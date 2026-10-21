#!/usr/bin/env node
// Still images of the site's own 3D view, for the hero, link previews and the README:
//   SITE_URL=http://127.0.0.1:8811/ node tools/site/shots.mjs <room> <goal> <seconds into the walk> <out dir>
// Writes hero.jpg (1200 × 900), og.png (1200 × 630) and site-navigate.png (a full playground screenshot).
import { chromium } from '@playwright/test';
import path from 'node:path';

const [room, goal, at, out] = process.argv.slice(2);
if (!out) { console.error('usage: shots.mjs <room> <goal> <seconds> <out dir>'); process.exit(2); }
const URL_ = process.env.SITE_URL || 'http://127.0.0.1:8811/';
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });

async function still(width, height, file, camera) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`${URL_}#try/${room}/${goal}`);
  await page.waitForSelector('#try.pg-ready', { timeout: 60000 });
  // The 3D view alone, full window: overlays hidden, the walk paused at the chosen moment.
  await page.addStyleTag({ content: `.top, .overlay, .timeline, .flash { display: none !important; } #pg-canvas { position: fixed !important; inset: 0 !important; z-index: 50; }` });
  await page.evaluate(async ({ at, camera }) => {
    const pg = window.studioPlayground;
    await pg.go();
    pg.pause();
    pg.seek(Number(at));
    pg.pause();
    const v = pg.viewer;
    v.resize();
    if (camera) { v.camera.position.set(...camera.position); v.controls.target.set(...camera.target); v.controls.update(); }
    v.dirty();
  }, { at, camera });
  await page.waitForTimeout(1500);
  await page.locator('#pg-canvas').screenshot({ path: file, type: file.endsWith('.jpg') ? 'jpeg' : 'png', quality: file.endsWith('.jpg') ? 86 : undefined });
  await page.context().close();
}

const camera = process.env.SHOT_CAMERA ? JSON.parse(process.env.SHOT_CAMERA) : null;
await still(1200, 900, path.join(out, 'hero.jpg'), camera);
await still(1200, 630, path.join(out, 'og.png'), camera);
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 })).newPage();
await page.goto(`${URL_}#try/${room}/${goal}`);
await page.waitForSelector('#try.pg-ready', { timeout: 60000 });
await page.evaluate(async at => { const pg = window.studioPlayground; await pg.go(); pg.pause(); pg.seek(Number(at)); pg.pause(); }, at);
await page.locator('#try').scrollIntoViewIfNeeded();
await page.evaluate(() => window.scrollBy(0, document.querySelector('#pg-worlds').getBoundingClientRect().top - 70));
await page.waitForTimeout(1500);
await page.screenshot({ path: path.join(out, 'site-navigate.png') });
await browser.close();
console.log('shots written to', out);
