// "Try it": the Navigate workflow on recorded, simulated walks of the deploy stack. Pick a goal on the robot's map,
// read Studio's goal checks for it, send it, press Go as the operator does, and watch the walk the stack made.
import { Viewer, COLORS } from './viewer.js';
import { json, walkJson, decodeWorld, Walk } from './data.js';
import { $, fmt, escape, OUTCOME, PHASE, RULES, grade, reducedMotion } from './util.js';

const DATA = 'data';
const CHECKS = {
  inside: { name: 'Inside', pass: 'Inside the map', why: "The goal must lie in the planner's 12 × 12 m memory, at least 0.5 m from its edge." },
  seen: { name: 'Seen', pass: 'Seen', why: 'Has the LiDAR seen this spot? Unseen goals pass with a warning: the planner explores as it sees more.' },
  free: { name: 'Free', pass: 'Free of obstacles', why: 'Blocks if anything taller than the 0.25 m step-over is within 0.30 m of the goal; route margins and low obstacles nearby warn.' },
  overhead: { name: 'Overhead', pass: 'No low overhead obstacle', why: "node.py defers its stand if its memory holds a ceiling below 1.35 m within its 0.8 m window. Studio blocks such goals and warns near them." },
  reachable: { name: 'Reachable', pass: 'Reachable', why: "A route through what the robot knows, mirroring Flow's SensorRoute: obstacles over 0.25 m kept 0.35 m away, unseen space treated as free." },
  distance: { name: 'Distance', pass: 'Distance', why: 'Straight-line and route length from the start mark.' },
};
const COMMON_WARNINGS = new Set(['Not seen yet', 'Route crosses unseen space']);
const STATUS = { p: ['pass', '✓'], w: ['warn', '!'], b: ['block', '✕'] };
const SPEEDS = [0.5, 1, 2, 4];
const narrow = () => window.matchMedia('(max-width: 1020px)').matches;

export class Playground {
  constructor(root) {
    this.root = root;
    this.S = { worldId: null, world: null, selected: null, staged: null, mode: 'pick', walk: null, t: 0, playing: false,
               speed: 1, last: null, mapStep: -1, layers: { map: true, world: 'ghost', lidar: true, plan: true, outcomes: true },
               trailIndex: -1, planShown: null, lidarShown: null, uiAt: 0, hover: null, clicked: null, loadToken: 0 };
    this.viewer = new Viewer($('pg-canvas'), { onPick: xy => this.pick(xy), onHover: xy => this.hover(xy) });
    this.viewer.onFrame = now => this.frame(now);
    this.lines = { route: this.viewer.line(COLORS.white, 2, { dashed: true, opacity: 0.8 }), plan: this.viewer.line(COLORS.pink, 4),
                   trail: this.viewer.line(COLORS.teal, 3, { opacity: 0.9 }) };
    this.viewer.groups.route.add(this.lines.route); this.viewer.groups.plan.add(this.lines.plan); this.viewer.groups.trail.add(this.lines.trail);
    this.pose = new Float64Array(36);
    this.bind();
  }

  async init() {
    const [catalog] = await Promise.all([json(`${DATA}/worlds.json`), this.viewer.loadRobot(DATA)]);
    this.catalog = catalog.worlds;
    $('pg-worlds').innerHTML = this.catalog.map(w => `<button class="tab" role="tab" id="tab-${w.id}" data-world="${w.id}" aria-selected="false" aria-controls="pg-panel" tabindex="-1">
      <span>${escape(w.title)}</span><small>${w.walks} walks</small></button>`).join('');
    const fromHash = parseHash();
    await this.loadWorld(fromHash?.world && this.catalog.some(w => w.id === fromHash.world) ? fromHash.world : this.catalog[0].id, { keepHash: true });
    window.addEventListener('hashchange', () => this.fromHash());
    if (window.matchMedia('(max-width: 700px)').matches) $('pg-legend').open = false;
    this.root.classList.add('pg-ready');
    if (fromHash?.goal) await this.fromHash();
  }

  // #try/<room>/<goal>[/play]: open a room, stage a recorded goal and, with /play, press Go (findings, hero).
  async fromHash() {
    const h = parseHash();
    if (!h) return;
    if (h.world && !this.catalog.some(w => w.id === h.world)) { this.flash('That room is not in this recording.'); return; }
    if (h.world && h.world !== this.S.worldId) await this.loadWorld(h.world, { keepHash: true });
    if (!h.goal) return;
    const cell = this.S.world.cells.find(c => c.id === h.goal);
    if (!cell || !cell.walk) { this.flash('That walk is not in this recording.'); return; }
    this.root.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'start' });
    this.S.clicked = null;
    this.selectCell(cell, { stage: true });
    if (h.play && this.S.mode === 'staged' && !reducedMotion()) this.go();
  }

  bind() {
    $('pg-send').addEventListener('click', () => this.send());
    $('pg-go').addEventListener('click', () => this.go());
    $('pg-clear').addEventListener('click', () => this.reset());
    $('pg-play').addEventListener('click', () => this.togglePlay());
    $('pg-again').addEventListener('click', () => { this.seek(0); this.play(); });
    $('pg-new').addEventListener('click', () => this.reset());
    $('pg-random').addEventListener('click', () => this.random());
    $('pg-failure').addEventListener('click', () => this.random(true));
    $('pg-speed').addEventListener('click', () => { const i = SPEEDS.indexOf(this.S.speed); this.S.speed = SPEEDS[(i + 1) % SPEEDS.length]; $('pg-speed').textContent = `${this.S.speed}×`; });
    const scrub = $('pg-scrub');
    scrub.addEventListener('input', () => {
      if (!this.S.walk) return;
      const t = Number(scrub.value) / 1000 * this.S.walk.duration;  // read before anything re-renders the slider
      this.S.playing = false;
      this.seek(t);
    });
    const tabs = $('pg-worlds');
    tabs.addEventListener('click', e => { const b = e.target.closest('[data-world]'); if (b) this.loadWorld(b.dataset.world); });
    tabs.addEventListener('keydown', e => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
      const ids = this.catalog.map(w => w.id), i = ids.indexOf(this.S.worldId);
      const next = e.key === 'Home' ? 0 : e.key === 'End' ? ids.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + ids.length) % ids.length;
      e.preventDefault();
      this.loadWorld(ids[next]).then(() => $(`tab-${ids[next]}`)?.focus());
    });
    for (const b of this.root.querySelectorAll('[data-layer]')) b.addEventListener('click', () => this.toggleLayer(b.dataset.layer, b));
    for (const b of this.root.querySelectorAll('[data-camera]')) b.addEventListener('click', () => this.camera(b.dataset.camera, b));
    window.addEventListener('keydown', e => {
      if (e.ctrlKey || e.metaKey || e.altKey || !this.inView()) return;
      if (e.target.closest('input, textarea, select, [contenteditable]')) return;
      // g and Escape work wherever focus is (Send moves it to Go); Space keeps its meaning on buttons and links.
      if (e.key.toLowerCase() === 'g' && this.S.mode === 'staged') { e.preventDefault(); this.go(); }
      else if (e.key === 'Escape' && (this.S.selected || this.S.walk)) this.reset();
      else if (e.key === ' ' && this.S.walk && !e.target.closest('button, a, [role="tab"], summary')) { e.preventDefault(); this.togglePlay(); }
    });
  }
  inView() { const r = this.root.getBoundingClientRect(); return r.bottom > 80 && r.top < window.innerHeight - 80; }

  // ----- rooms
  async loadWorld(id, { keepHash = false } = {}) {
    const S = this.S;
    if (S.worldId === id && S.world) return;
    const token = ++S.loadToken;
    this.pause();
    $('pg-status').textContent = 'Loading the room…';
    let world;
    try {
      world = decodeWorld(await json(`${DATA}/${id}/index.json`));
    } catch (error) {
      if (token === S.loadToken) { this.flash(`Could not load this room: ${error.message}`); this.render(); }
      return;
    }
    if (token !== S.loadToken) return;  // a later click won
    for (const b of $('pg-worlds').querySelectorAll('[data-world]')) {
      const on = b.dataset.world === id;
      b.setAttribute('aria-selected', String(on)); b.tabIndex = on ? 0 : -1;
    }
    $('pg-panel').setAttribute('aria-labelledby', `tab-${id}`);
    Object.assign(S, { worldId: id, world, walk: null, selected: null, staged: null, mode: 'pick', hover: null, clicked: null });
    this.viewer.setMarker('goalMarker', null);
    this.viewer.setMarker('hoverMarker', null);
    this.viewer.setLine(this.lines.route, null);
    S.recorded = world.cells.filter(c => c.walk);
    this.viewer.setWorld(world);
    this.viewer.setBoxesStyle(S.layers.world);
    this.viewer.frame(world);
    this.resetRobot();
    this.paintOutcomes();
    const g = S.recorded.map(c => grade(c.walk));
    const n = S.recorded.length, count = k => g.filter(x => x.key === k).length;
    const arrived = S.recorded.filter(c => c.walk.outcome === 'arrived').length;
    const parts = [`<b>${n}</b> walks`, `<b>${n ? Math.round(arrived / n * 100) : 0}%</b> arrived`];
    if (count('contact')) parts.push(`${count('contact')} with contact`);
    if (count('off')) parts.push(`${count('off')} ended off target`);
    const failed = n - arrived;
    if (failed) parts.push(`${failed} did not arrive`);
    $('pg-world-stats').innerHTML = parts.join(' · ');
    $('pg-world-blurb').textContent = world.blurb;
    $('pg-failure').hidden = !g.some(x => x.key !== 'clean');
    if (!keepHash) history.replaceState(null, '', `#try/${id}`);
    this.render();
  }
  paintOutcomes() { this.viewer.setOutcomes(this.S.layers.outcomes ? this.S.recorded : [], c => grade(c.walk).color); }

  resetRobot() {
    const S = this.S, w = S.world;
    this.viewer.dimOutcomes(false);
    Object.assign(S, { walk: null, t: 0, playing: false, mapStep: -1, trailIndex: -1, planShown: null, lidarShown: null });
    this.viewer.setMapBase(w.map);
    this.viewer.setLidar(S.layers.lidar ? w.start_lidar : null);
    this.viewer.setPose(w.startPose);
    this.viewer.setMarker('estMarker', null);
    this.viewer.setLine(this.lines.plan, null);
    this.viewer.setLine(this.lines.trail, null);
    $('pg-result').hidden = true;
  }

  // ----- picking goals
  nearest(xy, limit = 0.45, keep = () => true) {
    let best = null, bestD = limit;
    for (const c of this.S.world.cells) { if (!keep(c)) continue; const d = Math.hypot(c.xy[0] - xy[0], c.xy[1] - xy[1]); if (d < bestD) { best = c; bestD = d; } }
    return best;
  }
  // A blocked spot shows why it is blocked; a passing spot snaps to the nearest goal that has a recorded walk.
  target(xy) {
    const cell = this.nearest(xy);
    if (!cell || !cell.ok || cell.walk) return cell;
    return this.nearest(xy, 0.62, c => c.ok && c.walk) ?? cell;
  }
  hover(xy) {
    const S = this.S;
    if (!S.world || S.mode === 'playing' || S.mode === 'loading') return;
    const cell = xy ? this.target(xy) : null;
    if (cell === S.hover) return;
    S.hover = cell;
    this.viewer.setMarker('hoverMarker', cell ? cell.xy : null, { color: cell?.ok ? COLORS.white : COLORS.red, radius: 0.12, pin: false });
    if (S.mode === 'pick' || S.mode === 'done') this.renderGoal(cell, true);
  }
  // Clicking the floor always picks a new goal (a walk in progress is put away); Space or ▶ pause and resume.
  pick(xy) {
    const S = this.S;
    if (!S.world || S.mode === 'loading') return;
    const cell = this.target(xy);
    if (!cell) { this.flash('Outside the recorded room. Pick a spot on the floor.'); return; }
    S.clicked = xy;
    this.selectCell(cell);
  }
  selectCell(cell, { stage = false } = {}) {
    const S = this.S;
    if (!cell) return;
    this.pause();
    if (S.walk) this.resetRobot();
    S.selected = cell; S.staged = null; S.mode = 'pick';
    this.viewer.setMarker('goalMarker', cell.xy, { color: cell.ok ? COLORS.amber : COLORS.red });
    const path = cell.path?.length ? pairs(cell.path).map(p => [p[0], p[1], 0.03]) : null;
    this.viewer.setLine(this.lines.route, cell.ok ? path : null);
    if (stage && cell.ok && cell.walk) this.send();
    this.render();
  }
  random(failure = false) {
    this.S.clicked = null;
    const pool = this.S.recorded.filter(c => failure ? grade(c.walk).key !== 'clean' : grade(c.walk).key === 'clean' && c.walk.path_m > 1.5);
    const list = pool.length ? pool : this.S.recorded;
    if (!list.length) return;
    this.selectCell(list[Math.floor(Math.random() * list.length)], { stage: true });
  }
  send() {
    const S = this.S, c = S.selected;
    if (!c || !c.ok || !c.walk) return;
    S.staged = c; S.mode = 'staged';
    this.viewer.setMarker('goalMarker', c.xy, { color: COLORS.teal });
    history.replaceState(null, '', `#try/${S.worldId}/${c.id}`);
    this.render();
    $('pg-go').focus({ preventScroll: true });
  }
  async go() {
    const S = this.S, c = S.staged;
    if (!c || S.mode !== 'staged') return;
    S.mode = 'loading'; this.render();
    try {
      const walk = new Walk(await walkJson(`${DATA}/${S.worldId}/g/${c.id}.json`));
      if (S.staged !== c || S.mode !== 'loading') return;
      this.viewer.setMarker('hoverMarker', null);
      S.walk = walk; S.mapStep = -1;
      this.viewer.focus([S.world.start_xy, c.xy]);
      const stage = this.root.querySelector('.pg-stage').getBoundingClientRect();
      if (narrow() || stage.bottom > window.innerHeight || stage.top < 56) this.root.querySelector('.pg-stage').scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: narrow() ? 'start' : 'center' });
      this.seek(0); this.play();
    } catch (error) {
      S.mode = 'staged'; this.flash(`Could not load the walk: ${error.message}`); this.render();
    }
  }
  reset() {
    const S = this.S;
    this.pause();
    if (S.walk) this.resetRobot();
    Object.assign(S, { selected: null, staged: null, mode: 'pick', clicked: null });
    this.viewer.setMarker('goalMarker', null);
    this.viewer.setLine(this.lines.route, null);
    history.replaceState(null, '', `#try/${S.worldId}`);
    this.render();
  }

  // ----- playback
  play() {
    const S = this.S;
    if (!S.walk) return;
    if (S.t >= S.walk.duration - 1e-6) this.seek(0);
    S.playing = true; S.last = null; S.mode = 'playing';
    this.viewer.dimOutcomes(true); this.viewer.start(); this.render();
  }
  pause() { if (this.S.playing) { this.S.playing = false; this.renderTimeline(); } }
  togglePlay() { if (this.S.playing) this.pause(); else this.play(); }
  frame(now) {
    const S = this.S;
    if (!S.playing || !S.walk) return false;
    // A gap (scrolled away, another tab, a slow frame) does not jump the walk ahead.
    if (S.last !== null && now - S.last < 250) S.t = Math.min(S.walk.duration, S.t + (now - S.last) / 1000 * S.speed);
    S.last = now;
    this.apply();
    if (S.t >= S.walk.duration) { S.playing = false; S.mode = 'done'; this.render(); }
    else if (now - S.uiAt > 100) { S.uiAt = now; this.renderLive(); this.renderTimeline(); }
    return true;
  }
  seek(t) {
    const S = this.S;
    S.t = Math.max(0, Math.min(S.walk.duration, t));
    S.mode = S.t >= S.walk.duration ? 'done' : 'playing';
    this.apply();
    this.render();
  }
  apply() {
    const S = this.S, w = S.walk, v = this.viewer;
    v.setPose(w.pose(S.t, this.pose));
    // The robot's map: changes up to now (rebuilt from the pre-walk map when seeking back).
    let step = S.mapStep;
    if (step >= 0 && w.map[step].t > S.t + 1e-9) { v.setMapBase(S.world.map); step = -1; }
    while (step + 1 < w.map.length && w.map[step + 1].t <= S.t + 1e-9) { step++; v.applyMapChanges(w.map[step]); }
    S.mapStep = step;
    const k = w.index(S.t);
    if (k !== S.trailIndex) {
      S.trailIndex = k;
      v.setLine(this.lines.trail, w.trail.slice(0, k + 1).concat([[this.pose[0], this.pose[1], 0.02]]));
      v.setMarker('estMarker', [w.est[k * 2] / 1000, w.est[k * 2 + 1] / 1000], { color: COLORS.blue, radius: 0.1, pin: false });
    }
    const plan = S.layers.plan && w.phase(S.t) === 'RUN' ? w.plan(S.t) : null;
    if (plan !== S.planShown) { S.planShown = plan; v.setLine(this.lines.plan, plan && plan.rule !== 'stand' ? plan.points : null); }
    const lidar = S.layers.lidar ? w.lidarAt(S.t) : null;
    if (lidar !== S.lidarShown) { S.lidarShown = lidar; v.setLidar(lidar); }
  }

  // ----- layers and camera
  toggleLayer(name, button) {
    const S = this.S, L = S.layers;
    if (name === 'world') {
      L.world = { ghost: 'solid', solid: 'hidden', hidden: 'ghost' }[L.world];
      this.viewer.setBoxesStyle(L.world); button.dataset.state = L.world;
      button.querySelector('small').textContent = { ghost: 'ghost', solid: 'solid', hidden: 'off' }[L.world];
      return;
    }
    L[name] = !L[name];
    button.setAttribute('aria-pressed', String(L[name]));
    if (name === 'map') { this.viewer.groups.map.visible = this.viewer.groups.voxels.visible = L.map; this.viewer.dirty(); }
    if (name === 'outcomes') this.paintOutcomes();
    if (name === 'lidar') { this.viewer.groups.lidar.visible = L.lidar; S.lidarShown = undefined; if (S.walk) this.apply(); else this.viewer.setLidar(L.lidar ? S.world.start_lidar : null); }
    if (name === 'plan') { this.viewer.groups.plan.visible = L.plan; this.viewer.dirty(); }
  }
  camera(mode, button) {
    if (mode === 'follow') {
      this.viewer.follow = !this.viewer.follow;
      button.setAttribute('aria-pressed', String(this.viewer.follow));
      return;
    }
    for (const b of this.root.querySelectorAll('[data-camera]')) b.setAttribute('aria-pressed', String(b === button));
    this.viewer.follow = false;
    this.viewer.frame(this.S.world, mode);
  }

  // ----- panel
  flash(text) { const n = $('pg-flash'); n.textContent = text; n.hidden = false; clearTimeout(this._flash); this._flash = setTimeout(() => { n.hidden = true; }, 4000); }
  render() {
    const S = this.S, c = S.selected;
    this.root.dataset.mode = S.mode;
    this.renderGoal(c, false);
    $('pg-send').hidden = S.mode !== 'pick';
    $('pg-send').disabled = !(c && c.ok && c.walk);
    $('pg-go').hidden = S.mode !== 'staged' && S.mode !== 'loading';
    $('pg-go').disabled = S.mode !== 'staged';
    $('pg-go').textContent = S.mode === 'loading' ? 'Loading the walk…' : 'Go';
    $('pg-clear').hidden = !c && !S.walk;
    $('pg-clear').textContent = S.walk ? 'New goal' : 'Clear';
    $('pg-staged').hidden = S.mode !== 'staged';
    this.renderLive();
    this.renderTimeline();
    this.renderOutcome();
  }
  renderGoal(cell, preview) {
    const S = this.S, box = $('pg-goal');
    if (!preview && !cell) { box.innerHTML = `<p class="hint">Click the floor to pick a goal. The checks Studio runs before anything is sent appear here.</p>`; return; }
    if (preview && S.selected && S.mode !== 'done') return;
    if (!cell) { if (preview) this.renderGoal(S.selected, false); return; }
    const ids = S.world.check_ids, labels = [...cell.l];
    const rows = ids.map((id, k) => {
      const [status, icon] = STATUS[cell.s[k]] ?? ['warn', '?'];
      const label = status === 'pass' ? CHECKS[id].pass : labels.shift();
      const why = status === 'pass' ? '' : `<small>${escape(CHECKS[id].why)}</small>`;
      return `<li class="check ${status}" title="${escape(CHECKS[id].why)}"><span class="icon" aria-label="${status}">${icon}</span><span class="name">${escape(CHECKS[id].name)}</span><span class="label">${escape(label)}${why}</span></li>`;
    }).join('');
    const dist = Math.hypot(cell.xy[0] - S.world.start_xy[0], cell.xy[1] - S.world.start_xy[1]);
    const onlyCommon = cell.ok && cell.l.length && cell.l.every(l => COMMON_WARNINGS.has(l));
    const verdict = !cell.ok ? (cell.s.includes('b') ? `<span class="verdict block">Blocked: Studio would not send this goal</span>` : `<span class="verdict block">Within 0.8 m of the start: nothing to walk</span>`)
      : !cell.walk ? `<span class="verdict warn">Passes, but this goal has not been recorded</span>`
      : `<span class="verdict pass">Passes${cell.s.includes('w') ? ' with warnings' : ''}</span>`;
    const note = onlyCommon ? `<p class="fineprint">From the start mark the robot has seen little of the room, so Studio warns about unseen space; the planner explores as it walks.</p>` : '';
    const g = cell.walk ? grade(cell.walk) : null;
    const known = g && S.layers.outcomes ? ` · recorded: <b style="color:${css(g.color)}">${escape(g.label)}</b>` : '';
    const snap = !preview && S.clicked ? Math.hypot(S.clicked[0] - cell.xy[0], S.clicked[1] - cell.xy[1]) : 0;
    box.innerHTML = `<div class="goal-head"><b>Goal ${fmt(cell.xy[0], 2)}, ${fmt(cell.xy[1], 2)} m</b><span>${fmt(dist, 1)} m straight${cell.path_m ? ` · route ${fmt(cell.path_m, 1)} m` : ''}${known}</span>${snap > 0.05 ? `<span>Snapped ${fmt(snap, 2)} m to the nearest recorded goal</span>` : ''}</div>
      <ul class="checks">${rows}</ul>${verdict}${note}`;
  }
  renderLive() {
    const S = this.S, w = S.walk;
    const phase = w ? w.phase(S.t) : 'WAIT';
    const p = PHASE[phase] ?? { label: phase, color: '#8aa0ad' };
    $('pg-phase').textContent = p.label; $('pg-phase').style.setProperty('--c', p.color);
    $('pg-phase').title = p.why ?? '';
    if (!w) {
      setText('pg-status', S.mode === 'staged' ? 'Standing. The goal is staged; the walk starts only when the operator presses Go.'
        : S.mode === 'loading' ? 'Loading the walk…' : 'Standing at the start mark, waiting for a goal.');
      $('pg-facts').innerHTML = '';
      return;
    }
    const k = w.index(S.t), plan = w.plan(S.t);
    const dist = w.goal_cm[k] === null ? null : w.goal_cm[k] / 100;
    const tilt = w.tilt_mrad[k], contact = w.contact_n[k];
    setText('pg-status', p.text ?? '');
    $('pg-facts').innerHTML = [
      ['Time', `${fmt(S.t, 1)} s`, '', 'Simulated time since Go'],
      ['To goal (est.)', dist === null ? '—' : `${fmt(dist, 2)} m`, '', "By the robot's own estimate (LIO-level drift), as node.py measures it"],
      ['Tilt', tilt === null ? '—' : `${fmt(tilt / 1000 * 57.2958, 1)}°`, '', 'Simulator truth; the E-stop is at 0.75 rad (43°)'],
      ['Contact', contact === null ? '—' : contact > 0 ? `${contact} N` : 'none', contact > 100 ? 'hot' : '', 'Obstacle contact force, simulator truth'],
      ['Planner rule', plan ? (RULES[plan.rule]?.label ?? plan.rule.replaceAll('_', ' ')) : '—', 'wide', plan ? RULES[plan.rule]?.why ?? '' : ''],
    ].map(([a, b, cls, title]) => `<div class="${cls}" title="${escape(title)}"><span>${a}</span><b>${escape(b)}</b></div>`).join('');
  }
  renderTimeline() {
    const S = this.S, w = S.walk, bar = $('pg-timeline');
    bar.hidden = !w;
    if (!w) return;
    $('pg-play').textContent = S.playing ? '❚❚' : '▶';
    $('pg-play').setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    if (document.activeElement !== $('pg-scrub')) $('pg-scrub').value = String(Math.round(S.t / w.duration * 1000));
    $('pg-scrub').setAttribute('aria-valuetext', `${fmt(S.t, 1)} of ${fmt(w.duration, 1)} seconds`);
    $('pg-time').textContent = `${fmt(S.t, 1)} / ${fmt(w.duration, 1)} s`;
    if (bar.dataset.walk !== `${S.worldId}/${w.goal_id}`) {
      bar.dataset.walk = `${S.worldId}/${w.goal_id}`;
      const bands = w.phases.map(([i, ph], k) => {
        const t0 = w.times[i], t1 = k + 1 < w.phases.length ? w.times[w.phases[k + 1][0]] : w.duration;
        return `<span style="left:${t0 / w.duration * 100}%;width:${(t1 - t0) / w.duration * 100}%;background:${PHASE[ph]?.color ?? '#555'}" title="${escape(PHASE[ph]?.label ?? ph)}"></span>`;
      }).join('');
      const marks = w.events.filter(e => !['waiting', 'goal', 'prescan', 'run', 'walk_end', 'ended'].includes(e.type))
        .map(e => `<i class="${e.type === 'contact' ? 'hot' : ''}" style="left:${e.t / w.duration * 100}%" title="${escape(`${fmt(e.t, 1)} s · ${e.msg}`)}"></i>`).join('');
      $('pg-bands').innerHTML = bands + marks;
    }
  }
  renderOutcome() {
    const S = this.S, w = S.walk, box = $('pg-outcome'), chip = $('pg-result');
    const done = S.mode === 'done' && !!w;
    box.hidden = !done; chip.hidden = !done;
    if (!done) return;
    const g = grade(w), o = OUTCOME[w.outcome] ?? { text: '' };
    box.style.setProperty('--c', css(g.color)); chip.style.setProperty('--c', css(g.color));
    const contact = w.max_contact_n ?? null;
    const arrival = w.events.find(e => e.type === 'arrived')?.dist ?? null;
    const lines = [
      w.outcome === 'arrived' ? `It arrived ${arrival === null ? '' : `${fmt(arrival, 2)} m from the goal `}by its own estimate (node.py's rule: within 0.4 m) and stood. When the walk ended it was ${fmt(w.final_dist_estimate_m, 2)} m away by its estimate and ${fmt(w.final_dist_m, 2)} m by simulator truth.` : o.text,
      w.reason ? `Reason: ${reasonText(w.reason)}.` : '',
      contact === null ? '' : contact > 100 ? `It touched an obstacle: up to ${Math.round(contact)} N (Studio flags contact over 100 N).` : 'No obstacle contact over 100 N.',
      w.events.some(e => e.type === 'stand_deferred') ? 'Its stand was deferred under a low "ceiling" in its map' + (w.events.some(e => e.type === 'stand_forced') ? ', then forced after 20 s (a Studio limit in simulation).' : '.') : '',
    ].filter(Boolean);
    $('pg-outcome-title').textContent = g.label;
    $('pg-outcome-text').textContent = lines.join(' ');
    $('pg-outcome-facts').innerHTML = [
      ['Walk', `${fmt(w.duration_s, 1)} s`], ['Path', `${fmt(w.path_m, 2)} m`],
      ['Final, truth', `${fmt(w.final_dist_m, 2)} m`], ['Final, estimate', `${fmt(w.final_dist_estimate_m, 2)} m`],
      ['Max contact', contact === null ? '—' : `${Math.round(contact)} N`], ['Plans', w.plans_n ?? '—'],
    ].map(([a, b]) => `<div><span>${a}</span><b>${escape(String(b))}</b></div>`).join('');
    $('pg-outcome-meta').textContent = `Grades: green arrived cleanly; amber arrived with contact over 100 N, or ended more than 0.6 m from the goal by truth (node.py's radius is 0.4 m, by its estimate); red E-stop or fall. Recorded on CPU MuJoCo at ${fmt(w.rtf, 2)}× real time; seed ${S.world.settings?.seed ?? 0}; planner ${S.world.settings?.planner?.candidates ?? '?'} candidates, ${S.world.settings?.planner?.ode_steps ?? '?'} ODE steps.`;
    chip.innerHTML = `<b>${escape(g.label)}</b> · ends ${fmt(w.final_dist_m, 2)} m from the goal (truth)${contact > 100 ? ` · contact ${Math.round(contact)} N` : ''}`;
  }
}

// "tilt 0.75 rad > 0.75" reads as false at two decimals: say what the rule is instead.
const reasonText = r => r.replace(/tilt ([\d.]+) rad > ([\d.]+)/, (_, a, b) => `tilted past the ${b} rad E-stop limit`);
function setText(id, text) { const n = $(id); if (n.textContent !== text) n.textContent = text; }
function parseHash() {
  const m = location.hash.match(/^#try(?:\/([a-z]+))?(?:\/(g\d\d-\d\d))?(\/play)?$/);
  return m ? { world: m[1], goal: m[2], play: !!m[3] } : null;
}
const pairs = flat => { const out = []; for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]); return out; };
const css = c => `#${(c ?? 0x888888).toString(16).padStart(6, '0')}`;
