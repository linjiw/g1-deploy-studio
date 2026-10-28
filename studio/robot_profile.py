"""Source-inspected Unitree G1 29-DoF robot contract (stdlib only).

``load_profile()`` reads ``config/robots/g1_29dof.json`` and validates its internal
consistency. ``verify_against_sources()`` re-reads the read-only reference files the
profile cites (text, regex, ``ast``, ``xml.etree``) and returns human-readable
mismatches. Nothing here imports a deployment runtime, opens a socket, creates a DDS
participant or launches a process. The only executed reference code is the three pure
string-classification helpers of ``g1deploy/contract.py``, compiled from their AST in
an empty namespace (no module-level code, no imports).

Everything in the profile is source-inspected configuration, not hardware evidence.
"""
from __future__ import annotations

import ast
import json
import math
import operator
import re
import struct
import xml.etree.ElementTree as ET
from functools import lru_cache
from pathlib import Path

from studio import paths

DEFAULT_PATH = Path(__file__).resolve().parents[1] / "config" / "robots" / "g1_29dof.json"
ORDERS = ("unitree_motor", "mujoco", "isaaclab")
INDEX_KEY = {"unitree_motor": "unitree_motor_index", "mujoco": "mujoco_index", "isaaclab": "isaaclab_index"}
QUANTITIES = ("default_angle_rad", "kp_nm_per_rad", "kd_nm_s_per_rad", "action_scale_rad",
              "effort_limit_nm", "position_limit_rad", "velocity_limit_rad_s")
POSITIVE = ("kp_nm_per_rad", "kd_nm_s_per_rad", "action_scale_rad", "effort_limit_nm", "velocity_limit_rad_s")
EXACT_REL, ROUNDING_REL = 1e-6, 5e-3


class ProfileError(ValueError):
    """The profile is malformed or internally inconsistent."""


# ----------------------------------------------------------------------------------- loading
def load_profile(path=None) -> dict:
    # Cited paths are recorded as on the inspecting machine; relocate them onto this machine's roots (studio/paths.py).
    profile = paths.relocate_tree(json.loads(Path(path or DEFAULT_PATH).read_text()))
    validate(profile)
    return profile


@lru_cache(maxsize=1)
def _default_profile() -> dict:
    return load_profile()


def _rel(a: float, b: float) -> float:
    return abs(a - b) / max(abs(a), abs(b), 1e-12)


def agreement(values: list) -> tuple[str, float]:
    """Classify a list of numbers (or [lo, hi] pairs): exact, rounding, material, single_source."""
    flat = [v if isinstance(v, list) else [v] for v in values]
    if len(flat) < 2:
        return "single_source", 0.0
    worst = max(_rel(a[k], b[k]) for a in flat for b in flat for k in range(len(a)))
    return ("exact" if worst <= EXACT_REL else "rounding" if worst <= ROUNDING_REL else "material"), worst


def _walk(node, path="$"):
    yield path, node
    if isinstance(node, dict):
        for k, v in node.items():
            yield from _walk(v, f"{path}.{k}")
    elif isinstance(node, list):
        for i, v in enumerate(node):
            yield from _walk(v, f"{path}[{i}]")


def _check_source(src, where):
    if not (isinstance(src, dict) and isinstance(src.get("path"), str) and src["path"].startswith("/")
            and isinstance(src.get("line"), int) and src["line"] >= 1):
        raise ProfileError(f"{where}: source must be {{path (absolute), line >= 1}}")


def validate(profile: dict) -> None:
    if profile.get("schema_version") != 1:
        raise ProfileError("unsupported schema_version")
    for where, value in _walk(profile):
        if isinstance(value, float) and not math.isfinite(value):
            raise ProfileError(f"{where}: non-finite number")
        if isinstance(value, dict) and "source" in value:
            sources = value["source"] if isinstance(value["source"], list) else [value["source"]]
            for s in sources:
                _check_source(s, where)
    joints = profile.get("joints")
    if not isinstance(joints, list) or len(joints) != 29:
        raise ProfileError("expected exactly 29 joints")
    names = [j["name"] for j in joints]
    if len(set(names)) != 29:
        raise ProfileError("joint names are not unique")
    for order in ORDERS:
        seq = profile["orders"][order]
        if len(seq) != 29 or set(seq) != set(names):
            raise ProfileError(f"order {order!r} is not a permutation of the 29 joint names")
        for j in joints:
            if seq[j[INDEX_KEY[order]]] != j["name"]:
                raise ProfileError(f"{j['name']}: {INDEX_KEY[order]} disagrees with orders.{order}")
    for j in joints:
        for q in QUANTITIES:
            entry = j.get(q)
            if not entry or not entry.get("values"):
                raise ProfileError(f"{j['name']}.{q}: missing values")
            nums = []
            for v in entry["values"]:
                if v.get("origin") not in profile.get("value_origins", {}):
                    raise ProfileError(f"{j['name']}.{q}: unknown value origin {v.get('origin')!r}")
                _check_source(v.get("source"), f"{j['name']}.{q}.{v.get('origin')}")
                x = v["value"]
                nums.append(x)
                parts = x if isinstance(x, list) else [x]
                if not all(isinstance(p, (int, float)) and not isinstance(p, bool) for p in parts):
                    raise ProfileError(f"{j['name']}.{q}: non-numeric value")
                if q in POSITIVE and not all(p > 0 for p in parts):
                    raise ProfileError(f"{j['name']}.{q}.{v['origin']}: must be positive")
                if q == "position_limit_rad" and not (len(x) == 2 and x[0] < x[1]):
                    raise ProfileError(f"{j['name']}.{q}: expected [lower, upper] with lower < upper")
            label, _ = agreement(nums)
            if entry.get("agreement") != label:
                raise ProfileError(f"{j['name']}.{q}: agreement {entry.get('agreement')!r} != {label!r}")
            if label in ("exact", "single_source") and entry.get("value") != nums[0]:
                raise ProfileError(f"{j['name']}.{q}: value must equal the agreed source value")
            if label in ("rounding", "material") and entry.get("value") is not None:
                raise ProfileError(f"{j['name']}.{q}: disagreeing sources must leave value null")
    for t in profile.get("safety_thresholds", []):
        missing = {"id", "value", "unit", "owner", "effect", "source"} - set(t)
        if missing:
            raise ProfileError(f"safety threshold {t.get('id')}: missing {sorted(missing)}")


# ----------------------------------------------------------------------------------- helpers
def joint_index(name: str, order: str, profile: dict | None = None) -> int:
    seq = (profile or _default_profile())["orders"][order]
    try:
        return seq.index(name)
    except ValueError:
        raise KeyError(f"unknown joint {name!r}") from None


def reorder(values, from_order: str, to_order: str, profile: dict | None = None) -> list:
    """Re-index a 29-vector by joint name: ``out[to.index(n)] = values[from.index(n)]``."""
    orders = (profile or _default_profile())["orders"]
    src, dst = orders[from_order], orders[to_order]
    values = list(values)
    if len(values) != len(src):
        raise ValueError(f"expected {len(src)} values in {from_order} order, got {len(values)}")
    by_name = dict(zip(src, values))
    return [by_name[n] for n in dst]


# ----------------------------------------------------------------------------- source parsers
_OPS = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
        ast.Div: operator.truediv, ast.Pow: operator.pow}


def _eval(expr, names: dict) -> float:
    """Arithmetic on numbers and named constants only (C++ and Python constant expressions)."""
    node = ast.parse(expr.strip(), mode="eval").body if isinstance(expr, str) else expr

    def ev(n):
        if isinstance(n, ast.Constant) and isinstance(n.value, (int, float)) and not isinstance(n.value, bool):
            return float(n.value)
        if isinstance(n, ast.Name) and n.id in names:
            return names[n.id]
        if isinstance(n, ast.UnaryOp) and isinstance(n.op, ast.USub):
            return -ev(n.operand)
        if isinstance(n, ast.BinOp) and type(n.op) in _OPS:
            return _OPS[type(n.op)](ev(n.left), ev(n.right))
        raise ProfileError(f"unsupported constant expression: {ast.dump(n)}")
    return ev(node)


def _f32(x: float) -> float:
    return struct.unpack("<f", struct.pack("<f", x))[0]


def _line_of(text: str, pos: int) -> int:
    return text.count("\n", 0, pos) + 1


def parse_cpp_arrays(text: str) -> dict:
    """``const std::array<T, N> name = {...};`` -> {name: [(expr, line, comment), ...]} plus element type."""
    out = {}
    for m in re.finditer(r"const std::array<(\w+),\s*(\d+)>\s+(\w+)\s*=\s*\{(.*?)\};", text, re.S):
        line, entries = _line_of(text, m.start(4)), []
        for k, raw in enumerate(m.group(4).split("\n")):
            code, _, comment = raw.partition("//")
            for piece in code.split(","):
                if piece.strip():
                    entries.append((piece.strip(), line + k, comment.strip()))
        out[m.group(3)] = {"type": m.group(1), "size": int(m.group(2)), "entries": entries}
    return out


def parse_runner_parameters(path) -> dict:
    """policy_parameters.hpp -> constants, per-joint gains/scales/defaults (MuJoCo order) and mappings."""
    text = Path(path).read_text()
    consts = {}
    for m in re.finditer(r"^\s*const double (\w+)\s*=\s*([^;]+);", text, re.M):
        consts[m.group(1)] = _eval(m.group(2), consts)
    arrays = parse_cpp_arrays(text)
    out = {"constants": consts, "arrays": arrays}
    for name in ("kps", "kds", "g1_action_scale", "default_angles"):
        a = arrays[name]
        vals = [_eval(e, consts) for e, _, _ in a["entries"]]
        out[name] = [_f32(v) for v in vals] if a["type"] == "float" else vals
        out[name + "_joints"] = [re.search(r"(\w+_joint)", c).group(1) for _, _, c in a["entries"]]
    for name in ("isaaclab_to_mujoco", "mujoco_to_isaaclab"):
        out[name] = [int(e) for e, _, _ in arrays[name]["entries"]]
    return out


def parse_robot_parameters(path) -> dict:
    text = Path(path).read_text()
    topics = dict(re.findall(r'static const std::string (\w+)\s*=\s*"([^"]+)"', text))
    enum = re.search(r"enum G1JointIndex\s*\{(.*?)\};", text, re.S).group(1)
    by_index = {}
    for name, idx in re.findall(r"(\w+)\s*=\s*(\d+)", enum):
        by_index.setdefault(int(idx), name)  # first symbol per index; later ones are A/B aliases
    snake = [re.sub(r"(?<!^)(?=[A-Z])", "_", by_index[i]).lower() + "_joint" for i in sorted(by_index)]
    return {"topics": topics, "motor_order": snake,
            "num_motor": int(re.search(r"const int G1_NUM_MOTOR\s*=\s*(\d+);", text).group(1))}


def parse_flow_contract(path) -> dict:
    """g1deploy/contract.py: joint orders by AST literals; gain tables; pure classification helpers."""
    text = Path(path).read_text()
    tree = ast.parse(text)
    lit = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            value = node.value.args[0] if isinstance(node.value, ast.Call) and node.value.args else node.value
            try:
                lit[node.targets[0].id] = ast.literal_eval(value)
            except (ValueError, TypeError, SyntaxError):
                pass
    funcs = [n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name in ("_group", "_effort", "_default")]
    ns = {"__builtins__": {"any": any, "str": str, "float": float}}
    exec(compile(ast.Module(body=funcs, type_ignores=[]), str(path), "exec"), ns)  # pure helpers only
    mj, i2m = list(lit["MJ_JOINTS"]), list(lit["ISAAC_TO_MJ"])
    joints = {}
    for n in mj:
        g = ns["_group"](n)
        kp, kd, eff = lit["_KP"][g], lit["_KD"][g], ns["_effort"](n)
        joints[n] = {"group": g, "kp_nm_per_rad": kp, "kd_nm_s_per_rad": kd, "effort_limit_nm": eff,
                     "default_angle_rad": ns["_default"](n), "action_scale_rad": 0.25 * eff / kp}
    return {"mujoco_order": mj, "isaac_to_mj": i2m, "isaaclab_order": [mj[i] for i in i2m], "joints": joints}


def parse_mjcf(path, names) -> dict:
    """Body hinge joints of an MJCF: document order, ranges, actuatorfrcrange, parent body, line."""
    lines = Path(path).read_text().split("\n")
    root = ET.parse(path).getroot()
    order, joints, all_hinges = [], {}, []
    for body in root.iter("body"):
        for j in body.findall("joint"):
            n = j.get("name")
            if n and j.get("type") != "free":
                all_hinges.append(n)
            if n in names:
                order.append(n)
                lo, hi = (float(x) for x in j.get("range").split())
                frc = j.get("actuatorfrcrange")
                line = next(i + 1 for i, s in enumerate(lines) if f'<joint name="{n}"' in s)
                joints[n] = {"position_limit_rad": [lo, hi], "body": body.get("name"), "line": line,
                             "effort_limit_nm": max(abs(float(x)) for x in frc.split()) if frc else None}
    return {"order": order, "all_joints": all_hinges, "joints": joints}


def parse_sim_torque_limits(yaml_path, model_joint_order) -> dict:
    text = Path(yaml_path).read_text()
    m = re.search(r"^motor_effort_limit_list:\s*\[(.*?)\]", text, re.S | re.M)
    vals = [float(x) for x in m.group(1).replace("\n", " ").split(",") if x.strip()]
    if len(vals) != len(model_joint_order):
        raise ProfileError(f"{yaml_path}: {len(vals)} torque limits for {len(model_joint_order)} model joints")
    return {"line": _line_of(text, m.start()), "limits": dict(zip(model_joint_order, vals))}


def parse_training(path, names) -> dict:
    """gear_sonic g1.py: constants, ImplicitActuatorCfg groups and init joint_pos, resolved per joint."""
    tree = ast.parse(Path(path).read_text())
    consts = {}
    for node in tree.body:
        if isinstance(node, ast.Assign) and isinstance(node.targets[0], ast.Name):
            try:
                consts[node.targets[0].id] = _eval(node.value, consts)
            except (ProfileError, KeyError):
                pass
    out = {n: {} for n in names}
    for call in (c for c in ast.walk(tree) if isinstance(c, ast.Call)):
        fname = getattr(call.func, "id", getattr(call.func, "attr", None))
        kw = {k.arg: k.value for k in call.keywords}
        if fname == "ImplicitActuatorCfg":
            exprs = ast.literal_eval(kw["joint_names_expr"])
            for field, key in (("effort_limit_sim", "effort_limit_nm"), ("velocity_limit_sim", "velocity_limit_rad_s"),
                               ("stiffness", "kp_nm_per_rad"), ("damping", "kd_nm_s_per_rad")):
                node = kw[field]
                table = ({ast.literal_eval(k): (_eval(v, consts), k.lineno) for k, v in zip(node.keys, node.values)}
                         if isinstance(node, ast.Dict) else {e: (_eval(node, consts), node.lineno) for e in exprs})
                for n in names:
                    hit = [v for pat, v in table.items() if re.fullmatch(pat, n)]
                    if hit:
                        out[n][key] = hit[0]
        elif fname == "InitialStateCfg":
            node = kw["joint_pos"]
            table = {ast.literal_eval(k): (_eval(v, consts), k.lineno) for k, v in zip(node.keys, node.values)}
            for n in names:
                hit = [v for pat, v in table.items() if re.fullmatch(pat, n)]
                out[n]["default_angle_rad"] = hit[0] if hit else (0.0, node.lineno)  # unmatched joints: 0.0
    for n in names:
        if "effort_limit_nm" in out[n] and "kp_nm_per_rad" in out[n]:
            out[n]["action_scale_rad"] = (0.25 * out[n]["effort_limit_nm"][0] / out[n]["kp_nm_per_rad"][0],
                                          out[n]["kp_nm_per_rad"][1])
    return {"constants": consts, "joints": out}


def parse_bundle_contract(path, names) -> dict:
    data = json.loads(Path(path).read_text())
    out = {}
    for j in data["joints"]:
        if j["name"] in names:
            frc = j["attributes"].get("actuatorfrcrange")
            out[j["name"]] = {"position_limit_rad": list(j["range_rad"]),
                              "effort_limit_nm": max(abs(float(x)) for x in frc.split()) if frc else None}
    return {"model_name": data.get("model_name"), "joints": out}


def source_values(files: dict, names) -> dict:
    """{origin: {joint: {quantity: value}}} re-derived from the reference files."""
    rp = parse_runner_parameters(files["runner_policy_parameters"])
    fc = parse_flow_contract(files["flow_contract"])
    tr = parse_training(files["training_g1"], names)
    stud = parse_mjcf(files["mjcf_student_rubber"], names)
    dex3 = parse_mjcf(files["mjcf_lucid_dex3"], names)
    clip = parse_sim_torque_limits(files["lucid_sim_yaml"], dex3["all_joints"])
    bund = parse_bundle_contract(files["bundle_sonic_model_contract"], names)
    runner = {}
    for key, q in (("kps", "kp_nm_per_rad"), ("kds", "kd_nm_s_per_rad"),
                   ("g1_action_scale", "action_scale_rad"), ("default_angles", "default_angle_rad")):
        for n, v in zip(rp[key + "_joints"], rp[key]):
            runner.setdefault(n, {})[q] = v
    return {
        "runner_cpp": runner,
        "flow_python": {n: {k: v for k, v in d.items() if k != "group"} for n, d in fc["joints"].items()},
        "training_isaaclab": {n: {k: v[0] for k, v in d.items()} for n, d in tr["joints"].items()},
        "mjcf_student_rubber": {n: {k: d[k] for k in ("position_limit_rad", "effort_limit_nm")}
                                for n, d in stud["joints"].items()},
        "mjcf_lucid_dex3": {n: {k: d[k] for k in ("position_limit_rad", "effort_limit_nm")}
                            for n, d in dex3["joints"].items()},
        "lucid_sim_torque_clip": {n: {"effort_limit_nm": clip["limits"][n]} for n in names},
        "bundle_rev_1_0_contract": bund["joints"],
    }


def source_orders(files: dict, names) -> dict:
    """Each order as re-derived from every source that defines it."""
    rp = parse_runner_parameters(files["runner_policy_parameters"])
    fc = parse_flow_contract(files["flow_contract"])
    robot = parse_robot_parameters(files["runner_robot_parameters"])
    stud = parse_mjcf(files["mjcf_student_rubber"], names)
    dex3 = parse_mjcf(files["mjcf_lucid_dex3"], names)
    mj = fc["mujoco_order"]
    body_to_joint = {d["body"]: n for n, d in stud["joints"].items()}
    tree = ast.parse(Path(files["training_g1"]).read_text())
    bodies = next(ast.literal_eval(n.value) for n in tree.body
                  if isinstance(n, ast.Assign) and getattr(n.targets[0], "id", "") == "G1_ISAACLAB_JOINTS")
    return {
        "unitree_motor": {"runner_robot_parameters_enum": robot["motor_order"]},
        "mujoco": {"flow_contract_MJ_JOINTS": mj, "mjcf_student_rubber": stud["order"],
                   "mjcf_lucid_dex3_body_subset": dex3["order"],
                   **{f"runner_{a}_comments": rp[a + "_joints"]
                      for a in ("kps", "kds", "g1_action_scale", "default_angles")}},
        "isaaclab": {"flow_contract_ISAAC_TO_MJ": fc["isaaclab_order"],
                     "runner_mujoco_to_isaaclab": [mj[i] for i in rp["mujoco_to_isaaclab"]],
                     "runner_isaaclab_to_mujoco_inverse": sorted(mj, key=lambda n: rp["isaaclab_to_mujoco"][mj.index(n)]),
                     "training_G1_ISAACLAB_JOINTS_bodies": [body_to_joint[b] for b in bodies if b in body_to_joint]},
    }


# ------------------------------------------------------------------------------ verification
def _norm(s: str) -> str:
    return " ".join(s.split())


def _check_citations(profile: dict) -> list[str]:
    problems, cache = [], {}
    for where, node in _walk(profile):
        if not (isinstance(node, dict) and isinstance(node.get("path"), str) and isinstance(node.get("line"), int)):
            continue
        p = node["path"]
        if p not in cache:
            try:
                cache[p] = Path(p).read_text(errors="replace").split("\n")
            except OSError as exc:
                cache[p] = exc
        lines = cache[p]
        if isinstance(lines, OSError):
            problems.append(f"{where}: cannot read {p}: {lines}")
        elif node["line"] > len(lines):
            problems.append(f"{where}: {p}:{node['line']} beyond end of file ({len(lines)} lines)")
        elif "match" in node and _norm(node["match"]) not in _norm(lines[node["line"] - 1]):
            problems.append(f"{where}: {p}:{node['line']} no longer contains {node['match']!r}")
    return problems


def _same(a, b) -> bool:
    if isinstance(a, list) or isinstance(b, list):
        return isinstance(a, list) and isinstance(b, list) and len(a) == len(b) and all(map(_same, a, b))
    return a is not None and b is not None and _rel(float(a), float(b)) <= 1e-9


def verify_against_sources(profile: dict) -> list[str]:
    """Re-parse the cited reference sources read-only; return mismatches (empty when in sync)."""
    problems = _check_citations(profile)
    files = profile["source_files"]
    missing = [f"missing source file {k}: {p}" for k, p in files.items() if not Path(p).is_file()]
    if missing:
        return problems + missing
    names = profile["orders"]["mujoco"]
    try:
        derived = source_values(files, names)
        orders = source_orders(files, names)
    except (ProfileError, KeyError, AttributeError, StopIteration, SyntaxError, ET.ParseError) as exc:
        return problems + [f"source parsing failed: {type(exc).__name__}: {exc}"]
    for j in profile["joints"]:
        for q in QUANTITIES:
            for v in j[q]["values"]:
                got = derived.get(v["origin"], {}).get(j["name"], {}).get(q)
                if not _same(got, v["value"]):
                    problems.append(f"{j['name']}.{q}.{v['origin']}: profile {v['value']!r} != source {got!r}")
    for order, by_source in orders.items():
        for src, seq in by_source.items():
            if list(seq) != profile["orders"][order]:
                problems.append(f"orders.{order}: source {src} gives {seq}")
    for t in profile.get("safety_thresholds", []):
        lit = t.get("literal")
        if lit is None or lit not in t["source"].get("match", ""):
            problems.append(f"safety_thresholds.{t['id']}: literal {lit!r} missing from cited match")
        elif re.fullmatch(r"-?\d+(\.\d+)?", lit):
            if not _same(float(lit) * t.get("literal_scale", 1.0), t["value"]):
                problems.append(f"safety_thresholds.{t['id']}: literal {lit} != value {t['value']}")
        elif not t.get("value_derived_from_formula"):
            problems.append(f"safety_thresholds.{t['id']}: non-numeric literal without value_derived_from_formula")
    return problems
