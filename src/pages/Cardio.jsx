import { useEffect, useMemo, useState } from 'react';
import { getHealthCardio } from '../api.js';
import LineChart from '../components/LineChart.jsx';
import { MetricToggles } from '../components/BarChart.jsx';
import WeekBrush from '../components/WeekBrush.jsx';
import shared from '../styles/shared.module.css';
import s from './Peloton.module.css';
import n from './Neat.module.css';

const DAY = 86_400_000;

// Resting/recovery vitals that track aerobic fitness over months–years. `better`
// says which direction is progress, so the summary reports the right extreme.
const METRICS = [
  { key: 'resting_hr', label: 'Resting HR', unit: 'bpm', color: '#ff6b9d', round: 0, better: 'low' },
  { key: 'hrv', label: 'HRV (SDNN)', unit: 'ms', color: '#c6fe28', round: 0, better: 'high' },
  { key: 'vo2max', label: 'VO₂ Max', unit: 'mL/kg·min', color: '#4da3ff', round: 1, better: 'high' },
  { key: 'respiratory_rate', label: 'Respiratory Rate', unit: 'br/min', color: '#3fd8c7', round: 1, better: 'low' },
  { key: 'walking_hr', label: 'Walking HR', unit: 'bpm', color: '#f78e1e', round: 0, better: 'low' },
  { key: 'spo2', label: 'Blood Oxygen', unit: '%', color: '#b48aff', round: 1, better: 'high' },
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

export default function Cardio() {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [metricKey, setMetricKey] = useState('resting_hr');
  const [win, setWin] = useState(null);
  const [hoverId, setHoverId] = useState(null);

  useEffect(() => {
    getHealthCardio()
      .then(data => setRows(data.map(r => ({ ...r, ms: parseTs(r.day) }))))
      .catch(e => setError(e.message));
  }, []);

  // Default the scrub window to the last ~year once data loads.
  useEffect(() => {
    if (rows?.length) {
      const last = rows[rows.length - 1].ms;
      setWin([Math.max(rows[0].ms, last - 365 * DAY), last]);
    }
  }, [rows]);

  const metric = METRICS.find(m => m.key === metricKey);
  const valueOf = r => {
    const raw = r[metric.key];
    return raw == null ? null : Number(raw);
  };
  const bestOf = vals => metric.better === 'low' ? Math.min(...vals) : Math.max(...vals);

  const firstMs = rows?.length ? rows[0].ms : 0;
  const lastMs = rows?.length ? rows[rows.length - 1].ms : 0;

  // Per-day dots + 7-day rolling line for the scrubbed window.
  const detail = useMemo(() => {
    if (!rows?.length || !win) return null;
    const [lo, hi] = win;
    const inWin = rows.filter(r => r.ms >= lo && r.ms <= hi);
    const daily = inWin.map(r => ({ t: (r.ms - lo) / DAY, v: valueOf(r), id: r.ms, date: r.day }));
    const roll = [];
    let sum = 0, cnt = 0; const q = [];
    for (const d of daily) {
      q.push(d.v);
      if (d.v != null) { sum += d.v; cnt++; }
      if (q.length > 7) { const o = q.shift(); if (o != null) { sum -= o; cnt--; } }
      roll.push({ t: d.t, v: cnt ? sum / cnt : null });
    }
    const dots = daily.filter(p => p.v != null);
    return {
      seriesList: [
        { samples: dots, dots: true, opacity: 0.5 },
        ...(dots.length > 7 ? [{ samples: roll.filter(p => p.v != null), width: 2.2 }] : []),
      ],
      count: dots.length, from: fmtDay(lo), to: fmtDay(hi),
      tipT: t => fmtDay(lo + t * DAY),
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, win, metricKey]);

  // Weekly-average bars across the FULL history — the scrub surface.
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

  const summary = useMemo(() => {
    if (!rows?.length) return null;
    const statsFor = subset => {
      const vals = subset.map(valueOf).filter(v => v != null);
      if (!vals.length) return null;
      return { avg: vals.reduce((a, v) => a + v, 0) / vals.length, best: bestOf(vals), days: vals.length };
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
        <h2 className={shared.title}>Cardiovascular Fitness</h2>
        <p className={n.lead}>
          No Apple Health data yet — ingest an <strong>export.zip</strong> from the <strong>Sync</strong> tab.
        </p>
      </main>
    );
  }

  const u = metric.unit ? ` ${metric.unit}` : '';

  return (
    <main className={n.main}>
      <h2 className={shared.title}>Cardiovascular Fitness <span>· resting &amp; recovery vitals</span></h2>
      <p className={n.lead}>
        The long-run signals of <strong>aerobic fitness</strong> from Apple Health — measured at rest, not during
        workouts. <strong>Resting HR</strong> and <strong>HRV</strong> track recovery and autonomic balance day to
        day; <strong>VO₂ max</strong> is the headline estimate of aerobic capacity. Lower resting HR and respiratory
        rate, and higher HRV and VO₂ max, mean improving fitness.
      </p>

      <div className={n.toggles}>
        <MetricToggles options={METRICS} value={metricKey} onChange={setMetricKey} />
      </div>

      {summary && (
        <div className={n.statBlocks}>
          <div className={n.statBlock}>
            <div className={n.statBlockLabel}>All time</div>
            <div className={s.stats}>
              <Stat label="average" value={fmtNum(summary.all?.avg, metric.round)} unit={metric.unit} />
              <Stat label={metric.better === 'low' ? 'lowest' : 'highest'} value={fmtNum(summary.all?.best, metric.round)} unit={metric.unit} />
              <Stat label="tracked days" value={summary.all?.days?.toLocaleString()} />
            </div>
          </div>
          <div className={n.statBlock}>
            <div className={n.statBlockLabel}>
              Selected {detail ? <span className={n.range}>· {detail.from} → {detail.to}</span> : ''}
            </div>
            <div className={s.stats}>
              <Stat label="average" value={fmtNum(summary.sel?.avg, metric.round)} unit={metric.unit} />
              <Stat label={metric.better === 'low' ? 'lowest' : 'highest'} value={fmtNum(summary.sel?.best, metric.round)} unit={metric.unit} />
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
            hoverId={hoverId} onHover={setHoverId}
          />
        )}
      </section>

      <section className={n.section}>
        <div className={n.sectionHead}>
          <h2 className={shared.title}>Weekly average</h2>
          <span className={n.sub}>
            full history · mean {metric.label.toLowerCase()}{u} · drag across the bars to scrub the per-day view
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
