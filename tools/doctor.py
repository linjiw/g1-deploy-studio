#!/usr/bin/env python3
"""Is this machine ready for Studio, and for which use? Read-only: it writes nothing and starts no robot code.

    .venv/bin/python tools/doctor.py               # everything; exit 0 when simulation (Navigate, Rehearse) is ready
    .venv/bin/python tools/doctor.py --for robot   # the deploy PC: also the SONIC runner and the robot link config
    .venv/bin/python tools/doctor.py --quick       # skip the deploy interpreter probe and the bundle's full hashes
    .venv/bin/python tools/doctor.py --json

Three levels, each needing the ones before it:

- replay: Studio's own interpreter, packages and browser files (docs/INSTALL.md step 1);
- sim: the deploy stack at the pinned commit, its interpreter and the frozen bundle, verified file by file
  (steps 2-3). Navigate's simulated robot and rehearsals need it;
- robot: the SONIC C++ runner, CycloneDDS and a loopback-only config/robot_link.json (steps 4-5). Needed only on the
  deploy PC next to the robot. Ready here means configured, not tested on hardware.

The only processes it starts are git (read-only, --no-optional-locks), the deploy interpreter importing its
packages, and tools/deploy_bundle.py verify. None of them opens a socket or a DDS participant.
"""
from __future__ import annotations

import argparse
from importlib import metadata
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from studio import paths  # noqa: E402

LEVELS = ('replay', 'sim', 'robot')
OK, WARN, FAIL, INFO = 'ok', 'warn', 'fail', 'info'
MARK = {OK: '✓', WARN: '!', FAIL: '✗', INFO: '·'}
PROBE = r'''
import importlib, json, sys
out = {"python": sys.version.split()[0]}
for name in ("numpy", "scipy", "mujoco", "onnxruntime", "torch", "zmq", "msgpack"):
    try:
        out[name] = getattr(importlib.import_module(name), "__version__", "?")
    except Exception as error:
        out[name] = None; out.setdefault("errors", {})[name] = f"{type(error).__name__}: {error}"[:200]
try:
    import torch
    out["cuda"] = bool(torch.cuda.is_available())
except Exception:
    out["cuda"] = None
print(json.dumps(out))
'''


class Report:
    def __init__(self):
        self.rows = []

    def add(self, level, section, name, status, detail='', fix=''):
        self.rows.append({'level': level, 'section': section, 'check': name, 'status': status, 'detail': str(detail),
                          **({'fix': fix} if fix else {})})

    def ready(self, level):
        upto = LEVELS[:LEVELS.index(level) + 1]
        return not any(r['status'] == FAIL and r['level'] in upto for r in self.rows)


def git(repo, *args):
    try:
        out = subprocess.run(['git', '--no-optional-locks', '-C', str(repo), *args], capture_output=True, text=True,
                             timeout=20)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout.strip() if out.returncode == 0 else None


def load_pin():
    try:
        return json.loads((ROOT / 'config/deploy.json').read_text())
    except (OSError, ValueError):
        return {}


def check_studio(r):
    s = 'Studio'
    v = sys.version_info
    r.add('replay', s, 'Python', OK if v >= (3, 10) else FAIL, sys.version.split()[0], 'Python 3.10 or newer')
    if Path(sys.prefix).resolve() != (ROOT / '.venv').resolve():
        r.add('replay', s, 'Interpreter', WARN, f'{sys.executable} is not this checkout\'s .venv',
              'run with .venv/bin/python (tools/install.sh creates it)')
    for line in (ROOT / 'requirements.txt').read_text().splitlines():
        line = line.split('#')[0].strip()
        if not line:
            continue
        name, _, want = line.partition('==')
        try:
            have = metadata.version(name)
        except metadata.PackageNotFoundError:
            r.add('replay', s, name, FAIL, 'not installed', '.venv/bin/pip install -r requirements.txt')
            continue
        r.add('replay', s, name, OK if not want or have == want else WARN, have if have == want else f'{have} (pinned {want})')
    modules = ROOT / 'node_modules'
    three = modules / 'three/build/three.module.min.js'
    inter = modules / '@fontsource-variable/inter/files'
    r.add('replay', s, 'Browser files', OK if three.is_file() and inter.is_dir() else FAIL,
          'three.js and Inter' if three.is_file() and inter.is_dir() else 'node_modules lacks three.js or Inter', 'npm ci')
    try:
        local = paths.local_config()
        r.add('replay', s, 'config/local.json', OK if local else INFO,
              'valid' if local else 'absent: defaults apply (template config/local.example.json)')
    except paths.ConfigError as error:
        r.add('replay', s, 'config/local.json', FAIL, error, 'fix the JSON; template config/local.example.json')
    data = paths.get('data_root')
    probe = data
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    r.add('replay', s, 'Data root', OK if os.access(probe, os.W_OK) else FAIL,
          f"{data} ({paths.source('data_root')}){'' if data.exists() else ', created on first use'}",
          'set paths.data_root in config/local.json to a writable directory')
    chrome = os.environ.get('CHROME_PATH') or '/opt/google/chrome/chrome'
    browsers = Path.home() / '.cache/ms-playwright'
    found = Path(chrome).is_file() or (browsers.is_dir() and any(browsers.glob('chromium*')))
    r.add('replay', s, 'Chromium (browser tests)', OK if found else INFO,
          chrome if Path(chrome).is_file() else ('Playwright Chromium' if found else 'not found: browser tests only'),
          'npx playwright install chromium, or set CHROME_PATH')


def check_paths(r):
    for row in paths.describe():
        optional = row['key'] in ('flow_root', 'sonic_backend_root', 'grandloco_root')
        level = {'deploy_root': 'sim', 'lucid_root': 'robot', 'data_root': 'replay'}.get(row['key'], 'replay')
        status = OK if row['exists'] else (INFO if optional or row['key'] == 'data_root' else
                                           (WARN if row['key'] == 'lucid_root' else FAIL))
        r.add(level, 'Paths', row['key'], status, f"{row['path']} ({row['source']})",
              f"set ${row['env']} or paths.{row['key']} in config/local.json" if not row['exists'] else '')


def check_deploy(r, pin, quick):
    s = 'Deploy stack'
    root = paths.get('deploy_root')
    want = pin.get('deploy_stack', {})
    if not root.is_dir():
        r.add('sim', s, 'Checkout', FAIL, f'{root} missing',
              f"tools/install.sh --deploy (clones {want.get('repo', 'the deploy repo')} at {want.get('tag', 'the pinned tag')})")
        return
    head = git(root, 'rev-parse', 'HEAD')
    if head is None:
        r.add('sim', s, 'Checkout', WARN, f'{root} is not a git checkout: its commit cannot be checked')
    else:
        pinned = want.get('commit')
        r.add('sim', s, 'Commit', OK if not pinned or head == pinned else WARN,
              head[:12] + ('' if not pinned or head == pinned else f" (config/deploy.json pins {pinned[:12]}, tag {want.get('tag')})"),
              f"git -C {root} checkout {want.get('tag')}" if pinned and head != pinned else '')
        dirty = git(root, 'status', '--porcelain', '--untracked-files=no')
        r.add('sim', s, 'Tracked files', OK if not dirty else WARN, 'clean' if not dirty else 'modified: ' + ' '.join(
            line[3:] for line in dirty.splitlines()[:5]))
    python = paths.deploy_python()
    if not python.is_file():
        r.add('sim', s, 'Interpreter', FAIL, f'{python} missing', 'create the deploy venv (docs/INSTALL.md step 2)')
    elif quick:
        r.add('sim', s, 'Interpreter', INFO, f'{python} (probe skipped: --quick)')
    else:
        try:
            out = subprocess.run([str(python), '-c', PROBE], capture_output=True, text=True, timeout=180,
                                 env=dict(os.environ, CUDA_VISIBLE_DEVICES=os.environ.get('CUDA_VISIBLE_DEVICES', '')))
            probe = json.loads(out.stdout.strip().splitlines()[-1])
        except (OSError, subprocess.TimeoutExpired, ValueError, IndexError) as error:
            r.add('sim', s, 'Interpreter', FAIL, f'{python} did not answer: {error}')
        else:
            missing = [k for k in ('numpy', 'scipy', 'mujoco', 'onnxruntime', 'torch') if not probe.get(k)]
            r.add('sim', s, 'Interpreter', FAIL if missing else OK,
                  f"Python {probe['python']}, torch {probe.get('torch')}, mujoco {probe.get('mujoco')}, "
                  f"onnxruntime {probe.get('onnxruntime')}" + (f"; missing {missing}" if missing else ''),
                  'install the deploy requirements (docs/INSTALL.md step 2)' if missing else '')
            # Studio's simulations run on the CPU; the robot's planner needs CUDA on the deploy PC.
            r.add('robot', s, 'CUDA for the planner', OK if probe.get('cuda') else WARN,
                  'available' if probe.get('cuda') else 'torch sees no CUDA device (fine for Studio; node.py on the robot needs it)')
    tool = ROOT / 'tools/deploy_bundle.py'
    if not tool.is_file():
        r.add('sim', s, 'Bundle', FAIL, 'tools/deploy_bundle.py missing')
        return
    cmd = [sys.executable, str(tool), 'verify', '--deploy-root', str(root)] + (['--quick'] if quick else [])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except subprocess.TimeoutExpired:
        r.add('sim', s, 'Bundle', FAIL, 'verification timed out')
        return
    if out.returncode == 2 and quick and '--quick' in out.stderr:  # an older tool without --quick
        out = subprocess.run(cmd[:-1], capture_output=True, text=True, timeout=600)
    summary = {}
    for text in [out.stdout] + [line for line in reversed(out.stdout.strip().splitlines()) if line.startswith('{')]:
        try:
            summary = json.loads(text)
            break
        except ValueError:
            continue
    if not isinstance(summary, dict):
        summary = {}
    if out.returncode == 0:
        r.add('sim', s, 'Bundle', OK, summary.get('summary') or f"{summary.get('files', '?')} files verified against MANIFEST.json")
    else:
        detail = summary.get('summary') or summary.get('error') or (out.stderr.strip().splitlines() or ['failed'])[-1]
        r.add('sim', s, 'Bundle', FAIL, detail, 'tools/deploy_bundle.py fetch (docs/INSTALL.md step 3)')
    if summary.get('trt_engines') is not None:
        r.add('robot', s, 'TensorRT engines', INFO, 'cached' if summary['trt_engines'] else
              'not built yet: the first runner start builds them for this GPU (policy ~30 s, planner ~7 min)')


def check_studio_backend(r):
    s = 'Simulation'
    try:
        from studio import policies
        from studio.policy_worker import capabilities
        cap = capabilities()
        r.add('sim', s, 'CPU simulation backend', OK if cap['available'] else FAIL,
              'deploy interpreter, lockstep, SONIC ONNX and student checkpoint present' if cap['available']
              else 'missing ' + ', '.join(cap['missing']), 'tools/install.sh --deploy (docs/INSTALL.md steps 2-3)')
        profile = policies.get_profile(policies.DEFAULT_POLICY)
        ident = policies.identity(profile)
        r.add('sim', s, f'Policy {profile["id"]}', OK if ident['available'] else FAIL,
              f"identity {ident['identity_sha256'][:12]}" if ident['available'] else f"missing {', '.join(ident.get('missing', []))}",
              'tools/install.sh --deploy (docs/INSTALL.md steps 2-3)')
    except Exception as error:  # report, never crash: a broken import is itself the finding
        r.add('sim', s, 'Policy catalog', FAIL, f'{type(error).__name__}: {error}')


def check_robot(r, pin):
    s = 'Robot (deploy PC)'
    lucid = paths.get('lucid_root')
    runner = lucid / 'runner/target/release/g1_deploy_onnx_ref'
    r.add('robot', s, 'SONIC runner', OK if os.access(runner, os.X_OK) else FAIL, runner if runner.is_file() else f'{runner} not built',
          f"clone {pin.get('sonic_runner', {}).get('repo', 'linjiw/lucid-g1-deploy')}, then in a terminal: "
          'bash setup.sh && source env.sh && bash build.sh (docs/INSTALL.md step 4)')
    head = git(lucid, 'rev-parse', 'HEAD') if lucid.is_dir() else None
    pinned = pin.get('sonic_runner', {}).get('commit')
    if head:
        r.add('robot', s, 'Runner commit', OK if not pinned or head == pinned else WARN,
              head[:12] + ('' if not pinned or head == pinned else f' (config/deploy.json pins {pinned[:12]})'))
    dds = Path(os.environ.get('CYCLONEDDS_HOME') or Path.home() / 'opt/sonic-deploy-toolchain/cyclonedds')
    r.add('robot', s, 'CycloneDDS', OK if (dds / 'lib').is_dir() else FAIL, dds, "lucid-g1-deploy's setup.sh installs it")
    from studio.workbench import read_robot_link_config
    config, reason = read_robot_link_config()
    if config is None:
        r.add('robot', s, 'Robot link config', FAIL, reason,
              'cp config/robot_link.example.json config/robot_link.json (loopback endpoints only)')
    else:
        limits = config.get('limits', {})
        r.add('robot', s, 'Robot link config', OK,
              f"{len(config['endpoints'])} loopback endpoints; goals up to {limits.get('max_goal_distance_m', '?')} m")
    r.add('robot', s, 'Hardware', INFO, 'nothing in Studio has run on a robot; follow the deploy repo\'s HARDWARE.md '
          'ladder with the remote and the physical E-stop in hand')


def check_service(r):
    unit = Path.home() / '.config/systemd/user/g1-deploy-studio.service'
    served = paths.get('data_root') / 'release.commit'
    detail = 'installed' if unit.is_file() else 'not installed (optional: tools/studio_service.sh install)'
    if served.is_file():
        detail += f', serves {served.read_text().strip()[:12]}'
    r.add('replay', 'Service', 'systemd --user unit', INFO, detail)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split('\n')[0])
    ap.add_argument('--for', dest='level', choices=LEVELS, default='sim', help='the use the exit status answers for')
    ap.add_argument('--quick', action='store_true', help='skip the deploy interpreter probe and full bundle hashes')
    ap.add_argument('--json', action='store_true')
    args = ap.parse_args(argv)
    pin = load_pin()
    r = Report()
    check_studio(r)
    check_paths(r)
    check_deploy(r, pin, args.quick)
    check_studio_backend(r)
    check_robot(r, pin)
    check_service(r)
    verdict = {level: r.ready(level) for level in LEVELS}
    if args.json:
        print(json.dumps({'ready': verdict, 'checks': r.rows, 'pin': pin.get('deploy_stack')}, indent=1))
    else:
        section = None
        for row in r.rows:
            if row['section'] != section:
                section = row['section']
                print(f'\n{section}')
            print(f"  {MARK[row['status']]} {row['check']}: {row['detail']}")
            if row.get('fix') and row['status'] in (FAIL, WARN):
                print(f"      → {row['fix']}")
        names = {'replay': 'Replay', 'sim': 'Simulation (Navigate, Rehearse)', 'robot': 'Robot link (deploy PC)'}
        print('\nReady for: ' + ', '.join(f"{names[k]} {'yes' if v else 'no'}" for k, v in verdict.items()))
    return 0 if verdict[args.level] else 1


if __name__ == '__main__':
    sys.exit(main())
