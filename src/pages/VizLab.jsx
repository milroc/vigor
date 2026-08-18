import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { runVoltra, getTelemetry, getTargets, listTelemetry } from '../api.js';
import LineChart from '../components/LineChart.jsx';
import ChartLegend from '../components/ChartLegend.jsx';
import { MuscleHighlight } from '../components/MuscleBody.jsx';
import ChatBot from '../components/ChatBot.jsx';
import RepCharts from '../components/RepCharts.jsx';
import RepSelector from '../components/RepSelector.jsx';
import {
  CHARTS, GRAY, GRID, KEYS, LBS_TO_N,
  repSeries, mockYear, buildTpl, mulberry32, synthRep, averageSetRep,
} from '../lib/repviz.js';
import s from './VizLab.module.css';

// Idealized single-arm press: math-generated template curves, no telemetry
// needed. Everything on this page is synthetic — it exists to iterate on the
// chart UI quickly.
function idealTemplate() {
  const u = Array.from({ length: GRID }, (_, i) => i / (GRID - 1));
  const hump = (x, skew) => Math.pow(Math.sin(Math.PI * Math.min(x / skew, 1) * skew), 0.9);
  const conV = u.map(x => 0.85 * hump(x, 1) * (1 - 0.15 * x));
  const eccV = u.map(x => -0.62 * hump(x, 1) * (1 - 0.1 * (1 - x)));
  const conF = u.map(x => 25 * (1 + 0.02 * Math.sin(2 * Math.PI * x)));
  const eccF = u.map(x => 38 * Math.pow(Math.sin(Math.PI * (0.08 + 0.84 * x)), 0.12));

  const durs = { conDur: 1.15, eccDur: 1.4 };
  const telem = {
    con: { velocity: conV, force: conF, power: conV.map((v, i) => conF[i] * LBS_TO_N * v) },
    ecc: { velocity: eccV, force: eccF, power: eccV.map((v, i) => eccF[i] * LBS_TO_N * v) },
  };
  return { telem, durs };
}

import { DEFAULT_PRESS_TARGETS, targetBands } from '../lib/repviz.js';

// Charts for a real movement: finds that movement's most recent workout
// with imported telemetry (the app records one workout per arm/pass, so a
// movement maps to several workout records).
function RealMovement({ actionId, movements, workouts, telemIds }) {
  const [telemetry, setTelemetry] = useState(undefined); // undefined=loading, null=none
  const [reps, setReps] = useState(null);
  const [targets, setTargets] = useState(null);

  const m = movements.find(x => String(x.actionId) === String(actionId));
  const mine = workouts
    .filter(w => w.actionIds?.includes(Number(actionId)))
    .sort((a, b) => (b.startTime || '').localeCompare(a.startTime || ''));
  const source = mine.find(w => telemIds.includes(w.id));

  useEffect(() => {
    let alive = true;
    setTelemetry(undefined); setReps(null);
    if (!source) { setTelemetry(null); return; }
    getTelemetry(source.id)
      .then(t => {
        if (!alive) return;
        const setId = Object.keys(t)[0];
        setTelemetry({ rows: t[setId] });
        runVoltra(['workout', 'reps', String(source.id), String(setId), '--json'])
          .then(r => alive && setReps(r)).catch(() => {});
      })
      .catch(() => alive && setTelemetry(null));
    getTargets()
      .then(all => alive && setTargets(all[m?.actionName] ?? null))
      .catch(() => {});
    return () => { alive = false; };
  }, [actionId, source?.id]);

  if (telemetry === undefined) return <p className={s.hint}>loading telemetry…</p>;
  if (telemetry !== null && !source) return null; // transient state mismatch guard
  if (telemetry === null) {
    return (
      <p className={s.hint}>
        {mine.length} {m?.actionName} workout{mine.length === 1 ? '' : 's'} on your account,
        none with imported rep telemetry yet
        {mine[0] && <> — open <Link to={`/workout/${mine[0].id}`}>the most recent one</Link> and import the Beyond+ session CSV</>}.
      </p>
    );
  }
  return (
    <>
      <p className={s.hint}>
        {m?.actionName} · {m?.setCount} sets · {m?.repCount} reps across {mine.length} workouts —
        showing the latest with telemetry ({(source.startTime || '').slice(0, 10)},{' '}
        <Link to={`/workout/${source.id}`}>full detail</Link>).
      </p>
      <RepCharts telemRows={telemetry.rows} apiReps={reps} targets={targets?.romM ? targets : null} />
    </>
  );
}


// Left-arm variant: non-dominant arm modeled at ~95% force x 97% velocity
// (~92% power), slightly reduced ROM.
const ARM_SCALE = { force: 0.95, velocity: 0.97, rom: 0.98 };
const scaleRepLeft = r => ({
  rom: r.rom.map(pt => ({ t: pt.t, v: pt.v * ARM_SCALE.rom })),
  force: r.force.map(pt => ({ t: pt.t, v: pt.v * ARM_SCALE.force })),
  velocity: r.velocity.map(pt => ({ t: pt.t, v: pt.v * ARM_SCALE.velocity })),
  power: r.power.map(pt => ({ t: pt.t, v: pt.v * ARM_SCALE.force * ARM_SCALE.velocity })),
});

export default function VizLab() {
  const [sel, setSel] = useState({ day: null, set: null, rep: null });
  const [chartSource, setChartSource] = useState('mock');
  const [arm, setArm] = useState('right');
  const [accountWorkouts, setAccountWorkouts] = useState([]);

  const [movements, setMovements] = useState([]);
  const [telemIds, setTelemIds] = useState([]);

  useEffect(() => {
    const end = new Date().toISOString().slice(0, 10);
    const start = new Date(Date.now() - 364 * 86400000).toISOString().slice(0, 10);
    runVoltra(['workout', 'aggregate-sets', '--start', start, '--end', end, '--json'])
      .then(d => setMovements(d.byAction || [])).catch(() => {});
    runVoltra(['workout', 'list', '--json', '--local-time', '--page-size', '50'])
      .then(d => setAccountWorkouts(d.list || [])).catch(() => {});
    listTelemetry().then(setTelemIds).catch(() => {});
  }, []);

  const { mock, bands, durs, catalog } = useMemo(() => {
    const avg = idealTemplate();
    const avgSeries = repSeries(avg.telem, avg.durs);
    const mock = mockYear(avg, avgSeries);
    const rng = mulberry32(4177);
    const perRep = Array.from({ length: 10 }, () => synthRep(mock.tpl, avg.durs, 0.99, rng, 30));
    const bands = targetBands(DEFAULT_PRESS_TARGETS);

    // A full mock year of workout days for the contribution calendar.
    // Only metadata here (dates, set/rep counts, seeds) — the actual rep
    // series for a day are generated lazily when it's selected.
    const DAY_MS = 86400000;
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const thisMonday = today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS;
    const days = [];
    for (let weeksAgo = 51; weeksAgo >= 1; weeksAgo--) {
      const consistency = (52 - weeksAgo) / 52;
      const wrng = mulberry32(7000 + weeksAgo);
      const sessions = 2 + (consistency > 0.4 ? 1 : 0) + (wrng() < consistency ? 1 : 0);
      const slots = [0, 2, 4, 5].slice(0, sessions); // Mon Wed Fri Sat
      for (const dow of slots) {
        const dateMs = thisMonday - weeksAgo * 7 * DAY_MS + dow * DAY_MS;
        const seed = 7000 + weeksAgo * 10 + dow;
        const drng = mulberry32(seed);
        const nSets = 2 + (drng() < 0.4 ? 1 : 0);
        const sets = Array.from({ length: nSets }, (_, i) => ({
          label: `Set ${i + 1}`, repCount: 8 + Math.floor(drng() * 5),
        }));
        days.push({
          dateMs, seed, p: consistency,
          label: new Date(dateMs).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }),
          sets, totalReps: sets.reduce((a, st) => a + st.repCount, 0),
        });
      }
    }
    days.push({
      dateMs: today.getTime(),
      label: 'Today',
      totalReps: 30,
      sets: [
        { label: 'Set 1', repCount: 10 },
        { label: 'Set 2', repCount: 10 },
        { label: 'Set 3', repCount: 10 },
      ],
      concrete: [mock.today.slice(0, 10), mock.today.slice(10, 20), perRep],
    });

    return { mock, bands, durs: avg.durs, catalog: days };
  }, []);

  // No explicit selection yet -> the latest set done (today's last set).
  // Memoized: a fresh object here would defeat coachData's memo every render.
  const eff = useMemo(() => sel.day == null
    ? { day: catalog.length - 1, set: catalog[catalog.length - 1].sets.length - 1, rep: null }
    : sel, [sel, catalog]);

  // Rep series for every set of the selected day, generated on demand.
  const daySets = useMemo(() => {
    const d = catalog[eff.day];
    if (d.concrete) return d.concrete;
    const rng = mulberry32(d.seed + 1);
    return d.sets.map(st =>
      Array.from({ length: st.repCount }, () => synthRep(mock.tpl, durs, d.p, rng, 24))
    );
  }, [eff.day, catalog, mock, durs]);

  const armSets = useMemo(
    () => (arm === 'left' ? daySets.map(set => set.map(scaleRepLeft)) : daySets),
    [daySets, arm]
  );
  const reps = eff.set != null ? armSets[eff.set] : [];
  const otherReps = armSets.flatMap((setReps, i) => (i === eff.set ? [] : setReps));

  // Left/right power balance for the selected set (right = generated base).
  const balance = useMemo(() => {
    const base = eff.set != null ? daySets[eff.set] : daySets[daySets.length - 1] ?? [];
    if (!base.length) return null;
    const meanPeak = rs => rs.reduce((a, r) => a + Math.max(...r.power.map(pt => pt.v)), 0) / rs.length;
    const rightW = Math.round(meanPeak(base));
    const leftW = Math.round(meanPeak(base.map(scaleRepLeft)));
    return { rightW, leftW, ratio: Math.round((leftW / rightW) * 100) };
  }, [daySets, eff.set]);
  const setAvg = useMemo(() => (reps.length ? averageSetRep(reps) : null), [reps]);
  const showcase = eff.rep != null ? reps[eff.rep] : null;

  // Grounded context for the coach: everything we know, summarized.
  const coachData = useMemo(() => {
    const r2 = x => Math.round(x * 100) / 100;
    const summarize = ser => {
      const conV = ser.velocity.filter(p => p.t <= 0).map(p => p.v);
      const eccV = ser.velocity.filter(p => p.t > 0).map(p => p.v);
      return {
        mcvMs: r2(conV.reduce((a, b) => a + b, 0) / Math.max(conV.length, 1)),
        peakVelMs: r2(Math.max(...ser.velocity.map(p => p.v))),
        meanEccVelMs: r2(eccV.reduce((a, b) => a + b, 0) / Math.max(eccV.length, 1)),
        romPeakM: r2(Math.max(...ser.rom.map(p => p.v))),
        peakPowerW: Math.round(Math.max(...ser.power.map(p => p.v))),
        conDurS: r2(-Math.min(...ser.velocity.map(p => p.t))),
        eccDurS: r2(Math.max(...ser.velocity.map(p => p.t))),
      };
    };
    const d = catalog[eff.day];
    const half = Math.floor(catalog.length / 2);
    const avgReps = arr => Math.round(arr.reduce((a, x) => a + x.totalReps, 0) / Math.max(arr.length, 1));
    return {
      arm,
      powerBalanceW: balance ? { left: balance.leftW, right: balance.rightW, leftOverRightPct: balance.ratio } : null,
      selection: {
        day: d.label,
        date: new Date(d.dateMs).toISOString().slice(0, 10),
        set: eff.set != null ? d.sets[eff.set].label : null,
        rep: eff.rep != null ? eff.rep + 1 : null,
      },
      selectedRep: showcase ? summarize(showcase) : null,
      setAverage: setAvg ? summarize(setAvg) : null,
      perRep: reps.map((r, i) => ({ rep: i + 1, ...summarize(r) })),
      dayTotals: { sets: d.sets.length, totalReps: d.totalReps },
      yearHistory: {
        sessions: catalog.length,
        totalReps: catalog.reduce((a, x) => a + x.totalReps, 0),
        firstSession: new Date(catalog[0].dateMs).toISOString().slice(0, 10),
        avgRepsPerSessionFirstHalf: avgReps(catalog.slice(0, half)),
        avgRepsPerSessionSecondHalf: avgReps(catalog.slice(half)),
      },
    };
  }, [eff, catalog, reps, showcase, setAvg, arm, balance]);

  const { tMin, tMax } = useMemo(() => {
    const allT = (reps.length ? reps : armSets.flat()).flatMap(r => r.velocity.map(p => p.t));
    return { tMin: Math.min(...allT), tMax: Math.max(...allT) };
  }, [reps, armSets]);

  const seriesFor = key => [
    ...otherReps.map(rep => ({ samples: rep[key], color: GRAY, opacity: 0.22, width: 1 })),
    ...reps.map(r => ({ samples: r[key], opacity: 0.1, width: 1.5 })),
    ...(setAvg ? [{ samples: setAvg[key], opacity: 1, width: 2.5, label: 'set avg' }] : []),
    ...(showcase ? [{ samples: showcase[key], color: '#ffffff', opacity: 1, width: 2.2, label: `R${eff.rep + 1}` }] : []),
  ];

  return (
    <main className={s.main}>
      <div className={s.chartsRow}>
        <aside className={s.sideCol}>
          <div className={s.pickBlock}>
            <div className={s.pickTitle}>Pick Movement <span>▮</span></div>
            <select
              className={s.sourceSelect}
              value={chartSource}
              onChange={e => setChartSource(e.target.value)}
            >
              <option value="mock">Cable Chest Press</option>
              {movements.map(m => (
                <option key={m.actionId} value={m.actionId}>
                  {m.actionName} · {m.setCount} sets · {m.repCount} reps
                </option>
              ))}
            </select>
            {chartSource === 'mock' && (
              <>
                <div className={s.armRow}>
                  <span className={s.armLabel}>Arm</span>
                  {['left', 'right'].map(a => (
                    <button key={a} className={s.armBtn + (arm === a ? ` ${s.armSel}` : '')} onClick={() => setArm(a)}>
                      {a}
                    </button>
                  ))}
                </div>
                {balance && (
                  <div className={s.balance}>
                    <span className={s.balLabel}>Power balance</span>
                    <div className={s.balBar}>
                      <i className={s.balLeft} style={{ flex: balance.leftW }} />
                      <i className={s.balRight} style={{ flex: balance.rightW }} />
                    </div>
                    <span className={s.balNums}>L {balance.leftW} W · R {balance.rightW} W · L/R {balance.ratio}%</span>
                  </div>
                )}
              </>
            )}
          </div>
          {chartSource === 'mock' && <>
            <RepSelector catalog={catalog} sel={eff} onChange={setSel} />
            <iframe
              src="https://www.youtube-nocookie.com/embed/cIszwA55RUI"
              title="Single Arm Cable Chest Press — form demonstration"
              allow="accelerometer; encrypted-media; picture-in-picture"
              allowFullScreen
            />
            <div className={s.videoCaption}>
              Single Arm Cable Chest Press<br />
              <span>form reference · HASfit</span>
            </div>
            <div className={s.musclesBlock}>
              <div className={s.musclesTitle}>Muscles Worked</div>
              <MuscleHighlight primary={[4]} secondary={[5, 7]} side={arm} />
              <div className={s.musclesCaption}>
                <span className={s.mPrimary}>{arm} chest</span> primary · shoulders, triceps secondary
              </div>
            </div>
          </>}
        </aside>
        <div className={s.chartsCol + (chartSource === 'mock' ? ` ${s.fitH}` : '')}>
          {chartSource !== 'mock' && <RealMovement key={chartSource} actionId={chartSource} movements={movements} workouts={accountWorkouts} telemIds={telemIds} />}
          {chartSource === 'mock' && <>
            <ChartLegend repCount={reps.length} hasTargets history />
            <div className={s.chartStack}>
              {CHARTS.map(c => (
                <LineChart
                  key={c.key}
                  title={c.title}
                  unit={c.unit}
                  seriesList={seriesFor(c.key)}
                  color={c.color}
                  dividerT={0}
                  zeroLine={c.zeroLine}
                  hexPoints={mock.hex[c.key]}
                  targetBand={bands[c.key]}
                  xLabelLeft={`${tMin.toFixed(2)}s`}
                  xLabel={`+${tMax.toFixed(2)}s`}
                  fill
                />
              ))}
            </div>
          </>}
        </div>
      </div>
      {chartSource === 'mock' &&
        <ChatBot context={{ exercise: 'Single Arm Cable Chest Press', targets: DEFAULT_PRESS_TARGETS, data: coachData }} />}
    </main>
  );
}
