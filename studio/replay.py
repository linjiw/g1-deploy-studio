"""Read-only adapters for actual Flow/SONIC rehearsal recordings.

No deployment imports, sockets or policy execution. Recorded simulation truth is
never presented as physical robot measurement. Missing signals remain ``None``.
"""
from __future__ import annotations

import argparse
import bisect
import hashlib
import json
import math
from pathlib import Path
import re
import subprocess
import zipfile

import numpy as np

JOINT_NAMES = (
    "left_hip_pitch_joint", "left_hip_roll_joint", "left_hip_yaw_joint", "left_knee_joint",
    "left_ankle_pitch_joint", "left_ankle_roll_joint", "right_hip_pitch_joint", "right_hip_roll_joint",
    "right_hip_yaw_joint", "right_knee_joint", "right_ankle_pitch_joint", "right_ankle_roll_joint",
    "waist_yaw_joint", "waist_roll_joint", "waist_pitch_joint", "left_shoulder_pitch_joint",
    "left_shoulder_roll_joint", "left_shoulder_yaw_joint", "left_elbow_joint", "left_wrist_roll_joint",
    "left_wrist_pitch_joint", "left_wrist_yaw_joint", "right_shoulder_pitch_joint",
    "right_shoulder_roll_joint", "right_shoulder_yaw_joint", "right_elbow_joint", "right_wrist_roll_joint",
    "right_wrist_pitch_joint", "right_wrist_yaw_joint",
)
FLOW_ROOT = Path("/home/linjiw/code/g1-student-deploy")
LUCID_ROOT = Path("/home/linjiw/lucid-sonic/lucid-g1-deploy")
DEFAULT_SESSION = FLOW_ROOT / "runs/smoke/__start_stand_"
DEFAULT_DDS_SESSION = FLOW_ROOT / "runs/video/A_quickstart"
DT = 0.02
MAX_FRAMES = 3000
MAX_POINTS = 6000


class ReplayError(ValueError):
    """Invalid or unsupported recording; fail without inventing values."""


def _json(path: Path, default=None):
    if not path.exists():
        return default
    if path.stat().st_size > 16 * 1024 * 1024:
        raise ReplayError(f"JSON exceeds the 16 MiB adapter limit: {path.name}")
    return json.loads(path.read_text())


def _npz(path: Path):
    if path.stat().st_size > 64 * 1024 * 1024:
        raise ReplayError("Recording exceeds 64 MiB compressed; select a bounded clip")
    with zipfile.ZipFile(path) as archive:
        if sum(i.file_size for i in archive.infolist()) > 256 * 1024 * 1024:
            raise ReplayError("Recording exceeds 256 MiB decoded")
    with np.load(path, allow_pickle=False) as archive:
        return {k: archive[k] for k in archive.files}


def _finite(a, name, shape=None):
    a = np.asarray(a, dtype=float)
    if shape is not None and a.shape != shape:
        raise ReplayError(f"{name} shape {a.shape}, expected {shape}")
    if not np.isfinite(a).all():
        raise ReplayError(f"{name} contains nonfinite samples")
    return a


def _fingerprint(path: Path):
    digest = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            digest.update(chunk)
    return {"path": str(path.resolve()), "bytes": path.stat().st_size, "sha256": digest.hexdigest()}


def _git_provenance(root: Path):
    def git(*args):
        p = subprocess.run(["git", "--no-optional-locks", "-C", str(root), *args], capture_output=True, text=True, timeout=5)
        return p.stdout.strip() if p.returncode == 0 else None
    status = git("status", "--porcelain", "--untracked-files=no")
    return {"path": str(root), "head_at_read": git("rev-parse", "HEAD"),
            "dirty_at_read": bool(status) if status is not None else None,
            "recording_revision": None, "note": "Current source checkout; recording did not save Git revision"}


def quat_matrix(q):
    q = _finite(q, "quaternion", (4,))
    n = np.linalg.norm(q)
    if n < 1e-9 or abs(n - 1) > 0.02:
        raise ReplayError("Invalid wxyz quaternion norm")
    w, x, y, z = q / n
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


def matrix_quat(r):
    """Stable proper-rotation to wxyz conversion, without scipy dependency."""
    r = np.asarray(r)
    trace = np.trace(r)
    if trace > 0:
        s = math.sqrt(trace + 1) * 2
        q = [s/4, (r[2, 1]-r[1, 2])/s, (r[0, 2]-r[2, 0])/s, (r[1, 0]-r[0, 1])/s]
    else:
        i = int(np.argmax(np.diag(r)))
        j, k = (i+1) % 3, (i+2) % 3
        s = math.sqrt(1+r[i, i]-r[j, j]-r[k, k]) * 2
        q = np.zeros(4)
        q[0] = (r[k, j]-r[j, k])/s
        q[i+1], q[j+1], q[k+1] = s/4, (r[j, i]+r[i, j])/s, (r[k, i]+r[i, k])/s
    q = np.asarray(q)
    q /= np.linalg.norm(q)
    return q.tolist()


def decode_reference(ref, pre_qpos):
    """Decode feed.target's actual (10,67) values; no semantic token labels.

    The final three values are planner root deltas in measured-heading axes,
    explicitly excluded from SONIC input by SonicTracker.observation().
    """
    ref = _finite(ref, "reference", (10, 67))
    q = _finite(pre_qpos, "pre_action_qpos", (36,))
    measured_rotation = quat_matrix(q[3:7])
    yaw = math.atan2(measured_rotation[1, 0], measured_rotation[0, 0])
    c, s = math.cos(yaw), math.sin(yaw)
    heading = np.array([[c, -s, 0], [s, c, 0], [0, 0, 1]])
    window = []
    for k, row in enumerate(ref):
        columns = row[58:64].reshape(3, 2)
        a, b = columns[:, 0].copy(), columns[:, 1].copy()
        # Match the actual tracker: its learned 6D input is projected before
        # inference (g1deploy.sonic.project_rotation_6d), not assumed orthogonal.
        an = np.linalg.norm(a)
        a = a / an if an > 1e-8 else np.array([1., 0., 0.])
        b -= (b @ a) * a
        bn = np.linalg.norm(b)
        if bn > 1e-8:
            b /= bn
        else:
            b = np.eye(3)[np.argmin(np.abs(a))]
            b -= (b @ a) * a
            b /= np.linalg.norm(b)
        rotation = measured_rotation @ np.column_stack((a, b, np.cross(a, b)))
        window.append({"offset_s": k * .1, "joints": row[:29].tolist(),
                       "velocity": row[29:58].tolist(), "quaternion_wxyz": matrix_quat(rotation),
                       "position": (q[:3] + heading @ row[64:67]).tolist()})
    return {"joints": window[0]["joints"], "position": window[0]["position"],
            "quaternion_wxyz": window[0]["quaternion_wxyz"], "window": window,
            "root_position_available": True, "position_basis": "planner-diagnostic-not-consumed-by-sonic",
            "classification": "reference", "shape": [10, 67], "raw": ref.tolist(),
            "orientation_basis": "6D projected with tracker Gram-Schmidt convention",
            "consumed_columns": [0, 64], "diagnostic_columns": [64, 67],
            "latent_tokens": None, "latent_status": "not recorded or exposed by fused tracker output"}


def _sample_indices(n, max_frames):
    if not 1 <= max_frames <= MAX_FRAMES:
        raise ReplayError(f"max_frames must be 1..{MAX_FRAMES}")
    if n == 0:
        raise ReplayError("Recording contains no samples")
    return np.unique(np.linspace(0, n-1, min(n, max_frames), dtype=int))


def _model_joint_addresses(model_path):
    import mujoco
    model = mujoco.MjModel.from_xml_path(str(model_path))
    addresses = []
    for name in JOINT_NAMES:
        jid = mujoco.mj_name2id(model, mujoco.mjtObj.mjOBJ_JOINT, name)
        if jid < 0:
            raise ReplayError(f"Model is missing named joint {name}")
        addresses.append(int(model.jnt_qposadr[jid]))
    return model.nq, addresses


def _metadata(path, kind, model, duration, clock, origin, files, limitations):
    lockstep = kind == "sonic-mujoco-lockstep"
    return {"id": path.name, "title": "SONIC reference rehearsal" if lockstep else f"C++ / DDS · {path.name}",
            "mode": "replay", "recording_kind": kind, "backend_id": "sonic", "source_path": str(path),
            "model_path": str(model), "model_variant": "G1 29 DoF · rubber hands" if lockstep else "G1 43 DoF · Dex3 hands",
            "duration_s": float(duration), "clock_domain": clock, "source_time_origin": float(origin),
            "frame_id": "world", "quaternion_convention": "wxyz", "units": {"position": "m", "joint": "rad", "time": "s"},
            "hardware_validated": False, "command_path_enabled": False, "fixture": False,
            "policy_identity": "sonic_release_g1.onnx · fused 1570 → 29 (source configuration)",
            "policy_hash_at_recording": None, "calibration_identity": None,
            "limitations": limitations,
            "provenance": {"artifacts": [_fingerprint(f) for f in files if f.is_file()],
                           "model_at_read": _fingerprint(model),
                           "recorded_model_hash": None,
                           "repositories": [_git_provenance(FLOW_ROOT)] + ([] if lockstep else [_git_provenance(LUCID_ROOT)]),
                           "adapter": "studio.replay.v1"}}


def _graph(lockstep):
    nodes = [{"id": "sim", "label": "MuJoCo G1", "kind": "simulator"},
             {"id": "planner", "label": "Flow planner", "kind": "planner"},
             {"id": "sonic", "label": "SONIC ONNX" if lockstep else "SONIC C++ runner", "kind": "controller"},
             {"id": "memory", "label": "Perception memory", "kind": "perception"},
             {"id": "studio", "label": "Studio replay", "kind": "observer"}]
    specs = [("sim", "memory", "in-process" if lockstep else "Unitree DDS", "analytic ray casts" if lockstep else "rt/utlidar/cloud_livox_mid360"),
             ("memory", "planner", "in-process", "support / ceiling evidence"),
             ("planner", "sonic", "in-process" if lockstep else "ZMQ", "reference [10,67]" if lockstep else "pose v1 · 5556"),
             ("sonic", "sim", "in-process" if lockstep else "Unitree DDS", "PD torque" if lockstep else "rt/lowcmd"),
             ("sim", "planner", "in-process" if lockstep else "Unitree DDS", "qpos" if lockstep else "rt/lowstate + rt/odostate"),
             ("sim", "studio", "recording", "closed_loop.npz" if lockstep else "sim.npz")]
    edges = [{"source": a, "target": b, "transport": t, "topic": topic, "status": "configured",
              "observed_rate_hz": None, "age_ms": None, "drops": None, "qos": None,
              "basis": "source configuration; no packet capture"} for a,b,t,topic in specs]
    return {"basis": "configured-from-source", "runtime_discovered": False, "nodes": nodes, "edges": edges,
            "ros2": {"available": False, "reason": "No ROS graph was recorded"},
            "dds_domain": None, "dds_domain_note": "Historical capture did not record an isolated domain; Studio opens no DDS participant"}


def _plan(row, time, now, clock_basis="recorded simulation tick"):
    xyz = []
    if row.get("plan_xy") and row.get("plan_root_z"):
        xyz = [[float(x), float(y), float(z)] for (x,y),z in zip(row["plan_xy"], row["plan_root_z"])]
    return {"time": float(time), "age_s": max(0.0, float(now-time)),
            "latency_ms": float(row["latency_s"]) * 1000 if row.get("latency_s") is not None else None,
            "rule": row.get("rule"), "waypoint": row.get("waypoint_xy"), "future": xyz,
            "future_basis": "planner-prediction", "clock_basis": clock_basis,
            "rejected": row.get("rejected"), "anchor_tick": row.get("anchor_tick"),
            "late_ticks": row.get("late_ticks"), "route_remaining_m": row.get("route_remaining_m")}


def _lockstep(path, environment_path, model_path, max_frames):
    zpath = path / "closed_loop.npz"
    z = _npz(zpath)
    if not {"pre_action_qpos", "realized_qpos", "references"} <= z.keys():
        raise ReplayError("Lockstep recording is missing state/reference arrays")
    pre = z["pre_action_qpos"]
    if pre.ndim != 2 or pre.shape[1] != 36:
        raise ReplayError("Lockstep state must have shape [T,36]")
    n = len(pre)
    _finite(pre, "pre_action_qpos")
    post = _finite(z["realized_qpos"], "realized_qpos", (n, 36))
    refs = _finite(z["references"], "references", (n, 10, 67))
    model = Path(model_path) if model_path else FLOW_ROOT / "sim/assets/g1_29dof.xml"
    nq, addresses = _model_joint_addresses(model)
    if nq != 36 or addresses != list(range(7, 36)):
        raise ReplayError("Lockstep model joint order does not match source contract")
    rows = _json(path / "plans.json", [])
    rows.sort(key=lambda row: row["tick"])
    times = [float(row["tick"]) * DT for row in rows]
    frames = []
    for i in _sample_indices(n, max_frames):
        q, t = pre[i], float(i * DT)
        ref = decode_reference(refs[i], q)
        j = bisect.bisect_right(times, t) - 1
        plan = _plan(rows[j], times[j], t) if j >= 0 else None
        frames.append({"time": t, "sequence": int(i), "source_time": t, "source_clock_domain": "simulation",
                       "receipt_time": None, "sim_time": t, "position": q[:3].tolist(),
                       "quaternion_wxyz": q[3:7].tolist(), "joints": q[7:].tolist(), "qpos": q.tolist(),
                       "classification": "simulator-ground-truth", "validity": "valid", "frame_id": "world",
                       "reference": ref, "plan": plan, "command": None,
                       "post_action": {"time": t+DT, "qpos": post[i].tolist(), "classification": "simulator-ground-truth"},
                       "health": {"state_age_ms": 0.0, "reference_age_ms": 0.0,
                                  "planner_latency_ms": plan["latency_ms"] if plan else None,
                                  "tracking_rmse_rad": float(np.sqrt(np.mean((q[7:] - refs[i,0,:29])**2))),
                                  "lowcmd_age_ms": None, "sonic_inference_ms": None, "gpu_utilization": None}})
    boxes = _json(Path(environment_path), []) if environment_path else []
    files = [zpath, path/"plans.json", path/"run_config.json"] + ([Path(environment_path)] if environment_path else [])
    metadata = _metadata(path, "sonic-mujoco-lockstep", model, (n-1)*DT, "simulation", 0, files, [
        "Actual recorded MuJoCo + SONIC ONNX lockstep execution; controller and planner ran in-process, without DDS/ZMQ.",
        "Measured pose is simulator ground truth, sampled before the action; post-action state has timestamp +20 ms.",
        "Only reference columns 0:64 enter SONIC. Root path is planner diagnostic prediction, not SONIC global-position input.",
        "Low-level targets, latent tokens, raw LiDAR, mapping snapshots, wall-time receipt stamps and inference latency were not recorded.",
        "Planner latency is measured computation wall time and is not end-to-end latency or real-time execution speed.",
        "Recording did not save source/model revisions. Current checkout/model hashes are provenance at read time, not certified recording-time identity."])
    if environment_path:
        metadata["limitations"].append("Environment geometry was selected separately; its hash is recorded, but the lockstep NPZ has no embedded scene identity. The demonstrated scene is linked by the historical realtime replay config.")
    run_cfg = _json(path/"run_config.json", {})
    metadata["planner_configuration"] = {k:run_cfg.get(k) for k in ("route_source", "lidar", "latency_s", "anchor_mode", "start")}
    metadata["source_samples"] = n
    metadata["executed_sim_duration_s"] = n*DT
    return {"schema_version": 1, "metadata": metadata, "joint_names": list(JOINT_NAMES), "frames": frames,
            "events": [{"time": t, "type": "replan", "message": row.get("rule", "plan selected"), "source": "plans.json",
                        "latency_ms": row["latency_s"]*1000 if row.get("latency_s") is not None else None} for t,row in zip(times, rows)],
            "environment": {"boxes": boxes, "classification": "simulator-ground-truth", "source": str(environment_path) if environment_path else None,
                            "identity_basis": "separately selected historical replay scene; not embedded in lockstep NPZ"},
            "perception": {"available": False, "reason": "Perception was consumed but no map/point cloud was recorded in this session"},
            "graph": _graph(True), "trajectory": [f["position"] for f in frames]}


def _node_events(path, origin):
    out = []
    if not path.is_file():
        return out
    for line in path.read_text(errors="replace").splitlines():
        start = line.find('{"event"')
        if start < 0:
            continue
        try:
            row = json.loads(line[start:])
            t = float(row["t"]) - origin
        except (ValueError, KeyError):
            continue
        detail = row.get("reason", row.get("cmd", ""))
        out.append({"time": t, "type": row["event"], "message": f"{row['event']} {detail}".strip(),
                    "source": "node.log", "fields": row})
    return out


def _final_map(path, duration):
    if not path.is_file():
        return {"available": False, "reason": "No perception snapshot in recording"}
    z = _npz(path)
    support, ceiling = z["support"], z["ceiling"]
    if support.shape != ceiling.shape or support.ndim != 2:
        raise ReplayError("Map layers have inconsistent dimensions")
    if support.size > 1024 * 1024:
        raise ReplayError("Map exceeds one million cells; export a bounded region")
    lo, res = _finite(z["lo"], "map origin", (2,)), float(z["res"])
    if not np.isfinite(res) or res <= 0:
        raise ReplayError("Invalid map resolution")
    layers = {}
    total = {}
    for name, arr in (("support", support), ("ceiling", ceiling)):
        ix, iy = np.nonzero(np.isfinite(arr))
        total[name] = len(ix)
        stride = max(1, math.ceil(len(ix) / (MAX_POINTS // 2)))
        ix, iy = ix[::stride], iy[::stride]
        # CloudMemory stores grid arrays [x, y]; lo is cell-center origin.
        layers[name] = np.column_stack((lo[0]+ix*res, lo[1]+iy*res, arr[ix,iy])).tolist()
    return {"available": True, "kind": "final-map-snapshot", "classification": "estimated",
            "time": None, "available_at": duration, "frame_id": "world", "source": str(path),
            "synchronized": False, "label": "Final accumulated map · capture time not recorded",
            "support_points": layers["support"], "ceiling_points": layers["ceiling"],
            "observed_points": layers["support"]+layers["ceiling"], "raw_lidar": None,
            "observed_cells": total, "grid_shape": list(support.shape), "resolution_m": res,
            "origin": lo.tolist(), "unknown_cells": int((np.isnan(support) & np.isnan(ceiling)).sum()),
            "support_observed_mask": (~np.isnan(support)).tolist(),
            "ceiling_observed_mask": (~np.isnan(ceiling)).tolist(),
            "clear_ceiling_cells": int(np.isposinf(ceiling).sum()),
            "mask_convention": "grid[x][y]; NaN is unknown, +infinity ceiling means observed clear",
            "point_budget": MAX_POINTS, "decimated": sum(total.values()) > MAX_POINTS,
            "note": "Only finite observed cells are rendered; unknown cells remain absent. This snapshot cannot reconstruct past perception."}


def _realtime(path, model_path, max_frames):
    zpath = path / "sim.npz"
    z = _npz(zpath)
    qpos = _finite(z["qpos"], "qpos")
    if qpos.ndim != 2:
        raise ReplayError("qpos must be a 2D array")
    n = len(qpos)
    wall = _finite(z["wall"], "wall")
    sim_t = _finite(z["t"], "simulation time")
    # Source robot_sim.py logs wall/t/root every two physics steps, qpos every four.
    if len(wall) not in (2*n, 2*n-1) or len(sim_t) != len(wall):
        raise ReplayError("Unexpected qpos/wall sampling ratio; refusing guessed timestamps")
    qw, qt = wall[::2], sim_t[::2]
    if np.any(np.diff(qw) <= 0) or np.any(np.diff(qt) <= 0):
        raise ReplayError("Recording clock is non-monotonic")
    if not np.allclose(qpos[:, :3], z["root_pos"][::2], atol=1e-10):
        raise ReplayError("qpos/root samples disagree: timestamp alignment is invalid")
    origin = float(qw[0])
    times = qw - origin
    model = Path(model_path) if model_path else LUCID_ROOT / "sim/models/g1/scene_43dof.xml"
    nq, addresses = _model_joint_addresses(model)
    if qpos.shape[1] != nq:
        raise ReplayError(f"Recording qpos width {qpos.shape[1]} does not match model nq={nq}")
    events = _node_events(path/"node.log", origin)
    plan_log = _json(path/"node_plans.json", {})
    rows = plan_log.get("plans", [])
    up = next((e for e in events if e["type"] == "node_up"), None)
    # Node emits node_up immediately after initializing monotonic t0. Approximation is explicit.
    plan_times = [up["time"] + float(p["tick"])*DT for p in rows] if up else []
    frames = []
    for i in _sample_indices(n, max_frames):
        q, t = qpos[i], float(times[i])
        quat_matrix(q[3:7])
        j = bisect.bisect_right(plan_times, t) - 1
        plan = _plan(rows[j], plan_times[j], t, "estimated from node_up monotonic timestamp + tick × 20 ms") if j >= 0 else None
        frames.append({"time": t, "sequence": int(i), "source_time": float(qw[i]), "source_clock_domain": "host-monotonic",
                       "receipt_time": None, "sim_time": float(qt[i]), "position": q[:3].tolist(),
                       "quaternion_wxyz": q[3:7].tolist(), "joints": q[addresses].tolist(), "qpos": q.tolist(),
                       "classification": "simulator-ground-truth", "validity": "valid", "frame_id": "world",
                       "reference": None, "command": None, "plan": plan,
                       "health": {"state_age_ms": 0.0, "reference_age_ms": None,
                                  "planner_latency_ms": plan["latency_ms"] if plan else None,
                                  "tracking_rmse_rad": None, "lowcmd_age_ms": None, "sonic_inference_ms": None,
                                  "contact_force_n": float(z["contact_n"][2*i]), "gpu_utilization": None}})
    duration = float(times[-1])
    boxes = json.loads(str(z["boxes"])) if "boxes" in z else []
    files = [zpath, path/"node_plans.json", path/"node.log", path/"session.json", path/"node_memory.npz", path/"runner.log"]
    metadata = _metadata(path, "sonic-cpp-dds-rehearsal", model, duration, "host-monotonic", origin, files, [
        "Recorded separate MuJoCo, planner and SONIC C++ processes; DDS/ZMQ edges inferred from source and logs, not runtime discovery.",
        "qpos is simulator ground truth. It is not an rt/lowstate packet recording or hardware measurement.",
        "Reference frames, low-level commands and latent values were not recorded; ghost and tracking error are unavailable.",
        "Final map has no capture timestamp or history. It must not be presented as perception at the replay cursor.",
        "Planner event times are estimated from node_up + tick × 20 ms; latency values are recorded wall-clock computation duration.",
        "Historical simulator configuration used loopback, but did not record a nonzero DDS domain. Studio does not launch this historical runner.",
        "Recording did not save source/model revisions. Current checkout/model hashes are provenance at read time, not certified recording-time identity."])
    metadata["source_samples"] = n
    metadata["joint_qpos_addresses"] = dict(zip(JOINT_NAMES, addresses))
    metadata["recorded_state_rate_hz"] = float((n-1) / duration)
    metadata["sim_duration_s"] = float(qt[-1]-qt[0])
    return {"schema_version": 1, "metadata": metadata, "joint_names": list(JOINT_NAMES), "frames": frames,
            "events": sorted(events, key=lambda e:e["time"]), "environment": {"boxes": boxes, "classification": "simulator-ground-truth", "source": str(zpath)},
            "perception": _final_map(path/"node_memory.npz", duration), "graph": _graph(False),
            "trajectory": [f["position"] for f in frames]}


def load_session(path, *, environment_path=None, model_path=None, max_frames=MAX_FRAMES):
    """Decode one explicitly selected directory. Never searches research trees."""
    path = Path(path).expanduser().resolve()
    if (path / "closed_loop.npz").is_file():
        return _lockstep(path, environment_path, model_path, max_frames)
    if (path / "sim.npz").is_file():
        return _realtime(path, model_path, max_frames)
    raise ReplayError(f"No supported recording in {path}")


def frame_at(session, time_s, stale_after_s=.1):
    """Causal replay sample-and-hold, including honest pre-start/end freshness."""
    if not math.isfinite(time_s):
        raise ReplayError("Replay cursor must be finite")
    frames = session["frames"]
    i = bisect.bisect_right([f["time"] for f in frames], time_s)-1
    if i < 0:
        return {"frame": None, "status": "unavailable", "age_ms": None}
    age = max(0.0, time_s-frames[i]["time"])
    return {"frame": frames[i], "status": "stale" if age > stale_after_s else "fresh", "age_ms": age*1000}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default=str(DEFAULT_SESSION))
    parser.add_argument("--environment")
    args = parser.parse_args()
    session = load_session(args.path, environment_path=args.environment)
    print(json.dumps({"metadata": session["metadata"], "frames": len(session["frames"]),
                      "first_sample": {k:session["frames"][0][k] for k in ("time", "position", "joints", "health")},
                      "events": len(session["events"])}, indent=2, allow_nan=False))


if __name__ == "__main__":
    main()
