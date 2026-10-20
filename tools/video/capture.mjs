// Deterministic frame capture for the Studio introduction video.
//
//   node tools/video/capture.mjs --out <dir> [--app http://127.0.0.1:8790] [--demo http://127.0.0.1:8797] [--only a,b]
//
// Reads tools/video/storyboard.json and <dir>/narration.json (tools/video/narrate.py). Each segment is
// rendered frame by frame, never in real time, so software WebGL speed does not matter:
//   deck  — tools/video/deck.html at 30 fps (slides are pure functions of a virtual time t);
//   app   — the real Studio UI, driven through window.__studio and real clicks, captured at 15 fps.
// Frames stream as JPEG into one ffmpeg per segment (<dir>/segments/<id>.mp4, 30 fps, no audio).
// The app shots only read data, except `arena` and `rehearse`, which use the --demo gateway (its own
// data root) to save an arena and run one owned CPU rehearsal. Nothing here touches hardware.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { readFile, mkdir, access } from 'node:fs/promises';
import path from 'node:path';
import { SHOTS } from './shots.mjs';

const arg = (name, fallback) => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : fallback; };
const OUT = path.resolve(arg('out', 'video-out'));
const APP = arg('app', 'http://127.0.0.1:8790');
const DEMO = arg('demo', 'http://127.0.0.1:8797');
const ONLY = arg('only', null)?.split(',') ?? null;
const FFMPEG = arg('ffmpeg', 'ffmpeg');
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '../..');
const board = JSON.parse(await readFile(path.join(ROOT, 'tools/video/storyboard.json'), 'utf8'));
const narration = JSON.parse(await readFile(path.join(OUT, 'narration.json'), 'utf8'));
const spoken = Object.fromEntries(narration.segments.map(s => [s.id, s.duration_s]));
await mkdir(path.join(OUT, 'segments'), { recursive: true });

const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
  args: ['--force-color-profile=srgb', '--hide-scrollbars'] });
const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1, bypassCSP: true });

function encoder(file, inputFps) {
  const ff = spawn(FFMPEG, ['-y', '-loglevel', 'error', '-f', 'image2pipe', '-framerate', String(inputFps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-tune', 'animation', '-movflags', '+faststart', file],
  { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((resolve, reject) => ff.on('close', code => code === 0 ? resolve() : reject(new Error(`ffmpeg ${code} for ${file}`))));
  let frames = 0;
  return {
    get frames() { return frames; },
    write: async (buf, copies = 1) => { for (let i = 0; i < copies; i++) { frames++; if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); } },
    close: async () => { ff.stdin.end(); await done; },
  };
}
const shotJpeg = page => page.screenshot({ type: 'jpeg', quality: 92 });

// ------------------------------------------------------------------ deck segments
async function captureDeck(seg, seconds) {
  const page = await context.newPage();
  await page.goto('file://' + path.join(ROOT, 'tools/video/deck.html'));
  await page.evaluate(() => document.fonts.ready);
  await page.evaluate(id => window.show(id), seg.slide);
  const enc = encoder(path.join(OUT, 'segments', `${seg.id}.mp4`), 30);
  const n = Math.round(seconds * 30);
  let last = null;
  for (let i = 0; i < n; i++) {
    await page.evaluate(t => window.setT(t), i / 30);
    // After every element has settled the frame is identical; reuse it except for travelling pulses.
    const settled = i / 30 > 8 && !(await page.evaluate(() => document.querySelector('section.on circle[data-path]')));
    if (settled && last) { await enc.write(last); continue; }
    last = await shotJpeg(page);
    await enc.write(last);
  }
  await enc.close();
  await page.close();
  return n;
}

// ------------------------------------------------------------------ app segments
const OVERLAY_CSS = `
  #vid-caption { position: fixed; left: 50%; bottom: 34px; transform: translateX(-50%); z-index: 99999; max-width: 1180px;
    background: rgba(9, 13, 19, .9); border: 1px solid #2f6260; border-radius: 14px; padding: 14px 24px 15px; box-shadow: 0 12px 40px #000a;
    font-family: Inter, 'DejaVu Sans', sans-serif; color: #e6ebf0; transition: none; }
  #vid-caption .k { font: 600 14px 'JetBrains Mono', 'DejaVu Sans Mono', monospace; letter-spacing: .16em; color: #56d9d0; text-transform: uppercase; }
  #vid-caption .t { font-size: 25px; font-weight: 650; margin-top: 5px; letter-spacing: -.01em; }
  .vid-spot { position: fixed; z-index: 99998; border: 3px solid #56d9d0; border-radius: 12px; box-shadow: 0 0 0 4000px rgba(5, 8, 12, .38), 0 0 26px #56d9d0aa; pointer-events: none; }
  .vid-spot.nodim { box-shadow: 0 0 26px #56d9d0aa; }
  .vid-spot b { position: absolute; left: -3px; top: -36px; white-space: nowrap; background: #56d9d0; color: #071214; font: 700 15px Inter, 'DejaVu Sans', sans-serif; padding: 5px 10px; border-radius: 7px; }
  .vid-spot.below b { top: auto; bottom: -36px; }
  #vid-cursor { position: fixed; z-index: 100000; width: 30px; height: 30px; pointer-events: none; left: 0; top: 0; }
  #vid-ripple { position: fixed; z-index: 99999; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%; border: 3px solid #56d9d0; pointer-events: none; opacity: 0; }`;
const CURSOR_SVG = `<svg viewBox="0 0 24 24" width="30" height="30"><path d="M3 2 L3 19 L8 14.5 L11.5 22 L14.5 20.6 L11 13.2 L17.5 13.2 Z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg>`;

function helpers(page, enc, fps) {
  const state = { cursor: [1500, 700] };
  const ensureOverlay = () => page.evaluate(([css, svg]) => {
    if (document.getElementById('vid-style')) return;
    const s = Object.assign(document.createElement('style'), { id: 'vid-style', textContent: css }); document.head.append(s);
    const c = Object.assign(document.createElement('div'), { id: 'vid-cursor', innerHTML: svg }); document.body.append(c);
    const r = Object.assign(document.createElement('div'), { id: 'vid-ripple' }); document.body.append(r);
    // Studio fonts are system fonts; the deck loads Inter, so use it here too for a consistent look.
    const l = Object.assign(document.createElement('link'), { rel: 'stylesheet', href: 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;600&display=block' }); document.head.append(l);
  }, [OVERLAY_CSS, CURSOR_SVG]);
  const drawCount = () => page.evaluate(() => window.__studio?.sceneDrawCount ?? 0);
  const waitDraw = async c0 => { await page.waitForFunction(c => (window.__studio?.sceneDrawCount ?? 0) > c, c0, { polling: 'raf', timeout: 3000 }).catch(() => {}); };
  const frame = async (copies = 1) => enc.write(await shotJpeg(page), copies);
  const setCursor = ([x, y]) => page.evaluate(([x, y]) => { const c = document.getElementById('vid-cursor'); c.style.transform = `translate(${x - 3}px, ${y - 2}px)`; }, [x, y]);
  const center = async sel => { const b = await page.locator(sel).first().boundingBox(); if (!b) throw new Error(`no element ${sel}`); return [b.x + b.width / 2, b.y + b.height / 2]; };
  const h = {
    page, fps,
    async ready() { await ensureOverlay(); await page.evaluate(() => document.fonts.ready); await setCursor(state.cursor); },
    frame,
    async hold(seconds) { await frame(Math.max(1, Math.round(seconds * fps))); },
    async caption(kicker, text, { pos = 'bottom' } = {}) {
      await page.evaluate(([k, t, pos]) => { let el = document.getElementById('vid-caption'); if (!el) { el = document.createElement('div'); el.id = 'vid-caption'; document.body.append(el); }
        el.innerHTML = `<div class="k">${k}</div><div class="t">${t}</div>`; el.style.display = k || t ? '' : 'none';
        Object.assign(el.style, pos === 'top' ? { top: '96px', bottom: 'auto' } : { top: 'auto', bottom: '34px' }); }, [kicker, text, pos]);
    },
    async spot(sel, label = '', { pad = 6, dim = true, below = false } = {}) {
      const b = await page.locator(sel).first().boundingBox(); if (!b) return;
      await page.evaluate(([b, label, pad, dim, below]) => { const el = document.createElement('div'); el.className = `vid-spot ${dim ? '' : 'nodim'} ${below ? 'below' : ''}`;
        Object.assign(el.style, { left: `${b.x - pad}px`, top: `${b.y - pad}px`, width: `${b.width + 2 * pad}px`, height: `${b.height + 2 * pad}px` });
        if (label) el.innerHTML = `<b>${label}</b>`; document.body.append(el); }, [b, label, pad, dim, below]);
    },
    async spotRect(rect, label = '', opts = {}) {
      await page.evaluate(([r, label, dim]) => { const el = document.createElement('div'); el.className = `vid-spot ${dim ? '' : 'nodim'}`;
        Object.assign(el.style, { left: `${r[0]}px`, top: `${r[1]}px`, width: `${r[2]}px`, height: `${r[3]}px` }); if (label) el.innerHTML = `<b>${label}</b>`; document.body.append(el); },
      [rect, label, opts.dim ?? true]);
    },
    async clearSpots() { await page.evaluate(() => document.querySelectorAll('.vid-spot').forEach(e => e.remove())); },
    async moveTo(target, seconds = 0.6) {
      const to = typeof target === 'string' ? await center(target) : target, from = state.cursor, n = Math.max(1, Math.round(seconds * fps));
      for (let i = 1; i <= n; i++) { const p = i / n, e = p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; await setCursor([from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e]); await frame(); }
      state.cursor = to;
    },
    async click(target, { move = 0.6, after = 0.5, real = true } = {}) {
      await h.moveTo(target, move);
      const [x, y] = state.cursor;
      for (let i = 0; i < 4; i++) { await page.evaluate(([x, y, i]) => { const r = document.getElementById('vid-ripple'); Object.assign(r.style, { left: `${x}px`, top: `${y}px`, opacity: String(1 - i / 4), transform: `scale(${0.6 + i * 0.25})` }); }, [x, y, i]); await frame(); }
      await page.evaluate(() => { document.getElementById('vid-ripple').style.opacity = '0'; });
      if (real) { if (typeof target === 'string') await page.click(target); else await page.mouse.click(x, y); }
      await page.waitForTimeout(250);
      await h.settle();
      if (after) await h.hold(after);
    },
    // Wait until the 3D view has drawn after a UI change (render-on-demand) and the DOM settled.
    async settle(ms = 400) { const c0 = await drawCount(); await page.waitForTimeout(ms); await waitDraw(c0 - 1); },
    async seek(t) { const c0 = await drawCount(); await page.evaluate(t => window.__studio.seek(t), t); await waitDraw(c0); },
    async play(t0, t1, seconds) {
      const n = Math.max(1, Math.round(seconds * fps));
      for (let i = 0; i < n; i++) { await h.seek(t0 + (t1 - t0) * i / Math.max(1, n - 1)); await frame(); }
    },
    async orbit(degrees, seconds, { t = null } = {}) {
      const n = Math.max(1, Math.round(seconds * fps));
      for (let i = 0; i < n; i++) {
        const c0 = await drawCount();
        await page.evaluate(([deg, tt]) => import('/js/scene.js').then(({ view, markDirty }) => {
          const c = view.camera, o = view.controls.target, dx = c.position.x - o.x, dy = c.position.y - o.y, a = deg * Math.PI / 180;
          c.position.x = o.x + dx * Math.cos(a) - dy * Math.sin(a); c.position.y = o.y + dx * Math.sin(a) + dy * Math.cos(a);
          c.lookAt(o); view.controls.update(); markDirty(); if (tt !== null) window.__studio.seek(tt);
        }), [degrees / n, t === null ? null : t[0] + (t[1] - t[0]) * i / Math.max(1, n - 1)]);
        await waitDraw(c0); await frame();
      }
    },
    async waitFor(fn, arg, timeout = 120000) { await page.waitForFunction(fn, arg, { timeout, polling: 250 }); },
  };
  return h;
}

async function captureApp(seg, seconds) {
  const shot = SHOTS[seg.shot];
  if (!shot) throw new Error(`unknown shot ${seg.shot}`);
  const page = await context.newPage();
  page.on('pageerror', e => console.error(`[${seg.id}] page error`, e.message));
  const fps = 15, enc = encoder(path.join(OUT, 'segments', `${seg.id}.mp4`), fps);
  const h = helpers(page, enc, fps);
  await shot({ page, h, APP, DEMO, seconds, seg });
  // Pad to the narration length with the last frame (a shot may also run a little long).
  const need = Math.round(seconds * fps) - enc.frames;
  if (need > 0) await h.frame(need);
  await enc.close();
  await page.close();
  return enc.frames;
}

const manifest = [];
for (const seg of board.segments) {
  const seconds = Math.max(seg.min_s ?? 3, (spoken[seg.id] ?? 0) + (spoken[seg.id] ? board.pad_s ?? 0.7 : 0));
  if (ONLY && !ONLY.includes(seg.id)) {
    try { await access(path.join(OUT, 'segments', `${seg.id}.mp4`)); } catch { console.warn(`(missing segment ${seg.id})`); }
    manifest.push({ id: seg.id, seconds, skipped: true }); continue;
  }
  const t0 = Date.now();
  const frames = seg.kind === 'deck' ? await captureDeck(seg, seconds) : await captureApp(seg, seconds);
  manifest.push({ id: seg.id, seconds, frames });
  console.log(`${seg.id}: ${seconds.toFixed(1)} s, ${frames} frames, ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
}
await browser.close();
console.log(JSON.stringify({ segments: manifest.length, total_s: manifest.reduce((a, m) => a + m.seconds, 0) }));
