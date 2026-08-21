// Sleep roll-up from Apple Health, one record per night plus a separate nap list.
// A "night" is the noon-to-noon window ending on the wake date (start + 12h),
// so an 11pm-7am sleep is filed under the morning you woke.
//
// Source: Apple Watch is preferred whenever it recorded any sleep that night;
// iPhone/Withings are used only as a fallback when the Watch has nothing. The
// chosen source is reported per night.
//
// Timezone: night attribution and clock positions use start_local/end_local —
// the local wall-clock captured at ingest — so travel reads as the local hour.
// Durations and session gaps use the UTC instant (start_ts).
//
// Segments cluster into sessions on gaps > NAP_GAP; the largest asleep session
// is the main night, the rest are naps. Clock positions are anchored minutes-
// after-6pm (0 = 6pm, 360 = midnight, 720 = 6am, 1080 = noon).
const fs = require('fs');
const path = require('path');

const NAP_GAP = 3600;   // seconds of no sleep that split one session from the next
const NAP_MIN = 20;     // a non-main session under this many asleep-minutes is noise
const MAIN_MIN = 120;   // a day whose biggest session is under this has no real night
const BRIEF_WAKE = 10;  // awake blips shorter than this (min) count as sleep, not wake
const TIB_CAP = 120;    // clamp implausible time-in-bed padding (min)

const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();

const wallMin = ts => { const m = /\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(ts); return m ? (+m[1]) * 60 + (+m[2]) : null; };
const anchor = w => ((w - 1080) % 1440 + 1440) % 1440;
const shortStage = st => st === 'AsleepREM' ? 'rem' : st === 'AsleepDeep' ? 'deep'
  : st === 'Awake' ? 'awake' : st === 'InBed' ? 'inbed' : 'core';

// Manual sleep goals (labels/sleep-targets.json): asleep hours, bed & wake clock.
function readSleepTargets() {
  // deepMin/deepMax: healthy deep-sleep range (13–23% of total ≈ 60–110 min/night).
  const def = { asleepHours: 7, bedtime: '01:00', wake: '08:00', deepMin: 60, deepMax: 110 };
  let t = def;
  try { t = { ...def, ...JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'labels', 'sleep-targets.json'), 'utf8')) }; } catch { /* use defaults */ }
  const toAnchor = hm => { const [h, m] = String(hm).split(':').map(Number); return anchor(h * 60 + (m || 0)); };
  return { asleepHours: t.asleepHours, bedtime: t.bedtime, wake: t.wake,
    asleepMin: Math.round(t.asleepHours * 60), bedMin: toAnchor(t.bedtime), wakeMin: toAnchor(t.wake),
    deepMin: t.deepMin, deepMax: t.deepMax };
}

async function computeSleep(con) {
  // Sleep segments per night from the preferred source (Watch first, else the
  // source with the most asleep time), including InBed rows for time-in-bed.
  const seg = await rows(con, `
    WITH sleep AS (
      SELECT CAST(start_local + INTERVAL 12 HOUR AS DATE) AS night, source,
             replace(value_raw, 'HKCategoryValueSleepAnalysis', '') AS stage,
             start_ts, end_ts, start_local, end_local,
             date_diff('second', start_ts, end_ts) / 60.0 AS mins
      FROM ah_records WHERE metric = 'SleepAnalysis' AND end_ts > start_ts
    ),
    ranked AS (
      SELECT night, source, row_number() OVER (
        PARTITION BY night
        ORDER BY (lower(source) LIKE '%watch%') DESC,
                 sum(mins) FILTER (WHERE stage LIKE 'Asleep%') DESC NULLS LAST) AS rn
      FROM sleep GROUP BY night, source
    ),
    best AS (SELECT night, source FROM ranked WHERE rn = 1)
    SELECT s.night::VARCHAR AS night, b.source AS src, s.stage,
           epoch(s.start_ts)::BIGINT AS se, epoch(s.end_ts)::BIGINT AS ee,
           s.start_local::VARCHAR AS s0, s.end_local::VARCHAR AS e0
    FROM sleep s JOIN best b ON b.night = s.night AND b.source = s.source
    ORDER BY s.night, s.start_ts`);

  const resp = await rows(con, `
    SELECT CAST(start_local + INTERVAL 12 HOUR AS DATE)::VARCHAR AS night,
           round(avg(value) FILTER (WHERE metric = 'RespiratoryRate'), 2) AS resp_avg,
           round(min(value) FILTER (WHERE metric = 'RespiratoryRate'), 2) AS resp_min,
           round(max(value) FILTER (WHERE metric = 'RespiratoryRate'), 2) AS resp_max,
           round(avg(value) FILTER (WHERE metric = 'OxygenSaturation') * 100, 1) AS spo2_avg,
           round(avg(value) FILTER (WHERE metric = 'AppleSleepingBreathingDisturbances') * 100, 2) AS dist_avg
    FROM ah_records WHERE value IS NOT NULL
      AND metric IN ('RespiratoryRate', 'OxygenSaturation', 'AppleSleepingBreathingDisturbances')
    GROUP BY 1`);
  const respBy = new Map(resp.map(r => [r.night, r]));

  const byNight = new Map();
  for (const r of seg) { if (!byNight.has(r.night)) byNight.set(r.night, []); byNight.get(r.night).push(r); }

  const nights = [], naps = [];
  for (const [day, allSegs] of byNight) {
    const src = allSegs[0].src;
    const bedRows = allSegs.filter(x => x.stage === 'InBed');
    const segs = allSegs.filter(x => x.stage !== 'InBed').sort((a, b) => Number(a.se) - Number(b.se));
    if (!segs.length) continue;

    const sessions = []; let curS = [];
    for (const g of segs) {
      if (curS.length && Number(g.se) - Number(curS[curS.length - 1].ee) > NAP_GAP) { sessions.push(curS); curS = []; }
      curS.push(g);
    }
    if (curS.length) sessions.push(curS);
    const asleepOf = ss => ss.filter(x => x.stage !== 'Awake').reduce((t, x) => t + (Number(x.ee) - Number(x.se)) / 60, 0);
    sessions.forEach(ss => { ss._asleep = asleepOf(ss); });
    const main = sessions.reduce((a, b) => b._asleep > a._asleep ? b : a, sessions[0]);
    if (main._asleep < MAIN_MIN) continue;

    for (const ss of sessions) {
      if (ss === main || ss._asleep < NAP_MIN) continue;
      const s0 = ss[0], e0 = ss[ss.length - 1];
      naps.push({ day, startWall: wallMin(s0.s0), dur: Math.round((Number(e0.ee) - Number(s0.se)) / 60), asleep: Math.round(ss._asleep) });
    }

    const aSegs = main.map(g => {
      let a = anchor(wallMin(g.s0)), b = anchor(wallMin(g.e0));
      if (b < a) b += 1440;
      return { st: shortStage(g.stage), a, b, d: (Number(g.ee) - Number(g.se)) / 60 };
    }).filter(x => x.b - x.a > 0 && x.b - x.a < 720).sort((a, b) => a.a - b.a);
    if (!aSegs.length) continue;

    const dur = k => aSegs.filter(x => x.st === k).reduce((t, x) => t + x.d, 0);
    const rem = Math.round(dur('rem')), deep = Math.round(dur('deep')), core = Math.round(dur('core')), awake = Math.round(dur('awake'));
    const asleep = rem + deep + core;
    const briefAwake = aSegs.filter(x => x.st === 'awake' && x.d < BRIEF_WAKE).reduce((t, x) => t + x.d, 0);
    const asleepEff = Math.round(asleep + briefAwake);
    const briefWakes = aSegs.filter(x => x.st === 'awake' && x.d < BRIEF_WAKE).length;
    const fullWakes = aSegs.filter(x => x.st === 'awake' && x.d >= BRIEF_WAKE);
    const wakeCount = fullWakes.length;
    // Minutes spent in full (>= BRIEF_WAKE) awakenings — summed from the same
    // segments as wakeCount so the two never disagree (avoids rounding drift).
    const fullWakeMin = Math.round(fullWakes.reduce((t, x) => t + x.d, 0));

    const sleepStart = Math.min(...aSegs.map(x => x.a)), sleepEnd = Math.max(...aSegs.map(x => x.b));
    // Time in bed (before sleep onset / after final wake) from InBed segments.
    let tibBefore = 0, tibAfter = 0;
    if (bedRows.length) {
      const ib = bedRows.map(r => { let a = anchor(wallMin(r.s0)), b = anchor(wallMin(r.e0)); if (b < a) b += 1440; return { a, b }; });
      const ibStart = Math.min(...ib.map(x => x.a)), ibEnd = Math.max(...ib.map(x => x.b));
      tibBefore = Math.min(Math.max(0, Math.round(sleepStart - ibStart)), TIB_CAP);
      tibAfter = Math.min(Math.max(0, Math.round(ibEnd - sleepEnd)), TIB_CAP);
    }

    const R = respBy.get(day) || {};
    nights.push({
      day, source: src, bed: sleepStart, wake: sleepEnd,
      rem, deep, core, awake, asleep, asleepEff, briefWakes, wakeCount, fullWakeMin, tibBefore, tibAfter,
      eff: asleep + awake > 0 ? Math.round(1000 * asleep / (asleep + awake)) / 10 : null,
      segs: aSegs.map(({ st, a, b }) => ({ st, a, b })),
      resp: R.resp_avg ?? null, respMin: R.resp_min ?? null, respMax: R.resp_max ?? null,
      spo2: R.spo2_avg ?? null, dist: R.dist_avg ?? null,
    });
  }
  nights.sort((a, b) => a.day < b.day ? -1 : 1);
  naps.sort((a, b) => a.day < b.day ? -1 : 1);
  return { nights, naps, targets: readSleepTargets() };
}

// Per-night distribution (box-plot: min / Q1 / median / Q3 / max) of each vital
// over that night's in-bed window, plus daily training load for correlations.
async function computeSleepSeries(con) {
  const winCTE = `WITH win AS (
    SELECT CAST(start_local + INTERVAL 12 HOUR AS DATE) night, min(start_ts) w0, max(end_ts) w1
    FROM ah_records WHERE metric = 'SleepAnalysis' AND value_raw <> 'HKCategoryValueSleepAnalysisInBed'
    GROUP BY 1)`;
  const box = (metric, mul = '', filter = '') => rows(con, `${winCTE}
    SELECT w.night::VARCHAR AS night,
      round(min(r.value)${mul}, 1) AS lo, round(quantile_cont(r.value, 0.25)${mul}, 1) AS q1,
      round(quantile_cont(r.value, 0.5)${mul}, 1) AS med, round(quantile_cont(r.value, 0.75)${mul}, 1) AS q3,
      round(max(r.value)${mul}, 1) AS hi, count(*) AS n
    FROM ah_records r JOIN win w ON r.start_ts BETWEEN w.w0 AND w.w1
    WHERE r.metric = '${metric}'${filter}
    GROUP BY 1 HAVING count(*) >= 3 ORDER BY 1`);
  const [hr, hrv, resp, spo2] = await Promise.all([
    box('HeartRate', '', ' AND r.value >= 30'),
    box('HeartRateVariabilitySDNN'),
    box('RespiratoryRate'),
    box('OxygenSaturation', ' * 100'),
  ]);
  const load = await rows(con, `
    SELECT day::VARCHAR AS day, round(sum) AS kcal
    FROM ah_activity_daily WHERE metric = 'ActiveEnergyBurned' AND sum IS NOT NULL ORDER BY 1`);
  // Resting HR: one value per calendar day (Apple's daily at-rest estimate).
  const rhr = await rows(con, `
    SELECT CAST(start_local AS DATE)::VARCHAR AS day, round(avg(value)) AS bpm
    FROM ah_records WHERE metric = 'RestingHeartRate' AND value IS NOT NULL GROUP BY 1 ORDER BY 1`);
  // Time in daylight: many small buckets per day — sum to a daily total (minutes).
  const daylight = await rows(con, `
    SELECT CAST(start_local AS DATE)::VARCHAR AS day, round(sum(value)) AS min
    FROM ah_records WHERE metric = 'TimeInDaylight' AND value IS NOT NULL GROUP BY 1 ORDER BY 1`);
  return { hr, hrv, resp, spo2, load, rhr, daylight };
}

// Intraday samples for one night, anchored to the same minutes-after-6pm axis
// as the hypnogram, restricted to that night's in-bed window.
async function computeNight(con, date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('bad date');
  const D = `DATE '${date}'`;
  const anchored = "CAST(((date_part('hour', r.start_local) * 60 + date_part('minute', r.start_local) - 1080) % 1440 + 1440) % 1440 AS INT)";
  const win = `(SELECT min(start_ts) w0, max(end_ts) w1 FROM ah_records
    WHERE metric = 'SleepAnalysis' AND CAST(start_local + INTERVAL 12 HOUR AS DATE) = ${D}
      AND value_raw <> 'HKCategoryValueSleepAnalysisInBed')`;
  const series = (metric, extra, filter = '') => rows(con, `
    SELECT ${anchored} AS t, round(avg(value)${extra}) AS v
    FROM ah_records r, ${win} win
    WHERE r.metric = '${metric}' AND r.start_ts BETWEEN win.w0 AND win.w1${filter}
    GROUP BY 1 ORDER BY 1`);
  const [hr, resp, spo2, hrv] = await Promise.all([
    series('HeartRate', '', ' AND value >= 30'),
    series('RespiratoryRate', ', 1'),
    series('OxygenSaturation', ' * 100'),
    series('HeartRateVariabilitySDNN', ''),
  ]);
  return { hr, resp, spo2, hrv };
}

module.exports = { computeSleep, computeNight, computeSleepSeries, readSleepTargets };
