// Rehearse: choose a policy profile + arena preset, run the owned CPU worker,
// follow it live and run bounded suites. Simulation only; no hardware path.
import { $, escape, num, vector, fact, chip, request, outcomeChip, finite, emit, on, ago } from './util.js';

export const rh = {
  catalog: null, policyId: null, mapId: null, map: null, presetIndex: 0,
  settings: { duration_s: 8, seed: 0, candidates: 4, ode_steps: 6, criterion: 'arrive_hold', latency_ms: 0, anchor: 'measured' }, seeds: 1,
  job: null, suite: null, timer: null, suiteTimer: null, attached: null, busy: false, lastPerception: -Infinity,
};

const ACTIVE = ['queued', 'starting', 'running', 'cancelling'];
// 'detached': after a gateway restart a surviving worker this gateway does not own keeps
// running; follow its files read-only until its receipt makes it terminal.
const FOLLOW = [...ACTIVE, 'detached'];
const BUDGETS = [['Quick', 2, 4], ['Balanced', 4, 6], ['Wide', 8, 6]];

export async function initRehearse(catalog) {
  rh.catalog = catalog;
  rh.policyId ??= catalog.defaults.policy_id;
  rh.settings.actuators ??= catalog.default_actuators ?? 'g1-current';
  // The preselected profile starts at its own default budget until the user chooses one.
  const d = policy()?.default_planner;
  if (d && !rh.budgetChosen) Object.assign(rh.settings, { candidates: d.candidates, ode_steps: d.ode_steps });
  rh.mapId ??= (catalog.maps.find(m => m.origin === 'arena-editor') ?? catalog.maps.find(m => m.id === 'flow-detour') ?? catalog.maps[0])?.id;
  await selectMap(rh.mapId, false);
  render();
  refreshActive().catch(() => {});
}

export async function selectMap(id, rerender = true) {
  if (!id) throw new Error('Select a saved arena first.');
  rh.mapId = id;
  const token = rh.mapToken = (rh.mapToken ?? 0) + 1;
  const map = await request(`/api/map?id=${encodeURIComponent(id)}`);
  if (token !== rh.mapToken) return;  // a newer selection won; never pair its presets with old geometry
  rh.map = map;
  rh.presetIndex = 0;
  const suggested = rh.map.suggested_scenario;
  if (suggested && !rh.map.presets?.length) rh.settings.duration_s = suggested.duration_s ?? rh.settings.duration_s;
  if (rerender) render();
  emit('rehearse:preview', previewMarkers());
}

function presets() {
  const m = rh.map; if (!m) return [];
  if (m.presets?.length) return m.presets;
  if (m.suggested_scenario) return [{ label: 'Source preset', ...m.suggested_scenario }];
  return [{ label: 'Default 1 m', start_xy: [0, 0], start_yaw_rad: 0, goal_xy: [1, 0] }];
}
export function previewMarkers() {
  const q = presets()[rh.presetIndex];
  return { map: rh.map, start: q?.start_xy, yaw: q?.start_yaw_rad ?? 0, goal: q?.goal_xy };
}
const policy = () => rh.catalog?.policies?.find(p => p.id === rh.policyId);

function policyCard(p, research) {
  const selected = p.id === rh.policyId;
  const lineage = p.research_block
    ? `${p.matches_adopted ? chip('configured', 'Matches the block named in BEST_MODEL.md') : ''} Flow block <strong>${escape(p.research_block)}</strong>${p.revision ? ` @ <code>${escape(String(p.revision).slice(0, 10))}</code>` : ''}`
    : escape(p.research_lineage ?? 'Not a Flow research block');
  return `<label class="policy-card ${selected ? 'selected' : ''} ${p.available ? '' : 'unavailable'}">
    <input type="radio" name="policy" value="${escape(p.id)}" ${selected ? 'checked' : ''} ${p.available ? '' : 'disabled'}>
    <div><div class="policy-title"><strong>${escape(p.label)}</strong>${p.available ? '' : chip('unavailable', (p.missing ?? []).join('; '))}${p.matches_adopted ? '<span class="adopted">ADOPTED BLOCK</span>' : ''}</div>
    <div class="policy-meta">${lineage}</div>
    <div class="policy-meta">Tracker ${escape(p.tracker?.name ?? '—')} · runtime ${escape(p.runtime?.kind ?? 'cpu-lockstep')} · identity <code>${escape((p.identity?.identity_sha256 ?? '').slice(0, 10))}</code></div>
    ${(p.limitations ?? []).length ? `<details><summary>Limitations (${p.limitations.length})</summary><ul>${p.limitations.map(t => `<li>${escape(t)}</li>`).join('')}</ul></details>` : ''}</div></label>`;
}

export function render() {
  const root = $('rehearse-panel'); if (!root || !rh.catalog) return;
  const research = rh.catalog.flow_research ?? {};
  const pol = policy(), deployed = pol?.planner?.deployed_budget;
  const runnable = rh.catalog.maps.filter(m => m.runnable);
  const list = presets(), q = list[rh.presetIndex];
  const suiteActive = rh.suite && ['queued', 'running', 'cancelling'].includes(rh.suite.status);
  const active = (rh.job && ACTIVE.includes(rh.job.status)) || suiteActive;
  const suiteRuns = list.length * rh.seeds, suiteLimit = rh.catalog.limits?.suite_runs ?? 48;
  root.innerHTML = `
    <div class="panel-section"><h4>Flow research sync</h4>${research.available
      ? `<div class="research-sync">${chip('configured', research.basis)} Adopted block <strong>${escape(research.adopted_block)}</strong> · ${escape(research.adopted_at)} · commit <code>${escape(research.adopted_commit)}</code></div>${research.last_update ? `<details class="tiny research-note"><summary>Latest research note</summary>${escape(research.last_update)}</details>` : ''}`
      : `<div class="callout warning">${escape(research.reason ?? 'Flow research tracker unavailable')}</div>`}
      ${rh.catalog.policies.some(p => p.matches_adopted) ? '' : '<p class="tiny warn-text">No deployable Studio profile matches the adopted block yet.</p>'}</div>
    <div class="panel-section"><h4>Policy profile</h4><div class="policy-list">${rh.catalog.policies.map(p => policyCard(p, research)).join('')}</div></div>
    <div class="panel-section"><h4>Arena & preset</h4>
      <label class="field">Arena<select id="rh-map">${runnable.map(m => `<option value="${escape(m.id)}" ${m.id === rh.mapId ? 'selected' : ''}>${escape(m.label)}${m.origin === 'arena-editor' ? ' · custom' : ''}</option>`).join('')}</select></label>
      <label class="field">Preset<select id="rh-preset">${list.map((x, i) => `<option value="${i}" ${i === rh.presetIndex ? 'selected' : ''}>${escape(x.label)}</option>`).join('')}</select></label>
      ${q ? `<div class="preset-readout">${fact('Start · heading', `[${vector(q.start_xy, 2)}] m · ${num((q.start_yaw_rad ?? 0) * 180 / Math.PI, 0)}°`)}${fact('Goal', `[${vector(q.goal_xy, 2)}] m · ${num(Math.hypot(q.goal_xy[0] - q.start_xy[0], q.goal_xy[1] - q.start_xy[1]), 2, 'm')} away`)}</div>` : ''}
      <button id="rh-edit-arena" class="link-button">Edit this arena →</button></div>
    <div class="panel-section"><h4>Run settings</h4>
      <div class="grid-fields"><label>Duration s<input id="rh-duration" type="number" min="1" max="10" step="0.5" value="${rh.settings.duration_s}"></label><label>Seed<input id="rh-seed" type="number" min="0" max="2147483647" step="1" value="${rh.settings.seed}"></label><label>Seeds in suite<input id="rh-seeds" type="number" min="1" max="4" step="1" value="${rh.seeds}"></label>
      <label>Candidates K<input id="rh-k" type="number" min="1" max="${pol?.limits?.candidates?.[1] ?? 16}" step="1" value="${rh.settings.candidates}"></label><label>ODE steps<input id="rh-ode" type="number" min="1" max="${pol?.limits?.ode_steps?.[1] ?? 10}" step="1" value="${rh.settings.ode_steps}"></label><span></span></div>
      <div class="field-row compact budget-buttons">${BUDGETS.map(([n, k, o]) => `<button data-budget="${k},${o}" class="${rh.settings.candidates === k && rh.settings.ode_steps === o ? 'active' : ''}">${n} ${k}/${o}</button>`).join('')}${deployed ? `<button data-budget="${deployed.candidates},${deployed.ode_steps}" class="${rh.settings.candidates === deployed.candidates && rh.settings.ode_steps === deployed.ode_steps ? 'active' : ''}" title="${pol?.loader === 'flow-callback' ? 'The budget this block was evaluated at (Isaac)' : 'The profile\'s deployed planner budget'}">Deployed ${deployed.candidates}/${deployed.ode_steps}</button>` : ''}</div>
      <div class="grid-fields"><label>Planner latency<select id="rh-latency">${[0, 100, 160, 200, 300, 500].map(v => `<option value="${v}" ${v === rh.settings.latency_ms ? 'selected' : ''}>${v ? `${v} ms` : 'none (L1)'}</option>`).join('')}</select></label>
        <label>Anchor<select id="rh-anchor" ${!rh.settings.latency_ms ? 'disabled' : ''}><option value="measured" ${rh.settings.anchor === 'measured' ? 'selected' : ''}>measured</option><option value="predict" ${rh.settings.anchor === 'predict' ? 'selected' : ''}>predict (latency-aware)</option></select></label><span></span></div>
      <p class="tiny">${rh.settings.latency_ms ? `L2: each plan starts ${rh.settings.latency_ms} ms after it is requested while physics keeps running${pol?.loader === 'flow-callback' ? ` (Studio delayed-execution approximation for the Flow callback, L2≈${rh.settings.anchor === 'predict' ? ' predict: Studio gives the planner the state predicted at request + latency from the landed plan, the g1-student-deploy method; route and tight-mode decisions stay measured' : ''})` : ' (source lockstep latency model)'}.` : 'L1: physics waits for every replan, hiding planner latency.'}</p>
      <label class="field" title="${escape((rh.catalog.actuators ?? []).find(a => a.id === rh.settings.actuators)?.hardware ?? '')}">Actuator limits (hip pitch / roll / yaw)<select id="rh-actuators">${(rh.catalog.actuators ?? []).map(a => `<option value="${escape(a.id)}" ${a.id === rh.settings.actuators ? 'selected' : ''} title="${escape(a.description)}">${escape(a.label)}</option>`).join('')}</select></label>
      <label class="field">Success criterion<select id="rh-criterion">${(rh.catalog.criteria ?? [{ id: 'arrive_hold', label: 'Arrive and hold' }]).map(c => `<option value="${escape(c.id)}" ${c.id === rh.settings.criterion ? 'selected' : ''} title="${escape(`radius ${c.goal_radius_m} m · speed ≤ ${c.goal_speed_m_s} m/s for ${c.goal_hold_s} s · collision > ${c.obstacle_contact_threshold_n} N`)}">${escape(c.label)}</option>`).join('')}</select></label>
      <p class="tiny">CPU lockstep pauses physics while planning, so larger budgets cost wall time, not simulated time. Wall limit for this profile: ${pol?.limits?.wall_s ?? 180} s.</p></div>
    <div class="panel-section sticky-actions"><button id="rh-run" class="primary-action" ${active || !pol?.available ? 'disabled' : ''}>▶ Run preset</button><button id="rh-suite" ${active || !pol?.available || suiteRuns > suiteLimit ? 'disabled' : ''} title="${suiteRuns > suiteLimit ? `A suite holds at most ${suiteLimit} runs` : 'Run every preset of this arena (× seeds) one after another'}">Run suite · ${suiteRuns} run${suiteRuns === 1 ? '' : 's'}${suiteRuns > suiteLimit ? ` (max ${suiteLimit})` : ''}</button>${active ? '<button id="rh-cancel" class="danger">Cancel</button>' : ''}</div>
    <div id="rh-job" class="panel-section"></div><div id="rh-suite-status" class="panel-section"></div>`;
  bind();
  renderJob(); renderSuite();
}

function bind() {
  document.querySelectorAll('input[name=policy]').forEach(r => r.addEventListener('change', () => {
    rh.policyId = r.value;
    const d = policy()?.default_planner; if (d) Object.assign(rh.settings, { candidates: d.candidates, ode_steps: d.ode_steps });
    render();
  }));
  $('rh-map').addEventListener('change', e => selectMap(e.target.value).catch(report));
  $('rh-preset').addEventListener('change', e => { rh.presetIndex = Number(e.target.value); render(); emit('rehearse:preview', previewMarkers()); });
  $('rh-edit-arena').addEventListener('click', () => emit('rehearse:edit-arena', rh.mapId));
  for (const [id, key] of [['rh-duration', 'duration_s'], ['rh-seed', 'seed'], ['rh-k', 'candidates'], ['rh-ode', 'ode_steps']])
    $(id).addEventListener('change', e => {
      // Clamp to the field's allowed range here, instead of a server error after Run (review L6).
      const el = e.target, v = Number(el.value), lo = Number(el.min), hi = Number(el.max);
      if (finite(v)) rh.settings[key] = Math.round(Math.min(finite(hi) ? hi : v, Math.max(finite(lo) ? lo : v, v)) * 2) / 2;
      if (key === 'candidates' || key === 'ode_steps') { rh.settings[key] = Math.round(rh.settings[key]); rh.budgetChosen = true; }
      if (key === 'seed') rh.settings.seed = Math.round(rh.settings.seed);
      render();
    });
  $('rh-criterion').addEventListener('change', e => { rh.settings.criterion = e.target.value; });
  $('rh-actuators')?.addEventListener('change', e => { rh.settings.actuators = e.target.value; render(); });
  $('rh-latency').addEventListener('change', e => { rh.settings.latency_ms = Number(e.target.value); render(); });
  $('rh-anchor').addEventListener('change', e => { rh.settings.anchor = e.target.value; render(); });
  $('rh-seeds').addEventListener('change', e => { rh.seeds = Math.max(1, Math.min(4, Number(e.target.value) || 1)); render(); });
  document.querySelectorAll('[data-budget]').forEach(b => b.addEventListener('click', () => {
    const [k, o] = b.dataset.budget.split(',').map(Number); Object.assign(rh.settings, { candidates: k, ode_steps: o }); rh.budgetChosen = true; render();
  }));
  $('rh-run').addEventListener('click', () => guarded(runPreset));
  $('rh-suite').addEventListener('click', () => guarded(runSuite));
  $('rh-cancel')?.addEventListener('click', () => guarded(cancel));
}

function report(error) { emit('workbench:error', error.message ?? String(error)); }
let pollError = null;
function pollFailed(error) {
  pollError = `Lost contact with the gateway (${error.message ?? error}); retrying. A running worker is not affected by the page.`;
  report({ message: pollError });
}
function pollRecovered() { if (pollError) emit('workbench:clear', pollError); pollError = null; }
async function guarded(task) {
  if (rh.busy) return; rh.busy = true;
  try { await task(); } catch (error) { report(error); } finally { rh.busy = false; render(); }
}

function scenarioRequest(q, seed) {
  const pol = policy();
  const label = `${rh.map.label} · ${q.label} · ${pol?.short_label ?? rh.policyId} · K${rh.settings.candidates}/ODE${rh.settings.ode_steps} · s${seed}${rh.settings.criterion === 'arena_reach' ? ' · reach' : ''}${rh.settings.latency_ms ? ` · lat ${rh.settings.latency_ms}${rh.settings.anchor === 'predict' ? 'p' : ''}` : ''}${rh.settings.actuators && rh.settings.actuators !== rh.catalog.default_actuators ? ` · ${rh.settings.actuators}` : ''}`.slice(0, 100);
  // The anchor only matters with latency; without it every plan is anchored on the measured state.
  const latency = { ms: rh.settings.latency_ms, anchor: rh.settings.latency_ms ? rh.settings.anchor : 'measured' };
  return { label, preset_label: q.label, map_id: rh.mapId, backend_id: 'flow-sonic-cpu', policy_id: rh.policyId, criterion: rh.settings.criterion, latency, actuators: rh.settings.actuators, duration_s: rh.settings.duration_s,
    start_xy: q.start_xy, goal_xy: q.goal_xy, start_yaw_rad: q.start_yaw_rad ?? 0, seed,
    planner: { candidates: rh.settings.candidates, ode_steps: rh.settings.ode_steps } };
}
async function saveScenario(q, seed) {
  const saved = await request('/api/scenarios', scenarioRequest(q, seed));
  if (saved.validation?.valid === false) throw new Error(`${q.label}: ${saved.validation.issues.join('; ')}`);
  return saved.scenario;
}

async function runPreset() {
  const q = presets()[rh.presetIndex];
  const scenario = await saveScenario(q, rh.settings.seed);
  rh.job = await request('/api/jobs', { scenario_id: scenario.id });
  rh.attached = null; rh.lastPerception = -Infinity;
  emit('rehearse:started', rh.job);
  poll();
}

async function runSuite() {
  const total = presets().length * rh.seeds, limit = rh.catalog.limits?.suite_runs ?? 48;
  if (total > limit) throw new Error(`This suite has ${total} runs; the limit is ${limit}. Reduce presets or seeds.`);
  const ids = [];
  for (const q of presets()) for (let s = 0; s < rh.seeds; s++) ids.push((await saveScenario(q, rh.settings.seed + s)).id);
  // The previous run is not part of this suite: stop following it (pollSuite attaches the suite's runs).
  clearTimeout(rh.timer); rh.job = null; rh.attached = null; rh.lastPerception = -Infinity; renderJob();
  const suffix = ` · ${policy()?.short_label ?? rh.policyId} · ${ids.length} runs`;
  rh.suite = await request('/api/suites', { label: `${rh.map.label.slice(0, 100 - suffix.length)}${suffix}`, scenario_ids: ids });
  pollSuite();
}

async function cancel() {
  if (rh.suite && ['queued', 'running'].includes(rh.suite.status)) {
    rh.suite = await request('/api/suites/cancel', { id: rh.suite.id });
    renderSuite(); pollSuite();
  } else if (rh.job && ACTIVE.includes(rh.job.status)) await request('/api/jobs/cancel', { id: rh.job.id });
  poll();
}

export async function refreshActive() {
  const { jobs } = await request('/api/jobs');
  const live = jobs.find(j => FOLLOW.includes(j.status));  // includes runs a restarted gateway does not own
  if (live && !rh.job) { rh.job = live; poll(); }
  const { suites } = await request('/api/suites');
  const runningSuite = suites.find(s => ['queued', 'running', 'cancelling'].includes(s.status));
  if (runningSuite) { rh.suite = runningSuite; pollSuite(); }
}

async function poll() {
  clearTimeout(rh.timer);
  if (!rh.job) return;
  try {
    const previous = rh.job.status;
    rh.job = await request(`/api/jobs?id=${encodeURIComponent(rh.job.id)}&light=1&perception_after=${rh.lastPerception}`);
    if (rh.job.latest?.perception?.time > rh.lastPerception) rh.lastPerception = rh.job.latest.perception.time;
    emit('rehearse:job', rh.job);
    pollRecovered();
    if (previous !== rh.job.status) render(); else renderJob();
    if (!FOLLOW.includes(rh.job.status)) { emit('rehearse:finished', rh.job); return; }
  } catch (error) { pollFailed(error); rh.timer = setTimeout(poll, 1000); return; }
  rh.timer = setTimeout(poll, rh.job.status === 'detached' ? 1000 : 350);
}

async function pollSuite() {
  clearTimeout(rh.suiteTimer);
  if (!rh.suite) return;
  try {
    rh.suite = await request(`/api/suites?id=${encodeURIComponent(rh.suite.id)}`);
    const current = rh.suite.runs.find(r => r.status === 'running' && r.job_id);
    if (current && current.job_id !== rh.job?.id) {
      rh.job = { id: current.job_id, status: 'running' }; rh.attached = null; rh.lastPerception = -Infinity;
      render();  // a new suite run: refresh the action bar (Cancel shown, Run disabled)
      poll();
    }
    pollRecovered();
    renderSuite();
    if (!['queued', 'running', 'cancelling'].includes(rh.suite.status)) { render(); emit('rehearse:suite-finished', rh.suite); return; }
  } catch (error) { pollFailed(error); }
  rh.suiteTimer = setTimeout(pollSuite, 1000);
}

function renderJob() {
  const node = $('rh-job'); if (!node) return;
  const job = rh.job;
  if (!job) { node.innerHTML = '<p class="tiny">No run yet. A run executes the selected policy profile → SONIC ONNX → MuJoCo in an owned CPU worker. Hardware stays disabled.</p>'; return; }
  const progress = job.latest?.progress ?? {}, frame = job.latest?.frame;
  const sim = frame?.time ?? progress.simulation_time_s, total = progress.requested_duration_s ?? job.scenario?.duration_s;
  const pct = finite(sim) && finite(total) ? Math.min(100, sim / total * 100) : 0;
  const summary = { ...(job.summary ?? {}), ...(job.summary?.report ?? {}) };
  const goal = job.scenario?.goal_xy, dist = goal && frame?.position ? Math.hypot(frame.position[0] - goal[0], frame.position[1] - goal[1]) : null;
  node.innerHTML = `<h4>Current run <code>${escape(job.id)}</code></h4>
    <div class="job-line">${outcomeChip(summary.outcome, job.status)}<span>${escape(job.scenario?.label ?? '')}</span></div>
    <div class="progress"><i style="width:${pct}%"></i></div>
    ${fact('Simulated / requested', `${num(sim, 2)} / ${num(total, 1, 's')}`)}${fact('Goal distance now', num(dist ?? summary.final_goal_distance_xy_m, 3, 'm'))}
    ${progress.wall_time_s !== undefined ? fact('Worker wall · real-time factor', `${num(progress.wall_time_s, 1, 's')} · ${num(progress.real_time_factor, 2, '×')}`) : ''}
    ${job.runtime ? fact('Telemetry receipt', `${job.runtime.telemetry_status ?? '—'} · ${num(job.runtime.telemetry_age_ms, 0, 'ms')}`) : ''}
    ${summary.outcome ? `${fact('Final goal distance', num(summary.final_goal_distance_xy_m, 3, 'm'))}${fact('Peak contact', num(summary.maximum_obstacle_contact_n, 1, 'N'))}${summary.plan_latency_s ? fact('Planner p50 / p95', `${num(summary.plan_latency_s.p50 * 1000, 0)} / ${num(summary.plan_latency_s.p95 * 1000, 0, 'ms')}`) : ''}` : ''}
    ${job.error ? `<p class="job-error">${escape(job.error)}</p>` : ''}
    ${job.result_session_id ? `<button class="primary-action wide-button" data-open-session="${escape(job.result_session_id)}">${job.status === 'failed' ? 'Inspect recorded failure' : 'Open recorded result'} →</button>` : ''}
    ${job.log_tail && job.status === 'failed' ? `<details><summary>Worker log tail</summary><pre class="log">${escape(String(job.log_tail).slice(-3000))}</pre></details>` : ''}`;
  node.querySelector('[data-open-session]')?.addEventListener('click', e => emit('open-session', e.currentTarget.dataset.openSession));
}

function renderSuite() {
  const node = $('rh-suite-status'); if (!node) return;
  const s = rh.suite;
  if (!s) { node.innerHTML = ''; return; }
  const done = s.runs.filter(r => r.outcome).length, goals = s.runs.filter(r => r.outcome === 'goal_completion').length;
  node.innerHTML = `<h4>Suite · ${escape(s.status)}</h4><p class="tiny">${escape(s.label)} · ${done}/${s.runs.length} finished · ${goals} goal${goals === 1 ? '' : 's'} · started ${escape(ago(s.created_unix_s))}</p>
    <table class="suite-table"><tbody>${s.runs.map(r => `<tr><td>${outcomeChip(r.outcome, r.status)}</td><td>${escape(r.preset ?? r.label ?? r.scenario_id)}${r.seed !== undefined && r.seed !== null ? ` · s${escape(r.seed)}` : ''}</td><td>${r.job_id && r.outcome ? `<button class="link-button" data-open-session="${escape(r.job_id)}">open</button>` : ''}</td></tr>`).join('')}</tbody></table>`;
  node.querySelectorAll('[data-open-session]').forEach(b => b.addEventListener('click', () => emit('open-session', b.dataset.openSession)));
}

on('catalog:refreshed', catalog => {
  if (!rh.catalog) return;
  rh.catalog = catalog;
  render();
});
