// Re-validation (v0.3 fixes) · new random-goal options. No simulation runs; saves 1 arena.
//   3.11f 'Behind an obstacle': every saved preset's straight start→goal line crosses a box
//         (independent check: 1 cm point sampling against each oriented box footprint).
//   3.11g random goals use the current arena/start after switching arenas (no stale base start).
//   3.11h 'Behind an obstacle' on an empty arena: nothing fits → message, presets kept.
//   STUDIO_URL=http://127.0.0.1:8795 STUDIO_EVIDENCE=... node tools/browser/validation/reval_arena_extra.mjs
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('reval-arena-extra');
R.watch(page);
const arena = () => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__studio.arena, canvas: null, catalog: null, runs: null })));
async function template(key) { if (await page.locator('#arena-preview3d').getAttribute('aria-pressed') === 'true') await page.click('#arena-preview3d'); await page.selectOption('#arena-base', `tpl:${key}`); await sleep(200); }
async function openRandom() { if (await page.locator('.random-goals').getAttribute('open') === null) await page.click('.random-goals summary'); }
async function fill(o) { for (const [k, v] of Object.entries(o)) await page.fill(`#rg-${k}`, String(v)); }
async function setCheck(id, on) { if (on) await page.check(`#${id}`); else await page.uncheck(`#${id}`); }

// Independent geometry: does the segment a→b pass through the box footprint (optionally grown by pad)?
function crosses(a, b, box, pad = 0) {
  const n = Math.max(2, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.01));
  const c = Math.cos(-(box.yaw ?? 0)), s = Math.sin(-(box.yaw ?? 0));
  for (let i = 0; i <= n; i++) {
    const t = i / n, x = a[0] + t * (b[0] - a[0]) - box.center_xy[0], y = a[1] + t * (b[1] - a[1]) - box.center_xy[1];
    const lx = c * x - s * y, ly = s * x + c * y;
    if (Math.abs(lx) <= box.half_xy[0] + pad && Math.abs(ly) <= box.half_xy[1] + pad) return true;
  }
  return false;
}

await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-arena'); await page.waitForSelector('#arena-base'); await sleep(300);

await R.check('3.20', 'After typing an arena name, the first click on Save arena (and + Add preset) acts', async () => {
  await template('corridor');
  const posts = []; const onReq = r => { if (r.method() === 'POST' && r.url().includes('/api/arenas')) posts.push(r.url()); }; page.on('request', onReq);
  await page.click('#arena-label'); await page.keyboard.press('Control+A'); await page.keyboard.type('Reval typed name');
  await page.click('#arena-save'); await sleep(1500);
  const first = { saved: await page.evaluate(() => window.__studio.arena.savedId), posts: posts.length };
  if (!first.saved) { await page.click('#arena-save'); await sleep(1500); }
  const second = { saved: await page.evaluate(() => window.__studio.arena.savedId), posts: posts.length };
  page.off('request', onReq);
  await template('doorway'); const n0 = (await arena()).presets.length;
  await page.click('#arena-label'); await page.keyboard.press('Control+A'); await page.keyboard.type('Reval typed name 2');
  await page.click('#preset-add'); await sleep(300); const n1 = (await arena()).presets.length;
  const shot = await R.shot('first-click-lost');
  assert(first.saved && n1 === n0 + 1, `first Save click after typing: saved=${first.saved} (POSTs ${first.posts}); a second click saved=${second.saved}; '+ Add preset' after typing: presets ${n0} → ${n1}. arena.js:446 re-renders the panel on the name field's 'change' (fired on blur by the mousedown), so the clicked button is replaced before 'click'`);
  return { first, second, presets: [n0, n1], shot };
});

await R.check('3.11f', "Random goals 'Behind an obstacle': every saved preset's straight line crosses a box", async () => {
  await template('slalom'); await openRandom();
  await setCheck('rg-append', false); await setCheck('rg-start', false); await setCheck('rg-obstructed', true);
  await fill({ count: 8, min: 1.5, max: 5, seed: 3 }); await page.selectOption('#rg-heading', 'toward');
  await page.click('#rg-generate'); await sleep(300);
  const a = await arena();
  const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  await page.fill('#arena-label', 'Reval obstructed goals'); await page.locator('#arena-label').dispatchEvent('input'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(200); // blur first (N1)
  await page.click('#arena-save'); await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
  const id = (await arena()).savedId, map = (await api(page, `/api/map?id=${id}`)).body;
  const walk = map.boxes.filter(b => b.z_bottom <= 1.3);
  const per = map.presets.map(q => ({ label: q.label, start: q.start_xy, goal: q.goal_xy,
    strict: walk.filter(b => crosses(q.start_xy, q.goal_xy, b)).length, padded: walk.filter(b => crosses(q.start_xy, q.goal_xy, b, 0.15)).length }));
  // Control: the same seed without the option yields at least one unobstructed line on this arena.
  await setCheck('rg-obstructed', false); await page.click('#rg-generate'); await sleep(200);
  const free = (await arena()).presets.filter(q => !walk.some(b => crosses(q.start_xy, q.goal_xy, b, 0.15))).length;
  const shot = await R.shot('obstructed');
  assert(map.presets.length >= 4, `only ${map.presets.length} obstructed presets (${err})`);
  assert(per.every(p => p.padded > 0), `presets whose straight line does not touch any box (even with the 0.15 m pad): ${JSON.stringify(per.filter(p => !p.padded))}`);
  assert(/straight line blocked/.test(a.description), `description ${a.description}`);
  return { id, n: per.length, strictlyCrossing: per.filter(p => p.strict).length, grazeOnly: per.filter(p => !p.strict && p.padded).map(p => p.label), controlUnobstructed: free, per, description: a.description, shot };
});

await R.check('3.11g', 'Random goals start from the current arena/preset start after switching arenas (no stale base start)', async () => {
  // First generation on Slalom (start [0, 0]) happened above. Now Doorway, preset 2 'Offset approach' starts at [0, -1.2].
  await template('doorway'); await openRandom();
  await page.click('[data-preset-select="1"]'); await sleep(100);
  const before = (await arena()).presets[1].start_xy;
  await setCheck('rg-append', false); await setCheck('rg-start', false); await setCheck('rg-obstructed', false);
  await fill({ count: 4, min: 1.5, max: 4.5, seed: 11 }); await page.selectOption('#rg-heading', 'toward');
  await page.click('#rg-generate'); await sleep(200);
  const a = await arena();
  const starts = [...new Set(a.presets.map(q => q.start_xy.join(',')))];
  const shot = await R.shot('stale-base');
  assert(starts.length === 1 && starts[0] === before.join(','), `selected start ${JSON.stringify(before)}, but the generated presets start at ${JSON.stringify(starts)}; description "${a.description}" (arena.js:484 keeps arena.rg.baseStart from the first generation of the page session)`);
  return { before, starts, description: a.description };
});

await R.check('3.11h', "'Behind an obstacle' on an empty arena keeps the presets and explains", async () => {
  await template('empty'); await openRandom();
  const before = (await arena()).presets;
  await setCheck('rg-obstructed', true); await fill({ count: 4, min: 1.5, max: 4, seed: 2 });
  await page.click('#rg-generate'); await sleep(300);
  const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  const after = (await arena()).presets;
  await setCheck('rg-obstructed', false);
  assert(JSON.stringify(before) === JSON.stringify(after) && /Only 0 of 4/.test(err), `presets ${before.length} → ${after.length}; message "${err}"`);
  return { err };
});

await R.save();
await browser.close();
