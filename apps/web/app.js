import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { initializeWorkbench } from './workbench.js';

const $ = id => document.getElementById(id);
const escape = value => String(value ?? 'Unavailable').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = n => typeof n === 'number' && Number.isFinite(n);
const hasPose = frame => Array.isArray(frame?.position)&&Array.isArray(frame?.quaternion_wxyz)&&Array.isArray(frame?.qpos);
const hasReferencePose = frame => hasPose(frame)&&Array.isArray(frame?.reference?.position)&&Array.isArray(frame?.reference?.quaternion_wxyz);
const num = (n, digits = 2, unit = '') => finite(n) ? `${n.toFixed(digits)}${unit ? ` ${unit}` : ''}` : 'Unavailable';
const clock = value => { if (!finite(value)) return '—'; const ms = Math.round(Math.max(0,value) * 1000); return `${String(Math.floor(ms/60000)).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`; };
const fact = (label, value, cls = '') => `<div class="fact"><span>${escape(label)}</span><strong class="${cls}">${escape(value)}</strong></div>`;
const notice = (text, cls = '') => `<div class="callout ${cls}">${escape(text)}</div>`;
const vector = (v, digits = 3) => Array.isArray(v) ? v.map(n=>num(n,digits)).join(', ') : 'Unavailable';
const state = {session:null, frame:null, measuredFrame:null, frozenFrame:null, frameIndex:-1, time:0, playing:false, speed:1, tab:'intent', camera:'orbit', joint:0, loadGeneration:0};
let scene, camera, renderer, controls, modelSpec, robot, ghost, futureGhosts = [], content, environment, mapGroup, trajectory, futureLine, referenceLine, robotAxes, worldAxes, waypointMarker;
const meshCache = new Map();
const cachedGeometries = new Set();
const stl = new STLLoader();
const up = new THREE.Vector3(0,0,1);
const positions = new THREE.Vector3();
const previousFollow = new THREE.Vector3();
let lastTick = performance.now();
let preparationGroup, preparationGoal, preparationMode=false, goalPicking=false, goalPicked=null;
let sensorOverlayGroup, mapSample=null;
const sensorOverlays=new Map();

async function json(url) {
  const response = await fetch(url, {cache:'no-store'});
  if (!response.ok) throw new Error(`${url}: ${response.status} ${await response.text()}`);
  return response.json();
}
function error(message) { $('error-banner').textContent = message; $('error-banner').hidden = false; }
function quat(values) { return new THREE.Quaternion(values[1],values[2],values[3],values[0]); }

function initializeScene() {
  const host = $('viewport');
  scene = new THREE.Scene();
  scene.fog = new THREE.FogExp2(0x18222d, .018);
  camera = new THREE.PerspectiveCamera(43,1,.01,200);
  camera.up.copy(up);
  camera.position.set(3.5,-4.3,2.4);
  renderer = new THREE.WebGLRenderer({antialias:true,alpha:true});
  renderer.setPixelRatio(Math.min(window.devicePixelRatio,2));
  renderer.setClearColor(0x000000,0);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.3;
  host.appendChild(renderer.domElement);
  controls = new OrbitControls(camera,renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = .09;
  controls.target.set(0,0,.65);
  controls.maxPolarAngle = Math.PI*.49;
  controls.minDistance = .5;
  controls.maxDistance = 60;
  const ambient = new THREE.HemisphereLight(0xd7e5f4,0x3b4556,2.4);
  ambient.position.set(0,0,10);
  scene.add(ambient);
  const key = new THREE.DirectionalLight(0xf5ece0,3.4);
  key.position.set(3,-4,7); key.castShadow = true;
  key.shadow.mapSize.set(2048,2048); key.shadow.camera.left=-8; key.shadow.camera.right=8;
  key.shadow.camera.top=8; key.shadow.camera.bottom=-8; key.shadow.normalBias=.015;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x72bcd2,1.8); rim.position.set(-2,3,3); scene.add(rim);
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(120,120),new THREE.MeshStandardMaterial({color:0x1b2732,roughness:1,metalness:0,transparent:true,opacity:.78}));
  floor.position.z=-.015; floor.receiveShadow=true; scene.add(floor);
  const grid = new THREE.GridHelper(100,100,0x4c6472,0x30434f); grid.rotation.x=Math.PI/2; grid.position.z=-.01;
  grid.material.transparent=true;grid.material.opacity=.48;scene.add(grid);
  content = new THREE.Group();scene.add(content);
  preparationGroup=new THREE.Group();preparationGroup.visible=false;scene.add(preparationGroup);
  sensorOverlayGroup=new THREE.Group();scene.add(sensorOverlayGroup);
  let pointerStart=null;
  renderer.domElement.addEventListener('pointerdown',event=>{pointerStart=[event.clientX,event.clientY];});
  renderer.domElement.addEventListener('pointerup',event=>{
    if(!preparationMode||!goalPicking||!pointerStart||Math.hypot(event.clientX-pointerStart[0],event.clientY-pointerStart[1])>5)return;
    const rect=renderer.domElement.getBoundingClientRect(),ray=new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1,-(event.clientY-rect.top)/rect.height*2+1),camera);
    const point=ray.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,0,1),0),new THREE.Vector3());
    if(point)goalPicked?.([point.x,point.y]);
  });
  worldAxes = new THREE.AxesHelper(.6);worldAxes.position.z=.015;scene.add(worldAxes);
  new ResizeObserver(()=>{const {width,height}=host.getBoundingClientRect();camera.aspect=width/height;camera.updateProjectionMatrix();renderer.setSize(width,height);}).observe(host);
  renderer.domElement.addEventListener('webglcontextlost',()=>error('The 3D rendering context was lost. Reload to restore the scene; recorded data remains unchanged.'));
}

async function geometry(spec) {
  if (spec.type==='mesh') {
    if (!meshCache.has(spec.url)) meshCache.set(spec.url,stl.loadAsync(spec.url).then(g=>{cachedGeometries.add(g);return g;}));
    return await meshCache.get(spec.url);
  }
  const s=spec.size;
  if(spec.type==='box')return new THREE.BoxGeometry(s[0]*2,s[1]*2,s[2]*2);
  if(spec.type==='sphere')return new THREE.SphereGeometry(s[0],16,12);
  if(spec.type==='cylinder'||spec.type==='capsule') {
    const g=spec.type==='capsule'?new THREE.CapsuleGeometry(s[0],s[1]*2,6,12):new THREE.CylinderGeometry(s[0],s[0],s[1]*2,16);
    g.rotateX(Math.PI/2);return g;
  }
  throw new Error(`Unsupported model geometry ${spec.type}`);
}
async function buildRobot(spec, ghosted=false, opacity=.24) {
  const joints=[];
  async function body(node) {
    const group=new THREE.Group(); group.name=node.name;
    group.userData={spec:node,restPosition:new THREE.Vector3(...node.position),restQuaternion:quat(node.quaternion_wxyz)};
    group.position.copy(group.userData.restPosition);group.quaternion.copy(group.userData.restQuaternion);
    if(node.joint)joints.push(group);
    for(const geom of node.geometries) {
      const rgba=geom.rgba??[.65,.68,.7,1];
      const material=new THREE.MeshStandardMaterial(ghosted?{color:0x57ded3,transparent:true,opacity,roughness:.3,metalness:.12,depthWrite:false,emissive:0x1b625c,emissiveIntensity:.3}:{color:new THREE.Color(rgba[0],rgba[1],rgba[2]),roughness:.58,metalness:.22});
      const mesh=new THREE.Mesh(await geometry(geom),material);
      mesh.position.fromArray(geom.position);mesh.quaternion.copy(quat(geom.quaternion_wxyz));
      if(geom.scale)mesh.scale.fromArray(geom.scale);
      mesh.castShadow=!ghosted;mesh.receiveShadow=!ghosted;
      mesh.renderOrder=ghosted?2:0;group.add(mesh);
    }
    const children=await Promise.all(node.children.map(body));if(children.length)group.add(...children);return group;
  }
  const root=await body(spec.root);return {root,joints};
}
function pose(model, frame, reference=null) {
  const p=reference?.position??frame.position,q=reference?.quaternion_wxyz??frame.quaternion_wxyz;
  for(const group of model.joints) {
    const {spec,restPosition,restQuaternion}=group.userData;
    const joint=spec.joint;
    if(joint.type==='free'){group.position.fromArray(p);group.quaternion.copy(quat(q));continue;}
    const index=state.session.joint_names.indexOf(joint.name);
    const angle=reference&&index>=0?reference.joints[index]:frame.qpos[joint.qpos_index];
    if(!finite(angle))continue;
    const rotation=new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(...joint.axis).normalize(),angle);
    group.quaternion.copy(restQuaternion).multiply(rotation);
    const pivot=new THREE.Vector3(...joint.position);
    const offset=pivot.clone().sub(pivot.clone().applyQuaternion(rotation)).applyQuaternion(restQuaternion);
    group.position.copy(restPosition).add(offset);
  }
}
function line(points,color,opacity=1) {
  const object=new THREE.Line(new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p))),new THREE.LineBasicMaterial({color,transparent:true,opacity}));
  return object;
}
function updateLine(object,points) {
  object.geometry.dispose();object.geometry=new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p)));
}
function removeContent() {
  content.traverse(obj=>{if(obj.material){for(const m of Array.isArray(obj.material)?obj.material:[obj.material])m.dispose();}if(obj.geometry&&!cachedGeometries.has(obj.geometry))obj.geometry.dispose();});
  content.clear();robot=null;ghost=null;futureGhosts=[];environment=null;mapGroup=null;trajectory=null;futureLine=null;referenceLine=null;robotAxes=null;waypointMarker=null;
  mapSample=null;for(const id of sensorOverlays.keys())removeSensorOverlay(id);
}
function perceptionAt(time) {
  const perception=state.session?.perception;
  if(!perception?.frames)return perception;
  let selected=null;
  for(const frame of perception.frames){if(frame.time<=time)selected=frame;else break;}
  return selected;
}
function updateMapSample(force=false) {
  if(!mapGroup)return;
  const sample=perceptionAt(state.time);
  if(sample===mapSample&&!force)return;
  mapSample=sample;
  mapGroup.traverse(object=>{object.geometry?.dispose();object.material?.dispose();});mapGroup.clear();
  for(const [key,color]of [['support_points',0x6bc8ac],['ceiling_points',0xc4a0d9]]){
    const points=sample?.[key]??[];
    if(points.length)mapGroup.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p))),new THREE.PointsMaterial({size:Math.max(.025,(sample.resolution_m??.05)*.7),color,transparent:true,opacity:.78,sizeAttenuation:true})));
  }
}
async function loadScene(session,id,generation) {
  const spec=session.metadata.model_path?await json(`/api/model?id=${encodeURIComponent(id)}`):null;
  const worldAvailable=session.frames.some(hasPose);
  const [main,ref]=worldAvailable?await Promise.all([buildRobot(spec),buildRobot(spec,true)]):[null,null];
  if(generation!==state.loadGeneration)return;
  modelSpec=spec;removeContent();robot=main;ghost=ref;if(main)content.add(main.root,ref.root);
  $('scene-unavailable').hidden=worldAvailable;
  environment=new THREE.Group();
  for(const b of session.environment?.boxes??[]) {
    if(!Array.isArray(b.center_xy)||!Array.isArray(b.half_xy))continue;
    const height=b.z_top-b.z_bottom;
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(b.half_xy[0]*2,b.half_xy[1]*2,height),new THREE.MeshStandardMaterial({color:0x736d84,roughness:.9,transparent:true,opacity:.42}));
    mesh.position.set(b.center_xy[0],b.center_xy[1],b.z_bottom+height/2);mesh.rotation.z=b.yaw??0;mesh.castShadow=true;mesh.receiveShadow=true;
    const edges=new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:0x9a91ac,transparent:true,opacity:.5}));mesh.add(edges);environment.add(mesh);
  }
  content.add(environment);
  mapGroup=new THREE.Group();
  updateMapSample(true);
  content.add(mapGroup);
  trajectory=line(session.trajectory??[],0x7c92a0,.7);content.add(trajectory);
  futureLine=line([],0xefbb70,.95);referenceLine=line([],0x56d9d0,.7);content.add(futureLine,referenceLine);
  robotAxes=new THREE.AxesHelper(.32);content.add(robotAxes);
  waypointMarker=new THREE.Mesh(new THREE.RingGeometry(.09,.13,32),new THREE.MeshBasicMaterial({color:0xefbb70,side:THREE.DoubleSide,transparent:true,opacity:.8}));content.add(waypointMarker);
  if(session.frames.some(hasReferencePose)){
    const previews=await Promise.all([buildRobot(spec,true,.075),buildRobot(spec,true,.055)]);
    if(generation!==state.loadGeneration)return;
    futureGhosts=previews;previews.forEach(p=>content.add(p.root));
  }
  $('loading-overlay').hidden=true;
  cameraView(state.camera,true);renderFrame(true);updateLayers();
}

function cameraView(kind,reset=false) {
  state.camera=kind;
  document.querySelectorAll('[data-camera]').forEach(b=>{const active=b.dataset.camera===kind;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));});
  const root=state.frame?.position??[0,0,.75];
  controls.target.set(root[0],root[1],.7);
  previousFollow.fromArray(root);
  controls.enableRotate=kind!=='top';
  if(kind==='top')camera.position.set(root[0],root[1]-.001,7);
  else if(reset||kind==='follow')camera.position.set(root[0]+3.1,root[1]-4.4,2.5);
  controls.update();
}
function setPreparationMode(enabled) {
  preparationMode=enabled;preparationGroup.visible=enabled;content.visible=!enabled;
  sensorOverlayGroup.visible=!enabled;
  $('preparation-caption').hidden=!enabled;$('source-badge').hidden=enabled;
  document.querySelector('.viewport-meta').hidden=enabled;
  $('scene-unavailable').hidden=enabled||state.session?.frames.some(hasPose);
  if(enabled)setPlaying(false);else {goalPicking=false;renderer.domElement.style.cursor='';cameraView(state.camera,true);updateLayers();}
}
function clearPreparation() {
  preparationGroup.traverse(object=>{object.geometry?.dispose();if(object.material)for(const material of Array.isArray(object.material)?object.material:[object.material])material.dispose();});
  preparationGroup.clear();preparationGoal=null;
}
function showPreparationMap(map) {
  clearPreparation();setPreparationMode(true);
  for(const box of map.boxes??map.environment?.boxes??[]) {
    if(!Array.isArray(box.center_xy)||!Array.isArray(box.half_xy))continue;
    const height=box.z_top-box.z_bottom;
    if(!finite(height)||height<=0)continue;
    const mesh=new THREE.Mesh(new THREE.BoxGeometry(box.half_xy[0]*2,box.half_xy[1]*2,height),new THREE.MeshStandardMaterial({color:0x9287a5,roughness:.9,transparent:true,opacity:.58}));
    mesh.position.set(...box.center_xy,box.z_bottom+height/2);mesh.rotation.z=box.yaw??0;preparationGroup.add(mesh);
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(mesh.geometry),new THREE.LineBasicMaterial({color:0xb1a6c7})));
  }
  for(const [key,color] of [['support_points',0x6bc8ac],['ceiling_points',0xc4a0d9],['points',0x8bc9be]]) {
    const points=map[key]??map.perception?.[key]??[];
    if(points.length)preparationGroup.add(new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(p=>new THREE.Vector3(...p))),new THREE.PointsMaterial({color,size:.045,transparent:true,opacity:.85})));
  }
  preparationGoal=new THREE.Group();
  const ring=new THREE.Mesh(new THREE.RingGeometry(.12,.17,32),new THREE.MeshBasicMaterial({color:0xefbb70,side:THREE.DoubleSide}));ring.position.z=.035;
  const stem=line([[0,0,.04],[0,0,.6]],0xefbb70);preparationGoal.add(ring,stem);preparationGoal.visible=false;preparationGroup.add(preparationGoal);
  $('preparation-caption').textContent=`PREPARATION · ${map.label??map.id} · frame ${map.frame_id??'unverified'} · grid is a coordinate guide; empty space is unknown`;
  const box=new THREE.Box3().setFromObject(preparationGroup),bounds=map.bounds;
  const center=bounds?new THREE.Vector3((bounds.min[0]+bounds.max[0])/2,(bounds.min[1]+bounds.max[1])/2,0):box.isEmpty()?new THREE.Vector3():box.getCenter(new THREE.Vector3());
  const extent=bounds?Math.max(bounds.max[0]-bounds.min[0],bounds.max[1]-bounds.min[1],3):box.isEmpty()?8:Math.max(box.getSize(new THREE.Vector3()).x,box.getSize(new THREE.Vector3()).y,5);
  if(bounds){const [x0,y0]=bounds.min,[x1,y1]=bounds.max;preparationGroup.add(line([[x0,y0,.025],[x1,y0,.025],[x1,y1,.025],[x0,y1,.025],[x0,y0,.025]],map.kind==='boxes'?0x6a9caa:0x967f58,.7));}
  controls.target.set(center.x,center.y,0);camera.position.set(center.x,center.y-.001,Math.min(100,extent*1.6));controls.enableRotate=false;controls.update();
}
function setPreparationGoal(xy) {if(preparationGoal){preparationGoal.visible=Array.isArray(xy);if(xy)preparationGoal.position.set(xy[0],xy[1],0);}}
function pickPreparationGoal(enabled,callback) {goalPicking=enabled;goalPicked=callback;renderer.domElement.style.cursor=enabled?'crosshair':'';}
function removeSensorOverlay(id) {const object=sensorOverlays.get(id);if(object){object.geometry.dispose();object.material.dispose();sensorOverlayGroup.remove(object);sensorOverlays.delete(id);}}
function setSensorOverlay(sensor) {
  const points=sensor.payload?.points;
  if(!sensor.overlay_compatible||!Array.isArray(points)||!points.length){removeSensorOverlay(sensor.id);return;}
  removeSensorOverlay(sensor.id);
  const object=new THREE.Points(new THREE.BufferGeometry().setFromPoints(points.map(point=>new THREE.Vector3(...point))),new THREE.PointsMaterial({color:sensor.id.includes('raw')?0xc5abdc:sensor.id.includes('ceiling')?0xbba3d5:0x77e0c2,size:.035,transparent:true,opacity:.85}));
  sensorOverlays.set(sensor.id,object);sensorOverlayGroup.add(object);
}
function appendLiveFrame(latest) {
  const frame=latest.frame;if(!frame||!state.session||!hasPose(frame))return;
  setPlaying(false);state.frozenFrame=null;state.runtime=latest.runtime??null;
  const frames=state.session.frames,previous=frames.at(-1);
  if(previous&&frame.time<previous.time)return;
  if(previous&&frame.time===previous.time)frames[frames.length-1]=frame;else frames.push(frame);
  if(frames.length>3000)frames.splice(0,frames.length-3000);
  if(latest.perception){
    if(!state.session.perception?.frames)state.session.perception={available:true,kind:'time-series',frames:[]};
    const snapshots=state.session.perception.frames,previousMap=snapshots.at(-1);
    if(!previousMap||latest.perception.time>previousMap.time)snapshots.push(latest.perception);
    if(snapshots.length>500)snapshots.splice(0,snapshots.length-500);
  }
  state.session.metadata.duration_s=frame.time;state.session.metadata.mode='simulation';state.time=frame.time;state.frameIndex=-1;
  $('timeline').max=String(frame.time);$('duration-time').textContent=$('timeline-end').textContent=clock(frame.time);$('timeline-middle').textContent=clock(frame.time/2);$('frames-value').textContent=`${frames.length.toLocaleString()} observed`;
  $('layer-perception').disabled=!state.session.perception?.available;
  renderFrame(true);$('playback-state').textContent='CPU RUN · LATEST';$('source-badge').textContent='SIMULATION · ACTUAL WORKER STATE';
}
function updateLayers() {
  if(!environment)return;
  if(robot)robot.root.visible=$('layer-robot').checked&&hasPose(state.measuredFrame);
  if(ghost)ghost.root.visible=$('layer-reference').checked&&hasReferencePose(state.frame);
  futureGhosts.forEach(p=>p.root.visible=$('layer-future').checked&&!!state.frame?.reference);
  trajectory.visible=$('layer-trajectory').checked;
  environment.visible=$('layer-environment').checked;
  mapGroup.visible=$('layer-perception').checked&&!!state.session.perception?.available;
  futureLine.visible=$('layer-future').checked&&!!state.frame?.plan;
  referenceLine.visible=$('layer-reference').checked&&!!state.frame?.reference;
  waypointMarker.visible=$('layer-future').checked&&!!state.frame?.plan?.waypoint;
  robotAxes.visible=$('layer-frames').checked&&hasPose(state.measuredFrame);
  worldAxes.visible=$('layer-frames').checked&&hasPose(state.measuredFrame);
  if(mapGroup.visible)$('reference-caption').textContent=state.session.perception?.frames?`MAP OVERLAY · causal simulated LiDAR map · sample ${clock(mapSample?.time)}`:'MAP OVERLAY · final accumulated snapshot · capture time unavailable';
  else updateCaption();
}
function updateCaption() {
  const frame=state.frame;
  if(!frame)return;
  const measured=state.measuredFrame??frame;
  const age=sampleHealth().state_age_ms;
  if(!hasPose(measured)){
    $('pose-caption').textContent='ROBOT STATE UNAVAILABLE · no measured or world-root pose recorded';
    $('source-badge').textContent=`RECORDED ZMQ · ${(frame.health?.stream_status??'unavailable').toUpperCase()}`;
    $('reference-caption').textContent=frame.reference?'REFERENCE VALUES AVAILABLE · pose stream · no world-root position':'REFERENCE UNAVAILABLE · no payload received at this time';
    return;
  }
  $('pose-caption').textContent=`${state.frozenFrame?'DIAGNOSTIC HELD STATE':'GROUND TRUTH'} · xyz [${vector(measured.position,2)}] m · ${state.frozenFrame?`${num(age,0,'ms')} old`:frame.frame_id??'world'}`;
  $('source-badge').textContent=state.frozenFrame?'REPLAY DIAGNOSTIC · STATE HELD':'SIMULATOR GROUND TRUTH';
  $('reference-caption').textContent=frame.reference?'REFERENCE · cyan ghost · root path is planner diagnostic; not SONIC input':'REFERENCE UNAVAILABLE · this recording has no reference packets';
}
function sampleHealth() {
  const f=state.frame,m=state.measuredFrame??f;
  if(!f)return {};
  const age=hasPose(m)?Math.max(0,state.time-m.time)*1000:null;
  const referenceAge=finite(f.health?.reference_age_ms)?f.health.reference_age_ms+Math.max(0,state.time-f.time)*1000:null;
  const stale=finite(age)&&age>100;
  let tracking=f.health?.tracking_rmse_rad;
  if(stale)tracking=null;
  else if(state.frozenFrame&&f.reference)tracking=Math.sqrt(m.joints.reduce((sum,value,i)=>sum+(value-f.reference.joints[i])**2,0)/m.joints.length);
  return {...f.health,state_age_ms:age,reference_age_ms:referenceAge,tracking_rmse_rad:tracking,state_stale:stale};
}
function selectedFrame(time) {
  const frames=state.session.frames;let lo=0,hi=frames.length;
  while(lo<hi){const mid=(lo+hi)>>1;if(frames[mid].time<=time)lo=mid+1;else hi=mid;}
  return Math.max(0,lo-1);
}
function renderFrame(force=false) {
  if(!state.session)return;
  const index=selectedFrame(state.time);
  const changed=index!==state.frameIndex;
  state.frameIndex=index;state.frame=state.session.frames[index];
  state.measuredFrame=state.frozenFrame??state.frame;
  const f=state.frame;
  document.querySelector('.header-status .badge').textContent=state.session.metadata.mode==='simulation'?'◷ CPU SIMULATION':'◷ REPLAY';
  updateMapSample();
  $('timeline').value=String(state.time);
  $('current-time').textContent=clock(state.time);
  $('frame-counter').textContent=`Frame ${index+1} / ${state.session.frames.length}`;
  $('inspector-time').textContent=`SYNCHRONIZED · ${clock(f.time)}`;
  if(robot&&hasPose(state.measuredFrame)&&(changed||force)){
    pose(robot,state.measuredFrame);
    if(hasReferencePose(f)){pose(ghost,f,f.reference);futureGhosts.forEach((p,i)=>{const window=f.reference.window;pose(p,f,window[Math.min(window.length-1,i===0?4:9)]);});}
    robotAxes.position.fromArray(state.measuredFrame.position);robotAxes.quaternion.copy(quat(state.measuredFrame.quaternion_wxyz));
    updateLine(futureLine,f.plan?.future??[]);
    updateLine(referenceLine,f.reference?.window?.map(w=>w.position)??[]);
    if(f.plan?.waypoint)waypointMarker.position.set(f.plan.waypoint[0],f.plan.waypoint[1],.015);
    if(!preparationMode&&(state.camera==='follow'||state.camera==='top')){
      positions.fromArray(f.position);const delta=positions.clone().sub(previousFollow);delta.z=0;camera.position.add(delta);controls.target.add(delta);previousFollow.copy(positions);
    }
    updateLayers();
  }
  const h=sampleHealth();
  metric('state',h.state_age_ms,'ms',1,100);
  metric('reference',h.reference_age_ms,'ms',1,500);
  metric('latency',h.planner_latency_ms,'ms',1);
  metric('tracking',h.tracking_rmse_rad,'rad',3);
  $('metric-state-note').textContent=!finite(h.state_age_ms)?'State telemetry unavailable':h.state_stale?'STALE · >100 ms display threshold':state.frozenFrame?'Diagnostic · held state sample':'Cursor − state timestamp';
  $('metric-reference-note').textContent=h.stream_status?`${h.stream_status.toUpperCase()} · receiver observation`:finite(h.reference_age_ms)?'Cursor − reference timestamp':'No reference timestamp available';
  $('metric-reference').classList.toggle('bad',h.stream_status==='disconnected');
  updateCaption();if(mapGroup?.visible)updateLayers();
  if(changed||force)renderInspector();
  window.dispatchEvent(new CustomEvent('studio:frame',{detail:{frame:f,time:state.time,health:h}}));
}
function metric(name,value,unit,digits,warning) {
  const node=$(`metric-${name}`);node.innerHTML=finite(value)?`${value.toFixed(digits)}<em>${unit}</em>`:'—';
  node.classList.toggle('warn',finite(value)&&finite(warning)&&value>warning);
  node.classList.toggle('unavailable',!finite(value));
  node.setAttribute('aria-label',`${name}: ${num(value,digits,unit)}`);
}
function setPlaying(value) {
  state.playing=value;
  $('play').innerHTML=value?'Ⅱ <span>Pause</span>':'▶ <span>Play</span>';
  $('play').setAttribute('aria-label',value?'Pause recording':'Play recording');
  $('playback-state').textContent=value?'PLAYING':'PAUSED';
  lastTick=performance.now();
}
function seek(time) {if(state.frozenFrame&&time<state.frozenFrame.time)state.frozenFrame=null;state.time=Math.max(state.session.frames[0].time,Math.min(state.session.metadata.duration_s,time));renderFrame();}

function renderInspector() {
  if(!state.frame)return;
  if(state.tab==='intent')renderIntent();
  else if(state.tab==='joints')renderJoints();
  else if(state.tab==='health')renderHealth();
  else if(state.tab==='perception')renderPerception();
  else if(state.tab==='graph')renderGraph();
  else renderSource();
}
function renderIntent() {
  const f=state.frame,r=f.reference,p=f.plan,m=state.measuredFrame,h=sampleHealth();
  const wire=state.session.metadata.recording_kind==='recorded-wire-transport';
  const window=r?.window??[];
  const referenceDetail=r?`${fact('Recorded shape',r.shape?.join(' × ')+' · float values','value-cyan')}${fact('Horizon',`${window.length} frames · ${num(window.at(-1)?.offset_s,1,'s')}`)}<div class="window-bars">${window.slice(0,15).map(w=>`<span title="Reference offset ${num(w.offset_s,3,'s')}">${num(w.offset_s,1)}</span>`).join('')}</div><p class="tiny">Offsets in seconds · ${wire?'decoded wire reference':'sampled future reference'}</p>${wire?notice('World-root pose and playback cursor were not present in the captured packet. No ghost or inferred trajectory is rendered.','neutral'):notice('Cyan: reference pose. Faint ghosts: +0.4 s and +0.9 s. Amber: selected planner prediction. Future motion is not guaranteed.')}${wire?`${fact('Wire contract','pose v1 · little-endian arrays')}${fact('Wire joint order','Isaac → name-mapped G1 order')}${fact('Body quaternion','wxyz · frame not verified')}${fact('Latent token vector','Not in pose packet')}`:`${fact('SONIC input columns','0–63 · joints, velocity, orientation')}${fact('Diagnostic columns','64–66 · planner root displacement')}${fact('Orientation','relative 6D → world wxyz')}`}${fact('Joint position units','radians')}<details class="raw-details"><summary>Inspect actual reference values</summary><pre>${escape(JSON.stringify(wire?r.raw_fields:{offset_s:window[0]?.offset_s,joint_names:state.session.joint_names,values:r.raw?.[0]},null,2))}</pre></details>`:notice('No reference payload is available at this cursor. Reference joints, token values and tracking error remain unavailable.','warning');
  $('intent-content').innerHTML=`<span class="eyebrow">${wire?'REFERENCE PUBLISHER → COLLECTOR':'PLANNER → SONIC'}</span><h3>What comes next</h3><p>${wire?'Real reference payloads captured by a read-only subscriber during a local transport rehearsal.':'Selected motion and the reference window supplied to the recorded controller.'}</p>${notice(wire?'Recorded reference rows were reserialized through the source pose packer. This tests transport and decoding; no controller inference ran.':'Fused SONIC reference input · token vector unavailable in this recording/config. Reference values are not semantic token labels.','neutral')}<h4>Planner selection</h4>${fact('Selection rule',p?.rule??'Unavailable','value-amber')}${fact('Plan age',num(p?.age_s,3,'s'))}${fact('Waypoint · world',p?.waypoint?`[${vector(p.waypoint,2)}] m`:'Unavailable')}${fact('Compute latency',num(p?.latency_ms,1,'ms'))}${p?.clock_basis?`<p class="tiny">Timing: ${escape(p.clock_basis)}</p>`:''}<h4>${wire?'Observed pose reference':'SONIC reference window'}</h4>${referenceDetail}<h4>Observed execution</h4>${state.frozenFrame?notice(`Replay diagnostic injection: measured state held at ${clock(m.time)}. State ${h.state_stale?'stale':'held'}; reference follows the cursor.`,'warning'):''}${fact('Root · world',hasPose(m)?`[${vector(m.position,2)}] m`:'Unavailable')}${fact('Orientation · wxyz',hasPose(m)?`[${vector(m.quaternion_wxyz,3)}]`:'Unavailable')}${fact('Joint reference RMSE',num(h.tracking_rmse_rad,3,'rad'))}<p class="tiny">${f.command?.joints?'Reference targets describe intent. Recorded SONIC PD targets are available in Joints; these are simulated commands, not DDS motor packets.':'Reference targets describe intent. Low-level motor targets were not captured and are not interchangeable with these values.'}</p>`;
}

function jointChart(index) {
  const frames=state.session.frames,duration=state.session.metadata.duration_s;
  const values=frames.flatMap(f=>[f.joints?.[index],f.reference?.joints?.[index]]).filter(finite);
  if(!values.length)return '';
  let min=Math.min(...values),max=Math.max(...values);const pad=Math.max(.02,(max-min)*.15);min-=pad;max+=pad;
  const sample=frames.filter((_,i)=>i%Math.max(1,Math.ceil(frames.length/500))===0);
  const points=key=>sample.filter(f=>finite(key(f))).map(f=>`${(25+f.time/duration*245).toFixed(1)},${(79-(key(f)-min)/(max-min)*65).toFixed(1)}`).join(' ');
  const cursor=25+state.time/duration*245;
  return `<svg class="sparkline" viewBox="0 0 280 95" role="img" aria-label="Recorded joint position and reference over the session"><text x="3" y="15" fill="#728696" font-size="7">${max.toFixed(2)}</text><text x="3" y="80" fill="#728696" font-size="7">${min.toFixed(2)}</text><line x1="25" x2="270" y1="79" y2="79" stroke="#2b3e4d"/><polyline points="${points(f=>f.joints?.[index])}" fill="none" stroke="#e6dfcf" stroke-width="1.2"/><polyline points="${points(f=>f.reference?.joints?.[index])}" fill="none" stroke="#56d9d0" stroke-width="1.2"/><line x1="${cursor}" x2="${cursor}" y1="8" y2="82" stroke="#efbb70" stroke-width="1" stroke-dasharray="2 2"/></svg>`;
}
function renderJoints() {
  const f=state.frame,m=state.measuredFrame,h=sampleHealth();
  $('joints-content').innerHTML=`<span class="eyebrow">NAMED JOINT PARITY</span><h3>Planned vs executed</h3><p>Simulator state and selected reference. All values in radians; error = state − reference.</p>${state.frozenFrame?notice(`Replay diagnostic injection: state held at ${clock(m.time)}. ${h.state_stale?'Tracking error unavailable while stale.':'Historical chart remains unmodified.'}`,'warning'):''}<select id="joint-select" class="joint-select" aria-label="Joint to inspect">${state.session.joint_names.map((n,i)=>`<option value="${i}" ${i===state.joint?'selected':''}>${escape(n)}</option>`).join('')}</select>${jointChart(state.joint)}<div class="chart-legend"><span>Reference</span><span>Ground truth</span></div><p class="tiny">Amber cursor marks selected session time. Model indices are resolved by joint name.</p><table class="joint-table" data-testid="joint-table"><thead><tr><th>Joint</th><th>State</th><th>Ref</th><th>Error</th></tr></thead><tbody>${state.session.joint_names.map((name,i)=>`<tr><td title="${escape(name)}">${escape(name.replace('_joint',''))}</td><td>${num(m.joints?.[i],3)}</td><td>${finite(f.reference?.joints[i])?num(f.reference.joints[i],3):'—'}</td><td>${finite(f.reference?.joints?.[i])&&finite(m.joints?.[i])&&!h.state_stale?num(m.joints[i]-f.reference.joints[i],3):'—'}</td></tr>`).join('')}</tbody></table>${f.command?.joints?notice('SONIC PD targets are recorded from the CPU worker. These are simulated commanded positions; no DDS motor packets or physical joint faults are observed.','neutral'):notice('Motor commands, gains and joint faults are unavailable in this recording. Reference error is not low-level command tracking error.','neutral')}${f.command?.joints?`<h4>Recorded SONIC command targets</h4>${fact('Command tracking RMSE',num(h.command_tracking_rmse_rad,3,'rad'))}<details class="raw-details"><summary>Named target values · radians</summary><pre>${escape(JSON.stringify(Object.fromEntries(state.session.joint_names.map((name,index)=>[name,f.command.joints[index]])),null,2))}</pre></details>`:''}`;
  $('joint-select').addEventListener('change',e=>{state.joint=Number(e.target.value);renderJoints();});
}
function renderHealth() {
  const f=state.frame,m=state.measuredFrame,h=sampleHealth(),events=state.session.events??[];
  const recent=events.filter(e=>e.time<=state.time).slice(-8).reverse();
  $('health-content').innerHTML=`<span class="eyebrow">${state.session.metadata.mode==='simulation'?'CPU WORKER SAMPLE DIAGNOSTICS':'RECORDED DIAGNOSTICS'}</span><h3>Timing & availability</h3><p>${state.session.metadata.mode==='simulation'?'Actual worker samples use simulation time. Host receipt age is measured separately; CPU lockstep is not guaranteed real time.':'Historical metrics at the selected sample. Paused replay does not imply a disconnected controller.'}</p>${state.runtime?`${fact('Owned worker',state.runtime.worker_alive===true?'Running · PID '+state.runtime.worker_pid:state.runtime.worker_alive===false?'Exited':'Ownership unavailable')}${fact('Worker host',state.runtime.host)}${fact('Live telemetry receipt',state.runtime.telemetry_status??'Unavailable')}${fact('Host receipt age',num(state.runtime.telemetry_age_ms,0,'ms'))}`:''}<div class="callout ${state.frozenFrame?'warning':'neutral'}"><label class="diagnostic-toggle"><input id="freeze-state" data-testid="freeze-state" type="checkbox" ${state.frozenFrame?'checked':''}> Replay diagnostic injection: hold state</label><div class="tiny">Hold one recorded state while playback/reference advances. Display stale after 100 ms. No producer or controller is stopped.</div></div>${fact('State freshness',finite(h.state_age_ms)?`${num(h.state_age_ms,1,'ms')} · ${h.state_stale?'STALE':'recording clock'}`:'Unavailable',h.state_stale?'value-amber':'')}${fact('Reference freshness',num(h.reference_age_ms,1,'ms'))}${fact('Receiver status',h.stream_status??'Unavailable')}${fact('Last observed receive rate',num(h.observed_rate_hz,1,'Hz'))}${fact('Visualization queue drops',h.queue_drops??'Unavailable')}${fact('Planner wall latency',num(h.planner_latency_ms,1,'ms'))}${fact('SONIC inference',num(h.sonic_inference_ms,2,'ms'))}${fact('Controller step wall time',num(h.control_step_wall_ms,2,'ms'))}${fact('Command target RMSE',num(h.command_tracking_rmse_rad,3,'rad'))}${fact('Low-command freshness',num(h.lowcmd_age_ms,1,'ms'))}${fact('End-to-end latency','Unavailable')}${fact('GPU utilization',num(h.gpu_utilization,1,'%'))}${fact('Supervisor state','Unavailable at this cursor')}${fact(hasPose(m)?'State source time':'Event source time',num(m.source_time,6,'s'))}${fact('Source clock',m.source_clock_domain)}${fact('Simulator time',num(m.sim_time,3,'s'))}${fact('Receipt time',num(m.receipt_time,6,'s'))}${fact('State sequence',m.sequence)}${fact('Contact force',num(h.contact_force_n,2,'N'))}${notice('Unavailable fields stay unknown. Planner compute time is not end-to-end latency. State age is evaluated in the recording clock.','neutral')}<h4>Events up to this time</h4>${recent.length?`<ol class="event-list">${recent.map(e=>`<li><time>${clock(e.time)} · ${escape(e.source)}</time><button class="event-control" data-seek="${e.time}">${escape(e.message)}</button></li>`).join('')}</ol>`:'<p class="unavailable">No event recorded before this cursor.</p>'}`;
  $('freeze-state').disabled=!hasPose(state.frame);
  $('freeze-state').addEventListener('change',e=>{state.frozenFrame=e.target.checked?state.frame:null;renderFrame(true);});
  bindEventSeek();
}
function renderPerception() {
  const p=state.session.perception;
  if(p?.frames){
    const sample=perceptionAt(state.time);
    $('perception-content').innerHTML=`<span class="eyebrow">CAUSAL SIMULATED PERCEPTION</span><h3>What the planner observes</h3><p>Selected from recorded map and LiDAR samples at or before the session cursor. Unobserved grid cells remain unknown.</p>${sample?`${notice(sample.label??'Recorded simulated LiDAR and CloudMemory snapshot')}<div class="map-stats"><div><strong>${sample.observed_cells?.support?.toLocaleString()??'Unavailable'}</strong><span>OBSERVED SUPPORT CELLS</span></div><div><strong>${sample.observed_cells?.ceiling?.toLocaleString()??'Unavailable'}</strong><span>OBSERVED CEILING CELLS</span></div></div>${fact('Classification','Estimated map · simulated ray returns')}${fact('Frame',sample.frame_id)}${fact('Map sample time',num(sample.time,3,'s'))}${fact('Sensor acquisition',num(sample.sensor_capture_time,3,'s'))}${fact('Map age',num((state.time-sample.time)*1000,1,'ms'))}${fact('Sensor latency',num(sample.sensor_latency_s*1000,1,'ms'))}${fact('Sensor rate',num(sample.rate_hz,1,'Hz'))}${fact('Resolution',num(sample.resolution_m,3,'m'))}${fact('Unknown cells',sample.unknown_cells??'Unavailable')}${fact('Raw LiDAR count',sample.raw_points_count??sample.raw_lidar?.length??'Unavailable')}${fact('Filtered LiDAR count',sample.filtered_points_count??sample.filtered_lidar?.length??'Unavailable')}${fact('Self-filter removed · cumulative',sample.self_removed??'Unavailable')}${notice(sample.note??'Rendered point clouds are bounded visualization samples.','neutral')}<details class="raw-details"><summary>Sensor extrinsics and mask convention</summary><pre>${escape(JSON.stringify({extrinsics:sample.extrinsics,mask_convention:sample.mask_convention},null,2))}</pre></details>`:notice('No perception sample exists at or before this cursor.','warning')}<p>Open Sensors to attach raw LiDAR, filtered LiDAR, map layers or state to the viewport.</p>`;
    return;
  }
  $('perception-content').innerHTML=`<span class="eyebrow">PERCEPTION / MAPPING</span><h3>Observed space</h3><p>Recorded perception evidence. Unknown cells are left empty.</p>${p?.available?`${notice(p.label,'warning')}<div class="map-stats"><div><strong>${(p.observed_cells?.support??p.support_points?.length??0).toLocaleString()}</strong><span>OBSERVED SUPPORT CELLS</span></div><div><strong>${(p.observed_cells?.ceiling??p.ceiling_points?.length??0).toLocaleString()}</strong><span>OBSERVED CEILING CELLS</span></div></div>${fact('Classification','Estimated · accumulated map')}${fact('Grid resolution',num(p.resolution_m,3,'m'))}${fact('Unknown cells',p.unknown_cells?.toLocaleString()??'Unavailable')}${fact('Capture timestamp','Unavailable')}${fact('Time synchronization','Not available · final snapshot')}${fact('Displayed points',(p.observed_points?.length??0).toLocaleString())}${fact('Decimated',p.decimated?'Yes · bounded visualization':'No')}${notice(p.note,'neutral')}<p>Enable “Observed map snapshot” in View layers to show the final accumulated map. It does not represent perception at the timeline cursor.</p>`:notice(p?.reason??'No perception was recorded in this session.','warning')}${fact('Raw LiDAR','Unavailable')}${fact('Filtered LiDAR','Unavailable')}${fact('Sensor extrinsics','Unavailable')}${fact('Self-filter state','Unavailable')}${fact('Localization uncertainty','Unavailable')}${fact('Map update rate','Unavailable')}<p class="tiny">Simulation scene geometry is ground truth, separate from the estimated map. The ground grid is a coordinate guide; it does not imply observed free space.</p>`;
}
function renderGraph() {
  const g=state.frame.observed_graph??state.session.graph??{},nodes=new Map((g.nodes??[]).map(n=>[n.id,n]));
  const observed=!!state.frame.observed_graph;
  const h=sampleHealth();
  $('graph-content').innerHTML=`<span class="eyebrow">COMMUNICATION TOPOLOGY</span><h3>System connections</h3>${observed?notice('OBSERVED RECEIVER TRAFFIC · Rates, arrival age and socket events were recorded by the Studio subscriber. This is not full middleware graph discovery.'):notice('CONFIGURED FROM SOURCE · No runtime graph discovery or packet-rate measurements were recorded.','warning')}<p>${observed?'Recorded ZMQ reference packets and subscriber diagnostics. Publisher execution is not established by this packet schema; this viewer performs no inference or motor publishing.':state.session.metadata.recording_kind==='sonic-mujoco-lockstep'?'This rehearsal used in-process planner and SONIC calls. It did not exercise the DDS/ZMQ process chain.':'This historical rehearsal used separate simulator, planner and C++ SONIC processes. Transport edges below are configured, not discovered.'}</p>${(g.edges??[]).map(e=>`<div class="graph-label">${escape(e.status??'Configured')} · ${observed?'observed receiver edge':'configured edge'}</div><div class="graph-node">${escape(nodes.get(e.source)?.label??e.source)}<small>${escape(nodes.get(e.source)?.kind??'component')} · ${escape(nodes.get(e.source)?.host??'host unavailable')}</small></div><div class="graph-edge">↓ ${escape(e.transport)} · ${escape(e.topic)}<span>Last rate ${num(e.observed_rate_hz,1,'Hz')} · Age ${num(observed?h.reference_age_ms:e.age_ms,1,'ms')}</span><span>Drops ${escape(e.drops??'Unavailable')} · QoS ${escape(e.qos??'Unavailable')}</span><span>${escape(e.basis??g.basis)}</span></div><div class="graph-node">${escape(nodes.get(e.target)?.label??e.target)}</div>`).join('')}${observed?`${fact('Receiver status',h.stream_status??'Unavailable',h.stream_status==='fresh'?'value-cyan':'value-amber')}${fact('Last observed receive rate',num(h.observed_rate_hz,1,'Hz'))}${fact('Reference receipt age',num(h.reference_age_ms,1,'ms'))}${fact('Sequence gaps',h.sequence_gaps??'Unavailable')}${fact('Visualization queue drops',h.queue_drops??'Unavailable')}<p class="tiny">Rate comes from recorded message interarrival times; it remains the last estimate after a disconnect.</p>`:''}<h4>Discovery boundaries</h4>${fact('ROS 2 graph',g.ros2?.available?'Recorded':'Unavailable')}${fact('DDS participant discovery','Unavailable')}${fact('DDS domain',g.dds_domain??'Not recorded')}${fact('ZMQ publisher identity','Unavailable')}${notice(g.dds_domain_note??'Studio opens no DDS participant.','neutral')}<p class="tiny">Grandloco is an alternative backend, not another stage after SONIC.</p>`;
}

function renderSource() {
  const m=state.session.metadata,provenance=m.provenance??{};
  $('source-content').innerHTML=`<span class="eyebrow">REPRODUCIBLE PROVENANCE</span><h3>Source evidence</h3><a class="export-link" href="/api/export?id=${encodeURIComponent(state.sessionId)}" download>↓ Export normalized MCAP</a>${fact('Mode',m.mode==='simulation'?'Simulation · CPU worker observation':'Replay · read-only')}${fact('Recording',m.recording_kind)}${fact('Robot model',m.model_variant)}${fact('Backend',m.backend_id)}${fact('Clock',m.clock_domain)}${fact('Frame',m.frame_id)}${fact('Quaternion',m.quaternion_convention)}${fact('Policy',m.policy_identity)}${fact('Policy hash at capture',m.policy_hash_at_recording??'Unavailable')}${fact('Calibration identity',m.calibration_identity??'Unavailable')}${fact('Hardware validated',m.hardware_validated?'Yes':'No')}${fact('Hardware command path',m.command_path_enabled?'YES — unexpected':'No')}${fact('Adapter',provenance.adapter??'Unavailable')}<h4>Recording source</h4><pre>${escape(m.source_path)}</pre><h4>Exact model source</h4><pre>${escape(modelSpec?.source_path??m.model_path)}\nSHA-256 ${escape(modelSpec?.sha256??'Unavailable')}</pre><h4>Source artifacts</h4>${(provenance.artifacts??[]).map(a=>`<details class="raw-details"><summary>${escape(a.path.split('/').at(-1))} · ${num(a.bytes/1024,1,'KiB')}</summary><pre>${escape(a.path)}\nSHA-256 ${escape(a.sha256)}</pre></details>`).join('')}<h4>Source checkouts at read time</h4>${(provenance.repositories??[]).map(r=>`<pre>${escape(r.path)}\nHEAD ${escape(r.head_at_read)}\nDirty at read: ${r.dirty_at_read===null||r.dirty_at_read===undefined?'unknown':r.dirty_at_read?'yes':'no'}\nRevision at recording: ${escape(r.recording_revision??'not recorded')}</pre>`).join('')}<h4>Known evidence limits</h4>${(m.limitations??[]).map(text=>`<p>• ${escape(text)}</p>`).join('')}<p class="tiny">Local meshes are loaded from the referenced model. Third-party model files and recordings are not copied into this project.</p>`;
}
function bindEventSeek() { document.querySelectorAll('[data-seek]').forEach(el=>el.addEventListener('click',()=>{setPlaying(false);seek(Number(el.dataset.seek));})); }

async function loadSession(id) {
  const generation=++state.loadGeneration;
  setPlaying(false);$('loading-overlay').hidden=false;$('error-banner').hidden=true;removeContent();modelSpec=null;
  try {
    const session=await json(`/api/session?id=${encodeURIComponent(id)}`);
    if(generation!==state.loadGeneration)return;
    if(session.schema_version!==1||!session.frames?.length)throw new Error('Unsupported or empty recording. Expected telemetry schema v1.');
    state.session=session;state.sessionId=id;state.time=session.frames[0].time;state.frameIndex=-1;state.frame=null;state.measuredFrame=null;state.frozenFrame=null;state.joint=0;state.runtime=null;
    const m=session.metadata;
    const wire=m.recording_kind==='recorded-wire-transport';
    $('session-title').textContent=m.title;
    $('backend-value').textContent=m.backend_id.toUpperCase();
    $('model-value').textContent=m.model_variant;
    $('clock-value').textContent=m.clock_domain;
    $('frames-value').textContent=`${session.frames.length.toLocaleString()} decoded`;
    $('recording-kind').textContent=m.mode==='simulation'?'Fresh CPU MuJoCo + SONIC simulation. Observing the actual local worker; no DDS or robot connection.':wire?'Recorded ZMQ telemetry. Real pose packets and receiver status; policy execution is not observed.':m.recording_kind==='sonic-mujoco-lockstep'?'Recorded MuJoCo + SONIC lockstep. In-process rehearsal, with actual reference data.':'Recorded C++ / DDS rehearsal. Separate processes; reference packets were not captured.';
    $('world-frame').textContent=hasPose(session.frames[0])?m.frame_id:'frame unverified';
    $('footer-source').textContent=m.source_path;
    $('timeline').min=String(session.frames[0].time);$('timeline').max=String(m.duration_s);$('timeline').value=String(state.time);
    document.querySelector('.timeline-ticks>span').textContent=clock(session.frames[0].time);
    $('timeline-middle').textContent=clock(m.duration_s/2);$('timeline-end').textContent=$('duration-time').textContent=clock(m.duration_s);
    const events=session.events??[];
    $('event-rail').innerHTML=events.filter((_,i)=>i%Math.max(1,Math.ceil(events.length/200))===0).filter(e=>e.time>=0&&e.time<=m.duration_s).map(e=>`<button class="event-marker" data-seek="${e.time}" style="left:${e.time/m.duration_s*100}%" title="${escape(`${clock(e.time)} · ${e.message}`)}" aria-label="${escape(`Seek event ${e.message} at ${clock(e.time)}`)}"></button>`).join('');bindEventSeek();
    const hasReference=session.frames.some(hasReferencePose);
    const hasState=session.frames.some(hasPose);$('layer-robot').disabled=!hasState;$('layer-robot').checked=hasState;
    $('layer-future').disabled=!hasState;$('layer-trajectory').disabled=!hasState;$('layer-environment').disabled=!hasState;$('layer-frames').disabled=!hasState;
    $('scene-unavailable').hidden=hasState;
    $('layer-reference').disabled=!hasReference;$('layer-reference').checked=hasReference;
    $('layer-perception').disabled=!session.perception?.available;$('layer-perception').checked=false;
    renderFrame(true);await loadScene(session,id,generation);
    if(generation!==state.loadGeneration)return;
    window.__studio={get state(){return state;},get model(){return modelSpec;},get robot(){return robot;},get mapSample(){return mapSample;},get sensorOverlayCount(){return sensorOverlays.size;},seek,selectTab,setPlaying,loadSession,cameraView,setPreparationMode,showPreparationMap,setPreparationGoal,pickPreparationGoal,updateLayers,setSensorOverlay,removeSensorOverlay,appendLiveFrame};
    window.dispatchEvent(new CustomEvent('studio:session',{detail:{session,id}}));
    const url=new URL(window.location);url.searchParams.set('session',id);history.replaceState({},'',url);
  } catch(e) {if(generation===state.loadGeneration){$('loading-overlay').hidden=true;error(`Cannot open this recording: ${e.message}`);console.error(e);}}
}
function selectTab(name) {
  state.tab=name;
  document.querySelectorAll('[data-tab]').forEach(button=>{const active=button.dataset.tab===name;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));$(`panel-${button.dataset.tab}`).hidden=!active;});
  renderInspector();
}
function tick(now) {
  if(state.playing&&state.session){const dt=Math.min((now-lastTick)/1000,.25);state.time=Math.min(state.session.metadata.duration_s,state.time+dt*state.speed);renderFrame();if(state.time>=state.session.metadata.duration_s)setPlaying(false);}
  lastTick=now;
  if(renderer){controls.update();renderer.render(scene,camera);}
  requestAnimationFrame(tick);
}
async function initialize() {
  try{initializeScene();}catch(e){error(`3D renderer could not start: ${e.message}`);$('loading-overlay').hidden=true;return;}
  initializeWorkbench();
  $('session-picker').addEventListener('change',e=>loadSession(e.target.value));
  $('play').addEventListener('click',()=>{if(!state.session)return;if(state.time>=state.session.metadata.duration_s)seek(0);setPlaying(!state.playing);});
  $('restart').addEventListener('click',()=>{if(state.session){setPlaying(false);seek(0);}});
  $('timeline').addEventListener('input',e=>{setPlaying(false);seek(Number(e.target.value));});
  $('speed').addEventListener('change',e=>state.speed=Number(e.target.value));
  document.querySelectorAll('[data-camera]').forEach(b=>b.addEventListener('click',()=>cameraView(b.dataset.camera)));
  document.querySelectorAll('.layers input').forEach(b=>b.addEventListener('change',updateLayers));
  document.querySelectorAll('[data-tab]').forEach(b=>b.addEventListener('click',()=>selectTab(b.dataset.tab)));
  window.addEventListener('keydown',e=>{if(e.code==='Space'&&!['INPUT','SELECT','BUTTON','TEXTAREA'].includes(document.activeElement.tagName)){e.preventDefault();$('play').click();}});
  requestAnimationFrame(tick);
  try{
    const {sessions}=await json('/api/sessions');
    if(!sessions?.length)throw new Error('No recordings configured. See the local configuration instructions.');
    $('session-picker').innerHTML=sessions.map(s=>`<option value="${escape(s.id)}">${escape(s.label??s.title??s.id)}</option>`).join('');
    const view=new URLSearchParams(location.search);
    const requested=view.get('session');
    const selected=sessions.some(s=>s.id===requested)?requested:sessions[0].id;
    $('session-picker').value=selected;await loadSession(selected);
    // Explicit replay-view links configure only this browser after data/model
    // loading succeeds. They never start a producer or change recorded data.
    if(state.sessionId!==selected||!$('loading-overlay').hidden||!$('error-banner').hidden)return;
    if(requested&&requested!==selected)return;
    const panel=view.get('panel');
    if([...document.querySelectorAll('[data-tab]')].some(button=>button.dataset.tab===panel))selectTab(panel);
    if(view.get('map')==='1'&&!$('layer-perception').disabled){$('layer-perception').checked=true;updateLayers();}
    if(view.get('play')==='1')setPlaying(true);
  }catch(e){error(e.message);$('loading-overlay').hidden=true;}
}
initialize();
