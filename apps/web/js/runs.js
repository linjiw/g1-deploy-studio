// Runs browser and comparison overlay. Every row is an owned CPU rehearsal;
// outcomes come from the unmodified source scorer and are not hardware results.
import { $, escape, num, request, outcomeChip, outcomeColor, ago, emit, finite, download } from './util.js';

// Wilson 95% interval for k successes in n trials (honest for small n).
export function wilson(k, n, z = 1.96) {
  if (!n) return [null, null];
  const p = k / n, d = 1 + z * z / n, c = (p + z * z / (2 * n)) / d, h = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}
const median = xs => { const v = xs.filter(finite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
export function category(r) {
  if (r.outcome === 'goal_completion') return 'goal';
  if (r.outcome === 'timeout') return (r.metrics.final_goal_distance_m ?? Infinity) <= 0.5 ? 'timeout_near' : 'timeout_far';
  if (r.outcome === 'obstacle_collision') return 'collision';
  if (r.outcome === 'fall') return 'fall';
  if (r.outcome === 'runtime_error' || r.status === 'failed') return 'error';
  return r.outcome ?? r.status ?? 'unknown';
}
const CATEGORY_LABEL = { goal: 'goal', timeout_near: 'timeout ≤0.5 m', timeout_far: 'timeout >0.5 m', collision: 'collision', fall: 'fall', error: 'error' };

export function report(rows) {
  const groups = new Map();
  for (const r of rows.filter(x => x.outcome || x.status === 'failed')) {
    const key = `${r.policy_id} · ${r.criterion ?? 'arrive_hold'} · lat ${r.latency?.ms ?? 0}${r.latency?.anchor === 'predict' ? 'p' : ''} · K${r.planner?.candidates}/ODE${r.planner?.ode_steps} · ${r.actuators ?? 'source'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  return [...groups.entries()].map(([key, all]) => {
    // Tool/worker errors are not policy trials: set them aside first, so an errored re-run
    // never hides an earlier scored run of the same scenario.
    const errors = all.filter(r => category(r) === 'error'), scored = all.filter(r => category(r) !== 'error');
    // One trial per scenario: an identical re-run (same scenario id) is a repeat, not new evidence.
    const latest = new Map();
    for (const r of scored) { const k = r.scenario_id ?? r.id; if (!latest.has(k) || (r.started_unix_s ?? 0) > (latest.get(k).started_unix_s ?? 0)) latest.set(k, r); }
    const list = [...latest.values()];
    const n = list.length, goals = list.filter(r => r.outcome === 'goal_completion');
    const reach = list.filter(r => r.derived?.reach_post_hoc?.reached);
    const cats = {};
    for (const r of list) cats[category(r)] = (cats[category(r)] ?? 0) + 1;
    return { key, n, repeats: scored.length - list.length, errors: errors.length, goals: goals.length, ci: wilson(goals.length, n), reach: reach.length, reachCi: wilson(reach.length, n), cats,
      timeToGoal: median(goals.map(r => r.metrics.elapsed_s)), reachTime: median(reach.map(r => r.derived.reach_post_hoc.time_s)),
      efficiency: median(goals.map(r => r.derived?.path_efficiency)), contactRuns: list.filter(r => (r.metrics.max_contact_n ?? 0) > 0).length,
      saturatedRuns: list.filter(r => (r.torque_at_limit ?? Object.keys(r.torque?.saturated_substeps ?? {})).length).length, torqueKnown: list.filter(r => r.torque).length,
      plannerP95: median(list.map(r => r.metrics.planner_p95_ms)), finalMedian: median(list.map(r => r.metrics.final_goal_distance_m)) };
  });
}
const pct = (k, n) => n ? `${Math.round(100 * k / n)}%` : '—';
const ciText = ci => ci[0] === null ? '' : ` [${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%]`;

function reportHtml(rows) {
  const groups = report(rows);
  if (!groups.length) return '';
  return `<div class="panel-section"><h4>Robustness report · runs in view</h4>${groups.map(g => `<div class="report-group">
      <div class="report-key">${escape(g.key)}</div>
      ${g.errors || g.repeats ? `<div class="report-meta">${g.errors ? `<span class="cat cat-error">${g.errors} error run${g.errors > 1 ? 's' : ''} excluded from rates</span> ` : ''}${g.repeats ? `${g.repeats} identical re-run${g.repeats > 1 ? 's' : ''} counted once` : ''}</div>` : ''}
      <div class="report-main"><strong>${g.goals}/${g.n}</strong> source-scorer goals <span>${pct(g.goals, g.n)}${ciText(g.ci)}</span></div>
      <div class="report-main"><strong>${g.reach}/${g.n}</strong> post-hoc Flow reach <span>${pct(g.reach, g.n)}${ciText(g.reachCi)}</span></div>
      <div class="report-cats">${Object.entries(g.cats).map(([c, k]) => `<span class="cat cat-${escape(c)}">${escape(CATEGORY_LABEL[c] ?? c)} ${k}</span>`).join('')}</div>
      <div class="report-meta">median time to goal ${num(g.timeToGoal, 2, 's')} · to reach ${num(g.reachTime, 2, 's')} · path efficiency ${num(g.efficiency, 2)} · final ${num(g.finalMedian, 2, 'm')} · planner p95 ${num(g.plannerP95, 0, 'ms')}</div>
      <div class="report-meta">${g.contactRuns} run${g.contactRuns === 1 ? '' : 's'} with obstacle contact · ${g.torqueKnown ? `${g.saturatedRuns}/${g.torqueKnown} with leg torque at the limit (source clip or model clamp)` : 'torque not recorded'}</div></div>`).join('')}
    <p class="tiny">Rates are over distinct scenarios that completed scoring; worker/tool errors are listed, not counted as policy failures. 95% Wilson intervals. Source scorer = the run's own criterion; post-hoc reach = Flow arena protocol (0.4 m, 2 m/s, 0.1 s, contact ≤5 N) re-evaluated on the recorded trajectory. CPU lockstep simulation, single robot model; not a hardware success rate.</p>
    <div class="field-row compact"><button id="runs-select-all">Select all in view</button><button id="runs-export">↓ CSV</button><button id="runs-export-json">↓ JSON</button></div></div>`;
}

function csv(rows) {
  const cols = ['id', 'label', 'policy_id', 'map_id', 'criterion', 'actuators', 'latency_ms', 'latency_anchor', 'candidates', 'ode_steps', 'seed', 'start_x', 'start_y', 'start_yaw', 'goal_x', 'goal_y',
    'outcome', 'category', 'elapsed_s', 'final_m', 'closest_m', 'reach_post_hoc', 'reach_time_s', 'path_efficiency', 'max_contact_n', 'max_tilt_rad', 'planner_p95_ms', 'torque_at_limit_joints'];
  const q = v => v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replaceAll('"', '""')}"` : String(v);
  return [cols.join(','), ...rows.map(r => [r.id, r.label, r.policy_id, r.map_id, r.criterion, r.actuators ?? 'source', r.latency?.ms ?? 0, r.latency?.anchor ?? 'measured', r.planner?.candidates, r.planner?.ode_steps, r.seed,
    r.start_xy?.[0], r.start_xy?.[1], r.start_yaw_rad, r.goal_xy?.[0], r.goal_xy?.[1], r.outcome, category(r), r.metrics.elapsed_s, r.metrics.final_goal_distance_m,
    r.derived?.closest_m, r.derived?.reach_post_hoc?.reached, r.derived?.reach_post_hoc?.time_s, r.derived?.path_efficiency, r.metrics.max_contact_n, r.metrics.max_tilt_rad,
    r.metrics.planner_p95_ms, (r.torque_at_limit ?? Object.keys(r.torque?.saturated_substeps ?? {})).length].map(q).join(','))].join('\n');
}

export const runs = { table: [], selected: new Set(), filters: { map: '', policy: '', outcome: '' }, maps: new Map(), canvas: null, colorBy: 'outcome', hover: null };
const POLICY_COLORS = ['#56d9d0', '#c4a0d9', '#efbb70', '#7fb4ff', '#5fd39b', '#f08c85'];

export async function refreshRuns() {
  const data = await request('/api/runs');
  runs.table = data.runs;
  if (!runs.selected.size) {
    // Default comparison: the latest runs on the most recent arena.
    const latest = runs.table.find(r => r.replayable && r.trajectory);
    if (latest) runs.table.filter(r => r.map_id === latest.map_id && r.trajectory).slice(0, 6).forEach(r => runs.selected.add(r.id));
  }
  render();
  await drawCompare();
}

function filtered() {
  const f = runs.filters;
  return runs.table.filter(r => (!f.map || r.map_id === f.map) && (!f.policy || r.policy_id === f.policy) && (!f.outcome || (r.outcome ?? r.status) === f.outcome));
}

function policyColor(id) {
  const ids = [...new Set(runs.table.map(r => r.policy_id))].sort();
  return POLICY_COLORS[Math.max(0, ids.indexOf(id)) % POLICY_COLORS.length];
}
export const runColor = r => runs.colorBy === 'policy' ? policyColor(r.policy_id) : outcomeColor(r.outcome);

export function render() {
  const root = $('runs-panel'); if (!root) return;
  const rows = filtered();
  const maps = [...new Set(runs.table.map(r => r.map_id).filter(Boolean))];
  const policies = [...new Set(runs.table.map(r => r.policy_id))];
  const outcomes = [...new Set(runs.table.map(r => r.outcome ?? r.status))];
  const stats = policies.map(id => {
    const all = rows.filter(r => r.policy_id === id), rs = all.filter(r => r.outcome);
    const conditions = new Set(rs.map(r => `${r.criterion}|${r.latency?.ms ?? 0}|${r.latency?.anchor}|${r.actuators ?? 'source'}|${r.planner?.candidates}/${r.planner?.ode_steps}`));
    return { id, n: rs.length, unscored: all.length - rs.length, goals: rs.filter(r => r.outcome === 'goal_completion').length, mixed: conditions.size > 1,
      contact: rs.filter(r => (r.metrics.max_contact_n ?? 0) > 0).length, contactUnknown: rs.filter(r => !finite(r.metrics.max_contact_n)).length };
  }).filter(s => s.n || s.unscored);
  root.innerHTML = `<div class="panel-section"><label class="field">Arena<select id="runs-map"><option value="">All</option>${maps.map(m => `<option value="${escape(m)}" ${runs.filters.map === m ? 'selected' : ''}>${escape(mapOptionLabel(m, maps))}</option>`).join('')}</select></label>
      <div class="grid-fields"><label>Policy<select id="runs-policy"><option value="">All</option>${policies.map(p => `<option value="${escape(p)}" ${runs.filters.policy === p ? 'selected' : ''}>${escape(p)}</option>`).join('')}</select></label>
      <label>Outcome<select id="runs-outcome"><option value="">All</option>${outcomes.map(o => `<option value="${escape(o)}" ${runs.filters.outcome === o ? 'selected' : ''}>${escape(String(o).replaceAll('_', ' '))}</option>`).join('')}</select></label></div>
      <div class="field-row compact"><label class="check"><input type="radio" name="runs-color" value="outcome" ${runs.colorBy === 'outcome' ? 'checked' : ''}> Color by outcome</label><label class="check"><input type="radio" name="runs-color" value="policy" ${runs.colorBy === 'policy' ? 'checked' : ''}> by policy</label><button id="runs-refresh">Refresh</button></div></div>
    ${stats.length ? `<div class="panel-section"><h4>Outcomes in view</h4>${stats.map(s => `<div class="stat-row"><i style="background:${policyColor(s.id)}"></i><span>${escape(s.id)}</span><strong>${s.goals}/${s.n} goals</strong><small>${s.contact} with contact${s.contactUnknown ? ` · ${s.contactUnknown} contact unknown` : ''}${s.unscored ? ` · ${s.unscored} not scored (killed/cancelled/running)` : ''}${s.mixed ? ' · conditions mixed: see the report below' : ''}</small></div>`).join('')}<p class="tiny">Pooled over every condition in view. Per-condition rates with confidence intervals are in the robustness report below.</p></div>` : ''}
    ${reportHtml(rows)}
    <div class="panel-section runs-list">${rows.length ? rows.map(r => `<div class="run-row ${runs.selected.has(r.id) ? 'selected' : ''}">
        <label class="run-check" title="Compare"><input type="checkbox" data-run-select="${escape(r.id)}" ${runs.selected.has(r.id) ? 'checked' : ''} ${r.trajectory ? '' : 'disabled'}><i style="background:${runColor(r)}"></i></label>
        <div class="run-main"><div class="run-title">${outcomeChip(r.outcome, r.status)}<span title="${escape(r.label)}">${escape(shortLabel(r))}</span></div>
          <div class="run-meta">${escape(r.policy_id)} · K${r.planner?.candidates ?? '—'}/ODE${r.planner?.ode_steps ?? '—'} · s${r.seed ?? '—'} · ${escape(r.criterion === 'arena_reach' ? 'reach' : 'arrive & hold')}${r.latency?.ms ? ` · lat ${r.latency.ms} ms${r.latency.anchor === 'predict' ? ' predict' : ''}` : ''} · <span class="actuator-token" title="Actuator limits (hip pitch/roll/yaw)">${escape(ACTUATOR_SHORT[r.actuators ?? 'source'] ?? r.actuators)}</span> · ${escape(ago(r.started_unix_s))}</div>
          <div class="run-meta">${num(r.metrics.elapsed_s, 2, 's')} · final ${num(r.metrics.final_goal_distance_m, 2, 'm')} · contact ${num(r.metrics.max_contact_n, 0, 'N')} · plan p95 ${num(r.metrics.planner_p95_ms, 0, 'ms')}</div></div>
        ${r.replayable ? `<button class="link-button" data-open-session="${escape(r.id)}">Replay</button>` : ''}</div>`).join('') : '<p class="tiny">No runs match these filters.</p>'}</div>`;
  $('runs-map').addEventListener('change', e => { runs.filters.map = e.target.value; render(); });
  $('runs-policy').addEventListener('change', e => { runs.filters.policy = e.target.value; render(); });
  $('runs-outcome').addEventListener('change', e => { runs.filters.outcome = e.target.value; render(); });
  root.querySelectorAll('input[name=runs-color]').forEach(r => r.addEventListener('change', () => { runs.colorBy = r.value; render(); drawCompare(); }));
  $('runs-refresh').addEventListener('click', () => refreshRuns().catch(e => emit('workbench:error', e.message)));
  $('runs-select-all')?.addEventListener('click', () => { runs.selected = new Set(rows.filter(r => r.trajectory).slice(0, 64).map(r => r.id)); render(); drawCompare(); });
  $('runs-export')?.addEventListener('click', () => download(`studio-runs-${Date.now()}.csv`, csv(rows), 'text/csv'));
  $('runs-export-json')?.addEventListener('click', () => download(`studio-runs-${Date.now()}.json`, { report: report(rows), runs: rows.map(({ trajectory, ...r }) => r) }));
  root.querySelectorAll('[data-run-select]').forEach(c => c.addEventListener('change', () => {
    if (c.checked) { if (runs.selected.size >= 64) { c.checked = false; return; } runs.selected.add(c.dataset.runSelect); } else runs.selected.delete(c.dataset.runSelect);
    render(); drawCompare();
  }));
  root.querySelectorAll('[data-open-session]').forEach(b => b.addEventListener('click', () => emit('open-session', b.dataset.openSession)));
}

function mapLabel(id) { return runs.catalogMaps?.find(m => m.id === id)?.label ?? id; }
const ACTUATOR_SHORT = { 'g1-current': 'G1 139/139/88', 'g1-rev1': 'rev1 88/139/88', source: 'src 88/88/88' };
// Arena filter labels: disambiguate identical names with the arena id suffix.
function mapOptionLabel(id, ids) {
  const label = mapLabel(id);
  return ids.filter(x => mapLabel(x) === label).length > 1 ? `${label} · ${String(id).slice(-6)}` : label;
}
function shortLabel(r) {
  if (r.preset_label) return `${mapLabel(r.map_id)} · ${r.preset_label}`;
  return r.label ?? r.id;  // older runs: full label (shown with an ellipsis and a tooltip)
}

async function mapFor(id) {
  if (!id) return null;
  if (!runs.maps.has(id)) runs.maps.set(id, request(`/api/map?id=${encodeURIComponent(id)}`).catch(() => null));
  return runs.maps.get(id);
}

export function selectedRuns() { return runs.table.filter(r => runs.selected.has(r.id) && r.trajectory); }

export async function drawCompare() {
  const c = runs.canvas; if (!c || !c.clientWidth) return;
  const chosen = selectedRuns();
  const mapIds = [...new Set(chosen.map(r => r.map_id))];
  const map = await mapFor(mapIds[0]);
  const W = c.clientWidth, H = c.clientHeight, ratio = Math.min(2, devicePixelRatio || 1);
  c.width = Math.round(W * ratio); c.height = Math.round(H * ratio);
  const ctx = c.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#0d151d'; ctx.fillRect(0, 0, W, H);
  const xs = [], ys = [];
  for (const r of chosen) for (const p of r.trajectory) { xs.push(p[1]); ys.push(p[2]); }
  for (const r of chosen) for (const p of [r.start_xy, r.goal_xy]) if (p) { xs.push(p[0]); ys.push(p[1]); }
  for (const b of map?.boxes ?? []) { const rr = Math.hypot(...b.half_xy); xs.push(b.center_xy[0] - rr, b.center_xy[0] + rr); ys.push(b.center_xy[1] - rr, b.center_xy[1] + rr); }
  if (!xs.length) {
    ctx.fillStyle = '#8e9aa9'; ctx.font = '14px Inter, system-ui'; ctx.textAlign = 'center';
    ctx.fillText('Select runs on the left to compare their trajectories.', W / 2, H / 2); return;
  }
  const lo = [Math.min(...xs) - 0.6, Math.min(...ys) - 0.6], hi = [Math.max(...xs) + 0.6, Math.max(...ys) + 0.6];
  const scale = Math.min((W - 40) / (hi[0] - lo[0]), (H - 70) / (hi[1] - lo[1]));
  const ox = (W - (hi[0] - lo[0]) * scale) / 2, oy = (H - (hi[1] - lo[1]) * scale) / 2 + 10;
  const px = ([x, y]) => [ox + (x - lo[0]) * scale, H - oy - (y - lo[1]) * scale];
  ctx.strokeStyle = '#1b2a36'; ctx.lineWidth = 1; ctx.beginPath();
  for (let x = Math.ceil(lo[0]); x <= hi[0]; x++) { const [a] = px([x, 0]); ctx.moveTo(a, 0); ctx.lineTo(a, H); }
  for (let y = Math.ceil(lo[1]); y <= hi[1]; y++) { const [, b] = px([0, y]); ctx.moveTo(0, b); ctx.lineTo(W, b); }
  ctx.stroke();
  for (const b of map?.boxes ?? []) {
    const c0 = Math.cos(b.yaw ?? 0), s0 = Math.sin(b.yaw ?? 0), [hx, hy] = b.half_xy;
    const pts = [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]].map(([x, y]) => px([b.center_xy[0] + c0 * x - s0 * y, b.center_xy[1] + s0 * x + c0 * y]));
    ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.fillStyle = b.z_bottom > 0.05 ? '#8a6fa840' : '#7d7592b0'; ctx.fill(); ctx.strokeStyle = '#b6aecb'; ctx.stroke();
  }
  for (const r of chosen) {
    const color = runColor(r);
    if (r.goal_xy) { const [gx, gy] = px(r.goal_xy); ctx.strokeStyle = color + '99'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(gx, gy, 0.3 * scale, 0, 7); ctx.stroke(); }
    ctx.strokeStyle = color; ctx.lineWidth = runs.hover === r.id ? 3.5 : 2; ctx.beginPath();
    r.trajectory.forEach((p, i) => { const [x, y] = px([p[1], p[2]]); if (i) ctx.lineTo(x, y); else ctx.moveTo(x, y); });
    ctx.stroke();
    const end = r.trajectory.at(-1), [ex, ey] = px([end[1], end[2]]);
    ctx.fillStyle = color; ctx.beginPath(); ctx.arc(ex, ey, 4, 0, 7); ctx.fill();
    if (r.start_xy) { const [sx, sy] = px(r.start_xy); ctx.fillStyle = '#75c9f1'; ctx.beginPath(); ctx.arc(sx, sy, 4, 0, 7); ctx.fill(); }
  }
  ctx.fillStyle = '#c3cdd7'; ctx.font = '12px Inter, system-ui'; ctx.textAlign = 'left';
  ctx.fillText(`${chosen.length} run${chosen.length === 1 ? '' : 's'} · ${map?.label ?? 'map unavailable'}${mapIds.length > 1 ? ' · WARNING: runs from different arenas; drawing the first arena only' : ''}`, 14, 22);
  ctx.fillStyle = '#8e9aa9'; ctx.font = '11px Inter, system-ui';
  ctx.fillText('Simulator-ground-truth root XY (decimated). Dot = final pose · ring = goal radius.', 14, 40);
  const meters = scale > 120 ? 0.5 : scale > 40 ? 1 : 2;
  ctx.fillStyle = '#c3cdd7'; ctx.fillRect(14, H - 18, meters * scale, 3); ctx.fillText(`${meters} m`, 14, H - 24);
  emit('runs:compare', chosen);
}

export function initRuns(canvas, catalogMaps) {
  runs.canvas = canvas; runs.catalogMaps = catalogMaps;
  new ResizeObserver(() => drawCompare()).observe(canvas);
}
