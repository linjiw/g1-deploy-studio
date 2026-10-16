// Observe one explicitly selected owned simulation. GET-only: this script never
// creates a scenario, starts a worker, changes a policy, or connects to hardware.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8790';
const evidence=process.env.STUDIO_EVIDENCE;
assert.ok(evidence,'Set STUDIO_EVIDENCE outside Git');
assert.ok(process.env.STUDIO_ACTIVE_JOB||process.env.STUDIO_ACTIVE_JOB_FILE,'Select an actual active job explicitly');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname));
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1512,height:1100}}),errors=[],httpErrors=[],checks=[],observations=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('response',response=>{if(response.status()>=400)httpErrors.push(`${response.status()} ${response.url()}`);});
await page.route('**/api/**',route=>{
 assert.equal(route.request().method(),'GET','Acceptance must remain a telemetry consumer');
 return route.continue();
});
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function get(url){const response=await page.request.get(base+url);assert.equal(response.status(),200);return response.json();}
async function ready(id){await page.waitForFunction(id=>window.__studio?.state.sessionId===id&&!window.__studio.state.loading&&document.querySelector('#loading-overlay').hidden,id,{timeout:60000});}
async function capture(name){await page.screenshot({path:path.join(evidence,name+'.png'),fullPage:true});}
function inspect(session,frame,time){
 assert.equal(session.metadata.command_path_enabled,false);assert.equal(session.metadata.fixture,false);
 assert.equal(session.metadata.pipeline_contract.flow_engine,'pytorch-eager');assert.equal(session.metadata.pipeline_contract.sonic_engine,'onnxruntime');
 assert.equal(frame.qpos.length,36);assert.ok(frame.source_time<=time+1e-7);
 const result={time,source_time:frame.source_time,frame_sequence:frame.sequence,mode:session.metadata.mode};
 for(const kind of ['flow','sonic']){
  const index=frame.pipeline?.[`${kind}_index`],sample=session.pipeline?.[`${kind}_samples`]?.[index];
  assert.ok(Number.isInteger(index)&&sample,`${kind} index resolves from the actual session envelope`);
  assert.ok(sample.source_time<=time+1e-7,`${kind} sample is causal`);
  result[kind]={index,sequence:sample.sequence,source_time:sample.source_time,count:session.pipeline[`${kind}_samples`].length};
  if(kind==='sonic'){assert.equal(sample.input.values.length,1570);assert.equal(sample.output.values.length,29);result.sonic.inference_ms=sample.inference_ms;}
 }
 return result;
}
let id=process.env.STUDIO_ACTIVE_JOB;
try{
 // Cache the real model before the independently launched short worker starts.
 const warmup=process.env.STUDIO_WARMUP_JOB||'job-be7f6d4ba03d';
 await page.goto(`${base}/?session=${warmup}&panel=health&map=1&pin=lidar_filtered&camera=follow`);await ready(warmup);
 await writeFile(path.join(evidence,'observer-ready.json'),JSON.stringify({base,ready:true,warmup,policy_started:false}));
 const deadline=Date.now()+120000;
 while(!id&&Date.now()<deadline){try{id=(await readFile(process.env.STUDIO_ACTIVE_JOB_FILE,'utf8')).trim();}catch(error){if(error.code!=='ENOENT')throw error;}if(!id)await sleep(200);}
 assert.match(id||'',/^job-[a-f0-9]+$/,'Expected an explicit owned job ID');
 let job;
 while(Date.now()<deadline){job=await get(`/api/jobs?id=${encodeURIComponent(id)}`);if(job.latest?.frame?.pipeline&&job.latest?.perception)break;assert.ok(['queued','starting','running'].includes(job.status),`Worker ended before an observable model sample: ${job.status}`);await sleep(100);}
 assert.ok(job?.latest?.pipeline,'Need actual live model-boundary samples');assert.ok(['starting','running'].includes(job.status),'Direct-load test requires a running producer');
 const direct=await get(`/api/session?id=${id}`);assert.equal(direct.metadata.mode,'simulation');observations.push({phase:'direct-api',...inspect(direct,direct.frames.at(-1),direct.frames.at(-1).time)});
 checks.push('Direct active-session API includes causal Flow and SONIC samples for its indexed frame');
 await page.goto(`${base}/?session=${id}&panel=pipeline&stage=sonic&map=1&pin=lidar_filtered&camera=follow`);await ready(id);
 const initial=await page.evaluate(()=>({session:window.__studio.state.session,frame:window.__studio.state.frame,time:window.__studio.state.time}));
 assert.equal(initial.session.metadata.mode,'simulation');observations.push({phase:'direct-browser',...inspect(initial.session,initial.frame,initial.time)});
 assert.match(await page.locator('#pipeline-stage-detail').innerText(),/1 × 1570/);assert.ok(await page.locator('#layer-perception').isChecked());const directCaption=await page.locator('#reference-caption').innerText();assert.match(directCaption,/causal simulated LiDAR map · sample/);assert.doesNotMatch(directCaption,/final accumulated|unavailable/);assert.ok(Number.isFinite(initial.session.perception.time));
 await page.waitForSelector('#sensor-dock [data-sensor-card="lidar_filtered"]');await capture('direct-active-model-inspector');
 checks.push('Direct browser load shows actual live ONNX input/output with timestamped LiDAR/map caption');
 await page.click('#workspace-test');await page.waitForSelector('#job-picker');await page.waitForFunction(id=>window.__workbench.state.jobs?.some(row=>row.id===id),id);await page.selectOption('#job-picker',id);
 await page.waitForFunction(id=>window.__workbench.state.job?.id===id&&document.querySelector('#watch-job'),id);await page.click('#watch-job');
 await page.waitForFunction(()=>window.__workbench.state.live&&window.__studio.state.runtime?.worker_alive===true);await page.click('#workspace-replay');await page.click('#tab-pipeline');await page.click('[data-pipeline-stage="sonic"]');
 await page.waitForFunction(time=>window.__studio.state.time>time+.1,initial.time,{timeout:30000});
 const advancing=await page.evaluate(()=>({session:window.__studio.state.session,frame:window.__studio.state.frame,time:window.__studio.state.time,runtime:window.__studio.state.runtime}));
 assert.equal(advancing.session.metadata.mode,'simulation');observations.push({phase:'advancing-browser',...inspect(advancing.session,advancing.frame,advancing.time),runtime:advancing.runtime});
 for(const frame of advancing.session.frames)inspect(advancing.session,frame,frame.time);
 await capture('attached-advancing-model-inspector');checks.push('Attached worker advances simulation cursor with valid bounded pipeline indices for retained samples');
 await page.waitForFunction(()=>['completed','failed','cancelled'].includes(window.__workbench.state.job?.status),null,{timeout:120000});
 job=await get(`/api/jobs?id=${id}`);assert.equal(job.status,'completed',job.error??'Worker did not complete');assert.equal(job.runtime.worker_alive,false);assert.ok(job.result_session_id);
 await page.click('#workspace-test');await page.waitForSelector('#open-job-replay');await page.click('#open-job-replay');await ready(id);await page.waitForFunction(()=>window.__studio.state.session.metadata.mode==='replay');
 const replay=await page.evaluate(()=>({session:window.__studio.state.session,frame:window.__studio.state.frame,time:window.__studio.state.time}));
 assert.equal(replay.session.frames.length,job.summary.report.control_steps);assert.ok(replay.session.frames.length>advancing.session.frames.length);observations.push({phase:'recorded-handoff',...inspect(replay.session,replay.frame,replay.time),frames:replay.session.frames.length,outcome:job.summary.report.outcome});
 await page.evaluate(()=>window.__studio.seek(window.__studio.state.session.metadata.duration_s/2));await page.waitForFunction(()=>window.__workbench.state.sensors?.cursor_s===window.__studio.state.time);
 assert.equal(await page.locator('#panel-health').isVisible(),true);assert.ok(await page.locator('#layer-perception').isChecked());await capture('completed-recording-health');
 await page.click('#tab-pipeline');await page.click('[data-pipeline-stage="sonic"]');assert.match(await page.locator('#pipeline-stage-detail').innerText(),/1 × 1570/);await capture('completed-recording-onnx');
 checks.push('Completed worker exits and opens its full recording with synchronized LiDAR, map, Health and model inspector');
 assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);
 await writeFile(path.join(evidence,'live-pipeline-acceptance.json'),JSON.stringify({base,id,checks,observations,errors,httpErrors,policy_launch:'External operator-owned CPU test; observer uses GET only',timing_note:'Visualization attached during this separate smoke test; do not compare its wall timing to browser-free policy batches.'},null,2));
 console.log(JSON.stringify({id,checks:checks.length,evidence},null,2));
}catch(error){await capture('failure');await writeFile(path.join(evidence,'live-pipeline-failure.json'),JSON.stringify({id,error:String(error),checks,observations,errors,httpErrors},null,2));throw error;}finally{await browser.close();}
