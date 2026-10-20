// Probe: Fit framing and playback rate on the large job; rAF rate vs scene draws.
import { BASE, EVIDENCE, launch, ready, seek, sleep } from './harness.mjs';
import path from 'node:path';
const { browser, context } = await launch();
const page = await context.newPage();
page.on('pageerror', e => console.log('pageerror', e.message));
await page.goto(`${BASE}/?session=perf-large-job`); await ready(page, 'perf-large-job');
const info = await page.evaluate(() => ({ goal: window.__studio.state.session.metadata.goal_xy, start: window.__studio.state.session.metadata.start_xy, dur: window.__studio.state.session.metadata.duration_s, cam: window.__studio.camera, markers: window.__studio.navigationScreen, markerPos: window.__studio.navigationMarkers }));
console.log('after open', JSON.stringify(info));
await page.screenshot({ path: path.join(EVIDENCE, 'probe-large-open.png') });
for (const cam of ['top', 'follow', 'orbit', 'scene']) { await page.click(`#camera-${cam}`); await sleep(300); console.log(cam, JSON.stringify(await page.evaluate(() => window.__studio.navigationScreen.map(m => [m.name, m.ndc.map(v => +v.toFixed(2))])))); }
await page.screenshot({ path: path.join(EVIDENCE, 'probe-large-fit-after-cams.png') });
// Fit directly after a fresh open (no prior camera changes)
await page.goto(`${BASE}/?session=perf-large-job`); await ready(page, 'perf-large-job');
await page.click('#camera-scene'); await sleep(300);
console.log('fresh fit', JSON.stringify(await page.evaluate(() => window.__studio.navigationScreen.map(m => [m.name, m.ndc.map(v => +v.toFixed(2))]))), JSON.stringify(await page.evaluate(() => window.__studio.cameraFit)));
await page.click('#camera-follow'); await sleep(200); await page.click('#camera-scene'); await sleep(300);
console.log('follow→fit', JSON.stringify(await page.evaluate(() => window.__studio.navigationScreen.map(m => [m.name, m.ndc.map(v => +v.toFixed(2))]))));
await page.click('#camera-top'); await sleep(200); await page.click('#camera-scene'); await sleep(300);
console.log('top→fit', JSON.stringify(await page.evaluate(() => window.__studio.navigationScreen.map(m => [m.name, m.ndc.map(v => +v.toFixed(2))]))), JSON.stringify(await page.evaluate(() => window.__studio.cameraFit)));
await page.screenshot({ path: path.join(EVIDENCE, 'probe-large-top-then-fit.png') });
// rAF rate and playback rate
for (const [speed, tab] of [['1', 'intent'], ['4', 'intent'], ['4', 'health']]) {
  await page.click(`#tab-${tab}`); await page.selectOption('#speed', speed); await seek(page, 0);
  await page.evaluate(() => { window.__raf = 0; const f = () => { window.__raf++; if (window.__rafOn) requestAnimationFrame(f); }; window.__rafOn = true; requestAnimationFrame(f); });
  const d0 = await page.evaluate(() => window.__studio.sceneDrawCount);
  await page.click('#play'); const t0 = Date.now(); await sleep(3000);
  const r = await page.evaluate(() => ({ t: window.__studio.state.time, raf: window.__raf, draws: window.__studio.sceneDrawCount, playing: window.__studio.state.playing }));
  const wall = (Date.now() - t0) / 1000; await page.click('#play'); await page.evaluate(() => { window.__rafOn = false; });
  console.log(`speed ${speed} tab ${tab}: sim ${r.t.toFixed(2)} s in ${wall.toFixed(2)} s wall → ${(r.t / wall).toFixed(2)}× ; rAF ${(r.raf / wall).toFixed(1)} Hz ; draws ${((r.draws - d0) / wall).toFixed(1)} Hz ; playing ${r.playing}`);
}
await browser.close();
