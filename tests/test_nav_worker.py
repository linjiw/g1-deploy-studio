"""Navigation sessions: the simulated robot (studio/nav_worker.py).

Unit tests run everywhere. The opt-in integration tests run the real worker (deploy interpreter, CPU, a few minutes):

    STUDIO_INTEGRATION=1 .venv/bin/python -m unittest tests.test_nav_worker -v
"""
import json
import os
from pathlib import Path
import subprocess
import sys
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
        self.assertEqual(clean['stand_mode'], 'default')    # node.py stand(): arms to the default pose
        self.assertEqual(nav_worker.validate_request(request(stand_mode='hold_upper'))['stand_mode'], 'hold_upper')

    def test_rejects_bad_values(self):
        for bad in ({'odometry': 'gps'}, {'seed': -1}, {'goal_radius_m': 3}, {'initial_goal': [1]}, {'id': '../x'},
                    {'map': {'kind': 'scan'}}, {'planner': {'candidates': 99}}, {'latency': {'ms': 5000}},
                    {'stand_mode': 'arms_up'}, {'stand_mode': None}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                nav_worker.validate_request(request(**bad))

    def test_bundle_label_names_the_bundle_student_not_flows_current_one(self):
        from studio import policies, policy_worker
        self.assertEqual(nav_worker.BUNDLE_LABEL, policies.BUNDLE_LABEL)
        self.assertEqual(policy_worker.BUNDLE_LABEL, policies.BUNDLE_LABEL)
        self.assertEqual(policies.BUNDLE_LABEL, "student-s2-kcsc (2026-10-08 bundle), not Flow's current student-sk1")

    def test_lio_noise_is_the_g4_configuration(self):
        self.assertEqual(nav_worker.ODOMETRY['lio']['noise'],
                         {'xy_rw_m': 0.01, 'yaw_rw_rad': 0.005, 'xy_white_m': 0.002, 'yaw_white_rad': 0.001})


class StandChunkTests(unittest.TestCase):
    """stand_mode: 'default' is node.py stand() bitwise; 'hold_upper' holds waist and arms at the measured pose."""
    # SONIC's default joint pose in MuJoCo order (g1deploy/contract.py DEFAULT_MJ, as Flow's callback copies it).
    DEFAULT = [-0.312, 0.0, 0.0, 0.669, -0.363, 0.0] * 2 + [0.0] * 3 + [0.2, 0.2, 0.0, 0.6, 0.0, 0.0, 0.0] \
        + [0.2, -0.2, 0.0, 0.6, 0.0, 0.0, 0.0]

    @staticmethod
    def reference_chunk(np, q, default_mj):
        """The nav worker's stand_plan before stand_mode existed (commit cbc7fcb), verbatim apart from the return."""
        import math
        DT, SETTLE_S, HOLD_S = 0.02, 1.0, 3.0
        q = np.asarray(q, dtype=np.float64)
        n_settle, n = int(SETTLE_S / DT), int((SETTLE_S + HOLD_S) / DT)
        a = np.clip(np.arange(1, n + 1) / n_settle, 0.0, 1.0)[:, None]
        a = a * a * (3 - 2 * a)
        frames = np.repeat(q[None], n, 0)
        frames[:, 7:] = (1 - a) * q[7:] + a * default_mj
        w, x, y, z = q[3:7]
        yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))
        rot = np.array([[math.cos(yaw), -math.sin(yaw), 0], [math.sin(yaw), math.cos(yaw), 0], [0, 0, 1]])
        return {'qpos': frames, 'rotation': np.repeat(rot[None], n, 0), 'stand': True,
                'joint_velocity': np.vstack([np.zeros((1, 29)), np.diff(frames[:, 7:], axis=0) / DT])}

    def poses(self):
        import numpy as np
        rng = np.random.default_rng(7)
        default = np.asarray(self.DEFAULT)
        for _ in range(20):
            quat = rng.normal(size=4)
            yield np.concatenate([rng.uniform(-3, 3, 2), [rng.uniform(0.6, 0.8)], quat / np.linalg.norm(quat),
                                  default + rng.normal(scale=0.4, size=29)])

    def test_default_chunk_is_bitwise_unchanged(self):
        import numpy as np
        default = np.asarray(self.DEFAULT)
        for q in self.poses():
            new, old = nav_worker.stand_chunk(np, q, default, 'default'), self.reference_chunk(np, q, default)
            self.assertEqual(sorted(new), sorted(old))
            self.assertTrue(new['stand'])
            for key in ('qpos', 'rotation', 'joint_velocity'):
                self.assertEqual(new[key].dtype, old[key].dtype)
                self.assertEqual(new[key].tobytes(), old[key].tobytes(), key)

    def test_hold_upper_holds_waist_and_arms_exactly(self):
        import numpy as np
        default = np.asarray(self.DEFAULT)
        for q in self.poses():
            held, base = nav_worker.stand_chunk(np, q, default, 'hold_upper'), nav_worker.stand_chunk(np, q, default)
            upper = 7 + nav_worker.UPPER_MJ
            self.assertEqual(held['qpos'][:, :upper].tobytes(), base['qpos'][:, :upper].tobytes())  # pelvis + legs as node.py
            self.assertTrue((held['qpos'][:, upper:] == q[upper:]).all())                          # measured pose, exactly
            self.assertTrue((held['joint_velocity'][:, nav_worker.UPPER_MJ:] == 0).all())
            self.assertEqual(held['joint_velocity'][:, :nav_worker.UPPER_MJ].tobytes(),
                             base['joint_velocity'][:, :nav_worker.UPPER_MJ].tobytes())
            self.assertEqual(held['rotation'].tobytes(), base['rotation'].tobytes())
        self.assertEqual(nav_worker.UPPER_MJ, 12)  # MuJoCo 12..28 = waist yaw/roll/pitch + both arms (contract.MJ_JOINTS)
        with self.assertRaises(ValueError):
            nav_worker.stand_chunk(np, next(self.poses()), default, 'arms_up')

    @unittest.skipUnless((DEPLOY_PYTHON.parents[2] / 'g1deploy/node.py').is_file(), 'needs the g1-student-deploy checkout')
    def test_default_chunk_matches_node_stand_source(self):
        """The default chunk is node.py stand()'s formula (read from its source; node.py is not imported here)."""
        source = (DEPLOY_PYTHON.parents[2] / 'g1deploy/node.py').read_text()
        body = source[source.index('    def stand(self, now_tick, reason, settle_s=1.0, hold_s=3.0):'):]
        body = body[:body.index('    # -- main loop')]
        for line in ('n_settle, n = int(settle_s / DT), int((settle_s + hold_s) / DT)',
                     'a = np.clip(np.arange(1, n + 1) / n_settle, 0.0, 1.0)[:, None]', 'a = a * a * (3 - 2 * a)',
                     'frames = np.repeat(q[None], n, 0)', 'frames[:, 7:] = (1 - a) * q[7:] + a * C.DEFAULT_MJ',
                     'yaw = math.atan2(2 * (w * z + x * y), 1 - 2 * (y * y + z * z))',
                     '"joint_velocity": np.vstack([np.zeros((1, 29)), np.diff(frames[:, 7:], axis=0) / DT])}'):
            self.assertIn(line, body)
        self.assertEqual((nav_worker.SETTLE_S, nav_worker.HOLD_S), (1.0, 3.0))


class ContactAttributionTests(unittest.TestCase):
    def test_body_groups(self):
        cases = {('left_wrist_yaw_link', 'left_rubber_hand'): 'arm', ('right_elbow_link', ''): 'arm',
                 ('left_shoulder_yaw_link', ''): 'arm', ('right_knee_link', ''): 'leg', ('left_ankle_roll_link', ''): 'leg',
                 ('left_hip_pitch_link', ''): 'leg', ('torso_link', 'head_link'): 'head', ('torso_link', 'logo_link'): 'torso',
                 ('torso_link', 'waist_support_link'): 'torso', ('pelvis', 'pelvis_contour_link'): 'torso'}
        for (body, mesh), group in cases.items():
            self.assertEqual(nav_worker.body_group(body, mesh), group, (body, mesh))

    def test_summary_splits_stand_time_by_first_group(self):
        eps = [{'peak_n': 40.0, 'stand': True, 'first_group': 'arm'}, {'peak_n': 300.0, 'stand': True, 'first_group': 'arm'},
               {'peak_n': 5.0, 'stand': False, 'first_group': 'leg'}, {'peak_n': 150.0, 'stand': True, 'first_group': 'head'}]
        s = nav_worker.summarize_contacts(eps)
        self.assertEqual(s['episodes'], 4)
        self.assertEqual(s['stand']['episodes'], 3)
        self.assertEqual(s['stand']['by_group'], {'arm': 2, 'leg': 0, 'torso': 0, 'head': 1})
        self.assertEqual(s['walking']['by_group']['leg'], 1)
        self.assertEqual(s['peak_n'], 300.0)
        hard = nav_worker.summarize_contacts(eps, 100.0)
        self.assertEqual((hard['stand']['episodes'], hard['walking']['episodes']), (2, 0))


NODE_PY = DEPLOY_PYTHON.parents[2] / 'g1deploy/node.py'


class NodeLatencyTests(unittest.TestCase):
    """Opt-in latency mode 'node' (node.py's rule); the fixed model stays the default and is validated as before."""

    def test_fixed_model_is_the_default_and_unchanged(self):
        from studio.policy_worker import validate_latency
        for value in (None, {}, {'ms': 160, 'anchor': 'predict'}, {'ms': 170, 'anchor': 'measured'}, {'ms': 0, 'anchor': 'predict'}):
            with self.subTest(value=value):
                self.assertEqual(nav_worker.validate_nav_latency(value), validate_latency(value))
        self.assertEqual(nav_worker.validate_request(request())['latency'], {'ms': 0, 'anchor': 'measured'})

    def test_node_presets_and_custom(self):
        clean = nav_worker.validate_nav_latency({'mode': 'node'})
        self.assertEqual(clean, {'mode': 'node', 'preset': 'bundle-fused', 'guess_s': 0.3,
                                 'distribution': {'kind': 'lognormal', 'p50_s': 0.119, 'p95_s': 0.167}})
        sk1 = nav_worker.validate_nav_latency({'mode': 'node', 'preset': 'flow-sk1'})['distribution']
        self.assertEqual(sk1, {'kind': 'pools', 'first_s': 0.19, 'retry_s': 0.09, 'fallback_s': 1.10})
        custom = nav_worker.validate_nav_latency({'mode': 'node', 'distribution': {'kind': 'fixed', 's': 0.25}, 'guess_s': 0.2})
        self.assertEqual((custom['preset'], custom['distribution'], custom['guess_s']), ('custom', {'kind': 'fixed', 's': 0.25}, 0.2))
        for bad in ({'mode': 'node', 'preset': 'fastest'}, {'mode': 'node', 'distribution': {'kind': 'gamma'}},
                    {'mode': 'node', 'distribution': {'kind': 'lognormal', 'p50_s': 0.2, 'p95_s': 0.1}},
                    {'mode': 'node', 'preset': 'flow-sk1', 'distribution': {'kind': 'fixed', 's': 0.1}},
                    {'mode': 'node', 'guess_s': -1}, {'mode': 'node', 'ms': 160}, {'mode': 'node', 'guess_s': True}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                nav_worker.validate_nav_latency(bad)
        self.assertEqual(nav_worker.validate_request(request(latency={'mode': 'node', 'preset': 'flow-wx'}))['latency']['preset'],
                         'flow-wx')

    def test_node_rules(self):
        import numpy as np
        self.assertEqual(nav_worker.node_lead_ticks(0.3), 16)      # node.py from its 0.3 s first guess: ceil(15.0) + 1
        self.assertEqual(nav_worker.node_lead_ticks(0.119), 7)
        self.assertEqual(nav_worker.node_lead_ticks(1.10), 56)     # after a 1.1 s fallback: longer than a 50-frame plan
        lat = [0.1] * 9 + [1.1]
        self.assertAlmostEqual(nav_worker.node_latency_estimate(np, lat), float(np.quantile(lat[-8:], 0.9)))
        self.assertEqual(nav_worker.node_latency_estimate(np, [0.2]), 0.2)
        self.assertEqual(nav_worker.landing_tick(100, 0.0), 101)   # never in the request's own tick
        self.assertEqual(nav_worker.landing_tick(100, 0.12), 106)
        self.assertEqual(nav_worker.landing_tick(100, 0.121), 107)
        self.assertEqual(nav_worker.landing_tick(100, 1.10), 155)

    def test_latency_draws(self):
        import numpy as np

        class Planner:
            last_pools = [(None, None, 'go')]
        dist = nav_worker.validate_nav_latency({'mode': 'node', 'preset': 'flow-sk1'})['distribution']
        draw = nav_worker.LatencyDraw(np, dist, 0)
        self.assertEqual(draw(Planner, {}), (0.19, 'first pool'))
        Planner.last_pools = [(None, None, 'go'), (None, None, 'go'), (None, None, 'stop')]
        self.assertEqual(draw(Planner, {'exec_check': {'tries': 3}}), (1.10 + 0.09, 'fallback pools + check retry'))
        logn = nav_worker.validate_nav_latency({'mode': 'node'})['distribution']
        a, b = nav_worker.LatencyDraw(np, logn, 5), nav_worker.LatencyDraw(np, logn, 5)
        xs = [a(Planner, {})[0] for _ in range(4000)]
        self.assertEqual(xs[:20], [b(Planner, {})[0] for _ in range(20)])   # seeded, its own stream
        self.assertAlmostEqual(float(np.median(xs)), 0.119, delta=0.004)
        self.assertAlmostEqual(float(np.quantile(xs, 0.95)), 0.167, delta=0.008)

    @unittest.skipUnless(NODE_PY.is_file(), 'needs the g1-student-deploy checkout')
    def test_copied_rules_match_node_source(self):
        """The rules nav_worker copies from node.py, checked against its source text."""
        source = NODE_PY.read_text()
        for line in ('lead = 0 if first else int(math.ceil(self.latency_est / DT)) + 1',
                     'hist = self.history if lead == 0 else predicted_history(self.history, self.active, now_tick, lead, len(self.history))',
                     'self.latency_est = float(np.quantile(self.latencies[-8:], 0.9))',
                     'first = self.active is None',
                     'anchor_tick = now_tick  # computed while standing still: start it when it lands',
                     'if reason or anchor_tick <= self.last_streamed_anchor:',
                     'start = max(anchor_tick, now_tick - 2)',
                     'self.last_streamed_anchor = now_tick + 10**6',
                     'plan = planner.plan(np.asarray(hist), [], goal_fn, map_fn, sel, prev=None, guide_boxes=guide)',
                     'ap.add_argument("--latency-guess-s", type=float, default=0.3)',
                     'ap.add_argument("--inflight", type=int, default=1,'):
            self.assertIn(line, source)
        self.assertEqual((nav_worker.NODE_LATENCY_GUESS_S, nav_worker.NODE_LATENCY_WINDOW, nav_worker.NODE_LATENCY_QUANTILE),
                         (0.3, 8, 0.9))

    @unittest.skipUnless(NODE_PY.is_file(), 'needs the g1-student-deploy checkout')
    def test_node_sane_and_defaults_are_imported_from_node(self):
        """nav_worker calls node.py's own sane() and parse() defaults; run them here in a separate interpreter."""
        code = (
            'import sys, json; sys.path.insert(0, sys.argv[1]); import numpy as np\n'
            'from types import SimpleNamespace\n'
            'from g1deploy import node\n'
            'a = node.parse(["--goal", "0", "0"]); s = SimpleNamespace(args=a)\n'
            'q = np.zeros((50, 36)); q[:, 2] = 0.75; q[:, 0] = np.linspace(0, 1.0, 50)\n'
            'ok = {"qpos": q, "joint_velocity": np.zeros((50, 29))}\n'
            'low = dict(ok, qpos=np.where(np.arange(36) == 2, 0.3, q))\n'
            'fast = dict(ok, qpos=np.where(np.arange(36) == 0, np.linspace(0, 3.0, 50)[:, None], q))\n'
            'nan = dict(ok, joint_velocity=np.full((50, 29), np.nan))\n'
            'print(json.dumps({"defaults": [a.latency_guess_s, a.min_pelvis_z, a.max_speed, a.max_joint_vel, a.inflight],'
            ' "sane": [node.StudentNode.sane(s, p) for p in (ok, low, fast, nan)]}))\n')
        done = subprocess.run([sys.executable, '-I', '-c', code, str(NODE_PY.parents[1])], capture_output=True, text=True,
                              timeout=60, cwd=tempfile.gettempdir())
        self.assertEqual(done.returncode, 0, done.stderr[-2000:])
        got = json.loads(done.stdout)
        self.assertEqual(got['defaults'], [nav_worker.NODE_LATENCY_GUESS_S, nav_worker.MIN_PELVIS_Z_M, 2.5, 30.0, 1])
        self.assertIsNone(got['sane'][0])
        self.assertTrue(got['sane'][1].startswith('pelvis_z'))
        self.assertTrue(got['sane'][2].startswith('mean speed'))
        self.assertEqual(got['sane'][3], 'nonfinite')


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

    def __init__(self, output, req, root=ROOT):
        self.output, self.seq = Path(output), 0
        path = self.output.parent / f'{self.output.name}-request.json'
        path.write_text(json.dumps(req))
        env = dict(os.environ, PYTHONPATH=str(root), CUDA_VISIBLE_DEVICES='', OMP_NUM_THREADS='2', PYTHONDONTWRITEBYTECODE='1')
        self.log = (self.output.parent / f'{self.output.name}.log').open('wb')
        self.process = subprocess.Popen([str(DEPLOY_PYTHON), '-B', str(Path(root) / 'studio/nav_worker.py'), '--request', str(path),
                                         '--output', str(self.output)], stdout=self.log, stderr=subprocess.STDOUT, env=env, cwd=root)

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
        self.assertEqual(n['can'], {'goal': True, 'go': False, 'stand': False, 'takeover': False, 'end': True})
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

    def test_end_never_waits_on_a_deferred_stand(self):
        """Review H5: Stand next to a 1.0 m pillar (its top edge reads as a low ceiling) defers the stand; End must still
        end promptly with a complete recording, and the session limits hold in every moving phase."""
        pillar = {'id': 'tall-pillar', 'label': 'Tall pillar', 'kind': 'boxes', 'frame_id': 'world',
                  'boxes': [{'center_xy': [1.6, 0.0], 'half_xy': [0.25, 0.25], 'yaw': 0, 'z_bottom': 0, 'z_top': 1.0}]}
        s = Session(Path(self.tmp.name) / 'nav', request(map=pillar))
        self.addCleanup(s.close)
        s.wait(self.standing, what='the first stand')
        self.assertEqual(s.reply(s.send('goal', xy=[3.3, 0.6]), 1)['status'], 'applied')
        s.send('go')
        s.wait(lambda l: (l['frame'] or {}).get('position', [0])[0] > 1.25, 120, 'beside the pillar')
        s.send('stand')
        try:
            s.wait(lambda l: l['navigation'].get('pending_stand'), 5, 'the deferral')
            deferred = True
        except AssertionError:
            deferred = False
        started = time.monotonic()
        s.send('end')
        s.wait(lambda l: l.get('status') == 'completed', 90, 'completion after End')
        self.assertLess(time.monotonic() - started, 90)
        s.process.wait(30)
        session = json.loads((s.output / 'session.json').read_text())
        kinds = [e['type'] for e in session['events']]
        self.assertIn('ended', kinds)
        self.assertLess(session['metadata']['test_result']['motion_s'], 60)
        print(f'\nend-during-stand: stand deferred={deferred}; events {sorted(set(kinds))}', flush=True)
        self.assertTrue(deferred, 'the scenario no longer defers the stand; move the stand closer to the pillar')
        self.assertIn('stand_deferred', kinds)

    def test_sigterm_keeps_the_recording(self):
        s = Session(Path(self.tmp.name) / 'nav', request(map=PILLAR))
        self.addCleanup(s.close)
        s.wait(self.standing, what='the first stand')
        s.send('goal', xy=[1.0, 0.0])
        s.send('go')
        s.wait(lambda l: l['navigation']['phase'] == 'RUN', 60, 'walking')
        s.process.terminate()
        s.process.wait(60)
        result = json.loads((s.output / 'result.json').read_text())
        self.assertEqual(result['status'], 'completed')
        session = json.loads((s.output / 'session.json').read_text())
        self.assertIn('terminated', [e['type'] for e in session['events']])
        self.assertGreater(len(session['frames']), 1)

    def walk_and_end(self, session):
        session.wait(self.standing, what='arrival')
        session.send('end')
        session.wait(lambda l: l.get('status') == 'completed', 90, 'completion')
        session.process.wait(30)
        return json.loads((session.output / 'session.json').read_text())

    def test_fixed_latency_is_bitwise_the_pre_change_worker(self):
        """The default (fixed 160 ms predictive) latency and the default stand run exactly as the worker before
        stand_mode and the node latency mode existed (commit cbc7fcb, archived from Git)."""
        base = Path(self.tmp.name) / 'base'
        base.mkdir()
        archive = subprocess.run(['git', '-C', str(ROOT), 'archive', 'cbc7fcb', 'studio'], capture_output=True, check=True).stdout
        subprocess.run(['tar', '-x', '-C', str(base)], input=archive, check=True)
        req = request(map=PILLAR, seed=2, initial_goal=[1.5, 0.3], latency={'ms': 160, 'anchor': 'predict'})
        sessions = [Session(Path(self.tmp.name) / 'old', req, root=base)]
        self.addCleanup(sessions[0].close)
        old = self.walk_and_end(sessions[0])
        sessions.append(Session(Path(self.tmp.name) / 'new', req))
        self.addCleanup(sessions[1].close)
        new = self.walk_and_end(sessions[1])
        self.assertEqual(len(new['frames']), len(old['frames']))
        self.assertEqual([f['qpos'] for f in new['frames']], [f['qpos'] for f in old['frames']])
        self.assertEqual([f['command']['joints'] for f in new['frames']], [f['command']['joints'] for f in old['frames']])
        self.assertEqual([(p['tick'], p['rule'], p['plan_xy']) for p in new['plans']], [(p['tick'], p['rule'], p['plan_xy']) for p in old['plans']])
        self.assertEqual(new['metadata']['latency_model']['executing_plan_starts'], old['metadata']['latency_model']['executing_plan_starts'])
        self.assertEqual(new['metadata']['node_rules']['stand_mode'], 'default')
        print(f"\nfixed-latency parity: {len(new['frames'])} frames, {len(new['plans'])} plans bitwise equal to cbc7fcb", flush=True)

    def test_node_latency_mode(self):
        """node.py's rule: lead from the q90 of the last 8 latencies, landing after the drawn latency, late plans part-played."""
        req = request(map=PILLAR, seed=1, latency={'mode': 'node', 'preset': 'flow-sk1'})
        s = Session(Path(self.tmp.name) / 'nav', req)
        self.addCleanup(s.close)
        s.wait(self.standing, what='the first stand')
        self.assertEqual(s.reply(s.send('goal', xy=[2.6, 0.4]), 1)['status'], 'applied')
        s.send('go')
        session = self.walk_and_end(s)
        meta, plans = session['metadata'], session['plans']
        self.assertEqual((meta['latency_model']['mode'], meta['fidelity']), ('node', 'L2'))
        self.assertGreater(len(plans), 3)
        self.assertEqual(plans[0]['lead_ticks'], 0)                     # no plan yet: lead 0, started when it lands
        self.assertEqual(plans[0]['anchor_tick'], plans[0]['landed_tick'])
        import numpy as np
        lat, est = [], 0.3
        for p in plans:
            if p is not plans[0]:
                self.assertEqual(p['lead_ticks'], nav_worker.node_lead_ticks(est))
            self.assertIn(p['latency_s'], (0.19, 1.10))
            self.assertEqual(p['land_tick'], nav_worker.landing_tick(p['tick'], p['latency_s']))
            if 'landed_tick' in p:
                lat.append(p['latency_s'])
                est = nav_worker.node_latency_estimate(np, lat)
        starts = {index: tick for tick, index in meta['latency_model']['executing_plan_starts']}
        for i, p in enumerate(plans):
            if i in starts:
                self.assertEqual(starts[i], max(p['anchor_tick'], p['landed_tick']))
        print(f"\nnode mode: {meta['test_result']['node_latency']}", flush=True)

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
