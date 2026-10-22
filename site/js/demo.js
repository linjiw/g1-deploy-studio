// The Navigate demo: Studio's workflow on recorded, simulated walks of the deploy stack, on a full-bleed stage.
// Pick a goal on the robot's map, read Studio's goal checks where you clicked, send it, press Go as the operator
// does, and watch the walk the stack made: the robot (simulator truth), its own estimate, its LiDAR, the map it
// builds, the plan and, as a ghost, the plan body (the reference pose SONIC is tracking).
import { Viewer, COLORS } from './viewer.js';
import { DATA, json, walkJson, decodeWorld, Walk } from './data.js';
import { fmt, escape, OUTCOME, PHASE, RULES, GRADES, grade, reducedMotion } from './util.js';

const CHECKS = {
  inside: { name: 'Inside', pass: 'Inside the map', why: "The goal must lie in the planner's 12 × 12 m memory, at least 0.5 m from its edge." },
  seen: { name: 'Seen', pass: 'Seen', why: 'Has the LiDAR seen this spot? Unseen goals pass with a warning: the planner explores as it sees more.' },
  free: { name: 'Free', pass: 'Free of obstacles', why: 'Blocks if anything taller than the 0.25 m step-over is within 0.30 m of the goal; route margins and low obstacles nearby warn.' },
  overhead: { name: 'Overhead', pass: 'No low overhead obstacle', why: "The navigation node will not stand up where its map holds anything lower than 1.35 m within 0.8 m. Studio blocks such goals and warns near them." },
  reachable: { name: 'Reachable', pass: 'Reachable', why: "A route through what the robot has seen, 0.35 m clear of anything taller than 0.25 m; unseen space counts as free, as in the planner's own route finder." },
  distance: { name: 'Distance', pass: 'Distance', why: 'Straight-line and route length from the start mark.' },
};
const STATUS = { p: ['pass', '✓'], w: ['warn', '!'], b: ['block', '✕'] };
const SPEEDS = [0.5, 1, 2, 4];
const LAYERS = [
  { id: 'robot', label: 'Robot', dot: '#d5dde3', key: 'v', why: 'The simulated G1 (simulator truth), the path it walked (teal) and, as a blue ring, where it thinks it is.' },
  { id: 'body', label: 'Plan body', dot: '#ffb3dc', key: 'b', why: "The pose SONIC is chasing at this instant: the reference it tracks. Its root is the planner's (SONIC is never given it)." },
  { id: 'map', label: 'Its map', dot: '#efbb70', key: 'm', why: "The planner's memory: floor it has seen, low obstacles it steps over, obstacles at their seen height, overhead cells." },
  { id: 'lidar', label: 'LiDAR', dot: '#7fe0d2', key: 'l', why: 'The latest LiDAR returns, after the robot\'s own body is filtered out.' },
  { id: 'plan', label: 'Plan path', dot: '#ff6fb5', key: 'p', why: 'The plan the tracker is following right now: its pelvis path, at pelvis height.' },
  { id: 'world', label: 'Real room', dot: '#8fa4b3', key: 'w', why: 'The simulation\'s real boxes. The robot never receives them; it only knows its map. Click to cycle ghost, solid, off.' },
  { id: 'outcomes', label: 'Outcomes', dot: '#7be0a5', key: 'o', why: 'Every recorded goal, coloured by how its walk ended.' },
];
const WRONG_ORDER = ['fell', 'estop', 'stopped', 'away', 'off', 'contact'];
// The readout: [key, label, kind of value, what it is, class].
const HUD = [
  ['goal', 'To goal', 'estimate', "By the robot's own estimate (LIO-level drift), as node.py measures it", ''],
  ['tilt', 'Tilt', 'truth', 'Simulator truth; the E-stop is at 0.75 rad (43°)', ''],
  ['contact', 'Contact', 'truth', 'Obstacle contact force, simulator truth', ''],
  ['body', 'Plan body', 'off by', "How far the plan body's pelvis is from where the robot thinks its pelvis is (when they differ: walking, or a deferred stand holding the plan's last frame)", ''],
  ['planner', 'Planner', 'its rule', "The planner's choice among its sampled candidates", 'wide'],
  ['event', 'Last event', 'log', 'The most recent event of the walk, as the navigation node or Studio logged it', 'wide'],
];
const QUIET = new Set(['waiting', 'goal', 'prescan', 'run', 'walk_end', 'ended']);

export async function mountDemo(root, options = {}) {
  const demo = new Demo(root, options);
  await demo.init();
  return demo;
}

class Demo {
  constructor(root, { embedded = false, hashPrefix = '', fullHref = null, home = null, progress = () => {}, onStop = null } = {}) {
    Object.assign(this, { root, embedded, hashPrefix, fullHref, home, progress, onStop });
    // Every listener outside the demo's own nodes goes through this, so Stop leaves nothing behind.
    this.abort = new AbortController();
    const sig = { signal: this.abort.signal };
    this.S = { worldId: null, world: null, selected: null, staged: null, mode: 'pick', walk: null, t: 0, playing: false,
               speed: 1, last: null, mapStep: -1, trailIndex: -1, planShown: null, lidarShown: null, uiAt: 0, hover: null, clicked: null,
               loadToken: 0, phase: null, events: 0, picked: false, folder: null, filter: 'all', detail: false,
               layers: { robot: true, body: true, map: true, lidar: true, plan: true, world: 'ghost', outcomes: true } };
    root.classList.add('demo', embedded ? 'embedded' : 'standalone');
    root.insertAdjacentHTML('beforeend', template({ embedded, home, stop: !!onStop }));
    this.el = {};
    for (const n of root.querySelectorAll('[data-el]')) this.el[n.dataset.el] = n;
    this.viewer = new Viewer(this.el.canvas, { onPick: xy => this.pick(xy), onHover: xy => this.hover(xy) });
    this.viewer.onFrame = now => this.frame(now);
    this.viewer.onRender = () => this.place();
    // A full-bleed stage owns every gesture; inside the page a vertical swipe still scrolls the page.
    this.viewer.renderer.domElement.style.touchAction = embedded && matchMedia('(pointer: coarse)').matches ? 'pan-y' : 'none';
    const v = this.viewer;
    this.lines = { route: v.line(COLORS.white, 2, { dashed: true, opacity: 0.8 }), plan: v.line(COLORS.pink, 4), trail: v.line(COLORS.teal, 3, { opacity: 0.9 }) };
    v.groups.route.add(this.lines.route); v.groups.plan.add(this.lines.plan); v.groups.trail.add(this.lines.trail);
    this.pose = new Float64Array(36); this.refPose = new Float64Array(36);
    this.cameraMode = 'orbit';
    // Inside the page the keys belong to the demo only after a visitor has clicked or tabbed into it; a full-bleed
    // demo always has them.
    this.engaged = !embedded;
    if (embedded) {
      document.addEventListener('pointerdown', e => { this.engaged = root.contains(e.target); }, { capture: true, ...sig });
      root.addEventListener('focusin', () => { this.engaged = true; }, sig);
      root.addEventListener('focusout', e => { if (e.relatedTarget && !root.contains(e.relatedTarget)) this.engaged = false; }, sig);
    }
    // Narrow stages (phones, small slots) dock the goal checks and the result as sheets above the dock.
    this.observers = [new ResizeObserver(() => { this.root.classList.toggle('narrow', this.root.clientWidth < 640); this.place(); })];
    this.observers[0].observe(root);
    // Sheets and the result sit above the dock, whose height depends on how it wraps.
    this.observers.push(new ResizeObserver(() => root.style.setProperty('--dock-h', `${this.el.dock.offsetHeight}px`)));
    this.observers[1].observe(this.el.dock);
    this.bind();
  }

  async init() {
    this.progress(0.35, 'Loading the robot');
    const [catalog] = await Promise.all([json('worlds.json'), this.viewer.loadRobot(DATA, f => this.progress(0.35 + 0.5 * f, 'Loading the robot'))]);
    this.catalog = catalog.worlds;
    this.viewer.ghost('plan', { opacity: 0.42 });
    const h = this.parseHash();
    this.progress(0.88, 'Loading the room');
    await this.loadWorld(h?.world && this.catalog.some(w => w.id === h.world) ? h.world : this.catalog[0].id, { keepHash: true });
    this.progress(1, 'Ready');
    this.root.classList.add('is-ready');
    window.addEventListener('hashchange', () => this.fromHash(), { signal: this.abort.signal });
    if (h?.goal) await this.fromHash();
    else this.live('Standing at the start mark. Click the floor to pick a goal, or open the room menu.');
  }

  // ----- hash: [#try/]<room>[/<goal>[/play[@seconds]]]
  parseHash() {
    const m = location.hash.slice(1).match(new RegExp(`^${this.hashPrefix.replace('/', '\\/')}([a-z]+)(?:\\/(g\\d\\d-\\d\\d))?(\\/play(?:@(\\d+(?:\\.\\d+)?))?)?$`));
    return m ? { world: m[1], goal: m[2], play: !!m[3], at: m[4] ? Number(m[4]) : null } : null;
  }
  writeHash(path) {
    if (this.el.full) this.el.full.href = `${this.fullHref}#${path}`;
    // Inside the main page, only a hash the demo owns (or none) is replaced: section links stay as they are.
    if (this.embedded && location.hash && !location.hash.startsWith(`#${this.hashPrefix}`)) return;
    history.replaceState(null, '', `#${this.hashPrefix}${path}`);
  }
  async fromHash() {
    const h = this.parseHash();
    if (!h) return;
    if (h.world && !this.catalog.some(w => w.id === h.world)) { this.flash('That room is not in this recording.'); return; }
    if (h.world && h.world !== this.S.worldId && !(await this.loadWorld(h.world, { keepHash: true }))) return;
    if (!h.goal || this.S.worldId !== h.world) return;  // goal ids repeat across rooms: only this room's
    const cell = this.S.world.cells.find(c => c.id === h.goal);
    if (!cell || !cell.walk) { this.flash('That walk is not in this recording.'); return; }
    if (this.embedded) this.root.scrollIntoView({ behavior: reducedMotion() ? 'auto' : 'smooth', block: 'center' });
    this.S.clicked = null;
    this.selectCell(cell, { stage: true });
    if (h.play && this.S.mode === 'staged') await this.go({ at: h.at ?? 0, autoplay: !reducedMotion() });
  }

  bind() {
    const E = this.el;
    E.go.addEventListener('click', () => this.go());
    E.reset.addEventListener('click', () => this.reset());
    E.play.addEventListener('click', () => this.togglePlay());
    E.speed.addEventListener('click', () => this.cycleSpeed());
    E.rooms.addEventListener('click', () => this.togglePicker());
    E.pickerClose.addEventListener('click', () => this.togglePicker(false));
    E.shuffle.addEventListener('click', () => this.shuffle());
    E.helpBtn.addEventListener('click', () => this.toggleHelp());
    E.helpClose.addEventListener('click', () => this.toggleHelp(false));
    E.chip.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'send') this.send();
      if (b.dataset.act === 'go') this.go();
      if (b.dataset.act === 'clear') this.reset();
      if (b.dataset.act === 'more') { this.S.detail = !this.S.detail; this.renderChip(); }
    });
    E.result.addEventListener('click', e => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.act === 'replay') { this.seek(0); this.play(); }
      if (b.dataset.act === 'new') this.reset();
      if (b.dataset.act === 'wrong') this.togglePicker(true, 'wrong');
      if (b.dataset.act === 'compare') this.compare();
      if (b.dataset.act === 'link') this.copyLink();
    });
    const scrub = E.scrub;
    scrub.addEventListener('input', () => {
      if (!this.S.walk) return;
      const t = Number(scrub.value) / 1000 * this.S.walk.duration;  // read before anything re-renders the slider
      this.S.playing = false;
      this.seek(t);
    });
    for (const b of this.root.querySelectorAll('[data-layer]')) b.addEventListener('click', () => this.toggleLayer(b.dataset.layer));
    for (const b of this.root.querySelectorAll('[data-camera]')) b.addEventListener('click', () => this.camera(b.dataset.camera));
    E.folders.addEventListener('click', e => { const b = e.target.closest('[data-folder]'); if (b) { this.S.folder = b.dataset.folder; this.S.filter = 'all'; this.renderPicker(); } });
    E.filters.addEventListener('click', e => { const b = e.target.closest('[data-filter]'); if (b) { this.S.filter = b.dataset.filter; this.renderPicker(); } });
    E.walkList.addEventListener('click', e => { const b = e.target.closest('[data-walk]'); if (b) this.watch(b.dataset.room, b.dataset.walk); });
    const preview = e => {
      const b = e.target.closest?.('[data-walk]'), cell = b && b.dataset.room === this.S.worldId ? this.S.world.cells.find(c => c.id === b.dataset.walk) : null;
      this.viewer.setMarker('hoverMarker', cell ? cell.xy : null, { color: COLORS.white, radius: 0.14, pin: true });
    };
    E.walkList.addEventListener('pointerover', preview); E.walkList.addEventListener('focusin', preview);
    E.walkList.addEventListener('pointerleave', () => this.viewer.setMarker('hoverMarker', null));
    const sig = { signal: this.abort.signal };
    document.addEventListener('pointerdown', e => {
      this.swallow = false;
      if (!E.picker.hidden && !E.picker.contains(e.target) && !E.rooms.contains(e.target)) { this.togglePicker(false); this.swallow = true; }
    }, sig);
    window.addEventListener('keydown', e => this.key(e), sig);
    E.stop?.addEventListener('click', () => this.onStop?.());
  }
  // Stop: the page's poster comes back; the WebGL context, observers and listeners go.
  destroy() {
    this.abort.abort();
    clearTimeout(this._ghostTip);
    for (const o of this.observers) o.disconnect();
    clearTimeout(this._splash); clearTimeout(this._flash);
    this.viewer.dispose();
  }
  inView() {
    if (!this.embedded) return true;
    const r = this.root.getBoundingClientRect();
    return r.bottom > 120 && r.top < window.innerHeight - 120;
  }
  key(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || !this.engaged || !this.inView()) return;
    if (e.target.closest('input:not([type=range]), textarea, select, [contenteditable]')) return;
    if (e.target.closest('.stage') && !this.root.contains(e.target)) return;  // another stage has the keys
    const k = e.key, S = this.S;
    if (k === 'Escape') {
      if (!this.el.picker.hidden) { this.togglePicker(false); this.el.rooms.focus(); }
      else if (!this.el.help.hidden) this.toggleHelp(false);
      else if (!S.walk && S.selected) this.reset();
      return;
    }
    // Space keeps its meaning on buttons, links and the slider; the letters work wherever focus is.
    if (k === ' ' && S.walk && !e.target.closest('button, a, input, summary')) { e.preventDefault(); this.togglePlay(); return; }
    const lower = k.length === 1 ? k.toLowerCase() : k;
    if (lower === 'g' && S.mode === 'staged') { e.preventDefault(); this.go(); return; }
    if (lower === 'r') { this.reset(); return; }
    if (lower === '?') { this.toggleHelp(); return; }
    if (lower === 'c') { this.camera({ orbit: 'top', top: 'follow', follow: 'orbit' }[this.cameraMode ?? 'orbit']); return; }
    if (lower === 'f') { this.camera('follow'); return; }
    if (lower === 'n') { this.togglePicker(); return; }
    if (/^[1-9]$/.test(k) && this.catalog[Number(k) - 1]) { this.loadWorld(this.catalog[Number(k) - 1].id); return; }
    if (!S.walk && e.target === this.el.canvas && /^Arrow/.test(k)) { e.preventDefault(); this.moveCursor(k); return; }
    if (!S.walk && e.target === this.el.canvas && k === 'Enter' && S.cursor) { e.preventDefault(); this.pick(S.cursor); this.focusIn(this.el.chip.querySelector('[data-act="send"]')); return; }
    if (S.walk && (k === 'ArrowLeft' || k === 'ArrowRight') && !e.target.closest('input')) {
      e.preventDefault(); this.pause(); this.seek(S.t + (k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 0.04 : 1)); return;
    }
    const layer = LAYERS.find(l => l.key === lower);
    if (layer) this.toggleLayer(layer.id);
  }

  // ----- rooms
  async loadWorld(id, { keepHash = false } = {}) {
    const S = this.S;
    if (S.worldId === id && S.world) { ++S.loadToken; return true; }  // the last room asked for wins
    const token = ++S.loadToken;
    this.pause();
    this.live('Loading the room…');
    let world;
    try {
      world = decodeWorld(await json(`${id}/index.json`));
    } catch (error) {
      if (token === S.loadToken) this.flash(`Could not load this room: ${error.message}`);
      return false;
    }
    if (token !== S.loadToken) return false;  // a later click won
    Object.assign(S, { worldId: id, world, walk: null, selected: null, staged: null, mode: 'pick', hover: null, clicked: null });
    const v = this.viewer;
    v.setMarker('goalMarker', null); v.setMarker('hoverMarker', null); v.setLine(this.lines.route, null);
    S.recorded = world.cells.filter(c => c.walk);
    v.setWorld(world);
    v.setBoxesStyle(S.layers.world);
    v.frame(world, this.cameraMode === 'top' ? 'top' : 'orbit');
    this.resetRobot();
    this.paintOutcomes();
    const entry = this.catalog.find(w => w.id === id);
    this.el.roomName.textContent = world.title;
    this.el.roomCount.textContent = `${entry?.walks ?? S.recorded.length}`;
    this.root.dataset.room = id;
    if (!keepHash) this.writeHash(id);
    else if (this.el.full) this.el.full.href = `${this.fullHref}#${id}`;
    this.render();
    if (!keepHash) this.splash(world.title, `${S.recorded.length} recorded walks · click the floor`);
    return true;
  }
  paintOutcomes() { this.viewer.setOutcomes(this.S.layers.outcomes ? this.S.recorded : [], c => grade(c.walk).color); }

  resetRobot() {
    const S = this.S, w = S.world, v = this.viewer;
    v.dimOutcomes(false);
    Object.assign(S, { walk: null, t: 0, playing: false, mapStep: -1, trailIndex: -1, trailWalk: null, planShown: null, lidarShown: null, phase: null, events: 0 });
    v.setMapBase(w.map);
    v.setLidar(S.layers.lidar ? w.start_lidar : null);
    v.setPose(w.startPose);
    v.setGhost('plan', null);
    v.setMarker('estMarker', null);
    v.setLine(this.lines.plan, null);
    v.setLine(this.lines.trail, null);
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
    this.viewer.setMarker('hoverMarker', cell && cell !== S.selected ? cell.xy : null, { color: cell?.ok ? COLORS.white : COLORS.red, radius: 0.12, pin: false });
  }
  // The keyboard's goal cursor: 0.4 m steps, up is away from the camera.
  moveCursor(key) {
    const S = this.S, v = this.viewer, c = v.camera.position, t = v.controls.target;
    let fx = t.x - c.x, fy = t.y - c.y; const n = Math.hypot(fx, fy) || 1; fx /= n; fy /= n;
    const step = { ArrowUp: [fx, fy], ArrowDown: [-fx, -fy], ArrowRight: [fy, -fx], ArrowLeft: [-fy, fx] }[key];
    S.cursor ??= [S.world.start_xy[0] + Math.cos(S.world.start_yaw_rad) * 1.2, S.world.start_xy[1] + Math.sin(S.world.start_yaw_rad) * 1.2];
    S.cursor = [S.cursor[0] + step[0] * 0.4, S.cursor[1] + step[1] * 0.4];
    const cell = this.target(S.cursor);
    this.viewer.setMarker('hoverMarker', S.cursor, { color: cell?.ok ? COLORS.white : COLORS.red, radius: 0.16, pin: true });
    if (!cell) { this.live('Outside the recorded room.'); return; }
    const d = Math.hypot(cell.xy[0] - S.world.start_xy[0], cell.xy[1] - S.world.start_xy[1]);
    this.live(`${fmt(d, 1)} m from the start: ${verdict(cell).text}. Enter picks it.`);
  }
  // Clicking the floor always picks a new goal (a walk in progress is put away).
  pick(xy) {
    const S = this.S;
    if (!S.world || S.mode === 'loading' || this.swallow) return;
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
    S.selected = cell; S.staged = null; S.mode = 'pick'; S.detail = false;
    if (!S.picked) { S.picked = true; this.root.classList.add('picked'); }
    this.viewer.setMarker('hoverMarker', null);
    this.viewer.setMarker('goalMarker', cell.xy, { color: cell.ok ? COLORS.amber : COLORS.red });
    const path = cell.path?.length ? pairs(cell.path).map(p => [p[0], p[1], 0.03]) : null;
    this.viewer.setLine(this.lines.route, cell.ok ? path : null);
    if (stage && cell.ok && cell.walk) this.send({ quiet: true });
    else {
      const v = verdict(cell);
      this.live(`Goal at ${fmt(cell.xy[0], 1)}, ${fmt(cell.xy[1], 1)} m. ${v.text}.${v.sendable ? ' Send it to stage it.' : ''}`);
    }
    this.render();
  }
  shuffle() {
    const pool = this.pool();
    const list = pool.length ? pool : (this.catalog.flatMap(w => listOf(w)).filter(x => x.grade === 'clean'));
    if (!list.length) return;
    const w = list[Math.floor(Math.random() * list.length)];
    this.watch(w.room, w.id);
  }
  send({ quiet = false } = {}) {
    const S = this.S, c = S.selected;
    if (!c || !c.ok || !c.walk) return;
    S.staged = c; S.mode = 'staged';
    this.viewer.setMarker('goalMarker', c.xy, { color: COLORS.teal });
    this.writeHash(`${S.worldId}/${c.id}`);
    this.render();
    if (!quiet) this.splash('Goal sent and read back', 'Nothing moves until the operator presses Go');
    this.focusIn(this.el.chip.querySelector('[data-act="go"]') ?? this.el.go);
  }
  async go({ at = 0, autoplay = true } = {}) {
    const S = this.S, c = S.staged;
    if (!c || S.mode !== 'staged') return;
    S.mode = 'loading'; this.render();
    try {
      const walk = new Walk(await walkJson(`${S.worldId}/g/${c.id}.json`));
      if (S.staged !== c || S.mode !== 'loading') return;
      this.viewer.setMarker('hoverMarker', null);
      S.walk = walk; S.mapStep = -1; S.phase = null; S.events = 0;
      this.writeHash(`${S.worldId}/${c.id}/play`);
      this.viewer.focus([S.world.start_xy, c.xy]);
      if (this.root.classList.contains('narrow') && this.cameraMode === 'orbit') {
        // On a phone the room is small: walk with the robot instead (Orbit brings the room back).
        this.viewer.look([S.world.start_xy[0], S.world.start_xy[1], 0.6], { yaw: S.world.start_yaw_rad + Math.PI + 0.6, pitch: 0.55, distance: 4.2 });
        this.camera('follow');
      }
      this.seek(at);
      if (autoplay) this.play();
      if (this.root.contains(document.activeElement) && document.activeElement.disabled !== false) this.el.play.focus({ preventScroll: true });
      if (!at) this.splash('Pre-scan, then walk', 'node.py stands for 0.5 s while the LiDAR fills its map');
    } catch (error) {
      S.mode = 'staged'; this.flash(`Could not load the walk: ${error.message}`); this.render();
    }
  }
  // From the picker or a link: open the room, stage the walk's goal and play it.
  async watch(room, id, { play = false } = {}) {
    this.togglePicker(false);
    if (room !== this.S.worldId && !(await this.loadWorld(room))) return;
    if (this.S.worldId !== room) return;  // another room won meanwhile; goal ids repeat across rooms
    const cell = this.S.world.cells.find(c => c.id === id);
    if (!cell) return;
    this.S.clicked = null;
    if (play) { this.selectCell(cell, { stage: true }); await this.go(); this.focusIn(this.el.play); return; }
    // The operator's steps still apply: the goal and its checks, then Send, then Go.
    this.selectCell(cell);
    this.S.detail = true; this.renderChip(); this.place();
    this.focusIn(this.el.chip.querySelector('[data-act="send"]'));
  }
  // Focus a control and keep it on screen (inside the page the stage may be partly scrolled away).
  focusIn(node) {
    if (!node || node.disabled) return;
    node.focus({ preventScroll: true });
    if (this.embedded) node.scrollIntoView({ block: 'nearest', behavior: reducedMotion() ? 'auto' : 'smooth' });
  }
  reset() {
    const S = this.S;
    this.pause();
    if (S.walk) this.resetRobot();
    Object.assign(S, { selected: null, staged: null, mode: 'pick', clicked: null, detail: false });
    this.viewer.setMarker('goalMarker', null);
    this.viewer.setLine(this.lines.route, null);
    this.writeHash(S.worldId);
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
  pause() { if (this.S.playing) { this.S.playing = false; this.renderDock(); } }
  togglePlay() { if (this.S.playing) this.pause(); else this.play(); }
  cycleSpeed() {
    const i = SPEEDS.indexOf(this.S.speed); this.S.speed = SPEEDS[(i + 1) % SPEEDS.length];
    this.el.speed.textContent = `${this.S.speed}×`; this.el.speed.setAttribute('aria-label', `Playback speed: ${this.S.speed} times`);
  }
  frame(now) {
    const S = this.S;
    if (!S.playing || !S.walk) return false;
    // A gap (scrolled away, another tab, a slow frame) does not jump the walk ahead.
    if (S.last !== null && now - S.last < 250) S.t = Math.min(S.walk.duration, S.t + (now - S.last) / 1000 * S.speed);
    S.last = now;
    this.apply();
    if (S.t >= S.walk.duration) { S.playing = false; S.mode = 'done'; this.render(); this.splashDone(); }
    else if (now - S.uiAt > 100) { S.uiAt = now; this.renderHud(); this.renderDock(); }
    return true;
  }
  seek(t) {
    const S = this.S;
    S.t = Math.max(0, Math.min(S.walk.duration, Number.isFinite(t) ? t : 0));
    S.mode = S.t >= S.walk.duration ? 'done' : 'playing';
    // Seeking does not replay the headlines of what happened before.
    S.phase = S.walk.phase(S.t); S.events = S.walk.events.filter(e => e.t <= S.t).length;
    this.apply();
    this.render();
  }
  apply() {
    const S = this.S, w = S.walk, v = this.viewer, L = S.layers;
    v.setPose(w.pose(S.t, this.pose));
    const ref = L.body ? w.refPose(S.t, this.refPose) : null;
    const apart = ref && !coincides(ref, this.pose);
    v.setGhost('plan', apart ? ref : null);
    // After the walking headline has gone (about 2 s into the walk), so the two never sit on top of each other.
    if (apart && S.playing && S.t > 2.2 && !this.ghostHinted && Math.hypot(ref[0] - this.pose[0], ref[1] - this.pose[1]) > 0.18) {
      this.ghostHinted = true; this.el.ghostTip.hidden = false;
      clearTimeout(this._ghostTip); this._ghostTip = setTimeout(() => { this.el.ghostTip.hidden = true; }, 6000);
    }
    // The robot's map: changes up to now (rebuilt from the pre-walk map when seeking back).
    let step = S.mapStep;
    if (step >= 0 && w.map[step].t > S.t + 1e-9) { v.setMapBase(S.world.map); step = -1; }
    while (step + 1 < w.map.length && w.map[step + 1].t <= S.t + 1e-9) { step++; v.applyMapChanges(w.map[step]); }
    S.mapStep = step;
    const k = w.index(S.t);
    if (k !== S.trailIndex) {
      S.trailIndex = k;
      if (S.trailWalk !== w || !L.robot !== !this.lines.trail.visible) { S.trailWalk = w; v.setLine(this.lines.trail, L.robot ? w.trail : null); }
      v.setLineCount(this.lines.trail, k + 1);
      v.setMarker('estMarker', L.robot ? [w.est[k * 2] / 1000, w.est[k * 2 + 1] / 1000] : null, { color: COLORS.blue, radius: 0.1, pin: false });
    }
    const phase = w.phase(S.t);
    const plan = L.plan && phase === 'RUN' ? w.plan(S.t) : null;
    if (plan !== S.planShown) { S.planShown = plan; v.setLine(this.lines.plan, plan && plan.rule !== 'stand' ? plan.points : null); }
    const lidar = L.lidar ? w.lidarAt(S.t) : null;
    if (lidar !== S.lidarShown) { S.lidarShown = lidar; v.setLidar(lidar); }
    this.headlines(phase);
  }
  // A short headline at each phase change and at the events that matter, as they happen during playback.
  headlines(phase) {
    const S = this.S, w = S.walk;
    if (phase !== S.phase) {
      const was = S.phase;
      S.phase = phase;
      if (S.playing && was !== null) {
        if (phase === 'PRESCAN') this.splash('Pre-scan', 'node.py stands for 0.5 s while the LiDAR fills its map');
        else if (phase === 'RUN') this.splash('Walking', 'it replans several times a second, only around what it has seen');
        else if (phase === 'ARRIVED') {
          const a = w.events.find(e => e.type === 'arrived');
          this.splash(a?.dist != null ? `Arrived ${fmt(a.dist, 2)} m from the goal` : 'Arrived', 'by its own estimate · node.py stands it up');
        } else if (phase === 'STOPPED') this.splash('Stopped', 'standing up where it is');
      }
    }
    const due = w.events.filter(e => e.t <= S.t + 1e-9).length;
    if (due > S.events) {
      const fresh = w.events.slice(S.events, due);
      S.events = due;
      if (!S.playing) return;
      const ev = fresh.find(e => ['stand_deferred', 'stand_forced', 'estop', 'fell', 'contact'].includes(e.type));
      if (ev?.type === 'stand_deferred') this.splash('Stand deferred', 'a low "ceiling" in its map: it holds the last plan and can drift', 'warn');
      else if (ev?.type === 'stand_forced') this.splash('Stand forced', 'Studio stands it after 20 s (simulation only)', 'warn');
      else if (ev?.type === 'estop') this.splash('E-stop', ev.msg, 'bad');
      else if (ev?.type === 'fell') this.splash('It fell', ev.msg, 'bad');
    }
  }
  splashDone() {
    const w = this.S.walk, g = grade(w);
    this.splash(g.label, `ends ${fmt(w.final_dist_m, 2)} m from the goal by simulator truth${(w.max_contact_n ?? 0) > 100 ? ` · contact ${Math.round(w.max_contact_n)} N` : ''}`, g.key === 'clean' ? 'ok' : GRADES[g.key]?.color === 0xf07870 ? 'bad' : 'warn');
  }

  // ----- layers and camera
  toggleLayer(name) {
    const S = this.S, L = S.layers, v = this.viewer;
    const b = this.root.querySelector(`[data-layer="${name}"]`);
    if (name === 'world') {
      L.world = { ghost: 'solid', solid: 'hidden', hidden: 'ghost' }[L.world];
      v.setBoxesStyle(L.world); b.dataset.state = L.world;
      b.querySelector('small').textContent = { ghost: 'ghost', solid: 'solid', hidden: 'off' }[L.world];
      b.setAttribute('aria-pressed', String(L.world !== 'hidden'));
      return;
    }
    L[name] = !L[name];
    b.setAttribute('aria-pressed', String(L[name]));
    if (name === 'robot') { v.groups.robot.visible = L.robot; S.trailIndex = -1; if (S.walk) this.apply(); else v.dirty(); }
    if (name === 'body') { if (S.walk) this.apply(); else v.dirty(); }
    if (name === 'map') { v.groups.map.visible = v.groups.voxels.visible = L.map; v.dirty(); }
    if (name === 'outcomes') { this.paintOutcomes(); this.renderChip(); }
    if (name === 'lidar') { v.groups.lidar.visible = L.lidar; S.lidarShown = undefined; if (S.walk) this.apply(); else v.setLidar(L.lidar ? S.world.start_lidar : null); }
    if (name === 'plan') { v.groups.plan.visible = L.plan; v.dirty(); }
  }
  camera(mode) {
    const v = this.viewer;
    if (mode === 'follow') {
      v.follow = !(this.cameraMode === 'follow');
      this.cameraMode = v.follow ? 'follow' : 'orbit';
      if (!v.follow) v.frame(this.S.world, 'orbit');
    } else {
      v.follow = false; this.cameraMode = mode;
      v.frame(this.S.world, mode);
    }
    for (const b of this.root.querySelectorAll('[data-camera]')) b.setAttribute('aria-pressed', String(b.dataset.camera === this.cameraMode));
    if (this.S.walk) this.apply();
  }

  // This walk in the split view of the main page (plan body against the executed body).
  compare() {
    const S = this.S, hash = `#closer/${S.worldId}/${S.walk.goal_id}`;
    if (this.embedded) { location.hash = hash; return; }
    location.href = new URL(`${this.home ?? '../'}${hash}`, location.href).href;
  }
  async copyLink() {
    const S = this.S, path = `#${S.worldId}/${S.walk.goal_id}/play`;
    const url = new URL(this.embedded ? `${this.fullHref}${path}` : path, location.href).href;
    try { await navigator.clipboard.writeText(url); this.flash('Link copied: it opens this walk and plays it.'); }
    catch { this.flash(url); }
  }
  // Open the room menu on a folder and, optionally, one grade (the outcome table's cells use this).
  openPicker(folder, filter = 'all') { this.S.filter = filter; this.togglePicker(true, folder); }

  // ----- the picker: rooms as folders, every walk with its grade, and the walks that went wrong
  togglePicker(open = this.el.picker.hidden, folder = null) {
    const p = this.el.picker;
    if (!open) { if (!p.hidden) { p.hidden = true; this.el.rooms.setAttribute('aria-expanded', 'false'); } return; }
    if (folder) this.S.folder = folder;
    this.S.folder ??= this.S.worldId;
    p.hidden = false; this.el.rooms.setAttribute('aria-expanded', 'true');
    this.toggleHelp(false);
    this.renderPicker();
    requestAnimationFrame(() => p.querySelector('[aria-selected="true"]')?.focus({ preventScroll: true }));
  }
  pool() {
    const S = this.S;
    const all = S.folder === 'wrong' ? this.catalog.flatMap(w => listOf(w)).filter(x => x.grade !== 'clean')
      : listOf(this.catalog.find(w => w.id === S.folder) ?? this.catalog[0]);
    return all.filter(x => S.filter === 'all' || bucket(x.grade) === S.filter || x.grade === S.filter);
  }
  renderPicker() {
    const S = this.S, E = this.el;
    const wrong = this.catalog.flatMap(w => listOf(w)).filter(x => x.grade !== 'clean');
    E.folders.innerHTML = this.catalog.map((w, i) => {
      const list = listOf(w), on = S.folder === w.id;
      return `<li><button data-folder="${w.id}" role="option" aria-selected="${on}"><span class="f-name">${escape(w.title)}</span><small>${list.length} walks <kbd>${i + 1}</kbd></small>${bar(list)}</button></li>`;
    }).join('') + `<li class="wrong"><button data-folder="wrong" role="option" aria-selected="${S.folder === 'wrong'}"><span class="f-name">Went wrong</span><small>${wrong.length} walks · contact, off target, falls</small>${bar(wrong)}</button></li>`;
    const all = S.folder === 'wrong' ? wrong : listOf(this.catalog.find(w => w.id === S.folder) ?? this.catalog[0]);
    const counts = { all: all.length, clean: 0, flagged: 0, failed: 0 };
    for (const x of all) counts[bucket(x.grade)]++;
    const grade = GRADES[S.filter] && !['clean'].includes(S.filter) ? [[S.filter, GRADES[S.filter].short]] : [];
    for (const [k] of grade) counts[k] = all.filter(x => x.grade === k).length;
    E.filters.innerHTML = [['all', 'All'], ['clean', 'Clean'], ['flagged', 'Flagged'], ['failed', 'Failed'], ...grade].filter(([k]) => counts[k])
      .map(([k, label]) => `<button data-filter="${k}" aria-pressed="${S.filter === k}">${label} <small>${counts[k]}</small></button>`).join('');
    const rows = this.pool().sort((a, b) => S.folder === 'wrong' ? WRONG_ORDER.indexOf(a.grade) - WRONG_ORDER.indexOf(b.grade) || b.contact - a.contact : a.dist - b.dist || (a.turn ?? 0) - (b.turn ?? 0));
    const titles = Object.fromEntries(this.catalog.map(w => [w.id, w.title]));
    E.walkList.innerHTML = rows.length ? rows.map(x => {
      const g = GRADES[x.grade] ?? { label: x.grade, css: 'var(--ink-3)' };
      const detail = x.grade === 'contact' ? `${Math.round(x.contact)} N` : x.grade === 'off' || x.grade === 'away' ? `${fmt(x.final, 2)} m off` : `${fmt(x.duration, 0)} s`;
      const where = x.turn === null ? '' : `<span class="w-dir" style="--turn:${Math.round(-x.turn)}deg" aria-hidden="true">↑</span>`;
      return `<li><button data-room="${x.room}" data-walk="${x.id}" aria-label="${escape(`${S.folder === 'wrong' ? `${titles[x.room]}, ` : ''}${fmt(x.dist, 1)} m ${direction(x.turn)}, ${g.label}, ${detail}`)}"><i style="background:${g.css}"></i><span class="w-main">${where}${S.folder === 'wrong' ? `${escape(titles[x.room])} · ` : ''}${fmt(x.dist, 1)} m ${escape(direction(x.turn))}</span><span class="w-grade">${escape(g.label)}</span><span class="w-detail mono">${detail}</span></button></li>`;
    }).join('') : '<li class="empty">No walks here.</li>';
  }
  toggleHelp(open = this.el.help.hidden) {
    const was = !this.el.help.hidden;
    this.el.help.hidden = !open;
    if (open) { this.togglePicker(false); this.el.helpClose.focus({ preventScroll: true }); }
    else if (was) this.el.helpBtn.focus({ preventScroll: true });
  }

  // ----- chrome
  live(text) { if (this.el.live.textContent !== text) this.el.live.textContent = text; }
  flash(text) { const n = this.el.flash; n.textContent = text; n.hidden = false; clearTimeout(this._flash); this._flash = setTimeout(() => { n.hidden = true; }, 4000); }
  splash(title, sub = '', tone = '') {
    const n = this.el.splash;
    n.querySelector('b').textContent = title; n.querySelector('span').textContent = sub;
    n.dataset.tone = tone;
    n.classList.remove('on'); void n.offsetWidth; n.classList.add('on');
    clearTimeout(this._splash); this._splash = setTimeout(() => n.classList.remove('on'), reducedMotion() ? 2200 : 1700);
    this.live(sub ? `${title}: ${sub}.` : `${title}.`);
  }
  render() {
    const S = this.S;
    this.root.dataset.mode = S.mode;
    this.root.dataset.walk = S.walk ? '1' : '0';
    this.renderChip();
    this.renderHud();
    this.renderGuide();
    this.renderDock();
    this.renderResult();
    this.place();
  }
  // The operator's steps, until the first walk plays: pick a goal, send it (Studio checks and reads it back), Go.
  renderGuide() {
    const S = this.S, g = this.el.guide;
    if (S.walk) S.guided = true;
    g.hidden = !!S.guided;
    if (g.hidden) return;
    const now = S.mode === 'staged' || S.mode === 'loading' ? 'go' : S.selected ? 'send' : 'pick';
    const order = ['pick', 'send', 'go'];
    for (const li of g.children) {
      const k = order.indexOf(li.dataset.step), at = order.indexOf(now);
      li.className = k < at ? 'done' : k === at ? 'now' : '';
    }
  }
  renderDock() {
    const S = this.S, w = S.walk, E = this.el;
    E.go.disabled = S.mode !== 'staged';
    E.go.textContent = S.mode === 'loading' ? 'Loading…' : 'Go';
    E.go.classList.toggle('armed', S.mode === 'staged');
    E.reset.disabled = !S.selected && !w;
    E.play.disabled = !w;
    E.play.textContent = S.playing ? '❚❚' : '▶';
    E.play.setAttribute('aria-label', S.playing ? 'Pause (space)' : 'Play (space)');
    if (!w) return;
    if (document.activeElement !== E.scrub) E.scrub.value = String(Math.round(S.t / w.duration * 1000));
    E.scrub.setAttribute('aria-valuetext', `${fmt(S.t, 1)} of ${fmt(w.duration, 1)} seconds`);
    E.time.textContent = `${fmt(S.t, 1)} / ${fmt(w.duration, 1)} s`;
    if (E.bands.dataset.walk !== `${S.worldId}/${w.goal_id}`) {
      E.bands.dataset.walk = `${S.worldId}/${w.goal_id}`;
      const bands = w.phases.map(([i, ph], k) => {
        const t0 = w.times[i], t1 = k + 1 < w.phases.length ? w.times[w.phases[k + 1][0]] : w.duration;
        return `<span style="left:${t0 / w.duration * 100}%;width:${(t1 - t0) / w.duration * 100}%;background:${PHASE[ph]?.color ?? '#555'}" title="${escape(PHASE[ph]?.label ?? ph)}"></span>`;
      }).join('');
      const marks = w.events.filter(e => !['waiting', 'goal', 'prescan', 'run', 'walk_end', 'ended'].includes(e.type))
        .map(e => `<i class="${e.type === 'contact' ? 'hot' : ''}" style="left:${e.t / w.duration * 100}%" title="${escape(`${fmt(e.t, 1)} s · ${e.msg}`)}"></i>`).join('');
      E.bands.innerHTML = bands + marks;
    }
  }
  renderHud() {
    const S = this.S, w = S.walk, E = this.el;
    const phase = w ? w.phase(S.t) : 'WAIT';
    const p = PHASE[phase] ?? { label: phase, color: '#8aa0ad' };
    // A deferred stand is not settling: the node keeps the last plan's final frame until its memory clears or Studio forces it.
    const deferredNow = w && phase === 'ARRIVED' && w.events.find(e => e.type === 'stand_deferred' && e.t <= S.t);
    const stoodNow = deferredNow && w.events.some(e => (e.type === 'stand' || e.type === 'stand_forced') && e.t > deferredNow.t && e.t <= S.t);
    const badge = !w && (S.mode === 'staged' || S.mode === 'loading') ? { label: 'Waiting for Go', color: '#9fd8ff' }
      : deferredNow && !stoodNow ? { label: 'Arrived · stand deferred', color: '#efbb70' } : p;
    if (E.phase.textContent !== badge.label) E.phase.textContent = badge.label;
    E.phase.style.setProperty('--c', badge.color); E.phase.title = p.why ?? '';
    E.hud.hidden = !w;
    if (!w) return;
    const k = w.index(S.t), plan = w.plan(S.t);
    const dist = w.goal_cm[k] === null ? null : w.goal_cm[k] / 100;
    const tilt = w.tilt_mrad[k], contact = w.contact_n[k];
    const ref = S.layers.body ? w.refPose(S.t, this.refPose) : null;
    // A deferred stand is not settling: the node keeps the last plan's final frame until its memory clears or Studio forces it.
    const deferred = phase === 'ARRIVED' && w.events.find(e => e.type === 'stand_deferred' && e.t <= S.t);
    const stood = deferred && w.events.some(e => (e.type === 'stand' || e.type === 'stand_forced') && e.t > deferred.t && e.t <= S.t);
    const run = phase === 'RUN';
    const values = {
      goal: dist === null ? '—' : `${fmt(dist, 2)} m`,
      tilt: tilt === null ? '—' : `${fmt(tilt / 1000 * 57.2958, 1)}°`,
      contact: contact === null ? '—' : contact > 0 ? `${contact} N` : 'none',
      // The plan body's root is the planner's only while it walks; standing, the node sets it to the robot's pose.
      body: !ref ? (S.layers.body ? '—' : 'hidden') : coincides(ref, this.pose) ? 'on the body' : w.est_missing?.includes(k) ? '—' : `${fmt(Math.hypot(ref[0] - w.est[k * 2] / 1000, ref[1] - w.est[k * 2 + 1] / 1000), 2)} m`,
      planner: plan && run ? `#${w.planNumber(S.t)} · ${RULES[plan.rule]?.label ?? plan.rule.replaceAll('_', ' ')}` : deferred && !stood ? 'stand deferred' : '—',
      event: (() => { let last = null; for (const e of w.events) { if (e.t > S.t + 1e-9) break; if (!QUIET.has(e.type)) last = e; } return last ? `${fmt(last.t, 1)} s · ${last.msg}` : '—'; })(),
    };
    // The rows are built once; only their values change (their titles and kinds stay readable).
    if (!E.hud.firstChild) {
      E.hud.innerHTML = HUD.map(([key, label, kind, title, cls]) => `<div class="${cls}" title="${escape(title)}"><span>${escape(label)} <i>${escape(kind)}</i></span><b data-hud="${key}"></b></div>`).join('');
      this.hudCells = Object.fromEntries([...E.hud.querySelectorAll('[data-hud]')].map(n => [n.dataset.hud, n]));
    }
    for (const [key, text] of Object.entries(values)) if (this.hudCells[key].textContent !== text) this.hudCells[key].textContent = text;
    this.hudCells.contact.parentNode.classList.toggle('hot', contact > 100);
    this.hudCells.planner.parentNode.title = plan && run ? RULES[plan.rule]?.why ?? '' : HUD[4][3];
  }
  renderChip() {
    const S = this.S, c = S.selected, E = this.el;
    const show = !!c && (S.mode === 'pick' || S.mode === 'staged' || S.mode === 'loading');
    E.chip.hidden = !show;
    if (!show) return;
    const v = verdict(c);
    const ids = S.world.check_ids, labels = [...c.l];
    const dist = Math.hypot(c.xy[0] - S.world.start_xy[0], c.xy[1] - S.world.start_xy[1]);
    const rows = ids.map((id, k) => {
      const [status, icon] = STATUS[c.s[k]] ?? ['warn', '?'];
      const label = status !== 'pass' ? labels.shift() : id === 'distance' ? `${fmt(dist, 1)} m straight${c.path_m ? ` · route ${fmt(c.path_m, 1)} m` : ''}` : CHECKS[id].pass;
      return `<li class="check ${status}" title="${escape(CHECKS[id].why)}"><span class="icon" aria-hidden="true">${icon}</span><span class="name">${escape(CHECKS[id].name)}</span><span class="label">${escape(label)}${status === 'pass' ? '' : `<small>${escape(CHECKS[id].why)}</small>`}</span></li>`;
    }).join('');
    const g = c.walk ? grade(c.walk) : null;
    const snap = S.clicked ? Math.hypot(S.clicked[0] - c.xy[0], S.clicked[1] - c.xy[1]) : 0;
    const meta = [`${fmt(dist, 1)} m away`, c.path_m ? `route ${fmt(c.path_m, 1)} m` : null, snap > 0.05 && c.walk ? `snapped ${fmt(snap, 2)} m to a recorded goal` : null,
      g && S.layers.outcomes ? `recorded: <b style="color:${g.css}">${escape(g.label)}</b>` : null].filter(Boolean).join(' · ');
    const staged = S.mode !== 'pick';
    E.chip.dataset.state = staged ? 'staged' : v.tone;
    E.chip.innerHTML = staged
      ? `<p class="gc-verdict pass"><span class="icon" aria-hidden="true">✓</span>Sent · read back · verified</p>
         <p class="gc-note">On the robot Studio would now have sent this goal to <code>node.py</code> and read it back. Nothing moves until the operator presses <kbd>g</kbd>.</p>
         <div class="gc-actions"><button class="btn go armed" data-act="go"${S.mode === 'loading' ? ' disabled' : ''}>${S.mode === 'loading' ? 'Loading…' : 'Go <kbd>g</kbd>'}</button><button class="btn ghost" data-act="clear">Clear</button></div>`
      : `<p class="gc-verdict ${v.tone}"><span class="icon" aria-hidden="true">${STATUS[v.tone === 'pass' ? 'p' : v.tone === 'warn' ? 'w' : 'b'][1]}</span>${escape(v.text)}</p>
         <p class="gc-meta">${meta}</p>
         ${S.detail ? `<ul class="checks">${rows}</ul>${v.common ? '<p class="fineprint">From the start mark the robot has seen little of the room, so Studio warns about unseen space; the planner explores as it walks.</p>' : ''}` : ''}
         <div class="gc-actions"><button class="btn primary" data-act="send"${v.sendable ? '' : ' disabled'}>Send goal</button><button class="btn ghost" data-act="more" aria-expanded="${S.detail}">${S.detail ? 'Hide checks' : 'Six checks'}</button></div>`;
  }
  renderResult() {
    const S = this.S, w = S.walk, box = this.el.result;
    const done = S.mode === 'done' && !!w;
    box.hidden = !done;
    if (!done) return;
    const g = grade(w), o = OUTCOME[w.outcome] ?? { text: '' };
    box.style.setProperty('--c', g.css);
    const contact = w.max_contact_n ?? null;
    const arrival = w.events.find(e => e.type === 'arrived')?.dist ?? null;
    const lines = [
      w.outcome === 'arrived' ? `It arrived ${arrival === null ? '' : `${fmt(arrival, 2)} m from the goal `}by its own position estimate (the node stops within 0.4 m); by simulator truth it ended ${fmt(w.final_dist_m, 2)} m away.` : o.text,
      w.reason ? `Reason: ${reasonText(w.reason)}.` : '',
      contact === null ? '' : contact > 100 ? `It pushed an obstacle with up to ${Math.round(contact)} N (flagged over 100 N).` : 'No contact over 100 N.',
      w.events.some(e => e.type === 'stand_deferred') ? 'Its stand was deferred under a low "ceiling" in its map' + (w.events.some(e => e.type === 'stand_forced') ? ', then forced after 20 s (a Studio limit in simulation).' : '.') : '',
    ].filter(Boolean);
    const facts = [['Walk', `${fmt(w.duration_s, 1)} s`], ['Path', `${fmt(w.path_m, 2)} m`], ['Final, truth', `${fmt(w.final_dist_m, 2)} m`],
      ['Final, estimate', `${fmt(w.final_dist_estimate_m, 2)} m`], ['Max contact', contact === null ? '—' : `${Math.round(contact)} N`], ['Plans', w.plans_n ?? '—']];
    box.innerHTML = `<p class="r-title" id="demo-result-title">${escape(g.label)}</p><p class="r-text" id="demo-result-text">${escape(lines.join(' '))}</p>
      <div class="facts">${facts.map(([a, b]) => `<div><span>${a}</span><b>${escape(String(b))}</b></div>`).join('')}</div>
      <details class="r-more"><summary>How it is graded</summary><p>Green: arrived cleanly. Amber: arrived with contact over 100 N, or ended more than 0.6 m from the goal by truth (node.py's radius is 0.4 m, by its estimate; it can also move away after arriving). Red: E-stop or fall. Recorded on CPU MuJoCo at ${fmt(w.rtf, 2)}× real time; seed ${S.world.settings?.seed ?? 0}; planner ${S.world.settings?.planner?.candidates ?? '?'} candidates, ${S.world.settings?.planner?.ode_steps ?? '?'} ODE steps.</p></details>
      <div class="r-actions"><button class="btn" data-act="replay">Replay</button><button class="btn primary" data-act="new">New goal</button><button class="btn ghost" data-act="compare">Plan vs body</button><button class="btn ghost" data-act="link">Copy link</button><button class="btn ghost" data-act="wrong">Went wrong</button></div>`;
  }
  // DOM chips pinned to the scene: the hint above the robot, the goal checks above the goal's pin.
  place() {
    const S = this.S, v = this.viewer, E = this.el;
    if (!S.world) return;
    const W = this.root.clientWidth, H = this.root.clientHeight, R = this.root.getBoundingClientRect();
    const bottomOf = n => (n && n.getClientRects().length ? n.getBoundingClientRect().bottom - R.top : 0);
    const tr = bottomOf(this.root.querySelector('.chrome.top-right'));
    const minY = Math.max(bottomOf(this.root.querySelector('.chrome.top-left')), tr) + 10;
    // The readout hangs under whatever the top-right chrome holds (the phase, Open full screen, Stop).
    if (!E.hud.hidden && !this.root.classList.contains('narrow')) E.hud.style.top = `${Math.round(tr + 8)}px`;
    else E.hud.style.top = '';
    const maxY = H - (E.dock.offsetHeight || 50) - 24 - (E.guide.hidden || this.root.classList.contains('narrow') ? 0 : E.guide.offsetHeight + 10);
    const put = (node, xyz, dy, flip) => {
      const p = v.project(...xyz);
      if (!p || p[0] < -40 || p[0] > W + 40 || p[1] < -40 || p[1] > H + 40) { node.style.visibility = 'hidden'; return; }
      node.style.visibility = '';
      const w = node.offsetWidth, h = node.offsetHeight;
      const x = Math.max(8, Math.min(W - w - 8, p[0] - w / 2));
      let y = p[1] - h - dy, below = false;
      if (flip && y < minY) {  // no room above the pin: hang it below the goal's foot
        const foot = v.project(xyz[0], xyz[1], 0);
        y = (foot ? foot[1] : p[1]) + 16; below = true;
      }
      y = Math.max(minY, Math.min(maxY - h, y));
      node.classList.toggle('below', below);
      node.style.setProperty('--ax', `${Math.round(Math.max(16, Math.min(w - 16, p[0] - x)))}px`);
      node.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;
    };
    if (!S.picked) put(E.hint, [S.world.start_xy[0], S.world.start_xy[1], 1.75], 10, false);
    if (!E.ghostTip.hidden && this.viewer.ghosts.plan?.root.visible) { const r = this.refPose; put(E.ghostTip, [r[0], r[1], 1.55], 12, false); }
    if (E.chip.hidden) return;
    if (this.root.classList.contains('narrow')) { E.chip.style.transform = ''; E.chip.style.visibility = ''; }
    else put(E.chip, [S.selected.xy[0], S.selected.xy[1], 0.78], 12, true);
  }
}

// The plan body on top of the body (standing, pre-scan): nothing to show.
function coincides(a, b) {
  if (Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) > 0.03) return false;
  for (let j = 7; j < 36; j++) if (Math.abs(a[j] - b[j]) > 0.03) return false;
  return true;
}

// ----- verdicts and the walk catalogue
function verdict(c) {
  const blocks = [...c.s].filter(s => s === 'b').length, warns = [...c.s].filter(s => s === 'w').length;
  const common = c.ok && c.l.length && c.l.every(l => l === 'Not seen yet' || l === 'Route crosses unseen space');
  if (!c.ok) return { tone: 'block', sendable: false, text: blocks ? `Blocked: ${c.l[0] ?? 'a check failed'}` : 'Within 0.8 m of the start: nothing to walk' };
  if (!c.walk) return { tone: 'warn', sendable: false, text: 'Passes, but not recorded: pick a spot nearby', common };
  return { tone: warns ? 'warn' : 'pass', sendable: true, text: warns ? `Passes with ${warns} warning${warns > 1 ? 's' : ''}` : 'All six checks pass', common };
}
// worlds.json lists every walk of a room as rows of list_fields: id, grade, metres from the start, max contact (N),
// final distance by truth (m) and duration (s).
const lists = new WeakMap();
function listOf(w) {
  if (!lists.has(w)) {
    const f = w.list_fields ?? [];
    lists.set(w, (w.list ?? []).map(r => {
      const o = Object.fromEntries(f.map((k, i) => [k, r[i]]));
      // Where the goal is, seen from the start mark: degrees left of straight ahead.
      const turn = o.x == null || !w.start_xy ? null : ((Math.atan2(o.y - w.start_xy[1], o.x - w.start_xy[0]) - (w.start_yaw_rad ?? 0)) * 180 / Math.PI + 540) % 360 - 180;
      return { room: w.id, id: o.id, grade: o.grade, dist: o.dist_m, contact: o.contact_n ?? 0, final: o.final_m, duration: o.duration_s, turn };
    }));
  }
  return lists.get(w);
}
const bucket = g => g === 'clean' ? 'clean' : ['fell', 'estop'].includes(g) ? 'failed' : 'flagged';
// Eight ways round from the start mark's heading, in words.
function direction(turn) {
  if (turn === null || turn === undefined) return 'away';
  const names = ['ahead', 'ahead-left', 'left', 'behind-left', 'behind', 'behind-right', 'right', 'ahead-right'];
  return names[((Math.round(turn / 45) % 8) + 8) % 8];
}
function bar(list) {
  const n = list.length || 1, c = { clean: 0, flagged: 0, failed: 0 };
  for (const x of list) c[bucket(x.grade)]++;
  return `<span class="mini-bar" aria-hidden="true"><i class="ok" style="width:${c.clean / n * 100}%"></i><i class="warn" style="width:${c.flagged / n * 100}%"></i><i class="bad" style="width:${c.failed / n * 100}%"></i></span>`;
}

function template({ embedded, home, stop }) {
  const layers = LAYERS.map(l => `<button data-layer="${l.id}" aria-pressed="true" ${l.id === 'world' ? 'data-state="ghost"' : ''} title="${escape(`${l.why} (${l.key.toUpperCase()})`)}"><i style="--dot:${l.dot}"></i>${escape(l.label)}${l.id === 'world' ? ' <small>ghost</small>' : ''}</button>`).join('');
  return `
  <div class="stage-canvas" data-el="canvas" tabindex="0" role="application" aria-label="3D view of the room and the robot. Click the floor to pick a goal, or use the arrow keys to move a goal cursor and Enter to pick it."></div>
  <div class="chrome top-left">
    ${embedded ? '' : `<a class="title-chip" href="${home ?? '../'}"><span class="mark">G1</span><span>Deploy Studio <small>Navigate demo · recorded walks</small></span></a>`}
    <div class="layers" role="group" aria-label="Layers (also the legend)">${layers}<button class="legend-btn" data-el="helpBtn" aria-label="Legend and keys (?)" title="Legend and keys (?)">?</button></div>
  </div>
  <div class="chrome top-right">
    <span class="phase" data-el="phase">WAIT</span>
    ${embedded ? '<a class="pill" data-el="full" target="_blank" rel="noopener" aria-label="Open full screen"><span class="t">Open full screen</span> ↗</a>' : ''}
    ${stop ? '<button class="pill" data-el="stop" title="Stop the demo and free its memory">Stop</button>' : ''}
  </div>
  <div class="hud" data-el="hud" hidden></div>
  <ol class="guide" data-el="guide" aria-label="The operator's three steps"><li data-step="pick"><b>1</b> Pick a goal</li><li data-step="send"><b>2</b> Send it</li><li data-step="go"><b>3</b> Go</li></ol>
  <div class="hint" data-el="hint"><b>${matchMedia('(pointer: coarse)').matches ? 'Tap' : 'Click'} the floor.</b> It has to find its own way.</div>
  <div class="goal-chip" data-el="chip" hidden role="group" aria-label="Goal checks"></div>
  <p class="ghost-tip" data-el="ghostTip" hidden><b>The pink ghost</b> is the pose the tracker is chasing. Where it pulls ahead or aside, the body is behind its plan. ${embedded ? '<a href="#closer">Side by side ›</a>' : `<a href="${home ?? '../'}#closer">Side by side ›</a>`}</p>
  <div class="splash" data-el="splash" aria-hidden="true"><b></b><span></span></div>
  <p class="sr-only" data-el="live" aria-live="polite"></p>
  <div class="result" data-el="result" hidden role="region" aria-labelledby="demo-result-title"></div>
  <div class="flash" data-el="flash" role="status" hidden></div>
  <div class="dock" data-el="dock" role="toolbar" aria-label="Walk and rooms">
    <button class="dk" data-el="reset" title="New goal (R)" aria-label="New goal (R)">↺</button>
    <button class="dk" data-el="play" aria-label="Play (space)">▶</button>
    <button class="dk go" data-el="go" title="Go (G): the operator's key">Go</button>
    <div class="scrub"><div class="bands" data-el="bands"></div><input type="range" data-el="scrub" min="0" max="1000" value="0" aria-label="Walk time"></div>
    <span class="time mono" data-el="time">0.0 s</span>
    <button class="dk small" data-el="speed" title="Playback speed (simulated time)" aria-label="Playback speed: 1 times">1×</button>
    <button class="dk room" data-el="rooms" aria-haspopup="dialog" aria-expanded="false" title="Rooms and walks (N)"><span data-el="roomName">Room</span><small data-el="roomCount"></small><span aria-hidden="true">▾</span></button>
    <div class="seg" role="group" aria-label="Camera"><button data-camera="orbit" aria-pressed="true">Orbit</button><button data-camera="top" aria-pressed="false">Top</button><button data-camera="follow" aria-pressed="false">Follow</button></div>
  </div>
  <div class="picker" data-el="picker" role="dialog" aria-label="Rooms and walks" hidden>
    <div class="picker-head"><b>Rooms and walks</b><button class="btn small" data-el="shuffle">Pick one for me</button><button class="x" data-el="pickerClose" aria-label="Close">✕</button></div>
    <div class="picker-body"><ul class="folders" data-el="folders" role="listbox" aria-label="Folders"></ul><div class="walks"><div class="filters" data-el="filters" role="group" aria-label="Filter"></div><ul data-el="walkList" aria-label="Walks"></ul></div></div>
  </div>
  <div class="help" data-el="help" role="dialog" aria-label="Legend and keys" hidden>
    <div class="picker-head"><b>Legend and keys</b><button class="x" data-el="helpClose" aria-label="Close">✕</button></div>
    <div class="help-body">
      <ul class="legend">
        <li><i class="sw" style="background:#265c60"></i>floor the robot has seen</li><li><i class="sw" style="background:#efbb70"></i>low obstacle (steps over)</li>
        <li><i class="sw" style="background:#f07870"></i>obstacle, at its seen height</li><li><i class="sw" style="background:#c4a0d9"></i>overhead (below 2 m)</li>
        <li><i class="ln" style="background:#ff6fb5"></i>plan being tracked</li><li><i class="ln" style="background:#56d9d0"></i>path walked (simulator truth)</li>
        <li><i class="ring"></i>where it thinks it is (its estimate)</li><li><i class="sw" style="background:#ffb3dc;opacity:.7"></i>plan body: the pose SONIC is chasing</li>
        <li><i class="ln dash"></i>Studio's check route</li><li><i class="dot" style="background:#7be0a5"></i><i class="dot" style="background:#efbb70"></i><i class="dot" style="background:#f07870"></i>outcomes: clean, flagged, failed</li>
      </ul>
      <dl class="keys"><dt><kbd>G</kbd></dt><dd>Go (a staged goal)</dd><dt><kbd>Space</kbd></dt><dd>pause, play</dd><dt><kbd>R</kbd> <kbd>Esc</kbd></dt><dd>new goal</dd>
        <dt><kbd>←</kbd> <kbd>→</kbd></dt><dd>1 s back, forward (<kbd>Shift</kbd>: one frame)</dd><dt><kbd>N</kbd> <kbd>1</kbd>–<kbd>5</kbd></dt><dd>rooms and walks</dd>
        <dt><kbd>B</kbd> <kbd>M</kbd> <kbd>L</kbd> <kbd>P</kbd> <kbd>W</kbd> <kbd>O</kbd> <kbd>V</kbd></dt><dd>plan body, map, LiDAR, plan, real room, outcomes, robot</dd>
        <dt><kbd>C</kbd> <kbd>F</kbd></dt><dd>camera, follow</dd></dl>
      <p class="fineprint">Recorded, simulated walks of the deploy stack, one per goal, one seed. Your browser plays them back and runs no policy.</p>
    </div>
  </div>`;
}

// "tilt 0.75 rad > 0.75" reads as false at two decimals: say what the rule is instead.
const reasonText = r => r.replace(/tilt ([\d.]+) rad > ([\d.]+)/, (_, a, b) => `tilted past the ${b} rad E-stop limit`);
const pairs = flat => { const out = []; for (let k = 0; k + 1 < flat.length; k += 2) out.push([flat[k], flat[k + 1]]); return out; };
