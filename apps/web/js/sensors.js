// Causal sensor browser and pinned sensor cards. Missing channels stay visible.
import { $, escape, num, vector, fact, finite, request, chip, updateView, yawOf } from './util.js';
import { setSensorOverlay, removeSensorOverlay } from './scene.js';

export const sn = { data: null, pinned: new Set(), inflight: false, pending: false, time: null, session: null, lastFetch: 0, visible: false };

const CLASS_EVIDENCE = { 'simulator-ground-truth': 'sim-truth', 'simulator-commanded': 'commanded', estimated: 'estimated', commanded: 'commanded',
  measured: 'measured', observed_scan: 'measured', recorded: 'recorded', configured: 'configured' };

function payloadView(sensor) {
  const payload = sensor.payload ?? {};
  const points = payload.points;
  if (Array.isArray(points)) return `<canvas class="sensor-preview" data-sensor-preview="${escape(sensor.id)}" aria-label="${escape(sensor.label)} XY projection"></canvas>
    ${fact('Displayed points', points.length.toLocaleString())}${payload.input_points_count ? fact('Source points', payload.input_points_count.toLocaleString()) : ''}`;
  if (sensor.id === 'base_pose') return `${fact('Position · m', vector(payload.position ?? payload.position_m, 2))}${fact('Quaternion · wxyz', vector(payload.quaternion_wxyz))}`;
  if (sensor.id === 'joints' || sensor.id === 'joint_targets' || sensor.id === 'joint_velocity') {
    const values = payload.position ?? payload.positions ?? payload.position_rad ?? payload.velocity_rad_s ?? payload.targets ?? payload.joints ?? [];
    const names = payload.names ?? payload.joint_names ?? [];
    return `<div class="sensor-joint-bars">${values.slice(0, 29).map((v, i) => `<span title="${escape(names[i] ?? i)}: ${num(v, 3)}"><i style="height:${finite(v) ? Math.min(100, Math.abs(v) * 35) + 3 : 0}%;${v < 0 ? 'background:var(--c-purple)' : ''}"></i></span>`).join('')}</div><p class="tiny">${values.length} named joints · MuJoCo order · |value| bar, purple = negative</p>`;
  }
  return Object.entries(payload).filter(([k, v]) => !['points', 'provenance'].includes(k) && (v === null || typeof v !== 'object' || (Array.isArray(v) && v.length <= 4)))
    .slice(0, 6).map(([k, v]) => fact(k.replaceAll('_', ' '), Array.isArray(v) ? vector(v) : typeof v === 'number' ? num(v, 3) : v)).join('');
}

function card(sensor, pinned = false) {
  const available = sensor.available ?? (!['unavailable', 'missing'].includes(sensor.status) && !!sensor.payload);
  const tone = !available ? 'missing' : sensor.status === 'fresh' ? 'available' : 'unknown';
  return `<article class="sensor-card ${pinned ? 'pinned' : ''}" data-sensor-card="${escape(sensor.id)}">
    <div class="sensor-card-heading"><strong>${escape(sensor.label)}</strong><span class="sensor-state ${tone}">${escape(sensor.status)}</span></div>
    <div class="sensor-classification">${available ? (CLASS_EVIDENCE[sensor.classification] ? chip(CLASS_EVIDENCE[sensor.classification]) : `<span class="chip chip-unavailable" title="Unrecognized classification">${escape(sensor.classification ?? 'UNCLASSIFIED')}</span>`) : chip('unavailable')}<span>${escape(sensor.synchronized ? 'session clock' : 'unsynchronized')}</span></div>
    ${available ? payloadView(sensor) : `<p class="sensor-reason">${escape(sensor.reason ?? 'This source was not captured.')}</p>`}
    ${available ? fact('Age / rate', `${num(sensor.age_ms, 0, 'ms')} / ${num(sensor.rate_hz, 1, 'Hz')}`) : ''}
    ${pinned ? '' : `<details><summary>Frame & provenance</summary>${fact('Frame', sensor.frame_id)}${fact('Clock', sensor.source_clock ?? sensor.source_clock_domain)}${fact('Source time', num(sensor.source_time, 3, 's'))}<pre>${escape(JSON.stringify({ extrinsics: sensor.extrinsics, provenance: sensor.provenance }, null, 1))}</pre></details>`}
    <button class="sensor-pin" data-pin-sensor="${escape(sensor.id)}" ${!available && !pinned ? 'disabled' : ''}>${sn.pinned.has(sensor.id) ? 'Unpin' : 'Pin to viewport'}</button></article>`;
}

function preview(canvas, sensor, state) {
  const W = Math.max(1, canvas.clientWidth), H = Math.max(1, canvas.clientHeight), ratio = Math.min(2, devicePixelRatio || 1);
  canvas.width = Math.round(W * ratio); canvas.height = Math.round(H * ratio);
  const ctx = canvas.getContext('2d'); ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  ctx.fillStyle = '#0d151d'; ctx.fillRect(0, 0, W, H);
  const pts = (sensor?.payload?.points ?? []).filter((_, i, a) => i % Math.max(1, Math.ceil(a.length / 2500)) === 0);
  if (!pts.length) return;
  const pose = state?.measuredFrame, robot = sensor.overlay_compatible && Array.isArray(pose?.position) ? pose.position : null;
  const all = robot ? [...pts, robot] : pts;
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  const lo = [Math.min(...xs), Math.min(...ys)], hi = [Math.max(...xs), Math.max(...ys)];
  const scale = Math.min((W - 20) / Math.max(0.1, hi[0] - lo[0]), (H - 20) / Math.max(0.1, hi[1] - lo[1]));
  const px = p => [10 + (p[0] - lo[0]) * scale, H - 10 - (p[1] - lo[1]) * scale];
  // Color by height so overhead returns read differently from ground returns.
  for (const p of pts) { const [x, y] = px(p); const zc = Math.max(0, Math.min(1, ((p[2] ?? 0) + 0.2) / 1.8)); ctx.fillStyle = `hsl(${165 - zc * 120},60%,${55 + zc * 10}%)`; ctx.fillRect(x, y, 1.6, 1.6); }
  if (robot) {
    const [x, y] = px(robot), yaw = yawOf(pose.quaternion_wxyz) ?? 0;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-yaw); ctx.fillStyle = '#efbb70'; ctx.beginPath();
    ctx.moveTo(8, 0); ctx.lineTo(-5, -5); ctx.lineTo(-3, 0); ctx.lineTo(-5, 5); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  ctx.fillStyle = '#a8bbc8'; ctx.font = '10px Inter, system-ui'; ctx.fillText(`${num(hi[0] - lo[0], 1)} × ${num(hi[1] - lo[1], 1)} m · color = height`, 6, 12);
}

export function renderSensors(state) {
  const sensors = sn.data?.sensors ?? [];
  const panel = $('sensors-panel');
  if (panel && sn.visible) {
    const open = [...panel.querySelectorAll('[data-sensor-card] details[open]')].map(n => n.closest('[data-sensor-card]').dataset.sensorCard);
    panel.innerHTML = sn.data ? `<p class="tiny">Causal samples at ${num(sn.data.cursor_s, 3, 's')}. Pin up to three views below the viewport; point clouds also overlay the 3D scene when their frame matches. Unavailable sources stay listed with the reason.</p>
      <div class="sensor-grid">${sensors.map(s => card(s)).join('')}</div>` : '<p class="tiny">Loading causal sensor samples…</p>';
    for (const id of open) panel.querySelector(`[data-sensor-card="${CSS.escape(id)}"] details`)?.setAttribute('open', '');
  }
  const pinned = sensors.filter(s => sn.pinned.has(s.id));
  const dock = $('sensor-dock');
  dock.hidden = !pinned.length;
  dock.innerHTML = pinned.map(s => card(s, true)).join('');
  document.body.classList.toggle('has-sensor-dock', pinned.length > 0);
  for (const s of pinned) setSensorOverlay(s);
  document.querySelectorAll('[data-sensor-preview]').forEach(c => preview(c, sensors.find(s => s.id === c.dataset.sensorPreview), state));
  // Bind only the freshly rendered buttons of this panel and the dock (no duplicate handlers).
  [panel, dock].filter(Boolean).flatMap(root => [...root.querySelectorAll('[data-pin-sensor]')]).forEach(b => b.addEventListener('click', () => {
    const id = b.dataset.pinSensor;
    if (sn.pinned.has(id)) { sn.pinned.delete(id); removeSensorOverlay(id); }
    else if (sn.pinned.size >= 3) { window.dispatchEvent(new CustomEvent('studio:error', { detail: 'Unpin a view first: the viewport holds three sensor cards.' })); return; }
    else sn.pinned.add(id);
    updateView({ pin: sn.pinned.size ? [...sn.pinned].join(',') : null });
    renderSensors(state);
  }));
}

export async function refreshSensors(state, force = false) {
  if (!state?.sessionId) return;
  if (sn.inflight) { sn.pending = true; return; }
  if (!force && !sn.visible && !sn.pinned.size) return;
  if (!force && sn.session === state.sessionId && finite(sn.time) && Math.abs(sn.time - state.time) < (state.playing ? 0.09 : 1e-9)) return;
  sn.inflight = true;
  const id = state.sessionId, time = state.time;
  try {
    const data = await request(`/api/sensors?session=${encodeURIComponent(id)}&time=${encodeURIComponent(time)}`);
    if (state.sessionId !== id) return;
    sn.data = data; sn.time = time; sn.session = id;
    renderSensors(state);
  } catch (error) {
    if (sn.visible) window.dispatchEvent(new CustomEvent('studio:error', { detail: error.message }));
  } finally {
    sn.inflight = false;
    if (sn.pending || state.sessionId !== id || (!state.playing && Math.abs(state.time - time) > 1e-9)) { sn.pending = false; refreshSensors(state, true); }
  }
}

export function resetSensors() {
  for (const id of sn.pinned) removeSensorOverlay(id);
  sn.data = null; sn.session = null; sn.time = null;
  $('sensor-dock').hidden = true;
}

export function initSensors() {
  const view = new URLSearchParams(location.search);
  sn.pinned = new Set((view.get('pin') ?? '').split(',').filter(id => /^[a-z_]{1,40}$/.test(id)).slice(0, 3));
}
