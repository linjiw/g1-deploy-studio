// Robustness campaign screenshots from the Runs workspace comparison (read-only UI use).
//   STUDIO_URL=http://127.0.0.1:8790 node tools/campaign/screens.mjs <spec.json> <out-dir>
// spec: { "shots": [ { "name": "...", "map": "arena-…", "jobs": ["job-…"], "color": "outcome"|"policy", "policy": "" } ] }
import { chromium } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const base = process.env.STUDIO_URL || 'http://127.0.0.1:8790';
const [specPath, outDir] = process.argv.slice(2);
const spec = JSON.parse(await readFile(specPath, 'utf8'));
await mkdir(outDir, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [], failed = [], results = [];
page.on('pageerror', e => errors.push(e.message));
page.on('response', r => { if (r.status() >= 400) failed.push(`${r.status()} ${r.url()}`); });
await page.goto(base + '/');
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-runs');
await page.waitForSelector('#runs-map');
await page.waitForFunction(() => window.__studio.runs.table.length > 0, null, { timeout: 120000 });
for (const shot of spec.shots) {
  await page.evaluate(() => window.__studio.runs.selected.clear());
  await page.selectOption('#runs-policy', shot.policy ?? '');
  await page.selectOption('#runs-map', shot.map ?? '');
  await page.check(`input[name=runs-color][value=${shot.color ?? 'outcome'}]`);
  const missing = [];
  for (const id of shot.jobs) {
    const box = page.locator(`[data-run-select="${id}"]`);
    if (!(await box.count())) { missing.push(id); continue; }
    if (!(await box.isChecked())) await box.check();
  }
  await page.waitForTimeout(900);
  const selected = await page.evaluate(() => window.__studio.selectedRuns().map(r => ({ id: r.id, outcome: r.outcome, policy: r.policy_id, final: r.metrics.final_goal_distance_m })));
  const report = await page.evaluate(() => [...document.querySelectorAll('.report-group')].map(n => n.innerText));
  await page.screenshot({ path: path.join(outDir, `${shot.name}.png`) });
  if (shot.report) {
    // Scroll the runs panel back to its top so the robustness report is visible.
    await page.evaluate(() => { for (let n = document.querySelector('#runs-panel'); n; n = n.parentElement) n.scrollTop = 0; });
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outDir, `${shot.name}-report.png`) });
  }
  results.push({ ...shot, missing, selected, report });
  console.log(shot.name, selected.length, 'selected', missing.length ? `missing ${missing}` : '');
}
await writeFile(path.join(outDir, 'screens.json'), JSON.stringify({ base, results, errors, failed, finished: new Date().toISOString() }, null, 1));
console.log(JSON.stringify({ errors, failed }));
await browser.close();
