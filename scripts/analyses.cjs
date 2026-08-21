// Registry for the Ad-hoc Analysis tab. Each analysis computes on the parquet
// store and returns a normalized shape the generic frontend can render:
//   { sections: [{ title, columns:[...], rows:[[cell...]], note? }], notes:[...] }
// A cell is a primitive, or { v, tone: 'good'|'bad'|null } for good/bad coloring.
// `sourceFiles` are the actual calculation modules — the tab surfaces their code
// so every number here is traceable to the code that produced it.
const fs = require('fs');
const path = require('path');
const { computeEras } = require('./eras.cjs');
const { sanitizeSql } = require('./adhocAgent.cjs');

// Agent-generated analyses are persisted here as data (SQL + metadata), not
// code, so accepting one never writes executable JS. The registry merges these
// with the built-in code analyses.
const SAVED_FILE = path.join(__dirname, '..', 'labels', 'adhoc-analyses.json');
const loadSaved = () => {
  try { return JSON.parse(fs.readFileSync(SAVED_FILE, 'utf8')); } catch { return []; }
};
const slug = s => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'analysis';

const signed = (v, suffix = '') => `${v >= 0 ? '+' : ''}${v}${suffix}`;
const deltaCell = d => {
  if (!d) return '—';
  const v = `${signed(d.abs)} (${signed(d.pct, '%')})`;
  return d.better == null ? v : { v, tone: d.better ? 'good' : 'bad' };
};

function formatEras({ eras, deltas, markerDefs, dailyDefs, notes = [] }) {
  // No personal windows configured (labels/eras.json absent) — render a prompt
  // instead of empty tables.
  if (!eras.length) {
    return {
      sections: [{
        title: 'Life eras comparison',
        columns: ['Status'],
        rows: [['No eras configured']],
        note: 'Add labels/eras.json to define your life eras (see labels/eras.example.json).',
      }],
      notes: [],
    };
  }
  const labels = eras.map(e => e.label);
  return {
    sections: [
      {
        title: 'Cardio & body markers',
        columns: ['Marker', ...labels, 'Unit'],
        rows: markerDefs.map(m => [m.label, ...eras.map(e => e.markers[m.key].avg), m.unit]),
      },
      {
        title: `Change vs ${eras[0].label}`,
        columns: ['Marker', ...deltas.map(d => d.label)],
        rows: markerDefs.map(m => [m.label, ...deltas.map(d => deltaCell(d.markers[m.key]))]),
      },
      {
        title: 'Daily activity (NEAT) · avg per tracked day',
        columns: ['Metric', ...labels],
        rows: dailyDefs.map(m => [m.label + (m.unit ? ` (${m.unit})` : ''), ...eras.map(e => e.neat[m.key].avg)]),
      },
      {
        title: 'Workout volume',
        columns: ['Era', 'Workouts', 'Hours', 'Active days', 'Top activity'],
        rows: eras.map(e => {
          const t = e.workouts.byActivity[0];
          return [e.label, e.workouts.count, e.workouts.hours, e.workouts.activeDays,
            t ? `${t.activity} (${t.n}×${t.avgMin}m)` : '—'];
        }),
      },
      {
        title: 'Workout mix',
        columns: ['Era', 'Activity', 'Count', 'Total min', 'Avg min'],
        rows: eras.flatMap(e => e.workouts.byActivity.map(w => [e.label, w.activity, w.n, w.totalMin, w.avgMin])),
      },
      {
        title: 'Marker sample sizes (readings)',
        columns: ['Marker', ...labels],
        rows: markerDefs.map(m => [m.label, ...eras.map(e => e.markers[m.key].n)]),
      },
    ],
    // Caveats are personal to the data/eras, so they come from labels/eras.json.
    notes,
  };
}

const ANALYSES = [
  {
    name: 'eras',
    title: 'Life eras comparison',
    description: 'Cross-era Apple Health comparison of cardio/body markers, daily activity (NEAT), and workout mix across the life eras defined in labels/eras.json.',
    sourceFiles: ['scripts/eras.cjs'],
    run: async con => formatEras(await computeEras(con)),
  },
];

const nowIso = () => new Date().toISOString();
const writeSaved = list => { fs.mkdirSync(path.dirname(SAVED_FILE), { recursive: true }); fs.writeFileSync(SAVED_FILE, JSON.stringify(list, null, 2) + '\n'); };

const listAnalyses = () => [
  ...ANALYSES.map(({ name, title, description }) => ({ name, title, description, kind: 'built-in' })),
  ...loadSaved().map(({ name, title, description }) => ({ name, title, description, kind: 'saved' })),
];

// Built-in analyses run server-side and return rendered sections + source.
// Saved analyses are editable multi-cell notebooks — we return the definition
// and the client runs each cell's SQL via /api/health/query (instant, no LLM).
async function runAnalysis(con, name) {
  const built = ANALYSES.find(x => x.name === name);
  if (built) {
    const data = await built.run(con);
    const source = built.sourceFiles.map(f => {
      const abs = path.join(__dirname, '..', f);
      return { file: f, code: fs.existsSync(abs) ? fs.readFileSync(abs, 'utf8') : `// missing: ${f}` };
    });
    return { name: built.name, title: built.title, description: built.description, kind: 'built-in', data, source };
  }
  const saved = loadSaved().find(x => x.name === name);
  if (saved) return { ...saved, kind: 'saved' }; // editable notebook definition
  throw new Error(`unknown analysis: ${name}`);
}

// Create or update an editable notebook. Every cell must be a single read-only
// statement (validated by sanitizeSql). Stored as data — never executable JS.
function saveAnalysis({ name, title, description = '', cells }) {
  if (!title || !String(title).trim()) throw new Error('title required');
  const nonEmpty = (Array.isArray(cells) ? cells : []).filter(c => c && c.sql && String(c.sql).trim());
  if (!nonEmpty.length) throw new Error('add at least one cell with SQL');
  const clean = nonEmpty.map((c, i) => {
    const cell = { title: String(c.title || `Cell ${i + 1}`).slice(0, 80), sql: sanitizeSql(c.sql) };
    const v = c.viz;
    if (v && (v.type === 'line' || v.type === 'bar') && v.x && Array.isArray(v.y) && v.y.length) {
      cell.viz = { type: v.type, x: String(v.x), y: v.y.map(String) };
    }
    return cell;
  });

  const list = loadSaved();
  const at = name ? list.findIndex(x => x.name === name) : -1;
  const meta = { title: String(title).slice(0, 80), description: String(description).slice(0, 300), cells: clean };
  let entry;
  if (at >= 0) {
    entry = { ...list[at], ...meta, updatedAt: nowIso() };
    list[at] = entry;
  } else {
    let nm = slug(title), i = 1;
    while (list.some(x => x.name === nm) || ANALYSES.some(x => x.name === nm)) nm = `${slug(title)}-${++i}`;
    entry = { name: nm, ...meta, createdAt: nowIso(), updatedAt: nowIso() };
    list.push(entry);
  }
  writeSaved(list);
  return entry;
}

function deleteAnalysis(name) {
  writeSaved(loadSaved().filter(x => x.name !== name));
  return { deleted: name };
}

module.exports = { ANALYSES, listAnalyses, runAnalysis, saveAnalysis, deleteAnalysis };
