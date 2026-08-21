import { useEffect, useMemo, useRef, useState } from 'react';
import { Delaunay } from 'd3-delaunay';
import s from './LineChart.module.css';

const W = 640, H = 180, PAD = { l: 44, r: 10, t: 10, b: 20 };

// seriesList: [{ samples: [{t, v}], opacity?, width? }] — all on one axis.
// Single-series callers pass seriesList={[{samples}]}. t may be seconds or a
// normalized phase position; xLabel labels the right edge either way.
// Pointy-top hex binning in pixel space; density → fill opacity.
function hexBins(points, x, y, r) {
  const colW = r * Math.sqrt(3), rowH = r * 1.5;
  const bins = new Map();
  for (const p of points) {
    if (p.v == null) continue;
    const py = y(p.v), row = Math.round(py / rowH);
    const off = row % 2 ? colW / 2 : 0;
    const col = Math.round((x(p.t) - off) / colW);
    const key = `${row}:${col}`;
    bins.set(key, (bins.get(key) || 0) + 1);
  }
  const out = [];
  for (const [key, count] of bins) {
    const [row, col] = key.split(':').map(Number);
    const off = row % 2 ? colW / 2 : 0;
    out.push({ cx: col * colW + off, cy: row * rowH, count });
  }
  return out;
}

const hexPath = (cx, cy, r) => Array.from({ length: 6 }, (_, i) => {
  const a = Math.PI / 3 * i + Math.PI / 6;
  return `${i ? 'L' : 'M'}${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
}).join('') + 'Z';

const HEX_R = 6; // one lattice for everything: background grid, target zone, density

// Linear interpolation over t-sorted samples.
function interpT(arr, t) {
  if (t <= arr[0].t) return arr[0].v;
  for (let i = 1; i < arr.length; i++) {
    if (t <= arr[i].t) {
      const a = arr[i - 1], b = arr[i];
      return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1));
    }
  }
  return arr[arr.length - 1].v;
}

// Scrub sync: hovering one chart broadcasts its t to every mounted chart;
// receivers with the same time domain (i.e. the same chart group on the
// page) show the scrub line and tooltip at that t.
const scrubBus = new Set();
const broadcastScrub = msg => { for (const fn of scrubBus) fn(msg); };

// Every lattice cell whose center falls inside the plot area.
function latticeCells(w, h) {
  const colW = HEX_R * Math.sqrt(3), rowH = HEX_R * 1.5;
  const cells = [];
  for (let row = Math.ceil(PAD.t / rowH); row <= Math.floor((h - PAD.b) / rowH); row++) {
    const off = row % 2 ? colW / 2 : 0;
    for (let col = Math.ceil((PAD.l - off) / colW); col <= Math.floor((w - PAD.r - off) / colW); col++) {
      cells.push({ cx: col * colW + off, cy: row * rowH });
    }
  }
  return cells;
}

export default function LineChart({ title, unit, seriesList, color, dividerT, zeroLine, xLabel, xLabelLeft, fillFirst, hexPoints, targetBand, fill, onPointClick, tipT, hoverId, onHover, bands }) {
  // The plot renders in pixel space: the viewBox tracks the measured size of
  // the plot container, so text never distorts when the layout stretches it.
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

  const bandPts = targetBand ? [...targetBand.lower, ...targetBand.upper] : [];
  const all = seriesList.flatMap(x => x.samples).concat(hexPoints || []).concat(bandPts);
  // null values are gaps: they hold their spot on the time axis but
  // contribute nothing to the value scale and break the line.
  const vals = all.filter(p => p.v != null);
  const tMin = Math.min(...all.map(p => p.t), 0);
  const tMax = Math.max(...all.map(p => p.t));
  let vMin = Math.min(...vals.map(p => p.v));
  let vMax = Math.max(...vals.map(p => p.v));
  if (zeroLine) { vMin = Math.min(vMin, 0); vMax = Math.max(vMax, 0); }
  const span = vMax - vMin || 1;
  vMin -= span * 0.08; vMax += span * 0.08;

  const x = t => PAD.l + ((t - tMin) / (tMax - tMin || 1)) * (w - PAD.l - PAD.r);
  const y = v => PAD.t + (1 - (v - vMin) / (vMax - vMin)) * (h - PAD.t - PAD.b);
  const pathOf = samples => {
    let d = '', pen = false;
    for (const p of samples) {
      if (p.v == null) { pen = false; continue; }
      d += `${pen ? 'L' : 'M'}${x(p.t).toFixed(1)},${y(p.v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };

  const gridY = [vMin + (vMax - vMin) * 0.25, vMin + (vMax - vMin) * 0.5, vMin + (vMax - vMin) * 0.75];
  const gid = `g-${title.replace(/\W/g, '')}`;
  const fmt = v => Math.abs(v) >= 100 ? Math.round(v) : +v.toFixed(Math.abs(v) < 3 ? 2 : 1);
  const first = seriesList[0];
  let areaPath = null;
  if (fillFirst && first?.samples.length) {
    // One closed polygon per contiguous run so gaps stay unfilled.
    const segs = [];
    let cur = [];
    for (const p of first.samples) {
      if (p.v == null) { if (cur.length > 1) segs.push(cur); cur = []; }
      else cur.push(p);
    }
    if (cur.length > 1) segs.push(cur);
    const baseY = y(zeroLine ? 0 : vMin).toFixed(1);
    areaPath = segs.map(seg =>
      `${pathOf(seg)}L${x(seg[seg.length - 1].t).toFixed(1)},${baseY}L${x(seg[0].t).toFixed(1)},${baseY}Z`
    ).join('') || null;
  }

  // The hex layer is thousands of <path> elements over tens of thousands of
  // points — memoized so re-renders (selection, resize ticks) don't pay for
  // re-binning unless the geometry or data actually changed.
  const hexLayer = useMemo(() => {
    if (!all.length || (!hexPoints && !targetBand)) return null;
    // Single shared lattice: every cell gets a stroke. Empty cells are
    // the faint background grid, target-zone cells get a lighter base +
    // stroke, and density cells layer color on top — all at the same
    // radius so the three cell classes tile seamlessly.
    const cells = latticeCells(w, h);

    const interp = (arr, t) => {
      if (t <= arr[0].t) return arr[0].v;
      for (let i = 1; i < arr.length; i++) {
        if (t <= arr[i].t) {
          const a = arr[i - 1], b = arr[i];
          return a.v + (b.v - a.v) * ((t - a.t) / (b.t - a.t || 1));
        }
      }
      return arr[arr.length - 1].v;
    };
    const inZone = ({ cx, cy }) => {
      if (!targetBand) return false;
      const t0 = targetBand.lower[0].t, t1 = targetBand.lower[targetBand.lower.length - 1].t;
      const t = tMin + ((cx - PAD.l) / (w - PAD.l - PAD.r)) * (tMax - tMin || 1);
      if (t < t0 || t > t1) return false;
      const yU = y(interp(targetBand.upper, t)), yL = y(interp(targetBand.lower, t));
      // Zero-width bands (machine setpoints) become a single hex row.
      return cy >= Math.min(yU, yL) - 4.5 && cy <= Math.max(yU, yL) + 4.5;
    };

    const bins = hexPoints ? hexBins(hexPoints, x, y, HEX_R) : [];
    const maxCount = Math.max(...bins.map(b => b.count), 1);

    // Layered so the zone's stroke always wins on edges shared with
    // non-zone neighbors: empty grid first, density next, zone last.
    const zoneCells = [], gridCells = [];
    for (const c of cells) (inZone(c) ? zoneCells : gridCells).push(c);

    return (
      <>
        {gridCells.map((c, i) => (
          <path key={`g${i}`} d={hexPath(c.cx, c.cy, HEX_R)} className={s.gridHex} />
        ))}
        {bins.map((b, i) => (
          <path
            key={`h${i}`}
            d={hexPath(b.cx, b.cy, HEX_R)}
            fill={color}
            fillOpacity={0.05 + 0.28 * Math.pow(b.count / maxCount, 0.6)}
            stroke="#20201b"
            strokeWidth="0.6"
          />
        ))}
        {zoneCells.map((c, i) => (
          <path key={`z${i}`} d={hexPath(c.cx, c.cy, HEX_R)} className={s.targetHex} />
        ))}
      </>
    );
  }, [hexPoints, targetBand, w, h, tMin, tMax, vMin, vMax, color]);

  // X-axis scrub: pointer position maps to t only (y is ignored); synced
  // across charts sharing this domain via the module-level bus.
  const [scrubT, setScrubT] = useState(null);
  const domainRef = useRef({ tMin, tMax });
  domainRef.current = { tMin, tMax };
  useEffect(() => {
    const fn = msg => {
      if (msg == null) return setScrubT(null);
      const { tMin: a, tMax: b } = domainRef.current;
      const eps = (b - a || 1) * 0.001;
      setScrubT(Math.abs(msg.tMin - a) < eps && Math.abs(msg.tMax - b) < eps ? msg.t : null);
    };
    scrubBus.add(fn);
    return () => scrubBus.delete(fn);
  }, []);

  const onScrubMove = e => {
    const rect = plotRef.current.getBoundingClientRect();
    const frac = (e.clientX - rect.left - PAD.l) / (rect.width - PAD.l - PAD.r || 1);
    broadcastScrub({ t: tMin + Math.min(1, Math.max(0, frac)) * (tMax - tMin || 1), tMin, tMax });
  };
  const onScrubEnd = () => broadcastScrub(null);

  // Tooltip series: explicitly labeled ones, else the boldest line (the
  // average / trend fit) so every caller gets a sensible readout.
  let tipSeries = seriesList.filter(ser => ser.label && ser.samples.length);
  if (!tipSeries.length) {
    const lines = seriesList.filter(ser => !ser.dots && ser.samples.length > 1);
    tipSeries = lines.length
      ? [lines.reduce((a, b) => ((b.width ?? 2) > (a.width ?? 2) ? b : a), lines[0])]
      : [];
  }
  const scrub = scrubT == null || !tipSeries.length ? null : {
    px: x(scrubT),
    vals: tipSeries.map(ser => {
      const pts = ser.samples.filter(p => p.v != null);
      return pts.length
        ? { label: ser.label, color: ser.color ?? color, v: interpT(pts, scrubT) }
        : null;
    }).filter(Boolean),
  };

  // Click targets for scatter points: a voronoi cell per dot, so any click
  // in the plot lands on the nearest point. Point hover is controlled by
  // the parent (hoverId), so pointing at a workout in one chart rings it
  // in every chart that plots the same workout.
  const dotSeries = onPointClick ? seriesList.find(ser => ser.dots && ser.samples.length > 1) : null;
  const hoverIdx = dotSeries && hoverId != null
    ? dotSeries.samples.findIndex(p => p.id === hoverId) : -1;
  const voronoiCells = useMemo(() => {
    if (!dotSeries) return null;
    // Guard against degenerate/NaN inputs (e.g. null values → NaN pixels):
    // a Delaunay throw here would otherwise crash the whole page.
    try {
      const pixels = dotSeries.samples.map(p => [x(p.t), y(p.v)]);
      if (pixels.some(([px, py]) => !Number.isFinite(px) || !Number.isFinite(py))) return null;
      const vor = Delaunay.from(pixels).voronoi([PAD.l, PAD.t, w - PAD.r, h - PAD.b]);
      return dotSeries.samples.map((_, i) => vor.renderCell(i));
    } catch { return null; }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dotSeries, w, h, tMin, tMax, vMin, vMax]);

  if (!all.length || !vals.length) return null;

  return (
    <div className={s.wrap + (fill ? ` ${s.fill}` : '')}>
      <div className={s.name}>{title}<span>{unit}</span></div>
      <div className={s.plot} ref={plotRef} onPointerMove={onScrubMove} onPointerLeave={onScrubEnd}>
      <svg className={s.svg} data-chart viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.35" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {bands && bands.map((b, i) => {
          // Horizontal value bands (e.g. HR zones) behind everything else,
          // clipped to the visible value range, labeled at the right edge.
          const lo = Math.max(b.from, vMin), hi = Math.min(b.to, vMax);
          if (hi <= lo) return null;
          return (
            <g key={`band${i}`}>
              <rect x={PAD.l} width={w - PAD.l - PAD.r} y={y(hi)} height={y(lo) - y(hi)}
                fill={b.color} fillOpacity="0.3" />
              <text className={s.axisLabel} x={w - PAD.r - 4} y={y(hi) + 10}
                textAnchor="end" style={{ fill: b.color }}>{b.label}</text>
            </g>
          );
        })}
        {gridY.map((g, i) => (
          <line key={i} x1={PAD.l} x2={w - PAD.r} y1={y(g)} y2={y(g)} stroke="#23231e" strokeDasharray="3,4" />
        ))}
        {hexLayer}
        {zeroLine && (
          <line x1={PAD.l} x2={w - PAD.r} y1={y(0)} y2={y(0)} stroke={color} strokeDasharray="4,4" strokeOpacity="0.5" />
        )}
        {dividerT != null && (
          <>
            <line x1={x(dividerT)} x2={x(dividerT)} y1={PAD.t} y2={h - PAD.b} stroke={color} strokeDasharray="4,4" strokeOpacity="0.7" />
            <text className={s.divLabel} x={x(dividerT) - 4} y={h - PAD.b + 12} textAnchor="end">Con./Ecc.</text>
          </>
        )}
        {areaPath && <path d={areaPath} fill={`url(#${gid})`} />}
        {seriesList.map((ser, i) => ser.dots ? (
          <g key={i} fill={ser.color ?? color} fillOpacity={ser.opacity ?? 0.8}>
            {ser.samples.map((p, j) => p.v == null ? null : (
              <circle
                key={j} cx={x(p.t)} cy={y(p.v)} r={ser.r ?? 3}
                fill={p.color} fillOpacity={p.opacity}
              />
            ))}
          </g>
        ) : (
          <path
            key={i}
            d={pathOf(ser.samples)}
            fill="none"
            stroke={ser.color ?? color}
            strokeWidth={ser.width ?? 2}
            strokeOpacity={ser.opacity ?? 1}
            strokeLinejoin="round"
          />
        ))}
        <text className={s.axisLabel} x={PAD.l - 6} y={y(vMax) + 8} textAnchor="end">{fmt(vMax)}</text>
        <text className={s.axisLabel} x={PAD.l - 6} y={y((vMax + vMin) / 2) + 3} textAnchor="end">{fmt((vMax + vMin) / 2)}</text>
        <text className={s.axisLabel} x={PAD.l - 6} y={y(vMin)} textAnchor="end">{fmt(vMin)}</text>
        {xLabelLeft && <text className={s.axisLabel} x={PAD.l} y={h - PAD.b + 12} textAnchor="start">{xLabelLeft}</text>}
        {xLabel && <text className={s.axisLabel} x={w - PAD.r} y={h - PAD.b + 12} textAnchor="end">{xLabel}</text>}
        {voronoiCells && (
          <g>
            {hoverIdx >= 0 && (() => {
              // Dotted guides to both axes with the observed values.
              const p = dotSeries.samples[hoverIdx];
              const hx = x(p.t), hy = y(p.v);
              const yTxt = String(fmt(p.v));
              const xTxt = p.dateLabel ?? String(fmt(p.t));
              return (
                <g pointerEvents="none">
                  <line x1={PAD.l} x2={hx} y1={hy} y2={hy}
                    stroke={color} strokeDasharray="2,3" strokeOpacity="0.8" />
                  <line x1={hx} x2={hx} y1={hy} y2={h - PAD.b}
                    stroke={color} strokeDasharray="2,3" strokeOpacity="0.8" />
                  <circle cx={hx} cy={hy} r="5.5" fill="none" stroke={color} strokeWidth="1.5" />
                  <rect x={PAD.l + 2} y={hy - 15} width={yTxt.length * 6.4 + 8} height={13}
                    fill="#0a0a08" fillOpacity="0.9" />
                  <text className={s.hoverLabel} x={PAD.l + 6} y={hy - 5} fill={color}>{yTxt}</text>
                  <rect x={hx - (xTxt.length * 6.4 + 8) / 2} y={h - PAD.b + 2}
                    width={xTxt.length * 6.4 + 8} height={13} fill="#0a0a08" fillOpacity="0.9" />
                  <text className={s.hoverLabel} x={hx} y={h - PAD.b + 12}
                    textAnchor="middle" fill={color}>{xTxt}</text>
                </g>
              );
            })()}
            {voronoiCells.map((d, i) => d && (
              <path
                key={i} d={d} fill="transparent" style={{ cursor: 'pointer' }}
                onClick={() => onPointClick(dotSeries.samples[i])}
                onMouseEnter={() => onHover?.(dotSeries.samples[i].id)}
                onMouseLeave={() => onHover?.(null)}
              />
            ))}
          </g>
        )}
        {scrub && (
          <g pointerEvents="none">
            <line className={s.scrubLine} x1={scrub.px} x2={scrub.px} y1={PAD.t} y2={h - PAD.b} />
            {scrub.vals.map((d, i) => (
              <circle key={i} className={s.scrubDot} cx={scrub.px} cy={y(d.v)} r="3" fill={d.color} />
            ))}
          </g>
        )}
      </svg>
      {scrub && (
        <div
          className={s.tooltip}
          style={{
            left: scrub.px,
            transform: scrub.px > w * 0.72 ? 'translateX(calc(-100% - 10px))' : 'translateX(10px)',
          }}
        >
          <div className={s.tipT}>
            {(tipT ?? (t => `${t >= 0 ? '+' : ''}${t.toFixed(2)}s`))(scrubT)}
          </div>
          {scrub.vals.map((d, i) => (
            <div key={i} className={s.tipRow}>
              <i style={{ background: d.color }} />
              {d.label ? `${d.label} ` : ''}{fmt(d.v)}
            </div>
          ))}
        </div>
      )}
      </div>
    </div>
  );
}
