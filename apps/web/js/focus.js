// Stage: a full-screen presentation of the existing Studio scene and rehearsal lifecycle, laid out like the site's
// demo (title and layers top left, facts top right, one dock). No worker, model or navigation logic lives here;
// controls use the Studio actions. First built by Codex as the "Flow stage" (docs/STAGE.md).
import { $, on, emit, updateView, clock, finite } from './util.js';

const ACTIVE = ['queued', 'starting', 'running', 'cancelling', 'detached'];
const LAYERS = [['robot', 'Robot'], ['reference', 'Reference'], ['future', 'Planned'], ['trajectory', 'Path'], ['environment', 'Room']];
const LAYER_DOT = { robot: 'var(--c-bone)', reference: 'var(--c-ref)', future: 'var(--c-future)', trajectory: 'var(--c-travelled)', environment: 'var(--c-box)' };
const CAMERAS = ['orbit', 'follow', 'top', 'scene'];
const CAMERA_LABEL = { orbit: 'Orbit', follow: 'Follow', top: 'Top', scene: 'Fit' };

function policyName(p) {
  if (!p) return 'Policy unavailable';
  if (p.research_block) return `Flow ${p.research_block}${/retrieval-free/i.test(p.variant ?? '') ? '-RF' : ''}`;
  return p.label ?? p.short_label ?? p.id ?? 'Policy unavailable';  // the same name as the policy chip and Navigate
}

// Kept pure so provenance and pending-run behavior can be checked independently.
export function focusPresentation(state, rh, preview = false, layers = null, previewTitle = null) {
  const meta = state.session?.metadata ?? {};
  const selected = rh.catalog?.policies?.find(p => p.id === rh.policyId);
  const active = ACTIVE.includes(rh.job?.status);
  const waiting = active && state.sessionId !== rh.job.id;
  const empty = preview || waiting || !state.session;
  const live = !empty && ['simulation', 'live'].includes(meta.mode);
  const profile = meta.policy_profile;
  const displayed = empty ? 'No executed policy in this preview' : profile ? policyName(profile) : meta.policy_identity ?? 'Recorded policy unavailable';
  const realRobot = meta.recording_kind === 'robot-link' || meta.robot === 'real';
  const simulation = ['sonic-mujoco-lockstep', 'navigation-session'].includes(meta.recording_kind) || meta.mode === 'simulation';
  let mode = empty ? 'Arena preview · not executed' : live ? (realRobot ? 'Live robot observation' : 'Live CPU simulation') : realRobot ? 'Robot recording · replay' : simulation ? 'Simulation recording · replay' : 'Recorded data · replay';
  if (waiting) mode = 'Preparing simulation · awaiting samples';
  if (!empty && meta.mode === 'partial-live') mode = `Run ${state.liveStatus ?? 'ended'} · partial samples`;
  if (!empty && state.liveStatus === 'detached') mode = 'Detached simulation · read-only';
  // The map named is the one drawn: the robot's own (perception layer) or the configured room (simulator truth).
  const perceived = state.session?.perception?.available && (layers ? layers.perception : true);
  const source = empty ? 'Configured geometry · telemetry unavailable' : meta.privileged_map ? 'Privileged scene boxes · simulator truth'
    : perceived ? (live ? "Live perception · the robot's own LiDAR map" : 'Recorded perception · see Details for source')
    : layers?.environment ? 'Configured room · simulator truth (the robot does not see it)' : 'Map source unavailable';
  // A navigation session is graded walk by walk, not as one run.
  const walks = meta.test_result && Number.isFinite(meta.test_result.walks) ? meta.test_result : null;
  return { empty, live, waiting, active, displayed, selected: selected ? `${policyName(selected)}${selected.matches_adopted ? ' · adopted' : ''}` : 'Choose in Setup',
    mode, source, canReplay: !empty && !live && !state.loading && !!state.session?.frames?.length,
    title: empty ? previewTitle ?? rh.map?.label ?? 'Choose an arena in Setup' : meta.title ?? state.sessionId ?? 'Recorded session',
    identity: profile?.identity_sha256 ?? profile?.config_sha256 ?? null, realRobot,
    outcome: empty || live ? null : walks ? (walks.walks && walks.arrived === walks.walks ? 'walks_arrived' : 'walks_partial') : meta.test_result?.outcome ?? null,
    walks: walks ? `${walks.arrived ?? 0} of ${walks.walks ?? 0} walks arrived` : null };
}

const icon = (path) => `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const icons = {
  setup: icon('<path d="M4 7h16M4 17h16M8 4v6M16 14v6"/>'),
  restart: icon('<path d="M5 8V3m0 5h5M5 8a8 8 0 1 1-1 8"/>'),
  play: icon('<path d="m9 5 11 7-11 7Z"/>'),
  pause: icon('<path d="M9 5v14M15 5v14"/>'),
  camera: icon('<rect x="3" y="6" width="18" height="14" rx="3"/><path d="m8 6 1-3h6l1 3"/><circle cx="12" cy="13" r="3"/>'),
  details: icon('<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7h.01"/>'),
  exit: icon('<path d="M15 6l-6 6 6 6"/>'),
};

export function initFocus({ state, scene, rh, setWorkspace, setPlaying, seek, cameraView, previewMarkers, sampleHealth }) {
  let active = false, sheet = null, entering = false, lastFocus = null, returnFocus = null, cameFrom = 'replay';
  const root = document.createElement('div');
  root.id = 'focus-root'; root.hidden = true;
  root.innerHTML = `
    <div class="focus-top-left">
      <div class="focus-title focus-glass"><span class="focus-mark">G1</span><span><strong><span class="focus-brand">Deploy Studio · </span>Stage</strong><small class="focus-boundary"><span class="focus-local-view">Local view · </span>No motor commands</small></span></div>
      <div class="focus-layers focus-glass" role="group" aria-label="Scene layers">${LAYERS.map(([key, label]) => `<button id="focus-layer-${key}" data-focus-layer="${key}" aria-pressed="true" style="--dot: ${LAYER_DOT[key]}"><i></i>${label}</button>`).join('')}</div>
      <div class="focus-heading focus-glass" tabindex="-1" aria-label="What the stage shows">
        <p id="focus-mode" class="focus-mode" role="status"></p>
        <h2 id="focus-scene-name"></h2>
        <p id="focus-outcome" class="focus-outcome" hidden></p>
        <dl class="focus-source"><dt>Showing</dt><dd id="focus-displayed-policy"></dd><dt>Map</dt><dd id="focus-provenance"></dd><dt>Next run</dt><dd id="focus-selected-policy" class="focus-next"></dd></dl>
      </div>
      <div id="focus-notice" class="focus-notice" role="alert" hidden></div>
    </div>
    <div class="focus-top-right">
      <button id="focus-exit" class="focus-exit focus-glass">${icons.exit}<span>Back to Studio</span></button>
      <div class="focus-facts focus-glass" aria-label="Data at the displayed simulation time">
        <div><span id="focus-time-label">Sim time</span><strong id="focus-time">Unavailable</strong></div>
        <div><span>Goal distance</span><strong id="focus-distance">Unavailable</strong></div>
        <div><span>Obstacle contact</span><strong id="focus-contact">Unavailable</strong></div>
        <div title="Joint RMSE between the SONIC reference and the executed body at the cursor"><span>Tracking RMSE</span><strong id="focus-tracking">Unavailable</strong></div>
      </div>
    </div>
    <div class="focus-bottom"><p id="focus-hint" class="focus-hint">Drag to orbit · scroll to zoom</p>
      <div class="focus-dock focus-glass" role="group" aria-label="Stage controls">
        <button id="focus-setup" aria-expanded="false" aria-controls="tool-panel" title="Choose a policy, arena and preset, then run it">${icons.setup}<span>Setup</span></button>
        <button id="focus-restart" title="Restart the displayed recording">${icons.restart}<span>Restart</span></button>
        <button id="focus-play" class="focus-play">${icons.play}<span>Play</span></button>
        <div class="focus-scrub"><input id="focus-seek" type="range" min="0" max="1" step="0.001" value="0" aria-label="Seek displayed recording"><output id="focus-duration">—</output></div>
        <button id="focus-camera" title="Cycle camera: Orbit, Follow, Top, Fit">${icons.camera}<span>Orbit</span></button>
        <button id="focus-inspect" aria-expanded="false" aria-controls="focus-inspector" title="The full inspector: intent, joints, health, map, pipeline">${icons.details}<span>Details</span></button>
        <button id="focus-cancel" class="focus-cancel" hidden>Cancel run</button>
      </div>
    </div>
    <button id="focus-backdrop" class="focus-backdrop" aria-label="Close open panel" tabindex="-1" hidden></button>`;
  document.body.append(root);
  // Controls wrap on narrow screens (and during cancellation). Keep the facts
  // above the actual footer height instead of assuming a fixed dock height.
  const footerObserver = new ResizeObserver(([entry]) => {
    document.body.style.setProperty('--focus-footer-height', `${entry.borderBoxSize?.[0]?.blockSize ?? entry.contentRect.height}px`);
  });
  footerObserver.observe(root.querySelector('.focus-bottom'));
  const inspector = document.querySelector('.inspector');
  inspector.id = 'focus-inspector';
  const header = document.createElement('div'); header.className = 'focus-details-header';
  header.innerHTML = '<strong>Details</strong><button id="focus-details-close" aria-label="Close details">✕</button>';
  inspector.prepend(header);
  const text = (id, value) => { const el = $(id); if (el.textContent !== value) el.textContent = value; };

  // A preview (Rehearse's preset, Navigate's world) names itself in the scene title.
  function presentation() { const preview = document.body.classList.contains('previewing'); return focusPresentation(state, rh, preview, scene.view.layers, preview ? $('session-title').textContent : null); }
  function refresh() {
    if (!active) return;
    const p = presentation(), meta = state.session?.metadata ?? {}, frame = state.measuredFrame ?? state.frame;
    text('focus-mode', p.mode); text('focus-scene-name', p.title);
    const outcomes = { goal_completion: 'Goal completed', timeout: 'Time limit reached', obstacle_collision: 'Obstacle collision', fall: 'Fall', runtime_error: 'Runtime error' };
    $('focus-outcome').hidden = !p.outcome;
    text('focus-outcome', p.walks ? `Recorded session · ${p.walks}` : p.outcome ? `Recorded outcome · ${outcomes[p.outcome] ?? p.outcome.replaceAll('_', ' ')}` : '');
    $('focus-outcome').dataset.outcome = p.outcome ?? '';
    text('focus-displayed-policy', p.displayed); text('focus-selected-policy', p.selected); text('focus-provenance', p.source);
    $('focus-displayed-policy').title = p.empty ? '' : `Displayed recording: ${state.sessionId ?? 'unavailable'}${p.identity ? ` · identity ${p.identity}` : ''}`;
    root.dataset.preview = String(p.empty); root.dataset.live = String(p.live);
    const goal = frame?.navigation ? frame.navigation.goal_xy : meta.goal_xy;
    const distance = !p.empty && Array.isArray(goal) && Array.isArray(frame?.position) ? Math.hypot(frame.position[0] - goal[0], frame.position[1] - goal[1]) : null;
    const health = !p.empty && state.frame ? sampleHealth(state) : null, contact = health?.contact_force_n ?? null, tracking = health?.tracking_rmse_rad ?? null;
    text('focus-time-label', p.realRobot ? 'Recording time' : 'Sim time');
    text('focus-time', !p.empty && finite(state.time) ? `${state.time.toFixed(2)} s` : 'Unavailable');
    text('focus-tracking', finite(tracking) ? `${tracking.toFixed(3)} rad` : 'Unavailable');
    text('focus-distance', finite(distance) ? `${distance.toFixed(2)} m` : 'Unavailable');
    text('focus-contact', finite(contact) ? `${contact.toFixed(1)} N` : 'Unavailable');
    $('focus-play').disabled = !p.canReplay; $('focus-restart').disabled = !p.canReplay;
    const playLabel = p.live ? 'Live' : state.playing && p.canReplay ? 'Pause' : 'Play';
    if ($('focus-play').dataset.label !== playLabel) {
      $('focus-play').innerHTML = `${playLabel === 'Pause' ? icons.pause : icons.play}<span>${playLabel}</span>`;
      $('focus-play').dataset.label = playLabel;
    }
    $('focus-play').setAttribute('aria-label', p.live ? 'Live simulation: playback control unavailable' : `${playLabel} displayed recording`);
    $('focus-play').title = p.canReplay ? `${playLabel} recording (Space)` : p.live ? 'The worker advances simulation; this is not replay.' : 'Run a preset or open a recording to enable playback.';
    text('focus-hint', p.waiting ? 'Starting the selected policy. Waiting for its first captured state.' : p.empty ? 'Preview only. Open Setup to run this arena.' : p.live ? 'Following the CPU worker · simulation may advance slower than wall time' : 'Drag to orbit · scroll to zoom · Space to play');
    const range = $('focus-seek'); range.disabled = !p.canReplay;
    range.min = String(p.empty ? 0 : state.session?.frames?.[0]?.time ?? 0);
    range.max = String(p.empty ? 1 : meta.duration_s || 1); range.value = String(p.empty ? 0 : state.time);
    range.setAttribute('aria-valuetext', p.empty ? 'No executed samples' : `${clock(state.time)} of ${clock(meta.duration_s ?? 0)}`);
    text('focus-duration', p.empty ? 'Not run' : clock(meta.duration_s ?? 0));
    const camera = $('focus-camera');
    if (camera.dataset.cameraMode !== scene.view.camera_mode) {
      camera.innerHTML = `${icons.camera}<span>${CAMERA_LABEL[scene.view.camera_mode] ?? 'Camera'}</span>`;
      camera.dataset.cameraMode = scene.view.camera_mode;
    }
    for (const [key] of LAYERS) {
      const input = $(`layer-${key}`), button = $(`focus-layer-${key}`);
      button.disabled = p.empty || !input || input.disabled;
      button.setAttribute('aria-pressed', String(!!input?.checked));
      button.title = button.disabled ? 'This layer is unavailable in the current view' : `${input.checked ? 'Hide' : 'Show'} ${key === 'reference' ? 'commanded reference' : key === 'future' ? 'commanded planned future' : key === 'environment' ? 'configured collision scene' : key}`;
    }
    $('focus-inspect').disabled = p.empty;
    const cancel = $('rh-cancel'); $('focus-cancel').hidden = !p.active;
    $('focus-cancel').disabled = !cancel || cancel.disabled || rh.job?.status === 'detached';
    const warnings = (p.empty ? ['workbench-error'] : ['workbench-error', 'recording-warning']).map(id => $(id)).filter(el => el && !el.hidden && el.textContent.trim()).map(el => el.textContent.trim());
    const error = rh.job?.error;
    if (error && !ACTIVE.includes(rh.job?.status)) warnings.push(`Run ${rh.job.status}: ${error}`);
    const notice = [...new Set(warnings)].join(' ');
    $('focus-notice').hidden = !notice; text('focus-notice', notice);
  }

  function closeSheet({ restore = true } = {}) {
    const was = sheet; sheet = null;
    document.body.classList.remove('focus-setup-open', 'focus-inspect-open');
    $('focus-backdrop').hidden = true;
    $('focus-setup').setAttribute('aria-expanded', 'false'); $('focus-inspect').setAttribute('aria-expanded', 'false');
    for (const el of [$('tool-panel'), inspector]) { el.removeAttribute('role'); el.removeAttribute('aria-modal'); }
    if (restore && was) (returnFocus?.isConnected ? returnFocus : $('focus-setup')).focus();
  }
  async function openSheet(which) {
    if (sheet === which) { closeSheet(); return; }
    closeSheet({ restore: false }); returnFocus = which === 'setup' ? $('focus-setup') : $('focus-inspect');
    if (which === 'setup' && state.workspace !== 'rehearse') await setWorkspace('rehearse', { preserveScene: true });
    if (!active) return;
    if (which === 'details' && presentation().empty) return;
    sheet = which;
    document.body.classList.add(which === 'setup' ? 'focus-setup-open' : 'focus-inspect-open');
    $('focus-backdrop').hidden = false;
    const panel = which === 'setup' ? $('tool-panel') : inspector;
    panel.setAttribute('role', 'dialog'); panel.setAttribute('aria-modal', 'true');
    returnFocus.setAttribute('aria-expanded', 'true');
    (which === 'setup' ? $('tool-close') : $('focus-details-close')).focus();
    refresh();
  }
  async function enter() {
    if (active || entering) return;
    entering = true; lastFocus = document.activeElement;
    try {
      cameFrom = state.workspace;
      // Navigate stays Navigate (its own map and goals); other workspaces present their recording from Replay.
      if (!['replay', 'rehearse', 'navigate'].includes(state.workspace)) await setWorkspace('replay');
      active = true; root.hidden = false; document.body.classList.add('flow-focus');
      updateView({ focus: '1' });
      refresh(); root.querySelector('.focus-heading').focus({ preventScroll: true });
    } finally { entering = false; }
  }
  async function exit({ restore = true } = {}) {
    if (!active) return;
    closeSheet({ restore: false }); active = false; root.hidden = true;
    document.body.classList.remove('flow-focus'); updateView({ focus: null });
    // Back where Stage was entered (Setup opens Rehearse, which must not become the new home).
    if (restore && cameFrom && cameFrom !== state.workspace) await setWorkspace(cameFrom);
    (lastFocus?.isConnected && lastFocus !== document.body ? lastFocus : $('focus-enter')).focus();
  }
  function handleKey(e) {
    if (!active) return false;
    if (e.key === 'Escape') { e.preventDefault(); sheet ? closeSheet() : exit(); return true; }
    if (sheet) {
      if (e.key === 'Tab') {
        const panel = sheet === 'setup' ? $('tool-panel') : inspector;
        const items = [...panel.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), summary, a[href], [tabindex="0"]')].filter(el => el.getClientRects().length);
        const first = items[0], last = items.at(-1);
        if (e.shiftKey && (document.activeElement === first || !panel.contains(document.activeElement))) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && (document.activeElement === last || !panel.contains(document.activeElement))) { e.preventDefault(); first?.focus(); }
      }
      return true;
    }
    if (['INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(document.activeElement?.tagName)) return true;
    if (!presentation().canReplay && [' ', 'ArrowLeft', 'ArrowRight', 'j', 'k', 'l'].includes(e.key)) { e.preventDefault(); return true; }
    return false;
  }

  $('focus-enter').addEventListener('click', enter);
  $('focus-exit').addEventListener('click', () => exit());
  $('focus-setup').addEventListener('click', () => openSheet('setup'));
  $('focus-inspect').addEventListener('click', () => openSheet('details'));
  $('focus-details-close').addEventListener('click', () => closeSheet());
  $('focus-backdrop').addEventListener('click', () => closeSheet());
  $('focus-play').addEventListener('click', () => { if (presentation().canReplay) $('play').click(); refresh(); });
  $('focus-restart').addEventListener('click', () => { if (presentation().canReplay) $('restart').click(); refresh(); });
  $('focus-cancel').addEventListener('click', () => $('rh-cancel')?.click());
  $('focus-seek').addEventListener('input', e => { if (presentation().canReplay) { setPlaying(false); seek(Number(e.target.value)); refresh(); } });
  $('focus-camera').addEventListener('click', () => { cameraView(CAMERAS[(CAMERAS.indexOf(scene.view.camera_mode) + 1) % CAMERAS.length], true); refresh(); });
  root.querySelectorAll('[data-focus-layer]').forEach(b => b.addEventListener('click', () => { $(`layer-${b.dataset.focusLayer}`)?.click(); refresh(); }));
  on('rehearse:started', () => {
    if (!active) return;
    setPlaying(false); emit('rehearse:preview', previewMarkers());
    closeSheet(); refresh();
  });
  for (const event of ['session', 'frame', 'rehearse:preview', 'rehearse:job', 'rehearse:finished', 'workbench:error', 'workbench:clear']) on(event, refresh);
  on('workspace', name => { if (active && !['rehearse', 'replay', 'navigate'].includes(name)) exit({ restore: false }); });
  const observer = new MutationObserver(refresh);
  observer.observe($('rehearse-panel'), { childList: true, subtree: true });
  for (const id of ['workbench-error', 'recording-warning', 'play', 'camera-orbit', 'camera-follow', 'camera-top', 'camera-scene'])
    observer.observe($(id), { childList: true, attributes: true, attributeFilter: ['hidden', 'aria-pressed'] });
  return { get active() { return active; }, get sheet() { return sheet; }, enter, exit, refresh, closeSheet, handleKey };
}
