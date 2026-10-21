// Data for tools/video/deck.html. Every number is copied from committed evidence:
// docs/ROBUSTNESS.md (campaign, Addenda A/B), docs/REVALIDATION.md, docs/ROBOT_CONTRACT.md.
window.DECK_DATA = {
  ladder: [
    ['L0', 'Replay', 'recorded sessions, decoded independently', 'done'],
    ['L1', 'CPU lockstep', 'physics waits for each plan · Flow + SONIC ONNX + MuJoCo', 'done'],
    ['L2', 'Planner latency', 'physics keeps running while the plan computes', 'done'],
    ['L3', 'Real-time chain', 'separate processes over DDS + ZMQ, isolated namespace — ready', 'next'],
    ['M5', 'Robot link', 'observe + stage goals · the operator keeps Go · fixture-tested', 'later'],
  ],
  chapters: [
    ['ch-tour', '03', 'The cockpit, workspace by workspace', 'Replay · Inspector · Sensors · System · Arena · Rehearse · Runs'],
    ['ch-results', '04', 'What the rehearsals showed', 'Random goals · latency · torque limits · the real-time chain'],
    ['ch-navigate', '05', 'Deploying to a real room', "Goals on the robot's own map · scan to twin · build sheet · the robot link"],
  ],
  results: {
    headline: [
      { label: 'WX-RF · seed 0 · 4 arenas', k: 24, n: 24, lo: 0.862, hi: 1.0, color: '#56d9d0' },
      { label: 'WX-RF · incl. seeds 1–2', k: 35, n: 36, lo: 0.858, hi: 0.995, color: '#56d9d0' },
      { label: 'Frozen bundle · same 24', k: 19, n: 24, lo: 0.595, hi: 0.908, color: '#8794a6' },
      { label: 'Goals behind obstacles · WX', k: 6, n: 6, lo: 0.61, hi: 1.0, color: '#56d9d0' },
      { label: 'Goals behind obstacles · bundle', k: 2, n: 6, lo: 0.097, hi: 0.70, color: '#8794a6' },
    ],
    notes: [
      'No contacts, no falls, bit-identical on re-run.',
      'Holds often complete 1–4 s after arrival: it overshoots and loops back.',
      'WX is privileged (plans from exact boxes); the bundle plans from simulated LiDAR.',
    ],
    latency: [
      { label: 'WX-RF · measured anchor', sub: 'L2≈ delayed-execution wrapper', color: '#56d9d0', points: [[0, 12], [100, 11], [200, 1]] },
      { label: 'Bundle · measured anchor', sub: 'source lockstep latency model', color: '#8794a6', points: [[0, 8], [200, 4]] },
      { label: 'Bundle · predictive anchor', sub: 'source lockstep, anchor = predicted state', color: '#efbb70', dash: true, points: [[0, 8], [200, 9]] },
      { label: 'WX-RF · predictive anchor', sub: 'Studio adapter: plan from the state at landing', color: '#5fd39b', dash: true, points: [[0, 12], [200, 11]] },
    ],
  },
  extraSlides: [
    { id: 'navigate-flow', html: `
      <div class="eyebrow" data-in="0.1">Navigate</div>
      <h2 data-in="0.3" data-a="rise">From what the robot sees to a walk</h2>
      <svg width="1680" height="560" viewBox="0 0 1680 560" style="position:absolute; left:120px; top:330px">
        ${[['1', 'The robot sees', 'MID-360 → its own map · 12 × 12 m, 5 cm', '#56d9d0'],
           ['2', 'Studio shows it', 'floor · obstacles · overhead · unseen stays empty', '#7fb4ff'],
           ['3', 'Click a goal', "checked on the robot's map with node.py's rules", '#efbb70'],
           ['4', 'Stage it', 'only while standing · read back ≤ 5 cm', '#e6dfcf'],
           ['5', 'Operator: Go', 'console g · never Studio', '#f08c85'],
           ['6', 'Watch, review', 'plan · path · health · replay · twin', '#5fd39b']]
          .map(([n, t, sub, c], i) => { const x = (i % 3) * 560, y = Math.floor(i / 3) * 270, t0 = 0.7 + i * 0.55;
            return `<g data-in="${t0}" data-a="rise"><rect x="${x}" y="${y}" width="510" height="220" rx="18" fill="#121821" stroke="${c}" stroke-width="2.4"/>
              <text x="${x + 30}" y="${y + 70}" font-size="54" font-weight="800" fill="${c}" font-family="JetBrains Mono">${n}</text>
              <text x="${x + 100}" y="${y + 70}" font-size="34" font-weight="700" fill="#e6ebf0">${t}</text>
              <foreignObject x="${x + 30}" y="${y + 100}" width="450" height="110"><div xmlns="http://www.w3.org/1999/xhtml" style="font: 24px/1.4 Inter, sans-serif; color:#a3afbd">${sub}</div></foreignObject></g>`; }).join('')}
      </svg>
      <div class="footer"><span>05 · DEPLOY</span><span>G1 DEPLOY STUDIO</span></div>` },
    { id: 'navigate-finding', html: `
      <div class="eyebrow" data-in="0.1">What building it showed</div>
      <h2 data-in="0.3" data-a="rise">A table-height edge can look like a ceiling</h2>
      <div style="display:grid; grid-template-columns: 1.15fr 1fr; gap: 36px; margin-top: 34px">
        <div class="card" data-in="0.9" data-a="rise">
          <h3 style="font-size:30px">The deploy stack, in simulation</h3>
          <p data-in="1.3" style="margin-top:14px">The robot's map filed the top edge of a <span class="amber">1 m pillar</span> as a ceiling at 0.98 m (also seen at 0.83–0.96 m in a recorded run).</p>
          <p data-in="2.0" style="margin-top:14px">node.py then <span class="amber">defers its stand</span> there; when the plan ran out the robot held its last pose, leaned on the pillar at 107 N and drifted 1 m in 70 s.</p>
          <p data-in="2.8" style="margin-top:14px">Studio now refuses such goals, explains a deferred stand and offers the remote's takeover. The fix belongs to the deploy repository.</p>
        </div>
        <div style="display:flex; flex-direction:column; gap:18px">
          <div class="card" style="padding:20px 28px" data-in="3.4" data-a="rise"><span class="tag" style="color:var(--green)">PARITY</span><p style="margin-top:8px">The simulated robot's walk equals the validated rehearsal: 279 frames, largest pose difference 0.000005.</p></div>
          <div class="card" style="padding:20px 28px" data-in="3.9" data-a="rise"><span class="tag" style="color:var(--cyan)">ROUTE CHECK</span><p style="margin-top:8px">Studio's reachability equals Flow's SensorRoute on 25 recorded node maps: 200 routes, no mismatch.</p></div>
          <div class="card" style="padding:20px 28px" data-in="4.4" data-a="rise"><span class="tag" style="color:var(--amber)">SPEED</span><p style="margin-top:8px">Quick planner budget about real time on this CPU; the deployed budget 0.16×.</p></div>
        </div>
      </div>
      <div class="footer"><span>05 · DEPLOY</span><span>G1 DEPLOY STUDIO</span></div>` },
    { id: 'torque', html: `
      <div class="eyebrow" data-in="0.1">Hardware question, settled by research</div>
      <h2 data-in="0.3" data-a="rise">The hip limit depends on the robot's revision</h2>
      <div style="display:grid; grid-template-columns: 1.25fr 1fr; gap: 36px; margin-top: 30px">
        <div class="card" data-in="0.9" data-a="rise">
          <table class="t">
            <tr><th>mode_machine</th><th>Hip pitch</th><th>Hip roll</th><th>Hip yaw</th></tr>
            <tr data-in="1.2"><td class="mono">1 – 3 · deprecated</td><td class="n">88</td><td class="n">88</td><td class="n">88</td></tr>
            <tr data-in="1.6"><td class="mono">4 – 6, 13, 14 · rev_1_0</td><td class="n amber">88</td><td class="n">139</td><td class="n">88</td></tr>
            <tr data-in="2.0"><td class="mono">10 – 12, 15, 16, 18 · current</td><td class="n accent">139</td><td class="n accent">139</td><td class="n">88</td></tr>
          </table>
          <p style="margin-top:22px; font-size:20px" class="mono">N·m · Unitree unitree_ros model table (7520-14.3 = 88, 7520-22.5 = 139) · NVIDIA GR00T #174</p>
        </div>
        <div style="display:flex; flex-direction:column; gap:16px">
          <div class="card" style="padding:18px 26px" data-in="2.6" data-a="rise"><span class="tag" style="color:var(--cyan)">g1-current · default</span><p style="margin-top:8px">139 / 139 / 88 — the robot SONIC and the Flow policies were trained for.</p></div>
          <div class="card" style="padding:18px 26px" data-in="3.1" data-a="rise"><span class="tag" style="color:var(--amber)">g1-rev1 · pessimistic</span><p style="margin-top:8px">88 / 139 / 88 — older robots clamp hip pitch at 88 N·m.</p></div>

        </div>
      </div>
      <div class="card" style="margin-top:22px; padding:22px 34px" data-in="4.4" data-a="rise">
        <h3 style="font-size:27px">WX-RF · predictive anchor · same 12 scenarios · arrive &amp; hold</h3>
        <svg width="1600" height="210" viewBox="0 0 1600 210">
          ${[['0 ms · current G1 (139/139/88)', 12, 12, '#56d9d0', 'lockstep baseline'], ['160 ms · current G1 · robot replan budget', 12, 12, '#5fd39b', 'median 4.9 s to goal'], ['200 ms · current G1 · seeds 0–2', 21, 36, '#f08c85', '4–10/12 per seed · past a cliff'], ['200 ms · rev_1_0 (88/139/88) · seed 0', 11, 12, '#efbb70', 'hip pitch clipped · 1 fall']]
            .map(([l, k, n, c, note], i) => `<text x="0" y="${34 + i * 46}" font-size="22" fill="#e6ebf0" data-in="${4.6 + i * 0.4}">${l}</text>
              <rect x="470" y="${14 + i * 46}" width="700" height="28" rx="6" fill="#18212c" data-in="${4.6 + i * 0.4}"/>
              <rect x="470" y="${14 + i * 46}" width="${700 * k / n}" height="28" rx="6" fill="${c}" data-in="${4.7 + i * 0.4}" data-a="grow" data-d="0.9"/>
              <text x="1190" y="${36 + i * 46}" font-size="24" font-weight="700" fill="${c}" font-family="JetBrains Mono" data-in="${5.4 + i * 0.4}">${k}/${n}</text>
              <text x="1300" y="${35 + i * 46}" font-size="18" fill="#8794a6" data-in="${5.5 + i * 0.4}">${note}</text>`).join('')}
        </svg>
      </div>
      <div class="footer"><span>04 · RESULTS</span><span>G1 DEPLOY STUDIO</span></div>` },
    { id: 'l3', html: `
      <div class="eyebrow" data-in="0.1">Next rung · L3</div>
      <h2 data-in="0.3" data-a="rise">The real chain, sealed in a private network</h2>
      <svg width="1680" height="640" viewBox="0 0 1680 640" style="position:absolute; left:120px; top:320px">
        <defs><marker id="arr-c" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#56d9d0"/></marker>
          <marker id="arr-a" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="#efbb70"/></marker></defs>
        <g data-in="0.6" data-a="scale" data-d="0.8">
          <rect x="0" y="0" width="1100" height="560" rx="22" fill="#0f1a1d" stroke="#56d9d0" stroke-width="2.5" stroke-dasharray="14 8"/>
          <text x="30" y="46" font-size="24" font-family="JetBrains Mono" fill="#56d9d0">user + net + pid + mount namespace · only interface: lo</text>
        </g>
        <g data-in="1.2" data-a="rise"><rect x="60" y="110" width="300" height="130" rx="16" fill="#121821" stroke="#7fb4ff" stroke-width="2.2"/><text x="84" y="160" font-size="29" font-weight="700" fill="#e6ebf0">robot_sim.py</text><text x="84" y="196" font-size="21" fill="#a3afbd">MuJoCo · DDS lowstate</text></g>
        <g data-in="1.6" data-a="rise"><rect x="400" y="110" width="300" height="130" rx="16" fill="#121821" stroke="#56d9d0" stroke-width="2.2"/><text x="424" y="160" font-size="29" font-weight="700" fill="#e6ebf0">SONIC runner</text><text x="424" y="196" font-size="21" fill="#a3afbd">C++ · TensorRT (cached)</text></g>
        <g data-in="2.0" data-a="rise"><rect x="740" y="110" width="300" height="130" rx="16" fill="#121821" stroke="#efbb70" stroke-width="2.2"/><text x="764" y="160" font-size="29" font-weight="700" fill="#e6ebf0">node.py</text><text x="764" y="196" font-size="21" fill="#a3afbd">planner · ZMQ pose v1</text></g>
        <path d="M360,175 L392,175" stroke="#7fb4ff" stroke-width="3" marker-end="url(#arr-c)" data-in="2.3" data-a="draw"/>
        <path d="M740,175 L708,175" stroke="#efbb70" stroke-width="3" marker-end="url(#arr-a)" data-in="2.5" data-a="draw"/>
        <g data-in="2.8" data-a="rise"><rect x="400" y="320" width="640" height="120" rx="16" fill="#121821" stroke="#e6dfcf" stroke-width="2"/><text x="424" y="370" font-size="27" font-weight="700" fill="#e6ebf0">studio.recorder · subscribe-only</text><text x="424" y="406" font-size="21" fill="#a3afbd" font-family="JetBrains Mono">:5557 g1_debug · robot_config · :5556 pose</text></g>
        <g data-in="3.4" data-a="rise">
          <rect x="1220" y="190" width="420" height="180" rx="16" fill="#1a1414" stroke="#5a3234" stroke-width="2"/>
          <text x="1246" y="246" font-size="27" font-weight="700" fill="#f08c85">Robot network</text>
          <text x="1246" y="284" font-size="21" fill="#a3afbd" font-family="JetBrains Mono">192.168.123.x · LAN · tailnet</text>
          <text x="1246" y="320" font-size="21" fill="#a3afbd" font-family="JetBrains Mono">unreachable: no route</text>
          <path d="M1100,280 L1214,280" stroke="#f08c85" stroke-width="3" stroke-dasharray="8 8"/>
          <path d="M1140,250 L1180,310 M1180,250 L1140,310" stroke="#f08c85" stroke-width="5"/>
        </g>
        <g data-in="4.0" data-a="rise"><text x="60" y="510" font-size="22" fill="#5fd39b" font-family="JetBrains Mono">✓ no DDS/ZMQ leak  ✓ wrong NIC fails closed  ✓ zero survivors  ✓ engine hash match  ✓ CUDA OK</text></g>
      </svg>
      <div class="footer"><span>04 · RESULTS</span><span>G1 DEPLOY STUDIO</span></div>` },
  ],
  validation: [
    { v: 343, unit: '', cap: 'unit tests, plus opt-in real-worker integration tests (parity with the source rehearsal)', color: '#56d9d0' },
    { v: 15, unit: '/15', cap: 'browser acceptance checks, direct and through a forwarded SSH port', color: '#5fd39b' },
    { v: 34, unit: '', cap: 'browser checks for Navigate: simulated robot, robot link, its hazards, build sheet', color: '#efbb70' },
    { v: 118, unit: '', cap: 'independent re-validation checks across every workspace', color: '#e6dfcf' },
  ],
  validatorFound: [
    'a goal check that failed open when no map existed',
    'a readback marked refused while the node kept the goal',
    'a stand deferred forever kept a session from ending',
    'the robot vanished without the runner\'s joint stream',
    'phantom ceilings from the robot\'s own arms (deploy repo)',
    'recordings over 64 MiB that would not replay',
  ],
  honesty: [
    'missing telemetry renders UNAVAILABLE, never a healthy zero',
    'privileged runs say perception is unavailable by design',
    'a worker that exits is never counted as policy success',
    'every rate carries a Wilson interval and its n',
    'render-limited playback is flagged, real time is kept',
  ],
  securityLine: 'Loopback-only gateway (127.0.0.1 / ::1) · Host and Origin checks · per-process CSRF token · content-hashed assets · SSH tunnel for remote access · no hardware, DDS or ZMQ command path.',
  roadmap: [
    { tag: 'L3 · READY', color: '#7fb4ff', title: 'Real chain + robot link', text: 'Run the isolated real-time chain and connect Navigate to the real node.py inside it, before any robot.' },
    { tag: 'M5 · AFTER REVIEW', color: '#efbb70', title: 'The physical G1', text: 'Read mode_machine first, observe the streams, then stage goals while the operator keeps Go, the remote and the e-stop.' },
    { tag: 'NEXT', color: '#5fd39b', title: 'Site maps', text: 'A mapping walk, relocalization each session and named goals that stay valid across days.' },
  ],
  outroLine: 'tools/studio_service.sh status · http://127.0.0.1:8790/ · ssh -N -L 8790:127.0.0.1:8790',
};
