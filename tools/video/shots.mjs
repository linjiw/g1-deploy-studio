// App shots for tools/video/capture.mjs. Each shot drives the real Studio UI; `h` captures frames.
// Read-only shots use APP (the release gateway); `arena` and `rehearse` mutate only the DEMO gateway.
export const DEMO_RUN = 'job-47d39564736b';      // WX-RF doorway demo on the main workbench (goal at 5.92 s)

async function boot(page, base, query = '') {
  await page.goto(`${base}/${query}`);
  await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 180000 });
  await page.waitForTimeout(600);
}
async function open(page, id) {
  await page.evaluate(id => window.__studio.loadSession(id), id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && document.querySelector('#loading-overlay').hidden, id, { timeout: 120000 });
  await page.waitForTimeout(500);
}
const robotRect = async (page, w = 260, h = 420) => {
  const p = await page.evaluate(() => { const f = window.__studio.state.measuredFrame?.position; return f ? window.__studio.projectWorld([[f[0], f[1], 0.75]])[0] : null; });
  if (!p) return null;
  const vp = await page.locator('#viewport').boundingBox();
  const x = vp.x + (p[0] + 1) / 2 * vp.width, y = vp.y + (1 - p[1]) / 2 * vp.height;
  return [x - w / 2, y - h / 2, w, h];
};

// Navigate shots: world -> screen for clicks on the map; time-lapse while the simulated robot walks.
async function worldPoint(page, x, y) {
  const [ndc] = await page.evaluate(p => window.__studio.projectWorld([p]), [x, y, 0]);
  const vp = await page.locator('#viewport').boundingBox();
  return [vp.x + (ndc[0] + 1) / 2 * vp.width, vp.y + (1 - ndc[1]) / 2 * vp.height];
}
// Click the map where a world point is drawn and place the goal at exactly that point (a pixel click rounds to
// about 1 cm, and the quick planner's walk through a doorway depends on the exact goal).
async function pickAt(page, h, x, y) {
  await h.click(await worldPoint(page, x, y), { real: false, after: 0 });
  await page.evaluate(xy => window.__studio.pickGoal(xy), [x, y]);
  await h.hold(0.2);
}
const navState = page => page.evaluate(() => window.__studio.navigate.job?.latest?.navigation ?? null);
async function timelapse(page, h, done, { maxFrames = 150, wallMs = 150 } = {}) {
  for (let i = 0; i < maxFrames; i++) {
    await h.frame(1);
    if (await page.evaluate(done)) return true;
    await page.waitForTimeout(wallMs);
  }
  return false;
}
// A shot starts from the setup panel: end any session a failed earlier capture left running on the demo gateway.
async function endSessions(page, base) {
  const api = page.request;
  const token = (await (await api.get(`${base}/api/workbench`)).json()).csrf_token;
  const busy = async () => ((await (await api.get(`${base}/api/jobs`)).json()).jobs ?? []).filter(j => ['robot', 'navigation'].includes(j.kind) && ['starting', 'running', 'detached'].includes(j.status));
  for (const j of await busy()) await api.post(`${base}/api/nav/command`, { headers: { 'X-Studio-Token': token, Origin: base }, data: { id: j.id, cmd: 'end' } });
  for (let i = 0; i < 120 && (await busy()).length; i++) await page.waitForTimeout(500);
}
const walkEnded = () => { const n = window.__studio.navigate.job?.latest?.navigation; return !!(n?.paused && n.legs?.length && n.legs.at(-1).outcome); };
// The robot-link shot runs tools/fake_node.py (a protocol fixture, not a robot) on these loopback ports;
// the demo gateway must be started with STUDIO_ROBOT_LINK pointing at a matching config.
export const FIXTURE_PORTS = { odom: 18561, pose: 18556, debug: 18557, control: 18562 };

export const SHOTS = {
  async replay({ page, h, APP }) {
    await boot(page, APP, `?session=${DEMO_RUN}&camera=follow`);
    await h.ready();
    await page.evaluate(() => { window.__studio.cameraView('follow', true); window.__studio.seek(0.4); });
    await h.settle(800);
    await h.caption('Replay · digital twin', 'WX-RF on an offset doorway — CPU rehearsal, simulator ground truth');
    await h.hold(1.4);
    await h.play(0.4, 2.4, 4.0);
    const r = await robotRect(page);
    if (r) { await h.spotRect(r, 'white: simulator state · cyan: SONIC reference · amber: plan', { dim: false }); }
    await h.play(2.4, 3.4, 3.0);
    await h.clearSpots();
    await h.spot('#hud', 'HUD at the cursor', { dim: false });
    await h.play(3.4, 4.2, 2.2);
    await h.clearSpots();
    await h.spot('.lanes', 'one clock: goal distance · planner · SONIC · tracking · contact', { dim: false });
    await h.caption('Replay · timeline lanes', 'Every lane shares the run clock; peaks are labelled in place', { pos: 'top' });
    await h.play(4.2, 5.9, 4.6);
    await h.clearSpots();
    await h.hold(1.0);
  },

  async cameras({ page, h, APP }) {
    await boot(page, APP, `?session=${DEMO_RUN}`);
    await h.ready();
    await h.caption('Replay · cameras and layers', 'Follow · Orbit · Top · Fit — layers and the LiDAR-mount robot view');
    await h.seek(3.2);
    await h.click('#camera-orbit', { after: 0.2 });
    await h.orbit(140, 4.0, { t: [3.2, 4.2] });
    await h.click('#camera-top', { after: 1.4 });
    await h.click('#camera-scene', { after: 1.2 });
    await h.click('#layers-button', { after: 0.4 });
    await h.spot('#layers-popover, .layers-popover', 'evidence-styled layers', { dim: false, below: true });
    await h.hold(1.8);
    await h.clearSpots();
    await h.click('#layers-button', { after: 0.2 });
    await h.click('#camera-follow', { after: 0.2 });
    await h.click('#robot-view', { after: 0.4 });
    await h.spot('#robot-view-label', '', { dim: false });
    await h.play(4.2, 5.4, 3.2);
    await h.clearSpots();
    await h.click('#robot-view', { after: 0.6 });
  },

  async inspector({ page, h, APP }) {
    await boot(page, APP, `?session=${DEMO_RUN}&camera=follow&time=3.0`);
    await h.ready();
    await h.seek(3.0);
    await h.caption('Inspector', 'Explains the moment under the cursor — every fact carries its evidence chip');
    for (const [tab, label, secs] of [['intent', 'Intent · navigation target, planner selection, execution check', 3.0],
      ['health', 'Health · outcome, fidelity, budgets, leg torque vs limit', 3.6],
      ['joints', 'Joints · all 29 by name: state, reference, error, PD target', 3.2],
      ['pipeline', 'Pipeline · what crossed each model boundary', 3.4]]) {
      await h.click(`#tab-${tab}`, { after: 0.2 });
      await h.caption('Inspector', label);
      await h.spot('.inspector-content', '', { dim: true });
      await h.hold(secs);
      await h.clearSpots();
    }
  },

  async sensors({ page, h, APP }) {
    await boot(page, APP);
    const runs = (await (await page.request.get(`${APP}/api/runs`)).json()).runs;
    const lidar = runs.find(r => r.policy_id === 'flow-bundle-20261008' && r.replayable && r.outcome === 'goal_completion' && /clutter/.test(r.label));
    await open(page, lidar.id);
    await h.ready();
    await h.seek(2.0);
    await h.caption('Sensors · causal', 'Bundle run with simulated MID-360 LiDAR: each channel has its own timestamp and age');
    await h.click('#workspace-sensors', { after: 1.6 });
    const pin = page.locator('#sensors-panel [data-pin-sensor="lidar_filtered"]:not([disabled])');
    if (await pin.count()) { await h.click('#sensors-panel [data-pin-sensor="lidar_filtered"]', { after: 0.8 }); }
    await h.click('#workspace-replay', { after: 0.4 });
    await page.evaluate(() => window.__studio.cameraView('orbit', true)); await h.settle(600);
    await h.caption('Sensors · pinned point cloud', 'Robot-filtered LiDAR drawn in the scene at its own capture time');
    await h.orbit(60, 2.6, { t: [2.0, 3.2] });
    await open(page, DEMO_RUN);
    await h.seek(3.0);
    await h.click('#workspace-sensors', { after: 0.4 });
    await h.spot('#sensors-panel [data-sensor-card="lidar_raw"]', 'privileged WX block: unavailable by design', { dim: true, below: true });
    await h.caption('Sensors · honest gaps', 'WX plans from the exact boxes — Studio says so instead of drawing an empty map');
    await h.hold(3.0);
    await h.clearSpots();
  },

  async system({ page, h, APP }) {
    await boot(page, APP, `?session=${DEMO_RUN}`);
    await h.ready();
    await h.caption('System · deployment graph', 'DDS · ZMQ · in-process edges — solid = observed, dashed = configured');
    await h.click('#workspace-system', { after: 1.0 });
    await h.spot('#system-map-host', '', { dim: false });
    await h.hold(3.2);
    await h.clearSpots();
    await h.click('#system-stage [data-node="sonic"]', { after: 1.6 });
    await h.caption('System · Unitree G1 contract', 'Source-verified joint order, gains and limits — every disagreement listed');
    const stage = page.locator('#system-stage');
    for (let i = 0; i < 24; i++) { await stage.evaluate((el, i) => { el.scrollTop = i * 34; }, i); await h.frame(); }
    await h.hold(2.6);
  },

  async arena({ page, h, DEMO }) {
    await boot(page, DEMO);
    await h.ready();
    await h.caption('Arena · build a scenario', 'Templates, walls, beams, pillars, start/goal presets — top-down, in metres');
    await h.click('#workspace-arena', { after: 0.6 });
    await page.selectOption('#arena-base', 'tpl:doorway'); await h.settle(500); await h.hold(0.8);
    const canvas = await page.locator('#arena-canvas').boundingBox();
    const at = (fx, fy) => [canvas.x + canvas.width * fx, canvas.y + canvas.height * fy];
    await h.click('[data-arena-tool="wall"]', { after: 0.2 });
    // Drag a wall: visible cursor path, real mouse events.
    const [x1, y1] = at(0.66, 0.22), [x2, y2] = at(0.66, 0.42);
    await h.moveTo([x1, y1], 0.5);
    await page.mouse.move(x1, y1); await page.mouse.down();
    for (let i = 1; i <= 10; i++) { const x = x1 + (x2 - x1) * i / 10, y = y1 + (y2 - y1) * i / 10; await page.mouse.move(x, y); await page.evaluate(([x, y]) => { document.getElementById('vid-cursor').style.transform = `translate(${x - 3}px, ${y - 2}px)`; }, [x, y]); await h.frame(); }
    await page.mouse.up(); await h.settle(300); await h.hold(0.6);
    await h.click('[data-arena-tool="pillar"]', { after: 0.2 });
    await h.click(at(0.42, 0.7), { after: 0.6 });
    await h.click('[data-arena-tool="select"]', { after: 0.2 });
    await h.caption('Arena · footprint preflight', 'The new pillar blocks a preset start — flagged before anything runs');
    await h.spot('#arena-status', 'preflight', { dim: false });
    await h.hold(2.2);
    await h.clearSpots();
    await h.caption('Arena · seeded random goals', '“Behind an obstacle”: the straight line to each goal must cross a box');
    await h.click('.random-goals summary', { after: 0.4 });
    await page.fill('#rg-count', '5'); await page.fill('#rg-seed', '7');
    await h.click('#rg-obstructed', { after: 0.3 });
    await h.click('#rg-generate', { after: 1.6 });
    await h.hold(1.2);
    await page.fill('#arena-label', 'Video demo · doorway + wall');
    await page.locator('#arena-label').dispatchEvent('input');
    await h.click('#arena-save', { after: 1.0 });
    await h.caption('Arena · immutable', 'Saved as a new hashed arena; edits create a new one');
    await h.click('#arena-preview3d', { after: 0.4 });
    await h.orbit(40, 2.0);
    await h.hold(0.8);
  },

  async rehearse({ page, h, DEMO, seconds }) {
    await boot(page, DEMO);
    await h.ready();
    await h.caption('Rehearse · pinned policy profiles', 'Flow research sync · identity hash · budget · criterion · latency · actuator limits');
    await h.click('#workspace-rehearse', { after: 0.8 });
    const demo = await page.evaluate(() => [...document.querySelectorAll('#rh-map option')].find(o => /offset doorway/i.test(o.textContent))?.value);
    if (demo) { await page.selectOption('#rh-map', demo); await h.settle(800); }
    await h.spot('#rehearse-panel .research-sync', 'adopted block', { dim: false });
    await h.hold(1.4); await h.clearSpots();
    const wx = page.locator('input[name=policy][value="flow-wx-rf-23326aa-s0"]');
    if (await wx.count()) await h.click('input[name=policy][value="flow-wx-rf-23326aa-s0"]', { after: 0.4 });
    await h.click('[data-budget="8,6"]', { after: 0.4 });
    await h.spot('#rh-actuators', 'G1 actuator limits per hardware revision', { dim: false });
    await h.hold(1.6); await h.clearSpots();
    await h.spot('#rh-latency', 'planner latency (L2) · anchor', { dim: false });
    await h.hold(1.2); await h.clearSpots();
    await h.click('#rh-run', { after: 0.2 });
    // Live: the worker runs about 7x slower than real time on CPU; record a labelled time-lapse.
    await h.caption('Rehearse · live CPU worker (time-lapse)', 'Flow WX-RF → SONIC ONNX → MuJoCo in an owned, bounded process');
    const t0 = Date.now();
    while (Date.now() - t0 < 240000) {
      await h.frame(2);
      await page.waitForTimeout(700);
      const done = await page.evaluate(() => ['completed', 'failed', 'cancelled'].includes(window.__studio.rehearse.job?.status));
      if (done) break;
    }
    await page.waitForFunction(() => window.__studio.state.session?.metadata?.mode === 'replay', null, { timeout: 60000 }).catch(() => {});
    await h.settle(800);
    await h.caption('Rehearse · recording opened', 'The full recording replaces the live samples at the same moment');
    await h.spot('#rh-job', 'whole-run outcome', { dim: false });
    await h.hold(2.4);
    await h.clearSpots();
  },

  async navigate({ page, h, DEMO }) {
    await endSessions(page, DEMO);
    await boot(page, DEMO, '?workspace=navigate');
    await h.ready();
    await h.waitFor(() => !!document.querySelector('#nav-world'));
    // The original world, not a twin an earlier capture saved from it ("Twin · Studio demo · offset doorway").
    const world = await page.evaluate(() => [...document.querySelectorAll('#nav-world option')].find(o => o.textContent.trim() === 'Studio demo · offset doorway')?.value);
    if (world) { await page.selectOption('#nav-world', world); await h.settle(800); }
    await h.caption('Navigate · a simulated robot', "It follows node.py's rules and knows the world only through its own LiDAR");
    await h.spot('#navigate-panel .nav-robot', 'simulated now · the real robot later, same panel', { dim: false, below: true });
    await h.hold(2.0); await h.clearSpots();
    await h.click('#nav-start-session', { after: 0.2 });
    await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.phase === 'WAIT' && window.__studio.state.session?.metadata?.kind === 'navigation', null, 180000);
    await page.waitForTimeout(2000);
    await h.settle(600);
    await h.caption("Navigate · the robot's own map", 'teal: seen floor · red: obstacle · amber: low step · purple: overhead · never-seen space stays empty');
    await h.hold(3.0);
    await pickAt(page, h, 2.0, 1.3);
    await h.waitFor(() => !!window.__studio.navigate.pick?.check);
    await h.settle(400);
    await h.caption('Navigate · checked before sending', "A goal in a wall is refused, on the robot's map and with the node's own rules");
    await h.spot('.nav-checks', '', { dim: false }); await h.hold(3.0); await h.clearSpots();
    await pickAt(page, h, 3.6, 0.6);
    await h.waitFor(() => window.__studio.navigate.pick?.check?.ok === true);
    await h.settle(400);
    await h.caption('Navigate · a goal behind the doorway', 'Inside the map · seen and free · no low ceiling · a route through what it knows');
    await h.spot('.nav-checks', '', { dim: false }); await h.hold(3.2); await h.clearSpots();
    await h.click('#nav-send', { after: 0.6 });
    await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.can?.go === true);
    await h.click('#nav-go', { after: 0.2 });
    await h.caption('Navigate · walking (time-lapse)', 'Plan, reference and path live · the map grows as it walks');
    await timelapse(page, h, walkEnded, { maxFrames: 120 });
    await h.settle(600);
    await h.caption('Navigate · arrived and standing', 'Simulated time pauses while the robot waits for the next goal');
    await h.spot('.nav-walks', '', { dim: false }); await h.hold(2.6); await h.clearSpots();
  },

  async navigateReview({ page, h, DEMO }) {
    // Continues the live session of the previous shot on the demo gateway.
    await boot(page, DEMO, '?workspace=navigate');
    await h.ready();
    await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.can?.goal === true, null, 120000);
    await page.waitForTimeout(1500); await h.settle(500);
    await h.caption('Navigate · the next goal', 'Farther along; the map keeps everything it has seen');
    await pickAt(page, h, 4.3, 0.1);
    await h.waitFor(() => window.__studio.navigate.pick?.check?.ok === true);
    await h.hold(1.2);
    await h.click('#nav-send', { after: 0.4 });
    await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.can?.go === true);
    await h.click('#nav-go', { after: 0.2 });
    await timelapse(page, h, walkEnded, { maxFrames: 90 });
    await h.settle(400);
    await h.click('#nav-end', { after: 0.2 });
    await h.waitFor(() => window.__studio.state.session?.metadata?.mode === 'replay' && window.__studio.navigate.job?.status === 'completed', null, 120000);
    await h.settle(800);
    await h.caption('Navigate · the session in Replay', 'Every walk, its goal and the timeline lanes, from one recording');
    const duration = await page.evaluate(() => window.__studio.state.session.metadata.duration_s);
    await h.play(0, duration, 4.0);
    await h.click('#nav-twin', { after: 0.2 });
    await h.waitFor(() => !!window.__studio.navigate.notice?.arena, null, 60000);
    await h.settle(400);
    await h.caption('Navigate · scan to twin', "Boxes fitted to the robot's map, saved as a new arena, scored against the true world");
    await h.spot('#nav-live .callout', '', { dim: false }); await h.hold(3.0); await h.clearSpots();
    const arena = await page.evaluate(() => window.__studio.navigate.notice.arena);
    await page.goto(`${DEMO}/sheet.html?arena=${encodeURIComponent(arena)}&preset=0`);
    await page.waitForFunction(() => document.querySelector('svg') && document.body.innerText.includes('ahead'), null, { timeout: 30000 }).catch(() => {});
    await h.ready();
    await h.caption('Build sheet', 'The course measured from a start mark, the console command and the go / no-go list');
    await h.hold(2.4);
    for (let i = 0; i < 30; i++) { await page.evaluate(i => window.scrollTo(0, i * 40), i); await h.frame(); }
    await h.hold(1.2);
  },

  async navigateRobot({ page, h, DEMO }) {
    const { spawn } = await import('node:child_process');
    const root = new URL('../../', import.meta.url).pathname, py = `${root}.venv/bin/python`, ep = p => `tcp://127.0.0.1:${p}`;
    const F = FIXTURE_PORTS;
    const fixture = spawn(py, [`${root}tools/fake_node.py`, '--odom-bind', ep(F.odom), '--pose-bind', ep(F.pose), '--debug-bind', ep(F.debug),
      '--control-bind', ep(F.control), '--arena', 'demo'], { cwd: root, stdio: 'ignore' });
    try {
      await endSessions(page, DEMO);
      await page.waitForTimeout(1500);
      await boot(page, DEMO, '?workspace=navigate');
      await h.ready();
      await h.click('[data-robot="real"]', { after: 0.6 });
      await h.waitFor(() => !!document.querySelector('#nav-connect'), null, 30000);
      await h.caption('Navigate · the real robot', 'On the deploy PC: loopback streams from node.py, the SONIC runner and the LIO bridge');
      await h.spot('#navigate-panel .panel-section', '', { dim: false }); await h.hold(3.0); await h.clearSpots();
      await h.click('#nav-connect', { after: 0.2 });
      await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.phase === 'WAIT' && window.__studio.state.session?.metadata?.recording_kind === 'robot-link', null, 60000);
      await page.waitForTimeout(2500); await h.settle(600);
      await h.caption('Navigate · protocol fixture (not a robot)', 'Pose: the LIO estimate in the odom frame · map: Studio\'s reconstruction from the LiDAR');
      await h.spot('#source-badge', 'LIO ESTIMATE', { dim: false, below: true }); await h.hold(2.6); await h.clearSpots();
      // The link takes a goal once the robot has been still for 0.5 s and the node's frame matches LIO.
      await h.waitFor(() => window.__studio.navigate.job?.latest?.navigation?.can?.goal === true, null, 30000);
      await pickAt(page, h, 2.6, 0.3);
      await h.waitFor(() => window.__studio.navigate.pick?.check?.ok === true, null, 30000);
      await h.waitFor(() => !document.querySelector('#nav-send')?.disabled, null, 30000);
      await h.click('#nav-send', { after: 0.6 });
      await h.waitFor(() => (window.__studio.navigate.job?.latest?.navigation?.commands ?? []).some(c => c.cmd === 'goal' && c.status === 'applied'), null, 30000);
      await h.caption('Navigate · staged on the node', 'Sent as ahead / left while standing, read back within 5 cm · Studio never sends Go');
      await h.spot('.nav-node-goal', 'the node now holds this goal', { dim: false, below: true }); await h.hold(2.2); await h.clearSpots();
      await h.caption('Navigate · before g on the console', 'Status, LIO, frames, a still robot, a verified goal in range, no deferred stand');
      await h.spot('.nav-ready', '', { dim: false }); await h.hold(3.0); await h.clearSpots();
      await new Promise(resolve => spawn(py, [`${root}tools/fake_node.py`, '--press', 'go', '--control-connect', ep(F.control)], { cwd: root, stdio: 'ignore' }).on('exit', resolve));
      await h.caption('Navigate · the operator pressed Go', 'Console g or remote F1 · Studio watches the plan, the LIO pose and every stream');
      await timelapse(page, h, () => ['ARRIVED', 'STOPPED'].includes(window.__studio.navigate.job?.latest?.navigation?.phase), { maxFrames: 90, wallMs: 100 });
      await h.settle(400);
      await h.caption('Navigate · arrived', 'The walk is logged against the verified goal; Stand (not an emergency stop) settles a walk early');
      await h.spot('.nav-walks', '', { dim: false }); await h.hold(2.4); await h.clearSpots();
      await h.click('#nav-end', { after: 1.0 });
    } finally { fixture.kill('SIGTERM'); }
  },

  async runs({ page, h, APP }) {
    await boot(page, APP);
    await h.ready();
    await h.caption('Runs · compare and report', 'Every owned rehearsal, newest first — overlay paths on the arena');
    await h.click('#workspace-runs', { after: 1.0 });
    await page.waitForFunction(() => document.querySelectorAll('#runs-map option').length > 1, null, { timeout: 30000 }).catch(() => {});
    const clutter = await page.evaluate(() => [...document.querySelectorAll('#runs-map option')].find(o => /clutter/i.test(o.textContent))?.value);
    if (clutter) { await page.selectOption('#runs-map', clutter); await h.settle(1000); }
    await h.hold(1.0);
    const all = page.locator('#runs-select-all');
    if (await all.count()) await h.click('#runs-select-all', { after: 1.6 });
    await h.caption('Runs · robustness report', 'Wilson intervals · post-hoc Flow reach · failure categories · torque clamping');
    await h.spot('.report-group', 'per policy · criterion · latency · budget · actuator limits', { dim: false, below: true });
    await h.hold(3.2);
    await h.clearSpots();
    const panel = page.locator('#runs-panel, [data-panel="runs"]').first();
    for (let i = 0; i < 20; i++) { await panel.evaluate((el, i) => { el.scrollTop = i * 40; }, i).catch(() => {}); await h.frame(); }
    await h.hold(2.0);
  },
};
