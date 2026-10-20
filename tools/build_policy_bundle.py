#!/usr/bin/env python3
"""Pin the adopted Flow WX (retrieval-free) planner as a Studio policy bundle.

Read-only against Flow: ``git archive``/``git show`` of one commit, plus two
individual artifact symlinks the planner resolves relative to its source root.
Checkpoints are referenced in place by absolute path and SHA-256; nothing is
copied into Git and no Flow file, environment or running job is modified.

    .venv/bin/python tools/build_policy_bundle.py              # WX-RF @ 23326aa, teacher sk1_s0
    .venv/bin/python tools/build_policy_bundle.py --verify-only
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path
import subprocess
import sys
import tarfile
import time

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from studio.policy_bundle import ARTIFACT_LINKS, POLICY_ROOT, sha256, tree_hashes, verify  # noqa: E402

FLOW = Path('/home/linjiw/flow')
DEPLOY = Path('/home/linjiw/code/g1-student-deploy')
LFH = FLOW / '.bridge-deps/humanoid_lfh'

# Flow BEST_MODEL.md: WX adopted 2026-10-16 (4ba73cb). That tree lacks
# arena/probe.py (first committed f7a7734, imported by tight-mode arm posture);
# Isaac packets used the working tree. 23326aa contains it and keeps the WX
# config byte-identical (WXR0 arm differs only in a note timestamp).
DEFAULT = {'commit': '23326aa1df7aac98c4da6308ee0fa87dd8e80528', 'adopted_commit': '4ba73cb',
           'config': 'configs/closed_loop_wxr0_c3.json', 'arm': 'WXR0-g-s0', 'teacher': 'sk1_s0'}
DEPLOY_FILES = ['sim/episode.py', 'sim/scene.py', 'sim/assets/g1_29dof.xml', 'g1deploy/sonic.py', 'g1deploy/contract.py',
                'bundle/sonic/sonic_release_g1.onnx', 'bundle/config/sonic_model_contract.json']
LFH_FILES = ['native_closed_loop.py', 'native_g1.py', 'sonic_reference.py']


def ident(path, role):
    path = Path(path)
    return {'role': role, 'path': str(path), 'sha256': sha256(path), 'bytes': path.stat().st_size}


def git(repo, *args, binary=False):
    out = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, check=True, timeout=60)
    return out.stdout if binary else out.stdout.decode().strip()


def build(commit, config_path, arm_name, teacher, force=False):
    commit = git(FLOW, 'rev-parse', '--verify', f'{commit}^{{commit}}')
    bundle_id = f"flow-wx-rf-{commit[:7]}-{teacher.split('_')[-1]}"
    root = POLICY_ROOT / bundle_id
    if root.exists() and not force:
        raise SystemExit(f'{root} exists; use --verify-only or --force')
    root.mkdir(parents=True, exist_ok=force)
    archive = git(FLOW, 'archive', '--format=tar', commit, 'src/', binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = [m for m in tar.getmembers() if m.isfile() or m.isdir()]
        for m in members:
            if m.name.startswith('/') or '..' in Path(m.name).parts:
                raise SystemExit(f'Unsafe archive member {m.name}')
        tar.extractall(root, members=members)
    config_blob = git(FLOW, 'show', f'{commit}:{config_path}', binary=True)
    (root / 'config.json').write_bytes(config_blob)
    config = json.loads(config_blob)
    arm = next(a for a in config['arms'] if a['name'] == arm_name)
    if arm['gate_side']['level'].get('retrieval_k', 0) != 0:
        raise SystemExit('Selected arm is not retrieval-free')
    for rel in ARTIFACT_LINKS:
        link = root / rel
        link.parent.mkdir(parents=True, exist_ok=True)
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(FLOW / rel)
    teacher_dir = Path(arm['planner']['run'])
    if teacher_dir.name != teacher:
        raise SystemExit(f'Arm {arm_name} uses {teacher_dir.name}, not {teacher}')
    wm = Path(arm['planner']['exec_model'])
    artifacts = [ident(teacher_dir / 'model.pt', 'flow teacher checkpoint'), ident(teacher_dir / 'receipt.json', 'teacher receipt')]
    artifacts += [ident(p, 'WM-v2 execution-check member') for p in sorted(wm.glob('member*.pt'))]
    artifacts += [ident(wm / 'train_log.json', 'WM-v2 training log')]
    artifacts += [ident(FLOW / rel, 'planner geometry/reference artifact') for rel in ARTIFACT_LINKS]
    manifest = {
        'schema_version': 1, 'id': bundle_id, 'created_unix_s': time.time(),
        'label': f'Flow WX-RF · adopted block · teacher {teacher}',
        'research_block': 'WX', 'variant': 'WX-RF (retrieval-free; WXR0 arm)',
        'flow': {'repo': str(FLOW), 'commit': commit, 'committed_at': git(FLOW, 'log', '-1', '--format=%cI', commit),
                 'adopted_commit': DEFAULT['adopted_commit'], 'src_tree': git(FLOW, 'rev-parse', f'{commit}:src'),
                 'pin_basis': 'Adoption commit lacks arena/probe.py imported by tight-mode arm posture; this commit keeps the WX arm config identical.',
                 'config_path': config_path, 'config_blob': git(FLOW, 'rev-parse', f'{commit}:{config_path}'),
                 'config_sha256': hashlib.sha256(config_blob).hexdigest(), 'arm': arm_name},
        'planner_overrides': {'device': 'cpu'},
        'deployed_budget': {'candidates': config['planner_defaults']['candidates'], 'ode_steps': config['planner_defaults']['ode_steps']},
        'artifacts': artifacts,
        'humanoid_lfh': {'path': str(LFH.resolve()), 'commit': git(LFH, 'rev-parse', 'HEAD'),
                         'files': [ident(LFH / f, 'tracker reference/scoring helper') for f in LFH_FILES]},
        'deploy': {'repo': str(DEPLOY), 'head': git(DEPLOY, 'rev-parse', 'HEAD'),
                   'files': [ident(DEPLOY / f, 'MuJoCo physics / SONIC ONNX') for f in DEPLOY_FILES],
                   'newton': str(DEPLOY / 'bundle/newton')},
        'src_files': tree_hashes(root / 'src'),
        'caveats': [
            'Privileged block: map, selection, guidance, execution check and route use the exact configured boxes (simulator ground truth), not LiDAR.',
            'WM-v2 execution check was trained on Isaac SONIC executions; its accuracy under MuJoCo is unmeasured.',
            'WX was evaluated in Isaac (guard 121/156, V-learn 172/213); MuJoCo CPU results do not transfer automatically.',
            'Studio starts standing; Isaac arena tasks start from a recorded walk near 1 m/s.',
            'CPU planner randomness differs from Isaac CUDA runs; identical states can give different candidates.',
            'Lockstep: physics waits for each replan, so planner latency does not delay plans in simulation.',
        ],
    }
    (root / 'manifest.json').write_text(json.dumps(manifest, indent=1))
    return root, manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--commit', default=DEFAULT['commit'])
    ap.add_argument('--config', default=DEFAULT['config'])
    ap.add_argument('--arm', default=DEFAULT['arm'])
    ap.add_argument('--teacher', default=DEFAULT['teacher'])
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args(argv)
    if args.verify_only:
        roots = sorted(POLICY_ROOT.glob('flow-wx-rf-*'))
        if not roots:
            raise SystemExit('No WX bundle built yet')
        status = 0
        for root in roots:
            problems = verify(root)
            print(json.dumps({'bundle': str(root), 'verified': not problems, 'problems': problems}))
            status |= bool(problems)
        return status
    root, manifest = build(args.commit, args.config, args.arm, args.teacher, args.force)
    problems = verify(root)
    print(json.dumps({'bundle': str(root), 'id': manifest['id'], 'flow_commit': manifest['flow']['commit'],
                      'config_sha256': manifest['flow']['config_sha256'], 'src_files': len(manifest['src_files']),
                      'verified': not problems, 'problems': problems}, indent=1))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
