"""Compare exported hierarchy to MuJoCo kinematics using nonzero named joints."""
import unittest
from pathlib import Path
import numpy as np
from studio.model import RobotModel


def rotation(q):
    w, x, y, z = q
    return np.array([[1-2*(y*y+z*z), 2*(x*y-z*w), 2*(x*z+y*w)],
                     [2*(x*y+z*w), 1-2*(x*x+z*z), 2*(y*z-x*w)],
                     [2*(x*z-y*w), 2*(y*z+x*w), 1-2*(x*x+y*y)]])


class ModelParityTests(unittest.TestCase):
    def test_local_models_match_mujoco(self):
        paths = [Path('/home/linjiw/code/g1-student-deploy/sim/assets/g1_29dof.xml'),
                 Path('/home/linjiw/lucid-sonic/lucid-g1-deploy/sim/models/g1/scene_43dof.xml')]
        if not all(p.exists() for p in paths):
            self.skipTest('Local integration models not installed')
        for path, nq in zip(paths, [36, 50]):
            with self.subTest(path=path):
                model = RobotModel(path, 'test')
                self.assertEqual(model.description['nq'], nq)
                q = model.mj.qpos0.copy()
                q[0:3] = [1.3, -0.7, 0.9]
                q[3:7] = [np.cos(0.21), 0, 0, np.sin(0.21)]
                q[7:] = np.linspace(-0.2, 0.3, nq - 7)
                expected = model.body_poses(q)

                def check(b, parent_p, parent_r):
                    p = np.array(b['position'])
                    r = rotation(b['quaternion_wxyz'])
                    j = b['joint']
                    if j and j['type'] == 'free':
                        p, r = q[:3], rotation(q[3:7])
                    elif j:
                        axis = np.array(j['axis'])
                        a = q[j['qpos_index']]
                        rj = rotation([np.cos(a/2), *(axis*np.sin(a/2))])
                        pivot = np.array(j['position'])
                        p = p + r @ (pivot - rj @ pivot)
                        r = r @ rj
                    p, r = parent_p + parent_r @ p, parent_r @ r
                    np.testing.assert_allclose(p, expected[b['name']]['position'], atol=1e-12)
                    np.testing.assert_allclose(r, rotation(expected[b['name']]['quaternion_wxyz']), atol=1e-12)
                    for child in b['children']:
                        check(child, p, r)

                check(model.description['root'], np.zeros(3), np.eye(3))
                self.assertTrue(all(p.is_file() for p in model.assets.values()))


if __name__ == '__main__':
    unittest.main()
