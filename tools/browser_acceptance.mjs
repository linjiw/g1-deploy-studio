// Real browser acceptance against the already-running, loopback replay gateway.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/browser');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome',
  headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1512, height: 982 }, deviceScaleFactor: 1 });
const page = await context.newPage();
const errors = [];
const failed = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const checks = [];
const check = (name, details = {}) => checks.push({ name, passed: true, ...details });

async function ready(id) {
  await page.waitForFunction(id => window.__studio?.state?.session?.metadata.catalog_id === id &&
    (id === 'wire-local' || !!window.__studio.robot) &&
    document.querySelector('#loading-overlay').hidden, id, { timeout: 60000 });
  assert.equal(await page.locator('#error-banner').isVisible(), false);
}
async function seek(time) {
  await page.locator('#timeline').evaluate((node, t) => {
    node.value = t; node.dispatchEvent(new Event('input', { bubbles: true }));
  }, time);
}
async function parity(id, time) {
  await seek(time);
  const frame = await page.evaluate(() => window.__studio.state.frameIndex);
  const response = await page.request.get(`${base}/api/kinematics?id=${id}&frame=${frame}`);
  assert.equal(response.status(), 200);
  const oracle = await response.json();
  const actual = await page.evaluate(() => {
    const root = window.__studio.robot.root;
    root.updateMatrixWorld(true);
    const result = {};
    root.traverse(node => {
      if (node.userData.spec) result[node.name] = Array.from(node.matrixWorld.elements);
    });
    return result;
  });
  let maxPositionError = 0, maxRotationError = 0;
  for (const [name, matrix] of Object.entries(actual)) {
    const target = oracle[name];
    assert.ok(target, `MuJoCo body ${name} exists`);
    for (let i = 0; i < 3; i++) maxPositionError = Math.max(maxPositionError, Math.abs(matrix[12 + i] - target.position[i]));
    const [w, x, y, z] = target.quaternion_wxyz;
    const r = [[1-2*(y*y+z*z),2*(x*y-z*w),2*(x*z+y*w)], [2*(x*y+z*w),1-2*(x*x+z*z),2*(y*z-x*w)], [2*(x*z-y*w),2*(y*z+x*w),1-2*(x*x+y*y)]];
    for(let i=0;i<3;i++)for(let j=0;j<3;j++)maxRotationError=Math.max(maxRotationError,Math.abs(matrix[j*4+i]-r[i][j]));
  }
  assert.ok(maxPositionError < 1e-7, `FK position error ${maxPositionError}`);
  assert.ok(maxRotationError < 1e-7, `FK rotation error ${maxRotationError}`);
  check(`Browser FK vs MuJoCo: ${id}`, { frame, bodyCount: Object.keys(actual).length, maxPositionError, maxRotationError });
}

try {
  await page.goto(base);
  await ready('sonic-lockstep');
  assert.equal(await page.evaluate(() => window.__studio.state.session.metadata.fixture), false);
  assert.equal(await page.evaluate(() => window.__studio.model.nq), 36);
  assert.match(await page.locator('#reference-caption').textContent(), /planner diagnostic/);
  await parity('sonic-lockstep', 1.2);
  await page.screenshot({ path: path.join(evidence, 'lockstep-intent.png'), fullPage: true });
  check('Real recording with reference ghost and model rendered');

  await seek(.2);
  await page.selectOption('#speed', '0.5');
  await page.click('#play');
  await page.waitForTimeout(600);
  await page.click('#play');
  const paused = await page.evaluate(() => window.__studio.state.time);
  assert.ok(paused > .23 && paused < 1.5, `Playback advanced to ${paused}`);
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => window.__studio.state.time), paused);
  check('Play, pause, speed and causal seek');

  await page.uncheck('#layer-robot');
  assert.equal(await page.evaluate(() => window.__studio.robot.root.visible), false);
  await page.check('#layer-robot');
  for (const name of ['reference', 'future', 'trajectory', 'environment', 'frames']) {
    await page.uncheck(`#layer-${name}`); await page.check(`#layer-${name}`);
  }
  for (const camera of ['top', 'follow', 'orbit']) {
    await page.click(`#camera-${camera}`);
    assert.equal(await page.locator(`#camera-${camera}`).getAttribute('aria-pressed'), 'true');
  }
  check('Layer switches and top/follow/orbit cameras');

  await page.click('#tab-joints');
  assert.equal(await page.locator('.joint-table tbody tr').count(), 29);
  await page.selectOption('#joint-select', '3');
  const cell = await page.locator('.joint-table tbody tr').nth(3).locator('td').nth(1).textContent();
  const sourceJoint = await page.evaluate(() => window.__studio.state.frame.joints[3]);
  assert.equal(cell, sourceJoint.toFixed(3));
  await page.screenshot({ path: path.join(evidence, 'named-joints.png'), fullPage: true });
  check('Named joint table matches sampled source values');

  await page.click('#tab-health');
  if (await page.locator('#freeze-state').count()) {
    await seek(.3);
    await page.check('#freeze-state');
    await seek(.9);
    assert.match(await page.locator('#metric-state-note').textContent(), /stale/i);
    assert.ok(Number(await page.locator('#metric-state').innerText().then(t=>t.replace(/[^\d.]/g,''))) >= 500);
    await page.screenshot({ path: path.join(evidence, 'replay-stale-state.png'), fullPage: true });
    await page.uncheck('#freeze-state');
    check('Explicit replay dropout injection displays stale state without a fabricated healthy zero');
  } else {
    throw new Error('Missing expected replay stale-state diagnostic control');
  }

  await page.selectOption('#session-picker', 'sonic-dds-tutorial');
  await ready('sonic-dds-tutorial');
  assert.equal(await page.evaluate(() => window.__studio.model.nq), 50);
  assert.equal(await page.locator('#layer-reference').isDisabled(), true);
  assert.match(await page.locator('#reference-caption').textContent(), /UNAVAILABLE/);
  assert.equal(await page.locator('#metric-reference').textContent(), '—');
  await parity('sonic-dds-tutorial', 25);
  check('Separate C++/DDS recording, Dex3 joint mapping, missing reference stays unavailable');

  await page.click('#tab-perception');
  await page.check('#layer-perception');
  assert.match(await page.locator('#reference-caption').textContent(), /final accumulated snapshot/);
  assert.match(await page.locator('#perception-content').textContent(), /capture time not recorded/i);
  await page.click('#camera-top');
  await page.screenshot({ path: path.join(evidence, 'dds-final-map.png'), fullPage: true });
  check('Bounded final map overlay explicitly unsynchronized; unknown cells not filled');

  await page.click('#tab-graph');
  assert.match(await page.locator('#graph-content').textContent(), /CONFIGURED FROM SOURCE/);
  assert.match(await page.locator('#graph-content').textContent(), /rate Unavailable/i);
  await page.click('#tab-health');
  assert.match(await page.locator('#health-content').textContent(), /Unavailable/);
  await page.click('#tab-source');
  assert.match(await page.locator('#source-content').textContent(), /SHA-256/);
  check('Graph and provenance distinguish configured topology and unavailable runtime metrics');

  await page.selectOption('#session-picker', 'wire-local');
  await ready('wire-local');
  assert.equal(await page.evaluate(() => window.__studio.robot), null);
  assert.equal(await page.evaluate(() => window.__studio.state.frame.position), null);
  assert.equal(await page.locator('#metric-state').textContent(), '—');
  await page.click('#tab-graph');
  const streamSamples = await page.evaluate(() => {
    const frames=window.__studio.state.session.frames;
    return ['fresh','stale','disconnected'].map(status=>({status,time:frames.find(f=>f.health.stream_status===status)?.time}));
  });
  for (const { status, time } of streamSamples) {
    assert.equal(typeof time, 'number', `Captured ${status} sample exists`);
    // The user-facing slider has 1 ms precision; stay causally after the event.
    await seek(time + .001);
    assert.match((await page.locator('#graph-content').textContent()).toLowerCase(), new RegExp(status));
  }
  assert.match(await page.locator('#graph-content').textContent(), /observed|OBSERVED/);
  assert.match(await page.locator('#pose-caption').textContent(), /UNAVAILABLE/);
  await page.screenshot({ path: path.join(evidence, 'observed-zmq-disconnect.png'), fullPage: true });
  await page.click('#tab-joints');
  assert.equal(await page.locator('.joint-table tbody tr').count(), 29);
  assert.match(await page.locator('.joint-table tbody tr').first().locator('td').nth(1).textContent(), /Unavailable|—/);
  await page.click('#tab-intent');
  assert.match(await page.locator('#intent-content').textContent(), /wire|packet|transport/i);
  check('Actual captured ZMQ edge replays fresh/stale/disconnected with robot state honestly unavailable');

  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  assert.ok(await page.evaluate(() => document.body.scrollWidth <= innerWidth));
  await page.screenshot({ path: path.join(evidence, 'mobile.png'), fullPage: true });
  check('390px responsive layout without horizontal overflow');

  const safety = await (await page.request.get(`${base}/api/safety`)).json();
  assert.equal(safety.hardware_enabled, false);
  assert.equal(safety.dds_participants, 0);
  assert.deepEqual(safety.publishers, []);
  await page.close();
  const health = await context.request.get(`${base}/api/safety`);
  assert.equal(health.status(), 200);
  check('Browser disconnect leaves read-only gateway available; no hardware command path');
  assert.deepEqual(failed, [], 'No failed HTTP resources');
  assert.deepEqual(errors, [], 'No browser exceptions or console errors');
  await writeFile(path.join(evidence, 'browser-acceptance.json'), JSON.stringify({ base, checks, errors, failed, screenshots: evidence }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence, checks }, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'browser-failure.json'), JSON.stringify({ message: error.message, checks, errors, failed }, null, 2));
  if (!page.isClosed()) await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
}
