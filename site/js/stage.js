// Booting a stage on demand: a progress card, a WebGL check, then the module (the demo or a split view).
// Nothing heavy loads before this runs: the page itself is text, images and two small JSON files.
import { escape } from './util.js';
export function webgl() {
  try { const c = document.createElement('canvas'); return !!(c.getContext('webgl2') || c.getContext('webgl')); } catch { return false; }
}

function card(root) {
  let boot = root.querySelector('.boot');
  if (!boot) {
    root.insertAdjacentHTML('beforeend', `<div class="boot" role="status" aria-live="polite"><div class="boot-card"><b data-boot="label">Loading three.js</b><div class="bar"><i></i></div><small>About 1 MB: three.js, the G1 model and a room. Every walk is a recording; your browser runs no policy.</small></div></div>`);
    boot = root.querySelector('.boot');
  }
  boot.hidden = false;
  const label = boot.querySelector('[data-boot="label"]');
  return {
    progress: (f, text) => { boot.style.setProperty('--p', String(Math.max(0, Math.min(1, f)))); if (text && label.textContent !== text) label.textContent = text; },
    fail: message => {
      boot.classList.add('failed');
      label.textContent = 'This part could not start';
      boot.querySelector('small').innerHTML = `${escape(message)} The <a href="${escape(root.dataset.tour ?? '#tour')}" style="color:#fff">tour video</a> shows the same workflow.`;
    },
  };
}

// load: () => import('./demo.js').then(m => m.mountDemo) (or another mount function); options go to it.
// With onStopped, the stage gets a Stop button: it tears the module down (its WebGL context, listeners and
// observers) and puts the stage back as it was, poster included; then onStopped runs.
export async function boot(root, options = {}, load = () => import('./demo.js').then(m => m.mountDemo), { onStopped = null } = {}) {
  const before = { nodes: [...root.childNodes], attributes: [...root.attributes].map(a => [a.name, a.value]) };
  let instance = null, stopped = false;
  const stop = () => {
    stopped = true;
    instance?.destroy?.();
    instance = null;
    root.replaceChildren(...before.nodes);
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const [name, value] of before.attributes) root.setAttribute(name, value);
    onStopped?.();
  };
  const ui = card(root);
  if (!webgl()) { ui.fail('This browser does not provide WebGL, which the 3D view needs.'); return null; }
  ui.progress(0.08, 'Loading three.js');
  try {
    const mount = await load();
    ui.progress(0.3, 'Loading the robot');
    const mounted = await mount(root, { ...options, progress: ui.progress, onCreate: i => { instance = i; }, ...(onStopped ? { onStop: stop } : {}) });
    if (stopped) { mounted?.destroy?.(); return null; }  // stopped while booting: nothing stays behind
    instance = mounted;
    return instance;
  } catch (error) {
    console.error(error);
    ui.fail(`${String(error.message).replace(/\.?$/, '.')}`);
    return null;
  }
}
