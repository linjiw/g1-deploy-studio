// Deployment inspector tabs. Values are rendered with their evidence class;
// unavailable fields are collapsed with reasons rather than shown as zeros.
import { $, escape, num, vector, clock, fact, notice, tiny, chip, finite, hasPose, outcomeChip } from './util.js';
import { renderPipeline, pipelineHealthLink } from '../pipeline.js';
import { renderSystemMap, systemDetails, KIND_LABEL, sessionKind } from './system.js';

const LIMBS = [['Left leg', /left_(hip|knee|ankle)/], ['Right leg', /right_(hip|knee|ankle)/], ['Waist', /waist/],
  ['Left arm', /left_(shoulder|elbow|wrist)/], ['Right arm', /right_(shoulder|elbow|wrist)/]];

export const inspector = { tab: 'intent', joint: 0, jointsSession: null, lastRender: 0, lastKey: null, robot: null, systemNode: 'flow' };

export function sampleHealth(state) {
  const f = state.frame, m = state.measuredFrame ?? f;
  if (!f) return {};
  const age = hasPose(m) ? Math.max(0, state.time - m.time) * 1000 : null;
  const referenceAge = finite(f.health?.reference_age_ms) ? f.health.reference_age_ms + Math.max(0, state.time - f.time) * 1000 : null;
  const stale = finite(age) && age > 100;
  let tracking = f.health?.tracking_rmse_rad;
  if (stale) tracking = null;
  else if (state.frozenFrame && f.reference) tracking = Math.sqrt(m.joints.reduce((s, v, i) => s + (v - f.reference.joints[i]) ** 2, 0) / m.joints.length);
  return { ...f.health, state_age_ms: age, reference_age_ms: referenceAge, tracking_rmse_rad: tracking, state_stale: stale };
}

const isLockstep = state => ['sonic-mujoco-lockstep'].includes(state.session?.metadata?.recording_kind);

function card(title, body, { evidence = null, cls = '', id = '' } = {}) {
  return `<section class="card ${cls}" ${id ? `id="${id}"` : ''}><header><h4>${escape(title)}</h4>${evidence ? chip(evidence) : ''}</header>${body}</section>`;
}
function unavailableList(rows) {
  if (!rows.length) return '';
  return `<details class="unavailable-list"><summary>Not captured in this source (${rows.length})</summary>${rows.map(([name, reason]) => `<div class="fact"><span>${escape(name)}</span><strong class="unavailable" title="${escape(reason)}">${escape(reason)}</strong></div>`).join('')}</details>`;
}

// ---------------------------------------------------------------- Intent
function renderIntent(state) {
  const f = state.frame, r = f.reference, p = f.plan, m = state.measuredFrame, h = sampleHealth(state);
  const meta = state.session.metadata, wire = meta.recording_kind === 'recorded-wire-transport';
  const goal = meta.goal_xy, crit = meta.navigation_criteria;
  const dist = goal && hasPose(m) ? Math.hypot(m.position[0] - goal[0], m.position[1] - goal[1]) : null;
  const windowRows = r?.window ?? [];
  const nav = goal ? card('Navigation target', `${fact('Goal · world XY', `[${vector(goal, 2)}] m`)}${fact('Distance now', num(dist, 3, 'm'), dist !== null && crit && dist <= crit.goal_radius_m ? 'value-good' : '')}
      ${crit ? tiny(`Success needs ≤ ${num(crit.goal_radius_m, 2, 'm')} and speed ≤ ${num(crit.goal_speed_m_s, 2, 'm/s')} held ${num(crit.goal_hold_s, 2, 's')}. Collision > ${num(crit.obstacle_contact_threshold_n, 0, 'N')}.`) : ''}`, { evidence: 'configured' }) : '';
  const plan = card('Planner selection', p ? `${fact('Selection rule', p.rule ?? 'Unavailable', 'value-amber')}${fact('Plan age at cursor', num(p.age_s, 3, 's'))}${fact('Waypoint · world', p.waypoint ? `[${vector(p.waypoint, 2)}] m` : 'Unavailable')}
      ${fact(isLockstep(state) ? 'CPU compute · physics paused' : 'Compute latency', num(p.latency_ms, 1, 'ms'))}
      ${p.exec_check ? `<div class="fact"><span>Execution check ${chip('estimated', 'WM-v2 predicted SONIC execution, trained on Isaac; accuracy under MuJoCo is unmeasured.')}</span><strong class="${p.exec_check.ok ? 'value-good' : 'value-amber'}">${p.exec_check.ok ? 'pass' : 'fail'} · clearance ${num(p.exec_check.clearance_m * 100, 1, 'cm')} · tilt ${num(p.exec_check.tilt_rad, 2, 'rad')} · ${escape(p.exec_check.tries ?? '—')} tr${p.exec_check.tries === 1 ? 'y' : 'ies'}</strong></div>` : ''}
      ${p.tight !== undefined && p.tight !== null ? fact('Planner level', p.tight ? `tight / narrow passage · corridor ${num(p.corridor_m, 2, 'm')}` : 'nominal') : ''}${isLockstep(state) ? tiny('Lockstep pauses simulated time while planning, so this latency does not delay the plan in simulation. On the robot a replan has ~160 ms.') : ''}`
      : notice('No planner selection recorded at this cursor.', 'neutral'), { evidence: 'commanded' });
  const ref = card(wire ? 'Observed pose reference' : 'SONIC reference window', r ? `${fact('Shape', `${r.shape?.join(' × ') ?? '—'} floats`)}${fact('Horizon', `${windowRows.length} rows · ${num(windowRows.at(-1)?.offset_s, 1, 's')}`)}
      <div class="window-bars">${windowRows.slice(0, 15).map(w => `<span title="offset ${num(w.offset_s, 3, 's')}">${num(w.offset_s, 1)}</span>`).join('')}</div>
      ${tiny(wire ? 'Decoded wire reference. World-root pose was not in the packet; no ghost is rendered.' : 'Cyan ghost: reference now. Amber ghosts: +0.4 s and +0.9 s. Root path is a planner diagnostic (columns 64–66), not SONIC input.')}
      <details class="raw-details"><summary>Inspect actual reference values</summary><pre>${escape(JSON.stringify(wire ? r.raw_fields : { offset_s: windowRows[0]?.offset_s, joint_names: state.session.joint_names, values: r.raw?.[0] }, null, 1))}</pre></details>`
      : notice('No reference payload at this cursor. Reference joints and tracking error stay unavailable.', 'warning'), { evidence: wire ? 'measured' : 'commanded' });
  const exec = card('Observed execution', `${state.frozenFrame ? notice(`Diagnostic: state held at ${clock(m.time)} while the cursor advances.`, 'warning') : ''}${fact('Root · world', hasPose(m) ? `[${vector(m.position, 2)}] m` : 'Unavailable')}
      ${fact('Heading', hasPose(m) ? num(Math.atan2(2 * (m.quaternion_wxyz[0] * m.quaternion_wxyz[3] + m.quaternion_wxyz[1] * m.quaternion_wxyz[2]), 1 - 2 * (m.quaternion_wxyz[2] ** 2 + m.quaternion_wxyz[3] ** 2)), 3, 'rad') : 'Unavailable')}
      ${fact('Joint reference RMSE', num(h.tracking_rmse_rad, 3, 'rad'))}${fact('PD target RMSE', num(h.command_tracking_rmse_rad, 3, 'rad'))}`, { evidence: hasPose(m) ? (meta.mode === 'simulation' || isLockstep(state) ? 'sim-truth' : 'recorded') : 'unavailable' });
  $('intent-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">${wire ? 'REFERENCE PUBLISHER → COLLECTOR' : 'PLANNER → SONIC'}</span><h3>What comes next</h3></div>${nav}${plan}${ref}${exec}`;
}

// ---------------------------------------------------------------- Joints
function buildJoints(state) {
  const names = state.session.joint_names ?? [];
  const groups = LIMBS.map(([label, re]) => [label, names.map((n, i) => [n, i]).filter(([n]) => re.test(n))]);
  const hasCommand = state.session.frames.some(f => f.command?.joints);
  $('joints-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">NAMED JOINTS · MUJOCO ORDER</span><h3>Planned vs executed</h3><p>Radians. Error = state − reference.${hasCommand ? ' PD target is the recorded simulated command.' : ''}</p></div>
    <div class="joint-chart-head"><select id="joint-select" class="joint-select" aria-label="Joint to inspect">${names.map((n, i) => `<option value="${i}">${escape(n)}</option>`).join('')}</select><div class="chart-legend"><span class="lg-state">State</span><span class="lg-ref">Reference</span>${hasCommand ? '<span class="lg-cmd">PD target</span>' : ''}</div></div>
    <div id="joint-chart"></div>
    <table class="joint-table" data-testid="joint-table"><thead><tr><th>Joint</th><th>State</th><th>Ref</th><th>Error</th>${hasCommand ? '<th>Target</th>' : ''}</tr></thead>
    ${groups.map(([label, rows]) => `<tbody><tr class="limb-row"><th colspan="${hasCommand ? 5 : 4}">${escape(label)}</th></tr>${rows.map(([n, i]) => `<tr data-joint="${i}"><td title="${escape(n)}">${escape(n.replace('_joint', '').replace(/^(left|right)_/, ''))}</td><td data-c="s"></td><td data-c="r"></td><td data-c="e"></td>${hasCommand ? '<td data-c="t"></td>' : ''}</tr>`).join('')}</tbody>`).join('')}</table>
    ${hasCommand ? tiny('PD targets come from the owned CPU worker: simulated commands, not DDS LowCmd packets.') : tiny('Motor commands and gains were not captured in this recording.')}`;
  $('joint-select').value = String(inspector.joint);
  $('joint-select').addEventListener('change', e => { inspector.joint = Number(e.target.value); drawJointChart(state); });
  $('joints-content').querySelectorAll('tr[data-joint]').forEach(row => row.addEventListener('click', () => {
    inspector.joint = Number(row.dataset.joint); $('joint-select').value = row.dataset.joint; drawJointChart(state);
    $('joints-content').querySelectorAll('tr[data-joint]').forEach(r => r.classList.toggle('selected', r === row));
  }));
  inspector.jointsSession = state.session;
  inspector.jointCells = [...$('joints-content').querySelectorAll('tr[data-joint]')].map(row => ({
    i: Number(row.dataset.joint), row, s: row.querySelector('[data-c=s]'), r: row.querySelector('[data-c=r]'), e: row.querySelector('[data-c=e]'), t: row.querySelector('[data-c=t]') }));
  drawJointChart(state, true);
}

function drawJointChart(state, rebuild = true) {
  const host = $('joint-chart'); if (!host) return;
  const frames = state.session.frames, duration = state.session.metadata.duration_s || 1, i = inspector.joint;
  if (rebuild || !host.firstChild) {
    const step = Math.max(1, Math.ceil(frames.length / 500));
    const sample = frames.filter((_, k) => k % step === 0);
    const series = [['state', f => f.joints?.[i]], ['ref', f => f.reference?.joints?.[i]], ['cmd', f => f.command?.joints?.[i]]];
    const values = sample.flatMap(f => series.map(([, g]) => g(f))).filter(finite);
    if (!values.length) { host.innerHTML = tiny('No values recorded for this joint.'); return; }
    let min = Math.min(...values), max = Math.max(...values); const pad = Math.max(0.02, (max - min) * 0.12); min -= pad; max += pad;
    const pts = g => sample.filter(f => finite(g(f))).map(f => `${(30 + f.time / duration * 262).toFixed(1)},${(84 - (g(f) - min) / (max - min) * 72).toFixed(1)}`).join(' ');
    host.innerHTML = `<svg class="sparkline" viewBox="0 0 300 96" role="img" aria-label="Joint ${escape(state.session.joint_names[i])} over the session"><text x="2" y="14">${max.toFixed(2)}</text><text x="2" y="86">${min.toFixed(2)}</text><line x1="30" x2="292" y1="84" y2="84" class="axis"/>
      ${series.map(([k, g]) => `<polyline class="ln-${k}" points="${pts(g)}"/>`).join('')}<line id="joint-cursor" x1="0" x2="0" y1="8" y2="88" class="cursor"/></svg>`;
  }
  const cursor = $('joint-cursor');
  if (cursor) { const x = 30 + state.time / duration * 262; cursor.setAttribute('x1', x); cursor.setAttribute('x2', x); }
}

function updateJoints(state) {
  if (inspector.jointsSession !== state.session || !$('joint-select')) buildJoints(state);
  const f = state.frame, m = state.measuredFrame, h = sampleHealth(state);
  for (const c of inspector.jointCells) {
    const s = m?.joints?.[c.i], r = f.reference?.joints?.[c.i], t = f.command?.joints?.[c.i];
    c.s.textContent = finite(s) ? s.toFixed(3) : '—';
    c.r.textContent = finite(r) ? r.toFixed(3) : '—';
    const err = finite(s) && finite(r) && !h.state_stale ? s - r : null;
    c.e.textContent = finite(err) ? err.toFixed(3) : '—';
    c.e.className = finite(err) && Math.abs(err) > 0.15 ? 'value-bad' : finite(err) && Math.abs(err) > 0.06 ? 'value-amber' : '';
    if (c.t) c.t.textContent = finite(t) ? t.toFixed(3) : '—';
    c.row.classList.toggle('selected', c.i === inspector.joint);
  }
  drawJointChart(state, false);
}

// ---------------------------------------------------------------- Health
// Fidelity ladder (review §7.1): what a run proves and what it hides.
export function fidelity(meta = {}) {
  const latency = meta.latency_model?.ms;
  if (meta.recording_kind === 'sonic-mujoco-lockstep' && latency > 0) return { level: meta.fidelity ?? 'L2', label: `${meta.fidelity === 'L2-approx' ? 'L2≈' : 'L2'} · lockstep with ${latency} ms planner latency`,
    proves: `Planner/tracker logic plus the effect of plans arriving ${latency} ms after they are requested (${meta.latency_model.anchor} anchor).`,
    hides: `DDS/ZMQ transport, C++/TensorRT numerics, real sensors${meta.fidelity === 'L2-approx' ? '; the Flow callback still anchors replans on its latest plan (approximation)' : ''}.` };
  if (meta.recording_kind === 'sonic-mujoco-lockstep') return { level: 'L1', label: 'L1 · CPU lockstep',
    proves: 'Planner and tracker logic, geometry, scoring.', hides: 'Planner latency (physics waits for each replan), DDS/ZMQ transport, C++/TensorRT numerics, start-up transient, real sensors.' };
  if (meta.recording_kind === 'recorded-wire-transport') return { level: 'L0', label: 'L0 · transport replay',
    proves: 'Wire framing and decoding of recorded packets.', hides: 'Controller execution and robot state.' };
  return { level: 'L0', label: 'L0 · recorded replay', proves: 'Data and adapter correctness of a recording.', hides: 'Everything dynamic; nothing re-executed.' };
}

function torqueSummary(t) {
  if (!t?.peak_commanded_nm) return '';
  const rows = Object.entries(t.peak_commanded_nm).filter(([n]) => /hip|knee|ankle/.test(n))
    .sort((a, b) => b[1] / (t.model_limit_nm[b[0]] ?? Infinity) - a[1] / (t.model_limit_nm[a[0]] ?? Infinity)).slice(0, 6);
  const saturated = Object.entries(t.saturated_substeps ?? {});
  return `<details class="torque-details" ${saturated.length ? 'open' : ''}><summary>Leg torque vs model limit ${saturated.length ? `<span class="chip chip-commanded">SATURATED ${saturated.length} joint${saturated.length > 1 ? 's' : ''}</span>` : ''}</summary>
    <table class="joint-table"><thead><tr><th>Joint</th><th>Peak cmd</th><th>Model</th><th>Training</th><th>Clamped</th></tr></thead><tbody>${rows.map(([n, v]) => `<tr><td>${escape(n.replace('_joint', ''))}</td><td class="${v > (t.model_limit_nm[n] ?? Infinity) ? 'value-bad' : ''}">${num(v, 1)}</td><td>${num(t.model_limit_nm[n], 0)}</td><td>${num(t.training_effort_nm?.[n], 0)}</td><td>${escape(t.saturated_substeps?.[n] ?? 0)}</td></tr>`).join('')}</tbody></table>
    ${tiny(`Commanded PD torque (N·m) vs MuJoCo actuatorfrcrange; ${t.total_substeps} substeps. Where the training effort (contract) exceeds the model limit, MuJoCo clamps: see ROBOT_CONTRACT hip_effort_limit.`)}</details>`;
}

function outcomeCard(state) {
  const meta = state.session.metadata, result = meta.test_result;
  if (!result?.outcome) return '';
  const f = fidelity(meta);
  const last = state.session.frames.at(-1), interval = last?.post_action?.contact;
  return card('Run outcome · whole run', `<div class="outcome-line">${outcomeChip(result.outcome)}<span>${num(result.elapsed_s, 2, 's')} simulated</span></div>
    ${fact('Final / closest goal distance', `${num(result.final_goal_distance_xy_m, 3)} / ${num(result.minimum_goal_distance_xy_m, 3, 'm')}`)}${fact('Peak obstacle contact', num(result.maximum_obstacle_contact_n, 2, 'N'))}
    ${fact('Max root tilt / min height', `${num(result.maximum_root_tilt_rad, 3, 'rad')} / ${num(result.minimum_root_height_m, 3, 'm')}`)}
    ${result.runtime_error ? notice(result.runtime_error, 'warning') : ''}${interval ? tiny(`Final contact interval ${num(interval.start_s, 3)}–${num(interval.end_s, 3, 's')}: ${num(interval.max_force_n, 2, 'N')}.`) : ''}
    ${fact('Fidelity level', f.label)}${tiny(`Proves: ${f.proves} Hides: ${f.hides} Not a deployment or hardware result.`)}
    ${torqueSummary(result.torque)}`,
  { evidence: 'sim-truth', id: 'recorded-outcome' });
}

function renderHealth(state) {
  const f = state.frame, m = state.measuredFrame, h = sampleHealth(state), meta = state.session.metadata, events = state.session.events ?? [];
  const lock = isLockstep(state) || meta.mode === 'simulation';
  const missing = [];
  const opt = (name, value, reason, render) => { if (value === null || value === undefined) { missing.push([name, reason]); return ''; } return render(value); };
  const evaluation = f.health?.goal_evaluation;
  const goalCard = evaluation && finite(evaluation.source_time) && evaluation.source_time <= state.time + 1e-9
    ? card('Goal check · completed physics', `${fact('Evaluator sample', num(evaluation.source_time, 3, 's'))}${fact('Distance / required', `${num(evaluation.goal_distance_xy_m, 3)} / ≤ ${num(evaluation.goal_radius_m, 2, 'm')}`)}${fact('Speed / required', `${num(evaluation.root_speed_xy_m_s, 3)} / ≤ ${num(evaluation.goal_speed_m_s, 2, 'm/s')}`)}${fact('Hold / required', `${num(evaluation.hold_elapsed_s, 2)} / ${num(evaluation.goal_hold_s, 2, 's')}`)}`, { evidence: 'sim-truth', id: 'goal-evaluation' }) : '';
  const timing = card('Timing vs budget', `<div class="budget-row">${budget(lock ? 'CPU planner compute' : 'Planner compute', h.planner_latency_ms, 160, 'deploy replan')}${budget('SONIC inference', h.sonic_inference_ms, 20, 'control tick')}${budget('Control step wall', h.control_step_wall_ms, 20, 'control tick')}</div>
    ${lock ? tiny('CPU lockstep: physics pauses while the planner runs, so these are compute measurements, not real-time deadline results.') : ''}`, { evidence: 'observed' });
  const streams = card('Freshness at cursor', `${opt('State age', h.state_age_ms, 'No state stream', v => fact('State age', `${num(v, 1, 'ms')}${h.state_stale ? ' · STALE' : ''}`, h.state_stale ? 'value-amber' : ''))}
    ${opt('Reference age', h.reference_age_ms, 'No reference timestamp', v => fact('Reference age', num(v, 1, 'ms')))}
    ${opt('Receiver status', h.stream_status, 'Only for transport captures', v => fact('Receiver status', v))}
    ${opt('Observed receive rate', h.observed_rate_hz, 'Only for transport captures', v => fact('Observed receive rate', num(v, 1, 'Hz')))}
    ${opt('Queue drops', h.queue_drops, 'Only for transport captures', v => fact('Visualization queue drops', v))}
    ${tiny(lock || meta.mode === 'replay' ? 'Ages here are cursor − sample time in the recording clock; a paused replay is not a disconnected controller.' : 'Receiver-side ages; no clock alignment with the producer is assumed.')}`, { evidence: 'recorded' });
  const contact = card('Obstacle contact', opt('Contact · completed interval', h.contact_force_n, 'Not recorded', v => fact('Peak in previous interval', num(v, 2, 'N'), v > 100 ? 'value-bad' : v > 0 ? 'value-amber' : ''))
    + (h.contact_interval ? tiny(`Interval ${num(h.contact_interval.start_s, 3)}–${num(h.contact_interval.end_s, 3, 's')} · ${h.contact_interval.samples_n?.length ?? '—'} substeps · floor excluded.`) : ''), { evidence: 'sim-truth' });
  const runtime = state.runtime ? card('Owned CPU worker', `${fact('Process', state.runtime.worker_alive === true ? 'Running · PID ' + state.runtime.worker_pid : state.runtime.worker_alive === false ? 'Exited' : 'Ownership unavailable')}${fact('Telemetry receipt', `${state.runtime.telemetry_status ?? 'Unavailable'} · ${num(state.runtime.telemetry_age_ms, 0, 'ms')}`)}`, { evidence: 'observed' }) : '';
  for (const [name, reason] of [['Low-command freshness', 'No DDS LowCmd exists in Studio rehearsals'], ['End-to-end latency', 'Requires a common clock across processes'], ['GPU utilization', 'NVML unavailable on this host; not shown as idle'], ['Supervisor state', 'Node phase not captured in this source']])
    if (!finite(h[{ 'Low-command freshness': 'lowcmd_age_ms', 'GPU utilization': 'gpu_utilization' }[name]])) missing.push([name, reason]);
  const recent = events.filter(e => e.time <= state.time).slice(-8).reverse();
  const diag = card('Replay diagnostic', `<label class="diagnostic-toggle"><input id="freeze-state" data-testid="freeze-state" type="checkbox" ${state.frozenFrame ? 'checked' : ''} ${hasPose(state.frame) ? '' : 'disabled'}> Hold state while the cursor advances</label>${tiny('Injects a stale measured state in the viewer only. Display marks it stale after 100 ms. No producer or controller is affected.')}`, { cls: state.frozenFrame ? 'card-warning' : '' });
  $('health-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">${meta.mode === 'simulation' ? 'LIVE CPU WORKER' : meta.mode === 'partial-live' ? 'PARTIAL LIVE SAMPLES · RUN ENDED WITHOUT RECORDING' : 'RECORDED DIAGNOSTICS'}</span><h3>Run health</h3></div>
    ${outcomeCard(state)}${goalCard}${timing}${pipelineHealthLink(state)}${contact}${streams}${runtime}
    ${card('Events up to cursor', recent.length ? `<ol class="event-list">${recent.map(e => `<li><time>${clock(e.time)} · ${escape(e.source)}</time><button class="event-control" data-seek="${e.time}">${escape(e.message)}</button></li>`).join('')}</ol>` : '<p class="unavailable">No event before this cursor.</p>', { evidence: 'recorded' })}
    ${diag}${unavailableList(missing)}
    <div class="card card-flat">${fact(hasPose(m) ? 'State source time' : 'Event source time', num(m?.source_time, 6, 's'))}${fact('Source clock', m?.source_clock_domain)}${fact('Receipt time', num(m?.receipt_time, 6, 's'))}${fact('Sequence', m?.sequence)}</div>`;
  $('freeze-state')?.addEventListener('change', e => { state.freeze(e.target.checked); });
}

function budget(name, value, limit, basis) {
  const pct = finite(value) ? Math.min(100, value / limit * 100) : 0;
  const tone = !finite(value) ? 'na' : value > limit ? 'bad' : value > limit * 0.6 ? 'warn' : 'good';
  return `<div class="budget budget-${tone}"><span>${escape(name)}</span><strong>${finite(value) ? `${value.toFixed(value < 10 ? 2 : 0)} ms` : 'Unavailable'}</strong><div class="bar"><i style="width:${pct}%"></i></div><small>${escape(`${limit} ms ${basis}`)}</small></div>`;
}

// ---------------------------------------------------------------- Map / perception
export function perceptionAt(session, time) {
  const p = session?.perception;
  if (!p?.frames) return p;
  const frames = p.frames;
  let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].time <= time) lo = mid + 1; else hi = mid; }
  return lo > 0 ? frames[lo - 1] : null;
}

function renderPerception(state) {
  const p = state.session.perception;
  const unseen = notice('Planner limitation: the source Flow selector and route treat unseen cells as free. Studio keeps unseen space visibly unknown.', 'warning');
  if (p?.frames) {
    const s = perceptionAt(state.session, state.time);
    $('perception-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">CAUSAL SIMULATED PERCEPTION</span><h3>What the planner observes</h3><p>Latest map and LiDAR sample at or before the cursor.</p></div>
      ${s ? card('Map snapshot', `<div class="map-stats"><div><strong>${s.observed_cells?.support?.toLocaleString() ?? '—'}</strong><span>support cells</span></div><div><strong>${s.observed_cells?.ceiling?.toLocaleString() ?? '—'}</strong><span>ceiling cells</span></div><div><strong>${s.unknown_cells?.toLocaleString() ?? '—'}</strong><span>unknown cells</span></div></div>
        ${fact('Map sample time', num(s.time, 3, 's'))}${fact('Map age at cursor', num((state.time - s.time) * 1000, 0, 'ms'))}${fact('Sensor acquisition', num(s.sensor_capture_time, 3, 's'))}${fact('Sensor latency', num(s.sensor_latency_s * 1000, 0, 'ms'))}${fact('Rate', num(s.rate_hz, 1, 'Hz'))}${fact('Resolution', num(s.resolution_m, 3, 'm'))}`, { evidence: 'estimated' })
        + card('LiDAR', `${fact('Raw returns', s.raw_points_count ?? s.raw_lidar?.length ?? 'Unavailable')}${fact('After self-filter', s.filtered_points_count ?? s.filtered_lidar?.length ?? 'Unavailable')}${fact('Self-filter removed · cumulative', s.self_removed ?? 'Unavailable')}${tiny(s.note ?? 'Bounded visualization samples.')}
        <details class="raw-details"><summary>Mount extrinsics and mask convention</summary><pre>${escape(JSON.stringify({ extrinsics: s.extrinsics, mask_convention: s.mask_convention }, null, 1))}</pre></details>`, { evidence: 'sim-truth' })
        : notice('No perception sample at or before this cursor.', 'warning')}${unseen}
      <p class="tiny">Use the <strong>Robot view</strong> camera to see returns from the sensor mount, or Sensors to pin raw / filtered LiDAR.</p>`;
    return;
  }
  $('perception-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">PERCEPTION / MAPPING</span><h3>Observed space</h3></div>
    ${p?.available ? card('Final accumulated map', `<div class="map-stats"><div><strong>${(p.observed_cells?.support ?? p.support_points?.length)?.toLocaleString() ?? '—'}</strong><span>support</span></div><div><strong>${(p.observed_cells?.ceiling ?? p.ceiling_points?.length)?.toLocaleString() ?? '—'}</strong><span>ceiling</span></div></div>${fact('Resolution', num(p.resolution_m, 3, 'm'))}${fact('Unknown cells', p.unknown_cells?.toLocaleString() ?? 'Unavailable')}${notice('Final snapshot without capture time: it does not show perception at the cursor.', 'warning')}`, { evidence: 'estimated' })
      : notice(p?.reason ?? 'No perception was recorded in this session.', 'neutral')}${unseen}`;
}

// ---------------------------------------------------------------- Graph / system
function renderGraph(state) {
  const kind = sessionKind(state.session), g = state.frame.observed_graph ?? state.session.graph ?? {};
  const h = sampleHealth(state);
  $('graph-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">COMMUNICATION TOPOLOGY</span><h3>System connections</h3><p>${escape(KIND_LABEL[kind])}</p></div><div id="graph-map" class="graph-map"></div>
    ${state.frame.observed_graph ? card('Observed receiver edge', `${fact('Receiver status', h.stream_status ?? 'Unavailable')}${fact('Last receive rate', num(h.observed_rate_hz, 1, 'Hz'))}${fact('Reference receipt age', num(h.reference_age_ms, 1, 'ms'))}${fact('Sequence gaps', h.sequence_gaps ?? 'Unavailable')}`, { evidence: 'observed' }) : ''}
    ${card('Discovery boundaries', `${fact('ROS 2 graph', g.ros2?.available ? 'Recorded' : 'Not discovered')}${fact('DDS participant discovery', 'Not performed')}${fact('DDS domain', g.dds_domain ?? 'Not recorded')}${tiny(g.dds_domain_note ?? 'Studio opens no DDS participant. A ROS 2 graph would never show the ZMQ edges.')}`, { evidence: 'configured' })}
    <button class="wide-button" data-workspace-open="system">Open full system map →</button>`;
  renderSystemMap($('graph-map'), state.session, { compact: true });
}

// ---------------------------------------------------------------- Source
function renderSource(state) {
  const m = state.session.metadata, prov = m.provenance ?? {}, policy = m.policy_profile;
  $('source-content').innerHTML = `<div class="tab-intro"><span class="eyebrow">REPRODUCIBLE PROVENANCE</span><h3>Source evidence</h3></div>
    <a class="export-link" href="/api/export?id=${encodeURIComponent(state.sessionId)}" download>↓ Export normalized MCAP</a>
    ${policy ? card('Policy profile', `${fact('Profile', policy.label ?? policy.id)}${fact('Research block', policy.research_block ?? 'Not a Flow research block')}${fact('Revision', policy.revision ?? 'Bundle snapshot')}${fact('Identity SHA-256', (policy.identity_sha256 ?? '').slice(0, 16) || 'Unavailable')}${policy.config_path ? fact('Config', policy.config_path.split('/').slice(-1)[0]) : ''}`, { evidence: 'configured' }) : ''}
    ${card('Session', `${fact('Mode', m.mode === 'simulation' ? 'Live CPU worker' : 'Replay · read-only')}${fact('Recording', m.recording_kind)}${fact('Robot model', m.model_variant)}${fact('Policy', m.policy_identity)}${fact('Clock', m.clock_domain)}${fact('Frame', m.frame_id)}${fact('Quaternion', m.quaternion_convention)}${fact('Hardware validated', m.hardware_validated ? 'Yes' : 'No')}${fact('Hardware command path', m.command_path_enabled ? 'YES — unexpected' : 'None')}${fact('Adapter', prov.adapter ?? 'Unavailable')}`)}
    ${m.planner_configuration ? `<details class="raw-details"><summary>Effective planner configuration</summary><pre>${escape(JSON.stringify(m.planner_configuration, null, 1))}</pre></details>` : ''}
    <h4>Recording source</h4><pre>${escape(m.source_path)}</pre>
    <h4>Source artifacts</h4>${(prov.artifacts ?? []).map(a => `<details class="raw-details"><summary>${escape(a.path.split('/').at(-1))} · ${num(a.bytes / 1024, 1, 'KiB')}</summary><pre>${escape(a.path)}\nSHA-256 ${escape(a.sha256)}</pre></details>`).join('') || '<p class="unavailable">None recorded</p>'}
    <h4>Source checkouts at read time</h4>${(prov.repositories ?? []).map(r => `<pre>${escape(r.path)}\nHEAD ${escape(r.head_at_read)}\nDirty: ${r.dirty_at_read == null ? 'unknown' : r.dirty_at_read ? 'yes' : 'no'}</pre>`).join('') || '<p class="unavailable">None recorded</p>'}
    <h4>Known evidence limits</h4><ul class="limits">${(m.limitations ?? []).map(t => `<li>${escape(t)}</li>`).join('')}</ul>`;
}

// ---------------------------------------------------------------- Dispatcher
export function renderInspector(state, { force = false } = {}) {
  if (!state.frame || !state.session) return;
  const now = performance.now();
  // Bounded refresh while playing (review P-7); cheap tabs update every frame.
  if (!force && state.playing && inspector.tab !== 'joints' && now - inspector.lastRender < 125) return;
  const key = `${inspector.tab}:${state.sessionId}:${state.frameIndex}:${state.frozenFrame?.time ?? ''}:${state.session.frames.length}`;
  if (!force && key === inspector.lastKey) { if (inspector.tab === 'joints') drawJointChart(state, false); return; }
  inspector.lastKey = key; inspector.lastRender = now;
  const t = inspector.tab;
  if (t === 'intent') renderIntent(state);
  else if (t === 'joints') updateJoints(state);
  else if (t === 'health') renderHealth(state);
  else if (t === 'perception') renderPerception(state);
  else if (t === 'pipeline') renderPipeline(state, perceptionAt(state.session, state.time), force);
  else if (t === 'graph') renderGraph(state);
  else renderSource(state);
  $('inspector-time').textContent = `SYNCHRONIZED · ${clock(state.frame.time)}`;
}

export function selectTab(name, state) {
  inspector.tab = name;
  document.querySelectorAll('[data-tab]').forEach(b => {
    const active = b.dataset.tab === name;
    b.classList.toggle('active', active); b.setAttribute('aria-selected', String(active)); b.tabIndex = active ? 0 : -1;
    $(`panel-${b.dataset.tab}`).hidden = !active;
  });
  if (name === 'joints') inspector.jointsSession = null;
  renderInspector(state, { force: true });
}

export { systemDetails };
