// Deploy workspace: connect, scan, pick a goal, rehearse, deploy and review, in 3D (docs/DEPLOY.md).
//
// Studio relays an operator's press to the deploy kit's console, which owns the robot. Every motor gate stays in the
// console and the hub; this page never makes a press up and never retries one, except E-STOP. Data comes from the
// gateway's /api/deploy/* passthrough of the kit's deploy service (API v1).
//
// Polling (docs/DEPLOY.md, Browser): state 1 Hz, live view 5 Hz with cloud/memory cursors, scan live 2 Hz while a scan
// runs, panel state 2.5 Hz while a session is live; one request in flight per poller, aborted at 1.5 s, at most three
// polls in flight. The console heartbeat (1 Hz) runs outside that budget and never waits on the deploy service. E-STOP
// aborts every fetch first, then posts and retries every 300 ms until every console answers.
//
// Whose session (contract v3 A): the running session's receipt (state.live.<slot>.receipt) says its mode, robot,
// profile, odometry and every word the page uses about it; Connect's selectors are the NEXT session's settings and never
// relabel a running one. A page that finds a session it did not start views it read-only until the operator attaches.
//
// Freshness (contract v3 C): every source the page shows (deploy service, console, panel, node view, lidar, map, plan,
// recorder) is aged from its own receipt; motion-enabling presses lock when a source they depend on is stale or unknown,
// with the source and its age in the reason. Stops never lock on staleness.
import { $, escape, num, finite, emit, updateView } from './util.js';
import * as d3 from './deploy3d.js';

const STEPS = [
  { id: 'connect', label: 'Connect' }, { id: 'scan', label: 'Scan' }, { id: 'goal', label: 'Goal' },
  { id: 'rehearse', label: 'Rehearse' }, { id: 'deploy', label: 'Deploy' }, { id: 'review', label: 'Review' },
];
const SCAN_FRESH_S = 15 * 60, STALE_S = 1, LOST_S = 3, ESTOP_GIVE_UP_MS = 10000, SONIC_LONG_S = 8 * 60;
// How each odometry is validated, said plainly wherever it matters (never a precision claim the data does not carry).
const ODOMETRY = {
  fused: { label: 'FAST-LIO + legs', note: 'Fused: LIO corrects, legs and IMU predict; LIO doubt stops the walk.',
    validation: 'FAST-LIO + legs: validated offline on recorded walks; not yet validated walking on the robot' },
  leg: { label: 'Legs only', note: 'No lidar odometry: distance is under-counted by 25-40 %.',
    validation: 'Legs only: measured on the 2026-10-27 walks to under-count distance by 25-40 % and drift in heading' },
  zmq: { label: 'FAST-LIO only', note: 'The LIO pose alone, through the bridge.',
    validation: 'FAST-LIO only: validated offline on recorded walks; not yet validated walking on the robot' },
};
const odomLabel = o => ODOMETRY[o]?.label ?? (o === 'dds' ? 'Simulator truth' : o ?? 'Unavailable');
// Freshness sources (contract v3 C): stale above `stale` seconds; the view is LOST above 3 s.
const SOURCES = {
  hub: { label: 'Deploy service', short: 'Service', stale: 3 },
  console: { label: 'Console heartbeat', short: 'Console', stale: 1 },
  panel: { label: 'Console panel', short: 'Panel', stale: 3 },
  view: { label: 'Node view', short: 'View', stale: STALE_S, lost: LOST_S },
  lidar: { label: 'Lidar', short: 'Lidar', stale: 1.5 },
  map: { label: 'Planner map', short: 'Map', stale: 12 },
  plan: { label: 'Plan', short: 'Plan', stale: 3 },
  recorder: { label: 'Recorder', short: 'Recorder', stale: 6 },
};
const SESSION_SOURCES = ['console', 'panel', 'view', 'lidar', 'map', 'plan', 'recorder'];
// What each motion-enabling press needs fresh. Stops (E-STOP, Stand, Take over) need nothing.
const NEEDS = { start: ['hub'], arm: ['hub', 'console', 'panel'], sonic: ['hub', 'console', 'panel', 'view'], map: ['hub', 'console', 'panel', 'view'],
  goal: ['hub', 'console', 'panel', 'view'], go: ['hub', 'console', 'panel', 'view'] };
const MISMATCH = { scan: 'another scan', scan_memory_sha: 'the scan\'s memory changed', goal: 'another goal', goal_scene: 'another goal', profile: 'another profile',
  profile_sha: 'the profile\'s contents changed', bundle_sha: 'another policy bundle', rules_sha: 'other guard rules', odom: 'another odometry',
  starts: 'other start poses', state: 'not complete', identity: 'no identity receipt (an older set)', drift_model: 'another drift model' };
const CONFIRM = [
  ['gantry', 'The gantry (or a spotter on the rope) carries the robot\'s weight'],
  ['estop', 'The physical E-stop was tested today and is in reach'],
  ['remote', 'The remote holder is briefed: only Select (E-STOP) and D-up (stand)'],
  ['rope', 'The rope is held high, above 1.6 m, out of the lidar\'s view'],
];
const TAGS = ['clean', 'touched', 'stumble', 'caught', 'aborted', 'setup issue'];
const PHASE = { BOOT: 'Starting the planner', WAIT: 'Standing · ready', PRESCAN: 'Pre-scan', RUN: 'Walking', ARRIVED: 'Arrived · standing', STOPPED: 'Stopped · standing' };
const ICON = { pass: '✓', warn: '!', block: '✕', unknown: '?', later: '·', done: '✓', now: '›', todo: '', info: 'i' };
const GROUPS = [['link', 'Link'], ['robot', 'Robot'], ['perception', 'Perception'], ['scene', 'Scene'], ['operator', 'Operator']];
const AFTER = { connect: 'after Connect', scan: 'after the scan', session: 'after Start session', arm: 'after Arm', node: 'once the planner is up', goal: 'after Send goal', rehearsal: 'after the rehearsal' };

const store = {
  get(k, d = null) { try { return localStorage.getItem(`studio.deploy.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(`studio.deploy.${k}`); else localStorage.setItem(`studio.deploy.${k}`, String(v)); } catch { /* optional */ } },
};
// The session this tab attached to lives in sessionStorage: a reload keeps it, another tab or browser does not.
const tabStore = {
  get(k) { try { return sessionStorage.getItem(`studio.deploy.${k}`); } catch { return null; } },
  set(k, v) { try { if (v === null) sessionStorage.removeItem(`studio.deploy.${k}`); else sessionStorage.setItem(`studio.deploy.${k}`, String(v)); } catch { /* optional */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const nowS = () => Date.now() / 1000;

export const S = {
  ctx: null, visible: false, step: store.get('step', 'connect'),
  state: null, stateAt: 0, stateOk: null, everOk: false, stateError: null, cachedLive: false,
  readiness: null, mode: store.get('mode', 'practice'), operator: store.get('operator', ''), profile: store.get('profile', null),
  odom: store.get('odom', null), seconds: 8, room: store.get('room', null), scanName: store.get('scan', null), scene: null, sceneLoading: null,
  pendingScan: null, scanLive: null,
  goal: null, hover: null, pickToken: 0,
  rehearsalName: null, tracks: null, tracksFor: null, tracksSet: null, trackErr: {}, timeline: { t: 0, playing: false, duration: 0, raf: 0 },
  view: null, viewAt: -Infinity, viewSlot: null, cursors: { cloud: -1, mem: -1 }, panel: null, panelAt: 0,
  src: {}, returnedAt: -Infinity, hb: null, hbSupported: null, attached: tabStore.get('attached'), identityOpen: false,
  match: null, acts: {}, liveDetail: null, link: null, mapCollapsed: false,
  lease: { id: null, holder: null, until: 0, supported: null, lost: null, conflict: null },
  estop: { state: null, targets: [], t0: 0, error: null },
  sheet: null, busy: null, notice: null, ladderNote: {}, sendResult: null, goResult: null, attempts: {}, tagDraft: {},
  reviewName: null, reviewAttempt: null, detail: {}, manifest: null, manifestFor: null, manifestGood: {},
  readinessOpen: store.get('readiness', innerWidth >= 1560 ? '1' : '0') === '1',
  highlight: null, model: null, autoCheckKey: null, layersOpen: false, lastFrameStep: null,
};

// ------------------------------------------------------------------------------------------------ requests
const inflight = new Set();
let pollsInFlight = 0;
async function api(path, { method = 'GET', body, timeout = 1500, headers = {}, csrf = false, retried = false } = {}) {
  const ctl = new AbortController(); inflight.add(ctl);
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const options = { method, cache: 'no-store', signal: ctl.signal, headers: { ...headers } };
    if (body !== undefined) { options.headers['Content-Type'] = 'application/json'; options.body = JSON.stringify(body); }
    if (csrf) options.headers['X-Studio-Token'] = await S.ctx.csrf(false);
    const response = await fetch(path, options);
    let data = {};
    try { data = await response.json(); } catch { data = {}; }
    if (csrf && response.status === 403 && !retried && /token/i.test(data?.error ?? '')) {
      await S.ctx.csrf(true);
      return api(path, { method, body, timeout, headers, csrf, retried: true });
    }
    return { ok: response.ok, status: response.status, data: data ?? {} };
  } catch (error) {
    return { ok: false, status: 0, data: { error: ctl.signal.aborted ? 'no answer in time' : error.message }, aborted: ctl.signal.aborted };
  } finally { clearTimeout(timer); inflight.delete(ctl); }
}
const reason = r => r.data?.reason || r.data?.error || r.data?.detail || (r.status ? `refused (${r.status})` : 'no answer');
// A v3 endpoint this deploy service (or gateway) does not have: 404/405, or the gateway's {supported: false}.
const unsupportedReply = r => r.status === 404 || r.status === 405 || r.data?.supported === false;
const unsupportedWhy = r => r.data?.detail ?? r.data?.error ?? 'unsupported by this deploy service';
// The source's own age as the gateway measured it (contract v3 C: source_age_s), else the service's served_age_s.
const age0 = d => (finite(d?.source_age_s) ? d.source_age_s : finite(d?.served_age_s) ? d.served_age_s : 0);

// One request per poller, at most three polls in flight; a poller whose turn is taken tries again shortly.
// An `independent` poller (the console heartbeat) is outside the three-poll budget: a hung deploy service can never
// starve the one source that says whether the console itself still answers.
class Poller {
  constructor(name, everyMs, run, enabled, { independent = false } = {}) { Object.assign(this, { name, everyMs, run, enabled, independent, busy: false, timer: 0 }); }
  start(delay = 0) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), delay); }
  async tick() {
    if (!this.enabled()) return this.start(Math.max(this.everyMs, 500));
    if (this.busy || (!this.independent && pollsInFlight >= 3) || S.estop.state === 'sending') return this.start(100);
    this.busy = true; if (!this.independent) pollsInFlight++;
    const t0 = performance.now();
    try { await this.run(); } catch (error) { console.warn(`deploy ${this.name} poll`, error); }
    finally { this.busy = false; if (!this.independent) pollsInFlight--; }
    this.start(Math.max(0, this.everyMs - (performance.now() - t0)));
  }
}

// ------------------------------------------------------------------------------------------------ freshness
// A source's age now = the age it reported when it arrived + the time since. A tab back from the background treats every
// source as stale until it arrives again. Unknown (never arrived) is neither fresh nor green.
function mark(name, age0 = 0, extra = {}) { S.src[name] = { at: performance.now(), age0: finite(age0) ? Math.max(0, age0) : 0, ...extra }; }
const srcKey = name => (name === 'console' ? `console:${session()?.slot ?? 'robot'}` : name);
function srcAge(name) { const s = S.src[srcKey(name)]; return s ? s.age0 + (performance.now() - s.at) / 1000 : null; }
function srcState(name) {
  const s = S.src[srcKey(name)]; if (!s) return 'unknown';
  if (s.at < S.returnedAt) return 'stale';
  const a = srcAge(name), def = SOURCES[name];
  return def.lost && a > def.lost ? 'lost' : a > def.stale ? 'stale' : 'fresh';
}
const ageText = a => (!finite(a) ? '' : a < 10 ? `${a.toFixed(1)} s` : a < 120 ? `${Math.round(a)} s` : `${Math.round(a / 60)} min`);
// Why a source is not usable now, or null. `unknownText` overrides the generic "no data yet".
function srcReason(name, { stable = false } = {}) {
  const st_ = srcState(name), def = SOURCES[name];
  if (st_ === 'fresh') return null;
  if (st_ === 'unknown') {
    if (name === 'console' && S.hbSupported === false) return `${def.label}: unsupported by this Studio gateway (no /api/deploy/heartbeat)`;
    return `${def.label}: no data yet`;
  }
  if (S.src[srcKey(name)].at < S.returnedAt) return `${def.label}: this tab was in the background — waiting for fresh data`;
  return `${def.label} is ${stable ? 'stale' : `${ageText(srcAge(name))} old`} (stale above ${def.stale} s)`;
}
// The first source a press depends on that is not fresh: {key, text}. Its text carries the age (updated in place).
function freshLock(press) {
  for (const name of NEEDS[press] ?? []) { const why = srcReason(name, { stable: true }); if (why) return { key: `fresh:${name}:${srcState(name)}`, text: why, source: name }; }
  return null;
}
function clearSessionSources() { for (const k of Object.keys(S.src)) if (SESSION_SOURCES.some(n => k === n || k.startsWith(`${n}:`))) delete S.src[k]; }

// ------------------------------------------------------------------------------------------------ derived state
const st = () => S.state ?? {};
const liveSlot = slot => st().live?.[slot] ?? null;
// The operator's session: the robot slot, or the sim slot when it holds a practice session.
function session() {
  const r = liveSlot('robot'), s = liveSlot('sim');
  if (r?.running) return { slot: 'robot', ...r };
  if (s?.running && s.practice) return { slot: 'sim', ...s };
  return null;
}
// The running session as its receipt describes it (contract v3 A); older services without a receipt fall back to the
// slot's own fields, never to this page's settings.
function ident(sess = session()) {
  if (!sess) return null;
  const r = sess.receipt && typeof sess.receipt === 'object' ? sess.receipt : null;
  const kind = r?.kind ?? (sess.slot === 'robot' && !sess.practice ? 'robot' : sess.practice ? 'practice' : 'rehearsal');
  return { name: sess.name, slot: sess.slot, kind, receipt: r,
    robot: r?.robot ?? (kind === 'robot' ? st().robot_link?.robot ?? 'robot' : 'simulated G1'), operator: r?.operator ?? sess.operator ?? null,
    started: r?.started ?? null, profile: r?.profile?.name ?? sess.profile ?? null, profileSha: r?.profile?.sha ?? null,
    odom: r?.odom ?? sess.odom ?? null, scan: r?.scan?.name ?? sess.scan ?? null, scanSha: r?.scan?.memory_sha ?? null };
}
const shortName = n => String(n ?? '').replace(/^(robot|practice|rehearse)-/, '$1 ');
const shortSha = s => (s ? String(s).slice(0, 8) : '—');
// This tab controls a session only after attaching to it (it started it here, or the operator pressed Attach).
const attached = () => { const s = session(); return !!s && S.attached === s.name; };
function setAttached(name) { S.attached = name ?? null; tabStore.set('attached', S.attached); }
// Why this tab may not press a motion-enabling control now (who controls), or null.
function controlLock() {
  const sess = session();
  if (sess && !attached()) return `Viewing only: attach to ${sess.name} to control it (Connect)`;
  if (!holdsLease()) return S.lease.lost ? `You lost the controls: ${S.lease.lost} — take them again in Connect` : 'Take the controls first (Connect)';
  return null;
}
// An act whose reply never came: the page waits to learn its result from the console and never presses again.
const unknownAct = () => Object.values(S.acts).find(a => a.state === 'unknown' && !a.dismissed && (!a.session || a.session === session()?.name)) ?? null;
const ACT_WORDS = { arm: 'Arm', s: 'Start SONIC', c: 'Clear map', send_goal: 'Send goal', g: 'GO', stop: 'End session', start: 'Start session', tag: 'Tag', h: 'Stand', t: 'Take over' };
// The rehearsal sets: v3 rows carry `state`; older rows say `running: 'exact' | null`.
const setState = r => r?.state ?? (r?.running ? 'running' : r?.verdict ? 'complete' : 'partial');
const runningCase = r => (typeof r?.running === 'string' ? r.running : Object.entries(r?.runs ?? {}).find(([, v]) => v && typeof v === 'object' && v.state === 'running')?.[0] ?? null);
const rehearsalRunning = () => (st().rehearsals ?? []).find(r => setState(r) === 'running') ?? null;
const scans = () => st().scans ?? [];
const scanRow = name => scans().find(s => s.name === name) ?? null;
function scanStale(row = scanRow(S.scanName)) {
  if (!row) return null;
  if (row.walked_since) return 'the robot walked since this scan';
  if (finite(row.age_s) && row.age_s > SCAN_FRESH_S) return `this scan is ${Math.round(row.age_s / 60)} min old (fresh for 15 min)`;
  return null;
}
const profiles = () => {
  const list = [...(st().profiles ?? [])];
  return list.sort((a, b) => (b.featured ? 1 : 0) - (a.featured ? 1 : 0));
};
// The NEXT session's settings (Connect): what Start session will ask for. A running session keeps its own (ident()).
const nextProfile = () => S.profile ?? st().default_profile ?? profiles()[0]?.name ?? null;
// FAST-LIO + legs by default: always in Practice (the simulator stands in for FAST-LIO), on the robot when its bridge runs
const nextOdom = () => S.odom ?? (S.mode !== 'robot' || st().robot_link?.lio_bridge ? 'fused' : 'leg');
// What the page acts with now: the running session's receipt, else the next session's settings.
const profileName = () => ident()?.profile ?? nextProfile();
const profileLabel = name => profiles().find(p => p.name === name)?.label ?? name ?? 'Unavailable';
const odomName = () => ident()?.odom ?? nextOdom();
const isRobot = () => { const id = ident(); return id ? id.kind === 'robot' : S.mode === 'robot'; };
const holdsLease = () => S.lease.supported === false ? !!S.operator.trim() : !!S.lease.id && !S.lease.lost;
// The goal check is good for its TTL (contract v3 F: expires_at - issued_at, else check_ttl_s, else 10 min) from its receipt.
function goalCheckLeft(check = S.goal?.check) {
  if (!check?.receivedAt) return null;
  const ttl = finite(check.expires_at) && finite(check.issued_at) ? check.expires_at - check.issued_at : finite(check.check_ttl_s) ? check.check_ttl_s : 600;
  return ttl - (performance.now() - check.receivedAt) / 1000;
}
function goalStatus(check = S.goal?.check) {
  if (!check) return 'pending';
  if (check.unavailable) return 'pending';
  if (check.ok === false) return 'block';
  if ((goalCheckLeft(check) ?? 1) <= 0) return 'pending';  // never an expired green
  return (check.checks ?? []).some(c => c.status === 'warn') ? 'warn' : 'pass';
}
const goalUsable = () => !!S.goal?.check?.check_id && S.goal.check.scan === S.scanName && !['block', 'pending'].includes(goalStatus());
// The rehearsal set for this scan, goal, profile and odometry is the deploy service's pick (GET /api/deploy/rehearsal/match):
// the newest COMPLETE set whose identity matches. Never chosen here from the list's order.
const matchKey = () => (S.goal?.xy && S.scanName ? JSON.stringify([S.scanName, S.goal.xy, profileName(), odomName()]) : null);
function matchNow() { const m = S.match; return m && m.key === matchKey() ? m : null; }
const rehearsalFor = () => matchNow()?.data?.complete ?? null;
const rehearsalPending = () => matchNow()?.data?.running ?? null;
function liveAge() { return S.view ? srcAge('view') ?? Infinity : Infinity; }
const liveState = () => { if (!S.view) return 'lost'; const s = srcState('view'); return s === 'unknown' ? 'stale' : s; };
const walking = () => ['PRESCAN', 'RUN'].includes(S.panel?.phase ?? S.view?.phase);
// The console's attempt rows (g1deploy/attempts.py) say `result` and `end_goal_dist_m`; the page reads outcome / final_dist_m.
const attemptRow = a => ({ ...a, outcome: a.outcome ?? a.result ?? null, final_dist_m: a.final_dist_m ?? a.end_goal_dist_m ?? null });
const panelAttempts = () => (Array.isArray(S.panel?.attempts) ? S.panel.attempts.map(attemptRow) : []);

function stepState(id) {
  const sess = session();
  switch (id) {
    case 'connect': return { done: S.stateOk === true && holdsLease() };
    case 'scan': { const stale = S.scanName && scanStale(); return { done: !!S.scene && S.scene.name === S.scanName && !stale, stale: stale ? `Scan: ${stale}` : null }; }
    case 'goal': {
      const stale = S.goal?.check && S.goal.check.scan !== S.scanName ? 'Goal: checked on another scan' : null;
      return { done: goalUsable(), stale };
    }
    case 'rehearse': {
      const rec = rehearsalFor(), others = matchNow()?.data?.others ?? [];
      return { done: !!rec?.verdict && !passageMissed(rec), stale: !rec && others.length && S.goal ? 'Rehearsal: no matching completed set for this goal, profile and odometry' : null };
    }
    case 'deploy': return { done: panelAttempts().some(a => a.outcome) || (!sess && Object.values(S.attempts).some(l => l.some(a => a.outcome))) };
    default: return { done: false };
  }
}

// ------------------------------------------------------------------------------------------------ polling
const pollers = {
  state: new Poller('state', 1000, pollState, () => S.visible || S.everOk || S.cachedLive),
  // The console heartbeat (direct path, 2 Hz: at 1 Hz its age would cross the 1 s stale line between two polls) runs
  // whatever the deploy service does: it is how a hub outage with the
  // console alive and a hung console with the hub alive are told apart.
  heartbeat: new Poller('heartbeat', 500, pollHeartbeat, () => S.everOk || S.cachedLive || S.visible, { independent: true }),
  readiness: new Poller('readiness', 2000, pollReadiness, () => S.visible && S.stateOk),
  scanLive: new Poller('scan', 500, pollScanLive, () => S.visible && S.stateOk !== false && (st().scan_job?.running || !!S.pendingScan)),
  live: new Poller('live', 200, pollLive, () => S.visible && S.stateOk !== false && !!viewSlot()),
  panel: new Poller('panel', 400, pollPanel, () => S.visible && S.stateOk !== false && !!session()),
  lease: new Poller('lease', 1000, renewLease, () => !!S.lease.id && !document.hidden),
  match: new Poller('match', 1000, pollMatch, () => S.visible && S.stateOk === true && !!matchKey()),
  // The live session's recording health and the gateway's audit log: slow, informational.
  recorder: new Poller('recorder', 2000, pollRecorder, () => S.visible && S.stateOk === true && !!session()),
  link: new Poller('link', 5000, pollLink, () => S.visible),
};
// A view that answered 404 (the console ended between two state polls) is not asked again until the state names a
// new console in that slot.
function viewSlot() {
  const sess = session(), slot = sess ? sess.slot : liveSlot('sim')?.running && rehearsalRunning() ? 'sim' : null;
  if (!slot) return null;
  const gone = S.liveGone;
  return gone && gone.name === liveSlot(slot)?.name && performance.now() - gone.at < 3000 ? null : slot;
}

async function pollState() {
  const r = await api('/api/deploy/state');
  if (r.ok && r.data.api) {
    const before = S.state, wasScanning = before?.scan_job?.running;
    if (!S.everOk) emit('deploy:service', true);
    S.state = r.data; S.stateAt = performance.now(); S.stateOk = true; S.everOk = true; S.stateError = null; S.cachedLive = false;
    mark('hub', age0(r.data));
    onState(before, wasScanning);
  } else {
    S.stateOk = false; S.stateError = reason(r);
    S.cachedLive = !!(r.data?.studio?.estop_targets?.length);
  }
  renderBar(); renderContext();
  if (S.visible) { renderStrip(); renderPanel(); renderStage(); }
}
function onState(before, wasScanning) {
  // Defaults that need the service: profile, odometry, the newest scan.
  if (!S.profile && st().default_profile) S.profile = st().default_profile;
  if (!S.scanName || !scanRow(S.scanName)) {
    const pick = scans().find(s => (isRobot() ? !s.practice && !s.name.startsWith('practice-') : true));
    if (pick) selectScan(pick.name, false);
  }
  // A scan that finished: open the new scan (seen running, or never seen running after 3 s).
  if (S.pendingScan) {
    if (st().scan_job?.running) S.pendingSeen = true;
    else if (S.pendingSeen || performance.now() - (S.pendingScanAt ?? 0) > 3000) {
      // The job has ended; the hub lists the new scan on its next state (1 Hz). Wait for it, or for the job's error.
      const name = S.pendingScan, job = st().scan_job ?? {}, waited = performance.now() - (S.pendingScanAt ?? 0);
      const done = () => { S.pendingScan = null; S.pendingSeen = false; S.scanLive = null; };
      if (scanRow(name)) { done(); S.scene = null; selectScan(name, true); }
      else if (job.error && (!job.name || job.name === name)) { done(); S.notice = { kind: 'warning', text: `The scan failed: ${job.error}` }; }
      else if (waited > 240000) { done(); S.notice = { kind: 'warning', text: `The scan ${name} did not appear in the deploy service's list` }; }
    }
  }
  // Session started or ended.
  const sess = session(), name = sess?.name ?? null;
  if (name !== S.sessionName) {
    if (S.sessionName && !name) { S.reviewName = S.sessionName; S.reviewAttempt = null; d3.clearLive(); S.view = null; S.panel = null; }
    if (S.sessionName) { delete S.detail[S.sessionName]; S.liveDetail = null; }
    if (name) { S.tagDraft = {}; S.attemptEnd = null; d3.clearTrail(); S.cursors = { cloud: -1, mem: -1 }; S.view = null; S.sendResult = null; S.goResult = null; S.startCheck = null; S.autoCheckKey = null; S.clearedAt = null; S.ladderNote = {}; if (!['sending', 'undelivered'].includes(S.estop.state)) { S.estopGen = (S.estopGen ?? 0) + 1; S.estop = { state: null, targets: [], t0: 0, error: null }; } }
    clearSessionSources(); S.liveDetail = null;
    // Started from this tab (its start reply named it, or it appeared within 20 s of this tab's start): attached.
    if (name && S.startedHere && (S.startedHere.name === name || (!S.startedHere.name && performance.now() - S.startedHere.at < 20000))) setAttached(name);
    if (name) S.startedHere = null;
    if (!name || (S.attached && S.attached !== name)) setAttached(name && S.attached === name ? name : null);
    S.sessionName = name;
  }
  if (!viewSlot() && S.view) { S.view = null; d3.clearLive(); }
  // The matched set (the service's pick) is complete: load its tracks once per set.
  const rec = rehearsalFor();
  const tracksKey = rec ? `${rec.name}:${setState(rec)}` : null;
  if (rec?.verdict && S.tracksFor !== tracksKey) loadTracks(rec, tracksKey);
  if (!rec && S.tracksFor) { S.tracksFor = null; S.tracksSet = null; S.tracks = null; d3.setRehearsal(null); }
}

async function pollReadiness() {
  const sess = session(), q = new URLSearchParams();
  if (S.scanName) q.set('scan', S.scanName);
  q.set('slot', sess?.slot ?? (isRobot() ? 'robot' : 'sim'));
  const r = await api(`/api/deploy/readiness?${q}`);
  if (r.ok && Array.isArray(r.data.checks)) {
    S.readiness = r.data.checks; S.readinessAt = performance.now(); renderReadiness();
    const anchors = anchoredChecks(), key = JSON.stringify([anchors, S.highlight]);
    if (key !== S.anchorKey) { S.anchorKey = key; d3.setAnchors(anchors, S.highlight); }  // the 3D changes only when they do
  }
}

async function pollScanLive() {
  const r = await api('/api/deploy/scan/live', { timeout: 1500 });
  if (!r.ok) return;
  S.scanLive = r.data;
  if (r.data.running) { await d3.setScanLive(r.data); d3.setScanPoseRobot(true); }
  if (S.visible && S.step === 'scan') renderPanel(true);
}

async function pollLive() {
  const slot = viewSlot(); if (!slot) return;
  // The memory is asked for in full every 10 s: after Clear map (a new epoch) its seq may start below the cursor.
  if (performance.now() - (S.memAt ?? 0) > 10000) S.cursors.mem = -1;
  const r = await api(`/api/deploy/live?slot=${slot}&cloud_after=${S.cursors.cloud}&mem_after=${S.cursors.mem}`);
  if (!r.ok || !r.data.ok) {
    if (r.status === 404) { S.liveGone = { name: liveSlot(slot)?.name ?? null, at: performance.now() }; if (S.view) { S.view = null; d3.clearLive(); } }
    return;
  }
  const v = r.data;
  if (v.memory?.epoch !== undefined && S.view?.memEpoch !== undefined && v.memory.epoch !== S.view.memEpoch) S.cursors.mem = -1;
  if (v.cloud?.seq !== undefined) S.cursors.cloud = v.cloud.seq;
  if (v.memory?.seq !== undefined) { S.cursors.mem = v.memory.seq; S.memAt = performance.now(); }
  S.view = { ...v, memEpoch: v.memory?.epoch ?? S.view?.memEpoch, slot }; S.viewAt = performance.now(); S.viewSlot = slot;
  // Each part of the view is its own source: the node view as served, the lidar when a new cloud arrived, the planner's
  // map when its memory changed, the plan by its own age when the node reports it.
  const served = age0(v);
  const sameView = finite(v.t_mono) && S.lastViewT === v.t_mono && S.lastViewSlot === slot;
  S.lastViewT = v.t_mono; S.lastViewSlot = slot;
  if (!sameView || !S.src.view) mark('view', served);
  if (v.cloud && (v.cloud.n ?? 1) > 0) mark('lidar', finite(v.cloud.age_s) ? v.cloud.age_s : served);
  if (v.memory) mark('map', finite(v.memory.age_s) ? v.memory.age_s : served);
  else if (!S.src.map && v.memory === null) mark('map', served);
  if (v.plan && finite(v.plan.age_s)) mark('plan', v.plan.age_s); else if (v.plan) mark('plan', served + (finite(v.latency_s) ? v.latency_s : 0));
  if (Array.isArray(v.qpos) && Number.isFinite(v.t_mono)) {
    const h = S.poseTrail = (S.poseTrail ?? []).filter(e => e.slot === slot && v.t_mono - e.t < 1.2 && e.t < v.t_mono);
    h.push({ t: v.t_mono, x: v.qpos[0], y: v.qpos[1], slot });
  }
  // A rehearsal's drift run is never drawn in the scene (its estimate is in the drifted frame).
  const rec = rehearsalRunning(), which = runningCase(rec), rehearsal = slot === 'sim' && !session();
  await d3.setLive(v, { slot: rehearsal ? 'sim-rehearsal' : slot, hideRobot: rehearsal && which === 'drift',
    label: rehearsal && which !== 'drift' ? `Rehearsal · ${which} run (its own estimate)` : null });
  d3.setLost(false);
  if (S.visible) { renderHud(); renderBanners(); maybeStartCheck(); }
}

async function pollPanel() {
  const sess = session(); if (!sess) return;
  if (S.panelGone?.name === sess.name && performance.now() - S.panelGone.at < 3000) return;
  const r = await api(`/api/deploy/panel?slot=${sess.slot}`);
  if (r.status === 404) { S.panelGone = { name: sess.name, at: performance.now() }; return; }
  if (!r.ok) return;
  // A panel whose console clock did not move since the last poll is the same snapshot again (a frozen relay): it does
  // not refresh the panel's age.
  const tm = r.data.console_t_mono, same = finite(tm) && S.panel?.console_t_mono === tm && sess.name === S.panelFor;
  S.panel = r.data; S.panelAt = performance.now(); S.panelFor = sess.name;
  if (!same || finite(r.data.source_age_s)) mark('panel', age0(r.data));
  if (Array.isArray(r.data.attempts)) S.attempts[sess.name] = r.data.attempts.map(attemptRow);
  if (S.visible) { renderPanel(); renderHud(); renderTicker(); renderStrip(); renderIdentity(); }
}

// The console heartbeat on the direct path (GET /api/deploy/heartbeat): v3 rows {slot, session, reached, console_age_s},
// older gateways {slot, name, ok, console_age_s}. A console counts only for the session the page knows in its slot.
async function pollHeartbeat() {
  const r = await api('/api/deploy/heartbeat', { timeout: 1500 });
  if (unsupportedReply(r)) { S.hbSupported = false; return; }
  if (!r.ok) { S.hbError = reason(r); return; }
  S.hbSupported = true; S.hbError = null;
  const rows = (Array.isArray(r.data.consoles) ? r.data.consoles : Array.isArray(r.data.targets) ? r.data.targets : []).map(row => ({
    slot: row.slot, session: row.session ?? row.name ?? null, reached: row.reached ?? row.ok ?? false,
    age: finite(row.console_age_s) ? row.console_age_s : null, latency: row.latency_ms ?? null, error: row.error ?? null }));
  S.hb = { rows, at: performance.now(), hub: r.data.hub ?? null };
  for (const row of rows) {
    const known = liveSlot(row.slot)?.name;
    if (row.reached && row.age !== null && (!known || !row.session || row.session === known)) mark(`console:${row.slot}`, row.age, { session: row.session });
  }
  renderBar();
}

// The deploy service's pick of the rehearsal set for this goal (contract v3 B). Asked again when the inputs change, when
// the service's list of sets changes, and every 5 s.
async function pollMatch() {
  const key = matchKey(); if (!key) return;
  const sig = JSON.stringify((st().rehearsals ?? []).map(r => [r.name, setState(r), r.verdict ?? null, runningCase(r)]));
  if (S.match?.key === key && (S.match.unsupported ? performance.now() - S.match.at < 30000 : S.match.sig === sig && performance.now() - S.match.at < 5000)) return;
  const [x, y] = S.goal.xy, q = new URLSearchParams({ scan: S.scanName, x: String(x), y: String(y), profile: profileName() ?? '', odom: odomName() ?? '' });
  const r = await api(`/api/deploy/rehearsal/match?${q}`, { timeout: 3000 });
  if (matchKey() !== key) return;
  const before = JSON.stringify([S.match?.data?.complete?.name, setState(S.match?.data?.complete), S.match?.data?.running?.name, S.match?.unsupported]);
  if (r.ok && r.data && typeof r.data === 'object' && r.data.supported !== false) S.match = { key, sig, at: performance.now(), data: { complete: r.data.complete ?? null, running: r.data.running ?? null, others: r.data.others ?? [] } };
  else if (unsupportedReply(r)) S.match = { key, sig, at: performance.now(), data: null, unsupported: unsupportedWhy(r) };
  else S.match = { ...(S.match?.key === key ? S.match : {}), key, sig, at: performance.now(), error: reason(r) };
  if (JSON.stringify([S.match?.data?.complete?.name, setState(S.match?.data?.complete), S.match?.data?.running?.name, S.match?.unsupported]) !== before) { onState(S.state, false); renderAll(); }
}

// The live session's detail (contract v3 E) for its receipt and recording health; the same endpoint feeds Review.
async function pollRecorder() {
  const sess = session(); if (!sess) return;
  if (S.liveDetail?.name === sess.name && S.liveDetail.unsupported && performance.now() - S.liveDetail.at < 30000) return;
  const r = await api(`/api/deploy/session?name=${encodeURIComponent(sess.name)}`, { timeout: 3000 });
  if (session()?.name !== sess.name) return;
  if (unsupportedReply(r)) { S.liveDetail = { name: sess.name, at: performance.now(), unsupported: unsupportedWhy(r) }; }
  else if (r.ok) {
    S.liveDetail = { name: sess.name, data: r.data, at: performance.now() };
    const rec = r.data.recording ?? sess.recording;
    if (rec) mark('recorder', finite(rec.source_age_s) ? rec.source_age_s : finite(rec.age_s) && !finite(rec.t_mono) ? rec.age_s : 0);
  }
  if (S.visible) renderIdentity();
}
async function pollLink() {
  const r = await api('/api/deploy/link', { timeout: 2000 });
  if (r.ok) { S.link = r.data; renderIdentity(); renderContext(); }
}

// ------------------------------------------------------------------------------------------------ the lease
async function takeLease(takeOver = false) {
  const operator = S.operator.trim(); if (!operator) return;
  S.busy = 'lease'; renderPanel(true);
  const r = await api('/api/deploy/lease', { method: 'POST', body: { operator, ...(takeOver ? { take_over: true } : {}) }, csrf: true, timeout: 4000 });
  S.busy = null;
  if (r.ok && r.data.lease_id) {
    Object.assign(S.lease, { id: r.data.lease_id, holder: r.data.holder ?? operator, until: r.data.until ?? 0, supported: true, lost: null, conflict: null });
    pollers.lease.start(1000);
  } else if (r.status === 404 || r.status === 405) {
    Object.assign(S.lease, { supported: false, id: null, conflict: null, lost: null });
  } else if (r.status === 409) {
    S.lease.conflict = r.data.holder ?? 'another tab';
  } else S.notice = { kind: 'warning', text: `Could not take the controls: ${reason(r)}` };
  renderAll();
}
async function renewLease() {
  if (!S.lease.id) return;
  const r = await api('/api/deploy/lease/renew', { method: 'POST', body: { lease_id: S.lease.id }, csrf: true });
  if (r.ok) { S.lease.until = r.data.until ?? S.lease.until; if (S.lease.lost) { S.lease.lost = null; renderAll(); } }
  else if (r.status === 409 || r.status === 404) {
    S.lease.lost = r.data.holder ? `${r.data.holder} took the controls` : 'the lease expired (this tab was hidden or offline)';
    S.lease.id = null; renderAll();
  }
}
function releaseLease() {
  if (!S.lease.id) return;
  api('/api/deploy/lease/release', { method: 'POST', body: { lease_id: S.lease.id }, csrf: true });
  S.lease.id = null;
}

// ------------------------------------------------------------------------------------------------ acts
// One press, relayed once. The reply (done / refused + reason) is shown where the press was made, with the session that
// acknowledged it. A press into a session carries expect.session (the session this tab attached to): a console that is
// not that session refuses it. A reply that never came (gateway 202 {state: unknown}, or no answer in time) is NOT a
// refusal: the page asks the console's act record (GET /api/deploy/act_status) until it knows, and never presses again.
const SESSION_ACTS = new Set(['arm', 's', 'c', 'send_goal', 'g', 'stop', 'tag', 'note', 'start_check']);
async function act(name, body = {}, { slot = session()?.slot, timeout = 9000 } = {}) {
  const sess = session(), payload = { act: name, ...(slot ? { slot } : {}), id: uuid(), operator: S.operator.trim() || undefined, ...body };
  if (SESSION_ACTS.has(name) && sess) payload.expect = { ...(payload.expect ?? {}), session: S.attached ?? sess.name };
  if (S.lease.id) payload.lease_id = S.lease.id;
  S.busy = name; renderAll();
  const r = await api('/api/deploy/act', { method: 'POST', body: payload, csrf: true, timeout });
  S.busy = null;
  const record = { id: payload.id, act: name, slot: payload.slot ?? null, session: payload.expect?.session ?? null, since: performance.now(), wall: Date.now() };
  // Unknown: the gateway lost the reply (202), or this page got none (aborted or the network failed after sending).
  const noReply = [0, 502, 504].includes(r.status);
  const byState = r.status === 202 && r.data.reconcile === 'state';
  if ((r.status === 202 && !byState && (r.data.state === 'unknown' || r.data.result === 'unknown')) || (noReply && payload.slot && SESSION_ACTS.has(name) && name !== 'start_check')) {
    S.acts[payload.id] = { ...record, state: 'unknown', note: r.status === 202 ? 'the gateway lost the console\'s reply' : r.data.error };
    reconcileAct(payload.id);
    return { ok: false, unknown: true, id: payload.id, r, data: r.data, reason: null };
  }
  // A service-level press (scan, rehearse, start) without a reply is not a refusal either: the state shows if it acted.
  if (noReply || byState) return { ok: false, noReply: true, id: payload.id, r, data: r.data, reason: `no reply from the deploy service (${reason(r)}) — it may still have acted; this page shows it when it did` };
  const ok = r.ok && r.data.ok !== false && r.data.result !== 'refused';
  S.acts[payload.id] = { ...record, state: ok ? 'done' : 'refused', reason: ok ? null : reason(r), ackSession: r.data.session ?? r.data.act?.session ?? null };
  return { ok, r, data: r.data, reason: ok ? null : reason(r), id: payload.id, ack: ackWords(r.data, payload.expect?.session) };
}
// "· acknowledged by robot 141951-deploy", or a warning when another session answered; empty without an echo.
function ackWords(data, expected) {
  const got = data?.session ?? data?.act?.session ?? null;
  if (!got) return '';
  if (expected && got !== expected) return ` · ANSWERED BY ANOTHER SESSION (${got}) — check the identity strip`;
  return ` · acknowledged by ${shortName(got)}`;
}
// Ask the console's act record until it knows (every 0.5 s for 10 s, then every 2 s). Never resends.
async function reconcileAct(id) {
  const a = S.acts[id]; if (!a || a.reconciling) return;
  a.reconciling = true; renderAll();
  while (S.acts[id]?.state === 'unknown') {
    const waited = (performance.now() - a.since) / 1000;
    await new Promise(r => setTimeout(r, waited < 10 ? 500 : 2000));
    const q = new URLSearchParams({ id, ...(a.slot ? { slot: a.slot } : {}), ...(a.session ? { session: a.session } : {}) });
    const r = await api(`/api/deploy/act_status?${q}`, { timeout: 2000 });
    const cur = S.acts[id]; if (!cur) return;
    if (r.status === 405 || r.data?.supported === false || (r.status === 404 && !('known' in (r.data ?? {})))) { if (!cur.unsupported) { cur.unsupported = true; renderAll(); } continue; }
    if (!r.ok || !r.data?.known) {
      cur.lastAsk = performance.now(); cur.askError = r.ok ? null : reason(r);
      // The console's own record has no such press, asked for 15 s: it never arrived (pressing again is safe).
      if (r.ok && r.data?.known === false) { cur.unknownSince ??= performance.now(); if (performance.now() - cur.unknownSince > 15000) { Object.assign(cur, { state: 'refused', reason: 'the console has no record of it: it never arrived (you may press again)', learned: true }); onActLearned(cur); renderAll(); } }
      continue;
    }
    const result = r.data.result;
    if (result === 'done') Object.assign(cur, { state: 'done', ackSession: r.data.session ?? null, learned: true });
    else if (result === 'refused') Object.assign(cur, { state: 'refused', reason: r.data.reason ?? 'refused', learned: true });
    else { cur.queued = result; continue; }
    onActLearned(cur);
    renderAll();
  }
}
// What the page does once an unknown press is known: the same as a reply would have done.
function onActLearned(a) {
  const words = a.state === 'done' ? `${ACT_WORDS[a.act] ?? a.act}: the console's record says it was received${a.ackSession ? ` (${shortName(a.ackSession)})` : ''}.`
    : `${ACT_WORDS[a.act] ?? a.act}: the console's record says it was refused: ${a.reason}`;
  const key = { arm: 'arm', s: 'sonic', c: 'map' }[a.act];
  if (key) S.ladderNote[key] = { kind: a.state === 'done' ? 'ok' : 'warning', text: words };
  if (a.act === 'g') S.goResult = { ok: a.state === 'done', text: a.state === 'done' ? null : a.reason, at: Date.now(), learned: words };
  if (a.act === 'send_goal') S.sendResult = { ...(S.sendResult ?? {}), ok: a.state === 'done', text: a.state === 'done' ? null : a.reason, learned: words, unknown: false };
  if (a.act === 'c' && a.state === 'done') { S.clearedAt = performance.now(); S.cursors.mem = -1; }
  pollPanel();
}
function unknownWords(a, { stable = false } = {}) {
  const age = Math.round((performance.now() - a.since) / 1000);
  return `${ACT_WORDS[a.act] ?? a.act}: acknowledgement unavailable — checking console state${stable ? '' : ` (${age} s)`}. Not resent.${a.unsupported ? ' This deploy service cannot report it: look at the console\'s own panel before pressing again.' : ''}`;
}
function expectNow(fields) {
  const sess = session(), out = {};
  if (fields.includes('session') && sess) out.session = S.attached ?? sess.name;
  if (fields.includes('runner') && S.panel?.runner) out.runner = S.panel.runner;
  if (fields.includes('attempts') && S.panel) out.attempts = panelAttempts().length;
  if (fields.includes('goal_seq') && finite(S.view?.goal_seq)) out.goal_seq = S.view.goal_seq;
  return out;
}

async function startScan() {
  const seconds = Math.max(3, Math.min(30, Number(S.seconds) || 8));
  const room = practiceRoom();
  const body = isRobot() ? { seconds } : { seconds, ...(room?.startsWith('course:') ? { course: room.slice(7) } : room ? { scan: room.slice(5) } : {}) };
  const res = await act(isRobot() ? 'scan' : 'practice_scan', body, { slot: null });
  if (res.ok) { S.pendingScan = res.data.name ?? null; S.pendingScanAt = performance.now(); S.scanLive = null; pollers.scanLive.start(200); }
  S.notice = res.ok ? null : { kind: 'warning', text: res.noReply ? `Scan: ${res.reason}` : `Scan refused: ${res.reason}` };
  renderAll();
}
const baseScan = () => scans().find(s => !s.practice && !s.name.startsWith('practice-'))?.name ?? S.scanName;
// Practice rooms: the twin of each real scan (newest first), then the kit's built-in courses.
function practiceRooms() {
  const real = scans().filter(s => !s.practice && !s.name.startsWith('practice-'))
    .map(s => ({ value: `scan:${s.name}`, label: `Twin of ${scanLabel(s)}` }));
  const courses = (st().courses ?? []).map(c => ({ value: `course:${c}`, label: `Course · ${c}` }));
  return [...real, ...courses];
}
function practiceRoom() {
  const rooms = practiceRooms();
  return rooms.find(r => r.value === S.room)?.value ?? rooms[0]?.value ?? null;
}

async function runRehearsal() {
  const passage = S.goal?.passage?.required ? { a: S.goal.passage.a, b: S.goal.passage.b } : undefined;
  const res = await act('rehearse', { scan: S.scanName, goal_scene: S.goal.xy, profile: profileName(), odom: odomName(), ...(passage ? { passage } : {}) }, { slot: null });
  S.notice = res.ok ? null : res.unknown ? { kind: 'warning', act: res.id } : { kind: 'warning', text: res.noReply ? `Rehearsal: ${res.reason}` : `Rehearsal refused: ${res.reason}` };
  if (res.ok) { S.rehearsalName = res.data.name; S.tracks = null; S.tracksFor = null; S.tracksSet = null; d3.setRehearsal(null); if (S.match) S.match.at = 0; }
  pollState(); renderAll();
}
// A case's track: v3 runs are {name, state, ...}; older ones a bare name.
const caseRunName = run => (run && typeof run === 'object' ? run.name : run) ?? null;
// Tracks load with bounded backoff (0.5, 1, 2, 4, 8 s): a failed case says so with a Retry, the others still draw.
async function loadTracks(rec, key) {
  S.tracksFor = key; S.trackErr = {};
  const runs = rec.runs ?? {}, out = {};
  await Promise.all(Object.entries(runs).map(async ([which, run]) => {
    const name = caseRunName(run); if (!name) return;
    for (let attempt = 0; attempt < 5; attempt++) {
      const r = await api(`/api/deploy/rehearsal/track?name=${encodeURIComponent(name)}`, { timeout: 6000 });
      if (S.tracksFor !== key) return;
      if (r.ok && r.data.ok !== false && !r.data.running && Array.isArray(r.data.qpos)) { out[which] = r.data; delete S.trackErr[which]; return; }
      if (r.ok && r.data.running) return;  // not finished: no error
      S.trackErr[which] = { reason: reason(r), tries: attempt + 1, giveUp: attempt === 4 };
      if (S.visible && S.step === 'rehearse') renderPanel();
      if (attempt < 4) await new Promise(res => setTimeout(res, 500 * 2 ** attempt));
    }
  }));
  if (S.tracksFor !== key) return;
  S.tracks = out; S.tracksSet = rec.name;
  const duration = await d3.setRehearsal(out), first = d3.rehearsalFirstMove();
  S.timeline = { ...S.timeline, t: first, t0: Math.max(0, first - 1), duration, playing: false };
  applyContext(); d3.setScanPoseRobot(!S.view && !S.scanLive?.running);
  renderAll();
}

// Start session asks for the NEXT session's settings (Connect); the tab that starts it is attached to it.
async function startSession(confirm) {
  const robot = S.mode === 'robot';
  const body = { mode: robot ? 'robot' : 'sim', practice: !robot, scan: S.scanName, profile: nextProfile(), odom: nextOdom(),
    operator: S.operator.trim(), confirm };
  S.startedHere = { at: performance.now(), name: null };
  const res = await act('start', body, { slot: null, timeout: 15000 });
  if (res.ok) { S.startedHere.name = res.data.name ?? null; if (res.data.name) setAttached(res.data.name); closeSheet(); S.notice = null; S.ladderNote = {}; }
  else if (res.unknown) { closeSheet(); S.notice = { kind: 'warning', act: res.id }; }
  else if (res.noReply) { closeSheet(); S.notice = { kind: 'warning', text: `Start session: ${res.reason}` }; }
  else { S.startedHere = null; S.sheetError = res.reason; }
  await pollState(); renderAll();
}
async function ladderAct(key) {
  const sess = session(); if (!sess) return;
  const map = { arm: ['arm', ['session']], sonic: ['s', ['session', 'runner']], map: ['c', ['session']] };
  const [name, fields] = map[key];
  const res = await act(name, { expect: expectNow(fields) });
  S.ladderNote[key] = res.ok ? { kind: 'ok', text: `${{ arm: 'Armed: the planner node is starting.', sonic: 'SONIC is in CONTROL.', map: 'Map cleared: the robot rescans for 10 s.' }[key]}${res.ack}` }
    : res.unknown ? { kind: 'pending', act: res.id } : { kind: 'warning', text: `Refused by the console: ${res.reason}` };
  if (res.unknown) S.notice = { kind: 'warning', act: res.id };  // shown even on a rung already done (Clear map again)
  if (key === 'map' && res.ok) { S.clearedAt = performance.now(); S.autoCheckKey = null; S.cursors.mem = -1; }
  closeSheet(); pollPanel(); renderAll();
}
async function sendGoal() {
  const sess = session(); if (!sess || !goalUsable()) return;
  const passage = S.goal.passage?.required ? { a: S.goal.passage.a, b: S.goal.passage.b } : undefined;
  const res = await act('send_goal', { scan: S.scanName, goal_scene: S.goal.xy, check_id: S.goal.check.check_id, profile: profileName(),
    ...(passage ? { passage } : {}), expect: expectNow(['session']) }, { timeout: 12000 });
  S.sendResult = { ok: res.ok, unknown: !!res.unknown, act: res.id, text: res.ok ? null : res.reason, ack: res.ack ?? '', check: res.data.check ?? null, goalOdom: res.data.goal_odom ?? null, at: Date.now(), goal: [...S.goal.xy] };
  if (res.data.check) applyStartCheck(res.data.check);
  if (res.ok) d3.clearTrail();
  pollPanel(); renderAll();
}
async function go() {
  const sess = session(); if (!sess) return;
  // What was in force at GO goes with it: the matched rehearsal set (or none) and the operator's override tick.
  const rec = rehearsalFor(), cautions = goCautions();
  const res = await act('g', { expect: expectNow(['session', 'runner', 'attempts', 'goal_seq']),
    ...(rec ? { rehearsal: { name: rec.name, verdict: rec.verdict ?? null, state: setState(rec) } } : {}),
    ...(S.sheet?.ack && cautions.length ? { rehearsal_override: { operator: S.operator.trim() || null, reason: cautions.join('; ') } } : {}) });
  S.goResult = { ok: res.ok, unknown: !!res.unknown, act: res.id, text: res.ok ? null : res.reason, ack: res.ack ?? '', at: Date.now() };
  if (res.ok || res.unknown) closeSheet(); else S.sheetError = `Refused by the console: ${res.reason}`;
  pollPanel(); renderAll();
}
async function stopSession() {
  const sess = session(); if (!sess) return;
  const res = await act('stop', {}, { slot: sess.slot, timeout: 15000 });
  if (res.ok) { closeSheet(); S.reviewName = sess.name; S.reviewAttempt = null; setStep('review'); }
  else if (res.unknown) { closeSheet(); S.notice = { kind: 'warning', act: res.id }; }
  else S.sheetError = res.reason;
  await pollState(); renderAll();
}
async function saveTag(key) {
  const draft = S.tagDraft[key] ?? {}, sess = session(), n = Number(String(key).split(':').pop());
  if (!draft.tag || !sess || !String(key).startsWith(`${sess.name}:`)) return;
  const res = await act('tag', { n, tag: draft.tag, note: draft.note ?? '' }, { slot: sess?.slot });
  draft.result = res.ok ? `saved${res.ack}` : res.unknown ? 'acknowledgement unavailable — checking console state' : `not saved: ${res.reason}`;
  pollPanel(); renderAll();
}
// Review: a tag or note on any attempt, live or ended, through the deploy service (contract v3 E; append-only history).
async function saveReviewTag(name, n) {
  const key = `review:${name}:${n}`, draft = S.tagDraft[key] ?? {};
  if (!draft.tag || !reviewOperator()) return;
  draft.saving = true; renderPanel(true);
  const r = await api('/api/deploy/tag', { method: 'POST', csrf: true, timeout: 5000, body: { name, session: name, n, tag: draft.tag, note: draft.note ?? '', operator: reviewOperator(), ...(S.lease.id ? { lease_id: S.lease.id } : {}) } });
  draft.saving = false;
  draft.result = r.status === 202 ? 'acknowledgement unavailable — reload the session to see whether it was saved (not resent)' : r.ok && r.data.ok !== false && r.data.supported !== false ? 'saved' : unsupportedReply(r) ? `not saved: tagging is unsupported here (${unsupportedWhy(r)})` : `not saved: ${reason(r)}`;
  if (r.ok) loadDetail(name, { manual: true });
  renderPanel(true);
}
async function runDoctor() { const res = await act('doctor', {}, { slot: null, timeout: 4000 }); S.notice = res.ok ? { kind: 'ok', text: 'Doctor started: its result appears on the Doctor tile.' } : { kind: 'warning', text: `Doctor: ${res.reason}` }; renderAll(); }

// The start check is a measurement (no motion): run once when the node first stands ready, after Clear map's scan
// and after each attempt, so the live view can be drawn in the scan frame.
async function maybeStartCheck() {
  const sess = session(), v = S.view;
  if (!sess || !v || !S.scanName || !attached() || !['WAIT', 'ARRIVED', 'STOPPED'].includes(v.phase)) return;
  if (S.clearedAt && performance.now() - S.clearedAt < 10500) return;
  const key = `${sess.name}:${S.scanName}:${panelAttempts().length}:${S.clearedAt ?? 0}`;
  if (S.autoCheckKey === key || S.checking) return;
  S.autoCheckKey = key; S.checking = true;
  const r = await api('/api/deploy/act', { method: 'POST', body: { act: 'start_check', slot: sess.slot, scan: S.scanName, id: uuid(), expect: { session: sess.name } }, csrf: true, timeout: 8000 });
  S.checking = false;
  if (r.ok && r.data.ok !== false) applyStartCheck(r.data);
}
function applyStartCheck(chk) { S.startCheck = { ...chk, receivedAt: Date.now() }; renderAll(); }

// ------------------------------------------------------------------------------------------------ E-STOP
// Every fetch is aborted first; then the press goes to every live console through the gateway's reserve path and is
// retried every 300 ms until each console acknowledges. Never a keyboard shortcut.
export async function estop() {
  if (S.estop.state === 'sending' && performance.now() - S.estop.t0 < 600) return;
  for (const c of [...inflight]) c.abort();
  const gen = S.estopGen = (S.estopGen ?? 0) + 1;
  S.estop = { state: 'sending', targets: [], t0: performance.now(), error: null, missing: [] };
  renderBar();
  // A console counts as reached only when it answered ok or says the key went to the runner. Until every console is
  // reached the pill is red, NOT DELIVERED, at once (the physical E-stop may be the only stop left); SENT means the
  // key reached the runner but the runner has not confirmed; CONFIRMED means it has.
  const reached = t => t.ok === true || t.key_sent === true;
  while (performance.now() - S.estop.t0 < ESTOP_GIVE_UP_MS && gen === S.estopGen) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 1200);
    let res = null, data = {};
    try {
      res = await fetch('/api/deploy/estop', { method: 'POST', cache: 'no-store', signal: ctl.signal, body: '{}',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Estop': '1' } });
      try { data = await res.json(); } catch { data = {}; }
    } catch (error) { S.estop.error = ctl.signal.aborted ? 'the gateway did not answer within 1.2 s' : error.message; }
    finally { clearTimeout(timer); }
    if (gen !== S.estopGen) return;
    if (res && (res.status === 404 || res.status === 405)) {
      S.estop = { ...S.estop, state: 'failed', error: 'this Studio gateway has no E-STOP path', missing: [] }; renderBar(); return;
    }
    const targets = Array.isArray(data.targets) ? data.targets : [];
    S.estop.targets = targets;
    const missing = targets.filter(t => !reached(t));
    if (res?.ok && targets.length && !missing.length) {
      S.estop.state = targets.every(t => t.confirmed) ? 'confirmed' : 'sent'; S.estop.missing = []; S.estop.error = null;
      renderBar(); break;
    }
    S.estop.state = 'undelivered';
    S.estop.missing = targets.length ? missing.map(t => t.slot) : [];
    S.estop.error = targets.length ? missing.map(t => `${t.slot}: ${t.error ?? 'no answer'}`).join('; ') : (data.error ?? S.estop.error ?? `the gateway answered ${res?.status ?? 'nothing'}`);
    renderBar();
    await new Promise(r => setTimeout(r, 300));
  }
  if (gen !== S.estopGen) return;
  if (!['confirmed', 'sent'].includes(S.estop.state)) S.estop.state = 'failed';
  renderBar(); pollState();
}
async function direct(actName) {
  const sess = session(); if (!sess) return;
  const r = await api('/api/deploy/direct', { method: 'POST', body: { slot: sess.slot, act: actName },
    headers: { 'X-Studio-Estop': '1' }, timeout: 2000 });
  let res = r;
  if (r.status === 405) res = (await act(actName, {}, { slot: sess.slot, timeout: 3000 })).r;
  const ok = res.ok && res.data.ok !== false;
  S.directNote = { act: actName, ok, text: ok ? (actName === 'h' ? 'Stand sent' : 'Takeover sent') : `${actName === 'h' ? 'Stand' : 'Takeover'} NOT DELIVERED — use the remote or the physical E-stop`, error: ok ? null : reason(res), at: Date.now() };
  renderBar(); pollPanel();
}

// ------------------------------------------------------------------------------------------------ scan, goal
async function selectScan(name, frame = true) {
  if (!name) return;
  const changed = name !== S.scanName;
  S.scanName = name; store.set('scan', name);
  if (changed) { S.startCheck = null; }
  if (S.scene?.name === name || S.sceneLoading === name) return;
  S.sceneLoading = name;
  const r = await api(`/api/deploy/scan/scene?name=${encodeURIComponent(name)}`, { timeout: 10000 });
  if (S.sceneLoading !== name) return;
  S.sceneLoading = null;
  if (!r.ok) { S.notice = { kind: 'warning', text: `Could not open ${name}: ${reason(r)}` }; renderAll(); return; }
  S.scene = r.data;
  d3.setScanScene(r.data);
  d3.setScanPoseRobot(!S.view && !S.scanLive?.running);
  // A new scan makes the goal check stale: check the same goal again on this scan (a computation, not a press).
  if (S.goal?.xy && S.goal.check?.scan !== name) { const from = S.goal.check?.scan; await checkGoal(S.goal.xy); if (S.goal && from) S.goal.carriedFrom = from; renderAll(); }
  if (frame && S.visible) frameStep(true);
  renderAll();
}

// The goal check (contract v3 F) is a pure computation: with the active profile's route settings, bound to the scan and
// those settings, good for its TTL. It runs again by itself when it expires (30 s before) or when its inputs change
// (scan, profile, the live map's epoch after Clear map). A re-check keeps the goal and its "must pass" choice.
const goalInputs = () => JSON.stringify([S.scanName, profileName(), S.view?.memEpoch ?? null]);
async function checkGoal(xy, { auto = false } = {}) {
  const token = ++S.pickToken;
  const at = xy.map(v => Math.round(v * 100) / 100);
  const keep = auto && S.goal && Math.hypot(S.goal.xy[0] - at[0], S.goal.xy[1] - at[1]) < 1e-6 ? S.goal : null;
  S.goal = { xy: at, check: null, status: 'pending', passage: keep?.passage ?? null, quick: keep?.quick, carriedFrom: keep?.carriedFrom, previous: keep?.check ?? null, rechecking: auto };
  S.goal.inputs = goalInputs();
  drawGoal(); renderAll();
  const q = new URLSearchParams({ scan: S.scanName ?? '', x: String(at[0]), y: String(at[1]) });
  if (profileName()) q.set('profile', profileName());
  const r = await api(`/api/deploy/goal_check?${q}`, { timeout: 8000 });
  if (token !== S.pickToken) return;
  if (r.ok) S.goal.check = { ...r.data, scan: r.data.scan ?? S.scanName, receivedAt: performance.now(), profileAsked: profileName() };
  else if (r.status === 404) S.goal.check = { unavailable: true, scan: S.scanName, reason: 'Studio\'s goal check (/api/deploy/goal_check) is not available on this gateway' };
  else S.goal.check = { ok: false, scan: S.scanName, error: true, receivedAt: performance.now(), checks: [{ id: 'error', status: 'block', label: 'Goal check failed', detail: reason(r) }] };
  S.goal.status = goalStatus(); S.goal.rechecking = false; S.goal.previous = null;
  S.goal.passage = passageOffer(S.goal.check, S.goal.passage);
  store.set('goal', JSON.stringify({ scan: S.scanName, xy: at }));
  drawGoal(); renderAll();
}
function maybeRecheckGoal() {
  const g = S.goal; if (!g?.xy || !g.check || g.check.unavailable || !S.scanName || S.sceneLoading) return;
  const left = goalCheckLeft(g.check), changed = g.inputs !== goalInputs();
  const due = changed || (left !== null && left < 30);
  if (!due) return;
  if (g.check.error && performance.now() - (g.check.receivedAt ?? 0) < 10000) return;  // a failing check retries every 10 s
  checkGoal(g.xy, { auto: true });
}
// "Must pass through this gap" is offered when the check reports a passage under 1 m on the straight line or the route;
// the gate is the passage's two sides (sides_xy). The operator's choice survives a re-check of the same goal.
function passageOffer(check, prev) {
  const cand = [['straight line', check?.direct_gap], ['route', check?.gap]].filter(([, g]) => g && finite(g.width_m) && g.width_m < 1.0 && Array.isArray(g.sides_xy) && g.sides_xy.length === 2);
  if (!cand.length) return null;
  const [where, g] = cand.sort((a, b) => a[1].width_m - b[1].width_m)[0];
  return { where, width_m: g.width_m, a: g.sides_xy[0], b: g.sides_xy[1], required: !!prev?.required };
}
function drawGoal() {
  const g = S.goal, check = g?.check;
  if (!g) { d3.setGoal(null); return; }
  const dist = Math.hypot(g.xy[0], g.xy[1]);
  d3.setGoal({ xy: g.xy, status: goalStatus(), path: check?.path_xy ?? null, gap: check?.gap ?? null, blocking: check?.blocking_xy ?? [],
    passage: g.passage?.required ? g.passage : null, margin: routeMargin(check ?? g.previous),
    label: goalStatus() === 'block' ? 'Not here' : `Goal · ${dist.toFixed(1)} m` });
}
function clearGoal() { S.pickToken++; S.goal = null; store.set('goal', null); d3.setGoal(null); renderAll(); }

// ------------------------------------------------------------------------------------------------ steps and camera
function setStep(id, { frame = true } = {}) {
  if (!STEPS.some(s => s.id === id)) return;
  const changed = id !== S.step;
  S.step = id; store.set('step', id);
  d3.setHover(null); S.hover = null;
  const tip = $('dp-hover-tip'); if (tip) tip.hidden = true;
  if (changed && S.highlight) { S.highlight = null; d3.setAnchors(anchoredChecks(), null); }
  applyContext();
  if (id === 'review' && !S.reviewName) S.reviewName = session()?.name ?? st().sessions?.robot?.[0]?.name ?? null;
  if (changed) { S.sheet = null; S.notice = null; }
  syncReviewUrl();
  renderAll();
  if (frame && changed) frameStep();
}
function applyContext() { d3.applyVisibility({ step: S.step, tracksShown: !!S.tracks && S.tracksSet === rehearsalFor()?.name }); d3.setRehearsalTime(S.timeline.t); }
// Frame what matters for this step: the robot, the goal and the seen map. The camera mode is never changed.
function frameStep(instant = false) {
  // Live and not yet aligned: the robot's own frame, where the scan's goal does not belong.
  const robot = d3.liveScenePose() ?? [0, 0, 0], sceneOk = !d3.liveScenePose() || d3.isAligned();
  const pts = [robot];
  if (sceneOk && S.goal?.xy && ['goal', 'rehearse', 'deploy'].includes(S.step)) pts.push(S.goal.xy, ...(S.goal.check?.path_xy ?? []).filter((_, i) => i % 4 === 0));
  // The floor that matters is ahead of the robot: about 4 m ahead and 2 m to each side, clipped to what was seen.
  if (S.step === 'connect' || S.step === 'scan' || (S.step === 'goal' && !S.goal)) {
    const b = d3.d3.scanMem.bounds(d3.d3.scanFrame), c = Math.cos(robot[2] ?? 0), sn = Math.sin(robot[2] ?? 0);
    for (const [ax, ay] of [[4, 2.2], [4, -2.2], [-0.8, 0]]) {
      let x = robot[0] + c * ax - sn * ay, y = robot[1] + sn * ax + c * ay;
      if (b) { x = Math.min(b[2], Math.max(b[0], x)); y = Math.min(b[3], Math.max(b[1], y)); }
      pts.push([x, y]);
    }
  }
  if (S.step === 'rehearse' && S.tracks) for (const tr of Object.values(S.tracks)) if (tr?.qpos?.length) pts.push(tr.qpos[0], tr.qpos.at(-1));
  if (S.step === 'deploy' && !session()) pts.push([1.5, 0]);
  d3.frame(pts, { instant, heading: robot[2] ?? 0 });
}
function cameraButton(mode) {
  if (mode === 'frame') return frameStep();
  d3.setCameraMode(mode, mode === 'follow' ? null : framePoints(), {});
  store.set('camera', mode); renderStage();
}
function framePoints() { const pts = [d3.liveScenePose() ?? [0, 0, 0]]; if (S.goal?.xy) pts.push(S.goal.xy); else pts.push([2.5, 1.2], [2.5, -1.2]); return pts; }

// ------------------------------------------------------------------------------------------------ rendering: shared
const statusIcon = s => `<i class="dp-ic ${escape(s)}" aria-hidden="true">${ICON[s] ?? ''}</i>`;
const evChip = e => {
  const map = { MEASURED: 'measured', CONFIGURED: 'configured', OPERATOR: 'observed', DERIVED: 'estimated' };
  const label = { MEASURED: 'Measured', CONFIGURED: 'Configured', OPERATOR: 'Operator', DERIVED: 'Derived' }[e] ?? e;
  return e ? `<span class="chip chip-${map[e] ?? 'recorded'}" title="${escape({ MEASURED: 'From a sensor or a process on the deploy PC, measured now.', CONFIGURED: 'Read from configuration, not observed.', OPERATOR: 'Confirmed by the operator.', DERIVED: 'Computed from measured data.' }[e] ?? '')}">${escape(label)}</span>` : '';
};
const LOCK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true"><rect x="3" y="7" width="10" height="7" rx="1.6" fill="currentColor"/><path d="M5.2 7V5.2a2.8 2.8 0 0 1 5.6 0V7" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>';
function lockLine(lock) { const t = liveText(lock); return t ? `<p class="dp-lock" role="note">${LOCK_SVG}<span ${liveAttr(lock)}>${escape(t)}</span></p>` : ''; }
const scanLabel = s => {
  const d = s.time ? new Date(s.time) : null;
  const when = d && !Number.isNaN(d.getTime()) ? `${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}` : '';
  return `${when} · ${s.name}${s.practice || s.name.startsWith('practice-') ? ' (practice)' : ''} · ${s.verdict ?? '?'} · ${s.rehearsals ?? 0} rehearsal${s.rehearsals === 1 ? '' : 's'}`;
};
const ago = s => (!finite(s) ? '' : s < 90 ? `${Math.round(s)} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`);
const goalWords = xy => {
  if (!xy) return '';
  const ahead = xy[0], left = xy[1];
  return `${Math.abs(ahead).toFixed(2)} m ${ahead >= 0 ? 'ahead' : 'behind'}, ${Math.abs(left).toFixed(2)} m ${left >= 0 ? 'left' : 'right'} of the scan pose`;
};
// The 3 rehearsal cases (contract v3 B): arrival is the simulator's truth; passage only when a gap is required; contact
// and timing validity per case. A verdict is shown only for a COMPLETE set.
const CASES = [
  ['exact', 'Exact', 'From the scan pose, perfect odometry'],
  ['drift', 'Injected drift', 'Injected drift fitted to prior lab measurements (leg odometry, 2026-10-27)'],
  ['offset', 'Start offset', '20° right and 0.2 m off the scan pose, as the 2026-10-27 walks started'],
];
const CASE_COLOR = { exact: '#3d6fb5', drift: '#c2408f', offset: '#7d8794' };
// One case, from the v3 row (runs[which] an object) or, for older services, the run name and its loaded track.
function caseInfo(rec, which) {
  const run = rec?.runs?.[which], tr = S.tracksSet === rec?.name ? S.tracks?.[which] : null;
  if (run && typeof run === 'object') {
    return { name: run.name ?? null, state: run.state ?? 'pending', arrival: run.arrival ?? null, final: run.final_dist_m ?? tr?.final_dist_m ?? null,
      passage: run.passage ?? null, contact: run.contact_max_n ?? tr?.contact_max_n ?? null, contacts: tr?.contacts?.length ?? null,
      timing: run.timing_valid ?? null, timingNote: run.timing_note ?? null, duration: tr?.duration_s ?? null, v3: true };
  }
  const running = runningCase(rec) === which;
  return { name: run ?? null, state: tr ? 'done' : running ? 'running' : setState(rec) === 'running' ? 'pending' : rec ? 'done' : 'pending',
    arrival: tr ? !!tr.arrived : null, final: tr?.final_dist_m ?? null, passage: null, contact: tr?.contact_max_n ?? null, contacts: tr?.contacts?.length ?? null,
    timing: null, timingNote: null, duration: tr?.duration_s ?? null, v3: false };
}
// A required gap that a case went around: arrival by a detour is not a task pass.
const passageMissed = rec => !!rec && CASES.some(([w]) => caseInfo(rec, w).passage === 'missed');
const VERDICT = {
  robust: ['pass', 'Robust', r => `All 3 cases arrived (simulator truth); the drift case stayed within ${num(r.apart_m, 2)} m of the exact one.`],
  'other way': ['warn', 'Arrives another way', r => `Both arrived, but the injected drift sends the robot ${num(r.apart_m, 2)} m away from the exact path: expect a different path on the robot.`],
  'fails with drift': ['block', 'Fails with drift', () => 'Only the exact case arrived. With drift like the injected one this goal fails: pick another goal or rescan.'],
  fails: ['block', 'Fails', () => 'The exact case did not arrive. Do not deploy this goal.'],
};
function verdictText(rec) {
  if (!rec?.verdict || setState(rec) !== 'complete') return null;
  let [tone, title, fn] = VERDICT[rec.verdict] ?? ['warn', rec.verdict, () => ''];
  // The drift case injects LEG-odometry drift. With FAST-LIO the drift case is a caution, not a verdict — and the page
  // states what is known about that odometry instead of a precision it has not shown on the robot.
  if (rec.verdict === 'fails with drift' && ['fused', 'zmq'].includes(odomName())) {
    tone = 'warn'; title = 'Fails with the injected leg drift';
    fn = () => `Only the exact case arrived. With drift like the injected one this goal would fail. ${ODOMETRY[odomName()].validation}: watch the first walk closely.`;
  }
  if (passageMissed(rec)) {
    const which = CASES.filter(([w]) => caseInfo(rec, w).passage === 'missed').map(([, l]) => l.toLowerCase());
    return { tone: 'block', title: 'Missed the required gap', text: `The ${which.join(' and ')} case${which.length > 1 ? 's' : ''} went around the gap instead of through it. Arrival by a detour is not a task pass.` };
  }
  const offset = rec.offset_ok === true ? 'A start 20° right / 0.2 m off still arrives.' : rec.offset_ok === false ? 'A start 20° right / 0.2 m off does not arrive: line the robot up with its scan pose.' : '';
  const timing = CASES.some(([w]) => caseInfo(rec, w).timing === false) ? ' One case ran with invalid timing (the machine was loaded): its result is not evidence.' : '';
  const through = rec.passage && CASES.every(([w]) => caseInfo(rec, w).passage === 'crossed') ? ' Every case passed through the required gap.' : '';
  return { tone: timing && tone === 'pass' ? 'warn' : tone, title, text: `${fn(rec)}${through} ${offset}${timing}`.trim() };
}
const setTime = r => { const t = r?.finished ?? r?.started; if (!finite(t)) return ''; const d = new Date(t * 1000); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const setWords = r => `${r.name}${setTime(r) ? ` · ${setTime(r)}` : ''} · ${setState(r)}`;
// Why the other sets do not match, in words.
const mismatchWords = o => {
  const missing = new Set(o.missing ?? []);
  const words = [...new Set((o.mismatch ?? []).map(f => (missing.has(f) ? `no ${f.replaceAll('_', ' ')} in its identity (an older set)` : MISMATCH[f] ?? f)))];
  if (words.length) return words.join(', ');
  return o.state && o.state !== 'complete' ? `${o.state === 'running' ? 'still running' : `not complete (${o.state})`}` : 'superseded by a newer matching set';
};

function renderAll() {
  renderBar(); renderContext();
  if (!S.visible) return;
  renderIdentity(); renderStrip(); renderPanel(true); renderStage(); renderReadiness(); renderSheet();
}

// ------------------------------------------------------------------------------------------------ the E-STOP bar
// Shown whenever a console was live at the last good state poll, the service does not answer (after it once did, or in
// Deploy), or the gateway reports a cached live panel. Hidden only on a positive "no console running".
function barModel() {
  const live = Object.entries(st().live ?? {}).filter(([, v]) => v?.running).map(([slot, v]) => ({ slot, ...v }));
  const unreachable = S.stateOk === false && (S.everOk || S.visible || S.cachedLive);
  // A positive "no console running" hides it, unless an E-STOP is still being retried.
  if (!live.length && !unreachable && !['sending', 'undelivered'].includes(S.estop.state)) return null;
  const kindOf = l => l.receipt?.kind ?? (l.slot === 'robot' && !l.practice ? 'robot' : l.practice ? 'practice' : 'rehearsal');
  const robot = live.find(l => kindOf(l) === 'robot');
  const kind = robot ? 'robot' : live.length ? kindOf(live[0]) : 'unknown';
  return { live, unreachable, kind, robot };
}
// The console's age now, per slot: the freshest of the direct heartbeat and the deploy service's last report, each aged
// from its own receipt (a cached "0.02 s" from a hub that stopped answering ages with it). null: nothing known.
function consoleAgeNow(slot) {
  const hb = S.src[`console:${slot}`] ? srcAge(`console:${slot}`) : null;
  const l = liveSlot(slot), viaHub = l && finite(l.console_t_mono_age_s) ? l.console_t_mono_age_s + (performance.now() - S.stateAt) / 1000 : null;
  const known = [hb, viaHub].filter(finite);
  return known.length ? Math.min(...known) : null;
}
// The bar is built once and then only updated in place: a press on E-STOP can never land on a button that a poll
// replaced between pointer-down and pointer-up. E-STOP fires on pointer-down (and on keyboard activation).
function buildBar(bar) {
  bar.innerHTML = `
    <div class="dpe-who"><strong id="dpe-title"></strong><span id="dpe-sub"></span></div>
    <div class="dpe-alarm" id="dpe-alarm" role="alert" hidden>CONSOLE NOT RESPONDING — use the physical E-stop</div>
    <div class="dpe-actions">
      <button id="dp-estop" class="dpe-stop" title="Stops every live console now (relayed straight to each console, which owns the robot)">E-STOP</button>
      <span class="dpe-status" id="dpe-status" role="status" hidden></span>
      <button id="dp-stand" class="dpe-small">Stand</button>
      <button id="dp-takeover" class="dpe-small">Take over</button>
      <span class="dpe-status" id="dpe-direct" role="status" hidden></span>
    </div>
    <div class="dpe-fallback" title="Studio's E-STOP, the phone panel, the remote's Select while streaming and the node's auto-stop all go through the console process. Only the physical E-stop is independent.">Also: remote <b>Select</b> · phone panel · <b>physical E-stop</b>, the only stop that does not need the console</div>`;
  const stop = bar.querySelector('#dp-estop');
  stop.addEventListener('pointerdown', e => { if (e.button === 0) { stop.dataset.fired = String(performance.now()); estop(); } });
  stop.addEventListener('click', () => { if (performance.now() - Number(stop.dataset.fired ?? 0) > 800) estop(); });  // keyboard
  bar.querySelector('#dp-stand').addEventListener('click', () => direct('h'));
  bar.querySelector('#dp-takeover').addEventListener('click', () => direct('t'));
  bar.dataset.built = '1';
}
function renderBar() {
  const bar = $('deploy-estop'); if (!bar) return;
  const m = barModel();
  document.body.classList.toggle('estop-shown', !!m);
  if (!m) { bar.hidden = true; return; }
  if (!bar.dataset.built) buildBar(bar);
  bar.hidden = false; bar.dataset.kind = m.kind;
  const sess = m.robot ?? m.live[0];
  // Slots to judge: the live ones; with the service down, the ones the heartbeat still reports.
  const slots = [...new Set([...m.live.map(l => l.slot), ...(m.unreachable ? (S.hb?.rows ?? []).map(r => r.slot) : [])])];
  const ages = slots.map(consoleAgeNow), worst = ages.filter(finite).length ? Math.max(...ages.filter(finite)) : null;
  const robotName = sess?.receipt?.robot ?? st().robot_link?.robot ?? 'robot';
  $('dpe-title').textContent = m.kind === 'robot' ? `ROBOT LIVE · ${robotName}` : m.kind === 'practice' ? 'PRACTICE · simulated robot'
    : m.kind === 'rehearsal' ? 'REHEARSAL · simulator' : 'DEPLOY SERVICE NOT ANSWERING';
  const hbText = worst !== null ? `console heartbeat ${ageText(worst)}${S.src[`console:${slots[ages.indexOf(worst)]}`] ? ' (direct)' : ' (via the service)'}`
    : slots.length ? `console heartbeat unknown${S.hbSupported === false ? ' (unsupported by this gateway)' : ''}` : '';
  $('dpe-sub').textContent = m.unreachable ? `A console may still be running: Studio cannot see it through the deploy service${hbText ? ` · ${hbText}` : ''}.`
    : `${sess?.name ?? ''}${sess?.panel?.phase ? ` · ${PHASE[sess.panel.phase] ?? sess.panel.phase}` : ''}${hbText ? ` · ${hbText}` : ''}`;
  $('dpe-alarm').hidden = !(worst !== null && worst > SOURCES.console.stale);
  const es = S.estop, some = es.missing?.length && es.targets?.length > es.missing.length ? ` to ${es.missing.join(', ')}` : '';
  const text = { sending: 'SENDING…', undelivered: `NOT DELIVERED${some} — use the physical E-stop · retrying`,
    failed: `NOT DELIVERED${some} — use the physical E-stop`, sent: 'SENT · the runner has not confirmed yet',
    confirmed: 'CONFIRMED · E-STOP in the runner' }[es.state] ?? '';
  const status = $('dpe-status'); status.hidden = !text; status.textContent = text; status.dataset.state = es.state ?? '';
  status.title = es.error ? `What the gateway said: ${es.error}` : '';
  $('dp-estop').dataset.state = es.state ?? '';
  // Stops are for anyone who sees the robot: viewers too, and never locked by staleness.
  const live = !!session();
  for (const id of ['dp-stand', 'dp-takeover']) { $(id).disabled = !live; $(id).title = live ? (id === 'dp-stand' ? 'Stand: the robot stops walking and stands (direct to the console)' : 'Take over: the runner leaves the policy and holds a stand (direct to the console)') : 'No session is running'; }
  const dn = $('dpe-direct'), showDirect = S.directNote && Date.now() - S.directNote.at < 6000;
  dn.hidden = !showDirect; if (showDirect) { dn.textContent = S.directNote.text; dn.dataset.state = S.directNote.ok ? 'confirmed' : 'failed'; dn.title = S.directNote.error ? `What the gateway said: ${S.directNote.error}` : ''; }
}

// ------------------------------------------------------------------------------------------------ top bar context
// The top bar names the RUNNING session from its receipt; with none, the next session's mode (marked "Next").
function renderContext() {
  const el = $('deploy-context'); if (!el) return;
  const id = ident();
  const service = S.stateOk === true ? `<span class="dpc-chip ok" title="Deploy service ${escape(st().version?.kit_commit ?? '')}">● Deploy service</span>`
    : S.stateOk === false ? `<span class="dpc-chip bad" title="${escape(S.stateError ?? '')}">● Deploy service not answering</span>` : '<span class="dpc-chip">Connecting…</span>';
  const who = id ? `<span class="dpc-mode ${id.kind === 'robot' ? 'robot' : 'practice'}" title="The running session, from its receipt">${id.kind === 'robot' ? `Robot session · ${escape(id.robot)}` : 'Practice session'}</span>`
    : `<span class="dpc-mode next ${S.mode === 'robot' ? 'robot' : 'practice'}" title="No session is running: the next session's mode (Connect)">Next: ${S.mode === 'robot' ? `Robot · ${escape(st().robot_link?.robot ?? 'lab-g1')}` : 'Practice'}</span>`;
  const op = S.operator.trim() ? `<span class="dpc-chip" title="${holdsLease() ? 'You hold the controls' : 'Not holding the controls'}">${holdsLease() ? '◆' : '◇'} ${escape(S.operator.trim())}</span>` : '';
  const audit = S.link?.audit && S.link.audit.ok === false ? `<span class="dpc-chip bad" title="${escape(S.link.audit.last_error ?? '')}">! Audit log not writing</span>` : '';
  el.innerHTML = `${who}${op}${service}${id ? `<span class="dpc-chip live">● ${escape(id.name)}</span>` : ''}${audit}`;
}

// ------------------------------------------------------------------------------------------------ the identity strip
// Always on top of the panel: what is running (from its receipt), who controls it, how fresh each source is and how the
// recording does. Expanded, the exact receipt. Built in place so a poll never moves the button under a press.
function recordingHealth() {
  const sess = session(); if (!sess) return null;
  const rec = sess.recording ?? (S.liveDetail?.name === sess.name ? S.liveDetail.data?.recording : null);
  if (rec) return rec;
  if (S.liveDetail?.name === sess.name && S.liveDetail.unsupported) return { unsupported: true };
  return null;
}
// Recording health (kit evidence.recording_health). The recorder's state: recording | stalled (its process runs, its
// heartbeat stopped) | finalized | not finalized (gone without finalizing) | absent; older services and the manifest
// also say ended | lost. A stream's state: active | waiting | stalled | stopped | off | absent | n/a.
// A finalized recording is a good, closed one: its streams are stopped by design and judged on what they recorded.
const STREAM_LIVE_BAD = new Set(['stalled', 'off', 'absent']);
function recState(rec) {
  if (rec.state) return rec.state;
  if (rec.finalized === true) return 'finalized';
  if (rec.recorder_alive === true) return 'recording';
  return rec.recorder_alive === false ? 'not finalized' : null;
}
function recordingWords(rec) {
  if (!rec) return { tone: 'unknown', text: 'Recording: waiting for its health' };
  if (rec.unsupported) return { tone: 'unknown', text: 'Recording health: unsupported by this deploy service' };
  const streams = Array.isArray(rec.streams) ? rec.streams : [], req = streams.filter(s => s.required);
  const stOf = s => s.state ?? (s.active ? 'active' : 'stopped');
  const state = recState(rec);
  const closed = ['finalized', 'ended'].includes(state);
  const problems = Array.isArray(rec.problems) ? rec.problems : Array.isArray(rec.errors) ? rec.errors : [];
  const drops = streams.reduce((n, s) => n + (s.dropped ?? 0), 0);
  const disk = finite(rec.disk_free_gb) ? `${rec.disk_free_gb < 10 ? rec.disk_free_gb.toFixed(1) : Math.round(rec.disk_free_gb)} GB free` : null;
  const parts = [];
  let lead, tone;
  if (closed) {
    // Recorded = the required streams that wrote something (stopped with samples, or still marked active).
    const recorded = req.filter(s => !['absent', 'waiting', 'off'].includes(stOf(s)) && (s.samples ?? s.bytes ?? 1) > 0);
    const missing = req.filter(s => !recorded.includes(s));
    lead = state === 'finalized' ? 'Recording finalized' : 'Recording ended';
    parts.push(`${recorded.length} of ${req.length} required streams recorded`);
    if (missing.length) parts.push(`missing ${missing.map(s => s.id).join(', ')}`);
    if (state === 'ended' && rec.finalized === false) parts.push('NOT finalized');
    tone = missing.length || problems.length || rec.ok === false ? 'warn' : 'pass';
  } else if (state === 'stalled') {
    lead = 'Recorder stalled';
    parts.push(`its process runs but its heartbeat stopped${finite(rec.recorder?.heartbeat_age_s) ? ` ${ageText(rec.recorder.heartbeat_age_s)} ago` : ''} (a stuck disk?)`);
    tone = 'block';
  } else if (state === 'not finalized' || state === 'lost') {
    lead = state === 'lost' ? 'Recording LOST' : 'Recording NOT finalized';
    parts.push(state === 'lost' ? 'the console died before it closed the recording' : 'the recorder stopped without finalizing (killed, crashed or power loss)');
    tone = 'block';
  } else if (state === 'absent') {
    lead = 'No recording'; parts.push('the recorder never started for this session'); tone = 'block';
  } else {
    // Recording (or a state this page does not know): judged on its streams now.
    const active = req.filter(s => stOf(s) === 'active'), bad = req.filter(s => STREAM_LIVE_BAD.has(stOf(s))), waiting = req.filter(s => stOf(s) === 'waiting');
    lead = state && state !== 'recording' ? `Recording (${state})` : 'Recording';
    parts.push(`${active.length} of ${req.length} required streams active`);
    if (bad.length) parts.push(bad.map(s => `${s.id} ${stOf(s)}`).join(', '));
    if (waiting.length) parts.push(`${waiting.length} waiting for a first sample`);
    const last = streams.map(s => s.last_write_age_s).filter(finite);
    if (last.length) parts.push(`last write ${ageText(Math.min(...last))}`);
    tone = bad.length || (rec.ok === false && problems.length) ? 'block' : drops || waiting.length || rec.ok === false ? 'warn' : 'pass';
  }
  if (drops) parts.push(`${drops} dropped`);
  if (disk && !closed) parts.push(disk);
  if (finite(rec.disk_free_gb) && rec.disk_free_gb < 20 && tone === 'pass') tone = 'warn';
  if (problems.length) parts.push(problems.slice(0, 2).join('; '));
  return { tone, text: `${lead} · ${parts.join(' · ')}`, state };
}
// One line: every source that is not fresh gets its own chip (stale amber, lost red, unknown hollow) with its age; the
// fresh ones are summed up, their ages in the tooltip. A problem is never hidden in a row of green.
function sourceDots() {
  const sess = session(), walking_ = walking();
  // The node's own sources (view, lidar, map) exist from Arm on: before that they are not "no data", they are not running.
  const nodeUp = !!S.view || !!S.src.view || (S.panel?.phase && S.panel.phase !== 'BOOT');
  const rows = Object.entries(SOURCES).filter(([name]) => sess || !SESSION_SOURCES.includes(name)).filter(([name]) => name !== 'plan' || walking_)
    .filter(([name]) => nodeUp || !['view', 'lidar', 'map'].includes(name))
    .filter(([name]) => name !== 'recorder' || !recordingHealth()?.unsupported)
    .map(([name, def]) => ({ name, def, s: srcState(name), a: srcAge(name) }));
  const fresh = rows.filter(r => r.s === 'fresh'), other = rows.filter(r => r.s !== 'fresh');
  const chip = r => `<span class="dpi-src ${r.s}" title="${escape(r.s === 'unknown' ? (srcReason(r.name) ?? `${r.def.label}: no data yet`) : `${r.def.label}: ${ageText(r.a)} old (${r.s}; stale above ${r.def.stale} s)`)}" data-src="${r.name}"><i aria-hidden="true"></i>${escape(r.def.short)}<em>${r.s === 'unknown' ? 'no data' : escape(ageText(r.a))}</em></span>`;
  const oldest = fresh.reduce((m, r) => (!m || r.a > m.a ? r : m), null);
  const names = fresh.map(r => r.def.short).join(', ');
  const summary = fresh.length ? `<span class="dpi-src fresh sum" title="${escape(fresh.map(r => `${r.def.label} ${ageText(r.a)}`).join(' · '))}"><i aria-hidden="true"></i>${other.length ? `Fresh: ${escape(names)}` : `All fresh: ${escape(names)}`}${oldest ? `<em>≤ ${escape(ageText(oldest.a))}</em>` : ''}</span>` : '';
  return other.map(chip).join('') + summary;
}
function renderIdentity() {
  const el = $('dp-identity'); if (!el || !S.visible) return;
  const id = ident(), mine = attached(), lease = holdsLease();
  const tone = id ? (id.kind === 'robot' ? 'robot' : 'practice') : 'none';
  const who = !id ? `No session running · next session: ${S.mode === 'robot' ? 'Robot' : 'Practice'} · ${profileLabel(nextProfile())} · ${odomLabel(nextOdom())}`
    : `${id.kind === 'robot' ? `ROBOT · ${id.robot}` : id.kind === 'practice' ? 'PRACTICE · simulated G1' : 'REHEARSAL'} · ${shortName(id.name)}`;
  const own = !id ? (lease ? `You hold the controls (${S.lease.holder ?? S.operator.trim()})` : 'Not holding the controls')
    : mine && lease ? `You control it (${S.lease.holder ?? S.operator.trim()})` : mine ? 'Attached · not holding the controls' : `Viewing only${S.lease.conflict ? ` · ${S.lease.conflict} holds the controls` : ''}`;
  const rec = id ? recordingWords(recordingHealth()) : null;
  const r = id?.receipt;
  const rows = id ? [
    ['Session', id.name], ['Kind', id.kind], ['Robot', id.robot], ['Operator', id.operator ?? '—'], ['Started', finite(id.started) ? new Date(id.started * 1000).toLocaleString() : '—'],
    ['Profile', `${id.profile ?? '—'} · sha ${shortSha(id.profileSha)}`], ['Bundle', r?.bundle ? `${r.bundle.name ?? '—'} · ${shortSha(r.bundle.manifest_sha)}` : '—'],
    ['Rules', r?.rules ? `${r.rules.name ?? '—'} · ${shortSha(r.rules.sha)}` : '—'], ['Odometry', `${odomLabel(id.odom)} — ${ODOMETRY[id.odom]?.validation ?? 'validation status not known'}`],
    ['Scan', id.scan ? `${id.scan} · memory ${shortSha(id.scanSha)}` : '—'], ['Mount calibration', shortSha(r?.mount_calib_sha)],
    ['Start offset', Array.isArray(r?.start_offset) ? r.start_offset.map(v => num(v, 2)).join(', ') : '—'],
    ['Kit', r?.kit ? `${shortSha(r.kit.commit)}${r.kit.dirty ? ' · modified tree' : ''}` : '—'], ['Runner', shortSha(r?.runner_commit)],
  ] : [];
  const html = `<div class="dpi-main" data-tone="${tone}">
      <button class="dpi-toggle" id="dp-identity-toggle" aria-expanded="${S.identityOpen}" ${id ? '' : 'disabled'} title="${id ? 'Show the session\'s receipt' : 'No session is running'}">
        <strong>${escape(who)}</strong>${id ? `<span>${escape(profileLabel(id.profile))} · ${escape(odomLabel(id.odom))}</span>` : ''}${id ? `<i aria-hidden="true">${S.identityOpen ? '▴' : '▾'}</i>` : ''}</button>
      <div class="dpi-own ${id && !mine ? 'view' : ''}">${escape(own)}${id && !r ? ' · <em title="This deploy service sends no session receipt: the slot\'s own fields are shown">no receipt</em>' : ''}</div>
    </div>
    <div class="dpi-srcs" id="dp-sources" aria-label="Freshness of each source"></div>
    ${rec ? `<div class="dpi-rec ${rec.tone}">${statusIcon(rec.tone)}<span>${escape(rec.text)}</span></div>` : ''}
    ${S.link?.audit && S.link.audit.ok === false ? `<div class="dpi-rec warn">${statusIcon('warn')}<span>Studio's audit log is not writing: ${escape(S.link.audit.last_error ?? 'unknown error')}</span></div>` : ''}
    ${id && S.identityOpen ? `<dl class="dpi-receipt">${rows.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>` : ''}`;
  if (el.dataset.html !== html) {
    el.dataset.html = html; el.innerHTML = html; el.dataset.tone = tone;
    $('dp-identity-toggle')?.addEventListener('click', () => { S.identityOpen = !S.identityOpen; renderIdentity(); });
  }
  updateSources();
}
// The source chips change every tick (their ages): updated in place, never rebuilt with the strip.
function updateSources() {
  const host = $('dp-sources'); if (!host) return;
  const html = sourceDots();
  if (host.dataset.html !== html) { host.dataset.html = html; host.innerHTML = html; }
}

// ------------------------------------------------------------------------------------------------ the step strip
function renderStrip() {
  const el = $('dp-strip'); if (!el) return;
  const idx = STEPS.findIndex(s => s.id === S.step);
  el.innerHTML = STEPS.map((s, i) => {
    const ss = stepState(s.id), cls = s.id === S.step ? 'now' : ss.stale ? 'stale' : ss.done ? 'done' : i < idx ? 'todo' : 'todo';
    return `<button data-step="${s.id}" class="${cls}" aria-current="${s.id === S.step ? 'step' : 'false'}" title="${escape(ss.stale ?? (ss.done ? `${s.label}: done` : s.label))}"><b>${ss.done && s.id !== S.step && !ss.stale ? '✓' : ss.stale ? '!' : i + 1}</b><em>${s.label}</em></button>`;
  }).join('<span class="dp-sep" aria-hidden="true"></span>');
  el.querySelectorAll('[data-step]').forEach(b => b.addEventListener('click', () => setStep(b.dataset.step)));
}

// ------------------------------------------------------------------------------------------------ the step panel
let lastPanelKey = '';
function renderPanel(force = false) {
  const root = $('dp-panel-content'); if (!root || !S.visible) return;
  if (S.pointerHeld && !force) return;  // a press in progress: the button under it must stay the same element
  const body = panelBody(), blocker = S.stateOk === false ? null : nextBlocker();
  // Ages in lock texts tick every frame: the key holds which source is stale, the text is refreshed in place.
  const key = JSON.stringify([body, blocker?.key ?? blocker?.text ?? null], (k, v) => (k === 'locked' && v && typeof v === 'object' ? v.key : k === 'liveText' ? undefined : v));
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;
  const focused = document.activeElement?.id, sel = focused && document.activeElement.selectionStart;
  const scroller = root.querySelector('.dp-body'), scroll = scroller?.scrollTop ?? 0;
  const idx = STEPS.findIndex(s => s.id === S.step) + 1;
  const top = S.stateOk === false
    ? `<div class="callout danger dp-top-callout" role="alert" title="${escape(S.stateError ?? '')}"><strong>The deploy service does not answer.</strong> A console may still be running: watch the robot. E-STOP above goes straight to the console. Start the service on the deploy PC: <code>./g1 lab --headless</code></div>`
    : blocker ? `<div class="dp-block-line ${blocker.tone}" role="status" title="${escape(blocker.detail ?? '')}">${statusIcon(blocker.tone)}<span ${liveAttr(blocker)}>${escape(liveText(blocker))}</span>${blocker.action ? `<button class="link-button" data-action="${escape(blocker.action)}">${escape(blocker.actionLabel)}</button>` : ''}</div>` : '';
  const attention = body.attention ?? (S.stateOk === false ? 'service' : null);
  const label = body.primary ? (S.busy && body.primary.busyText ? body.primary.busyText : body.primary.label) : '';
  // Review speaks of the reviewed session (its receipt), not of the next session or the running one.
  const rk = S.step === 'review' ? reviewKind() : null;
  const modeWord = S.step === 'review' ? (rk === 'robot' ? ' · real robot session' : rk === 'practice' ? ' · practice session' : rk === 'rehearsal' ? ' · rehearsal run' : '') : isRobot() ? ' · real robot' : ' · practice';
  root.innerHTML = `
    <header class="dp-head"><span class="eyebrow">Step ${idx} of ${STEPS.length}${modeWord}${session() && !attached() && S.step !== 'review' ? ' · viewing' : ''}</span><button class="link-button dp-map-toggle" id="dp-map-toggle" aria-pressed="${S.mapCollapsed}">${S.mapCollapsed ? 'Show map' : 'Hide map'}</button><h2>${escape(body.title)}</h2>${body.lead ? `<p>${escape(body.lead)}</p>` : ''}</header>
    ${top}
    <div class="dp-body">${body.html}${noticeHtml(S.notice)}</div>
    <footer class="dp-foot"><span class="dp-foot-now" aria-hidden="true">Step ${idx} · ${escape(body.title)}</span>${body.primary ? primaryButton(body.primary) : ''}${body.secondary ?? ''}</footer>`;
  // Something that needs the operator now (an ended attempt's tag, an E-STOP, a lost view) scrolls into sight once.
  root.querySelector('.dp-body').scrollTop = attention && attention !== S.lastAttention ? 0 : scroll;
  S.lastAttention = attention;
  if (focused && root.contains(document.getElementById(focused))) { const el = document.getElementById(focused); el.focus({ preventScroll: true }); try { if (sel !== null && sel !== undefined) el.setSelectionRange(sel, sel); } catch { /* not a text input */ } }
  else if (S.focusAction) { root.querySelector(`[data-action="${CSS.escape(S.focusAction)}"]`)?.focus({ preventScroll: true }); }
  S.focusAction = null;
  bindPanel(root); refreshLive();
  if (label) root.querySelector('#dp-primary')?.setAttribute('aria-label', label);
}
// A lock is a string, or {key, text, source|act} whose text ages: those carry data-live so uiTick refreshes them in place.
const lockStr = l => (l && typeof l === 'object' ? l.text : l);
// The HTML carries an age-free text (so a render key does not change every frame); refreshLive() writes the ages in.
const liveText = l => (l && typeof l === 'object' && l.source ? srcReason(l.source, { stable: true }) ?? l.text : l && typeof l === 'object' && l.act && S.acts[l.act] ? unknownWords(S.acts[l.act], { stable: true }) : lockStr(l));
const liveAttr = l => (l && typeof l === 'object' && l.source ? `data-live-src="${escape(l.source)}"` : l && typeof l === 'object' && l.act ? `data-live-act="${escape(l.act)}"` : '');
function refreshLive() {
  document.querySelectorAll('[data-live-src]').forEach(e => { const t = srcReason(e.dataset.liveSrc); if (t && e.textContent !== t) e.textContent = t; });
  document.querySelectorAll('[data-live-act]').forEach(e => { const a = S.acts[e.dataset.liveAct]; if (a?.state === 'unknown') { const t = unknownWords(a); if (e.textContent !== t) e.textContent = t; } });
  document.querySelectorAll('[data-live-goal]').forEach(e => { const t = goalFreshText(); if (e.textContent !== t) e.textContent = t; });
}
// A notice about a press whose reply never came follows the console's record: unknown, then received or refused.
function noticeHtml(n) {
  if (!n) return '';
  if (n.act) {
    const a = S.acts[n.act]; if (!a) return '';
    if (a.state === 'unknown') return '';  // said once, in the line under the step header
    return `<div class="callout ${a.state === 'done' ? 'ok' : 'warning'}" role="status">${escape(`${ACT_WORDS[a.act] ?? a.act}: the console's record says it was ${a.state === 'done' ? 'received' : `refused: ${a.reason}`}.`)}</div>`;
  }
  return `<div class="callout ${n.kind === 'ok' ? 'ok' : 'warning'}" role="status">${escape(n.text)}</div>`;
}
function primaryButton(p) {
  return `<button id="dp-primary" class="dp-primary ${p.tone ?? ''}" ${p.locked || S.busy ? 'disabled' : ''} data-action="${escape(p.action)}">${escape(S.busy && p.busyText ? p.busyText : p.label)}</button>${lockLine(p.locked)}`;
}
// The next thing in the way, under the step header, with how to resolve it: who controls, an unknown press, a stale
// source the next press needs, then the readiness blocks.
function nextBlocker() {
  const sess = session(), review = S.step === 'review';
  // An unknown press matters on every step; the rest is about controlling the next or the running session, not Review.
  const u = unknownAct(); if (u) return { tone: 'warn', key: `act:${u.id}`, text: unknownWords(u), act: u.id };
  if (review) return null;
  if (sess && !attached()) return { tone: 'info', key: 'view', text: `Viewing only: ${sess.name} (${ident().kind === 'robot' ? 'the real robot' : 'practice'}) was not started in this tab. Attach to control it; E-STOP, Stand and Take over work either way.`, action: 'step:connect', actionLabel: 'Attach…' };
  if (sess) {
    const row = ladderRows().find(r => r.state !== 'done');
    const f = row && freshLock(row.key); if (f) return { tone: 'block', key: f.key, text: f.text, source: f.source, detail: 'Presses that move the robot wait for fresh data. E-STOP, Stand and Take over stay live.' };
  }
  const block = S.stateOk === true ? firstBlock() : null;
  return block ? { tone: 'block', key: `ready:${block.id}`, text: blockText(block), detail: block.detail } : null;
}

function panelBody() {
  switch (S.step) {
    case 'connect': return connectBody();
    case 'scan': return scanBody();
    case 'goal': return goalBody();
    case 'rehearse': return rehearseBody();
    case 'deploy': return deployBody();
    default: return reviewBody();
  }
}

function tile(t) {
  const chipHtml = t.value === 'Unavailable' ? '<span class="chip chip-unavailable" title="Not captured now: the deploy service does not report it.">Unavailable</span>' : t.ev ? evChip(t.ev) : '';
  return `<div class="dp-tile ${t.status}">${statusIcon(t.status)}<div><span>${escape(t.label)}</span><strong>${escape(t.value)}</strong>${t.hint ? `<small>${escape(t.hint)}</small>` : ''}</div>${chipHtml}${t.button ?? ''}</div>`;
}
function connectTiles() {
  const s = st(), link = s.robot_link ?? {}, pc = s.pc ?? {}, gpu = s.gpu ?? {}, robot = isRobot(), odom = odomName();
  const tiles = [];
  if (!robot) tiles.push({ label: 'Robot link, lidar and FAST-LIO', value: 'Not needed for practice', status: 'later', hint: 'The simulator runs the practice robot, its lidar and its odometry on this PC.' });
  else tiles.push({ label: 'Network link to the robot', value: link.carrier ? `${link.iface ?? 'eno1'} carrier up` : `${link.iface ?? 'eno1'}: no carrier`, status: link.carrier ? 'pass' : 'block', ev: 'MEASURED', hint: link.carrier ? '' : 'Plug the robot\'s Ethernet cable and power the robot.' });
  if (robot) tiles.push({ label: 'Lidar publishing', value: finite(link.lidar_hz) ? `${link.lidar_hz.toFixed(1)} Hz` : link.livox_driver ? 'driver running, rate unknown' : 'driver not running', status: finite(link.lidar_hz) ? (link.lidar_hz >= 8 ? 'pass' : 'warn') : link.livox_driver ? 'unknown' : 'block', ev: 'MEASURED', hint: link.livox_driver ? '' : 'Start it: g1 lidar start' });
  const lioNeeded = robot && ['fused', 'zmq'].includes(odom);
  if (robot) tiles.push({ label: 'FAST-LIO bridge', value: link.lio_bridge ? `running${finite(link.lio_pose_age_s) ? ` · pose ${Math.round(link.lio_pose_age_s * 1000)} ms old` : ''}` : 'not running', status: link.lio_bridge ? (finite(link.lio_pose_age_s) && link.lio_pose_age_s > 0.15 ? 'warn' : 'pass') : lioNeeded ? 'block' : 'warn', ev: 'MEASURED', hint: link.lio_bridge ? '' : lioNeeded ? `${ODOMETRY[odom].label} needs it: g1 lio start, or choose Legs only` : 'Only needed for FAST-LIO odometry' });
  const free = gpu.free_mib, need = gpu.rehearsal_mib;
  tiles.push({ label: 'GPU memory free', value: finite(free) ? `${(free / 1024).toFixed(1)} GB` : 'Unavailable', status: !finite(free) ? 'unknown' : finite(need) && free < need ? 'warn' : 'pass', ev: 'MEASURED', hint: finite(need) && free < need ? `A rehearsal needs ${(need / 1024).toFixed(1)} GB` : '' });
  const busy = pc.busy?.length ? pc.busy.join(', ') : pc.chains?.length ? `${pc.chains.length} other deploy chain(s)` : '';
  tiles.push({ label: 'PC load', value: finite(pc.load) ? `${pc.load.toFixed(1)} on ${pc.cpus ?? '?'} cores${busy ? ` · ${busy}` : ''}` : 'Unavailable', status: busy ? 'warn' : finite(pc.load) ? (pc.load > (pc.cpus ?? 28) * 0.5 ? 'warn' : 'pass') : 'unknown', ev: 'MEASURED', hint: busy ? 'Real-time runs need a quiet machine' : '' });
  tiles.push({ label: 'Disk free', value: finite(pc.disk_free_gb) ? `${Math.round(pc.disk_free_gb)} GB` : 'Unavailable', status: !finite(pc.disk_free_gb) ? 'unknown' : pc.disk_free_gb < 20 ? 'block' : pc.disk_free_gb < 60 ? 'warn' : 'pass', ev: 'MEASURED', hint: 'A robot session records about 2 GB' });
  // Which Studio this is: the installed release, or a candidate build served from a worktree (contract v3 F09).
  const rel = S.studioVersion?.release;
  if (rel) tiles.push({ label: 'Studio build', value: rel.is_installed ? `installed ${String(rel.commit ?? '').slice(0, 7)}${rel.dirty ? ' · modified tree' : ''}` : `CANDIDATE ${String(rel.commit ?? '').slice(0, 7)}${rel.dirty ? ' · modified tree' : ''} (installed: ${String(rel.installed_commit ?? 'none').slice(0, 7)})`,
    status: rel.is_installed && !rel.dirty ? 'pass' : 'warn', ev: 'CONFIGURED', hint: rel.is_installed ? '' : `Served from ${rel.served_from ?? 'a worktree'}, not the installed release` });
  const v = s.version ?? {};
  tiles.push({ label: 'Deploy kit', value: v.kit_commit ? `${String(v.kit_commit).slice(0, 7)}${v.kit_dirty ? ' · modified tree' : ''}` : 'Unavailable', status: v.kit_dirty ? 'warn' : v.kit_commit ? 'pass' : 'unknown', ev: 'CONFIGURED' });
  const doc = s.doctor;
  tiles.push({ label: 'Doctor', value: doc ? `${doc.exit === 0 ? 'passed' : `exit ${doc.exit}`} · ${ago(nowS() - doc.t)}` : 'not run today', status: doc ? (doc.exit === 0 ? (nowS() - doc.t > 1800 ? 'warn' : 'pass') : 'block') : 'unknown', ev: 'MEASURED', hint: doc?.text && doc.exit !== 0 ? doc.text.slice(0, 160) : '', button: `<button class="link-button" data-action="doctor">Run</button>` });
  return tiles;
}
// A running session is described by its receipt, on its own card; the selectors below it are the NEXT session's and
// never relabel it. A tab that did not start the session attaches to it explicitly before it can press anything.
function sessionCard(id) {
  const mine = attached(), r = id.receipt;
  return `<div class="dp-session-card" data-tone="${id.kind === 'robot' ? 'robot' : 'practice'}">
      <span class="dp-session-mode">${id.kind === 'robot' ? 'REAL ROBOT SESSION' : id.kind === 'practice' ? 'PRACTICE SESSION' : 'REHEARSAL'} · running</span>
      <strong>${escape(id.name)}</strong>
      <div class="dp-summary">
        <div><span>Robot</span><strong>${escape(id.robot)}</strong></div>
        <div><span>Policy</span><strong>${escape(profileLabel(id.profile))}${id.profileSha ? ` · ${escape(shortSha(id.profileSha))}` : ''}</strong></div>
        <div><span>Odometry</span><strong>${escape(odomLabel(id.odom))}</strong></div>
        <div><span>Operator</span><strong>${escape(id.operator ?? '—')}</strong></div>
        <div><span>Scan</span><strong>${escape(id.scan ?? '—')}</strong></div>
      </div>
      <p class="tiny">${r ? 'From the session\'s receipt.' : 'This deploy service sends no receipt: from the slot\'s own fields.'} The next session's settings below do not change it.</p>
      ${mine ? '' : `<div class="callout info dp-attach-note"><strong>This tab did not start this session.</strong> It only views it until you attach: type your name and press <em>Attach</em>. E-STOP, Stand and Take over work either way.</div>`}
    </div>`;
}
function connectBody() {
  const s = st(), carrier = !!s.robot_link?.carrier, unreachable = S.stateOk === false;
  const name = S.operator.trim(), lease = S.lease, sess = session(), id = ident(), mine = attached(), nextRobot = S.mode === 'robot';
  let primary;
  if (unreachable) primary = { label: 'Take the controls', action: 'lease', locked: `The deploy service does not answer (${S.stateError}). Start it on the deploy PC: ./g1 lab --headless` };
  else if (sess && !mine) primary = { label: lease.conflict ? `Take over from ${lease.conflict} and attach` : `Attach to this ${id.kind === 'robot' ? 'robot' : 'practice'} session`,
    action: lease.conflict ? 'attach-takeover' : 'attach', tone: id.kind === 'robot' ? 'robot' : 'practice',
    locked: !name ? 'Type your name: it is recorded with every press' : null, busyText: 'Attaching…' };
  else if (!holdsLease()) primary = { label: lease.conflict ? `Take over from ${lease.conflict}` : 'Take the controls', action: lease.conflict ? 'lease-takeover' : 'lease',
    locked: !name ? 'Type your name: it is recorded with every press' : !sess && nextRobot && !carrier ? 'No robot link: plug the robot in, or choose Practice' : null, busyText: 'Taking the controls…' };
  else if (sess) primary = { label: 'Back to the session', action: 'step:deploy', locked: null };
  else primary = { label: 'Next: scan the scene', action: 'step:scan', locked: nextRobot && !carrier ? 'No robot link: plug the robot in, or choose Practice' : null };
  const np = nextProfile(), no = nextOdom();
  const profileOpts = profiles().map(p => `<option value="${escape(p.name)}" ${p.name === np ? 'selected' : ''}>${escape(p.label ?? p.name)}${p.featured ? '' : ' (more)'}</option>`).join('');
  const prof = profiles().find(p => p.name === np);
  return {
    title: sess && !mine ? 'Attach to the session' : 'Connect',
    lead: sess ? 'A session is running. Studio shows it from its receipt and relays your presses to its console.' : nextRobot ? 'The deploy kit runs the robot; Studio shows it and relays your presses to its console.' : 'A simulated G1 in a scanned room, with the same console, gates and recording as the robot.',
    html: `
      ${id ? sessionCard(id) : ''}
      <label class="field"><span>Operator</span><input id="dp-operator" type="text" autocomplete="name" placeholder="Your name" value="${escape(S.operator)}" ${holdsLease() ? 'readonly' : ''}></label>
      ${holdsLease() ? `<p class="tiny ok">You hold the controls${lease.supported === false ? ' (this gateway has no operator lease yet: one tab at a time)' : ''}${sess && mine ? ` and are attached to ${escape(sess.name)}` : ''}. <button class="link-button" data-action="release">Release</button></p>` : ''}
      ${lease.lost ? `<div class="callout warning">You lost the controls: ${escape(lease.lost)}.</div>` : ''}
      ${lease.conflict ? `<div class="callout warning">${escape(lease.conflict)} holds the controls in another tab or browser. Take over only if they agree: it is logged.</div>` : ''}
      <fieldset class="dp-next"><legend>Next session${sess ? ' · after this one ends' : ''}</legend>
        <div class="segmented wide dp-mode" role="group" aria-label="Next session: robot or practice">
          <button data-mode="robot" aria-pressed="${nextRobot}">Robot · ${escape(s.robot_link?.robot ?? 'lab-g1')}</button><button data-mode="practice" aria-pressed="${!nextRobot}">Practice · simulated</button>
        </div>
        <div class="dp-row2">
          <label class="field"><span>Policy profile</span><select id="dp-profile">${profileOpts}</select></label>
          <label class="field"><span>Odometry</span><select id="dp-odom">${Object.entries(ODOMETRY).map(([k, o]) => `<option value="${k}" ${k === no ? 'selected' : ''}>${escape(o.label)}</option>`).join('')}</select></label>
        </div>
        <p class="tiny">${escape(prof?.note ?? '')}${prof?.note ? ' · ' : ''}${escape(ODOMETRY[no]?.note ?? '')}</p>
        <p class="tiny">${escape(ODOMETRY[no]?.validation ?? '')}.</p>
        ${sess ? '<p class="tiny">These apply when you start the next session; the running session keeps its own.</p>' : ''}
      </fieldset>
      <h4>This PC and the robot link</h4>
      <div class="dp-tiles">${connectTiles().map(tile).join('')}</div>`,
    primary,
  };
}

function scanBody() {
  const live = S.scanLive, scanning = !!(st().scan_job?.running || S.pendingScan), list = scans().filter(s => isRobot() ? !s.practice && !s.name.startsWith('practice-') : true);
  const row = scanRow(S.scanName), stale = scanStale(row), sess = session();
  const locked = sess ? 'A session is running: end it before scanning (the robot stands still for a scan)' : !holdsLease() ? 'Take the controls first (Connect)' : rehearsalRunning() ? 'A rehearsal is using the simulator' : null;
  let primary;
  if (scanning) primary = { label: `Scanning… ${num(live?.t, 1)} / ${S.seconds} s`, action: 'none', locked: 'The robot stands still while its lidar sweeps the room' };
  else if (!row || stale) primary = { label: isRobot() ? `Scan the scene (${S.seconds} s)` : `Scan the practice room (${S.seconds} s)`, action: 'scan', locked, busyText: 'Starting the scan…' };
  else primary = { label: 'Next: pick a goal', action: 'step:goal', locked: !S.scene ? 'Loading the scan…' : null };
  const counts = d3.scanCounts(), sc = S.scene, verdictTone = { GO: 'pass', CHECK: 'warn', 'NO-GO': 'block' }[sc?.verdict ?? row?.verdict] ?? 'unknown';
  return {
    title: 'Scan the scene', lead: isRobot() ? 'The robot stands; its lidar builds the map the planner will start from.' : 'The simulated robot stands in the scanned room\'s twin and scans it with the robot\'s lidar settings.',
    html: `
      ${scanning ? `<div class="dp-progress"><div class="progress"><i style="width:${Math.min(100, ((live?.t ?? 0) / S.seconds) * 100)}%"></i></div><p class="tiny">${num(live?.t, 1)} s · ${live?.n_frames ?? 0} lidar frames · the map grows in 3D as points arrive</p></div>` : ''}
      <label class="field"><span>Scan</span><select id="dp-scan" ${scanning ? 'disabled' : ''}>${list.map(s => `<option value="${escape(s.name)}" ${s.name === S.scanName ? 'selected' : ''}>${escape(scanLabel(s))}</option>`).join('') || '<option>No scans yet</option>'}</select></label>
      ${row ? `<div class="dp-verdict ${verdictTone}">${statusIcon(verdictTone)}<div><strong>${escape(sc?.verdict ?? row.verdict ?? 'Unavailable')}</strong><span>${escape(ago(row.age_s))}${row.walked_since ? ' · walked since' : ''}${sc?.frames ? ` · ${sc.frames} frames` : ''}</span></div></div>
        <ul class="dp-reasons">${(sc?.reasons ?? row.reasons ?? []).map(r => `<li>${escape(r)}</li>`).join('') || '<li>Nothing flagged around the robot</li>'}</ul>` : '<p class="tiny">No scan on this deploy PC yet.</p>'}
      ${stale ? `<div class="callout warning">Stale: ${escape(stale)}. Rescan before a robot session.</div>` : ''}
      ${counts ? `<div class="dp-counts"><span><i class="sw-ob"></i><b>${counts.obstacles}</b> obstacle cells</span><span><i class="sw-st"></i><b>${counts.steps}</b> step-over</span><span><i class="sw-oh"></i><b>${counts.overheads}</b> overhead</span></div>` : ''}
      ${isRobot() ? '' : `<label class="field"><span>Practice room</span><select id="dp-room" ${scanning ? 'disabled' : ''}>${practiceRooms().map(r => `<option value="${escape(r.value)}" ${r.value === practiceRoom() ? 'selected' : ''}>${escape(r.label)}</option>`).join('') || '<option>No rooms</option>'}</select><span class="tiny">A practice scan stands the simulated robot in this room and scans it like the robot does.</span></label>`}
      <label class="field narrow"><span>Seconds</span><input id="dp-seconds" type="number" min="3" max="30" step="1" value="${S.seconds}"></label>`,
    primary,
    secondary: row && !stale && !scanning ? `<button class="dp-secondary" data-action="scan" ${locked || S.busy ? 'disabled' : ''}>Rescan (${S.seconds} s)</button>` : '',
  };
}

function goalBody() {
  const g = S.goal, check = g?.check, status = goalStatus(), hover = S.hover;
  let locked = null;
  if (!S.scene) locked = 'Pick a scan first';
  else if (!g) locked = 'Click the floor in 3D to place a goal';
  else if (!check) locked = g.rechecking ? 'Checking the goal again…' : 'Checking the goal on the scan…';
  else if (check.unavailable) locked = check.reason;
  else if (status === 'block') locked = `This goal is blocked: ${(check.checks ?? []).find(c => c.status === 'block')?.label ?? 'see the checks'}`;
  else if (status === 'pending') locked = 'The goal check expired: checking again…';
  const checks = check?.checks ?? [], shown = check ?? g?.previous;
  return {
    title: 'Pick a goal', lead: 'Click the floor in 3D. The disc is the robot\'s footprint; its colour is a first look at the cells under it.',
    html: `
      ${hover && !g ? `<p class="tiny">Under the pointer: ${escape(hover.text)}</p>` : ''}
      ${g?.carriedFrom ? `<div class="callout warning">This goal was carried over from ${escape(g.carriedFrom)} at the same place relative to the scan pose. Check it in 3D, or click a new one.</div>` : ''}
      ${g ? `<div class="dp-goal ${status}">${statusIcon(status === 'pending' ? 'unknown' : status)}<div><strong>(${num(g.xy[0], 2)}, ${num(g.xy[1], 2)}) m</strong><span>${escape(goalWords(g.xy))}</span></div><button class="link-button" data-action="clear-goal">Clear</button></div>` : '<div class="dp-empty"><b>No goal yet.</b> Point at the floor: green is clear, amber needs a look, red is blocked. A click on an obstacle lands on it and is refused there.</div>'}
      ${g ? goalBasisHtml(shown) : ''}
      ${check && !check.unavailable ? `<ul class="nav-checks dp-checks">${checks.map(c => `<li class="${escape(c.status)}"><i>${ICON[c.status] ?? '?'}</i><span><strong>${escape(c.label)}</strong>${c.detail ? `<small>${escape(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
        <p class="tiny">Straight ${num(check.straight_m, 2)} m · route ${num(check.path_m, 2)} m${finite(check.unknown_fraction) ? ` · ${Math.round(check.unknown_fraction * 100)} % of it unseen` : ''}${check.gap ? ` · narrowest gap on the route ${num(check.gap.width_m, 2)} m` : ''}${check.direct_gap ? ` · on the straight line ${num(check.direct_gap.width_m, 2)} m` : ''}</p>` : ''}
      ${g?.passage ? `<label class="dp-confirm-one dp-passage"><input type="checkbox" data-passage ${g.passage.required ? 'checked' : ''}><span><strong>Must pass through this gap</strong> (${num(g.passage.width_m, 2)} m, on the ${escape(g.passage.where)}). The rehearsal cases and the real attempts are then scored on passing it as well as on arriving: a detour is not a task pass.</span></label>` : ''}
      ${check?.unavailable ? `<div class="callout warning">${escape(check.reason)}. The quick look says: ${escape(S.goal.quick?.text ?? 'unknown')}.</div>` : ''}
      <div class="dp-legend-inline"><span><i class="sw-route"></i>Route check + ${num(routeMargin(shown), 2)} m margin (Studio, on the scan${shown?.config && /profile/i.test(shown.config.basis ?? '') ? `, ${escape(profileLabel(shown.config.profile))}` : ''})</span><span><i class="sw-gap"></i>Gap</span><span><i class="sw-block"></i>Blocking cells</span><span><i class="sw-unseen"></i>Unseen route</span>${session() ? '<span><i class="sw-plan"></i>Planner\'s live route</span>' : ''}</div>`,
    primary: session() ? { label: `Back to the session: send this goal${rehearsalFor()?.verdict ? '' : ' (not rehearsed)'}`, action: 'step:deploy', locked }
      : { label: 'Next: rehearse this goal', action: 'step:rehearse', locked },
  };
}
// What the goal check was computed with (contract v3 F) and how long it stays good.
function goalBasisHtml(check) {
  if (!check || check.unavailable) return '';
  if (check.error) return '<p class="tiny dp-basis">The check failed: it runs again in 10 s.</p>';
  const cfg = check.config, p = cfg?.params ?? {};
  const profileBased = cfg && /profile/i.test(cfg.basis ?? '') && !/generic/i.test(cfg.basis ?? '');
  const basis = profileBased ? `Checked with the ${profileLabel(cfg.profile)} route settings (profile ${shortSha(cfg.sha)})`
    : `Studio's generic check — the live planner may route differently${cfg ? '' : ' (this gateway does not report route settings)'}`;
  const params = [['robot radius', p.robot_radius_m], ['route margin', p.route_margin_m], ['step-over', p.step_over_m], ['ceiling below', p.ceiling_below_m]].filter(([, v]) => finite(v)).map(([k, v]) => `${k} ${num(v, 2)} m`).join(' · ');
  return `<p class="tiny dp-basis ${profileBased ? '' : 'generic'}"><strong>${escape(basis)}</strong>${params ? `<br>${escape(params)}` : ''}<br><span data-live-goal>${escape(goalFreshText(check))}</span></p>`;
}
// The margin the check kept around the route: the profile's route settings, else Studio's generic 0.35 m.
const routeMargin = check => (finite(check?.config?.params?.route_margin_m) ? check.config.params.route_margin_m : 0.35);
function goalFreshText(check = S.goal?.check) {
  if (!check?.receivedAt) return S.goal?.rechecking ? 'Checking again…' : '';
  const age = (performance.now() - check.receivedAt) / 1000, left = goalCheckLeft(check);
  if (S.goal?.rechecking) return 'Checking again (expired, or the scan, profile or map changed)…';
  return left <= 0 ? `Checked ${ago(age)} · EXPIRED — checking again` : `Checked ${ago(age)} · good for ${left < 90 ? `${Math.round(left)} s` : `${Math.round(left / 60)} min`} more (it re-checks itself)`;
}

// One rehearsal case: arrival (simulator truth), passage when required, contact, timing validity.
function caseRow(rec, [which, label, sub]) {
  const c = caseInfo(rec, which), err = S.trackErr[which];
  const tone = c.state === 'running' ? 'live' : c.state === 'error' ? 'block' : c.arrival === true && c.passage !== 'missed' ? 'pass' : c.arrival === false || c.passage === 'missed' ? 'block' : c.state === 'done' ? 'unknown' : 'later';
  // The outcome first (arrival by the simulator's truth, passage when required), then the evidence quality, quieter.
  const head = [], rest = [];
  if (c.state === 'running') head.push(['live', 'Running in the simulator…']);
  else if (c.state === 'pending') head.push(['', setState(rec) === 'running' ? 'Waiting' : 'Not run']);
  else if (c.state === 'error') head.push(['bad', 'The run failed: no result']);
  else {
    head.push(c.arrival === true ? ['ok', `Arrived${finite(c.final) ? ` · ${num(c.final, 2)} m` : ''}`] : c.arrival === false ? ['bad', `Did not arrive${finite(c.final) ? ` · ${num(c.final, 2)} m short` : ''}`] : ['', 'Arrival unknown']);
    if (c.passage === 'crossed') head.push(['ok', 'through the gap']);
    else if (c.passage === 'missed') head.push(['bad', 'went AROUND the required gap']);
    rest.push(finite(c.contact) && c.contact > 0 ? `contact ${Math.round(c.contact)} N max${c.contacts ? ` (${c.contacts})` : ''}` : finite(c.contact) ? 'no contact' : c.v3 ? 'contact not measured' : '');
    if (c.timing === false) rest.push(`timing INVALID${c.timingNote ? `: ${c.timingNote}` : ''}`);
    else if (c.timing === true) rest.push('timing valid');
    if (finite(c.duration)) rest.push(`${num(c.duration, 1)} s`);
  }
  return `<li class="dp-run ${tone}"><i class="dp-run-sw" style="--c:${CASE_COLOR[which]}"></i><div><strong>${escape(label)}</strong><small>${escape(sub)}</small>
    <span class="dp-case">${c.state === 'running' ? '<i class="dp-spin" aria-hidden="true"></i>' : ''}${head.map(([t, x]) => `<b class="${t}">${escape(x)}</b>`).join('<i class="dp-dot">·</i>')}${rest.filter(Boolean).length ? `<em>${escape(rest.filter(Boolean).join(' · '))}</em>` : ''}</span>
    ${err ? `<em class="dp-track-err">Track ${err.giveUp ? 'unavailable' : `retrying (${err.tries}/5)`}: ${escape(err.reason)}${err.giveUp ? ' <button class="link-button" data-action="retry-tracks">Retry</button>' : ''}</em>` : ''}</div></li>`;
}
// Why no set counts: the sets for THIS goal first (each with its reasons), then a count of the scan's sets for other goals.
function nomatchHtml(others) {
  const here = others.filter(o => !(o.mismatch ?? []).includes('goal_scene') && !(o.mismatch ?? []).includes('goal'));
  const elsewhere = others.length - here.length;
  return `<div class="dp-nomatch"><strong>No matching completed rehearsal</strong>${here.length ? `<ul>${here.slice(0, 8).map(o => `<li><code>${escape(o.name)}</code>: ${escape(mismatchWords(o))}</li>`).join('')}${here.length > 8 ? `<li>${here.length - 8} more for this goal</li>` : ''}</ul>` : '<p class="tiny">No set has been rehearsed for this goal yet.</p>'}${elsewhere ? `<p class="tiny">${elsewhere} set${elsewhere === 1 ? '' : 's'} on this scan ${elsewhere === 1 ? 'is' : 'are'} for other goals.</p>` : ''}</div>`;
}
function rehearseBody() {
  const m = matchNow(), rec = rehearsalFor(), pend = rehearsalPending(), running = rehearsalRunning(), gpu = st().gpu ?? {}, sess = session(), robotWalking = liveSlot('robot')?.panel && ['PRESCAN', 'RUN'].includes(liveSlot('robot').panel.phase);
  let locked = null;
  if (!goalUsable() && !(S.goal?.check?.unavailable && S.goal?.xy)) locked = S.goal ? 'The goal is blocked or not checked (Goal)' : 'Pick a goal first';
  else if (!holdsLease()) locked = 'Take the controls first (Connect)';
  else if (running) locked = `A rehearsal is running (${runningCase(running) ?? 'a'} case)`;
  else if (sess?.slot === 'sim') locked = 'End the practice session first: rehearsals use the simulator slot';
  else if (robotWalking) locked = 'The robot is walking';
  else if (finite(gpu.free_mib) && finite(gpu.rehearsal_mib) && gpu.free_mib < gpu.rehearsal_mib) locked = `The GPU has ${(gpu.free_mib / 1024).toFixed(1)} GB free; a rehearsal needs ${(gpu.rehearsal_mib / 1024).toFixed(1)} GB`;
  const shown = pend ?? rec, v = verdictText(rec), tracks = S.tracksSet === rec?.name ? S.tracks : null;
  const needPassage = !!S.goal?.passage?.required, recNoPassage = rec && needPassage && !rec.passage;
  const done = rec?.verdict && !passageMissed(rec) && !recNoPassage;
  const primary = done && !pend ? { label: 'Next: deploy', action: 'step:deploy', locked: null }
    : { label: pend || running ? 'Rehearsing…' : rec ? 'Rehearse again (3 cases)' : 'Rehearse 3 cases (about 1-2 min)', action: 'rehearse', locked: pend ? 'Running: the robots appear on the timeline when the cases end' : locked, busyText: 'Starting…' };
  // Which set is shown, by name and time, and why the others do not count.
  const setLine = m?.unsupported ? '<div class="callout warning">Rehearsal matching is unsupported by this deploy service (no /api/v1/rehearsal/match): no set is shown as this goal\'s rehearsal.</div>'
    : !m ? '<p class="tiny">Asking the deploy service for this goal\'s rehearsal set…</p>'
    : m.error && !m.data ? `<div class="callout warning">The deploy service did not say which set matches: ${escape(m.error)}</div>`
    : `${pend ? `<p class="dp-setline live"><strong>Running set:</strong> ${escape(setWords(pend))}</p>` : ''}
       ${rec ? `<p class="dp-setline" title="The deploy service's pick: the newest complete set for this scan (and its memory), goal, profile (and its contents), bundle, rules and odometry"><strong>${pend ? 'Last complete set' : 'Selected set'}:</strong> ${escape(setWords(rec))}</p>`
         : !pend ? nomatchHtml(m.data?.others ?? []) : ''}`;
  const partial = shown && setState(shown) === 'partial' ? '<div class="callout warning">This set is PARTIAL: not every case finished, so it has no verdict.</div>' : shown && setState(shown) === 'failed' ? '<div class="callout warning">This set FAILED to run: no verdict.</div>' : '';
  return {
    title: 'Rehearse in 3D', lead: `The deployed policy (${profileLabel(profileName())}) in the scan's twin, through the kit's real-time chain: 3 rehearsal cases.`,
    html: `
      ${S.goal ? `<p class="tiny">Goal (${num(S.goal.xy[0], 2)}, ${num(S.goal.xy[1], 2)}) · ${escape(odomLabel(odomName()))} · scan ${escape(S.scanName ?? '')}${needPassage ? ` · must pass the ${num(S.goal.passage.width_m, 2)} m gap` : ''}</p>` : ''}
      ${setLine}
      ${v ? `<div class="dp-verdict ${v.tone}">${statusIcon(v.tone)}<div><strong>${escape(v.title)}</strong><span>${escape(pend ? `The last complete set (${rec.name}): ${v.text} A rerun is running: its own verdict comes when it completes.` : v.text)}</span></div></div>` : ''}
      ${partial}
      <h4 class="dp-cases-head">3 rehearsal cases <span class="tiny">${shown ? `${escape(shown.name)} (${escape(setState(shown))}) · ` : ''}arrival by the simulator's truth</span></h4>
      <ul class="dp-runs">${CASES.map(c => caseRow(shown, c)).join('')}</ul>
      ${recNoPassage ? '<div class="callout warning">This set was rehearsed without the gap requirement: its arrivals say nothing about passing the gap. Rehearse again to score passage.</div>' : ''}
      <p class="tiny">${escape(ODOMETRY[odomName()]?.validation ?? '')}.</p>
      ${tracks ? '<p class="tiny">Scrub the timeline under the 3D view: the three robots walk together. Red spheres are contacts, drawn at the robot.</p>' : ''}
      ${v?.tone === 'block' ? '<div class="callout warning">The rehearsal did not pass. You can still deploy in practice, but on the robot pick another goal or rescan.</div>' : ''}`,
    primary,
    secondary: done && !pend && !running ? `<button class="dp-secondary" data-action="rehearse" ${locked || S.busy ? 'disabled' : ''}>Rehearse again</button>` : '',
  };
}

// The goal the node holds, in the scene (view.goal is in odom; the align maps it), vs the goal on the page.
function goalSentStale() {
  if (!S.goal?.xy) return null;
  const v = S.view, sc = v?.align?.scene_from_odom;
  let held = null;
  if (Array.isArray(v?.goal) && sc) { const c = Math.cos(sc[2]), s = Math.sin(sc[2]); held = [sc[0] + c * v.goal[0] - s * v.goal[1], sc[1] + s * v.goal[0] + c * v.goal[1]]; }
  else if (S.sendResult?.ok) held = S.sendResult.goal;
  if (!held) return null;
  const d = Math.hypot(held[0] - S.goal.xy[0], held[1] - S.goal.xy[1]);
  return d > 0.15 ? `The goal moved ${d.toFixed(2)} m since it was sent: Send goal again` : null;
}
// Where the robot starts, in words. The rehearsal's start-offset envelope covers the first walk from the scan pose; after
// a walk the kit sends within_offset_envelope = null with closed_attempts > 0, and the page says where it starts from.
function startWords(sc, { short = false } = {}) {
  if (!sc) return 'not run';
  const moved = `${num(sc.moved_m, 2)} m, ${num(sc.turned_deg, 0)}°`;
  if (sc.within_offset_envelope === null && sc.closed_attempts > 0) return `starts from where attempt ${sc.closed_attempts} ended (${moved} from the scan pose)`;
  // The kit takes the envelope from a set on this scan whose offset case passed: when this goal's own offset case
  // failed, say so beside it instead of a bare "inside".
  if (sc.within_offset_envelope === true) return `${moved} from the scan pose · inside the rehearsed start offset${rehearsalFor()?.offset_ok === false ? ' (of another rehearsal on this scan; this goal\'s offset case did not arrive)' : ''}`;
  if (sc.within_offset_envelope === false) return `${moved} from the scan pose · outside the rehearsed start offset${short ? '' : ' (20° / 0.2 m)'}`;
  return `${moved} from the scan pose`;
}
// What the operator should know before GO although the console has no lock: shown in amber, and on the real robot
// acknowledged with one tick.
// What the operator should know before GO although the console has no lock. On the robot each needs the override tick,
// which goes with the GO press (recorded with the attempt).
function goCautions() {
  const rec = rehearsalFor(), v = verdictText(rec), sc = S.startCheck ?? S.sendResult?.check, out = [];
  if (matchNow()?.unsupported) out.push('Rehearsal matching is unsupported by this deploy service: no rehearsal can be shown for this goal');
  else if (!rec?.verdict) out.push('No matching completed rehearsal for this goal, profile and odometry');
  else if (rec.verdict !== 'robust' || v?.tone !== 'pass') {
    // Any matching set that is not robust asks for the override, whatever the odometry: the FAST-LIO context is in
    // the words, never in a missing tick.
    const fused = ['fused', 'zmq'].includes(odomName()) && ['fails with drift', 'other way'].includes(rec.verdict);
    out.push(`The rehearsal says: ${v?.title.toLowerCase() ?? rec.verdict}${fused ? ` (the injected drift models leg odometry; this walk uses ${odomLabel(odomName())}, not yet validated walking on the robot)` : ''}`);
  }
  if (rec && S.goal?.passage?.required && !rec.passage) out.push('The rehearsal did not score the required gap');
  if (sc?.within_offset_envelope === false) out.push('The robot stands outside the start offset the rehearsal covered');
  // A failing start-offset case is its own caution unless the start check places the robot inside a passing envelope.
  else if (rec?.offset_ok === false && sc?.within_offset_envelope !== true) out.push(`This goal's start-offset case did not arrive, and the start is ${sc ? 'not known to be inside a rehearsed offset' : 'not checked yet'}: line the robot up with its scan pose`);
  return out;
}
function firstBlock(groups = null) {
  return (S.readiness ?? []).find(c => (!groups || groups.includes(c.group)) && checkShown(c).status === 'block') ?? null;
}
const blockText = c => `${c.label}${c.detail ? ` — ${c.detail}` : ''}${c.fix?.hint ? ` · ${c.fix.hint}` : ''}`;
// On the real robot a Link or Robot block (lidar, FAST-LIO, the link, temperatures) locks Start session and Arm.
const blockLock = () => { if (!isRobot()) return null; const c = firstBlock(['link', 'robot']); return c ? blockText(c) : null; };
function ladderRows() {
  const p = S.panel, ladder = p?.ladder ?? [], locks = p?.go_locks ?? [], lost = !!S.view && liveState() === 'lost';
  const byKey = Object.fromEntries(ladder.map(l => [l.key, l]));
  const robot = isRobot(), rows = [
    { key: 'arm', label: 'Arm', sub: robot ? 'The runner takes the motors and ramps the robot to its stand pose (about 25 s); the gantry carries the weight.' : 'The runner takes the simulated motors and ramps to the stand pose; the planner node starts.' },
    { key: 'sonic', label: 'Start SONIC', sub: robot ? 'SONIC holds the robot standing. Then lower the gantry until the feet take the weight.' : 'SONIC holds the practice robot standing.' },
    { key: 'map', label: 'Clear map', sub: robot ? 'The planner forgets the old map and rescans for 10 s: spotter to the side, rope held high.' : 'The planner forgets the old map and rescans for 10 s.' },
    { key: 'goal', label: 'Send goal', sub: 'Start check, then the goal converted to the robot\'s frame now.' },
    { key: 'go', label: 'GO', sub: 'The robot walks to the goal.' },
  ];
  const cleared = S.clearedAt ? Math.max(0, 10 - (performance.now() - S.clearedAt) / 1000) : 0;
  const control = controlLock(), u = unknownAct();
  return rows.map(r => {
    const l = byKey[r.key] ?? { state: 'todo' };
    let lock = null;
    const fresh = l.state === 'done' ? null : freshLock(r.key);
    if (p?.runner === 'E-STOP') lock = 'E-STOP is active: end the session';
    else if (control) lock = control;
    else if (u) lock = { key: `act:${u.id}`, text: unknownWords(u), act: u.id };
    else if (r.key === 'arm' && robot && blockLock()) lock = blockLock();
    else if (lost && ['arm', 'sonic', 'map', 'goal', 'go'].includes(r.key)) lock = 'Live view lost: watch the robot';
    else if (fresh && !fresh.key.endsWith(':unknown')) lock = fresh;
    else if (r.key === 'go') lock = locks[0] ?? goalSentStale();
    else if (r.key === 'goal' && !goalUsable()) lock = S.goal ? 'The goal is not checked on this scan (Goal)' : 'Pick a goal first (Goal)';
    else if (r.key === 'map' && cleared > 0) lock = `Rescanning: ${Math.ceil(cleared)} s`;
    else if (['sonic', 'map'].includes(r.key) && (p?.phase === 'BOOT' || !p?.phase)) lock = 'The planner node is starting (about 3-20 s after Arm)';
    // the runner ramps the robot to its stand for about 25 s after Arm; the console refuses Start SONIC until INIT done
    else if (r.key === 'sonic' && p?.runner !== 'INIT done' && p?.runner !== 'CONTROL') lock = 'The runner is ramping the robot to its stand (about 25 s after Arm)';
    if (!lock && fresh) lock = fresh;  // unknown (never arrived) after the step's own reasons
    return { ...r, state: l.state ?? 'todo', detail: l.detail, lock };
  });
}
function deployBody() {
  const sess = session(), rec = rehearsalFor(), v = verdictText(rec);
  if (!sess) {
    const stale = scanStale(), locked = !holdsLease() ? 'Take the controls first (Connect)' : S.stateOk !== true ? 'The deploy service does not answer'
      : isRobot() && !st().robot_link?.carrier ? 'No robot link' : !S.scanName ? 'Scan first' : isRobot() && stale ? `Rescan first: ${stale}` : rehearsalRunning() ? 'A rehearsal is running' : blockLock();
    const ended = S.reviewName && S.attempts[S.reviewName];
    return {
      title: isRobot() ? 'Deploy on the robot' : 'Deploy on the practice robot',
      lead: 'Start a session, then the ladder: Arm, Start SONIC, Clear map, Send goal, GO. Every step is a press relayed to the kit\'s console, which checks its own gates.',
      html: `
        <h4 class="dp-next-head">The next session</h4>
        <div class="dp-summary">
          <div><span>Mode</span><strong class="${isRobot() ? 'block' : ''}">${isRobot() ? `Real robot · ${escape(st().robot_link?.robot ?? 'lab-g1')}` : 'Practice · simulated G1'}</strong></div>
          <div><span>Scan</span><strong>${escape(S.scanName ?? 'none')}</strong></div>
          <div><span>Goal</span><strong>${S.goal ? `(${num(S.goal.xy[0], 2)}, ${num(S.goal.xy[1], 2)}) · ${escape(goalStatus())}` : 'none yet'}</strong></div>
          <div><span>Policy</span><strong>${escape(profileLabel(profileName()))}</strong></div>
          <div><span>Odometry</span><strong>${escape(odomLabel(odomName()))}</strong></div>
          <div><span>Rehearsal</span><strong class="${v?.tone ?? ''}">${escape(rec ? `${v?.title ?? setState(rec)} · ${rec.name}` : 'no matching completed rehearsal')}</strong></div>
        </div>
        <p class="tiny">Change these in Connect (next session settings).</p>
        ${!rec?.verdict ? '<div class="callout warning">This goal has no matching completed rehearsal for this profile and odometry. Rehearse first, unless you only practise the ladder.</div>' : ''}
        ${ended ? `<p class="tiny">Last session ${escape(S.reviewName)}: ${ended.length} attempt${ended.length === 1 ? '' : 's'}. <button class="link-button" data-action="step:review">Review</button></p>` : ''}`,
      primary: { label: isRobot() ? 'Start robot session…' : 'Start practice session…', action: 'sheet:start', locked: locked ?? freshLock('start'), tone: isRobot() ? 'robot' : 'practice' },
    };
  }
  const rows = ladderRows(), p = S.panel ?? {}, moved = goalSentStale();
  const estopped = p.runner === 'E-STOP', lostNow = !!S.view && liveState() === 'lost';
  // A goal moved after Send goal makes Send goal the step to do again.
  if (moved) { const g = rows.find(r => r.key === 'goal'); if (g?.state === 'done' && !walking()) { g.state = 'now'; g.note = moved; rows.find(r => r.key === 'go').state = 'todo'; } }
  const attempts = panelAttempts(), lastA = attempts.at(-1), untagged = attempts.filter(a => a.outcome && !a.tag);
  // After an attempt ends: tag it, then pick the next goal (or send the same goal again). Not once a new goal was
  // picked (Send goal is the step then) or sent.
  const endKey = lastA?.outcome ? `${sess.name}:${lastA.n}` : null;
  if (endKey && S.attemptEnd?.key !== endKey) S.attemptEnd = { key: endKey, at: Date.now() };
  const sentAfter = S.sendResult?.ok && S.attemptEnd?.key === endKey && S.sendResult.at > S.attemptEnd.at;
  const afterAttempt = !!endKey && !walking() && !estopped && !moved && !sentAfter;
  const nowRow = estopped || afterAttempt ? null : rows.find(r => r.state === 'now') ?? rows.find(r => r.state !== 'done');
  const sc = S.startCheck, lastKey = lastA ? `${sess.name}:${lastA.n}` : null, lastDraft = lastKey ? (S.tagDraft[lastKey] ??= { tag: null, note: '' }) : null;
  let primary = null, secondary = '';
  const control = controlLock();
  const endButton = `<button class="dp-secondary" data-action="sheet:end" ${walking() || control ? `disabled title="${walking() ? 'The robot is walking: Stand or E-STOP first' : escape(control)}"` : ''}>End session…</button>${walking() ? lockLine('End session is locked while the robot walks') : ''}`;
  if (sess && !attached()) { primary = { label: `Attach to this ${ident().kind === 'robot' ? 'robot' : 'practice'} session…`, action: 'step:connect', locked: null, tone: ident().kind === 'robot' ? 'robot' : 'practice' }; secondary = ''; }
  else if (estopped) primary = { label: 'End session…', action: 'sheet:end', locked: control };
  else if (walking()) { primary = { label: 'Walking…', action: 'none', locked: 'Stand or E-STOP from the bar above; the remote and the physical E-stop stay in hand' }; secondary = endButton; }
  else if (afterAttempt || !nowRow) {
    const tagged = !lastA?.outcome || lastA.tag;
    primary = tagged ? { label: 'Pick the next goal', action: 'step:goal', locked: null }
      : { label: 'Save tag', action: `tag:${lastKey}`, locked: lastDraft?.tag ? null : `Pick a tag for attempt ${lastA.n} above (clean, touched, stumble…)`, busyText: 'Saving…' };
    const againLock = control ?? (unknownAct() ? unknownWords(unknownAct(), { stable: true }) : null) ?? lockStr(freshLock('goal'));
    secondary = `<button class="dp-secondary" data-action="send-goal" ${goalUsable() && !S.busy && !againLock ? '' : 'disabled'} title="${escape(againLock ?? (goalUsable() ? 'The same goal: the robot walks from where it stands now' : 'The goal is not checked on this scan'))}">Send this goal again</button>${endButton}`;
  } else {
    const action = { arm: 'sheet:arm', sonic: 'ladder:sonic', map: 'ladder:map', goal: 'send-goal', go: 'sheet:go' }[nowRow.key];
    const label = { arm: 'Arm…', sonic: 'Start SONIC', map: 'Clear map', goal: 'Send goal', go: isRobot() ? 'GO…' : 'GO (practice)…' }[nowRow.key];
    primary = { label, action, locked: nowRow.lock, tone: nowRow.key === 'go' ? (isRobot() ? 'robot' : 'practice') : '', busyText: 'Sending…' };
    secondary = endButton;
  }
  // The card for the attempt that just ended goes first; older untagged attempts follow it.
  const cards = untagged.slice().reverse().map(a => tagCard(a, sess.name, afterAttempt && a === lastA)).join('');
  const attention = estopped ? `estop:${sess.name}` : afterAttempt && !lastA.tag ? `tag:${lastKey}` : lostNow ? `lost:${sess.name}` : null;
  const viewer = sess && !attached();
  const noteHtml = n => (n.kind === 'pending' ? '' : `<em class="${n.kind}">${escape(n.text)}</em>`);  // an unknown press is said under the step header
  const sendHtml = () => {
    const r = S.sendResult; if (!r || afterAttempt) return '';
    if (r.unknown && S.acts[r.act]?.state === 'unknown') return '';  // said under the step header
    if (r.learned) return `<div class="callout ${r.ok ? 'ok' : 'warning'}" role="status">${escape(r.learned)}</div>`;
    return `<div class="callout ${r.ok ? 'ok' : 'warning'}" role="status">${r.ok ? `Goal confirmed by the node${escape(r.ack ?? '')}${r.check ? `. Start: ${escape(startWords(r.check, { short: true }))}` : ''}.` : `Send goal refused: ${escape(r.text)}`}</div>`;
  };
  const goHtml = () => {
    const r = S.goResult; if (!r) return '';
    if (r.unknown && S.acts[r.act]?.state === 'unknown') return '<div class="callout warning" role="status"><strong>Watch the robot:</strong> it may be walking. E-STOP, Stand and Take over work while the page checks whether GO arrived.</div>';
    if (r.learned) return `<div class="callout ${r.ok ? 'ok' : 'warning'}" role="status">${escape(r.learned)}</div>`;
    return r.ok ? '' : `<div class="callout warning" role="status">GO refused by the console: ${escape(r.text)}</div>`;
  };
  return {
    title: lostNow ? 'Live view lost' : walking() ? 'Walking' : afterAttempt ? `Attempt ${lastA.n} ended` : `${isRobot() ? 'Robot' : 'Practice'} session${viewer ? ' · viewing' : ''}`,
    lead: lostNow ? `${sess.name} · last seen ${Math.round(liveAge())} s ago` : `${sess.name} · ${PHASE[p.phase] ?? p.phase ?? 'starting'}`,
    attention,
    html: `
      ${estopped ? '<div class="callout danger" role="alert"><strong>E-STOP is active.</strong> The runner holds the robot in its safe mode and the console refuses every other press. End the session; start a new one to try again.</div>' : ''}
      ${viewer ? '' : cards}
      <ol class="dp-ladder${estopped ? ' stopped' : ''}${afterAttempt ? ' resting' : ''}${viewer ? ' viewing' : ''}">${rows.map(r => `<li class="${r.state}${r === nowRow ? ' current' : ''}" ${r.detail ? `title="${escape(`The console: ${r.detail}`)}"` : ''}>${statusIcon(r.state === 'done' ? 'done' : r === nowRow ? 'now' : 'todo')}<div><strong>${escape(r.label)}</strong><small>${escape(r.sub)}</small>${r.note ? `<em>${escape(r.note)}</em>` : ''}${r === nowRow && r.lock && !estopped && !viewer && !r.lock?.act ? `<em ${liveAttr(r.lock)}>${escape(liveText(r.lock))}</em>` : ''}${S.ladderNote[r.key] && r.key !== 'goal' && !estopped && r.state !== 'done' ? noteHtml(S.ladderNote[r.key]) : ''}</div>${r.state === 'done' && r.key === 'map' && !walking() && !estopped && !viewer ? '<button class="link-button" data-action="ladder:map">Again</button>' : ''}</li>`).join('')}</ol>
      ${sendHtml()}
      ${goHtml()}
      ${sc ? `<p class="tiny">Start check: ${escape(startWords(sc, { short: true }))} (the grey ghost in 3D is the scan pose).</p>` : ''}
      ${attempts.length ? `<h4>Attempts</h4><ol class="dp-attempts">${attempts.map(a => `<li><strong>${a.n}</strong><span class="outcome ${a.outcome === 'arrived' ? 'outcome-good' : a.outcome ? 'outcome-warn' : 'outcome-live'}">${escape(a.outcome ?? 'walking')}</span>${finite(a.final_dist_m) ? `<small>${num(a.final_dist_m, 2)} m from the goal</small>` : ''}${a.tag ? `<span class="dp-tag">${escape(a.tag)}</span>` : a.outcome ? '<small>untagged</small>' : ''}</li>`).join('')}</ol>` : ''}`,
    primary,
    secondary,
  };
}
function tagCard(a, sessionName, viaPrimary = false) {
  const key = `${sessionName}:${a.n}`, draft = S.tagDraft[key] ??= { tag: null, note: '' };
  return `<div class="dp-tagcard${viaPrimary ? ' first' : ''}"><strong>Attempt ${a.n} ended: ${escape(a.outcome)}${finite(a.final_dist_m) ? ` (${num(a.final_dist_m, 2)} m from the goal)` : ''}</strong><p class="tiny">${viaPrimary ? 'Tag it, then pick the next goal.' : 'Not tagged yet.'}</p>
    <div class="dp-tags">${(S.panel?.tags ?? TAGS).map(t => `<button data-tag="${escape(t)}" data-key="${escape(key)}" aria-pressed="${draft.tag === t}">${escape(t)}</button>`).join('')}</div>
    <input type="text" id="dp-note-${a.n}" data-note="${escape(key)}" placeholder="Note (optional)" value="${escape(draft.note)}">
    ${viaPrimary ? '' : `<button class="dp-secondary" data-action="tag:${escape(key)}" ${draft.tag ? '' : 'disabled'}>Save tag</button>`}${draft.result ? `<small>${escape(draft.result)}</small>` : ''}</div>`;
}

// Review (contract v3 E): one session's detail from the deploy service through the gateway: its receipt, attempts with
// tags, checks, rehearsal and alignment, the manifest v2, recording health and the exact Replay id. Durable: the URL
// holds the session and the attempt, so a reload or another browser opens the same view. A failed load keeps the last
// good snapshot on screen with its age and a Retry; it retries by itself with backoff (1, 2, 4, 8, 16 s).
// One request in flight per session. A render only ASKS for the detail (ensureDetail): it starts a load when there is
// none yet, or every 4 s for a live session; never for a session the service does not have (404, terminal), never past
// the retry budget (5 retries at 1, 2, 4, 8, 16 s: then a Retry button only), never for an unsupported service.
const DETAIL_RETRIES = 5;
function ensureDetail(name) {
  if (!name) return;
  const d = S.detail[name];
  if (!d) return loadDetail(name);
  if (d.loading || d.retryTimer || d.missing || d.unsupported || d.gaveUp) return;
  if (d.data && session()?.name === name && performance.now() - (d.at ?? 0) > 4000) loadDetail(name);
}
async function loadDetail(name, { manual = false } = {}) {
  if (!name) return;
  const cur = S.detail[name];
  if (cur?.loading) return;
  if (manual && cur) { clearTimeout(cur.retryTimer); Object.assign(cur, { retryTimer: 0, retries: 0, gaveUp: false, missing: false }); }
  S.detail[name] = { ...(cur ?? {}), loading: true, requests: (cur?.requests ?? 0) + 1 };
  const r = await api(`/api/deploy/session?name=${encodeURIComponent(name)}`, { timeout: 6000 });
  const d = S.detail[name] = { ...(S.detail[name] ?? {}), loading: false, at: performance.now() };
  if (r.ok && r.data && typeof r.data === 'object' && !r.data.error && r.data.supported !== false) {
    Object.assign(d, { data: r.data, good: r.data, goodAt: Date.now(), error: null, unsupported: false, retries: 0, missing: false, gaveUp: false });
  } else if (r.status === 404 && /no such session|unknown session|not found/i.test(r.data?.error ?? '')) {
    Object.assign(d, { data: null, error: null, missing: true });  // terminal: Retry or another session only
  } else if (unsupportedReply(r)) {
    Object.assign(d, { data: null, unsupported: unsupportedWhy(r), unsupportedReplay: r.data?.replay ?? null, error: null });
    if (S.manifestFor !== name) loadManifest(name);
  } else {
    d.error = reason(r); d.data = null; d.retries = (d.retries ?? 0) + 1;
    if (d.retries <= DETAIL_RETRIES) d.retryTimer = setTimeout(() => { const x = S.detail[name]; if (x) x.retryTimer = 0; loadDetail(name); }, 1000 * 2 ** (d.retries - 1));
    else d.gaveUp = true;  // terminal: Retry only
  }
  if (S.visible && S.step === 'review' && S.reviewName === name) renderPanel(true);
}
const sizeText = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} kB` : `${b ?? 0} B`);
const clockText = t => (finite(t) ? new Date(t * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '—');
// The Replay id (exact, from the gateway's catalog registration) and why it cannot open when it cannot.
function replayInfo(detail) {
  const rp = detail?.replay;
  if (!rp) return { id: null, why: detail ? 'Replay registration is not reported by this Studio gateway' : null };
  const id = rp.catalog_id ?? (rp.linked && rp.studio_id ? rp.studio_id : null);
  const state = rp.state ?? (id ? 'registered' : 'not_registered');
  if (id && state === 'registered') return { id, why: null };
  const why = { not_registered: 'Not registered in Studio\'s Replay catalog', indexing: 'Studio is indexing this session: try again in a moment', error: 'Replay registration failed' }[state] ?? `Replay: ${state}`;
  const short = rp.detail ? String(rp.detail).split(/(?<=[.;:])\s/)[0].replace(/\s*\([^)]*\/[^)]*\)/g, '').slice(0, 140) : '';
  return { id: null, why: `${why}${short ? ` — ${short}` : ''}`, detail: rp.detail ?? null };
}
// Where the attempt starts in the Replay timeline: the gateway's replay_t_s, else the console's t_go (seconds since the
// console started, which the recording starts within about a second of).
const replayTime = a => (finite(a?.replay_t_s) ? { t: a.replay_t_s, exact: true } : finite(a?.t_go) ? { t: Math.max(0, a.t_go - 1), exact: false } : null);
function manifestHtml(m, { stale = null } = {}) {
  if (!m) return '';
  const items = Array.isArray(m.items) ? m.items : [];
  const empty = i => i.status === 'present' && !(i.bytes > 0) && i.id !== 'rehearsal';
  const req = items.filter(i => i.required), opt = items.filter(i => !i.required);
  const v2 = m.version === 2 || items.some(i => 'required' in i);
  const reqPresent = req.filter(i => i.status === 'present' && !empty(i)).length;
  const bad = items.filter(i => i.status === 'missing' || i.status === 'partial' || empty(i));
  const complete = m.complete === true;  // only the service says complete (required present + finalized + console closed)
  const stateWord = m.state === 'lost' ? ' · LOST: the console died before it closed the recording' : m.state === 'recording' ? ' · still recording' : '';
  const head = v2 ? `${reqPresent} of ${req.length} required present${m.finalized === false ? ' · not finalized' : ''}${complete ? ' · complete' : ' · NOT complete'}${stateWord}`
    : `${items.filter(i => i.status === 'present' && !empty(i)).length} of ${items.length} present${complete ? ' · complete' : ''}`;
  const row = i => `<tr class="${empty(i) ? 'missing' : escape(String(i.status).replace('/', ''))}${i.required ? ' req' : ''}"><td>${statusIcon(empty(i) ? 'warn' : i.status === 'present' ? 'pass' : i.status === 'partial' ? 'warn' : i.status === 'missing' ? (i.required ? 'block' : 'warn') : 'later')}</td><td>${escape(i.id.replaceAll('_', ' '))}</td><td>${empty(i) ? 'empty' : i.status === 'present' ? escape(sizeText(i.bytes ?? 0)) : escape(i.status)}${i.gaps ? ` · ${i.gaps} gap${i.gaps === 1 ? '' : 's'}` : ''}${i.dropped ? ` · ${i.dropped} dropped` : ''}</td><td>${escape(i.reason ?? '')}</td></tr>`;
  return `<h4>Evidence <span class="tiny ${complete ? '' : 'warn'}">${escape(head)}</span></h4>
    ${stale ? `<p class="tiny warn">${escape(stale)}</p>` : ''}
    ${Array.isArray(m.incomplete_reasons) && m.incomplete_reasons.length && !complete ? `<ul class="dp-incomplete">${m.incomplete_reasons.slice(0, 6).map(r => `<li>${escape(r)}</li>`).join('')}</ul>` : ''}
    ${v2 ? `<table class="dp-manifest"><tbody><tr class="grp"><td colspan="4">Required for this session</td></tr>${req.map(row).join('')}<tr class="grp"><td colspan="4">Optional</td></tr>${opt.map(row).join('')}</tbody></table>`
      : `<table class="dp-manifest"><tbody>${items.map(row).join('')}</tbody></table>`}
    ${bad.length ? `<p class="tiny">${bad.length} missing, partial or empty: ${escape(bad.map(i => i.id.replaceAll('_', ' ')).join(', '))}.</p>` : ''}`;
}
function attemptHtml(name, a, sel, live) {
  const out = a.outcome ?? a.result ?? null, key = `review:${name}:${a.n}`, draft = S.tagDraft[key] ??= { tag: a.tag ?? null, note: a.note ?? '' };
  const passage = a.passage === 'crossed' ? 'passed the gap' : a.passage === 'missed' ? 'went AROUND the gap' : null;
  const reh = a.rehearsal ? `${a.rehearsal.name ?? 'set'}${a.rehearsal.verdict ? ` · ${a.rehearsal.verdict}` : ''}` : 'none in force';
  const sc = a.start_check, rt = replayTime(a);
  const facts = [
    ['Outcome', `${out ?? 'open'}${finite(a.final_dist_m ?? a.end_goal_dist_m) ? ` · ${num(a.final_dist_m ?? a.end_goal_dist_m, 2)} m from the goal` : ''}${finite(a.duration_s) ? ` · ${num(a.duration_s, 1)} s` : ''}`],
    ['Goal', Array.isArray(a.goal_scene) ? `(${num(a.goal_scene[0], 2)}, ${num(a.goal_scene[1], 2)}) on ${a.scan ?? 'the scan'}` : '—'],
    ['Passage', passage ?? (a.passage_required ? 'required, not scored' : 'not required')],
    ['Rehearsal', reh], ['Start check', sc ? `${num(sc.moved_m, 2)} m / ${num(sc.turned_deg, 0)}° from the scan pose${sc.within_offset_envelope === false ? ' · outside the rehearsed offset' : ''}` : '—'],
    ['Alignment', a.align ? `overlap ${num(a.align.overlap, 2)}${a.align.ok === false ? ' · NOT ok' : ''}` : sc?.overlap ? `overlap ${num(sc.overlap, 2)}` : '—'],
    ['Plans', finite(a.plans) ? `${a.plans}${finite(a.no_safe_plans) ? ` · ${a.no_safe_plans} no-safe` : ''}` : '—'],
    ['In Replay', rt ? `${rt.exact ? '' : '≈ '}${num(rt.t, 1)} s${rt.exact ? '' : ' (console clock)'}` : 'time not recorded'],
  ];
  return `<li class="dp-rev-attempt${sel ? ' sel' : ''}"><button class="dp-rev-head" data-attempt="${a.n}" aria-expanded="${sel}"><strong>${a.n}</strong><span class="outcome ${out === 'arrived' && a.passage !== 'missed' ? 'outcome-good' : out ? 'outcome-warn' : 'outcome-live'}">${escape(out ?? 'walking')}</span>${a.passage === 'missed' ? '<span class="dp-tag warn">missed gap</span>' : ''}${a.tag ? `<span class="dp-tag">${escape(a.tag)}</span>` : out ? '<small>untagged</small>' : ''}${a.note ? `<small class="dp-rev-note">${escape(a.note)}</small>` : ''}</button>
    ${sel ? `<div class="dp-rev-body"><dl class="dp-rev-facts">${facts.map(([k, v]) => `<dt>${escape(k)}</dt><dd>${escape(v)}</dd>`).join('')}</dl>
      ${out ? `<div class="dp-tags">${(S.panel?.tags ?? TAGS).map(t => `<button data-rtag="${escape(t)}" data-key="${escape(key)}" aria-pressed="${draft.tag === t}">${escape(t)}</button>`).join('')}</div>
      <input type="text" id="dp-rnote-${a.n}" data-rnote="${escape(key)}" placeholder="Note (optional)" value="${escape(draft.note ?? '')}">
      <button class="dp-secondary" data-action="rtag:${escape(name)}:${a.n}" ${draft.tag && !draft.saving && reviewOperator() ? '' : 'disabled'}>${draft.saving ? 'Saving…' : a.tag ? 'Change tag' : 'Save tag'}</button>${reviewOperator() ? '' : lockLine('Type your name above: it is recorded with the tag')}${draft.result ? `<small class="dp-rev-result">${escape(draft.result)}</small>` : ''}
      ${a.tag_history?.length ? `<details class="dp-rev-hist"><summary>Tag history (${a.tag_history.length})</summary><ul>${a.tag_history.map(h => `<li>${escape(h.tag ?? '')}${h.note ? ` · ${escape(h.note)}` : ''} · ${escape(h.operator ?? '')} ${escape(clockText(h.t ?? h.at))}</li>`).join('')}</ul></details>` : ''}` : '<p class="tiny">Still walking: tag it when it ends.</p>'}
      </div>` : ''}</li>`;
}
// The reviewed session's kind (Review's eyebrow and tone): its receipt, else the service's list; never the next-session mode.
function reviewKind(name = S.reviewName) {
  const d = S.detail[name], r = (d?.data ?? d?.good)?.receipt;
  if (r?.kind) return r.kind;
  if ((st().sessions?.robot ?? []).some(s => s.name === name)) return 'robot';
  const row = (st().sessions?.other ?? []).find(s => s.name === name);
  return row ? (row.practice ? 'practice' : /^rehearse-/.test(name) ? 'rehearsal' : null) : null;
}
function reviewBody() {
  const list = [...(st().sessions?.robot ?? []), ...(st().sessions?.other ?? [])];
  const name = S.reviewName ?? list[0]?.name ?? null;
  if (name && name !== S.reviewName) S.reviewName = name;
  if (name) ensureDetail(name);
  const d = name ? S.detail[name] : null, data = d?.data ?? null, shown = data ?? (d?.error ? d.good : null);
  const live = session()?.name === name;
  // Older services: the manifest alone, and the attempts only while the session is live.
  if (d?.unsupported && name && S.manifestFor !== name) loadManifest(name);
  const attempts = (shown?.attempts ?? (d?.unsupported && live ? panelAttempts() : null))?.map(attemptRow) ?? null;
  const sel = S.reviewAttempt ?? attempts?.at(-1)?.n ?? null;
  const rp = replayInfo(shown ?? (d?.unsupportedReplay ? { replay: d.unsupportedReplay } : null)), selA = attempts?.find(a => a.n === sel);
  const receipt = shown?.receipt ?? null, id = receipt ? { kind: receipt.kind, robot: receipt.robot, profile: receipt.profile?.name, sha: receipt.profile?.sha, odom: receipt.odom, operator: receipt.operator, scan: receipt.scan?.name } : null;
  const listed = list.some(s => s.name === name);
  const tries = (d?.retries ?? 0) + 1;
  const errBox = d?.error ? `<div class="callout warning dp-retry" role="status"><strong>The session could not be loaded:</strong> ${escape(d.error)}${d.retryTimer ? ` · trying again (${tries} of ${DETAIL_RETRIES + 1})` : d.gaveUp ? ` · gave up after ${DETAIL_RETRIES + 1} tries` : ''}. ${d.good ? `Showing the last good snapshot from ${escape(ago((Date.now() - d.goodAt) / 1000))}.` : ''} <button class="link-button" data-action="detail-retry">Retry</button></div>` : '';
  const others = list.filter(s => s.name !== name).slice(0, 4);
  const missingBox = d?.missing ? `<div class="callout warning dp-missing" role="status"><strong>The deploy service has no session named ${escape(name)}.</strong> A Review link opens a session the service still lists (the kit looks names up in the current lab day). ${others.length ? 'Today\'s sessions:' : 'It lists no session today.'} ${others.map(s => `<button class="link-button" data-review-session="${escape(s.name)}">${escape(s.name)}</button>`).join(' · ')} <button class="link-button" data-action="detail-retry">Retry</button></div>` : '';
  let mHtml = '';
  if (shown?.manifest) mHtml = manifestHtml(shown.manifest, { stale: d?.error ? 'From the last good snapshot.' : null });
  else if (d?.unsupported) {
    const m = S.manifestFor === name ? S.manifest : null, good = S.manifestGood[name];
    if (m?.error) mHtml = `<h4>Evidence</h4><div class="callout warning dp-retry" role="status"><strong>Evidence could not be loaded:</strong> ${escape(m.error)}. <button class="link-button" data-action="manifest">Retry</button></div>${good ? manifestHtml(good.m, { stale: `Last good snapshot from ${ago((Date.now() - good.at) / 1000)}.` }) : ''}`;
    else mHtml = m ? manifestHtml(m) : '<p class="tiny">Loading the manifest…</p>';
  }
  const rec = shown?.recording ? recordingWords(shown.recording) : null;
  // One message for an older service: what it can and cannot show, nothing that contradicts it below.
  const unsupportedBox = d?.unsupported ? `<div class="callout warning">Session detail is unsupported by this deploy service (${escape(d.unsupported)}). ${live ? 'The attempts below come from the live console; tags are edited there (Deploy).' : 'Its attempts and tags cannot be shown here; the evidence below comes from its manifest.'}</div>` : '';
  const replayLock = !name ? 'No session yet' : rp.id ? null : d?.missing ? 'No such session in the deploy service' : d?.unsupported && !rp.why ? 'Replay registration is not reported by this deploy service'
    : !shown && d?.error ? 'The session could not be loaded: Retry above' : rp.why ?? 'Loading the session…';
  const canTag = !!shown && !d?.unsupported;
  return {
    title: 'Review', lead: 'What the session did and recorded, from the deploy service. This view survives a reload: its link opens it in any browser.',
    html: `
      <label class="field"><span>Session</span><select id="dp-review">${!listed && name ? `<option value="${escape(name)}" selected>${escape(name)}</option>` : ''}${[['Robot sessions', st().sessions?.robot ?? []], ['Practice and rehearsal runs', st().sessions?.other ?? []]].filter(([, l]) => l.length).map(([g, l]) => `<optgroup label="${g}">${l.map(s => `<option value="${escape(s.name)}" ${s.name === name ? 'selected' : ''}>${escape(s.name)}${s.practice ? ' (practice)' : ''}${s.started ? ` · ${new Date(s.started * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</option>`).join('')}</optgroup>`).join('') || (name ? '' : '<option>No sessions today</option>')}</select></label>
      ${errBox}${missingBox}${unsupportedBox}
      ${!d || (d.loading && !shown && !d.error && !d.missing) ? '<p class="tiny">Loading the session…</p>' : ''}
      ${id ? `<div class="dp-summary dp-rev-receipt">
          <div><span>Session</span><strong>${escape(id.kind === 'robot' ? `Real robot · ${id.robot ?? ''}` : id.kind === 'practice' ? 'Practice · simulated G1' : id.kind ?? '—')}${shown.ended ? ' · ended' : ' · running'}</strong></div>
          <div><span>Policy</span><strong>${escape(profileLabel(id.profile))} · ${escape(shortSha(id.sha))}</strong></div>
          <div><span>Odometry</span><strong>${escape(odomLabel(id.odom))}</strong></div>
          <div><span>Operator</span><strong>${escape(id.operator ?? '—')}</strong></div>
          <div><span>Scan</span><strong>${escape(id.scan ?? '—')}</strong></div>
        </div>` : ''}
      ${rec ? `<div class="dpi-rec ${rec.tone} dp-rev-rec">${statusIcon(rec.tone)}<span>${escape(rec.text)}</span></div>` : ''}
      ${canTag && attempts?.some(a => a.outcome) ? `<label class="field dp-rev-op"><span>Your name (recorded with a tag)</span><input id="dp-review-operator" type="text" autocomplete="name" placeholder="Your name" value="${escape(reviewOperator())}"></label>` : ''}
      ${name && attempts ? `<h4>Attempts</h4>${attempts.length ? `<ol class="dp-rev-attempts">${attempts.map(a => attemptHtml(name, a, a.n === sel, live)).join('')}</ol>` : '<p class="tiny">No attempts in this session.</p>'}` : ''}
      ${mHtml}`,
    primary: { label: selA ? `Open in Replay at attempt ${selA.n}` : 'Open in Replay', action: 'replay', locked: replayLock },
    secondary: name ? `<button class="dp-secondary" data-action="detail-retry">Refresh</button>` : '',
  };
}
// Review's tagging name: what was typed here, else Connect's operator.
const reviewOperator = () => (S.reviewOperator ?? S.operator ?? '').trim();
async function loadManifest(name) {
  S.manifestFor = name; S.manifest = null;
  const r = await api(`/api/deploy/manifest?name=${encodeURIComponent(name)}`, { timeout: 5000 });
  if (S.manifestFor !== name) return;
  if (r.ok && Array.isArray(r.data.items)) { S.manifest = r.data; S.manifestGood[name] = { m: r.data, at: Date.now() }; }
  else S.manifest = { items: [], error: reason(r) };
  renderPanel(true);
}
// The Review URL: ?workspace=deploy&session=<name>&attempt=<n> while Review shows; removed when it does not.
function syncReviewUrl() {
  if (!S.visible) return;
  if (S.step === 'review' && S.reviewName) updateView({ workspace: 'deploy', session: S.reviewName, attempt: S.reviewAttempt ?? null });
  else if (new URLSearchParams(location.search).get('workspace') === 'deploy') updateView({ session: null, attempt: null });
}
function openReplay() {
  const name = S.reviewName, d = S.detail[name], shown = d?.data ?? d?.good, rp = replayInfo(shown);
  if (!rp.id) return;
  const attempts = shown?.attempts ?? [], a = attempts.find(x => x.n === (S.reviewAttempt ?? attempts.at(-1)?.n));
  const rt = replayTime(a);
  emit('open-session', { id: rp.id, time: rt?.t ?? null, attempt: a?.n ?? null });
}

// ------------------------------------------------------------------------------------------------ panel events
function bindPanel(root) {
  // Next session's mode (Connect): never relabels a running session.
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    S.mode = b.dataset.mode; store.set('mode', S.mode);
    if (!session() && S.mode === 'robot' && (scanRow(S.scanName)?.practice || S.scanName?.startsWith('practice-'))) { S.scanName = null; S.scene = null; onState(S.state, false); }
    renderAll();
  }));
  const opInput = root.querySelector('#dp-operator');
  opInput?.addEventListener('input', e => { S.operator = e.target.value; store.set('operator', S.operator); renderPanel(); renderContext(); });
  opInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && S.operator.trim()) doAction(root.querySelector('#dp-primary')?.dataset.action === 'attach' ? 'attach' : 'lease'); });
  root.querySelector('#dp-profile')?.addEventListener('change', e => { S.profile = e.target.value; store.set('profile', S.profile); renderAll(); });
  root.querySelector('#dp-odom')?.addEventListener('change', e => { S.odom = e.target.value; store.set('odom', S.odom); renderAll(); });
  root.querySelector('#dp-scan')?.addEventListener('change', e => selectScan(e.target.value));
  root.querySelector('#dp-room')?.addEventListener('change', e => { S.room = e.target.value; store.set('room', S.room); renderPanel(true); });
  root.querySelector('#dp-seconds')?.addEventListener('change', e => { S.seconds = Math.max(3, Math.min(30, Number(e.target.value) || 8)); renderPanel(true); });
  root.querySelector('#dp-review')?.addEventListener('change', e => { S.reviewName = e.target.value; S.reviewAttempt = null; syncReviewUrl(); renderPanel(true); });
  root.querySelector('#dp-map-toggle')?.addEventListener('click', () => { S.mapCollapsed = !S.mapCollapsed; document.body.classList.toggle('dp-map-collapsed', S.mapCollapsed); renderPanel(true); setTimeout(updateInsets, 50); });
  root.querySelector('[data-passage]')?.addEventListener('change', e => { if (S.goal?.passage) { S.goal.passage.required = e.target.checked; drawGoal(); renderAll(); } });
  root.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { const d = S.tagDraft[b.dataset.key] ??= {}; d.tag = b.dataset.tag; d.result = null; renderPanel(true); }));
  root.querySelectorAll('[data-note]').forEach(i => i.addEventListener('input', e => { (S.tagDraft[i.dataset.note] ??= {}).note = e.target.value; }));
  root.querySelectorAll('[data-rtag]').forEach(b => b.addEventListener('click', () => { const d = S.tagDraft[b.dataset.key] ??= {}; d.tag = b.dataset.rtag; d.result = null; renderPanel(true); }));
  root.querySelectorAll('[data-rnote]').forEach(i => i.addEventListener('input', e => { (S.tagDraft[i.dataset.rnote] ??= {}).note = e.target.value; }));
  root.querySelector('#dp-review-operator')?.addEventListener('input', e => { S.reviewOperator = e.target.value; root.querySelectorAll('[data-action^="rtag:"]').forEach(b => { const k = `review:${S.reviewName}:${b.dataset.action.split(':').pop()}`; b.disabled = !S.tagDraft[k]?.tag || !reviewOperator(); }); });
  root.querySelector('#dp-review-operator')?.addEventListener('change', () => renderPanel(true));
  root.querySelectorAll('[data-review-session]').forEach(b => b.addEventListener('click', () => { S.reviewName = b.dataset.reviewSession; S.reviewAttempt = null; syncReviewUrl(); renderPanel(true); }));
  root.querySelectorAll('[data-attempt]').forEach(b => b.addEventListener('click', () => { const n = Number(b.dataset.attempt); S.reviewAttempt = n; syncReviewUrl(); renderPanel(true); }));
  root.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => doAction(b.dataset.action, b)));
}
async function attachSession(takeOver) {
  const sess = session(); if (!sess || !S.operator.trim()) return;
  if (!holdsLease() || takeOver) await takeLease(takeOver);
  if (holdsLease() && session()?.name === sess.name) {
    setAttached(sess.name);
    S.notice = { kind: 'ok', text: `Attached to ${sess.name}: your presses go to it, with your name, and it refuses them if it is not that session.` };
  }
  renderAll();
}
function doAction(a, el = null) {
  if (!a || a === 'none') return;
  if (a.startsWith('step:')) return setStep(a.slice(5));
  if (a.startsWith('sheet:')) return openSheet(a.slice(6), el);
  if (a.startsWith('ladder:')) return ladderAct(a.slice(7));
  if (a.startsWith('tag:')) return saveTag(a.slice(4));
  if (a.startsWith('rtag:')) { const [, ...rest] = a.split(':'); const n = Number(rest.pop()); return saveReviewTag(rest.join(':'), n); }
  switch (a) {
    case 'lease': return takeLease(false);
    case 'lease-takeover': return takeLease(true);
    case 'attach': return attachSession(false);
    case 'attach-takeover': return attachSession(true);
    case 'release': releaseLease(); S.lease = { ...S.lease, id: null, supported: S.lease.supported === false ? null : S.lease.supported }; return renderAll();
    case 'doctor': return runDoctor();
    case 'scan': return startScan();
    case 'clear-goal': return clearGoal();
    case 'rehearse': return runRehearsal();
    case 'retry-tracks': { const rec = rehearsalFor(); if (rec) loadTracks(rec, `${rec.name}:${setState(rec)}:${Date.now()}`); return renderPanel(true); }
    case 'send-goal': return sendGoal();
    case 'manifest': S.manifestFor = null; if (S.reviewName) loadManifest(S.reviewName); return renderPanel(true);
    case 'detail-retry': loadDetail(S.reviewName, { manual: true }); return renderPanel(true);
    case 'replay': return openReplay();
    default: return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ sheets
// In-page confirmations, docked over the step panel: the stage stays visible (the goal and route in 3D). Keyboard: focus
// stays in the sheet (Tab cycles through it and the E-STOP button), Escape cancels, focus returns to the control that
// opened it.
function openSheet(kind, opener = null) {
  const from = opener ?? document.activeElement;
  S.sheet = { kind, confirm: {}, armed: false, opener: from?.id ? { id: from.id } : from?.dataset?.action ? { action: from.dataset.action } : null }; S.sheetError = null;
  if (kind === 'go' && S.goal?.xy) d3.frame([d3.liveScenePose() ?? [0, 0, 0], S.goal.xy, ...(S.goal.check?.path_xy ?? [])], {});
  renderSheet();
}
function closeSheet() {
  const opener = S.sheet?.opener;
  S.sheet = null; S.sheetError = null; renderSheet();
  if (!opener) return;
  // The opener may have been rebuilt by a render meanwhile: find it again by id or action.
  const find = () => (opener.id ? document.getElementById(opener.id) : document.querySelector(`[data-action="${CSS.escape(opener.action)}"]`));
  const el = find();
  if (el && !el.disabled) el.focus({ preventScroll: true }); else { S.focusAction = opener.action ?? null; (document.getElementById('dp-primary') ?? $('dp-estop'))?.focus({ preventScroll: true }); }
}
// The session a sheet acts on, in its header: from the receipt (a start sheet: the NEXT session's settings).
function sheetIdentity(kind) {
  if (kind === 'start') return `Next session · ${S.mode === 'robot' ? `robot ${st().robot_link?.robot ?? 'lab-g1'}` : 'practice'} · ${profileLabel(nextProfile())} · ${odomLabel(nextOdom())}`;
  const id = ident(); if (!id) return 'No session running';
  return `${id.name} · ${id.kind === 'robot' ? id.robot : 'simulated G1'} · ${profileLabel(id.profile)} · ${odomLabel(id.odom)}`;
}
// Locks every motion-enabling sheet shares: who controls, an unknown press, stale sources, a lost view.
function sheetLock(press) {
  const control = controlLock(); if (control) return control;
  const u = unknownAct(); if (u) return { key: `act:${u.id}`, text: unknownWords(u, { stable: true }), act: u.id };
  if (press !== 'start' && S.view && liveState() === 'lost') return 'Live view lost: watch the robot';
  return freshLock(press);
}
function sheetModel() {
  const k = S.sheet?.kind, sess = session();
  if (k === 'start') {
    const robot = S.mode === 'robot', c = S.sheet.confirm, all = CONFIRM.every(([id]) => c[id]);
    const lock = sess ? `A session is running (${sess.name}): end it first` : !holdsLease() ? 'Take the controls first (Connect)' : null;
    return { title: robot ? 'Start the robot session' : 'Start the practice session', tone: robot ? 'robot' : 'practice',
      body: `<p>${robot ? 'The kit starts the console on the real robot: the runner, the planner node and the recorder. Nothing moves until you Arm.' : 'The kit starts a simulated robot on this scan\'s twin, 0.2 m and 20° off the scan pose, with the same console and recorder.'}</p>
        <div class="dp-summary"><div><span>Mode</span><strong>${robot ? `Real robot · ${escape(st().robot_link?.robot ?? 'lab-g1')}` : 'Practice · simulated G1'}</strong></div><div><span>Scan</span><strong>${escape(S.scanName ?? '')}</strong></div><div><span>Policy</span><strong>${escape(profileLabel(nextProfile()))}</strong></div><div><span>Odometry</span><strong>${escape(odomLabel(nextOdom()))}</strong></div><div><span>Operator</span><strong>${escape(S.operator.trim())}</strong></div></div>
        <p class="tiny">${escape(ODOMETRY[nextOdom()]?.validation ?? '')}.</p>
        <fieldset class="dp-confirm"><legend>Confirm, as on every robot day${robot ? '' : ' (practised here too)'}</legend>${CONFIRM.map(([id, text]) => `<label><input type="checkbox" data-confirm="${id}" ${c[id] ? 'checked' : ''}><span>${escape(text)}</span></label>`).join('')}</fieldset>`,
      ok: robot ? 'Start robot session' : 'Start practice session', locked: lock ?? (robot ? blockLockNext() : null) ?? freshLock('start') ?? (all ? null : 'Tick every item: they are stored with the session'),
      run: () => startSession({ ...Object.fromEntries(CONFIRM.map(([id]) => [id, true])) }) };
  }
  const robot = isRobot();
  if (k === 'arm') {
    return { title: 'Arm', tone: robot ? 'robot' : 'practice',
      body: `<p>Arming starts the runner's motor control and the planner node. ${robot ? '<strong>The gantry carries the weight</strong>: the robot may sag or twitch while the motors take over.' : 'The practice robot does the same in the simulator.'}</p>
        <label class="dp-confirm-one"><input type="checkbox" data-armed ${S.sheet.armed ? 'checked' : ''}><span>${robot ? 'The gantry carries the robot\'s weight and nobody is within 1 m' : 'I am practising the robot-day ladder'}</span></label>`,
      ok: robot ? 'Arm the real robot' : 'Arm (practice)', locked: sheetLock('arm') ?? blockLock() ?? (S.sheet.armed ? null : 'Confirm first'), run: () => ladderAct('arm') };
  }
  if (k === 'go') {
    const rec = rehearsalFor(), v = verdictText(rec), locks = S.panel?.go_locks ?? [], sc = S.startCheck ?? S.sendResult?.check;
    const blocking = (S.readiness ?? []).filter(c => c.status === 'block').map(c => c.label);
    const moved = goalSentStale();
    const items = [...locks.map(l => `Console: ${l}`), ...(moved ? [moved] : []), ...blocking.map(b => `Readiness: ${b}`)];
    const cautions = goCautions(), needAck = robot && cautions.length && !items.length;
    const cautionHtml = !items.length && cautions.length ? `<div class="dp-caution"><strong>No console lock, but:</strong><ul>${cautions.map(c => `<li>${statusIcon('warn')}${escape(c)}</li>`).join('')}</ul>
        ${robot ? `<label class="dp-confirm-one"><input type="checkbox" data-ack ${S.sheet.ack ? 'checked' : ''}><span>I walk this goal anyway: the area is clear and the remote is in hand. This override is recorded with the attempt.</span></label>` : '<p class="tiny">Practice: go ahead and see what happens; on the robot this needs a tick that is recorded with the attempt.</p>'}</div>` : '';
    const passage = S.goal?.passage?.required ? `must pass the ${num(S.goal.passage.width_m, 2)} m gap` : null;
    return { title: robot ? 'GO · the real robot walks' : 'GO · practice robot', tone: robot ? 'robot' : 'practice',
      body: `<div class="dp-summary">
          <div><span>Session</span><strong>${escape(sess?.name ?? '')}</strong></div>
          <div><span>Goal</span><strong>(${num(S.goal?.xy?.[0], 2)}, ${num(S.goal?.xy?.[1], 2)}) · ${escape(goalWords(S.goal?.xy))}${passage ? ` · ${escape(passage)}` : ''}</strong></div>
          <div><span>Route check</span><strong>${num(S.goal?.check?.path_m, 2)} m${S.goal?.check?.gap ? ` · gap ${num(S.goal.check.gap.width_m, 2)} m` : ''} · ${escape(S.goal?.check?.config && /profile/i.test(S.goal.check.config.basis ?? '') ? 'with the profile\'s route settings' : 'Studio\'s generic check')}</strong></div>
          <div><span>Policy</span><strong>${escape(profileLabel(profileName()))}${ident()?.profileSha ? ` · ${escape(shortSha(ident().profileSha))}` : ''}</strong></div>
          <div><span>Odometry</span><strong>${escape(odomLabel(odomName()))}</strong></div>
          <div><span>Rehearsal</span><strong class="${v?.tone ?? 'warn'}">${escape(rec ? `${setWords(rec)}${v ? ` — ${v.title}: ${v.text}` : ''}` : 'no matching completed rehearsal')}</strong></div>
          <div><span>Start</span><strong class="${sc?.within_offset_envelope === false ? 'warn' : ''}">${escape(startWords(sc))}</strong></div>
        </div>
        <p class="tiny">${escape(ODOMETRY[odomName()]?.validation ?? '')}.</p>
        ${items.length ? `<div class="dp-before"><strong>Before GO</strong><ul>${items.map(i => `<li>${statusIcon('block')}${escape(i)}</li>`).join('')}</ul></div>`
          : cautionHtml || (v?.tone === 'pass' ? '<p class="tiny ok">The console reports no lock, and the goal was rehearsed robust from this start. Watch the robot, remote in hand.</p>' : '<p class="tiny">The console reports no lock. Watch the robot, remote in hand.</p>')}`,
      ok: robot ? 'GO — the robot walks' : 'GO — practice robot walks',
      locked: sheetLock('go') ?? items[0] ?? (needAck && !S.sheet.ack ? 'Tick the line above: this walk has no matching complete rehearsal (or it did not pass)' : null), run: () => go(),
      caution: !items.length && cautions.length > 0 };
  }
  if (k === 'end') {
    const attempts = panelAttempts(), untagged = attempts.filter(a => a.outcome && !a.tag).length;
    return { title: 'End the session', tone: robot ? 'robot' : 'practice',
      body: `<p>The kit stops the runner and the planner and writes the session's manifest. ${robot ? 'The robot goes limp unless the runner holds it: <strong>the gantry carries the weight</strong>.' : ''}</p>
        <p>${escape(sess?.name ?? '')}: ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}${untagged ? `, <strong>${untagged} untagged</strong>` : ''}. You can still tag them in Review.</p>`,
      ok: 'End session', locked: walking() ? 'The robot is walking: Stand or E-STOP first' : !sess ? 'No session' : controlLock(), run: () => stopSession() };
  }
  return null;
}
// On the real robot a Link or Robot block locks Start session too (the next session is a robot one).
function blockLockNext() { const c = firstBlock(['link', 'robot']); return c ? blockText(c) : null; }
let lastSheetKey = '';
function renderSheet() {
  const host = $('dp-sheet-host'); if (!host) return;
  const m = S.sheet ? sheetModel() : null;
  document.body.classList.toggle('dp-sheet-open', !!m);
  if (!m) { host.innerHTML = ''; lastSheetKey = ''; return; }
  // The body is rebuilt only when its words change; the OK button and its lock are updated in place, so the focused
  // control (a checkbox, Cancel) stays the same element while a source ages.
  const bodyKey = JSON.stringify([S.sheet.kind, m.title, m.body, m.tone, m.caution, S.sheetError, sheetIdentity(S.sheet.kind)]);
  if (bodyKey !== lastSheetKey && !(S.pointerHeld && host.innerHTML)) {
    lastSheetKey = bodyKey;
    const focused = host.contains(document.activeElement) ? (document.activeElement.id || (document.activeElement.dataset.confirm ? `[data-confirm="${document.activeElement.dataset.confirm}"]` : document.activeElement.matches('[data-armed]') ? '[data-armed]' : document.activeElement.matches('[data-ack]') ? '[data-ack]' : null)) : null;
    host.innerHTML = `<div class="dp-sheet" role="dialog" aria-modal="true" aria-labelledby="dp-sheet-title" aria-describedby="dp-sheet-who" data-tone="${m.tone}" ${m.caution ? 'data-caution="1"' : ''}>
      <header><span class="dp-sheet-mode">${m.tone === 'robot' ? 'REAL ROBOT' : 'PRACTICE'}</span><span class="dp-sheet-who" id="dp-sheet-who">${escape(sheetIdentity(S.sheet.kind))}</span><h3 id="dp-sheet-title">${escape(m.title)}</h3></header>
      <div class="dp-sheet-body">${m.body}${S.sheetError ? `<div class="callout danger" role="alert">${escape(S.sheetError)}</div>` : ''}</div>
      <footer><button class="dp-sheet-ok ${m.tone}" id="dp-sheet-ok"></button><div id="dp-sheet-lock"></div><button class="dp-secondary" id="dp-sheet-cancel">Cancel</button><p class="tiny dp-sheet-keys">Esc cancels · Tab reaches E-STOP</p></footer></div>`;
    host.querySelector('#dp-sheet-cancel').addEventListener('click', closeSheet);
    host.querySelector('#dp-sheet-ok').addEventListener('click', () => { const cur = sheetModel(); if (cur && !cur.locked && !S.busy) { S.sheetError = null; cur.run(); } });
    host.querySelectorAll('[data-confirm]').forEach(i => i.addEventListener('change', () => { S.sheet.confirm[i.dataset.confirm] = i.checked; renderSheet(); }));
    host.querySelector('[data-armed]')?.addEventListener('change', e => { S.sheet.armed = e.target.checked; renderSheet(); });
    host.querySelector('[data-ack]')?.addEventListener('change', e => { S.sheet.ack = e.target.checked; renderSheet(); });
    const back = focused && (focused.startsWith('[') ? host.querySelector(focused) : host.querySelector(`#${CSS.escape(focused)}`));
    if (back) back.focus({ preventScroll: true });
    else if (!host.contains(document.activeElement)) host.querySelector('input, #dp-sheet-cancel')?.focus({ preventScroll: true });
  }
  const ok = host.querySelector('#dp-sheet-ok'), lockHost = host.querySelector('#dp-sheet-lock');
  if (!ok) return;
  const label = S.busy ? 'Sending…' : m.ok;
  if (ok.textContent !== label) ok.textContent = label;
  ok.disabled = !!m.locked || !!S.busy;
  const lockHtml = lockLine(m.locked);
  if (lockHost.dataset.html !== lockHtml) { lockHost.dataset.html = lockHtml; lockHost.innerHTML = lockHtml; }
  refreshLive();
}
// Tab inside an open sheet cycles through the sheet's controls and the E-STOP button (reachable by keyboard from it).
function trapFocus(e) {
  const host = $('dp-sheet-host'), sheet = host?.querySelector('.dp-sheet'); if (!sheet) return false;
  const list = [...sheet.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')].filter(el => !el.disabled && el.offsetParent !== null);
  const stop = $('dp-estop'); if (stop && !$('deploy-estop').hidden) list.push(stop);
  if (!list.length) return false;
  const i = list.indexOf(document.activeElement);
  const next = e.shiftKey ? (i <= 0 ? list.length - 1 : i - 1) : (i === -1 || i === list.length - 1 ? 0 : i + 1);
  e.preventDefault(); list[next].focus();
  return true;
}

// ------------------------------------------------------------------------------------------------ stage overlays
let lastCamKey = '';
function renderStage() {
  const el = $('deploy-stage'); if (!el || !S.visible) return;
  const mode = d3.cameraMode(), L = d3.layers();
  el.dataset.ready = S.readinessOpen ? 'open' : 'closed';
  const camKey = JSON.stringify([mode, !!d3.liveScenePose(), S.layersOpen, L]);
  if (camKey !== lastCamKey && !S.pointerHeld) { lastCamKey = camKey; renderCamera(mode, L); }
  renderBanners(); renderHud(); renderTicker(); renderTimeline(); renderLegend();
  updateInsets();
}
function renderCamera(mode, L) {
  $('dp-camera').innerHTML = `<button data-cam="frame" title="Frame robot, goal and the seen map (F)">Frame step</button><div class="segmented" role="group" aria-label="Camera">${[['orbit', 'Orbit'], ['follow', 'Follow'], ['top', 'Top']].map(([k, l]) => `<button data-cam="${k}" aria-pressed="${mode === k}" ${k === 'follow' && !d3.liveScenePose() ? 'disabled title="Follow needs a live robot"' : ''}>${l}</button>`).join('')}</div><button id="dp-layers-btn" aria-expanded="${S.layersOpen}" aria-controls="dp-layers">Layers</button>`;
  $('dp-camera').querySelectorAll('[data-cam]').forEach(b => b.addEventListener('click', () => cameraButton(b.dataset.cam)));
  $('dp-layers-btn').addEventListener('click', () => { S.layersOpen = !S.layersOpen; renderStage(); });
  $('dp-layers').hidden = !S.layersOpen;
  $('dp-layers').innerHTML = [['scan', 'Scan map', 'sw-ob', 'The scan\'s memory: what the goal check and the rehearsal use'], ['scanUnder', 'Scan map under the live map', 'sw-twin', 'While a session runs, the scan drawn as a grey ghost under the planner\'s memory'], ['live', 'Live map', 'sw-live', 'The planner\'s memory now (session)'], ['lidar', 'Lidar points', 'sw-pt', 'Last 1.5 s; grey and lavender points are ignored by the planner'], ['twin', 'Twin boxes', 'sw-twin', 'The rehearsal\'s simulated room'], ['robot', 'Robots', 'sw-bot', 'Live robot, scan pose, plan futures'], ['rehearsal', 'Rehearsal', 'sw-reh', 'The three rehearsal runs'], ['checks', 'Check anchors', 'sw-chk', 'Readiness items drawn in the scene'], ['cut', 'Cutaway', 'sw-cut', 'Columns between the camera and the robot are cut to 0.35 m so they never hide it']]
    .map(([k, l, sw, tip]) => `<label title="${escape(tip)}"><input type="checkbox" data-layer="${k}" ${(k === 'cut' ? d3.cutOn() : L[k]) ? 'checked' : ''}><i class="${sw}"></i>${escape(l)}</label>`).join('');
  $('dp-layers').querySelectorAll('[data-layer]').forEach(i => i.addEventListener('change', () => { d3.setLayer(i.dataset.layer, i.checked); lastCamKey = ''; }));
}
function renderBanners() {
  const el = $('dp-banners'); if (!el) return;
  const out = [], sess = session(), ls = S.view ? liveState() : null;
  renderLost(sess && ls);
  if (S.view && !d3.isAligned() && sess) out.push(['neutral', 'Not aligned yet: the robot\'s own frame only. The start check aligns it with the scan (it runs once the planner stands ready).']);
  if (S.lease.lost && S.step !== 'connect') out.push(['warning', `You lost the controls: ${S.lease.lost}. Take them again in Connect.`]);
  if (S.step === 'goal' && !S.goal && S.scene) out.push(['hint', 'Click the floor to place a goal · Esc cancels']);
  if (S.step !== 'goal' && S.hoverHint) out.push(['hint', S.hoverHint]);
  const key = JSON.stringify(out);
  if (key !== el.dataset.key) { el.dataset.key = key; el.innerHTML = out.map(([k, t]) => `<div class="dp-banner ${k}" role="${k === 'danger' ? 'alert' : 'status'}">${escape(t)}</div>`).join(''); updateInsets(); }
}
// The one LIVE VIEW LOST banner, at the bottom of the stage, with a red stage border; stale is a quiet line there.
function renderLost(ls) {
  const el = $('dp-lost'), stage = $('deploy-stage'); if (!el) return;
  const lost = ls === 'lost', stale = ls === 'stale', age = liveAge();
  stage.toggleAttribute('data-lost', lost);
  el.hidden = !lost && !stale;
  el.className = `dp-lost ${lost ? 'lost' : 'stale'}`;
  const text = lost ? `LIVE VIEW LOST ${Math.round(age)} s — the robot may still be walking · watch it · E-STOP above · physical E-stop`
    : stale ? `Live view ${age.toFixed(1)} s old` : '';
  if (el.textContent !== text) { el.textContent = text; updateInsets(); }
  if (lost && !S.lostFramed) { S.lostFramed = true; d3.ensureInView(d3.liveScenePose()); }
  if (!lost && !stale) S.lostFramed = false;
}
function hudItem(label, value, tone = '', big = false, tip = '') { return `<div class="dp-hud-item ${tone}${big ? ' big' : ''}" data-k="${escape(label.toLowerCase().replace(/\s+/g, '-'))}" ${tip ? `title="${escape(tip)}"` : ''}><span>${escape(label)}</span><strong>${value}</strong></div>`; }
// What drives the robot, in the operator's words (the console's own text is the tooltip). A remote D-pad set other than
// standing is called out: on 10-27 the boxing set was read as a planner pose.
function drivingWords(p) {
  if (!p) return { text: null, tone: '' };
  if (p.runner === 'E-STOP') return { text: 'E-STOP · runner safe mode', tone: 'bad' };
  const raw = String(p.driving ?? ''), key = p.driving_source ?? (/student/i.test(raw) ? 'student' : /recorded/i.test(raw) ? 'replay'
    : /SONIC planner/i.test(raw) ? 'sonic_planner' : /SONIC reference/i.test(raw) ? 'sonic_reference' : /Unitree/i.test(raw) ? 'unitree' : null);
  const set = p.motion_set ?? raw.match(/\(([^)]+?) set\)/)?.[1] ?? null;
  if (key === 'student') return walking() ? { text: 'Policy walking', tone: 'live' } : { text: 'Policy holding (standing)', tone: '' };
  if (key === 'replay') return { text: 'Recorded reference', tone: 'live' };
  if (key === 'sonic_planner') return set && set !== 'standing' ? { text: `SONIC · ${set} set (remote D-pad)`, tone: 'warn' } : { text: 'Standing (SONIC)', tone: '' };
  if (key === 'sonic_reference') return { text: 'Stand hold (policy off)', tone: '' };
  if (key === 'unitree') return { text: 'Unitree controller (not armed)', tone: '' };
  return { text: raw || null, tone: '' };
}
const ODOM_MODE = { fused: 'FAST-LIO + legs', zmq: 'FAST-LIO', lio: 'FAST-LIO', leg: 'Legs', dds: 'Simulator' };
// Every HUD value carries its own source's age: a fresh node view never makes the console panel's (or the service's)
// older facts look current. A value whose source is not fresh shows that source's age instead of the number.
function renderHud() {
  const el = $('dp-hud'); if (!el) return;
  const sess = session(), v = S.view, p = S.panel;
  if (!sess || !v) { if (el.innerHTML) { el.innerHTML = ''; updateInsets(); } return; }
  const ls = liveState();
  const val = (source, x, fmt) => {
    const s = srcState(source);
    if (s !== 'fresh') return `<em class="age">${s === 'unknown' ? 'no data' : `${escape(ageText(srcAge(source)))} old`}</em>`;
    return x === null || x === undefined ? '<em>Unavailable</em>' : fmt(x);
  };
  const tipOf = (source, extra = '') => `${extra ? `${extra} · ` : ''}from the ${SOURCES[source].label.toLowerCase()}, ${srcState(source) === 'unknown' ? 'no data yet' : `${ageText(srcAge(source))} old`}`;
  const item = (label, source, value, tone = '', big = false, extra = '') => hudItem(label, value, srcState(source) === 'fresh' ? tone : 'aged', big, tipOf(source, extra));
  const trail = S.poseTrail ?? [], hist = v.pose_hist ?? [];
  const speed = trail.length > 1 && trail.at(-1).t - trail[0].t >= 0.3 ? Math.hypot(trail.at(-1).x - trail[0].x, trail.at(-1).y - trail[0].y) / (trail.at(-1).t - trail[0].t)
    : hist.length > 1 ? Math.hypot(hist.at(-1)[1] - hist[0][1], hist.at(-1)[2] - hist[0][2]) / Math.max(0.05, hist.at(-1)[0] - hist[0][0]) : null;
  // The mode and the LIO age; the watchdog only when it is not "ok" (then in warn tone).
  const odom = v.odom ?? p?.odom ?? {}, wd = odom.watchdog && !['ok', 'off'].includes(odom.watchdog) ? odom.watchdog : null;
  const odomTone = odom.lost ? 'bad' : odom.doubt || wd ? 'warn' : '', mode = ODOM_MODE[odom.mode] ?? odom.mode ?? 'Unavailable';
  const odomText = odom.lost ? `LOST · ${odom.lost}` : odom.doubt ? `LIO doubt${wd ? ` · ${wd}` : ''}` : wd ? `${mode} · ${wd}`
    : `${mode}${finite(odom.lio_age_s) ? ` · LIO ${Math.round(odom.lio_age_s * 1000)} ms` : ''}`;
  const drive = drivingWords(p);
  const temp = p?.temps?.max_c, sonic = p?.standing_s, lidar = st().robot_link?.lidar_hz;
  el.innerHTML = [
    item('Driving', 'panel', val('panel', drive.text, x => escape(x)), drive.tone, true, p?.driving ? `the console: ${p.driving}` : ''),
    item('Phase', 'view', val('view', v.phase, x => escape(PHASE[x] ?? x))),
    item('To goal', 'view', val('view', v.goal_dist_m, x => `${x.toFixed(2)}<em>m</em>${odom.mode === 'leg' ? '<small>leg odometry under-counts 25-40 %</small>' : ''}`)),
    item('Speed', 'view', val('view', speed, x => `${x.toFixed(2)}<em>m/s</em>`)),
    item('Tilt', 'view', val('view', v.tilt_rad, x => `${(x * 180 / Math.PI).toFixed(1)}<em>°</em>`), finite(v.tilt_rad) && v.tilt_rad > 0.35 ? 'bad' : ''),
    item('Plan latency', 'view', val('view', v.latency_s, x => `${Math.round(x * 1000)}<em>ms</em>`), finite(v.latency_s) && v.latency_s > 0.3 ? 'warn' : ''),
    item('Odometry', 'view', val('view', odomText, x => escape(x)), odomTone),
    !isRobot() ? hudItem('Remote', '<span class="muted">not used in practice</span>') : item('Remote', 'panel', val('panel', p?.remote ? (p.remote.connected ? 'connected' : 'NOT CONNECTED') : null, x => escape(x)), p?.remote && !p.remote.connected ? 'bad' : ''),
    item('Motors', 'panel', val('panel', temp, x => `${x.toFixed(0)}<em>°C</em>${finite(sonic) ? `<small>${Math.floor(sonic / 60)} min on SONIC${sonic > SONIC_LONG_S ? ' · end the session between tries' : ''}</small>` : ''}`), finite(temp) && temp > 70 ? 'bad' : finite(temp) && temp > 60 || sonic > SONIC_LONG_S ? 'warn' : ''),
    isRobot() ? item('Lidar', srcState('lidar') === 'fresh' ? 'hub' : 'lidar', srcState('lidar') === 'fresh' ? val('hub', lidar, x => `${x.toFixed(1)}<em>Hz</em>`) : val('lidar', null, () => ''), finite(lidar) && lidar < 8 ? 'warn' : '') : '',
  ].join('');
  el.dataset.state = ls;
  updateInsets();
}
// The console's events in the operator's words: Studio's own echoes ("studio: g ok"), the lease heartbeat and goal
// sequence numbers are hidden unless the Console log is opened.
const quietLine = e => /\bstudio:\s*[\w-]+\s+ok\b/i.test(e) || /:\s*lease\b/i.test(e);
const plainLine = e => e.replace(/\bgoal\s+\d{5,}\b/gi, 'goal').replace(/\s*\(seq \d+\)/gi, '').replace(/\s{2,}/g, ' ').trim();
function renderTicker() {
  const el = $('dp-ticker'); if (!el || S.pointerHeld) return;
  const all = session() ? (S.panel?.events ?? []).map(e => String(e).trim()) : [];
  const lines = S.logAll ? all.slice(0, 12) : all.filter(e => !quietLine(e)).map(plainLine).slice(0, 4);
  el.hidden = !all.length;
  const key = JSON.stringify([lines, S.logAll]);
  if (key === el.dataset.key) return;
  el.dataset.key = key;
  el.innerHTML = `<li class="dp-ticker-head"><span>Console</span><button type="button" id="dp-log-toggle" aria-pressed="${!!S.logAll}">${S.logAll ? 'Fewer lines' : 'Console log'}</button></li>${lines.map(e => `<li>${escape(e)}</li>`).join('')}`;
  $('dp-log-toggle').addEventListener('click', () => { S.logAll = !S.logAll; el.dataset.key = ''; renderTicker(); updateInsets(); });
}
function renderTimeline() {
  const el = $('dp-timeline'); if (!el) return;
  const show = S.step === 'rehearse' && S.tracks && S.tracksSet === rehearsalFor()?.name && S.timeline.duration > 0;
  el.hidden = !show;
  if (!show) return;
  const t = S.timeline;
  el.innerHTML = `<button id="dp-tl-play" aria-label="${t.playing ? 'Pause' : 'Play'}">${t.playing ? '❚❚' : '▶'}</button>
    <input id="dp-tl" type="range" min="${t.t0 ?? 0}" max="${t.duration}" step="0.02" value="${t.t}" aria-label="Rehearsal time (from the first move)">
    <span>${(t.t - (t.t0 ?? 0)).toFixed(1)} / ${(t.duration - (t.t0 ?? 0)).toFixed(1)} s</span>
    <span class="dp-tl-key"><i style="--c:#3d6fb5"></i>exact<i style="--c:#c2408f"></i>injected drift<i style="--c:#7d8794"></i>offset</span>`;
  $('dp-tl-play').addEventListener('click', () => playTimeline(!S.timeline.playing));
  $('dp-tl').addEventListener('input', e => { playTimeline(false); S.timeline.t = Number(e.target.value); d3.setRehearsalTime(S.timeline.t); el.querySelector('span').textContent = `${(S.timeline.t - (t.t0 ?? 0)).toFixed(1)} / ${(t.duration - (t.t0 ?? 0)).toFixed(1)} s`; });
}
function playTimeline(on) {
  const t = S.timeline; t.playing = on; cancelAnimationFrame(t.raf);
  if (on) {
    if (t.t >= t.duration - 0.05) t.t = t.t0 ?? 0;
    let last = performance.now();
    const loop = now => {
      if (!S.timeline.playing) return;
      t.t = Math.min(t.duration, t.t + (now - last) / 1000); last = now;
      d3.setRehearsalTime(t.t);
      const range = $('dp-tl'); if (range) { range.value = String(t.t); range.nextElementSibling.textContent = `${(t.t - (t.t0 ?? 0)).toFixed(1)} / ${(t.duration - (t.t0 ?? 0)).toFixed(1)} s`; }
      if (t.t >= t.duration) { t.playing = false; renderTimeline(); return; }
      t.raf = requestAnimationFrame(loop);
    };
    t.raf = requestAnimationFrame(loop);
  }
  renderTimeline();
}
function renderLegend() {
  const el = $('dp-legend'); if (!el) return;
  const live = !!S.view;
  el.innerHTML = `<span><i class="sw-ob"></i>Obstacle (by height)</span><span><i class="sw-st"></i>Step-over</span><span><i class="sw-oh"></i>Overhead</span><span><i class="sw-floor"></i>Seen floor</span>${live || S.scanLive?.running ? '<span><i class="sw-pt"></i>Lidar</span><span><i class="sw-ign"></i>Ignored by the planner</span>' : ''}${S.goal ? '<span><i class="sw-route"></i>Route check (Studio)</span>' : ''}${live && (S.view?.route?.length || S.view?.plan?.path?.length) ? '<span><i class="sw-plan"></i>Planner\'s live route</span><span><i class="sw-future"></i>Plan, next 2 s</span>' : ''}${d3.hasTrail() ? '<span><i class="sw-walked"></i>Walked</span>' : ''}${live && d3.liveCounts()?.near ? '<span><i class="sw-near"></i>Near the robot\'s body (ignored)</span>' : ''}`;
}
// The overlays' footprint on the canvas: the camera centres the free area (deploy3d.setInsets).
function updateInsets() {
  const shell = $('viewport-shell'); if (!shell || !S.visible) return;
  const box = shell.getBoundingClientRect(), rect = id => $(id)?.offsetParent ? $(id).getBoundingClientRect() : null;
  const top = Math.max(rect('dp-top')?.bottom ?? box.top, rect('dp-banners')?.bottom ?? box.top) - box.top;
  const hud = rect('dp-bottom'), bottom = hud ? box.bottom - hud.top : 0;
  const ready = rect('dp-readiness'), left = ready && S.readinessOpen ? ready.right - box.left : 0;
  if (ready) $('deploy-stage').style.setProperty('--dp-ready-right', `${Math.round(ready.right - box.left)}px`);
  d3.setInsets({ top: Math.max(0, top), bottom: Math.max(0, bottom), left: Math.max(0, left), right: 0 });
}

// ------------------------------------------------------------------------------------------------ readiness
function measurable(c) {
  const sess = session(), p = S.panel, ladder = Object.fromEntries((p?.ladder ?? []).map(l => [l.key, l.state]));
  switch (c.measurable_after) {
    case 'connect': return S.stateOk === true;
    case 'scan': return !!S.scanName;
    case 'session': return !!sess;
    case 'arm': return !!sess && ladder.arm === 'done';
    case 'node': return !!S.view && !!S.view.phase && S.view.phase !== 'BOOT';
    case 'goal': return !!S.sendResult?.ok || !!S.startCheck;
    case 'rehearsal': return !!rehearsalFor()?.verdict;
    default: return true;
  }
}
function checkShown(c) {
  const stale = finite(c.at) && finite(c.max_age_s) && nowS() - c.at > c.max_age_s;
  if (c.status === 'unknown' && !measurable(c)) return { status: 'later', text: AFTER[c.measurable_after] ?? 'later' };
  if (stale) return { status: 'unknown', text: `UNKNOWN · ${Math.round(nowS() - c.at)} s old` };
  return { status: c.status, text: c.status === 'unknown' ? 'UNKNOWN' : null };
}
const anchoredChecks = () => (S.readiness ?? []).filter(c => c.anchor).map(c => ({ id: c.id, status: checkShown(c).status, anchor: c.anchor, label: c.label }));
function renderReadiness() {
  const el = $('dp-readiness'); if (!el || !S.visible || S.pointerHeld) return;
  const checks = S.readiness ?? [], shown = checks.map(c => ({ c, s: checkShown(c) }));
  const count = k => shown.filter(x => x.s.status === k).length;
  const old = S.readinessAt ? (performance.now() - S.readinessAt) / 1000 : 0;
  const summary = `${count('pass')} ✓ · ${count('warn')} ! · ${count('block')} ✕ · ${count('later')} later${old > 6 ? ` (last seen ${Math.round(old)} s ago)` : ''}`;
  el.dataset.open = String(S.readinessOpen);
  el.innerHTML = `<button class="dp-ready-head" id="dp-ready-toggle" aria-expanded="${S.readinessOpen}"><strong>Readiness</strong><span class="${count('block') ? 'block' : count('warn') ? 'warn' : 'pass'}">${checks.length ? summary : 'waiting for the service'}</span><i aria-hidden="true">${S.readinessOpen ? '‹' : '›'}</i></button>
    ${S.readinessOpen ? `<div class="dp-ready-body">${GROUPS.map(([g, label]) => {
      const rows = shown.filter(x => x.c.group === g); if (!rows.length) return '';
      return `<section><h5>${label}</h5><ul>${rows.map(({ c, s }) => `<li class="${s.status}${S.highlight === c.id ? ' hl' : ''}" ${c.anchor ? `data-anchor="${escape(c.id)}" tabindex="0" role="button" title="Show it in 3D"` : ''}>${statusIcon(s.status)}<div><strong>${escape(c.label)}</strong>${s.status === 'later' ? '' : evChip(c.evidence)}<small>${escape(s.text ?? c.detail ?? '')}${c.fix?.hint && ['warn', 'block'].includes(s.status) ? ` · ${escape(c.fix.hint)}` : ''}</small></div>${c.anchor ? '<b class="dp-locate" aria-hidden="true">⌖</b>' : ''}</li>`).join('')}</ul></section>`;
    }).join('')}<p class="tiny">Grey items are measured later in the journey; they are not passes. Click an item with ⌖ to see it in 3D.</p></div>` : ''}`;
  $('dp-ready-toggle').addEventListener('click', () => { S.readinessOpen = !S.readinessOpen; store.set('readiness', S.readinessOpen ? '1' : '0'); renderReadiness(); updateInsets(); });
  el.querySelectorAll('[data-anchor]').forEach(li => {
    const go = () => {
      const c = checks.find(x => x.id === li.dataset.anchor); S.highlight = c.id; d3.setAnchors(anchoredChecks(), c.id); d3.flyToAnchor(c.anchor); renderReadiness();
      clearTimeout(S.highlightTimer); S.highlightTimer = setTimeout(() => { if (S.highlight === c.id) { S.highlight = null; d3.setAnchors(anchoredChecks(), null); renderReadiness(); } }, 8000);
    };
    li.addEventListener('click', go); li.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
  });
}

// ------------------------------------------------------------------------------------------------ pointer: goal picking
let pointerDown = null, hoverRaf = 0, hoverAt = null;
function bindPointer() {
  const canvas = $('viewport').querySelector('canvas'); if (!canvas || canvas.dataset.deployBound) return;
  canvas.dataset.deployBound = '1';
  canvas.addEventListener('pointerdown', e => { if (S.visible) pointerDown = [e.clientX, e.clientY]; });
  canvas.addEventListener('pointermove', e => {
    if (!S.visible || e.buttons) return;
    if (S.clickAt && Math.hypot(e.clientX - S.clickAt[0], e.clientY - S.clickAt[1]) < 6) return;
    S.clickAt = null;
    hoverAt = [e.clientX, e.clientY];
    if (!hoverRaf) hoverRaf = requestAnimationFrame(() => { hoverRaf = 0; hover(hoverAt); });
  });
  canvas.addEventListener('pointerleave', () => { if (S.visible) { S.hover = null; d3.setHover(null); const tip = $('dp-hover-tip'); if (tip) tip.hidden = true; } });
  canvas.addEventListener('pointerup', e => {
    if (!S.visible || !pointerDown || Math.hypot(e.clientX - pointerDown[0], e.clientY - pointerDown[1]) > 5) { pointerDown = null; return; }
    pointerDown = null;
    if (S.step !== 'goal' || S.sheet) return;
    if (!S.scene) return;
    const hit = d3.pickAt(e.clientX, e.clientY); if (!hit) return;
    cancelAnimationFrame(hoverRaf); hoverRaf = 0;
    const tip = $('dp-hover-tip'); if (tip) tip.hidden = true;
    S.hover = null; d3.setHover(null); S.clickAt = [e.clientX, e.clientY];
    const quick = d3.quickCheck(d3.scanLookup(), hit.xy);
    checkGoal(hit.xy).then(() => { if (S.goal) S.goal.quick = quick; });
  });
}
function hover(at) {
  if (S.step !== 'goal' || S.sheet || !S.scene) { if (S.hover) { S.hover = null; d3.setHover(null); } const tip = $('dp-hover-tip'); if (tip) tip.hidden = true; return; }
  const hit = d3.pickAt(at[0], at[1]);
  if (!hit) { S.hover = null; d3.setHover(null); return; }
  const q = d3.quickCheck(d3.scanLookup(), hit.xy);
  S.hover = { xy: hit.xy, status: q.status, text: q.text, columnTop: hit.hit === 'column' ? hit.columnTop : null };
  d3.setHover(S.hover);
  const tip = $('dp-hover-tip');
  if (tip) {
    tip.hidden = false; tip.textContent = q.text; tip.dataset.status = q.status;
    // Beside the pointer, flipped to the left near the stage's right edge.
    const box = $('viewport-shell').getBoundingClientRect(), w = tip.offsetWidth, x = at[0] - box.left, y = at[1] - box.top;
    tip.style.transform = `translate(${x + 16 + w > box.width - 8 ? Math.max(8, x - 16 - w) : x + 16}px, ${y + 14}px)`;
  }
}

// ------------------------------------------------------------------------------------------------ keyboard
// F frames the step, T top view; Escape cancels a pick or closes a sheet. No shortcut for GO or E-STOP.
export function handleKey(e) {
  if (!S.visible) return false;
  if (e.key === 'Tab' && S.sheet && !e.ctrlKey && !e.metaKey && !e.altKey) return trapFocus(e);
  if (e.key === 'Escape') {
    if (S.sheet) { e.preventDefault(); closeSheet(); return true; }
    if (S.hover || S.step === 'goal') { S.hover = null; d3.setHover(null); const tip = $('dp-hover-tip'); if (tip) tip.hidden = true; return true; }
    if (S.layersOpen) { S.layersOpen = false; renderStage(); return true; }
    return false;
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (e.key === 'f') { frameStep(); return true; }
  if (e.key === 't') { cameraButton('top'); return true; }
  if (e.key === 'o') { cameraButton('orbit'); return true; }
  return e.key !== '?';  // the other Replay shortcuts (Space, arrows, layers) do nothing here
}

// ------------------------------------------------------------------------------------------------ the 3D tick
// Point fade steps and LIVE VIEW LOST age the label at most 4 times a second, never per frame.
let uiTimer = 0;
function uiTick() {
  clearTimeout(uiTimer);
  if (!S.visible) return;
  d3.stepFade();
  if (S.view && session()) {
    const ls = liveState();
    if (ls === 'lost') d3.setLost(true, liveAge());
    renderBanners(); renderHud();
    if (ls !== S.lastLiveState) { S.lastLiveState = ls; renderPanel(); }
  }
  // Freshness: the lock texts age in place; a source crossing its threshold re-renders the panel (its key changes).
  renderPanel(); renderSheet(); renderBar(); updateSources(); refreshLive();
  maybeRecheckGoal();
  if (S.clearedAt && performance.now() - S.clearedAt < 11000) renderPanel();
  if (S.readinessAt && performance.now() - S.readinessAt > 6000 && Math.floor(performance.now() / 1000) !== S.readinessTick) { S.readinessTick = Math.floor(performance.now() / 1000); renderReadiness(); }
  // The scan ghost vs robot now: shown once a session is aligned with the scan.
  const sc = S.startCheck, sess = session(), ghost = [!!(sess && d3.isAligned()), sc ? `moved ${num(sc.moved_m, 2)} m, turned ${num(sc.turned_deg, 0)}°` : null];
  const poseRobot = !S.view && !S.scanLive?.running;
  const ghostKey = JSON.stringify([ghost, poseRobot, d3.hasModel(), S.step]);
  if (ghostKey !== S.ghostKey) { S.ghostKey = ghostKey; d3.setScanGhost(...ghost); d3.setScanPoseRobot(poseRobot); }
  uiTimer = setTimeout(uiTick, 250);
}

// ------------------------------------------------------------------------------------------------ model
async function loadModel() {
  if (d3.hasModel()) return;
  let r = await api('/api/deploy/model', { timeout: 6000 });
  if (r.ok && (r.data.spec?.root || r.data.root)) { d3.setModel(r.data.spec ?? r.data); return; }
  // Until the gateway serves /api/deploy/model: the same g1 29-DoF model from a recording in Studio's catalog.
  const list = (S.ctx.sessions?.() ?? []).filter(s => s.available);
  const ranked = [...list.filter(s => /robot|console/i.test(s.group ?? '')), ...list.filter(s => /^rd1024|lockstep/.test(s.id)), ...list].slice(0, 6);
  for (const s of ranked) {
    r = await api(`/api/model?id=${encodeURIComponent(s.id)}`, { timeout: 6000 });
    if (r.ok && r.data.nq === 36 && r.data.root) { d3.setModel(r.data); return; }
  }
}

// ------------------------------------------------------------------------------------------------ lifecycle
const STAGE_HTML = `
  <div class="dp-top" id="dp-top"><nav class="dp-strip" id="dp-strip" aria-label="Deploy steps"></nav><div class="dp-camera" id="dp-camera" role="toolbar" aria-label="Camera and layers"></div></div>
  <div class="dp-layers" id="dp-layers" hidden></div>
  <div class="dp-banners" id="dp-banners" aria-live="polite"></div>
  <aside class="dp-readiness" id="dp-readiness" aria-label="Readiness"></aside>
  <div class="dp-bottom" id="dp-bottom"><div class="dp-lost" id="dp-lost" role="alert" hidden></div><div class="dp-timeline" id="dp-timeline" hidden></div><div class="dp-hud" id="dp-hud" aria-live="off"></div><div class="dp-side"><ol class="dp-ticker" id="dp-ticker" aria-label="Console events" hidden></ol><div class="dp-legend" id="dp-legend"></div></div></div>
  <div class="dp-hover-tip" id="dp-hover-tip" hidden></div>`;
export function initDeploy(ctx) {
  S.ctx = ctx;
  d3.init();
  $('deploy-stage').innerHTML = STAGE_HTML;
  $('deploy-panel').innerHTML = '<div id="dp-identity" class="dp-identity" aria-label="The running session" role="region"></div><div id="dp-panel-content" class="dp-panel-content"></div><div id="dp-sheet-host"></div>';
  // A Review link (?workspace=deploy&session=<name>&attempt=<n>) opens that session's Review, in any browser.
  const url = new URLSearchParams(location.search);
  if (url.get('workspace') === 'deploy' && url.get('session')) {
    S.step = 'review'; S.reviewName = url.get('session');
    const n = Number(url.get('attempt')); S.reviewAttempt = Number.isInteger(n) && n > 0 ? n : null;
  }
  // While a pointer is pressed on Deploy's controls, polls never replace the element under it.
  for (const id of ['deploy-panel', 'deploy-stage']) $(id).addEventListener('pointerdown', e => { if (e.target.closest('button, input, select, label')) S.pointerHeld = true; });
  window.addEventListener('pointerup', () => { if (S.pointerHeld) { S.pointerHeld = false; setTimeout(() => { renderPanel(); renderSheet(); renderStage(); }, 0); } }, true);
  window.addEventListener('pointercancel', () => { S.pointerHeld = false; }, true);
  for (const p of Object.values(pollers)) p.start(p === pollers.state ? 0 : 300);
  api('/api/version', { timeout: 4000 }).then(r => { if (r.ok) { S.studioVersion = r.data; renderPanel(); } });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    S.returnedAt = performance.now();   // a tab coming back treats every source as stale until it arrives again
    if (S.lease.id) pollers.lease.start(0);
    for (const p of Object.values(pollers)) p.start(0);
    renderAll();
  });
  window.addEventListener('beforeunload', () => releaseLease());
  window.__deploy = { S, d3: d3.d3, estop, setStep, checkGoal, project: d3.project, pickAt: d3.pickAt, frameStep,
    fn: { session, ident, isRobot, attached, rehearsalFor, ladderRows, sheetModel, liveState, liveAge, srcState, srcAge, freshLock, renderAll, reviewBody, goalStatus } };
}
// The service answers the v1 API: Studio opens on Deploy (app.js).
export async function probe() {
  const r = await api('/api/deploy/state', { timeout: 1500 });
  if (r.ok && r.data.api) { S.state = r.data; S.stateOk = true; S.everOk = true; emit('deploy:service', true); return true; }
  return false;
}
export async function enter() {
  S.visible = true;
  d3.enter();
  bindPointer();
  if (S.state) onState(S.state, false);
  if (S.scanName && !S.scene) selectScan(S.scanName, false);
  syncReviewUrl();
  // The last goal on this scan comes back (the user's, never made up).
  if (!S.goal) { try { const g = JSON.parse(store.get('goal', 'null')); if (g?.scan === S.scanName && Array.isArray(g.xy)) checkGoal(g.xy); } catch { /* none */ } }
  renderAll();
  const cam = store.get('camera', 'orbit');
  d3.setCameraMode(['orbit', 'top'].includes(cam) ? cam : 'orbit');
  requestAnimationFrame(() => { updateInsets(); frameStep(true); });
  uiTick();
  for (const p of Object.values(pollers)) p.start(0);
  await loadModel();
  d3.setScanPoseRobot(!S.view && !S.scanLive?.running);
}
export function leave() {
  S.visible = false; clearTimeout(uiTimer); playTimeline(false);
  S.sheet = null; renderSheet();
  d3.setHover(null); d3.leave();
  renderBar();
}
export const isVisible = () => S.visible;
