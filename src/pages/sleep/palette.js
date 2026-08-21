// Sleep-tab color palette, shared across the scrubber, skyline, charts, legend,
// and the color tuner. Each color is a CSS variable (defaults in global.css :root)
// so the in-tab COLOR TUNER can re-theme every chart at runtime by writing the var
// via document.documentElement.style.setProperty — zero prop-threading.
export const STAGE = { deep: 'var(--st-deep)', core: 'var(--st-core)', rem: 'var(--st-rem)', awake: 'var(--st-awake)' };
export const INBED_PRE = 'var(--inbed-pre)';   // time in bed before sleep onset (lighter gray)
export const INBED_POST = 'var(--inbed-post)'; // time in bed after final wake (darker gray)
export const RESP = 'var(--c-resp)';
export const SPO2 = 'var(--c-spo2)';
export const DIST = 'var(--c-dist)';    // breathing disturbances
export const FULLWAKE = 'var(--c-fullwake)'; // minutes in full (>=10m) awakenings
export const HR = 'var(--c-hr)';
export const HRV = 'var(--c-hrv)';
export const NAP = 'var(--c-nap)';
export const DEBT = 'var(--c-debt)';
export const LOAD = 'var(--c-load)';    // training load (active energy)
export const RHR = 'var(--c-rhr)';      // following-day resting HR (recovery output)
export const DAYLIGHT = 'var(--c-daylight)'; // time in daylight (bedtime input)
// Consistency has its OWN palette (must not reuse stage colors) — its own vars.
export const BED_TGT = 'var(--tgt-bed)';
export const WAKE_TGT = 'var(--tgt-wake)';

// The default (ORIGINAL, pre-audit) palette — also the tuner's per-role "revert"
// target and the set of vars applyTunerState knows how to override.
export const TUNER_DEFAULTS = {
  '--st-deep': '#4da3ff', '--st-core': '#3fd8c7', '--st-rem': '#b48aff', '--st-awake': '#f78e1e',
  '--tgt-bed': '#6d7bff', '--tgt-wake': '#ffc64a',
  '--inbed-pre': '#6a6a60', '--inbed-post': '#3d3d37',
  '--c-hr': '#ff6b9d', '--c-hrv': '#c6a0ff', '--c-resp': '#9fe8ff', '--c-spo2': '#e8e8e0', '--c-dist': '#ff8a5c',
  '--c-nap': '#c6fe28', '--c-debt': '#e8705a', '--c-load': '#7a7a70',
};

export const TUNER_LS = 'sleepTunerV1';

// Apply a persisted tuner state (overrides + comp-mute) to :root. Called both by
// the panel and once on page load so a reload keeps the working set even when the
// panel is closed. Returns the parsed state (or null).
export function applyTunerState() {
  if (typeof document === 'undefined') return null;
  let st = null;
  try { const raw = localStorage.getItem(TUNER_LS); if (raw) st = JSON.parse(raw); } catch { return null; }
  if (!st) return null;
  const root = document.documentElement, over = st.over || {};
  for (const k of Object.keys(TUNER_DEFAULTS)) {
    if (over[k]) root.style.setProperty(k, over[k]); else root.style.removeProperty(k);
  }
  const m = st.mute || { sat: 1, bri: 1 };
  root.style.setProperty('--comp-mute', `saturate(${m.sat}) brightness(${m.bri})`);
  return st;
}
