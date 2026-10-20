// Probe: after typing an arena name, is the first click on "Save arena" (or another panel button) lost?
// Also checks the 180° box save with the name field blurred first. Saves up to 3 arenas.
import { BASE, launch, sleep } from './harness.mjs';
const { browser, context } = await launch();
const page = await context.newPage();
const errs = []; page.on('pageerror', e => errs.push(e.message));
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
const saved = () => page.evaluate(() => window.__studio.arena.savedId);
const posts = []; page.on('request', r => { if (r.method() === 'POST') posts.push(r.url()); });
const out = {};
// A: type a name with real keystrokes, then one mouse click on Save.
await page.selectOption('#arena-base', 'tpl:corridor'); await sleep(200);
await page.click('#arena-label'); await page.keyboard.press('Control+A'); await page.keyboard.type('Probe name typed');
let n0 = posts.length; await page.click('#arena-save'); await sleep(1500);
out.typedThenClick = { savedId: await saved(), postsSent: posts.length - n0, label: await page.evaluate(() => window.__studio.arena.label) };
// B: second click on Save.
n0 = posts.length; if (!out.typedThenClick.savedId) { await page.click('#arena-save'); await sleep(1500); }
out.secondClick = { savedId: await saved(), postsSent: posts.length - n0 };
// C: type a name, then click "+ Add preset".
await page.selectOption('#arena-base', 'tpl:doorway'); await sleep(200);
const p0 = await page.evaluate(() => window.__studio.arena.presets.length);
await page.click('#arena-label'); await page.keyboard.press('Control+A'); await page.keyboard.type('Probe preset click');
await page.click('#preset-add'); await sleep(300);
out.typedThenAddPreset = { presetsBefore: p0, presetsAfter: await page.evaluate(() => window.__studio.arena.presets.length) };
// D: 180° yaw wall drawn right to left, name field blurred before Save.
await page.selectOption('#arena-base', 'tpl:empty'); await sleep(200); await page.click('#arena-fit');
const px = (x, y) => page.evaluate(([x, y]) => { const a = window.__studio.arena, c = a.canvas, r = c.getBoundingClientRect(); return [r.left + c.clientWidth / 2 + (x - a.view.cx) * a.view.scale, r.top + c.clientHeight / 2 - (y - a.view.cy) * a.view.scale]; }, [x, y]);
await page.click('[data-arena-tool="wall"]');
const p = await px(3, 1.5), q = await px(1, 1.5); await page.mouse.move(...p); await page.mouse.down(); await page.mouse.move(...q, { steps: 6 }); await page.mouse.up();
const yaw = await page.evaluate(() => window.__studio.arena.boxes[0].yaw);
await page.keyboard.press('Escape');
await page.fill('#arena-label', 'Probe yaw 180 drawn'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200);
n0 = posts.length; await page.click('#arena-save'); await sleep(1500);
const idD = await saved();
out.yaw180Drawn = { yaw, savedId: idD, posts: posts.length - n0, server: idD ? (await (await page.request.get(`${BASE}/api/map?id=${idD}`)).json()).boxes.map(b => b.yaw) : null,
  error: await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : null };
// E: yaw field 180 on a corridor wall.
await page.selectOption('#arena-base', 'tpl:corridor'); await sleep(200); await page.click('#arena-fit'); await page.click('[data-arena-tool="select"]');
const w = await px(2.5, 0.6); await page.mouse.click(...w);
await page.fill('#box-yaw', '180'); await page.locator('#box-yaw').dispatchEvent('change'); await page.keyboard.press('Escape');
await page.fill('#arena-label', 'Probe yaw field 180'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200);
n0 = posts.length; await page.click('#arena-save'); await sleep(1500);
const idE = await saved();
out.yaw180Field = { local: await page.evaluate(() => window.__studio.arena.boxes.map(b => b.yaw)), savedId: idE, posts: posts.length - n0,
  server: idE ? (await (await page.request.get(`${BASE}/api/map?id=${idE}`)).json()).boxes.map(b => b.yaw) : null,
  error: await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : null };
await page.screenshot({ path: `${process.env.STUDIO_EVIDENCE}/probe-label-click.png` });
console.log(JSON.stringify({ out, errs }, null, 1));
await browser.close();
