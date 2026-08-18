import s from './ZoneBars.module.css';

// One stacked bar per session at its date: minutes in each HR zone, Z1 at
// the bottom. Raw per-session data, no aggregation.
const ZONE_COLORS = ['#5a5a50', '#4da3ff', '#c6fe28', '#ff9d4d', '#ff4d3a'];
const W = 640, H = 200, PAD = { l: 44, r: 10, t: 10, b: 20 };
const DAY = 86_400_000;

export default function ZoneBars({ rides, xLeft, xRight }) {
  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 2) return null;

  const t0 = new Date(data[0].start).getTime();
  const pts = data.map(r => ({
    t: (new Date(r.start).getTime() - t0) / DAY,
    mins: r.zones.map(z => (z || 0) / 60),
  }));
  const tMax = Math.max(...pts.map(p => p.t)) || 1;
  const vMax = Math.max(...pts.map(p => p.mins.reduce((sum, v) => sum + v, 0))) * 1.08 || 1;
  const x = t => PAD.l + (t / tMax) * (W - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - v / vMax) * (H - PAD.t - PAD.b);
  const barW = Math.max(2.5, Math.min(9, ((W - PAD.l - PAD.r) / pts.length) * 0.55));
  const grid = [0.25, 0.5, 0.75].map(f => vMax * f);

  return (
    <div className={s.wrap}>
      <div className={s.name}>
        Time in Zone<span>MIN PER SESSION · stacked</span>
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
          <line key={i} x1={PAD.l} x2={W - PAD.r} y1={y(g)} y2={y(g)}
            stroke="#23231e" strokeDasharray="3,4" />
        ))}
        {pts.map((p, i) => {
          let acc = 0;
          return p.mins.map((m, z) => {
            if (m <= 0) return null;
            const y1 = y(acc + m), y0 = y(acc);
            acc += m;
            return (
              <rect
                key={`${i}:${z}`}
                x={x(p.t) - barW / 2} y={y1}
                width={barW} height={Math.max(y0 - y1, 0.5)}
                fill={ZONE_COLORS[z]} fillOpacity="0.85"
              />
            );
          });
        })}
        <text className={s.axis} x={PAD.l - 6} y={y(vMax / 1.08) + 8} textAnchor="end">
          {Math.round(vMax / 1.08)}
        </text>
        <text className={s.axis} x={PAD.l - 6} y={y(vMax / 2.16) + 3} textAnchor="end">
          {Math.round(vMax / 2.16)}
        </text>
        <text className={s.axis} x={PAD.l - 6} y={y(0)} textAnchor="end">0</text>
        {xLeft && <text className={s.axis} x={PAD.l} y={H - PAD.b + 12} textAnchor="start">{xLeft}</text>}
        {xRight && <text className={s.axis} x={W - PAD.r} y={H - PAD.b + 12} textAnchor="end">{xRight}</text>}
      </svg>
    </div>
  );
}
