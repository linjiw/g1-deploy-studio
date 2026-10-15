"""Read local G1 MJCF visual/kinematic assets. No simulation stepping or DDS imports.

Meshes stay in their existing source repository. Only individually declared files
are served. This exporter deliberately supports the inspected G1 MJCF subset;
unknown transform conventions fail rather than silently misaligning the robot.
"""
from __future__ import annotations

import hashlib
from pathlib import Path
import xml.etree.ElementTree as ET

import mujoco
import numpy as np


def values(node, field, default):
    return [float(v) for v in node.get(field, default).split()]


def quaternion(node):
    if any(k in node.attrib for k in ("euler", "axisangle", "xyaxes", "zaxis")):
        raise ValueError("Unsupported MJCF orientation: expected explicit wxyz quaternion")
    q = np.array(values(node, "quat", "1 0 0 0"))
    if len(q) != 4 or not np.isfinite(q).all() or np.linalg.norm(q) < 1e-9:
        raise ValueError("Invalid MJCF quaternion")
    return (q / np.linalg.norm(q)).tolist()


class RobotModel:
    def __init__(self, path: str | Path, key: str):
        self.path = Path(path).resolve(strict=True)
        self.key = key
        self.assets = {}
        documents = []
        seen = set()

        def read(p):
            p = p.resolve(strict=True)
            if p in seen or not p.is_relative_to(self.path.parent):
                raise ValueError("Cyclic or out-of-root model include")
            seen.add(p)
            tree = ET.parse(p).getroot()
            documents.append((p, tree))
            for item in tree.findall("include"):
                read(p.parent / item.attrib["file"])

        read(self.path)
        self.mj = mujoco.MjModel.from_xml_path(str(self.path))
        self.sources = {str(p): hashlib.sha256(p.read_bytes()).hexdigest() for p, _ in documents}
        mesh_defs = {}
        pelvis = None
        for p, doc in documents:
            compiler = doc.find("compiler")
            if compiler is not None and compiler.get("angle", "degree") != "radian":
                raise ValueError("Only verified radian G1 models supported")
            meshdir = p.parent / (compiler.get("meshdir", "") if compiler is not None else "")
            for mesh in doc.findall("asset/mesh"):
                meshpath = (meshdir / mesh.attrib["file"]).resolve(strict=True)
                # symlink targets are acceptable local references, never browser supplied.
                token = f"{len(self.assets)}.stl"
                if meshpath.suffix.lower() != ".stl":
                    raise ValueError("Only local STL meshes supported")
                self.assets[token] = meshpath
                mesh_defs[mesh.attrib["name"]] = {
                    "url": f"/assets/model/{key}/{token}",
                    "scale": values(mesh, "scale", "1 1 1"),
                }
            candidate = doc.find("worldbody/body[@name='pelvis']")
            if candidate is not None:
                if pelvis is not None:
                    raise ValueError("Ambiguous pelvis")
                pelvis = candidate
        if pelvis is None:
            raise ValueError("G1 pelvis missing")

        def body(node):
            joints = node.findall("joint")
            if len(joints) > 1 or node.find("freejoint") is not None:
                raise ValueError("Unsupported MJCF joint layout")
            joint = None
            if joints:
                j = joints[0]
                name = j.attrib["name"]
                ji = mujoco.mj_name2id(self.mj, mujoco.mjtObj.mjOBJ_JOINT, name)
                jt = j.get("type", "hinge")
                if ji < 0 or jt not in ("free", "hinge") or float(j.get("ref", "0")) != 0:
                    raise ValueError("Unsupported joint type/reference")
                axis = np.array(values(j, "axis", "0 0 1"))
                axis /= np.linalg.norm(axis)
                joint = {"name": name, "type": jt, "axis": axis.tolist(),
                         "position": values(j, "pos", "0 0 0"),
                         "qpos_index": int(self.mj.jnt_qposadr[ji]),
                         "range": self.mj.jnt_range[ji].tolist()}
            geoms = []
            unique = set()
            for g in node.findall("geom"):
                if "fromto" in g.attrib:
                    raise ValueError("Unsupported fromto geometry")
                kind = g.get("type", "sphere")
                signature = (kind, g.get("mesh"), g.get("pos"), g.get("quat"), g.get("size"))
                if signature in unique:
                    continue
                unique.add(signature)
                geom = {"type": kind, "position": values(g, "pos", "0 0 0"),
                        "quaternion_wxyz": quaternion(g), "size": values(g, "size", "1"),
                        "rgba": values(g, "rgba", "0.6 0.65 0.7 1"), "scale": [1, 1, 1]}
                if kind == "mesh":
                    geom.update(mesh_defs[g.attrib["mesh"]])
                geoms.append(geom)
            return {"name": node.attrib["name"], "position": values(node, "pos", "0 0 0"),
                    "quaternion_wxyz": quaternion(node), "joint": joint,
                    "geometries": geoms, "children": [body(c) for c in node.findall("body")]}

        self.description = {
            "name": self.mj.names.decode(errors="replace").split("\0")[0],
            "nq": self.mj.nq, "source_path": str(self.path), "source_hashes": self.sources,
            "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest(),
            "root": body(pelvis), "joint_names": [self.mj.joint(j).name for j in range(self.mj.njnt)
                                                   if self.mj.jnt_type[j] == mujoco.mjtJoint.mjJNT_HINGE],
            "units": {"position": "m", "joint_angle": "rad"},
            "quaternion_convention": "wxyz", "frame_convention": "right-handed, Z up",
            "asset_policy": "Read from local integration source; not redistributed or copied into Git",
        }

    def body_poses(self, qpos):
        """Oracle for browser FK acceptance; kinematics only, no physics stepping."""
        q = np.asarray(qpos)
        if q.shape != (self.mj.nq,) or not np.isfinite(q).all():
            raise ValueError("qpos shape or values do not match model")
        data = mujoco.MjData(self.mj)
        data.qpos[:] = q
        mujoco.mj_kinematics(self.mj, data)
        return {self.mj.body(b).name: {"position": data.xpos[b].tolist(),
                                      "quaternion_wxyz": data.xquat[b].tolist()}
                for b in range(1, self.mj.nbody)}
