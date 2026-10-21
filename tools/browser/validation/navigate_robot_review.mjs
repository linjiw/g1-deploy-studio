// Navigate robot link, the review's hazards (evidence/review-navigate-20261021): what the operator sees when the node
// holds a goal Studio did not verify, when the node's odometry frame differs from LIO, when a stand is deferred, when the
// runner's joints are missing, and when a goal cannot be checked. Against tools/fake_node.py (a protocol fixture).
// The gateway must be started with STUDIO_ROBOT_LINK=<CONFIG>; this script rewrites that file between sessions.
//   ROBOT_LINK_CONFIG=... FIXTURE_PORTS=... STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/navigate_robot_review.mjs
import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { BASE, launch, recorder, assert, sleep } from './harness.mjs';

const ROOT = new URL('../../../', import.meta.url).pathname;
const CONFIG = process.env.ROBOT_LINK_CONFIG;
const [odomPort, posePort, debugPort, controlPort] = (process.env.FIXTURE_PORTS ?? '15561,15556,15557,15562').split(',');
const ep = port => `tcp://127.0.0.1:${port}`;
let fixture = null;
async function session({ fixtureArgs = [], endpoints = {} } = {}) {
  if (fixture) { fixture.kill('SIGKILL'); await sleep(800); }
  await writeFile(CONFIG, JSON.stringify({ label: 'review fixture', endpoints: { odom: ep(odomPort), cloud: ep(odomPort), pose: ep(posePort), debug: ep(debugPort), control: ep(controlPort), ...endpoints } }));
  fixture = spawn(`${ROOT}.venv/bin/python`, ['-B', `${ROOT}tools/fake_node.py`, '--odom-bind', ep(odomPort), '--pose-bind', ep(posePort),
    '--debug-bind', ep(debugPort), '--control-bind', ep(controlPort), '--arena', 'demo', ...fixtureArgs], { cwd: ROOT, stdio: 'ignore' });
  await sleep(1500);
}
const press = key => new Promise(resolve => spawn(`${ROOT}.venv/bin/python`, ['-B', `${ROOT}tools/fake_node.py`, '--press', key, '--control-connect', ep(controlPort)], { cwd: ROOT, stdio: 'ignore' }).on('exit', resolve));

const R = recorder('navigate-robot-review');
const { browser, context } = await launch();
const page = await context.newPage();
R.watch(page);
const nav = () => page.evaluate(() => { const n = window.__studio.navigate; return { job: n.job?.id, status: n.job?.status, nav: n.job?.latest?.navigation ?? null, notice: n.notice, pick: n.pick }; });
async function waitNav(predicate, timeout = 60000, what = 'condition') {
  const deadline = Date.now() + timeout; let last;
  while (Date.now() < deadline) { last = await nav(); if (predicate(last)) return last; await sleep(300); }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ phase: last?.nav?.phase, notice: last?.notice, reasons: last?.nav?.can_reasons }).slice(0, 500)}`);
}
async function clickWorld(x, y) {
  const [ndc] = await page.evaluate(p => window.__studio.projectWorld([p]), [x, y, 0]);
  const box = await page.locator('#viewport canvas').first().boundingBox();
  await page.mouse.click(box.x + (ndc[0] + 1) / 2 * box.width, box.y + (1 - ndc[1]) / 2 * box.height);
}
// A failed check must not leave its session running into the next one. Cleanup goes through the HTTP API, never by
// navigating the page away mid-load (aborted mesh fetches would read as console errors).
async function endAny() {
  const api = page.request;
  const token = (await (await api.get(`${BASE}/api/workbench`)).json()).csrf_token;
  const busy = async () => ((await (await api.get(`${BASE}/api/jobs`)).json()).jobs ?? []).filter(j => ['starting', 'running', 'detached', 'cancelling'].includes(j.status));
  for (const j of (await busy()).filter(j => ['robot', 'navigation'].includes(j.kind)))
    await api.post(`${BASE}/api/nav/command`, { headers: { 'X-Studio-Token': token, Origin: BASE }, data: { id: j.id, cmd: 'end' } });
  const deadline = Date.now() + 60000;
  while ((await busy()).length && Date.now() < deadline) await sleep(500);
}
async function connect() {
  await endAny();
  await page.goto(`${BASE}/?workspace=navigate`);
  await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  await page.waitForSelector('[data-robot="real"]', { timeout: 60000 });
  await page.click('[data-robot="real"]');
  await page.waitForSelector('#nav-connect', { timeout: 15000 });
  await page.click('#nav-connect');
  return waitNav(s => s.nav?.phase === 'WAIT' && s.nav.ready, 60000, 'connected');
}
async function end() {
  await page.click('#nav-end');
  await waitNav(s => s.status === 'completed', 60000, 'ended');
}
const panel = () => page.locator('#nav-live').innerText();
const ready = (s, id) => s.nav.ready.find(r => r.id === id);
// Stage a goal through the UI and wait for the link's reply to it.
async function stage(x, y) {
  // The link takes a goal only once the robot has been still for 0.5 s: wait for that before clicking.
  await waitNav(s => s.nav?.can?.goal, 30000, 'goal allowed (robot still)');
  await clickWorld(x, y);
  await waitNav(s => s.pick?.check?.ok === true, 20000, 'a passing check');
  await waitNav(s => s.nav?.can?.goal, 20000, 'goal allowed (robot still)');
  const before = (await nav()).nav.commands?.length ?? 0;
  await page.click('#nav-send');
  return waitNav(s => (s.nav?.commands?.length ?? 0) > before && !['pending', 'sent'].includes(s.nav.commands.at(-1).status), 20000, 'goal reply');
}

if (!CONFIG) throw new Error('set ROBOT_LINK_CONFIG to the file the gateway reads (STUDIO_ROBOT_LINK)');

await R.check('RV1', "The node's launch goal is shown as NOT FROM STUDIO, in red, and the pre-Go list says do not press g", async () => {
  await session({ fixtureArgs: ['--goal', '2', '0'] });
  const s = await connect();
  assert(s.nav.goal?.verification === 'external', `verification ${s.nav.goal?.verification}`);
  assert(ready(s, 'goal_verified')?.status === 'block' && s.nav.ready_ok === false, JSON.stringify(s.nav.ready));
  await sleep(800);
  const text = await panel();
  assert(/NOT FROM STUDIO/.test(text) && /launch goal/i.test(text) && /do not press g/i.test(text), text.slice(0, 600));
  await R.shot('launch-goal');
  await end();
  return { warning: s.nav.goal_warning };
});

await R.check('RV2', 'A readback that does not match: the node goal is UNVERIFIED, the warning persists across a reload, and a Go walks it as unverified', async () => {
  await session({ fixtureArgs: ['--goal-error-m', '0.3', '0'] });
  await connect();
  const s = await stage(1.5, 0.3);
  const reply = s.nav.commands.at(-1);
  assert(reply.status === 'rejected' && /keeps|holds/i.test(reply.reason), JSON.stringify(reply));
  const w = await waitNav(s => s.nav.goal?.verification === 'unverified' && s.nav.goal_warning, 10000, 'unverified');
  await page.reload();
  await page.waitForFunction(() => window.__studio?.navigate?.job?.latest?.navigation?.goal_warning, null, { timeout: 60000 });
  await sleep(1000);
  const text = await panel();
  assert(/UNVERIFIED/.test(text) && /do not press g/i.test(text), `after reload: ${text.slice(0, 500)}`);
  await R.shot('unverified');
  assert(await press('go') === 0, 'fixture key');
  const walked = await waitNav(s => (s.nav.legs ?? []).some(l => l.outcome), 60000, 'walk end');
  const leg = walked.nav.legs.find(l => l.outcome);
  assert(leg.goal_source === 'unverified' && leg.staged_seq == null, JSON.stringify(leg));
  await end();
  return { warning: w.nav.goal_warning, leg: { index: leg.index, goal_source: leg.goal_source } };
});

await R.check('RV3', "The node's odometry differs from LIO: goals are refused with the reason, and the frame item blocks", async () => {
  await session({ fixtureArgs: ['--odom-offset', '0.5', '0'] });
  const s = await connect();
  const frame = ready(s, 'frame');
  assert(frame?.status === 'block' && !s.nav.can.goal, JSON.stringify({ frame, can: s.nav.can }));
  assert(/odom zmq|LIO/i.test(s.nav.can_reasons?.goal ?? ''), s.nav.can_reasons?.goal);
  await sleep(800);
  const text = await panel();
  assert(/frame/i.test(text), 'frame reason visible');
  await R.shot('frame-mismatch');
  await end();
  return { reason: s.nav.can_reasons.goal };
});

await R.check('RV4', 'A deferred stand on the robot is shown in red, with the phase saying so, and the pre-Go list blocks', async () => {
  await session({ fixtureArgs: ['--defer-stand', '6'] });
  await connect();
  await stage(2.4, 0.2);
  assert(await press('go') === 0, 'fixture key');
  await waitNav(s => s.nav.phase === 'RUN' && s.nav.can.stand, 20000, 'walking');
  await page.click('#nav-stand');
  const s = await waitNav(s => s.nav.pending_stand, 20000, 'deferred');
  await sleep(800);
  const text = await panel();
  assert(/stand deferred/i.test(text) && /deferring its stand/i.test(text), text.slice(0, 600));
  assert(ready(s, 'stand')?.status === 'block', JSON.stringify(ready(s, 'stand')));
  await R.shot('deferred');
  await waitNav(s => !s.nav.pending_stand, 30000, 'deferral cleared');
  await end();
  return { pending: s.nav.pending_stand };
});

await R.check('RV5', "Without the runner's joints the robot is drawn from its LIO pose, never \"World pose was not captured\"", async () => {
  await session({ endpoints: { debug: null } });
  await writeFile(CONFIG, JSON.stringify({ label: 'review fixture', endpoints: { odom: ep(odomPort), cloud: ep(odomPort), pose: ep(posePort), control: ep(controlPort) } }));
  await connect();
  await sleep(2500);
  const view = await page.evaluate(async () => {
    const { view } = await import('/js/scene.js');
    return { marker: !!view.rootMarker?.visible, robot: !!view.robot?.root.visible, unavailable: !document.querySelector('#scene-unavailable').hidden,
      badge: document.querySelector('#source-badge').textContent, frames: window.__studio.state.session?.frames?.length };
  });
  assert(view.marker && !view.unavailable && /LIO ESTIMATE/.test(view.badge), JSON.stringify(view));
  await R.shot('no-joints');
  await end();
  return view;
});

await R.check('RV6', 'Fail closed: a goal past the test distance and a goal with no map are refused before the robot link', async () => {
  await session();
  await connect();
  await sleep(2000);
  await clickWorld(4.3, -0.6);
  const far = await waitNav(s => s.pick?.check, 20000, 'check');
  const distance = far.pick.check.checks.find(c => c.id === 'distance');
  assert(!far.pick.check.ok && distance.status === 'block', JSON.stringify(distance));
  assert(await page.locator('#nav-send').isDisabled(), 'Send enabled for a far goal');
  await end();
  // No cloud endpoint: no map can exist, so no goal can be checked or sent.
  await writeFile(CONFIG, JSON.stringify({ label: 'review fixture', endpoints: { odom: ep(odomPort), pose: ep(posePort), debug: ep(debugPort), control: ep(controlPort) } }));
  await connect();
  const id = (await nav()).job;
  const refused = await page.evaluate(async ({ id }) => {
    const wb = await (await fetch('/api/workbench')).json();
    const r = await fetch('/api/nav/command', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': wb.csrf_token }, body: JSON.stringify({ id, cmd: 'goal', xy: [1.0, 0.0] }) });
    return { status: r.status, body: await r.json() };
  }, { id });
  assert(refused.status === 422 && /could not be checked|not sent/i.test(refused.body.error), JSON.stringify(refused));
  await end();
  return { far: distance.detail, nomap: refused.body.error };
}, { expectHttp: [/422 .*\/api\/nav\/(command|check)/] });

if (fixture) fixture.kill('SIGTERM');
await R.save({});
await browser.close();
