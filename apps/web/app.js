// G1 Deploy Studio browser entry: causal replay, owned CPU rehearsals and
// navigation arenas. The browser never talks to a robot, DDS or ZMQ.
import { $, escape, num, vector, clock, finite, hasPose, hasRoot, hasReferencePose, request, setToken, setTokenRefresher, on, emit,
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
import { nav, initNavigate, render as renderNavigate, pickGoal, overlay as navOverlay, resetPreview as resetNavPreview } from './js/navigate.js';
import { initFocus } from './js/focus.js';

const state = {
  session: null, sessionId: null, frame: null, measuredFrame: null, frozenFrame: null, frameIndex: -1, time: 0,
  playing: false, speed: 1, loop: false, loading: false, loadGeneration: 0, runtime: null, liveStatus: null,
  workspace: 'replay', live: null, catalog: null, robot: null, sessions: [],
};
// Playback clock anchor (see tick): wall time and simulated time at the last re-anchor.
let anchor = { wall: performance.now(), sim: 0, speed: 1 }, frameTimes = [];
let focus;
let rehearsePreviewSuspensions = 0;
state.freeze = on_ => { state.frozenFrame = on_ ? state.frame : null; renderFrame(true); };

const WORKSPACES = {
  replay: { title: 'Replay', eyebrow: '', panel: null, stage: '3d' },
  navigate: { title: 'Navigate', eyebrow: "Goals on the robot's own map", panel: 'navigate', stage: '3d' },
  arena: { title: 'Navigation arena', eyebrow: 'Build · obstacles · start / goal presets', panel: 'arena', stage: 'arena' },
  rehearse: { title: 'Rehearse a policy', eyebrow: 'Isolated CPU simulation · hardware disabled', panel: 'rehearse', stage: '3d' },
  runs: { title: 'Runs', eyebrow: 'Compare outcomes and trajectories', panel: 'runs', stage: 'runs' },
  sensors: { title: 'What the robot perceives', eyebrow: 'Causal sensor samples at the cursor', panel: 'sensors', stage: '3d' },
  system: { title: 'System', eyebrow: 'Pipeline · transports · Unitree contract', panel: 'system', stage: 'system' },
};

function showError(message) { $('error-banner').textContent = message; $('error-banner').hidden = false; clearTimeout(showError.t); showError.t = setTimeout(() => { $('error-banner').hidden = true; }, 9000); }
window.addEventListener('studio:error', e => showError(e.detail));
on('workbench:error', message => { $('workbench-error').textContent = message; $('workbench-error').hidden = false; });
on('workbench:clear', message => { if ($('workbench-error').textContent === message) $('workbench-error').hidden = true; });
on('arena:error', message => { $('workbench-error').textContent = message; $('workbench-error').hidden = false; });

// ------------------------------------------------------------------ sessions
const OUTCOME_MARK = { goal_completion: '✓', timeout: '◷', obstacle_collision: '✕', fall: '✕', runtime_error: '✕' };  // text glyphs, never emoji
function sessionOption(s) {
  const mark = s.status === 'running' ? '●' : Number.isFinite(s.walks) ? (s.walks && s.arrived === s.walks ? '✓' : '◐') : OUTCOME_MARK[s.outcome] ?? '';
  const policy = s.policy_id && s.policy_id !== 'flow-bundle-20261008' ? ` · ${s.policy_id.replace('flow-', '').replace(/-s\d$/, '')}` : '';
  return `<option value="${escape(s.id)}" ${s.available ? '' : 'disabled'}>${mark ? mark + ' ' : ''}${escape(s.label ?? s.id)}${policy}${s.id.startsWith('job-') ? ` · #${escape(s.id.slice(-6))}` : ''}</option>`;
}
async function refreshSessionList(selected) {
  const { sessions } = await request('/api/sessions');
  selected ??= state.sessionId;  // read after the request: a recording may have opened meanwhile
  state.sessions = sessions;
  const groups = new Map();
  const ordered = [...sessions].sort((a, b) => (b.started_unix_s ?? 0) - (a.started_unix_s ?? 0));
  for (const s of ordered) { const g = s.group ?? 'Recordings'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(s); }
  const order = ['Navigation sessions', 'CPU rehearsals', 'Real-time rehearsals (L3)', 'Recordings'];
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
    setPreviewing(false);
    const m = session.metadata;
    $('session-title').textContent = m.title ?? id; $('session-title').title = m.source_path ?? '';
    $('footer-source').textContent = m.source_path ?? '';
    $('timeline').min = String(session.frames[0].time); $('timeline').max = String(m.duration_s); $('timeline').value = String(state.time);
    $('duration-time').textContent = clock(m.duration_s);
    const hasState = session.frames.some(hasPose) || session.frames.some(hasRoot), hasRef = session.frames.some(hasReferencePose);
    for (const [layer, enabled] of [['robot', hasState], ['future', hasState], ['trajectory', hasState], ['environment', hasState], ['frames', hasState], ['reference', hasRef]]) $(`layer-${layer}`).disabled = !enabled;
    $('layer-perception').disabled = !session.perception?.available;
    $('layer-navigation').disabled = !m.goal_xy && !m.start_xy;
    $('layer-perception').checked = !!session.perception?.available && new URLSearchParams(location.search).get('map') === '1';
    syncLayers();
    $('scene-unavailable').hidden = hasState;
    updateModeBadge(); updatePolicyChip(); updateRecordingWarning();
    $('privileged-badge').hidden = !m.privileged_map;
    $('robot-view-label').textContent = robotViewLabel();
    $('playback-state').textContent = ['simulation', 'live'].includes(m.mode) ? 'Live' : 'Paused';
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
    if (state.workspace === 'system') renderSystem().catch(() => {});
    return true;
  } catch (error) {
    if (generation === state.loadGeneration) {
      $('loading-overlay').hidden = true; showError(`Cannot open this recording: ${error.message}`); console.error(error);
      // The picker names what the view shows, never the recording that failed to open (validation D3).
      if (state.sessionId && [...$('session-picker').options].some(o => o.value === state.sessionId)) $('session-picker').value = state.sessionId;
    }
    return false;
  } finally {
    if (generation === state.loadGeneration) state.loading = false;
  }
}

function updateModeBadge() {
  const m = state.session?.metadata ?? {};
  const live = m.mode === 'simulation';
  if (m.mode === 'partial-live') {
    $('mode-badge').textContent = `Run ${String(state.liveStatus ?? 'ended')} · partial live samples`;
    $('mode-badge').classList.remove('sim');
    $('run-outcome').innerHTML = outcomeChip(null, state.liveStatus ?? 'failed');
    return;
  }
  const fid = fidelity(m), level = fid.short ?? (fid.level === 'L2-approx' ? 'L2≈' : fid.level);
  const detached = live && state.liveStatus === 'detached';
  document.body.classList.toggle('live-navigation', (m.kind === 'navigation' || m.recording_kind === 'robot-link') && (live || m.mode === 'live'));
  if (m.kind === 'navigation' || m.recording_kind === 'robot-link') {
    const real = m.recording_kind === 'robot-link' || m.robot === 'real', running = live || m.mode === 'live';
    $('mode-badge').textContent = running ? (real ? '● Live · real robot · observe + goals' : `● Live · simulated robot · ${level}`)
      : real ? 'Replay · robot session · M5' : `Replay · navigation session · ${level}`;
    $('mode-badge').title = `${fid.label}. Proves: ${fid.proves} Hides: ${fid.hides}`;
    $('mode-badge').classList.toggle('sim', running);
    const r = m.test_result;
    $('run-outcome').innerHTML = running ? outcomeChip(null, 'running')
      : r ? `<span class="outcome ${r.arrived === r.walks && r.walks ? 'outcome-good' : 'outcome-warn'}">${r.arrived ?? 0}/${r.walks ?? 0} walks arrived</span>` : '';
    return;
  }
  $('mode-badge').textContent = detached ? `◌ Detached CPU simulation · ${level}` : live ? `● Live CPU simulation · ${level}` : m.recording_kind === 'sonic-mujoco-lockstep' ? (/^studio\.(flow_)?policy_worker/.test(m.provenance?.adapter ?? '') ? `Replay · CPU rehearsal · ${level}` : `Replay · recorded lockstep · ${level}`) : m.recording_kind === 'recorded-wire-transport' ? 'Replay · ZMQ capture · L0' : m.fidelity === 'L3' ? 'Replay · real-time chain · L3' : 'Replay · L0';
  $('mode-badge').title = `${fid.label}. Proves: ${fid.proves} Hides: ${fid.hides}`;
  $('mode-badge').classList.toggle('sim', live);
  const result = m.test_result;
  $('run-outcome').innerHTML = live ? outcomeChip(null, detached ? 'detached' : 'running') : result?.outcome ? outcomeChip(result.outcome) : '';
  $('run-outcome').title = result?.outcome ? `Whole-run source scorer outcome · ${num(result.elapsed_s, 2, 's')} · final ${num(result.final_goal_distance_xy_m, 2, 'm')}` : '';
}
function updatePolicyChip() {
  const meta = state.session?.metadata ?? {};
  const p = meta.policy_profile ?? (meta.policy_identity ? { label: meta.policy_identity.split(' + ')[0].replace('Frozen ', 'frozen ') } : null);
  const chipEl = $('policy-chip');
  if (!p) { chipEl.hidden = true; return; }
  chipEl.hidden = false;
  const block = p.research_block ? `${p.research_block}${/retrieval-free/i.test(p.variant ?? '') ? '-RF' : ''}` : null;
  chipEl.innerHTML = block ? `Policy <strong>${escape(block)}</strong> @ ${escape(String(p.revision).slice(0, 7))}` : `Policy <strong>${escape(p.label ?? p.id)}</strong>`;
  chipEl.title = `${p.label ?? p.id}${p.config_sha256 ? ` · config ${p.config_sha256.slice(0, 12)}` : ''}${p.identity_sha256 ? ` · identity ${p.identity_sha256.slice(0, 12)}` : ''}`;
}
function updateRecordingWarning() {
  const m = state.session?.metadata ?? {};
  const node = $('recording-warning');
  if (['simulation', 'live'].includes(m.mode)) {
    node.hidden = !['failed', 'detached'].includes(state.liveStatus);
    node.textContent = state.liveStatus === 'detached'
      ? 'Run detached · The gateway restarted while this worker kept running. Following its files read-only; this gateway does not own it and cannot cancel it. The recording opens when the worker finishes.'
      : `Worker failed · ${m.termination_reason ?? m.error ?? 'The worker stopped before normal completion.'} Showing received live samples; open the recorded failure for all captured execution.`;
    return;
  }
  node.hidden = !m.incomplete && m.recording_complete !== false;
  node.textContent = `Incomplete recording · ${m.termination_reason ?? m.error ?? 'Stopped before normal completion.'} Executed motion is shown up to the last captured sample. This is a recorded failure, not a navigation success.`;
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
  $('frame-counter').textContent = `sample ${index + 1} / ${state.session.frames.length}`;
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
  if (!hasPose(m) && !hasRoot(m)) {
    $('hud').innerHTML = hudItem('Receiver', h.stream_status ?? 'unavailable', '', h.stream_status === 'fresh' ? 'good' : 'warn') + hudItem('Reference age', h.reference_age_ms, 'ms') + hudItem('Receive rate', h.observed_rate_hz, 'Hz');
    $('pose-caption').textContent = 'Robot state unavailable · no measured or world-root pose recorded';
    $('reference-caption').textContent = f.reference ? 'Reference values · pose stream · no world-root position' : 'Reference unavailable at this time';
    $('source-badge').className = 'chip chip-measured'; $('source-badge').textContent = 'Recorded ZMQ';
    return;
  }
  // Navigation sessions carry the goal per frame (it changes from walk to walk).
  const goal = f.navigation ? f.navigation.goal_xy : meta.goal_xy, dist = goal ? Math.hypot(m.position[0] - goal[0], m.position[1] - goal[1]) : null;
  if (f.navigation) crit.goal_radius_m ??= meta.navigation?.goal_radius_m ?? meta.node_rules?.goal_radius_m ?? 0.4;
  const v = f.post_action?.root_linear_velocity_w;
  let speed = Array.isArray(v) ? Math.hypot(v[0], v[1]) : null, speedLabel = 'Speed';
  if (speed === null && !state.frozenFrame) {
    speedLabel = 'Speed (fd)';
    // Older recordings lack root velocity: finite difference of recorded poses (labelled in the tooltip).
    const frames = state.session.frames, i = state.frameIndex, a = frames[Math.max(0, i - 2)], b = frames[Math.min(frames.length - 1, i + 2)];
    if (hasRoot(a) && hasRoot(b) && b.time > a.time) speed = Math.hypot(b.position[0] - a.position[0], b.position[1] - a.position[1]) / (b.time - a.time);
  }
  // Angle between body z and world z; 1 - 2(x² + y²) = cos(tilt), no folding beyond 90°.
  const q = m.quaternion_wxyz, tilt = Array.isArray(q) ? Math.acos(Math.max(-1, Math.min(1, 1 - 2 * (q[1] ** 2 + q[2] ** 2)))) : null;
  const contact = h.contact_force_n, threshold = crit.obstacle_contact_threshold_n ?? 100;
  const exec = f.plan?.exec_check;
  $('hud').innerHTML = (goal ? hudItem('Goal distance', dist, 'm', dist <= (crit.goal_radius_m ?? 0.3) ? 'good' : '') : '')
    + hudItem(speedLabel, speed, 'm/s') + hudItem('Tilt', tilt, 'rad', tilt > 0.5 ? 'warn' : '')
    + hudItem('Contact', contact, 'N', contact > threshold ? 'bad' : contact > 0 ? 'warn' : '')
    + hudItem('Plan rule', f.plan?.rule ? f.plan.rule.replaceAll('_', ' ') : null, '')
    + (exec ? hudItem('Exec check · est.', `${exec.ok ? 'ok' : 'fail'} · ${num(exec.clearance_m * 100, 1)} cm`, '', exec.ok ? 'good' : 'warn') : '')
    + (sample && !meta.privileged_map ? (state.time - sample.time >= 1 ? hudItem('Map age', state.time - sample.time, 's') : hudItem('Map age', (state.time - sample.time) * 1000, 'ms')) : '');
  const age = h.state_age_ms;
  if (document.body.classList.contains('previewing')) return;  // the preview owns the caption and the source badge
  // A live session's staged goal is in the node's status, not yet in the frames (they carry the goal of a walk).
  const staged = !goal && f.navigation && nav.job?.id === state.sessionId ? nav.job.latest?.navigation?.goal?.xy : null;
  $('navigation-caption').textContent = f.navigation
    ? `${f.navigation.walk ? `Walk ${f.navigation.walk}` : 'Standing'} · ${goal ? `goal [${vector(goal, 2)}] m` : staged ? `goal staged [${vector(staged, 2)}] m` : 'no goal'} · ${String(f.navigation.phase ?? '').toLowerCase()}`
    : goal ? `Goal [${vector(goal, 2)}] m · ${crit.label ?? ''}` : '';
  const truth = meta.recording_kind !== 'robot-link' && (meta.mode === 'simulation' || ['sonic-mujoco-lockstep', 'navigation-session'].includes(meta.recording_kind));
  $('pose-caption').textContent = `${state.frozenFrame ? 'Diagnostic held state' : m.classification === 'estimated' ? 'LIO estimate · odom frame' : truth ? 'Sim truth' : 'Recorded'} · xyz [${vector(m.position, 2)}] m · yaw ${num(yawOf(q), 2, 'rad')}${state.frozenFrame ? ` · ${num(age, 0, 'ms')} old` : ''}`;
  $('reference-caption').textContent = scene.view.layers.perception && sample ? (finite(sample.time) && state.session.perception?.frames ? `Map · causal sample ${clock(sample.time)} · unknown cells stay empty` : 'Map · final accumulated snapshot · capture time unavailable') : f.reference ? 'Pink: SONIC reference now · amber: +0.4 s / +0.9 s · line: planner prediction' : 'No reference packets in this recording';
  const badge = $('source-badge'), estimated = m.classification === 'estimated';
  badge.className = `chip ${state.frozenFrame ? 'chip-unavailable' : estimated ? 'chip-estimated' : truth ? 'chip-sim-truth' : 'chip-recorded'}`;
  badge.textContent = state.frozenFrame ? 'State held' : estimated ? 'LIO estimate' : truth ? 'Sim truth' : 'Recorded';
  badge.title = estimated ? 'Pose is the LIO odometry estimate streamed by the deploy PC; a robot has no ground truth.' : truth ? EVIDENCE['sim-truth'].tip : EVIDENCE.recorded.tip;
}

// ------------------------------------------------------------------ playback
const svg = d => `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true">${d}</svg>`;
const PLAY_ICON = svg('<path d="m8 5 11 7-11 7z"/>'), PAUSE_ICON = svg('<rect x="7" y="5" width="3.6" height="14" rx="1"/><rect x="13.4" y="5" width="3.6" height="14" rx="1"/>');
function setPlaying(value) {
  // Pausing lands on the wall-clock time of the pause, not on the last rendered frame.
  const landing = !value && state.playing && state.session && !state.loading;
  if (landing) state.time = Math.min(state.session.metadata.duration_s, anchor.sim + (performance.now() - anchor.wall) / 1000 * anchor.speed);
  state.playing = value;
  $('play').innerHTML = value ? `${PAUSE_ICON}<span>Pause</span>` : `${PLAY_ICON}<span>Play</span>`;
  $('play').setAttribute('aria-label', value ? 'Pause recording' : 'Play recording');
  $('playback-state').textContent = value ? 'Playing' : ['simulation', 'live'].includes(state.session?.metadata?.mode) ? 'Live' : 'Paused';
  updateView({ play: value ? '1' : null });
  if (value && scene.view.camera_mode === 'scene' && state.session?.metadata?.goal_xy) cameraView('follow', true);
  reanchor();
  if (!value) $('render-rate').hidden = true;
  if (landing) renderFrame();
}
function seek(time) {
  if (!state.session) return;
  if (state.frozenFrame && time < state.frozenFrame.time) state.frozenFrame = null;
  state.time = Math.max(state.session.frames[0].time, Math.min(state.session.metadata.duration_s, time));
  reanchor();
  renderFrame();
  updateViewSoon({ time: state.time.toFixed(3) });
}
function step(ticks) { setPlaying(false); seek(state.time + ticks * 0.02 + 1e-6); }
// Playback follows the wall clock from an anchor (re-set on play, seek, speed change and when
// the tab becomes visible), so 1x is real time at any frame rate; slow rendering only drops
// frames, which the render-rate badge reports, and never slows simulated time.
function reanchor() { anchor = { wall: performance.now(), sim: state.time, speed: state.speed }; frameTimes = []; }
document.addEventListener('visibilitychange', () => { if (!document.hidden) reanchor(); });
function tick(now) {
  if (state.playing && state.session && !state.loading) {
    if (anchor.speed !== state.speed) reanchor();
    state.time = Math.min(state.session.metadata.duration_s, anchor.sim + (now - anchor.wall) / 1000 * state.speed);
    renderFrame();
    frameTimes.push(now); while (frameTimes.length && now - frameTimes[0] > 2000) frameTimes.shift();
    if (now - (tick.rateShown ?? 0) > 1000) {  // an overlay, refreshed at most 1 Hz: never a layout change
      tick.rateShown = now;
      const fps = frameTimes.length > 4 ? (frameTimes.length - 1) / ((now - frameTimes[0]) / 1000) : null;
      const limited = fps !== null && fps < 15;
      if ($('render-rate').hidden === limited) $('render-rate').hidden = !limited;
      if (limited) $('render-rate').textContent = `Render-limited · ${fps.toFixed(1)} fps · real-time clock kept`;
    }
    if (state.time >= state.session.metadata.duration_s) {
      if (state.loop && state.session.metadata.duration_s > state.session.frames[0].time) seek(state.session.frames[0].time);
      else setPlaying(false);
    }
  }
  requestAnimationFrame(tick);
}

function markCamera(kind) {
  document.querySelectorAll('[data-camera]').forEach(b => { const a = b.dataset.camera === kind; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
}
function cameraView(kind, reset = false) {
  markCamera(kind);
  scene.cameraView(kind, state, reset);
  updateView({ camera: kind });
}
function syncLayers() {
  for (const name of Object.keys(scene.view.layers)) { const input = $(`layer-${name}`); if (input) scene.view.layers[name] = input.checked && !input.disabled; }
  if (scene.view.layers.perception) scene.setMapSample(perceptionAt(state.session, state.time));
  scene.applyLayers(state);
  if (state.session && state.frame) updateHud(perceptionAt(state.session, state.time));
}
function robotViewLabel() {
  const mount = state.session?.perception?.frames?.[0]?.extrinsics?.[0];
  return mount ? 'Robot view · recorded MID-360 mount pose, facing pelvis heading · renders the simulated scene and map, not a camera sensor'
    : 'Robot view · approximate viewpoint 0.45 m above the pelvis (no mount extrinsics in this recording) · renders the simulated scene, not a camera sensor';
}
function setRobotView(enabled) {
  scene.setRobotView(enabled);
  $('robot-view-label').textContent = robotViewLabel();
  if (enabled && state.session) scene.setMapSample(perceptionAt(state.session, state.time));
  $('robot-view').setAttribute('aria-pressed', String(enabled)); $('robot-view').classList.toggle('active', enabled);
  $('robot-view-label').hidden = !enabled;
  updateView({ robot_view: enabled ? '1' : null });
}

// ------------------------------------------------------------------ live rehearsal attach
async function attachLive(job) {
  if (!job?.latest?.frame) return;
  const terminal = ['completed', 'failed', 'cancelled'].includes(job.status);
  if (rh.attached !== job.id) {
    if (terminal && !job.result_session_id) return;  // ended without a replayable recording
    if (terminal && rh.followDetached === job.id) return;  // rehearse:finished opens the followed run's recording once
    if (job.status === 'detached') {
      // After a reload, a restarted gateway serves no live session for a run it does not own: follow its
      // status from the job API only and open the recording when it finishes (rehearse:finished).
      if (rh.followDetached !== job.id) { rh.followDetached = job.id; emit('workbench:error', `Following ${job.id}, which a previous gateway started; its recording opens when it finishes.`); }
      return;
    }
    rh.attached = job.id;
    // A run that ended before its first live attach: this load already is the recording.
    if (terminal) rh.recordingOpened = job.id;
    const ok = await loadSession(job.id, { keepCamera: true });
    if (!ok) { rh.attached = null; if (rh.recordingOpened === job.id) rh.recordingOpened = null; return; }
    cameraView('follow', true);
    if (inspector.tab !== 'health') selectTab('health', state);
  }
  // The job status from the gateway is authoritative: a killed worker cannot update its own latest.json.
  if (state.sessionId === job.id) appendLiveFrame({ ...job.latest, status: ['completed', 'failed', 'cancelled', 'detached'].includes(job.status) ? job.status : job.latest.status, runtime: job.runtime });
}
function appendLiveFrame(latest) {
  const frame = latest.frame;
  const rootOnly = !hasPose(frame) && hasRoot(frame) && state.session?.metadata?.recording_kind === 'robot-link';
  if (!frame || !state.session || !(hasPose(frame) || rootOnly) || state.loading || !['simulation', 'live'].includes(state.session.metadata.mode)) return;
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
  // A live session can start without a reference (a standing robot): enable the layers once data exists.
  if (frame.reference && $('layer-reference').disabled) { $('layer-reference').disabled = false; $('layer-future').disabled = false; syncLayers(); }
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
  $('playback-state').textContent = terminal ? `Run ${latest.status}` : latest.status === 'detached' ? 'Run detached · following files' : 'Live';
}

// ------------------------------------------------------------------ Navigate (live navigation sessions)
const navAttach = { loading: null, opened: null, layers: null, mapKey: null, mapLoading: false };
const bytes = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));
// Map cell codes -> texture; the same call gives Navigate the planner memory's square to draw.
async function refreshNavMap(job, force = false) {
  const map = job?.latest?.navigation?.map, seq = map && 'file_seq' in map ? map.file_seq : map?.seq, key = `${job?.id}:${seq}:${job?.status}`;
  // Only once the session has written its map file (a robot link without a cloud stream never does).
  if (!job || !(seq > 0) || state.workspace !== 'navigate' || navAttach.mapLoading || (!force && key === navAttach.mapKey)) return;
  navAttach.mapLoading = true;
  try {
    const map = await request(`/api/nav/map?id=${encodeURIComponent(job.id)}`);
    navAttach.mapKey = key;
    if (state.workspace === 'navigate') scene.setNavMap({ ...map, codes: bytes(map.codes), height: bytes(map.height_cm) });
    const half = map.res_m / 2, far = (map.n - 1) * map.res_m + half;
    if (job.kind !== 'robot') nav.mapBounds = [map.lo[0] - half, map.lo[1] - half, map.lo[0] + far, map.lo[1] + far];
    scene.setNavOverlay(navOverlay());
  } catch { /* no map yet: the session has not published its memory */ }
  finally { navAttach.mapLoading = false; }
}
function robotLinkChrome(job) {
  const live = job?.kind === 'robot' && ['starting', 'running', 'cancelling', 'detached'].includes(job.status);
  const chip = $('hardware-chip');
  chip.classList.toggle('robot-live', live);
  chip.lastChild.textContent = live ? 'Robot link · goal + stand only' : 'No motor commands';
  chip.title = live ? 'The robot link may stage a goal and ask for a stand on node.py; Go stays with the operator.' : 'Studio has no DDS participant and no motor-command path. On a real robot it may only stage a goal and ask for a stand on node.py; Go stays with the operator.';
  $('footer-mode').lastChild.textContent = live
    ? ' Loopback only · robot link live: goal and stand to node.py; never Go, quit or motor commands'
    : ' Loopback only · replay, owned CPU simulation and the robot link (goal and stand only)';
}
async function attachNav(job) {
  robotLinkChrome(job);
  const waiting = job?.kind === 'robot' && !job?.latest?.frame && ['starting', 'running', 'detached'].includes(job?.status);
  if (state.workspace === 'navigate') {
    $('preview-note').hidden = !waiting;
    if (waiting) $('preview-note').textContent = "Connected · waiting for the robot's LIO pose from the deploy PC. The view still shows the last recording.";
  }
  if (!job?.latest?.frame) return;
  if (state.sessionId !== job.id) {
    // Only Navigate follows the live session: elsewhere (or after picking another run) the view stays put.
    if (state.workspace !== 'navigate' || navAttach.loading === job.id) return;
    navAttach.loading = job.id;
    const ok = await loadSession(job.id, { keepCamera: true }).finally(() => { navAttach.loading = null; });
    if (!ok) return;
    $('session-picker').value = job.id;
    if (state.workspace === 'navigate') { navLayers(true); navTopView(job.latest.frame.position); }
  }
  if (state.sessionId === job.id && ['starting', 'running', 'cancelling'].includes(job.status) && job.latest.frame)
    appendLiveFrame({ ...job.latest, status: job.latest.status, runtime: job.runtime });
  if (state.workspace === 'navigate') { scene.setNavOverlay(navOverlay()); refreshNavMap(job); }
}
// Navigate's map view: top-down on the robot, closer on narrow stages; the camera buttons say Top.
function navTopView(position) {
  const width = $('viewport').clientWidth || 800;
  // Centred: the title card above and the stage bar below cover about as much of the map.
  scene.topView(position, width < 520 ? 3.2 : width < 900 ? 4 : 5);
  markCamera('top');
}
function navLayers(entering) {
  const env = $('layer-environment'), map = $('layer-perception');
  if (entering) {
    navAttach.layers ??= { environment: env.checked, perception: map.checked };
    env.checked = nav.showTruth; if (!map.disabled) map.checked = true;
  } else if (navAttach.layers) {
    env.checked = navAttach.layers.environment; map.checked = navAttach.layers.perception; navAttach.layers = null;
  }
  syncLayers();
}
// The Navigate tab carries a dot while a session runs, so leaving it never hides a running robot.
const markNavLive = job => document.body.classList.toggle('nav-live', !!job && ['starting', 'running', 'cancelling', 'detached'].includes(job.status));
on('navigate:job', job => { markNavLive(job); attachNav(job).catch(e => showError(e.message)); });
on('navigate:overlay', () => { if (state.workspace === 'navigate') scene.setNavOverlay(navOverlay()); });
on('navigate:layers', () => { if (state.workspace === 'navigate') navLayers(true); $('layer-environment').checked = nav.showTruth; syncLayers(); });
on('navigate:finished', async job => {
  markNavLive(null);
  robotLinkChrome(job);
  $('preview-note').hidden = true;
  await refreshSessionList();
  if (job.result_session_id && state.sessionId === job.id && navAttach.opened !== job.id) {
    navAttach.opened = job.id;
    const keep = state.time;
    if (await loadSession(job.result_session_id, { keepCamera: true })) { $('session-picker').value = job.result_session_id; seek(keep); }
    else {
      // Never leave the picker naming a recording the view did not open (validation D3).
      if (state.sessionId) $('session-picker').value = state.sessionId;
      nav.notice = { kind: 'warning', text: 'The recording could not be opened in Replay; see the error banner. It is kept on disk.' };
      renderNavigate();
    }
  }
  if (state.workspace === 'navigate') { scene.setNavOverlay(navOverlay()); navLayers(true); refreshNavMap(job, true); }
});

on('rehearse:job', job => { if (state.workspace === 'rehearse' || rh.attached === job.id) attachLive(job).catch(e => showError(e.message)); });
on('rehearse:started', () => {
  rh.attached = null; $('workbench-error').hidden = true;
  // Say at once that the run started: the preview stays until the worker's first sample replaces it.
  if (state.workspace === 'rehearse' && document.body.classList.contains('previewing')) {
    $('mode-badge').textContent = '● Starting the CPU simulation'; $('mode-badge').classList.add('sim');
    $('navigation-caption').textContent = 'Booting the policy and SONIC on the CPU: the robot appears with its first sample, in about 10–30 s.';
  }
  $('rh-job')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});
on('rehearse:finished', async job => {
  await refreshSessionList();
  const viewing = (rh.attached === job.id && state.sessionId === job.id) || rh.followDetached === job.id;
  if (rh.followDetached === job.id) { rh.followDetached = null; emit('workbench:clear', `Following ${job.id}, which a previous gateway started; its recording opens when it finishes.`); }
  const opened = rh.recordingOpened === job.id;  // attachLive already started loading this recording
  rh.recordingOpened = null;
  if (viewing && job.result_session_id && !opened) {
    const keepTime = state.time;
    await loadSession(job.result_session_id, { keepCamera: true });
    seek(keepTime);
  } else if (viewing && !opened) {
    // Cancelled or killed without a recording: keep the partial live samples, clearly terminal.
    state.liveStatus = job.status;
    Object.assign(state.session.metadata, { mode: 'partial-live', termination_reason: job.error ?? `Run ${job.status}` });
    updateModeBadge();
    $('playback-state').textContent = `Run ${String(job.status)}`;
    renderInspector(state, { force: true });
    $('recording-warning').hidden = false;
    $('recording-warning').textContent = `Run ${String(job.status)} · ${job.error ?? 'No recording was saved.'} Showing only the live samples received; nothing after them is inferred.`;
  }
  if (rh.attached === job.id) rh.attached = null;
  if (opened && state.sessionId === job.result_session_id) $('session-picker').value = job.result_session_id;
  if (runs.table.length) refreshRuns().catch(() => {});
});
on('rehearse:suite-finished', () => { refreshRuns().catch(() => {}); refreshSessionList(); });
// While Rehearse previews a not-yet-run preset, the inspector, lanes and HUD still describe the
// last opened recording: mark them as such instead of letting them read as the preview's data.
function setPreviewing(on) {
  const was = document.body.classList.contains('previewing');
  document.body.classList.toggle('previewing', on);
  $('preview-note').hidden = !on;
  if (on) $('preview-note').textContent = `The inspector and timeline still show the last recording (${state.session?.metadata?.title ?? state.sessionId ?? 'none'}), not this preview.`;
  // A preview has run nothing: the title chips must not describe the last recording.
  if (on) {
    $('mode-badge').textContent = 'Preview · not run'; $('mode-badge').classList.remove('sim'); $('mode-badge').title = 'Configured geometry only: no policy has run in it yet.';
    $('policy-chip').hidden = true; $('privileged-badge').hidden = true;
  } else if (was && state.session) { updateModeBadge(); updatePolicyChip(); $('privileged-badge').hidden = !state.session.metadata.privileged_map; }
}
function restoreTitle() {
  if (state.session) { $('session-title').textContent = state.session.metadata.title ?? state.sessionId; renderFrame(true); }
}
// Navigate before a session: the chosen world and start, configured and not yet run.
on('navigate:preview', p => {
  if (state.workspace !== 'navigate') return;
  if (!p) {
    if (scene.view.arenaGroup.visible && !rh.attached) { scene.setArenaPreview(null); setPreviewing(false); restoreTitle(); }
    return;
  }
  setPreviewing(true);
  scene.setArenaPreview(p.map, { start: p.start, yaw: p.yaw });
  scene.fitScene(scene.sceneBounds([p.start]));
  $('session-title').textContent = p.label;
  $('source-badge').className = 'chip chip-configured'; $('source-badge').textContent = 'Configured';
  $('navigation-caption').textContent = 'The real room, as configured. Once it stands, the robot knows it only through its own LiDAR.';
});
on('rehearse:preview', markers => {
  if (state.workspace !== 'rehearse' || rh.attached || rehearsePreviewSuspensions) return;
  setPreviewing(true);
  scene.setArenaPreview(markers.map, { start: markers.start, yaw: markers.yaw, goal: markers.goal });
  scene.fitScene(scene.sceneBounds([markers.start, markers.goal]));
  $('session-title').textContent = `Preview · ${markers.map?.label ?? 'arena'}`;
  $('source-badge').className = 'chip chip-configured'; $('source-badge').textContent = 'Configured';
  $('navigation-caption').textContent = 'Not yet run. Press Run preset to execute the selected policy in the CPU simulation.';
});
on('rehearse:edit-arena', async id => { await setWorkspace('arena'); await loadFromMap(id).catch(e => showError(e.message)); });
on('arena:rehearse', async id => { await setWorkspace('rehearse'); await rehearseSelectMap(id); });
on('arena:preview3d', enabled => {
  arena.preview3d = enabled;
  setStage(enabled ? '3d' : 'arena');
  // The 3D preview shows a draft arena: the title, inspector and transport must not read as the last recording.
  setPreviewing(enabled);
  if (enabled) {
    $('session-title').textContent = `Arena draft · ${arena.label || 'unsaved'}`;
    $('navigation-caption').textContent = 'Draft arena geometry, starts and goals. Save it, then use Rehearse to run a policy on it.';
    $('source-badge').className = 'chip chip-configured'; $('source-badge').textContent = 'Configured';
  } else if (state.session) { $('session-title').textContent = state.session.metadata.title ?? state.sessionId; renderFrame(true); }
  if (enabled) { const q = activePreset(); scene.setArenaPreview(arenaDocument(), { start: q?.start_xy, yaw: q?.start_yaw_rad, goal: q?.goal_xy }); scene.fitScene(); }
});
on('arena:changed', () => { if (arena.preview3d) { const q = activePreset(); scene.setArenaPreview(arenaDocument(), { start: q?.start_xy, yaw: q?.start_yaw_rad, goal: q?.goal_xy }); } });
on('catalog:refreshed', catalog => { state.catalog = catalog; arena.catalog = catalog; if (runs.canvas) runs.catalogMaps = catalog.maps; });
on('arena:saved', async () => {
  $('workbench-error').hidden = true;  // an earlier "Fix before saving" no longer applies
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
// After a gateway restart the per-process POST token changes: refresh it once and retry.
setTokenRefresher(async () => { const fresh = await request('/api/workbench'); setToken(fresh.csrf_token); state.catalog = fresh; });

async function setWorkspace(name, { preserveScene = false } = {}) {
  if (!WORKSPACES[name]) name = 'replay';
  const ws = WORKSPACES[name], previous = state.workspace;
  state.workspace = name;
  for (const key of Object.keys(WORKSPACES)) document.body.classList.toggle(`ws-${key}`, key === name);
  updateDrawerMode();
  document.querySelectorAll('[data-workspace]').forEach(b => { const a = b.dataset.workspace === name; b.classList.toggle('active', a); b.setAttribute('aria-pressed', String(a)); });
  $('workbench-error').hidden = true;
  $('tool-panel').hidden = !ws.panel;
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== ws.panel; });
  $('tool-title').textContent = ws.title; $('tool-eyebrow').textContent = ws.eyebrow;
  sn.visible = name === 'sensors';
  document.body.classList.toggle('no-inspector', ['arena', 'runs', 'system'].includes(name));
  if (previous === 'runs' && name !== 'runs') scene.setComparison([]);
  if (previous === 'arena' && name !== 'arena' && arena.preview3d) { arena.preview3d = false; scene.setArenaPreview(null); }
  if (name !== 'rehearse') setPreviewing(false);
  if (previous === 'navigate' && name !== 'navigate') { scene.view.onPick = null; scene.setNavOverlay(null); scene.setNavMap(null); navAttach.mapKey = null; navLayers(false); resetNavPreview(); }
  if (name === 'navigate' && previous !== 'navigate') resetNavPreview();
  if (name !== 'rehearse' && name !== 'arena' && !rh.attached && scene.view.arenaGroup.visible) {
    scene.setArenaPreview(null);
    if (state.session) { $('session-title').textContent = state.session.metadata.title ?? state.sessionId; renderFrame(true); }
  }
  updateView({ workspace: name === 'replay' ? null : name });
  setStage(name === 'arena' && arena.preview3d ? '3d' : ws.stage);
  const preserving = name === 'rehearse' && preserveScene && !!state.session && !document.body.classList.contains('previewing');
  if (preserving) rehearsePreviewSuspensions++;
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
    if (name === 'navigate') {
      const catalog = await ensureCatalog();
      catalog.nav_options ??= await request('/api/nav/options').catch(() => null);
      if (!nav.catalog) await initNavigate(catalog); else { nav.catalog = catalog; renderNavigate(); }
      if (state.workspace !== 'navigate') return;
      scene.view.onPick = xy => pickGoal(xy);
      navLayers(true);
      scene.setNavOverlay(navOverlay());
      if (nav.job) refreshNavMap(nav.job, true);
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
  finally { if (preserving) rehearsePreviewSuspensions--; }
  emit('workspace', name);
}

async function renderSystem() {
  if (!state.robot) { try { state.robot = await request('/api/robot', undefined, { cache: 'no-cache' }); } catch (e) { state.robot = null; } }
  const kind = sessionKind(state.session);
  $('system-panel').innerHTML = `<div class="panel-section"><h4>Selected component</h4><div id="system-detail">${systemDetails(inspector.systemNode, state.session, state.robot)}</div></div>
    <div class="panel-section"><h4>This source</h4><p class="tiny">${escape(KIND_LABEL[kind])}</p>
    <label class="check"><input id="system-deploy" type="checkbox" ${state.systemDeploy ? 'checked' : ''}> Show the real-time deployment topology instead</label></div>
    <div class="panel-section"><h4>Boundary</h4><p class="tiny">Studio is observe-only. It never publishes <code>rt/lowcmd</code>, hand commands or ZMQ <code>pose</code>, and never connects to the planner node control port :5562. Physical E-stop and operator procedures own the robot.</p></div>`;
  $('system-stage').innerHTML = `<div class="system-layout"><section><span class="eyebrow">Deployment chain</span><h3>${state.systemDeploy ? 'Real-time deployment (source-configured)' : escape(state.session?.metadata?.title ?? 'System')}</h3><div id="system-map-host"></div></section>
    <section id="robot-contract"></section></div>`;
  const draw = () => renderSystemMap($('system-map-host'), state.session, { selected: inspector.systemNode, showDeploy: !!state.systemDeploy,
    onSelect: id => { inspector.systemNode = id; $('system-detail').innerHTML = systemDetails(id, state.session, state.robot); draw(); } });
  draw();
  renderRobotContract($('robot-contract'), state.robot);
  $('system-deploy').addEventListener('change', e => { state.systemDeploy = e.target.checked; renderSystem(); });
}

// ------------------------------------------------------------------ chrome
function buildLegend() {
  $('evidence-legend').innerHTML = `<h3>Evidence key</h3><p class="callout ok">${escape($('hardware-chip').title)}</p><p class="tiny">Every value carries one of these classes. Hover a chip anywhere for its reason.</p>
    ${Object.entries(EVIDENCE).map(([k, e]) => `<div class="legend-row">${chip(k)}<span>${escape(e.tip)}</span></div>`).join('')}
    <p class="tiny">CPU lockstep pauses physics while the planner runs. Success in Studio is a simulation result, never hardware readiness.</p>`;
}
function closePopovers(except = null) {
  document.querySelectorAll('.popover').forEach(p => { if (p.id !== except) p.hidden = true; });
  document.querySelectorAll('[aria-expanded][aria-controls]').forEach(b => { if (b.getAttribute('aria-controls') !== except && document.getElementById(b.getAttribute('aria-controls'))?.classList.contains('popover')) b.setAttribute('aria-expanded', 'false'); });
}
function togglePopover(id, button) {
  const node = $(id), open = node.hidden;
  closePopovers(id);
  node.hidden = !open; button?.setAttribute('aria-expanded', String(open));
}
// The inspector is a drawer from 1024 to 1279 px, and up to 1599 px in Navigate, where the map needs the room.
function updateDrawerMode() {
  const w = innerWidth, on = w >= 1024 && (w < 1280 || (state.workspace === 'navigate' && w < 1600));
  if (document.body.classList.contains('drawer-mode') !== on) { document.body.classList.toggle('drawer-mode', on); if (!on) setInspectorDrawer(false); scene.markDirty?.(); }
}
window.addEventListener('resize', () => updateDrawerMode());
function setInspectorDrawer(open) {
  open = !!open && document.body.classList.contains('drawer-mode');
  document.body.classList.toggle('show-inspector', open);
  $('inspector-backdrop').hidden = !open;
  $('inspector-toggle').setAttribute('aria-expanded', String(open));
  $('inspector-toggle').classList.toggle('active', open);
  if (open) document.querySelector('#focus-inspector [role=tab][aria-selected=true]')?.focus({ preventScroll: true });
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
  if (focus?.handleKey(e)) return;
  if (e.key === 'Escape' && document.body.classList.contains('show-inspector')) { setInspectorDrawer(false); $('inspector-toggle').focus(); return; }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return;
  if (state.workspace === 'arena' && e.key !== '?') return;  // the arena editor owns the keyboard
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
  else if (k === 'Escape') { closePopovers(); setInspectorDrawer(false); }
}

function bindChrome() {
  $('session-picker').addEventListener('change', async e => {
    const id = e.target.value;
    if (rh.attached && rh.attached !== id) rh.attached = null;
    // A live Navigate session follows its robot; another run opens in Replay while the session keeps running
    // (Navigate returns to it).
    if (state.workspace === 'navigate' && nav.job && id !== nav.job.id && ['starting', 'running', 'detached'].includes(nav.job.status)) await setWorkspace('replay');
    loadSession(id);
  });
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
  $('tool-close').addEventListener('click', () => focus?.active ? focus.closeSheet() : setWorkspace('replay'));
  $('evidence-button').addEventListener('click', () => togglePopover('evidence-legend', $('evidence-button')));
  $('inspector-toggle').addEventListener('click', () => setInspectorDrawer(!document.body.classList.contains('show-inspector')));
  $('hardware-chip').addEventListener('click', () => togglePopover('evidence-legend', $('evidence-button')));
  $('help-evidence').addEventListener('click', () => togglePopover('evidence-legend', $('evidence-button')));
  $('inspector-backdrop').addEventListener('click', () => setInspectorDrawer(false));
  $('help-button').addEventListener('click', () => togglePopover('help-overlay', $('help-button')));
  document.addEventListener('click', e => {
    const inspect = e.target.closest('[data-inspect-pipeline]');
    if (inspect) { selectPipelineStage(inspect.dataset.inspectPipeline); selectTab('pipeline', state); }
    const seekButton = e.target.closest('[data-seek]');
    if (seekButton) { setPlaying(false); seek(Number(seekButton.dataset.seek)); }
    const open = e.target.closest('[data-workspace-open]');
    if (open) setWorkspace(open.dataset.workspaceOpen);
    if (!e.target.closest('.popover, #layers-button, #evidence-button, #help-button, #hardware-chip')) closePopovers();
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
  // Notes, popovers and chips that float under the title row follow its height (it wraps on narrow stages).
  new ResizeObserver(([entry]) => $('viewport-shell').style.setProperty('--vp-top-h', `${Math.ceil(entry.target.getBoundingClientRect().height)}px`)).observe(document.querySelector('.vp-top'));
  focus = initFocus({ state, scene, rh, setWorkspace, setPlaying, seek, cameraView, previewMarkers, sampleHealth });
  $('focus-details-close').addEventListener('click', () => setInspectorDrawer(false));
  $('focus-enter').addEventListener('click', () => setInspectorDrawer(false));
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
    get navigate() { return nav; }, pickGoal, get navOverlay() { return scene.view.navGroup?.children.length ?? 0; },
    get focus() { return focus; },
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
    // Reloaded while a run is live (any workspace): resume following it.
    if (['simulation', 'live'].includes(state.session?.metadata?.mode) && state.session.metadata.kind === 'navigation') {
      if (state.workspace !== 'navigate') await setWorkspace('navigate');
    } else if (state.session?.metadata?.mode === 'simulation' && !rh.catalog) {
      await initRehearse(await ensureCatalog());
      rh.attached = state.sessionId;
    }
    if (view.get('play') === '1') setPlaying(true);
    if (view.get('focus') === '1') await focus.enter();
  } catch (error) { showError(error.message); $('loading-overlay').hidden = true; }
}
initialize();
