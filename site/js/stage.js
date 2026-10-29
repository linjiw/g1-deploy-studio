// Boot a stage on demand, with retry and cancellation. Failed or cancelled attempts release their viewer.
import { escape } from './util.js';
export function webgl() {
  try {
    // The installed Three.js renderer requires WebGL 2. Release this probe immediately: it is not a viewer.
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

function card(root, cancel) {
  let panel = root.querySelector('.boot');
  if (!panel) {
    root.insertAdjacentHTML('beforeend', '<div class="boot"><div class="boot-card"></div></div>');
    panel = root.querySelector('.boot');
  }
  panel.hidden = false;
  panel.classList.remove('failed');
  panel.removeAttribute('role'); panel.removeAttribute('aria-live');
  panel.querySelector('.boot-card').innerHTML = `<b data-boot="label" role="status" aria-live="polite">Loading three.js</b><div class="bar" aria-hidden="true"><i></i></div><small>About 1 MB: three.js, the G1 model and a room. Every walk is a recording; your browser runs no policy.</small><div class="boot-actions">${cancel ? '<button class="btn" data-boot="cancel">Cancel loading</button>' : ''}</div>`;
  panel.querySelector('[data-boot="cancel"]')?.addEventListener('click', cancel);
  const label = panel.querySelector('[data-boot="label"]');
  return {
    progress: (f, text) => { panel.style.setProperty('--p', String(Math.max(0, Math.min(1, f)))); if (text && label.textContent !== text) label.textContent = text; },
    fail: (message, retry) => {
      panel.classList.add('failed');
      label.textContent = 'This part could not start';
      panel.querySelector('small').innerHTML = `${escape(message)} Try again, or watch the <a href="${escape(root.dataset.tour ?? '#tour')}">tour video</a> for the same workflow.`;
      panel.querySelector('.boot-actions').insertAdjacentHTML('afterbegin', '<button class="btn primary" data-boot="retry">Try again</button>');
      panel.querySelector('[data-boot="retry"]').addEventListener('click', retry, { once: true });
      const back = panel.querySelector('[data-boot="cancel"]');
      if (back) back.textContent = 'Back to preview';
    },
    ready: () => { panel.hidden = true; },
  };
}

// onStopped restores the caller's poster. The returned promise spans retries, so callers receive only a
// successful instance (or null after cancellation), never a stale failed attempt.
export async function boot(root, options = {}, load = () => import('./demo.js').then(m => m.mountDemo), { onStopped = null } = {}) {
  const before = { nodes: [...root.childNodes], attributes: [...root.attributes].map(a => [a.name, a.value]) };
  let instance = null, stopped = false, resolveStop;
  const cancelled = new Promise(resolve => { resolveStop = resolve; });
  const restore = () => {
    instance?.destroy?.(); instance = null;
    root.replaceChildren(...before.nodes);
    for (const a of [...root.attributes]) root.removeAttribute(a.name);
    for (const [name, value] of before.attributes) root.setAttribute(name, value);
  };
  const stop = () => {
    if (stopped) return;
    stopped = true; restore(); onStopped?.(); resolveStop(null);
  };
  const attempt = async () => {
    const ui = card(root, onStopped ? stop : null);
    root.setAttribute('aria-busy', 'true');
    try {
      if (!webgl()) throw new Error('This browser does not provide WebGL 2, which the 3D view needs.');
      ui.progress(0.08, 'Loading three.js');
      const mount = await load();
      if (stopped) return null;
      ui.progress(0.3, 'Loading the robot');
      const mounted = await mount(root, { ...options, progress: ui.progress, onCreate: i => { instance = i; }, ...(onStopped ? { onStop: stop } : {}) });
      if (stopped) { mounted?.destroy?.(); return null; }
      instance = mounted;
      root.setAttribute('aria-busy', 'false'); ui.ready();
      return instance;
    } catch (error) {
      if (stopped) return null;
      console.warn('Stage could not start:', error);
      // Keep only the original poster and the error card; a partial canvas must never stay alive underneath.
      instance?.destroy?.(); instance = null;
      const panel = root.querySelector('.boot');
      restore(); if (!panel.isConnected) root.append(panel);
      root.setAttribute('aria-busy', 'false');
      return new Promise(resolve => ui.fail(String(error.message).replace(/\.?$/, '.'), () => {
        if (stopped) return;
        restore(); resolve(attempt());
      }));
    }
  };
  return Promise.race([attempt(), cancelled]);
}
