// Shared harness for the independent validation scripts (tools/browser/validation/*.mjs).
// Soft checks: every item records PASS / FAIL / BLOCKED with evidence and keeps going.
// Page errors, console errors, failed requests and HTTP >= 400 are collected globally and
// attributed to the check that was running when they happened.
import { chromium } from '@playwright/test';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const BASE = process.env.STUDIO_URL || 'http://127.0.0.1:8792';
export const EVIDENCE = process.env.STUDIO_EVIDENCE || path.join(os.homedir(), 'research-data/g1-deploy-studio/evidence/validation-20261020');
export const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function launch({ viewport = { width: 1600, height: 1000 } } = {}) {
  await mkdir(EVIDENCE, { recursive: true });
  const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || '/opt/google/chrome/chrome', headless: true,
    args: ['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const context = await browser.newContext({ viewport, acceptDownloads: true });
  return { browser, context };
}

export function recorder(section) {
  const results = [], log = { errors: [], http: [], expected: [] };
  let current = null, page = null;
  const allow = [];
  function watch(p) {
    page = p;
    p.on('pageerror', e => log.errors.push({ check: current, kind: 'pageerror', text: e.message }));
    p.on('console', m => {
      if (m.type() !== 'error') return;
      const item = { check: current, kind: 'console', text: m.text(), url: m.location()?.url };
      // Chrome logs every HTTP error response as a console error; those are judged by the response handler.
      const http = m.text().match(/Failed to load resource: the server responded with a status of (\d+)/);
      if (http && allow.some(re => re.test(`${http[1]} ${item.url}`))) { log.expected.push(item); return; }
      if (http) return; // counted once, by the response listener
      if (/Failed to load resource: net::/.test(m.text())) { if (allow.some(re => re.test(`failed ${item.url}`))) { log.expected.push(item); return; } return; } // counted by requestfailed
      log.errors.push(item);
    });
    p.on('requestfailed', r => {
      const f = r.failure()?.errorText ?? '';
      // Aborted downloads/navigations are browser-side cancellations, not server failures.
      if (/ERR_ABORTED/.test(f)) return;
      const item = { check: current, status: 'failed', url: r.url(), text: f };
      if (allow.some(re => re.test(`failed ${r.url()}`))) log.expected.push(item); else log.http.push(item);
    });
    p.on('response', r => {
      if (r.status() < 400) return;
      const item = { check: current, status: r.status(), url: r.url() };
      if (allow.some(re => re.test(`${r.status()} ${r.url()}`))) log.expected.push(item); else log.http.push(item);
    });
  }
  async function shot(name, p = page) {
    const file = path.join(EVIDENCE, `${section}-${name}.png`);
    try { await p.screenshot({ path: file }); } catch { return null; }
    return file;
  }
  async function check(id, title, fn, { expectHttp = [] } = {}) {
    current = id; allow.length = 0; allow.push(...expectHttp);
    const e0 = log.errors.length, h0 = log.http.length, t0 = Date.now();
    let status = 'PASS', evidence = null, note = '';
    try {
      const out = await fn();
      evidence = out ?? null;
      if (out && out.__blocked) { status = 'BLOCKED'; note = out.reason; evidence = out.evidence ?? null; }
    } catch (error) {
      status = 'FAIL'; note = error.message.split('\n').slice(0, 6).join(' | ');
      evidence = { screenshot: await shot(`fail-${id}`) };
    }
    const errors = log.errors.slice(e0), http = log.http.slice(h0);
    if (status === 'PASS' && (errors.length || http.length)) { status = 'FAIL'; note = `Unexpected errors: ${JSON.stringify([...errors, ...http]).slice(0, 600)}`; }
    const row = { id, title, status, note, evidence, errors, http, ms: Date.now() - t0 };
    results.push(row);
    console.log(`${status === 'PASS' ? '✓' : status === 'BLOCKED' ? '∅' : '✕'} [${id}] ${title}${note ? ' — ' + note : ''}`);
    current = null;
    return row;
  }
  const blocked = (reason, evidence) => ({ __blocked: true, reason, evidence });
  async function save(extra = {}) {
    const file = path.join(EVIDENCE, `results-${section}.json`);
    await writeFile(file, JSON.stringify({ section, base: BASE, finished: new Date().toISOString(), results, log, ...extra }, null, 1));
    const n = s => results.filter(r => r.status === s).length;
    console.log(`${section}: PASS ${n('PASS')} FAIL ${n('FAIL')} BLOCKED ${n('BLOCKED')} → ${file}`);
  }
  const use = p => { page = p; };
  return { watch, use, check, blocked, shot, save, results, log };
}

export function assert(cond, message) { if (!cond) throw new Error(message); }
export function near(a, b, tol, message) { if (!(Math.abs(a - b) <= tol)) throw new Error(`${message}: ${a} vs ${b} (tol ${tol})`); }

// Wait for a session to be fully open (scene built, overlay hidden).
export async function ready(page, id, timeout = 120000) {
  await page.waitForFunction(id => window.__studio?.state?.session?.metadata?.catalog_id === id
    && (window.__studio.state.session.frames.some(f => Array.isArray(f.qpos)) ? !!window.__studio.robot : true)
    && document.querySelector('#loading-overlay').hidden && !window.__studio.state.loading, id, { timeout });
}
export async function open(page, id) {
  if (await page.evaluate(() => !!window.__studio?.state?.session).catch(() => false)) await page.selectOption('#session-picker', id);
  else await page.goto(`${BASE}/?session=${id}`);
  await ready(page, id);
  const banner = await page.locator('#error-banner').isVisible() ? await page.locator('#error-banner').textContent() : null;
  if (banner) throw new Error(`error banner on open: ${banner}`);
}
export const seek = (page, t) => page.evaluate(t => window.__studio.seek(t), t);
export const st = (page, fn, arg) => page.evaluate(fn, arg);

// Scene-module access: dynamic import of the same URL returns the page's module instance
// (the page CSP forbids eval, so callers pass a function that does the import itself).
export const sceneView = (page, fn, arg) => page.evaluate(fn, arg);
export const SCENE = '/js/scene.js';

export async function api(page, p) { const r = await page.request.get(`${BASE}${p}`); return { status: r.status(), body: await r.json().catch(() => null) }; }

export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
