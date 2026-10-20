// Probe: where does a playing frame spend its time (headless swiftshader)?
// rAF callbacks are wrapped before the app loads; a MessageChannel heartbeat measures main-thread stalls.
import { BASE, launch, ready, sleep } from './harness.mjs';
const { browser, context } = await launch();
const page = await context.newPage();
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window); window.__cb = {};
  window.requestAnimationFrame = cb => raf(t => { const s = performance.now(); try { cb(t); } finally { const d = performance.now() - s, k = cb.name || 'anon'; (window.__cb[k] ??= []).push(d); } });
});
await page.goto(`${BASE}/?session=perf-large-job`); await ready(page, 'perf-large-job');
for (const [label, tab] of [['intent', 'intent'], ['health', 'health'], ['joints', 'joints']]) {
  await page.click(`#tab-${tab}`); await page.evaluate(() => window.__studio.seek(0));
  const res = await page.evaluate(async () => {
    window.__cb = {}; const gaps = []; let last = performance.now(), on = true;
    const ch = new MessageChannel(); ch.port1.onmessage = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) setTimeout(() => ch.port2.postMessage(0), 0); }; ch.port2.postMessage(0);
    window.__studio.setPlaying(true); await new Promise(x => setTimeout(x, 3000)); window.__studio.setPlaying(false); on = false;
    const stat = a => a.length ? { n: a.length, mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1), max: +a.reduce((x, y) => Math.max(x, y), 0).toFixed(1) } : null;
    return { cb: Object.fromEntries(Object.entries(window.__cb).map(([k, v]) => [k, stat(v)])), stalls200: gaps.filter(g => g > 200).length, maxGap: +gaps.reduce((x, y) => Math.max(x, y), 0).toFixed(0), beats: gaps.length, sim: window.__studio.state.time };
  });
  console.log(label, JSON.stringify(res));
}
await browser.close();
