// The main page. Nothing heavy loads until asked: the demo and the split view start from their posters (or a
// #try/... link), the diagram, robot day and findings are built as they near the viewport.
import { $, escape, fmt, reducedMotion } from './util.js';
import { json } from './data.js';
import { boot } from './stage.js';

const smooth = () => (reducedMotion() ? 'auto' : 'smooth');

// ----- the demo slot
let demoStart = null;
function startDemo({ scroll = true, focus = false } = {}) {
  if (scroll) $('demo-stage').scrollIntoView({ behavior: smooth(), block: 'start' });
  // Started from a button, the keyboard goes with the visitor into the stage (its arrow keys move a goal cursor).
  if (demoStart) { if (focus) demoStart.then(d => d?.el.canvas.focus({ preventScroll: true })); return demoStart; }
  const stage = $('demo-stage'), poster = stage.querySelector('.poster');
  poster.hidden = true;
  demoStart = boot(stage, { embedded: true, hashPrefix: 'try/', fullHref: 'demo/' }, undefined, {
    // Stop: back to the poster, nothing left running; a later Start (or #try link) boots it again.
    onStopped: () => {
      demoStart = null; window.studioDemo = null; poster.hidden = false;
      if (location.hash.startsWith('#try/')) history.replaceState(null, '', '#try');
      poster.querySelector('.start')?.focus({ preventScroll: true });
    },
  }).then(d => { window.studioDemo = d; if (focus) d?.el.canvas.focus({ preventScroll: true }); return d; });
  return demoStart;
}
for (const b of document.querySelectorAll('[data-start]')) b.addEventListener('click', () => startDemo({ focus: true }));
if (location.hash.startsWith('#try/')) startDemo({ scroll: false });
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#try/') && !demoStart) startDemo(); });
// #closer/<room>/<goal>: that walk in the split view (the demo's "Plan vs body").
const closerLink = () => {
  const m = location.hash.match(/^#closer\/([a-z]+)\/(g\d\d-\d\d)$/);
  if (!m) return;
  $('closer').scrollIntoView({ behavior: smooth(), block: 'start' });
  closer().then(s => s.showWalk(m[1], m[2]));
};
window.addEventListener('hashchange', closerLink);
// The outcome table's cells open the room menu on that room and grade.
document.addEventListener('site:pick', e => startDemo().then(d => d?.openPicker(e.detail.folder, e.detail.grade)));

// ----- numbers, from the same files the demo plays
const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);
async function stats() {
  const [catalog, featured] = await Promise.all([json('worlds.json'), json('featured.json').catch(() => ({}))]);
  const W = catalog.worlds, walks = sum(W, w => w.walks);
  if (!walks) return;
  // Every walk's row (worlds.json list): its grade, max contact and final distance by simulator truth.
  const rows = W.flatMap(w => (w.list ?? []).map(r => Object.fromEntries((w.list_fields ?? []).map((k, i) => [k, r[i]]))));
  const arrivedRows = rows.filter(r => ['clean', 'contact', 'off', 'away', 'ungraded'].includes(r.grade));
  // One grade per walk, the first that applies (as in the outcome table): contact, then off by truth.
  const arrived = arrivedRows.length, contact = arrivedRows.filter(r => r.grade === 'contact').length;
  const off = arrivedRows.filter(r => r.grade === 'off' || r.grade === 'away').length;
  const outcomes = {};
  for (const w of W) for (const [k, n] of Object.entries(w.outcomes)) if (k !== 'arrived') outcomes[k] = (outcomes[k] ?? 0) + n;
  const NAMES = { estop: ['E-stop', 'E-stops'], fell: ['fall', 'falls'], stopped: ['stop', 'stops'] };
  const failed = Object.entries(outcomes).map(([k, n]) => `${n} ${(NAMES[k] ?? [k, k])[n === 1 ? 0 : 1]}`);
  const set = (key, text) => { for (const n of document.querySelectorAll(`[data-stat="${key}"]`)) n.textContent = text; };
  set('walks', walks.toLocaleString('en-US'));
  set('arrived', `${Math.round(arrived / walks * 100)} %`);
  set('arrived-text', `But ${contact} of them pushed an obstacle hard (over 100 N), and ${off} more ended over 0.6 m off target by simulator truth.${failed.length ? ` The other ${walks - arrived}: ${failed.join(', ')}.` : ''}`);
  const words = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
  $('claim-highlights').textContent = `${walks.toLocaleString('en-US')} walks. ${words[W.length] ?? W.length} rooms. Zero motor commands.`;
  const ex = featured.facts?.execution;
  if (ex) set('lag-line', `In ${ex.walks} recorded walks, the plan body's pelvis is a median ${fmt(ex.lag_m.median, 2)} m from where the robot thinks its pelvis is while it walks (95th percentile ${fmt(ex.lag_m.p95, 2)} m).`);
}

// ----- take a closer look (its poster's button works before the section has been built)
let closerSection = null;
const closer = () => (closerSection ??= import('./closer-section.js').then(m => m.initCloserSection({ chips: $('closer-chips'), stage: $('closer-stage'), caption: $('closer-caption') })));
closerLink();  // a #closer/<room>/<goal> link that opened the page
$('closer-stage').querySelector('[data-closer-start]').addEventListener('click', () => closer().then(s => s.start()), { once: true });

// ----- small tools
document.querySelector('.menu')?.addEventListener('click', e => { if (e.target.closest('a')) e.currentTarget.open = false; });
$('faq-all')?.addEventListener('click', e => {
  const all = [...document.querySelectorAll('#faq-list details')], open = !all.every(d => d.open);
  for (const d of all) d.open = open;
  e.currentTarget.textContent = open ? 'Collapse all' : 'Expand all';
});
for (const b of document.querySelectorAll('[data-copy]')) b.addEventListener('click', async () => {
  const text = b.parentNode.querySelector('code').textContent;
  try { await navigator.clipboard.writeText(text); b.textContent = 'Copied'; } catch { b.textContent = 'Select and copy'; }
  setTimeout(() => { b.textContent = 'Copy'; }, 2000);
});

// ----- the tour's chapters (the video itself loads only when played)
async function chapters() {
  const list = await json('../media/chapters.json').catch(() => null);
  const video = $('tour-video');
  if (!list) return;
  $('chapters').innerHTML = list.map(c => `<li><button data-t="${c.t}"><span>${escape(c.at)}</span>${escape(c.title)}</button></li>`).join('');
  $('chapters').addEventListener('click', e => {
    const b = e.target.closest('[data-t]');
    if (!b) return;
    const t = Number(b.dataset.t);
    const seek = () => { video.currentTime = t; video.play().catch(() => {}); };
    // Seeking before the metadata is in is ignored: wait for it.
    if (video.readyState >= 1) seek();
    else { video.addEventListener('loadedmetadata', seek, { once: true }); video.preload = 'auto'; video.load(); }
  });
}

// ----- sections built as they near the viewport (or receive focus), and all of them once the page is idle
const starters = [];
const lazy = (sectionId, start) => {
  const section = $(sectionId);
  if (!section) return;
  let done = null;
  const go = () => {
    if (done) return done;
    io.disconnect();
    done = start().catch(error => { console.error(error); section.insertAdjacentHTML('beforeend', `<p class="muted">Could not load this part: ${escape(error.message)}</p>`); });
    return done;
  };
  const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) go(); }, { rootMargin: '400px 0px' });
  io.observe(section);
  section.addEventListener('focusin', go, { once: true });
  starters.push(go);
};
stats().catch(() => {});
lazy('highlights', chapters);
lazy('closer', closer);
lazy('atlas', async () => (await import('./atlas.js')).initAtlas($('atlas-chart')));
lazy('how', async () => (await import('./pipeline.js')).initPipeline($('pipeline'), $('pipeline-detail')));
lazy('robot-day', async () => (await import('./robotday.js')).initRobotDay($('day')));
lazy('findings', async () => (await import('./findings.js')).initFindings($('findings-cards'), $('outcome-table')));
// Sections built after a jump to #findings or #faq change the heights above it: land there again, unless the
// visitor has already scrolled on their own.
let moved = false;
for (const type of ['wheel', 'touchmove', 'keydown', 'mousedown']) window.addEventListener(type, () => { moved = true; }, { once: true, passive: true });
const idle = window.requestIdleCallback ?? (fn => setTimeout(fn, 1500));
window.addEventListener('load', () => idle(async () => {
  await Promise.all(starters.map(go => go()));
  const target = /^#[a-z-]+$/.test(location.hash) ? document.querySelector(location.hash) : null;
  if (target && !moved) requestAnimationFrame(() => target.scrollIntoView({ block: 'start' }));
}, { timeout: 4000 }));
