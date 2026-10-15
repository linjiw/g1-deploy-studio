import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

from studio.server import Catalog
from studio.workbench import (
    DEVELOPMENT_SCENES, REFERENCE_ROOT, Workbench, development_maps, point_status,
)


class SceneCatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        self.source = self.root / 'bundle/flow/src/motion2scene_flow/closed_loop/panel.py'
        self.source.parent.mkdir(parents=True)
        # Unit fixture verifies that the adapter calls only the pure generator;
        # it is never registered as integration evidence or a production scene.
        self.source.write_text('''def layout(family, rng):
    x = float(rng.uniform(1.0, 2.0))
    return [{"center_xy": [x, 0.0], "half_xy": [0.1, 0.5], "yaw": 0.0,
             "z_bottom": 0.0, "z_top": 1.8, "velocity_xy": [0.0, 0.0]}], [4.0, 0.0]
def make_panel(*args, **kwargs):
    raise RuntimeError("Research panel entry point must never run")
if __name__ == "__main__":
    raise RuntimeError("Research CLI must never run")
''')

    def tearDown(self):
        self.temp.cleanup()

    def test_fixed_pure_generator_provenance_and_reproducibility(self):
        maps = development_maps(self.root)
        self.assertEqual([m['id'] for m in maps], [s[0] for s in DEVELOPMENT_SCENES])
        self.assertEqual(maps, development_maps(self.root))
        for scene in maps:
            self.assertEqual(scene['provenance']['sha256'], hashlib.sha256(self.source.read_bytes()).hexdigest())
            self.assertFalse(scene['provenance']['research_panel_read'])
            self.assertEqual(scene['provenance']['origin_xy'], [0, 0])
            self.assertEqual(scene['frame_id'], 'world')
            self.assertEqual(point_status(scene, scene['suggested_scenario']['start_xy'])['status'], 'configured_free')
            self.assertEqual(point_status(scene, scene['suggested_scenario']['goal_xy'])['status'], 'configured_free')
            self.assertEqual(point_status(scene, scene['boxes'][0]['center_xy'])['status'], 'blocked')
        self.assertFalse((self.source.parent / '__pycache__').exists())
        old_hash = maps[0]['provenance']['sha256']
        self.source.write_text(self.source.read_text() + '\n# a new source revision\n')
        self.assertNotEqual(old_hash, development_maps(self.root)[0]['provenance']['sha256'])

    def test_missing_source_stays_unavailable_and_motion_is_not_silently_discarded(self):
        self.assertEqual(development_maps(self.root / 'absent'), [])
        self.source.write_text(self.source.read_text().replace('"velocity_xy": [0.0, 0.0]',
                                                             '"velocity_xy": [1.0, 0.0]'))
        with self.assertRaisesRegex(ValueError, 'Moving scene obstacles'):
            development_maps(self.root)

    def test_builtin_scenes_do_not_consume_import_quota(self):
        config = self.root / 'catalog.json'
        config.write_text(json.dumps({'sessions': []}))
        with patch('studio.workbench.REFERENCE_ROOT', self.root):
            workbench = Workbench(Catalog(config), self.root / 'data')
        for i in range(31):
            workbench.maps[f'map-fixture-{i}'] = {}
        workbench.import_map({'kind': 'boxes', 'label': 'last allowed import', 'frame_id': 'world', 'boxes': []})
        with self.assertRaisesRegex(ValueError, '32 imports'):
            workbench.import_map({'kind': 'boxes', 'label': 'over quota', 'frame_id': 'world', 'boxes': []})

    @unittest.skipUnless((REFERENCE_ROOT / 'bundle/flow/src/motion2scene_flow/closed_loop/panel.py').is_file(),
                         'Local source generator unavailable')
    def test_actual_source_development_scenes_fit_navigation_contract(self):
        scenes = development_maps()
        self.assertEqual([len(scene['boxes']) for scene in scenes], [1, 3, 3])
        self.assertEqual([scene['provenance']['family'] for scene in scenes], ['detour', 'slalom', 'corridor_beam'])
        for scene in scenes:
            self.assertTrue(scene['runnable'])
            self.assertTrue(any(box['z_bottom'] == 0 and box['z_top'] > 1.5 for box in scene['boxes']))
            self.assertGreater(scene['suggested_scenario']['goal_xy'][0], 3.0)


if __name__ == '__main__':
    unittest.main()
