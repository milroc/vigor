import { useEffect, useMemo, useRef, useState } from 'react';
import { getHealthDay, getHealthSleepNight } from '../../api.js';
import { ZONE_COLORS } from '../../components/ZoneDays.jsx';
import { EX_COLORS, EX_LABELS, activityCategory, prettyActivity } from './palette.js';
import { PAD_R, clamp, clock, hm, labelWidth, useMeasure } from '../sleep/helpers.js';
import { NightDatePicker } from '../sleep/pickers.jsx';
import { NightDetail } from '../sleep/NightModal.jsx';
import { Stat } from '../sleep/charts.jsx';
import shared from '../../styles/shared.module.css';
import s from '../Sleep.module.css';
import o from '../Overview.module.css';

const ZONE_EDGES = [0.65, 0.75, 0.85, 0.95]; // fractions of HRmax, Z2..Z5 lower bounds
// The sleep helpers' clock() is 6pm-anchored (sleep-axis units); day-modal
// times are true minutes-of-day, so unshift before formatting.
const clockDay = m => clock(m - 1080);
const PAD_L_DAY = 40;

// Zone bin for a HR value against personal HRmax: 0 = under 65% (Z1) … 4 = Z5.
const zoneOf = (v, hrMax) => {
  if (!hrMax) return 0;
  const f = v / hrMax;
  return f >= 0.95 ? 4 : f >= 0.85 ? 3 : f >= 0.75 ? 2 : f >= 0.65 ? 1 : 0;
};
// Split a sample stream into consecutive same-zone runs (each run keeps the
// previous point so the colored segments join without gaps).
const zoneRuns = (pts, hrMax) => {
  const out = [];
  let cur = null;
  for (const p of pts) {
    const z = zoneOf(p.v, hrMax);
    if (!cur || cur.z !== z) {
      const prev = cur ? cur.pts[cur.pts.length - 1] : null;
      cur = { z, pts: prev ? [prev, p] : [p] };
      out.push(cur);
    } else cur.pts.push(p);
  }
  return out;
};

// ---- Train tab: the day's heart rate over clock time, the trace COLORED BY
// ZONE, with each workout's window shaded in its category color and dashed
// zone-threshold lines off personal HRmax. Workout labels live in their own
// band above the plot; the y-range hugs the data so there's no dead headroom.
// Below, the ranked workout table. ----
function TrainTab({ detail, hrMax }) {
  const [ref, w] = useMeasure();
  const workouts = detail?.workouts || [];
  const hr = useMemo(() => (detail?.hr || []).map(p => ({ t: Number(p.t), v: Number(p.v) })), [detail]);
  const PADl = PAD_L_DAY, PADr = PAD_R;
  const plotW = Math.max(w - PADl - PADr, 1);

  // Clock extent: cover the HR stream and every workout, padded slightly.
  const [x0, x1] = useMemo(() => {
    const ts = hr.map(p => p.t);
    for (const wk of workouts) {
      const d = new Date(wk.start);
      const t = d.getHours() * 60 + d.getMinutes();
      ts.push(t, t + (Number(wk.duration) || 0));
    }
    if (!ts.length) return [6 * 60, 22 * 60];
    return [Math.max(0, Math.min(...ts) - 20), Math.min(1439, Math.max(...ts) + 20)];
  }, [hr, workouts]);
  const span = Math.max(x1 - x0, 1);
  const x = m => PADl + (clamp(m, x0, x1) - x0) / span * plotW;

  // Raw (per-second-ish) HR per workout, grouped from the single day query.
  const rawByIdx = useMemo(() => {
    const m = new Map();
    for (const r of detail?.workout_hr || []) {
      const k = String(r.idx);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push({ sec: Number(r.sec), v: Number(r.v) });
    }
    return m;
  }, [detail]);

  const wins = useMemo(() => {
    const base = workouts.map(wk => {
      const d = new Date(wk.start);
      const a = d.getHours() * 60 + d.getMinutes();
      const dur = Number(wk.duration) || 0;
      return { ...wk, a, b: a + dur, dur };
    }).sort((p, q) => p.a - q.a);
    // Merge double-logged recordings: windows overlapping >=80% of the shorter
    // one are the same physical activity written by two sources (e.g. Peloton
    // + Strava). Keep the more specific activity name ('Other' loses), the
    // longest window, and remember every source.
    const merged = [];
    for (const wk of base) {
      const hit = merged.find(m => {
        const ov = Math.min(m.b, wk.b) - Math.max(m.a, wk.a);
        return ov >= 0.8 * Math.max(Math.min(m.dur, wk.dur), 1);
      });
      if (hit) {
        hit.sources.add(wk.source);
        hit.idxs.push(String(wk.idx));
        if (hit.activity === 'Other' && wk.activity !== 'Other') hit.activity = wk.activity;
        if (wk.dur > hit.dur) { hit.dur = wk.dur; hit.b = Math.max(hit.b, wk.b); }
        hit.a = Math.min(hit.a, wk.a);
        if (!hit.avg_hr && wk.avg_hr) { hit.avg_hr = wk.avg_hr; hit.max_hr = wk.max_hr; }
        continue;
      }
      merged.push({ ...wk, sources: new Set([wk.source]), idxs: [String(wk.idx)] });
    }
    return merged.map(wk => {
      const raws = wk.idxs.map(k => rawByIdx.get(k) || []).sort((p, q) => q.length - p.length);
      const raw = raws[0]?.length ? raws[0]
        : hr.filter(p => p.t >= wk.a - 0.5 && p.t <= wk.b + 0.5).map(p => ({ sec: (p.t - wk.a) * 60, v: p.v }));
      // Zone minutes as each zone's SHARE of samples x the workout duration, so
      // the zone bar always totals exactly the workout's minutes.
      const counts = [0, 0, 0, 0, 0];
      raw.forEach(p => counts[zoneOf(p.v, hrMax)]++);
      const n = raw.length || 1;
      const zoneMin = counts.map(c => (c / n) * wk.dur);
      return { ...wk, cat: activityCategory(wk.activity), raw, zoneMin, sources: [...wk.sources] };
    });
  }, [workouts, hr, rawByIdx, hrMax]);

  const runs = useMemo(() => zoneRuns(hr, hrMax), [hr, hrMax]);

  // Workout labels in a DEDICATED band above the plot: dedupe double-logged
  // recordings, then greedy interval row assignment so nothing collides; the
  // band grows only as tall as the rows actually used.
  const labelItems = useMemo(() => {
    if (!(w > 0)) return [];
    const seen = new Set();
    const items = [];
    for (const wk of wins) {
      const key = `${wk.activity}@${Math.round(wk.a / 5)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const text = prettyActivity(wk.activity);
      items.push({ text, lx: x(wk.a) + 1, wpx: labelWidth(text, 9), color: EX_COLORS[wk.cat] });
    }
    items.sort((a2, b2) => a2.lx - b2.lx);
    const rowEnds = [];
    for (const it of items) {
      let r = 0;
      while (r < rowEnds.length && rowEnds[r] + 8 > it.lx) r++;
      it.row = r;
      rowEnds[r] = it.lx + it.wpx;
    }
    return items;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wins, w, x0, x1]);
  const labelRows = labelItems.length ? Math.max(...labelItems.map(it => it.row)) + 1 : 0;
  const padT = 5 + labelRows * 11;
  const plotH = 128, H = padT + plotH + 18;

  // Tight y-range on the DATA — no reserved headroom up to HRmax; zone
  // threshold lines simply clip out when they fall outside the day's range.
  const vs = hr.map(p => p.v);
  const vMin = vs.length ? Math.min(...vs) - 3 : 50;
  const vMax = vs.length ? Math.max(...vs) + 4 : (hrMax || 180);
  const y = v => padT + plotH - (v - vMin) / Math.max(vMax - vMin, 1) * plotH;

  const ticks = [];
  for (let m = Math.ceil(x0 / 180) * 180; m <= x1; m += 180) ticks.push(m);

  // Hover on the day chart: snap to the nearest minute sample; workouts under
  // the cursor also light their table rows below.
  const [hov, setHov] = useState(null); // { t, p, x, y }
  const onMove = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const vbX = (e.clientX - r.left) / Math.max(r.width, 1) * w;
    const t = x0 + (vbX - PADl) / plotW * span;
    if (t < x0 || t > x1 || !hr.length) { setHov(null); return; }
    let best = null, bd = Infinity;
    for (const p of hr) { const d = Math.abs(p.t - t); if (d < bd) { bd = d; best = p; } }
    setHov({ t, p: best, x: e.clientX, y: e.clientY });
  };
  const hotWks = hov ? wins.filter(wk => hov.t >= wk.a && hov.t <= wk.b) : [];
  // Hot set flows BOTH ways: chart hover lights table rows, and hovering a
  // table row lights its window in the chart.
  const [rowHot, setRowHot] = useState(null);
  const hotIdx = new Set(hotWks.map(wk => String(wk.idx)));
  if (rowHot) hotIdx.add(rowHot);

  // NOTE: the measured div must exist from the FIRST render — useMeasure only
  // attaches its ResizeObserver on mount — so the loading state renders inside
  // it rather than replacing it.
  return (
    <div ref={ref}>
      <div className={s.miniLabel} style={{ marginLeft: 0 }}>Heart rate (all day) · colored by zone, workout windows shaded</div>
      {!detail && <TrainSkeleton w={w} />}
      {detail && w > 0 && (
        <svg className={s.svg} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none"
          style={{ cursor: 'crosshair' }} onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
          {labelItems.map((it, k) => (
            <text key={k} x={it.lx} y={12 + it.row * 11} fontSize="9" fill={it.color}>{it.text}</text>
          ))}
          {wins.map((wk, k) => (
            <rect key={k} x={x(wk.a)} y={padT} width={Math.max(x(wk.b) - x(wk.a), 2)} height={plotH} fill={EX_COLORS[wk.cat]} opacity={hotIdx.has(String(wk.idx)) ? 0.28 : 0.13} />
          ))}
          {/* dashed zone thresholds off personal HRmax, labeled at the right */}
          {hrMax && ZONE_EDGES.map((f, z) => {
            const ty = y(f * hrMax);
            if (f * hrMax > vMax || f * hrMax < vMin) return null;
            return (
              <g key={z}>
                <line x1={PADl} x2={w - PADr} y1={ty} y2={ty} stroke={ZONE_COLORS[z + 1]} strokeDasharray="3 4" opacity={0.4} />
                <text x={w - PADr + 3} y={ty + 3} fontSize="8" fill={ZONE_COLORS[z + 1]}>Z{z + 2}</text>
              </g>
            );
          })}
          {[60, 100, 140].filter(g2 => g2 > vMin && g2 < vMax).map(g2 => (
            <text key={g2} x={PADl - 6} y={y(g2) + 3} fill="var(--dim)" fontSize="9" textAnchor="end">{g2}</text>
          ))}
          {/* HR trace colored by zone */}
          {runs.map((r, k) => r.pts.length > 1 && (
            <path key={k} d={r.pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.t).toFixed(1)} ${y(p.v).toFixed(1)}`).join('')}
              fill="none" stroke={ZONE_COLORS[r.z]} strokeWidth={r.z >= 1 ? 1.6 : 1.1} opacity={r.z >= 1 ? 0.95 : 0.6} />
          ))}
          {ticks.map(m => <text key={m} x={x(m)} y={H - 5} fill="var(--dim)" fontSize="9" textAnchor="middle">{clockDay(m)}</text>)}
          {hov && (
            <g pointerEvents="none">
              <line x1={x(hov.t)} x2={x(hov.t)} y1={padT} y2={padT + plotH} stroke="#fff" opacity={0.32} />
              {hov.p && <line x1={x(hov.p.t) - 4} x2={x(hov.p.t) + 4} y1={y(hov.p.v)} y2={y(hov.p.v)}
                stroke={ZONE_COLORS[zoneOf(hov.p.v, hrMax)]} strokeWidth={2.5} />}
            </g>
          )}
          {hr.length < 2 && <text x={w / 2} y={H / 2} fill="var(--dim)" fontSize="11" textAnchor="middle">no heart-rate stream this day</text>}
        </svg>
      )}
      {hov && hov.p && (
        <div className={`${s.tip} ${s.tipBlank}`} style={{ left: Math.min(hov.x + 12, window.innerWidth - 240), top: hov.y + 12 }}>
          <b>{clockDay(Math.round(hov.t))}</b>
          <div className={s.tipRow}><span>hr</span>
            <span style={{ color: ZONE_COLORS[zoneOf(hov.p.v, hrMax)] }}>{Math.round(hov.p.v)} bpm - Z{zoneOf(hov.p.v, hrMax) + 1}</span></div>
          {hotWks.map((wk, k) => (
            <div key={k} className={s.tipRow}><span><span className={s.tipDot} style={{ background: EX_COLORS[wk.cat] }} />{prettyActivity(wk.activity)}</span>
              <span>{Math.round(hov.t - wk.a)}m in</span></div>
          ))}
        </div>
      )}
      {detail && wins.length === 0 && (
        <div className={o.emptyCard}>
          <svg width="40" height="26" viewBox="0 0 40 26" aria-hidden>
            <path d="M1 15 L12 15 L15 8 L18 21 L21 12 L23 15 L39 15" fill="none"
              stroke={EX_COLORS[0]} strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity="0.85" />
          </svg>
          <div>
            <div className={o.emptyTitle}>Rest day</div>
            <div className={o.emptySub}>No workouts logged — recovery is part of the plan.</div>
          </div>
        </div>
      )}
      {wins.length > 0 && <WorkoutTable wins={wins} hrMax={hrMax} hotIdx={hotIdx} onRowHot={setRowHot} />}
    </div>
  );
}

// Loading skeleton shaped like what arrives: a ghost day-HR chart (dashed
// thresholds, shaded workout windows, a shimmering trace) over ghost table
// rows with descending zone bars — the ranked-table silhouette.
function TrainSkeleton({ w }) {
  if (!(w > 0)) return <div style={{ height: 320 }} />;
  const H = 150, padT = 16, plotH = H - padT - 18;
  const PADl = PAD_L_DAY, PADr = PAD_R;
  const plotW = Math.max(w - PADl - PADr, 1);
  const mid = padT + plotH * 0.55;
  const N = 40;
  const d = Array.from({ length: N }, (_, i) => {
    const t = i / (N - 1);
    const wob = Math.sin(t * 9 + 1.3) * 0.3 + Math.sin(t * 23 + 2.1) * 0.14;
    return `${i ? 'L' : 'M'}${(PADl + t * plotW).toFixed(1)} ${(mid - wob * plotH * 0.5).toFixed(1)}`;
  }).join('');
  return (
    <div aria-busy="true" aria-label="loading the day's heart rate and workouts">
      <svg className={`${s.svg} ${s.skelSvg}`} width="100%" height={H} viewBox={`0 0 ${w} ${H}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="trainskel" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="var(--c-hr)" stopOpacity="0.12" />
            <stop offset="50%" stopColor="var(--c-hr)" stopOpacity="0.65" />
            <stop offset="100%" stopColor="var(--c-hr)" stopOpacity="0.12" />
            <animate attributeName="x1" values="-1;1" dur="1.6s" repeatCount="indefinite" />
            <animate attributeName="x2" values="0;2" dur="1.6s" repeatCount="indefinite" />
          </linearGradient>
        </defs>
        {[0.52, 0.6, 0.78].map((f, i) => (
          <rect key={i} x={PADl + plotW * f} y={padT} width={plotW * 0.055} height={plotH} fill="var(--line)" opacity={0.3} />
        ))}
        {[0.22, 0.42, 0.62].map((f, i) => (
          <line key={i} x1={PADl} x2={w - PADr} y1={padT + plotH * f} y2={padT + plotH * f} stroke="var(--line)" strokeDasharray="3 4" opacity={0.5} />
        ))}
        <path className={s.skelTrack} d={d} fill="none" stroke="var(--line)" strokeWidth={1.4} />
        <path d={d} fill="none" stroke="url(#trainskel)" strokeWidth={1.8} strokeLinecap="round" />
      </svg>
      <div className={o.wkTable}>
        {['Workout', 'Time', 'Time in zone', 'HR'].map(h => <div key={h} className={o.wkTh}>{h}</div>)}
        {[0, 1, 2].map(k => (
          <div key={k} className={o.wkRow}>
            <div><span className={o.skelBlock} style={{ width: 130 - k * 18 }} /></div>
            <div><span className={o.skelBlock} style={{ width: 84 }} /></div>
            <div><span className={o.skelBlock} style={{ width: `${72 - k * 22}%`, height: 12 }} /></div>
            <div><span className={o.skelBlock} style={{ width: '100%', height: 16 }} /></div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ---- Workout table, ranked by total minutes (longest first). One query feeds
// it (the day endpoint's raw in-workout HR). Zone bar LENGTH = the workout's
// minutes (comparable across rows, scaled to the longest workout); the HR
// sparkline is axis-free but keeps the zone coloring. ----
function WorkoutTable({ wins, hrMax, hotIdx, onRowHot }) {
  const sorted = useMemo(() => [...wins].sort((a, b) => b.dur - a.dur), [wins]);
  const maxDur = Math.max(...sorted.map(wk => wk.dur), 1);
  return (
    <div className={o.wkTable}>
      {['Workout', 'Time', 'Time in zone', 'HR'].map(h => <div key={h} className={o.wkTh}>{h}</div>)}
      {sorted.map((wk, k) => (
        <div key={k} className={`${o.wkRow} ${hotIdx?.has(String(wk.idx)) ? o.wkRowHot : ''}`}
          onMouseEnter={() => onRowHot?.(String(wk.idx))} onMouseLeave={() => onRowHot?.(null)}>
          <div className={o.workoutHead}>
            <span className={s.tipDot} style={{ background: EX_COLORS[wk.cat] }} />
            <span className={o.workoutName}>{prettyActivity(wk.activity)}</span>
            <span className={o.workoutMeta}>{EX_LABELS[wk.cat].toLowerCase()}{wk.sources.length > 1 ? ` · ${wk.sources.length} sources: ${wk.sources.join(' + ')}` : ` · ${wk.sources[0]}`}</span>
          </div>
          <div className={o.workoutMeta}>{clockDay(wk.a)} – {clockDay(Math.round(wk.b))}</div>
          <ZoneBar wk={wk} maxDur={maxDur} />
          <ZoneSpark samples={wk.raw} hrMax={hrMax} />
        </div>
      ))}
    </div>
  );
}

// Horizontal time-in-zone bar: total length ∝ the workout's minutes, split
// into zone segments (Z1 faded → Z5), with the total labeled at the end.
function ZoneBar({ wk, maxDur }) {
  const [hovSeg, setHovSeg] = useState(null); // { z, zm, x, y }
  const total = wk.zoneMin.reduce((a, b) => a + b, 0);
  if (!(total > 0)) return <span className={o.workoutMeta}>no HR</span>;
  const pct = Math.max(wk.dur / maxDur * 100, 3);
  const fmtMin = zm => (zm < 1 ? '<1' : Math.round(zm));
  let acc = 0;
  return (
    <div className={o.zoneBarWrap}>
      <svg className={s.svg} style={{ width: `${pct}%`, cursor: 'help' }} height={12} viewBox="0 0 100 12" preserveAspectRatio="none"
        onPointerLeave={() => setHovSeg(null)}>
        {wk.zoneMin.map((zm, z) => {
          if (!(zm > 0)) return null;
          const seg = (
            <rect key={z} x={acc / total * 100} y={0} width={zm / total * 100} height={12}
              fill={ZONE_COLORS[z]} opacity={hovSeg ? (hovSeg.z === z ? 1 : 0.35) : (z === 0 ? 0.45 : 0.9)}
              onPointerMove={e => setHovSeg({ z, zm, x: e.clientX, y: e.clientY })} />
          );
          acc += zm;
          return seg;
        })}
      </svg>
      <span className={o.workoutMeta}>{Math.round(wk.dur)}m</span>
      {hovSeg && (
        <div className={`${s.tip} ${s.tipBlank}`} style={{ left: Math.min(hovSeg.x + 12, window.innerWidth - 180), top: hovSeg.y + 12 }}>
          <div className={s.tipRow}><span style={{ color: ZONE_COLORS[hovSeg.z] }}>Z{hovSeg.z + 1}</span>
            <span>{fmtMin(hovSeg.zm)}m · {Math.round(hovSeg.zm / total * 100)}%</span></div>
        </div>
      )}
    </div>
  );
}

// Axis-free HR sparkline over the workout window, colored by zone. Hovering
// snaps to the nearest sample: a crosshair on the line plus a small tooltip
// with time-into-workout, bpm and the zone.
function ZoneSpark({ samples, hrMax }) {
  const runs = useMemo(() => zoneRuns(samples, hrMax), [samples, hrMax]);
  const [hov, setHov] = useState(null); // { p, x, y }
  if (samples.length < 2) return <span className={o.workoutMeta}>no HR</span>;
  const s0 = samples[0].sec, s1 = samples[samples.length - 1].sec;
  const vs = samples.map(p => p.v);
  const lo = Math.min(...vs), hi = Math.max(...vs);
  const sx = t => (t - s0) / Math.max(s1 - s0, 1) * 100;
  const sy = v => 2 + 22 * (1 - (v - lo) / Math.max(hi - lo, 1));
  const onMove = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const t = s0 + (e.clientX - r.left) / Math.max(r.width, 1) * (s1 - s0);
    let best = null, bd = Infinity;
    for (const p of samples) { const d = Math.abs(p.sec - t); if (d < bd) { bd = d; best = p; } }
    setHov({ p: best, x: e.clientX, y: e.clientY });
  };
  const z = hov ? zoneOf(hov.p.v, hrMax) : 0;
  const mmss = sec => `${Math.floor(sec / 60)}:${String(Math.round(sec % 60)).padStart(2, '0')}`;
  return (
    <>
      <svg className={s.svg} width="100%" height={26} viewBox="0 0 100 26" preserveAspectRatio="none"
        style={{ cursor: 'crosshair' }} onPointerMove={onMove} onPointerLeave={() => setHov(null)}>
        {runs.map((r, k) => r.pts.length > 1 && (
          <path key={k} d={r.pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.sec).toFixed(2)} ${sy(p.v).toFixed(1)}`).join('')}
            fill="none" stroke={ZONE_COLORS[r.z]} strokeWidth={1} vectorEffect="non-scaling-stroke" opacity={r.z === 0 ? 0.55 : 0.95} />
        ))}
        {hov && (
          <g pointerEvents="none">
            <line x1={sx(hov.p.sec)} x2={sx(hov.p.sec)} y1={0} y2={26} stroke="#fff" opacity={0.35} vectorEffect="non-scaling-stroke" />
            <line x1={sx(hov.p.sec) - 1.4} x2={sx(hov.p.sec) + 1.4} y1={sy(hov.p.v)} y2={sy(hov.p.v)}
              stroke={ZONE_COLORS[z]} strokeWidth={2.5} vectorEffect="non-scaling-stroke" />
          </g>
        )}
      </svg>
      {hov && (
        <div className={`${s.tip} ${s.tipBlank}`} style={{ left: Math.min(hov.x + 12, window.innerWidth - 190), top: hov.y + 12 }}>
          <div className={s.tipRow}><span>+{mmss(hov.p.sec)}</span>
            <span style={{ color: ZONE_COLORS[z] }}>{Math.round(hov.p.v)} bpm · Z{z + 1}</span></div>
        </div>
      )}
    </>
  );
}

// ---- NEAT tab: hour-of-day lanes for every all-day metric (steps, active
// energy, exercise + stand minutes) with one shared hover cursor. ----
const NEAT_LANES = [
  { key: 'steps', label: 'Steps', color: 'var(--c-daylight)', unit: '' },
  { key: 'active', label: 'Active energy', color: 'var(--c-rhr)', unit: ' kcal' },
  { key: 'exercise', label: 'Exercise min', color: EX_COLORS[0], unit: ' min' },
  { key: 'stand', label: 'Stand min', color: 'var(--c-resp)', unit: ' min', max: 60 },
];
function NeatTab({ detail, g }) {
  const [ref, w] = useMeasure();
  const [hovH, setHovH] = useState(null);
  const hourly = detail?.hourly || [];
  const byHour = useMemo(() => Object.fromEntries(hourly.map(r => [Number(r.hour), r])), [hourly]);
  const PAD = { l: PAD_L_DAY, r: PAD_R };
  const plotW = Math.max(w - PAD.l - PAD.r, 1), cw = plotW / 24;
  const LANE = 56, GAP = 14;

  const m = detail?.metrics || {};
  const onMove = e => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = (e.clientX - r.left) / r.width * w;
    setHovH(clamp(Math.floor((px - PAD.l) / cw), 0, 23));
  };
  return (
    <div>
      {!detail && <div className={o.tabEmpty}>loading…</div>}
      {detail && <div className={`${s.statTier} ${s.statSm}`} style={{ paddingTop: 0 }}>
        <Stat value={m.steps != null ? Math.round(m.steps).toLocaleString() : '—'} label="steps" />
        <Stat value={m.active_energy != null ? Math.round(m.active_energy).toLocaleString() : '—'} unit="kcal" label="active" />
        <Stat value={m.neat_energy != null ? Math.round(m.neat_energy).toLocaleString() : '—'} unit="kcal" label="neat (non-workout)" />
        <Stat value={m.exercise_min != null ? Math.round(m.exercise_min) : '—'} unit="min" label="exercise" />
        <Stat value={g?.stand_hours ?? '—'} unit="hr" label="stand hours" />
        <Stat value={m.flights != null ? Math.round(m.flights) : '—'} label="flights" />
        <Stat value={m.distance != null ? Number(m.distance).toFixed(1) : '—'} unit="mi" label="distance" />
      </div>}
      {detail && hourly.length === 0 && (
        <div className={o.emptyCard}>
          <svg width="40" height="20" viewBox="0 0 40 20" aria-hidden>
            {[[4, 14, 3], [12, 11, 2.5], [20, 13, 2], [28, 10, 1.5], [35, 12, 1]].map(([cx, cy, r], i) => (
              <circle key={i} cx={cx} cy={cy} r={r} fill="var(--c-daylight)" opacity={0.8 - i * 0.15} />
            ))}
          </svg>
          <div>
            <div className={o.emptyTitle}>A quiet one</div>
            <div className={o.emptySub}>No movement captured this day — no phone or Watch along for the ride.</div>
          </div>
        </div>
      )}
      <div ref={ref} onPointerMove={w > 0 ? onMove : undefined} onPointerLeave={() => setHovH(null)} style={{ cursor: 'crosshair' }}>
        {w > 0 && hourly.length > 0 && NEAT_LANES.map((lane, li) => {
          const vals = Array.from({ length: 24 }, (_, h) => Number(byHour[h]?.[lane.key]) || 0);
          const vmax = Math.max(lane.max || 0, ...vals, 1);
          const H = LANE + (li === NEAT_LANES.length - 1 ? 16 : 0);
          return (
            <svg key={lane.key} className={s.svg} width="100%" height={H + GAP} viewBox={`0 0 ${w} ${H + GAP}`} preserveAspectRatio="none">
              <text x={0} y={9} fontSize="10" fill="var(--dim)">{lane.label} · <tspan fill={lane.color}>{Math.round(vals.reduce((a, b) => a + b, 0)).toLocaleString()}</tspan>{lane.unit}</text>
              <line x1={PAD.l} x2={w - PAD.r} y1={GAP + LANE - 1} y2={GAP + LANE - 1} stroke="var(--line)" />
              {vals.map((v, h) => v > 0 && (
                <rect key={h} x={PAD.l + h * cw + 0.5} y={GAP + LANE - 1 - (v / vmax) * (LANE - 14)} width={Math.max(cw - 1, 1)}
                  height={(v / vmax) * (LANE - 14)} fill={lane.color} opacity={hovH === h ? 1 : 0.62} />
              ))}
              {hovH != null && <rect x={PAD.l + hovH * cw} y={GAP} width={cw} height={LANE - 1} fill="#fff" opacity={0.08} pointerEvents="none" />}
              {hovH != null && vals[hovH] > 0 && (
                <text x={clamp(PAD.l + hovH * cw + cw / 2, PAD.l + 14, w - PAD.r - 14)} y={GAP + 8} fontSize="9" fill={lane.color} textAnchor="middle">{Math.round(vals[hovH]).toLocaleString()}</text>
              )}
              {li === NEAT_LANES.length - 1 && [0, 6, 12, 18, 24].map(h => (
                <text key={h} x={PAD.l + Math.min(h, 23.999) * cw + (h === 24 ? cw : 0)} y={H + GAP - 3} fontSize="9" fill="var(--dim)" textAnchor="middle">{clockDay((h % 24) * 60)}</text>
              ))}
            </svg>
          );
        })}
      </div>
    </div>
  );
}

// ---- Day modal: goals scorecard up top (met goals celebrated, unmet behind a
// hover count), then Train / NEAT / Sleep tabs. Sleep reuses the sleep view's
// NightDetail wholesale. ----
export function DayModal({ cal, idx, goalsEval, g, naps, hrMax, min, max, onClose, onStep, onPickDate }) {
  const day = cal[idx];
  const [tab, setTab] = useState('train');
  const [detail, setDetail] = useState(null);       // /api/health/day
  const [nightDetail, setNightDetail] = useState(null); // /api/health/sleep/night
  const [picking, setPicking] = useState(false);    // single-date picker open
  const changeRef = useRef(null);                   // anchor for the fixed-position picker

  // Debounced fetch (same idiom as the sleep NightModal): holding an arrow key
  // steps many days quickly, so wait for the date to settle before querying.
  useEffect(() => {
    let ok = true;
    setDetail(null); setNightDetail(null);
    const timer = setTimeout(() => {
      getHealthDay(day.day).then(d => { if (ok) setDetail(d); }).catch(() => { if (ok) setDetail({ metrics: {}, workouts: [], hr: [], hourly: [] }); });
      if (!day.blank) {
        getHealthSleepNight(day.day).then(d => { if (ok) setNightDetail(d); }).catch(() => { if (ok) setNightDetail({ hr: [], hrv: [], resp: [], spo2: [] }); });
      }
    }, 250);
    return () => { ok = false; clearTimeout(timer); };
  }, [day.day, day.blank]);

  useEffect(() => {
    const onKey = e => {
      if (e.key === 'Escape') { if (picking) setPicking(false); else onClose(); return; }
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

  const title = new Date(day.day + 'T00:00:00').toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
  const met = goalsEval.filter(e => !e.empty && e.met);
  const unmet = goalsEval.filter(e => !e.empty && !e.met);
  const [showUnmet, setShowUnmet] = useState(false);

  const TABS = [['train', 'Train'], ['neat', 'NEAT'], ['sleep', 'Sleep']];
  return (
    <div className={s.modalOverlay} onClick={onClose}>
      <section className={s.modal} onClick={e => e.stopPropagation()}>
        <div className={s.modalHead}>
          <div>
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
            <div className={s.modalSub}>
              {g?.exercise_min != null && `${Math.round(g.exercise_min)} min exercise · `}
              {g?.steps != null && `${Math.round(g.steps).toLocaleString()} steps · `}
              {!day.blank ? `${hm(day.asleepEff)} asleep` : 'no sleep recorded'}
            </div>
          </div>
          <div className={s.modalHeadRight}>
            <button className={shared.btn} onClick={onClose}>Close</button>
          </div>
        </div>
        {picking && (
          <NightDatePicker min={min} max={max} day={day.day} anchorRef={changeRef}
            onClose={() => setPicking(false)}
            onPick={d => { setPicking(false); onPickDate?.(d); }} />
        )}

        {/* Goals scorecard: met goals celebrated as chips, unmet as one count
            that reveals the misses on hover. */}
        <div className={o.goalStrip}>
          {met.map(e => (
            <span key={e.g.id} className={o.chipMet} style={{ borderColor: e.g.color }} title={e.g.label}>
              <span className={o.chipCheck} style={{ color: e.g.color }}>✓</span>
              {e.short} {e.g.fmt(e.value)}{e.per === 'week' ? ' /wk' : ''}
            </span>
          ))}
          {met.length === 0 && <span className={o.emptySub}>No targets met — an off day on the record.</span>}
          {unmet.length > 0 && (
            <span className={o.chipUnmet} onMouseEnter={() => setShowUnmet(true)} onMouseLeave={() => setShowUnmet(false)}>
              {unmet.length} unmet
              {showUnmet && (
                <span className={`${s.infoPop} ${o.unmetPop}`}>
                  {unmet.map(e => (
                    <span key={e.g.id} className={s.tipRow}>
                      <span><span className={s.tipDot} style={{ background: e.g.color }} />{e.g.label.toLowerCase()}{e.per === 'week' ? ' (week)' : ''}</span>
                      <span>{e.g.fmt(e.value ?? 0)} / {e.g.fmt(e.g.target)}</span>
                    </span>
                  ))}
                </span>
              )}
            </span>
          )}
        </div>

        <div className={o.tabBar} role="tablist">
          {TABS.map(([k, lbl]) => (
            <button key={k} role="tab" aria-selected={tab === k} className={`${o.tabBtn} ${tab === k ? o.tabOn : ''}`} onClick={() => setTab(k)}>{lbl}</button>
          ))}
        </div>

        {tab === 'train' && <TrainTab detail={detail} hrMax={hrMax} />}
        {tab === 'neat' && <NeatTab detail={detail} g={g} />}
        {tab === 'sleep' && (day.blank
          ? (
            <div className={o.emptyCard}>
              <svg width="30" height="30" viewBox="0 0 30 30" aria-hidden>
                <path d="M19 3 A 11 11 0 1 0 27 17 A 9 9 0 0 1 19 3 Z" fill="var(--st-core)" opacity="0.75" />
                <text x="21" y="9" fontSize="8" fill="var(--st-rem)" fontFamily="'IBM Plex Mono', monospace">z</text>
                <text x="26" y="5" fontSize="6" fill="var(--st-rem)" fontFamily="'IBM Plex Mono', monospace">z</text>
              </svg>
              <div>
                <div className={o.emptyTitle}>No sleep recorded</div>
                <div className={o.emptySub}>The Watch sat this night out — nothing reached the sensor.</div>
              </div>
            </div>
          )
          : (
            <>
              <div className={`${s.statTier} ${s.statSm}`} style={{ paddingTop: 0 }}>
                <Stat value={hm(day.asleepEff)} label="asleep" />
                <Stat value={day.eff == null ? '—' : day.eff} unit="%" label="efficiency" />
                <Stat value={hm(day.deep)} label="deep" />
                <Stat value={hm(day.rem)} label="rem" />
                <Stat value={hm(day.core)} label="core" />
                <Stat value={hm(day.awake)} label="awake" />
                {naps.length > 0 && <Stat value={naps.map(p => hm(p.asleep)).join(', ')} label={naps.length > 1 ? 'naps' : 'nap'} />}
              </div>
              <NightDetail night={day} detail={nightDetail} />
            </>
          ))}

        <div className={s.modalStepHint}>Press ← → to move between days</div>
      </section>
    </div>
  );
}
