// Re-validation · N1 (verify-20261020): reloading the page while a run is *detached* (the gateway restarted,
// the worker survived) must not loop on /api/session 404s; the recording must open when the run finishes.
// Launches 1 short bundle run and restarts THIS gateway (never the 8790 service).
//   PORT=8796 DATA_ROOT=... EVIDENCE=... STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/reval_detached_reload.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const GW = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'gateway.sh');
const PORT = new URL(BASE).port;
const gateway = (cmd, env = {}) => execFileSync(GW, [cmd], { env: { ...process.env, PORT, ...env }, encoding: 'utf8' }).trim();
const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('reval-detached-reload');
R.watch(page);
const sessionMisses = [];
const sessionLoads = [];
page.on('response', r => {
  if (!r.url().includes('/api/session?')) return;
  if (r.status() === 404) sessionMisses.push(r.url()); else if (r.status() === 200) sessionLoads.push(r.url());
});
const ready = () => page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });

await page.goto(`${BASE}/`); await ready();
await R.check('N1', 'Reload during a detached run: no /api/session 404 loop, and the recording opens when it finishes', async () => {
  const token = (await api(page, '/api/workbench')).body.csrf_token;
  const post = async (p, data) => (await page.request.post(`${BASE}${p}`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data })).json();
  const saved = await post('/api/scenarios', { backend_id: 'flow-sonic-cpu', map_id: 'flat-ground', label: 'Reval detached reload', duration_s: 6,
    start_xy: [0, 0], goal_xy: [2, 0], seed: 0, policy_id: 'flow-bundle-20261008', planner: { candidates: 2, ode_steps: 4 } });
  const job = await post('/api/jobs', { scenario_id: saved.scenario.id });
  const t0 = Date.now();
  while (Date.now() - t0 < 90000) { const j = (await api(page, `/api/jobs?id=${job.id}&light=1`)).body; if (j.status === 'running' && j.latest?.frame) break; await sleep(300); }
  gateway('stop', { SIG: 'TERM' }); await sleep(500); gateway('start');
  const status = (await api(page, `/api/jobs?id=${job.id}`)).body.status;
  await page.goto(`${BASE}/?workspace=rehearse`); await ready();
  await page.click('#workspace-rehearse').catch(() => {});
  sessionMisses.length = 0; sessionLoads.length = 0;
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'replay', job.id, { timeout: 180000 }).catch(() => {});
  const opened = await page.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode }));
  const shot = await R.shot('detached-reload-opened');
  await sleep(1500);  // a duplicate load would follow the first within the finish handler
  const loads = sessionLoads.filter(u => new URL(u).searchParams.get('id') === job.id).length;
  const final = (await api(page, `/api/jobs?id=${job.id}`)).body;
  assert(status === 'detached' || status === 'completed', `after the restart the job was ${status}`);
  assert(sessionMisses.length <= 1, `${sessionMisses.length} /api/session 404s while following`);
  assert(final.status === 'completed' && opened.id === job.id && opened.mode === 'replay', `final ${final.status}; opened ${JSON.stringify(opened)}`);
  assert(loads === 1, `the recording was loaded ${loads} times (VERIFY2: once is enough)`);
  return { job: job.id, statusAfterRestart: status, misses: sessionMisses.length, recordingLoads: loads, opened, shot };
}, { expectHttp: [new RegExp(`failed .*127\\.0\\.0\\.1:${PORT}`), /50\d /, /403 /] });
await R.save({});
await browser.close();
