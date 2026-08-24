import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import s from '../Sleep.module.css';

// ---- Canvas marks layer ----
// The per-night marks are the bulk of every chart — up to 44k of them across the
// "All" range. As SVG elements each window change made React reconcile and Blink
// re-resolve style for every one of them, which is what made date scrubbing
// stutter. They're identical pixels either way, so they're drawn to a canvas
// underneath instead; axes, gridlines, target markers and the pointer surface
// stay as SVG on top, where text and CSS-variable theming still matter.

// Canvas takes literal colors, not `var(--x)`. Resolve against :root once per
// value; the tuner clears this when it re-themes.
const colorCache = new Map();
export function cssColor(v) {
  if (typeof v !== 'string' || !v.startsWith('var(')) return v;
  const hit = colorCache.get(v);
  if (hit) return hit;
  const name = v.slice(4, -1).trim();
  const resolved = getComputedStyle(document.documentElement).getPropertyValue(name).trim() || '#888';
  colorCache.set(v, resolved);
  return resolved;
}

// Palette generation: bumped when the color tuner writes new values so every
// canvas redraws with them (CSS variables can't cascade into canvas pixels).
let paletteVersion = 0;
const paletteSubs = new Set();
export function notifyPaletteChange() {
  colorCache.clear();
  paletteVersion++;
  for (const fn of paletteSubs) fn(paletteVersion);
}
export function usePaletteVersion() {
  const [v, setV] = useState(paletteVersion);
  useEffect(() => { paletteSubs.add(setV); return () => paletteSubs.delete(setV); }, []);
  return v;
}

// `draw` receives a 2D context already scaled to devicePixelRatio, so it can use
// the same coordinates the SVG viewBox uses. Give it a stable identity (useMemo
// / useCallback over the chart's real inputs) — it doubles as the redraw key.
export function MarksCanvas({ w, h, draw, filter }) {
  const ref = useRef(null);
  const pv = usePaletteVersion();
  useLayoutEffect(() => {
    const cv = ref.current;
    if (!cv || !w || !h) return;
    const dpr = window.devicePixelRatio || 1;
    const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
    if (cv.width !== W) cv.width = W;
    if (cv.height !== H) cv.height = H;
    const g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);
    if (draw) draw(g);
  }, [w, h, draw, pv]);
  return <canvas ref={ref} className={s.marksLayer} style={filter ? { filter } : undefined} aria-hidden="true" />;
}

// ---- Tiny drawing helpers, so the chart code reads like the JSX it replaced ----
export const fillRect = (g, x, y, w, h, color, alpha = 1) => {
  g.globalAlpha = alpha;
  g.fillStyle = cssColor(color);
  g.fillRect(x, y, Math.max(w, 0), Math.max(h, 0));
};
export const fillCircle = (g, cx, cy, r, color, alpha = 1) => {
  g.globalAlpha = alpha;
  g.fillStyle = cssColor(color);
  g.beginPath();
  g.arc(cx, cy, Math.max(r, 0), 0, Math.PI * 2);
  g.fill();
};
export const strokeLine = (g, x1, y1, x2, y2, color, alpha = 1, width = 1) => {
  g.globalAlpha = alpha;
  g.strokeStyle = cssColor(color);
  g.lineWidth = width;
  g.beginPath();
  g.moveTo(x1, y1);
  g.lineTo(x2, y2);
  g.stroke();
};
