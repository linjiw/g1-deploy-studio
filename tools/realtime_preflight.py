#!/usr/bin/env python3
"""Read-only readiness report for an isolated real-time (L3) SONIC rehearsal.

Checks what the existing g1-student-deploy `sim/realtime/rehearse.py` chain needs
(MuJoCo DDS simulator + C++ SONIC runner + planner node) and whether it could be
confined to an unprivileged network namespace, where DDS domain 0 has no route to
any physical interface. It launches no simulator, runner, DDS participant or CUDA
context, opens no sockets and changes no configuration. The only process it may
start is `unshare ... ip -brief link` (a namespace probe with no side effects).

    .venv/bin/python tools/realtime_preflight.py [--json]
"""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = Path('/home/linjiw/code/g1-student-deploy')
LUCID = Path('/home/linjiw/lucid-sonic/lucid-g1-deploy')


def sha(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def item(name, ok, detail, blocking=True):
    return {'check': name, 'status': 'ok' if ok else ('blocked' if blocking else 'warning'), 'detail': detail}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    checks = []
    runner = LUCID / 'runner/target/release/g1_deploy_onnx_ref'
    onnx = DEPLOY / 'bundle/sonic/sonic_release_g1.onnx'
    checks.append(item('SONIC C++ runner binary', runner.is_file(), f'{runner} sha256 {sha(runner)[:16]}' if runner.is_file() else f'missing {runner}'))
    checks.append(item('Fused SONIC ONNX (1570 -> 29)', onnx.is_file(), f'{onnx} sha256 {sha(onnx)[:16]}' if onnx.is_file() else f'missing {onnx}'))
    for rel in ('sim/realtime/rehearse.py', 'sim/realtime/robot_sim.py', 'g1deploy/node.py'):
        checks.append(item(f'g1-student-deploy {rel}', (DEPLOY / rel).is_file(), str(DEPLOY / rel)))
    obs = LUCID / 'config/observation_config_lucid_g1_1570.yaml'
    checks.append(item('Runner observation config', obs.is_file(), str(obs)))
    engines = sorted(LUCID.glob('policies/*.trt')) + sorted(DEPLOY.glob('bundle/sonic/*.engine')) + sorted(DEPLOY.glob('bundle/sonic/*.trt'))
    checks.append(item('Prebuilt TensorRT engines', bool(engines),
                       f'{len(engines)} found; rehearse.py builds the fused-ONNX engine on first boot (up to 600 s)', blocking=False))
    # DDS domain: hard-coded in the runner (from the source-verified robot contract).
    cpp = LUCID / 'runner/src/g1/g1_deploy_onnx_ref/src/g1_deploy_onnx_ref.cpp'
    hard_coded = False
    if cpp.is_file():
        hard_coded = bool(re.search(r'ChannelFactory::Instance\(\)->Init\(\s*0\s*,', cpp.read_text(errors='replace')))
    checks.append(item('Runner DDS domain', not hard_coded,
                       'Hard-coded domain 0 (ChannelFactory::Instance()->Init(0, ...)). Needs either an upstream --dds-domain '
                       'option or network-namespace isolation (below).' if hard_coded else 'Configurable'))
    # Unprivileged network namespace: domain-0 traffic confined to a private loopback.
    netns = {'available': False}
    if shutil.which('unshare') and shutil.which('ip'):
        probe = subprocess.run(['unshare', '--user', '--map-root-user', '--net', 'ip', '-brief', 'link'],
                               capture_output=True, text=True, timeout=10)
        links = [line.split()[0] for line in probe.stdout.splitlines() if line.strip()]
        netns = {'available': probe.returncode == 0 and links == ['lo'], 'interfaces_inside': links, 'stderr': probe.stderr.strip()[:200]}
    checks.append(item('Unprivileged network namespace', netns['available'],
                       f"interfaces inside: {netns.get('interfaces_inside')} (only a private loopback: no route to robot NICs)"
                       if netns['available'] else f'unavailable: {netns}'))
    # GPU: report driver/library versions without touching CUDA or NVML.
    kernel = Path('/proc/driver/nvidia/version')
    kernel_ver = re.search(r'(\d+\.\d+\.\d+)', kernel.read_text()).group(1) if kernel.is_file() else None
    libs = sorted(Path('/usr/lib/x86_64-linux-gnu').glob('libnvidia-ml.so.*.*'))
    lib_ver = re.search(r'(\d+\.\d+\.\d+)$', libs[-1].name).group(1) if libs else None
    checks.append(item('NVIDIA kernel module vs user libraries', kernel_ver and kernel_ver == lib_ver,
                       f'kernel {kernel_ver} vs libnvidia-ml {lib_ver}: NVML/nvidia-smi fail; GPU utilisation is unknown, not idle. '
                       'Flow research jobs are using the GPU; a reboot or driver repair is out of scope.', blocking=False))
    checks.append(item('Isolation of Studio itself', True,
                       'Studio would only launch the existing rehearse.py chain inside the namespace and subscribe to g1_debug '
                       'there; it never publishes rt/lowcmd or pose.', blocking=False))
    blocked = [c for c in checks if c['status'] == 'blocked']
    plan = {'approval_needed': [
        'Run the domain-0 chain inside an unprivileged user+network namespace (isolated loopback), OR approve an upstream '
        '--dds-domain option in the runner/robot_sim/node.',
        'Use the shared GPU for TensorRT + the planner while Flow research jobs run (bounded, one rehearsal at a time).'],
        'command_sketch': ("unshare --user --map-root-user --net bash -c 'ip link set lo up && "
                           "cd /home/linjiw/code/g1-student-deploy && .venv/bin/python sim/realtime/rehearse.py "
                           "--task <task.json> --out <owned dir> & .venv/bin/python -m studio.recorder --endpoint tcp://127.0.0.1:5557 "
                           "--topic g1_debug --topic robot_config --duration <s> --output <owned dir>/g1_debug.jsonl'"),
        'not_run': 'This preflight launched nothing. The sketch is for review only.'}
    report = {'schema_version': 1, 'ready_without_approval': False,
              'blocking': [c['check'] for c in blocked], 'checks': checks, 'plan': plan}
    if args.json:
        print(json.dumps(report, indent=1))
    else:
        for c in checks:
            print(f"[{c['status']:>7}] {c['check']}: {c['detail']}")
        print('\nApproval needed before any real-time rehearsal:')
        for a in plan['approval_needed']:
            print(f'  - {a}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
