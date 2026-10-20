// Probe: is the Runs comparison canvas deterministic for the same selection?
import { BASE, EVIDENCE, launch, sleep } from './harness.mjs';
import path from 'node:path';
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto(`${BASE}/`); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await sleep(800);
const snap = () => page.evaluate(() => { const c = document.getElementById('runs-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return { h, w: c.width, hgt: c.height, sel: window.__studio.selectedRuns().map(r => r.id) }; });
for (const id of await page.evaluate(() => [...window.__studio.runs.selected])) await page.uncheck(`[data-run-select="${id}"]`).catch(() => {});
const ids = await page.locator('[data-run-select]:not([disabled])').evaluateAll(x => x.map(i => i.dataset.runSelect));
await page.check(`[data-run-select="${ids[0]}"]`); await sleep(1500); const a = await snap(); await page.screenshot({ path: path.join(EVIDENCE, 'probe-compare-a.png') });
await page.check(`[data-run-select="${ids[1]}"]`); await sleep(1500); const b = await snap();
await page.uncheck(`[data-run-select="${ids[1]}"]`); await sleep(1500); const c = await snap(); await page.screenshot({ path: path.join(EVIDENCE, 'probe-compare-c.png') });
await page.mouse.move(5, 5); await sleep(500); const d = await snap();
console.log(JSON.stringify({ a, b, c, d }));
await browser.close();
