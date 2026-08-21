// Per-workout cardio fitness analysis for Apple Health, mirroring the Peloton
// fitness endpoint's output shape ({ rides, hrMax, workloadKey }) so the same
// FitnessPanel renders it. Heart rate comes from HeartRate samples; workload
// (for cycling) from CyclingPower. Everything else degrades to HR-only
// intensity/TRIMP, exactly like Peloton does when a ride has no power.
const WARMUP = 120;        // skip the opening ramp from steady-state stats
const HR_FLOOR = 30;       // below any living resting HR — strap dropout
const ZONE_EDGES = [0, 0.65, 0.75, 0.85, 0.95, 1.06]; // fractions of HRmax

// Activities whose workload signal is real (mechanical) cycling power.
const POWER_ACTIVITIES = new Set(['Cycling']);

// Activities with no power meter, whose "output" is instead an ACSM-estimated
// *metabolic* power (watts) derived from speed + body mass. This is not the
// same quantity as Peloton/cycling mechanical output — it's energy expenditure,
// so its EF sits on a different scale and must not be mixed with mechanical EF.
const SPEED_POWER_ACTIVITIES = new Set(['Walking', 'Running', 'Hiking']);

const MI_TO_M = 1609.344;
const RUN_SPEED = 134;      // m/min (~5.0 mph): above this use the ACSM run eq
const SPEED_CAP = 322;      // m/min (~12 mph): clamp GPS glitches
const K_VO2_W = 20.9 / 60;  // ml O₂/min → watts (20.9 J/ml aerobic, per second)
const MAX_SEG = 3600;       // ignore absurdly long distance intervals

// ACSM walking/running metabolic cost → gross metabolic power in watts.
// VO₂ (ml/kg/min) = 0.1·S + 3.5 walking, 0.2·S + 3.5 running (S in m/min,
// grade assumed 0 — no per-workout altitude series). Gross (includes the 3.5
// resting term), so the value is total expenditure, not work above rest.
const metabolicWatts = (speedMmin, weightKg) => {
  let s = speedMmin;
  if (!(s > 0)) return null;
  if (s > SPEED_CAP) s = SPEED_CAP;
  const vo2 = (s >= RUN_SPEED ? 0.2 : 0.1) * s + 3.5;
  return vo2 * weightKg * K_VO2_W;
};

// Expand contiguous distance intervals into a 1 Hz metabolic-power stream so
// walks flow through the same EF/decoupling/binning path as cycling power.
function distanceToPowerStream(intervals, weightKg) {
  const bySec = new Map();
  for (const iv of intervals) {
    const secs = iv.s1 - iv.s0;
    if (secs <= 0 || secs > MAX_SEG || !(iv.miles > 0)) continue;
    const w = metabolicWatts((iv.miles * MI_TO_M) / secs * 60, weightKg);
    if (w == null) continue;
    for (let s = iv.s0; s < iv.s1; s++) bySec.set(s, w); // last writer wins on overlap
  }
  return [...bySec.entries()].map(([sec, v]) => ({ sec, v })).sort((a, b) => a.sec - b.sec);
}

const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const sqlStr = s => `'${String(s).replace(/'/g, "''")}'`;

function groupById(list) {
  const by = new Map();
  for (const r of list) {
    const id = String(r.id);
    let arr = by.get(id);
    if (!arr) by.set(id, arr = []);
    arr.push({ sec: Number(r.sec), v: Number(r.v) });
  }
  return by;
}

const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);

// Port of the Peloton per-ride accumulation, adapted to separate HR and
// workload sample streams (Apple stores them as independent records).
function analyzeRide(w, hrS, wlS, hrMax, wKey, weightKg) {
  // Walk/run "output" is ACSM-estimated metabolic power, not a real power
  // meter — the cycling VO2max equation below assumes mechanical watts, so it
  // must not run on it.
  const estOutput = wlS.length > 0 && !POWER_ACTIVITIES.has(w.activity);
  const durSecs = (w.duration || 20) * 60;
  const mid = WARMUP + (durSecs - WARMUP) / 2;

  // Steady-state (post-warmup) means, and first/second-half means for decoupling.
  const hrSteady = [], wlSteady = [];
  const hr1 = [], hr2 = [], wl1 = [], wl2 = [];
  let maxHr = 0;
  for (const s of hrS) {
    if (s.v >= HR_FLOOR && s.v > maxHr) maxHr = s.v;
    if (s.sec <= WARMUP || s.v < HR_FLOOR) continue;
    hrSteady.push(s.v);
    (s.sec <= mid ? hr1 : hr2).push(s.v);
  }
  for (const s of wlS) {
    if (s.sec <= WARMUP || s.v == null) continue;
    wlSteady.push(s.v);
    (s.sec <= mid ? wl1 : wl2).push(s.v);
  }

  const avgHr = mean(hrSteady);
  const avgOutput = mean(wlSteady);

  // 10s overlay bins (full start→finish, no warmup skip).
  const bin10 = samples => {
    const acc = [];
    for (const s of samples) {
      if (s.v == null || (s === undefined)) continue;
      const b = Math.floor(s.sec / 10);
      (acc[b] || (acc[b] = [0, 0]))[0] += s.v;
      acc[b][1]++;
    }
    const out = [];
    acc.forEach((bn, i) => { if (bn && bn[1]) out.push([i * 10, +(bn[0] / bn[1]).toFixed(1)]); });
    return out;
  };
  const hrSeries = bin10(hrS.filter(s => s.v >= HR_FLOOR));
  const outSeries = bin10(wlS);

  // HR zones from samples vs personal HRmax → Edwards TRIMP.
  let zones = null, trimp = null;
  if (hrMax) {
    const counts = [0, 0, 0, 0, 0];
    let tot = 0;
    for (const s of hrS) {
      if (s.v < HR_FLOOR) continue;
      const frac = s.v / hrMax;
      let z = 0; while (z < 4 && frac >= ZONE_EDGES[z + 1]) z++;
      counts[z]++; tot++;
    }
    if (tot) {
      zones = counts.map(c => Math.round((c / tot) * durSecs));
      trimp = zones.reduce((sum, secs, i) => sum + (secs / 60) * (i + 1), 0);
    }
  }

  const ride = {
    id: w.id, start: w.start, title: w.title || w.activity,
    activity: w.activity, duration: w.duration, source: w.source,
    avgOutput, avgHr, maxHr: maxHr || null,
    pctHrMax: avgHr != null && hrMax ? (avgHr / hrMax) * 100 : null,
    trimp, zones,
    ef: null, decoupling: null,
    outputEstimated: estOutput || null,
    totalOutput: null,
    distance: w.distance ?? null,
    calories: w.energy ?? null,
    strive: null,
    hr: hrSeries.length > 1 ? hrSeries : null,
    out: outSeries.length > 1 ? outSeries : null,
  };

  // EF = steady-state mean power / mean HR; needs ~5min of both.
  if (avgOutput != null && avgHr != null && hrSteady.length >= 60 && wlSteady.length >= 60) {
    ride.ef = avgOutput / avgHr;
    if (hr1.length >= 30 && hr2.length >= 30 && wl1.length >= 30 && wl2.length >= 30) {
      const ef1 = mean(wl1) / mean(hr1), ef2 = mean(wl2) / mean(hr2);
      if (ef1 > 0) ride.decoupling = ((ef1 - ef2) / ef1) * 100;
    }

    // Submaximal VO2max proxy: OLS of minute-mean HR on minute-mean power
    // (HR shifted 30s to absorb lag), extrapolated to HRmax → max aerobic
    // power, ACSM cycling equation → ml/kg/min when weight is known.
    // Cycling only: walking's estimated metabolic power under-reads VO2max
    // badly (submaximal ceiling + cardiac drift → ~35% low vs the bike), and
    // walks sample HR too sparsely (~5s) for this per-ride regression anyway.
    if (wKey === 'output' && hrMax && !estOutput) {
      const pMin = new Map(), hMin = new Map();
      for (const s of wlS) if (s.sec > WARMUP) {
        const m = Math.floor(s.sec / 60);
        const b = pMin.get(m) || [0, 0]; b[0] += s.v; b[1]++; pMin.set(m, b);
      }
      for (const s of hrS) if (s.sec > WARMUP && s.v >= HR_FLOOR) {
        const m = Math.floor((s.sec - 30) / 60);
        if (m < 0) continue;
        const b = hMin.get(m) || [0, 0]; b[0] += s.v; b[1]++; hMin.set(m, b);
      }
      const bins = [];
      for (const [m, p] of pMin) {
        const h = hMin.get(m);
        if (p[1] >= 20 && h && h[1] >= 20) bins.push({ w: p[0] / p[1], hr: h[0] / h[1] });
      }
      if (bins.length >= 8) {
        const ws = bins.map(b => b.w), n = bins.length;
        const sW = ws.reduce((s, v) => s + v, 0);
        const sH = bins.reduce((s, b) => s + b.hr, 0);
        const sWH = bins.reduce((s, b) => s + b.w * b.hr, 0);
        const sW2 = ws.reduce((s, v) => s + v * v, 0);
        const den = n * sW2 - sW * sW;
        const range = Math.max(...ws) - Math.min(...ws);
        if (den > 0 && range >= 30) {
          const slope = (n * sWH - sW * sH) / den;
          const intercept = (sH - slope * sW) / n;
          if (slope >= 0.1) {
            if (Math.min(...ws) <= 100 && Math.max(...ws) >= 100) ride.hrAt100 = intercept + slope * 100;
            const wMax = (hrMax - intercept) / slope;
            if (wMax > 100 && wMax < 500) {
              ride.wAtHrMax = wMax;
              if (weightKg) ride.vo2 = (10.8 * wMax + 7 * weightKg) / weightKg;
            }
          }
        }
      }
    }
  }
  return ride;
}

async function computeFitness(con, { activity, weightLbs, idxs } = {}) {
  if (activity && !/^[A-Za-z]+$/.test(activity)) throw new Error('bad activity');
  const weightKg = weightLbs ? Number(weightLbs) * 0.45359 : null;

  // An explicit idx bundle (e.g. the trainer-session bundles from the Apple
  // Health tab) scopes the whole analysis to those workouts, overriding the
  // activity filter. Every workout query is gated by the same `scope` predicate.
  const idxList = Array.isArray(idxs) ? idxs.filter(n => Number.isInteger(n) && n >= 0) : null;
  const scope = idxList && idxList.length ? `w.idx IN (${idxList.join(',')})`
    : (activity ? `w.activity = ${sqlStr(activity)}` : null);
  const actClause = scope ? `WHERE ${scope}` : '';

  // Distance/energy live in WorkoutStatistics for this export, not the Workout
  // attributes — coalesce them in so trend/SPLOM/totals see real values.
  const ws = await rows(con, `
    WITH stats AS (
      SELECT workout_idx,
             max(CASE WHEN metric IN ('DistanceWalkingRunning','DistanceCycling','DistanceSwimming')
                      THEN sum END) AS dist,
             max(CASE WHEN metric = 'ActiveEnergyBurned' THEN sum END) AS energy
      FROM ah_workout_stats GROUP BY workout_idx
    )
    SELECT w.idx AS id, w.start_ts::VARCHAR AS start, w.activity, w.duration,
           coalesce(w.distance, st.dist) AS distance,
           coalesce(w.energy, st.energy) AS energy, w.source
    FROM ah_workouts w
    LEFT JOIN stats st ON st.workout_idx = w.idx
    ${actClause} ORDER BY w.start_ts`);
  if (!ws.length) return { rides: [], hrMax: null, workloadKey: null };

  const hr = await rows(con, `
    SELECT w.idx AS id, CAST(date_diff('second', w.start_ts, r.start_ts) AS INT) AS sec,
           CAST(r.value AS DOUBLE) AS v
    FROM ah_workouts w JOIN ah_records r
      ON r.metric = 'HeartRate' AND r.start_ts BETWEEN w.start_ts AND w.end_ts
    ${actClause} ORDER BY w.idx`);

  // Workload = cycling power. Only pulled for cycling (or unfiltered).
  const wantPower = !activity || POWER_ACTIVITIES.has(activity);
  let wl = [];
  if (wantPower) {
    const powClause = scope ? `WHERE ${scope}`
      : `WHERE w.activity = 'Cycling'`;
    wl = await rows(con, `
      SELECT w.idx AS id, CAST(date_diff('second', w.start_ts, r.start_ts) AS INT) AS sec,
             CAST(r.value AS DOUBLE) AS v
      FROM ah_workouts w JOIN ah_records r
        ON r.metric = 'CyclingPower' AND r.start_ts BETWEEN w.start_ts AND w.end_ts
      ${powClause} ORDER BY w.idx`);
  }

  const hrBy = groupById(hr), wlBy = groupById(wl);

  // Estimated metabolic power for foot activities: pull DistanceWalkingRunning
  // intervals, keep the single fullest-recording source per workout (iPhone +
  // Watch both log, overlapping), and convert speed → ACSM watts. Needs body
  // mass; without it walks stay HR-only, exactly like a ride with no power.
  // Speed→metabolic-power synthesis is an activity-level feature (walks/runs).
  // An explicit idx bundle (e.g. trainer strength sessions) must not fabricate
  // "walking watts" from incidental movement, so it stays HR-only.
  const wantSpeed = weightKg && !idxList && (!activity || [...SPEED_POWER_ACTIVITIES].includes(activity));
  if (wantSpeed) {
    const spClause = scope
      ? scope
      : `w.activity IN (${[...SPEED_POWER_ACTIVITIES].map(sqlStr).join(', ')})`;
    const dist = await rows(con, `
      SELECT w.idx AS id, r.source AS src,
             CAST(date_diff('second', w.start_ts, r.start_ts) AS INT) AS s0,
             CAST(date_diff('second', w.start_ts, r.end_ts)   AS INT) AS s1,
             CAST(r.value AS DOUBLE) AS miles
      FROM ah_workouts w JOIN ah_records r
        ON r.metric = 'DistanceWalkingRunning'
       AND r.start_ts >= w.start_ts AND r.end_ts <= w.end_ts AND r.value IS NOT NULL
      WHERE ${spClause} ORDER BY w.idx`);

    // Group by workout → source, then keep the source covering the most time.
    const byId = new Map();
    for (const r of dist) {
      const id = String(r.id);
      let srcs = byId.get(id);
      if (!srcs) byId.set(id, srcs = new Map());
      let ivs = srcs.get(r.src);
      if (!ivs) srcs.set(r.src, ivs = []);
      ivs.push({ s0: Number(r.s0), s1: Number(r.s1), miles: Number(r.miles) });
    }
    for (const [id, srcs] of byId) {
      if (wlBy.has(id)) continue; // real power (unlikely for a walk) wins
      let best = null, bestCov = -1;
      for (const ivs of srcs.values()) {
        const cov = ivs.reduce((s, iv) => s + Math.max(0, iv.s1 - iv.s0), 0);
        if (cov > bestCov) { bestCov = cov; best = ivs; }
      }
      const stream = distanceToPowerStream(best, weightKg);
      if (stream.length) wlBy.set(id, stream);
    }
  }

  // Personal HRmax: 3rd-highest per-workout max, robust to strap spikes.
  const maxes = ws
    .map(w => Math.max(0, ...(hrBy.get(String(w.id)) || []).filter(s => s.v >= HR_FLOOR).map(s => s.v)))
    .filter(v => v > 0).sort((a, b) => b - a);
  const hrMax = maxes.length ? maxes[Math.min(2, maxes.length - 1)] : null;

  const nWithPower = ws.filter(w => (wlBy.get(String(w.id)) || []).length > 0).length;
  const wKey = nWithPower >= 3 ? 'output' : null;

  const rides = ws.map(w =>
    analyzeRide(w, hrBy.get(String(w.id)) || [], wlBy.get(String(w.id)) || [], hrMax, wKey, weightKg));

  return { rides, hrMax, workloadKey: wKey };
}

module.exports = { computeFitness };
