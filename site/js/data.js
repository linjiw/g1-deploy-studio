// Site data (tools/site/export.py): quantized integers back to SI units, and time lookups for a recorded walk.
// Paths are relative to the data folder next to js/, so the main page, demo/ and next/ share it.
export const DATA = new URL('../data/', import.meta.url).href;
export const MEDIA = new URL('../media/', import.meta.url).href;
const at = path => new URL(path, DATA).href;
const cache = new Map();

// Walks are fetched one at a time as they are played: keep the last few, not every walk ever opened.
const walks = new Map();
export async function walkJson(path, keep = 6) {
  const url = at(path);
  if (walks.has(url)) { const v = walks.get(url); walks.delete(url); walks.set(url, v); return v; }
  const value = await fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  walks.set(url, value);
  while (walks.size > keep) walks.delete(walks.keys().next().value);
  return value;
}

export async function json(path) {
  const url = at(path);
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => { if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`); return r.json(); })
    .catch(error => { cache.delete(url); throw error; }));
  return cache.get(url);
}

export const b64bytes = text => Uint8Array.from(atob(text), c => c.charCodeAt(0));

// One frame: x y z (mm), quaternion w x y z (x 1e4), 29 joint angles (mrad) -> metres, unit quaternion, radians.
export function qpos(ints, offset = 0, out = new Float64Array(36)) {
  for (let k = 0; k < 3; k++) out[k] = ints[offset + k] / 1000;
  let n = 0;
  for (let k = 3; k < 7; k++) { out[k] = ints[offset + k] / 1e4; n += out[k] * out[k]; }
  n = Math.sqrt(n) || 1;
  for (let k = 3; k < 7; k++) out[k] /= n;
  for (let k = 7; k < 36; k++) out[k] = ints[offset + k] / 1000;
  return out;
}

export function decodeWorld(index) {
  const map = { ...index.map, codes: b64bytes(index.map.codes), height_cm: b64bytes(index.map.height_cm) };
  const cells = index.cells.map(c => ({ ...c, walk: index.walks[c.id] ?? null }));
  return { ...index, map, cells, startPose: qpos(index.start_qpos) };
}

export class Walk {
  constructor(data) {
    Object.assign(this, data);
    this.times = Float64Array.from(data.time);
    this.duration = this.times[this.times.length - 1];
    this.frames = new Float64Array(data.n * 36);
    for (let k = 0; k < data.n; k++) qpos(data.q, k * 36, this.frames.subarray(k * 36, k * 36 + 36));
    this.trail = [];
    for (let k = 0; k < data.n; k++) this.trail.push([this.frames[k * 36], this.frames[k * 36 + 1], 0.02]);
    // The reference SONIC tracks (the plan body), where the recording has one; NaN marks a frame without.
    this.hasRef = Array.isArray(data.ref) && data.ref.some(Boolean);
    if (this.hasRef) {
      this.refFrames = new Float64Array(data.n * 36).fill(NaN);
      data.ref.forEach((r, k) => { if (r) qpos(r, 0, this.refFrames.subarray(k * 36, k * 36 + 36)); });
    }
    this.planList = data.plans.map(p => {
      const pts = [];
      for (let k = 0; k < p.xy.length / 2; k++) pts.push([p.xy[k * 2] / 100, p.xy[k * 2 + 1] / 100, (p.z[k] ?? 78) / 100]);
      return { ...p, points: pts };
    });
    // A plan drives the robot from when it starts executing (after the modelled latency), not when it was requested.
    this.planStarts = data.plan_starts ?? data.plans.map((p, i) => [p.t, i]);
  }
  index(t) {  // last frame at or before t
    const ts = this.times;
    let lo = 0, hi = ts.length - 1;
    if (t <= ts[0]) return 0;
    if (t >= ts[hi]) return hi;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (ts[mid] <= t) lo = mid; else hi = mid; }
    return lo;
  }
  pose(t, out = new Float64Array(36)) { return lerpPose(this, this.frames, t, out); }
  // The plan body at t, or null where the recording has no reference.
  refPose(t, out = new Float64Array(36)) {
    if (!this.hasRef) return null;
    const k = this.index(t);
    if (Number.isNaN(this.refFrames[k * 36])) return null;
    if (k + 1 < this.n && Number.isNaN(this.refFrames[(k + 1) * 36])) { out.set(this.refFrames.subarray(k * 36, k * 36 + 36)); return out; }
    return lerpPose(this, this.refFrames, t, out);
  }
  // Where the robot thinks it is: its estimated position with the true posture (the estimate has no joints).
  estPose(t, out = new Float64Array(36)) {
    this.pose(t, out);
    const k = this.index(t);
    out[0] = this.est[k * 2] / 1000; out[1] = this.est[k * 2 + 1] / 1000;
    return out;
  }
  phaseAt(k) {
    let phase = this.phases[0]?.[1] ?? 'RUN';
    for (const [i, p] of this.phases) { if (i <= k) phase = p; else break; }
    return phase;
  }
  phase(t) { return this.phaseAt(this.index(t)); }
  // Is the reference at t the plan's? While walking (RUN), and while a deferred stand holds the plan's last frame
  // (until the robot stands). Otherwise the node's reference is a stand, not a plan.
  planHeld(t) {
    const phase = this.phase(t);
    if (phase === 'RUN') return true;
    if (phase !== 'ARRIVED') return false;
    const d = this.events.find(e => e.type === 'stand_deferred' && e.t <= t + 1e-9);
    return !!d && !this.events.some(e => (e.type === 'stand' || e.type === 'stand_forced') && e.t > d.t && e.t <= t + 1e-9);
  }
  plan(t) {
    let found = null;
    for (const [start, i] of this.planStarts) { if (start <= t + 1e-9) found = i; else break; }
    return found === null ? null : this.planList[found];
  }
  planNumber(t) {
    let n = 0;
    for (const [start] of this.planStarts) { if (start <= t + 1e-9) n++; else break; }
    return n;
  }
  lidarAt(t) {
    let found = null;
    for (const s of this.lidar) if (s.t <= t + 1e-9) found = s; else break;
    return found;
  }
  sample(series, t) { const v = this[series]?.[this.index(t)]; return v ?? null; }
}

// Linear between frames (40 ms apart); the quaternion as a normalised lerp along the shorter arc.
function lerpPose(walk, f, t, out) {
  const k = walk.index(t);
  if (k >= walk.n - 1) { out.set(f.subarray(k * 36, k * 36 + 36)); return out; }
  const a = (t - walk.times[k]) / (walk.times[k + 1] - walk.times[k] || 1), A = k * 36, B = A + 36;
  for (let i = 0; i < 36; i++) out[i] = f[A + i] + (f[B + i] - f[A + i]) * a;
  let dot = 0; for (let i = 3; i < 7; i++) dot += f[A + i] * f[B + i];
  if (dot < 0) for (let i = 3; i < 7; i++) out[i] = f[A + i] - (f[B + i] + f[A + i]) * a;
  let n = 0; for (let i = 3; i < 7; i++) n += out[i] * out[i];
  n = Math.sqrt(n) || 1; for (let i = 3; i < 7; i++) out[i] /= n;
  return out;
}
