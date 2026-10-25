// Navigate and Rehearse with the deploy-side guards (g1-student-deploy g1deploy/guards.py): the controls, the deploy
// preset (--guards walls --goal-lookahead 1.0, the robot's H5-H6 flags), a session that runs with them, and the job
// provenance. Needs a gateway whose deploy root has guards.py (G1_STUDENT_DEPLOY at branch robustness or integration).
//   STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/navigate_guards.mjs
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const R = recorder('navigate_guards');
const { browser, context } = await launch();
const page = await context.newPage();
R.watch(page);
const nav = () => page.evaluate(() => {
  const n = window.__studio.navigate;
  return { job: n.job?.id, status: n.job?.status, phase: n.job?.latest?.navigation?.phase, settings: n.settings };
});

await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.ready && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });

await R.check('G1', 'The gateway offers the guard presets of its deploy stack', async () => {
  const wb = (await api(page, '/api/workbench')).body;
  assert(wb?.guards?.available === true, `guards ${JSON.stringify(wb?.guards)}`);
  assert(JSON.stringify(Object.keys(wb.guards.presets)) === JSON.stringify(['off', 'deploy', 'walls']), 'presets');
});

await R.check('G2', 'Navigate: Guards and Walking speed controls; Use deploy settings picks walls + 1.0 m', async () => {
  await page.click('#workspace-navigate');
  await page.waitForSelector('#nav-world');
  const options = await page.$$eval('#nav-guards option', o => o.map(x => x.value));
  assert(JSON.stringify(options) === JSON.stringify(['off', 'deploy', 'walls']), `options ${options}`);
  await page.click('#nav-deploy-preset');
  await sleep(300);
  const { settings } = await nav();
  assert(settings.guards === 'walls' && settings.lookahead === '1.0', `settings ${JSON.stringify(settings)}`);
  assert(await page.$eval('#nav-guards', s => s.value) === 'walls', 'select shows walls');
  await R.shot('deploy-preset');
  return { settings };
});

await R.check('G3', 'A session started with them carries guards walls and lookahead 1.0, and stands', async () => {
  // Light settings so the session starts in seconds; the guards stay as the preset set them.
  await page.selectOption('#nav-planner', 'quick');
  await page.selectOption('#nav-latency', 'none');
  await page.click('#nav-start-session');
  const deadline = Date.now() + 180000;
  let s;
  while (Date.now() < deadline) { s = await nav(); if (s.phase === 'WAIT') break; await sleep(500); }
  assert(s?.phase === 'WAIT', `phase ${s?.phase} status ${s?.status}`);
  const jobs = (await api(page, '/api/jobs')).body?.jobs ?? [];
  const job = jobs.find(j => j.id === s.job);
  assert(job?.navigation?.guards === 'walls' && job?.navigation?.goal_lookahead_m === 1, `job ${JSON.stringify(job?.navigation)}`);
  await page.click('#nav-end');
  const end = Date.now() + 60000;
  while (Date.now() < end) { s = await nav(); if (!['starting', 'running', 'cancelling'].includes(s.status)) break; await sleep(500); }
  return { job: s.job, status: s.status };
});

await R.check('G4', 'Rehearse lists the guard presets and walking speed for the deploy bundle student', async () => {
  await page.click('#workspace-rehearse');
  await page.waitForSelector('#rh-guards', { timeout: 20000 });
  const options = await page.$$eval('#rh-guards option', o => o.map(x => x.value));
  assert(options.includes('walls') && options.includes('deploy'), `options ${options}`);
  assert(await page.locator('#rh-lookahead').count() === 1, 'walking speed select');
  await R.shot('rehearse');
});

await R.save();
await browser.close();
