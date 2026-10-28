// Three.js digital twin. Renders only on demand; geometry buffers are reused.
// Poses come from recorded/simulated frames; nothing here infers missing state.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { finite, hasPose, hasRoot, hasReferencePose, request, yawOf } from './util.js';
import { UI, SERIES, hex } from './palette.js';

// The scene's colours, as numbers. Same meaning as the site's viewer: the reference (what SONIC is asked to track) is
// a pink ghost, planned futures are amber, the executed path is teal, configured boxes are slate glass.
const C = Object.fromEntries(Object.entries(SERIES).map(([k, v]) => [k, hex(v)]));
const BACKDROP = 0xedf0f3;   // fog and the robot-view inset: the edge of the viewport's white-to-grey backdrop
const FLOOR_M = 60;          // the floor: a square this wide with a half-metre grid, fading out at its edge

const up = new THREE.Vector3(0, 0, 1);
const stl = new STLLoader();
const meshCache = new Map();          // content-addressed URL -> Promise<BufferGeometry>
const sharedGeometries = new Set();
const scratch = { q: new THREE.Quaternion(), v: new THREE.Vector3(), w: new THREE.Vector3(), m: new THREE.Matrix4() };

export const view = {
  scene: null, camera: null, renderer: null, controls: null, host: null,
  dirty: true, drawCount: 0, camera_mode: 'orbit', model: null,
  robot: null, ghost: null, futures: [], content: null, environment: null,
  mapLayer: null, sensorLayer: null, sensorOverlays: new Map(), lines: {}, markers: {},
  compareGroup: null, arenaGroup: null, robotView: false, robotCamera: null, onPick: null,
  layers: { robot: true, reference: true, future: true, trajectory: true, environment: true,
    navigation: true, perception: false, frames: false, sensors: true },
  lastPoseKey: null, followAnchor: new THREE.Vector3(), mapSample: null, session: null,
  minFrameMs: 0, beforeRender: null,
};

const quat = v => new THREE.Quaternion(v[1], v[2], v[3], v[0]);
export const markDirty = () => { view.dirty = true; };

// ----- Preallocated renderables -------------------------------------------------
function polyline(color, opacity = 1, capacity = 4096, width = 1) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setDrawRange(0, 0);
  const line = new THREE.Line(geometry, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, linewidth: width }));
  line.frustumCulled = false;
  line.userData.capacity = capacity;
  return line;
}
function setPolyline(line, points, z = null) {
  const attr = line.geometry.getAttribute('position');
  const n = Math.min(points.length, line.userData.capacity);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    attr.array[i * 3] = p[0]; attr.array[i * 3 + 1] = p[1]; attr.array[i * 3 + 2] = z ?? p[2] ?? 0.02;
  }
  attr.needsUpdate = true;
  line.geometry.setDrawRange(0, n);
  line.geometry.computeBoundingSphere();
}
function pointLayer(color, size, capacity = 6000, opacity = 0.85) {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(capacity * 3), 3));
  geometry.setDrawRange(0, 0);
  const points = new THREE.Points(geometry, new THREE.PointsMaterial({ color, size, transparent: true, opacity, sizeAttenuation: true, depthWrite: false }));
  points.frustumCulled = false;
  points.userData.capacity = capacity;
  return points;
}
function setPoints(layer, points) {
  const attr = layer.geometry.getAttribute('position');
  const n = Math.min(points?.length ?? 0, layer.userData.capacity);
  for (let i = 0; i < n; i++) {
    const p = points[i];
    attr.array[i * 3] = p[0]; attr.array[i * 3 + 1] = p[1]; attr.array[i * 3 + 2] = p[2];
  }
  attr.needsUpdate = true;
  layer.geometry.setDrawRange(0, n);
  return n;
}

// Labels read as quiet white pills with a dot of the marker's colour (the site's goal chip), in sentence case.
// A red marker (an unverified or rejected goal) gets a red pill and red text, so its warning reads at a glance.
// Marker names stay upper case: tools find markers by name ('GOAL', 'START').
const caption = text => text.toLowerCase().replace(/^./, c => c.toUpperCase()).replace(/\blio\b/gi, 'LIO');
function label(text, color, { raw = false } = {}) {
  // raw: the text as given (Deploy writes its labels in sentence case with units, e.g. "60 N")
  const canvas = document.createElement('canvas');
  const font = '600 26px Inter, system-ui, sans-serif', shown = raw ? text : caption(text);
  const probe = canvas.getContext('2d'); probe.font = font;
  // Wide enough for the text: longer labels get a wider sprite at the same height (no clipping).
  const textWidth = Math.ceil(probe.measureText(shown).width), pill = textWidth + 60;
  const width = Math.max(128, Math.ceil((pill + 16) / 32) * 32);
  canvas.width = width; canvas.height = 64;
  const ctx = canvas.getContext('2d'), x = (width - pill) / 2, warn = color === C.red;
  ctx.shadowColor = 'rgba(16, 24, 40, 0.2)'; ctx.shadowBlur = 10; ctx.shadowOffsetY = 2;
  ctx.fillStyle = warn ? 'rgba(253, 238, 238, 0.97)' : 'rgba(255, 255, 255, 0.95)'; ctx.beginPath(); ctx.roundRect(x, 10, pill, 44, 22); ctx.fill();
  ctx.shadowColor = 'transparent'; ctx.strokeStyle = warn ? 'rgba(194, 52, 52, 0.45)' : 'rgba(16, 22, 28, 0.12)'; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.fillStyle = `#${color.toString(16).padStart(6, '0')}`; ctx.beginPath(); ctx.arc(x + 23, 32, 7, 0, Math.PI * 2); ctx.fill();
  ctx.font = font; ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = warn ? UI.badText : UI.ink; ctx.fillText(shown, x + 39, 33);
  const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: false, sizeAttenuation: false }));
  sprite.scale.set(0.11 * width / 256, 0.0275, 1);
  sprite.renderOrder = 10;
  return sprite;
}
function navMarker(text, color, radius = 0.22, heading = false) {
  const group = new THREE.Group(); group.name = text;
  const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.03, radius, 48), new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide, transparent: true, opacity: 0.9, depthWrite: false }));
  ring.position.z = 0.03; group.add(ring);
  const disc = new THREE.Mesh(new THREE.CircleGeometry(radius - 0.03, 48), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.12, side: THREE.DoubleSide, depthWrite: false }));
  disc.position.z = 0.028; group.add(disc);
  const tag = label(text, color); tag.position.z = heading ? 0.42 : 0.7; tag.center.set(0.5, 0); group.add(tag);
  if (heading) {
    const arrow = new THREE.Group(); arrow.name = 'heading';
    arrow.add(new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 0, 0.04), 0.5, color, 0.14, 0.09));
    group.add(arrow);
  } else {
    const pole = polyline(color, 0.7, 2); setPolyline(pole, [[0, 0, 0.03], [0, 0, 0.6]]); group.add(pole);
  }
  return group;
}

// Configured boxes: slate glass with darker edges (overhead beams violet), as on the site. Translucent so the robot
// stays visible behind a wall; the boxes are simulator geometry, not something the robot observed.
function boxMesh(b, { opacity = 0.32 } = {}) {
  const height = b.z_top - b.z_bottom;
  const overhead = b.z_bottom > 0.05;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(b.half_xy[0] * 2, b.half_xy[1] * 2, height),
    new THREE.MeshStandardMaterial({ color: overhead ? C.overhead : C.box, roughness: 0.85, transparent: true, opacity, depthWrite: false }));
  mesh.position.set(b.center_xy[0], b.center_xy[1], b.z_bottom + height / 2);
  mesh.rotation.z = b.yaw ?? 0;
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry), new THREE.LineBasicMaterial({ color: overhead ? C.overheadEdge : C.boxEdge, transparent: true, opacity: 0.7 })));
  if (overhead) {
    // A faint footprint shows where an overhead obstacle is, without implying a floor obstacle.
    const foot = new THREE.Mesh(new THREE.PlaneGeometry(b.half_xy[0] * 2, b.half_xy[1] * 2), new THREE.MeshBasicMaterial({ color: C.overhead, transparent: true, opacity: 0.18, depthWrite: false }));
    foot.position.set(0, 0, -height / 2 - b.z_bottom + 0.012); mesh.add(foot);
  }
  return mesh;
}

// The floor: a pale slab with a half-metre grid (whole metres darker) that fades to transparent, as on the site.
function floorTexture(renderer) {
  const px = 2048, c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d'), per = px / FLOOR_M;
  const fade = g.createRadialGradient(px / 2, px / 2, px * 0.08, px / 2, px / 2, px / 2);
  fade.addColorStop(0, 'rgba(252, 253, 254, 1)'); fade.addColorStop(0.55, 'rgba(246, 248, 250, 0.92)'); fade.addColorStop(1, 'rgba(240, 243, 246, 0)');
  g.fillStyle = fade; g.fillRect(0, 0, px, px);
  g.globalCompositeOperation = 'source-atop';
  for (let k = 0; k <= FLOOR_M * 2; k++) {
    const at = Math.round(k * per / 2) + 0.5;
    g.strokeStyle = k % 2 === 0 ? 'rgba(52, 70, 88, 0.12)' : 'rgba(52, 70, 88, 0.05)'; g.lineWidth = 1;
    g.beginPath(); g.moveTo(at, 0); g.lineTo(at, px); g.moveTo(0, at); g.lineTo(px, at); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  return t;
}

// ----- Scene setup ------------------------------------------------------------
export function initScene(host, { onPick } = {}) {
  view.host = host; view.onPick = onPick;
  const scene = view.scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(BACKDROP, 0.02);
  const camera = view.camera = new THREE.PerspectiveCamera(42, 1, 0.01, 300);
  camera.up.copy(up); camera.position.set(3.5, -4.3, 2.4);
  const renderer = view.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
  renderer.setClearColor(0x000000, 0);
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap; renderer.shadowMap.autoUpdate = false;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  host.appendChild(renderer.domElement);
  const controls = view.controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true; controls.dampingFactor = 0.1;
  controls.target.set(0, 0, 0.65); controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 0.4; controls.maxDistance = 80;
  controls.addEventListener('change', markDirty);
  controls.addEventListener('start', () => { view.userOrbiting = true; });
  controls.addEventListener('end', () => { view.userOrbiting = false; });

  // The site's light: a cool sky and one soft key light that follows the robot for its shadow.
  const sky = new THREE.HemisphereLight(0xf4f8fb, 0x8a96a2, 1.35); sky.position.set(0, 0, 1); scene.add(sky);  // Z is up here
  const key = new THREE.DirectionalLight(0xffffff, 1.5); key.position.set(3, -4, 7); key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048); Object.assign(key.shadow.camera, { left: -8, right: 8, top: 8, bottom: -8 });
  key.shadow.normalBias = 0.015; scene.add(key); scene.add(key.target); view.key = key;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(FLOOR_M, FLOOR_M),
    new THREE.MeshStandardMaterial({ map: floorTexture(renderer), transparent: true, depthWrite: false, roughness: 1, metalness: 0 }));
  floor.position.z = -0.01; floor.receiveShadow = true; floor.renderOrder = -1; scene.add(floor);
  view.floor = floor;
  // World axes (the Coordinate frames layer, off by default): thin and short, at the origin.
  view.worldAxes = new THREE.AxesHelper(0.4); view.worldAxes.position.z = 0.015; view.worldAxes.material.transparent = true; view.worldAxes.material.opacity = 0.7; scene.add(view.worldAxes);

  view.content = new THREE.Group(); scene.add(view.content);
  view.sensorLayer = new THREE.Group(); scene.add(view.sensorLayer);
  view.compareGroup = new THREE.Group(); scene.add(view.compareGroup);
  view.arenaGroup = new THREE.Group(); view.arenaGroup.visible = false; scene.add(view.arenaGroup);
  view.robotCamera = new THREE.PerspectiveCamera(84, 16 / 9, 0.05, 40); view.robotCamera.up.copy(up);

  let pointerStart = null;
  renderer.domElement.addEventListener('pointerdown', e => { pointerStart = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!view.onPick || !pointerStart || Math.hypot(e.clientX - pointerStart[0], e.clientY - pointerStart[1]) > 5) return;
    const rect = renderer.domElement.getBoundingClientRect(), ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((e.clientX - rect.left) / rect.width * 2 - 1, -(e.clientY - rect.top) / rect.height * 2 + 1), camera);
    const hit = ray.ray.intersectPlane(new THREE.Plane(up, 0), new THREE.Vector3());
    if (hit) view.onPick([hit.x, hit.y], e);
  });
  new ResizeObserver(() => {
    const { width, height } = host.getBoundingClientRect();
    if (width < 2 || height < 2) return;
    camera.aspect = width / height; camera.updateProjectionMatrix(); renderer.setSize(width, height); markDirty();
    if (view.camera_mode === 'scene' && view.session) fitScene();
  }).observe(host);
  renderer.domElement.addEventListener('webglcontextlost', () =>
    window.dispatchEvent(new CustomEvent('studio:error', { detail: 'The 3D rendering context was lost. Reload to restore the scene; recorded data is unchanged.' })));
  requestAnimationFrame(loop);
}

function loop(now = performance.now()) {
  if (view.renderer) {
    const moving = view.controls.update();
    // view.minFrameMs (0 = every animation frame) caps the frame rate; Deploy sets it to 33 (30 fps).
    const capped = view.minFrameMs > 0 && now - (view.lastRenderAt ?? -Infinity) < view.minFrameMs;
    if ((view.dirty || moving) && capped) view.dirty = true;
    else if (view.dirty || moving) {
      view.beforeRender?.(now);
      const r = view.renderer, size = r.getSize(new THREE.Vector2());
      r.setScissorTest(false); r.setViewport(0, 0, size.x, size.y);
      r.render(view.scene, view.camera);
      if (view.robotView && view.robotViewReady) renderRobotView(size);
      view.drawCount++; view.dirty = false; view.lastRenderAt = now;
    }
  }
  requestAnimationFrame(loop);
}

// ----- Robot model ------------------------------------------------------------
async function geometry(spec) {
  if (spec.type === 'mesh') {
    if (!meshCache.has(spec.url)) meshCache.set(spec.url, stl.loadAsync(spec.url).then(g => { sharedGeometries.add(g); return g; }));
    return meshCache.get(spec.url);
  }
  const s = spec.size;
  if (spec.type === 'box') return new THREE.BoxGeometry(s[0] * 2, s[1] * 2, s[2] * 2);
  if (spec.type === 'sphere') return new THREE.SphereGeometry(s[0], 16, 12);
  if (spec.type === 'cylinder' || spec.type === 'capsule') {
    const g = spec.type === 'capsule' ? new THREE.CapsuleGeometry(s[0], s[1] * 2, 6, 12) : new THREE.CylinderGeometry(s[0], s[0], s[1] * 2, 16);
    g.rotateX(Math.PI / 2); return g;
  }
  throw new Error(`Unsupported model geometry ${spec.type}`);
}

async function buildRobot(spec, jointNames, ghost = null) {
  const joints = [];
  // Ghosts are pushed back in depth by a hair: where the reference coincides with the executed body the robot wins,
  // so the ghost shows where the two differ (by more than the depth tolerance, about a centimetre at orbit distance)
  // and the robot keeps its own colour.
  const ghostMaterial = ghost ? new THREE.MeshStandardMaterial({ color: ghost.color ?? C.ghost, transparent: true, opacity: ghost.opacity, roughness: 0.6, metalness: 0, depthWrite: false,
    emissive: ghost.color ?? C.ghost, emissiveIntensity: 0.3, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }) : null;
  async function body(node) {
    const group = new THREE.Group(); group.name = node.name;
    const restPosition = new THREE.Vector3(...node.position), restQuaternion = quat(node.quaternion_wxyz);
    group.position.copy(restPosition); group.quaternion.copy(restQuaternion);
    if (node.joint) {
      const j = node.joint;
      group.userData = { restPosition, restQuaternion, joint: j, axis: new THREE.Vector3(...j.axis).normalize(),
        pivot: new THREE.Vector3(...j.position), nameIndex: jointNames.indexOf(j.name) };
      joints.push(group);
    }
    for (const g of node.geometries) {
      const rgba = g.rgba ?? [0.65, 0.68, 0.7, 1];
      const material = ghostMaterial ?? new THREE.MeshStandardMaterial({ color: new THREE.Color(rgba[0], rgba[1], rgba[2]), roughness: 0.55, metalness: 0.22 });
      const mesh = new THREE.Mesh(await geometry(g), material);
      mesh.position.fromArray(g.position); mesh.quaternion.copy(quat(g.quaternion_wxyz));
      if (g.scale) mesh.scale.fromArray(g.scale);
      mesh.castShadow = !ghost; mesh.receiveShadow = !ghost; mesh.renderOrder = ghost ? 2 : 0;
      group.add(mesh);
    }
    const children = await Promise.all(node.children.map(body));
    if (children.length) group.add(...children);
    return group;
  }
  const root = await body(spec.root);
  return { root, joints, material: ghostMaterial };
}

function pose(model, frame, reference = null) {
  const p = reference?.position ?? frame.position, q = reference?.quaternion_wxyz ?? frame.quaternion_wxyz;
  for (const group of model.joints) {
    const d = group.userData, j = d.joint;
    if (j.type === 'free') { group.position.fromArray(p); group.quaternion.set(q[1], q[2], q[3], q[0]); continue; }
    const angle = reference && d.nameIndex >= 0 ? reference.joints[d.nameIndex] : frame.qpos[j.qpos_index];
    if (!finite(angle)) continue;
    scratch.q.setFromAxisAngle(d.axis, angle);
    group.quaternion.copy(d.restQuaternion).multiply(scratch.q);
    // Rotate about the joint pivot: offset = (pivot - R·pivot) in the parent frame.
    scratch.v.copy(d.pivot).applyQuaternion(scratch.q);
    scratch.w.copy(d.pivot).sub(scratch.v).applyQuaternion(d.restQuaternion);
    group.position.copy(d.restPosition).add(scratch.w);
  }
}

function disposeGroup(group) {
  group.traverse(obj => {
    if (obj.material) for (const m of Array.isArray(obj.material) ? obj.material : [obj.material]) { m.map?.dispose(); m.dispose(); }
    if (obj.geometry && !sharedGeometries.has(obj.geometry)) obj.geometry.dispose();
  });
  group.clear();
}

export function clearSessionScene() {
  disposeGroup(view.content);
  Object.assign(view, { robot: null, ghost: null, futures: [], environment: null, mapLayer: null, lines: {}, markers: {}, mapSample: null, lastPoseKey: null, robotViewReady: false });
  for (const id of [...view.sensorOverlays.keys()]) removeSensorOverlay(id);
  markDirty();
}

export async function loadSessionScene(session, id, isCurrent) {
  const spec = session.metadata.model_path ? await request(`/api/model?id=${encodeURIComponent(id)}`, undefined, { cache: 'no-cache' }) : null;
  // A live robot link may stream the LIO pose before (or without) the runner's joints: build the scene for it too.
  const worldAvailable = session.frames.some(hasPose) || session.frames.some(hasRoot);
  const names = session.joint_names ?? [];
  const [main, ref] = worldAvailable && spec
    ? await Promise.all([buildRobot(spec, names), buildRobot(spec, names, { opacity: 0.26 })]) : [null, null];
  if (!isCurrent()) return null;
  clearSessionScene();
  view.session = session; view.model = spec; view.robot = main; view.ghost = ref;
  if (main) view.content.add(main.root, ref.root);
  const env = view.environment = new THREE.Group();
  for (const b of session.environment?.boxes ?? []) {
    if (Array.isArray(b.center_xy) && Array.isArray(b.half_xy) && b.z_top > b.z_bottom) env.add(boxMesh(b));
  }
  view.content.add(env);
  view.mapLayer = new THREE.Group();
  view.mapLayer.add(pointLayer(C.support, 0.04, 8000, 0.75), pointLayer(C.ceiling, 0.04, 8000, 0.75));
  view.content.add(view.mapLayer);
  const L = view.lines;
  L.trajectory = polyline(C.path, 0.8, 8192); setPolyline(L.trajectory, session.trajectory ?? [], 0.02);
  L.future = polyline(C.future, 1, 512); L.reference = polyline(C.reference, 0.9, 64); L.travelled = polyline(C.travelled, 1, 8192);
  view.content.add(L.trajectory, L.future, L.reference, L.travelled);
  view.robotAxes = new THREE.AxesHelper(0.25); view.content.add(view.robotAxes);
  view.rootMarker = navMarker('LIO POSE · NO JOINTS', C.blue, 0.3, true); view.rootMarker.visible = false;
  view.content.add(view.rootMarker);
  view.waypoint = new THREE.Mesh(new THREE.RingGeometry(0.09, 0.13, 32), new THREE.MeshBasicMaterial({ color: C.future, side: THREE.DoubleSide, transparent: true, opacity: 0.9 }));
  view.content.add(view.waypoint);
  const m = session.metadata;
  if (m.goal_xy?.length === 2) {
    view.markers.goal = navMarker('GOAL', C.goal, m.navigation_criteria?.goal_radius_m ?? 0.3);
    view.markers.goal.position.set(m.goal_xy[0], m.goal_xy[1], 0); view.content.add(view.markers.goal);
  }
  if (m.start_xy?.length === 2) {
    view.markers.start = navMarker('START', C.start, 0.22, finite(m.start_yaw_rad));
    view.markers.start.position.set(m.start_xy[0], m.start_xy[1], 0);
    const arrow = view.markers.start.getObjectByName('heading'); if (arrow) arrow.rotation.z = m.start_yaw_rad;
    view.content.add(view.markers.start);
  }
  if (session.frames.some(hasReferencePose) && spec) {
    const previews = await Promise.all([buildRobot(spec, names, { opacity: 0.12, color: C.future }), buildRobot(spec, names, { opacity: 0.07, color: C.future })]);
    if (!isCurrent()) return null;
    view.futures = previews; previews.forEach(p => view.content.add(p.root));
  }
  view.robotViewReady = worldAvailable;
  centreFloor();
  view.renderer.shadowMap.needsUpdate = true;
  applyLayers(); markDirty();
  return { worldAvailable };
}

// ----- Per-frame update -------------------------------------------------------
export function renderFrameScene(state) {
  const f = state.frame, measured = state.measuredFrame ?? f;
  if (!f || !view.robot) { applyLayers(state); return; }
  const key = `${state.frameIndex}:${state.frozenFrame ? state.frozenFrame.time : ''}`;
  const posed = hasPose(measured), rooted = !posed && hasRoot(measured);
  if (key !== view.lastPoseKey && (posed || rooted)) {
    view.lastPoseKey = key;
    if (posed) pose(view.robot, measured);
    if (view.rootMarker) {
      view.rootMarker.userData.rooted = rooted;
      if (rooted) {
        view.rootMarker.position.set(measured.position[0], measured.position[1], 0);
        const arrow = view.rootMarker.getObjectByName('heading'); if (arrow) arrow.rotation.z = yawOf(measured.quaternion_wxyz) ?? 0;
      }
    }
    if (posed && hasReferencePose(f)) {
      pose(view.ghost, f, f.reference);
      const window = f.reference.window ?? [];
      view.futures.forEach((p, i) => { const w = window[Math.min(window.length - 1, i === 0 ? 4 : 9)]; if (w) pose(p, f, w); });
    }
    view.robotAxes.position.fromArray(measured.position); view.robotAxes.quaternion.copy(quat(measured.quaternion_wxyz));
    setPolyline(view.lines.future, f.plan?.future ?? [], null);
    setPolyline(view.lines.reference, f.reference?.window?.map(w => w.position) ?? [], null);
    const frames = state.session.frames, upto = [];
    const step = Math.max(1, Math.ceil(state.frameIndex / 4000));
    for (let i = 0; i <= state.frameIndex; i += step) if (hasRoot(frames[i])) upto.push(frames[i].position);
    upto.push(measured.position);
    setPolyline(view.lines.travelled, upto, 0.025);
    if (f.plan?.waypoint) view.waypoint.position.set(f.plan.waypoint[0], f.plan.waypoint[1], 0.015);
    // Navigation sessions change goals over time: the marker shows the goal at the cursor.
    const goal = f.navigation?.goal_xy;
    if (Array.isArray(goal)) {
      if (!view.markers.goal) { view.markers.goal = navMarker('GOAL', C.goal, 0.4); view.content.add(view.markers.goal); }
      view.markers.goal.position.set(goal[0], goal[1], 0);
      view.markers.goal.userData.hidden = false;
    } else if (f.navigation && view.markers.goal) view.markers.goal.userData.hidden = true;
    view.key.position.set(measured.position[0] + 3, measured.position[1] - 4, 7);
    view.key.target.position.set(measured.position[0], measured.position[1], 0);
    view.renderer.shadowMap.needsUpdate = true;
    followCamera(measured.position, state.playing);
  }
  applyLayers(state);
  markDirty();
}

function followCamera(position, playing) {
  const target = scratch.v.fromArray(position);
  if (view.camera_mode === 'follow' || view.camera_mode === 'top') {
    const delta = target.clone().sub(view.followAnchor); delta.z = 0;
    view.camera.position.add(delta); view.controls.target.add(delta); view.followAnchor.copy(target);
  } else if (view.camera_mode === 'orbit' && playing && !view.userOrbiting) {
    // Auto-recenter when the robot leaves the central part of the frame (review UX-2).
    const ndc = target.clone().setZ(0.7).project(view.camera);
    if (Math.abs(ndc.x) > 0.72 || Math.abs(ndc.y) > 0.72 || ndc.z > 1) {
      const delta = new THREE.Vector3(target.x - view.controls.target.x, target.y - view.controls.target.y, 0);
      view.camera.position.add(delta); view.controls.target.add(delta);
    }
  }
}

export function applyLayers(state = {}) {
  const L = view.layers, f = state.frame, m = state.measuredFrame ?? f;
  if (view.robot) view.robot.root.visible = L.robot && hasPose(m);
  if (view.rootMarker) view.rootMarker.visible = L.robot && !hasPose(m) && hasRoot(m);
  if (view.ghost) view.ghost.root.visible = L.reference && hasReferencePose(f);
  view.futures.forEach(p => { p.root.visible = L.future && !!f?.reference; });
  if (view.lines.trajectory) {
    view.lines.trajectory.visible = L.trajectory; view.lines.travelled.visible = L.trajectory;
    view.lines.future.visible = L.future && !!f?.plan; view.lines.reference.visible = L.reference && !!f?.reference;
  }
  if (view.waypoint) view.waypoint.visible = L.future && !!f?.plan?.waypoint;
  if (view.environment) view.environment.visible = L.environment;
  // In Navigate the map texture shows the whole memory; the decimated points would only add noise.
  if (view.mapLayer) view.mapLayer.visible = L.perception && !!view.session?.perception?.available && !view.navMapActive;
  if (view.navMap) view.navMap.visible = L.perception && !!view.navMapActive;
  for (const marker of Object.values(view.markers)) marker.visible = L.navigation && !marker.userData.hidden;
  if (view.robotAxes) view.robotAxes.visible = L.frames && hasRoot(m);
  view.worldAxes.visible = L.frames;
  view.sensorLayer.visible = L.sensors;
  markDirty();
}

export function setMapSample(sample) {
  if (!view.mapLayer || sample === view.mapSample) return;
  view.mapSample = sample;
  const [support, ceiling] = view.mapLayer.children;
  const size = Math.max(0.03, (sample?.resolution_m ?? 0.05) * 0.75);
  support.material.size = ceiling.material.size = size;
  setPoints(support, sample?.support_points ?? []);
  setPoints(ceiling, sample?.ceiling_points ?? []);
  markDirty();
}

export function setSensorOverlay(sensor) {
  const points = sensor.payload?.points;
  if (!sensor.overlay_compatible || !Array.isArray(points) || !points.length) { removeSensorOverlay(sensor.id); return; }
  let layer = view.sensorOverlays.get(sensor.id);
  if (!layer) {
    const color = sensor.id.includes('raw') ? C.violet : sensor.id.includes('ceiling') ? C.overheadEdge : C.travelled;
    layer = pointLayer(color, 0.035, 6000, 0.9);
    view.sensorOverlays.set(sensor.id, layer); view.sensorLayer.add(layer);
  }
  if (layer.userData.key !== `${sensor.source_time}:${points.length}`) {
    layer.userData.key = `${sensor.source_time}:${points.length}`;
    setPoints(layer, points);
  }
  markDirty();
}
export function removeSensorOverlay(id) {
  const layer = view.sensorOverlays.get(id);
  if (!layer) return;
  layer.geometry.dispose(); layer.material.dispose(); view.sensorLayer.remove(layer); view.sensorOverlays.delete(id); markDirty();
}

// ----- Cameras ----------------------------------------------------------------
export function cameraView(kind, state, reset = false) {
  view.camera_mode = kind;
  if (kind === 'scene') { fitScene(); return; }
  view.scene.fog.density = 0.02;
  const root = state?.measuredFrame?.position ?? state?.frame?.position ?? view.session?.metadata?.start_xy?.concat?.([0.75]) ?? [0, 0, 0.75];
  view.controls.target.set(root[0], root[1], 0.7);
  view.followAnchor.fromArray(root);
  view.controls.enableRotate = kind !== 'top';
  if (kind === 'top') view.camera.position.set(root[0], root[1] - 0.001, 7.5);
  else if (reset || kind === 'follow') {
    const yaw = yawOf(state?.measuredFrame?.quaternion_wxyz) ?? -0.6;
    // Behind-and-above the robot along its heading for Follow, a 3/4 view for Orbit.
    const back = kind === 'follow' ? yaw + Math.PI : -0.95;
    view.camera.position.set(root[0] + Math.cos(back) * 3.6, root[1] + Math.sin(back) * 3.6, 2.4);
  }
  view.controls.update(); markDirty();
}

// Straight-down view showing `half` metres around `center` (Navigate: the robot's 12 x 12 m memory).
// lift: move the subject up by this fraction of the half-height (Navigate keeps the robot above its stage bar).
export function topView(center, half = 5, { lift = 0 } = {}) {
  view.camera_mode = 'top';
  const height = half / Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2)) / Math.min(1, Math.max(0.3, view.camera.aspect));
  const dy = lift * height * Math.tan(THREE.MathUtils.degToRad(view.camera.fov / 2));
  view.scene.fog.density = Math.min(0.02, 1 / Math.max(1, height));
  view.controls.maxDistance = Math.max(80, height * 2); view.camera.far = Math.max(300, height * 3); view.camera.updateProjectionMatrix();
  view.controls.target.set(center[0], center[1] - dy, 0);
  view.followAnchor.set(center[0], center[1], center[2] ?? 0.75);
  view.camera.position.set(center[0], center[1] - dy - 0.001, height);
  view.controls.enableRotate = false; view.controls.update(); markDirty();
}

export function sceneBounds(extraPoints = []) {
  const bounds = new THREE.Box3();
  if (view.environment?.children.length) bounds.expandByObject(view.environment);
  for (const p of view.session?.trajectory ?? []) if (p.length >= 3) bounds.expandByPoint(scratch.v.set(p[0], p[1], p[2]));
  for (const p of [view.session?.metadata?.start_xy, view.session?.metadata?.goal_xy, ...extraPoints])
    if (p?.length >= 2) bounds.expandByPoint(scratch.v.set(p[0], p[1], 0));
  if (view.arenaGroup.visible && view.arenaGroup.children.length) bounds.expandByObject(view.arenaGroup);
  if (view.compareGroup.children.length) bounds.expandByObject(view.compareGroup);
  if (bounds.isEmpty()) bounds.setFromCenterAndSize(new THREE.Vector3(0, 0, 0.7), new THREE.Vector3(3, 3, 1.4));
  return bounds.expandByScalar(0.6);
}

// The grid is drawn in whole metres: centre the floor on a whole metre near the scene.
function centreFloor() {
  const c = sceneBounds().getCenter(new THREE.Vector3());
  view.floor.position.set(Math.round(c.x), Math.round(c.y), view.floor.position.z);
}

export function fitScene(bounds = sceneBounds()) {
  const center = bounds.getCenter(new THREE.Vector3()), size = bounds.getSize(new THREE.Vector3());
  const cam = view.camera;
  const distance = Math.max(size.y, size.x / Math.max(0.01, cam.aspect)) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)));
  const elevation = Math.max(0, bounds.max.z) + distance * 1.18;
  view.controls.maxDistance = Math.max(80, elevation * 2); cam.far = Math.max(300, elevation * 3); cam.updateProjectionMatrix();
  view.scene.fog.density = Math.min(0.02, 1 / Math.max(1, elevation));
  // Slight tilt keeps wall heights readable while showing the full layout.
  view.controls.target.set(center.x, center.y, 0);
  cam.position.set(center.x, center.y - elevation * 0.32, elevation);
  view.controls.enableRotate = true; view.controls.update(); markDirty();
}

// Sensor-viewpoint inset: from the recorded MID-360 mount, looking along the pelvis heading.
export function setRobotView(enabled) { view.robotView = enabled; markDirty(); }
function renderRobotView(size) {
  const state = window.__studio?.state, m = state?.measuredFrame;
  if (!hasPose(m)) return;
  const mount = view.mapSample?.extrinsics?.[0] ?? state?.session?.perception?.frames?.[0]?.extrinsics?.[0];
  const pelvis = quat(m.quaternion_wxyz);
  const offset = scratch.v.fromArray(mount?.position_m ?? [0.0, 0.0, 0.45]).applyQuaternion(pelvis);
  const cam = view.robotCamera;
  cam.position.set(m.position[0] + offset.x, m.position[1] + offset.y, m.position[2] + offset.z);
  const yaw = yawOf(m.quaternion_wxyz) ?? 0;
  cam.lookAt(cam.position.x + Math.cos(yaw) * 3, cam.position.y + Math.sin(yaw) * 3, cam.position.z - 0.55);
  const w = Math.round(Math.min(360, size.x * 0.34)), h = Math.round(w * 9 / 16);
  const x = size.x - w - 14, y = 14;
  cam.aspect = w / h; cam.updateProjectionMatrix();
  const r = view.renderer;
  const robotVisible = view.robot?.root.visible, ghostVisible = view.ghost?.root.visible;
  if (view.robot) view.robot.root.visible = false;
  if (view.ghost) view.ghost.root.visible = false;
  const futureVisible = view.futures.map(p => p.root.visible);
  view.futures.forEach(p => { p.root.visible = false; });
  // The inset shows what the robot perceives: map cells and pinned returns are
  // always drawn here (no fog), even when hidden in the main view.
  const fog = view.scene.fog, mapVisible = view.mapLayer?.visible, sensorsVisible = view.sensorLayer.visible;
  view.scene.fog = null;
  if (view.mapLayer && view.session?.perception?.available) view.mapLayer.visible = true;
  view.sensorLayer.visible = true;
  r.setScissorTest(true); r.setScissor(x, y, w, h); r.setViewport(x, y, w, h);
  r.setClearColor(BACKDROP, 1); r.clear(); r.render(view.scene, cam);
  r.setClearColor(0x000000, 0); r.setScissorTest(false);
  view.scene.fog = fog; if (view.mapLayer) view.mapLayer.visible = mapVisible; view.sensorLayer.visible = sensorsVisible;
  if (view.robot) view.robot.root.visible = robotVisible;
  if (view.ghost) view.ghost.root.visible = ghostVisible;
  view.futures.forEach((p, i) => { p.root.visible = futureVisible[i]; });
  view.robotViewRect = { x, y: size.y - y - h, w, h };
}

// ----- Overlays: run comparison and arena preview -------------------------------
export function setComparison(runs = []) {
  disposeGroup(view.compareGroup);
  for (const run of runs) {
    if (!run.trajectory?.length) continue;
    const line = polyline(run.color, 0.95, run.trajectory.length + 1);
    setPolyline(line, run.trajectory.map(p => [p[1], p[2], 0.03]), 0.03);
    view.compareGroup.add(line);
    const end = new THREE.Mesh(new THREE.CircleGeometry(0.06, 20), new THREE.MeshBasicMaterial({ color: run.color }));
    const last = run.trajectory.at(-1); end.position.set(last[1], last[2], 0.035); view.compareGroup.add(end);
  }
  markDirty();
}

export function setArenaPreview(arena, markers = {}) {
  disposeGroup(view.arenaGroup);
  view.arenaGroup.visible = !!arena;
  view.content.visible = !arena;
  view.sensorLayer.visible = !arena && view.layers.sensors;
  document.body.classList.toggle('arena-preview', !!arena);
  view.renderer.shadowMap.needsUpdate = true;
  if (!arena) { markDirty(); return; }
  for (const b of arena.boxes ?? []) if (b.z_top > b.z_bottom) view.arenaGroup.add(boxMesh(b, { opacity: 0.45 }));
  if (arena.bounds) {
    const [x0, y0] = arena.bounds.min, [x1, y1] = arena.bounds.max;
    const edge = polyline(hex(UI.faint), 0.8, 5); setPolyline(edge, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], 0.02); view.arenaGroup.add(edge);
  }
  if (markers.start) {
    const s = navMarker('START', C.start, 0.22, true); s.position.set(markers.start[0], markers.start[1], 0);
    s.getObjectByName('heading').rotation.z = markers.yaw ?? 0; view.arenaGroup.add(s);
  }
  if (markers.goal) { const g = navMarker('GOAL', C.goal, 0.3); g.position.set(markers.goal[0], markers.goal[1], 0); view.arenaGroup.add(g); }
  centreFloor(); markDirty();
}

// ----- Navigate overlay: the goal being checked, its path, the staged/active goal and past walks.
// It lives outside the session content so it survives loading the live session or its recording.
const PICK_COLOR = { pending: hex(UI.faint), pass: C.green, warn: C.future, block: C.red };
export function setNavOverlay(o = null) {
  if (!view.scene) return;
  if (!view.navGroup) { view.navGroup = new THREE.Group(); view.navGroup.name = 'navigate'; view.scene.add(view.navGroup); }
  disposeGroup(view.navGroup);
  view.navGroup.visible = !!o;
  if (!o) { markDirty(); return; }
  for (const w of o.walks ?? []) {
    if (!Array.isArray(w.xy)) continue;
    const ok = w.outcome === 'arrived';
    const m = navMarker(`${w.index} ${ok ? '✓' : '·'}`, ok ? C.green : hex(UI.faint), 0.16);
    m.position.set(w.xy[0], w.xy[1], 0); view.navGroup.add(m);
  }
  if (Array.isArray(o.bounds)) {
    const [x0, y0, x1, y1] = o.bounds, edge = polyline(C.blue, 0.5, 5);
    setPolyline(edge, [[x0, y0], [x1, y0], [x1, y1], [x0, y1], [x0, y0]], 0.02); view.navGroup.add(edge);
    const tag = label(o.boundsLabel ?? 'planner memory', C.blue); tag.position.set(x0 + 0.1, y1 - 0.1, 0.05); tag.center.set(0, 1);
    view.navGroup.add(tag);
  }
  if (Array.isArray(o.goal)) {
    const unverified = o.goalUnverified;
    const g = navMarker(unverified ? (o.goalLabel ?? 'NODE GOAL · UNVERIFIED') : o.staged ? 'GOAL · STAGED' : 'GOAL', unverified ? C.red : C.goal, o.radius ?? 0.4);
    g.position.set(o.goal[0], o.goal[1], 0); view.navGroup.add(g);
  }
  if (Array.isArray(o.path) && o.path.length > 1) {
    const line = polyline(o.pickStatus === 'block' ? C.red : C.travelled, 1, o.path.length + 1);
    setPolyline(line, o.path, 0.04); view.navGroup.add(line);
  }
  if (Array.isArray(o.pick)) {
    const color = PICK_COLOR[o.pickStatus] ?? PICK_COLOR.pending;
    const p = navMarker(o.pickStatus === 'block' ? 'NOT HERE' : 'NEW GOAL', color, o.radius ?? 0.4);
    p.position.set(o.pick[0], o.pick[1], 0); view.navGroup.add(p);
  }
  markDirty();
}

// The robot's map as a floor texture: one texel per memory cell, never-observed cells transparent.
const MAP_RGBA = { 1: [126, 200, 194, 72], 2: [232, 170, 72, 215], 3: [226, 120, 110, 230], 4: [160, 128, 205, 210] };  // the site's, tuned for a light floor
export function setNavMap(map = null) {
  if (!view.scene) return;
  view.navMapActive = !!map;
  const syncMapLayers = () => {  // only the two map renderables; applyLayers() needs the frame state
    if (view.mapLayer) view.mapLayer.visible = view.layers.perception && !!view.session?.perception?.available && !view.navMapActive;
    if (view.navMap) view.navMap.visible = view.layers.perception && view.navMapActive;
    markDirty();
  };
  if (!map) { syncMapLayers(); return; }
  const n = map.n;
  if (!view.navMap || view.navMap.userData.n !== n) {
    if (view.navMap) { view.navMap.geometry.dispose(); view.navMap.material.map.dispose(); view.navMap.material.dispose(); view.scene.remove(view.navMap); }
    const texture = new THREE.DataTexture(new Uint8Array(n * n * 4), n, n, THREE.RGBAFormat);
    texture.magFilter = THREE.NearestFilter; texture.minFilter = THREE.LinearFilter;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false }));
    mesh.renderOrder = 1; mesh.userData.n = n; mesh.name = 'robot-map';
    view.scene.add(mesh); view.navMap = mesh;
  }
  const mesh = view.navMap, data = mesh.material.map.image.data;
  // Source arrays are grid[i][j], i along x: texel column i, row j (DataTexture rows run along +y).
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const code = map.codes[i * n + j], rgba = MAP_RGBA[code], k = (j * n + i) * 4;
    if (!rgba) { data[k + 3] = 0; continue; }
    const shade = code === 3 ? Math.min(1, 0.65 + map.height[i * n + j] / 250) : 1;
    data[k] = rgba[0] * shade; data[k + 1] = rgba[1] * shade; data[k + 2] = rgba[2] * shade; data[k + 3] = rgba[3];
  }
  mesh.material.map.needsUpdate = true;
  const size = n * map.res_m;
  mesh.scale.set(size, size, 1);
  mesh.position.set(map.lo[0] + (n - 1) * map.res_m / 2, map.lo[1] + (n - 1) * map.res_m / 2, 0.006);
  syncMapLayers();
}

export function projectWorld(points) { return points.map(p => new THREE.Vector3(...p).project(view.camera).toArray()); }
export function cameraFit() {
  return { distance: view.camera.position.distanceTo(view.controls.target), maxDistance: view.controls.maxDistance, far: view.camera.far, aspect: view.camera.aspect };
}
export function markerPositions() {
  return { goal: view.markers.goal?.position.toArray() ?? null, start: view.markers.start?.position.toArray() ?? null };
}
export function markerScreen() {
  return Object.values(view.markers).map(o => ({ name: o.name, ndc: o.position.clone().project(view.camera).toArray() }));
}

// ----- Deploy workspace (js/deploy3d.js): the robot builder, posing and drawing helpers, shared as-is ------------
export { buildRobot, pose, label as makeLabel, navMarker, polyline, setPolyline, disposeGroup, boxMesh };
