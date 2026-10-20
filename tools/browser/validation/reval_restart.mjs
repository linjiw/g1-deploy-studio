// Re-validation (v0.3 fixes) · restarts, reloads and recovery. Restarts ONLY the validation gateway
// (tools/browser/validation/gateway.sh with PORT / DATA_ROOT / EVIDENCE). Launches 3 short bundle runs (3 s, K2/ODE4):
//   R9  reload in Rehearse (8.2a), then reload in Replay (8.2b); release guard during a single job
//   R10 gateway + worker SIGTERM mid-run (8.1) → header leaves LIVE (4.9b-restart); Save without reload (8.1b);
//       idle restart, then Run preset without reload (8.1b-run)
//   R11 gateway-only SIGTERM, worker survives (8.1c) → replayable right after completion (8.1d)
//   PORT=8795 DATA_ROOT=... EVIDENCE=... STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/reval_restart.mjs
import { execFileSync, execSync } from 'node:child_process';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, api, sleep, readJson } from './harness.mjs';
import { writeFile } from 'node:fs/promises';

const GW = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'gateway.sh');
const PORT = new URL(BASE).port;
const gateway = (cmd, env = {}) => execFileSync(GW, [cmd], { env: { ...process.env, PORT, ...env }, encoding: 'utf8' }).trim();
const workerPids = job => { try { return execSync(`pgrep -f -- "--output .*${job}/run"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
const { browser, context } = await launch();
let page = await context.newPage();
const R = recorder(process.env.ONLY ? 'reval-restart-b' : 'reval-restart');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const check0 = R.check; R.check = (id, ...rest) => (!ONLY || ONLY.has(id)) ? check0(id, ...rest) : null;
R.watch(page);
const S = () => page.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length,
  badge: document.querySelector('#mode-badge').textContent, chip: document.querySelector('#run-outcome').textContent, playback: document.querySelector('#playback-state').textContent,
  health: document.querySelector('#health-content .tab-intro')?.textContent ?? null, warning: document.querySelector('#recording-warning').hidden ? null : document.querySelector('#recording-warning').textContent,
  workspace: window.__studio.state.workspace, attached: window.__studio.rehearse.attached, job: window.__studio.rehearse.job?.id, jobStatus: window.__studio.rehearse.job?.status,
  error: document.getElementById('workbench-error')?.hidden === false ? document.getElementById('workbench-error').textContent : null }));
async function setNum(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
async function boot(url = `${BASE}/`) { await page.goto(url); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 }); }
async function startRun(preset, duration = 3) {
  if (await page.evaluate(() => window.__studio.state.workspace) !== 'rehearse') await page.click('#workspace-rehearse');
  await page.waitForSelector('#rh-map'); await sleep(300);
  await page.selectOption('#rh-map', fixture.arenaId); await sleep(500);
  await page.check('input[name=policy][value="flow-bundle-20261008"]'); await sleep(100); await page.click('[data-budget="2,4"]');
  await setNum('rh-duration', duration); await setNum('rh-seed', 0); await page.selectOption('#rh-preset', preset); await page.selectOption('#rh-latency', '0'); await sleep(150);
  const prev = await page.evaluate(() => window.__studio.rehearse.job?.id ?? null);
  await page.click('#rh-run');
  await page.waitForFunction(prev => window.__studio.rehearse.job?.id && window.__studio.rehearse.job.id !== prev, prev, { timeout: 60000 });
  const id = await page.evaluate(() => window.__studio.rehearse.job.id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation' && window.__studio.state.session.frames.length > 2, id, { timeout: 180000, polling: 150 });
  return id;
}
async function jobApi(id) { return (await api(page, `/api/jobs?id=${id}&light=1`)).body; }
async function activeRuns() {
  const script = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../../studio_service.sh');
  const fn = execFileSync('sed', ['-n', '/^active_runs() {/,/^}/p', script], { encoding: 'utf8' });
  return execFileSync('bash', ['-c', `set -euo pipefail\n${fn}\nPORT=${PORT}\nbusy="$(active_runs | xargs)"\nif [[ -n "$busy" && "\${FORCE:-0}" != 1 ]]; then echo "WOULD REFUSE: $busy"; else echo "WOULD RELEASE"; fi`], { encoding: 'utf8' }).trim();
}
const downAllow = [new RegExp(`failed .*127\\.0\\.0\\.1:${PORT}`), /50\d /];
const jobs = {};

// ------------------------------------------------------------------ R9 reloads
await boot();
let r9 = null;
await R.check('8.2b', 'Reload while in Replay during a live run keeps the live view updating, then opens the recording', async () => {
  r9 = await startRun('0'); jobs.reload = r9;
  jobs.releaseGuardSingle = await activeRuns();
  await page.click('#workspace-replay'); await sleep(200);
  await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  const a = await S(); await sleep(1200); const b = await S();
  const shot = await R.shot('reload-in-replay');
  const statusAtB = (await jobApi(r9)).status;
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay', r9, { timeout: 90000 }).catch(() => {});
  const done = await S(); const shotDone = await R.shot('reload-in-replay-done');
  assert(statusAtB === 'running' || b.frames > a.frames, `run finished before the post-reload sample (${statusAtB}); cannot observe following`);
  assert(a.id === r9 && a.workspace === 'replay', `reload did not reopen the live job in Replay: ${JSON.stringify(a)}`);
  assert(b.frames > a.frames, `live view frozen after reload in Replay: frames ${a.frames} → ${b.frames} (${b.badge}, ${b.playback}), job ${statusAtB}`);
  assert(done.id === r9 && done.mode === 'replay' && /REPLAY · CPU REHEARSAL/.test(done.badge), `after completion: ${JSON.stringify(done)}`);
  return { a, b, statusAtB, done, shot, shotDone };
});

let r10 = null;
await R.check('8.2a', 'Reload the page mid-run (in Rehearse) re-attaches to the live job', async () => {
  r10 = await startRun('1'); jobs.killed = r10;
  await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  await page.waitForFunction(id => window.__studio.rehearse.job?.id === id && window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'simulation', r10, { timeout: 30000 });
  const a = await S(); await sleep(1000); const b = await S();
  const shot = await R.shot('reload-in-rehearse');
  assert(b.frames > a.frames && /LIVE/.test(b.badge), `re-attach frames ${a.frames} → ${b.frames} badge ${b.badge} job ${(await jobApi(r10)).status}`);
  return { a, b, shot };
});

await R.check('B.release-guard-job', 'release guard: active_runs lists a single running job (would refuse)', async () => {
  const s = jobs.releaseGuardSingle; if (!s) return R.blocked('no observation');
  assert(new RegExp(`^WOULD REFUSE: ${r9}$`).test(s), `active_runs during ${r9}: "${s}"`);
  return { during: s, idle: await activeRuns() };
});

// ------------------------------------------------------------------ R10 gateway + worker killed mid-run
await R.check('8.1', 'Restart the gateway and its worker mid-run → job recovered as failed with a reason, never success', async () => {
  if (!r10 || (await jobApi(r10)).status !== 'running') { r10 = await startRun('1'); jobs.killed = r10; }
  await page.click('#tab-health'); await sleep(300);
  const pids = workerPids(r10);
  gateway('stop', { SIG: 'TERM' }); for (const p of pids) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } }
  await sleep(2500);
  const during = await S(); const shotDown = await R.shot('gateway-down');
  gateway('start'); await sleep(2000);
  const job = (await api(page, `/api/jobs?id=${r10}`)).body;
  await page.waitForFunction(id => { const j = window.__studio.rehearse.job; return j?.id === id && !['running', 'starting', 'cancelling'].includes(j.status); }, r10, { timeout: 30000 }).catch(() => {});
  await sleep(1500);
  const ui = await S();
  const row = (await api(page, '/api/runs')).body.runs.find(r => r.id === r10);
  const shot = await R.shot('gateway-recovered');
  jobs.afterKill = ui;
  assert(job.status === 'failed' && /interrupt|ownership/i.test(job.error ?? ''), `recovered job ${job.status}: ${job.error}`);
  assert(ui.jobStatus === 'failed', `UI job ${ui.jobStatus}`);
  assert(row && row.status === 'failed' && row.outcome !== 'goal_completion' && !row.replayable, `runs row ${JSON.stringify(row && { s: row.status, o: row.outcome, r: row.replayable })}`);
  return { job: r10, pids, error: job.error, during: { badge: during.badge, error: during.error }, ui, shotDown, shot };
}, { expectHttp: downAllow });

await R.check('4.9b-restart', 'After a gateway-restart failure the header/badge/chip/transport/Health leave LIVE → RUN FAILED · PARTIAL LIVE SAMPLES', async () => {
  const ui = jobs.afterKill; if (!ui) return R.blocked('8.1 did not run');
  assert(ui.id === r10, `viewport left the run: ${ui.id}`);
  assert(/RUN FAILED · PARTIAL LIVE SAMPLES/.test(ui.badge) && !/LIVE CPU/.test(ui.badge), `badge "${ui.badge}"`);
  assert(!/running/i.test(ui.chip) && /fail|error/i.test(ui.chip), `chip "${ui.chip}"`);
  assert(/RUN FAILED/.test(ui.playback), `transport "${ui.playback}"`);
  assert(/PARTIAL LIVE SAMPLES/.test(ui.health ?? ''), `Health "${ui.health}"`);
  return ui;
});

await R.check('8.1b', 'After a gateway restart the open page can still POST (Save arena) without a reload', async () => {
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  await page.selectOption('#arena-base', 'tpl:corridor');
  await page.fill('#arena-label', 'Reval after restart'); await page.locator('#arena-label').dispatchEvent('input'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200);
  await page.click('#arena-save'); await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 15000 }).catch(() => {});
  const id = await page.evaluate(() => window.__studio.arena.savedId), err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  assert(id, `Save after gateway restart failed without reload: "${err}"`);
  return { id, staleError: err || null };
}, { expectHttp: [/403 .*\/api\/arenas/] });

// ------------------------------------------------------------------ R11 idle restart → Run without reload → gateway-only SIGTERM
let r11 = null, seq = [];
await R.check('8.1b-run', 'After an idle gateway restart, Run preset works without a reload (token refresh on the run path)', async () => {
  gateway('stop', { SIG: 'TERM' }); await sleep(800); gateway('start'); await sleep(1500);
  r11 = await startRun('0'); jobs.detached = r11;
  return { job: r11 };
}, { expectHttp: [/403 .*\/api\/scenarios/, /403 .*\/api\/jobs/] });

await R.check('8.1c', 'Gateway-only SIGTERM (worker survives): job shown detached, never success until its completion receipt exists', async () => {
  if (!r11) return R.blocked('R11 did not start');
  gateway('stop', { SIG: 'TERM' }); await sleep(400);
  const alive = workerPids(r11);
  gateway('start');
  const t0 = Date.now(); let j;
  while (Date.now() - t0 < 120000) {
    j = (await api(page, `/api/jobs?id=${r11}`)).body;
    const receipt = (() => { try { return JSON.parse(execSync(`cat ${j.output_path}/run/result.json 2>/dev/null || true`, { encoding: 'utf8' }) || 'null')?.status ?? null; } catch { return null; } })();
    seq.push({ t: Math.round((Date.now() - t0) / 100) / 10, status: j.status, receipt, workers: workerPids(r11).length });
    if (['completed', 'failed', 'cancelled'].includes(j.status) && !seq.at(-1).workers) break;
    await sleep(500);
  }
  jobs.completedAt = Date.now();
  const bad = seq.filter(x => x.status === 'completed' && x.receipt !== 'completed');
  assert(alive.length > 0, 'worker did not survive SIGTERM of the gateway (cannot test the detached state)');
  assert(!bad.length, `completed shown before a completion receipt: ${JSON.stringify(bad)}`);
  assert(seq.some(x => x.status === 'detached'), `never reported detached: ${JSON.stringify(seq)}`);
  assert(j.status === 'completed', `final ${j.status} ${j.error}`);
  return { job: r11, alive: alive.length, seq: seq.filter((x, i) => i === 0 || x.status !== seq[i - 1].status || x.workers !== seq[i - 1].workers), final: { status: j.status, error: j.error, result: j.result_session_id, teardown_warning: j.teardown_warning } };
}, { expectHttp: downAllow });

await R.check('8.1d', 'A detached job that completes after the restart is replayable right away (no second restart): sessions, GET session, Runs → Replay', async () => {
  if (!r11) return R.blocked('R11 did not start');
  const j = (await api(page, `/api/jobs?id=${r11}`)).body;
  if (j.status !== 'completed') return R.blocked(`job ended ${j.status}`);
  const lag = (Date.now() - jobs.completedAt) / 1000;
  const entry = (await api(page, '/api/sessions')).body.sessions.find(s => s.id === r11);
  const sess = await page.request.get(`${BASE}/api/session?id=${r11}`);
  const row = (await api(page, '/api/runs')).body.runs.find(r => r.id === r11);
  // The page that started the run was never reloaded: what does it show now?
  const openPage = await S(); const shotOpen = await R.shot('detached-open-page');
  await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await sleep(500);
  await page.click('#runs-refresh').catch(() => {}); await sleep(1200);
  const btn = page.locator(`.run-row:has([data-run-select="${r11}"]) [data-open-session]`);
  const hasBtn = await btn.count();
  if (hasBtn) { await btn.click(); await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'replay' && document.querySelector('#loading-overlay').hidden, r11, { timeout: 60000 }).catch(() => {}); } // the stale partial-live session has the same id: wait for the recording itself
  const opened = await page.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode })), banner = await page.locator('#error-banner').isVisible() ? await page.locator('#error-banner').textContent() : '';
  const shot = await R.shot('detached-replay');
  jobs.detachedOpenPage = openPage;
  assert(entry && sess.status() === 200 && row?.replayable && hasBtn && opened.id === r11 && opened.mode === 'replay' && !banner,
    `completed ${lag.toFixed(1)} s ago: sessions entry ${!!entry}, GET session ${sess.status()}, row replayable ${row?.replayable}, Replay button ${hasBtn}, opened ${JSON.stringify(opened)}, banner "${banner}"`);
  return { lag_s: lag, entry: entry && { label: entry.label, status: entry.status, outcome: entry.outcome }, openPage, shotOpen, shot };
});

await R.check('8.1e', 'The page that was open across the gateway-only restart follows the detached run to its recording (no reload)', async () => {
  const o = jobs.detachedOpenPage; if (!o) return R.blocked('8.1d did not run');
  assert(o.id === r11 && o.mode === 'replay' && /REPLAY · CPU REHEARSAL/.test(o.badge), `open page after the detached run completed: ${JSON.stringify(o)}`);
  return o;
});

await R.check('B.order', 'Runs ordering newest first after gateway restarts (API and UI)', async () => {
  const rows = (await api(page, '/api/runs')).body.runs;
  const ts = rows.map(r => r.started_unix_s ?? 0);
  const sorted = ts.every((t, i) => i === 0 || ts[i - 1] >= t);
  await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await page.selectOption('#runs-map', ''); await page.selectOption('#runs-policy', ''); await page.selectOption('#runs-outcome', ''); await sleep(500);
  const ui = await page.locator('[data-run-select]').evaluateAll(x => x.map(i => i.dataset.runSelect));
  assert(sorted && JSON.stringify(ui) === JSON.stringify(rows.map(r => r.id)) && rows[0].id === r11, `api order sorted ${sorted}; first ${rows[0]?.id} (newest ${r11}); ui ${JSON.stringify(ui.slice(0, 4))} vs api ${JSON.stringify(rows.slice(0, 4).map(r => r.id))}`);
  return { n: rows.length, first: rows.slice(0, 4).map(r => [r.id, r.started_unix_s]) };
});

await R.save({ jobs, seq });
const prior = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json'));
await writeFile(path.join(EVIDENCE, 'rehearse-jobs.json'), JSON.stringify({ ...prior, jobs: { ...prior.jobs, reload: jobs.reload, killed: jobs.killed, detached: jobs.detached } }, null, 1));
await browser.close();
