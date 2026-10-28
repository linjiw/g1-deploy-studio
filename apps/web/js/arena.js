// Top-down navigation arena editor: static collision boxes + start/goal presets.
// Geometry is explicit simulation input; preflight here mirrors the server check
// and never claims that a route is feasible.
import { $, escape, num, finite, request, pointStatus, download, emit, outcomeColor } from './util.js';

const WALL_T = 0.24, WALL_H = 1.2, BEAM = [1.05, 1.25], PILLAR = 0.3;
const GOAL_R = 0.3, FOOT_R = 0.25;

export const arena = {
  label: 'Custom arena', description: '', base_map_id: null, boxes: [], presets: [], active: 0,
  selection: null, tool: 'select', snap: true, view: { cx: 2, cy: 0, scale: 90 }, canvas: null,
  drag: null, hover: null, savedId: null, dirty: false, runs: [], catalog: null,
};

const clone = v => structuredClone(v);
const mm = v => Math.round(v * 1000) / 1000;
const snap = v => mm(arena.snap ? Math.round(v / 0.05) * 0.05 : v);
const deg = r => r * 180 / Math.PI, rad = d => d * Math.PI / 180;
const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const preset = () => arena.presets[arena.active];

// ---------------------------------------------------------------- templates
function wall(x0, y0, x1, y1, t = WALL_T, z = [0, WALL_H]) {
  const len = Math.hypot(x1 - x0, y1 - y0);
  return { center_xy: [(x0 + x1) / 2, (y0 + y1) / 2], half_xy: [Math.max(0.02, len / 2), t / 2], yaw: Math.atan2(y1 - y0, x1 - x0), z_bottom: z[0], z_top: z[1] };
}
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32); }
export const TEMPLATES = {
  empty: { label: 'Empty floor', make: () => ({ boxes: [], presets: [p('Straight 3 m', [0, 0], 0, [3, 0])] }) },
  corridor: { label: 'Corridor 1.2 m', make: () => ({ boxes: [wall(0.8, 0.6, 4.2, 0.6), wall(0.8, -0.6, 4.2, -0.6)], presets: [p('Through corridor', [0, 0], 0, [4.8, 0]), p('Corridor exit left', [0, 0], 0, [4.8, 1.0])] }) },
  doorway: { label: 'Doorway 0.8 m', make: () => ({ boxes: [wall(2, 0.4, 2, 2.2), wall(2, -0.4, 2, -2.2)], presets: [p('Through door', [0, 0], 0, [3.6, 0]), p('Offset approach', [0, -1.2], 0.4, [3.6, 0.6])] }) },
  slalom: { label: 'Slalom', make: () => ({ boxes: [wall(1.3, 0.05, 1.3, 1.6), wall(2.5, -0.05, 2.5, -1.6), wall(3.7, 0.05, 3.7, 1.6)], presets: [p('Slalom end', [0, 0], 0, [4.8, 0]), p('Slalom left', [0, 0], 0, [4.8, 0.8])] }) },
  beam: { label: 'Overhead beam', make: () => ({ boxes: [wall(0.8, 0.65, 4.2, 0.65), wall(0.8, -0.65, 4.2, -0.65), { center_xy: [2.4, 0], half_xy: [0.12, 0.65], yaw: 0, z_bottom: BEAM[0], z_top: BEAM[1] }], presets: [p('Under the beam', [0, 0], 0, [4.8, 0])] }) },
  utrap: { label: 'U-trap', make: () => ({ boxes: [wall(2.2, -1.0, 2.2, 1.0), wall(0.9, 1.0, 2.2, 1.0), wall(0.9, -1.0, 2.2, -1.0)], presets: [p('Goal behind U', [0, 0], 0, [3.4, 0]), p('Escape sideways', [0.4, 0], 0, [1.2, 2.0])] }) },
  clutter: { label: 'Clutter (seeded)', make: (seed = 7) => {
    const r = rng(seed), boxes = [];
    for (let k = 0; boxes.length < 9 && k < 400; k++) {
      const c = [1 + r() * 3.2, -1.5 + r() * 3];
      if (Math.hypot(c[0], c[1]) < 0.9 || Math.hypot(c[0] - 4.8, c[1]) < 0.9) continue;
      if (boxes.some(b => Math.hypot(b.center_xy[0] - c[0], b.center_xy[1] - c[1]) < 0.85)) continue;
      boxes.push({ center_xy: [snap(c[0]), snap(c[1])], half_xy: [PILLAR / 2 + r() * 0.1, PILLAR / 2 + r() * 0.1], yaw: snap(r() * Math.PI) - Math.PI / 2, z_bottom: 0, z_top: WALL_H });
    }
    return { boxes, presets: [p('Through clutter', [0, 0], 0, [4.8, 0]), p('Diagonal', [0, -1.2], 0.3, [4.8, 1.0])] };
  } },
};
function p(label, start, yaw, goal) { return { label, start_xy: start, start_yaw_rad: yaw, goal_xy: goal }; }

// Seeded random start/goal presets for robustness checks. Every sample must pass
// the same standing-footprint preflight as a hand-placed preset; the seed and
// parameters are recorded in the labels and the arena description.
// Does the straight start->goal segment cross a box footprint grown by `pad` (separating axis)?
function segmentBlocked(a, b, boxes, pad = 0.15) {
  return boxes.some(box => {
    if (box.z_bottom > 1.3) return false;  // overhead-only obstacles do not block a straight walk
    const la = toLocal(box, a), lb = toLocal(box, b), h = [box.half_xy[0] + pad, box.half_xy[1] + pad];
    let t0 = 0, t1 = 1;
    for (let k = 0; k < 2; k++) {
      const d = lb[k] - la[k];
      if (Math.abs(d) < 1e-9) { if (Math.abs(la[k]) > h[k]) return false; continue; }
      let ta = (-h[k] - la[k]) / d, tb = (h[k] - la[k]) / d;
      if (ta > tb) [ta, tb] = [tb, ta];
      t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
      if (t0 > t1) return false;
    }
    return true;
  });
}

export function randomPresets({ count = 8, minDist = 1.5, maxDist = 4.5, seed = 1, randomStart = false, heading = 'toward', replace = true, baseStart = null, baseYaw = null, obstructed = false } = {}) {
  const r = rng(seed * 7919 + 17), doc = { boxes: arena.boxes, bounds: arenaBounds(arena.boxes, []) };
  const lo = doc.bounds.min.map(v => v + 0.6), hi = doc.bounds.max.map(v => v - 0.6);
  // The base start/heading come from the caller (see the Generate handler); the note records them.
  const base = p('Base', baseStart ?? arena.presets[arena.active]?.start_xy ?? [0, 0], baseYaw ?? arena.presets[arena.active]?.start_yaw_rad ?? 0, [3, 0]);
  const out = [];
  for (let attempt = 0; out.length < count && attempt < (obstructed ? 20000 : 4000); attempt++) {
    const start = randomStart ? [snap(lo[0] + r() * (hi[0] - lo[0])), snap(lo[1] + r() * (hi[1] - lo[1]))] : base.start_xy.slice();
    const goal = [snap(lo[0] + r() * (hi[0] - lo[0])), snap(lo[1] + r() * (hi[1] - lo[1]))];
    const d = Math.hypot(goal[0] - start[0], goal[1] - start[1]);
    if (d < minDist || d > maxDist) continue;
    if (pointStatus(doc, start).status !== 'configured_free' || pointStatus(doc, goal).status !== 'configured_free') continue;
    if (obstructed && !segmentBlocked(start, goal, arena.boxes)) continue;
    if (out.some(q => Math.hypot(q.goal_xy[0] - goal[0], q.goal_xy[1] - goal[1]) < 0.4 && Math.hypot(q.start_xy[0] - start[0], q.start_xy[1] - start[1]) < 0.4)) continue;
    const toward = Math.atan2(goal[1] - start[1], goal[0] - start[0]);
    const yaw = heading === 'toward' ? toward : heading === 'random' ? (r() * 2 - 1) * Math.PI : base.start_yaw_rad;
    out.push(p(`Random ${out.length + 1} · seed ${seed}`, start, wrap(Math.round(yaw / rad(5)) * rad(5)), goal));
  }
  if (!out.length) return out;  // nothing fits: keep the existing presets untouched
  arena.presets = replace ? out : [...arena.presets, ...out].slice(0, 16);
  arena.active = 0;
  arena.rgBase = { start_xy: base.start_xy.slice(), start_yaw_rad: base.start_yaw_rad, presets: JSON.stringify(arena.presets) };
  const note = `[random: seed ${seed}; ${out.length} goals; ${minDist}-${maxDist} m; start ${randomStart ? 'random' : `fixed (${base.start_xy.join(', ')})`}; heading ${heading}${obstructed ? '; straight line blocked' : ''}]`;
  arena.description = [(arena.description ?? '').replace(/\s*\[random:[^\]]*\]/g, '').trim(), note].filter(Boolean).join(' ').slice(0, 500);
  changed(); draw();
  return out;
}

// ---------------------------------------------------------------- geometry
export function arenaBounds(boxes = arena.boxes, presets = arena.presets) {
  // Same default formula as the server (validate_map), extended to contain presets.
  const xs = [], ys = [];
  for (const b of boxes) { const r = Math.hypot(...b.half_xy); xs.push(b.center_xy[0] - r, b.center_xy[0] + r); ys.push(b.center_xy[1] - r, b.center_xy[1] + r); }
  for (const q of presets) for (const pt of [q.start_xy, q.goal_xy]) { xs.push(pt[0] - 0.5, pt[0] + 0.5); ys.push(pt[1] - 0.5, pt[1] + 0.5); }
  return { min: [Math.min(-2, ...xs) - 1, Math.min(-2, ...ys) - 1], max: [Math.max(4, ...xs) + 1, Math.max(2, ...ys) + 1] };
}
const mapDoc = () => ({ boxes: arena.boxes, bounds: arenaBounds() });
function boxCorners(b) {
  const c = Math.cos(b.yaw), s = Math.sin(b.yaw), [hx, hy] = b.half_xy;
  return [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]].map(([x, y]) => [b.center_xy[0] + c * x - s * y, b.center_xy[1] + s * x + c * y]);
}
function toLocal(b, pt) {
  const dx = pt[0] - b.center_xy[0], dy = pt[1] - b.center_xy[1], c = Math.cos(b.yaw), s = Math.sin(b.yaw);
  return [c * dx + s * dy, -s * dx + c * dy];
}
const inside = (b, pt) => { const l = toLocal(b, pt); return Math.abs(l[0]) <= b.half_xy[0] && Math.abs(l[1]) <= b.half_xy[1]; };
const kindOf = b => b.z_bottom > 0.05 ? 'beam' : (b.half_xy[0] < 0.26 && b.half_xy[1] < 0.26 ? 'pillar' : 'wall');

// ---------------------------------------------------------------- view transform
const W = () => arena.canvas.clientWidth, H = () => arena.canvas.clientHeight;
const toPx = ([x, y]) => [W() / 2 + (x - arena.view.cx) * arena.view.scale, H() / 2 - (y - arena.view.cy) * arena.view.scale];
const toWorld = (px, py) => [arena.view.cx + (px - W() / 2) / arena.view.scale, arena.view.cy - (py - H() / 2) / arena.view.scale];

export function fitArena() {
  if (!arena.canvas) return;
  const b = arenaBounds();
  const w = b.max[0] - b.min[0], h = b.max[1] - b.min[1];
  arena.view.cx = (b.min[0] + b.max[0]) / 2; arena.view.cy = (b.min[1] + b.max[1]) / 2;
  arena.view.scale = Math.max(20, Math.min(220, Math.min((W() - 40) / w, (H() - 40) / h)));
  draw();
}

// ---------------------------------------------------------------- drawing
export function draw() {
  const c = arena.canvas; if (!c || !c.clientWidth) return;
  const ratio = Math.min(2, devicePixelRatio || 1);
  if (c.width !== Math.round(W() * ratio) || c.height !== Math.round(H() * ratio)) { c.width = Math.round(W() * ratio); c.height = Math.round(H() * ratio); }
  const ctx = c.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#0d151d'; ctx.fillRect(0, 0, W(), H());
  // Grid: 0.1 m minor when zoomed in, 0.5 / 1 m majors.
  const [x0, y1] = toWorld(0, 0), [x1, y0] = toWorld(W(), H());
  for (const [stepM, color] of [[0.1, '#141f29'], [0.5, '#1b2a36'], [1, '#26394a']]) {
    if (stepM * arena.view.scale < 7) continue;
    ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.beginPath();
    for (let x = Math.floor(x0 / stepM) * stepM; x <= x1; x += stepM) { const [px] = toPx([x, 0]); ctx.moveTo(px + 0.5, 0); ctx.lineTo(px + 0.5, H()); }
    for (let y = Math.floor(y0 / stepM) * stepM; y <= y1; y += stepM) { const [, py] = toPx([0, y]); ctx.moveTo(0, py + 0.5); ctx.lineTo(W(), py + 0.5); }
    ctx.stroke();
  }
  const [ox, oy] = toPx([0, 0]);
  ctx.lineWidth = 2; ctx.strokeStyle = '#c75a5a'; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox + 0.6 * arena.view.scale, oy); ctx.stroke();
  ctx.strokeStyle = '#5aa86a'; ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(ox, oy - 0.6 * arena.view.scale); ctx.stroke();
  // Bounds.
  const b = arenaBounds(), [bx0, by0] = toPx(b.min), [bx1, by1] = toPx(b.max);
  ctx.setLineDash([6, 5]); ctx.strokeStyle = '#4f7f8c'; ctx.lineWidth = 1; ctx.strokeRect(bx0, by1, bx1 - bx0, by0 - by1); ctx.setLineDash([]);
  // Previous runs on this saved arena.
  for (const run of arena.runs) {
    if (!run.trajectory?.length) continue;
    ctx.strokeStyle = outcomeColor(run.outcome) + 'aa'; ctx.lineWidth = 1.6; ctx.beginPath();
    run.trajectory.forEach((pt, i) => { const [px, py] = toPx([pt[1], pt[2]]); if (i) ctx.lineTo(px, py); else ctx.moveTo(px, py); });
    ctx.stroke();
  }
  // Boxes.
  arena.boxes.forEach((box, i) => {
    const pts = boxCorners(box).map(toPx), kind = kindOf(box), selected = arena.selection?.type === 'box' && arena.selection.index === i;
    ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath();
    ctx.fillStyle = kind === 'beam' ? '#8a6fa83a' : '#7d7592b0'; ctx.fill();
    if (kind === 'beam') { ctx.save(); ctx.clip(); ctx.strokeStyle = '#c9a8e660'; ctx.lineWidth = 1; for (let d = -2000; d < 2000; d += 9) { ctx.beginPath(); ctx.moveTo(d, 0); ctx.lineTo(d + H(), H()); ctx.stroke(); } ctx.restore(); }
    ctx.strokeStyle = selected ? '#56d9d0' : kind === 'beam' ? '#c9a8e6' : '#b6aecb'; ctx.lineWidth = selected ? 2 : 1;
    ctx.beginPath(); pts.forEach(([x, y], k) => k ? ctx.lineTo(x, y) : ctx.moveTo(x, y)); ctx.closePath(); ctx.stroke();
    if (arena.view.scale > 45) {
      const [cx, cy] = toPx(box.center_xy); ctx.fillStyle = '#d7d1e6'; ctx.font = '10px Inter, system-ui'; ctx.textAlign = 'center';
      ctx.fillText(kind === 'beam' ? `beam ${box.z_bottom.toFixed(2)}–${box.z_top.toFixed(2)} m` : `top ${box.z_top.toFixed(2)} m`, cx, cy + 3);
    }
    if (selected) for (const h of handles(box)) { const [hx, hy] = toPx(h.pt); ctx.fillStyle = h.kind === 'rotate' ? '#efbb70' : '#56d9d0'; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fill(); }
  });
  // Presets (inactive faint, active bold).
  arena.presets.forEach((q, i) => drawPreset(ctx, q, i === arena.active));
  // Scale bar.
  const meters = arena.view.scale > 120 ? 0.5 : arena.view.scale > 40 ? 1 : 2;
  ctx.fillStyle = '#c3cdd7'; ctx.fillRect(16, H() - 22, meters * arena.view.scale, 3);
  ctx.font = '11px Inter, system-ui'; ctx.textAlign = 'left'; ctx.fillText(`${meters} m`, 16, H() - 28);
  if (arena.hover) ctx.fillText(`x ${arena.hover[0].toFixed(2)}  y ${arena.hover[1].toFixed(2)} m`, W() - 150, H() - 14);
  emit('arena:drawn');
}

function drawPreset(ctx, q, active) {
  const s = pointStatus(mapDoc(), q.start_xy), g = pointStatus(mapDoc(), q.goal_xy);
  const alpha = active ? 'ff' : '66';
  const [sx, sy] = toPx(q.start_xy), [gx, gy] = toPx(q.goal_xy), r = arena.view.scale;
  ctx.setLineDash([4, 4]); ctx.strokeStyle = '#ffffff' + (active ? '40' : '20'); ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(gx, gy); ctx.stroke(); ctx.setLineDash([]);
  // Standing footprint clearance (server preflight uses 0.25 m around each box).
  ctx.strokeStyle = (s.status === 'configured_free' ? '#5fd39b' : '#f08c85') + alpha; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.arc(sx, sy, FOOT_R * r, 0, 7); ctx.stroke();
  ctx.fillStyle = '#75c9f1' + alpha; ctx.beginPath(); ctx.arc(sx, sy, Math.max(4, 0.09 * r), 0, 7); ctx.fill();
  const hx = sx + Math.cos(q.start_yaw_rad) * 0.55 * r, hy = sy - Math.sin(q.start_yaw_rad) * 0.55 * r;
  ctx.strokeStyle = '#75c9f1' + alpha; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(hx, hy); ctx.stroke();
  if (active) { ctx.fillStyle = '#75c9f1'; ctx.beginPath(); ctx.arc(hx, hy, 5, 0, 7); ctx.fill(); }
  ctx.strokeStyle = (g.status === 'configured_free' ? '#efbb70' : '#f08c85') + alpha; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.arc(gx, gy, GOAL_R * r, 0, 7); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(gx - 6, gy); ctx.lineTo(gx + 6, gy); ctx.moveTo(gx, gy - 6); ctx.lineTo(gx, gy + 6); ctx.stroke();
  if (active || arena.view.scale > 60) {
    ctx.font = active ? '600 11px Inter, system-ui' : '10px Inter, system-ui'; ctx.fillStyle = '#e4e9ee' + alpha; ctx.textAlign = 'left';
    ctx.fillText('START', sx + 10, sy - 10); ctx.fillText(active ? `GOAL · ${q.label}` : q.label, gx + 10, gy - 10);
  }
}

function handles(box) {
  const c = Math.cos(box.yaw), s = Math.sin(box.yaw), [hx, hy] = box.half_xy, [x, y] = box.center_xy;
  const at = (lx, ly) => [x + c * lx - s * ly, y + s * lx + c * ly];
  return [{ kind: 'x', pt: at(hx, 0) }, { kind: 'y', pt: at(0, hy) }, { kind: 'corner', pt: at(hx, hy) }, { kind: 'rotate', pt: at(hx + 0.3, 0) }];
}

// ---------------------------------------------------------------- hit testing / interaction
function hit(px, py) {
  const pt = toWorld(px, py), tol = 9 / arena.view.scale;
  const q = preset();
  if (q) {
    const head = [q.start_xy[0] + Math.cos(q.start_yaw_rad) * 0.55, q.start_xy[1] + Math.sin(q.start_yaw_rad) * 0.55];
    if (Math.hypot(pt[0] - head[0], pt[1] - head[1]) < tol * 1.3) return { type: 'heading' };
    if (Math.hypot(pt[0] - q.start_xy[0], pt[1] - q.start_xy[1]) < Math.max(0.16, tol)) return { type: 'start' };
    if (Math.hypot(pt[0] - q.goal_xy[0], pt[1] - q.goal_xy[1]) < Math.max(GOAL_R, tol)) return { type: 'goal' };
  }
  if (arena.selection?.type === 'box') {
    const box = arena.boxes[arena.selection.index];
    for (const h of handles(box)) if (Math.hypot(pt[0] - h.pt[0], pt[1] - h.pt[1]) < tol * 1.2) return { type: 'handle', handle: h.kind, index: arena.selection.index };
  }
  for (let i = arena.boxes.length - 1; i >= 0; i--) if (inside(arena.boxes[i], pt)) return { type: 'box', index: i };
  return null;
}

function onPointerDown(e) {
  if (!e.isPrimary || arena.drag) return;
  arena.pointerId = e.pointerId;
  arena.canvas.focus({ preventScroll: true });
  const rect = arena.canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top, pt = toWorld(px, py);
  arena.canvas.setPointerCapture(e.pointerId);
  if (e.button === 1 || e.button === 2 || e.shiftKey && arena.tool === 'select' && !hit(px, py)) { arena.drag = { type: 'pan', px, py, cx: arena.view.cx, cy: arena.view.cy }; return; }
  if (['wall', 'beam'].includes(arena.tool)) { arena.drag = { type: 'draw', start: [snap(pt[0]), snap(pt[1])] }; return; }
  if (arena.tool === 'pillar') { addBox({ center_xy: [snap(pt[0]), snap(pt[1])], half_xy: [PILLAR / 2, PILLAR / 2], yaw: 0, z_bottom: 0, z_top: WALL_H }); return; }
  if (arena.tool === 'start' || arena.tool === 'goal') { ensurePreset(); preset()[`${arena.tool}_xy`] = [snap(pt[0]), snap(pt[1])]; arena.drag = { type: arena.tool }; changed(); return; }
  const target = hit(px, py);
  if (!target) { arena.selection = null; arena.drag = { type: 'pan', px, py, cx: arena.view.cx, cy: arena.view.cy }; renderPanel(); draw(); return; }
  if (target.type === 'box') { arena.selection = target; const box = arena.boxes[target.index]; arena.drag = { type: 'move', index: target.index, offset: [pt[0] - box.center_xy[0], pt[1] - box.center_xy[1]], before: clone(box) }; }
  else if (target.type === 'handle') arena.drag = { type: 'handle', ...target };
  else arena.drag = { type: target.type };
  renderPanel(); draw();
}

function onPointerMove(e) {
  if (!e.isPrimary || (arena.drag && e.pointerId !== arena.pointerId)) return;
  const rect = arena.canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top, pt = toWorld(px, py);
  arena.hover = pt;
  const d = arena.drag;
  if (!d) { arena.canvas.style.cursor = hit(px, py) ? 'grab' : arena.tool === 'select' ? 'default' : 'crosshair'; draw(); return; }
  const q = preset();
  if (d.type === 'pan') { arena.view.cx = d.cx - (px - d.px) / arena.view.scale; arena.view.cy = d.cy + (py - d.py) / arena.view.scale; }
  else if (d.type === 'move') { arena.boxes[d.index].center_xy = [snap(pt[0] - d.offset[0]), snap(pt[1] - d.offset[1])]; arena.dirty = true; }
  else if (d.type === 'handle') {
    const box = arena.boxes[d.index], l = toLocal(box, pt);
    if (d.handle === 'x' || d.handle === 'corner') box.half_xy[0] = Math.max(0.03, snap(Math.abs(l[0])));
    if (d.handle === 'y' || d.handle === 'corner') box.half_xy[1] = Math.max(0.03, snap(Math.abs(l[1])));
    if (d.handle === 'rotate') { const a = Math.atan2(pt[1] - box.center_xy[1], pt[0] - box.center_xy[0]); box.yaw = arena.snap ? Math.round(a / rad(5)) * rad(5) : a; box.yaw = wrap(box.yaw); }
    arena.dirty = true;
  }
  else if (d.type === 'start' && q) q.start_xy = [snap(pt[0]), snap(pt[1])];
  else if (d.type === 'goal' && q) q.goal_xy = [snap(pt[0]), snap(pt[1])];
  else if (d.type === 'heading' && q) { const a = Math.atan2(pt[1] - q.start_xy[1], pt[0] - q.start_xy[0]); q.start_yaw_rad = wrap(arena.snap ? Math.round(a / rad(5)) * rad(5) : a); }
  else if (d.type === 'draw') d.end = [snap(pt[0]), snap(pt[1])];
  if (d.type === 'draw' && d.end) { draw(); const ctx = arena.canvas.getContext('2d'); const [ax, ay] = toPx(d.start), [bx, by] = toPx(d.end); ctx.strokeStyle = '#56d9d0'; ctx.lineWidth = Math.max(2, WALL_T * arena.view.scale); ctx.globalAlpha = 0.5; ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); ctx.globalAlpha = 1; return; }
  if (d.type !== 'pan') changed(false);
  draw();
}

function onPointerCancel(e) {
  if (e && e.pointerId !== arena.pointerId) return;
  arena.pointerId = null;
  // A cancelled touch must never complete a half-drawn wall or leave a stuck drag.
  const changedGeometry = arena.drag && !['pan', 'draw'].includes(arena.drag.type);
  arena.drag = null; arena.hover = null;
  if (changedGeometry) changed();
  draw();
}

function onPointerUp(e) {
  if (e && e.pointerId !== arena.pointerId) return;
  arena.pointerId = null;
  const d = arena.drag; arena.drag = null;
  if (d?.type === 'draw' && d.end && Math.hypot(d.end[0] - d.start[0], d.end[1] - d.start[1]) > 0.1) {
    addBox(wall(d.start[0], d.start[1], d.end[0], d.end[1], WALL_T, arena.tool === 'beam' ? BEAM : [0, WALL_H]));
  } else if (d && d.type !== 'pan') changed();
  draw();
}

function onWheel(e) {
  e.preventDefault();
  const rect = arena.canvas.getBoundingClientRect(), px = e.clientX - rect.left, py = e.clientY - rect.top, before = toWorld(px, py);
  arena.view.scale = Math.min(400, Math.max(12, arena.view.scale * Math.exp(-e.deltaY * 0.0015)));
  const after = toWorld(px, py);
  arena.view.cx += before[0] - after[0]; arena.view.cy += before[1] - after[1];
  draw();
}

function onKey(e) {
  if (!arena.active_workspace || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || document.activeElement?.isContentEditable || ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName)) return;
  const sel = arena.selection?.type === 'box' ? arena.boxes[arena.selection.index] : null;
  if ((e.key === 'Delete' || e.key === 'Backspace') && sel) { arena.boxes.splice(arena.selection.index, 1); arena.selection = null; changed(); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'd' && sel) { addBox({ ...clone(sel), center_xy: [sel.center_xy[0] + 0.3, sel.center_xy[1] - 0.3] }); e.preventDefault(); }
  else if (e.key.toLowerCase() === 'r' && sel) { sel.yaw = wrap(sel.yaw + rad(e.shiftKey ? -15 : 15)); changed(); e.preventDefault(); }
  else if (sel && e.key.startsWith('Arrow')) {
    const step = e.shiftKey ? 0.25 : 0.05, d = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    sel.center_xy = [snap(sel.center_xy[0] + d[0]), snap(sel.center_xy[1] + d[1])]; changed(); e.preventDefault();
  }
  else if (e.key === 'Escape') { onPointerCancel(); arena.selection = null; setTool('select'); draw(); renderPanel(); }
}

function addBox(box) {
  if (arena.boxes.length >= 128) { emit('arena:error', 'A simulation map supports at most 128 boxes.'); return; }
  arena.boxes.push(box); arena.selection = { type: 'box', index: arena.boxes.length - 1 }; changed();
}
function ensurePreset() { if (!arena.presets.length) { arena.presets.push(p('Preset 1', [0, 0], 0, [3, 0])); arena.active = 0; } }

function changed(panel = true) {
  if (arena.savedId) arena.runs = [];  // edited geometry no longer matches recorded runs
  arena.dirty = true; arena.savedId = null;
  if (panel) renderPanel(); else updateStatus();
  emit('arena:changed', arena);
}

export function setTool(tool) {
  arena.tool = tool;
  document.querySelectorAll('[data-arena-tool]').forEach(b => { const on = b.dataset.arenaTool === tool; b.classList.toggle('active', on); b.setAttribute('aria-pressed', String(on)); });
  if (arena.canvas) arena.canvas.style.cursor = tool === 'select' ? 'default' : 'crosshair';
}

// ---------------------------------------------------------------- loading / saving
export function loadArena({ label, boxes = [], presets = [], base_map_id = null, description = '', savedId = null, keepView = false }) {
  // Runs recorded on other geometry must never be drawn on this arena.
  if (!savedId || savedId !== arena.savedId) arena.runs = [];
  Object.assign(arena, { label, description, base_map_id, boxes: clone(boxes).map(b => ({ yaw: 0, ...b })), presets: clone(presets), active: 0, selection: null, savedId, dirty: !savedId });
  if (!arena.presets.length) ensurePreset();
  renderPanel(); if (!keepView) fitArena(); else draw();
  emit('arena:changed', arena);
}

export async function loadFromMap(id) {
  const map = await request(`/api/map?id=${encodeURIComponent(id)}`);
  if (map.kind !== 'boxes') throw new Error('Only box collision maps can be edited. Scans are inspection-only.');
  const presets = map.presets?.length ? map.presets : map.suggested_scenario ? [p('Source preset', map.suggested_scenario.start_xy, map.suggested_scenario.start_yaw_rad ?? 0, map.suggested_scenario.goal_xy)] : [];
  loadArena({ label: map.origin === 'arena-editor' ? map.label : `${map.label} · edited`, boxes: map.boxes, presets, base_map_id: id,
    description: map.description ?? '', savedId: map.origin === 'arena-editor' ? id : null });
  if (map.origin !== 'arena-editor') { arena.savedId = null; arena.dirty = true; }
  await loadRuns();
}

export function applyTemplate(key, seed) {
  const t = TEMPLATES[key]; if (!t) return;
  const made = t.make(seed);
  loadArena({ label: `${t.label}${key === 'clutter' ? ` · seed ${seed ?? 7}` : ''}`, boxes: made.boxes, presets: made.presets, base_map_id: null });
  arena.runs = []; draw();
}

export function exportDocument() {
  return { schema_version: 1, label: arena.label, kind: 'boxes', frame_id: 'world', units: 'm', description: arena.description || undefined,
    boxes: arena.boxes.map(b => ({ center_xy: b.center_xy.map(Number), half_xy: b.half_xy.map(Number), yaw: Math.max(-Math.PI, Math.min(Math.PI, Number(wrap(b.yaw).toFixed(6)))), z_bottom: b.z_bottom, z_top: b.z_top })),
    bounds: arenaBounds(), presets: arena.presets, base_map_id: arena.base_map_id ?? undefined };
}

export async function saveArena() {
  const doc = exportDocument();
  const issues = presetIssues();
  if (issues.length) throw new Error(`Fix before saving: ${issues.join('; ')}`);
  const saved = await request('/api/arenas', doc);
  arena.savedId = saved.id; arena.dirty = false;
  emit('arena:saved', saved);
  renderPanel();
  return saved;
}

async function loadRuns() {
  arena.runs = [];
  if (!arena.savedId && !arena.base_map_id) return;
  try {
    const table = await request('/api/runs');
    const id = arena.savedId ?? arena.base_map_id;
    arena.runs = table.runs.filter(r => r.map_id === id && r.trajectory?.length);
  } catch { arena.runs = []; }
  draw();
}

function presetIssues() {
  const doc = mapDoc(), out = [];
  arena.presets.forEach(q => {
    const s = pointStatus(doc, q.start_xy), g = pointStatus(doc, q.goal_xy);
    if (s.status !== 'configured_free') out.push(`${q.label}: start — ${s.reason.toLowerCase()}`);
    if (g.status !== 'configured_free') out.push(`${q.label}: goal — ${g.reason.toLowerCase()}`);
    if (Math.hypot(q.goal_xy[0] - q.start_xy[0], q.goal_xy[1] - q.start_xy[1]) < 0.2) out.push(`${q.label}: start and goal closer than 0.2 m`);
  });
  if (arena.boxes.length > 128) out.push('more than 128 boxes');
  return out;
}

// ---------------------------------------------------------------- panel
function updateStatus() {
  const node = $('arena-status'); if (!node) return;
  const save = $('arena-save'), go = $('arena-rehearse');
  if (save) save.textContent = arena.savedId ? 'Saved ✓' : 'Save arena';
  if (go) go.disabled = !arena.savedId;
  const sheet = $('arena-sheet');
  if (sheet) {
    sheet.disabled = !arena.savedId || !preset();
    sheet.title = !arena.savedId ? 'Save the arena first: the build sheet is made from the saved arena' : !preset() ? 'Add a start/goal preset first'
      : 'Printable build sheet for the active preset: floor measurements from the start mark, the console command and the rehearsal evidence (new tab)';
  }
  const issues = presetIssues();
  node.innerHTML = `<div class="arena-counts"><span><strong>${arena.boxes.length}</strong> boxes</span><span><strong>${arena.presets.length}</strong> presets</span><span>${arena.savedId ? `<span class="chip chip-recorded">SAVED ${escape(arena.savedId.slice(-6))}</span>` : '<span class="chip chip-unavailable">UNSAVED DRAFT</span>'}</span></div>
    ${issues.length ? `<ul class="issues">${issues.map(i => `<li>${escape(i)}</li>`).join('')}</ul>` : '<p class="tiny ok">Preflight: every start and goal clears the standing footprint. Route feasibility is not checked; only a rehearsal can tell.</p>'}`;
  document.querySelectorAll('[data-preset-index]').forEach(row => {
    const q = arena.presets[Number(row.dataset.presetIndex)]; if (!q) return;
    const ok = pointStatus(mapDoc(), q.start_xy).status === 'configured_free' && pointStatus(mapDoc(), q.goal_xy).status === 'configured_free';
    row.querySelector('.preset-state').className = `preset-state ${ok ? 'ok' : 'bad'}`;
    row.querySelector('.preset-state').textContent = ok ? '✓' : '✕';
  });
  const sel = arena.selection?.type === 'box' ? arena.boxes[arena.selection.index] : null;
  if (sel) for (const [id, v] of [['box-x', sel.center_xy[0]], ['box-y', sel.center_xy[1]], ['box-len', sel.half_xy[0] * 2], ['box-wid', sel.half_xy[1] * 2], ['box-yaw', deg(sel.yaw)], ['box-z0', sel.z_bottom], ['box-z1', sel.z_top]]) {
    const input = $(id); if (input && document.activeElement !== input) input.value = (Math.round(v * 1000) / 1000).toString();
  }
  const q = preset();
  if (q) for (const [id, v] of [['preset-sx', q.start_xy[0]], ['preset-sy', q.start_xy[1]], ['preset-yaw', deg(q.start_yaw_rad)], ['preset-gx', q.goal_xy[0]], ['preset-gy', q.goal_xy[1]]]) {
    const input = $(id); if (input && document.activeElement !== input) input.value = (Math.round(v * 1000) / 1000).toString();
  }
}

export function renderPanel() {
  const root = $('arena-panel'); if (!root) return;
  const sel = arena.selection?.type === 'box' ? arena.boxes[arena.selection.index] : null, q = preset();
  const maps = arena.catalog?.maps ?? [];
  root.innerHTML = `
    <div class="panel-section"><label class="field">Arena name<input id="arena-label" maxlength="100" value="${escape(arena.label)}"></label>
      <div class="field-row"><label class="field">Start from<select id="arena-base"><option value="">Choose…</option>
        <optgroup label="Templates">${Object.entries(TEMPLATES).map(([k, t]) => `<option value="tpl:${k}">${escape(t.label)}</option>`).join('')}</optgroup>
        <optgroup label="Maps">${maps.filter(m => m.kind === 'boxes').map(m => `<option value="map:${escape(m.id)}">${escape(m.label)}</option>`).join('')}</optgroup></select></label>
        <label class="field narrow" title="Seed for the clutter template">Seed<input id="arena-seed" type="number" min="0" max="9999" value="7"></label></div></div>
    <div class="panel-section"><div class="tool-row" role="toolbar" aria-label="Arena tools">
      ${[['select', '↖', 'Select / move (drag empty space to pan)'], ['wall', '▬', 'Draw wall: drag a line'], ['beam', '⊓', 'Draw overhead beam (1.05–1.25 m): drag'], ['pillar', '■', 'Place 0.3 m pillar: click'], ['start', '◉', 'Place start: click'], ['goal', '◎', 'Place goal: click']]
        .map(([k, icon, tip]) => `<button data-arena-tool="${k}" title="${escape(tip)}" aria-pressed="${arena.tool === k}" class="${arena.tool === k ? 'active' : ''}"><span>${icon}</span>${k}</button>`).join('')}</div>
      <div class="field-row compact"><label class="check"><input id="arena-snap" type="checkbox" ${arena.snap ? 'checked' : ''}> Snap 5 cm / 5°</label><button id="arena-fit">Fit view</button><button id="arena-preview3d" aria-pressed="${arena.preview3d ? 'true' : 'false'}" class="${arena.preview3d ? 'active' : ''}">3D preview</button></div>
      <p class="tiny">Drag boxes to move; blue handles resize, amber rotates. Del removes · D duplicates · R rotates 15° · arrows nudge. Drag the blue tip to set start heading.</p></div>
    ${sel ? `<div class="panel-section"><h4>Selected ${escape(kindOf(sel))} #${arena.selection.index + 1}</h4><div class="grid-fields">
      <label>X m<input id="box-x" type="number" step="0.05"></label><label>Y m<input id="box-y" type="number" step="0.05"></label><label>Yaw °<input id="box-yaw" type="number" step="5"></label>
      <label>Length m<input id="box-len" type="number" step="0.05" min="0.06"></label><label>Width m<input id="box-wid" type="number" step="0.05" min="0.06"></label><span></span>
      <label>Bottom m<input id="box-z0" type="number" step="0.05" min="0"></label><label>Top m<input id="box-z1" type="number" step="0.05" min="0.05"></label></div>
      <div class="field-row compact"><button id="box-dup">Duplicate</button><button id="box-del" class="danger">Delete</button></div></div>` : ''}
    <div class="panel-section"><h4>Start / goal presets</h4><div class="preset-list">${arena.presets.map((x, i) => `<div class="preset-row ${i === arena.active ? 'active' : ''}" data-preset-index="${i}"><button data-preset-select="${i}">${escape(x.label)}</button><span class="preset-state">·</span>${arena.presets.length > 1 ? `<button class="icon" data-preset-remove="${i}" aria-label="Remove ${escape(x.label)} preset" title="Remove preset">✕</button>` : ''}</div>`).join('')}</div>
      ${q ? `<label class="field">Preset name<input id="preset-label" maxlength="100" value="${escape(q.label)}"></label><div class="grid-fields">
        <label>Start X<input id="preset-sx" type="number" step="0.05"></label><label>Start Y<input id="preset-sy" type="number" step="0.05"></label><label>Heading °<input id="preset-yaw" type="number" step="5"></label>
        <label>Goal X<input id="preset-gx" type="number" step="0.05"></label><label>Goal Y<input id="preset-gy" type="number" step="0.05"></label><span></span></div>` : ''}
      <div class="field-row compact"><button id="preset-add" ${arena.presets.length >= 16 ? 'disabled' : ''}>+ Add preset</button><button id="preset-mirror" title="Add a copy mirrored across y = 0">Mirror Y</button></div>
      <details class="random-goals" ${arena.randomOpen ? 'open' : ''}><summary>Random goals (seeded)</summary>
        <div class="grid-fields"><label>Count<input id="rg-count" type="number" min="1" max="16" value="${arena.rg?.count ?? 8}"></label><label>Min m<input id="rg-min" type="number" step="0.5" min="0.5" value="${arena.rg?.minDist ?? 1.5}"></label><label>Max m<input id="rg-max" type="number" step="0.5" min="1" value="${arena.rg?.maxDist ?? 4.5}"></label>
        <label>Seed<input id="rg-seed" type="number" min="0" max="99999" value="${arena.rg?.seed ?? 1}"></label><label>Heading<select id="rg-heading"><option value="toward">toward goal</option><option value="random">random</option><option value="fixed">keep start's</option></select></label><span></span></div>
        <div class="field-row compact"><label class="check"><input id="rg-start" type="checkbox" ${arena.rg?.randomStart ? 'checked' : ''}> Random start too</label><label class="check" title="Only keep goals whose straight line from the start crosses an obstacle"><input id="rg-obstructed" type="checkbox" ${arena.rg?.obstructed ? 'checked' : ''}> Behind an obstacle</label><label class="check"><input id="rg-append" type="checkbox" ${arena.rg && !arena.rg.replace ? 'checked' : ''}> Append</label><button id="rg-generate" class="primary-action">Generate</button></div>
        <p class="tiny">Samples inside the arena bounds; each start and goal must clear the standing footprint. Same seed → same presets. Save the arena, then Rehearse → Run suite.</p></details></div>
    <div class="panel-section" id="arena-status"></div>
    <div class="panel-section sticky-actions"><button id="arena-save" class="primary-action">${arena.savedId ? 'Saved ✓' : 'Save arena'}</button><button id="arena-rehearse" ${arena.savedId ? '' : 'disabled'} title="Open Rehearse with this arena">Rehearse →</button><button id="arena-sheet" disabled>Build sheet</button>
      <button id="arena-export">↓ JSON</button><label class="file-button">↑ JSON<input id="arena-import" type="file" accept="application/json,.json"></label></div>`;
  bindPanel();
  updateStatus();
}

function bindPanel() {
  const num_ = id => $(id).valueAsNumber;
  // Text fields update in place: re-rendering the panel on 'change' (fired on blur by the
  // mousedown of the next click) would replace the clicked button before its 'click'.
  $('arena-label').addEventListener('input', e => { arena.label = e.target.value; arena.savedId = null; updateStatus(); });
  $('arena-base').addEventListener('change', e => {
    const v = e.target.value; if (!v) return;
    if (v.startsWith('tpl:')) applyTemplate(v.slice(4), Number($('arena-seed').value) || 7);
    else loadFromMap(v.slice(4)).catch(err => emit('arena:error', err.message));
  });
  document.querySelectorAll('[data-arena-tool]').forEach(b => b.addEventListener('click', () => setTool(b.dataset.arenaTool)));
  $('arena-snap').addEventListener('change', e => { arena.snap = e.target.checked; });
  $('arena-fit').addEventListener('click', fitArena);
  $('arena-preview3d').addEventListener('click', e => { const on = e.currentTarget.getAttribute('aria-pressed') !== 'true'; e.currentTarget.setAttribute('aria-pressed', String(on)); e.currentTarget.classList.toggle('active', on); emit('arena:preview3d', on); });
  const sel = arena.selection?.type === 'box' ? arena.boxes[arena.selection.index] : null;
  if (sel) {
    const bindBox = (id, apply) => $(id).addEventListener('change', () => { const v = num_(id); if (finite(v)) { apply(v); changed(false); draw(); } else { updateStatus(); } });
    bindBox('box-x', v => { sel.center_xy[0] = v; }); bindBox('box-y', v => { sel.center_xy[1] = v; });
    bindBox('box-len', v => { sel.half_xy[0] = Math.max(0.03, v / 2); }); bindBox('box-wid', v => { sel.half_xy[1] = Math.max(0.03, v / 2); });
    bindBox('box-yaw', v => { sel.yaw = wrap(rad(v)); }); bindBox('box-z0', v => { sel.z_bottom = Math.max(0, Math.min(v, sel.z_top - 0.05)); });
    bindBox('box-z1', v => { sel.z_top = Math.max(sel.z_bottom + 0.05, Math.min(10, v)); });
    $('box-dup').addEventListener('click', () => addBox({ ...clone(sel), center_xy: [sel.center_xy[0] + 0.3, sel.center_xy[1] - 0.3] }));
    $('box-del').addEventListener('click', () => { arena.boxes.splice(arena.selection.index, 1); arena.selection = null; changed(); draw(); });
  }
  document.querySelectorAll('[data-preset-select]').forEach(b => b.addEventListener('click', () => { arena.active = Number(b.dataset.presetSelect); renderPanel(); draw(); emit('arena:changed', arena); }));
  document.querySelectorAll('[data-preset-remove]').forEach(b => b.addEventListener('click', () => { arena.presets.splice(Number(b.dataset.presetRemove), 1); arena.active = Math.min(arena.active, arena.presets.length - 1); changed(); draw(); }));
  const q = preset();
  if (q) {
    $('preset-label').addEventListener('input', e => {
      q.label = e.target.value || 'Preset'; arena.savedId = null;
      const row = document.querySelector(`[data-preset-select="${arena.active}"]`); if (row) row.textContent = q.label;
      updateStatus(); draw();
    });
    const bindPreset = (id, apply) => $(id).addEventListener('change', () => { const v = num_(id); if (finite(v)) { apply(v); changed(false); draw(); } else { updateStatus(); } });
    bindPreset('preset-sx', v => { q.start_xy[0] = v; }); bindPreset('preset-sy', v => { q.start_xy[1] = v; });
    bindPreset('preset-yaw', v => { q.start_yaw_rad = wrap(rad(v)); });
    bindPreset('preset-gx', v => { q.goal_xy[0] = v; }); bindPreset('preset-gy', v => { q.goal_xy[1] = v; });
  }
  $('preset-add').addEventListener('click', () => { const base = preset() ?? p('Preset', [0, 0], 0, [3, 0]); arena.presets.push({ ...clone(base), label: `Preset ${arena.presets.length + 1}` }); arena.active = arena.presets.length - 1; changed(); draw(); });
  $('rg-heading').value = arena.rg?.heading ?? 'toward';
  document.querySelector('.random-goals').addEventListener('toggle', e => { arena.randomOpen = e.target.open; });
  $('rg-generate').addEventListener('click', () => {
    // Reuse the previous base only while the presets are exactly what the last generation made
    // (so a random-start pass does not move it); any load, selection edit or new arena resets it
    // to the active preset's start.
    const q0 = arena.presets[arena.active], same = arena.rgBase && arena.rgBase.presets === JSON.stringify(arena.presets);
    arena.rg = { count: Math.max(1, Math.min(16, Number($('rg-count').value) || 8)), minDist: Number($('rg-min').value) || 1.5,
      maxDist: Number($('rg-max').value) || 4.5, seed: Math.max(0, Number($('rg-seed').value) || 0), randomStart: $('rg-start').checked,
      heading: $('rg-heading').value, replace: !$('rg-append').checked, obstructed: $('rg-obstructed').checked,
      baseStart: same ? arena.rgBase.start_xy.slice() : q0?.start_xy?.slice() ?? [0, 0],
      baseYaw: same ? arena.rgBase.start_yaw_rad : q0?.start_yaw_rad ?? 0 };
    const made = randomPresets(arena.rg);
    if (made.length < arena.rg.count) emit('arena:error', `Only ${made.length} of ${arena.rg.count} goals fit the distance band and preflight; widen the band or enlarge the arena.`);
  });
  $('preset-mirror').addEventListener('click', () => { const base = preset(); if (!base || arena.presets.length >= 16) return; arena.presets.push({ label: `${base.label} · mirrored`, start_xy: [base.start_xy[0], -base.start_xy[1]], start_yaw_rad: -base.start_yaw_rad, goal_xy: [base.goal_xy[0], -base.goal_xy[1]] }); arena.active = arena.presets.length - 1; changed(); draw(); });
  $('arena-save').addEventListener('click', async e => { e.currentTarget.disabled = true; try { await saveArena(); } catch (err) { emit('arena:error', err.message); } finally { const b = $('arena-save'); if (b) b.disabled = false; } });
  $('arena-rehearse').addEventListener('click', () => emit('arena:rehearse', arena.savedId));
  $('arena-sheet').addEventListener('click', () => { if (arena.savedId && preset()) window.open(`/sheet.html?arena=${encodeURIComponent(arena.savedId)}&preset=${arena.active}`, '_blank', 'noopener'); });
  $('arena-export').addEventListener('click', () => download(`${(arena.label || 'arena').replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.json`, exportDocument()));
  $('arena-import').addEventListener('change', async e => {
    const file = e.target.files[0]; if (!file) return;
    try {
      if (file.size > 4 * 1024 * 1024) throw new Error('Arena JSON exceeds 4 MiB');
      const doc = JSON.parse(await file.text());
      if (doc.kind !== 'boxes' || doc.frame_id !== 'world') throw new Error('Arena JSON must be {kind: "boxes", frame_id: "world", boxes: [...]} in metres');
      const okBox = b => b && [b.center_xy, b.half_xy].every(v => Array.isArray(v) && v.length === 2 && v.every(finite)) && finite(b.z_bottom) && finite(b.z_top) && b.z_top > b.z_bottom;
      const okPreset = q => q && [q.start_xy, q.goal_xy].every(v => Array.isArray(v) && v.length === 2 && v.every(finite));
      if (!Array.isArray(doc.boxes) || doc.boxes.length > 128 || !doc.boxes.every(okBox)) throw new Error('Arena JSON boxes must be ≤128 entries with numeric center_xy, half_xy, z_bottom < z_top.');
      if (doc.presets !== undefined && (!Array.isArray(doc.presets) || doc.presets.length > 16 || !doc.presets.every(okPreset))) throw new Error('Arena JSON presets must be ≤16 entries with numeric start_xy and goal_xy.');
      loadArena({ label: doc.label ?? file.name.replace(/\.json$/i, ''), boxes: doc.boxes ?? [], presets: doc.presets ?? [], description: doc.description ?? '' });
    } catch (err) { emit('arena:error', err.message); }
  });
}

export function initArena(canvas, catalog) {
  arena.canvas = canvas; arena.catalog = catalog;
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('lostpointercapture', onPointerCancel);
  canvas.addEventListener('pointerleave', () => { arena.hover = null; draw(); });
  canvas.addEventListener('wheel', onWheel, { passive: false });
  canvas.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', onKey);
  new ResizeObserver(() => draw()).observe(canvas);
  if (!arena.boxes.length && !arena.presets.length) applyTemplate('corridor');
}
export const activePreset = preset;
