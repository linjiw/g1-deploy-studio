// Section 4 (suite): Run suite with 3 short runs, then cancel mid-way (during run 2).
// Launches at most 2 runs (run 1 completes, run 2 is cancelled, run 3 is skipped).
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/suite_cancel.mjs
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, api, sleep, readJson } from './harness.mjs';

const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('suite');
R.watch(page);
async function setNum(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-map');
await page.selectOption('#rh-map', fixture.arenaId); await sleep(500);
await page.check('input[name=policy][value="flow-bundle-20261008"]'); await page.click('[data-budget="2,4"]');
await setNum('rh-duration', 3); await setNum('rh-seeds', 1); await page.selectOption('#rh-latency', '0');

let obs = {};
await R.check('4.10', 'Run suite: table fills; during run 2 the UI keeps Cancel and attaches the live run', async () => {
  await page.click('#rh-suite');
  await page.waitForFunction(() => window.__studio.rehearse.suite?.id, null, { timeout: 60000 });
  const suiteId = await page.evaluate(() => window.__studio.rehearse.suite.id);
  const rows = await page.locator('.suite-table tr').count();
  const runUi = async () => page.evaluate(() => ({ cancel: !!document.getElementById('rh-cancel'), runDisabled: document.getElementById('rh-run')?.disabled, suiteDisabled: document.getElementById('rh-suite')?.disabled,
    session: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length, job: window.__studio.rehearse.job?.id, jobStatus: window.__studio.rehearse.job?.status }));
  const during1 = await (async () => { await page.waitForFunction(() => window.__studio.rehearse.suite?.runs?.[0]?.job_id, null, { timeout: 60000 }); await sleep(3000); return runUi(); })();
  // Wait (server-side, fast polling) for run 2 to start.
  let s; const t0 = Date.now();
  while (Date.now() - t0 < 300000) { s = (await api(page, `/api/suites?id=${suiteId}`)).body; if (s.runs[1].job_id && s.runs[1].status === 'running') break; await sleep(250); }
  await sleep(4000);
  const during2 = await runUi(); const shot2 = await R.shot('suite-run2');
  obs = { suiteId, rows, during1, during2, run2: s.runs[1].job_id };
  assert(rows === 3, `rows ${rows}`);
  assert(during1.cancel && during1.runDisabled, `run 1: ${JSON.stringify(during1)}`);
  assert(during2.cancel && during2.runDisabled && during2.suiteDisabled, `during suite run 2 the Cancel button is ${during2.cancel ? 'shown' : 'missing'} and Run preset / Run suite are ${during2.runDisabled ? 'disabled' : 'ENABLED'} (rehearse.js:185 sets a 'running' stub job, so poll() sees no status change and only re-renders the job card)`);
  return { ...obs, shot2 };
});

await R.check('4.10a', 'Suite run 2 is attached live to the viewport', async () => {
  const d = obs.during2; if (!d) return R.blocked('no observation');
  assert(d.session === obs.run2 && d.mode === 'simulation', `viewport shows ${d.session} (${d.mode}) while suite run ${obs.run2} is live`);
  return d;
});

await R.check('4.10c', 'Cancel suite mid-way: current run cancelled, remaining skipped, UI recovers', async () => {
  let via = 'button';
  if (!(await page.locator('#rh-cancel').count())) { via = 'workaround: Runs → Rehearse re-render'; await page.click('#workspace-runs'); await sleep(500); await page.click('#workspace-rehearse'); await sleep(800); }
  await page.waitForSelector('#rh-cancel', { timeout: 10000 });
  await page.click('#rh-cancel');
  await page.waitForFunction(() => ['cancelled', 'completed', 'interrupted', 'failed'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000, polling: 500 });
  await sleep(2000);
  const suite = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  const table = await page.locator('#rh-suite-status').textContent();
  const ui = await page.evaluate(() => ({ cancel: !!document.getElementById('rh-cancel'), run: document.getElementById('rh-run')?.disabled, suite: document.getElementById('rh-suite')?.disabled }));
  const shot = await R.shot('suite-cancelled');
  assert(suite.status === 'cancelled' && suite.runs[0].outcome && suite.runs[1].status === 'cancelled' && suite.runs[2].status === 'skipped', `suite ${suite.status} runs ${JSON.stringify(suite.runs.map(r => [r.status, r.outcome]))}`);
  assert(!ui.cancel && !ui.run && !ui.suite, `UI after cancel ${JSON.stringify(ui)}`);
  assert(/Suite · cancelled/.test(table) && /1\/3 finished/.test(table), `table ${table}`);
  return { via, runs: suite.runs.map(r => [r.status, r.outcome, r.job_id]), table, shot };
});

await R.save(obs);
await browser.close();
