// "Take a closer look": one recorded walk on the two halves of one canvas, in step.
//   body:     left the plan body (the reference pose SONIC is tracking), right the body the simulated G1 executed.
//             Each half follows its own pelvis from the same direction, so posture compares without the lag.
//   estimate: left simulator truth, right where the robot thinks it is (its estimated position, the same posture).
//             Both halves share one camera on the goal, so the positions compare.
// Overlay puts both bodies in one view. Scenarios come from data/featured.json (closer), chosen from the data.
import { Viewer, COLORS } from './viewer.js';
import { DATA, json, walkJson, decodeWorld, Walk } from './data.js';
import { fmt, escape, reducedMotion } from './util.js';

const FPS = 25, CLIP_S = 9;
// The readouts: [label, kind of value, what it is].
const FACTS = {
  body: [['Plan to body', 'while walking', "The plan body's pelvis from where the robot thinks its pelvis is, both in the planner's frame"],
         ['Pelvis', 'plan / body', 'Pelvis height: planned, and executed (simulator truth)'],
         ['Joints apart', 'plan / body', 'Root-mean-square gap over the 29 joint angles'],
         ['Contact', 'truth', 'Obstacle contact force, simulator truth']],
  estimate: [['Estimate off by', 'estimate / truth', 'Distance between its estimate and simulator truth'],
             ['To goal', 'its estimate', "node.py's arrival rule uses this: within 0.4 m"],
             ['To goal', 'truth', 'Simulator truth'],
             ['Phase', 'node.py', "node.py's phase"]],
};
const SIDES = {
  body: [['Plan body', 'the reference pose SONIC is chasing'], ['Executed body', 'the simulated G1, simulator truth']],
  estimate: [['Simulator truth', 'where the robot is'], ['Its estimate', 'where it thinks it is']],
};

export async function mountCloser(root, { scenarios, progress = () => {}, onChange = () => {} } = {}) {
  const c = new Closer(root, scenarios, progress, onChange);
  await c.init();
  return c;
}

class Closer {
  constructor(root, scenarios, progress, onChange) {
    Object.assign(this, { root, scenarios, progress, onChange });
    // Side by side needs room: narrow stages start overlaid.
    this.S = { scenario: null, walk: null, world: null, t: 0, playing: false, last: null, speed: 1, overlay: false, clip: [0, 0], token: 0 };
    root.classList.add('closer');
    root.insertAdjacentHTML('beforeend', `
      <div class="stage-canvas" data-el="canvas" tabindex="0" role="img" aria-label="Two synchronized views of a recorded walk. Space plays or pauses; comma and period step one frame."></div>
      <div class="split-labels" aria-hidden="true"><span data-el="left"></span><span data-el="right"></span></div>
      <div class="split-divider" aria-hidden="true"></div>
      <div class="split-facts" data-el="facts" aria-live="off"></div>
      <div class="dock" role="toolbar" aria-label="Playback">
        <button class="dk" data-el="play" aria-label="Pause">❚❚</button>
        <button class="dk" data-el="back" aria-label="One frame back" title="One frame back">‹</button>
        <button class="dk" data-el="fwd" aria-label="One frame forward" title="One frame forward">›</button>
        <div class="scrub"><div class="bands" data-el="bands"></div><input type="range" data-el="scrub" min="0" max="1000" value="0" aria-label="Clip time"></div>
        <span class="time mono" data-el="frame">frame —</span>
        <button class="dk small" data-el="speed" title="Playback speed">1×</button>
        <div class="seg" role="group" aria-label="View"><button data-view="split" aria-pressed="true">Side by side</button><button data-view="overlay" aria-pressed="false">Overlay</button></div>
      </div>`);
    this.el = {};
    for (const n of root.querySelectorAll('[data-el]')) this.el[n.dataset.el] = n;
    new ResizeObserver(() => root.classList.toggle('narrow', root.clientWidth < 640)).observe(root);
    new ResizeObserver(() => root.style.setProperty('--dock-h', `${root.querySelector('.dock').offsetHeight}px`)).observe(root.querySelector('.dock'));
    const v = this.viewer = new Viewer(this.el.canvas);
    v.controls.minDistance = 1.4; v.controls.maxDistance = 14;
    v.onFrame = now => this.frame(now);
    this.lines = { truth: v.line(COLORS.teal, 3, { opacity: 0.9 }), est: v.line(COLORS.blue, 3, { opacity: 0.9 }), plan: v.line(COLORS.pink, 3) };
    v.groups.trail.add(this.lines.truth, this.lines.est); v.groups.plan.add(this.lines.plan);
    this.q = new Float64Array(36); this.r = new Float64Array(36);
    this.bind();
  }
  async init() {
    await this.viewer.loadRobot(DATA, f => this.progress(0.3 + 0.55 * f, 'Loading the robot'));
    this.viewer.ghost('plan', { color: COLORS.ghost, opacity: 1 });
    this.viewer.ghost('est', { color: 0x8fb8ff, opacity: 1 });
    this.progress(0.9, 'Loading the walk');
    await this.load(this.scenarios[0]);
    this.progress(1, 'Ready');
    this.root.classList.add('is-ready');
  }
  bind() {
    const E = this.el;
    E.play.addEventListener('click', () => this.toggle());
    E.back.addEventListener('click', () => this.step(-1));
    E.fwd.addEventListener('click', () => this.step(1));
    E.speed.addEventListener('click', () => { const s = [0.25, 0.5, 1], i = s.indexOf(this.S.speed); this.S.speed = s[(i + 1) % s.length]; E.speed.textContent = `${this.S.speed}×`; });
    E.scrub.addEventListener('input', () => { const [a, b] = this.S.clip; this.S.playing = false; this.seek(a + Number(E.scrub.value) / 1000 * (b - a)); });
    for (const b of this.root.querySelectorAll('[data-view]')) b.addEventListener('click', () => this.setOverlay(b.dataset.view === 'overlay'));
    this.root.addEventListener('keydown', e => {
      if (e.key === ' ' && !e.target.closest('button, input')) { e.preventDefault(); this.toggle(); }
      if (e.key === ',' || e.key === '.') this.step(e.key === '.' ? 1 : -1);
    });
  }

  async load(sc) {
    const S = this.S, token = ++S.token;
    S.playing = false;
    const [world, walk] = await Promise.all([json(`${sc.world}/index.json`).then(decodeWorld), walkJson(`${sc.world}/g/${sc.goal}.json`).then(d => new Walk(d))]);
    if (token !== S.token) return;
    S.scenario = sc; S.world = world; S.walk = walk;  // the scenario changes only with its walk
    const v = this.viewer;
    // Walls as glass: the bodies are the subject, and a wall must not hide them.
    v.setWorld(world); v.setBoxesStyle('ghost');
    const a = Math.max(0, Math.min(sc.at ?? 0, walk.duration - 1));
    S.clip = [a, sc.clip_s === null ? walk.duration : Math.min(walk.duration, a + (sc.clip_s ?? CLIP_S))];
    // A still camera where the scenario is about something moving away (a deferred stand); else it follows.
    this.still = sc.view === 'overlay-fixed';
    this.root.dataset.mode = sc.mode;
    // Truth and estimate are centimetres apart: overlaid they compare; side by side the gap would be lost.
    // Side by side needs room for the plan body too: narrow stages start overlaid.
    S.overlay = (sc.view ?? '').startsWith('overlay') || sc.mode === 'estimate' || this.root.clientWidth < 560;
    const [l, r] = SIDES[sc.mode];
    this.el.left.innerHTML = `<b>${escape(l[0])}</b> ${escape(l[1])}`;
    this.el.right.innerHTML = `<b>${escape(r[0])}</b> ${escape(r[1])}`;
    v.setMarker('goal', sc.mode === 'estimate' ? walk.goal : null, { color: COLORS.amber, radius: 0.4 });
    this.setOverlay(S.overlay, { quiet: true });
    this.bands();
    this.seek(S.clip[0]);
    this.aim();
    this.onChange(sc);
    if (!reducedMotion()) this.play();
  }
  // Cameras: body mode follows the pelvis from in front of the robot, a three-quarter view; estimate mode looks
  // down on the goal and the end of the walk.
  aim() {
    const S = this.S, w = S.walk, v = this.viewer;
    const p = w.pose(S.t, this.q), heading = Math.atan2(2 * (p[3] * p[6] + p[4] * p[5]), 1 - 2 * (p[5] * p[5] + p[6] * p[6]));
    if (this.still) {
      // Frame where the robot starts and where it ends up: the plan body stays at the start.
      const end = w.pose(S.clip[1], new Float64Array(36)), cx = (p[0] + end[0]) / 2, cy = (p[1] + end[1]) / 2;
      const span = Math.hypot(end[0] - p[0], end[1] - p[1]);
      v.look([cx, cy, 0.5], { yaw: Math.atan2(end[1] - p[1], end[0] - p[0]) - Math.PI / 2, pitch: 0.75, distance: Math.max(4, span * 1.6 + 2) });
    } else if (S.scenario.mode === 'estimate') v.look([p[0], p[1], 0.3], { yaw: heading - 2.4, pitch: 0.9, distance: 3.6 });
    else v.look([p[0], p[1], 0.55], { yaw: heading + 0.95, pitch: 0.26, distance: S.overlay ? 3.6 : 4.4 });
  }
  setOverlay(on, { quiet = false } = {}) {
    const S = this.S, v = this.viewer;
    S.overlay = on;
    for (const b of this.root.querySelectorAll('[data-view]')) b.setAttribute('aria-pressed', String((b.dataset.view === 'overlay') === on));
    this.root.classList.toggle('overlay', on);
    const ghost = S.scenario?.mode === 'estimate' ? 'est' : 'plan';
    for (const name of ['plan', 'est']) {
      const m = v.ghosts[name]?.material;
      if (!m) continue;
      m.transparent = on; m.opacity = on ? 0.4 : 1; m.depthWrite = !on; m.needsUpdate = true;
    }
    if (on) v.setViews(null);
    else {
      // Left half: the robot hidden, the other body shown (and, in body mode, the camera moved onto it); right: the robot.
      const shift = new Float64Array(3);
      v.setViews([
        { x: 0, w: 0.5, before: () => {
          v.groups.robot.visible = false; v.ghosts[ghost].root.visible = this.ghostOn;
          this.lines.truth.visible = false; this.lines.est.visible = S.scenario.mode === 'estimate';
          if (S.scenario.mode === 'body') { const d = this.delta(shift); v.camera.position.x += d[0]; v.camera.position.y += d[1]; v.camera.position.z += d[2]; }
        }, after: () => {
          if (S.scenario.mode === 'body') { v.camera.position.x -= shift[0]; v.camera.position.y -= shift[1]; v.camera.position.z -= shift[2]; }
        } },
        { x: 0.5, w: 0.5, before: () => {
          v.groups.robot.visible = true; v.ghosts[ghost].root.visible = false;
          this.lines.truth.visible = S.scenario.mode === 'estimate'; this.lines.est.visible = false;
        } },
      ]);
    }
    if (!quiet && S.walk) { this.aim(); this.apply(); }
  }
  // How far the left half's body is from the robot, so the left camera sits the same way on it.
  delta(out) {
    const S = this.S, ref = S.walk.refPose(S.t, this.r), p = S.walk.pose(S.t, this.q);
    out[0] = ref ? ref[0] - p[0] : 0; out[1] = ref ? ref[1] - p[1] : 0; out[2] = 0;
    return out;
  }

  play() { const S = this.S; if (!S.walk) return; if (S.t >= S.clip[1] - 1e-6) this.seek(S.clip[0]); S.playing = true; S.last = null; this.viewer.start(); this.renderDock(); }
  pause() { this.S.playing = false; this.renderDock(); }
  toggle() { if (this.S.playing) this.pause(); else this.play(); }
  step(n) { this.pause(); const S = this.S, k = S.walk.index(S.t + 1e-6) + n; this.seek(S.walk.times[Math.max(0, Math.min(S.walk.n - 1, k))]); }
  frame(now) {
    const S = this.S;
    if (!S.playing || !S.walk) return false;
    if (S.last !== null && now - S.last < 250) S.t += (now - S.last) / 1000 * S.speed;
    S.last = now;
    if (S.t >= S.clip[1]) S.t = S.clip[0];   // the clip loops
    this.apply();
    if (now - (this._ui ?? 0) > 80) { this._ui = now; this.renderDock(); }
    return true;
  }
  seek(t) { const S = this.S; S.t = Math.max(S.clip[0], Math.min(S.clip[1], t)); this.apply(); this.renderDock(); }
  // Bodies move every drawn frame; lines and numbers change only when the recorded frame does.
  apply() {
    const S = this.S, w = S.walk, v = this.viewer, mode = S.scenario.mode;
    const p = w.pose(S.t, this.q);
    v.setPose(p);
    this.follow(p);
    const k = w.index(S.t), fresh = this.shown?.walk !== w || this.shown?.mode !== mode;
    if (mode === 'body') {
      const ref = w.refPose(S.t, this.r);
      v.setGhost('plan', ref); v.setGhost('est', null); this.ghostOn = !!ref;
      if (fresh) { v.setLine(this.lines.truth, null); v.setLine(this.lines.est, null); }
      const plan = w.phase(S.t) === 'RUN' ? w.plan(S.t) : null;
      if (fresh || plan !== this.shown.plan) v.setLine(this.lines.plan, plan ? plan.points : null);
      if (fresh || k !== this.shown.k) {
        // The plan body's root is the planner's only while it walks; standing, the node sets it to the robot's pose.
        const run = w.phase(S.t) === 'RUN' && !w.est_missing?.includes(k), r = w.hasRef ? w.refFrames.subarray(k * 36, k * 36 + 36) : null;
        const has = r && !Number.isNaN(r[0]), f = w.frames.subarray(k * 36, k * 36 + 36);
        let rms = null;
        if (has) { let sq = 0; for (let j = 7; j < 36; j++) sq += (r[j] - f[j]) ** 2; rms = Math.sqrt(sq / 29) * 57.2958; }
        this.facts('body', [
          !has ? '—' : run ? `${fmt(Math.hypot(r[0] - w.est[k * 2] / 1000, r[1] - w.est[k * 2 + 1] / 1000), 2)} m` : 'not walking',
          has ? `${fmt(r[2], 2)} / ${fmt(f[2], 2)} m` : '—',
          has ? `${fmt(rms, 1)}° RMS` : '—',
          w.contact_n[k] === null ? '—' : w.contact_n[k] > 0 ? `${w.contact_n[k]} N` : 'none',
        ], w.contact_n[k] > 100);
      }
      this.shown = { walk: w, mode, k, plan };
    } else {
      const e = w.estPose(S.t, this.r);
      v.setGhost('est', e); v.setGhost('plan', null); this.ghostOn = true;
      if (fresh) {
        v.setLine(this.lines.plan, null);
        v.setLine(this.lines.truth, w.trail);
        const est = []; for (let i = 0; i < w.n; i++) est.push([w.est[i * 2] / 1000, w.est[i * 2 + 1] / 1000, 0.03]);
        v.setLine(this.lines.est, est);
      }
      if (fresh || k !== this.shown.k) {
        v.setLineCount(this.lines.truth, k + 1); v.setLineCount(this.lines.est, k + 1);
        const g = w.goal, f = w.frames.subarray(k * 36, k * 36 + 2), ex = w.est[k * 2] / 1000, ey = w.est[k * 2 + 1] / 1000;
        const missing = w.est_missing?.includes(k);
        this.facts('estimate', [
          missing ? '—' : `${fmt(Math.hypot(ex - f[0], ey - f[1]), 2)} m`,
          g && !missing ? `${fmt(Math.hypot(ex - g[0], ey - g[1]), 2)} m` : '—',
          g ? `${fmt(Math.hypot(f[0] - g[0], f[1] - g[1]), 2)} m` : '—',
          w.phaseAt(k),
        ]);
      }
      this.shown = { walk: w, mode, k };
    }
  }
  // The camera keeps its direction and distance and moves with the executed pelvis (the left half's camera is
  // moved onto the plan body as it renders).
  follow(p) {
    if (this.still) return;
    const v = this.viewer, dx = p[0] - v.controls.target.x, dy = p[1] - v.controls.target.y;
    v.controls.target.x += dx; v.controls.target.y += dy; v.camera.position.x += dx; v.camera.position.y += dy;
  }
  // The readout's rows are built once per mode; afterwards only their values change.
  facts(mode, values, hot = false) {
    const E = this.el;
    if (E.facts.dataset.mode !== mode) {
      E.facts.dataset.mode = mode;
      E.facts.innerHTML = FACTS[mode].map(([label, kind, title]) => `<div title="${escape(title)}"><span>${escape(label)} <i>${escape(kind)}</i></span><b></b></div>`).join('');
      this.factCells = [...E.facts.querySelectorAll('b')];
    }
    values.forEach((text, i) => { if (this.factCells[i].textContent !== text) this.factCells[i].textContent = text; });
    this.factCells[3].parentNode.classList.toggle('hot', hot);
  }
  bands() {
    const S = this.S, w = S.walk, [a, b] = S.clip;
    this.el.bands.innerHTML = w.events.filter(e => ['contact', 'stand_deferred', 'stand_forced', 'arrived', 'estop', 'fell'].includes(e.type) && e.t >= a && e.t <= b)
      .map(e => `<i class="${e.type === 'contact' ? 'hot' : ''}" style="left:${(e.t - a) / (b - a || 1) * 100}%" title="${escape(`${fmt(e.t, 1)} s · ${e.msg}`)}"></i>`).join('');
  }
  renderDock() {
    const S = this.S, E = this.el, w = S.walk;
    if (!w) return;
    E.play.textContent = S.playing ? '❚❚' : '▶';
    E.play.setAttribute('aria-label', S.playing ? 'Pause' : 'Play');
    const [a, b] = S.clip;
    if (document.activeElement !== E.scrub) E.scrub.value = String(Math.round((S.t - a) / (b - a || 1) * 1000));
    const k = w.index(S.t + 1e-6);
    E.frame.textContent = `frame ${k + 1} / ${w.n} · ${fmt(S.t, 2)} s`;
    E.scrub.setAttribute('aria-valuetext', `${fmt(S.t, 2)} seconds, frame ${k + 1} of ${w.n} (${FPS} per second)`);
  }
}
