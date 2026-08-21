import { useEffect, useState } from 'react';

// Shared hover state, kept OUTSIDE React. Pointer moves fire at up to the
// display's refresh rate, and at the "All" range every pixel is a different
// night — so routing hover through useState re-rendered the whole Sleep tree
// (and every chart SVG) per pixel. Subscribers here are leaf components that
// either write styles imperatively (the column band, the axis) or re-render
// alone (the tooltip, the header date), so the chart SVGs are never touched.
let state = null;
const subs = new Set();

export const getHover = () => state;
export const subscribeHover = fn => { subs.add(fn); return () => subs.delete(fn); };

export function setHover(next) {
  if (next === state) return;
  // Nothing to do when both are "no hover".
  if (next == null && state == null) return;
  state = next;
  for (const fn of subs) fn(state);
}

// Re-render a component when the hovered NIGHT (or source section) changes,
// ignoring pure cursor movement within the same column.
export function useHoverTarget() {
  const [t, setT] = useState(() => {
    const h = getHover();
    return { i: h?.i ?? null, section: h?.section ?? null };
  });
  useEffect(() => subscribeHover(h => {
    setT(prev => {
      const i = h?.i ?? null, section = h?.section ?? null;
      return prev.i === i && prev.section === section ? prev : { i, section };
    });
  }), []);
  return t;
}
