import { useState, useEffect, useRef } from 'react';

export const PAD_L = 38;   // fallback left gutter. The real value (padL) is measured from the
export const PAD_R = 0;    // widest y-axis label present in the data and shared across the
                    // aligned date charts so they line up. Right side is full-bleed.

// Measure a label's rendered width so the left gutter can be sized to exactly the
// widest tick that will appear — no wasted space, no clipping. Uses an offscreen
// SVG <text> and getComputedTextLength so measurement goes through the real font
// engine (IBM Plex Mono), matching how the axis labels actually render — a canvas
// measureText silently falls back to a narrower generic font and under-measures.
export let _measSvg, _measText;
// getComputedTextLength() forces a synchronous layout, and the axis code asks for
// the same handful of labels on every hover — so results are cached by text+size.
const _measCache = new Map();
export function labelWidth(str, px = 10) {
  const t = String(str);
  if (typeof document === 'undefined') return t.length * px * 0.6;
  const key = `${px}|${t}`;
  const hit = _measCache.get(key);
  if (hit !== undefined) return hit;
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
  const width = _measText.getComputedTextLength();
  _measCache.set(key, width);
  return width;
}
// Web fonts land after first paint, so widths measured against the fallback are
// stale; Sleep clears the cache once document.fonts is ready.
export const clearLabelWidthCache = () => _measCache.clear();
export const srcLabel = src => !src ? '—' : /watch/i.test(src) ? 'Apple Watch' : /iphone/i.test(src) ? 'iPhone' : /withings/i.test(src) ? 'Withings' : src;
export const CAP_MIN = 600; // stage-composition y-axis caps at 10h; longer nights overflow
export const RANGES = [['90d', 90], ['1yr', 365], ['All', null]];
// Navigation units. Calendar-aligned (W/M/YR) snap to Mon–Sun / 1st–last / Jan1–Dec31
// and the ‹ › arrows move one calendar unit; rolling (7D/30D/1YR) are fixed-length
// windows the arrows shift by n days. Grouped so the segmented control can rule
// between the calendar-snap and rolling families.
export const UNITS_CAL = [['W', { type: 'cal', unit: 'week' }], ['M', { type: 'cal', unit: 'month' }], ['YR', { type: 'cal', unit: 'year' }]];
export const UNITS_ROLL = [['7D', { type: 'roll', n: 7 }], ['30D', { type: 'roll', n: 30 }], ['1YR', { type: 'roll', n: 365 }]];
export const UNITS = [...UNITS_CAL, ...UNITS_ROLL];
// Clock positions are anchored minutes-after-6pm (0 = 6pm, 360 = midnight,
// 720 = 6am, 1080 = noon), matching scripts/sleepSessions.cjs (local wall time).
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const wall = m => ((m % 1440) + 1440 + 1080) % 1440;
export const clock = m => {
  const w = wall(m), h = Math.floor(w / 60), mm = w % 60;
  const ap = h < 12 ? 'a' : 'p', h12 = h % 12 === 0 ? 12 : h % 12;
  return mm === 0 ? `${h12}${ap}` : `${h12}:${String(mm).padStart(2, '0')}${ap}`;
};
export const clockWall = w => { const h = Math.floor(w / 60), ap = h < 12 ? 'a' : 'p', h12 = h % 12 === 0 ? 12 : h % 12; return `${h12}${ap}`; };
export const hm = v => v == null ? '—' : `${Math.floor(v / 60)}h ${Math.round(v % 60)}m`;
export const pctl = (arr, p) => { const a = [...arr].sort((x, y) => x - y); return a[clamp(Math.floor(p * a.length), 0, a.length - 1)]; };
export const fmtMon = day => new Date(day + 'T00:00:00').toLocaleDateString('en', { month: 'short', year: '2-digit' });
export const fmtShort = day => new Date(day + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' });
// Expand a data-only nights array (missing calendar days dropped) into a
// CONTINUOUS daily calendar from the first to last day, inserting placeholder
// { day, blank: true } entries for days with no data. Real nights pass through
// unchanged. Dates are built/formatted in LOCAL time to avoid TZ date shifts.
export const fmtDay = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
export function fillNightGaps(nights) {
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
export const std = arr => { if (arr.length < 2) return null; const m = arr.reduce((a, b) => a + b, 0) / arr.length; return Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length); };
// ~n round gridline values spanning [min,max].
export function niceTicks(min, max, n = 3) {
  const span = max - min; if (span <= 0) return [Math.round(min)];
  const mag = Math.pow(10, Math.floor(Math.log10(span / n)));
  const step = [1, 2, 2.5, 5, 10].map(x => x * mag).find(x => x >= span / n) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(min / step) * step; v <= max; v += step) out.push(Math.round(v * 10) / 10);
  return out;
}

export function useMeasure() {
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
export function timeTicks(nights, lo, hi, plotW) {
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

