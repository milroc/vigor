// Cross-era comparison of Apple Health signals, built entirely on the parquet
// store views (ah_records_canonical for point readings, ah_activity_daily for
// deduped daily NEAT, ah_workouts for the workout mix). Given date windows it
// returns per-era body composition, cardio-fitness markers, daily activity, and
// workout mix, plus deltas vs the first era. The windows themselves are personal
// (which years you did what), so they live in gitignored labels/eras.json — this
// module carries none. Pass any windows you want, or let it load the config.
const fs = require('fs');
const path = require('path');

const CONFIG_FILE = path.join(__dirname, '..', 'labels', 'eras.json');

// Personal era windows + caveats, hand-maintained in labels/eras.json (see
// labels/eras.example.json for the shape). Missing/corrupt → empty config, and
// the analysis degrades to a "configure me" message rather than throwing.
function loadEraConfig() {
  try {
    const c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    return { eras: Array.isArray(c.eras) ? c.eras : [], notes: Array.isArray(c.notes) ? c.notes : [], summary: c.summary || '' };
  } catch {
    return { eras: [], notes: [], summary: '' };
  }
}

// Point-in-time markers, averaged per era. `dir` labels a delta: +1 = higher is
// fitter/better, -1 = lower is better, 0 = context only (no good/bad).
const MARKERS = [
  { key: 'restingHr', metric: 'RestingHeartRate', label: 'Resting HR', unit: 'bpm', dir: -1, round: 1 },
  { key: 'walkingHr', metric: 'WalkingHeartRateAverage', label: 'Walking HR', unit: 'bpm', dir: -1, round: 1 },
  { key: 'hrvSdnn', metric: 'HeartRateVariabilitySDNN', label: 'HRV (SDNN)', unit: 'ms', dir: 1, round: 1 },
  { key: 'vo2max', metric: 'VO2Max', label: 'VO₂max (Apple)', unit: 'ml/kg/min', dir: 1, round: 1 },
  { key: 'bodyMass', metric: 'BodyMass', label: 'Body mass', unit: 'lb', dir: 0, round: 1 },
  { key: 'bodyFat', metric: 'BodyFatPercentage', label: 'Body fat', unit: '%', dir: -1, round: 1, scale: 100 },
];

// Daily activity (NEAT) from the deduped daily view — averaged over tracked days.
const DAILY = [
  { key: 'steps', metric: 'StepCount', label: 'Steps', unit: '', dir: 1, round: 0 },
  { key: 'activeEnergy', metric: 'ActiveEnergyBurned', label: 'Active energy', unit: 'kcal', dir: 1, round: 0 },
  { key: 'basalEnergy', metric: 'BasalEnergyBurned', label: 'Basal energy', unit: 'kcal', dir: 0, round: 0 },
  { key: 'flights', metric: 'FlightsClimbed', label: 'Flights', unit: '', dir: 1, round: 1 },
  { key: 'distance', metric: 'DistanceWalkingRunning', label: 'Walk/run distance', unit: 'mi', dir: 1, round: 2 },
  { key: 'exerciseMin', metric: 'AppleExerciseTime', label: 'Exercise time', unit: 'min', dir: 1, round: 0 },
];

const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();
const lit = d => `DATE '${d}'`;
const num = v => (v == null ? null : Number(v));

function delta(from, to, dir, round) {
  if (from == null || to == null) return null;
  const abs = +(to - from).toFixed(round);
  const pct = from !== 0 ? +(((to - from) / Math.abs(from)) * 100).toFixed(1) : null;
  const better = dir === 0 ? null : (Math.sign(to - from) === Math.sign(dir));
  return { abs, pct, better };
}

async function computeEras(con, opts = {}) {
  const cfg = loadEraConfig();
  const eras = opts.eras || cfg.eras;
  // No personal era windows configured — return an empty result the caller can
  // render as a "configure labels/eras.json" prompt.
  if (!eras.length) {
    return { eras: [], deltas: [], markerDefs: MARKERS, dailyDefs: DAILY, notes: cfg.notes, summary: cfg.summary };
  }
  // Per-era FILTER fragment over a date column `d`.
  const filt = (e, expr) => `${expr} FILTER (WHERE d BETWEEN ${lit(e.from)} AND ${lit(e.to)})`;

  // 1) Point markers from the deduped record view.
  const markerCols = eras.flatMap((e, i) => MARKERS.map(m => {
    const val = m.scale ? `value * ${m.scale}` : 'value';
    return `round(avg(CASE WHEN metric = '${m.metric}' THEN ${val} END) ${filt(e, '')}, ${m.round}) AS ${m.key}_e${i}_avg,
            count(CASE WHEN metric = '${m.metric}' THEN 1 END) ${filt(e, '')} AS ${m.key}_e${i}_n`;
  }));
  const metricList = MARKERS.map(m => `'${m.metric}'`).join(', ');
  const markerRow = (await rows(con, `
    SELECT ${markerCols.join(',\n')}
    FROM (SELECT metric, value, CAST(start_ts AS DATE) AS d
          FROM ah_records_canonical WHERE value IS NOT NULL AND metric IN (${metricList}))`))[0] || {};

  // 2) Daily activity / NEAT from the deduped daily view.
  const dailyCols = eras.flatMap((e, i) => DAILY.map(m =>
    `round(avg(CASE WHEN metric = '${m.metric}' THEN sum END) ${filt(e, '')}, ${m.round}) AS ${m.key}_e${i}_avg,
     count(CASE WHEN metric = '${m.metric}' THEN 1 END) ${filt(e, '')} AS ${m.key}_e${i}_n`));
  const dailyList = DAILY.map(m => `'${m.metric}'`).join(', ');
  const dailyRow = (await rows(con, `
    SELECT ${dailyCols.join(',\n')}
    FROM (SELECT metric, sum, day AS d FROM ah_activity_daily WHERE metric IN (${dailyList}))`))[0] || {};

  // 3) Workout mix per era.
  const built = [];
  for (const e of eras) {
    const where = `CAST(start_ts AS DATE) BETWEEN ${lit(e.from)} AND ${lit(e.to)}`;
    const mix = await rows(con, `
      SELECT activity, count(*) AS n, round(sum(duration), 0) AS total_min, round(avg(duration), 0) AS avg_min
      FROM ah_workouts WHERE ${where} GROUP BY activity ORDER BY sum(duration) DESC`);
    const tot = (await rows(con, `
      SELECT count(*) AS n, round(sum(duration) / 60, 1) AS hrs, count(DISTINCT CAST(start_ts AS DATE)) AS days
      FROM ah_workouts WHERE ${where}`))[0] || { n: 0, hrs: 0, days: 0 };

    const markers = {}, neat = {};
    MARKERS.forEach(m => {
      const i = eras.indexOf(e);
      markers[m.key] = { label: m.label, unit: m.unit, dir: m.dir,
        avg: num(markerRow[`${m.key}_e${i}_avg`]), n: Number(markerRow[`${m.key}_e${i}_n`] || 0) };
    });
    DAILY.forEach(m => {
      const i = eras.indexOf(e);
      neat[m.key] = { label: m.label, unit: m.unit, dir: m.dir,
        avg: num(dailyRow[`${m.key}_e${i}_avg`]), days: Number(dailyRow[`${m.key}_e${i}_n`] || 0) };
    });
    built.push({
      key: e.key, label: e.label, from: e.from, to: e.to,
      markers, neat,
      workouts: {
        count: Number(tot.n), hours: num(tot.hrs), activeDays: Number(tot.days),
        byActivity: mix.map(r => ({ activity: r.activity, n: Number(r.n), totalMin: Number(r.total_min), avgMin: Number(r.avg_min) })),
      },
    });
  }

  // 4) Deltas vs the first era.
  const base = built[0];
  const deltas = built.slice(1).map(e => {
    const mk = {}, nt = {};
    MARKERS.forEach(m => { mk[m.key] = delta(base.markers[m.key].avg, e.markers[m.key].avg, m.dir, m.round); });
    DAILY.forEach(m => { nt[m.key] = delta(base.neat[m.key].avg, e.neat[m.key].avg, m.dir, m.round); });
    return { key: e.key, label: e.label, vs: base.key, markers: mk, neat: nt };
  });

  return { eras: built, deltas, markerDefs: MARKERS, dailyDefs: DAILY, notes: cfg.notes, summary: cfg.summary };
}

module.exports = { computeEras, loadEraConfig, MARKERS, DAILY };
