"""Actuator-limit profiles for the G1 29-DoF MuJoCo model.

The g1-student-deploy MJCF is the deprecated mode_machine-2 G1 (hips 88/88/88 N·m). Unitree's own
model table (unitree_ros robots/g1_description README, per mode_machine) gives the hip pitch/roll
motors per hardware revision: 7520-14.3 = 88 N·m, 7520-22.5 = 139 N·m. NVIDIA GR00T issue #174
confirms SONIC was built for the newer (black-pelvis, 7520-22) hip pitch motor; g1deploy.contract and
the Isaac training config use 139/139/88.

Studio never copies or edits the source model: a profile patches ``jnt_actfrcrange`` of the compiled
in-memory model after ``Physics`` is built (MuJoCo reads it at every step). The source XML hash plus
the patch hash identify the model that ran. The body (masses, inertias) stays the mode-2 model.
"""
from __future__ import annotations

import hashlib
import json

HIPS = ('hip_pitch', 'hip_roll', 'hip_yaw')
SOURCES = (
    'unitreerobotics/unitree_ros@5994d4faef robots/g1_description/README.md (hip gear ratio per mode_machine) '
    'and g1_29dof_rev_1_0.urdf / g1_29dof_mode_15.urdf effort attributes',
    'NVlabs/GR00T-WholeBodyControl issue #174 (2026-06-04/08): SONIC built for the newer hip pitch motor',
    'g1-student-deploy g1deploy/contract.py effort table and the SONIC/Flow Isaac config (hip pitch 139, roll 139, yaw 88)',
)

PROFILES = {
    'g1-current': {
        'label': 'Current G1 · 139/139/88 (training)',
        'hardware': 'mode_machine 10, 11, 12, 15, 16, 18 (7520-22.5 hip pitch and roll; black pelvis)',
        'description': 'Hip pitch 139, roll 139, yaw 88 N·m: the hardware SONIC and the Flow policies were trained for.',
        'hips_nm': {'hip_pitch': 139.0, 'hip_roll': 139.0, 'hip_yaw': 88.0},
    },
    'g1-rev1': {
        'label': 'G1 rev_1_0 · 88/139/88 (pessimistic)',
        'hardware': 'mode_machine 4, 5, 6, 13, 14 (7520-14.3 hip pitch, 7520-22.5 hip roll)',
        'description': 'Hip pitch 88, roll 139, yaw 88 N·m: older robots; WX commands above 88 N·m at the hip pitch would be clamped.',
        'hips_nm': {'hip_pitch': 88.0, 'hip_roll': 139.0, 'hip_yaw': 88.0},
    },
    'source': {
        'label': 'Source model · 88/88/88 (deprecated mode 2)',
        'hardware': 'mode_machine 1, 2, 3 (deprecated original G1); the unmodified g1-student-deploy MJCF',
        'description': 'Unchanged source limits. Hip roll 88 N·m matches no currently supported G1; kept as the historical baseline.',
        'hips_nm': None,
    },
}
DEFAULT_PROFILE = 'g1-current'
BODY_NOTE = ('Body masses and inertias are the deprecated mode-2 model (torso about 1.8 kg heavier than rev_1_0); '
             'only the hip actuator limits follow the profile. MuJoCo does not enforce motor velocity limits.')


def validate(profile_id):
    if profile_id is None:
        return DEFAULT_PROFILE
    if not isinstance(profile_id, str) or profile_id not in PROFILES:
        raise ValueError(f"actuators must be one of {sorted(PROFILES)}")
    return profile_id


def _joint_kind(name):
    return next((h for h in HIPS if name.endswith(f'_{h}_joint')), None)


def patch_digest(profile_id):
    body = json.dumps({'profile': profile_id, 'hips_nm': PROFILES[profile_id]['hips_nm']}, sort_keys=True).encode()
    return hashlib.sha256(body).hexdigest()


def apply(model, joint_names, profile_id):
    """Patch hip ``jnt_actfrcrange`` in place; return a receipt with the before/after limits."""
    profile_id = validate(profile_id)
    hips = PROFILES[profile_id]['hips_nm']
    changed = {}
    for name in joint_names:
        kind = _joint_kind(name)
        if kind is None:
            continue
        jid = model.joint(name).id
        lo, hi = (float(v) for v in model.jnt_actfrcrange[jid])
        if hips is not None and bool(model.jnt_actfrclimited[jid]):
            limit = hips[kind]
            model.jnt_actfrcrange[jid] = (-limit, limit)
            changed[name] = {'before_nm': hi, 'after_nm': limit}
        else:
            changed[name] = {'before_nm': hi, 'after_nm': hi}
    return {'profile': profile_id, **{k: PROFILES[profile_id][k] for k in ('label', 'hardware', 'description')},
            'hips': changed, 'patch_sha256': patch_digest(profile_id), 'body_note': BODY_NOTE, 'sources': list(SOURCES),
            'basis': 'In-memory jnt_actfrcrange patch of the compiled source model; the source MJCF is unchanged.'}


def reference_limits(joint_names, training_effort):
    """Per-joint reference ceilings for exceedance counts: training effort and each hardware profile."""
    out = {'training': [float(v) for v in training_effort]}
    for pid in ('g1-current', 'g1-rev1'):
        hips = PROFILES[pid]['hips_nm']
        out[pid] = [hips[_joint_kind(n)] if _joint_kind(n) else float(t) for n, t in zip(joint_names, training_effort)]
    return out
