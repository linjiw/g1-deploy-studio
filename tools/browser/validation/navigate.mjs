// Navigate workspace, end to end with the simulated robot: start a session, click goals on the robot's own
// map, read the checks, send, Go, Stand, walks, end, replay, scan-to-twin, reload and the real-robot card.
//   STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/navigate.mjs
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const R = recorder('navigate');
const { browser, context } = await launch();
const page = await context.newPage();
R.watch(page);

const nav = () => page.evaluate(() => {
  const n = window.__studio.navigate, latest = n.job?.latest ?? {};
  return { job: n.job?.id, status: n.job?.status, nav: latest.navigation ?? null, pick: n.pick, notice: n.notice,
    session: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode,
    kind: window.__studio.state.session?.metadata?.kind, overlay: window.__studio.navOverlay, layers: window.__studio.layers,
    camera: window.__studio.camera };
});
async function waitNav(predicate, timeout = 180000, what = 'condition') {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await nav();
    if (predicate(last)) return last;
    await sleep(400);
  }
  throw new Error(`timed out waiting for ${what}: ${JSON.stringify({ phase: last?.nav?.phase, status: last?.status, notice: last?.notice })}`);
}
// Click the 3D viewport where a world point (on the floor) appears.
async function clickWorld(x, y) {
  const [ndc] = await page.evaluate(p => window.__studio.projectWorld([p]), [x, y, 0]);
  const box = await page.locator('#viewport canvas').first().boundingBox();
  const px = box.x + (ndc[0] + 1) / 2 * box.width, py = box.y + (1 - ndc[1]) / 2 * box.height;
  await page.mouse.click(px, py);
  return [px, py];
}
const standing = s => s.nav?.paused && ['WAIT', 'ARRIVED', 'STOPPED'].includes(s.nav?.phase);

// A world with one pillar ahead and a wall to the left: something to walk around and to refuse.
const token = (await api(page, '/api/workbench')).body?.csrf_token;
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
const arena = await page.evaluate(async () => {
  const wb = await (await fetch('/api/workbench')).json();
  const r = await fetch('/api/arenas', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Studio-Token': wb.csrf_token },
    body: JSON.stringify({ label: 'Navigate validation · pillar', boxes: [
      { center_xy: [1.8, 0.0], half_xy: [0.25, 0.25], yaw: 0, z_bottom: 0, z_top: 1.0 },
      { center_xy: [1.0, 1.6], half_xy: [1.5, 0.1], yaw: 0, z_bottom: 0, z_top: 0.8 }],
      presets: [{ label: 'Origin', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [3, 0] }] }) });
  return r.json();
});

await R.check('N1', 'Navigate workspace: rail button, robot choice, world and start, Start session', async () => {
  assert(token, 'workbench token');
  assert(arena.id, `arena saved: ${JSON.stringify(arena).slice(0, 200)}`);
  await page.click('#workspace-navigate');
  await page.waitForSelector('#nav-world');
  await page.selectOption('#nav-world', arena.id);
  await sleep(500);
  const text = await page.locator('#navigate-panel').innerText();
  for (const s of ['Simulated robot', 'Real robot', 'World', 'Start', 'Start session', 'How it works']) assert(text.toLowerCase().includes(s.toLowerCase()), `panel lacks "${s}"`);
  await R.shot('setup');
  return { arena: arena.id };
});

await R.check('N2', 'Start: the robot stands, the map is the robot\'s memory, the true world is hidden, top camera', async () => {
  await page.click('#nav-start-session');
  // The map layer switches on just after the live session opens: wait for both.
  const s = await waitNav(s => s.nav?.phase === 'WAIT' && s.session === s.job && s.kind === 'navigation' && s.layers.perception, 180000, 'WAIT');
  assert(s.mode === 'simulation', `live mode ${s.mode}`);
  assert(s.layers.perception === true && s.layers.environment === false, `layers ${JSON.stringify(s.layers)}`);
  assert(s.nav.can.goal && !s.nav.can.go && !s.nav.can.stand, `can ${JSON.stringify(s.nav.can)}`);
  assert(s.nav.map.observed_fraction > 0, 'pre-scan map published');
  const text = await page.locator('#nav-live').innerText();
  assert(/Standing · waiting for a goal/i.test(text) && /Click the map to place a goal/i.test(text), text.slice(0, 300));
  await R.shot('waiting');
  return { job: s.job, coverage: s.nav.map.observed_fraction, camera: s.camera };
});

await R.check('N3', 'A goal inside the pillar is refused before sending; Send stays disabled', async () => {
  await clickWorld(1.8, 0.0);
  const s = await waitNav(s => s.pick?.check, 30000, 'check');
  assert(!s.pick.check.ok, 'pillar goal should block');
  assert(await page.locator('#nav-send').isDisabled(), 'Send enabled for a blocked goal');
  const text = await page.locator('#nav-live').innerText();
  assert(/✕/.test(text), 'block icon');
  await R.shot('blocked');
  return s.pick.check.checks.map(c => `${c.id}:${c.status}`);
});

await R.check('N4', 'A goal in front of the pillar: checks pass, a path is drawn, Send stages it, Go walks', async () => {
  await clickWorld(1.0, -0.2);
  const s = await waitNav(s => s.pick?.check && Math.abs(s.pick.xy[0] - 1.0) < 0.15, 30000, 'check');
  assert(s.pick.check.ok, `checks ${JSON.stringify(s.pick.check.checks)}`);
  assert(s.overlay >= 2, `overlay objects ${s.overlay}`);
  await R.shot('checked');
  await page.click('#nav-send');
  const staged = await waitNav(s => s.nav?.can?.go, 30000, 'staged');
  assert(staged.nav.goal && Math.abs(staged.nav.goal.xy[0] - s.pick.xy[0]) < 1e-6, 'staged goal equals the click');
  await page.click('#nav-go');
  const walking = await waitNav(s => ['PRESCAN', 'RUN'].includes(s.nav?.phase), 30000, 'walking');
  assert(walking.nav.can.stand && !walking.nav.can.goal, `can while walking ${JSON.stringify(walking.nav.can)}`);
  await sleep(1500);
  await R.shot('walking');
  return { goal: staged.nav.goal.xy };
});

await R.check('N5', 'Arrival: the walk is listed as arrived, the robot stands and pauses, the next goal is allowed', async () => {
  const s = await waitNav(s => standing(s) && s.nav.legs?.[0]?.outcome, 240000, 'walk 1');
  const walk = s.nav.legs[0];
  assert(walk.outcome === 'arrived', JSON.stringify(walk));
  assert(walk.final_dist_m < 0.6, `final distance ${walk.final_dist_m}`);
  assert(s.nav.can.goal, 'next goal allowed');
  const text = await page.locator('#nav-live').innerText();
  assert(/Arrived/i.test(text), 'walk row');
  await R.shot('arrived');
  return walk;
});

await R.check('N6', 'Walk 2 behind the pillar, then Stand mid-walk: stops and stands (not an emergency stop)', async () => {
  await clickWorld(2.7, 0.3);
  await waitNav(s => s.pick?.check, 30000, 'check');
  const s0 = await nav();
  assert(s0.pick.check.ok, `checks ${JSON.stringify(s0.pick.check.checks)}`);
  await page.click('#nav-send');
  await waitNav(s => s.nav?.can?.go, 30000, 'staged');
  await page.click('#nav-go');
  await waitNav(s => s.nav?.phase === 'RUN', 60000, 'RUN');
  await sleep(2500);
  await page.click('#nav-stand');
  // node.py defers a stand near a remembered low ceiling (the pillar's top edge can be filed as one): then the
  // panel must say so and offer the remote's takeover, which stands the robot at once.
  const after = await waitNav(s => s.nav?.pending_stand || standing(s) || s.nav?.phase === 'STOPPED', 30000, 'stand reply');
  let deferred = false;
  if (after.nav.pending_stand) {
    deferred = true;
    const text = await page.locator('#nav-live').innerText();
    assert(/Stand deferred/i.test(text), 'deferral explained');
    await R.shot('deferred');
    await page.click('#nav-takeover');
  }
  const s = await waitNav(s => standing(s) && s.nav.legs?.length === 2 && s.nav.legs[1].outcome, 120000, 'stopped');
  s.deferred = deferred;
  assert(['stopped', 'arrived'].includes(s.nav.legs[1].outcome), JSON.stringify(s.nav.legs[1]));
  assert((s.nav.commands ?? []).some(c => c.cmd === 'stand' && c.status === 'applied'), 'stand applied');
  await R.shot('stopped');
  assert(s.nav.legs[1].duration_s < 30, `walk 2 lasted ${s.nav.legs[1].duration_s} s`);
  return { ...s.nav.legs[1], deferred };
});

await R.check('N7', 'Rehearse while a session runs does not adopt the navigation job', async () => {
  await page.click('#workspace-rehearse');
  await sleep(1500);
  const attached = await page.evaluate(() => window.__studio.rehearse.job?.id ?? null);
  const s = await nav();
  assert(attached !== s.job, 'Rehearse adopted the navigation session');
  await page.click('#workspace-navigate');
  await sleep(800);
  const back = await nav();
  assert(back.layers.environment === false && back.overlay >= 1, `back in Navigate ${JSON.stringify(back.layers)}`);
  return { attached };
});

await R.check('N8', 'Reload mid-session: Navigate resumes the live session', async () => {
  const before = await nav();
  await page.goto(`${BASE}/?workspace=navigate`);
  const s = await waitNav(s => s.job === before.job && s.nav?.phase && s.session === before.job, 120000, 'resume');
  assert(standing(s), `phase ${s.nav.phase}`);
  return { job: s.job };
});

await R.check('N9', 'End: the recording opens in Replay with both walks and per-frame goals', async () => {
  await page.click('#nav-end');
  const s = await waitNav(s => s.status === 'completed' && s.mode === 'replay', 120000, 'recording');
  const info = await page.evaluate(() => {
    const ss = window.__studio.state.session;
    return { frames: ss.frames.length, legs: ss.metadata.navigation?.legs?.length, goals: [...new Set(ss.frames.map(f => JSON.stringify(f.navigation?.goal_xy)))].length };
  });
  assert(info.frames > 100 && info.legs === 2 && info.goals >= 2, JSON.stringify(info));
  const text = await page.locator('#nav-live').innerText();
  assert(/Session saved/i.test(text) && /Make an arena twin/i.test(text), text.slice(0, 300));
  await R.shot('saved');
  return info;
});

await R.check('N10', 'Scan to twin: an arena fitted to the robot\'s map is saved and reported against the true world', async () => {
  await page.click('#nav-twin');
  await page.waitForFunction(() => window.__studio.navigate.notice?.arena, null, { timeout: 60000 });
  const notice = await page.evaluate(() => window.__studio.navigate.notice);
  const map = (await api(page, `/api/map?id=${notice.arena}`)).body;
  assert(map?.kind === 'boxes' && map.boxes.length >= 1, `twin ${JSON.stringify(map).slice(0, 200)}`);
  assert(/footprint match/.test(notice.text), notice.text);
  await R.shot('twin');
  return { arena: notice.arena, boxes: map.boxes.length, text: notice.text };
});

await R.check('N11', 'Real robot card without a robot link: explains the setup, no connect button, Go stays with the operator', async () => {
  await page.click('#nav-new');
  await page.click('[data-robot="real"]');
  await page.waitForFunction(() => !/Checking the robot link/.test(document.querySelector('#navigate-panel').innerText), null, { timeout: 15000 });
  const text = await page.locator('#navigate-panel').innerText();
  assert(/never starts a walk/i.test(text), 'Go rule');
  const configured = await page.locator('#nav-connect').count();
  await R.shot('real-robot');
  return { configured: configured > 0, text: text.slice(0, 200) };
});

await R.save({ arena: arena.id });
await browser.close();
