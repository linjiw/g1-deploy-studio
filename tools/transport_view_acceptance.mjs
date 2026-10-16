// Read-only usability checks against an actual decoded rehearsal recording.
import {chromium} from '@playwright/test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
const base=process.env.STUDIO_URL||'http://127.0.0.1:8790',id=process.env.STUDIO_PIPELINE_JOB||'job-13c4ac059f7a',evidence=process.env.STUDIO_EVIDENCE;
assert.ok(evidence,'Set STUDIO_EVIDENCE outside Git');await mkdir(evidence,{recursive:true});
const browser=await chromium.launch({executablePath:process.env.CHROME_PATH||'/opt/google/chrome/chrome',headless:true,args:['--no-sandbox','--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const page=await browser.newPage(),errors=[],checks=[];page.on('pageerror',error=>errors.push(error.message));
async function visibleControls(){return page.evaluate(()=>Object.fromEntries(['play','timeline','speed'].map(id=>{const node=document.getElementById(id),rect=node.getBoundingClientRect(),hit=document.elementFromPoint(rect.x+rect.width/2,rect.y+rect.height/2);return [id,{top:rect.y,bottom:rect.bottom,visible:rect.y>=0&&rect.bottom<=innerHeight&&!!hit&&(node===hit||node.contains(hit))}];})));}
try{
 for(const [width,height] of [[1280,720],[1600,1000],[390,844]]){
  await page.setViewportSize({width,height});await page.goto(`${base}/?session=${id}&panel=health&map=1&pin=lidar_filtered&camera=follow&time=.8&speed=.5`);await page.waitForFunction(id=>window.__studio?.state.sessionId===id&&!window.__studio.state.loading&&window.__workbench.state.sensors?.cursor_s===.8,id,{timeout:60000});await page.waitForTimeout(300);
  const controls=await visibleControls();assert.ok(Object.values(controls).every(item=>item.visible),`Transport must be visible and clickable without scrolling at ${width}×${height}: ${JSON.stringify(controls)}`);
  assert.equal(await page.evaluate(()=>scrollY),0);assert.ok(await page.evaluate(()=>document.body.scrollWidth<=innerWidth));assert.ok(await page.locator('#layer-perception').isChecked());assert.equal(await page.locator('#panel-health').isVisible(),true);
  await page.screenshot({path:path.join(evidence,`transport-${width}x${height}.png`)});
  await page.click('#play');await page.waitForFunction(()=>window.__studio.state.time>.95);await page.click('#play');const range=await page.locator('#timeline').boundingBox();await page.mouse.click(range.x+range.width*.65,range.y+range.height/2);await page.waitForFunction(()=>window.__studio.state.time>1.5);assert.equal(await page.evaluate(()=>window.__studio.state.playing),false);
  if(width<600){await page.locator('#panel-health').scrollIntoViewIfNeeded();const scrolled=await visibleControls();assert.ok(Object.values(scrolled).every(item=>item.visible),'Mobile transport remains reachable while reading Health');await page.screenshot({path:path.join(evidence,'transport-mobile-health.png')});}
  checks.push({width,height,controls,click_play_pause_seek:true});
 }
 assert.deepEqual(errors,[]);await writeFile(path.join(evidence,'transport-view-acceptance.json'),JSON.stringify({base,id,checks,errors},null,2));console.log(JSON.stringify({checks:checks.length,evidence}));
}catch(error){await page.screenshot({path:path.join(evidence,'failure.png')});throw error;}finally{await browser.close();}
