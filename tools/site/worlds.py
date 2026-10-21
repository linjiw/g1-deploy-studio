"""The worlds the public site offers, each with its start mark. Geometry only; nothing here runs a robot.

Flow arenas come from the deploy repository's development scenes (``studio.workbench.development_maps``); the
Studio arenas are committed copies of the arenas saved by Studio's arena editor (``tools/site/worlds/*.json``).
"""
from __future__ import annotations

import json
import math
from pathlib import Path

HERE = Path(__file__).resolve().parent

WORLDS = {
    'detour': {'source': 'flow-detour', 'title': 'Wall detour', 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0,
               'blurb': 'One wall across the room. The robot can only plan around what its LiDAR has seen.'},
    'slalom': {'source': 'flow-slalom', 'title': 'Alternating walls', 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0,
               'blurb': 'Three staggered walls: the route weaves, and the far side is hidden until the robot moves.'},
    'corridor': {'source': 'flow-corridor', 'title': 'Corridor and overhead beam', 'start_xy': [0.0, 0.0], 'start_yaw_rad': 0.0,
                 'blurb': 'A corridor with a beam overhead. The map keeps overhead cells apart from obstacles.'},
    'doorway': {'source': 'worlds/doorway.json', 'title': 'Offset doorway', 'start_xy': [0.0, -1.0],
                'start_yaw_rad': 0.4363323129985824,
                'blurb': 'A 0.8 m doorway, offset from the start. Tight for a 0.6 m wide robot; not every walk makes it.'},
    'clutter': {'source': 'worlds/clutter.json', 'title': 'Cluttered room', 'start_xy': [0.0, 0.0],
                'start_yaw_rad': 1.5707963267948966,
                'blurb': 'Nine boxes of different heights, some low enough to step over.'},
}


def world_map(world_id):
    """The world's collision boxes as the nav worker's request map (``policy_worker.clean_map`` input)."""
    spec = WORLDS[world_id]
    source = spec['source']
    if source.startswith('worlds/'):
        data = json.loads((HERE / source).read_text())
    else:
        from studio.workbench import REFERENCE_ROOT, development_maps
        data = next(m for m in development_maps(REFERENCE_ROOT) if m['id'] == source)
    bounds = data.get('bounds') or {}
    return {'id': f'site-{world_id}', 'label': spec['title'], 'kind': 'boxes', 'frame_id': 'world',
            'boxes': [{k: b[k] for k in ('center_xy', 'half_xy', 'yaw', 'z_bottom', 'z_top') if k in b} for b in data['boxes']],
            'source': str(data.get('provenance') or source)[:900]}, bounds


def describe(world_id):
    spec = WORLDS[world_id]
    m, bounds = world_map(world_id)
    return {'id': world_id, 'title': spec['title'], 'blurb': spec['blurb'], 'start_xy': spec['start_xy'],
            'start_yaw_rad': spec['start_yaw_rad'], 'boxes': m['boxes'],
            'bounds': {'min': [float(v) for v in bounds.get('min', [-3, -3])], 'max': [float(v) for v in bounds.get('max', [5, 3])]},
            'start_yaw_deg': round(math.degrees(spec['start_yaw_rad']), 1)}
