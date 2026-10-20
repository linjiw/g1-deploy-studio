// Re-validation · deterministic repro of N3: after a run ends without a recording, starting a suite and
// pressing Cancel before its first run is picked up re-polls the PREVIOUS run (stale rh.job) and tries to
// attach it. Launches at most 2 short bundle runs (one cancelled when live, one cancelled at start).
//   STUDIO_URL=http://127.0.0.1:8795 STUDIO_EVIDENCE=... node tools/browser/validation/reval_stale_cancel.mjs
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, api, sleep, readJson } from './harness.mjs';

const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('reval-stale-cancel');
R.watch(page);
async function setNum(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-map'); await sleep(300);
await page.selectOption('#rh-map', fixture.arenaId); await sleep(500);
await page.check('input[name=policy][value="flow-bundle-20261008"]'); await page.click('[data-budget="2,4"]');
await setNum('rh-duration', 2); await setNum('rh-seed', 7); await page.selectOption('#rh-preset', '2'); await page.selectOption('#rh-latency', '0');

let first = null;
await R.check('N3', 'Cancelling a suite before its first run is attached never re-attaches the previous run or shows an error', async () => {
  await page.click('#rh-run');
  await page.waitForFunction(() => window.__studio.rehearse.job?.id && window.__studio.state.sessionId === window.__studio.rehearse.job.id && window.__studio.state.session?.metadata?.mode === 'simulation', null, { timeout: 120000 });
  first = await page.evaluate(() => window.__studio.rehearse.job.id);
  await page.click('#rh-cancel');
  await page.waitForFunction(() => window.__studio.state.session?.metadata?.mode === 'partial-live', null, { timeout: 60000 });
  await sleep(1000);
  await page.click('#rh-suite');
  await page.waitForSelector('#rh-cancel', { timeout: 20000 });
  const before = await page.evaluate(() => ({ suite: window.__studio.rehearse.suite?.id, job: window.__studio.rehearse.job?.id }));
  await page.click('#rh-cancel');
  await page.waitForFunction(() => !['queued', 'running', 'cancelling'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000 });
  await sleep(2500);
  const suite = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  const banner = await page.locator('#error-banner').isVisible() ? await page.locator('#error-banner').textContent() : null;
  const card = await page.locator('#rh-job h4').textContent().catch(() => null);
  const shot = await R.shot('stale-cancel');
  assert(!banner && !card?.includes(first), `previous run ${first}; at Cancel rh.job was ${before.job}; suite ${suite.id} → ${suite.status} runs ${JSON.stringify(suite.runs.map(r => [r.status, r.job_id]))}; Current run card "${card}"; error banner "${banner}" (rehearse.js cancel() polls the stale rh.job; app.js 'rehearse:job' attaches any job while in Rehearse)`);
  return { first, before, suite: suite.runs.map(r => [r.status, r.job_id]), card, shot };
});
await R.save({ first });
await browser.close();
