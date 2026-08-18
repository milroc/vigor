import s from './ProgressBar.module.css';

export default function ProgressBar({ state, detail }) {
  const { phase, totalWorkouts, processedWorkouts, sets, reps, username } = state;
  const busy = phase === 'listing' || phase === 'login';
  const pct = totalWorkouts ? Math.round((processedWorkouts / totalWorkouts) * 100) : 0;
  const who = username ? `${username} — ` : '';

  return (
    <div>
      <div className={s.track}>
        <div
          className={s.fill + (busy ? ` ${s.indeterminate}` : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={s.meta}>
        <span className={s.phase}>
          {phase === 'login' ? `${who}Logging in…`
            : busy ? `${who}Scanning workout history…`
            : `${who}Workout ${processedWorkouts}/${totalWorkouts}`}
        </span>
        <span>{detail ?? `${sets} sets · ${reps} reps`}{busy ? '' : ` · ${pct}%`}</span>
      </div>
    </div>
  );
}
