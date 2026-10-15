# Recording

`studio/recorder.py` captures allowlisted ZMQ telemetry on literal loopback endpoints into bounded JSONL with original wire bytes, clock domains, health and connection events. It is independent of browser lifetime.

`studio/export.py` writes/reads indexed normalized MCAP replay. It labels index time as session-relative; source/receipt times retain their own domains. rosbag2 and native Foxglove 3D conversion are not implemented.

Large recordings stay outside Git. The demonstrated evidence is under `~/research-data/g1-deploy-studio/evidence/`; see `docs/ACCEPTANCE.md` for exact commands and files.
