// The next-step page: the execution gap, measured by Studio in its own recordings (data/featured.json facts).
// A local build may add data/next-local.json (tools/site/build.sh NEXT_LOCAL=...): material that is not
// published. The public build ships an empty one, so the public page shows only what Studio measured.
import { $, escape, fmt } from './util.js';
import { json } from './data.js';
import { initCloserSection } from './closer-section.js';

initCloserSection({ chips: $('closer-chips'), stage: $('closer-stage'), caption: $('closer-caption'), keep: sc => sc.mode === 'body' }).loaded.catch(console.error);
const [featured, catalog] = await Promise.all([json('featured.json'), json('worlds.json').then(c => c.worlds)]);

const f = featured.facts ?? {}, ex = f.execution, c = f.contact ?? {};
const room = id => catalog.find(w => w.id === id)?.title ?? id;

// ----- three numbers
const worst = Object.entries(c).sort((a, b) => b[1].over_100n / b[1].walks - a[1].over_100n / a[1].walks)[0];
const cards = [];
if (ex) {
  cards.push({ num: `${fmt(ex.lag_m.median, 2)} m`, title: 'from plan body to body', text: `Median distance from the plan body's pelvis to where the robot thinks its pelvis is, over ${ex.frames.toLocaleString('en-US')} walking frames of ${ex.walks} walks (95th percentile ${fmt(ex.lag_m.p95, 2)} m). SONIC is never given the pelvis position.`, fn: 'fn-body' });
  cards.push({ num: `${fmt(ex.joint_rms_deg.median, 1)}°`, title: 'joint gap while walking', text: `Median RMS gap over the 29 joint angles between the plan body and the executed body (95th percentile ${fmt(ex.joint_rms_deg.p95, 1)}°).`, fn: 'fn-joints' });
}
if (worst && worst[1].over_100n) {
  const [w, v] = worst;
  cards.push({ num: `${v.over_100n}/${v.walks}`, title: `${room(w).toLowerCase()} walks pushed an obstacle`, text: `With more than 100 N${v.at_wall_end ? `; ${v.at_wall_end} of them within 0.6 m of a wall's end, where the walk turns into the opening` : ''}. The node's outcome does not see contact, so most still "arrived".`, fn: 'fn-contact' });
}
$('numbers-cards').innerHTML = cards.map(x => `<article class="hl"><b>${escape(x.num)}</b><h3>${escape(x.title)}<sup><a href="#${x.fn}">${{ 'fn-body': 1, 'fn-joints': 2, 'fn-contact': 3 }[x.fn]}</a></sup></h3><p>${escape(x.text)}</p></article>`).join('');

// ----- per room
if (ex) {
  $('gap-table').insertAdjacentHTML('beforeend', `<thead><tr><th>Room</th><th>Plan to body, median</th><th>Contact over 100 N</th><th>Walks</th></tr></thead><tbody>${
    catalog.map(w => `<tr><td>${escape(w.title)}</td><td>${ex.lag_by_room_m?.[w.id] == null ? '—' : `${fmt(ex.lag_by_room_m[w.id], 2)} m`}</td><td class="${c[w.id]?.over_100n ? 'hotcell' : 'zero'}">${c[w.id] ? `${c[w.id].over_100n} of ${c[w.id].walks}` : '—'}</td><td>${w.walks}</td></tr>`).join('')}</tbody>`);
}

// ----- one plan, two trackers: SONIC's column is measured; the other stays empty until it is run
const b = f.beam, d = f.doorway, dr = f.deferral_drift;
const falls = catalog.reduce((n, w) => n + (w.outcomes.estop ?? 0) + (w.outcomes.fell ?? 0), 0), walks = catalog.reduce((n, w) => n + w.walks, 0);
const rows = [
  c.corridor && ['Wall end', "corridor walks with contact over 100 N (within 0.6 m of a wall's end)", `${c.corridor.over_100n} of ${c.corridor.walks} (${c.corridor.at_wall_end ?? '—'})`],
  b?.walks_under && (() => {
    // One walk's two numbers, the one that went lowest: its executed pelvis and its plan's, under the beam.
    const i = b.pelvis_under_m.indexOf(Math.min(...b.pelvis_under_m)), planned = b.planned_under_m?.[i];
    return ['Low beam', 'lowest pelvis under the beam: body (its plan), the walk that went lowest', `${fmt(b.pelvis_under_m[i], 2)} m (${planned == null ? '—' : `${fmt(planned, 2)} m`})`];
  })(),
  d?.far_goals && ['Tight passage', 'far-side walks through the 1 m door, clean', `${d.through_door} of ${d.far_goals}, ${d.through_clean} clean`],
  dr?.walks && ['Deferred stand', 'walks that moved more than 0.5 m while deferred', `${dr.over_0_5m} of ${dr.walks}`],
  ex && ['Walking', 'plan to body, median (95th percentile)', `${fmt(ex.lag_m.median, 2)} m (${fmt(ex.lag_m.p95, 2)} m)`],
  ['Falls and E-stops', 'all rooms', `${falls} of ${walks}`],
].filter(Boolean);
$('tracker-table').insertAdjacentHTML('beforeend', `<thead><tr><th>Scenario</th><th>Measure</th><th>SONIC · measured here</th><th>Another tracker</th></tr></thead><tbody>${
  rows.map(([s, m, v]) => `<tr><td>${escape(s)}</td><td class="measure">${escape(m)}</td><td>${escape(v)}</td><td class="zero">not run</td></tr>`).join('')}</tbody>`);

// ----- material that only a local build carries
const local = await json('next-local.json').catch(() => null);
if (local?.sections?.length) {
  const box = $('local');
  box.hidden = false;
  box.innerHTML = `<div class="section-head"><p class="eyebrow">${escape(local.eyebrow ?? 'Local build only · not deployed')}</p><h2>${escape(local.title ?? '')}</h2>${local.note ? `<p>${escape(local.note)}</p>` : ''}</div>${
    local.sections.map(s => s.kind === 'numbers'
      ? `<h3 class="local-h">${escape(s.title)}</h3><div class="highlights">${s.items.map(x => `<article class="hl"><b>${escape(x.num)}</b><h3>${escape(x.title)}</h3><p>${escape(x.text)}</p>${x.source ? `<p class="fineprint">${escape(x.source)}</p>` : ''}</article>`).join('')}</div>`
      : s.kind === 'ladder'
        ? `<h3 class="local-h">${escape(s.title)}</h3><ol class="ladder">${s.items.map(x => `<li><span class="rung">${escape(x.id)}</span><div><b>${escape(x.title)}</b><p>${escape(x.text ?? '')}</p>${x.gate ? `<p class="fineprint">Gate: ${escape(x.gate)}</p>` : ''}</div><span class="status ${escape(x.status_kind ?? '')}">${escape(x.status ?? '')}</span></li>`).join('')}</ol>`
        : `<h3 class="local-h">${escape(s.title)}</h3><p class="muted">${escape(s.text ?? '')}</p>`).join('')}`;
}
