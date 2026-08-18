import { useEffect, useRef, useState } from 'react';
import s from './ZoneDays.module.css';

// Time in zone over time: one stacked bar per calendar day (Z1 bottom → Z5
// top, minutes), with all of that day's sessions summed, on a true time
// axis so training gaps stay visible as empty days. Clicking picks the
// nearest workout day; days with several sessions open an inline chooser.
// Peloton's zone palette: Z1 blue, Z2 green, Z3 yellow, Z4 orange, Z5 red
// (hex values approximated from the app — Peloton doesn't publish them).
export const ZONE_COLORS = ['#3b9ad9', '#7ec642', '#f6c344', '#f78e1e', '#eb3745'];
// Same geometry as LineChart so charts line up column-for-column.
const W = 640, H = 180, PAD = { l: 44, r: 10, t: 10, b: 20 };
const DAY = 86_400_000;

export default function ZoneDays({ rides, onOpenWorkout, hoverId, onHover, fill }) {
  const [choice, setChoice] = useState(null);
  // Pixel-space sizing, same pattern as LineChart: the viewBox tracks the
  // measured plot size so a flex parent can stretch the chart without
  // distorting text.
  const plotRef = useRef(null);
  const [size, setSize] = useState({ w: W, h: H });
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      if (width && height) {
        setSize(prev =>
          Math.abs(prev.w - width) < 1 && Math.abs(prev.h - height) < 1
            ? prev : { w: width, h: height }
        );
      }
    });
    if (plotRef.current) ro.observe(plotRef.current);
    return () => ro.disconnect();
  }, []);
  const { w, h } = size;

  const data = rides.filter(r => r.zones?.some(v => v > 0));
  if (data.length < 2) return null;

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
  const days = [...byDay.entries()]
    .map(([day, { mins, sessions }]) => ({
      day, mins, sessions, total: mins.reduce((sum, v) => sum + v, 0),
    }))
    .sort((a, b) => a.day.localeCompare(b.day));

  // Zone totals across the selection live in the legend, next to the
  // colors they describe.
  const zoneTotals = [0, 1, 2, 3, 4].map(z =>
    data.reduce((sum, r) => sum + (r.zones[z] || 0), 0));
  const fmtTotal = secs => secs >= 3600
    ? `${(secs / 3600).toFixed(1)}h` : `${Math.round(secs / 60)}m`;

  const t0 = Date.parse(days[0].day);
  const tMax = (Date.parse(days[days.length - 1].day) - t0) / DAY || 1;
  const x = day => PAD.l + ((Date.parse(day) - t0) / DAY / tMax) * (w - PAD.l - PAD.r);
  const maxTotal = Math.max(...days.map(d => d.total)) * 1.06 || 1;
  const y = v => PAD.t + (1 - v / maxTotal) * (h - PAD.t - PAD.b);
  // One slot per calendar day on the axis; bars fill most of a slot.
  const barW = Math.max(2, Math.min(10, ((w - PAD.l - PAD.r) / (tMax + 1)) * 0.8));
  const grid = [0.25, 0.5, 0.75].map(f => (maxTotal / 1.06) * f);

  const nearestDay = e => {
    const svg = e.currentTarget.ownerSVGElement;
    const rect = svg.getBoundingClientRect();
    const vx = (e.clientX - rect.left) * (w / rect.width);
    let best = null, bestD = Infinity;
    for (const d of days) {
      const dist = Math.abs(x(d.day) - vx);
      if (dist < bestD) { bestD = dist; best = d; }
    }
    return best;
  };
  const pickDay = e => {
    const best = nearestDay(e);
    if (!best) return;
    if (best.sessions.length === 1) onOpenWorkout(best.sessions[0].id);
    else setChoice(best);
  };

  return (
    <div className={s.wrap + (fill ? ` ${s.fill}` : '')}>
      <div className={s.name}>
        Time in Zone<span>MIN PER DAY · STACKED Z1→Z5 · SAME-DAY SESSIONS SUMMED · CLICK A DAY</span>
        <span className={s.legend}>
          {ZONE_COLORS.map((c, i) => (
            <span key={i} className={s.legendItem}>
              <span className={s.swatch} style={{ background: c }} />
              Z{i + 1}{zoneTotals[i] > 0 ? ` ${fmtTotal(zoneTotals[i])}` : ''}
            </span>
          ))}
        </span>
      </div>
      <div className={s.plot} ref={plotRef}>
      <svg className={s.svg} viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        {grid.map((g, i) => (
          <g key={i}>
            <line x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)}
              stroke="#23231e" strokeDasharray="3,4" />
            <text className={s.axis} x={PAD.l - 6} y={y(g) + 3} textAnchor="end">
              {Math.round(g)}
            </text>
          </g>
        ))}
        <line x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} stroke="#23231e" />
        {days.map(d => {
          const hovered = hoverId != null && d.sessions.some(sess => sess.id === hoverId);
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
                fill={ZONE_COLORS[z]} fillOpacity={hovered ? 1 : 0.9}
                stroke={hovered ? '#e8e8e0' : 'none'} strokeWidth={hovered ? 1 : 0}
              >
                <title>{d.day} · {Math.round(d.total)} min</title>
              </rect>
            );
          });
        })}
        <text className={s.axis} x={PAD.l} y={h - 4} textAnchor="start">{days[0].day}</text>
        <text className={s.axis} x={w - PAD.r} y={h - 4} textAnchor="end">
          {days[days.length - 1].day}
        </text>
        {onOpenWorkout && (
          <rect
            x={PAD.l} y={PAD.t} width={w - PAD.l - PAD.r} height={h - PAD.t - PAD.b}
            fill="transparent" style={{ cursor: 'pointer' }} onClick={pickDay}
            onMouseMove={onHover ? e => onHover(nearestDay(e)?.sessions[0]?.id ?? null) : undefined}
            onMouseLeave={onHover ? () => onHover(null) : undefined}
          />
        )}
      </svg>
      </div>
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
