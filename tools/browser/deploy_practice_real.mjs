// Deploy workspace on the REAL deploy chain, in Practice: the kit's deploy service (`./g1 lab --headless`) runs real
// simulations (robot_sim + SONIC runner + planner node) for the scan, the rehearsal set and the practice session.
//   STUDIO_URL=http://127.0.0.1:8795 ROOM=course:gap-069 GOAL=2.8,0 node tools/browser/deploy_practice_real.mjs
// The gateway's config/local.json deploy_service.url must point at that service. Nothing here touches a robot: Practice
// never starts `g1 robot`. Hold the machine's simulation lock around it (real-time simulations need a quiet machine).
//
// Connect, practice scan, goal, rehearsal set (three cases), practice session (checklist), Arm, Start SONIC, Clear map,
// Send goal (start check), GO, the walk, arrival, tag, E-STOP (standing), End session, Review, and Review reopened from
// its link in a fresh browser context.
//
// Strict: any page error, console error or unexpected HTTP error fails the run; the walk must arrive and the E-STOP be
// CONFIRMED. The report (report.json) says full_run: true only when every step ran in this one invocation, and holds the
// source hashes of the Studio files under test, Studio's and the kit's versions and the session's receipt.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SOURCES = ['apps/web/js/deploy.js', 'apps/web/js/deploy3d.js', 'apps/web/deploy.css', 'apps/web/app.js', 'studio/deploy_link.py', 'studio/server.py', 'tools/browser/deploy_practice_real.mjs'];
const sourceHashes = Object.fromEntries(await Promise.all(SOURCES.map(async f => [f, createHash('sha256').update(await readFile(path.join(root, f))).digest('hex')])));

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8795';
const room = process.env.ROOM || 'course:gap-069';
const goal = (process.env.GOAL || '2.8,0').split(',').map(Number);
const profile = process.env.PROFILE || null;
const shots = process.env.DEPLOY_SHOTS || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/deploy-practice-real');
await mkdir(shots, { recursive: true });

const report = { base, room, goal, profile, started: new Date().toISOString(), full_run: false, source_hashes: sourceHashes, steps: [], errors: [], http: [] };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let where = 'boot';
// Expected HTTP refusals: a live view or panel 404 between a session's end and the next state poll; a lease 409 when an
// earlier tab's lease is still running out. Everything else at 400 or above is an error.
const EXPECTED = [{ status: 404, re: /^\/api\/deploy\/(live|panel)$/ }, { status: 409, re: /^\/api\/deploy\/lease$/ }];
function watch(p, label) {
  p.on('pageerror', e => report.errors.push({ page: label, step: where, kind: 'pageerror', message: e.message }));
  p.on('console', m => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) report.errors.push({ page: label, step: where, kind: 'console', message: m.text() }); });
  p.on('response', r => {
    if (r.status() < 400) return;
    const row = { page: label, step: where, status: r.status(), path: new URL(r.url()).pathname };
    report.http.push(row);
    if (!EXPECTED.some(e => e.status === row.status && e.re.test(row.path))) report.errors.push({ ...row, kind: 'http', message: `${row.status} ${row.path}` });
  });
}
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
page.setDefaultTimeout(30000);
watch(page, 'main');

const S = () => page.evaluate(() => {
  const d = window.__deploy.S;
  return { step: d.step, scan: d.scanName, goalOk: d.goal?.check?.ok ?? null, session: Object.values(d.state?.live ?? {}).find(v => v?.running)?.name ?? null,
    phase: d.panel?.phase ?? null, runner: d.panel?.runner ?? null, ladder: Object.fromEntries((d.panel?.ladder ?? []).map(l => [l.key, l.state])),
    locks: d.panel?.go_locks ?? [], attempts: d.panel?.attempts ?? [],
    rehearsal: d.match?.data?.complete ?? d.match?.data?.running ?? (d.state?.rehearsals ?? []).find(r => r.name === d.rehearsalName) ?? null,
    tracks: d.tracks ? Object.keys(d.tracks) : null, estop: d.estop.state, lease: !!d.lease.id, scanJob: d.state?.scan_job?.running ?? null };
});
const until = async (what, fn, timeout = 30000, every = 500) => {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < timeout) { last = await S(); if (await fn(last)) return last; await page.waitForTimeout(every); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify(last)}`);
};
const step = name => { where = name; report.steps.push({ name, at: new Date().toISOString() }); console.log(`· ${name}  ${new Date().toISOString()}`); };
const shot = async name => { await page.waitForTimeout(600); await page.screenshot({ path: path.join(shots, `${name}.png`) }); };
const primary = () => page.locator('#dp-primary');
const primaryText = async () => (await primary().textContent()).trim();
const ready = async re => re.test(await primaryText()) && !(await primary().isDisabled());
const clickScene = async xy => {
  const pt = await page.evaluate(p => window.__deploy.project([p[0], p[1], 0]), xy);
  await page.mouse.move(pt[0] - 30, pt[1] - 20); await page.mouse.move(pt[0], pt[1], { steps: 4 }); await page.waitForTimeout(250);
  await page.mouse.click(pt[0], pt[1]);
};

let failure = null;
try {
  step('connect');
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${base}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__studio?.state?.ready && window.__deploy?.S?.stateOk, null, { timeout: 60000 });
  assert.equal(await page.evaluate(() => window.__studio.state.workspace), 'deploy');
  if (profile) await page.selectOption('#dp-profile', profile).catch(() => {});
  await page.fill('#dp-operator', 'Practice e2e');
  await primary().click();
  await until('the lease', s => s.lease);
  await shot('01-connect');

  step('scan');
  await primary().click();
  await page.selectOption('#dp-room', room);
  const before = (await S()).scan;
  if (await ready(/Scan the/)) await primary().click(); else await page.locator('.dp-foot [data-action="scan"]').click();
  await page.waitForTimeout(6000);
  await shot('02-scan-running');
  await until('the new scan', s => s.scan && s.scan !== before && s.scanJob === false, 120000, 1000);
  await page.waitForFunction(() => window.__deploy.S.scene?.name === window.__deploy.S.scanName, null, { timeout: 30000 });
  await shot('03-scan-done');

  step('goal');
  await until('Pick a goal', async () => ready(/pick a goal/i), 20000);
  await primary().click();
  await clickScene(goal);
  const g = await until('the goal check', s => s.goalOk !== null, 20000);
  assert.equal(g.goalOk, true, 'the goal passes its check');
  await shot('04-goal');

  step('rehearse');
  await primary().click();
  await until('Rehearse', async () => ready(/Rehearse/), 10000);
  await primary().click();
  await page.waitForTimeout(20000);
  await shot('05-rehearse-running');
  const r = await until('the rehearsal verdict', s => s.rehearsal?.verdict && s.rehearsal.state === 'complete' && s.tracks?.length === 3, 900000, 3000);
  report.rehearsal = r.rehearsal;
  const dur = Number(await page.locator('#dp-tl').getAttribute('max'));
  await page.locator('#dp-tl').evaluate((el, v) => { el.value = String(v); el.dispatchEvent(new Event('input', { bubbles: true })); }, dur * 0.6);
  await shot('06-rehearse-ghosts');

  step('session');
  await until('Next: deploy', async () => ready(/deploy/i), 10000);
  await primary().click();
  await until('Start practice session', async () => ready(/Start practice session/), 10000);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  for (const box of await page.locator('.dp-sheet [data-confirm]').all()) await box.check();
  await shot('07-start-sheet');
  await page.click('#dp-sheet-ok');
  await until('the practice session', s => !!s.session, 60000);
  await page.waitForSelector('#deploy-estop:not([hidden])');
  report.session = (await S()).session;
  report.receipt = await page.evaluate(() => window.__deploy.fn.ident()?.receipt ?? null);
  assert.ok(await page.evaluate(() => window.__deploy.fn.attached()), 'the tab that started the session is attached to it');

  step('arm');
  await until('Arm', async () => ready(/Arm/), 60000);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  await page.locator('.dp-sheet [data-armed]').check();
  await page.click('#dp-sheet-ok');
  await page.waitForTimeout(8000);
  await shot('08-arming');
  step('sonic');
  await until('Start SONIC enabled', async () => ready(/Start SONIC/), 120000);
  await primary().click();
  await until('CONTROL', s => s.runner === 'CONTROL', 30000);
  step('clear-map');
  await until('Clear map', async () => ready(/Clear map/), 20000);
  await primary().click();
  await page.waitForTimeout(3000);
  await shot('09-clear-map');
  await until('the 10 s rescan', s => s.ladder.map === 'done', 30000);
  step('send-goal');
  await until('Send goal', async () => ready(/Send goal/), 20000);
  await primary().click();
  await page.waitForSelector('.dp-body .callout.ok', { timeout: 20000 });
  await shot('10-goal-sent');
  report.goal_sent = await page.locator('.dp-body .callout.ok').first().textContent();
  step('go');
  await until('GO', async () => ready(/GO/), 20000);
  await primary().click();
  await page.waitForSelector('.dp-sheet');
  for (const box of await page.locator('.dp-sheet input[type="checkbox"]').all()) await box.check();
  await shot('11-go-sheet');
  await page.click('#dp-sheet-ok');
  await until('walking', s => ['PRESCAN', 'RUN', 'ARRIVED'].includes(s.phase), 20000, 200);
  await page.waitForTimeout(2500);
  await shot('12-walking');
  const end = await until('the walk to end', s => ['ARRIVED', 'STOPPED'].includes(s.phase) || s.attempts.at(-1)?.result, 90000, 500);
  report.attempt = end.attempts.at(-1) ?? null;
  assert.equal(report.attempt?.result ?? report.attempt?.outcome, 'arrived', `the walk arrived: ${JSON.stringify(report.attempt)}`);
  await page.waitForTimeout(1500);
  await shot('13-arrived');

  step('tag');
  await page.waitForSelector('.dp-tagcard', { timeout: 20000 });
  await page.locator('.dp-tagcard [data-tag="clean"]').click();
  await page.locator('.dp-tagcard input[data-note]').fill('practice e2e on the real chain');
  await until('Save tag', async () => ready(/Save tag/), 10000);
  await primary().click();
  await until('the tag', s => s.attempts.at(-1)?.tag === 'clean', 15000);
  await shot('13c-tagged');

  step('estop');
  await page.click('#dp-estop');
  const es = await until('E-STOP confirmed', s => ['confirmed', 'failed'].includes(s.estop), 15000, 100);
  report.estop = es.estop;
  assert.equal(es.estop, 'confirmed', 'the E-STOP was CONFIRMED by the runner');
  await shot('14-estop');

  step('end');
  await until('End session', async () => ready(/End session/i), 20000);
  await primary().click();
  if (await page.locator('.dp-sheet').count()) await page.click('#dp-sheet-ok');
  await until('Review', s => s.step === 'review' && !s.session, 60000, 1000);
  await page.waitForTimeout(4000);
  await shot('15-review');

  // Review reopened from its link in a fresh browser context: the attempt, its outcome and tag survive.
  step('review-fresh');
  const ctx2 = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fresh = await ctx2.newPage(); fresh.setDefaultTimeout(30000); watch(fresh, 'fresh');
  await fresh.goto(`${base}/?workspace=deploy&session=${encodeURIComponent(report.session)}&attempt=1`, { waitUntil: 'domcontentloaded' });
  await fresh.waitForFunction(() => !!document.querySelector('.dp-rev-attempt.sel'), null, { timeout: 60000 });
  const rev = await fresh.evaluate(() => document.querySelector('.dp-panel-content').innerText);
  assert.match(rev, /arrived/, 'the reopened Review shows the outcome');
  assert.match(rev, /clean/, 'the reopened Review shows the tag');
  assert.doesNotMatch(rev, /Evidence\s*0 of 0/, 'never an empty evidence list');
  // The recording line of an ended session: finalized (or ended), never "NOT RUNNING" for a closed recording.
  const recLine = await fresh.evaluate(() => document.querySelector('.dp-rev-rec')?.textContent ?? '');
  assert.match(recLine, /Recording (finalized|ended) · (\d+) of \2 required streams recorded/, `the recording line of an ended session: ${recLine}`);
  assert.doesNotMatch(recLine, /NOT RUNNING|stalled|NOT finalized/, `a closed recording is not shown as dead: ${recLine}`);
  const evidence = await fresh.evaluate(() => [...document.querySelectorAll('.dp-panel-content h4')].find(h => /Evidence/.test(h.textContent))?.textContent ?? '');
  const ev = evidence.match(/(\d+) of (\d+) required present/);
  assert.ok(ev && ev[1] === ev[2] && /· complete/.test(evidence), `every required evidence item present and complete: ${evidence}`);
  report.review_recording = recLine; report.review_evidence = evidence;
  report.review_fresh = rev.slice(0, 1200);
  await fresh.screenshot({ path: path.join(shots, '16-review-fresh-browser.png') });
  await ctx2.close();
  report.full_run = true;
} catch (e) {
  failure = e;
  await page.screenshot({ path: path.join(shots, 'zz-failure.png') }).catch(() => {});
} finally {
  report.finished = new Date().toISOString();
  report.failure = failure ? String(failure.stack || failure) : null;
  if (report.errors.length) report.full_run = false;
  try { report.studio_version = await (await fetch(`${base}/api/version`)).json(); } catch { report.studio_version = null; }
  try { const st = await (await fetch(`${base}/api/deploy/state`)).json(); report.kit_version = st.version ?? null; } catch { report.kit_version = null; }
  report.environment = { node: process.version, host: os.hostname(), platform: process.platform };
  await writeFile(path.join(shots, 'report.json'), JSON.stringify(report, null, 2));
  await browser.close();
}
console.log(JSON.stringify({ failure: report.failure, errors: report.errors, http: report.http.slice(0, 20), rehearsal: report.rehearsal && { verdict: report.rehearsal.verdict, results: report.rehearsal.results }, attempt: report.attempt, estop: report.estop, goal_sent: report.goal_sent }, null, 1));
process.exit(failure || report.errors.length ? 1 : 0);
