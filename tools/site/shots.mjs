#!/usr/bin/env node
// Still images of the site's own 3D views, rendered from a local build of the site:
//   SITE_URL=http://127.0.0.1:8811/ node tools/site/shots.mjs <assets dir> <media dir> [docs img dir]
// Writes, from the demo and the split view as a visitor sees them:
//   <assets>/hero.jpg (1200 × 900, the demo's poster), <assets>/og.png (1200 × 630, link previews),
//   <assets>/closer.jpg (the split view's poster), <media>/stills/<finding>.jpg (one per findings example, at its
//   moment) and, with a docs dir, <docs>/site-navigate.png (the demo mid-walk, for the README).
// The hero walk can be changed with HERO=<room>/<goal>@<seconds>.
import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

const [assets, media, docs] = process.argv.slice(2);
if (!media) { console.error('usage: shots.mjs <assets dir> <media dir> [docs img dir]'); process.exit(2); }
const URL_ = process.env.SITE_URL || 'http://127.0.0.1:8811/';
const [heroWalk, heroAt] = (process.env.HERO || 'slalom/g16-06@4.2').split('@');
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const featured = await (await fetch(new URL('data/featured.json', URL_))).json();
await mkdir(path.join(media, 'stills'), { recursive: true });
await mkdir(assets, { recursive: true });

// The demo, paused at a moment of a walk, framed on the robot and its goal; chrome hidden unless asked for.
async function demo({ walk, at, width, height, file, chrome = false, margin = 0.7, look = null }) {
  const page = await (await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`${URL_}demo/#${walk}`);
  await page.waitForFunction(() => window.studioDemo?.S.mode === 'staged', null, { timeout: 60000 });
  if (!chrome) await page.addStyleTag({ content: '.chrome, .dock, .hud, .goal-chip, .hint, .splash, .result, .flash, .boot { display: none !important; }' });
  await page.evaluate(async ({ at, margin, chrome, look }) => {
    const D = window.studioDemo;
    await D.go({ at, autoplay: false });
    const p = D.S.walk.pose(at);
    if (look) D.viewer.look([p[0], p[1], 0.5], look);   // from above, into a corridor
    else D.viewer.focus([[p[0], p[1]], D.S.staged.xy], { margin });
    if (chrome) D.render();
    D.viewer.dirty();
  }, { at, margin, chrome, look });
  await page.waitForTimeout(chrome ? 2000 : 1200);
  await page.screenshot({ path: file, type: file.endsWith('.png') ? 'png' : 'jpeg', quality: file.endsWith('.png') ? undefined : 82 });
  await page.context().close();
  console.log('wrote', file);
}

await demo({ walk: heroWalk, at: Number(heroAt), width: 1200, height: 900, file: path.join(assets, 'hero.jpg'), margin: 0.9 });
await demo({ walk: heroWalk, at: Number(heroAt), width: 1200, height: 630, file: path.join(assets, 'og.png'), margin: 0.9 });
if (docs) await demo({ walk: heroWalk, at: Number(heroAt), width: 1440, height: 900, file: path.join(docs, 'site-navigate.png'), chrome: true, margin: 1.2 });

// One still per findings example, at the moment the card is about (a little after it, for the ones that unfold).
const AFTER = { drift: 12, 'edge-ceiling': 2, phantom: 2, beam: 0.6, contact: 0, doorway: 0.2 };
const LOOK = { beam: { yaw: -2.0, pitch: 1.05, distance: 4.2 }, contact: { yaw: -2.0, pitch: 1.05, distance: 4.2 } };
for (const [id, ex] of Object.entries(featured.examples ?? {})) {
  const index = JSON.parse(await (await fetch(new URL(`data/${ex.world}/g/${ex.goal}.json`, URL_))).text());
  const end = index.time[index.time.length - 1];
  const at = Math.min(end, (ex.at ?? end / 2) + (AFTER[id] ?? 0));
  await demo({ walk: `${ex.world}/${ex.goal}`, at, width: 800, height: 450, file: path.join(media, 'stills', `${id}.jpg`), margin: 0.5, look: LOOK[id] ?? null });
}

// The split view's poster: the first plan-body scenario on the main page, paused mid-clip.
{
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 940 }, deviceScaleFactor: 1 })).newPage();
  await page.goto(`${URL_}#closer`);
  await page.waitForSelector('[data-closer-start]');
  await page.click('[data-closer-start]');
  await page.waitForSelector('#closer-stage.ready', { timeout: 60000 });
  await page.addStyleTag({ content: '#closer-stage .dock, #closer-stage .split-facts { display: none !important; }' });
  await page.evaluate(() => { const c = window.studioCloser; c.pause(); c.seek(c.S.clip[0] + 1.4); });
  await page.waitForTimeout(1500);
  await page.locator('#closer-stage').screenshot({ path: path.join(assets, 'closer.jpg'), type: 'jpeg', quality: 82 });
  await page.context().close();
  console.log('wrote', path.join(assets, 'closer.jpg'));
}
await browser.close();
