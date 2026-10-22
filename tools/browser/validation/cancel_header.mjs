// Section 4.9b: after Cancel, the header/viewport must stop claiming a live, running simulation.
// Launches ONE short bundle run (K2/ODE4, 3 s) and cancels it.
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, sleep, readJson } from './harness.mjs';
const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('cancel'); R.watch(page);
await page.goto(`${BASE}/`); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await R.check('4.9b', 'After Cancel the header, outcome chip and transport stop showing LIVE / Running', async () => {
  await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-map');
  await page.selectOption('#rh-map', fixture.arenaId); await sleep(500);
  await page.check('input[name=policy][value="flow-bundle-20261008"]'); await page.click('[data-budget="2,4"]');
  await page.fill('#rh-duration', '3'); await page.locator('#rh-duration').dispatchEvent('change'); await page.selectOption('#rh-latency', '0');
  await page.click('#rh-run');
  await page.waitForFunction(() => window.__studio.rehearse.job?.id && window.__studio.state.sessionId === window.__studio.rehearse.job.id && window.__studio.state.session.metadata.mode === 'simulation', null, { timeout: 120000 });
  const id = await page.evaluate(() => window.__studio.rehearse.job.id);
  await page.waitForSelector('#rh-cancel'); await page.click('#rh-cancel');
  await page.waitForFunction(() => window.__studio.rehearse.job?.status === 'cancelled', null, { timeout: 60000 });
  await sleep(4000);
  const ui = await page.evaluate(() => ({ badge: document.getElementById('mode-badge').textContent, chip: document.getElementById('run-outcome').textContent, playback: document.getElementById('playback-state').textContent,
    picker: document.getElementById('session-picker').selectedOptions[0]?.textContent, card: document.getElementById('rh-job').querySelector('.job-line')?.textContent, health: document.querySelector('#health-content .tab-intro')?.textContent }));
  const shot = await R.shot('after-cancel');
  assert(!/live CPU simulation/i.test(ui.badge) && !/running/i.test(ui.chip) && !/^live$/i.test(ui.playback.trim()), `job ${id} cancelled, but header still shows "${ui.badge}" / chip "${ui.chip}" / transport "${ui.playback}" / picker "${ui.picker}" / Health "${ui.health}"`);
  return { id, ui, shot };
});
await R.save();
await browser.close();
