// Flow stage acceptance. Starts exactly ONE bounded, real WXD CPU rehearsal via
// the existing UI. Run on an isolated workbench; never cancels another worker.
// STUDIO_URL=http://127.0.0.1:8797 node tools/browser/flow_stage.mjs
// FLOW_STAGE_JOB=<completed-job-id> rechecks a recording without starting a worker.
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8797';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/flow-stage-20261022');
const WXD = 'flow-wxd-rf-5658a6d-s0', S2 = 'flow-bundle-20261008';
const duration = Number(process.env.FLOW_STAGE_DURATION || 4);
assert.ok(duration >= 1 && duration <= 6, 'Acceptance duration must be 1–6 simulated seconds.');
const existingJob = process.env.FLOW_STAGE_JOB;
await mkdir(evidence, { recursive: true });
const report = { base, evidence, started: new Date().toISOString(), existingJob: existingJob ?? null, checks: [], errors: [], requests: [], jobId: existingJob ?? null };
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(20000);
let current = 'boot';
page.on('pageerror', e => report.errors.push({ check: current, kind: 'pageerror', message: e.message }));
page.on('console', m => { if (m.type() === 'error') report.errors.push({ check: current, kind: 'console', message: m.text() }); });
page.on('response', r => { if (r.status() >= 400) report.requests.push({ check: current, status: r.status(), url: r.url() }); });
page.on('requestfailed', r => { if (!/ERR_ABORTED/.test(r.failure()?.errorText ?? '')) report.requests.push({ check: current, url: r.url(), message: r.failure()?.errorText }); });
const save = () => writeFile(path.join(evidence, existingJob ? 'flow-stage-recheck.json' : 'flow-stage.json'), JSON.stringify(report, null, 2));
const shot = async name => { const file = path.join(evidence, `${name}.png`); await page.screenshot({ path: file }); return file; };
const get = async endpoint => { const r = await context.request.get(`${base}${endpoint}`); assert.ok(r.ok(), `${endpoint}: HTTP ${r.status()}`); return r.json(); };
const check = async (name, fn) => {
  current = name; const start = Date.now();
  try { const details = await fn(); report.checks.push({ name, status: 'PASS', ms: Date.now() - start, details }); console.log(`PASS ${name}`); }
  catch (error) { const screenshot = await shot(`failure-${report.checks.length}`).catch(() => null); report.checks.push({ name, status: 'FAIL', ms: Date.now() - start, error: error.stack, screenshot }); console.error(`FAIL ${name}: ${error.message}`); }
  await save();
};
const state = () => page.evaluate(() => {
  const { state: s, rehearse: r } = window.__studio;
  return { sessionId: s.sessionId, mode: s.session?.metadata?.mode, frames: s.session?.frames?.length,
    time: s.time, playing: s.playing, workspace: s.workspace, selectedPolicy: r.policyId, settings: { ...r.settings },
    jobId: r.job?.id, jobStatus: r.job?.status, profile: s.session?.metadata?.policy_profile,
    provenance: s.session?.metadata?.provenance, outcome: s.session?.metadata?.test_result?.outcome,
    labels: Object.fromEntries(['focus-mode', 'focus-displayed-policy', 'focus-selected-policy', 'focus-provenance', 'focus-distance', 'focus-contact', 'focus-time'].map(id => [id, document.getElementById(id)?.textContent?.trim() ?? null])) };
});
const openSetup = async () => { if (!(await page.locator('body').evaluate(el => el.classList.contains('focus-setup-open')))) await page.click('#focus-setup'); await page.waitForSelector('#rh-map', { state: 'visible' }); };
const closeSetup = async () => { if (await page.locator('body').evaluate(el => el.classList.contains('focus-setup-open'))) await page.click('#tool-close'); };
const setNumber = async (id, value) => { await page.fill(`#${id}`, String(value)); await page.locator(`#${id}`).dispatchEvent('change'); };
const assertScene = async ({ preview = false } = {}) => {
  const scene = await page.evaluate(async () => {
    const v = (await import('/js/scene.js')).view, c = v.renderer?.domElement?.getBoundingClientRect();
    return { renderer: v.renderer?.isWebGLRenderer, contextLost: v.renderer?.getContext().isContextLost(), drawCount: v.drawCount,
      calls: v.renderer?.info.render.calls, triangles: v.renderer?.info.render.triangles,
      width: c?.width, height: c?.height, model: !!v.model, robot: !!v.robot, robotVisible: !!v.robot?.root?.visible,
      previewVisible: !!v.arenaGroup?.visible, previewObjects: v.arenaGroup?.children.length,
      sceneUnavailable: !document.querySelector('#scene-unavailable').hidden,
      error: document.querySelector('#error-banner')?.hidden ? null : document.querySelector('#error-banner')?.textContent };
  });
  assert.ok(scene.renderer && !scene.contextLost && scene.drawCount > 0 && scene.calls > 0 && scene.triangles > 0, `Scene must render actual geometry: ${JSON.stringify(scene)}`);
  assert.ok(scene.width > 200 && scene.height > 100, `Canvas must have usable dimensions: ${JSON.stringify(scene)}`);
  assert.equal(scene.error, null, `Scene error: ${scene.error}`);
  assert.equal(scene.sceneUnavailable, false, 'World pose unavailable overlay must not be ignored.');
  if (preview) assert.ok(scene.previewVisible && scene.previewObjects > 0, 'Actual arena preview must be populated.');
  else assert.ok(scene.model && scene.robot && scene.robotVisible, 'The articulated G1 must be present and visible.');
  return scene;
};
const palette = () => page.evaluate(async () => {
  const v = (await import('/js/scene.js')).view;
  const mat = m => m ? { color: m.color.getHex(), opacity: m.opacity, saved: m.userData.studioPalette ? { color: m.userData.studioPalette.color.getHex(), opacity: m.userData.studioPalette.opacity } : null } : null;
  return { focus: v.focusMode, fog: v.scene.fog.color.getHex(), floor: mat(v.floor.material), ghost: mat(v.ghost?.material),
    futures: v.futures.map(p => mat(p.material)), lines: Object.fromEntries(Object.entries(v.lines).map(([k, l]) => [k, mat(l.material)])),
    grids: v.studioGrids.map(g => g.visible), focusGrid: v.focusGrid.visible };
});
const waitReplay = id => page.waitForFunction(id => {
  const s = window.__studio?.state;
  return s?.sessionId === id && s.session?.metadata?.mode === 'replay' && s.session.frames.length > 1 && !s.loading && document.querySelector('#loading-overlay').hidden;
}, id, { timeout: 120000 });

try {
  report.version = await get('/api/version');
  const before = await get('/api/jobs');
  assert.equal(before.jobs.filter(j => ['queued', 'starting', 'running', 'cancelling', 'detached'].includes(j.status)).length, 0,
    'An existing worker is active. This test will neither start a duplicate nor cancel it.');
  if (!existingJob) {
    let prior = null;
    try { prior = JSON.parse(await readFile(path.join(evidence, 'flow-stage-job.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    assert.ok(!prior?.jobId, `This evidence directory already owns ${prior?.jobId}. Recheck with FLOW_STAGE_JOB=${prior?.jobId}; do not launch another run.`);
  }
  await page.goto(`${base}/?workspace=rehearse&focus=1${existingJob ? `&session=${encodeURIComponent(existingJob)}` : ''}`);
  await page.waitForFunction(() => window.__studio?.focus?.active && window.__studio?.rehearse?.catalog && !window.__studio.state.loading && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });

  await check('focused boot uses adopted WXD and a real arena preview', async () => {
    const s = await state();
    assert.equal(s.selectedPolicy, WXD);
    const adopted = await page.evaluate(() => window.__studio.rehearse.catalog.policies.find(p => p.id === window.__studio.rehearse.policyId));
    assert.ok(adopted.available && adopted.matches_adopted, 'Selected WXD must be available and match the adoption record.');
    assert.equal(s.settings.candidates, 8); assert.equal(s.settings.ode_steps, 6);
    assert.ok(/preview/i.test(s.labels['focus-mode']), `Preview mode: ${JSON.stringify(s.labels)}`);
    assert.ok(await page.locator('#focus-play').isDisabled(), 'A preview cannot play the underlying recording.');
    assert.ok(/unavailable|—|not recorded/i.test(`${s.labels['focus-distance']} ${s.labels['focus-contact']}`), 'Preview facts must not expose stale recorded telemetry.');
    assert.ok(!/\d/.test(s.labels['focus-distance'] ?? '') && !/\d/.test(s.labels['focus-contact'] ?? ''), 'Preview must not show numeric telemetry from the previous session.');
    return { selectedPolicy: s.selectedPolicy, labels: s.labels, scene: await assertScene({ preview: true }), screenshot: await shot('01-preview-desktop') };
  });

  await check('setup sheet reuses the real Rehearse form and bounds the run', async () => {
    await openSetup();
    assert.equal(await page.locator('#rh-run').count(), 1, 'There must be only one real run form.');
    assert.ok(await page.locator('#tool-panel #rehearse-panel #rh-run').isVisible());
    await page.selectOption('#rh-map', 'flow-detour');
    await page.waitForFunction(() => window.__studio.rehearse.map?.id === 'flow-detour');
    await page.check(`input[name=policy][value="${WXD}"]`);
    await page.click('[data-budget="8,6"]');
    await setNumber('rh-duration', duration);
    await page.selectOption('#rh-latency', '0');
    const s = await state();
    assert.equal(s.settings.duration_s, duration); assert.equal(s.settings.candidates, 8); assert.equal(s.settings.ode_steps, 6);
    assert.equal(await page.locator('#rh-map').inputValue(), 'flow-detour');
    assert.equal(await page.locator('#rh-run').isDisabled(), false);
    const screenshot = await shot('02-setup-desktop');
    await closeSetup();
    assert.equal(await page.locator('#rh-run').isVisible(), false, 'Closing setup returns the viewport space.');
    return { settings: s.settings, screenshot };
  });

  if (report.checks.some(c => c.status === 'FAIL')) throw new Error('Setup acceptance failed; no worker was started.');
  if (!existingJob) {
    await check('one real UI-started WXD CPU run exposes live samples and provenance', async () => {
      assert.equal(report.checks.some(c => c.status === 'FAIL') || report.errors.length > 0 || report.requests.length > 0, false, 'Fix setup/browser errors before starting the worker.');
      const active = (await get('/api/jobs')).jobs.filter(j => ['queued', 'starting', 'running', 'cancelling', 'detached'].includes(j.status));
      assert.equal(active.length, 0, 'Another worker became active before Run.');
      await openSetup();
      await page.click('#rh-run');
      await page.waitForFunction(() => !!window.__studio.rehearse.job?.id, null, { timeout: 60000 });
      report.jobId = (await state()).jobId;
      await writeFile(path.join(evidence, 'flow-stage-job.json'), JSON.stringify({ jobId: report.jobId, base, started: new Date().toISOString() }, null, 2));
      await save();
      await closeSetup();
      await page.waitForFunction(id => { const s = window.__studio.state; return s.sessionId === id && s.session?.metadata?.mode === 'simulation' && s.session.frames.length > 1; }, report.jobId, { timeout: 300000, polling: 100 });
      const live = await state();
      assert.ok(/live/i.test(live.labels['focus-mode']), `Live stage mode: ${live.labels['focus-mode']}`);
      assert.ok(/WXD/i.test(live.labels['focus-displayed-policy']));
      assert.ok(/privileged/i.test(live.labels['focus-provenance']), `Privileged map provenance must be visible: ${live.labels['focus-provenance']}`);
      assert.equal(live.profile.id, WXD);
      const geometry = await assertScene();
      const screenshot = await shot('03-live-wxd');
      await page.waitForFunction(({ id, frames, time }) => { const s = window.__studio.state; return s.sessionId === id && s.session.frames.length > frames && s.time > time; }, { id: report.jobId, frames: live.frames, time: live.time }, { timeout: 180000, polling: 200 });
      const progressed = await state();
      report.live = { live, progressed, geometry, screenshot };
      return report.live;
    });
  } else {
    await check('reuse the named WXD recording without starting another worker', async () => {
      const job = await get(`/api/jobs?id=${encodeURIComponent(existingJob)}&light=1`);
      assert.equal(job.status, 'completed'); assert.equal(job.scenario.policy_id, WXD);
      await page.click('#focus-exit');
      await page.click('#workspace-replay');
      await page.selectOption('#session-picker', existingJob);
      await waitReplay(existingJob);
      await page.click('#focus-enter');
      return { jobId: existingJob, status: job.status, note: 'Replay-only recheck; live evidence is retained in flow-stage.json.' };
    });
  }

  if (!report.jobId) throw new Error('No simulation job is available for replay checks.');
  await check('completed replay contains actual execution and immutable WXD identity', async () => {
    assert.ok(report.jobId, 'No run was launched.');
    if (!existingJob) await page.waitForFunction(id => { const j = window.__studio.rehearse.job; return j?.id === id && ['completed', 'failed', 'cancelled'].includes(j.status); }, report.jobId, { timeout: 600000, polling: 1000 });
    const job = await get(`/api/jobs?id=${encodeURIComponent(report.jobId)}&light=1`);
    report.job = job;
    assert.equal(job.status, 'completed', `Worker ended ${job.status}: ${job.error ?? ''}`);
    assert.equal(job.scenario.policy_id, WXD); assert.ok(job.scenario.duration_s <= 6);
    assert.deepEqual(job.scenario.planner, { candidates: 8, ode_steps: 6 });
    await waitReplay(report.jobId);
    const s = await state();
    assert.equal(s.profile.id, WXD); assert.ok(s.profile.identity_sha256, 'Pinned policy identity hash is required.');
    assert.ok(/replay/i.test(s.labels['focus-mode']), `Completed stage mode: ${s.labels['focus-mode']}`);
    assert.ok(/privileged/i.test(s.labels['focus-provenance']));
    const execution = await page.evaluate(() => {
      const s = window.__studio.state.session, frames = s.frames.filter(f => Array.isArray(f.qpos));
      return { frames: frames.length, first: frames[0]?.qpos, last: frames.at(-1)?.qpos, firstTime: frames[0]?.time, lastTime: frames.at(-1)?.time,
        adapter: s.metadata.provenance?.adapter, plans: s.plans?.length, outcome: s.metadata.test_result?.outcome };
    });
    assert.ok(execution.frames > 5 && execution.lastTime > execution.firstTime, `Actual execution samples: ${JSON.stringify(execution)}`);
    assert.ok(execution.last.some((v, i) => Math.abs(v - execution.first[i]) > 1e-5), 'Actual joint/root states must evolve, not duplicate a frozen pose.');
    assert.ok(/flow_policy_worker/.test(execution.adapter), `Expected real Flow adapter, got ${execution.adapter}`);
    return { jobId: report.jobId, state: s, execution, scene: await assertScene(), screenshot: await shot('04-completed-replay') };
  });

  await check('layer switches affect scene objects and remain synchronized', async () => {
    await waitReplay(report.jobId);
    const result = {};
    for (const layer of ['robot', 'reference', 'future', 'trajectory', 'environment']) {
      const selector = `#focus-layer-${layer}`;
      assert.equal(await page.locator(selector).isDisabled(), false, `${layer} must be available for this recording.`);
      const before = await page.evaluate(name => window.__studio.layers[name], layer);
      await page.click(selector);
      await page.waitForFunction(({ layer, value }) => window.__studio.layers[layer] === value, { layer, value: !before });
      assert.equal(await page.locator(`#layer-${layer}`).isChecked(), !before, 'Stage and original controls must agree.');
      const objects = await page.evaluate(async layer => {
        const v = (await import('/js/scene.js')).view;
        const groups = { robot: [v.robot?.root], reference: [v.ghost?.root, v.lines.reference], future: [...v.futures.map(p => p.root), v.lines.future],
          trajectory: [v.lines.trajectory, v.lines.travelled], environment: [v.environment] };
        return groups[layer].map(object => object ? { present: true, visible: object.visible } : { present: false });
      }, layer);
      assert.ok(objects.length > 0 && objects.every(o => o.present), `${layer} must have real scene objects.`);
      if (before) assert.ok(objects.every(o => !o.visible), `${layer} scene objects must hide when disabled: ${JSON.stringify(objects)}`);
      await page.click(selector);
      await page.waitForFunction(({ layer, value }) => window.__studio.layers[layer] === value, { layer, value: before });
      result[layer] = 'toggled off/on through stage and synchronized';
    }
    return result;
  });

  await check('playback seek restart and camera operate on the recording', async () => {
    await page.click('#focus-restart');
    if ((await state()).playing) await page.click('#focus-play');
    await page.locator('#focus-seek').fill('1.25');
    await page.locator('#focus-seek').dispatchEvent('input');
    await page.waitForFunction(() => Math.abs(window.__studio.state.time - 1.25) < 0.03);
    const seekState = await state();
    await page.click('#focus-play');
    await page.waitForFunction(t => window.__studio.state.time > t + 0.12, seekState.time);
    await page.click('#focus-play');
    assert.equal((await state()).playing, false);
    const cameras = [];
    for (let i = 0; i < 4; i++) { await page.click('#focus-camera'); cameras.push(await page.evaluate(() => window.__studio.camera)); }
    assert.deepEqual(new Set(cameras), new Set(['orbit', 'follow', 'top', 'scene']));
    await page.click('#focus-restart');
    await page.waitForFunction(() => window.__studio.state.time < 0.03);
    return { seekTime: seekState.time, cameras, screenshot: await shot('05-replay-controls') };
  });

  await check('selecting S2 keeps the displayed WXD recording identified', async () => {
    await openSetup();
    await page.check(`input[name=policy][value="${S2}"]`);
    await closeSetup();
    const s = await state();
    assert.equal(s.selectedPolicy, S2); assert.equal(s.profile.id, WXD); assert.equal(s.sessionId, report.jobId);
    assert.ok(/WXD/.test(s.labels['focus-displayed-policy']), `Displayed identity: ${s.labels['focus-displayed-policy']}`);
    assert.ok(/S2|bundle|student/i.test(s.labels['focus-selected-policy']), `Selected identity: ${s.labels['focus-selected-policy']}`);
    assert.ok(/privileged/i.test(s.labels['focus-provenance']), 'Selecting S2 must not relabel WXD provenance as a LiDAR policy.');
    return { labels: s.labels, screenshot: await shot('06-selected-s2-displayed-wxd') };
  });

  await check('recording details remain reachable and Escape restores the trigger', async () => {
    await page.click('#focus-inspect');
    await page.waitForSelector('#focus-inspector[role="dialog"]', { state: 'visible' });
    await page.click('#tab-health');
    assert.ok(await page.locator('#panel-health').isVisible());
    await page.screenshot({ path: path.join(evidence, '06-recording-details.png') });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#focus-inspector').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'focus-inspect');
    assert.ok(await page.locator('#focus-root').isVisible());
  });

  for (const width of [390, 320]) await check(`mobile ${width}px stage controls fit and setup scrolls`, async () => {
    await page.setViewportSize({ width, height: 844 });
    await page.waitForTimeout(250);
    const selectors = ['#focus-exit', '#focus-setup', '#focus-restart', '#focus-play', '#focus-camera', '#focus-inspect', '#focus-seek', '.focus-facts', '#focus-hint'];
    const boxes = {};
    for (const sel of selectors) {
      const box = await page.locator(sel).boundingBox(); assert.ok(box && box.width > 0 && box.height > 0, `${sel} visible`);
      assert.ok(box.x >= -1 && box.x + box.width <= width + 1 && box.y >= -1 && box.y + box.height <= 845, `${sel} fits viewport ${JSON.stringify(box)}`);
      boxes[sel] = box;
    }
    const entries = Object.entries(boxes);
    for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) {
      const [an, a] = entries[i], [bn, b] = entries[j];
      const overlapX = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
      const overlapY = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      assert.ok(overlapX <= 1 || overlapY <= 1, `${an} overlaps ${bn} by ${overlapX}×${overlapY}px`);
    }
    const widthState = await page.evaluate(() => ({ body: document.body.scrollWidth, root: document.documentElement.scrollWidth, viewport: innerWidth }));
    assert.ok(widthState.body <= width + 1 && widthState.root <= width + 1, `No horizontal page overflow: ${JSON.stringify(widthState)}`);
    const screenshot = await shot(`07-mobile-${width}`);
    await openSetup();
    await page.locator('#rh-duration').scrollIntoViewIfNeeded();
    assert.ok(await page.locator('#rh-duration').isVisible(), 'Lower run settings can scroll into view.');
    await page.locator('#rh-run').scrollIntoViewIfNeeded();
    const run = await page.locator('#rh-run').boundingBox();
    assert.ok(run && run.y >= 0 && run.y + run.height <= 845, 'Actual Run stays reachable in the setup sheet.');
    const setup = await shot(`08-mobile-${width}-setup`);
    await closeSetup();
    return { boxes, widthState, screenshot, setup, scene: await assertScene() };
  });

  await check('leaving focus restores the original palette and Studio layout', async () => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    const before = await palette();
    assert.equal(before.focus, true); assert.equal(before.focusGrid, true);
    await page.click('#focus-exit');
    await page.waitForFunction(() => !window.__studio.focus.active && !document.body.classList.contains('flow-focus'));
    const after = await palette();
    assert.equal(after.focus, false); assert.equal(after.focusGrid, false); assert.ok(after.grids.every(Boolean));
    assert.equal(after.fog, 0x101820);
    const materials = [after.floor, after.ghost, ...after.futures, ...Object.values(after.lines)].filter(m => m?.saved);
    assert.ok(materials.length >= 5, 'Palette restoration must cover floor, ghost and path materials.');
    for (const m of materials) { assert.equal(m.color, m.saved.color); assert.equal(m.opacity, m.saved.opacity); }
    assert.ok(await page.locator('#focus-enter').isVisible()); assert.ok(await page.locator('.inspector').isVisible());
    assert.ok(await page.locator('.dock').isVisible()); assert.ok(await page.locator('#workspace-replay').isVisible());
    assert.equal(new URL(page.url()).searchParams.has('focus'), false);
    return { before, after, screenshot: await shot('09-restored-studio') };
  });
} catch (error) {
  report.checks.push({ name: current, status: 'FAIL', error: error.stack, screenshot: await shot('fatal').catch(() => null) });
  console.error(error.stack);
} finally {
  report.finished = new Date().toISOString();
  report.ok = report.checks.length > 0 && report.checks.every(c => c.status === 'PASS') && !report.errors.length && !report.requests.length;
  await save();
  await browser.close();
}
console.log(JSON.stringify({ ok: report.ok, jobId: report.jobId, checks: report.checks.map(c => ({ name: c.name, status: c.status })), errors: report.errors, requests: report.requests, evidence }, null, 2));
if (!report.ok) process.exitCode = 1;
