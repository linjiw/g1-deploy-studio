#!/usr/bin/env node
// Failure recovery, cancellation, keyboard focus and narrow-screen regressions using real site recordings.
// SITE_URL=http://127.0.0.1:8811 SITE_EVIDENCE=/absolute/evidence node tools/site/ux_edges.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = (process.env.SITE_URL || 'http://127.0.0.1:8811/').replace(/\/?$/, '/');
const output = process.env.SITE_EVIDENCE || '/tmp/g1-site-ux-edges';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results = [];
async function check(name, run, viewport = { width: 1280, height: 800 }) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  try {
    await run(page); assert.deepEqual(errors, [], 'unexpected page errors');
    results.push({ name, ok: true }); console.log(`PASS ${name}`);
  } catch (error) {
    results.push({ name, ok: false, error: error.message, pageErrors: errors }); console.error(`FAIL ${name}: ${error.message}`);
    await page.screenshot({ path: path.join(output, `${results.length}-failure.png`) }).catch(() => {});
  } finally { await context.close(); }
}
const ready = p => p.waitForFunction(() => !!window.studioDemo?.S.world, null, { timeout: 45000 });

await check('Initial room failure releases the partial viewer; retry loads the real room', async p => {
  let fail = true;
  await p.route('**/data/*/index.json', route => fail ? (fail = false, route.fulfill({ status: 503, body: 'temporarily unavailable' })) : route.continue());
  await p.goto(`${base}demo/`);
  await p.locator('.boot.failed').waitFor();
  assert.equal(await p.locator('.stage canvas').count(), 0);
  assert.equal(await p.locator('.stage').getAttribute('aria-busy'), 'false');
  await p.screenshot({ path: path.join(output, 'desktop-retry.png') });
  await p.getByRole('button', { name: 'Try again', exact: true }).click(); await ready(p);
  assert.ok(await p.evaluate(() => window.studioDemo.S.recorded.length > 0));
  assert.equal(await p.locator('.stage canvas').count(), 1);
});
await check('Cancel while the robot loads restores the preview and ignores late completion', async p => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let requested = false, requestStarted;
  const started = new Promise(resolve => { requestStarted = resolve; });
  await p.route('**/data/meshes.bin', async route => { requested = true; requestStarted(); await held; await route.continue(); });
  await p.goto(base); await p.locator('#try .start').click();
  await p.locator('#demo-stage canvas').waitFor({ state: 'attached' });
  await started;
  await p.getByRole('button', { name: 'Cancel loading' }).click();
  assert.ok(await p.locator('#demo-stage .poster').isVisible());
  assert.equal(await p.locator('#demo-stage canvas').count(), 0);
  release(); await p.waitForTimeout(500);
  assert.equal(await p.locator('#demo-stage canvas').count(), 0);
  assert.equal(await p.evaluate(() => window.studioDemo), null);
  await p.locator('#try .start').click(); await ready(p);
  assert.equal(await p.locator('#demo-stage canvas').count(), 1);
  assert.ok(requested);
});
await check('A rejected walk after New goal cannot resurrect the cancelled goal', async p => {
  await p.goto(`${base}demo/`); await ready(p);
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await p.route('**/data/*/g/*.json', async route => { await held; await route.fulfill({ status: 503, body: 'temporary outage' }); });
  await p.evaluate(() => { const d = window.studioDemo; d.selectCell(d.S.recorded[0], { stage: true }); window.pendingWalk = d.go(); });
  await p.getByRole('button', { name: 'New goal', exact: true }).click(); release();
  await p.evaluate(() => window.pendingWalk);
  assert.deepEqual(await p.evaluate(() => ({ mode: window.studioDemo.S.mode, goal: window.studioDemo.S.selected })), { mode: 'pick', goal: null });
  assert.ok(await p.locator('[data-el="go"]').isDisabled());
});
await check('Room and filter changes preserve keyboard focus', async p => {
  await p.goto(`${base}demo/`); await ready(p);
  await p.locator('[data-el="rooms"]').click();
  const folder = p.locator('[data-folder]').nth(1), id = await folder.getAttribute('data-folder');
  await folder.click();
  assert.equal(await p.evaluate(() => document.activeElement.dataset.folder), id);
  await p.locator('[data-filter="clean"]').click();
  assert.equal(await p.evaluate(() => document.activeElement.dataset.filter), 'clean');
  await p.keyboard.press('Escape');
  assert.equal(await p.evaluate(() => document.activeElement.dataset.el), 'rooms');
});
await check('Failed comparison keeps the last scenario and can retry without reloading', async p => {
  await p.goto(base);
  await p.locator('#closer').scrollIntoViewIfNeeded();
  await p.locator('#closer-stage [data-closer-start]').click();
  await p.waitForFunction(() => !!window.studioCloser?.S.walk, null, { timeout: 45000 });
  const before = await p.evaluate(() => window.studioCloser.S.scenario.id);
  let fail = true;
  await p.route('**/data/*/g/*.json', route => fail ? (fail = false, route.fulfill({ status: 503, body: 'temporary outage' })) : route.continue());
  const chip = p.locator('#closer-chips [data-sc]').last(), wanted = await chip.getAttribute('data-sc');
  await chip.click();
  await p.getByText('This comparison could not load.', { exact: false }).waitFor();
  assert.equal(await p.evaluate(() => window.studioCloser.S.scenario.id), before);
  assert.equal(await p.locator('#closer-chips [aria-pressed="true"]').getAttribute('data-sc'), before);
  await p.locator('.section-status').getByRole('button', { name: 'Try again' }).click();
  await p.waitForFunction(id => window.studioCloser.S.scenario.id === id, wanted);
  assert.equal(await p.locator('#closer-stage').getAttribute('aria-busy'), 'false');
});
await check('Chart filters clear the previous room’s selected walk', async p => {
  await p.goto(base); await p.locator('#atlas').scrollIntoViewIfNeeded();
  await p.locator('#atlas-chart svg').focus(); await p.keyboard.press('ArrowRight');
  assert.equal(await p.locator('.atlas-read .watch').count(), 1);
  await p.locator('#atlas-chart button[data-room]').last().click();
  assert.equal(await p.locator('.atlas-read .watch').count(), 0);
});
await check('WebGL fallback links to the tour and keeps retry available', async p => {
  await p.addInitScript(() => {
    const get = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(kind, ...args) { return /^webgl/.test(kind) ? null : get.call(this, kind, ...args); };
  });
  await p.goto(`${base}demo/`); await p.locator('.boot.failed').waitFor();
  assert.equal(await p.locator('.boot a').evaluate(a => new URL(a.href).pathname), new URL(base).pathname);
  assert.equal(await p.locator('.boot a').evaluate(a => new URL(a.href).hash), '#tour');
  assert.ok(await p.getByRole('button', { name: 'Try again', exact: true }).isVisible());
  assert.equal(await p.locator('.is-ready').count(), 0);
});
await check('Empty recordings show an unavailable state without a healthy scene', async p => {
  await p.route('**/data/worlds.json', route => route.fulfill({ contentType: 'application/json', body: '{"worlds":[]}' }));
  await p.goto(`${base}demo/`); await p.locator('.boot.failed').waitFor();
  assert.match(await p.locator('.boot').innerText(), /No recorded rooms/);
  assert.equal(await p.locator('.is-ready').count(), 0);
  assert.equal(await p.locator('.stage canvas').count(), 0);
});
await check('320 px phone keeps the dock, goal actions and room menu reachable', async p => {
  await p.goto(`${base}demo/`); await ready(p);
  assert.ok(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  const tapTargets = await p.locator('.dock button').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length).map(n => ({ h: n.getBoundingClientRect().height, name: n.textContent })));
  assert.ok(tapTargets.every(x => x.h >= 44), JSON.stringify(tapTargets));
  await p.evaluate(() => { const d = window.studioDemo; d.selectCell(d.S.recorded[0]); });
  await p.locator('[data-act="more"]').click();
  const send = p.locator('[data-act="send"]'); await send.click();
  assert.ok(await p.locator('[data-el="go"]').isEnabled());
  await p.screenshot({ path: path.join(output, 'phone-320-goal.png') });
  await p.locator('[data-el="rooms"]').click();
  const bounds = await p.locator('[data-el="picker"]').boundingBox();
  assert.ok(bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= 320 && bounds.y + bounds.height <= 568, JSON.stringify(bounds));
  await p.screenshot({ path: path.join(output, 'phone-320-picker.png') });
}, { width: 320, height: 568 });

await browser.close();
await writeFile(path.join(output, 'ux-edges.json'), JSON.stringify({ results }, null, 2));
console.log(`${results.filter(r => r.ok).length}/${results.length} passed`);
process.exitCode = results.some(r => !r.ok) ? 1 : 0;
