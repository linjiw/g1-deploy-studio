#!/usr/bin/env python3
"""The G1 kinematic tree for the static site: bodies, joint axes, offsets and mesh references from the MJCF.

    .venv/bin/python -m tools.site.export_robot --out <site-data dir>

Writes ``robot.json`` (the tree studio/model.py serves to Studio, mesh URLs replaced by mesh names) and
``robot-meshes.txt`` (name and source STL per line) for ``tools/site/meshes.mjs``, which simplifies the meshes.
The model is the deploy repository's ``sim/assets/g1_29dof.xml`` (rubber hands), the body the walks ran with.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from studio.model import RobotModel  # noqa: E402
from studio.workbench import REFERENCE_ROOT  # noqa: E402

MODEL = REFERENCE_ROOT / 'sim/assets/g1_29dof.xml'


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--out', required=True, type=Path)
    args = ap.parse_args(argv)
    model = RobotModel(MODEL, 'g1')
    by_url = {f'/assets/mesh/{token}.stl': path for token, path in model.assets.items()}
    meshes = {}

    def walk(body):
        for g in body['geometries']:
            if g['type'] == 'mesh':
                path = by_url[g.pop('url')]
                g['mesh'] = path.stem
                meshes[path.stem] = path
        for c in body['children']:
            walk(c)
    d = model.description
    walk(d['root'])
    out = {'name': d['name'], 'nq': d['nq'], 'joint_names': d['joint_names'], 'root': d['root'],
           'quaternion_convention': 'wxyz', 'frame_convention': 'right-handed, Z up', 'units': d['units'],
           'source': {'model': 'g1-student-deploy sim/assets/g1_29dof.xml (Unitree G1 29 DoF, rubber hands)',
                      'sha256': d['sha256'],
                      'meshes': 'Unitree G1 meshes, simplified for the web by tools/site/meshes.mjs (see NOTICE)'}}
    args.out.mkdir(parents=True, exist_ok=True)
    (args.out / 'robot.json').write_text(json.dumps(out, separators=(',', ':')))
    (args.out / 'robot-meshes.txt').write_text(''.join(f'{name}\t{path}\n' for name, path in sorted(meshes.items())))
    print(len(meshes), 'meshes')
    return 0


if __name__ == '__main__':
    sys.exit(main())
