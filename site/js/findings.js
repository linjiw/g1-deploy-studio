// What rehearsing found (docs/STATUS.md open issues, docs/REVIEW-20261021-NAVIGATE.md). The measured cards are
// written from the recordings themselves (data/featured.json, data/worlds.json, made by tools/site/export.py).
import { escape } from './util.js';
import { json } from './data.js';

const pct = (a, b) => (b ? `${Math.round(a / b * 100)} %` : '—');

function cards(featured, catalog) {
  const ex = featured.examples ?? {}, f = featured.facts ?? {};
  const deferred = f.deferred ?? {};
  const room = id => catalog.find(w => w.id === id);
  const out = [
    { id: 'edge-ceiling', kind: 'robot', tag: 'Robot side · open', title: 'Table-height edges look like ceilings',
      text: "The top edge of an obstacle between 0.8 and 1.35 m tall can be filed in the robot's map as a low ceiling. node.py then refuses to stand near it and the robot holds its last plan's pose; in one simulated session it leaned on a pillar and drifted about a metre.",
      status: `In the deploy repository (STATUS #11). Studio blocks goals inside the node's 0.8 m window and warns near the arrival.${deferred['table-edge'] ? ` In these recordings: ${deferred['table-edge']} walks deferred their stand next to a table-height box.` : ''}` },
    { id: 'phantom', kind: 'robot', tag: 'Robot side · open', title: "The robot's own arms leave phantom ceilings",
      text: "Single high returns from the robot's arms become overhead cells in a memory that never forgets. Over a long session the validator saw stalls, deferred stands and falls follow.",
      status: `In the deploy repository (STATUS #15). Studio's simulated robot offers a fresh-map mode to compare.${deferred.phantom ? ` In these short walks: ${deferred.phantom} deferred their stand with nothing that low nearby.` : ''}` },
  ];
  const dr = f.deferral_drift;
  if (dr && dr.over_0_5m) {
    out.push({ id: 'drift', kind: 'robot', tag: 'Robot side · measured here', title: 'A deferred stand can walk away',
      text: `While node.py defers a stand it does not stand: it lets the last plan play out and then holds that plan's final frame. In ${dr.over_0_5m} of ${dr.walks} recorded walks with a deferred stand the robot still moved more than 0.5 m while it waited, up to ${dr.max_m.toFixed(1)} m in ${dr.max_held_s.toFixed(0)} s. The node's outcome stays "arrived".`,
      status: "On the robot node.py keeps deferring; Studio forces the stand after 20 s only in simulation. The operator stands the robot with the remote's D-up, only if nothing is directly above it. Simulation, one seed per goal." });
  }
  const SHORT = { detour: 'wall-detour room', slalom: 'alternating-walls room', corridor: 'corridor', doorway: 'doorway room', clutter: 'cluttered room' };
  const c = f.contact ?? {}, worst = Object.entries(c).sort((a, b) => b[1].over_100n / b[1].walks - a[1].over_100n / a[1].walks)[0];
  if (worst && worst[1].over_100n) {
    const [w, v] = worst;
    out.push({ id: 'contact', kind: 'policy', tag: 'Policy · measured here', title: `Walls get touched in the ${SHORT[w] ?? w}`,
      text: `${v.over_100n} of ${v.walks} recorded walks there pushed against a wall with more than 100 N${v.at_wall_end ? `, ${v.at_wall_end} of them within 0.6 m of a wall's end, where the walk turns into the opening` : ''}. Most still "arrived": the node's outcome does not see contact. The playground marks them amber.`,
      status: Object.entries(c).map(([k, x]) => `${room(k)?.title ?? k}: ${x.over_100n} of ${x.walks}`).join(' · ') });
  }
  const d = f.doorway;
  if (d && d.far_goals) {
    const door = d.door_halfwidth_m ? `${(2 * d.door_halfwidth_m).toFixed(1)} m` : 'single';
    const other = d.crossed_elsewhere ?? 0;
    out.push({ id: 'doorway', kind: 'policy', tag: 'Policy · measured here', title: `Through a ${door} door`,
      text: `The doorway room has one ${door} door in a 2 m wall that runs past the edge of the planner's map. Of ${d.far_goals} recorded walks to goals on the far side, ${d.through_door} went through the door (${pct(d.through_door, d.far_goals)})${other ? ` and ${other} crossed the wall line elsewhere` : ''}${d.far_goals - d.through_door - other > 0 ? `; ${d.far_goals - d.through_door - other} never reached the wall` : ''}; ${d.through_clean} of those through the door arrived without contact over 100 N.`,
      status: 'Simulation, one seed per goal. Not a hardware result.' });
  }
  const b = f.beam;
  if (b && b.walks_under) {
    const m = list => list.map(v => v.toFixed(2)).join(', ');
    out.push({ id: 'beam', kind: 'policy', tag: 'Policy · measured here', title: 'Under a beam it has only seen',
      text: `In the corridor a beam hangs ${b.beam_bottom_m.toFixed(2)} m above the floor; the planner never receives it as a box, only as overhead cells in its map. ${b.walks_under} recorded walks passed under it. Lowest pelvis height under the beam: ${m(b.pelvis_under_m)} m, against a median of ${m(b.pelvis_elsewhere_m)} m on the rest of each walk.`,
      status: b.clean ? `${b.clean} of them arrived without contact over 100 N.` : 'None of them is clean: each also pushed against a corridor wall with more than 100 N.' });
  }
  out.push(
    { id: 'fail-open', kind: 'studio', tag: 'Studio · fixed', title: 'Goal checks used to fail open',
      text: 'With no map, an unchecked goal could reach the node. Now the gateway and the robot link both refuse unless the check ran and passed.',
      status: 'Found by the independent reviewer (H2); fixed and re-verified.', link: 'https://github.com/linjiw/g1-deploy-studio/blob/main/docs/REVIEW-20261021-NAVIGATE.md' },
    { id: 'frames', kind: 'studio', tag: 'Studio · fixed', title: 'Two odometry frames, one map',
      text: "The console's default leg odometry is not the frame Studio draws LIO in, so readbacks failed. Goals are now refused unless the node's position matches LIO within 10 cm, and the docs require --odom zmq.",
      status: 'Found in review (H4). Try the leg-odometry switch in the robot day.', anchor: '#robot-day' },
    { id: 'readback', kind: 'studio', tag: 'Studio · fixed', title: 'A "refused" goal could still be walked',
      text: "node.py applies a goal before Studio reads it back. A readback that did not match used to look like a refusal, yet Go walked to it. The node's goal is now shown as verified, unverified or not from Studio, with a red warning.",
      status: 'Found in review (H3). Try the console-goal switch in the robot day.', anchor: '#robot-day' });
  return out.map(card => ({ ...card, example: ex[card.id] ?? null }));
}

export async function initFindings(container) {
  const [featured, catalog] = await Promise.all([json('data/featured.json').catch(() => ({})), json('data/worlds.json').then(c => c.worlds).catch(() => [])]);
  container.innerHTML = cards(featured, catalog).map(f => {
    const ex = f.example;
    const watch = ex ? `<a class="button watch" href="#try/${ex.world}/${ex.goal}/play">${escape(ex.label ?? 'Watch it')}</a>`
      : f.anchor ? `<a class="button ghost watch" href="${f.anchor}">Try it</a>`
      : f.link ? `<a class="button ghost watch" href="${f.link}">Read the record</a>` : '';
    return `<article class="card finding"><span class="kind ${f.kind}">${escape(f.tag)}</span><h3>${escape(f.title)}</h3><p>${escape(f.text)}</p>
      ${ex?.note ? `<p class="status">${escape(ex.note)}</p>` : ''}<p class="status">${escape(f.status)}</p>${watch}</article>`;
  }).join('');
}
