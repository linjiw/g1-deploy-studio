// The 3D view: one WebGL context for the whole page, rendered only when something changed.
// World frame as in Studio and MuJoCo: right-handed, Z up, metres; quaternions w, x, y, z.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { toCreasedNormals } from 'three/addons/utils/BufferGeometryUtils.js';

export const COLORS = {
  bg: 0x0b1117, floor: 0x111a21, grid: 0x1d2a33, teal: 0x56d9d0, amber: 0xefbb70, red: 0xf07870, violet: 0xc4a0d9,
  green: 0x7be0a5, box: 0x8fa4b3, white: 0xe6eef2, pink: 0xff6fb5, blue: 0x7fb4ff,
};
// The robot's map, one texel per 5 cm memory cell (Studio's palette): never observed cells stay transparent.
const MAP_RGBA = { 1: [38, 92, 96, 150], 2: [239, 187, 112, 215], 3: [240, 120, 112, 235], 4: [196, 160, 217, 215] };
const VOXEL_RGB = { 2: new THREE.Color(0xefbb70), 3: new THREE.Color(0xf07870), 4: new THREE.Color(0xc4a0d9) };
const MAX_VOXELS = 24000;

const tmp = { q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), m: new THREE.Matrix4(), s: new THREE.Vector3(), p: new THREE.Vector3() };

export class Viewer {
  constructor(container, { onPick, onHover } = {}) {
    this.container = container;
    const renderer = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'default' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(renderer.domElement);
    const scene = this.scene = new THREE.Scene();
    scene.background = new THREE.Color(COLORS.bg);
    scene.fog = new THREE.Fog(COLORS.bg, 14, 30);
    const camera = this.camera = new THREE.PerspectiveCamera(38, 1, 0.05, 80);
    camera.up.set(0, 0, 1);
    camera.position.set(-3.2, -4.6, 3.6);
    const controls = this.controls = new OrbitControls(camera, renderer.domElement);
    controls.target.set(1.2, 0, 0.4);
    controls.enableDamping = true; controls.dampingFactor = 0.12;
    controls.maxPolarAngle = Math.PI * 0.49; controls.minDistance = 1.2; controls.maxDistance = 22;
    // OrbitControls sets touch-action: none on the canvas; on touch screens let a vertical swipe scroll the page.
    if (window.matchMedia('(pointer: coarse)').matches) renderer.domElement.style.touchAction = 'pan-y';
    controls.addEventListener('change', () => this.dirty());
    controls.addEventListener('start', () => this.start());
    scene.add(new THREE.HemisphereLight(0xcfe8f0, 0x1a2228, 1.15));
    const sun = this.sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-3, -4, 8); sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    Object.assign(sun.shadow.camera, { left: -2.5, right: 2.5, top: 2.5, bottom: -2.5, near: 0.5, far: 20 });
    sun.shadow.bias = -0.0005;
    scene.add(sun, sun.target);
    const floor = this.floor = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), new THREE.MeshStandardMaterial({ color: COLORS.floor, roughness: 0.95 }));
    floor.receiveShadow = true; floor.name = 'floor';
    scene.add(floor);
    this.groups = {};
    for (const name of ['world', 'map', 'voxels', 'lidar', 'route', 'plan', 'trail', 'markers', 'outcomes', 'robot']) {
      const g = new THREE.Group(); g.name = name; this.groups[name] = g; scene.add(g);
    }
    this.lineMaterials = [];
    this.needsRender = true; this.running = false; this.visible = true;
    this.onFrame = null;
    this.robot = null;
    this.follow = false;
    this._resize = () => this.resize();
    new ResizeObserver(this._resize).observe(container);
    this.resize();
    this._pickSetup(onPick, onHover);
    new IntersectionObserver(entries => { this.visible = entries[0].isIntersecting; if (this.visible) this.start(); }, { threshold: 0.01 }).observe(container);
    this.start();
  }

  // ----- render loop: rAF only while visible; draw only when dirty, damping or a frame callback asks
  start() {
    if (this.running) return;
    this.running = true;
    let idle = 0;
    const tick = now => {
      if (!this.visible) { this.running = false; return; }
      const animating = this.onFrame ? this.onFrame(now) : false;
      const moved = this.controls.update();
      if (this.needsRender || moved || animating) { this.renderer.render(this.scene, this.camera); this.needsRender = false; idle = 0; }
      // Nothing moved for half a second (damping settled, no walk playing): stop until something changes.
      else if (++idle > 30) { this.running = false; return; }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }
  dirty() { this.needsRender = true; if (!this.running && this.visible) this.start(); }
  resize() {
    const w = this.container.clientWidth || 1, h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    for (const m of this.lineMaterials) m.resolution.set(w, h);
    this.dirty();
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
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, t: performance.now() }; });
    el.addEventListener('pointerup', e => {
      if (!down) return;
      const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y);
      if (moved < 7 && performance.now() - down.t < 600 && onPick) { const xy = toWorld(e); if (xy) onPick(xy); }
      down = null;
    });
    el.addEventListener('pointermove', e => {
      if (!onHover || e.pointerType === 'touch' || down) return;
      hoverPending = e;
      if (this._hoverQueued) return;
      this._hoverQueued = true;
      requestAnimationFrame(() => { this._hoverQueued = false; const xy = toWorld(hoverPending); onHover(xy); });
    });
    el.addEventListener('pointerleave', () => onHover && onHover(null));
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
    const flat = new Float32Array(points.length * 3);
    points.forEach((p, i) => { flat[i * 3] = p[0]; flat[i * 3 + 1] = p[1]; flat[i * 3 + 2] = p[2] ?? 0.02; });
    line.geometry.dispose();
    line.geometry = new LineGeometry();
    line.geometry.setPositions(flat);
    if (line.material.dashed) line.computeLineDistances();
    line.visible = true;
    this.dirty();
  }

  // ----- the real room (simulation geometry: shown only as the sim truth it is)
  setWorld(world) {
    clear(this.groups.world);
    const b = world.bounds, w = b.max[0] - b.min[0], h = b.max[1] - b.min[1];
    const grid = new THREE.GridHelper(Math.ceil(Math.max(w, h)) + 2, (Math.ceil(Math.max(w, h)) + 2) * 2, COLORS.grid, COLORS.grid);
    grid.rotation.x = Math.PI / 2; grid.position.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0.001);
    grid.material.transparent = true; grid.material.opacity = 0.55;
    this.groups.world.add(grid);
    this.boxes = new THREE.Group();
    for (const box of world.boxes) this.boxes.add(boxMesh(box));
    this.groups.world.add(this.boxes);
    // The start mark, as taped on the floor (build sheet): a cross and the heading arrow.
    const mark = new THREE.Group(), mat = new THREE.MeshBasicMaterial({ color: COLORS.white, transparent: true, opacity: 0.8 });
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
      const size = n * map.res_m;
      mesh.scale.set(size, size, 1);
      mesh.position.set(map.lo[0] + (n - 1) * map.res_m / 2, map.lo[1] + (n - 1) * map.res_m / 2, 0.005);
      clear(this.groups.voxels);
      const voxels = this.voxels = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial({ roughness: 0.7, transparent: true, opacity: 0.9 }), MAX_VOXELS);
      voxels.count = 0; voxels.frustumCulled = false;
      voxels.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(MAX_VOXELS * 3), 3);
      this.groups.voxels.add(voxels);
    }
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
  mapCodeAt(xy) {
    const m = this.map; if (!m) return null;
    const i = Math.round((xy[0] - m.lo[0]) / m.res), j = Math.round((xy[1] - m.lo[1]) / m.res);
    if (i < 0 || j < 0 || i >= m.n || j >= m.n) return null;
    return { code: m.codes[i * m.n + j], height_cm: m.heights[i * m.n + j] };
  }

  // ----- LiDAR returns (cm integers, x y z triples) and the sensor origin
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
      c.setHSL(0.47 - Math.min(1, Math.max(0, pts[k * 3 + 2] / 200)) * 0.3, 0.75, 0.62);
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
    const mesh = new THREE.InstancedMesh(new THREE.CircleGeometry(0.11, 20), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.7, depthWrite: false }), cells.length);
    cells.forEach((c, k) => {
      tmp.m.makeTranslation(c.xy[0], c.xy[1], 0.009);
      mesh.setMatrixAt(k, tmp.m); mesh.setColorAt(k, new THREE.Color(colorOf(c)));
    });
    mesh.renderOrder = 2;
    this.groups.outcomes.add(mesh);
    this.dirty();
  }

  dimOutcomes(dim) {
    for (const m of this.groups.outcomes.children) m.material.opacity = dim ? 0.22 : 0.7;
    this.dirty();
  }

  // ----- the robot
  async loadRobot(base) {
    const [spec, index, bin] = await Promise.all([
      fetch(`${base}/robot.json`).then(ok).then(r => r.json()),
      fetch(`${base}/meshes.json`).then(ok).then(r => r.json()),
      fetch(`${base}/meshes.bin`).then(ok).then(r => r.arrayBuffer())]);
    const geometries = {};
    for (const [name, m] of Object.entries(index.meshes)) {
      const q = new Uint16Array(bin, m.offset, m.vertices * 3), ind = new Uint16Array(bin, m.offset + m.vertices * 6, m.indices);
      const pos = new Float32Array(m.vertices * 3);
      for (let k = 0; k < m.vertices; k++) for (let a = 0; a < 3; a++) pos[k * 3 + a] = m.min[a] + q[k * 3 + a] / 65535 * (m.max[a] - m.min[a]);
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
      g.setIndex(new THREE.BufferAttribute(new Uint16Array(ind), 1));
      geometries[name] = toCreasedNormals(g, Math.PI / 5);
    }
    const materials = new Map();
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
        const key = g.rgba.join(',');
        if (!materials.has(key)) materials.set(key, new THREE.MeshStandardMaterial({ color: new THREE.Color(g.rgba[0], g.rgba[1], g.rgba[2]), roughness: 0.5, metalness: 0.25 }));
        const mesh = new THREE.Mesh(geometries[g.mesh], materials.get(key));
        mesh.position.fromArray(g.position); mesh.quaternion.copy(quat(g.quaternion_wxyz));
        mesh.castShadow = true;
        group.add(mesh);
      }
      for (const c of node.children) group.add(body(c));
      return group;
    };
    const root = body(spec.root);
    this.groups.robot.add(root);
    this.robot = { root, joints, spec };
    this.dirty();
    return this.robot;
  }
  // qpos: [x, y, z, qw, qx, qy, qz, 29 joint angles] in the model's qpos order (MuJoCo, named joints)
  setPose(qpos) {
    if (!this.robot) return;
    for (const group of this.robot.joints) {
      const d = group.userData, j = d.joint;
      if (j.type === 'free') { group.position.set(qpos[0], qpos[1], qpos[2]); group.quaternion.set(qpos[4], qpos[5], qpos[6], qpos[3]); continue; }
      const angle = qpos[j.qpos_index];
      tmp.q.setFromAxisAngle(d.axis, angle);
      group.quaternion.copy(d.restQuaternion).multiply(tmp.q);
      tmp.v.copy(d.pivot).applyQuaternion(tmp.q);
      tmp.w.copy(d.pivot).sub(tmp.v).applyQuaternion(d.restQuaternion);
      group.position.copy(d.restPosition).add(tmp.w);
    }
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
  frame(world, mode = 'orbit') {
    // Aim between the start mark and the room's centre: the robot and where it can go both stay in view.
    const b = world.bounds, s = world.start_xy;
    const cx = (s[0] + (b.min[0] + b.max[0]) / 2) / 2, cy = (s[1] + (b.min[1] + b.max[1]) / 2) / 2;
    const span = Math.max(b.max[0] - b.min[0], b.max[1] - b.min[1]);
    const narrow = this.camera.aspect < 0.9;
    if (mode === 'top') {
      this.controls.target.set((b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, 0);
      const fov = this.camera.fov * Math.PI / 180, fit = Math.max(b.max[1] - b.min[1], (b.max[0] - b.min[0]) / this.camera.aspect);
      this.camera.position.set(this.controls.target.x, this.controls.target.y - 0.01, fit / 2 / Math.tan(fov / 2) * 1.08);
    } else {
      this.controls.target.set(cx, cy, 0.3);
      const d = span * (narrow ? 1.15 : 0.66) + 1.2;
      this.camera.position.set(cx - d * 0.62, cy - d * 0.7, d * 0.58);
    }
    this.controls.update();
    this.dirty();
  }
  // Keep the viewing direction; move the target to the middle of the points and back off to see all of them.
  focus(points) {
    if (this.follow || !points.length) return;
    const cx = points.reduce((a, p) => a + p[0], 0) / points.length, cy = points.reduce((a, p) => a + p[1], 0) / points.length;
    const r = Math.max(1.6, ...points.map(p => Math.hypot(p[0] - cx, p[1] - cy)));
    const dir = tmp.v.copy(this.camera.position).sub(this.controls.target).normalize();
    const fov = this.camera.fov * Math.PI / 180, aspect = Math.min(1, this.camera.aspect);
    const d = Math.min(this.controls.maxDistance, (r + 1.2) / Math.tan(fov / 2) / aspect * 0.95);
    this.controls.target.set(cx, cy, 0.4);
    this.camera.position.copy(this.controls.target).addScaledVector(dir, d);
    this.controls.update();
    this.dirty();
  }
  dispose() { this.renderer.dispose(); }
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
    new THREE.MeshStandardMaterial({ color: overhead ? 0x9a86b0 : COLORS.box, roughness: 0.8, transparent: true, opacity: 0.8 }));
  mesh.position.set(b.center_xy[0], b.center_xy[1], b.z_bottom + height / 2);
  mesh.rotation.z = b.yaw ?? 0;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: overhead ? 0xc9a8e6 : 0xb8c8d4, transparent: true, opacity: 0.75 })));
  return mesh;
}

const quat = q => new THREE.Quaternion(q[1], q[2], q[3], q[0]);
const ok = r => { if (!r.ok) throw new Error(`${r.url}: HTTP ${r.status}`); return r; };
function clear(group) {
  for (const child of [...group.children]) {
    child.traverse(o => { o.geometry?.dispose(); if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(m => { m.map?.dispose(); m.dispose(); }); });
    group.remove(child);
  }
}
