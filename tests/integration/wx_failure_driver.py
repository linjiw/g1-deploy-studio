"""Inject a physics failure at tick N into a short WX-RF episode (deploy interpreter only).

    PYTHONPATH=<studio> <g1-student-deploy>/.venv/bin/python tests/integration/wx_failure_driver.py OUT N
"""
import json
import sys
from pathlib import Path

sys.dont_write_bytecode = True
out, fail_at = Path(sys.argv[1]), int(sys.argv[2])
sys.path.insert(0, '/home/linjiw/code/g1-student-deploy')
import sim.episode as episode  # noqa: E402  (same module object the worker will use)

original = episode.Physics.step
calls = {'n': 0}


def failing_step(self, *args, **kwargs):
    calls['n'] += 1
    if calls['n'] > fail_at:
        raise FloatingPointError(f'injected test failure at tick {fail_at}')
    return original(self, *args, **kwargs)


episode.Physics.step = failing_step
from studio import flow_policy_worker  # noqa: E402

request = {'schema_version': 1, 'id': 'wx-injected-failure', 'goal_xy': [2.0, 0.0], 'start_xy': [0, 0], 'start_yaw_rad': 0,
           'duration_s': 2, 'seed': 0, 'planner': {'candidates': 2, 'ode_steps': 2}, 'criterion': 'arrive_hold',
           'policy': {'id': 'flow-wx-rf-23326aa-s0', 'loader': 'flow-callback', 'bundle_id': 'flow-wx-rf-23326aa-s0'},
           'map': {'id': 'flat', 'label': 'Flat', 'kind': 'boxes', 'frame_id': 'world', 'boxes': []}}
try:
    flow_policy_worker.execute(request, out)
    print(json.dumps({'raised': None}))
except BaseException as error:
    print(json.dumps({'raised': f'{type(error).__name__}: {error}'}))
