// Apple Health export ingest: stream-parse the (large) export.xml out of a
// backup zip and materialize it as partitioned Parquet under store/, which
// DuckDB then queries. The XML is ~2GB for a decade of Watch data, so we never
// hold it in memory: we stream `unzip -p`, tokenize on '>' (Apple escapes '<'
// and '>' inside attribute values as &lt;/&gt;, so every literal '>' is a tag
// terminator), and write newline-delimited JSON that DuckDB bulk-loads.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { once } = require('events');
const { DuckDBInstance } = require('@duckdb/node-api');

const ROOT = path.join(__dirname, '..');
const STORE = path.join(ROOT, 'store', 'apple-health');
const TMP = path.join(STORE, '_tmp');
const RECORDS_GLOB = path.join(STORE, 'records', '**', '*.parquet');
const WORKOUTS_PARQUET = path.join(STORE, 'workouts.parquet');
const STATS_PARQUET = path.join(STORE, 'workout_stats.parquet');

const TS_FMT = '%Y-%m-%d %H:%M:%S %z'; // e.g. "2024-10-20 23:40:52 -0700"

// Shared progress state, polled by the UI via /api/health/ingest/status.
const healthState = {
  running: false,
  phase: 'idle', // idle | parsing | loading | views | done | error
  error: null,
  startedAt: null,
  records: 0,
  workouts: 0,
  stats: 0,
  result: null, // { records, workouts, dir, dateRange }
};

function unescapeXml(s) {
  if (s.indexOf('&') === -1) return s;
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // must be last
}

const ATTR_RE = /([\w:]+)="([^"]*)"/g;
function parseAttrs(tag) {
  const attrs = {};
  let m;
  ATTR_RE.lastIndex = 0;
  while ((m = ATTR_RE.exec(tag))) attrs[m[1]] = unescapeXml(m[2]);
  return attrs;
}

// Buffered NDJSON writer with backpressure via the caller awaiting flush().
function ndjsonWriter(file) {
  const stream = fs.createWriteStream(file);
  let buf = '';
  return {
    stream,
    write(obj) { buf += JSON.stringify(obj) + '\n'; },
    needsFlush() { return buf.length > 1 << 20; }, // 1MB
    async flush() {
      if (!buf) return;
      const chunk = buf; buf = '';
      if (!stream.write(chunk)) await once(stream, 'drain');
    },
    async end() { await this.flush(); stream.end(); await once(stream, 'finish'); },
  };
}

// Parse the XML stream into three NDJSON temp files. Returns counts.
async function parseXml(zipPath, onProgress) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const recW = ndjsonWriter(path.join(TMP, 'records.ndjson'));
  const wkW = ndjsonWriter(path.join(TMP, 'workouts.ndjson'));
  const stW = ndjsonWriter(path.join(TMP, 'workout_stats.ndjson'));

  const child = spawn('unzip', ['-p', zipPath, 'apple_health_export/export.xml']);
  child.stderr.resume();
  child.stdout.setEncoding('utf8'); // decode multibyte safely across chunk boundaries

  let counts = { records: 0, workouts: 0, stats: 0 };
  let workoutIdx = -1;
  let buf = '';

  const handleTag = (tag) => {
    // tag is '<Elem ... "' (open) or '<Elem ... /' (self-closed), no trailing '>'
    if (tag.startsWith('<Record')) {
      const a = parseAttrs(tag);
      recW.write({
        type: a.type ?? null, unit: a.unit ?? null, value: a.value ?? null,
        sourceName: a.sourceName ?? null, sourceVersion: a.sourceVersion ?? null,
        startDate: a.startDate ?? null, endDate: a.endDate ?? null,
        creationDate: a.creationDate ?? null,
      });
      counts.records++;
    } else if (tag.startsWith('<Workout ')) {
      workoutIdx++;
      const a = parseAttrs(tag);
      wkW.write({
        idx: workoutIdx, activityType: a.workoutActivityType ?? null,
        duration: a.duration ?? null, durationUnit: a.durationUnit ?? null,
        totalDistance: a.totalDistance ?? null, totalDistanceUnit: a.totalDistanceUnit ?? null,
        totalEnergyBurned: a.totalEnergyBurned ?? null, totalEnergyBurnedUnit: a.totalEnergyBurnedUnit ?? null,
        sourceName: a.sourceName ?? null, sourceVersion: a.sourceVersion ?? null,
        startDate: a.startDate ?? null, endDate: a.endDate ?? null, creationDate: a.creationDate ?? null,
      });
      counts.workouts++;
    } else if (tag.startsWith('<WorkoutStatistics')) {
      const a = parseAttrs(tag);
      stW.write({
        workout_idx: workoutIdx, type: a.type ?? null,
        average: a.average ?? null, minimum: a.minimum ?? null, maximum: a.maximum ?? null,
        sum: a.sum ?? null, unit: a.unit ?? null,
        startDate: a.startDate ?? null, endDate: a.endDate ?? null,
      });
      counts.stats++;
    }
    // WorkoutStatistics only ever appear inside a Workout (per the DTD), so the
    // running workoutIdx is always their parent — no close-tag reset needed,
    // and resetting would break idx uniqueness across workouts.
  };

  for await (const chunk of child.stdout) {
    buf += chunk;
    let gt;
    while ((gt = buf.indexOf('>')) !== -1) {
      const seg = buf.slice(0, gt);
      buf = buf.slice(gt + 1);
      const lt = seg.lastIndexOf('<');
      if (lt === -1) continue; // whitespace/text between tags
      handleTag(seg.slice(lt));
    }
    if (recW.needsFlush()) await recW.flush();
    if (wkW.needsFlush()) await wkW.flush();
    if (stW.needsFlush()) await stW.flush();
    onProgress(counts);
  }

  const [code] = await once(child, 'close');
  if (code !== 0) throw new Error(`unzip exited ${code} (is the export.xml present in the zip?)`);
  await recW.end(); await wkW.end(); await stW.end();
  return counts;
}

// Load the NDJSON temp files into partitioned Parquet under store/.
async function loadParquet(con) {
  fs.rmSync(path.join(STORE, 'records'), { recursive: true, force: true });
  const recSrc = path.join(TMP, 'records.ndjson');
  const wkSrc = path.join(TMP, 'workouts.ndjson');
  const stSrc = path.join(TMP, 'workout_stats.ndjson');

  await con.run(`COPY (
    SELECT
      type,
      unit,
      TRY_CAST(value AS DOUBLE) AS value,
      value AS value_raw,
      sourceName AS source,
      sourceVersion AS source_version,
      try_strptime(startDate, '${TS_FMT}') AS start_ts,
      try_strptime(endDate, '${TS_FMT}') AS end_ts,
      try_strptime(creationDate, '${TS_FMT}') AS creation_ts,
      -- Local wall-clock (naive TIMESTAMP, offset stripped): the time on the
      -- clock where the sample was recorded, so travel across timezones reads
      -- as the local hour instead of the server zone. start_ts stays the UTC
      -- instant for correct interval/dedup math.
      try_strptime(startDate[1:19], '%Y-%m-%d %H:%M:%S') AS start_local,
      try_strptime(endDate[1:19], '%Y-%m-%d %H:%M:%S') AS end_local,
      regexp_replace(type, '^HK[A-Za-z]*TypeIdentifier', '') AS metric,
      CAST(year(try_strptime(startDate, '${TS_FMT}')) AS INT) AS year
    FROM read_json_auto('${recSrc}', format='newline_delimited', maximum_object_size=10000000)
    WHERE startDate IS NOT NULL
  ) TO '${path.join(STORE, 'records')}'
    (FORMAT PARQUET, PARTITION_BY (metric, year), OVERWRITE_OR_IGNORE, COMPRESSION zstd)`);

  await con.run(`COPY (
    SELECT
      idx,
      regexp_replace(activityType, '^HKWorkoutActivityType', '') AS activity,
      TRY_CAST(duration AS DOUBLE) AS duration, durationUnit AS duration_unit,
      TRY_CAST(totalDistance AS DOUBLE) AS distance, totalDistanceUnit AS distance_unit,
      TRY_CAST(totalEnergyBurned AS DOUBLE) AS energy, totalEnergyBurnedUnit AS energy_unit,
      sourceName AS source, sourceVersion AS source_version,
      try_strptime(startDate, '${TS_FMT}') AS start_ts,
      try_strptime(endDate, '${TS_FMT}') AS end_ts,
      try_strptime(creationDate, '${TS_FMT}') AS creation_ts
    FROM read_json_auto('${wkSrc}', format='newline_delimited')
  ) TO '${WORKOUTS_PARQUET}' (FORMAT PARQUET, OVERWRITE_OR_IGNORE, COMPRESSION zstd)`);

  // Stats file may be empty (older exports carry totals on the Workout element).
  if (fs.existsSync(stSrc) && fs.statSync(stSrc).size > 0) {
    await con.run(`COPY (
      SELECT
        workout_idx,
        regexp_replace(type, '^HK[A-Za-z]*TypeIdentifier', '') AS metric,
        TRY_CAST(average AS DOUBLE) AS average, TRY_CAST(minimum AS DOUBLE) AS minimum,
        TRY_CAST(maximum AS DOUBLE) AS maximum, TRY_CAST(sum AS DOUBLE) AS sum, unit,
        try_strptime(startDate, '${TS_FMT}') AS start_ts,
        try_strptime(endDate, '${TS_FMT}') AS end_ts
      FROM read_json_auto('${stSrc}', format='newline_delimited')
    ) TO '${STATS_PARQUET}' (FORMAT PARQUET, OVERWRITE_OR_IGNORE, COMPRESSION zstd)`);
  }
}

// Define the query layer: raw views over Parquet + dedup/normalization on top.
// Idempotent; safe to call on server start whenever the store exists.
async function setupViews(con) {
  if (!fs.existsSync(path.join(STORE, 'records'))) return false;
  await con.run(`CREATE OR REPLACE VIEW ah_records AS
    SELECT * FROM read_parquet('${RECORDS_GLOB}', hive_partitioning=true)`);

  // Exact-duplicate removal: Apple stores the same sample from multiple sources
  // (iPhone + Watch + third-party apps). Keep one row per (type, interval, value).
  // Interval-overlap dedup for aggregates is a later refinement.
  await con.run(`CREATE OR REPLACE VIEW ah_records_dedup AS
    SELECT * EXCLUDE (rn) FROM (
      SELECT *, row_number() OVER (
        PARTITION BY type, start_ts, end_ts, value_raw ORDER BY source
      ) AS rn FROM ah_records
    ) WHERE rn = 1`);

  // Interval-overlap dedup: for the same metric+interval written by several
  // sources (iPhone + Watch + apps), keep a single canonical row so summed
  // aggregates (steps, energy, distance) aren't double-counted. Source
  // preference is by sample count — the device that logs a metric most often
  // is treated as its primary recorder.
  await con.run(`CREATE OR REPLACE VIEW ah_records_canonical AS
    WITH pref AS (
      SELECT type, source, count(*) AS n,
             row_number() OVER (PARTITION BY type ORDER BY count(*) DESC) AS src_rank
      FROM ah_records GROUP BY type, source
    )
    SELECT r.* EXCLUDE (rn) FROM (
      SELECT d.*, row_number() OVER (
        PARTITION BY d.type, d.start_ts, d.end_ts
        ORDER BY p.src_rank
      ) AS rn
      FROM ah_records_dedup d
      JOIN pref p ON p.type = d.type AND p.source = d.source
    ) r WHERE rn = 1`);

  await con.run(`CREATE OR REPLACE VIEW ah_daily AS
    SELECT metric, CAST(start_ts AS DATE) AS day,
           count(*) AS n, avg(value) AS avg, min(value) AS min,
           max(value) AS max, sum(value) AS sum
    FROM ah_records_canonical WHERE value IS NOT NULL
    GROUP BY ALL`);

  // Correct daily SUMS for additive activity metrics. Apple never sums steps/
  // energy from concurrent sources (iPhone + Watch record the same movement
  // over different sample boundaries, so ah_records_canonical — which only
  // merges identical intervals — still double-counts). Approximate Apple's
  // dedup by taking, for each hour, the single source that logged the most
  // (the fullest recorder), then summing hours. Matches the Health app closely.
  await con.run(`CREATE OR REPLACE VIEW ah_activity_daily AS
    WITH src_hour AS (
      SELECT metric, CAST(start_ts AS DATE) AS day, date_trunc('hour', start_ts) AS hr,
             source, sum(value) AS v
      FROM ah_records
      WHERE value IS NOT NULL AND metric IN (
        'StepCount','ActiveEnergyBurned','BasalEnergyBurned','FlightsClimbed',
        'DistanceWalkingRunning','AppleExerciseTime','AppleStandTime')
      GROUP BY 1, 2, 3, 4
    ),
    hour_best AS (
      SELECT metric, day, hr, max(v) AS hr_val FROM src_hour GROUP BY 1, 2, 3
    )
    SELECT metric, day, sum(hr_val) AS sum FROM hour_best GROUP BY 1, 2`);

  if (fs.existsSync(WORKOUTS_PARQUET)) {
    await con.run(`CREATE OR REPLACE VIEW ah_workouts AS
      SELECT * FROM read_parquet('${WORKOUTS_PARQUET}')`);
  }
  if (fs.existsSync(STATS_PARQUET)) {
    await con.run(`CREATE OR REPLACE VIEW ah_workout_stats AS
      SELECT * FROM read_parquet('${STATS_PARQUET}')`);
  }
  return true;
}

// Full ingest: parse → load → views → manifest. Mutates healthState for polling.
async function runHealthIngest(con, zipPath, backupDir) {
  Object.assign(healthState, {
    running: true, phase: 'parsing', error: null, startedAt: new Date().toISOString(),
    records: 0, workouts: 0, stats: 0, result: null,
  });
  try {
    const counts = await parseXml(zipPath, (c) => {
      healthState.records = c.records;
      healthState.workouts = c.workouts;
      healthState.stats = c.stats;
    });

    healthState.phase = 'loading';
    await loadParquet(con);

    healthState.phase = 'views';
    await setupViews(con);

    const rangeReader = await con.runAndReadAll(
      `SELECT min(start_ts)::VARCHAR AS from_ts, max(start_ts)::VARCHAR AS to_ts,
              count(*) AS n FROM ah_records`);
    const range = rangeReader.getRowObjects()[0] || {};

    const result = {
      records: counts.records, workouts: counts.workouts, stats: counts.stats,
      dir: STORE, dateRange: { from: range.from_ts, to: range.to_ts },
    };
    // Manifest in the backup dir so listBackups() surfaces it in "Previous imports".
    fs.writeFileSync(path.join(backupDir, 'manifest.json'), JSON.stringify({
      createdAt: healthState.startedAt,
      source: 'apple-health',
      counts: { workouts: counts.workouts, samples: counts.records, stats: counts.stats },
      note: `Ingested to partitioned Parquet under store/apple-health/. ${counts.records.toLocaleString()} records across metric/year partitions. Timestamps are TIMESTAMPTZ. Dedup + daily rollups exposed as ah_records_dedup / ah_daily views.`,
    }, null, 2));

    fs.rmSync(TMP, { recursive: true, force: true });
    healthState.result = result;
    healthState.phase = 'done';
    return result;
  } catch (err) {
    healthState.phase = 'error';
    healthState.error = err.message;
    throw err;
  } finally {
    healthState.running = false;
  }
}

module.exports = { healthState, runHealthIngest, setupViews, STORE };
