// Merge the re-validation result files into one summary (later sources override earlier ids).
//   STUDIO_EVIDENCE=... node tools/browser/validation/reval_report.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE } from './harness.mjs';

// Order matters: a later file overrides an earlier one for the same id (reruns with corrected instruments).
const order = ['arena', 'reval-arena-extra', 'replay', 'reval-rehearse', 'reval-race', 'reval-restart', 'reval-restart-b', 'reval-stale-cancel', 'robustness-b', 'runs'];
// replay.mjs 6.5 also matches the MID-360 IMU card; the targeted 6.5 in reval_rehearse.mjs covers the five perception channels.
const superseded = { replay: new Set(['6.5']) };
// Findings recorded as notes by the harness that are judged here (see REVALIDATION.md).
// 5.13 (N5) is now asserted by runs.mjs itself: n = 2, goals = 1, errors = 1 after the fix.
const judged = process.env.JUDGE_N5 === '1'
  ? { '5.13': { status: 'FAIL', note: 'N5: a scored trial is dropped when its latest identical re-run is an error (synthetic rows through runs.js report()).' } }
  : {};
const merged = new Map(), errors = [], http = [], sources = {};
for (const name of order) {
  let d; try { d = JSON.parse(await readFile(path.join(EVIDENCE, `results-${name}.json`), 'utf8')); } catch { continue; }
  errors.push(...d.log.errors.map(e => ({ ...e, source: name }))); http.push(...d.log.http.map(e => ({ ...e, source: name })));
  for (const r of d.results) { if (superseded[name]?.has(r.id)) continue; merged.set(r.id, { ...r, source: name }); sources[r.id] = name; }
}
for (const [id, j] of Object.entries(judged)) if (merged.has(id)) merged.set(id, { ...merged.get(id), ...j });
const live = e => !e.check || sources[e.check] === e.source;
const errs = errors.filter(live), hs = http.filter(live);
merged.set('8.5', { id: '8.5', title: 'No console errors or failed HTTP requests across all flows', status: errs.length || hs.length ? 'FAIL' : 'PASS', source: 'all',
  note: errs.length || hs.length ? `${errs.length} page/console error(s), ${hs.length} HTTP failure(s): ${[...errs, ...hs].map(e => `${e.check} ${(e.text ?? `${e.status} ${e.url}`).split('\n')[0]}`).join('; ')}` : 'none' });
const rows = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const count = s => rows.filter(r => r.status === s).length;
const summary = { generated: new Date().toISOString(), pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'),
  rows: rows.map(r => ({ id: r.id, title: r.title, status: r.status, source: r.source, note: r.note })), unexpectedPageErrors: errs, unexpectedHttp: hs };
await writeFile(path.join(EVIDENCE, 'revalidation-summary.json'), JSON.stringify(summary, null, 1));
for (const r of summary.rows) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(18)} ${r.source.padEnd(18)} ${r.title}${r.status !== 'PASS' ? ' — ' + (r.note ?? '').slice(0, 140) : ''}`);
console.log(`PASS ${summary.pass} FAIL ${summary.fail} BLOCKED ${summary.blocked}`);
