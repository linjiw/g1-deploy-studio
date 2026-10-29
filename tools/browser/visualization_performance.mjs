// Real browser rendering/lifecycle regressions. Recorded data only; no worker or hardware requests.
// SITE_URL=http://127.0.0.1:8816/ STUDIO_URL=http://127.0.0.1:8796 STUDIO_EVIDENCE=<dir> node tools/browser/visualization_performance.mjs
import { launch, recorder, ready, BASE, assert } from './validation/harness.mjs';

const SITE = process.env.SITE_URL || 'http://127.0.0.1:8811/';
const { browser, context } = await launch({ viewport: { width: 1280, height: 900 } });
const report = recorder('visualization-performance');
const page = await context.newPage(); report.watch(page);
async function probe() {
  await page.evaluate(async () => {
    window.probeViewer?.dispose(); window.probeHost?.remove();
    const host = window.probeHost = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', top: '0', left: '0', width: '600px', height: '400px', zIndex: '9999' });
    document.body.appendChild(host);
    window.probePicks = []; window.probeHovers = [];
    const { Viewer } = await import('/js/viewer.js');
    window.probeViewer = new Viewer(host, { onPick: xy => probePicks.push(xy), onHover: xy => probeHovers.push(xy) });
  });
}
try {
  await report.check('real-recording', 'A real recorded public walk still plays with robot, reference and map', async () => {
    await page.goto(new URL('demo/', SITE).href);
    await page.waitForFunction(() => window.studioDemo?.S.world && window.studioDemo?.viewer.robot, null, { timeout: 60000 });
    await page.evaluate(async () => { const d = studioDemo; d.selectCell(d.S.recorded[0], { stage: true }); await d.go(); });
    await page.waitForFunction(() => studioDemo.S.t > 1.2 && studioDemo.viewer.ghosts.plan?.root.visible, null, { timeout: 15000 });
    await page.evaluate(() => studioDemo.pause());
    const result = await page.evaluate(() => ({ time: studioDemo.S.t, walk: studioDemo.S.walk.goal_id, robot: !!studioDemo.viewer.robot,
      ghost: !!studioDemo.viewer.ghosts.plan?.root.visible, map: !!studioDemo.viewer.mapMesh, geometries: studioDemo.viewer.renderer.info.memory.geometries }));
    assert(result.robot && result.ghost && result.map, JSON.stringify(result));
    await report.shot('recorded-walk');
    return result;
  });
  await report.check('public-idle', 'Paused public replay stops controls and GPU draws entirely', async () => {
    await page.waitForFunction(() => !studioDemo.viewer.running);
    await page.evaluate(() => {
      const v = studioDemo.viewer, update = v.controls.update.bind(v.controls);
      v.__updates = 0; v.controls.update = (...args) => { v.__updates++; return update(...args); };
    });
    const before = await page.evaluate(() => studioDemo.viewer.renderer.info.render.frame);
    await page.waitForTimeout(800);
    const result = await page.evaluate(before => ({ draws: studioDemo.viewer.renderer.info.render.frame - before, updates: studioDemo.viewer.__updates }), before);
    assert(result.draws === 0 && result.updates === 0, JSON.stringify(result));
    return { ...result, interval_ms: 800 };
  });
  await report.check('line-buffers', 'Updating paths reuses GPU buffers and preserves dashed distances and draw bounds', async () => {
    await probe();
    const result = await page.evaluate(() => {
      const v = probeViewer, line = v.line(0x56d9d0, 3, { dashed: true }); v.groups.route.add(line);
      v.setLine(line, [[0, 0], [1, 0], [1, 1]]);
      const geometry = line.geometry, buffer = geometry.attributes.instanceStart.data;
      for (let n = 0; n < 200; n++) v.setLine(line, [[0, 0], [1, 0], [1, 2]]);
      const same = geometry === line.geometry && buffer === line.geometry.attributes.instanceStart.data;
      const distance = geometry.attributes.instanceDistanceEnd.getX(1);
      v.setLineCount(line, 10000); const clamped = geometry.instanceCount;
      v.setLineCount(line, 1); const empty = geometry.instanceCount;
      v.setLineCount(line, 3); const restored = geometry.instanceCount;
      return { same, distance, clamped, empty, restored, updates: 200 };
    });
    assert(result.same && result.distance === 3 && result.clamped === 2 && result.empty === 0 && result.restored === 2, JSON.stringify(result));
    await page.waitForTimeout(100); await report.shot('reused-line');
    return result;
  });
  await report.check('pointer-gestures', 'Right clicks, drags, cancelled and multitouch gestures never select a goal', async () => {
    const result = await page.evaluate(async () => {
      const el = probeViewer.renderer.domElement;
      const emit = (type, extras = {}) => el.dispatchEvent(new PointerEvent(type, { clientX: 300, clientY: 240, button: 0, pointerId: 1, isPrimary: true, ...extras }));
      emit('pointerdown', { button: 2 }); emit('pointerup', { button: 2 });
      emit('pointerdown'); emit('pointercancel'); emit('pointerup');
      emit('pointerdown'); emit('pointerup', { clientX: 400 });
      emit('pointerdown', { pointerType: 'touch' }); emit('pointerdown', { pointerId: 2, isPrimary: false, pointerType: 'touch' }); emit('pointerup', { pointerType: 'touch' });
      const rejected = probePicks.length;
      emit('pointerdown'); emit('pointerup');
      emit('pointermove', { pointerType: 'mouse' }); emit('pointerleave');
      await new Promise(resolve => requestAnimationFrame(resolve));
      return { rejected, accepted: probePicks.length, staleHover: probeHovers.at(-1) };
    });
    assert(result.rejected === 0 && result.accepted === 1 && result.staleHover === null, JSON.stringify(result));
    return result;
  });
  await report.check('offscreen', 'An offscreen animated viewer sleeps and resumes when shown', async () => {
    await page.evaluate(() => { probeViewer.onFrame = () => true; probeViewer.start(); });
    await page.waitForTimeout(120);
    await page.evaluate(() => { probeHost.style.display = 'none'; });
    await page.waitForFunction(() => !probeViewer.visible && !probeViewer.running);
    const before = await page.evaluate(() => probeViewer.renderer.info.render.frame);
    await page.waitForTimeout(250);
    assert(await page.evaluate(() => probeViewer.renderer.info.render.frame) === before, 'offscreen view kept drawing');
    await page.evaluate(() => { probeHost.style.display = ''; });
    await page.waitForFunction(before => probeViewer.renderer.info.render.frame > before, before);
    await page.evaluate(() => { probeViewer.onFrame = null; });
    return { hidden_draws: 0, resumed: true };
  });
  await report.check('context-recovery', 'A real WebGL context loss pauses rendering, explains it, and restores the scene', async () => {
    await page.evaluate(() => { window.probeContext = probeViewer.renderer.getContext().getExtension('WEBGL_lose_context'); probeContext.loseContext(); });
    await page.waitForFunction(() => probeViewer.contextLost);
    assert(await page.locator('[role="status"]').filter({ hasText: 'graphics context recovers' }).isVisible(), 'lost context has no visible status');
    const before = await page.evaluate(() => probeViewer.renderer.info.render.frame);
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => probeViewer.renderer.info.render.frame) === before, 'lost context kept drawing');
    await page.evaluate(() => probeContext.restoreContext());
    await page.waitForFunction(() => !probeViewer.contextLost && !probeViewer._contextStatus.isConnected);
    await page.waitForTimeout(100);
    return { recovered: true };
  });
  await report.check('map-and-camera', 'Map resolution changes resize the map and a portrait top camera fits its room', async () => {
    const result = await page.evaluate(() => {
      const v = probeViewer, map = { n: 2, res_m: 0.05, lo: [0, 0], codes: [1, 1, 0, 3], height_cm: [0, 0, 0, 80] };
      v.setMapBase(map); const mesh = v.mapMesh; v.setMapBase({ ...map, res_m: 0.2 });
      probeHost.style.width = '280px'; probeHost.style.height = '760px'; v.resize();
      const world = { bounds: { min: [-6, -6], max: [6, 6] }, start_xy: [0, 0] }; v.frame(world, 'top');
      const corners = [[-6, -6], [-6, 6], [6, -6], [6, 6]].map(p => v.project(...p));
      return { reused: mesh === v.mapMesh, scale: v.mapMesh.scale.x, distance: v.camera.position.distanceTo(v.controls.target),
        cornersFit: corners.every(p => p && p[0] >= 0 && p[0] <= 280 && p[1] >= 0 && p[1] <= 760) };
    });
    assert(result.reused && result.scale === 0.4 && result.distance > 22 && result.cornersFit, JSON.stringify(result));
    return result;
  });
  await report.check('pixel-budget', 'A 4K canvas obeys the 3.5 million pixel cap even below device ratio one', async () => {
    const result = await page.evaluate(() => {
      probeHost.style.width = '3840px'; probeHost.style.height = '2160px'; probeViewer.resize();
      const el = probeViewer.renderer.domElement;
      return { pixels: el.width * el.height, ratio: probeViewer.renderer.getPixelRatio() };
    });
    assert(result.pixels <= 3500000 && result.ratio < 1, JSON.stringify(result));
    await probe(); return result;
  });
  await report.check('truncated-mesh', 'A truncated robot download fails explicitly instead of rendering zero-filled geometry', async () => {
    await page.route('**/data/meshes.bin', route => route.fulfill({ body: Buffer.alloc(32), contentType: 'application/octet-stream' }));
    const result = await page.evaluate(async () => {
      try { await probeViewer.loadRobot('/data/', () => {}); return { error: null }; }
      catch (e) { return { error: e.message, robot: !!probeViewer.robot }; }
    });
    await page.unroute('**/data/meshes.bin');
    assert(/expected .* mesh bytes, received 32/.test(result.error) && !result.robot, JSON.stringify(result));
    return result;
  });
  await report.check('dispose-during-load', 'Stop aborts a pending robot download and prevents late scene attachment', async () => {
    let arrived, release;
    const started = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/data/meshes.bin', async route => { arrived(); await held; await route.continue().catch(() => {}); });
    await page.evaluate(() => { window.probeLoad = probeViewer.loadRobot('/data/', () => {}).then(() => 'loaded', e => e.name); });
    await started;
    await page.evaluate(() => { probeViewer.dispose(); probeViewer.dispose(); });
    const result = await page.evaluate(async () => ({ result: await probeLoad, canvases: probeHost.querySelectorAll('canvas').length, robot: !!probeViewer.robot, running: probeViewer.running }));
    release(); await page.unroute('**/data/meshes.bin');
    assert(result.result === 'AbortError' && !result.canvases && !result.robot && !result.running, JSON.stringify(result));
    return result;
  });
  await report.check('studio-idle', 'Studio recorded replay renders correctly and performs no idle control updates', async () => {
    await page.goto(`${BASE}/?session=sonic-lockstep`); await ready(page, 'sonic-lockstep');
    await page.evaluate(async () => {
      const { view } = await import('/js/scene.js'); const update = view.controls.update.bind(view.controls);
      window.probeScene = view; view.__updates = 0; view.controls.update = (...args) => { view.__updates++; return update(...args); };
    });
    await page.waitForTimeout(500);
    const before = await page.evaluate(() => ({ draws: probeScene.drawCount, updates: probeScene.__updates }));
    await page.waitForTimeout(800);
    const result = await page.evaluate(before => ({ draws: probeScene.drawCount - before.draws, updates: probeScene.__updates - before.updates }), before);
    assert(result.draws === 0 && result.updates === 0, JSON.stringify(result));
    await page.evaluate(() => { __studio.seek(0.3); __studio.setPlaying(true); });
    await page.waitForTimeout(350); await page.evaluate(() => __studio.setPlaying(false));
    assert(await page.evaluate(() => __studio.state.time) > 0.4, 'Studio replay did not advance');
    await report.shot('studio-replay');
    return { ...result, interval_ms: 800, playback: true };
  });
  await report.check('superseded-model', 'A completed but superseded model build disposes its materials and preserves the current scene', async () => {
    const result = await page.evaluate(async () => {
      const scene = await import('/js/scene.js'), THREE = await import('three');
      const robot = scene.view.robot, futures = scene.view.futures, session = scene.view.session;
      const dispose = THREE.Material.prototype.dispose;
      let disposed = 0, checks = 0;
      THREE.Material.prototype.dispose = function () { disposed++; return dispose.call(this); };
      try {
        const loaded = await scene.loadSessionScene(__studio.state.session, __studio.state.sessionId, () => ++checks === 1);
        return { cancelled: loaded === null, disposed, checks, unchanged: scene.view.robot === robot && scene.view.futures === futures && scene.view.session === session };
      } finally { THREE.Material.prototype.dispose = dispose; }
    });
    assert(result.cancelled && result.disposed > 0 && result.unchanged, JSON.stringify(result));
    return result;
  });
} finally { await report.save({ site: SITE }); await browser.close(); }
process.exitCode = report.results.some(r => r.status !== 'PASS') ? 1 : 0;
