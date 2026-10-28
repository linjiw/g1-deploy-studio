// Printable build sheet: one saved arena preset turned into floor measurements from a start mark,
// the robot console command, a go/no-go checklist and the rehearsal evidence for that preset.
// Read-only: GET /api/map, /api/runs, /api/policies and /api/version. Nothing is sent to a robot.
//
// Start-mark frame: origin at the preset's start, x = ahead along the start heading, y = left, metres.
//   p_start = R(-start_yaw) · (p_world - start_xy);  box rotation = yaw - start_yaw.
// This is the frame of `./g1 robot --goal AHEAD LEFT` (the console passes --goal-frame start).
import { escape, finite, request, chip, outcomeChip, outcomeColor } from './util.js';
import { report, ACTUATOR_SHORT } from './runs.js';

// Robot-side facts, read from g1-student-deploy (6a86c86) and cited on the sheet.
export const NODE_GOAL_RADIUS_M = 0.4;  // g1deploy/node.py --goal-radius default; the console does not override it
export const LEG_ODOM_MAX_M = 3;        // OPERATOR_GUIDE §3.6: --odom leg is fine for walks up to 3 m
export const MEMORY_HALF_M = 6;         // planner memory: 12 x 12 m around the start pose (REAL_WORLD_DEPLOYMENT §1)
export const STEP_OVER_M = 0.25;        // taller ground obstacles are marked "cannot step over"
export const OVERHEAD_BOTTOM_M = 0.05;  // same rule as the arena editor: a box whose bottom is above 5 cm is overhead
const MATCH_XY_M = 0.005, MATCH_YAW_RAD = 0.01;
const CRITERION = { arrive_hold: 'arrive & hold (≤ 0.3 m, held 0.4 s)', arena_reach: 'reach (≤ 0.4 m, Flow protocol)' };

const wrap = a => Math.atan2(Math.sin(a), Math.cos(a));
const deg = r => r * 180 / Math.PI;

export function toStart(p, start, yaw) {
  const dx = p[0] - start[0], dy = p[1] - start[1], c = Math.cos(yaw), s = Math.sin(yaw);
  return [c * dx + s * dy, -s * dx + c * dy];
}
// A rectangle is symmetric under a half turn, so its rotation is reported in (-90°, 90°].
export function halfTurn(a) {
  let r = wrap(a);
  if (r > Math.PI / 2 + 1e-9) r -= Math.PI;
  else if (r <= -Math.PI / 2 + 1e-9) r += Math.PI;
  return r;
}
// Fixed decimals without a "-0.00".
export function fx(v, digits = 2) {
  if (!finite(v)) return '—';
  const s = v.toFixed(digits);
  return Number(s) === 0 ? (0).toFixed(digits) : s;
}

export function consoleCommand(ahead, left) {
  const odom = Math.hypot(ahead, left) > LEG_ODOM_MAX_M ? 'zmq' : 'leg';
  return { odom, line: `./g1 robot --iface eth0 --goal ${fx(ahead)} ${fx(left)} --odom ${odom} --mount-calib mount.json` };
}

export function sheetModel(map, index) {
  const q = map.presets[index], s0 = q.start_xy, th = q.start_yaw_rad ?? 0;
  const boxes = (map.boxes ?? []).map((b, i) => {
    const centre = toStart(b.center_xy, s0, th), yaw = halfTurn((b.yaw ?? 0) - th);
    const c = Math.cos(yaw), s = Math.sin(yaw), [hx, hy] = b.half_xy;
    const corners = [[hx, hy], [-hx, hy], [-hx, -hy], [hx, -hy]].map(([x, y]) => [centre[0] + c * x - s * y, centre[1] + s * x + c * y]);
    const overhead = b.z_bottom > OVERHEAD_BOTTOM_M;
    return { n: i + 1, centre, yaw, along: 2 * hx, across: 2 * hy, z_bottom: b.z_bottom, z_top: b.z_top, overhead,
      noStep: !overhead && b.z_top > STEP_OVER_M, corners };
  });
  const goal = toStart(q.goal_xy, s0, th);
  const distance = Math.hypot(goal[0], goal[1]);
  const overhead = boxes.filter(b => b.overhead);
  const ladder = overhead.length ? { step: 'H7', what: 'overhead obstacles' } : boxes.length ? { step: 'H6', what: 'ground obstacles' } : { step: 'H5', what: 'open floor' };
  return { preset: q, index, start: s0, yaw: th, boxes, goal, distance, bearing: Math.atan2(goal[1], goal[0]), overhead, ladder, command: consoleCommand(goal[0], goal[1]) };
}

const near2 = (a, b) => Array.isArray(a) && Array.isArray(b) && Math.abs(a[0] - b[0]) <= MATCH_XY_M && Math.abs(a[1] - b[1]) <= MATCH_XY_M;
// Rehearsals of this preset: same arena, start, heading and goal.
export function matchRuns(rows, map, q) {
  return rows.filter(r => r.map_id === map.id && near2(r.start_xy, q.start_xy) && near2(r.goal_xy, q.goal_xy)
    && finite(r.start_yaw_rad) && Math.abs(wrap(r.start_yaw_rad - (q.start_yaw_rad ?? 0))) <= MATCH_YAW_RAD);
}

const pathLength = t => t?.length > 1 ? t.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[1] - t[i][1], p[2] - t[i][2]), 0) : null;
const median = xs => { const v = xs.filter(finite).sort((a, b) => a - b); return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
function stamp(unix) {
  if (!finite(unix)) return '—';
  const d = new Date(unix * 1000), p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Signed left for the console; on the floor a negative left reads as metres to the right.
const sideText = l => fx(l).startsWith('-') ? `${fx(-l)} m right` : `${fx(l)} m left`;
const bearingText = b => Math.abs(deg(b)) < 0.5 ? 'straight ahead' : `${fx(Math.abs(deg(b)), 0)}° ${b > 0 ? 'left' : 'right'} of the heading`;

// ---------------------------------------------------------------- plan (SVG, start-mark frame, ahead up)
function planSvg(m, paths) {
  const R = NODE_GOAL_RADIUS_M;
  const pts = [[0, 0], [0.7, 0], [m.goal[0] + R, m.goal[1] + R], [m.goal[0] - R, m.goal[1] - R], ...m.boxes.flatMap(b => b.corners)];
  const lo = k => Math.floor((Math.min(...pts.map(p => p[k])) - 0.5) * 2) / 2, hi = k => Math.ceil((Math.max(...pts.map(p => p[k])) + 0.5) * 2) / 2;
  const aMin = lo(0), aMax = hi(0), lMin = lo(1), lMax = hi(1);
  const mL = 44, mR = 18, mT = 24, mB = 48;
  // Target box 760 x 440 units, close to the printed plan's aspect (full width x 88 mm), so labels keep their size.
  const S = Math.max(20, Math.min(200, Math.min((760 - mL - mR) / (lMax - lMin), (440 - mT - mB) / (aMax - aMin))));
  const W = Math.round(mL + mR + (lMax - lMin) * S), H = Math.round(mT + mB + (aMax - aMin) * S);
  const X = l => +(mL + (lMax - l) * S).toFixed(2), Y = a => +(mT + (aMax - a) * S).toFixed(2);
  const P = ([a, l]) => `${X(l)},${Y(a)}`;
  const out = [];
  out.push(`<svg id="sheet-plan" class="plan" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="sheet-plan-title" data-scale="${S.toFixed(4)}" xmlns="http://www.w3.org/2000/svg">`,
    `<title id="sheet-plan-title">Course plan from the start mark: ahead is up, left is left. 0.5 m grid.</title>`,
    `<defs><clipPath id="sheet-clip"><rect x="${mL}" y="${mT}" width="${X(lMin) - mL}" height="${Y(aMin) - mT}"/></clipPath></defs>`);
  // 0.5 m grid, metre labels: ahead on the left edge, left along the bottom (positive to the left).
  for (let k = Math.ceil(aMin * 2); k <= Math.floor(aMax * 2); k++) {
    const a = k / 2, y = Y(a);
    out.push(`<line class="${k % 2 ? 'g-minor' : 'g-major'}" x1="${mL}" x2="${X(lMin)}" y1="${y}" y2="${y}"/>`);
    if (k % 2 === 0) out.push(`<text class="g-label" x="${mL - 6}" y="${y + 4}" text-anchor="end">${fx(a, 0)}</text>`);
  }
  for (let k = Math.ceil(lMin * 2); k <= Math.floor(lMax * 2); k++) {
    const l = k / 2, x = X(l);
    out.push(`<line class="${k % 2 ? 'g-minor' : 'g-major'}" x1="${x}" x2="${x}" y1="${mT}" y2="${Y(aMin)}"/>`);
    if (k % 2 === 0) out.push(`<text class="g-label" x="${x}" y="${Y(aMin) + 15}" text-anchor="middle">${fx(l, 0)}</text>`);
  }
  out.push(`<text class="g-caption" x="${mL - 6}" y="${mT - 9}" text-anchor="end">Ahead (m) ↑</text>`,
    `<text class="g-caption" x="${mL}" y="${H - 8}">← Left + (m)</text>`, `<text class="g-caption" x="${W - mR}" y="${H - 8}" text-anchor="end">− Right →</text>`);
  // Rehearsed paths (simulator ground truth), clipped to the plan.
  out.push(`<g clip-path="url(#sheet-clip)">${paths.map(r => `<polyline class="path" style="stroke:${outcomeColor(r.outcome)}" points="${r.trajectory.map(p => P(toStart([p[1], p[2]], m.start, m.yaw))).join(' ')}"/>`).join('')}</g>`);
  for (const b of m.boxes) out.push(`<polygon id="sheet-box-${b.n}" class="${b.overhead ? 'box-overhead' : 'box-ground'}" points="${b.corners.map(P).join(' ')}"/>`);
  const [gx, gy] = [X(m.goal[1]), Y(m.goal[0])], gr = +(R * S).toFixed(2), [sx, sy] = [X(0), Y(0)];
  out.push(`<line class="straight" x1="${sx}" y1="${sy}" x2="${gx}" y2="${gy}"/>`,
    `<line class="g-ahead" x1="${sx}" y1="${sy}" x2="${sx}" y2="${mT}"/>`,
    `<circle id="sheet-goal" class="goal-ring" cx="${gx}" cy="${gy}" r="${gr}"/>`,
    `<path class="goal-cross" d="M${gx - 7} ${gy}H${gx + 7}M${gx} ${gy - 7}V${gy + 7}"/>`,
    `<text class="mark-label" x="${gx + gr + 5 + 40 > W - mR ? gx - gr - 5 : gx + gr + 5}" y="${gy + 4}" text-anchor="${gx + gr + 45 > W - mR ? 'end' : 'start'}">Goal</text>`);
  const tip = Y(0.6);
  out.push(`<circle class="start-ring" cx="${sx}" cy="${sy}" r="10"/>`, `<path class="heading" d="M${sx - 14} ${sy}H${sx + 14}"/>`,
    `<line class="heading" x1="${sx}" y1="${sy}" x2="${sx}" y2="${tip + 6}"/>`, `<polygon class="heading-tip" points="${sx},${tip - 4} ${sx - 6},${tip + 8} ${sx + 6},${tip + 8}"/>`,
    `<circle id="sheet-start" class="start-dot" cx="${sx}" cy="${sy}" r="4.5"/>`,
    `<text class="mark-label" x="${sx + 14}" y="${sy + 16}">Start · face ahead</text>`);
  for (const b of m.boxes) {
    const [cx, cy] = [X(b.centre[1]), Y(b.centre[0])];
    out.push(`<g class="badge"><circle cx="${cx}" cy="${cy}" r="9"/><text x="${cx}" y="${cy + 4}" text-anchor="middle">${b.n}</text></g>`);
    if (b.overhead) out.push(`<text class="box-note" x="${cx}" y="${cy + 22}" text-anchor="middle">overhead · bottom ${fx(b.z_bottom)} m</text>`);
  }
  const barX = Math.round((W - S) / 2);
  out.push(`<rect id="sheet-scale" class="scale-bar" data-metres="1" x="${barX}" y="${H - 15}" width="${+S.toFixed(2)}" height="4"/>`,
    `<text class="g-caption" x="${barX + S + 6}" y="${H - 9}">1 m</text>`, '</svg>');
  return out.join('');
}

// ---------------------------------------------------------------- sections
function obstacleTable(m) {
  if (!m.boxes.length) return '<p class="tiny">No obstacles: open floor.</p>';
  const note = b => b.overhead ? 'overhead: not before H7' : b.noStep ? 'cannot step over' : `low (≤ ${fx(STEP_OVER_M)} m)`;
  return `<div class="table-wrap"><table class="data" id="sheet-obstacles"><thead><tr><th>#</th><th class="l">Type</th><th>Ahead m</th><th>Left m</th><th>Along m</th><th>Across m</th><th>Rotation °</th><th>Bottom–top m</th><th class="l">Note</th></tr></thead><tbody>
    ${m.boxes.map(b => `<tr data-box="${b.n}" class="${b.overhead ? 'flag' : ''}"><td>${b.n}</td><td class="l">${b.overhead ? 'overhead' : 'ground'}</td><td>${fx(b.centre[0])}</td><td>${fx(b.centre[1])}</td>
      <td>${fx(b.along)}</td><td>${fx(b.across)}</td><td>${fx(deg(b.yaw), 1)}</td><td>${fx(b.z_bottom)}–${fx(b.z_top)}</td><td class="l note">${note(b)}</td></tr>`).join('')}</tbody></table></div>
    <p class="tiny">Ahead, left: the obstacle's centre, measured from the start mark, <em>ahead</em> along the heading line, <em>left</em> at right angles (negative = right). <em>Along</em> is the side turned by <em>Rotation</em> from the heading line (counter-clockwise seen from above, toward the left; a half turn gives the same footprint, so −90° &lt; rotation ≤ 90°). <em>Across</em> is the other side. Heights above the floor.</p>`;
}

function goalSection(m) {
  const [a, l] = m.goal, warn = [];
  if (a < 0) warn.push('The goal is behind the start heading: the robot must turn around.');
  if (Math.max(Math.abs(a), Math.abs(l)) > MEMORY_HALF_M - 0.5) warn.push(`The goal is within 0.5 m of, or outside, the planner's ${2 * MEMORY_HALF_M} × ${2 * MEMORY_HALF_M} m memory (±${MEMORY_HALF_M} m around the start). Goals must lie inside it.`);
  return `<section class="keep" id="sheet-goal-section"><h2>Goal from the start mark ${chip('configured', 'Designed in the Studio arena; not measured on the floor.')}</h2>
    <p class="big" id="sheet-goal-text">${fx(a)} m ahead · ${sideText(l)}</p>
    <dl class="kv"><dt>Distance</dt><dd>${fx(m.distance)} m (straight line), ${bearingText(m.bearing)}</dd>
      <dt>Arrival</dt><dd>${fx(NODE_GOAL_RADIUS_M, 1)} m radius on the robot (<code>node.py --goal-radius</code> default; the console keeps it). Rehearsals score with their own criterion.</dd></dl>
    ${warn.map(w => `<div class="callout warning">${w}</div>`).join('')}</section>`;
}

// The console line, with no line break inside a flag or value.
function commandSection(m) {
  const [a, l] = m.goal;
  return `<section class="keep" id="sheet-command"><h2>Run on the robot · g1-student-deploy console</h2>
    <code class="console" id="sheet-console">${m.command.line.split(' ').map(t => `<span class="tok">${escape(t)}</span>`).join(' ')}</code>
    ${m.command.odom === 'zmq' ? `<div class="callout warning">The goal is ${fx(m.distance)} m away, beyond the ${LEG_ODOM_MAX_M} m that leg odometry is rated for, so the line uses <code>--odom zmq</code>. It needs Point-LIO on the robot's LiDAR topics and <code>ros2_lio_bridge.py</code> running (the bridge has not been tested on the robot).</div>` : ''}
    <ul class="notes"><li><code>--goal AHEAD LEFT</code> is relative to where the robot stands when the node starts (the console passes <code>--goal-frame start</code>); a negative left is to the right. Replace <code>eth0</code> with the deploy PC's wired interface; <code>mount.json</code> comes from <code>./g1 calibrate</code>.</li>
      <li><code>--odom leg</code> is for walks up to ${LEG_ODOM_MAX_M} m, <code>--odom zmq</code> (Point-LIO + bridge) for longer walks; a detour walks further than the straight line.</li>
      <li>Console (OPERATOR_GUIDE §4): <code>yes</code>, <code>s</code> (SONIC stands), <code>g</code> (walk). New target: <code>n</code>, "${fx(a)} ${fx(l)}", <code>g</code>. End: <code>t</code>, tighten the gantry, <code>o</code>, <code>q</code>.</li></ul></section>`;
}

function startSection(m) {
  return `<section class="keep" id="sheet-start-section"><h2>Start mark and heading</h2>
    <dl class="kv"><dt>Start mark</dt><dd>Origin of every measurement on this sheet. Stand the robot centred on it (pelvis over the mark).</dd>
      <dt>Heading</dt><dd>Face along the heading line ("ahead"). Studio heading ${fx(deg(m.yaw), 1)}° in the arena frame.</dd>
      <dt>Studio start</dt><dd>x ${fx(m.start[0])} m, y ${fx(m.start[1])} m (arena frame)</dd>
      <dt>Ladder step</dt><dd id="sheet-ladder">${m.ladder.step} · ${m.ladder.what} (HARDWARE.md §4)</dd></dl>
    <ul class="notes"><li>Tape a cross on the start mark and a heading line at least 1 m long from it, ahead.</li>
      <li>Measure <em>ahead</em> along the heading line and <em>left</em> at right angles to it, to the robot's left.</li></ul>
    ${m.overhead.length ? `<div class="callout warning" id="sheet-overhead-warning">${m.overhead.length} overhead obstacle${m.overhead.length > 1 ? 's' : ''} (#${m.overhead.map(b => b.n).join(', #')}): nothing overhead is allowed before ladder step H7, and remote D-up must not be used within about 1 m of anything overhead.</div>` : ''}</section>`;
}

function policyInfo(policies, id) { return policies?.find(p => p.id === id) ?? null; }
function conditionRows(rows, policies) {
  const groups = new Map();
  for (const r of rows) {
    const k = JSON.stringify([r.policy_id, r.criterion ?? 'arrive_hold', r.latency?.ms ?? 0, r.latency?.anchor ?? 'measured', r.planner?.candidates ?? null, r.planner?.ode_steps ?? null, r.actuators ?? 'source']);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.values()].map(list => {
    const r = list[0], p = policyInfo(policies, r.policy_id), g = report(list)[0] ?? null;
    const deployed = p?.planner?.deployed_budget;
    return { r, p, g, list, robot: p ? p.loader === 'deploy-bundle' : null,
      budget: `K${r.planner?.candidates ?? '—'}/ODE${r.planner?.ode_steps ?? '—'}${deployed && deployed.candidates === r.planner?.candidates && deployed.ode_steps === r.planner?.ode_steps ? ' (deployed)' : ''}`,
      latency: `${r.latency?.ms ?? 0} ms${r.latency?.anchor === 'predict' ? ' predict' : ''}` };
  });
}
const pct = (k, n) => n ? `${Math.round(100 * k / n)}%` : '—';
const ciText = ci => ci[0] === null ? '' : ` [${Math.round(100 * ci[0])}–${Math.round(100 * ci[1])}%]`;

function evidenceSection(m, matched, others, policies, runsError) {
  const head = `<h2>Rehearsal evidence · this arena and preset ${chip('sim-truth', 'CPU lockstep simulation outcomes from the source scorer.')}</h2>`;
  if (runsError) return `<section id="sheet-evidence">${head}<div class="callout warning">Rehearsal evidence unavailable: ${escape(runsError)}. This is not the same as "no rehearsal".</div></section>`;
  if (!matched.length) {
    return `<section id="sheet-evidence" class="keep">${head}<div class="callout warning" id="sheet-no-rehearsal">No rehearsal yet for this preset. Rehearse it in Studio (Rehearse → this arena and preset) before building the course.</div>
      ${others ? `<p class="tiny">${others} run${others > 1 ? 's' : ''} on other presets of this arena (not counted).</p>` : ''}</section>`;
  }
  const conds = conditionRows(matched, policies);
  const robotCovered = conds.some(c => c.robot && c.g?.n);
  const robotLatency = conds.some(c => c.robot && c.g?.n && (c.r.latency?.ms ?? 0) >= 160);
  const walked = median(matched.filter(r => r.outcome === 'goal_completion').map(r => pathLength(r.trajectory)));
  const unscored = matched.filter(r => !r.outcome && r.status !== 'failed').length;
  const latest = [...matched].sort((a, b) => (b.started_unix_s ?? 0) - (a.started_unix_s ?? 0)).slice(0, 8);
  const cats = g => Object.entries(g.cats).filter(([c]) => c !== 'goal').map(([c, k]) => `${escape(c.replaceAll('_', ' '))} ${k}`).join(', ') || 'none';
  return `<section id="sheet-evidence">${head}
    <div class="table-wrap"><table class="data" id="sheet-conditions"><thead><tr><th class="l">Policy</th><th class="l">Criterion</th><th>Latency</th><th>Budget</th><th class="l">Actuators</th><th>Goals (Wilson 95%)</th><th>Post-hoc reach</th><th class="l">Failures</th></tr></thead><tbody>
      ${conds.map(c => `<tr><td class="l"><span class="cond">${escape(c.p?.short_label ?? c.r.policy_id)}</span>${c.robot === true ? '<br><span class="tiny">robot console policy</span>' : c.robot === false ? '<br><span class="tiny">simulation only</span>' : ''}</td>
        <td class="l">${escape(CRITERION[c.r.criterion ?? 'arrive_hold'] ?? c.r.criterion)}</td><td>${escape(c.latency)}</td><td>${escape(c.budget)}</td><td class="l">${escape(ACTUATOR_SHORT[c.r.actuators ?? 'source'] ?? c.r.actuators)}</td>
        <td class="goals">${c.g ? `<strong>${c.g.goals}/${c.g.n}</strong> ${pct(c.g.goals, c.g.n)}${ciText(c.g.ci)}` : 'not scored yet'}</td><td>${c.g ? `${c.g.reach}/${c.g.n}${ciText(c.g.reachCi)}` : '—'}</td>
        <td class="l">${c.g ? cats(c.g) : '—'}${c.g?.errors ? ` · ${c.g.errors} worker error${c.g.errors > 1 ? 's' : ''} excluded` : ''}${c.g?.repeats ? ` · ${c.g.repeats} identical re-run${c.g.repeats > 1 ? 's' : ''} counted once` : ''}</td></tr>`).join('')}</tbody></table></div>
    ${robotCovered ? '' : `<div class="callout warning" id="sheet-no-robot-policy">${policies ? "No scored rehearsal of the robot console's policy (the frozen bundle, the LiDAR student) on this preset. Other profiles do not predict the real run." : 'Policy catalog unavailable: cannot tell which rehearsals used the robot console policy.'}</div>`}
    ${robotCovered && !robotLatency ? '<div class="callout neutral">The robot-policy rehearsals ran with under 160 ms planner latency. The deploy PC measured 0.16–0.18 s (HARDWARE.md §3); rehearse at 160 ms or more as well.</div>' : ''}
    <div class="table-wrap"><table class="data" id="sheet-runs"><thead><tr><th class="l">Run started</th><th class="l">Outcome</th><th class="l">Policy</th><th>Seed</th><th>Latency</th><th>Final m</th><th>Contact N</th><th>Sim time s</th></tr></thead><tbody>
      ${latest.map(r => `<tr><td class="l">${escape(stamp(r.started_unix_s))}</td><td class="l">${outcomeChip(r.outcome, r.status)}</td><td class="l">${escape(policyInfo(policies, r.policy_id)?.short_label ?? r.policy_id)}</td><td>${escape(r.seed ?? '—')}</td>
        <td>${escape(`${r.latency?.ms ?? 0}${r.latency?.anchor === 'predict' ? ' p' : ''}`)}</td><td>${fx(r.metrics?.final_goal_distance_m)}</td><td>${fx(r.metrics?.max_contact_n, 0)}</td><td>${fx(r.metrics?.elapsed_s, 1)}</td></tr>`).join('')}</tbody></table></div>
    <p class="tiny" id="sheet-evidence-summary">${matched.length} run${matched.length > 1 ? 's' : ''} of this preset${matched.length > latest.length ? ` (latest ${latest.length} listed)` : ''}${unscored ? ` · ${unscored} not scored (running, cancelled or killed)` : ''}${others ? ` · ${others} on other presets (not counted)` : ''}${finite(walked) ? ` · median walked length of goal runs ${fx(walked)} m (simulator ground truth)` : ''}.
      Rates are over distinct scenarios; worker errors are not policy failures. CPU lockstep simulation of one robot model: not a hardware success rate.</p></section>`;
}

function checklist(m) {
  return `<section class="keep" id="sheet-checklist"><h2>Go / no-go (OPERATOR_GUIDE §3–4, HARDWARE.md §3–5)</h2><ul class="checklist">
    <li><span>LiDAR mount calibrated on open floor: <code>./g1 calibrate --iface eth0 --out mount.json --png coverage.png</code>; floor within 0.5°, |z| &lt; 1 cm; no blocked sector ahead in <code>coverage.png</code>.</span></li>
    <li><span><code>./g1 check --iface eth0 --perception</code> passes: 500 Hz lowstate, 10 Hz LiDAR, no returns on the robot, floor at 0.</span></li>
    <li><span>Earlier ladder steps passed: this course is ${m.ladder.step} (${m.ladder.what}); H5 is open floor with a 2–3 m goal.</span></li>
    <li><span>Gantry or spotter. Slacken the gantry only after SONIC stands (<code>s</code> / remote Start).</span></li>
    <li><span>Remote in hand: D-up → SONIC stands (not within about 1 m of anything overhead); Select → damping, the robot drops into the gantry. Physical E-stop within reach.</span></li>
    <li><span>Nothing overhead before H7${m.overhead.length ? ` <strong>(this course has ${m.overhead.length})</strong>` : ''}.</span></li>
    <li><span>Nobody within 2 m of the robot's path. The remote operator watches the robot, the console operator the screen; any surprise → Select.</span></li>
    <li><span>Course built to this sheet. Measured placement error at the start mark: ahead <span class="blank"></span> cm, left <span class="blank"></span> cm, heading <span class="blank"></span> °.</span></li></ul></section>`;
}

// ---------------------------------------------------------------- page
function fail(message, map) {
  const root = document.getElementById('sheet-root');
  const links = map?.presets?.length ? `<p class="tiny">Presets of this arena: ${map.presets.map((q, i) => `<a href="${escape(sheetUrl(map.id, i))}">${i} · ${escape(q.label)}</a>`).join(' · ')}</p>` : '';
  root.innerHTML = `<div class="callout warning" id="sheet-error">${escape(message)}</div>${links}<p class="tiny">Open a build sheet from Arena → <strong>Build sheet</strong> on a saved arena, or use <code>/sheet.html?arena=&lt;map id&gt;&amp;preset=&lt;index&gt;</code>.</p>`;
  document.body.dataset.state = 'error';
}
export const sheetUrl = (id, index) => `/sheet.html?arena=${encodeURIComponent(id)}&preset=${encodeURIComponent(index)}`;

async function main() {
  const params = new URLSearchParams(location.search);
  const id = params.get('arena'), presetParam = params.get('preset') ?? '0';
  if (!id) return fail('No arena selected.');
  let map;
  try { map = await request(`/api/map?id=${encodeURIComponent(id)}`); } catch (error) { return fail(`Arena ${id} could not be loaded: ${error.message}`); }
  if (map.kind !== 'boxes' || map.frame_id !== 'world' || map.units !== 'm') return fail(`${map.label ?? id} is not a box arena in world metres; only box arenas have a build sheet.`);
  if (!map.presets?.length) return fail(`${map.label} has no start/goal preset. Add one in the arena editor and save the arena.`);
  const index = /^\d+$/.test(presetParam) ? Number(presetParam) : NaN;
  if (!(index >= 0 && index < map.presets.length)) return fail(`Preset ${presetParam} does not exist in ${map.label} (it has ${map.presets.length}).`, map);
  const [runsResult, policiesResult, versionResult] = await Promise.allSettled([request('/api/runs'), request('/api/policies'), request('/api/version')]);
  const m = sheetModel(map, index), q = m.preset;
  const rows = runsResult.status === 'fulfilled' ? runsResult.value.runs ?? [] : [];
  const matched = matchRuns(rows, map, q), others = rows.filter(r => r.map_id === map.id).length - matched.length;
  const policies = policiesResult.status === 'fulfilled' ? policiesResult.value.policies : null;
  const version = versionResult.status === 'fulfilled' ? versionResult.value : null;
  const paths = matched.filter(r => r.trajectory?.length > 1).slice(0, 16);
  const now = new Date(), today = stamp(now.getTime() / 1000);
  document.title = `Build sheet · ${map.label} · ${q.label}`;
  const picker = document.getElementById('sheet-preset');
  picker.innerHTML = map.presets.map((x, i) => `<option value="${i}" ${i === index ? 'selected' : ''}>${i} · ${escape(x.label)}</option>`).join('');
  picker.addEventListener('change', () => location.assign(sheetUrl(map.id, picker.value)));
  document.getElementById('sheet-preset-picker').hidden = map.presets.length < 2;
  document.getElementById('sheet-root').innerHTML = `
    <header class="sheet-head"><span class="eyebrow">G1 Deploy Studio · course build sheet</span>
      <h1 id="sheet-title">${escape(map.label)}</h1>
      <div class="sub">Preset ${index}: <strong id="sheet-preset-label">${escape(q.label)}</strong> · printed ${escape(today)}</div>
      <div class="not-cert" id="sheet-not-cert">Simulation-designed course · not a hardware certification</div></header>
    <section class="keep"><h2>Plan from the start mark ${chip('configured', 'Arena geometry as designed in Studio.')}</h2>${planSvg(m, paths)}
      <div class="legend"><span><i class="lg-start"></i>start mark, heading arrow = ahead</span><span><i class="lg-ground"></i>ground obstacle (numbered)</span><span><i class="lg-over"></i>overhead obstacle, bottom height shown</span><span><i class="lg-goal"></i>goal, ${fx(NODE_GOAL_RADIUS_M, 1)} m arrival radius</span>${paths.length ? `<span><i class="lg-path"></i>${paths.length} rehearsed path${paths.length > 1 ? 's' : ''} (simulator ground truth)</span>` : ''}<span>grid 0.5 m · labels in metres</span></div></section>
    <div class="two-col row-gap">${goalSection(m)}${startSection(m)}</div>
    ${commandSection(m)}
    <section id="sheet-obstacle-section" class="${m.boxes.length <= 24 ? 'keep' : ''}"><h2>Obstacles · ${m.boxes.length} ${chip('configured', 'Designed geometry; place and measure each one on the floor.')}</h2>${obstacleTable(m)}</section>
    ${evidenceSection(m, matched, others, policies, runsResult.status === 'rejected' ? runsResult.reason?.message ?? 'request failed' : null)}
    ${checklist(m)}
    <p class="sheet-foot" id="sheet-provenance">Arena <code>${escape(map.id)}</code> · sha256 ${escape(String(map.sha256 ?? '—').slice(0, 16))} · saved ${escape(stamp(map.provenance?.created_unix_s))}${map.provenance?.base_map_id ? ` · from ${escape(map.provenance.base_map_id)}` : ''} · Studio ${escape(version?.commit ? version.commit.slice(0, 7) : 'build unknown')}${version?.dirty ? ' (modified tree)' : ''}.
      Start-mark frame: p = R(−θ₀)·(p<sub>arena</sub> − s₀), θ₀ = ${fx(deg(m.yaw), 1)}°, s₀ = (${fx(m.start[0])}, ${fx(m.start[1])}) m; rotations are relative to θ₀.
      Studio does not connect to the robot; this sheet is a plan for an operator-run test under the g1-student-deploy procedure. Simulation-designed course · not a hardware certification.</p>`;
  const print = document.getElementById('sheet-print');
  print.disabled = false;
  print.addEventListener('click', () => window.print());
  document.body.dataset.state = 'ready';
}

main().catch(error => fail(`Build sheet failed: ${error.message}`));
