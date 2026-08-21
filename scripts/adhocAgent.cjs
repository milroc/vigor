// Ad-hoc analysis agent: turns a natural-language request into ONE read-only
// DuckDB query over the parquet store, runs it, and returns plan + SQL + result.
// The parquet views are the "semantic layer" that grounds the model; the
// generated SQL is shown to the user and must be accepted before anything is
// saved. LLM access reuses the same headless `claude` CLI as /api/chat.
const { execFile } = require('child_process');

const READ_ONLY = /^\s*(SELECT|WITH|DESCRIBE|SUMMARIZE|EXPLAIN|PRAGMA|SHOW|VALUES|FROM)\b/i;
const rows = async (con, sql) => (await con.runAndReadAll(sql)).getRowObjectsJson();

const SCHEMA_DOC = `Parquet-backed DuckDB views (personal Apple Health store):
- ah_workouts(idx, activity, duration /*minutes*/, distance, energy, source, start_ts, end_ts)
- ah_records_canonical(metric, value, unit, source, start_ts, end_ts) -- deduped point/interval readings, ONE row per reading
- ah_activity_daily(metric, day /*DATE*/, sum) -- deduped daily totals for additive metrics
- ah_workout_stats(workout_idx, metric, sum, avg, min, max) -- per-workout aggregates
Guidance:
- Timestamps are TIMESTAMPTZ. Use date_part('year', start_ts), date_trunc, dayofweek(ts) (0=Sun..6=Sat).
- Body/cardio metrics live in ah_records_canonical (e.g. BodyMass in lb, BodyFatPercentage as a 0-1 fraction, RestingHeartRate, HeartRateVariabilitySDNN, VO2Max, WalkingHeartRateAverage, HeartRate).
- For steps / energy / distance / flights use ah_activity_daily (metrics StepCount, ActiveEnergyBurned, BasalEnergyBurned, FlightsClimbed, DistanceWalkingRunning, AppleExerciseTime, AppleStandTime) — it is already deduped, so never sum raw records for these.
- Workout activities include Walking, Cycling, FunctionalStrengthTraining, Other, Yoga, Hiking.`;

async function buildSchema(con) {
  let metrics = [];
  try { metrics = (await rows(con, `SELECT DISTINCT metric FROM ah_records_canonical ORDER BY 1`)).map(r => r.metric); } catch { /* pre-ingest */ }
  return `${SCHEMA_DOC}\nAll metrics in ah_records_canonical: ${metrics.join(', ')}`;
}

function callClaude(prompt, model = 'sonnet') {
  return new Promise((resolve, reject) => {
    execFile('claude', ['-p', prompt, '--model', model], { timeout: 90_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message || 'agent failed').trim().slice(0, 300)));
      resolve(stdout.trim());
    });
  });
}

function extractJson(text) {
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) t = t.slice(s, e + 1);
  return JSON.parse(t);
}

// A generated query must be a single read-only statement.
function sanitizeSql(raw) {
  const sql = String(raw || '').trim().replace(/;+\s*$/, '');
  if (!sql) throw new Error('agent produced an empty query');
  if (sql.includes(';')) throw new Error('only a single statement is allowed');
  if (!READ_ONLY.test(sql)) throw new Error('agent produced a non-read-only query');
  return sql;
}

async function runAgent(con, { messages = [], model } = {}) {
  const schema = await buildSchema(con);
  const convo = messages.map(m => `${m.role === 'assistant' ? 'Agent' : 'User'}: ${m.text}`).join('\n');
  const prompt = [
    'You are a data-analyst agent inside VIGOR, working over a personal Apple Health DuckDB store.',
    'Write ONE read-only DuckDB SQL query that answers the latest user request, plus a short plan.',
    'RULES:',
    '- Read-only only (SELECT / WITH). Never mutate. A single statement, no semicolons.',
    '- Use only the views/columns below; metric strings must match EXACTLY.',
    '- Aggregate — keep the result small and legible. Add LIMIT 200 for any row-level output.',
    '- Round aggregates sensibly and alias columns to human-readable names.',
    '- When the result is a trend or comparison that reads better as a chart (or the user asks for one), also return a "viz" spec: {"type":"line"|"bar","x":"<column alias>","y":["<numeric column alias>", ...]}. For a time trend order by the x column and use type "line". Omit "viz" when a table is best.',
    '',
    schema,
    '',
    'Conversation so far:',
    convo,
    '',
    'Reply with ONLY a JSON object, no prose or code fences:',
    '{"title": "<=6 word label", "plan": ["step", "..."], "sql": "the query", "explanation": "one sentence on what it shows", "viz": {"type":"line","x":"month","y":["value"]} }',
    '(omit "viz" entirely if a table is best.)',
  ].join('\n');

  const raw = await callClaude(prompt, model);
  let parsed;
  try { parsed = extractJson(raw); } catch { throw new Error('agent returned unparseable output'); }

  const sql = sanitizeSql(parsed.sql);
  const result = await rows(con, sql);
  const columns = result.length ? Object.keys(result[0]) : [];

  // Keep a viz spec only if it references real output columns.
  let viz = null;
  const v = parsed.viz;
  if (v && (v.type === 'line' || v.type === 'bar')) {
    const x = String(v.x || '');
    const y = (Array.isArray(v.y) ? v.y : []).map(String).filter(c => columns.includes(c));
    if (columns.includes(x) && y.length) viz = { type: v.type, x, y };
  }

  return {
    title: String(parsed.title || 'Analysis').slice(0, 80),
    plan: Array.isArray(parsed.plan) ? parsed.plan.map(String).slice(0, 6) : [],
    explanation: String(parsed.explanation || '').slice(0, 400),
    sql,
    columns,
    rows: result.slice(0, 200).map(r => columns.map(c => r[c])),
    rowCount: result.length,
    viz,
  };
}

module.exports = { runAgent, buildSchema, sanitizeSql };
