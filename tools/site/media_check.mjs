#!/usr/bin/env node
// Decode, play and seek the shipped films in a real browser. Read-only; suitable for local builds or Pages.
// SITE_URL=https://linjiw.github.io/g1-deploy-studio/ SITE_EVIDENCE=<dir> node tools/site/media_check.mjs
import { chromium } from '@playwright/test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
const base = process.env.SITE_URL || 'http://127.0.0.1:8816/';
const out = process.env.SITE_EVIDENCE || '/tmp/g1-site-media';
await mkdir(out, { recursive: true });
const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true, args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
const errors = [], results = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.goto(base);
  for (const [id, folder, minimum] of [['showcase-film', 'showcase', 22], ['research-video', 'research', 16]]) {
    const video = page.locator(`#${id}`);
    await video.scrollIntoViewIfNeeded();
    assert.equal(await video.getAttribute('preload'), 'none');
    assert.equal(await video.getAttribute('autoplay'), null);
    assert.ok(await video.evaluate(v => v.controls && v.playsInline));
    const poster = await video.getAttribute('poster');
    assert.ok((await page.request.get(new URL(poster, base).href)).ok(), `${id} poster missing`);
    const captions = await page.request.get(new URL(`media/${folder}/highlights.vtt`, base).href);
    assert.ok(captions.ok()); assert.match(await captions.text(), /^WEBVTT/);
    await video.evaluate(async v => { v.muted = true; await v.play(); });
    await page.waitForFunction(id => { const v = document.getElementById(id); return v.currentTime > .2 && v.readyState >= 2; }, id, { timeout: 60000 });
    const media = await video.evaluate(v => { v.pause(); return { duration: v.duration, width: v.videoWidth, height: v.videoHeight, error: v.error?.message ?? null }; });
    assert.ok(media.duration >= minimum && media.duration < 40, JSON.stringify(media));
    assert.ok(media.width >= 960 && media.height >= 540 && media.error === null, JSON.stringify(media));
    await video.evaluate(v => { v.currentTime = v.duration * .7; });
    await page.waitForFunction(id => { const v = document.getElementById(id); return !v.seeking && v.readyState >= 2; }, id);
    await video.screenshot({ path: path.join(out, `${id}.png`) });
    results.push({ id, ...media, play_and_seek: true, captions: true });
    console.log(`PASS ${id}: decode, playback, seek, poster and captions`);
  }
  const metadata = await page.request.get(new URL('media/research/metadata.json', base).href);
  assert.ok(metadata.ok());
  const text = await metadata.text(); JSON.parse(text);
  assert.ok(!/\/home\/|\/Users\/|input_snapshot/.test(text), 'Research provenance exposed a local source path');
  assert.match(await page.locator('#research-film').innerText(), /Isaac.*SONIC/is);
  assert.match(await page.locator('#research-film').innerText(), /not an aggregate comparison/);
  assert.deepEqual(errors, []);
  console.log('PASS research provenance and separate setup labels');
  await writeFile(path.join(out, 'media.json'), JSON.stringify({ base, results, provenance: true, page_errors: errors }, null, 2));
} finally { await browser.close(); }
