// Bounded development navigation checks through the actual browser controls.
// Source outcomes are reported, never asserted to be successful navigation.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const base=process.env.STUDIO_URL||'http://127.0.0.1:8790';
assert.ok(['localhost','127.0.0.1','[::1]'].includes(new URL(base).hostname),'Loopback gateway required');
const evidence=process.env.STUDIO_EVIDENCE||path.join(os.homedir(),'research-data/g1-deploy-studio/evidence/navigation-workflow');
await mkdir(evidence,{recursive:true});
const catalog=await(await fetch(`${base}/api/workbench`)).json();
const maps=Object.fromEntries(catalog.maps.map(map=>[map.id,map]));
const preset=id=>structuredClone(maps[id].suggested_scenario);
const cases=process.env.STUDIO_CASES?JSON.parse(await readFile(process.env.STUDIO_CASES,'utf8')):[
  {name:'detour-short-quick',map_id:'flow-detour',...preset('flow-detour'),goal_xy:[.8,-.2],duration_s:4,planner:{candidates:2,ode_steps:4}},
  {name:'detour-short-expanded',map_id:'flow-detour',...preset('flow-detour'),goal_xy:[.8,-.2],duration_s:4,planner:{candidates:8,ode_steps:6}},
  {name:'detour-beyond-wall',map_id:'flow-detour',...preset('flow-detour'),duration_s:10},
  {name:'slalom-custom-heading',map_id:'flow-slalom',...preset('flow-slalom'),start_yaw_rad:.35,duration_s:8},
  {name:'corridor-through-beam',map_id:'flow-corridor',...preset('flow-corridor'),duration_s:10},
  {name:'corridor-custom-turn',map_id:'flow-corridor',...preset('flow-corridor'),goal_xy:[.8,.1],start_yaw_rad:1.2,duration_s:4,planner:{candidates:2,ode_steps:4}},
];
assert.ok(cases.length>0&&cases.length<=6,'At most six explicit development cases');
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1512,height:1100}});
const errors=[],failed=[],results=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
page.on('console',message=>{if(message.type()==='error')errors.push(message.text());});
page.on('response',response=>{if(response.status()>=400)failed.push(`${response.status()} ${response.url()}`);});
const snapshot=name=>page.screenshot({path:path.join(evidence,`${name}.png`),fullPage:true});
const save=()=>writeFile(path.join(evidence,'navigation-acceptance.json'),JSON.stringify({base,cases,checks,results,errors,failed,scope:'Fresh CPU development checks; no hardware, DDS or statistical success-rate claim'},null,2));
async function fill(id,value){await page.fill(`#${id}`,String(value));}
async function seek(time){await page.locator('#timeline').evaluate((node,t)=>{node.value=t;node.dispatchEvent(new Event('input',{bubbles:true}));},time);}
try{
  await page.goto(`${base}/?session=sonic-lockstep&panel=health&map=1`);
  await page.waitForFunction(()=>window.__studio?.robot&&document.querySelector('#loading-overlay').hidden,null,{timeout:60000});
  for(const [index,test] of cases.entries()){
    console.log(`Preparing ${index+1}/${cases.length}: ${test.name}`);
    await page.click('#workspace-prepare');await page.waitForSelector('#prepare-map');
    await page.selectOption('#prepare-map',test.map_id);
    await page.waitForFunction(id=>window.__workbench.state.map?.id===id,test.map_id);
    if(index===0){
      const old=await page.evaluate(()=>[...window.__workbench.state.config.goal_xy]);
      await page.click('#pick-goal');const box=await page.locator('#viewport').boundingBox();
      await page.mouse.click(box.x+box.width*.58,box.y+box.height*.6);
      const selected=await page.evaluate(()=>window.__workbench.state.config.goal_xy);
      assert.notDeepEqual(selected,old);assert.ok(selected.every(Number.isFinite));
      checks.push({name:'Viewport goal picking changes real world XY configuration',passed:true,selected});
      if(await page.locator('#pick-goal').getAttribute('aria-pressed')==='true')await page.click('#pick-goal');
    }
    for(const [id,value]of [['start-x',test.start_xy[0]],['start-y',test.start_xy[1]],['goal-x',test.goal_xy[0]],['goal-y',test.goal_xy[1]]])await fill(id,value);
    await page.click('#save-scenario');await page.waitForFunction(()=>window.__workbench.state.scenario?.id);
    assert.match(await page.locator('#scenario-result').textContent(),/Scenario saved/);
    await snapshot(`${test.name}-prepare`);
    await page.click('#workspace-test');
    await page.locator('#test-settings').evaluate(node=>node.open=true);
    for(const [id,value]of [['test-duration',test.duration_s],['test-yaw',test.start_yaw_rad],['test-seed',test.seed],['test-candidates',test.planner.candidates],['test-ode',test.planner.ode_steps]])await fill(id,value);
    const previous=await page.evaluate(()=>window.__workbench.state.job?.id);
    await page.click('#start-job');
    await page.waitForFunction(previous=>window.__workbench.state.job?.id&&window.__workbench.state.job.id!==previous,previous,{timeout:30000});
    const id=await page.evaluate(()=>window.__workbench.state.job.id);
    const result={name:test.name,job_id:id,requested:test,map_provenance:maps[test.map_id].provenance};results.push(result);await save();
    await page.waitForFunction(()=>window.__workbench.state.job?.latest?.frame&&window.__studio.state.sessionId===window.__workbench.state.job.id&&window.__studio.robot,null,{timeout:120000});
    result.live=await page.evaluate(()=>({time:window.__studio.state.time,mode:window.__studio.state.session.metadata.mode,health:window.__studio.state.frame.health}));
    assert.equal(result.live.mode,'simulation');assert.ok(result.live.health.sonic_inference_ms>0);
    await snapshot(`${test.name}-live`);
    await page.waitForFunction(()=>['completed','failed','cancelled'].includes(window.__workbench.state.job?.status),null,{timeout:190000});
    const job=await page.evaluate(()=>window.__workbench.state.job);
    result.status=job.status;result.output_path=job.output_path;result.summary=job.summary;await save();
    assert.ok(['completed','failed'].includes(job.status),job.error??job.log_tail);
    assert.ok(job.result_session_id,'Execution must retain its actual recording, including source runtime failures');
    assert.deepEqual(job.scenario.goal_xy,test.goal_xy);assert.deepEqual(job.scenario.planner,test.planner);
    assert.equal(job.runtime.dds_participants,0);assert.equal(job.runtime.hardware_enabled,false);
    await snapshot(`${test.name}-outcome`);
    await page.click('#open-job-replay');
    await page.waitForFunction(id=>window.__studio.state.sessionId===id&&window.__studio.state.session.metadata.mode==='replay',id,{timeout:60000});
    const recording=await page.evaluate(()=>window.__studio.state.session);
    assert.deepEqual(recording.metadata.goal_xy,test.goal_xy);assert.equal(recording.metadata.fixture,false);
    if(job.status==='failed'){
      assert.equal(recording.metadata.incomplete,true);
      assert.equal(job.summary.report.outcome,'runtime_error');
    }
    result.frame_count=recording.frames.length;result.perception_count=recording.perception.frames.length;
    result.start_position=recording.frames[0].position;result.end_position=recording.frames.at(-1).post_action.qpos.slice(0,3);
    result.root_displacement_m=Math.hypot(...result.end_position.slice(0,2).map((v,i)=>v-result.start_position[i]));
    assert.ok(recording.frames.length>=25&&recording.perception.frames.length>=2);
    await seek(Math.min(recording.metadata.duration_s,.6*job.summary.report.elapsed_s));
    await page.click('#workspace-sensors');
    await page.waitForFunction(id=>window.__workbench.state.sensors?.session_id===id,id);
    for(const sensor of ['lidar_filtered','map_support']){
      if(!await page.evaluate(sensor=>window.__workbench.state.pinned.has(sensor),sensor))await page.locator(`#workbench-sensors [data-pin-sensor="${sensor}"]`).click();
    }
    await page.click('#workspace-replay');await page.check('#layer-perception');await page.click('#tab-health');
    await page.click('#camera-orbit');await snapshot(`${test.name}-lidar-map-health`);
    const sensors=await page.evaluate(()=>window.__workbench.state.sensors);
    result.sensor_samples=sensors.sensors.filter(s=>['lidar_filtered','map_support','contact'].includes(s.id)).map(s=>({id:s.id,available:s.available,time:s.sample_time_s,status:s.status}));
    assert.ok(result.sensor_samples.filter(s=>s.id!=='contact').every(s=>s.available));
    checks.push({name:`${test.name}: configured map/goal/settings → actual CPU motion → synchronized LiDAR/map/Health`,passed:true,job_id:id,outcome:job.summary.report.outcome});
    console.log(JSON.stringify({name:test.name,job_id:id,outcome:job.summary.report.outcome,goal_distance_m:job.summary.report.final_goal_distance_xy_m,wall_s:job.summary.wall_time_s}));await save();
    if(index===0){
      for(const tab of ['intent','joints','perception','graph','source']){await page.click(`#tab-${tab}`);await snapshot(`inspector-${tab}`);}
      await page.click('#tab-health');
      for(const camera of ['top','follow']){await page.click(`#camera-${camera}`);await snapshot(`camera-${camera}`);}
      await page.click('#camera-orbit');
      for(const layer of ['environment','perception','reference']){await page.uncheck(`#layer-${layer}`);await page.check(`#layer-${layer}`);}
      await seek(.2);await page.selectOption('#speed','0.5');await page.click('#play');await page.waitForTimeout(400);await page.click('#play');
      assert.ok(await page.evaluate(()=>window.__studio.state.time>.2));
      checks.push({name:'All six inspectors, camera modes, visibility layers and playback controls exercised on fresh obstacle recording',passed:true});
    }
  }
  await page.setViewportSize({width:390,height:844});await page.waitForTimeout(250);await snapshot('navigation-mobile');assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));
  checks.push({name:'Narrow viewport has no horizontal overflow',passed:true});
  assert.deepEqual(errors,[]);assert.deepEqual(failed,[]);await save();
}catch(error){await snapshot('navigation-failure');await writeFile(path.join(evidence,'navigation-failure.json'),JSON.stringify({error:error.stack,results,checks,errors,failed},null,2));throw error;}finally{await browser.close();}
