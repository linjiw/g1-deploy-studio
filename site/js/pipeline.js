// How the pieces fit: the robot-day topology (docs/REAL_WORLD_DEPLOYMENT.md §3), drawn as an SVG one can click.
import { escape } from './util.js';

const W = 200, H = 66;
const NODES = {
  lidar: { x: 40, y: 50, title: 'MID-360 LiDAR', sub: 'head · 10 Hz clouds',
    text: "The Livox MID-360 on the G1's head: 360° around, 59° vertical, 10 point clouds a second over DDS. It is the planner's only view of the room; the head camera is not used.",
    facts: [['Topic', 'rt/utlidar/cloud_livox_mid360'], ['Rate', '10 Hz (its IMU 200 Hz)'], ['Kind', 'measured']] },
  body: { x: 400, y: 50, title: 'Joints and IMU', sub: 'rt/lowstate · 500 Hz',
    text: "The G1's 29 joint encoders and its IMU, published by the robot's own computer at 500 Hz.",
    facts: [['Topic', 'rt/lowstate'], ['Rate', '500 Hz'], ['Kind', 'measured']] },
  motors: { x: 760, y: 50, title: '29 motors', sub: 'PD position control',
    text: 'Each joint follows a position target with PD gains. Exactly one program writes those targets: the SONIC runner. Studio has no path to them.',
    facts: [['Topic', 'rt/lowcmd'], ['Writer', 'SONIC runner only'], ['Kind', 'commanded']] },
  lio: { x: 40, y: 220, title: 'Point-LIO + bridge', sub: 'ZMQ :5561 odom · cloud',
    text: "Point-LIO fuses the LiDAR with its IMU into odometry. g1-student-deploy's ros2_lio_bridge forwards it on ZMQ :5561 at 50 Hz, and with --forward-cloud the registered cloud too. The odom frame starts where LIO starts: the floor is z = 0 and yaw 0 is the start heading. The bridge is written but untested: the development machine has no ROS 2.",
    facts: [['Publishes', ':5561 odom 50 Hz, cloud'], ['Binds', 'tcp://*:5561 (every interface today)'], ['If it stops', 'node.py E-stops after 0.5 s; the console switches the runner to damping'], ['Kind', 'estimated']] },
  node: { x: 400, y: 220, title: 'node.py', sub: 'Flow planner · memory',
    text: "g1-student-deploy's node removes the robot's own body from each scan and fuses the points into a 12 × 12 m memory at 5 cm (floor and ceiling heights). Flow's SensorRoute finds a route through it and the frozen Flow student plans whole-body motion (16 candidates, 10 ODE steps). Phases: WAIT → PRESCAN → RUN → ARRIVED or STOPPED, with a tilt E-stop at 0.75 rad and a 0.4 m goal radius.",
    facts: [['Plans to', ':5556 pose reference (50 Hz frames)'], ['Control', ':5562 status · goal · go · stand · quit'], ['Binds', 'tcp://*:5562 and *:5556 (every interface today; proposal U3 would bind them to loopback)'], ['Memory', '12 × 12 m, 5 cm cells, 4 m range']] },
  sonic: { x: 760, y: 220, title: 'SONIC runner', sub: 'C++ · ONNX · 50 Hz',
    text: "The SONIC whole-body tracking policy (C++, ONNX) follows the planner's reference, sampling ten frames 0.1 s apart. It reads rt/lowstate, writes PD targets to rt/lowcmd and publishes measured joints and motor temperatures on ZMQ :5557.",
    facts: [['Reads', ':5556 pose, rt/lowstate'], ['Writes', 'rt/lowcmd'], ['Debug', ':5557 g1_debug, bound to tcp://*:5557 (every interface)']] },
  studio: { x: 400, y: 400, title: 'Studio', sub: '127.0.0.1:8790 · loopback',
    text: "Studio runs on the deploy PC and binds only loopback. It subscribes to the odometry, cloud, pose and debug streams and shows each with its age; missing data shows as missing, never as zero. It checks a goal on its reconstruction of the LIO cloud and sends node.py that goal (only while the robot stands still and the frames match) or a stand. It has no DDS participant and cannot command a motor.",
    facts: [['Listens', ':5561 · :5556 · :5557'], ['Sends', ':5562 goal · stand · status'], ['Never', 'go · quit · rt/lowcmd']] },
  operator: { x: 40, y: 400, title: 'Operator', sub: 'console g · remote',
    text: "A person starts every walk: g on the node console hands the runner to the node's stream and tells node.py to go (the console starts it with --wait-go; the remote's F1 alone only switches the runner's stream). h asks the node to stand; the remote's D-up hands control to SONIC standing (not near overhead obstacles) and Select is the runner's damping E-stop (the robot drops: gantry or spotter only). The physical E-stop stays in hand.",
    facts: [['Starts', 'g on the node console'], ['Stops', 'h · D-up · Select · physical E-stop'], ['Always', 'a person']] },
  browser: { x: 760, y: 400, title: 'Your browser', sub: 'SSH tunnel to :8790',
    text: 'The operator laptop opens Studio through an SSH tunnel (ssh -N -L 8790:127.0.0.1:8790 …): Studio itself listens only on loopback.',
    facts: [['Tunnel', 'ssh -N -L 8790:127.0.0.1:8790'], ['Shows', 'pose, LiDAR, map, plan, stream ages'], ['Kind', 'view only']] },
};
// [path, label, label x, label y, anchor, kind]
const EDGES = [
  ['M140,116 L140,220', 'DDS cloud + IMU', 148, 172, 'start', 'flow'],
  ['M240,100 C330,100 400,150 440,220', 'cloud 10 Hz', 352, 128, 'start', 'flow'],
  ['M240,253 L400,253', ':5561 odom 50 Hz', 320, 244, 'middle', 'flow'],
  ['M600,253 L760,253', ':5556 pose', 680, 244, 'middle', 'flow'],
  ['M600,100 C700,100 760,150 800,220', 'rt/lowstate 500 Hz', 706, 128, 'start', 'flow'],
  ['M860,220 L860,116', 'rt/lowcmd', 868, 172, 'start', 'motor'],
  ['M140,286 C140,343 430,343 430,400', 'SUB :5561', 150, 312, 'start', 'flow'],
  ['M470,286 L470,400', 'SUB :5556', 462, 360, 'end', 'flow'],
  ['M530,400 L530,286', ':5562 goal · stand', 538, 360, 'start', 'studio-write'],
  ['M860,286 C860,343 570,343 570,400', 'SUB :5557', 850, 312, 'end', 'flow'],
  ['M240,433 C330,433 330,275 400,270', 'console g', 250, 452, 'start', 'operator'],
  ['M600,433 L760,433', 'HTTP over SSH', 680, 424, 'middle', 'flow'],
];

export function initPipeline(container, detail) {
  const edges = EDGES.map(([d, label, x, y, anchor, kind]) =>
    `<path class="edge ${kind}" d="${d}" marker-end="url(#arrow-${kind})"/><text class="elabel ${kind === 'studio-write' ? 'studio' : ''}" x="${x}" y="${y}" text-anchor="${anchor}">${escape(label)}</text>`).join('');
  const nodes = Object.entries(NODES).map(([id, n]) => `<g class="node" data-id="${id}" tabindex="0" role="button" aria-label="${escape(`${n.title}: ${n.sub}`)}">
    <rect x="${n.x}" y="${n.y}" width="${W}" height="${H}"/><text x="${n.x + 14}" y="${n.y + 28}">${escape(n.title)}</text><text class="sub" x="${n.x + 14}" y="${n.y + 49}">${escape(n.sub)}</text></g>`).join('');
  const marker = id => `<marker id="arrow-${id}" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" class="arrow-${id}"/></marker>`;
  container.innerHTML = `<svg viewBox="0 0 1000 516" xmlns="http://www.w3.org/2000/svg">
    <defs>${['flow', 'motor', 'studio-write', 'operator', 'never'].map(marker).join('')}</defs>
    <rect class="zone" x="16" y="18" width="968" height="122" rx="14"/><text class="zone-label" x="28" y="134">G1 ROBOT</text>
    <rect class="zone" x="16" y="190" width="968" height="120" rx="14"/><text class="zone-label" x="28" y="304">DEPLOY PC</text>
    <rect class="zone" x="16" y="376" width="968" height="110" rx="14"/><text class="zone-label" x="28" y="480">PEOPLE AND VIEWS</text>
    ${edges}
    <path class="edge never" d="M500,466 L500,500 L990,500 L990,83 L962,83" marker-end="url(#arrow-never)"/>
    <text class="elabel never" x="745" y="494" text-anchor="middle">Studio → motors: no path (never go, quit or rt/lowcmd)</text>
    ${nodes}</svg>`;
  const select = id => {
    const n = NODES[id];
    for (const g of container.querySelectorAll('.node')) g.classList.toggle('on', g.dataset.id === id);
    detail.innerHTML = `<h3>${escape(n.title)}</h3><p>${escape(n.text)}</p><dl>${n.facts.map(([a, b]) => `<dt>${escape(a)}</dt><dd><code>${escape(b)}</code></dd>`).join('')}</dl>`;
  };
  // The detail is announced once a visitor picks a part, not when the page builds the diagram.
  const chosen = id => { detail.setAttribute('aria-live', 'polite'); select(id); };
  container.addEventListener('click', e => { const g = e.target.closest('.node'); if (g) chosen(g.dataset.id); });
  container.addEventListener('keydown', e => { const g = e.target.closest('.node'); if (g && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); chosen(g.dataset.id); } });
  select('studio');
}
