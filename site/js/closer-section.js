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
      const poster = stage.querySelector('.poster');
      poster.hidden = true;
      starting = boot(stage, { scenarios: [current, ...list.filter(x => x !== current)] }, () => import('./closer.js').then(m => m.mountCloser), {
        onStopped: () => { starting = null; view = null; window.studioCloser = null; poster.hidden = false; poster.querySelector('.start')?.focus({ preventScroll: true }); },
      }).then(v => { view = v; window.studioCloser = v; return v; });
    }
    return starting;
  };
  stage.querySelector('[data-closer-start]').addEventListener('click', start);
  // Any recorded walk, plan body against body, from its start (the demo's "Plan vs body" sends it here).
  const showWalk = async (world, goal, title = 'Your walk') => {
    await loaded;
    if (!list) return;
    const sc = { id: 'walk', mode: 'body', world, goal, at: 0.6, clip_s: 9, view: 'split', title, chip: 'Your walk',
                 caption: 'The walk you chose in the demo, from just after its pre-scan: the plan body on the left, the body that followed it on the right. Use the timeline to move through the walk.' };
    const i = list.findIndex(x => x.id === 'walk');
    if (i >= 0) list[i] = sc; else list.unshift(sc);
    chips.querySelector('[data-sc="walk"]')?.remove();
    chips.insertAdjacentHTML('afterbegin', `<button data-sc="walk" aria-pressed="false">Your walk<small>plan · body</small></button>`);
    show(sc, true);
    if (!starting) { start(); return; }
    await starting;
    view?.load(sc);
  };
  chips.addEventListener('click', async e => {
    const b = e.target.closest('[data-sc]');
    if (!b || !list) return;
    const sc = list.find(x => x.id === b.dataset.sc);
    show(sc, true);
    if (!starting) { start(); return; }
    await starting;
    view?.load(sc);
  });
  return { loaded, start, showWalk };
}
