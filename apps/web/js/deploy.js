// Deploy workspace: connect, scan, pick a goal, rehearse, deploy and review, in 3D (docs/DEPLOY.md).
//
// Studio relays an operator's press to the deploy kit's console, which owns the robot. Every motor gate stays in the
// console and the hub; this page never makes a press up and never retries one, except E-STOP. Data comes from the
// gateway's /api/deploy/* passthrough of the kit's deploy service (API v1).
//
// Polling (docs/DEPLOY.md, Browser): state 1 Hz, live view 5 Hz with cloud/memory cursors, scan live 2 Hz while a scan
// runs, panel state 2.5 Hz while a session is live; one request in flight per poller, aborted at 1.5 s, at most three
// polls in flight. E-STOP aborts every fetch first, then posts and retries every 300 ms until every console answers.
import { $, escape, num, finite, emit } from './util.js';
import * as d3 from './deploy3d.js';

const STEPS = [
  { id: 'connect', label: 'Connect' }, { id: 'scan', label: 'Scan' }, { id: 'goal', label: 'Goal' },
  { id: 'rehearse', label: 'Rehearse' }, { id: 'deploy', label: 'Deploy' }, { id: 'review', label: 'Review' },
];
const SCAN_FRESH_S = 15 * 60, STALE_S = 1, LOST_S = 3, ESTOP_GIVE_UP_MS = 10000, SONIC_LONG_S = 8 * 60;
const ODOMETRY = {
  fused: { label: 'FAST-LIO + legs', note: 'Fused: LIO corrects, legs and IMU predict; LIO doubt stops the walk.' },
  leg: { label: 'Legs only', note: 'No lidar odometry: distance is under-counted by 25-40 %.' },
  zmq: { label: 'FAST-LIO only', note: 'The LIO pose alone, through the bridge.' },
};
const CONFIRM = [
  ['gantry', 'The gantry (or a spotter on the rope) carries the robot\'s weight'],
  ['estop', 'The physical E-stop was tested today and is in reach'],
  ['remote', 'The remote holder is briefed: only Select (E-STOP) and D-up (stand)'],
  ['rope', 'The rope is held high, above 1.6 m, out of the lidar\'s view'],
];
const TAGS = ['clean', 'touched', 'stumble', 'caught', 'aborted', 'setup issue'];
const PHASE = { BOOT: 'Starting the planner', WAIT: 'Standing · ready', PRESCAN: 'Pre-scan', RUN: 'Walking', ARRIVED: 'Arrived · standing', STOPPED: 'Stopped · standing' };
const ICON = { pass: '✓', warn: '!', block: '✕', unknown: '?', later: '·', done: '✓', now: '›', todo: '' };
const GROUPS = [['link', 'Link'], ['robot', 'Robot'], ['perception', 'Perception'], ['scene', 'Scene'], ['operator', 'Operator']];
const AFTER = { connect: 'after Connect', scan: 'after the scan', session: 'after Start session', arm: 'after Arm', node: 'once the planner is up', goal: 'after Send goal', rehearsal: 'after the rehearsal' };

const store = {
  get(k, d = null) { try { return localStorage.getItem(`studio.deploy.${k}`) ?? d; } catch { return d; } },
  set(k, v) { try { if (v === null) localStorage.removeItem(`studio.deploy.${k}`); else localStorage.setItem(`studio.deploy.${k}`, String(v)); } catch { /* optional */ } },
};
const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`);
const nowS = () => Date.now() / 1000;

export const S = {
  ctx: null, visible: false, step: store.get('step', 'connect'),
  state: null, stateAt: 0, stateOk: null, everOk: false, stateError: null, cachedLive: false,
  readiness: null, mode: store.get('mode', 'practice'), operator: store.get('operator', ''), profile: store.get('profile', null),
  odom: store.get('odom', null), seconds: 8, scanName: store.get('scan', null), scene: null, sceneLoading: null,
  pendingScan: null, scanLive: null,
  goal: null, hover: null, pickToken: 0,
  rehearsalName: null, tracks: null, tracksFor: null, timeline: { t: 0, playing: false, duration: 0, raf: 0 },
  view: null, viewAt: -Infinity, viewSlot: null, viewStaleUntilFresh: false, cursors: { cloud: -1, mem: -1 }, panel: null, panelAt: 0,
  lease: { id: null, holder: null, until: 0, supported: null, lost: null, conflict: null },
  estop: { state: null, targets: [], t0: 0, error: null },
  sheet: null, busy: null, notice: null, ladderNote: {}, sendResult: null, goResult: null, attempts: {}, tagDraft: {},
  reviewName: null, manifest: null, manifestFor: null, readinessOpen: store.get('readiness', innerWidth >= 1560 ? '1' : '0') === '1',
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
const reason = r => r.data?.reason || r.data?.error || (r.status ? `refused (${r.status})` : 'no answer');

// One request per poller, at most three polls in flight; a poller whose turn is taken tries again shortly.
class Poller {
  constructor(name, everyMs, run, enabled) { Object.assign(this, { name, everyMs, run, enabled, busy: false, timer: 0 }); }
  start(delay = 0) { clearTimeout(this.timer); this.timer = setTimeout(() => this.tick(), delay); }
  async tick() {
    if (!this.enabled()) return this.start(Math.max(this.everyMs, 500));
    if (this.busy || pollsInFlight >= 3 || S.estop.state === 'sending') return this.start(100);
    this.busy = true; pollsInFlight++;
    const t0 = performance.now();
    try { await this.run(); } catch (error) { console.warn(`deploy ${this.name} poll`, error); }
    finally { this.busy = false; pollsInFlight--; }
    this.start(Math.max(0, this.everyMs - (performance.now() - t0)));
  }
}

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
const rehearsalRunning = () => (st().rehearsals ?? []).find(r => r.running) ?? null;
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
const profileName = () => S.profile ?? st().default_profile ?? profiles()[0]?.name ?? null;
const profileLabel = name => profiles().find(p => p.name === name)?.label ?? name ?? 'Unavailable';
const odomName = () => S.odom ?? (st().robot_link?.lio_bridge ? 'fused' : 'leg');
const isRobot = () => S.mode === 'robot';
const holdsLease = () => S.lease.supported === false ? !!S.operator.trim() : !!S.lease.id && !S.lease.lost;
function goalStatus(check = S.goal?.check) {
  if (!check) return 'pending';
  if (check.unavailable) return 'pending';
  if (check.ok === false) return 'block';
  return (check.checks ?? []).some(c => c.status === 'warn') ? 'warn' : 'pass';
}
const goalUsable = () => !!S.goal?.check?.check_id && S.goal.check.scan === S.scanName && goalStatus() !== 'block';
// The rehearsal set for this scan, goal and profile (newest first).
function rehearsalFor() {
  if (!S.goal?.xy) return null;
  const list = (st().rehearsals ?? []).filter(r => r.scan === S.scanName && (r.profile ?? profileName()) === profileName()
    && Array.isArray(r.goal_scene) && Math.hypot(r.goal_scene[0] - S.goal.xy[0], r.goal_scene[1] - S.goal.xy[1]) < 0.08);
  return list.at(-1) ?? null;
}
function liveAge() {
  if (!S.view) return Infinity;
  const age = (S.view.served_age_s ?? 0) + (performance.now() - S.viewAt) / 1000;
  return S.viewStaleUntilFresh ? Math.max(age, STALE_S + 0.01) : age;
}
const liveState = () => { const a = liveAge(); return a > LOST_S ? 'lost' : a > STALE_S ? 'stale' : 'fresh'; };
const walking = () => ['PRESCAN', 'RUN'].includes(S.panel?.phase ?? S.view?.phase);
const panelAttempts = () => (Array.isArray(S.panel?.attempts) ? S.panel.attempts : []);

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
      const rec = rehearsalFor(), anyOld = (st().rehearsals ?? []).some(r => r.scan === S.scanName && r.verdict);
      return { done: !!rec?.verdict, stale: !rec && anyOld && S.goal ? 'Rehearsal: for another goal or profile' : null };
    }
    case 'deploy': return { done: panelAttempts().some(a => a.outcome) || (!sess && Object.values(S.attempts).some(l => l.some(a => a.outcome))) };
    default: return { done: false };
  }
}

// ------------------------------------------------------------------------------------------------ polling
const pollers = {
  state: new Poller('state', 1000, pollState, () => S.visible || S.everOk || S.cachedLive),
  readiness: new Poller('readiness', 2000, pollReadiness, () => S.visible && S.stateOk),
  scanLive: new Poller('scan', 500, pollScanLive, () => S.visible && (st().scan_job?.running || !!S.pendingScan)),
  live: new Poller('live', 200, pollLive, () => S.visible && !!viewSlot()),
  panel: new Poller('panel', 400, pollPanel, () => S.visible && !!session()),
  lease: new Poller('lease', 1000, renewLease, () => !!S.lease.id && !document.hidden),
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
    S.state = r.data; S.stateAt = performance.now(); S.stateOk = true; S.everOk = true; S.stateError = null; S.cachedLive = false;
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
      const name = S.pendingScan; S.pendingScan = null; S.pendingSeen = false; S.scanLive = null;
      if (scanRow(name)) { S.scene = null; selectScan(name, true); }
    }
  }
  // Session started or ended.
  const sess = session(), name = sess?.name ?? null;
  if (name !== S.sessionName) {
    if (S.sessionName && !name) { S.reviewName = S.sessionName; d3.clearLive(); S.view = null; S.panel = null; }
    if (name) { d3.clearTrail(); S.cursors = { cloud: -1, mem: -1 }; S.view = null; S.sendResult = null; S.goResult = null; S.startCheck = null; S.autoCheckKey = null; S.clearedAt = null; S.ladderNote = {}; if (S.estop.state !== 'sending') S.estop = { state: null, targets: [], t0: 0, error: null }; }
    S.sessionName = name;
  }
  if (!viewSlot() && S.view) { S.view = null; d3.clearLive(); }
  // A rehearsal set finished: load its tracks.
  const rec = rehearsalFor();
  if (rec?.verdict && S.tracksFor !== rec.name) loadTracks(rec);
  if (!rec && S.tracksFor) { S.tracksFor = null; S.tracks = null; d3.setRehearsal(null); }
}

async function pollReadiness() {
  const sess = session(), q = new URLSearchParams();
  if (S.scanName) q.set('scan', S.scanName);
  q.set('slot', sess?.slot ?? (isRobot() ? 'robot' : 'sim'));
  const r = await api(`/api/deploy/readiness?${q}`);
  if (r.ok && Array.isArray(r.data.checks)) {
    S.readiness = r.data.checks; renderReadiness();
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
  S.view = { ...v, memEpoch: v.memory?.epoch ?? S.view?.memEpoch, slot }; S.viewAt = performance.now(); S.viewStaleUntilFresh = false; S.viewSlot = slot;
  if (Array.isArray(v.qpos) && Number.isFinite(v.t_mono)) {
    const h = S.poseTrail = (S.poseTrail ?? []).filter(e => e.slot === slot && v.t_mono - e.t < 1.2 && e.t < v.t_mono);
    h.push({ t: v.t_mono, x: v.qpos[0], y: v.qpos[1], slot });
  }
  // A rehearsal's drift run is never drawn in the scene (its estimate is in the drifted frame).
  const rec = rehearsalRunning(), which = rec?.running, rehearsal = slot === 'sim' && !session();
  await d3.setLive(v, { slot: rehearsal ? 'sim-rehearsal' : slot, hideRobot: rehearsal && which === 'drift',
    label: rehearsal && which !== 'drift' ? `REHEARSAL · ${which} run (its own estimate)` : null });
  d3.setLost(false);
  if (S.visible) { renderHud(); renderBanners(); maybeStartCheck(); }
}

async function pollPanel() {
  const sess = session(); if (!sess) return;
  if (S.panelGone?.name === sess.name && performance.now() - S.panelGone.at < 3000) return;
  const r = await api(`/api/deploy/panel?slot=${sess.slot}`);
  if (r.status === 404) { S.panelGone = { name: sess.name, at: performance.now() }; return; }
  if (!r.ok) return;
  S.panel = r.data; S.panelAt = performance.now();
  if (Array.isArray(r.data.attempts)) S.attempts[sess.name] = r.data.attempts;
  if (S.visible) { renderPanel(); renderHud(); renderTicker(); renderStrip(); }
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
// One press, relayed once. The reply (done / refused + reason) is shown where the press was made.
async function act(name, body = {}, { slot = session()?.slot, timeout = 9000 } = {}) {
  const payload = { act: name, ...(slot ? { slot } : {}), id: uuid(), operator: S.operator.trim() || undefined, ...body };
  if (S.lease.id) payload.lease_id = S.lease.id;
  S.busy = name; renderAll();
  const r = await api('/api/deploy/act', { method: 'POST', body: payload, csrf: true, timeout });
  S.busy = null;
  const ok = r.ok && r.data.ok !== false && r.data.result !== 'refused';
  return { ok, r, data: r.data, reason: ok ? null : reason(r) };
}
function expectNow(fields) {
  const sess = session(), out = {};
  if (fields.includes('session') && sess) out.session = sess.name;
  if (fields.includes('runner') && S.panel?.runner) out.runner = S.panel.runner;
  if (fields.includes('attempts') && S.panel) out.attempts = panelAttempts().length;
  if (fields.includes('goal_seq') && finite(S.view?.goal_seq)) out.goal_seq = S.view.goal_seq;
  return out;
}

async function startScan() {
  const seconds = Math.max(3, Math.min(30, Number(S.seconds) || 8));
  const body = isRobot() ? { seconds } : { seconds, ...(baseScan() ? { scan: baseScan() } : {}) };
  const res = await act(isRobot() ? 'scan' : 'practice_scan', body, { slot: null });
  if (res.ok) { S.pendingScan = res.data.name ?? null; S.pendingScanAt = performance.now(); S.scanLive = null; pollers.scanLive.start(200); }
  S.notice = res.ok ? null : { kind: 'warning', text: `Scan refused: ${res.reason}` };
  renderAll();
}
const baseScan = () => scans().find(s => !s.practice && !s.name.startsWith('practice-'))?.name ?? S.scanName;

async function runRehearsal() {
  const res = await act('rehearse', { scan: S.scanName, goal_scene: S.goal.xy, profile: profileName(), odom: odomName() }, { slot: null });
  S.notice = res.ok ? null : { kind: 'warning', text: `Rehearsal refused: ${res.reason}` };
  if (res.ok) { S.rehearsalName = res.data.name; S.tracks = null; S.tracksFor = null; d3.setRehearsal(null); }
  pollState(); renderAll();
}
async function loadTracks(rec) {
  S.tracksFor = rec.name;
  const runs = rec.runs ?? {}, out = {};
  await Promise.all(Object.entries(runs).map(async ([which, name]) => {
    const r = await api(`/api/deploy/rehearsal/track?name=${encodeURIComponent(name)}`, { timeout: 6000 });
    if (r.ok && !r.data.running) out[which] = r.data;
  }));
  if (S.tracksFor !== rec.name) return;
  S.tracks = out;
  const duration = await d3.setRehearsal(out);
  S.timeline = { ...S.timeline, t: duration, duration, playing: false };
  applyContext(); d3.setScanPoseRobot(!S.view && !S.scanLive?.running);
  renderAll();
}

async function startSession(confirm) {
  const body = { mode: isRobot() ? 'robot' : 'sim', practice: !isRobot(), scan: S.scanName, profile: profileName(), odom: odomName(),
    operator: S.operator.trim(), confirm };
  const res = await act('start', body, { slot: null, timeout: 15000 });
  if (res.ok) { closeSheet(); S.notice = null; S.ladderNote = {}; } else S.sheetError = res.reason;
  await pollState(); renderAll();
}
async function ladderAct(key) {
  const sess = session(); if (!sess) return;
  const map = { arm: ['arm', ['session']], sonic: ['s', ['session', 'runner']], map: ['c', ['session']] };
  const [name, fields] = map[key];
  const res = await act(name, { expect: expectNow(fields) });
  S.ladderNote[key] = res.ok ? { kind: 'ok', text: { arm: 'Armed: the planner node is starting.', sonic: 'SONIC is in CONTROL.', map: 'Map cleared: the robot rescans for 10 s.' }[key] }
    : { kind: 'warning', text: `Refused by the console: ${res.reason}` };
  if (key === 'map' && res.ok) { S.clearedAt = performance.now(); S.autoCheckKey = null; S.cursors.mem = -1; }
  closeSheet(); pollPanel(); renderAll();
}
async function sendGoal() {
  const sess = session(); if (!sess || !goalUsable()) return;
  const res = await act('send_goal', { scan: S.scanName, goal_scene: S.goal.xy, check_id: S.goal.check.check_id, expect: expectNow(['session']) }, { timeout: 12000 });
  S.sendResult = { ok: res.ok, text: res.ok ? null : res.reason, check: res.data.check ?? null, goalOdom: res.data.goal_odom ?? null, at: Date.now(), goal: [...S.goal.xy] };
  if (res.data.check) applyStartCheck(res.data.check);
  pollPanel(); renderAll();
}
async function go() {
  const sess = session(); if (!sess) return;
  const res = await act('g', { expect: expectNow(['session', 'runner', 'attempts', 'goal_seq']) });
  S.goResult = { ok: res.ok, text: res.ok ? null : res.reason, at: Date.now() };
  if (res.ok) closeSheet(); else S.sheetError = `Refused by the console: ${res.reason}`;
  pollPanel(); renderAll();
}
async function stopSession() {
  const sess = session(); if (!sess) return;
  const res = await act('stop', {}, { slot: sess.slot, timeout: 15000 });
  if (res.ok) { closeSheet(); S.reviewName = sess.name; setStep('review'); } else S.sheetError = res.reason;
  await pollState(); renderAll();
}
async function saveTag(n) {
  const draft = S.tagDraft[n] ?? {}, sess = session();
  if (!draft.tag) return;
  const res = await act('tag', { n, tag: draft.tag, note: draft.note ?? '' }, { slot: sess?.slot });
  draft.result = res.ok ? 'saved' : `not saved: ${res.reason}`;
  pollPanel(); renderAll();
}
async function runDoctor() { const res = await act('doctor', {}, { slot: null, timeout: 4000 }); S.notice = res.ok ? { kind: 'ok', text: 'Doctor started: its result appears on the Doctor tile.' } : { kind: 'warning', text: `Doctor: ${res.reason}` }; renderAll(); }

// The start check is a measurement (no motion): run once when the node first stands ready, after Clear map's scan
// and after each attempt, so the live view can be drawn in the scan frame.
async function maybeStartCheck() {
  const sess = session(), v = S.view;
  if (!sess || !v || !S.scanName || !['WAIT', 'ARRIVED', 'STOPPED'].includes(v.phase)) return;
  if (S.clearedAt && performance.now() - S.clearedAt < 10500) return;
  const key = `${sess.name}:${S.scanName}:${panelAttempts().length}:${S.clearedAt ?? 0}`;
  if (S.autoCheckKey === key || S.checking) return;
  S.autoCheckKey = key; S.checking = true;
  const r = await api('/api/deploy/act', { method: 'POST', body: { act: 'start_check', slot: sess.slot, scan: S.scanName, id: uuid() }, csrf: true, timeout: 8000 });
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
  S.estop = { state: 'sending', targets: [], t0: performance.now(), error: null };
  renderBar();
  while (performance.now() - S.estop.t0 < ESTOP_GIVE_UP_MS && gen === S.estopGen) {
    const ctl = new AbortController(), timer = setTimeout(() => ctl.abort(), 1200);
    let res = null, data = {};
    try {
      res = await fetch('/api/deploy/estop', { method: 'POST', cache: 'no-store', signal: ctl.signal, body: '{}',
        headers: { 'Content-Type': 'application/json', 'X-Studio-Estop': '1' } });
      try { data = await res.json(); } catch { data = {}; }
    } catch (error) { S.estop.error = ctl.signal.aborted ? 'no answer within 1.2 s' : error.message; }
    finally { clearTimeout(timer); }
    if (res && (res.status === 404 || res.status === 405)) {
      S.estop = { ...S.estop, state: 'failed', error: 'this Studio gateway has no E-STOP path' }; renderBar(); return;
    }
    const targets = Array.isArray(data.targets) ? data.targets : [];
    if (res?.ok) {
      S.estop.targets = targets;
      // No console known to the gateway while the bar believed one live: nothing was stopped. Say so plainly.
      if (!targets.length) { S.estop = { ...S.estop, state: 'failed', error: data.error ?? 'Studio knows no live console' }; renderBar(); return; }
      if (targets.every(t => t.ok)) { S.estop.state = targets.every(t => t.confirmed) ? 'confirmed' : 'acked'; S.estop.retrying = false; renderBar(); break; }
      S.estop.state = 'sent'; S.estop.retrying = true; S.estop.error = targets.filter(t => !t.ok).map(t => `${t.slot}: ${t.error ?? 'no answer'}`).join('; ');
    } else if (res) S.estop.error = data.error ?? `refused (${res.status})`;
    renderBar();
    await new Promise(r => setTimeout(r, 300));
  }
  if (gen !== S.estopGen) return;
  if (!['confirmed', 'acked'].includes(S.estop.state)) S.estop.state = 'failed';
  renderBar(); pollState();
}
async function direct(actName) {
  const sess = session(); if (!sess) return;
  const r = await api('/api/deploy/direct', { method: 'POST', body: { slot: sess.slot, act: actName },
    headers: { 'X-Studio-Estop': '1' }, timeout: 2000 });
  let res = r;
  if (r.status === 405) res = (await act(actName, {}, { slot: sess.slot, timeout: 3000 })).r;
  const ok = res.ok && res.data.ok !== false;
  S.directNote = { act: actName, ok, text: ok ? (actName === 'h' ? 'Stand sent' : 'Takeover sent') : `${actName === 'h' ? 'Stand' : 'Takeover'} failed: ${reason(res)}`, at: Date.now() };
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
  if (S.goal?.xy && S.goal.check?.scan !== name) checkGoal(S.goal.xy);
  if (frame && S.visible) frameStep(true);
  renderAll();
}

async function checkGoal(xy) {
  const token = ++S.pickToken;
  const at = xy.map(v => Math.round(v * 100) / 100);
  S.goal = { xy: at, check: null, status: 'pending' };
  drawGoal(); renderAll();
  const r = await api(`/api/deploy/goal_check?scan=${encodeURIComponent(S.scanName)}&x=${at[0]}&y=${at[1]}`, { timeout: 8000 });
  if (token !== S.pickToken) return;
  if (r.ok) S.goal.check = { ...r.data, scan: r.data.scan ?? S.scanName };
  else if (r.status === 404) S.goal.check = { unavailable: true, scan: S.scanName, reason: 'Studio\'s goal check (/api/deploy/goal_check) is not available on this gateway' };
  else S.goal.check = { ok: false, scan: S.scanName, checks: [{ id: 'error', status: 'block', label: 'Goal check failed', detail: reason(r) }] };
  S.goal.status = goalStatus();
  store.set('goal', JSON.stringify({ scan: S.scanName, xy: at }));
  drawGoal(); renderAll();
}
function drawGoal() {
  const g = S.goal, check = g?.check;
  if (!g) { d3.setGoal(null); return; }
  const dist = Math.hypot(g.xy[0], g.xy[1]);
  d3.setGoal({ xy: g.xy, status: goalStatus(), path: check?.path_xy ?? null, gap: check?.gap ?? null, blocking: check?.blocking_xy ?? [],
    label: goalStatus() === 'block' ? 'NOT HERE' : `GOAL · ${dist.toFixed(1)} M` });
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
  renderAll();
  if (frame && changed) frameStep();
}
function applyContext() { d3.applyVisibility({ step: S.step, tracksShown: !!S.tracks && S.tracksFor === rehearsalFor()?.name }); d3.setRehearsalTime(S.timeline.t); }
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
function lockLine(text) { return text ? `<p class="dp-lock" role="note">${LOCK_SVG}<span>${escape(text)}</span></p>` : ''; }
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
const VERDICT = {
  robust: ['pass', 'Robust', r => `All runs arrived; the drifted run stayed within ${num(r.apart_m, 2)} m of the exact one.`],
  'other way': ['warn', 'Arrives another way', r => `Both arrived, but drift sends the robot ${num(r.apart_m, 2)} m away from the exact path: expect a different path on the robot.`],
  'fails with drift': ['block', 'Fails with drift', () => 'Only the exact run arrived. The robot\'s odometry drifts like the drift run: pick another goal or rescan.'],
  fails: ['block', 'Fails', () => 'The exact run did not arrive. Do not deploy this goal.'],
};
function verdictText(rec) {
  if (!rec?.verdict) return null;
  const [tone, title, fn] = VERDICT[rec.verdict] ?? ['warn', rec.verdict, () => ''];
  const offset = rec.offset_ok === true ? 'A start 20° right / 0.2 m off still arrives.' : rec.offset_ok === false ? 'A start 20° right / 0.2 m off does not arrive: line the robot up with its scan pose.' : '';
  return { tone, title, text: `${fn(rec)} ${offset}`.trim() };
}

function renderAll() {
  renderBar(); renderContext();
  if (!S.visible) return;
  renderStrip(); renderPanel(true); renderStage(); renderReadiness(); renderSheet();
}

// ------------------------------------------------------------------------------------------------ the E-STOP bar
// Shown whenever a console was live at the last good state poll, the service does not answer (after it once did, or in
// Deploy), or the gateway reports a cached live panel. Hidden only on a positive "no console running".
function barModel() {
  const live = Object.entries(st().live ?? {}).filter(([, v]) => v?.running).map(([slot, v]) => ({ slot, ...v }));
  const unreachable = S.stateOk === false && (S.everOk || S.visible || S.cachedLive);
  if (!live.length && !unreachable && !['sending', 'sent', 'failed'].includes(S.estop.state)) return null;
  const robot = live.find(l => l.slot === 'robot' && !l.practice);
  const kind = robot ? 'robot' : live.length ? (live[0].practice ? 'practice' : 'rehearsal') : 'unknown';
  return { live, unreachable, kind, robot };
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
  const sess = m.live[0], age = m.live.map(l => l.console_t_mono_age_s).filter(finite);
  $('dpe-title').textContent = m.kind === 'robot' ? `ROBOT LIVE · ${st().robot_link?.robot ?? 'robot'}` : m.kind === 'practice' ? 'PRACTICE · simulated robot'
    : m.kind === 'rehearsal' ? 'REHEARSAL · simulator' : 'DEPLOY SERVICE NOT ANSWERING';
  $('dpe-sub').textContent = m.unreachable ? 'A console may still be running: Studio cannot see it.'
    : `${sess?.name ?? ''}${sess?.panel?.phase ? ` · ${PHASE[sess.panel.phase] ?? sess.panel.phase}` : ''}`;
  $('dpe-alarm').hidden = !age.some(a => a > 1);
  const es = S.estop, text = { sending: 'SENDING…', sent: `SENT · retrying: ${es.error ?? 'a console has not answered'}`, acked: 'SENT · every console acknowledged',
    confirmed: 'CONFIRMED · E-STOP in the runner', failed: `FAILED · ${es.error ?? 'no acknowledgement'} — use the physical E-stop` }[es.state] ?? '';
  const status = $('dpe-status'); status.hidden = !text; status.textContent = text; status.dataset.state = es.state ?? '';
  $('dp-estop').dataset.state = es.state ?? '';
  const mine = !!session();
  for (const id of ['dp-stand', 'dp-takeover']) { $(id).disabled = !mine; $(id).title = mine ? (id === 'dp-stand' ? 'Stand: the robot stops walking and stands (direct to the console)' : 'Take over: the runner leaves the policy and holds a stand (direct to the console)') : 'No session of yours is running'; }
  const dn = $('dpe-direct'), showDirect = S.directNote && Date.now() - S.directNote.at < 6000;
  dn.hidden = !showDirect; if (showDirect) { dn.textContent = S.directNote.text; dn.dataset.state = S.directNote.ok ? 'sent' : 'failed'; }
}

// ------------------------------------------------------------------------------------------------ top bar context
function renderContext() {
  const el = $('deploy-context'); if (!el) return;
  const sess = session();
  const service = S.stateOk === true ? `<span class="dpc-chip ok" title="Deploy service ${escape(st().version?.kit_commit ?? '')}">● Deploy service</span>`
    : S.stateOk === false ? `<span class="dpc-chip bad" title="${escape(S.stateError ?? '')}">● Deploy service not answering</span>` : '<span class="dpc-chip">Connecting…</span>';
  const who = isRobot() ? `<span class="dpc-mode robot">Robot · ${escape(st().robot_link?.robot ?? 'lab-g1')}</span>` : '<span class="dpc-mode practice">Practice</span>';
  const op = S.operator.trim() ? `<span class="dpc-chip" title="${holdsLease() ? 'You hold the controls' : 'Not holding the controls'}">${holdsLease() ? '◆' : '◇'} ${escape(S.operator.trim())}</span>` : '';
  el.innerHTML = `${who}${op}${service}${sess ? `<span class="dpc-chip live">● ${escape(sess.name)}</span>` : ''}`;
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
  const body = panelBody(), key = JSON.stringify(body);
  if (!force && key === lastPanelKey) return;
  lastPanelKey = key;
  const focused = document.activeElement?.id, sel = focused && document.activeElement.selectionStart;
  const scroller = root.querySelector('.dp-body'), scroll = scroller?.scrollTop ?? 0;
  const idx = STEPS.findIndex(s => s.id === S.step) + 1;
  root.innerHTML = `
    <header class="dp-head"><span class="eyebrow">Step ${idx} of ${STEPS.length}${isRobot() ? ' · real robot' : ' · practice'}</span><h2>${escape(body.title)}</h2>${body.lead ? `<p>${escape(body.lead)}</p>` : ''}</header>
    <div class="dp-body">${body.html}${S.notice ? `<div class="callout ${S.notice.kind === 'ok' ? 'ok' : 'warning'}" role="status">${escape(S.notice.text)}</div>` : ''}</div>
    <footer class="dp-foot">${body.primary ? primaryButton(body.primary) : ''}${body.secondary ?? ''}</footer>`;
  root.querySelector('.dp-body').scrollTop = scroll;
  if (focused && root.contains(document.getElementById(focused))) { const el = document.getElementById(focused); el.focus({ preventScroll: true }); try { if (sel !== null && sel !== undefined) el.setSelectionRange(sel, sel); } catch { /* not a text input */ } }
  bindPanel(root);
}
function primaryButton(p) {
  return `<button id="dp-primary" class="dp-primary ${p.tone ?? ''}" ${p.locked || S.busy ? 'disabled' : ''} data-action="${escape(p.action)}">${escape(S.busy && p.busyText ? p.busyText : p.label)}</button>${lockLine(p.locked)}`;
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
  return `<div class="dp-tile ${t.status}">${statusIcon(t.status)}<div><span>${escape(t.label)}</span><strong>${escape(t.value)}</strong>${t.hint ? `<small>${escape(t.hint)}</small>` : ''}</div>${t.ev ? evChip(t.ev) : ''}${t.button ?? ''}</div>`;
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
  const v = s.version ?? {};
  tiles.push({ label: 'Deploy kit', value: v.kit_commit ? `${String(v.kit_commit).slice(0, 7)}${v.kit_dirty ? ' · modified tree' : ''}` : 'Unavailable', status: v.kit_dirty ? 'warn' : v.kit_commit ? 'pass' : 'unknown', ev: 'CONFIGURED' });
  const doc = s.doctor;
  tiles.push({ label: 'Doctor', value: doc ? `${doc.exit === 0 ? 'passed' : `exit ${doc.exit}`} · ${ago(nowS() - doc.t)}` : 'not run today', status: doc ? (doc.exit === 0 ? (nowS() - doc.t > 1800 ? 'warn' : 'pass') : 'block') : 'unknown', ev: 'MEASURED', hint: doc?.text && doc.exit !== 0 ? doc.text.slice(0, 160) : '', button: `<button class="link-button" data-action="doctor">Run</button>` });
  return tiles;
}
function connectBody() {
  const s = st(), carrier = !!s.robot_link?.carrier, unreachable = S.stateOk === false;
  const name = S.operator.trim(), lease = S.lease;
  let primary;
  if (unreachable) primary = { label: 'Take the controls', action: 'lease', locked: `The deploy service does not answer (${S.stateError}). Start it on the deploy PC: ./g1 lab --headless` };
  else if (!holdsLease()) primary = { label: lease.conflict ? `Take over from ${lease.conflict}` : 'Take the controls', action: lease.conflict ? 'lease-takeover' : 'lease',
    locked: !name ? 'Type your name: it is recorded with every press' : isRobot() && !carrier ? 'No robot link: plug the robot in, or choose Practice' : null, busyText: 'Taking the controls…' };
  else primary = { label: 'Next: scan the scene', action: 'step:scan', locked: isRobot() && !carrier ? 'No robot link: plug the robot in, or choose Practice' : null };
  const profileOpts = profiles().map(p => `<option value="${escape(p.name)}" ${p.name === profileName() ? 'selected' : ''}>${escape(p.label ?? p.name)}${p.featured ? '' : ' (more)'}</option>`).join('');
  const prof = profiles().find(p => p.name === profileName());
  return {
    title: 'Connect', lead: isRobot() ? 'The deploy kit runs the robot; Studio shows it and relays your presses to its console.' : 'A simulated G1 in a scanned room, with the same console, gates and recording as the robot.',
    html: `
      <div class="segmented wide dp-mode" role="group" aria-label="Robot or practice">
        <button data-mode="robot" aria-pressed="${isRobot()}" ${session() ? 'disabled' : ''}>Robot · ${escape(s.robot_link?.robot ?? 'lab-g1')}</button><button data-mode="practice" aria-pressed="${!isRobot()}" ${session() ? 'disabled' : ''}>Practice · simulated</button>
      </div>
      ${session() ? '<p class="tiny">A session is running: end it to switch between robot and practice.</p>' : ''}
      <label class="field"><span>Operator</span><input id="dp-operator" type="text" autocomplete="name" placeholder="Your name" value="${escape(S.operator)}" ${holdsLease() ? 'readonly' : ''}></label>
      ${holdsLease() ? `<p class="tiny ok">You hold the controls${lease.supported === false ? ' (this gateway has no operator lease yet: one tab at a time)' : ''}. <button class="link-button" data-action="release">Release</button></p>` : ''}
      ${lease.lost ? `<div class="callout warning">You lost the controls: ${escape(lease.lost)}.</div>` : ''}
      ${lease.conflict ? `<div class="callout warning">${escape(lease.conflict)} holds the controls in another tab or browser. Take over only if they agree.</div>` : ''}
      <div class="dp-row2">
        <label class="field"><span>Policy profile</span><select id="dp-profile">${profileOpts}</select></label>
        <label class="field"><span>Odometry</span><select id="dp-odom">${Object.entries(ODOMETRY).map(([k, o]) => `<option value="${k}" ${k === odomName() ? 'selected' : ''}>${escape(o.label)}</option>`).join('')}</select></label>
      </div>
      <p class="tiny">${escape(prof?.note ?? '')}${prof?.note ? ' · ' : ''}${escape(ODOMETRY[odomName()]?.note ?? '')}</p>
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
        <ul class="dp-reasons">${(sc?.reasons ?? row.reasons ?? []).map(r => `<li>${escape(r)}</li>`).join('') || '<li>No reasons recorded</li>'}</ul>` : '<p class="tiny">No scan on this deploy PC yet.</p>'}
      ${stale ? `<div class="callout warning">Stale: ${escape(stale)}. Rescan before a robot session.</div>` : ''}
      ${counts ? `<div class="dp-counts"><span><i class="sw-ob"></i><b>${counts.obstacles}</b> obstacle cells</span><span><i class="sw-st"></i><b>${counts.steps}</b> step-over</span><span><i class="sw-oh"></i><b>${counts.overheads}</b> overhead</span></div>` : ''}
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
  else if (!check) locked = 'Checking the goal on the scan…';
  else if (check.unavailable) locked = check.reason;
  else if (status === 'block') locked = `This goal is blocked: ${(check.checks ?? []).find(c => c.status === 'block')?.label ?? 'see the checks'}`;
  const checks = check?.checks ?? [];
  return {
    title: 'Pick a goal', lead: 'Click the floor in 3D. The disc is the robot\'s footprint; its colour is a first look at the cells under it.',
    html: `
      ${hover && !g ? `<p class="tiny">Under the pointer: ${escape(hover.text)}</p>` : ''}
      ${g ? `<div class="dp-goal ${status}">${statusIcon(status === 'pending' ? 'unknown' : status)}<div><strong>(${num(g.xy[0], 2)}, ${num(g.xy[1], 2)}) m</strong><span>${escape(goalWords(g.xy))}</span></div><button class="link-button" data-action="clear-goal">Clear</button></div>` : '<div class="dp-empty"><b>No goal yet.</b> Point at the floor: green is clear, amber needs a look, red is blocked. A click on an obstacle lands on it and is refused there.</div>'}
      ${check && !check.unavailable ? `<ul class="nav-checks dp-checks">${checks.map(c => `<li class="${escape(c.status)}"><i>${ICON[c.status] ?? '?'}</i><span><strong>${escape(c.label)}</strong>${c.detail ? `<small>${escape(c.detail)}</small>` : ''}</span></li>`).join('')}</ul>
        <p class="tiny">Straight ${num(check.straight_m, 2)} m · route ${num(check.path_m, 2)} m${finite(check.unknown_fraction) ? ` · ${Math.round(check.unknown_fraction * 100)} % of it unseen` : ''}${check.gap ? ` · narrowest gap ${num(check.gap.width_m, 2)} m` : ''}</p>` : ''}
      ${check?.unavailable ? `<div class="callout warning">${escape(check.reason)}. The quick look says: ${escape(S.goal.quick?.text ?? 'unknown')}.</div>` : ''}
      <div class="dp-legend-inline"><span><i class="sw-route"></i>Route + 0.35 m margin</span><span><i class="sw-gap"></i>Gap the route passes</span><span><i class="sw-block"></i>Blocking cells</span><span><i class="sw-unseen"></i>Unseen route</span></div>`,
    primary: { label: 'Next: rehearse this goal', action: 'step:rehearse', locked },
  };
}

function runRow(which, label, sub, rec, track) {
  const running = rec?.running === which, result = track ? (track.arrived ? 'pass' : 'block') : running ? 'live' : rec && !rec.running ? 'unknown' : 'later';
  const detail = track ? `${track.arrived ? 'Arrived' : 'Did not arrive'} · ${num(track.duration_s, 1)} s${finite(track.final_dist_m) ? ` · ${num(track.final_dist_m, 2)} m from the goal` : ''}${track.contacts?.length ? ` · ${track.contacts.length} contact${track.contacts.length === 1 ? '' : 's'}, max ${Math.round(track.contact_max_n ?? 0)} N` : ''}`
    : running ? 'Running in the simulator…' : rec?.running ? 'Waiting' : 'Not run';
  return `<li class="dp-run ${result}"><i class="dp-run-sw" style="--c:${{ exact: '#0f9e94', drift: '#e0a030', offset: '#8a63d2' }[which]}"></i><div><strong>${escape(label)}</strong><small>${escape(sub)}</small><span>${running ? '<i class="dp-spin" aria-hidden="true"></i>' : ''}${escape(detail)}</span></div></li>`;
}
function rehearseBody() {
  const rec = rehearsalFor(), running = rehearsalRunning(), gpu = st().gpu ?? {}, sess = session(), robotWalking = liveSlot('robot')?.panel && ['PRESCAN', 'RUN'].includes(liveSlot('robot').panel.phase);
  let locked = null;
  if (!goalUsable() && !(S.goal?.check?.unavailable && S.goal?.xy)) locked = S.goal ? 'The goal is blocked or not checked (Goal)' : 'Pick a goal first';
  else if (!holdsLease()) locked = 'Take the controls first (Connect)';
  else if (running) locked = `A rehearsal is running (${running.running} run)`;
  else if (sess?.slot === 'sim') locked = 'End the practice session first: rehearsals use the simulator slot';
  else if (robotWalking) locked = 'The robot is walking';
  else if (finite(gpu.free_mib) && finite(gpu.rehearsal_mib) && gpu.free_mib < gpu.rehearsal_mib) locked = `The GPU has ${(gpu.free_mib / 1024).toFixed(1)} GB free; a rehearsal needs ${(gpu.rehearsal_mib / 1024).toFixed(1)} GB`;
  const v = verdictText(rec), tracks = S.tracksFor === rec?.name ? S.tracks : null;
  const primary = rec?.verdict ? { label: 'Next: deploy', action: 'step:deploy', locked: v?.tone === 'block' ? null : null }
    : { label: rec?.running || running ? 'Rehearsing…' : 'Rehearse 3 runs (about 1-2 min)', action: 'rehearse', locked: rec?.running ? 'Running: the robots appear on the timeline when the runs end' : locked, busyText: 'Starting…' };
  return {
    title: 'Rehearse in 3D', lead: `The deployed policy (${profileLabel(profileName())}) in the scan's twin, through the kit's real-time chain: once as scanned, once with the robot's measured leg drift, once from a typical start offset.`,
    html: `
      ${S.goal ? `<p class="tiny">Goal (${num(S.goal.xy[0], 2)}, ${num(S.goal.xy[1], 2)}) · ${escape(odomName())} odometry · scan ${escape(S.scanName ?? '')}</p>` : ''}
      <ul class="dp-runs">
        ${runRow('exact', 'Exact', 'From the scan pose, perfect odometry', rec, tracks?.exact)}
        ${runRow('drift', 'Measured leg drift', 'The heading drift the robot\'s legs measured', rec, tracks?.drift)}
        ${runRow('offset', 'Start offset', '20° right and 0.2 m off the scan pose, as every 10-27 walk', rec, tracks?.offset)}
      </ul>
      ${v ? `<div class="dp-verdict ${v.tone}">${statusIcon(v.tone)}<div><strong>${escape(v.title)}</strong><span>${escape(v.text)}</span></div></div>` : ''}
      ${tracks ? '<p class="tiny">Scrub the timeline under the 3D view: the three robots walk together. Red spheres are contacts, drawn at the robot.</p>' : ''}
      ${v?.tone === 'block' ? '<div class="callout warning">The rehearsal did not pass. You can still deploy in practice, but on the robot pick another goal or rescan.</div>' : ''}`,
    primary,
    secondary: rec?.verdict && !running ? `<button class="dp-secondary" data-action="rehearse" ${locked || S.busy ? 'disabled' : ''}>Rehearse again</button>` : '',
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
function ladderRows() {
  const p = S.panel, ladder = p?.ladder ?? [], locks = p?.go_locks ?? [], lost = !!S.view && liveState() === 'lost';
  const byKey = Object.fromEntries(ladder.map(l => [l.key, l]));
  const rows = [
    { key: 'arm', label: 'Arm', sub: 'The runner initialises the motors; the planner node starts.' },
    { key: 'sonic', label: 'Start SONIC', sub: 'SONIC holds the robot standing.' },
    { key: 'map', label: 'Clear map', sub: 'The planner forgets the old map and rescans for 10 s.' },
    { key: 'goal', label: 'Send goal', sub: 'Start check, then the goal converted to the robot\'s frame now.' },
    { key: 'go', label: 'GO', sub: 'The robot walks to the goal.' },
  ];
  const cleared = S.clearedAt ? Math.max(0, 10 - (performance.now() - S.clearedAt) / 1000) : 0;
  return rows.map(r => {
    const l = byKey[r.key] ?? { state: 'todo' };
    let lock = null;
    if (p?.runner === 'E-STOP') lock = 'E-STOP is active: end the session';
    else if (lost && ['arm', 'goal', 'go'].includes(r.key)) lock = 'Live view lost: watch the robot';
    else if (r.key === 'go') lock = locks[0] ?? goalSentStale();
    else if (r.key === 'goal' && !goalUsable()) lock = S.goal ? 'The goal is not checked on this scan (Goal)' : 'Pick a goal first (Goal)';
    else if (r.key === 'map' && cleared > 0) lock = `Rescanning: ${Math.ceil(cleared)} s`;
    else if (['sonic', 'map'].includes(r.key) && (p?.phase === 'BOOT' || !p?.phase)) lock = 'The planner node is starting (about 3-20 s after Arm)';
    return { ...r, state: l.state ?? 'todo', detail: l.detail, lock };
  });
}
function deployBody() {
  const sess = session(), rec = rehearsalFor(), v = verdictText(rec);
  if (!sess) {
    const stale = scanStale(), locked = !holdsLease() ? 'Take the controls first (Connect)' : S.stateOk !== true ? 'The deploy service does not answer'
      : isRobot() && !st().robot_link?.carrier ? 'No robot link' : !S.scanName ? 'Scan first' : isRobot() && stale ? `Rescan first: ${stale}` : rehearsalRunning() ? 'A rehearsal is running' : null;
    const ended = S.reviewName && S.attempts[S.reviewName];
    return {
      title: isRobot() ? 'Deploy on the robot' : 'Deploy on the practice robot',
      lead: 'Start a session, then the ladder: Arm, Start SONIC, Clear map, Send goal, GO. Every step is a press relayed to the kit\'s console, which checks its own gates.',
      html: `
        <div class="dp-summary">
          <div><span>Scan</span><strong>${escape(S.scanName ?? 'none')}</strong></div>
          <div><span>Goal</span><strong>${S.goal ? `(${num(S.goal.xy[0], 2)}, ${num(S.goal.xy[1], 2)}) · ${escape(goalStatus())}` : 'none yet'}</strong></div>
          <div><span>Policy</span><strong>${escape(profileLabel(profileName()))}</strong></div>
          <div><span>Odometry</span><strong>${escape(ODOMETRY[odomName()]?.label ?? odomName())}</strong></div>
          <div><span>Rehearsal</span><strong class="${v?.tone ?? ''}">${escape(v?.title ?? 'not rehearsed for this goal')}</strong></div>
        </div>
        ${!rec?.verdict ? '<div class="callout warning">This goal has no rehearsal for this profile. Rehearse first, unless you only practise the ladder.</div>' : ''}
        ${ended ? `<p class="tiny">Last session ${escape(S.reviewName)}: ${ended.length} attempt${ended.length === 1 ? '' : 's'}. <button class="link-button" data-action="step:review">Review</button></p>` : ''}`,
      primary: { label: isRobot() ? 'Start robot session…' : 'Start practice session…', action: 'sheet:start', locked, tone: isRobot() ? 'robot' : 'practice' },
    };
  }
  const rows = ladderRows(), p = S.panel ?? {}, moved = goalSentStale();
  // A goal moved after Send goal makes Send goal the step to do again.
  if (moved) { const g = rows.find(r => r.key === 'goal'); if (g?.state === 'done' && !walking()) { g.state = 'now'; g.detail = moved; rows.find(r => r.key === 'go').state = 'todo'; } }
  const nowRow = rows.find(r => r.state === 'now') ?? rows.find(r => r.state !== 'done');
  const attempts = panelAttempts(), last = attempts.at(-1), untagged = attempts.filter(a => a.outcome && !a.tag);
  const sc = S.startCheck, envelope = sc ? (sc.within_offset_envelope ? 'inside the rehearsed start-offset envelope' : 'outside the rehearsed start-offset envelope') : null;
  let primary = null;
  const estopped = p.runner === 'E-STOP';
  if (estopped) primary = { label: 'End session…', action: 'sheet:end', locked: null };
  else if (walking()) primary = { label: 'Walking…', action: 'none', locked: 'Stand or E-STOP from the bar above; the remote and the physical E-stop stay in hand' };
  else if (nowRow) {
    const action = { arm: 'sheet:arm', sonic: 'ladder:sonic', map: 'ladder:map', goal: 'send-goal', go: 'sheet:go' }[nowRow.key];
    const label = { arm: 'Arm…', sonic: 'Start SONIC', map: 'Clear map', goal: 'Send goal', go: isRobot() ? 'GO…' : 'GO (practice)…' }[nowRow.key];
    primary = { label, action, locked: nowRow.lock, tone: nowRow.key === 'go' ? (isRobot() ? 'robot' : 'practice') : '', busyText: 'Sending…' };
  }
  return {
    title: walking() ? 'Walking' : `${isRobot() ? 'Robot' : 'Practice'} session`,
    lead: `${sess.name} · ${PHASE[p.phase] ?? p.phase ?? 'starting'}${p.runner ? ` · runner ${p.runner}` : ''}`,
    html: `
      ${estopped ? '<div class="callout danger" role="alert"><strong>E-STOP is active.</strong> The runner holds the robot in its safe mode and the console refuses every other press. End the session; start a new one to try again.</div>' : ''}
      <ol class="dp-ladder${estopped ? ' stopped' : ''}">${rows.map(r => `<li class="${r.state}${r === nowRow ? ' current' : ''}">${statusIcon(r.state === 'done' ? 'done' : r === nowRow ? 'now' : 'todo')}<div><strong>${escape(r.label)}</strong><small>${escape(r.detail || r.sub)}</small>${r === nowRow && r.lock && !estopped ? `<em>${escape(r.lock)}</em>` : ''}${S.ladderNote[r.key] && r.key !== 'goal' && !estopped ? `<em class="${S.ladderNote[r.key].kind}">${escape(S.ladderNote[r.key].text)}</em>` : ''}</div>${r.state === 'done' && r.key === 'map' && !walking() ? '<button class="link-button" data-action="ladder:map">Again</button>' : ''}${r.state === 'done' && r.key === 'goal' && !walking() && goalUsable() ? '<button class="link-button" data-action="send-goal">Resend</button>' : ''}</li>`).join('')}</ol>
      ${S.sendResult ? `<div class="callout ${S.sendResult.ok ? 'ok' : 'warning'}" role="status">${S.sendResult.ok ? `Goal confirmed by the node${S.sendResult.check ? `. Start check: moved ${num(S.sendResult.check.moved_m, 2)} m, turned ${num(S.sendResult.check.turned_deg, 0)}° (${escape(S.sendResult.check.within_offset_envelope ? 'inside the rehearsed envelope' : 'outside the rehearsed envelope')})` : ''}.` : `Send goal refused: ${escape(S.sendResult.text)}`}</div>` : ''}
      ${S.goResult && !S.goResult.ok ? `<div class="callout warning" role="status">GO refused by the console: ${escape(S.goResult.text)}</div>` : ''}
      ${sc ? `<p class="tiny">Robot now vs its scan pose: ${num(sc.moved_m, 2)} m, ${num(sc.turned_deg, 0)}° · ${escape(envelope)} (grey ghost in 3D).</p>` : ''}
      ${untagged.map(a => tagCard(a)).join('')}
      ${attempts.length ? `<h4>Attempts</h4><ol class="dp-attempts">${attempts.map(a => `<li><strong>${a.n}</strong><span class="outcome ${a.outcome === 'arrived' ? 'outcome-good' : a.outcome ? 'outcome-warn' : 'outcome-live'}">${escape(a.outcome ?? 'walking')}</span>${finite(a.final_dist_m) ? `<small>${num(a.final_dist_m, 2)} m from the goal</small>` : ''}${a.tag ? `<span class="dp-tag">${escape(a.tag)}</span>` : ''}</li>`).join('')}</ol>` : ''}`,
    primary,
    secondary: estopped ? '' : `<button class="dp-secondary" data-action="sheet:end" ${walking() ? 'disabled title="The robot is walking: Stand or E-STOP first"' : ''}>End session…</button>${walking() ? lockLine('End session is locked while the robot walks') : ''}`,
  };
}
function tagCard(a) {
  const draft = S.tagDraft[a.n] ??= { tag: null, note: '' };
  return `<div class="dp-tagcard"><strong>Attempt ${a.n} ended: ${escape(a.outcome)}${finite(a.final_dist_m) ? ` (${num(a.final_dist_m, 2)} m from the goal)` : ''}</strong><p class="tiny">Tag it before the next try.</p>
    <div class="dp-tags">${(S.panel?.tags ?? TAGS).map(t => `<button data-tag="${escape(t)}" data-n="${a.n}" aria-pressed="${draft.tag === t}">${escape(t)}</button>`).join('')}</div>
    <input type="text" id="dp-note-${a.n}" data-note="${a.n}" placeholder="Note (optional)" value="${escape(draft.note)}">
    <button class="dp-secondary" data-action="tag:${a.n}" ${draft.tag ? '' : 'disabled'}>Save tag</button>${draft.result ? `<small>${escape(draft.result)}</small>` : ''}</div>`;
}

function reviewBody() {
  const list = [...(st().sessions?.robot ?? []), ...(st().sessions?.other ?? [])];
  const name = S.reviewName ?? list[0]?.name ?? null, row = list.find(s => s.name === name);
  if (name && S.manifestFor !== name) loadManifest(name);
  const m = S.manifestFor === name ? S.manifest : null, attempts = S.attempts[name] ?? (session()?.name === name ? panelAttempts() : null);
  const present = m?.items?.filter(i => i.status === 'present').length ?? 0, missing = m?.items?.filter(i => i.status === 'missing') ?? [];
  const size = b => (b >= 1e9 ? `${(b / 1e9).toFixed(1)} GB` : b >= 1e6 ? `${(b / 1e6).toFixed(0)} MB` : b >= 1e3 ? `${(b / 1e3).toFixed(0)} kB` : `${b} B`);
  return {
    title: 'Review', lead: 'Everything the session recorded, collected by the kit in the session directory.',
    html: `
      <label class="field"><span>Session</span><select id="dp-review">${list.map(s => `<option value="${escape(s.name)}" ${s.name === name ? 'selected' : ''}>${escape(s.name)}${s.practice ? ' (practice)' : ''}${s.started ? ` · ${new Date(s.started * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</option>`).join('') || '<option>No sessions today</option>'}</select></label>
      ${name ? `<h4>Attempts</h4>${attempts?.length ? `<ol class="dp-attempts">${attempts.map(a => `<li><strong>${a.n}</strong><span class="outcome ${a.outcome === 'arrived' ? 'outcome-good' : 'outcome-warn'}">${escape(a.outcome ?? 'open')}</span>${a.tag ? `<span class="dp-tag">${escape(a.tag)}</span>` : '<small>untagged</small>'}${a.note ? `<small>${escape(a.note)}</small>` : ''}${a.rehearsal?.verdict ? `<small>rehearsal: ${escape(a.rehearsal.verdict)}</small>` : ''}${a.start_check ? `<small>start ${num(a.start_check.moved_m, 2)} m / ${num(a.start_check.turned_deg, 0)}°</small>` : ''}</li>`).join('')}</ol>` : `<p class="tiny">${attempts ? 'No attempts.' : 'Attempts are in the session\'s attempts.jsonl (recorded, not shown here for an ended session).'}</p>`}
        <h4>Evidence ${m ? `<span class="tiny">${present} of ${m.items.length} present${m.complete ? ' · complete' : ''}</span>` : ''}</h4>
        ${m ? `<table class="dp-manifest"><tbody>${m.items.map(i => `<tr class="${escape(i.status.replace('/', ''))}"><td>${statusIcon(i.status === 'present' ? 'pass' : i.status === 'missing' ? 'block' : 'later')}</td><td>${escape(i.id.replaceAll('_', ' '))}</td><td>${i.status === 'present' ? escape(size(i.bytes ?? 0)) : escape(i.status)}</td><td>${escape(i.reason ?? '')}</td></tr>`).join('')}</tbody></table>
          ${missing.length ? `<p class="tiny">${missing.length} missing: ${escape(missing.map(i => i.id).join(', '))}.</p>` : ''}` : '<p class="tiny">Loading the manifest…</p>'}` : ''}`,
    primary: { label: 'Open in Replay', action: 'replay', locked: !name ? 'No session yet' : replayId(name) ? null : 'Not in Studio\'s run list yet: it appears once the session has ended and Studio\'s catalog lists it' },
    secondary: name ? `<button class="dp-secondary" data-action="manifest">Refresh evidence</button>` : '',
  };
}
async function loadManifest(name) {
  S.manifestFor = name; S.manifest = null;
  const r = await api(`/api/deploy/manifest?name=${encodeURIComponent(name)}`, { timeout: 5000 });
  if (S.manifestFor === name) { S.manifest = r.ok ? r.data : { items: [], error: reason(r) }; renderPanel(true); }
}
function replayId(name) {
  const list = S.ctx?.sessions?.() ?? [];
  return list.find(s => s.available && (s.id === name || String(s.id).endsWith(name) || String(s.label ?? '').includes(name)))?.id ?? null;
}

// ------------------------------------------------------------------------------------------------ panel events
function bindPanel(root) {
  root.querySelectorAll('[data-mode]').forEach(b => b.addEventListener('click', () => {
    S.mode = b.dataset.mode; store.set('mode', S.mode);
    if (isRobot() && (scanRow(S.scanName)?.practice || S.scanName?.startsWith('practice-'))) { S.scanName = null; S.scene = null; onState(S.state, false); }
    renderAll();
  }));
  const opInput = root.querySelector('#dp-operator');
  opInput?.addEventListener('input', e => { S.operator = e.target.value; store.set('operator', S.operator); renderPanel(); renderContext(); });
  opInput?.addEventListener('keydown', e => { if (e.key === 'Enter' && S.operator.trim()) takeLease(); });
  root.querySelector('#dp-profile')?.addEventListener('change', e => { S.profile = e.target.value; store.set('profile', S.profile); renderAll(); });
  root.querySelector('#dp-odom')?.addEventListener('change', e => { S.odom = e.target.value; store.set('odom', S.odom); renderAll(); });
  root.querySelector('#dp-scan')?.addEventListener('change', e => selectScan(e.target.value));
  root.querySelector('#dp-seconds')?.addEventListener('change', e => { S.seconds = Math.max(3, Math.min(30, Number(e.target.value) || 8)); renderPanel(true); });
  root.querySelector('#dp-review')?.addEventListener('change', e => { S.reviewName = e.target.value; renderPanel(true); });
  root.querySelectorAll('[data-tag]').forEach(b => b.addEventListener('click', () => { const d = S.tagDraft[b.dataset.n] ??= {}; d.tag = b.dataset.tag; d.result = null; renderPanel(true); }));
  root.querySelectorAll('[data-note]').forEach(i => i.addEventListener('input', e => { (S.tagDraft[i.dataset.note] ??= {}).note = e.target.value; }));
  root.querySelectorAll('[data-action]').forEach(b => b.addEventListener('click', () => doAction(b.dataset.action)));
}
function doAction(a) {
  if (!a || a === 'none') return;
  if (a.startsWith('step:')) return setStep(a.slice(5));
  if (a.startsWith('sheet:')) return openSheet(a.slice(6));
  if (a.startsWith('ladder:')) return ladderAct(a.slice(7));
  if (a.startsWith('tag:')) return saveTag(Number(a.slice(4)));
  switch (a) {
    case 'lease': return takeLease(false);
    case 'lease-takeover': return takeLease(true);
    case 'release': releaseLease(); S.lease = { ...S.lease, id: null, supported: S.lease.supported === false ? null : S.lease.supported }; return renderAll();
    case 'doctor': return runDoctor();
    case 'scan': return startScan();
    case 'clear-goal': return clearGoal();
    case 'rehearse': return runRehearsal();
    case 'send-goal': return sendGoal();
    case 'manifest': S.manifestFor = null; return renderPanel(true);
    case 'replay': { const id = replayId(S.reviewName ?? ''); if (id) emit('open-session', id); return; }
    default: return undefined;
  }
}

// ------------------------------------------------------------------------------------------------ sheets
// In-page confirmations, docked over the step panel: the stage stays visible (the goal and route in 3D).
function openSheet(kind) {
  S.sheet = { kind, confirm: {}, armed: false }; S.sheetError = null;
  if (kind === 'go' && S.goal?.xy) d3.frame([d3.liveScenePose() ?? [0, 0, 0], S.goal.xy, ...(S.goal.check?.path_xy ?? [])], {});
  renderSheet();
}
function closeSheet() { S.sheet = null; S.sheetError = null; renderSheet(); }
function sheetModel() {
  const k = S.sheet?.kind, sess = session(), robot = isRobot();
  if (k === 'start') {
    const c = S.sheet.confirm, all = CONFIRM.every(([id]) => c[id]);
    return { title: robot ? 'Start the robot session' : 'Start the practice session', tone: robot ? 'robot' : 'practice',
      body: `<p>${robot ? 'The kit starts the console on the real robot: the runner, the planner node and the recorder. Nothing moves until you Arm.' : 'The kit starts a simulated robot on this scan\'s twin, 0.2 m and 20° off the scan pose, with the same console and recorder.'}</p>
        <div class="dp-summary"><div><span>Scan</span><strong>${escape(S.scanName ?? '')}</strong></div><div><span>Policy</span><strong>${escape(profileLabel(profileName()))}</strong></div><div><span>Odometry</span><strong>${escape(ODOMETRY[odomName()]?.label ?? '')}</strong></div><div><span>Operator</span><strong>${escape(S.operator.trim())}</strong></div></div>
        <fieldset class="dp-confirm"><legend>Confirm, as on every robot day${robot ? '' : ' (practised here too)'}</legend>${CONFIRM.map(([id, text]) => `<label><input type="checkbox" data-confirm="${id}" ${c[id] ? 'checked' : ''}><span>${escape(text)}</span></label>`).join('')}</fieldset>`,
      ok: robot ? 'Start robot session' : 'Start practice session', locked: all ? null : 'Tick every item: they are stored with the session', run: () => startSession({ ...Object.fromEntries(CONFIRM.map(([id]) => [id, true])) }) };
  }
  if (k === 'arm') {
    return { title: 'Arm', tone: robot ? 'robot' : 'practice',
      body: `<p>Arming starts the runner's motor control and the planner node. ${robot ? '<strong>The gantry carries the weight</strong>: the robot may sag or twitch while the motors take over.' : 'The practice robot does the same in the simulator.'}</p>
        <label class="dp-confirm-one"><input type="checkbox" data-armed ${S.sheet.armed ? 'checked' : ''}><span>${robot ? 'The gantry carries the robot\'s weight and nobody is within 1 m' : 'I am practising the robot-day ladder'}</span></label>`,
      ok: 'Arm', locked: S.sheet.armed ? (liveState() === 'lost' && S.view ? 'Live view lost' : null) : 'Confirm first', run: () => ladderAct('arm') };
  }
  if (k === 'go') {
    const rec = rehearsalFor(), v = verdictText(rec), locks = S.panel?.go_locks ?? [], sc = S.startCheck ?? S.sendResult?.check;
    const blocking = (S.readiness ?? []).filter(c => c.status === 'block').map(c => c.label);
    const lost = liveState() === 'lost';
    const moved = goalSentStale();
    const items = [...locks.map(l => `Console: ${l}`), ...(moved ? [moved] : []), ...blocking.map(b => `Readiness: ${b}`), ...(lost ? ['Live view lost'] : [])];
    return { title: robot ? 'GO · the real robot walks' : 'GO · practice robot', tone: robot ? 'robot' : 'practice',
      body: `<div class="dp-summary">
          <div><span>Goal</span><strong>(${num(S.goal?.xy?.[0], 2)}, ${num(S.goal?.xy?.[1], 2)}) · ${escape(goalWords(S.goal?.xy))}</strong></div>
          <div><span>Route</span><strong>${num(S.goal?.check?.path_m, 2)} m${S.goal?.check?.gap ? ` · gap ${num(S.goal.check.gap.width_m, 2)} m` : ''} (in 3D)</strong></div>
          <div><span>Policy</span><strong>${escape(profileLabel(profileName()))}</strong></div>
          <div><span>Odometry</span><strong>${escape(ODOMETRY[odomName()]?.label ?? '')}</strong></div>
          <div><span>Rehearsal</span><strong class="${v?.tone ?? 'warn'}">${escape(v ? `${v.title}: ${v.text}` : 'not rehearsed for this goal')}</strong></div>
          <div><span>Start check</span><strong>${sc ? `${num(sc.moved_m, 2)} m, ${num(sc.turned_deg, 0)}° · ${sc.within_offset_envelope ? 'inside' : 'outside'} the rehearsed envelope` : 'not run'}</strong></div>
        </div>
        ${items.length ? `<div class="dp-before"><strong>Before GO</strong><ul>${items.map(i => `<li>${statusIcon('block')}${escape(i)}</li>`).join('')}</ul></div>` : '<p class="tiny ok">The console reports no lock. Watch the robot, remote in hand.</p>'}`,
      ok: robot ? 'GO — the robot walks' : 'GO — practice robot walks', locked: items[0] ?? null, run: () => go() };
  }
  if (k === 'end') {
    const attempts = panelAttempts(), untagged = attempts.filter(a => a.outcome && !a.tag).length;
    return { title: 'End the session', tone: robot ? 'robot' : 'practice',
      body: `<p>The kit stops the runner and the planner and writes the session's manifest. ${robot ? 'The robot goes limp unless the runner holds it: <strong>the gantry carries the weight</strong>.' : ''}</p>
        <p>${attempts.length} attempt${attempts.length === 1 ? '' : 's'}${untagged ? `, <strong>${untagged} untagged</strong>` : ''}.</p>`,
      ok: 'End session', locked: walking() ? 'The robot is walking: Stand or E-STOP first' : sess ? null : 'No session', run: () => stopSession() };
  }
  return null;
}
let lastSheetKey = '';
function renderSheet() {
  const host = $('dp-sheet-host'); if (!host) return;
  const m = S.sheet ? sheetModel() : null;
  document.body.classList.toggle('dp-sheet-open', !!m);
  if (!m) { host.innerHTML = ''; lastSheetKey = ''; return; }
  const key = JSON.stringify([m.title, m.body, m.ok, m.locked, S.busy, S.sheetError]);
  if (key === lastSheetKey || (S.pointerHeld && host.innerHTML)) return;
  lastSheetKey = key;
  host.innerHTML = `<div class="dp-sheet" role="dialog" aria-modal="true" aria-labelledby="dp-sheet-title" data-tone="${m.tone}">
    <header><span class="dp-sheet-mode">${m.tone === 'robot' ? 'REAL ROBOT' : 'PRACTICE'}</span><h3 id="dp-sheet-title">${escape(m.title)}</h3></header>
    <div class="dp-sheet-body">${m.body}${S.sheetError ? `<div class="callout danger" role="alert">${escape(S.sheetError)}</div>` : ''}</div>
    <footer><button class="dp-sheet-ok ${m.tone}" id="dp-sheet-ok" ${m.locked || S.busy ? 'disabled' : ''}>${escape(S.busy ? 'Sending…' : m.ok)}</button>${lockLine(m.locked)}<button class="dp-secondary" id="dp-sheet-cancel">Cancel</button></footer></div>`;
  host.querySelector('#dp-sheet-cancel').addEventListener('click', closeSheet);
  host.querySelector('#dp-sheet-ok').addEventListener('click', () => { if (!m.locked && !S.busy) { S.sheetError = null; m.run(); } });
  host.querySelectorAll('[data-confirm]').forEach(i => i.addEventListener('change', () => { S.sheet.confirm[i.dataset.confirm] = i.checked; renderSheet(); }));
  host.querySelector('[data-armed]')?.addEventListener('change', e => { S.sheet.armed = e.target.checked; renderSheet(); });
  if (!host.contains(document.activeElement)) host.querySelector('input, #dp-sheet-cancel')?.focus({ preventScroll: true });
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
  if (S.stateOk === false) out.push(['danger', `The deploy service does not answer: ${S.stateError}. A console may still be running.`]);
  if (sess && ls === 'lost') out.push(['danger', `LIVE VIEW LOST — the robot may still be walking. Watch the robot. E-STOP above (direct path) · physical E-stop.`]);
  else if (sess && ls === 'stale') out.push(['warning', `Live view ${liveAge().toFixed(1)} s old`]);
  if (S.view && !d3.isAligned() && sess) out.push(['neutral', 'Not aligned yet: the robot\'s own frame only. The start check aligns it with the scan (it runs once the planner stands ready).']);
  if (S.lease.lost && S.step !== 'connect') out.push(['warning', `You lost the controls: ${S.lease.lost}. Take them again in Connect.`]);
  if (S.step === 'goal' && !S.goal && S.scene) out.push(['hint', 'Click the floor to place a goal · Esc cancels']);
  if (S.step !== 'goal' && S.hoverHint) out.push(['hint', S.hoverHint]);
  const key = JSON.stringify(out);
  if (key !== el.dataset.key) { el.dataset.key = key; el.innerHTML = out.map(([k, t]) => `<div class="dp-banner ${k}" role="${k === 'danger' ? 'alert' : 'status'}">${escape(t)}</div>`).join(''); updateInsets(); }
}
function hudItem(label, value, tone = '', big = false) { return `<div class="dp-hud-item ${tone}${big ? ' big' : ''}"><span>${escape(label)}</span><strong>${value}</strong></div>`; }
function renderHud() {
  const el = $('dp-hud'); if (!el) return;
  const sess = session(), v = S.view, p = S.panel;
  if (!sess || !v) { if (el.innerHTML) { el.innerHTML = ''; updateInsets(); } return; }
  const ls = liveState(), age = liveAge(), old = ls === 'fresh' ? null : `${age.toFixed(1)} s old`;
  const val = (x, fmt) => (old ? `<em>${escape(old)}</em>` : x === null || x === undefined ? '<em>Unavailable</em>' : fmt(x));
  const trail = S.poseTrail ?? [], hist = v.pose_hist ?? [];
  const speed = trail.length > 1 && trail.at(-1).t - trail[0].t >= 0.3 ? Math.hypot(trail.at(-1).x - trail[0].x, trail.at(-1).y - trail[0].y) / (trail.at(-1).t - trail[0].t)
    : hist.length > 1 ? Math.hypot(hist.at(-1)[1] - hist[0][1], hist.at(-1)[2] - hist[0][2]) / Math.max(0.05, hist.at(-1)[0] - hist[0][0]) : null;
  const odom = v.odom ?? p?.odom ?? {}, odomTone = odom.lost ? 'bad' : odom.doubt ? 'warn' : '';
  const odomText = odom.lost ? `LOST · ${odom.lost}` : odom.doubt ? 'LIO doubt' : odom.watchdog ? `watchdog: ${odom.watchdog}` : `${odom.mode ?? '?'}${finite(odom.lio_age_s) ? ` · LIO ${Math.round(odom.lio_age_s * 1000)} ms` : ''}`;
  const temp = p?.temps?.max_c, sonic = p?.standing_s, lidar = st().robot_link?.lidar_hz;
  el.innerHTML = [
    hudItem('Driving', val(p?.driving, x => escape(x)), walking() ? 'live' : '', true),
    hudItem('Phase', val(v.phase, x => escape(PHASE[x] ?? x))),
    hudItem('To goal', val(v.goal_dist_m, x => `${x.toFixed(2)}<em>m</em>${odom.mode === 'leg' ? '<small>leg odometry under-counts 25-40 %</small>' : ''}`)),
    hudItem('Speed', val(speed, x => `${x.toFixed(2)}<em>m/s</em>`)),
    hudItem('Tilt', val(v.tilt_rad, x => `${(x * 180 / Math.PI).toFixed(1)}<em>°</em>`), finite(v.tilt_rad) && v.tilt_rad > 0.35 ? 'bad' : ''),
    hudItem('Plan latency', val(v.latency_s, x => `${Math.round(x * 1000)}<em>ms</em>`), finite(v.latency_s) && v.latency_s > 0.3 ? 'warn' : ''),
    hudItem('Odometry', val(odomText, x => escape(x)), odomTone),
    hudItem('Remote', val(p?.remote ? (p.remote.connected ? 'connected' : 'NOT CONNECTED') : null, x => escape(x)), p?.remote && !p.remote.connected ? 'bad' : ''),
    hudItem('Motors', val(temp, x => `${x.toFixed(0)}<em>°C</em>${finite(sonic) ? `<small>${Math.floor(sonic / 60)} min on SONIC${sonic > SONIC_LONG_S ? ' · end the session between tries' : ''}</small>` : ''}`), finite(temp) && temp > 70 ? 'bad' : finite(temp) && temp > 60 || sonic > SONIC_LONG_S ? 'warn' : ''),
    isRobot() ? hudItem('Lidar', val(lidar, x => `${x.toFixed(1)}<em>Hz</em>`), finite(lidar) && lidar < 8 ? 'warn' : '') : '',
  ].join('');
  el.dataset.state = ls;
  updateInsets();
}
function renderTicker() {
  const el = $('dp-ticker'); if (!el) return;
  const events = session() ? (S.panel?.events ?? []).filter(e => !/:\s*lease\b/.test(String(e))).slice(0, 4) : [];
  el.innerHTML = events.map(e => `<li>${escape(String(e).trim())}</li>`).join('');
  el.hidden = !events.length;
}
function renderTimeline() {
  const el = $('dp-timeline'); if (!el) return;
  const show = S.step === 'rehearse' && S.tracks && S.tracksFor === rehearsalFor()?.name && S.timeline.duration > 0;
  el.hidden = !show;
  if (!show) return;
  const t = S.timeline;
  el.innerHTML = `<button id="dp-tl-play" aria-label="${t.playing ? 'Pause' : 'Play'}">${t.playing ? '❚❚' : '▶'}</button>
    <input id="dp-tl" type="range" min="0" max="${t.duration}" step="0.02" value="${t.t}" aria-label="Rehearsal time">
    <span>${t.t.toFixed(1)} / ${t.duration.toFixed(1)} s</span>
    <span class="dp-tl-key"><i style="--c:#0f9e94"></i>exact<i style="--c:#e0a030"></i>drift<i style="--c:#8a63d2"></i>offset</span>`;
  $('dp-tl-play').addEventListener('click', () => playTimeline(!S.timeline.playing));
  $('dp-tl').addEventListener('input', e => { playTimeline(false); S.timeline.t = Number(e.target.value); d3.setRehearsalTime(S.timeline.t); el.querySelector('span').textContent = `${S.timeline.t.toFixed(1)} / ${t.duration.toFixed(1)} s`; });
}
function playTimeline(on) {
  const t = S.timeline; t.playing = on; cancelAnimationFrame(t.raf);
  if (on) {
    if (t.t >= t.duration - 0.05) t.t = 0;
    let last = performance.now();
    const loop = now => {
      if (!S.timeline.playing) return;
      t.t = Math.min(t.duration, t.t + (now - last) / 1000); last = now;
      d3.setRehearsalTime(t.t);
      const range = $('dp-tl'); if (range) { range.value = String(t.t); range.nextElementSibling.textContent = `${t.t.toFixed(1)} / ${t.duration.toFixed(1)} s`; }
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
  el.innerHTML = `<span><i class="sw-ob"></i>Obstacle (by height)</span><span><i class="sw-st"></i>Step-over</span><span><i class="sw-oh"></i>Overhead</span><span><i class="sw-floor"></i>Seen floor</span>${live || S.scanLive?.running ? '<span><i class="sw-pt"></i>Lidar</span><span><i class="sw-ign"></i>Ignored by the planner</span>' : ''}${S.goal ? '<span><i class="sw-route"></i>Route</span>' : ''}${d3.hasTrail() ? '<span><i class="sw-walked"></i>Walked</span>' : ''}`;
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
  const el = $('dp-readiness'); if (!el || !S.visible) return;
  const checks = S.readiness ?? [], shown = checks.map(c => ({ c, s: checkShown(c) }));
  const count = k => shown.filter(x => x.s.status === k).length;
  const summary = `${count('pass')} ✓ · ${count('warn')} ! · ${count('block')} ✕ · ${count('later')} later`;
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
  if (e.key === 'Escape') {
    if (S.sheet) { closeSheet(); return true; }
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
    if (ls !== S.lastLiveState) { S.lastLiveState = ls; renderPanel(); renderSheet(); }
  }
  if (S.clearedAt && performance.now() - S.clearedAt < 11000) renderPanel();
  // The scan ghost vs robot now: shown once a session is aligned with the scan.
  const sc = S.startCheck, sess = session(), ghost = [!!(sess && d3.isAligned()), sc ? `MOVED ${num(sc.moved_m, 2)} M, TURNED ${num(sc.turned_deg, 0)}°` : null];
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
  <div class="dp-bottom" id="dp-bottom"><div class="dp-timeline" id="dp-timeline" hidden></div><div class="dp-hud" id="dp-hud" aria-live="off"></div><div class="dp-side"><ol class="dp-ticker" id="dp-ticker" aria-label="Console events" hidden></ol><div class="dp-legend" id="dp-legend"></div></div></div>
  <div class="dp-hover-tip" id="dp-hover-tip" hidden></div>`;
export function initDeploy(ctx) {
  S.ctx = ctx;
  d3.init();
  $('deploy-stage').innerHTML = STAGE_HTML;
  $('deploy-panel').innerHTML = '<div id="dp-panel-content" class="dp-panel-content"></div><div id="dp-sheet-host"></div>';
  // While a pointer is pressed on Deploy's controls, polls never replace the element under it.
  for (const id of ['deploy-panel', 'deploy-stage']) $(id).addEventListener('pointerdown', e => { if (e.target.closest('button, input, select, label')) S.pointerHeld = true; });
  window.addEventListener('pointerup', () => { if (S.pointerHeld) { S.pointerHeld = false; setTimeout(() => { renderPanel(); renderSheet(); renderStage(); }, 0); } }, true);
  window.addEventListener('pointercancel', () => { S.pointerHeld = false; }, true);
  for (const p of Object.values(pollers)) p.start(p === pollers.state ? 0 : 300);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    S.viewStaleUntilFresh = true;   // a tab coming back starts stale until a fresh view arrives
    if (S.lease.id) pollers.lease.start(0);
  });
  window.addEventListener('beforeunload', () => releaseLease());
  window.__deploy = { S, d3: d3.d3, estop, setStep, checkGoal, project: d3.project, pickAt: d3.pickAt, frameStep };
}
// The service answers the v1 API: Studio opens on Deploy (app.js).
export async function probe() {
  const r = await api('/api/deploy/state', { timeout: 1500 });
  if (r.ok && r.data.api) { S.state = r.data; S.stateOk = true; S.everOk = true; return true; }
  return false;
}
export async function enter() {
  S.visible = true;
  d3.enter();
  bindPointer();
  if (S.state) onState(S.state, false);
  if (S.scanName && !S.scene) selectScan(S.scanName, false);
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
