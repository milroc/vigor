// Daily fitness-goal metrics for the Overview tab: one row per day of the
// signals the configurable goals (labels/fitness-goals.json) are scored
// against — heart-rate zone minutes, steps, Apple exercise minutes, and
// explicit-workout session counts.
//
// "Sessions" are explicit workouts: every Apple Health workout plus every
// completed Peloton workout from the newest backups. The two overlap (the
// Peloton app writes rides into HealthKit, and the Watch may record the same
// ride), so overlapping/near-adjacent recordings are merged into one session
// before counting.
//
// Zone minutes come from Apple HeartRate samples inside workout windows:
// each calendar minute is classified ONCE by its average HR against personal
// HRmax (same ZONE_EDGES as scripts/healthFitness.cjs), so double-logged
// workouts and dual HR sources can't double-count a minute. Z2+ = >=65% of
// HRmax, Z4+ = >=85%. A Peloton ride that never reached Apple Health has no
// HR samples here and contributes no zone minutes.
const HR_FLOOR = 30;         // below any living resting HR — strap dropout
const Z2_FRAC = 0.65;        // ZONE_EDGES[1] in healthFitness.cjs
const Z4_FRAC = 0.85;        // ZONE_EDGES[3]
const MERGE_GAP_MIN = 5;     // recordings closer than this merge into one session

// Built-in goal set, used when labels/fitness-goals.json doesn't exist.
// per:'week' sums the metric over Mon–Sun calendar weeks; per:'day' scores
// each day on its own. Metrics: z2 / z4 (zone minutes), exercise_min (Apple
// exercise ring), steps, asleep_min (effective sleep, from the sleep data),
// sessions / session_min (merged explicit workouts).
const DEFAULT_GOALS = [
  { id: 'z4', label: 'Zone 4+ minutes', metric: 'z4', per: 'week', target: 10, unit: 'min', shape: 'violin' },
  { id: 'z2', label: 'Zone 2+ minutes', metric: 'z2', per: 'week', target: 150, unit: 'min', shape: 'violin' },
  { id: 'exercise', label: 'Exercise minutes', metric: 'exercise_min', per: 'week', target: 210, unit: 'min', shape: 'violin' },
  { id: 'exercise-daily', label: 'Exercise ring', metric: 'exercise_min', per: 'day', target: 30, unit: 'min', short: 'EX30' },
  { id: 'steps', label: 'Steps', metric: 'steps', per: 'day', target: 7000, unit: 'steps' },
  { id: 'move', label: 'Active energy', metric: 'active_energy', per: 'day', target: 750, unit: 'kcal', short: 'MOVE' },
  { id: 'stand', label: 'Stand hours', metric: 'stand_hours', per: 'day', target: 12, unit: 'hours', short: 'STAND' },
  { id: 'sleep', label: 'Sleep', metric: 'asleep_min', per: 'day', target: 420, unit: 'min' },
  { id: 'deep', label: 'Deep sleep', metric: 'deep_min', per: 'day', target: 60, unit: 'min' },
];

const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const num = v => (v == null ? null : Number(v));
const pad2 = n => String(n).padStart(2, '0');
const localDay = ms => { const d = new Date(ms); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

// Merge raw workout intervals (ms epoch) into per-day session counts/minutes.
function mergeSessions(intervals) {
  const ivs = intervals.filter(iv => Number.isFinite(iv.s) && Number.isFinite(iv.e) && iv.e >= iv.s)
    .sort((a, b) => a.s - b.s);
  const clusters = [];
  for (const iv of ivs) {
    const prev = clusters[clusters.length - 1];
    if (prev && iv.s - prev.e <= MERGE_GAP_MIN * 60_000) prev.e = Math.max(prev.e, iv.e);
    else clusters.push({ ...iv });
  }
  const byDay = new Map();
  for (const c of clusters) {
    const day = localDay(c.s);
    const cur = byDay.get(day) || { sessions: 0, session_min: 0 };
    cur.sessions++;
    cur.session_min += Math.round((c.e - c.s) / 60_000);
    byDay.set(day, cur);
  }
  return byDay;
}

async function computeGoalDays(con, { pelotonWindows = [] } = {}) {
  // Steps + exercise minutes per day (ah_activity_daily already dedups the
  // concurrent iPhone + Watch streams — same source as the NEAT endpoint).
  const act = await rows(con, `
    SELECT day::VARCHAR AS day,
           sum(CASE WHEN metric = 'StepCount' THEN sum END) AS steps,
           sum(CASE WHEN metric = 'AppleExerciseTime' THEN sum END) AS exercise_min,
           sum(CASE WHEN metric = 'ActiveEnergyBurned' THEN sum END) AS active_energy,
           sum(CASE WHEN metric = 'AppleStandTime' THEN sum END) AS stand_min
    FROM ah_activity_daily GROUP BY 1 ORDER BY 1`);

  // Stand HOURS (the stand ring): Apple credits an hour when you stood at
  // least a minute in it — approximate as distinct clock-hours with any
  // AppleStandTime recorded.
  const stand = await rows(con, `
    SELECT CAST(start_ts AS DATE)::VARCHAR AS day,
           count(DISTINCT date_trunc('hour', start_ts)) AS stand_hours
    FROM ah_records
    WHERE metric = 'AppleStandTime' AND value > 0
    GROUP BY 1 ORDER BY 1`);

  // Workout-dependent metrics degrade gracefully when workouts.parquet is absent.
  let hrMax = null, zones = [], workouts = [], exSplit = [];
  try {
    // Personal HRmax: 3rd-highest per-workout max, robust to strap spikes
    // (same rule as healthFitness.cjs).
    const mx = await rows(con, `
      SELECT max(r.value) AS mx
      FROM ah_workouts w JOIN ah_records r
        ON r.metric = 'HeartRate' AND r.value >= ${HR_FLOOR}
       AND r.start_ts BETWEEN w.start_ts AND w.end_ts
      GROUP BY w.idx ORDER BY mx DESC LIMIT 3`);
    hrMax = mx.length ? Number(mx[Math.min(2, mx.length - 1)].mx) : null;

    if (hrMax) {
      zones = await rows(con, `
        WITH mhr AS (
          SELECT date_trunc('minute', start_ts) AS mts, avg(value) AS hr
          FROM ah_records WHERE metric = 'HeartRate' AND value >= ${HR_FLOOR}
          GROUP BY 1
        )
        SELECT CAST(mts AS DATE)::VARCHAR AS day,
               count(*) FILTER (WHERE hr >= ${Z2_FRAC * hrMax}) AS z2,
               count(*) FILTER (WHERE hr >= ${Z4_FRAC * hrMax}) AS z4,
               count(*) FILTER (WHERE hr < ${0.65 * hrMax}) AS zb1,
               count(*) FILTER (WHERE hr >= ${0.65 * hrMax} AND hr < ${0.75 * hrMax}) AS zb2,
               count(*) FILTER (WHERE hr >= ${0.75 * hrMax} AND hr < ${0.85 * hrMax}) AS zb3,
               count(*) FILTER (WHERE hr >= ${0.85 * hrMax} AND hr < ${0.95 * hrMax}) AS zb4,
               count(*) FILTER (WHERE hr >= ${0.95 * hrMax}) AS zb5
        FROM (
          SELECT DISTINCT m.mts, m.hr
          FROM mhr m JOIN ah_workouts w ON m.mts BETWEEN w.start_ts AND w.end_ts
        )
        GROUP BY 1 ORDER BY 1`);
    }
    workouts = await rows(con, `
      SELECT start_ts::VARCHAR AS start, end_ts::VARCHAR AS "end"
      FROM ah_workouts ORDER BY start_ts`);

    // Exercise-ring minutes split by what you were doing: each distinct
    // credited minute is attributed to the workout window it fell in — lifting
    // (strength types + 'Other', which is how trainer sessions log), recovery
    // (yoga / stretch / prep / cooldown), any other workout = cardio — and
    // ring minutes outside any workout land in the 'other' bucket (brisk
    // walking etc.). Named activities outrank the generic 'Other' when windows
    // overlap (double-logged Peloton + Strava recordings label the same
    // cooldown 'PreparationAndRecovery' and 'Other'); an 'Other' alone still
    // counts as lifting, per the trainer-session convention.
    exSplit = await rows(con, `
      WITH em AS (
        SELECT DISTINCT date_trunc('minute', start_ts) AS mts
        FROM ah_records WHERE metric = 'AppleExerciseTime' AND value > 0
      ),
      lab AS (
        SELECT em.mts,
               min(CASE
                 WHEN w.activity IN ('TraditionalStrengthTraining','FunctionalStrengthTraining','CoreTraining') THEN 1
                 WHEN w.activity IN ('Yoga','Flexibility','Cooldown','MindAndBody','Pilates','PreparationAndRecovery') THEN 3
                 WHEN w.activity = 'Other' THEN 4
                 WHEN w.activity IS NOT NULL THEN 2
                 ELSE 6 END) AS cat
        FROM em LEFT JOIN ah_workouts w ON em.mts BETWEEN w.start_ts AND w.end_ts
        GROUP BY em.mts
      )
      SELECT CAST(mts AS DATE)::VARCHAR AS day,
             count(*) FILTER (WHERE cat = 2) AS exc,
             count(*) FILTER (WHERE cat IN (1, 4)) AS exl,
             count(*) FILTER (WHERE cat = 3) AS exr,
             count(*) FILTER (WHERE cat = 6) AS exo
      FROM lab GROUP BY 1 ORDER BY 1`);
  } catch { /* no workouts ingested yet — steps/exercise still served */ }

  // Apple timestamps are naive local strings; Peloton backups carry their own
  // parseable timestamps. Date.parse lands both on comparable epoch ms.
  const intervals = workouts.map(w => ({ s: Date.parse(w.start), e: Date.parse(w.end) }));
  for (const p of pelotonWindows) {
    const s = Date.parse(p.start);
    const e = p.end ? Date.parse(p.end) : s;
    intervals.push({ s, e });
  }
  const sessByDay = mergeSessions(intervals);

  const byDay = new Map();
  const at = day => { let r = byDay.get(day); if (!r) byDay.set(day, r = { day }); return r; };
  for (const a of act) Object.assign(at(a.day), { steps: num(a.steps), exercise_min: num(a.exercise_min), active_energy: num(a.active_energy), stand_min: num(a.stand_min) });
  for (const sv of stand) at(sv.day).stand_hours = num(sv.stand_hours);
  // zones = per-band minutes Z1..Z5 (same ZONE_EDGES as healthFitness.cjs),
  // for the Overview's zone stream; z2/z4 stay the Z2+/Z4+ goal aggregates.
  for (const z of zones) Object.assign(at(z.day), {
    z2: num(z.z2), z4: num(z.z4),
    zones: [num(z.zb1), num(z.zb2), num(z.zb3), num(z.zb4), num(z.zb5)],
  });
  // ex_split = ring minutes by kind [cardio, lift, recovery, unattributed].
  for (const e of exSplit) at(e.day).ex_split = [num(e.exc), num(e.exl), num(e.exr), num(e.exo)];
  for (const [day, sVal] of sessByDay) Object.assign(at(day), sVal);

  const days = [...byDay.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
  return { hrMax, days };
}

module.exports = { computeGoalDays, DEFAULT_GOALS, Z2_FRAC, Z4_FRAC, MERGE_GAP_MIN };
