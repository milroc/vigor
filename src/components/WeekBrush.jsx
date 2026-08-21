import { useEffect, useRef, useState } from 'react';
import s from './WeekBrush.module.css';

// Full-history weekly bar chart that IS the brush: drag inside the window to
// move it, drag an edge to resize, drag on empty bars to draw a fresh window.
// Bars inside the selection are highlighted; the rest dim. Same interaction
// model as DateBrush, but the bars themselves are the scrub surface.
const PAD = { l: 44, r: 10, t: 12, b: 16 }, GRIP = 6;

export default function WeekBrush({ weeks, value, onChange, color = '#c6fe28', height = 132, fmt = v => Math.round(v), tipT }) {
  const H = height;
  const ref = useRef(null);
  const [w, setW] = useState(760);
  const drag = useRef(null);

  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width } = e.contentRect;
      if (width) setW(prev => (Math.abs(prev - width) < 1 ? prev : width));
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  if (!weeks.length) return <div ref={ref} />;
  const t0 = weeks[0].ms, t1 = weeks[weeks.length - 1].ms;
  const span = t1 - t0 || 1;
  const plotW = Math.max(w - PAD.l - PAD.r, 1);
  const yH = H - PAD.t - PAD.b;
  const x = t => PAD.l + ((t - t0) / span) * plotW;
  const invert = px => t0 + ((px - PAD.l) / plotW) * span;
  const clamp = t => Math.min(t1, Math.max(t0, t));
  const maxV = Math.max(...weeks.map(k => k.v), 1e-9);
  const barW = Math.max(1, plotW / weeks.length - 0.5);
  const [lo, hi] = value;

  const pxOf = e => e.clientX - ref.current.getBoundingClientRect().left;
  const onDown = e => {
    const px = pxOf(e);
    const xLo = x(lo), xHi = x(hi);
    const mode = Math.abs(px - xLo) <= GRIP ? 'lo'
      : Math.abs(px - xHi) <= GRIP ? 'hi'
      : px > xLo && px < xHi ? 'move' : 'new';
    drag.current = { mode, px0: px, lo, hi };
    if (mode === 'new') { const t = clamp(invert(px)); onChange([t, t]); }
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* not supported in some envs */ }
  };
  const onMove = e => {
    const d = drag.current;
    if (!d) return;
    const px = pxOf(e), t = clamp(invert(px));
    if (d.mode === 'move') {
      const width = d.hi - d.lo;
      const start = Math.max(t0, Math.min(t1 - width, d.lo + invert(px) - invert(d.px0)));
      onChange([start, start + width]);
    } else if (d.mode === 'lo') {
      onChange([Math.min(t, d.hi), d.hi]);
    } else if (d.mode === 'hi') {
      onChange([d.lo, Math.max(t, d.lo)]);
    } else {
      const a = clamp(invert(d.px0));
      onChange([Math.min(a, t), Math.max(a, t)]);
    }
  };
  const onUp = () => { drag.current = null; };

  const xLo = x(lo), xHi = x(hi);
  return (
    <div className={s.wrap} ref={ref} style={{ height }}>
      <svg
        className={s.svg} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
        onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      >
        <text x={PAD.l - 6} y={PAD.t + 4} className={s.axis} textAnchor="end">{fmt(maxV)}</text>
        <line x1={PAD.l} x2={w - PAD.r} y1={H - PAD.b} y2={H - PAD.b} stroke="#23231e" />
        {weeks.map((k, i) => {
          const sel = k.ms >= lo && k.ms <= hi;
          const bh = Math.max(0, (k.v / maxV) * yH);
          return (
            <rect
              key={i} x={x(k.ms) - barW / 2} y={H - PAD.b - bh}
              width={barW} height={bh} fill={color} fillOpacity={sel ? 0.92 : 0.24}
            >
              <title>{`${tipT ? tipT(k.ms) : ''} · ${fmt(k.v)}`}</title>
            </rect>
          );
        })}
        <rect
          className={s.window}
          style={{ stroke: color, fill: color }}
          x={xLo} y={PAD.t - 6} width={Math.max(xHi - xLo, 1)} height={H - PAD.t - PAD.b + 10}
        />
        <rect className={s.grip} x={xLo - GRIP} y={0} width={GRIP * 2} height={H} />
        <rect className={s.grip} x={xHi - GRIP} y={0} width={GRIP * 2} height={H} />
      </svg>
    </div>
  );
}
