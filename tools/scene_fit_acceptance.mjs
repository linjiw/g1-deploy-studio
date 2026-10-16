// Explicit rendering fixture only. No policy execution, uploaded map, or motion claim.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8790',evidence=process.env.STUDIO_EVIDENCE;assert.ok(evidence);await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage(),errors=[],checks=[];page.on('pageerror',e=>errors.push(e.message));
const boxes=[{center_xy:[-50,-50],half_xy:[20,20],z_bottom:0,z_top:2},{center_xy:[50,50],half_xy:[20,20],z_bottom:0,z_top:2}],corners=[];
for(const box of boxes)for(const dx of [-20,20])for(const dy of [-20,20])for(const z of [0,2])corners.push([box.center_xy[0]+dx,box.center_xy[1]+dy,z]);
try{
 const source=await (await page.request.get(base+'/api/session?id=sonic-lockstep')).json();
 const fixture=structuredClone(source);Object.assign(fixture.metadata,{fixture:true,title:'RENDERING TEST FIXTURE · large map',goal_xy:[50,50],start_xy:[-50,-50],command_path_enabled:false});fixture.environment={boxes,classification:'rendering-test-fixture'};fixture.trajectory=[[-50,-50,0],[50,50,0]];
 await page.route('**/api/session?id=sonic-lockstep',route=>route.fulfill({contentType:'application/json',body:JSON.stringify(fixture)}));
 for(const viewport of [{width:1512,height:1100},{width:390,height:844}]){
  await page.setViewportSize(viewport);await page.goto(base+'/?session=sonic-lockstep&camera=scene&panel=source');await page.waitForFunction(()=>window.__studio?.state.session&&!window.__studio.state.loading&&document.querySelector('#loading-overlay').hidden);
  // Visible fixture label is deliberately independent of the borrowed G1 asset.
  await page.locator('.viewport-top h2').evaluate(node=>node.textContent='RENDERING TEST FIXTURE · large map');
  await page.waitForFunction(()=>window.__studio.cameraFit.distance>60);
  const fitted=await page.evaluate(points=>({projection:window.__studio.projectWorld(points),fit:window.__studio.cameraFit}),corners);assert.ok(fitted.projection.every(p=>Math.abs(p[0])<.9&&Math.abs(p[1])<.9&&Math.abs(p[2])<1));assert.ok(fitted.fit.maxDistance>fitted.fit.distance&&fitted.fit.far>fitted.fit.distance);
  await page.locator('#viewport').scrollIntoViewIfNeeded();await page.screenshot({path:path.join(evidence,`large-replay-${viewport.width}.png`),fullPage:true});
  await page.evaluate(boxes=>window.__studio.showPreparationMap({label:'RENDERING TEST FIXTURE · large map',kind:'boxes',frame_id:'world',bounds:{min:[-70,-70],max:[70,70]},boxes}),boxes);await page.waitForTimeout(200);
  const prepared=await page.evaluate(points=>({projection:window.__studio.projectWorld(points),fit:window.__studio.cameraFit}),corners);assert.ok(prepared.projection.every(p=>Math.abs(p[0])<.9&&Math.abs(p[1])<.9&&Math.abs(p[2])<1));await page.screenshot({path:path.join(evidence,`large-preparation-${viewport.width}.png`),fullPage:true});checks.push({viewport,replay:fitted.fit,preparation:prepared.fit,corners_in_view:true});
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'scene-fit-acceptance.json'),JSON.stringify({fixture:true,claims:'Rendering only; no policy or measured motion claim',checks,errors},null,2));console.log(JSON.stringify({checks:checks.length,evidence}));
}finally{await browser.close();}
