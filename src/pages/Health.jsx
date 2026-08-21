import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthFitness, getHealthWorkouts, getHealthWorkoutSeries, getHealthWatchWear, getHealthTrainer, getProfile } from '../api.js';
import DateBrush, { COL_A, COL_B, COL_AB } from '../components/DateBrush.jsx';
import LineChart from '../components/LineChart.jsx';
import Splom from '../components/Splom.jsx';
import WatchWear from '../components/WatchWear.jsx';
import ZoneDays, { ZONE_COLORS } from '../components/ZoneDays.jsx';
import { regIncBeta, fmtP } from '../lib/stats.js';
import shared from '../styles/shared.module.css';
import s from './Peloton.module.css';
import h from './Health.module.css';

const DAY = 86_400_000;
const HR_FLOOR = 30;
const ZONE_EDGES = [0, 0.65, 0.75, 0.85, 0.95, 1.06];

// Per-second metric charts shown in the workout modal (cycling records these).
const MODAL_METRICS = [
  { key: 'CyclingPower', title: 'Output', unit: 'W', color: '#4da3ff' },
  { key: 'CyclingCadence', title: 'Cadence', unit: 'RPM', color: '#3fd8c7' },
  { key: 'CyclingSpeed', title: 'Speed', unit: 'MPH', color: '#c6fe28' },
  { key: 'RunningSpeed', title: 'Speed', unit: 'MPH', color: '#c6fe28' },
  { key: 'RunningPower', title: 'Power', unit: 'W', color: '#4da3ff' },
];

const humanize = a => String(a || '').replace(/([a-z])([A-Z])/g, '$1 $2');
const fmtMin = min => {
  if (min == null) return '—';
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};
const fmtZone = secs => `${Math.floor(secs / 60)}:${String(Math.round(secs) % 60).padStart(2, '0')}`;
// DuckDB emits "2026-08-17 19:59:20-07" — space separator + colon-less offset,
// both of which JS Date rejects. Normalize to ISO before parsing.
const parseTs = iso => iso ? new Date(String(iso).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')) : null;
const fmtDay = iso => {
  const d = parseTs(iso);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' }) : '—';
};
const fmtDay2 = iso => {
  const d = parseTs(iso);
  return d && !isNaN(d) ? d.toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: '2-digit' }) : '—';
};

const tsOf = r => parseTs(r.start)?.getTime() ?? NaN;
const within = (win, t) => !!win && t >= win[0] && t <= win[1];

// VO2max fitness-tier boundaries (ml/kg/min) by sex and age decade.
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

function Stat({ label, value, unit }) {
  if (value == null || value === '') return null;
  return (
    <div className={s.stat}>
      <div className={s.statValue}>{value}{unit && <small> {unit}</small>}</div>
      <div className={s.statLabel}>{label}</div>
    </div>
  );
}

// Raw per-workout cardio analysis: every workout is its own data point, trend
// from a least-squares fit. Ported from the Peloton FitnessPanel, sourced from
// /api/health/fitness (HR from HealthKit samples, workload from cycling power).
function FitnessPanel({ selection, setSelection, options, bundles, bundleIdxs, onOpenWorkout, header, workouts, selectedId, wear }) {
  const [winA, setWinA] = useState(null);
  const [winB, setWinB] = useState(null);
  const [profile, setProfile] = useState({});
  useEffect(() => { getProfile().then(setProfile).catch(() => {}); }, []);
  const [result, setResult] = useState(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState(null);
  const [hoverId, setHoverId] = useState(null);
  const onHoverPoint = id => setHoverId(prev => (prev === id ? prev : id));
  const [tab, setTab] = useState('table');
  const [chartsH, setChartsH] = useState(() => Math.max(260, Math.round((window.innerHeight || 900) * 0.34)));
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

  const seqRef = useRef(0);
  useEffect(() => {
    const seq = ++seqRef.current;
    const timer = setTimeout(async () => {
      setRunning(true);
      setError(null);
      try {
        const data = await getHealthFitness(bundleIdxs?.length
          ? { idxs: bundleIdxs, weightLbs: profile.weightLbs ?? '' }
          : { activity: selection, weightLbs: profile.weightLbs ?? '' });
        if (seqRef.current === seq) setResult(data);
      } catch (e) {
        if (seqRef.current === seq) setError(e.message);
      } finally {
        if (seqRef.current === seq) setRunning(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [selection, profile, bundleIdxs]);

  const analyzeRides = (filter, tagA, tagB) => {
    const rides = (result?.rides || []).filter(r => r.avgHr != null && (!filter || filter(tsOf(r))));
    if (!rides.length) return null;
    const tagging = !!(tagA || tagB);
    const t0 = tsOf(rides[0]);
    const tOf = r => (tsOf(r) - t0) / DAY;
    const tMax = tOf(rides[rides.length - 1]);
    const mean = a => a.reduce((sum, v) => sum + v, 0) / a.length;

    const scatter = key => {
      const pts = rides
        .map(r => {
          const t = tsOf(r);
          const a = within(tagA, t), b = within(tagB, t);
          return {
            t: tOf(r), v: r[key], id: r.id, dateLabel: String(r.start).slice(0, 10),
            ...(tagging ? {
              color: a && b ? COL_AB : a ? COL_A : b ? COL_B : undefined,
              opacity: a || b ? 0.95 : 0.2,
            } : {}),
          };
        })
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
      // Base the trend line and percentages on the metric's ACTUAL data span,
      // not the global t0. A metric like EF/power that only exists for recent
      // cycling workouts would otherwise extrapolate back to the first HR-only
      // workout (years earlier) and produce a negative/garbage baseline.
      const ptsT = pts.map(p => p.t);
      const tLo = Math.min(...ptsT), tHi = Math.max(...ptsT);
      return {
        series: [
          { samples: pts, dots: true, opacity: 0.75 },
          { samples: [{ t: tLo, v: fit(tLo) }, { t: tHi, v: fit(tHi) }], width: 2.5 },
        ],
        slopePerMonth: (slope * 30.44 / fit(tLo)) * 100,
        fitStart: fit(tLo), fitEnd: fit(tHi),
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
      hrMax: result.hrMax,
      efSeries: ef?.series, efP: ef?.p,
      outputSeries: output?.series, outputP: output?.p,
      hrSeries: hrSc?.series, hrP: hrSc?.p,
      distanceSeries: dist?.series, distanceP: dist?.p,
      vo2Series: vo2?.series, vo2P: vo2?.p,
      vo2InMlKg,
      vo2SlopePerMonth: vo2?.slopePerMonth, vo2FitStart: vo2?.fitStart, vo2FitEnd: vo2?.fitEnd,
      hr100Series: hr100?.series, hr100P: hr100?.p,
      intensitySeries: intensity?.series, intensityP: intensity?.p,
      intensityFitStart: intensity?.fitStart, intensityFitEnd: intensity?.fitEnd,
      trimpSeries: trimp?.series, trimpP: trimp?.p,
      slopePerMonth: ef?.slopePerMonth,
      efTotalPct: ef ? ((ef.fitEnd - ef.fitStart) / ef.fitStart) * 100 : null,
      fitStart: ef?.fitStart, fitEnd: ef?.fitEnd,
      totalCalories: sum('calories'),
      totalDistance: sum('distance'),
      medianHr: !hrs.length ? null
        : hrs.length % 2 ? hrs[(hrs.length - 1) / 2]
        : (hrs[hrs.length / 2 - 1] + hrs[hrs.length / 2]) / 2,
      spanDays: Math.round(tMax),
      xLeft: String(rides[0].start).slice(0, 10),
      xRight: String(rides[rides.length - 1].start).slice(0, 10),
      tipT: t => new Date(t0 + t * DAY).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: '2-digit' }),
    };
  };

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const analysisFull = useMemo(() => analyzeRides(null, winA, winB), [result, winA, winB]);
  const analysis = analysisFull && analysisFull.rides.length >= 3 ? analysisFull : null;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statsA = useMemo(() => (winA ? analyzeRides(t => within(winA, t)) : null), [result, winA]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const statsB = useMemo(() => (winB ? analyzeRides(t => within(winB, t)) : null), [result, winB]);
  const anyWin = !!(winA || winB);

  const rideTs = useMemo(() => (result?.rides || []).filter(r => r.avgHr != null).map(tsOf), [result]);
  const dMin = rideTs[0], dMax = rideTs[rideTs.length - 1];
  const toggleA = () => setWinA(w => w ? null : [Math.max(dMin, dMax - 60 * DAY), Math.max(dMin, dMax - 30 * DAY)]);
  const toggleB = () => setWinB(w => w ? null : [Math.max(dMin, dMax - 30 * DAY), dMax]);
  const clampWin = w => {
    if (!w || !rideTs.length) return w;
    const lo = Math.max(dMin, Math.min(dMax, w[0]));
    return [lo, Math.max(lo, Math.min(dMax, w[1]))];
  };
  const wA = clampWin(winA), wB = clampWin(winB);

  const ab = get => {
    if (!anyWin) return analysis ? get(analysis) : null;
    return (
      <span className={s.abVals}>
        {winA && <span style={{ color: COL_A }}>{(statsA && get(statsA)) ?? '—'}</span>}
        {winB && <span style={{ color: COL_B }}>{(statsB && get(statsB)) ?? '—'}</span>}
      </span>
    );
  };

  const chartDefs = useMemo(() => {
    if (!analysis) return [];
    return [
      analysis.efSeries && {
        key: 'ef', series: analysis.efSeries, color: '#c6fe28', p: analysis.efP,
        title: 'Efficiency Factor', unit: 'W/BPM · thick line = trend fit',
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
        title: 'Avg Output (steady-state)', unit: 'W · thick line = trend fit',
      },
      analysis.hrSeries && {
        key: 'hr', series: analysis.hrSeries, color: '#ff6b9d', p: analysis.hrP,
        title: 'Avg Heart Rate (steady-state)', unit: 'BPM · thick line = trend fit',
      },
    ].filter(Boolean).sort((a, b) => (a.p ?? 1) - (b.p ?? 1));
  }, [analysis, profile]);

  return (
    <section className={s.fitness}>
      <div className={s.headRow}>
        {header}
        <div className={s.fitControls}>
          <select className={s.fitInput} value={selection} onChange={e => setSelection(e.target.value)}>
            <option value="">all activities · {options.total}</option>
            {bundles && (bundles.all > 0 || bundles.confirmed > 0) && (
              <optgroup label="Trainer sessions">
                {bundles.all > 0 && <option value="trainer:all">All trainer sessions · {bundles.all}</option>}
                {bundles.confirmed > 0 && <option value="trainer:confirmed">Confirmed trainer sessions · {bundles.confirmed}</option>}
              </optgroup>
            )}
            <optgroup label="Activities">
              {options.activities.map(([a, n]) => (
                <option key={a} value={a}>{humanize(a)} · {n}</option>
              ))}
            </optgroup>
          </select>
          <button
            className={s.chip + (winA ? ` ${s.chipActive}` : '')}
            style={winA ? { borderColor: COL_A, color: COL_A } : undefined}
            onClick={toggleA} disabled={!rideTs.length} title="toggle compare window A"
          >A</button>
          <button
            className={s.chip + (winB ? ` ${s.chipActive}` : '')}
            style={winB ? { borderColor: COL_B, color: COL_B } : undefined}
            onClick={toggleB} disabled={!rideTs.length} title="toggle compare window B"
          >B</button>
          {running && <span className={s.fitDash}>updating…</span>}
        </div>
      </div>

      {anyWin && (
        <div className={s.brushRows}>
          {wA && (
            <div className={s.hrScrubRow}>
              <span className={s.abTag} style={{ color: COL_A }}>A</span>
              <DateBrush dates={rideTs} value={wA} onChange={setWinA} color={COL_A} height={30} />
              <span className={`${s.fitDash} ${s.brushLabel}`} style={{ color: COL_A }}>
                {fmtDay2(new Date(wA[0]).toISOString())} → {fmtDay2(new Date(wA[1]).toISOString())} · {rideTs.filter(t => within(wA, t)).length}
              </span>
            </div>
          )}
          {wB && (
            <div className={s.hrScrubRow}>
              <span className={s.abTag} style={{ color: COL_B }}>B</span>
              <DateBrush dates={rideTs} value={wB} onChange={setWinB} color={COL_B} height={30} />
              <span className={`${s.fitDash} ${s.brushLabel}`} style={{ color: COL_B }}>
                {fmtDay2(new Date(wB[0]).toISOString())} → {fmtDay2(new Date(wB[1]).toISOString())} · {rideTs.filter(t => within(wB, t)).length}
              </span>
            </div>
          )}
        </div>
      )}

      {error && <div className={s.error}>analysis failed: {error}</div>}
      {result && !analysis && (
        <p className={s.intro}>
          Only {(result.rides || []).filter(r => r.avgHr != null).length} workout(s) with heart-rate
          data in this selection — need at least 3 for a trend. (An Apple Watch or paired monitor must
          have recorded heart rate.)
        </p>
      )}

      {analysis && (
        <>
          <div className={s.topGrid}>
            <div className={s.stats}>
              <Stat label="workouts" value={ab(a => a.rides.length)} />
              <Stat label="span" value={ab(a => a.spanDays)} unit="days" />
              {analysis.efSeries && (
                <>
                  <Stat label="EF trend" unit={anyWin ? '/month' : `/month · ${fmtP(analysis.efP)}`}
                    value={ab(a => a.slopePerMonth != null ? `${a.slopePerMonth >= 0 ? '+' : ''}${a.slopePerMonth.toFixed(1)}%` : null)} />
                  <Stat label="EF total"
                    value={ab(a => a.efTotalPct != null ? `${a.efTotalPct >= 0 ? '+' : ''}${a.efTotalPct.toFixed(1)}%` : null)} />
                </>
              )}
              {!analysis.efSeries && analysis.intensitySeries && (
                <Stat label="intensity fit (%HRmax)" unit={anyWin ? undefined : fmtP(analysis.intensityP)}
                  value={ab(a => a.intensityFitStart != null ? `${a.intensityFitStart.toFixed(0)}% → ${a.intensityFitEnd.toFixed(0)}%` : null)} />
              )}
              {analysis.vo2Series && analysis.vo2InMlKg && (
                <Stat label="est. VO₂max" unit="ml/kg/min"
                  value={ab(a => a.vo2InMlKg && a.vo2FitStart != null ? `${a.vo2FitStart.toFixed(1)} → ${a.vo2FitEnd.toFixed(1)}` : null)} />
              )}
              <Stat label="calories" unit="kcal"
                value={ab(a => a.totalCalories ? Math.round(a.totalCalories).toLocaleString() : null)} />
            </div>
            <ZoneDays rides={analysis.rides} onOpenWorkout={onOpenWorkout}
              hoverId={hoverId} onHover={onHoverPoint} fill winA={wA} winB={wB} />
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
              charts ranked by trend significance · p-values are two-tailed OLS slope tests and assume
              independent workouts; treat back-to-back sessions as approximate.
            </p>
          </div>
          <div className={s.divider} onPointerDown={onDividerDown} title="drag to resize">
            <span className={s.dividerGrip} />
          </div>
        </>
      )}

      <div className={s.bottomPane}>
        <div className={s.chips}>
          <button className={s.chip + (tab === 'table' || !analysis ? ` ${s.chipActive}` : '')} onClick={() => setTab('table')}>
            Workouts · {workouts.length}
          </button>
          {analysis && (
            <button className={s.chip + (tab === 'splom' ? ` ${s.chipActive}` : '')} onClick={() => setTab('splom')}>Correlations</button>
          )}
          {analysis && (
            <button className={s.chip + (tab === 'hr' ? ` ${s.chipActive}` : '')} onClick={() => setTab('hr')}>Heartrates</button>
          )}
          {wear?.length > 0 && (
            <button className={s.chip + (tab === 'wear' ? ` ${s.chipActive}` : '')} onClick={() => setTab('wear')}>Watch Wear</button>
          )}
        </div>

        <div className={s.paneScroll + (tab === 'hr' && analysis ? ` ${s.paneFill}` : '')}>
          {tab === 'hr' && analysis ? (
            (() => {
              const withHr = analysis.rides.filter(r => r.hr?.length > 1);
              if (!withHr.length) return <p className={s.intro}>No heart-rate traces in this selection.</p>;
              const dates = withHr.map(tsOf);
              const inA = i => within(wA, dates[i]);
              const inB = i => within(wB, dates[i]);
              const bands = analysis.hrMax
                ? ZONE_COLORS.map((c, z) => ({
                  from: ZONE_EDGES[z] * analysis.hrMax, to: ZONE_EDGES[z + 1] * analysis.hrMax, color: c, label: `Z${z + 1}`,
                }))
                : undefined;
              const trace = r => r.hr.map(([t, v]) => ({ t, v }));
              return (
                <LineChart
                  title="Heart Rate"
                  unit={`BPM · every workout start → finish · zones vs HRmax ${analysis.hrMax ?? '?'}${anyWin ? ' · colored by A/B window' : ''}`}
                  seriesList={anyWin
                    ? [
                      ...withHr.filter((r, i) => !inA(i) && !inB(i)).map(r => ({ samples: trace(r), opacity: 0.01, width: 1 })),
                      ...withHr.filter((r, i) => inA(i)).map(r => ({ samples: trace(r), color: COL_A, opacity: 0.65, width: 1.4 })),
                      ...withHr.filter((r, i) => inB(i)).map(r => ({ samples: trace(r), color: COL_B, opacity: 0.65, width: 1.4 })),
                    ]
                    : withHr.map(r => ({ samples: trace(r), opacity: 0.4, width: 1 }))}
                  color="#e8e8e0" bands={bands} fill
                  xLabelLeft="0:00"
                  xLabel={fmtZone(Math.max(...withHr.map(r => r.hr[r.hr.length - 1][0])))}
                  tipT={t => fmtZone(Math.max(0, Math.round(t)))}
                />
              );
            })()
          ) : tab === 'wear' && wear?.length > 0 ? (
            <WatchWear data={wear} />
          ) : tab === 'splom' && analysis ? (
            <Splom
              data={analysis.rides}
              onPointClick={r => onOpenWorkout(r.id)}
              hoverId={hoverId} onHover={onHoverPoint}
              pointStyle={anyWin ? r => {
                const t = tsOf(r);
                const a = within(wA, t), b = within(wB, t);
                return { color: a && b ? COL_AB : a ? COL_A : b ? COL_B : '#c6fe28', opacity: a || b ? 0.9 : 0.12 };
              } : undefined}
              fields={[
                { key: 'ef', label: 'EF' },
                { key: 'avgOutput', label: 'Avg W' },
                { key: 'avgHr', label: 'Avg HR' },
                { key: 'maxHr', label: 'Max HR' },
                { key: 'pctHrMax', label: '%HRmax' },
                { key: 'trimp', label: 'TRIMP' },
              ]}
            />
          ) : (
            <>
              <table className={shared.table}>
                <thead>
                  <tr>
                    <th>Date</th><th>Activity</th><th>Source</th>
                    <th className={shared.num}>Length</th>
                    <th className={shared.num}>Distance</th>
                    <th className={shared.num}>Steps</th>
                    <th className={shared.num}>Avg W</th>
                    <th className={shared.num}>Cal</th>
                    <th className={shared.num}>Avg HR</th>
                    <th className={shared.num}>Max HR</th>
                  </tr>
                </thead>
                <tbody>
                  {workouts.map(w => {
                    const t = tsOf(w);
                    const a = within(wA, t), b = within(wB, t);
                    const mark = a && b ? COL_AB : a ? COL_A : b ? COL_B : null;
                    return (
                      <tr
                        key={w.idx}
                        className={s.row + (String(selectedId) === String(w.idx) ? ` ${s.rowActive}` : '')}
                        style={anyWin ? { boxShadow: mark ? `inset 3px 0 0 ${mark}` : undefined, opacity: mark ? 1 : 0.4 } : undefined}
                        onClick={() => onOpenWorkout(w.idx)}
                      >
                        <td>{fmtDay(w.start)}</td>
                        <td>{humanize(w.activity)}</td>
                        <td>{w.source || '—'}</td>
                        <td className={shared.num}>{fmtMin(w.duration)}</td>
                        <td className={shared.num}>{w.distance != null ? `${Number(w.distance).toFixed(1)} ${w.distance_unit || ''}` : '—'}</td>
                        <td className={shared.num}>{w.steps ? Math.round(w.steps).toLocaleString() : '—'}</td>
                        <td className={shared.num}>{w.avgOutput != null ? Math.round(w.avgOutput) : '—'}</td>
                        <td className={shared.num}>{w.energy != null ? Math.round(w.energy).toLocaleString() : '—'}</td>
                        <td className={shared.num}>{w.avg_hr ?? '—'}</td>
                        <td className={shared.num}>{w.max_hr ?? '—'}</td>
                      </tr>
                    );
                  })}
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

export default function Health() {
  const [workouts, setWorkouts] = useState(null);
  const [wear, setWear] = useState([]);
  const [trainer, setTrainer] = useState(null);
  const [error, setError] = useState(null);
  const [selection, setSelection] = useState('');
  const [selected, setSelected] = useState(null);
  const [series, setSeries] = useState(null);
  const [seriesLoading, setSeriesLoading] = useState(false);
  const selRef = useRef(null);

  useEffect(() => {
    getHealthWorkouts().then(setWorkouts).catch(e => setError(e.message));
    getHealthWatchWear().then(setWear).catch(() => {});
    getHealthTrainer().then(setTrainer).catch(() => {});
  }, []);

  // Trainer-session bundles for the activity picker: analyze just those workouts
  // (one primary workout per session, dedup'd upstream). No session under 20min.
  const bundles = useMemo(() => {
    const ss = (trainer?.sessions || []).filter(x => x.hasWorkout && x.idx != null && x.duration >= 20);
    return { all: ss.map(x => x.idx), confirmed: ss.filter(x => x.source === 'confirmed').map(x => x.idx) };
  }, [trainer]);
  const bundleIdxs = useMemo(() =>
    selection === 'trainer:all' ? bundles.all
    : selection === 'trainer:confirmed' ? bundles.confirmed
    : null, [selection, bundles]);

  // Default the analysis population to Cycling (the modality with power), when present.
  useEffect(() => {
    if (!workouts) return;
    const n = workouts.filter(w => w.activity === 'Cycling').length;
    setSelection(n > 1 ? 'Cycling' : '');
  }, [workouts]);

  const options = useMemo(() => {
    const counts = new Map();
    for (const w of workouts || []) counts.set(w.activity, (counts.get(w.activity) || 0) + 1);
    return {
      total: (workouts || []).length,
      activities: [...counts.entries()].filter(([, n]) => n > 1).sort((a, b) => b[1] - a[1]),
    };
  }, [workouts]);

  const filtered = useMemo(() => {
    const list = workouts || [];
    if (bundleIdxs) {
      const set = new Set(bundleIdxs.map(String));
      return list.filter(w => set.has(String(w.idx)));
    }
    return list.filter(w => !selection || w.activity === selection);
  }, [workouts, selection, bundleIdxs]);

  // Personal HRmax reference for the modal's zone bands.
  const hrMaxRef = useMemo(() => {
    const pool = (workouts || []).map(w => Number(w.max_hr)).filter(v => v > 0).sort((a, b) => b - a);
    return pool.length ? pool[Math.min(2, pool.length - 1)] : null;
  }, [workouts]);

  const select = w => {
    setSelected(w);
    setSeries(null);
    selRef.current = w?.idx ?? null;
    if (!w) return;
    setSeriesLoading(true);
    // HR always; cycling/running metrics when present. Whichever have data render.
    const metrics = ['HeartRate', ...MODAL_METRICS.map(m => m.key)];
    Promise.all(metrics.map(m => getHealthWorkoutSeries(w.idx, m).catch(() => [])))
      .then(results => {
        if (selRef.current !== w.idx) return;
        const byMetric = {};
        metrics.forEach((m, i) => { byMetric[m] = results[i]; });
        setSeries(byMetric);
      })
      .finally(() => { if (selRef.current === w.idx) setSeriesLoading(false); });
  };

  const openById = id => {
    const w = (workouts || []).find(x => String(x.idx) === String(id));
    if (w) select(w);
  };

  useEffect(() => {
    if (!selected) return;
    const onKey = e => { if (e.key === 'Escape') select(null); };
    window.addEventListener('keydown', onKey);
    const scrollbar = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (scrollbar > 0) document.body.style.paddingRight = `${scrollbar}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [selected]);

  const seriesFor = (metric) => {
    const raw = series?.[metric] || [];
    return raw.map(r => {
      let v = Number(r.v);
      if (metric === 'HeartRate' && v < HR_FLOOR) v = null;
      return { t: Number(r.second), v };
    });
  };

  if (error) {
    return <main className={h.main}><div className={s.error}>Apple Health data unavailable: {error}</div></main>;
  }
  if (!workouts) return <main className={h.main} />;
  if (!workouts.length) {
    return (
      <main className={h.main}>
        <h2 className={shared.title}>Apple Health</h2>
        <p className={s.intro}>
          No Apple Health workouts yet — ingest an <strong>export.zip</strong> from the{' '}
          <strong>Sync</strong> tab and this page will analyze every workout: fitness trends, heart-rate
          zones, and correlations, filterable by activity.
        </p>
      </main>
    );
  }

  const hrSamples = seriesFor('HeartRate');
  const hrZoneBands = hrMaxRef
    ? ZONE_COLORS.map((c, z) => ({ from: ZONE_EDGES[z] * hrMaxRef, to: ZONE_EDGES[z + 1] * hrMaxRef, color: c, label: `Z${z + 1}` }))
    : undefined;
  const modalMetrics = MODAL_METRICS
    .map(m => ({ ...m, samples: seriesFor(m.key) }))
    .filter(m => m.samples.filter(p => p.v != null).length > 1);

  return (
    <main className={h.main}>
      {selected && (
        <div className={s.modalOverlay} onClick={() => select(null)}>
          <section className={`${s.detail} ${s.modal}`} onClick={e => e.stopPropagation()}>
            <div className={s.detailHead}>
              <div className={s.detailMain}>
                <div className={s.detailTitle}>{humanize(selected.activity)}</div>
                <div className={s.detailSub}>
                  {[fmtDay(selected.start), fmtMin(selected.duration), selected.source].filter(Boolean).join(' · ')}
                </div>
              </div>
              <button className={shared.btn} onClick={() => select(null)}>Close</button>
            </div>
            <div className={s.stats}>
              <Stat label="duration" value={fmtMin(selected.duration)} />
              <Stat label="avg heart rate" value={selected.avg_hr} unit="BPM" />
              <Stat label="max heart rate" value={selected.max_hr} unit="BPM" />
              {selected.distance != null && <Stat label="distance" value={Number(selected.distance).toFixed(2)} unit={selected.distance_unit} />}
              {selected.steps ? <Stat label="steps" value={Math.round(selected.steps).toLocaleString()} /> : null}
              {selected.energy != null && <Stat label="energy" value={Math.round(selected.energy).toLocaleString()} unit={selected.energy_unit} />}
            </div>

            <div className={s.modalScroll}>
              {seriesLoading && <p className={s.intro}>loading workout metrics…</p>}
              {!seriesLoading && hrSamples.filter(p => p.v != null).length <= 1 && !modalMetrics.length && (
                <p className={s.intro}>No per-sample metrics recorded during this workout.</p>
              )}
              {!seriesLoading && hrSamples.filter(p => p.v != null).length > 1 && (
                <div className={s.charts}>
                  <LineChart
                    title="Heart Rate" unit={`BPM · zones vs HRmax ${hrMaxRef ?? '?'}`}
                    seriesList={[{ samples: hrSamples, width: 1.8 }]}
                    color="#e8e8e0" bands={hrZoneBands}
                    xLabelLeft="0:00" xLabel={fmtZone((selected.duration || 0) * 60)}
                    tipT={t => fmtZone(Math.max(0, Math.round(t)))}
                  />
                </div>
              )}
              <div className={s.modalChartGrid}>
                {modalMetrics.map(m => (
                  <LineChart
                    key={m.key} title={m.title} unit={m.unit}
                    seriesList={[{ samples: m.samples }]} color={m.color} fillFirst
                    xLabelLeft="0:00" xLabel={fmtZone((selected.duration || 0) * 60)}
                    tipT={t => fmtZone(Math.max(0, Math.round(t)))}
                  />
                ))}
              </div>
            </div>
          </section>
        </div>
      )}

      <FitnessPanel
        selection={selection}
        setSelection={setSelection}
        options={options}
        bundles={{ all: bundles.all.length, confirmed: bundles.confirmed.length }}
        bundleIdxs={bundleIdxs}
        onOpenWorkout={openById}
        workouts={filtered}
        selectedId={selected?.idx}
        wear={wear}
        header={<h2 className={shared.title}>Apple Health <span>· {workouts.length} workouts</span></h2>}
      />
    </main>
  );
}
