// Section 3: Arena editor. No simulation runs; saves arenas only into the validation data root.
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/arena.mjs
import { writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, near, ready, api, sceneView, sleep } from './harness.mjs';

const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('arena');
let previewSync = null;
R.watch(page);
const A = fn => page.evaluate(fn);
const arena = () => A(() => JSON.parse(JSON.stringify({ ...window.__studio.arena, canvas: null, catalog: null, runs: (window.__studio.arena.runs ?? []).length })));
async function px(x, y) {
  return page.evaluate(([x, y]) => { const a = window.__studio.arena, c = a.canvas, r = c.getBoundingClientRect();
    return [r.left + c.clientWidth / 2 + (x - a.view.cx) * a.view.scale, r.top + c.clientHeight / 2 - (y - a.view.cy) * a.view.scale]; }, [x, y]);
}
async function drag(a, b, steps = 6) {
  const p = await px(...a), q = await px(...b);
  await page.mouse.move(...p); await page.mouse.down(); await page.mouse.move(...q, { steps }); await page.mouse.up();
}
async function click(a) { const p = await px(...a); await page.mouse.click(...p); }
const tool = t => page.click(`[data-arena-tool="${t}"]`);
async function template(key) { await preview2d(); await page.selectOption('#arena-base', `tpl:${key}`); await page.waitForTimeout(150); }
async function setField(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); }
const statusText = () => page.locator('#arena-status').textContent();
// v0.3: the name field re-renders the panel on 'change' (blur), which swallows the next panel click
// (see REVALIDATION N1). Blur it explicitly so the checks below measure what they intend.
async function setLabel(v) { await page.fill('#arena-label', v); await page.locator('#arena-label').dispatchEvent('input'); await page.locator('#arena-label').dispatchEvent('change'); await sleep(150); }
const blur = () => page.evaluate(() => document.activeElement?.blur());
async function preview2d() { if (await page.locator('#arena-preview3d').getAttribute('aria-pressed') === 'true') await page.click('#arena-preview3d'); }

await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-arena');
await page.waitForSelector('#arena-base');
await page.waitForTimeout(300);

await R.check('3.1', 'Every template loads with expected boxes/presets and passes preflight', async () => {
  const expected = { empty: [0, 1], corridor: [2, 2], doorway: [2, 2], slalom: [3, 2], beam: [3, 1], utrap: [3, 2], clutter: [9, 2] };
  const out = {};
  for (const [key, [nb, np]] of Object.entries(expected)) {
    await template(key);
    const a = await arena();
    assert(a.boxes.length === nb && a.presets.length === np, `${key}: ${a.boxes.length} boxes / ${a.presets.length} presets, expected ${nb}/${np}`);
    const marks = await page.locator('.preset-state').allTextContents();
    assert(marks.every(m => m === '✓'), `${key}: preflight marks ${marks}`);
    assert(/Preflight: every start and goal clears/.test(await statusText()), `${key}: status ${await statusText()}`);
    if (key === 'beam') assert(a.boxes.some(b => b.z_bottom >= 1.0), 'beam template has an overhead box');
    out[key] = { boxes: nb, presets: np, shot: await R.shot(`template-${key}`) };
  }
  // Clutter seed changes the layout deterministically.
  await page.fill('#arena-seed', '11'); await template('clutter'); const s11 = (await arena()).boxes;
  await page.fill('#arena-seed', '11'); await template('clutter'); const s11b = (await arena()).boxes;
  await page.fill('#arena-seed', '7'); await template('clutter'); const s7 = (await arena()).boxes;
  assert(JSON.stringify(s11) === JSON.stringify(s11b), 'same clutter seed reproduces');
  assert(JSON.stringify(s11) !== JSON.stringify(s7), 'different clutter seed differs');
  return out;
});

await R.check('3.2', 'Start from existing maps (Flow arenas, beam scene)', async () => {
  const out = {};
  for (const id of ['flow-detour', 'flow-slalom', 'flow-corridor', 'beam-scene']) {
    await page.selectOption('#arena-base', `map:${id}`);
    await page.waitForFunction(id => window.__studio.arena.base_map_id === id, id, { timeout: 10000 });
    const a = await arena(), m = (await api(page, `/api/map?id=${id}`)).body;
    assert(a.boxes.length === m.boxes.length, `${id}: ${a.boxes.length} vs ${m.boxes.length}`);
    assert(a.label.endsWith('· edited') && a.savedId === null, `${id}: label ${a.label} saved ${a.savedId}`);
    assert(/unsaved draft/i.test(await statusText()), 'draft chip');
    out[id] = a.boxes.length;
  }
  await R.shot('start-from-flow-corridor');
  return out;
});

await R.check('3.3', 'Tools: wall, beam, pillar, start, goal by mouse on the canvas', async () => {
  await template('empty'); await page.click('#arena-fit'); await sleep(100);
  await tool('wall'); await drag([1, 1], [3, 1]);
  let a = await arena(); let b = a.boxes.at(-1);
  assert(a.boxes.length === 1, `wall count ${a.boxes.length}`);
  near(b.center_xy[0], 2, 0.051, 'wall center x'); near(b.center_xy[1], 1, 0.051, 'wall center y');
  near(b.half_xy[0], 1, 0.051, 'wall half length'); near(b.half_xy[1], 0.12, 1e-9, 'wall half thickness');
  assert(b.z_bottom === 0 && b.z_top === 1.2, `wall z ${b.z_bottom}-${b.z_top}`);
  await tool('beam'); await drag([1, -1.5], [3, -1.5]);
  a = await arena(); b = a.boxes.at(-1);
  assert(a.boxes.length === 2 && b.z_bottom === 1.05 && b.z_top === 1.25, `beam ${JSON.stringify(b)}`);
  await tool('pillar'); await click([0.5, 2]);
  a = await arena(); b = a.boxes.at(-1);
  assert(a.boxes.length === 3 && b.half_xy[0] === 0.15 && b.half_xy[1] === 0.15, `pillar ${JSON.stringify(b)}`);
  near(b.center_xy[0], 0.5, 0.051, 'pillar x');
  await tool('start'); await click([-1, 0.5]);
  await tool('goal'); await click([4, 0]);
  a = await arena(); const q = a.presets[a.active];
  near(q.start_xy[0], -1, 0.051, 'start x'); near(q.start_xy[1], 0.5, 0.051, 'start y');
  near(q.goal_xy[0], 4, 0.051, 'goal x'); near(q.goal_xy[1], 0, 0.051, 'goal y');
  return { boxes: a.boxes, preset: q, shot: await R.shot('tools') };
});

await R.check('3.4', 'Select tool: drag box, resize handles (x, y, corner), rotate handle, drag start/goal/heading', async () => {
  await tool('select');
  // The 2 m wall at (2, 1).
  await drag([2, 1], [2, 1.5]);
  let b = (await arena()).boxes[0];
  near(b.center_xy[1], 1.5, 0.051, 'moved wall y');
  const sel = (await arena()).selection; assert(sel?.type === 'box' && sel.index === 0, `selection ${JSON.stringify(sel)}`);
  await drag([b.center_xy[0] + b.half_xy[0], b.center_xy[1]], [b.center_xy[0] + 1.5, b.center_xy[1]]);
  b = (await arena()).boxes[0]; near(b.half_xy[0], 1.5, 0.051, 'x handle resize');
  await drag([b.center_xy[0], b.center_xy[1] + b.half_xy[1]], [b.center_xy[0], b.center_xy[1] + 0.3]);
  b = (await arena()).boxes[0]; near(b.half_xy[1], 0.3, 0.051, 'y handle resize');
  await drag([b.center_xy[0] + b.half_xy[0], b.center_xy[1] + b.half_xy[1]], [b.center_xy[0] + 1.2, b.center_xy[1] + 0.2]);
  b = (await arena()).boxes[0]; near(b.half_xy[0], 1.2, 0.051, 'corner x'); near(b.half_xy[1], 0.2, 0.051, 'corner y');
  await drag([b.center_xy[0] + b.half_xy[0] + 0.3, b.center_xy[1]], [b.center_xy[0], b.center_xy[1] + 1.5]);
  b = (await arena()).boxes[0]; near(b.yaw, Math.PI / 2, 1e-6, 'rotate handle to 90°');
  // Goal / start drag and heading tip.
  let q = (await arena()).presets[0];
  await drag(q.goal_xy, [4, -1]);
  q = (await arena()).presets[0]; near(q.goal_xy[1], -1, 0.051, 'goal dragged');
  await drag(q.start_xy, [-1.5, -0.5]);
  q = (await arena()).presets[0]; near(q.start_xy[0], -1.5, 0.051, 'start dragged');
  const tip = [q.start_xy[0] + Math.cos(q.start_yaw_rad) * 0.55, q.start_xy[1] + Math.sin(q.start_yaw_rad) * 0.55];
  await drag(tip, [q.start_xy[0], q.start_xy[1] + 0.6]);
  q = (await arena()).presets[0]; near(q.start_yaw_rad, Math.PI / 2, 1e-6, 'heading tip drag');
  // Pan by dragging empty space.
  const v0 = (await arena()).view; await drag([-2.5, 2.5], [-2, 2.5]); const v1 = (await arena()).view;
  assert(Math.abs(v1.cx - v0.cx) > 0.3, `pan cx ${v0.cx} → ${v1.cx}`);
  await page.click('#arena-fit');
  return { box: b, preset: q, shot: await R.shot('handles') };
});

await R.check('3.5', 'Keyboard: D duplicates, R rotates 15°, arrows nudge, Del removes, Esc deselects', async () => {
  await page.click('#arena-fit'); await blur();
  let a = await arena(); const b0 = a.boxes[2]; // pillar
  await click(b0.center_xy); a = await arena(); assert(a.selection?.index === 2, `select pillar ${JSON.stringify(a.selection)}`);
  const n0 = a.boxes.length;
  await page.keyboard.press('d'); a = await arena();
  assert(a.boxes.length === n0 + 1, 'D duplicates'); const d = a.boxes.at(-1);
  near(d.center_xy[0], b0.center_xy[0] + 0.3, 1e-6, 'duplicate offset x'); assert(a.selection.index === a.boxes.length - 1, 'duplicate selected');
  await page.keyboard.press('r'); a = await arena(); near(a.boxes.at(-1).yaw, Math.PI / 12, 1e-9, 'R rotates 15°');
  await page.keyboard.press('Shift+R'); a = await arena(); near(a.boxes.at(-1).yaw, 0, 1e-9, 'Shift+R rotates back');
  const c0 = a.boxes.at(-1).center_xy;
  await page.keyboard.press('ArrowUp'); await page.keyboard.press('Shift+ArrowRight'); a = await arena();
  near(a.boxes.at(-1).center_xy[1], c0[1] + 0.05, 1e-6, 'ArrowUp nudges 5 cm'); near(a.boxes.at(-1).center_xy[0], c0[0] + 0.25, 1e-6, 'Shift+ArrowRight nudges 25 cm');
  await page.keyboard.press('Delete'); a = await arena(); assert(a.boxes.length === n0 && a.selection === null, 'Del removes');
  await click(b0.center_xy); await page.keyboard.press('Escape'); a = await arena();
  assert(a.selection === null && a.tool === 'select', 'Esc deselects');
  await page.keyboard.press('Delete'); a = await arena(); assert(a.boxes.length === n0, 'Del without selection does nothing');
  // Arena shortcuts must not fire while typing in a field (box selected).
  await click(b0.center_xy);
  await page.click('#arena-label'); await page.keyboard.press('End'); await page.keyboard.type('dr'); await page.keyboard.press('Backspace'); await page.keyboard.press('Backspace');
  a = await arena(); assert(a.boxes.length === n0 && a.boxes[2].yaw === b0.yaw, `typing in name field edited geometry: ${a.boxes.length} boxes`);
  // Replay shortcuts are suppressed on the 2D editor (camera / tab unchanged).
  await blur(); const cam = await page.evaluate(() => window.__studio.camera), tab = await page.locator('[role=tab][aria-selected=true]').getAttribute('data-tab');
  await page.keyboard.press('t'); await page.keyboard.press('3');
  assert(await page.evaluate(() => window.__studio.camera) === cam && await page.locator('[role=tab][aria-selected=true]').getAttribute('data-tab') === tab, 'replay keys fired in arena');
  return { boxes: a.boxes.length };
});

await R.check('3.6', 'Snap toggle: endpoints snap to 5 cm when on, free when off', async () => {
  await page.click('#arena-fit');
  await page.uncheck('#arena-snap'); await tool('wall'); await drag([0.513, 2.437], [2.013, 2.437]);
  let b = (await arena()).boxes.at(-1);
  const offGrid = v => Math.abs(v / 0.05 - Math.round(v / 0.05)) > 1e-3;
  assert(offGrid(b.center_xy[0]) || offGrid(b.center_xy[1]), `snap off still snapped ${b.center_xy}`);
  await page.keyboard.press('Escape');
  await page.check('#arena-snap'); await tool('wall'); await drag([0.513, -2.437], [2.013, -2.437]);
  b = (await arena()).boxes.at(-1);
  assert(!offGrid(b.center_xy[0]) && !offGrid(b.center_xy[1]), `snap on not snapped ${b.center_xy}`);
  await page.keyboard.press('Escape');
  return { last: b.center_xy };
});

await R.check('3.7', 'Wheel zoom changes the view and Fit view restores it', async () => {
  await page.click('#arena-fit'); const fit = (await arena()).view;
  const p = await px(1, 0); await page.mouse.move(...p); await page.mouse.wheel(0, -400); await sleep(100);
  const zoomed = (await arena()).view; assert(zoomed.scale > fit.scale * 1.3, `zoom ${fit.scale} → ${zoomed.scale}`);
  await page.click('#arena-fit'); const again = (await arena()).view;
  near(again.scale, fit.scale, 1e-6, 'fit scale'); near(again.cx, fit.cx, 1e-6, 'fit cx');
  return { fit, zoomed };
});

await R.check('3.8', 'Selected-box numeric fields edit X/Y/length/width/yaw/bottom/top', async () => {
  const b0 = (await arena()).boxes[0];
  await tool('select'); await click(b0.center_xy);
  assert((await arena()).selection?.index === 0, 'box 0 selected');
  await setField('box-x', 2.5); await setField('box-y', 1.25); await setField('box-len', 1); await setField('box-wid', 0.4);
  await setField('box-yaw', 30); await setField('box-z0', 0.2); await setField('box-z1', 0.9);
  const b = (await arena()).boxes[0];
  assert(b.center_xy[0] === 2.5 && b.center_xy[1] === 1.25, `xy ${b.center_xy}`);
  near(b.half_xy[0], 0.5, 1e-9, 'length'); near(b.half_xy[1], 0.2, 1e-9, 'width'); near(b.yaw, Math.PI / 6, 1e-9, 'yaw');
  assert(b.z_bottom === 0.2 && b.z_top === 0.9, `z ${b.z_bottom} ${b.z_top}`);
  assert(/Selected wall #1/.test(await page.locator('#arena-panel').textContent()), 'selected header');
  await page.keyboard.press('Escape');
  return b;
});

await R.check('3.9', '3D preview toggle shows boxes and start/goal markers', async () => {
  const a = await arena();
  await page.click('#arena-preview3d');
  await sleep(400);
  const s = await page.evaluate(async () => { const v = (await import('/js/scene.js')).view; return { visible: v.arenaGroup.visible, meshes: v.arenaGroup.children.filter(c => c.isMesh).length,
    groups: v.arenaGroup.children.filter(c => c.isGroup || (!c.isMesh && !c.isLine)).length, lines: v.arenaGroup.children.filter(c => c.isLine).length }; });
  const canvasHidden = await page.locator('#arena-canvas').isHidden();
  const vis = await page.evaluate(() => getComputedStyle(document.getElementById('viewport')).visibility);
  assert(s.visible && canvasHidden && vis === 'visible', `preview ${JSON.stringify(s)} canvasHidden ${canvasHidden} ${vis}`);
  assert(s.meshes >= a.boxes.length && s.groups >= 2, `preview content ${JSON.stringify(s)} for ${a.boxes.length} boxes`);
  const shot = await R.shot('preview3d');
  // Editing while previewing updates the preview.
  await page.evaluate(() => { window.__studio.arena.boxes.push({ center_xy: [0, -2], half_xy: [0.15, 0.15], yaw: 0, z_bottom: 0, z_top: 1.2 }); });
  await page.click('#preset-add');
  const s2 = await page.evaluate(async () => (await import('/js/scene.js')).view.arenaGroup.children.filter(c => c.isMesh).length);
  assert(s2 === s.meshes + 1, `preview did not update on change: ${s.meshes} → ${s2}`);
  const pressedAfterRerender = await page.locator('#arena-preview3d').getAttribute('aria-pressed');
  await page.click('#arena-preview3d'); await sleep(200);
  previewSync = { pressedAfterRerender, backAfterOneClick: await page.locator('#arena-canvas').isVisible() };
  if (!previewSync.backAfterOneClick) { await page.click('#arena-preview3d'); await sleep(200); }
  assert(await page.locator('#arena-canvas').isVisible(), '2D editor did not come back');
  return { ...s, shot };
});

await R.check('3.9b', '3D preview toggle stays in sync after the panel re-renders', async () => {
  assert(previewSync?.pressedAfterRerender === 'true' && previewSync.backAfterOneClick, `after + Add preset the 3D preview button shows aria-pressed=${previewSync?.pressedAfterRerender} while 3D is still on; one click ${previewSync?.backAfterOneClick ? 'returns' : 'does not return'} to the 2D editor (needs two)`);
  return previewSync;
});

await R.check('3.10', 'Presets: add, rename, mirror, select, remove; 16-preset cap', async () => {
  await template('doorway');
  let a = await arena(); const n0 = a.presets.length;
  await page.click('#preset-add'); a = await arena(); assert(a.presets.length === n0 + 1 && a.active === n0, 'add');
  await page.fill('#preset-label', 'Renamed preset'); await page.locator('#preset-label').dispatchEvent('change');
  a = await arena(); assert(a.presets[a.active].label === 'Renamed preset', `rename ${a.presets[a.active].label}`);
  assert(await page.locator(`[data-preset-select="${a.active}"]`).textContent() === 'Renamed preset', 'list shows rename');
  await page.click('[data-preset-select="1"]'); a = await arena(); assert(a.active === 1, 'select');
  const base = a.presets[1];
  await page.click('#preset-mirror'); a = await arena(); const m = a.presets.at(-1);
  assert(m.start_xy[1] === -base.start_xy[1] && m.goal_xy[1] === -base.goal_xy[1] && m.start_yaw_rad === -base.start_yaw_rad && /mirrored/.test(m.label), `mirror ${JSON.stringify(m)}`);
  const n1 = a.presets.length;
  await page.click(`[data-preset-remove="${n1 - 1}"]`); a = await arena(); assert(a.presets.length === n1 - 1, 'remove');
  while ((await arena()).presets.length < 16) await page.click('#preset-add');
  assert(await page.locator('#preset-add').isDisabled(), 'add disabled at 16');
  await page.click('#preset-mirror'); assert((await arena()).presets.length === 16, 'mirror respects cap');
  return { presets: 16 };
});

let firstGen, appendKept;
await R.check('3.11', 'Random goals: count/min/max/seed/heading, same seed reproduces, random start, append', async () => {
  await template('slalom');
  await page.click('.random-goals summary');
  const fill = async o => { for (const [k, v] of Object.entries(o)) await page.fill(`#rg-${k}`, String(v)); };
  await fill({ count: 6, min: 1.5, max: 4, seed: 42 }); await page.selectOption('#rg-heading', 'toward');
  await page.click('#rg-generate');
  let a = await arena(); firstGen = a.presets;
  assert(a.presets.length === 6 && a.presets.every(q => /seed 42/.test(q.label)), `gen ${a.presets.length}`);
  for (const q of a.presets) { const d = Math.hypot(q.goal_xy[0] - q.start_xy[0], q.goal_xy[1] - q.start_xy[1]); assert(d >= 1.5 - 1e-9 && d <= 4 + 1e-9, `distance ${d}`);
    near(Math.atan2(q.goal_xy[1] - q.start_xy[1], q.goal_xy[0] - q.start_xy[0]), q.start_yaw_rad, 0.05, 'heading toward goal'); }
  assert((await page.locator('.preset-state').allTextContents()).every(m => m === '✓'), 'all pass preflight');
  await page.click('#rg-generate'); a = await arena();
  assert(JSON.stringify(a.presets) === JSON.stringify(firstGen), 'same seed → same presets');
  await fill({ seed: 43 }); await page.click('#rg-generate'); a = await arena();
  assert(JSON.stringify(a.presets) !== JSON.stringify(firstGen), 'different seed differs');
  await fill({ seed: 42 }); await page.check('#rg-start'); await page.click('#rg-generate'); a = await arena();
  assert(new Set(a.presets.map(q => q.start_xy.join(','))).size > 1, 'random start varies');
  await template('slalom');
  if (await page.locator('.random-goals').getAttribute('open') === null) await page.click('.random-goals summary');
  await page.uncheck('#rg-start');
  await page.selectOption('#rg-heading', 'fixed'); await page.click('#rg-generate'); a = await arena();
  assert(a.presets.every(q => q.start_yaw_rad === 0 && q.start_xy[0] === 0 && q.start_xy[1] === 0), 'fixed heading keeps the base start and its yaw');
  await page.check('#rg-append'); await page.selectOption('#rg-heading', 'random'); await fill({ seed: 5 }); await page.click('#rg-generate'); a = await arena();
  assert(a.presets.length === 12, `append → ${a.presets.length}`);
  appendKept = await page.locator('#rg-append').isChecked();
  await page.check('#rg-append'); await page.click('#rg-generate'); a = await arena(); assert(a.presets.length === 16, `append caps at 16 → ${a.presets.length}`);
  assert(/Random presets: seed 5|\[random: seed 5;/.test(a.description), `description ${a.description}`); // v0.2 or v0.3 note format
  return { first: firstGen.map(q => [q.start_xy, q.goal_xy, q.start_yaw_rad]), shot: await R.shot('random-goals') };
});

await R.check('3.11e', 'Random goals: the Append option stays selected after Generate', async () => {
  assert(appendKept === true, 'the Append checkbox resets to unchecked after each Generate, so a second Generate silently replaces the appended presets');
});

await R.check('3.11d', 'Random goals: same seed reproduces after an intervening random-start generation', async () => {
  await template('slalom');
  if (await page.locator('.random-goals').getAttribute('open') === null) await page.click('.random-goals summary');
  await page.uncheck('#rg-append').catch(() => {}); await page.uncheck('#rg-start').catch(() => {});
  for (const [k, v] of Object.entries({ count: 5, min: 1.5, max: 4, seed: 42 })) await page.fill(`#rg-${k}`, String(v));
  await page.selectOption('#rg-heading', 'toward');
  await page.click('#rg-generate'); const g1 = (await arena()).presets;
  await page.check('#rg-start'); await page.click('#rg-generate');
  await page.uncheck('#rg-start'); await page.click('#rg-generate'); const g2 = (await arena()).presets;
  assert(JSON.stringify(g1) === JSON.stringify(g2), `seed 42 differs after a random-start pass: first start ${JSON.stringify(g1[0]?.start_xy)} vs ${JSON.stringify(g2[0]?.start_xy)}`);
  return { n: g1.length };
});

await R.check('3.11b', 'Random goals: description keeps one provenance note across regenerations (integer band)', async () => {
  await template('slalom'); await page.uncheck('#rg-append').catch(() => {});
  if (await page.locator('.random-goals').getAttribute('open') === null) await page.click('.random-goals summary');
  for (const [k, v] of Object.entries({ count: 4, min: 2, max: 4, seed: 9 })) await page.fill(`#rg-${k}`, String(v));
  await page.click('#rg-generate'); await page.click('#rg-generate'); await page.click('#rg-generate');
  const d = (await arena()).description; const n = (d.match(/Random presets:|\[random:/g) ?? []).length; // v0.2 or v0.3 note format
  assert(n === 1, `description has ${n} random-preset notes: "${d}"`);
  return { description: d };
});

await R.check('3.11c', 'Random goals: an impossible band does not discard existing presets', async () => {
  await template('slalom'); const before = (await arena()).presets;
  if (await page.locator('.random-goals').getAttribute('open') === null) await page.click('.random-goals summary');
  await page.uncheck('#rg-append').catch(() => {});
  for (const [k, v] of Object.entries({ count: 4, min: 30, max: 40, seed: 1 })) await page.fill(`#rg-${k}`, String(v));
  await page.click('#rg-generate');
  const msg = await page.locator('#workbench-error').textContent();
  const after = (await arena()).presets;
  assert(/Only 0 of 4/.test(msg), `message ${msg}`);
  assert(after.length === before.length, `presets ${before.length} → ${after.length} after a failed generation (message: ${msg})`);
  return { msg };
});

await R.check('3.12', 'Preflight: goal inside a wall shows ✕ and Save refuses', async () => {
  await template('corridor');
  await page.fill('#preset-gx', '2'); await page.locator('#preset-gx').dispatchEvent('change');
  await page.fill('#preset-gy', '0.6'); await page.locator('#preset-gy').dispatchEvent('change');
  const mark = await page.locator('[data-preset-index="0"] .preset-state').textContent();
  assert(mark === '✕', `mark ${mark}`);
  assert(/goal( —)? an obstacle intersects/i.test(await statusText()), `issues ${await statusText()}`);
  let posted = 0; const onReq = r => { if (r.url().includes('/api/arenas') && r.method() === 'POST') posted++; };
  page.on('request', onReq);
  await page.click('#arena-save'); await sleep(400);
  page.off('request', onReq);
  const err = await page.locator('#workbench-error').textContent();
  assert(/Fix before saving/.test(err) && posted === 0 && !(await arena()).savedId, `save refused? ${err} posted ${posted}`);
  return { err, shot: await R.shot('preflight-blocked') };
});

let saved1, saved2;
await R.check('3.13', 'Save arena is immutable: edit + save creates a new id; the old map is unchanged', async () => {
  await page.fill('#preset-gy', '0'); await page.locator('#preset-gy').dispatchEvent('change');
  await setLabel('Validation arena A');
  await page.click('#arena-save');
  await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 15000 });
  saved1 = (await arena()).savedId;
  assert(/Saved ✓/.test(await page.locator('#arena-save').textContent()) && /(^|[^n])Saved [0-9a-z]{6}/.test(await statusText()), 'saved state');
  const m1 = (await api(page, `/api/map?id=${saved1}`)).body;
  assert(m1.boxes.length === 2 && m1.presets.length === 2 && m1.label === 'Validation arena A', `server copy ${JSON.stringify(m1).slice(0, 200)}`);
  await page.click('#arena-fit'); await tool('select'); await click([2.5, 0.6]);
  await setField('box-x', 2.7);
  assert((await arena()).savedId === null && /unsaved draft/i.test(await statusText()), 'edit invalidates saved id');
  await page.click('#arena-save');
  await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 15000 });
  saved2 = (await arena()).savedId;
  const m1b = (await api(page, `/api/map?id=${saved1}`)).body, m2 = (await api(page, `/api/map?id=${saved2}`)).body;
  assert(saved2 !== saved1 && m1b.sha256 === m1.sha256 && m2.sha256 !== m1.sha256, `ids ${saved1} ${saved2} sha ${m1.sha256} ${m1b.sha256} ${m2.sha256}`);
  return { saved1, saved2, sha1: m1.sha256, sha2: m2.sha256 };
});

await R.check('3.14', 'Rehearse → opens Rehearse with the saved arena', async () => {
  await page.click('#arena-rehearse');
  await page.waitForFunction(id => window.__studio.state.workspace === 'rehearse' && window.__studio.rehearse.mapId === id, saved2, { timeout: 20000 });
  await sleep(500);
  const title = await page.locator('#session-title').textContent();
  assert(/Preview · Validation arena A/.test(title), `title ${title}`);
  assert(await page.locator('#rh-map').inputValue() === saved2, 'rh-map select');
  return { title, shot: await R.shot('rehearse-from-arena') };
});

await R.check('3.15', 'JSON export then import round-trip', async () => {
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  const dl = page.waitForEvent('download'); await page.click('#arena-export'); const d = await dl;
  const file = path.join(EVIDENCE, `arena-export-${d.suggestedFilename()}`); await d.saveAs(file);
  const doc = JSON.parse(await readFile(file, 'utf8')); const before = await arena();
  assert(doc.kind === 'boxes' && doc.frame_id === 'world' && doc.units === 'm' && doc.boxes.length === before.boxes.length && doc.presets.length === before.presets.length, `export ${JSON.stringify(doc).slice(0, 200)}`);
  await template('empty');
  await page.setInputFiles('#arena-import', file); await sleep(400);
  const after = await arena();
  assert(after.label === doc.label && JSON.stringify(after.boxes.map(b => [b.center_xy, b.half_xy, Number(b.yaw.toFixed(6)), b.z_bottom, b.z_top]))
    === JSON.stringify(doc.boxes.map(b => [b.center_xy, b.half_xy, b.yaw, b.z_bottom, b.z_top])) && JSON.stringify(after.presets) === JSON.stringify(doc.presets), 'round trip differs');
  return { file, boxes: doc.boxes.length };
});

await R.check('3.16', 'JSON import of 129 boxes: limit message and Save refuses; placing a box at the cap is refused', async () => {
  const boxes = []; for (let i = 0; i < 129; i++) boxes.push({ center_xy: [-2 + (i % 13) * 0.5, 4 + Math.floor(i / 13) * 0.5], half_xy: [0.1, 0.1], yaw: 0, z_bottom: 0, z_top: 1 });
  const file = path.join(EVIDENCE, 'arena-129-boxes.json');
  await writeFile(file, JSON.stringify({ kind: 'boxes', frame_id: 'world', units: 'm', label: '129 boxes', boxes, presets: [{ label: 'p', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [2, 0] }] }));
  const n0 = (await arena()).boxes.length;
  await page.setInputFiles('#arena-import', file); await sleep(300);
  const a = await arena(); const status = await statusText();
  let err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  if (a.boxes.length === 129) {  // v0.2 behaviour: imported, flagged by preflight, Save refused
    assert(/more than 128 boxes/.test(status), `status ${status}`);
    await page.click('#arena-save'); await sleep(300);
    err = await page.locator('#workbench-error').textContent();
    assert(/Fix before saving: .*more than 128 boxes/.test(err) && !(await arena()).savedId, `save ${err}`);
    await page.evaluate(() => window.__studio.arena.boxes.splice(128));
  } else {  // v0.3 behaviour: the import itself is refused with the limit, arena unchanged
    assert(a.boxes.length === n0 && /≤128 entries/.test(err), `129-box import: boxes ${n0} → ${a.boxes.length}, message "${err}"`);
    const f128 = path.join(EVIDENCE, 'arena-128-boxes.json');
    await writeFile(f128, JSON.stringify({ kind: 'boxes', frame_id: 'world', units: 'm', label: '128 boxes', boxes: boxes.slice(0, 128), presets: [{ label: 'p', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [2, 0] }] }));
    await page.setInputFiles('#arena-import', f128); await sleep(300);
    assert((await arena()).boxes.length === 128, `128-box import ${(await arena()).boxes.length}`);
  }
  await page.click('#arena-fit'); await tool('pillar'); await click([0, -1.5]);
  const err2 = await page.locator('#workbench-error').textContent();
  assert((await arena()).boxes.length === 128 && /at most 128 boxes/.test(err2), `cap ${err2}`);
  await page.keyboard.press('Escape');
  return { status, err, err2 };
});

await R.check('3.17', 'Wall drawn right-to-left (yaw = 180°) can be saved', async () => {
  await template('empty'); await page.click('#arena-fit');
  await tool('wall'); await drag([3, 1.5], [1, 1.5]);
  const b = (await arena()).boxes[0];
  await page.keyboard.press('Escape');
  await setLabel('Validation yaw 180');
  await page.click('#arena-save'); await sleep(1500);
  const id = (await arena()).savedId, err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  assert(id, `Save failed for a wall with yaw ${b.yaw} (exported ${Number(b.yaw.toFixed(6))}): ${err}`);
  return { id, yaw: b.yaw };
}, { expectHttp: [/422 .*\/api\/arenas/] });

await R.check('3.18', 'Box yaw field 180° can be saved', async () => {
  await template('corridor'); await tool('select'); await page.click('#arena-fit'); await click([2.5, 0.6]);
  await setField('box-yaw', 180); await page.keyboard.press('Escape');
  await setLabel('Validation yaw field 180');
  await page.click('#arena-save'); await sleep(1500);
  const id = (await arena()).savedId, err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  assert(id, `Save failed: ${err}`);
  return { id };
}, { expectHttp: [/422 .*\/api\/arenas/] });

await R.save({ saved1, saved2 });
await browser.close();
