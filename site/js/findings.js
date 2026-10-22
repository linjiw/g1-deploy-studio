// What rehearsing found (docs/STATUS.md open issues, docs/REVIEW-20261021-NAVIGATE.md). The measured cards are
// written from the recordings themselves (data/featured.json, data/worlds.json, made by tools/site/export.py);
// each leads with its number and a still of its example walk (media/stills, made by tools/site/shots.mjs).
import { escape, fmt, GRADES } from './util.js';
import { json, MEDIA } from './data.js';

const pct = (a, b) => (b ? `${Math.round(a / b * 100)} %` : '—');
const SHORT = { detour: 'wall-detour room', slalom: 'alternating-walls room', corridor: 'corridor', doorway: 'doorway room', clutter: 'cluttered room' };

function cards(featured, catalog) {
  const ex = featured.examples ?? {}, f = featured.facts ?? {};
  const deferred = f.deferred ?? {};
  const room = id => catalog.find(w => w.id === id);
  const out = [];
  if (deferred['table-edge']) out.push({ id: 'edge-ceiling', kind: 'robot', tag: 'Robot side · open', num: deferred['table-edge'], unit: deferred['table-edge'] === 1 ? 'walk' : 'walks', title: 'Table-height edges look like ceilings',
    text: "The top edge of an obstacle between 0.8 and 1.35 m tall can be filed in the robot's map as a low ceiling. The navigation node then refuses to stand near it and holds its last plan's pose.",
    method: `In the deploy repository (STATUS #11). Studio blocks goals inside the node's 0.8 m window and warns near the arrival. In these recordings ${deferred['table-edge']} walks deferred their stand next to a table-height box (classified from the recorded map and the room's boxes).` });
  if (deferred.phantom) out.push({ id: 'phantom', kind: 'robot', tag: 'Robot side · open', num: deferred.phantom, unit: 'walks', title: 'Ceilings with nothing overhead',
    text: "Stands get deferred under low overhead cells in the robot's map with no box anywhere near them. The deploy repository's diagnosis (STATUS #15): single high returns from the robot's own arms, in a memory that never forgets.",
    method: `In the deploy repository (STATUS #15). Over a long session the validator saw stalls, deferred stands and falls follow. In these short walks ${deferred.phantom} deferred their stand with no box within 0.5 m of the low overhead cells. Studio's simulated robot offers a fresh-map mode to compare.` });
  const dr = f.deferral_drift;
  if (dr && dr.over_0_5m) out.push({ id: 'drift', kind: 'robot', tag: 'Robot side · measured here', num: fmt(dr.max_m, 1), unit: `m in ${fmt(dr.max_held_s, 0)} s`, title: 'A deferred stand can walk away',
    text: `While the navigation node defers a stand it lets the last plan play out and holds that plan's final frame. In ${dr.over_0_5m} of ${dr.walks} walks with a deferred stand the robot still moved more than 0.5 m. The node's outcome stays "arrived".`,
    method: "On the robot node.py keeps deferring; Studio forces the stand after 20 s only in simulation. The operator stands the robot with the remote's D-up, only if nothing is directly above it (STATUS #18). Simulation, one seed per goal." });
  const c = f.contact ?? {}, worst = Object.entries(c).sort((a, b) => b[1].over_100n / b[1].walks - a[1].over_100n / a[1].walks)[0];
  if (worst && worst[1].over_100n) {
    const [w, v] = worst;
    out.push({ id: 'contact', kind: 'policy', tag: 'Policy · measured here', num: `${v.over_100n}/${v.walks}`, unit: 'walks', title: `Obstacles get pushed in the ${SHORT[w] ?? w}`,
      text: `${v.over_100n} of ${v.walks} walks there pushed an obstacle with more than 100 N${v.at_wall_end ? `, ${v.at_wall_end} of them within 0.6 m of a wall's end, where the walk turns into the opening` : ''}. Most still "arrived": the node's outcome does not see contact.`,
      method: `Peak obstacle contact force, simulator truth, at any frame. By room: ${Object.entries(c).map(([k, x]) => `${room(k)?.title ?? k} ${x.over_100n} of ${x.walks}`).join(' · ')}.` });
  }
  const d = f.doorway;
  if (d && d.far_goals) {
    const door = d.door_halfwidth_m ? `${fmt(2 * d.door_halfwidth_m, 1)} m` : 'single';
    const other = d.crossed_elsewhere ?? 0, never = d.far_goals - d.through_door - other;
    out.push({ id: 'doorway', kind: 'policy', tag: 'Policy · measured here', num: `${d.through_door}/${d.far_goals}`, unit: 'through the door', title: `Through a ${door} door`,
      text: `The doorway room has one ${door} door in a 2 m wall that runs past the edge of the planner's map. Of ${d.far_goals} walks to the far side, ${d.through_door} went through the door (${pct(d.through_door, d.far_goals)}); ${d.through_clean} of those arrived without contact over 100 N.`,
      method: `A walk goes through the door when its pelvis (simulator truth) crosses the wall's line within the door${other ? `; ${other} crossed the wall line elsewhere` : ''}${never > 0 ? `; ${never} never reached the wall` : ''}. Simulation, one seed per goal.` });
  }
  const b = f.beam;
  if (b && b.walks_under) {
    const low = Math.min(...b.pelvis_under_m), m = list => list.map(v => (v === null ? '—' : v.toFixed(2))).join(', ');
    out.push({ id: 'beam', kind: 'policy', tag: 'Policy · measured here', num: fmt(low, 2), unit: 'm lowest pelvis', title: 'Under a beam it has only seen',
      text: `In the corridor a beam hangs ${fmt(b.beam_bottom_m, 2)} m above the floor; the planner never receives it as a box, only as overhead cells in its map. ${b.walks_under} walks passed under it.`,
      method: `Lowest pelvis under the beam: ${m(b.pelvis_under_m)} m, against a median of ${m(b.pelvis_elsewhere_m)} m on the rest of each walk${b.planned_under_m ? `; the plan's lowest pelvis there: ${m(b.planned_under_m)} m` : ''}. ${b.clean ? `${b.clean} of them arrived without contact over 100 N.` : 'None of them is clean: each also pushed against a corridor wall with more than 100 N.'}` });
  }
  out.push(
    { id: 'fail-open', kind: 'studio', tag: 'Studio · fixed', num: 'Fixed', title: 'Goal checks used to fail open',
      text: 'With no map, an unchecked goal could reach the node. Now the gateway and the robot link both refuse unless the check ran and passed.',
      method: 'Found by the independent reviewer (H2); fixed and re-verified.', link: 'https://github.com/linjiw/g1-deploy-studio/blob/main/docs/REVIEW-20261021-NAVIGATE.md' },
    { id: 'frames', kind: 'studio', tag: 'Studio · fixed', num: 'Fixed', title: 'Two odometry frames, one map',
      text: "The console's default leg odometry is not the frame Studio draws LIO in, so readbacks failed. Goals are now refused unless the node's position matches LIO within 10 cm.",
      method: 'Found in review (H4). The docs require --odom zmq. Try the leg-odometry switch in the robot day.', anchor: '#robot-day' },
    { id: 'readback', kind: 'studio', tag: 'Studio · fixed', num: 'Fixed', title: 'A "refused" goal could still be walked',
      text: "node.py applies a goal before Studio reads it back. A readback that did not match used to look like a refusal, yet Go walked to it. Now the node's goal shows as verified, unverified or not from Studio.",
      method: 'Found in review (H3). Try the console-goal switch in the robot day.', anchor: '#robot-day' });
  return out.map(card => ({ ...card, example: ex[card.id] ?? null }));
}

export async function initFindings(container, table) {
  const [featured, catalog] = await Promise.all([json('featured.json').catch(() => ({})), json('worlds.json').then(c => c.worlds).catch(() => [])]);
  container.innerHTML = cards(featured, catalog).map(f => {
    const ex = f.example;
    const href = ex ? `#try/${ex.world}/${ex.goal}/play${ex.at ? `@${Math.max(0, ex.at - 2).toFixed(1)}` : ''}` : f.anchor ?? f.link;
    const fixed = f.num === 'Fixed';
    const shot = ex
      ? `<a class="shot" href="${href}" aria-label="${escape(ex.label ?? 'Watch it')}"><img src="${MEDIA}stills/${f.id}.jpg" width="640" height="360" loading="lazy" alt="" onerror="this.parentNode.classList.add('blank');this.remove()"><span class="play">▶ ${escape(ex.label ?? 'Watch it')}</span></a>`
      : fixed ? '' : `<div class="shot blank" aria-hidden="true"><span>${escape(f.tag)}</span></div>`;
    // One way in per card: the still is the link when there is an example.
    const watch = ex ? ''
      : f.anchor ? `<a class="watch" href="${f.anchor}">Try it →</a>` : f.link ? `<a class="watch" href="${f.link}">Read the record →</a>` : '';
    const lead = fixed ? '<span class="fixed-badge">✓ Fixed in review</span>' : `<p class="num">${escape(String(f.num))}${f.unit ? `<small>${escape(f.unit)}</small>` : ''}</p>`;
    return `<article class="finding${fixed ? ' fixed' : ''}">${shot}<div class="body"><span class="kind ${f.kind}">${escape(f.tag)}</span>
      ${lead}<h3>${escape(f.title)}</h3><p>${escape(f.text)}</p>
      <details><summary>How this was measured</summary>${ex?.note ? `<p>${escape(ex.note)}</p>` : ''}<p>${escape(f.method)}</p></details>${watch}</div></article>`;
  }).join('');
  if (table) outcomeTable(table, catalog);
}

// Every walk, by room and grade (worlds.json grades: the same rule as the demo's colours).
function outcomeTable(table, catalog) {
  const keys = Object.keys(GRADES).filter(k => catalog.some(w => w.grades?.[k]));
  // A count opens the demo's room menu on those walks (all rooms: the Went wrong folder).
  const cell = (n, k, folder) => {
    const cls = !n ? 'zero' : k === 'clean' ? '' : ['estop', 'fell'].includes(k) ? 'badcell' : 'hotcell';
    const open = n && folder && !(folder === 'wrong' && k === 'clean');
    const what = `${n} ${GRADES[k]?.label ?? k} walks${folder === 'wrong' ? ' in all rooms' : ''}`;
    return `<td class="${cls}">${open ? `<button class="cell" data-folder="${folder}" data-grade="${k}" title="Open these walks in the demo" aria-label="Open the ${escape(what)} in the demo">${n}</button>` : n ?? 0}</td>`;
  };
  const total = k => catalog.reduce((n, w) => n + (w.grades?.[k] ?? 0), 0);
  table.insertAdjacentHTML('beforeend', `<thead><tr><th>Room</th>${keys.map(k => `<th><i style="background:${GRADES[k].css}"></i>${escape(GRADES[k].short)}</th>`).join('')}<th>Walks</th></tr></thead>
    <tbody>${catalog.map(w => `<tr><td>${escape(w.title)}</td>${keys.map(k => cell(w.grades?.[k], k, w.id)).join('')}<td>${w.walks}</td></tr>`).join('')}</tbody>
    <tfoot><tr><td>All rooms</td>${keys.map(k => cell(total(k), k, 'wrong')).join('')}<td>${catalog.reduce((n, w) => n + w.walks, 0)}</td></tr></tfoot>`);
  table.addEventListener('click', e => {
    const b = e.target.closest('button.cell');
    if (b) document.dispatchEvent(new CustomEvent('site:pick', { detail: { folder: b.dataset.folder, grade: b.dataset.grade } }));
  });
}
