#!/usr/bin/env node
// Browser acceptance for the static site: the main page loads light and starts the demo on request; pick a goal,
// read its checks where you clicked, send, Go, watch a walk to its end and check its grade against the raw data;
// the picker, layers, keys, rooms, the split view, the diagram, the robot day, the findings, the next-step page
// (public build: Studio's own measurements only), the standalone demo by deep link, phones; no console errors.
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
const data = async p => (await fetch(new URL(`data/${p}`, URL_))).json();

await mkdir(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const problems = [];
async function open(viewport, label, at = '') {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage();
  const requests = [];
  page.on('pageerror', e => problems.push(`${label} pageerror: ${e.message}`));
  page.on('console', m => { if (m.type() === 'error') problems.push(`${label} console: ${m.text()}`); });
  // A video element fetches its metadata and aborts the rest until played: that is not a failure.
  page.on('requestfailed', r => { if (!(/\.mp4$/.test(r.url()) && /ERR_ABORTED/.test(r.failure()?.errorText ?? ''))) problems.push(`${label} requestfailed: ${r.url()} ${r.failure()?.errorText}`); });
  page.on('response', r => { if (r.status() >= 400) problems.push(`${label} HTTP ${r.status()}: ${r.url()}`); });
  page.on('requestfinished', async r => { const s = await r.sizes().catch(() => null); requests.push({ url: r.url(), bytes: s ? s.responseBodySize + s.responseHeadersSize : 0 }); });
  await page.goto(URL_ + at, { waitUntil: 'domcontentloaded' });
  return { context, page, requests };
}
const catalog = (await data('worlds.json')).worlds, featured = await data('featured.json');
const totalWalks = catalog.reduce((n, w) => n + w.walks, 0);
// The outcome rule, restated here from the site's documentation so the page is checked against the raw data.
function expectedGrade(walk) {
  const contact = (walk.max_contact_n ?? 0) > 100;
  if (walk.outcome === 'arrived') return contact ? 'Arrived, with contact' : (walk.final_dist_m ?? 0) > 0.6 ? ((walk.final_dist_estimate_m ?? 0) > 0.6 ? 'Arrived, then moved away' : 'Arrived by its estimate, off by truth')
    : walk.final_dist_m == null || walk.max_contact_n == null ? 'Arrived, not fully graded' : 'Arrived';
  return { stopped: 'Stopped', estop: 'E-stop', fell: 'Fell' }[walk.outcome] ?? walk.outcome;
}

const { page, requests } = await open({ width: 1440, height: 900 }, 'desktop');
const D = fn => page.evaluate(fn);
await check('the page loads light: nothing heavy before Start', async () => {
  await page.waitForLoadState('load');
  await page.waitForTimeout(2500);
  const heavy = requests.filter(r => /three\.module|meshes\.bin|\/g\/g\d\d-\d\d\.json|\.mp4$/.test(r.url));
  if (heavy.length) throw new Error(`loaded before Start: ${heavy.map(r => r.url.split('/').slice(-2).join('/')).join(', ')}`);
  const kb = Math.round(requests.reduce((n, r) => n + r.bytes, 0) / 1024);
  await page.screenshot({ path: path.join(OUT, 'desktop-top.png') });
  return `${requests.length} requests, ${kb} kB before anything is started`;
});
await check('Start loads the demo: a room, the robot, the recorded goals', async () => {
  await page.click('#try .poster .start');
  await page.waitForSelector('#demo-stage.is-ready', { timeout: 60000 });
  const s = await D(() => ({ world: window.studioDemo.S.worldId, cells: window.studioDemo.S.world.cells.length, recorded: window.studioDemo.S.recorded.length, robot: !!window.studioDemo.viewer.robot }));
  if (!s.robot || !s.recorded) throw new Error(JSON.stringify(s));
  const kb = Math.round(requests.reduce((n, r) => n + r.bytes, 0) / 1024);
  await page.screenshot({ path: path.join(OUT, 'desktop-demo.png') });
  return `${s.world}: ${s.recorded} recorded of ${s.cells} cells; ${kb} kB so far`;
});
await check('nothing that should be hidden is shown before a goal is picked', async () => {
  if (!(await page.locator('#demo-stage [data-el="go"]').isDisabled())) throw new Error('Go enabled with no goal');
  const shown = await D(() => ['chip', 'result', 'hud'].filter(k => { const n = document.querySelector(`#demo-stage [data-el="${k}"]`); return n && n.getClientRects().length > 0; }));
  if (shown.length) throw new Error(`visible: ${shown.join(', ')}`);
  if (await page.locator('#demo-stage .scrub').isVisible()) throw new Error('timeline visible with no walk');
  return 'Go disabled; checks, result, readouts and timeline hidden';
});
await check('clicking the floor shows the checks at the goal, and all six on demand', async () => {
  const box = await page.locator('#demo-stage canvas').boundingBox();
  await page.mouse.click(box.x + box.width * 0.4, box.y + box.height * 0.62);
  await page.waitForSelector('#demo-stage [data-el="chip"]:not([hidden])', { timeout: 5000 });
  const verdict = await page.locator('#demo-stage .gc-verdict').innerText();
  // The chip sits above the goal's pin: on screen, around where the goal projects.
  const near = await D(() => { const d = window.studioDemo, c = d.el.chip.getBoundingClientRect(), r = d.root.getBoundingClientRect(), p = d.viewer.project(d.S.selected.xy[0], d.S.selected.xy[1], 0.78);
    return p && Math.abs(c.left + c.width / 2 - (r.left + p[0])) < c.width / 2 + 10 && c.bottom <= r.top + p[1] + 8 ? 'ok' : JSON.stringify({ chip: [c.left, c.bottom, c.width], pin: p }); });
  if (near !== 'ok') throw new Error(`the checks are not anchored at the goal: ${near}`);
  await page.click('#demo-stage [data-act="more"]');
  const n = await page.locator('#demo-stage .goal-chip .check').count();
  if (n !== 6) throw new Error(`${n} checks`);
  // Each check is one row of three columns, not text wrapped a word per line (page styles must not leak in).
  const tall = await D(() => [...document.querySelectorAll('#demo-stage .goal-chip .check')].filter(r => getComputedStyle(r).gridTemplateColumns.split(' ').length !== 3 || r.querySelector('.label').getBoundingClientRect().width < 120).length);
  if (tall) throw new Error(`${tall} of the six checks are laid out wrong`);
  // Over every recorded goal of the room, the checks never sit under the floating chrome.
  const under = await D(() => { const d = window.studioDemo, keep = d.S.selected, hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    const chrome = [...d.root.querySelectorAll('.chrome.top-left, .chrome.top-right')].map(n => n.getBoundingClientRect()); let n = 0;
    for (const c of d.S.recorded) { d.selectCell(c); d.place(); const r = d.el.chip.getBoundingClientRect(); if (chrome.some(x => hit(r, x))) n++; }
    d.selectCell(keep); d.place(); return n; });
  if (under) throw new Error(`the checks sit under the chrome for ${under} goals`);
  await page.screenshot({ path: path.join(OUT, 'desktop-checks.png') });
  return verdict;
});
await check('send a recorded goal, press g, the walk plays, the outcome matches the raw walk', async () => {
  const id = await D(() => { const d = window.studioDemo; const c = d.S.recorded.find(c => c.walk.outcome === 'arrived' && c.walk.path_m > 2); d.selectCell(c); return c.id; });
  await page.click('#demo-stage [data-act="send"]');
  if (!(await D(() => window.studioDemo.S.mode === 'staged'))) throw new Error('not staged after Send');
  await page.keyboard.press('g');
  await page.waitForFunction(() => window.studioDemo.S.mode === 'playing', null, { timeout: 15000 });
  const t0 = await D(() => window.studioDemo.S.t);
  await page.waitForTimeout(2500);
  const t1 = await D(() => window.studioDemo.S.t);
  const splash = await page.locator('#demo-stage .splash b').innerText();
  const ghost = await D(() => window.studioDemo.viewer.ghosts.plan.root.visible);
  await page.screenshot({ path: path.join(OUT, 'desktop-walking.png') });
  if (!(t1 > t0)) throw new Error(`time frozen at ${t0}`);
  if (!ghost) throw new Error('the plan body is not shown during the walk');
  await D(() => { window.studioDemo.S.speed = 4; });
  await page.waitForFunction(() => window.studioDemo.S.mode === 'done', null, { timeout: 120000 });
  await page.screenshot({ path: path.join(OUT, 'desktop-done.png') });
  const world = await D(() => window.studioDemo.S.worldId);
  const raw = await data(`${world}/g/${id}.json`);
  const shown = await page.locator('#demo-result-title').innerText();
  if (shown !== expectedGrade(raw)) throw new Error(`outcome "${shown}" but the raw walk says "${expectedGrade(raw)}"`);
  const arrived = raw.events.find(e => e.type === 'arrived');
  const text = await page.locator('#demo-result-text').innerText();
  if (arrived && !text.includes(`arrived ${arrived.dist.toFixed(2)} m from the goal`)) throw new Error(`arrival sentence does not use ${arrived.dist}: ${text.slice(0, 160)}`);
  return `${world}/${id}: t ${t0.toFixed(1)} → ${t1.toFixed(1)} s, headline "${splash}"; ${shown}`;
});
await check('scrubbing back rebuilds the map; Shift+arrow steps one frame', async () => {
  const before = await D(() => ({ t: window.studioDemo.S.t, step: window.studioDemo.S.mapStep, d: window.studioDemo.S.walk.duration }));
  const bar = await page.locator('#demo-stage [data-el="scrub"]').boundingBox();
  await page.mouse.click(bar.x + bar.width * 0.15, bar.y + bar.height / 2);
  const after = await D(() => ({ t: window.studioDemo.S.t, step: window.studioDemo.S.mapStep }));
  if (!(before.t - after.t > 0.3 * before.d)) throw new Error(`t ${before.t.toFixed(2)} → ${after.t.toFixed(2)} of ${before.d.toFixed(2)}`);
  if (!(after.step < before.step)) throw new Error(`map step ${before.step} → ${after.step}`);
  await D(() => { document.activeElement?.blur(); window.studioDemo.pause(); });
  const k0 = await D(() => window.studioDemo.S.walk.index(window.studioDemo.S.t + 1e-6));
  await page.keyboard.press('Shift+ArrowRight');
  const k1 = await D(() => window.studioDemo.S.walk.index(window.studioDemo.S.t + 1e-6));
  if (k1 !== k0 + 1) throw new Error(`frame ${k0} → ${k1}`);
  return `t ${before.t.toFixed(1)} → ${after.t.toFixed(1)} s, map step ${before.step} → ${after.step}, frame ${k0} → ${k1}`;
});
await check('layer keys toggle the layers and their buttons', async () => {
  const pressed = k => page.evaluate(k2 => document.querySelector(`#demo-stage [data-layer="${k2}"]`).getAttribute('aria-pressed'), k);
  await page.keyboard.press('m'); const m = await pressed('map'); await page.keyboard.press('m');
  await page.keyboard.press('b'); const b = await pressed('body'); const ghost = await D(() => window.studioDemo.viewer.ghosts.plan.root.visible); await page.keyboard.press('b');
  if (m !== 'false' || b !== 'false' || ghost) throw new Error(`map ${m}, body ${b}, ghost ${ghost}`);
  if ((await pressed('map')) !== 'true' || (await pressed('body')) !== 'true') throw new Error('not restored');
  return 'M and B toggle the map and the plan body';
});
await check('Escape puts a staged goal away, R starts over, and Escape during a load wins over the load', async () => {
  const state = () => D(() => ({ m: window.studioDemo.S.mode, sel: !!window.studioDemo.S.selected, walk: !!window.studioDemo.S.walk }));
  await D(() => { const d = window.studioDemo; d.selectCell(d.S.recorded[0], { stage: true }); });
  await page.keyboard.press('Escape');
  const a = await state();
  await D(() => { const d = window.studioDemo; d.selectCell(d.S.recorded[1], { stage: true }); });
  await page.keyboard.press('r');
  const b = await state();
  await D(() => { const d = window.studioDemo; d.selectCell(d.S.recorded[2], { stage: true }); window.__going = d.go(); });
  await page.keyboard.press('Escape');
  await D(() => window.__going);
  const c = await state();
  for (const [name, s] of [['Escape', a], ['R', b], ['Escape while loading', c]]) if (s.m !== 'pick' || s.sel || s.walk) throw new Error(`${name}: ${JSON.stringify(s)}`);
  return 'each returns to picking, with no walk left playing';
});
await check('the picker: rooms with counts, and a Went wrong folder that lists every walk not graded clean', async () => {
  await page.click('#demo-stage [data-el="rooms"]');
  await page.waitForSelector('#demo-stage [data-el="picker"]:not([hidden])');
  const folders = await page.locator('#demo-stage .folders [data-folder]').count();
  await page.click('#demo-stage [data-folder="wrong"]');
  const rows = await page.locator('#demo-stage .walks [data-walk]').count();
  const expected = catalog.reduce((n, w) => n + Object.entries(w.grades).filter(([k]) => k !== 'clean').reduce((a, [, v]) => a + v, 0), 0);
  await page.screenshot({ path: path.join(OUT, 'desktop-picker.png') });
  if (folders !== catalog.length + 1) throw new Error(`${folders} folders for ${catalog.length} rooms`);
  if (rows !== expected) throw new Error(`Went wrong lists ${rows}, the grades say ${expected}`);
  // A walk from another room: the one clicked is staged in its own room (goal ids repeat across rooms), its
  // checks open with Send focused; the operator's steps still apply: Send, then Go.
  const row = page.locator('#demo-stage .walks [data-walk]').nth(1);
  const want = { room: await row.getAttribute('data-room'), walk: await row.getAttribute('data-walk') };
  await row.click();
  await page.waitForFunction(w => window.studioDemo.S.selected?.id === w.walk && window.studioDemo.S.worldId === w.room, want, { timeout: 20000 });
  const focused = await D(() => document.activeElement?.dataset?.act);
  if (focused !== 'send') throw new Error(`after a pick the focus is on ${focused}, not Send`);
  await page.keyboard.press('Enter');
  await page.keyboard.press('g');
  await page.waitForFunction(() => window.studioDemo.S.mode === 'playing', null, { timeout: 20000 });
  const got = await D(() => ({ room: window.studioDemo.S.worldId, walk: window.studioDemo.S.walk.goal_id, outcome: window.studioDemo.S.walk.outcome }));
  if (got.room !== want.room || got.walk !== want.walk) throw new Error(`clicked ${want.room}/${want.walk}, playing ${got.room}/${got.walk}`);
  return `${folders - 1} rooms + Went wrong (${rows} walks); the clicked one plays: ${got.room}/${got.walk}, ${got.outcome}`;
});
await check('every room loads (keys 1–5)', async () => {
  const ids = [];
  for (let k = 1; k <= catalog.length; k++) {
    await page.keyboard.press(String(k));
    await page.waitForFunction(i => window.studioDemo.S.worldId === i, catalog[k - 1].id, { timeout: 20000 });
    ids.push(catalog[k - 1].id);
  }
  return ids.join(', ');
});
await check('the split view: plan body against executed body, in step; scenarios switch', async () => {
  await page.locator('#closer').scrollIntoViewIfNeeded();
  await page.click('#closer-stage [data-closer-start]');
  await page.waitForSelector('#closer-stage.is-ready', { timeout: 60000 });
  const f0 = await page.locator('#closer-stage [data-el="frame"]').innerText();
  await page.waitForTimeout(1500);
  const f1 = await page.locator('#closer-stage [data-el="frame"]').innerText();
  if (f0 === f1) throw new Error(`frame counter stuck at ${f0}`);
  const split = await D(() => !!window.studioCloser.viewer.views && window.studioCloser.viewer.views.length === 2);
  await page.locator('#closer-stage').screenshot({ path: path.join(OUT, 'desktop-closer.png') });
  const left = await D(() => window.studioCloser.ghostOn && window.studioCloser.viewer.ghosts.plan != null);
  const ids = featured.closer.map(c => c.id), last = featured.closer[featured.closer.length - 1];
  await page.click(`#closer-chips [data-sc="${last.id}"]`);
  // The scenario counts as switched once its own walk is loaded and drawn.
  await page.waitForFunction(sc => window.studioCloser.S.scenario.id === sc.id && window.studioCloser.S.walk.goal_id === sc.goal && window.studioCloser.S.world.id === sc.world, last, { timeout: 20000 });
  if (!split || !left) throw new Error(`split ${split}, plan body shown ${left}`);
  return `${f0} → ${f1}; ${ids.length} scenarios (${ids.join(', ')}); switched to ${last.world}/${last.goal}`;
});
await check('the system diagram answers a click', async () => {
  await page.locator('#how').scrollIntoViewIfNeeded();
  await page.waitForSelector('#pipeline svg .node', { timeout: 10000 });
  await page.click('#pipeline .node[data-id="node"]');
  const title = await page.locator('#pipeline-detail h3').innerText();
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
  const focus = await D(() => document.activeElement?.id || document.activeElement?.tagName);
  await page.screenshot({ path: path.join(OUT, 'desktop-robot-day.png') });
  const playing = await D(() => document.getElementById('day-canvas').getAttribute('aria-label'));
  if (!/walking/.test(playing)) throw new Error(`no walk: ${playing}`);
  if (focus === 'BODY') throw new Error('focus dropped to the page');
  return `blocked with leg odometry; walked with the suggested goal; focus on ${focus}`;
});
await check('findings: numbers from the same walks as the rooms, stills, and the outcome table', async () => {
  await page.locator('#findings').scrollIntoViewIfNeeded();
  await page.waitForSelector('#findings-cards .finding', { timeout: 10000 });
  const n = await page.locator('#findings-cards .finding').count();
  if (featured.facts.walks !== totalWalks) throw new Error(`findings count ${featured.facts.walks} walks, the rooms ${totalWalks}`);
  for (const w of catalog) if (featured.facts.contact?.[w.id] && featured.facts.contact[w.id].walks !== w.walks) throw new Error(`${w.id}: ${featured.facts.contact[w.id].walks} vs ${w.walks}`);
  const total = await page.locator('#outcome-table tfoot td').last().innerText();
  if (Number(total) !== totalWalks) throw new Error(`table total ${total}, walks ${totalWalks}`);
  await page.waitForTimeout(800);
  const stills = await D(() => [...document.querySelectorAll('#findings-cards .shot img')].map(i => i.complete && i.naturalWidth > 0));
  if (stills.some(ok => !ok)) throw new Error(`${stills.filter(ok => !ok).length} stills did not load`);
  await page.screenshot({ path: path.join(OUT, 'desktop-findings.png') });
  return `${n} findings, ${stills.length} stills, table total ${total}`;
});
await check('the page idles: no animation runs while its part is off screen', async () => {
  const fresh = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await fresh.goto(URL_);
  await fresh.waitForSelector('#pipeline .node', { state: 'attached', timeout: 15000 });
  await fresh.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; document.getElementById('findings').scrollIntoView(); });
  await fresh.waitForTimeout(1500);
  const running = await fresh.evaluate(() => document.getAnimations().filter(a => a.playState === 'running').length);
  const frames = await fresh.evaluate(() => new Promise(r => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
  await fresh.context().close();
  if (running) throw new Error(`${running} animations running off screen`);
  return `0 animations running with the diagram off screen (rAF probe ${frames}/s, the probe's own)`;
});
await check('every section is built once the page is idle (Tab reaches them)', async () => {
  const fresh = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await fresh.goto(URL_);
  for (const sel of ['#pipeline .node', '#day-steps button', '#findings-cards .finding', '#closer-chips [data-sc]', '#chapters button', '#atlas-chart svg .dot'])
    await fresh.waitForSelector(sel, { state: 'attached', timeout: 15000 });
  await fresh.context().close();
  return 'diagram, robot day, findings, scenarios and chapters built without scrolling';
});

await check('every walk, one dot: the chart plays the walk it names, and its counts open the demo', async () => {
  const { page: a } = await open({ width: 1440, height: 900 }, 'atlas');
  await a.evaluate(() => { document.documentElement.style.scrollBehavior = 'auto'; document.getElementById('atlas').scrollIntoView(); });
  await a.waitForSelector('#atlas-chart svg .dot', { timeout: 15000 });
  const dots = await a.locator('#atlas-chart svg .dot').count();
  if (dots !== totalWalks) throw new Error(`${dots} dots for ${totalWalks} walks`);
  await a.click('#atlas-chart [data-metric="contact"]');
  await a.focus('#atlas-chart svg'); await a.keyboard.press('End');
  const named = await a.evaluate(() => document.querySelector('#atlas-chart .atlas-read a.watch').getAttribute('href'));
  await a.keyboard.press('Enter');
  await a.waitForFunction(() => window.studioDemo?.S.mode === 'playing', null, { timeout: 60000 });
  const playing = await a.evaluate(() => `#try/${window.studioDemo.S.worldId}/${window.studioDemo.S.walk.goal_id}/play`);
  if (playing !== named) throw new Error(`the chart named ${named}, the demo plays ${playing}`);
  // From the result, the same walk in the split view.
  await a.evaluate(() => { const d = window.studioDemo; d.seek(d.S.walk.duration); });
  await a.click('#demo-stage [data-act="compare"]');
  await a.waitForFunction(w => window.studioCloser?.S.scenario?.id === 'walk' && `#try/${window.studioCloser.S.world.id}/${window.studioCloser.S.walk.goal_id}/play` === w, playing, { timeout: 60000 });
  // Stop: the posters come back and no WebGL canvas is left.
  await a.click('#closer-stage [data-el="stop"]');
  await a.evaluate(() => document.querySelector('#demo-stage [data-el="stop"]').click());
  const left = await a.evaluate(() => ({ canvases: document.querySelectorAll('#demo-stage canvas, #closer-stage canvas').length, posters: [...document.querySelectorAll('#demo-stage .poster, #closer-stage .poster')].filter(p => !p.hidden).length }));
  if (left.canvases || left.posters !== 2) throw new Error(`after Stop: ${JSON.stringify(left)}`);
  // A count in the outcome table opens the room menu on exactly those walks.
  await a.evaluate(() => document.getElementById('findings').scrollIntoView());
  await a.waitForSelector('#outcome-table tfoot button.cell');
  const cell = a.locator('#outcome-table tfoot button.cell').first();
  const want = Number(await cell.innerText());
  await cell.click();
  await a.waitForFunction(() => window.studioDemo && !window.studioDemo.el.picker.hidden, null, { timeout: 60000 });
  const rows = await a.locator('#demo-stage .walks [data-walk]').count();
  await a.context().close();
  if (rows !== want) throw new Error(`the table says ${want}, the room menu lists ${rows}`);
  return `${dots} dots; Enter played ${playing}; Plan vs body opened it; Stop left ${left.canvases} canvases; a count of ${want} opened ${rows} walks`;
});
await check('next step: Studio-measured numbers only, the split view starts', async () => {
  const { page: next } = await open({ width: 1440, height: 900 }, 'next', 'next/');
  await next.waitForSelector('#numbers-cards .hl', { timeout: 15000 });
  const text = await next.locator('main').innerText();
  // The public build carries no unpublished research material (docs/SITE.md): an empty next-local.json, no local
  // section, and none of the local file's markers when they are given (NEXT_LOCAL_MARKERS, from the local file).
  const localFile = await data('next-local.json');
  const local = await next.evaluate(() => !document.getElementById('local').hidden);
  const markers = (process.env.NEXT_LOCAL_MARKERS ?? '').split(',').map(m => m.trim()).filter(m => m && text.includes(m));
  if (Object.keys(localFile).length || local || markers.length) throw new Error(`local material on the public page: ${Object.keys(localFile).length ? 'next-local.json is not empty; ' : ''}${local ? 'local section shown; ' : ''}${markers.length} markers found`);
  const cards = await next.locator('#numbers-cards .hl').count(), rows = await next.locator('#tracker-table tbody tr').count();
  await next.click('#closer-stage [data-closer-start]');
  await next.waitForSelector('#closer-stage.is-ready', { timeout: 60000 });
  const mode = await next.evaluate(() => window.studioCloser.S.scenario.mode);
  await next.screenshot({ path: path.join(OUT, 'next-top.png') });
  await next.context().close();
  if (cards !== 3 || !rows || mode !== 'body') throw new Error(`${cards} numbers, ${rows} tracker rows, mode ${mode}`);
  return `${cards} numbers, ${rows} scenarios in the tracker table, split view in plan-body mode`;
});
await check('the standalone demo opens a walk by link and plays from the given moment', async () => {
  const ex = featured.examples.drift ?? Object.values(featured.examples)[0];
  const at = Math.max(0, (ex.at ?? 0) - 2);
  const { page: demo } = await open({ width: 1280, height: 800 }, 'standalone', `demo/#${ex.world}/${ex.goal}/play@${at.toFixed(1)}`);
  await demo.waitForFunction(() => window.studioDemo?.S.walk, null, { timeout: 60000 });
  const s = await demo.evaluate(() => ({ t: window.studioDemo.S.t, goal: window.studioDemo.S.walk.goal_id, world: window.studioDemo.S.worldId, full: getComputedStyle(document.getElementById('demo')).position }));
  await demo.waitForTimeout(1500);
  const later = await demo.evaluate(() => window.studioDemo.S.t);
  await demo.screenshot({ path: path.join(OUT, 'standalone.png') });
  // A malformed moment opens the walk from its start, never at a time that is not a number.
  await demo.goto(URL_ + `demo/#${ex.world}/${ex.goal}/play@1.2.3`);
  await demo.waitForTimeout(800);
  const bad = await demo.evaluate(() => window.studioDemo?.S.t ?? 0);
  await demo.context().close();
  if (s.goal !== ex.goal || s.world !== ex.world || !Number.isFinite(s.t) || s.t < at - 0.05 || s.full !== 'fixed') throw new Error(JSON.stringify(s));
  if (!(later > s.t)) throw new Error(`not playing: ${s.t} → ${later}`);
  if (!Number.isFinite(bad)) throw new Error(`a malformed link gave t = ${bad}`);
  return `${s.world}/${s.goal} from ${at.toFixed(1)} s, playing (${later.toFixed(1)} s), full-bleed; a malformed link is ignored`;
});

await check('phone: the demo fits, a tap picks a goal, its checks sit above the dock', async () => {
  const { page: phone } = await open({ width: 390, height: 844 }, 'phone', 'demo/');
  await phone.waitForSelector('.stage.is-ready', { timeout: 60000 });
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const box = await phone.locator('.stage-canvas canvas').boundingBox();
  await phone.touchscreen.tap(box.x + box.width * 0.6, box.y + box.height * 0.45);
  await phone.waitForSelector('[data-el="chip"]:not([hidden])', { timeout: 5000 });
  const r = await phone.evaluate(() => { const c = document.querySelector('[data-el="chip"]').getBoundingClientRect(), d = document.querySelector('[data-el="dock"]').getBoundingClientRect(); return { chip: c.bottom, dock: d.top, left: c.left, right: c.right }; });
  await phone.screenshot({ path: path.join(OUT, 'phone-demo.png') });
  await phone.context().close();
  if (wide > 1) throw new Error(`page scrolls sideways by ${wide}px`);
  if (r.chip > r.dock + 1 || r.left < 0 || r.right > 390) throw new Error(`checks overlap the dock or the edge: ${JSON.stringify(r)}`);
  return `canvas ${Math.round(box.width)}×${Math.round(box.height)}; checks end at ${Math.round(r.chip)} px, dock starts at ${Math.round(r.dock)} px`;
});
await check('phone: the main page has no sideways scroll and its embedded demo lets the page scroll', async () => {
  const { page: phone } = await open({ width: 390, height: 844 }, 'phone-main');
  await phone.waitForLoadState('load');
  await phone.click('#try .poster .start');
  await phone.waitForSelector('#demo-stage.is-ready', { timeout: 60000 });
  await phone.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
  await phone.waitForTimeout(1500);
  const wide = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  const touch = await phone.evaluate(() => document.querySelector('#demo-stage canvas').style.touchAction);
  await phone.evaluate(() => document.getElementById('try').scrollIntoView());
  await phone.screenshot({ path: path.join(OUT, 'phone-main.png') });
  await phone.context().close();
  if (wide > 1) throw new Error(`page scrolls sideways by ${wide}px`);
  if (touch !== 'pan-y') throw new Error(`embedded canvas touch-action is ${touch}: a vertical swipe would not scroll the page`);
  return 'no sideways scroll; embedded canvas pans the page vertically';
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
