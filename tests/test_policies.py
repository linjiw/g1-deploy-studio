"""Policy profile catalog, research-adoption parsing and pinned bundle verification.

Everything runs on synthetic files in temporary directories. Git is replaced by
test doubles; no reference checkout, checkpoint or Flow tracker is read.
"""
import hashlib
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch

from studio import policies
from studio import policy_bundle as pb

ADOPTED_HEADING = '## 1. Current best (adopted): WX, adopted 2026-10-16 16:13 (commit 4ba73cb) (`research/ROUND_WX_PLAN.md`)'


def sha(data):
    return hashlib.sha256(data).hexdigest()


def unknown_git(root, max_age_s=5.0):
    return {'path': str(root), 'head': None, 'branch': None, 'dirty': None}


class CacheIsolation(unittest.TestCase):
    """Module-level identity caches are restored so tests cannot leak entries."""

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.base = Path(self.tmp.name)
        saved_hash, saved_git = dict(policies._hash_cache), dict(policies._git_cache)

        def restore():
            policies._hash_cache.clear()
            policies._hash_cache.update(saved_hash)
            policies._git_cache.clear()
            policies._git_cache.update(saved_git)
        self.addCleanup(restore)


def write_bundle(policy_root, bundle_id='flow-wx-rf-abcdef0-s0', *, block='WX'):
    """A self-consistent synthetic bundle whose external files live in a temp dir."""
    root = Path(policy_root) / bundle_id
    (root / 'src/motion2scene_flow/closed_loop').mkdir(parents=True)
    (root / 'src/motion2scene_flow/__init__.py').write_text('VERSION = 1\n')
    (root / 'src/motion2scene_flow/closed_loop/planner.py').write_text('def plan():\n    return 0\n')
    config = json.dumps({'arms': [{'name': 'wx-rf'}], 'planner_defaults': {}}).encode()
    (root / 'config.json').write_bytes(config)
    external = Path(policy_root).parent / 'external' / bundle_id

    def entry(name, data, role):
        path = external / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return {'path': str(path), 'bytes': len(data), 'sha256': sha(data), 'role': role}
    manifest = {
        'schema_version': 1, 'id': bundle_id, 'label': f'Synthetic {block}-RF', 'research_block': block,
        'variant': 'wx-rf',
        'flow': {'repo': '/nonexistent/flow', 'commit': 'abcdef0123456789abcdef0123456789abcdef01',
                 'adopted_commit': 'abcdef0', 'pin_basis': 'synthetic test pin', 'config_path': 'configs/wx.json',
                 'config_sha256': sha(config), 'arm': 'wx-rf'},
        'src_files': pb.tree_hashes(root / 'src'),
        'artifacts': [entry('teacher-run/model.pt', b'teacher-weights', 'flow teacher checkpoint'),
                      entry('wm/ensemble.pt', b'world-model', 'execution check')]
                     + [entry(f'flow/{rel}', b'{"synthetic": true}', 'planner geometry/reference artifact')
                        for rel in pb.ARTIFACT_LINKS],
        'humanoid_lfh': {'path': '/nonexistent/humanoid_lfh', 'files': [entry('lfh/bridge.py', b'bridge = 1', 'bridge')]},
        'deploy': {'newton': 'synthetic', 'files': [entry('deploy/sonic.onnx', b'onnx-bytes', 'tracker')]},
        'deployed_budget': {'candidates': 16, 'ode_steps': 10},
        'caveats': ['Synthetic test bundle; not a policy.']}
    for rel in pb.ARTIFACT_LINKS:
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).symlink_to(external / f'flow/{rel}')
    (root / 'manifest.json').write_text(json.dumps(manifest))
    return root, manifest


class ResearchStatusTests(CacheIsolation):
    def write(self, text):
        path = self.base / 'BEST_MODEL.md'
        path.write_text(text)
        return path

    def test_adopted_heading_is_parsed(self):
        update = '**Last update.** 2026-10-19 18:40 EDT ' + 'x' * 400
        text = f'# Flow tracker\n\n{update}\n\n{ADOPTED_HEADING}\n\nBody that is never interpreted.\n'
        status = policies.flow_research_status(self.write(text))
        self.assertTrue(status['available'])
        self.assertIsNone(status['reason'])
        self.assertEqual((status['adopted_block'], status['adopted_at'], status['adopted_commit']),
                         ('WX', '2026-10-16 16:13', '4ba73cb'))
        self.assertEqual(status['source_sha256'], sha(text.encode()))
        self.assertEqual(len(status['last_update']), 240)
        self.assertTrue(status['last_update'].startswith('2026-10-19 18:40 EDT'))
        self.assertIn('not deployment qualification', status['basis'])

    def test_heading_variants(self):
        cases = {'## 1. Current best (adopted): WX+RF_2, adopted 2026-10-16 (commit 4ba73cb)': ('WX+RF_2', '2026-10-16'),
                 '## 1. Current best (adopted):GAS-v1, adopted 2026-10-20 08:00:01 (commit 0123456789abcdef)': ('GAS-v1', '2026-10-20 08:00:01'),
                 # The tracker's style since 2026-10-20: a description and a plan reference, no commit.
                 '## 1. Current best (adopted): WXD = WX + DP2 keys, adopted 2026-10-20 19:45 (`research/ROUND_DP2_PLAN.md`)': ('WXD', '2026-10-20 19:45')}
        for heading, (block, when) in cases.items():
            with self.subTest(heading=heading):
                status = policies.flow_research_status(self.write(f'intro\n{heading}\n'))
                self.assertEqual((status['adopted_block'], status['adopted_at']), (block, when))

    def test_missing_or_unrecognized_heading_is_unavailable_with_reason(self):
        for text in ('# Tracker\nNo adoption yet.\n',
                     '   ' + ADOPTED_HEADING + '\n',  # indented: not a heading
                     ADOPTED_HEADING.replace('## 1.', '## 2.') + '\n',
                     ADOPTED_HEADING.replace('(commit 4ba73cb)', '(commit XYZ)') + '\n'):
            with self.subTest(text=text[:40]):
                status = policies.flow_research_status(self.write(text))
                self.assertFalse(status['available'])
                self.assertEqual(status['reason'], 'Adopted-block heading not found')
                self.assertIsNone(status['adopted_block'])
                self.assertIsNone(status['adopted_commit'])

    def test_unreadable_or_oversized_tracker_fails_soft(self):
        missing = policies.flow_research_status(self.base / 'absent.md')
        self.assertFalse(missing['available'])
        self.assertTrue(missing['reason'].startswith('FileNotFoundError'))
        self.assertNotIn('adopted_block', missing)
        huge = self.base / 'huge.md'
        with huge.open('wb') as handle:
            handle.truncate(2 * 1024 * 1024 + 1)
        status = policies.flow_research_status(huge)
        self.assertFalse(status['available'])
        self.assertIn('exceeds the bounded read', status['reason'])


class IdentityTests(CacheIsolation):
    def test_file_identity_hashes_and_caches_by_size_and_mtime(self):
        path = self.base / 'checkpoint.pt'
        path.write_bytes(b'weights v1')
        first = policies.file_identity(path)
        self.assertEqual(first, {'path': str(path), 'available': True, 'sha256': sha(b'weights v1'), 'bytes': 10})
        with patch('studio.policies.hashlib.sha256', side_effect=AssertionError('cached file was re-hashed')):
            second = policies.file_identity(path)
        self.assertEqual(second, first)
        second['sha256'] = 'tampered'
        self.assertEqual(policies.file_identity(path)['sha256'], sha(b'weights v1'), 'Callers receive copies')
        path.write_bytes(b'weights v2 (longer)')
        self.assertEqual(policies.file_identity(path)['sha256'], sha(b'weights v2 (longer)'))

    def test_missing_file_identity_is_explicitly_unavailable(self):
        self.assertEqual(policies.file_identity(self.base / 'absent.pt'),
                         {'path': str(self.base / 'absent.pt'), 'available': False, 'sha256': None, 'bytes': None})

    def test_git_identity_fails_soft_when_git_is_unavailable(self):
        root = self.base / 'checkout'
        for error in (FileNotFoundError('git'), subprocess.CalledProcessError(128, ['git']),
                      subprocess.TimeoutExpired(['git'], 3)):
            with self.subTest(error=type(error).__name__):
                policies._git_cache.pop(str(root), None)
                with patch('studio.policies.subprocess.run', side_effect=error):
                    self.assertEqual(policies.git_identity(root),
                                     {'path': str(root), 'head': None, 'branch': None, 'dirty': None})

    def test_git_identity_reads_head_branch_dirty_and_caches(self):
        root = self.base / 'checkout'
        answers = {'rev-parse': 'a' * 40, 'branch': 'main', 'status': ' M g1deploy/bundle.py'}
        run = Mock(side_effect=lambda args, **kw: Mock(stdout=answers[args[4]] + '\n'))
        with patch('studio.policies.subprocess.run', run):
            self.assertEqual(policies.git_identity(root),
                             {'path': str(root), 'head': 'a' * 40, 'branch': 'main', 'dirty': True})
            calls = run.call_count
            self.assertEqual(policies.git_identity(root)['head'], 'a' * 40)
            self.assertEqual(run.call_count, calls, 'Fresh cache entry must not rerun git')
            answers['status'] = ''
            self.assertFalse(policies.git_identity(root, max_age_s=0)['dirty'])
            self.assertGreater(run.call_count, calls)
        for args, kwargs in (c.args + (c.kwargs,) for c in run.call_args_list):
            # --no-optional-locks: a read-only reference checkout's index is never rewritten.
            self.assertEqual(args[:4], ['git', '--no-optional-locks', '-C', str(root)])
            self.assertEqual(kwargs['timeout'], 3)


class CatalogTests(CacheIsolation):
    def setUp(self):
        super().setUp()
        self.artifact = self.base / 'model.pt'
        self.artifact.write_bytes(b'model')
        patcher = patch.object(policies, 'git_identity', unknown_git)
        patcher.start()
        self.addCleanup(patcher.stop)

    def profile(self, profile_id, block, **extra):
        return {'id': profile_id, 'label': profile_id, 'research_block': block, 'loader': 'deploy-bundle',
                'artifacts': [self.artifact], 'repositories': [self.base], **extra}

    def catalog(self, builders, research):
        with patch.object(policies, 'PROFILE_BUILDERS', builders):
            return policies.catalog(research)

    def test_default_falls_back_to_bundle_without_an_available_adopted_profile(self):
        builders = [lambda: self.profile('flow-bundle-20261008', None),
                    lambda: [self.profile('flow-wx-rf-abcdef0-s0', 'WX', available=False)]]
        self.assertEqual(self.catalog(builders, {'available': True, 'adopted_block': 'WX'})['default_policy_id'], 'flow-bundle-20261008')
        self.assertEqual(self.catalog(builders[:1], {'available': False})['default_policy_id'], 'flow-bundle-20261008')

    def test_catalog_shape_and_adopted_block_matching(self):
        builders = [lambda: self.profile('flow-bundle-20261008', None),
                    lambda: [self.profile('flow-wx-rf-abcdef0-s0', 'WX'), self.profile('flow-gas-0000000-s0', 'GAS')]]
        research = {'available': True, 'adopted_block': 'WX'}
        result = self.catalog(builders, research)
        self.assertEqual(result['schema_version'], 1)
        self.assertEqual(result['default_policy_id'], 'flow-wx-rf-abcdef0-s0', 'the adopted block is preselected')
        self.assertIs(result['flow_research'], research)
        self.assertIn('not hardware qualification', result['note'])
        rows = {row['id']: row for row in result['policies']}
        self.assertEqual(list(rows), ['flow-bundle-20261008', 'flow-wx-rf-abcdef0-s0', 'flow-gas-0000000-s0'])
        self.assertEqual({k: r['matches_adopted'] for k, r in rows.items()},
                         {'flow-bundle-20261008': False, 'flow-wx-rf-abcdef0-s0': True, 'flow-gas-0000000-s0': False})
        for row in rows.values():
            self.assertNotIn('artifacts', row)
            self.assertNotIn('repositories', row)
            self.assertTrue(row['available'])
            self.assertEqual(row['missing'], [])
            identity = row['identity']
            self.assertEqual(identity['artifacts'][0]['sha256'], sha(b'model'))
            self.assertEqual(identity['repositories'][0]['head'], None)
            self.assertRegex(identity['identity_sha256'], r'^[0-9a-f]{64}$')
        none_adopted = self.catalog(builders, {'available': False, 'adopted_block': None})
        self.assertFalse(any(row['matches_adopted'] for row in none_adopted['policies']))

    def test_identity_tracks_artifact_content_and_missing_files(self):
        profile = self.profile('flow-bundle-20261008', None)
        first = policies.identity(profile)
        self.assertEqual(first, policies.identity(profile))
        self.artifact.write_bytes(b'retrained model')
        self.assertNotEqual(policies.identity(profile)['identity_sha256'], first['identity_sha256'])
        absent = self.base / 'absent.onnx'
        rows = self.catalog([lambda: self.profile('p-missing', None, artifacts=[absent]),
                             lambda: self.profile('p-flagged', None, available=False, missing=['bundle verify failed'])],
                            {'adopted_block': None})['policies']
        by_id = {row['id']: row for row in rows}
        self.assertFalse(by_id['p-missing']['available'])
        self.assertEqual(by_id['p-missing']['missing'], [str(absent)])
        self.assertFalse(by_id['p-flagged']['available'])
        self.assertEqual(by_id['p-flagged']['missing'], ['bundle verify failed'])

    def test_failing_builder_yields_unavailable_profile_instead_of_raising(self):
        def _broken_adapter():
            raise RuntimeError('adapter offline')
        builders = [lambda: self.profile('flow-bundle-20261008', None), _broken_adapter]
        with patch.object(policies, 'PROFILE_BUILDERS', builders):
            table = policies.profiles()
            self.assertEqual(set(table), {'flow-bundle-20261008', 'broken_adapter'})
            broken = table['broken_adapter']
            self.assertFalse(broken['available'])
            self.assertEqual(broken['missing'], ['RuntimeError: adapter offline'])
            rows = {row['id']: row for row in policies.catalog({'adopted_block': 'WX'})['policies']}
            self.assertFalse(rows['broken_adapter']['available'])
            self.assertTrue(rows['flow-bundle-20261008']['available'])
            with self.assertRaisesRegex(ValueError, 'Unknown policy profile'):
                policies.get_profile('flow-wx-rf-0000000-s0')

    def test_register_profile_is_idempotent(self):
        builders = []
        with patch.object(policies, 'PROFILE_BUILDERS', builders):
            def extra():
                return self.profile('extra', None)
            self.assertIs(policies.register_profile(extra), extra)
            policies.register_profile(extra)
            self.assertEqual(builders, [extra])
            self.assertEqual(list(policies.profiles()), ['extra'])


class BundleProfileTests(CacheIsolation):
    def setUp(self):
        super().setUp()
        self.policy_root = self.base / 'policies'
        self.policy_root.mkdir()
        for patcher in (patch.object(pb, 'POLICY_ROOT', self.policy_root),
                        patch.object(policies, 'DEPLOY_ROOT', self.base / 'no-deploy-checkout'),
                        patch.object(policies, 'git_identity', unknown_git),
                        patch.object(policies, 'PROFILE_BUILDERS', [policies._wx_profiles])):
            patcher.start()
            self.addCleanup(patcher.stop)

    def test_verified_bundle_becomes_flow_callback_profile(self):
        root, manifest = write_bundle(self.policy_root)
        (self.policy_root / 'not-a-bundle').mkdir()
        table = policies.profiles()
        self.assertEqual(list(table), ['flow-wx-rf-abcdef0-s0'])
        profile = table['flow-wx-rf-abcdef0-s0']
        self.assertEqual((profile['loader'], profile['bundle_id'], profile['research_block']),
                         ('flow-callback', 'flow-wx-rf-abcdef0-s0', 'WX'))
        self.assertTrue(profile['available'])
        self.assertEqual(profile['limits']['wall_s'], 480)
        self.assertEqual(profile['short_label'], 'WX-RF abcdef0')
        self.assertEqual(profile['planner']['checkpoint'], manifest['artifacts'][0]['path'])
        self.assertTrue(profile['privileged_map'])
        row = policies.catalog({'adopted_block': 'WX'})['policies'][0]
        self.assertTrue(row['available'], row['missing'])
        self.assertTrue(row['matches_adopted'])
        self.assertEqual(row['identity']['config_sha256'], manifest['flow']['config_sha256'])

    def test_bundle_with_missing_artifact_is_listed_unavailable(self):
        root, manifest = write_bundle(self.policy_root)
        Path(manifest['artifacts'][1]['path']).unlink()
        profile = policies.profiles()['flow-wx-rf-abcdef0-s0']
        self.assertFalse(profile['available'])
        self.assertEqual(profile['missing'], [f"missing {manifest['artifacts'][1]['path']}"])

    # Regression (fixed 2026-10-20): studio/policies.py:_wx_profiles only guards load_manifest(); verify() and the row
    # construction run unguarded, so one incomplete bundle directory raises out of the builder and
    # profiles() replaces *every* WX bundle with a single 'wx_profiles' unavailable placeholder.
    def test_one_malformed_bundle_does_not_hide_valid_bundles(self):
        write_bundle(self.policy_root, 'flow-wx-rf-abcdef0-s0')
        broken, manifest = write_bundle(self.policy_root, 'flow-wx-rf-1234567-s1')
        del manifest['flow']  # schema_version 1 passes load_manifest; verify() then raises KeyError
        (broken / 'manifest.json').write_text(json.dumps(manifest))
        table = policies.profiles()
        self.assertIn('flow-wx-rf-abcdef0-s0', table)
        self.assertTrue(table['flow-wx-rf-abcdef0-s0']['available'])


class BundleVerifyTests(CacheIsolation):
    def setUp(self):
        super().setUp()
        self.root, self.manifest = write_bundle(self.base / 'policies')

    def test_consistent_bundle_verifies(self):
        self.assertEqual(pb.verify(self.root), [])
        self.assertEqual(pb.verify(self.root, deep=False), [])
        self.assertEqual(pb.load_manifest(self.root)['id'], 'flow-wx-rf-abcdef0-s0')

    def test_src_tree_changes_are_reported_by_deep_verify_only(self):
        (self.root / 'src/motion2scene_flow/closed_loop/planner.py').write_text('def plan():\n    return 1\n')
        problems = pb.verify(self.root)
        self.assertEqual(len(problems), 1)
        self.assertIn('src tree differs from manifest (2 entries)', problems[0])
        self.assertEqual(pb.verify(self.root, deep=False), [])
        (self.root / 'src/motion2scene_flow/closed_loop/planner.py').write_text('def plan():\n    return 0\n')
        (self.root / 'src/motion2scene_flow/injected.py').write_text('import os\n')
        self.assertIn('(1 entries)', pb.verify(self.root)[0])

    def test_src_symlinks_are_rejected(self):
        # A symlink is not hashed, so it could smuggle unverified importable code: refuse it.
        (self.root / 'src/link.py').symlink_to(self.root / 'src/motion2scene_flow/__init__.py')
        self.assertNotIn('link.py', pb.tree_hashes(self.root / 'src'))
        problems = pb.verify(self.root)
        self.assertEqual(len(problems), 1)
        self.assertIn('symlinks are not allowed', problems[0])

    def test_unpinned_checkpoint_and_foreign_link_target(self):
        teacher = Path(self.manifest['artifacts'][0]['path'])
        (teacher.parent / 'model_extra.pt').write_bytes(b'unpinned')
        self.assertTrue(any('unpinned checkpoint files' in p for p in pb.verify(self.root)))
        (teacher.parent / 'model_extra.pt').unlink()
        link = self.root / pb.ARTIFACT_LINKS[0]
        foreign = self.root.parent / 'foreign.json'
        foreign.write_text('{}')
        link.unlink(); link.symlink_to(foreign)
        self.assertTrue(any('points outside the pinned artifacts' in p for p in pb.verify(self.root)))

    def test_config_hash_mismatch(self):
        (self.root / 'config.json').write_text('{"arms": []}')
        self.assertEqual(pb.verify(self.root), ['config.json hash mismatch'])
        self.assertEqual(pb.verify(self.root, deep=False), ['config.json hash mismatch'])

    def test_missing_and_mismatched_artifacts(self):
        teacher, world_model = (Path(a['path']) for a in self.manifest['artifacts'][:2])
        bridge = Path(self.manifest['humanoid_lfh']['files'][0]['path'])
        onnx = Path(self.manifest['deploy']['files'][0]['path'])
        teacher.unlink()
        world_model.write_bytes(b'world-modeX')  # same size, different content
        bridge.write_bytes(b'bridge = 1  # edited')  # different size
        onnx.write_bytes(b'onnx-byteZ')
        deep = pb.verify(self.root)
        self.assertEqual(deep, [f'missing {teacher}', f'hash mismatch {world_model}', f'hash mismatch {bridge}',
                                f'hash mismatch {onnx}'])
        # The quick check compares presence and sizes only.
        self.assertEqual(pb.verify(self.root, deep=False), [f'missing {teacher}', f'hash mismatch {bridge}'])

    def test_missing_planner_artifact_link(self):
        (self.root / pb.ARTIFACT_LINKS[1]).unlink()
        self.assertEqual(pb.verify(self.root), [f'missing planner artifact link {pb.ARTIFACT_LINKS[1]}'])

    def test_unreadable_or_unsupported_manifest(self):
        manifest = self.root / 'manifest.json'
        manifest.write_text(json.dumps(dict(self.manifest, schema_version=2)))
        self.assertEqual(len(pb.verify(self.root)), 1)
        self.assertIn('manifest unavailable: Unsupported policy bundle manifest', pb.verify(self.root)[0])
        with self.assertRaisesRegex(ValueError, 'Unsupported'):
            pb.load_manifest(self.root)
        manifest.write_text('{"schema_version": 1,')
        self.assertTrue(pb.verify(self.root)[0].startswith('manifest unavailable'))
        manifest.unlink()
        self.assertTrue(pb.verify(self.root)[0].startswith('manifest unavailable'))

    # Regression (fixed 2026-10-20): studio/policy_bundle.py:verify hashes root/'config.json' without an existence check, so a
    # bundle missing config.json raises FileNotFoundError instead of returning a problem list
    # (docstring: "Mismatches ... (empty list = verified)"). _wx_profiles then fails as a whole.
    def test_missing_config_is_reported_not_raised(self):
        (self.root / 'config.json').unlink()
        problems = pb.verify(self.root, deep=False)
        self.assertTrue(any('config.json' in p for p in problems), problems)

    def test_bundle_path_accepts_only_pinned_identifiers(self):
        self.assertEqual(pb.bundle_path('flow-wx-rf-23326aa-s0', root=self.base), self.base / 'flow-wx-rf-23326aa-s0')
        self.assertEqual(pb.bundle_path('flow-wx-rf-0123456-s2'), pb.POLICY_ROOT / 'flow-wx-rf-0123456-s2')
        for bad in ('../x', 'flow-wx-rf-23326aa-s3', 'flow-wx-rf-23326AA-s0', 'flow-wx-rf-23326a-s0',
                    'flow-wx-rf-23326aa0-s0', 'flow-wx-rf-23326aa-s0/../../etc', '../flow-wx-rf-23326aa-s0',
                    'flow-wx-rf-23326aa-s0\n', ' flow-wx-rf-23326aa-s0', '', None, 23326,
                    Path('flow-wx-rf-23326aa-s0'), 'flow-bundle-20261008'):
            with self.subTest(bad=bad), self.assertRaisesRegex(ValueError, 'Unknown policy bundle id'):
                pb.bundle_path(bad, root=self.base)


if __name__ == '__main__':
    unittest.main()
