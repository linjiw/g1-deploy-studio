// A day with the real robot: the operator workflow (docs/NAVIGATE.md, real robot) with the robot link's pre-Go
// checklist (studio/robot_link.py _ready) and its refusals (_can). The robot is a recorded simulated walk, drawn as
// the LIO pose Studio shows for a real robot.
import { $, escape, fmt } from './util.js';
import { json, walkJson, decodeWorld, Walk } from './data.js';

const WORLD = 'detour';
const MAX_GOAL_M = 3.0;      // robot_link limits.max_goal_distance_m default
const FAULTS = {
  leg: { label: 'Node started on leg odometry', note: "The console's default --odom leg instead of --odom zmq" },
  sway: { label: 'Robot still swaying', note: 'Just stood up; LIO reads it moving' },
  lio: { label: 'LIO bridge stopped', note: 'No odometry for 2 s' },
  console: { label: 'Goal typed on the console', note: "Someone pressed n on the node's console" },
  ceiling: { label: 'Stand deferred after a walk', note: "The node will not stand: a low 'ceiling' in its map" },
};
const STEPS = [
  { id: 'build', title: 'Build the course', sub: 'from a start mark' },
  { id: 'start', title: 'Start the stack', sub: 'on the deploy PC' },
  { id: 'connect', title: 'Connect Studio', sub: 'see what it sees' },
  { id: 'goal', title: 'Pick and send a goal', sub: 'checked, read back' },
  { id: 'go', title: 'The operator presses g', sub: 'only a person starts a walk' },
  { id: 'review', title: 'Watch and review', sub: 'replay, twin' },
];
const ICON = { pass: '✓', warn: '!', block: '✕' };

export async function initRobotDay(root) {
  const world = decodeWorld(await json(`data/${WORLD}/index.json`));
  const cells = world.cells.filter(c => c.walk && c.walk.outcome === 'arrived' && (c.walk.max_contact_n ?? 0) <= 100);
  const near = cells.filter(c => Math.hypot(c.xy[0] - world.start_xy[0], c.xy[1] - world.start_xy[1]) <= MAX_GOAL_M);
  const suggest = near.slice().sort((a, b) => Math.abs(Math.hypot(...a.xy) - 2.4) - Math.abs(Math.hypot(...b.xy) - 2.4))[0] ?? null;
  const D = { step: 0, faults: new Set(), goal: null, sent: null, walk: null, t: 0, playing: false, last: null, message: null, visible: true, looping: false };
  root.innerHTML = `
    <ol class="steps" id="day-steps">${STEPS.map((s, i) => `<li><button data-step="${i}"><b>${escape(s.title)}</b><span>${escape(s.sub)}</span></button></li>`).join('')}</ol>
    <div class="day-main">
      <div class="day-view"><canvas id="day-canvas" role="img" aria-label="Top view of what Studio shows for a real robot"></canvas><span class="tag" id="day-tag">STUDIO · REAL ROBOT</span></div>
      <div class="card step-text" id="day-text" aria-live="polite"></div>
    </div>
    <aside class="card" id="day-side" aria-label="Pre-Go checklist">
      <div class="ready-head"><h3>Before <kbd>g</kbd> on the console</h3><span id="day-verdict" class="verdict" aria-live="polite"></span></div>
      <ul class="ready" id="day-ready"></ul>
      <div class="faults"><h3 style="margin-top:14px">Break something</h3>
        ${Object.entries(FAULTS).map(([id, f]) => `<label class="switch"><input type="checkbox" data-fault="${id}"><span>${escape(f.label)}<small>${escape(f.note)}</small></span></label>`).join('')}
      </div>
    </aside>`;
  const canvas = $('day-canvas'), ctx = canvas.getContext('2d');
  const phaseAt = () => D.walk ? D.walk.phase(D.t) : 'WAIT';
  const walking = () => !!D.walk && D.t < D.walk.duration && !['ARRIVED', 'STOPPED'].includes(phaseAt());
  const motion = () => {  // LIO-level speed from the recorded estimate, as the robot link measures stillness
    if (!D.walk) return { v: 0, w: 0 };
    const k = D.walk.index(D.t), j = Math.max(0, k - 5), e = D.walk.est, dt = (D.walk.times[k] - D.walk.times[j]) || 1;
    return { v: Math.hypot(e[k * 2] - e[j * 2], e[k * 2 + 1] - e[j * 2 + 1]) / 1000 / dt, w: 0 };
  };

  // ----- the checklist, as robot_link._ready words it
  const ready = () => {
    const f = D.faults, items = [];
    const add = (label, status, detail) => items.push({ label, status, detail });
    add('Node status fresh', 'pass', '0.21 s old (limit 1.5 s)');
    if (f.has('lio')) add('LIO odometry fresh', 'block', 'odometry is 2.1 s old (limit 0.1 s)');
    else add('LIO odometry fresh', 'pass', '0.02 s old (limit 0.1 s)');
    if (f.has('lio')) add('Node frame matches LIO', 'block', 'node frame not compared yet: needs fresh node status and LIO odometry');
    else if (f.has('leg')) add('Node frame matches LIO', 'block', "the node's odometry is not the LIO bridge's: node status xy (0.31, -0.12) is 0.33 m from the LIO pose (0.00, 0.00) (limit 0.10 m); start the node with --odom zmq on the bridge's odometry");
    else add('Node frame matches LIO', 'pass', 'node status xy is 1.2 cm from the LIO pose (limit 10 cm)');
    const m = motion();
    if (f.has('lio')) add('Robot still', 'block', 'robot stillness unknown: odometry is stale');
    else if (walking()) add('Robot still', 'block', `the robot is moving (${fmt(m.v)} m/s; still means below 0.05 m/s and 0.05 rad/s)`);
    else if (f.has('sway')) add('Robot still', 'block', 'the robot is moving (0.08 m/s, 0.11 rad/s; still means below 0.05 m/s and 0.05 rad/s)');
    else add('Robot still', 'pass', 'still for 2.4 s (0.004 m/s, 0.006 rad/s)');
    const g = f.has('console') ? [1.8, 0.4] : D.sent?.xy;
    if (!g) add('Node goal verified', 'block', 'the node reports no goal');
    else if (f.has('console')) add('Node goal verified', 'block', `UNVERIFIED goal (${fmt(g[0])}, ${fmt(g[1])}): set on the console, not by Studio. Do not press g; stage a new goal`);
    else add('Node goal verified', 'pass', `(${fmt(g[0])}, ${fmt(g[1])}): read back from the node within 5 cm of what Studio sent`);
    const label = `Goal inside the memory and within ${MAX_GOAL_M.toFixed(1)} m`;
    if (!g || f.has('lio')) add(label, 'block', "unknown: needs the node's goal, fresh odometry and the memory centre");
    else {
      const d = Math.hypot(g[0] - world.start_xy[0], g[1] - world.start_xy[1]);
      add(label, d <= MAX_GOAL_M ? 'pass' : 'block', d <= MAX_GOAL_M ? `${fmt(d)} m from the robot; inside the assumed memory (±6 m around (0.00, 0.00))` : `${fmt(d)} m from the robot: beyond the ${MAX_GOAL_M.toFixed(1)} m limit`);
    }
    if (f.has('ceiling')) add('Stand not deferred', 'block', "inferred from node status: the node is deferring its stand (a low ceiling near the robot): the robot holds the plan's last pose until it is clear. Take over with the remote's D-up only if nothing is directly above the robot");
    else if (walking()) add('Stand not deferred', 'warn', `the robot is walking (node phase ${phaseAt()})`);
    else add('Stand not deferred', 'pass', D.walk ? `node phase ${phaseAt()}, standing = true` : 'node phase WAIT (no stand pending)');
    return items;
  };
  // robot_link._can: a goal is sent only while the robot stands, still, in the LIO frame.
  const canSend = () => {
    const f = D.faults;
    if (walking()) return 'Refused: a goal can be sent only while the robot stands';
    if (f.has('ceiling')) return 'Refused: the robot is not standing (its stand is deferred)';
    if (f.has('lio')) return 'Refused: odometry is stale, so Studio cannot tell whether the robot is still';
    if (f.has('leg')) return "Refused: the node's position is not LIO's (start the node with --odom zmq)";
    if (f.has('sway')) return 'Refused: the robot must read still on LIO for 0.5 s before a goal is sent';
    return null;
  };

  // ----- drawing: a top view of what Studio shows on a real robot (no ground truth: the LIO pose and the map)
  const view = { scale: 60, ox: 0, oy: 0, w: 0, h: 0 };
  const fit = () => {
    const r = canvas.getBoundingClientRect(), dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (!r.width) return;
    canvas.width = Math.round(r.width * dpr); canvas.height = Math.round(r.height * dpr);
    const b = world.bounds, pad = 0.4;
    view.w = r.width; view.h = r.height;
    view.scale = Math.min(r.width / (b.max[0] - b.min[0] + pad * 2), r.height / (b.max[1] - b.min[1] + pad * 2));
    view.ox = r.width / 2 - (b.min[0] + b.max[0]) / 2 * view.scale; view.oy = r.height / 2 + (b.min[1] + b.max[1]) / 2 * view.scale;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    draw();
  };
  const sx = x => view.ox + x * view.scale, sy = y => view.oy - y * view.scale;
  const toWorld = (px, py) => [(px - view.ox) / view.scale, (view.oy - py) / view.scale];
  const mapCanvas = document.createElement('canvas');
  const RGBA = { 1: [38, 92, 96, 160], 2: [239, 187, 112, 220], 3: [240, 120, 112, 240], 4: [196, 160, 217, 220] };
  const paintMap = codes => {
    const n = world.map.n; mapCanvas.width = n; mapCanvas.height = n;
    const mctx = mapCanvas.getContext('2d'), img = mctx.createImageData(n, n);
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
      const c = RGBA[codes[i * n + j]], k = ((n - 1 - j) * n + i) * 4;
      if (!c) continue;
      img.data[k] = c[0]; img.data[k + 1] = c[1]; img.data[k + 2] = c[2]; img.data[k + 3] = c[3];
    }
    mctx.putImageData(img, 0, 0);
  };
  const map = { codes: null, step: -1 };
  const resetMap = () => { map.codes = world.map.codes.slice(); map.step = -1; paintMap(map.codes); };
  resetMap();
  const applyMap = () => {
    if (!D.walk) return;
    let changed = false;
    if (map.step >= 0 && D.walk.map[map.step].t > D.t) { map.codes = world.map.codes.slice(); map.step = -1; changed = true; }
    while (map.step + 1 < D.walk.map.length && D.walk.map[map.step + 1].t <= D.t) {
      const s = D.walk.map[++map.step]; let idx = 0;
      for (let k = 0; k < s.g.length; k++) { idx += s.g[k]; const v = s.v[k]; map.codes[idx] = v >= 1000 ? Math.floor(v / 1000) : v; }
      changed = true;
    }
    if (changed) paintMap(map.codes);
  };
  const line = (pts, color, width, dash = []) => {
    if (pts.length < 2) return;
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.setLineDash(dash); ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(sx(x), sy(y)) : ctx.moveTo(sx(x), sy(y))));
    ctx.stroke(); ctx.setLineDash([]);
  };
  const draw = () => {
    if (!view.w) return;
    const step = STEPS[D.step].id, b = world.bounds;
    ctx.fillStyle = '#0b1117'; ctx.fillRect(0, 0, view.w, view.h);
    ctx.strokeStyle = '#18242c'; ctx.lineWidth = 1;
    for (let x = Math.ceil(b.min[0]); x <= b.max[0]; x++) { ctx.beginPath(); ctx.moveTo(sx(x), sy(b.min[1])); ctx.lineTo(sx(x), sy(b.max[1])); ctx.stroke(); }
    for (let y = Math.ceil(b.min[1]); y <= b.max[1]; y++) { ctx.beginPath(); ctx.moveTo(sx(b.min[0]), sy(y)); ctx.lineTo(sx(b.max[0]), sy(y)); ctx.stroke(); }
    if (step === 'build' || step === 'start') {
      for (const box of world.boxes) drawBox(box);
      ctx.fillStyle = '#9aaeba'; ctx.font = '12px ui-monospace, monospace';
      for (const box of world.boxes) {
        const text = `${fmt(box.center_xy[0], 2)}, ${fmt(box.center_xy[1], 2)} m · ${fmt(box.z_top, 2)} m tall`;
        const x = Math.min(sx(box.center_xy[0]) + 10, view.w - ctx.measureText(text).width - 8);
        ctx.fillText(text, x, sy(box.center_xy[1]) - 6);
      }
    } else {
      const n = world.map.n, res = world.map.res_m, lo = world.map.lo;
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(mapCanvas, sx(lo[0] - res / 2), sy(lo[1] + (n - 0.5) * res), n * res * view.scale, n * res * view.scale);
      ctx.strokeStyle = 'rgba(86,217,208,.35)'; ctx.setLineDash([6, 6]);
      ctx.strokeRect(sx(-6), sy(6), 12 * view.scale, 12 * view.scale); ctx.setLineDash([]);
      ctx.strokeStyle = 'rgba(239,187,112,.4)'; ctx.beginPath(); ctx.arc(sx(world.start_xy[0]), sy(world.start_xy[1]), MAX_GOAL_M * view.scale, 0, Math.PI * 2); ctx.stroke();
      const lidar = D.walk ? D.walk.lidarAt(D.t) : world.start_lidar;
      if (lidar) { ctx.fillStyle = 'rgba(160,230,220,.75)'; for (let k = 0; k < lidar.p.length; k += 3) ctx.fillRect(sx(lidar.p[k] / 100) - 1, sy(lidar.p[k + 1] / 100) - 1, 2, 2); }
    }
    drawStart();
    const goal = D.sent?.xy ?? D.goal?.xy;
    if (D.goal && !D.sent && D.goal.path?.length) {
      const pts = []; for (let k = 0; k + 1 < D.goal.path.length; k += 2) pts.push([D.goal.path[k], D.goal.path[k + 1]]);
      line(pts, 'rgba(230,238,242,.75)', 1.5, [5, 5]);
    }
    if (goal) {
      ctx.strokeStyle = D.sent ? '#56d9d0' : '#efbb70'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(sx(goal[0]), sy(goal[1]), 0.4 * view.scale, 0, Math.PI * 2); ctx.stroke();
      ctx.fillStyle = ctx.strokeStyle; ctx.beginPath(); ctx.arc(sx(goal[0]), sy(goal[1]), 4, 0, Math.PI * 2); ctx.fill();
    }
    if (D.walk) {
      const k = D.walk.index(D.t), pts = [];
      for (let i = 0; i <= k; i++) pts.push([D.walk.est[i * 2] / 1000, D.walk.est[i * 2 + 1] / 1000]);
      line(pts, '#56d9d0', 2.5);
      const plan = phaseAt() === 'RUN' ? D.walk.plan(D.t) : null;
      if (plan) line(plan.points, '#ff6fb5', 3);
    }
    drawRobot();
  };
  const drawBox = b => {
    ctx.save(); ctx.translate(sx(b.center_xy[0]), sy(b.center_xy[1])); ctx.rotate(-(b.yaw ?? 0));
    ctx.fillStyle = 'rgba(143,164,179,.25)'; ctx.strokeStyle = '#8fa4b3'; ctx.lineWidth = 1.5;
    const w = b.half_xy[0] * 2 * view.scale, h = b.half_xy[1] * 2 * view.scale;
    ctx.fillRect(-w / 2, -h / 2, w, h); ctx.strokeRect(-w / 2, -h / 2, w, h);
    ctx.restore();
  };
  const drawStart = () => {
    const [x, y] = world.start_xy; ctx.strokeStyle = '#e6eef2'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(sx(x) - 10, sy(y)); ctx.lineTo(sx(x) + 10, sy(y)); ctx.moveTo(sx(x), sy(y) - 10); ctx.lineTo(sx(x), sy(y) + 10); ctx.stroke();
  };
  const drawRobot = () => {
    let x = world.start_xy[0], y = world.start_xy[1], yaw = world.start_yaw_rad;
    if (D.walk) {
      const k = D.walk.index(D.t), q = D.walk.pose(D.t);
      x = D.walk.est[k * 2] / 1000; y = D.walk.est[k * 2 + 1] / 1000;
      yaw = Math.atan2(2 * (q[3] * q[6] + q[4] * q[5]), 1 - 2 * (q[5] * q[5] + q[6] * q[6]));
    }
    ctx.save(); ctx.translate(sx(x), sy(y)); ctx.rotate(-yaw);
    ctx.fillStyle = '#7fb4ff'; ctx.strokeStyle = '#0b1117'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-9, 9); ctx.lineTo(-5, 0); ctx.lineTo(-9, -9); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.restore();
    if (STEPS[D.step].id !== 'build' && STEPS[D.step].id !== 'start') { ctx.fillStyle = '#7fb4ff'; ctx.font = '600 11px ui-monospace, monospace'; ctx.fillText('LIO ESTIMATE', Math.min(sx(x) + 14, view.w - 90), sy(y) + 22); }
  };

  // ----- text per step
  const TEXT = {
    build: () => `<h3>Build the course from a start mark</h3><p>Pick an arena in Studio and print its build sheet: every box as a measured offset from a start mark taped on the floor, the heading arrow, and the exact console command. Studio rehearses the same course in simulation first.</p><p class="muted">Here: the wall-detour room, one 1.8 m high wall about 1.8 m ahead of the start.</p>`,
    start: () => `<h3>Start the stack on the deploy PC</h3><p>Under the operator procedure: gantry or spotter, the remote in hand, the physical E-stop within reach.</p>
<pre class="term"><span class="c"># the LiDAR mount and the streams</span>
<span class="p">$</span> ./g1 calibrate &amp;&amp; ./g1 check
<span class="c"># Point-LIO odometry on ZMQ :5561, with the registered cloud for Studio (bridge untested: no ROS 2 on the dev machine)</span>
<span class="p">$</span> python g1deploy/adapters/ros2_lio_bridge.py --forward-cloud
<span class="c"># the SONIC runner and node.py, planning on LIO odometry</span>
<span class="p">$</span> ./g1 robot --iface eth0 --goal 2 0 <b>--odom zmq</b>
<span class="c"># Studio, on loopback; the laptop connects through SSH</span>
<span class="p">$</span> .venv/bin/python -m studio.server --port 8790
<span class="p">laptop$</span> ssh -N -L 8790:127.0.0.1:8790 you@deploy-pc</pre>
<p class="muted">Studio refuses goals when the node runs on the console's default <code>--odom leg</code>: its frame would not be the one Studio draws. The node and the bridge bind every interface today, so keep the robot network firewalled.</p>`,
    connect: () => `<h3>Connect: see what the robot sees</h3><p>Navigate → Real robot → Connect. Studio subscribes on loopback and shows the LIO pose (labelled as an estimate: a real robot has no ground truth), the LiDAR, its reconstruction of the map within the planner's 12 × 12 m memory (dashed) and each stream's age. A stale stream shows as stale, never as zero.</p><p>The checklist on the right is live from here on. Try the switches.</p>`,
    goal: () => {
      const refusal = canSend(), g = D.goal;
      return `<h3>Pick a goal and send it</h3><p>Click the map, or use the suggestion. On a robot Studio checks the goal on its reconstruction of the LIO cloud (the planner's own memory is not published yet): inside the memory, seen, free, room to stand, a route, and within ${MAX_GOAL_M} m for the first walks. Send converts it to the node's <code>{"cmd": "goal", "ahead": …, "left": …}</code>, only while the robot has been still for 0.5 s and the node's position matches LIO, then reads it back.</p>
        ${g ? `<p><b>Goal ${fmt(g.xy[0])}, ${fmt(g.xy[1])} m</b> · ${fmt(Math.hypot(g.xy[0], g.xy[1]))} m away</p>` : '<p class="muted">No goal picked yet.</p>'}
        <div class="actions">${suggest && !g ? `<button class="button" id="day-suggest">Use the suggested goal (${fmt(suggest.xy[0], 1)}, ${fmt(suggest.xy[1], 1)})</button>` : ''}<button class="button primary" id="day-send" ${g && !D.sent ? '' : 'disabled'}>Send goal</button>${D.sent ? '<span class="verdict pass">Sent and read back: verified</span>' : ''}</div>
        ${D.message ? `<p class="verdict block" style="margin-top:8px">${escape(D.message)}</p>` : refusal && g && !D.sent ? `<p class="muted" style="margin-top:8px">${escape(refusal)}</p>` : ''}`;
    },
    go: () => {
      const ok = !ready().some(i => i.status === 'block');
      return `<h3>Only a person starts a walk</h3><p>Studio never sends Go. The operator reads the checklist and presses <kbd>g</kbd> on the node's console (or F1 on the remote). Nothing in software stops a person pressing it anyway, so the list is written to be read.</p>
        <div class="keys"><button class="keycap ${ok ? 'armed' : ''}" id="day-g" aria-label="Press g">g</button><span class="${ok ? 'verdict pass' : 'verdict block'}">${ok ? 'Checklist clear: press g' : 'Checklist blocked: do not press g'}</span></div>
        ${D.message ? `<p class="verdict block" style="margin-top:8px">${escape(D.message)}</p>` : ''}`;
    },
    review: () => `<h3>Watch, then review</h3><p>While it walks: the plan (pink), the path, distance to the goal, plan age and planner latency against the 160 ms budget, tilt against the 0.75 rad E-stop. Stand asks the node to settle; the remote's D-up and the E-stop stay with people.</p><p>Afterwards the session opens in Replay next to its simulated rehearsal, and <b>Make an arena twin</b> turns the robot's map into a simulation arena to rehearse the next walk on.</p>
      <div class="actions"><button class="button" id="day-replay" ${D.walk ? '' : 'disabled'}>Replay the walk</button><a class="button ghost" href="#try">Try more goals above</a></div>`,
  };

  // Rebuild only what changed, and give focus back to the control that had it (keyboard users keep their place).
  let lastText = '', lastReady = '';
  const render = () => {
    const focused = document.activeElement?.id;
    for (const b of root.querySelectorAll('[data-step]')) {
      const i = Number(b.dataset.step);
      if (i === D.step) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
      b.classList.toggle('done', i < D.step);
    }
    const text = TEXT[STEPS[D.step].id]();
    if (text !== lastText) { $('day-text').innerHTML = text; lastText = text; }
    renderReady();
    $('day-tag').textContent = STEPS[D.step].id === 'build' || STEPS[D.step].id === 'start' ? 'THE ROOM · BUILD SHEET' : 'STUDIO · REAL ROBOT · LIO ESTIMATE';
    canvas.setAttribute('aria-label', D.walk ? `Top view: the robot's LIO estimate walking to the goal, ${fmt(D.t, 1)} of ${fmt(D.walk.duration, 1)} s` : 'Top view of what Studio shows for a real robot');
    if (focused && document.activeElement?.id !== focused) $(focused)?.focus({ preventScroll: true });
    draw();
  };
  const renderReady = () => {
    const items = ready(), ok = !items.some(i => i.status === 'block'), live = D.step >= 2;
    const html = items.map(i => `<li class="${live ? i.status : 'idle'}"><span class="icon">${live ? ICON[i.status] : '·'}</span><span>${escape(i.label)}<small>${escape(live ? i.detail : 'not connected yet')}</small></span></li>`).join('');
    if (html !== lastReady) { $('day-ready').innerHTML = html; lastReady = html; }
    $('day-verdict').className = `verdict ${live ? (ok ? 'pass' : 'block') : 'idle'}`;
    $('day-verdict').textContent = live ? (ok ? 'Clear' : 'Do not press g') : 'Not connected';
  };
  const choose = cell => {
    const dist = Math.hypot(cell.xy[0] - world.start_xy[0], cell.xy[1] - world.start_xy[1]);
    D.step = 3; D.sent = null; D.walk = null; D.t = 0; D.playing = false;
    resetMap();
    D.goal = dist > MAX_GOAL_M ? null : cell;
    D.message = dist > MAX_GOAL_M ? `Refused: ${fmt(dist)} m from the robot, beyond the ${MAX_GOAL_M} m test distance (robot_link limits.max_goal_distance_m)` : null;
    render();
  };

  root.addEventListener('click', async e => {
    const step = e.target.closest('[data-step]');
    if (step) { D.step = Number(step.dataset.step); D.message = null; render(); return; }
    const id = e.target.id;
    if (id === 'day-suggest' && suggest) { choose(suggest); $('day-send')?.focus({ preventScroll: true }); return; }
    if (id === 'day-send') {
      const refusal = canSend();
      if (refusal) { D.message = refusal; render(); return; }
      D.sent = D.goal; D.message = null; D.step = 4; render(); $('day-g')?.focus({ preventScroll: true }); return;
    }
    if (id === 'day-g') {
      if (ready().some(i => i.status === 'block')) { D.message = 'In this demo g is refused while the checklist blocks. On the robot nothing would stop it: that is why the operator reads the list.'; render(); return; }
      D.message = null;
      D.walk = new Walk(await walkJson(`data/${WORLD}/g/${D.sent.id}.json`));
      resetMap();
      D.t = 0; D.step = 5; render(); $('day-replay')?.focus({ preventScroll: true }); play(); return;
    }
    if (id === 'day-replay' && D.walk) { D.t = 0; resetMap(); play(); }
  });
  root.addEventListener('change', e => {
    const f = e.target.dataset.fault;
    if (!f) return;
    if (e.target.checked) D.faults.add(f); else D.faults.delete(f);
    D.message = null; render();
  });
  canvas.addEventListener('click', e => {
    if (!['goal', 'connect'].includes(STEPS[D.step].id) || walking()) return;
    const r = canvas.getBoundingClientRect(), xy = toWorld(e.clientX - r.left, e.clientY - r.top);
    let best = null, bestD = 0.45;
    for (const c of cells) { const d = Math.hypot(c.xy[0] - xy[0], c.xy[1] - xy[1]); if (d < bestD) { best = c; bestD = d; } }
    if (best) choose(best);
  });

  // ----- one playback loop, only while visible
  const play = () => { D.playing = true; D.last = null; if (!D.looping && D.visible) { D.looping = true; requestAnimationFrame(tick); } };
  let uiAt = 0;
  const tick = now => {
    if (!D.playing || !D.walk || !D.visible) { D.looping = false; return; }
    if (D.last !== null && now - D.last < 250) D.t = Math.min(D.walk.duration, D.t + (now - D.last) / 1000);
    D.last = now;
    applyMap();
    draw();
    if (D.t >= D.walk.duration) { D.playing = false; D.looping = false; render(); return; }
    if (now - uiAt > 250) { uiAt = now; renderReady(); }
    requestAnimationFrame(tick);
  };
  new IntersectionObserver(entries => { D.visible = entries[0].isIntersecting; if (D.visible && D.playing) play(); }, { threshold: 0.01 }).observe(canvas);
  new ResizeObserver(fit).observe(canvas);
  render();
}
