#!/usr/bin/env node
// Browser acceptance for the static site: load, pick a goal, send, Go, watch a walk to its end, the robot day,
// the diagram, no console errors; desktop and phone widths.
//   SITE_URL=http://127.0.0.1:8811/ SITE_EVIDENCE=<dir> node tools/site/check.mjs
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const URL_ = process.env.SITE_URL || 'http://127.0.0.1:8811/';
const OUT = process.env.SITE_EVIDENCE || 'site-check';
const results = [];
const check = async (name, fn) => {
  const t0 = Date.now();
  try { const detail = await fn(); results.push({ name, ok: true, detail, ms: Date.now() - t0 }); console.log(`PASS ${name}${detail ? ` · ${detail}` : ''}`); }
  catch (e) { results.push({ name, ok: false, detail: String(e.message ?? e).slice(0, 400), ms: Date.now() - t0 }); console.log(`FAIL ${name} · ${e.message}`); }
};

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const problems = [];
async function open(viewport, label) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage();
  page.on('pageerror', e => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
  // A video element fetches its metadata and aborts the rest until played: that is not a failure.
  page.on('requestfailed', r => { if (!(/\.mp4$/.test(r.url()) && /ERR_ABORTED/.test(r.failure()?.errorText ?? ''))) problems.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', r => { if (r.status() >= 400) problems.push(`${label} HTTP ${r.status()}: ${r.url()}`); });
  await page.goto(URL_, { waitUntil: 'domcontentloaded' });
  return { context, page };
}

const { page } = await open({ width: 1440, height: 900 }, 'desktop');
await check('playground loads a room and the robot', async () => {
  await page.waitForSelector('#try.pg-ready', { timeout: 60000 });
  const s = await page.evaluate(() => ({ world: window.studioPlayground.S.worldId, cells: window.studioPlayground.S.world.cells.length, recorded: window.studioPlayground.S.recorded.length, robot: !!window.studioPlayground.viewer.robot }));
  if (!s.robot || !s.recorded) throw new Error(JSON.stringify(s));
  await page.screenshot({ path: path.join(OUT, 'desktop-hero.png') });
  return `${s.world}: ${s.recorded} recorded of ${s.cells} cells`;
});
await check('nothing that should be hidden is shown before a goal is picked', async () => {
  if (!(await page.locator('#pg-send').isDisabled())) throw new Error('Send goal enabled with no goal picked');
  const shown = await page.evaluate(() => ['pg-go', 'pg-clear', 'pg-timeline', 'pg-outcome', 'pg-result']
    .filter(id => { const n = document.getElementById(id); return n && n.getClientRects().length > 0; }));
  if (shown.length) throw new Error(`visible: ${shown.join(', ')}`);
  return 'Send disabled; Go, Clear, timeline and outcome hidden';
});
await check('clicking the floor shows the six goal checks', async () => {
  await page.locator('#try').scrollIntoViewIfNeeded();
  const box = await page.locator('#pg-canvas canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.62, box.y + box.height * 0.5);
  await page.waitForSelector('#pg-goal .check', { timeout: 5000 });
  const n = await page.locator('#pg-goal .check').count();
  if (n !== 6) throw new Error(`${n} checks`);
  return await page.locator('#pg-goal .verdict').innerText();
});
// The outcome rule, restated here from the site's documentation so the page is checked against the raw data.
function expectedGrade(walk) {
  const contact = (walk.max_contact_n ?? 0) > 100;
  if (walk.outcome === 'arrived') return contact ? 'Arrived, with contact' : (walk.final_dist_m ?? 0) > 0.6 ? 'Arrived by its estimate, off by truth' : 'Arrived';
  return { stopped: 'Stopped', estop: 'E-stop', fell: 'Fell' }[walk.outcome] ?? walk.outcome;
}
await check('pick for me, press g on the keyboard, the timeline moves, the outcome matches the raw walk', async () => {
  await page.evaluate(() => { window.studioPlayground.S.speed = 4; });
  await page.click('#pg-random');
  await page.waitForSelector('#pg-go:visible', { timeout: 5000 });
  if (await page.locator('#pg-send').isVisible()) throw new Error('Send still visible once staged');
  await page.screenshot({ path: path.join(OUT, 'desktop-staged.png') });
  await page.keyboard.press('g');
  await page.waitForFunction(() => window.studioPlayground.S.mode === 'playing', null, { timeout: 15000 });
  const t0 = await page.locator('#pg-time').innerText();
  await page.waitForTimeout(2500);
  const t1 = await page.locator('#pg-time').innerText();
  await page.screenshot({ path: path.join(OUT, 'desktop-walking.png') });
  if (t0 === t1) throw new Error(`timeline frozen at ${t0}`);
  await page.waitForFunction(() => window.studioPlayground.S.mode === 'done', null, { timeout: 120000 });
  await page.screenshot({ path: path.join(OUT, 'desktop-done.png') });
  const id = await page.evaluate(() => `${window.studioPlayground.S.worldId}/g/${window.studioPlayground.S.walk.goal_id}.json`);
  const raw = await (await page.request.get(new URL(`data/${id}`, URL_).href)).json();
  const shown = await page.locator('#pg-outcome-title').innerText();
  if (shown !== expectedGrade(raw)) throw new Error(`outcome "${shown}" but the raw walk says "${expectedGrade(raw)}"`);
  const arrived = raw.events.find(e => e.type === 'arrived');
  const text = await page.locator('#pg-outcome-text').innerText();
  if (arrived && !text.includes(`arrived ${arrived.dist.toFixed(2)} m from the goal`)) throw new Error(`arrival sentence does not use the arrival distance ${arrived.dist}: ${text.slice(0, 160)}`);
  return `${t0} -> ${t1}; ${shown}`;
});
await check('Escape puts a staged goal away', async () => {
  await page.click('#pg-random');
  await page.waitForSelector('#pg-go:visible', { timeout: 5000 });
  await page.keyboard.press('Escape');
  const mode = await page.evaluate(() => window.studioPlayground.S.mode);
  if (mode !== 'pick') throw new Error(`mode ${mode} after Escape`);
  await page.click('#pg-random');
  await page.keyboard.press('g');
  await page.waitForFunction(() => window.studioPlayground.S.mode === 'done', null, { timeout: 120000 });
  return 'Escape returns to picking';
});
await check('scrubbing seeks, and scrubbing back rebuilds the map', async () => {
  const before = await page.evaluate(() => ({ t: window.studioPlayground.S.t, step: window.studioPlayground.S.mapStep, d: window.studioPlayground.S.walk.duration }));
  await page.locator('#pg-scrub').scrollIntoViewIfNeeded();
  const bar = await page.locator('#pg-scrub').boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.15, bar.y + bar.height / 2);
  const after = await page.evaluate(() => ({ t: window.studioPlayground.S.t, step: window.studioPlayground.S.mapStep }));
  if (!(Math.abs(after.t - before.t) > 0.3 * before.d)) throw new Error(`t ${before.t.toFixed(2)} -> ${after.t.toFixed(2)} of ${before.d.toFixed(2)}`);
  if (!(after.step < before.step)) throw new Error(`map step ${before.step} -> ${after.step}`);
  const text = await page.locator('#pg-time').innerText();
  return `t ${before.t.toFixed(1)} -> ${after.t.toFixed(1)} s, map step ${before.step} -> ${after.step}, readout ${text}`;
});
await check('a new goal can be picked while a walk is paused', async () => {
  await page.evaluate(() => window.studioPlayground.pause());
  if (!(await page.locator('#pg-clear').isVisible())) throw new Error('no New goal control');
  await page.click('#pg-clear');
  const mode = await page.evaluate(() => window.studioPlayground.S.mode);
  if (mode !== 'pick') throw new Error(mode);
  return 'New goal returns to picking';
});
await check('every room loads', async () => {
  const ids = await page.evaluate(() => window.studioPlayground.catalog.map(w => w.id));
  for (const id of ids) { await page.click(`[data-world="${id}"]`); await page.waitForFunction(i => window.studioPlayground.S.worldId === i, id, { timeout: 20000 }); }
  return ids.join(', ');
});
await check('the system diagram answers a click', async () => {
  await page.locator('#how').scrollIntoViewIfNeeded();
  await page.waitForSelector('#pipeline svg .node', { timeout: 10000 });
  await page.click('#pipeline .node[data-id="node"]');
  const title = await page.locator('#pipeline-detail h3').innerText();
  await page.screenshot({ path: path.join(OUT, 'desktop-how.png'), fullPage: false });
  if (!/node\.py/.test(title)) throw new Error(title);
  return title;
});
await check('robot day: a fault blocks the checklist, a clean run walks, focus is kept', async () => {
  await page.locator('#robot-day').scrollIntoViewIfNeeded();
  await page.waitForSelector('#day-steps button', { timeout: 15000 });
  await page.click('[data-step="2"]');
  await page.check('[data-fault="leg"]');
  const blocked = await page.locator('#day-verdict').innerText();
  if (!/Do not press g/.test(blocked)) throw new Error(`fault did not block: ${blocked}`);
  await page.uncheck('[data-fault="leg"]');
  await page.click('[data-step="3"]');
  await page.click('#day-suggest');
  await page.click('#day-send');
  await page.click('#day-g');
  await page.waitForTimeout(2500);
  const focus = await page.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.screenshot({ path: path.join(OUT, 'desktop-robot-day.png') });
  const playing = await page.evaluate(() => document.getElementById('day-canvas').getAttribute('aria-label'));
  if (!/walking/.test(playing)) throw new Error(`no walk: ${playing}`);
  if (focus === 'BODY') throw new Error('focus dropped to the page');
  return `blocked with leg odometry; walked with the suggested goal; focus on ${focus}`;
});
await check('every section is built once the page is idle (Tab reaches them)', async () => {
  const fresh = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await fresh.goto(URL_);
  await fresh.waitForSelector('#pipeline .node', { state: 'attached', timeout: 15000 });
  await fresh.waitForSelector('#day-steps button', { state: 'attached', timeout: 15000 });
  await fresh.waitForSelector('#findings-cards .finding', { state: 'attached', timeout: 15000 });
  await fresh.context().close();
  return 'diagram, robot day and findings built without scrolling';
});
await check('findings and tour render', async () => {
  await page.locator('#findings').scrollIntoViewIfNeeded();
  await page.waitForSelector('#findings-cards .finding', { timeout: 10000 });
  const n = await page.locator('#findings-cards .finding').count();
  // The findings count walks from the same recordings as the rooms: the totals must agree.
  const rooms = await (await page.request.get(new URL('data/worlds.json', URL_).href)).json();
  const featured = await (await page.request.get(new URL('data/featured.json', URL_).href)).json();
  const total = rooms.worlds.reduce((a, w) => a + w.walks, 0);
  if (featured.facts.walks !== total) throw new Error(`findings count ${featured.facts.walks} walks, the rooms ${total}`);
  for (const w of rooms.worlds) if (featured.facts.contact?.[w.id] && featured.facts.contact[w.id].walks !== w.walks) throw new Error(`${w.id}: ${featured.facts.contact[w.id].walks} vs ${w.walks}`);
  await page.locator('#tour').scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT, 'desktop-findings.png') });
  return `${n} findings`;
});

const phone = await open({ width: 390, height: 844 }, 'phone');
await check('phone: the playground fits and a tap picks a goal', async () => {
  await phone.page.waitForSelector('#try.pg-ready', { timeout: 60000 });
  await phone.page.locator('#try').scrollIntoViewIfNeeded();
  await phone.page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await phone.page.waitForTimeout(1500);
  const wide = await phone.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await phone.page.locator('#try').scrollIntoViewIfNeeded();
  const box = await phone.page.locator('#pg-canvas canvas').boundingBox();
  await phone.page.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.45);
  await phone.page.waitForTimeout(400);
  await phone.page.screenshot({ path: path.join(OUT, 'phone-playground.png') });
  if (wide > 1) throw new Error(`page scrolls sideways by ${wide}px`);
  const touch = await phone.page.evaluate(() => document.querySelector('#pg-canvas canvas').style.touchAction);
  if (touch !== 'pan-y') throw new Error(`canvas touch-action is ${touch}: a vertical swipe would not scroll the page`);
  const legendOpen = await phone.page.evaluate(() => document.getElementById('pg-legend').open);
  if (legendOpen) throw new Error('the legend is open on a phone and pushes the timeline down');
  return `canvas ${Math.round(box.width)}×${Math.round(box.height)}`;
});

await check('no console errors, page errors or failed requests', async () => {
  const real = problems.filter(p => !/favicon/.test(p));
  if (real.length) throw new Error(real.slice(0, 8).join(' | '));
  return 'clean';
});
await writeFile(path.join(OUT, 'results.json'), JSON.stringify({ url: URL_, results, problems }, null, 1));
await browser.close();
const failed = results.filter(r => !r.ok).length;
console.log(`${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
