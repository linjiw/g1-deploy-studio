#!/usr/bin/env node
// Simplify the G1 STL meshes for the static site: weld, simplify (meshoptimizer), quantize to 16 bits.
//   node tools/site/meshes.mjs <site-data dir>      (reads robot-meshes.txt written by tools/site/export_robot.py)
// Writes meshes.bin (per mesh: uint16 positions, then uint16 indices) and meshes.json (offsets, counts, bounds).
import fs from 'node:fs';
import path from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const dir = process.argv[2];
if (!dir) { console.error('usage: meshes.mjs <site-data dir>'); process.exit(2); }
const RATIO = 0.22, ERROR = 0.004;   // keep about a fifth of the triangles; at most 0.4 % of the mesh size off

function readStl(file) {
  const buf = fs.readFileSync(file);
  const n = buf.readUInt32LE(80);
  if (84 + n * 50 !== buf.length) throw new Error(`${file}: not a binary STL`);
  const tri = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) tri[t * 9 + k] = buf.readFloatLE(84 + t * 50 + 12 + k * 4);
  return tri;
}

function weld(tri) {
  const map = new Map(), pos = [], idx = new Uint32Array(tri.length / 3);
  for (let v = 0; v < tri.length / 3; v++) {
    const key = `${Math.round(tri[v * 3] * 1e5)},${Math.round(tri[v * 3 + 1] * 1e5)},${Math.round(tri[v * 3 + 2] * 1e5)}`;
    let i = map.get(key);
    if (i === undefined) { i = pos.length / 3; map.set(key, i); pos.push(tri[v * 3], tri[v * 3 + 1], tri[v * 3 + 2]); }
    idx[v] = i;
  }
  return { positions: new Float32Array(pos), indices: idx };
}

await MeshoptSimplifier.ready;
const list = fs.readFileSync(path.join(dir, 'robot-meshes.txt'), 'utf8').trim().split('\n').map(l => l.split('\t'));
const chunks = [], index = {};
let offset = 0, before = 0, after = 0;
for (const [name, file] of list) {
  const { positions, indices } = weld(readStl(file));
  const target = Math.max(36, Math.floor(indices.length * RATIO / 3) * 3);
  const [simple] = MeshoptSimplifier.simplify(indices, positions, 3, target, ERROR, ['LockBorder']);
  // Compact: keep only the vertices the simplified triangles use.
  const remap = new Map(), kept = [];
  const out = new Uint16Array(simple.length);
  for (let k = 0; k < simple.length; k++) {
    let i = remap.get(simple[k]);
    if (i === undefined) { i = kept.length; remap.set(simple[k], i); kept.push(simple[k]); }
    out[k] = i;
  }
  if (kept.length > 65535) throw new Error(`${name}: too many vertices for 16-bit indices`);
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (const v of kept) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], positions[v * 3 + a]); max[a] = Math.max(max[a], positions[v * 3 + a]); }
  const q = new Uint16Array(kept.length * 3);
  kept.forEach((v, i) => { for (let a = 0; a < 3; a++) q[i * 3 + a] = Math.round((positions[v * 3 + a] - min[a]) / ((max[a] - min[a]) || 1) * 65535); });
  index[name] = { offset, vertices: kept.length, indices: out.length, min, max };
  chunks.push(Buffer.from(q.buffer), Buffer.from(out.buffer));
  offset += q.byteLength + out.byteLength;
  before += indices.length / 3; after += out.length / 3;
}
fs.writeFileSync(path.join(dir, 'meshes.bin'), Buffer.concat(chunks));
fs.writeFileSync(path.join(dir, 'meshes.json'), JSON.stringify({ format: 'uint16 positions (x, y, z scaled to [min, max]) then uint16 triangle indices, per mesh, little-endian', meshes: index }));
console.log(`${list.length} meshes, ${before} -> ${after} triangles, ${(offset / 1024).toFixed(0)} KiB`);
