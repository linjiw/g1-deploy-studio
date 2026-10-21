// Build sheet (REAL_WORLD_DEPLOYMENT §6.1, Phase 0). Saves 2 arenas through the API (CSRF token) and, unless
// SHEET_RUN=0, runs ONE short frozen-bundle CPU rehearsal of preset 0 to check the evidence section.
// Every expected value is computed here, independently of apps/web/js/sheet.js.
//   STUDIO_URL=http://127.0.0.1:8796 STUDIO_EVIDENCE=<dir> node tools/browser/validation/sheet.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, near, api, sleep } from './harness.mjs';

const { browser, context } = await launch({ viewport: { width: 1400, height: 1000 } });
const page = await context.newPage();
const R = recorder('sheet');
R.watch(page);

// ---------------------------------------------------------------- course under test
const BOX = [
  { center_xy: [2.0, 0.8], half_xy: [0.5, 0.12], yaw: 0.6, z_bottom: 0, z_top: 1.2 },          // rotated wall
  { center_xy: [2.6, -0.4], half_xy: [0.12, 0.7], yaw: 0.1, z_bottom: 1.05, z_top: 1.25 },     // overhead beam
  { center_xy: [1.2, -1.2], half_xy: [0.2, 0.15], yaw: -0.3, z_bottom: 0, z_top: 0.2 },        // low box
];
const PRESETS = [
  { label: 'Straight 3 m', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [3.0, 0] },
  { label: 'Offset start, heading 30°', start_xy: [0.4, -0.6], start_yaw_rad: Math.PI / 6, goal_xy: [3.0, 0.6] },
  { label: 'Facing +y', start_xy: [1.0, -2.2], start_yaw_rad: Math.PI / 2, goal_xy: [1.0, -0.6] },
  { label: 'Long diagonal', start_xy: [-0.5, -1.5], start_yaw_rad: -0.4, goal_xy: [4.0, 1.4] },
];
const LABEL = `Sheet validation ${new Date().toISOString().slice(0, 19)}`;

// Independent geometry. Complex-number form: (d) · e^{-iθ} gives (ahead, left).
function startFrame(p, q) {
  const re = p[0] - q.start_xy[0], im = p[1] - q.start_xy[1], c = Math.cos(-q.start_yaw_rad), s = Math.sin(-q.start_yaw_rad);
  return [re * c - im * s, re * s + im * c];
}
function worldCorners(b) {
  const out = [];
  for (const [u, v] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
    const lx = u * b.half_xy[0], ly = v * b.half_xy[1];
    out.push([b.center_xy[0] + lx * Math.cos(b.yaw) - ly * Math.sin(b.yaw), b.center_xy[1] + lx * Math.sin(b.yaw) + ly * Math.cos(b.yaw)]);
  }
  return out;
}
function rotationDeg(b, q) {   // half-turn symmetric footprint: report in (-90°, 90°]
  let d = (((b.yaw - q.start_yaw_rad) * 180 / Math.PI) % 180 + 180) % 180;
  if (d > 90) d -= 180;
  return d;
}
function expectedRows(q) {
  return BOX.map((b, i) => {
    const [a, l] = startFrame(b.center_xy, q), over = b.z_bottom > 0.05;
    return { n: i + 1, type: over ? 'overhead' : 'ground', ahead: a, left: l, along: 2 * b.half_xy[0], across: 2 * b.half_xy[1], rot: rotationDeg(b, q),
      z: [b.z_bottom, b.z_top], noStep: !over && b.z_top > 0.25, corners: worldCorners(b).map(p => startFrame(p, q)) };
  });
}
const f2 = v => { const s = v.toFixed(2); return Number(s) === 0 ? '0.00' : s; };
function expectedLine(q) {
  const [a, l] = startFrame(q.goal_xy, q), d = Math.hypot(a, l);
  return { a, l, d, line: `./g1 robot --iface eth0 --goal ${f2(a)} ${f2(l)} --odom ${d > 3 ? 'zmq' : 'leg'} --mount-calib mount.json` };
}
function wilson(k, n) { const z = 1.96, p = k / n, den = 1 + z * z / n, mid = (p + z * z / (2 * n)) / den, half = (z / den) * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [Math.max(0, mid - half), Math.min(1, mid + half)]; }

// ---------------------------------------------------------------- helpers
let token = null;
async function post(p, data) {
  token ??= (await api(page, '/api/workbench')).body.csrf_token;
  const r = await page.request.post(`${BASE}${p}`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data });
  const body = await r.json().catch(() => null);
  if (r.status() !== 201) throw new Error(`${p}: ${r.status()} ${JSON.stringify(body)}`);
  return body;
}
const sheetUrl = (id, i) => `${BASE}/sheet.html?arena=${encodeURIComponent(id)}&preset=${i}`;
async function openSheet(p, id, i) {
  await p.goto(sheetUrl(id, i));
  await p.waitForFunction(() => ['ready', 'error'].includes(document.body.dataset.state), null, { timeout: 60000 });
  return p.evaluate(() => document.body.dataset.state);
}
async function readSheet(p) {
  return p.evaluate(() => {
    const txt = s => document.querySelector(s)?.textContent?.trim() ?? null;
    const start = document.querySelector('#sheet-start'), scale = document.querySelector('#sheet-scale'), goal = document.querySelector('#sheet-goal');
    return {
      title: txt('#sheet-title'), preset: txt('#sheet-preset-label'), notCert: txt('#sheet-not-cert'), console: txt('#sheet-console'), goalText: txt('#sheet-goal-text'),
      ladder: txt('#sheet-ladder'), overheadWarning: txt('#sheet-overhead-warning'), noRehearsal: txt('#sheet-no-rehearsal'), evidence: txt('#sheet-evidence'),
      rows: [...document.querySelectorAll('#sheet-obstacles tbody tr')].map(tr => [...tr.cells].map(td => td.textContent.trim())),
      origin: start ? [Number(start.getAttribute('cx')), Number(start.getAttribute('cy'))] : null,
      scale: scale ? Number(scale.getAttribute('width')) : null, scaleMetres: scale ? Number(scale.dataset.metres) : null,
      goal: goal ? [Number(goal.getAttribute('cx')), Number(goal.getAttribute('cy')), Number(goal.getAttribute('r'))] : null,
      polygons: [...document.querySelectorAll('#sheet-plan polygon[id^="sheet-box-"]')].map(pg => ({ id: pg.id, cls: pg.getAttribute('class'),
        points: pg.getAttribute('points').trim().split(/\s+/).map(s => s.split(',').map(Number)) })),
      paths: document.querySelectorAll('#sheet-plan polyline.path').length,
      printButton: (() => { const b = document.querySelector('#sheet-print'); return b ? { visible: !!b.offsetParent && getComputedStyle(b).display !== 'none', disabled: b.disabled } : null; })(),
    };
  });
}
// Real print output (print media, browser-default "no background graphics", 12 mm margins) on both paper sizes.
async function printPages(name, p = page) {
  const pages = {};
  await p.emulateMedia({ media: 'print' });
  for (const format of ['A4', 'Letter']) {
    const file = path.join(EVIDENCE, `${name}-${format.toLowerCase()}.pdf`);
    await p.pdf({ path: file, format, margin: { top: '12mm', bottom: '12mm', left: '12mm', right: '12mm' } });
    pages[format] = ((await readFile(file)).toString('latin1').match(/\/Type\s*\/Page(?![s\w])/g) ?? []).length;
  }
  await p.emulateMedia({ media: null });
  return pages;
}
const fitsTwo = pages => Object.values(pages).every(n => n >= 1 && n <= 2);
// Back from SVG units to the start frame, using only what a reader sees: the start mark and the 1 m scale bar.
const toFrame = (s, [x, y]) => [(s.origin[1] - y) / s.scale, (s.origin[0] - x) / s.scale];
function checkGeometry(s, q, label) {
  const exp = expectedRows(q), line = expectedLine(q);
  assert(s.title === LABEL, `${label}: title ${s.title}`);
  assert(s.preset === q.label, `${label}: preset label ${s.preset}`);
  assert(/Simulation-designed course · not a hardware certification/.test(s.notCert ?? ''), `${label}: certification note ${s.notCert}`);
  assert(s.console === line.line, `${label}: console line\n  got  ${s.console}\n  want ${line.line}`);
  const side = f2(line.l).startsWith('-') ? `${f2(-line.l)} m right` : `${f2(line.l)} m left`;
  assert(s.goalText === `${f2(line.a)} m ahead · ${side}`, `${label}: goal text ${s.goalText}`);
  assert(s.rows.length === exp.length, `${label}: ${s.rows.length} obstacle rows`);
  const worst = { pos: 0, rot: 0, svg: 0 };
  exp.forEach((e, i) => {
    const c = s.rows[i];
    assert(Number(c[0]) === e.n && c[1] === e.type, `${label} #${e.n}: number/type ${c[0]} ${c[1]}`);
    for (const [k, v] of [[2, e.ahead], [3, e.left], [4, e.along], [5, e.across]]) { near(Number(c[k]), v, 0.0051, `${label} #${e.n} col ${k}`); worst.pos = Math.max(worst.pos, Math.abs(Number(c[k]) - v)); }
    near(Number(c[6]), e.rot, 0.051, `${label} #${e.n} rotation`); worst.rot = Math.max(worst.rot, Math.abs(Number(c[6]) - e.rot));
    const [z0, z1] = c[7].split('–').map(Number);
    near(z0, e.z[0], 0.0051, `${label} #${e.n} bottom`); near(z1, e.z[1], 0.0051, `${label} #${e.n} top`);
    assert(/cannot step over/.test(c[8]) === e.noStep, `${label} #${e.n}: note "${c[8]}" (cannot step over expected ${e.noStep})`);
    if (e.type === 'overhead') assert(/overhead/.test(c[8]), `${label} #${e.n}: overhead note ${c[8]}`);
    // Plan: every drawn corner is one of the expected corners (order-free).
    const pg = s.polygons.find(x => x.id === `sheet-box-${e.n}`);
    assert(pg && pg.points.length === 4, `${label} #${e.n}: polygon missing`);
    assert(pg.cls === (e.type === 'overhead' ? 'box-overhead' : 'box-ground'), `${label} #${e.n}: polygon class ${pg.cls}`);
    for (const pt of pg.points.map(p => toFrame(s, p))) {
      const d = Math.min(...e.corners.map(c2 => Math.hypot(c2[0] - pt[0], c2[1] - pt[1])));
      worst.svg = Math.max(worst.svg, d);
      assert(d < 0.01, `${label} #${e.n}: plotted corner ${pt.map(v => v.toFixed(3))} is ${d.toFixed(3)} m from every expected corner`);
    }
  });
  assert(s.scaleMetres === 1 && s.scale > 10, `${label}: scale bar ${s.scale} px for ${s.scaleMetres} m`);
  const g = toFrame(s, s.goal);
  near(g[0], line.a, 0.01, `${label}: plotted goal ahead`); near(g[1], line.l, 0.01, `${label}: plotted goal left`);
  near(s.goal[2] / s.scale, 0.4, 0.005, `${label}: plotted arrival radius`);
  assert(/^H7/.test(s.ladder ?? ''), `${label}: ladder ${s.ladder}`);
  assert(/1 overhead obstacle \(#2\)/.test(s.overheadWarning ?? ''), `${label}: overhead warning ${s.overheadWarning}`);
  return { worst, line: line.line, distance: line.d };
}

// ---------------------------------------------------------------- run
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
let arenaId = null, xssId = null;

await R.check('S1', 'Save an arena with a rotated wall, an overhead beam, a low box and 4 presets (one at 30°, one at 90°) through the API', async () => {
  const saved = await post('/api/arenas', { label: LABEL, kind: 'boxes', frame_id: 'world', units: 'm', boxes: BOX, presets: PRESETS });
  arenaId = saved.id;
  assert(/^arena-/.test(arenaId) && saved.presets.length === 4 && saved.boxes.length === 3, `saved ${JSON.stringify(saved).slice(0, 300)}`);
  return { id: arenaId, sha256: saved.sha256 };
});

await R.check('S2', 'Sheet, preset 1 (start yaw 30°): table, plan corners, goal and console line match the independent transform', async () => {
  assert(await openSheet(page, arenaId, 1) === 'ready', 'sheet did not load');
  const s = await readSheet(page);
  const out = checkGeometry(s, PRESETS[1], 'preset 1');
  assert(/--odom leg/.test(s.console), 'a 2.86 m goal keeps --odom leg');
  assert(/No rehearsal yet for this preset/.test(s.noRehearsal ?? ''), `no-rehearsal state: ${s.noRehearsal}`);
  assert(s.printButton?.visible && !s.printButton.disabled, `Print button ${JSON.stringify(s.printButton)}`);
  const bg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  assert(bg === 'rgb(11, 15, 21)', `screen background ${bg} (styles.css --bg)`);
  await page.screenshot({ path: path.join(EVIDENCE, 'sheet-screen.png'), fullPage: true });
  return { ...out, rows: s.rows, shot: path.join(EVIDENCE, 'sheet-screen.png') };
});

await R.check('S3', 'Sheet, preset 2 (facing +y): hand-derived values, and the plan has ahead up and left to the left', async () => {
  assert(await openSheet(page, arenaId, 2) === 'ready', 'sheet did not load');
  const s = await readSheet(page);
  const out = checkGeometry(s, PRESETS[2], 'preset 2');
  // Facing +y from (1.0, -2.2): the goal (1.0, -0.6) is 1.6 m straight ahead; the low box at (1.2, -1.2) is 1.0 m ahead and 0.2 m to the right.
  assert(s.goalText === '1.60 m ahead · 0.00 m left', `goal ${s.goalText}`);
  assert(s.rows[2][2] === '1.00' && s.rows[2][3] === '-0.20', `low box ${s.rows[2].join(' | ')}`);
  const box3 = s.polygons.find(p => p.id === 'sheet-box-3').points, cx = box3.reduce((a, p) => a + p[0], 0) / 4, cy = box3.reduce((a, p) => a + p[1], 0) / 4;
  assert(cy < s.origin[1] && cx > s.origin[0], `box 3 should be drawn above (ahead) and right of the start: centre ${cx},${cy} vs start ${s.origin}`);
  assert(s.goal[1] < s.origin[1] && Math.abs(s.goal[0] - s.origin[0]) < 0.5, `goal should be straight above the start: ${s.goal} vs ${s.origin}`);
  return out;
});

await R.check('S4', 'Sheet, preset 3 (5.35 m diagonal): the line switches to --odom zmq and says why', async () => {
  assert(await openSheet(page, arenaId, 3) === 'ready', 'sheet did not load');
  const s = await readSheet(page);
  const out = checkGeometry(s, PRESETS[3], 'preset 3');
  assert(/--odom zmq/.test(s.console), s.console);
  const warn = await page.locator('#sheet-command .callout.warning').allTextContents();
  assert(warn.some(w => /beyond the 3 m.*--odom zmq.*Point-LIO/.test(w)), `warnings ${JSON.stringify(warn)}`);
  return { ...out, warn };
});

await R.check('S5', 'Print layout: black on white, no Print button, no horizontal overflow, A4 and Letter PDFs fit in ≤ 2 pages', async () => {
  assert(await openSheet(page, arenaId, 1) === 'ready', 'sheet did not load');
  await page.setViewportSize({ width: 703, height: 980 });   // printable width of A4 with 12 mm margins at 96 dpi
  await page.emulateMedia({ media: 'print' });
  const p = await page.evaluate(() => {
    const W = document.documentElement.clientWidth, b = document.querySelector('#sheet-print');
    const over = [...document.querySelectorAll('body *')].filter(e => { const r = e.getBoundingClientRect(); return r.width && r.right > W + 0.5; }).map(e => `${e.tagName}#${e.id}.${e.className?.baseVal ?? e.className}`).slice(0, 8);
    const plan = document.querySelector('#sheet-plan').getBoundingClientRect();
    return { W, scrollW: document.documentElement.scrollWidth, over, bg: getComputedStyle(document.body).backgroundColor, ink: getComputedStyle(document.querySelector('#sheet-title')).color,
      printVisible: !!b?.offsetParent, toolbar: getComputedStyle(document.querySelector('.sheet-toolbar')).display, planH: plan.height,
      boxFill: getComputedStyle(document.querySelector('#sheet-box-1')).fill, consoleInk: getComputedStyle(document.querySelector('#sheet-console')).color };
  });
  await page.screenshot({ path: path.join(EVIDENCE, 'sheet-print.png'), fullPage: true });
  const pages = await printPages('sheet');
  await page.setViewportSize({ width: 1400, height: 1000 });
  assert(!p.printVisible && p.toolbar === 'none', `Print button visible in print (${JSON.stringify(p)})`);
  assert(p.bg === 'rgb(255, 255, 255)' && p.ink === 'rgb(0, 0, 0)' && p.consoleInk === 'rgb(0, 0, 0)', `print colours ${p.bg} / ${p.ink} / ${p.consoleInk}`);
  assert(p.scrollW <= p.W && !p.over.length, `overflow: scrollWidth ${p.scrollW} > ${p.W}; elements ${p.over.join(', ')}`);
  assert(p.planH <= 88 * 96 / 25.4 + 1, `plan ${p.planH} px taller than 88 mm`);
  assert(fitsTwo(pages), `pages ${JSON.stringify(pages)}`);
  return { ...p, pages, shot: path.join(EVIDENCE, 'sheet-print.png') };
});

await R.check('S5b', 'A 16-pillar arena still prints on ≤ 2 pages (A4 and Letter), every obstacle listed', async () => {
  const pillars = [];
  for (const x of [1.2, 2.0, 2.8, 3.6]) for (const y of [-1.5, -0.5, 0.5, 1.5]) pillars.push({ center_xy: [x, y], half_xy: [0.15, 0.15], yaw: 0, z_bottom: 0, z_top: 1.2 });
  const saved = await post('/api/arenas', { label: `${LABEL} · 16 pillars`, kind: 'boxes', frame_id: 'world', units: 'm', boxes: pillars,
    presets: [{ label: 'Through the grid', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [4.8, 0] }] });
  assert(await openSheet(page, saved.id, 0) === 'ready', 'sheet did not load');
  const rows = await page.locator('#sheet-obstacles tbody tr').count();
  const pages = await printPages('sheet-16-pillars');
  assert(rows === 16 && fitsTwo(pages), `rows ${rows}, pages ${JSON.stringify(pages)}`);
  return { id: saved.id, rows, pages };
});

await R.check('S6', 'User text is escaped (arena and preset labels with markup)', async () => {
  const label = 'Sheet <img src=x onerror="window.__sheetXss=1"> & "q"';
  const saved = await post('/api/arenas', { label, kind: 'boxes', frame_id: 'world', units: 'm', boxes: [], presets: [{ label: '<b>bold</b> preset', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [2, 0] }] });
  xssId = saved.id;
  assert(await openSheet(page, xssId, 0) === 'ready', 'sheet did not load');
  const r = await page.evaluate(() => ({ title: document.querySelector('#sheet-title').textContent, preset: document.querySelector('#sheet-preset-label').textContent,
    imgs: document.querySelectorAll('#sheet-root img, #sheet-root b').length, xss: window.__sheetXss ?? null, docTitle: document.title,
    rows: document.querySelectorAll('#sheet-obstacles tbody tr').length, empty: /No obstacles: open floor/.test(document.querySelector('#sheet-obstacle-section').textContent),
    ladder: document.querySelector('#sheet-ladder').textContent }));
  assert(r.title === label && r.preset === '<b>bold</b> preset' && !r.imgs && r.xss === null, JSON.stringify(r));
  assert(r.empty && /^H5/.test(r.ladder), `empty arena: ${JSON.stringify(r)}`);
  return r;
});

await R.check('S7', 'Bad links explain themselves: unknown arena (404) and a preset index out of range', async () => {
  assert(await openSheet(page, 'arena-000000000000', 0) === 'error', 'unknown arena did not show an error');
  const unknown = await page.locator('#sheet-error').textContent();
  assert(await openSheet(page, arenaId, 9) === 'error', 'preset 9 did not show an error');
  const range = await page.locator('#sheet-error').textContent();
  const links = await page.locator('#sheet-root a[href*="sheet.html"]').count();
  assert(/could not be loaded/.test(unknown) && /Preset 9 does not exist .* \(it has 4\)/.test(range) && links === 4, `${unknown} / ${range} / links ${links}`);
  return { unknown, range, links };
}, { expectHttp: [/^404 .*\/api\/map\?id=arena-000000000000/] });

await R.check('S8', 'Arena panel: Build sheet is disabled with a tooltip on an unsaved draft and opens the active preset of a saved arena in a new tab', async () => {
  await page.goto(`${BASE}/`);
  await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-sheet'); await sleep(300);
  const draft = { disabled: await page.locator('#arena-sheet').isDisabled(), title: await page.locator('#arena-sheet').getAttribute('title'), saved: await page.evaluate(() => window.__studio.arena.savedId) };
  await page.selectOption('#arena-base', `map:${arenaId}`);
  await page.waitForFunction(id => window.__studio.arena.savedId === id, arenaId, { timeout: 20000 });
  await page.click('[data-preset-select="1"]'); await sleep(150);
  const saved = { disabled: await page.locator('#arena-sheet').isDisabled(), title: await page.locator('#arena-sheet').getAttribute('title') };
  await R.shot('arena-panel');
  const [tab] = await Promise.all([context.waitForEvent('page', { timeout: 20000 }), page.click('#arena-sheet')]);
  R.watch(tab);
  await tab.waitForFunction(() => ['ready', 'error'].includes(document.body?.dataset.state), null, { timeout: 60000 });
  const opened = { url: tab.url(), state: await tab.evaluate(() => document.body.dataset.state), preset: await tab.locator('#sheet-preset-label').textContent(), opener: await tab.evaluate(() => window.opener === null) };
  await tab.close(); R.use(page);
  // Any geometry edit makes it a draft again.
  await page.fill('#preset-gx', '3.05'); await page.locator('#preset-gx').dispatchEvent('change'); await sleep(200);
  const edited = { disabled: await page.locator('#arena-sheet').isDisabled(), title: await page.locator('#arena-sheet').getAttribute('title') };
  assert(!draft.saved && draft.disabled && /Save the arena first/.test(draft.title ?? ''), `draft ${JSON.stringify(draft)}`);
  assert(!saved.disabled && /build sheet/i.test(saved.title ?? ''), `saved ${JSON.stringify(saved)}`);
  assert(opened.url === sheetUrl(arenaId, 1) && opened.state === 'ready' && opened.preset === PRESETS[1].label && opened.opener, `opened ${JSON.stringify(opened)}`);
  assert(edited.disabled && /Save the arena first/.test(edited.title ?? ''), `after an edit ${JSON.stringify(edited)}`);
  return { draft, saved, opened, edited };
});

let job = null;
await R.check('S9', 'Rehearsal evidence: one short bundle run of preset 0 appears with its Wilson interval; preset 1 still says no rehearsal', async () => {
  if (process.env.SHEET_RUN === '0') return R.blocked('SHEET_RUN=0: simulation run skipped');
  const policies = (await api(page, '/api/policies')).body?.policies ?? [];
  const bundle = policies.find(p => p.loader === 'deploy-bundle');
  if (!bundle?.available) return R.blocked(`frozen bundle profile unavailable: ${JSON.stringify(bundle?.missing ?? 'not listed')}`);
  const q = PRESETS[0];
  const scen = await post('/api/scenarios', { backend_id: 'flow-sonic-cpu', map_id: arenaId, label: `${LABEL} · ${q.label}`, preset_label: q.label, duration_s: 5,
    start_xy: q.start_xy, goal_xy: q.goal_xy, start_yaw_rad: q.start_yaw_rad, seed: 0, policy_id: bundle.id, planner: { candidates: 2, ode_steps: 4 } });
  job = await post('/api/jobs', { scenario_id: scen.scenario.id });
  let status = null;
  for (const t0 = Date.now(); Date.now() - t0 < 300000; await sleep(2000)) {
    status = (await api(page, `/api/jobs?id=${job.id}&light=1`)).body?.status;
    if (['completed', 'failed', 'cancelled'].includes(status)) break;
  }
  assert(status === 'completed', `job ${job.id} ended ${status}`);
  const row = (await api(page, '/api/runs')).body.runs.find(r => r.id === job.id);
  assert(row?.outcome, `run row ${JSON.stringify(row)?.slice(0, 300)}`);
  const k = row.outcome === 'goal_completion' ? 1 : 0, ci = wilson(k, 1), ciText = `${k}/1 ${k ? 100 : 0}% [${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%]`;
  assert(await openSheet(page, arenaId, 0) === 'ready', 'sheet did not load');
  const s = await readSheet(page);
  const cond = await page.locator('#sheet-conditions tbody tr').allTextContents();
  const runs = await page.locator('#sheet-runs tbody tr').count();
  await page.screenshot({ path: path.join(EVIDENCE, 'sheet-evidence.png'), fullPage: true });
  const pages = await printPages('sheet-evidence');
  assert(fitsTwo(pages), `with evidence: pages ${JSON.stringify(pages)}`);
  assert(cond.length === 1 && cond[0].replace(/\s+/g, ' ').includes(ciText), `condition row "${cond[0]}" lacks "${ciText}"`);
  assert(/robot console policy/.test(cond[0]) && /K2\/ODE4/.test(cond[0]) && /0 ms/.test(cond[0]), `condition row ${cond[0]}`);
  assert(runs === 1 && s.paths === 1 && !s.noRehearsal, `runs ${runs}, plotted paths ${s.paths}`);
  assert(await openSheet(page, arenaId, 1) === 'ready', 'preset 1 sheet did not load');
  const other = await readSheet(page);
  assert(/No rehearsal yet/.test(other.noRehearsal ?? '') && /1 run on other presets/.test(other.evidence ?? ''), `preset 1 evidence: ${other.evidence}`);
  return { job: job.id, outcome: row.outcome, final_m: row.metrics.final_goal_distance_m, expected: ciText, pages, condition: cond[0].replace(/\s+/g, ' '), shot: path.join(EVIDENCE, 'sheet-evidence.png') };
});

await R.save({ arenaId, xssId, job: job?.id ?? null });
await browser.close();
