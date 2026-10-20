// Probe: Orbit auto-recenter while playing on the 10 s slalom recording.
import { BASE, EVIDENCE, launch, ready, seek, sleep } from './harness.mjs';
import path from 'node:path';
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto(`${BASE}/?session=perf-large-job`); await ready(page, 'perf-large-job');
await seek(page, 0); await page.click('#camera-orbit'); await page.selectOption('#speed', '4'); await sleep(800);
await page.click('#play');
const rows = [];
for (let i = 0; i < 16; i++) { await sleep(500); rows.push(await page.evaluate(() => { const s = window.__studio.state, p = s.measuredFrame.position; return { t: +s.time.toFixed(2), playing: s.playing, xy: [+p[0].toFixed(2), +p[1].toFixed(2)], ndc: window.__studio.projectWorld([[p[0], p[1], 0.7]])[0].slice(0, 2).map(v => +v.toFixed(2)), cam: window.__studio.camera }; })); }
await page.click('#play'); await page.screenshot({ path: path.join(EVIDENCE, 'probe-orbit-end.png') });
console.log(rows.map(r => JSON.stringify(r)).join('\n'));
// Control: same playback with auto-recenter disabled by user orbiting? (not available) — compare with a static camera expectation
await browser.close();
