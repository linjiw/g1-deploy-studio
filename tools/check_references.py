#!/usr/bin/env python3
"""Read-only local reference inventory. Never imports or starts deployment code."""
import argparse
import json
from pathlib import Path
import subprocess
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studio import paths  # noqa: E402


def inspect_reference(entry):
    root = Path(paths.relocate(entry["path"]))  # recorded path -> this machine's root
    missing = [p for p in entry["required_paths"] if not (root / p).exists()]
    head = None
    if root.is_dir():
        try:
            result = subprocess.run(["git", "-C", str(root), "rev-parse", "HEAD"],
                                    capture_output=True, text=True, timeout=10)
            if result.returncode == 0:
                head = result.stdout.strip()
        except (OSError, subprocess.TimeoutExpired):
            pass
    observed = entry.get("observed_head")
    return {"id": entry["id"], "path": str(root), "exists": root.is_dir(),
            "missing_paths": missing, "observed_head": observed, "current_head": head,
            "head_changed": observed is not None and head != observed,
            "ok": root.is_dir() and not missing}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path,
                        default=Path(__file__).resolve().parents[1] / "config/references.json")
    args = parser.parse_args()
    manifest = json.loads(args.manifest.read_text())
    results = [inspect_reference(e) for e in manifest["repositories"]]
    print(json.dumps({"read_only": True, "repositories": results,
                      "ok": all(r["ok"] for r in results)}, indent=2))
    return 0 if all(r["ok"] for r in results) else 1


if __name__ == "__main__":
    raise SystemExit(main())
