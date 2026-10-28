// Read-only Studio UX regression checks. Uses a real replay; creates no jobs/maps.
// STUDIO_URL=http://127.0.0.1:8796 node tools/browser/studio_ux.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/studio-ux');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
const checks = [], errors = [];
page.on('pageerror', error => errors.push(error.message));
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log('✓', name); };
const ready = p => p.waitForFunction(() => window.__studio?.state.session?.metadata.catalog_id === 'sonic-lockstep' && document.querySelector('#loading-overlay').hidden, null, { timeout: 90000 });
try {
  await page.goto(`${base}/?session=sonic-lockstep`); await ready(page);
  for (const width of [320, 390, 768, 1024]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(() => document.body.classList.contains('drawer-mode') === (innerWidth >= 1024 && innerWidth < 1280));
    const drawer = page.locator('#inspector-toggle');
    if (await drawer.isVisible()) {
      await drawer.click();
      assert.equal(await drawer.getAttribute('aria-expanded'), 'true');
    }
    assert.equal(await page.locator('.inspector').isVisible(), true, `inspector at ${width}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `horizontal overflow at ${width}`);
    await page.locator('#tab-health').click();
    assert.equal(await page.locator('#tab-health').getAttribute('aria-selected'), 'true');
    if (await drawer.isVisible()) {
      await page.keyboard.press('Escape');
      assert.equal(await drawer.getAttribute('aria-expanded'), 'false');
      assert.equal(await drawer.evaluate(el => document.activeElement === el), true);
    }
    const evidenceButton = await page.locator('#evidence-button').isVisible() ? page.locator('#evidence-button') : page.locator('#hardware-chip');
    await evidenceButton.click();
    assert.equal(await page.locator('#evidence-legend').isVisible(), true, `evidence key at ${width}`);
    await page.keyboard.press('Escape');
    await page.screenshot({ path: path.join(evidence, `studio-${width}.png`), fullPage: true });
  }
  check('inspector, evidence key and health remain accessible at 320, 390, 768 and 1024 px');

  await page.setViewportSize({ width: 1440, height: 1000 });
  const lanes = page.locator('#lanes-canvas'), laneRect = await lanes.boundingBox();
  await page.mouse.move(laneRect.x + 200, laneRect.y + 20); await page.mouse.down();
  const cancelledAt = await page.evaluate(() => window.__studio.state.time);
  await lanes.dispatchEvent('pointercancel', { pointerId: 1 });
  await page.mouse.move(laneRect.x + 280, laneRect.y + 20); await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__studio.state.time), cancelledAt);
  check('cancelled timeline drag stops seeking');
  await page.locator('#workspace-arena').click();
  await page.waitForSelector('#arena-base');
  assert.equal(await page.locator('.inspector').isVisible(), false);
  await page.selectOption('#arena-base', 'tpl:corridor');
  const canvas = page.locator('#arena-canvas');
  const rect = await canvas.boundingBox();
  await page.locator('[data-arena-tool="wall"]').click();
  const original = await page.evaluate(() => window.__studio.arena.boxes.length);
  await page.mouse.move(rect.x + rect.width / 2, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width / 2 + 80, rect.y + rect.height / 2 + 30);
  await canvas.dispatchEvent('pointercancel', { pointerId: 1, pointerType: 'mouse' });
  await page.mouse.up();
  assert.equal(await page.evaluate(() => window.__studio.arena.drag), null);
  assert.equal(await page.evaluate(() => window.__studio.arena.boxes.length), original);
  await page.evaluate(() => { window.__studio.arena.selection = { type: 'box', index: 0 }; });
  await canvas.focus();
  await canvas.dispatchEvent('keydown', { key: 'd', ctrlKey: true, bubbles: true });
  await canvas.dispatchEvent('keydown', { key: 'r', metaKey: true, bubbles: true });
  assert.equal(await page.evaluate(() => window.__studio.arena.boxes.length), original);
  assert.equal(await page.evaluate(() => window.__studio.arena.boxes[0].yaw), 0);
  await page.keyboard.press('ArrowRight');
  await page.waitForSelector('#box-x');
  const x = await page.evaluate(() => window.__studio.arena.boxes[0].center_xy[0]);
  await page.fill('#box-x', ''); await page.locator('#box-y').focus();
  assert.equal(await page.evaluate(() => window.__studio.arena.boxes[0].center_xy[0]), x, 'clearing numeric field must not move obstacle to origin');
  await page.setViewportSize({ width: 390, height: 900 });
  assert.equal(await page.locator('.inspector').isVisible(), false, 'mobile arena should not show unrelated replay inspector');
  check('cancelled arena gestures, browser modifier shortcuts and empty numeric fields preserve geometry');

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#workspace-sensors').click();
  await page.waitForSelector('#sensors-panel [data-pin-sensor="base_pose"]:not([disabled])');
  await page.setViewportSize({ width: 1100, height: 1000 });
  const narrowScene = await page.locator('.viewport-shell').boundingBox(), narrowToolbar = await page.locator('.vp-toolbar').boundingBox(), narrowTitle = await page.locator('.vp-title').boundingBox();
  assert.ok(narrowToolbar.x >= narrowScene.x && narrowToolbar.x + narrowToolbar.width <= narrowScene.x + narrowScene.width + 1, 'toolbar fits the narrow desktop scene');
  assert.ok(narrowTitle.y + narrowTitle.height <= narrowToolbar.y + 1 || narrowToolbar.y + narrowToolbar.height <= narrowTitle.y + 1 ||
    narrowTitle.x + narrowTitle.width <= narrowToolbar.x + 1, 'title clears the desktop toolbar');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('#sensors-panel [data-pin-sensor="base_pose"]').click();
  const summary = page.locator('#sensors-panel [data-sensor-card="base_pose"] summary');
  await summary.click(); await summary.focus();
  await page.evaluate(() => window.__studio.seek(0.2));
  await page.waitForFunction(() => document.querySelector('#sensors-panel .tiny')?.textContent.includes('0.200'));
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'SUMMARY');
  assert.equal(await page.locator('#sensors-panel [data-sensor-card="base_pose"] details').getAttribute('open'), '');
  check('sensor refresh preserves expanded provenance and keyboard focus');
  let failedRequests = 0;
  const failSensors = route => { failedRequests++; return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Injected sensor outage' }) }); };
  await page.route('**/api/sensors?*', failSensors);
  await page.evaluate(() => window.__studio.seek(0.4));
  await page.waitForSelector('#sensors-retry');
  assert.equal(await page.locator('#sensor-dock .sensor-state').textContent(), 'unavailable');
  assert.equal(await page.locator('#sensors-panel .sensor-state.available').count(), 0);
  await page.waitForTimeout(750);
  assert.equal(failedRequests, 1, 'failed sensor retries must be bounded');
  await page.unroute('**/api/sensors?*', failSensors);
  await page.locator('#sensors-retry').click();
  await page.waitForFunction(() => !document.querySelector('#sensors-retry') && document.querySelector('#sensor-dock .sensor-state')?.textContent === 'fresh');
  check('sensor outage hides old samples, bounds retries and recovers explicitly', { failedRequests });

  const touch = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const mobile = await touch.newPage();
  await mobile.goto(`${base}/?session=sonic-lockstep`); await ready(mobile);
  for (const id of ['play', 'restart', 'camera-orbit', 'layers-button', 'hardware-chip']) {
    assert.ok((await mobile.locator(`#${id}`).boundingBox()).height >= 44, `${id} touch target`);
  }
  assert.equal(await mobile.locator('.loader').evaluate(el => getComputedStyle(el).animationName), 'none');
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await mobile.screenshot({ path: path.join(evidence, 'studio-touch.png'), fullPage: true });
  await mobile.setViewportSize({ width: 320, height: 700 });
  const toolbar = await mobile.locator('.vp-toolbar').boundingBox(), title = await mobile.locator('.vp-title').boundingBox();
  assert.ok(title.y + title.height <= toolbar.y + 1 || toolbar.y + toolbar.height <= title.y + 1 ||
    title.x + title.width <= toolbar.x + 1, 'wrapped touch toolbar must not overlap the title');
  assert.ok(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await touch.close();
  check('touch controls have 44 px targets and reduced-motion stops loader animation');
  assert.deepEqual(errors, []);
  await writeFile(path.join(evidence, 'studio-ux.json'), JSON.stringify({ base, checks, errors }, null, 2));
  console.log(JSON.stringify({ passed: checks.length, evidence }));
} catch (error) {
  await page.screenshot({ path: path.join(evidence, 'studio-ux-failure.png'), fullPage: true }).catch(() => {});
  await writeFile(path.join(evidence, 'studio-ux-failure.json'), JSON.stringify({ message: error.message, checks, errors }, null, 2));
  throw error;
} finally { await browser.close(); }
