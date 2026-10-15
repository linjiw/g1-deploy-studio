// Local scenario preparation, owned CPU jobs and read-only sensor views.
// All coordinates and sensor values originate in server-normalized data.
const $ = id => document.getElementById(id);
const escape = value => String(value ?? 'Unavailable').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value,digits=2,unit='') => finite(value)?`${value.toFixed(digits)}${unit?' '+unit:''}`:'Unavailable';
const vector = value => Array.isArray(value)?value.map(v=>number(v,3)).join(', '):'Unavailable';
const fact = (name,value) => `<div class="fact"><span>${escape(name)}</span><strong>${escape(value)}</strong></div>`;
const wb = {workspace:'replay',catalog:null,config:null,map:null,scenario:null,job:null,sensors:null,pinned:new Set(),sensorRequest:false,sensorTime:0,sensorSession:null,jobTimer:null,live:false,liveJob:null,lastFrame:null};
const api = () => window.__studio;

async function request(path,body) {
  const options={cache:'no-store'};
  if(body!==undefined)Object.assign(options,{method:'POST',headers:{'Content-Type':'application/json','X-Studio-Token':wb.catalog?.csrf_token??''},body:JSON.stringify(body)});
  const response=await fetch(path,options);
  const data=await response.json();
  if(!response.ok)throw new Error(data.error??`Request failed (${response.status})`);
  return data;
}
function report(error) {$('workbench-error').textContent=error.message??String(error);$('workbench-error').hidden=false;}
function clearError() {$('workbench-error').hidden=true;}
function busy(button,task) {button.disabled=true;return task().catch(report).finally(()=>{button.disabled=false;if(button.id==='start-job')updateTestSummary();});}
function markDirty() {wb.scenario=null;const note=$('scenario-result');if(note)note.textContent='Draft changed. Validate and save before running.';updateTestSummary();}
function showPreparation() {if(!wb.map)return;api()?.showPreparationMap(wb.map);api()?.setPreparationGoal(wb.config.goal_xy);api()?.setPreparationStart(wb.config.start_xy,wb.config.start_yaw_rad);}
function syncPins() {api()?.updateView({pin:wb.pinned.size?[...wb.pinned].join(','):null});}
function positionSensorDock() {const dock=$('sensor-dock'),viewport=document.querySelector('.viewport-shell');if(matchMedia('(max-width:600px)').matches)viewport.after(dock);else viewport.append(dock);}

async function catalog(refresh=false) {
  if(wb.catalog&&!refresh)return wb.catalog;
  wb.catalog=await request('/api/workbench');
  if(!wb.config)wb.config=structuredClone(wb.catalog.defaults);
  return wb.catalog;
}
function workspace(name) {
  wb.workspace=name;clearError();
  document.querySelectorAll('[data-workspace]').forEach(button=>{const active=button.dataset.workspace===name;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
  $('workbench-drawer').hidden=name==='replay';
  for(const kind of ['prepare','test','sensors'])$(`workbench-${kind}`).hidden=kind!==name;
  api()?.setPreparationMode(name==='prepare'&&!!wb.map);
  if(name==='prepare'&&wb.map)showPreparation();
  if(name==='prepare'||name==='test')catalog().then(()=>{if(!$('prepare-map'))buildPreparation();if(!$('test-backend'))buildTest();if(!wb.map)return selectMap(wb.config.map_id);}).catch(report);
  if(name==='sensors')refreshSensors(true);
  const url=new URL(location.href);if(name==='replay')url.searchParams.delete('workspace');else url.searchParams.set('workspace',name);history.replaceState({},'',url);
}
function mapOptions() {return wb.catalog.maps.map(map=>`<option value="${escape(map.id)}" ${map.id===wb.config.map_id?'selected':''}>${escape(map.label)}${map.runnable?'':' · inspect only'}</option>`).join('');}
function buildPreparation() {
  $('workbench-prepare').innerHTML=`<div class="tool-heading"><div><span class="eyebrow">MAP → GOAL → SCENARIO</span><h3>Prepare a rehearsal</h3></div><span class="badge subtle">LOCAL CONFIGURATION</span></div>
    <div class="tool-actions sticky-actions"><button id="pick-goal" aria-pressed="false">⌖ Pick goal on map</button><button id="use-scene-preset" hidden>Use scene start / goal</button><button id="save-scenario" class="primary-action">Validate & save scenario</button></div>
    <div class="saved-scenario-row"><label class="tool-field">Saved scenario<select id="saved-scenario"><option value="">Current draft</option></select></label><button id="export-scenario" title="Download the current configuration as JSON">↓ JSON</button></div>
    <label class="tool-field">Map <select id="prepare-map" aria-label="Preparation map">${mapOptions()}</select></label>
    <div class="coordinate-fields"><fieldset><legend>Start · map frame · m</legend><label>X<input id="start-x" type="number" step="0.05" value="${wb.config.start_xy[0]}"></label><label>Y<input id="start-y" type="number" step="0.05" value="${wb.config.start_xy[1]}"></label></fieldset><fieldset><legend>Navigation goal · map frame · m</legend><label>X<input id="goal-x" type="number" step="0.05" value="${wb.config.goal_xy[0]}"></label><label>Y<input id="goal-y" type="number" step="0.05" value="${wb.config.goal_xy[1]}"></label></fieldset></div>
    <div id="prepare-map-info" class="tool-note">Loading map provenance…</div>
    <div id="scenario-result" class="tool-note" aria-live="polite">Draft only. Picking a goal does not command a robot.</div>
    <details class="map-import"><summary>Import a simulation map or real-world scan</summary><p>Local JSON: boxes with collision geometry, or XYZ scan points. Scans remain inspection-only until collision geometry and frame alignment are established.</p><input id="map-import-file" type="file" accept="application/json,.json" aria-label="Import map JSON"><label class="tool-field">Map label<input id="map-import-label" placeholder="Imported map"></label><button id="import-map">Import selected JSON</button><p class="tiny">Every JSON must declare frame_id: "world" after alignment. Use {kind: "boxes", boxes: [...]} or {kind: "scan", points: [[x,y,z], ...], resolution_m: 0.1}. SI units, Z up. Import files stay local.</p></details>`;
  $('prepare-map').addEventListener('change',e=>selectMap(e.target.value).catch(report));
  for(const [id,key,index] of [['start-x','start_xy',0],['start-y','start_xy',1],['goal-x','goal_xy',0],['goal-y','goal_xy',1]])$(id).addEventListener('input',e=>{wb.config[key][index]=e.target.value===''?null:Number(e.target.value);if(key==='goal_xy'&&wb.config.goal_xy.every(finite))api()?.setPreparationGoal(wb.config.goal_xy);if(key==='start_xy')api()?.setPreparationStart(wb.config.start_xy,wb.config.start_yaw_rad);markDirty();});
  $('pick-goal').addEventListener('click',()=>{
    const enabled=$('pick-goal').getAttribute('aria-pressed')!=='true';$('pick-goal').setAttribute('aria-pressed',String(enabled));$('pick-goal').classList.toggle('active',enabled);
    $('scenario-result').textContent=enabled?'Click the map to set an XY goal. A click does not establish free space or reachability.':'Draft goal ready for validation.';
    api()?.pickPreparationGoal(enabled,xy=>{wb.config.goal_xy=xy.map(v=>Math.round(v*1000)/1000);$('goal-x').value=wb.config.goal_xy[0];$('goal-y').value=wb.config.goal_xy[1];api()?.setPreparationGoal(wb.config.goal_xy);markDirty();});
  });
  $('save-scenario').addEventListener('click',()=>busy($('save-scenario'),saveScenario));
  $('use-scene-preset').addEventListener('click',()=>{const preset=wb.map?.suggested_scenario;if(!preset)return;Object.assign(wb.config,structuredClone(preset));for(const [id,key,index]of [['start-x','start_xy',0],['start-y','start_xy',1],['goal-x','goal_xy',0],['goal-y','goal_xy',1]])$(id).value=wb.config[key][index];buildTest();showPreparation();markDirty();$('scenario-result').textContent='Scene start and goal loaded with its suggested CPU test settings. Edit coordinates or pick a custom goal, then validate.';});
  $('import-map').addEventListener('click',()=>busy($('import-map'),importMap));
  $('saved-scenario').addEventListener('change',e=>{if(e.target.value)loadSavedScenario(e.target.value).catch(report);});
  $('export-scenario').addEventListener('click',()=>{const document=wb.scenario??{schema_version:1,...wb.config,label:'Studio draft',draft:true};const url=URL.createObjectURL(new Blob([JSON.stringify(document,null,2)],{type:'application/json'}));const link=Object.assign(documentNode('a'),{href:url,download:`${wb.scenario?.id??'studio-scenario-draft'}.json`});link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  refreshSavedScenarios().catch(report);
}
const documentNode = tag => document.createElement(tag);
async function refreshSavedScenarios() {
  const result=await request('/api/scenarios');if(!$('saved-scenario'))return;
  $('saved-scenario').innerHTML='<option value="">Current draft</option>'+result.scenarios.map(scenario=>`<option value="${escape(scenario.id)}" ${scenario.id===wb.scenario?.id?'selected':''}>${escape(scenario.label)} · ${escape(scenario.id.slice(-6))}</option>`).join('');
}
async function loadSavedScenario(id) {
  const scenario=await request(`/api/scenarios?id=${encodeURIComponent(id)}`);
  wb.config=Object.fromEntries(['map_id','backend_id','duration_s','start_xy','goal_xy','start_yaw_rad','seed','planner'].map(key=>[key,structuredClone(scenario[key])]));
  for(const [input,key,index]of [['start-x','start_xy',0],['start-y','start_xy',1],['goal-x','goal_xy',0],['goal-y','goal_xy',1]])$(input).value=wb.config[key][index];
  $('prepare-map').value=scenario.map_id;await selectMap(scenario.map_id);wb.scenario=scenario;
  buildTest();$('scenario-result').textContent=`Loaded ${scenario.id}. The configuration is revalidated before every new run.`;updateTestSummary();
}
async function selectMap(id) {
  wb.config.map_id=id;markDirty();const selected=await request(`/api/map?id=${encodeURIComponent(id)}`);
  if(wb.config.map_id!==id)return;
  wb.map=selected;
  const map=wb.catalog.maps.find(item=>item.id===id)??selected;
  $('prepare-map-info').innerHTML=`<span class="sensor-state ${map.runnable?'available':'unknown'}">${map.runnable?'SIMULATION MAP':'INSPECTION MAP'}</span> ${escape(map.kind)} · frame ${escape(map.frame_id)}${fact('Bounds · m',map.bounds?`${vector(map.bounds.min)} → ${vector(map.bounds.max)}`:'Unavailable')}<p>${escape(selected.description??map.reason??selected.note??'Geometry is provided by this map. Unknown space is not marked free.')}</p>${selected.source_path||selected.provenance?`<details><summary>Map provenance</summary><pre>${escape(JSON.stringify(selected.provenance??{path:selected.source_path,sha256:selected.sha256},null,2))}</pre></details>`:''}`;
  $('use-scene-preset').hidden=!selected.suggested_scenario;
  if(wb.workspace==='prepare')showPreparation();
  updateTestSummary();
}
async function importMap() {
  clearError();
  const file=$('map-import-file').files[0];if(!file)throw new Error('Select a JSON map file first.');
  if(file.size>4*1024*1024)throw new Error('Map JSON exceeds the 4 MiB import limit. Decimate the scan first.');
  const document=JSON.parse(await file.text());
  if(!['boxes','scan'].includes(document.kind))throw new Error('Map kind must be boxes or scan.');
  if(document.frame_id!=='world')throw new Error('Map JSON must explicitly declare frame_id: world after its coordinates have been aligned. No transform is inferred.');
  const imported=await request('/api/maps/import',{...document,label:$('map-import-label').value.trim()||document.label||file.name.replace(/\.json$/i,''),frame_id:document.frame_id});
  await catalog(true);$('prepare-map').innerHTML=mapOptions();const id=imported.id??imported.map?.id;if(!id)throw new Error('Imported map has no catalog ID.');$('prepare-map').value=id;await selectMap(id);
}
async function saveScenario() {
  clearError();
  if(![...wb.config.start_xy,...wb.config.goal_xy,wb.config.duration_s,wb.config.start_yaw_rad].every(finite))throw new Error('Start, goal, heading and duration require finite numbers.');
  const label=`${wb.map?.label??wb.config.map_id} · goal [${vector(wb.config.goal_xy)}] · ${wb.config.duration_s}s · K${wb.config.planner.candidates}/ODE${wb.config.planner.ode_steps}`.slice(0,100);
  const response=await request('/api/scenarios',{...wb.config,label});
  wb.scenario=response.validation?.valid===false?null:response.scenario;
  await refreshSavedScenarios();
  const validation=response.validation??{};
  $('scenario-result').innerHTML=`<strong>${validation.valid?'Scenario saved':'Scenario cannot run'}</strong>${fact('Goal classification',validation.goal?.status??'Unavailable')}<ul>${[...(validation.issues??[]),...(validation.warnings??[])].map(issue=>`<li>${escape(typeof issue==='string'?issue:issue.message??JSON.stringify(issue))}</li>`).join('')}</ul>${validation.valid?'<span>Saved locally. Review Policy test to start an isolated CPU run.</span>':''}`;
  updateTestSummary();return response;
}
function buildTest() {
  $('workbench-test').innerHTML=`<div class="tool-heading"><div><span class="eyebrow">ACTUAL INFERENCE / CPU / MUJOCO</span><h3>Test a policy</h3></div><span class="badge subtle">NO DDS OR HARDWARE</span></div>
    <div class="tool-actions sticky-actions"><button id="test-review">Review map & goal</button><button id="start-job" class="primary-action">Save & run CPU test</button><button id="cancel-job" hidden>Cancel this test</button></div>
    <details id="test-settings" class="test-settings" open><summary>Run configuration · CPU lockstep</summary><label class="tool-field">Backend <select id="test-backend">${wb.catalog.backends.map(backend=>`<option value="${escape(backend.id)}" ${backend.id===wb.config.backend_id?'selected':''}>${escape(backend.label)}</option>`).join('')}</select></label><div id="backend-detail" class="tool-note"></div>
    <div class="test-fields"><label class="tool-field">Duration · s<input id="test-duration" type="number" min="1" max="10" step="0.2" value="${wb.config.duration_s}"></label><label class="tool-field">Start heading · rad<input id="test-yaw" type="number" min="-3.142" max="3.142" step="0.1" value="${wb.config.start_yaw_rad}"></label><label class="tool-field">Seed<input id="test-seed" type="number" min="0" max="2147483647" step="1" value="${wb.config.seed}"></label></div>
    <div class="test-fields"><label class="tool-field">Flow candidates<input id="test-candidates" type="number" min="1" max="16" step="1" value="${wb.config.planner.candidates}"></label><label class="tool-field">ODE steps<input id="test-ode" type="number" min="1" max="10" step="1" value="${wb.config.planner.ode_steps}"></label></div>
    <div id="test-scenario" class="tool-note"></div></details>
    <div class="saved-scenario-row"><label class="tool-field">Owned runs<select id="job-picker"><option value="">Select a saved or running test</option></select></label><button id="refresh-jobs">Refresh</button></div>
    <div id="job-status" class="job-status" aria-live="polite">No active test. A run invokes the existing Flow planner and SONIC policy in an isolated local MuJoCo worker.</div><div id="job-results"></div><details id="job-log-details" hidden><summary>Worker log</summary><pre id="job-log"></pre></details>
    <p class="tiny">CPU lockstep is not the C++ / DDS real-time deployment chain. Small candidate and ODE settings are a quick test profile, not deployment parity.</p>`;
  const fields=[['test-duration','duration_s'],['test-yaw','start_yaw_rad'],['test-seed','seed']];
  for(const [id,key]of fields)$(id).addEventListener('input',e=>{wb.config[key]=e.target.value===''?null:Number(e.target.value);markDirty();});
  for(const [id,key]of [['test-candidates','candidates'],['test-ode','ode_steps']])$(id).addEventListener('input',e=>{wb.config.planner[key]=e.target.value===''?null:Number(e.target.value);markDirty();});
  $('test-backend').addEventListener('change',e=>{wb.config.backend_id=e.target.value;markDirty();updateTestSummary();});
  $('test-review').addEventListener('click',()=>workspace('prepare'));
  $('start-job').addEventListener('click',()=>busy($('start-job'),startJob));
  $('cancel-job').addEventListener('click',()=>busy($('cancel-job'),async()=>{await request('/api/jobs/cancel',{id:wb.job.id});await pollJob();}));
  $('job-picker').addEventListener('change',async event=>{clearTimeout(wb.jobTimer);wb.live=false;wb.liveJob=null;if(event.target.value){wb.job=wb.jobs.find(job=>job.id===event.target.value);await pollJob();}});
  $('refresh-jobs').addEventListener('click',()=>busy($('refresh-jobs'),refreshJobs));
  updateTestSummary();renderJob();refreshJobs().catch(report);
}
async function refreshJobs() {
  const response=await request('/api/jobs');wb.jobs=response.jobs??[];
  if(!$('job-picker'))return;
  $('job-picker').innerHTML='<option value="">Select a saved or running test</option>'+wb.jobs.map(job=>`<option value="${escape(job.id)}" ${job.id===wb.job?.id?'selected':''}>${escape(job.scenario?.label??job.id)} · ${escape(job.status)} · ${escape(job.id.slice(-6))}</option>`).join('');
  if(!wb.job){const active=wb.jobs.find(job=>['starting','running','cancelling'].includes(job.status));if(active){wb.job=active;$('job-picker').value=active.id;renderJob();await pollJob();}}
}
function updateTestSummary() {
  if(!$('test-scenario')||!wb.catalog)return;
  const backend=wb.catalog.backends.find(item=>item.id===wb.config.backend_id),map=wb.catalog.maps.find(item=>item.id===wb.config.map_id);
  $('backend-detail').textContent=backend?.reason??(backend?.available?'Available on this host':'Unavailable');
  $('test-scenario').innerHTML=`${fact('Map',map?.label??wb.config.map_id)}${fact('Start → goal · m',`[${vector(wb.config.start_xy)}] → [${vector(wb.config.goal_xy)}]`)}${fact('Scenario',wb.scenario?.id??'Unsaved draft')}`;
  $('start-job').disabled=!backend?.available||!map?.runnable||['queued','starting','running'].includes(wb.job?.status);
}
async function startJob() {
  await saveScenario();if(!wb.scenario)throw new Error('Scenario validation failed. Open Prepare to review the issues.');
  wb.job=await request('/api/jobs',{scenario_id:wb.scenario.id});$('test-settings').open=false;wb.lastFrame=null;wb.live=true;wb.liveJob=null;renderJob();refreshJobs().catch(report);await pollJob();
}
async function pollJob() {
  if(!wb.job)return;
  try{
    const previousStatus=wb.job.status;
    wb.job=await request(`/api/jobs?id=${encodeURIComponent(wb.job.id)}`);renderJob();
    if(wb.live&&wb.job.latest?.frame)await showLiveFrame();
    if(previousStatus!==wb.job.status&&!['queued','starting','running','cancelling'].includes(wb.job.status))await refreshJobs();
  }catch(error){report(error);}
  clearTimeout(wb.jobTimer);
  if(['queued','starting','running','cancelling'].includes(wb.job?.status))wb.jobTimer=setTimeout(pollJob,600);
}
function renderJob() {
  const job=wb.job;if(!job||!$('job-status'))return;
  const terminal=!['queued','starting','running','cancelling'].includes(job.status);
  $('cancel-job').hidden=terminal;$('start-job').disabled=!terminal;
  $('job-status').innerHTML=`<span class="sensor-state ${job.status==='completed'?'available':job.status==='failed'?'missing':'unknown'}">${escape(job.status.toUpperCase())}</span> <strong>${escape(job.id)}</strong>${fact('Simulated time',number(job.latest?.frame?.time??job.latest?.progress?.simulation_time_s,2,'s'))}${job.latest?.progress?`${fact('Worker wall time',number(job.latest.progress.wall_time_s,2,'s'))}${fact('Real-time factor',number(job.latest.progress.real_time_factor,3,'×'))}`:''}${job.runtime?`${fact('Worker process',job.runtime.worker_alive===null?'Ownership unavailable':job.runtime.worker_alive?'Running · PID '+job.runtime.worker_pid:'Exited')}${fact('Telemetry receipt',`${job.runtime.telemetry_status??'Unavailable'} · ${number(job.runtime.telemetry_age_ms,0,'ms')}`)}`:''}${job.error?`<p class="job-error">${escape(job.error)}</p>`:''}`;
  const summary={...(job.summary??{}),...(job.summary?.report??{})};
  $('job-results').innerHTML=`${summary.outcome?`<div class="result-outcome"><span>POLICY OUTCOME</span><strong>${escape(summary.outcome)}</strong>${fact('Final goal distance',number(summary.final_goal_distance_xy_m,3,'m'))}<p class="tiny">Worker completion and the policy outcome are separate. The source evaluator determines this result.</p></div>`:''}${job.latest?.frame&&!terminal?'<button id="watch-job" class="wide-button">'+(wb.live?'Detach live preview':'Attach running simulation to viewport')+'</button>':''}${job.result_session_id?'<button id="open-job-replay" class="primary-action wide-button">'+(job.status==='failed'?'Inspect recorded failure':'Open recorded test result')+'</button>':''}${Object.keys(summary).length?`<details open><summary>Measured run summary</summary>${summary.plan_latency_s?fact('Planner p50 / p95',`${number(summary.plan_latency_s.p50*1000,1,'ms')} / ${number(summary.plan_latency_s.p95*1000,1,'ms')}`):''}${summary.sonic_inference_ms?fact('SONIC p50 / p95',`${number(summary.sonic_inference_ms.p50,2,'ms')} / ${number(summary.sonic_inference_ms.p95,2,'ms')}`):''}${Object.entries(summary).filter(([,v])=>typeof v!=='object').map(([key,value])=>fact(key.replaceAll('_',' '),typeof value==='number'?number(value,3):value)).join('')}</details>`:''}`;
  $('watch-job')?.addEventListener('click',()=>{wb.live=!wb.live;if(wb.live)showLiveFrame().catch(report);renderJob();});
  $('open-job-replay')?.addEventListener('click',()=>openResult(job.result_session_id).catch(report));
  $('job-log-details').hidden=!job.log_tail;$('job-log').textContent=Array.isArray(job.log_tail)?job.log_tail.join('\n'):job.log_tail??'';
}
async function openResult(id) {
  wb.live=false;wb.liveJob=null;api()?.setPreparationMode(false);
  const sessions=await request('/api/sessions');$('session-picker').innerHTML=sessions.sessions.map(session=>`<option value="${escape(session.id)}">${escape(session.label??session.id)}</option>`).join('');$('session-picker').value=id;
  if(await api().loadSession(id)){api().selectTab('health');workspace('replay');}
}
async function showLiveFrame() {
  const job=wb.job;
  if(!wb.live||!job?.latest?.frame)return;
  const id=job.session_id??job.id;
  if(wb.liveJob!==id){wb.liveJob=id;const loaded=await api().loadSession(id);if(!wb.live||wb.liveJob!==id||wb.job?.id!==job.id)return;if(!loaded||api().state.sessionId!==id){wb.liveJob=null;throw new Error('The worker has not published a renderable session yet. Try attach again after its first state sample.');}if(![...$('session-picker').options].some(option=>option.value===id))$('session-picker').add(new Option('Flow / SONIC · current CPU test',id));$('session-picker').value=id;api().selectTab('health');}
  if(!wb.live||wb.liveJob!==id||api().state.sessionId!==id)return;
  api().setPreparationMode(false);
  api().appendLiveFrame?.({...job.latest,runtime:job.runtime});
}

function sensorPayload(sensor) {
  const payload=sensor.payload??{};
  const points=payload.points??payload.support_points??payload.ceiling_points;
  if(Array.isArray(points))return `<canvas class="sensor-preview" data-sensor-preview="${escape(sensor.id)}" width="260" height="110" aria-label="${escape(sensor.label)} XY projection"></canvas>${fact('Displayed points',points.length.toLocaleString())}${fact('Frame',sensor.frame_id)}<p class="tiny">XY projection · ${escape(sensor.synchronized?'causal sample at the replay cursor.':'static snapshot; capture time unavailable.')}${sensor.overlay_compatible?'':' World overlay unavailable; frame transform not verified.'}</p>`;
  if(sensor.id==='base_pose')return `${fact('Position · m',vector(payload.position??payload.position_m))}${fact('Quaternion · wxyz',vector(payload.quaternion_wxyz))}`;
  if(sensor.id==='joints'){
    const values=payload.position??payload.positions??payload.position_rad??payload.joints??[],names=payload.names??payload.joint_names??[];
    return `${fact('Named joints',values.length||names.length||'Unavailable')}<div class="sensor-joint-bars">${values.slice(0,12).map((value,index)=>`<span title="${escape(names[index]??index)}: ${number(value,3,'rad')}"><i style="height:${finite(value)?Math.min(100,Math.abs(value)*35)+3:0}%"></i></span>`).join('')}</div><p class="tiny">Absolute angle · first 12 named joints · radians</p>`;
  }
  return Object.entries(payload).filter(([key,value])=>!['points','provenance'].includes(key)&&(value===null||typeof value!=='object'||Array.isArray(value)&&value.length<=4)).slice(0,5).map(([key,value])=>fact(key.replaceAll('_',' '),Array.isArray(value)?vector(value):typeof value==='number'?number(value,3):value)).join('');
}
function sensorCard(sensor,pinned=false) {
  const available=sensor.available??(!['unavailable','missing'].includes(sensor.status)&&!!sensor.payload);
  return `<article class="sensor-card ${pinned?'pinned':''}" data-sensor-card="${escape(sensor.id)}"><div class="sensor-card-heading"><strong>${escape(sensor.label)}</strong><span class="sensor-state ${available?(sensor.status==='fresh'?'available':'unknown'):'missing'}">${escape(sensor.status)}</span></div><span class="sensor-classification">${escape(sensor.classification)} · ${escape(sensor.synchronized?'session clock':'unsynchronized')}</span>${available?sensorPayload(sensor):`<p class="sensor-reason">${escape(sensor.reason??'This source was not captured.')}</p>`}${fact('Source time',number(sensor.source_time,3,'s'))}${fact('Age / update rate',`${number(sensor.age_ms,0,'ms')} / ${number(sensor.rate_hz,1,'Hz')}`)}${pinned?'':`<details><summary>Source & frame</summary>${fact('Frame',sensor.frame_id)}${fact('Clock',sensor.source_clock??sensor.source_clock_domain)}<p class="tiny">${escape(sensor.reason??'')}</p><pre>${escape(JSON.stringify({extrinsics:sensor.extrinsics,provenance:sensor.provenance},null,2))}</pre></details>`}<button class="sensor-pin" data-pin-sensor="${escape(sensor.id)}" ${!available&&!pinned?'disabled':''}>${wb.pinned.has(sensor.id)?'Detach from viewport':'Attach to viewport'}</button></article>`;
}
function drawSensorPreview(canvas,sensor) {
  const points=sensor?.payload?.points??[];const context=canvas.getContext('2d');context.fillStyle='#101a23';context.fillRect(0,0,canvas.width,canvas.height);
  const selected=points.filter((_,index)=>index%Math.max(1,Math.ceil(points.length/2500))===0);if(!selected.length)return;
  const xs=selected.map(point=>point[0]),ys=selected.map(point=>point[1]);const lo=[Math.min(...xs),Math.min(...ys)],hi=[Math.max(...xs),Math.max(...ys)],extent=[Math.max(.1,hi[0]-lo[0]),Math.max(.1,hi[1]-lo[1])];const scale=Math.min((canvas.width-16)/extent[0],(canvas.height-16)/extent[1]);
  context.fillStyle='#83cdbb';for(const point of selected)context.fillRect(8+(point[0]-lo[0])*scale,canvas.height-8-(point[1]-lo[1])*scale,1.7,1.7);
  context.font='9px monospace';context.fillStyle='#a8bbc8';context.fillText(`${number(lo[0],1)}…${number(hi[0],1)} m X`,8,12);
}
function renderSensors() {
  if(!wb.sensors)return;
  const sensors=wb.sensors.sensors??[];
  if(wb.workspace==='sensors'){
    const scroll=$('workbench-drawer').scrollTop,open=[...document.querySelectorAll('[data-sensor-card] details[open]')].map(node=>node.closest('[data-sensor-card]').dataset.sensorCard);
    $('workbench-sensors').innerHTML=`<div class="tool-heading"><div><span class="eyebrow">READ-ONLY / SOURCE CAPABILITIES</span><h3>Sensor & perception browser</h3></div><span class="badge subtle">${number(wb.sensors.cursor_s,3,'s')}</span></div><p class="tool-note">Attach available streams to the main display. Missing channels stay visible as unavailable. A final map is never substituted for a live LiDAR stream.</p><div class="sensor-grid">${sensors.map(sensor=>sensorCard(sensor)).join('')}</div>`;
    for(const id of open)document.querySelector(`[data-sensor-card="${CSS.escape(id)}"] details`)?.setAttribute('open','');
    $('workbench-drawer').scrollTop=scroll;
  }
  const pinned=sensors.filter(sensor=>wb.pinned.has(sensor.id));
  $('sensor-dock').hidden=!pinned.length;$('sensor-dock').innerHTML=pinned.map(sensor=>sensorCard(sensor,true)).join('');
  for(const sensor of pinned)api()?.setSensorOverlay?.(sensor);
  document.querySelectorAll('[data-sensor-preview]').forEach(canvas=>drawSensorPreview(canvas,sensors.find(sensor=>sensor.id===canvas.dataset.sensorPreview)));
  document.querySelectorAll('[data-pin-sensor]').forEach(button=>button.addEventListener('click',()=>{
    const id=button.dataset.pinSensor;
    if(wb.pinned.has(id)){wb.pinned.delete(id);api()?.removeSensorOverlay?.(id);}else {if(wb.pinned.size>=3){report(new Error('Detach one view before pinning another. The viewport supports three sensor cards.'));return;}wb.pinned.add(id);}
    syncPins();renderSensors();
  }));
}
async function refreshSensors(force=false) {
  const state=api()?.state;if(!state?.sessionId)return;
  if(wb.sensorRequest){if(force)wb.pendingSensorRefresh=true;return;}
  if(!force&&wb.workspace!=='sensors'&&!wb.pinned.size)return;
  // Playback is decimated; a paused seek must update even a single frame.
  if(!force&&wb.sensorSession===state.sessionId&&Math.abs(wb.sensorTime-state.time)<(state.playing ? .09 : 1e-9))return;
  wb.sensorRequest=true;const sessionId=state.sessionId,time=state.time;
  try{
    const response=await request(`/api/sensors?session=${encodeURIComponent(sessionId)}&time=${encodeURIComponent(time)}`);
    if(api()?.state.sessionId!==sessionId)return;
    if(time>api().state.time+1e-9){wb.pendingSensorRefresh=true;return;}
    wb.sensors=response;wb.sensorTime=time;wb.sensorSession=sessionId;renderSensors();
  }catch(error){if(wb.workspace==='sensors')report(error);}finally{
    wb.sensorRequest=false;
    if(api()?.state.sessionId!==sessionId||wb.pendingSensorRefresh||(!api()?.state.playing&&Math.abs((api()?.state.time??time)-time)>1e-9)){wb.pendingSensorRefresh=false;refreshSensors(true);}
  }
}
export function initializeWorkbench() {
  const view=new URLSearchParams(location.search);
  wb.pinned=new Set((view.get('pin')??'').split(',').filter(id=>/^[a-z_]{1,40}$/.test(id)).slice(0,3));
  positionSensorDock();window.addEventListener('resize',positionSensorDock);
  document.querySelectorAll('[data-workspace]').forEach(button=>button.addEventListener('click',()=>workspace(button.dataset.workspace)));
  window.addEventListener('studio:session',()=>{if(wb.live&&wb.liveJob&&api()?.state.sessionId!==wb.liveJob)wb.live=false;wb.sensors=null;wb.sensorSession=null;$('sensor-dock').hidden=true;for(const id of wb.pinned)api()?.removeSensorOverlay?.(id);refreshSensors(true);});
  window.addEventListener('studio:frame',event=>{
    if(finite(wb.lastCursor)&&event.detail.time<wb.lastCursor-1e-9){
      for(const id of wb.pinned)api()?.removeSensorOverlay?.(id);
      wb.sensors=null;wb.sensorSession=null;$('sensor-dock').hidden=true;
      if(wb.workspace==='sensors')$('workbench-sensors').innerHTML='<p class="tool-note">Loading causal sensor samples for this cursor…</p>';
      refreshSensors(true);
    }else if(!api()?.state.playing||performance.now()-(wb.lastSensorFetch??0)>250){wb.lastSensorFetch=performance.now();refreshSensors();}
    wb.lastCursor=event.detail.time;
  });
  window.__workbench={state:wb,workspace,refreshSensors};
  const selected=view.get('workspace');if(['prepare','test','sensors'].includes(selected))workspace(selected);
}
