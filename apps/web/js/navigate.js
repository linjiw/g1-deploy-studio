// Navigate: put goals on the robot's own map and watch it walk there (docs/NAVIGATE.md).
// The simulated robot is an owned CPU process that behaves like g1deploy/node.py; the real robot is
// reached only through the robot link (goal and stand to node.py; Go stays with the operator).
import { $, escape, num, request, emit, on, finite } from './util.js';

export const nav = {
  catalog: null, robot: 'simulated', mapId: null, map: null, presetIndex: 0,
  settings: { planner: 'quick', latency: 'none', actuators: 'g1-current', odometry: 'truth', seed: 0 },
  job: null, timer: null, pick: null, busy: false, lastPerception: -Infinity, pendingSeq: null, notice: null,
  showTruth: false, robotLink: null, finished: null, mapBounds: null, endRequestedAt: null,
};

const ACTIVE = ['starting', 'running', 'cancelling'];
// A robot link a previous gateway started keeps running ('detached'): it can still be watched and ended.
const followed = job => job && (ACTIVE.includes(job.status) || (job.kind === 'robot' && job.status === 'detached'));
const LATENCY = {
  none: { label: 'None (lockstep)', value: { ms: 0, anchor: 'measured' } },
  robot: { label: '160 ms · deploy PC budget, predictive', value: { ms: 160, anchor: 'predict' } },
  slow: { label: '200 ms · past the budget, predictive', value: { ms: 200, anchor: 'predict' } },
};
const ODOMETRY = { truth: 'Simulator truth', lio: 'LIO-level drift', drift: 'Poor odometry (drift)' };
const ACTUATORS = { 'g1-current': 'Current G1 (139/139/88 N·m hips)', 'g1-rev1': 'G1 rev 1 (88/139/88)', source: 'Training model (88/88/88)' };
const PHASE = {
  BOOT: ['Starting the simulated robot', 'outcome-live'], WAIT: ['Standing · waiting for a goal', 'outcome-good'],
  PRESCAN: ['Pre-scanning', 'outcome-live'], RUN: ['Walking', 'outcome-live'], ARRIVED: ['Arrived · standing', 'outcome-good'],
  STOPPED: ['Stopped · standing', 'outcome-warn'], ENDED: ['Session ended', 'outcome-muted'],
};
const CHECK_ICON = { pass: '✓', warn: '!', block: '✕' };

const isActive = followed;
const isReal = job => job?.kind === 'robot' || job?.latest?.robot === 'real';
function phaseLabel(n, real) {
  if (!n?.phase) return [real ? "Waiting for the node's status" : 'Starting the simulated robot', 'outcome-live'];
  let [text, tone] = PHASE[n.phase] ?? [n.phase, 'outcome-live'];
  if (['ARRIVED', 'STOPPED'].includes(n.phase) && n.pending_stand) [text, tone] = [`${n.phase === 'ARRIVED' ? 'Arrived' : 'Stopped'} · stand deferred`, 'outcome-warn'];
  if (n.phase_status === 'stale') { text += ' · status stale'; tone = 'outcome-warn'; }
  return [text, tone];
}
const navState = () => nav.job?.latest?.navigation ?? null;

export async function initNavigate(catalog) {
  nav.catalog = catalog;
  const worlds = runnableWorlds();
  nav.mapId ??= (worlds.find(m => m.origin === 'arena-editor') ?? worlds.find(m => m.id === 'flow-detour') ?? worlds[0])?.id;
  if (nav.mapId) await selectWorld(nav.mapId, false);
  await Promise.all([refreshActive(), refreshSessions()]);
  render();
}

function runnableWorlds() { return (nav.catalog?.maps ?? []).filter(m => m.runnable && m.kind === 'boxes'); }

async function selectWorld(id, rerender = true) {
  nav.mapId = id;
  const token = nav.mapToken = (nav.mapToken ?? 0) + 1;
  const map = await request(`/api/map?id=${encodeURIComponent(id)}`);
  if (token !== nav.mapToken) return;
  nav.map = map; nav.presetIndex = 0;
  if (rerender) render();
}

function starts() {
  const m = nav.map; if (!m) return [];
  const list = (m.presets ?? []).map(p => ({ label: p.label, start_xy: p.start_xy, start_yaw_rad: p.start_yaw_rad ?? 0, goal_xy: p.goal_xy }));
  if (m.suggested_scenario) list.push({ label: 'Source start', ...m.suggested_scenario });
  if (!list.length) list.push({ label: 'World origin', start_xy: [0, 0], start_yaw_rad: 0 });
  return list;
}

export async function refreshActive() {
  try {
    const { jobs } = await request('/api/jobs');
    const live = jobs.find(j => ['navigation', 'robot'].includes(j.kind) && followed(j));
    if (live && nav.job?.id !== live.id) { nav.job = live; poll(true); }
  } catch { /* jobs are optional for replay-only gateways */ }
}

function schedule(ms = 250) { clearTimeout(nav.timer); nav.timer = setTimeout(() => poll(), ms); }

async function poll(first = false) {
  if (!nav.job) return;
  const id = nav.job.id;
  try {
    const after = Number.isFinite(nav.lastPerception) ? nav.lastPerception : '';
    const job = await request(`/api/jobs?id=${encodeURIComponent(id)}&light=1&perception_after=${after}`);
    if (nav.job?.id !== id) return;
    if (job.latest?.perception?.time > nav.lastPerception) nav.lastPerception = job.latest.perception.time;
    const wasActive = isActive(nav.job) || first;
    const before = nav.job?.latest?.navigation?.phase;
    nav.job = job;
    // A notice belongs to the moment it was given: a phase change retires "Walking." and friends.
    if (before && navState()?.phase !== before && nav.notice?.kind === 'ok') nav.notice = null;
    resolvePending();
    emit('navigate:job', job);
    renderLive();
    if (isActive(job)) schedule(navState()?.paused ? 500 : 250);
    else if (wasActive) { nav.finished = job; nav.endRequestedAt = null; nav.notice = null; emit('navigate:finished', job); render(); }
  } catch (error) {
    nav.notice = { kind: 'warning', text: `Lost the session status: ${error.message}` };
    renderLive();
    schedule(1500);
  }
}

function resolvePending() {
  const seq = nav.pendingSeq; if (!seq) return;
  const reply = navState()?.commands?.find(c => c.seq === seq);
  if (!reply) return;
  nav.pendingSeq = null;
  if (reply.status === 'rejected') nav.notice = { kind: 'warning', text: `${label(reply.cmd)} refused: ${reply.reason}` };
  else if (reply.cmd === 'stand' && navState()?.pending_stand) {
    nav.notice = { kind: 'warning', text: 'Stand requested; the node defers it here (see above).' };
  } else {
    nav.notice = { kind: 'ok', text: { goal: isReal(nav.job) ? 'Goal staged on the node and read back. The operator starts the walk with g on the console or F1 on the remote.' : 'Goal staged. Press Go to walk there.', go: 'Walking.', stand: 'Settling to a stand.', takeover: 'Taken over: standing now.', end: 'Ending the session…', clear: 'Goal cleared.' }[reply.cmd] ?? 'Done.' };
    if (reply.cmd === 'goal') nav.pick = null;
  }
  emit('navigate:overlay');
}
const label = cmd => ({ goal: 'Goal', go: 'Go', stand: 'Stand', takeover: 'Take over', end: 'End', clear: 'Clear' }[cmd] ?? cmd);

async function command(cmd, extra = {}) {
  if (!nav.job || nav.busy) return;
  nav.busy = true; nav.notice = null; renderLive();
  try {
    const result = await request('/api/nav/command', { id: nav.job.id, cmd, ...extra });
    nav.pendingSeq = result.seq;
    if (cmd === 'end') nav.endRequestedAt = Date.now();
    schedule(100);
  } catch (error) { nav.notice = { kind: 'warning', text: error.message }; }
  finally { nav.busy = false; renderLive(); }
}

async function startSession() {
  const q = starts()[nav.presetIndex];
  if (!q) return;
  nav.busy = true; nav.notice = null; nav.finished = null; render();
  try {
    const body = { map_id: nav.mapId, start_xy: q.start_xy, start_yaw_rad: q.start_yaw_rad ?? 0, planner: nav.settings.planner,
      latency: LATENCY[nav.settings.latency].value, actuators: nav.settings.actuators, odometry: nav.settings.odometry, seed: nav.settings.seed };
    nav.job = await request('/api/nav/start', body);
    nav.lastPerception = -Infinity; nav.pick = null;
    emit('navigate:started', nav.job);
    schedule(300);
  } catch (error) { nav.notice = { kind: 'warning', text: error.message }; }
  finally { nav.busy = false; render(); }
}

// ----- picking a goal on the map ------------------------------------------------
export async function pickGoal(xy) {
  const n = navState();
  if (!isActive(nav.job) || !n) return;
  if (!n.can?.goal) {
    nav.notice = { kind: 'warning', text: n.can_reasons?.goal ?? (n.phase === 'RUN' || n.phase === 'PRESCAN' ? 'Goals are placed while the robot stands, as on the robot. Press Stand first or wait for it to arrive.' : 'The robot cannot take a goal right now.') };
    renderLive(); return;
  }
  const token = nav.pickToken = (nav.pickToken ?? 0) + 1;
  nav.pick = { xy: xy.map(v => Math.round(v * 100) / 100), check: null };
  nav.notice = null;
  emit('navigate:overlay'); renderLive();
  try {
    const check = await request(`/api/nav/check?id=${encodeURIComponent(nav.job.id)}&x=${nav.pick.xy[0]}&y=${nav.pick.xy[1]}`);
    if (token !== nav.pickToken) return;
    nav.pick.check = check;
  } catch (error) {
    if (token !== nav.pickToken) return;
    nav.pick.check = { ok: false, checks: [{ id: 'error', status: 'block', label: 'Check unavailable', detail: error.message }] };
  }
  emit('navigate:overlay'); renderLive();
}

export function overlay() {
  const n = navState(), live = isActive(nav.job);
  const walks = (n?.legs ?? []).filter(l => l.outcome).map(l => ({ xy: l.goal_xy, outcome: l.outcome, index: l.index }));
  const goal = live ? n?.goal : null;
  const status = nav.pick?.check ? (nav.pick.check.ok ? (nav.pick.check.checks.some(c => c.status === 'warn') ? 'warn' : 'pass') : 'block') : 'pending';
  // The planner memory's 12 x 12 m square: from the map file (simulated robot) or the link's assumed origin (robot).
  const m = n?.memory, bounds = m?.origin_xy ? [m.origin_xy[0] - m.half_extent_m, m.origin_xy[1] - m.half_extent_m, m.origin_xy[0] + m.half_extent_m, m.origin_xy[1] + m.half_extent_m]
    : nav.mapBounds;
  return { pick: live ? nav.pick?.xy : null, pickStatus: status, path: live ? nav.pick?.check?.path_xy : null,
    goal: goal?.xy ?? null, staged: !!goal && n?.phase !== 'RUN' && n?.phase !== 'PRESCAN' && n?.can?.go, walks: live ? walks : [],
    goalUnverified: !!(goal && goal.verification && goal.verification !== 'verified'),
    bounds: live ? bounds : null, boundsLabel: m?.origin_xy ? 'planner memory · assumed' : 'planner memory', radius: 0.4 };
}

// ----- rendering ------------------------------------------------------------
export function render() {
  const root = $('navigate-panel'); if (!root || !nav.catalog) return;
  const live = isActive(nav.job);
  if (live) nav.robot = isReal(nav.job) ? 'real' : 'simulated';
  root.innerHTML = `
    <section class="panel-section nav-robot">
      <div class="segmented wide" role="group" aria-label="Robot">
        <button data-robot="simulated" aria-pressed="${nav.robot === 'simulated'}" ${live ? 'disabled' : ''}>Simulated robot</button><button data-robot="real" aria-pressed="${nav.robot === 'real'}" ${live ? 'disabled' : ''}>Real robot</button>
      </div>
    </section>
    ${live || nav.finished ? '<div id="nav-live"></div>' : nav.robot === 'simulated' ? setupForm() : realRobotCard()}`;
  root.querySelectorAll('[data-robot]').forEach(b => b.addEventListener('click', () => { nav.robot = b.dataset.robot; nav.finished = null; render(); if (nav.robot === 'real') loadRobotLink(); }));
  if (live || nav.finished) renderLive(); else bindSetup(root);
}

function setupForm() {
  const worlds = runnableWorlds(), list = starts();
  const option = (value, text, selected) => `<option value="${escape(value)}" ${selected ? 'selected' : ''}>${escape(text)}</option>`;
  return `
    <section class="panel-section">
      <h4>World</h4>
      <p class="tiny">The robot stands in this world and knows it only through its own LiDAR, as on a real site.</p>
      <label class="field"><span>World</span><select id="nav-world">${worlds.map(m => option(m.id, m.label, m.id === nav.mapId)).join('')}</select></label>
      <label class="field"><span>Start</span><select id="nav-start">${list.map((q, i) => option(i, `${q.label} · (${num(q.start_xy[0], 1)}, ${num(q.start_xy[1], 1)})`, i === nav.presetIndex)).join('')}</select></label>
      <details class="nav-advanced"><summary>Advanced</summary>
        <label class="field"><span>Planner budget</span><select id="nav-planner">${Object.entries(nav.catalog.nav_options?.planner ?? { quick: 'Quick · K 2, ODE 4 (CPU)', balanced: 'Balanced · K 8, ODE 6', deployed: 'Deployed budget · K 16, ODE 10 (slow on CPU)' }).map(([k, v]) => option(k, v, k === nav.settings.planner)).join('')}</select></label>
        <label class="field"><span>Planner latency</span><select id="nav-latency">${Object.entries(LATENCY).map(([k, v]) => option(k, v.label, k === nav.settings.latency)).join('')}</select></label>
        <label class="field"><span>Hardware limits</span><select id="nav-actuators">${Object.entries(ACTUATORS).map(([k, v]) => option(k, v, k === nav.settings.actuators)).join('')}</select></label>
        <label class="field"><span>Odometry</span><select id="nav-odometry">${Object.entries(ODOMETRY).map(([k, v]) => option(k, v, k === nav.settings.odometry)).join('')}</select></label>
        <label class="field narrow"><span>Seed</span><input id="nav-seed" type="number" min="0" step="1" value="${nav.settings.seed}"></label>
      </details>
      <p class="tiny">Policy: the frozen Flow student (deploy bundle), the one policy that plans from the robot's own LiDAR. Simulated time pauses while the robot waits for you.</p>
      ${nav.notice ? `<div class="callout ${nav.notice.kind === 'ok' ? '' : 'warning'}">${escape(nav.notice.text)}</div>` : ''}
      <button id="nav-start-session" class="primary-action wide-button" ${nav.busy || !nav.mapId ? 'disabled' : ''}>Start session</button>
    </section>
    ${recentSessions()}
    ${nav.finished ? '' : sessionHelp()}`;
}

function recentSessions() {
  const list = (nav.sessions ?? []).filter(s => s.group === 'Navigation sessions' && s.available && s.status !== 'running')
    .sort((a, b) => (b.started_unix_s ?? 0) - (a.started_unix_s ?? 0)).slice(0, 5);
  if (!list.length) return '';
  return `<section class="panel-section"><h4>Recent sessions</h4><ul class="nav-recent">${list.map(s => `<li>
    <button class="link-button" data-open-session="${escape(s.id)}">${escape((s.scenario_label ?? s.label ?? s.id).replace(/^Navigate · /, ''))}</button>
    <small>${s.robot === 'real' ? 'real robot · ' : ''}${Number.isFinite(s.walks) ? `${s.arrived ?? 0}/${s.walks} walks arrived` : escape(s.status ?? '')} · #${escape(s.id.slice(-6))}</small></li>`).join('')}</ul></section>`;
}

async function refreshSessions() {
  try { nav.sessions = (await request('/api/sessions')).sessions ?? []; } catch { nav.sessions = []; }
}

function sessionHelp() {
  return `<section class="panel-section nav-steps"><h4>How it works</h4><ol class="tiny">
    <li>Start: the robot stands and scans what it can see.</li>
    <li>Click the map to place a goal. Studio checks it on the robot's map.</li>
    <li>Send the goal, then Go. Watch the plan, path and health live.</li>
    <li>It arrives and stands. Place the next goal; the map keeps growing.</li>
    <li>End the session: the recording opens in Replay, and the map can become an arena twin.</li></ol></section>`;
}

function bindSetup(root) {
  root.querySelector('#nav-world')?.addEventListener('change', e => selectWorld(e.target.value).catch(err => { nav.notice = { kind: 'warning', text: err.message }; render(); }));
  root.querySelector('#nav-start')?.addEventListener('change', e => { nav.presetIndex = Number(e.target.value); });
  for (const [id, key] of [['nav-planner', 'planner'], ['nav-latency', 'latency'], ['nav-actuators', 'actuators'], ['nav-odometry', 'odometry']])
    root.querySelector(`#${id}`)?.addEventListener('change', e => { nav.settings[key] = e.target.value; });
  root.querySelector('#nav-seed')?.addEventListener('change', e => { nav.settings.seed = Math.max(0, Math.floor(Number(e.target.value) || 0)); });
  root.querySelector('#nav-start-session')?.addEventListener('click', startSession);
  root.querySelectorAll('[data-open-session]').forEach(b => b.addEventListener('click', () => emit('open-session', b.dataset.openSession)));
}

function realRobotCard() {
  const link = nav.robotLink;
  const configured = link?.configured;
  return `<section class="panel-section">
    <h4>Real robot</h4>
    <p class="tiny">Studio runs on the deploy PC next to <code>node.py</code>, the SONIC runner and the LIO bridge, and reads their loopback streams. It can stage a goal and ask for a stand. <strong>It never starts a walk</strong>: Go stays with the operator (<code>g</code> on the console or F1 on the remote), and the remote and the physical E-stop stay in hand.</p>
    ${link === null ? '<p class="tiny">Checking the robot link configuration…</p>' : configured
      ? `<div class="nav-endpoints">${(link.endpoints ?? []).map(e => `<div><span>${escape(e.id)}</span><code>${escape(e.endpoint)}</code></div>`).join('')}</div>
         ${nav.notice ? `<div class="callout warning">${escape(nav.notice.text)}</div>` : ''}
         <p class="tiny">Goals up to ${num(link.max_goal_distance_m ?? 3, 1)} m from the robot (<code>limits.max_goal_distance_m</code>).</p>
         <button id="nav-connect" class="primary-action wide-button" ${nav.busy ? 'disabled' : ''}>Connect to the robot</button>`
      : `<div class="callout">${escape(link?.reason ?? 'The robot link is not configured.')}</div>
         <p class="tiny">Copy <code>config/robot_link.example.json</code> to <code>config/robot_link.json</code> on the deploy PC (loopback endpoints; see docs/NAVIGATE.md). Until then, rehearse the same workflow with the simulated robot.</p>`}
  </section>
  <section class="panel-section nav-steps"><h4>On the robot day</h4><ol class="tiny">
    <li>Calibrate the LiDAR mount and run <code>./g1 check</code>.</li>
    <li>Start the runner and the node with the console using LIO odometry (<code>./g1 robot … --odom zmq</code>) and the bridge with <code>--forward-cloud</code>, so the node and Studio share one frame and Studio sees the LiDAR. Then connect here.</li>
    <li>Click a goal on the live map, send it, and press <code>g</code> / F1 when the area is clear.</li>
    <li>Watch the plan and health. Remote D-up or Select at any surprise.</li></ol></section>`;
}

async function loadRobotLink() {
  nav.robotLink = null; render();
  try { nav.robotLink = await request('/api/nav/robot'); }
  catch (error) { nav.robotLink = { configured: false, reason: error.message }; }
  render();
  $('nav-connect')?.addEventListener('click', connectRobot);
}

async function connectRobot() {
  nav.busy = true; nav.notice = null; render();
  try {
    nav.job = await request('/api/nav/connect', {});
    nav.lastPerception = -Infinity; nav.pick = null;
    emit('navigate:started', nav.job); schedule(300);
  } catch (error) { nav.notice = { kind: 'warning', text: error.message }; }
  finally { nav.busy = false; render(); }
}

function checkList(check) {
  if (!check) return '<p class="tiny">Checking on the robot\'s map…</p>';
  const path = finite(check.path_m) ? ` · path ${num(check.path_m, 1)} m` : '';
  return `<ul class="nav-checks">${check.checks.map(c => `<li class="${c.status}" title="${escape(c.detail ?? '')}"><i>${CHECK_ICON[c.status] ?? '?'}</i><span><strong>${escape(c.label)}</strong>${c.detail ? `<small>${escape(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
    <p class="tiny">Straight ${num(check.straight_m, 1)} m${path} · checked on the ${escape(check.grid?.basis ?? 'map')}</p>`;
}

function facts(job) {
  const n = navState(), latest = job?.latest ?? {}, frame = latest.frame, progress = latest.progress ?? {};
  const real = latest.robot === 'real' || job?.kind === 'robot', goal = n?.goal, coverage = n?.map?.observed_fraction;
  const v = frame?.post_action?.root_linear_velocity_w ?? frame?.linear_velocity_w;
  const speed = Array.isArray(v) ? Math.hypot(v[0], v[1]) : null, rtf = progress.real_time_factor;
  return `<div><span>Map seen</span><strong>${finite(coverage) ? `${num(coverage * 100, 0)} %` : '—'}</strong><small>${escape(n?.map?.basis ?? '')}</small></div>
    <div><span>To goal</span><strong>${finite(n?.goal_dist_m) ? `${num(n.goal_dist_m, 2)} m` : '—'}</strong><small>${goal ? `(${num(goal.xy[0], 2)}, ${num(goal.xy[1], 2)})` : 'no goal'}</small></div>
    <div><span>Speed</span><strong>${finite(speed) ? `${num(speed, 2)} m/s` : '—'}</strong><small>${real ? 'LIO estimate' : 'sim truth'}</small></div>
    <div><span>${real ? 'Elapsed' : 'Sim time'}</span><strong>${num(progress.simulation_time_s ?? progress.elapsed_s ?? 0, 1)} s</strong><small>${finite(rtf) ? `${num(rtf, 2)}× real time` : real ? 'live' : ''}</small></div>`;
}

// The panel is rebuilt only when its structure changes (phase, permissions, goal, walks, notices):
// rebuilding on every poll would swallow clicks on Stand while the robot walks.
function structureKey(job) {
  const n = navState();
  return JSON.stringify([job?.id, job?.status, n?.phase, n?.paused, n?.can, n?.goal?.seq, n?.fallen, n?.pending_stand, n?.holding_plan_end,
    (n?.legs ?? []).map(l => [l.index, l.outcome]), (n?.streams ?? []).map(s => s.status), nav.pick, nav.notice, nav.busy, nav.showTruth,
    n?.goal?.verification, n?.goal_warning, (n?.ready ?? []).map(r => r.status), n?.can_reasons?.goal, n?.phase_status, endOverdue()]);
}
const endOverdue = () => !!nav.endRequestedAt && Date.now() - nav.endRequestedAt > 12000;

function readyList(n) {
  const items = n?.ready ?? [];
  if (!items.length) return '';
  // Name what fails, in the negative: the items' own labels state the condition that must hold.
  const FAILS = { node_status: 'node status not fresh', odometry: 'LIO odometry not fresh', frame: "node frame does not match LIO",
    still: 'robot not still', goal_verified: 'node goal not verified by Studio', goal_range: 'goal outside the memory or the distance limit',
    stand: 'stand deferred' };
  const blocks = items.filter(r => r.status === 'block').map(r => FAILS[r.id] ?? r.label);
  return `<section class="panel-section nav-ready"><h4>Before g on the console</h4>
    <div class="callout ${n.ready_ok ? 'ok' : 'danger'}">${n.ready_ok ? 'Ready: the operator may press g (or F1) once the area is clear.' : `Not ready, do not press g: ${escape(blocks.join('; ') || 'see below')}.`}</div>
    <ul class="nav-checks">${items.map(r => `<li class="${r.status}" title="${escape(r.detail ?? '')}"><i>${CHECK_ICON[r.status] ?? '?'}</i><span><strong>${escape(r.label)}</strong>${r.detail ? `<small>${escape(r.detail)}</small>` : ''}</span></li>`).join('')}</ul></section>`;
}

function nodeGoal(n) {
  const g = n?.goal;
  if (!g) return '<p class="tiny">The node reports no goal yet.</p>';
  const chip = { verified: ['VERIFIED BY STUDIO', 'chip-measured'], unverified: ['UNVERIFIED', 'chip-unavailable'], external: ['NOT FROM STUDIO', 'chip-unavailable'] }[g.verification] ?? ['UNKNOWN', 'chip-unavailable'];
  return `<div class="nav-node-goal"><span>Node goal <strong>(${num(g.xy[0], 2)}, ${num(g.xy[1], 2)})</strong></span><span class="chip ${chip[1]}">${chip[0]}</span></div>
    ${g.detail ? `<p class="tiny">${escape(g.detail)}</p>` : ''}`;
}

export function renderLive() {
  const root = $('nav-live'); if (!root) return;
  const job = nav.job, n = navState(), live = isActive(job);
  if (!live) { root.innerHTML = finishedCard(job); root.dataset.key = ''; bindFinished(root); return; }
  const key = structureKey(job);
  if (root.dataset.key === key) {
    // Facts and walk rows change every poll; they hold no buttons, so they update in place.
    const f = root.querySelector('.nav-facts'); if (f) f.innerHTML = facts(job);
    const w = root.querySelector('.nav-walks-host'); if (w) w.innerHTML = walksList(n?.legs ?? []);
    return;
  }
  root.dataset.key = key;
  const real = isReal(job);
  const [phaseText, tone] = phaseLabel(n, real);
  const can = n?.can ?? {};
  const goal = n?.goal;
  const legs = n?.legs ?? [];
  const pick = nav.pick;
  root.innerHTML = `
    <section class="panel-section nav-status">
      <div class="nav-phase"><span class="outcome ${tone}">${escape(phaseText)}</span>${n?.paused && !real ? '<span class="tiny">simulation paused</span>' : ''}</div>
      ${!n ? `<p class="tiny">${real ? 'Connecting to the deploy PC streams…' : 'Loading the planner and SONIC on the CPU (about 10–30 s)…'}</p>` : ''}
      ${job.status === 'detached' ? '<div class="callout warning">This robot link was started by a previous gateway and is still running. Watch it here; End stops it.</div>' : ''}
      <div class="nav-facts">${facts(job)}</div>
      ${n?.pending_stand ? (real
        ? `<div class="callout danger">The node is deferring its stand (${escape(n.pending_stand)}): its map shows something overhead below head height near the robot, so the robot keeps playing its last plan. Use the remote's D-up only if nothing is overhead; Select is the E-stop.</div>`
        : `<div class="callout warning">Stand deferred: the robot's map shows something overhead below head height within 0.8 m, so node.py lets the current plan play out first${n.holding_plan_end ? '. The plan has ended and the robot holds its last pose' : ''}. Take over to stand it now (the remote's D-up); Studio forces it after 20 s. <button id="nav-takeover" class="link-button">Take over</button></div>`) : ''}
      ${n?.fallen ? '<div class="callout warning">E-stop: the robot tilted past the supervisor limit. On the robot the runner switches to damping. End the session to keep the recording.</div>' : ''}
      ${(n?.streams ?? []).filter(s => (s.status === 'stale' || s.status === 'unavailable')
          // The node streams plans only while walking: a quiet pose stream while standing is expected.
          && !(s.id === 'pose' && !['PRESCAN', 'RUN'].includes(n?.phase))).map(s => `<div class="callout warning">${escape(s.label)}: ${escape(s.status)}${finite(s.age_s) ? ` · ${num(s.age_s, 1)} s old` : ''}</div>`).join('')}
    </section>
    <section class="panel-section nav-goal">
      <h4>Goal</h4>
      ${real ? nodeGoal(n) : ''}
      ${real && n?.goal_warning ? `<div class="callout danger">${escape(n.goal_warning)}</div>` : ''}
      ${pick ? `<div class="nav-pick"><strong>(${num(pick.xy[0], 2)}, ${num(pick.xy[1], 2)})</strong><button id="nav-clear-pick" class="link-button">Clear</button></div>${checkList(pick.check)}`
        : !real && goal && can.go ? `<p class="tiny">Goal staged at (${num(goal.xy[0], 2)}, ${num(goal.xy[1], 2)}). Press Go, or click elsewhere to change it.</p>`
        : can.goal ? '<p class="tiny nav-hint">Click the map to place a goal.</p>'
        : `<p class="tiny">${escape(n?.can_reasons?.goal ?? 'Goals are placed while the robot stands.')}</p>`}
      <div class="tool-row">
        <button id="nav-send" class="primary-action" ${pick?.check?.ok && can.goal && !nav.busy ? '' : 'disabled'}>Send goal</button>
        ${real ? '' : `<button id="nav-go" class="primary-action" ${can.go && !nav.busy ? '' : 'disabled'}>▶ Go</button>`}
        <button id="nav-stand" ${can.stand && !nav.busy ? '' : 'disabled'} title="Settle to a stand (not an emergency stop)">■ Stand</button>
      </div>
      ${real ? `<div class="callout">${escape(n?.go_note ?? 'Start the walk with g on the console or F1 on the remote. Studio never sends Go to the robot.')}</div>` : ''}
      ${nav.notice ? `<div class="callout ${nav.notice.kind === 'ok' ? 'ok' : 'warning'}">${escape(nav.notice.text)}</div>` : ''}
    </section>
    ${real ? readyList(n) : ''}
    <section class="panel-section">
      <h4>Walks</h4>
      <div class="nav-walks-host">${walksList(legs)}</div>
    </section>
    <section class="panel-section">
      ${real ? '' : `<label class="check"><input id="nav-truth" type="checkbox" ${nav.showTruth ? 'checked' : ''}> Show the true world (simulation only; the robot does not see it)</label>`}
      <div class="tool-row nav-session-actions"><button id="nav-end" class="danger" ${(can.end || job.status === 'detached') && !nav.busy ? '' : 'disabled'}>End session</button>
        ${endOverdue() ? '<button id="nav-force" class="danger" title="Stop the session process now (its recording may be incomplete)">Force stop</button>' : ''}</div>
      <p class="tiny">${real ? 'Ending stops Studio\'s link only; nothing is sent to the robot.' : 'Ending stands the robot, saves the recording and the map, and opens it in Replay.'}</p>
    </section>`;
  bindLive(root);
}

function walksList(legs) {
  return legs.length ? `<ol class="nav-walks">${legs.map(walkRow).join('')}</ol>` : '<p class="tiny">No walks yet.</p>';
}

function walkRow(l) {
  const outcome = l.outcome ?? 'walking';
  const tone = { arrived: 'outcome-good', walking: 'outcome-live', stopped: 'outcome-warn', timeout: 'outcome-warn', estop: 'outcome-bad', session_end: 'outcome-muted' }[outcome] ?? 'outcome-muted';
  const text = { arrived: 'Arrived', walking: 'Walking', stopped: 'Stopped', timeout: 'Timed out', estop: 'E-stop', session_end: 'Session ended' }[outcome] ?? outcome;
  return `<li><span class="outcome ${tone}">${escape(text)}</span><span>to (${num(l.goal_xy?.[0], 1)}, ${num(l.goal_xy?.[1], 1)})</span>
    <small>${finite(l.final_dist_m) ? `${num(l.final_dist_m, 2)} m off${finite(l.final_dist_true_m) && l.distance_basis && l.distance_basis !== 'Simulator truth' ? ` (estimate; ${num(l.final_dist_true_m, 2)} m true)` : ''} · ` : ''}${l.goal_source && l.goal_source !== 'studio' ? `goal ${escape(l.goal_source)} · ` : ''}${finite(l.duration_s) ? `${num(l.duration_s, 1)} s · ` : ''}${finite(l.path_m) ? `${num(l.path_m, 1)} m walked` : ''}${l.max_contact_n > 5 ? ` · contact ${num(l.max_contact_n, 0)} N` : ''}${l.reason ? ` · ${escape(l.reason)}` : ''}</small></li>`;
}

function bindLive(root) {
  root.querySelector('#nav-clear-pick')?.addEventListener('click', () => { nav.pick = null; emit('navigate:overlay'); renderLive(); });
  root.querySelector('#nav-send')?.addEventListener('click', () => nav.pick && command('goal', { xy: nav.pick.xy }));
  root.querySelector('#nav-go')?.addEventListener('click', () => command('go'));
  root.querySelector('#nav-stand')?.addEventListener('click', () => command('stand'));
  root.querySelector('#nav-takeover')?.addEventListener('click', () => command('takeover'));
  root.querySelector('#nav-end')?.addEventListener('click', () => command('end'));
  root.querySelector('#nav-force')?.addEventListener('click', async () => {
    try { await request('/api/jobs/cancel', { id: nav.job.id }); nav.notice = { kind: 'warning', text: 'Force-stopped the session process.' }; }
    catch (error) { nav.notice = { kind: 'warning', text: error.message }; }
    schedule(200);
  });
  root.querySelector('#nav-truth')?.addEventListener('change', e => { nav.showTruth = e.target.checked; emit('navigate:layers'); });
}

function finishedCard(job) {
  if (!job) return '';
  const report = job.summary?.report ?? {};
  const legs = report.legs ?? job.latest?.navigation?.legs ?? [];
  const ok = job.status === 'completed';
  return `<section class="panel-section">
      <div class="nav-phase"><span class="outcome ${ok ? 'outcome-good' : 'outcome-bad'}">${ok ? 'Session saved' : `Session ${escape(job.status)}`}</span></div>
      <p class="tiny">${ok ? `${report.arrived ?? 0} of ${report.walks ?? legs.length} walks arrived · ${num(report.motion_s ?? 0, 1)} s of motion${finite(report.worker_real_time_factor) ? ` at ${num(report.worker_real_time_factor, 2)}× real time` : ''}. ${escape(report.end_reason ?? '')}` : escape(job.error ?? 'No recording was saved.')}</p>
      ${legs.length ? `<ol class="nav-walks">${legs.map(walkRow).join('')}</ol>` : ''}
      <div class="tool-row">
        ${job.result_session_id ? '<button id="nav-open-replay">Open in Replay</button>' : ''}
        ${ok ? `<button id="nav-twin" title="Fit boxes to ${job.kind === 'robot' ? "Studio's reconstruction of the robot's LiDAR" : "the robot's map"} and save them as a new arena">Make an arena twin</button>` : ''}
      </div>
      ${nav.notice ? `<div class="callout ${nav.notice.kind === 'ok' ? 'ok' : 'warning'}">${escape(nav.notice.text)}${nav.notice.arena ? ` <button class="link-button" data-open-arena="${escape(nav.notice.arena)}">Open the arena</button>` : ''}</div>` : ''}
      <button id="nav-new" class="primary-action wide-button">New session</button>
    </section>`;
}

function bindFinished(root) {
  root.querySelector('#nav-open-replay')?.addEventListener('click', () => emit('open-session', nav.job.result_session_id));
  root.querySelector('#nav-new')?.addEventListener('click', async () => {
    nav.job = null; nav.finished = null; nav.notice = null; nav.pick = null; nav.endRequestedAt = null; emit('navigate:overlay');
    await refreshSessions(); render();
  });
  root.querySelector('#nav-twin')?.addEventListener('click', makeTwin);
  root.querySelector('[data-open-arena]')?.addEventListener('click', e => emit('rehearse:edit-arena', e.target.dataset.openArena));
}

async function makeTwin() {
  nav.busy = true; renderLive();
  try {
    const result = await request('/api/nav/twin', { id: nav.job.id });
    const q = result.quality;
    nav.notice = { kind: 'ok', arena: result.arena_id,
      text: `Saved arena “${result.label}” with ${result.boxes} boxes${q ? ` (footprint match ${num(q.occupancy_iou * 100, 0)} % of the true world, ${q.true_boxes_found}/${q.true_boxes_total} obstacles found)` : ''}.` };
    emit('arena:saved');
  } catch (error) { nav.notice = { kind: 'warning', text: error.message }; }
  finally { nav.busy = false; renderLive(); }
}

on('navigate:refresh', () => render());
