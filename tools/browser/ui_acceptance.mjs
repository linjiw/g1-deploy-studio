// Read-only browser acceptance for the replay cockpit (no worker is launched).
//   STUDIO_URL=http://127.0.0.1:8790 node tools/browser/ui_acceptance.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/browser-v2');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
const errors = [], failed = [], checks = [], bytes = { session: 0, sensors: 0, mesh: 0, meshRequests: 0 };
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', async r => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`);
  const url = r.url(), size = Number((await r.allHeaders().catch(() => ({})))['content-length'] ?? 0);
  if (url.includes('/api/session?')) bytes.session += size;
  if (url.includes('/api/sensors?')) bytes.sensors += size;
  if (url.includes('/assets/mesh/') && !r.fromServiceWorker()) { bytes.meshRequests++; bytes.mesh += size; }
});
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log('✓', name); };
const shot = name => page.screenshot({ path: path.join(evidence, `${name}.png`) });

async function ready(id) {
  await page.waitForFunction(id => window.__studio?.state?.session?.metadata.catalog_id === id && (id === 'wire-local' || !!window.__studio.robot)
    && document.querySelector('#loading-overlay').hidden, id, { timeout: 90000 });
  assert.equal(await page.locator('#error-banner').isVisible(), false, await page.locator('#error-banner').textContent());
}
async function open(id) {
  if (await page.evaluate(() => !!window.__studio)) await page.selectOption('#session-picker', id); else await page.goto(`${base}/?session=${id}`);
  await ready(id);
}
const seek = t => page.evaluate(t => window.__studio.seek(t), t);
async function parity(id, time) {
  await seek(time);
  const frame = await page.evaluate(() => window.__studio.state.frameIndex);
  const oracle = await (await page.request.get(`${base}/api/kinematics?id=${id}&frame=${frame}`)).json();
  const actual = await page.evaluate(() => {
    const root = window.__studio.robot.root, out = {};
    root.updateMatrixWorld(true);
    root.traverse(n => { if (n.userData.joint || n === root) out[n.name] = Array.from(n.matrixWorld.elements); });
    return out;
  });
  let pos = 0, rot = 0, bodies = 0;
  for (const [name, m] of Object.entries(actual)) {
    const t = oracle[name]; if (!t) continue; bodies++;
    for (let i = 0; i < 3; i++) pos = Math.max(pos, Math.abs(m[12 + i] - t.position[i]));
    const [w, x, y, z] = t.quaternion_wxyz;
    const r = [[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)], [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)], [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) rot = Math.max(rot, Math.abs(m[j * 4 + i] - r[i][j]));
  }
  assert.ok(bodies > 20, `bodies compared ${bodies}`);
  assert.ok(pos < 1e-6 && rot < 1e-6, `FK error pos ${pos} rot ${rot}`);
  check(`browser FK matches MuJoCo (${id})`, { frame, bodies, pos, rot });
}

try {
  await page.goto(`${base}/?session=sonic-lockstep`);
  await ready('sonic-lockstep');
  assert.equal(await page.evaluate(() => window.__studio.model.nq), 36);
  await parity('sonic-lockstep', 1.2);
  // Transport visible without scrolling (review UX-1).
  const play = await page.locator('#play').boundingBox();
  assert.ok(play.y + play.height <= 1000, `play button at ${play.y}`);
  check('transport docked in view', { playTop: play.y });
  // Render-on-demand while paused (review P-6).
  const d0 = await page.evaluate(() => window.__studio.sceneDrawCount); await page.waitForTimeout(1200);
  const d1 = await page.evaluate(() => window.__studio.sceneDrawCount);
  assert.ok(d1 - d0 <= 3, `idle frames rendered ${d1 - d0}`);
  check('paused scene renders on demand only', { idleDraws: d1 - d0 });
  // Playback, speed, keyboard stepping.
  await seek(0.2); await page.selectOption('#speed', '0.5'); await page.click('#play'); await page.waitForTimeout(700); await page.click('#play');
  const paused = await page.evaluate(() => window.__studio.state.time);
  assert.ok(paused > 0.25 && paused < 1.5, `playback advanced to ${paused}`);
  await page.locator('body').click({ position: { x: 5, y: 990 } });
  await page.keyboard.press('ArrowRight');
  const stepped = await page.evaluate(() => window.__studio.state.time);
  assert.ok(Math.abs(stepped - paused - 0.02) < 0.002, `step ${stepped - paused}`);
  await page.keyboard.press('Shift+ArrowLeft');
  assert.ok(Math.abs(await page.evaluate(() => window.__studio.state.time) - Math.max(0, stepped - 1)) < 0.002);
  check('play / pause / speed / tick stepping', { paused, stepped });
  // Layers + cameras.
  await page.click('#layers-button');
  await page.uncheck('#layer-robot');
  assert.equal(await page.evaluate(() => window.__studio.robot.root.visible), false);
  await page.check('#layer-robot');
  for (const name of ['reference', 'future', 'trajectory', 'environment', 'frames']) { await page.uncheck(`#layer-${name}`); await page.check(`#layer-${name}`); }
  await page.click('#layers-button');
  for (const cam of ['top', 'follow', 'orbit', 'scene']) { await page.click(`#camera-${cam}`); assert.equal(await page.locator(`#camera-${cam}`).getAttribute('aria-pressed'), 'true'); }
  await page.click('#robot-view'); assert.equal(await page.locator('#robot-view-label').isVisible(), true); await page.waitForTimeout(400); await shot('lockstep-robot-view'); await page.click('#robot-view');
  check('layers, cameras and robot-view inset');
  // Named joints update in place and match the source frame.
  await page.click('#tab-joints');
  assert.equal(await page.locator('.joint-table tr[data-joint]').count(), 29);
  const value = await page.locator('.joint-table tr[data-joint="3"] [data-c=s]').textContent();
  assert.equal(value, (await page.evaluate(() => window.__studio.state.frame.joints[3])).toFixed(3));
  check('named joint table matches the sampled source value');
  // Stale-state diagnostic never shows a healthy zero.
  await page.click('#tab-health'); await seek(0.3); await page.check('#freeze-state'); await seek(0.9);
  assert.match(await page.locator('#health-content').textContent(), /STALE/);
  assert.match(await page.locator('#source-badge').textContent(), /HELD/);
  await shot('lockstep-held-state'); await page.uncheck('#freeze-state');
  check('held-state injection is labelled stale');

  await open('sonic-dds-tutorial');
  assert.equal(await page.evaluate(() => window.__studio.model.nq), 50);
  assert.equal(await page.locator('#layer-reference').isDisabled(), true);
  await parity('sonic-dds-tutorial', 25);
  await page.click('#tab-perception');
  await page.click('#layers-button'); await page.check('#layer-perception'); await page.click('#layers-button');
  assert.match(await page.locator('#reference-caption').textContent(), /final accumulated snapshot/i);
  assert.match(await page.locator('#perception-content').textContent(), /without capture time/i);
  await page.click('#tab-graph');
  assert.match(await page.locator('#graph-content').textContent(), /configured/i);
  await page.click('#tab-source'); assert.match(await page.locator('#source-content').textContent(), /SHA-256/);
  await shot('dds-final-map');
  check('C++/DDS recording: Dex3 mapping, unsynchronized final map, configured graph');

  await open('wire-local');
  assert.equal(await page.evaluate(() => window.__studio.robot), null);
  assert.equal(await page.locator('#scene-unavailable').isVisible(), true);
  await page.click('#tab-graph');
  for (const status of ['fresh', 'stale', 'disconnected']) {
    const t = await page.evaluate(s => window.__studio.state.session.frames.find(f => f.health.stream_status === s)?.time, status);
    assert.equal(typeof t, 'number', `${status} sample exists`);
    await seek(t + 0.001);
    assert.match((await page.locator('#graph-content').textContent()).toLowerCase(), new RegExp(status));
  }
  await shot('wire-disconnect');
  check('captured ZMQ edge replays fresh / stale / disconnected; pose stays unavailable');

  // A fresh owned rehearsal recording, if present: outcome chip + lanes + system map.
  const job = await page.evaluate(() => window.__studio.state.sessions?.find(s => s.group === 'CPU rehearsals' && s.outcome)?.id);
  if (job) {
    const before = bytes.meshRequests;
    await open(job);
    await page.click('#tab-health');
    assert.match(await page.locator('#run-outcome').textContent(), /\w/);
    assert.match(await page.locator('#health-content').textContent(), /Timing vs budget/i);
    await shot('rehearsal-health');
    check('owned rehearsal shows the whole-run outcome and budgets', { job, meshRequestsOnSwitch: bytes.meshRequests - before });
    // View link round trip (time, panel, camera, workspace-free).
    await seek(1.234); await page.click('#camera-follow'); await page.click('#copy-view');
    const link = page.url(); await page.goto(link); await ready(job);
    assert.ok(Math.abs(await page.evaluate(() => window.__studio.state.time) - 1.234) < 0.002);
    assert.equal(await page.locator('#tab-health').getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => window.__studio.camera), 'follow');
    check('view link restores time, panel and camera', { link });
  }
  await page.click('#workspace-system'); await page.waitForSelector('.contract-table'); await page.waitForTimeout(500);
  assert.ok(await page.locator('.sys-node').count() >= 9);
  assert.ok(await page.locator('.discrepancy').count() > 0);
  await shot('system');
  check('system map and source-verified Unitree contract render');

  await page.setViewportSize({ width: 390, height: 844 }); await page.click('#workspace-replay'); await page.waitForTimeout(400);
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'no horizontal page scroll at 390 px');
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
  check('390 px layout without horizontal overflow');

  const safety = await (await page.request.get(`${base}/api/safety`)).json();
  assert.equal(safety.hardware_enabled, false); assert.equal(safety.dds_participants, 0); assert.deepEqual(safety.publishers, []);
  await page.close();
  assert.equal((await context.request.get(`${base}/api/safety`)).status(), 200);
  check('browser disconnect leaves the gateway serving; no hardware command path', { bytes });
  assert.deepEqual(failed, [], 'no failed HTTP resources');
  assert.deepEqual(errors, [], 'no browser exceptions');
  await writeFile(path.join(evidence, 'ui-acceptance.json'), JSON.stringify({ base, checks, bytes, errors, failed }, null, 1));
  console.log(JSON.stringify({ passed: checks.length, evidence, bytes }, null, 1));
} catch (error) {
  await writeFile(path.join(evidence, 'ui-failure.json'), JSON.stringify({ message: error.message, checks, errors, failed }, null, 1));
  if (!page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png') });
  throw error;
} finally {
  await browser.close();
}
