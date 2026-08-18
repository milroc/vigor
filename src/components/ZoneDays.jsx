import s from './ZoneDays.module.css';

// Time in zone over time, grouped the way the data actually occurs: one
// stacked bar per calendar DAY (Z1 bottom → Z5 top, minutes), with all of
// that day's sessions summed. True time axis, so training gaps stay
// visible as empty days.
const ZONE_COLORS = ['#8a8a7c', '#4da3ff', '#c6fe28', '#ff9d4d', '#ff4d3a'];
const W = 640, H = 210, PAD = { l: 44, r: 10, t: 12, b: 20 };
const DAY = 86_400_000;

export default function ZoneDays({ rides }) {
  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 2) return null;

  // Group by local calendar day, summing zone minutes across sessions.
  const byDay = new Map();
  for (const r of data) {
    const day = new Date(r.start).toLocaleDateString('en-CA');
    if (!byDay.has(day)) byDay.set(day, [0, 0, 0, 0, 0]);
    const mins = byDay.get(day);
    r.zones.forEach((z, i) => { mins[i] += (z || 0) / 60; });
  }
  const days = [...byDay.entries()]
    .map(([day, mins]) => ({ day, mins, total: mins.reduce((sum, v) => sum + v, 0) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const t0 = Date.parse(days[0].day);
  const tMax = (Date.parse(days[days.length - 1].day) - t0) / DAY || 1;
  const x = day => PAD.l + ((Date.parse(day) - t0) / DAY / tMax) * (W - PAD.l - PAD.r);
  const vMax = Math.max(...days.map(d => d.total)) * 1.06 || 1;
  const y = v => PAD.t + (1 - v / vMax) * (H - PAD.t - PAD.b);
  // One slot per calendar day on the axis; bars fill most of a slot.
  const barW = Math.max(2, Math.min(10, ((W - PAD.l - PAD.r) / (tMax + 1)) * 0.8));
  const grid = [0.25, 0.5, 0.75].map(f => (vMax / 1.06) * f);

  return (
    <div className={s.wrap}>
      <div className={s.name}>
        Time in Zone<span>MIN PER DAY · stacked Z1→Z5 · same-day sessions summed</span>
        <span className={s.legend}>
          {ZONE_COLORS.map((c, i) => (
            <span key={i} className={s.legendItem}>
              <span className={s.swatch} style={{ background: c }} />Z{i + 1}
            </span>
          ))}
        </span>
      </div>
      <svg className={s.svg} viewBox={`0 0 ${W} ${H}`}>
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)}
              stroke="#23231e" strokeDasharray="3,4" />
            <text className={s.axis} x={PAD.l - 6} y={y(g) + 3} textAnchor="end">
              {Math.round(g)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#23231e" />
        {days.map(d => {
          let acc = 0;
          return d.mins.map((m, z) => {
            if (m <= 0) return null;
            const yTop = y(acc + m), yBot = y(acc);
            acc += m;
            return (
              <rect
                key={`${d.day}:${z}`}
                x={x(d.day) - barW / 2} y={yTop}
                width={barW} height={Math.max(yBot - yTop, 0.5)}
                fill={ZONE_COLORS[z]} fillOpacity="0.9"
              />
            );
          });
        })}
        <text className={s.axis} x={PAD.l} y={H - 4} textAnchor="start">{days[0].day}</text>
        <text className={s.axis} x={W - PAD.r} y={H - 4} textAnchor="end">
          {days[days.length - 1].day}
        </text>
      </svg>
    </div>
  );
}
