// Deploy workspace, the edges an external review found (Astra, 2026-10-28), expecting the FIXED behaviour, against the
// fake deploy hub v3 and its fault switches (tools/fake_deploy_hub.py). Each check records pass/fail and the run goes
// on; the exit code is 1 when any check failed.
//   STUDIO_URL=http://127.0.0.1:8792 FAKE_HUB_PORT=8779 STUDIO_DATA=<the gateway's --data-root> node tools/browser/deploy_edges.mjs
// The gateway at STUDIO_URL must point at http://127.0.0.1:FAKE_HUB_PORT (G1_DEPLOY_SERVICE) with G1_PANEL_TOKEN=fake-token.
// This script starts the fake hub itself (with --studio-data STUDIO_DATA so Replay can open its sessions) and never
// talks to a robot. ONLY=F01,F03 runs a subset.
//
// F01 whose session: a fresh browser, a browser with Practice stored, a second browser, every press carries the session.
// F02 the rehearsal set: newest-first newer failure, a rerun in progress, changed odometry, changed profile contents,
//     another start, a missing identity field.
// F03 freshness: panel-only freeze, view-only freeze, hub down with the console alive, console hung with the hub alive,
//     both at once (a cached console age must age), a hidden tab coming back, a request stalled mid-confirmation.
// F04 rehearsal cases: a required gap (passage), a detour is no task pass, a partial set has no verdict, no precision claim.
// F05 Review: an attempt completed, tagged, reopened from its link in a fresh browser, re-tagged, opened in Replay.
// F06 goal check basis and freshness. F07 a dropped act reply, Review and track 503s then recovery.
// Design: 390 px current action, keyboard walk of every sheet.
// Verification round (D1-D13): Review requests bounded for an unknown and a failing session; recording states from a
// detail recorded from the real kit (finalized, stalled); a failing rehearsal on fused odometry asks for the override.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.STUDIO_URL || 'http://127.0.0.1:8792';
const hubPort = Number(process.env.FAKE_HUB_PORT || 8779);
const studioData = process.env.STUDIO_DATA || null;
const shots = process.env.DEPLOY_SHOTS || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/deploy-edges');
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
await mkdir(shots, { recursive: true });

// ----- the fake hub
let hub = null;
async function startHub() {
  const args = ['tools/fake_deploy_hub.py', '--port', String(hubPort), '--panel-port', String(hubPort + 1), ...(studioData ? ['--studio-data', studioData] : [])];
  hub = spawn(path.join(root, '.venv/bin/python'), args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  hub.stderr.on('data', d => process.stderr.write(`[fake hub] ${d}`));
  for (let i = 0; i < 80; i++) {
    try { const r = await fetch(`http://127.0.0.1:${hubPort}/api/v1/state?t=fake-token`); if (r.ok) return; } catch { /* not up yet */ }
    await sleep(150);
  }
  throw new Error(`the fake hub did not start on :${hubPort}`);
}
function stopHub() { if (hub && hub.exitCode === null) hub.kill('SIGKILL'); hub = null; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function hubPost(p, body = {}) {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${hubPort}${p}?t=fake-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      return await r.json();
    } catch { await sleep(250); }  // the hub may be coming back from hub_down_s
  }
  throw new Error(`the fake hub did not answer ${p}`);
}
async function hubGet(p) { const r = await fetch(`http://127.0.0.1:${hubPort}${p}${p.includes('?') ? '&' : '?'}t=fake-token`); return r.json(); }
const faults = f => hubPost('/api/fake/faults', f);
const resetFaults = () => faults({ reset: true });
async function endAll() { for (const slot of ['robot', 'sim']) await hubPost('/api/fake/end', { slot }); await sleep(1200); }
async function startRobot(extra = {}) {
  const r = await hubPost('/api/v1/start', { mode: 'robot', profile: 'deploy', odom: 'fused', operator: 'Linji', scan: (await hubGet('/api/v1/state')).scans?.[0]?.name,
    confirm: { gantry: true, estop: true, remote: true, rope: true }, ...extra });
  if (!r.name) throw new Error(`the fake robot session did not start: ${JSON.stringify(r)}`);
  return r.name;
}

// ----- the browser
const report = { base, shots, started: new Date().toISOString(), checks: [], errors: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const contexts = [];
let faultWindow = false, lastPage = null;
const BENIGN = [/\/api\/deploy\/(live|panel)$/];  // 404 after a session ends, between two state polls
async function openPage({ width = 1440, height = 900, init = null, query = '?workspace=deploy', label = 'page', allow = [], before = null } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  contexts.push(context);
  if (init) await context.addInitScript(init);
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  lastPage = page;
  page.__requests = [];
  page.on('pageerror', e => report.errors.push({ page: label, kind: 'pageerror', message: e.message }));
  page.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) report.errors.push({ page: label, kind: 'console', message: m.text() }); });
  page.on('request', r => { if (r.url().includes('/api/deploy/')) page.__requests.push({ path: new URL(r.url()).pathname, method: r.method(), body: r.postData() }); });
  page.on('response', r => {
    if (r.status() < 400) return;
    const p = new URL(r.url()).pathname;
    if (faultWindow || (r.status() === 404 && BENIGN.some(re => re.test(p))) || (r.status() === 409 && p === '/api/deploy/lease') || allow.some(a => a.status === r.status() && a.path === p)) return;
    report.errors.push({ page: label, kind: 'http', message: `${r.status()} ${p}` });
  });
  if (before) await before(page);
  await page.goto(`${base}/${query}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__studio?.state?.ready !== undefined && window.__deploy?.S?.stateOk, null, { timeout: 60000 });
  await page.waitForTimeout(1500);
  return page;
}
async function closeAll() { while (contexts.length) await contexts.pop().close().catch(() => {}); }
const until = async (page, what, fn, arg, timeout = 20000) => {
  try { return await page.waitForFunction(fn, arg, { timeout, polling: 100 }); } catch { throw new Error(`timed out waiting for ${what}`); }
};
const primary = page => page.evaluate(() => { const b = document.getElementById('dp-primary'); return { text: b?.textContent.trim() ?? '', disabled: !!b?.disabled, lock: document.querySelector('.dp-foot .dp-lock')?.textContent.trim() ?? '' }; });
const shot = async (page, name) => { const f = path.join(shots, `${name}.png`); await page.screenshot({ path: f }); return f; };
async function check(id, name, fn) {
  if (only && !only.has(id)) return;
  const row = { id, name, pass: false, detail: null };
  const t0 = Date.now();
  console.log(`· ${id} ${name}`);
  try { row.detail = await fn() ?? null; row.pass = true; } catch (e) {
    row.error = String(e?.stack ?? e).slice(0, 1600);
    if (lastPage && !lastPage.isClosed()) {
      row.failureShot = await shot(lastPage, `fail-${id}-${report.checks.length}`).catch(() => null);
      row.panel = await lastPage.evaluate(() => document.querySelector('.dp-panel-content')?.innerText?.slice(0, 1500)).catch(() => null);
    }
  }
  row.seconds = Math.round((Date.now() - t0) / 100) / 10;
  faultWindow = false;
  await resetFaults().catch(() => {});
  report.checks.push(row);
  console.log(`  ${row.pass ? 'PASS' : 'FAIL'} (${row.seconds} s)${row.pass ? '' : `: ${row.error.split('\n')[0]}`}`);
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };
const typeName = async (page, name) => { await page.evaluate(() => window.__deploy.setStep('connect')); await page.fill('#dp-operator', name); await page.waitForTimeout(200); };
// Take the controls; a page closed earlier may still hold the lease for its last 3 s: then take over (logged).
async function takeControls(page, name) {
  await typeName(page, name); await page.click('#dp-primary');
  await until(page, 'the lease or a conflict', () => !!window.__deploy.S.lease.id || !!window.__deploy.S.lease.conflict, null, 10000);
  if (await page.evaluate(() => !window.__deploy.S.lease.id)) { await page.click('#dp-primary'); await until(page, 'the lease', () => !!window.__deploy.S.lease.id, null, 10000); }
}
async function attach(page, name) {
  await typeName(page, name);
  await page.click('#dp-primary');
  await until(page, 'attached or a conflict', () => window.__deploy.fn.attached() || !!window.__deploy.S.lease.conflict, null, 10000);
  if (!(await page.evaluate(() => window.__deploy.fn.attached()))) await page.click('#dp-primary');
  await until(page, 'attached', () => window.__deploy.fn.attached() && !!window.__deploy.S.lease.id);
}
// From a fresh robot session to GO open: goal, Arm, Start SONIC, Clear map, Send goal (through the page).
async function ladderToGo(page, goal = [1.6, 0]) {
  await page.evaluate(g => { window.__deploy.setStep('goal'); return window.__deploy.checkGoal(g); }, goal);
  await until(page, 'a usable goal', () => ['pass', 'warn'].includes(window.__deploy.fn.goalStatus()));
  await page.evaluate(() => window.__deploy.setStep('deploy'));
  await until(page, 'Arm', () => /Arm/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled);
  await page.click('#dp-primary'); await page.waitForSelector('.dp-sheet');
  await page.locator('.dp-sheet [data-armed]').check(); await page.click('#dp-sheet-ok');
  for (const [label, re] of [['Start SONIC', /Start SONIC/], ['Clear map', /Clear map/], ['Send goal', /Send goal/]]) {
    await until(page, label, r => new RegExp(r).test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, re.source, 40000);
    await page.click('#dp-primary');
  }
  await until(page, 'GO open', () => /GO/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, null, 30000);
}
// Keyboard: open a sheet from its opener with Enter, Tab around (the sheet and E-STOP only), Escape, focus back.
async function keyboardWalk(page, opener, expectFocus) {
  await page.focus(opener); await page.keyboard.press('Enter');
  await page.waitForSelector('.dp-sheet');
  const seen = new Set();
  for (let i = 0; i < 14; i++) { await page.keyboard.press('Tab'); seen.add(await page.evaluate(() => (document.activeElement.closest('.dp-sheet') ? 'sheet' : document.activeElement.id === 'dp-estop' ? 'estop' : `out:${document.activeElement.tagName}#${document.activeElement.id}`))); }
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Escape'); await page.waitForTimeout(250);
  const after = await page.evaluate(() => ({ open: !!document.querySelector('.dp-sheet'), focus: document.activeElement?.id || document.activeElement?.dataset?.action || document.activeElement?.tagName }));
  const estopShown = await page.evaluate(() => !document.getElementById('deploy-estop').hidden);
  assert(!after.open, `${opener}: Escape closed the sheet`);
  assert([...seen].every(x => x === 'sheet' || x === 'estop') && (!estopShown || seen.has('estop')), `${opener}: Tab stays in the sheet${estopShown ? ' and reaches E-STOP' : ''}: ${[...seen]}`);
  assert(after.focus === expectFocus, `${opener}: focus back on its opener (${after.focus})`);
  return { seen: [...seen], focus: after.focus };
}
const goOpen = page => page.evaluate(() => { const b = document.getElementById('dp-primary'); return /GO/.test(b?.textContent ?? '') && !b.disabled; });

let failure = null;
try {
  await startHub();

  // ================================================================== F01: whose session
  await check('F01', 'fresh browser while a robot session runs: robot wording, viewing only, attach step', async () => {
    await endAll();
    const name = await startRobot();
    const page = await openPage({ label: 'fresh' });
    await page.evaluate(() => window.__deploy.setStep('deploy'));
    await page.waitForTimeout(800);
    const m = await page.evaluate(() => {
      const D = window.__deploy, f = D.fn; D.S.sheet = { kind: 'arm', confirm: {}, armed: true }; f.renderAll();
      const sheet = f.sheetModel(); D.S.sheet = null; f.renderAll();
      return { isRobot: f.isRobot(), attached: f.attached(), bar: document.getElementById('dpe-title').textContent, ctx: document.getElementById('deploy-context').textContent,
        ident: document.getElementById('dp-identity').innerText, primary: document.getElementById('dp-primary').textContent, sheetTone: sheet.tone, sheetLock: String(sheet.locked?.text ?? sheet.locked ?? ''),
        sheetBody: sheet.body, mode: D.S.mode };
    });
    await shot(page, 'f01-fresh-browser');
    assert(m.isRobot && m.mode === 'practice', `the receipt says robot although this browser's next mode is ${m.mode}: ${JSON.stringify(m)}`);
    assert(/ROBOT LIVE/.test(m.bar) && /Robot session/.test(m.ctx) && /ROBOT/.test(m.ident) && /Viewing only/.test(m.ident), `robot wording everywhere: ${JSON.stringify(m)}`);
    assert(/Attach to this robot session/.test(m.primary), `the attach step is the action: ${m.primary}`);
    assert(m.sheetTone === 'robot' && /gantry/.test(m.sheetBody) && !/practising/.test(m.sheetBody), 'the Arm sheet uses robot wording');
    assert(/Viewing only/.test(m.sheetLock), `the Arm sheet is locked for a viewer: ${m.sheetLock}`);
    return { session: name, ...m, sheetBody: undefined };
  });

  await check('F01', 'browser with Practice stored: next-session settings never relabel the running robot session', async () => {
    const page = await openPage({ label: 'stored-practice', init: () => { localStorage.setItem('studio.deploy.mode', 'practice'); localStorage.setItem('studio.deploy.profile', 'near'); localStorage.setItem('studio.deploy.step', 'connect'); } });
    await page.evaluate(() => window.__deploy.setStep('connect'));
    const before = await page.evaluate(() => ({ ident: document.getElementById('dp-identity').innerText, card: document.querySelector('.dp-session-card')?.innerText, next: document.querySelector('[data-mode="practice"]').getAttribute('aria-pressed'), profileSel: document.getElementById('dp-profile').value }));
    await page.selectOption('#dp-profile', 'low-margin'); await page.click('[data-mode="practice"]'); await page.waitForTimeout(500);
    const after = await page.evaluate(() => ({ ident: document.getElementById('dp-identity').innerText, ctx: document.getElementById('deploy-context').textContent, card: document.querySelector('.dp-session-card')?.innerText, profile: window.__deploy.fn.ident().profile, isRobot: window.__deploy.fn.isRobot() }));
    await shot(page, 'f01-stored-practice');
    assert(/REAL ROBOT SESSION/.test(before.card) && /Deploy default/.test(before.card), `the session card describes the robot session: ${before.card}`);
    assert(before.next === 'true' && before.profileSel === 'near', 'the stored settings show as the NEXT session');
    assert(after.isRobot && after.profile === 'deploy' && /ROBOT/.test(after.ident) && /Deploy default/.test(after.ident) && /Robot session/.test(after.ctx), `changing next-session settings did not relabel it: ${JSON.stringify(after)}`);
    return { before, after };
  });

  await check('F01', 'second browser: read-only viewer; taking control is an explicit takeover; every press carries the session', async () => {
    await closeAll();
    const a = await openPage({ label: 'A' });
    await attach(a, 'Linji');
    const b = await openPage({ label: 'B' });
    await b.evaluate(() => window.__deploy.setStep('deploy')); await b.waitForTimeout(500);
    const bView = await b.evaluate(() => ({ attached: window.__deploy.fn.attached(), primary: document.getElementById('dp-primary').textContent, ident: document.getElementById('dp-identity').innerText }));
    await typeName(b, 'Visitor'); await b.click('#dp-primary');
    await until(b, 'the takeover offer', () => /Take over from Linji/.test(document.getElementById('dp-primary')?.textContent ?? ''));
    const aStill = await a.evaluate(() => window.__deploy.fn.attached() && !!window.__deploy.S.lease.id && !window.__deploy.S.lease.lost);
    // A presses Arm: the press carries expect.session and the reply names the session.
    await a.evaluate(() => window.__deploy.setStep('deploy'));
    await until(a, 'Arm', () => /Arm/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled);
    await a.click('#dp-primary'); await a.waitForSelector('.dp-sheet');
    const sheetWho = await a.locator('#dp-sheet-who').textContent();
    await a.locator('.dp-sheet [data-armed]').check(); await a.click('#dp-sheet-ok');
    await until(a, 'the Arm reply', () => !!document.querySelector('.dp-ladder em.ok, .dp-ladder li.done'), null, 15000);
    const armReq = a.__requests.filter(r => r.path === '/api/deploy/act' && r.body && JSON.parse(r.body).act === 'arm').map(r => JSON.parse(r.body));
    const sess = await a.evaluate(() => window.__deploy.fn.session().name);
    const note = await a.evaluate(() => document.querySelector('.dp-ladder em.ok')?.textContent ?? '');
    await shot(b, 'f01-second-browser');
    assert(!bView.attached && /Attach/.test(bView.primary) && /Viewing only/.test(bView.ident), `B is a viewer: ${JSON.stringify(bView)}`);
    assert(aStill, 'A keeps the controls until B takes over explicitly');
    assert(new RegExp(sess).test(sheetWho), `the Arm sheet names the session: ${sheetWho}`);
    assert(armReq.length === 1 && armReq[0].expect?.session === sess, `Arm carried expect.session once: ${JSON.stringify(armReq)}`);
    return { bView, sheetWho, expect: armReq[0].expect, note };
  });

  // ================================================================== F03: freshness (A attached, ladder to GO)
  let A = null;
  await check('F03', 'ladder to GO with every source fresh', async () => {
    await closeAll(); await endAll();
    await startRobot();
    A = await openPage({ label: 'A' });
    await attach(A, 'Linji');
    await ladderToGo(A);
    const src = await A.evaluate(() => Object.fromEntries(['hub', 'console', 'panel', 'view', 'lidar', 'map'].map(n => [n, window.__deploy.fn.srcState(n)])));
    const hb = A.__requests.filter(r => r.path === '/api/deploy/heartbeat').length;
    assert(Object.values(src).every(s => s === 'fresh'), `every source fresh: ${JSON.stringify(src)}`);
    assert(hb > 3, `the console heartbeat is polled (${hb})`);
    await shot(A, 'f03-go-open');
    return { src, heartbeatRequests: hb };
  });

  const goLockedBy = (page, re, timeout = 8000) => until(page, `GO locked by ${re}`, r => { const b = document.getElementById('dp-primary'); const l = document.querySelector('.dp-foot .dp-lock')?.textContent ?? ''; return b?.disabled && new RegExp(r).test(l); }, re, timeout);
  const goBack = (page, timeout = 15000) => until(page, 'GO open again', () => { const b = document.getElementById('dp-primary'); return /GO/.test(b?.textContent ?? '') && !b.disabled; }, null, timeout);

  await check('F03', 'stale at 1.5 s locks GO (Astra probe 3): a frozen node view', async () => {
    assert(await goOpen(A), 'GO was open');
    faultWindow = true; await faults({ freeze_view: true });
    await until(A, 'view age 1.5 s', () => (window.__deploy.fn.srcAge('view') ?? 0) >= 1.5, null, 6000);
    const m = await A.evaluate(() => { const f = window.__deploy.fn; const S = window.__deploy.S; const row = f.ladderRows().find(r => r.key === 'go'); S.sheet = { kind: 'go', ack: true }; const sheet = f.sheetModel(); S.sheet = null; f.renderAll();
      return { liveState: f.liveState(), age: f.srcAge('view'), goLock: String(row.lock?.text ?? row.lock ?? ''), sheetLock: String(sheet.locked?.text ?? sheet.locked ?? ''),
        hudPhase: [...document.querySelectorAll('#dp-hud .dp-hud-item')].find(e => /Phase/i.test(e.querySelector('span').textContent))?.textContent,
        hudDriving: [...document.querySelectorAll('#dp-hud .dp-hud-item')].find(e => /Driving/i.test(e.querySelector('span').textContent))?.textContent };
    });
    await goLockedBy(A, 'Node view');
    await shot(A, 'f03-view-frozen');
    assert(m.liveState === 'stale' && /Node view/.test(m.goLock) && /Node view/.test(m.sheetLock), `stale view locks GO and its sheet: ${JSON.stringify(m)}`);
    assert(/s old/.test(m.hudPhase) && !/s old/.test(m.hudDriving), `HUD: the view's values show their age, the panel's do not: ${JSON.stringify(m)}`);
    await resetFaults(); faultWindow = false; await goBack(A);
    return m;
  });

  await check('F03', 'panel-only freeze: GO locks on the console panel; the node view stays fresh', async () => {
    faultWindow = true; await faults({ freeze_panel: true });
    await goLockedBy(A, 'Console panel', 9000);
    const m = await A.evaluate(() => ({ view: window.__deploy.fn.srcState('view'), panel: window.__deploy.fn.srcState('panel'), lock: document.querySelector('.dp-foot .dp-lock')?.textContent,
      driving: [...document.querySelectorAll('#dp-hud .dp-hud-item')].find(e => /Driving/i.test(e.querySelector('span').textContent))?.textContent }));
    await shot(A, 'f03-panel-frozen');
    assert(m.view === 'fresh' && m.panel !== 'fresh' && /s old/.test(m.driving), `panel stale, view fresh, panel HUD values aged: ${JSON.stringify(m)}`);
    await resetFaults(); faultWindow = false; await goBack(A);
    return m;
  });

  await check('F03', 'hub down with the console alive: heartbeat stays fresh on the direct path, GO locks, E-STOP live', async () => {
    faultWindow = true; await faults({ hub_down_s: 7 });
    await goLockedBy(A, 'Deploy service', 9000);
    const m = await A.evaluate(() => ({ alarm: !document.getElementById('dpe-alarm').hidden, sub: document.getElementById('dpe-sub').textContent, console: window.__deploy.fn.srcState('console'),
      estop: !document.getElementById('dp-estop').disabled, stand: !document.getElementById('dp-stand').disabled }));
    await shot(A, 'f03-hub-down');
    assert(!m.alarm && m.console === 'fresh' && /console heartbeat .*direct/.test(m.sub), `console alive, no false alarm: ${JSON.stringify(m)}`);
    assert(m.estop && m.stand, 'E-STOP and Stand stay live');
    await until(A, 'the service back', () => window.__deploy.S.stateOk === true, null, 20000);
    faultWindow = false; await goBack(A, 20000);
    return m;
  });

  await check('F03', 'console hung with the hub alive: CONSOLE NOT RESPONDING, GO locked on the heartbeat, stops live', async () => {
    faultWindow = true; await faults({ hang_console: true });
    await until(A, 'the console alarm', () => !document.getElementById('dpe-alarm').hidden, null, 6000);
    await goLockedBy(A, 'Console heartbeat|Console panel', 6000);
    const m = await A.evaluate(() => ({ console: window.__deploy.fn.srcState('console'), hub: window.__deploy.fn.srcState('hub'), lock: document.querySelector('.dp-foot .dp-lock')?.textContent, estop: !document.getElementById('dp-estop').disabled }));
    await shot(A, 'f03-console-hung');
    assert(m.hub === 'fresh' && m.console !== 'fresh' && m.estop, JSON.stringify(m));
    await resetFaults(); faultWindow = false;
    await until(A, 'the alarm clears', () => document.getElementById('dpe-alarm').hidden, null, 10000);
    await goBack(A);
    return m;
  });

  await check('F03', 'hub down AND console hung: the cached console age ages (Astra probe 4)', async () => {
    faultWindow = true; await faults({ hang_console: true }); await faults({ hub_down_s: 6 });
    await until(A, 'the console alarm', () => !document.getElementById('dpe-alarm').hidden, null, 7000);
    const m = await A.evaluate(() => ({ alarm: !document.getElementById('dpe-alarm').hidden, sub: document.getElementById('dpe-sub').textContent, stateOk: window.__deploy.S.stateOk }));
    await shot(A, 'f03-hub-down-console-hung');
    await resetFaults();
    await until(A, 'the service back', () => window.__deploy.S.stateOk === true, null, 20000);
    faultWindow = false; await goBack(A, 20000);
    assert(m.alarm, JSON.stringify(m));
    return m;
  });

  await check('F03', 'a hidden tab coming back starts stale, then fresh', async () => {
    const m = await A.evaluate(async () => {
      const set = v => { Object.defineProperty(document, 'hidden', { value: v, configurable: true }); Object.defineProperty(document, 'visibilityState', { value: v ? 'hidden' : 'visible', configurable: true }); document.dispatchEvent(new Event('visibilitychange')); };
      set(true); await new Promise(r => setTimeout(r, 300)); set(false);
      const b = document.getElementById('dp-primary');
      return { disabled: b.disabled, lock: document.querySelector('.dp-foot .dp-lock')?.textContent ?? '', view: window.__deploy.fn.srcState('view') };
    });
    await shot(A, 'f03-hidden-return');
    assert(m.disabled && /background/.test(m.lock) && m.view === 'stale', `back from the background: stale first: ${JSON.stringify(m)}`);
    await goBack(A, 6000);
    return m;
  });

  await check('F03', 'a request stalled mid-confirmation: the open GO sheet locks in place, focus stays put', async () => {
    await A.click('#dp-primary'); await A.waitForSelector('.dp-sheet');
    await A.focus('#dp-sheet-cancel');
    const okBefore = await A.evaluate(() => !document.getElementById('dp-sheet-ok').disabled || /Tick/.test(document.querySelector('#dp-sheet-lock')?.textContent ?? ''));
    faultWindow = true; await faults({ hub_delay_s: 4 });
    await until(A, 'the sheet locks', () => document.getElementById('dp-sheet-ok').disabled && /stale|old|background/.test(document.querySelector('#dp-sheet-lock')?.textContent ?? ''), null, 8000);
    const m = await A.evaluate(() => ({ lock: document.querySelector('#dp-sheet-lock')?.textContent, focus: document.activeElement?.id }));
    await shot(A, 'f03-stalled-in-sheet');
    await resetFaults(); faultWindow = false;
    await until(A, 'the sheet unlocks', () => !/stale|old/.test(document.querySelector('#dp-sheet-lock')?.textContent ?? ''), null, 15000);
    await A.click('#dp-sheet-cancel');
    assert(okBefore && m.focus === 'dp-sheet-cancel', `focus kept on Cancel while the lock changed: ${JSON.stringify(m)}`);
    return m;
  });

  await check('N3', 'a stalled (slow, not down) deploy service for 8 s: the operator keeps the controls', async () => {
    const before = await A.evaluate(() => window.__deploy.S.lease.id);
    assert(before, 'holding the lease before the stall');
    faultWindow = true; await faults({ hub_delay_s: 4 });
    await A.waitForTimeout(8000);
    const during = await A.evaluate(() => ({ id: window.__deploy.S.lease.id, lost: window.__deploy.S.lease.lost ?? null }));
    await resetFaults(); faultWindow = false;
    await A.waitForTimeout(3000);
    const after = await A.evaluate(() => ({ id: window.__deploy.S.lease.id, lost: window.__deploy.S.lease.lost ?? null }));
    assert(during.id === before && !during.lost, `the lease survived the stall: ${JSON.stringify(during)}`);
    assert(after.id === before && !after.lost, `and after it: ${JSON.stringify(after)}`);
    return { during, after };
  });

  // ================================================================== F07: an act whose reply is lost
  await check('F07', 'dropped act reply: "acknowledgement unavailable", never "refused", never resent, then known', async () => {
    assert(A, 'needs the attached page');
    const n0 = A.__requests.filter(r => r.path === '/api/deploy/act' && r.body && JSON.parse(r.body).act === 'c').length;
    await faults({ console_drop_reply: 1, console_drop_acts: ['c'] });
    // Clear map again (the done rung's "Again"): a motion-enabling press the console applies and whose reply is lost.
    await A.evaluate(() => document.querySelector('.dp-ladder [data-action="ladder:map"]')?.click());
    await until(A, 'the unknown state', () => /acknowledgement unavailable/i.test(document.querySelector('.dp-panel-content')?.textContent ?? ''), null, 12000);
    const during = await A.evaluate(() => ({ text: document.querySelector('.dp-panel-content').textContent, go: document.getElementById('dp-primary')?.disabled }));
    await shot(A, 'f07-unknown');
    await until(A, 'the console record', () => /record says it was received/i.test(document.querySelector('.dp-panel-content')?.textContent ?? ''), null, 20000);
    const n1 = A.__requests.filter(r => r.path === '/api/deploy/act' && r.body && JSON.parse(r.body).act === 'c').length;
    const statusAsks = A.__requests.filter(r => r.path === '/api/deploy/act_status').length;
    assert(!/refused/i.test(during.text.match(/Clear map[^.]*\./)?.[0] ?? ''), 'not called refused');
    assert(n1 - n0 === 1, `pressed once, never resent (${n1 - n0})`);
    assert(statusAsks > 0, 'reconciled through act_status');
    return { sent: n1 - n0, statusAsks };
  });

  // ================================================================== Design: keyboard walk of the sheets (robot session)
  await check('Design', 'keyboard walk of the GO and End sheets: focus trapped (with E-STOP), Escape cancels, focus returns', async () => {
    // Clear map again (F07) opened a new cycle: Send goal, then GO.
    await until(A, 'Send goal or GO', () => /Send goal|GO/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, null, 30000);
    if (/Send goal/.test(await A.locator('#dp-primary').textContent())) await A.click('#dp-primary');
    await goBack(A, 20000);
    const out = {};
    for (const kind of ['go', 'end']) {
      if (kind === 'go') { await A.focus('#dp-primary'); await A.keyboard.press('Enter'); }
      else { await A.focus('.dp-foot [data-action="sheet:end"]'); await A.keyboard.press('Enter'); }
      await A.waitForSelector('.dp-sheet');
      const seen = new Set();
      for (let i = 0; i < 12; i++) { await A.keyboard.press('Tab'); seen.add(await A.evaluate(() => (document.activeElement.closest('.dp-sheet') ? 'sheet' : document.activeElement.id === 'dp-estop' ? 'estop' : `out:${document.activeElement.tagName}#${document.activeElement.id}`))); }
      await A.keyboard.press('Shift+Tab');
      await A.keyboard.press('Escape');
      await A.waitForTimeout(250);
      const after = await A.evaluate(() => ({ open: !!document.querySelector('.dp-sheet'), focus: document.activeElement?.id || document.activeElement?.dataset?.action || document.activeElement?.tagName }));
      out[kind] = { seen: [...seen], ...after };
      assert(!after.open, `${kind}: Escape closed it`);
      assert([...seen].every(s => s === 'sheet' || s === 'estop') && seen.has('estop'), `${kind}: Tab stays in the sheet and reaches E-STOP: ${[...seen]}`);
      assert(['dp-primary', 'sheet:end'].includes(after.focus), `${kind}: focus back on its opener: ${after.focus}`);
    }
    return out;
  });

  await check('D3', 'robot, FAST-LIO + legs, a matching set that fails with drift: the override tick is required and goes with GO', async () => {
    const scan = await A.evaluate(() => window.__deploy.S.scanName);
    await hubPost('/api/fake/rehearsals', { scan, goal_scene: [1.6, 0], profile: 'deploy', odom: 'fused', sets: [{ minutes_ago: 0.5, state: 'complete', verdict: 'fails with drift', label: 'fused-fail' }] });
    await until(A, 'the failing set matched', () => /fused-fail/.test(window.__deploy.fn.rehearsalFor()?.name ?? ''), null, 12000);
    await goBack(A, 20000);
    await A.click('#dp-primary'); await A.waitForSelector('.dp-sheet');
    const m = await A.evaluate(() => ({ caution: document.querySelector('.dp-sheet .dp-caution')?.textContent ?? '', okDisabled: document.getElementById('dp-sheet-ok').disabled,
      lock: document.querySelector('#dp-sheet-lock')?.textContent ?? '', green: !!document.querySelector('.dp-sheet .tiny.ok'), body: document.querySelector('.dp-sheet-body').innerText }));
    await shot(A, 'd3-fused-failing-set');
    assert(/fails with the injected leg drift/i.test(m.caution) && /models leg odometry/.test(m.caution), `the caution names the failing set and the odometry context: ${m.caution}`);
    assert(m.okDisabled && /Tick the line above/.test(m.lock) && !m.green, `GO waits for the tick and never ends green: ${JSON.stringify(m)}`);
    await A.locator('.dp-sheet [data-ack]').check();
    await until(A, 'GO enabled by the tick', () => !document.getElementById('dp-sheet-ok').disabled, null, 5000);
    await A.click('#dp-sheet-ok');
    await until(A, 'the GO press', () => !document.querySelector('.dp-sheet'), null, 10000);
    const g = A.__requests.filter(r => r.path === '/api/deploy/act' && r.body && JSON.parse(r.body).act === 'g').map(r => JSON.parse(r.body)).at(-1);
    assert(g?.rehearsal_override?.operator && /fails with/i.test(g.rehearsal_override.reason ?? '') && /fused-fail/.test(g.rehearsal?.name ?? ''), `GO carried the override and the set: ${JSON.stringify(g)}`);
    await until(A, 'the walk ends', () => (window.__deploy.S.panel?.attempts ?? []).some(a => a.result ?? a.outcome), null, 60000);
    return { caution: m.caution, override: g.rehearsal_override, rehearsal: g.rehearsal };
  });

  await check('Design', '390 px: the current action is reachable without scrolling; the E-STOP bar stays; the map collapses', async () => {
    await A.setViewportSize({ width: 390, height: 844 });
    await A.evaluate(() => { scrollTo(0, 0); window.__deploy.setStep('deploy'); });
    await A.waitForTimeout(800);
    const m = await A.evaluate(() => {
      const b = document.getElementById('dp-primary').getBoundingClientRect(), e = document.getElementById('dp-estop').getBoundingClientRect();
      const hit = document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2);
      return { primary: b.toJSON(), estop: e.toJSON(), vh: innerHeight, scrollY, topmost: hit?.id === 'dp-primary' || !!hit?.closest?.('#dp-primary'), docW: document.documentElement.scrollWidth };
    });
    await shot(A, 'design-390-deploy');
    await A.click('#dp-map-toggle'); await A.waitForTimeout(500);
    const collapsed = await A.evaluate(() => document.getElementById('viewport-shell').getBoundingClientRect().height);
    await shot(A, 'design-390-map-collapsed');
    await A.click('#dp-map-toggle');
    // A failing audit log with a long path wraps (no horizontal scroll at 390 px).
    const linkRoute = u => u.pathname === '/api/deploy/link';
    await A.route(linkRoute, async route => { const res = await route.fetch(), body = await res.json(); body.audit = { ok: false, errors: 3, last_error: "PermissionError: [Errno 13] Permission denied: '/tmp/claude-1000/a/very/long/path/to/the/studio/data/root/deploy/gateway_actions.jsonl'", at: Date.now() / 1000 }; await route.fulfill({ response: res, json: body }); });
    await until(A, 'the audit warning', () => /audit log is not writing/.test(document.getElementById('dp-identity')?.textContent ?? ''), null, 9000);
    const auditW = await A.evaluate(() => document.documentElement.scrollWidth);
    await shot(A, 'design-390-audit-path');
    await A.unroute(linkRoute);
    // 1024 x 768 with the receipt expanded: the current action stays above the fold.
    await A.setViewportSize({ width: 1024, height: 768 }); await A.evaluate(() => scrollTo(0, 0)); await A.waitForTimeout(600);
    await A.click('#dp-identity-toggle'); await A.waitForTimeout(400);
    const at1024 = await A.evaluate(() => ({ bottom: document.getElementById('dp-primary').getBoundingClientRect().bottom, vh: innerHeight }));
    await shot(A, 'design-1024-receipt-open');
    await A.click('#dp-identity-toggle');
    await A.setViewportSize({ width: 1440, height: 900 }); await A.waitForTimeout(600);
    assert(auditW <= 391, `a long audit path wraps at 390 px (${auditW})`);
    assert(at1024.bottom <= at1024.vh, `1024x768 with the receipt open: the current action is above the fold (${JSON.stringify(at1024)})`);
    assert(m.primary.top >= 0 && m.primary.bottom <= m.vh && m.topmost, `the current action is on screen and on top: ${JSON.stringify(m)}`);
    assert(m.estop.top >= 0 && m.estop.bottom <= m.vh, 'the E-STOP bar is on screen');
    assert(m.docW <= 391, `no horizontal scroll (${m.docW})`);
    assert(collapsed <= 140, `the map collapses (${collapsed} px)`);
    return { ...m, collapsed };
  });

  // ================================================================== F06: goal check basis and freshness
  await check('F06', 'goal check: the profile it was checked with, its freshness, a re-check when the profile changes', async () => {
    await closeAll(); await endAll();
    const page = await openPage({ label: 'goal' });
    await takeControls(page, 'Linji');
    await page.evaluate(() => { window.__deploy.setStep('goal'); return window.__deploy.checkGoal([1.6, 0]); });
    await until(page, 'checked', () => !!window.__deploy.S.goal?.check?.check_id);
    const first = await page.evaluate(() => ({ basis: document.querySelector('.dp-basis')?.textContent, legend: document.querySelector('.dp-legend-inline')?.textContent, profile: window.__deploy.S.goal.check.config?.profile, asked: window.__deploy.S.goal.check.profileAsked }));
    const reqs0 = page.__requests.filter(r => r.path === '/api/deploy/goal_check').length;
    await page.evaluate(() => window.__deploy.setStep('connect')); await page.selectOption('#dp-profile', 'low-margin');
    await page.evaluate(() => window.__deploy.setStep('goal'));
    await until(page, 'a re-check with low-margin', () => window.__deploy.S.goal?.check?.profileAsked === 'low-margin' && !!window.__deploy.S.goal.check.check_id, null, 10000);
    const second = await page.evaluate(() => ({ basis: document.querySelector('.dp-basis')?.textContent, profile: window.__deploy.S.goal.check.config?.profile }));
    // An expired check is never green: age it past its TTL.
    const expired = await page.evaluate(() => { const c = window.__deploy.S.goal.check; c.receivedAt -= 1e6; return window.__deploy.fn.goalStatus(); });
    await page.waitForTimeout(600);
    const reqs1 = page.__requests.filter(r => r.path === '/api/deploy/goal_check').length;
    await shot(page, 'f06-goal-basis');
    await page.selectOption('#dp-profile', 'deploy').catch(() => {});
    assert(/route settings|generic/i.test(first.basis ?? '') && /Checked .* ago/.test(first.basis ?? ''), `basis and freshness shown: ${first.basis}`);
    assert(/0\.30 m margin/.test(first.legend ?? '') || /generic/i.test(first.basis ?? ''), `the legend's margin is the profile's: ${first.legend}`);
    assert(second.profile === 'low-margin' || /generic/i.test(second.basis ?? ''), `checked again with the new profile: ${JSON.stringify(second)}`);
    assert(expired === 'pending' && reqs1 > reqs0 + 1, `an expired check is not green and runs again (${expired}, ${reqs0} -> ${reqs1})`);
    await page.evaluate(() => { window.__deploy.S.profile = 'deploy'; localStorage.setItem('studio.deploy.profile', 'deploy'); });
    return { first, second, expired };
  });

  // ================================================================== F04 + F07: a real rehearsal with a required gap; tracks 503 then recover
  await check('F04', 'must pass through the gap: offered, sent with the rehearsal, scored per case; tracks recover from 503s', async () => {
    await closeAll(); await endAll();
    const page = await openPage({ label: 'f04' });
    await takeControls(page, 'Linji');
    await page.evaluate(() => { window.__deploy.setStep('goal'); return window.__deploy.checkGoal([2.4, 0.0]); });
    await until(page, 'the passage offer', () => !!document.querySelector('[data-passage]'), null, 10000);
    await page.locator('[data-passage]').check();
    await page.evaluate(() => window.__deploy.setStep('rehearse'));
    await until(page, 'Rehearse', () => /Rehearse/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, null, 10000);
    await faults({ track_fail: 2 });
    faultWindow = true;
    await page.click('#dp-primary');
    const sent = page.__requests.filter(r => r.path === '/api/deploy/act' && r.body && JSON.parse(r.body).act === 'rehearse').map(r => JSON.parse(r.body)).at(-1);
    let sawRetry = false;
    for (let i = 0; i < 240; i++) {
      const s = await page.evaluate(() => ({ tracks: Object.keys(window.__deploy.S.tracks ?? {}).length, err: !!document.querySelector('.dp-track-err') }));
      sawRetry ||= s.err;
      if (s.tracks === 3) break;
      await page.waitForTimeout(500);
    }
    faultWindow = false;
    const m = await page.evaluate(() => ({ text: document.querySelector('.dp-panel-content').innerText, tracks: Object.keys(window.__deploy.S.tracks ?? {}), rec: window.__deploy.fn.rehearsalFor() }));
    await shot(page, 'f04-passage-cases');
    assert(sent?.passage?.a && sent.passage.b, `the gate went with the rehearsal: ${JSON.stringify(sent?.passage)}`);
    assert(m.tracks.length === 3 && sawRetry, `tracks retried after 503 and loaded (${m.tracks}, saw retry ${sawRetry})`);
    assert(/3 rehearsal cases/.test(m.text) && /Injected drift fitted to prior lab measurements/.test(m.text), 'the cases are named plainly');
    assert(/through the gap|AROUND the required gap/.test(m.text), 'passage is scored per case');
    assert(!/within a few centim/i.test(m.text) && /not yet validated walking on the robot/.test(m.text), 'no precision claim; the validation status is stated');
    // A detour around the required gap is never a task pass, whatever the verdict says (the browser's own guard).
    const matchRoute = u => u.pathname === '/api/deploy/rehearsal/match';
    await page.route(matchRoute, async route => {
      const res = await route.fetch(), body = await res.json();
      if (body.complete) { body.complete.verdict = 'robust'; body.complete.passage ??= { a: [2, 0.35], b: [2, -0.35] }; body.complete.runs.exact.passage = 'missed'; }
      await route.fulfill({ response: res, json: body });
    });
    await page.evaluate(() => { window.__deploy.S.match.at = 0; window.__deploy.S.match.sig = ''; });
    await until(page, 'the detour verdict', () => /Missed the required gap/.test(document.querySelector('.dp-verdict')?.textContent ?? ''), null, 8000);
    const detour = await page.evaluate(() => ({ verdict: document.querySelector('.dp-verdict').textContent, primary: document.getElementById('dp-primary').textContent }));
    await shot(page, 'f04-detour');
    await page.unroute(matchRoute);
    assert(!/Next: deploy/.test(detour.primary), `no task pass for a detour: ${JSON.stringify(detour)}`);
    return { passage: sent.passage, verdict: m.rec?.verdict, detour };
  });

  await check('F04', 'a partial set never says all three passed', async () => {
    await closeAll();
    const page = await openPage({ label: 'partial' });
    await takeControls(page, 'Linji');
    await page.evaluate(() => { window.__deploy.setStep('goal'); return window.__deploy.checkGoal([1.2, 0.0]); });
    await until(page, 'checked', () => !!window.__deploy.S.goal?.check?.check_id);
    await page.evaluate(() => window.__deploy.setStep('rehearse'));
    await faults({ rehearsal_stop_after: 'drift' });
    await until(page, 'Rehearse', () => /Rehearse/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, null, 10000);
    await page.click('#dp-primary');
    await until(page, 'the partial set', () => (window.__deploy.S.state?.rehearsals ?? []).some(r => r.state === 'partial'), null, 120000);
    await page.waitForTimeout(1500);
    const m = await page.evaluate(() => ({ text: document.querySelector('.dp-panel-content').innerText, selected: window.__deploy.fn.rehearsalFor()?.name ?? null }));
    await shot(page, 'f04-partial');
    assert(!m.selected && !/All 3 cases arrived|Robust/.test(m.text), `no verdict for a partial set: ${m.text.slice(0, 400)}`);
    assert(/No matching completed rehearsal|PARTIAL|not complete/i.test(m.text), 'it says why');
    return { selected: m.selected };
  });

  // ================================================================== F05: Review survives, in another browser, and opens Replay at the attempt
  let ended = null;
  await check('F05', 'complete an attempt, tag it, end, reopen the Review link in a fresh browser, re-tag, Open in Replay', async () => {
    await closeAll(); await endAll();
    const page = await openPage({ label: 'f05' });
    await takeControls(page, 'Linji');
    await page.evaluate(() => window.__deploy.setStep('deploy'));
    await until(page, 'Start practice session', () => /Start practice session/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled);
    const kbStart = await keyboardWalk(page, '#dp-primary', 'dp-primary');
    await page.click('#dp-primary'); await page.waitForSelector('.dp-sheet');
    for (const box of await page.locator('.dp-sheet [data-confirm]').all()) await box.check();
    await page.click('#dp-sheet-ok');
    await until(page, 'the practice session, attached', () => window.__deploy.fn.attached(), null, 20000);
    await until(page, 'Arm', () => /Arm/.test(document.getElementById('dp-primary')?.textContent ?? '') && !document.getElementById('dp-primary').disabled, null, 20000);
    const kbArm = await keyboardWalk(page, '#dp-primary', 'dp-primary');
    await ladderToGo(page, [1.6, 0]);
    await page.click('#dp-primary'); await page.waitForSelector('.dp-sheet');
    // Practice with a failing matching set (seeded in D3 when it ran): a note, no tick.
    const practiceGo = await page.evaluate(() => ({ caution: document.querySelector('.dp-sheet .dp-caution')?.textContent ?? '', tick: !!document.querySelector('.dp-sheet [data-ack]'), okDisabled: document.getElementById('dp-sheet-ok').disabled, green: !!document.querySelector('.dp-sheet .tiny.ok') }));
    assert(!practiceGo.tick && !practiceGo.okDisabled, `Practice: no tick, GO open: ${JSON.stringify(practiceGo)}`);
    assert(!(practiceGo.green && /fails/i.test(practiceGo.caution)), 'never green beside a failing set');
    await page.click('#dp-sheet-ok');
    await until(page, 'arrival', () => (window.__deploy.S.panel?.attempts ?? []).some(a => a.result ?? a.outcome), null, 60000);
    await page.waitForSelector('.dp-tagcard');
    await page.locator('.dp-tagcard [data-tag="clean"]').click();
    await page.locator('.dp-tagcard input[data-note]').fill('edge run: arrived');
    await page.click('#dp-primary');
    await until(page, 'tagged', () => (window.__deploy.S.panel?.attempts ?? []).at(-1)?.tag === 'clean', null, 10000);
    ended = await page.evaluate(() => window.__deploy.fn.session().name);
    await page.click('[data-action="sheet:end"]'); await page.waitForSelector('.dp-sheet'); await page.click('#dp-sheet-ok');
    await until(page, 'Review', () => window.__deploy.S.step === 'review' && !window.__deploy.fn.session(), null, 20000);
    const url = await page.evaluate(() => location.href);
    // A clean browser opens the exact link.
    const fresh = await openPage({ label: 'f05-fresh', query: `?workspace=deploy&session=${encodeURIComponent(ended)}&attempt=1`, init: () => { localStorage.setItem('studio.deploy.mode', 'robot'); } });
    await until(fresh, 'the session detail', () => !!document.querySelector('.dp-rev-attempt.sel'), null, 15000);
    const m = await fresh.evaluate(() => ({ step: window.__deploy.S.step, text: document.querySelector('.dp-panel-content').innerText, primary: document.getElementById('dp-primary').textContent, disabled: document.getElementById('dp-primary').disabled, lock: document.querySelector('.dp-foot .dp-lock')?.textContent ?? '',
      eyebrow: document.querySelector('.dp-head .eyebrow').textContent, blocker: document.querySelector('.dp-block-line')?.textContent ?? null }));
    assert(/practice session/.test(m.eyebrow) && !/real robot/.test(m.eyebrow), `Review's eyebrow is the reviewed session's kind, not the next-session mode (robot here): ${m.eyebrow}`);
    assert(m.blocker === null, `no readiness blocker on Review: ${m.blocker}`);
    await shot(fresh, 'f05-review-fresh-browser');
    assert(/[?&]session=/.test(url) && /[?&]workspace=deploy/.test(url), `the Review URL holds the session: ${url}`);
    assert(m.step === 'review' && /arrived/.test(m.text) && /clean/.test(m.text) && /edge run: arrived/.test(m.text), `attempt, outcome, tag and note after a reload elsewhere: ${m.text.slice(0, 500)}`);
    assert(/Rehearsal/.test(m.text) && /Start check/.test(m.text) && /Alignment/.test(m.text), 'rehearsal, start check and alignment rows');
    assert(/Recording/.test(m.text) && /Evidence/.test(m.text) && !/Evidence\s*0 of 0/.test(m.text), 'recording health and evidence, never "0 of 0"');
    // Re-tag the ended session (named viewer; no lease needed).
    await fresh.locator('.dp-rev-body [data-rtag="touched"]').click();
    assert(await fresh.locator('.dp-rev-body [data-action^="rtag:"]').isDisabled(), 'Save waits for a name (no 400)');
    await fresh.fill('#dp-review-operator', 'Reviewer');
    await fresh.locator('.dp-rev-body input[data-rnote]').fill('re-tagged in Review');
    await fresh.locator('.dp-rev-body [data-action^="rtag:"]').click();
    await until(fresh, 'saved', () => /saved/.test(document.querySelector('.dp-rev-result')?.textContent ?? ''), null, 10000);
    await fresh.reload({ waitUntil: 'domcontentloaded' });
    await until(fresh, 'reloaded detail', () => !!document.querySelector('.dp-rev-attempt.sel') && /touched/.test(document.querySelector('.dp-rev-attempt.sel').textContent), null, 20000);
    // Open in Replay at the attempt.
    let replay = null;
    if (!m.disabled) {
      const want = await fresh.evaluate(n => window.__deploy.S.detail[n]?.data?.replay?.catalog_id, ended);
      await fresh.click('#dp-primary');
      await until(fresh, 'Replay on that session', w => window.__studio.state.workspace === 'replay' && window.__studio.state.sessionId === w && document.getElementById('loading-overlay').hidden && window.__studio.state.time > 0, want, 90000);
      replay = await fresh.evaluate(() => ({ id: window.__studio.state.sessionId, time: window.__studio.state.time, start: window.__studio.state.session.frames[0].time }));
      await shot(fresh, 'f05-replay-at-attempt');
    }
    assert(replay && replay.id && replay.time > replay.start, `Replay opened the session at the attempt (${JSON.stringify(replay)}; Review said: ${m.lock})`);
    return { session: ended, url, replay, keyboard: { start: kbStart, arm: kbArm } };
  });

  await check('F07', 'Review: the session detail 503s, retries, recovers; it never shows "Evidence 0 of 0" (Astra probe 6)', async () => {
    assert(ended, 'needs the ended session');
    faultWindow = true; await faults({ session_fail: 2 });
    const page = await openPage({ label: 'f07-review', query: `?workspace=deploy&session=${encodeURIComponent(ended)}&attempt=1` });
    await until(page, 'the error with Retry', () => /could not be loaded/.test(document.querySelector('.dp-panel-content')?.textContent ?? ''), null, 8000);
    const during = await page.evaluate(() => document.querySelector('.dp-panel-content').innerText);
    await shot(page, 'f07-review-503');
    await until(page, 'recovered', () => !!document.querySelector('.dp-rev-attempt.sel') && !/could not be loaded/.test(document.querySelector('.dp-panel-content').textContent), null, 20000);
    faultWindow = false;
    assert(/Retry/.test(during) && !/0 of 0/.test(during), `an error with Retry, no empty evidence: ${during.slice(0, 300)}`);
    return { during: during.slice(0, 300) };
  });
  // ================================================================== F02: which rehearsal set (last: its seeded rerun stays 'running')
  await check('F02', 'newest-first: a newer failure beats an older pass; a running rerun is shown as running; reasons for the rest', async () => {
    await closeAll(); await endAll();
    const page = await openPage({ label: 'f02', init: () => { localStorage.setItem('studio.deploy.odom', 'fused'); localStorage.setItem('studio.deploy.profile', 'deploy'); localStorage.setItem('studio.deploy.mode', 'practice'); } });
    const scan = await page.evaluate(() => window.__deploy.S.scanName);
    await hubPost('/api/fake/rehearsals', { preset: 'f02', scan, goal_scene: [3.0, 0.0], profile: 'deploy', odom: 'fused' });
    await page.evaluate(() => { window.__deploy.setStep('goal'); return window.__deploy.checkGoal([3.0, 0.0]); });
    await page.evaluate(() => window.__deploy.setStep('rehearse'));
    await until(page, 'the match', () => !!window.__deploy.S.match?.data, null, 10000);
    await page.waitForTimeout(600);
    const m = await page.evaluate(() => ({ selected: window.__deploy.fn.rehearsalFor()?.name, running: window.__deploy.S.match.data.running?.name, setline: [...document.querySelectorAll('.dp-setline')].map(e => e.textContent).join(' | '),
      verdict: document.querySelector('.dp-verdict')?.textContent ?? '', others: document.querySelector('.dp-nomatch')?.textContent ?? '', otherList: window.__deploy.S.match.data.others.map(o => o.name) }));
    await shot(page, 'f02-newer-failure');
    assert(/new-failure/.test(m.selected ?? ''), `the newest complete matching set is selected, not the older pass: ${m.selected}`);
    assert(/rerun/.test(m.running ?? '') && /Running set/.test(m.setline), `the rerun shows as running: ${m.setline}`);
    assert(/Fails/.test(m.verdict) && !/Robust/.test(m.verdict), `the verdict is the newer failure's: ${m.verdict}`);
    // Changed odometry (the next session's, no session running): the set for that odometry.
    await page.evaluate(() => { window.__deploy.S.odom = 'leg'; window.__deploy.fn.renderAll(); });
    await until(page, 'the leg set', () => /other-odom/.test(window.__deploy.fn.rehearsalFor()?.name ?? ''), null, 8000);
    // Changed profile contents under the same name: nothing matches, with the reason.
    await page.evaluate(() => { window.__deploy.S.odom = 'fused'; window.__deploy.fn.renderAll(); });
    await until(page, 'back to fused', () => /new-failure/.test(window.__deploy.fn.rehearsalFor()?.name ?? ''), null, 8000);
    await hubPost('/api/fake/profile', { name: 'deploy', params: { route_margin_m: 0.31 } });
    await page.evaluate(() => { window.__deploy.S.match.at = 0; });
    await until(page, 'no match after the profile changed', () => window.__deploy.S.match?.data && !window.__deploy.fn.rehearsalFor() && !!document.querySelector('.dp-nomatch'), null, 10000);
    const none = await page.evaluate(() => document.querySelector('.dp-nomatch')?.textContent ?? '');
    await shot(page, 'f02-profile-changed');
    await hubPost('/api/fake/profile', { name: 'deploy', params: { route_margin_m: 0.30 } });
    assert(/No matching completed rehearsal/.test(none) && /contents changed/.test(none), `no match, with the reason: ${none}`);
    assert(/other start/.test(none) && /no bundle sha in its identity/.test(none), `other start and a missing identity field are named: ${none}`);
    return { ...m, none: none.slice(0, 600) };
  });

  await check('D1', 'Review requests are bounded: an unknown session (404) and a failing detail (503) over 15 s', async () => {
    const page = await openPage({ label: 'd1-missing', query: '?workspace=deploy&session=practice-000000-not-today&attempt=1', allow: [{ status: 404, path: '/api/deploy/session' }] });
    await page.waitForTimeout(15000);
    const n404 = page.__requests.filter(r => r.path === '/api/deploy/session').length;
    const missing = await page.evaluate(() => ({ text: document.querySelector('.dp-panel-content').innerText, offers: document.querySelectorAll('[data-review-session]').length, lock: document.querySelector('.dp-foot .dp-lock')?.textContent ?? '' }));
    await shot(page, 'd1-unknown-session');
    assert(n404 <= 6, `requests for an unknown session in 15 s: ${n404}`);
    assert(/no session named/.test(missing.text) && /No such session/.test(missing.lock), `says so, with a consistent Replay lock: ${missing.lock}`);
    faultWindow = true; await faults({ session_fail: -1 });
    const page2 = await openPage({ label: 'd1-failing', query: `?workspace=deploy&session=${encodeURIComponent(ended ?? 'x')}&attempt=1` });
    await page2.waitForTimeout(15000);
    const n503 = page2.__requests.filter(r => r.path === '/api/deploy/session').length;
    const failing = await page2.evaluate(() => ({ text: document.querySelector('.dp-panel-content').innerText, lock: document.querySelector('.dp-foot .dp-lock')?.textContent ?? '' }));
    await shot(page2, 'd1-failing-detail');
    await resetFaults(); faultWindow = false;
    assert(n503 <= 6, `requests for a failing detail in 15 s: ${n503}`);
    assert(/could not be loaded/.test(failing.text) && /Retry/.test(failing.text) && /could not be loaded/.test(failing.lock), `an error with Retry, the Replay lock says the same: ${failing.lock}`);
    await page2.locator('.dp-retry [data-action="detail-retry"]').click();
    if (ended) await until(page2, 'recovered on Retry', () => !!document.querySelector('.dp-rev-attempt'), null, 10000);
    return { n404, n503, offers: missing.offers };
  });

  await check('D2', 'recording states from a session detail recorded from the real kit: finalized is good, stalled is stalled', async () => {
    const fixture = JSON.parse(await readFile(path.join(root, 'tests/fixtures/deploy_v1/session_detail_practice_real.json'), 'utf8'));
    const name = fixture.name;
    const out = {};
    for (const [label, mutate] of [['finalized', d => d], ['stalled', d => { d.recording.state = 'stalled'; d.recording.recorder = { ...(d.recording.recorder ?? {}), heartbeat_age_s: 12 }; d.recording.finalized = false; d.ended = false; return d; }],
      ['not finalized', d => { d.recording.state = 'not finalized'; d.recording.finalized = false; return d; }]]) {
      const page = await openPage({ label: `d2-${label}`, query: `?workspace=deploy&session=${encodeURIComponent(name)}&attempt=1`,
        before: p => p.route(u => u.pathname === '/api/deploy/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(mutate(JSON.parse(JSON.stringify(fixture)))) })) });
      await until(page, 'the recording line', () => !!document.querySelector('.dp-rev-rec'), null, 10000);
      out[label] = await page.evaluate(() => ({ rec: document.querySelector('.dp-rev-rec').textContent, tone: document.querySelector('.dp-rev-rec').className, evidence: document.querySelector('.dp-panel-content h4 .tiny')?.textContent ?? '', eyebrow: document.querySelector('.dp-head .eyebrow').textContent }));
      await shot(page, `d2-recording-${label.replace(' ', '-')}`);
      await contexts.pop().close();
    }
    assert(/Recording finalized · 6 of 6 required streams recorded/.test(out.finalized.rec) && !/NOT RUNNING|stopped/.test(out.finalized.rec) && /pass/.test(out.finalized.tone), `finalized reads as finalized: ${JSON.stringify(out.finalized)}`);
    assert(/required present · complete/.test(out.finalized.evidence), `the evidence count: ${out.finalized.evidence}`);
    assert(/practice session/.test(out.finalized.eyebrow), `eyebrow from the receipt: ${out.finalized.eyebrow}`);
    assert(/Recorder stalled/.test(out.stalled.rec) && !/NOT RUNNING/.test(out.stalled.rec), `stalled reads as stalled: ${out.stalled.rec}`);
    assert(/NOT finalized/.test(out['not finalized'].rec), `not finalized is distinct: ${out['not finalized'].rec}`);
    return out;
  });

  await check('D13', 'an older service: Review of an ended session says once what it cannot show', async () => {
    assert(ended, 'needs the ended session');
    const page = await openPage({ label: 'd13', query: `?workspace=deploy&session=${encodeURIComponent(ended)}&attempt=1`,
      before: p => p.route(u => u.pathname === '/api/deploy/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ supported: false, capability: 'session_detail', detail: 'the deploy service has no session_detail: it predates contract v3; update the kit' }) })) });
    await until(page, 'the unsupported message', () => /unsupported/.test(document.querySelector('.dp-panel-content')?.textContent ?? ''), null, 8000);
    await page.waitForTimeout(800);
    const text = await page.evaluate(() => document.querySelector('.dp-panel-content').innerText);
    await shot(page, 'd13-v1-review');
    assert(/cannot be shown here/.test(text) && !/No attempts in this session/.test(text), `one clear message: ${text.slice(0, 500)}`);
    return { text: text.slice(0, 300) };
  });
} catch (error) {
  failure = error;
} finally {
  await resetFaults().catch(() => {});
  report.finished = new Date().toISOString();
  report.failure = failure ? String(failure.stack ?? failure) : null;
  report.passed = report.checks.filter(c => c.pass).length; report.failed = report.checks.filter(c => !c.pass).length;
  await writeFile(path.join(shots, 'deploy-edges.json'), JSON.stringify(report, null, 1));
  await closeAll(); await browser.close(); stopHub();
}
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, errors: report.errors.slice(0, 12), failure: report.failure, failedChecks: report.checks.filter(c => !c.pass).map(c => `${c.id} ${c.name}: ${c.error?.split('\n')[0]}`) }, null, 1));
process.exit(failure || report.failed || report.errors.length ? 1 : 0);
