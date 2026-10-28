// Replay failure, keyboard and scheduling acceptance. GET-only, no worker or robot connection.
// STUDIO_URL=http://127.0.0.1:8796 node tools/browser/replay_edges.mjs
import { launch, recorder, ready, BASE, assert } from './validation/harness.mjs';

const { browser, context } = await launch();
const report = recorder('replay-edges');
const page = await context.newPage(); report.watch(page);
await page.addInitScript(() => {
  const raf = window.requestAnimationFrame.bind(window);
  window.__rafCallbacks = 0;
  window.requestAnimationFrame = callback => raf(t => { window.__rafCallbacks++; callback(t); });
});
try {
  await report.check('empty', 'An empty catalog stays unavailable and Retry opens a real recording', async () => {
    await page.route('**/api/sessions', r => r.fulfill({ json: { sessions: [] } }));
    await page.goto(`${BASE}/?session=sonic-lockstep`);
    await page.waitForFunction(() => window.__studio?.state.ready);
    await page.click('#workspace-replay');
    await page.waitForSelector('#refresh-recordings');
    assert(await page.locator('#play').isDisabled(), 'empty replay can play');
    assert(await page.locator('#session-picker').isDisabled(), 'empty picker is enabled');
    assert(await page.locator('#source-badge').isHidden() || /unavailable/i.test(await page.locator('#source-badge').innerText()), 'empty data marked as truth');
    await report.shot('empty');
    await page.unroute('**/api/sessions'); await page.click('#refresh-recordings');
    await ready(page, 'sonic-lockstep');
    assert(!await page.locator('#play').isDisabled(), 'recovered replay cannot play');
  });
  await report.check('idle', 'Paused replay performs no animation callbacks after settling', async () => {
    await page.waitForTimeout(1000);
    const before = await page.evaluate(() => window.__rafCallbacks);
    await page.waitForTimeout(1200);
    const after = await page.evaluate(() => window.__rafCallbacks);
    assert(after - before <= 2, `${after - before} idle callbacks`);
    return { callbacks: after - before, interval_ms: 1200 };
  });
  await report.check('workspace-race', 'A slow workspace load cannot reactivate an editor after leaving', async () => {
    await page.evaluate(() => { window.__studio.state.catalog = null; });
    let release, arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/workbench', async route => { arrived(); await held; await route.continue(); });
    await page.click('#workspace-arena'); await started;
    await page.click('#workspace-replay'); release();
    await page.waitForFunction(() => window.__studio.state.catalog);
    await page.unroute('**/api/workbench');
    assert(await page.evaluate(() => window.__studio.state.workspace) === 'replay', 'late catalog replaced workspace');
    assert(!await page.evaluate(() => window.__studio.arena.active_workspace), 'hidden editor owns keyboard');
    assert(await page.locator('#tool-panel').isHidden(), 'late workspace revealed old panel');
  });
  await report.check('keyboard', 'Native Space, popover Escape and keyboard resizing keep their meanings', async () => {
    await page.focus('#camera-top'); await page.keyboard.press('Space');
    assert(await page.evaluate(() => window.__studio.camera) === 'top', 'Space did not activate focused camera');
    assert(!await page.evaluate(() => window.__studio.state.playing), 'camera button started replay');
    await page.locator('#intent-content summary').first().focus(); await page.keyboard.press('Space');
    assert(!await page.evaluate(() => window.__studio.state.playing), 'details summary started replay');
    await page.click('#layers-button');
    assert(await page.evaluate(() => document.activeElement.id) === 'layer-robot', 'Layers did not receive focus');
    await page.keyboard.press('Escape');
    assert(await page.locator('#layers-popover').isHidden(), 'Escape inside a checkbox did not close Layers');
    assert(await page.evaluate(() => document.activeElement.id) === 'layers-button', 'Layers focus not restored');
    await page.click('#workspace-arena'); await page.click('#help-button'); await page.keyboard.press('Escape');
    assert(await page.locator('#help-overlay').isHidden(), 'Arena swallowed Escape for help');
    await page.click('#workspace-replay');
    await page.focus('#inspector-resize');
    const initial = Number(await page.locator('#inspector-resize').getAttribute('aria-valuenow'));
    await page.keyboard.press('ArrowLeft');
    assert(Number(await page.locator('#inspector-resize').getAttribute('aria-valuenow')) === initial + 20, 'separator did not resize');
    await page.keyboard.press('ArrowRight');
  });
  await report.check('model-failure', 'Failed replacement model preserves the last recording and retries', async () => {
    await page.route('**/api/model?id=sonic-dds-tutorial', r => r.fulfill({ status: 503, json: { error: 'Model temporarily unavailable' } }));
    const before = await page.locator('#session-title').innerText();
    await page.selectOption('#session-picker', 'sonic-dds-tutorial');
    await page.waitForSelector('#retry-load');
    assert(await page.evaluate(() => window.__studio.state.sessionId) === 'sonic-lockstep', 'failed model replaced state');
    assert(await page.locator('#session-picker').inputValue() === 'sonic-lockstep', 'picker does not match view');
    assert(await page.locator('#session-title').innerText() === before, 'title does not match retained scene');
    assert(await page.evaluate(() => window.__studio.model.nq) === 36, 'retained model changed');
    await report.shot('model-unavailable');
    await page.unroute('**/api/model?id=sonic-dds-tutorial'); await page.click('#retry-load');
    await ready(page, 'sonic-dds-tutorial');
    assert(await page.evaluate(() => window.__studio.model.nq) === 50, 'Retry did not load Dex3');
  }, { expectHttp: [/503 .*api\/model/] });
  await report.check('superseded', 'A slow superseded recording cannot replace the latest selection', async () => {
    let release, arrived;
    const started = new Promise(resolve => { arrived = resolve; });
    const held = new Promise(resolve => { release = resolve; });
    await page.route('**/api/session?id=sonic-lockstep', async route => {
      arrived(); await held; await route.continue().catch(() => {});
    });
    await page.selectOption('#session-picker', 'sonic-lockstep'); await started;
    assert(await page.locator('#play').isDisabled(), 'transport active during replacement');
    await page.selectOption('#session-picker', 'wire-local'); await ready(page, 'wire-local');
    release(); await page.unroute('**/api/session?id=sonic-lockstep'); await page.waitForTimeout(300);
    assert(await page.evaluate(() => window.__studio.state.sessionId) === 'wire-local', 'old response replaced new choice');
    assert(await page.locator('#session-picker').inputValue() === 'wire-local', 'picker changed after cancellation');
  });
  await report.check('playback', 'Replay still plays, pauses, loops and restores a view link', async () => {
    await page.selectOption('#session-picker', 'sonic-lockstep'); await ready(page, 'sonic-lockstep');
    await page.evaluate(() => window.__studio.seek(0.2)); await page.click('#play'); await page.waitForTimeout(500); await page.click('#play');
    const t = await page.evaluate(() => window.__studio.state.time);
    assert(t > 0.4, `replay did not advance: ${t}`);
    await page.check('#loop');
    const looped = await page.evaluate(() => new Promise(resolve => {
      const s = window.__studio;
      s.seek(s.state.session.metadata.duration_s - 0.05);
      const cleanup = () => { clearTimeout(timeout); window.removeEventListener('studio:frame', onFrame); s.setPlaying(false); };
      const onFrame = event => { if (event.detail.time < 0.5) { cleanup(); resolve(true); } };
      const timeout = setTimeout(() => { cleanup(); resolve(false); }, 10000);
      window.addEventListener('studio:frame', onFrame); document.getElementById('play').click();
    }));
    assert(looped, 'loop did not restart');
    await page.uncheck('#loop');
    await page.evaluate(() => window.__studio.seek(1.234)); await page.click('#camera-follow'); await page.click('#tab-health'); await page.click('#copy-view');
    await page.goto(page.url()); await ready(page, 'sonic-lockstep');
    assert(Math.abs(await page.evaluate(() => window.__studio.state.time) - 1.234) < 0.002, 'view time not restored');
    assert(await page.evaluate(() => window.__studio.camera) === 'follow', 'view camera not restored');
    assert(await page.locator('#tab-health').getAttribute('aria-selected') === 'true', 'view panel not restored');
  });
  await report.check('startup-race', 'Replacing the initial recording keeps controls busy until the replacement finishes', async () => {
    let releaseFirst, releaseNext, firstArrived, nextArrived;
    const first = new Promise(resolve => { releaseFirst = resolve; });
    const next = new Promise(resolve => { releaseNext = resolve; });
    const firstStarted = new Promise(resolve => { firstArrived = resolve; });
    const nextStarted = new Promise(resolve => { nextArrived = resolve; });
    await page.route('**/api/session?id=sonic-lockstep', async r => { firstArrived(); await first; await r.continue().catch(() => {}); });
    await page.route('**/api/session?id=sonic-dds-tutorial', async r => { nextArrived(); await next; await r.continue().catch(() => {}); });
    await page.goto(`${BASE}/?session=sonic-lockstep`); await firstStarted;
    await page.selectOption('#session-picker', 'sonic-dds-tutorial'); await nextStarted;
    releaseFirst(); await page.waitForTimeout(200);
    assert(await page.evaluate(() => window.__studio.state.loading), 'initial aborted request cleared newer loading state');
    assert(await page.locator('#play').isDisabled(), 'transport enabled before replacement loaded');
    releaseNext(); await ready(page, 'sonic-dds-tutorial');
    await page.unroute('**/api/session?id=sonic-lockstep'); await page.unroute('**/api/session?id=sonic-dds-tutorial');
  });
} finally { await report.save(); await browser.close(); }
process.exitCode = report.results.some(r => r.status !== 'PASS') ? 1 : 0;
