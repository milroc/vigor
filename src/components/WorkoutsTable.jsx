import { useNavigate } from 'react-router-dom';
import shared from '../styles/shared.module.css';
import s from './WorkoutsTable.module.css';

function fmtDuration(sec) {
  const m = Math.floor(sec / 60), s = sec % 60;
  return m ? `${m}m ${s}s` : `${s}s`;
}

export default function WorkoutsTable({ workouts, telemetryIds = [] }) {
  const navigate = useNavigate();
  const hasTelem = new Set(telemetryIds);
  return (
    <section className={shared.section}>
      <h2 className={shared.title}>Recent Workouts</h2>
      <table className={shared.table}>
        <thead>
          <tr>
            <th>Date</th><th>Type</th><th>Movement</th><th className={shared.num}>Sets</th>
            <th className={shared.num}>Reps</th><th className={shared.num}>Volume (lbs)</th>
            <th className={shared.num}>Duration</th>
          </tr>
        </thead>
        <tbody>
          {workouts.slice(0, 10).map(w => (
            <tr key={w.id} className={s.rowLink} onClick={() => navigate(`/workout/${w.id}`)}>
              <td>{(w.startTime || '').slice(0, 10)}</td>
              <td><span className={s.typeTag}>{w.workoutTypeName || '—'}</span></td>
              <td>
                {w.actionNames?.join(', ') || '—'}
                {hasTelem.has(w.id) && <span className={s.telemDot} title="rep telemetry attached">◉</span>}
              </td>
              <td className={shared.num}>{w.setCount}</td>
              <td className={shared.num}>{w.repCount}</td>
              <td className={shared.num}>{Math.round(w.totalPullVolumeLbs).toLocaleString()}</td>
              <td className={shared.num}>{fmtDuration(w.durationSec || 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
