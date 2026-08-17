// Shared machinery for the rep telemetry charts: series building, the
// average rep, and the mock year-of-history generator.

export const KEYS = ['force', 'velocity', 'power'];
export const GRID = 48; // resample resolution per phase
export const LBS_TO_N = 4.44822;
export const GRAY = '#8a8a7e';

export const CHARTS = [
  { key: 'rom', title: 'Range of Motion', unit: 'M (relative, integrated)', color: '#4da3ff' },
  { key: 'force', title: 'Resistance', unit: 'LBS', color: '#ff4d3a' },
  { key: 'velocity', title: 'Velocity', unit: 'M/S', color: '#3fd8c7', zeroLine: true },
  { key: 'power', title: 'Power', unit: 'W', color: '#c6fe28', zeroLine: true },
];

export function durations(telem, apiRep) {
  const nCon = telem.con.velocity.length, nEcc = telem.ecc.velocity.length;
  const conDur = apiRep ? apiRep.pull.durationMs / 1000 : telem.durationS;
  const eccDur = apiRep
    ? apiRep.recovery.durationMs / 1000
    : telem.durationS * (nEcc / Math.max(nCon, 1));
  return { conDur, eccDur };
}

// Real-time axis anchored at the con/ecc transition: concentric samples span
// [-conDur, 0], eccentric [0, eccDur]. Longer reps extend further left/right.
export function repSeries(telem, { conDur, eccDur }) {
  const nCon = telem.con.velocity.length, nEcc = telem.ecc.velocity.length;
  const tCon = i => -conDur + (i / Math.max(nCon - 1, 1)) * conDur;
  const tEcc = i => (i / Math.max(nEcc - 1, 1)) * eccDur;

  const joined = key => [
    ...telem.con[key].map((v, i) => ({ t: tCon(i), v })),
    ...telem.ecc[key].map((v, i) => ({ t: tEcc(i), v })),
  ];

  const velocity = joined('velocity');
  const rom = [];
  let pos = 0, prevT = velocity[0]?.t ?? 0;
  for (const p of velocity) {
    pos = Math.max(pos + p.v * (p.t - prevT), 0);
    prevT = p.t;
    rom.push({ t: p.t, v: pos });
  }

  return { rom, force: joined('force'), velocity, power: joined('power') };
}

// Average a set's reps in {t, v} space: resample every rep onto a common
// index grid (reps in a set share con/ecc sample structure, so index
// fraction aligns phases) and take the pointwise mean of t and v.
export function averageSetRep(reps) {
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const out = {};
  for (const key of ['rom', ...KEYS]) {
    const len = Math.min(...reps.map(r => r[key].length));
    out[key] = Array.from({ length: len }, (_, j) => {
      const pts = reps.map(r => {
        const pos = (j / (len - 1)) * (r[key].length - 1);
        const lo = Math.floor(pos), hi = Math.ceil(pos), f = pos - lo;
        const a = r[key][lo], b = r[key][hi];
        return { t: a.t + (b.t - a.t) * f, v: a.v + (b.v - a.v) * f };
      });
      return { t: mean(pts.map(p => p.t)), v: mean(pts.map(p => p.v)) };
    });
  }
  return out;
}

export const resample = (arr, n) => Array.from({ length: n }, (_, j) => {
  const pos = (j / (n - 1)) * (arr.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return arr[lo] + (arr[hi] - arr[lo]) * (pos - lo);
});

// The "average rep": per phase, resample every rep onto a common grid and
// take the mean per grid point; phase durations are averaged too.
export function averageRep(telemRows, durs) {
  const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;
  const avg = { con: {}, ecc: {} };
  for (const phase of ['con', 'ecc']) {
    for (const key of KEYS) {
      const grids = telemRows.map(r => resample(r[phase][key], GRID));
      avg[phase][key] = Array.from({ length: GRID }, (_, j) => mean(grids.map(g => g[j])));
    }
  }
  return {
    telem: avg,
    durs: { conDur: mean(durs.map(d => d.conDur)), eccDur: mean(durs.map(d => d.eccDur)) },
  };
}

export const mulberry32 = seed => () => {
  seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

// Template curves (con/ecc × rom/force/velocity) from the average rep.
export function buildTpl(avg, avgSeries) {
  return {
    con: {
      rom: avgSeries.rom.slice(0, GRID).map(p => p.v),
      ...Object.fromEntries(KEYS.map(k => [k, avg.telem.con[k]])),
    },
    ecc: {
      rom: avgSeries.rom.slice(GRID).map(p => p.v),
      ...Object.fromEntries(KEYS.map(k => [k, avg.telem.ecc[k]])),
    },
  };
}

// One synthetic rep: template curves scaled by training progress
// (strength/mobility up, speed up, noise down) plus smooth wobble.
// Power is derived pointwise from synthetic force × velocity (P = F · v),
// so the four charts stay physically consistent.
export function synthRep(tpl, avgDurs, p, rng, nPts) {
  const day = 1 + (rng() - 0.5) * 0.12;
  const scale = {
    force: (0.62 + 0.38 * p) * day,
    velocity: (0.85 + 0.15 * p) * day,
    rom: (0.82 + 0.20 * p) * (1 + (rng() - 0.5) * 0.06),
  };
  const sigma = 0.20 - 0.12 * p;
  const conDur = avgDurs.conDur * (1.08 - 0.16 * p) * (1 + (rng() - 0.5) * 0.24);
  const eccDur = avgDurs.eccDur * (1.06 - 0.12 * p) * (1 + (rng() - 0.5) * 0.24);

  const wob = () => {
    const a1 = sigma * rng(), a2 = sigma * rng(), f1 = 1 + rng() * 2, f2 = 3 + rng() * 3;
    const p1 = rng() * Math.PI * 2, p2 = rng() * Math.PI * 2;
    return u => 1 + a1 * Math.sin(2 * Math.PI * f1 * u + p1) + a2 * Math.sin(2 * Math.PI * f2 * u + p2);
  };

  const interp = (arr, u) => {
    const idx = u * (arr.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    return arr[lo] + (arr[hi] - arr[lo]) * (idx - lo);
  };

  const out = { rom: [], force: [], velocity: [], power: [] };
  for (const [phase, dur] of [['con', conDur], ['ecc', eccDur]]) {
    const w = { rom: wob(), force: wob(), velocity: wob() };
    for (let j = 0; j < nPts; j++) {
      const u = j / (nPts - 1);
      const t = phase === 'con' ? -conDur + u * conDur : u * eccDur;
      const force = interp(tpl[phase].force, u) * scale.force * w.force(u);
      const velocity = interp(tpl[phase].velocity, u) * scale.velocity * w.velocity(u);
      out.rom.push({ t, v: Math.max(interp(tpl[phase].rom, u) * scale.rom * w.rom(u), 0) });
      out.force.push({ t, v: force });
      out.velocity.push({ t, v: velocity });
      out.power.push({ t, v: force * LBS_TO_N * velocity });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Target bands: per-rep prescription curves (upper/lower), research-grounded.
//
// - Concentric velocity: VBT mean-concentric-velocity zone [mcvMin, mcvMax]
//   (strength-speed ≈ 0.5–0.75 m/s), half-sine profile peaking mid-ROM.
// - Eccentric: controlled tempo of eccSecs (2–3 s per tempo literature).
// - Resistance: NOT a performance band — the machine fixes it. The target is
//   the exact programmed setpoints (con load, ecc load), drawn as a stepped
//   line; chart noise around it is measurement/dynamics, not user error.
// - ROM: smooth rise to [0.95, 1.08] × target ROM, controlled return.
// - Power: derived pointwise as F · v; band width comes from the velocity
//   band only, since force is fixed.
export const DEFAULT_PRESS_TARGETS = {
  romM: 0.65, loadLbs: 25, eccLbs: 38,
  mcvMin: 0.5, mcvMax: 0.75, eccSecs: 2.5,
};

export function targetBands(p, nPts = 40) {
  const mcvMid = (p.mcvMin + p.mcvMax) / 2;
  const conDur = p.romM / mcvMid;
  const eccDur = p.eccSecs;
  const HALF_SINE_MEAN = 0.66; // mean of sin(pi·u)^0.85 profile
  const smooth = u => u * u * (3 - 2 * u);

  const con = [], ecc = [];
  for (let j = 0; j < nPts; j++) {
    const u = j / (nPts - 1);
    con.push({ t: -conDur + u * conDur, u });
    ecc.push({ t: u * eccDur, u });
  }

  const shape = u => Math.pow(Math.sin(Math.PI * u), 0.85);

  const rom = {
    lower: [...con.map(({ t, u }) => ({ t, v: 0.95 * p.romM * smooth(u) })),
      ...ecc.map(({ t, u }) => ({ t, v: 0.95 * p.romM * smooth(1 - u) }))],
    upper: [...con.map(({ t, u }) => ({ t, v: 1.08 * p.romM * smooth(Math.min(u * 1.12, 1)) })),
      ...ecc.map(({ t, u }) => ({ t, v: 1.08 * p.romM * smooth(Math.min((1 - u) * 1.12, 1)) }))],
  };

  // Machine setpoints: exact stepped line (upper === lower renders as a line)
  const forceLine = [
    ...con.map(({ t }) => ({ t, v: p.loadLbs })),
    ...ecc.map(({ t }) => ({ t, v: p.eccLbs })),
  ];
  const force = { lower: forceLine, upper: forceLine };

  const eccV = p.romM / eccDur; // controlled descent speed
  const velocity = {
    lower: [...con.map(({ t, u }) => ({ t, v: (p.mcvMin / HALF_SINE_MEAN) * shape(u) })),
      ...ecc.map(({ t, u }) => ({ t, v: -1.25 * eccV * Math.pow(Math.sin(Math.PI * u), 0.3) }))],
    upper: [...con.map(({ t, u }) => ({ t, v: (p.mcvMax / HALF_SINE_MEAN) * shape(u) })),
      ...ecc.map(({ t, u }) => ({ t, v: -0.75 * eccV * Math.pow(Math.sin(Math.PI * u), 0.3) }))],
  };

  const power = {
    lower: velocity.lower.map((pt, i) => {
      const products = [
        force.lower[i].v * LBS_TO_N * velocity.lower[i].v,
        force.upper[i].v * LBS_TO_N * velocity.lower[i].v,
        force.lower[i].v * LBS_TO_N * velocity.upper[i].v,
        force.upper[i].v * LBS_TO_N * velocity.upper[i].v,
      ];
      return { t: pt.t, v: Math.min(...products) };
    }),
    upper: velocity.upper.map((pt, i) => {
      const products = [
        force.lower[i].v * LBS_TO_N * velocity.lower[i].v,
        force.upper[i].v * LBS_TO_N * velocity.upper[i].v,
        force.lower[i].v * LBS_TO_N * velocity.upper[i].v,
        force.upper[i].v * LBS_TO_N * velocity.lower[i].v,
      ];
      return { t: pt.t, v: Math.max(...products) };
    }),
  };

  return { rom, force, velocity, power };
}

// A year of consistent, improving training: sessions/week grow, per-rep
// noise shrinks, strength/speed/mobility trend up.
export function mockYear(avg, avgSeries, seed = 20260817) {
  const rng = mulberry32(seed);
  const tpl = buildTpl(avg, avgSeries);

  const hex = { rom: [], force: [], velocity: [], power: [] };
  for (let week = 0; week < 52; week++) {
    const consistency = week / 52;
    const sessions = 2 + (consistency > 0.4 ? 1 : 0) + (rng() < consistency ? 1 : 0);
    for (let sess = 0; sess < sessions; sess++) {
      const p = Math.min((week + sess / sessions) / 52, 1);
      const reps = 8 + Math.floor(rng() * 5);
      for (let r = 0; r < reps; r++) {
        const rep = synthRep(tpl, avg.durs, p, rng, 12);
        for (const key of Object.keys(hex)) hex[key].push(...rep[key]);
      }
    }
  }

  // Today's other sets, drawn as gray lines at current-strength parameters.
  const today = [];
  for (let set = 0; set < 2; set++) {
    for (let r = 0; r < 10; r++) today.push(synthRep(tpl, avg.durs, 0.97, rng, 24));
  }
  return { hex, today, tpl };
}
