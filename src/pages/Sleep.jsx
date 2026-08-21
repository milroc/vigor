import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthSleep, getHealthSleepSeries, getHealthSleepNight } from '../api.js';
import shared from '../styles/shared.module.css';
import s from './Sleep.module.css';
import {
  STAGE, INBED_PRE, INBED_POST, RESP, SPO2, DIST, FULLWAKE, HR, HRV, NAP, DEBT, LOAD, RHR, DAYLIGHT, BED_TGT, WAKE_TGT,
  applyTunerState,
} from './sleep/palette.js';
import TunerPanel from './sleep/TunerPanel.jsx';

import { PAD_R, labelWidth, srcLabel, clamp, clock, hm, fmtMon, fmtDay, fillNightGaps, std } from './sleep/helpers.js';
import { InfoTip, DateStepper, RangePicker } from './sleep/pickers.jsx';
import { Legend, SubLabel } from './sleep/Legend.jsx';
import { Navigator, Composition, Skyline, NapsPanel, BoxSeries, NextDayCombo, RespirationChart, Consistency, MiniChart, Stat } from './sleep/charts.jsx';
import { NightModal } from './sleep/NightModal.jsx';

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
