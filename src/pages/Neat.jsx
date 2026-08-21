import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthNeat, getHealthDay } from '../api.js';
import LineChart from '../components/LineChart.jsx';
import BarChart, { MetricToggles } from '../components/BarChart.jsx';
import WeekBrush from '../components/WeekBrush.jsx';
import shared from '../styles/shared.module.css';
import s from './Peloton.module.css';
import n from './Neat.module.css';

const DAY = 86_400_000;
const ROLL = 28; // rolling-average window (days)

// Overall daily-activity signals. NEAT energy = active energy minus the energy
// logged to formal workouts, isolating non-exercise activity.
const METRICS = [
  { key: 'neat_energy', label: 'NEAT Energy', unit: 'kcal', color: '#c6fe28', round: 0 },
  { key: 'active_energy', label: 'Active Energy', unit: 'kcal', color: '#ff6b9d', round: 0 },
  { key: 'steps', label: 'Steps', unit: '', color: '#4da3ff', round: 0 },
  { key: 'distance', label: 'Distance', unit: 'mi', color: '#3fd8c7', round: 1 },
  { key: 'flights', label: 'Flights', unit: '', color: '#e0c341', round: 0 },
  { key: 'exercise_min', label: 'Exercise', unit: 'min', color: '#b48aff', round: 0 },
  { key: 'stand_min', label: 'Stand', unit: 'hrs', color: '#f78e1e', round: 1, transform: v => v / 60 },
];

const parseTs = iso => iso ? new Date(String(iso) + 'T00:00:00').getTime() : NaN;
const fmtDay = ms => new Date(ms).toLocaleDateString(undefined, { year: '2-digit', month: 'short', day: 'numeric' });
const fmtNum = (v, round) => v == null ? '—'
  : round === 0 ? Math.round(v).toLocaleString()
  : Number(v).toFixed(round);

function weekStart(ms) {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return +d;
}

function Stat({ label, value, unit }) {
  return (
    <div className={s.stat}>
      <div className={s.statValue}>{value}{unit && <small> {unit}</small>}</div>
      <div className={s.statLabel}>{label}</div>
    </div>
  );
}

export default function Neat() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [metricKey, setMetricKey] = useState('neat_energy');
  const [win, setWin] = useState(null); // [loMs, hiMs] scrub window for the daily detail
  const [hoverId, setHoverId] = useState(null); // hovered day (ms) in the detail chart
  const [dayDate, setDayDate] = useState(null); // YYYY-MM-DD opened in the day-view modal
  const [dayData, setDayData] = useState(null);
  const [dayLoading, setDayLoading] = useState(false);
  const dayRef = useRef(null);

  useEffect(() => {
    getHealthNeat()
      .then(data => setRows(data.map(r => ({ ...r, ms: parseTs(r.day) }))))
      .catch(e => setError(e.message));
  }, []);

  const openDay = date => {
    setDayDate(date); setDayData(null); dayRef.current = date;
    setDayLoading(true);
    getHealthDay(date)
      .then(d => { if (dayRef.current === date) setDayData(d); })
      .catch(() => { if (dayRef.current === date) setDayData({ error: true }); })
      .finally(() => { if (dayRef.current === date) setDayLoading(false); });
  };
  const closeDay = () => { setDayDate(null); setDayData(null); dayRef.current = null; };

  // Modal: Escape closes, page scroll locks while open.
  useEffect(() => {
    if (!dayDate) return;
    const onKey = e => { if (e.key === 'Escape') closeDay(); };
    window.addEventListener('keydown', onKey);
    const sb = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sb > 0) document.body.style.paddingRight = `${sb}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [dayDate]);

  // Default the scrub window to the last ~6 months once data loads.
  useEffect(() => {
    if (rows?.length) {
      const last = rows[rows.length - 1].ms;
      setWin([Math.max(rows[0].ms, last - 183 * DAY), last]);
    }
  }, [rows]);

  const metric = METRICS.find(m => m.key === metricKey);
  const valueOf = r => {
    const raw = r[metric.key];
    if (raw == null) return null;
    const v = Number(raw);
    return metric.transform ? metric.transform(v) : v;
  };

  const firstMs = rows?.length ? rows[0].ms : 0;
  const lastMs = rows?.length ? rows[rows.length - 1].ms : 0;
  const tIdx = ms => (ms - firstMs) / DAY; // days since first — the shared x axis

  const allTs = useMemo(() => (rows || []).map(r => r.ms), [rows]);

  // Steps-per-day detail for the scrubbed window (dots + 7-day rolling line).
  const detail = useMemo(() => {
    if (!rows?.length || !win) return null;
    const [lo, hi] = win;
    const inWin = rows.filter(r => r.ms >= lo && r.ms <= hi);
    // Window-relative t (LineChart pins its x-domain to 0, so absolute day
    // indices would bunch the window against the right edge).
    const daily = inWin.map(r => ({ t: (r.ms - lo) / DAY, v: valueOf(r), id: r.ms, date: r.day, dateLabel: fmtDay(r.ms) }));
    const roll = [];
    let sum = 0, cnt = 0; const q = [];
    for (const d of daily) {
      q.push(d.v);
      if (d.v != null) { sum += d.v; cnt++; }
      if (q.length > 7) { const o = q.shift(); if (o != null) { sum -= o; cnt--; } }
      roll.push({ t: d.t, v: cnt ? sum / cnt : null });
    }
    // Dots must exclude null days: LineChart's voronoi maps every dot to a
    // pixel, and a null value yields NaN coords that crash Delaunay.
    const dots = daily.filter(p => p.v != null);
    return {
      seriesList: [
        { samples: dots, dots: true, opacity: 0.5 },
        ...(dots.length > 7 ? [{ samples: roll, width: 2.2 }] : []),
      ],
      count: dots.length, from: fmtDay(lo), to: fmtDay(hi),
      tipT: t => fmtDay(lo + t * DAY), // t is relative to the window start, not firstMs
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, win, metricKey]);

  // Weekly-average bars across the FULL history — the scrub surface itself.
  const weeklyBars = useMemo(() => {
    if (!rows?.length) return [];
    const byWeek = new Map();
    for (const r of rows) {
      const v = valueOf(r);
      if (v == null) continue;
      const wk = weekStart(r.ms);
      const b = byWeek.get(wk) || { sum: 0, cnt: 0 };
      b.sum += v; b.cnt++; byWeek.set(wk, b);
    }
    return [...byWeek.entries()].sort((a, b) => a[0] - b[0])
      .map(([wk, b]) => ({ ms: wk, v: b.sum / b.cnt }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, metricKey]);

  // Summary tiles: recent vs all-time daily averages + best day.
  const summary = useMemo(() => {
    if (!rows?.length) return null;
    const statsFor = subset => {
      const vals = subset.map(valueOf).filter(v => v != null);
      if (!vals.length) return null;
      const total = vals.reduce((a, v) => a + v, 0);
      return { avg: total / vals.length, best: Math.max(...vals), total, days: vals.length };
    };
    const inWin = win ? rows.filter(r => r.ms >= win[0] && r.ms <= win[1]) : rows;
    return { all: statsFor(rows), sel: statsFor(inWin) };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, win, metricKey]);

  if (error) return <main className={n.main}><div className={s.error}>Apple Health data unavailable: {error}</div></main>;
  if (!rows) return <main className={n.main} />;
  if (!rows.length) {
    return (
      <main className={n.main}>
        <h2 className={shared.title}>NEAT</h2>
        <p className={n.lead}>
          No Apple Health data yet — ingest an <strong>export.zip</strong> from the <strong>Sync</strong> tab.
        </p>
      </main>
    );
  }

  const u = metric.unit ? ` ${metric.unit}` : '';
  const dayTitle = dayDate
    ? new Date(dayDate + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    : '';
  const hhmm = mins => `${Math.floor(mins / 60)}:${String(Math.round(mins) % 60).padStart(2, '0')}`;

  return (
    <main className={n.main}>
      {dayDate && (
        <div className={s.modalOverlay} onClick={closeDay}>
          <section className={`${s.detail} ${s.modal}`} onClick={e => e.stopPropagation()}>
            <div className={s.detailHead}>
              <div className={s.detailMain}>
                <div className={s.detailTitle}>{dayTitle}</div>
                <div className={s.detailSub}>
                  {dayData?.metrics
                    ? `Watch worn ${dayData.metrics.hr_hours}h · ${dayData.workouts.length} workout${dayData.workouts.length === 1 ? '' : 's'}`
                    : dayLoading ? 'loading…' : ''}
                </div>
              </div>
              <button className={shared.btn} onClick={closeDay}>Close</button>
            </div>

            {dayData?.error && <p className={n.lead}>Could not load this day.</p>}
            {dayData?.metrics && (() => {
              const dm = dayData.metrics;
              // Anchor the HR axis to the whole day (0–1440 min) with null
              // sentinels so a partial-wear day shows its samples at the right
              // time of day instead of stretched across the full width.
              const hrPts = (dayData.hr || []).map(r => ({ t: Number(r.t), v: Number(r.v) })).filter(p => isFinite(p.v));
              const dayHr = hrPts.length > 1 ? [{ t: 0, v: null }, ...hrPts, { t: 1440, v: null }] : [];
              const stepsBy = new Map((dayData.hourly || []).map(x => [Number(x.hour), Number(x.steps) || 0]));
              const activeBy = new Map((dayData.hourly || []).map(x => [Number(x.hour), Number(x.active) || 0]));
              const stepBars = Array.from({ length: 24 }, (_, h) => ({ label: h % 6 === 0 ? `${h}:00` : '', a: stepsBy.get(h) || 0 }));
              const activeBars = Array.from({ length: 24 }, (_, h) => ({ label: h % 6 === 0 ? `${h}:00` : '', a: activeBy.get(h) || 0 }));
              const hasSteps = stepBars.some(b => b.a > 0);
              const hasActive = activeBars.some(b => b.a > 0);
              return (
                <>
                  <div className={s.stats}>
                    <Stat label="NEAT energy" value={fmtNum(dm.neat_energy, 0)} unit="kcal" />
                    <Stat label="active energy" value={fmtNum(dm.active_energy, 0)} unit="kcal" />
                    <Stat label="steps" value={fmtNum(dm.steps, 0)} />
                    <Stat label="distance" value={dm.distance != null ? Number(dm.distance).toFixed(1) : null} unit="mi" />
                    <Stat label="flights" value={dm.flights != null ? Math.round(dm.flights) : null} />
                    <Stat label="exercise" value={dm.exercise_min != null ? Math.round(dm.exercise_min) : null} unit="min" />
                    <Stat label="stand" value={dm.stand_min != null ? (dm.stand_min / 60).toFixed(1) : null} unit="hrs" />
                    <Stat label="workout energy" value={fmtNum(dm.workout_energy, 0)} unit="kcal" />
                    <Stat label="watch worn" value={dm.hr_hours} unit="h" />
                  </div>

                  <div className={s.modalScroll}>
                    {dayData.workouts.length > 0 && (
                      <table className={shared.table}>
                        <thead>
                          <tr><th>Time</th><th>Activity</th><th className={shared.num}>Length</th><th className={shared.num}>Avg HR</th><th className={shared.num}>Max HR</th></tr>
                        </thead>
                        <tbody>
                          {dayData.workouts.map(w => (
                            <tr key={w.idx}>
                              <td>{new Date(String(w.start).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00')).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}</td>
                              <td>{humanize(w.activity)}</td>
                              <td className={shared.num}>{fmtMin(w.duration)}</td>
                              <td className={shared.num}>{w.avg_hr ?? '—'}</td>
                              <td className={shared.num}>{w.max_hr ?? '—'}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                    {dayHr.length > 0 && (
                      <div className={s.charts}>
                        <LineChart
                          title="Heart Rate" unit="BPM · through the day"
                          seriesList={[{ samples: dayHr, width: 1.6 }]} color="#ff6b9d"
                          xLabelLeft="0:00" xLabel="24:00" tipT={t => hhmm(t)}
                        />
                      </div>
                    )}
                    {(hasSteps || hasActive) && (
                      <div className={s.modalChartGrid}>
                        {hasSteps && (
                          <div>
                            <div className={n.sub} style={{ marginBottom: 6 }}>Steps by hour</div>
                            <BarChart bars={stepBars} fmt={v => (v >= 1 ? Math.round(v).toLocaleString() : '')} />
                          </div>
                        )}
                        {hasActive && (
                          <div>
                            <div className={n.sub} style={{ marginBottom: 6 }}>Active energy by hour · kcal</div>
                            <BarChart bars={activeBars} fmt={v => (v >= 1 ? Math.round(v) : '')} />
                          </div>
                        )}
                      </div>
                    )}
                    {!dayHr.length && !hasSteps && !hasActive && dayData.workouts.length === 0 && (
                      <p className={n.lead}>No intraday detail recorded for this day.</p>
                    )}
                  </div>
                </>
              );
            })()}
          </section>
        </div>
      )}

      <h2 className={shared.title}>NEAT <span>· non-exercise activity</span></h2>
      <p className={n.lead}>
        Your <strong>overall daily movement</strong> from Apple Health — everything outside logged workouts.
        <strong> NEAT energy</strong> is each day's active energy minus the calories attributed to formal
        workouts, so it tracks the background activity (walking around, stairs, fidgeting) that drives most
        non-exercise burn.
      </p>

      <div className={n.toggles}>
        <MetricToggles options={METRICS} value={metricKey} onChange={setMetricKey} />
      </div>

      {summary && (
        <div className={n.statBlocks}>
          <div className={n.statBlock}>
            <div className={n.statBlockLabel}>All time</div>
            <div className={s.stats}>
              <Stat label="avg / day" value={fmtNum(summary.all?.avg, metric.round)} unit={metric.unit} />
              <Stat label="best day" value={fmtNum(summary.all?.best, metric.round)} unit={metric.unit} />
              <Stat label="total" value={fmtNum(summary.all?.total, 0)} unit={metric.unit} />
              <Stat label="tracked days" value={summary.all?.days?.toLocaleString()} />
            </div>
          </div>
          <div className={n.statBlock}>
            <div className={n.statBlockLabel}>
              Selected {detail ? <span className={n.range}>· {detail.from} → {detail.to}</span> : ''}
            </div>
            <div className={s.stats}>
              <Stat label="avg / day" value={fmtNum(summary.sel?.avg, metric.round)} unit={metric.unit} />
              <Stat label="best day" value={fmtNum(summary.sel?.best, metric.round)} unit={metric.unit} />
              <Stat label="total" value={fmtNum(summary.sel?.total, 0)} unit={metric.unit} />
              <Stat label="days" value={summary.sel?.days?.toLocaleString()} />
            </div>
          </div>
        </div>
      )}

      <section className={n.section}>
        <div className={n.sectionHead}>
          <h2 className={shared.title}>{metric.label} · per day</h2>
          <span className={n.sub}>
            {detail ? `${detail.from} → ${detail.to} · ${detail.count} days` : ''} · dots = each day · line = 7-day avg
          </span>
        </div>
        {detail && (
          <LineChart
            title={metric.label} unit={metric.unit || 'per day'}
            seriesList={detail.seriesList} color={metric.color}
            xLabelLeft={detail.from} xLabel={detail.to} tipT={detail.tipT}
            onPointClick={p => p.date && openDay(p.date)} hoverId={hoverId} onHover={setHoverId}
          />
        )}
      </section>

      <section className={n.section}>
        <div className={n.sectionHead}>
          <h2 className={shared.title}>Weekly average</h2>
          <span className={n.sub}>
            full history · mean {metric.label.toLowerCase()}{u} per day · drag across the bars to scrub the per-day view
          </span>
        </div>
        {win && weeklyBars.length > 1 && (
          <WeekBrush
            weeks={weeklyBars} value={win} onChange={setWin} color={metric.color}
            fmt={v => fmtNum(v, metric.round)} tipT={ms => fmtDay(ms)}
          />
        )}
        <div className={n.axisRow}>
          <span>{fmtDay(firstMs)}</span><span>{fmtDay(lastMs)}</span>
        </div>
      </section>
    </main>
  );
}
