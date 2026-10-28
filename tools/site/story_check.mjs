#!/usr/bin/env node
// LfH explainer and curated films: data parity, keyboard/touch layouts and honest recording identity.
// SITE_URL=http://127.0.0.1:8816 SITE_EVIDENCE=/absolute/evidence node tools/site/story_check.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { selectShowcase } from '../../site/js/showcase.js';

const base = (process.env.SITE_URL || 'http://127.0.0.1:8816/').replace(/\/?$/, '/');
const out = process.env.SITE_EVIDENCE || '/tmp/g1-site-story';
await mkdir(out, { recursive: true });
const catalog = await (await fetch(`${base}data/worlds.json`)).json();
const chosen = selectShowcase(catalog);
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const results=[];
async function check(name, fn, width=1440) {
  const context = await browser.newContext({ viewport:{width,height:900}, deviceScaleFactor:1, isMobile:width<600, hasTouch:width<600, reducedMotion:'reduce' });
  const p=await context.newPage(), errors=[], requests=[];
  p.on('pageerror',e=>errors.push(e.message));p.on('request',r=>requests.push(r.url()));
  try { await fn(p,requests); assert.deepEqual(errors,[],'page errors'); results.push({name,ok:true});console.log(`PASS ${name}`); }
  catch(e) { results.push({name,ok:false,error:e.message,pageErrors:errors});console.log(`FAIL ${name}: ${e.message}`);await p.screenshot({path:path.join(out,`${results.length}-failure.png`)}).catch(()=>{}); }
  finally { await context.close(); }
}
await check('Selected highlights satisfy published criteria in the catalog and exact raw walks', async p=>{
  assert.equal(chosen.length,3);
  for(const row of chosen) {
    const raw=await(await fetch(`${base}data/${row.world}/g/${row.id}.json`)).json();
    assert.equal(raw.outcome,'arrived'); assert.equal(raw.max_contact_n,0);assert.ok(raw.final_dist_m<=.4);
    assert.ok(raw.time.at(-1)<=20);assert.equal(Math.max(...raw.contact_n.filter(Number.isFinite)),0);
  }
  const missing=structuredClone(catalog);for(const w of missing.worlds)for(const r of w.list)r[w.list_fields.indexOf('contact_n')]=null;
  assert.deepEqual(selectShowcase(missing),[],'Missing contact must never become a clean showcase');
  await p.goto(base);await p.locator('#showcase[data-ready=true]').waitFor();
  assert.equal(await p.locator('.showcase-card').count(),3);
  for(const row of chosen) {
    const card=p.locator(`.showcase-card[data-world="${row.world}"]`);
    assert.equal(await card.getAttribute('data-goal'),row.id);
    assert.match(await card.innerText(),new RegExp(row.final_m.toFixed(2).replace('.','\\.')));
  }
  assert.match(await p.locator('.showcase-context').innerText(),/student-s2-kcsc/);
});
await check('Research story remains light before playback and posters name exact selected walks', async(p,requests)=>{
  await p.goto(base);await p.locator('#showcase[data-ready=true]').waitFor();await p.locator('#showcase').scrollIntoViewIfNeeded();
  await p.locator('.showcase-card').last().scrollIntoViewIfNeeded();
  await p.waitForFunction(()=>[...document.querySelectorAll('.showcase-card img')].every(i=>i.complete&&i.naturalWidth>0));
  assert.equal(await p.locator('.showcase-card img').count(),chosen.length);
  const heavy=requests.filter(url=>/three\.module|meshes\.bin|\/g\/g\d\d-\d\d\.json|\.mp4$/.test(url));
  assert.deepEqual(heavy,[],'No renderer, individual walks or film downloads before interaction');
  assert.equal(await p.locator('#showcase-film').getAttribute('preload'),'none');
  await p.locator('.top').evaluate(n=>n.style.visibility='hidden');
  await p.locator('#showcase').screenshot({path:path.join(out,'showcase-desktop.png')});
});
await check('LfH is a conceptual six-step interactive illustration with keyboard controls', async p=>{
  await p.goto(`${base}#learning`);await p.locator('[data-lfh-step="0"]').waitFor();
  assert.equal(await p.locator('[data-lfh-step]').count(),6);
  assert.match(await p.locator('.lfh-caveat').innerText(),/not a training sample.*recorded robot telemetry/);
  await p.locator('[data-lfh-step="0"]').focus();await p.keyboard.press('ArrowRight');
  assert.equal(await p.locator('#lfh-explainer').getAttribute('data-step'),'1');
  const before=await p.locator('[data-lfh-svg]').innerHTML();
  await p.getByRole('button',{name:'Another scene'}).click();
  assert.notEqual(await p.locator('[data-lfh-svg]').innerHTML(),before);
  await p.getByRole('button',{name:'Upright',exact:true}).click();
  assert.equal(await p.locator('[data-lfh-motion="walk"]').getAttribute('aria-pressed'),'true');
  await p.locator('[data-lfh-progress]').fill('76');
  assert.match(await p.locator('[data-lfh-progress]').getAttribute('aria-valuetext'),/76 percent/);
  const still=await p.locator('[data-lfh-svg]').innerHTML();await p.waitForTimeout(600);assert.equal(await p.locator('[data-lfh-svg]').innerHTML(),still);
  await p.locator('[data-lfh-step="1"]').focus();await p.keyboard.press('End');
  assert.equal(await p.locator('#lfh-explainer').getAttribute('data-step'),'5');
  assert.match(await p.locator('[data-lfh-description]').innerText(),/SONIC/);
  assert.equal(await p.locator('.lfh-controls').isVisible(),false);
  assert.doesNotMatch(await p.locator('[data-lfh-hint]').innerText(),/slider/);
  await p.locator('[data-lfh-step="1"]').click();await p.getByRole('button',{name:'Duck',exact:true}).click();
  await p.locator('.top').evaluate(n=>n.style.visibility='hidden');
  await p.locator('#learning').screenshot({path:path.join(out,'lfh-desktop.png')});
});
await check('Curated film opens its exact recording and honors reduced motion', async p=>{
  await p.goto(base);await p.locator('#showcase[data-ready=true]').waitFor();
  const row=chosen[0];await p.locator(`.showcase-card[data-world="${row.world}"] .showcase-shot`).click();
  await p.waitForFunction(()=>!!window.studioDemo?.S.walk,null,{timeout:60000});
  const state=await p.evaluate(()=>({world:window.studioDemo.S.worldId,goal:window.studioDemo.S.walk.goal_id,camera:window.studioDemo.cameraMode,playing:window.studioDemo.S.playing}));
  assert.deepEqual(state,{world:row.world,goal:row.id,camera:'film',playing:false});
  await p.evaluate(()=>window.studioDemo.seek(2.4));
  assert.ok(await p.evaluate(()=>window.studioDemo.S.t>2));
  await p.locator('#demo-stage').screenshot({path:path.join(out,'showcase-replay.png')});
});
await check('320 px phone keeps the story and controls in bounds', async p=>{
  await p.goto(base);await p.locator('#showcase[data-ready=true]').waitFor();
  await p.locator('#learning').scrollIntoViewIfNeeded();await p.locator('[data-lfh-step="0"]').waitFor();
  assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'page overflow');
  for(const selector of ['.showcase-card','.lfh-explainer','.lfh-controls','.hero']) {
    const boxes=await p.locator(selector).evaluateAll(ns=>ns.map(n=>({l:n.getBoundingClientRect().left,r:n.getBoundingClientRect().right})));
    assert.ok(boxes.every(b=>b.l>=-1&&b.r<=321),`${selector}: ${JSON.stringify(boxes)}`);
  }
  await p.locator('[data-lfh-step="4"]').click();assert.equal(await p.locator('#lfh-explainer').getAttribute('data-step'),'4');
  await p.locator('[data-lfh-next]').click();assert.equal(await p.locator('#lfh-explainer').getAttribute('data-step'),'5');
  await p.locator('.top').evaluate(n=>n.style.visibility='hidden');
  await p.locator('#learning').screenshot({path:path.join(out,'lfh-phone.png')});
},320);
await check('Desktop navigation fits and the complete menu works without clipping', async p=>{
  await p.goto(base);
  for(const width of [1121,1280,1440]) {
    await p.setViewportSize({width,height:900});
    const nav=await p.locator('.top > nav').evaluate(n=>({width:n.clientWidth,scroll:n.scrollWidth}));
    assert.ok(nav.width>0 && nav.scroll<=nav.width,`${width}: ${JSON.stringify(nav)}`);
    assert.ok(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
    await p.locator('.menu summary').click();
    assert.equal(await p.locator('.menu nav a[href="#research-film"]').count(),1);
    await p.keyboard.press('Escape');assert.equal(await p.locator('.menu').getAttribute('open'),null);
    assert.equal(await p.evaluate(()=>document.activeElement.tagName),'SUMMARY');
  }
});
await check('Highlight video decodes real frames and pauses when scrolled away', async p=>{
  await p.goto(base);await p.locator('#showcase-film').scrollIntoViewIfNeeded();
  await p.locator('#showcase-film').evaluate(v=>v.play());
  await p.waitForFunction(()=>document.getElementById('showcase-film').currentTime>.15,null,{timeout:20000});
  assert.ok(await p.locator('#showcase-film').evaluate(v=>v.videoWidth>0&&v.videoHeight>0));
  await p.locator('#learning').scrollIntoViewIfNeeded();
  await p.waitForFunction(()=>document.getElementById('showcase-film').paused);
});
await check('Hero opens the newer research film with source metrics, captions and playable frames', async p=>{
  await p.goto(base);
  assert.equal(await p.locator('.hero .primary').getAttribute('href'),'#research-film');
  assert.equal(await p.locator('.top > nav a').filter({hasText:'Watch'}).getAttribute('href'),'#showcase');
  await p.locator('.hero .primary').click();
  assert.equal(new URL(p.url()).hash,'#research-film');
  assert.equal(await p.locator('#research-video').getAttribute('preload'),'none');
  const receipt=await(await fetch(`${base}media/research/metadata.json`)).json();
  assert.equal(receipt.simulation,'Isaac');assert.equal(receipt.clips.length,2);
  const copy=await p.locator('.research-film-copy').innerText();
  for(const clip of receipt.clips) {
    assert.equal(clip.result.outcome,'goal_completion');
    assert.equal(clip.result.maximum_obstacle_contact_n,0);
    assert.ok(copy.includes(`${clip.result.elapsed_s.toFixed(2)} s`));
    assert.ok(copy.includes(`${clip.result.final_goal_distance_xy_m.toFixed(3)} m`));
    assert.equal(clip.provenance.recording_source_commit,null,'Do not invent the recorded source revision');
  }
  const captions=await(await fetch(`${base}media/research/highlights.vtt`)).text();
  assert.match(captions,/^WEBVTT/);assert.match(captions,/Gray:.*Pink:/);
  await p.locator('#research-video').evaluate(v=>v.play());
  await p.waitForFunction(()=>document.getElementById('research-video').currentTime>.15,null,{timeout:20000});
  assert.ok(await p.locator('#research-video').evaluate(v=>v.videoWidth>0&&v.videoHeight>0));
  await p.locator('#research-video').evaluate(v=>v.pause());
  await p.locator('.top').evaluate(n=>n.style.visibility='hidden');
  await p.locator('#research-film').screenshot({path:path.join(out,'research-film.png')});
  await p.locator('#research-video').evaluate(v=>v.play());
  await p.locator('.hero').scrollIntoViewIfNeeded();
  await p.waitForFunction(()=>document.getElementById('research-video').paused);
});
await check('Catalog outage gives showcase retry without replacing missing telemetry with values',async p=>{
  let fail=true;await p.route('**/data/worlds.json',r=>fail?r.fulfill({status:503,body:'unavailable'}):r.continue());
  await p.goto(base);await p.locator('#showcase').scrollIntoViewIfNeeded();await p.locator('#showcase .section-status').waitFor();
  assert.equal(await p.locator('.showcase-card').count(),0);
  fail=false;await p.locator('#showcase').getByRole('button',{name:'Try again'}).click();await p.locator('#showcase[data-ready=true]').waitFor();
  assert.equal(await p.locator('.showcase-card').count(),chosen.length);
});
await browser.close();await writeFile(path.join(out,'story.json'),JSON.stringify({selected:chosen,results},null,2));
console.log(`${results.filter(r=>r.ok).length}/${results.length} passed`);process.exitCode=results.some(r=>!r.ok)?1:0;
