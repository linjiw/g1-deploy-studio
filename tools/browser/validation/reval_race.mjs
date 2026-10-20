// Re-validation (v0.3 fixes) · cancel landing during worker completion (F4). API + filesystem only,
// against the validation gateway's own data root. Launches 2 short bundle runs (2 s, K2/ODE4):
//   R7 single job: POST /api/jobs/cancel the moment run/result.json (completed receipt) appears.
//   R8 suite of 1: POST /api/suites/cancel the moment run/session.json appears (suite thread signals ≤0.3 s later).
// Expected for both: a run whose worker committed a completed receipt + recording stays completed and replayable.
//   STUDIO_URL=http://127.0.0.1:8795 STUDIO_EVIDENCE=... STUDIO_DATA_ROOT=... node tools/browser/validation/reval_race.mjs
import { existsSync, readFileSync, watch } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { BASE, EVIDENCE, launch, recorder, assert, sleep, readJson } from './harness.mjs';

const DATA = process.env.STUDIO_DATA_ROOT || path.join(os.homedir(), 'research-data/g1-deploy-studio/validation-workbench-2');
const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('reval-race');
R.watch(page);
const get = async p => (await fetch(`${BASE}${p}`)).json();
let token = (await get('/api/workbench')).csrf_token;
const post = async (p, data) => { const r = await fetch(`${BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, body: JSON.stringify(data) }); return { status: r.status, body: await r.json().catch(() => ({})) }; };
const map = await get(`/api/map?id=${fixture.arenaId}`);
async function scenario(label, q) {
  const r = await post('/api/scenarios', { label, preset_label: q.label, map_id: fixture.arenaId, backend_id: 'flow-sonic-cpu', policy_id: 'flow-bundle-20261008', criterion: 'arrive_hold',
    latency: { ms: 0, anchor: 'measured' }, duration_s: 2, start_xy: q.start_xy, goal_xy: q.goal_xy, start_yaw_rad: q.start_yaw_rad ?? 0, seed: 0, planner: { candidates: 2, ode_steps: 4 } });
  assert(r.status < 300, `scenario ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.scenario.id;
}
// Resolve as soon as <dir>/<name> exists (fs.watch on the directory + 2 ms polling fallback).
function appear(dir, name, timeout = 300000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now(); let w = null, done = false;
    const finish = how => { if (done) return; done = true; clearInterval(iv); try { w?.close(); } catch { /* closed */ } resolve({ how, at: Date.now() }); };
    const iv = setInterval(() => {
      if (!w && existsSync(dir)) { try { w = watch(dir, (ev, f) => { if (f === name && existsSync(path.join(dir, name))) finish('watch'); }); } catch { /* retry */ } }
      if (existsSync(path.join(dir, name))) finish('poll');
      if (Date.now() - t0 > timeout) { clearInterval(iv); reject(new Error(`${name} did not appear in ${dir}`)); }
    }, 2);
  });
}
const workerAlive = id => { try { return execSync(`pgrep -f -- "--output .*${id}/run"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean).length; } catch { return 0; } };
async function terminal(id, timeout = 240000) { const t0 = Date.now(); let j; do { j = await get(`/api/jobs?id=${id}`); if (['completed', 'failed', 'cancelled'].includes(j.status)) return j; await sleep(300); } while (Date.now() - t0 < timeout); return j; }
const receipt = id => { try { return JSON.parse(readFileSync(path.join(DATA, 'jobs', id, 'run/result.json'), 'utf8')); } catch { return null; } };

const out = {};
await R.check('4.10c-race-job', 'Cancel landing during completion (single job, cancel at the completed receipt) keeps a completed, replayable run', async () => {
  const sid = await scenario('Reval race · cancel at receipt', map.presets[2]);
  const start = await post('/api/jobs', { scenario_id: sid });
  assert(start.status < 300, `start ${start.status} ${JSON.stringify(start.body)}`);
  const id = start.body.id; out.job = id;
  const seen = await appear(path.join(DATA, 'jobs', id, 'run'), 'result.json');
  const alive = workerAlive(id);
  const t = Date.now(); const cancel = await post('/api/jobs/cancel', { id }); const cancelMs = Date.now() - t;
  const j = await terminal(id);
  const rec = receipt(id);
  const runs = (await get('/api/runs')).runs, row = runs.find(r => r.id === id);
  const sess = await fetch(`${BASE}/api/session?id=${id}`); await sess.arrayBuffer();
  const res = { id, detectedBy: seen.how, workerAliveAtReceipt: alive, cancel: { status: cancel.status, error: cancel.body.error, status_after: cancel.body.status, ms: cancelMs },
    job: { status: j.status, error: j.error, exit_code: j.exit_code, result_session_id: j.result_session_id, teardown_warning: j.teardown_warning }, receipt: rec?.status,
    row: row && { status: row.status, outcome: row.outcome, replayable: row.replayable }, sessionHttp: sess.status };
  out.jobRace = res;
  assert(rec?.status === 'completed', `receipt ${rec?.status}`);
  assert(j.status === 'completed' && j.result_session_id === id && row?.replayable && sess.status === 200,
    `worker wrote a completed receipt + recording, cancel ${cancel.status} "${cancel.body.error ?? cancel.body.status}" landed ${alive ? 'while the worker was still exiting' : 'after exit'}; job ended ${j.status} (exit ${j.exit_code}, "${j.error}"), replayable ${row?.replayable}, Runs outcome ${row?.outcome} (workbench.py _monitor: complete but returncode != 0 → failed)`);
  return res;
}, { expectHttp: [/4\d\d .*\/api\/jobs\/cancel/] });

await R.check('4.10c-race-suite', 'Suite cancel landing during completion (cancel at session.json) keeps a completed, replayable run; the suite table counts it', async () => {
  const sid = await scenario('Reval race · suite cancel at recording', map.presets[1]);
  const s0 = await post('/api/suites', { label: 'Reval race suite · 1 run', scenario_ids: [sid] });
  assert(s0.status < 300, `suite ${s0.status} ${JSON.stringify(s0.body)}`);
  const suiteId = s0.body.id; out.suite = suiteId;
  let s, t0 = Date.now(); do { s = await get(`/api/suites?id=${suiteId}`); if (s.runs[0].job_id) break; await sleep(100); } while (Date.now() - t0 < 60000);
  const id = s.runs[0].job_id; out.suiteJob = id;
  const seen = await appear(path.join(DATA, 'jobs', id, 'run'), 'session.json');
  const cancel = await post('/api/suites/cancel', { id: suiteId });
  t0 = Date.now(); do { s = await get(`/api/suites?id=${suiteId}`); if (!['queued', 'running', 'cancelling'].includes(s.status)) break; await sleep(300); } while (Date.now() - t0 < 120000);
  const j = await terminal(id); const rec = receipt(id);
  const row = (await get('/api/runs')).runs.find(r => r.id === id);
  const res = { suiteId, id, detectedBy: seen.how, cancel: { status: cancel.status, suite: cancel.body.status, error: cancel.body.error }, suite: { status: s.status, run: s.runs[0] },
    job: { status: j.status, error: j.error, exit_code: j.exit_code, result_session_id: j.result_session_id }, receipt: rec?.status, row: row && { status: row.status, outcome: row.outcome, replayable: row.replayable } };
  out.suiteRace = res;
  const consistent = rec?.status === 'completed'
    ? j.status === 'completed' && row?.replayable && s.runs[0].status === 'completed' && !!s.runs[0].outcome
    : j.status === 'cancelled' && !s.runs[0].outcome && !row?.outcome;
  assert(consistent, `receipt ${rec?.status}; job ${j.status} (exit ${j.exit_code}, ${j.error}); suite run ${JSON.stringify(s.runs[0])}; runs row ${JSON.stringify(res.row)}`);
  return res;
}, { expectHttp: [/4\d\d .*\/api\/suites\/cancel/] });

await R.save(out);
await browser.close();
