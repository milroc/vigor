import { useEffect, useLayoutEffect, useRef } from 'react';
import { STAGE } from './palette.js';
import { clock, hm, srcLabel } from './helpers.js';
import { getHover, subscribeHover, useHoverTarget } from './hoverStore.js';
import s from '../Sleep.module.css';

// Keep the day tooltip fully on-screen: measure it and clamp against every
// viewport edge — flip left/above when it would overflow right/bottom, clamp to
// an 8px inset otherwise. The measured size is cached and only refreshed after a
// render changes the content, so simply moving the cursor within one night's
// column never forces a layout.
const M = 8, GAP = 14;
function place(el, h, size) {
  if (!el || !h || h.cx == null) return;
  const { width: w, height: ht } = size;
  const vw = window.innerWidth, vh = window.innerHeight;
  let left = h.cx + GAP;
  if (left + w > vw - M) left = h.cx - w - GAP; // flip to the left of cursor
  left = Math.max(M, Math.min(left, vw - w - M));
  let top = h.cy + GAP;
  if (top + ht > vh - M) top = Math.min(h.cy - ht - GAP, vh - ht - M); // flip above / clamp
  top = Math.max(M, top);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

// The tooltip subscribes to hover itself rather than being rendered by Sleep, so
// a pointer move re-renders this one small subtree instead of the whole page
// (and every chart) — see hoverStore.js.
export function HoverTooltip({ nights, byDay, napByDay, followRhrByDay, daylightByDay, targets }) {
  const ref = useRef(null);
  const size = useRef({ width: 0, height: 0 });
  const { i, section } = useHoverTarget();

  // Cursor-only movement: reposition from the cached size, no React render.
  useEffect(() => subscribeHover(h => place(ref.current, h, size.current)), []);
  // Content changed: re-measure, then reposition.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    size.current = { width: r.width, height: r.height };
    place(el, getHover(), size.current);
  });

  const d = i == null ? null : nights[i];
  if (!d) return null;

  if (d.blank) {
    return (
      <div ref={ref} className={`${s.tip} ${s.tipBlank}`}>
        <b className={s.tipHead}>{new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })}</b>
        <div className={s.tipRow}><span style={{ color: 'var(--dim)' }}>no data</span></div>
      </div>
    );
  }

  const naps = napByDay[d.day] || [];
  const hrB = byDay.hr[d.day], hrvB = byDay.hrv[d.day], tib = (d.tibBefore || 0) + (d.tibAfter || 0);
  // Same derivations the modal's `extra` uses: 3-night rolling debt under 7h,
  // and the following night's overnight HRV median.
  let sum = 0, cnt = 0;
  for (const j of [i - 2, i - 1, i]) { const a = nights[j]?.asleepEff; if (a != null) { sum += Math.max(0, 420 - a); cnt++; } }
  const debt = cnt ? sum / cnt : 0;
  const nextHrv = byDay.hrv[nights[i + 1]?.day]?.med;
  const followRhr = followRhrByDay[d.day];
  const daylight = daylightByDay[d.day];
  const load = byDay.load[d.day];
  const bedD = d.bed - targets.bedMin, wakeD = d.wake - targets.wakeMin;
  const sgn = m => (m > 0 ? '+' : '') + Math.round(m);
  const sec = section;
  // Emphasis, not hiding: the group matching the hovered chart gets a lighter
  // bounding box; the rest stay fully readable. The "When You Slept" skyline
  // (section 'timing') encodes BOTH stage colors and clock timing, so it lights
  // both the stages and timing groups.
  const stagesHot = sec === 'stages' || sec === 'timing';
  const timingHot = sec === 'timing' || sec === 'consistency';
  const grp = id => `${s.tipGroup}${sec === id ? ' ' + s.tipGroupHot : ''}`;
  const grpIf = hot => `${s.tipGroup}${hot ? ' ' + s.tipGroupHot : ''}`;
  // Per-stage spark swimlane: a tiny inline lane spanning bed→wake with this
  // stage's segments drawn as rects at their a→b positions.
  const span = Math.max(d.wake - d.bed, 1);
  const spark = st => {
    const segs = (d.segs || []).filter(g => g.st === st);
    const W = 96, H = 9;
    return (
      <svg className={s.tipStageSpark} width={W} height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none">
        <rect x={0} y={0} width={W} height={H} fill="var(--panel)" opacity={0.5} />
        {segs.map((g, j) => {
          const x = ((g.a - d.bed) / span) * W;
          const w = Math.max(((g.b - g.a) / span) * W, 0.6);
          return <rect key={j} x={x} y={0} width={w} height={H} fill={STAGE[st]} opacity={0.9} />;
        })}
      </svg>
    );
  };
  const stageRow = st => (
    <div className={s.tipStageRow}>
      <span className={s.tipStageName}><span className={s.tipDot} style={{ background: STAGE[st] }} />{st}</span>
      {spark(st)}
      <span className={s.tipStageTime}>{hm(d[st])}</span>
    </div>
  );
  const timingGroup = (
    <div className={grpIf(timingHot)}>
      <div className={s.tipGroupLabel}>timing</div>
      <div className={s.tipRow}><span>bed</span><span>{clock(d.bed)}</span></div>
      <div className={s.tipRow}><span>wake</span><span>{clock(d.wake)}</span></div>
      {tib > 0 && <div className={s.tipRow}><span>in bed before/after</span><span>{d.tibBefore}m / {d.tibAfter}m</span></div>}
      <div className={s.tipRow}><span>bed vs target</span><span>{sgn(bedD)}m</span></div>
      <div className={s.tipRow}><span>wake vs target</span><span>{sgn(wakeD)}m</span></div>
      {daylight != null && <div className={s.tipRow}><span>daylight (prev day)</span><span>{hm(daylight)}</span></div>}
    </div>
  );
  const respGroup = (d.resp || d.spo2 || d.dist != null) && (
    <div className={grp('respiration')}>
      <div className={s.tipGroupLabel}>respiration</div>
      {d.resp && <div className={s.tipRow}><span>resp rate</span><span>{d.resp.toFixed(1)} br/min</span></div>}
      <div className={s.tipRow}><span>SpO₂</span><span>{d.spo2 ? `${d.spo2.toFixed(0)}%` : '—'}</span></div>
      {d.dist != null && <div className={s.tipRow}><span>breathing dist.</span><span>{d.dist.toFixed(1)}</span></div>}
      <div className={s.tipRow}><span>wakes (brief/full)</span><span>{d.briefWakes} / {d.wakeCount}</span></div>
      {d.fullWakeMin > 0 && <div className={s.tipRow}><span>full wake mins</span><span>{hm(d.fullWakeMin)}</span></div>}
    </div>
  );
  const heartGroup = (hrB || hrvB) && (
    <div className={grp('heart')}>
      <div className={s.tipGroupLabel}>heart rate</div>
      {hrB && <div className={s.tipRow}><span>sleeping HR</span><span>{hrB.med} · {hrB.lo}–{hrB.hi}</span></div>}
      {hrvB && <div className={s.tipRow}><span>overnight HRV</span><span>{hrvB.med} ms</span></div>}
    </div>
  );
  const recoveryGroup = (naps.length > 0 || debt > 0.5 || nextHrv != null || followRhr != null || load != null) && (
    <div className={grp('recovery')}>
      <div className={s.tipGroupLabel}>recovery</div>
      {naps.length > 0 && <div className={s.tipRow}><span>{naps.length > 1 ? 'naps' : 'nap'}</span><span>{naps.map(p => hm(p.asleep)).join(', ')}</span></div>}
      {debt > 0.5 && <div className={s.tipRow}><span>sleep debt</span><span>{hm(debt)}</span></div>}
      {nextHrv != null && <div className={s.tipRow}><span>next-day HRV</span><span>{nextHrv} ms</span></div>}
      {followRhr != null && <div className={s.tipRow}><span>next-day RHR</span><span>{followRhr} bpm</span></div>}
      {load != null && <div className={s.tipRow}><span>training load</span><span>{Math.round(load).toLocaleString()} kcal</span></div>}
    </div>
  );
  return (
    <div ref={ref} className={s.tip}>
      <div className={s.tipHeadRow}>
        <b className={s.tipHead}>{new Date(d.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'short', month: 'short', day: 'numeric', year: '2-digit' })}</b>
        <span className={s.tipSourceTop}>{srcLabel(d.source)}</span>
      </div>
      <div className={s.tipHero}>
        <span><span className={s.tipHeroVal}>{hm(d.asleepEff)}</span><span className={s.tipHeroLbl}>asleep</span></span>
        <span><span className={s.tipHeroVal}>{d.eff == null ? '—' : `${d.eff}%`}</span><span className={s.tipHeroLbl}>efficiency</span></span>
      </div>

      <div className={`${grpIf(stagesHot)} ${s.tipStages}`}>
        <div className={s.tipGroupLabel}>stages</div>
        {stageRow('deep')}
        {stageRow('core')}
        {stageRow('rem')}
        {stageRow('awake')}
      </div>

      <div className={s.tipGrid}>
        <div className={s.tipCol}>
          {timingGroup}
          {heartGroup}
        </div>
        <div className={s.tipCol}>
          {respGroup}
          {recoveryGroup}
        </div>
      </div>
    </div>
  );
}
