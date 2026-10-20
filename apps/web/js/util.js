// Shared formatting, evidence vocabulary and request helpers.
// Every value shown in the UI comes from server-normalized data; helpers here
// never invent defaults for missing values (they render "Unavailable").

export const $ = id => document.getElementById(id);
export const finite = n => typeof n === 'number' && Number.isFinite(n);

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = value => String(value ?? 'Unavailable').replace(/[&<>"']/g, c => ESCAPES[c]);

export function num(n, digits = 2, unit = '') {
  return finite(n) ? `${n.toFixed(digits)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
}
export const vector = (v, digits = 3) => Array.isArray(v) ? v.map(n => num(n, digits)).join(', ') : 'Unavailable';

export function clock(value) {
  if (!finite(value)) return '—';
  const ms = Math.round(Math.max(0, value) * 1000);
  const mm = String(Math.floor(ms / 60000)).padStart(2, '0');
  const ss = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${mm}:${ss}.${String(ms % 1000).padStart(3, '0')}`;
}

export function ago(unixSeconds) {
  if (!finite(unixSeconds)) return 'time unknown';
  const s = Date.now() / 1000 - unixSeconds;
  if (s < 90) return 'just now';
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return new Date(unixSeconds * 1000).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export const fact = (label, value, cls = '') =>
  `<div class="fact"><span>${escape(label)}</span><strong class="${cls}">${escape(value)}</strong></div>`;
export const notice = (text, cls = '') => `<div class="callout ${cls}">${escape(text)}</div>`;
export const tiny = text => `<p class="tiny">${escape(text)}</p>`;

// One evidence vocabulary for facts, layers, edges and lanes (review §4.1).
export const EVIDENCE = {
  measured: { label: 'MEASURED', tip: 'From a physical sensor or recorded wire bytes.' },
  'sim-truth': { label: 'SIM-TRUTH', tip: 'Simulator internal state (e.g. MuJoCo qpos, contact forces). Not a physical measurement.' },
  estimated: { label: 'ESTIMATED', tip: 'Derived by an estimator or map (e.g. CloudMemory support/ceiling).' },
  commanded: { label: 'COMMANDED', tip: 'Intent or command (plan, reference window, PD targets). Not proof of delivery.' },
  configured: { label: 'CONFIGURED', tip: 'Read from source or configuration, not observed at runtime.' },
  observed: { label: 'OBSERVED', tip: 'Observed at runtime by a Studio wrapper or subscriber.' },
  recorded: { label: 'RECORDED', tip: 'Replayed from a saved recording.' },
  unavailable: { label: 'UNAVAILABLE', tip: 'Not captured in this source. Missing values are never shown as healthy zeros.' },
};
export function chip(kind, reason = '') {
  const e = EVIDENCE[kind] ?? { label: String(kind).toUpperCase(), tip: '' };
  const tip = reason ? `${e.tip} ${reason}` : e.tip;
  return `<span class="chip chip-${escape(kind)}" title="${escape(tip)}">${escape(e.label)}</span>`;
}

export const OUTCOMES = {
  goal_completion: { label: 'Goal reached', tone: 'good' },
  timeout: { label: 'Timed out', tone: 'warn' },
  obstacle_collision: { label: 'Collision', tone: 'bad' },
  fall: { label: 'Fall', tone: 'bad' },
  runtime_error: { label: 'Runtime error', tone: 'bad' },
};
export function outcomeChip(outcome, status) {
  if (!outcome) {
    const tone = ['running', 'starting', 'queued'].includes(status) ? 'live' : status === 'failed' ? 'bad' : 'muted';
    return `<span class="outcome outcome-${tone}">${escape((status ?? 'unknown').replaceAll('_', ' '))}</span>`;
  }
  const o = OUTCOMES[outcome] ?? { label: outcome.replaceAll('_', ' '), tone: 'muted' };
  return `<span class="outcome outcome-${o.tone}">${escape(o.label)}</span>`;
}
export const outcomeColor = outcome =>
  ({ good: '#5fd39b', warn: '#efbb70', bad: '#f08c85', live: '#56d9d0' })[(OUTCOMES[outcome] ?? {}).tone] ?? '#8e9aa9';

let token = '', refreshToken = null;
export const setToken = value => { token = value ?? ''; };
export const setTokenRefresher = fn => { refreshToken = fn; };

export async function request(path, body, { cache = 'no-store', retried = false } = {}) {
  const options = { cache };
  if (body !== undefined) {
    Object.assign(options, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token },
      body: JSON.stringify(body),
    });
  }
  const response = await fetch(path, options);
  let data;
  try { data = await response.json(); } catch { data = {}; }
  if (response.status === 403 && body !== undefined && !retried && refreshToken && /token/i.test(data.error ?? '')) {
    await refreshToken();
    return request(path, body, { cache, retried: true });
  }
  if (!response.ok) throw new Error(data.error ?? `${path}: request failed (${response.status})`);
  return data;
}

// Minimal event bus shared by modules (session, frame, workspace changes).
const listeners = new Map();
export function on(name, fn) {
  if (!listeners.has(name)) listeners.set(name, new Set());
  listeners.get(name).add(fn);
  return () => listeners.get(name).delete(fn);
}
export function emit(name, detail) {
  for (const fn of listeners.get(name) ?? []) {
    try { fn(detail); } catch (error) { console.error(`${name} listener failed`, error); }
  }
}

export function updateView(values) {
  const url = new URL(location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null || value === undefined || value === '') url.searchParams.delete(key);
    else url.searchParams.set(key, String(value));
  }
  if (url.href !== location.href) history.replaceState({}, '', url);
}

// Debounced variant for high-frequency cursor updates (Safari limits replaceState).
let pendingView = {}, viewTimer = null;
export function updateViewSoon(values) {
  Object.assign(pendingView, values);
  clearTimeout(viewTimer);
  viewTimer = setTimeout(() => { const v = pendingView; pendingView = {}; updateView(v); }, 250);
}

export function download(name, data, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof data === 'string' ? data : JSON.stringify(data, null, 2)], { type }));
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export const yawOf = q => Array.isArray(q) ? Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])) : null;
export const hasPose = f => Array.isArray(f?.position) && Array.isArray(f?.quaternion_wxyz) && Array.isArray(f?.qpos);
export const hasReferencePose = f => hasPose(f) && Array.isArray(f?.reference?.position) && Array.isArray(f?.reference?.quaternion_wxyz);

// Same conservative standing-footprint preflight the server applies (workbench.point_status).
export function pointStatus(map, point, clearance = 0.25) {
  if (!map?.bounds) return { status: 'unknown', reason: 'Map bounds unavailable' };
  const lo = map.bounds.min, hi = map.bounds.max;
  if (point.some((v, i) => !finite(v) || v < lo[i] || v > hi[i])) return { status: 'outside', reason: 'Outside the map bounds' };
  for (const box of map.boxes ?? []) {
    const dx = point[0] - box.center_xy[0], dy = point[1] - box.center_xy[1];
    const c = Math.cos(box.yaw ?? 0), s = Math.sin(box.yaw ?? 0);
    const local = [c * dx + s * dy, -s * dx + c * dy];
    if (box.z_bottom < 1.3 && box.z_top > 0 && local.every((v, i) => Math.abs(v) <= box.half_xy[i] + clearance))
      return { status: 'blocked', reason: 'An obstacle intersects the conservative standing footprint' };
  }
  return { status: 'configured_free', reason: 'No configured box intersects the standing footprint (path not checked)' };
}
