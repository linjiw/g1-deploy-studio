// A small, event-driven SVG explanation. Its shapes are illustrative, never recorded telemetry or a model run.
import { escape } from './util.js';
const STEPS = [
  ['Motion first', 'Start with a motion the body can make.', 'A whole-body motion includes the torso, arms and legs. Its swept volume describes the space occupied by the body throughout the movement.', 'Training data'],
  ['Imagine the scene', 'Build worlds that fit that motion.', 'Place compatible obstacles outside the swept body. One motion can become a training example in several imagined scenes. A ducking motion can fit below an obstacle that an upright motion would hit.', 'Training data'],
  ['Learn the planner', 'Learn scene-conditioned whole-body motion.', 'Pair the compatible scene with its motion. The humanoid planner learns to propose motion conditioned on a map, a goal and motion history. The imagined geometry supplies training context.', 'Offline learning'],
  ['Propose motion', 'At runtime, use the provided map.', 'The planner receives the current map, goal and motion history and proposes candidate motions. In the Navigate recordings, the map comes from simulated LiDAR. No scene is being invented by this browser.', 'Runtime planning'],
  ['Check execution', 'Evaluate what the body may actually execute.', 'Clearance and execution checks help select a candidate or fall back when no candidate passes. An execution prediction is an estimate; it does not guarantee contact-free tracking.', 'Runtime selection'],
  ['Track & inspect', 'Let SONIC track. Observe the result.', 'The chosen motion becomes a reference for the existing SONIC tracker. Studio shows the reference beside the executed body, including contact and final error. Planning and tracking can disagree.', 'Recorded execution'],
];
const line = (x1, y1, x2, y2, color = '#2456e6', width = 9) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${color}" stroke-width="${width}" stroke-linecap="round"/>`;
function body(x, duck, phase = 0, color = '#2456e6', opacity = 1) {
  const hip = 239 + duck * 31, shoulder = 177 + duck * 51, head = shoulder - 25, step = Math.sin(phase * Math.PI * 4) * 17;
  return `<g opacity="${opacity}">${line(x, shoulder, x - duck * 16, hip, color, 13)}<circle cx="${x + duck * 6}" cy="${head}" r="14" fill="${color}"/>${line(x, shoulder + 7, x + 24, shoulder + 36, color, 7)}${line(x + 24, shoulder + 36, x + 38, shoulder + 31, color, 7)}${line(x - duck * 16, hip, x + 18 + step, 279, color)}${line(x + 18 + step, 279, x + step, 317, color)}${line(x - duck * 16, hip, x - 17 - step, 281, color)}${line(x - 17 - step, 281, x - step - 12, 317, color)}<circle cx="${x - duck * 16}" cy="${hip}" r="5" fill="white"/><circle cx="${x + 18 + step}" cy="279" r="4" fill="white"/></g>`;
}
function sketch({ step, progress, scene, motion }) {
  const duckAt = x => motion === 'duck' ? Math.max(0, Math.min(1, (x - 210) / 80, (560 - x) / 80)) : 0;
  const envelope = motion === 'duck' ? 'M65 133 H210 L290 184 H480 L560 133 H650 V326 H65Z' : 'M65 133 H650 V326 H65Z';
  const floor = '<path d="M35 327H685" stroke="#c3cedb" stroke-width="2"/>';
  const label = (x, y, text, cls = '') => `<text x="${x}" y="${y}" class="${cls}">${escape(text)}</text>`;
  const obstacles = scene % 3 === 0 ? [[290, 62, 190, motion === 'duck' ? 109 : 57], [35, 87, 155, 32], [570, 77, 110, 42]]
    : scene % 3 === 1 ? [[310, 83, 145, motion === 'duck' ? 89 : 36], [40, 53, 125, 59], [570, 52, 110, 65]]
      : [[300, 72, 170, motion === 'duck' ? 98 : 45], [40, 67, 130, 51], [580, 85, 100, 30]];
  const boxes = obstacles.map(([x,y,w,h]) => `<rect class="lfh-obstacle" x="${x}" y="${y}" width="${w}" height="${h}" rx="7"/>`).join('');
  const samples = [105, 222, 340, 458, 595].map((x,i) => body(x, duckAt(x), i / 4, '#2456e6', .12)).join('');
  if (step < 3) return `${step > 0 ? boxes : ''}<path d="${envelope}" fill="#dce8ff" opacity=".65" stroke="#8baff6" stroke-dasharray="5 6"/>${floor}${samples}${body(100 + progress * 500, duckAt(100 + progress * 500), progress)}${label(35, 32, step === 0 ? 'THE MOTION IS THE STARTING POINT' : step === 1 ? `COMPATIBLE SCENE ${scene % 3 + 1}` : 'SCENE + MOTION → TRAINING PAIR', 'lfh-svg-kicker')}${label(35, 365, 'Blue: space the body sweeps through', 'lfh-svg-note')}${step === 2 ? '<rect x="454" y="346" width="228" height="34" rx="17" fill="#2456e6"/><text x="568" y="368" text-anchor="middle" fill="white">conditional whole-body planner</text>' : label(685, 365, 'Side view · conceptual', 'lfh-svg-note lfh-right')}`;
  if (step < 5) {
    const candidates = ['M80 282C180 275 220 130 350 150S500 190 638 102', 'M80 282C215 310 285 280 370 222S500 230 565 205Q600 185 638 102', 'M80 282C175 190 270 195 340 250S530 240 638 102'];
    return `${label(35,32,step === 3 ? 'MAP + GOAL + MOTION HISTORY' : 'CLEARANCE + EXECUTION CHECK', 'lfh-svg-kicker')}<g class="lfh-map"><rect x="225" y="82" width="45" height="138" rx="6"/><rect x="375" y="244" width="45" height="95" rx="6"/><rect x="505" y="55" width="35" height="123" rx="6"/></g>${candidates.map((d,i) => `<path d="${d}" fill="none" stroke="${step === 4 && i === 1 ? '#138a4a' : ['#93aee5','#2456e6','#b1bfd2'][i]}" stroke-width="${i === 1 ? 6 : 3}" stroke-dasharray="${step === 4 && i !== 1 ? '5 7' : 'none'}" opacity="${step === 4 && i !== 1 ? .35 : .85}"/>`).join('')}<circle cx="80" cy="282" r="12" fill="#2456e6"/><circle cx="638" cy="102" r="14" fill="#fff" stroke="#138a4a" stroke-width="3"/>${label(46,320,'history', 'lfh-svg-note')}${label(611,74,'goal', 'lfh-svg-note')}${label(35,365,step === 3 ? 'Several candidate motions' : 'Select a candidate, or use a fallback', 'lfh-svg-note')}${label(685,365,'Top view · conceptual','lfh-svg-note lfh-right')}`;
  }
  return `${label(35,32,'REFERENCE → SONIC → EXECUTED BODY', 'lfh-svg-kicker')}${floor}${body(290, .65, progress, '#c2307a', .35)}${body(340, .4, progress, '#2456e6', 1)}${line(425,176,560,176,'#c5cfdd',2)}${label(439,163,'inspect the gap', 'lfh-svg-note')}<circle cx="290" cy="270" r="5" fill="#c2307a"/><circle cx="334" cy="251" r="5" fill="#2456e6"/>${label(35,365,'Pink: reference · Blue: executed body', 'lfh-svg-note')}${label(685,365,'Conceptual · no measured values','lfh-svg-note lfh-right')}`;
}
export function initLfh(root) {
  const state = { step: 0, progress: .48, scene: 0, motion: 'duck' };
  root.innerHTML = `<div class="lfh-steps" role="group" aria-label="Learning from Hallucination, step by step">${STEPS.map(([name],i)=>`<button data-lfh-step="${i}" aria-pressed="${i===0}"><span>0${i+1}</span>${name}</button>`).join('')}</div>
    <div class="lfh-workspace"><div class="lfh-picture"><div class="lfh-proof"><span>Conceptual illustration</span><span data-lfh-hint>Move the slider to explore</span></div><svg viewBox="0 0 720 400" role="img" aria-label="Motion and compatible imagined scenes" data-lfh-svg></svg><div class="lfh-controls"><label>Motion <input data-lfh-progress type="range" min="0" max="100" value="48" aria-label="Inspect the motion"></label><div role="group" aria-label="Motion type"><button data-lfh-motion="duck" aria-pressed="true">Duck</button><button data-lfh-motion="walk" aria-pressed="false">Upright</button></div><button data-lfh-scene>Another scene ↻</button></div></div>
    <div class="lfh-detail" aria-live="polite" aria-atomic="true"><span class="lfh-phase" data-lfh-phase></span><h3 data-lfh-title></h3><p data-lfh-description></p><div class="lfh-key"><span data-lfh-key></span></div><button class="button" data-lfh-next>Next step <span aria-hidden="true">→</span></button></div></div>
    <p class="lfh-caveat">This diagram explains the idea. It is a simplified sketch, not a training sample, a model prediction or recorded robot telemetry. The replays above and below show actual simulated executions.</p>`;
  const svg = root.querySelector('[data-lfh-svg]'), slider = root.querySelector('[data-lfh-progress]');
  let shownStep = -1;
  const draw = () => {
    svg.innerHTML = sketch(state);
    svg.setAttribute('aria-label', `${STEPS[state.step][0]}: ${STEPS[state.step][1]} Conceptual illustration.`);
    root.dataset.step = state.step;
    for (const b of root.querySelectorAll('[data-lfh-step]')) b.setAttribute('aria-pressed', String(Number(b.dataset.lfhStep) === state.step));
    const [name,title,description,phase] = STEPS[state.step];
    if (shownStep !== state.step) {
    root.querySelector('[data-lfh-phase]').textContent = `${String(state.step+1).padStart(2,'0')} / 06 · ${phase}`;
    root.querySelector('[data-lfh-title]').textContent = title;
    root.querySelector('[data-lfh-description]').textContent = description;
    root.querySelector('[data-lfh-key]').textContent = state.step < 3 ? 'Motion → compatible scenes → learning' : 'Provided map → candidate motion → execution';
    root.querySelector('[data-lfh-next]').firstChild.textContent = state.step === 5 ? 'Back to the idea ' : 'Next step ';
    shownStep = state.step;
    }
    root.querySelector('[data-lfh-scene]').disabled = state.step > 2;
    root.querySelector('.lfh-controls').hidden = state.step >= 3;
    root.querySelector('[data-lfh-hint]').textContent = state.step < 3 ? 'Move the slider to explore' : 'Choose a step to explore';
    slider.setAttribute('aria-valuetext', `${Math.round(state.progress * 100)} percent through the illustrative motion`);
  };
  root.addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.hasAttribute('data-lfh-step')) state.step = Number(b.dataset.lfhStep);
    if (b.hasAttribute('data-lfh-next')) state.step = (state.step + 1) % STEPS.length;
    if (b.hasAttribute('data-lfh-scene')) { state.scene++; if (!state.step) state.step = 1; }
    if (b.hasAttribute('data-lfh-motion')) { state.motion = b.dataset.lfhMotion; for (const n of root.querySelectorAll('[data-lfh-motion]')) n.setAttribute('aria-pressed', String(n === b)); }
    draw();
  });
  root.querySelector('.lfh-steps').addEventListener('keydown', e => {
    const dir = {ArrowRight:1, ArrowDown:1, ArrowLeft:-1, ArrowUp:-1}[e.key];
    if (!dir && e.key !== 'Home' && e.key !== 'End') return;
    e.preventDefault(); state.step = e.key === 'Home' ? 0 : e.key === 'End' ? STEPS.length-1 : (state.step + dir + STEPS.length) % STEPS.length;
    draw(); root.querySelector(`[data-lfh-step="${state.step}"]`).focus();
  });
  slider.addEventListener('input', () => { state.progress = Number(slider.value)/100; draw(); });
  draw();
}
