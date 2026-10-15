"""Loopback, read-only HTTP replay gateway. This process has no control interface."""
from __future__ import annotations

import argparse
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import mimetypes
from pathlib import Path
import re
import threading
from urllib.parse import parse_qs, unquote, urlparse

from studio.model import RobotModel

ROOT = Path(__file__).resolve().parents[1]


class Catalog:
    def __init__(self, config=ROOT / "config/sessions.json"):
        document = json.loads(Path(config).read_text())
        entries = document["sessions"]
        self.entries = {}
        for item in entries:
            key = item["id"]
            if not re.fullmatch(r"[a-zA-Z0-9_-]{1,64}", key) or key in self.entries:
                raise ValueError("Session IDs must be unique URL-safe identifiers")
            self.entries[key] = item
        self.cache = {}
        self.models = {}
        self.lock = threading.RLock()

    def listing(self):
        return {"sessions": [{"id": k, "label": v.get("label", k),
                              "description": v.get("description", ""),
                              "available": Path(v["path"]).exists()}
                             for k, v in self.entries.items()],
                "mode": "replay", "hardware_enabled": False, "read_only": True}

    def session(self, key):
        from studio.replay import load_session
        with self.lock:
            if key not in self.entries:
                raise KeyError("Unknown session")
            if key not in self.cache:
                item = self.entries[key]
                if Path(item["path"]).suffix.lower() == ".jsonl":
                    from studio.capture_replay import load_capture
                    data = load_capture(item["path"])
                elif Path(item["path"]).suffix.lower() == ".mcap":
                    from studio.export import load_mcap
                    data = load_mcap(item["path"])
                else:
                    data = load_session(item["path"], environment_path=item.get("environment_path"))
                data["metadata"]["catalog_id"] = key
                # JSON encoding validates finite values before any response is served.
                body = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
                if len(body) > 64 * 1024 * 1024:
                    raise ValueError("Session exceeds 64 MiB browser replay limit; split recording")
                self.cache[key] = (data, body)
            return self.cache[key]

    def model(self, key):
        with self.lock:
            if key not in self.models:
                data, _ = self.session(key)
                if not data["metadata"].get("model_path"):
                    raise ValueError("Robot model and pose were not captured in this diagnostics session")
                self.models[key] = RobotModel(data["metadata"]["model_path"], key)
            return self.models[key]


class Gateway(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 16
    allow_reuse_address = True

    def __init__(self, address, catalog):
        if address[0] != "127.0.0.1":
            raise ValueError("Replay gateway binds only 127.0.0.1; use an authenticated SSH tunnel")
        self.catalog = catalog
        self.slots = threading.BoundedSemaphore(12)
        super().__init__(address, Handler)

    def process_request(self, request, client_address):
        if not self.slots.acquire(blocking=False):
            request.close()
            return
        super().process_request(request, client_address)

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            self.slots.release()


class Handler(BaseHTTPRequestHandler):
    server_version = "G1Replay/0.1"

    def setup(self):
        super().setup()
        self.connection.settimeout(15)

    def log_message(self, fmt, *args):
        # Keep mesh requests from overwhelming the terminal.
        if args and not str(args[0]).startswith("GET /assets/"):
            super().log_message(fmt, *args)

    def respond(self, data, kind="application/json", status=200):
        if not isinstance(data, bytes):
            data = json.dumps(data, allow_nan=False, separators=(",", ":")).encode()
        self.send_response(status)
        self.send_header("Content-Type", kind)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-store" if kind == "application/json" else "private, max-age=3600")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Cross-Origin-Resource-Policy", "same-origin")
        self.send_header("Referrer-Policy", "no-referrer")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        # Reject cross-site fetches and DNS rebinding even on a loopback listener.
        expected = {f"127.0.0.1:{self.server.server_port}", f"localhost:{self.server.server_port}"}
        if self.headers.get("Host") not in expected:
            return self.respond({"error": "Loopback Host required"}, status=403)
        origin = self.headers.get("Origin")
        if origin and origin not in {f"http://{h}" for h in expected}:
            return self.respond({"error": "Cross-origin telemetry access denied"}, status=403)
        if self.headers.get("Sec-Fetch-Site") == "cross-site":
            return self.respond({"error": "Cross-site access denied"}, status=403)
        try:
            route = urlparse(self.path)
            path = unquote(route.path)
            query = parse_qs(route.query)
            catalog = self.server.catalog
            if path == "/api/sessions":
                return self.respond(catalog.listing())
            if path == "/api/safety":
                return self.respond({"mode": "replay", "hardware_enabled": False, "publishers": [],
                                     "dds_participants": 0, "binding": "127.0.0.1", "read_only": True})
            if path in ("/api/session", "/api/model", "/api/kinematics", "/api/export"):
                key = query.get("id", [next(iter(catalog.entries))])[0]
                if path == "/api/session":
                    return self.respond(catalog.session(key)[1])
                if path == "/api/export":
                    from studio.export import encode_mcap
                    return self.respond(encode_mcap(catalog.session(key)[0]), "application/octet-stream")
                model = catalog.model(key)
                if path == "/api/model":
                    return self.respond(model.description)
                data, _ = catalog.session(key)
                index = int(query.get("frame", ["0"])[0])
                if index < 0 or index >= len(data["frames"]):
                    raise ValueError("Frame out of range")
                return self.respond(model.body_poses(data["frames"][index]["qpos"]))
            if path.startswith("/assets/model/"):
                parts = path.split("/")
                if len(parts) != 5:
                    raise KeyError("Unknown asset")
                asset = catalog.model(parts[3]).assets[parts[4]]
                return self.respond(asset.read_bytes(), "application/octet-stream")
            if path.startswith("/vendor/three/"):
                base = ROOT / "node_modules/three"
                relative = path[len("/vendor/three/"):]
            else:
                base = ROOT / "apps/web"
                relative = "index.html" if path == "/" else path.lstrip("/")
            target = (base / relative).resolve()
            if not target.is_relative_to(base.resolve()) or not target.is_file():
                raise KeyError("Not found")
            kind = mimetypes.guess_type(target)[0] or "application/octet-stream"
            return self.respond(target.read_bytes(), kind)
        except (BrokenPipeError, ConnectionResetError):
            return
        except KeyError:
            self.respond({"error": "Unknown session or resource"}, status=404)
        except (ValueError, FileNotFoundError) as error:
            self.respond({"error": str(error)}, status=422)

    def do_POST(self):
        self.respond({"error": "Read-only replay gateway; mutations and control are not supported"}, status=405)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=8790)
    parser.add_argument("--config", type=Path, default=ROOT / "config/sessions.json")
    args = parser.parse_args()
    server = Gateway(("127.0.0.1", args.port), Catalog(args.config))
    print(f"G1 Deploy Studio: http://127.0.0.1:{server.server_port}  [REPLAY / READ ONLY]", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
