// Read-only browser proof using existing real policy recordings; starts no worker.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8790';
const cases=[['collision',process.env.STUDIO_COLLISION_JOB,'obstacle_collision','Obstacle collision'],['timeout',process.env.STUDIO_TIMEOUT_JOB,'timeout','Timed out'],['goal',process.env.STUDIO_GOAL_JOB,'goal_completion','Goal reached']];
assert.ok(cases.every(([,id])=>id),'Set STUDIO_COLLISION_JOB, STUDIO_TIMEOUT_JOB and STUDIO_GOAL_JOB to existing recorded jobs.');
const evidence=process.env.STUDIO_EVIDENCE||path.join(os.homedir(),'research-data/g1-deploy-studio/evidence/recorded-outcome');
await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage({viewport:{width:1512,height:1100}}),errors=[],checks=[];
page.on('pageerror',error=>errors.push(error.message));
const get=async url=>{const response=await page.request.get(base+url);assert.equal(response.status(),200);return response.json();};
const factText=(parent,label)=>page.locator(`${parent} > .fact`).filter({has:page.locator('span',{hasText:new RegExp('^'+label+'$')})}).locator('strong').textContent();
try {
  for(const [name,id,outcome,label]of cases){
    const recording=await get(`/api/session?id=${id}`),result=recording.metadata.test_result,last=recording.frames.at(-1),interval=last.post_action.contact;
    assert.equal(result.outcome,outcome);
    await page.goto(`${base}/?session=${id}&panel=health&map=1&pin=lidar_filtered&camera=follow&time=${last.time}`);
    await page.waitForFunction(({id,time})=>window.__studio?.state.sessionId===id&&!window.__studio.state.loading&&window.__studio.state.time===time&&window.__workbench.state.sensors?.session_id===id&&window.__workbench.state.sensors.cursor_s===time,{id,time:last.time},{timeout:60000});
    assert.equal(await page.locator('#recorded-outcome').isVisible(),true);
    assert.match(await page.locator('#recorded-outcome').textContent(),/FINAL RECORDED OUTCOME · ENTIRE RUN/);
    assert.equal(await factText('#recorded-outcome','Policy result'),label);
    assert.equal(await factText('#recorded-outcome','Evaluator elapsed'),`${result.elapsed_s.toFixed(3)} s`);
    assert.equal(await factText('#recorded-outcome','Peak obstacle contact'),`${result.maximum_obstacle_contact_n.toFixed(2)} N`);
    const text=await page.locator('#recorded-outcome').textContent();
    assert.ok(text.includes(`${interval.start_s.toFixed(3)}–${interval.end_s.toFixed(3)} s: ${interval.max_force_n.toFixed(2)} N`));
    assert.ok(text.includes(`final rendered pose at ${last.time.toFixed(3)} s`));
    assert.equal(await factText('#health-content','Obstacle contact · completed interval'),last.health.contact_force_n===null?'Unavailable':`${last.health.contact_force_n.toFixed(2)} N`);
    assert.equal(await page.evaluate(()=>window.__studio.state.session.frames.length),recording.frames.length);
    assert.equal(await page.locator('#layer-perception').isChecked(),true);
    assert.equal(await page.locator('#sensor-dock [data-sensor-card="lidar_filtered"]').isVisible(),true);
    assert.equal(await page.locator('#tab-health').getAttribute('aria-selected'),'true');
    if(name==='collision'){
      assert.equal(last.time,7.44);assert.equal(interval.end_s,7.46);
      assert.equal(await factText('#health-content','Obstacle contact · completed interval'),'0.00 N');
      assert.equal(await factText('#recorded-outcome','Peak obstacle contact'),'238.61 N');
    }
    await page.screenshot({path:path.join(evidence,`${name}-final-outcome-lidar-map-health.png`),fullPage:true});
    await page.evaluate(()=>window.__studio.seek(.4));
    await page.waitForFunction(()=>window.__workbench.state.sensors?.cursor_s===.4);
    assert.equal(await page.locator('#recorded-outcome').textContent(),text,'Whole-run summary is explicitly independent of replay cursor.');
    assert.equal(await page.evaluate(()=>window.__studio.state.frame.time),.4);
    checks.push({case:name,id,outcome,frames:recording.frames.length,rendered_end_s:last.time,evaluator_end_s:result.elapsed_s,whole_run_peak_n:result.maximum_obstacle_contact_n,final_interval:interval,cursor_contact_n:last.health.contact_force_n,passed:true});
  }
  assert.deepEqual(errors,[]);
  await writeFile(path.join(evidence,'outcome-view.json'),JSON.stringify({base,checks,errors},null,2));console.log(JSON.stringify({checks,errors},null,2));
}catch(error){await page.screenshot({path:path.join(evidence,'outcome-view-failure.png'),fullPage:true});throw error;}finally{await browser.close();}
