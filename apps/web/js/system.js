// System map: the deployment chain with transport-specific, evidence-styled edges.
// Configured edges are never animated; only observed/recorded edges carry data.
import { escape, num, chip, fact, finite, tiny } from './util.js';

// Three-row layout (viewBox 1200 × 490): planning chain on top, tracking chain in the middle,
// sensing and physics on the bottom with the state feedback along the bottom edge. Every edge is
// routed orthogonally around nodes and every label has a hand-placed slot (see ROUTES).
const NODES = [
  { id: 'lidar', x: 95, y: 80, label: 'MID-360 LiDAR', sub: 'torso mount · inverted' },
  { id: 'perception', x: 295, y: 80, label: 'Perception', sub: 'deskew · filter · CloudMemory' },
  { id: 'route', x: 495, y: 80, label: 'Route A*', sub: 'waypoint ≈1.5 m ahead' },
  { id: 'flow', x: 695, y: 80, label: 'Flow planner', sub: 'K candidates × ODE · select' },
  { id: 'studio', x: 895, y: 80, label: 'Studio (read-only)', sub: 'recorder · gateway · browser' },
  { id: 'feed', x: 695, y: 255, label: 'Reference feed', sub: '10 rows × 67 · 0–0.9 s' },
  { id: 'sonic', x: 895, y: 255, label: 'SONIC tracker', sub: 'obs 1570 → action 29' },
  { id: 'pd', x: 1095, y: 255, label: 'PD / motors', sub: 'q* = default + scale·a' },
  { id: 'state', x: 95, y: 430, label: 'IMU + 29 joints', sub: 'rt/lowstate · secondary IMU' },
  { id: 'robot', x: 1095, y: 430, label: 'Robot / physics', sub: 'G1 29-DoF' },
];
// Polyline waypoints and label slot [x, y, anchor, max characters] per edge, in viewBox units.
const ROUTES = {
  'lidar-perception': { pts: [[181, 80], [209, 80]], label: [195, 34, 'middle'] },
  'perception-route': { pts: [[381, 80], [409, 80]], label: [395, 34, 'middle'] },
  'route-flow': { pts: [[581, 80], [609, 80]], label: [595, 34, 'middle'] },
  'state-perception': { pts: [[75, 395], [75, 150], [275, 150], [275, 115]], label: [175, 144, 'middle'] },
  'state-flow': { pts: [[105, 395], [105, 185], [655, 185], [655, 115]], label: [380, 179, 'middle'] },
  'state-sonic': { pts: [[135, 395], [135, 330], [870, 330], [870, 290]], label: [500, 324, 'middle'] },
  'flow-feed': { pts: [[695, 115], [695, 220]], label: [705, 166, 'start', 26] },
  'feed-sonic': { pts: [[781, 255], [809, 255]], label: [795, 211, 'middle', 24] },
  'sonic-pd': { pts: [[981, 255], [1009, 255]], label: [995, 211, 'middle', 24] },
  'pd-robot': { pts: [[1095, 290], [1095, 395]], label: [1085, 346, 'end', 28] },
  'robot-state': { pts: [[1009, 430], [181, 430]], label: [595, 422, 'middle'] },
  'sonic-studio': { pts: [[895, 220], [895, 115]], label: [905, 166, 'start', 26] },
};

// transport: dds | zmq | inproc | http | ros2 ; deploy = real-time path; lockstep = Studio CPU worker
const EDGES = [
  { id: 'lidar-perception', from: 'lidar', to: 'perception', deploy: ['dds', 'rt/utlidar/cloud_livox_mid360 · 10 Hz'], lockstep: ['inproc', 'MuJoCo ray LiDAR → CloudMemory.add_cloud'] },
  { id: 'state-perception', from: 'state', to: 'perception', deploy: ['dds', 'rt/lowstate (FK to torso mount)'], lockstep: ['inproc', 'simulator qpos (truth)'] },
  { id: 'perception-route', from: 'perception', to: 'route', deploy: ['inproc', 'support / ceiling grid'], lockstep: ['inproc', 'support / ceiling grid'] },
  { id: 'route-flow', from: 'route', to: 'flow', deploy: ['inproc', 'waypoint every 0.1 s'], lockstep: ['inproc', 'waypoint every 0.1 s'] },
  { id: 'state-flow', from: 'state', to: 'flow', deploy: ['dds', 'state history 5 × qpos36'], lockstep: ['inproc', 'state history 5 × qpos36'] },
  { id: 'flow-feed', from: 'flow', to: 'feed', deploy: ['inproc', '1.0 s plan · ≥8-tick replans'], lockstep: ['inproc', 'plan (physics paused while planning)'] },
  { id: 'feed-sonic', from: 'feed', to: 'sonic', deploy: ['zmq', ':5556 pose v1 · Isaac order · wxyz'], lockstep: ['inproc', 'reference window → tracker.policy'] },
  { id: 'state-sonic', from: 'state', to: 'sonic', deploy: ['dds', 'rt/lowstate + rt/secondary_imu'], lockstep: ['inproc', 'proprioceptive history'] },
  { id: 'sonic-pd', from: 'sonic', to: 'pd', deploy: ['inproc', 'action → q* targets (runner)'], lockstep: ['inproc', 'action → q* targets'] },
  { id: 'pd-robot', from: 'pd', to: 'robot', deploy: ['dds', 'rt/lowcmd · 500 Hz · CRC'], lockstep: ['inproc', 'Physics.step · 4 × 5 ms PD substeps'] },
  { id: 'robot-state', from: 'robot', to: 'state', deploy: ['dds', 'motor encoders + IMU'], lockstep: ['inproc', 'measure()'] },
  { id: 'sonic-studio', from: 'sonic', to: 'studio', deploy: ['zmq', ':5557 g1_debug · robot_config'], lockstep: ['inproc', 'Studio observer wrappers'] },
];

const TRANSPORT = {
  dds: { label: 'Unitree DDS', color: '#7fb4ff' }, zmq: { label: 'ZMQ', color: '#efbb70' },
  inproc: { label: 'In-process call', color: '#9fb0be' }, http: { label: 'HTTP loopback', color: '#82baa7' },
  ros2: { label: 'ROS 2', color: '#d58ad6' },
};

export function sessionKind(session) {
  const m = session?.metadata ?? {};
  if (m.recording_kind === 'recorded-wire-transport') return 'wire';
  if (m.recording_kind === 'sonic-mujoco-lockstep') {
    if (m.privileged_map || m.policy_profile?.loader === 'flow-callback') return 'privileged';
    return /^studio\.(policy_worker|flow_policy_worker)/.test(m.provenance?.adapter ?? '') ? 'worker' : 'lockstep';
  }
  if (session) return 'process-chain';
  return 'reference';
}

// Under a latency model the plan edge is not "physics paused": each plan lands L ms after its request.
function latencyTopic(edge, session) {
  const ms = session?.metadata?.latency_model?.ms;
  return edge.id === 'flow-feed' && ms ? `plan lands +${ms} ms (physics runs)` : null;
}

// Evidence per edge for the open session (never upgrades configured to observed).
const PRIVILEGED_UNUSED = new Set(['lidar-perception', 'state-perception', 'perception-route']);
function edgeEvidence(edge, kind, session) {
  if (kind === 'privileged') {
    if (PRIVILEGED_UNUSED.has(edge.id)) return { evidence: 'unavailable', transport: 'inproc', topic: 'not used: privileged block', basis: 'This block plans from the exact configured boxes; no LiDAR, perception map or sensed route exists in the run' };
    if (edge.id === 'route-flow') return { evidence: 'configured', transport: 'inproc', topic: 'privileged cost route on exact boxes (SIM-TRUTH)', basis: 'Route computed from the simulator\'s exact collision boxes, not from sensing' };
    return { evidence: 'observed', transport: edge.lockstep[0], topic: latencyTopic(edge, session) ?? edge.lockstep[1], basis: 'Observed by Studio wrappers inside the owned CPU worker (Flow callback)' };
  }
  if (kind === 'worker') return { evidence: 'observed', transport: edge.lockstep[0], topic: latencyTopic(edge, session) ?? edge.lockstep[1], basis: 'Observed by Studio wrappers inside the owned CPU worker' };
  if (kind === 'lockstep') return { evidence: 'recorded', transport: edge.lockstep[0], topic: edge.lockstep[1], basis: 'In-process lockstep recording (no DDS/ZMQ)' };
  if (kind === 'wire') {
    if (edge.id === 'feed-sonic') return { evidence: 'observed', transport: 'zmq', topic: 'pose v1 at Studio subscriber', basis: 'Receiver-side observation of recorded reference packets' };
    return { evidence: 'unavailable', transport: edge.deploy[0], topic: edge.deploy[1], basis: 'Not part of this transport capture' };
  }
  if (kind === 'process-chain') return { evidence: 'configured', transport: edge.deploy[0], topic: edge.deploy[1], basis: 'Configured from source; packet-level traffic was not captured' };
  return { evidence: 'configured', transport: edge.deploy[0], topic: edge.deploy[1], basis: 'Reference deployment topology from source' };
}

function nodeBadge(id, session) {
  const r = session?.metadata?.test_result ?? {};
  if (id === 'flow' && r.plan_latency_s) return `p50 ${num(r.plan_latency_s.p50 * 1000, 0)} · p95 ${num(r.plan_latency_s.p95 * 1000, 0)} ms`;
  if (id === 'sonic' && r.sonic_inference_ms) return `p50 ${num(r.sonic_inference_ms.p50, 1)} · p95 ${num(r.sonic_inference_ms.p95, 1)} ms`;
  if (id === 'perception' && session?.perception?.frames?.length) return `${session.perception.frames.length} map snapshots`;
  if ((id === 'perception' || id === 'lidar') && sessionKind(session) === 'privileged') return 'not used (privileged)';
  if (id === 'robot' && (['worker', 'privileged'].includes(sessionKind(session)) || session?.metadata?.fidelity === 'L3')) {
    const hips = session?.metadata?.actuators?.hips;
    const nm = side => hips?.[`left_hip_${side}_joint`]?.after_nm;
    return hips ? `hips ${num(nm('pitch'), 0)}/${num(nm('roll'), 0)}/${num(nm('yaw'), 0)} N·m` : 'hips 88/88/88 (source model)';
  }
  return '';
}

export function renderSystemMap(container, session, { selected = null, onSelect = null, compact = false, showDeploy = false } = {}) {
  const kind = showDeploy ? 'reference' : sessionKind(session);
  const W = 1200, H = 490, nodeW = 172, nodeH = 70;
  const edges = EDGES.map(e => ({ ...e, ...edgeEvidence(e, kind, session) }));
  const short = (text, max = 30) => text.length > max ? `${text.slice(0, max - 1)}…` : text;
  const edgeSvg = edges.map(e => {
    const route = ROUTES[e.id], t = TRANSPORT[e.transport] ?? TRANSPORT.inproc;
    const dash = e.evidence === 'configured' ? '7 5' : e.evidence === 'unavailable' ? '2 5' : '';
    const opacity = e.evidence === 'unavailable' ? 0.35 : 1;
    const [lx, ly, anchor, max] = route.label;
    return `<g class="sys-edge" data-edge="${e.id}" opacity="${opacity}"><title>${escape(`${t.label} · ${e.topic}\n${e.basis}`)}</title>
      <polyline points="${route.pts.map(p => p.join(',')).join(' ')}" fill="none" stroke="${t.color}" stroke-width="${e.evidence === 'observed' ? 2.4 : 1.6}" stroke-dasharray="${dash}" stroke-linejoin="round" marker-end="url(#arrow-${e.transport})"/>
      ${compact ? '' : `<text x="${lx}" y="${ly}" class="sys-edge-label" text-anchor="${anchor}">${escape(short(e.topic, max))}</text>`}</g>`;
  }).join('');
  const markers = Object.entries(TRANSPORT).map(([k, t]) => `<marker id="arrow-${k}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${t.color}"/></marker>`).join('');
  const nodeSvg = NODES.map(n => {
    const badge = nodeBadge(n.id, session);
    return `<g class="sys-node ${selected === n.id ? 'selected' : ''}" data-node="${n.id}" tabindex="0" role="button" aria-label="${escape(n.label)}">
      <rect x="${n.x - nodeW / 2}" y="${n.y - nodeH / 2}" width="${nodeW}" height="${nodeH}" rx="10"/>
      <text x="${n.x}" y="${n.y - (badge ? 12 : 4)}" text-anchor="middle" class="sys-node-label">${escape(n.label)}</text>
      <text x="${n.x}" y="${n.y + (badge ? 6 : 14)}" text-anchor="middle" class="sys-node-sub">${escape(n.sub)}</text>
      ${badge ? `<text x="${n.x}" y="${n.y + 24}" text-anchor="middle" class="sys-node-badge">${escape(badge)}</text>` : ''}</g>`;
  }).join('');
  const legend = Object.entries(TRANSPORT).filter(([k]) => k !== 'ros2').map(([, t]) => `<span><i style="background:${t.color}"></i>${escape(t.label)}</span>`).join('');
  container.innerHTML = `<div class="sys-legend">${legend}<span class="sys-style"><b class="solid"></b>observed / recorded</span><span class="sys-style"><b class="dashed"></b>configured from source</span><span class="sys-style"><b class="dotted"></b>not in this source</span></div>
    <svg class="system-map" viewBox="0 0 ${W} ${H}" role="img" aria-label="Deployment system map">${'<defs>' + markers + '</defs>'}${edgeSvg}${nodeSvg}</svg>`;
  if (onSelect) {
    container.querySelectorAll('[data-node]').forEach(node => {
      const pick = () => onSelect(node.dataset.node);
      node.addEventListener('click', pick);
      node.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); pick(); } });
    });
  }
  return { kind, edges };
}

export const KIND_LABEL = {
  privileged: 'Fresh Studio CPU worker · PRIVILEGED block: plans from the exact configured boxes; no LiDAR or perception map; DDS/ZMQ not exercised',
  worker: 'Fresh Studio CPU worker · in-process calls observed by wrappers; DDS/ZMQ not exercised',
  lockstep: 'Recorded in-process lockstep · no DDS/ZMQ in this run',
  wire: 'Recorded ZMQ transport capture · one observed receiver edge',
  'process-chain': 'Separate simulator / planner / C++ runner processes · edges configured, traffic not captured',
  reference: 'Reference real-time deployment topology (source-configured)',
};

const DETAILS = {
  lidar: { what: 'Livox MID-360 mounted inverted on torso_link. ~20k points per sweep at 10 Hz in the sensor frame.', studio: 'CPU rehearsals use MuJoCo ray casts from the same mount; raw and filtered returns are recorded at 5 Hz.' },
  state: { what: 'Pelvis IMU and 29 motor encoders in rt/lowstate; the runner also requires rt/secondary_imu.', studio: 'CPU rehearsals use simulator truth for pose and IMU; no physical IMU acceleration exists.' },
  perception: { what: 'Points → world via odometry + FK + mount, robot self-filter, then support (standable height) and ceiling grids at 0.05 m. NaN = unseen.', studio: 'The planner treats unseen cells as free. Studio keeps them visibly unknown.' },
  route: { what: 'A* over the sensed grid every 0.1 s picks a waypoint about 1.5 m ahead.', studio: 'Effective route configuration is recorded per run.' },
  flow: { what: 'Generative flow-matching planner: K candidate 1 s whole-body motions conditioned on history, an ego map and the waypoint; a clearance check selects one.', studio: 'Studio records the first forward call per replan, the selected rule and measured compute time.' },
  feed: { what: 'Each 20 ms tick a 10-row window (0…0.9 s) is cut from the selected plan: joints, velocities and relative pelvis orientation. Columns 64–66 are diagnostic only.', studio: 'Recorded per frame; the cyan ghost renders this window.' },
  sonic: { what: 'Fused SONIC ONNX tracker: observation [1,1570] → action [1,29]. It tracks the window while balancing; it does not plan.', studio: 'Inputs/outputs sampled at 10 Hz in CPU rehearsals; inference time measured directly.' },
  pd: { what: 'q* = default + action_scale ⊙ action (Isaac→MuJoCo order); fixed kp/kd; 500 Hz LowCmd writer on hardware.', studio: 'CPU rehearsals record PD targets and the clipped simulated PD torques. No DDS LowCmd exists.' },
  robot: { what: 'Unitree G1 29-DoF body. Physical robot or simulator.', studio: 'Studio never publishes rt/lowcmd or hand commands. Hardware is disabled.' },
  studio: { what: 'Read-only recorder (ZMQ SUB on loopback), replay gateway and this browser.', studio: 'Never connects to the planner node REP :5562 control port.' },
};

export function systemDetails(id, session, robot) {
  const d = DETAILS[id];
  if (!d) return '<p class="tiny">Select a component.</p>';
  const node = NODES.find(n => n.id === id);
  const kind = sessionKind(session);
  const privilegedNote = kind === 'privileged' && ['lidar', 'perception', 'route', 'flow'].includes(id)
    ? '<div class="callout warning">Privileged block: this run planned from the exact configured boxes (simulator ground truth). No LiDAR, perception map or sensed route was used.</div>' : '';
  const related = EDGES.filter(e => e.from === id || e.to === id).map(e => ({ ...e, ...edgeEvidence(e, kind, session) }));
  const thresholds = (robot?.safety_thresholds ?? []).filter(t => {
    const owner = `${t.owner ?? ''} ${t.id ?? ''} ${t.name ?? ''}`.toLowerCase();
    return (id === 'state' && /lowstate|state|odom/.test(owner)) || (id === 'sonic' && /runner|reference|velocity/.test(owner))
      || (id === 'flow' && /plan|node|stall|tilt/.test(owner)) || (id === 'perception' && /cloud/.test(owner));
  });
  return `<h3>${escape(node.label)}</h3>${privilegedNote}<p>${escape(d.what)}</p>${tiny(d.studio)}
    <h4>Connections in this source</h4>${related.map(e => `<div class="sys-detail-edge">${chip(e.evidence)} <strong>${escape(TRANSPORT[e.transport]?.label ?? e.transport)}</strong> ${escape(e.from)} → ${escape(e.to)}<small>${escape(e.topic)} · ${escape(e.basis)}</small></div>`).join('')}
    ${thresholds.length ? `<h4>Safety thresholds in source</h4><div class="threshold-list">${thresholds.map(t => `<div class="threshold"><strong>${escape((t.id ?? t.name).replaceAll('_', ' '))}</strong><span class="value">${escape(t.value)} ${escape(t.unit ?? '')}</span> · ${escape(t.owner ?? '')}<p>${escape(t.effect ?? '')}</p></div>`).join('')}</div>${tiny('Source-inspected configuration; not verified on hardware.')}` : ''}`;
}

function quantity(q, digits = 3) {
  if (!q || typeof q !== 'object') return '<td>—</td>';
  const fmt = v => Array.isArray(v) ? v.map(x => finite(x) ? x.toFixed(2) : '—').join(' … ') : finite(v) ? v.toFixed(digits) : '—';
  if (q.value !== null && q.value !== undefined) return `<td title="${escape(`${q.agreement ?? ''} across ${q.values?.length ?? 1} source(s)`)}">${fmt(q.value)}</td>`;
  const values = (q.values ?? []).map(v => `${fmt(v.value)} <small>${escape(v.origin)}</small>`).join('<br>');
  return `<td class="disagree agree-${escape(q.agreement ?? 'unknown')}" title="Sources disagree (${escape(q.agreement)}, max relative difference ${escape(q.max_rel_diff)})">${values || '—'}</td>`;
}
const where = src => src ? `${String(src.path ?? '').split('/').slice(-1)[0]}:${src.line ?? ''}` : '—';

export function renderRobotContract(container, robot) {
  if (!robot?.joints?.length) { container.innerHTML = '<div class="callout warning">Robot contract unavailable.</div>'; return; }
  const rows = robot.joints.map(j => `<tr><td title="${escape(j.name)}">${escape(j.name.replace('_joint', ''))}</td><td>${j.unitree_motor_index}</td><td>${j.mujoco_index}</td><td>${j.isaaclab_index}</td>
    ${quantity(j.default_angle_rad)}${quantity(j.kp_nm_per_rad, 2)}${quantity(j.kd_nm_s_per_rad, 3)}${quantity(j.action_scale_rad, 3)}${quantity(j.effort_limit_nm, 0)}${quantity(j.position_limit_rad)}</tr>`).join('');
  const sevRank = { high: 0, medium: 1, low: 2 };
  // Open items first (by severity), then mitigated, then resolved.
  const stRank = { open: 0, mitigated: 1, resolved: 2 };
  const discrepancies = [...(robot.discrepancies ?? [])].sort((a, b) => (stRank[a.status ?? 'open'] - stRank[b.status ?? 'open']) || ((sevRank[a.severity] ?? 3) - (sevRank[b.severity] ?? 3)));
  const openCount = discrepancies.filter(d => (d.status ?? 'open') === 'open').length;
  const topics = (robot.dds?.topics ?? []).map(t => `<tr><td><code>${escape(t.name)}</code></td><td>${escape((t.type ?? '').split('::').pop())}</td><td>${escape(t.kind ?? '')}</td>
    <td>${(t.publishers ?? []).map(x => `${escape(x.component)}${finite(x.rate_hz_configured) ? ` · ${x.rate_hz_configured} Hz` : ''}`).join('<br>')}</td><td>${(t.subscribers ?? []).map(x => escape(x.component)).join('<br>')}</td></tr>`).join('');
  const thresholds = (robot.safety_thresholds ?? []).map(t => `<tr><td>${escape(t.id)}</td><td>${escape(t.value)} ${escape(t.unit ?? '')}</td><td>${escape(t.owner ?? '—')}</td><td>${escape(t.effect ?? '—')}</td><td><code>${escape(where(t.source))}</code></td></tr>`).join('');
  container.innerHTML = `<div class="contract-head"><div><span class="eyebrow">UNITREE G1 CONTRACT · ${escape((robot.verification?.status ?? 'source_inspected').replaceAll('_', ' ').toUpperCase())}</span><h3>${escape(robot.title ?? robot.robot_id)}</h3></div>${chip('configured', robot.verification?.statement ?? '')}</div>
    <p class="tiny">${escape(robot.verification?.statement ?? '')} Joints are matched by name. Motor index = LowCmd/LowState slot; MuJoCo order = simulator and recordings; IsaacLab order = ZMQ pose wire and policy tensors.</p>
    ${discrepancies.length ? `<h4>Source discrepancies (${openCount} open of ${discrepancies.length})</h4><div class="discrepancies">${discrepancies.map(d => { const st = d.status ?? 'open';
      return `<div class="discrepancy sev-${escape(d.severity)} st-${escape(st)}"><span class="sev">${escape(st === 'open' ? d.severity : st)}</span><div><strong>${escape(d.id.replaceAll('_', ' '))}</strong>${d.resolution ? `<p class="resolution">${escape(d.resolution)}</p>` : ''}<p>${escape(d.summary)}</p></div></div>`; }).join('')}</div>` : ''}
    <h4>Joint table</h4><div class="table-scroll"><table class="contract-table"><thead><tr><th>Joint</th><th>Motor</th><th>MJ</th><th>Isaac</th><th>Default rad</th><th>kp</th><th>kd</th><th>Action scale</th><th>Effort N·m</th><th>Limits rad</th></tr></thead><tbody>${rows}</tbody></table></div>
    ${topics ? `<h4>Unitree DDS topics (source-configured)</h4><div class="table-scroll"><table class="contract-table"><thead><tr><th>Topic</th><th>Type</th><th>Kind</th><th>Publishers</th><th>Subscribers</th></tr></thead><tbody>${topics}</tbody></table></div>` : ''}
    ${robot.dds?.isolation_assessment ? `<div class="callout warning"><strong>Domain isolation.</strong> ${escape(typeof robot.dds.isolation_assessment === 'string' ? robot.dds.isolation_assessment : robot.dds.isolation_assessment.summary ?? JSON.stringify(robot.dds.isolation_assessment))}</div>` : ''}
    ${thresholds ? `<h4>Safety thresholds (source)</h4><div class="table-scroll"><table class="contract-table"><thead><tr><th>Check</th><th>Threshold</th><th>Owner</th><th>Effect</th><th>Source</th></tr></thead><tbody>${thresholds}</tbody></table></div>` : ''}`;
}
