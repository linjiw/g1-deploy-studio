"""tools/deploy_bundle.py: pack, fetch --from and verify on a synthetic deploy root (no network, no real bundle)."""
import contextlib
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import shutil
import tarfile
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('deploy_bundle', Path(__file__).resolve().parents[1] / 'tools/deploy_bundle.py')
assert spec is not None and spec.loader is not None
db = importlib.util.module_from_spec(spec)
spec.loader.exec_module(db)

FILES = {
    'config/student.json': b'{"student": "fixture"}\n',
    'flow/artifacts/student/model.pt': bytes(range(256)) * 64,
    'sonic/sonic_release_g1.onnx': b'onnx-policy' * 100,
    'sonic/planner/V2/planner_sonic.onnx': b'onnx-planner' * 300,
}


def sha(data):
    return hashlib.sha256(data).hexdigest()


def make_root(base, files=FILES, manifest_only=False):
    """A deploy root with bundle/MANIFEST.json (as the deploy repo tracks it) and, unless manifest_only, the files."""
    bundle = Path(base) / 'bundle'
    bundle.mkdir(parents=True)
    manifest = {'kind': 'g1_student_deploy_bundle', 'created': '2026-10-08T05:27:31+00:00',
                'files': {rel: {'sha256': sha(data), 'bytes': len(data)} for rel, data in files.items()}}
    (bundle / 'MANIFEST.json').write_text(json.dumps(manifest, indent=1))
    if not manifest_only:
        for rel, data in files.items():
            (bundle / rel).parent.mkdir(parents=True, exist_ok=True)
            (bundle / rel).write_bytes(data)
    return Path(base)


def config_from(summary):
    return {'deploy_stack': {'repo': 'example/deploy', 'tag': 'deploy-test'},
            'bundle': {'release': 'deploy-test', 'manifest_sha256': summary['manifest_sha256'], 'assets': summary['assets']}}


class DeployBundleTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.base = Path(tmp.name)
        self.src = make_root(self.base / 'src')
        self.out = self.base / 'assets'
        self.summary = db.pack(self.src, self.out)
        self.config = config_from(self.summary)

    def fresh(self, name='dst'):
        root = self.base / name
        (root / 'bundle').mkdir(parents=True)
        shutil.copy(self.src / 'bundle/MANIFEST.json', root / 'bundle/MANIFEST.json')
        return root

    def test_pack_writes_core_archive_raw_planner_and_summary(self):
        names = [a['name'] for a in self.summary['assets']]
        self.assertEqual(names, ['g1-deploy-bundle-core-20261008.tar.gz', 'planner_sonic.onnx'])
        self.assertEqual(json.loads((self.out / 'assets.json').read_text())['assets'], self.summary['assets'])
        with tarfile.open(self.out / names[0], 'r:gz') as tar:
            members = tar.getmembers()
        self.assertEqual([m.name for m in members], ['bundle/config/student.json', 'bundle/flow/artifacts/student/model.pt',
                                                     'bundle/sonic/sonic_release_g1.onnx', 'bundle/MANIFEST.json'])
        self.assertTrue(all(m.mtime == 0 and m.uid == 0 and m.gid == 0 and m.uname == '' and m.mode == 0o644 for m in members))
        self.assertEqual(self.summary['files'], 4)
        self.assertIsNone(self.summary['deploy_commit'])  # not a git checkout

    def test_pack_is_deterministic(self):
        again = db.pack(self.src, self.base / 'assets2')
        self.assertEqual([a['sha256'] for a in again['assets']], [a['sha256'] for a in self.summary['assets']])

    def test_pack_refuses_a_bundle_that_differs_from_its_manifest_and_never_overwrites(self):
        with self.assertRaises(SystemExit):
            db.pack(self.src, self.out)  # assets exist
        (self.src / 'bundle/sonic/sonic_release_g1.onnx').write_bytes(b'changed')
        with self.assertRaises(SystemExit):
            db.pack(self.src, self.base / 'other')
        self.assertFalse((self.base / 'other' / 'assets.json').exists())

    def test_fetch_from_assets_into_a_fresh_checkout_then_rerun_is_a_no_op(self):
        dst = self.fresh()
        result = db.fetch(dst, self.config, source=self.out)
        self.assertTrue(result['verified'], result['problems'])
        self.assertEqual((result['written'], result['identical']), (4, 0))
        for rel, data in FILES.items():
            self.assertEqual((dst / 'bundle' / rel).read_bytes(), data)
        self.assertEqual(list((dst / 'bundle').rglob('*.partial')), [])
        again = db.fetch(dst, self.config, source=self.out)
        self.assertTrue(again['verified'])
        self.assertEqual((again['written'], again['identical']), (0, 4))

    def test_tampered_asset_is_refused_and_nothing_is_written(self):
        tampered = self.base / 'tampered'
        shutil.copytree(self.out, tampered)
        data = bytearray((tampered / 'planner_sonic.onnx').read_bytes())
        data[0] ^= 1
        (tampered / 'planner_sonic.onnx').write_bytes(bytes(data))
        dst = self.fresh()
        result = db.fetch(dst, self.config, source=tampered)
        self.assertFalse(result['verified'])
        self.assertIn('does not match config/deploy.json', ' '.join(result['problems']))
        self.assertEqual(sorted(p.name for p in (dst / 'bundle').rglob('*') if p.is_file()), ['MANIFEST.json'])

    def test_tampered_extracted_file_is_reported_by_verify(self):
        dst = self.fresh()
        self.assertTrue(db.fetch(dst, self.config, source=self.out)['verified'])
        target = dst / 'bundle/flow/artifacts/student/model.pt'
        data = bytearray(target.read_bytes())
        data[10] ^= 1
        target.write_bytes(bytes(data))
        report = db.verify_bundle(dst / 'bundle')
        self.assertFalse(report['verified'])
        self.assertEqual(report['mismatched'], ['flow/artifacts/student/model.pt'])
        self.assertTrue(db.verify_bundle(dst / 'bundle', deep=False)['verified'], 'same size: only the hash sees it')
        (dst / 'bundle/sonic/sonic_release_g1.onnx').unlink()
        self.assertEqual(db.verify_bundle(dst / 'bundle')['missing'], ['sonic/sonic_release_g1.onnx'])

    def test_unsafe_members_are_refused(self):
        def archive(name, info_fn):
            buf = io.BytesIO()
            with tarfile.open(fileobj=buf, mode='w:gz') as tar:
                info_fn(tar)
            path = self.base / name
            path.write_bytes(buf.getvalue())
            return {'name': name, 'kind': 'tar.gz', 'sha256': sha(buf.getvalue()), 'bytes': len(buf.getvalue())}

        def regular(member, data=b'x'):
            def add(tar):
                info = tarfile.TarInfo(member)
                info.size = len(data)
                tar.addfile(info, io.BytesIO(data))
            return add

        def link(tar):
            info = tarfile.TarInfo('bundle/config/student.json')
            info.type, info.linkname = tarfile.SYMTYPE, '/etc/passwd'
            tar.addfile(info)

        cases = {'dotdot.tar.gz': regular('bundle/../escape.txt'), 'absolute.tar.gz': regular('/tmp/escape.txt'),
                 'outside.tar.gz': regular('escape.txt'), 'unlisted.tar.gz': regular('bundle/unlisted.bin'),
                 'link.tar.gz': link}
        for name, fn in cases.items():
            with self.subTest(name):
                asset = archive(name, fn)
                config = {**self.config, 'bundle': {**self.config['bundle'], 'assets': [asset]}}
                dst = self.fresh(f'dst-{name}')
                result = db.fetch(dst, config, source=self.base)
                self.assertFalse(result['verified'])
                self.assertEqual(result['written'], 0)
                self.assertFalse((self.base / 'escape.txt').exists())
                self.assertFalse((dst / 'escape.txt').exists())
                self.assertFalse((dst / 'bundle/config/student.json').exists())

    def test_existing_file_that_differs_is_refused_before_anything_is_written(self):
        dst = self.fresh()
        (dst / 'bundle/config').mkdir()
        (dst / 'bundle/config/student.json').write_bytes(b'local edit')
        result = db.fetch(dst, self.config, source=self.out)
        self.assertFalse(result['verified'])
        self.assertIn('exists and differs', ' '.join(result['problems']))
        self.assertEqual((dst / 'bundle/config/student.json').read_bytes(), b'local edit')
        self.assertFalse((dst / 'bundle/sonic').exists())

    def test_no_download_when_refused_or_already_complete(self):
        """A differing file is refused, and a complete bundle is accepted, before gh downloads 0.87 GB."""
        from unittest import mock
        calls = []
        with mock.patch.object(db.subprocess, 'run', side_effect=lambda *a, **k: calls.append(a) or (_ for _ in ()).throw(AssertionError('downloaded'))):
            complete = db.fetch(self.src, self.config)
            self.assertTrue(complete['verified'], complete['problems'])
            self.assertEqual((complete['written'], complete['identical']), (0, 4))
            self.assertIn('nothing to download', complete['summary'])
            dst = self.fresh('refused')
            (dst / 'bundle/config').mkdir()
            (dst / 'bundle/config/student.json').write_bytes(b'local edit')
            refused = db.fetch(dst, self.config)
            self.assertFalse(refused['verified'])
            self.assertEqual(refused['differing'], ['config/student.json'])
        self.assertEqual(calls, [])

    def test_checkout_at_another_commit_is_refused(self):
        dst = self.base / 'other-commit'
        make_root(dst, files={**FILES, 'config/student.json': b'{"student": "other"}\n'}, manifest_only=True)
        result = db.fetch(dst, self.config, source=self.out)
        self.assertFalse(result['verified'])
        self.assertIn('not at deploy-test', result['problems'][0])
        missing = db.fetch(self.base / 'no-checkout', self.config, source=self.out)
        self.assertIn('check out the deploy repo', missing['problems'][0])

    def test_cli_verify_exit_status(self):
        dst = self.fresh()
        config = self.base / 'deploy.json'
        config.write_text(json.dumps(self.config))
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(db.main(['verify', '--deploy-root', str(dst), '--quick']), 1)
            self.assertEqual(db.main(['fetch', '--deploy-root', str(dst), '--from', str(self.out), '--config', str(config)]), 0)
            self.assertEqual(db.main(['verify', '--deploy-root', str(dst)]), 0)
        lines = printed.getvalue().splitlines()
        self.assertEqual(len(lines), 3, 'one JSON line per action (tools/doctor.py reads the last one)')
        first, fetched, last = (json.loads(line) for line in lines)
        self.assertEqual((first['verified'], first['trt_engines'], first['files']), (False, False, 4))
        self.assertIn('4 missing', first['summary'])
        self.assertTrue(fetched['summary'].startswith('wrote 4 files, 0 already identical; 4 files verified'))
        self.assertEqual((last['verified'], last['problems'], last['summary']),
                         (True, [], '4 files verified (SHA-256) against MANIFEST.json'))
        for rel in db.TRT_ENGINES:
            (dst / 'bundle' / rel).write_bytes(b'engine')
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(db.main(['verify', '--deploy-root', str(dst), '--quick']), 0)
        self.assertTrue(json.loads(printed.getvalue().splitlines()[-1])['trt_engines'])
        with contextlib.redirect_stdout(io.StringIO()) as printed:
            self.assertEqual(db.main(['verify', '--deploy-root', str(self.base / 'absent')]), 1)
        broken = json.loads(printed.getvalue().splitlines()[-1])
        self.assertTrue(broken['error'] and broken['summary'] and broken['problems'] and broken['files'] == 0)


class PinnedConfigTests(unittest.TestCase):
    """config/deploy.json is what a new machine fetches: well formed, and in step with the packer's asset layout."""

    def test_pin_is_well_formed(self):
        config = json.loads((Path(db.ROOT) / 'config/deploy.json').read_text())
        hexes = lambda value: isinstance(value, str) and len(value) == 64 and all(c in '0123456789abcdef' for c in value)
        stack, bundle = config['deploy_stack'], config['bundle']
        self.assertEqual(stack['visibility'], 'private')
        self.assertEqual(len(stack['commit']), 40)
        self.assertEqual(bundle['release'], stack['tag'])
        self.assertTrue(hexes(bundle['manifest_sha256']))
        kinds = {a['name']: a['kind'] for a in bundle['assets']}
        self.assertEqual(sorted(kinds.values()), ['file', 'tar.gz'])
        for asset in bundle['assets']:
            self.assertTrue(hexes(asset['sha256']) and asset['bytes'] > 0, asset['name'])
            if asset['kind'] == 'file':
                self.assertEqual(db.RAW.get(asset['path']), asset['name'])
        self.assertNotIn('token', json.dumps(config).lower())


if __name__ == '__main__':
    unittest.main()
