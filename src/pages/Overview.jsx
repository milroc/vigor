import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthSleep, getHealthGoals } from '../api.js';
import shared from '../styles/shared.module.css';
import s from './Sleep.module.css';
import o from './Overview.module.css';
import { STAGE, INBED_PRE, INBED_POST } from './sleep/palette.js';
import { PAD_R, labelWidth, clamp, clock, hm, fmtDay, fillNightGaps } from './sleep/helpers.js';
import { InfoTip, DateStepper, RangePicker } from './sleep/pickers.jsx';
import { Legend, SubLabel } from './sleep/Legend.jsx';
import { Navigator, Composition, Skyline, MiniChart, Stat } from './sleep/charts.jsx';
import { GoalBars, violinGeometry } from './overview/GoalBars.jsx';
import { ZoneStream, GoalHeatRows, StackedBars } from './overview/ZoneStream.jsx';
import { DayModal } from './overview/DayModal.jsx';
import { EX_COLORS, EX_LABELS } from './overview/palette.js';
import { ZONE_COLORS } from '../components/ZoneDays.jsx';

// Chart color per goal metric (config can override via goal.color).
// Zone goals wear the SAME colors as their bands in the zone streamgraph
// (ZONE_COLORS), sleep goals the sleep-stage palette, so the Targets heatmap
// keys directly to the charts below it.
const GOAL_COLORS = {
  z2: ZONE_COLORS[1], z4: ZONE_COLORS[3], exercise_min: '#2fb3a0',
  steps: 'var(--c-daylight)', active_energy: 'var(--c-rhr)', stand_hours: 'var(--c-resp)', stand_min: 'var(--c-resp)',
  asleep_min: 'var(--st-core)', deep_min: 'var(--st-deep)',
  sessions: 'var(--c-nap)', session_min: 'var(--c-nap)',
};
const fmtFor = g =>
  g.metric === 'steps' ? (v => v >= 1000 ? `${(v / 1000).toFixed(v % 1000 ? 1 : 0)}k` : String(Math.round(v)))
  : g.metric === 'asleep_min' || g.metric === 'deep_min' ? (v => `${Math.round(v / 60 * 10) / 10}h`)
  : (v => String(Math.round(v)));
// Fixed sample week for the "how to read" figure — rest days around three
// workouts of different sizes — rendered through the REAL violin geometry so
// the legend is drawn exactly like the charts. Total 112, biggest day 52.
const DEMO_WEEK = [0, 34, 0, 16, 0, 52, 10];
const DEMO_TOTAL = DEMO_WEEK.reduce((a, b) => a + b, 0);
const DEMO_VIOLIN = violinGeometry(DEMO_WEEK, 14, 26, 52, v => 26 - (v / DEMO_TOTAL) * 22);

const GOAL_TIPS = {
  z2: <>Minutes with average heart rate at or above <strong>65% of your HRmax</strong>, counted only during explicit workouts (Apple Health + Peloton, overlapping recordings deduped). Each calendar minute counts once.</>,
  z4: <>Minutes with average heart rate at or above <strong>85% of your HRmax</strong>, counted only during explicit workouts (Apple Health + Peloton, overlapping recordings deduped).</>,
  exercise_min: <>Apple's <strong>exercise-ring</strong> minutes for the day — any brisk activity, not just logged workouts.</>,
  steps: <>Daily <strong>step count</strong>, iPhone + Watch deduped by taking the fullest source per hour.</>,
  active_energy: <>Daily <strong>active energy</strong> burned (kcal) — Apple's move ring, iPhone + Watch deduped like steps.</>,
  stand_hours: <>Apple's <strong>stand ring</strong>: distinct clock-hours with any stand time recorded.</>,
  stand_min: <>Total <strong>stand minutes</strong> for the day, from the Watch.</>,
  asleep_min: <>Effective <strong>time asleep</strong> per night (brief wake-ups folded in), from the same data as the Sleep tab.</>,
  deep_min: <>Minutes of <strong>deep sleep</strong> per night, from the same stage data as the Sleep tab.</>,
  sessions: <>Explicit <strong>workout sessions</strong> that day — Apple Health workouts plus completed Peloton workouts, with overlapping recordings merged into one.</>,
};

export default function Overview() {
  const [sleep, setSleep] = useState(null);
  const [goalsData, setGoalsData] = useState(null);
  const [error, setError] = useState(null);
  const [win, setWin] = useState(null);
  const [hover, setHover] = useState(null);
  const [range, setRange] = useState('6mo');
  const [gran, setGran] = useState(null);
  const [pick, setPick] = useState(null);
  const [openIdx, setOpenIdx] = useState(null); // day modal
  const openDay = i => { setHover(null); setOpenIdx(i); };
  // Violin vs heat rendering for the weekly goal charts (design A/B), sticky
  // across visits.
  const [vizMode, setVizMode] = useState(() => { try { return localStorage.getItem('overviewGoalViz') || 'violin'; } catch { return 'violin'; } });
  const setViz = m => { setVizMode(m); try { localStorage.setItem('overviewGoalViz', m); } catch { /* ignore */ } };
  const pickBtnRef = useRef(null);
  const tipRef = useRef(null);
  const scrollRef = useRef(null);
  const headRef = useRef(null);
  const [fontsReady, setFontsReady] = useState(false);
  useEffect(() => { document.fonts?.ready?.then(() => setFontsReady(true)); }, []);

  useEffect(() => {
    Promise.allSettled([getHealthSleep(), getHealthGoals()]).then(([sl, gl]) => {
      setSleep(sl.status === 'fulfilled' ? sl.value : { nights: [], naps: [] });
      setGoalsData(gl.status === 'fulfilled' ? gl.value : { goals: [], days: [], hrMax: null });
      if (sl.status === 'rejected' && gl.status === 'rejected') setError(sl.reason.message);
    });
  }, []);

  // One continuous day calendar covering BOTH datasets (sleep nights + goal
  // metric days), each sleep night attached — Skyline/Composition read straight
  // off it, goal charts look values up by day.
  const cal = useMemo(() => {
    const nights = fillNightGaps(sleep?.nights || []);
    const gDays = goalsData?.days || [];
    const firsts = [], lasts = [];
    if (nights.length) { firsts.push(nights[0].day); lasts.push(nights[nights.length - 1].day); }
    if (gDays.length) { firsts.push(gDays[0].day); lasts.push(gDays[gDays.length - 1].day); }
    if (!firsts.length) return [];
    const first = firsts.sort()[0], last = lasts.sort()[lasts.length - 1];
    const byDay = new Map(nights.map(n => [n.day, n]));
    const out = [];
    const cur = new Date(first + 'T00:00:00'), end = new Date(last + 'T00:00:00');
    while (cur <= end) { const k = fmtDay(cur); out.push(byDay.get(k) || { day: k, blank: true }); cur.setDate(cur.getDate() + 1); }
    return out;
  }, [sleep, goalsData]);

  const goalsByDay = useMemo(() => new Map((goalsData?.days || []).map(d => [d.day, d])), [goalsData]);
  const targets = { deepMin: 60, deepMax: 110, ...(sleep?.targets || { asleepMin: 420, bedMin: 420, wakeMin: 840, asleepHours: 7, bedtime: '01:00', wake: '08:00' }) };

  useEffect(() => {
    if (cal.length && !win) setWin([Math.max(0, cal.length - 183), cal.length - 1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cal]);

  // Mon–Sun weeks over the whole calendar (first/last may be clipped).
  const weeks = useMemo(() => {
    const out = []; let cur = null;
    cal.forEach((n, i) => {
      const dow = (new Date(n.day + 'T00:00:00').getDay() + 6) % 7; // Mon=0
      if (!cur || dow === 0) { cur = { lo: i, hi: i }; out.push(cur); }
      else cur.hi = i;
    });
    return out;
  }, [cal]);

  const goalDefs = useMemo(() => (goalsData?.goals || []).map(g => ({
    ...g,
    color: g.color || GOAL_COLORS[g.metric] || 'var(--lime)',
    fmt: fmtFor(g),
    tip: (
      <>
        {GOAL_TIPS[g.metric] || <>Daily <strong>{g.metric}</strong> from the goal metrics feed.</>}
        {(g.shape === 'violin' || g.shape === 'ramp') && <> Drawn as a weekly <strong>violin</strong> — mirrored area charts over a Mon→Sun axis (Mon at the bottom, each day an equal slot): the <strong>width</strong> at a day's slot is its minutes, so hard days bulge and rest days pinch to the axis. The tip lands at the <strong>weekly sum</strong> (the small tick), read against the target line.</>}
      </>
    ),
  })), [goalsData]);

  // Per-goal daily accessor (index into the calendar), shared by the period
  // roll-up, the violin profiles, and the tooltip.
  const metricAtFns = useMemo(() => goalDefs.map(g => i => {
    if (g.metric === 'asleep_min') return cal[i].blank ? null : cal[i].asleepEff ?? null;
    if (g.metric === 'deep_min') return cal[i].blank ? null : cal[i].deep ?? null;
    return goalsByDay.get(cal[i].day)?.[g.metric] ?? null;
  }), [goalDefs, cal, goalsByDay]);

  // Per-goal periods over the FULL calendar: one per day, or one per Mon–Sun
  // week (value = sum of the days present; a week clipped by the calendar edge
  // — including the in-progress current week — is marked partial).
  const goalPeriods = useMemo(() => goalDefs.map((g, gi) => {
    const metricAt = metricAtFns[gi];
    if (g.per === 'week') return weeks.map(wk => {
      let sum = 0, cnt = 0;
      for (let i = wk.lo; i <= wk.hi; i++) { const v = metricAt(i); if (v != null) { sum += v; cnt++; } }
      return { lo: wk.lo, hi: wk.hi, value: cnt ? sum : null, partial: wk.hi - wk.lo + 1 < 7 };
    });
    return cal.map((n, i) => ({ lo: i, hi: i, value: metricAt(i), partial: false }));
  }), [goalDefs, metricAtFns, cal, weeks]);

  // Shared left gutter: widest y-axis label across the aligned charts.
  const padL = useMemo(() => {
    const cands = [['10h', 10]];
    for (let h = 0; h < 24; h++) cands.push([clock(h * 60), 10]);
    for (const g of goalDefs) { cands.push([g.fmt(g.target), 10]); cands.push([g.fmt(g.target * 2.5), 10]); }
    return Math.ceil(Math.max(...cands.map(([str, px]) => labelWidth(str, px)))) + 8;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalDefs, fontsReady]);

  const summary = useMemo(() => {
    if (!cal.length || !win) return null;
    const [lo, hi] = win;
    const days = cal.slice(lo, hi + 1);
    const mean = a => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
    const stepVals = days.map(d => goalsByDay.get(d.day)?.steps).filter(v => v != null);
    const asleepVals = days.filter(d => !d.blank).map(d => d.asleepEff).filter(v => v != null);
    const fullWeeks = weeks.filter(w => w.lo >= lo && w.hi <= hi && w.hi - w.lo + 1 === 7);
    const wkAvg = metric => {
      if (!fullWeeks.length) return null;
      let tot = 0;
      for (const wk of fullWeeks) for (let i = wk.lo; i <= wk.hi; i++) tot += goalsByDay.get(cal[i].day)?.[metric] || 0;
      return tot / fullWeeks.length;
    };
    return {
      days: days.length, z2wk: wkAvg('z2'), z4wk: wkAvg('z4'), exwk: wkAvg('exercise_min'),
      steps: mean(stepVals), asleep: mean(asleepVals),
    };
  }, [cal, win, weeks, goalsByDay]);

  // ---- Window navigation (same semantics as the Sleep tab). ----
  const firstDay = cal[0]?.day, lastDay = cal[cal.length - 1]?.day;
  const dayToIdx = day => {
    if (!cal.length) return 0;
    const off = Math.round((new Date(day + 'T00:00:00') - new Date(firstDay + 'T00:00:00')) / 86400000);
    return clamp(off, 0, cal.length - 1);
  };
  const applyRange = (key, days) => {
    const N = cal.length;
    setWin([days ? Math.max(0, N - days) : 0, N - 1]);
    setRange(key); setGran(null);
  };
  const changeWin = w => { setWin(w); setRange(null); setGran(null); };
  const calBounds = (unit, ref) => {
    const d = new Date(ref + 'T00:00:00');
    let a, b;
    if (unit === 'week') { const dow = (d.getDay() + 6) % 7; a = new Date(d); a.setDate(d.getDate() - dow); b = new Date(a); b.setDate(a.getDate() + 6); }
    else if (unit === 'year') { a = new Date(d.getFullYear(), 0, 1); b = new Date(d.getFullYear(), 11, 31); }
    else { a = new Date(d.getFullYear(), d.getMonth(), 1); b = new Date(d.getFullYear(), d.getMonth() + 1, 0); }
    return [fmtDay(a), fmtDay(b)];
  };
  const applyGran = g => {
    if (!cal.length) return;
    const N = cal.length;
    if (g.type === 'roll') setWin([Math.max(0, N - g.n), N - 1]);
    else { const [a, b] = calBounds(g.unit, lastDay); setWin([dayToIdx(a), dayToIdx(b)]); }
    setRange(null); setGran(g);
  };
  const stepGran = dir => {
    if (!win || !cal.length || !gran) return;
    const N = cal.length, [lo, hi] = win;
    if (gran.type === 'roll') {
      const span = hi - lo;
      const nlo = clamp(lo + dir * gran.n, 0, N - 1 - span);
      if (nlo === lo) return;
      setWin([nlo, nlo + span]);
    } else {
      const edge = new Date(cal[dir < 0 ? lo : hi].day + 'T00:00:00');
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
    if (!win || !cal.length || !gran) return false;
    const N = cal.length, [lo, hi] = win;
    if (gran.type === 'roll') return clamp(lo + dir * gran.n, 0, N - 1 - (hi - lo)) !== lo;
    const edge = new Date(cal[dir < 0 ? lo : hi].day + 'T00:00:00');
    let nref;
    if (gran.unit === 'week') { nref = new Date(edge); nref.setDate(edge.getDate() + dir * 7); }
    else if (gran.unit === 'year') nref = new Date(edge.getFullYear() + dir, 0, 1);
    else nref = new Date(edge.getFullYear(), edge.getMonth() + dir, 1);
    const [a] = calBounds(gran.unit, fmtDay(nref));
    return dayToIdx(a) !== lo;
  };
  const pageWin = dir => {
    if (!win || !cal.length) return;
    const N = cal.length, [lo, hi] = win, span = hi - lo;
    const nlo = clamp(lo + dir * (span + 1), 0, N - 1 - span);
    if (nlo === lo) return;
    setWin([nlo, nlo + span]);
    setRange(null);
  };
  const stepHover = dir => {
    if (!win || hover?.i == null) return;
    const [lo, hi] = win;
    const j = hover.i + dir;
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
  const reachable = dir => {
    if (!win || !cal.length) return false;
    const [lo, hi] = win;
    if (hover?.i != null) { const j = hover.i + dir; return j >= lo && j <= hi; }
    if (gran) return canGran(dir);
    const N = cal.length, span = hi - lo;
    return clamp(lo + dir * (span + 1), 0, N - 1 - span) !== lo;
  };
  const stepUnit = dir => hover?.i != null ? stepHover(dir) : gran ? stepGran(dir) : pageWin(dir);

  useEffect(() => {
    const onKey = e => {
      if (openIdx != null) return; // modal owns the arrows
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const dir = e.key === 'ArrowRight' ? 1 : -1;
      if (hover?.i != null) { e.preventDefault(); stepHover(dir); }
      else if (win) { e.preventDefault(); gran ? stepGran(dir) : pageWin(dir); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hover, win, cal, padL, gran, openIdx]);

  // Range-picker hover intent (same as Sleep).
  const pickTimer = useRef(null);
  const openPick = () => {
    if (pickTimer.current) { clearTimeout(pickTimer.current); pickTimer.current = null; }
    setPick(p => p || [cal[win[0]].day, cal[win[1]].day]);
  };
  const closePickSoon = () => {
    if (pickTimer.current) clearTimeout(pickTimer.current);
    pickTimer.current = setTimeout(() => { setPick(null); pickTimer.current = null; }, 180);
  };
  const applyPick = (startDay, endDay) => {
    setPick(null);
    const lo = dayToIdx(startDay), hi = dayToIdx(endDay);
    changeWin([Math.min(lo, hi), Math.max(lo, hi)]);
  };

  // Coordinated hover surface over the charts' shared x-range (see Sleep.jsx).
  const RESPECT = `button, a, input, h2, h3, [class*="headRow"], [class*="info"], [class*="legendItem"], [class*="subLabel"], [class*="navWrap"], [class*="scrub"], [class*="pickPop"]`;
  const onXHover = e => {
    if (!win || !scrollRef.current || openIdx != null) return;
    if (headRef.current && e.clientY <= headRef.current.getBoundingClientRect().bottom) { setHover(null); return; }
    if (e.target.closest(RESPECT)) { setHover(null); return; }
    const [lo, hi] = win;
    const r = scrollRef.current.getBoundingClientRect();
    const cw = (r.width - padL - PAD_R) / (hi - lo + 1);
    if (cw <= 0) return;
    const section = e.target.closest('[data-section]')?.dataset.section ?? null;
    setHover({ i: clamp(lo + Math.floor((e.clientX - r.left - padL) / cw), lo, hi), cx: e.clientX, cy: e.clientY, section });
  };

  // Keep the tooltip on-screen (same clamping as Sleep).
  useEffect(() => {
    const el = tipRef.current;
    if (!el || !hover || hover.cx == null) return;
    const M = 8, GAP = 14;
    const { width: w, height: h } = el.getBoundingClientRect();
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = hover.cx + GAP;
    if (left + w > vw - M) left = hover.cx - w - GAP;
    left = Math.max(M, Math.min(left, vw - w - M));
    let top = hover.cy + GAP;
    if (top + h > vh - M) top = Math.min(hover.cy - h - GAP, vh - h - M);
    top = Math.max(M, top);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  });

  // Zone-stream + target-heatmap plumbing: per-day zone minutes, and one
  // yes/no row per goal built from the same periods the goal charts score.
  const zonesAt = useMemo(() => i => goalsByDay.get(cal[i]?.day)?.zones ?? null, [goalsByDay, cal]);
  const hasZones = useMemo(() => (goalsData?.days || []).some(d => d.zones && d.zones.some(v => v)), [goalsData]);
  const SHORT = { z2: 'Z2+', z4: 'Z4+', exercise_min: 'EXER', steps: 'STEPS', active_energy: 'MOVE', stand_hours: 'STAND', asleep_min: 'SLEEP', deep_min: 'DEEP', sessions: 'SESS' };
  const GOAL_GROUP = { z2: 'training', z4: 'training', exercise_min: 'training', sessions: 'training', session_min: 'training', steps: 'NEAT', active_energy: 'NEAT', stand_hours: 'NEAT', stand_min: 'NEAT', asleep_min: 'sleep', deep_min: 'sleep' };
  const heatGroups = useMemo(() => {
    const rows = goalDefs.map((g, gi) => ({
      label: g.short || SHORT[g.metric] || g.metric.slice(0, 5).toUpperCase(),
      color: g.color,
      group: GOAL_GROUP[g.metric] || 'other',
      cells: goalPeriods[gi].map(p => ({ lo: p.lo, hi: p.hi, met: p.value != null && p.value >= g.target, partial: p.partial, empty: p.value == null })),
    }));
    return ['training', 'NEAT', 'sleep', 'other']
      .map(name => ({ name, rows: rows.filter(r => r.group === name) }))
      .filter(gr => gr.rows.length);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [goalDefs, goalPeriods]);

  // Daily target lookup for the bar charts.
  const dailyTarget = metric => goalDefs.find(g => g.metric === metric && g.per === 'day')?.target;
  // Stand ring met/missed per day, for the filled-vs-hollow stand bubbles.
  const standMet = useMemo(() => {
    const t = goalDefs.find(g => g.metric === 'stand_hours' && g.per === 'day')?.target;
    return i => { const g = goalsByDay.get(cal[i]?.day); return t != null && g?.stand_hours != null && g.stand_hours >= t; };
  }, [goalDefs, goalsByDay, cal]);

  // Every goal judged for one day (daily goals on the day itself, weekly on
  // the containing week) — the day modal's scorecard.
  const goalsEvalFor = idx => goalDefs.map((g, gi) => {
    const periods = goalPeriods[gi];
    const p = g.per === 'week' ? periods.find(q => idx >= q.lo && idx <= q.hi) : periods[idx];
    const v = p?.value;
    return { g, short: g.short || SHORT[g.metric] || g.metric, per: g.per, value: v, met: v != null && v >= g.target, empty: v == null };
  });

  const statusFor = (g, periods) => {
    if (!win) return null;
    if (g.per === 'week') {
      const last = [...periods].reverse().find(p => p.value != null);
      return last ? `latest week ${g.fmt(last.value)} / ${g.fmt(g.target)}` : null;
    }
    const [lo, hi] = win;
    let met = 0, cnt = 0;
    for (const p of periods) if (p.lo >= lo && p.hi <= hi && p.value != null) { cnt++; if (p.value >= g.target) met++; }
    return cnt ? `met ${Math.round((met / cnt) * 100)}% of days` : null;
  };
  const targetStr = g => {
    const suffix = g.unit === 'min' && g.metric !== 'asleep_min' && g.metric !== 'deep_min' ? ' min'
      : g.unit === 'kcal' ? ' kcal' : g.unit === 'hours' ? ' hr' : '';
    return `≥${g.fmt(g.target)}${suffix} / ${g.per === 'week' ? 'week' : 'day'}`;
  };

  if (error) return <main className={s.main}><div className={s.error}>Couldn't load your health data: {error}</div></main>;
  if (!sleep || !goalsData) return <main className={s.main} />;
  if (!cal.length) {
    return (
      <main className={s.main}>
        <div className={s.headRow}><h2 className={shared.title}>Overview</h2></div>
        <p className={s.intro}>No health data yet. Import an <strong>export.zip</strong> from the <strong>Sync</strong> tab to load it.</p>
      </main>
    );
  }

  const hovered = hover?.i != null ? cal[hover.i] : null;

  return (
    <main className={s.main} onPointerMove={onXHover} onPointerLeave={() => setHover(null)}>
      <div className={s.pinned}>
        <div className={s.headRow} ref={headRef}>
          <div className={s.headMain}>
            <div className={s.titleRow}>
              <h2 className={shared.title}>Overview</h2>
              <InfoTip wide>
                <strong>Your training and recovery at a glance.</strong> The top section scores each configured <strong>fitness goal</strong> (labels/fitness-goals.json) over time — weekly goals as one bar per Mon–Sun week, daily goals as one bar per day, with the <strong>lime dashes</strong> marking the target. Below it, the two headline sleep charts. Hover anywhere to inspect a day; all panels move together.
              </InfoTip>
            </div>
            {summary && (
              <div className={s.stats}>
                <Stat value={summary.days} label="days" />
                <Stat value={summary.z2wk != null ? Math.round(summary.z2wk) : '—'} unit="min" label="avg z2+ / wk" />
                <Stat value={summary.z4wk != null ? Math.round(summary.z4wk) : '—'} unit="min" label="avg z4+ / wk" />
                <Stat value={summary.exwk != null ? Math.round(summary.exwk) : '—'} unit="min" label="avg exercise / wk" />
                <Stat value={summary.steps != null ? Math.round(summary.steps).toLocaleString() : '—'} label="avg steps / day" />
                <Stat value={hm(summary.asleep)} label="avg asleep" />
              </div>
            )}
          </div>
          <div className={s.headSel}>
            {win && (() => {
              let label;
              if (hovered) {
                label = new Date(hovered.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
              } else {
                const a = new Date(cal[win[0]].day + 'T00:00:00'), b = new Date(cal[win[1]].day + 'T00:00:00');
                const sameYear = a.getFullYear() === b.getFullYear();
                const fa = a.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) });
                const fb = b.toLocaleDateString('en', { month: 'short', day: 'numeric', year: 'numeric' });
                label = `${fa} – ${fb}`;
              }
              const tip = hovered
                ? <>Press <strong>← →</strong> to step one day at a time.</>
                : <>Press <strong>← →</strong> to page the date range. Hover a day to step one date at a time instead.</>;
              return (
                <span className={s.stepWrap}>
                  <DateStepper label={label} onPrev={() => stepUnit(-1)} onNext={() => stepUnit(1)}
                    labelRef={pickBtnRef} onLabel={openPick}
                    onHoverOpen={openPick} onHoverClose={closePickSoon}
                    canPrev={reachable(-1)} canNext={reachable(1)} />
                  {pick && <RangePicker min={firstDay} max={lastDay} init={pick} anchorRef={pickBtnRef}
                    onApply={applyPick} activeRange={range} activeGran={gran}
                    onGran={g => { applyGran(g); setPick(null); }} onRange={(k, d) => { applyRange(k, d); setPick(null); }}
                    onMouseEnter={openPick} onMouseLeave={closePickSoon} hint={tip}
                    pickHint="Click a start day, then an end day."
                    brush={<div className={s.pickBrush}><Navigator nights={cal} win={win} onWin={changeWin} /></div>} />}
                </span>
              );
            })()}
          </div>
        </div>

        <div className={`${s.block} ${s.skyBlock}`} data-section="targets">
          <div className={s.chartHead}><h3 className={shared.title}>Targets</h3>
            <InfoTip>Every configured <strong>fitness target</strong> (labels/fitness-goals.json) scored over time, grouped into <strong>training / NEAT / sleep</strong>: one row per goal, one cell per day or Mon–Sun week. A cell <strong>filled in the goal's color</strong> (the same color that metric wears in the charts below) = met; faint blocks are misses; the dashed cell is the in-progress week. Pinned so the scorecard stays in view while you scroll.</InfoTip>
            <Legend items={goalDefs.map(g => ({
              glyph: 'square', color: g.color,
              label: `${g.short || SHORT[g.metric] || g.metric} ${targetStr(g)}`,
              tip: g.tip,
            }))} />
          </div>
          {win && heatGroups.length > 0 && <GoalHeatRows nights={cal} win={win} groups={heatGroups} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="targets" />}
        </div>
      </div>

      <div className={s.scroller} ref={scrollRef}>
        {/* DEPRECATED: the original Fitness Goals section (violin/heat A-B charts,
            toggle, how-to legend). Kept as dead code for comparison while the
            Targets + Training layout is evaluated — flip the guard to resurrect. */}
        {false && (
        <div className={s.block} data-section="goals">
          <div className={s.chartHead}><h3 className={shared.title}>Fitness Goals</h3>
            <InfoTip>Each goal from <strong>labels/fitness-goals.json</strong>, scored over time. Weekly goals sum Mon–Sun; daily goals score each day. Bars that reach the <strong>lime target line</strong> render solid, misses are faded, and the in-progress week draws hollow.</InfoTip>
            {goalDefs.some(g => g.shape === 'violin' || g.shape === 'ramp') && (
              <span className={o.vizToggle} role="group" aria-label="Weekly chart style">
                {['violin', 'heat'].map(m => (
                  <button key={m} className={`${o.vizBtn} ${vizMode === m ? o.vizOn : ''}`} onClick={() => setViz(m)}>{m}</button>
                ))}
              </span>
            )}
            <Legend items={goalDefs.map(g => ({ glyph: g.shape === 'violin' || g.shape === 'ramp' ? (vizMode === 'heat' ? 'heat' : 'violin') : 'bar', color: g.color, label: g.label, tip: g.tip }))} />
            {goalDefs.some(g => g.shape === 'violin' || g.shape === 'ramp') && (
              <div className={o.howTo}>
                <svg width="28" height="28" viewBox="0 0 28 28" aria-hidden>
                  {/* the sample week rendered in the ACTIVE style: Mon at the
                      bottom, top tick = weekly total just above the target line */}
                  <line x1="1" x2="27" y1="6.5" y2="6.5" stroke="var(--lime)" strokeWidth="1" strokeDasharray="3 3" opacity="0.6" />
                  {vizMode === 'heat' ? (
                    <>
                      {DEMO_WEEK.map((v, j) => {
                        const yb = 26 - (112 * j / 7 / 112) * 22, yt = 26 - (112 * (j + 1) / 7 / 112) * 22;
                        return <rect key={j} x="10" y={yt + 0.25} width="8" height={Math.max(yb - yt - 0.5, 0.4)}
                          fill="var(--c-resp)" fillOpacity={0.06 + 0.84 * Math.min(v / 52, 1)} />;
                      })}
                      <rect x="9.5" y="4" width="9" height="22" fill="none" stroke="var(--c-resp)" strokeOpacity="0.8" strokeWidth="0.8" />
                      <line x1="7" x2="21" y1="4" y2="4" stroke="var(--c-resp)" strokeWidth="1.4" />
                    </>
                  ) : (
                    <>
                      <path d={DEMO_VIOLIN.fillPath} fill="var(--c-resp)" fillOpacity="0.5" />
                      <path d={DEMO_VIOLIN.d} fill="none" stroke="var(--c-resp)" strokeOpacity="0.95" strokeWidth="1" />
                      <line x1="10" x2="18" y1={DEMO_VIOLIN.top} y2={DEMO_VIOLIN.top} stroke="var(--c-resp)" strokeWidth="1.4" />
                    </>
                  )}
                </svg>
                <div className={o.howToText}>
                  <div><span className={o.howToTitle}>How to read</span> · Mon→Sun, bottom to top; {vizMode === 'heat' ? 'brightness' : 'width'} = a day's minutes</div>
                  <div>tip = weekly total vs <strong>target</strong></div>
                </div>
              </div>
            )}
          </div>
          {win && goalDefs.map((g, gi) => (
            <div key={g.id || g.metric} className={s.subChart}>
              <SubLabel label={`${g.label} · ${targetStr(g)}${statusFor(g, goalPeriods[gi]) ? ` — ${statusFor(g, goalPeriods[gi])}` : ''}`} tip={g.tip} />
              <GoalBars nights={cal} win={win} periods={goalPeriods[gi]} target={g.target} color={g.color}
                fmt={g.fmt} shape={g.shape} variant={vizMode} dayValueAt={metricAtFns[gi]}
                hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="goals" />
            </div>
          ))}
          {win && !goalDefs.length && <p className={s.intro}>No goals configured — add them to <strong>labels/fitness-goals.json</strong>.</p>}
        </div>
        )}

        {win && (
          <div className={s.block} data-section="training">
            <div className={s.chartHead}><h3 className={shared.title}>Training</h3>
              <InfoTip>How hard and how much, day by day. The <strong>streamgraph</strong> shows minutes per day in each heart-rate zone (same zones and colors as the Peloton and Apple Health tabs), centered on a midline — thick days were big days, and the stream pinches shut on rest days. Below it, total <strong>exercise minutes</strong> per day (Apple's exercise ring) as bars.</InfoTip>
              <Legend items={[
                ...ZONE_COLORS.map((c, z) => ({
                  glyph: 'square', color: c, label: `Z${z + 1}`,
                  tip: <>Minutes in <strong>zone {z + 1}</strong>{['— under 65% of HRmax (recovery)', '— 65–75% of HRmax', '— 75–85% of HRmax', '— 85–95% of HRmax', '— 95%+ of HRmax (max effort)'][z]}, counted during explicit workouts.</>,
                })),
                ...EX_COLORS.map((c, k) => ({
                  glyph: 'bar', color: c, label: EX_LABELS[k],
                  tip: [<>Exercise-ring minutes inside <strong>cardio</strong> workouts (cycling, walking, running, HIIT…).</>,
                    <>Exercise-ring minutes inside <strong>strength</strong> workouts — including trainer sessions logged as "Other".</>,
                    <>Exercise-ring minutes inside <strong>recovery</strong> work — yoga, stretching, prep and cooldowns.</>,
                    <>Ring minutes credited <strong>outside any logged workout</strong> — mostly brisk walking through the day.</>][k],
                })),
              ]} /></div>
            {hasZones && (
              <div className={s.subChart}>
                <SubLabel label="Zone minutes (per day)" tip={<>Minutes per day in each HR zone as a centered <strong>streamgraph</strong>, Z1 at the bottom through Z5 on top. Zones are bands of your personal HRmax, counted during explicit workouts only.</>} />
                <ZoneStream nights={cal} win={win} zonesAt={zonesAt} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} H={240} section="training" />
              </div>
            )}
            <div className={s.subChart}>
              <SubLabel label="Exercise minutes (per day, by kind)" tip={<>Total <strong>exercise-ring minutes</strong> each day, stacked by what you were doing: <strong>cardio</strong> workouts, <strong>lifting</strong> (strength + trainer sessions), <strong>recovery</strong> (yoga / stretch / prep), and ring minutes credited <strong>outside any logged workout</strong> (brisk walking etc.). Days reaching the lime line closed the 30-min ring.</>} />
              <StackedBars nights={cal} win={win}
                valuesAt={i => { const g = goalsByDay.get(cal[i].day); if (!g) return null; if (g.ex_split) return g.ex_split; return g.exercise_min != null ? [0, 0, 0, g.exercise_min] : null; }}
                colors={EX_COLORS} target={dailyTarget('exercise_min')} H={220} yCap={100}
                hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="training" />
            </div>
          </div>
        )}

        {win && (
          <div className={s.block} data-section="neat">
            <div className={s.chartHead}><h3 className={shared.title}>NEAT</h3>
              <InfoTip>All-day movement outside formal training. Daily <strong>steps</strong> and <strong>active energy</strong> (the move ring) as bars, and <strong>stand minutes</strong> as a bubble lane — bubble <strong>area</strong> scales with the value across the window.</InfoTip>
              <Legend items={[
                { glyph: 'bar', color: 'var(--c-daylight)', label: 'Steps', tip: GOAL_TIPS.steps },
                { glyph: 'bar', color: 'var(--c-rhr)', label: 'Active energy', tip: GOAL_TIPS.active_energy },
                { glyph: 'bubblemet', color: 'var(--c-resp)', label: 'Stand minutes · ●=ring met ○=missed', tip: <>{GOAL_TIPS.stand_min} Bubble <strong>area</strong> is that day's stand minutes; a <strong>filled</strong> bubble means the stand ring closed (≥12 stand hours), a <strong>hollow</strong> one means it didn't.</> },
              ]} /></div>
            <div className={s.subChart}>
              <SubLabel label="Steps (per day)" tip={GOAL_TIPS.steps} />
              <MiniChart nights={cal} win={win} valueAt={i => goalsByDay.get(cal[i].day)?.steps ?? null} color="var(--c-daylight)" unit="steps" label="Steps (per day)" type="bars" H={110} target={dailyTarget('steps')} targetLabel={dailyTarget('steps') ? fmtFor({ metric: 'steps' })(dailyTarget('steps')) : undefined} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="neat" />
            </div>
            <div className={s.subChart}>
              <SubLabel label="Active energy (per day)" tip={GOAL_TIPS.active_energy} />
              <MiniChart nights={cal} win={win} valueAt={i => goalsByDay.get(cal[i].day)?.active_energy ?? null} color="var(--c-rhr)" unit="kcal" label="Active energy (per day)" type="bars" H={110} target={dailyTarget('active_energy')} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="neat" />
            </div>
            <div className={s.subChart}>
              <SubLabel label="Stand minutes (per day)" tip={<>{GOAL_TIPS.stand_min} Bubble <strong>area</strong> is stand minutes; a <strong>filled</strong> bubble means the stand ring closed that day (≥12 stand hours), a hollow outline means it didn't.</>} />
              <MiniChart nights={cal} win={win} valueAt={i => goalsByDay.get(cal[i].day)?.stand_min ?? null} color="var(--c-resp)" unit="min" label="Stand minutes (per day)" type="bubble" H={48} filledAt={standMet} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} padL={padL} section="neat" />
            </div>
          </div>
        )}

        <div className={s.block} data-section="timing">
          <div className={s.chartHead}><h3 className={shared.title}>When You Slept</h3>
            <InfoTip>One column per night. The y-axis is <strong>clock time</strong> (bedtime at the top, wake at the bottom), colored by stage. Main sleep only — see the <strong>Sleep</strong> tab for the full picture.</InfoTip>
            <Legend items={[
              { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <><strong>Deep</strong> sleep. Each band sits at the clock time you were in this stage.</> },
              { glyph: 'square', color: STAGE.core, label: 'Core', tip: <><strong>Core</strong> (light) sleep. Most of a typical night.</> },
              { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <><strong>REM</strong>, the dreaming stage. Tends to cluster toward morning.</> },
              { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Moments you woke up during the night.</> },
            ]} /></div>
          {win && <Skyline nights={cal} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} targets={targets} padL={padL} section="timing" />}
        </div>

        <div className={s.block} data-section="stages">
          <div className={s.chartHead}><h3 className={shared.title}>Stage Composition</h3>
            <InfoTip>How each night breaks down by stage. One bar per night, stacking <strong>Deep / Core / REM / Awake</strong> minutes. The axis caps at 10h; taller nights spill over the top.</InfoTip>
            <Legend items={[
              { glyph: 'square', color: STAGE.deep, label: 'Deep', tip: <>Minutes of <strong>Deep</strong> sleep, at the bottom of the stack.</> },
              { glyph: 'square', color: STAGE.core, label: 'Core', tip: <>Minutes of <strong>Core</strong> (light) sleep in the stack.</> },
              { glyph: 'square', color: STAGE.rem, label: 'REM', tip: <>Minutes of <strong>REM</strong> sleep in the stack.</> },
              { glyph: 'square', color: STAGE.awake, label: 'Awake', tip: <>Minutes spent <strong>awake</strong>, at the top of the stack.</> },
              { glyph: 'square', color: INBED_PRE, label: 'In bed · pre', tip: <>Time in bed <strong>before</strong> you fell asleep. Faded cap below the stack.</> },
              { glyph: 'square', color: INBED_POST, label: 'In bed · post', tip: <>Time in bed <strong>after</strong> you woke. Faded cap above the stack.</> },
            ]} /></div>
          {win && <Composition nights={cal} win={win} hover={hover?.i ?? null} onHover={setHover} onOpen={openDay} targets={targets} padL={padL} section="stages" />}
        </div>
      </div>

      {hovered && openIdx == null && (() => {
        const g = goalsByDay.get(hovered.day);
        const wk = weeks.find(x => hover.i >= x.lo && x.hi >= hover.i);
        const wkLabel = wk ? new Date(cal[wk.lo].day + 'T00:00:00').toLocaleDateString('en', { month: 'short', day: 'numeric' }) : null;
        const met = (v, t) => t != null && v != null && v >= t;
        const stepsTarget = goalDefs.find(x => x.metric === 'steps')?.target;
        const dayGoals = goalDefs.filter(x => x.per === 'day');
        const weekGoals = goalDefs.filter(x => x.per === 'week');
        const wkVal = gi => {
          const p = goalPeriods[gi].find(q => hover.i >= q.lo && hover.i <= q.hi);
          return p?.value ?? null;
        };
        const noData = !g && hovered.blank;
        return (
          <div ref={tipRef} className={`${s.tip} ${noData ? s.tipBlank : ''}`} style={{ left: hover.cx + 14, top: hover.cy + 14 }}>
            <b className={s.tipHead}>{new Date(hovered.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })}</b>
            {noData ? (
              <div className={s.tipRow}><span style={{ color: 'var(--dim)' }}>no data</span></div>
            ) : (
              <>
                <div className={s.tipHero}>
                  <span><span className={s.tipHeroVal} style={met(g?.steps, stepsTarget) ? { color: 'var(--lime)' } : undefined}>{g?.steps != null ? Math.round(g.steps).toLocaleString() : '—'}</span><span className={s.tipHeroLbl}>steps</span></span>
                  <span><span className={s.tipHeroVal}>{hovered.blank ? '—' : hm(hovered.asleepEff)}</span><span className={s.tipHeroLbl}>asleep</span></span>
                </div>
                <div className={s.tipGroup}>
                  <div className={s.tipGroupLabel}>day</div>
                  <div className={s.tipRow}><span>exercise min</span><span>{g?.exercise_min != null ? Math.round(g.exercise_min) : '—'}</span></div>
                  {g?.ex_split?.some(v => v) && EX_LABELS.map((lbl, k) => g.ex_split[k] > 0 && (
                    <div key={lbl} className={s.tipRow}><span><span className={s.tipDot} style={{ background: EX_COLORS[k] }} />{lbl.toLowerCase()}</span><span>{g.ex_split[k]} min</span></div>
                  ))}
                  <div className={s.tipRow}><span>zone 2+ / 4+ min</span><span>{g?.z2 ?? 0} / {g?.z4 ?? 0}</span></div>
                  {g?.zones?.some(v => v) && <div className={s.tipRow}><span>zones z1–z5</span><span>{g.zones.join(' / ')}</span></div>}
                  {g?.sessions > 0 && <div className={s.tipRow}><span>{g.sessions > 1 ? 'sessions' : 'session'}</span><span>{g.sessions} · {hm(g.session_min)}</span></div>}
                  {dayGoals.map((dg, k) => {
                    const gi = goalDefs.indexOf(dg);
                    const v = goalPeriods[gi][hover.i]?.value;
                    return (
                      <div key={dg.id || k} className={s.tipRow}><span><span className={s.tipDot} style={{ background: dg.color }} />{dg.label.toLowerCase()}</span>
                        <span style={met(v, dg.target) ? { color: 'var(--lime)' } : undefined}>{v != null ? dg.fmt(v) : '—'} / {dg.fmt(dg.target)}</span></div>
                    );
                  })}
                </div>
                {weekGoals.length > 0 && (
                  <div className={s.tipGroup}>
                    <div className={s.tipGroupLabel}>week of {wkLabel}</div>
                    {weekGoals.map((wg, k) => {
                      const gi = goalDefs.indexOf(wg);
                      const v = wkVal(gi);
                      return (
                        <div key={wg.id || k} className={s.tipRow}><span><span className={s.tipDot} style={{ background: wg.color }} />{wg.label.toLowerCase()}</span>
                          <span style={met(v, wg.target) ? { color: 'var(--lime)' } : undefined}>{v != null ? wg.fmt(v) : '—'} / {wg.fmt(wg.target)}</span></div>
                      );
                    })}
                  </div>
                )}
              </>
            )}
          </div>
        );
      })()}

      {openIdx != null && cal[openIdx] && (
        <DayModal cal={cal} idx={openIdx} goalsEval={goalsEvalFor(openIdx)}
          g={goalsByDay.get(cal[openIdx].day)}
          naps={(sleep?.naps || []).filter(p => p.day === cal[openIdx].day)}
          hrMax={goalsData?.hrMax} min={firstDay} max={lastDay}
          onClose={() => setOpenIdx(null)}
          onStep={dir => setOpenIdx(i => clamp(i + dir, 0, cal.length - 1))}
          onPickDate={day => setOpenIdx(dayToIdx(day))} />
      )}
    </main>
  );
}
