#!/usr/bin/env python3
"""Pin a retrieval-free Flow planner block as a Studio policy bundle (default: WX-RF, adopted 2026-10-16).

Read-only against Flow: ``git archive``/``git show`` of one commit, plus two
individual artifact symlinks the planner resolves relative to its source root.
Checkpoints are referenced in place by absolute path and SHA-256; nothing is
copied into Git and no Flow file, environment or running job is modified.

    .venv/bin/python tools/build_policy_bundle.py              # WX-RF @ 23326aa, teacher sk1_s0
    .venv/bin/python tools/build_policy_bundle.py --verify-only
    # WXD = WX + DP2 duck keys (Flow's adopted block since 2026-10-20), retrieval-free arm of the DP2 xdg config:
    .venv/bin/python tools/build_policy_bundle.py --block WXD --commit 5658a6d \
        --config configs/closed_loop_dp2_xdg.json --arm XGD-g-s0 --teacher sk1_s0 \
        --variant 'WXD-RF (WX + DP2 duck keys, retrieval-free; XGD arm)' --adopted-commit 5658a6d

The bundle id is ``flow-<block>-rf-<commit7>-s<seed>`` (studio.policy_bundle.BUNDLE_ID).
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
import re  # noqa: E402

from studio.policy_bundle import ARTIFACT_LINKS, BUNDLE_ID, POLICY_ROOT, sha256, tree_hashes, verify  # noqa: E402

BLOCK = re.compile(r'[A-Za-z0-9]{1,16}')

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


def build(commit, config_path, arm_name, teacher, force=False, block='WX', variant=None, label=None, adopted_commit=None,
          pin_basis=None):
    if not BLOCK.fullmatch(block):
        raise SystemExit('--block must be 1-16 letters or digits')
    commit = git(FLOW, 'rev-parse', '--verify', f'{commit}^{{commit}}')
    bundle_id = f"flow-{block.lower()}-rf-{commit[:7]}-{teacher.split('_')[-1]}"
    if not BUNDLE_ID.fullmatch(bundle_id):
        raise SystemExit(f'Bundle id {bundle_id} does not match {BUNDLE_ID.pattern}')
    # Check the arm before anything is written: a refused build leaves no partial bundle behind.
    config_blob = git(FLOW, 'show', f'{commit}:{config_path}', binary=True)
    config = json.loads(config_blob)
    arm = next((a for a in config['arms'] if a['name'] == arm_name), None)
    if arm is None:
        raise SystemExit(f'No arm {arm_name} in {config_path} at {commit[:7]}')
    if arm['gate_side']['level'].get('retrieval_k', 0) != 0:
        raise SystemExit('Selected arm is not retrieval-free')
    if Path(arm['planner']['run']).name != teacher:
        raise SystemExit(f"Arm {arm_name} uses {Path(arm['planner']['run']).name}, not {teacher}")
    root = POLICY_ROOT / bundle_id
    if root.exists() and not force:
        raise SystemExit(f'{root} exists; use --verify-only or --force')
    root.mkdir(parents=True, exist_ok=force)
    if force and (root / 'src').exists():
        import shutil
        shutil.rmtree(root / 'src')  # never pin stale files left by an earlier extraction
    archive = git(FLOW, 'archive', '--format=tar', commit, 'src/', binary=True)
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        members = [m for m in tar.getmembers() if m.isfile() or m.isdir()]
        for m in members:
            if m.name.startswith('/') or '..' in Path(m.name).parts:
                raise SystemExit(f'Unsafe archive member {m.name}')
        tar.extractall(root, members=members)
    (root / 'config.json').write_bytes(config_blob)
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
        'label': label or f'Flow {block}-RF · adopted block · teacher {teacher}',
        **({} if block == 'WX' else {'short_label': f'{block}-RF {commit[:7]}'}),
        'research_block': block, 'variant': variant or ('WX-RF (retrieval-free; WXR0 arm)' if block == 'WX' else f'{block}-RF ({arm_name})'),
        'flow': {'repo': str(FLOW), 'commit': commit, 'committed_at': git(FLOW, 'log', '-1', '--format=%cI', commit),
                 'adopted_commit': adopted_commit or (DEFAULT['adopted_commit'] if block == 'WX' else commit[:7]),
                 'src_tree': git(FLOW, 'rev-parse', f'{commit}:src'),
                 'pin_basis': pin_basis or ('Adoption commit lacks arena/probe.py imported by tight-mode arm posture; this commit keeps the WX arm config identical.'
                                            if block == 'WX' else f'Flow commit {commit[:7]}, config {config_path}, arm {arm_name}.'),
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
            ('WX was evaluated in Isaac (guard 121/156, V-learn 172/213); MuJoCo CPU results do not transfer automatically.'
             if block == 'WX' else f'{block} was evaluated in Isaac (Flow research/BEST_MODEL.md); MuJoCo CPU results do not transfer automatically.'),
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
    ap.add_argument('--block', default='WX', help="Flow research block name (BEST_MODEL.md), e.g. WX or WXD; sets the id prefix")
    ap.add_argument('--variant', default=None, help='variant text in the manifest (default: WX-RF text for WX)')
    ap.add_argument('--label', default=None, help="profile label (default 'Flow <block>-RF · adopted block · teacher <teacher>')")
    ap.add_argument('--adopted-commit', default=None, help='the adoption commit to record (default: 4ba73cb for WX, else --commit)')
    ap.add_argument('--pin-basis', default=None, help='why this commit is pinned (default: the WX note for WX)')
    ap.add_argument('--verify-only', action='store_true')
    ap.add_argument('--force', action='store_true')
    args = ap.parse_args(argv)
    if args.verify_only:
        roots = sorted(p for p in POLICY_ROOT.glob('flow-*') if BUNDLE_ID.fullmatch(p.name))
        if not roots:
            raise SystemExit('No Flow bundle built yet')
        status = 0
        for root in roots:
            problems = verify(root)
            print(json.dumps({'bundle': str(root), 'verified': not problems, 'problems': problems}))
            status |= bool(problems)
        return status
    root, manifest = build(args.commit, args.config, args.arm, args.teacher, args.force, block=args.block, variant=args.variant,
                           label=args.label, adopted_commit=args.adopted_commit, pin_basis=args.pin_basis)
    problems = verify(root)
    print(json.dumps({'bundle': str(root), 'id': manifest['id'], 'flow_commit': manifest['flow']['commit'],
                      'config_sha256': manifest['flow']['config_sha256'], 'src_files': len(manifest['src_files']),
                      'verified': not problems, 'problems': problems}, indent=1))
    return 1 if problems else 0


if __name__ == '__main__':
    sys.exit(main())
