// Deploy workspace, the whole journey in a browser, against the fake deploy hub (tools/fake_deploy_hub.py) (docs/DEPLOY.md).
//   STUDIO_URL=http://127.0.0.1:8792 FAKE_HUB_PORT=8779 node tools/browser/deploy_flow.mjs
// The gateway at STUDIO_URL must have config/local.json deploy_service.url = http://127.0.0.1:FAKE_HUB_PORT and run with
// G1_PANEL_TOKEN=fake-token. This script starts the fake hub itself (it stops it mid-walk for LIVE VIEW LOST) and
// never talks to a robot: the fake is a kinematic puppet. FAKE_SCAN_DIR uses a real scan's memory.npz + twin.json.
//
// Practice: connect, scan, goal (one blocked, one good), rehearse (three runs), start session (checklist), Arm, Start
// SONIC, Clear map, a refused GO with its reason, Send goal, GO, the walk, arrival, tag; E-STOP during a second walk;
// Review; LIVE VIEW LOST with the hub stopped mid-walk, and recovery. Screenshots at 1440x900 and 1024x768.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.STUDIO_URL || 'http://127.0.0.1:8792';
const hubPort = Number(process.env.FAKE_HUB_PORT || 8779);
const shots = process.env.DEPLOY_SHOTS || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/deploy-flow');
const scanDir = process.env.FAKE_SCAN_DIR || null;
await mkdir(shots, { recursive: true });

// ----- the fake hub (killable for LIVE VIEW LOST)
let hub = null;
async function startHub() {
  const args = ['tools/fake_deploy_hub.py', '--port', String(hubPort), '--panel-port', String(hubPort + 1), ...(scanDir ? ['--scan-dir', scanDir] : [])];
  hub = spawn(path.join(root, '.venv/bin/python'), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stderr.on('data', d => process.stderr.write(`[fake hub] ${d}`));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${hubPort}/api/v1/state?t=fake-token`); if (r.ok) return; } catch { /* not up yet */ }
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(`the fake hub did not start on :${hubPort}`);
}
function stopHub() { if (hub && hub.exitCode === null) hub.kill('SIGKILL'); hub = null; }

const report = { base, shots, started: new Date().toISOString(), steps: [], shots_taken: [], errors: [], http: [], outage: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
page.setDefaultTimeout(30000);

// ----- errors: page errors and console errors fail the run; HTTP refusals are expected only where the journey makes them
let window_ = 'boot', outage = false;
const allowed = [];  // [{status, path}] expected right now
page.on('pageerror', e => report.errors.push({ step: window_, kind: 'pageerror', message: e.message }));
page.on('console', m => {
  if (m.type() !== 'error') return;
  if (/Failed to load resource/.test(m.text())) return;  // judged from the response below
  report.errors.push({ step: window_, kind: 'console', message: m.text() });
});
page.on('response', r => {
  if (r.status() < 400) return;
  const u = new URL(r.url()), row = { step: window_, status: r.status(), path: u.pathname };
  if (outage && u.pathname.startsWith('/api/deploy/')) { report.outage.push(row); return; }
  if (allowed.some(a => a.status === r.status() && u.pathname === a.path)) { report.http.push({ ...row, expected: true }); return; }
  report.http.push(row); report.errors.push({ step: window_, kind: 'http', message: `${r.status()} ${u.pathname}` });
});

const S = () => page.evaluate(() => {
  const d = window.__deploy.S;
  return { step: d.step, stateOk: d.stateOk, scan: d.scanName, goal: d.goal?.xy ?? null, goalOk: d.goal?.check?.ok ?? null, goalStatus: d.goal?.status,
    session: Object.values(d.state?.live ?? {}).find(v => v?.running)?.name ?? null, phase: d.panel?.phase ?? null, runner: d.panel?.runner ?? null,
    ladder: Object.fromEntries((d.panel?.ladder ?? []).map(l => [l.key, l.state])), locks: d.panel?.go_locks ?? [], attempts: d.panel?.attempts ?? [],
    rehearsal: (d.state?.rehearsals ?? []).at(-1) ?? null, tracks: d.tracks ? Object.keys(d.tracks) : null, estop: d.estop.state, lease: !!d.lease.id };
});
const until = async (what, fn, timeout = 30000, every = 250) => {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await S(); if (await fn(last)) return last; await page.waitForTimeout(every); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
};
const step = name => { window_ = name; report.steps.push({ name, at: new Date().toISOString() }); console.log(`· ${name}`); };
const shot = async (name, { narrow = false } = {}) => {
  await page.waitForTimeout(450);
  const file = path.join(shots, `${name}.png`); await page.screenshot({ path: file }); report.shots_taken.push(file);
  if (narrow) {
    await page.setViewportSize({ width: 1024, height: 768 }); await page.waitForTimeout(900);
    const f2 = path.join(shots, `${name}-1024.png`); await page.screenshot({ path: f2 }); report.shots_taken.push(f2);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: no horizontal scroll at 1024 px`);
    await page.setViewportSize({ width: 1440, height: 900 }); await page.waitForTimeout(600);
  }
};
const primary = () => page.locator('#dp-primary');
const primaryText = async () => (await primary().textContent()).trim();
const lockText = async () => (await page.locator('.dp-foot .dp-lock').first().textContent().catch(() => '')).trim();
const clickScene = async xy => {
  const pt = await page.evaluate(p => window.__deploy.project([p[0], p[1], 0]), xy);
  await page.mouse.move(pt[0] - 30, pt[1] - 20); await page.mouse.move(pt[0], pt[1], { steps: 4 }); await page.waitForTimeout(250);
  await page.mouse.click(pt[0], pt[1]);
};
const scanName = async () => (await S()).scan;
// Goal candidates from the gateway's own goal check (the same one the page uses).
async function candidates() {
  const scan = await scanName(), out = [];
  for (const x of [1.6, 2.0, 2.4, 2.8, 1.2, 3.2]) for (const y of [0, 0.4, -0.4, 0.8, -0.8, 1.2, -1.2]) {
    const r = await page.request.get(`${base}/api/deploy/goal_check?scan=${encodeURIComponent(scan)}&x=${x}&y=${y}`);
    if (r.ok()) { const c = await r.json(); out.push({ xy: [x, y], ok: c.ok, free: c.checks.find(k => k.id === 'free')?.status, path: c.path_m }); }
  }
  return out;
}

let failure = null;
try {
  await startHub();
  // ------------------------------------------------------------------ Connect
  step('connect');
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__studio?.state?.ready && window.__deploy?.S?.stateOk, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__studio.state.workspace), 'deploy', 'Deploy is the default workspace when the deploy service answers');
  assert.equal(await page.locator('#workspace-deploy').getAttribute('aria-pressed'), 'true');
  assert.equal(await page.locator('[data-mode="practice"]').getAttribute('aria-pressed'), 'true', 'practice is the default mode');
  assert.ok(await primary().isDisabled(), 'Take the controls is locked without a name');
  assert.match(await lockText(), /Type your name/);
  assert.equal(await page.locator('#deploy-estop').isVisible(), false, 'no E-STOP bar while no console runs');
  await page.waitForFunction(() => window.__deploy.d3.robots.scanPose?.root.visible, null, { timeout: 30000 });
  await shot('01-connect', { narrow: true });
  await page.fill('#dp-operator', 'Linji');
  await primary().click();
  await until('the operator lease', s => s.lease);
  assert.match(await primaryText(), /scan the scene/i);
  await shot('02-connect-controls');
  // Readiness drawer: open, then a check with a 3D anchor flies the camera there.
  await page.click('#dp-ready-toggle');
  await page.waitForSelector('.dp-ready-body li[data-anchor]');
  await page.locator('.dp-ready-body li[data-anchor]').first().click();
  await shot('03-readiness-anchor');
  await page.click('#dp-ready-toggle');

  // ------------------------------------------------------------------ Scan
  step('scan');
  await primary().click();
  assert.equal((await S()).step, 'scan');
  const scanBefore = await scanName();
  await page.locator('.dp-foot [data-action="scan"]').click();
  await until('the scan to run', async () => page.evaluate(() => !!window.__deploy.S.scanLive?.running), 10000, 150);
  await page.waitForTimeout(2500);
  await shot('04-scan-running', { narrow: true });
  const afterScan = await until('the new scan', s => s.scan && s.scan !== scanBefore && s.scan.startsWith('practice-'), 30000);
  await page.waitForFunction(() => window.__deploy.S.scene?.name === window.__deploy.S.scanName, null, { timeout: 20000 });
  await shot('05-scan-done');
  assert.match(await primaryText(), /pick a goal/i);

  // ------------------------------------------------------------------ Goal: one blocked, one good
  step('goal');
  await primary().click();
  const cands = await candidates();
  const blocked = cands.find(c => c.free === 'block'), good = cands.filter(c => c.ok && c.path && c.path < 4.5);
  assert.ok(blocked, 'a blocked goal candidate exists'); assert.ok(good.length >= 2, `two good goal candidates exist: ${JSON.stringify(cands)}`);
  const g1 = good[0], g2 = good.find(c => Math.hypot(c.xy[0] - g1.xy[0], c.xy[1] - g1.xy[1]) > 0.9) ?? good[1];
  // Hover first: the disc follows the pointer, coloured by the quick check.
  const hpt = await page.evaluate(p => window.__deploy.project([p[0], p[1], 0]), g1.xy);
  await page.mouse.move(hpt[0], hpt[1], { steps: 5 }); await page.waitForTimeout(500);
  assert.ok(await page.evaluate(() => !!window.__deploy.S.hover), 'the hover disc follows the pointer');
  await shot('06-goal-hover');
  await clickScene(blocked.xy);
  let s1 = await until('the blocked goal check', s => s.goalOk !== null);
  assert.equal(s1.goalOk, false, 'the blocked goal is refused');
  assert.ok(await primary().isDisabled());
  assert.match(await lockText(), /blocked/i);
  assert.ok(await page.evaluate(() => window.__deploy.d3.goalGroup.children.length > 0), 'the refused goal is drawn in 3D');
  await shot('07-goal-blocked', { narrow: true });
  await clickScene(g1.xy);
  s1 = await until('the good goal check', s => s.goalOk === true, 15000);
  await shot('08-goal-good');

  // ------------------------------------------------------------------ Rehearse: three runs, then ghosts on a timeline
  step('rehearse');
  allowed.push({ status: 404, path: '/api/deploy/live' });
  await primary().click();
  assert.match(await primaryText(), /Rehearse 3 runs/);
  await primary().click();
  await until('the rehearsal to run', s => s.rehearsal?.running, 10000);
  await page.waitForTimeout(3500);
  await shot('09-rehearse-running');
  await until('the rehearsal verdict', s => s.rehearsal?.verdict && s.tracks?.length === 3, 180000, 500);
  await page.waitForSelector('#dp-tl', { state: 'visible' });
  const dur = Number(await page.locator('#dp-tl').getAttribute('max'));
  await page.locator('#dp-tl').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, dur * 0.55);
  await shot('10-rehearse-ghosts', { narrow: true });
  assert.match(await primaryText(), /deploy/i);

  allowed.pop();
  // ------------------------------------------------------------------ Deploy: session, ladder, refused GO, Send goal, GO
  step('deploy-start');
  await primary().click();
  assert.match(await primaryText(), /Start practice session/);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  assert.ok(await page.locator('#dp-sheet-ok').isDisabled(), 'Start is locked until every item is ticked');
  await shot('11-start-sheet');
  for (const box of await page.locator('.dp-sheet [data-confirm]').all()) await box.check();
  await page.click('#dp-sheet-ok');
  await until('the practice session', s => !!s.session, 20000);
  await page.waitForSelector('#deploy-estop:not([hidden])');
  assert.equal(await page.locator('#deploy-estop').getAttribute('data-kind'), 'practice', 'the E-STOP bar is practice-styled');
  step('deploy-arm');
  await until('the ladder', s => s.ladder.arm === 'now');
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  await shot('12-arm-sheet');
  await page.locator('.dp-sheet [data-armed]').check();
  await page.click('#dp-sheet-ok');
  await until('the node to stand ready', s => s.phase === 'WAIT', 20000);
  step('deploy-sonic');
  await until('Start SONIC enabled', async () => /Start SONIC/.test(await primaryText()) && !(await primary().isDisabled()), 10000);
  await primary().click();
  await until('CONTROL', s => s.runner === 'CONTROL');
  step('deploy-clear-map');
  await until('Clear map', async () => /Clear map/.test(await primaryText()) && !(await primary().isDisabled()), 10000);
  await primary().click();
  await page.waitForTimeout(2500);
  await shot('13-clear-map-countdown');
  await until('the 10 s rescan', s => s.ladder.map === 'done', 20000, 500);

  // A refused GO shows the console's reason: the page is made to believe GO is open (a stale page), the console says no.
  step('refused-go');
  allowed.push({ status: 409, path: '/api/deploy/act' });
  const panelRoute = url => url.pathname === '/api/deploy/panel';
  await page.route(panelRoute, async route => {
    const res = await route.fetch(); const body = await res.json();
    body.go_locks = []; body.ladder = (body.ladder ?? []).map(l => ({ ...l, state: l.key === 'go' ? 'now' : 'done' }));
    await route.fulfill({ response: res, json: body });
  });
  await until('GO offered by the stale page', async () => /GO/.test(await primaryText()) && !(await primary().isDisabled()), 10000);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  await page.click('#dp-sheet-ok');
  await page.waitForSelector('.dp-sheet .callout.danger', { timeout: 10000 });
  const refusal = await page.locator('.dp-sheet .callout.danger').textContent();
  assert.match(refusal, /Refused by the console: .*goal/i, `the refusal names the console's reason: ${refusal}`);
  await shot('14-go-refused');
  await page.click('#dp-sheet-cancel');
  await page.unroute(panelRoute);
  allowed.pop();
  assert.equal((await S()).attempts.length, 0, 'the refused GO opened no attempt');

  step('send-goal');
  await until('Send goal', async () => /Send goal/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click();
  await page.waitForSelector('.dp-body .callout.ok', { timeout: 15000 });
  assert.match(await page.locator('.dp-body .callout.ok').first().textContent(), /Goal confirmed by the node/);
  await page.waitForFunction(() => window.__deploy.d3.aligned, null, { timeout: 15000 });
  await shot('15-goal-sent-aligned', { narrow: true });
  step('go');
  await until('GO open', async () => /GO/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  await shot('16-go-sheet');
  await page.click('#dp-sheet-ok');
  await until('the walk', s => s.phase === 'RUN', 15000, 150);
  await page.waitForTimeout(1600);
  await shot('17-walking', { narrow: true });
  const walk = await page.evaluate(() => ({ hud: document.querySelectorAll('#dp-hud .dp-hud-item').length, lidar: window.__deploy.d3.ring.counts }));
  assert.ok(walk.hud >= 8, `the HUD shows the live values (${walk.hud})`);
  assert.ok(walk.lidar[1] > 0 && walk.lidar[2] > 0, `self-filtered and rear-blind points are drawn (dimmed): ${walk.lidar}`);
  await until('arrival', s => s.attempts.at(-1)?.outcome === 'arrived', 60000, 300);
  step('tag');
  await page.waitForSelector('.dp-tagcard');
  await page.locator('.dp-tagcard [data-tag="clean"]').click();
  await page.locator('.dp-tagcard input[data-note]').fill('first practice walk, through the gap');
  await page.locator('.dp-tagcard [data-action^="tag:"]').click();
  await until('the tag', s => s.attempts.at(-1)?.tag === 'clean', 10000);
  await shot('18-arrived-tagged');

  // ------------------------------------------------------------------ E-STOP during a second walk
  step('estop');
  await page.click('[data-step="goal"]');
  // From above, so no obstacle stands between the camera and the floor cell (an orbit ray stops at the first column).
  await page.click('[data-cam="top"]'); await page.waitForTimeout(900);
  assert.equal(await page.locator('[data-cam="top"]').getAttribute('aria-pressed'), 'true');
  await clickScene(g2.xy);
  await until('goal 2 checked', s => s.goalOk === true, 15000);
  await shot('19a-goal2-top');
  await page.click('[data-cam="orbit"]');
  await page.click('[data-step="deploy"]');
  await until('Send goal 2', async () => /Send goal/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click();
  await until('GO 2', async () => /GO/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click(); await page.waitForSelector('.dp-sheet'); await page.click('#dp-sheet-ok');
  await until('walk 2', s => s.phase === 'RUN', 15000, 100);
  await page.waitForTimeout(700);
  await page.click('#dp-estop');
  const es = await until('E-STOP confirmed', s => ['confirmed', 'failed'].includes(s.estop), 12000, 100);
  assert.equal(es.estop, 'confirmed', 'E-STOP reached every console and was confirmed');
  await until('the robot stopped', s => s.runner === 'E-STOP', 10000);
  await shot('19b-estop-confirmed', { narrow: true });

  // ------------------------------------------------------------------ End, Review
  step('end');
  await until('End session', async () => !(await page.locator('[data-action="sheet:end"]').isDisabled()), 10000);
  const ended = (await S()).session;
  allowed.push({ status: 404, path: '/api/deploy/live' }, { status: 404, path: '/api/deploy/panel' });
  await page.click('[data-action="sheet:end"]');
  await page.waitForSelector('.dp-sheet'); await page.click('#dp-sheet-ok');
  await until('Review', s => s.step === 'review' && !s.session, 20000);
  await page.waitForSelector('.dp-manifest');
  assert.ok(await page.locator('#dp-review').inputValue() === ended, 'Review opens the session that just ended');
  await shot('20-review', { narrow: true });

  // ------------------------------------------------------------------ LIVE VIEW LOST: the hub stops mid-walk
  step('lost-start');
  await page.click('[data-step="deploy"]');
  await until('Start again', async () => /Start practice session/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click(); await page.waitForSelector('.dp-sheet');
  for (const box of await page.locator('.dp-sheet [data-confirm]').all()) await box.check();
  await page.click('#dp-sheet-ok');
  await until('session 2', s => !!s.session && s.session !== ended, 20000);
  await until('arm 2', s => s.ladder.arm === 'now');
  await primary().click(); await page.waitForSelector('.dp-sheet'); await page.locator('.dp-sheet [data-armed]').check(); await page.click('#dp-sheet-ok');
  await until('WAIT 2', s => s.phase === 'WAIT', 20000);
  await until('SONIC 2', async () => /Start SONIC/.test(await primaryText()) && !(await primary().isDisabled()), 10000); await primary().click();
  await until('Clear map 2', async () => /Clear map/.test(await primaryText()) && !(await primary().isDisabled()), 10000); await primary().click();
  await until('rescan 2', s => s.ladder.map === 'done', 20000, 500);
  await until('Send goal 3', async () => /Send goal/.test(await primaryText()) && !(await primary().isDisabled()), 15000); await primary().click();
  await until('GO 3', async () => /GO/.test(await primaryText()) && !(await primary().isDisabled()), 15000);
  await primary().click(); await page.waitForSelector('.dp-sheet'); await page.click('#dp-sheet-ok');
  await until('walk 3', s => s.phase === 'RUN', 15000, 100);
  step('lost');
  outage = true; stopHub();
  await page.waitForTimeout(4200);
  const lost = await page.evaluate(() => ({ banner: document.getElementById('dp-banners').textContent, hud: document.getElementById('dp-hud').textContent,
    bar: !document.getElementById('deploy-estop').hidden, lost: window.__deploy.d3.lost, label: window.__deploy.d3.lastSeenText,
    primary: document.getElementById('dp-primary')?.disabled }));
  assert.match(lost.banner, /LIVE VIEW LOST — the robot may still be walking/);
  assert.match(lost.hud, /s old/, 'the HUD shows ages, never old numbers as live');
  assert.ok(lost.bar && lost.lost && /LAST SEEN/.test(lost.label ?? ''), JSON.stringify(lost));
  assert.equal(await page.locator('#dp-estop').isDisabled(), false, 'E-STOP stays live');
  await shot('21-live-view-lost', { narrow: true });
  step('recover');
  await startHub();
  await page.waitForFunction(() => window.__deploy.S.stateOk === true && document.getElementById('deploy-estop').hidden, null, { timeout: 20000 });
  await page.waitForTimeout(1500);
  outage = false;
  await shot('22-recovered');
  // A Replay round trip leaves Replay working: its recording opens on the first visit.
  step('replay');
  await page.click('#workspace-replay');
  await page.waitForFunction(() => window.__studio.state.session && document.getElementById('loading-overlay').hidden, null, { timeout: 90000 });
  assert.equal(await page.evaluate(() => window.__deploy.d3.root.visible), false, 'Deploy\'s scene is hidden in Replay');
  await shot('23-replay-after-deploy');
  await page.click('#workspace-deploy');
  await page.waitForTimeout(800);
} catch (error) {
  failure = error;
  await page.screenshot({ path: path.join(shots, `failure-${window_}.png`) }).catch(() => {});
} finally {
  report.finished = new Date().toISOString();
  report.failure = failure ? String(failure.stack ?? failure) : null;
  await writeFile(path.join(shots, 'deploy-flow.json'), JSON.stringify(report, null, 1));
  await browser.close();
  stopHub();
}
if (failure) { console.error(`FAIL at ${window_}: ${failure.message}`); process.exit(1); }
assert.deepEqual(report.errors, [], `console, page or HTTP errors: ${JSON.stringify(report.errors, null, 1)}`);
console.log(JSON.stringify({ passed: report.steps.length, shots: report.shots_taken.length, outage_requests: report.outage.length, expected_http: report.http.length, shots_dir: shots }, null, 1));
