// Read-only before/after review of explicitly listed real CPU recordings.
// This script has no POST requests and never starts a policy or simulator.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
for(const name of ['STUDIO_BEFORE_REPORT','STUDIO_AFTER_REPORT','STUDIO_EVIDENCE'])assert.ok(process.env[name],`Set ${name}`);
const before=JSON.parse(await readFile(process.env.STUDIO_BEFORE_REPORT,'utf8')),after=JSON.parse(await readFile(process.env.STUDIO_AFTER_REPORT,'utf8'));
const base=process.env.STUDIO_URL||after.base||'http://127.0.0.1:8790',evidence=process.env.STUDIO_EVIDENCE;
assert.ok(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname));
assert.equal(after.results.length,after.cases.length);assert.ok(after.results.length>0&&after.results.length<=6);
const pairs=after.results.map(current=>{const original=before.results.find(row=>row.name===current.name);assert.ok(original,`Missing baseline ${current.name}`);for(const row of [original,current])assert.ok(['completed','failed'].includes(row.status));assert.deepEqual(current.requested,original.requested,`Preserve exact original inputs ${current.name}`);return {name:current.name,before:original,after:current};});
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1512,height:1100}}),errors=[],httpErrors=[],reviews=[];
page.on('pageerror',error=>errors.push(error.message));page.on('response',response=>{if(response.status()>=400)httpErrors.push(`${response.status()} ${response.url()}`);});
async function seek(time){await page.evaluate(t=>window.__studio.seek(t),time);await page.waitForFunction(t=>Math.abs((window.__workbench?.state.sensors?.cursor_s??-1)-t)<1e-7,time);}
async function save(){await writeFile(path.join(evidence,'comparison-view.json'),JSON.stringify({base,source_reports:{before:process.env.STUDIO_BEFORE_REPORT,after:process.env.STUDIO_AFTER_REPORT},reviews,errors,httpErrors},null,2));}
try{
 for(const pair of pairs){
  const comparison={name:pair.name,requested:pair.after.requested,runs:[]};
  const commonTime=Number((Math.min(pair.before.summary.report.elapsed_s,pair.after.summary.report.elapsed_s)*.55).toFixed(3));
  for(const variant of ['before','after']){
   const result=pair[variant],id=result.job_id,source=result.summary.report;
   const url=`${base}/?session=${encodeURIComponent(id)}&panel=health&map=1&pin=lidar_filtered&camera=follow&speed=0.5&loop=1`;
   await page.goto(url);await page.waitForFunction(({id,count})=>window.__studio?.state.sessionId===id&&!window.__studio.state.loading&&document.querySelector('#loading-overlay').hidden&&window.__studio.state.session.frames.length===count,{id,count:source.control_steps},{timeout:60000});
   const meta=await page.evaluate(()=>window.__studio.state.session.metadata);assert.deepEqual(meta.goal_xy,result.requested.goal_xy);assert.equal(meta.command_path_enabled,false);assert.equal(meta.fixture,false);assert.equal(meta.test_result.outcome,source.outcome);assert.ok(await page.locator('#layer-perception').isChecked());assert.equal(await page.locator('#panel-health').isVisible(),true);
   const samples=[];
   for(const [label,time,camera] of [['common-time',commonTime,'follow'],['end',meta.duration_s,'follow'],['full-scene',meta.duration_s,'scene']]){
    const draws=await page.evaluate(kind=>{window.__studio.cameraView(kind,true);return window.__studio.sceneDrawCount;},camera);await seek(time);await page.waitForFunction(count=>window.__studio.sceneDrawCount>count,draws);assert.equal(await page.locator('#sensor-dock [data-sensor-card]').count(),1);
    const view=await page.evaluate(()=>{const s=window.__studio.state,w=window.__workbench.state;return {cursor_s:s.time,state_source_time:s.frame.source_time,position:s.frame.position,quaternion_wxyz:s.frame.quaternion_wxyz,health:s.frame.health,map_time:window.__studio.mapSample?.time,goal:window.__studio.navigationMarkers.goal,projection:window.__studio.navigationScreen,sensors:w.sensors.sensors.filter(sensor=>['lidar_filtered','map_support'].includes(sensor.id)).map(sensor=>({id:sensor.id,available:sensor.available,sample_time_s:sensor.sample_time_s,age_ms:sensor.age_ms,frame: sensor.frame_id}))};});
    assert.ok(view.state_source_time<=time+1e-7);assert.ok(view.map_time<=time+1e-7);assert.deepEqual(view.goal.slice(0,2),result.requested.goal_xy);assert.equal(view.sensors.length,2);assert.ok(view.sensors.every(sensor=>sensor.available&&sensor.sample_time_s<=time+1e-7));assert.ok(Math.abs(Math.hypot(...view.quaternion_wxyz)-1)<1e-5);assert.equal(await page.locator('#recording-warning').isVisible(),meta.recording_complete===false);
    const viewport=await page.locator('.viewport-shell').boundingBox(),dock=await page.locator('#sensor-dock').boundingBox();assert.ok(dock.y>=viewport.y+viewport.height);if(camera==='scene')assert.ok(view.projection.every(marker=>Math.abs(marker.ndc[0])<.95&&Math.abs(marker.ndc[1])<.95));
    if(variant==='after')assert.ok((await page.locator('.health-timing').innerText()).includes(view.health.sonic_inference_ms.toFixed(2)));
    const screenshot=path.join(evidence,`${pair.name}-${variant}-${label}.png`);await page.screenshot({path:screenshot,fullPage:true});samples.push({label,camera,screenshot,...view});
   }
   await seek(.2);await page.click('#play');await page.waitForFunction(()=>window.__studio.state.time>.34);await page.click('#play');await seek(meta.duration_s-.02);await page.click('#play');await page.waitForFunction(()=>window.__studio.state.playing&&window.__studio.state.time<.5);await page.click('#play');
   comparison.runs.push({variant,id,outcome:source.outcome,elapsed_s:source.elapsed_s,frames:source.control_steps,samples,half_speed_playback:true,loop:true,replay_url:`${url}&time=${commonTime}&play=1`});console.log(`${pair.name} ${variant}: ${id}, ${source.outcome}, LiDAR/map/Health, common t=${commonTime}, end and full scene`);
  }
  reviews.push(comparison);await save();
 }
 assert.deepEqual(errors,[]);assert.deepEqual(httpErrors,[]);await save();
}catch(error){await page.screenshot({path:path.join(evidence,'comparison-failure.png'),fullPage:true});await save();throw error;}finally{await browser.close();}
