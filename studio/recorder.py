"""Bounded, subscription-only telemetry capture on literal loopback addresses.

Run ``python -m studio.recorder --help``. This module never creates a DDS
participant or a ZMQ PUB socket. It is independent of the browser lifecycle.
"""
from __future__ import annotations

import argparse
import base64
from dataclasses import dataclass, field
from collections import deque
import ipaddress
import json
from pathlib import Path
import queue
import signal
import threading
import time
from urllib.parse import urlsplit
import uuid

from .protocols import ALLOWED_TOPICS, MAX_PACKET_BYTES, ProtocolError, decode_packet


def validate_endpoint(endpoint: str) -> str:
    """Reject non-loopback, DNS, IPC, wildcard, credentials, paths and queries."""
    try:
        parts = urlsplit(endpoint)
        address = ipaddress.ip_address(parts.hostname or "")
        port = parts.port
    except ValueError as exc:
        raise ValueError("endpoint must be tcp://literal-loopback-address:port") from exc
    if (parts.scheme != "tcp" or not address.is_loopback or port is None or not 1 <= port <= 65535
            or parts.username is not None or parts.password is not None
            or parts.path or parts.query or parts.fragment):
        raise ValueError("only explicit loopback TCP telemetry endpoints are allowed")
    return endpoint


@dataclass
class StreamHealth:
    """Receipt-time freshness, plus packet sequence gaps only when available.

    Unknown source clocks never become end-to-end latency. A stale connection
    is not proof that its producer died; transport disconnect is separate.
    """
    stale_after_s: float = 0.5
    disconnected_after_s: float = 2.0
    received: int = 0
    sequence_gaps: int = 0
    sequence_restarts: int = 0
    duplicate_sequences: int = 0
    malformed: int = 0
    last_sequence: int | None = None
    last_receipt: float | None = None
    transport: str = "unknown"
    receipts: deque = field(default_factory=lambda: deque(maxlen=128))

    def observe(self, sequence: int | None, receipt: float):
        if self.last_receipt is not None and receipt < self.last_receipt:
            raise ValueError("collector monotonic clock moved backwards")
        if sequence is not None:
            if self.last_sequence is not None:
                delta = sequence - self.last_sequence
                if delta > 1:
                    self.sequence_gaps += delta - 1
                elif delta < 0:
                    self.sequence_restarts += 1
                elif delta == 0:
                    self.duplicate_sequences += 1
            self.last_sequence = sequence
        self.last_receipt = receipt
        self.receipts.append(receipt)
        self.received += 1

    def snapshot(self, now: float):
        age = None if self.last_receipt is None else max(0.0, now - self.last_receipt)
        if age is None:
            status = "unavailable"
        elif self.transport == "disconnected":
            status = "disconnected"
        elif age > self.disconnected_after_s:
            status = "silent"
        elif age > self.stale_after_s:
            status = "stale"
        else:
            status = "fresh"
        window = self.receipts[-1] - self.receipts[0] if len(self.receipts) >= 2 else 0
        rate = (len(self.receipts) - 1) / window if window > 0 else None
        return {"status": status, "transport": self.transport, "receipt_age_s": age,
                "observed_rate_hz": rate, "rate_basis": "last_received_window",
                "source_latency_s": None, "received": self.received,
                "sequence_gaps": self.sequence_gaps if self.last_sequence is not None else None,
                "sequence_restarts": self.sequence_restarts, "duplicate_sequences": self.duplicate_sequences,
                "malformed": self.malformed}


class BoundedRecorder:
    """A disk writer isolated by a bounded drop-oldest queue.

    ``submit`` only enqueues a Python object; it never waits for file I/O. The
    queue cap and packet cap bound capture memory; file size is also bounded.
    """
    def __init__(self, path, *, queue_size=64, max_bytes=256 * 1024 * 1024):
        if queue_size < 1 or max_bytes < 1:
            raise ValueError("queue_size and max_bytes must be positive")
        self.path = Path(path)
        self.queue = queue.Queue(maxsize=queue_size)
        self.max_bytes = max_bytes
        self.accepted = self.written = self.dropped = self.bytes_written = 0
        self.error = None
        self.limit_reached = False
        self._closed = threading.Event()
        self._file = self.path.open("x", encoding="utf-8")
        self._thread = threading.Thread(target=self._write_loop, name="studio-recorder", daemon=True)
        self._thread.start()

    def submit(self, event):
        if self._closed.is_set() or self.error is not None or self.limit_reached:
            self.dropped += 1
            return False
        try:
            self.queue.put_nowait(event)
        except queue.Full:
            try:
                self.queue.get_nowait()
                self.queue.task_done()
                self.dropped += 1
            except queue.Empty:
                pass
            try:
                self.queue.put_nowait(event)
            except queue.Full:
                self.dropped += 1
                return False
        self.accepted += 1
        return True

    def _write_loop(self):
        try:
            while not self._closed.is_set() or not self.queue.empty():
                try:
                    event = self.queue.get(timeout=0.05)
                except queue.Empty:
                    continue
                try:
                    line = json.dumps(event, allow_nan=False, separators=(",", ":")) + "\n"
                    length = len(line.encode("utf-8"))
                    if self.bytes_written + length > self.max_bytes:
                        self.limit_reached = True
                        self.dropped += 1
                    else:
                        self._file.write(line)
                        self.bytes_written += length
                        self.written += 1
                finally:
                    self.queue.task_done()
            self._file.flush()
        except Exception as exc:
            self.error = f"{type(exc).__name__}: {exc}"
        finally:
            self._file.close()

    def close(self):
        self._closed.set()
        self._thread.join(timeout=3.0)
        if self._thread.is_alive():
            self.error = "disk writer did not finish within 3 seconds"
        return self.stats()

    def stats(self):
        return {"accepted": self.accepted, "written": self.written, "queue_drops": self.dropped,
                "bytes_written": self.bytes_written, "file_limit_reached": self.limit_reached,
                "writer_error": self.error, "queue_capacity": self.queue.maxsize}


def capture_zmq(endpoints, topics, output, *, duration=10.0, queue_size=64,
                max_bytes=256 * 1024 * 1024, stale_after_s=0.5, include_wire=True, stop_event=None):
    """Capture local streams and transport state; return exact capture stats.

    Topics are observed independently even when they share a publisher. No
    source-latency claims are made without an explicit clock-alignment receipt.
    ``stop_event`` (set by SIGINT/SIGTERM in ``main``) ends the capture normally,
    so the summary and ``capture_end`` are always written; ``stopped_by`` says why.
    """
    import zmq
    from zmq.utils.monitor import recv_monitor_message

    endpoints = list(dict.fromkeys(validate_endpoint(e) for e in endpoints))
    topics = [t.encode() if isinstance(t, str) else t for t in topics]
    if not endpoints or not topics or any(t not in ALLOWED_TOPICS for t in topics):
        raise ValueError("provide endpoints and allowlisted telemetry topics")
    if not 0 < duration <= 3600 or queue_size > 4096 or stale_after_s <= 0:
        raise ValueError("invalid capture duration, queue size, or freshness threshold")
    session = str(uuid.uuid4())
    stop_event = stop_event or threading.Event()
    stopped_by = "duration"
    start = time.monotonic()
    recorder = BoundedRecorder(output, queue_size=queue_size, max_bytes=max_bytes)
    context = zmq.Context()
    poller = zmq.Poller()
    sockets, monitors, health = {}, {}, {}
    recorder.submit({"record": "capture_start", "schema_version": 1, "session_id": session,
                     "receipt_timestamp": start, "receipt_clock": "collector_host_monotonic",
                     "receipt_unix": time.time(), "endpoints": endpoints,
                     "topics": [t.decode() for t in topics], "mode": "loopback_read_only_telemetry",
                     "hardware_command_path": False, "dds_participant": False,
                     "note": "Capture is not proof of a controller run or physical robot observation."})
    try:
        for endpoint in endpoints:
            sock = context.socket(zmq.SUB)
            sock.setsockopt(zmq.LINGER, 0)
            sock.setsockopt(zmq.RCVHWM, queue_size)
            sock.setsockopt(zmq.MAXMSGSIZE, MAX_PACKET_BYTES)
            if ":[" in endpoint or "tcp://[" in endpoint:
                sock.setsockopt(zmq.IPV6, 1)
            for topic in topics:
                sock.setsockopt(zmq.SUBSCRIBE, topic)
                health[(endpoint, topic)] = StreamHealth(stale_after_s=stale_after_s)
            monitor = sock.get_monitor_socket(events=zmq.EVENT_CONNECTED | zmq.EVENT_DISCONNECTED)
            sockets[sock] = endpoint
            monitors[monitor] = endpoint
            poller.register(sock, zmq.POLLIN)
            poller.register(monitor, zmq.POLLIN)
            sock.connect(endpoint)
        last_status = start
        while time.monotonic() - start < duration and not recorder.limit_reached and recorder.error is None:
            if stop_event.is_set():
                stopped_by = "signal"
                break
            for sock, _ in poller.poll(50):
                now = time.monotonic()
                if sock in monitors:
                    event = recv_monitor_message(sock)
                    endpoint = monitors[sock]
                    state = "connected" if event["event"] == zmq.EVENT_CONNECTED else "disconnected"
                    for topic in topics:
                        health[(endpoint, topic)].transport = state
                    recorder.submit({"record": "transport", "receipt_timestamp": now,
                                     "endpoint": endpoint, "state": state, "provenance": "zmq_socket_monitor"})
                    continue
                endpoint = sockets[sock]
                parts = sock.recv_multipart(flags=zmq.NOBLOCK)
                message = parts[0]
                topic = next((t for t in topics if message.startswith(t)), None)
                if topic is None:
                    continue
                stream = health[(endpoint, topic)]
                if len(parts) != 1:
                    stream.malformed += 1
                    continue
                try:
                    event = decode_packet(message, topic, receipt_monotonic=now, receipt_unix=time.time(),
                                          source_id=endpoint, session_id=session)
                except (ProtocolError, ValueError, TypeError, OverflowError) as exc:
                    stream.malformed += 1
                    recorder.submit({"record": "decode_error", "receipt_timestamp": now,
                                     "endpoint": endpoint, "topic": topic.decode(), "error": str(exc)})
                    continue
                stream.observe(event["sequence"], now)
                if include_wire:
                    event["wire_base64"] = base64.b64encode(message).decode("ascii")
                recorder.submit(event)
            now = time.monotonic()
            if now - last_status >= 0.25:
                recorder.submit({"record": "health", "receipt_timestamp": now,
                                 "streams": {e + "#" + t.decode(): h.snapshot(now) for (e, t), h in health.items()},
                                 "recorder": recorder.stats()})
                last_status = now
        if stopped_by == "duration" and (recorder.limit_reached or recorder.error is not None):
            stopped_by = "file_limit" if recorder.limit_reached else "writer_error"
    except KeyboardInterrupt:
        stopped_by = "signal"  # a SIGINT that arrived before the handler or outside the poll
    finally:
        for sock in sockets:
            sock.disable_monitor()
            sock.close(0)
        for sock in monitors:
            sock.close(0)
        context.term()
        now = time.monotonic()
        final_health = {e + "#" + t.decode(): h.snapshot(now) for (e, t), h in health.items()}
        recorder.submit({"record": "capture_end", "receipt_timestamp": now,
                         "duration_s": now - start, "stopped_by": stopped_by, "streams": final_health})
        stats = recorder.close()
    return {"output": str(Path(output).resolve()), "session_id": session, "duration_s": now - start,
            "stopped_by": stopped_by, "streams": final_health, "recorder": stats, "hardware_command_path": False}


def main():
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    parser.add_argument("--endpoint", action="append", required=True)
    parser.add_argument("--topic", action="append", choices=[t.decode() for t in ALLOWED_TOPICS], required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--duration", type=float, default=10.0)
    parser.add_argument("--queue-size", type=int, default=64)
    parser.add_argument("--max-bytes", type=int, default=256 * 1024 * 1024)
    args = parser.parse_args()
    stop = threading.Event()
    for sig in (signal.SIGINT, signal.SIGTERM):
        signal.signal(sig, lambda *_: stop.set())
    result = capture_zmq(args.endpoint, args.topic, args.output, duration=args.duration,
                         queue_size=args.queue_size, max_bytes=args.max_bytes, stop_event=stop)
    print(json.dumps(result, indent=2))
    if result["recorder"]["writer_error"]:
        raise SystemExit(1)


if __name__ == "__main__":
    main()
