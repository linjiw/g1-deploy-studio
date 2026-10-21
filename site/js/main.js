import { $, escape } from './util.js';
import { json } from './data.js';

// The playground starts at once. Everything else starts when it nears the viewport or receives keyboard focus.
const lazy = (sectionId, start) => {
  const section = $(sectionId);
  if (!section) return;
  let started = false;
  const go = () => {
    if (started) return;
    started = true; io.disconnect();
    start().catch(error => { console.error(error); section.insertAdjacentHTML('beforeend', `<p class="muted">Could not load this part: ${escape(error.message)}</p>`); });
  };
  const io = new IntersectionObserver(entries => { if (entries.some(e => e.isIntersecting)) go(); }, { rootMargin: '400px 0px' });
  io.observe(section);
  section.addEventListener('focusin', go, { once: true });
};

async function playground() {
  if (!webgl()) {
    $('try').classList.add('no-webgl');
    $('pg-canvas').innerHTML = `<div class="no-webgl-note"><img src="assets/hero.jpg" alt="A recorded walk, as the 3D view would show it"><p>The 3D view needs WebGL, which this browser does not provide. The <a href="#tour">tour video</a> shows the same workflow.</p></div>`;
    $('pg-status').textContent = 'The 3D view is not available in this browser.';
    return;
  }
  const { Playground } = await import('./playground.js');
  const pg = new Playground($('try'));
  window.studioPlayground = pg;  // for the browser checks in tools/site/check.mjs
  await pg.init();
}

async function stats() {
  const catalog = await json('data/worlds.json');
  const walks = catalog.worlds.reduce((n, w) => n + w.walks, 0);
  const arrived = catalog.worlds.reduce((n, w) => n + (w.outcomes.arrived ?? 0), 0);
  document.querySelector('[data-stat="walks"]').textContent = walks.toLocaleString('en-US');
  document.querySelector('[data-stat="worlds"]').textContent = String(catalog.worlds.length);
  document.querySelector('[data-stat="arrived"]').textContent = walks ? `${Math.round(arrived / walks * 100)} %` : '—';
}

async function chapters() {
  const list = await json('media/chapters.json').catch(() => null);
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

function webgl() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

playground().catch(error => { console.error(error); $('pg-status').textContent = `Could not start the playground: ${error.message}`; });
stats().catch(() => {});
lazy('how', async () => (await import('./pipeline.js')).initPipeline($('pipeline'), $('pipeline-detail')));
lazy('robot-day', async () => (await import('./robotday.js')).initRobotDay($('day')));
lazy('findings', async () => (await import('./findings.js')).initFindings($('findings-cards')));
lazy('tour', chapters);
