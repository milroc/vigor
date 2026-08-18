import { useState } from 'react';
import s from './ZoneDays.module.css';

// Time in zone over time as a streamgraph: zone minutes stacked per calendar
// day (same-day sessions summed) around a silhouette baseline, on a true
// time axis. Days with no workout are real zeros, so the stream pinches
// closed during training gaps instead of bridging them. Clicking picks the
// nearest workout day; days with several sessions open an inline chooser.
// Peloton's zone palette: Z1 blue, Z2 green, Z3 yellow, Z4 orange, Z5 red
// (hex values approximated from the app — Peloton doesn't publish them).
const ZONE_COLORS = ['#3b9ad9', '#7ec642', '#f6c344', '#f78e1e', '#eb3745'];
const W = 640, H = 210, PAD = { l: 44, r: 10, t: 12, b: 20 };
const DAY = 86_400_000;

// Catmull-Rom → cubic Bézier through every point; C-segment string.
function smoothSegments(pts) {
  let d = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)], p1 = pts[i];
    const p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
    d += `C${(p1[0] + (p2[0] - p0[0]) / 6).toFixed(1)},${(p1[1] + (p2[1] - p0[1]) / 6).toFixed(1)}`
      + ` ${(p2[0] - (p3[0] - p1[0]) / 6).toFixed(1)},${(p2[1] - (p3[1] - p1[1]) / 6).toFixed(1)}`
      + ` ${p2[0].toFixed(1)},${p2[1].toFixed(1)}`;
  }
  return d;
}

export default function ZoneDays({ rides, onOpenWorkout }) {
  const [choice, setChoice] = useState(null);
  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 3) return null;

  // Group by local calendar day, summing zone minutes across sessions and
  // remembering each session for the multi-session chooser.
  const byDay = new Map();
  for (const r of data) {
    const day = new Date(r.start).toLocaleDateString('en-CA');
    if (!byDay.has(day)) byDay.set(day, { mins: [0, 0, 0, 0, 0], sessions: [] });
    const entry = byDay.get(day);
    r.zones.forEach((z, i) => { entry.mins[i] += (z || 0) / 60; });
    entry.sessions.push({
      id: r.id,
      label: `${new Date(r.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        + ` · ${r.title || '?'}`
        + ` · ${Math.round(r.zones.reduce((sum, v) => sum + (v || 0), 0) / 60)}m`,
    });
  }
  const keys = [...byDay.keys()].sort();
  const t0 = Date.parse(keys[0]), tEnd = Date.parse(keys[keys.length - 1]);
  if (!(tEnd > t0)) return null;

  // Zero-fill every calendar day in the span (UTC-midnight stepping matches
  // the en-CA date keys).
  const days = [];
  for (let t = t0; t <= tEnd; t += DAY) {
    const key = new Date(t).toISOString().slice(0, 10);
    const entry = byDay.get(key);
    days.push(entry
      ? {
        day: key, mins: entry.mins, sessions: entry.sessions,
        total: entry.mins.reduce((s2, v) => s2 + v, 0),
      }
      : { day: key, mins: [0, 0, 0, 0, 0], sessions: [], total: 0 });
  }

  const tMax = (tEnd - t0) / DAY || 1;
  const x = day => PAD.l + ((Date.parse(day) - t0) / DAY / tMax) * (W - PAD.l - PAD.r);
  const maxTotal = Math.max(...days.map(d => d.total)) || 1;
  const half = (maxTotal / 2) * 1.12;
  const y = v => PAD.t + (1 - (v + half) / (2 * half)) * (H - PAD.t - PAD.b);

  // Silhouette offset: each day's stack is centered on zero, boundaries are
  // cumulative sums from -total/2 upward through Z1..Z5.
  const bounds = days.map(d => {
    const b = [-d.total / 2];
    for (const m of d.mins) b.push(b[b.length - 1] + m);
    return b;
  });
  const layerPath = z => {
    const top = days.map((d, i) => [x(d.day), y(bounds[i][z + 1])]);
    const bottom = days.map((d, i) => [x(d.day), y(bounds[i][z])]).reverse();
    return `M${top[0][0].toFixed(1)},${top[0][1].toFixed(1)}${smoothSegments(top)}`
      + `L${bottom[0][0].toFixed(1)},${bottom[0][1].toFixed(1)}${smoothSegments(bottom)}Z`;
  };

  const workoutDays = days.filter(d => d.sessions.length > 0);
  const pickDay = e => {
    const svg = e.currentTarget.ownerSVGElement;
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (W / rect.width);
    let best = null, bestD = Infinity;
    for (const d of workoutDays) {
      const dist = Math.abs(x(d.day) - vx);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    if (!best) return;
    if (best.sessions.length === 1) onOpenWorkout(best.sessions[0].id);
    else setChoice(best);
  };

  return (
    <div className={s.wrap}>
      <div className={s.name}>
        Time in Zone<span>MIN PER DAY · STREAMGRAPH · SAME-DAY SESSIONS SUMMED · CLICK A DAY</span>
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
        {ZONE_COLORS.map((c, z) => (
          <path key={z} d={layerPath(z)} fill={c} fillOpacity="0.85" />
        ))}
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
      {choice && (
        <div className={s.chooserBackdrop} onClick={() => setChoice(null)}>
          <div className={s.chooser} onClick={e => e.stopPropagation()}>
            <div className={s.chooserTitle}>{choice.day} · {choice.sessions.length} sessions</div>
            {choice.sessions.map(sess => (
              <button
                key={sess.id}
                className={s.chooserItem}
                onClick={() => { setChoice(null); onOpenWorkout(sess.id); }}
              >
                {sess.label}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
