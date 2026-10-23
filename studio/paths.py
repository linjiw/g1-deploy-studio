"""Where this machine keeps Studio's neighbours: the deploy stack, the SONIC runner, Flow and Studio's own data.

Studio modules and tools ask here instead of hard-coding a path. Each root comes from, in order:

1. its environment variable (the same names g1-student-deploy's ``env.sh`` uses where one exists);
2. the ``paths`` object of ``config/local.json`` (ignored by Git; template ``config/local.example.json``);
3. the default under ``$HOME``, the layout docs/INSTALL.md sets up.

The configs in Git (``config/references.json``, ``config/robots/*.json``, ``config/sessions.json``) record the
paths of the machine that inspected or recorded them. ``relocate`` maps those onto this machine's roots, so the
provenance stays as recorded and the files are still found here.

Standard library only: the policy workers import this module under the deploy stack's interpreter.
"""
from __future__ import annotations

from functools import lru_cache
import json
import os
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
LOCAL_CONFIG = ROOT / 'config/local.json'

# key: (environment variable, default relative to $HOME, path recorded in the configs in Git, what needs it)
ROOTS = {
    'deploy_root': ('G1_STUDENT_DEPLOY', 'code/g1-student-deploy', '/home/linjiw/code/g1-student-deploy',
                    'the deploy stack (node.py, the frozen bundle): Navigate, rehearsals, the robot link'),
    'lucid_root': ('LUCID_DEPLOY_ROOT', 'lucid-sonic/lucid-g1-deploy', '/home/linjiw/lucid-sonic/lucid-g1-deploy',
                   'the SONIC C++ runner: real-time rehearsal and the robot'),
    'data_root': ('STUDIO_DATA', 'research-data/g1-deploy-studio', '/home/linjiw/research-data/g1-deploy-studio',
                  "Studio's data: rehearsals, sessions, policy pins, evidence, the service's release worktree"),
    'flow_root': ('FLOW_ROOT', 'flow', '/home/linjiw/flow',
                  'Flow research checkout (optional): only to build the privileged Flow policy pins'),
    'sonic_backend_root': ('SONIC_BACKEND_ROOT', 'groot-wbc-sonic-sim-trackb', '/home/linjiw/groot-wbc-sonic-sim-trackb',
                           'SONIC training source (optional): cited by the robot contract'),
    'grandloco_root': ('GRANDLOCO_ROOT', 'newton-terrain/deploy_g1', '/home/linjiw/newton-terrain/deploy_g1',
                       'GrandLoco deploy (optional): cited by the robot contract'),
}


class ConfigError(ValueError):
    """config/local.json is malformed."""


@lru_cache(maxsize=1)
def local_config() -> dict:
    """config/local.json as a dict ({} when absent). Also holds recordings: see config/local.example.json."""
    try:
        text = LOCAL_CONFIG.read_text()
    except FileNotFoundError:
        return {}
    try:
        data = json.loads(text)
    except json.JSONDecodeError as error:
        raise ConfigError(f'{LOCAL_CONFIG}: not JSON ({error})') from None
    if not isinstance(data, dict) or not isinstance(data.get('paths', {}), dict):
        raise ConfigError(f'{LOCAL_CONFIG}: expected an object with an optional "paths" object')
    unknown = set(data.get('paths', {})) - set(ROOTS)
    if unknown:
        raise ConfigError(f'{LOCAL_CONFIG}: unknown paths {sorted(unknown)}; known: {sorted(ROOTS)}')
    return data


def _resolve(key: str) -> tuple[Path, str]:
    if key not in ROOTS:
        raise KeyError(f'Unknown path {key!r}; known: {sorted(ROOTS)}')
    env, default, _, _ = ROOTS[key]
    if os.environ.get(env):
        return Path(os.environ[env]).expanduser(), f'${env}'
    configured = local_config().get('paths', {}).get(key)
    if configured:
        return Path(configured).expanduser(), 'config/local.json'
    return Path.home() / default, 'default'


def get(key: str) -> Path:
    """The absolute root for ``key`` on this machine (it may not exist)."""
    return _resolve(key)[0]


def source(key: str) -> str:
    """Where ``get(key)`` came from: '$ENV', 'config/local.json' or 'default'."""
    return _resolve(key)[1]


def deploy_python() -> Path:
    """The deploy stack's interpreter, which runs the policy workers (its venv carries torch and MuJoCo)."""
    if os.environ.get('G1_DEPLOY_PYTHON'):
        return Path(os.environ['G1_DEPLOY_PYTHON']).expanduser()
    return get('deploy_root') / '.venv/bin/python'


def relocate(path):
    """Map a path recorded on the machine that wrote a config in Git onto this machine's roots.

    '/home/linjiw/code/g1-student-deploy/g1deploy/node.py' becomes '<deploy_root>/g1deploy/node.py'; a path under no
    recorded root, and a leading '~', are expanded and returned as they are. The result is a str."""
    text = str(path)
    for key, (_, _, recorded, _) in ROOTS.items():
        if text == recorded or text.startswith(recorded + '/'):
            return str(get(key)) + text[len(recorded):]
    return os.path.expanduser(text)


def relocate_tree(node):
    """relocate() every absolute path string inside a JSON-like tree (dicts, lists), returning a new tree."""
    if isinstance(node, dict):
        return {k: relocate_tree(v) for k, v in node.items()}
    if isinstance(node, list):
        return [relocate_tree(v) for v in node]
    if isinstance(node, str) and (node.startswith('/') or node.startswith('~/')):
        return relocate(node)
    return node


def describe() -> list[dict]:
    """Every root with its value, source and presence (tools/doctor.py, docs/INSTALL.md)."""
    rows = []
    for key, (env, _, _, need) in ROOTS.items():
        value, origin = _resolve(key)
        rows.append({'key': key, 'path': str(value), 'source': origin, 'env': env, 'exists': value.is_dir(), 'needed_for': need})
    return rows


if __name__ == '__main__':  # `python -m studio.paths [key]`: shell scripts read a root without duplicating the rules
    import sys
    if len(sys.argv) > 1:
        print(deploy_python() if sys.argv[1] == 'deploy_python' else get(sys.argv[1]))
    else:
        print(json.dumps(describe(), indent=1))
