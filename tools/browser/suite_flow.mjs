// UI-driven suite rehearsal: arena template + presets -> Run suite -> compare runs.
// Launches real bounded CPU runs (one per preset x seed), one at a time.
//   STUDIO_URL=http://127.0.0.1:8790 STUDIO_POLICY=flow-wx-rf-23326aa-s0 STUDIO_TEMPLATE=slalom node tools/browser/suite_flow.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const policy = process.env.STUDIO_POLICY || 'flow-wx-rf-23326aa-s0';
const template = process.env.STUDIO_TEMPLATE || 'slalom';
const criterion = process.env.STUDIO_CRITERION || 'arrive_hold';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence', `suite-${template}-${Date.now()}`);
await mkdir(evidence, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [], failed = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
const shot = name => page.screenshot({ path: path.join(evidence, `${name}.png`) });

await page.goto(base + '/');
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 90000 });
await page.click('#workspace-arena');
await page.waitForSelector('#arena-base');
await page.selectOption('#arena-base', `tpl:${template}`);
await page.fill('#arena-label', `Studio suite · ${template}`); await page.locator('#arena-label').dispatchEvent('input');
// Mirror the last preset to add a symmetric case.
await page.click(`[data-preset-select="${(await page.evaluate(() => window.__studio.arena.presets.length)) - 1}"]`);
await page.click('#preset-mirror');
const presets = await page.evaluate(() => window.__studio.arena.presets);
await shot('01-arena');
await page.click('#arena-save');
await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
const arenaId = await page.evaluate(() => window.__studio.arena.savedId);
await page.click('#arena-rehearse');
await page.waitForFunction(id => window.__studio.rehearse.mapId === id, arenaId, { timeout: 20000 });
await page.check(`input[name=policy][value="${policy}"]`);
await page.fill('#rh-duration', process.env.STUDIO_DURATION || '8'); await page.locator('#rh-duration').dispatchEvent('change');
await page.selectOption('#rh-criterion', criterion);
await page.click('#rh-suite');
await page.waitForFunction(() => window.__studio.rehearse.suite?.id, null, { timeout: 60000 });
const suiteId = await page.evaluate(() => window.__studio.rehearse.suite.id);
await page.waitForTimeout(15000); await shot('02-suite-running');
await page.waitForFunction(() => ['completed', 'cancelled', 'interrupted'].includes(window.__studio.rehearse.suite?.status), null, { timeout: Number(process.env.STUDIO_SUITE_TIMEOUT_MS || 2400000), polling: 2000 });
const suite = await page.evaluate(() => window.__studio.rehearse.suite);
await shot('03-suite-done');
await page.click('#workspace-runs'); await page.waitForSelector('#runs-map');
await page.selectOption('#runs-map', arenaId); await page.waitForTimeout(500);
for (const run of suite.runs) { const box = page.locator(`[data-run-select="${run.job_id}"]`); if (run.job_id && await box.count() && !(await box.isChecked())) await box.check(); }
await page.waitForTimeout(1200);
const compared = await page.evaluate(() => window.__studio.selectedRuns().map(r => ({ id: r.id, label: r.label, outcome: r.outcome, final: r.metrics.final_goal_distance_m, contact: r.metrics.max_contact_n, elapsed: r.metrics.elapsed_s, planner_p95_ms: r.metrics.planner_p95_ms })));
await shot('04-runs-compare');
const report = { base, policy, template, criterion, arenaId, presets, suite, compared, errors, failed, finished: new Date().toISOString() };
await writeFile(path.join(evidence, 'suite-flow.json'), JSON.stringify(report, null, 1));
console.log(JSON.stringify({ suite: suite.status, runs: suite.runs.map(r => [r.label, r.status, r.outcome]), compared, errors, failed }, null, 1));
await browser.close();
assert.deepEqual(errors, []);
