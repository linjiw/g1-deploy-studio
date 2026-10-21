// Navigate: put goals on the robot's own map and watch it walk there (docs/NAVIGATE.md).
// The simulated robot is an owned CPU process that behaves like g1deploy/node.py; the real robot is
// reached only through the robot link (goal and stand to node.py; Go stays with the operator).
import { $, escape, num, request, emit, on, finite } from './util.js';

export const nav = {
  catalog: null, robot: 'simulated', mapId: null, map: null, presetIndex: 0,
  settings: { planner: 'quick', latency: 'none', actuators: 'g1-current', odometry: 'truth', seed: 0 },
  job: null, timer: null, pick: null, busy: false, lastPerception: -Infinity, pendingSeq: null, notice: null,
  showTruth: false, robotLink: null, finished: null,
};

const ACTIVE = ['starting', 'running', 'cancelling'];
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

const isActive = job => job && ACTIVE.includes(job.status);
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
    const live = jobs.find(j => ['navigation', 'robot'].includes(j.kind) && ACTIVE.includes(j.status));
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
    nav.job = job;
    resolvePending();
    emit('navigate:job', job);
    renderLive();
    if (isActive(job)) schedule(navState()?.paused ? 500 : 250);
    else if (wasActive) { nav.finished = job; emit('navigate:finished', job); render(); }
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
  else {
    nav.notice = { kind: 'ok', text: { goal: 'Goal staged. Press Go to walk there.', go: 'Walking.', stand: 'Settling to a stand.', end: 'Ending the session…', clear: 'Goal cleared.' }[reply.cmd] ?? 'Done.' };
    if (reply.cmd === 'goal') nav.pick = null;
  }
  emit('navigate:overlay');
}
const label = cmd => ({ goal: 'Goal', go: 'Go', stand: 'Stand', end: 'End', clear: 'Clear' }[cmd] ?? cmd);

async function command(cmd, extra = {}) {
  if (!nav.job || nav.busy) return;
  nav.busy = true; nav.notice = null; renderLive();
  try {
    const result = await request('/api/nav/command', { id: nav.job.id, cmd, ...extra });
    nav.pendingSeq = result.seq;
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
    nav.notice = { kind: 'warning', text: n.phase === 'RUN' || n.phase === 'PRESCAN' ? 'Goals are placed while the robot stands, as on the robot. Press Stand first or wait for it to arrive.' : 'The robot cannot take a goal right now.' };
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
  return { pick: live ? nav.pick?.xy : null, pickStatus: status, path: live ? nav.pick?.check?.path_xy : null,
    goal: goal?.xy ?? null, staged: !!goal && n?.phase !== 'RUN' && n?.phase !== 'PRESCAN' && n?.can?.go, walks: live ? walks : [],
    radius: 0.4 };
}

// ----- rendering ------------------------------------------------------------
export function render() {
  const root = $('navigate-panel'); if (!root || !nav.catalog) return;
  const live = isActive(nav.job);
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
         <button id="nav-connect" class="primary-action wide-button" ${nav.busy ? 'disabled' : ''}>Connect to the robot</button>`
      : `<div class="callout">${escape(link?.reason ?? 'The robot link is not configured.')}</div>
         <p class="tiny">Set the loopback endpoints in <code>config/local.json</code> under <code>robot_link</code> (see docs/NAVIGATE.md). Until then, rehearse the same workflow with the simulated robot.</p>`}
  </section>
  <section class="panel-section nav-steps"><h4>On the robot day</h4><ol class="tiny">
    <li>Calibrate the LiDAR mount and run <code>./g1 check</code>.</li>
    <li>Start the runner, the node and the LIO bridge with the console, then connect here.</li>
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
  const v = frame?.post_action?.root_linear_velocity_w ?? frame?.velocity_w;
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
  return JSON.stringify([job?.id, job?.status, n?.phase, n?.paused, n?.can, n?.goal?.seq, n?.fallen, n?.pending_stand,
    (n?.legs ?? []).map(l => [l.index, l.outcome]), (n?.streams ?? []).map(s => s.status), nav.pick, nav.notice, nav.busy, nav.showTruth]);
}

export function renderLive() {
  const root = $('nav-live'); if (!root) return;
  const job = nav.job, n = navState(), live = isActive(job);
  if (!live) { root.innerHTML = finishedCard(job); root.dataset.key = ''; bindFinished(root); return; }
  const key = structureKey(job);
  if (root.dataset.key === key) { const f = root.querySelector('.nav-facts'); if (f) f.innerHTML = facts(job); return; }
  root.dataset.key = key;
  const latest = job.latest ?? {};
  const phase = n?.phase ?? 'BOOT', [phaseText, tone] = PHASE[phase] ?? [phase, 'outcome-live'];
  const real = latest.robot === 'real' || job.kind === 'robot';
  const can = n?.can ?? {};
  const goal = n?.goal;
  const legs = n?.legs ?? [];
  const pick = nav.pick;
  root.innerHTML = `
    <section class="panel-section nav-status">
      <div class="nav-phase"><span class="outcome ${tone}">${escape(phaseText)}</span>${n?.paused && !real ? '<span class="tiny">simulation paused</span>' : ''}</div>
      ${!n ? '<p class="tiny">Loading the planner and SONIC on the CPU (about 10–30 s)…</p>' : ''}
      <div class="nav-facts">${facts(job)}</div>
      ${n?.pending_stand ? `<div class="callout warning">Stand deferred under a low ceiling (${escape(n.pending_stand)}); the current plan plays out first, as node.py does.</div>` : ''}
      ${n?.fallen ? '<div class="callout warning">E-stop: the robot tilted past the supervisor limit. On the robot the runner switches to damping. End the session to keep the recording.</div>' : ''}
      ${(n?.streams ?? []).filter(s => s.status === 'stale' || s.status === 'unavailable').map(s => `<div class="callout warning">${escape(s.label)}: ${escape(s.status)}${finite(s.age_s) ? ` · ${num(s.age_s, 1)} s old` : ''}</div>`).join('')}
    </section>
    <section class="panel-section nav-goal">
      <h4>Goal</h4>
      ${pick ? `<div class="nav-pick"><strong>(${num(pick.xy[0], 2)}, ${num(pick.xy[1], 2)})</strong><button id="nav-clear-pick" class="link-button">Clear</button></div>${checkList(pick.check)}`
        : goal && can.go ? `<p class="tiny">Goal staged at (${num(goal.xy[0], 2)}, ${num(goal.xy[1], 2)}). ${real ? '' : 'Press Go, or click elsewhere to change it.'}</p>`
        : can.goal ? '<p class="tiny nav-hint">Click the map to place a goal.</p>'
        : '<p class="tiny">Goals are placed while the robot stands.</p>'}
      <div class="tool-row">
        <button id="nav-send" class="primary-action" ${pick?.check?.ok && can.goal && !nav.busy ? '' : 'disabled'}>Send goal</button>
        ${real ? '' : `<button id="nav-go" class="primary-action" ${can.go && !nav.busy ? '' : 'disabled'}>▶ Go</button>`}
        <button id="nav-stand" ${can.stand && !nav.busy ? '' : 'disabled'} title="Settle to a stand (not an emergency stop)">■ Stand</button>
      </div>
      ${real ? `<div class="callout">${escape(n?.go_note ?? 'Start the walk with g on the console or F1 on the remote. Studio never sends Go to the robot.')}</div>` : ''}
      ${nav.notice ? `<div class="callout ${nav.notice.kind === 'ok' ? 'ok' : 'warning'}">${escape(nav.notice.text)}</div>` : ''}
    </section>
    <section class="panel-section">
      <h4>Walks</h4>
      ${legs.length ? `<ol class="nav-walks">${legs.map(walkRow).join('')}</ol>` : '<p class="tiny">No walks yet.</p>'}
    </section>
    <section class="panel-section">
      <label class="check"><input id="nav-truth" type="checkbox" ${nav.showTruth ? 'checked' : ''} ${real ? 'disabled' : ''}> Show the true world${real ? '' : ' (simulation only; the robot does not see it)'}</label>
      <div class="tool-row nav-session-actions"><button id="nav-end" class="danger" ${can.end && !nav.busy ? '' : 'disabled'}>End session</button></div>
      <p class="tiny">${real ? 'Ending stops Studio\'s link only; nothing is sent to the robot.' : 'Ending stands the robot, saves the recording and the map, and opens it in Replay.'}</p>
    </section>`;
  bindLive(root);
}

function walkRow(l) {
  const outcome = l.outcome ?? 'walking';
  const tone = { arrived: 'outcome-good', walking: 'outcome-live', stopped: 'outcome-warn', timeout: 'outcome-warn', estop: 'outcome-bad', session_end: 'outcome-muted' }[outcome] ?? 'outcome-muted';
  const text = { arrived: 'Arrived', walking: 'Walking', stopped: 'Stopped', timeout: 'Timed out', estop: 'E-stop', session_end: 'Session ended' }[outcome] ?? outcome;
  return `<li><span class="outcome ${tone}">${escape(text)}</span><span>to (${num(l.goal_xy?.[0], 1)}, ${num(l.goal_xy?.[1], 1)})</span>
    <small>${finite(l.final_dist_m) ? `${num(l.final_dist_m, 2)} m off · ` : ''}${finite(l.duration_s) ? `${num(l.duration_s, 1)} s · ` : ''}${finite(l.path_m) ? `${num(l.path_m, 1)} m walked` : ''}${l.max_contact_n > 5 ? ` · contact ${num(l.max_contact_n, 0)} N` : ''}${l.reason ? ` · ${escape(l.reason)}` : ''}</small></li>`;
}

function bindLive(root) {
  root.querySelector('#nav-clear-pick')?.addEventListener('click', () => { nav.pick = null; emit('navigate:overlay'); renderLive(); });
  root.querySelector('#nav-send')?.addEventListener('click', () => nav.pick && command('goal', { xy: nav.pick.xy }));
  root.querySelector('#nav-go')?.addEventListener('click', () => command('go'));
  root.querySelector('#nav-stand')?.addEventListener('click', () => command('stand'));
  root.querySelector('#nav-end')?.addEventListener('click', () => command('end'));
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
        ${ok && job.kind !== 'robot' ? '<button id="nav-twin" title="Fit boxes to the robot\'s map and save them as a new arena">Make an arena twin</button>' : ''}
      </div>
      ${nav.notice ? `<div class="callout ${nav.notice.kind === 'ok' ? 'ok' : 'warning'}">${escape(nav.notice.text)}${nav.notice.arena ? ` <button class="link-button" data-open-arena="${escape(nav.notice.arena)}">Open the arena</button>` : ''}</div>` : ''}
      <button id="nav-new" class="primary-action wide-button">New session</button>
    </section>`;
}

function bindFinished(root) {
  root.querySelector('#nav-open-replay')?.addEventListener('click', () => emit('open-session', nav.job.result_session_id));
  root.querySelector('#nav-new')?.addEventListener('click', async () => {
    nav.job = null; nav.finished = null; nav.notice = null; nav.pick = null; emit('navigate:overlay');
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
