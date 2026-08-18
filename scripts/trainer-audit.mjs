#!/usr/bin/env node
// Audit the hand-kept trainer log (manual/trainer-sessions.json) against the
// newest Peloton backup: which sessions are recorded, partial, or missing.
//
//   node scripts/trainer-audit.mjs [--user name]
import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const USER = args.includes('--user') ? args[args.indexOf('--user') + 1] : null;
const BAND = { minMins: 42, maxMins: 66 };
const root = path.join(import.meta.dirname, '..');

const manualFile = path.join(root, 'manual', 'trainer-sessions.json');
if (!fs.existsSync(manualFile)) {
  console.error('missing manual/trainer-sessions.json');
  process.exit(1);
}
const manual = JSON.parse(fs.readFileSync(manualFile, 'utf8'));

const backupsRoot = path.join(root, 'backups');
const dirs = fs.existsSync(backupsRoot)
  ? fs.readdirSync(backupsRoot)
    .filter(n => n.includes('-peloton-') && (!USER || n.endsWith(`-${USER}`)))
    .filter(n => fs.existsSync(path.join(backupsRoot, n, 'workouts.csv')))
    .sort().reverse()
  : [];
if (!dirs.length) {
  console.error('no peloton backup found');
  process.exit(1);
}
console.log(`manual log: ${manual.sessions.length} sessions | backup: ${dirs[0]}`);

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
  return data.map(r => Object.fromEntries(header.map((name, i) => [name, r[i] ?? ''])));
}

const laDate = iso => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date(iso));

const workouts = fromCsv(fs.readFileSync(path.join(backupsRoot, dirs[0], 'workouts.csv'), 'utf8'))
  .filter(w => w.start);
const earliest = workouts.map(w => w.start).sort()[0];
console.log(`account history begins: ${laDate(earliest)} (LA)\n`);

const byDate = new Map();
for (const w of workouts) {
  const d = laDate(w.start);
  if (!byDate.has(d)) byDate.set(d, []);
  byDate.get(d).push({
    disc: w.discipline,
    mins: (Number(w.duration_secs) || 0) / 60,
    startMs: Date.parse(w.start),
    endMs: Date.parse(w.end || w.start) || Date.parse(w.start),
  });
}

const buckets = { matched: [], partial: [], missing: [], preAccount: [] };
for (const s of manual.sessions) {
  const tag = s.partner ? ' (partner)' : '';
  if (s.date < laDate(earliest)) { buckets.preAccount.push(s.date + tag); continue; }
  const day = byDate.get(s.date) || [];
  const strengthy = day.filter(w => ['strength', 'stretching'].includes(w.disc));
  const totalMins = strengthy.reduce((sum, w) => sum + w.mins, 0);
  // Wall-clock span of the day's recordings — matches the server's
  // merged-session rule, so a paused/split trainer hour still counts.
  const wallMins = strengthy.length
    ? (Math.max(...strengthy.map(w => w.endMs)) - Math.min(...strengthy.map(w => w.startMs))) / 60_000
    : 0;
  if (strengthy.some(w => w.mins >= BAND.minMins && w.mins <= BAND.maxMins)
    || (wallMins >= BAND.minMins && wallMins <= BAND.maxMins)) {
    buckets.matched.push(s.date + tag);
  } else if (totalMins >= 10) {
    buckets.partial.push(`${s.date}${tag}: ${totalMins.toFixed(0)}m recorded`);
  } else {
    buckets.missing.push(s.date + tag);
  }
}

console.log(`matched (full or merged recording in ${BAND.minMins}-${BAND.maxMins}m): ${buckets.matched.length}`);
console.log(`partial recording (≥10m but under band): ${buckets.partial.length}`);
for (const p of buckets.partial) console.log('  ', p);
console.log(`missing from this account: ${buckets.missing.length}`);
for (const m of buckets.missing) console.log('  ', m);
console.log(`before account history: ${buckets.preAccount.length}`);
if (manual.incomplete) console.log(`\nnote: ${manual.incomplete}`);
