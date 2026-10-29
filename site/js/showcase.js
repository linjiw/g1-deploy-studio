// A deliberately selected set of successes from the public catalog. No walk/model loads before a click.
import { json } from './data.js';
import { escape, fmt } from './util.js';

const ROOMS = ['doorway', 'detour', 'clutter'];
const POSTERS = new Set(['doorway/g18-14', 'detour/g17-01', 'clutter/g20-12']);
export function selectShowcase(catalog) {
  return ROOMS.flatMap(id => {
    const world = catalog.worlds.find(w => w.id === id);
    if (!world) return [];
    const rows = (world.list ?? []).map(row => Object.fromEntries(world.list_fields.map((key, i) => [key, row[i]])));
    const eligible = rows.filter(r => r.grade === 'clean' && r.contact_n === 0 && Number.isFinite(r.final_m) && r.final_m <= 0.4 && Number.isFinite(r.dist_m) && Number.isFinite(r.duration_s) && r.duration_s <= 20);
    eligible.sort((a, b) => b.dist_m - a.dist_m || a.final_m - b.final_m || a.id.localeCompare(b.id));
    return eligible.length ? [{ ...eligible[0], world: id, title: world.title }] : [];
  });
}

export async function initShowcase(root) {
  const cards = root.querySelector('.showcase-grid');
  const load = async () => {
    try {
      const catalog = await json('worlds.json'), selected = selectShowcase(catalog);
      root.querySelector('[data-showcase-count]').textContent = catalog.worlds.reduce((n, w) => n + w.walks, 0).toLocaleString('en-US');
      if (!selected.length) { cards.innerHTML = '<p class="section-status">No recordings meet these showcase criteria. Explore the full atlas below.</p>'; return; }
      cards.innerHTML = selected.map((w, i) => {
        const key = `${w.world}/${w.id}`, film = `#try/${key}/film`;
        const poster = POSTERS.has(key) ? `<img src="media/showcase/${w.world}-${w.id}.jpg" width="960" height="600" alt="This recorded ${escape(w.title.toLowerCase())} walk in the simulator" loading="lazy" decoding="async">` : '';
        return `<article class="showcase-card" data-world="${w.world}" data-goal="${w.id}">
          <a class="showcase-shot" href="${film}" aria-label="Play film: ${escape(w.title)}"><span class="showcase-fallback" aria-hidden="true">G1<span>${escape(w.title)}</span></span>${poster}<span class="showcase-number">0${i + 1}</span><span class="showcase-play"><span aria-hidden="true">▶</span> Play film <small>${fmt(w.duration_s, 1)} s</small></span></a>
          <div class="showcase-copy"><p class="showcase-tag">Recorded simulation · clean arrival</p><h3>${escape(w.title)}</h3><dl class="showcase-metrics"><div><dt>Goal from start</dt><dd>${fmt(w.dist_m, 2)} <small>m</small></dd></div><div><dt>Final error · truth</dt><dd>${fmt(w.final_m, 2)} <small>m</small></dd></div><div><dt>Peak contact</dt><dd>${fmt(w.contact_n, 0)} <small>N</small></dd></div></dl><a class="showcase-inspect" href="demo/#${key}/play">Open interactive replay <span aria-hidden="true">↗</span></a></div>
        </article>`;
      }).join('');
      // If an older asset release is used, never substitute another walk's picture for this recording.
      for (const img of cards.querySelectorAll('img')) img.addEventListener('error', () => img.remove(), { once: true });
      root.dataset.ready = 'true';
    } catch {
      cards.innerHTML = '<div class="section-status" role="status">The recorded highlights could not load. <button class="button">Try again</button></div>';
      cards.querySelector('button').addEventListener('click', load, { once: true });
    }
  };
  root.addEventListener('click', e => {
    const a = e.target.closest('a[href^="#try/"]');
    if (a && location.hash === a.hash) { e.preventDefault(); window.dispatchEvent(new HashChangeEvent('hashchange')); }
  });
  await load();
}
