"""tools/stand_contacts.py: the paired plan and the summary (no worker runs here)."""
import argparse
from pathlib import Path
import unittest

from tools import stand_contacts as sc


def args(**kw):
    base = dict(worlds=['narrow', 'narrow-stop'], modes=['default', 'hold_upper'], walks=4, seed0=0, profile='deploy',
                narrow_width=1.1, leg_timeout=40.0)
    return argparse.Namespace(**dict(base, **kw))


class PlanTests(unittest.TestCase):
    def test_every_walk_runs_once_per_stand_mode_with_the_same_goal_and_seed(self):
        specs = sc.plan(args())
        self.assertEqual(len(specs), 2 * 4 * 2)
        pairs = {}
        for s in specs:
            pairs.setdefault((s['world'], s['index']), []).append(s)
        for (world, _), pair in pairs.items():
            self.assertEqual([p['stand_mode'] for p in pair], ['default', 'hold_upper'])
            self.assertEqual(len({(tuple(p['goal_xy']), p['seed'], p['leg_timeout_s']) for p in pair}), 1)
            req = [p['request'] for p in pair]
            self.assertEqual([r['stand_mode'] for r in req], ['default', 'hold_upper'])
            self.assertEqual({k: v for k, v in req[0].items() if k not in ('stand_mode', 'id')},
                             {k: v for k, v in req[1].items() if k not in ('stand_mode', 'id')})
        stops = [s['leg_timeout_s'] for s in specs if s['world'] == 'narrow-stop' and s['stand_mode'] == 'default']
        self.assertEqual(stops, [2.4, 2.8, 3.2, 3.5])
        deploy = specs[0]['request']
        self.assertEqual((deploy['planner'], deploy['latency'], deploy['odometry'], deploy['map_mode']),
                         ({'candidates': 16, 'ode_steps': 10}, {'ms': 160, 'anchor': 'predict'}, 'lio', 'keep'))

    def test_narrow_world_walls_leave_the_requested_gap(self):
        boxes = sc.narrow_world(1.1)['boxes']
        inner = sorted(abs(b['center_xy'][1]) - b['half_xy'][1] for b in boxes)
        self.assertAlmostEqual(inner[0] * 2, 1.1)
        self.assertTrue(all(b['z_top'] > 1.35 for b in boxes))  # never a ceiling-deferral height


class SummaryTests(unittest.TestCase):
    def row(self, mode, index, contacts, outcome='arrived', sha='x'):
        return {'world': 'narrow', 'stand_mode': mode, 'index': index, 'goal_xy': [2, 0], 'seed': 0, 'status': 'walked',
                'outcome': outcome, 'contacts': contacts, 'fell': False, 'pre_stand_sha256': sha}

    def test_counts_by_mode_stand_and_group(self):
        arm = {'peak_n': 50.0, 'stand': True, 'first_group': 'arm'}
        leg = {'peak_n': 150.0, 'stand': False, 'first_group': 'leg'}
        rows = [self.row('default', 0, [arm, arm, leg]), self.row('hold_upper', 0, [leg]),
                self.row('default', 1, [], 'stopped'), self.row('hold_upper', 1, [], 'stopped', sha='y'),
                dict(self.row('default', 2, []), status='goal_rejected', outcome=None)]
        table = {r['stand_mode']: r for r in sc.summarize(rows)}
        self.assertEqual((table['default']['walks'], table['default']['arrived'], table['default']['goal_rejected']), (2, 1, 1))
        self.assertEqual((table['default']['stand_episodes'], table['default']['stand_by_group']['arm']), (2, 2))
        self.assertEqual((table['hold_upper']['stand_episodes'], table['hold_upper']['walking_episodes']), (0, 1))
        self.assertEqual(table['default']['walks_with_stand_contact'], 1)
        hard = {r['stand_mode']: r for r in sc.summarize(rows, 100.0)}
        self.assertEqual(hard['default']['stand_episodes'], 0)
        self.assertEqual(sc.pairing(rows), {'pairs': 2, 'identical_before_first_stand': 1})
        self.assertIn('| narrow | hold_upper |', sc.table_text(sc.summarize(rows)))

    def test_clearance_table(self):
        def c(start, stand):
            return {'arm_at_stand_start_m': start, 'stand': {'arm': stand}}
        rows = [dict(self.row('default', 0, []), clearance=c(0.30, 0.10)), dict(self.row('default', 1, []), clearance=c(0.2, 0.2)),
                dict(self.row('hold_upper', 0, []), clearance=c(0.30, 0.25)), self.row('hold_upper', 1, [])]
        text = sc.clearance_table(rows)
        self.assertIn('| narrow | default | 2 | 0.250 | 0.150 / 0.100 | 1 |', text)
        self.assertIn('| narrow | hold_upper | 1 | 0.300 | 0.250 / 0.250 | 1 |', text)


if __name__ == '__main__':
    unittest.main()
