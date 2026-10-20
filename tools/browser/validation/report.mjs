// Merge the validation result files into one summary (later sources override earlier ids).
//   node tools/browser/validation/report.mjs
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EVIDENCE } from './harness.mjs';

const order = ['arena', 'rehearse', 'rehearse-b', 'suite', 'cancel', 'replay', 'replay-b', 'runs', 'robustness', 'robustness-b'];
const merged = new Map(), errors = [], http = [], sources = {};
const drop = new Set(['4.10b']); // superseded by suite_cancel.mjs (4.10 / 4.10a / 4.10c)
for (const name of order) {
  let rows = [];
  try {
    const d = JSON.parse(await readFile(path.join(EVIDENCE, `results-${name}.json`), 'utf8'));
    rows = d.results; errors.push(...d.log.errors.map(e => ({ ...e, source: name }))); http.push(...d.log.http.map(e => ({ ...e, source: name })));
  } catch {
    if (name !== 'rehearse') continue;
    // Fallback: rebuild a pass from its console log when its results file is missing.
    const log = await readFile(path.join(EVIDENCE, 'rehearse.log'), 'utf8').catch(() => '');
    rows = log.split('\n').map(l => l.match(/^(✓|✕|∅) \[([\d.a-z]+)\] (.*?)(?: — (.*))?$/)).filter(Boolean)
      .map(m => ({ id: m[2], title: m[3], status: m[1] === '✓' ? 'PASS' : m[1] === '✕' ? 'FAIL' : 'BLOCKED', note: m[4] ?? '', evidence: { log: 'rehearse.log' } }));
  }
  for (const r of rows) { if (drop.has(r.id)) continue; merged.set(r.id, { ...r, source: name }); sources[r.id] = name; }
}
// Keep only errors attributed to the final (non-superseded) source of each check.
const live = e => !e.check || sources[e.check] === e.source;
errors.splice(0, errors.length, ...errors.filter(live)); http.splice(0, http.length, ...http.filter(live));
// 8.5 is the global error capture across every flow (attributed errors are listed with their checks).
merged.set('8.5', { id: '8.5', title: 'No console errors or failed HTTP requests across all flows', status: errors.length || http.length ? 'FAIL' : 'PASS', source: 'all',
  note: errors.length || http.length ? `${errors.length} unexpected page/console error(s), ${http.length} unexpected HTTP failure(s): ${errors.map(e => e.check + ' ' + e.text.split('\n')[0]).join('; ')}` : 'none' });
const rows = [...merged.values()].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }));
const count = s => rows.filter(r => r.status === s).length;
const summary = { generated: new Date().toISOString(), pass: count('PASS'), fail: count('FAIL'), blocked: count('BLOCKED'),
  rows: rows.map(r => ({ id: r.id, title: r.title, status: r.status, source: r.source, note: r.note })), unexpectedPageErrors: errors, unexpectedHttp: http };
await writeFile(path.join(EVIDENCE, 'validation-summary.json'), JSON.stringify(summary, null, 1));
for (const r of summary.rows) console.log(`${r.status.padEnd(7)} ${r.id.padEnd(6)} ${r.title}${r.status !== 'PASS' ? ' — ' + r.note.slice(0, 160) : ''}`);
console.log(`PASS ${summary.pass} FAIL ${summary.fail} BLOCKED ${summary.blocked}`);
console.log('unexpected page errors', JSON.stringify(errors)); console.log('unexpected http', JSON.stringify(http).slice(0, 600));
