"""Pinned policy bundles under the Studio data root (outside Git).

A bundle holds an archived planner source tree at one commit, the exact config
blob and a manifest of every checkpoint/dependency hash. Checkpoints stay in
their original repository and are verified by SHA-256 before each run.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import re

POLICY_ROOT = Path.home() / 'research-data/g1-deploy-studio/policies'
ARTIFACT_LINKS = ['artifacts/native-reference-v1-final/geometry.json', 'artifacts/clean-reference-v2/receipt.json']
# flow-<block>-rf-<commit7>-s<seed>, e.g. flow-wx-rf-23326aa-s0 or flow-wxd-rf-5658a6d-s0 (tools/build_policy_bundle.py).
BUNDLE_ID = re.compile(r'flow-[a-z0-9]{1,16}-rf-[0-9a-f]{7}-s[0-2]')


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(1 << 20), b''):
            h.update(chunk)
    return h.hexdigest()


def tree_hashes(root):
    root = Path(root)
    return {str(p.relative_to(root)): sha256(p) for p in sorted(root.rglob('*')) if p.is_file() and not p.is_symlink()}


def bundle_path(bundle_id, root=POLICY_ROOT):
    if not isinstance(bundle_id, str) or not BUNDLE_ID.fullmatch(bundle_id):
        raise ValueError('Unknown policy bundle id')
    return Path(root) / bundle_id


def load_manifest(path):
    data = json.loads((Path(path) / 'manifest.json').read_text())
    if data.get('schema_version') != 1:
        raise ValueError('Unsupported policy bundle manifest')
    return data


def verify(root, *, deep=True):
    """Mismatches between a bundle and its manifest (empty list = verified)."""
    root = Path(root)
    try:
        manifest = load_manifest(root)
    except (OSError, ValueError) as error:
        return [f'manifest unavailable: {error}']
    problems = []
    links = [str(q.relative_to(root)) for q in (root / 'src').rglob('*') if q.is_symlink()]
    if links:
        problems.append(f'symlinks are not allowed in the pinned source tree: {links[:3]}')
    if deep:
        current = tree_hashes(root / 'src')
        if current != manifest['src_files']:
            changed = sorted(set(current.items()) ^ set(manifest['src_files'].items()))
            problems.append(f'src tree differs from manifest ({len(changed)} entries), e.g. {changed[:2]}')
    if not (root / 'config.json').is_file():
        problems.append('missing config.json')
    elif sha256(root / 'config.json') != manifest['flow']['config_sha256']:
        problems.append('config.json hash mismatch')
    for entry in manifest['artifacts'] + manifest['humanoid_lfh']['files'] + manifest['deploy']['files']:
        path = Path(entry['path'])
        if not path.is_file():
            problems.append(f'missing {path}')
        elif path.stat().st_size != entry['bytes'] or (deep and sha256(path) != entry['sha256']):
            problems.append(f'hash mismatch {path}')
    pinned = {Path(a['path']).resolve() for a in manifest['artifacts']}
    for rel in ARTIFACT_LINKS:
        link = root / rel
        if not link.is_file():
            problems.append(f'missing planner artifact link {rel}')
        elif link.resolve() not in pinned:
            problems.append(f'planner artifact link {rel} points outside the pinned artifacts: {link.resolve()}')
    # Checkpoint folders are globbed by Flow (e.g. member*.pt; a model.pt takes precedence):
    # any unpinned checkpoint file there would be loaded without verification.
    for folder in {Path(a['path']).parent for a in manifest['artifacts'] if a['path'].endswith('.pt')}:
        extra = sorted(str(f) for f in folder.glob('*.pt') if f.resolve() not in pinned)
        if extra:
            problems.append(f'unpinned checkpoint files in {folder}: {extra[:3]}')
    return problems
