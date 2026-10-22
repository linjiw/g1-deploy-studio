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
  refused: { label: 'Refused', color: 0x8aa0ad, text: 'The goal was refused.' },
};

// One verdict per walk for colours and badges: arrival by the robot's estimate is not the whole story.
// The same rule as tools/site/export.py grade_key: contact over 100 N, then the final distance by simulator truth.
export const GRADES = {
  clean: { label: 'Arrived', short: 'Clean', color: 0x2fae6a, css: 'var(--ok)' },
  contact: { label: 'Arrived, with contact', short: 'Contact', color: 0xe2a03a, css: 'var(--warn)' },
  off: { label: 'Arrived by its estimate, off by truth', short: 'Off by truth', color: 0xe2a03a, css: 'var(--warn)' },
  away: { label: 'Arrived, then moved away', short: 'Moved away', color: 0xe2a03a, css: 'var(--warn)' },
  stopped: { label: 'Stopped', short: 'Stopped', color: 0xe2a03a, css: 'var(--warn)' },
  estop: { label: 'E-stop', short: 'E-stop', color: 0xd64545, css: 'var(--bad)' },
  fell: { label: 'Fell', short: 'Fell', color: 0xd64545, css: 'var(--bad)' },
  ungraded: { label: 'Arrived, not fully graded', short: 'Ungraded', color: 0x8aa0ad, css: 'var(--ink-3)' },
};
export function gradeKey(walk) {
  if (walk.outcome === 'arrived') {
    if ((walk.max_contact_n ?? 0) > 100) return 'contact';
    // Off by truth: its estimate was wrong, or (its estimate agreeing) it moved away after arriving, as in a deferred stand.
    if ((walk.final_dist_m ?? 0) > 0.6) return (walk.final_dist_estimate_m ?? 0) > 0.6 ? 'away' : 'off';
    if (walk.final_dist_m == null || walk.max_contact_n == null) return 'ungraded';  // nothing flagged, but a missing value is not clean
    return 'clean';
  }
  return walk.outcome;
}
export function grade(walk) {
  const key = gradeKey(walk), g = GRADES[key] ?? { label: OUTCOME[key]?.label ?? key, short: key, color: 0x8aa0ad, css: 'var(--ink-3)' };
  return { key, ...g };
}
export const hex = c => `#${(c ?? 0x888888).toString(16).padStart(6, '0')}`;

// node.py phases (studio/nav_worker.py reproduces the state machine).
export const PHASE = {
  WAIT: { label: 'Waiting', color: '#8aa0ad', why: 'Standing. The navigation node (node.py, phase WAIT) waits for a goal and the operator.' },
  PRESCAN: { label: 'Pre-scan', color: '#c4a0d9', text: 'Pre-scan: before every walk the node stands for 0.5 s while its LiDAR fills the map.', why: 'node.py phase PRESCAN: it pre-scans before every walk.' },
  RUN: { label: 'Walking', color: '#56d9d0', text: 'Walking: the planner replans from its memory several times a second and the tracker follows the plan.', why: 'node.py phase RUN: the Flow student plans; SONIC tracks.' },
  ARRIVED: { label: 'Arrived', color: '#7be0a5', text: "Arrived: settling to a stand. The recording ends when it stands still, or if it falls.", why: "node.py phase ARRIVED: its own position estimate within the 0.4 m goal radius." },
  STOPPED: { label: 'Stopped', color: '#efbb70', text: 'Stopped: standing up where it is.', why: "node.py phase STOPPED: a walk timeout (Studio's 60 s limit in simulation), the operator, or a supervisor stop." },
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
