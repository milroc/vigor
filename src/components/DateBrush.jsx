import { useEffect, useRef, useState } from 'react';
import s from './DateBrush.module.css';

// d3-brush-style date scrubber: one tick per item on a true time axis,
// with a lime brush window. Drag inside the window to move it, drag an
// edge to resize, drag on empty track to draw a fresh window.
const H = 44, PAD = { l: 44, r: 10 }, GRIP = 6;

export default function DateBrush({ dates, value, onChange }) {
  const ref = useRef(null);
  const [w, setW] = useState(640);
  useEffect(() => {
    const ro = new ResizeObserver(([e]) => {
      const { width } = e.contentRect;
      if (width) setW(prev => (Math.abs(prev - width) < 1 ? prev : width));
    });
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);

  const t0 = Math.min(...dates), t1 = Math.max(...dates);
  const span = t1 - t0 || 1;
  const x = t => PAD.l + ((t - t0) / span) * (w - PAD.l - PAD.r);
  const invert = px => t0 + ((px - PAD.l) / (w - PAD.l - PAD.r || 1)) * span;
  const clamp = t => Math.min(t1, Math.max(t0, t));
  const [lo, hi] = value;
  const drag = useRef(null);

  const pxOf = e => e.clientX - ref.current.getBoundingClientRect().left;
  const onDown = e => {
    const px = pxOf(e);
    const xLo = x(lo), xHi = x(hi);
    const mode = Math.abs(px - xLo) <= GRIP ? 'lo'
      : Math.abs(px - xHi) <= GRIP ? 'hi'
      : px > xLo && px < xHi ? 'move' : 'new';
    drag.current = { mode, px0: px, lo, hi };
    if (mode === 'new') {
      const t = clamp(invert(px));
      onChange([t, t]);
    }
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onMove = e => {
    const d = drag.current;
    if (!d) return;
    const px = pxOf(e);
    const t = clamp(invert(px));
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
    <div className={s.wrap} ref={ref}>
      <svg
        className={s.svg} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
        onPointerDown={onDown} onPointerMove={onMove}
        onPointerUp={onUp} onPointerCancel={onUp}
      >
        <rect className={s.track} x={PAD.l} y={0} width={Math.max(w - PAD.l - PAD.r, 0)} height={H} />
        <line x1={PAD.l} x2={w - PAD.r} y1={H / 2} y2={H / 2} stroke="#23231e" />
        {dates.map((t, i) => {
          const sel = t >= lo && t <= hi;
          return (
            <line
              key={i} x1={x(t)} x2={x(t)} y1={13} y2={H - 13}
              stroke={sel ? '#e8e8e0' : '#6b6b60'} strokeOpacity={sel ? 0.9 : 0.45}
            />
          );
        })}
        <rect
          className={s.window}
          x={xLo} y={6} width={Math.max(xHi - xLo, 1)} height={H - 12}
        />
        <rect className={s.grip} x={xLo - GRIP} y={0} width={GRIP * 2} height={H} />
        <rect className={s.grip} x={xHi - GRIP} y={0} width={GRIP * 2} height={H} />
      </svg>
    </div>
  );
}
