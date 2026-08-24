import { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { getHealthSleepNight } from '../../api.js';
import { HR, HRV, INBED_POST, INBED_PRE, RESP, SPO2, STAGE } from './palette.js';
import { PAD_R, clamp, clock, hm, labelWidth, srcLabel, useMeasure } from './helpers.js';
import { NightDatePicker } from './pickers.jsx';
import { Stat } from './charts.jsx';
import shared from '../../styles/shared.module.css';
import s from '../Sleep.module.css';

// ---- Hypnogram: one night's stage transitions. x = clock time (bed → wake),
// y = stage lanes (Awake / REM / Core / Deep), colored blocks per segment with
// dim connectors at each transition so the stepping between stages reads. ----
export const HYP_LANES = [['awake', 'Awake'], ['rem', 'REM'], ['core', 'Core'], ['deep', 'Deep']];
export const STAGE_LABEL = { awake: 'Awake', rem: 'REM', core: 'Core', deep: 'Deep' };
export function NightDetail({ night, detail }) {
  const [ref, w] = useMeasure();
  const [hoverT, setHoverT] = useState(null);
  const [tip, setTip] = useState(null);
  const mPad = Math.ceil(Math.max(
    ...HYP_LANES.map(([, lbl]) => labelWidth(lbl, 11)),
    labelWidth('888', 9),
  )) + 8;
  const PAD = { l: mPad, r: PAD_R };
  const { segs, bed, wake } = night;
  // Widen the clock axis to the in-bed window (bed - tibBefore .. wake + tibAfter)
  // when present, so pre-sleep / post-wake in-bed periods show. Falls back to
  // bed→wake for nights without time-in-bed data.
  const tb = night.tibBefore || 0, ta = night.tibAfter || 0;
  const x0 = bed - tb, x1 = wake + ta;
  const plotW = Math.max(w - PAD.l - PAD.r, 1);
  const span = Math.max(x1 - x0, 1);
  const x = m => PAD.l + (clamp(m, x0, x1) - x0) / span * plotW;
  const ticks = [];
  for (let m = Math.ceil(x0 / 60) * 60; m <= x1; m += 60) ticks.push(m);

  // Shared clock-time cursor across the hypnogram + every vital curve.
  const onMove = e => {
    const rect = e.currentTarget.getBoundingClientRect();
    const vbX = (e.clientX - rect.left) / rect.width * w;
    setHoverT(clamp(x0 + (vbX - PAD.l) / plotW * span, x0, x1));
    setTip({ x: e.clientX, y: e.clientY });
  };
  const onLeave = () => { setHoverT(null); setTip(null); };
  const guide = h => hoverT != null && <line x1={x(hoverT)} x2={x(hoverT)} y1={0} y2={h} stroke="#fff" opacity={0.32} pointerEvents="none" />;
  const winPts = samples => (samples || []).filter(p => p.t >= bed - 3 && p.t <= wake + 3);
  // Snap to the nearest reading in time (1-D Voronoi): the hovered point is
  // whichever sample owns the cursor's x, no distance cutoff. Returns the point
  // itself so the marker lands ON the line/dot, not at the cursor's x.
  const near = samples => {
    if (hoverT == null) return null;
    const pts = winPts(samples);
    if (!pts.length) return null;
    let best = null, bd = Infinity;
    for (const p of pts) { const d = Math.abs(p.t - hoverT); if (d < bd) { bd = d; best = p; } }
    return best;
  };
  const seg = hoverT == null ? null : segs.find(sg => hoverT >= sg.a && hoverT <= sg.b);

  const HYP = 176, hp = { t: 12, b: 8 };
  const laneH = (HYP - hp.t - hp.b) / HYP_LANES.length;
  const laneY = st => hp.t + HYP_LANES.findIndex(l => l[0] === st) * laneH + laneH / 2;
  const barH = Math.min(laneH * 0.5, 22);

  // One overnight vital as a small line chart sharing the clock axis.
  const seriesChart = (samples, color, label, unit, H, round = 0) => {
    const pts = (samples || []).filter(p => p.t >= bed - 3 && p.t <= wake + 3);
    if (pts.length < 2) return null;
    const vs = pts.map(p => p.v);
    const min = Math.min(...vs), max = Math.max(...vs), avg = vs.reduce((a, b) => a + b, 0) / vs.length;
    const PADt = 15, PADb = 5, plotH = H - PADt - PADb;
    const padv = (max - min) * 0.2 || 1, lo = min - padv, hi = max + padv;
    const y = v => PADt + plotH - (v - lo) / (hi - lo) * plotH;
    const fmt = v => round ? v.toFixed(round) : Math.round(v);
    // Sparse series (few samples spread over the night) read better as a scatter
    // than a line that fabricates connections across long gaps.
    const scatter = pts.length < 12 || span / pts.length > 30;
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('');
    const cur = near(samples);
    return (
      <svg key={label} className={s.svg} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none">
        <text x={0} y={10} fontSize="10" fill="var(--dim)">{label} · <tspan fill={color}>{fmt(min)}–{fmt(max)}</tspan> {unit}{scatter ? ` · ${pts.length} readings` : ''}</text>
        <line x1={PAD.l} x2={w - PAD.r} y1={y(avg)} y2={y(avg)} stroke="var(--line)" strokeDasharray="2 3" />
        <text x={PAD.l - 6} y={y(avg) + 3} fontSize="9" fill="var(--dim)" textAnchor="end">{fmt(avg)}</text>
        {scatter
          ? pts.map((p, i) => <circle key={i} cx={x(p.t)} cy={y(p.v)} r={2.4} fill={color} opacity={0.9} />)
          : <path d={d} fill="none" stroke={color} strokeWidth={1.6} />}
        {guide(H)}
        {cur && <circle cx={x(cur.t)} cy={y(cur.v)} r={scatter ? 4 : 3.4} fill={color} stroke="#fff" strokeWidth={1} pointerEvents="none" />}
      </svg>
    );
  };

  // Loading placeholder for one vital: mirrors seriesChart's layout (same
  // viewBox, label row, dashed mean line) but draws a shimmering ghost curve
  // over the clock axis so the rows read as charts materializing, not a spinner.
  const skelChart = (color, label, unit, H, seed) => {
    const PADt = 15, PADb = 5, plotH = H - PADt - PADb;
    const mid = PADt + plotH / 2;
    // A deterministic wiggly path across the plot, so each row looks distinct.
    const N = 26;
    const d = Array.from({ length: N }, (_, i) => {
      const t = i / (N - 1);
      const mx = x(bed + t * (wake - bed));
      const wob = Math.sin(t * 7 + seed) * 0.28 + Math.sin(t * 17 + seed * 2) * 0.12;
      const my = mid - wob * plotH * 0.5;
      return `${i ? 'L' : 'M'}${mx.toFixed(1)} ${my.toFixed(1)}`;
    }).join('');
    const gid = `skelg-${seed}`;
    return (
      <svg key={label} className={`${s.svg} ${s.skelSvg}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor={color} stopOpacity="0.15" />
            <stop offset="50%" stopColor={color} stopOpacity="0.7" />
            <stop offset="100%" stopColor={color} stopOpacity="0.15" />
            <animate attributeName="x1" values="-1;1" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="x2" values="0;2" dur="1.6s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        <text x={0} y={10} fontSize="10" fill="var(--dim)" opacity={0.6}>{label} · <tspan fill={color}>loading</tspan> {unit}</text>
        <line x1={PAD.l} x2={w - PAD.r} y1={mid} y2={mid} stroke="var(--line)" strokeDasharray="2 3" />
        <path className={s.skelTrack} d={d} fill="none" stroke="var(--line)" strokeWidth={1.4} />
        <path d={d} fill="none" stroke={`url(#${gid})`} strokeWidth={1.8} strokeLinecap="round" />
      </svg>
    );
  };

  const rows = [
    seg && ['stage', STAGE_LABEL[seg.st], STAGE[seg.st]],
    ['hr', near(detail?.hr)?.v, HR, ' bpm'],
    ['hrv', near(detail?.hrv)?.v, HRV, ' ms'],
    ['resp', near(detail?.resp)?.v, RESP, ' br/min', 1],
    ['spo₂', near(detail?.spo2)?.v, SPO2, '%'],
  ];

  return (
    <div ref={ref} onPointerMove={w > 0 ? onMove : undefined} onPointerLeave={onLeave} style={{ cursor: 'crosshair' }}>
      {w > 0 && (
        <>
          <svg className={s.svg} width="100%" height={HYP} viewBox={`0 0 ${w} ${HYP}`} preserveAspectRatio="none">
            {/* In-bed periods (pre-sleep / post-wake) as faint full-height shading. */}
            {tb > 0 && <rect className={s.inbedBand} x={x(x0)} y={hp.t} width={Math.max(x(bed) - x(x0), 0)} height={HYP - hp.t - hp.b} fill={INBED_PRE} />}
            {ta > 0 && <rect className={s.inbedBand} x={x(wake)} y={hp.t} width={Math.max(x(x1) - x(wake), 0)} height={HYP - hp.t - hp.b} fill={INBED_POST} />}
            {(tb > 0 || ta > 0) && <text x={x(x0) + 3} y={hp.t + 9} fontSize="9" fill="var(--dim)">In bed</text>}
            {HYP_LANES.map(([st, lbl]) => (
              <g key={st}>
                <line x1={PAD.l} x2={w - PAD.r} y1={laneY(st)} y2={laneY(st)} stroke="var(--line)" opacity={0.4} />
                <text x={PAD.l - 6} y={laneY(st) + 3} fill={STAGE[st]} fontSize="11" textAnchor="end">{lbl}</text>
              </g>
            ))}
            {segs.slice(1).map((seg, i) => (
              <line key={`c${i}`} x1={x(seg.a)} x2={x(seg.a)} y1={laneY(segs[i].st)} y2={laneY(seg.st)}
                stroke="var(--dim)" strokeWidth={1.4} opacity={0.5} />
            ))}
            {segs.map((sg, i) => (
              <rect key={i} x={x(sg.a)} y={laneY(sg.st) - barH / 2} width={Math.max(x(sg.b) - x(sg.a), 1.2)} height={barH}
                rx={3} fill={STAGE[sg.st]} opacity={seg ? (sg === seg ? 1 : 0.28) : 0.92} />
            ))}
            {seg && (
              <rect x={x(seg.a)} y={laneY(seg.st) - barH / 2} width={Math.max(x(seg.b) - x(seg.a), 1.2)} height={barH}
                rx={3} fill="none" stroke="#fff" strokeWidth={1.4} pointerEvents="none" />
            )}
          </svg>
          {detail ? (
            <>
              {seriesChart(detail.hr, HR, 'Heart rate', 'bpm', 80)}
              {seriesChart(detail.hrv, HRV, 'HRV (SDNN)', 'ms', 60)}
              {seriesChart(detail.resp, RESP, 'Respiratory rate', 'br/min', 60, 1)}
              {seriesChart(detail.spo2, SPO2, 'Blood oxygen', '%', 56)}
            </>
          ) : (
            <div className={s.vitalsSkel} aria-busy="true" aria-label="loading overnight vitals">
              {skelChart(HR, 'Heart rate', 'bpm', 80, 0)}
              {skelChart(HRV, 'HRV (SDNN)', 'ms', 60, 1.7)}
              {skelChart(RESP, 'Respiratory rate', 'br/min', 60, 3.4)}
              {skelChart(SPO2, 'Blood oxygen', '%', 56, 5.1)}
            </div>
          )}
          <svg className={s.svg} width="100%" height={18} viewBox={`0 0 ${w} 18`} preserveAspectRatio="none">
            {ticks.map(m => <text key={m} x={x(m)} y={12} fill="var(--dim)" fontSize="10" textAnchor="middle">{clock(m)}</text>)}
            {guide(18)}
          </svg>
          {tip && hoverT != null && (
            <div className={s.tip} style={{ left: Math.min(tip.x + 14, window.innerWidth - 200), top: tip.y + 14 }}>
              <b>{clock(Math.round(hoverT))}</b>
              {rows.filter(r => r && r[1] != null).map(([lbl, val, col, unit = '', round]) => (
                <div key={lbl} className={s.tipRow}>
                  <span>{lbl}</span>
                  <span style={{ color: col }}>{typeof val === 'number' ? (round ? val.toFixed(round) : Math.round(val)) : val}{typeof val === 'number' ? unit : ''}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

export function NightModal({ night, naps, extra = {}, onClose, onStep, onPickDate, min, max }) {
  const [detail, setDetail] = useState(null);
  const [picking, setPicking] = useState(false); // single-date picker open
  const changeRef = useRef(null); // anchor for the fixed-position picker
  useEffect(() => {
    let ok = true, tries = 0, timer;
    setDetail(null);
    // Debounced fetch with a couple of retries so a transient error (e.g. a brief
    // DuckDB lock) doesn't leave the vitals permanently blank for a night that has data.
    const load = () => getHealthSleepNight(night.day)
      .then(d => { if (ok) setDetail(d); })
      .catch(() => { if (!ok) return; if (tries++ < 2) { timer = setTimeout(load, 400); } else { setDetail({ hr: [], hrv: [], resp: [], spo2: [] }); } });
    timer = setTimeout(load, 250);
    return () => { ok = false; clearTimeout(timer); };
  }, [night.day]);

  useEffect(() => {
    const onKey = e => {
      // Escape closes the picker first if it's open; otherwise closes the modal.
      if (e.key === 'Escape') { if (picking) { setPicking(false); } else { onClose(); } return; }
      if (e.key === 'ArrowRight') { e.preventDefault(); onStep?.(1); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); onStep?.(-1); }
    };
    window.addEventListener('keydown', onKey);
    const sb = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.overflow = 'hidden';
    if (sb > 0) document.body.style.paddingRight = `${sb}px`;
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
      document.body.style.paddingRight = '';
    };
  }, [onClose, onStep, picking]);

  const title = new Date(night.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  // position:fixed overlay — portaled for the same reason as the day tooltip:
  // it must not depend on no ancestor ever becoming a containing block.
  return createPortal((
    <div className={s.modalOverlay} onClick={onClose}>
      <section className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalHead}>
          <div>
            {/* The whole date title is the affordance: hover (or keyboard-focus)
                reveals an inline edit icon + label that opens the single-date picker. */}
            <button ref={changeRef} className={s.modalTitleRow}
              aria-expanded={picking} aria-label="Change the date"
              onClick={() => setPicking(p => !p)}>
              <span className={s.modalTitle}>{title}</span>
              <span className={s.changeDate} aria-hidden="true">
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none"
                  stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
                </svg>
                edit
              </span>
            </button>
            <div className={s.modalSub}>{clock(night.bed)} → {clock(night.wake)} · {hm(night.asleepEff)} asleep · {night.eff == null ? '—' : `${night.eff}%`} efficiency · {srcLabel(night.source)}</div>
          </div>
          <div className={s.modalHeadRight}>
            <button className={shared.btn} onClick={onClose}>Close</button>
          </div>
        </div>
        {picking && (
          <NightDatePicker min={min} max={max} day={night.day} anchorRef={changeRef}
            onClose={() => setPicking(false)}
            onPick={day => { setPicking(false); onPickDate?.(day); }} />
        )}
        <div className={s.statTiers}>
          <div className={`${s.statTier} ${s.statHero}`}>
            <Stat value={hm(night.asleepEff)} label="asleep" />
            <Stat value={night.eff == null ? '—' : night.eff} unit="%" label="efficiency" />
            <Stat value={hm(night.deep)} label="deep" />
          </div>
          <div className={s.statTier}>
            <Stat value={hm(night.rem)} label="rem" />
            <Stat value={hm(night.core)} label="core" />
            <Stat value={hm(night.awake)} label="awake" />
            <Stat value={`${night.wakeCount} · ${night.briefWakes}`} label="full · brief wakes" />
            {(night.tibBefore + night.tibAfter) > 0 && <Stat value={hm(night.tibBefore + night.tibAfter)} label="extra in bed" />}
            {naps.length > 0 && <Stat value={naps.map(p => hm(p.asleep)).join(', ')} label={naps.length > 1 ? 'naps' : 'nap'} />}
          </div>
          <div className={`${s.statTier} ${s.statSm}`}>
            <Stat value={extra.hr ? extra.hr.med : '—'} unit="bpm" label="sleeping HR" />
            {extra.hrv && <Stat value={extra.hrv.med} unit="ms" label="HRV" />}
            <Stat value={night.resp ? night.resp.toFixed(1) : '—'} unit="br/min" label="resp" />
            <Stat value={night.spo2 ? `${night.spo2.toFixed(0)}` : '—'} unit="%" label="spo₂" />
            {night.dist != null && <Stat value={night.dist.toFixed(1)} label="breathing dist." />}
            {extra.debt > 0.5 && <Stat value={hm(extra.debt)} label="sleep debt" />}
            {extra.nextHrv != null && <Stat value={extra.nextHrv} unit="ms" label="next-day HRV" />}
            {extra.load != null && <Stat value={Math.round(extra.load).toLocaleString()} unit="kcal" label="training load" />}
            {extra.bedStd != null && <Stat value={`${Math.round(extra.bedStd)} / ${Math.round(extra.wakeStd)}`} unit="min" label="bed / wake swing (14n)" />}
          </div>
        </div>
        <div className={s.miniLabel} style={{ marginLeft: 0 }}>Sleep stages &amp; overnight vitals</div>
        <NightDetail night={night} detail={detail} />
        <div className={s.modalStepHint}>Press ← → to move between nights</div>
      </section>
    </div>
  ), document.body);
}
