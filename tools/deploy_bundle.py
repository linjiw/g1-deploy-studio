#!/usr/bin/env python3
"""Pack, fetch and verify the deploy stack's frozen navigation policy bundle (g1-student-deploy ``bundle/``).

The bundle (the student checkpoint, the frozen planner source, the SONIC ONNX models, the MID-360 pattern) is not
in Git, but its ``MANIFEST.json`` is: the deploy repo's own commit pins every file's SHA-256. The files travel as
assets of a private release of the deploy repo, pinned in ``config/deploy.json``. A fetch checks each asset against
that pin, then every extracted file against the checkout's manifest: deploy commit -> MANIFEST.json -> files.

    .venv/bin/python tools/deploy_bundle.py verify                 # this machine's bundle against its manifest
    .venv/bin/python tools/deploy_bundle.py fetch                  # gh release download (your gh login), check, extract
    .venv/bin/python tools/deploy_bundle.py fetch --from DIR       # the same from assets copied by hand (USB, scp)
    .venv/bin/python tools/deploy_bundle.py pack --out DIR         # on the machine that holds the bundle: the assets

TensorRT engines (``*.trt``) are not part of the bundle: the SONIC runner builds them for the local GPU on first
start. Nothing is overwritten: a file that already exists and differs is refused, and a refused fetch writes nothing.
Reads the deploy checkout only (``git rev-parse`` / ``git show``); it never changes it outside ``bundle/``.
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import shutil
import subprocess
import sys
import tarfile
import tempfile

ROOT = Path(__file__).resolve().parents[1]
CONFIG = ROOT / 'config/deploy.json'
CHUNK = 1 << 20
PREFIX = 'bundle/'
# Files kept out of the core archive and published as they are (large, and NVIDIA's own GEAR-SONIC download).
RAW = {'sonic/planner/V2/planner_sonic.onnx': 'planner_sonic.onnx'}
# The runner's TensorRT engines (built per GPU on first start, cached beside the ONNX files; never in the bundle).
TRT_ENGINES = ('sonic/policy_sonic_release_g1.trt', 'sonic/planner/V2/planner_planner_sonic.trt')


def default_deploy_root():
    try:
        sys.path.insert(0, str(ROOT))
        from studio import paths  # noqa: PLC0415  (machine paths, docs/INSTALL.md)
        return Path(paths.get('deploy_root'))
    except Exception:
        return Path.home() / 'code/g1-student-deploy'


def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as handle:
        while block := handle.read(CHUNK):
            digest.update(block)
    return digest.hexdigest()


def safe_rel(name):
    """A manifest/archive path as a relative POSIX path inside the bundle, or None when it could escape."""
    if not isinstance(name, str) or not name or '\\' in name or '\0' in name:
        return None
    rel = PurePosixPath(name)
    if rel.is_absolute() or any(part in ('', '.', '..') for part in name.split('/')):
        return None
    return str(rel)


def load_manifest(bundle):
    path = Path(bundle) / 'MANIFEST.json'
    raw = path.read_bytes()
    manifest = json.loads(raw)
    files = manifest.get('files')
    if not isinstance(files, dict) or not files:
        raise ValueError(f'{path} lists no files')
    for rel, entry in files.items():
        if safe_rel(rel) != rel or not isinstance(entry, dict) or not isinstance(entry.get('sha256'), str) \
                or not isinstance(entry.get('bytes'), int):
            raise ValueError(f'{path}: unsafe or malformed entry {rel!r}')
    return manifest, hashlib.sha256(raw).hexdigest()


def verify_bundle(bundle, deep=True):
    """Every manifest file present with its size (and, deep, its SHA-256). TRT engines are listed, never required."""
    bundle = Path(bundle)
    try:
        manifest, manifest_sha = load_manifest(bundle)
    except (OSError, ValueError) as error:
        return {'bundle': str(bundle), 'verified': False, 'summary': f'no usable MANIFEST.json in {bundle}', 'files': 0,
                'problems': [f'manifest: {error}'], 'missing': [], 'mismatched': [], 'trt_engines': False,
                'tensorrt_engines': [], 'error': str(error)}
    missing, mismatched = [], []
    for rel, entry in sorted(manifest['files'].items()):
        path = bundle / rel
        if not path.is_file():
            missing.append(rel)
        elif path.stat().st_size != entry['bytes'] or (deep and sha256_file(path) != entry['sha256']):
            mismatched.append(rel)
    engines = sorted(str(p.relative_to(bundle)) for p in bundle.rglob('*.trt')) if bundle.is_dir() else []
    problems = [f'missing {rel}' for rel in missing] + [f'differs from the manifest: {rel}' for rel in mismatched]
    count = len(manifest['files'])
    how = 'verified (SHA-256)' if deep else 'present with their sizes (no hashes)'
    summary = (f'{count} files {how} against MANIFEST.json' if not problems else
               f'{len(missing)} missing, {len(mismatched)} differ of {count} files in MANIFEST.json')
    return {'bundle': str(bundle), 'verified': not problems, 'summary': summary, 'deep': deep,
            'manifest_sha256': manifest_sha, 'files': count, 'bytes': sum(e['bytes'] for e in manifest['files'].values()),
            'missing': missing, 'mismatched': mismatched,
            'trt_engines': all((bundle / rel).is_file() for rel in TRT_ENGINES), 'tensorrt_engines': engines,
            'tensorrt_note': 'built for the local GPU on the first runner start; not part of the bundle',
            'problems': problems}


class HashingReader:
    def __init__(self, handle):
        self.handle, self.digest, self.bytes = handle, hashlib.sha256(), 0

    def read(self, size=-1):
        data = self.handle.read(size)
        self.digest.update(data)
        self.bytes += len(data)
        return data


def git(repo, *args):
    try:
        out = subprocess.run(['git', '-C', str(repo), *args], capture_output=True, timeout=30)
    except (OSError, subprocess.TimeoutExpired):
        return None
    return out.stdout if out.returncode == 0 else None


def core_name(manifest):
    created = str(manifest.get('created', ''))[:10].replace('-', '')
    return f"g1-deploy-bundle-core-{created if len(created) == 8 and created.isdigit() else 'undated'}.tar.gz"


def pack(deploy_root, out):
    """Write the release assets for ``deploy_root/bundle`` into ``out`` (exclusive creation) after a deep verify."""
    deploy_root, out = Path(deploy_root), Path(out)
    bundle = deploy_root / 'bundle'
    report = verify_bundle(bundle, deep=True)
    if not report['verified']:
        raise SystemExit(json.dumps({'action': 'pack', 'refused': 'the bundle does not match its manifest', **report}))
    manifest, manifest_sha = load_manifest(bundle)
    files = manifest['files']
    out.mkdir(parents=True, exist_ok=True)
    core = out / core_name(manifest)
    targets = [core, out / 'assets.json', *(out / name for rel, name in RAW.items() if rel in files)]
    if existing := [str(p) for p in targets if p.exists()]:
        raise SystemExit(f'Refusing to overwrite {existing}')
    members = sorted(rel for rel in files if rel not in RAW)
    with open(core, 'xb') as raw, gzip.GzipFile(filename='', mode='wb', fileobj=raw, mtime=0, compresslevel=6) as gz, \
            tarfile.open(fileobj=gz, mode='w', format=tarfile.PAX_FORMAT) as tar:
        for rel in members + ['MANIFEST.json']:
            path = bundle / rel
            info = tarfile.TarInfo(PREFIX + rel)
            info.size, info.mtime, info.mode, info.type = path.stat().st_size, 0, 0o644, tarfile.REGTYPE
            info.uid = info.gid = 0
            info.uname = info.gname = ''
            with open(path, 'rb') as handle:
                reader = HashingReader(handle)
                tar.addfile(info, reader)
            expected = manifest_sha if rel == 'MANIFEST.json' else files[rel]['sha256']
            if reader.digest.hexdigest() != expected:
                raise SystemExit(f'{rel} changed while it was packed')
    assets = [{'name': core.name, 'kind': 'tar.gz', 'sha256': sha256_file(core), 'bytes': core.stat().st_size,
               'members': len(members) + 1,
               'contains': f'every bundle file except {", ".join(sorted(RAW))}, plus MANIFEST.json, under bundle/'}]
    for rel, name in RAW.items():
        if rel not in files:
            continue
        target = out / name
        with open(bundle / rel, 'rb') as src, open(target, 'xb') as dst:
            reader = HashingReader(src)
            shutil.copyfileobj(reader, dst, CHUNK)
        if reader.digest.hexdigest() != files[rel]['sha256']:
            raise SystemExit(f'{rel} changed while it was copied')
        assets.append({'name': name, 'kind': 'file', 'path': rel, 'sha256': files[rel]['sha256'],
                       'bytes': files[rel]['bytes'], 'contains': f'bundle/{rel}'})
    head = git(deploy_root, 'rev-parse', 'HEAD')
    tracked = git(deploy_root, 'show', 'HEAD:bundle/MANIFEST.json')
    summary = {'schema_version': 1, 'manifest_sha256': manifest_sha, 'files': len(files),
               'bytes': sum(e['bytes'] for e in files.values()),
               'deploy_commit': head.decode().strip() if head else None,
               'manifest_tracked_at_commit': tracked is not None and hashlib.sha256(tracked).hexdigest() == manifest_sha,
               'assets': assets}
    with open(out / 'assets.json', 'x') as handle:
        json.dump(summary, handle, indent=1)
        handle.write('\n')
    return summary


def _write_checked(stream, target, entry, bundle):
    """Stream into ``target`` through a partial file; keep it only when size and SHA-256 match the manifest."""
    target.parent.mkdir(parents=True, exist_ok=True)
    if not target.parent.resolve().is_relative_to(bundle.resolve()):
        raise ValueError(f'{target} resolves outside {bundle}')
    partial = target.with_name(target.name + '.partial')
    reader = HashingReader(stream)
    try:
        with open(partial, 'xb') as dst:
            shutil.copyfileobj(reader, dst, CHUNK)
        if reader.bytes != entry['bytes'] or reader.digest.hexdigest() != entry['sha256']:
            raise ValueError(f'{target.relative_to(bundle)} does not match the manifest')
        os.chmod(partial, 0o644)
        os.replace(partial, target)
    finally:
        if partial.exists():
            partial.unlink()


def _existing(target, entry):
    """'absent', 'identical' or 'differs' for a file the fetch would write."""
    if not os.path.lexists(target):
        return 'absent'
    if target.is_symlink() or not target.is_file():
        return 'differs'
    if target.stat().st_size == entry['bytes'] and sha256_file(target) == entry['sha256']:
        return 'identical'
    return 'differs'


def fetch(deploy_root, config, source=None, download_dir=None):
    """Install the pinned assets into ``deploy_root/bundle``; every check runs before the first byte is written."""
    deploy_root = Path(deploy_root)
    bundle = deploy_root / 'bundle'
    pin = config['bundle']
    problems = []
    try:
        manifest, manifest_sha = load_manifest(bundle)
    except (OSError, ValueError) as error:
        return {'action': 'fetch', 'verified': False, 'written': 0,
                'problems': [f'{error}: check out the deploy repo at {config["deploy_stack"]["tag"]} first']}
    if manifest_sha != pin['manifest_sha256']:
        return {'action': 'fetch', 'verified': False, 'written': 0,
                'problems': [f'{bundle}/MANIFEST.json is {manifest_sha[:12]}…, the pin is {pin["manifest_sha256"][:12]}…: '
                             f'the checkout is not at {config["deploy_stack"]["tag"]}']}
    files = manifest['files']
    # Before any download: a file that exists with other bytes is refused, and a complete bundle needs nothing.
    present = {rel: _existing(bundle / rel, entry) for rel, entry in files.items()}
    differing = sorted(rel for rel, state in present.items() if state == 'differs')
    if differing:
        return {'action': 'fetch', 'verified': False, 'written': 0, 'differing': differing,
                'problems': [f'{bundle / rel} exists and differs from the manifest; move it away first' for rel in differing]}
    if all(state == 'identical' for state in present.values()):
        report = verify_bundle(bundle, deep=False)  # every file was just hashed by _existing
        report.update(deep=True, summary=f"{len(files)} files verified (SHA-256) against MANIFEST.json; nothing to download")
        return {'action': 'fetch', 'source': 'nothing to download: every file already matches the manifest', 'written': 0,
                'identical': len(files), **report}
    with tempfile.TemporaryDirectory(prefix='g1-deploy-bundle-', dir=download_dir) as tmp:
        src = Path(source) if source else Path(tmp)
        if not source:
            stack = config['deploy_stack']
            for asset in pin['assets']:
                cmd = ['gh', 'release', 'download', pin.get('release') or stack['tag'], '-R', stack['repo'],
                       '-p', asset['name'], '-D', str(src)]
                try:
                    done = subprocess.run(cmd, capture_output=True, text=True, timeout=3600)
                except (OSError, subprocess.TimeoutExpired) as error:
                    return {'action': 'fetch', 'verified': False, 'written': 0,
                            'problems': [f'gh release download failed ({error}): install the GitHub CLI and run '
                                         '`gh auth login`, or copy the assets and use --from DIR']}
                if done.returncode:
                    return {'action': 'fetch', 'verified': False, 'written': 0,
                            'problems': [f'gh release download {asset["name"]}: {done.stderr.strip()[-400:]}']}
        # 1. Every asset matches the pin.
        for asset in pin['assets']:
            path = src / asset['name']
            if not path.is_file():
                problems.append(f'asset {asset["name"]} not found in {src}')
            elif path.stat().st_size != asset['bytes'] or sha256_file(path) != asset['sha256']:
                problems.append(f'asset {asset["name"]} does not match config/deploy.json')
        # 2. Every member is a plain file the manifest lists, and nothing it would write exists with other bytes.
        plan, seen = [], set()
        for asset in pin['assets'] if not problems else []:
            path = src / asset['name']
            if asset['kind'] == 'file':
                rel = safe_rel(asset.get('path'))
                if rel is None or rel not in files:
                    problems.append(f'asset {asset["name"]}: path {asset.get("path")!r} is not in the manifest')
                elif rel in seen:
                    problems.append(f'asset {asset["name"]}: {rel} is already in another asset')
                else:
                    seen.add(rel)
                    plan.append((asset, rel, None))
                continue
            if asset['kind'] != 'tar.gz':
                problems.append(f'asset {asset["name"]}: unknown kind {asset["kind"]!r}')
                continue
            with tarfile.open(path, 'r:gz') as tar:
                for member in tar.getmembers():
                    rel = safe_rel(member.name[len(PREFIX):]) if member.name.startswith(PREFIX) else None
                    if not member.isreg():
                        problems.append(f'{asset["name"]}: {member.name!r} is not a regular file')
                    elif rel is None:
                        problems.append(f'{asset["name"]}: unsafe member {member.name!r}')
                    elif rel == 'MANIFEST.json':
                        data = tar.extractfile(member).read()
                        if hashlib.sha256(data).hexdigest() != manifest_sha:
                            problems.append(f'{asset["name"]}: its MANIFEST.json differs from the checkout')
                    elif rel not in files:
                        problems.append(f'{asset["name"]}: {member.name!r} is not in the manifest')
                    elif rel in seen:
                        problems.append(f'{asset["name"]}: {member.name!r} appears twice')
                    else:
                        seen.add(rel)
                        plan.append((asset, rel, member.name))
        states = {rel: present[rel] for _, rel, _ in plan}
        if problems:
            return {'action': 'fetch', 'verified': False, 'written': 0, 'problems': problems}
        # 3. Write what is absent; skip what is already identical.
        written = identical = 0
        try:
            for asset in pin['assets']:
                path = src / asset['name']
                todo = [(rel, name) for a, rel, name in plan if a is asset and states[rel] == 'absent']
                identical += sum(1 for a, rel, _ in plan if a is asset and states[rel] == 'identical')
                if asset['kind'] == 'file':
                    for rel, _ in todo:
                        with open(path, 'rb') as stream:
                            _write_checked(stream, bundle / rel, files[rel], bundle)
                        written += 1
                    continue
                with tarfile.open(path, 'r:gz') as tar:
                    for rel, name in todo:
                        _write_checked(tar.extractfile(tar.getmember(name)), bundle / rel, files[rel], bundle)
                        written += 1
        except (OSError, ValueError) as error:
            problems.append(str(error))
    report = verify_bundle(bundle, deep=True)
    return {'action': 'fetch', 'source': str(source) if source else f"release {pin.get('release')} of {config['deploy_stack']['repo']}",
            'written': written, 'identical': identical, **report, 'problems': problems + report['problems'],
            'verified': report['verified'] and not problems}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='action', required=True)
    for name in ('pack', 'fetch', 'verify'):
        p = sub.add_parser(name)
        p.add_argument('--deploy-root', type=Path, default=None, help='the g1-student-deploy checkout (default: studio.paths)')
        if name == 'pack':
            p.add_argument('--out', type=Path, required=True, help='directory for the assets (outside Git)')
        if name == 'fetch':
            p.add_argument('--from', dest='source', type=Path, default=None, help='assets already on this machine')
            p.add_argument('--config', type=Path, default=CONFIG)
            p.add_argument('--download-dir', type=Path, default=None, help='where the temporary download goes')
        if name == 'verify':
            p.add_argument('--quick', action='store_true', help='sizes only, no SHA-256')
    args = ap.parse_args(argv)
    deploy_root = args.deploy_root or default_deploy_root()
    # Every action ends with ONE line of JSON (tools/doctor.py reads the last stdout line that starts with '{').
    if args.action == 'pack':
        result = pack(deploy_root, args.out)
        print(json.dumps({'action': 'pack', 'out': str(args.out), **result}))
        return 0
    if args.action == 'verify':
        result = {'action': 'verify', **verify_bundle(deploy_root / 'bundle', deep=not args.quick)}
    else:
        try:
            config = json.loads(args.config.read_text())
        except (OSError, ValueError) as error:
            config, result = None, {'action': 'fetch', 'verified': False, 'written': 0, 'files': 0, 'error': str(error),
                                    'problems': [f'{args.config}: {error}']}
        if config is not None:
            result = fetch(deploy_root, config, args.source, args.download_dir)
        tail = result.get('summary') if result['verified'] else (result['problems'] or ['not verified'])[0]
        result['summary'] = f"wrote {result.get('written', 0)} files, {result.get('identical', 0)} already identical; {tail}"
        result.setdefault('files', 0)
    print(json.dumps(result))
    return 0 if result['verified'] else 1


if __name__ == '__main__':
    sys.exit(main())
