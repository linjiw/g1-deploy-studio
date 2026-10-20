// Probe: does the 3D-preview toggle stay in sync after the arena panel re-renders?
import { BASE, launch, sleep } from './harness.mjs';
const { browser, context } = await launch();
const page = await context.newPage();
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-arena'); await page.waitForSelector('#arena-base'); await sleep(300);
const s = async label => console.log(label, JSON.stringify(await page.evaluate(() => ({ preview3d: window.__studio.arena.preview3d,
  pressed: document.getElementById('arena-preview3d').getAttribute('aria-pressed'), canvasHidden: document.getElementById('arena-canvas').hidden }))));
await s('initial');
await page.click('#arena-preview3d'); await sleep(200); await s('after toggle on');
await page.click('#preset-add'); await sleep(200); await s('after + Add preset (panel re-render)');
await page.click('#arena-preview3d'); await sleep(200); await s('after clicking toggle once more');
await page.click('#arena-preview3d'); await sleep(200); await s('after a second click');
await page.click('#workspace-replay'); await sleep(300); await page.click('#workspace-arena'); await sleep(300); await s('after leaving and re-entering Arena');
await browser.close();
