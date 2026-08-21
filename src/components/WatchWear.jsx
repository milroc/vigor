import { useMemo } from 'react';
import s from './WatchWear.module.css';

// GitHub-style calendar heatmap of Apple Watch wear, one block per year. Each
// cell is a day, shaded by hr_hours (distinct hours with a heart-rate sample,
// 0-24) as a proxy for how long the Watch was worn.
const CELL = 11, GAP = 2, PITCH = CELL + GAP;
const PAD_L = 30, PAD_T = 16, ROW_H = 7 * PITCH;
const YEAR_GAP = 26;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DOW = ['Mon', '', 'Wed', '', 'Fri', '', 'Sun'];

const mon0 = d => (d.getDay() + 6) % 7; // Monday = 0
const iso = d => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const fmtDay = d => d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });

// Discrete lime scale so light vs heavy wear reads at a glance.
function cellFill(hrs) {
  if (hrs == null || hrs <= 0) return 'var(--line, #24241f)';
  if (hrs <= 4) return 'rgba(198,254,40,0.22)';
  if (hrs <= 9) return 'rgba(198,254,40,0.42)';
  if (hrs <= 14) return 'rgba(198,254,40,0.62)';
  if (hrs <= 19) return 'rgba(198,254,40,0.82)';
  return 'rgba(198,254,40,1)';
}

export default function WatchWear({ data }) {
  const { years, byDay, stats } = useMemo(() => {
    const byDay = new Map(data.map(r => [r.day, Number(r.hr_hours)]));
    let yrs = [];
    if (data.length) {
      const y0 = Number(data[0].day.slice(0, 4));
      const y1 = Number(data[data.length - 1].day.slice(0, 4));
      yrs = Array.from({ length: y1 - y0 + 1 }, (_, i) => y0 + i);
    }
    const worn = data.filter(r => Number(r.hr_hours) > 0);
    const heavy = data.filter(r => Number(r.hr_hours) >= 12);
    return {
      years: yrs,
      byDay,
      stats: {
        wornDays: worn.length,
        heavyDays: heavy.length,
        avgHrsWorn: worn.length ? worn.reduce((a, r) => a + Number(r.hr_hours), 0) / worn.length : 0,
      },
    };
  }, [data]);

  const width = PAD_L + 54 * PITCH;

  return (
    <div className={s.wrap}>
      <div className={s.legendRow}>
        <span className={s.summary}>
          Worn <strong>{stats.wornDays.toLocaleString()}</strong> days
          {' · '}<strong>{stats.heavyDays.toLocaleString()}</strong> full-day (12h+)
          {' · avg '}<strong>{stats.avgHrsWorn.toFixed(1)}h</strong> on worn days
        </span>
        <span className={s.legend}>
          less
          {[0, 3, 8, 13, 18, 23].map(h => (
            <i key={h} style={{ background: cellFill(h) }} />
          ))}
          more
        </span>
      </div>

      <svg width={width} height={years.length * (ROW_H + PAD_T + YEAR_GAP)} className={s.svg}>
        {years.map((yr, yi) => {
          const oy = yi * (ROW_H + PAD_T + YEAR_GAP) + PAD_T;
          const jan1 = new Date(yr, 0, 1);
          const jan1off = mon0(jan1);
          const cells = [];
          const monthTicks = [];
          const end = new Date(yr, 11, 31);
          for (let d = new Date(jan1); d <= end; d.setDate(d.getDate() + 1)) {
            const doy = Math.round((d - jan1) / 86400000);
            const col = Math.floor((doy + jan1off) / 7);
            const row = mon0(d);
            const key = iso(d);
            const hrs = byDay.get(key);
            if (d.getDate() === 1) monthTicks.push({ col, m: d.getMonth() });
            cells.push(
              <rect
                key={key}
                x={PAD_L + col * PITCH} y={oy + row * PITCH}
                width={CELL} height={CELL} rx={2}
                fill={cellFill(hrs)}
              >
                <title>{`${fmtDay(d)} · ${hrs ? `${hrs}h worn` : 'not worn'}`}</title>
              </rect>
            );
          }
          return (
            <g key={yr}>
              <text x={0} y={oy - 4} className={s.yearLabel}>{yr}</text>
              {yi === 0 && monthTicks.map(({ col, m }) => (
                <text key={m} x={PAD_L + col * PITCH} y={oy - 4} className={s.monthLabel}>{MONTHS[m]}</text>
              ))}
              {DOW.map((lbl, r) => lbl && (
                <text key={r} x={PAD_L - 6} y={oy + r * PITCH + CELL - 1} className={s.dowLabel} textAnchor="end">{lbl}</text>
              ))}
              {cells}
            </g>
          );
        })}
      </svg>
    </div>
  );
}
