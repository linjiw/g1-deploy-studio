#!/usr/bin/env node
// Capture the selected public walks at recorded speed, using the same Film camera as the interactive demo.
// SITE_URL=http://127.0.0.1:8816/ node tools/site/highlights.mjs <media/showcase directory>
// Generated media stays outside Git. No planner, simulator or hardware is started.
import { chromium } from '@playwright/test';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import path from 'node:path';
import { selectShowcase } from '../../site/js/showcase.js';

const output = process.argv[2];
if (!output) throw new Error('Provide the media/showcase output directory');
const base = process.env.SITE_URL || 'http://127.0.0.1:8816/';
const catalog = await (await fetch(new URL('data/worlds.json', base))).json();
const cases = selectShowcase(catalog);
if (cases.length !== 3) throw new Error('Expected three eligible showcase walks');
await mkdir(output, { recursive: true });
if (process.env.FILM_REVIEW) await mkdir(process.env.FILM_REVIEW, { recursive: true });
const fps = 25, width = 1280, height = 720;
const ff = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
  '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-movflags', '+faststart', path.join(output, 'highlights.mp4')],
{ stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = once(ff, 'close').then(([code]) => { if (code !== 0) throw new Error(`ffmpeg exited ${code}`); });
// Observe encoder errors immediately, then propagate them when finishing.
encoded.catch(() => {});
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'] })
  .catch(error => { ff.kill(); throw error; });
const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
let frameCount = 0;
const manifest = [];
const stamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
try {
  for (const [i, row] of cases.entries()) {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL(`demo/#${row.world}/${row.id}/film`, base).href);
    await page.waitForFunction(() => window.studioDemo?.S.walk && window.studioDemo.cameraMode === 'film', null, { timeout: 60000 });
    const duration = await page.evaluate(() => { window.studioDemo.pause(); return window.studioDemo.S.walk.duration; });
    await page.addStyleTag({ content: `
      .chrome,.dock,.hud,.goal-chip,.hint,.splash,.result,.flash,.boot,.film-status,.ghost-tip { display:none!important }
      .capture-caption { position:fixed;z-index:100;left:36px;top:30px;font-family:Inter,system-ui,sans-serif;color:#192d38;
        padding:18px 22px;background:rgba(255,255,255,.92);border:1px solid #dce5e9;border-radius:16px; }
      .capture-caption p { margin:0 0 7px;font-size:12px;font-weight:600;letter-spacing:.13em;text-transform:uppercase;color:#526a76 }
      .capture-caption h1 { margin:0;font-size:28px;letter-spacing:-.04em }
      .capture-caption small { display:block;margin-top:8px;font-size:13px;color:#506670 }
      .capture-footer { position:fixed;bottom:24px;left:36px;right:36px;display:flex;justify-content:space-between;z-index:100;
        font:12px Inter,system-ui,sans-serif;color:#526570;background:rgba(255,255,255,.9);padding:10px 14px;border-radius:8px }
    ` });
    await page.evaluate(({ row, i }) => {
      const caption = document.createElement('div'); caption.className = 'capture-caption';
      for (const [tag, text] of [['p', `${String(i + 1).padStart(2, '0')} / 03 · Recorded simulation`], ['h1', row.title],
        ['small', `${row.dist_m.toFixed(2)} m goal · ${row.final_m.toFixed(2)} m final error (truth) · ${row.contact_n} N obstacle contact`]]) {
        const el = document.createElement(tag); el.textContent = text; caption.append(el);
      }
      document.body.append(caption);
      const footer = document.createElement('div'); footer.className = 'capture-footer';
      const identity = document.createElement('span'); identity.textContent = 'G1 Deploy Studio · October 8 frozen planner + SONIC · MuJoCo';
      const clock = document.createElement('span'); clock.id = 'capture-clock'; footer.append(identity, clock); document.body.append(footer);
    }, { row, i });
    await page.evaluate(() => document.fonts.ready);
    const start = frameCount / fps, n = Math.ceil(duration * fps) + 1;
    for (let j = 0; j < n + 18; j++) {
      const time = Math.min(duration, j / fps);
      await page.evaluate(t => {
        const demo = window.studioDemo; demo.pause(); demo.seek(t); demo.viewer.render();
        document.getElementById('capture-clock').textContent = `${t.toFixed(2)} s · recorded speed`;
      }, time);
      const frame = await page.screenshot({ type: 'jpeg', quality: 90 });
      if (!ff.stdin.write(frame)) await once(ff.stdin, 'drain');
      frameCount++;
      if (process.env.FILM_REVIEW && j === Math.floor(n / 2)) await writeFile(path.join(process.env.FILM_REVIEW, `${row.world}-film-review.jpg`), frame);
    }
    if (errors.length) throw new Error(errors.join('\n'));
    manifest.push({ world: row.world, goal: row.id, title: row.title, clip_start_s: start, clip_end_s: frameCount / fps,
      recording_duration_s: duration, final_error_truth_m: row.final_m, obstacle_contact_n: row.contact_n });
    console.log(`Captured ${row.world}/${row.id}: ${duration.toFixed(2)} s at recorded speed`);
    await page.close();
  }
  ff.stdin.end(); await encoded;
  await writeFile(path.join(output, 'highlights.vtt'), 'WEBVTT\n\n' + manifest.map((s, i) =>
    `${i + 1}\n${stamp(s.clip_start_s)} --> ${stamp(s.clip_end_s)}\n${s.title}: ${s.final_error_truth_m.toFixed(2)} m final error; zero obstacle contact.\nMuJoCo recording · gray: executed body; pink: planned reference.\n`).join('\n'));
  await writeFile(path.join(output, 'highlights.json'), JSON.stringify({ source: 'public Navigate recordings',
    planner: 'student-s2-kcsc', bundle_date: '2026-10-08', simulation: 'MuJoCo', fps, width, height, duration_s: frameCount / fps,
    camera: 'Film: deterministic recorded-time framing; robot poses unchanged', clips: manifest }, null, 2) + '\n');
  console.log(`Wrote ${path.join(output, 'highlights.mp4')} (${(frameCount / fps).toFixed(2)} s)`);
} finally {
  await browser.close();
  if (ff.exitCode === null) ff.kill();
}
