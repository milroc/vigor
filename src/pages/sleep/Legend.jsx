import { useState } from 'react';
import s from '../Sleep.module.css';

// ---- Legend: each entry is a mini-glyph shaped like the mark it stands for
// (a horizontal box-plot, bubbles, bars, a line+dot, or a stage swatch) so the
// legend reads as a key to the chart. Hovering an entry explains how to read it. ----
export function LegendGlyph({ type, color }) {
  const c = color;
  if (type === 'box') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      <line x1="1" x2="25" y1="6" y2="6" stroke={c} strokeOpacity="0.4" />
      <rect x="8" y="2.5" width="10" height="7" fill={c} fillOpacity="0.32" />
      <line x1="13" x2="13" y1="2.5" y2="9.5" stroke={c} strokeWidth="1.4" />
    </svg>
  );
  if (type === 'bar') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      {[[4, 5], [11, 9], [18, 3]].map(([x, h], i) => <rect key={i} x={x} y={11 - h} width="4" height={h} fill={c} />)}
    </svg>
  );
  if (type === 'bubble') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      {[[5, 1.8], [13, 3], [21, 4.2]].map(([cx, r], i) => <circle key={i} cx={cx} cy="6" r={r} fill={c} fillOpacity="0.85" />)}
    </svg>
  );
  if (type === 'linedot') return (
    <svg width="26" height="12" viewBox="0 0 26 12" aria-hidden>
      <polyline points="1,9 8,4 14,7 20,3 25,6" fill="none" stroke={c} strokeWidth="1.4" />
      <circle cx="14" cy="7" r="2" fill={c} />
    </svg>
  );
  return <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden><rect x="1" y="1" width="10" height="10" rx="1.5" fill={c} /></svg>;
}
export function LegendItem({ item }) {
  const [hov, setHov] = useState(false);
  return (
    <span className={s.legendItem} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <LegendGlyph type={item.glyph} color={item.color} />
      <span>{item.label}</span>
      {hov && item.tip && <span className={s.infoPop}>{item.tip}</span>}
    </span>
  );
}
export function Legend({ items }) {
  return <div className={s.legend}>{items.map(it => <LegendItem key={it.label} item={it} />)}</div>;
}

// ---- Sub-chart caption: names a stacked chart inside a section and, on hover,
// explains in detail how to read it (same rich-tooltip treatment as the legend). ----
export function SubLabel({ label, tip }) {
  const [hov, setHov] = useState(false);
  return (
    <div className={s.subLabel} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      {label}
      {hov && tip && <span className={s.infoPop}>{tip}</span>}
    </div>
  );
}

