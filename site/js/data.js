// Site data (tools/site/export.py): quantized integers back to SI units, and time lookups for a recorded walk.
const cache = new Map();

// Walks are fetched one at a time as they are played: keep the last few, not every walk ever opened.
const walks = new Map();
export async function walkJson(url, keep = 6) {
  if (walks.has(url)) { const v = walks.get(url); walks.delete(url); walks.set(url, v); return v; }
  const value = await fetch(url).then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); });
  walks.set(url, value);
  while (walks.size > keep) walks.delete(walks.keys().next().value);
  return value;
}

export async function json(url) {
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
  pose(t, out = new Float64Array(36)) {
    const k = this.index(t), f = this.frames;
    if (k >= this.n - 1) { out.set(f.subarray(k * 36, k * 36 + 36)); return out; }
    const a = (t - this.times[k]) / (this.times[k + 1] - this.times[k] || 1), A = k * 36, B = A + 36;
    for (let i = 0; i < 36; i++) out[i] = f[A + i] + (f[B + i] - f[A + i]) * a;
    // Quaternion: normalised lerp along the shorter arc (frames are 40 ms apart).
    let dot = 0; for (let i = 3; i < 7; i++) dot += f[A + i] * f[B + i];
    if (dot < 0) for (let i = 3; i < 7; i++) out[i] = f[A + i] - (f[B + i] + f[A + i]) * a;
    let n = 0; for (let i = 3; i < 7; i++) n += out[i] * out[i];
    n = Math.sqrt(n) || 1; for (let i = 3; i < 7; i++) out[i] /= n;
    return out;
  }
  phase(t) {
    const k = this.index(t);
    let phase = this.phases[0]?.[1] ?? 'RUN';
    for (const [i, p] of this.phases) { if (i <= k) phase = p; else break; }
    return phase;
  }
  plan(t) {
    let found = null;
    for (const [start, i] of this.planStarts) { if (start <= t + 1e-9) found = i; else break; }
    return found === null ? null : this.planList[found];
  }
  lidarAt(t) {
    let found = null;
    for (const s of this.lidar) if (s.t <= t + 1e-9) found = s; else break;
    return found;
  }
  sample(series, t) { const v = this[series]?.[this.index(t)]; return v ?? null; }
}
