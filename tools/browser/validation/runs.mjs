// Section 5: Runs workspace. Read-only (no runs are launched).
//   STUDIO_URL=http://127.0.0.1:8792 node tools/browser/validation/runs.mjs
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { BASE, EVIDENCE, launch, recorder, assert, near, api, sleep } from './harness.mjs';

const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('runs');
R.watch(page);
await page.goto(`${BASE}/`);
await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await sleep(800);
const table = (await api(page, '/api/runs')).body.runs;
const canvasHash = () => page.evaluate(() => { const c = document.getElementById('runs-canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let h = 0; for (let i = 0; i < d.length; i += 97) h = (h * 31 + d[i]) >>> 0; return h; });
const rowIds = () => page.locator('[data-run-select]').evaluateAll(x => x.map(i => i.dataset.runSelect));

// Independent re-implementation of the robustness grouping (runs.js report) for cross-checking.
const wilson = (k, n, z = 1.96) => { if (!n) return [null, null]; const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d; return [Math.max(0, c - h), Math.min(1, c + h)]; };
// v0.3 semantics (runs.js report): one trial per scenario id (latest start wins); error runs
// (runtime_error outcome or failed status without a scorer outcome) are listed, not counted.
const isError = r => !['goal_completion', 'timeout', 'obstacle_collision', 'fall'].includes(r.outcome) && (r.outcome === 'runtime_error' || r.status === 'failed');
function groups(rows) {
  const g = new Map();
  for (const r of rows.filter(x => x.outcome || x.status === 'failed')) {
    const key = `${r.policy_id} · ${r.criterion ?? 'arrive_hold'} · lat ${r.latency?.ms ?? 0}${r.latency?.anchor === 'predict' ? 'p' : ''} · K${r.planner?.candidates}/ODE${r.planner?.ode_steps}`;
    if (!g.has(key)) g.set(key, []); g.get(key).push(r);
  }
  return [...g.entries()].map(([key, all]) => {
    const byScenario = {};
    for (const r of [...all].sort((a, b) => (a.started_unix_s ?? 0) - (b.started_unix_s ?? 0))) byScenario[r.scenario_id ?? r.id] = r;
    const unique = Object.values(byScenario), list = unique.filter(r => !isError(r));
    return { key, n: list.length, repeats: all.length - unique.length, errors: unique.length - list.length, errorIds: unique.filter(isError).map(r => r.id),
      goals: list.filter(r => r.outcome === 'goal_completion').length, reach: list.filter(r => r.derived?.reach_post_hoc?.reached).length, contact: list.filter(r => (r.metrics.max_contact_n ?? 0) > 0).length };
  });
}

await R.check('5.1', 'Runs list matches /api/runs', async () => {
  const ids = await rowIds();
  const rows = await page.locator('.run-row').count();
  assert(rows === table.length && rows > 0, `rows ${rows} vs api ${table.length}`);
  const first = await page.locator('.run-row').first().textContent();
  assert(/K\d+\/ODE\d+/.test(first) && /final/.test(first), `row text ${first}`);
  const cancelled = table.find(r => r.status === 'cancelled');
  if (cancelled) { const t = await page.locator('.run-row', { has: page.locator(`[data-run-select="${cancelled.id}"]`) }).textContent(); assert(/cancelled/i.test(t) && !/Goal reached/.test(t), `cancelled row ${t}`); }
  return { rows, statuses: table.map(r => [r.id, r.status, r.outcome]), shot: await R.shot('list') };
});

await R.check('5.2', 'Filters: arena, policy, outcome', async () => {
  const out = {};
  for (const p of [...new Set(table.map(r => r.policy_id))]) {
    await page.selectOption('#runs-policy', p); await sleep(150);
    const n = await page.locator('.run-row').count(); assert(n === table.filter(r => r.policy_id === p).length, `policy ${p}: ${n}`); out[p] = n;
  }
  await page.selectOption('#runs-policy', '');
  for (const o of [...new Set(table.map(r => r.outcome ?? r.status))]) {
    await page.selectOption('#runs-outcome', o); await sleep(150);
    const n = await page.locator('.run-row').count(); assert(n === table.filter(r => (r.outcome ?? r.status) === o).length, `outcome ${o}: ${n}`); out[o] = n;
  }
  await page.selectOption('#runs-outcome', '');
  const map = table[0].map_id; await page.selectOption('#runs-map', map); await sleep(150);
  const n = await page.locator('.run-row').count(); assert(n === table.filter(r => r.map_id === map).length, `map ${map}: ${n}`); out[map] = n;
  const label = await page.locator(`#runs-map option[value="${map}"]`).textContent();
  await page.selectOption('#runs-map', '');
  return { ...out, mapLabel: label };
});

await R.check('5.3', 'Color modes: by outcome / by policy', async () => {
  const sw = () => page.locator('.run-row .run-check i').evaluateAll(x => x.map(i => i.style.background));
  const a = await sw();
  await page.check('input[name=runs-color][value=policy]'); await sleep(200); const b = await sw();
  const byPolicy = new Map(); table.forEach((r, i) => { if (!byPolicy.has(r.policy_id)) byPolicy.set(r.policy_id, new Set()); byPolicy.get(r.policy_id).add(b[i]); });
  await page.check('input[name=runs-color][value=outcome]'); await sleep(200); const c = await sw();
  assert(JSON.stringify(a) === JSON.stringify(c) && JSON.stringify(a) !== JSON.stringify(b) && [...byPolicy.values()].every(s => s.size === 1), `colors ${JSON.stringify({ a, b })}`);
  assert(new Set([...byPolicy.values()].map(s => [...s][0])).size === byPolicy.size, 'distinct policy colors');
  return { byOutcome: [...new Set(a)], byPolicy: Object.fromEntries([...byPolicy].map(([k, v]) => [k, [...v]])) };
});

await R.check('5.4', 'Select / deselect updates the comparison canvas', async () => {
  const ids = await rowIds(); const enabled = await page.locator('[data-run-select]:not([disabled])').evaluateAll(x => x.map(i => i.dataset.runSelect));
  for (const id of await page.evaluate(() => [...window.__studio.runs.selected])) await page.uncheck(`[data-run-select="${id}"]`).catch(() => {});
  await sleep(300); const h0 = await canvasHash(); const n0 = await page.evaluate(() => window.__studio.selectedRuns().length);
  await page.check(`[data-run-select="${enabled[0]}"]`); await sleep(400); const h1 = await canvasHash(); const n1 = await page.evaluate(() => window.__studio.selectedRuns().length);
  await page.check(`[data-run-select="${enabled[1]}"]`); await sleep(400); const h2 = await canvasHash();
  await page.uncheck(`[data-run-select="${enabled[1]}"]`); await sleep(400); const h3 = await canvasHash();
  const n3 = await page.evaluate(() => window.__studio.selectedRuns().length);
  assert(n0 === 0 && n1 === 1 && n3 === 1 && h0 !== h1 && h1 !== h2 && h3 !== h2, `selection ${n0}/${n1}/${n3} hashes ${[h0, h1, h2, h3]}`); // h3 vs h1 differs by GPU-canvas antialiasing only (visually identical, probe_compare.mjs)
  const shot = await R.shot('compare-one');
  return { ids: ids.length, enabled: enabled.length, shot };
});

await R.check('5.5', 'Select all in view (respects filters)', async () => {
  const p = table.find(r => r.policy_id === 'flow-bundle-20261008')?.policy_id;
  await page.selectOption('#runs-policy', p); await sleep(200);
  await page.click('#runs-select-all'); await sleep(400);
  const sel = await page.evaluate(() => window.__studio.selectedRuns().map(r => r.id));
  const expect = table.filter(r => r.policy_id === p && r.trajectory).slice(0, 64).map(r => r.id);
  await page.selectOption('#runs-policy', ''); await sleep(200);
  const shot = await R.shot('compare-all');
  assert(JSON.stringify(sel.sort()) === JSON.stringify(expect.sort()), `select all ${sel.length} vs ${expect.length}`);
  return { selected: sel.length, shot };
});

await R.check('5.6', 'Robustness report numbers match a hand recomputation from /api/runs', async () => {
  const shown = await page.locator('.report-group').evaluateAll(gs => gs.map(g => ({ key: g.querySelector('.report-key').textContent, main: [...g.querySelectorAll('.report-main')].map(m => m.textContent), cats: g.querySelector('.report-cats').textContent, meta: [...g.querySelectorAll('.report-meta')].map(m => m.textContent) })));
  const mine = groups(table);
  assert(shown.length === mine.length, `groups ${shown.length} vs ${mine.length}`);
  const out = [];
  for (const g of mine) {
    const s = shown.find(x => x.key === g.key); assert(s, `group ${g.key} missing`);
    const [k, n] = s.main[0].match(/(\d+)\/(\d+)/).slice(1).map(Number), [rk] = s.main[1].match(/(\d+)\/(\d+)/).slice(1).map(Number);
    assert(k === g.goals && n === g.n && rk === g.reach, `${g.key}: shown ${k}/${n} reach ${rk} vs ${g.goals}/${g.n} reach ${g.reach}`);
    const ci = wilson(g.goals, g.n), txt = s.main[0];
    if (ci[0] !== null) assert(txt.includes(`[${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%]`), `CI ${txt} vs ${ci}`);
    const contactMeta = s.meta.find(m => /with obstacle contact/.test(m)) ?? '';
    assert(contactMeta.startsWith(`${g.contact} run`), `contact runs ${contactMeta} vs ${g.contact}`);
    const flags = s.meta.join(' | ');
    if (g.errors) assert(flags.includes(`${g.errors} error run${g.errors > 1 ? 's' : ''} excluded from rates`), `${g.key}: errors ${g.errors} not listed: ${flags}`);
    if (g.repeats) assert(flags.includes(`${g.repeats} identical re-run${g.repeats > 1 ? 's' : ''} counted once`), `${g.key}: repeats ${g.repeats} not listed: ${flags}`);
    if (!g.errors) assert(!/excluded from rates/.test(flags), `${g.key}: unexpected error note ${flags}`);
    out.push({ key: g.key, shown: s.main, flags, mine: g });
  }
  // Cancelled runs are excluded from n; failed runs count as errors.
  return { groups: out, excluded: table.filter(r => !(r.outcome || r.status === 'failed')).map(r => [r.id, r.status]) };
});

await R.check('5.7', 'CSV and JSON export download and contain the rows in view', async () => {
  const d1p = page.waitForEvent('download'); await page.click('#runs-export'); const d1 = await d1p;
  const f1 = path.join(EVIDENCE, `runs-${d1.suggestedFilename()}`); await d1.saveAs(f1);
  const csv = (await readFile(f1, 'utf8')).trim().split('\n');
  const d2p = page.waitForEvent('download'); await page.click('#runs-export-json'); const d2 = await d2p;
  const f2 = path.join(EVIDENCE, `runs-${d2.suggestedFilename()}`); await d2.saveAs(f2);
  const json = JSON.parse(await readFile(f2, 'utf8'));
  const ids = csv.slice(1).map(l => l.split(',')[0]);
  assert(csv[0].startsWith('id,label,policy_id,map_id') && csv.length - 1 === table.length && table.every(r => ids.includes(r.id)), `csv rows ${csv.length - 1}`);
  assert(json.runs.length === table.length && Array.isArray(json.report) && !('trajectory' in json.runs[0]), `json runs ${json.runs.length}`);
  return { csv: f1, json: f2, rows: csv.length - 1, header: csv[0] };
});

await R.check('5.8', 'Replay button opens the run in Replay (Health tab)', async () => {
  // Pick a row that is not already open, so the wait below observes the new load (not the current session).
  const current = await page.evaluate(() => window.__studio.state.sessionId);
  const run = table.find(r => r.replayable && r.id !== current) ?? table.find(r => r.replayable);
  const gen = await page.evaluate(() => window.__studio.state.loadGeneration);
  await page.click(`.run-row:has([data-run-select="${run.id}"]) [data-open-session]`);
  await page.waitForFunction(([id, gen]) => window.__studio.state.sessionId === id && window.__studio.state.loadGeneration > gen && !window.__studio.state.loading && document.querySelector('#loading-overlay').hidden, [run.id, gen], { timeout: 60000 });
  await sleep(300);
  const ws = await page.evaluate(() => window.__studio.state.workspace), tab = await page.locator('[role=tab][aria-selected=true]').getAttribute('data-tab');
  assert(ws === 'replay' && tab === 'health', `ws ${ws} tab ${tab}`);
  return { run: run.id, shot: await R.shot('replay-from-runs') };
});

await R.check('5.9', '3D comparison overlay is cleared after leaving Runs', async () => {
  await page.click('#workspace-runs'); await sleep(500);
  const n = await page.evaluate(async () => (await import('/js/scene.js')).view.compareGroup.children.length);
  await page.click('#workspace-replay'); await sleep(200);
  const m = await page.evaluate(async () => (await import('/js/scene.js')).view.compareGroup.children.length);
  assert(m === 0, `compare overlay left in the 3D scene after leaving Runs: ${m}`);
  return { inRuns: n, afterLeave: m };
});

await R.check('5.10', 'Robustness report: an error run is listed as excluded (not counted as a failure)', async () => {
  await page.click('#workspace-runs'); await page.waitForSelector('#runs-map'); await sleep(500);
  const mine = groups(table).filter(g => g.errors);
  if (!mine.length) return R.blocked('no error run in the table');
  const shown = await page.locator('.report-group').evaluateAll(gs => gs.map(g => ({ key: g.querySelector('.report-key').textContent, text: g.textContent })));
  const out = [];
  for (const g of mine) {
    const s = shown.find(x => x.key === g.key); assert(s, `group ${g.key} missing`);
    assert(new RegExp(`${g.errors} error runs? excluded from rates`).test(s.text) && !/\berror \d/.test(s.text.split('excluded from rates')[1] ?? ''), `${g.key}: ${s.text.slice(0, 400)}`);
    out.push({ key: g.key, errors: g.errors, errorIds: g.errorIds, n: g.n });
  }
  return { groups: out, shot: await R.shot('report-errors') };
});

await R.check('5.11', 'Robustness report: identical re-runs of one scenario count once', async () => {
  const counts = {}; for (const r of table.filter(x => x.outcome || x.status === 'failed')) counts[r.scenario_id] = (counts[r.scenario_id] ?? 0) + 1;
  const repeated = Object.entries(counts).filter(([, n]) => n > 1);
  if (!repeated.length) return R.blocked('no repeated scenario in the table');
  const g = groups(table).filter(x => x.repeats);
  const shown = await page.locator('.report-group').evaluateAll(gs => gs.map(g => ({ key: g.querySelector('.report-key').textContent, text: g.textContent, n: g.querySelector('.report-main strong').textContent })));
  for (const x of g) { const s = shown.find(y => y.key === x.key); assert(s && s.n.endsWith(`/${x.n}`) && new RegExp(`${x.repeats} identical re-runs? counted once`).test(s.text), `${x.key}: shown ${s?.n} vs n=${x.n}, repeats ${x.repeats}: ${s?.text.slice(0, 300)}`); }
  return { repeated: repeated.map(([sid, n]) => ({ sid, n, runs: table.filter(r => r.scenario_id === sid).map(r => [r.id, r.status, r.outcome]) })), groups: g.map(x => ({ key: x.key, n: x.n, repeats: x.repeats })) };
});

await R.check('5.12', "Run rows show '<arena> · <preset name>' (full label in the tooltip)", async () => {
  const maps = (await api(page, '/api/workbench')).body.maps;
  const rows = await page.locator('.run-row').evaluateAll(rs => rs.map(r => ({ id: r.querySelector('[data-run-select]').dataset.runSelect, text: r.querySelector('.run-title span[title]')?.textContent, title: r.querySelector('.run-title span[title]')?.getAttribute('title') })));
  const bad = [];
  for (const r of rows) { const t = table.find(x => x.id === r.id); if (!t?.preset_label) continue; const want = `${maps.find(m => m.id === t.map_id)?.label ?? t.map_id} · ${t.preset_label}`; if (r.text !== want || r.title !== t.label) bad.push({ id: r.id, text: r.text, want, title: r.title }); }
  const withPreset = table.filter(r => r.preset_label).length;
  assert(withPreset > 0 && !bad.length, `rows with preset ${withPreset}; mismatches ${JSON.stringify(bad.slice(0, 4))}`);
  return { withPreset, sample: rows.slice(0, 4) };
});

await R.check('5.13', 'Report dedupe when the latest identical re-run is an error (synthetic rows through runs.js report())', async () => {
  const res = await page.evaluate(async () => {
    const { report } = await import('/js/runs.js');
    const base = { policy_id: 'p', criterion: 'arrive_hold', latency: { ms: 0, anchor: 'measured' }, planner: { candidates: 2, ode_steps: 4 }, metrics: {}, derived: {} };
    const rows = [{ ...base, id: 'a', scenario_id: 's1', status: 'completed', outcome: 'goal_completion', started_unix_s: 1 },
                  { ...base, id: 'b', scenario_id: 's1', status: 'failed', outcome: null, started_unix_s: 2 },
                  { ...base, id: 'c', scenario_id: 's2', status: 'completed', outcome: 'timeout', started_unix_s: 3 }];
    const g = report(rows)[0]; return { n: g.n, goals: g.goals, errors: g.errors, repeats: g.repeats };
  });
  // N5: errors are set aside before the latest-per-scenario dedupe, so s1 keeps its scored goal.
  assert(res.n === 2 && res.goals === 1 && res.errors === 1 && res.repeats === 0, `report ${JSON.stringify(res)} (expected n 2, goals 1, errors 1, repeats 0)`);
  return res;
});

await R.save({ runs: table.length });
await browser.close();
