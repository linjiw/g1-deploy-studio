// Runs browser and comparison overlay. Every row is an owned CPU rehearsal;
// outcomes come from the unmodified source scorer and are not hardware results.
import { $, escape, num, request, outcomeChip, outcomeColor, ago, emit, finite } from './util.js';

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
    const rs = rows.filter(r => r.policy_id === id && r.outcome);
    return { id, n: rs.length, goals: rs.filter(r => r.outcome === 'goal_completion').length, contact: rs.filter(r => (r.metrics.max_contact_n ?? 0) > 0).length };
  }).filter(s => s.n);
  root.innerHTML = `<div class="panel-section"><div class="grid-fields three">
      <label>Arena<select id="runs-map"><option value="">All</option>${maps.map(m => `<option value="${escape(m)}" ${runs.filters.map === m ? 'selected' : ''}>${escape(mapLabel(m))}</option>`).join('')}</select></label>
      <label>Policy<select id="runs-policy"><option value="">All</option>${policies.map(p => `<option value="${escape(p)}" ${runs.filters.policy === p ? 'selected' : ''}>${escape(p)}</option>`).join('')}</select></label>
      <label>Outcome<select id="runs-outcome"><option value="">All</option>${outcomes.map(o => `<option value="${escape(o)}" ${runs.filters.outcome === o ? 'selected' : ''}>${escape(String(o).replaceAll('_', ' '))}</option>`).join('')}</select></label></div>
      <div class="field-row compact"><label class="check"><input type="radio" name="runs-color" value="outcome" ${runs.colorBy === 'outcome' ? 'checked' : ''}> Color by outcome</label><label class="check"><input type="radio" name="runs-color" value="policy" ${runs.colorBy === 'policy' ? 'checked' : ''}> by policy</label><button id="runs-refresh">Refresh</button></div></div>
    ${stats.length ? `<div class="panel-section"><h4>Outcomes in view</h4>${stats.map(s => `<div class="stat-row"><i style="background:${policyColor(s.id)}"></i><span>${escape(s.id)}</span><strong>${s.goals}/${s.n} goals</strong><small>${s.contact} with contact</small></div>`).join('')}<p class="tiny">Individual CPU lockstep checks, mostly one seed each: not a success-rate estimate.</p></div>` : ''}
    <div class="panel-section runs-list">${rows.length ? rows.map(r => `<div class="run-row ${runs.selected.has(r.id) ? 'selected' : ''}">
        <label class="run-check" title="Compare"><input type="checkbox" data-run-select="${escape(r.id)}" ${runs.selected.has(r.id) ? 'checked' : ''} ${r.trajectory ? '' : 'disabled'}><i style="background:${runColor(r)}"></i></label>
        <div class="run-main"><div class="run-title">${outcomeChip(r.outcome, r.status)}<span title="${escape(r.label)}">${escape(shortLabel(r))}</span></div>
          <div class="run-meta">${escape(r.policy_id)} · K${r.planner?.candidates ?? '—'}/ODE${r.planner?.ode_steps ?? '—'} · s${r.seed ?? '—'} · ${escape(ago(r.started_unix_s))}</div>
          <div class="run-meta">${num(r.metrics.elapsed_s, 2, 's')} · final ${num(r.metrics.final_goal_distance_m, 2, 'm')} · contact ${num(r.metrics.max_contact_n, 0, 'N')} · plan p95 ${num(r.metrics.planner_p95_ms, 0, 'ms')}</div></div>
        ${r.replayable ? `<button class="link-button" data-open-session="${escape(r.id)}">Replay</button>` : ''}</div>`).join('') : '<p class="tiny">No runs match these filters.</p>'}</div>`;
  $('runs-map').addEventListener('change', e => { runs.filters.map = e.target.value; render(); });
  $('runs-policy').addEventListener('change', e => { runs.filters.policy = e.target.value; render(); });
  $('runs-outcome').addEventListener('change', e => { runs.filters.outcome = e.target.value; render(); });
  document.querySelectorAll('input[name=runs-color]').forEach(r => r.addEventListener('change', () => { runs.colorBy = r.value; render(); drawCompare(); }));
  $('runs-refresh').addEventListener('click', () => refreshRuns().catch(e => emit('workbench:error', e.message)));
  document.querySelectorAll('[data-run-select]').forEach(c => c.addEventListener('change', () => {
    if (c.checked) { if (runs.selected.size >= 12) { c.checked = false; return; } runs.selected.add(c.dataset.runSelect); } else runs.selected.delete(c.dataset.runSelect);
    render(); drawCompare();
  }));
  document.querySelectorAll('[data-open-session]').forEach(b => b.addEventListener('click', () => emit('open-session', b.dataset.openSession)));
}

function mapLabel(id) { return runs.catalogMaps?.find(m => m.id === id)?.label ?? id; }
function shortLabel(r) {
  const parts = (r.label ?? r.id).split(' · ');
  return parts.length > 2 ? parts.slice(0, 2).join(' · ') : r.label ?? r.id;
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
