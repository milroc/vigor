import { memo, useEffect, useLayoutEffect, useRef, useMemo } from 'react';
import { BED_TGT, DEBT, DIST, FULLWAKE, HR, HRV, INBED_POST, INBED_PRE, NAP, RESP, RHR, STAGE, WAKE_TGT } from './palette.js';
import { CAP_MIN, PAD_L, PAD_R, clamp, clock, labelWidth, niceTicks, pctl, timeTicks, useMeasure } from './helpers.js';
import { useHoverStore, useHoverTarget } from './hoverStore.jsx';
import { MarksCanvas, cssColor, fillRect, fillCircle, strokeLine } from './canvasLayer.jsx';
import s from '../Sleep.module.css';

// ---- The hovered-column band. It used to be a <rect> inside each chart's SVG,
// which meant every pointer move dirtied all twelve SVGs and forced Blink to
// re-rasterize ~44k marks at the "All" range. It's now a plain div layered over
// the chart and moved by writing a transform straight to the node — the SVGs are
// never touched, so their rasters stay cached and hover costs nothing to paint. ----
function HoverBand({ lo, hi, cw, padL, top, height, alpha = 0.13, ready }) {
  const ref = useRef(null);
  const store = useHoverStore();
  // Layout effect, not passive: a window change re-renders the chart with new
  // column geometry, and a passive effect can run after the browser has already
  // painted — leaving the band at the previous width and offset for a frame.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.width = `${cw}px`;   // constant for a given window; only transform moves per frame
    const apply = () => {
      const i = store.getHover()?.i;
      if (!ready || i == null || i < lo || i > hi) { el.style.opacity = '0'; return; }
      el.style.opacity = String(alpha);
      el.style.transform = `translate3d(${padL + (i - lo) * cw}px, 0, 0)`;
    };
    apply();
    return store.subscribe(apply);
  }, [store, lo, hi, cw, padL, alpha, ready]);
  return <div ref={ref} className={s.hoverBand} style={{ top, height }} aria-hidden="true" />;
}

// ---- Navigator: the date selector. A miniature all-time skyline (each night's
// bed→wake band) with a draggable window: drag an edge to move start/end, drag
// inside to pan, drag empty space to draw a new window. ----
export const GRIP = 6;
export const Navigator = memo(function Navigator({ nights, win, onWin }) {
  const [ref, w] = useMeasure();
  const H = 44, PAD = { t: 4, r: 6, b: 4, l: 6 };
  const drag = useRef(null);
  // Coalesce drag updates to one per frame. A trackpad emits pointermoves faster
  // than the page can rebuild every chart for a new window, so without this the
  // handler queues renders it can never catch up on and the drag falls behind.
  const raf = useRef(0), pending = useRef(null);
  const emit = next => {
    pending.current = next;
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => { raf.current = 0; onWin(pending.current); });
  };
  useEffect(() => () => { if (raf.current) cancelAnimationFrame(raf.current); }, []);
  const N = nights.length;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const x = i => PAD.l + (i / (N - 1)) * plotW;
  const [yMin, yMax] = useMemo(() => {
    const beds = nights.filter(d => !d.blank).map(d => d.bed), wakes = nights.filter(d => !d.blank).map(d => d.wake);
    if (!beds.length) return [120, 1080];
    return [Math.max(120, pctl(beds, 0.02) - 25), Math.min(1080, pctl(wakes, 0.98) + 25)];
  }, [nights]);
  const y = m => PAD.t + (clamp(m, yMin, yMax) - yMin) / (yMax - yMin) * plotH;
  const idxAt = clientX => clamp(Math.round((clientX - ref.current.getBoundingClientRect().left - PAD.l) / plotW * (N - 1)), 0, N - 1);

  const bars = useMemo(() => {
    if (!w) return null;
    const bw = Math.max(plotW / N, 0.6);
    return nights.map((d, i) => (
      d.blank ? null : <rect key={i} x={x(i)} y={y(d.bed)} width={bw} height={Math.max(y(d.wake) - y(d.bed), 0.6)} fill={STAGE.core} opacity={0.5} />
    ));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nights, w, yMin, yMax]);

  const onDown = e => {
    const px = e.clientX - ref.current.getBoundingClientRect().left;
    const [lo, hi] = win, xLo = x(lo), xHi = x(hi);
    const mode = Math.abs(px - xLo) <= GRIP ? 'lo' : Math.abs(px - xHi) <= GRIP ? 'hi'
      : px > xLo && px < xHi ? 'pan' : 'new';
    drag.current = { mode, start: idxAt(e.clientX), win: [lo, hi] };
    if (mode === 'new') emit([idxAt(e.clientX), idxAt(e.clientX)]);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported env */ }
  };
  const onMove = e => {
    const d = drag.current; if (!d) return;
    const i = idxAt(e.clientX), [lo, hi] = d.win;
    if (d.mode === 'pan') { const width = hi - lo; const s0 = clamp(lo + (i - d.start), 0, N - 1 - width); emit([s0, s0 + width]); }
    else if (d.mode === 'lo') emit([Math.min(i, hi), hi]);
    else if (d.mode === 'hi') emit([lo, Math.max(i, lo)]);
    else emit([Math.min(d.start, i), Math.max(d.start, i)]);
  };
  const onUp = () => { drag.current = null; };

  const [lo, hi] = win, x0 = x(lo), x1 = x(hi);
  return (
    <div ref={ref} className={s.navWrap}>
      {w > 0 && (
        <svg className={`${s.svg} ${s.scrub}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
          {bars}
          <rect x={0} y={0} width={Math.max(x0, 0)} height={H} fill="#000" opacity={0.58} />
          <rect x={x1} y={0} width={Math.max(w - x1, 0)} height={H} fill="#000" opacity={0.58} />
          <rect x={x0} y={0} width={Math.max(x1 - x0, 1)} height={H} fill="none" stroke={NAP} strokeWidth={1.2} />
          <rect x={x0 - 2} y={0} width={4} height={H} fill={NAP} />
          <rect x={x1 - 2} y={0} width={4} height={H} fill={NAP} />
        </svg>
      )}
    </div>
  );
});

// ---- Stage Composition: per-night stacked stage minutes over the selected
// window. Fixed 10h ceiling; longer nights overflow the top. ----
export const Composition = memo(function Composition({ nights, win, onHover, onOpen, targets, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const H = 200, PAD = { t: 14, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const n = view.length, cw = plotW / n;
  const y = v => PAD.t + plotH - (v / CAP_MIN) * plotH;

  const drawBars = useMemo(() => g => {
    const bw = Math.max(cw - 0.4, 0.7);
    const order = [['deep', STAGE.deep], ['core', STAGE.core], ['rem', STAGE.rem], ['awake', STAGE.awake], ['tibBefore', INBED_PRE], ['tibAfter', INBED_POST]];
    view.forEach((d, k) => {
      let acc = 0;
      for (const [key, col] of order) {
        const v = d[key] || 0; if (v <= 0) continue;
        fillRect(g, PAD.l + k * cw, y(acc + v), bw, y(acc) - y(acc + v), col, 0.88);
        acc += v;
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, w, cw, PAD.l]);

  const idxAt = e => clamp(lo + Math.floor(((e.clientX - ref.current.getBoundingClientRect().left) / ref.current.getBoundingClientRect().width * w - PAD.l) / cw), lo, hi);
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawBars} filter="var(--comp-mute)" />}
      {w > 0 && (
        <svg className={`${s.svg} ${s.clickable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={e => onOpen(idxAt(e))}>
          {/* Goal levels replace the axis label at their level (total-sleep in lime, deep
              min/max in the deep color); any regular hour label within 9px is hidden. */}
          {(() => {
            const avoid = [targets?.asleepMin, targets?.deepMin, targets?.deepMax]
              .filter(v => v > 0 && v < CAP_MIN).map(v => y(v));
            return [2, 4, 6, 8, 10].map(h => {
              const gy = y(h * 60);
              const hide = avoid.some(ay => Math.abs(gy - ay) < 9);
              return (
                <g key={h}>
                  <line x1={PAD.l} x2={w - PAD.r} y1={gy} y2={gy} stroke="var(--line)" strokeDasharray={h === 10 ? '3 3' : undefined} />
                  {!hide && <text x={PAD.l - 6} y={gy + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{h}h</text>}
                </g>
              );
            });
          })()}
        </svg>
      )}
      {/* Goal markers were painted after the bars, so they ride above the canvas. */}
      {w > 0 && (
        <svg className={`${s.svg} ${s.goalLayer}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none" aria-hidden="true">
            {/* Deep-sleep goal on the bottom (deep) stacked segment: healthy 13–23% ≈ 60–110 min.
                The in-chart lines were invisible over the deep bars, so min & max are shown as axis
                ticks (value + tick, deep color) with a faint zone fill between them. */}
            {targets?.deepMin > 0 && targets?.deepMax > targets.deepMin && (() => {
              const yTop = y(Math.min(targets.deepMax, CAP_MIN)), yBot = y(Math.min(targets.deepMin, CAP_MIN));
              const fmt = v => `${Math.round(v / 60 * 10) / 10}h`;
              return (
                <g pointerEvents="none">
                  <rect x={PAD.l} y={yTop} width={w - PAD.l - PAD_R} height={yBot - yTop} fill="var(--st-deep)" opacity={0.15} />
                  {[[targets.deepMin, yBot], [targets.deepMax, yTop]].map(([v, ty], i) => (
                    <g key={i}>
                      <line x1={PAD.l} x2={PAD.l + 5} y1={ty} y2={ty} stroke="var(--st-deep)" strokeWidth="1.5" />
                      <text x={PAD.l - 6} y={ty + 3} fill="var(--st-deep)" fontSize="10" textAnchor="end">{fmt(v)}</text>
                    </g>
                  ))}
                </g>
              );
            })()}
            {/* Lime goal line: axis-label value + tick + faint full-width guideline at target minutes. */}
            {targets?.asleepMin > 0 && targets.asleepMin < CAP_MIN && (() => {
              const ty = y(targets.asleepMin);
              return (
                <g pointerEvents="none">
                  <line x1={PAD.l} x2={w - PAD.r} y1={ty} y2={ty} stroke="var(--lime)" strokeWidth="1" strokeDasharray="4 4" opacity={0.35} />
                  <line x1={PAD.l} x2={PAD.l + 5} y1={ty} y2={ty} stroke="var(--lime)" strokeWidth="1.5" />
                  <text x={PAD.l - 6} y={ty + 3} fill="var(--lime)" fontSize="10" textAnchor="end">{`${Math.round(targets.asleepMin / 60 * 10) / 10}h`}</text>
                </g>
              );
            })()}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={PAD.t} height={plotH} alpha={0.13} ready={w > 0} />
    </div>
  );
});

// ---- Skyline's date axis. Split out of the main SVG into its own small overlay
// so the hovered-date label and the fading month ticks can update without
// invalidating the 23k-mark skyline behind them. ----
const SkylineAxis = memo(function SkylineAxis({ nights, lo, hi, cw, padL, w, plotW }) {
  const AX = 18;
  const { i } = useHoverTarget();
  const ticks = useMemo(
    () => timeTicks(nights, lo, hi, plotW).map(t => ({ ...t, x: padL + (t.i - lo) * cw, lw: labelWidth(t.lbl, 10) })),
    [nights, lo, hi, cw, padL, plotW]);

  // Edge-aware date label: centered under the hovered column when there is room,
  // otherwise pinned to whichever edge it would have clipped past, so the whole
  // label (including "· no data") stays on screen.
  const label = useMemo(() => {
    const n = i != null && i >= lo && i <= hi ? nights[i] : null;
    if (!n) return null;
    const text = new Date(n.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
      + (n.blank ? ' · no data' : '');
    const hw = labelWidth(text, 10) / 2;
    const cxAnchor = padL + (i - lo) * cw + cw / 2;
    const leftEdge = padL, rightEdge = w - PAD_R;
    if (cxAnchor - hw < leftEdge) return { text, hw, x: leftEdge, anchor: 'start', center: leftEdge + hw };
    if (cxAnchor + hw > rightEdge) return { text, hw, x: rightEdge, anchor: 'end', center: rightEdge - hw };
    return { text, hw, x: cxAnchor, anchor: 'middle', center: cxAnchor };
  }, [i, nights, lo, hi, cw, padL, w]);

  if (!w) return null;
  // Ticks the focused-date label would collide with fade out (and back in) as you
  // hover. This is an ordinary render: the paint win came from the axis being its
  // own <svg> root beside the 23k-mark skyline, not from writing attributes by
  // hand, so React patching ~13 elements costs the same invalidation and keeps
  // the DOM honest.
  const hideR = label ? label.hw + 16 : 0, showR = label ? label.hw + 44 : 1;
  return (
    <svg className={`${s.svg} ${s.skyAxis}`} width="100%" height={AX} viewBox={`0 0 ${w} ${AX}`} preserveAspectRatio="none">
      {ticks.map(t => (
        <text key={t.i} x={t.x} y={AX - 5} fill="var(--dim)" fontSize="10"
          opacity={label ? clamp((Math.abs(t.x + t.lw / 2 - label.center) - hideR) / (showR - hideR), 0, 1) : 1}
          style={{ transition: 'opacity 0.18s ease' }}>{t.lbl}</text>
      ))}
      {label && (
        <text x={label.x} y={AX - 5} fill="var(--lime)" fontSize="10" fontWeight="600" textAnchor={label.anchor}>{label.text}</text>
      )}
    </svg>
  );
});

// ---- Skyline: one column per night, y = clock time, colored by stage ----
export const Skyline = memo(function Skyline({ nights, win, onHover, onOpen, targets, padL = PAD_L, fill, section }) {
  const [ref, w, hMeas] = useMeasure();
  // In fill mode draw at the real measured pixel height so the viewBox is 1:1 with
  // the rendered box — otherwise preserveAspectRatio="none" squishes the bars.
  const H = fill ? Math.max(Math.round(hMeas) || 220, 80) : 300;
  const PAD = { t: 8, r: PAD_R, b: 18, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const n = view.length, cw = plotW / n;
  const [yMin, yMax] = useMemo(() => {
    const vis = view.filter(d => !d.blank);
    // Include the in-bed window (bed - tibBefore .. wake + tibAfter) in the extent
    // so faint pre/post bands aren't clipped. Percentiles keep outliers from blowing up scale.
    const tops = vis.map(d => d.bed - (d.tibBefore || 0)), bots = vis.map(d => d.wake + (d.tibAfter || 0));
    if (!tops.length) return [120, 1080];
    return [Math.max(120, pctl(tops, 0.02) - 25), Math.min(1080, pctl(bots, 0.98) + 25)];
  }, [view]);
  const y = m => PAD.t + (clamp(m, yMin, yMax) - yMin) / (yMax - yMin) * plotH;

  const drawRects = useMemo(() => g => {
    const bw = Math.max(cw - 0.4, 0.7);
    view.forEach((d, k) => {
      if (d.blank) return;
      const cx = PAD.l + k * cw;
      const tb = d.tibBefore || 0, ta = d.tibAfter || 0;
      fillRect(g, cx, y(d.bed), bw, y(d.wake) - y(d.bed), 'var(--text)', 0.05);
      if (tb > 0) fillRect(g, cx, y(d.bed - tb), bw, Math.max(y(d.bed) - y(d.bed - tb), 0.5), INBED_PRE, 0.4);
      if (ta > 0) fillRect(g, cx, y(d.wake), bw, Math.max(y(d.wake + ta) - y(d.wake), 0.5), INBED_POST, 0.4);
      for (const seg of d.segs) {
        fillRect(g, cx, y(seg.a), bw, Math.max(y(seg.b) - y(seg.a), 0.5), STAGE[seg.st], seg.st === 'awake' ? 0.9 : 0.8);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, w, yMin, yMax, cw, PAD.l]);

  const idxAt = e => clamp(lo + Math.floor(((e.clientX - ref.current.getBoundingClientRect().left) / ref.current.getBoundingClientRect().width * w - PAD.l) / cw), lo, hi);
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });

  return (
    <div ref={ref} className={`${s.chartWrap} ${fill ? s.skyFill : ''}`}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawRects} />}
      {w > 0 && (
        <svg className={`${s.svg} ${s.clickable}`} width="100%" height={fill ? '100%' : H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          style={fill ? { flex: 1, minHeight: 0 } : undefined}
          onPointerMove={onMove} onClick={e => onOpen(idxAt(e))}>
          {/* Target y-positions (bed=indigo, wake=gold). Their clock value is written on the
              axis in the target color, so any regular clock label within 9px is hidden. */}
          {(() => {
            const tgts = (targets ? [
              { m: targets.bedMin, col: 'var(--tgt-bed)' },
              { m: targets.wakeMin, col: 'var(--tgt-wake)' },
            ] : []).filter(t => t.m != null).map(t => ({ ...t, ty: y(t.m) }));
            const clockLines = Array.from({ length: Math.ceil((yMax - yMin) / 120) + 1 }, (_, k) => Math.ceil(yMin / 120) * 120 + k * 120)
              .filter(m => m > yMin && m < yMax);
            return (
              <>
                {clockLines.map(m => {
                  const gy = y(m), hide = tgts.some(t => Math.abs(gy - t.ty) < 9);
                  return (
                    <g key={m}><line x1={PAD.l} x2={w - PAD.r} y1={gy} y2={gy} stroke="var(--line)" />
                      {!hide && <text x={PAD.l - 6} y={gy + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{clock(m)}</text>}</g>
                  );
                })}
                {/* Colored tick + on-axis value + faint guideline. Out-of-range targets are clamped
                    to the nearest edge by y(); the guideline is dropped there to avoid a false level. */}
                {tgts.map((t, k) => {
                  const edge = t.m <= yMin || t.m >= yMax;
                  return (
                    <g key={k} pointerEvents="none">
                      {!edge && <line x1={PAD.l} x2={w - PAD.r} y1={t.ty} y2={t.ty} stroke={t.col} strokeWidth="1" strokeDasharray="4 4" opacity={0.25} />}
                      <line x1={PAD.l} x2={PAD.l + 5} y1={t.ty} y2={t.ty} stroke={t.col} strokeWidth="1.5" />
                      <text x={PAD.l - 6} y={t.ty + 3} fill={t.col} fontSize="10" textAnchor="end">{clock(t.m)}</text>
                    </g>
                  );
                })}
              </>
            );
          })()}
        </svg>
      )}
      {/* Cubism-style axis: month ticks stay put, but any tick the focused-date
          label would overlap fades out (and back in) gracefully as you hover. */}
      <SkylineAxis nights={nights} lo={lo} hi={hi} cw={cw} padL={PAD.l} w={w} plotW={plotW} />
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={PAD.t} height={plotH} alpha={0.13} ready={w > 0} />
    </div>
  );
});

// ---- Naps: shares the skyline's date axis (one column per night, gaps on days
// without naps). Top = the 3 nights before each nap vs the median (recovery
// context); bottom = nap length. Nap-days that followed short nights are lime.
// Back-to-back bars sharing one central date axis: nap length grows up (given
// 3/4 of the height), the 3 nights before each nap hang down below the axis
// (inverted, 1/4 of the height). A short-sleep run reads as debt under the nap.
export const NapsPanel = memo(function NapsPanel({ nights, napDays, win, onHover, onOpen, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const PAD = { l: padL, r: PAD_R };
  const NAP_H = 80, AXIS = 0, DEBT_H = 80, TOP = 6;         // nap : debt = 50 : 50
  const napBase = TOP + NAP_H, debtTop = napBase + AXIS, debtBase = debtTop + DEBT_H;
  const H = debtBase + 4;
  const [lo, hi] = win;
  const days = useMemo(() => napDays.filter(d => d.idx >= lo && d.idx <= hi), [napDays, lo, hi]);
  const plotW = Math.max(w - PAD.l - PAD.r, 1), n = hi - lo + 1, cw = plotW / n;
  const X = i => PAD.l + (i - lo) * cw + cw / 2;
  const bwN = Math.max(cw, 3);
  const MAX_DEBT = 180, MAX_NAP = 150;                      // fixed so outliers don't crush the rest
  const yN = v => napBase - Math.min(v / MAX_NAP, 1) * NAP_H;      // nap length: up from the axis
  const yD = v => debtTop + Math.min(v / MAX_DEBT, 1) * DEBT_H;    // debt: down from the axis (inverted)

  const idxAt = e => { const rect = ref.current.getBoundingClientRect(); const px = (e.clientX - rect.left) / rect.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });

  // Sleep debt for EVERY night: 3-night rolling AVERAGE of the nightly deficit
  // under 7h, using effective sleep (brief wake-ups folded in). Memoized so
  // hover doesn't re-render the whole series.
  const drawMarks = useMemo(() => g => {
    // nap length — up (nap-days only)
    for (const d of days) {
      fillRect(g, X(d.idx) - bwN / 2, yN(d.napLen), bwN, napBase - yN(d.napLen), NAP, d.recovery ? 0.9 : 0.5);
    }
    // sleep debt — down (inverted), every night
    const bwD = Math.max(cw - 0.4, 0.7);
    for (let i = lo; i <= hi; i++) {
      let sum = 0, cnt = 0;
      for (const j of [i - 2, i - 1, i]) { const a = nights[j]?.asleepEff; if (a != null) { sum += Math.max(0, 420 - a); cnt++; } }
      const debt = cnt ? sum / cnt : 0;
      if (debt <= 0.5) continue;
      fillRect(g, PAD.l + (i - lo) * cw, debtTop, bwD, yD(debt) - debtTop, DEBT, 0.7);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nights, days, lo, hi, w, cw]);

  return (
    <div ref={ref} className={`${s.chartWrap} ${s.napGrid}`}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>

          {/* nap length — up (nap-days only) */}
          {[1, 2].map(h => (
            <g key={h}><line x1={PAD.l} x2={w - PAD.r} y1={yN(h * 60)} y2={yN(h * 60)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={yN(h * 60) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{h}h</text></g>
          ))}
          {/* shared central zero line (date labels dropped — see the pinned skyline) */}
          <line x1={PAD.l} x2={w - PAD.r} y1={napBase} y2={napBase} stroke="var(--dim)" opacity={0.6} />

          {/* sleep debt — down (inverted), every night */}
          {[1, 2].map(h => (
            <g key={h}><line x1={PAD.l} x2={w - PAD.r} y1={yD(h * 60)} y2={yD(h * 60)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={yD(h * 60) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{h}h</text></g>
          ))}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={TOP} height={debtBase - TOP} alpha={0.13} ready={w > 0} />
    </div>
  );
});

// ---- Box-plot per night (min / Q1 / median / Q3 / max) across the window, for
// vitals that are a timeseries within each night. byDay maps day -> box. ----
export const BoxSeries = memo(function BoxSeries({ nights, win, byDay, color, unit, label, onHover, onOpen, H = 168, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const PAD = { t: 14, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b, n = view.length, cw = plotW / n;
  const boxes = useMemo(() => view.map((d, k) => ({ k, b: byDay[d.day] })).filter(x => x.b), [view, byDay]);
  // Scale to the spread of MEDIANS (+ a typical IQR of headroom) so a single
  // outlier whisker doesn't squash the everyday range; outliers clip at the edge.
  const [yMin, yMax] = useMemo(() => {
    const meds = boxes.map(x => x.b.med);
    if (!meds.length) return [0, 1];
    const mn = Math.min(...meds), mx = Math.max(...meds);
    const iqrs = boxes.map(x => x.b.q3 - x.b.q1).sort((a, b) => a - b);
    const typ = iqrs.length ? iqrs[Math.floor(iqrs.length / 2)] : 0;
    const pad = Math.max(typ * 1.4, (mx - mn) * 0.15, 1);
    return [mn - pad, mx + pad];
  }, [boxes]);
  const y = v => PAD.t + plotH - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin) * plotH;
  const bw = Math.max(Math.min(cw * 0.62, 9), 1.2);

  const drawMarks = useMemo(() => g => {
    for (const { k, b } of boxes) {
      const cx = PAD.l + k * cw + cw / 2;
      strokeLine(g, cx, y(b.hi), cx, y(b.lo), color, 0.3);
      fillRect(g, cx - bw / 2, y(b.q3), bw, Math.max(y(b.q1) - y(b.q3), 0.8), color, 0.32);
      strokeLine(g, cx - bw / 2, y(b.med), cx + bw / 2, y(b.med), color, 1, 1.3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, w, yMin, yMax, cw, bw, color]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {niceTicks(yMin, yMax, 3).filter(g => g > yMin && g < yMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          {boxes.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={PAD.t} height={plotH} alpha={0.12} ready={w > 0} />
    </div>
  );
});

// ---- "The Morning After" combo (styled like Respiration): next-day HRV box-plots
// on top, with the following-day resting HR area-encoded as a bubble lane beneath.
// Both are next-day recovery readouts, so they share one panel + the date axis. ----
export const NextDayCombo = memo(function NextDayCombo({ nights, win, hrvByDay, rhrByDay, hrvColor, rhrColor, onHover, onOpen, H = 176, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const BOT = 26, PAD = { r: PAD_R, l: padL };
  const rhrRow = H - BOT + 13;            // RHR bubble lane sits BELOW the HRV box-plots
  const [lo, hi] = win;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const plotW = Math.max(w - PAD.l - PAD.r, 1), n = view.length, cw = plotW / n;
  const mTop = 14, mBot = H - BOT - 6, plotH = mBot - mTop;
  const boxes = useMemo(() => view.map((d, k) => ({ k, b: hrvByDay[d.day] })).filter(x => x.b), [view, hrvByDay]);
  // HRV box-plot axis: scale to the spread of medians + typical IQR headroom.
  const [yMin, yMax] = useMemo(() => {
    const meds = boxes.map(x => x.b.med);
    if (!meds.length) return [0, 1];
    const mn = Math.min(...meds), mx = Math.max(...meds);
    const iqrs = boxes.map(x => x.b.q3 - x.b.q1).sort((a, b) => a - b);
    const typ = iqrs.length ? iqrs[Math.floor(iqrs.length / 2)] : 0;
    const pad = Math.max(typ * 1.4, (mx - mn) * 0.15, 1);
    return [mn - pad, mx + pad];
  }, [boxes]);
  const y = v => mTop + plotH - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin) * plotH;
  const X = k => PAD.l + k * cw + cw / 2;
  const bw = Math.max(Math.min(cw * 0.62, 9), 1.2);
  // RHR bubble scale: normalize to the window's min..max (narrow bpm band → legible area).
  const [rMin, rMax] = useMemo(() => {
    const vs = view.map(d => rhrByDay[d.day]).filter(v => v != null);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1];
  }, [view, rhrByDay]);

  const drawMarks = useMemo(() => g => {
    const maxR = Math.min(Math.max(cw * 0.5, 2.5), 6);
    const norm = v => rMax > rMin ? (v - rMin) / (rMax - rMin) : 1;
    view.forEach((d, k) => {
      const v = rhrByDay[d.day];
      if (v != null) fillCircle(g, X(k), rhrRow, Math.max(maxR * Math.sqrt(0.16 + 0.84 * norm(v)), 1), rhrColor, 0.75);
    });
    for (const { k, b } of boxes) {
      const cx = X(k);
      strokeLine(g, cx, y(b.hi), cx, y(b.lo), hrvColor, 0.3);
      fillRect(g, cx - bw / 2, y(b.q3), bw, Math.max(y(b.q1) - y(b.q3), 0.8), hrvColor, 0.32);
      strokeLine(g, cx - bw / 2, y(b.med), cx + bw / 2, y(b.med), hrvColor, 1, 1.3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, view, w, yMin, yMax, rMin, rMax, cw, bw]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {niceTicks(yMin, yMax, 3).filter(g => g > yMin && g < yMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          <text x={PAD.l - 6} y={rhrRow + 3} fill="var(--dim)" fontSize="8" textAnchor="end">RHR</text>
          {boxes.length === 0 && <text x={w / 2} y={mTop + plotH / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={4} height={H - 6} alpha={0.12} ready={w > 0} />
    </div>
  );
});

// ---- Respiration section: respiratory-rate box-plots + a top lane of
// area-encoded bubbles for breathing disturbances and brief wake-ups. SpO2 is
// its own box-plot chart (added in the section, not overlaid here). ----
export const RespirationChart = memo(function RespirationChart({ nights, win, respBy, onHover, onOpen, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const H = 196, BOT = 46, PAD = { r: PAD_R, l: padL };
  // Brief-wake + disturbance + full-wake bubble lanes sit BELOW the resp box-plots.
  // (H - BOT is held constant so the box-plot plot area is unchanged.)
  const wakeRow = H - BOT + 11, distRow = H - BOT + 24, fullRow = H - BOT + 37;
  const [lo, hi] = win;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const plotW = Math.max(w - PAD.l - PAD.r, 1), n = view.length, cw = plotW / n;
  const mTop = 6, mBot = H - BOT - 4, plotH = mBot - mTop;
  const boxes = useMemo(() => view.map((d, k) => ({ k, b: respBy[d.day] })).filter(x => x.b), [view, respBy]);
  const [rMin, rMax] = useMemo(() => {
    const meds = boxes.map(x => x.b.med);
    if (!meds.length) return [12, 20];
    const mn = Math.min(...meds), mx = Math.max(...meds);
    const iqrs = boxes.map(x => x.b.q3 - x.b.q1).sort((a, b) => a - b);
    const typ = iqrs.length ? iqrs[Math.floor(iqrs.length / 2)] : 0;
    const pad = Math.max(typ * 1.4, (mx - mn) * 0.15, 1);
    return [mn - pad, mx + pad];
  }, [boxes]);
  const yR = v => mTop + plotH - (clamp(v, rMin, rMax) - rMin) / (rMax - rMin) * plotH;
  const X = k => PAD.l + k * cw + cw / 2;
  const bw = Math.max(Math.min(cw * 0.6, 8), 1.2);

  const drawMarks = useMemo(() => g => {
    // bubbles: area (r ∝ √value) encodes brief-wake count and disturbance level.
    const maxR = Math.min(Math.max(cw * 0.5, 2.5), 6);
    let wakeMax = 1, distMax = 1, fullMax = 1;
    for (const d of view) {
      if (d.briefWakes > wakeMax) wakeMax = d.briefWakes;
      if (d.dist > distMax) distMax = d.dist;
      if (d.fullWakeMin > fullMax) fullMax = d.fullWakeMin;
    }
    view.forEach((d, k) => {
      const cx = X(k);
      if (d.briefWakes > 0) fillCircle(g, cx, wakeRow, Math.max(maxR * Math.sqrt(d.briefWakes / wakeMax), 1), STAGE.awake, 0.7);
      if (d.dist > 0) fillCircle(g, cx, distRow, Math.max(maxR * Math.sqrt(d.dist / distMax), 1), DIST, 0.8);
      if (d.fullWakeMin > 0) fillCircle(g, cx, fullRow, Math.max(maxR * Math.sqrt(d.fullWakeMin / fullMax), 1), FULLWAKE, 0.8);
    });
    for (const { k, b } of boxes) {
      const cx = X(k);
      strokeLine(g, cx, yR(b.hi), cx, yR(b.lo), RESP, 0.28);
      fillRect(g, cx - bw / 2, yR(b.q3), bw, Math.max(yR(b.q1) - yR(b.q3), 0.8), RESP, 0.3);
      strokeLine(g, cx - bw / 2, yR(b.med), cx + bw / 2, yR(b.med), RESP, 1, 1.3);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, boxes, w, rMin, rMax, cw, bw]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          <text x={PAD.l - 6} y={wakeRow + 3} fill="var(--dim)" fontSize="8" textAnchor="end">wakes</text>
          <text x={PAD.l - 6} y={distRow + 3} fill="var(--dim)" fontSize="8" textAnchor="end">dist</text>
          <text x={PAD.l - 6} y={fullRow + 3} fill="var(--dim)" fontSize="8" textAnchor="end">full</text>
          {niceTicks(rMin, rMax, 3).filter(g => g > rMin && g < rMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={yR(g)} y2={yR(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={yR(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={4} height={H - 6} alpha={0.12} ready={w > 0} />
    </div>
  );
});

// ---- Consistency: rolling 14-night standard deviation of bedtime and wake
// time (lower = more regular). ----
export const CONSIST_WIN = 14;
export const Consistency = memo(function Consistency({ nights, win, onHover, onOpen, targets, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const H = 168, PAD = { t: 14, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b, n = hi - lo + 1, cw = plotW / n;
  // Signed deviation from target bed/wake (minutes). Negative = earlier than target.
  const delta = useMemo(() => nights.map(d => d.blank ? null : ({ bed: d.bed - targets.bedMin, wake: d.wake - targets.wakeMin })), [nights, targets]);
  const rolling = useMemo(() => nights.map((_, i) => {
    const from = Math.max(0, i - CONSIST_WIN + 1);
    let bs = 0, ws = 0, c = 0;
    for (let j = from; j <= i; j++) { if (!delta[j]) continue; bs += delta[j].bed; ws += delta[j].wake; c++; }
    return c ? { bed: bs / c, wake: ws / c } : { bed: null, wake: null };
  }), [delta]);
  // Scale to the ~90th percentile of daily deviations (not the single worst
  // outlier), rounded to a tidy step; the rare far-off night clips at the edge.
  const yMax = useMemo(() => {
    const vals = [];
    for (let i = lo; i <= hi; i++) { if (!delta[i]) continue; vals.push(Math.abs(delta[i].bed), Math.abs(delta[i].wake)); }
    vals.sort((a, b) => a - b);
    const p90 = vals.length ? vals[Math.floor(0.9 * (vals.length - 1))] : 60;
    return clamp(Math.ceil(p90 * 1.2 / 15) * 15, 45, 180);
  }, [delta, lo, hi]);
  const step = yMax <= 60 ? 15 : yMax <= 120 ? 30 : 60;
  const glines = []; for (let g = step; g < yMax; g += step) glines.push(g, -g);
  const mid = PAD.t + plotH / 2;
  const y = v => mid - clamp(v, -yMax, yMax) / yMax * (plotH / 2); // 0 = on target, up = later
  const X = i => PAD.l + (i - lo) * cw + cw / 2;
  const drawMarks = useMemo(() => g => {
    const r = Math.min(Math.max(cw * 0.28, 0.8), 2.2);
    for (let i = lo; i <= hi; i++) {
      if (!delta[i]) continue;
      fillCircle(g, X(i), y(delta[i].bed), r, BED_TGT, 0.5);
      fillCircle(g, X(i), y(delta[i].wake), r, WAKE_TGT, 0.5);
    }
    // The 14-night rolling averages, drawn as polylines with gaps where a run
    // of blank nights leaves no average to plot.
    for (const [key, col] of [['bed', BED_TGT], ['wake', WAKE_TGT]]) {
      g.globalAlpha = 1; g.strokeStyle = cssColor(col); g.lineWidth = 1.8;
      g.beginPath();
      let pen = false;
      for (let i = lo; i <= hi; i++) {
        const v = rolling[i][key];
        if (v == null) { pen = false; continue; }
        if (pen) g.lineTo(X(i), y(v)); else g.moveTo(X(i), y(v));
        pen = true;
      }
      g.stroke();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delta, rolling, lo, hi, w, cw, yMax]);
  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const gl = g => `${g > 0 ? '+' : ''}${g}`;

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {glines.map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{gl(g)}</text></g>
          ))}
          <line x1={PAD.l} x2={w - PAD.r} y1={mid} y2={mid} stroke="var(--dim)" opacity={0.6} />
          <text x={PAD.l - 6} y={mid + 3} fill="var(--dim)" fontSize="10" textAnchor="end">0</text>
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={PAD.t} height={plotH} alpha={0.12} ready={w > 0} />
    </div>
  );
});

// ---- Recovery correlation: next-day HRV (line) over daily training load
// (faint bars), sharing the date axis with the nap/debt chart above. ----
// Generic per-night line/bars chart sharing the date axis with every other
// chart (identical PAD_L/PAD_R). valueAt(i) returns the value for night index i.
export const MiniChart = memo(function MiniChart({ nights, win, valueAt, color, unit, label, type = 'line', onHover, onOpen, H = 116, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const PAD = { t: 14, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b, n = hi - lo + 1, cw = plotW / n;
  const pts = useMemo(() => {
    const out = [];
    for (let i = lo; i <= hi; i++) { const v = valueAt(i); if (v != null) out.push({ i, v }); }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nights, lo, hi]);
  const [yMin, yMax] = useMemo(() => {
    const vs = pts.map(p => p.v);
    if (!vs.length) return [0, 1];
    if (type === 'bars') return [0, Math.max(1, ...vs) * 1.05];
    const mn = Math.min(...vs), mx = Math.max(...vs), pad = (mx - mn) * 0.12 || 1;
    return [mn - pad, mx + pad];
  }, [pts, type]);
  // Bubble lane: area ∝ value, normalized to the window's min..max so differences
  // read clearly even when absolute values sit in a narrow band (e.g. resting HR).
  const [bvMin, bvMax] = useMemo(() => {
    const vs = pts.map(p => p.v);
    return vs.length ? [Math.min(...vs), Math.max(...vs)] : [0, 1];
  }, [pts]);
  const y = v => PAD.t + plotH - (clamp(v, yMin, yMax) - yMin) / (yMax - yMin) * plotH;
  const X = i => PAD.l + (i - lo) * cw + cw / 2;

  const drawMarks = useMemo(() => g => {
    if (!pts.length) return;
    if (type === 'bars') {
      const bw = Math.max(cw - 0.6, 0.8);
      for (const p of pts) fillRect(g, PAD.l + (p.i - lo) * cw, y(p.v), bw, PAD.t + plotH - y(p.v), color, 0.55);
      return;
    }
    if (type === 'bubble') {
      const cy = PAD.t + plotH / 2;
      const maxR = Math.min(Math.max(cw * 0.5, 2.5), 7);
      const norm = v => bvMax > bvMin ? (v - bvMin) / (bvMax - bvMin) : 1;
      // area ∝ value: r = maxR·√(floor + (1-floor)·norm); a floor keeps the smallest bubble visible.
      for (const p of pts) fillCircle(g, X(p.i), cy, Math.max(maxR * Math.sqrt(0.16 + 0.84 * norm(p.v)), 1), color, 0.72);
      return;
    }
    g.globalAlpha = 1; g.strokeStyle = cssColor(color); g.lineWidth = 1.6;
    g.beginPath();
    pts.forEach((p, k) => { if (k) g.lineTo(X(p.i), y(p.v)); else g.moveTo(X(p.i), y(p.v)); });
    g.stroke();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, w, yMin, yMax, cw, type, color, bvMin, bvMax]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };

  return (
    <div ref={ref} className={s.chartWrap}>
      {w > 0 && <MarksCanvas w={w} h={H} draw={drawMarks} />}
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {type !== 'bubble' && niceTicks(yMin, yMax, 3).filter(g => g > yMin && g < yMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          {type === 'bubble' && pts.length > 0 && (
            <text x={PAD.l - 6} y={PAD.t + plotH / 2 + 3} fill="var(--dim)" fontSize="9" textAnchor="end">{bvMin}–{bvMax}</text>
          )}
          {pts.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
      <HoverBand lo={lo} hi={hi} cw={cw} padL={PAD.l} top={PAD.t} height={plotH} alpha={0.12} ready={w > 0} />
    </div>
  );
});

export function Stat({ value, unit, label }) {
  return <div><div className={s.statValue}>{value}{unit && <small> {unit}</small>}</div><div className={s.statLabel}>{label}</div></div>;
}

