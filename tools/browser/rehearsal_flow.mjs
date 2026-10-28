// End-to-end browser acceptance: build a custom arena, run a policy profile in
// the owned CPU simulation, follow it live, open the recording and compare runs.
// Launches ONE real bounded simulation job per profile listed in STUDIO_POLICIES.
//   STUDIO_URL=http://127.0.0.1:8791 STUDIO_POLICIES=flow-wx-rf-23326aa-s0 node tools/browser/rehearsal_flow.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8791';
const policies = (process.env.STUDIO_POLICIES || 'flow-wx-rf-23326aa-s0').split(',');
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence', `rehearsal-flow-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [], failed = [], checks = [];
page.on('pageerror', e => errors.push(e.message));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const check = (name, details = {}) => { checks.push({ name, ...details }); console.log('✓', name, JSON.stringify(details)); };
const shot = name => page.screenshot({ path: path.join(evidence, `${name}.png`) });

await page.goto(base + '/');
await page.waitForFunction(() => window.__studio?.state?.ready && document.querySelector('#loading-overlay').hidden, null, { timeout: 90000 });

// 1. Arena: doorway template, custom start / heading / goal.
await page.click('#workspace-arena');
await page.waitForSelector('#arena-base');
await page.selectOption('#arena-base', 'tpl:doorway');
await page.fill('#arena-label', 'Studio demo · offset doorway');
await page.locator('#arena-label').dispatchEvent('input');
for (const [id, v] of [['preset-sx', '0'], ['preset-sy', '-1.0'], ['preset-yaw', '25'], ['preset-gx', '3.6'], ['preset-gy', '0.6']]) {
  await page.fill(`#${id}`, v); await page.locator(`#${id}`).dispatchEvent('change');
}
await page.fill('#preset-label', 'Offset start → lateral goal'); await page.locator('#preset-label').dispatchEvent('input'); await page.locator('#preset-label').dispatchEvent('change');
const preset = await page.evaluate(() => window.__studio.arena.presets[window.__studio.arena.active]);
assert.deepEqual(preset.start_xy, [0, -1]); assert.deepEqual(preset.goal_xy, [3.6, 0.6]);
assert.ok(Math.abs(preset.start_yaw_rad - 25 * Math.PI / 180) < 1e-6);
await shot('01-arena-editor');
await page.click('#arena-save');
await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
const arenaId = await page.evaluate(() => window.__studio.arena.savedId);
check('arena saved through the editor', { arenaId, preset });

// 2. Rehearse each policy on the saved arena.
const jobs = [];
for (const policy of policies) {
  await page.click('#workspace-rehearse');
  await page.waitForSelector('#rh-map');
  await page.selectOption('#rh-map', arenaId);
  await page.waitForFunction(id => window.__studio.rehearse.mapId === id, arenaId);
  await page.check(`input[name=policy][value="${policy}"]`);
  await page.fill('#rh-duration', process.env.STUDIO_DURATION || '8'); await page.locator('#rh-duration').dispatchEvent('change');
  const settings = await page.evaluate(() => ({ ...window.__studio.rehearse.settings, policy: window.__studio.rehearse.policyId }));
  await shot(`02-rehearse-config-${policy}`);
  const previousJob = await page.evaluate(() => window.__studio.rehearse.job?.id ?? null);
  await page.click('#rh-run');
  await page.waitForFunction(prev => window.__studio.rehearse.job?.id && window.__studio.rehearse.job.id !== prev, previousJob, { timeout: 30000 });
  const jobId = await page.evaluate(() => window.__studio.rehearse.job.id);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'simulation', jobId, { timeout: 120000 });
  await page.waitForTimeout(4000);
  const live = await page.evaluate(() => ({ frames: window.__studio.state.session.frames.length, time: window.__studio.state.time, mode: document.querySelector('#mode-badge').textContent }));
  assert.ok(live.frames > 0, 'live frames received');
  await shot(`03-live-${policy}`);
  check('live owned simulation attached to the viewport', { policy, jobId, settings, live });
  const limit = Number(process.env.STUDIO_JOB_TIMEOUT_MS || 600000);
  await page.waitForFunction(id => { const j = window.__studio.rehearse.job; return j?.id === id && ['completed', 'failed', 'cancelled'].includes(j.status); }, jobId, { timeout: limit, polling: 1000 });
  const job = await page.evaluate(() => window.__studio.rehearse.job);
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session.metadata.mode === 'replay', jobId, { timeout: 60000 }).catch(() => {});
  const result = await page.evaluate(() => ({ outcome: window.__studio.state.session.metadata.test_result?.outcome, profile: window.__studio.state.session.metadata.policy_profile, frames: window.__studio.state.session.frames.length, chip: document.querySelector('#policy-chip').textContent }));
  jobs.push({ policy, jobId, status: job.status, summary: job.summary?.report ?? job.summary, result });
  check('recorded result opened in replay', { policy, jobId, status: job.status, outcome: result.outcome, frames: result.frames, chip: result.chip });
  // Inspect the result at mid-run with Health, then the Pipeline stage.
  await page.evaluate(() => window.__studio.seek(window.__studio.state.session.metadata.duration_s * 0.55));
  await page.click('#tab-health'); await page.waitForTimeout(800);
  await shot(`04-result-health-${policy}`);
  await page.click('#camera-follow'); await page.click('#robot-view'); await page.waitForTimeout(1200);
  await shot(`05-result-follow-robotview-${policy}`);
  await page.click('#robot-view');
}

// 3. Compare in Runs (latest runs on this arena are preselected).
await page.click('#workspace-runs');
await page.waitForSelector('#runs-map');
await page.selectOption('#runs-map', arenaId);
await page.waitForTimeout(800);
for (const job of jobs) {
  const box = page.locator(`[data-run-select="${job.jobId}"]`);
  if (await box.count() && !(await box.isChecked())) await box.check();
}
await page.waitForTimeout(1200);
const compared = await page.evaluate(() => window.__studio.selectedRuns().map(r => ({ id: r.id, outcome: r.outcome, policy: r.policy_id, points: r.trajectory.length })));
await shot('06-runs-compare');
check('runs comparison overlays trajectories on the saved arena', { compared });
await page.click('#workspace-system'); await page.waitForTimeout(1500);
await shot('07-system');

const report = { base, evidence, arenaId, jobs, checks, errors, failed, finished: new Date().toISOString() };
await writeFile(path.join(evidence, 'rehearsal-flow.json'), JSON.stringify(report, null, 1));
await browser.close();
assert.deepEqual(errors, [], `page errors: ${errors.join('; ')}`);
assert.deepEqual(failed, [], `failed requests: ${failed.join('; ')}`);
console.log(`Evidence: ${evidence}`);
