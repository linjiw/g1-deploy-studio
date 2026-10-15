"""Portable MCAP JSON export of normalized replay sessions (no vendor assets)."""
from __future__ import annotations

import argparse
import io
import json
from pathlib import Path

from mcap.reader import make_reader
from mcap.writer import Writer


def encode_mcap(session):
    """Keep original source clocks; MCAP indexing uses labelled session-relative ns."""
    output = io.BytesIO()
    writer = Writer(output)
    writer.start(profile="g1-studio-relative-time-v1", library="g1-deploy-studio/0.1")
    schema = writer.register_schema("g1.studio.ReplayFrame.v1", "jsonschema", json.dumps({
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "type": "object", "required": ["time", "sequence", "source_clock_domain", "classification"],
        "properties": {"time": {"type": "number"}, "sequence": {"type": ["integer", "null"]},
                       "source_clock_domain": {"type": "string"}, "classification": {"type": "string"}},
    }).encode())
    channel = writer.register_channel("/g1/replay/frame", "json", schema, metadata={
        "clock_domain": "session-relative-seconds", "time_basis": "not Unix acquisition time",
        "source_clock": session["metadata"]["clock_domain"],
    })
    context = {k: v for k, v in session.items() if k != "frames"}
    context["mcap_time_basis"] = "session-relative nanoseconds; not Unix acquisition time"
    writer.add_metadata("g1.studio.session.v1", {"json": json.dumps(context, allow_nan=False)})
    previous = -1
    for i, frame in enumerate(session["frames"]):
        time_ns = round(frame["time"] * 1_000_000_000)
        if time_ns < 0 or time_ns < previous:
            raise ValueError("Replay clock must be nonnegative and monotonic")
        previous = time_ns
        writer.add_message(channel_id=channel, log_time=time_ns, publish_time=time_ns,
                           sequence=i, data=json.dumps(frame, allow_nan=False, separators=(",", ":")).encode())
    writer.finish()
    return output.getvalue()


def load_mcap(path):
    path = Path(path)
    if path.stat().st_size > 128 * 1024 * 1024:
        raise ValueError("MCAP exceeds 128 MiB local replay input limit")
    with path.open("rb") as stream:
        reader = make_reader(stream)
        if reader.get_header().profile != "g1-studio-relative-time-v1":
            raise ValueError("Only normalized G1 Studio MCAP replay is supported")
        session = None
        for metadata in reader.iter_metadata():
            if metadata.name == "g1.studio.session.v1":
                session = json.loads(metadata.metadata["json"])
        if session is None:
            raise ValueError("Missing session provenance")
        frames = []
        decoded_bytes = 0
        for _, channel, message in reader.iter_messages(topics=["/g1/replay/frame"]):
            decoded_bytes += len(message.data)
            if decoded_bytes > 64 * 1024 * 1024 or len(frames) >= 10000:
                raise ValueError("Decoded replay exceeds browser limit")
            frame = json.loads(message.data)
            if abs(frame["time"] - message.log_time / 1e9) > 1e-8:
                raise ValueError("MCAP replay clock differs from source envelope")
            frames.append(frame)
        if not frames:
            raise ValueError("No replay frames")
        session["frames"] = frames
        return session


def main():
    from studio.replay import load_session
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("session", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("--environment", type=Path)
    args = parser.parse_args()
    session = load_session(args.session, environment_path=args.environment)
    # Exclusive creation protects previous recordings.
    with args.output.open("xb") as stream:
        stream.write(encode_mcap(session))
    print(f"Exported {len(session['frames'])} frames to {args.output}; time basis: session-relative")


if __name__ == "__main__":
    main()
