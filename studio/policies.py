"""Explicit policy profiles for owned simulation rehearsals.

A profile names *what* is deployed (planner + tracker identity, pinned revision,
config and checkpoint hashes) separately from *where* it runs (the CPU lockstep
worker). The HTTP gateway never imports a policy runtime: this module reads
files and Git metadata only. Reference repositories are consumed read-only.

Flow research status is read from ``research/BEST_MODEL.md`` so the UI can show
whether a deployable profile matches the block the research side has adopted.
Only the adoption heading is parsed; evaluation outputs are never read here.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re
import subprocess
import threading
import time

DEPLOY_ROOT = Path('/home/linjiw/code/g1-student-deploy')
FLOW_ROOT = Path('/home/linjiw/flow')
BEST_MODEL = FLOW_ROOT / 'research/BEST_MODEL.md'
DEFAULT_POLICY = 'flow-bundle-20261008'

_hash_cache: dict = {}
_hash_lock = threading.Lock()


def file_identity(path):
    """SHA-256 of a file, cached by (size, mtime) so repeated catalog reads are cheap."""
    path = Path(path)
    try:
        stat = path.stat()
    except OSError:
        return {'path': str(path), 'available': False, 'sha256': None, 'bytes': None}
    key = (str(path), stat.st_size, stat.st_mtime_ns)
    with _hash_lock:
        if key in _hash_cache:
            return dict(_hash_cache[key])
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1 << 20), b''):
            digest.update(chunk)
    result = {'path': str(path), 'available': True, 'sha256': digest.hexdigest(), 'bytes': stat.st_size}
    with _hash_lock:
        _hash_cache[key] = result
    return dict(result)


_git_cache: dict = {}


def git_identity(root, max_age_s=5.0):
    """HEAD/branch/dirty of a reference checkout; unknown (None) when Git is unavailable."""
    now = time.monotonic()
    with _hash_lock:
        hit = _git_cache.get(str(root))
        if hit and now - hit[0] < max_age_s:
            return dict(hit[1])

    def git(*args):
        try:
            return subprocess.run(['git', '-C', str(root), *args], capture_output=True, text=True,
                                  timeout=3, check=True).stdout.strip()
        except Exception:  # missing git, timeout, or a test double: record unknown, never guess
            return None
    status = git('status', '--porcelain', '--untracked-files=no')
    result = {'path': str(root), 'head': git('rev-parse', 'HEAD'), 'branch': git('branch', '--show-current'),
              'dirty': None if status is None else bool(status)}
    with _hash_lock:
        _git_cache[str(root)] = (now, result)
    return dict(result)


_ADOPTED = re.compile(r'^## 1\. Current best \(adopted\):\s*(?P<block>[A-Za-z0-9_+-]+),\s*adopted\s+'
                      r'(?P<when>[0-9-]+(?: [0-9:]+)?)\s*\(commit (?P<commit>[0-9a-f]{6,40})\)', re.M)
_UPDATED = re.compile(r'^\*\*Last update\.\*\*\s*(?P<text>.+)$', re.M)


def flow_research_status(path=BEST_MODEL):
    """Adopted block named by the Flow research tracker (heading only)."""
    path = Path(path)
    try:
        if path.stat().st_size > 2 * 1024 * 1024:
            raise ValueError('BEST_MODEL.md exceeds the bounded read')
        text = path.read_text(errors='replace')
    except (OSError, ValueError) as error:
        return {'available': False, 'reason': f'{type(error).__name__}: {error}', 'source': str(path)}
    match = _ADOPTED.search(text)
    updated = _UPDATED.search(text)
    return {'available': bool(match), 'source': str(path),
            'source_sha256': hashlib.sha256(text.encode()).hexdigest(),
            'adopted_block': match['block'] if match else None,
            'adopted_at': match['when'] if match else None,
            'adopted_commit': match['commit'] if match else None,
            'last_update': updated['text'].strip()[:240] if updated else None,
            'basis': 'Parsed from the Flow research tracker heading; adoption is a research decision, not deployment qualification.',
            'reason': None if match else 'Adopted-block heading not found'}


def _bundle_profile():
    manifest_path = DEPLOY_ROOT / 'bundle/MANIFEST.json'
    try:
        manifest = json.loads(manifest_path.read_text())
    except (OSError, ValueError):
        manifest = {}
    student = DEPLOY_ROOT / 'bundle/config/student.json'
    try:
        student_config = json.loads(student.read_text())
    except (OSError, ValueError):
        student_config = {}
    return {
        'id': 'flow-bundle-20261008',
        'label': 'Flow student s2-kcsc · frozen deploy bundle',
        'short_label': 'Flow bundle 2026-10-08',
        'family': 'flow', 'research_block': None,
        'research_lineage': 'closed-loop-v2-main planner snapshot + student-s2-kcsc_s0 (pre-dates SKX2/WX)',
        'loader': 'deploy-bundle',
        'planner': {'name': student_config.get('name'), 'checkpoint': 'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt',
                    'deployed_budget': {'candidates': 16, 'ode_steps': 10}},
        'tracker': {'name': 'SONIC release G1 · fused ONNX 1570 → 29', 'path': str(DEPLOY_ROOT / 'bundle/sonic/sonic_release_g1.onnx')},
        'runtime': {'kind': 'cpu-lockstep', 'source': str(DEPLOY_ROOT / 'sim/lockstep.py'),
                    'physics': 'MuJoCo · g1_29dof rubber hands', 'device': 'cpu'},
        'bundle': {'created': manifest.get('created'), 'sources': manifest.get('sources', {}),
                   'manifest': str(manifest_path)},
        'artifacts': [DEPLOY_ROOT / p for p in (
            'bundle/MANIFEST.json', 'bundle/config/student.json',
            'bundle/flow/artifacts/student-s2-kcsc_s0/model.pt', 'bundle/sonic/sonic_release_g1.onnx',
            'sim/lockstep.py', 'g1deploy/bundle.py')],
        'repositories': [DEPLOY_ROOT],
        'limits': {'candidates': [1, 16], 'ode_steps': [1, 10], 'duration_s': [1, 10], 'wall_s': 180},
        'default_planner': {'candidates': 4, 'ode_steps': 6},
        'limitations': [
            'Frozen 2026-10-08 planner snapshot; not the Flow research adopted block.',
            'Includes Studio-authorized g1-student-deploy route adapters (codex/near-goal-route).',
        ],
    }


def _wx_profiles():
    from studio.policy_bundle import POLICY_ROOT, load_manifest, verify
    rows = []
    for root in sorted(POLICY_ROOT.glob('flow-wx-rf-*')):
        try:
            manifest = load_manifest(root)
        except (OSError, ValueError, KeyError):
            continue
        quick = verify(root, deep=False)  # sizes/presence; full hashes run inside the worker
        teacher = next((a['path'] for a in manifest['artifacts'] if a['role'] == 'flow teacher checkpoint'), '')
        rows.append({
            'id': manifest['id'], 'label': manifest['label'], 'short_label': f"WX-RF {manifest['flow']['commit'][:7]}",
            'family': 'flow', 'research_block': manifest['research_block'], 'variant': manifest['variant'],
            'revision': manifest['flow']['commit'], 'adopted_commit': manifest['flow']['adopted_commit'],
            'pin_basis': manifest['flow']['pin_basis'], 'config_path': manifest['flow']['config_path'],
            'config_sha256': manifest['flow']['config_sha256'], 'arm': manifest['flow']['arm'],
            'research_lineage': f"Flow {manifest['variant']} · {Path(teacher).parent.name}",
            'loader': 'flow-callback', 'bundle_id': manifest['id'], 'flow_snapshot': str(root),
            'planner': {'name': manifest['variant'], 'checkpoint': teacher, 'deployed_budget': manifest['deployed_budget'],
                        'execution_check': 'WM-v2 3-member ensemble (Isaac-trained)', 'map': 'privileged exact boxes'},
            'tracker': {'name': 'SONIC release G1 · fused ONNX 1570 → 29', 'path': str(DEPLOY_ROOT / 'bundle/sonic/sonic_release_g1.onnx')},
            'runtime': {'kind': 'cpu-flow-callback', 'source': 'motion2scene_flow.closed_loop.callback (pinned snapshot)',
                        'physics': 'MuJoCo · g1_29dof rubber hands', 'device': 'cpu'},
            'privileged_map': True,
            'artifacts': [Path(root / 'manifest.json'), Path(root / 'config.json')] + [Path(a['path']) for a in manifest['artifacts']],
            'repositories': [DEPLOY_ROOT],
            'available': not quick, 'missing': quick,
            'limits': {'candidates': [1, 16], 'ode_steps': [1, 10], 'duration_s': [1, 10], 'wall_s': 480},
            'default_planner': {'candidates': 8, 'ode_steps': 6},
            'limitations': list(manifest['caveats']) + [
                'Default Studio budget K8/ODE6 differs from the evaluated 16/10 (≈3–4 s per CPU replan at 16/10 on this host).'],
        })
    return rows


def _expand(builder):
    result = builder()
    return result if isinstance(result, list) else [result]


PROFILE_BUILDERS = [_bundle_profile, _wx_profiles]


def register_profile(builder):
    """Add an optional profile builder (e.g. a pinned Flow research snapshot)."""
    if builder not in PROFILE_BUILDERS:
        PROFILE_BUILDERS.append(builder)
    return builder


def profiles():
    result = {}
    for builder in PROFILE_BUILDERS:
        try:
            built = _expand(builder)
        except Exception as error:  # an optional adapter must not disable the catalog
            built = [{'id': getattr(builder, '__name__', 'unknown').strip('_'), 'label': 'Unavailable profile',
                      'available': False, 'missing': [f'{type(error).__name__}: {error}'], 'artifacts': [],
                      'repositories': []}]
        for profile in built:
            if profile:
                result[profile['id']] = profile
    return result


def get_profile(policy_id):
    table = profiles()
    if policy_id not in table:
        raise ValueError(f'Unknown policy profile {policy_id!r}')
    return table[policy_id]


def identity(profile):
    """Resolved, hashable identity pinned into each scenario/run."""
    artifacts = [file_identity(p) for p in profile.get('artifacts', [])]
    missing = [a['path'] for a in artifacts if not a['available']] + list(profile.get('missing', []))
    repos = [git_identity(r) for r in profile.get('repositories', [])]
    pinned = hashlib.sha256(json.dumps({'id': profile['id'],
                                        'artifacts': [(a['path'], a['sha256']) for a in artifacts],
                                        'repositories': [(r['path'], r['head']) for r in repos],
                                        'config_sha256': profile.get('config_sha256')},
                                       sort_keys=True).encode()).hexdigest()
    return {'policy_id': profile['id'], 'artifacts': artifacts, 'repositories': repos,
            'config_sha256': profile.get('config_sha256'), 'revision': profile.get('revision'),
            'identity_sha256': pinned, 'available': not missing, 'missing': missing}


def catalog(research=None):
    research = research or flow_research_status()
    rows = []
    for profile in profiles().values():
        ident = identity(profile)
        row = {k: v for k, v in profile.items() if k not in ('artifacts', 'repositories')}
        row.update(identity=ident, available=ident['available'] and profile.get('available', True),
                   missing=ident['missing'])
        block = profile.get('research_block')
        row['matches_adopted'] = bool(block and research.get('adopted_block') == block)
        rows.append(row)
    return {'schema_version': 1, 'default_policy_id': DEFAULT_POLICY, 'policies': rows,
            'flow_research': research,
            'note': 'Profiles are simulation rehearsal configurations. Research adoption and CPU-lockstep success are not hardware qualification.'}
