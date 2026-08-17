import { useMemo } from 'react';
import s from './RepSelector.module.css';

const DAY_MS = 86400000;
const PITCH = 7, CELL = 6, TOP = 10, LEFT = 14; // viewBox units

// GitHub-contributions-style year calendar: 52 week columns × 7 day rows,
// cell intensity = total reps performed that day. Clicking a workout day
// selects it; Set/Rep pickers below drill into it.
export default function RepSelector({ catalog, sel, onChange }) {
  const { weeks, dayIndexByMs, thresholds } = useMemo(() => {
    const dayIndexByMs = new Map(catalog.map((d, i) => [d.dateMs, i]));
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const thisMonday = today.getTime() - ((today.getDay() + 6) % 7) * DAY_MS;
    const start = thisMonday - 51 * 7 * DAY_MS;
    const weeks = Array.from({ length: 52 }, (_, w) =>
      Array.from({ length: 7 }, (_, r) => {
        const ms = start + (w * 7 + r) * DAY_MS;
        return ms > today.getTime() ? null : ms;
      })
    );
    const counts = catalog.map(d => d.totalReps).sort((a, b) => a - b);
    const q = f => counts[Math.min(counts.length - 1, Math.floor(f * counts.length))] ?? 0;
    return { weeks, dayIndexByMs, thresholds: [q(0.25), q(0.5), q(0.75)] };
  }, [catalog]);

  const level = reps =>
    reps <= thresholds[0] ? 1 : reps <= thresholds[1] ? 2 : reps <= thresholds[2] ? 3 : 4;

  const day = sel.day != null ? catalog[sel.day] : null;
  const set = day && sel.set != null ? day.sets[sel.set] : null;
  const pick = patch => onChange({ ...sel, ...patch });

  return (
    <div className={s.wrap}>
      <div className={s.title}>Browse Sets <span>▮</span></div>

      <svg
        className={s.cal}
        viewBox={`0 0 ${LEFT + 26 * PITCH} ${(TOP + 7 * PITCH + 8) * 2}`}
        role="listbox"
        aria-label="Workout days, past 52 weeks"
      >
        {[weeks.slice(0, 26), weeks.slice(26)].map((half, hi) => (
          <g key={hi} transform={`translate(0, ${hi * (TOP + 7 * PITCH + 8)})`}>
            {half.map((col, w) => {
              const month = new Date(col[0]).getMonth();
              const startsMonth = w > 0 && new Date(half[w - 1][0]).getMonth() !== month;
              const firstFull = w === 0 && new Date(half[1][0]).getMonth() === month;
              const label = startsMonth || firstFull
                ? new Date(col[0]).toLocaleDateString(undefined, { month: 'short' })
                : '';
              return label ? (
                <text key={`m${w}`} className={s.monthLabel} x={LEFT + w * PITCH} y={TOP - 3}>{label}</text>
              ) : null;
            })}
            {['M', 'W', 'F'].map((d, i) => (
              <text key={d} className={s.monthLabel} x={0} y={TOP + (i * 2) * PITCH + CELL - 1}>{d}</text>
            ))}
            {half.map((col, w) => col.map((ms, r) => {
              if (ms == null) return null;
              const idx = dayIndexByMs.get(ms);
              const d = idx != null ? catalog[idx] : null;
              return (
                <rect
                  key={`${w}-${r}`}
                  x={LEFT + w * PITCH}
                  y={TOP + r * PITCH}
                  width={CELL}
                  height={CELL}
                  rx="1.2"
                  className={
                    d
                      ? `${s.cell} ${s['lvl' + level(d.totalReps)]}` + (sel.day === idx ? ` ${s.cellSel}` : '')
                      : `${s.cell} ${s.cellEmpty}`
                  }
                  onClick={d ? () => pick({ day: idx, set: d.sets.length - 1, rep: null }) : undefined}
                >
                  <title>
                    {new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}
                    {d ? ` — ${d.totalReps} reps, ${d.sets.length} sets` : ' — rest day'}
                  </title>
                </rect>
              );
            }))}
          </g>
        ))}
      </svg>
      <div className={s.calScale}>
        less
        {[1, 2, 3, 4].map(l => <i key={l} className={s['lvl' + l]} />)}
        more · cell = reps that day
      </div>

      {day && (
        <div className={s.setList}>
          {day.sets.map((st, si) => (
            <div key={si} className={s.setRow}>
              <button
                className={s.setLabel + (sel.set === si ? ` ${s.setSel}` : '')}
                onClick={() => pick({ set: si, rep: null })}
              >
                {st.label}
              </button>
              <div className={s.repChips}>
                {Array.from({ length: st.repCount }, (_, ri) => (
                  <button
                    key={ri}
                    className={
                      s.chip + (sel.set === si && sel.rep === ri ? ` ${s.chipSel}` : '')
                    }
                    onClick={() => pick({ set: si, rep: ri })}
                  >
                    {ri + 1}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className={s.hint}>
        {sel.rep != null
          ? <>Showing <b>{day.label} · {set.label} · R{sel.rep + 1}</b> as the white line on every chart.</>
          : set
            ? <>Showing <b>{day.label} · {set.label}</b> — all reps + set average. Click a rep to highlight one.</>
            : <>Selected <b>{day.label}</b> — click a set or a rep.</>}
      </div>
      <button className={s.clear} onClick={() => onChange({ day: null, set: null, rep: null })}>
        Reset to latest set
      </button>
    </div>
  );
}
