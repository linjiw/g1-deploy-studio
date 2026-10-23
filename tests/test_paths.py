"""Machine paths (studio/paths.py): environment > config/local.json > defaults, and relocation of recorded paths."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest import mock

from studio import paths

ROOT = Path(__file__).resolve().parents[1]
ENVS = [env for env, *_ in paths.ROOTS.values()] + ['G1_DEPLOY_PYTHON']


class PathsTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.local = Path(self.tmp.name, 'local.json')
        patcher = mock.patch.object(paths, 'LOCAL_CONFIG', self.local)
        patcher.start()
        self.addCleanup(patcher.stop)
        env = mock.patch.dict(os.environ, {k: '' for k in ENVS})
        env.start()
        self.addCleanup(env.stop)
        paths.local_config.cache_clear()
        self.addCleanup(paths.local_config.cache_clear)

    def write(self, data):
        self.local.write_text(json.dumps(data) if not isinstance(data, str) else data)
        paths.local_config.cache_clear()

    def test_defaults_under_home(self):
        self.assertEqual(paths.get('deploy_root'), Path.home() / 'code/g1-student-deploy')
        self.assertEqual(paths.source('deploy_root'), 'default')
        self.assertEqual(paths.deploy_python(), Path.home() / 'code/g1-student-deploy/.venv/bin/python')

    def test_local_config_then_environment(self):
        self.write({'paths': {'deploy_root': '~/elsewhere/deploy', 'data_root': '/srv/studio'}})
        self.assertEqual(paths.get('deploy_root'), Path.home() / 'elsewhere/deploy')
        self.assertEqual(paths.source('deploy_root'), 'config/local.json')
        self.assertEqual(paths.get('data_root'), Path('/srv/studio'))
        with mock.patch.dict(os.environ, {'G1_STUDENT_DEPLOY': '/opt/deploy', 'G1_DEPLOY_PYTHON': '/opt/py'}):
            self.assertEqual(paths.get('deploy_root'), Path('/opt/deploy'))
            self.assertEqual(paths.source('deploy_root'), '$G1_STUDENT_DEPLOY')
            self.assertEqual(paths.deploy_python(), Path('/opt/py'))

    def test_bad_local_config_is_refused(self):
        self.write('{not json')
        with self.assertRaises(paths.ConfigError):
            paths.get('deploy_root')
        self.write({'paths': {'deploy_rot': '/x'}})
        with self.assertRaisesRegex(paths.ConfigError, 'deploy_rot'):
            paths.get('deploy_root')
        with self.assertRaises(KeyError):
            paths.get('nowhere')

    def test_relocate_recorded_paths(self):
        self.write({'paths': {'deploy_root': '/new/deploy', 'lucid_root': '/new/lucid'}})
        self.assertEqual(paths.relocate('/home/linjiw/code/g1-student-deploy/g1deploy/node.py'), '/new/deploy/g1deploy/node.py')
        self.assertEqual(paths.relocate('/home/linjiw/code/g1-student-deploy'), '/new/deploy')
        # A sibling that only shares the prefix text is not under the root.
        self.assertEqual(paths.relocate('/home/linjiw/code/g1-student-deploy-old/x'), '/home/linjiw/code/g1-student-deploy-old/x')
        self.assertEqual(paths.relocate('~/x.json'), str(Path.home() / 'x.json'))
        tree = paths.relocate_tree({'a': ['/home/linjiw/lucid-sonic/lucid-g1-deploy/runner', 'text', 3],
                                    'b': {'path': '/home/linjiw/code/g1-student-deploy/sim'}})
        self.assertEqual(tree, {'a': ['/new/lucid/runner', 'text', 3], 'b': {'path': '/new/deploy/sim'}})

    def test_robot_profile_follows_the_deploy_root(self):
        from studio import robot_profile
        self.write({'paths': {'deploy_root': '/new/deploy'}})
        profile = robot_profile.load_profile()
        self.assertEqual(profile['source_files']['flow_contract'], '/new/deploy/g1deploy/contract.py')
        self.assertTrue(all(not str(p).startswith('/home/linjiw/code/g1-student-deploy/') for p in profile['source_files'].values()))

    def test_catalog_adds_local_sessions_and_relocates(self):
        from studio.server import Catalog
        self.write({'paths': {'deploy_root': '/new/deploy'},
                    'sessions': [{'id': 'mine', 'label': 'Mine', 'path': '~/recordings/run1'}]})
        catalog = Catalog()
        self.assertEqual(catalog.entries['mine']['path'], str(Path.home() / 'recordings/run1'))
        self.assertTrue(catalog.entries['sonic-lockstep']['path'].startswith('/new/deploy/runs/'))

    def test_module_prints_a_root_for_shell_scripts(self):
        out = subprocess.run([sys.executable, '-m', 'studio.paths', 'data_root'], cwd=ROOT, capture_output=True, text=True,
                             env=dict(os.environ, STUDIO_DATA='/tmp/studio-data-test', PYTHONPATH=str(ROOT)))
        self.assertEqual(out.returncode, 0, out.stderr)
        self.assertEqual(out.stdout.strip(), '/tmp/studio-data-test')


class NoHardcodedRootsTests(unittest.TestCase):
    def test_studio_modules_ask_paths(self):
        """Machine roots come from studio/paths.py; only that module names the recording machine's paths."""
        offenders = [str(p.relative_to(ROOT)) for p in (ROOT / 'studio').glob('*.py')
                     if p.name != 'paths.py' and '/home/linjiw' in p.read_text()]
        offenders += [str(p.relative_to(ROOT)) for p in (ROOT / 'tools').glob('*.py') if '/home/linjiw' in p.read_text()]
        offenders += [str(p.relative_to(ROOT)) for p in (ROOT / 'tests').glob('*.py')
                      if p.name != 'test_paths.py' and '/home/linjiw' in p.read_text()]
        self.assertEqual(offenders, [])


if __name__ == '__main__':
    unittest.main()
