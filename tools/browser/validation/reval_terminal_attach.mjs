// Re-validation · N9 (verify3-20261020): a run that ends before its first live attach opens its recording once and
// is never relabelled "No recording was saved", whichever of /api/sessions and /api/session answers first.
// No new run: response interception makes an already-completed job look running (no frame) for one poll.
// Variants: natural ordering, /api/sessions delayed, /api/session delayed (after the technique in verify3 scripts/).
//   STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/reval_terminal_attach.mjs
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const R = recorder('reval-terminal-attach');
const { browser, context } = await launch();
const probe = await context.newPage();
await probe.goto(`${BASE}/`);
const target = (await api(probe, '/api/jobs')).body.jobs.find(j => j.status === 'completed' && j.result_session_id === j.id)?.id;
// Start on another recording: at startup the app opens the newest run, which would otherwise be the target itself.
const other = (await api(probe, '/api/sessions')).body.sessions.find(s => s.available && s.id !== target)?.id;
await probe.close();

for (const variant of ['natural', 'delay-sessions', 'delay-session']) {
  await R.check(`N9-${variant}`, `Terminal first attach (${variant}): one recording load, replay mode, no "No recording" banner, picker names the run`, async () => {
    assert(target && other, 'needs one completed owned run and one other recording on this gateway');
    const page = await context.newPage();
    R.watch(page);
    const loads = [];
    page.on('response', r => { if (r.url().includes('/api/session?') && new URL(r.url()).searchParams.get('id') === target) loads.push(r.status()); });
    let fake = false, faked = 0;
    await page.route(/\/api\/jobs(\?.*)?$/, async route => {
      const url = new URL(route.request().url());
      if (!fake || route.request().method() !== 'GET') return route.continue();
      const resp = await route.fetch(), body = await resp.json();
      if (!url.searchParams.get('id')) { for (const j of body.jobs ?? []) if (j.id === target) j.status = 'running'; }
      else if (url.searchParams.get('id') === target && !faked++) {
        Object.assign(body, { status: 'running', result_session_id: null, finished_unix_s: null });
        if (body.latest) body.latest = { ...body.latest, status: 'running', frame: null };
      }
      return route.fulfill({ response: resp, json: body });
    });
    if (variant === 'delay-sessions') await page.route(/\/api\/sessions(\?.*)?$/, async route => { if (fake) await sleep(1500); return route.continue(); });
    if (variant === 'delay-session') await page.route(/\/api\/session\?/, async route => {
      if (fake && new URL(route.request().url()).searchParams.get('id') === target) await sleep(1500); return route.continue(); });
    await page.goto(`${BASE}/?workspace=rehearse&session=${encodeURIComponent(other)}`);
    await page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden && document.querySelector('#rh-run'), null, { timeout: 120000 });
    await sleep(1500);
    loads.length = 0; fake = true;
    await page.evaluate(async () => { const m = await import('/js/rehearse.js'); await m.refreshActive(); });
    await sleep(6000);
    const final = await page.evaluate(() => {
      const s = window.__studio.state, w = document.querySelector('#recording-warning');
      return { sessionId: s.sessionId, mode: s.session?.metadata?.mode, warning: w && !w.hidden ? w.textContent : null,
        picker: document.querySelector('#session-picker').value };
    });
    await R.shot(`terminal-attach-${variant}`, page);
    await page.close();
    assert(final.sessionId === target && final.mode === 'replay', `opened ${JSON.stringify(final)}`);
    assert(!/No recording was saved/.test(final.warning ?? ''), `banner: ${final.warning}`);
    assert(final.picker === target, `RUN picker names ${final.picker}`);
    assert(loads.length === 1 && loads[0] === 200, `recording loads ${JSON.stringify(loads)}`);
    return { target, ...final, loads: loads.length };
  });
}
await R.save({});
await browser.close();
