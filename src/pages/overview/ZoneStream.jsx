import { useMemo } from 'react';
import { PAD_L, PAD_R, clamp, niceTicks, pctl, useMeasure } from '../sleep/helpers.js';
import { ZONE_COLORS } from '../../components/ZoneDays.jsx';
import s from '../Sleep.module.css';

// Quadratic-midpoint smoothing for one boundary, built ONCE as a segment
// chain so adjacent bands can traverse the exact same geometry in either
// direction. (Smoothing forward vs reversed point lists produces slightly
// different curves — drawing each band's edges independently that way opens
// hairline background seams between layers, obvious at wide zoom.)
const f = p => `${p[0].toFixed(2)} ${p[1].toFixed(2)}`;
const smoothChain = pts => {
  const cmds = [];
  for (let k = 1; k < pts.length - 1; k++) {
    cmds.push({ c: pts[k], a: [(pts[k][0] + pts[k + 1][0]) / 2, (pts[k][1] + pts[k + 1][1]) / 2] });
  }
  return { start: pts[0], cmds, end: pts[pts.length - 1] };
};
// Forward traversal: M start, quads through midpoints, line to end.
const chainFwd = s => {
  let d = `M${f(s.start)}`;
  for (const q of s.cmds) d += ` Q${f(q.c)} ${f(q.a)}`;
  return d + ` L${f(s.end)}`;
};
// Reverse traversal of the SAME curve (quads with endpoints swapped, same
// controls), appended to an open path.
const chainRev = s => {
  let d = ` L${f(s.end)}`;
  if (!s.cmds.length) return d + ` L${f(s.start)}`;
  d += ` L${f(s.cmds[s.cmds.length - 1].a)}`;
  for (let k = s.cmds.length - 1; k >= 1; k--) d += ` Q${f(s.cmds[k].c)} ${f(s.cmds[k - 1].a)}`;
  return d + ` Q${f(s.cmds[0].c)} ${f(s.start)}`;
};

// ---- Zone stream: a silhouette streamgraph of minutes per day in each HR
// zone (Z1 bottom → Z5 top, the shared ZONE_COLORS palette), centered on a
// midline and pinching to it on rest days. Same day axis / coordinated hover
// as every other chart. zonesAt(i) returns [z1..z5] minutes or null. ----
export function ZoneStream({ nights, win, zonesAt, hover, onHover, onOpen, H = 156, padL = PAD_L, section }) {
  const [refEl, w] = useMeasure();
  const PAD = { t: 8, r: PAD_R, b: 8, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const n = hi - lo + 1, cw = plotW / n;

  const data = useMemo(() => {
    const out = [];
    for (let i = lo; i <= hi; i++) {
      const z = zonesAt(i);
      out.push(z ? z.map(v => Number(v) || 0) : [0, 0, 0, 0, 0]);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi, zonesAt]);

  const scaleInfo = useMemo(() => {
    const totals = data.map(z => z.reduce((a, b) => a + b, 0));
    const pos = totals.filter(t => t > 0);
    return { totals, scale: plotH / Math.max(pos.length ? pctl(pos, 0.98) : 1, 1) }; // p98 total fills the height
  }, [data, plotH]);

  const bands = useMemo(() => {
    if (!w) return null;
    const { totals, scale } = scaleInfo;
    const yMid = PAD.t + plotH / 2;
    const Y = v => clamp(yMid - v * scale, PAD.t, PAD.t + plotH);
    const X = k => PAD.l + k * cw + cw / 2;
    // Boundary b_z(k) = -total/2 + Σ zones below z (silhouette baseline).
    const boundary = z => data.map((zs, k) => {
      let v = -totals[k] / 2;
      for (let m = 0; m < z; m++) v += zs[m];
      return [X(k), Y(v)];
    });
    const edges = [0, 1, 2, 3, 4, 5].map(z => smoothChain(boundary(z)));
    return ZONE_COLORS.map((c, z) => {
      const d = chainFwd(edges[z + 1]) + chainRev(edges[z]) + ' Z';
      return <path key={z} d={d} fill={c} fillOpacity={0.82} />;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, scaleInfo, w, plotH, cw]);

  const idxAt = e => { const r = refEl.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={refEl}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          <line x1={PAD.l} x2={w - PAD.r} y1={PAD.t + plotH / 2} y2={PAD.t + plotH / 2} stroke="var(--line)" />
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {bands}
          {data.every(z => z.every(v => !v)) && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no zone minutes in this window</text>}
        </svg>
      )}
    </div>
  );
}

// ---- Stacked daily bars (e.g. exercise minutes by activity kind): valuesAt(i)
// returns an array of segment values (or null); segments stack bottom-up in
// `colors` order. Optional lime `target` line reads against the day's TOTAL —
// days at/above render solid, misses faded, matching the goal idiom. ----
export function StackedBars({ nights, win, valuesAt, colors, target, targetLabel, yCap, hover, onHover, onOpen, H = 110, padL = PAD_L, section }) {
  const [refEl, w] = useMeasure();
  const PAD = { t: 12, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const n = hi - lo + 1, cw = plotW / n;

  const pts = useMemo(() => {
    const out = [];
    for (let i = lo; i <= hi; i++) {
      const v = valuesAt(i);
      if (v && v.some(x => x > 0)) out.push({ i, v, total: v.reduce((a, b) => a + (b || 0), 0) });
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lo, hi, valuesAt]);

  // Fixed `yCap` when given (stable scale across windows); otherwise scale to
  // the typical (98th-pct) day so one monster session can't crush the rest.
  // Taller stacks clip at the top edge either way.
  const yMax = useMemo(() => {
    if (yCap != null) return yCap;
    const vs = pts.map(p => p.total);
    const v98 = vs.length ? pctl(vs, 0.98) : 1;
    return Math.max(v98 * 1.1, target != null ? target * 1.25 : 0, 1);
  }, [pts, target, yCap]);
  const y = v => PAD.t + plotH - Math.min(v / yMax, 1) * plotH;

  const marks = useMemo(() => {
    if (!w) return null;
    const bw = Math.max(cw - 0.6, 0.8);
    return pts.map(p => {
      const op = target != null ? (p.total >= target ? 0.85 : 0.35) : 0.7;
      let acc = 0;
      return p.v.map((seg, k) => {
        if (!(seg > 0)) return null;
        const y1 = y(acc + seg), y0 = y(acc);
        acc += seg;
        return <rect key={`${p.i}-${k}`} x={PAD.l + (p.i - lo) * cw} y={y1} width={bw} height={Math.max(y0 - y1, 0.4)} fill={colors[k]} opacity={op} />;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, w, yMax, lo, cw, target, colors]);

  const idxAt = e => { const r = refEl.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={refEl}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {niceTicks(0, yMax, 3).filter(g => g > 0 && g < yMax && (target == null || Math.abs(y(g) - y(target)) >= 9)).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          {target != null && (
            <g pointerEvents="none">
              <line x1={PAD.l} x2={w - PAD.r} y1={y(target)} y2={y(target)} stroke="var(--lime)" strokeWidth="1" strokeDasharray="4 4" opacity={0.35} />
              <line x1={PAD.l} x2={PAD.l + 5} y1={y(target)} y2={y(target)} stroke="var(--lime)" strokeWidth="1.5" />
              <text x={PAD.l - 6} y={y(target) + 3} fill="var(--lime)" fontSize="10" textAnchor="end">{targetLabel || String(target)}</text>
            </g>
          )}
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {marks}
          {pts.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
    </div>
  );
}

// ---- Binary target heatmap: goals grouped under small sub-headers
// (training / NEAT / sleep), one row per goal, one cell per period (a day, or
// a Mon–Sun week spanning its columns). A filled cell in the GOAL'S OWN color
// (the same color that metric wears in the charts below) = target met; misses
// sit as faint blocks; the in-progress week draws hollow. groups:
// [{ name, rows: [{ label, color, cells: [{lo, hi, met, partial, empty}] }] }]. ----
export function GoalHeatRows({ nights, win, groups, hover, onHover, onOpen, padL = PAD_L, section }) {
  const [refEl, w] = useMeasure();
  const ROW = 11, GAP = 3, GH = 12, GGAP = 4, TOP = 2;
  const layout = useMemo(() => {
    const out = [];
    let yy = TOP;
    for (const gr of groups) {
      out.push({ type: 'head', label: gr.name, y: yy });
      yy += GH;
      for (const r of gr.rows) { out.push({ type: 'row', row: r, y: yy }); yy += ROW + GAP; }
      yy += GGAP;
    }
    return { items: out, H: yy };
  }, [groups]);
  const H = layout.H;
  const PAD = { r: PAD_R, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), n = hi - lo + 1, cw = plotW / n;

  const cells = useMemo(() => {
    if (!w) return null;
    return layout.items.map((it, k) => {
      if (it.type === 'head') {
        return <text key={k} x={PAD.l} y={it.y + 8} fill="var(--dim)" fontSize="7" letterSpacing="1.5" style={{ textTransform: 'uppercase' }}>{it.label.toUpperCase()}</text>;
      }
      const r = it.row, y0 = it.y;
      const marks = r.cells.filter(p => p.hi >= lo && p.lo <= hi && !p.empty).map(p => {
        const xa = PAD.l + (Math.max(p.lo, lo) - lo) * cw;
        const xb = PAD.l + (Math.min(p.hi, hi) - lo + 1) * cw;
        const bw = Math.max(xb - xa - 0.4, 0.6);
        const c = r.color || 'var(--lime)';
        if (p.partial) return <rect key={p.lo} x={xa} y={y0} width={bw} height={ROW} fill={c} fillOpacity={0.12} stroke={c} strokeOpacity={0.55} strokeWidth={0.8} strokeDasharray="3 2" />;
        return <rect key={p.lo} x={xa} y={y0} width={bw} height={ROW} fill={p.met ? c : 'var(--text)'} fillOpacity={p.met ? 0.8 : 0.07} />;
      });
      return (
        <g key={k}>
          <text x={PAD.l - 6} y={y0 + ROW / 2 + 3} fill="var(--dim)" fontSize="8" textAnchor="end">{r.label}</text>
          {marks}
        </g>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, w, lo, hi]);

  const idxAt = e => { const r = refEl.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={refEl}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={1} width={cw} height={H - 2} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {cells}
        </svg>
      )}
    </div>
  );
}
