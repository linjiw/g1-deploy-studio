"""Local preparation data and owned CPU simulation jobs. No robot transport code."""
from __future__ import annotations

import copy
import fcntl
from functools import lru_cache
import hashlib
import json
import math
import os
from pathlib import Path
import secrets
import signal
import subprocess
import sys
import threading
import time
import uuid

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_POLICY_ID = 'flow-bundle-20261008'
DATA_ROOT = Path.home() / 'research-data/g1-deploy-studio/workbench'
REFERENCE_ROOT = Path('/home/linjiw/code/g1-student-deploy')
MAX_MAP_POINTS = 20000
MAX_BOXES = 128
MAX_JOBS = 128  # bounded metadata history for repeated multi-scene reviews
MAX_OUTPUT_BYTES = 256 * 1024 * 1024
MAX_ARENAS = 64
MAX_PRESETS = 16
MAX_SUITE_RUNS = 12
MAX_SUITES = 64
SUITE_ACTIVE = ('queued', 'running', 'cancelling')
ACTIVE_STATES = ('starting', 'running', 'cancelling')
TERMINAL_STATES = ('completed', 'failed', 'cancelled')
HISTORY_FIELDS = ('id', 'status', 'scenario_id', 'scenario', 'started_unix_s', 'finished_unix_s',
                  'exit_code', 'error', 'result_session_id', 'recovered', 'ownership', 'suite_id',
                  'policy_id', 'policy_identity')
DEVELOPMENT_SCENES = (
    ('flow-detour', 'detour', 20261015, 'Flow arena · wall detour',
     'A standing wall blocks the direct route. Select a goal on either side to inspect avoidance.'),
    ('flow-slalom', 'slalom', 20261016, 'Flow arena · alternating walls',
     'Three alternating wall stubs require lateral route changes; this is a navigation challenge, not a promised success.'),
    ('flow-corridor', 'corridor_beam', 20261017, 'Flow arena · corridor and overhead beam',
     'Side walls constrain steering while an overhead beam constrains body height.'),
)


@lru_cache(maxsize=2)
def _generate_development_layouts(source_path, source_sha256):
    """Run only the fixed source geometry generator in an isolated, bounded process.

    Never call make_panel: that entry point reads research task templates. These
    fresh development seeds call the pure layout function only, without panels,
    research outcomes, controller imports or writes to the reference repository.
    """
    code = '''import hashlib, importlib.util, json, pathlib, sys
import numpy as np
path = pathlib.Path(sys.argv[1])
if hashlib.sha256(path.read_bytes()).hexdigest() != sys.argv[2]:
    raise RuntimeError("Scene source changed during catalog construction")
spec = importlib.util.spec_from_file_location("studio_scene_source", path)
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
scenes = json.loads(sys.argv[3])
result = []
for family, seed in scenes:
    boxes, goal = module.layout(family, np.random.default_rng(seed))
    result.append({"family": family, "seed": seed, "boxes": boxes, "goal_xy": goal})
print(json.dumps({"numpy_version": np.__version__, "layouts": result}, allow_nan=False))
'''
    process = subprocess.run(
        [sys.executable, '-I', '-B', '-c', code, source_path, source_sha256,
         json.dumps([[s[1], s[2]] for s in DEVELOPMENT_SCENES])],
        capture_output=True, text=True, timeout=5, check=True,
        env=dict(os.environ, PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='',
                 OMP_NUM_THREADS='1', OPENBLAS_NUM_THREADS='1', MKL_NUM_THREADS='1'))
    if len(process.stdout) > 65536:
        raise ValueError('Scene generator exceeded the bounded geometry response')
    return json.loads(process.stdout)


def development_maps(reference_root=REFERENCE_ROOT):
    source = Path(reference_root) / 'bundle/flow/src/motion2scene_flow/closed_loop/panel.py'
    if not source.is_file():
        return []
    if source.stat().st_size > 1024 * 1024:
        raise ValueError('Scene source exceeds the bounded source read')
    source_hash = hashlib.sha256(source.read_bytes()).hexdigest()
    generated = _generate_development_layouts(str(source), source_hash)
    maps = []
    for definition, layout in zip(DEVELOPMENT_SCENES, generated['layouts'], strict=True):
        key, family, seed, title, description = definition
        if layout['family'] != family or layout['seed'] != seed:
            raise ValueError('Scene generator identity mismatch')
        # The worker supports static native box colliders. Do not silently
        # discard motion if a future generator changes its scene contract.
        if any(b.get('velocity_xy', [0, 0]) != [0, 0] for b in layout['boxes']):
            raise ValueError('Moving scene obstacles are not supported by this backend')
        data = validate_map({'label': title, 'kind': 'boxes', 'frame_id': 'world',
                             'units': 'm', 'boxes': layout['boxes']})
        goal = vector(layout['goal_xy'], 'source goal XY', low=-50, high=50)
        data.update(id=key, description=description,
                    suggested_scenario={'start_xy': [0, 0], 'goal_xy': goal,
                                        'start_yaw_rad': 0, 'duration_s': 8,
                                        'seed': 0, 'planner': {'candidates': 4, 'ode_steps': 6}},
                    provenance={'path': str(source), 'sha256': source_hash,
                                'source_kind': 'source_generated_development_layout',
                                'function': 'layout', 'family': family, 'layout_seed': seed,
                                'numpy_version': generated['numpy_version'],
                                'generator_frame': 'local x-forward, y-left; identity transform to world',
                                'origin_xy': [0, 0], 'yaw_rad': 0,
                                'research_panel_read': False,
                                'note': 'Fresh Studio development geometry from the existing Flow generator; no recorded or sealed evaluation result used.'})
        if any(point_status(data, p)['status'] != 'configured_free' for p in ([0, 0], goal)):
            raise ValueError('Generated scene preset fails standing-footprint preflight')
        maps.append(data)
    return maps


def finite(value, name, low=-1000., high=1000.):
    if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
        raise ValueError(f'{name} must be finite in [{low}, {high}]')
    return float(value)


def vector(value, name, length=2, low=-1000., high=1000.):
    if not isinstance(value, list) or len(value) != length:
        raise ValueError(f'{name} needs {length} numeric coordinates')
    return [finite(v, name, low, high) for v in value]


def integer(value, name, low, high):
    if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
        raise ValueError(f'{name} must be an integer in [{low}, {high}]')
    return value


def label(value):
    if not isinstance(value, str) or not value.strip() or len(value) > 100:
        raise ValueError('Label must contain 1–100 characters')
    return value.strip()


def read_json(path, limit=64 * 1024 * 1024):
    path = Path(path)
    if path.stat().st_size > limit:
        raise ValueError('Data exceeds bounded read limit')
    return json.loads(path.read_text(), parse_constant=lambda s: (_ for _ in ()).throw(ValueError(f'Invalid JSON number {s}')))


def atomic_json(path, data):
    path = Path(path)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    try:
        temporary.write_text(json.dumps(data, allow_nan=False, separators=(',', ':')))
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def validate_map(document):
    """Accept bounded geometry/scan values, never paths, meshes, scripts or URLs."""
    if not isinstance(document, dict):
        raise ValueError('Map must be a JSON object')
    if 'units' in document and document['units'] != 'm':
        raise ValueError('Map units must be metres (m); explicit unit conversion is required before import')
    if 'schema_version' in document and (type(document['schema_version']) is not int or document['schema_version'] != 1):
        raise ValueError('Map schema_version must be 1')
    if document.get('frame_id', 'world') != 'world':
        raise ValueError('Map must be explicitly aligned to world; import transforms first')
    kind = document.get('kind')
    result = {'schema_version': 1, 'label': label(document.get('label')), 'kind': kind,
              'frame_id': 'world', 'units': 'm', 'classification': 'configured_simulation_geometry' if kind == 'boxes' else 'observed_scan',
              'runnable': kind == 'boxes', 'reason': None if kind == 'boxes' else 'Scan has no verified collision geometry; policy physics testing is unavailable.'}
    xs, ys = [], []
    if kind == 'boxes':
        boxes = document.get('boxes')
        if not isinstance(boxes, list) or len(boxes) > MAX_BOXES:
            raise ValueError(f'Expected at most {MAX_BOXES} boxes')
        clean = []
        for box in boxes:
            if not isinstance(box, dict):
                raise ValueError('Each box must be an object')
            b = {'center_xy': vector(box.get('center_xy'), 'box center', low=-50, high=50),
                 'half_xy': vector(box.get('half_xy'), 'box half extents', low=.01, high=20),
                 'yaw': finite(box.get('yaw', 0), 'box yaw', -math.pi, math.pi),
                 'z_bottom': finite(box.get('z_bottom'), 'box bottom', 0, 10),
                 'z_top': finite(box.get('z_top'), 'box top', 0, 10)}
            if b['z_top'] <= b['z_bottom']:
                raise ValueError('Box top must exceed bottom')
            radius = math.hypot(*b['half_xy'])
            xs.extend([b['center_xy'][0]-radius, b['center_xy'][0]+radius])
            ys.extend([b['center_xy'][1]-radius, b['center_xy'][1]+radius])
            clean.append(b)
        result['boxes'] = clean
        result['floor'] = {'z_m': 0, 'basis': 'Explicit simulated ground plane; not inferred from scan'}
    elif kind == 'scan':
        points = document.get('points')
        if not isinstance(points, list) or not 1 <= len(points) <= MAX_MAP_POINTS:
            raise ValueError(f'Scan requires 1–{MAX_MAP_POINTS} finite XYZ points')
        result['points'] = [vector(p, 'scan point', 3) for p in points]
        result['resolution_m'] = finite(document.get('resolution_m', .1), 'resolution', .02, 1)
        xs, ys = [p[0] for p in result['points']], [p[1] for p in result['points']]
        result['capture_time'] = None
        result['note'] = 'Uploaded points only; unobserved space remains unknown. Sensor timing/calibration are unavailable.'
    else:
        raise ValueError('Supported map kinds: boxes, scan (XYZ JSON)')
    bounds = document.get('bounds')
    if bounds is not None:
        if not isinstance(bounds, dict):
            raise ValueError('Bounds must contain min/max XY coordinates')
        lo, hi = vector(bounds.get('min'), 'bounds minimum'), vector(bounds.get('max'), 'bounds maximum')
        if any(b-a < .1 for a, b in zip(lo, hi)):
            raise ValueError('Map bounds must have positive extent')
        if xs and (min(xs) < lo[0] or max(xs) > hi[0] or min(ys) < lo[1] or max(ys) > hi[1]):
            raise ValueError('Map bounds do not contain supplied geometry')
    else:
        lo = [min([-2, *xs])-1, min([-2, *ys])-1]
        hi = [max([4, *xs])+1, max([2, *ys])+1]
    result['bounds'] = {'min': [float(v) for v in lo], 'max': [float(v) for v in hi]}
    result['sha256'] = hashlib.sha256(json.dumps(result, sort_keys=True).encode()).hexdigest()
    return result


def point_status(map_data, point, clearance=.25):
    lo, hi = map_data['bounds']['min'], map_data['bounds']['max']
    if any(x < a or x > b for x, a, b in zip(point, lo, hi)):
        return {'status': 'outside', 'reason': 'Point is outside the selected map bounds'}
    if map_data['kind'] != 'boxes':
        points = map_data.get('points', [])
        near = any(math.hypot(p[0]-point[0], p[1]-point[1]) <= .2 for p in points)
        return {'status': 'observed_surface' if near else 'unknown',
                'reason': 'Nearby returns do not establish traversability or collision-free robot clearance'}
    for box in map_data['boxes']:
        dx, dy = point[0]-box['center_xy'][0], point[1]-box['center_xy'][1]
        c, s = math.cos(box['yaw']), math.sin(box['yaw'])
        local = [c*dx+s*dy, -s*dx+c*dy]
        if box['z_bottom'] < 1.3 and box['z_top'] > 0 and all(abs(v) <= h+clearance for v, h in zip(local, box['half_xy'])):
            return {'status': 'blocked', 'reason': 'Configured obstacle intersects conservative standing footprint/height'}
    return {'status': 'configured_free', 'reason': 'No configured box intersects the standing footprint; path and dynamic feasibility untested'}


def _ms(seconds):
    return seconds * 1000 if isinstance(seconds, (int, float)) and math.isfinite(seconds) else None


def validate_presets(presets, map_data):
    """Named start/goal variants saved with an arena. Each must pass preflight."""
    if presets is None:
        return []
    if not isinstance(presets, list) or len(presets) > MAX_PRESETS:
        raise ValueError(f'Arena presets must be a list of at most {MAX_PRESETS}')
    clean = []
    for index, preset in enumerate(presets):
        if not isinstance(preset, dict):
            raise ValueError('Each preset must be an object')
        item = {'label': label(preset.get('label') or f'Preset {index + 1}'),
                'start_xy': vector(preset.get('start_xy', [0, 0]), 'preset start XY', low=-50, high=50),
                'start_yaw_rad': finite(preset.get('start_yaw_rad', 0), 'preset start yaw', -math.pi, math.pi),
                'goal_xy': vector(preset.get('goal_xy'), 'preset goal XY', low=-50, high=50)}
        for name in ('start_xy', 'goal_xy'):
            status = point_status(map_data, item[name])
            if status['status'] != 'configured_free':
                raise ValueError(f"{item['label']}: {name.split('_')[0]} {status['reason']}")
        if math.dist(item['start_xy'], item['goal_xy']) < .2:
            raise ValueError(f"{item['label']}: start and goal must be at least 0.2 m apart")
        clean.append(item)
    return clean


class Workbench:
    def __init__(self, catalog, data_root=DATA_ROOT, worker_python=None):
        self.catalog = catalog
        self.root = Path(data_root)
        self.worker_python = Path(worker_python or REFERENCE_ROOT / '.venv/bin/python')
        self.token = secrets.token_urlsafe(32)
        self.lock = threading.RLock()
        self.maps = {}
        self.map_warnings = []
        self.scenarios = {}
        self.jobs = {}
        self.suites = {}
        self._run_rows = {}
        self.root.mkdir(parents=True, exist_ok=True)
        for name in ['maps', 'scenarios', 'jobs', 'suites']:
            (self.root / name).mkdir(exist_ok=True)
        flat = validate_map({'label': 'Flat ground · simulation', 'kind': 'boxes', 'boxes': [], 'bounds': {'min': [-5,-5], 'max': [5,5]}})
        self.maps['flat-ground'] = dict(flat, id='flat-ground', provenance={'source': 'Explicit Studio simulation ground plane'})
        try:
            for scene in development_maps(REFERENCE_ROOT):
                self.maps[scene['id']] = scene
        except (ValueError, OSError, KeyError, TypeError, subprocess.SubprocessError) as error:
            # Optional scene sources cannot disable replay. No approximate
            # replacement geometry is substituted for a failed source adapter.
            self.map_warnings.append(f'Flow development scenes unavailable: {type(error).__name__}')
        source = REFERENCE_ROOT / 'runs/rt/replay-beams2-101/boxes.json'
        if source.exists():
            boxes = read_json(source)
            if isinstance(boxes, dict):
                boxes = boxes.get('boxes', [])
            beam = validate_map({'label': 'Recorded beam scene · simulation geometry', 'kind': 'boxes', 'boxes': boxes})
            self.maps['beam-scene'] = dict(beam, id='beam-scene', provenance={'path': str(source), 'sha256': hashlib.sha256(source.read_bytes()).hexdigest()})
        try:
            recorded, _ = self.catalog.session('sonic-dds-tutorial')
            perception = recorded.get('perception', {})
            points = (perception.get('support_points', []) + perception.get('ceiling_points', []))[:6000]
            if perception.get('available') and points:
                observed = validate_map({'label': 'Recorded DDS observed map · final snapshot',
                                         'kind': 'scan', 'points': points,
                                         'resolution_m': perception.get('resolution_m', .05)})
                self.maps['dds-observed-map'] = dict(observed, id='dds-observed-map', classification='estimated',
                    capture_time=None, runnable=False,
                    note='Actual final accumulated DDS rehearsal map. Capture time and synchronized history unavailable.',
                    provenance={'session_id': 'sonic-dds-tutorial', 'source': perception.get('source'),
                                'session_artifacts': recorded.get('metadata', {}).get('provenance', {}).get('artifacts', [])})
        except (KeyError, ValueError, OSError, ImportError):
            # Optional historic assets must not prevent the preparation tool starting.
            pass
        for path in sorted((self.root/'maps').glob('map-*.json'))[:32]:
            try:
                data = read_json(path, 4*1024*1024)
                self.maps[path.stem] = dict(validate_map(data), id=path.stem, provenance=data.get('provenance'))
            except (ValueError, OSError):
                continue
        for path in sorted((self.root/'maps').glob('arena-*.json'))[:MAX_ARENAS]:
            try:
                data = read_json(path, 4*1024*1024)
                arena = dict(validate_map(data), id=path.stem, provenance=data.get('provenance'),
                             description=data.get('description'), origin='arena-editor')
                arena['presets'] = validate_presets(data.get('presets'), arena)
                self.maps[path.stem] = arena
            except (ValueError, OSError, TypeError):
                self.map_warnings.append(f'Saved arena {path.stem} failed validation and is hidden')
        for path in sorted((self.root/'scenarios').glob('scenario-*.json'))[:100]:
            try:
                data = read_json(path, 16384)
                self.scenarios[path.stem] = data
            except (ValueError, OSError):
                continue
        self._reload_jobs()
        self._reload_suites()

    def _lease_held(self):
        """Probe kernel state, never infer ownership from a saved PID or timestamp."""
        fd = os.open(self.root / '.worker.lock', os.O_RDWR | os.O_CREAT, 0o600)
        try:
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                return False
            except BlockingIOError:
                return True
        finally:
            os.close(fd)

    def _acquire_lease(self):
        fd = os.open(self.root / '.worker.lock', os.O_RDWR | os.O_CREAT, 0o600)
        try:
            fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            os.close(fd)
            raise ValueError('A simulation worker already holds this data root; wait for it to finish') from None
        except BaseException:
            os.close(fd)
            raise
        return fd

    @staticmethod
    def _close_lease(job):
        fd = job.pop('_lease_fd', None)
        if fd is not None:
            # Do not LOCK_UN: parent/child share the open-file description. Closing
            # the parent fd must leave a surviving worker's inherited lock intact.
            os.close(fd)

    def _persist_job(self, job):
        atomic_json(job['output']/'job.json', {k: job[k] for k in HISTORY_FIELDS if k in job})

    @staticmethod
    def _optional_json(path, limit):
        try:
            data = read_json(path, limit)
            return data if isinstance(data, dict) else None
        except (ValueError, OSError):
            return None

    def _reconcile_recovered(self, job):
        """Read completion receipts only. An old PID never grants signal ownership."""
        output = job['output']
        result = self._optional_json(output/'run/result.json', 1024*1024)
        if result and result.get('status') == 'completed' and (output/'run/session.json').is_file():
            job.update(status='completed', result_session_id=job['id'], error=None)
        elif result and result.get('status') == 'failed':
            job.update(status='failed', error=str(result.get('error', 'Recorded worker failure'))[:2000])
            if (output/'run/session.json').is_file():
                job['result_session_id'] = job['id']
        elif not self._lease_held():
            job.update(status='failed', error='Gateway ownership was interrupted; no worker lock or successful completion receipt remains.')
        else:
            job.update(status='detached', error='Another or surviving worker holds the data root. This gateway can inspect files but does not own its process.')
        job['ownership'] = 'read-only recovered record; no process signals authorized'
        if job['status'] in TERMINAL_STATES and not self._lease_held():
            job.setdefault('finished_unix_s', time.time())
            self._persist_job(job)

    def _reload_jobs(self):
        for output in sorted((self.root/'jobs').glob('job-*'))[-MAX_JOBS:]:
            if not output.is_dir():
                continue
            saved = self._optional_json(output/'job.json', 1024*1024) or {}
            job = {k: saved[k] for k in HISTORY_FIELDS if k in saved}
            job.update(id=output.name, output=output, process=None, latest=None, recovered=True,
                       ownership='read-only recovered record; no process signals authorized')
            job.setdefault('error', None)
            job.setdefault('result_session_id', None)
            if job.get('status') not in TERMINAL_STATES:
                self._reconcile_recovered(job)
            elif job['status'] == 'completed' and not (output/'run/session.json').is_file():
                job.update(status='failed', result_session_id=None, error='Saved completion recording is unavailable')
            self.jobs[output.name] = job
            if (output/'run/session.json').is_file() and job['status'] in ('completed', 'failed'):
                job['result_session_id'] = output.name
                self._register_result(job)

    def _register_result(self, job):
        summary = self._optional_json(job['output']/'run/result.json', 1024*1024) or {}
        scenario = job.get('scenario', {})
        self.catalog.register(job['id'], job['output']/'run/session.json',
                              f"{scenario.get('label', 'saved CPU simulation')}",
                              extra={'group': 'CPU rehearsals', 'status': job['status'],
                                     'outcome': (summary.get('report') or {}).get('outcome') or ('runtime_error' if job['status'] == 'failed' else None),
                                     'policy_id': job.get('policy_id') or scenario.get('policy_id') or DEFAULT_POLICY_ID,
                                     'started_unix_s': job.get('started_unix_s'), 'map_id': scenario.get('map_id'),
                                     'scenario_label': scenario.get('label'), 'suite_id': job.get('suite_id')})

    def capabilities(self):
        from studio.policy_worker import capabilities
        source = capabilities()
        return {'id': 'flow-sonic-cpu', 'label': 'Flow + SONIC · CPU MuJoCo (in-process)',
                'available': source['available'], 'missing': source.get('missing', []),
                'reason': 'Fresh frozen Flow planner + SONIC ONNX + MuJoCo. No DDS/ZMQ execution parity.',
                'hardware_enabled': False, 'dds_participants': 0, 'device': 'cpu',
                'limits': {'duration_s': [1,10], 'candidates': [1,16], 'ode_steps': [1,10]}}

    def policy_catalog(self):
        from studio import policies
        return policies.catalog()

    def description(self):
        maps = [{k:v for k,v in m.items() if k not in ('boxes','points')} for m in self.maps.values()]
        from studio import policies
        catalog = policies.catalog()
        return {'schema_version': 1, 'csrf_token': self.token, 'maps': maps, 'map_warnings': self.map_warnings,
                'backends': [self.capabilities()], 'policies': catalog['policies'],
                'flow_research': catalog['flow_research'],
                'criteria': self._criteria(),
                'limits': {'arenas': MAX_ARENAS, 'presets': MAX_PRESETS, 'boxes': MAX_BOXES,
                           'suite_runs': MAX_SUITE_RUNS, 'jobs': MAX_JOBS},
                'defaults': {'map_id': 'flat-ground', 'backend_id': 'flow-sonic-cpu',
                'policy_id': catalog['default_policy_id'],
                'duration_s': 2, 'start_xy': [0,0], 'goal_xy': [1,0], 'start_yaw_rad': 0, 'seed': 0,
                'planner': {'candidates': 2, 'ode_steps': 4}},
                'boundaries': ['Simulation jobs only; hardware disabled', 'One owned CPU job at a time',
                               'Quick test uses 2 candidates / 4 ODE steps; deployed bundle uses 16 / 10',
                               'Scans require collision geometry before physics testing']}

    def map(self, key):
        with self.lock:
            if key not in self.maps:
                raise KeyError('Unknown map')
            return copy.deepcopy(self.maps[key])

    def import_map(self, document):
        if not isinstance(document, dict) or document.get('frame_id') != 'world':
            raise ValueError('Imported maps must explicitly declare frame_id: world after alignment')
        data = validate_map(document)
        with self.lock:
            if sum(key.startswith('map-') for key in self.maps) >= 32:
                raise ValueError('Map catalog limit reached (32 imports)')
            key = 'map-' + uuid.uuid4().hex[:12]
            data.update(id=key, provenance={'source': 'User-uploaded geometry/points', 'imported_unix_s': time.time()})
            atomic_json(self.root/'maps'/f'{key}.json', data)
            self.maps[key] = data
            return copy.deepcopy(data)

    def prepare(self, request):
        if not isinstance(request, dict):
            raise ValueError('Scenario must be an object')
        if request.get('backend_id') != 'flow-sonic-cpu':
            raise ValueError('Only the isolated CPU simulation backend is enabled')
        from studio import policies
        policy_id = request.get('policy_id', DEFAULT_POLICY_ID)
        if not isinstance(policy_id, str):
            raise ValueError('policy_id must be a string')
        profile = policies.get_profile(policy_id)
        map_data = self.map(request.get('map_id'))
        planner = request.get('planner', {})
        if not isinstance(planner, dict):
            raise ValueError('Planner settings must be an object')
        limits = profile.get('limits', {})
        max_k = limits.get('candidates', [1, 16])[1]
        max_ode = limits.get('ode_steps', [1, 10])[1]
        scenario = {'schema_version': 1, 'label': label(request.get('label', 'Flow CPU rehearsal')),
                    'map_id': map_data['id'], 'map_sha256': map_data['sha256'], 'frame_id': 'world',
                    'backend_id': 'flow-sonic-cpu', 'duration_s': finite(request.get('duration_s', 2), 'duration', 1, 10),
                    'start_xy': vector(request.get('start_xy', [0,0]), 'start XY', low=-50, high=50),
                    'goal_xy': vector(request.get('goal_xy'), 'goal XY', low=-50, high=50),
                    'start_yaw_rad': finite(request.get('start_yaw_rad', 0), 'start yaw', -math.pi, math.pi),
                    'seed': integer(request.get('seed', 0), 'seed', 0, 2147483647),
                    'policy_id': profile['id'],
                    'criterion': self._criterion(request.get('criterion', 'arrive_hold')),
                    'planner': {'candidates': integer(planner.get('candidates', 2), 'candidates', 1, max_k),
                                'ode_steps': integer(planner.get('ode_steps', 4), 'ODE steps', 1, max_ode)}}
        goal, start = point_status(map_data, scenario['goal_xy']), point_status(map_data, scenario['start_xy'])
        issues = []
        if not map_data['runnable']:
            issues.append(map_data['reason'])
        for name, status in [('Goal', goal), ('Start', start)]:
            if status['status'] != 'configured_free':
                issues.append(f"{name}: {status['reason']}")
        if math.dist(scenario['start_xy'], scenario['goal_xy']) < .2:
            issues.append('Start and goal must be at least 0.2 m apart')
        warnings = ['Goal clearance is a geometric preflight, not a prediction of navigation success.',
                    'CPU wall time and simulation time differ; realtime factor is measured during execution.',
                    'The source Flow selector treats unseen cells as free. Studio keeps those cells visually unknown; this is not a hardware-safe navigation guarantee.']
        deployed = profile.get('planner', {}).get('deployed_budget')
        if deployed and scenario['planner'] != deployed:
            warnings.append(f"Planner settings differ from deployed budget of this policy profile ({deployed['candidates']} candidates / {deployed['ode_steps']} ODE steps).")
        warnings.extend(profile.get('limitations', []))
        scenario['validation'] = {'valid': not issues, 'issues': issues, 'warnings': warnings, 'goal': goal, 'start': start}
        return scenario

    @staticmethod
    def _criteria():
        from studio.policy_worker import CRITERIA
        return [{'id': k, **v} for k, v in CRITERIA.items()]

    @staticmethod
    def _criterion(value):
        from studio.policy_worker import CRITERIA
        if value not in CRITERIA:
            raise ValueError(f'Success criterion must be one of {sorted(CRITERIA)}')
        return value

    def save_scenario(self, request):
        scenario = self.prepare(request)
        with self.lock:
            if len(self.scenarios) >= 100:
                raise ValueError('Scenario storage limit reached (100)')
            scenario['id'] = 'scenario-' + uuid.uuid4().hex[:12]
            atomic_json(self.root/'scenarios'/f"{scenario['id']}.json", scenario)
            self.scenarios[scenario['id']] = scenario
        return {'scenario': scenario, 'validation': scenario['validation']}

    def start_job(self, scenario_id, suite_id=None):
        from studio import policies
        with self.lock:
            if scenario_id not in self.scenarios:
                raise KeyError('Unknown saved scenario')
            scenario = self.prepare(self.scenarios[scenario_id])
            if not scenario['validation']['valid']:
                raise ValueError('; '.join(scenario['validation']['issues']))
            if not self.capabilities()['available']:
                raise ValueError('CPU reference interpreter or SONIC model unavailable')
            profile = policies.get_profile(scenario['policy_id'])
            policy_identity = policies.identity(profile)
            if not policy_identity['available'] or not profile.get('available', True):
                raise ValueError('Policy profile artifacts unavailable: ' + '; '.join(policy_identity['missing'])[:500])
            if any(j['status'] in ACTIVE_STATES for j in self.jobs.values()):
                raise ValueError('A simulation job is already active')
            lease_fd = self._acquire_lease()
            key = 'job-' + uuid.uuid4().hex[:12]
            output = self.root/'jobs'/key
            job = {'id': key, 'status': 'starting', 'scenario_id': scenario_id, 'scenario': scenario,
                   'started_unix_s': time.time(), 'output': output, 'process': None, 'latest': None,
                   'error': None, 'result_session_id': None, '_lease_fd': lease_fd,
                   'ownership': 'owned child process', 'suite_id': suite_id,
                   'policy_id': profile['id'], 'policy_identity': policy_identity,
                   'wall_limit_s': float(profile.get('limits', {}).get('wall_s', 180))}
            try:
                if len(list((self.root/'jobs').glob('job-*'))) >= MAX_JOBS:
                    raise ValueError('Job storage limit reached; archive owned runs before starting more')
                output.mkdir()
                os.ftruncate(lease_fd, 0)
                os.write(lease_fd, key.encode())
                self.jobs[key] = job
                self._persist_job(job)
                request = {k:v for k,v in scenario.items() if k not in ('validation','label','backend_id','map_id','map_sha256','frame_id','policy_id')}
                request.update(id=key, map=self.map(scenario['map_id']),
                               policy={'id': profile['id'], 'loader': profile.get('loader'),
                                       'identity_sha256': policy_identity['identity_sha256'],
                                       **({'bundle_id': profile['bundle_id']} if profile.get('bundle_id') else {})})
                script = 'flow_policy_worker.py' if profile.get('loader') == 'flow-callback' else 'policy_worker.py'
                atomic_json(output/'request.json', request)
                env = dict(os.environ, PYTHONDONTWRITEBYTECODE='1', CUDA_VISIBLE_DEVICES='',
                           OMP_NUM_THREADS='2', MKL_NUM_THREADS='2', OPENBLAS_NUM_THREADS='2',
                           NUMEXPR_NUM_THREADS='2', PYTHONPATH=str(ROOT))
                with (output/'worker.log').open('wb') as log:
                    process = subprocess.Popen([str(self.worker_python), '-u', str(ROOT/'studio'/script),
                                                '--request', str(output/'request.json'), '--output', str(output/'run')],
                                               cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT,
                                               start_new_session=True, pass_fds=(lease_fd,))
                job['process'] = process
                self.catalog.register(key, output/'run/session.json', f"LIVE · {scenario['label']}", provider=lambda: self.session_data(key),
                                      extra={'group': 'CPU rehearsals', 'status': 'running', 'policy_id': profile['id'],
                                             'started_unix_s': job['started_unix_s'], 'map_id': scenario['map_id'],
                                             'scenario_label': scenario['label'], 'suite_id': suite_id})
                threading.Thread(target=self._monitor, args=(key,), daemon=True).start()
            except BaseException as exc:
                if job['process'] is not None:
                    self._terminate(job['process'])
                    job['process'].wait()
                job.update(status='failed', error=f'Worker launch failed: {type(exc).__name__}: {exc}',
                           finished_unix_s=time.time())
                try:
                    if output.is_dir():
                        self._persist_job(job)
                finally:
                    self._close_lease(job)
                raise
            return self.job(key)

    def _monitor(self, key):
        job = self.jobs[key]
        process, output = job['process'], job['output']/'run'
        started = time.monotonic()
        try:
            while process.poll() is None:
                latest = self._optional_json(output/'latest.json', 16*1024*1024)
                if latest is not None:
                    with self.lock:
                        job['latest'] = latest
                        if job['status'] == 'starting':
                            job['status'] = 'running'
                try:
                    size = sum(p.stat().st_size for p in job['output'].rglob('*') if p.is_file())
                except OSError:
                    size = 0  # concurrent atomic file replacement; retry next poll
                limit = job.get('wall_limit_s', 180)
                if time.monotonic()-started > limit or size > MAX_OUTPUT_BYTES:
                    job['error'] = f'Owned simulation exceeded {limit:.0f} s wall-time / 256 MiB output limit'
                    self._terminate(process)
                    break
                time.sleep(.2)
            process.wait()
            with self.lock:
                job['exit_code'] = process.returncode
                job['finished_unix_s'] = time.time()
                receipt = self._optional_json(output/'result.json', 1024*1024)
                if job['status'] == 'cancelling':
                    job['status'] = 'cancelled'
                elif process.returncode == 0 and (output/'session.json').is_file() and receipt and receipt.get('status') == 'completed':
                    job['status'] = 'completed'
                    job['result_session_id'] = key
                else:
                    job['status'] = 'failed'
                    job['error'] = job['error'] or (receipt or {}).get('error') or f'Worker exited with code {process.returncode}; inspect log for details'
                    if (output/'session.json').is_file() and receipt and receipt.get('status') == 'failed':
                        job['result_session_id'] = key
                job['latest'] = self._optional_json(output/'latest.json', 16*1024*1024) or job['latest']
                self._persist_job(job)
        except BaseException as exc:
            # Unexpected monitoring errors cannot abandon an owned runaway child.
            self._terminate(process)
            process.wait()
            with self.lock:
                job.update(status='failed', error=f'Owned job monitoring failed: {type(exc).__name__}: {exc}',
                           finished_unix_s=time.time(), exit_code=process.returncode)
                try:
                    self._persist_job(job)
                except OSError:
                    pass
        finally:
            # The child retains an inherited lease if the gateway itself dies.
            # In normal execution close the parent descriptor only after child exit.
            if process.poll() is None:
                self._terminate(process)
                process.wait()
            self._close_lease(job)
            if (output/'session.json').is_file() and job['status'] in ('completed', 'failed'):
                # Freeze the completed file outside the job lock. A replay must
                # not reread/re-encode its full recording on every sensor poll.
                self._register_result(job)
            elif key in self.catalog.providers:
                # No replayable recording: stop advertising a live provider.
                self.catalog.register(key, output/'session.json', f"{job.get('scenario', {}).get('label', 'CPU run')} · no recording",
                                      extra={'group': 'CPU rehearsals', 'status': job['status']})

    @staticmethod
    def _terminate(process):
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                return
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass

    def cancel_job(self, key):
        with self.lock:
            if key not in self.jobs:
                raise KeyError('Unknown owned job')
            job = self.jobs[key]
            if job['status'] not in ('starting','running') or job.get('process') is None or job.get('recovered'):
                raise ValueError('Job is no longer an active process owned by this gateway')
            job['status'] = 'cancelling'
            self._persist_job(job)
            self._terminate(job['process'])
            return self.job(key)

    @staticmethod
    def _light_latest(latest, perception_after):
        """Live-view payload: frame + progress always, perception only when newer."""
        if not latest:
            return latest
        light = {k: v for k, v in latest.items() if k not in ('perception', 'metadata', 'graph', 'environment', 'joint_names')}
        perception = latest.get('perception')
        if perception and isinstance(perception.get('time'), (int, float)) and (
                perception_after is None or perception['time'] > perception_after):
            light['perception'] = {k: v for k, v in perception.items()
                                   if k not in ('support_observed_indices', 'ceiling_observed_indices', 'observed_points')}
        light['light'] = True
        return light

    def job(self, key, *, compact=False, light=False, perception_after=None):
        with self.lock:
            if key not in self.jobs:
                raise KeyError('Unknown owned job')
            job = self.jobs[key]
            if job.get('recovered') and job['status'] == 'detached':
                self._reconcile_recovered(job)
            result = {k:job[k] for k in HISTORY_FIELDS if k in job}
            result['output_path'] = str(job['output'])
            summary = self._optional_json(job['output']/'run/result.json', 1024*1024)
            if summary is not None:
                result['summary'] = summary
            if compact:
                # Result summaries are bounded on disk; only outcome/duration in lists.
                if summary is not None:
                    report = summary.get('report', {})
                    result['summary'] = {'status': summary.get('status'), 'wall_time_s': summary.get('wall_time_s'),
                                         'outcome': report.get('outcome'), 'elapsed_s': report.get('elapsed_s')}
                return copy.deepcopy(result)
            if job.get('recovered'):
                job['latest'] = self._optional_json(job['output']/'run/latest.json', 16*1024*1024)
            result['latest'] = self._light_latest(job.get('latest'), perception_after) if light else job.get('latest')
            frame = (result['latest'] or {}).get('frame') or {}
            receipt = frame.get('receipt_time')
            age = None
            if job.get('process') is not None and frame.get('receipt_clock_domain') == 'host-monotonic' and isinstance(receipt, (int,float)) and math.isfinite(receipt):
                delta = time.monotonic()-receipt
                age = delta if delta >= 0 else None
            active = job['status'] in ACTIVE_STATES
            result['telemetry'] = {'receipt_age_s': age if active else None,
                'status': ('stale' if age > 1 else 'fresh') if active and age is not None else ('unavailable' if active else 'recorded'),
                'stale_after_s': 1, 'clock_domain': 'host-monotonic',
                'note': 'Age applies to live owned worker receipt; historical/recovered monotonic clocks are not compared.'}
            process = job.get('process')
            result['runtime'] = {'worker_pid': process.pid if process is not None else None,
                                 'worker_alive': process.poll() is None if process is not None else None,
                                 'host': 'local', 'basis': 'owned subprocess observation' if process is not None else 'persisted record; process ownership unavailable',
                                 'telemetry_age_ms': age*1000 if active and age is not None else None,
                                 'telemetry_status': result['telemetry']['status'],
                                 'dds_participants': 0, 'hardware_enabled': False}
            log = job['output']/'worker.log'
            try:
                with log.open('rb') as f:
                    f.seek(max(0, log.stat().st_size-6000))
                    result['log_tail'] = f.read(6000).decode(errors='replace')
            except OSError:
                pass
            return copy.deepcopy(result)

    def list_jobs(self):
        return {'jobs': [self.job(key, compact=True) for key in reversed(list(self.jobs))]}

    def session_data(self, key):
        job = self.jobs[key]
        final = job['output']/'run/session.json'
        if final.exists() and job['status'] in ('completed', 'failed'):
            return read_json(final)
        latest = job['latest']
        if not latest or not latest.get('frame') or not latest.get('metadata'):
            raise ValueError('Simulation is initializing; state and model are not available yet')
        metadata = dict(latest['metadata'], catalog_id=key, duration_s=max(.02, latest['frame']['time']), incomplete=True)
        from studio.replay import JOINT_NAMES
        return {'schema_version': 1, 'metadata': metadata, 'joint_names': list(JOINT_NAMES),
                'frames': [latest['frame']], 'events': latest.get('events', []),
                'pipeline': latest.get('pipeline', {'schema_version': 1, 'flow_samples': [], 'sonic_samples': []}),
                'perception': latest.get('perception') or {'available': False, 'reason': 'No perception sample published yet'},
                'environment': latest.get('environment', {'boxes': []}),
                'graph': latest.get('graph', {'nodes': [], 'edges': []})}

    # ----- Arenas: operator-edited collision layouts with named start/goal presets.
    def save_arena(self, document):
        """Save an edited box arena as a new immutable map (never overwrites)."""
        if not isinstance(document, dict):
            raise ValueError('Arena must be a JSON object')
        if document.get('kind', 'boxes') != 'boxes':
            raise ValueError('Arenas are explicit box collision geometry')
        base = document.get('base_map_id')
        if base is not None and base not in self.maps:
            raise ValueError('Unknown base map for arena')
        data = validate_map({'label': document.get('label'), 'kind': 'boxes', 'frame_id': 'world',
                             'units': 'm', 'boxes': document.get('boxes', []),
                             **({'bounds': document['bounds']} if document.get('bounds') is not None else {})})
        presets = validate_presets(document.get('presets'), data)
        description = document.get('description')
        if description is not None and (not isinstance(description, str) or len(description) > 500):
            raise ValueError('Arena description must be at most 500 characters')
        with self.lock:
            if sum(key.startswith('arena-') for key in self.maps) >= MAX_ARENAS:
                raise ValueError(f'Arena limit reached ({MAX_ARENAS}); archive saved arenas first')
            key = 'arena-' + uuid.uuid4().hex[:12]
            data.update(id=key, presets=presets, description=description, origin='arena-editor',
                        provenance={'source': 'Studio arena editor', 'created_unix_s': time.time(),
                                    'base_map_id': base,
                                    'base_map_sha256': self.maps[base]['sha256'] if base else None})
            atomic_json(self.root/'maps'/f'{key}.json', data)
            self.maps[key] = data
            return copy.deepcopy(data)

    # ----- Suites: bounded sequential rehearsals through the single owned worker.
    def _persist_suite(self, suite):
        atomic_json(self.root/'suites'/f"{suite['id']}.json", suite)

    def _reload_suites(self):
        for path in sorted((self.root/'suites').glob('suite-*.json'))[-MAX_SUITES:]:
            suite = self._optional_json(path, 1024*1024)
            if not suite:
                continue
            if suite.get('status') in SUITE_ACTIVE:
                # A gateway restart ends ownership of queued launches.
                suite['status'] = 'interrupted'
                for run in suite.get('runs', []):
                    if run.get('status') in ('queued', 'running', 'starting'):
                        job = self.jobs.get(run.get('job_id'))
                        run['status'] = job['status'] if job else 'not_started'
                self._persist_suite(suite)
            self.suites[suite['id']] = suite

    def start_suite(self, document):
        if not isinstance(document, dict):
            raise ValueError('Suite must be an object')
        ids = document.get('scenario_ids')
        if not isinstance(ids, list) or not 1 <= len(ids) <= MAX_SUITE_RUNS:
            raise ValueError(f'A suite needs 1–{MAX_SUITE_RUNS} saved scenario IDs')
        with self.lock:
            for scenario_id in ids:
                if scenario_id not in self.scenarios:
                    raise KeyError('Unknown saved scenario')
                checked = self.prepare(self.scenarios[scenario_id])
                if not checked['validation']['valid']:
                    raise ValueError(f"{checked['label']}: " + '; '.join(checked['validation']['issues']))
            if any(s['status'] in SUITE_ACTIVE for s in self.suites.values()):
                raise ValueError('A scenario suite is already running')
            if any(j['status'] in ACTIVE_STATES for j in self.jobs.values()):
                raise ValueError('A simulation job is already active')
            if len(list((self.root/'jobs').glob('job-*'))) + len(ids) > MAX_JOBS:
                raise ValueError('Job storage limit would be exceeded; archive owned runs first')
            if len(self.suites) >= MAX_SUITES:
                raise ValueError(f'Suite history limit reached ({MAX_SUITES})')
            suite = {'schema_version': 1, 'id': 'suite-' + uuid.uuid4().hex[:12],
                     'label': label(document.get('label', 'Scenario suite')), 'status': 'queued',
                     'created_unix_s': time.time(), 'finished_unix_s': None,
                     'runs': [{'scenario_id': sid, 'label': self.scenarios[sid].get('label'),
                               'job_id': None, 'status': 'queued', 'outcome': None} for sid in ids],
                     'note': 'Runs execute one at a time in the owned CPU worker; each run is an independent bounded simulation.'}
            self.suites[suite['id']] = suite
            self._persist_suite(suite)
        threading.Thread(target=self._run_suite, args=(suite['id'],), daemon=True).start()
        return copy.deepcopy(suite)

    def _wait_idle(self, timeout_s):
        deadline = time.monotonic() + timeout_s
        while time.monotonic() < deadline:
            with self.lock:
                busy = any(j['status'] in ACTIVE_STATES or '_lease_fd' in j for j in self.jobs.values())
            if not busy:
                return True
            time.sleep(.25)
        return False

    def _run_suite(self, key):
        suite = self.suites[key]
        with self.lock:
            suite['status'] = 'running'
            self._persist_suite(suite)
        for run in suite['runs']:
            with self.lock:
                if suite['status'] == 'cancelling':
                    run['status'] = 'skipped'
                    continue
            if not self._wait_idle(240):
                with self.lock:
                    run.update(status='launch_failed', error='Another simulation stayed active; suite run not started')
                    self._persist_suite(suite)
                continue
            try:
                job = self.start_job(run['scenario_id'], suite_id=key)
            except (ValueError, KeyError, OSError) as error:
                with self.lock:
                    run.update(status='launch_failed', error=str(error)[:500])
                    self._persist_suite(suite)
                continue
            with self.lock:
                run.update(job_id=job['id'], status='running')
                self._persist_suite(suite)
            while True:
                with self.lock:
                    record = self.jobs[job['id']]
                    done = record['status'] in TERMINAL_STATES and '_lease_fd' not in record
                    if suite['status'] == 'cancelling' and record['status'] in ('starting', 'running') and record.get('process'):
                        record['status'] = 'cancelling'
                        self._persist_job(record)
                        self._terminate(record['process'])
                if done:
                    break
                time.sleep(.3)
            summary = self._optional_json(record['output']/'run/result.json', 1024*1024) or {}
            with self.lock:
                run.update(status=record['status'],
                           outcome=(summary.get('report') or {}).get('outcome') or (
                               'runtime_error' if record['status'] == 'failed' else None),
                           error=record.get('error'))
                self._persist_suite(suite)
        with self.lock:
            suite['status'] = 'cancelled' if suite['status'] == 'cancelling' else 'completed'
            suite['finished_unix_s'] = time.time()
            self._persist_suite(suite)

    def cancel_suite(self, key):
        with self.lock:
            if key not in self.suites:
                raise KeyError('Unknown suite')
            suite = self.suites[key]
            if suite['status'] not in ('queued', 'running'):
                raise ValueError('Suite is not running')
            suite['status'] = 'cancelling'
            self._persist_suite(suite)
            return copy.deepcopy(suite)

    def suite(self, key):
        with self.lock:
            if key not in self.suites:
                raise KeyError('Unknown suite')
            return copy.deepcopy(self.suites[key])

    def list_suites(self):
        with self.lock:
            return {'suites': [copy.deepcopy(s) for s in sorted(self.suites.values(),
                                                                key=lambda s: s.get('created_unix_s', 0), reverse=True)]}

    # ----- Runs table: compact, comparable outcomes for every owned job.
    def _trajectory(self, job, budget=160):
        path = job['output']/'run/progress.jsonl'
        points = []
        try:
            if path.stat().st_size > 32*1024*1024:
                return None
            with path.open() as handle:
                for line in handle:
                    try:
                        row = json.loads(line)
                        q = row['qpos']
                        points.append([round(float(row['time']), 3), round(float(q[0]), 3), round(float(q[1]), 3)])
                    except (ValueError, KeyError, TypeError, IndexError):
                        continue
        except OSError:
            return None
        if not points:
            return None
        step = max(1, math.ceil(len(points)/budget))
        sampled = points[::step]
        if sampled[-1] is not points[-1]:
            sampled.append(points[-1])
        return sampled

    def run_row(self, key):
        with self.lock:
            job = self.jobs[key]
            terminal = job['status'] in TERMINAL_STATES
            cached = self._run_rows.get(key)
            if terminal and cached and cached['status'] == job['status']:
                return cached
            snapshot = {k: job.get(k) for k in HISTORY_FIELDS}
            output = job['output']
        summary = self._optional_json(output/'run/result.json', 1024*1024) or {}
        report = summary.get('report') or {}
        scenario = snapshot.get('scenario') or {}
        row = {'id': key, 'status': snapshot['status'], 'started_unix_s': snapshot.get('started_unix_s'),
               'finished_unix_s': snapshot.get('finished_unix_s'), 'suite_id': snapshot.get('suite_id'),
               'policy_id': snapshot.get('policy_id') or scenario.get('policy_id') or DEFAULT_POLICY_ID,
               'policy_identity_sha256': (snapshot.get('policy_identity') or {}).get('identity_sha256'),
               'scenario_id': snapshot.get('scenario_id'), 'label': scenario.get('label'),
               'map_id': scenario.get('map_id'), 'map_sha256': scenario.get('map_sha256'),
               'start_xy': scenario.get('start_xy'), 'start_yaw_rad': scenario.get('start_yaw_rad'),
               'goal_xy': scenario.get('goal_xy'), 'duration_s': scenario.get('duration_s'),
               'seed': scenario.get('seed'), 'planner': scenario.get('planner'),
               'replayable': snapshot.get('result_session_id') == key,
               'outcome': report.get('outcome') or ('runtime_error' if snapshot['status'] == 'failed' and snapshot.get('result_session_id') else None),
               'error': snapshot.get('error'),
               'metrics': {'elapsed_s': report.get('elapsed_s'),
                           'final_goal_distance_m': report.get('final_goal_distance_xy_m'),
                           'minimum_goal_distance_m': report.get('minimum_goal_distance_xy_m'),
                           'max_contact_n': report.get('maximum_obstacle_contact_n'),
                           'max_tilt_rad': report.get('maximum_root_tilt_rad'),
                           'min_root_height_m': report.get('minimum_root_height_m'),
                           'planner_p50_ms': _ms((report.get('plan_latency_s') or {}).get('p50')),
                           'planner_p95_ms': _ms((report.get('plan_latency_s') or {}).get('p95')),
                           'sonic_p95_ms': (report.get('sonic_inference_ms') or {}).get('p95'),
                           'replans': report.get('replans'), 'wall_time_s': summary.get('wall_time_s'),
                           'selection_rules': report.get('selection_rules')},
               'trajectory': self._trajectory({'output': output}),
               'trajectory_basis': 'Decimated simulator-ground-truth root XY from progress.jsonl (time, x, y)',
               'clock_domain': 'simulation'}
        if terminal:
            with self.lock:
                self._run_rows[key] = row
        return row

    def runs_table(self):
        with self.lock:
            keys = list(reversed(list(self.jobs)))
        rows = []
        for key in keys:
            try:
                rows.append(self.run_row(key))
            except (KeyError, OSError, ValueError):
                continue
        return {'schema_version': 1, 'runs': rows,
                'note': 'CPU lockstep rehearsal outcomes. Physics pauses while planning; these are not real-time or hardware results.'}
