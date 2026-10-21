"""Navigation sessions: the simulated robot (studio/nav_worker.py).

Unit tests run everywhere. The opt-in integration tests run the real worker (deploy interpreter, CPU, a few minutes):

    STUDIO_INTEGRATION=1 .venv/bin/python -m unittest tests.test_nav_worker -v
"""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time
import unittest

from studio import nav_worker

ROOT = Path(__file__).resolve().parents[1]
DEPLOY_PYTHON = Path('/home/linjiw/code/g1-student-deploy/.venv/bin/python')
ENABLED = os.environ.get('STUDIO_INTEGRATION') == '1' and DEPLOY_PYTHON.is_file()
FLAT = {'id': 'flat', 'label': 'Flat', 'kind': 'boxes', 'frame_id': 'world', 'boxes': []}
PILLAR = {'id': 'pillar', 'label': 'Pillar', 'kind': 'boxes', 'frame_id': 'world',
          'boxes': [{'center_xy': [1.6, 0.0], 'half_xy': [0.2, 0.2], 'yaw': 0, 'z_bottom': 0, 'z_top': 1.0}]}


def request(**overrides):
    return dict({'schema_version': 1, 'id': 'nav-test', 'map': FLAT, 'start_xy': [0, 0], 'start_yaw_rad': 0, 'seed': 0,
                 'planner': {'candidates': 2, 'ode_steps': 4}}, **overrides)


class RequestTests(unittest.TestCase):
    def test_defaults_follow_node_rules(self):
        clean = nav_worker.validate_request(request())
        self.assertEqual(clean['goal_radius_m'], 0.4)      # node.py --goal-radius
        self.assertEqual(clean['prescan_s'], 0.5)          # node.py --prescan-s
        self.assertEqual(clean['actuators'], 'g1-current')
        self.assertEqual(clean['odometry'], 'truth')
        self.assertIsNone(clean['initial_goal'])
        self.assertEqual(clean['policy']['loader'], 'deploy-bundle')

    def test_rejects_bad_values(self):
        for bad in ({'odometry': 'gps'}, {'seed': -1}, {'goal_radius_m': 3}, {'initial_goal': [1]}, {'id': '../x'},
                    {'map': {'kind': 'scan'}}, {'planner': {'candidates': 99}}, {'latency': {'ms': 5000}}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                nav_worker.validate_request(request(**bad))

    def test_lio_noise_is_the_g4_configuration(self):
        self.assertEqual(nav_worker.ODOMETRY['lio']['noise'],
                         {'xy_rw_m': 0.01, 'yaw_rw_rad': 0.005, 'xy_white_m': 0.002, 'yaw_white_rad': 0.001})


class InboxTests(unittest.TestCase):
    def test_order_skip_and_malformed(self):
        with tempfile.TemporaryDirectory() as tmp:
            inbox = Path(tmp)
            (inbox / '000002.json').write_text(json.dumps({'seq': 2, 'cmd': 'go'}))
            (inbox / '000001.json').write_text(json.dumps({'seq': 1, 'cmd': 'goal', 'xy': [1, 0]}))
            (inbox / '000003.json').write_text('{not json')
            (inbox / '000004.json').write_text(json.dumps({'seq': 9, 'cmd': 'go'}))  # seq disagrees with the name
            (inbox / '000005.json.0a.tmp').write_text('partial')                   # an atomic write in progress
            got = nav_worker.read_inbox(inbox, 0)
            self.assertEqual([c['seq'] for c in got], [1, 2, 3, 4])
            self.assertEqual([c['cmd'] for c in got], ['goal', 'go', 'invalid', 'invalid'])
            self.assertEqual([c['seq'] for c in nav_worker.read_inbox(inbox, 2)], [3, 4])


class Session:
    """Drive a real worker process through its inbox, as the gateway does."""

    def __init__(self, output, req):
        self.output, self.seq = Path(output), 0
        path = self.output.parent / f'{self.output.name}-request.json'
        path.write_text(json.dumps(req))
        env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
        self.log = (self.output.parent / f'{self.output.name}.log').open('wb')
        self.process = subprocess.Popen([str(DEPLOY_PYTHON), '-B', str(ROOT / 'studio/nav_worker.py'), '--request', str(path),
                                         '--output', str(self.output)], stdout=self.log, stderr=subprocess.STDOUT, env=env, cwd=ROOT)

    def latest(self):
        try:
            return json.loads((self.output / 'latest.json').read_text())
        except (OSError, ValueError):
            return {}

    def wait(self, predicate, timeout=240, what='condition'):
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            latest = self.latest()
            if latest and predicate(latest):
                return latest
            if self.process.poll() is not None and not predicate(self.latest()):
                raise AssertionError(f'worker exited ({self.process.returncode}) before {what}; see {self.log.name}')
            time.sleep(0.2)
        raise AssertionError(f'timed out waiting for {what}')

    def send(self, cmd, **fields):
        self.seq += 1
        body = dict(fields, seq=self.seq, cmd=cmd)
        tmp = self.output / 'inbox' / f'{self.seq:06d}.json.tmp'
        tmp.write_text(json.dumps(body))
        tmp.replace(self.output / 'inbox' / f'{self.seq:06d}.json')
        return self.wait(lambda l: any(c['seq'] == self.seq for c in l.get('navigation', {}).get('commands', [])),
                         60, f'reply to {cmd}')['navigation']['commands']

    def reply(self, commands, seq):
        return next(c for c in commands if c['seq'] == seq)

    def close(self):
        if self.process.poll() is None:
            self.process.kill()
        self.process.wait()
        self.log.close()


@unittest.skipUnless(ENABLED, 'set STUDIO_INTEGRATION=1 (needs the deploy interpreter)')
class NavWorkerIntegrationTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)

    def standing(self, latest):
        n = latest.get('navigation', {})
        return n.get('paused') and n.get('phase') in ('WAIT', 'ARRIVED', 'STOPPED')

    def test_two_walks_with_node_rules(self):
        s = Session(Path(self.tmp.name) / 'nav', request(map=PILLAR))
        self.addCleanup(s.close)
        latest = s.wait(self.standing, what='the first stand')
        n = latest['navigation']
        self.assertEqual(n['phase'], 'WAIT')
        self.assertEqual(n['can'], {'goal': True, 'go': False, 'stand': False, 'end': True})
        self.assertIsNotNone(latest['frame'])                   # the standing pose is shown before any tick
        self.assertTrue((s.output / 'memory.npz').is_file())    # the pre-scan map is published
        # Go without a goal and a goal inside the pillar are refused; nothing moves.
        self.assertEqual(s.reply(s.send('go'), 1)['status'], 'rejected')
        self.assertEqual(s.reply(s.send('goal', xy=[1.6, 0.0]), 2)['status'], 'rejected')
        # Walk 1: straight 1.2 m, in front of the pillar.
        self.assertEqual(s.reply(s.send('goal', xy=[1.0, 0.0]), 3)['status'], 'applied')
        self.assertEqual(s.reply(s.send('go'), 4)['status'], 'applied')
        s.wait(lambda l: l['navigation']['phase'] in ('RUN', 'PRESCAN'), what='walking')
        # A new goal while walking is refused (goals are staged while standing, as on the robot).
        self.assertEqual(s.reply(s.send('goal', xy=[0.0, 1.0]), 5)['status'], 'rejected')
        latest = s.wait(lambda l: self.standing(l) and l['navigation']['legs'] and l['navigation']['legs'][-1]['outcome'],
                        what='walk 1 to end')
        walk = latest['navigation']['legs'][0]
        self.assertEqual(walk['outcome'], 'arrived', walk)
        self.assertLess(walk['final_dist_m'], 0.6)
        # Walk 2: behind the pillar; the map keeps what walk 1 saw.
        self.assertEqual(s.reply(s.send("goal", xy=[2.6, 0.4]), 6)['status'], 'applied')
        self.assertEqual(s.reply(s.send('go'), 7)['status'], 'applied')
        latest = s.wait(lambda l: self.standing(l) and len(l['navigation']['legs']) == 2 and l['navigation']['legs'][-1]['outcome'],
                        what='walk 2 to end')
        self.assertIn(latest['navigation']['legs'][1]['outcome'], ('arrived', 'stopped', 'timeout'))
        s.send('end')
        s.wait(lambda l: l.get('status') == 'completed', 60, 'completion')
        s.process.wait(30)
        session = json.loads((s.output / 'session.json').read_text())
        legs = session['metadata']['navigation']['legs']
        self.assertEqual(len(legs), 2)
        times = [f['time'] for f in session['frames']]
        self.assertEqual(times, sorted(times))
        self.assertEqual(len(set(times)), len(times))
        self.assertTrue(all(f['navigation']['goal_xy'] for f in session['frames'] if f['navigation']['walk']))
        self.assertTrue((s.output / 'memory-final.npz').is_file())
        self.assertFalse(session['metadata']['planner_configuration']['task_boxes_to_planner'])
        kinds = [e['type'] for e in session['events']]
        for kind in ('goal', 'prescan', 'run', 'replan', 'arrived', 'stand', 'waiting', 'ended'):
            self.assertIn(kind, kinds)
        # Paused waiting time is not simulated: motion time equals the recorded frames.
        self.assertAlmostEqual(session['metadata']['test_result']['motion_s'], len(session['frames']) * 0.02, places=6)

    def test_parity_with_the_source_rehearsal_until_arrival(self):
        """With a goal at t = 0, walking is the bundle worker's source run_episode, frame for frame."""
        goal, seed = [1.5, 0.3], 3
        s = Session(Path(self.tmp.name) / 'nav', request(map=PILLAR, seed=seed, initial_goal=goal))
        self.addCleanup(s.close)
        latest = s.wait(self.standing, what='arrival')
        s.send('end')
        s.wait(lambda l: l.get('status') == 'completed', 60, 'completion')
        s.process.wait(30)
        nav = json.loads((s.output / 'session.json').read_text())
        arrived = next(e['time'] for e in nav['events'] if e['type'] == 'arrived')
        req = {'schema_version': 1, 'id': 'parity', 'goal_xy': goal, 'start_xy': [0, 0], 'start_yaw_rad': 0, 'duration_s': 8,
               'seed': seed, 'planner': {'candidates': 2, 'ode_steps': 4}, 'criterion': 'arena_reach', 'actuators': 'g1-current',
               'latency': {'ms': 0, 'anchor': 'measured'}, 'map': PILLAR}
        path = Path(self.tmp.name) / 'bundle-request.json'
        path.write_text(json.dumps(req))
        env = dict(os.environ, PYTHONPATH=str(ROOT), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
        out = Path(self.tmp.name) / 'bundle'
        done = subprocess.run([str(DEPLOY_PYTHON), '-B', str(ROOT / 'studio/policy_worker.py'), '--request', str(path),
                               '--output', str(out)], capture_output=True, text=True, timeout=600, env=env, cwd=ROOT)
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        source = json.loads((out / 'session.json').read_text())
        n = int(round(arrived / 0.02))
        self.assertGreater(n, 50)
        self.assertGreaterEqual(len(source['frames']), n)
        worst = max(abs(a - b) for fa, fb in zip(nav['frames'][:n], source['frames'][:n]) for a, b in zip(fa['qpos'], fb['qpos']))
        print(f'\nparity: {n} frames until arrival at {arrived:.2f} s, worst |qpos| difference {worst:.2e}', flush=True)
        self.assertLess(worst, 1e-4, 'nav worker qpos (rounded to 1e-5) diverged from the source rehearsal before arrival')


if __name__ == '__main__':
    unittest.main()
