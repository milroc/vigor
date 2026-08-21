import { useState, useEffect, useRef } from 'react';
import { RANGES, UNITS_CAL, UNITS_ROLL, clamp, fmtDay } from './helpers.js';
import s from '../Sleep.module.css';

// Info affordance by a title: hover the "i" for a description tooltip. When
// forceOpen is set (first-load NUX) it stays open with a dismiss button.
export function InfoTip({ children, wide, forceOpen, onDismiss }) {
  const [hov, setHov] = useState(false);
  const open = hov || forceOpen;
  return (
    <span className={s.info} onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}>
      <span className={s.infoIcon}>i</span>
      {open && (
        <span className={`${s.infoPop} ${wide ? s.infoPopWide : ''}`}>
          {children}
          {onDismiss && <button className={s.nuxBtn} onClick={onDismiss}>Got it</button>}
        </span>
      )}
    </span>
  );
}

// ---- Date stepper: clickable ‹ › arrows around a text readout of the current
// date (or window range). Arrows/keys share the same onPrev/onNext handlers;
// canPrev/canNext grey out and disable a side at the data/window boundary. `sub`
// is optional trailing text (e.g. "· no data"). The modal variant passes `tip`
// and shows a hover tooltip explaining the ← → arrow keys. The header variant
// passes onHoverOpen/onHoverClose instead: hovering the WHOLE component opens the
// range picker (which folds the arrow-key hint inline), so it suppresses the
// tooltip. ----
export function DateStepper({ label, sub, tip, onPrev, onNext, onLabel, labelRef, canPrev = true, canNext = true, onHoverOpen, onHoverClose }) {
  const [hov, setHov] = useState(false);
  return (
    <span className={s.stepper}
      onMouseEnter={() => { setHov(true); onHoverOpen?.(); }}
      onMouseLeave={() => { setHov(false); onHoverClose?.(); }}
      onPointerMove={e => e.stopPropagation()}>
      <button className={s.stepArrow} onClick={onPrev} disabled={!canPrev} aria-label="previous">‹</button>
      {onLabel
        ? <button ref={labelRef} className={s.stepDateBtn} onClick={onLabel}>{label}{sub}</button>
        : <span className={s.stepDate}>{label}{sub}</span>}
      <button className={s.stepArrow} onClick={onNext} disabled={!canNext} aria-label="next">›</button>
      {hov && tip && !onHoverOpen && <span className={s.infoPop}>{tip}</span>}
    </span>
  );
}

// ---- Month grid for the range calendar: one calendar month, days clamped to
// [min,max]. Click a start then an end; the in-progress range previews on hover
// and the committed range highlights. Same day twice → caller opens that night. ----
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
export const DOW = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
export function MonthGrid({ year, month, min, max, sel, preview, onPick, onHover }) {
  const first = new Date(year, month, 1);
  const lead = (first.getDay() + 6) % 7; // Mon=0
  const days = new Date(year, month + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let d = 1; d <= days; d++) cells.push(d);
  const [selA, selB] = sel; // committed range (YYYY-MM-DD | null)
  const [prA, prB] = preview; // preview range while choosing the second day
  return (
    <div className={s.calMonth}>
      <div className={s.calCaption}>{MONTHS[month]} {year}</div>
      <div className={s.calDow}>{DOW.map((d, i) => <span key={i}>{d}</span>)}</div>
      <div className={s.calGrid}>
        {cells.map((d, i) => {
          if (d == null) return <span key={i} className={s.calPad} />;
          const day = fmtDay(new Date(year, month, d));
          const dis = day < min || day > max;
          const inSel = selA && selB && day >= selA && day <= selB;
          const inPrev = prA && prB && day >= prA && day <= prB;
          const isEnd = day === selA || day === selB;
          const cls = [s.calDay, dis && s.calDayDis, (inSel || inPrev) && s.calDayIn, isEnd && s.calDayEnd].filter(Boolean).join(' ');
          return (
            <button key={i} className={cls} disabled={dis}
              onClick={() => onPick(day)} onMouseEnter={() => onHover(day)}>{d}</button>
          );
        })}
      </div>
    </div>
  );
}

// ---- Range calendar popover: a self-contained date picker anchored to the ‹ date ›
// label. Two-month grid (prev/next arrows) where clicking a start then an end sets
// the window (same day twice → open that night). Folds in the preset list (rolling
// windows + calendar-unit snaps) and embeds the brush, so the picker is the one
// place to steer the date range. onApply keeps applyPick's start===end semantics. ----
export function RangePicker({ min, max, init, onApply, activeRange, activeGran, onGran, onRange, brush, hint, onClose, anchorRef, onMouseEnter, onMouseLeave }) {
  const [start, setStart] = useState(null);
  const [end, setEnd] = useState(null);
  const [hoverDay, setHoverDay] = useState(null);
  const [view, setView] = useState(() => { const d = new Date(init[0] + 'T00:00:00'); return { y: d.getFullYear(), m: d.getMonth() }; });
  // Position:fixed popover anchored to the trigger button. Measure its rect on
  // open and on resize/scroll; clamp left so the two-month popover never runs off
  // the right edge of the viewport. Escapes .pinned/.main overflow:hidden.
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const place = () => {
      const btn = anchorRef && anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const w = popRef.current ? popRef.current.offsetWidth : 0;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top: r.bottom + 9, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  const pick = day => {
    if (start == null || end != null) { setStart(day); setEnd(null); return; }
    const a = start < day ? start : day, b = start < day ? day : start;
    onApply(a, b); // start===end → modal; else window
  };
  // Committed selection while mid-pick is just the anchor; otherwise show init range.
  const sel = start != null && end == null ? [start, start] : init;
  const preview = start != null && end == null && hoverDay
    ? [start < hoverDay ? start : hoverDay, start < hoverDay ? hoverDay : start] : [null, null];
  const canPrev = fmtDay(new Date(view.y, view.m, 1)) > min;
  const canNext = fmtDay(new Date(view.y, view.m + 1, 1)) <= max;
  const step = dir => setView(v => { const d = new Date(v.y, v.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  const next = { y: view.m === 11 ? view.y + 1 : view.y, m: (view.m + 1) % 12 };
  return (
    <div ref={popRef} className={s.pickPop} onMouseEnter={onMouseEnter} onMouseLeave={onMouseLeave}
      style={{ top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className={s.pickCols}>
        <div className={s.pickMain}>
          <div className={s.pickQuick}>
            <div className={s.units}>
              {UNITS_CAL.map(([k, g]) => (
                <button key={k} className={`${s.unit} ${activeGran && activeGran.key === k ? s.unitActive : ''}`} onClick={() => onGran({ ...g, key: k })}>{k}</button>
              ))}
              <span className={s.unitSep} />
              {UNITS_ROLL.map(([k, g]) => (
                <button key={k} className={`${s.unit} ${activeGran && activeGran.key === k ? s.unitActive : ''}`} onClick={() => onGran({ ...g, key: k })}>{k}</button>
              ))}
            </div>
            <div className={s.chips}>
              {RANGES.filter(([k]) => k === '90d' || k === 'All').map(([k, d]) => (
                <button key={k} className={`${s.chip} ${activeRange === k ? s.chipActive : ''}`} onClick={() => onRange(k, d)}>{k}</button>
              ))}
            </div>
          </div>
          <div className={s.calNav}>
            <button className={s.calArrow} onClick={() => step(-1)} disabled={!canPrev} aria-label="previous month">‹</button>
            <button className={s.calArrow} onClick={() => step(1)} disabled={!canNext} aria-label="next month">›</button>
          </div>
          <div className={s.calMonths}>
            <MonthGrid year={view.y} month={view.m} min={min} max={max} sel={sel} preview={preview} onPick={pick} onHover={setHoverDay} />
            <MonthGrid year={next.y} month={next.m} min={min} max={max} sel={sel} preview={preview} onPick={pick} onHover={setHoverDay} />
          </div>
          <div className={s.pickHint}>Click a start then an end day · pick the same day twice to open that night.</div>
          {brush}
          {hint && <div className={s.pickHint}>{hint}</div>}
        </div>
      </div>
    </div>
  );
}

// ---- Single-date picker popover: a thin single-select wrapper around MonthGrid,
// styled with the same .pickPop shell + prev/next month arrows as RangePicker, but
// with no range/preview — the currently-open night is highlighted via sel=[day,day]
// and preview=[null,null], and clicking any in-range day navigates the modal there.
// Uses the same position:fixed + anchorRef measuring/clamping so it escapes the
// modal's overflow and stays anchored on scroll/resize. Closes on outside-click. ----
export function NightDatePicker({ min, max, day, onPick, onClose, anchorRef }) {
  const [view, setView] = useState(() => { const d = new Date(day + 'T00:00:00'); return { y: d.getFullYear(), m: d.getMonth() }; });
  const popRef = useRef(null);
  const [pos, setPos] = useState(null);
  useEffect(() => {
    const place = () => {
      const btn = anchorRef && anchorRef.current;
      if (!btn) return;
      const r = btn.getBoundingClientRect();
      const w = popRef.current ? popRef.current.offsetWidth : 0;
      const left = Math.max(8, Math.min(r.left, window.innerWidth - w - 8));
      setPos({ top: r.bottom + 9, left });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [anchorRef]);
  // Outside-click closes (the anchor button toggles separately, so ignore it).
  useEffect(() => {
    const onDown = e => {
      if (popRef.current && popRef.current.contains(e.target)) return;
      if (anchorRef && anchorRef.current && anchorRef.current.contains(e.target)) return;
      onClose();
    };
    window.addEventListener('mousedown', onDown, true);
    return () => window.removeEventListener('mousedown', onDown, true);
  }, [onClose, anchorRef]);
  const canPrev = fmtDay(new Date(view.y, view.m, 1)) > min;
  const canNext = fmtDay(new Date(view.y, view.m + 1, 1)) <= max;
  const step = dir => setView(v => { const d = new Date(v.y, v.m + dir, 1); return { y: d.getFullYear(), m: d.getMonth() }; });
  return (
    <div ref={popRef} className={s.pickPop}
      style={{ top: pos ? pos.top : 0, left: pos ? pos.left : 0, visibility: pos ? 'visible' : 'hidden' }}>
      <div className={s.pickMain}>
        <div className={s.calNav}>
          <button className={s.calArrow} onClick={() => step(-1)} disabled={!canPrev} aria-label="previous month">‹</button>
          <button className={s.calArrow} onClick={() => step(1)} disabled={!canNext} aria-label="next month">›</button>
        </div>
        <MonthGrid year={view.y} month={view.m} min={min} max={max} sel={[day, day]} preview={[null, null]} onPick={onPick} onHover={() => {}} />
        <div className={s.pickHint}>Pick a night to view its sleep.</div>
      </div>
    </div>
  );
}

