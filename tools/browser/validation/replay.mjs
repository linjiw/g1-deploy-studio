// Sections 1, 2, 6, 7, 9: replay cockpit, inspector, sensors, system and performance.
// Read-only: no worker is launched. Uses job recordings produced by rehearse.mjs.
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/replay.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, near, ready, open, seek, api, sleep, readJson } from './harness.mjs';

const fixture = await readJson(path.join(EVIDENCE, 'rehearse-jobs.json')).catch(() => ({ jobs: {} }));
const { browser, context } = await launch();
let page = await context.newPage();
const R = recorder(process.env.ONLY ? 'replay-b' : 'replay');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const check0 = R.check; R.check = (id, ...rest) => (!ONLY || ONLY.has(id)) ? check0(id, ...rest) : null;
R.watch(page);
const S = () => page.evaluate(() => ({ id: window.__studio.state.sessionId, time: window.__studio.state.time, playing: window.__studio.state.playing, speed: window.__studio.state.speed,
  loop: window.__studio.state.loop, camera: window.__studio.camera, robotView: document.getElementById('robot-view').getAttribute('aria-pressed') === 'true',
  tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.tab, duration: window.__studio.state.session?.metadata?.duration_s, t0: window.__studio.state.session?.frames?.[0]?.time,
  workspace: window.__studio.state.workspace, map: document.getElementById('layer-perception').checked }));
const scene = fn => page.evaluate(fn);
const body = () => page.evaluate(() => document.activeElement?.blur());
async function unpinAll() { for (let i = 0; i < 6 && await page.locator('#sensor-dock [data-pin-sensor]').count(); i++) { await page.locator('#sensor-dock [data-pin-sensor]').first().click(); await sleep(250); } }
const sessions = (await api(page, '/api/sessions')).body.sessions;
const jobsList = sessions.filter(s => s.group === 'CPU rehearsals' && s.outcome);
const bundleJob = fixture.jobs.bundle && sessions.some(s => s.id === fixture.jobs.bundle) ? fixture.jobs.bundle : jobsList.find(s => s.policy_id === 'flow-bundle-20261008')?.id;
const wxJob = fixture.jobs.wx200 && sessions.some(s => s.id === fixture.jobs.wx200) ? fixture.jobs.wx200 : jobsList.find(s => s.policy_id === 'flow-wx-rf-23326aa-s0')?.id;
console.log('jobs', { bundleJob, wxJob });

await page.goto(`${BASE}/?session=sonic-lockstep`);
await ready(page, 'sonic-lockstep');

await R.check('1.1', 'Session picker: groups, outcome marks, policy and id suffix', async () => {
  const groups = await page.locator('#session-picker optgroup').evaluateAll(gs => gs.map(g => ({ label: g.label, options: [...g.querySelectorAll('option')].map(o => ({ v: o.value, t: o.textContent, d: o.disabled })) })));
  const labels = groups.map(g => g.label);
  assert(labels.includes('Recordings'), `groups ${labels}`);
  if (!jobsList.length) return R.blocked('No owned job recordings in the validation data root', { groups });
  assert(labels[0] === 'CPU rehearsals', `CPU rehearsals first: ${labels}`);
  const cpu = groups[0].options;
  for (const s of sessions.filter(s => s.group === 'CPU rehearsals')) {
    const o = cpu.find(o => o.v === s.id); assert(o, `missing ${s.id}`);
    const mark = { goal_completion: '✓', timeout: '⏱', obstacle_collision: '✕', fall: '✕', runtime_error: '✕' }[s.outcome];
    if (mark) assert(o.t.startsWith(mark), `${s.id} mark ${o.t}`);
    assert(o.t.includes(`#${s.id.slice(-6)}`), `${s.id} id suffix ${o.t}`);
    if (s.policy_id === 'flow-wx-rf-23326aa-s0') assert(/wx-rf-23326aa/.test(o.t), `WX suffix ${o.t}`);
  }
  return { groups: groups.map(g => ({ label: g.label, n: g.options.length, sample: g.options.slice(0, 3).map(o => o.t) })) };
});

await R.check('1.2', 'Open each configured recording and a job recording', async () => {
  const out = {};
  for (const id of ['sonic-lockstep', 'sonic-dds-tutorial', 'wire-local', ...(bundleJob ? [bundleJob] : []), ...(wxJob ? [wxJob] : [])]) {
    const t0 = Date.now(); await open(page, id);
    const title = await page.locator('#session-title').textContent(), dur = await page.locator('#duration-time').textContent(), ticks = await page.locator('#frame-counter').textContent();
    assert(title && title !== 'Opening…' && dur !== '—' && /(tick|sample) \d+ \/ \d+/.test(ticks), `${id}: ${title} ${dur} ${ticks}`);
    out[id] = { title, dur, ticks, ms: Date.now() - t0, shot: await R.shot(`open-${id.replace(/[^a-z0-9-]/gi, '')}`) };
  }
  if (!bundleJob) return R.blocked('no job recording available', out);
  return out;
});

await R.check('1.3', 'Transport buttons: play/pause, restart, step forward/back', async () => {
  await open(page, 'sonic-lockstep'); await seek(page, 1.0);
  await page.click('#step-forward'); let s = await S(); near(s.time, 1.02, 0.0015, 'step forward');
  await page.click('#step-back'); await page.click('#step-back'); s = await S(); near(s.time, 0.98, 0.0015, 'step back');
  await page.click('#play'); await sleep(700); s = await S();
  assert(s.playing && /Pause/.test(await page.locator('#play').textContent()) && await page.locator('#playback-state').textContent() === 'PLAYING', 'playing state');
  await page.click('#play'); const p = await S(); assert(!p.playing && p.time > 1.2, `paused at ${p.time}`);
  await page.click('#restart'); s = await S(); assert(!s.playing && Math.abs(s.time - s.t0) < 1e-9, `restart ${s.time}`);
  return { pausedAt: p.time };
});

await R.check('1.4', 'Keyboard: Space, ←/→, Shift+←/→, J/K/L, F/T/O/G/R, M, 1–7, ?', async () => {
  await open(page, 'sonic-dds-tutorial'); await body(); await seek(page, 10);
  const k = async key => { await page.keyboard.press(key); await sleep(60); return S(); };
  let s = await k('ArrowRight'); near(s.time, 10.02, 0.0015, '→');
  s = await k('ArrowLeft'); near(s.time, 10.0, 0.0015, '←');
  s = await k('Shift+ArrowRight'); near(s.time, 11.0, 0.0015, 'Shift+→');
  s = await k('Shift+ArrowLeft'); near(s.time, 10.0, 0.0015, 'Shift+←');
  s = await k(' '); assert(s.playing, 'Space plays'); s = await k(' '); assert(!s.playing, 'Space pauses');
  s = await k('l'); assert(s.speed === 2, `L → ${s.speed}`); s = await k('l'); assert(s.speed === 4, 'L → 4'); s = await k('l'); assert(s.speed === 4, 'L caps at 4');
  s = await k('j'); assert(s.speed === 2, 'J'); for (let i = 0; i < 4; i++) s = await k('j'); assert(s.speed === 0.25, `J floors at 0.25 (${s.speed})`);
  assert(await page.locator('#speed').inputValue() === '0.25', 'speed select follows');
  await k('l'); await k('l'); s = await k('l'); assert(s.speed === 2, 'speed back to 2');
  await k(' '); s = await k('k'); assert(!s.playing, 'K pauses');
  await page.keyboard.press('j'); await page.keyboard.press('j'); await page.keyboard.press('l'); // back to 1
  for (const [key, cam] of [['f', 'follow'], ['t', 'top'], ['o', 'orbit'], ['g', 'scene']]) { s = await k(key); assert(s.camera === cam, `${key} → ${s.camera}`);
    assert(await page.locator(`[data-camera="${cam}"]`).getAttribute('aria-pressed') === 'true', `${cam} pressed`); }
  s = await k('r'); assert(s.robotView, 'R robot view on'); s = await k('r'); assert(!s.robotView, 'R off');
  assert(!(await page.locator('#layer-perception').isDisabled()), 'DDS tutorial has a map');
  s = await k('m'); assert(s.map, 'M map on'); s = await k('m'); assert(!s.map, 'M map off');
  const tabs = ['intent', 'joints', 'health', 'perception', 'pipeline', 'graph', 'source'];
  for (let i = 1; i <= 7; i++) { s = await k(String(i)); assert(s.tab === tabs[i - 1], `${i} → ${s.tab}`); }
  await k('1');
  s = await k('?'); assert(await page.locator('#help-overlay').isVisible(), '? opens help'); await k('?'); assert(await page.locator('#help-overlay').isHidden(), '? closes help');
  return { ok: true };
});

await R.check('1.4b', 'Shortcuts do not fire while typing in inputs/selects', async () => {
  await body(); const s0 = await S();
  await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-seed');
  await page.click('#rh-seed'); await page.keyboard.type('3f 7r?'); await page.keyboard.press('ArrowRight');
  const s1 = await S();
  assert(s1.tab === s0.tab && s1.camera === s0.camera && !s1.playing && !s1.robotView && Math.abs(s1.time - s0.time) < 1e-9 && await page.locator('#help-overlay').isHidden(), `typing fired shortcuts ${JSON.stringify([s0, s1])}`);
  await page.fill('#rh-seed', '0'); await page.locator('#rh-seed').dispatchEvent('change');
  await page.click('#workspace-replay'); await page.click('#tab-joints'); await page.focus('#joint-select'); await page.keyboard.press('3');
  const s2 = await S(); assert(s2.tab === 'joints', `select focus fired tab key: ${s2.tab}`);
  await page.click('#tab-intent'); await body();
  return { s0, s1 };
});

await R.check('1.5', 'Speed and loop', async () => {
  await open(page, 'sonic-lockstep'); await body();
  const rateAt = async v => { await page.selectOption('#speed', v); await seek(page, 0.3);
    const r = await page.evaluate(async () => { const t0 = window.__studio.state.time, w0 = performance.now(); window.__studio.setPlaying(true); await new Promise(x => setTimeout(x, 1200)); window.__studio.setPlaying(false); return (window.__studio.state.time - t0) / ((performance.now() - w0) / 1000); });
    return r; };
  const r1 = await rateAt('1'), r2 = await rateAt('2');
  let s = await S(); const rate = r2 / r1;
  assert(rate > 1.6 && rate < 2.4, `2× / 1× playback rate ratio ${rate} (1×: ${r1}, 2×: ${r2})`);
  await page.selectOption('#speed', '1');
  await page.check('#loop'); assert((await S()).loop, 'loop state');
  await seek(page, s.duration - 0.3); await page.click('#play'); await sleep(900); s = await S();
  assert(s.playing && s.time < s.duration - 0.3, `loop wrapped? time ${s.time} playing ${s.playing}`);
  await page.click('#play'); await page.uncheck('#loop');
  await seek(page, s.duration - 0.2); await page.click('#play'); await sleep(800); s = await S();
  assert(!s.playing && Math.abs(s.time - s.duration) < 1e-6, `stops at end ${s.time}/${s.duration} ${s.playing}`);
  assert(/loop/.test(page.url()) === false, 'loop removed from URL');
  return { rate, r1, r2, note: 'absolute rate is frame-capped (dt ≤ 0.25 s) under software GL' };
});

await R.check('1.6', 'Scrub slider seeks', async () => {
  const box = await page.locator('#timeline').boundingBox(); const s0 = await S();
  await page.mouse.click(box.x + box.width * 0.5, box.y + box.height / 2);
  const s = await S(); const expect = s0.t0 + (s0.duration - s0.t0) * 0.5;
  near(s.time, expect, (s0.duration - s0.t0) * 0.03, 'slider midpoint');
  return { time: s.time, expect };
});

async function laneX(frac) {
  return page.evaluate(f => { const c = document.getElementById('lanes-canvas'), r = c.getBoundingClientRect(), lw = c.clientWidth < 520 ? 92 : 132;
    return { x: r.left + lw + f * (c.clientWidth - lw - 8), y0: r.top, h: r.height, lanes: 6 }; }, frac);
}
await R.check('1.7', 'Lanes canvas: click and drag seek; hover tooltip', async () => {
  await open(page, bundleJob ?? 'sonic-lockstep');
  const s0 = await S(); const span = s0.duration - s0.t0;
  let g = await laneX(0.25); await page.mouse.click(g.x, g.y0 + g.h * 0.3);
  let s = await S(); near(s.time, s0.t0 + 0.25 * span, span * 0.01 + 0.005, 'lane click');
  g = await laneX(0.2); const g2 = await laneX(0.7);
  await page.mouse.move(g.x, g.y0 + 10); await page.mouse.down(); await page.mouse.move(g2.x, g.y0 + 10, { steps: 8 }); await page.mouse.up();
  s = await S(); near(s.time, s0.t0 + 0.7 * span, span * 0.01 + 0.005, 'lane drag');
  const laneH = (g.h - 4) / 6;
  await page.mouse.move(g.x + 40, g.y0 + 2 + laneH * 2.5); await sleep(150);
  const tip = await page.locator('#lanes-tip').isVisible() ? await page.locator('#lanes-tip').textContent() : null;
  assert(tip && /Planner compute|not captured/.test(tip), `tooltip ${tip}`);
  await page.mouse.move(g.x + 40, g.y0 + 2 + laneH * 1.5); await sleep(100);
  const tip2 = await page.locator('#lanes-tip').textContent();
  assert(/Goal distance/.test(tip2), `goal tooltip ${tip2}`);
  await page.mouse.move(5, 5); await sleep(100);
  assert(await page.locator('#lanes-tip').isHidden(), 'tooltip hides on leave');
  return { tip, tip2, shot: await R.shot('lanes') };
});

await R.check('1.8', 'Hide lanes toggle', async () => {
  const h0 = (await page.locator('.lanes').boundingBox())?.height ?? 0;
  await page.click('#lanes-toggle'); await sleep(200);
  const collapsed = await page.evaluate(() => document.body.classList.contains('lanes-collapsed'));
  const h1 = (await page.locator('.lanes').boundingBox())?.height ?? 0;
  const text = await page.locator('#lanes-toggle').textContent();
  const shot = await R.shot('lanes-hidden');
  await page.click('#lanes-toggle'); await sleep(200);
  const h2 = (await page.locator('.lanes').boundingBox())?.height ?? 0;
  assert(collapsed && text === 'Show lanes' && h1 < h0 * 0.5 && Math.abs(h2 - h0) < 2, `lanes ${h0} → ${h1} → ${h2} ${text}`);
  return { h0, h1, h2, shot };
});

await R.check('1.9', 'Camera buttons incl. Fit shows start+goal; Orbit auto-recenters during playback', async () => {
  const id = (await page.evaluate(() => window.__studio.state.session.frames.length)) && 'perf-large-job';
  await open(page, id); await body();
  for (const cam of ['top', 'follow', 'orbit', 'scene']) { await page.click(`#camera-${cam}`); assert((await S()).camera === cam && await page.locator(`#camera-${cam}`).getAttribute('aria-pressed') === 'true', cam); }
  await sleep(1500); // projection matrices update on the next render; software GL renders slowly
  const markers = await page.evaluate(() => window.__studio.navigationScreen);
  assert(markers.length >= 2 && markers.every(m => Math.abs(m.ndc[0]) <= 1 && Math.abs(m.ndc[1]) <= 1), `Fit markers ${JSON.stringify(markers)}`);
  const fitShot = await R.shot('camera-fit');
  // Orbit: reset on the robot at the start, play at 4×, the robot must stay in frame.
  await seek(page, 0); await page.click('#camera-orbit'); await page.selectOption('#speed', '4'); await body(); await sleep(800);
  await page.evaluate(() => window.__studio.setPlaying(true));
  const ndcs = [], samples = [];
  for (let i = 0; i < 9; i++) { await sleep(500); const r = await page.evaluate(() => { const s = window.__studio.state, p = s.measuredFrame.position; return { t: s.time, xy: [p[0], p[1]], ndc: window.__studio.projectWorld([[p[0], p[1], 0.7]])[0] }; }); samples.push(r); ndcs.push(r.ndc); }
  await page.evaluate(() => window.__studio.setPlaying(false)); await page.selectOption('#speed', '1');
  const travelled = await page.evaluate(() => { const f = window.__studio.state.session.frames, a = f[0].position, b = window.__studio.state.measuredFrame.position; return Math.hypot(b[0] - a[0], b[1] - a[1]); });
  const worstOf = a => Math.max(...a.map(n => Math.max(Math.abs(n[0]), Math.abs(n[1]))));
  const worst = worstOf(ndcs), last = worstOf(ndcs.slice(-4));
  assert(travelled > 1.5, `robot travelled only ${travelled} m during the Orbit test`);
  // With software GL (~3 fps) a sample can briefly exceed the frame before the next recenter; the robot must be back in frame.
  assert(last < 0.9, `robot not recentred in Orbit: |ndc| of the last samples ${last} after ${travelled} m`);
  return { travelled, worst, samples: samples.map(r => ({ t: +r.t.toFixed(2), xy: r.xy.map(v => +v.toFixed(2)), ndc: r.ndc.slice(0, 2).map(v => +v.toFixed(2)) })), fitShot, camAfterPlay: (await S()).camera };
});

await R.check('1.10', 'Robot view inset renders', async () => {
  await seek(page, 3); const d0 = await page.evaluate(() => window.__studio.sceneDrawCount);
  await page.click('#robot-view'); await sleep(500);
  const label = await page.locator('#robot-view-label').isVisible(), pressed = await page.locator('#robot-view').getAttribute('aria-pressed');
  const d1 = await page.evaluate(() => window.__studio.sceneDrawCount);
  const shot = await R.shot('robot-view');
  await page.click('#robot-view');
  assert(label && pressed === 'true' && d1 > d0, `label ${label} pressed ${pressed} draws ${d0}→${d1}`);
  return { shot, url: page.url() };
});

await R.check('1.11', 'Layers popover: each layer toggles its object; unavailable layers disabled', async () => {
  await open(page, bundleJob ?? 'sonic-lockstep'); await seek(page, 1.0);
  await page.click('#layers-button'); assert(await page.locator('#layers-popover').isVisible(), 'popover opens');
  const probe = () => page.evaluate(async () => { const v = (await import('/js/scene.js')).view;
    return { robot: v.robot?.root.visible, reference: v.ghost?.root.visible, refLine: v.lines.reference?.visible, future: v.futures.every(p => p.root.visible), futureLine: v.lines.future?.visible,
      trajectory: v.lines.trajectory?.visible && v.lines.travelled?.visible, environment: v.environment?.visible, navigation: Object.values(v.markers).every(m => m.visible) && Object.keys(v.markers).length > 0,
      perception: v.mapLayer?.visible, sensors: v.sensorLayer?.visible, frames: v.worldAxes?.visible && v.robotAxes?.visible }; });
  const base = await probe(); const out = { base };
  const map = { robot: ['robot'], reference: ['reference', 'refLine'], future: ['future', 'futureLine'], trajectory: ['trajectory'], environment: ['environment'], navigation: ['navigation'], sensors: ['sensors'], frames: ['frames'] };
  for (const [layer, keys] of Object.entries(map)) {
    if (await page.locator(`#layer-${layer}`).isDisabled()) { out[layer] = 'disabled'; continue; }
    await page.uncheck(`#layer-${layer}`); const off = await probe();
    await page.check(`#layer-${layer}`); const on = await probe();
    for (const k of keys) assert(off[k] === false && on[k] === true, `${layer}: ${k} off=${off[k]} on=${on[k]}`);
    // Other layers are unaffected.
    for (const [k, v] of Object.entries(base)) if (!keys.includes(k) && v !== undefined && !['refLine', 'futureLine'].includes(k)) assert(off[k] === v, `${layer} toggled ${k}`);
    out[layer] = 'ok';
  }
  if (!(await page.locator('#layer-perception').isDisabled())) { await page.check('#layer-perception'); const p = await probe(); await page.uncheck('#layer-perception'); assert(p.perception === true, 'perception layer'); out.perception = 'ok'; }
  await page.click('#layers-button');
  // Disabled states.
  await open(page, 'sonic-dds-tutorial');
  const dds = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#layers-popover input')].map(i => [i.id, i.disabled])));
  await open(page, 'wire-local');
  const wire = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#layers-popover input')].map(i => [i.id, i.disabled])));
  await open(page, 'sonic-lockstep');
  const lock = await page.evaluate(() => ({ ...Object.fromEntries([...document.querySelectorAll('#layers-popover input')].map(i => [i.id, i.disabled])), perception: window.__studio.state.session.perception?.available ?? false }));
  assert(dds['layer-reference'] && !dds['layer-robot'] && !dds['layer-perception'], `dds ${JSON.stringify(dds)}`);
  assert(['robot', 'reference', 'future', 'trajectory', 'environment', 'frames', 'perception'].every(l => wire[`layer-${l}`]), `wire ${JSON.stringify(wire)}`);
  assert(lock['layer-perception'] === !lock.perception, `lockstep perception ${JSON.stringify(lock)}`);
  return { ...out, dds, wire, lock };
});

await R.check('1.11b', 'Navigation layer is disabled when the recording has no start/goal', async () => {
  const wire = await page.evaluate(() => 0);
  await open(page, 'wire-local');
  const d = await page.locator('#layer-navigation').isDisabled(), sensorsD = await page.locator('#layer-sensors').isDisabled();
  await open(page, 'sonic-lockstep');
  const hasGoal = await page.evaluate(() => !!window.__studio.state.session.metadata.goal_xy), dLock = await page.locator('#layer-navigation').isDisabled();
  assert(d && (hasGoal || dLock), `navigation layer enabled without a goal: wire ${d}, lockstep(goal=${hasGoal}) ${dLock}; pinned-clouds layer on wire ${sensorsD}`);
  return { wire: d, lockstep: dLock, hasGoal, wire0: wire };
});

await R.check('1.12', 'HUD values sane and consistent with the inspector', async () => {
  if (!bundleJob) return R.blocked('no job recording');
  await open(page, bundleJob); await seek(page, 1.5); await page.click('#tab-intent'); await sleep(200);
  const hud = await page.evaluate(() => Object.fromEntries([...document.querySelectorAll('#hud .hud-item')].map(n => [n.querySelector('span').textContent, n.querySelector('strong').textContent])));
  const intent = await page.locator('#intent-content').textContent();
  const dIntent = Number(intent.match(/Distance now([\d.]+) m/)?.[1]);
  const dHud = parseFloat(hud['Goal distance']);
  near(dHud, dIntent, 0.006, 'goal distance HUD vs Intent');
  const meta = await page.evaluate(() => { const f = window.__studio.state.measuredFrame, g = window.__studio.state.session.metadata.goal_xy; return Math.hypot(f.position[0] - g[0], f.position[1] - g[1]); });
  near(dIntent, meta, 0.0006, 'Intent vs frame truth');
  const speed = parseFloat(hud.Speed ?? hud['Speed (fd)']), tilt = parseFloat(hud.Tilt); // v0.3 labels finite-difference speed 'Speed (fd)'
  assert(speed >= 0 && speed < 3 && tilt >= 0 && tilt < 1.6, `speed ${speed} tilt ${tilt}`);
  await page.click('#tab-health'); await sleep(200);
  const health = await page.locator('#health-content').textContent();
  const hc = health.match(/Peak in previous interval([\d.]+) N/)?.[1];
  if (hud.Contact !== '—') near(parseFloat(hud.Contact), Number(hc), 0.051, 'contact HUD vs Health');
  return { hud, dIntent, healthContact: hc };
});

await R.check('1.13', 'Evidence key popover', async () => {
  await page.click('#evidence-button');
  const rows = await page.locator('#evidence-legend .legend-row').count(), exp = await page.locator('#evidence-button').getAttribute('aria-expanded');
  const shot = await R.shot('evidence-key');
  await page.mouse.click(700, 500); await sleep(100);
  const hidden = await page.locator('#evidence-legend').isHidden(), exp2 = await page.locator('#evidence-button').getAttribute('aria-expanded');
  assert(rows === 8 && exp === 'true' && hidden, `rows ${rows} expanded ${exp} hidden ${hidden}`);
  return { rows, ariaAfterClose: exp2, shot };
});

await R.check('1.13b', 'Popover buttons reset aria-expanded when the popover closes', async () => {
  await page.click('#evidence-button'); await page.mouse.click(700, 500); await sleep(100);
  const a = await page.locator('#evidence-button').getAttribute('aria-expanded');
  await page.click('#layers-button'); await page.keyboard.press('Escape'); await sleep(100);
  const b = await page.locator('#layers-button').getAttribute('aria-expanded');
  assert(a === 'false' && b === 'false', `aria-expanded stays "true" after outside click (${a}) / Escape (${b}) — app.js togglePopover/close handlers`);
});

await R.check('1.14', 'Help popover (button, ?, Escape)', async () => {
  await page.click('#help-button'); const v1 = await page.locator('#help-overlay').isVisible();
  const t = await page.locator('#help-overlay').textContent();
  await body(); await page.keyboard.press('Escape'); const v2 = await page.locator('#help-overlay').isVisible();
  await page.keyboard.press('?'); const v3 = await page.locator('#help-overlay').isVisible();
  await page.keyboard.press('?'); const v4 = await page.locator('#help-overlay').isVisible();
  assert(v1 && !v2 && v3 && !v4 && /Robot view/.test(t), `help ${[v1, v2, v3, v4]}`);
  return { ok: true };
});

let viewLink = null, rowHighlight = null;
await R.check('1.15', 'View link round trip: session/time/panel/camera/speed/loop/map/pin/robot_view/workspace', async () => {
  if (!bundleJob) return R.blocked('no bundle job recording');
  await open(page, bundleJob); await body();
  await seek(page, 1.234); await page.click('#tab-health'); await page.click('#camera-follow'); await page.selectOption('#speed', '2'); await page.check('#loop');
  await body(); await page.keyboard.press('m'); await page.click('#robot-view');
  await page.click('#workspace-sensors'); await page.waitForSelector('[data-pin-sensor]');
  const pinId = await page.locator('[data-pin-sensor]:not([disabled])').first().getAttribute('data-pin-sensor');
  await page.click(`[data-pin-sensor="${pinId}"]`); await sleep(300);
  await page.click('#copy-view'); await sleep(400);
  viewLink = page.url();
  const p2 = await context.newPage(); R.watch(p2);
  await p2.goto(viewLink); await ready(p2, bundleJob); await sleep(1500);
  const s = await p2.evaluate(() => ({ time: window.__studio.state.time, tab: document.querySelector('[role=tab][aria-selected=true]')?.dataset.tab, camera: window.__studio.camera,
    speed: window.__studio.state.speed, loop: window.__studio.state.loop, map: document.getElementById('layer-perception').checked, robotView: document.getElementById('robot-view').getAttribute('aria-pressed'),
    workspace: window.__studio.state.workspace, dock: document.querySelectorAll('#sensor-dock [data-sensor-card]').length, pins: [...document.querySelectorAll('#sensor-dock [data-sensor-card]')].map(n => n.dataset.sensorCard) }));
  await p2.screenshot({ path: path.join(EVIDENCE, 'replay-view-link-restored.png') });
  R.use(page); await p2.close();
  const bad = [];
  if (Math.abs(s.time - 1.234) > 0.002) bad.push(`time ${s.time}`);
  if (s.tab !== 'health') bad.push(`tab ${s.tab}`);
  if (s.camera !== 'follow') bad.push(`camera ${s.camera}`);
  if (s.speed !== 2) bad.push(`speed ${s.speed}`);
  if (!s.loop) bad.push('loop');
  if (!s.map) bad.push('map');
  if (s.robotView !== 'true') bad.push('robot_view');
  if (s.workspace !== 'sensors') bad.push(`workspace ${s.workspace}`);
  if (!s.pins.includes(pinId)) bad.push(`pin ${pinId} → ${s.pins}`);
  assert(!bad.length, `not restored: ${bad.join('; ')} (link ${viewLink})`);
  return { link: viewLink, restored: s };
});

await R.check('1.16', 'Status bar build id matches /api/version', async () => {
  const v = (await api(page, '/api/version')).body, t = await page.locator('#build-info').textContent();
  assert(t.includes(v.commit.slice(0, 7)), `build ${t} vs ${v.commit}`);
  return { text: t, commit: v.commit, dirty: v.dirty };
});

// ------------------------------------------------------------------ Inspector
await page.click('#workspace-replay').catch(() => {});
await unpinAll();

await R.check('2.1', 'Intent tab', async () => {
  if (!bundleJob) return R.blocked('no job');
  await open(page, bundleJob); await seek(page, 1.0); await page.click('#tab-intent'); await sleep(200);
  const t = await page.locator('#intent-content').textContent();
  for (const s of ['Navigation target', 'Planner selection', 'SONIC reference window', 'Observed execution', 'Distance now', 'Selection rule']) assert(t.includes(s), `missing ${s}`);
  await page.locator('#intent-content .raw-details summary').click();
  const raw = await page.locator('#intent-content .raw-details pre').textContent();
  assert(/joint_names/.test(raw) && /values/.test(raw), 'raw reference values');
  return { shot: await R.shot('intent') };
});

await R.check('2.2', 'Joints tab: row click selects joint; chart cursor follows time', async () => {
  await page.click('#tab-joints'); await sleep(200);
  const rows = await page.locator('.joint-table tr[data-joint]').count();
  await page.click('.joint-table tr[data-joint="7"]');
  const sel = await page.locator('#joint-select').inputValue(), clsNow = await page.locator('.joint-table tr[data-joint="7"]').getAttribute('class');
  await seek(page, 1.02); const cls = await page.locator('.joint-table tr[data-joint="7"]').getAttribute('class');
  rowHighlight = { immediately: clsNow, afterSeek: cls };
  const aria = await page.locator('#joint-chart svg').getAttribute('aria-label');
  const names = await page.evaluate(() => window.__studio.state.session.joint_names);
  const dur = await page.evaluate(() => window.__studio.state.session.metadata.duration_s);
  await seek(page, 0.5); const t1 = (await S()).time, x1 = Number(await page.locator('#joint-cursor').getAttribute('x1'));
  await seek(page, 1.5); const t2 = (await S()).time, x2 = Number(await page.locator('#joint-cursor').getAttribute('x1'));
  assert(rows === 29 && sel === '7' && /selected/.test(cls ?? '') && aria.includes(names[7]), `rows ${rows} sel ${sel} cls(after seek) ${cls} aria ${aria}`);
  near(x1, 30 + t1 / dur * 262, 0.6, 'cursor at t1'); near(x2, 30 + t2 / dur * 262, 0.6, 'cursor at t2'); assert(x2 > x1, 'cursor moves right');
  // Cursor also follows during playback.
  await page.click('#play'); await sleep(500); await page.click('#play');
  const t = await page.evaluate(() => window.__studio.state.time), x3 = Number(await page.locator('#joint-cursor').getAttribute('x1'));
  near(x3, 30 + t / dur * 262, 1.2, 'cursor after playback');
  const v = await page.locator('.joint-table tr[data-joint="7"] [data-c=s]').textContent(), truth = await page.evaluate(() => window.__studio.state.frame.joints[7].toFixed(3));
  assert(v === truth, `joint value ${v} vs ${truth}`);
  return { rows, x1, x2, shot: await R.shot('joints') };
});

await R.check('2.2b', 'Joints: clicking a row highlights it immediately (paused)', async () => {
  if (!rowHighlight) return R.blocked('2.2 did not run');
  assert(/selected/.test(rowHighlight.immediately ?? ''), `row 7 class right after the click: ${rowHighlight.immediately}; after a seek: ${rowHighlight.afterSeek} (inspector.js:72-74 redraws only the chart)`);
  return rowHighlight;
});

await R.check('2.3', 'Health tab: outcome, fidelity, torque, budgets, events seek, held state → STALE', async () => {
  await page.click('#tab-health'); await seek(page, 1.8); await sleep(200);
  const t = await page.locator('#health-content').textContent();
  for (const s of ['Run outcome · whole run', 'Fidelity level', 'Timing vs budget', 'Freshness at cursor', 'Obstacle contact']) assert(t.includes(s), `missing ${s}`);
  const budgets = await page.locator('#health-content .budget').count();
  const torque = await page.locator('#health-content .torque-details').count();
  const ev = page.locator('#health-content .event-control').first();
  let evSeek = null;
  if (await ev.count()) { const target = Number(await ev.getAttribute('data-seek')); await ev.click(); evSeek = { target, time: (await S()).time }; near(evSeek.time, target, 1e-6, 'event seek'); }
  await seek(page, 0.6); await page.check('#freeze-state'); await seek(page, 1.2); await sleep(150);
  const stale = await page.locator('#health-content').textContent(), badge = await page.locator('#source-badge').textContent(), cap = await page.locator('#pose-caption').textContent();
  const shot = await R.shot('health-held');
  await page.uncheck('#freeze-state');
  const after = await page.locator('#source-badge').textContent();
  assert(budgets === 3 && /STALE/.test(stale) && /HELD/.test(badge) && /DIAGNOSTIC HELD STATE/.test(cap) && /SIM-TRUTH/.test(after), `budgets ${budgets} stale ${/STALE/.test(stale)} badge ${badge} after ${after}`);
  // Seeking before the held time releases the hold.
  return { budgets, torque, evSeek, shot };
});

await R.check('2.4', 'Map tab: causal perception (bundle), final-snapshot honesty (DDS), unavailable by design (WX)', async () => {
  await page.click('#tab-perception'); await seek(page, 1.0); await sleep(200);
  const b = await page.locator('#perception-content').textContent();
  assert(/CAUSAL SIMULATED PERCEPTION/.test(b) && /Map snapshot/.test(b) && /Map age at cursor/.test(b), `bundle map ${b.slice(0, 200)}`);
  const shotB = await R.shot('map-bundle');
  await open(page, 'sonic-dds-tutorial'); await page.click('#tab-perception'); await sleep(200);
  const d = await page.locator('#perception-content').textContent();
  assert(/Final snapshot without capture time/.test(d), `dds map ${d.slice(0, 200)}`);
  let w = null;
  if (wxJob) { await open(page, wxJob); await page.click('#tab-perception'); await sleep(200); w = await page.locator('#perception-content').textContent();
    assert(/Privileged WX block/.test(w) && !/support cells|0\s*support/.test(w), `wx map ${w.slice(0, 200)}`); }
  await open(page, 'sonic-lockstep'); await page.click('#tab-perception'); await sleep(200);
  const l = await page.locator('#perception-content').textContent();
  return { bundle: b.slice(0, 120), dds: d.slice(0, 160), wx: w?.slice(0, 200), lockstep: l.slice(0, 160), shotB };
});

await R.check('2.5', 'Pipeline tab: stage buttons, tensors, conditioning maps, block select', async () => {
  if (!bundleJob) return R.blocked('no job');
  await open(page, bundleJob); await seek(page, 1.0); await page.click('#tab-pipeline'); await sleep(300);
  const heads = {};
  for (const [stage, head] of [['sense', 'What the robot sees'], ['flow', 'Flow motion planner'], ['reference', 'Selected reference window'], ['sonic', 'SONIC fused ONNX'], ['control', 'Command and resulting state']]) {
    await page.click(`[data-pipeline-stage="${stage}"]`); await sleep(150);
    const t = await page.locator('#pipeline-content').textContent();
    assert(t.includes(head) && await page.locator(`[data-pipeline-stage="${stage}"]`).getAttribute('aria-pressed') === 'true', `${stage}`);
    heads[stage] = (await page.locator(`[data-pipeline-stage="${stage}"] small`).textContent());
    if (stage === 'flow') {
      const maps = await page.locator('[data-conditioning-channel]').count();
      const drawn = await page.evaluate(() => [...document.querySelectorAll('[data-conditioning-channel]')].some(c => { const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; const s = new Set(); for (let i = 0; i < d.length; i += 64) s.add(d[i]); return s.size > 2; }));
      heads.flowMaps = { maps, drawn, ranges: await page.locator('#pipeline-content').evaluate(n => n.textContent.match(/(support|lateral|overhead) · m[-\d.]+ … [-\d.]+/g)) }; await R.shot('pipeline-flow');
    }
    if (stage === 'sonic') {
      heads.tensors = await page.locator('.pipeline-tensors tbody tr').count();
      const opts = await page.locator('#pipeline-block option').count();
      if (opts > 1) { await page.selectOption('#pipeline-block', '1'); await sleep(150); heads.blockSel = await page.locator('#pipeline-block').inputValue(); }
      await R.shot('pipeline-sonic');
    }
  }
  assert(heads.tensors >= 2 && heads.flowMaps.maps > 0, `pipeline ${JSON.stringify(heads)}`);
  assert(/stage=control/.test(page.url()), 'stage in URL');
  return heads;
});

await R.check('2.5b', 'Pipeline cross-links: "Inspect all joints" and "Open sensor browser"', async () => {
  await page.click('[data-pipeline-stage="control"]'); await sleep(150);
  const j = page.locator('[data-pipeline-tab="joints"]');
  if (await j.count()) { await j.first().click(); await sleep(150); assert((await S()).tab === 'joints', 'joints link'); await page.click('#tab-pipeline'); }
  await page.click('[data-pipeline-stage="sense"]'); await sleep(150);
  const sensorsBtn = page.locator('[data-pipeline-sensors]');
  if (!(await sensorsBtn.count())) return R.blocked('No "Open sensor browser" button rendered for this stage');
  await sensorsBtn.first().click(); await sleep(400);
  const ws = (await S()).workspace;
  await page.click('#workspace-replay').catch(() => {});
  assert(ws === 'sensors', `"Open sensor browser" did not open Sensors (workspace ${ws}); pipeline.js:57 calls window.__workbench.workspace, which app.js never defines`);
  return { ws };
});

await R.check('2.6', 'Graph tab: compact system map, open full map', async () => {
  await page.click('#tab-graph'); await sleep(200);
  const nodes = await page.locator('#graph-map .sys-node').count(), edges = await page.locator('#graph-map .sys-edge').count();
  const t = await page.locator('#graph-content').textContent();
  await page.click('[data-workspace-open="system"]'); await sleep(500);
  const ws = (await S()).workspace, sysNodes = await page.locator('#system-stage .sys-node').count();
  await page.click('#workspace-replay');
  assert(nodes === 10 && edges > 8 && /Discovery boundaries/.test(t) && ws === 'system' && sysNodes === 10, `graph nodes ${nodes} edges ${edges} ws ${ws}`);
  return { nodes, edges };
});

await R.check('2.7', 'Source tab: provenance and MCAP export download', async () => {
  await page.click('#tab-source'); await sleep(200);
  const t = await page.locator('#source-content').textContent();
  assert(/Policy profile/.test(t) && /Identity SHA-256/.test(t) && /Hardware command pathNone/.test(t) && /Source artifacts/.test(t), `source ${t.slice(0, 300)}`);
  const dl = page.waitForEvent('download', { timeout: 120000 }); await page.click('#source-content .export-link'); const d = await dl;
  const file = path.join(EVIDENCE, `export-${bundleJob}.mcap`); await d.saveAs(file);
  const bytes = await readFile(file);
  assert(bytes.length > 1000 && bytes.subarray(0, 8).toString('latin1') === '\x89MCAP0\r\n', `mcap ${bytes.length} bytes magic ${JSON.stringify(bytes.subarray(0, 8).toString('latin1'))}`);
  return { file, bytes: bytes.length, suggested: d.suggestedFilename() };
});

await R.check('2.8', 'Tab arrow-key navigation (wraps; does not step time)', async () => {
  await page.click('#tab-intent'); await page.focus('#tab-intent'); const t0 = (await S()).time;
  await page.keyboard.press('ArrowRight'); const a = await page.evaluate(() => [document.activeElement.id, document.querySelector('[role=tab][aria-selected=true]').id]);
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('ArrowLeft');
  const b = await page.evaluate(() => [document.activeElement.id, document.querySelector('[role=tab][aria-selected=true]').id]);
  const t1 = (await S()).time;
  assert(a[0] === 'tab-joints' && a[1] === 'tab-joints' && b[0] === 'tab-source' && b[1] === 'tab-source' && Math.abs(t1 - t0) < 1e-9, `${a} ${b} time ${t0}→${t1}`);
  const tabindex = await page.locator('#tab-source').getAttribute('tabindex');
  return { a, b, tabindex };
});

await R.check('2.9', 'Inspector resize handle (bounded, persisted)', async () => {
  const w0 = (await page.locator('.inspector').boundingBox()).width, h = await page.locator('#inspector-resize').boundingBox();
  await page.mouse.move(h.x + h.width / 2, h.y + 200); await page.mouse.down(); await page.mouse.move(h.x + h.width / 2 - 120, h.y + 200, { steps: 6 }); await page.mouse.up(); await sleep(200);
  const w1 = (await page.locator('.inspector').boundingBox()).width;
  await page.mouse.move(h.x - 120 + h.width / 2, h.y + 200); await page.mouse.down(); await page.mouse.move(h.x - 2000, h.y + 200, { steps: 6 }); await page.mouse.up(); await sleep(200);
  const w2 = (await page.locator('.inspector').boundingBox()).width;
  const saved = await page.evaluate(() => localStorage.getItem('studio.inspector'));
  await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  const w3 = (await page.locator('.inspector').boundingBox()).width;
  await page.evaluate(() => localStorage.removeItem('studio.inspector')); await page.reload(); await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  near(w1, w0 + 120, 3, 'resize +120'); assert(Math.abs(w2 - 720) < 3, `clamped to 720: ${w2}`); near(w3, 720, 3, 'persisted after reload');
  return { w0, w1, w2, w3, saved };
});

// ------------------------------------------------------------------ Sensors
await R.check('6.1', 'Sensors list: available and unavailable sources with reasons', async () => {
  if (!bundleJob) return R.blocked('no job');
  await open(page, bundleJob); await seek(page, 1.0);
  await page.click('#workspace-sensors'); await page.waitForSelector('[data-sensor-card]'); await sleep(500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#sensors-panel [data-sensor-card]')].map(n => ({ id: n.dataset.sensorCard, state: n.querySelector('.sensor-state').textContent, reason: n.querySelector('.sensor-reason')?.textContent ?? null, pin: !n.querySelector('[data-pin-sensor]').disabled })));
  const avail = cards.filter(c => c.pin), missing = cards.filter(c => c.reason);
  assert(avail.length >= 3 && missing.length >= 1 && missing.every(c => c.reason.length > 10), `cards ${JSON.stringify(cards)}`);
  return { cards, shot: await R.shot('sensors-list') };
});

await R.check('6.2', 'Pin up to 3; the 4th is refused with a message', async () => {
  const ids = await page.locator('#sensors-panel [data-pin-sensor]:not([disabled])').evaluateAll(b => b.map(x => x.dataset.pinSensor));
  for (const id of ids.slice(0, 3)) { await page.click(`#sensors-panel [data-pin-sensor="${id}"]`); await sleep(250); }
  const dock = await page.locator('#sensor-dock [data-sensor-card]').count();
  await page.click(`#sensors-panel [data-pin-sensor="${ids[3]}"]`); await sleep(250);
  const banner = await page.locator('#error-banner').textContent(), dock2 = await page.locator('#sensor-dock [data-sensor-card]').count();
  assert(dock === 3 && dock2 === 3 && /Unpin a view first/.test(banner) && /pin=/.test(page.url()), `dock ${dock}/${dock2} banner ${banner}`);
  return { pinned: ids.slice(0, 3), banner, shot: await R.shot('sensors-pinned') };
});

await R.check('6.3', 'Pinned dock cards update while playing', async () => {
  await page.click('#workspace-replay'); await sleep(300);
  const snap = () => page.evaluate(() => [...document.querySelectorAll('#sensor-dock [data-sensor-card]')].map(n => n.textContent).join('|'));
  const before = await snap(), cursor0 = await page.evaluate(() => window.__studio.state.time);
  await page.click('#play'); await sleep(1500); const during = await snap(); await page.click('#play'); await sleep(600);
  const after = await snap();
  assert(before !== during || before !== after, 'dock text unchanged after 1.5 s of playback');
  return { cursor0 };
});

await R.check('6.4', "Pinned point clouds overlay the scene and follow the Layers toggle", async () => {
  await unpinAll();
  await page.click('#workspace-sensors'); await page.waitForSelector('[data-sensor-card]'); await sleep(400);
  for (const id of ['lidar_filtered', 'lidar_raw']) if (await page.locator(`#sensors-panel [data-pin-sensor="${id}"]:not([disabled])`).count()) { await page.click(`#sensors-panel [data-pin-sensor="${id}"]`); await sleep(400); }
  await page.click('#workspace-replay'); await sleep(800);
  const n = await page.evaluate(() => window.__studio.sensorOverlayCount);
  await page.click('#layers-button'); await page.uncheck('#layer-sensors');
  const off = await page.evaluate(async () => (await import('/js/scene.js')).view.sensorLayer.visible);
  const shotOff = await R.shot('overlay-off');
  await page.check('#layer-sensors');
  const on = await page.evaluate(async () => (await import('/js/scene.js')).view.sensorLayer.visible);
  await page.click('#layers-button');
  const shotOn = await R.shot('overlay-on');
  assert(n >= 1 && off === false && on === true, `overlays ${n} off ${off} on ${on}`);
  // Unpin all from the dock.
  await unpinAll();
  await sleep(200);
  const n2 = await page.evaluate(() => window.__studio.sensorOverlayCount);
  assert(n2 === 0 && await page.locator('#sensor-dock').isHidden(), `unpin from dock: overlays ${n2}`);
  return { overlays: n, shotOff, shotOn };
});

await R.check('6.5', 'WX recording: perception unavailable by design in Sensors', async () => {
  if (!wxJob) return R.blocked('no WX job');
  await open(page, wxJob); await page.click('#workspace-sensors'); await page.waitForSelector('[data-sensor-card]'); await sleep(500);
  const cards = await page.evaluate(() => [...document.querySelectorAll('#sensors-panel [data-sensor-card]')].map(n => ({ id: n.dataset.sensorCard, label: n.querySelector('strong').textContent, reason: n.querySelector('.sensor-reason')?.textContent ?? null })));
  const lidar = cards.filter(c => /lidar|map|support|ceiling/i.test(c.id + c.label));
  const shot = await R.shot('sensors-wx');
  await page.click('#workspace-replay');
  assert(lidar.length && lidar.every(c => c.reason && /privileged|by design|exact boxes|not generated|no simulated/i.test(c.reason)), `wx lidar cards ${JSON.stringify(lidar)}`);
  return { lidar, shot };
});

// ------------------------------------------------------------------ System
await R.check('7.1', 'System: node click updates details', async () => {
  await page.click('#workspace-system'); await page.waitForSelector('#system-stage .sys-node'); await sleep(300);
  const out = {};
  for (const id of ['lidar', 'sonic', 'pd']) {
    await page.click(`#system-stage [data-node="${id}"]`); await sleep(150);
    out[id] = await page.locator('#system-detail h3').textContent();
    assert(/selected/.test(await page.locator(`#system-stage [data-node="${id}"]`).getAttribute('class')), `${id} selected`);
  }
  assert(out.lidar === 'MID-360 LiDAR' && out.sonic === 'SONIC tracker' && out.pd === 'PD / motors', JSON.stringify(out));
  await page.focus('#system-stage [data-node="flow"]'); await page.keyboard.press('Enter'); await sleep(150);
  assert(await page.locator('#system-detail h3').textContent() === 'Flow planner', 'Enter selects node');
  return out;
});

await R.check('7.2', 'System: deploy-topology toggle', async () => {
  const h0 = await page.locator('#system-stage h3').first().textContent(), dash0 = await page.locator('#system-stage .sys-edge polyline[stroke-dasharray="7 5"]').count();
  await page.check('#system-deploy'); await sleep(300);
  const h1 = await page.locator('#system-stage h3').first().textContent(), dash1 = await page.locator('#system-stage .sys-edge polyline[stroke-dasharray="7 5"]').count();
  const shot = await R.shot('system-deploy');
  await page.uncheck('#system-deploy'); await sleep(300);
  const h2 = await page.locator('#system-stage h3').first().textContent();
  assert(/Real-time deployment \(source-configured\)/.test(h1) && h2 === h0 && dash1 > dash0, `${h0} | ${h1} | ${h2} dashed ${dash0}→${dash1}`);
  return { h0, h1, dash0, dash1, shot };
});

await R.check('7.3', 'System: contract tables render', async () => {
  const tables = await page.locator('#robot-contract .contract-table').count();
  const joints = await page.locator('#robot-contract .contract-table').first().locator('tbody tr').count();
  const robot = (await api(page, '/api/robot')).body;
  assert(tables >= 3 && joints === robot.joints.length && joints === 29, `tables ${tables} joints ${joints}`);
  return { tables, joints, shot: await R.shot('system-contract') };
});

await R.check('7.4', 'System: discrepancy cards sorted by severity', async () => {
  const sev = await page.locator('#robot-contract .discrepancy .sev').allTextContents();
  const rank = { high: 0, medium: 1, low: 2 };
  const sorted = sev.every((s, i) => i === 0 || (rank[sev[i - 1]] ?? 3) <= (rank[s] ?? 3));
  const robot = (await api(page, '/api/robot')).body;
  assert(sev.length === robot.discrepancies.length && sorted, `severities ${sev}`);
  return { n: sev.length, sev };
});
await page.click('#workspace-replay');

// ------------------------------------------------------------------ Performance + honesty
await R.check('9.1', 'Time to open a large job session (41 MB JSON)', async () => {
  let bytes = 0; const onResp = async r => { if (r.url().includes('/api/session?id=perf-large-job')) { const h = await r.allHeaders(); bytes = Number(h['content-length'] ?? 0); } };
  page.on('response', onResp);
  const t0 = Date.now(); await page.selectOption('#session-picker', 'perf-large-job'); await ready(page, 'perf-large-job'); const ms = Date.now() - t0;
  page.off('response', onResp);
  const t1 = Date.now(); await page.selectOption('#session-picker', 'sonic-lockstep'); await ready(page, 'sonic-lockstep');
  const t2 = Date.now(); await page.selectOption('#session-picker', 'perf-large-job'); await ready(page, 'perf-large-job'); const warm = Date.now() - t2;
  const frames = await page.evaluate(() => window.__studio.state.session.frames.length);
  assert(ms < 20000, `cold open ${ms} ms`);
  return { coldMs: ms, warmMs: warm, transferBytes: bytes, frames };
});

await R.check('9.2', 'Frames rendered while idle (paused) stay flat', async () => {
  await body(); await page.mouse.move(5, 990);
  await sleep(500); const d0 = await page.evaluate(() => window.__studio.sceneDrawCount); await sleep(2000);
  const d1 = await page.evaluate(() => window.__studio.sceneDrawCount);
  assert(d1 - d0 <= 3, `idle draws ${d1 - d0} in 2 s`);
  return { idleDraws: d1 - d0 };
});

await R.check('9.3', 'Playback responsiveness: no main-thread stall > 200 ms during 5 s of 4× playback', async () => {
  await seek(page, 0); await page.selectOption('#speed', '4'); await page.click('#tab-health');
  const sanity = await page.evaluate(() => new Promise(r => { const out = []; const o = new PerformanceObserver(l => { for (const e of l.getEntries()) out.push(e.duration); }); o.observe({ type: 'longtask' }); const t = performance.now(); while (performance.now() - t < 300) {} setTimeout(() => { o.disconnect(); r(out.length); }, 200); }));
  const res = await page.evaluate(async () => {
    const gaps = []; let last = performance.now(), on = true; const ch = new MessageChannel();
    ch.port1.onmessage = () => { const n = performance.now(); gaps.push(n - last); last = n; if (on) setTimeout(() => ch.port2.postMessage(0), 0); }; ch.port2.postMessage(0);
    const d0 = window.__studio.sceneDrawCount, t0 = window.__studio.state.time;
    window.__studio.setPlaying(true); await new Promise(x => setTimeout(x, 5000)); window.__studio.setPlaying(false); on = false;
    return { stalls200: gaps.filter(g => g > 200).length, maxGapMs: Math.round(gaps.reduce((a, b) => Math.max(a, b), 0)), fps: (window.__studio.sceneDrawCount - d0) / 5, simAdvanced: window.__studio.state.time - t0 };
  });
  await page.selectOption('#speed', '1');
  assert(res.stalls200 === 0, `main-thread stalls > 200 ms: ${res.stalls200} (max ${res.maxGapMs} ms)`);
  return { ...res, longtaskObserverWorks: sanity > 0, note: 'PerformanceObserver longtask is inert in this headless build (300 ms busy loop not reported); a MessageChannel heartbeat measures stalls instead. Frame rate is bounded by software GL (~3-4 fps for ~1.5 M triangles).' };
});

await R.check('8.6', 'Honesty scan: no NaN/undefined/null/[object] text; unavailable stays "Unavailable"', async () => {
  const bad = {};
  for (const id of ['sonic-lockstep', 'sonic-dds-tutorial', 'wire-local', bundleJob, wxJob].filter(Boolean)) {
    await open(page, id); await seek(page, 0.7);
    for (const tab of ['intent', 'joints', 'health', 'perception', 'pipeline', 'graph', 'source']) {
      await page.click(`#tab-${tab}`); await sleep(120);
      const t = await page.evaluate(() => [document.getElementById('hud').innerText, document.querySelector('.inspector-content').innerText, document.getElementById('pose-caption').innerText].join('\n'));
      const m = t.match(/.{0,40}\b(NaN|undefined|null|\[object [A-Za-z]+\]|Infinity)\b.{0,40}/g);
      if (m) bad[`${id}/${tab}`] = m.slice(0, 4);
    }
    if (id === 'wire-local' || id === 'sonic-dds-tutorial') {
      await page.click('#tab-health'); await sleep(100);
      const budgets = await page.locator('#health-content .budget strong').allTextContents();
      bad[`${id}/budgets`] = budgets;
    }
  }
  const real = Object.entries(bad).filter(([k]) => !k.endsWith('/budgets'));
  assert(!real.length, `suspicious text: ${JSON.stringify(Object.fromEntries(real)).slice(0, 700)}`);
  return bad;
});

await R.save({ bundleJob, wxJob, viewLink });
await browser.close();
