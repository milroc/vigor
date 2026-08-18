import { fitTrend, fmtP } from '../lib/stats.js';
import s from './ZoneRows.module.css';

// Time in zone over time as small multiples: one row per HR zone, one dot
// per session (minutes in that zone), least-squares trend per row. Raw
// per-session data on a true time axis — same-day sessions are simply two
// dots in the same column; gaps in training stay visible.
const ZONE_COLORS = ['#8a8a7c', '#4da3ff', '#c6fe28', '#ff9d4d', '#ff4d3a'];
const W = 640, ROW = 54, PAD = { l: 30, r: 78, b: 18, rowT: 7, rowB: 7 };
const DAY = 86_400_000;

export default function ZoneRows({ rides, xLeft, xRight }) {
  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 3) return null;

  const t0 = new Date(data[0].start).getTime();
  const ts = data.map(r => (new Date(r.start).getTime() - t0) / DAY);
  const tMax = Math.max(...ts) || 1;
  const H = 5 * ROW + PAD.b;
  const x = t => PAD.l + (t / tMax) * (W - PAD.l - PAD.r);

  const rows = [0, 1, 2, 3, 4].map(z => {
    // Zero minutes in a zone is a real measurement for a session that has
    // zone data at all — keep it, so absent zones read as flat-at-zero.
    const pts = data.map((r, i) => ({ t: ts[i], v: (r.zones[z] || 0) / 60 }));
    const vMax = Math.max(...pts.map(p => p.v), 1);
    const trend = fitTrend(pts);
    return { z, pts, vMax, trend };
  });

  return (
    <div className={s.wrap}>
      <div className={s.name}>
        Time in Zone<span>MIN PER SESSION · one row per zone · line = trend fit</span>
      </div>
      <svg className={s.svg} viewBox={`0 0 ${W} ${H}`}>
        {rows.map(({ z, pts, vMax, trend }) => {
          const top = z * ROW;
          const y = v => top + PAD.rowT + (1 - v / vMax) * (ROW - PAD.rowT - PAD.rowB);
          return (
            <g key={z}>
              <line x1={PAD.l} x2={W - PAD.r} y1={y(0)} y2={y(0)} stroke="#23231e" />
              <text className={s.zLabel} x={PAD.l - 8} y={top + ROW / 2 + 3}
                textAnchor="end" fill={ZONE_COLORS[z]}>Z{z + 1}</text>
              {trend && (
                <line
                  x1={x(0)} y1={y(Math.max(trend.fit(0), 0))}
                  x2={x(tMax)} y2={y(Math.max(trend.fit(tMax), 0))}
                  stroke={ZONE_COLORS[z]} strokeWidth="2" strokeOpacity="0.9"
                />
              )}
              {pts.map((p, i) => (
                <circle key={i} cx={x(p.t)} cy={y(p.v)} r="2.4"
                  fill={ZONE_COLORS[z]} fillOpacity="0.6" />
              ))}
              <text className={s.axis} x={W - PAD.r + 8} y={top + PAD.rowT + 8}>
                max {vMax < 10 ? vMax.toFixed(1) : Math.round(vMax)}m
              </text>
              <text className={s.axis} x={W - PAD.r + 8} y={top + ROW - PAD.rowB}>
                {trend ? fmtP(trend.p) : ''}
              </text>
            </g>
          );
        })}
        {xLeft && <text className={s.axis} x={PAD.l} y={H - 4} textAnchor="start">{xLeft}</text>}
        {xRight && <text className={s.axis} x={W - PAD.r} y={H - 4} textAnchor="end">{xRight}</text>}
      </svg>
    </div>
  );
}
