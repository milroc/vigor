import { useMemo } from 'react';
import s from './Splom.module.css';

const CELL = 108, GAP = 8, PAD = 6;

// Scatterplot matrix: every pairwise combination of `fields` over `data`.
// Points brighten with data order, so on date-sorted rows the newest points
// stand out and drift across each cell as the metrics change together.
export default function Splom({ data, fields, color = '#c6fe28' }) {
  const n = fields.length;
  const size = n * CELL + (n - 1) * GAP;

  const ranges = useMemo(() => {
    const out = {};
    for (const f of fields) {
      const vals = data.map(d => d[f.key]).filter(v => v != null);
      let min = vals.length ? Math.min(...vals) : 0;
      let max = vals.length ? Math.max(...vals) : 1;
      const pad = (max - min || 1) * 0.06;
      min -= pad; max += pad;
      out[f.key] = { min, max };
    }
    return out;
  }, [data, fields]);

  if (data.length < 3) return null;

  const cellX = j => j * (CELL + GAP);
  const cellY = i => i * (CELL + GAP);
  const px = (key, v) => {
    const { min, max } = ranges[key];
    return PAD + ((v - min) / (max - min)) * (CELL - 2 * PAD);
  };
  const fmt = v => Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(Math.abs(v) < 3 ? 2 : 1);

  return (
    <div className={s.wrap}>
      <svg viewBox={`0 0 ${size} ${size}`} className={s.svg}>
        {fields.map((fy, i) => fields.map((fx, j) => {
          const x0 = cellX(j), y0 = cellY(i);
          if (i === j) {
            const { min, max } = ranges[fx.key];
            return (
              <g key={fx.key}>
                <rect x={x0} y={y0} width={CELL} height={CELL} className={s.diag} />
                <text x={x0 + CELL / 2} y={y0 + CELL / 2 - 2} className={s.label} textAnchor="middle">
                  {fx.label}
                </text>
                <text x={x0 + CELL / 2} y={y0 + CELL / 2 + 14} className={s.range} textAnchor="middle">
                  {fmt(min)} – {fmt(max)}
                </text>
              </g>
            );
          }
          const pts = data
            .map((d, k) => ({ x: d[fx.key], y: d[fy.key], k }))
            .filter(p => p.x != null && p.y != null);
          return (
            <g key={`${fy.key}:${fx.key}`}>
              <rect x={x0} y={y0} width={CELL} height={CELL} className={s.cell} />
              {pts.map(p => (
                <circle
                  key={p.k}
                  cx={x0 + px(fx.key, p.x)}
                  cy={y0 + CELL - px(fy.key, p.y)}
                  r="2.2"
                  fill={color}
                  fillOpacity={0.2 + 0.7 * (p.k / (data.length - 1 || 1))}
                />
              ))}
            </g>
          );
        }))}
      </svg>
      <div className={s.caption}>rows = y · columns = x · brighter dots = more recent</div>
    </div>
  );
}
