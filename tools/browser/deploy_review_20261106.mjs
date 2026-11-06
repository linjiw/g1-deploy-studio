// The browser side of the 2026-11-06 review (Astra), expecting the FIXED behaviour: R02 an unresolved act stays
// unresolved, R03 an unknown console heartbeat raises the alarm (and the phone keeps the physical E-stop line), R04 a
// late Start reply, R06 one attempt outcome, R07 focus and the typed goal, and Review's session times.
// Self-contained: it starts tools/fake_deploy_hub.py and a dev gateway on its own ports and a temporary data root, and
// never talks to a robot or the real deploy service. Some checks inject browser responses (named in each check).
//   node tools/browser/deploy_review_20261106.mjs            (REVIEW_SHOTS=<dir> keeps screenshots; ONLY=R02,R04)
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// STUDIO_ROOT runs the same checks against another checkout (e.g. the code before these fixes).
const root = process.env.STUDIO_ROOT ? path.resolve(process.env.STUDIO_ROOT) : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hubPort = Number(process.env.FAKE_HUB_PORT || 18979), studioPort = Number(process.env.STUDIO_PORT || 18992);
const hub = `http://127.0.0.1:${hubPort}`, base = `http://127.0.0.1:${studioPort}`;
const data = await mkdtemp(path.join(os.tmpdir(), 'deploy-review-'));
const shots = process.env.REVIEW_SHOTS || path.join(data, 'shots');
const only = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
await mkdir(shots, { recursive: true });
await writeFile(path.join(data, 'config.json'), JSON.stringify({ sessions: [] }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const report = { started: new Date().toISOString(), scope: 'fake deploy hub + dev gateway on loopback; no robot, no real deploy service', checks: [], errors: [] };
const children = [];
function launch(args, env = {}) {
  const c = spawn(path.join(root, '.venv/bin/python'), args, { cwd: root, env: { ...process.env, ...env }, stdio: ['ignore', 'ignore', 'pipe'] });
  let err = ''; c.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-10000); });
  c.on('exit', code => { if (code && /Traceback/.test(err)) console.log(err.slice(-2000)); });
  children.push(c); return c;
}
async function ready(url) { for (let i = 0; i < 120; i++) { try { if ((await fetch(url)).ok) return; } catch { /* starting */ } await sleep(150); } throw new Error(`not ready: ${url}`); }
async function hubPost(p, body = {}) { const r = await fetch(`${hub}${p}?t=fake-token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }); return r.json(); }
const endAll = async () => { for (const slot of ['robot', 'sim']) await hubPost('/api/fake/end', { slot }); await sleep(1500); };
const CONFIRM = { gantry: true, estop: true, remote: true, rope: true };
const startPractice = (operator = 'Other operator') => hubPost('/api/v1/start', { mode: 'sim', practice: true, scan: 'scan-fake', profile: 'deploy', odom: 'fused', operator, confirm: CONFIRM });
function assert(ok, what) { if (!ok) throw new Error(what); }

let browser, lastPage = null;
const contexts = [];
async function open(label, { before = null, width = 1440, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  contexts.push(context);
  const page = await context.newPage();
  lastPage = page; page.__label = label;
  page.on('pageerror', e => report.errors.push({ label, message: e.message }));
  if (before) await before(page);
  await page.goto(`${base}/?workspace=deploy`);
  await page.waitForFunction(() => window.__deploy?.S?.stateOk, null, { timeout: 60000 });
  await page.waitForTimeout(1200);
  return { page, context };
}
async function takeControls(page, name = 'Review check') {
  await page.evaluate(() => window.__deploy.setStep('connect'));
  await page.fill('#dp-operator', name);
  await page.click('#dp-primary');
  await page.waitForFunction(() => !!window.__deploy.S.lease.id, null, { timeout: 10000 });
}
const pageErrors = label => report.errors.filter(e => e.label === label);
async function check(id, name, fn) {
  if (only && !only.has(id)) return;
  const row = { id, name, pass: false };
  const t0 = Date.now();
  console.log(`· ${id} ${name}`);
  try { row.detail = (await fn()) ?? null; row.pass = true; } catch (e) {
    row.error = String(e?.stack ?? e).slice(0, 1500);
    if (lastPage && !lastPage.isClosed()) row.shot = await lastPage.screenshot({ path: path.join(shots, `fail-${id}-${report.checks.length}.png`) }).then(() => 'saved').catch(() => null);
  }
  row.seconds = Math.round((Date.now() - t0) / 100) / 10;
  while (contexts.length) await contexts.pop().close().catch(() => {});  // a failed check's page never keeps the lease
  await sleep(3500);                                                     // the gateway's lease TTL (3 s)
  report.checks.push(row);
  console.log(`  ${row.pass ? 'PASS' : 'FAIL'} (${row.seconds} s)${row.pass ? '' : `: ${row.error.split('\n')[0]}`}`);
  await endAll().catch(() => {});
}

try {
  launch(['tools/fake_deploy_hub.py', '--port', String(hubPort), '--panel-port', String(hubPort + 1), '--studio-data', data]);
  await ready(`${hub}/api/v1/state?t=fake-token`);
  launch(['-m', 'studio.server', '--port', String(studioPort), '--config', path.join(data, 'config.json'), '--data-root', data],
    { G1_DEPLOY_SERVICE: hub, G1_PANEL_TOKEN: 'fake-token' });
  await ready(`${base}/api/version`);
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

  // R02: Arm is carried out, its reply replaced by 202 unknown (injected), its act record answers "no record"
  // (injected) and then an answer about ANOTHER session (injected): it stays unresolved, motion stays locked, and only
  // the operator's explicit unlock after 15 s releases the page; the real record, when it comes, settles it.
  await check('R02', 'no record is not "never arrived": unresolved until the record says, unlock only by the operator', async () => {
    const start = await startPractice('Review check');
    let lookups = 'absent';
    const { page, context } = await open('R02', { before: async p => {
      await p.route('**/api/deploy/act', async route => {
        const body = route.request().postDataJSON();
        if (body.act !== 'arm') return route.continue();
        await route.fetch();  // carried out by the fake console
        await route.fulfill({ status: 202, json: { state: 'unknown', reconcile: 'act_status', id: body.id, act: 'arm', slot: 'sim', session: start.name } });
      });
      await p.route('**/api/deploy/act_status?*', async route => {
        if (lookups === 'absent') return route.fulfill({ json: { known: false, session: start.name, searched: ['console act_result (its last 500 acts)', 'console_events.jsonl'], absence: 'no record (injected)' } });
        if (lookups === 'other') return route.fulfill({ json: { known: true, result: 'refused', reason: 'injected, about another session', session: 'practice-000000-other' } });
        return route.continue();  // the gateway's real lookup
      });
    } });
    await takeControls(page);
    await page.evaluate(() => { const D = window.__deploy; D.S.attached = D.fn.session()?.name; D.setStep('deploy'); D.S.sheet = { kind: 'arm', confirm: {}, armed: true }; D.fn.renderAll(); });
    await page.waitForSelector('#dp-sheet-ok:not([disabled])'); await page.click('#dp-sheet-ok');
    await page.waitForFunction(() => Object.values(window.__deploy.S.acts).some(a => a.act === 'arm' && a.state === 'unknown'));
    await page.waitForTimeout(16500);
    const late = await page.evaluate(() => {
      const D = window.__deploy, a = Object.values(D.S.acts).find(x => x.act === 'arm');
      return { state: a.state, reason: a.reason ?? null, locked: !!D.fn.unknownAct(), line: document.querySelector('.dp-block-line [data-live-act]')?.closest('.dp-block-line')?.innerText ?? '',
        unlock: !!document.querySelector('.dp-block-line [data-action^="act-unlock:"]') };
    });
    await page.screenshot({ path: path.join(shots, 'r02-unresolved.png') });
    assert(late.state === 'unknown' && late.locked, `still unresolved and locking: ${JSON.stringify(late)}`);
    assert(!/you may press again|it never arrived \(/i.test(late.line) && /does not mean it never arrived/.test(late.line), `honest words: ${late.line.replace(/\s+/g, ' ')}`);
    assert(late.unlock, 'the operator is offered an explicit unlock');
    lookups = 'other'; await page.waitForTimeout(2600);
    const other = await page.evaluate(() => { const a = Object.values(window.__deploy.S.acts).find(x => x.act === 'arm'); return { state: a.state, otherSession: a.otherSession }; });
    assert(other.state === 'unknown' && other.otherSession === 'practice-000000-other', `an answer about another session settles nothing: ${JSON.stringify(other)}`);
    await page.click('.dp-block-line [data-action^="act-unlock:"]');
    const unlocked = await page.evaluate(() => { const D = window.__deploy, a = Object.values(D.S.acts).find(x => x.act === 'arm'); return { state: a.state, locked: !!D.fn.unknownAct(), notice: D.S.notice?.text ?? '' }; });
    assert(unlocked.state === 'unknown' && !unlocked.locked && /still unresolved/.test(unlocked.notice), `unlocked by the operator, still unresolved: ${JSON.stringify(unlocked)}`);
    lookups = 'real';
    await page.waitForFunction(() => Object.values(window.__deploy.S.acts).find(x => x.act === 'arm')?.state === 'done', null, { timeout: 12000 });
    const errs = pageErrors('R02'); await context.close();
    assert(!errs.length, JSON.stringify(errs));
    return { late, other, unlocked };
  });

  // R03: the heartbeat answers "unknown" for every console from the first load (injected), then one healthy and one
  // unknown console (injected); on a phone the physical E-stop line stays.
  await check('R03', 'an unknown heartbeat raises its own alarm, per console; the phone keeps the physical E-stop line', async () => {
    await startPractice('Review check');
    let hb = 'unknown';
    const { page, context } = await open('R03', { before: async p => {
      await p.route('**/api/deploy/heartbeat', async route => {
        const rows = hb === 'unknown' ? [{ slot: 'sim', reached: false, console_age_s: null, state: 'unknown', error: 'injected: unreachable' }]
          : [{ slot: 'sim', reached: true, console_age_s: 0.05, state: 'fresh' }, { slot: 'robot', reached: false, console_age_s: null, state: 'unknown', error: 'injected' }];
        await route.fulfill({ json: { consoles: rows, hub: { ok: true }, stale_after_s: 1 } });
      });
      await p.route('**/api/deploy/state', async route => {
        const response = await route.fetch(), json = await response.json();
        for (const v of Object.values(json.live ?? {})) if (v) delete v.console_t_mono_age_s;
        if (hb === 'two') json.live = { ...json.live, robot: { ...(json.live?.sim ?? {}), running: true, practice: false, name: 'robot-000000-injected', receipt: { kind: 'robot', session: 'robot-000000-injected' } } };
        await route.fulfill({ response, json });
      });
    } });
    await page.waitForTimeout(2800);
    const one = await page.evaluate(() => ({ alarm: !document.getElementById('dpe-alarm').hidden, text: document.getElementById('dpe-alarm').textContent, sub: document.getElementById('dpe-sub').textContent }));
    await page.screenshot({ path: path.join(shots, 'r03-unknown.png') });
    assert(one.alarm && /UNKNOWN/.test(one.text) && /physical E-stop/.test(one.text), `alarm on an unknown heartbeat: ${JSON.stringify(one)}`);
    hb = 'two'; await page.waitForTimeout(2500);
    const two = await page.evaluate(() => ({ alarm: !document.getElementById('dpe-alarm').hidden, text: document.getElementById('dpe-alarm').textContent, sub: document.getElementById('dpe-sub').textContent }));
    assert(two.alarm && /\(robot\)/.test(two.text) && /sim .*robot unknown|robot unknown/.test(two.sub), `a healthy console never hides an unknown one: ${JSON.stringify(two)}`);
    await page.setViewportSize({ width: 390, height: 844 }); await page.waitForTimeout(700);
    const phone = await page.evaluate(() => ({ fallback: getComputedStyle(document.querySelector('.dpe-fallback')).display, short: getComputedStyle(document.querySelector('.dpe-fb-short')).display,
      text: document.querySelector('.dpe-fallback').innerText, overflow: document.documentElement.scrollWidth > innerWidth }));
    await page.screenshot({ path: path.join(shots, 'r03-phone.png') });
    const errs = pageErrors('R03'); await context.close();
    assert(phone.fallback !== 'none' && phone.short !== 'none' && /physical E-stop/.test(phone.text) && !phone.overflow, `phone: ${JSON.stringify(phone)}`);
    assert(!errs.length, JSON.stringify(errs));
    return { one, two, phone };
  });

  // R04: the Start reply held back 2.2 s (injected delay) while the state poll finds the session; then a Start reply
  // lost (aborted, injected) with the session found by its start_id; then another operator's session appearing while
  // this tab's Start is held back (it is refused: slot busy) is never attached.
  await check('R04', 'Start: a late reply, a lost reply and an unrelated session converge without an error', async () => {
    let mode = 'delay';
    const { page, context } = await open('R04', { before: async p => {
      await p.route('**/api/deploy/act', async route => {
        const body = route.request().postDataJSON();
        if (body.act !== 'start') return route.continue();
        if (mode === 'delay') { const response = await route.fetch(); await sleep(2200); return route.fulfill({ response }); }
        if (mode === 'lost') { await route.fetch(); return route.abort('connectionreset'); }
        if (mode === 'other') { await startPractice('Someone else'); await sleep(1500); return route.continue(); }
        return route.continue();
      });
    } });
    await takeControls(page);
    const startHere = async () => {
      await page.evaluate(() => window.__deploy.setStep('deploy'));
      await page.waitForSelector('#dp-primary:not([disabled])', { timeout: 15000 }); await page.click('#dp-primary'); await page.waitForSelector('.dp-sheet');
      for (const id of ['gantry', 'estop', 'remote', 'rope']) await page.locator(`[data-confirm="${id}"]`).check();
      await page.click('#dp-sheet-ok');
    };
    const state = () => page.evaluate(() => { const D = window.__deploy; return { session: D.fn.session()?.name ?? null, attached: D.fn.attached(), sheet: D.S.sheet?.kind ?? null, startedHere: D.S.startedHere, sheetError: D.S.sheetError ?? null }; });
    await startHere(); await page.waitForTimeout(4500);
    const late = await state();
    assert(late.session && late.attached && !late.sheet && !late.startedHere, `late reply: ${JSON.stringify(late)}`);
    await endAll(); await page.waitForTimeout(1500);
    mode = 'lost'; await startHere(); await page.waitForTimeout(5000);
    const lost = await state();
    assert(lost.session && lost.attached && !lost.sheet, `lost reply, found by start_id: ${JSON.stringify(lost)}`);
    await endAll(); await page.waitForTimeout(1500);
    mode = 'other'; await startHere(); await page.waitForTimeout(5000);
    const other = await state();
    await page.screenshot({ path: path.join(shots, 'r04-other-session.png') });
    assert(other.session && !other.attached, `another operator's session is not attached: ${JSON.stringify(other)}`);
    const errs = pageErrors('R04'); await context.close();
    assert(!errs.length, `no page errors: ${JSON.stringify(errs)}`);
    return { late, lost, other };
  });

  // R06: the console's last attempt arrived; its passage (injected into the panel reply) crossed, missed, required and
  // not scored, or not required. Live list, tag card and the outcome model agree.
  await check('R06', 'one attempt outcome: arrived with the gap missed is not a pass, live and on the tag card', async () => {
    await startPractice('Review check');
    let passage = 'missed';
    const { page, context } = await open('R06', { before: async p => {
      await p.route('**/api/deploy/panel?*', async route => {
        const response = await route.fetch(), json = await response.json();
        const a = { n: 1, outcome: 'arrived', result: 'arrived', final_dist_m: 0.12, duration_s: 25 };
        if (passage === 'missed' || passage === 'crossed') Object.assign(a, { passage, passage_required: true });
        if (passage === 'unscored') a.passage = { a: [1, 0.3], b: [1, -0.3] };
        Object.assign(json, { phase: 'ARRIVED', runner: 'CONTROL', attempts: [a] });
        await route.fulfill({ response, json });
      });
      await p.route('**/api/deploy/session?*', route => route.fulfill({ json: { supported: false, capability: 'session_detail' } }));
    } });
    await page.evaluate(() => { const D = window.__deploy; D.S.attached = D.fn.session()?.name; D.setStep('deploy'); });
    const read = async () => { await page.waitForTimeout(1500); return page.evaluate(() => ({ chip: document.querySelector('.dp-attempts .outcome')?.className ?? '', text: document.querySelector('.dp-attempts li')?.innerText ?? '', card: document.querySelector('.dp-tagcard')?.innerText ?? '' })); };
    const out = {};
    for (const p of ['missed', 'crossed', 'unscored', 'none']) { passage = p; out[p] = await read(); if (p === 'missed') await page.screenshot({ path: path.join(shots, 'r06-missed.png') }); }
    const errs = pageErrors('R06'); await context.close();
    assert(/outcome-warn/.test(out.missed.chip) && /gap missed/.test(out.missed.text) && /not a task pass/.test(out.missed.card), `missed: ${JSON.stringify(out.missed)}`);
    assert(/outcome-good/.test(out.crossed.chip), `crossed: ${JSON.stringify(out.crossed)}`);
    assert(/outcome-warn/.test(out.unscored.chip) && /not scored/.test(out.unscored.text), `required, not scored: ${JSON.stringify(out.unscored)}`);
    assert(/outcome-good/.test(out.none.chip), `not required: ${JSON.stringify(out.none)}`);
    assert(!errs.length, JSON.stringify(errs));
    return out;
  });

  // R07: a focused step button keeps the focus through polling; a goal typed with the keyboard is checked there.
  await check('R07', 'focus survives polling; a goal typed with the keyboard is checked at those numbers', async () => {
    const { page, context } = await open('R07');
    await page.focus('#dp-strip [data-step="goal"]'); await page.waitForTimeout(2500);
    const focus = await page.evaluate(() => ({ tag: document.activeElement.tagName, step: document.activeElement.dataset.step ?? null }));
    assert(focus.tag === 'BUTTON' && focus.step === 'goal', `focus kept: ${JSON.stringify(focus)}`);
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.__deploy.S.step === 'goal' && !!window.__deploy.S.scene, null, { timeout: 15000 });
    await page.waitForSelector('#dp-goal-x');
    await page.focus('#dp-goal-x'); await page.keyboard.type('1.25'); await page.keyboard.press('Tab');
    await page.keyboard.type('-0.40'); await page.waitForTimeout(1200);  // polls in between: the draft and the focus stay
    const mid = await page.evaluate(() => ({ id: document.activeElement.id, y: document.getElementById('dp-goal-y').value }));
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => !!window.__deploy.S.goal?.check, null, { timeout: 15000 });
    const goal = await page.evaluate(() => ({ xy: window.__deploy.S.goal.xy, status: window.__deploy.fn.goalStatus() }));
    await page.screenshot({ path: path.join(shots, 'r07-typed-goal.png') });
    const errs = pageErrors('R07'); await context.close();
    assert(mid.id === 'dp-goal-y' && mid.y === '-0.40', `typing survives polling: ${JSON.stringify(mid)}`);
    assert(goal.xy[0] === 1.25 && goal.xy[1] === -0.4, `checked at the typed numbers: ${JSON.stringify(goal)}`);
    assert(!errs.length, JSON.stringify(errs));
    return { focus, mid, goal };
  });

  // Review's session list: the kit sends `started` as ISO text and `started_unix` as a number (as the fake does now).
  await check('DATE', 'Review lists session start times, never "Invalid Date"', async () => {
    const s = await startPractice('Review check'); await sleep(1200); await hubPost('/api/fake/end', { slot: 'sim' }); await sleep(1500);
    const { page, context } = await open('DATE');
    await page.evaluate(() => window.__deploy.setStep('review')); await page.waitForSelector('#dp-review');
    const opts = await page.evaluate(() => [...document.querySelectorAll('#dp-review option')].map(o => o.textContent));
    await context.close();
    assert(opts.length && !opts.some(t => /Invalid Date|NaN/.test(t)), JSON.stringify(opts));
    assert(opts.some(t => t.includes(s.name) && /\d\d:\d\d/.test(t)), `the session's start time: ${JSON.stringify(opts)}`);
    return { opts: opts.slice(0, 4) };
  });
} catch (e) { report.fatal = String(e?.stack ?? e); console.log(report.fatal); } finally {
  if (browser) await browser.close();
  for (const c of children) c.kill('SIGTERM');
  await sleep(500);
  for (const c of children) if (c.exitCode === null) c.kill('SIGKILL');
  report.finished = new Date().toISOString();
  report.passed = report.checks.filter(c => c.pass).length; report.failed = report.checks.filter(c => !c.pass).length;
  await writeFile(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  console.log(`${report.passed} passed, ${report.failed} failed; report: ${path.join(shots, 'report.json')}`);
  process.exitCode = report.failed || report.fatal ? 1 : 0;
}
