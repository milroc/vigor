// COLOR TUNER — a dismissible in-tab dev panel that live-previews chart colors.
// Every chart color is a CSS var (see global.css :root); the tuner writes those
// vars at runtime via document.documentElement.style.setProperty, so picking a
// color instantly re-themes every chart with zero prop-threading. State persists
// in localStorage; Copy exports the working palette as JS consts + a :root block.
import { useEffect, useMemo, useRef, useState } from 'react';
import { TUNER_DEFAULTS, TUNER_LS, applyTunerState } from './palette.js';
import s from '../Sleep.module.css';

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// Per-role option chips: Original (default) + Audit (where one exists) + a couple
// tasteful alternatives. The <input type=color> covers arbitrary custom values.
const TUNER_OPTS = {
  '--st-deep': [['Original', '#4da3ff'], ['Deep indigo', '#3d6bd6'], ['Slate', '#5b7fa6']],
  '--st-core': [['Original', '#3fd8c7'], ['Teal', '#2fb3a4'], ['Sea', '#57c8d8']],
  '--st-rem': [['Original', '#b48aff'], ['Violet', '#9d6bff'], ['Orchid', '#c79cf0']],
  '--st-awake': [['Original', '#f78e1e'], ['Audit', '#f5a623'], ['Amber', '#ffb347']],
  '--tgt-bed': [['Original', '#6d7bff'], ['Indigo', '#5865f2'], ['Steel', '#7d8bd4']],
  '--tgt-wake': [['Original', '#ffc64a'], ['Gold', '#ffd54a'], ['Marigold', '#f5a623']],
  '--inbed-pre': [['Original', '#6a6a60'], ['Warm gray', '#7a746a'], ['Cool gray', '#66686a']],
  '--inbed-post': [['Original', '#3d3d37'], ['Audit', '#4a4a42'], ['Charcoal', '#33332c']],
  '--c-hr': [['Original', '#ff6b9d'], ['Audit', '#ff5db1'], ['Rose', '#ff8fb3']],
  '--c-hrv': [['Original', '#c6a0ff'], ['Audit', '#e0b0ff'], ['Lilac', '#b78dff']],
  '--c-resp': [['Original', '#9fe8ff'], ['Ice', '#7fd4f5'], ['Sky', '#a8dcff']],
  '--c-spo2': [['Original', '#e8e8e0'], ['Audit', '#f2f2ec'], ['Bone', '#d6d6cc']],
  '--c-dist': [['Original', '#ff8a5c'], ['Audit', '#ff6a3d'], ['Coral', '#ff7a52']],
  '--c-nap': [['Original', '#c6fe28'], ['Audit', '#ffd54a'], ['Lime soft', '#a8e04a']],
  '--c-debt': [['Original', '#e8705a'], ['Audit', '#c94f36'], ['Rust', '#d15c42']],
  '--c-load': [['Original', '#7a7a70'], ['Audit', '#4a4a44'], ['Gray', '#66665c']],
};
const TUNER_GROUPS = [
  ['Sleep stages', [['--st-deep', 'deep'], ['--st-core', 'core'], ['--st-rem', 'rem'], ['--st-awake', 'awake']]],
  ['Consistency', [['--tgt-bed', 'bedtime target'], ['--tgt-wake', 'wake target']]],
  ['In-bed', [['--inbed-pre', 'pre'], ['--inbed-post', 'post']]],
  ['Vitals', [['--c-hr', 'HR'], ['--c-hrv', 'HRV'], ['--c-resp', 'respiratory'], ['--c-spo2', 'SpO₂'], ['--c-dist', 'disturbances']]],
  ['Recovery', [['--c-nap', 'nap'], ['--c-debt', 'sleep debt'], ['--c-load', 'training load']]],
];

// --- small color-math helpers for the luminance-ramp mode ---
function rgbToHex(r, g, b) {
  const c = x => Math.round(clamp(x, 0, 255)).toString(16).padStart(2, '0');
  return `#${c(r)}${c(g)}${c(b)}`;
}
function hslToHex(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  let r = 0, g = 0, b = 0;
  if (h < 60) [r, g, b] = [c, x, 0]; else if (h < 120) [r, g, b] = [x, c, 0];
  else if (h < 180) [r, g, b] = [0, c, x]; else if (h < 240) [r, g, b] = [0, x, c];
  else if (h < 300) [r, g, b] = [x, 0, c]; else [r, g, b] = [c, 0, x];
  return rgbToHex((r + m) * 255, (g + m) * 255, (b + m) * 255);
}
// Three stage colors as an even luminance ramp of one hue: deep darkest → rem lightest.
function rampStages(hue, sat, spread) {
  const mid = 0.58, lift = spread / 2;
  return {
    '--st-deep': hslToHex(hue, sat, clamp(mid - lift, 0.05, 0.95)),
    '--st-core': hslToHex(hue, sat, clamp(mid, 0.05, 0.95)),
    '--st-rem': hslToHex(hue, sat, clamp(mid + lift, 0.05, 0.95)),
  };
}
// Resolve the actual applied hex per var (custom override wins, else default).
const resolveVar = (over, k) => (over[k] || TUNER_DEFAULTS[k]).toLowerCase();

export default function TunerPanel({ onClose }) {
  // `over` = per-role overrides (hex) that differ from the default; `ramp`/`mute`
  // are the two special modes. Everything hydrates from localStorage on mount.
  const [over, setOver] = useState({});
  const [ramp, setRamp] = useState({ on: false, hue: 82, sat: 0.62, spread: 0.5 });
  const [mute, setMute] = useState({ sat: 1, bri: 1 });
  const [copied, setCopied] = useState(false);
  const taRef = useRef(null);

  // Hydrate once (applyTunerState already ran on page mount; this syncs the UI).
  useEffect(() => {
    const st = applyTunerState();
    if (!st) return;
    if (st.over) setOver(st.over);
    if (st.ramp) setRamp(st.ramp);
    if (st.mute) setMute(st.mute);
  }, []);

  // Apply overrides to the document root whenever they change, and persist.
  useEffect(() => {
    const root = document.documentElement;
    for (const k of Object.keys(TUNER_DEFAULTS)) {
      if (over[k]) root.style.setProperty(k, over[k]); else root.style.removeProperty(k);
    }
    root.style.setProperty('--comp-mute', `saturate(${mute.sat}) brightness(${mute.bri})`);
    try { localStorage.setItem(TUNER_LS, JSON.stringify({ over, ramp, mute })); } catch { /* ignore */ }
  }, [over, ramp, mute]);

  // Ramp mode writes deep/core/rem into `over` whenever its controls move.
  useEffect(() => {
    if (!ramp.on) return;
    setOver(o => ({ ...o, ...rampStages(ramp.hue, ramp.sat, ramp.spread) }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ramp]);

  const setColor = (k, hex) => setOver(o => ({ ...o, [k]: hex.toLowerCase() }));
  const revert = k => setOver(o => { const n = { ...o }; delete n[k]; return n; });
  const resetAll = () => { setOver({}); setRamp(r => ({ ...r, on: false })); setMute({ sat: 1, bri: 1 }); };

  // Build the export text (resolved hexes → JS consts + :root block).
  const exportText = useMemo(() => {
    const resolved = {};
    for (const k of Object.keys(TUNER_DEFAULTS)) resolved[k] = resolveVar(over, k);
    const js = [
      '// Sleep palette constants (resolved hexes from the tuner):',
      `const STAGE = { deep: '${resolved['--st-deep']}', core: '${resolved['--st-core']}', rem: '${resolved['--st-rem']}', awake: '${resolved['--st-awake']}' };`,
      `const INBED_PRE = '${resolved['--inbed-pre']}';`,
      `const INBED_POST = '${resolved['--inbed-post']}';`,
      `const RESP = '${resolved['--c-resp']}';`,
      `const SPO2 = '${resolved['--c-spo2']}';`,
      `const DIST = '${resolved['--c-dist']}';`,
      `const HR = '${resolved['--c-hr']}';`,
      `const HRV = '${resolved['--c-hrv']}';`,
      `const NAP = '${resolved['--c-nap']}';`,
      `const DEBT = '${resolved['--c-debt']}';`,
      `const LOAD = '${resolved['--c-load']}';`,
      `const BED_TGT = '${resolved['--tgt-bed']}';`,
      `const WAKE_TGT = '${resolved['--tgt-wake']}';`,
    ].join('\n');
    const css = [':root {',
      ...Object.keys(TUNER_DEFAULTS).map(k => `  ${k}: ${resolved[k]};`),
      `  --comp-mute: saturate(${mute.sat}) brightness(${mute.bri});`,
      '}'].join('\n');
    const rampNote = ramp.on
      ? `\n/* luminance-ramp: hue ${Math.round(ramp.hue)}° · sat ${ramp.sat.toFixed(2)} · spread ${ramp.spread.toFixed(2)} */`
      : '';
    return `${js}\n\n${css}${rampNote}`;
  }, [over, ramp, mute]);

  const doCopy = () => {
    try { navigator.clipboard?.writeText(exportText); } catch { /* ignore */ }
    if (taRef.current) { taRef.current.focus(); taRef.current.select(); }
    setCopied(true); setTimeout(() => setCopied(false), 1400);
  };

  return (
    <div className={s.tunerPanel} role="dialog" aria-label="Color tuner">
      <div className={s.tunerHead}>
        <span className={s.tunerTitle}>Color Tuner</span>
        <span className={s.tunerHint}>dev · live preview</span>
        <button className={s.tunerX} onClick={onClose} aria-label="Close tuner">✕</button>
      </div>

      <div className={s.tunerScroll}>
        {/* Luminance-ramp mode for the three stages. */}
        <div className={s.tunerModeBox}>
          <div className={s.tunerModeRow}>
            <span className={s.tunerModeLabel}>Stages</span>
            <button className={`${s.tunerChip} ${!ramp.on ? s.tunerChipOn : ''}`} onClick={() => setRamp(r => ({ ...r, on: false }))}>Independent hues</button>
            <button className={`${s.tunerChip} ${ramp.on ? s.tunerChipOn : ''}`} onClick={() => setRamp(r => ({ ...r, on: true }))}>Luminance ramp</button>
          </div>
          {ramp.on && (
            <div className={s.tunerRampCtl}>
              <label className={s.tunerSlider}>hue {Math.round(ramp.hue)}°
                <input type="range" min="0" max="360" value={ramp.hue} onChange={e => setRamp(r => ({ ...r, hue: +e.target.value }))} />
              </label>
              <div className={s.tunerHuePresets}>
                {[['Lime', 82], ['Teal', 168], ['Blue', 212], ['Violet', 268]].map(([lab, h]) => (
                  <button key={lab} className={s.tunerMiniChip} onClick={() => setRamp(r => ({ ...r, hue: h }))}>{lab}</button>
                ))}
              </div>
              <label className={s.tunerSlider}>spread {ramp.spread.toFixed(2)}
                <input type="range" min="0.1" max="0.8" step="0.01" value={ramp.spread} onChange={e => setRamp(r => ({ ...r, spread: +e.target.value }))} />
              </label>
              <label className={s.tunerSlider}>saturation {ramp.sat.toFixed(2)}
                <input type="range" min="0.1" max="1" step="0.01" value={ramp.sat} onChange={e => setRamp(r => ({ ...r, sat: +e.target.value }))} />
              </label>
              <div className={s.tunerHint}>awake stays a separate accent (tunable below)</div>
            </div>
          )}
        </div>

        {/* Composition-mute — desaturates ONLY the Stage Composition chart. */}
        <div className={s.tunerModeBox}>
          <div className={s.tunerModeLabel}>Mute Stage Composition</div>
          <label className={s.tunerSlider}>saturation {mute.sat.toFixed(2)}
            <input type="range" min="0" max="1" step="0.01" value={mute.sat} onChange={e => setMute(m => ({ ...m, sat: +e.target.value }))} />
          </label>
          <label className={s.tunerSlider}>brightness {mute.bri.toFixed(2)}
            <input type="range" min="0.4" max="1" step="0.01" value={mute.bri} onChange={e => setMute(m => ({ ...m, bri: +e.target.value }))} />
          </label>
        </div>

        {TUNER_GROUPS.map(([group, rows]) => (
          <div key={group} className={s.tunerGroup}>
            <div className={s.tunerGroupLabel}>{group}</div>
            {rows.map(([k, name]) => {
              const cur = resolveVar(over, k);
              const dimmed = ramp.on && (k === '--st-deep' || k === '--st-core' || k === '--st-rem');
              return (
                <div key={k} className={s.tunerRow} style={dimmed ? { opacity: 0.5 } : undefined}>
                  <span className={s.tunerSwatch} style={{ background: `var(${k})` }} />
                  <span className={s.tunerName}>{name}</span>
                  <span className={s.tunerChips}>
                    {(TUNER_OPTS[k] || []).map(([lab, hex]) => (
                      <button key={lab} className={`${s.tunerChip} ${cur === hex.toLowerCase() ? s.tunerChipOn : ''}`}
                        onClick={() => setColor(k, hex)} title={hex}>{lab}</button>
                    ))}
                    <input className={s.tunerColor} type="color" value={cur} onChange={e => setColor(k, e.target.value)} aria-label={`${name} custom color`} />
                    <button className={s.tunerRevert} onClick={() => revert(k)} title="Revert to original">↺</button>
                  </span>
                </div>
              );
            })}
          </div>
        ))}

        <div className={s.tunerExport}>
          <div className={s.tunerGroupLabel}>Export</div>
          <textarea ref={taRef} className={s.tunerOut} readOnly value={exportText} spellCheck={false} />
        </div>
      </div>

      <div className={s.tunerFoot}>
        <button className={s.tunerCopy} onClick={doCopy}>{copied ? 'Copied ✓' : 'Copy palette'}</button>
        <button className={s.tunerReset} onClick={resetAll}>Reset all</button>
      </div>
    </div>
  );
}
