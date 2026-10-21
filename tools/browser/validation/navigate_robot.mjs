// Navigate with the REAL-ROBOT link against tools/fake_node.py, a loopback protocol fixture (not a robot, not node.py).
// The gateway must be started with STUDIO_ROBOT_LINK pointing at a config whose endpoints are the fixture's ports.
//   FIXTURE_PORTS=15561,15556,15557,15562 STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/navigate_robot.mjs
import { spawn } from 'node:child_process';
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const [odomPort, posePort, debugPort, controlPort] = (process.env.FIXTURE_PORTS ?? '15561,15556,15557,15562').split(',');
const ep = port => `tcp://127.0.0.1:${port}`;
let fixture = null;
function startFixture() {
  fixture = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}tools/fake_node.py`, '--odom-bind', ep(odomPort), '--pose-bind', ep(posePort),
    '--debug-bind', ep(debugPort), '--control-bind', ep(controlPort), '--arena', 'demo'], { cwd: ROOT, stdio: 'ignore' });
}
const press = key => new Promise(resolve => {
  const p = spawn(`${ROOT}.venv/bin/python`, [`${ROOT}tools/fake_node.py`, '--press', key, '--control-connect', ep(controlPort)], { cwd: ROOT, stdio: 'ignore' });
  p.on('exit', code => resolve(code));
});

const R = recorder('navigate-robot');
const { browser, context } = await launch();
const page = await context.newPage();
R.watch(page);
const nav = () => page.evaluate(() => {
  const n = window.__studio.navigate, latest = n.job?.latest ?? {};
  return { job: n.job?.id, status: n.job?.status, kind: n.job?.kind, nav: latest.navigation ?? null, frame: latest.frame ?? null,
    notice: n.notice, pick: n.pick, session: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode,
    recording: window.__studio.state.session?.metadata?.recording_kind };
});
async function waitNav(predicate, timeout = 60000, what = 'condition') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) { last = await nav(); if (predicate(last)) return last; await sleep(300); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ phase: last?.nav?.phase, status: last?.status, notice: last?.notice }).slice(0, 400)}`);
}
async function clickWorld(x, y) {
  const [ndc] = await page.evaluate(p => window.__studio.projectWorld([p]), [x, y, 0]);
  const box = await page.locator('#viewport canvas').first().boundingBox();
  await page.mouse.click(box.x + (ndc[0] + 1) / 2 * box.width, box.y + (1 - ndc[1]) / 2 * box.height);
}

startFixture();
await sleep(1500);
await page.goto(`${BASE}/?workspace=navigate`);
await page.waitForSelector('[data-robot="real"]', { timeout: 60000 });

await R.check('R1', 'Real robot card: the configured loopback endpoints, Connect, and the rule that Go stays with the operator', async () => {
  const status = (await api(page, '/api/nav/robot')).body;
  assert(status.configured, `robot link not configured: ${JSON.stringify(status)}`);
  await page.click('[data-robot="real"]');
  await page.waitForSelector('#nav-connect', { timeout: 15000 });
  const text = await page.locator('#navigate-panel').innerText();
  assert(/never starts a walk/i.test(text) && text.includes(`127.0.0.1:${controlPort}`), text.slice(0, 400));
  await R.shot('card');
  return status.endpoints;
});

await R.check('R2', 'Connect: live LIO pose (estimated, odom frame), streams fresh, no Go button, the map is Studio\'s reconstruction', async () => {
  await page.click('#nav-connect');
  const s = await waitNav(s => s.kind === 'robot' && s.nav?.phase === 'WAIT' && s.session === s.job && s.frame, 60000, 'connected');
  assert(s.frame.classification === 'estimated' && s.frame.frame_id === 'odom', `frame ${s.frame.classification} ${s.frame.frame_id}`);
  const streams = Object.fromEntries(s.nav.streams.map(x => [x.id, x.status]));
  assert(streams.odom === 'fresh' && streams.node_status === 'fresh', JSON.stringify(streams));
  assert(await page.locator('#nav-go').count() === 0, 'a Go button exists in robot mode');
  const text = await page.locator('#nav-live').innerText();
  assert(/g on the node console/.test(text), 'go note');
  assert(/reconstruction/i.test(s.nav.map.label ?? s.nav.map.basis ?? ''), `map basis ${JSON.stringify(s.nav.map)}`);
  const badge = await page.locator('#source-badge').textContent();
  assert(/LIO ESTIMATE/.test(badge), `source badge ${badge}`);
  await sleep(1500);
  await R.shot('connected');
  return { streams, badge: await page.locator('#mode-badge').textContent() };
});

await R.check('R3', 'A goal inside the fixture\'s tall pillar is refused before anything is sent to the node', async () => {
  await sleep(2000);  // let the reconstruction see the pillar
  await clickWorld(2.6, -1.1);
  const s = await waitNav(s => s.pick?.check, 20000, 'check');
  assert(!s.pick.check.ok, `pillar goal not blocked: ${JSON.stringify(s.pick.check.checks)}`);
  assert(await page.locator('#nav-send').isDisabled(), 'Send enabled');
  return s.pick.check.checks.map(c => `${c.id}:${c.status}`);
});

await R.check('R4', 'Send a free goal: the node receives ahead/left and the readback matches within 5 cm', async () => {
  await clickWorld(2.9, 0.4);
  const s0 = await waitNav(s => s.pick?.check && Math.abs(s.pick.xy[0] - 2.9) < 0.15, 20000, 'check');
  assert(s0.pick.check.ok, JSON.stringify(s0.pick.check.checks));
  await page.click('#nav-send');
  const s = await waitNav(s => (s.nav?.commands ?? []).some(c => c.cmd === 'goal' && c.status !== 'pending'), 20000, 'goal reply');
  const reply = s.nav.commands.filter(c => c.cmd === 'goal').at(-1);
  assert(reply.status === 'applied' && /read back/.test(reply.reason), JSON.stringify(reply));
  assert(Math.hypot(s.nav.goal.xy[0] - s0.pick.xy[0], s.nav.goal.xy[1] - s0.pick.xy[1]) < 0.05, 'node goal differs from the click');
  await R.shot('staged');
  return reply;
});

await R.check('R5', 'Go from the API is refused; the operator\'s Go (fixture key) walks; Stand from Studio stops it', async () => {
  const token = await page.evaluate(async () => (await (await fetch('/api/workbench')).json()).csrf_token);
  const id = (await nav()).job;
  const go = await page.evaluate(async ({ id, token }) => {
    const r = await fetch('/api/nav/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token }, body: JSON.stringify({ id, cmd: 'go' }) });
    return r.json();
  }, { id, token });
  const refused = await waitNav(s => s.nav.commands.some(c => c.seq === go.seq && c.status === 'rejected'), 15000, 'go refused');
  assert(refused.nav.phase === 'WAIT', `phase after API go ${refused.nav.phase}`);
  assert(await press('go') === 0, 'fixture key');
  await waitNav(s => s.nav?.phase === 'RUN' && s.nav.can?.stand, 20000, 'walking');
  await page.click('#nav-stand');
  await R.shot('walking');
  const s = await waitNav(s => ['STOPPED', 'ARRIVED'].includes(s.nav?.phase) && s.nav.standing, 30000, 'stand');
  return { phase: s.nav.phase, legs: s.nav.legs };
});

await R.check('R6', 'Robot streams lost: shown stale, goals disabled, the link stays up; the fixture restarts and it recovers', async () => {
  fixture.kill('SIGKILL');
  const lost = await waitNav(s => s.nav?.streams?.some(x => x.id === 'odom' && x.status !== 'fresh'), 20000, 'stale');
  assert(!lost.nav.can.goal, 'goal allowed with stale streams');
  const text = await page.locator('#nav-live').innerText();
  assert(/stale|unavailable/i.test(text), 'stale streams not shown');
  await R.shot('stale');
  startFixture();
  // The pose (plan) stream is quiet while the node is not walking; the others must come back.
  const back = await waitNav(s => s.nav?.streams?.filter(x => x.id !== 'pose').every(x => x.status === 'fresh') && s.nav.can.goal, 30000, 'recovered');
  return { lost: lost.nav.streams.map(x => `${x.id}:${x.status}`), back: back.nav.streams.map(x => `${x.id}:${x.status}`) };
});

await R.check('R7', 'End: Studio stops its link only; the robot session opens in Replay as M5 with the walk', async () => {
  await page.click('#nav-end');
  const s = await waitNav(s => s.status === 'completed' && s.recording === 'robot-link' && s.mode === 'replay', 60000, 'recording');
  const badge = await page.locator('#mode-badge').textContent();
  assert(/ROBOT SESSION · M5/.test(badge), badge);
  await R.shot('replay');
  return { badge };
});

fixture.kill('SIGTERM');
await R.save({});
await browser.close();
