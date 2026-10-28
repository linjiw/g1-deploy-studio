// Re-validation (v0.3 fixes) · Rehearse runs. Launches at most 6 short CPU runs:
//   R1 bundle 2 s lat 200 predict (live attach, L2 badge, torque card)
//   R2 WX-RF 2 s on the EMPTY flat-ground map, lat 200 (completes, L2≈, privileged honesty)
//   R3 bundle 3 s cancelled (partial-live wording)
//   R4/R5 suite 3 × 3 s: run 1 completes, run 2 cancelled, run 3 skipped (Cancel UI, suite reservation)
//   R6 suite on a 96-character arena name, cancelled at once
//   STUDIO_URL=http://127.0.0.1:8795 STUDIO_EVIDENCE=... node tools/browser/validation/reval_rehearse.mjs
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, api, sleep } from './harness.mjs';

const BUNDLE = 'flow-bundle-20261008', WX = 'flow-wx-rf-23326aa-s0';
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const { browser, context } = await launch();
let page = await context.newPage();
const R = recorder(process.env.ONLY ? 'reval-rehearse-b' : 'reval-rehearse');
const check0 = R.check; R.check = (id, ...rest) => (!ONLY || ONLY.has(id)) ? check0(id, ...rest) : null;
R.watch(page);
const jobs = {}, timing = {};
let prior = {}; try { prior = JSON.parse(await readFile(path.join(EVIDENCE, 'rehearse-jobs.json'), 'utf8')); } catch { /* first run */ }

const rh = () => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__studio.rehearse, catalog: null, map: window.__studio.rehearse.map?.id, timer: null, suiteTimer: null })));
const S = (p = page) => p.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length,
  badge: document.querySelector('#mode-badge').textContent, chip: document.querySelector('#run-outcome').textContent, playback: document.querySelector('#playback-state').textContent,
  health: document.querySelector('#health-content .tab-intro')?.textContent ?? null, warning: document.querySelector('#recording-warning').hidden ? null : document.querySelector('#recording-warning').textContent,
  workspace: window.__studio.state.workspace, picker: document.getElementById('session-picker').selectedOptions[0]?.textContent }));
const ui = (p = page) => p.evaluate(() => ({ cancel: !!document.getElementById('rh-cancel'), runDisabled: document.getElementById('rh-run')?.disabled, suiteDisabled: document.getElementById('rh-suite')?.disabled,
  session: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length, job: window.__studio.rehearse.job?.id, jobStatus: window.__studio.rehearse.job?.status }));
async function setNum(id, v, p = page) { await p.fill(`#${id}`, String(v)); await p.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
async function policy(id, p = page) { await p.check(`input[name=policy][value="${id}"]`); await sleep(150); }
async function boot(p = page) { await p.goto(`${BASE}/`); await p.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 }); }
async function rehearse(p = page) { if (await p.evaluate(() => window.__studio.state.workspace) !== 'rehearse') { await p.click('#workspace-rehearse'); } await p.waitForSelector('#rh-map'); await sleep(300); }
async function configure({ map, pol = BUNDLE, duration = 2, preset = '0', latency = '0', anchor = null }, p = page) {
  await rehearse(p);
  await p.selectOption('#rh-map', map); await sleep(500);
  await policy(pol, p); await p.click('[data-budget="2,4"]'); await sleep(100);
  await setNum('rh-duration', duration, p); await p.selectOption('#rh-preset', preset); await sleep(100);
  await p.selectOption('#rh-latency', latency); await sleep(150);
  if (anchor) await p.selectOption('#rh-anchor', anchor);
}
async function startRun() {
  const prev = (await rh()).job?.id ?? null;
  await page.click('#rh-run');
  await page.waitForFunction(prev => window.__studio.rehearse.job?.id && window.__studio.rehearse.job.id !== prev, prev, { timeout: 60000 });
  return (await rh()).job.id;
}
async function waitLive(id, timeout = 240000, p = page) {
  await p.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation' && window.__studio.state.session.frames.length > 0, id, { timeout, polling: 200 });
}
async function waitJobApi(id, timeout = 480000) {
  let j; const t0 = Date.now();
  do { j = (await api(page, `/api/jobs?id=${id}&light=1`)).body; if (['completed', 'failed', 'cancelled'].includes(j.status)) return j; await sleep(1000); } while (Date.now() - t0 < timeout);
  return j;
}
const replayOf = id => page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay' && document.querySelector('#loading-overlay').hidden, id, { timeout: 90000 });

await boot();

// Fixture arena: doorway + mirrored preset = 3 presets, saved through the editor.
await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
await page.selectOption('#arena-base', 'tpl:doorway');
await page.fill('#arena-label', 'Reval doorway'); await page.locator('#arena-label').dispatchEvent('input'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200); // blur first (N1)
await page.click('[data-preset-select="1"]'); await page.click('#preset-mirror');
await page.click('#arena-save');
await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
const arenaId = await page.evaluate(() => window.__studio.arena.savedId);
const arenaDoc = (await api(page, `/api/map?id=${arenaId}`)).body;
console.log('fixture arena', arenaId, arenaDoc.presets.map(p => p.label));

// ------------------------------------------------------------------ R1 bundle, latency 200 predict
await R.check('4.8', 'Run preset (bundle K2/ODE4, 2 s, lat 200 predict): live attach, frames grow, LIVE badge, Health worker card, recorded result opens', async () => {
  await configure({ map: arenaId, duration: 2, preset: '2', latency: '200', anchor: 'predict' });
  const t0 = Date.now();
  const id = await startRun(); jobs.bundle = id; jobs.bundle200 = id;
  await waitLive(id);
  const a = await S(); await sleep(2000); const b = await S();
  const health = await page.locator('#health-content').textContent();
  const shot = await R.shot('live-bundle');
  const cam = await page.evaluate(() => window.__studio.camera);
  const job = await waitJobApi(id);
  await replayOf(id);
  timing.bundle2s_wall_s = (Date.now() - t0) / 1000;
  const done = await S();
  const shot2 = await R.shot('result-bundle');
  assert(/live CPU simulation/i.test(a.badge), `badge ${a.badge}`);
  assert(b.frames > a.frames || job.status !== 'running', `frames ${a.frames} → ${b.frames}`);
  assert(/Owned CPU worker/.test(health), 'Health worker card');
  assert(cam === 'follow', `camera ${cam}`);
  assert(job.status === 'completed' && done.chip.trim(), `job ${job.status} ${job.error ?? ''} chip ${done.chip}`);
  assert(/replay · CPU rehearsal/i.test(done.badge), `result badge ${done.badge}`);
  return { id, a, b, done, wall_s: timing.bundle2s_wall_s, shot, shot2 };
});

await R.check('4.12', 'Bundle run with 200 ms latency (predict): fidelity badge L2 (not L2≈), Health fidelity text', async () => {
  const id = jobs.bundle; if (!id) return R.blocked('R1 did not run');
  await page.click('#tab-health'); await sleep(400);
  const health = await page.locator('#health-content').textContent(), badge = await page.locator('#mode-badge').textContent();
  const job = (await api(page, `/api/jobs?id=${id}&light=1`)).body;
  assert(job.scenario.latency.ms === 200 && job.scenario.latency.anchor === 'predict', `latency ${JSON.stringify(job.scenario.latency)}`);
  // Since the review (L3) the bundle badge names its anchor: "L2 predict".
  assert(/· L2( predict)?$/.test(badge.trim()) && !/L2≈/.test(badge), `badge ${badge}`);
  assert(/L2( predict)? · lockstep with 200 ms planner latency/.test(health), 'health fidelity text');
  return { badge, shot: await R.shot('result-bundle-lat200') };
});

await R.check('B.torque', 'Health torque card present for a new run', async () => {
  if (!jobs.bundle) return R.blocked('R1 did not run');
  await page.click('#tab-health'); await sleep(300);
  const n = await page.locator('#health-content .torque-details').count();
  const summary = n ? await page.locator('#health-content .torque-details summary').first().textContent() : null;
  if (n) await page.locator('#health-content .torque-details summary').first().click();
  const rows = n ? await page.locator('#health-content .torque-details tr').count() : 0;
  const shot = await R.shot('health-torque');
  assert(n === 1 && /Leg torque vs (model )?limit/.test(summary) && rows > 1, `torque card ${n} summary ${summary} rows ${rows}`);
  return { summary, rows, shot };
});

// Since predictive anchoring for the Flow callback (1944abe), the anchor is selectable for WX whenever a
// latency is set, and a chosen 'predict' persists across a latency change.
await R.check('4.6', 'Latency select + anchor enabling rules (anchor disabled without latency; WX supports predict)', async () => {
  await rehearse();
  await policy(BUNDLE); await page.selectOption('#rh-latency', '0'); await sleep(150);
  const a = await page.locator('#rh-anchor').isDisabled();
  await page.selectOption('#rh-latency', '200'); await sleep(150);
  const b = await page.locator('#rh-anchor').isDisabled(), l2 = /L2: each replan starts 200 ms/.test(await page.locator('#rehearse-panel').textContent());
  await page.selectOption('#rh-anchor', 'predict');
  await policy(WX); await sleep(150);
  const c = await page.locator('#rh-anchor').isDisabled(), wxText = /Studio delayed-execution approximation/.test(await page.locator('#rehearse-panel').textContent());
  await page.selectOption('#rh-latency', '160'); await sleep(150);
  const anchorAfter = (await rh()).settings.anchor;
  await policy(BUNDLE); await page.selectOption('#rh-anchor', 'measured'); await page.selectOption('#rh-latency', '0');
  assert(a && !b && l2 && !c && wxText && anchorAfter === 'predict', JSON.stringify({ bundle0: a, bundle200: b, l2, wx: c, wxText, anchorAfter }));
  return { bundle0Disabled: a, bundle200Disabled: b, wxDisabled: c, wxAnchorAfterLatency: anchorAfter };
});

// ------------------------------------------------------------------ R2 WX on the empty flat-ground map
await R.check('B.wx-empty', 'WX-RF run on an EMPTY map (flat-ground), 2 s, lat 200: completes (no infinite-clearance crash)', async () => {
  await configure({ map: 'flat-ground', pol: WX, duration: 2, preset: '0', latency: '200' });
  const anchorDisabled = await page.locator('#rh-anchor').isDisabled();
  const t0 = Date.now();
  const id = await startRun(); jobs.wx200 = id; jobs.wxEmpty = id;
  await waitLive(id, 300000).catch(() => {});
  const live = await S();
  const job = await waitJobApi(id, 540000);
  timing.wx2s_wall_s = (Date.now() - t0) / 1000;
  if (job.status === 'completed') await replayOf(id);
  const done = await S();
  const shot = await R.shot('result-wx-empty');
  const full = (await api(page, `/api/jobs?id=${id}`)).body;
  assert(!anchorDisabled, 'anchor selectable for WX at 200 ms (predictive anchoring)');
  assert(job.status === 'completed' && full.result_session_id === id, `WX on flat-ground ended ${job.status}: ${job.error ?? ''} ${(full.log_tail ?? '').slice(-400)}`);
  assert(full.scenario.latency.ms === 200 && full.scenario.latency.anchor === 'measured', `latency ${JSON.stringify(full.scenario.latency)}`);
  return { id, map: full.scenario.map_id, boxes: (await api(page, '/api/map?id=flat-ground')).body.boxes.length, liveBadge: live.badge, done, wall_s: timing.wx2s_wall_s, outcome: full.summary?.report?.outcome ?? full.summary?.outcome, shot };
});

await R.check('4.11', 'WX run with 200 ms latency: fidelity badge L2≈', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  const s = await S(); if (s.id !== id || s.mode !== 'replay') return R.blocked(`WX recording not open (${s.id} ${s.mode})`);
  await page.click('#tab-health'); await sleep(300);
  const health = await page.locator('#health-content').textContent();
  assert(/L2≈/.test(s.badge), `badge ${s.badge}`);
  return { badge: s.badge, fidelity: health.match(/Fidelity level.{0,80}/)?.[0] };
});

await R.check('B.priv-chip', 'WX recording: PRIVILEGED MAP chip visible (and hidden for a bundle recording)', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  const vis = await page.locator('#privileged-badge').isVisible(), text = await page.locator('#privileged-badge').textContent(), title = await page.locator('#privileged-badge').getAttribute('title');
  const shot = await R.shot('privileged-chip');
  await page.selectOption('#session-picker', jobs.bundle); await replayOf(jobs.bundle);
  const bundleVis = await page.locator('#privileged-badge').isVisible();
  await page.selectOption('#session-picker', id); await replayOf(id);
  assert(vis && /privileged map/i.test(text) && !bundleVis, `wx chip visible ${vis} "${text}", bundle chip visible ${bundleVis}`);
  return { text, title, bundleVisible: bundleVis, shot };
});

await R.check('B.robot-view', 'Robot-view label says approximate viewpoint for a WX run', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  await page.click('#robot-view'); await sleep(600);
  const wx = await page.locator('#robot-view-label').textContent(), vis = await page.locator('#robot-view-label').isVisible();
  const shot = await R.shot('robot-view-wx');
  await page.click('#robot-view');
  await page.selectOption('#session-picker', jobs.bundle); await replayOf(jobs.bundle);
  await page.click('#robot-view'); await sleep(400);
  const bundle = await page.locator('#robot-view-label').textContent();
  await page.click('#robot-view');
  await page.selectOption('#session-picker', id); await replayOf(id);
  assert(vis && /approximate viewpoint/i.test(wx) && !/approximate/i.test(bundle), `wx "${wx}" bundle "${bundle}"`);
  return { wx, bundle, shot };
});

await R.check('B.system', 'System workspace for a WX run: LiDAR/perception/route edges not used; privileged label', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  await page.click('#workspace-system'); await page.waitForSelector('#system-stage .sys-edge'); await sleep(500);
  const edges = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#system-stage .sys-edge')].map(g => [g.dataset.edge, { opacity: g.getAttribute('opacity'), dash: g.querySelector('polyline, line').getAttribute('stroke-dasharray'), title: g.querySelector('title').textContent }])));
  const text = await page.locator('#system-panel, #workbench-panel, .system-panel').first().textContent().catch(() => '');
  const panel = await page.evaluate(() => document.body.innerText.match(/PRIVILEGED block[^\n]*/)?.[0] ?? null);
  const badges = await page.locator('#system-stage .sys-node-badge').allTextContents();
  await page.click('#system-stage [data-node="lidar"]'); await sleep(200);
  const detail = await page.locator('#system-detail').textContent();
  const shot = await R.shot('system-wx');
  await page.click('#workspace-replay'); await sleep(300);
  const unused = ['lidar-perception', 'state-perception', 'perception-route'];
  assert(unused.every(e => edges[e]?.dash === '2 5' && edges[e]?.opacity === '0.35' && /not used/.test(edges[e].title)), `edges ${JSON.stringify(Object.fromEntries(unused.map(e => [e, edges[e]])))}`);
  assert(/privileged/i.test(edges['route-flow']?.title ?? ''), `route-flow ${JSON.stringify(edges['route-flow'])}`);
  assert(panel && badges.filter(b => /not used \(privileged\)/.test(b)).length === 2 && /Privileged block/.test(detail), `panel ${panel} badges ${badges} detail ${detail.slice(0, 200)}`);
  return { unused: Object.fromEntries(unused.map(e => [e, edges[e].title])), routeFlow: edges['route-flow'].title, panel, badges, shot };
});

await R.check('B.graph', 'Graph tab for a WX run: LiDAR/perception/route edges not used; privileged label', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  await page.click('#tab-graph'); await sleep(400);
  const edges = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#graph-map .sys-edge')].map(g => [g.dataset.edge, { opacity: g.getAttribute('opacity'), dash: g.querySelector('polyline, line').getAttribute('stroke-dasharray'), title: g.querySelector('title').textContent }])));
  const intro = await page.locator('#graph-content .tab-intro').textContent();
  const shot = await R.shot('graph-wx');
  const unused = ['lidar-perception', 'state-perception', 'perception-route'];
  assert(unused.every(e => edges[e]?.dash === '2 5' && /not used/.test(edges[e].title)) && /PRIVILEGED block/.test(intro), `graph ${JSON.stringify(edges).slice(0, 400)} intro ${intro}`);
  return { intro, shot };
});

await R.check('6.5', 'WX recording: Sensors say perception is unavailable by design', async () => {
  const id = jobs.wx200; if (!id) return R.blocked('R2 did not run');
  await page.click('#workspace-sensors'); await page.waitForSelector('[data-sensor-card]'); await sleep(600);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#sensors-panel [data-sensor-card]')].map(n => ({ id: n.dataset.sensorCard, label: n.querySelector('strong').textContent, reason: n.querySelector('.sensor-reason')?.textContent ?? null })));
  const keys = ['lidar_raw', 'lidar_registered', 'lidar_filtered', 'map_support', 'map_ceiling'];
  const lidar = cards.filter(c => keys.includes(c.id));
  const shot = await R.shot('sensors-wx');
  await page.click('#workspace-replay');
  assert(lidar.length === 5 && lidar.every(c => /Unavailable by design/.test(c.reason ?? '') && /privileged/.test(c.reason)), `wx lidar/map cards ${JSON.stringify(lidar)}`);
  return { lidar, others: cards.filter(c => !keys.includes(c.id) && c.reason), shot };
});

// ------------------------------------------------------------------ R3 cancel
await R.check('4.9', 'Cancel during a run: status cancelled, UI recovers', async () => {
  await configure({ map: arenaId, duration: 3, preset: '1', latency: '0' });
  const id = await startRun(); jobs.cancelled = id;
  await waitLive(id);
  await page.waitForSelector('#rh-cancel', { timeout: 10000 });
  await page.click('#rh-cancel');
  const job = await waitJobApi(id, 60000);
  await sleep(4000);
  const runEnabled = !(await page.locator('#rh-run').isDisabled()), cancelGone = await page.locator('#rh-cancel').count() === 0;
  const jobText = await page.locator('#rh-job').textContent();
  const sessions = (await api(page, '/api/sessions')).body.sessions, entry = sessions.find(s => s.id === id);
  const row = (await api(page, '/api/runs')).body.runs.find(r => r.id === id);
  const shot = await R.shot('cancelled');
  assert(job.status === 'cancelled', `status ${job.status}`);
  assert(runEnabled && cancelGone, `run enabled ${runEnabled} cancel gone ${cancelGone}`);
  assert(/cancelled/i.test(jobText) && !/Goal reached/.test(jobText), `job text ${jobText}`);
  assert(!entry || (entry.outcome !== 'goal_completion' && /no recording/.test(entry.label ?? '')), `session entry ${JSON.stringify(entry)}`);
  assert(row && row.status === 'cancelled' && !row.outcome && !row.replayable, `runs row ${JSON.stringify(row && { s: row.status, o: row.outcome, r: row.replayable })}`);
  return { id, entry: entry && { label: entry.label, status: entry.status, outcome: entry.outcome }, shot };
});

await R.check('4.9b', 'After Cancel: header/badge/chip/transport/Health leave LIVE → RUN CANCELLED · PARTIAL LIVE SAMPLES', async () => {
  const id = jobs.cancelled; if (!id) return R.blocked('R3 did not run');
  await page.click('#tab-health'); await sleep(400);
  const s = await S();
  const shot = await R.shot('after-cancel-header');
  assert(s.id === id, `viewport left the cancelled run: ${s.id}`);
  assert(/run cancelled · partial live samples/i.test(s.badge) && !/live CPU/i.test(s.badge), `badge "${s.badge}"`);
  assert(!/running/i.test(s.chip) && /cancel/i.test(s.chip), `chip "${s.chip}"`);
  assert(/run cancelled/i.test(s.playback), `transport "${s.playback}"`);
  assert(/partial live samples/i.test(s.health ?? '') && !/live CPU worker/i.test(s.health ?? ''), `Health "${s.health}"`);
  assert(/run cancelled/i.test(s.warning ?? ''), `warning ${s.warning}`);
  return { ...s, shot };
});

// ------------------------------------------------------------------ R4/R5 suite with Cancel + reservation
let suiteObs = {};
await R.check('4.10', 'Run suite: during run 1 and run 2 the action bar shows Cancel; Run preset / Run suite disabled', async () => {
  await configure({ map: arenaId, duration: 3, preset: '0', latency: '0' });
  await setNum('rh-seeds', 1);
  // A second tab opened before the suite (stale: it does not know about the suite).
  const p2 = await context.newPage(); R.watch(p2);
  await boot(p2); await configure({ map: arenaId, duration: 2, preset: '2', latency: '0' }, p2);
  R.use(page);
  suiteObs.p2 = p2;
  const label = await page.locator('#rh-suite').textContent();
  assert(/Run suite · 3 runs/.test(label), `suite button ${label}`);
  await page.click('#rh-suite');
  await page.waitForFunction(() => window.__studio.rehearse.suite?.id, null, { timeout: 60000 });
  const suiteId = await page.evaluate(() => window.__studio.rehearse.suite.id);
  await page.waitForFunction(() => window.__studio.rehearse.suite?.runs?.[0]?.job_id && window.__studio.state.session?.metadata?.mode === 'simulation', null, { timeout: 120000, polling: 250 });
  await sleep(1500);
  const during1 = await ui(); const shot1 = await R.shot('suite-run1');
  suiteObs = { ...suiteObs, suiteId, during1, run1: during1.job, shot1 };
  // Release guard (read-only): the active_runs function of tools/studio_service.sh against THIS gateway.
  suiteObs.activeRunsDuringSuite = await activeRuns();
  assert(during1.cancel && during1.runDisabled && during1.suiteDisabled, `run 1: ${JSON.stringify(during1)}`);
  return { suiteId, during1, shot1 };
});

async function activeRuns() {
  const { execFileSync } = await import('node:child_process');
  const port = new URL(BASE).port;
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../studio_service.sh');
  const fn = execFileSync('sed', ['-n', '/^active_runs() {/,/^}/p', script], { encoding: 'utf8' });
  return execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\nPORT=${port}\nbusy="$(active_runs | xargs)"\nif [[ -n "$busy" && "\${FORCE:-0}" != 1 ]]; then echo "WOULD REFUSE: $busy"; else echo "WOULD RELEASE"; fi`], { encoding: 'utf8' }).trim();
}

await R.check('B.suite-refuses', 'A running suite refuses a manual Run preset (stale tab click + API spam across the run 1 → run 2 gap) with a clear message', async () => {
  const p2 = suiteObs.p2; if (!p2 || !suiteObs.suiteId) return R.blocked('suite did not start');
  const jobsBefore = (await api(page, '/api/jobs')).body.jobs.length;
  // (a) stale second tab: Run preset is still enabled there; the server must refuse.
  R.use(p2);
  const p2Enabled = !(await p2.locator('#rh-run').isDisabled());
  if (p2Enabled) { await p2.click('#rh-run'); await sleep(1500); }
  const p2Error = await p2.locator('#workbench-error').isVisible() ? await p2.locator('#workbench-error').textContent() : '';
  R.use(page);
  // (b) API spam with a valid scenario between run 1 finishing and run 2 starting.
  const token = (await api(page, '/api/workbench')).body.csrf_token;
  const scen = (await api(page, '/api/scenarios')).body.scenarios.find(s => s.map_id === arenaId && s.duration_s === 2);
  const msgs = {}; let started = null, posts = 0;
  const t0 = Date.now(); let s;
  while (Date.now() - t0 < 300000) {
    s = (await api(page, `/api/suites?id=${suiteObs.suiteId}`)).body;
    if (s.runs[1].job_id || !['queued', 'running'].includes(s.status)) break;
    const j1 = s.runs[0].job_id ? (await api(page, `/api/jobs?id=${s.runs[0].job_id}&light=1`)).body.status : null;
    if (['completed', 'failed', 'cancelled'].includes(j1)) {
      for (let i = 0; i < 6; i++) {
        const r = await page.request.post(`${BASE}/api/jobs`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data: { scenario_id: scen.id } });
        posts++; const b = await r.json().catch(() => ({}));
        if (r.status() < 300) { started = b.id; break; }
        msgs[`${r.status()} ${b.error}`] = (msgs[`${r.status()} ${b.error}`] ?? 0) + 1;
        await sleep(25);
      }
      if (started) break;
    } else await sleep(150);
  }
  // The run 1 → run 2 gap can be shorter than one poll; then refusal is checked while the suite is still running.
  if (!posts && !started) {
    for (let i = 0; i < 3; i++) {
      const r = await page.request.post(`${BASE}/api/jobs`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data: { scenario_id: scen.id } });
      posts++; const b = await r.json().catch(() => ({}));
      if (r.status() < 300) { started = b.id; break; }
      msgs[`${r.status()} ${b.error}`] = (msgs[`${r.status()} ${b.error}`] ?? 0) + 1;
    }
  }
  if (started) { await page.request.post(`${BASE}/api/jobs/cancel`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data: { id: started } }).catch(() => {}); jobs.leaked = started; }
  const jobsAfter = (await api(page, '/api/jobs')).body.jobs.length;
  suiteObs.refuse = { p2Enabled, p2Error, posts, msgs, started };
  assert(!started, `a manual job ${started} started while the suite was running`);
  assert(!p2Enabled || /Suite .* is running|already active/.test(p2Error), `stale tab Run preset: "${p2Error}"`);
  assert(Object.keys(msgs).length && Object.keys(msgs).every(m => /Suite suite-[0-9a-f]+ is running; cancel it or wait|A simulation job is already active/.test(m)), `messages ${JSON.stringify(msgs)}`);
  return { ...suiteObs.refuse, suiteSpecific: Object.keys(msgs).filter(m => /Suite suite-/.test(m)), jobsBefore, jobsAfter };
}, { expectHttp: [/4\d\d .*\/api\/jobs$/] });

await R.check('4.10a', 'Suite run 2 is attached live to the viewport with Cancel shown', async () => {
  if (!suiteObs.suiteId) return R.blocked('suite did not start');
  let s; const t0 = Date.now();
  while (Date.now() - t0 < 300000) { s = (await api(page, `/api/suites?id=${suiteObs.suiteId}`)).body; if (s.runs[1].job_id && s.runs[1].status === 'running') break; if (!['queued', 'running'].includes(s.status)) break; await sleep(250); }
  suiteObs.run2 = s.runs[1].job_id;
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation' && window.__studio.state.session.frames.length > 1, suiteObs.run2, { timeout: 60000, polling: 200 }).catch(() => {});
  const during2 = await ui(); const shot2 = await R.shot('suite-run2');
  suiteObs.during2 = during2;
  assert(during2.session === suiteObs.run2 && during2.mode === 'simulation', `viewport ${during2.session} (${during2.mode}) while suite run ${suiteObs.run2} is live`);
  assert(during2.cancel && during2.runDisabled && during2.suiteDisabled, `run 2: ${JSON.stringify(during2)}`);
  return { during2, shot2 };
});

await R.check('4.10c', 'Cancel suite mid-way (button): run 2 cancelled, run 3 skipped, header → RUN CANCELLED · PARTIAL LIVE SAMPLES, UI recovers', async () => {
  if (!suiteObs.run2) return R.blocked('run 2 did not start');
  const st = (await api(page, `/api/jobs?id=${suiteObs.run2}&light=1`)).body.status;
  if (st !== 'running') return R.blocked(`run 2 already ${st}`);
  await page.waitForSelector('#rh-cancel', { timeout: 5000 });
  await page.click('#rh-cancel');
  await page.waitForFunction(() => ['cancelled', 'completed', 'completed_with_errors', 'interrupted', 'failed'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000, polling: 500 });
  await sleep(3000);
  const suite = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  jobs.suite = suite.runs.map(r => r.job_id).filter(Boolean);
  const table = await page.locator('#rh-suite-status').textContent();
  const u = await ui(); await page.click('#tab-health'); await sleep(300); const s = await S();
  const shot = await R.shot('suite-cancelled');
  assert(suite.status === 'cancelled' && suite.runs[0].outcome && suite.runs[0].status === 'completed' && suite.runs[1].status === 'cancelled' && !suite.runs[1].outcome && suite.runs[2].status === 'skipped', `suite ${suite.status} runs ${JSON.stringify(suite.runs.map(r => [r.status, r.outcome]))}`);
  assert(!u.cancel && !u.runDisabled && !u.suiteDisabled, `UI after cancel ${JSON.stringify(u)}`);
  assert(/Suite · cancelled/.test(table) && /1\/3 finished/.test(table), `table ${table}`);
  assert(s.id === suiteObs.run2 && /run cancelled · partial live samples/i.test(s.badge) && !/running/i.test(s.chip) && /run cancelled/i.test(s.playback) && /partial live samples/i.test(s.health ?? ''),
    `header after suite cancel: ${JSON.stringify({ id: s.id, badge: s.badge, chip: s.chip, playback: s.playback, health: s.health })}`);
  return { runs: suite.runs.map(r => [r.status, r.outcome, r.job_id, r.preset]), table, header: { badge: s.badge, chip: s.chip, playback: s.playback, health: s.health }, shot };
});

await R.check('B.release-guard', 'tools/studio_service.sh active_runs (against this gateway) lists the active job + suite during a suite, empty when idle', async () => {
  const during = suiteObs.activeRunsDuringSuite; if (!during) return R.blocked('no suite observation');
  const idle = await activeRuns();
  assert(/^WOULD REFUSE: job-[0-9a-f]+ suite-[0-9a-f]+$/.test(during) && during.includes(suiteObs.suiteId) && idle === 'WOULD RELEASE', `during "${during}" idle "${idle}"`);
  return { during, idle };
});
if (suiteObs.p2) { await suiteObs.p2.close().catch(() => {}); R.use(page); }

// ------------------------------------------------------------------ R6 long arena name suite
await R.check('4.13', 'Run suite is accepted for a 96-character arena name (label ≤ 100)', async () => {
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  await page.selectOption('#arena-base', 'tpl:empty');
  const long = 'Reval long arena name '.padEnd(96, 'x');
  await page.fill('#arena-label', long); await page.locator('#arena-label').dispatchEvent('input'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200); // blur first (N1)
  await page.click('#arena-save'); await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
  const id = await page.evaluate(() => window.__studio.arena.savedId);
  await page.click('#arena-rehearse'); await page.waitForFunction(id => window.__studio.rehearse.mapId === id, id, { timeout: 20000 });
  await policy(BUNDLE); await page.click('[data-budget="2,4"]'); await setNum('rh-duration', 2); await page.selectOption('#rh-latency', '0');
  await page.click('#rh-suite');
  await page.waitForFunction(() => window.__studio.rehearse.suite?.label?.startsWith('Reval long'), null, { timeout: 15000 }).catch(() => {});
  const suite = await page.evaluate(() => window.__studio.rehearse.suite && JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  const started = suite && /Reval long/.test(suite.label) && ['queued', 'running'].includes(suite.status);
  if (started) {
    await page.waitForSelector('#rh-cancel', { timeout: 10000 }).catch(() => {});
    await page.click('#rh-cancel').catch(() => {});
    await page.waitForFunction(() => !['queued', 'running', 'cancelling'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000 }).catch(() => {});
    jobs.longSuite = (await page.evaluate(() => window.__studio.rehearse.suite?.runs?.map(r => r.job_id))) ?? [];
  }
  const shot = await R.shot('long-name-suite');
  assert(started, `Run suite refused for a ${long.length}-character arena name: "${err}"`);
  assert(suite.label.length <= 100 && /· 1 runs?$/.test(suite.label), `label (${suite.label.length}) ${suite.label}`);
  return { label: suite.label, length: suite.label.length, err, shot };
}, { expectHttp: [/422 .*\/api\/suites/] });

await R.save({ arenaId, jobs, timing, suiteObs: { ...suiteObs, p2: undefined } });
await writeFile(path.join(EVIDENCE, 'rehearse-jobs.json'), JSON.stringify({ arenaId: prior.arenaId ?? arenaId, arenaIds: [...new Set([...(prior.arenaIds ?? []), arenaId])], jobs: { ...(prior.jobs ?? {}), ...jobs }, timing: { ...(prior.timing ?? {}), ...timing } }, null, 1));
await browser.close();
