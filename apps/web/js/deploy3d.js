// Deploy workspace, 3D: the scan, the robot's live view, goals, rehearsals and readiness anchors in one scene frame.
//
// Frames (docs/DEPLOY.md, Frames): the scene is the scan robot frame (the robot at scan time at [0, 0, 0], x ahead).
// The scan memory arrives in memory_S and is drawn through scene_from_memory; the live node view arrives in the
// robot's odometry frame and is drawn through align.scene_from_odom. Until an align exists, the live layers are drawn
// alone in the robot's own frame and every scene-frame layer is hidden (never two unregistered frames overlaid).
//
// Cost rules (docs/DEPLOY.md, 3D): Deploy owns its own group; memory is one InstancedMesh per class, rebuilt only when
// memory.seq changes; the floor is one DataTexture; points live in a ring of 8 preallocated buffers whose fade steps at
// the data rate; no shadows, pixel ratio 1, 30 fps; rendering happens on new data or camera input only.
import * as THREE from 'three';
import { view, markDirty, buildRobot, pose, makeLabel, polyline, setPolyline, disposeGroup } from './scene.js';
import { SERIES, UI, hex } from './palette.js';

const C = Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [k, hex(v)]));
// Deploy colours: warm columns are what blocks the robot, violet slabs are overhead, cool points are the lidar, teal is
// the route, amber the goal. One meaning per colour, as everywhere in Studio.
export const COLORS = {
  floor: [214, 230, 237], step: 0xf2c25c, obstacleLow: 0xf09a52, obstacleHigh: 0xa9503f, overhead: 0x9d7cc9, overheadLow: 0x6f47bd,
  pointLow: 0x8fb8e8, pointHigh: 0x1f4fa8, pointFloor: 0xc3cdd6, selfFiltered: 0xb9c2cb, rearBlind: 0xc6b2e6,
  route: C.travelled, goal: C.goal, gap: 0x2f74d0, block: C.red, pass: C.green, warn: 0xe0a030, pending: hex(UI.faint),
  exact: 0x3d6fb5, drift: 0xc2408f, offset: 0x7d8794, plan: C.future, scanGhost: 0x55657a, lost: 0x9aa3ad, walked: 0x2a333d,
  // The planner's own live route: dashed ink, never the teal of Studio's route check (two different computations).
  liveRoute: 0x1b2530,
};
export const STEP_OVER_M = 0.25, FLOOR_M = 0.05, HEAD_CLEAR_M = 1.35, ROBOT_DISC_M = 0.30, ROUTE_MARGIN_M = 0.35;
const RING = 8, RING_CAP = 6000, FADE_S = 1.5;
const up = new THREE.Vector3(0, 0, 1);

// ------------------------------------------------------------------------------------------------ frames
export const frames = {
  apply(p, xy) { const c = Math.cos(p[2]), s = Math.sin(p[2]); return [p[0] + c * xy[0] - s * xy[1], p[1] + s * xy[0] + c * xy[1]]; },
  inverse(p) { const c = Math.cos(p[2]), s = Math.sin(p[2]); return [-(c * p[0] + s * p[1]), -(-s * p[0] + c * p[1]), -p[2]]; },
  compose(a, b) { const [x, y] = frames.apply(a, b); return [x, y, a[2] + b[2]]; },
  yawOf(q) { return Math.atan2(2 * (q[0] * q[3] + q[1] * q[2]), 1 - 2 * (q[2] * q[2] + q[3] * q[3])); },
};
const IDENTITY = [0, 0, 0];
function setFrame(group, p) { group.position.set(p[0], p[1], 0); group.rotation.set(0, 0, p[2]); group.updateMatrixWorld(true); }

// ------------------------------------------------------------------------------------------------ decoding
export function b64bytes(b64) {
  const bin = atob(b64 ?? ''), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
// §2 memory: cell (i, j) is centred at lo + (i, j) res, flat index i * ny + j ("C, first index x").
export function decodeMemory(m) {
  if (!m?.support_b64) return null;
  const [nx, ny] = m.n;
  return { seq: m.seq, epoch: m.epoch ?? 0, lo: m.lo, res: m.res, nx, ny, support: b64bytes(m.support_b64),
    ceiling: m.ceiling_b64 ? b64bytes(m.ceiling_b64) : null, near: m.near_b64 ? b64bytes(m.near_b64) : null };
}
export function decodeCloud(c) {
  if (!c?.points_b64) return null;
  const raw = b64bytes(c.points_b64), n = Math.floor(raw.length / 6), dv = new DataView(raw.buffer), o = c.origin ?? [0, 0, 0];
  const xyz = new Float32Array(n * 3);
  for (let k = 0; k < n; k++) {
    xyz[k * 3] = o[0] + dv.getInt16(k * 6, true) / 100;
    xyz[k * 3 + 1] = o[1] + dv.getInt16(k * 6 + 2, true) / 100;
    xyz[k * 3 + 2] = o[2] + dv.getInt16(k * 6 + 4, true) / 100;
  }
  const cls = c.class_b64 ? b64bytes(c.class_b64) : new Uint8Array(n);
  return { n, xyz, cls };
}
export const heightOf = code => (code === 255 ? null : code * 0.02);

// A memory with its frame (scene_from_grid), so scene points can be looked up in it.
export function memoryLookup(mem, sceneFromGrid) {
  const gridFromScene = frames.inverse(sceneFromGrid);
  const cell = xy => {
    const [gx, gy] = frames.apply(gridFromScene, xy);
    const i = Math.round((gx - mem.lo[0]) / mem.res), j = Math.round((gy - mem.lo[1]) / mem.res);
    return i < 0 || j < 0 || i >= mem.nx || j >= mem.ny ? null : { i, j, k: i * mem.ny + j };
  };
  return { mem, sceneFromGrid, gridFromScene, cell };
}

// The quick client-side check under a hover disc: the cells within the robot's disc. Server goal_check is the gate.
export function quickCheck(lookup, xy, radius = ROBOT_DISC_M) {
  if (!lookup) return { status: 'pending', text: 'No map yet' };
  const { mem } = lookup, centre = lookup.cell(xy);
  if (!centre) return { status: 'block', text: 'Outside the robot\'s map' };
  const r = Math.ceil(radius / mem.res);
  let total = 0, unseen = 0, step = 0, tall = 0, tallH = 0, low = 0;
  for (let di = -r; di <= r; di++) for (let dj = -r; dj <= r; dj++) {
    if ((di * di + dj * dj) * mem.res * mem.res > radius * radius) continue;
    const i = centre.i + di, j = centre.j + dj;
    if (i < 0 || j < 0 || i >= mem.nx || j >= mem.ny) { unseen++; total++; continue; }
    const k = i * mem.ny + j, h = heightOf(mem.support[k]); total++;
    if (h === null) unseen++;
    else if (h >= STEP_OVER_M) { tall++; tallH = Math.max(tallH, h); }
    else if (h >= FLOOR_M) step++;
    const c = mem.ceiling ? heightOf(mem.ceiling[k]) : null;
    if (c !== null && c < HEAD_CLEAR_M) low++;
  }
  if (tall) return { status: 'block', text: `An obstacle ${tallH.toFixed(2)} m high is under the robot's disc` };
  if (low) return { status: 'warn', text: 'Something overhead below head height here' };
  if (unseen / total > 0.5) return { status: 'warn', text: 'The robot has not seen most of this floor' };
  if (step) return { status: 'warn', text: 'A step-over height object is under the disc' };
  return { status: 'pass', text: 'Floor seen and clear under the robot\'s disc' };
}

// ------------------------------------------------------------------------------------------------ cutaway
// Columns nearer the camera than the subject (along the view direction, minus a margin) are cut to a 0.35 m stub, as
// in an architectural cutaway: the room's walls behind the robot never hide the robot or the floor ahead of it.
export const CUT = { uCutCam: { value: new THREE.Vector2() }, uCutDir: { value: new THREE.Vector2(1, 0) }, uCutDist: { value: -1e9 }, uCutStub: { value: 0.12 } };
function cutaway(material) {
  // The column's height is clamped in the vertex shader (a closed, shorter box: no inner faces, no z-fighting), and
  // the clamped stub is drawn in a pale section colour.
  material.onBeforeCompile = shader => {
    Object.assign(shader.uniforms, CUT);
    shader.vertexShader = shader.vertexShader.replace('#include <common>', `#include <common>
        uniform vec2 uCutCam; uniform vec2 uCutDir; uniform float uCutDist; uniform float uCutStub; varying float vCut;`)
      .replace('#include <project_vertex>', `vCut = 0.0;
        #ifdef USE_INSTANCING
          vec4 cutBase = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
          float cutH = length((instanceMatrix * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
          if (dot(cutBase.xy - uCutCam, uCutDir) < uCutDist && cutH > uCutStub) { transformed.z = min(transformed.z, uCutStub / cutH); vCut = 1.0; }
        #endif
        #include <project_vertex>`);
    shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vCut;')
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        if (vCut > 0.5) gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(0.95, 0.93, 0.91), 0.78);`);
  };
  return material;
}
function updateCut() {
  const cam = view.camera.position, tgt = view.controls.target;
  const dx = tgt.x - cam.x, dy = tgt.y - cam.y, horiz = Math.hypot(dx, dy);
  if (!D.cut || horiz < 0.8 || D.mode === 'top') { CUT.uCutDist.value = -1e9; return; }
  CUT.uCutCam.value.set(cam.x, cam.y); CUT.uCutDir.value.set(dx / horiz, dy / horiz);
  CUT.uCutDist.value = horiz - 1.6;
}

// ------------------------------------------------------------------------------------------------ memory layer
// One floor DataTexture, one InstancedMesh per class (step-over, obstacle) and one for overhead slabs.
const unitBox = new THREE.BoxGeometry(1, 1, 1).translate(0, 0, 0.5);
class MemoryLayer {
  constructor(name) {
    this.group = new THREE.Group(); this.group.name = name;
    this.key = null; this.style = 'solid';
    this.mats = {
      step: cutaway(new THREE.MeshLambertMaterial({ color: 0xffffff })),
      obstacle: cutaway(new THREE.MeshLambertMaterial({ color: 0xffffff })),
      overhead: new THREE.MeshLambertMaterial({ color: 0xffffff, transparent: true, opacity: 0.62, depthWrite: false }),
    };
    this.meshes = {};
    this.floor = null;
  }
  ensure(kind, count) {
    let m = this.meshes[kind];
    if (!m || m.userData.capacity < count) {
      if (m) { this.group.remove(m); m.dispose(); }
      const cap = Math.max(256, Math.ceil(count * 1.3));
      m = new THREE.InstancedMesh(unitBox, this.mats[kind], cap);
      m.userData.capacity = cap; m.name = `${this.group.name}-${kind}`;
      m.frustumCulled = false; m.renderOrder = kind === 'overhead' ? 3 : 0;
      m.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      this.meshes[kind] = m; this.group.add(m);
    }
    m.count = count;
    return m;
  }
  set(mem) {
    if (!mem) { this.group.visible = false; this.key = null; return; }
    const key = `${mem.seq}:${mem.epoch}:${mem.nx}:${mem.lo}`;
    this.group.visible = true;
    if (key === this.key) return;
    this.key = key; this.mem = mem;
    const { nx, ny, res, lo, support, ceiling } = mem, n = nx * ny;
    // Floor texture: seen floor tinted, never-seen transparent (the white floor shows through).
    if (!this.floor || this.floor.userData.nx !== nx || this.floor.userData.ny !== ny) {
      if (this.floor) { this.group.remove(this.floor); this.floor.material.map.dispose(); this.floor.material.dispose(); this.floor.geometry.dispose(); }
      const tex = new THREE.DataTexture(new Uint8Array(nx * ny * 4), nx, ny, THREE.RGBAFormat);
      tex.magFilter = THREE.NearestFilter; tex.minFilter = THREE.LinearFilter; tex.colorSpace = THREE.SRGBColorSpace;
      this.floor = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false }));
      this.floor.userData = { nx, ny }; this.floor.renderOrder = 1; this.floor.name = `${this.group.name}-floor`;
      this.group.add(this.floor);
    }
    const data = this.floor.material.map.image.data, near = mem.near;
    let steps = 0, obstacles = 0, overheads = 0, nearCount = 0;
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = i * ny + j, code = support[k], t = (j * nx + i) * 4;  // texel row j along +y, column i along +x
      if (code === 255) { data[t + 3] = 0; continue; }
      const h = code * 0.02;
      if (near && near[k]) { data[t] = 212; data[t + 1] = 172; data[t + 2] = 186; data[t + 3] = 255; nearCount++; }   // near-body returns (ignored): pink-grey
      else { data[t] = COLORS.floor[0]; data[t + 1] = COLORS.floor[1]; data[t + 2] = COLORS.floor[2]; data[t + 3] = 235; }
      if (h >= STEP_OVER_M) obstacles++; else if (h >= FLOOR_M) steps++;
      if (ceiling && ceiling[k] !== 255) overheads++;
    }
    this.floor.material.map.needsUpdate = true;
    this.floor.scale.set(nx * res, ny * res, 1);
    this.floor.position.set(lo[0] + (nx - 1) * res / 2, lo[1] + (ny - 1) * res / 2, 0.004);
    const ms = this.ensure('step', steps), mo = this.ensure('obstacle', obstacles), mc = this.ensure('overhead', overheads);
    const m4 = new THREE.Matrix4(), col = new THREE.Color(), lowC = new THREE.Color(COLORS.obstacleLow), highC = new THREE.Color(COLORS.obstacleHigh);
    const stepC = new THREE.Color(COLORS.step), ohC = new THREE.Color(COLORS.overhead), ohLowC = new THREE.Color(COLORS.overheadLow);
    let a = 0, b = 0, c = 0; const side = res;   // no gaps: a wall reads as one block
    for (let i = 0; i < nx; i++) for (let j = 0; j < ny; j++) {
      const k = i * ny + j, code = support[k], x = lo[0] + i * res, y = lo[1] + j * res;
      if (code !== 255) {
        const h = code * 0.02;
        if (h >= STEP_OVER_M) {
          m4.makeScale(side, side, h).setPosition(x, y, 0); mo.setMatrixAt(b, m4);
          col.copy(lowC).lerp(highC, Math.min(1, Math.max(0, (h - STEP_OVER_M) / 1.5))); mo.setColorAt(b++, col);
        } else if (h >= FLOOR_M) {
          m4.makeScale(side, side, Math.max(0.03, h)).setPosition(x, y, 0); ms.setMatrixAt(a, m4); ms.setColorAt(a++, stepC);
        }
      }
      if (ceiling && ceiling[k] !== 255) {
        const z = ceiling[k] * 0.02;
        m4.makeScale(side, side, 0.035).setPosition(x, y, z); mc.setMatrixAt(c, m4);
        mc.setColorAt(c++, z < HEAD_CLEAR_M ? ohLowC : ohC);
      }
    }
    for (const m of [ms, mo, mc]) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    this.counts = { steps, obstacles, overheads, near: nearCount };
    this.applyStyle();
  }
  // 'ghost': the scan under a live map, quiet grey so the two never read as one.
  setStyle(style) { if (style !== this.style) { this.style = style; this.applyStyle(); } }
  applyStyle() {
    const ghost = this.style === 'ghost';
    for (const [k, m] of Object.entries(this.mats)) {
      m.transparent = ghost || k === 'overhead'; m.opacity = ghost ? 0.16 : k === 'overhead' ? 0.62 : 1; m.depthWrite = !m.transparent;
      m.color.set(ghost ? 0x8a96a3 : 0xffffff); m.needsUpdate = true;
    }
    if (this.floor) this.floor.material.opacity = ghost ? 0.35 : 1;
  }
  bounds(sceneFromGrid) {
    // The seen cells' extent in the scene (for framing).
    const mem = this.mem; if (!mem) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < mem.nx; i += 2) for (let j = 0; j < mem.ny; j += 2) {
      if (mem.support[i * mem.ny + j] === 255) continue;
      const [x, y] = frames.apply(sceneFromGrid, [mem.lo[0] + i * mem.res, mem.lo[1] + j * mem.res]);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    return Number.isFinite(x0) ? [x0, y0, x1, y1] : null;
  }
}

// ------------------------------------------------------------------------------------------------ point ring
class PointRing {
  constructor() {
    this.group = new THREE.Group(); this.group.name = 'lidar';
    this.items = Array.from({ length: RING }, () => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(RING_CAP * 3), 3));
      g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(RING_CAP * 3), 3));
      g.setDrawRange(0, 0);
      const p = new THREE.Points(g, new THREE.PointsMaterial({ size: 0.04, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false, sizeAttenuation: true }));
      p.frustumCulled = false; p.visible = false; p.renderOrder = 4; p.userData.t = -Infinity;
      this.group.add(p); return p;
    });
    this.next = 0; this.source = null;
    this.c = { low: new THREE.Color(COLORS.pointLow), high: new THREE.Color(COLORS.pointHigh), floor: new THREE.Color(COLORS.pointFloor),
      self: new THREE.Color(COLORS.selfFiltered), rear: new THREE.Color(COLORS.rearBlind), tmp: new THREE.Color() };
    this.counts = [0, 0, 0];
  }
  clear() { for (const p of this.items) { p.visible = false; p.userData.t = -Infinity; p.geometry.setDrawRange(0, 0); } this.key = null; markDirty(); }
  push(cloud, now, source) {
    if (source !== this.source) { this.clear(); this.source = source; }
    const p = this.items[this.next]; this.next = (this.next + 1) % RING;
    const pos = p.geometry.getAttribute('position'), colA = p.geometry.getAttribute('color'), n = Math.min(cloud.n, RING_CAP);
    const { low, high, floor, self, rear, tmp } = this.c; const counts = [0, 0, 0];
    for (let k = 0; k < n; k++) {
      const z = cloud.xyz[k * 3 + 2], cls = cloud.cls[k] ?? 0;
      pos.array[k * 3] = cloud.xyz[k * 3]; pos.array[k * 3 + 1] = cloud.xyz[k * 3 + 1]; pos.array[k * 3 + 2] = z;
      counts[Math.min(2, cls)]++;
      if (cls === 1) tmp.copy(self); else if (cls === 2) tmp.copy(rear);
      else if (z < 0.06) tmp.copy(floor); else tmp.copy(low).lerp(high, Math.min(1, z / 2.0));
      colA.array[k * 3] = tmp.r; colA.array[k * 3 + 1] = tmp.g; colA.array[k * 3 + 2] = tmp.b;
    }
    pos.needsUpdate = true; colA.needsUpdate = true; p.geometry.setDrawRange(0, n);
    p.userData.t = now; this.counts = counts; this.key = null;
    this.step(now);
  }
  // The fade steps once per data arrival (and once more when the stream stops): never a per-frame animation.
  step(now) {
    const live = this.items.filter(p => now - p.userData.t <= FADE_S * 1000).sort((a, b) => b.userData.t - a.userData.t);
    const key = live.map(p => p.id).join(',');
    if (key === this.key) return live.length;   // nothing expired and nothing arrived: no render
    this.key = key;
    for (const p of this.items) p.visible = false;
    live.forEach((p, rank) => { p.visible = true; p.material.opacity = Math.max(0.12, 0.92 * Math.pow(0.72, rank)); });
    markDirty();
    return live.length;
  }
}

// ------------------------------------------------------------------------------------------------ module state
const D = {
  root: null, scanGroup: null, liveGroup: null, cloudGroup: null, goalGroup: null, hoverGroup: null, rehearsalGroup: null,
  anchorGroup: null, labelGroup: null,
  scanMem: new MemoryLayer('scan-memory'), liveMem: new MemoryLayer('live-memory'), ring: new PointRing(),
  spec: null, modelNames: null, robots: {}, building: {}, saved: null, active: false,
  scanFrame: IDENTITY, align: null, aligned: false, liveOdomPose: null, liveScenePose: null,
  layers: { scan: true, live: true, lidar: true, twin: false, robot: true, rehearsal: true, checks: true, scanUnder: false },
  context: { step: 'connect', tracksShown: false },
  insets: { left: 0, right: 0, top: 0, bottom: 0 }, mode: 'orbit', tween: null, followAt: null, cut: true,
  twin: null, lost: false, lastSeenText: null, rehearsal: null, anchors: [], highlight: null,
};
export const d3 = D;

export function init() {
  if (D.root) return;
  D.root = new THREE.Group(); D.root.name = 'deploy'; D.root.visible = false;
  D.scanGroup = new THREE.Group(); D.scanGroup.name = 'scan';          // memory_S: scene_from_memory
  D.liveGroup = new THREE.Group(); D.liveGroup.name = 'live';          // odom: scene_from_odom
  D.cloudGroup = new THREE.Group(); D.cloudGroup.name = 'cloud';       // follows its source's frame
  D.goalGroup = new THREE.Group(); D.goalGroup.name = 'goal';          // scene
  D.hoverGroup = new THREE.Group(); D.hoverGroup.name = 'hover';       // scene
  D.rehearsalGroup = new THREE.Group(); D.rehearsalGroup.name = 'rehearsal';  // scene
  D.anchorGroup = new THREE.Group(); D.anchorGroup.name = 'anchors';   // scene
  D.robotAnchors = new THREE.Group(); D.robotAnchors.name = 'robot-anchors';  // the robot's frame, posed with it
  D.sceneOnly = new THREE.Group(); D.sceneOnly.name = 'scene-frame';   // everything that needs the scene frame
  D.twinGroup = new THREE.Group(); D.twinGroup.name = 'twin'; D.twinGroup.visible = false;  // memory_S
  D.scanGroup.add(D.scanMem.group, D.twinGroup);
  D.liveGroup.add(D.liveMem.group);
  D.cloudGroup.add(D.ring.group);
  D.sceneOnly.add(D.scanGroup, D.goalGroup, D.hoverGroup, D.rehearsalGroup, D.anchorGroup);
  D.root.add(D.sceneOnly, D.liveGroup, D.cloudGroup, D.robotAnchors);
  // Live overlays in the odom frame: route, plan path, node goal.
  D.lines = { route: polyline(COLORS.liveRoute, 0.9, 512), plan: polyline(COLORS.plan, 1, 256) };
  D.lines.route.material = new THREE.LineDashedMaterial({ color: COLORS.liveRoute, dashSize: 0.12, gapSize: 0.07, transparent: true, opacity: 0.9 });
  D.lines.route.name = 'planner-route'; D.lines.plan.name = 'plan-path';
  D.liveGroup.add(D.lines.route, D.lines.plan);
  view.scene.add(D.root);
  window.addEventListener('resize', () => D.active && applyViewOffset());
  new ResizeObserver(() => D.active && applyViewOffset()).observe(view.host);
}

// Deploy takes the scene: Replay's content, the arena preview, Navigate's overlay and the comparison hide; the render
// rules for Deploy apply (pixel ratio 1, 30 fps, no shadow-map updates).
export function enter() {
  init();
  if (D.active) return;
  D.active = true;
  const hide = [view.content, view.sensorLayer, view.compareGroup, view.arenaGroup, view.navGroup, view.navMap, view.worldAxes].filter(Boolean);
  D.saved = { visible: hide.map(o => [o, o.visible]), floor: view.floor.position.clone(), mode: view.camera_mode,
    camera: view.camera.position.clone(), target: view.controls.target.clone(), rotate: view.controls.enableRotate,
    pixelRatio: view.renderer.getPixelRatio(), robotView: view.robotView };
  hide.forEach(o => { o.visible = false; });
  view.robotView = false;
  view.camera_mode = 'deploy';
  view.floor.position.set(0, 0, view.floor.position.z);
  view.renderer.setPixelRatio(1);
  view.renderer.shadowMap.needsUpdate = true;   // once: the shadow map loses Replay's robot; Deploy casts none
  view.minFrameMs = 33;
  view.beforeRender = beforeRender;
  D.root.visible = true;
  applyViewOffset();
  markDirty();
}
export function leave() {
  if (!D.active) return;
  D.active = false;
  D.root.visible = false;
  for (const [o, v] of D.saved.visible) o.visible = v;
  view.floor.position.copy(D.saved.floor);
  view.renderer.setPixelRatio(D.saved.pixelRatio);
  view.minFrameMs = 0; view.beforeRender = null; D.tween = null;
  view.camera.clearViewOffset();
  const { width, height } = view.host.getBoundingClientRect();
  if (width > 1 && height > 1) view.camera.aspect = width / height;
  view.camera.updateProjectionMatrix();
  view.camera.position.copy(D.saved.camera); view.controls.target.copy(D.saved.target); view.controls.enableRotate = D.saved.rotate;
  view.camera_mode = D.saved.mode; view.robotView = D.saved.robotView;
  view.renderer.shadowMap.needsUpdate = true;
  view.controls.update(); markDirty();
}

// ------------------------------------------------------------------------------------------------ robots
const ROBOT_STYLE = {
  live: null,
  scanGhost: { opacity: 0.2, color: COLORS.scanGhost }, scanPose: null,
  exact: { opacity: 0.5, color: COLORS.exact }, drift: { opacity: 0.28, color: COLORS.drift }, offset: { opacity: 0.28, color: COLORS.offset },
  plan1: { opacity: 0.16, color: COLORS.plan }, plan2: { opacity: 0.09, color: COLORS.plan }, rehearsalLive: { opacity: 0.45, color: COLORS.exact },
};
export function setModel(spec) {
  if (!spec?.root || D.spec) return;
  D.spec = spec; D.modelNames = spec.joint_names ?? [];
}
export const hasModel = () => !!D.spec;
async function robot(role, parent) {
  if (D.robots[role]) return D.robots[role];
  if (!D.spec) return null;
  if (!D.building[role]) {
    D.building[role] = buildRobot(D.spec, D.modelNames, ROBOT_STYLE[role]).then(r => {
      r.root.traverse(o => { if (o.isMesh) { o.castShadow = false; o.receiveShadow = false; } });
      r.root.name = `robot-${role}`; r.root.visible = false;
      D.robots[role] = r; parent.add(r.root); markDirty();
      return r;
    }).catch(error => { console.warn('robot build failed', error); return null; });
  }
  return D.building[role];
}
const remapCache = new Map();
function jointsInModelOrder(names, qpos) {
  const key = names?.join(',') ?? '';
  let map = remapCache.get(key);
  if (!map) { map = (D.modelNames ?? []).map(n => names?.indexOf(n) ?? -1); remapCache.set(key, map); }
  return map.map(i => (i >= 0 ? qpos[7 + i] : null));
}
function poseRobot(r, qpos, names) {
  if (!r || !Array.isArray(qpos) || qpos.length < 7 || qpos.slice(0, 7).some(v => !Number.isFinite(v))) return false;
  pose(r, {}, { position: qpos.slice(0, 3), quaternion_wxyz: qpos.slice(3, 7), joints: jointsInModelOrder(names, qpos) });
  return true;
}
function show(role, visible) { const r = D.robots[role]; if (r) r.root.visible = visible; }
// The standing pose for ghosts with no joints of their own (the scan pose before any data).
let standJoints = null, standNames = null;
function standQpos(x = 0, y = 0, yaw = 0) {
  const q = [x, y, 0.78, Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
  return standJoints ? q.concat(standJoints) : q.concat(new Array(29).fill(0));
}

// ------------------------------------------------------------------------------------------------ labels
function tag(text, color, at, group) {
  const s = makeLabel(text, color, { raw: true }); s.position.set(at[0], at[1], at[2] ?? 1.75); s.center.set(0.5, 0); group.add(s); return s;
}
function disposeLabel(s) { if (!s) return; s.material.map?.dispose(); s.material.dispose(); s.parent?.remove(s); }

// ------------------------------------------------------------------------------------------------ the scan
// scene: {start_S, scene_from_memory, memory, twin}. Drawn in the scan robot frame through scene_from_memory.
export function setScanScene(scene) {
  init();
  if (!scene) { D.scanMem.set(null); D.scanLookup = null; D.scanName = null; disposeGroup(D.twinGroup); markDirty(); return; }
  const sceneFromMemory = scene.scene_from_memory ?? frames.inverse(scene.start_S ?? IDENTITY);
  D.scanFrame = sceneFromMemory;
  setFrame(D.scanGroup, sceneFromMemory);
  const mem = decodeMemory(scene.memory);
  D.scanMem.set(mem);
  D.scanLookup = mem ? memoryLookup(mem, sceneFromMemory) : null;
  if (D.scanName !== scene.name) {
    D.scanName = scene.name;
    disposeGroup(D.twinGroup);
    const mat = new THREE.MeshBasicMaterial({ color: 0x6f7f8e, transparent: true, opacity: 0.1, depthWrite: false });
    const edge = new THREE.LineBasicMaterial({ color: 0x6f7f8e, transparent: true, opacity: 0.45 });
    for (const b of (scene.twin ?? []).slice(0, 4000)) {
      const h = b.z_top - b.z_bottom; if (!(h > 0)) continue;
      const g = new THREE.BoxGeometry(b.half_xy[0] * 2, b.half_xy[1] * 2, h);
      const m = new THREE.Mesh(g, mat); m.position.set(b.center_xy[0], b.center_xy[1], b.z_bottom + h / 2); m.rotation.z = b.yaw ?? 0;
      m.add(new THREE.LineSegments(new THREE.EdgesGeometry(g), edge)); D.twinGroup.add(m);
    }
  }
  D.twinGroup.visible = D.layers.twin;
  applyVisibility(); markDirty();
}
export const scanLookup = () => D.scanLookup;
export const scanCounts = () => D.scanMem.counts ?? null;

// A scan running: points in scene, memory in memory_S, the robot posed from its measured joints in scene.
export async function setScanLive(live, now = performance.now()) {
  init();
  if (!live?.running) return;
  const sceneFromMemory = frames.inverse(live.start_S ?? IDENTITY);
  setFrame(D.scanGroup, sceneFromMemory); D.scanFrame = sceneFromMemory;
  const mem = decodeMemory(live.memory);
  if (mem) { D.scanMem.set(mem); D.scanLookup = memoryLookup(mem, sceneFromMemory); }
  const cloud = decodeCloud(live.cloud);
  setFrame(D.cloudGroup, IDENTITY);
  if (cloud) D.ring.push(cloud, now, 'scan');
  if (Array.isArray(live.qpos)) {
    standJoints = live.qpos.slice(7); standNames = live.joint_names;
    const r = await robot('scanPose', D.sceneOnly);
    if (poseRobot(r, live.qpos, live.joint_names)) { r.root.visible = D.layers.robot; D.scanPosePosed = true; }
  }
  markDirty();
}

// ------------------------------------------------------------------------------------------------ the live view
// view: §2 node view (odom) + align. Returns what the UI needs to say about it.
export async function setLive(v, { now = performance.now(), slot = 'robot', hideRobot = false, label = null } = {}) {
  init();
  if (!v?.ok) return null;
  const align = v.align?.scene_from_odom ? v.align : null;
  D.align = align; D.aligned = !!align;
  setFrame(D.liveGroup, align ? align.scene_from_odom : IDENTITY);
  const mem = decodeMemory(v.memory);
  if (mem) { D.liveMem.set(mem); D.liveLookup = memoryLookup(mem, align ? align.scene_from_odom : IDENTITY); D.liveMemData = mem; }
  else if (D.liveLookup) D.liveLookup = memoryLookup(D.liveLookup.mem, align ? align.scene_from_odom : IDENTITY);
  const cloud = decodeCloud(v.cloud);
  setFrame(D.cloudGroup, align ? align.scene_from_odom : IDENTITY);
  if (cloud) D.ring.push(cloud, now, `live:${slot}`);
  if (Array.isArray(v.joint_names) && Array.isArray(v.qpos)) { standJoints ??= v.qpos.slice(7); standNames ??= v.joint_names; }
  const role = slot === 'sim-rehearsal' ? 'rehearsalLive' : 'live';
  const r = await robot(role, D.liveGroup);
  if (r && poseRobot(r, v.qpos, v.joint_names)) {
    r.root.visible = D.layers.robot && !hideRobot;
    const q = v.qpos; D.liveOdomPose = [q[0], q[1], frames.yawOf(q.slice(3, 7))];
    D.liveScenePose = align ? frames.compose(align.scene_from_odom, D.liveOdomPose) : D.liveOdomPose;
    D.liveRole = role;
    if (role === 'live') { setFrame(D.robotAnchors, D.liveScenePose); if (align) extendTrail(D.liveScenePose); }
  }
  if (role === 'live') show('rehearsalLive', false); else show('live', false);
  // Plan futures: 2 ghosts + the plan path; the node's route; the node's goal.
  const plan = v.plan, frames2 = plan?.frames ?? [];
  for (const [i, name] of [[0, 'plan1'], [1, 'plan2']]) {
    const g = await robot(name, D.liveGroup);
    if (g) g.root.visible = D.layers.robot && !hideRobot && !!frames2[i] && poseRobot(g, frames2[i], v.joint_names);
  }
  setPolyline(D.lines.plan, (plan?.path ?? []).map(p => [p[0], p[1], 0.03]), 0.03);
  setPolyline(D.lines.route, (v.route ?? []).map(p => [p[0], p[1], 0.04]), 0.04);
  D.lines.route.computeLineDistances();
  D.lines.plan.visible = !!plan?.path?.length && !hideRobot; D.lines.route.visible = !!v.route?.length && !hideRobot;
  disposeLabel(D.liveLabel); D.liveLabel = null;
  if (label && D.liveOdomPose) D.liveLabel = tag(label, COLORS.exact, [D.liveOdomPose[0], D.liveOdomPose[1], 1.62], D.liveGroup);
  applyVisibility(); setLost(D.lost);
  if (D.mode === 'follow') followRobot();
  markDirty();
  return { aligned: D.aligned, scenePose: D.liveScenePose };
}
// The path the live robot walked, in the scene (only while aligned): a band behind it, kept for Review.
function extendTrail(p) {
  const pts = D.trailPts ??= [], last = pts.at(-1);
  if (last && Math.hypot(p[0] - last[0], p[1] - last[1]) < 0.03) return;
  pts.push([p[0], p[1]]); if (pts.length > 4000) pts.shift();
  if (pts.length < 2) return;
  if (D.trail) { D.sceneOnly.remove(D.trail); D.trail.geometry.dispose(); D.trail.material.dispose(); }
  D.trail = ribbon(pts, 0.022, COLORS.walked, 0.8, 0.034); D.trail.name = 'walked'; D.sceneOnly.add(D.trail);
}
export function clearTrail() {
  D.trailPts = [];
  if (D.trail) { D.sceneOnly.remove(D.trail); D.trail.geometry.dispose(); D.trail.material.dispose(); D.trail = null; markDirty(); }
}
export function clearLive() {
  init();
  setFrame(D.robotAnchors, IDENTITY);
  D.liveMem.set(null); D.liveLookup = null; D.liveOdomPose = null; D.liveScenePose = null; D.align = null; D.aligned = false;
  for (const role of ['live', 'plan1', 'plan2', 'rehearsalLive']) show(role, false);
  D.lines.plan.visible = D.lines.route.visible = false;
  disposeLabel(D.liveLabel); D.liveLabel = null;
  if (D.ring.source?.startsWith('live')) D.ring.clear();
  setLost(false); applyVisibility(); markDirty();
}
export function stepFade(now = performance.now()) { return D.ring.step(now); }
export const pointCounts = () => D.ring.counts;
export const hasTrail = () => (D.trailPts?.length ?? 0) > 1;
export const liveScenePose = () => D.liveScenePose;
export const isAligned = () => D.aligned;
export const liveCounts = () => D.liveMem.counts ?? null;

// LIVE VIEW LOST: the robot greyed and frozen where it was last seen, with its age at the robot.
const lostMaterial = new THREE.MeshStandardMaterial({ color: 0x3a4553, transparent: true, opacity: 0.8, roughness: 0.85 });
export function setLost(lost, ageS = null) {
  init();
  D.lost = lost;
  const r = D.robots.live;
  if (r) r.root.traverse(o => {
    if (!o.isMesh) return;
    if (lost) { o.userData.material ??= o.material; o.material = lostMaterial; }
    else if (o.userData.material) { o.material = o.userData.material; o.userData.material = null; }
  });
  for (const role of ['plan1', 'plan2']) if (lost) show(role, false);
  const text = lost && ageS !== null ? `Last seen ${Math.round(ageS)} s ago` : null;
  if (text !== D.lastSeenText) {
    D.lastSeenText = text; disposeLabel(D.lostLabel); D.lostLabel = null;
    if (text && D.liveOdomPose) D.lostLabel = tag(text, C.red, [D.liveOdomPose[0], D.liveOdomPose[1], 1.62], D.liveGroup);
  }
  if (lost && !D.lostRing && D.liveOdomPose) {
    D.lostRing = new THREE.Group();
    D.lostRing.add(flatRing(0.42, 0.5, C.red, 0.9, 0.03), flatDisc(0.42, C.red, 0.12, 0.028));
    D.lostRing.position.set(D.liveOdomPose[0], D.liveOdomPose[1], 0); D.liveGroup.add(D.lostRing);
  } else if (!lost && D.lostRing) { disposeGroup(D.lostRing); D.liveGroup.remove(D.lostRing); D.lostRing = null; }
  markDirty();
}

// ------------------------------------------------------------------------------------------------ goal
function flatRing(r0, r1, color, opacity, z = 0.02) {
  const m = new THREE.Mesh(new THREE.RingGeometry(r0, r1, 64), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  m.position.z = z; m.renderOrder = 5; return m;
}
function flatDisc(r, color, opacity, z = 0.018) {
  const m = new THREE.Mesh(new THREE.CircleGeometry(r, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  m.position.z = z; m.renderOrder = 5; return m;
}
const STATUS_COLOR = { pass: COLORS.pass, warn: COLORS.warn, block: COLORS.block, pending: COLORS.pending };
// The hover disc: where the goal would go, coloured by the quick check of the cells under it.
export function setHover(h) {
  init();
  disposeGroup(D.hoverGroup);
  if (h?.xy) {
    const col = STATUS_COLOR[h.status] ?? COLORS.pending, g = new THREE.Group();
    g.add(flatDisc(ROBOT_DISC_M, col, 0.22, 0.03), flatRing(ROBOT_DISC_M - 0.025, ROBOT_DISC_M, col, 0.95, 0.032));
    if (h.columnTop) {  // the ray hit an obstacle: show its top, and the floor cell under it
      const top = flatRing(0.04, 0.07, col, 0.9, h.columnTop + 0.01); g.add(top);
      const pole = polyline(col, 0.8, 2); setPolyline(pole, [[0, 0, 0.03], [0, 0, h.columnTop]]); g.add(pole);
    }
    g.position.set(h.xy[0], h.xy[1], 0); D.hoverGroup.add(g);
  }
  markDirty();
}

function ribbon(path, half, color, opacity, z = 0.012) {
  // A flat strip of half-width `half` along the path (the route margin the planner keeps).
  const pos = [], idx = [];
  for (let k = 0; k < path.length; k++) {
    const a = path[Math.max(0, k - 1)], b = path[Math.min(path.length - 1, k + 1)];
    let dx = b[0] - a[0], dy = b[1] - a[1]; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    pos.push(path[k][0] - dy * half, path[k][1] + dx * half, z, path[k][0] + dy * half, path[k][1] - dx * half, z);
    if (k) { const o = (k - 1) * 2; idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); }
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3)); g.setIndex(idx);
  const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false }));
  m.renderOrder = 2; return m;
}
// The checked goal: disc, route with its margin (unseen parts grey), gap gates, blocking cells.
export function setGoal(goal) {
  init();
  disposeGroup(D.goalGroup);
  D.goal = goal;
  if (!goal?.xy) { markDirty(); return; }
  const status = goal.status ?? 'pending', col = status === 'block' ? COLORS.block : status === 'pending' ? COLORS.pending : status === 'pass' ? COLORS.pass : COLORS.goal;
  const g = new THREE.Group(); g.position.set(goal.xy[0], goal.xy[1], 0);
  g.add(flatDisc(ROBOT_DISC_M, col, 0.2), flatRing(ROBOT_DISC_M - 0.03, ROBOT_DISC_M, col, 0.95, 0.024));
  const pole = polyline(col, 0.85, 2); setPolyline(pole, [[0, 0, 0.03], [0, 0, 0.62]]); g.add(pole);
  tag(goal.label ?? 'Goal', col, [0, 0, 0.66], g).name = 'goal-label';
  D.goalGroup.add(g);
  const path = goal.path ?? [];
  if (path.length > 1) {
    D.goalGroup.add(ribbon(path, Number.isFinite(goal.margin) ? goal.margin : ROUTE_MARGIN_M, status === 'block' ? COLORS.block : COLORS.route, status === 'block' ? 0.08 : 0.15));
    // Centre band: teal where the scan saw the floor, grey where the route crosses unseen space.
    const seenC = status === 'block' ? COLORS.block : COLORS.route, unseenC = 0xa3adb8;
    let run = [path[0]], runSeen = null;
    const flush = () => { if (run.length > 1) { const band = ribbon(run, 0.022, runSeen === false ? unseenC : seenC, 0.95, 0.026); band.renderOrder = 6; D.goalGroup.add(band); } };
    for (let k = 1; k < path.length; k++) {
      const a = path[k - 1], b = path[k], mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const cell = D.scanLookup?.cell(mid), seen = !!cell && D.scanLookup.mem.support[cell.k] !== 255;
      if (runSeen !== null && seen !== runSeen) { flush(); run = [a]; }
      runSeen = seen; run.push(b);
    }
    flush();
  }
  if (goal.gap?.at_xy && goal.gap.width_m > 0) {
    // Two posts the route passes between, the gap's width apart, across the route.
    const at = [...goal.gap.at_xy]; let dir = [1, 0], best = Infinity;
    for (let k = 1; k < path.length; k++) {
      const m = [(path[k][0] + path[k - 1][0]) / 2, (path[k][1] + path[k - 1][1]) / 2], dd = Math.hypot(m[0] - at[0], m[1] - at[1]);
      if (dd < best) { best = dd; const dx = path[k][0] - path[k - 1][0], dy = path[k][1] - path[k - 1][1], L = Math.hypot(dx, dy) || 1; dir = [dx / L, dy / L]; }
    }
    let n = [-dir[1], dir[0]], w = goal.gap.width_m / 2; const gate = new THREE.Group();
    const sides = goal.gap.sides_xy;
    if (Array.isArray(sides) && sides.length === 2) {
      const dx = sides[1][0] - sides[0][0], dy = sides[1][1] - sides[0][1], L = Math.hypot(dx, dy);
      if (L > 0.05) { n = [dx / L, dy / L]; w = L / 2; at[0] = (sides[0][0] + sides[1][0]) / 2; at[1] = (sides[0][1] + sides[1][1]) / 2; }
    }
    const ok = goal.gap.width_m >= 0.6, gc = ok ? COLORS.gap : COLORS.block;
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, 1.0, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: gc }));
      post.position.set(at[0] + n[0] * w * s, at[1] + n[1] * w * s, 0.5); gate.add(post);
    }
    const bar = polyline(gc, 0.9, 2); setPolyline(bar, [[at[0] - n[0] * w, at[1] - n[1] * w, 1.0], [at[0] + n[0] * w, at[1] + n[1] * w, 1.0]]); gate.add(bar);
    const sill = polyline(gc, 0.9, 2); setPolyline(sill, [[at[0] - n[0] * w, at[1] - n[1] * w, 0.03], [at[0] + n[0] * w, at[1] + n[1] * w, 0.03]]); gate.add(sill);
    tag(`Gap ${goal.gap.width_m.toFixed(2)} m`, gc, [at[0], at[1], 1.06], gate);
    gate.name = 'gap-gate'; D.goalGroup.add(gate);
  }
  // The operator's "must pass through this gap": a gold gate between the passage's two sides.
  const pa = goal.passage?.a, pb = goal.passage?.b;
  if (Array.isArray(pa) && Array.isArray(pb)) {
    const gate = new THREE.Group(), gc = COLORS.goal;
    for (const q of [pa, pb]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.026, 0.026, 1.2, 10).rotateX(Math.PI / 2), new THREE.MeshBasicMaterial({ color: gc }));
      post.position.set(q[0], q[1], 0.6); gate.add(post);
    }
    const bar = polyline(gc, 1, 2); setPolyline(bar, [[pa[0], pa[1], 1.2], [pb[0], pb[1], 1.2]]); gate.add(bar);
    const sill = polyline(gc, 1, 2); setPolyline(sill, [[pa[0], pa[1], 0.035], [pb[0], pb[1], 0.035]]); gate.add(sill);
    // Over one post (the goal's own label floats at the middle of the route).
    tag(`Must pass · ${Number(goal.passage.width_m ?? Math.hypot(pb[0] - pa[0], pb[1] - pa[1])).toFixed(2)} m`, gc, [pa[0], pa[1], 1.34], gate);
    gate.name = 'passage-gate'; D.goalGroup.add(gate);
  }
  const blocks = goal.blocking ?? [];
  if (blocks.length) {
    const im = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: COLORS.block, transparent: true, opacity: 0.75 }), blocks.length);
    const m4 = new THREE.Matrix4();
    blocks.forEach((p, k) => { m4.makeScale(0.05, 0.05, 0.08).setPosition(p[0], p[1], 0.005); im.setMatrixAt(k, m4); });
    im.instanceMatrix.needsUpdate = true; im.renderOrder = 6; im.name = 'blocking-cells'; D.goalGroup.add(im);
  }
  markDirty();
}

// ------------------------------------------------------------------------------------------------ rehearsal
// tracks: {exact, drift, offset} -> {t, qpos, joint_names, contacts, arrived}; ghosts on one shared timeline.
export async function setRehearsal(tracks) {
  init();
  disposeGroup(D.rehearsalGroup);
  for (const k of ['exact', 'drift', 'offset']) { const r = D.robots[k]; if (r) { r.root.visible = false; } }
  D.robots.exact = D.robots.drift = D.robots.offset = null; D.building.exact = D.building.drift = D.building.offset = null;
  D.rehearsal = tracks;
  const gen = D.rehearsalGen = (D.rehearsalGen ?? 0) + 1;
  if (!tracks) { markDirty(); return 0; }
  let duration = 0;
  for (const [which, tr] of Object.entries(tracks)) {
    if (!tr?.qpos?.length) continue;
    duration = Math.max(duration, tr.t.at(-1) ?? 0);
    const pts = tr.qpos.filter((_, i) => i % 2 === 0 || i === tr.qpos.length - 1).map(q => [q[0], q[1]]);
    if (pts.length > 1) { const band = ribbon(pts, 0.035, COLORS[which], 0.9, 0.03 + 0.004 * ['exact', 'drift', 'offset'].indexOf(which)); band.name = `path-${which}`; D.rehearsalGroup.add(band); }
    const end = tr.qpos.at(-1), start = tr.qpos[0];
    const endMark = flatRing(0.06, 0.1, COLORS[which], 0.95, 0.04); endMark.position.set(end[0], end[1], 0.04); D.rehearsalGroup.add(endMark);
    if (which === 'offset') { const s = flatRing(0.18, 0.22, COLORS.offset, 0.8, 0.03); s.position.set(start[0], start[1], 0.03); D.rehearsalGroup.add(s); }
    const clusters = [];
    for (const c of tr.contacts ?? []) {
      if (!Array.isArray(c.root_xy)) continue;
      const near = clusters.find(k => Math.hypot(k.xy[0] - c.root_xy[0], k.xy[1] - c.root_xy[1]) < 0.3);
      if (near) { if ((c.n ?? 0) > near.n) { near.n = c.n ?? 0; near.xy = c.root_xy; } } else clusters.push({ xy: c.root_xy, n: c.n ?? 0 });
    }
    for (const k of clusters) {
      const sph = new THREE.Mesh(new THREE.SphereGeometry(0.07 + Math.min(0.08, k.n / 1500), 16, 12), new THREE.MeshBasicMaterial({ color: C.red, transparent: true, opacity: 0.85 }));
      sph.position.set(k.xy[0], k.xy[1], 0.5); sph.renderOrder = 7; D.rehearsalGroup.add(sph);
    }
    if (tr.contacts?.length) {
      const worst = tr.contacts.reduce((a, b) => (b.n > a.n ? b : a));
      tag(`${which} run: contact ${Math.round(worst.n)} N, at the robot`, C.red, [worst.root_xy[0], worst.root_xy[1], 1.0], D.rehearsalGroup);
    }
    await robot(which, D.rehearsalGroup);
    if (gen !== D.rehearsalGen) return 0;
  }
  let firstMove = duration;
  for (const tr of Object.values(tracks)) {
    if (!tr?.qpos?.length) continue;
    const q0 = tr.qpos[0], i = tr.qpos.findIndex(q => Math.hypot(q[0] - q0[0], q[1] - q0[1]) > 0.05);
    if (i >= 0) firstMove = Math.min(firstMove, tr.t[i] ?? duration);
  }
  D.rehearsalDuration = duration; D.rehearsalFirstMove = firstMove;
  setRehearsalTime(firstMove);
  return duration;
}
export function setRehearsalTime(t) {
  const tracks = D.rehearsal; if (!tracks) return;
  const shown = D.layers.rehearsal && D.context.step === 'rehearse';
  for (const [which, tr] of Object.entries(tracks)) {
    const r = D.robots[which]; if (!r || !tr?.qpos?.length) continue;
    let lo = 0, hi = tr.t.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (tr.t[mid] <= t) lo = mid + 1; else hi = mid; }
    const i = Math.max(0, lo - 1);
    poseRobot(r, tr.qpos[i], tr.joint_names);
    r.root.visible = shown;
  }
  markDirty();
}
export const rehearsalDuration = () => D.rehearsalDuration ?? 0;
export const rehearsalFirstMove = () => D.rehearsalFirstMove ?? 0;

// ------------------------------------------------------------------------------------------------ scan pose ghost
// The robot where it stood for the scan (scene origin) vs the robot now: the moved/turned anchor.
export async function setScanGhost(visible, moved = null) {
  init();
  const r = await robot('scanGhost', D.sceneOnly);
  if (r) { poseRobot(r, standQpos(0, 0, 0), standNames ?? D.modelNames); r.root.visible = visible && D.layers.robot; }
  disposeLabel(D.ghostLabel); D.ghostLabel = null;
  if (visible) D.ghostLabel = tag(moved ? `Scan pose · start check: ${moved}` : 'Where the robot stood for the scan', COLORS.scanGhost, [-0.05, 0, 1.62], D.sceneOnly);
  markDirty();
}
// Before any session: the robot drawn standing at its scan pose (scene origin), as it was scanned.
export async function setScanPoseRobot(visible) {
  init();
  const r = await robot('scanPose', D.sceneOnly);
  if (r && visible && !D.scanPosePosed) poseRobot(r, standQpos(0, 0, 0), standNames ?? D.modelNames);
  if (r) r.root.visible = visible && D.layers.robot && !(D.context.tracksShown && D.context.step === 'rehearse');
  markDirty();
}

// ------------------------------------------------------------------------------------------------ readiness anchors
// anchors: [{id, status, anchor:{kind, ...}}]; each drawn faintly, the highlighted one strong.
export function setAnchors(list, highlight = D.highlight) {
  init();
  D.anchors = list ?? []; D.highlight = highlight;
  disposeGroup(D.anchorGroup); disposeGroup(D.robotAnchors);
  const base = D.liveScenePose && D.aligned ? D.liveScenePose : [0, 0, 0];
  if (!(D.liveScenePose && D.aligned)) setFrame(D.robotAnchors, IDENTITY);
  for (const a of D.anchors) {
    const k = a.anchor?.kind, strong = a.id === highlight, col = a.status === 'block' ? COLORS.block : a.status === 'warn' ? COLORS.warn : COLORS.pass;
    if (!strong && a.status === 'pass') continue;  // passing checks draw only when asked
    if (a.status === 'later' && !strong) continue;  // not measurable yet: nothing to show
    const op = strong ? 0.42 : 0.14;
    if (k === 'wedge') {
      // In the robot's frame: it moves and turns with the robot.
      const yaw = a.anchor.yaw ?? Math.PI, half = THREE.MathUtils.degToRad((a.anchor.deg ?? 90) / 2), r = a.anchor.range_m ?? 1;
      const fan = new THREE.Mesh(new THREE.CircleGeometry(r, 40, yaw - half, half * 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: op, side: THREE.DoubleSide, depthWrite: false }));
      fan.position.z = 0.015; fan.renderOrder = 3; D.robotAnchors.add(fan);
      const edge = new THREE.Mesh(new THREE.RingGeometry(r - 0.015, r, 40, 1, yaw - half, half * 2), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: strong ? 0.9 : 0.45, side: THREE.DoubleSide, depthWrite: false }));
      edge.position.z = 0.016; D.robotAnchors.add(edge);
      tag(strong ? 'Rear blind: the lidar cannot see here' : (a.label ?? 'Rear blind'), col, [Math.cos(yaw) * r * 0.75, Math.sin(yaw) * r * 0.75, 0.25], D.robotAnchors);
    } else if (k === 'cells' && (a.anchor.cells_xy ?? a.anchor.cells)?.length) {
      const cells = a.anchor.cells_xy ?? a.anchor.cells, im = new THREE.InstancedMesh(unitBox, new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: strong ? 0.8 : 0.4 }), cells.length);
      const m4 = new THREE.Matrix4(); cells.forEach((p, i) => { m4.makeScale(0.05, 0.05, p[2] ?? 0.06).setPosition(p[0], p[1], 0); im.setMatrixAt(i, m4); });
      im.instanceMatrix.needsUpdate = true; D.anchorGroup.add(im);
    } else if (k === 'point' || k === 'frame') {
      const at = a.anchor.at ?? [0, 0, 0], p = a.anchor.frame === 'scene' ? at : [...frames.apply(base, at), at[2] ?? 0];
      const ring = flatRing(0.16, 0.2, col, strong ? 0.95 : 0.5, 0.03); ring.position.set(p[0], p[1], 0.03); D.anchorGroup.add(ring);
      if (k === 'frame') { const ax = new THREE.AxesHelper(0.3); ax.position.set(p[0], p[1], p[2] ?? 1.2); ax.rotation.z = base[2]; D.anchorGroup.add(ax); }
      if (strong) tag(a.label ?? 'check', col, [p[0], p[1], (p[2] ?? 0) + 0.35], D.anchorGroup);
    } else if (k === 'pose' && strong) {
      const p = a.anchor.pose ?? [0, 0, 0], ring = flatRing(0.34, 0.38, col, 0.9, 0.03); ring.position.set(p[0], p[1], 0.03); D.anchorGroup.add(ring);
    }
  }
  D.anchorGroup.visible = D.robotAnchors.visible = D.layers.checks;
  markDirty();
}
// Where the camera flies for an anchor (scene frame): [x, y, z, radius].
export function anchorTarget(anchor) {
  const base = D.liveScenePose && D.aligned ? D.liveScenePose : [0, 0, 0];
  if (!anchor) return null;
  if (anchor.kind === 'wedge') { const yaw = base[2] + (anchor.yaw ?? Math.PI), r = anchor.range_m ?? 1; return [base[0] + Math.cos(yaw) * r * 0.5, base[1] + Math.sin(yaw) * r * 0.5, 0.4, r + 1.2]; }
  if (anchor.kind === 'pose') { const p = anchor.pose ?? [0, 0]; return [p[0], p[1], 0.7, 2.4]; }
  if (anchor.kind === 'cells') { const c = (anchor.cells_xy ?? anchor.cells ?? [])[0] ?? base; return [c[0], c[1], 0.3, 1.8]; }
  const at = anchor.at ?? [0, 0, 0], p = anchor.frame === 'scene' ? at : [...frames.apply(base, at), at[2] ?? 0];
  return [p[0], p[1], p[2] ?? 0.5, 1.8];
}

// ------------------------------------------------------------------------------------------------ layers
export function setLayer(name, on) { if (name === 'cut') D.cut = on; else D.layers[name] = on; applyVisibility(); markDirty(); }
export const cutOn = () => D.cut;
export const layers = () => ({ ...D.layers });
// Scene-frame layers need either no live data or an align: two unregistered frames are never overlaid (D5).
export function applyVisibility(context = {}) {
  if (!D.root) return;
  D.context = { ...D.context, ...context };
  const live = !!D.liveOdomPose, sceneOk = !live || D.aligned, liveMap = live && D.layers.live && !!D.liveMem.mem;
  D.sceneOnly.visible = sceneOk;
  // Under a live map the scan is drawn only on request (Layers), as a quiet grey ghost: two maps never read as one.
  D.scanMem.group.visible = !!D.scanMem.mem && D.layers.scan && D.scanMem.key !== null && (!liveMap || D.layers.scanUnder);
  D.scanMem.setStyle(liveMap ? 'ghost' : 'solid');
  D.liveMem.group.visible = !!D.liveMem.mem && D.layers.live && D.liveMem.key !== null;
  D.ring.group.visible = D.layers.lidar;
  D.twinGroup.visible = D.layers.twin;
  const rehearsal = D.layers.rehearsal && D.context.step === 'rehearse';
  D.rehearsalGroup.visible = rehearsal;
  D.anchorGroup.visible = D.layers.checks;
  if (D.robotAnchors) D.robotAnchors.visible = D.layers.checks && (!live || D.aligned);
  for (const role of ['exact', 'drift', 'offset']) if (D.robots[role] && D.rehearsal) D.robots[role].root.visible = rehearsal;
  // The robot at its scan pose: hidden while the rehearsal's robots start from that pose.
  if (D.robots.scanPose && D.context.tracksShown && D.context.step === 'rehearse') D.robots.scanPose.root.visible = false;
}
export function showScanLayers(on) { D.scanMem.group.visible = on && D.layers.scan; markDirty(); }

// ------------------------------------------------------------------------------------------------ camera
// Insets: the overlays at the canvas edges. The camera's optical centre sits in the middle of the free area, so the
// floor ahead of the robot is never under a panel (grade issue 10).
export function setInsets(insets) {
  const next = { ...D.insets, ...insets };
  if (['left', 'right', 'top', 'bottom'].every(k => Math.abs(next[k] - D.insets[k]) < 1)) return;
  D.insets = next; if (D.active) applyViewOffset();
}
function applyViewOffset() {
  const { width: w, height: h } = view.host.getBoundingClientRect();
  if (w < 2 || h < 2) return;
  const { left, right, top, bottom } = D.insets;
  const cx = left + Math.max(40, w - left - right) / 2, cy = top + Math.max(40, h - top - bottom) / 2;
  const fw = Math.max(w, 2 * Math.max(cx, w - cx)), fh = Math.max(h, 2 * Math.max(cy, h - cy));
  view.camera.aspect = fw / fh;
  view.camera.setViewOffset(fw, fh, fw / 2 - cx, fh / 2 - cy, w, h);
  view.camera.updateProjectionMatrix();
  D.free = { w: Math.max(40, w - left - right), h: Math.max(40, h - top - bottom), fh };
  markDirty();
}
// The half-angle the free area spans (vertical and horizontal), for fitting.
function freeHalfAngles() {
  const f = D.free ?? { w: 800, h: 600, fh: 600 };
  const focal = (f.fh / 2) / Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2));
  return [Math.atan((f.h / 2) / focal), Math.atan((f.w / 2) / focal)];
}
function flyTo(target, position, ms = 480) {
  D.tween = { t0: performance.now(), ms, fromT: view.controls.target.clone(), fromP: view.camera.position.clone(), toT: target, toP: position };
  markDirty();
}
function beforeRender(now) {
  updateCut();
  const tw = D.tween;
  if (tw) {
    const u = Math.min(1, (now - tw.t0) / tw.ms), e = u < 0.5 ? 2 * u * u : 1 - Math.pow(-2 * u + 2, 2) / 2;
    view.controls.target.lerpVectors(tw.fromT, tw.toT, e); view.camera.position.lerpVectors(tw.fromP, tw.toP, e);
    if (u >= 1) D.tween = null;
    view.dirty = true;
  }
}
export function cameraMode() { return D.mode; }
// Frame a set of scene points (xy or xyz) from behind the robot's heading, in the current mode.
export function frame(points, { heading = null, instant = false, minRadius = 1.6 } = {}) {
  const pts = points.filter(p => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
  if (!pts.length) return;
  const box = new THREE.Box3();
  for (const p of pts) box.expandByPoint(new THREE.Vector3(p[0], p[1], p[2] ?? 0));
  box.expandByPoint(new THREE.Vector3(box.min.x, box.min.y, 1.2));
  const centre = box.getCenter(new THREE.Vector3()), radius = Math.max(minRadius, box.getSize(new THREE.Vector3()).length() / 2);
  const [av, ah] = freeHalfAngles(), fit = radius / Math.sin(Math.max(0.12, Math.min(av, ah)));
  const yaw = heading ?? D.liveScenePose?.[2] ?? 0;
  const target = new THREE.Vector3(centre.x, centre.y, D.mode === 'top' ? 0 : 0.35);
  let position;
  if (D.mode === 'top') position = new THREE.Vector3(centre.x - Math.cos(yaw) * 0.001, centre.y - Math.sin(yaw) * 0.001, fit * 1.05);
  else {
    const elev = THREE.MathUtils.degToRad(56), back = yaw + Math.PI + THREE.MathUtils.degToRad(-20);
    position = new THREE.Vector3(centre.x + Math.cos(back) * Math.cos(elev) * fit, centre.y + Math.sin(back) * Math.cos(elev) * fit, 0.35 + Math.sin(elev) * fit);
  }
  view.controls.enableRotate = D.mode !== 'top';
  view.controls.maxDistance = Math.max(80, fit * 3);
  if (instant) { view.controls.target.copy(target); view.camera.position.copy(position); view.controls.update(); markDirty(); }
  else flyTo(target, position);
  D.followAt = D.liveScenePose ? [...D.liveScenePose] : null;
}
export function setCameraMode(mode, points, opts = {}) {
  D.mode = mode;
  view.controls.enableRotate = mode !== 'top';
  if (mode === 'follow' && D.liveScenePose) {
    const p = D.liveScenePose, back = p[2] + Math.PI;
    flyTo(new THREE.Vector3(p[0], p[1], 0.6), new THREE.Vector3(p[0] + Math.cos(back) * 3.4, p[1] + Math.sin(back) * 3.4, 2.4));
    D.followAt = [...p];
  } else if (points) frame(points, opts);
  markDirty();
}
function followRobot() {
  const p = D.liveScenePose; if (!p) return;
  if (!D.followAt) { D.followAt = [...p]; return; }
  const dx = p[0] - D.followAt[0], dy = p[1] - D.followAt[1];
  if (Math.abs(dx) + Math.abs(dy) < 1e-4) return;
  const d = new THREE.Vector3(dx, dy, 0);
  view.camera.position.add(d); view.controls.target.add(d);
  if (D.tween) { D.tween.toT.add(d); D.tween.toP.add(d); }
  D.followAt = [...p]; markDirty();
}
export function ensureInView(p, radius = 2.2) {
  if (!p || !D.free) return false;
  const v = new THREE.Vector3(p[0], p[1], 0.8).project(view.camera), rect = view.renderer.domElement.getBoundingClientRect();
  const x = (v.x + 1) / 2 * rect.width, y = (1 - v.y) / 2 * rect.height, { left, right, top, bottom } = D.insets;
  if (v.z < 1 && x > left + 40 && x < rect.width - right - 40 && y > top + 40 && y < rect.height - bottom - 40) return false;
  frame([p], { minRadius: radius, heading: p[2] ?? 0 });
  return true;
}
export const liveOdomPoseScene = () => D.liveScenePose;
export function flyToAnchor(anchor) {
  const t = anchorTarget(anchor); if (!t) return;
  const [x, y, z, r] = t, yaw = D.liveScenePose?.[2] ?? 0, back = yaw + Math.PI - 0.5;
  const dist = r / Math.sin(Math.max(0.15, Math.min(...freeHalfAngles())));
  flyTo(new THREE.Vector3(x, y, z), new THREE.Vector3(x + Math.cos(back) * dist * 0.7, y + Math.sin(back) * dist * 0.7, z + dist * 0.7));
}

// ------------------------------------------------------------------------------------------------ picking
// The cell under the pointer through the scan's memory grid: march the ray, stop at the first column it enters or at
// the floor. A click on an obstacle lands on the obstacle's footprint (and is refused there), never behind it.
const raycaster = new THREE.Raycaster();
export function pickAt(clientX, clientY) {
  const rect = view.renderer.domElement.getBoundingClientRect();
  raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), view.camera);
  const { origin, direction } = raycaster.ray;
  if (direction.z >= -1e-4) return null;  // looking at or above the horizon
  const lookup = D.scanLookup, tFloor = -origin.z / direction.z;
  const floor = [origin.x + direction.x * tFloor, origin.y + direction.y * tFloor];
  if (!lookup) return { xy: floor, hit: 'floor' };
  const maxH = 2.6, tStart = origin.z > maxH ? (origin.z - maxH) / -direction.z : 0, L = tFloor - tStart;
  const horiz = Math.hypot(direction.x, direction.y), dt = horiz > 1e-6 ? (lookup.mem.res / 2) / horiz : L;
  const steps = Math.min(4000, Math.ceil(L / Math.max(1e-4, dt)) + 1);
  for (let s = 0; s <= steps; s++) {
    const t = tStart + Math.min(L, s * dt), z = origin.z + direction.z * t, xy = [origin.x + direction.x * t, origin.y + direction.y * t];
    const cell = lookup.cell(xy); if (!cell) continue;
    const h = heightOf(lookup.mem.support[cell.k]);
    if (h !== null && h >= STEP_OVER_M && z <= h) {
      const c = frames.apply(lookup.sceneFromGrid, [lookup.mem.lo[0] + cell.i * lookup.mem.res, lookup.mem.lo[1] + cell.j * lookup.mem.res]);
      return { xy: c, hit: 'column', columnTop: h };
    }
  }
  return { xy: floor, hit: 'floor' };
}
// Screen position of a scene point (for tests and HUD anchoring).
export function project(p) {
  const v = new THREE.Vector3(p[0], p[1], p[2] ?? 0).project(view.camera), rect = view.renderer.domElement.getBoundingClientRect();
  return [rect.left + (v.x + 1) / 2 * rect.width, rect.top + (1 - v.y) / 2 * rect.height, v.z];
}
