// Section 4 (+ reload re-attach from 8): Rehearse. Launches at most 7 short CPU runs
// (2–3 s simulated, K2/ODE4) on the validation gateway's own data root.
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/rehearse.mjs
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, near, api, sleep } from './harness.mjs';

const BUNDLE = 'flow-bundle-20261008', WX = 'flow-wx-rf-23326aa-s0';
const { browser, context } = await launch();
let page = await context.newPage();
const R = recorder(process.env.ONLY ? 'rehearse-b' : 'rehearse');
const ONLY = process.env.ONLY ? new Set(process.env.ONLY.split(',')) : null;
const check = R.check; R.check = (id, ...rest) => (!ONLY || ONLY.has(id)) ? check(id, ...rest) : null;
R.watch(page);
const jobs = {};
const rh = () => page.evaluate(() => JSON.parse(JSON.stringify({ ...window.__studio.rehearse, catalog: null, map: window.__studio.rehearse.map?.id, timer: null, suiteTimer: null })));
const S = () => page.evaluate(() => ({ id: window.__studio.state.sessionId, mode: window.__studio.state.session?.metadata?.mode, frames: window.__studio.state.session?.frames?.length,
  time: window.__studio.state.time, outcome: window.__studio.state.session?.metadata?.test_result?.outcome, badge: document.querySelector('#mode-badge').textContent, workspace: window.__studio.state.workspace }));
async function setNum(id, v) { await page.fill(`#${id}`, String(v)); await page.locator(`#${id}`).dispatchEvent('change'); await sleep(100); }
async function policy(id) { await page.check(`input[name=policy][value="${id}"]`); await sleep(150); }
async function quick() { await page.click('[data-budget="2,4"]'); await sleep(100); }
async function waitJobDone(id, timeout = 420000) {
  await page.waitForFunction(id => { const j = window.__studio.rehearse.job; return j?.id === id && ['completed', 'failed', 'cancelled'].includes(j.status); }, id, { timeout, polling: 1000 });
  return page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.rehearse.job)));
}
async function startRun() {
  const prev = (await rh()).job?.id ?? null;
  await page.click('#rh-run');
  await page.waitForFunction(prev => window.__studio.rehearse.job?.id && window.__studio.rehearse.job.id !== prev, prev, { timeout: 60000 });
  return (await rh()).job.id;
}
async function waitLive(id, timeout = 180000) {
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation' && window.__studio.state.session.frames.length > 0, id, { timeout, polling: 200 });
}

await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });

// Fixture arena: doorway + mirrored preset = 3 presets (saved through the editor).
await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
await page.selectOption('#arena-base', 'tpl:doorway');
await page.fill('#arena-label', 'Validation rehearse doorway'); await page.locator('#arena-label').dispatchEvent('input');
await page.click('[data-preset-select="1"]'); await page.click('#preset-mirror');
await page.click('#arena-save');
await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
const arenaId = await page.evaluate(() => window.__studio.arena.savedId);
await page.click('#arena-rehearse');
await page.waitForFunction(id => window.__studio.rehearse.mapId === id, arenaId, { timeout: 20000 });
await sleep(500);

await R.check('4.1', 'Flow research sync text shows the adopted block', async () => {
  const t = await page.locator('#rehearse-panel .research-sync').textContent();
  assert(/Adopted block WX/.test(t) && /2026-10-16 16:13/.test(t) && /4ba73cb/.test(t) && /CONFIGURED/.test(t), `sync text: ${t}`);
  return { text: t.trim() };
});

await R.check('4.2', 'Policy cards: select changes profile/budget/wall limit; ADOPTED BLOCK; limitations expand', async () => {
  const cards = await page.locator('.policy-card').count();
  assert(cards === 2, `cards ${cards}`);
  const wxCard = page.locator('.policy-card', { has: page.locator(`input[value="${WX}"]`) });
  assert(/ADOPTED BLOCK/.test(await wxCard.textContent()), 'WX adopted tag');
  await policy(WX); let r = await rh();
  assert(r.policyId === WX && r.settings.candidates === 8 && r.settings.ode_steps === 6, `WX default ${JSON.stringify(r.settings)}`);
  assert(/Wall limit for this profile: 480 s/.test(await page.locator('#rehearse-panel').textContent()), 'WX wall limit 480');
  assert(await page.locator('.policy-card.selected input').getAttribute('value') === WX, 'selected card styling');
  await policy(BUNDLE); r = await rh();
  assert(r.policyId === BUNDLE && r.settings.candidates === 4 && /Wall limit for this profile: 180 s/.test(await page.locator('#rehearse-panel').textContent()), `bundle ${JSON.stringify(r.settings)}`);
  const det = page.locator('.policy-card details').first();
  await det.locator('summary').click();
  assert(await det.getAttribute('open') !== null && await det.locator('li').count() > 0, 'limitations expand');
  return { cards, shot: await R.shot('policy-cards') };
});

await R.check('4.3', 'Arena / preset selection updates the 3D preview and readout', async () => {
  const goalOf = () => page.evaluate(async () => { const v = (await import('/js/scene.js')).view; const g = v.arenaGroup.getObjectByName('GOAL'); return { visible: v.arenaGroup.visible, goal: g ? [g.position.x, g.position.y] : null, boxes: v.arenaGroup.children.filter(c => c.isMesh).length }; });
  await page.selectOption('#rh-preset', '0'); await sleep(300);
  const a = await goalOf(), map = (await api(page, `/api/map?id=${arenaId}`)).body;
  assert(a.visible && a.boxes === map.boxes.length && Math.abs(a.goal[0] - map.presets[0].goal_xy[0]) < 1e-6, `preview 0 ${JSON.stringify(a)}`);
  await page.selectOption('#rh-preset', '2'); await sleep(300);
  const b = await goalOf();
  assert(Math.abs(b.goal[1] - map.presets[2].goal_xy[1]) < 1e-6 && b.goal[1] !== a.goal[1], `preview 2 ${JSON.stringify(b)}`);
  const readout = await page.locator('.preset-readout').textContent();
  assert(readout.includes(map.presets[2].goal_xy[1].toFixed(2)), `readout ${readout}`);
  assert(/Preview · Validation rehearse doorway/.test(await page.locator('#session-title').textContent()), 'preview title');
  await page.selectOption('#rh-map', 'flow-detour'); await sleep(600);
  const c = await goalOf();
  assert(c.boxes > 0 && (await rh()).mapId === 'flow-detour', `switch arena ${JSON.stringify(c)}`);
  const shot = await R.shot('preview-flow-detour');
  await page.selectOption('#rh-map', arenaId); await sleep(500); await page.selectOption('#rh-preset', '0'); await sleep(200);
  return { a, b, c, shot };
});

await R.check('4.4', 'Budget buttons set K/ODE and highlight', async () => {
  const out = {};
  for (const [k, o] of [[2, 4], [4, 6], [8, 6], [16, 10]]) {
    await page.click(`[data-budget="${k},${o}"]`); await sleep(100);
    const r = await rh(); assert(r.settings.candidates === k && r.settings.ode_steps === o, `budget ${k}/${o}: ${JSON.stringify(r.settings)}`);
    assert(await page.locator(`[data-budget="${k},${o}"]`).getAttribute('class') === 'active', `active class ${k}/${o}`);
    assert(await page.locator('#rh-k').inputValue() === String(k), 'K field');
    out[`${k}/${o}`] = true;
  }
  await quick();
  return out;
});

await R.check('4.5', 'Criterion select', async () => {
  await page.selectOption('#rh-criterion', 'arena_reach'); assert((await rh()).settings.criterion === 'arena_reach', 'reach');
  await page.selectOption('#rh-criterion', 'arrive_hold'); assert((await rh()).settings.criterion === 'arrive_hold', 'arrive');
  // The criterion survives a re-render (e.g. changing duration).
  await page.selectOption('#rh-criterion', 'arena_reach'); await setNum('rh-duration', 2);
  const kept = await page.locator('#rh-criterion').inputValue();
  await page.selectOption('#rh-criterion', 'arrive_hold');
  assert(kept === 'arena_reach', `criterion after re-render ${kept}`);
  return { kept };
});

await R.check('4.6', 'Latency select + anchor enabling rules (anchor disabled for WX and for no latency)', async () => {
  await policy(BUNDLE); await page.selectOption('#rh-latency', '0'); await sleep(100);
  assert(await page.locator('#rh-anchor').isDisabled(), 'bundle, 0 ms → anchor disabled');
  await page.selectOption('#rh-latency', '200'); await sleep(100);
  assert(!(await page.locator('#rh-anchor').isDisabled()), 'bundle, 200 ms → anchor enabled');
  assert(/L2: each plan starts 200 ms/.test(await page.locator('#rehearse-panel').textContent()), 'L2 explanation');
  await page.selectOption('#rh-anchor', 'predict');
  await policy(WX); await sleep(100);
  assert(await page.locator('#rh-anchor').isDisabled(), 'WX, 200 ms → anchor disabled');
  const wxAnchor = (await rh()).settings.anchor;
  await page.selectOption('#rh-latency', '200'); const after = (await rh()).settings.anchor;
  await policy(BUNDLE); await page.selectOption('#rh-anchor', 'measured'); await page.selectOption('#rh-latency', '0');
  return { wxAnchorWhenSwitched: wxAnchor, wxAnchorAfterLatencyChange: after, note: 'Scenario request forces measured anchor for flow-callback (rehearse.js:123)' };
});

await R.check('4.7', 'Invalid settings show an error and start nothing (duration 0, 20; K 0)', async () => {
  const before = (await api(page, '/api/jobs')).body.jobs.length;
  const out = {};
  for (const [id, v] of [['rh-duration', 0], ['rh-duration', 20], ['rh-k', 0]]) {
    await setNum(id, v);
    await page.click('#rh-run'); await sleep(800);
    const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
    assert(/must be/.test(err), `${id}=${v}: error "${err}"`);
    out[`${id}=${v}`] = err;
    await setNum(id, id === 'rh-k' ? 2 : 2);
  }
  const after = (await api(page, '/api/jobs')).body.jobs.length;
  assert(after === before, `jobs started ${before} → ${after}`);
  return out;
}, { expectHttp: [/422 .*\/api\/scenarios/] });

await R.check('4.8', 'Run preset (bundle K2/ODE4, 2 s): live attach, frames grow, LIVE badge, Health worker card, recorded result opens', async () => {
  await policy(BUNDLE); await quick(); await setNum('rh-duration', 2); await page.selectOption('#rh-preset', '0');
  const id = await startRun(); jobs.bundle = id;
  await waitLive(id);
  const a = await S(); await sleep(2500); const b = await S();
  const health = await page.locator('#health-content').textContent();
  const tab = await page.locator('[role=tab][aria-selected=true]').getAttribute('data-tab');
  const shot = await R.shot('live-bundle');
  const cam = await page.evaluate(() => window.__studio.camera);
  const live = { a, b, tab, cam, worker: /Owned CPU worker/.test(health) && /Running · PID|Exited/.test(health), playback: await page.locator('#playback-state').textContent() };
  const job = await waitJobDone(id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay', id, { timeout: 60000 });
  const done = await S();
  const outcome = await page.locator('#run-outcome').textContent();
  const shot2 = await R.shot('result-bundle');
  assert(/LIVE CPU SIMULATION/.test(a.badge), `badge ${a.badge}`);
  assert(b.frames > a.frames || job.status !== 'running', `frames ${a.frames} → ${b.frames}`);
  assert(tab === 'health' && live.worker, `health tab ${tab} worker card ${live.worker}`);
  assert(cam === 'follow', `camera ${cam}`);
  assert(job.status === 'completed' && done.outcome && outcome.trim(), `job ${job.status} outcome ${done.outcome} chip ${outcome}`);
  assert(/REPLAY · CPU REHEARSAL · L1/.test(done.badge), `result badge ${done.badge}`);
  return { id, live, job: { status: job.status, outcome: job.summary?.report?.outcome ?? job.summary?.outcome }, done, shot, shot2 };
});

await R.check('4.9', 'Cancel during a run: status cancelled, UI recovers', async () => {
  await policy(BUNDLE); await quick(); await setNum('rh-duration', 3); await page.selectOption('#rh-preset', '1');
  const id = await startRun(); jobs.cancelled = id;
  await waitLive(id);
  await page.waitForSelector('#rh-cancel', { timeout: 10000 });
  await page.click('#rh-cancel');
  const job = await waitJobDone(id, 60000);
  await sleep(1500);
  const runEnabled = !(await page.locator('#rh-run').isDisabled()), cancelGone = await page.locator('#rh-cancel').count() === 0;
  const jobText = await page.locator('#rh-job').textContent();
  const playback = await page.locator('#playback-state').textContent();
  const shot = await R.shot('cancelled');
  const sessions = (await api(page, '/api/sessions')).body.sessions;
  const entry = sessions.find(s => s.id === id);
  assert(job.status === 'cancelled', `status ${job.status}`);
  assert(runEnabled && cancelGone, `run enabled ${runEnabled} cancel gone ${cancelGone}`);
  assert(/cancelled/i.test(jobText) && !/Goal reached/.test(jobText), `job text ${jobText}`);
  assert(!entry || entry.outcome !== 'goal_completion', 'not listed as success');
  return { id, status: job.status, playback, entry, shot };
});

await R.check('4.10', 'Run suite (3 short runs), table fills, Cancel mid-way skips the rest', async () => {
  await policy(BUNDLE); await quick(); await setNum('rh-duration', 2); await setNum('rh-seeds', 1);
  const label = await page.locator('#rh-suite').textContent();
  assert(/Run suite · 3 runs/.test(label), `suite button ${label}`);
  await page.click('#rh-suite');
  await page.waitForFunction(() => window.__studio.rehearse.suite?.id, null, { timeout: 60000 });
  const rows = await page.locator('.suite-table tr').count();
  // Wait for the first run to finish; watch whether Cancel stays reachable between runs.
  let gap = 0, samples = 0;
  const t0 = Date.now();
  while (Date.now() - t0 < 400000) {
    const s = await page.evaluate(() => { const s = window.__studio.rehearse.suite; return s && { status: s.status, runs: s.runs.map(r => [r.status, r.outcome, r.job_id]) }; });
    const cancel = await page.locator('#rh-cancel').count();
    if (s?.status === 'running') { samples++; if (!cancel) gap++; }
    if (s && s.runs[0][1] && s.runs[1][0] === 'running' && s.runs[1][2]) break;
    if (s && ['cancelled', 'completed', 'interrupted', 'failed'].includes(s.status)) break;
    await sleep(150);
  }
  const midShot = await R.shot('suite-running');
  // Second run is live: cancel the suite.
  await page.waitForSelector('#rh-cancel', { timeout: 20000 });
  await page.click('#rh-cancel');
  await page.waitForFunction(() => ['cancelled', 'completed', 'interrupted'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000, polling: 500 });
  await sleep(1500);
  const suite = await page.evaluate(() => JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  jobs.suite = suite.runs.map(r => r.job_id).filter(Boolean);
  const table = await page.locator('#rh-suite-status').textContent();
  const shot = await R.shot('suite-cancelled');
  assert(rows === 3, `suite table rows ${rows}`);
  assert(suite.status === 'cancelled', `suite status ${suite.status}`);
  assert(suite.runs[0].outcome && suite.runs[1].status === 'cancelled' && suite.runs[2].status === 'skipped', `runs ${JSON.stringify(suite.runs.map(r => [r.status, r.outcome]))}`);
  assert(!(await page.locator('#rh-suite').isDisabled()), 'suite button re-enabled');
  return { suite: suite.id, runs: suite.runs.map(r => [r.status, r.outcome, r.job_id]), table, cancelMissingWhileSuiteRunning: { gap, samples }, midShot, shot };
});

await R.check('4.10b', 'Cancel stays reachable for the whole suite (no gap between runs)', async () => {
  const prev = R.results.find(r => r.id === '4.10')?.evidence?.cancelMissingWhileSuiteRunning;
  if (!prev) return R.blocked('4.10 did not record the cancel-gap samples');
  assert(prev.gap === 0, `Cancel button absent in ${prev.gap}/${prev.samples} samples while the suite was running (between runs)`);
  return prev;
});

await R.check('4.11', 'WX run with 200 ms latency: anchor forced/disabled, reload mid-run re-attaches, fidelity badge L2≈', async () => {
  await page.selectOption('#rh-map', arenaId); await sleep(400);
  await policy(WX); await quick(); await setNum('rh-duration', 4); await page.selectOption('#rh-preset', '0');
  await page.selectOption('#rh-latency', '200'); await sleep(100);
  assert(await page.locator('#rh-anchor').isDisabled(), 'anchor disabled for WX');
  const id = await startRun(); jobs.wx200 = id;
  await waitLive(id, 240000);
  const before = await S();
  // Reload mid-run (section 8): the page must re-attach to the live job.
  await page.reload();
  await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
  let reattached = null;
  try {
    await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.rehearse.job?.id === id, id, { timeout: 30000 });
    const r1 = await S(); await sleep(3000); const r2 = await S();
    reattached = { r1, r2, url: page.url() };
  } catch (e) { reattached = { error: e.message.split('\n')[0], state: await S(), url: page.url() }; }
  const shotReload = await R.shot('live-wx-after-reload');
  let job = (await api(page, `/api/jobs?id=${id}&light=1`)).body; const tw = Date.now();
  while (Date.now() - tw < 480000 && ['queued', 'starting', 'running', 'cancelling'].includes(job.status)) { await sleep(1500); job = (await api(page, `/api/jobs?id=${id}&light=1`)).body; }
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay', id, { timeout: 60000 }).catch(() => {});
  const done = await S();
  const health = await page.locator('#health-content').textContent().catch(() => '');
  const shot = await R.shot('result-wx-lat200');
  const scenario = job.scenario ?? {};
  assert(reattached && !reattached.error && (reattached.r2.frames > reattached.r1.frames || job.status !== 'running'), `reload re-attach: ${JSON.stringify(reattached)}`);
  assert(job.status === 'completed', `job ${job.status} ${job.error ?? ''}`);
  assert(scenario.latency?.ms === 200 && scenario.latency?.anchor === 'measured', `scenario latency ${JSON.stringify(scenario.latency)}`);
  assert(/L2≈/.test(done.badge), `fidelity badge "${done.badge}"`);
  return { id, before, reattached, badge: done.badge, healthFidelity: health.match(/Fidelity level[^.]*/)?.[0], shotReload, shot };
});

await R.check('4.12', 'Bundle run with 200 ms latency: fidelity badge L2', async () => {
  if (await page.evaluate(() => window.__studio.state.workspace) !== 'rehearse') { await page.click('#workspace-rehearse'); await page.waitForSelector('#rh-map'); }
  await page.selectOption('#rh-map', arenaId); await sleep(400);
  await policy(BUNDLE); await quick(); await setNum('rh-duration', 2); await page.selectOption('#rh-preset', '2');
  await page.selectOption('#rh-latency', '200'); await sleep(100);
  await page.selectOption('#rh-anchor', 'predict');
  const id = await startRun(); jobs.bundle200 = id;
  await waitLive(id);
  const job = await waitJobDone(id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay', id, { timeout: 60000 });
  const done = await S();
  await page.click('#tab-health'); await sleep(300);
  const health = await page.locator('#health-content').textContent();
  const shot = await R.shot('result-bundle-lat200');
  assert(job.status === 'completed' && job.scenario.latency.ms === 200 && job.scenario.latency.anchor === 'predict', `job ${job.status} ${JSON.stringify(job.scenario.latency)}`);
  assert(/· L2$/.test(done.badge.trim()) && !/L2≈/.test(done.badge), `badge ${done.badge}`);
  assert(/L2 · lockstep with 200 ms planner latency/.test(health), 'health fidelity text');
  return { id, badge: done.badge, shot };
});

await R.check('4.13', 'Suite label stays within the 100-character limit for a long arena name', async () => {
  // Cheap: the suite request is rejected before any run if the label is too long; if accepted it is cancelled at once.
  await page.click('#workspace-arena'); await page.waitForSelector('#arena-base');
  await page.selectOption('#arena-base', 'tpl:empty');
  const long = 'Validation long arena name '.padEnd(96, 'x');
  await page.fill('#arena-label', long); await page.locator('#arena-label').dispatchEvent('input');
  await page.click('#arena-save'); await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
  const id = await page.evaluate(() => window.__studio.arena.savedId);
  await page.click('#arena-rehearse'); await page.waitForFunction(id => window.__studio.rehearse.mapId === id, id, { timeout: 20000 });
  await policy(BUNDLE); await quick(); await setNum('rh-duration', 1); await page.selectOption('#rh-latency', '0');
  await page.click('#rh-suite'); await sleep(2500);
  const suite = await page.evaluate(() => window.__studio.rehearse.suite?.label === undefined ? null : JSON.parse(JSON.stringify(window.__studio.rehearse.suite)));
  const err = await page.locator('#workbench-error').isVisible() ? await page.locator('#workbench-error').textContent() : '';
  let started = suite && /Validation long arena/.test(suite.label) && ['queued', 'running'].includes(suite.status);
  if (started) { await page.click('#rh-cancel').catch(() => {}); await page.waitForFunction(() => !['queued', 'running', 'cancelling'].includes(window.__studio.rehearse.suite?.status), null, { timeout: 120000 }).catch(() => {}); jobs.longSuite = (await page.evaluate(() => window.__studio.rehearse.suite?.runs?.map(r => r.job_id))) ?? []; }
  assert(started, `Run suite refused for a ${long.length}-character arena name: "${err}"`);
  return { err, suite: suite?.id };
}, { expectHttp: [/422 .*\/api\/suites/] });

await R.save({ arenaId, jobs });
let prior = {}; try { prior = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(EVIDENCE, 'rehearse-jobs.json'), 'utf8')); } catch { /* first run */ }
await writeFile(path.join(EVIDENCE, 'rehearse-jobs.json'), JSON.stringify({ arenaId: prior.arenaId ?? arenaId, arenaIds: [...new Set([...(prior.arenaIds ?? [prior.arenaId].filter(Boolean)), arenaId])], jobs: { ...(prior.jobs ?? {}), ...jobs } }, null, 1));
await browser.close();
