// A "Take a closer look" section: scenario chips, a poster that starts the split view, and the caption.
// The poster's button works at once; the scenarios (data/featured.json) load in the background.
import { escape } from './util.js';
import { json } from './data.js';
import { boot } from './stage.js';

export function initCloserSection({ chips, stage, caption, keep = () => true }) {
  let list = null, current = null, view = null, starting = null;
  const show = (sc, chosen = false) => {
    current = sc;
    // Announced when a visitor picks a scenario, not when the page builds the section.
    if (chosen) caption.setAttribute('aria-live', 'polite');
    for (const b of chips.querySelectorAll('[data-sc]')) b.setAttribute('aria-pressed', String(b.dataset.sc === sc.id));
    caption.innerHTML = `<b>${escape(sc.title)}.</b> ${escape(sc.caption)}`;
  };
  const loaded = json('featured.json').then(featured => {
    list = (featured.closer ?? []).filter(keep);
    if (!list.length) { stage.hidden = true; chips.hidden = true; return list; }
    chips.innerHTML = list.map(sc => `<button data-sc="${sc.id}" aria-pressed="false">${escape(sc.chip)}<small>${sc.mode === 'estimate' ? 'truth · estimate' : 'plan · body'}</small></button>`).join('');
    show(list[0]);
    return list;
  });
  const start = async () => {
    await loaded;
    if (!list.length) return null;
    if (!starting) {
      stage.querySelector('.poster').hidden = true;
      starting = boot(stage, { scenarios: [current, ...list.filter(x => x !== current)] }, () => import('./closer.js').then(m => m.mountCloser))
        .then(v => { view = v; window.studioCloser = v; return v; });
    }
    return starting;
  };
  stage.querySelector('[data-closer-start]').addEventListener('click', start);
  chips.addEventListener('click', async e => {
    const b = e.target.closest('[data-sc]');
    if (!b || !list) return;
    const sc = list.find(x => x.id === b.dataset.sc);
    show(sc, true);
    if (!starting) { start(); return; }
    await starting;
    view?.load(sc);
  });
  return { loaded, start };
}
