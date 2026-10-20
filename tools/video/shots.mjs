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
    await h.caption('Arena · seeded random goals', '“Behind an obstacle”: the straight line to each goal must cross a box');
    await h.click('.random-goals summary', { after: 0.4 });
    await page.fill('#rg-count', '5'); await page.fill('#rg-seed', '7');
    await h.click('#rg-obstructed', { after: 0.3 });
    await h.click('#rg-generate', { after: 1.6 });
    await page.locator('#arena-status').scrollIntoViewIfNeeded(); await h.settle(200);
    await h.spot('#arena-status', 'footprint preflight', { dim: false, below: true });
    await h.hold(1.6);
    await h.clearSpots();
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

  async runs({ page, h, APP }) {
    await boot(page, APP);
    await h.ready();
    await h.caption('Runs · compare and report', 'Every owned rehearsal, newest first — overlay paths on the arena');
    await h.click('#workspace-runs', { after: 1.0 });
    const clutter = await page.evaluate(() => [...document.querySelectorAll('#runs-map option')].find(o => /clutter/i.test(o.textContent))?.value);
    if (clutter) { await page.selectOption('#runs-map', clutter); await h.settle(1000); }
    await h.hold(1.0);
    const all = page.locator('#runs-select-all');
    if (await all.count()) await h.click('#runs-select-all', { after: 1.6 });
    await h.caption('Runs · robustness report', 'Wilson intervals · post-hoc Flow reach · failure categories · torque clamping');
    await h.spot('.report-group', 'per policy · criterion · latency · budget', { dim: false, below: true });
    await h.hold(3.2);
    await h.clearSpots();
    const panel = page.locator('#runs-panel, [data-panel="runs"]').first();
    for (let i = 0; i < 20; i++) { await panel.evaluate((el, i) => { el.scrollTop = i * 40; }, i).catch(() => {}); await h.frame(); }
    await h.hold(2.0);
  },
};
