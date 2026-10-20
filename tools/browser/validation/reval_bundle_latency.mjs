// Re-validation · N8 (verify2-20261020): a bundle run under 200 ms latency shows the *executing* plan, live and
// recorded: the first plan drives SONIC at once, every replan from request + 200 ms. Launches 1 short bundle run.
//   STUDIO_URL=... STUDIO_EVIDENCE=... node tools/browser/validation/reval_bundle_latency.mjs
import { BASE, launch, recorder, assert, api, sleep } from './harness.mjs';

const { browser, context } = await launch();
const page = await context.newPage();
const R = recorder('reval-bundle-latency');
R.watch(page);
const ready = () => page.waitForFunction(() => window.__studio?.state?.session && document.querySelector('#loading-overlay').hidden, null, { timeout: 120000 });
const framePlan = () => page.evaluate(() => {
  const s = window.__studio.state, f = s.session?.frames?.at(s.frameIndex >= 0 ? s.frameIndex : -1), p = f?.plan;
  const card = [...document.querySelectorAll('#intent-content .card')].find(c => /Planner selection/.test(c.querySelector('h4')?.textContent ?? ''));
  return { mode: s.session?.metadata?.mode, t: f?.time, card: card?.innerText ?? null,
    plan: p ? { age_s: p.age_s, requested_at_s: p.requested_at_s, executing_since_s: p.executing_since_s, attribution: p.attribution, future0: p.future?.[0] } : null };
});
// A sample is consistent when its age counts from the start, and the start is the request (first plan) or request + 200 ms.
const consistent = s => s.plan && Math.abs(s.plan.age_s - (s.t - s.plan.executing_since_s)) < 1e-6
  && [0, 0.2].some(d => Math.abs(s.plan.executing_since_s - s.plan.requested_at_s - d) < 1e-6);

await page.goto(`${BASE}/`); await ready();
const live = [];
let job;
await R.check('N8-live', 'Bundle 200 ms measured: every live Intent sample names the executing plan', async () => {
  const token = (await api(page, '/api/workbench')).body.csrf_token;
  const post = async (p, data) => (await page.request.post(`${BASE}${p}`, { headers: { 'Content-Type': 'application/json', 'X-Studio-Token': token, Origin: BASE }, data })).json();
  const saved = await post('/api/scenarios', { backend_id: 'flow-sonic-cpu', map_id: 'flat-ground', label: 'Reval bundle latency', duration_s: 8,
    start_xy: [0, 0], goal_xy: [3, 0], seed: 0, policy_id: 'flow-bundle-20261008', planner: { candidates: 2, ode_steps: 4 },
    latency: { ms: 200, anchor: 'measured' } });
  job = await post('/api/jobs', { scenario_id: saved.scenario.id });
  await page.goto(`${BASE}/?workspace=rehearse`); await ready();
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'simulation', job.id, { timeout: 180000, polling: 200 });
  await page.click('#tab-intent'); await sleep(300);
  for (let shots = 0; ;) {
    const s = await framePlan();
    if (s.mode !== 'simulation') break;
    if (s.plan) live.push(s);
    if (s.t > 2 && !shots++) await R.shot('live-intent');
    const j = (await api(page, `/api/jobs?id=${job.id}&light=1`)).body;
    if (['completed', 'failed', 'cancelled'].includes(j.status)) break;
    await sleep(150);
  }
  const bad = live.filter(s => !consistent(s));
  const replans = live.filter(s => s.plan.executing_since_s > s.plan.requested_at_s + 1e-6);
  assert(live.length >= 5, `only ${live.length} live samples`);
  assert(!bad.length, `${bad.length} inconsistent live samples, e.g. ${JSON.stringify(bad[0])}`);
  assert(replans.length > 0, 'no live sample showed a replan that landed 200 ms after its request');
  assert(live.every(s => /Executing for/.test(s.card ?? '')), 'the Intent card does not say "Executing for"');
  return { job: job.id, liveSamples: live.length, replanSamples: replans.length, example: replans.at(-1)?.plan.attribution };
});
await R.check('N8-recorded', 'The recording shows the same executing plan at the live sample times', async () => {
  await page.waitForFunction(id => window.__studio.state.sessionId === id && window.__studio.state.session?.metadata?.mode === 'replay'
    && document.querySelector('#loading-overlay').hidden, job.id, { timeout: 180000 });
  const starts = await page.evaluate(() => window.__studio.state.session.metadata.latency_model?.executing_plan_starts);
  assert(Array.isArray(starts) && starts.length > 1 && starts[0][0] === starts[0][1], `executing_plan_starts ${JSON.stringify(starts)}`);
  assert(starts.slice(1).every(([s, r]) => s === r + 10), 'a replan did not start at request + 10 ticks');
  const mismatches = [];
  for (const s of live.filter((_, i) => i % Math.max(1, Math.floor(live.length / 8)) === 0)) {
    await page.evaluate(t => window.__studio.seek(t), s.t); await sleep(300);
    const r = await framePlan();
    if (!consistent(r) || r.plan.requested_at_s !== s.plan.requested_at_s || r.plan.executing_since_s !== s.plan.executing_since_s
      || JSON.stringify(r.plan.future0) !== JSON.stringify(s.plan.future0)) mismatches.push({ live: s.plan, recorded: r.plan, t: s.t });
  }
  await R.shot('recorded-intent');
  assert(!mismatches.length, `${mismatches.length} recorded frames differ from live, e.g. ${JSON.stringify(mismatches[0])}`);
  return { starts: starts.length, compared: Math.min(live.length, 9) };
});
await R.save({ live });
await browser.close();
