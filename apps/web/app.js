// G1 Deploy Studio browser entry: causal replay, owned CPU rehearsals and
// navigation arenas. The browser never talks to a robot, DDS or ZMQ.
import { $, escape, num, vector, clock, finite, hasPose, hasReferencePose, request, setToken, on, emit,
  updateView, updateViewSoon, EVIDENCE, chip, outcomeChip, yawOf } from './js/util.js';
import * as scene from './js/scene.js';
import { initTimeline, setTimelineSession, setTimelineCursor, refreshTimelineLive } from './js/timeline.js';
import { inspector, renderInspector, selectTab, sampleHealth, perceptionAt, systemDetails, fidelity } from './js/inspector.js';
import { selectPipelineStage } from './pipeline.js';
import { sn, initSensors, refreshSensors, renderSensors, resetSensors } from './js/sensors.js';
import { arena, initArena, renderPanel as renderArenaPanel, loadFromMap, fitArena, exportDocument as arenaDocument, activePreset } from './js/arena.js';
import { rh, initRehearse, render as renderRehearse, selectMap as rehearseSelectMap, previewMarkers } from './js/rehearse.js';
import { runs, initRuns, refreshRuns, drawCompare, selectedRuns, runColor } from './js/runs.js';
import { renderSystemMap, renderRobotContract, KIND_LABEL, sessionKind } from './js/system.js';

const state = {
  session: null, sessionId: null, frame: null, measuredFrame: null, frozenFrame: null, frameIndex: -1, time: 0,
  playing: false, speed: 1, loop: false, loading: false, loadGeneration: 0, runtime: null, liveStatus: null,
  workspace: 'replay', live: null, catalog: null, robot: null, sessions: [],
};
state.freeze = on_ => { state.frozenFrame = on_ ? state.frame : null; renderFrame(true); };

const WORKSPACES = {
  replay: { title: 'Replay', eyebrow: '', panel: null, stage: '3d' },
  arena: { title: 'Navigation arena', eyebrow: 'Build · obstacles · start / goal presets', panel: 'arena', stage: 'arena' },
  rehearse: { title: 'Rehearse a policy', eyebrow: 'Isolated CPU simulation · hardware disabled', panel: 'rehearse', stage: '3d' },
  runs: { title: 'Runs', eyebrow: 'Compare outcomes and trajectories', panel: 'runs', stage: 'runs' },
  sensors: { title: 'What the robot perceives', eyebrow: 'Causal sensor samples at the cursor', panel: 'sensors', stage: '3d' },
  system: { title: 'System', eyebrow: 'Pipeline · transports · Unitree contract', panel: 'system', stage: 'system' },
};

function showError(message) { $('error-banner').textContent = message; $('error-banner').hidden = false; clearTimeout(showError.t); showError.t = setTimeout(() => { $('error-banner').hidden = true; }, 9000); }
window.addEventListener('studio:error', e => showError(e.detail));
on('workbench:error', message => { $('workbench-error').textContent = message; $('workbench-error').hidden = false; });
on('arena:error', message => { $('workbench-error').textContent = message; $('workbench-error').hidden = false; });

// ------------------------------------------------------------------ sessions
const OUTCOME_MARK = { goal_completion: '✓', timeout: '⏱', obstacle_collision: '✕', fall: '✕', runtime_error: '✕' };
function sessionOption(s) {
  const mark = s.status === 'running' ? '●' : OUTCOME_MARK[s.outcome] ?? '';
  const policy = s.policy_id && s.policy_id !== 'flow-bundle-20261008' ? ` · ${s.policy_id.replace('flow-', '').replace(/-s\d$/, '')}` : '';
  return `<option value="${escape(s.id)}" ${s.available ? '' : 'disabled'}>${mark ? mark + ' ' : ''}${escape(s.label ?? s.id)}${policy}${s.id.startsWith('job-') ? ` · #${escape(s.id.slice(-6))}` : ''}</option>`;
}
async function refreshSessionList(selected = state.sessionId) {
  const { sessions } = await request('/api/sessions');
  state.sessions = sessions;
  const groups = new Map();
  const ordered = [...sessions].sort((a, b) => (b.started_unix_s ?? 0) - (a.started_unix_s ?? 0));
  for (const s of ordered) { const g = s.group ?? 'Recordings'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  const order = ['CPU rehearsals', 'Recordings'];
  $('session-picker').innerHTML = [...groups.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
    .map(([g, list]) => `<optgroup label="${escape(g)}">${list.map(sessionOption).join('')}</optgroup>`).join('');
  if (selected && sessions.some(s => s.id === selected)) $('session-picker').value = selected;
  return sessions;
}

function selectedFrame(time) {
  const frames = state.session.frames; let lo = 0, hi = frames.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (frames[mid].time <= time) lo = mid + 1; else hi = mid; }
  return Math.max(0, lo - 1);
}

async function loadSession(id, { keepCamera = false } = {}) {
  const generation = ++state.loadGeneration;
  state.loading = true; setPlaying(false);
  $('loading-overlay').hidden = false; $('error-banner').hidden = true;
  try {
    const session = await request(`/api/session?id=${encodeURIComponent(id)}`, undefined, { cache: 'no-cache' });
    if (generation !== state.loadGeneration) return false;
    if (session.schema_version !== 1 || !session.frames?.length) throw new Error('Unsupported or empty recording. Expected telemetry schema v1.');
    Object.assign(state, { session, sessionId: id, time: session.frames[0].time, frameIndex: -1, frame: null, measuredFrame: null,
      frozenFrame: null, runtime: null, liveStatus: null });
    inspector.jointsSession = null;
    resetSensors();
    scene.setArenaPreview(null);
    const m = session.metadata;
    $('session-title').textContent = m.title ?? id; $('session-title').title = m.source_path ?? '';
    $('footer-source').textContent = m.source_path ?? '';
    $('timeline').min = String(session.frames[0].time); $('timeline').max = String(m.duration_s); $('timeline').value = String(state.time);
    $('duration-time').textContent = clock(m.duration_s);
    const hasState = session.frames.some(hasPose), hasRef = session.frames.some(hasReferencePose);
    for (const [layer, enabled] of [['robot', hasState], ['future', hasState], ['trajectory', hasState], ['environment', hasState], ['frames', hasState], ['reference', hasRef]]) $(`layer-${layer}`).disabled = !enabled;
    $('layer-perception').disabled = !session.perception?.available;
    $('layer-perception').checked = !!session.perception?.available && new URLSearchParams(location.search).get('map') === '1';
    syncLayers();
    $('scene-unavailable').hidden = hasState;
    updateModeBadge(); updatePolicyChip(); updateRecordingWarning();
    $('playback-state').textContent = m.mode === 'simulation' ? 'LIVE' : 'PAUSED';
    setTimelineSession(session);
    renderFrame(true);
    const built = await scene.loadSessionScene(session, id, () => generation === state.loadGeneration);
    if (!built || generation !== state.loadGeneration) return false;
    $('loading-overlay').hidden = true;
    // Navigation runs open on the full scene; others on the robot (review UX-2).
    if (!keepCamera) cameraView(m.goal_xy ? 'scene' : 'orbit', true);
    renderFrame(true);
    updateView({ session: id });
    if (![...$('session-picker').options].some(o => o.value === id)) await refreshSessionList(id);
    $('session-picker').value = id;
    emit('session', { session, id });
    refreshSensors(state, true);
    return true;
  } catch (error) {
    if (generation === state.loadGeneration) { $('loading-overlay').hidden = true; showError(`Cannot open this recording: ${error.message}`); console.error(error); }
    return false;
  } finally {
    if (generation === state.loadGeneration) state.loading = false;
  }
}

function updateModeBadge() {
  const m = state.session?.metadata ?? {};
  const live = m.mode === 'simulation';
  $('mode-badge').textContent = live ? '● LIVE CPU SIMULATION · L1' : m.recording_kind === 'sonic-mujoco-lockstep' ? 'REPLAY · CPU REHEARSAL · L1' : m.recording_kind === 'recorded-wire-transport' ? 'REPLAY · ZMQ CAPTURE · L0' : 'REPLAY · L0';
  const fid = fidelity(m);
  $('mode-badge').title = `${fid.label}. Proves: ${fid.proves} Hides: ${fid.hides}`;
  $('mode-badge').classList.toggle('sim', live);
  const result = m.test_result;
  $('run-outcome').innerHTML = live ? outcomeChip(null, 'running') : result?.outcome ? outcomeChip(result.outcome) : '';
  $('run-outcome').title = result?.outcome ? `Whole-run source scorer outcome · ${num(result.elapsed_s, 2, 's')} · final ${num(result.final_goal_distance_xy_m, 2, 'm')}` : '';
}
function updatePolicyChip() {
  const meta = state.session?.metadata ?? {};
  const p = meta.policy_profile ?? (meta.policy_identity ? { label: meta.policy_identity.split(' + ')[0].replace('Frozen ', 'frozen ') } : null);
  const chipEl = $('policy-chip');
  if (!p) { chipEl.hidden = true; return; }
  chipEl.hidden = false;
  chipEl.innerHTML = p.research_block ? `Policy <strong>${escape(p.research_block)}-RF</strong> @ ${escape(String(p.revision).slice(0, 7))}` : `Policy <strong>${escape(p.label ?? p.id)}</strong>`;
  chipEl.title = `${p.label ?? p.id}${p.config_sha256 ? ` · config ${p.config_sha256.slice(0, 12)}` : ''}${p.identity_sha256 ? ` · identity ${p.identity_sha256.slice(0, 12)}` : ''}`;
}
function updateRecordingWarning() {
  const m = state.session?.metadata ?? {};
  const node = $('recording-warning');
  if (m.mode === 'simulation') {
    node.hidden = state.liveStatus !== 'failed';
    node.textContent = `WORKER FAILED · ${m.termination_reason ?? m.error ?? 'The worker stopped before normal completion.'} Showing received live samples; open the recorded failure for all captured execution.`;
    return;
  }
  node.hidden = !m.incomplete && m.recording_complete !== false;
  node.textContent = `INCOMPLETE RECORDING · ${m.termination_reason ?? m.error ?? 'Stopped before normal completion.'} Executed motion is shown up to the last captured sample. This is a recorded failure, not a navigation success.`;
}

// ------------------------------------------------------------------ frame rendering
let lastHud = 0, lastSensorFetch = 0;
function renderFrame(force = false) {
  if (!state.session) return;
  const index = selectedFrame(state.time);
  const changed = index !== state.frameIndex;
  state.frameIndex = index; state.frame = state.session.frames[index];
  state.measuredFrame = state.frozenFrame ?? state.frame;
  const sample = perceptionAt(state.session, state.time);
  if (scene.view.layers.perception || scene.view.robotView) scene.setMapSample(sample);
  scene.renderFrameScene(state);
  $('timeline').value = String(state.time);
  $('current-time').textContent = clock(state.time);
  $('frame-counter').textContent = `tick ${index + 1} / ${state.session.frames.length}`;
  setTimelineCursor(state.time);
  const now = performance.now();
  if (force || !state.playing || now - lastHud > 66) { lastHud = now; updateHud(sample); }
  if (changed || force || !state.playing) renderInspector(state, { force });
  if (!state.playing || now - lastSensorFetch > 250) { lastSensorFetch = now; refreshSensors(state); }
  emit('frame', { frame: state.frame, time: state.time });
  window.dispatchEvent(new CustomEvent('studio:frame', { detail: { frame: state.frame, time: state.time } }));
}

function hudItem(label, value, unit, tone = '') {
  return `<div class="hud-item ${finite(value) || typeof value === 'string' ? tone : 'na'}"><span>${escape(label)}</span><strong>${finite(value) ? value.toFixed(unit === 'm' || unit === 'm/s' ? 2 : unit === 'rad' ? 2 : 1) : typeof value === 'string' ? escape(value) : '—'}${finite(value) && unit ? `<em>${escape(unit)}</em>` : ''}</strong></div>`;
}
function updateHud(sample) {
  const f = state.frame, m = state.measuredFrame ?? f, meta = state.session.metadata, h = sampleHealth(state);
  const crit = meta.navigation_criteria ?? {};
  if (!hasPose(m)) {
    $('hud').innerHTML = hudItem('Receiver', h.stream_status ?? 'unavailable', '', h.stream_status === 'fresh' ? 'good' : 'warn') + hudItem('Reference age', h.reference_age_ms, 'ms') + hudItem('Receive rate', h.observed_rate_hz, 'Hz');
    $('pose-caption').textContent = 'ROBOT STATE UNAVAILABLE · no measured or world-root pose recorded';
    $('reference-caption').textContent = f.reference ? 'REFERENCE VALUES · pose stream · no world-root position' : 'REFERENCE UNAVAILABLE at this time';
    $('source-badge').className = 'chip chip-measured'; $('source-badge').textContent = 'RECORDED ZMQ';
    return;
  }
  const goal = meta.goal_xy, dist = goal ? Math.hypot(m.position[0] - goal[0], m.position[1] - goal[1]) : null;
  const v = f.post_action?.root_linear_velocity_w;
  let speed = Array.isArray(v) ? Math.hypot(v[0], v[1]) : null;
  if (speed === null && !state.frozenFrame) {
    // Older recordings lack root velocity: finite difference of recorded poses (labelled in the tooltip).
    const frames = state.session.frames, i = state.frameIndex, a = frames[Math.max(0, i - 2)], b = frames[Math.min(frames.length - 1, i + 2)];
    if (hasPose(a) && hasPose(b) && b.time > a.time) speed = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1]) / (b.time - a.time);
  }
  const q = m.quaternion_wxyz, tilt = Array.isArray(q) ? Math.acos(Math.min(1, Math.abs(1 - 2 * (q[1] ** 2 + q[2] ** 2)))) : null;
  const contact = h.contact_force_n, threshold = crit.obstacle_contact_threshold_n ?? 100;
  const exec = f.plan?.exec_check;
  $('hud').innerHTML = (goal ? hudItem('Goal distance', dist, 'm', dist <= (crit.goal_radius_m ?? 0.3) ? 'good' : '') : '')
    + hudItem('Speed', speed, 'm/s') + hudItem('Tilt', tilt, 'rad', tilt > 0.5 ? 'warn' : '')
    + hudItem('Contact', contact, 'N', contact > threshold ? 'bad' : contact > 0 ? 'warn' : '')
    + hudItem('Plan rule', f.plan?.rule ? f.plan.rule.replaceAll('_', ' ') : null, '')
    + (exec ? hudItem('Exec check · est.', `${exec.ok ? 'ok' : 'fail'} · ${num(exec.clearance_m * 100, 1)} cm`, '', exec.ok ? 'good' : 'warn') : '')
    + (sample && !meta.privileged_map ? hudItem('Map age', (state.time - sample.time) * 1000, 'ms') : '');
  const age = h.state_age_ms;
  $('navigation-caption').textContent = goal ? `Goal [${vector(goal, 2)}] m · ${crit.label ?? ''}` : '';
  const truth = meta.mode === 'simulation' || meta.recording_kind === 'sonic-mujoco-lockstep';
  $('pose-caption').textContent = `${state.frozenFrame ? 'DIAGNOSTIC HELD STATE' : truth ? 'SIM-TRUTH' : 'RECORDED'} · xyz [${vector(m.position, 2)}] m · yaw ${num(yawOf(q), 2, 'rad')}${state.frozenFrame ? ` · ${num(age, 0, 'ms')} old` : ''}`;
  $('reference-caption').textContent = scene.view.layers.perception && sample ? (finite(sample.time) && state.session.perception?.frames ? `MAP · causal sample ${clock(sample.time)} · unknown cells stay empty` : 'MAP · final accumulated snapshot · capture time unavailable') : f.reference ? 'Cyan: SONIC reference now · amber: +0.4 s / +0.9 s · line: planner prediction' : 'No reference packets in this recording';
  const badge = $('source-badge');
  badge.className = `chip ${state.frozenFrame ? 'chip-unavailable' : truth ? 'chip-sim-truth' : 'chip-recorded'}`;
  badge.textContent = state.frozenFrame ? 'STATE HELD' : truth ? 'SIM-TRUTH' : 'RECORDED';
  badge.title = truth ? EVIDENCE['sim-truth'].tip : EVIDENCE.recorded.tip;
}

// ------------------------------------------------------------------ playback
function setPlaying(value) {
  state.playing = value;
  $('play').innerHTML = value ? 'Ⅱ <span>Pause</span>' : '▶ <span>Play</span>';
  $('play').setAttribute('aria-label', value ? 'Pause recording' : 'Play recording');
  $('playback-state').textContent = value ? 'PLAYING' : state.session?.metadata?.mode === 'simulation' ? 'LIVE' : 'PAUSED';
  updateView({ play: value ? '1' : null });
  if (value && scene.view.camera_mode === 'scene' && state.session?.metadata?.goal_xy) cameraView('follow', true);
  lastTick = performance.now();
}
function seek(time) {
  if (!state.session) return;
  if (state.frozenFrame && time < state.frozenFrame.time) state.frozenFrame = null;
  state.time = Math.max(state.session.frames[0].time, Math.min(state.session.metadata.duration_s, time));
  renderFrame();
  updateViewSoon({ time: state.time.toFixed(3) });
}
function step(ticks) { setPlaying(false); seek(state.time + ticks * 0.02 + 1e-6); }
let lastTick = performance.now();
function tick(now) {
  if (state.playing && state.session && !state.loading) {
    const dt = Math.min((now - lastTick) / 1000, 0.25);
    state.time = Math.min(state.session.metadata.duration_s, state.time + dt * state.speed);
    renderFrame();
    if (state.time >= state.session.metadata.duration_s) {
      if (state.loop && state.session.metadata.duration_s > state.session.frames[0].time) seek(state.session.frames[0].time);
      else setPlaying(false);
    }
  }
  lastTick = now;
  requestAnimationFrame(tick);
}

function cameraView(kind, reset = false) {
  document.querySelectorAll('[data-camera]').forEach(b => { const a = b.dataset.camera === kind; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
  scene.cameraView(kind, state, reset);
  updateView({ camera: kind });
}
function syncLayers() {
  for (const name of Object.keys(scene.view.layers)) { const input = $(`layer-${name}`); if (input) scene.view.layers[name] = input.checked && !input.disabled; }
  if (scene.view.layers.perception) scene.setMapSample(perceptionAt(state.session, state.time));
  scene.applyLayers(state);
  if (state.session && state.frame) updateHud(perceptionAt(state.session, state.time));
}
function setRobotView(enabled) {
  scene.setRobotView(enabled);
  if (enabled && state.session) scene.setMapSample(perceptionAt(state.session, state.time));
  $('robot-view').setAttribute('aria-pressed', String(enabled)); $('robot-view').classList.toggle('active', enabled);
  $('robot-view-label').hidden = !enabled;
  updateView({ robot_view: enabled ? '1' : null });
}

// ------------------------------------------------------------------ live rehearsal attach
async function attachLive(job) {
  if (!job?.latest?.frame) return;
  if (rh.attached !== job.id) {
    rh.attached = job.id;
    const ok = await loadSession(job.id, { keepCamera: true });
    if (!ok) { rh.attached = null; return; }
    cameraView('follow', true);
    if (inspector.tab !== 'health') selectTab('health', state);
  }
  if (state.sessionId === job.id) appendLiveFrame({ ...job.latest, runtime: job.runtime });
}
function appendLiveFrame(latest) {
  const frame = latest.frame;
  if (!frame || !state.session || !hasPose(frame) || state.loading || state.session.metadata.mode !== 'simulation') return;
  state.runtime = latest.runtime ?? null; state.liveStatus = latest.status ?? null;
  const frames = state.session.frames, previous = frames.at(-1);
  if (previous && frame.time < previous.time) return;
  if (latest.metadata) Object.assign(state.session.metadata, latest.metadata);
  if (latest.pipeline) {
    state.session.pipeline ??= { schema_version: 1, flow_samples: [], sonic_samples: [] };
    frame.pipeline = { schema_version: 1, ...frame.pipeline };
    for (const kind of ['flow', 'sonic']) {
      const key = `${kind}_samples`, samples = state.session.pipeline[key] ??= [], incoming = latest.pipeline[key]?.at(-1);
      if (!incoming) continue;
      const last = samples.at(-1);
      if (!last || last.sequence !== incoming.sequence || last.source_time !== incoming.source_time) samples.push(incoming); else samples[samples.length - 1] = incoming;
      frame.pipeline[`${kind}_index`] = samples.length - 1;
      if (samples.length > 500) samples.splice(0, samples.length - 500);
    }
  }
  if (previous && frame.time === previous.time) frames[frames.length - 1] = frame; else frames.push(frame);
  if (frames.length > 3000) frames.splice(0, frames.length - 3000);
  if (latest.perception?.available !== false && Number.isFinite(latest.perception?.time)) {
    if (!state.session.perception?.frames) state.session.perception = { available: true, kind: 'time-series', frames: [] };
    const snaps = state.session.perception.frames, last = snaps.at(-1);
    if (!last || latest.perception.time > last.time) snaps.push(latest.perception);
    if (snaps.length > 500) snaps.splice(0, snaps.length - 500);
    $('layer-perception').disabled = false;
  }
  state.session.trajectory ??= [];
  state.session.metadata.duration_s = frame.time;
  state.time = frame.time; state.frameIndex = -1;
  $('timeline').max = String(frame.time); $('duration-time').textContent = clock(frame.time);
  if (performance.now() - (appendLiveFrame.lanes ?? 0) > 1000) { appendLiveFrame.lanes = performance.now(); refreshTimelineLive(); }
  updateRecordingWarning(); updateModeBadge();
  renderFrame(true);
  const terminal = ['completed', 'failed', 'cancelled'].includes(latest.status);
  $('playback-state').textContent = terminal ? `RUN ${latest.status.toUpperCase()}` : 'LIVE';
}

on('rehearse:job', job => { if (state.workspace === 'rehearse' || rh.attached === job.id) attachLive(job).catch(e => showError(e.message)); });
on('rehearse:started', () => { rh.attached = null; });
on('rehearse:finished', async job => {
  await refreshSessionList(state.sessionId);
  if (job.result_session_id && rh.attached === job.id) {
    const keepTime = state.time;
    await loadSession(job.result_session_id, { keepCamera: true });
    seek(keepTime);
  }
  if (runs.table.length) refreshRuns().catch(() => {});
});
on('rehearse:suite-finished', () => { refreshRuns().catch(() => {}); refreshSessionList(); });
on('rehearse:preview', markers => {
  if (state.workspace !== 'rehearse' || rh.attached) return;
  scene.setArenaPreview(markers.map, { start: markers.start, yaw: markers.yaw, goal: markers.goal });
  scene.fitScene(scene.sceneBounds([markers.start, markers.goal]));
  $('session-title').textContent = `Preview · ${markers.map?.label ?? 'arena'}`;
  $('source-badge').className = 'chip chip-configured'; $('source-badge').textContent = 'CONFIGURED';
  $('navigation-caption').textContent = 'Not yet run. Press Run preset to execute the selected policy in the CPU simulation.';
});
on('rehearse:edit-arena', async id => { await setWorkspace('arena'); await loadFromMap(id).catch(e => showError(e.message)); });
on('arena:rehearse', async id => { await setWorkspace('rehearse'); await rehearseSelectMap(id); });
on('arena:preview3d', enabled => {
  arena.preview3d = enabled;
  setStage(enabled ? '3d' : 'arena');
  if (enabled) { const q = activePreset(); scene.setArenaPreview(arenaDocument(), { start: q?.start_xy, yaw: q?.start_yaw_rad, goal: q?.goal_xy }); scene.fitScene(); }
});
on('arena:changed', () => { if (arena.preview3d) { const q = activePreset(); scene.setArenaPreview(arenaDocument(), { start: q?.start_xy, yaw: q?.start_yaw_rad, goal: q?.goal_xy }); } });
on('catalog:refreshed', catalog => { state.catalog = catalog; arena.catalog = catalog; if (runs.canvas) runs.catalogMaps = catalog.maps; });
on('arena:saved', async () => {
  // New arenas must appear in every consumer; never reuse a pre-save catalog.
  state.catalog = null;
  try { emit('catalog:refreshed', await ensureCatalog()); } catch (error) { emit('workbench:error', error.message); }
});
on('open-session', async id => {
  await setWorkspace('replay');
  await refreshSessionList(id);
  if (await loadSession(id)) { selectTab('health', state); }
});
on('runs:compare', list => { if (state.workspace === 'runs') scene.setComparison(list.map(r => ({ ...r, color: parseInt(runColor(r).slice(1), 16) }))); });

// ------------------------------------------------------------------ workspaces
function setStage(kind) {
  $('viewport').style.visibility = kind === '3d' ? 'visible' : 'hidden';
  $('arena-canvas').hidden = kind !== 'arena';
  $('runs-canvas').hidden = kind !== 'runs';
  $('system-stage').hidden = kind !== 'system';
  document.body.classList.toggle('stage-2d', kind !== '3d');
  $('vp-title').hidden = kind !== '3d';
  if (kind === '3d') scene.markDirty();
}

async function ensureCatalog() {
  if (!state.catalog) { state.catalog = await request('/api/workbench'); setToken(state.catalog.csrf_token); }
  return state.catalog;
}

async function setWorkspace(name) {
  if (!WORKSPACES[name]) name = 'replay';
  const ws = WORKSPACES[name], previous = state.workspace;
  state.workspace = name;
  document.querySelectorAll('[data-workspace]').forEach(b => { const a = b.dataset.workspace === name; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
  $('workbench-error').hidden = true;
  $('tool-panel').hidden = !ws.panel;
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== ws.panel; });
  $('tool-title').textContent = ws.title; $('tool-eyebrow').textContent = ws.eyebrow;
  sn.visible = name === 'sensors';
  document.body.classList.toggle('no-inspector', ['arena', 'runs', 'system'].includes(name));
  if (previous === 'runs' && name !== 'runs') scene.setComparison([]);
  if (name !== 'rehearse' && name !== 'arena' && !rh.attached && scene.view.arenaGroup.visible) {
    scene.setArenaPreview(null);
    if (state.session) { $('session-title').textContent = state.session.metadata.title ?? state.sessionId; renderFrame(true); }
  }
  updateView({ workspace: name === 'replay' ? null : name });
  setStage(name === 'arena' && arena.preview3d ? '3d' : ws.stage);
  try {
    if (name === 'arena') {
      const catalog = await ensureCatalog();
      if (!arena.canvas) initArena($('arena-canvas'), catalog); else { arena.catalog = catalog; renderArenaPanel(); }
      arena.active_workspace = true;
      requestAnimationFrame(() => fitArena());
    } else arena.active_workspace = false;
    if (name === 'rehearse') {
      const catalog = await ensureCatalog();
      if (!rh.catalog) await initRehearse(catalog); else renderRehearse();
      if (!rh.attached) emit('rehearse:preview', previewMarkers());
    }
    if (name === 'runs') {
      const catalog = await ensureCatalog();
      if (!runs.canvas) initRuns($('runs-canvas'), catalog.maps);
      await refreshRuns();
      requestAnimationFrame(() => drawCompare());
    }
    if (name === 'sensors') { renderSensors(state); refreshSensors(state, true); }
    if (name === 'system') await renderSystem();
  } catch (error) { emit('workbench:error', error.message); }
}

async function renderSystem() {
  if (!state.robot) { try { state.robot = await request('/api/robot', undefined, { cache: 'no-cache' }); } catch (e) { state.robot = null; } }
  const kind = sessionKind(state.session);
  $('system-panel').innerHTML = `<div class="panel-section"><h4>Selected component</h4><div id="system-detail">${systemDetails(inspector.systemNode, state.session, state.robot)}</div></div>
    <div class="panel-section"><h4>This source</h4><p class="tiny">${escape(KIND_LABEL[kind])}</p>
    <label class="check"><input id="system-deploy" type="checkbox" ${state.systemDeploy ? 'checked' : ''}> Show the real-time deployment topology instead</label></div>
    <div class="panel-section"><h4>Boundary</h4><p class="tiny">Studio is observe-only. It never publishes <code>rt/lowcmd</code>, hand commands or ZMQ <code>pose</code>, and never connects to the planner node control port :5562. Physical E-stop and operator procedures own the robot.</p></div>`;
  $('system-stage').innerHTML = `<div class="system-layout"><section><span class="eyebrow">DEPLOYMENT CHAIN</span><h3>${state.systemDeploy ? 'Real-time deployment (source-configured)' : escape(state.session?.metadata?.title ?? 'System')}</h3><div id="system-map-host"></div></section>
    <section id="robot-contract"></section></div>`;
  const draw = () => renderSystemMap($('system-map-host'), state.session, { selected: inspector.systemNode, showDeploy: !!state.systemDeploy,
    onSelect: id => { inspector.systemNode = id; $('system-detail').innerHTML = systemDetails(id, state.session, state.robot); draw(); } });
  draw();
  renderRobotContract($('robot-contract'), state.robot);
  $('system-deploy').addEventListener('change', e => { state.systemDeploy = e.target.checked; renderSystem(); });
}

// ------------------------------------------------------------------ chrome
function buildLegend() {
  $('evidence-legend').innerHTML = `<h3>Evidence key</h3><p class="tiny">Every value carries one of these classes. Hover a chip anywhere for its reason.</p>
    ${Object.entries(EVIDENCE).map(([k, e]) => `<div class="legend-row">${chip(k)}<span>${escape(e.tip)}</span></div>`).join('')}
    <p class="tiny">CPU lockstep pauses physics while the planner runs. Success in Studio is a simulation result, never hardware readiness.</p>`;
}
function togglePopover(id, button) {
  const node = $(id), open = node.hidden;
  document.querySelectorAll('.popover').forEach(p => { if (p.id !== id) p.hidden = true; });
  node.hidden = !open; button?.setAttribute('aria-expanded', String(open));
}
function initInspectorResize() {
  const handle = $('inspector-resize');
  let start = null;
  let saved = 0;
  try { saved = Number(localStorage.getItem('studio.inspector') ?? 0); } catch { /* storage unavailable: keep default width */ }
  if (saved >= 280 && saved <= 720) document.documentElement.style.setProperty('--inspector-w', `${saved}px`);
  handle.addEventListener('pointerdown', e => { start = { x: e.clientX, w: document.querySelector('.inspector').getBoundingClientRect().width }; handle.setPointerCapture(e.pointerId); });
  handle.addEventListener('pointermove', e => {
    if (!start) return;
    const w = Math.max(280, Math.min(720, start.w + start.x - e.clientX));
    document.documentElement.style.setProperty('--inspector-w', `${w}px`);
  });
  handle.addEventListener('pointerup', () => { if (start) { try { localStorage.setItem('studio.inspector', String(parseInt(getComputedStyle(document.documentElement).getPropertyValue('--inspector-w'), 10))); } catch { /* storage optional */ } } start = null; });
}

function onKey(e) {
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.workspace === 'arena' && !arena.preview3d && !['?', ' '].includes(e.key)) return;
  const k = e.key;
  if (k === ' ') { e.preventDefault(); $('play').click(); }
  else if (k === 'ArrowRight' || k === 'ArrowLeft') { e.preventDefault(); const dir = k === 'ArrowRight' ? 1 : -1; if (e.shiftKey) { setPlaying(false); seek(state.time + dir); } else step(dir); }
  else if (k === 'j' || k === 'l') { const speeds = [0.25, 0.5, 1, 2, 4]; const i = Math.max(0, Math.min(4, speeds.indexOf(state.speed) + (k === 'l' ? 1 : -1))); state.speed = speeds[i]; $('speed').value = String(state.speed); updateView({ speed: state.speed }); }
  else if (k === 'k') setPlaying(false);
  else if (k === 'f') cameraView('follow', true); else if (k === 't') cameraView('top'); else if (k === 'o') cameraView('orbit', true); else if (k === 'g') cameraView('scene');
  else if (k === 'r') setRobotView(!scene.view.robotView);
  else if (k === 'm' && !$('layer-perception').disabled) { $('layer-perception').checked = !$('layer-perception').checked; syncLayers(); updateView({ map: $('layer-perception').checked ? '1' : null }); }
  else if (/^[1-7]$/.test(k)) { const tab = document.querySelectorAll('[data-tab]')[Number(k) - 1]; if (tab) { selectTab(tab.dataset.tab, state); updateView({ panel: tab.dataset.tab }); } }
  else if (k === '?') togglePopover('help-overlay', $('help-button'));
  else if (k === 'Escape') document.querySelectorAll('.popover').forEach(p => { p.hidden = true; });
}

function bindChrome() {
  $('session-picker').addEventListener('change', e => loadSession(e.target.value));
  $('play').addEventListener('click', () => { if (!state.session) return; if (state.time >= state.session.metadata.duration_s) seek(state.session.frames[0].time); setPlaying(!state.playing); });
  $('restart').addEventListener('click', () => { if (state.session) { setPlaying(false); seek(state.session.frames[0].time); } });
  $('step-back').addEventListener('click', () => step(-1));
  $('step-forward').addEventListener('click', () => step(1));
  $('timeline').addEventListener('input', e => { setPlaying(false); seek(Number(e.target.value)); });
  $('speed').addEventListener('change', e => { state.speed = Number(e.target.value); updateView({ speed: state.speed }); });
  $('loop').addEventListener('change', e => { state.loop = e.target.checked; updateView({ loop: state.loop ? '1' : null }); });
  $('copy-view').addEventListener('click', async () => {
    updateView({ time: state.time.toFixed(3) });
    try { await navigator.clipboard.writeText(location.href); $('copy-view').textContent = 'Copied'; } catch { $('copy-view').textContent = 'URL updated'; }
    setTimeout(() => { $('copy-view').textContent = 'Link'; }, 2000);
  });
  document.querySelectorAll('[data-camera]').forEach(b => b.addEventListener('click', () => cameraView(b.dataset.camera, true)));
  $('robot-view').addEventListener('click', () => setRobotView(!scene.view.robotView));
  $('layers-button').addEventListener('click', () => togglePopover('layers-popover', $('layers-button')));
  document.querySelectorAll('#layers-popover input').forEach(input => input.addEventListener('change', () => { syncLayers(); if (input.id === 'layer-perception') updateView({ map: input.checked ? '1' : null }); }));
  document.querySelectorAll('[data-tab]').forEach(b => {
    b.addEventListener('click', () => { selectTab(b.dataset.tab, state); updateView({ panel: b.dataset.tab }); });
    b.addEventListener('keydown', e => {
      if (!['ArrowRight', 'ArrowLeft'].includes(e.key)) return;
      const tabs = [...document.querySelectorAll('[data-tab]')], i = tabs.indexOf(b), next = tabs[(i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length];
      e.preventDefault(); e.stopPropagation(); next.focus(); next.click();
    });
  });
  document.querySelectorAll('[data-workspace]').forEach(b => b.addEventListener('click', () => setWorkspace(b.dataset.workspace)));
  $('tool-close').addEventListener('click', () => setWorkspace('replay'));
  $('evidence-button').addEventListener('click', () => togglePopover('evidence-legend', $('evidence-button')));
  $('help-button').addEventListener('click', () => togglePopover('help-overlay', $('help-button')));
  document.addEventListener('click', e => {
    const inspect = e.target.closest('[data-inspect-pipeline]');
    if (inspect) { selectPipelineStage(inspect.dataset.inspectPipeline); selectTab('pipeline', state); }
    const seekButton = e.target.closest('[data-seek]');
    if (seekButton) { setPlaying(false); seek(Number(seekButton.dataset.seek)); }
    const open = e.target.closest('[data-workspace-open]');
    if (open) setWorkspace(open.dataset.workspaceOpen);
    if (!e.target.closest('.popover, #layers-button, #evidence-button, #help-button')) document.querySelectorAll('.popover').forEach(p => { p.hidden = true; });
  });
  window.addEventListener('keydown', onKey);
}

async function initialize() {
  const view = new URLSearchParams(location.search);
  try {
    scene.initScene($('viewport'), { onPick: null });
  } catch (error) { showError(`3D renderer could not start: ${error.message}`); $('loading-overlay').hidden = true; return; }
  initTimeline({ onSeek: t => { setPlaying(false); seek(t); } });
  initSensors(); buildLegend(); initInspectorResize(); bindChrome();
  requestAnimationFrame(tick);
  request('/api/version').then(v => { $('build-info').textContent = `build ${v.commit ? v.commit.slice(0, 7) : 'unknown'}${v.dirty ? ' · modified tree' : ''}`; $('build-info').title = v.describe ?? ''; }).catch(() => {});
  window.__studio = {
    get state() { return state; }, get model() { return scene.view.model; }, get robot() { return scene.view.robot; },
    get sceneDrawCount() { return scene.view.drawCount; }, get mapSample() { return scene.view.mapSample; },
    get sensorOverlayCount() { return scene.view.sensorOverlays.size; }, get navigationMarkers() { return scene.markerPositions(); },
    get navigationScreen() { return scene.markerScreen(); }, get cameraFit() { return scene.cameraFit(); },
    get camera() { return scene.view.camera_mode; }, get layers() { return { ...scene.view.layers }; },
    projectWorld: scene.projectWorld, seek, setPlaying, loadSession, cameraView, updateView, appendLiveFrame, setWorkspace,
    selectTab: name => selectTab(name, state), setRobotView,
    get arena() { return arena; }, get runs() { return runs; }, get rehearse() { return rh; }, selectedRuns,
  };
  try {
    const sessions = await refreshSessionList();
    if (!sessions?.length) throw new Error('No recordings configured. See README for config/local.json.');
    const requested = view.get('session');
    const firstJob = [...sessions].filter(s => s.group === 'CPU rehearsals' && s.available && s.outcome)
      .sort((a, b) => (b.started_unix_s ?? 0) - (a.started_unix_s ?? 0))[0];
    const selected = sessions.some(s => s.id === requested) ? requested : (firstJob ?? sessions.find(s => s.available) ?? sessions[0]).id;
    $('session-picker').value = selected;
    if (!(await loadSession(selected))) return;
    if (requested && requested !== selected) return;
    // View links configure this browser only; they never start a worker.
    const panel = view.get('panel');
    if ([...document.querySelectorAll('[data-tab]')].some(b => b.dataset.tab === panel)) selectTab(panel, state);
    if (view.get('map') === '1' && !$('layer-perception').disabled) { $('layer-perception').checked = true; syncLayers(); }
    if (view.has('time') && finite(Number(view.get('time')))) seek(Number(view.get('time')));
    if (['orbit', 'follow', 'top', 'scene'].includes(view.get('camera'))) cameraView(view.get('camera'), true);
    if (['0.25', '.25', '0.5', '1', '2', '4'].includes(view.get('speed'))) { state.speed = Number(view.get('speed')); $('speed').value = String(state.speed); }
    state.loop = view.get('loop') === '1'; $('loop').checked = state.loop;
    if (view.get('robot_view') === '1') setRobotView(true);
    if (view.get('workspace')) await setWorkspace(view.get('workspace'));
    if (view.get('play') === '1') setPlaying(true);
  } catch (error) { showError(error.message); $('loading-overlay').hidden = true; }
}
initialize();
