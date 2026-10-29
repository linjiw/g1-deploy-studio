// Scenario choices share one viewer. A failed download keeps the last successful view and offers a retry.
import { escape } from './util.js';
import { json } from './data.js';
import { boot } from './stage.js';

export function initCloserSection({ chips, stage, caption, keep = () => true }) {
  let list = null, current = null, view = null, starting = null, metadata = null, choice = 0;
  const status = document.createElement('p');
  status.className = 'section-status'; status.setAttribute('role', 'status'); status.hidden = true;
  caption.before(status);
  const message = (text = '', retry = null) => {
    status.hidden = !text; status.textContent = text;
    if (retry) {
      const b = document.createElement('button'); b.className = 'button'; b.textContent = 'Try again';
      b.addEventListener('click', retry, { once: true }); status.append(' ', b);
    }
  };
  const show = (sc, chosen = false) => {
    current = sc;
    if (chosen) caption.setAttribute('aria-live', 'polite');
    for (const b of chips.querySelectorAll('[data-sc]')) b.setAttribute('aria-pressed', String(b.dataset.sc === sc.id));
    caption.innerHTML = `<b>${escape(sc.title)}.</b> ${escape(sc.caption)}`;
  };
  const getList = () => metadata ??= json('featured.json').then(featured => {
    list = (featured.closer ?? []).filter(keep);
    if (!list.length) { chips.hidden = true; message('No comparison recordings are available.'); return list; }
    chips.hidden = false;
    chips.innerHTML = list.map(sc => `<button data-sc="${escape(sc.id)}" aria-pressed="false">${escape(sc.chip)}<small>${sc.mode === 'estimate' ? 'truth · estimate' : 'plan · body'}</small></button>`).join('');
    show(list[0]); message(); return list;
  }).catch(() => {
    metadata = null;
    message('Comparison recordings could not load. Check your connection and try again.', () => getList());
    return [];
  });
  const loaded = getList();
  const start = async () => {
    await getList();
    if (!list?.length) return null;
    if (!starting) {
      const poster = stage.querySelector('.poster'); poster.hidden = true;
      starting = boot(stage, { scenarios: [current, ...list.filter(x => x !== current)], trace: document.getElementById('closer-trace') }, () => import('./closer.js').then(m => m.mountCloser), {
        onStopped: () => { ++choice; starting = null; view = null; window.studioCloser = null; message(); poster.hidden = false; poster.querySelector('.start')?.focus({ preventScroll: true }); },
      }).then(v => { view = v; window.studioCloser = v; return v; });
    }
    return starting;
  };
  stage.querySelector('[data-closer-start]').addEventListener('click', start);
  const choose = async sc => {
    const token = ++choice;
    if (!starting) { show(sc, true); return start(); }
    message(`Loading ${sc.title.toLowerCase()}…`);
    stage.setAttribute('aria-busy', 'true');
    try {
      const active = await starting;
      if (!active || token !== choice) return;
      await active.load(sc);
      if (token === choice && !active.destroyed) { show(sc, true); message(); }
    } catch {
      if (token === choice) message('This comparison could not load. The previous recording is still shown.', () => choose(sc));
    } finally { if (token === choice) stage.setAttribute('aria-busy', 'false'); }
  };
  const showWalk = async (world, goal, title = 'Your walk') => {
    await getList();
    if (!list) return;
    const sc = { id: 'walk', mode: 'body', world, goal, at: 0.6, clip_s: 9, view: 'split', title, chip: 'Your walk',
      caption: 'The walk you chose in the demo, from just after its pre-scan: the plan body on the left, the body that followed it on the right. Use the timeline to move through the walk.' };
    const i = list.findIndex(x => x.id === 'walk');
    if (i >= 0) list[i] = sc; else list.unshift(sc);
    chips.hidden = false;
    chips.querySelector('[data-sc="walk"]')?.remove();
    chips.insertAdjacentHTML('afterbegin', '<button data-sc="walk" aria-pressed="false">Your walk<small>plan · body</small></button>');
    return choose(sc);
  };
  chips.addEventListener('click', e => {
    const b = e.target.closest('[data-sc]');
    const sc = b && list?.find(x => x.id === b.dataset.sc);
    if (sc) choose(sc);
  });
  return { loaded, start, showWalk };
}
