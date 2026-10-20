// Robustness campaign step 1: create the random-goal arenas through the Arena
// workspace's seeded generator (exercises the UI feature end to end).
//   STUDIO_URL=http://127.0.0.1:8790 STUDIO_EVIDENCE=<dir> node tools/campaign/make_arenas.mjs
// Writes <evidence>/arenas.json and one screenshot per arena. Saving an arena is
// the only mutation; no rehearsal is started here.
import { chromium } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const evidence = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/robustness-20261020');
await mkdir(path.join(evidence, 'screens'), { recursive: true });

const ARENAS = [
  { key: 'open', template: 'empty', label: 'Robustness · open floor · rg101', count: 6, min: 1.5, max: 4.5, seed: 101, randomStart: true },
  { key: 'clutter', template: 'clutter', templateSeed: 7, label: 'Robustness · clutter s7 · rg102', count: 6, min: 1.5, max: 4.5, seed: 102, randomStart: false },
  { key: 'doorway', template: 'doorway', label: 'Robustness · doorway · rg103', count: 6, min: 2.0, max: 4.5, seed: 103, randomStart: false },
  { key: 'slalom', template: 'slalom', label: 'Robustness · slalom · rg104', count: 6, min: 1.5, max: 4.5, seed: 104, randomStart: false },
];

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [], failed = [], uiErrors = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
await page.goto(base + '/');
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-arena');
await page.waitForSelector('#arena-base');

const out = [];
for (const a of ARENAS) {
  if (a.templateSeed !== undefined) await page.fill('#arena-seed', String(a.templateSeed));
  await page.selectOption('#arena-base', `tpl:${a.template}`);
  await page.waitForTimeout(300);
  const templatePresets = await page.evaluate(() => structuredClone(window.__studio.arena.presets));
  await page.fill('#arena-label', a.label); await page.locator('#arena-label').dispatchEvent('input');
  if (!(await page.locator('details.random-goals').evaluate(d => d.open))) await page.click('.random-goals summary');
  await page.fill('#rg-count', String(a.count));
  await page.fill('#rg-min', String(a.min));
  await page.fill('#rg-max', String(a.max));
  await page.fill('#rg-seed', String(a.seed));
  await page.selectOption('#rg-heading', 'toward');
  if ((await page.isChecked('#rg-start')) !== a.randomStart) await page.click('#rg-start');
  if (await page.isChecked('#rg-append')) await page.click('#rg-append');
  const errBefore = await page.evaluate(() => document.querySelector('#toast, .toast, [role=alert]')?.textContent ?? null).catch(() => null);
  await page.click('#rg-generate');
  await page.waitForTimeout(400);
  const presets = await page.evaluate(() => structuredClone(window.__studio.arena.presets));
  const description = await page.evaluate(() => window.__studio.arena.description);
  const errAfter = await page.evaluate(() => [...document.querySelectorAll('.toast, [role=alert], .error')].map(n => n.textContent.trim()).filter(Boolean)).catch(() => []);
  if (presets.length < a.count) uiErrors.push({ arena: a.key, generated: presets.length, requested: a.count, messages: errAfter });
  await page.click('#arena-save');
  await page.waitForFunction(() => window.__studio.arena.savedId, null, { timeout: 20000 });
  const arenaId = await page.evaluate(() => window.__studio.arena.savedId);
  await page.screenshot({ path: path.join(evidence, 'screens', `arena-${a.key}.png`) });
  const map = await page.evaluate(async id => (await fetch(`/api/map?id=${encodeURIComponent(id)}`)).json(), arenaId);
  out.push({ ...a, arena_id: arenaId, map_sha256: map.sha256, server_label: map.label, description, template_presets: templatePresets,
    generated_presets: presets, server_presets: map.presets, boxes: map.boxes, bounds: map.bounds, toast_before: errBefore, ui_messages: errAfter });
  console.log(a.key, arenaId, presets.length, 'presets', JSON.stringify(presets.map(q => [q.start_xy, q.goal_xy, +q.start_yaw_rad.toFixed(3)])));
}
await writeFile(path.join(evidence, 'arenas.json'), JSON.stringify({ base, created: new Date().toISOString(), arenas: out, errors, failed, uiErrors }, null, 1));
console.log(JSON.stringify({ errors, failed, uiErrors }));
await browser.close();
