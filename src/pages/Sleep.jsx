import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getHealthSleep, getHealthSleepSeries } from '../api.js';
import shared from '../styles/shared.module.css';
import s from './Sleep.module.css';
import {
  STAGE, INBED_PRE, INBED_POST, RESP, SPO2, DIST, FULLWAKE, HR, HRV, NAP, DEBT, LOAD, RHR, DAYLIGHT, BED_TGT, WAKE_TGT,
  applyTunerState,
} from './sleep/palette.js';
import TunerPanel from './sleep/TunerPanel.jsx';

import { PAD_R, labelWidth, clearLabelWidthCache, srcLabel, clamp, clock, hm, fmtMon, fmtDay, fillNightGaps, std } from './sleep/helpers.js';
import { HoverProvider, useHoverStore, useHoverTarget } from './sleep/hoverStore.jsx';
import { HoverTooltip } from './sleep/HoverTooltip.jsx';
import { InfoTip, DateStepper, RangePicker } from './sleep/pickers.jsx';
import { Legend, SubLabel } from './sleep/Legend.jsx';
import { Navigator, Composition, Skyline, NapsPanel, BoxSeries, NextDayCombo, RespirationChart, Consistency, MiniChart, Stat } from './sleep/charts.jsx';
import { NightModal } from './sleep/NightModal.jsx';

// Format ISO day strings for copy (slice, no Date() → no timezone drift).
const ym = d => d && d.slice(0, 7);                     // "2023-09"
const yrRange = (a, b) => !a ? null : a.slice(0, 4) === b.slice(0, 4) ? a.slice(0, 4) : `${a.slice(0, 4)}–${b.slice(2, 4)}`;

// The date readout, its ‹ › arrows and their enabled state all depend on which
// night is hovered. Subscribing here rather than in Sleep keeps a pointer move
// from re-rendering the page (and re-running every chart body) — at the "All"
// range every pixel is a different night, so that ran on every single move.
function HeaderSelector({ nights, win, reachable, stepUnit, pickBtnRef, openPick, closePickSoon,
  pick, setPick, firstDay, lastDay, applyPick, range, gran, applyGran, applyRange, changeWin }) {
  const { i } = useHoverTarget();
  // A hover published a frame before the window changed can name a night that is
  // no longer on screen; the column bands already ignore those, so ignore them here.
  const hovered = i != null && i >= win[0] && i <= win[1] && nights[i];
  let label;
  if (hovered) {
    label = new Date(nights[i].day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  } else {
    const a = new Date(nights[win[0]].day + 'T00:00:00'), b = new Date(nights[win[1]].day + 'T00:00:00');
    const sameYear = a.getFullYear() === b.getFullYear();
    const fa = a.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
    const fb = b.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
    label = `${fa} – ${fb}`;
  }
  const tip = hovered
    ? <>Press <strong>← →</strong> to jump to the previous or next night with data.</>
    : <>Press <strong>← →</strong> to page the date range. Hover a night to step one date at a time instead.</>;
  const hoverIdx = hovered ? i : null;
  return (
    <span className={s.stepWrap}>
      <DateStepper label={label} sub={null} onPrev={() => stepUnit(-1, hoverIdx)} onNext={() => stepUnit(1, hoverIdx)}
        labelRef={pickBtnRef} onLabel={openPick}
        onHoverOpen={openPick} onHoverClose={closePickSoon}
        canPrev={reachable(-1, hoverIdx)} canNext={reachable(1, hoverIdx)} />
      {pick && <RangePicker min={firstDay} max={lastDay} init={pick} anchorRef={pickBtnRef}
        onApply={applyPick} activeRange={range} activeGran={gran}
        onGran={g => { applyGran(g); setPick(null); }} onRange={(k, d) => { applyRange(k, d); setPick(null); }}
        onMouseEnter={openPick} onMouseLeave={closePickSoon} hint={tip}
        brush={<div className={s.pickBrush}><Navigator nights={nights} win={win} onWin={changeWin} /></div>} />}
    </span>
  );
}

export default function Sleep() {
  return <HoverProvider><SleepView /></HoverProvider>;
}

function SleepView() {
  const store = useHoverStore();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [win, setWin] = useState(null);
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
  useEffect(() => { document.fonts?.ready?.then(() => { clearLabelWidthCache(); setFontsReady(true); }); }, []);
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
  // Rebuilt every render, this object invalidated Consistency's delta/rolling
  // memos — which walk all ~1,800 nights with a 14-night inner loop — on every
  // single pointer move. Memoized so they recompute only when targets change.
  const targets = useMemo(
    () => ({ deepMin: 60, deepMax: 110, ...(data?.targets || { asleepMin: 420, bedMin: 420, wakeMin: 840, asleepHours: 7, bedtime: '01:00', wake: '08:00' }) }),
    [data]);

  // Per-metric coverage windows, computed from the data so copy never hardcodes
  // dates (each Watch metric came online at a different time).
  const coverage = useMemo(() => {
    if (!data?.nights?.length) return null;
    const N = data.nights;
    const span = pred => { const ds = N.filter(pred).map(n => n.day); return ds.length ? [ds[0], ds[ds.length - 1]] : null; };
    const inbed = span(n => n.tibBefore != null || n.tibAfter != null);
    const dist = span(n => n.dist != null);
    const dl = series?.daylight || [], sp = series?.spo2 || [];
    return {
      startYear: N[0].day.slice(0, 4),
      inbed: inbed && yrRange(inbed[0], inbed[1]),
      distStart: dist && ym(dist[0]),
      daylightStart: dl.length ? ym(dl[0].day) : null,
      spo2End: sp.length ? ym(sp[sp.length - 1].night) : null,
    };
  }, [data, series]);

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
  // Cached geometry: both getBoundingClientRect() calls below used to run on every
  // pointer move, forcing a synchronous layout of a document holding tens of
  // thousands of SVG nodes. The rects only change on scroll/resize, so they're
  // cached and invalidated by those events instead.
  const rects = useRef(null);
  const invalidateRects = () => { rects.current = null; };
  useEffect(() => {
    window.addEventListener('resize', invalidateRects);
    window.addEventListener('scroll', invalidateRects, true);
    return () => {
      window.removeEventListener('resize', invalidateRects);
      window.removeEventListener('scroll', invalidateRects, true);
    };
  }, []);
  useEffect(invalidateRects, [win, padL, data, series, openIdx, pick, tuner, fontsReady, nux]);
  const geom = () => {
    if (!rects.current && scrollRef.current) {
      rects.current = {
        scroll: scrollRef.current.getBoundingClientRect(),
        headBottom: headRef.current ? headRef.current.getBoundingClientRect().bottom : 0,
      };
    }
    return rects.current;
  };

  // Pointer moves arrive faster than a frame; only the last one in a frame can
  // matter, so they're coalesced into a single rAF-published hover update.
  const hoverRaf = useRef(0), hoverNext = useRef(null);
  // Stable identity: every chart is memo()'d on it, so an inline arrow here would
  // silently defeat all of them.
  const publishHover = useCallback(h => {
    hoverNext.current = h;
    if (hoverRaf.current) return;
    hoverRaf.current = requestAnimationFrame(() => { hoverRaf.current = 0; store.setHover(hoverNext.current); });
  }, [store]);
  useEffect(() => () => { if (hoverRaf.current) cancelAnimationFrame(hoverRaf.current); }, []);

  const onXHover = e => {
    if (!win || !scrollRef.current) return;
    const g = geom();
    if (!g) return;
    // Geometric guard: the entire top bar (its padding/borders and the gaps
    // between title / stats / controls) sits above headRow's bottom edge — bail
    // there regardless of the leaf under the cursor, so it never drives the band.
    if (e.clientY <= g.headBottom) { publishHover(null); return; }
    if (e.target.closest(RESPECT)) { publishHover(null); return; }
    const [lo, hi] = win;
    const r = g.scroll;
    const cw = (r.width - padL - PAD_R) / (hi - lo + 1);
    if (cw <= 0) return;
    // Infer the source section from the nearest [data-section] ancestor (the gap
    // areas between charts have none → null, no group highlighted).
    const section = e.target.closest('[data-section]')?.dataset.section ?? null;
    publishHover({ i: clamp(lo + Math.floor((e.clientX - r.left - padL) / cw), lo, hi), cx: e.clientX, cy: e.clientY, section });
  };
  // Companion to onXHover: clicking anywhere in the coordinated x-range (the gaps
  // between/around charts) opens that night — matching the hover surface. Charts
  // keep their own onClick (bail on any svg); the header and interactive leaves are
  // respected. Snaps off blank days via nearestReal.
  const onXClick = e => {
    if (!win || !scrollRef.current || !data) return;
    if (e.target.closest('svg')) return;
    const g = geom();
    if (!g) return;
    if (e.clientY <= g.headBottom) return;
    if (e.target.closest(RESPECT)) return;
    const [lo, hi] = win;
    const r = g.scroll;
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
    const hover = store.getHover();
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
    store.setHover({ i: j, cx, cy, section: hover.section });
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
  const reachable = (dir, hoverIdx) => {
    if (!win || !data) return false;
    const [lo, hi] = win;
    if (hoverIdx != null) {
      let j = hoverIdx + dir;
      while (j >= lo && j <= hi && data.nights[j]?.blank) j += dir;
      return j >= lo && j <= hi;
    }
    if (gran) return canGran(dir);
    const N = data.nights.length, span = hi - lo;
    return clamp(lo + dir * (span + 1), 0, N - 1 - span) !== lo;
  };
  const stepUnit = (dir, hoverIdx) => hoverIdx != null ? stepHover(dir) : gran ? stepGran(dir) : pageWin(dir);

  // Arrow keys drive the stepper: hovered → step the focused date (skipping
  // blanks); no-hover → page the window. Disabled while a night modal is open
  // (openIdx != null) so arrows drive the modal instead — see NightModal.
  useEffect(() => {
    const onKey = e => {
      if (openIdx != null) return;
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (store.getHover()?.i != null) { e.preventDefault(); stepHover(dir); }
      else if (win) { e.preventDefault(); gran ? stepGran(dir) : pageWin(dir); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [win, data, padL, openIdx, gran]);

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

  if (error) return <main className={s.main}><div className={s.error}>Couldn't load your Apple Health data: {error}</div></main>;
  if (!data) return <main className={s.main} />;
  if (!data.nights.length) {
    return (
      <main className={s.main}>
        <div className={s.headRow}><h2 className={shared.title}>Sleep</h2></div>
        <p className={s.intro}>No sleep data yet. Import an <strong>export.zip</strong> from the <strong>Sync</strong> tab to load it. Stage data goes back to whenever the Apple Watch was first worn overnight.</p>
      </main>
    );
  }


  return (
    <main className={s.main} onPointerMove={onXHover} onPointerLeave={() => publishHover(null)} onClick={onXClick}>
      <div className={s.pinned}>
        <div className={s.headRow} ref={headRef}>
          <div className={s.headMain}>
            <div className={s.titleRow}>
              <h2 className={shared.title}>Sleep</h2>
              <InfoTip wide forceOpen={nux} onDismiss={dismissNux}>
                <strong>Welcome to Sleep.</strong> Every night since {coverage.startYear}, recorded by the Apple Watch and shown in <strong>local time</strong> (so travel doesn't skew it). Set a range at the top right, or drag the edges of the <strong>date selector</strong>. Hover any chart to inspect a single night; all the panels move together.
              </InfoTip>
            </div>
            {summary && (
              <div className={s.stats}>
                <Stat value={summary.nights} label="nights" />
                <Stat value={hm(summary.asleep)} label="avg asleep" />
                <Stat value={summary.eff != null ? summary.eff.toFixed(1) : '—'} unit="%" label="avg efficiency" />
                <Stat value={summary.resp != null ? summary.resp.toFixed(1) : '—'} unit="br/min" label="avg breathing" />
                <Stat value={hm(summary.deep)} label="deep / night" />
                <Stat value={summary.naps} label="naps" />
              </div>
            )}
          </div>
          <div className={s.headSel}>
            {win && data.nights.length > 0 && (
              <HeaderSelector nights={data.nights} win={win} reachable={reachable} stepUnit={stepUnit}
                pickBtnRef={pickBtnRef} openPick={openPick} closePickSoon={closePickSoon}
                pick={pick} setPick={setPick} firstDay={firstDay} lastDay={lastDay}
                applyPick={applyPick} range={range} gran={gran} applyGran={applyGran}
                applyRange={applyRange} changeWin={changeWin} />
            )}
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
            <InfoTip>One column per night. The y-axis is <strong>clock time</strong> (bedtime at the top, wake at the bottom), colored by stage. Main sleep only. <strong>Click a night</strong> to open its full hypnogram.</InfoTip>
            <Legend items={[
              { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <><strong>Deep</strong> sleep. Each band sits at the clock time you were in this stage.</> },
              { glyph: 'square', color: STAGE.core, label: 'Core', tip: <><strong>Core</strong> (light) sleep. Most of a typical night.</> },
              { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <><strong>REM</strong>, the dreaming stage. Tends to cluster toward morning.</> },
              { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Moments you woke up during the night.</> },
            ]} /></div>
          {win && <Skyline nights={data.nights} win={win} onHover={publishHover} onOpen={setOpenIdx} targets={targets} padL={padL} fill section="timing" />}
        </div>
      </div>

      <div className={s.scroller} ref={scrollRef}>
      <div className={s.block} data-section="stages">
        <div className={s.chartHead}><h3 className={shared.title}>Stage Composition</h3>
          <InfoTip>How each night breaks down by stage. One bar per night, stacking <strong>Deep / Core / REM / Awake</strong> minutes. The axis caps at 10h; taller nights spill over the top.{summary ? ` Showing ${summary.from} → ${summary.to}.` : ''}</InfoTip>
          <Legend items={[
            { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <>Minutes of <strong>Deep</strong> sleep, at the bottom of the stack.</> },
            { glyph: 'square', color: STAGE.core, label: 'Core', tip: <>Minutes of <strong>Core</strong> (light) sleep in the stack.</> },
            { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <>Minutes of <strong>REM</strong> sleep in the stack.</> },
            { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Minutes spent <strong>awake</strong>, at the top of the stack.</> },
            { glyph: 'square', color: INBED_PRE, label: 'In bed · pre', tip: <>Time in bed <strong>before</strong> you fell asleep{coverage.inbed ? ` (${coverage.inbed})` : ''}. Faded cap below the stack.</> },
            { glyph: 'square', color: INBED_POST, label: 'In bed · post', tip: <>Time in bed <strong>after</strong> you woke{coverage.inbed ? ` (${coverage.inbed})` : ''}. Faded cap above the stack.</> },
          ]} /></div>
        {win && <Composition nights={data.nights} win={win} onHover={publishHover} onOpen={setOpenIdx} targets={targets} padL={padL} section="stages" />}
      </div>

      <div className={s.block} data-section="consistency">
        <div className={s.chartHead}><h3 className={shared.title}>Consistency</h3>
          <InfoTip>How far each night ran from your <strong>target</strong> (bed {targets.bedtime}, wake {targets.wake}), in minutes. <strong>Below the line is earlier</strong> than target, above is later. Each dot is one night; the line is a 14-night rolling average. The bars below show <strong>time in daylight</strong> the day before, which nudges when you get to bed.</InfoTip>
          <Legend items={[
            { glyph: 'linedot', color: BED_TGT, label: 'Bedtime vs target', tip: <>How many minutes your <strong>bedtime</strong> ran off target. One <strong>dot</strong> per night; the <strong>line</strong> is the 14-night average. Below 0 means earlier.</> },
            { glyph: 'linedot', color: WAKE_TGT, label: 'Wake vs target', tip: <>How many minutes your <strong>wake time</strong> ran off target. One dot per night; line is the 14-night average.</> },
            { glyph: 'bar', color: DAYLIGHT, label: 'Daylight (prev day)', tip: <><strong>Time in daylight</strong> (min) the day <strong>before</strong> this night, which feeds into your body clock and bedtime. Watch-only, so a low bar can also mean the Watch was off your wrist.</> },
          ]} /></div>
        {win && <Consistency nights={data.nights} win={win} onHover={publishHover} onOpen={setOpenIdx} targets={targets} padL={padL} section="consistency" />}
        {win && series && <div className={s.subChart}><SubLabel label="Time in daylight (previous day)" tip={<><strong>Time in daylight</strong> (min) racked up the day <strong>before</strong> each night, so it lines up as the daytime that leads into that evening's bedtime. Watch-only{coverage.daylightStart ? ` (from ${coverage.daylightStart})` : ''}; a low bar can mean little daylight <strong>or</strong> that the Watch was off.</>} /><MiniChart nights={data.nights} win={win} valueAt={i => daylightByDay[data.nights[i].day] ?? null} color={DAYLIGHT} unit="min" label="Time in daylight (previous day)" type="bars" onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="consistency" /></div>}
      </div>

      <div className={s.block} data-section="recovery">
        <div className={s.chartHead}><h3 className={shared.title}>Recovery</h3>
          <InfoTip><strong>Nap length</strong> rises above the axis; <strong>sleep debt</strong> (how far the last 3 nights fell under 7h) hangs below. The charts under it track how your body responds: <strong>HRV the next night</strong>, <strong>resting HR the next day</strong>, and daily <strong>training load</strong>. A rough night or a hard workout usually drops the next day's HRV and raises resting HR.</InfoTip>
          <Legend items={[
            { glyph: 'bar', color: NAP, label: 'Nap', tip: <>How long you <strong>napped</strong> that day, rising above the axis. Brighter means the nap followed a sleep deficit.</> },
            { glyph: 'bar', color: DEBT, label: 'Sleep debt', tip: <><strong>Sleep debt</strong>: how far the last 3 nights fell short of 7h, hanging below the axis.</> },
            { glyph: 'box', color: HRV, label: 'Next-day HRV', tip: <>HRV the night <strong>after</strong> each day (ms). Box is the middle 50%, whiskers are min–max, tick is the median.</> },
            { glyph: 'bubble', color: RHR, label: 'Following-day RHR', tip: <>Apple's <strong>resting HR</strong> the day <strong>after</strong> each night (bpm). Bubble <strong>area</strong> scales with the value across the window. A rising resting HR points to poor recovery.</> },
            { glyph: 'bar', color: LOAD, label: 'Training load', tip: <><strong>Active energy</strong> burned that day (kcal), drawn as bars.</> },
          ]} /></div>
        {win && <div className={s.subChart}><SubLabel label="Naps & sleep debt" tip={<>Two series meeting at a zero line. <strong>Nap length</strong> rises above it (brighter if the nap followed a sleep deficit); <strong>sleep debt</strong> — how far the last 3 nights fell under 7h — hangs below.</>} /><NapsPanel nights={data.nights} napDays={napDays} win={win} onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="The morning after" tip={<>How your body looked the next day. <strong>Next-day HRV</strong> (ms) as box-plots — box is the middle 50%, whiskers are min–max, tick is the median — with <strong>next-day resting HR</strong> (bpm) as the bubble lane beneath (bubble <strong>area</strong> scales with the value across the window). A rough night usually <strong>drops</strong> HRV and <strong>raises</strong> resting HR.</>} /><NextDayCombo nights={data.nights} win={win} hrvByDay={nextHrvByDay} rhrByDay={followRhrByDay} hrvColor={HRV} rhrColor={RHR} onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Training load (active energy)" tip={<>Daily <strong>active energy</strong> burned (kcal) as bars, a stand-in for <strong>training load</strong>. A heavy day can eat into the next night's recovery.</>} /><MiniChart nights={data.nights} win={win} valueAt={i => byDay.load[data.nights[i].day] ?? null} color={LOAD} unit="kcal" label="Training load (active energy)" type="bars" onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="recovery" /></div>}
      </div>

      <div className={s.block} data-section="respiration">
        <div className={s.chartHead}><h3 className={shared.title}>Respiration</h3>
          <InfoTip>Each night's <strong>breathing rate</strong> as a box-plot (box is the middle 50%, whiskers are min–max). The lanes underneath size their <strong>bubbles</strong> by count: <strong>breathing disturbances</strong> (coral), <strong>brief wake-ups under 10 min</strong> (orange), and <strong>time awake in stretches of 10 min or more</strong> (red). <strong>SpO₂</strong> gets its own box-plot below.</InfoTip>
          <Legend items={[
            { glyph: 'box', color: RESP, label: 'Resp rate', tip: <>Overnight <strong>breathing rate</strong> (breaths/min). Box is the middle 50%, whiskers are min–max, tick is the median.</> },
            { glyph: 'bubble', color: DIST, label: 'Disturbances', tip: <><strong>Breathing disturbances</strong> flagged that night. Bigger bubble means more{coverage.distStart ? ` (from ${coverage.distStart})` : ''}.</> },
            { glyph: 'bubble', color: STAGE.awake, label: 'Brief wake-ups', tip: <>Wake-ups <strong>under 10 min</strong>. Bigger bubble means more of them.</> },
            { glyph: 'bubble', color: FULLWAKE, label: 'Full wake mins', tip: <>Total minutes awake in stretches of <strong>10 min or more</strong>. Bigger bubble means more time awake.</> },
            { glyph: 'box', color: SPO2, label: 'SpO₂', tip: <>Overnight <strong>blood-oxygen %</strong>. Box is the middle 50%, whiskers are min–max, tick is the median.</> },
          ]} /></div>
        {win && series && <div className={s.subChart}><SubLabel label="Respiratory rate" tip={<>Each night's <strong>breathing rate</strong> (breaths/min) as a box-plot — <strong>box</strong> is the middle 50%, <strong>whiskers</strong> are min–max, <strong>tick</strong> is the median. The lanes below size their <strong>bubbles</strong> by breathing disturbances, brief wake-ups under 10 min, and total minutes awake in longer stretches.</>} /><RespirationChart nights={data.nights} win={win} respBy={byDay.resp} onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="respiration" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Blood oxygen (SpO₂)" tip={<>Each night's <strong>blood-oxygen %</strong> as a box-plot — box is the middle 50%, whiskers are min–max, tick is the median. Only the nights the Watch or iPhone logged SpO₂, so it's patchy{coverage.spo2End ? ` (ends ${coverage.spo2End})` : ''}.</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.spo2} color={SPO2} unit="%" label="Blood oxygen (SpO₂)" onHover={publishHover} onOpen={setOpenIdx} H={120} padL={padL} section="respiration" /></div>}
      </div>

      <div className={s.block} data-section="heart">
        <div className={s.chartHead}><h3 className={shared.title}>Heart Rate</h3>
          <InfoTip>Each night's heart-rate spread as a box-plot (box is the middle 50%, whiskers are min–max, tick is the median). A lower <strong>sleeping HR</strong> and a higher <strong>HRV</strong> both point to better recovery.</InfoTip>
          <Legend items={[
            { glyph: 'box', color: HR, label: 'Sleeping HR', tip: <>Overnight <strong>heart rate</strong> (bpm). Box is the middle 50%, whiskers are min–max, tick is the median. Lower means better recovery.</> },
            { glyph: 'box', color: HRV, label: 'Overnight HRV', tip: <>Overnight <strong>HRV</strong> (SDNN, ms) — the beat-to-beat variation in your heart rate. Box is the middle 50%, whiskers are min–max, tick is the median. Higher means better recovery.</> },
          ]} /></div>
        {win && series && <div className={s.subChart}><SubLabel label="Sleeping heart rate" tip={<>Each night's <strong>heart rate</strong> (bpm) as a box-plot — box is the middle 50%, whiskers are min–max, tick is the median. A <strong>lower</strong> sleeping HR usually means better recovery.</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.hr} color={HR} unit="bpm" label="Sleeping heart rate" onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="heart" /></div>}
        {win && series && <div className={s.subChart}><SubLabel label="Overnight HRV (SDNN)" tip={<>Each night's <strong>heart-rate variability</strong> (SDNN, ms) as a box-plot — box is the middle 50%, whiskers are min–max, tick is the median. <strong>Higher</strong> HRV usually means better recovery.</>} /><BoxSeries nights={data.nights} win={win} byDay={byDay.hrv} color={HRV} unit="ms" label="Overnight HRV (SDNN)" onHover={publishHover} onOpen={setOpenIdx} padL={padL} section="heart" /></div>}
      </div>
      </div>

      <HoverTooltip nights={data.nights} win={win} byDay={byDay} napByDay={napByDay}
        followRhrByDay={followRhrByDay} daylightByDay={daylightByDay} targets={targets} />

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
