#!/usr/bin/env node
// Render only the two audited development examples from export_research_showcase.py.
// SITE_URL=http://127.0.0.1:8816/ node tools/site/research_film.mjs <render.json> <media/research directory>
// REVIEW_ONLY=1 writes stills without encoding. Source exports and review stills stay outside Git.
import assert from 'node:assert/strict';
import { chromium } from '@playwright/test';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import path from 'node:path';

const [input, output] = process.argv.slice(2);
if (!input || !output) throw new Error('Provide the sanitized render.json and media/research output directory');
const base = process.env.SITE_URL || 'http://127.0.0.1:8816/';
const reviewOnly = process.env.REVIEW_ONLY === '1';
const review = process.env.FILM_REVIEW || path.join(path.dirname(input), 'film-review');
const sha = data => createHash('sha256').update(data).digest('hex');
const sourceBytes = await readFile(input), source = JSON.parse(sourceBytes);
const robotResponse = await fetch(new URL('data/robot.json', base));
assert(robotResponse.ok, 'Public rendering avatar must load');
const robotBytes = Buffer.from(await robotResponse.arrayBuffer()), robot = JSON.parse(robotBytes);
assert.equal(source.schema_version, 1);
assert.equal(source.quaternion_convention, 'wxyz');
assert.deepEqual(source.units, { position: 'm', joint: 'rad', time: 's' });
assert.deepEqual(source.clips.map(c => c.id), ['duck', 'clutter']);
for (const c of source.clips) {
  assert.equal(c.provenance.split, 'arena-xdgc-dev_extrap');
  assert.equal(c.provenance.recording_source_commit, null);
  assert.equal(c.provenance.rendering_avatar.sha256, sha(robotBytes));
  assert.deepEqual(c.joint_names, robot.joint_names);
  assert.equal(c.provenance.joint_mapping.length, 29);
  c.provenance.joint_mapping.forEach((m, i) => {
    assert.equal(m.name, robot.joint_names[i]); assert.equal(m.avatar_qpos_index, i + 7);
  });
  assert.equal(c.times.length, c.qpos.length); assert.equal(c.times.length, c.reference_qpos.length);
  assert.equal(c.times[0], 0); assert.equal(c.times.at(-1), c.result.elapsed_s);
  assert.equal(c.reference_qpos.at(-1), null, 'Final post-action state has no recorded command');
  for (let i = 0; i < c.times.length; i++) {
    assert(Number.isFinite(c.times[i]) && (i === 0 || c.times[i] > c.times[i - 1]));
    for (const q of [c.qpos[i], c.reference_qpos[i]]) if (q !== null) {
      assert.equal(q.length, 36); assert(q.every(Number.isFinite));
      assert(Math.abs(Math.hypot(...q.slice(3, 7)) - 1) < 0.002, 'Expected unit wxyz quaternion');
    }
  }
  const q = c.qpos.at(-1);
  assert(Math.abs(Math.hypot(q[0] - c.goal_xy[0], q[1] - c.goal_xy[1]) - c.result.final_goal_distance_xy_m) < 1e-12);
  assert(c.world.boxes.every(b => b.velocity_xy.every(v => v === 0)), 'This bounded capture expects static recorded geometry');
}
await mkdir(output, { recursive: true }); await mkdir(review, { recursive: true });
const fps = 25, width = 1280, height = 720, holdFrames = 18;
const movie = path.join(output, 'highlights.mp4');
const ff = reviewOnly ? null : spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(fps),
  '-c:v', 'mjpeg', '-i', '-', '-vf', 'format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
  '-movflags', '+faststart', movie], { stdio: ['pipe', 'inherit', 'inherit'] });
const encoded = ff && once(ff, 'close').then(([code]) => { assert.equal(code, 0, 'ffmpeg must complete'); });
encoded?.catch(() => {});
let browser;
const pageURL = new URL('__research_capture__', base).href;
const html = `<!doctype html><html lang="en"><meta charset="utf-8"><title>Recorded Isaac development simulation</title>
<link rel="stylesheet" href="${new URL('css/base.css', base)}"><link rel="stylesheet" href="${new URL('css/stage.css', base)}">
<script type="importmap">${JSON.stringify({ imports: { three: new URL('vendor/three/three.module.min.js', base).href, 'three/addons/': new URL('vendor/three/addons/', base).href } })}</script>
<style>body{margin:0}.stage{position:fixed;inset:0}.caption{position:fixed;z-index:2;left:32px;top:25px;padding:15px 19px;background:#fffffff0;border:1px solid #dce5e9;border-radius:14px;color:#192d38;font-family:Inter,system-ui,sans-serif;max-width:570px}
.caption p{margin:0 0 6px;font-size:11px;font-weight:650;letter-spacing:.1em;text-transform:uppercase;color:#526a76}.caption h1{margin:0;font-size:27px;letter-spacing:-.035em}.caption small{display:block;margin-top:7px;font-size:12px;color:#506670}
.footer{position:fixed;bottom:21px;left:32px;right:32px;z-index:2;font:12px/1.55 Inter,system-ui,sans-serif;color:#526570;background:#fffffff0;padding:10px 14px;border-radius:9px;display:flex;justify-content:space-between;align-items:center}.footer b{font-weight:600}.clock{font-variant-numeric:tabular-nums;text-align:right}.gray{color:#293540}.pink{color:#b73378}</style>
<div class="stage"><div class="stage-canvas" id="canvas"></div></div><div class="caption"><p id="eyebrow"></p><h1 id="title"></h1><small id="metrics"></small></div>
<div class="footer"><div><b class="gray">Gray: simulator truth</b> · <b class="pink">Pink: commanded reference</b><br>Privileged exact scene · no LiDAR · G1 display avatar</div><div class="clock"><b id="clock"></b><br>Two selected successes · not a benchmark</div></div>
<script type="module">import {Viewer} from '${new URL('js/viewer.js', base)}'; window.ready=(async()=>{window.viewer=new Viewer(document.getElementById('canvas'));await viewer.loadRobot('${new URL('data/', base)}');await document.fonts.ready;})();</script></html>`;
let frameCount = 0;
const manifest = [], verification = [];
try {
  browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: 'no-preference' });
  for (const [caseIndex, clip] of source.clips.entries()) {
    const page = await context.newPage(), errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route(pageURL, route => route.fulfill({ contentType: 'text/html', body: html }));
    await page.goto(pageURL); await page.evaluate(() => window.ready);
    await page.evaluate(({ c, caseIndex }) => {
      const v = window.viewer;
      v.setWorld(c.world); v.setBoxesStyle('ghost'); v.setMarker('goal', c.goal_xy, { radius: 0.4 });
      // Emphasize the recorded overhead constraints without changing their geometry or the ghost walls.
      c.world.boxes.forEach((box, i) => {
        if (box.z_bottom <= 0.4) return;
        const mesh = v.boxes.children[i];
        mesh.material.color.set(0xa68acb); mesh.material.opacity = 0.4;
        mesh.children.forEach(edge => { if (edge.isLineSegments) edge.material.opacity = 0.9; });
      });
      const trail = v.line(0x506d7e, 2, { opacity: 0.65 }); v.groups.trail.add(trail);
      v.setLine(trail, c.qpos.map(q => [q[0], q[1], 0.018]));
      const walk = { times: c.times, frames: Float64Array.from(c.qpos.flat()), n: c.times.length,
        duration: c.times.at(-1), goal: c.goal_xy, index(t) {
          let lo = 0, hi = this.n - 1;
          while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.times[mid] <= t + 1e-10) lo = mid; else hi = mid - 1; }
          return lo;
        } };
      document.getElementById('eyebrow').textContent = `${caseIndex + 1} / 2 · Recorded Isaac development simulation`;
      document.getElementById('title').textContent = `R2 RF · ${c.label}`;
      document.getElementById('metrics').textContent = `Final goal error ${c.result.final_goal_distance_xy_m.toFixed(2)} m · Max obstacle contact ${c.result.maximum_obstacle_contact_n} N · Simulator truth`;
      window.drawRecorded = time => {
        const k = walk.index(time), q = c.qpos[k];
        v.setPose(q); v.setGhost('commanded-reference', c.reference_qpos[k]);
        v.setLineCount(trail, k + 1); trail.visible = k > 0;
        v.filmFrame(walk, c.world, time); v.stop(); v.render();
        document.getElementById('clock').textContent = `${time.toFixed(2)} s / ${walk.duration.toFixed(2)} s · recorded speed`;
        return { index: k, time: c.times[k], root: v.robot.root.position.toArray(), expectedRoot: q.slice(0, 3),
          ghostVisible: v.ghosts['commanded-reference'].root.visible,
          sensorObjects: v.groups.lidar.children.length + v.groups.map.children.length + v.groups.voxels.children.length,
          screenRoot: v.project(q[0], q[1], q[2]) };
      };
    }, { c: clip, caseIndex });
    const duration = clip.times.at(-1), n = Math.ceil(duration * fps) + 1, start = frameCount / fps;
    const reviewFrames = new Set([0, Math.round(1.5 * fps), Math.round(duration * fps / 2), 109, n - 1]);
    const sequence = reviewOnly ? [...reviewFrames] : Array.from({ length: n + holdFrames }, (_, j) => j);
    for (const j of sequence) {
      const time = Math.min(duration, j / fps);
      const receipt = await page.evaluate(t => window.drawRecorded(t), time);
      assert.deepEqual(receipt.root, receipt.expectedRoot, 'Camera must not change recorded root');
      assert.equal(receipt.sensorObjects, 0, 'No invented sensor data');
      assert.equal(receipt.ghostVisible, time < duration, 'Only recorded commands are displayed');
      assert(receipt.screenRoot?.every(Number.isFinite), 'Robot must remain inside camera depth');
      assert(receipt.screenRoot[0] > 40 && receipt.screenRoot[0] < width - 40 && receipt.screenRoot[1] > 140 && receipt.screenRoot[1] < height - 90, 'Robot framing avoids caption/footer');
      const frame = await page.screenshot({ type: 'jpeg', quality: 90 });
      if (reviewFrames.has(j)) {
        await writeFile(path.join(review, `${clip.id}-${j}.jpg`), frame);
        verification.push({ clip: clip.id, video_frame: frameCount, requested_time: time, ...receipt });
      }
      if (ff && !ff.stdin.write(frame)) await once(ff.stdin, 'drain');
      frameCount++;
    }
    assert.deepEqual(errors, []);
    manifest.push({ id: clip.id, title: clip.label, clip_start_s: start, clip_end_s: frameCount / fps,
      recording_duration_s: duration, result: clip.result, recipe: clip.recipe, provenance: clip.provenance,
      pose_basis: clip.pose_basis, reference_basis: clip.reference_basis, limitations: clip.limitations });
    console.log(`${reviewOnly ? 'Reviewed' : 'Captured'} ${clip.id}: ${duration.toFixed(2)} s, ${n} recorded-time frames + ${holdFrames} final hold frames`);
    await page.close();
  }
  await writeFile(path.join(review, 'verification.json'), JSON.stringify(verification, null, 2) + '\n');
  if (ff) {
    ff.stdin.end(); await encoded;
    const posterFrame = 109; // 4.36 s: the duck recording's lowest measured root height.
    execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-i', movie, '-vf', `select=eq(n\\,${posterFrame})`, '-frames:v', '1', '-q:v', '2', path.join(output, 'poster.jpg')]);
    const stamp = seconds => new Date(Math.round(seconds * 1000)).toISOString().slice(11, 23);
    const captions = 'WEBVTT\n\n' + manifest.map((c, i) => `${i + 1}\n${stamp(c.clip_start_s)} --> ${stamp(c.clip_end_s)}\nRecorded Isaac · ${c.title}\nGray: truth. Pink: commanded reference.\n`).join('\n');
    await writeFile(path.join(output, 'highlights.vtt'), captions);
    const metadata = { schema_version: 1, title: 'R2 RF recorded development examples', simulation: 'Isaac',
      selection: 'Two explicitly selected successful dev_extrap recordings; not an aggregate benchmark or hardware test',
      fps, width, height, duration_s: frameCount / fps, input_sha256: sha(sourceBytes), avatar_sha256: sha(robotBytes),
      capture: { camera: 'Public Film camera, deterministic recorded-time framing; robot poses unmodified',
        pose_sampling: 'Causal original 50 Hz samples displayed at 25 fps, including final post-action state; no interpolated robot poses',
        final_hold_frames_per_clip: holdFrames, poster_frame: posterFrame, poster_time_s: posterFrame / fps,
        poster_basis: 'Decoded from this exact MP4', sensors: 'No LiDAR or estimated-pose channels recorded or displayed',
        geometry: 'Recorded simulator boxes unchanged; walls at 0.14 opacity, overhead constraints at 0.4; public named-joint-mapped G1 display avatar' }, clips: manifest };
    const text = JSON.stringify(metadata, null, 2) + '\n';
    assert(!/(?:\/home\/|\/mnt\/|\/tmp\/)/.test(text), 'Public receipt must not contain machine paths');
    await writeFile(path.join(output, 'metadata.json'), text);
    console.log(`Wrote ${movie}: ${frameCount} frames, ${(frameCount / fps).toFixed(2)} s`);
  }
} finally {
  await browser?.close();
  if (ff && ff.exitCode === null) ff.kill();
}
