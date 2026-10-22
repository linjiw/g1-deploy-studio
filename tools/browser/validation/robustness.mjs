// Section 8: restart recovery, reload in Replay, forwarded tunnel, mobile layout, arena limit.
// Launches 2 short runs and restarts ONLY the validation gateway (port 8792, own data root).
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/robustness.mjs
import { execFileSync, execSync } from 'node:child_process';
import net from 'node:net';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, api, sleep, ready } from './harness.mjs';

const GW = path.resolve(path.dirname(new URL(import.meta.url).pathname), 'gateway.sh');
const gateway = (cmd, env = {}) => execFileSync(GW, [cmd], { env: { ...process.env, ...env }, encoding: 'utf8' }).trim();
const workerPids = job => { try { return execSync(`pgrep -f -- "--output .*${job}/run"`, { encoding: 'utf8' }).trim().split('\n').filter(Boolean); } catch { return []; } };
const { browser, context } = await launch();
let page = await context.newPage();
const R = recorder(process.env.ONLY ? 'robustness-b' : 'robustness');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const check0 = R.check; R.check = (id, ...rest) => (!ONLY || ONLY.has(id)) ? check0(id, ...rest) : null;
R.watch(page);
const S = () => page.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length, badge: document.querySelector('#mode-badge').textContent, playback: document.querySelector('#playback-state').textContent }));
async function setNum(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
async function boot(url = `${BASE}/`) { await page.goto(url); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 }); }
async function rehearseRun(preset = '0', duration = 3) {
  await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-map');
  const arena = (await api(page, '/api/workbench')).body.maps.find(m => m.label === 'Validation rehearse doorway')?.id ?? 'flow-detour';
  await page.selectOption('#rh-map', arena); await sleep(500);
  await page.check('input[name=policy][value="flow-bundle-20261008"]'); await page.click('[data-budget="2,4"]');
  await setNum('rh-duration', duration); await page.selectOption('#rh-preset', preset); await page.selectOption('#rh-latency', '0');
  const prev = await page.evaluate(() => window.__studio.rehearse.job?.id ?? null);
  await page.click('#rh-run');
  await page.waitForFunction(prev => window.__studio.rehearse.job?.id && window.__studio.rehearse.job.id !== prev, prev, { timeout: 60000 });
  const id = await page.evaluate(() => window.__studio.rehearse.job.id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation' && window.__studio.state.session.frames.length > 5, id, { timeout: 180000, polling: 200 });
  return id;
}
const downAllow = [/failed .*127\.0\.0\.1:8792/, /50\d /];

let killedJob = null, sigtermJob = null;
await R.check('8.2a', 'Reload the page mid-run (in Rehearse) re-attaches to the live job', async () => {
  await boot();
  killedJob = await rehearseRun('0', 5);
  await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  await page.waitForFunction(id => window.__studio.rehearse.job?.id === id && window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'simulation', killedJob, { timeout: 30000 });
  const a = await S(); await sleep(2000); const b = await S();
  const job = (await api(page, `/api/jobs?id=${killedJob}&light=1`)).body;
  const shot = await R.shot('reload-in-rehearse');
  assert(b.frames > a.frames && /\blive\b/i.test(b.badge), `re-attach frames ${a.frames} → ${b.frames} badge ${b.badge} job ${job.status}`);
  return { a, b, status: job.status, shot };
});

await R.check('8.2b', 'Reload while in Replay during a live run keeps the live view updating', async () => {
  const st = (await api(page, `/api/jobs?id=${killedJob}&light=1`)).body.status;
  if (st !== 'running') return R.blocked(`run already ${st}`);
  await page.click('#workspace-replay'); await sleep(300);
  await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  const a = await S(); await sleep(2500); const b = await S();
  const shot = await R.shot('reload-in-replay');
  assert(a.id === killedJob, `reload did not reopen the live job: ${JSON.stringify(a)}`);
  assert(b.frames > a.frames, `live view frozen after reload in Replay: frames ${a.frames} → ${b.frames} (${b.badge}, ${b.playback}); rehearse polling only starts in the Rehearse workspace`);
  return { a, b, shot };
});

await R.check('8.1', 'Restart the gateway (and its worker, as systemd does) mid-run → job recovered as failed with a reason, never success', async () => {
  // Make sure a live run exists (8.2b may have finished it).
  let job = (await api(page, `/api/jobs?id=${killedJob}&light=1`)).body;
  if (!['running', 'starting'].includes(job?.status)) { await boot(); killedJob = await rehearseRun('1', 3); }
  await page.click('#workspace-rehearse'); await sleep(500);
  const pids = workerPids(killedJob);
  gateway('stop', { SIG: 'TERM' }); for (const p of pids) { try { process.kill(Number(p), 'SIGTERM'); } catch { /* gone */ } }
  await sleep(2500);
  const during = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  const shotDown = await R.shot('gateway-down');
  gateway('start');
  await sleep(3000);
  job = (await api(page, `/api/jobs?id=${killedJob}`)).body;
  // The open page keeps polling and should pick up the recovered state.
  await page.waitForFunction(id => { const j = window.__studio.rehearse.job; return j?.id === id && !['running', 'starting', 'cancelling'].includes(j.status); }, killedJob, { timeout: 30000 }).catch(() => {});
  const ui = await page.evaluate(() => ({ status: window.__studio.rehearse.job?.status, error: window.__studio.rehearse.job?.error, text: document.getElementById('rh-job')?.textContent }));
  const runs = (await api(page, '/api/runs')).body.runs, row = runs.find(r => r.id === killedJob);
  const sessions = (await api(page, '/api/sessions')).body.sessions, entry = sessions.find(s => s.id === killedJob);
  const shot = await R.shot('gateway-recovered');
  assert(job.status === 'failed' && /interrupt|ownership/i.test(job.error ?? ''), `recovered job ${job.status}: ${job.error}`);
  assert(ui.status === 'failed' && !/Goal reached/.test(ui.text ?? ''), `UI ${JSON.stringify(ui).slice(0, 300)}`);
  assert(!row || (row.outcome !== 'goal_completion' && row.status === 'failed'), `runs row ${JSON.stringify(row)?.slice(0, 200)}`);
  assert(!entry || entry.outcome !== 'goal_completion', 'session listing');
  return { job: killedJob, pids, error: job.error, during, ui: { status: ui.status, error: ui.error }, row: row && { status: row.status, outcome: row.outcome }, entry, shotDown, shot };
}, { expectHttp: downAllow });

await R.check('8.1b', 'After a gateway restart the open page can still POST (CSRF token refreshed) without a reload', async () => {
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  await page.selectOption('#arena-base', 'tpl:corridor');
  await page.fill('#arena-label', 'Validation after restart'); await page.locator('#arena-label').dispatchEvent('input');
  await page.click('#arena-save'); await sleep(1500);
  const id = await page.evaluate(() => window.__studio.arena.savedId), err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  assert(id, `Save after gateway restart failed without reload: "${err}"`);
  return { id };
}, { expectHttp: [/403 .*\/api\/arenas/] });

await R.check('8.1c', 'Plain SIGTERM of the gateway only (worker survives): job shown detached, never success until its completion receipt exists', async () => {
  await boot();
  const job = await rehearseRun('2', 5);
  gateway('stop', { SIG: 'TERM' }); await sleep(500);
  const alive = workerPids(job);
  gateway('start');
  const seq = []; const t0 = Date.now(); let j;
  while (Date.now() - t0 < 120000) {
    j = (await api(page, `/api/jobs?id=${job}`)).body;
    const receipt = (() => { try { return JSON.parse(execSync(`cat ${j.output_path}/run/result.json 2>/dev/null || true`, { encoding: 'utf8' }) || 'null')?.status ?? null; } catch { return null; } })();
    const workers = workerPids(job).length;
    seq.push({ t: Math.round((Date.now() - t0) / 100) / 10, status: j.status, receipt, workers });
    if (['completed', 'failed', 'cancelled'].includes(j.status) && !workers) break;
    await sleep(1000);
  }
  const bad = seq.filter(x => x.status === 'completed' && x.receipt !== 'completed');
  sigtermJob = job;
  assert(alive.length > 0, 'worker did not survive SIGTERM of the gateway (cannot test detached state)');
  assert(!bad.length, `completed shown before a completion receipt: ${JSON.stringify(bad)}`);
  assert(seq.some(x => x.status === 'detached'), `never reported detached: ${JSON.stringify(seq)}`);
  return { job, workerAliveAfterStop: alive.length, seq: seq.filter((x, i) => i === 0 || x.status !== seq[i - 1].status || x.workers !== seq[i - 1].workers), final: { status: j.status, error: j.error, result: j.result_session_id } };
}, { expectHttp: downAllow });

await R.check('8.1d', 'A detached job that completes after the restart is replayable (Runs → Replay opens it)', async () => {
  if (!sigtermJob) return R.blocked('8.1c did not run');
  const j = (await api(page, `/api/jobs?id=${sigtermJob}`)).body;
  if (j.status !== 'completed') return R.blocked(`job ended ${j.status}`);
  const sessions = (await api(page, '/api/sessions')).body.sessions, entry = sessions.find(s => s.id === sigtermJob);
  const sess = await page.request.get(`${BASE}/api/session?id=${sigtermJob}`);
  const row = (await api(page, '/api/runs')).body.runs.find(r => r.id === sigtermJob);
  await boot(); await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await sleep(800);
  await page.click(`.run-row:has([data-run-select="${sigtermJob}"]) [data-open-session]`); await sleep(3000);
  const opened = await page.evaluate(() => window.__studio.state.sessionId), banner = await page.locator('#error-banner').isVisible() ? await page.locator('#error-banner').textContent() : '';
  const shot = await R.shot('detached-replay');
  assert(entry && sess.status() === 200 && opened === sigtermJob, `job ${sigtermJob}: completed with result_session_id=${j.result_session_id}, Runs row replayable=${row?.replayable}, but /api/sessions lists it: ${!!entry}, GET /api/session → ${sess.status()}, Replay opened ${opened} (banner: "${banner}")`);
  return { entry, shot };
}, { expectHttp: [/404 .*\/api\/session\?id=/] });

// ------------------------------------------------------------------ forwarded tunnel
await R.check('8.3', 'UI through a Host-preserving TCP tunnel (localhost:<other port>)', async () => {
  const backend = new URL(BASE), sockets = new Set();
  const proxy = net.createServer(c => { const u = net.connect({ host: backend.hostname, port: Number(backend.port) }); for (const s of [c, u]) { sockets.add(s); s.on('close', () => sockets.delete(s)); s.on('error', () => { c.destroy(); u.destroy(); }); } c.pipe(u).pipe(c); });
  await new Promise(r => proxy.listen(0, '127.0.0.1', r));
  const url = `http://localhost:${proxy.address().port}`;
  const p2 = await context.newPage(); R.watch(p2);
  try {
    await p2.goto(`${url}/?session=sonic-lockstep`); await ready(p2, 'sonic-lockstep');
    const build = await p2.locator('#build-info').textContent();
    await p2.click('#workspace-arena'); await p2.waitForSelector('#arena-base');
    await p2.selectOption('#arena-base', 'tpl:doorway'); await p2.fill('#arena-label', 'Validation via tunnel'); await p2.locator('#arena-label').dispatchEvent('input'); await p2.locator('#arena-label').dispatchEvent('change'); await sleep(200); // blur first (v0.3 N1)
    await p2.click('#arena-save'); await p2.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 15000 });
    const foreign = await p2.request.get(`${url}/api/version`, { headers: { Host: 'evil.example:80' } });
    await p2.screenshot({ path: path.join(EVIDENCE, 'robustness-tunnel.png') });
    assert(/build [0-9a-f]{7}/.test(build) && foreign.status() === 403, `tunnel build ${build} foreign host ${foreign.status()}`);
    return { url, build, foreignHost: foreign.status() };
  } finally { R.use(page); await p2.close(); for (const s of sockets) s.destroy(); await new Promise(r => proxy.close(r)); }
}, { expectHttp: [/403 .*\/api\/version/] });

// ------------------------------------------------------------------ mobile
await R.check('8.4', 'Mobile 390×844: no horizontal scroll; core controls reachable in every workspace', async () => {
  const m = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true });
  const p = await m.newPage(); R.watch(p);
  const out = {};
  try {
    await p.goto(`${BASE}/?session=sonic-lockstep`); await ready(p, 'sonic-lockstep');
    for (const ws of ['replay', 'arena', 'rehearse', 'runs', 'sensors', 'system']) {
      await p.click(`#workspace-${ws}`); await sleep(900);
      const r = await p.evaluate(() => {
        const vis = id => { const n = document.getElementById(id); if (!n) return null; const b = n.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), x: Math.round(b.x), right: Math.round(b.right) }; };
        const overflow = [...document.querySelectorAll('body *')].filter(n => { const b = n.getBoundingClientRect(); return b.width > 0 && b.right > innerWidth + 2 && getComputedStyle(n).position !== 'fixed'; }).slice(0, 5).map(n => `${n.tagName.toLowerCase()}#${n.id}.${[...n.classList].join('.')}`);
        return { scrollW: document.documentElement.scrollWidth, innerW: innerWidth, play: vis('play'), picker: vis('session-picker'), rail: vis(`workspace-system`), overflow };
      });
      await p.screenshot({ path: path.join(EVIDENCE, `robustness-mobile-${ws}.png`), fullPage: true });
      out[ws] = r;
    }
    await p.click('#workspace-replay'); await sleep(300);
    await p.locator('#play').scrollIntoViewIfNeeded(); await p.locator('#play').tap(); await sleep(400);
    const playing = await p.evaluate(() => window.__studio.state.playing); await p.locator('#play').tap();
    await p.click('#workspace-arena'); await sleep(400); await p.locator('#arena-save').scrollIntoViewIfNeeded();
    const saveVisible = await p.locator('#arena-save').isVisible();
    const bad = Object.entries(out).filter(([, r]) => r.scrollW > r.innerW + 1);
    assert(!bad.length, `horizontal scroll: ${bad.map(([k, r]) => `${k} ${r.scrollW}>${r.innerW} ${r.overflow.join(' ')}`).join('; ')}`);
    assert(playing && saveVisible && out.replay.play?.w > 0 && out.replay.picker?.w > 0 && out.replay.rail?.w > 0, `controls ${JSON.stringify(out.replay)} playing ${playing} save ${saveVisible}`);
    return out;
  } finally { R.use(page); await m.close(); }
});

// ------------------------------------------------------------------ arena limit (last: fills the validation data root)
await R.check('3.19', '64-arena limit: Save shows the limit message', async () => {
  await boot(); await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  const wb = (await api(page, '/api/workbench')).body;
  const have = wb.maps.filter(m => m.id.startsWith('arena-')).length;
  const token = wb.csrf_token;
  const doc = { kind: 'boxes', frame_id: 'world', units: 'm', label: 'Validation filler', boxes: [], presets: [{ label: 'p', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [2, 0] }] };
  let made = 0;
  for (let i = have; i < 64; i++) { const r = await page.request.post(`${BASE}/api/arenas`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data: { ...doc, label: `Validation filler ${i}` } }); if (r.status() === 201) made++; else break; }
  await page.selectOption('#arena-base', 'tpl:slalom'); await page.fill('#arena-label', 'Validation 65th'); await page.locator('#arena-label').dispatchEvent('input');
  await page.evaluate(() => window.__studio.setWorkspace('arena'));
  await page.click('#arena-save'); await sleep(1200);
  const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  assert(/Arena limit reached \(64\)/.test(err) && !(await page.evaluate(() => window.__studio.arena.savedId)), `65th save: "${err}"`);
  return { had: have, made, err, shot: await R.shot('arena-limit') };
}, { expectHttp: [/422 .*\/api\/arenas/] });

await R.save({ killedJob });
await browser.close();
