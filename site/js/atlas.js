// "Every walk, one dot": every recorded walk by its distance from the start mark against a measure of how it went
// (worlds.json list rows, the same files the demo plays). Move across the chart, or use the arrow keys, to read a
// walk; click it, or press Enter, to watch it in the demo.
import { escape, fmt, GRADES } from './util.js';
import { json } from './data.js';

const METRICS = {
  final: { label: 'Final distance from the goal', short: 'Final distance', unit: 'm', kind: 'simulator truth', log: true, min: 0.01, max: 5,
           get: r => r.final, ticks: [0.01, 0.1, 0.4, 1, 4], lines: [[0.4, "node.py's 0.4 m radius (it uses its estimate)"], [0.6, 'flagged over 0.6 m']] },
  contact: { label: 'Hardest push on an obstacle', short: 'Peak contact', unit: 'N', kind: 'simulator truth', log: true, min: 1, max: 2000, zero: 'no contact',
             get: r => r.contact, ticks: [1, 10, 100, 1000], lines: [[100, 'flagged over 100 N']] },
  time: { label: 'Recording length, from Go to the end (walk and stand)', short: 'Recording length', unit: 's', kind: 'simulated', log: false, min: 0, max: 70,
          get: r => r.duration, ticks: [0, 10, 20, 30, 40, 50, 60, 70], lines: [] },
};
const FAILED = new Set(['fell', 'estop']);

export async function initAtlas(root) {
  const catalog = (await json('worlds.json')).worlds;
  const titles = Object.fromEntries(catalog.map(w => [w.id, w.title]));
  const rows = catalog.flatMap(w => (w.list ?? []).map(r => {
    const o = Object.fromEntries((w.list_fields ?? []).map((k, i) => [k, r[i]]));
    // Goals sit on a 0.4 m lattice, so distances repeat: a small fixed offset per walk keeps the dots apart.
    let h = 0; for (const ch of `${w.id}${o.id}`) h = (h * 31 + ch.charCodeAt(0)) % 997;
    return { room: w.id, id: o.id, grade: o.grade, dist: o.dist_m, contact: o.contact_n ?? null, final: o.final_m ?? null, duration: o.duration_s ?? null, jitter: (h / 997 - 0.5) * 0.16 };
  }));
  const S = { metric: 'final', room: 'all', at: -1, keyed: false };
  root.innerHTML = `
    <div class="atlas-bar">
      <div class="chips" role="group" aria-label="Measure">${Object.entries(METRICS).map(([k, m]) => `<button data-metric="${k}" aria-pressed="${k === S.metric}">${escape(m.short)}</button>`).join('')}</div>
      <div class="chips" role="group" aria-label="Room"><button data-room="all" aria-pressed="true">All rooms</button>${catalog.map(w => `<button data-room="${w.id}" aria-pressed="false">${escape(w.title)}</button>`).join('')}</div>
    </div>
    <div class="atlas-read" aria-live="off"><p class="muted">Move across the chart to read a walk, or focus it and use the arrow keys (left and right by distance, up and down by the measure). Click a dot, or press Enter, to watch that walk in the demo.</p></div>
    <div class="atlas-plot"><svg role="group" tabindex="0" aria-roledescription="chart" aria-describedby="atlas-desc"></svg></div>
    <p class="sr-only" id="atlas-desc"></p>
    <p class="fineprint atlas-legend"><i class="ok"></i>arrived cleanly <i class="warn"></i>flagged: contact over 100 N or off target <i class="bad sq"></i>fell or E-stop. One dot per walk, nudged sideways by up to 0.08 m so dots on the same lattice distance stay apart; values past an axis sit on its edge. Simulation, one seed per goal. <span class="atlas-missing"></span></p>`;
  const svg = root.querySelector('svg'), read = root.querySelector('.atlas-read');
  const hint = read.innerHTML;
  let pts = [];
  const draw = () => {
    const m = METRICS[S.metric], W = root.querySelector('.atlas-plot').clientWidth || 800, H = Math.max(300, Math.min(420, W * 0.42));
    const L = 58, R = 16, T = 14, B = 44, maxX = 6.4;
    const x = d => L + (d / maxX) * (W - L - R);
    const zeroBand = m.zero ? 22 : 0;
    const y = v => {
      if (m.zero && !(v > 0)) return H - B;  // the 'no contact' band
      const top = T, bottom = H - B - zeroBand;
      const f = m.log ? (Math.log10(Math.max(m.min, v)) - Math.log10(m.min)) / (Math.log10(m.max) - Math.log10(m.min)) : (v - m.min) / (m.max - m.min);
      return bottom - Math.max(0, Math.min(1, f)) * (bottom - top);
    };
    const inRoom = rows.filter(r => S.room === 'all' || r.room === S.room);
    const shown = inRoom.filter(r => m.get(r) !== null && m.get(r) !== undefined);  // no value, no dot (counted below)
    pts = shown.map(r => ({ r, px: x(Math.max(0, r.dist + r.jitter)), py: y(m.get(r)) })).sort((a, b) => a.px - b.px || a.py - b.py);
    const grid = m.ticks.map(t => `<line class="grid" x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/><text class="tick" x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${t}</text>`).join('');
    const xticks = [1, 2, 3, 4, 5, 6].map(t => `<line class="grid v" x1="${x(t)}" x2="${x(t)}" y1="${T}" y2="${H - B}"/><text class="tick" x="${x(t)}" y="${H - B + 18}" text-anchor="middle">${t} m</text>`).join('');
    const lines = m.lines.map(([v, label]) => `<line class="rule" x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}"/><text class="rule-label" x="${W - R - 6}" y="${y(v) - 6}" text-anchor="end">${escape(label)}</text>`).join('');
    const band = m.zero ? `<text class="tick" x="${L - 8}" y="${H - B + 4}" text-anchor="end">0</text><text class="rule-label" x="${L + 6}" y="${H - B - 8}">${escape(m.zero)}</text>` : '';
    const dots = pts.map((p, i) => FAILED.has(p.r.grade)
      ? `<rect class="dot ${cls(p.r.grade)}" data-i="${i}" x="${p.px - 4.5}" y="${p.py - 4.5}" width="9" height="9" transform="rotate(45 ${p.px} ${p.py})"/>`
      : `<circle class="dot ${cls(p.r.grade)}" data-i="${i}" cx="${p.px}" cy="${p.py}" r="4"/>`).join('');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.setAttribute('aria-label', `${m.label} (${m.unit}, ${m.kind}) against distance from the start mark, for ${shown.length} walks${S.room === 'all' ? '' : ` in the ${titles[S.room]} room`}`);
    svg.innerHTML = `${grid}${xticks}${lines}${band}
      <text class="axis" x="${(L + W - R) / 2}" y="${H - 6}" text-anchor="middle">distance from the start mark to the goal</text>
      <text class="axis" transform="translate(14 ${(T + H - B) / 2}) rotate(-90)" text-anchor="middle">${escape(m.short)} (${m.unit}${m.log ? ', log scale' : ''})</text>
      <g class="dots">${dots}</g><circle class="focus-ring" r="9" visibility="hidden"/>`;
    const n = k => shown.filter(r => k(r)).length;
    const missing = inRoom.length - shown.length;
    root.querySelector('.atlas-missing').textContent = missing ? `${missing} walks have no ${m.short.toLowerCase()} recorded and are not drawn.` : '';
    root.querySelector('#atlas-desc').textContent = `Scatter chart of ${shown.length} recorded walks.${missing ? ` ${missing} have no value and are not drawn.` : ''} ${n(r => r.grade === 'clean')} arrived cleanly, ${n(r => !FAILED.has(r.grade) && r.grade !== 'clean')} were flagged, ${n(r => FAILED.has(r.grade))} fell or hit the E-stop. Use the arrow keys to move between walks and Enter to watch one.`;
    if (S.at >= pts.length) S.at = -1;
    mark();
  };
  const mark = () => {
    const ring = svg.querySelector('.focus-ring'), p = pts[S.at];
    if (!p) {
      ring.setAttribute('visibility', 'hidden');
      read.setAttribute('aria-live', S.keyed ? 'polite' : 'off');
      read.innerHTML = pts.length ? hint : '<p class="muted">No recorded values are available for this measure in this room. Choose another measure or room.</p>';
      return;
    }
    ring.setAttribute('cx', p.px); ring.setAttribute('cy', p.py); ring.setAttribute('visibility', 'visible');
    const m = METRICS[S.metric], r = p.r, g = GRADES[r.grade] ?? { label: r.grade };
    const value = m.get(r);
    read.setAttribute('aria-live', S.keyed ? 'polite' : 'off');
    read.innerHTML = `<p><b style="color:${g.css ?? 'inherit'}">${escape(g.label)}</b> · ${escape(titles[r.room])} · goal ${fmt(r.dist, 1)} m from the start</p>
      <p class="muted">${escape(m.short)}: <b>${value === null || value === undefined ? '—' : `${fmt(value, m.unit === 'N' ? 0 : m.unit === 's' ? 1 : 2)} ${m.unit}`}</b> (${escape(m.kind)}) · peak contact ${r.contact === null ? '—' : `${fmt(r.contact, 0)} N`} · ends ${fmt(r.final, 2)} m from the goal by simulator truth · ${fmt(r.duration, 1)} s recorded</p>
      <a class="watch" href="#try/${r.room}/${r.id}/play" data-room="${r.room}" data-id="${r.id}">Watch this walk →</a>`;
  };
  const nearest = e => {
    const b = svg.getBoundingClientRect(), vb = svg.viewBox.baseVal, sx = vb.width / b.width;
    const mx = (e.clientX - b.left) * sx, my = (e.clientY - b.top) * sx;
    let best = -1, bd = 16 * sx;
    pts.forEach((p, i) => { const d = Math.hypot(p.px - mx, p.py - my); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  svg.addEventListener('pointermove', e => { const i = nearest(e); if (i >= 0 && i !== S.at) { S.at = i; S.keyed = false; mark(); } });
  svg.addEventListener('click', e => { const i = nearest(e); if (i >= 0) watch(pts[i].r); });
  svg.addEventListener('keydown', e => {
    if (!pts.length) return;
    const step = { ArrowRight: 1, ArrowLeft: -1, PageDown: 10, PageUp: -10 }[e.key];
    if (step) { e.preventDefault(); S.keyed = true; S.at = Math.max(0, Math.min(pts.length - 1, (S.at < 0 ? -1 : S.at) + step)); mark(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault(); S.keyed = true;
      if (S.at < 0) { S.at = 0; mark(); return; }
      const p = pts[S.at], up = e.key === 'ArrowUp';
      let best = -1, bd = Infinity;
      pts.forEach((q, i) => { if (i === S.at || (up ? q.py >= p.py - 0.5 : q.py <= p.py + 0.5)) return; const d = Math.abs(q.py - p.py) + 3 * Math.abs(q.px - p.px); if (d < bd) { bd = d; best = i; } });
      if (best >= 0) { S.at = best; mark(); }
    }
    else if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); S.keyed = true; S.at = e.key === 'Home' ? 0 : pts.length - 1; mark(); }
    else if (e.key === 'Enter' && pts[S.at]) { e.preventDefault(); watch(pts[S.at].r); }
  });
  svg.addEventListener('focus', () => { if (S.at < 0 && pts.length) { S.at = 0; S.keyed = true; mark(); } });
  // The readout's link plays its walk even when the page's link already names it.
  read.addEventListener('click', e => { const a = e.target.closest('a.watch'); if (a) { e.preventDefault(); watch({ room: a.dataset.room, id: a.dataset.id }); } });
  root.addEventListener('click', e => {
    if (e.target.closest('.atlas-read')) return;
    const b = e.target.closest('[data-metric], [data-room]');
    if (!b) return;
    if (b.dataset.metric) S.metric = b.dataset.metric; else S.room = b.dataset.room;
    for (const x of root.querySelectorAll(b.dataset.metric ? '[data-metric]' : '[data-room]')) x.setAttribute('aria-pressed', String(x === b));
    S.at = -1; draw();
  });
  let w0 = 0;
  new ResizeObserver(() => { const w = root.clientWidth; if (Math.abs(w - w0) > 4) { w0 = w; draw(); } }).observe(root);
  draw();
}

const cls = g => (g === 'clean' ? 'ok' : FAILED.has(g) ? 'bad' : 'warn');
// Watching goes through the page's demo: its link starts the demo if it has not started yet (and the same link
// twice still plays).
function watch(r) {
  const hash = `#try/${r.room}/${r.id}/play`;
  if (location.hash === hash) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = hash;
}
