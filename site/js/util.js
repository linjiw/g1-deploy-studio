export const $ = id => document.getElementById(id);
const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escape = v => String(v ?? '').replace(/[&<>"']/g, c => ESC[c]);
export const fmt = (n, d = 2) => (typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—');
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// Walk outcomes as the nav worker reports them (studio/nav_worker.py legs[].outcome).
export const OUTCOME = {
  arrived: { label: 'Arrived', color: 0x7be0a5, text: 'Within the 0.4 m arrival radius by its own estimate; it settled to a stand.' },
  stopped: { label: 'Stopped', color: 0xefbb70, text: 'The walk ended before arriving and the robot stood.' },
  estop: { label: 'E-stop', color: 0xf07870, text: "The walk was stopped: the robot tilted past 0.75 rad (node.py's supervisor) or the pelvis dropped below 0.35 m (Studio's fall rule). On the robot the runner switches to damping." },
  fell: { label: 'Fell', color: 0xf07870, text: 'The robot fell while settling to a stand.' },
  session_end: { label: 'Ended', color: 0x8aa0ad, text: 'The session ended during the walk.' },
  refused: { label: 'Refused', color: 0x8aa0ad, text: 'The node refused the goal.' },
};

// One verdict per walk for colours and badges: arrival by the robot's estimate is not the whole story.
export function grade(walk) {
  const contact = (walk.max_contact_n ?? 0) > 100;
  if (walk.outcome === 'arrived') {
    if (contact) return { key: 'contact', label: 'Arrived, with contact', color: 0xefbb70 };
    if ((walk.final_dist_m ?? 0) > 0.6) return { key: 'off', label: 'Arrived by its estimate, off by truth', color: 0xefbb70 };
    return { key: 'clean', label: 'Arrived', color: 0x7be0a5 };
  }
  const o = OUTCOME[walk.outcome] ?? { label: walk.outcome, color: 0x8aa0ad };
  return { key: walk.outcome, label: o.label, color: o.color };
}

// node.py phases (studio/nav_worker.py reproduces the state machine).
export const PHASE = {
  WAIT: { label: 'WAIT', color: '#8aa0ad', why: 'Standing; the node waits for a goal and the operator.' },
  PRESCAN: { label: 'PRESCAN', color: '#c4a0d9', text: 'Pre-scan: before every walk node.py stands for 0.5 s while its LiDAR fills the map.', why: 'node.py pre-scans before every walk.' },
  RUN: { label: 'RUN', color: '#56d9d0', text: 'Walking: the planner replans from its memory several times a second and SONIC tracks the plan.', why: 'Flow student plans; SONIC tracks.' },
  ARRIVED: { label: 'ARRIVED', color: '#7be0a5', text: "Arrived: settling to a stand. The recording ends once it stands still.", why: "node.py's arrival rule: its own pose estimate within the 0.4 m goal radius." },
  STOPPED: { label: 'STOPPED', color: '#efbb70', text: 'Stopped: standing up where it is.', why: 'A timeout, the operator, or a supervisor stop.' },
};

// The planner's candidate selection (Flow closed_loop/planner.py), in words.
export const RULES = {
  safe_min_goal_distance: { label: 'safest candidates, closest to the goal', why: 'Of the sampled plans with enough clearance, the one that ends nearest the goal.' },
  resampled_safe: { label: 'resampled, then closest to the goal', why: 'No sampled plan had enough clearance; it sampled more and took the safe one nearest the goal.' },
  continue_previous: { label: 'continue the previous plan', why: 'Nothing new was safe; it keeps following the plan it had.' },
  forward_max_clearance: { label: 'forward, most clearance', why: 'Nothing was safe; the forward plan with the most clearance.' },
  stop_max_clearance: { label: 'stop and hold, most clearance', why: 'Nothing was safe; it holds position (turning toward the goal) with the most clearance.' },
  max_clearance: { label: 'most clearance', why: 'Nothing was safe; the plan with the most clearance.' },
};
