import shared from '../styles/shared.module.css';
import s from './WeeklyMinutes.module.css';

const WEEKS = 8;
const CARDIO_TYPES = new Set(['Rowing', 'Skiing']);
const INTENTIONAL_REST_S = 90; // per between-set break; beyond this is "extra"

const SEGMENTS = [
  { key: 'tut', label: 'time under tension', color: 'var(--lime)' },
  { key: 'cardio', label: 'cardio', color: '#3fd8c7' },
  { key: 'intentionalRest', label: 'intentional rest', color: '#6b6b60' },
  { key: 'extraRest', label: 'extra rest', color: '#ff4d3a' },
];

// Monday-start local week
function weekStart(d) {
  const w = new Date(d);
  w.setHours(0, 0, 0, 0);
  w.setDate(w.getDate() - ((w.getDay() + 6) % 7));
  return w;
}
const weekKey = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

function bucketize(w) {
  const work = w.durationSec || 0;
  const rest = w.totalRestDurationSec || 0;
  const breaks = Math.max((w.setCount || 1) - 1, 1);
  const intentional = Math.min(rest, breaks * INTENTIONAL_REST_S);
  return CARDIO_TYPES.has(w.workoutTypeName)
    ? { tut: 0, cardio: work, intentionalRest: intentional, extraRest: rest - intentional }
    : { tut: work, cardio: 0, intentionalRest: intentional, extraRest: rest - intentional };
}

export default function WeeklyMinutes({ workouts }) {
  const weeks = [];
  const start = weekStart(new Date());
  for (let i = WEEKS - 1; i >= 0; i--) {
    const d = new Date(start);
    d.setDate(d.getDate() - i * 7);
    weeks.push({ key: weekKey(d), label: `${d.getMonth() + 1}/${d.getDate()}`, tut: 0, cardio: 0, intentionalRest: 0, extraRest: 0 });
  }
  const byKey = Object.fromEntries(weeks.map(w => [w.key, w]));
  for (const w of workouts) {
    const wk = byKey[weekKey(weekStart(new Date(w.startTime)))];
    if (!wk) continue;
    const b = bucketize(w);
    for (const seg of SEGMENTS) wk[seg.key] += b[seg.key];
  }

  const total = wk => SEGMENTS.reduce((a, seg) => a + wk[seg.key], 0);
  const max = Math.max(...weeks.map(total), 60);
  const fmtMin = sec => Math.round(sec / 60 * 10) / 10;

  return (
    <section className={shared.section}>
      <h2 className={shared.title}>Minutes per Week</h2>
      <div className={s.legend}>
        {SEGMENTS.map(seg => (
          <span key={seg.key} className={s.legendItem}>
            <i style={{ background: seg.color }} />{seg.label}
          </span>
        ))}
      </div>
      <div className={s.chart}>
        {weeks.map(wk => (
          <div
            key={wk.key}
            className={s.barWrap}
            title={SEGMENTS.map(seg => `${seg.label}: ${fmtMin(wk[seg.key])}m`).join('\n')}
          >
            <div className={s.total}>{total(wk) ? `${fmtMin(total(wk))}m` : ''}</div>
            <div className={s.stack}>
              {SEGMENTS.map(seg => wk[seg.key] > 0 && (
                <div
                  key={seg.key}
                  className={s.segment}
                  style={{ height: `${(wk[seg.key] / max) * 100}%`, background: seg.color }}
                />
              ))}
            </div>
            <div className={s.label}>{wk.label}</div>
          </div>
        ))}
      </div>
    </section>
  );
}
