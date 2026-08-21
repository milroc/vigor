import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthSleep, getHealthSleepSeries, getHealthSleepNight } from '../api.js';
import shared from '../styles/shared.module.css';
import s from './Sleep.module.css';
import {
  STAGE, INBED_PRE, INBED_POST, RESP, SPO2, DIST, FULLWAKE, HR, HRV, NAP, DEBT, LOAD, RHR, DAYLIGHT, BED_TGT, WAKE_TGT,
  applyTunerState,
} from './sleep/palette.js';
import TunerPanel from './sleep/TunerPanel.jsx';

const PAD_L = 38;   // fallback left gutter. The real value (padL) is measured from the
const PAD_R = 0;    // widest y-axis label present in the data and shared across the
                    // aligned date charts so they line up. Right side is full-bleed.

// Measure a label's rendered width so the left gutter can be sized to exactly the
// widest tick that will appear — no wasted space, no clipping. Uses an offscreen
// SVG <text> and getComputedTextLength so measurement goes through the real font
// engine (IBM Plex Mono), matching how the axis labels actually render — a canvas
// measureText silently falls back to a narrower generic font and under-measures.
let _measSvg, _measText;
function labelWidth(str, px = 10) {
  const t = String(str);
  if (typeof document === 'undefined') return t.length * px * 0.6;
  if (!_measSvg) {
    _measSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    _measSvg.setAttribute('style', 'position:absolute;left:-9999px;top:-9999px;width:0;height:0;overflow:hidden');
    _measText = document.createElementNS('http://www.w3.org/2000/svg', 'text');
    _measText.style.fontFamily = '"IBM Plex Mono", monospace';
    _measSvg.appendChild(_measText);
    document.body.appendChild(_measSvg);
  }
  _measText.style.fontSize = `${px}px`;
  _measText.textContent = t;
  return _measText.getComputedTextLength();
}
const srcLabel = src => !src ? '—' : /watch/i.test(src) ? 'Apple Watch' : /iphone/i.test(src) ? 'iPhone' : /withings/i.test(src) ? 'Withings' : src;
const CAP_MIN = 600; // stage-composition y-axis caps at 10h; longer nights overflow
const RANGES = [['90d', 90], ['1yr', 365], ['All', null]];
// Navigation units. Calendar-aligned (W/M/YR) snap to Mon–Sun / 1st–last / Jan1–Dec31
// and the ‹ › arrows move one calendar unit; rolling (7D/30D/1YR) are fixed-length
// windows the arrows shift by n days. Grouped so the segmented control can rule
// between the calendar-snap and rolling families.
const UNITS_CAL = [['W', { type: 'cal', unit: 'week' }], ['M', { type: 'cal', unit: 'month' }], ['YR', { type: 'cal', unit: 'year' }]];
const UNITS_ROLL = [['7D', { type: 'roll', n: 7 }], ['30D', { type: 'roll', n: 30 }], ['1YR', { type: 'roll', n: 365 }]];
const UNITS = [...UNITS_CAL, ...UNITS_ROLL];
// Clock positions are anchored minutes-after-6pm (0 = 6pm, 360 = midnight,
// 720 = 6am, 1080 = noon), matching scripts/sleepSessions.cjs (local wall time).
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wall = m => ((m % 1440) + 1440 + 1080) % 1440;
const clock = m => {
  const w = wall(m), h = Math.floor(w / 60), mm = w % 60;
  const ap = h < 12 ? 'a' : 'p', h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12}${ap}` : `${h12}:${String(mm).padStart(2, '0')}${ap}`;
};
const clockWall = w => { const h = Math.floor(w / 60), ap = h < 12 ? 'a' : 'p', h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}${ap}`; };
const hm = v => v == null ? '—' : `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`;
const pctl = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[clamp(Math.floor(p * a.length), 0, a.length - 1)]; };
const fmtMon = day => new Date(day + 'T00:00:00').toLocaleDateString('en', { month: 'short', year: '2-digit' });
const fmtShort = day => new Date(day + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
// Expand a data-only nights array (missing calendar days dropped) into a
// CONTINUOUS daily calendar from the first to last day, inserting placeholder
// { day, blank: true } entries for days with no data. Real nights pass through
// unchanged. Dates are built/formatted in LOCAL time to avoid TZ date shifts.
const fmtDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
function fillNightGaps(nights) {
  if (!nights || nights.length < 2) return nights || [];
  const byDay = new Map(nights.map(n => [n.day, n]));
  const out = [];
  const cur = new Date(nights[0].day + 'T00:00:00');
  const end = new Date(nights[nights.length - 1].day + 'T00:00:00');
  while (cur <= end) {
    const key = fmtDay(cur);
    out.push(byDay.get(key) || { day: key, blank: true });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
const std = arr => { if (arr.length < 2) return null; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };
// ~n round gridline values spanning [min,max].
function niceTicks(min, max, n = 3) {
  const span = max - min; if (span <= 0) return [Math.round(min)];
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= span / n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.round(v * 10) / 10);
  return out;
}

function useMeasure() {
  const ref = useRef(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width) setSize(prev => (Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1 ? prev : { w: width, h: height }));
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, size.w, size.h];
}

// Adaptive time-axis ticks (D3-style): pick a "nice" month step (1/2/3/4/6/12/…)
// so labels land ~92px apart and never collide, aligned to absolute month
// number for stable phase. Steps ≥ 12 months label the year only.
function timeTicks(nights, lo, hi, plotW) {
  const months = []; let last = '';
  for (let i = lo; i <= hi; i++) {
    const ym = nights[i].day.slice(0, 7);
    if (ym !== last) { months.push({ i, ym }); last = ym; }
  }
  if (months.length <= 1) return months.map(m => ({ i: m.i, lbl: fmtMon(nights[m.i].day) }));
  const maxTicks = Math.max(2, Math.floor(plotW / 92));
  const step = [1, 2, 3, 4, 6, 12, 24, 60].find(sv => months.length / sv <= maxTicks) || 60;
  const mnum = ym => { const [y, m] = ym.split('-'); return (+y) * 12 + (+m - 1); };
  return months.filter(mt => mnum(mt.ym) % step === 0)
    .map(mt => ({ i: mt.i, lbl: step >= 12 ? nights[mt.i].day.slice(0, 4) : fmtMon(nights[mt.i].day) }));
}

// Info affordance by a title: hover the "i" for a description tooltip. When
// forceOpen is set (first-load NUX) it stays open with a dismiss button.
function InfoTip({ children, wide, forceOpen, onDismiss }) {
  const [hov, setHov] = useState(false);
  const open = hov || forceOpen;
  return (
    <span className={s.info} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <span className={s.infoIcon}>i</span>
      {open && (
        <span className={`${s.infoPop} ${wide ? s.infoPopWide : ''}`}>
          {children}
          {onDismiss && <button className={s.nuxBtn} onClick={onDismiss}>Got it</button>}
        </span>
      )}
    </span>
  );
}

// ---- Date stepper: clickable ‹ › arrows around a text readout of the current
// date (or window range). Arrows/keys share the same onPrev/onNext handlers;
// canPrev/canNext grey out and disable a side at the data/window boundary. `sub`
// is optional trailing text (e.g. "· no data"). The modal variant passes `tip`
// and shows a hover tooltip explaining the ← → arrow keys. The header variant
// passes onHoverOpen/onHoverClose instead: hovering the WHOLE component opens the
// range picker (which folds the arrow-key hint inline), so it suppresses the
// tooltip. ----
function DateStepper({ label, sub, tip, onPrev, onNext, onLabel, labelRef, canPrev = true, canNext = true, onHoverOpen, onHoverClose }) {
  const [hov, setHov] = useState(false);
  return (
    <span className={s.stepper}
      onMouseEnter={() => { setHov(true); onHoverOpen?.(); }}
      onMouseLeave={() => { setHov(false); onHoverClose?.(); }}
      onPointerMove={e => e.stopPropagation()}>
      <button className={s.stepArrow} onClick={onPrev} disabled={!canPrev} aria-label="previous">‹</button>
      {onLabel
        ? <button ref={labelRef} className={s.stepDateBtn} onClick={onLabel}>{label}{sub}</button>
        : <span className={s.stepDate}>{label}{sub}</span>}
      <button className={s.stepArrow} onClick={onNext} disabled={!canNext} aria-label="next">›</button>
      {hov && tip && !onHoverOpen && <span className={s.infoPop}>{tip}</span>}
    </span>
  );
}

// ---- Month grid for the range calendar: one calendar month, days clamped to
// [min,max]. Click a start then an end; the in-progress range previews on hover
// and the committed range highlights. Same day twice → caller opens that night. ----
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
function MonthGrid({ year, month, min, max, sel, preview, onPick, onHover }) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const [selA, selB] = sel; // committed range (YYYY-MM-DD | null)
  const [prA, prB] = preview; // preview range while choosing the second day
  return (
    <div className={s.calMonth}>
      <div className={s.calCaption}>{MONTHS[month]} {year}</div>
      <div className={s.calDow}>{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className={s.calGrid}>
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className={s.calPad} />;
          const day = fmtDay(new Date(year, month, d));
          const dis = day < min || day > max;
          const inSel = selA && selB && day >= selA && day <= selB;
          const inPrev = prA && prB && day >= prA && day <= prB;
          const isEnd = day === selA || day === selB;
          const cls = [s.calDay, dis && s.calDayDis, (inSel || inPrev) && s.calDayIn, isEnd && s.calDayEnd].filter(Boolean).join(' ');
          return (
            <button key={i} className={cls} disabled={dis}
              onClick={() => onPick(day)} onMouseEnter={() => onHover(day)}>{d}</button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Range calendar popover: a self-contained date picker anchored to the ‹ date ›
// label. Two-month grid (prev/next arrows) where clicking a start then an end sets
// the window (same day twice → open that night). Folds in the preset list (rolling
// windows + calendar-unit snaps) and embeds the brush, so the picker is the one
// place to steer the date range. onApply keeps applyPick's start===end semantics. ----
function RangePicker({ min, max, init, onApply, activeRange, activeGran, onGran, onRange, brush, hint, onClose, anchorRef, onMouseEnter, onMouseLeave }) {
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [hoverDay, setHoverDay] = useState(null);
  const [view, setView] = useState(() => { const d = new Date(init[0] + 'T00:00:00'); return { y: d.getFullYear(), m: d.getMonth() }; });
  // Position:fixed popover anchored to the trigger button. Measure its rect on
  // open and on resize/scroll; clamp left so the two-month popover never runs off
  // the right edge of the viewport. Escapes .pinned/.main overflow:hidden.
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const place = () => {
      const btn = anchorRef && anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const w = popRef.current ? popRef.current.offsetWidth : 0;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top: r.bottom + 9, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  const pick = day => {
    if (start == null || end != null) { setStart(day); setEnd(null); return; }
    const a = start < day ? start : day, b = start < day ? day : start;
    onApply(a, b); // start===end → modal; else window
  };
  // Committed selection while mid-pick is just the anchor; otherwise show init range.
  const sel = start != null && end == null ? [start, start] : init;
  const preview = start != null && end == null && hoverDay
    ? [start < hoverDay ? start : hoverDay, start < hoverDay ? hoverDay : start] : [null, null];
  const canPrev = fmtDay(new Date(view.y, view.m, 1)) > min;
  const canNext = fmtDay(new Date(view.y, view.m + 1, 1)) <= max;
  const step = dir => setView(v => { const d = new Date(v.y, v.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const next = { y: view.m === 11 ? view.y + 1 : view.y, m: (view.m + 1) % 12 };
  return (
    <div ref={popRef} className={s.pickPop} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{ top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className={s.pickCols}>
        <div className={s.pickMain}>
          <div className={s.pickQuick}>
            <div className={s.units}>
              {UNITS_CAL.map(([k, g]) => (
                <button key={k} className={`${s.unit} ${activeGran && activeGran.key === k ? s.unitActive : ''}`} onClick={() => onGran({ ...g, key: k })}>{k}</button>
              ))}
              <span className={s.unitSep} />
              {UNITS_ROLL.map(([k, g]) => (
                <button key={k} className={`${s.unit} ${activeGran && activeGran.key === k ? s.unitActive : ''}`} onClick={() => onGran({ ...g, key: k })}>{k}</button>
              ))}
            </div>
            <div className={s.chips}>
              {RANGES.filter(([k]) => k === '90d' || k === 'All').map(([k, d]) => (
                <button key={k} className={`${s.chip} ${activeRange === k ? s.chipActive : ''}`} onClick={() => onRange(k, d)}>{k}</button>
              ))}
            </div>
          </div>
          <div className={s.calNav}>
            <button className={s.calArrow} onClick={() => step(-1)} disabled={!canPrev} aria-label="previous month">‹</button>
            <button className={s.calArrow} onClick={() => step(1)} disabled={!canNext} aria-label="next month">›</button>
          </div>
          <div className={s.calMonths}>
            <MonthGrid year={view.y} month={view.m} min={min} max={max} sel={sel} preview={preview} onPick={pick} onHover={setHoverDay} />
            <MonthGrid year={next.y} month={next.m} min={min} max={max} sel={sel} preview={preview} onPick={pick} onHover={setHoverDay} />
          </div>
          <div className={s.pickHint}>Click a start then an end day · pick the same day twice to open that night.</div>
          {brush}
          {hint && <div className={s.pickHint}>{hint}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- Single-date picker popover: a thin single-select wrapper around MonthGrid,
// styled with the same .pickPop shell + prev/next month arrows as RangePicker, but
// with no range/preview — the currently-open night is highlighted via sel=[day,day]
// and preview=[null,null], and clicking any in-range day navigates the modal there.
// Uses the same position:fixed + anchorRef measuring/clamping so it escapes the
// modal's overflow and stays anchored on scroll/resize. Closes on outside-click. ----
function NightDatePicker({ min, max, day, onPick, onClose, anchorRef }) {
  const [view, setView] = useState(() => { const d = new Date(day + 'T00:00:00'); return { y: d.getFullYear(), m: d.getMonth() }; });
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const place = () => {
      const btn = anchorRef && anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const w = popRef.current ? popRef.current.offsetWidth : 0;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top: r.bottom + 9, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  // Outside-click closes (the anchor button toggles separately, so ignore it).
  useEffect(() => {
    const onDown = e => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [onClose, anchorRef]);
  const canPrev = fmtDay(new Date(view.y, view.m, 1)) > min;
  const canNext = fmtDay(new Date(view.y, view.m + 1, 1)) <= max;
  const step = dir => setView(v => { const d = new Date(v.y, v.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  return (
    <div ref={popRef} className={s.pickPop}
      style={{ top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className={s.pickMain}>
        <div className={s.calNav}>
          <button className={s.calArrow} onClick={() => step(-1)} disabled={!canPrev} aria-label="previous month">‹</button>
          <button className={s.calArrow} onClick={() => step(1)} disabled={!canNext} aria-label="next month">›</button>
        </div>
        <MonthGrid year={view.y} month={view.m} min={min} max={max} sel={[day, day]} preview={[null, null]} onPick={onPick} onHover={() => {}} />
        <div className={s.pickHint}>Pick a night to view its sleep.</div>
      </div>
    </div>
  );
}

// ---- Legend: each entry is a mini-glyph shaped like the mark it stands for
// (a horizontal box-plot, bubbles, bars, a line+dot, or a stage swatch) so the
// legend reads as a key to the chart. Hovering an entry explains how to read it. ----
function LegendGlyph({ type, color }) {
  const c = color;
  if (type === 'box') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      <line x1="1" x2="25" y1="6" y2="6" stroke={c} strokeOpacity="0.4" />
      <rect x="8" y="2.5" width="10" height="7" fill={c} fillOpacity="0.32" />
      <line x1="13" x2="13" y1="2.5" y2="9.5" stroke={c} strokeWidth="1.4" />
    </svg>
  );
  if (type === 'bar') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      {[[4, 5], [11, 9], [18, 3]].map(([x, h], i) => <rect key={i} x={x} y={11 - h} width="4" height={h} fill={c} />)}
    </svg>
  );
  if (type === 'bubble') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      {[[5, 1.8], [13, 3], [21, 4.2]].map(([cx, r], i) => <circle key={i} cx={cx} cy="6" r={r} fill={c} fillOpacity="0.85" />)}
    </svg>
  );
  if (type === 'linedot') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      <polyline points="1,9 8,4 14,7 20,3 25,6" fill="none" stroke={c} strokeWidth="1.4" />
      <circle cx="14" cy="7" r="2" fill={c} />
    </svg>
  );
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="1.5" fill={c} /></svg>;
}
function LegendItem({ item }) {
  const [hov, setHov] = useState(false);
  return (
    <span className={s.legendItem} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <LegendGlyph type={item.glyph} color={item.color} />
      <span>{item.label}</span>
      {hov && item.tip && <span className={s.infoPop}>{item.tip}</span>}
    </span>
  );
}
function Legend({ items }) {
  return <div className={s.legend}>{items.map(it => <LegendItem key={it.label} item={it} />)}</div>;
}

// ---- Sub-chart caption: names a stacked chart inside a section and, on hover,
// explains in detail how to read it (same rich-tooltip treatment as the legend). ----
function SubLabel({ label, tip }) {
  const [hov, setHov] = useState(false);
  return (
    <div className={s.subLabel} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      {label}
      {hov && tip && <span className={s.infoPop}>{tip}</span>}
    </div>
  );
}

// ---- Navigator: the date selector. A miniature all-time skyline (each night's
// bed→wake band) with a draggable window: drag an edge to move start/end, drag
// inside to pan, drag empty space to draw a new window. ----
const GRIP = 6;
function Navigator({ nights, win, onWin }) {
  const [ref, w] = useMeasure();
  const H = 44, PAD = { t: 4, r: 6, b: 4, l: 6 };
  const drag = useRef(null);
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
    if (mode === 'new') onWin([idxAt(e.clientX), idxAt(e.clientX)]);
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* unsupported env */ }
  };
  const onMove = e => {
    const d = drag.current; if (!d) return;
    const i = idxAt(e.clientX), [lo, hi] = d.win;
    if (d.mode === 'pan') { const width = hi - lo; const s0 = clamp(lo + (i - d.start), 0, N - 1 - width); onWin([s0, s0 + width]); }
    else if (d.mode === 'lo') onWin([Math.min(i, hi), hi]);
    else if (d.mode === 'hi') onWin([lo, Math.max(i, lo)]);
    else onWin([Math.min(d.start, i), Math.max(d.start, i)]);
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
}

// ---- Stage Composition: per-night stacked stage minutes over the selected
// window. Fixed 10h ceiling; longer nights overflow the top. ----
function Composition({ nights, win, hover, onHover, onOpen, targets, padL = PAD_L, section }) {
  const [ref, w] = useMeasure();
  const H = 200, PAD = { t: 14, r: PAD_R, b: 6, l: padL };
  const [lo, hi] = win;
  const plotW = Math.max(w - PAD.l - PAD.r, 1), plotH = H - PAD.t - PAD.b;
  const view = useMemo(() => nights.slice(lo, hi + 1), [nights, lo, hi]);
  const n = view.length, cw = plotW / n;
  const y = v => PAD.t + plotH - (v / CAP_MIN) * plotH;

  const bars = useMemo(() => {
    if (!w) return null;
    const bw = Math.max(cw - 0.4, 0.7);
    const order = [['deep', STAGE.deep], ['core', STAGE.core], ['rem', STAGE.rem], ['awake', STAGE.awake], ['tibBefore', INBED_PRE], ['tibAfter', INBED_POST]];
    return view.map((d, k) => {
      let acc = 0;
      return order.map(([key, col]) => {
        const v = d[key] || 0; if (v <= 0) return null;
        const rect = <rect key={key} x={PAD.l + k * cw} y={y(acc + v)} width={bw} height={y(acc) - y(acc + v)} fill={col} opacity={0.88} />;
        acc += v; return rect;
      });
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, w]);

  const idxAt = e => clamp(lo + Math.floor(((e.clientX - ref.current.getBoundingClientRect().left) / ref.current.getBoundingClientRect().width * w - PAD.l) / cw), lo, hi);
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref}>
      {w > 0 && (
        <svg className={`${s.svg} ${s.clickable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          style={{ filter: 'var(--comp-mute)' }}
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
          {bars}
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
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.13} pointerEvents="none" />}
        </svg>
      )}
    </div>
  );
}

// ---- Skyline: one column per night, y = clock time, colored by stage ----
function Skyline({ nights, win, hover, onHover, onOpen, targets, padL = PAD_L, fill, section }) {
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

  const rects = useMemo(() => {
    if (!w) return null;
    return view.map((d, k) => {
      if (d.blank) return null;
      const cx = PAD.l + k * cw, bw = Math.max(cw - 0.4, 0.7);
      const tb = d.tibBefore || 0, ta = d.tibAfter || 0;
      return (
        <g key={d.day}>
          <rect x={cx} y={y(d.bed)} width={bw} height={y(d.wake) - y(d.bed)} fill="var(--text)" opacity={0.05} />
          {tb > 0 && <rect x={cx} y={y(d.bed - tb)} width={bw} height={Math.max(y(d.bed) - y(d.bed - tb), 0.5)} fill={INBED_PRE} opacity={0.4} />}
          {ta > 0 && <rect x={cx} y={y(d.wake)} width={bw} height={Math.max(y(d.wake + ta) - y(d.wake), 0.5)} fill={INBED_POST} opacity={0.4} />}
          {d.segs.map((g, j) => (
            <rect key={j} x={cx} y={y(g.a)} width={bw} height={Math.max(y(g.b) - y(g.a), 0.5)}
              fill={STAGE[g.st]} opacity={g.st === 'awake' ? 0.9 : 0.8} />
          ))}
        </g>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, w, yMin, yMax]);

  const idxAt = e => clamp(lo + Math.floor(((e.clientX - ref.current.getBoundingClientRect().left) / ref.current.getBoundingClientRect().width * w - PAD.l) / cw), lo, hi);
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref} className={fill ? s.skyFill : undefined}>
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
          {rects}
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.13} pointerEvents="none" />}
          {/* Cubism-style axis: month ticks stay put, but any tick the focused-date
              label would overlap fades out (and back in) gracefully as you hover. */}
          {(() => {
            const dateStr = hot && nights[hover]
              ? new Date(nights[hover].day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }) + (nights[hover].blank ? ' · no data' : '')
              : '';
            // Edge-aware date label: sit centered under the hovered column when there's
            // room, but if either extent would clip past the plot edge, flip to start/end
            // anchoring pinned to that edge so the whole label (incl. "· no data") shows.
            const lw = labelWidth(dateStr, 10), hw = lw / 2;
            const cxAnchor = PAD.l + (hover - lo) * cw + cw / 2;
            const leftEdge = PAD.l, rightEdge = w - PAD.r;
            let labelX, anchor, labelCenter;
            if (cxAnchor - hw < leftEdge) { anchor = 'start'; labelX = leftEdge; labelCenter = leftEdge + hw; }
            else if (cxAnchor + hw > rightEdge) { anchor = 'end'; labelX = rightEdge; labelCenter = rightEdge - hw; }
            else { anchor = 'middle'; labelX = cxAnchor; labelCenter = cxAnchor; }
            const hideR = hw + 16, showR = hw + 44;
            return (
              <>
                {timeTicks(nights, lo, hi, plotW).map(t => {
                  const tx = PAD.l + (t.i - lo) * cw;
                  const op = hot ? clamp((Math.abs(tx + labelWidth(t.lbl, 10) / 2 - labelCenter) - hideR) / (showR - hideR), 0, 1) : 1;
                  return <text key={t.i} x={tx} y={H - 5} fill="var(--dim)" fontSize="10" opacity={op} style={{ transition: 'opacity 0.18s ease' }}>{t.lbl}</text>;
                })}
                {dateStr && (
                  <text x={labelX} y={H - 5} fill="var(--lime)" fontSize="10" fontWeight="600" textAnchor={anchor} pointerEvents="none">{dateStr}</text>
                )}
              </>
            );
          })()}
        </svg>
      )}
    </div>
  );
}

// ---- Naps: shares the skyline's date axis (one column per night, gaps on days
// without naps). Top = the 3 nights before each nap vs the median (recovery
// context); bottom = nap length. Nap-days that followed short nights are lime.
// Back-to-back bars sharing one central date axis: nap length grows up (given
// 3/4 of the height), the 3 nights before each nap hang down below the axis
// (inverted, 1/4 of the height). A short-sleep run reads as debt under the nap.
function NapsPanel({ nights, napDays, win, hover, onHover, onOpen, padL = PAD_L, section }) {
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
  const hot = hover != null && hover >= lo && hover <= hi;
  const bandX = hot ? PAD.l + (hover - lo) * cw : 0;

  // Sleep debt for EVERY night: 3-night rolling AVERAGE of the nightly deficit
  // under 7h, using effective sleep (brief wake-ups folded in). Memoized so
  // hover doesn't re-render the whole series.
  const debtBars = useMemo(() => {
    if (!w) return null;
    const bwD = Math.max(cw - 0.4, 0.7), out = [];
    for (let i = lo; i <= hi; i++) {
      let sum = 0, cnt = 0;
      for (const j of [i - 2, i - 1, i]) { const a = nights[j]?.asleepEff; if (a != null) { sum += Math.max(0, 420 - a); cnt++; } }
      const debt = cnt ? sum / cnt : 0;
      if (debt <= 0.5) continue;
      out.push(<rect key={i} x={PAD.l + (i - lo) * cw} y={debtTop} width={bwD} height={yD(debt) - debtTop} fill={DEBT} opacity={0.7} />);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nights, lo, hi, w]);

  return (
    <div ref={ref} className={s.napGrid}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {hot && <rect x={bandX} y={TOP} width={cw} height={debtBase - TOP} fill="#fff" opacity={0.13} pointerEvents="none" />}

          {/* nap length — up (nap-days only) */}
          {[1, 2].map(h => (
            <g key={h}><line x1={PAD.l} x2={w - PAD.r} y1={yN(h * 60)} y2={yN(h * 60)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={yN(h * 60) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{h}h</text></g>
          ))}
          {days.map(d => (
            <rect key={d.idx} x={X(d.idx) - bwN / 2} y={yN(d.napLen)} width={bwN} height={napBase - yN(d.napLen)}
              fill={NAP} opacity={d.recovery ? 0.9 : 0.5} />
          ))}

          {/* shared central zero line (date labels dropped — see the pinned skyline) */}
          <line x1={PAD.l} x2={w - PAD.r} y1={napBase} y2={napBase} stroke="var(--dim)" opacity={0.6} />

          {/* sleep debt — down (inverted), every night */}
          {[1, 2].map(h => (
            <g key={h}><line x1={PAD.l} x2={w - PAD.r} y1={yD(h * 60)} y2={yD(h * 60)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={yD(h * 60) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{h}h</text></g>
          ))}
          {debtBars}
        </svg>
      )}
    </div>
  );
}

// ---- Box-plot per night (min / Q1 / median / Q3 / max) across the window, for
// vitals that are a timeseries within each night. byDay maps day -> box. ----
function BoxSeries({ nights, win, byDay, color, unit, label, hover, onHover, onOpen, H = 168, padL = PAD_L, section }) {
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

  const marks = useMemo(() => {
    if (!w) return null;
    return boxes.map(({ k, b }) => {
      const cx = PAD.l + k * cw + cw / 2;
      return (
        <g key={k}>
          <line x1={cx} x2={cx} y1={y(b.hi)} y2={y(b.lo)} stroke={color} opacity={0.3} />
          <rect x={cx - bw / 2} y={y(b.q3)} width={bw} height={Math.max(y(b.q1) - y(b.q3), 0.8)} fill={color} opacity={0.32} />
          <line x1={cx - bw / 2} x2={cx + bw / 2} y1={y(b.med)} y2={y(b.med)} stroke={color} strokeWidth={1.3} />
        </g>
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, w, yMin, yMax]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const onMove = e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section });
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={onMove} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {niceTicks(yMin, yMax, 3).filter(g => g > yMin && g < yMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {marks}
          {boxes.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
    </div>
  );
}

// ---- "The Morning After" combo (styled like Respiration): next-day HRV box-plots
// on top, with the following-day resting HR area-encoded as a bubble lane beneath.
// Both are next-day recovery readouts, so they share one panel + the date axis. ----
function NextDayCombo({ nights, win, hrvByDay, rhrByDay, hrvColor, rhrColor, hover, onHover, onOpen, H = 176, padL = PAD_L, section }) {
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

  const marks = useMemo(() => {
    if (!w) return null;
    const out = [];
    const maxR = Math.min(Math.max(cw * 0.5, 2.5), 6);
    const norm = v => rMax > rMin ? (v - rMin) / (rMax - rMin) : 1;
    view.forEach((d, k) => {
      const v = rhrByDay[d.day];
      if (v != null) out.push(<circle key={`r${k}`} cx={X(k)} cy={rhrRow} r={Math.max(maxR * Math.sqrt(0.16 + 0.84 * norm(v)), 1)} fill={rhrColor} opacity={0.75} />);
    });
    boxes.forEach(({ k, b }) => {
      const cx = X(k);
      out.push(<line key={`w${k}`} x1={cx} x2={cx} y1={y(b.hi)} y2={y(b.lo)} stroke={hrvColor} opacity={0.3} />);
      out.push(<rect key={`b${k}`} x={cx - bw / 2} y={y(b.q3)} width={bw} height={Math.max(y(b.q1) - y(b.q3), 0.8)} fill={hrvColor} opacity={0.32} />);
      out.push(<line key={`m${k}`} x1={cx - bw / 2} x2={cx + bw / 2} y1={y(b.med)} y2={y(b.med)} stroke={hrvColor} strokeWidth={1.3} />);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, view, w, yMin, yMax, rMin, rMax]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {niceTicks(yMin, yMax, 3).filter(g => g > yMin && g < yMax).map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{g}</text></g>
          ))}
          <text x={PAD.l - 6} y={rhrRow + 3} fill="var(--dim)" fontSize="8" textAnchor="end">RHR</text>
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={4} width={cw} height={H - 6} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {marks}
          {boxes.length === 0 && <text x={w / 2} y={mTop + plotH / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
    </div>
  );
}

// ---- Respiration section: respiratory-rate box-plots + a top lane of
// area-encoded bubbles for breathing disturbances and brief wake-ups. SpO2 is
// its own box-plot chart (added in the section, not overlaid here). ----
function RespirationChart({ nights, win, respBy, hover, onHover, onOpen, padL = PAD_L, section }) {
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

  const marks = useMemo(() => {
    if (!w) return null;
    const out = [];
    // bubbles: area (r ∝ √value) encodes brief-wake count and disturbance level.
    const maxR = Math.min(Math.max(cw * 0.5, 2.5), 6);
    const wakeMax = Math.max(1, ...view.map(d => d.briefWakes || 0));
    const distMax = Math.max(1, ...view.map(d => d.dist || 0));
    const fullMax = Math.max(1, ...view.map(d => d.fullWakeMin || 0));
    view.forEach((d, k) => {
      const cx = X(k);
      if (d.briefWakes > 0) out.push(<circle key={`w${k}`} cx={cx} cy={wakeRow} r={Math.max(maxR * Math.sqrt(d.briefWakes / wakeMax), 1)} fill={STAGE.awake} opacity={0.7} />);
      if (d.dist > 0) out.push(<circle key={`d${k}`} cx={cx} cy={distRow} r={Math.max(maxR * Math.sqrt(d.dist / distMax), 1)} fill={DIST} opacity={0.8} />);
      if (d.fullWakeMin > 0) out.push(<circle key={`f${k}`} cx={cx} cy={fullRow} r={Math.max(maxR * Math.sqrt(d.fullWakeMin / fullMax), 1)} fill={FULLWAKE} opacity={0.8} />);
    });
    boxes.forEach(({ k, b }) => {
      const cx = X(k);
      out.push(<line key={`wk${k}`} x1={cx} x2={cx} y1={yR(b.hi)} y2={yR(b.lo)} stroke={RESP} opacity={0.28} />);
      out.push(<rect key={`bx${k}`} x={cx - bw / 2} y={yR(b.q3)} width={bw} height={Math.max(yR(b.q1) - yR(b.q3), 0.8)} fill={RESP} opacity={0.3} />);
      out.push(<line key={`md${k}`} x1={cx - bw / 2} x2={cx + bw / 2} y1={yR(b.med)} y2={yR(b.med)} stroke={RESP} strokeWidth={1.3} />);
    });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, boxes, w, rMin, rMax]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref}>
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
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={4} width={cw} height={H - 6} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {marks}
        </svg>
      )}
    </div>
  );
}

// ---- Consistency: rolling 14-night standard deviation of bedtime and wake
// time (lower = more regular). ----
const CONSIST_WIN = 14;
function Consistency({ nights, win, hover, onHover, onOpen, targets, padL = PAD_L }) {
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
  const line = key => {
    let d = '', pen = false;
    for (let i = lo; i <= hi; i++) { const v = rolling[i][key]; if (v == null) { pen = false; continue; } d += `${pen ? 'L' : 'M'}${X(i)} ${y(v)}`; pen = true; }
    return d;
  };
  const dots = useMemo(() => {
    if (!w) return null;
    const r = Math.min(Math.max(cw * 0.28, 0.8), 2.2), out = [];
    for (let i = lo; i <= hi; i++) {
      if (!delta[i]) continue;
      out.push(<circle key={`b${i}`} cx={X(i)} cy={y(delta[i].bed)} r={r} fill={BED_TGT} opacity={0.5} />);
      out.push(<circle key={`w${i}`} cx={X(i)} cy={y(delta[i].wake)} r={r} fill={WAKE_TGT} opacity={0.5} />);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [delta, lo, hi, w]);
  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;
  const gl = g => `${g > 0 ? '+' : ''}${g}`;

  return (
    <div ref={ref}>
      {w > 0 && (
        <svg className={`${s.svg} ${onOpen ? s.clickable : s.hoverable}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          onPointerMove={e => onHover({ i: idxAt(e), cx: e.clientX, cy: e.clientY, section })} onClick={onOpen ? e => onOpen(idxAt(e)) : undefined}>
          {glines.map(g => (
            <g key={g}><line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="var(--line)" />
              <text x={PAD.l - 6} y={y(g) + 3} fill="var(--dim)" fontSize="10" textAnchor="end">{gl(g)}</text></g>
          ))}
          <line x1={PAD.l} x2={w - PAD.r} y1={mid} y2={mid} stroke="var(--dim)" opacity={0.6} />
          <text x={PAD.l - 6} y={mid + 3} fill="var(--dim)" fontSize="10" textAnchor="end">0</text>
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {dots}
          <path d={line('bed')} fill="none" stroke={BED_TGT} strokeWidth={1.8} />
          <path d={line('wake')} fill="none" stroke={WAKE_TGT} strokeWidth={1.8} />
        </svg>
      )}
    </div>
  );
}

// ---- Recovery correlation: next-day HRV (line) over daily training load
// (faint bars), sharing the date axis with the nap/debt chart above. ----
// Generic per-night line/bars chart sharing the date axis with every other
// chart (identical PAD_L/PAD_R). valueAt(i) returns the value for night index i.
function MiniChart({ nights, win, valueAt, color, unit, label, type = 'line', hover, onHover, onOpen, H = 116, padL = PAD_L, section }) {
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

  const marks = useMemo(() => {
    if (!w || !pts.length) return null;
    if (type === 'bars') {
      const bw = Math.max(cw - 0.6, 0.8);
      return pts.map(p => <rect key={p.i} x={PAD.l + (p.i - lo) * cw} y={y(p.v)} width={bw} height={PAD.t + plotH - y(p.v)} fill={color} opacity={0.55} />);
    }
    if (type === 'bubble') {
      const cy = PAD.t + plotH / 2;
      const maxR = Math.min(Math.max(cw * 0.5, 2.5), 7);
      const norm = v => bvMax > bvMin ? (v - bvMin) / (bvMax - bvMin) : 1;
      // area ∝ value: r = maxR·√(floor + (1-floor)·norm); a floor keeps the smallest bubble visible.
      return pts.map(p => <circle key={p.i} cx={X(p.i)} cy={cy} r={Math.max(maxR * Math.sqrt(0.16 + 0.84 * norm(p.v)), 1)} fill={color} opacity={0.72} />);
    }
    let d = '', pen = false;
    pts.forEach(p => { d += `${pen ? 'L' : 'M'}${X(p.i)} ${y(p.v)}`; pen = true; });
    return <path d={d} fill="none" stroke={color} strokeWidth={1.6} />;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pts, w, yMin, yMax]);

  const idxAt = e => { const r = ref.current.getBoundingClientRect(); const px = (e.clientX - r.left) / r.width * w; return clamp(lo + Math.floor((px - PAD.l) / cw), lo, hi); };
  const hot = hover != null && hover >= lo && hover <= hi;

  return (
    <div ref={ref}>
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
          {hot && <rect x={PAD.l + (hover - lo) * cw} y={PAD.t} width={cw} height={plotH} fill="#fff" opacity={0.12} pointerEvents="none" />}
          {marks}
          {pts.length === 0 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no data in this window</text>}
        </svg>
      )}
    </div>
  );
}

function Stat({ value, unit, label }) {
  return <div><div className={s.statValue}>{value}{unit && <small> {unit}</small>}</div><div className={s.statLabel}>{label}</div></div>;
}

// ---- Hypnogram: one night's stage transitions. x = clock time (bed → wake),
// y = stage lanes (Awake / REM / Core / Deep), colored blocks per segment with
// dim connectors at each transition so the stepping between stages reads. ----
const HYP_LANES = [['awake', 'Awake'], ['rem', 'REM'], ['core', 'Core'], ['deep', 'Deep']];
const STAGE_LABEL = { awake: 'Awake', rem: 'REM', core: 'Core', deep: 'Deep' };
function NightDetail({ night, detail }) {
  const [ref, w] = useMeasure();
  const [hoverT, setHoverT] = useState(null);
  const [tip, setTip] = useState(null);
  const mPad = Math.ceil(Math.max(
    ...HYP_LANES.map(([, lbl]) => labelWidth(lbl, 11)),
    labelWidth('888', 9),
  )) + 8;
  const PAD = { l: mPad, r: PAD_R };
  const { segs, bed, wake } = night;
  // Widen the clock axis to the in-bed window (bed - tibBefore .. wake + tibAfter)
  // when present, so pre-sleep / post-wake in-bed periods show. Falls back to
  // bed→wake for nights without time-in-bed data.
  const tb = night.tibBefore || 0, ta = night.tibAfter || 0;
  const x0 = bed - tb, x1 = wake + ta;
  const plotW = Math.max(w - PAD.l - PAD.r, 1);
  const span = Math.max(x1 - x0, 1);
  const x = m => PAD.l + (clamp(m, x0, x1) - x0) / span * plotW;
  const ticks = [];
  for (let m = Math.ceil(x0 / 60) * 60; m <= x1; m += 60) ticks.push(m);

  // Shared clock-time cursor across the hypnogram + every vital curve.
  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vbX = (e.clientX - rect.left) / rect.width * w;
    setHoverT(clamp(x0 + (vbX - PAD.l) / plotW * span, x0, x1));
    setTip({ x: e.clientX, y: e.clientY });
  };
  const onLeave = () => { setHoverT(null); setTip(null); };
  const guide = h => hoverT != null && <line x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={h} stroke="#fff" opacity={0.32} pointerEvents="none" />;
  const winPts = samples => (samples || []).filter(p => p.t >= bed - 3 && p.t <= wake + 3);
  // Snap to the nearest reading in time (1-D Voronoi): the hovered point is
  // whichever sample owns the cursor's x, no distance cutoff. Returns the point
  // itself so the marker lands ON the line/dot, not at the cursor's x.
  const near = samples => {
    if (hoverT == null) return null;
    const pts = winPts(samples);
    if (!pts.length) return null;
    let best = null, bd = Infinity;
    for (const p of pts) { const d = Math.abs(p.t - hoverT); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const seg = hoverT == null ? null : segs.find(sg => hoverT >= sg.a && hoverT <= sg.b);

  const HYP = 176, hp = { t: 12, b: 8 };
  const laneH = (HYP - hp.t - hp.b) / HYP_LANES.length;
  const laneY = st => hp.t + HYP_LANES.findIndex(l => l[0] === st) * laneH + laneH / 2;
  const barH = Math.min(laneH * 0.5, 22);

  // One overnight vital as a small line chart sharing the clock axis.
  const seriesChart = (samples, color, label, unit, H, round = 0) => {
    const pts = (samples || []).filter(p => p.t >= bed - 3 && p.t <= wake + 3);
    if (pts.length < 2) return null;
    const vs = pts.map(p => p.v);
    const min = Math.min(...vs), max = Math.max(...vs), avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const PADt = 15, PADb = 5, plotH = H - PADt - PADb;
    const padv = (max - min) * 0.2 || 1, lo = min - padv, hi = max + padv;
    const y = v => PADt + plotH - (v - lo) / (hi - lo) * plotH;
    const fmt = v => round ? v.toFixed(round) : Math.round(v);
    // Sparse series (few samples spread over the night) read better as a scatter
    // than a line that fabricates connections across long gaps.
    const scatter = pts.length < 12 || span / pts.length > 30;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
    const cur = near(samples);
    return (
      <svg key={label} className={s.svg} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none">
        <text x={0} y={10} fontSize="10" fill="var(--dim)">{label} · <tspan fill={color}>{fmt(min)}–{fmt(max)}</tspan> {unit}{scatter ? ` · ${pts.length} readings` : ''}</text>
        <line x1={PAD.l} x2={w - PAD.r} y1={y(avg)} y2={y(avg)} stroke="var(--line)" strokeDasharray="2 3" />
        <text x={PAD.l - 6} y={y(avg) + 3} fontSize="9" fill="var(--dim)" textAnchor="end">{fmt(avg)}</text>
        {scatter
          ? pts.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.4} fill={color} opacity={0.9} />)
          : <path d={d} fill="none" stroke={color} strokeWidth={1.6} />}
        {guide(H)}
        {cur && <circle cx={x(cur.t)} cy={y(cur.v)} r={scatter ? 4 : 3.4} fill={color} stroke="#fff" strokeWidth={1} pointerEvents="none" />}
      </svg>
    );
  };

  // Loading placeholder for one vital: mirrors seriesChart's layout (same
  // viewBox, label row, dashed mean line) but draws a shimmering ghost curve
  // over the clock axis so the rows read as charts materializing, not a spinner.
  const skelChart = (color, label, unit, H, seed) => {
    const PADt = 15, PADb = 5, plotH = H - PADt - PADb;
    const mid = PADt + plotH / 2;
    // A deterministic wiggly path across the plot, so each row looks distinct.
    const N = 26;
    const d = Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      const mx = x(bed + t * (wake - bed));
      const wob = Math.sin(t * 7 + seed) * 0.28 + Math.sin(t * 17 + seed * 2) * 0.12;
      const my = mid - wob * plotH * 0.5;
      return `${i ? 'L' : 'M'}${mx.toFixed(1)} ${my.toFixed(1)}`;
    }).join('');
    const gid = `skelg-${seed}`;
    return (
      <svg key={label} className={`${s.svg} ${s.skelSvg}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0.15" />
            <stop offset="50%" stopColor={color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={color} stopOpacity="0.15" />
            <animate attributeName="x1" values="-1;1" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="x2" values="0;2" dur="1.6s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        <text x={0} y={10} fontSize="10" fill="var(--dim)" opacity={0.6}>{label} · <tspan fill={color}>loading</tspan> {unit}</text>
        <line x1={PAD.l} x2={w - PAD.r} y1={mid} y2={mid} stroke="var(--line)" strokeDasharray="2 3" />
        <path className={s.skelTrack} d={d} fill="none" stroke="var(--line)" strokeWidth={1.4} />
        <path d={d} fill="none" stroke={`url(#${gid})`} strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    );
  };

  const rows = [
    seg && ['stage', STAGE_LABEL[seg.st], STAGE[seg.st]],
    ['hr', near(detail?.hr)?.v, HR, ' bpm'],
    ['hrv', near(detail?.hrv)?.v, HRV, ' ms'],
    ['resp', near(detail?.resp)?.v, RESP, ' br/min', 1],
    ['spo₂', near(detail?.spo2)?.v, SPO2, '%'],
  ];

  return (
    <div ref={ref} onPointerMove={w > 0 ? onMove : undefined} onPointerLeave={onLeave} style={{ cursor: 'crosshair' }}>
      {w > 0 && (
        <>
          <svg className={s.svg} width="100%" height={HYP} viewBox={`0 0 ${w} ${HYP}`} preserveAspectRatio="none">
            {/* In-bed periods (pre-sleep / post-wake) as faint full-height shading. */}
            {tb > 0 && <rect className={s.inbedBand} x={x(x0)} y={hp.t} width={Math.max(x(bed) - x(x0), 0)} height={HYP - hp.t - hp.b} fill={INBED_PRE} />}
            {ta > 0 && <rect className={s.inbedBand} x={x(wake)} y={hp.t} width={Math.max(x(x1) - x(wake), 0)} height={HYP - hp.t - hp.b} fill={INBED_POST} />}
            {(tb > 0 || ta > 0) && <text x={x(x0) + 3} y={hp.t + 9} fontSize="9" fill="var(--dim)">In bed</text>}
            {HYP_LANES.map(([st, lbl]) => (
              <g key={st}>
                <line x1={PAD.l} x2={w - PAD.r} y1={laneY(st)} y2={laneY(st)} stroke="var(--line)" opacity={0.4} />
                <text x={PAD.l - 6} y={laneY(st) + 3} fill={STAGE[st]} fontSize="11" textAnchor="end">{lbl}</text>
              </g>
            ))}
            {segs.slice(1).map((seg, i) => (
              <line key={`c${i}`} x1={x(seg.a)} x2={x(seg.a)} y1={laneY(segs[i].st)} y2={laneY(seg.st)}
                stroke="var(--dim)" strokeWidth={1.4} opacity={0.5} />
            ))}
            {segs.map((sg, i) => (
              <rect key={i} x={x(sg.a)} y={laneY(sg.st) - barH / 2} width={Math.max(x(sg.b) - x(sg.a), 1.2)} height={barH}
                rx={3} fill={STAGE[sg.st]} opacity={seg ? (sg === seg ? 1 : 0.28) : 0.92} />
            ))}
            {seg && (
              <rect x={x(seg.a)} y={laneY(seg.st) - barH / 2} width={Math.max(x(seg.b) - x(seg.a), 1.2)} height={barH}
                rx={3} fill="none" stroke="#fff" strokeWidth={1.4} pointerEvents="none" />
            )}
          </svg>
          {detail ? (
            <>
              {seriesChart(detail.hr, HR, 'Heart rate', 'bpm', 80)}
              {seriesChart(detail.hrv, HRV, 'HRV (SDNN)', 'ms', 60)}
              {seriesChart(detail.resp, RESP, 'Respiratory rate', 'br/min', 60, 1)}
              {seriesChart(detail.spo2, SPO2, 'Blood oxygen', '%', 56)}
            </>
          ) : (
            <div className={s.vitalsSkel} aria-busy="true" aria-label="loading overnight vitals">
              {skelChart(HR, 'Heart rate', 'bpm', 80, 0)}
              {skelChart(HRV, 'HRV (SDNN)', 'ms', 60, 1.7)}
              {skelChart(RESP, 'Respiratory rate', 'br/min', 60, 3.4)}
              {skelChart(SPO2, 'Blood oxygen', '%', 56, 5.1)}
            </div>
          )}
          <svg className={s.svg} width="100%" height={18} viewBox={`0 0 ${w} 18`} preserveAspectRatio="none">
            {ticks.map(m => <text key={m} x={x(m)} y={12} fill="var(--dim)" fontSize="10" textAnchor="middle">{clock(m)}</text>)}
            {guide(18)}
          </svg>
          {tip && hoverT != null && (
            <div className={s.tip} style={{ left: Math.min(tip.x + 14, window.innerWidth - 200), top: tip.y + 14 }}>
              <b>{clock(Math.round(hoverT))}</b>
              {rows.filter(r => r && r[1] != null).map(([lbl, val, col, unit = '', round]) => (
                <div key={lbl} className={s.tipRow}>
                  <span>{lbl}</span>
                  <span style={{ color: col }}>{typeof val === 'number' ? (round ? val.toFixed(round) : Math.round(val)) : val}{typeof val === 'number' ? unit : ''}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function NightModal({ night, naps, extra = {}, onClose, onStep, onPickDate, min, max }) {
  const [detail, setDetail] = useState(null);
  const [picking, setPicking] = useState(false); // single-date picker open
  const changeRef = useRef(null); // anchor for the fixed-position picker
  useEffect(() => {
    let ok = true, tries = 0, timer;
    setDetail(null);
    // Debounced fetch with a couple of retries so a transient error (e.g. a brief
    // DuckDB lock) doesn't leave the vitals permanently blank for a night that has data.
    const load = () => getHealthSleepNight(night.day)
      .then(d => { if (ok) setDetail(d); })
      .catch(() => { if (!ok) return; if (tries++ < 2) { timer = setTimeout(load, 400); } else { setDetail({ hr: [], hrv: [], resp: [], spo2: [] }); } });
    timer = setTimeout(load, 250);
    return () => { ok = false; clearTimeout(timer); };
  }, [night.day]);

  useEffect(() => {
    const onKey = e => {
      // Escape closes the picker first if it's open; otherwise closes the modal.
      if (e.key === 'Escape') { if (picking) { setPicking(false); } else { onClose(); } return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); onStep?.(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onStep?.(-1); }
    };
    window.addEventListener('keydown', onKey);
    const sb = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sb > 0) document.body.style.paddingRight = `${sb}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [onClose, onStep, picking]);

  const title = new Date(night.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  return (
    <div className={s.modalOverlay} onClick={onClose}>
      <section className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalHead}>
          <div>
            {/* The whole date title is the affordance: hover (or keyboard-focus)
                reveals an inline edit icon + label that opens the single-date picker. */}
            <button ref={changeRef} className={s.modalTitleRow}
              aria-expanded={picking} aria-label="change date"
              onClick={() => setPicking(p => !p)}>
              <span className={s.modalTitle}>{title}</span>
              <span className={s.changeDate} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                edit
              </span>
            </button>
            <div className={s.modalSub}>{clock(night.bed)} → {clock(night.wake)} · {hm(night.asleepEff)} asleep · {night.eff == null ? '—' : `${night.eff}%`} efficiency · {srcLabel(night.source)}</div>
          </div>
          <div className={s.modalHeadRight}>
            <button className={shared.btn} onClick={onClose}>Close</button>
          </div>
        </div>
        {picking && (
          <NightDatePicker min={min} max={max} day={night.day} anchorRef={changeRef}
            onClose={() => setPicking(false)}
            onPick={day => { setPicking(false); onPickDate?.(day); }} />
        )}
        <div className={s.statTiers}>
          <div className={`${s.statTier} ${s.statHero}`}>
            <Stat value={hm(night.asleepEff)} label="asleep" />
            <Stat value={night.eff == null ? '—' : night.eff} unit="%" label="efficiency" />
            <Stat value={hm(night.deep)} label="deep" />
          </div>
          <div className={s.statTier}>
            <Stat value={hm(night.rem)} label="rem" />
            <Stat value={hm(night.core)} label="core" />
            <Stat value={hm(night.awake)} label="awake" />
            <Stat value={`${night.wakeCount} · ${night.briefWakes}`} label="wakes · brief" />
            {(night.tibBefore + night.tibAfter) > 0 && <Stat value={hm(night.tibBefore + night.tibAfter)} label="extra in bed" />}
            {naps.length > 0 && <Stat value={naps.map(p => hm(p.asleep)).join(', ')} label={naps.length > 1 ? 'naps' : 'nap'} />}
          </div>
          <div className={`${s.statTier} ${s.statSm}`}>
            <Stat value={extra.hr ? extra.hr.med : '—'} unit="bpm" label="sleeping HR" />
            {extra.hrv && <Stat value={extra.hrv.med} unit="ms" label="HRV" />}
            <Stat value={night.resp ? night.resp.toFixed(1) : '—'} unit="br/min" label="resp" />
            <Stat value={night.spo2 ? `${night.spo2.toFixed(0)}` : '—'} unit="%" label="spo₂" />
            {night.dist != null && <Stat value={night.dist.toFixed(1)} label="breathing dist." />}
            {extra.debt > 0.5 && <Stat value={hm(extra.debt)} label="sleep debt" />}
            {extra.nextHrv != null && <Stat value={extra.nextHrv} unit="ms" label="next-day HRV" />}
            {extra.load != null && <Stat value={Math.round(extra.load).toLocaleString()} unit="kcal" label="training load" />}
            {extra.bedStd != null && <Stat value={`${Math.round(extra.bedStd)} / ${Math.round(extra.wakeStd)}`} unit="min" label="bed / wake σ" />}
          </div>
        </div>
        <div className={s.miniLabel} style={{ marginLeft: 0 }}>Sleep stages &amp; overnight vitals</div>
        <NightDetail night={night} detail={detail} />
        <div className={s.modalStepHint}>← → to step through nights</div>
      </section>
    </div>
  );
}


export default function Sleep() {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [win, setWin] = useState(null);
  const [hover, setHover] = useState(null);
  const tipRef = useRef(null);
  // Keep the day tooltip fully on-screen: after it renders at the cursor, measure
  // it and clamp against every viewport edge — flip left/above when it would
  // overflow right/bottom, clamp to an 8px inset otherwise.
  useEffect(() => {
    const el = tipRef.current;
    if (!el || !hover || hover.cx == null) return;
    const M = 8, GAP = 14;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = hover.cx + GAP;
    if (left + w > vw - M) left = hover.cx - w - GAP; // flip to the left of cursor
    left = Math.max(M, Math.min(left, vw - w - M));
    let top = hover.cy + GAP;
    if (top + h > vh - M) top = Math.min(hover.cy - h - GAP, vh - h - M); // flip above / clamp
    top = Math.max(M, top);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });
  const [openIdx, setOpenIdx] = useState(null);
  const [range, setRange] = useState('6mo');
  const [gran, setGran] = useState(null); // active nav unit: {type:'cal',unit:'week'|'month'} | {type:'roll',n} | null
  const [pick, setPick] = useState(null); // inline date-range picker: {start,end} | null
  const pickBtnRef = useRef(null); // trigger button the fixed-position picker anchors to
  // Hover-intent for the range picker: hovering the stepper (or the popover)
  // opens it; leaving both closes after a short delay so the cursor can travel
  // from stepper down into the popover without dismissing it.
  const pickTimer = useRef(null);
  const openPick = () => {
    if (pickTimer.current) { clearTimeout(pickTimer.current); pickTimer.current = null; }
    setPick(p => p || [data.nights[win[0]].day, data.nights[win[1]].day]);
  };
  const closePickSoon = () => {
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => { setPick(null); pickTimer.current = null; }, 180);
  };
  const [series, setSeries] = useState(null);
  const [tuner, setTuner] = useState(false); // dev color-tuner panel open/closed
  // The color tuner is a dev tool, parked behind ?tune (the palette is baked into
  // global.css :root). Add ?tune to the URL to reveal its header toggle.
  const tuneEnabled = typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('tune');
  const [nux, setNux] = useState(() => { try { return !localStorage.getItem('sleepNuxSeen'); } catch { return false; } });
  const dismissNux = () => { try { localStorage.setItem('sleepNuxSeen', '1'); } catch { /* ignore */ } setNux(false); };
  // Web fonts load after first paint; re-measure the gutter once IBM Plex Mono is
  // ready so labels can't be clipped by a fallback-font under-measurement.
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { document.fonts?.ready?.then(() => setFontsReady(true)); }, []);
  // Re-apply any persisted color-tuner working set on load so a reload keeps it,
  // even with the tuner panel closed. (Defaults are untouched if nothing is saved.)
  useEffect(() => { if (tuneEnabled) applyTunerState(); }, []);

  useEffect(() => {
    getHealthSleep()
      .then(d => { const nights = fillNightGaps(d.nights); setData({ ...d, nights }); const N = nights.length; if (N) setWin([Math.max(0, N - 183), N - 1]); })
      .catch(e => setError(e.message));
    getHealthSleepSeries().then(setSeries).catch(() => setSeries({ hr: [], hrv: [], resp: [], spo2: [], load: [], rhr: [], daylight: [] }));
  }, []);

  // Index the box-plot series + daily scalars by day for alignment with nights.
  const byDay = useMemo(() => {
    const idx = k => Object.fromEntries((series?.[k] || []).map(r => [r.night, r]));
    return { hr: idx('hr'), hrv: idx('hrv'), resp: idx('resp'), spo2: idx('spo2'),
      load: Object.fromEntries((series?.load || []).map(r => [r.day, r.kcal])),
      rhr: Object.fromEntries((series?.rhr || []).map(r => [r.day, r.bpm])),
      daylight: Object.fromEntries((series?.daylight || []).map(r => [r.day, r.min])) };
  }, [series]);
  // Next-day HRV box: at night i show the FOLLOWING night's HRV distribution.
  const nextHrvByDay = useMemo(() => {
    const m = {}; if (data) data.nights.forEach((n, i) => { const nx = byDay.hrv[data.nights[i + 1]?.day]; if (nx) m[n.day] = nx; }); return m;
  }, [data, byDay]);
  // Following-day resting HR (recovery OUTPUT): the RHR of the day after you wake
  // — same lag as next-day HRV (the next night's calendar date).
  const followRhrByDay = useMemo(() => {
    const m = {}; if (data) data.nights.forEach((n, i) => { const r = byDay.rhr[data.nights[i + 1]?.day]; if (r != null) m[n.day] = r; }); return m;
  }, [data, byDay]);
  // Time in daylight (bedtime INPUT): the daylight accumulated the day BEFORE this
  // night's label — i.e. the daytime that precedes the evening you went to bed.
  const daylightByDay = useMemo(() => {
    const m = {}; if (data) data.nights.forEach(n => {
      const p = new Date(n.day + 'T00:00:00'); p.setDate(p.getDate() - 1);
      const v = byDay.daylight[p.toISOString().slice(0, 10)]; if (v != null) m[n.day] = v;
    }); return m;
  }, [data, byDay]);
  const targets = { deepMin: 60, deepMax: 110, ...(data?.targets || { asleepMin: 420, bedMin: 420, wakeMin: 840, asleepHours: 7, bedtime: '01:00', wake: '08:00' }) };

  // Size the shared left gutter to the widest y-axis label that appears across the
  // aligned date charts (measured from the whole dataset), so every chart lines up
  // column-for-column with just enough room and no wasted space.
  const padL = useMemo(() => {
    const cands = [['wakes', 8], ['dist', 8], ['10h', 10], ['+180', 10]];
    for (let h = 0; h < 24; h++) cands.push([clock(h * 60), 10]);
    const maxOf = arr => { const v = (arr || []).map(r => r.hi ?? r.med).filter(x => x != null); return v.length ? Math.max(...v) : null; };
    for (const k of ['hr', 'hrv', 'resp', 'spo2']) { const m = maxOf(series?.[k]); if (m != null) cands.push([String(Math.ceil(m)), 10]); }
    const loads = (series?.load || []).map(r => r.kcal).filter(x => x != null);
    if (loads.length) cands.push([String(Math.ceil(Math.max(...loads))), 10]);
    return Math.ceil(Math.max(...cands.map(([str, px]) => labelWidth(str, px)))) + 8;
  }, [series, fontsReady]);

  const applyRange = (key, days) => {
    const N = data.nights.length;
    setWin([days ? Math.max(0, N - days) : 0, N - 1]);
    setRange(key);
    setGran(null);
  };
  const changeWin = w => { setWin(w); setRange(null); setGran(null); };

  // Dataset date bounds (first/last day, native-input formatted YYYY-MM-DD).
  const firstDay = data?.nights[0]?.day;
  const lastDay = data?.nights[data.nights.length - 1]?.day;
  // Map a YYYY-MM-DD to the nearest index in data.nights (they are a contiguous
  // day calendar, so index is a pure date-offset from firstDay, clamped).
  const dayToIdx = day => {
    if (!data) return 0;
    const N = data.nights.length;
    const off = Math.round((new Date(day + 'T00:00:00') - new Date(firstDay + 'T00:00:00')) / 86400000);
    return clamp(off, 0, N - 1);
  };
  // Snap to the nearest NON-blank index (search outward), for opening the modal.
  const nearestReal = idx => {
    if (!data) return null;
    const N = data.nights.length;
    if (!data.nights[idx]?.blank) return data.nights[idx] ? idx : null;
    for (let d = 1; d < N; d++) {
      if (idx - d >= 0 && !data.nights[idx - d].blank) return idx - d;
      if (idx + d < N && !data.nights[idx + d].blank) return idx + d;
    }
    return null;
  };
  // Apply the inline picker: same day → open that night's modal (snap to nearest
  // real day if it's blank/absent); a real range → set the window.
  const applyPick = (startDay, endDay) => {
    setPick(null);
    if (startDay === endDay) { const j = nearestReal(dayToIdx(startDay)); if (j != null) setOpenIdx(j); return; }
    const lo = dayToIdx(startDay), hi = dayToIdx(endDay);
    changeWin([Math.min(lo, hi), Math.max(lo, hi)]);
  };

  // ---- Calendar-aligned windowing (Week = Mon–Sun, Month = 1st–last, Year =
  // Jan1–Dec31). Given a reference date, snap the window to the enclosing calendar
  // unit; unit stepping moves the reference by one unit. All in LOCAL time to
  // match the day calendar. ----
  const calBounds = (unit, ref) => {
    const d = new Date(ref + 'T00:00:00');
    let a, b;
    if (unit === 'week') {
      const dow = (d.getDay() + 6) % 7; // Mon=0
      a = new Date(d); a.setDate(d.getDate() - dow);
      b = new Date(a); b.setDate(a.getDate() + 6);
    } else if (unit === 'year') {
      a = new Date(d.getFullYear(), 0, 1);
      b = new Date(d.getFullYear(), 11, 31);
    } else {
      a = new Date(d.getFullYear(), d.getMonth(), 1);
      b = new Date(d.getFullYear(), d.getMonth() + 1, 0);
    }
    return [fmtDay(a), fmtDay(b)];
  };
  // Apply a nav unit: snap the window to the latest unit (anchored to lastDay for
  // rolling, or the calendar unit enclosing lastDay for cal), and record `gran`.
  const applyGran = g => {
    if (!data) return;
    const N = data.nights.length;
    if (g.type === 'roll') {
      setWin([Math.max(0, N - g.n), N - 1]);
    } else {
      const [a, b] = calBounds(g.unit, lastDay);
      setWin([dayToIdx(a), dayToIdx(b)]);
    }
    setRange(null);
    setGran(g);
  };
  // Step the active nav unit left/right (no-hover). Cal units move by one calendar
  // week/month (snapping); rolling units shift the fixed-length window by n days.
  const stepGran = dir => {
    if (!win || !data || !gran) return;
    const N = data.nights.length, [lo, hi] = win;
    if (gran.type === 'roll') {
      const span = hi - lo;
      let nlo = clamp(lo + dir * gran.n, 0, N - 1 - span);
      if (nlo === lo) return;
      setWin([nlo, nlo + span]);
    } else {
      const edge = new Date(data.nights[dir < 0 ? lo : hi].day + 'T00:00:00');
      let nref;
      if (gran.unit === 'week') { nref = new Date(edge); nref.setDate(edge.getDate() + dir * 7); }
      else if (gran.unit === 'year') nref = new Date(edge.getFullYear() + dir, 0, 1);
      else nref = new Date(edge.getFullYear(), edge.getMonth() + dir, 1);
      const [a, b] = calBounds(gran.unit, fmtDay(nref));
      const nlo = dayToIdx(a), nhi = dayToIdx(b);
      if (nlo === lo && nhi === hi) return;
      setWin([nlo, nhi]);
    }
    setRange(null);
  };
  const canGran = dir => {
    if (!win || !data || !gran) return false;
    const N = data.nights.length, [lo, hi] = win;
    if (gran.type === 'roll') return clamp(lo + dir * gran.n, 0, N - 1 - (hi - lo)) !== lo;
    if (gran.unit === 'week') { const r = new Date(data.nights[dir < 0 ? lo : hi].day + 'T00:00:00'); r.setDate(r.getDate() + dir * 7); const [a] = calBounds('week', fmtDay(r)); return dayToIdx(a) !== lo; }
    if (gran.unit === 'year') { const y = new Date(data.nights[dir < 0 ? lo : hi].day + 'T00:00:00'); const [a] = calBounds('year', fmtDay(new Date(y.getFullYear() + dir, 0, 1))); return dayToIdx(a) !== lo; }
    const m = new Date(data.nights[dir < 0 ? lo : hi].day + 'T00:00:00'); const r = new Date(m.getFullYear(), m.getMonth() + dir, 1); const [a] = calBounds('month', fmtDay(r)); return dayToIdx(a) !== lo;
  };

  // Coordinated hover surface: hovering anywhere over the charts' x-range (even the
  // gaps/whitespace between and around panels — including the whitespace in each
  // chart's title row) drives the shared night hover. Only the actual interactive
  // LEAF elements are respected (they clear the hover so their own hover/click still
  // works) — NOT the chart-title container (chartHead), whose empty space is exactly
  // the "gap" the user hovers. The ONE container we do exclude is the top page header
  // (headRow) — the Sleep title / stats / date-selector strip in the sticky region:
  // hovering anywhere in it should never drive the band.
  const scrollRef = useRef(null);
  const headRef = useRef(null);
  const RESPECT = `button, a, input, h2, h3, [class*="headRow"], [class*="info"], [class*="legendItem"], [class*="subLabel"], [class*="navWrap"], [class*="scrub"], [class*="modalOverlay"], [class*="pickPop"]`;
  const onXHover = e => {
    if (!win || !scrollRef.current) return;
    // Geometric guard: the entire top bar (its padding/borders and the gaps
    // between title / stats / controls) sits above headRow's bottom edge — bail
    // there regardless of the leaf under the cursor, so it never drives the band.
    if (headRef.current && e.clientY <= headRef.current.getBoundingClientRect().bottom) { setHover(null); return; }
    if (e.target.closest(RESPECT)) { setHover(null); return; }
    const [lo, hi] = win;
    const r = scrollRef.current.getBoundingClientRect();
    const cw = (r.width - padL - PAD_R) / (hi - lo + 1);
    if (cw <= 0) return;
    // Infer the source section from the nearest [data-section] ancestor (the gap
    // areas between charts have none → null, no group highlighted).
    const section = e.target.closest('[data-section]')?.dataset.section ?? null;
    setHover({ i: clamp(lo + Math.floor((e.clientX - r.left - padL) / cw), lo, hi), cx: e.clientX, cy: e.clientY, section });
  };
  // Companion to onXHover: clicking anywhere in the coordinated x-range (the gaps
  // between/around charts) opens that night — matching the hover surface. Charts
  // keep their own onClick (bail on any svg); the header and interactive leaves are
  // respected. Snaps off blank days via nearestReal.
  const onXClick = e => {
    if (!win || !scrollRef.current || !data) return;
    if (e.target.closest('svg')) return;
    if (headRef.current && e.clientY <= headRef.current.getBoundingClientRect().bottom) return;
    if (e.target.closest(RESPECT)) return;
    const [lo, hi] = win;
    const r = scrollRef.current.getBoundingClientRect();
    const cw = (r.width - padL - PAD_R) / (hi - lo + 1);
    if (cw <= 0) return;
    const j = nearestReal(clamp(lo + Math.floor((e.clientX - r.left - padL) / cw), lo, hi));
    if (j != null) setOpenIdx(j);
  };

  // Move the hover to the nearest night WITH data in a direction (+1 / -1),
  // skipping blank (gap-filled) days, clamped to the current window. Shared by
  // the arrow keys and the date stepper. Recomputes cx/cy from the same geometry
  // the hover surface uses so the tooltip stays anchored to the new column.
  const stepHover = dir => {
    if (!win || hover?.i == null || !data) return;
    const [lo, hi] = win;
    let j = hover.i + dir;
    while (j >= lo && j <= hi && data.nights[j]?.blank) j += dir;
    if (j < lo || j > hi) return;
    let cx = hover.cx, cy = hover.cy;
    const el = scrollRef.current;
    if (el) {
      const r = el.getBoundingClientRect();
      const cw = (r.width - padL - PAD_R) / (hi - lo + 1);
      if (cw > 0) cx = r.left + padL + (j - lo + 0.5) * cw;
    }
    setHover({ i: j, cx, cy, section: hover.section });
  };

  // No-hover mode: page the visible window left/right by its own span, keeping
  // the same length, clamped to [0, N-1]. Returns whether it moved.
  const pageWin = dir => {
    if (!win || !data) return;
    const N = data.nights.length, [lo, hi] = win, span = hi - lo;
    let nlo = lo + dir * (span + 1);
    nlo = clamp(nlo, 0, N - 1 - span);
    if (nlo === lo) return;
    setWin([nlo, nlo + span]);
    setRange(null);
  };

  // Move the open modal to the nearest night WITH data in a direction (+1 / -1),
  // skipping blank/gap days, clamped to the full dataset range.
  const stepOpen = dir => {
    if (openIdx == null || !data) return;
    const N = data.nights.length;
    let j = openIdx + dir;
    while (j >= 0 && j < N && data.nights[j]?.blank) j += dir;
    if (j < 0 || j >= N) return;
    setOpenIdx(j);
  };

  // Header stepper arrows share the keydown behavior: hovered → step the focused
  // date; no-hover → page the window. canPrev/canNext grey out a side when there's
  // no reachable target in that direction (window edge after skipping blanks, or
  // the data boundary when paging).
  const reachable = dir => {
    if (!win || !data) return false;
    const [lo, hi] = win;
    if (hover?.i != null) {
      let j = hover.i + dir;
      while (j >= lo && j <= hi && data.nights[j]?.blank) j += dir;
      return j >= lo && j <= hi;
    }
    if (gran) return canGran(dir);
    const N = data.nights.length, span = hi - lo;
    return clamp(lo + dir * (span + 1), 0, N - 1 - span) !== lo;
  };
  const stepUnit = dir => hover?.i != null ? stepHover(dir) : gran ? stepGran(dir) : pageWin(dir);
  const stepLeft = () => stepUnit(-1);
  const stepRight = () => stepUnit(1);
  const canPrev = reachable(-1);
  const canNext = reachable(1);

  // Arrow keys drive the stepper: hovered → step the focused date (skipping
  // blanks); no-hover → page the window. Disabled while a night modal is open
  // (openIdx != null) so arrows drive the modal instead — see NightModal.
  useEffect(() => {
    const onKey = e => {
      if (openIdx != null) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (hover?.i != null) { e.preventDefault(); stepHover(dir); }
      else if (win) { e.preventDefault(); gran ? stepGran(dir) : pageWin(dir); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, win, data, padL, openIdx, gran]);

  const napByDay = useMemo(() => {
    const m = {}; (data?.naps || []).forEach(p => { (m[p.day] = m[p.day] || []).push(p); }); return m;
  }, [data]);

  // Per nap-day: the 3 nights leading up to it, whether it followed a deficit.
  // Per nap-day: nap length + sleep debt = minutes under 7h summed over the 3
  // nights leading up to the nap. recovery = there was any debt to catch up on.
  const napDays = useMemo(() => {
    if (!data) return [];
    const idxOf = new Map(data.nights.map((n, i) => [n.day, i]));
    return Object.keys(napByDay).map(day => {
      const idx = idxOf.get(day); if (idx == null) return null;
      const debt = [idx - 2, idx - 1, idx].reduce((a, i) => {
        const v = data.nights[i]?.asleepEff; return a + (v == null ? 0 : Math.max(0, 420 - v));
      }, 0);
      return { day, idx, napLen: napByDay[day].reduce((a, p) => a + p.asleep, 0), debt, recovery: debt > 30 };
    }).filter(Boolean).sort((a, b) => a.idx - b.idx);
  }, [data, napByDay]);

  const summary = useMemo(() => {
    if (!data || !win) return null;
    const ns = data.nights.slice(win[0], win[1] + 1);
    const avg = f => { const v = ns.map(f).filter(x => x != null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };
    return {
      nights: ns.length, asleep: avg(d => d.asleepEff), eff: avg(d => d.eff), resp: avg(d => d.resp), deep: avg(d => d.deep),
      naps: ns.reduce((a, d) => a + (napByDay[d.day]?.length || 0), 0),
      from: fmtMon(ns[0].day), to: fmtMon(ns[ns.length - 1].day),
    };
  }, [data, win, napByDay]);

  if (error) return <main className={s.main}><div className={s.error}>Apple Health data unavailable: {error}</div></main>;
  if (!data) return <main className={s.main} />;
  if (!data.nights.length) {
    return (
      <main className={s.main}>
        <div className={s.headRow}><h2 className={shared.title}>Sleep</h2></div>
        <p className={s.intro}>No sleep data yet — ingest an <strong>export.zip</strong> from the <strong>Sync</strong> tab. Sleep stages come from the Apple Watch worn overnight, starting late 2021.</p>
      </main>
    );
  }


  return (
    <main className={s.main} onPointerMove={onXHover} onPointerLeave={() => setHover(null)} onClick={onXClick}>
      <div className={s.pinned}>
        <div className={s.headRow} ref={headRef}>
          <div className={s.headMain}>
            <div className={s.titleRow}>
              <h2 className={shared.title}>Sleep</h2>
              <InfoTip wide forceOpen={nux} onDismiss={dismissNux}>
                <strong>Welcome to Sleep.</strong> Every night since 2021 from the Apple Watch, shown in <strong>local time</strong> (travel normalized). Pick a range at top-right or drag the <strong>date selector's</strong> edges; hover any chart to inspect a night — every panel moves together.
              </InfoTip>
            </div>
            {summary && (
              <div className={s.stats}>
                <Stat value={summary.nights} label="nights" />
                <Stat value={hm(summary.asleep)} label="avg sleep" />
                <Stat value={summary.eff != null ? summary.eff.toFixed(1) : '—'} unit="%" label="efficiency" />
                <Stat value={summary.resp != null ? summary.resp.toFixed(1) : '—'} unit="br/min" label="avg resp" />
                <Stat value={hm(summary.deep)} label="deep / night" />
                <Stat value={summary.naps} label="naps" />
              </div>
            )}
          </div>
          <div className={s.headSel}>
            {win && data.nights.length > 0 && (() => {
              const hovered = hover?.i != null && data.nights[hover.i];
              let label, sub = null;
              if (hovered) {
                const d = data.nights[hover.i];
                label = new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
              } else {
                const a = new Date(data.nights[win[0]].day + 'T00:00:00'), b = new Date(data.nights[win[1]].day + 'T00:00:00');
                const sameYear = a.getFullYear() === b.getFullYear();
                const fa = a.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
                const fb = b.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
                label = `${fa} – ${fb}`;
              }
              const tip = hovered
                ? <>Use the <strong>← →</strong> arrow keys to step to the previous / next night with data.</>
                : <>Use the <strong>← →</strong> arrow keys to page the visible date range. Hover a night to step through individual dates instead.</>;
              return (
                <span className={s.stepWrap}>
                  <DateStepper label={label} sub={sub} onPrev={stepLeft} onNext={stepRight}
                    labelRef={pickBtnRef} onLabel={openPick}
                    onHoverOpen={openPick} onHoverClose={closePickSoon}
                    canPrev={canPrev} canNext={canNext} />
                  {pick && <RangePicker min={firstDay} max={lastDay} init={pick} anchorRef={pickBtnRef}
                    onApply={applyPick} activeRange={range} activeGran={gran}
                    onGran={g => { applyGran(g); setPick(null); }} onRange={(k, d) => { applyRange(k, d); setPick(null); }}
                    onMouseEnter={openPick} onMouseLeave={closePickSoon} hint={tip}
                    brush={<div className={s.pickBrush}><Navigator nights={data.nights} win={win} onWin={changeWin} /></div>} />}
                </span>
              );
            })()}
            {tuneEnabled && (
              <div className={s.chips}>
                <button className={`${s.chip} ${s.tunerToggle} ${tuner ? s.chipActive : ''}`}
                  onClick={() => setTuner(t => !t)} title="Color tuner (dev)" aria-label="Color tuner" aria-pressed={tuner}>
                  <span className={s.tunerToggleSwatch} />
                </button>
              </div>
            )}
          </div>
        </div>
        {tuneEnabled && tuner && <TunerPanel onClose={() => setTuner(false)} />}

        <div className={`${s.block} ${s.skyBlock}`} data-section="timing">
          <div className={s.chartHead}><h3 className={shared.title}>When You Slept</h3>
            <InfoTip>One column per night · y = <strong>clock time</strong> (bed top → wake bottom) · colored by stage · main sleep only. <strong>Click a night</strong> for its stage-by-stage hypnogram.</InfoTip>
            <Legend items={[
              { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <><strong>Deep</strong> sleep — colored band in each night's column at the clock time you were in this stage.</> },
              { glyph: 'square', color: STAGE.core, label: 'Core', tip: <><strong>Core</strong> (light) sleep — the bulk of most nights.</> },
              { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <><strong>REM</strong> — dreaming sleep, clustered toward morning.</> },
              { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Brief <strong>awakenings</strong> during the night.</> },
            ]} /></div>
          {win && <Skyline nights={data.nights} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} targets={targets} padL={padL} fill section="timing" />}
        </div>
      </div>

      <div className={s.scroller} ref={scrollRef}>
      <div className={s.block} data-section="stages">
        <div className={s.chartHead}><h3 className={shared.title}>Stage Composition</h3>
          <InfoTip>Per-night stage minutes over the selected range · stacked <strong>Deep / Core / REM / Awake</strong> · capped at 10h, longer nights overflow the top.{summary ? ` Showing ${summary.from} → ${summary.to}.` : ''}</InfoTip>
          <Legend items={[
            { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <>Minutes of <strong>Deep</strong> sleep, stacked bottom-to-top with Core, REM and Awake.</> },
            { glyph: 'square', color: STAGE.core, label: 'Core', tip: <>Minutes of <strong>Core</strong> (light) sleep in the stack.</> },
            { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <>Minutes of <strong>REM</strong> sleep in the stack.</> },
            { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Minutes <strong>awake</strong> during the night, on top of the stack.</> },
            { glyph: 'square', color: INBED_PRE, label: 'In bed · pre', tip: <>Time <strong>in bed before</strong> falling asleep (2021–24), a faded cap under the stack.</> },
            { glyph: 'square', color: INBED_POST, label: 'In bed · post', tip: <>Time <strong>in bed after</strong> waking (2021–24), a faded cap above the stack.</> },
          ]} /></div>
        {win && <Composition nights={data.nights} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} targets={targets} padL={padL} section="stages" />}
      </div>

      <div className={s.block} data-section="consistency">
        <div className={s.chartHead}><h3 className={shared.title}>Consistency</h3>
          <InfoTip>Minutes from your <strong>target</strong> (bed {targets.bedtime} · wake {targets.wake}), signed — <strong>below the line = earlier</strong>, above = later. Dots are each night; the line is the 14-night rolling average. Below, <strong>time in daylight</strong> the day before — a circadian <strong>input</strong> to getting to bed on time.</InfoTip>
          <Legend items={[
            { glyph: 'linedot', color: BED_TGT, label: 'Bedtime vs target', tip: <>Minutes your <strong>bedtime</strong> differed from target — a <strong>dot</strong> per night, the <strong>line</strong> is the 14-night average. Below 0 = earlier.</> },
            { glyph: 'linedot', color: WAKE_TGT, label: 'Wake vs target', tip: <>Minutes your <strong>wake time</strong> differed from target — dot per night, line = 14-night average.</> },
            { glyph: 'bar', color: DAYLIGHT, label: 'Daylight (prev day)', tip: <><strong>Time in daylight</strong> (min) the day <strong>before</strong> this night — a leading circadian <strong>input</strong> to bedtime. Watch-only; low values can also mean the Watch wasn't worn.</> },
          ]} /></div>
        {win && <Consistency nights={data.nights} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} targets={targets} padL={padL} section="consistency" />}
        {win && series && <div className={s.subChart}><SubLabel label="Time in daylight (previous day)" tip={<><strong>Time in daylight</strong> (min) accumulated the day <strong>before</strong> each night — the daytime that precedes that evening's bedtime, so it reads as a leading circadian <strong>input</strong>. Watch-only (from 2023-09); a low bar can mean little daylight <strong>or</strong> the Watch wasn't worn.</>} /><MiniChart nights={data.nights} win={win} valueAt={i => daylightByDay[data.nights[i].day] ?? null} color={DAYLIGHT} unit="min" label="Time in daylight (previous day)" type="bars" hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="consistency" /></div>}
      </div>

      <div className={s.block} data-section="recovery">
        <div className={s.chartHead}><h3 className={shared.title}>Recovery</h3>
          <InfoTip><strong>Nap length</strong> rises above the axis; <strong>sleep debt</strong> (3-night rolling shortfall under 7h) hangs below. <strong>Next-day HRV</strong> (HRV the night after), <strong>following-day resting HR</strong>, and daily <strong>training load</strong> are their own aligned charts — poor sleep or high load tends to drop next-day HRV and lift resting HR.</InfoTip>
          <Legend items={[
            { glyph: 'bar', color: NAP, label: 'Nap', tip: <><strong>Nap length</strong> that day, rising above the axis. Brighter = it followed a sleep deficit.</> },
            { glyph: 'bar', color: DEBT, label: 'Sleep debt', tip: <><strong>Sleep debt</strong> — 3-night rolling shortfall under 7h, hanging below the axis.</> },
            { glyph: 'box', color: HRV, label: 'Next-day HRV', tip: <>HRV the night <strong>after</strong> each day (ms). Box = middle 50%, whiskers = min–max, tick = median.</> },
            { glyph: 'bubble', color: RHR, label: 'Following-day RHR', tip: <>Apple's <strong>resting HR</strong> the day <strong>after</strong> each night (bpm) — bubble <strong>area</strong> ∝ value within the window. A rising resting HR flags under-recovery.</> },
            { glyph: 'bar', color: LOAD, label: 'Training load', tip: <>Daily <strong>active energy</strong> burned (kcal), as bars.</> },
          ]} /></div>
        {win && <div className={s.subChart}><SubLabel label="Naps & sleep debt" tip={<>A diverging chart on the shared date axis: <strong>nap length</strong> rises above the zero line (brighter = the nap followed a sleep deficit); <strong>sleep debt</strong> — the 3-night rolling shortfall under 7h — hangs below.</>} /><NapsPanel nights={data.nights} napDays={napDays} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="The morning after" tip={<>How the next day looked: <strong>next-day HRV</strong> (ms) as box-plots — box = middle 50%, whiskers = min–max, tick = median — with <strong>following-day resting HR</strong> (bpm) area-encoded as a bubble lane beneath (bubble <strong>area</strong> ∝ value within the window). Poor sleep tends to <strong>drop</strong> HRV and <strong>lift</strong> resting HR.</>} /><NextDayCombo nights={data.nights} win={win} hrvByDay={nextHrvByDay} rhrByDay={followRhrByDay} hrvColor={HRV} rhrColor={RHR} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Training load (active energy)" tip={<>Daily <strong>active energy</strong> burned (kcal) as bars — a proxy for <strong>training load</strong>, which can suppress the following night's recovery.</>} /><MiniChart nights={data.nights} win={win} valueAt={i => byDay.load[data.nights[i].day] ?? null} color={LOAD} unit="kcal" label="Training load (active energy)" type="bars" hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
      </div>

      <div className={s.block} data-section="respiration">
        <div className={s.chartHead}><h3 className={shared.title}>Respiration</h3>
          <InfoTip>Per-night <strong>respiratory rate</strong> box-plots (box = middle 50%, whiskers = min–max). The lower lanes' <strong>bubbles</strong> area-encode <strong>breathing disturbances</strong> (coral), <strong>brief &lt;10m wake-ups</strong> (orange), and <strong>full wake-up minutes</strong> (red — time in awakenings ≥10m). <strong>SpO₂</strong> has its own box-plot below.</InfoTip>
          <Legend items={[
            { glyph: 'box', color: RESP, label: 'Resp rate', tip: <>Overnight <strong>respiratory rate</strong> (br/min). Box = middle 50%, whiskers = min–max, tick = median.</> },
            { glyph: 'bubble', color: DIST, label: 'Disturbances', tip: <><strong>Breathing disturbances</strong> per night — bubble <strong>area</strong> encodes the count (2025-10+).</> },
            { glyph: 'bubble', color: STAGE.awake, label: 'Brief wake-ups', tip: <>Brief <strong>&lt;10-min wake-ups</strong> — bubble <strong>area</strong> encodes the count.</> },
            { glyph: 'bubble', color: FULLWAKE, label: 'Full wake mins', tip: <><strong>Full wake-up minutes</strong> — total time spent in awakenings <strong>≥10 min</strong>; bubble <strong>area</strong> encodes the minutes.</> },
            { glyph: 'box', color: SPO2, label: 'SpO₂', tip: <>Overnight <strong>blood-oxygen %</strong>. Box = middle 50%, whiskers = min–max, tick = median.</> },
          ]} /></div>
        {win && series && <div className={s.subChart}><SubLabel label="Respiratory rate" tip={<>Overnight <strong>respiratory rate</strong> (br/min) per night as box-plots — <strong>box</strong> = middle 50%, <strong>whiskers</strong> = min–max, <strong>tick</strong> = median. The lower lanes' <strong>bubbles</strong> area-encode breathing disturbances, brief &lt;10-min wake-ups, and full wake-up minutes.</>} /><RespirationChart nights={data.nights} win={win} respBy={byDay.resp} hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="respiration" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Blood oxygen (SpO₂)" tip={<>Overnight <strong>blood-oxygen %</strong> per night as box-plots — box = middle 50%, whiskers = min–max, tick = median. Sparse: only nights the Watch/iPhone recorded SpO₂ (ends 2025-10).</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.spo2} color={SPO2} unit="%" label="Blood oxygen (SpO₂)" hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} H={120} padL={padL} section="respiration" /></div>}
      </div>

      <div className={s.block} data-section="heart">
        <div className={s.chartHead}><h3 className={shared.title}>Heart Rate</h3>
          <InfoTip>Overnight distribution per night — box = middle 50%, whiskers = min–max, tick = median. Lower <strong>sleeping HR</strong> and higher <strong>HRV</strong> indicate better recovery.</InfoTip>
          <Legend items={[
            { glyph: 'box', color: HR, label: 'Sleeping HR', tip: <>Overnight <strong>heart rate</strong> (bpm). Box = middle 50%, whiskers = min–max, tick = median. Lower is better recovery.</> },
            { glyph: 'box', color: HRV, label: 'Overnight HRV', tip: <>Overnight <strong>HRV (SDNN, ms)</strong>. Box = middle 50%, whiskers = min–max, tick = median. Higher is better recovery.</> },
          ]} /></div>
        {win && series && <div className={s.subChart}><SubLabel label="Sleeping heart rate" tip={<>Overnight <strong>heart rate</strong> (bpm) per night as box-plots — box = middle 50%, whiskers = min–max, tick = median. A <strong>lower</strong> sleeping HR generally means better recovery.</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.hr} color={HR} unit="bpm" label="Sleeping heart rate" hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="heart" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Overnight HRV (SDNN)" tip={<>Overnight <strong>heart-rate variability</strong> (SDNN, ms) per night as box-plots — box = middle 50%, whiskers = min–max, tick = median. <strong>Higher</strong> HRV generally means better recovery.</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.hrv} color={HRV} unit="ms" label="Overnight HRV (SDNN)" hover={hover?.i ?? null} onHover={setHover} onOpen={setOpenIdx} padL={padL} section="heart" /></div>}
      </div>
      </div>

      {hover?.i != null && data.nights[hover.i]?.blank && (
        <div ref={tipRef} className={`${s.tip} ${s.tipBlank}`} style={{ left: hover.cx + 14, top: hover.cy + 14 }}>
          <b className={s.tipHead}>{new Date(data.nights[hover.i].day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })}</b>
          <div className={s.tipRow}><span style={{ color: 'var(--dim)' }}>no data</span></div>
        </div>
      )}

      {hover?.i != null && data.nights[hover.i] && !data.nights[hover.i].blank && (() => {
        const i = hover.i, d = data.nights[i], naps = napByDay[d.day] || [];
        const hrB = byDay.hr[d.day], hrvB = byDay.hrv[d.day], tib = (d.tibBefore || 0) + (d.tibAfter || 0);
        // Same derivations the modal's `extra` uses: 3-night rolling debt under 7h,
        // and the following night's overnight HRV median.
        let sum = 0, cnt = 0;
        for (const j of [i - 2, i - 1, i]) { const a = data.nights[j]?.asleepEff; if (a != null) { sum += Math.max(0, 420 - a); cnt++; } }
        const debt = cnt ? sum / cnt : 0;
        const nextHrv = byDay.hrv[data.nights[i + 1]?.day]?.med;
        const followRhr = followRhrByDay[d.day];
        const daylight = daylightByDay[d.day];
        const load = byDay.load[d.day];
        const bedD = d.bed - targets.bedMin, wakeD = d.wake - targets.wakeMin;
        const sgn = m => (m > 0 ? '+' : '') + Math.round(m);
        const sec = hover.section;
        // Emphasis, not hiding: the group matching the hovered chart gets a lighter
        // bounding box; the rest stay fully readable. The "When You Slept" skyline
        // (section 'timing') encodes BOTH stage colors and clock timing, so it lights
        // both the stages and timing groups.
        const stagesHot = sec === 'stages' || sec === 'timing';
        const timingHot = sec === 'timing' || sec === 'consistency';
        const grp = id => `${s.tipGroup}${sec === id ? ' ' + s.tipGroupHot : ''}`;
        const grpIf = hot => `${s.tipGroup}${hot ? ' ' + s.tipGroupHot : ''}`;
        // Per-stage spark swimlane: a tiny inline lane spanning bed→wake with this
        // stage's segments drawn as rects at their a→b positions.
        const span = Math.max(d.wake - d.bed, 1);
        const spark = st => {
          const segs = (d.segs || []).filter(g => g.st === st);
          const W = 96, H = 9;
          return (
            <svg className={s.tipStageSpark} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
              <rect x={0} y={0} width={W} height={H} fill="var(--panel)" opacity={0.5} />
              {segs.map((g, j) => {
                const x = ((g.a - d.bed) / span) * W;
                const w = Math.max(((g.b - g.a) / span) * W, 0.6);
                return <rect key={j} x={x} y={0} width={w} height={H} fill={STAGE[st]} opacity={0.9} />;
              })}
            </svg>
          );
        };
        const stageRow = st => (
          <div className={s.tipStageRow}>
            <span className={s.tipStageName}><span className={s.tipDot} style={{ background: STAGE[st] }} />{st}</span>
            {spark(st)}
            <span className={s.tipStageTime}>{hm(d[st])}</span>
          </div>
        );
        const timingGroup = (
          <div className={grpIf(timingHot)}>
            <div className={s.tipGroupLabel}>timing</div>
            <div className={s.tipRow}><span>bed</span><span>{clock(d.bed)}</span></div>
            <div className={s.tipRow}><span>wake</span><span>{clock(d.wake)}</span></div>
            {tib > 0 && <div className={s.tipRow}><span>in bed pre/post</span><span>{d.tibBefore}m / {d.tibAfter}m</span></div>}
            <div className={s.tipRow}><span>bed vs target</span><span>{sgn(bedD)}m</span></div>
            <div className={s.tipRow}><span>wake vs target</span><span>{sgn(wakeD)}m</span></div>
            {daylight != null && <div className={s.tipRow}><span>daylight (prev day)</span><span>{hm(daylight)}</span></div>}
          </div>
        );
        const respGroup = (d.resp || d.spo2 || d.dist != null) && (
          <div className={grp('respiration')}>
            <div className={s.tipGroupLabel}>respiration</div>
            {d.resp && <div className={s.tipRow}><span>resp rate</span><span>{d.resp.toFixed(1)} br/min</span></div>}
            <div className={s.tipRow}><span>SpO₂</span><span>{d.spo2 ? `${d.spo2.toFixed(0)}%` : '—'}</span></div>
            {d.dist != null && <div className={s.tipRow}><span>breathing dist.</span><span>{d.dist.toFixed(1)}</span></div>}
            <div className={s.tipRow}><span>wakes (b/f)</span><span>{d.briefWakes} / {d.wakeCount}</span></div>
            {d.fullWakeMin > 0 && <div className={s.tipRow}><span>full wake mins</span><span>{hm(d.fullWakeMin)}</span></div>}
          </div>
        );
        const heartGroup = (hrB || hrvB) && (
          <div className={grp('heart')}>
            <div className={s.tipGroupLabel}>heart rate</div>
            {hrB && <div className={s.tipRow}><span>sleeping HR</span><span>{hrB.med} · {hrB.lo}–{hrB.hi}</span></div>}
            {hrvB && <div className={s.tipRow}><span>overnight HRV</span><span>{hrvB.med} ms</span></div>}
          </div>
        );
        const recoveryGroup = (naps.length > 0 || debt > 0.5 || nextHrv != null || followRhr != null || load != null) && (
          <div className={grp('recovery')}>
            <div className={s.tipGroupLabel}>recovery</div>
            {naps.length > 0 && <div className={s.tipRow}><span>{naps.length > 1 ? 'naps' : 'nap'}</span><span>{naps.map(p => hm(p.asleep)).join(', ')}</span></div>}
            {debt > 0.5 && <div className={s.tipRow}><span>sleep debt</span><span>{hm(debt)}</span></div>}
            {nextHrv != null && <div className={s.tipRow}><span>next-day HRV</span><span>{nextHrv} ms</span></div>}
            {followRhr != null && <div className={s.tipRow}><span>next-day RHR</span><span>{followRhr} bpm</span></div>}
            {load != null && <div className={s.tipRow}><span>training load</span><span>{Math.round(load).toLocaleString()} kcal</span></div>}
          </div>
        );
        return (
          <div ref={tipRef} className={s.tip} style={{ left: hover.cx + 14, top: hover.cy + 14 }}>
            <div className={s.tipHeadRow}>
              <b className={s.tipHead}>{new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })}</b>
              <span className={s.tipSourceTop}>{srcLabel(d.source)}</span>
            </div>
            <div className={s.tipHero}>
              <span><span className={s.tipHeroVal}>{hm(d.asleepEff)}</span><span className={s.tipHeroLbl}>asleep</span></span>
              <span><span className={s.tipHeroVal}>{d.eff == null ? '—' : `${d.eff}%`}</span><span className={s.tipHeroLbl}>efficiency</span></span>
            </div>

            <div className={`${grpIf(stagesHot)} ${s.tipStages}`}>
              <div className={s.tipGroupLabel}>stages</div>
              {stageRow('deep')}
              {stageRow('core')}
              {stageRow('rem')}
              {stageRow('awake')}
            </div>

            <div className={s.tipGrid}>
              <div className={s.tipCol}>
                {timingGroup}
                {heartGroup}
              </div>
              <div className={s.tipCol}>
                {respGroup}
                {recoveryGroup}
              </div>
            </div>
          </div>
        );
      })()}

      {openIdx != null && data.nights[openIdx] && !data.nights[openIdx].blank && (() => {
        const i = openIdx, d = data.nights[i];
        let sum = 0, cnt = 0;
        for (const j of [i - 2, i - 1, i]) { const a = data.nights[j]?.asleepEff; if (a != null) { sum += Math.max(0, 420 - a); cnt++; } }
        const beds = [], wakes = [];
        for (let j = Math.max(0, i - 13); j <= i; j++) { if (data.nights[j].blank) continue; beds.push(data.nights[j].bed); wakes.push(data.nights[j].wake); }
        const extra = {
          debt: cnt ? sum / cnt : 0, load: byDay.load[d.day], nextHrv: byDay.hrv[data.nights[i + 1]?.day]?.med,
          bedStd: std(beds), wakeStd: std(wakes),
          hr: byDay.hr[d.day], hrv: byDay.hrv[d.day], resp: byDay.resp[d.day], spo2: byDay.spo2[d.day], targets,
        };
        return <NightModal night={d} naps={napByDay[d.day] || []} extra={extra} onClose={() => setOpenIdx(null)} onStep={stepOpen}
          min={firstDay} max={lastDay} onPickDate={day => { const j = nearestReal(dayToIdx(day)); if (j != null) setOpenIdx(j); }} />;
      })()}
    </main>
  );
}
