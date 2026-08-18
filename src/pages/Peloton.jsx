import { useEffect, useMemo, useRef, useState } from 'react';
import { getPelotonWorkouts, getPelotonMetrics, getPelotonFitness } from '../api.js';
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
const fmtHours = secs => secs < 3600
  ? `0h ${Math.round(secs / 60)}m`
  : (secs / 3600).toFixed(secs >= 36_000 ? 1 : 2);

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

// Peloton's zone boundaries as fractions of max HR: Z1 <65%, Z2 65-75%,
// Z3 75-85%, Z4 85-95%, Z5 95%+.
const ZONE_EDGES = [0, 0.65, 0.75, 0.85, 0.95, 1.06];

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
function FitnessPanel({ current, discipline, onOpenWorkout }) {
  const [title, setTitle] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [weight, setWeight] = useState(() => localStorage.getItem('peloWeightLbs') || '');
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  // Shared point-hover: the hovered workout id, mirrored by every chart.
  const [hoverId, setHoverId] = useState(null);
  const onHoverPoint = id => setHoverId(prev => (prev === id ? prev : id));

  const titles = useMemo(() => {
    const counts = new Map();
    for (const w of current?.workouts || []) {
      if (discipline !== 'all' && w.discipline !== discipline) continue;
      const t = w.title || '(untitled)';
      counts.set(t, (counts.get(t) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [current, discipline]);

  useEffect(() => {
    setResult(null);
    setTitle(titles.find(([t]) => t === '20 min Beginner Ride') ? '20 min Beginner Ride' : '');
  }, [titles]);

  const run = async () => {
    setRunning(true);
    setError(null);
    localStorage.setItem('peloWeightLbs', weight);
    const set = CUSTOM_SETS[title];
    try {
      setResult(await getPelotonFitness(current.dir, set
        ? {
          from, to, weightLbs: weight,
          disciplines: set.disciplines.join(','),
          minSecs: set.minSecs, maxSecs: set.maxSecs,
          mergeGapMins: set.mergeGapMins,
        }
        : {
          title, from, to, weightLbs: weight,
          discipline: discipline === 'all' ? '' : discipline,
        }));
    } catch (e) {
      setError(e.message);
    } finally {
      setRunning(false);
    }
  };

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
    const zoneTotals = [0, 1, 2, 3, 4].map(i =>
      rides.reduce((total, r) => total + (r.zones?.[i] || 0), 0));
    const hrs = rides.map(r => r.avgHr).filter(v => v != null).sort((a, b) => a - b);
    return {
      rides,
      workloadKey,
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
      zoneTotals,
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

  return (
    <section className={s.fitness}>
      <h2 className={shared.title}>Cardio Fitness <span>· raw per-ride, no smoothing</span></h2>
      <div className={s.fitControls}>
        <select className={s.fitInput} value={title} onChange={e => setTitle(e.target.value)}>
          <option value="">all classes{discipline !== 'all' ? ` (${discipline})` : ''}</option>
          {Object.entries(CUSTOM_SETS).map(([key, set]) => (
            <option key={key} value={key}>
              {set.label} · {(current?.workouts || []).filter(set.matches).length}
            </option>
          ))}
          {titles.map(([t, n]) => <option key={t} value={t}>{t} · {n}</option>)}
        </select>
        <input className={s.fitInput} type="date" value={from} onChange={e => setFrom(e.target.value)} />
        <span className={s.fitDash}>→</span>
        <input className={s.fitInput} type="date" value={to} onChange={e => setTo(e.target.value)} />
        <input
          className={`${s.fitInput} ${s.fitWeight}`} type="number" min="50" max="500"
          placeholder="weight lbs" title="Body weight, used only for the VO₂max estimate"
          value={weight} onChange={e => setWeight(e.target.value)}
        />
        <button className={shared.btn} onClick={run} disabled={running}>
          {running ? 'Running…' : 'Run Analysis'}
        </button>
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
          <div className={s.stats}>
            <Stat label="rides" value={analysis.rides.length} />
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
                <Stat
                  label="EF fit start → end"
                  value={`${analysis.fitStart.toFixed(3)} → ${analysis.fitEnd.toFixed(3)}`}
                />
              </>
            )}
            {analysis.intensitySeries && (
              <Stat
                label="intensity fit (%HRmax)"
                value={`${analysis.intensityFitStart.toFixed(0)}% → ${analysis.intensityFitEnd.toFixed(0)}%`}
                unit={fmtP(analysis.intensityP)}
              />
            )}
            {analysis.zoneTotals.some(v => v > 0) && analysis.zoneTotals.map((secs, i) => (
              <Stat
                key={i}
                label={`zone ${i + 1} total`}
                value={secs > 0 ? fmtHours(secs) : null}
                unit={secs >= 3600 ? 'h' : null}
              />
            ))}
            <Stat
              label="distance traveled"
              value={analysis.totalDistance ? analysis.totalDistance.toFixed(1) : null}
              unit="mi"
            />
            <Stat
              label="median avg HR"
              value={analysis.medianHr ? Math.round(analysis.medianHr) : null}
              unit="bpm"
            />
            <Stat
              label="total output"
              value={analysis.totalOutput ? analysis.totalOutput.toLocaleString() : null}
              unit="kJ"
            />
            <Stat
              label="total calories"
              value={analysis.totalCalories ? analysis.totalCalories.toLocaleString() : null}
              unit="kcal"
            />
            {analysis.vo2Series && (
              <>
                <Stat
                  label={analysis.vo2InMlKg ? 'est. VO₂max fit' : 'est. max power fit'}
                  value={`${analysis.vo2FitStart.toFixed(1)} → ${analysis.vo2FitEnd.toFixed(1)}`}
                  unit={analysis.vo2InMlKg ? 'ml/kg/min' : 'W'}
                />
                <Stat
                  label="VO₂ proxy trend"
                  value={`${analysis.vo2SlopePerMonth >= 0 ? '+' : ''}${analysis.vo2SlopePerMonth.toFixed(1)}%`}
                  unit={`/month · ${fmtP(analysis.vo2P)}`}
                />
              </>
            )}
            {analysis.hr100Series && (
              <Stat
                label="HR @ 100W fit (lower = fitter)"
                value={`${analysis.hr100FitStart.toFixed(1)} → ${analysis.hr100FitEnd.toFixed(1)}`}
                unit={`bpm · ${fmtP(analysis.hr100P)}`}
              />
            )}
          </div>
          <div className={s.charts}>
            <ZoneDays rides={analysis.rides} onOpenWorkout={onOpenWorkout}
              hoverId={hoverId} onHover={onHoverPoint} />
            {analysis.efSeries && (
              <LineChart
                title={analysis.workloadKey === 'speed' ? 'Efficiency (speed per heartbeat)' : 'Efficiency Factor'}
                unit={`${analysis.workloadKey === 'speed' ? 'MPH' : 'W'}/BPM · thick line = trend fit · ${fmtP(analysis.efP)}`}
                seriesList={analysis.efSeries} color="#c6fe28"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.intensitySeries && (
              <LineChart
                title="Intensity" unit={`%HRMAX · avg HR relative to your HRmax · ${fmtP(analysis.intensityP)}`}
                seriesList={analysis.intensitySeries} color="#b48aff"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.trimpSeries && (
              <LineChart
                title="Training Load (Edwards TRIMP)"
                unit={`ZONE-WEIGHTED MINUTES · ${fmtP(analysis.trimpP)}`}
                seriesList={analysis.trimpSeries} color="#e07b39"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.vo2Series && (
              <LineChart
                title={analysis.vo2InMlKg ? 'Estimated VO₂max' : 'Estimated Max Aerobic Power'}
                unit={(analysis.vo2InMlKg ? 'ML/KG/MIN' : 'W')
                  + ` · HR-vs-power extrapolated to personal HRmax · ${fmtP(analysis.vo2P)}`}
                seriesList={analysis.vo2Series} color="#e0c341"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.hr100Series && (
              <LineChart
                title="Predicted HR at 100W"
                unit={`BPM · fixed workload, lower = fitter · ${fmtP(analysis.hr100P)}`}
                seriesList={analysis.hr100Series} color="#ff9d4d"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.outputSeries && (
              <LineChart
                title={analysis.workloadKey === 'speed' ? 'Avg Speed (steady-state)' : 'Avg Output (steady-state)'}
                unit={`${analysis.workloadKey === 'speed' ? 'MPH' : 'W'} · thick line = trend fit · ${fmtP(analysis.outputP)}`}
                seriesList={analysis.outputSeries} color="#4da3ff"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.hrSeries && (
              <LineChart
                title="Avg Heart Rate (steady-state)" unit={`BPM · thick line = trend fit · ${fmtP(analysis.hrP)}`}
                seriesList={analysis.hrSeries} color="#ff6b9d"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
            {analysis.distanceSeries && (
              <LineChart
                title="Distance" unit={`MI · thick line = trend fit · ${fmtP(analysis.distanceP)}`}
                seriesList={analysis.distanceSeries} color="#3fd8c7"
                xLabelLeft={analysis.xLeft} xLabel={analysis.xRight} onPointClick={p => onOpenWorkout(p.id)} tipT={analysis.tipT} hoverId={hoverId} onHover={onHoverPoint}
              />
            )}
          </div>
          <p className={s.intro}>
            p-values are two-tailed OLS slope tests and assume independent rides;
            back-to-back rides share day effects (heat, hydration, fatigue), so
            treat them as approximate.
          </p>
          <h2 className={shared.title}>Metric Correlations <span>· scatterplot matrix</span></h2>
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
        </>
      )}
    </section>
  );
}

export default function Peloton() {
  const [users, setUsers] = useState(null);
  const [error, setError] = useState(null);
  const [userIdx, setUserIdx] = useState(0);
  const [discipline, setDiscipline] = useState('all');
  const [selected, setSelected] = useState(null);
  const [metrics, setMetrics] = useState(null);
  const [metricsLoading, setMetricsLoading] = useState(false);
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

  const disciplines = useMemo(() => {
    const counts = new Map();
    for (const w of current?.workouts || []) {
      counts.set(w.discipline, (counts.get(w.discipline) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [current]);

  const workouts = useMemo(
    () => (current?.workouts || []).filter(w => discipline === 'all' || w.discipline === discipline),
    [current, discipline]
  );

  const select = w => {
    setSelected(w);
    setMetrics(null);
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
    setDiscipline('all');
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
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected]);

  const charts = useMemo(() => {
    if (!metrics?.metrics?.length) return [];
    return METRICS
      .map(m => ({
        ...m,
        samples: metrics.metrics
          .filter(r => r[m.key] != null)
          .map(r => ({ t: r.second, v: r[m.key] })),
      }))
      .filter(m => m.samples.length > 1);
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
      <div className={s.headRow}>
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

      <div className={s.chips}>
        <button
          className={s.chip + (discipline === 'all' ? ` ${s.chipActive}` : '')}
          onClick={() => setDiscipline('all')}
        >
          all · {current.workouts.length}
        </button>
        {disciplines.map(([d, n]) => (
          <button
            key={d}
            className={s.chip + (discipline === d ? ` ${s.chipActive}` : '')}
            onClick={() => setDiscipline(d)}
          >
            {d} · {n}
          </button>
        ))}
      </div>

      {selected && (
        <div className={s.modalOverlay} onClick={() => select(null)}>
        <section className={`${s.detail} ${s.modal}`} onClick={e => e.stopPropagation()}>
          <div className={s.detailHead}>
            <div>
              <div className={s.detailTitle}>{selected.title || selected.discipline}</div>
              <div className={s.detailSub}>
                {[instructorOf(selected), fmtDay(selected.start), fmtLen(selected.duration_secs)]
                  .filter(Boolean).join(' · ')}
              </div>
            </div>
            <button className={shared.btn} onClick={() => select(null)}>Close</button>
          </div>
          <div className={s.stats}>
            <Stat label="strive score" value={selected.strive_score} />
            <Stat label="total output" value={summary(selected, 'total_output')} unit="kJ" />
            <Stat label="distance" value={summary(selected, 'distance')} unit="mi" />
            <Stat label="calories" value={summary(selected, 'calories')} unit="kcal" />
            {METRICS.map(m => (
              <Stat
                key={m.key}
                label={`avg ${m.title.toLowerCase()}`}
                value={selected[`avg_${m.key}`]}
                unit={m.unit}
              />
            ))}
            {[1, 2, 3, 4, 5].map(z => (
              <Stat
                key={z}
                label={`hr zone ${z}`}
                value={selected[`hr_z${z}_secs`] ? fmtZone(selected[`hr_z${z}_secs`]) : null}
              />
            ))}
          </div>

          {muscles.length > 0 && (
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
          )}
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
              const bands = ZONE_COLORS.map((c, z) => ({
                from: ZONE_EDGES[z] * hrMaxRef,
                to: ZONE_EDGES[z + 1] * hrMaxRef,
                color: c,
                label: `Z${z + 1}`,
              }));
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
        </section>
        </div>
      )}

      <FitnessPanel current={current} discipline={discipline} onOpenWorkout={openById} />

      <div className={s.tableWrap}>
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
                className={s.row + (selected?.id === w.id ? ` ${s.rowActive}` : '')}
                onClick={() => select(w)}
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
      </div>
    </main>
  );
}
