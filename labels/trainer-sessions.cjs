// Personal-training session roll-up from Apple Health. Trainer sessions are
// strength-focused and ~1 hour; across eras Apple logged them under different
// activity types (2017-19 as "Other", 2025-26 as FunctionalStrengthTraining),
// often double-recording one session as both an FST and an "Other" of equal
// length. We reconcile those into one session per day, then classify:
//   confirmed  — day is in the hand-labeled ground truth (labels/trainer-sessions.json)
//   inferred   — not labeled, but a strength/"Other" workout >= MIN_MIN that day
//   (a confirmed day with no qualifying workout is still a session, hasWorkout=false)
const CANDIDATE_ACTIVITIES = ['FunctionalStrengthTraining', 'TraditionalStrengthTraining', 'Other'];
const MIN_MIN = 40;   // hour-long sessions land ~40-70min once warmup/setup is trimmed
const HR_FLOOR = 30;
// Preference when a day has several candidate workouts (real strength beats the
// generic auto-detected "Other"); higher wins, then longer duration.
const ACT_RANK = { FunctionalStrengthTraining: 3, TraditionalStrengthTraining: 2, Other: 1 };

const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();

async function computeTrainerSessions(con, { labels = [] } = {}) {
  const labelByDate = new Map(labels.map(l => [l.date, !!l.partner]));
  const actList = CANDIDATE_ACTIVITIES.map(a => `'${a}'`).join(', ');

  // One row per candidate workout with HR aggregates and workout energy.
  const wl = await rows(con, `
    WITH cand AS (
      SELECT idx, start_ts, end_ts, CAST(start_ts AS DATE)::VARCHAR AS date,
             start_ts::VARCHAR AS start, dayname(start_ts) AS dow,
             activity, duration, source
      FROM ah_workouts WHERE activity IN (${actList})
    ),
    en AS (
      SELECT workout_idx AS idx,
             max(CASE WHEN metric = 'ActiveEnergyBurned' THEN sum END) AS energy
      FROM ah_workout_stats GROUP BY 1
    ),
    hr AS (
      SELECT c.idx,
             avg(CASE WHEN r.value >= ${HR_FLOOR} THEN r.value END) AS avg_hr,
             max(CASE WHEN r.value >= ${HR_FLOOR} THEN r.value END) AS max_hr,
             count(CASE WHEN r.value >= ${HR_FLOOR} THEN 1 END) AS hr_n
      FROM cand c JOIN ah_records r
        ON r.metric = 'HeartRate' AND r.start_ts BETWEEN c.start_ts AND c.end_ts
      GROUP BY c.idx
    )
    SELECT c.idx, c.date, c.start, c.dow, c.activity, c.duration, c.source,
           hr.avg_hr, hr.max_hr, hr.hr_n, en.energy
    FROM cand c LEFT JOIN hr ON hr.idx = c.idx LEFT JOIN en ON en.idx = c.idx
    ORDER BY c.start`);

  // Collapse to the primary workout per day (highest-ranked activity, longest).
  const byDate = new Map();
  for (const w of wl) {
    const cur = byDate.get(w.date);
    const better = !cur
      || ACT_RANK[w.activity] > ACT_RANK[cur.activity]
      || (ACT_RANK[w.activity] === ACT_RANK[cur.activity] && Number(w.duration) > Number(cur.duration));
    if (better) byDate.set(w.date, w);
  }

  // Session dates = every labeled day ∪ every day with a qualifying workout.
  const dates = new Set(labelByDate.keys());
  for (const [date, w] of byDate) if (Number(w.duration) >= MIN_MIN) dates.add(date);

  const sessions = [];
  for (const date of dates) {
    const labeled = labelByDate.has(date);
    const w = byDate.get(date) || null;
    // An unlabeled day only counts if its workout clears the hour-long bar.
    if (!labeled && (!w || Number(w.duration) < MIN_MIN)) continue;
    sessions.push({
      date,
      dow: (w && w.dow) || new Date(date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' }),
      year: Number(date.slice(0, 4)),
      source: labeled ? 'confirmed' : 'inferred',
      partner: labeled ? labelByDate.get(date) : null,
      hasWorkout: !!w,
      idx: w ? Number(w.idx) : null,
      activity: w ? w.activity : null,
      duration: w && w.duration != null ? Number(w.duration) : null,
      avgHr: w && w.avg_hr != null ? Math.round(Number(w.avg_hr)) : null,
      maxHr: w && w.max_hr != null ? Math.round(Number(w.max_hr)) : null,
      energy: w && w.energy != null ? Math.round(Number(w.energy)) : null,
    });
  }
  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const withM = sessions.filter(s => s.hasWorkout);
  const durs = withM.map(s => s.duration).filter(v => v != null);
  const hrs = withM.map(s => s.avgHr).filter(v => v != null);
  const mean = a => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : null);
  const byYear = {};
  for (const s of sessions) (byYear[s.year] ??= { total: 0, confirmed: 0, inferred: 0 }),
    byYear[s.year].total++, byYear[s.year][s.source]++;

  const summary = {
    total: sessions.length,
    confirmed: sessions.filter(s => s.source === 'confirmed').length,
    inferred: sessions.filter(s => s.source === 'inferred').length,
    labelOnly: sessions.filter(s => s.source === 'confirmed' && !s.hasWorkout).length,
    partner: sessions.filter(s => s.partner).length,
    withMetrics: withM.length,
    avgDurationMin: durs.length ? +mean(durs).toFixed(0) : null,
    avgHr: hrs.length ? +mean(hrs).toFixed(0) : null,
    firstDate: sessions.length ? sessions[0].date : null,
    lastDate: sessions.length ? sessions[sessions.length - 1].date : null,
    byYear,
  };

  return { sessions, summary, minMinutes: MIN_MIN };
}

module.exports = { computeTrainerSessions, CANDIDATE_ACTIVITIES, MIN_MIN };
