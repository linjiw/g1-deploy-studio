// Opt-in recorded-time camera acceptance, using real public walks and real WebGL.
// SITE_URL=http://127.0.0.1:8816/ STUDIO_EVIDENCE=<dir> node tools/site/cinematic.mjs
import { launch, recorder, assert } from '../browser/validation/harness.mjs';

const SITE = process.env.SITE_URL || 'http://127.0.0.1:8811/';
const { browser, context } = await launch({ viewport: { width: 1440, height: 900 } });
const report = recorder('cinematic');
let page = await context.newPage(); report.watch(page);
const ready = p => p.waitForFunction(() => window.studioDemo?.S.walk && studioDemo.S.world, null, { timeout: 60000 });
const state = p => p.evaluate(() => ({ time: studioDemo.S.t, playing: studioDemo.S.playing, mode: studioDemo.cameraMode,
  eye: studioDemo.viewer.camera.position.toArray(), target: studioDemo.viewer.controls.target.toArray(), shot: studioDemo.viewer.film?.shot }));
try {
  await report.check('film-link', 'A Film deep link plays the real doorway recording from the requested time', async () => {
    await page.goto(new URL('demo/#doorway/g12-00/film@3', SITE).href); await ready(page);
    assert(await page.evaluate(() => studioDemo.cameraMode) === 'film', 'Film link did not select Film');
    await page.waitForFunction(() => studioDemo.S.t > 3.2);
    await page.evaluate(() => { studioDemo.pause(); studioDemo.seek(3); });
    assert(await page.locator('[data-camera="film"]').getAttribute('aria-pressed') === 'true', 'Film control not active');
    await report.shot('doorway-desktop');
    return state(page);
  });
  await report.check('deterministic', 'Seeking backward reproduces the camera without changing recorded robot poses', async () => {
    const result = await page.evaluate(() => {
      const d = studioDemo, camera = () => [...d.viewer.camera.position, ...d.viewer.controls.target];
      d.seek(3.125); const first = camera(), q = [...d.pose];
      d.seek(7); d.seek(0); d.seek(3.125); const second = camera();
      return { error: Math.max(...first.map((x, i) => Math.abs(x - second[i]))),
        poseError: Math.max(...q.map((x, i) => Math.abs(x - d.S.walk.pose(3.125)[i]))),
        cameraChanges: first.some((x, i) => Math.abs(x - second[i]) > 1e-9) };
    });
    assert(result.error < 1e-9 && result.poseError === 0, JSON.stringify(result));
    return result;
  });
  await report.check('smooth-shots', 'Establishing, tracking and finish shots have continuous camera paths', async () => {
    const result = await page.evaluate(async () => {
      const { filmPose } = await import('/js/viewer.js'), d = studioDemo, w = d.S.walk;
      const a = new Float64Array(6), b = new Float64Array(6); let max = 0;
      filmPose(w, d.S.world, 0, d.viewer.camera.aspect, a);
      for (let t = 0.04; t <= w.duration; t += 0.04) {
        filmPose(w, d.S.world, t, d.viewer.camera.aspect, b);
        max = Math.max(max, Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])); a.set(b);
      }
      const shots = [0, w.duration / 2, w.duration].map(t => { d.seek(t); return d.viewer.film.shot; });
      d.seek(3); return { max_camera_step_m: max, interval_s: 0.04, shots };
    });
    assert(result.max_camera_step_m < 0.4 && result.shots.join(',') === 'Establishing,Tracking,Finish', JSON.stringify(result));
    return result;
  });
  await report.check('pause-and-speed', 'Pausing stops all Film draws; speed changes preserve recorded-time framing', async () => {
    await page.waitForFunction(() => !studioDemo.viewer.running);
    const first = await page.evaluate(() => studioDemo.viewer.renderer.info.render.frame);
    const before = await state(page); await page.waitForTimeout(600); const after = await state(page);
    assert(await page.evaluate(() => studioDemo.viewer.renderer.info.render.frame) === first, 'paused camera kept drawing');
    assert(JSON.stringify(before.eye) === JSON.stringify(after.eye) && before.time === after.time, 'paused view moved');
    await page.evaluate(() => { studioDemo.S.speed = 4; studioDemo.play(); });
    await page.waitForTimeout(200); await page.evaluate(() => studioDemo.pause());
    assert((await state(page)).time > before.time, 'Film stopped playback');
    return { idle_draws: 0, speed: 4 };
  });
  await report.check('manual-takeover', 'Dragging and wheel zoom hand control back; Film can be resumed explicitly', async () => {
    await page.mouse.move(700, 500); await page.mouse.down(); await page.mouse.move(760, 510, { steps: 5 }); await page.mouse.up();
    assert((await state(page)).mode === 'orbit', 'drag did not release Film');
    assert(await page.evaluate(() => !studioDemo.viewer.film && !location.hash.includes('/film')), 'Film state/link remained active');
    await page.click('[data-camera="film"]'); assert((await state(page)).mode === 'film', 'Film could not resume');
    await page.mouse.move(700, 500); await page.mouse.wheel(0, 100);
    assert((await state(page)).mode === 'orbit', 'wheel did not release Film');
    await page.click('[data-camera="film"]');
    return { drag: 'orbit', wheel: 'orbit', resumed: true };
  });
  await report.check('offscreen', 'An offscreen Film suspends its playback and GPU work', async () => {
    await page.evaluate(() => { studioDemo.S.speed = 1; studioDemo.play(); studioDemo.root.style.visibility = 'hidden'; studioDemo.el.canvas.style.display = 'none'; });
    await page.waitForFunction(() => !studioDemo.viewer.visible && !studioDemo.viewer.running);
    const before = await state(page); const draws = await page.evaluate(() => studioDemo.viewer.renderer.info.render.frame);
    await page.waitForTimeout(500);
    assert((await state(page)).time === before.time && await page.evaluate(() => studioDemo.viewer.renderer.info.render.frame) === draws, 'offscreen playback advanced');
    await page.evaluate(() => { studioDemo.root.style.visibility = ''; studioDemo.el.canvas.style.display = ''; });
    await page.waitForFunction(t => studioDemo.S.t > t, before.time); await page.evaluate(() => studioDemo.pause());
    return { offscreen_draws: 0, offscreen_time_delta: 0, resumed: true };
  });
  await report.check('phone', 'Portrait and landscape keep the Film control and robot in view', async () => {
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const mobile = await phone.newPage(); report.watch(mobile);
    await mobile.goto(new URL('demo/#doorway/g12-00/film@3', SITE).href); await ready(mobile); await mobile.evaluate(() => studioDemo.pause());
    const results = [];
    try {
      for (const [width, height] of [[390, 844], [844, 390]]) {
        await mobile.setViewportSize({ width, height }); await mobile.waitForTimeout(180);
        await mobile.evaluate(() => { studioDemo.seek(studioDemo.S.walk.duration / 2); });
        const result = await mobile.evaluate(() => {
          const d = studioDemo, b = d.root.querySelector('[data-camera="film"]').getBoundingClientRect(), p = d.viewer.project(d.pose[0], d.pose[1], d.pose[2]);
          const dock = d.el.dock.getBoundingClientRect();
          return { width: innerWidth, height: innerHeight, buttonFits: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight,
            touchTarget: [b.width, b.height], robotFits: p && p[0] > 0 && p[0] < innerWidth && p[1] > 0 && p[1] < dock.top, overflow: document.body.scrollWidth > innerWidth };
        });
        assert(result.buttonFits && result.robotFits && !result.overflow && result.touchTarget.every(n => n >= 40), JSON.stringify(result));
        await report.shot(`film-${width}x${height}`, mobile); results.push(result);
      }
    } finally { await phone.close(); report.use(page); }
    return results;
  });
  await report.check('ordinary-links', 'Ordinary playback links retain their camera behavior and keyboard camera cycle', async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(new URL('demo/#doorway/g12-00/play@3', SITE).href); await ready(page); await page.evaluate(() => studioDemo.pause());
    assert((await state(page)).mode === 'orbit', 'ordinary play link opted into Film');
    await page.locator('[data-el="canvas"]').focus(); await page.keyboard.press('c');
    assert((await state(page)).mode === 'top', 'C camera cycle changed');
    await page.keyboard.press('c'); assert((await state(page)).mode === 'follow', 'C follow cycle changed');
    return { normal_link: 'orbit', cycle: ['top', 'follow'] };
  });
  await report.check('reduced-motion', 'Reduced motion opens Film paused and keeps a fixed camera during playback', async () => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(new URL('demo/#doorway/g12-00/film@3', SITE).href); await ready(page);
    const before = await state(page);
    assert(before.mode === 'film' && before.shot === 'Still view' && !before.playing, JSON.stringify(before));
    await page.evaluate(() => { studioDemo.seek(4); studioDemo.play(); }); await page.waitForTimeout(300); await page.evaluate(() => studioDemo.pause());
    const after = await state(page);
    const error = Math.max(...before.eye.map((x, i) => Math.abs(x - after.eye[i])), ...before.target.map((x, i) => Math.abs(x - after.target[i])));
    assert(error < 1e-9, `reduced-motion camera moved ${error} m`);
    return { paused_on_open: true, camera: 'fixed', recording_played: after.time > 4 };
  });
  await report.check('reset', 'New goal exits Film and disables it until another recording is loaded', async () => {
    await page.click('[data-el="reset"]');
    assert(await page.locator('[data-camera="film"]').isDisabled(), 'Film enabled without a recording');
    assert((await state(page)).mode === 'orbit' && await page.evaluate(() => !studioDemo.viewer.film), 'old camera track survived reset');
    return { mode: 'orbit', film_disabled: true };
  });
} finally { await report.save({ site: SITE }); await browser.close(); }
process.exitCode = report.results.some(r => r.status !== 'PASS') ? 1 : 0;
