// Targeted acceptance for shareable replay-view URLs; read-only gateway required.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/replay-view-link');
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1512, height: 982 } });
const errors = [], failed = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const check = (name, details = {}) => checks.push({ name, passed: true, ...details });
async function open(query, id) {
  await page.goto(`${base}/?${query}`);
  await page.waitForFunction(id => window.__studio?.state?.session?.metadata.catalog_id === id &&
    (id === 'wire-local' || !!window.__studio.robot) && document.querySelector('#loading-overlay').hidden,
  id, { timeout: 60000 });
  assert.equal(await page.locator('#error-banner').isVisible(), false);
}

try {
  const query = 'session=sonic-dds-tutorial&panel=health&map=1&play=1';
  await open(query, 'sonic-dds-tutorial');
  assert.equal(await page.locator('#tab-health').getAttribute('aria-selected'), 'true');
  assert.equal(await page.locator('#panel-health').isVisible(), true);
  assert.equal(await page.locator('#layer-perception').isChecked(), true);
  assert.match(await page.locator('#reference-caption').textContent(), /final accumulated snapshot/i);
  assert.equal(await page.evaluate(() => window.__studio.state.playing), true);
  const start = await page.evaluate(() => window.__studio.state.time);
  await page.waitForFunction(start => window.__studio.state.time > start + .25, start);
  const end = await page.evaluate(() => window.__studio.state.time);
  assert.match(await page.locator('#health-content').textContent(), /Timing & availability/);
  await page.screenshot({ path: path.join(evidence, 'dds-map-health-playing.png'), fullPage: true });
  check('C++/DDS view link opens Health, observed map and advancing playback', { start, end });

  // Explicit view settings initialize once; a user session switch must reset playback/map.
  await page.selectOption('#session-picker', 'sonic-lockstep');
  await page.waitForFunction(() => window.__studio?.state?.session?.metadata.catalog_id === 'sonic-lockstep' &&
    !!window.__studio.robot && document.querySelector('#loading-overlay').hidden);
  assert.equal(await page.evaluate(() => window.__studio.state.playing), false);
  assert.equal(await page.locator('#layer-perception').isChecked(), false);
  check('Switching sessions does not reapply autoplay/map URL intent');

  await open('session=wire-local&map=1&panel=invalid', 'wire-local');
  assert.equal(await page.locator('#layer-perception').isDisabled(), true);
  assert.equal(await page.locator('#layer-perception').isChecked(), false);
  assert.equal(await page.locator('#tab-intent').getAttribute('aria-selected'), 'true');
  assert.equal(await page.evaluate(() => window.__studio.state.playing), false);
  check('Unavailable map remains disabled and invalid panel is ignored');

  await open('session=sonic-dds-tutorial', 'sonic-dds-tutorial');
  assert.equal(await page.evaluate(() => window.__studio.state.playing), false);
  assert.equal(await page.locator('#layer-perception').isChecked(), false);
  assert.equal(await page.locator('#tab-intent').getAttribute('aria-selected'), 'true');
  check('Ordinary rehearsal links retain paused default');
  assert.deepEqual(errors, []);
  assert.deepEqual(failed, []);
  const result = { base, checks, errors, failed, evidence };
  await writeFile(path.join(evidence, 'view-link-acceptance.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  await writeFile(path.join(evidence, 'view-link-failure.json'), JSON.stringify({ message: error.message, checks, errors, failed }, null, 2));
  await page.screenshot({ path: path.join(evidence, 'failure.png'), fullPage: true });
  throw error;
} finally {
  await browser.close();
}
