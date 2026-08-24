import { createContext, useContext, useRef, useSyncExternalStore } from 'react';

// Shared hover state, kept OUTSIDE the render path. Pointer moves arrive at up to
// the display's refresh rate, and at the "All" range every pixel is a different
// night — so routing hover through useState re-rendered the whole Sleep tree (and
// every chart SVG) per pixel. Subscribers here are leaf components that either
// write styles imperatively (the column band) or re-render alone (the tooltip,
// the header date).
//
// The store is created per-provider rather than living at module scope, so it
// dies with the tree: navigating away and back can't resurrect a stale hover,
// two <Sleep> instances can't share one cursor, and a leaked subscription can't
// outlive the page. It is also directly unit-testable without React.
export function createHoverStore() {
  let state = null;
  // getSnapshot must return a referentially stable value or useSyncExternalStore
  // loops forever, so the {i, section} view is cached and only replaced when one
  // of them actually changes. That also makes the "same column, moved cursor"
  // bail a property of the data rather than of each consumer.
  let target = { i: null, section: null };
  const subs = new Set();
  return {
    getHover: () => state,
    getTarget: () => target,
    subscribe: fn => { subs.add(fn); return () => subs.delete(fn); },
    setHover: next => {
      if (next === state || (next == null && state == null)) return;
      state = next;
      const i = next?.i ?? null, section = next?.section ?? null;
      if (target.i !== i || target.section !== section) target = { i, section };
      for (const fn of subs) fn();
    },
  };
}

const HoverContext = createContext(null);

export function HoverProvider({ children }) {
  const ref = useRef(null);
  if (!ref.current) ref.current = createHoverStore();
  return <HoverContext.Provider value={ref.current}>{children}</HoverContext.Provider>;
}

export function useHoverStore() {
  const store = useContext(HoverContext);
  if (!store) throw new Error('useHoverStore must be used inside <HoverProvider>');
  return store;
}

// Re-render when the hovered NIGHT (or source section) changes, ignoring cursor
// movement within one column. useSyncExternalStore closes the gap between render
// and the subscribing effect — a hand-rolled subscription can drop the last
// update before the pointer stops and leave the tooltip a night behind.
export function useHoverTarget() {
  const store = useHoverStore();
  return useSyncExternalStore(store.subscribe, store.getTarget, store.getTarget);
}
