// Multi-lane session timeline sharing one cursor (review §4.6).
// Static lane content is drawn once per session/resize; the cursor is cheap.
import { $, finite, escape, clock, hasPose } from './util.js';

const LANES = [
  { id: 'events', label: 'Events', unit: '' },
  { id: 'goal', label: 'Goal distance', unit: 'm', color: '#efbb70', value: (f, m) => goalDistance(f, m),
    threshold: m => m.navigation_criteria?.goal_radius_m ?? m.navigation?.goal_radius_m ?? m.node_rules?.goal_radius_m, thresholdLabel: 'goal radius' },
  { id: 'planner', label: 'Planner compute', unit: 'ms', color: '#c4a0d9', value: f => f.health?.planner_latency_ms,
    threshold: () => 160, thresholdLabel: 'deploy replan 160 ms', step: true },
  { id: 'sonic', label: 'SONIC inference', unit: 'ms', color: '#56d9d0', value: f => f.health?.sonic_inference_ms,
    threshold: () => 20, thresholdLabel: '20 ms control tick' },
  { id: 'tracking', label: 'Tracking RMSE', unit: 'rad', color: '#e6dfcf', value: f => f.health?.tracking_rmse_rad },
  { id: 'contact', label: 'Obstacle contact', unit: 'N', color: '#f08c85', value: f => f.health?.contact_force_n,
    threshold: m => m.navigation_criteria?.obstacle_contact_threshold_n, thresholdLabel: 'collision' },
];

function goalDistance(f, m) {
  // Navigation sessions carry the goal of each walk in the frame; between walks there is none.
  const g = f?.navigation ? f.navigation.goal_xy : m.goal_xy;
  return g && Array.isArray(f?.position) ? Math.hypot(f.position[0] - g[0], f.position[1] - g[1]) : null;
}

const tl = { session: null, canvas: null, base: null, lanes: [], t0: 0, t1: 1, onSeek: null, cursor: 0, dragging: false };

export function initTimeline({ onSeek }) {
  tl.onSeek = onSeek;
  tl.canvas = $('lanes-canvas');
  tl.base = document.createElement('canvas');
  new ResizeObserver(() => { drawBase(); drawCursor(); }).observe(tl.canvas);
  const seekAt = event => {
    const rect = tl.canvas.getBoundingClientRect();
    const x = Math.min(Math.max(event.clientX - rect.left - labelWidth(), 0), rect.width - labelWidth() - 8);
    const t = tl.t0 + x / Math.max(1, rect.width - labelWidth() - 8) * (tl.t1 - tl.t0);
    tl.onSeek?.(t);
  };
  tl.canvas.addEventListener('pointerdown', e => { tl.dragging = true; tl.canvas.setPointerCapture(e.pointerId); seekAt(e); });
  tl.canvas.addEventListener('pointermove', e => { if (tl.dragging) seekAt(e); else hover(e); });
  tl.canvas.addEventListener('pointerup', () => { tl.dragging = false; });
  tl.canvas.addEventListener('pointerleave', () => { $('lanes-tip').hidden = true; });
  $('lanes-toggle')?.addEventListener('click', () => {
    const collapsed = document.body.classList.toggle('lanes-collapsed');
    $('lanes-toggle').setAttribute('aria-expanded', String(!collapsed));
    $('lanes-toggle').textContent = collapsed ? 'Show lanes' : 'Hide lanes';
  });
}

const labelWidth = () => (tl.canvas?.clientWidth ?? 800) < 520 ? 92 : 132;

export function setTimelineSession(session) {
  tl.session = session;
  const frames = session?.frames ?? [];
  tl.t0 = frames[0]?.time ?? 0;
  tl.t1 = Math.max(tl.t0 + 0.02, session?.metadata?.duration_s ?? frames.at(-1)?.time ?? 1);
  computeLanes();
  drawBase(); drawCursor();
}

function computeLanes() {
  const s = tl.session;
  tl.lanes = [];
  if (!s) return;
  const m = s.metadata ?? {}, frames = s.frames ?? [];
  const step = Math.max(1, Math.ceil(frames.length / 1200));
  for (const lane of LANES) {
    if (lane.id === 'events') {
      const events = (s.events ?? []).filter(e => finite(e.time));
      tl.lanes.push({ ...lane, events, available: events.length > 0 });
      continue;
    }
    const points = [];
    for (let i = 0; i < frames.length; i += step) {
      const v = lane.value(frames[i], m);
      if (finite(v)) points.push([frames[i].time, v]);
    }
    const threshold = lane.threshold?.(m);
    const values = points.map(p => p[1]);
    const max = Math.max(...values, finite(threshold) && threshold < Math.max(...values, 0) * 4 ? threshold : 0, 1e-6);
    tl.lanes.push({ ...lane, points, available: points.length > 0, max, threshold: finite(threshold) ? threshold : null,
      peak: values.length ? Math.max(...values) : null });
  }
}

function laneGeometry() {
  const height = tl.canvas.clientHeight, n = tl.lanes.length || 1;
  const laneH = Math.max(14, (height - 4) / n);
  return { width: tl.canvas.clientWidth, height, laneH, left: labelWidth(), right: 8 };
}
const xOf = (t, g) => g.left + (t - tl.t0) / (tl.t1 - tl.t0) * (g.width - g.left - g.right);

function drawBase() {
  const c = tl.canvas;
  if (!c || !c.clientWidth) return;
  const ratio = Math.min(2, devicePixelRatio || 1);
  const g = laneGeometry();
  for (const canvas of [c, tl.base]) { canvas.width = Math.round(g.width * ratio); canvas.height = Math.round(g.height * ratio); }
  const ctx = tl.base.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.clearRect(0, 0, g.width, g.height);
  ctx.font = '11px Inter, system-ui, sans-serif'; ctx.textBaseline = 'middle';
  tl.lanes.forEach((lane, i) => {
    const y0 = 2 + i * g.laneH, y1 = y0 + g.laneH - 3, mid = (y0 + y1) / 2;
    ctx.fillStyle = i % 2 ? '#111a23' : '#0f1720'; ctx.fillRect(0, y0, g.width, g.laneH - 1);
    ctx.fillStyle = lane.available ? '#aab6c3' : '#6f7c8b';
    ctx.fillText(lane.label, 8, mid);
    if (lane.id === 'events') {
      for (const e of lane.events) {
        const x = xOf(e.time, g);
        ctx.fillStyle = /error|fail|collision|estop/i.test(`${e.type} ${e.message}`) ? '#f08c85' : /result|goal/i.test(e.type ?? '') ? '#5fd39b' : '#efbb70';
        ctx.fillRect(x - 1, y0 + 3, 2, g.laneH - 8);
      }
      if (!lane.available) { ctx.fillStyle = '#6f7c8b'; ctx.fillText('No events recorded', g.left + 6, mid); }
      return;
    }
    if (!lane.available) { ctx.fillStyle = '#5f6b79'; ctx.fillText('Unavailable in this recording', g.left + 6, mid); return; }
    const yOf = v => y1 - Math.min(1, v / lane.max) * (y1 - y0 - 3);
    if (lane.threshold !== null && lane.threshold <= lane.max * 1.001) {
      const ty = yOf(lane.threshold);
      ctx.strokeStyle = '#ffffff30'; ctx.setLineDash([3, 3]); ctx.beginPath(); ctx.moveTo(g.left, ty); ctx.lineTo(g.width - g.right, ty); ctx.stroke(); ctx.setLineDash([]);
    }
    ctx.strokeStyle = lane.color; ctx.lineWidth = 1.3; ctx.beginPath();
    lane.points.forEach(([t, v], k) => {
      const x = xOf(t, g), y = yOf(v);
      if (k === 0) ctx.moveTo(x, y);
      else if (lane.step) { ctx.lineTo(x, yOf(lane.points[k - 1][1])); ctx.lineTo(x, y); }
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
    const peak = `peak ${lane.peak.toFixed(lane.unit === 'rad' ? 3 : lane.unit === 'm' ? 2 : 1)} ${lane.unit}`;
    ctx.font = '10.5px Inter, system-ui, sans-serif'; ctx.textAlign = 'right';
    const w = ctx.measureText(peak).width + 8;
    ctx.fillStyle = '#0b0f15c0'; ctx.fillRect(g.width - g.right - w, y0 + 1, w, 13);
    ctx.fillStyle = '#93a0ae'; ctx.fillText(peak, g.width - g.right - 4, y0 + 8);
    ctx.textAlign = 'left'; ctx.font = '11px Inter, system-ui, sans-serif';
  });
}

export function setTimelineCursor(time) {
  tl.cursor = time;
  drawCursor();
}

function drawCursor() {
  const c = tl.canvas;
  if (!c || !c.width) return;
  const ratio = c.width / Math.max(1, c.clientWidth);
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.drawImage(tl.base, 0, 0);
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  const g = laneGeometry(), x = xOf(tl.cursor, g);
  ctx.fillStyle = '#efbb7022'; ctx.fillRect(g.left, 0, Math.max(0, x - g.left), g.height);
  ctx.strokeStyle = '#efbb70'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, g.height); ctx.stroke();
}

function hover(event) {
  const tip = $('lanes-tip'); if (!tl.session || !tip) return;
  const rect = tl.canvas.getBoundingClientRect(), g = laneGeometry();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const lane = tl.lanes[Math.floor((y - 2) / g.laneH)];
  if (!lane || x < g.left) { tip.hidden = true; return; }
  const t = tl.t0 + (x - g.left) / Math.max(1, g.width - g.left - g.right) * (tl.t1 - tl.t0);
  let text;
  if (lane.id === 'events') {
    const near = lane.events.filter(e => Math.abs(xOf(e.time, g) - x) < 4).slice(0, 3);
    text = near.length ? near.map(e => `${clock(e.time)} · ${e.message}`).join('\n') : `${clock(t)} · no event`;
  } else if (lane.available) {
    let best = lane.points[0];
    for (const p of lane.points) if (Math.abs(p[0] - t) < Math.abs(best[0] - t)) best = p;
    text = `${lane.label} ${best[1].toFixed(3)} ${lane.unit} at ${clock(best[0])}${lane.threshold !== null ? ` · ${lane.thresholdLabel} ${lane.threshold} ${lane.unit}` : ''}`;
  } else text = `${lane.label} was not captured in this recording`;
  tip.textContent = text; tip.hidden = false;
  tip.style.left = `${Math.min(rect.width - 260, Math.max(0, x + 10))}px`; tip.style.top = `${Math.max(0, y - 30)}px`;
}

export function refreshTimelineLive() {
  // Live sessions grow; recompute at a bounded rate from the caller.
  if (!tl.session) return;
  const frames = tl.session.frames ?? [];
  tl.t1 = Math.max(tl.t0 + 0.02, tl.session.metadata?.duration_s ?? frames.at(-1)?.time ?? 1);
  computeLanes(); drawBase(); drawCursor();
}

export function laneSummary() {
  return tl.lanes.map(l => ({ id: l.id, available: l.available, peak: l.peak ?? null, threshold: l.threshold ?? null }));
}
export const laneLabelsHtml = () => tl.lanes.map(l => `<span>${escape(l.label)}</span>`).join('');
