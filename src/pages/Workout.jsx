import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { runVoltra, getTelemetry, saveTelemetry, getTargets, saveTargets } from '../api.js';
import { DEFAULT_PRESS_TARGETS } from '../lib/repviz.js';
import BarChart, { MetricToggles } from '../components/BarChart.jsx';
import RepCharts from '../components/RepCharts.jsx';
import { parseSessionCsv, matchTelemetry } from '../lib/telemetry.js';
import shared from '../styles/shared.module.css';
import s from './Workout.module.css';

const SET_METRICS = [
  { key: 'volume', label: 'Volume', get: x => x.totalPullVolumeOriginLbs, fmt: v => `${Math.round(v)}` },
  { key: 'force', label: 'Avg Force', get: x => x.avgPullForceLbs, fmt: v => `${v}` },
  { key: 'work', label: 'Work (J)', get: x => x.pullWorkJ ?? 0, fmt: v => `${Math.round(v)}` },
];

const REP_METRICS = [
  { key: 'power', label: 'Peak Power', get: p => p?.peakPowerW ?? 0, fmt: v => `${v}W` },
  { key: 'velocity', label: 'Peak Vel', get: p => (p?.peakVelocityMmS ?? 0), fmt: v => `${(v / 1000).toFixed(1)}` },
  { key: 'work', label: 'Work', get: p => p?.totalWorkJ ?? 0, fmt: v => `${v}J` },
];

const TARGET_FIELDS = [
  { key: 'romM', label: 'ROM', unit: 'm', step: 0.01 },
  { key: 'loadLbs', label: 'Load', unit: 'lbs', step: 1 },
  { key: 'eccLbs', label: 'Ecc load', unit: 'lbs', step: 1 },
  { key: 'mcvMin', label: 'Con MCV min', unit: 'm/s', step: 0.05 },
  { key: 'mcvMax', label: 'Con MCV max', unit: 'm/s', step: 0.05 },
  { key: 'eccSecs', label: 'Ecc tempo', unit: 's', step: 0.5 },
];

function TargetsEditor({ action, targets, onSave }) {
  const [draft, setDraft] = useState(targets?.romM ? targets : DEFAULT_PRESS_TARGETS);
  const [msg, setMsg] = useState(null);

  const save = async () => {
    const clean = Object.fromEntries(
      Object.entries(draft).filter(([, v]) => v !== '' && v != null).map(([k, v]) => [k, Number(v)])
    );
    try {
      await onSave(clean);
      setMsg('saved');
      setTimeout(() => setMsg(null), 2000);
    } catch (e) {
      setMsg(e.message);
    }
  };

  return (
    <section className={s.targetsSection}>
      <h2 className={shared.title}>Targets <span>({action})</span></h2>
      <div className={s.targetsRow}>
        {TARGET_FIELDS.map(f => (
          <label key={f.key} className={s.targetField}>
            <span>{f.label} ({f.unit})</span>
            <input
              type="number" step={f.step} min="0"
              value={draft[f.key] ?? ''}
              placeholder="—"
              onChange={e => setDraft(d => ({ ...d, [f.key]: e.target.value }))}
            />
          </label>
        ))}
        <button className={shared.btn} onClick={save}>Save</button>
        {msg && <span className={s.importMsg}>{msg}</span>}
      </div>
    </section>
  );
}

const fmtDur = sec => {
  const m = Math.floor(sec / 60), r = Math.round(sec % 60);
  return m ? `${m}m ${r}s` : `${r}s`;
};
const fmtM = mm => `${(mm / 1000).toFixed(2)} m`;
const fmtWhen = iso => new Date(iso).toLocaleString(undefined, {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
});

function RepsTable({ reps }) {
  return (
    <div className={s.repsWrap}>
      <table className={shared.table}>
        <thead>
          <tr>
            <th>Rep</th><th>Phase</th>
            <th className={shared.num}>Distance</th>
            <th className={shared.num}>Duration</th>
            <th className={shared.num}>Avg Vel (m/s)</th>
            <th className={shared.num}>Peak Vel (m/s)</th>
            <th className={shared.num}>Avg Pwr (W)</th>
            <th className={shared.num}>Peak Pwr (W)</th>
            <th className={shared.num}>Work (J)</th>
          </tr>
        </thead>
        <tbody>
          {reps.flatMap(rep => [
            ['pull', 'concentric', s.phasePull], ['recovery', 'eccentric', s.phaseRec],
          ].map(([field, label, cls]) => {
            const d = rep[field];
            if (!d) return null;
            return (
              <tr key={`${rep.position}-${field}`}>
                <td>{field === 'pull' ? rep.position : ''}</td>
                <td className={cls}>{label}</td>
                <td className={shared.num}>{fmtM(d.distanceMm)}</td>
                <td className={shared.num}>{(d.durationMs / 1000).toFixed(2)}s</td>
                <td className={shared.num}>{(d.avgVelocityMmS / 1000).toFixed(2)}</td>
                <td className={shared.num}>{(d.peakVelocityMmS / 1000).toFixed(2)}</td>
                <td className={shared.num}>{d.avgPowerW}</td>
                <td className={shared.num}>{d.peakPowerW}</td>
                <td className={shared.num}>{d.totalWorkJ}</td>
              </tr>
            );
          }).filter(Boolean))}
        </tbody>
      </table>
    </div>
  );
}

function SetBlock({ set, reps, telemRows, targets, expanded, onToggle, onNeedReps }) {
  const [metric, setMetric] = useState('power');
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!expanded || reps) return;
    onNeedReps(set.id).catch(e => setError(e.message));
  }, [expanded, reps, set.id, onNeedReps]);

  return (
    <div className={s.setBlock + (telemRows ? ` ${s.setBlockTelem}` : '')}>
      <button className={s.setHeader} onClick={onToggle}>
        <span className={s.setNum}>S{set.position}</span>
        <span className={s.setMeta}><strong>{set.repCount}</strong> reps</span>
        <span className={s.setMeta}><strong>{set.baseWeightLbs}</strong> lbs</span>
        <span className={s.setMeta}>avg <strong>{set.avgPullForceLbs}</strong> · max <strong>{set.maxPullForceLbs}</strong> lbf</span>
        <span className={s.setMeta}><strong>{set.pullWorkJ ?? '--'}</strong> J</span>
        <span className={s.setMeta}>{fmtDur(set.durationSec)} work · {fmtDur(set.restDurationSec)} rest</span>
        {telemRows && <span className={s.telemBadge}>telemetry</span>}
        <span className={s.chev}>{expanded ? '▲' : '▼'}</span>
      </button>
      {expanded && !reps && !error && <div className={s.repsNote} style={{ padding: '10px 16px' }}>loading reps…</div>}
      {expanded && error && <div className={s.error} style={{ padding: '10px 16px' }}>{error}</div>}
      {expanded && reps && telemRows && (
        <div className={s.repsWrap}>
          <RepCharts telemRows={telemRows} apiReps={reps} targets={targets} />
        </div>
      )}
      {expanded && reps && (
        <div className={s.repsWrap}>
          <MetricToggles options={REP_METRICS} value={metric} onChange={setMetric} />
          {(() => {
            const m = REP_METRICS.find(x => x.key === metric);
            return (
              <BarChart
                bars={reps.map(r => ({ label: `R${r.position}`, a: m.get(r.pull), b: m.get(r.recovery) }))}
                fmt={m.fmt}
                legendA="concentric"
                legendB="eccentric"
              />
            );
          })()}
        </div>
      )}
      {expanded && reps && <RepsTable reps={reps} />}
    </div>
  );
}

export default function Workout() {
  const { id } = useParams();
  const [workout, setWorkout] = useState(null);
  const [sets, setSets] = useState(null);
  const [repsBySet, setRepsBySet] = useState({});
  const [telemetry, setTelemetry] = useState(null); // {setId: [rows]}
  const [allTargets, setAllTargets] = useState(null); // {actionName: {rom, force, velocity, power}}
  const [error, setError] = useState(null);
  const [importMsg, setImportMsg] = useState(null);
  const [openSet, setOpenSet] = useState(null);
  const [setMetric, setSetMetric] = useState('volume');
  const fileRef = useRef(null);

  const fetchReps = useCallback(async setId => {
    const reps = await runVoltra(['workout', 'reps', String(id), String(setId), '--json']);
    setRepsBySet(prev => ({ ...prev, [setId]: reps }));
    return reps;
  }, [id]);

  useEffect(() => {
    let alive = true;
    runVoltra(['workout', 'list', '--json', '--local-time', '--page-size', '50'])
      .then(data => {
        if (!alive) return;
        const w = (data.list || []).find(x => String(x.id) === id);
        if (w) setWorkout(w); else setError(`workout ${id} not found in recent history`);
      })
      .catch(e => alive && setError(e.message));
    runVoltra(['workout', 'sets', id, '--json'])
      .then(data => alive && setSets(data))
      .catch(e => alive && setError(e.message));
    getTelemetry(id).then(t => alive && setTelemetry(t)).catch(() => {});
    getTargets().then(t => alive && setAllTargets(t)).catch(() => alive && setAllTargets({}));
    return () => { alive = false; };
  }, [id]);

  const actionName = workout?.actionNames?.[0];
  const targets = actionName ? allTargets?.[actionName] : null;

  const persistTargets = async draft => {
    const next = { ...allTargets, [actionName]: draft };
    await saveTargets(next);
    setAllTargets(next);
  };

  const importCsv = async file => {
    setImportMsg('parsing CSV…');
    try {
      const rows = parseSessionCsv(await file.text());
      const matched = {};
      let found = 0;
      for (const set of sets) {
        setImportMsg(`matching set ${set.position}…`);
        const reps = repsBySet[set.id] || await fetchReps(set.id);
        const m = matchTelemetry(rows, reps);
        if (m) { matched[set.id] = m; found++; }
      }
      if (!found) {
        setImportMsg('no matching reps found in this CSV — is it the right session export?');
        return;
      }
      await saveTelemetry(id, matched);
      setTelemetry(matched);
      setImportMsg(`telemetry attached to ${found}/${sets.length} set${sets.length > 1 ? 's' : ''}`);
    } catch (e) {
      setImportMsg(`import failed: ${e.message}`);
    }
  };

  if (error) return <main className={s.main}><div className={s.error}>{error}</div></main>;
  if (!workout || !sets) return <main className={s.main}><div className={s.loading}>loading workout…</div></main>;

  return (
    <main className={s.main}>
      <Link to="/" className={s.back}>← Lift</Link>
      <h2 className={shared.title}>
        <span className={s.type}>{workout.workoutTypeName}</span> — {workout.actionNames?.join(', ')}
      </h2>
      <div className={s.when}>{fmtWhen(workout.startTime)} · {fmtDur(workout.durationSec)}</div>

      <div className={s.statGrid}>
        <div className={s.stat}><label>Sets</label><div className={s.val}>{workout.setCount}</div></div>
        <div className={s.stat}><label>Reps</label><div className={s.val}>{workout.repCount}</div></div>
        <div className={s.stat}><label>Volume</label><div className={`${s.val} ${s.lit}`}>{Math.round(workout.totalPullVolumeLbs).toLocaleString()}<span className={s.unit}>lbs</span></div></div>
        <div className={s.stat}><label>Max Force</label><div className={s.val}>{workout.maxPullForceLbs}<span className={s.unit}>lbf</span></div></div>
        <div className={s.stat}><label>Avg Power</label><div className={s.val}>{workout.avgPullPowerW}<span className={s.unit}>W</span></div></div>
        <div className={s.stat}><label>Peak Vel</label><div className={s.val}>{(workout.maxPullVelocityMmS / 1000).toFixed(1)}<span className={s.unit}>m/s</span></div></div>
        <div className={s.stat}><label>Distance</label><div className={s.val}>{(workout.totalPullDistanceMm / 1000).toFixed(1)}<span className={s.unit}>m</span></div></div>
        <div className={s.stat}><label>Rest</label><div className={s.val}>{fmtDur(workout.totalRestDurationSec)}</div></div>
      </div>

      <div className={s.importRow}>
        <button className={shared.btn} onClick={() => fileRef.current?.click()}>
          {telemetry ? 'Re-import Beyond+ CSV' : 'Import Beyond+ CSV (rep telemetry)'}
        </button>
        <input
          ref={fileRef} type="file" accept=".csv" style={{ display: 'none' }}
          onChange={e => { if (e.target.files?.[0]) importCsv(e.target.files[0]); e.target.value = ''; }}
        />
        {importMsg && <span className={s.importMsg}>{importMsg}</span>}
      </div>

      {allTargets && (
        <TargetsEditor key={actionName} action={actionName} targets={targets} onSave={persistTargets} />
      )}

      <h2 className={shared.title}>Set Comparison</h2>
      <MetricToggles options={SET_METRICS} value={setMetric} onChange={setSetMetric} />
      {(() => {
        const m = SET_METRICS.find(x => x.key === setMetric);
        return (
          <BarChart
            bars={sets.map(set => ({ label: `S${set.position}`, a: m.get(set) }))}
            fmt={m.fmt}
          />
        );
      })()}

      <h2 className={shared.title} style={{ marginTop: 28 }}>Sets</h2>
      {sets.map(set => (
        <SetBlock
          key={set.id}
          set={set}
          reps={repsBySet[set.id]}
          telemRows={telemetry?.[set.id]}
          targets={targets}
          expanded={openSet === set.id}
          onToggle={() => setOpenSet(openSet === set.id ? null : set.id)}
          onNeedReps={fetchReps}
        />
      ))}
    </main>
  );
}
