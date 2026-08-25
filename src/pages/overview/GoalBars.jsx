import { useId, useMemo } from 'react';
import { PAD_L, PAD_R, clamp, niceTicks, pctl, useMeasure } from '../sleep/helpers.js';
import s from '../Sleep.module.css';

// ---- Goal bars: value-vs-target in the sleep tab's visual language, on the
// shared day axis. Each period is a contiguous day-index span ({lo, hi, value,
// partial}) — one day for per-day goals, a Mon–Sun week for per-week goals, so
// week bars span their seven day-columns and the coordinated hover still lands
// on the right period. Bars at/above target render solid, misses faded; a
// partial period (the in-progress week, or one clipped by the data edge) draws
// hollow since it can't be judged yet. The lime dashes mark the target, same
// treatment as the sleep-duration goal line in Stage Composition.
//
// shape='violin' (weekly goals with a dayValueAt accessor): a violin plot per
// week — two mirrored area charts joined over a vertical DAY-OF-WEEK axis,
// not a value density. The violin stands centered in the week's x-span; its
// axis runs from the week's first day at 0 to the WEEKLY SUM at the tip (read
// directly against the target line), with each day owning an equal slot along
// it. The mirrored width at each slot is that day's minutes, on ONE fixed
// scale across the whole dataset (the biggest day anywhere = full week
// width). Hard days bulge, rest days pinch to the axis at their own slot —
// zeros stay encoded — and an even week reads as a slim uniform column. ----
// Build the mirrored violin outline for one week: two area charts joined over
// a vertical day-of-week axis. The axis runs from 0 at the week's first day to
// the WEEKLY SUM at its last, with each day owning an equal slot along it —
// positional, not cumulative — and the mirrored width at each slot is that
// day's minutes (vmax = full width). Zero days keep their slot and pinch the
// outline to the axis, so rest days are encoded (and hoverable) instead of
// vanishing. values in day order, cx the horizontal center, span the max
// width, yOf the value → y scale. Returns the smoothed SVG paths (open
// outline + closed fill) and the top-tip y, or null for an all-zero week.
// Shared by the chart and the "how to read" legend so the legend figure is
// drawn by the exact same geometry.
export function violinGeometry(values, cx, span, vmax, yOf) {
  const n = values.length;
  const total = values.reduce((a, v) => a + (v > 0 ? v : 0), 0);
  if (!(total > 0)) return null;
  const ctrl = [[0, yOf(0)]];
  values.forEach((v, j) => {
    const hw = (span / 2) * Math.min(Math.max(v, 0) / vmax, 1);
    ctrl.push([hw, yOf(total * (j + 0.5) / n)]);
  });
  ctrl.push([0, yOf(total)]);
  if (ctrl.length < 3) return null;
  const leftEdge = ctrl.map(([hw, yy]) => [cx - hw, yy]);
  const rightEdge = [...ctrl].reverse().map(([hw, yy]) => [cx + hw, yy]);
  rightEdge.shift(); // top tip is shared between the two edges
  const pts = [...leftEdge, ...rightEdge];
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`;
  for (let k = 1; k < pts.length - 1; k++) {
    const mx = (pts[k][0] + pts[k + 1][0]) / 2, my = (pts[k][1] + pts[k + 1][1]) / 2;
    d += ` Q${pts[k][0].toFixed(1)} ${pts[k][1].toFixed(1)} ${mx.toFixed(1)} ${my.toFixed(1)}`;
  }
  const lastPt = pts[pts.length - 1];
  d += ` L${lastPt[0].toFixed(1)} ${lastPt[1].toFixed(1)}`;
  return { d, fillPath: `${d} Z`, top: yOf(total) };
}

// variant='heat' (violin-shaped goals only): same axis and slots as the
// violin, but each week is a slim uniform-width bar whose day-slots are
// tinted by intensity (opacity ramp on the goal color) instead of bulging —
// trades precise visual discrimination for horizontal quiet.
export function GoalBars({ nights, win, periods, target, color, fmt = v => String(Math.round(v)), shape, variant = 'violin', dayValueAt, hover, onHover, onOpen, H = 132, padL = PAD_L, section }) {
  const [refEl, w] = useMeasure();
  const PAD = { t: 12, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const n = hi - lo + 1, cw = plotW / n;
  const view = useMemo(() => periods.filter(p => p.hi >= lo && p.lo <= hi && p.value != null), [periods, lo, hi]);

  const violin = (shape === 'violin' || shape === 'ramp') && !!dayValueAt;
  const heat = violin && variant === 'heat';
  const heatW = span => Math.max(Math.min(span * 0.5, 14), 3);

  // Scale to the target's neighborhood and the typical (98th-pct) value so one
  // outlier week can't crush the rest; taller marks clip at the top edge.
  const yMax = useMemo(() => {
    const vals = view.map(p => p.value);
    const v98 = vals.length ? pctl(vals, 0.98) : 0;
    return Math.max(target * 1.25, v98 * 1.08, 1);
  }, [view, target]);

  // Violin width scale: fixed across the WHOLE dataset, not the visible
  // window, so the same minutes render the same width in every week at every
  // zoom — the (98th-pct) biggest day anywhere spans the full week width.
  const vmax = useMemo(() => {
    if (!violin) return 1;
    const vs = [];
    for (let i = 0; i < nights.length; i++) { const v = dayValueAt(i); if (v > 0) vs.push(v); }
    return vs.length ? pctl(vs, 0.98) : 1;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [violin, nights, dayValueAt]);
  const y = v => PAD.t + plotH - Math.min(v / yMax, 1) * plotH;

  const bars = useMemo(() => {
    if (!w) return null;
    if (violin) {
      return view.map(p => {
        const a = Math.max(p.lo, lo), b = Math.min(p.hi, hi);
        const xa = PAD.l + (a - lo) * cw, xb = PAD.l + (b - lo + 1) * cw - 0.4;
        const span = xb - xa, cx2 = (xa + xb) / 2;
        const vals = [];
        for (let i = p.lo; i <= p.hi; i++) vals.push(dayValueAt(i) || 0);
        const met = p.value >= target, ty2 = y(p.value);
        if (heat && p.value > 0) {
          const n2 = vals.length, total = p.value;
          const bw = heatW(span), x0 = cx2 - bw / 2;
          return (
            <g key={p.lo}>
              {vals.map((v, j) => {
                const yTop = y(total * (j + 1) / n2), yBot = y(total * j / n2);
                const h2 = Math.max(yBot - yTop - 0.5, 0.4); // hairline gap between days
                return <rect key={j} x={x0} y={yTop + 0.25} width={bw} height={h2}
                  fill={color} fillOpacity={0.06 + 0.84 * Math.min(v / vmax, 1)} />;
              })}
              <rect x={x0 - 0.5} y={ty2} width={bw + 1} height={Math.max(PAD.t + plotH - ty2, 0)} fill="none"
                stroke={color} strokeOpacity={p.partial ? 0.6 : met ? 0.8 : 0.3} strokeWidth={0.8}
                strokeDasharray={p.partial ? '3 2' : undefined} />
              <line x1={x0 - 2.5} x2={x0 + bw + 2.5} y1={ty2} y2={ty2} stroke={color} strokeWidth={1.4} opacity={p.partial ? 0.6 : met ? 1 : 0.55} />
            </g>
          );
        }
        const geo = heat ? null : violinGeometry(vals, cx2, span, vmax, y);
        if (!geo) {
          // All-zero week: no shape, but keep a faded tick at the baseline so
          // the missed week doesn't vanish from the record.
          return p.value == null ? null : (
            <line key={p.lo} x1={cx2 - 4} x2={cx2 + 4} y1={ty2} y2={ty2} stroke={color} strokeWidth={1.4} opacity={p.partial ? 0.4 : 0.55} />
          );
        }
        return (
          <g key={p.lo}>
            {p.partial
              ? <path d={geo.fillPath} fill={color} fillOpacity={0.12} stroke={color} strokeOpacity={0.7} strokeWidth={1} strokeDasharray="3 2" />
              : <>
                  <path d={geo.fillPath} fill={color} fillOpacity={met ? 0.5 : 0.18} />
                  <path d={geo.d} fill="none" stroke={color} strokeOpacity={met ? 0.95 : 0.45} strokeWidth={1} />
                </>}
            {/* short tick at the top tip = the weekly sum, read against the target line */}
            <line x1={cx2 - 4} x2={cx2 + 4} y1={ty2} y2={ty2} stroke={color} strokeWidth={1.4} opacity={p.partial ? 0.6 : met ? 1 : 0.55} />
          </g>
        );
      }).filter(Boolean);
    }
    return view.map(p => {
      const xa = PAD.l + (Math.max(p.lo, lo) - lo) * cw;
      const xb = PAD.l + (Math.min(p.hi, hi) - lo + 1) * cw;
      const bw = Math.max(xb - xa - 0.4, 0.7);
      const top = y(p.value), h = Math.max(PAD.t + plotH - top, 0.6);
      if (p.partial) {
        return <rect key={p.lo} x={xa} y={top} width={bw} height={h} fill={color} fillOpacity={0.16} stroke={color} strokeOpacity={0.7} strokeWidth={1} strokeDasharray="3 2" />;
      }
      return <rect key={p.lo} x={xa} y={top} width={bw} height={h} fill={color} opacity={p.value >= target ? 0.85 : 0.3} />;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, w, yMax, vmax, lo, hi, color, target, violin, heat]);

  const idxAt = e => { const r = refEl.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  // In violin mode the cursor's x picks the WEEK and its y picks the DAY: the
  // violin's vertical extent (0 → weekly total) is divided into equal per-day
  // slots, so sliding up a violin walks Mon → Sun across every coordinated
  // chart — rest days included, since a zero day keeps its slot. Above the
  // tip it clamps to the week's last day.
  const idxAtViolin = e => {
    const i = idxAt(e);
    const p = periods.find(q => i >= q.lo && i <= q.hi);
    if (!p || !(p.value > 0)) return i;
    const r = refEl.current.getBoundingClientRect();
    const py = (e.clientY - r.top) / r.height * H;
    const v = Math.max(0, (PAD.t + plotH - py) / plotH * yMax);
    const n = p.hi - p.lo + 1;
    const frac = Math.min(v / p.value, 1 - 1e-9);
    return p.lo + Math.floor(frac * n);
  };
  // stopPropagation in violin mode: the page-level hover surface maps x → day
  // and would immediately override the y → day mapping on bubble.
  const onMove = e => {
    if (violin) e.stopPropagation();
    onHover({ i: violin ? idxAtViolin(e) : idxAt(e), cx: e.clientX, cy: e.clientY, section });
  };
  const hot = hover != null && hover >= lo && hover <= hi;
  // useId can contain ':' which breaks url(#...) references — strip it.
  const clipId = 'gvclip' + useId().replace(/[^a-zA-Z0-9]/g, '');
  // Hovered day's slice of its week-violin: that day's equal slot along the
  // violin's vertical extent, clipped to the outline so exactly its bulge (or
  // its pinch, for a rest day) lights up.
  const hovSlice = (() => {
    if (!violin || !hot) return null;
    const p = periods.find(q => hover >= q.lo && hover <= q.hi);
    if (!p || !(p.value > 0)) return null;
    const a = Math.max(p.lo, lo), b = Math.min(p.hi, hi);
    const xa = PAD.l + (a - lo) * cw, xb = PAD.l + (b - lo + 1) * cw - 0.4;
    const n = p.hi - p.lo + 1, k = hover - p.lo;
    const y0 = y(p.value * k / n), y1 = y(p.value * (k + 1) / n);
    if (heat) {
      const span = xb - xa, bw = heatW(span);
      return { geo: null, xa: (xa + xb) / 2 - bw / 2 - 2, w: bw + 4, y0, y1 };
    }
    const vals = [];
    for (let i = p.lo; i <= p.hi; i++) vals.push(dayValueAt(i) || 0);
    const geo = violinGeometry(vals, (xa + xb) / 2, xb - xa, vmax, y);
    if (!geo) return null;
    return { geo, xa, w: xb - xa, y0, y1 };
  })();
  // Highlight the whole hovered period (the full week for weekly goals).
  const hotSpan = useMemo(() => {
    if (!hot) return null;
    const p = periods.find(q => hover >= q.lo && hover <= q.hi);
    return p ? [Math.max(p.lo, lo), Math.min(p.hi, hi)] : [hover, hover];
  }, [hot, hover, periods, lo, hi]);
  const ty = y(target);

  return (
    <div ref={refEl}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={onOpen ? e => onOpen(violin ? idxAtViolin(e) : idxAt(e)) : undefined}>
          {niceTicks(0, yMax, 3).filter(g => g > 0 && g < yMax && Math.abs(y(g) - ty) >= 9).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{fmt(g)}</text></g>
          ))}
          {hotSpan && <rect x={PAD.l + (hotSpan[0] - lo) * cw} y={PAD.t} width={(hotSpan[1] - hotSpan[0] + 1) * cw} height={plotH} fill="#fff" opacity={0.1} pointerEvents="none" />}
          {bars}
          {hovSlice && (
            <g pointerEvents="none">
              {hovSlice.geo && <clipPath id={clipId}><path d={hovSlice.geo.fillPath} /></clipPath>}
              <rect x={hovSlice.xa} y={hovSlice.y1} width={hovSlice.w} height={Math.max(hovSlice.y0 - hovSlice.y1, 1)}
                fill="#fff" opacity={0.32} clipPath={hovSlice.geo ? `url(#${clipId})` : undefined} />
            </g>
          )}
          {/* Target: axis value + tick + faint full-width guideline, in lime like
              the sleep-duration goal in Stage Composition. */}
          <g pointerEvents="none">
            <line x1={PAD.l} x2={w - PAD.r} y1={ty} y2={ty} stroke="var(--lime)" strokeWidth="1" strokeDasharray="4 4" opacity={0.35} />
            <line x1={PAD.l} x2={PAD.l + 5} y1={ty} y2={ty} stroke="var(--lime)" strokeWidth="1.5" />
            <text x={PAD.l - 6} y={ty + 3} fill="var(--lime)" fontSize="10" textAnchor="end">{fmt(target)}</text>
          </g>
          {view.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
    </div>
  );
}
