#!/usr/bin/env node
// Month-over-month cardiovascular fitness trends from Peloton backups.
//
//   node scripts/peloton-cardio.mjs [--title "20 min Beginner Ride"] [--discipline cycling] [--user name]
//
// Efficiency Factor (EF) = steady-state avg output / avg heart rate (W per bpm).
// More power at the same heart rate over time = improving aerobic fitness.
// Decoupling = % EF fade from first half to second half (endurance; lower is better).
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const opt = name => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : null;
};
const TITLE = opt('title') ?? '20 min Beginner Ride';
const DISCIPLINE = opt('discipline') ?? 'cycling';
const USER = opt('user');
const WARMUP_SECS = 120;

const root = path.join(import.meta.dirname, '..', 'backups');

function fromCsv(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c !== '"') field += c;
      else if (text[i + 1] === '"') { field += '"'; i++; }
      else inQ = false;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') {
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  const [header, ...data] = rows;
  return data.map(r => Object.fromEntries(header.map((name, i) => {
    let v = r[i] ?? '';
    // ID columns stay strings: an all-digit hex Peloton id must not be
    // mangled into float notation.
    if (v !== '' && !/id$/i.test(name) && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    return [name, v === '' ? null : v];
  })));
}

// Newest peloton backup dir (optionally for a specific user).
if (!fs.existsSync(root)) {
  console.error('no backups/ directory — run a backup from the Backup tab first');
  process.exit(1);
}
const dirs = fs.readdirSync(root)
  .filter(n => n.includes('-peloton-') && (!USER || n.endsWith(`-${USER}`)))
  .filter(n => fs.existsSync(path.join(root, n, 'workouts.csv')))
  .sort().reverse();
if (!dirs.length) {
  console.error('no peloton backup found — run one from the Backup tab');
  process.exit(1);
}
const dir = path.join(root, dirs[0]);
console.log(`backup: ${dirs[0]}`);

const workouts = fromCsv(fs.readFileSync(path.join(dir, 'workouts.csv'), 'utf8'))
  .filter(w => w.discipline === DISCIPLINE && (w.title || '') === TITLE && w.status === 'COMPLETE')
  .sort((a, b) => String(a.start).localeCompare(String(b.start)));
console.log(`rides matching "${TITLE}" (${DISCIPLINE}): ${workouts.length}\n`);
if (!workouts.length) process.exit(0);

const metricLines = fs.readFileSync(path.join(dir, 'metrics.csv'), 'utf8').split('\n');
const metricHeader = metricLines[0];
const metricsFor = id =>
  fromCsv([metricHeader, ...metricLines.filter((l, i) => i > 0 && l.startsWith(id + ','))].join('\n'));

const mean = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;

const rides = [];
for (const w of workouts) {
  const rows = metricsFor(w.id).filter(r => r.second > WARMUP_SECS);
  const paired = rows.filter(r => r.output != null && r.heart_rate > 0);
  const ride = {
    start: new Date(w.start),
    month: String(w.start).slice(0, 7),
    avgOutput: mean(rows.map(r => r.output).filter(v => v != null)),
    avgHr: mean(paired.map(r => r.heart_rate)),
    maxHr: Math.max(0, ...rows.map(r => r.heart_rate ?? 0)) || null,
    totalOutput: w.total_output ?? w.total_total_output,
    calories: w.calories ?? w.total_calories,
    strive: w.strive_score,
  };
  if (paired.length >= 300) {
    ride.ef = mean(paired.map(r => r.output)) / ride.avgHr;
    // Time-midpoint split (standard Pw:HR convention), matching server.cjs.
    const mid = WARMUP_SECS + ((w.duration_secs || 1200) - WARMUP_SECS) / 2;
    const h1 = paired.filter(r => r.second <= mid), h2 = paired.filter(r => r.second > mid);
    if (h1.length >= 120 && h2.length >= 120) {
      const half = rowsHalf => mean(rowsHalf.map(r => r.output)) / mean(rowsHalf.map(r => r.heart_rate));
      const ef1 = half(h1), ef2 = half(h2);
      ride.decoupling = ((ef1 - ef2) / ef1) * 100;
    }
  }
  rides.push(ride);
}

// ---- per-ride table ----
const fmt = (v, d = 1) => v == null ? '—' : (+v).toFixed(d);
console.log('date        avg W  avg HR  max HR  EF(W/bpm)  decouple%  kJ    cal  strive');
for (const r of rides) {
  console.log([
    r.start.toISOString().slice(0, 10), ' ',
    String(fmt(r.avgOutput, 0)).padStart(5),
    String(fmt(r.avgHr, 0)).padStart(7),
    String(fmt(r.maxHr, 0)).padStart(7),
    String(fmt(r.ef, 3)).padStart(10),
    String(fmt(r.decoupling)).padStart(10),
    String(fmt(r.totalOutput, 0)).padStart(5),
    String(fmt(r.calories, 0)).padStart(6),
    String(fmt(r.strive)).padStart(7),
  ].join(''));
}

// ---- monthly aggregates ----
const months = new Map();
for (const r of rides) {
  if (!months.has(r.month)) months.set(r.month, []);
  months.get(r.month).push(r);
}
console.log('\nmonth    rides  avg W  avg HR  EF(W/bpm)  decouple%');
let prev = null;
for (const [m, rs] of [...months.entries()].sort()) {
  const ef = mean(rs.map(r => r.ef).filter(v => v != null));
  const line = [
    m, ' ',
    String(rs.length).padStart(6),
    String(fmt(mean(rs.map(r => r.avgOutput).filter(v => v != null)), 0)).padStart(7),
    String(fmt(mean(rs.map(r => r.avgHr).filter(v => v != null)), 0)).padStart(7),
    String(fmt(ef, 3)).padStart(10),
    String(fmt(mean(rs.map(r => r.decoupling).filter(v => v != null)))).padStart(10),
  ].join('');
  const delta = prev != null && ef != null ? `  (${ef >= prev ? '+' : ''}${(((ef - prev) / prev) * 100).toFixed(1)}% EF)` : '';
  console.log(line + delta);
  if (ef != null) prev = ef;
}

// ---- overall trend: least-squares slope of EF over time ----
const pts = rides.filter(r => r.ef != null)
  .map(r => ({ x: r.start.getTime() / (30.44 * 86_400_000), y: r.ef }));
if (pts.length >= 3) {
  const mx = mean(pts.map(p => p.x)), my = mean(pts.map(p => p.y));
  const slope = pts.reduce((s, p) => s + (p.x - mx) * (p.y - my), 0)
    / pts.reduce((s, p) => s + (p.x - mx) ** 2, 0);
  const first = pts[0].y, last = pts[pts.length - 1].y;
  console.log(`\nEF trend: ${slope >= 0 ? '+' : ''}${(slope / my * 100).toFixed(1)}%/month (fit over ${pts.length} rides)`);
  console.log(`first ride EF ${first.toFixed(3)} → last ride EF ${last.toFixed(3)} (${(((last - first) / first) * 100).toFixed(1)}% total)`);
} else {
  console.log(`\nonly ${pts.length} ride(s) with heart-rate data — not enough for a trend line`);
}
