// The main page. Nothing heavy loads until asked: the demo and the split view start from their posters (or a
// #try/... link), the diagram, robot day and findings are built as they near the viewport.
import { $, escape, fmt, reducedMotion } from './util.js';
import { json } from './data.js';
import { boot } from './stage.js';

const smooth = () => (reducedMotion() ? 'auto' : 'smooth');

// ----- the demo slot
let demoStart = null;
function startDemo({ scroll = true } = {}) {
  if (scroll) $('demo-stage').scrollIntoView({ behavior: smooth(), block: 'start' });
  if (demoStart) return demoStart;
  const stage = $('demo-stage');
  stage.querySelector('.poster').hidden = true;
  demoStart = boot(stage, { embedded: true, hashPrefix: 'try/', fullHref: 'demo/' }).then(d => { window.studioDemo = d; return d; });
  return demoStart;
}
for (const b of document.querySelectorAll('[data-start]')) b.addEventListener('click', () => startDemo());
if (location.hash.startsWith('#try/')) startDemo({ scroll: false });
window.addEventListener('hashchange', () => { if (location.hash.startsWith('#try/') && !demoStart) startDemo(); });

// ----- numbers, from the same files the demo plays
const sum = (list, f) => list.reduce((n, x) => n + (f(x) ?? 0), 0);
async function stats() {
  const [catalog, featured] = await Promise.all([json('worlds.json'), json('featured.json').catch(() => ({}))]);
  const W = catalog.worlds, walks = sum(W, w => w.walks);
  if (!walks) return;
  const arrived = sum(W, w => w.outcomes.arrived), contact = sum(W, w => w.contact);
  const off = sum(W, w => (w.grades?.off ?? 0) + (w.grades?.away ?? 0)), failed = walks - arrived;
  const pct = n => `${Math.round(n / walks * 100)} %`;
  const set = (key, text) => { for (const n of document.querySelectorAll(`[data-stat="${key}"]`)) n.textContent = text; };
  set('walks', walks.toLocaleString('en-US'));
  set('arrived', pct(arrived));
  set('arrived-text', `But ${contact} of them (${pct(contact)}) pushed an obstacle with more than 100 N on the way, ${off} ended more than 0.6 m from the goal by simulator truth${failed ? `, and ${failed} did not arrive (E-stop or fall)` : ''}.`);
  $('claim-highlights').textContent = `${walks.toLocaleString('en-US')} walks, ${W.length} rooms, zero motor commands.`;
  const ex = featured.facts?.execution;
  if (ex) set('lag-line', `In ${ex.walks} recorded walks, the plan body's pelvis is a median ${fmt(ex.lag_m.median, 2)} m from where the robot thinks its pelvis is while it walks (95th percentile ${fmt(ex.lag_m.p95, 2)} m).`);
}

// ----- take a closer look (its poster's button works before the section has been built)
let closerSection = null;
const closer = () => (closerSection ??= import('./closer-section.js').then(m => m.initCloserSection({ chips: $('closer-chips'), stage: $('closer-stage'), caption: $('closer-caption') })));
$('closer-stage').querySelector('[data-closer-start]').addEventListener('click', () => closer().then(s => s.start()), { once: true });

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
