import { useEffect, useMemo, useRef, useState } from 'react';
import { getPelotonWorkouts, getPelotonMetrics, getPelotonFitness, getProfile } from '../api.js';
import DateBrush from '../components/DateBrush.jsx';
import LineChart from '../components/LineChart.jsx';
import { MuscleHighlight } from '../components/MuscleBody.jsx';
import Splom from '../components/Splom.jsx';
import ZoneDays, { ZONE_COLORS } from '../components/ZoneDays.jsx';
import { regIncBeta, fmtP } from '../lib/stats.js';
import shared from '../styles/shared.module.css';
import s from './Peloton.module.css';

const METRICS = [
  { key: 'output', title: 'Output', unit: 'W', color: '#c6fe28' },
  { key: 'cadence', title: 'Cadence', unit: 'RPM', color: '#3fd8c7' },
  { key: 'resistance', title: 'Resistance', unit: '%', color: '#ff4d3a' },
  { key: 'speed', title: 'Speed', unit: 'MPH', color: '#4da3ff' },
  { key: 'heart_rate', title: 'Heart Rate', unit: 'BPM', color: '#ff6b9d' },
  { key: 'pace', title: 'Pace', unit: 'MIN/MI', color: '#b48aff' },
  { key: 'altitude', title: 'Altitude', unit: 'FT', color: '#e0c341' },
];

const fmtLen = secs => {
  if (secs == null) return '—';
  const m = Math.floor(secs / 60), sRem = secs % 60;
  return sRem ? `${m}m ${sRem}s` : `${m}m`;
};
const fmtDay = iso => iso ? new Date(iso).toLocaleDateString(undefined,
  { year: '2-digit', month: 'short', day: 'numeric' }) : '—';
// Older backups prefixed summary slugs with total_.
const summary = (w, key) => w[key] ?? w[`total_${key}`] ?? null;
// Freestyle "Just Workout" rows carry the uppercased title as the instructor.
const instructorOf = w =>
  w.instructor && w.instructor.toLowerCase() !== (w.title || '').toLowerCase()
    ? w.instructor : null;
const fmtZone = secs => `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;

// Peloton muscle group name → Cortex typeId used by the shared body figure.
const MUSCLE_TYPE = [
  ['glute', 2], ['quad', 2], ['hamstring', 2], ['calv', 2], ['leg', 2],
  ['lat', 3], ['back', 3], ['chest', 4], ['pec', 4], ['shoulder', 5], ['delt', 5],
  ['bicep', 6], ['tricep', 7], ['core', 8], ['ab', 8], ['oblique', 8],
];
const muscleName = m => String(m.display_name ?? m.name ?? m.muscle_group ?? '');
const muscleValue = m => m.percentage ?? m.score ?? m.value ?? 0;
const muscleTypeOf = m => MUSCLE_TYPE.find(([p]) => muscleName(m).toLowerCase().includes(p))?.[1];

function Stat({ label, value, unit }) {
  if (value == null) return null;
  return (
    <div className={s.stat}>
      <div className={s.statValue}>{value}{unit && <small> {unit}</small>}</div>
      <div className={s.statLabel}>{label}</div>
    </div>
  );
}

const DAY = 86_400_000;

// Below any living resting HR — strap dropout noise, treated as missing.
const HR_FLOOR = 30;

// Peloton's zone boundaries as fractions of max HR: Z1 <65%, Z2 65-75%,
// Z3 75-85%, Z4 85-95%, Z5 95%+.
const ZONE_EDGES = [0, 0.65, 0.75, 0.85, 0.95, 1.06];

// VO2max fitness-tier boundaries (ml/kg/min) by sex and age decade —
// approximate Apple Health style cardio-fitness levels: [low-top,
// below-avg-top, above-avg-top]; High is everything above.
const VO2_TIERS = {
  m: { 20: [34, 41, 52], 30: [33, 39, 52], 40: [32, 38, 50], 50: [28, 35, 47], 60: [24, 30, 42] },
  f: { 20: [27, 33, 42], 30: [26, 32, 41], 40: [24, 30, 40], 50: [21, 26, 36], 60: [18, 23, 32] },
};
const vo2BandsFor = (age, sex) => {
  const bracket = Math.min(60, Math.max(20, Math.floor((Number(age) || 0) / 10) * 10));
  const edges = VO2_TIERS[sex]?.[bracket];
  if (!age || !edges) return null;
  return [
    { from: 0, to: edges[0], color: '#eb3745', label: 'LOW' },
    { from: edges[0], to: edges[1], color: '#f78e1e', label: 'BELOW AVG' },
    { from: edges[1], to: edges[2], color: '#f6c344', label: 'ABOVE AVG' },
    { from: edges[2], to: edges[2] * 1.4, color: '#7ec642', label: 'HIGH' },
  ];
};

// Custom analysis sets: named cross-discipline filters. Trainer sessions
// were logged inconsistently as strength or stretching; the duration
// histogram shows the cluster runs 42-66 minutes with a clean gap below.
const TRAINER_MIN = 42 * 60, TRAINER_MAX = 66 * 60;
const CUSTOM_SETS = {
  __trainer: {
    label: 'Trainer sessions',
    disciplines: ['strength', 'stretching'],
    minSecs: TRAINER_MIN,
    maxSecs: TRAINER_MAX,
    // Paused/restarted recordings within 30min merge into one session
    // server-side, so the dropdown count (individual recordings) can be
    // slightly below the analyzed session count.
    mergeGapMins: 30,
    matches: w => ['strength', 'stretching'].includes(w.discipline)
      && w.duration_secs >= TRAINER_MIN && w.duration_secs <= TRAINER_MAX,
  },
};

// Raw per-ride cardio analysis — every ride is its own data point, no
// monthly averaging. Trend comes from a least-squares fit over the points.
function FitnessPanel({ current, selection, setSelection, onOpenWorkout, header, workouts, selectedId }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  // Weight/age/sex come from manual/profile.json — no inputs; they feed
  // the VO2max conversion and target bands only.
  const [profile, setProfile] = useState({});
  useEffect(() => {
    getProfile().then(setProfile).catch(() => {});
  }, []);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // Shared point-hover: the hovered workout id, mirrored by every chart.
  const [hoverId, setHoverId] = useState(null);
  const onHoverPoint = id => setHoverId(prev => (prev === id ? prev : id));

  // Bottom pane tab: the workout table or the correlation matrix.
  const [tab, setTab] = useState('table');
  // Heartrates tab brush window: [fromMs, toMs] over workout start dates
  // (null = default, the last month).
  const [hrRange, setHrRange] = useState(null);
  // Chart-area height, adjustable by dragging the divider above the tabs.
  // Starts proportional to the viewport so the bottom pane is visible on
  // any desktop size.
  const [chartsH, setChartsH] = useState(() =>
    Math.max(260, Math.round((window.innerHeight || 900) * 0.34)));
  const onDividerDown = e => {
    e.preventDefault();
    const startY = e.clientY, startH = chartsH;
    const move = ev => setChartsH(Math.max(220, Math.min(1600, startH + ev.clientY - startY)));
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  // One dropdown selects the analysis population: custom sets, whole
  // disciplines, or repeatable classes — anything with a single workout
  // can't trend, so it's dropped.
  const options = useMemo(() => {
    const ws = current?.workouts || [];
    const discCounts = new Map(), titleCounts = new Map();
    for (const w of ws) {
      discCounts.set(w.discipline, (discCounts.get(w.discipline) || 0) + 1);
      const t = w.title || '(untitled)';
      titleCounts.set(t, (titleCounts.get(t) || 0) + 1);
    }
    return {
      total: ws.length,
      sets: Object.entries(CUSTOM_SETS)
        .map(([key, set]) => [key, set.label, ws.filter(set.matches).length])
        .filter(([, , n]) => n > 1),
      discs: [...discCounts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
      titles: [...titleCounts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
    };
  }, [current]);

  // The analysis runs in ~150ms, so it re-runs automatically on any input
  // change — debounced for date typing, sequence-guarded against
  // out-of-order responses. The previous result stays up while the next
  // one loads.
  const seqRef = useRef(0);
  useEffect(() => {
    if (!current) return;
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      setRunning(true);
      setError(null);
      const set = CUSTOM_SETS[selection];
      const base = { from, to, weightLbs: profile.weightLbs ?? '' };
      try {
        const data = await getPelotonFitness(current.dir, set
          ? {
            ...base,
            disciplines: set.disciplines.join(','),
            minSecs: set.minSecs, maxSecs: set.maxSecs,
            mergeGapMins: set.mergeGapMins,
          }
          : selection.startsWith('disc:')
            ? { ...base, discipline: selection.slice(5) }
            : { ...base, title: selection });
        if (seqRef.current === seq) setResult(data);
      } catch (e) {
        if (seqRef.current === seq) setError(e.message);
      } finally {
        if (seqRef.current === seq) setRunning(false);
      }
    }, 250);
    return () => clearTimeout(timer);
  }, [current, selection, from, to, profile]);

  const analysis = useMemo(() => {
    // Heart rate is the only hard requirement; workload metrics (EF, VO2,
    // HR@100W) appear when the discipline records a workload.
    const rides = (result?.rides || []).filter(r => r.avgHr != null);
    if (rides.length < 3) return null;
    const workloadKey = result.workloadKey;
    const t0 = new Date(rides[0].start).getTime();
    const tOf = r => (new Date(r.start).getTime() - t0) / DAY;
    const tMax = tOf(rides[rides.length - 1]);
    const mean = a => a.reduce((sum, v) => sum + v, 0) / a.length;

    // Dots for the raw points, least-squares line for the trend. Each point
    // carries its workout id so charts can open the workout on click.
    const scatter = key => {
      const pts = rides
        .map(r => ({ t: tOf(r), v: r[key], id: r.id, dateLabel: String(r.start).slice(0, 10) }))
        .filter(p => p.v != null);
      if (pts.length < 3) return null;
      const mx = mean(pts.map(p => p.t)), my = mean(pts.map(p => p.v));
      const slope = pts.reduce((sum, p) => sum + (p.t - mx) * (p.v - my), 0)
        / (pts.reduce((sum, p) => sum + (p.t - mx) ** 2, 0) || 1);
      const fit = t => my + slope * (t - mx);
      const sxx = pts.reduce((sum, p) => sum + (p.t - mx) ** 2, 0);
      const sse = pts.reduce((sum, p) => sum + (p.v - fit(p.t)) ** 2, 0);
      const df = pts.length - 2;
      let p = null;
      if (df > 0 && sse > 0 && sxx > 0) {
        const tStat = slope / Math.sqrt(sse / df / sxx);
        p = regIncBeta(df / 2, 0.5, df / (df + tStat * tStat));
      }
      return {
        series: [
          { samples: pts, dots: true, opacity: 0.75 },
          { samples: [{ t: 0, v: fit(0) }, { t: tMax, v: fit(tMax) }], width: 2.5 },
        ],
        // Percent per month against the fitted start value, so monthly and
        // total percentages share a base.
        slopePerMonth: (slope * 30.44 / fit(0)) * 100,
        fitStart: fit(0), fitEnd: fit(tMax),
        p,
      };
    };

    const ef = scatter('ef');
    const vo2 = scatter('vo2') || scatter('wAtHrMax');
    const vo2InMlKg = rides.some(r => r.vo2 != null);
    const hr100 = scatter('hrAt100');
    const output = scatter('avgOutput'), hrSc = scatter('avgHr'), dist = scatter('distance');
    const intensity = scatter('pctHrMax'), trimp = scatter('trimp');
    const sum = key => rides.reduce((total, r) => total + (r[key] || 0), 0);
    const hrs = rides.map(r => r.avgHr).filter(v => v != null).sort((a, b) => a - b);
    return {
      rides,
      workloadKey,
      hrMax: result.hrMax,
      efSeries: ef?.series, efP: ef?.p,
      outputSeries: output?.series, outputP: output?.p,
      hrSeries: hrSc?.series, hrP: hrSc?.p,
      distanceSeries: dist?.series, distanceP: dist?.p,
      vo2Series: vo2?.series, vo2P: vo2?.p,
      vo2InMlKg,
      vo2SlopePerMonth: vo2?.slopePerMonth,
      vo2FitStart: vo2?.fitStart, vo2FitEnd: vo2?.fitEnd,
      hr100Series: hr100?.series, hr100P: hr100?.p,
      hr100FitStart: hr100?.fitStart, hr100FitEnd: hr100?.fitEnd,
      intensitySeries: intensity?.series, intensityP: intensity?.p,
      intensityFitStart: intensity?.fitStart, intensityFitEnd: intensity?.fitEnd,
      trimpSeries: trimp?.series, trimpP: trimp?.p,
      slopePerMonth: ef?.slopePerMonth,
      efTotalPct: ef ? ((ef.fitEnd - ef.fitStart) / ef.fitStart) * 100 : null,
      fitStart: ef?.fitStart, fitEnd: ef?.fitEnd,
      totalDistance: sum('distance'),
      totalOutput: sum('totalOutput'),
      totalCalories: sum('calories'),
      medianHr: !hrs.length ? null
        : hrs.length % 2 ? hrs[(hrs.length - 1) / 2]
        : (hrs[hrs.length / 2 - 1] + hrs[hrs.length / 2]) / 2,
      spanDays: Math.round(tMax),
      xLeft: rides[0].start.slice(0, 10),
      xRight: rides[rides.length - 1].start.slice(0, 10),
      tipT: t => new Date(t0 + t * DAY).toLocaleDateString(undefined,
        { month: 'short', day: 'numeric', year: '2-digit' }),
    };
  }, [result]);

  // Charts ranked by trend significance — smallest p first — and laid out
  // two per row.
  const chartDefs = useMemo(() => {
    if (!analysis) return [];
    const speed = analysis.workloadKey === 'speed';
    return [
      analysis.efSeries && {
        key: 'ef', series: analysis.efSeries, color: '#c6fe28', p: analysis.efP,
        title: speed ? 'Efficiency (speed per heartbeat)' : 'Efficiency Factor',
        unit: `${speed ? 'MPH' : 'W'}/BPM · thick line = trend fit`,
      },
      analysis.intensitySeries && {
        key: 'intensity', series: analysis.intensitySeries, color: '#b48aff', p: analysis.intensityP,
        title: 'Intensity', unit: '%HRMAX · avg HR relative to your HRmax',
      },
      analysis.trimpSeries && {
        key: 'trimp', series: analysis.trimpSeries, color: '#e07b39', p: analysis.trimpP,
        title: 'Training Load (Edwards TRIMP)', unit: 'ZONE-WEIGHTED MINUTES',
      },
      analysis.vo2Series && {
        key: 'vo2', series: analysis.vo2Series, color: '#e0c341', p: analysis.vo2P,
        title: analysis.vo2InMlKg ? 'Estimated VO₂max' : 'Estimated Max Aerobic Power',
        unit: (analysis.vo2InMlKg ? 'ML/KG/MIN' : 'W') + ' · HR-vs-power extrapolated to personal HRmax',
        bands: analysis.vo2InMlKg ? vo2BandsFor(profile.age, profile.sex || 'm') : undefined,
      },
      analysis.hr100Series && {
        key: 'hr100', series: analysis.hr100Series, color: '#ff9d4d', p: analysis.hr100P,
        title: 'Predicted HR at 100W', unit: 'BPM · fixed workload, lower = fitter',
      },
      analysis.outputSeries && {
        key: 'output', series: analysis.outputSeries, color: '#4da3ff', p: analysis.outputP,
        title: speed ? 'Avg Speed (steady-state)' : 'Avg Output (steady-state)',
        unit: `${speed ? 'MPH' : 'W'} · thick line = trend fit`,
      },
      analysis.hrSeries && {
        key: 'hr', series: analysis.hrSeries, color: '#ff6b9d', p: analysis.hrP,
        title: 'Avg Heart Rate (steady-state)', unit: 'BPM · thick line = trend fit',
      },
      analysis.distanceSeries && {
        key: 'distance', series: analysis.distanceSeries, color: '#3fd8c7', p: analysis.distanceP,
        title: 'Distance', unit: 'MI · thick line = trend fit',
      },
    ].filter(Boolean).sort((a, b) => (a.p ?? 1) - (b.p ?? 1));
  }, [analysis, profile]);

  return (
    <section className={s.fitness}>
      <div className={s.headRow}>
        {header}
        <div className={s.fitControls}>
        <select className={s.fitInput} value={selection} onChange={e => setSelection(e.target.value)}>
          <option value="">all workouts · {options.total}</option>
          {options.sets.length > 0 && (
            <optgroup label="Sets">
              {options.sets.map(([key, label, n]) => (
                <option key={key} value={key}>{label} · {n}</option>
              ))}
            </optgroup>
          )}
          <optgroup label="Disciplines">
            {options.discs.map(([d, n]) => (
              <option key={d} value={`disc:${d}`}>{d} · {n}</option>
            ))}
          </optgroup>
          <optgroup label="Classes">
            {options.titles.map(([t, n]) => <option key={t} value={t}>{t} · {n}</option>)}
          </optgroup>
        </select>
        <input className={s.fitInput} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <span className={s.fitDash}>→</span>
        <input className={s.fitInput} type="date" value={to} onChange={e => setTo(e.target.value)} />
        {running && <span className={s.fitDash}>updating…</span>}
        </div>
      </div>

      {error && <div className={s.error}>analysis failed: {error}</div>}
      {result && !analysis && (
        <p className={s.intro}>
          Only {result.rides.filter(r => r.avgHr != null).length} workout(s) with heart-rate
          data in this range — need at least 3 for a trend. (A heart-rate monitor must have
          been paired during the workout.)
        </p>
      )}

      {analysis && (
        <>
          <div className={s.topGrid}>
          {/* Topline: how much did I train, and am I getting fitter?
              Everything else (per-metric fits, p-values) lives on the
              ranked charts below. */}
          <div className={s.stats}>
            <Stat label="workouts" value={analysis.rides.length} />
            <Stat label="span" value={analysis.spanDays} unit="days" />
            {analysis.efSeries && (
              <>
                <Stat
                  label="EF trend"
                  value={`${analysis.slopePerMonth >= 0 ? '+' : ''}${analysis.slopePerMonth.toFixed(1)}%`}
                  unit={`/month · ${fmtP(analysis.efP)}`}
                />
                <Stat
                  label="EF total"
                  value={`${analysis.efTotalPct >= 0 ? '+' : ''}${analysis.efTotalPct.toFixed(1)}%`}
                />
              </>
            )}
            {!analysis.efSeries && analysis.intensitySeries && (
              <Stat
                label="intensity fit (%HRmax)"
                value={`${analysis.intensityFitStart.toFixed(0)}% → ${analysis.intensityFitEnd.toFixed(0)}%`}
                unit={fmtP(analysis.intensityP)}
              />
            )}
            {analysis.vo2Series && analysis.vo2InMlKg && (
              <Stat
                label="est. VO₂max"
                value={`${analysis.vo2FitStart.toFixed(1)} → ${analysis.vo2FitEnd.toFixed(1)}`}
                unit="ml/kg/min"
              />
            )}
            <Stat
              label="distance"
              value={analysis.totalDistance ? analysis.totalDistance.toFixed(1) : null}
              unit="mi"
            />
            <Stat
              label="calories"
              value={analysis.totalCalories ? analysis.totalCalories.toLocaleString() : null}
              unit="kcal"
            />
          </div>
          <ZoneDays rides={analysis.rides} onOpenWorkout={onOpenWorkout}
            hoverId={hoverId} onHover={onHoverPoint} fill />
          </div>
          <div className={s.chartsScroll} style={{ height: chartsH }}>
            <div className={s.chartGrid}>
              {chartDefs.map(d => (
                <LineChart
                  key={d.key}
                  title={d.title} unit={`${d.unit} · ${fmtP(d.p)}`}
                  seriesList={d.series} color={d.color} bands={d.bands}
                  xLabelLeft={analysis.xLeft} xLabel={analysis.xRight}
                  onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT}
                  hoverId={hoverId} onHover={onHoverPoint}
                />
              ))}
            </div>
            <p className={s.intro}>
              charts ranked by trend significance · p-values are two-tailed OLS slope
              tests and assume independent rides; back-to-back rides share day effects
              (heat, hydration, fatigue), so treat them as approximate.
            </p>
          </div>
          <div className={s.divider} onPointerDown={onDividerDown} title="drag to resize">
            <span className={s.dividerGrip} />
          </div>
        </>
      )}

      <div className={s.bottomPane}>
      <div className={s.chips}>
        <button
          className={s.chip + (tab === 'table' || !analysis ? ` ${s.chipActive}` : '')}
          onClick={() => setTab('table')}
        >
          Workouts · {workouts.length}
        </button>
        {analysis && (
          <button
            className={s.chip + (tab === 'splom' ? ` ${s.chipActive}` : '')}
            onClick={() => setTab('splom')}
          >
            Correlations
          </button>
        )}
        {analysis && (
          <button
            className={s.chip + (tab === 'hr' ? ` ${s.chipActive}` : '')}
            onClick={() => setTab('hr')}
          >
            Heartrates
          </button>
        )}
      </div>

      <div className={s.paneScroll + (tab === 'hr' && analysis ? ` ${s.paneFill}` : '')}>
      {tab === 'hr' && analysis ? (
        (() => {
          // Every selected workout's HR trace start→finish on one time
          // axis over the zone bands (same metaphor as the workout modal).
          // The date scrubber picks a from→to window; traces inside it
          // draw at 0.8, the rest fade to 0.2. Defaults to the last month.
          const withHr = analysis.rides.filter(r => r.hr?.length > 1);
          if (!withHr.length) {
            return <p className={s.intro}>No heart-rate traces in this selection.</p>;
          }
          const n = withHr.length;
          const dates = withHr.map(r => new Date(r.start).getTime());
          const dMin = dates[0], dMax = dates[n - 1];
          const raw = hrRange ?? [Math.max(dMin, dMax - 30 * DAY), dMax];
          const lo = Math.max(dMin, Math.min(dMax, raw[0]));
          const hi = Math.max(lo, Math.min(dMax, raw[1]));
          const inSel = i => dates[i] >= lo && dates[i] <= hi;
          const selCount = dates.filter(t => t >= lo && t <= hi).length;
          const trace = r => r.hr.map(([t, v]) => ({ t, v }));
          const bands = analysis.hrMax
            ? ZONE_COLORS.map((c, z) => ({
              from: ZONE_EDGES[z] * analysis.hrMax,
              to: ZONE_EDGES[z + 1] * analysis.hrMax,
              color: c,
              label: `Z${z + 1}`,
            }))
            : undefined;
          return (
            <>
              <div className={s.hrScrubRow}>
                <DateBrush dates={dates} value={[lo, hi]} onChange={setHrRange} />
                <span className={s.fitDash}>
                  {fmtDay(lo)} → {fmtDay(hi)} · {selCount} of {n}
                </span>
              </div>
              <LineChart
                title="Heart Rate"
                unit={`BPM · every workout start → finish · zones vs HRmax ${analysis.hrMax ?? '?'} · scrub a date window`}
                seriesList={[
                  ...withHr.filter((r, i) => !inSel(i)).map(r => ({
                    samples: trace(r), opacity: 0.2, width: 1,
                  })),
                  ...withHr.filter((r, i) => inSel(i)).map(r => ({
                    samples: trace(r), opacity: 0.8, width: 1.4,
                  })),
                ]}
                color="#e8e8e0"
                bands={bands}
                fill
                xLabelLeft="0:00"
                xLabel={fmtZone(Math.max(...withHr.map(r => r.hr[r.hr.length - 1][0])))}
                tipT={t => fmtZone(Math.max(0, Math.round(t)))}
              />
            </>
          );
        })()
      ) : tab === 'splom' && analysis ? (
        <Splom
          data={analysis.rides}
          onPointClick={r => onOpenWorkout(r.id)}
          hoverId={hoverId} onHover={onHoverPoint}
          fields={[
            { key: 'ef', label: 'EF' },
            { key: 'avgOutput', label: 'Avg W' },
            { key: 'avgHr', label: 'Avg HR' },
            { key: 'maxHr', label: 'Max HR' },
            { key: 'distance', label: 'Dist' },
            { key: 'strive', label: 'Strive' },
          ]}
        />
      ) : (
        <>
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Date</th><th>Discipline</th><th>Class</th><th>Instructor</th>
                <th className={shared.num}>Length</th>
                <th className={shared.num}>Output</th>
                <th className={shared.num}>Cal</th>
                <th className={shared.num}>Avg HR</th>
              </tr>
            </thead>
            <tbody>
              {workouts.map(w => (
                <tr
                  key={w.id}
                  className={s.row + (selectedId === w.id ? ` ${s.rowActive}` : '')}
                  onClick={() => onOpenWorkout(w.id)}
                >
                  <td>{fmtDay(w.start)}</td>
                  <td>{w.discipline}</td>
                  <td>{w.title || '—'}</td>
                  <td>{instructorOf(w) || '—'}</td>
                  <td className={shared.num}>{fmtLen(w.duration_secs)}</td>
                  <td className={shared.num}>{summary(w, 'total_output') ?? '—'}</td>
                  <td className={shared.num}>{summary(w, 'calories') ?? '—'}</td>
                  <td className={shared.num}>{w.avg_heart_rate ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!workouts.length && <p className={s.intro}>No workouts match this filter.</p>}
        </>
      )}
      </div>
      </div>
    </section>
  );
}

export default function Peloton() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [userIdx, setUserIdx] = useState(0);
  // Unified analysis selection: '' (all), a CUSTOM_SETS key, 'disc:<name>',
  // or a class title. Drives both the fitness panel and the workout table.
  const [selection, setSelection] = useState('');
  const [selected, setSelected] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
  // Body-activity popover on the header's mini figure.
  const [muscleTip, setMuscleTip] = useState(false);
  const selectedIdRef = useRef(null);


  useEffect(() => {
    getPelotonWorkouts().then(setUsers).catch(e => setError(e.message));
  }, []);

  const current = users?.[userIdx];

  // Personal HRmax reference for zone boundaries: 3rd-highest per-workout
  // max, robust against a single strap spike.
  const hrMaxRef = useMemo(() => {
    const pool = (current?.workouts || [])
      .map(w => w.max_heart_rate).filter(v => v > 0).sort((a, b) => b - a);
    return pool.length ? pool[Math.min(2, pool.length - 1)] : null;
  }, [current]);

  // Default the selection to the flagship repeatable class when it exists.
  useEffect(() => {
    const n = (current?.workouts || []).filter(w => w.title === '20 min Beginner Ride').length;
    setSelection(n > 1 ? '20 min Beginner Ride' : '');
  }, [current]);

  const matcher = useMemo(() => {
    if (!selection) return () => true;
    if (CUSTOM_SETS[selection]) return CUSTOM_SETS[selection].matches;
    if (selection.startsWith('disc:')) {
      const d = selection.slice(5);
      return w => w.discipline === d;
    }
    return w => (w.title || '') === selection;
  }, [selection]);

  const workouts = useMemo(
    () => (current?.workouts || []).filter(matcher),
    [current, matcher]
  );

  const select = w => {
    setSelected(w);
    setMetrics(null);
    setMuscleTip(false);
    selectedIdRef.current = w?.id ?? null;
    if (!w) return;
    setMetricsLoading(true);
    // Ignore responses for a workout the user has already clicked away from.
    getPelotonMetrics(current.dir, w.id)
      .then(data => { if (selectedIdRef.current === w.id) setMetrics(data); })
      .catch(() => {
        if (selectedIdRef.current === w.id) setMetrics({ metrics: [], muscles: [], error: true });
      })
      .finally(() => { if (selectedIdRef.current === w.id) setMetricsLoading(false); });
  };

  const switchUser = i => {
    setUserIdx(i);
    select(null);
  };

  // Chart points carry workout ids; clicking one opens that workout's
  // detail modal (for merged sessions, the first recording).
  const openById = id => {
    const w = (current?.workouts || []).find(x => String(x.id) === String(id));
    if (w) select(w);
  };

  // Modal behavior: Escape closes, page scroll locks while open.
  useEffect(() => {
    if (!selected) return;
    const onKey = e => { if (e.key === 'Escape') select(null); };
    window.addEventListener('keydown', onKey);
    // Locking scroll removes the page scrollbar; pad by its width so the
    // content doesn't shift sideways while the modal is open.
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  // Missing seconds stay in the series as nulls so LineChart draws gaps
  // instead of bridging them; sub-floor HR readings count as missing too.
  const charts = useMemo(() => {
    if (!metrics?.metrics?.length) return [];
    return METRICS
      .map(m => ({
        ...m,
        samples: metrics.metrics.map(r => {
          let v = r[m.key] ?? null;
          if (m.key === 'heart_rate' && v != null && v < HR_FLOOR) v = null;
          return { t: r.second, v };
        }),
      }))
      .filter(m => m.samples.filter(p => p.v != null).length > 1);
  }, [metrics]);

  const muscles = useMemo(
    () => (metrics?.muscles || [])
      .map(m => ({ name: muscleName(m), value: muscleValue(m), type: muscleTypeOf(m) }))
      .filter(m => m.value > 0)
      .sort((a, b) => b.value - a.value),
    [metrics]
  );

  if (error) {
    return <main className={s.main}><div className={s.error}>peloton data unavailable: {error}</div></main>;
  }
  if (!users) return <main className={s.main} />;
  if (!users.length) {
    return (
      <main className={s.main}>
        <h2 className={shared.title}>Peloton Explorer</h2>
        <p className={s.intro}>
          No Peloton backups yet — run one from the <strong>Backup</strong> tab and this page
          will browse the snapshot: every workout, filterable by discipline, with per-second
          output, cadence, resistance, speed, and heart-rate charts.
        </p>
      </main>
    );
  }

  return (
    <main className={s.main}>
      {selected && (
        <div className={s.modalOverlay} onClick={() => select(null)}>
        <section className={`${s.detail} ${s.modal}`} onClick={e => e.stopPropagation()}>
          <div className={s.detailHead}>
            <div className={s.detailMain}>
              <div className={s.detailTitle}>{selected.title || selected.discipline}</div>
              <div className={s.detailSub}>
                {[instructorOf(selected), fmtDay(selected.start), fmtLen(selected.duration_secs)]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
            {muscles.length > 0 && (
              <div
                className={s.bodyMini}
                onMouseEnter={() => setMuscleTip(true)}
                onMouseLeave={() => setMuscleTip(false)}
              >
                {/* body-muscles misrenders below ~50px wide, so draw at its
                    natural size and scale the box down. */}
                <div className={s.bodyMiniScale}>
                  <MuscleHighlight
                    compact
                    primary={muscles.filter(m => m.value >= 20 && m.type).map(m => m.type)}
                    secondary={muscles.filter(m => m.value >= 5 && m.value < 20 && m.type).map(m => m.type)}
                  />
                </div>
                {muscleTip && (
                  <div className={s.bodyTip}>
                    <div className={s.muscleRow}>
                      <MuscleHighlight
                        primary={muscles.filter(m => m.value >= 20 && m.type).map(m => m.type)}
                        secondary={muscles.filter(m => m.value >= 5 && m.value < 20 && m.type).map(m => m.type)}
                      />
                      <div className={s.muscleBars}>
                        <div className={s.muscleTitle}>Body Activity</div>
                        {muscles.map(m => (
                          <div key={m.name} className={s.muscleBar}>
                            <span className={s.muscleName}>{m.name}</span>
                            <div className={s.muscleTrack}>
                              <div className={s.muscleFill} style={{ width: `${Math.min(m.value, 100)}%` }} />
                            </div>
                            <span className={s.musclePct}>{Math.round(m.value)}%</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
            <button className={shared.btn} onClick={() => select(null)}>Close</button>
          </div>
          {/* Topline only — per-metric averages live on the charts below. */}
          <div className={s.stats}>
            <Stat label="strive score" value={selected.strive_score} />
            <Stat label="total output" value={summary(selected, 'total_output')} unit="kJ" />
            <Stat label="distance" value={summary(selected, 'distance')} unit="mi" />
            <Stat label="calories" value={summary(selected, 'calories')} unit="kcal" />
            <Stat label="avg heart rate" value={selected.avg_heart_rate} unit="BPM" />
          </div>

          <div className={s.modalScroll}>
          {metricsLoading && <p className={s.intro}>loading per-second metrics…</p>}
          {!metricsLoading && metrics && !charts.length && (
            <p className={s.intro}>
              {metrics.error
                ? 'Could not load metrics for this workout — check the server log.'
                : 'No per-second metrics recorded for this workout.'}
            </p>
          )}
          <div className={s.charts}>
            {(() => {
              // HR leads the modal, drawn as a neutral line over Peloton's
              // zone bands so the zones carry the color story.
              const hr = charts.find(m => m.key === 'heart_rate');
              if (!hr || !hrMaxRef) return null;
              // Time spent in each zone lives on the band label itself.
              const bands = ZONE_COLORS.map((c, z) => {
                const secs = selected[`hr_z${z + 1}_secs`];
                return {
                  from: ZONE_EDGES[z] * hrMaxRef,
                  to: ZONE_EDGES[z + 1] * hrMaxRef,
                  color: c,
                  label: secs > 0 ? `Z${z + 1} ${fmtZone(secs)}` : `Z${z + 1}`,
                };
              });
              return (
                <LineChart
                  title="Heart Rate"
                  unit={`BPM · zones vs HRmax ${hrMaxRef}`}
                  seriesList={[{ samples: hr.samples, width: 1.8 }]}
                  color="#e8e8e0"
                  bands={bands}
                  xLabel={fmtLen(selected.duration_secs)}
                  xLabelLeft="0:00"
                  tipT={t => fmtZone(Math.max(0, Math.round(t)))}
                />
              );
            })()}
          </div>
          <div className={s.modalChartGrid}>
            {charts.filter(m => m.key !== 'heart_rate' || !hrMaxRef).map(m => (
              <LineChart
                key={m.key}
                title={m.title}
                unit={m.unit}
                seriesList={[{ samples: m.samples }]}
                color={m.color}
                fillFirst
                xLabel={fmtLen(selected.duration_secs)}
                xLabelLeft="0:00"
                tipT={t => fmtZone(Math.max(0, Math.round(t)))}
              />
            ))}
          </div>
          </div>
        </section>
        </div>
      )}

      <FitnessPanel
        current={current}
        selection={selection}
        setSelection={setSelection}
        onOpenWorkout={openById}
        workouts={workouts}
        selectedId={selected?.id}
        header={(
          <div>
            <h2 className={shared.title}>
              Peloton Explorer <span>· snapshot {fmtDay(current.createdAt)}</span>
            </h2>
            {users.length > 1 && (
              <div className={s.chips}>
                {users.map((u, i) => (
                  <button
                    key={u.user}
                    className={s.chip + (i === userIdx ? ` ${s.chipActive}` : '')}
                    onClick={() => switchUser(i)}
                  >
                    {u.user}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      />
    </main>
  );
}
