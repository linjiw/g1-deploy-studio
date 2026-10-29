// The 3D view: rendered only when something changed, on a transparent canvas over the stage's light backdrop
// (a white, quiet studio: colours below are chosen to read on it).
// World frame as in Studio and MuJoCo: right-handed, Z up, metres; quaternions w, x, y, z.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const COLORS = {
  teal: 0x0f9e94, amber: 0xe0a030, red: 0xdc5348, violet: 0x9d7cc9,
  green: 0x2fae6a, box: 0x9aa8b6, ink: 0x2a333d, pink: 0xe8458f, blue: 0x2f74d0, ghost: 0xff7fc4,
};
// The robot's map, one texel per 5 cm memory cell (Studio's hues, tuned for a light floor): never observed cells
// stay transparent.
const MAP_RGBA = { 1: [126, 200, 194, 72], 2: [232, 170, 72, 215], 3: [226, 120, 110, 230], 4: [160, 128, 205, 210] };
const VOXEL_RGB = { 2: new THREE.Color(0xeab35a), 3: new THREE.Color(0xe2786e), 4: new THREE.Color(0xa88ad2) };
const MAX_VOXELS = 24000;
const FLOOR_M = 32;   // the backdrop floor: a square this wide, fading to transparent at its edge

const tmp = { q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), m: new THREE.Matrix4(), s: new THREE.Vector3(), p: new THREE.Vector3(), size: new THREE.Vector2() };

const ease = (a, b, t) => { const x = Math.max(0, Math.min(1, (t - a) / Math.max(0.001, b - a))); return x * x * (3 - 2 * x); };
const mix = (a, b, t) => a + (b - a) * t;

// A camera pose only: [eye xyz, target xyz]. Recorded robot poses never pass through this filter.
// The shot depends only on recording time, so seeking and video capture give the same framing as playback.
export function filmPose(walk, world, time, aspect = 1, out = new Float64Array(6)) {
  const t = Math.max(0, Math.min(walk.duration, time)), k = walk.index(t), next = Math.min(k + 1, walk.n - 1);
  const alpha = next === k ? 0 : (t - walk.times[k]) / (walk.times[next] - walk.times[k]);
  // Smooth the camera's target over nearby recorded samples to remove footfall bob; retain the robot's motion.
  for (let axis = 0; axis < 3; axis++) {
    let a = 0, b = 0, weight = 0;
    for (let j = -5; j <= 5; j++) {
      const w = 6 - Math.abs(j); weight += w;
      a += walk.frames[Math.max(0, Math.min(walk.n - 1, k + j)) * 36 + axis] * w;
      b += walk.frames[Math.max(0, Math.min(walk.n - 1, next + j)) * 36 + axis] * w;
    }
    out[axis + 3] = mix(a / weight, b / weight, alpha);
  }
  const sx = walk.frames[0], sy = walk.frames[1], goal = walk.goal ?? world.start_xy;
  const gx = goal[0], gy = goal[1], span = Math.hypot(gx - sx, gy - sy);
  const heading = span > 0.1 ? Math.atan2(gy - sy, gx - sx) : world.start_yaw_rad ?? 0;
  const trackAt = Math.min(2.4, walk.duration * 0.22), finishAt = Math.max(trackAt, walk.duration - Math.min(3, walk.duration * 0.22));
  const tracking = ease(0.15, trackAt, t), finishing = ease(finishAt, walk.duration, t);
  const x = out[3], y = out[4], z = Math.max(0.45, Math.min(0.72, out[5] * 0.8));
  // Establish the task, track the executed body, then show its final relation to the goal (including a miss).
  out[3] = mix(mix(sx + (gx - sx) * 0.18, x, tracking), mix(x, gx, 0.28), finishing);
  out[4] = mix(mix(sy + (gy - sy) * 0.18, y, tracking), mix(y, gy, 0.28), finishing);
  out[5] = mix(0.48, z, tracking);
  const establish = Math.max(6.2, Math.min(9, 5.8 + span * 0.3));
  const distance = mix(mix(establish, 3.9, tracking), 4.1 + Math.hypot(gx - x, gy - y) * 0.9, finishing)
    / Math.min(1, Math.sqrt(Math.max(0.2, aspect)));
  const pitch = mix(mix(0.78, 0.45, tracking), 0.62, finishing);
  const yaw = heading - 2.35 + 0.3 * Math.sin(Math.PI * t / Math.max(0.001, walk.duration));
  out[0] = out[3] + Math.cos(yaw) * Math.cos(pitch) * distance;
  out[1] = out[4] + Math.sin(yaw) * Math.cos(pitch) * distance;
  out[2] = out[5] + Math.sin(pitch) * distance;
  return out;
}

export class Viewer {
  constructor(container, { onPick, onHover } = {}) {
    this.container = container;
    this.abort = new AbortController();
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'default' });
    renderer.setClearColor(0x000000, 0);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    const scene = this.scene = new THREE.Scene();
    const camera = this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 80);
    camera.up.set(0, 0, 1);
    camera.position.set(-3.2, -4.6, 3.6);
    const controls = this.controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(1.2, 0, 0.4);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 1.2; controls.maxDistance = 22;
    controls.addEventListener('change', () => this.dirty());
    controls.addEventListener('start', () => { this.onInteraction?.(); this.start(); });
    scene.add(new THREE.HemisphereLight(0xf4f8fb, 0x8a96a2, 1.35));
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.5);
    sun.position.set(-3, -4, 8); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.5, far: 20 });
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);
    const floor = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_M, FLOOR_M),
      new THREE.MeshStandardMaterial({ map: floorTexture(renderer), transparent: true, depthWrite: false, roughness: 1, metalness: 0 }));
    floor.receiveShadow = true; floor.name = 'floor'; floor.renderOrder = -1;
    scene.add(floor);
    this.groups = {};
    for (const name of ['world', 'map', 'voxels', 'lidar', 'route', 'plan', 'trail', 'markers', 'outcomes', 'robot', 'ghost']) {
      const g = new THREE.Group(); g.name = name; this.groups[name] = g; scene.add(g);
    }
    this.lineMaterials = [];
    this.needsRender = true; this.running = false; this.visible = true; this.contextLost = false;
    this.onFrame = null;     // (now) => animating?  called every frame while running
    this.onRender = null;    // () => void            called after every drawn frame (to place DOM chips)
    this.views = null;       // split screen: [{ x, w, before(), after() }], x and w in fractions of the width
    this.robot = null; this.ghosts = {};
    this.follow = false;
    (this._resizer = new ResizeObserver(() => this.resize())).observe(container);
    this.resize();
    this._pickSetup(onPick, onHover);
    (this._seer = new IntersectionObserver(entries => {
      this.visible = entries[0].isIntersecting;
      if (this.visible) this.start(); else this.stop();
    }, { threshold: 0.01 })).observe(container);
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.stop(); else this.start(); }, { signal: this.abort.signal });
    renderer.domElement.addEventListener('webglcontextlost', e => {
      e.preventDefault(); this.contextLost = true; this.stop();
      const status = this._contextStatus = document.createElement('div');
      status.setAttribute('role', 'status');
      status.textContent = 'The 3D view is paused while its graphics context recovers. Reload if the scene does not return.';
      Object.assign(status.style, { position: 'absolute', inset: '0', display: 'grid', placeContent: 'center', padding: '2rem', background: '#101820eb', color: '#e6eef2', textAlign: 'center' });
      container.appendChild(status);
    }, { signal: this.abort.signal });
    renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.contextLost = false; this._contextStatus?.remove(); this.dirty();
    }, { signal: this.abort.signal });
    this.start();
  }

  // ----- render loop: rAF only while visible; draw only when dirty, damping or a frame callback asks
  start() {
    if (this.running || this.disposed || !this.visible || document.hidden || this.contextLost) return;
    this.running = true;
    const tick = now => {
      this._frameRequest = null;
      if (!this.visible || this.disposed || document.hidden || this.contextLost) { this.running = false; return; }
      const animating = this.onFrame ? this.onFrame(now) : false;
      const moved = this.controls.update();
      if (this.needsRender || moved || animating) { this.render(); this.needsRender = false; }
      // Once damping settles, sleep until an interaction, resize or playback starts the loop again.
      else { this.running = false; return; }
      this._frameRequest = requestAnimationFrame(tick);
    };
    this._frameRequest = requestAnimationFrame(tick);
  }
  stop() { cancelAnimationFrame(this._frameRequest); this._frameRequest = null; this.running = false; }
  render() {
    const r = this.renderer, size = r.getDrawingBufferSize(tmp.size), pr = r.getPixelRatio();
    if (!this.views) {
      r.setScissorTest(false); r.setViewport(0, 0, size.x / pr, size.y / pr);
      r.render(this.scene, this.camera);
    } else {
      const w = size.x / pr, h = size.y / pr;
      r.setScissorTest(true);
      for (const v of this.views) {
        const x = Math.round(v.x * w), vw = Math.round(v.w * w);
        r.setViewport(x, 0, vw, h); r.setScissor(x, 0, vw, h);
        v.before?.(); r.render(this.scene, this.camera); v.after?.();
      }
      r.setScissorTest(false);
    }
    this.onRender?.();
  }
  dirty() { this.needsRender = true; if (!this.running && this.visible) this.start(); }
  resize() {
    if (this.disposed) return;
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    // Big canvases draw fewer device pixels per CSS pixel: about 3.5 million at most.
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75, Math.sqrt(3.5e6 / (w * h))));
    this.renderer.setSize(w, h, false);
    const share = this.views ? this.views[0].w : 1;
    this.camera.aspect = w * share / h; this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w * share, h);
    if (this.film) this.filmFrame(this.film.walk, this.film.world, this.film.time, { reducedMotion: this.film.reducedMotion, force: true });
    this.dirty();
  }
  setViews(views) { this.views = views; this.resize(); }
  // A world point in CSS pixels from the container's top left, or null when it is behind the camera.
  project(x, y, z = 0) {
    // Camera presets and DOM chips can update before the next GPU draw.
    this.camera.updateMatrixWorld();
    const v = tmp.p.set(x, y, z).project(this.camera);
    if (v.z > 1 || v.z < -1) return null;
    return [(v.x + 1) / 2 * this.container.clientWidth, (1 - v.y) / 2 * this.container.clientHeight];
  }

  _pickSetup(onPick, onHover) {
    const el = this.renderer.domElement, ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
    const plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), hit = new THREE.Vector3();
    const toWorld = e => {
      const r = el.getBoundingClientRect();
      ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      ray.setFromCamera(ndc, this.camera);
      return ray.ray.intersectPlane(plane, hit) ? [hit.x, hit.y] : null;
    };
    let down = null, hoverPending = null;
    const sig = { signal: this.abort.signal };
    const clearHover = () => { hoverPending = null; cancelAnimationFrame(this._hoverRequest); this._hoverRequest = null; onHover?.(null); };
    el.addEventListener('pointerdown', e => {
      clearHover();
      down = e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY, t: performance.now(), id: e.pointerId } : null;
    }, sig);
    el.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (e.button === 0 && e.pointerId === down.id && moved < 7 && performance.now() - down.t < 600 && onPick && !this.views) { const xy = toWorld(e); if (xy) onPick(xy, e); }
      down = null;
    }, sig);
    el.addEventListener('pointercancel', () => { down = null; clearHover(); }, sig);
    el.addEventListener('pointermove', e => {
      if (!onHover || e.pointerType === 'touch' || down || this.views) return;
      hoverPending = e;
      if (this._hoverRequest) return;
      this._hoverRequest = requestAnimationFrame(() => { this._hoverRequest = null; if (hoverPending && !this.disposed) onHover(toWorld(hoverPending)); });
    }, sig);
    el.addEventListener('pointerleave', () => { down = null; clearHover(); }, sig);
  }

  // ----- lines
  line(color, width, { dashed = false, opacity = 1 } = {}) {
    const material = new LineMaterial({ color, linewidth: width, transparent: opacity < 1, opacity, dashed, dashSize: 0.12, gapSize: 0.08, worldUnits: false });
    material.resolution.set(this.container.clientWidth || 1, this.container.clientHeight || 1);
    this.lineMaterials.push(material);
    const line = new Line2(new LineGeometry(), material);
    line.visible = false; line.frustumCulled = false;
    return line;
  }
  setLine(line, points) {
    if (!points || points.length < 2) { line.visible = false; this.dirty(); return; }
    const segments = points.length - 1;
    if ((line.userData.capacity ?? 0) < segments) {
      const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(segments)));
      line.geometry.dispose();
      const geometry = line.geometry = new LineGeometry();
      const positions = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 6), 6).setUsage(THREE.DynamicDrawUsage);
      geometry.setAttribute('instanceStart', new THREE.InterleavedBufferAttribute(positions, 3, 0));
      geometry.setAttribute('instanceEnd', new THREE.InterleavedBufferAttribute(positions, 3, 3));
      if (line.material.dashed) {
        const distances = new THREE.InstancedInterleavedBuffer(new Float32Array(capacity * 2), 2).setUsage(THREE.DynamicDrawUsage);
        geometry.setAttribute('instanceDistanceStart', new THREE.InterleavedBufferAttribute(distances, 1, 0));
        geometry.setAttribute('instanceDistanceEnd', new THREE.InterleavedBufferAttribute(distances, 1, 1));
      }
      line.userData.capacity = capacity;
    }
    const positions = line.geometry.attributes.instanceStart.data;
    const distances = line.geometry.attributes.instanceDistanceStart?.data;
    let distance = 0;
    for (let i = 0; i < segments; i++) {
      const a = points[i], b = points[i + 1], k = i * 6;
      positions.array[k] = a[0]; positions.array[k + 1] = a[1]; positions.array[k + 2] = a[2] ?? 0.02;
      positions.array[k + 3] = b[0]; positions.array[k + 4] = b[1]; positions.array[k + 5] = b[2] ?? 0.02;
      if (distances) {
        distances.array[i * 2] = distance;
        distance += Math.hypot(b[0] - a[0], b[1] - a[1], (b[2] ?? 0.02) - (a[2] ?? 0.02));
        distances.array[i * 2 + 1] = distance;
      }
    }
    positions.clearUpdateRanges(); positions.addUpdateRange(0, segments * 6); positions.needsUpdate = true;
    if (distances) { distances.clearUpdateRanges(); distances.addUpdateRange(0, segments * 2); distances.needsUpdate = true; }
    line.geometry.instanceCount = line.userData.segments = segments;
    line.visible = true;
    this.dirty();
  }

  // Draw only the first n points of a line set once (a trail growing during playback, without a new geometry).
  setLineCount(line, n) {
    const segments = Math.min(line.userData.segments ?? 0, Math.max(0, n - 1));
    if (!line.visible || line.geometry.instanceCount === segments) return;
    line.geometry.instanceCount = segments;
    this.dirty();
  }

  // ----- the real room (simulation geometry: shown only as the sim truth it is)
  setWorld(world) {
    clear(this.groups.world);
    const b = world.bounds;
    // The floor's grid is drawn in whole metres: centre it on a whole metre near the room.
    this.floor.position.set(Math.round((b.min[0] + b.max[0]) / 2), Math.round((b.min[1] + b.max[1]) / 2), 0);
    this.boxes = new THREE.Group();
    for (const box of world.boxes) this.boxes.add(boxMesh(box));
    this.groups.world.add(this.boxes);
    // The start mark, as taped on the floor (build sheet): a cross and the heading arrow.
    const mark = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: COLORS.ink, transparent: true, opacity: 0.8 });
    for (const [sx, sy] of [[0.5, 0.025], [0.025, 0.5]]) { const m = new THREE.Mesh(new THREE.PlaneGeometry(sx, sy), mat); m.position.z = 0.003; mark.add(m); }
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.16, 3), mat); arrow.rotation.z = -Math.PI / 2; arrow.position.set(0.36, 0, 0.003); arrow.scale.z = 0.05;
    mark.add(arrow);
    mark.position.set(world.start_xy[0], world.start_xy[1], 0); mark.rotation.z = world.start_yaw_rad;
    this.groups.world.add(mark);
    this.dirty();
  }
  setBoxesStyle(mode) {  // 'solid' | 'ghost' | 'hidden'
    if (!this.boxes) return;
    this.boxes.visible = mode !== 'hidden';
    this.boxes.traverse(o => {
      if (o.isMesh) { o.material.opacity = mode === 'ghost' ? 0.14 : 0.8; o.material.depthWrite = mode !== 'ghost'; o.castShadow = mode !== 'ghost'; }
      if (o.isLineSegments) o.material.opacity = mode === 'ghost' ? 0.55 : 0.75;
    });
    this.dirty();
  }

  // ----- the robot's map: a floor texture plus height cells for obstacles and overhead
  setMapBase(map) {
    const n = map.n;
    this.map = { n, res: map.res_m, lo: map.lo, codes: map.codes.slice(), heights: map.height_cm.slice() };
    if (!this.mapMesh || this.mapMesh.userData.n !== n) {
      clear(this.groups.map);
      const texture = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat);
      texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.LinearFilter;
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
      mesh.renderOrder = 1; mesh.userData.n = n;
      this.groups.map.add(mesh); this.mapMesh = mesh;
      clear(this.groups.voxels);
      const voxels = this.voxels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.8, transparent: true, opacity: 0.84 }), MAX_VOXELS);
      voxels.count = 0; voxels.frustumCulled = false;
      voxels.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VOXELS * 3), 3);
      this.groups.voxels.add(voxels);
    }
    this.mapMesh.scale.set(n * map.res_m, n * map.res_m, 1);
    this.mapMesh.position.set(map.lo[0] + (n - 1) * map.res_m / 2, map.lo[1] + (n - 1) * map.res_m / 2, 0.005);
    this._paintAll();
  }
  applyMapChanges(step) {  // {g: gaps between flat indices, v: code or code * 1000 + height cm}
    const m = this.map; if (!m) return;
    let idx = 0;
    const data = this.mapMesh.material.map.image.data;
    for (let k = 0; k < step.g.length; k++) {
      idx += step.g[k];
      const v = step.v[k], code = v >= 1000 ? Math.floor(v / 1000) : v, h = v >= 1000 ? v % 1000 : 0;
      m.codes[idx] = code; m.heights[idx] = h;
      paintCell(data, m, idx);
    }
    this.mapMesh.material.map.needsUpdate = true;
    this._voxels();
    this.dirty();
  }
  _paintAll() {
    const m = this.map, data = this.mapMesh.material.map.image.data;
    for (let idx = 0; idx < m.n * m.n; idx++) paintCell(data, m, idx);
    this.mapMesh.material.map.needsUpdate = true;
    this._voxels();
    this.dirty();
  }
  _voxels() {
    const m = this.map, v = this.voxels, n = m.n;
    let count = 0;
    for (let idx = 0; idx < n * n && count < MAX_VOXELS; idx++) {
      const code = m.codes[idx];
      if (code < 2) continue;
      const i = Math.floor(idx / n), j = idx % n, h = Math.max(1, m.heights[idx]) / 100;
      const x = m.lo[0] + i * m.res, y = m.lo[1] + j * m.res;
      if (code === 4) { tmp.p.set(x, y, h + 0.01); tmp.s.set(m.res, m.res, 0.02); }
      else { tmp.p.set(x, y, h / 2); tmp.s.set(m.res * 0.92, m.res * 0.92, h); }
      tmp.m.compose(tmp.p, tmp.q.identity(), tmp.s);
      v.setMatrixAt(count, tmp.m); v.setColorAt(count, VOXEL_RGB[code]);
      count++;
    }
    v.count = count;
    v.instanceMatrix.needsUpdate = true; if (v.instanceColor) v.instanceColor.needsUpdate = true;
  }

  // ----- LiDAR returns (cm integers, x y z triples)
  setLidar(snapshot) {
    const g = this.groups.lidar;
    if (!this.lidarPoints) {
      const geom = new THREE.BufferGeometry();
      geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(1200 * 3), 3));
      geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(1200 * 3), 3));
      this.lidarPoints = new THREE.Points(geom, new THREE.PointsMaterial({ size: 0.035, vertexColors: true, transparent: true, opacity: 0.9, depthWrite: false }));
      this.lidarPoints.frustumCulled = false;
      g.add(this.lidarPoints);
    }
    const pts = snapshot?.p ?? [], geom = this.lidarPoints.geometry, pos = geom.attributes.position.array, col = geom.attributes.color.array;
    const count = Math.min(pts.length / 3, 1200), c = new THREE.Color();
    for (let k = 0; k < count; k++) {
      pos[k * 3] = pts[k * 3] / 100; pos[k * 3 + 1] = pts[k * 3 + 1] / 100; pos[k * 3 + 2] = pts[k * 3 + 2] / 100;
      c.setHSL(0.5 - Math.min(1, Math.max(0, pts[k * 3 + 2] / 200)) * 0.32, 0.8, 0.42);
      col[k * 3] = c.r; col[k * 3 + 1] = c.g; col[k * 3 + 2] = c.b;
    }
    geom.setDrawRange(0, count);
    geom.attributes.position.needsUpdate = true; geom.attributes.color.needsUpdate = true;
    this.dirty();
  }

  // ----- markers
  marker(name, color, radius) {
    if (this[name]) return this[name];
    const g = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.025, radius, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, side: THREE.DoubleSide, depthWrite: false }));
    ring.position.z = 0.012; g.add(ring);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.025, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, depthWrite: false }));
    disc.position.z = 0.011; g.add(disc);
    const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.7, 8), new THREE.MeshBasicMaterial({ color }));
    pin.rotation.x = Math.PI / 2; pin.position.z = 0.35; g.add(pin);
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.05, 16, 12), new THREE.MeshBasicMaterial({ color }));
    head.position.z = 0.72; g.add(head);
    g.visible = false; g.userData = { ring, disc, pin, head };
    this.groups.markers.add(g);
    this[name] = g;
    return g;
  }
  setMarker(name, xy, { color, radius = 0.4, pin = true } = {}) {
    const g = this.marker(name, color ?? COLORS.amber, radius);
    if (!xy) { g.visible = false; this.dirty(); return; }
    if (color !== undefined) for (const k of ['ring', 'disc', 'pin', 'head']) g.userData[k].material.color.set(color);
    g.userData.pin.visible = g.userData.head.visible = pin;
    g.position.set(xy[0], xy[1], 0); g.visible = true;
    this.dirty();
  }

  setOutcomes(cells, colorOf) {  // recorded goals as small floor discs, coloured by outcome
    clear(this.groups.outcomes);
    if (!cells?.length) { this.dirty(); return; }
    const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.06, 20), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.72, depthWrite: false }), cells.length);
    cells.forEach((c, k) => {
      tmp.m.makeTranslation(c.xy[0], c.xy[1], 0.009);
      mesh.setMatrixAt(k, tmp.m); mesh.setColorAt(k, new THREE.Color(colorOf(c)));
    });
    mesh.renderOrder = 2;
    this.groups.outcomes.add(mesh);
    this.dirty();
  }
  dimOutcomes(dim) {
    for (const m of this.groups.outcomes.children) m.material.opacity = dim ? 0.2 : 0.72;
    this.dirty();
  }

  // ----- the robot and its ghosts (the same model with another material)
  async loadRobot(base, onProgress) {
    const signal = this.abort.signal;
    const [spec, index] = await Promise.all([fetch(`${base}robot.json`, { signal }).then(ok).then(r => r.json()), fetch(`${base}meshes.json`, { signal }).then(ok).then(r => r.json())]);
    const total = Math.max(...Object.values(index.meshes).map(m => m.offset + m.vertices * 6 + m.indices * 2));
    if (!Number.isSafeInteger(total) || total <= 0) throw new Error('The robot mesh index is invalid.');
    const bin = await fetchBytes(`${base}meshes.bin`, total, onProgress, signal);
    signal.throwIfAborted();
    const geometries = {};
    const materials = new Map();
    try {
      for (const [name, m] of Object.entries(index.meshes)) {
        const q = new Uint16Array(bin, m.offset, m.vertices * 3), ind = new Uint16Array(bin, m.offset + m.vertices * 6, m.indices);
        const pos = new Float32Array(m.vertices * 3);
        for (let k = 0; k < m.vertices; k++) for (let a = 0; a < 3; a++) pos[k * 3 + a] = m.min[a] + q[k * 3 + a] / 65535 * (m.max[a] - m.min[a]);
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        g.setIndex(new THREE.BufferAttribute(new Uint16Array(ind), 1));
        geometries[name] = toCreasedNormals(g, Math.PI / 5);
        if (geometries[name] !== g) g.dispose();
      }
      this.robot = buildRobot(spec, geometries, rgba => {
        const key = rgba.join(',');
        if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(rgba[0], rgba[1], rgba[2]), roughness: 0.5, metalness: 0.25 }));
        return materials.get(key);
      }, true);
    } catch (error) {
      for (const geometry of Object.values(geometries)) geometry.dispose();
      for (const material of materials.values()) material.dispose();
      throw error;
    }
    this._model = { spec, geometries };
    this.groups.robot.add(this.robot.root);
    this.dirty();
    return this.robot;
  }
  ghost(name, { color = COLORS.ghost, opacity = 0.34 } = {}) {
    if (this.ghosts[name]) return this.ghosts[name];
    if (!this._model) return null;
    const material = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.3, roughness: 0.6, transparent: opacity < 1, opacity, depthWrite: opacity >= 1 });
    const g = buildRobot(this._model.spec, this._model.geometries, () => material, false);
    g.material = material; g.root.visible = false;
    this.groups.ghost.add(g.root);
    this.ghosts[name] = g;
    return g;
  }
  setGhost(name, qpos, style) {
    const g = this.ghost(name, style);
    if (!g) return;
    g.root.visible = !!qpos;
    if (qpos) poseRobot(g, qpos);
    this.dirty();
  }
  // qpos: [x, y, z, qw, qx, qy, qz, 29 joint angles] in the model's qpos order (MuJoCo, named joints)
  setPose(qpos) {
    if (!this.robot) return;
    poseRobot(this.robot, qpos);
    // The shadow follows the robot; the camera too when following.
    this.sun.target.position.set(qpos[0], qpos[1], 0); this.sun.position.set(qpos[0] - 3, qpos[1] - 4, 8);
    if (this.follow) {
      const dx = qpos[0] - this.controls.target.x, dy = qpos[1] - this.controls.target.y;
      this.controls.target.x += dx; this.controls.target.y += dy;
      this.camera.position.x += dx; this.camera.position.y += dy;
    }
    this.dirty();
  }

  // ----- camera
  filmFrame(walk, world, time, { reducedMotion = false, force = false } = {}) {
    if (!this.film || this.film.walk !== walk || this.film.reducedMotion !== reducedMotion) {
      this.clearFilm();
      this.film = { walk, world, time, reducedMotion, pose: new Float64Array(6), damping: this.controls.enableDamping };
      // Clear any remaining orbit momentum before taking the camera. No wall-clock animation is added.
      this.controls.enableDamping = false; this.controls.update();
      if (reducedMotion) this.frame(world, 'orbit');
    }
    const film = this.film; film.time = time;
    this.follow = false;
    if (reducedMotion) { if (force) this.frame(world, 'orbit'); film.shot = 'Still view'; return film.shot; }
    const p = filmPose(walk, world, time, this.camera.aspect, film.pose);
    this.controls.target.set(p[3], p[4], p[5]); this.camera.position.set(p[0], p[1], p[2]);
    this.controls.maxDistance = Math.max(22, this.camera.position.distanceTo(this.controls.target) * 1.2);
    this.controls.update(); this.dirty();
    film.shot = time < Math.min(2.4, walk.duration * 0.22) ? 'Establishing' : time > walk.duration - Math.min(3, walk.duration * 0.22) ? 'Finish' : 'Tracking';
    return film.shot;
  }
  clearFilm() {
    if (!this.film) return;
    this.controls.enableDamping = this.film.damping;
    this.film = null;
  }
  frame(world, mode = 'orbit') {
    // Aim between the start mark and the room's centre: the robot and where it can go both stay in view.
    const b = world.bounds, s = world.start_xy;
    const cx = (s[0] + (b.min[0] + b.max[0]) / 2) / 2, cy = (s[1] + (b.min[1] + b.max[1]) / 2) / 2;
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    const narrow = this.camera.aspect < 0.9;
    if (mode === 'top') {
      this.controls.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0);
      const fov = this.camera.fov * Math.PI / 180, fit = Math.max(b.max[1] - b.min[1], (b.max[0] - b.min[0]) / this.camera.aspect);
      this.camera.position.set(this.controls.target.x, this.controls.target.y - 0.01, fit / 2 / Math.tan(fov / 2) * 1.12);
    } else {
      this.controls.target.set(cx, cy, 0.3);
      const d = span * (narrow ? 1.35 : 0.86) + 1.6;
      this.camera.position.set(cx - d * 0.6, cy - d * 0.68, d * 0.6);
    }
    // A portrait top view can need more distance than the default orbit limit.
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.controls.maxDistance = Math.max(22, distance * 1.5);
    this.camera.far = Math.max(80, distance + span * 2); this.camera.updateProjectionMatrix();
    this.controls.update();
    this.dirty();
  }
  // Keep the viewing direction; move the target to the middle of the points and back off to see all of them.
  focus(points, { margin = 1.2 } = {}) {
    if (this.follow || !points.length) return;
    const cx = points.reduce((a, p) => a + p[0], 0) / points.length, cy = points.reduce((a, p) => a + p[1], 0) / points.length;
    const r = Math.max(1.6, ...points.map(p => Math.hypot(p[0] - cx, p[1] - cy)));
    const dir = tmp.v.copy(this.camera.position).sub(this.controls.target).normalize();
    const fov = this.camera.fov * Math.PI / 180, aspect = Math.min(1, this.camera.aspect);
    const d = Math.min(this.controls.maxDistance, (r + margin) / Math.tan(fov / 2) / aspect * 0.95);
    this.controls.target.set(cx, cy, 0.4);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
    this.controls.update();
    this.dirty();
  }
  // Look at a point from a heading (radians, the camera's direction from the target), a pitch and a distance.
  look(target, { yaw = -2.3, pitch = 0.42, distance = 3.2 } = {}) {
    const z = target[2] ?? 0.6, c = Math.cos(pitch);
    this.controls.target.set(target[0], target[1], z);
    this.camera.position.set(target[0] + Math.cos(yaw) * c * distance, target[1] + Math.sin(yaw) * c * distance, z + Math.sin(pitch) * distance);
    this.controls.update();
    this.dirty();
  }
  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.clearFilm(); this.onInteraction = null;
    this.abort.abort(); this.stop(); cancelAnimationFrame(this._hoverRequest); this._contextStatus?.remove();
    this._resizer.disconnect(); this._seer.disconnect(); this.controls.dispose();
    clear(this.scene);
    this.lineMaterials.length = 0;
    this.renderer.dispose();
    this.renderer.forceContextLoss?.();
    this.renderer.domElement.remove();
  }
}

function buildRobot(spec, geometries, materialOf, shadows) {
  const joints = [];
  const body = node => {
    const group = new THREE.Group(); group.name = node.name;
    const restPosition = new THREE.Vector3(...node.position), restQuaternion = quat(node.quaternion_wxyz);
    group.position.copy(restPosition); group.quaternion.copy(restQuaternion);
    if (node.joint) {
      const j = node.joint;
      group.userData = { restPosition, restQuaternion, joint: j, axis: new THREE.Vector3(...j.axis).normalize(), pivot: new THREE.Vector3(...j.position) };
      joints.push(group);
    }
    for (const g of node.geometries) {
      if (g.type !== 'mesh' || !geometries[g.mesh]) continue;
      const mesh = new THREE.Mesh(geometries[g.mesh], materialOf(g.rgba));
      mesh.position.fromArray(g.position); mesh.quaternion.copy(quat(g.quaternion_wxyz));
      mesh.castShadow = shadows;
      group.add(mesh);
    }
    for (const c of node.children) group.add(body(c));
    return group;
  };
  return { root: body(spec.root), joints, spec };
}

function poseRobot(robot, qpos) {
  for (const group of robot.joints) {
    const d = group.userData, j = d.joint;
    if (j.type === 'free') { group.position.set(qpos[0], qpos[1], qpos[2]); group.quaternion.set(qpos[4], qpos[5], qpos[6], qpos[3]); continue; }
    const angle = qpos[j.qpos_index];
    tmp.q.setFromAxisAngle(d.axis, angle);
    group.quaternion.copy(d.restQuaternion).multiply(tmp.q);
    tmp.v.copy(d.pivot).applyQuaternion(tmp.q);
    tmp.w.copy(d.pivot).sub(tmp.v).applyQuaternion(d.restQuaternion);
    group.position.copy(d.restPosition).add(tmp.w);
  }
}

// The backdrop floor: a pale slab with a half-metre grid that fades to transparent, so it melts into the stage.
function floorTexture(renderer) {
  const px = 1024, c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d'), per = px / FLOOR_M;
  const fade = g.createRadialGradient(px / 2, px / 2, px * 0.1, px / 2, px / 2, px / 2);
  fade.addColorStop(0, 'rgba(252, 253, 254, 1)'); fade.addColorStop(0.5, 'rgba(246, 248, 250, 0.92)'); fade.addColorStop(1, 'rgba(240, 243, 246, 0)');
  g.fillStyle = fade; g.fillRect(0, 0, px, px);
  g.globalCompositeOperation = 'source-atop';
  for (let k = 0; k <= FLOOR_M * 2; k++) {
    const at = Math.round(k * per / 2) + 0.5;
    g.strokeStyle = k % 2 === 0 ? 'rgba(52, 70, 88, 0.11)' : 'rgba(52, 70, 88, 0.045)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(at, 0); g.lineTo(at, px); g.moveTo(0, at); g.lineTo(px, at); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

function paintCell(data, m, idx) {
  const n = m.n, i = Math.floor(idx / n), j = idx % n, k = (j * n + i) * 4;  // texel column i (x), row j (y)
  const code = m.codes[idx], rgba = MAP_RGBA[code];
  if (!rgba) { data[k + 3] = 0; return; }
  const shade = code === 3 ? Math.min(1, 0.65 + m.heights[idx] / 250) : 1;
  data[k] = rgba[0] * shade; data[k + 1] = rgba[1] * shade; data[k + 2] = rgba[2] * shade; data[k + 3] = rgba[3];
}

function boxMesh(b) {
  const height = b.z_top - b.z_bottom, overhead = b.z_bottom > 0.3;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.half_xy[0] * 2, b.half_xy[1] * 2, height),
    new THREE.MeshStandardMaterial({ color: overhead ? 0xb7a5cf : COLORS.box, roughness: 0.85, transparent: true, opacity: 0.8 }));
  mesh.position.set(b.center_xy[0], b.center_xy[1], b.z_bottom + height / 2);
  mesh.rotation.z = b.yaw ?? 0;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: overhead ? 0x8a6fb5 : 0x6f7f8e, transparent: true, opacity: 0.6 })));
  return mesh;
}

// Bytes with progress (0..1). A server may compress on the wire, so progress counts decoded bytes against the size
// the mesh index gives.
async function fetchBytes(url, total, onProgress, signal) {
  const r = ok(await fetch(url, { signal }));
  if (!r.body || !onProgress) {
    const bytes = await r.arrayBuffer();
    if (bytes.byteLength !== total) throw new Error(`${url}: expected ${total} mesh bytes, received ${bytes.byteLength}`);
    return bytes;
  }
  const reader = r.body.getReader(), out = new Uint8Array(total);
  let got = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (got + value.length > out.length) throw new Error(`${url}: larger than its index says`);
      out.set(value, got); got += value.length;
      onProgress(got / total);
    }
    if (got !== total) throw new Error(`${url}: expected ${total} mesh bytes, received ${got}`);
  } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  return out.buffer;
}

const quat = q => new THREE.Quaternion(q[1], q[2], q[3], q[0]);
const ok = r => { if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`); return r; };
function clear(group) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  for (const child of [...group.children]) {
    child.traverse(o => {
      if (o.geometry) geometries.add(o.geometry);
      if (o.material) for (const m of Array.isArray(o.material) ? o.material : [o.material]) { materials.add(m); if (m.map) textures.add(m.map); }
      o.shadow?.dispose();
    });
    group.remove(child);
  }
  for (const texture of textures) texture.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
}
