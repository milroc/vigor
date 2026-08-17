// Beyond+ session CSV → per-rep telemetry, matched to API reps by
// fingerprinting the per-rep peak power sequence.

const num = v => (v === '-' || v === '' ? null : Number(v));
const arr = v => v.split(';').map(Number);

export function parseSessionCsv(text) {
  const lines = text.trim().split(/\r?\n/);
  const header = lines[0].split(',');
  const col = name => header.indexOf(name);
  const c = {
    exercise: col('Exercise Index'), set: col('Set Index'), rep: col('Reps Index'),
    action: col('Action Name'), rom: col('Range of Motion (M)'), dur: col('Duration (S)'),
    peakP: col('Peak Power (W)'), peakV: col('Peak Velocity (M/S)'),
    conF: col('Con. Force (LBS)'), conV: col('Con. Velocity (M/S)'), conP: col('Con. Power (W)'),
    eccF: col('Ecc. Force (LBS)'), eccV: col('Ecc Velocity (M/S)'), eccP: col('Ecc Power (W)'),
  };
  return lines.slice(1).map(line => {
    const f = line.split(',');
    return {
      exercise: f[c.exercise], set: f[c.set], rep: f[c.rep], action: f[c.action],
      romM: num(f[c.rom]), durationS: num(f[c.dur]),
      peakPowerW: num(f[c.peakP]), peakVelocityMS: num(f[c.peakV]),
      con: { force: arr(f[c.conF]), velocity: arr(f[c.conV]), power: arr(f[c.conP]) },
      ecc: { force: arr(f[c.eccF]), velocity: arr(f[c.eccV]), power: arr(f[c.eccP]) },
    };
  });
}

// The app export interleaves multiple API workouts within one CSV "set"
// (e.g. left/right arm passes). Candidate slices: the whole group and each
// parity de-interleave; match on the exact per-rep peak power sequence.
export function matchTelemetry(csvRows, apiReps) {
  const target = apiReps.map(r => r.pull.peakPowerW);
  const groups = new Map();
  for (const row of csvRows) {
    const key = `${row.exercise}:${row.set}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  for (const rows of groups.values()) {
    for (const slice of [rows, rows.filter((_, i) => i % 2 === 0), rows.filter((_, i) => i % 2 === 1)]) {
      if (slice.length !== target.length) continue;
      if (slice.every((row, i) => Math.abs(row.peakPowerW - target[i]) <= 1)) return slice;
    }
  }
  return null;
}
