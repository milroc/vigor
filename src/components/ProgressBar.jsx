import s from './ProgressBar.module.css';

export default function ProgressBar({ state }) {
  const { phase, totalWorkouts, processedWorkouts, sets, reps } = state;
  const listing = phase === 'listing';
  const pct = totalWorkouts ? Math.round((processedWorkouts / totalWorkouts) * 100) : 0;

  return (
    <div>
      <div className={s.track}>
        <div
          className={s.fill + (listing ? ` ${s.indeterminate}` : '')}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className={s.meta}>
        <span className={s.phase}>
          {listing ? 'Scanning workout history…' : `Workout ${processedWorkouts}/${totalWorkouts}`}
        </span>
        <span>{sets} sets · {reps} reps{listing ? '' : ` · ${pct}%`}</span>
      </div>
    </div>
  );
}
