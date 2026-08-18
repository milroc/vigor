import s from './ZoneDays.module.css';

// Time in zone over time as a stream-bar graph: one stacked bar per calendar
// day (same-day sessions summed), centered on a silhouette baseline like a
// streamgraph — but discrete, so empty days are genuinely empty instead of
// interpolated. Clicking picks the nearest workout day.
// Peloton's zone palette: Z1 blue, Z2 green, Z3 yellow, Z4 orange, Z5 red
// (hex values approximated from the app — Peloton doesn't publish them).
const ZONE_COLORS = ['#3b9ad9', '#7ec642', '#f6c344', '#f78e1e', '#eb3745'];
const W = 640, H = 210, PAD = { l: 44, r: 10, t: 12, b: 20 };
const DAY = 86_400_000;

export default function ZoneDays({ rides, onOpenWorkout }) {
  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 2) return null;

  // Group by local calendar day, summing zone minutes across sessions.
  const byDay = new Map();
  for (const r of data) {
    const day = new Date(r.start).toLocaleDateString('en-CA');
    if (!byDay.has(day)) byDay.set(day, { mins: [0, 0, 0, 0, 0], id: r.id });
    const entry = byDay.get(day);
    r.zones.forEach((z, i) => { entry.mins[i] += (z || 0) / 60; });
  }
  const days = [...byDay.entries()]
    .map(([day, { mins, id }]) => ({ day, mins, id, total: mins.reduce((sum, v) => sum + v, 0) }))
    .sort((a, b) => a.day.localeCompare(b.day));

  const t0 = Date.parse(days[0].day);
  const tMax = (Date.parse(days[days.length - 1].day) - t0) / DAY || 1;
  const x = day => PAD.l + ((Date.parse(day) - t0) / DAY / tMax) * (W - PAD.l - PAD.r);
  const maxTotal = Math.max(...days.map(d => d.total)) || 1;
  const half = (maxTotal / 2) * 1.08;
  const y = v => PAD.t + (1 - (v + half) / (2 * half)) * (H - PAD.t - PAD.b);
  // One slot per calendar day; bars fill most of a slot.
  const barW = Math.max(2, Math.min(10, ((W - PAD.l - PAD.r) / (tMax + 1)) * 0.8));

  const pickDay = e => {
    const svg = e.currentTarget.ownerSVGElement;
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (W / rect.width);
    let best = null, bestD = Infinity;
    for (const d of days) {
      const dist = Math.abs(x(d.day) - vx);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (best) onOpenWorkout(best.id);
  };

  return (
    <div className={s.wrap}>
      <div className={s.name}>
        Time in Zone<span>MIN PER DAY · STREAM BAR GRAPH · SAME-DAY SESSIONS SUMMED · CLICK A DAY</span>
        <span className={s.legend}>
          {ZONE_COLORS.map((c, i) => (
            <span key={i} className={s.legendItem}>
              <span className={s.swatch} style={{ background: c }} />Z{i + 1}
            </span>
          ))}
        </span>
      </div>
      <svg className={s.svg} viewBox={`0 0 ${W} ${H}`}>
        <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)}
          stroke="#23231e" strokeDasharray="3,4" />
        {days.map(d => {
          // Silhouette-centered stack: from -total/2 upward through Z1..Z5.
          let acc = -d.total / 2;
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
              >
                <title>{d.day} · {Math.round(d.total)} min</title>
              </rect>
            );
          });
        })}
        <text className={s.axis} x={PAD.l - 6} y={y(maxTotal / 2) + 8} textAnchor="end">
          {Math.round(maxTotal)}m
        </text>
        <text className={s.axis} x={PAD.l} y={H - 4} textAnchor="start">{days[0].day}</text>
        <text className={s.axis} x={W - PAD.r} y={H - 4} textAnchor="end">
          {days[days.length - 1].day}
        </text>
        {onOpenWorkout && (
          <rect
            x={PAD.l} y={PAD.t} width={W - PAD.l - PAD.r} height={H - PAD.t - PAD.b}
            fill="transparent" style={{ cursor: 'pointer' }} onClick={pickDay}
          />
        )}
      </svg>
    </div>
  );
}
