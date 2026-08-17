const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4321;
const HOST = '127.0.0.1';

const VOLTRA_BIN = fs.existsSync(path.join(os.homedir(), '.voltra/bin/voltra'))
  ? path.join(os.homedir(), '.voltra/bin/voltra')
  : 'voltra';

// Only commands the dashboard needs. Excludes config/logs/skills/daemon/update
// so the browser can never touch keys, logs, or the install.
const ALLOWED_COMMANDS = new Set([
  'scan', 'connect', 'reconnect', 'disconnect', 'status', 'refresh',
  'set-mode', 'set-weight', 'load', 'unload', 'finish-training',
  'check-cable-zero', 'workout', 'actions', 'whoami',
]);
const SAFE_ARG = /^[\w.:+/-]+$/;

function validateArgs(args) {
  if (!Array.isArray(args) || args.length === 0 || args.length > 12) return 'args must be a non-empty array (max 12)';
  if (!args.every(a => typeof a === 'string' && a.length <= 100 && SAFE_ARG.test(a))) return 'invalid argument';
  if (!ALLOWED_COMMANDS.has(args[0])) return `command not allowed: ${args[0]}`;
  return null;
}

function runVoltra(args, cb) {
  execFile(VOLTRA_BIN, args, { timeout: 90_000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      const msg = (stderr || stdout || err.message || '').trim();
      return cb({ ok: false, error: msg });
    }
    let data;
    try { data = JSON.parse(stdout); } catch { data = stdout.trim(); }
    cb({ ok: true, data });
  });
}

function voltraJson(args) {
  return new Promise((resolve, reject) => {
    execFile(VOLTRA_BIN, [...args, '--json'], { timeout: 90_000, maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || stdout || err.message || '').trim()));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error('unparseable output from voltra ' + args[0])); }
    });
  });
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = [...new Set(rows.flatMap(r => Object.keys(r)))];
  const esc = v => {
    if (v == null) return '';
    if (Array.isArray(v)) v = v.join(';');
    v = String(v);
    return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n') + '\n';
}

function flattenRep(rep, workoutId, setId) {
  const row = { workoutId, setId, position: rep.position };
  for (const phase of ['pull', 'recovery']) {
    for (const [k, v] of Object.entries(rep[phase] || {})) row[`${phase}_${k}`] = v;
  }
  return row;
}

// CLI datetime format: yyyy-MM-ddTHH:mm:ss, UTC, no Z suffix
const fmtDate = d => d.toISOString().slice(0, 19);

const sleep = ms => new Promise(r => setTimeout(r, ms));

// The Beyond backend rate-limits bursts (error 10207). Space requests out
// and back off hard when throttled.
async function backupCall(args) {
  const delays = [0, 5_000, 30_000, 60_000];
  for (let attempt = 0; ; attempt++) {
    try {
      await sleep(1_000);
      return await voltraJson(args);
    } catch (err) {
      if (attempt >= delays.length - 1 || !/10207/.test(err.message)) throw err;
      await sleep(delays[attempt + 1]);
    }
  }
}

const backupState = {
  running: false, phase: 'idle', error: null, result: null, startedAt: null,
  totalWorkouts: 0, processedWorkouts: 0, sets: 0, reps: 0,
};

async function backupAll() {
  Object.assign(backupState, {
    running: true, phase: 'listing', error: null, result: null,
    startedAt: new Date().toISOString(),
    totalWorkouts: 0, processedWorkouts: 0, sets: 0, reps: 0,
  });
  // Exhaustive: the backend caps query spans at 365 days, so walk
  // 364-day windows from before the product existed to now.
  const workouts = new Map();
  let cursor = new Date('2022-01-01T00:00:00Z');
  const now = new Date();
  while (cursor < now) {
    const end = new Date(Math.min(cursor.getTime() + 364 * 86_400_000, now.getTime()));
    let page = 1, pages = 1;
    do {
      const res = await backupCall(['workout', 'list',
        '--start', fmtDate(cursor), '--end', fmtDate(end),
        '--page', String(page), '--page-size', '50']);
      for (const w of res.list || []) workouts.set(w.id, w);
      pages = res.pages || 1;
      page++;
    } while (page <= pages);
    cursor = new Date(end.getTime() + 1000);
  }

  backupState.phase = 'workouts';
  backupState.totalWorkouts = workouts.size;
  const setRows = [], repRows = [];
  for (const w of workouts.values()) {
    const sets = await backupCall(['workout', 'sets', String(w.id)]);
    for (const s of sets) {
      setRows.push({ workoutId: w.id, ...s });
      const reps = await backupCall(['workout', 'reps', String(w.id), String(s.id)]);
      for (const rep of reps) repRows.push(flattenRep(rep, w.id, s.id));
      backupState.sets = setRows.length;
      backupState.reps = repRows.length;
    }
    backupState.processedWorkouts++;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const dir = path.join(__dirname, 'backups', stamp);
  fs.mkdirSync(dir, { recursive: true });
  const workoutRows = [...workouts.values()].sort((a, b) => a.id - b.id);
  fs.writeFileSync(path.join(dir, 'workouts.csv'), toCsv(workoutRows));
  fs.writeFileSync(path.join(dir, 'sets.csv'), toCsv(setRows));
  fs.writeFileSync(path.join(dir, 'reps.csv'), toCsv(repRows));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    counts: { workouts: workoutRows.length, sets: setRows.length, reps: repRows.length },
    note: 'All weights in lbs, distances in mm, timestamps UTC. IDs are Beyond cloud IDs.',
  }, null, 2));
  return { dir, workouts: workoutRows.length, sets: setRows.length, reps: repRows.length };
}

function listBackups() {
  const root = path.join(__dirname, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => fs.existsSync(path.join(root, name, 'manifest.json')))
    .map(name => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, name, 'manifest.json'), 'utf8'));
        return { name, createdAt: m.createdAt, counts: m.counts };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.name.localeCompare(a.name));
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.map': 'application/json',
};

function serveStatic(req, res) {
  const dist = path.join(__dirname, 'dist');
  let urlPath;
  // decodeURIComponent throws on malformed escapes (GET /%) — an uncaught
  // throw here would kill the whole process.
  try { urlPath = decodeURIComponent(req.url.split('?')[0]); } catch { urlPath = '/'; }
  let file = path.normalize(path.join(dist, urlPath));
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* missing or racing delete */ }
  // Trailing separator so a sibling like dist-backup/ can never match.
  if (!file.startsWith(dist + path.sep) || !stat || stat.isDirectory()) {
    file = path.join(dist, 'index.html');
  }
  fs.readFile(file, (err, data) => {
    if (err) return json(res, 500, { ok: false, error: 'dist/ not built — run: npm run build' });
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

function json(res, code, body) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

// All POST routes require a JSON Content-Type. Cross-site "simple requests"
// (text/plain forms/fetch) skip the CORS preflight, so without this gate any
// website could write our files or drive the machine.
function requireJson(req, res) {
  if ((req.headers['content-type'] || '').includes('application/json')) return true;
  json(res, 415, { ok: false, error: 'Content-Type must be application/json' });
  return false;
}

function readBody(req, res, limit, cb) {
  let body = '', over = false;
  req.on('data', c => {
    if (over) return;
    body += c;
    if (body.length > limit) {
      over = true;
      json(res, 413, { ok: false, error: `body exceeds ${limit} bytes` });
      req.destroy();
    }
  });
  req.on('end', () => { if (!over) cb(body); });
}

// Write via tmp + rename so a crash mid-write can't leave a truncated file.
function writeFileAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

const server = http.createServer((req, res) => {
  // Host allowlist: defeats DNS rebinding. A hostile page that rebinds its
  // domain to 127.0.0.1 becomes same-origin with us, but still sends its own
  // hostname in the Host header.
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test((req.headers.host || '').toLowerCase())) {
    return json(res, 403, { ok: false, error: 'forbidden host' });
  }
  const pathname = req.url.split('?')[0];

  if (req.method === 'POST' && pathname === '/api/run') {
    if (!requireJson(req, res)) return;
    readBody(req, res, 10_000, body => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const errMsg = validateArgs(parsed.args);
      if (errMsg) return json(res, 400, { ok: false, error: errMsg });
      runVoltra(parsed.args, result => json(res, result.ok ? 200 : 502, result));
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/backup') {
    if (!requireJson(req, res)) return;
    if (backupState.running) return json(res, 409, { ok: false, error: 'backup already running' });
    backupAll()
      .then(result => { backupState.phase = 'done'; backupState.result = result; })
      .catch(err => { backupState.phase = 'error'; backupState.error = err.message; })
      .finally(() => { backupState.running = false; });
    return json(res, 202, { ok: true, data: { started: true } });
  }

  if (req.method === 'GET' && pathname === '/api/backup/status') {
    return json(res, 200, { ok: true, data: backupState });
  }

  if (req.method === 'GET' && pathname === '/api/backups') {
    return json(res, 200, { ok: true, data: listBackups() });
  }

  if (req.method === 'GET' && pathname === '/api/telemetry') {
    const dir = path.join(__dirname, 'telemetry');
    const ids = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /^\d+\.json$/.test(f)).map(f => Number(f.slice(0, -5)))
      : [];
    return json(res, 200, { ok: true, data: ids });
  }

  if (req.method === 'POST' && pathname === '/api/chat') {
    if (!requireJson(req, res)) return;
    readBody(req, res, 8 * 1024 * 1024, body => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const msgs = Array.isArray(parsed.messages) ? parsed.messages.slice(-20) : [];
      if (!msgs.length || msgs.some(m => typeof m.text !== 'string' || m.text.length > 2000)) {
        return json(res, 400, { ok: false, error: 'messages must be non-empty, each ≤2000 chars' });
      }
      const ctx = parsed.context || {};
      if (ctx.exercise != null && (typeof ctx.exercise !== 'string' || ctx.exercise.length > 200)) {
        return json(res, 400, { ok: false, error: 'context.exercise must be a short string' });
      }
      // Serialized once here: caps the prompt well under ARG_MAX so execFile
      // can't fail with E2BIG, and bounds what reaches the model.
      const targetsStr = ctx.targets ? JSON.stringify(ctx.targets) : '';
      const dataStr = ctx.data ? JSON.stringify(ctx.data) : '';
      if (targetsStr.length + dataStr.length > 100_000) {
        return json(res, 400, { ok: false, error: 'context too large' });
      }

      // Screenshot of the charts as the user sees them, for visual grounding.
      // Fresh mkdtemp per request: no fixed predictable tmp path, no races
      // between concurrent chats.
      let shotDir = null, shotPath = null;
      if (typeof parsed.screenshot === 'string' && parsed.screenshot.startsWith('data:image/png;base64,')) {
        try {
          shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigor-coach-chat-'));
          shotPath = path.join(shotDir, 'charts.png');
          fs.writeFileSync(shotPath, Buffer.from(parsed.screenshot.slice('data:image/png;base64,'.length), 'base64'));
        } catch { shotDir = shotPath = null; }
      }

      const prompt = [
        'You are a strength coach embedded in VIGOR COACH, a personal health dashboard whose Lift page controls a VOLTRA cable machine with per-rep telemetry (ROM, resistance, velocity, power).',
        '',
        'GROUND RULES:',
        '- Everything we know is in the DATA block below. NEVER ask the user for anything already present there — read it and use it.',
        '- Ground every answer in the actual numbers: quote the specific values (velocity, ROM, tempo, power) that support your point.',
        '- Compare performance against the targets and against these research guidelines: VBT mean-concentric-velocity zones (max strength <0.5 m/s, strength-speed 0.5-0.75, power 0.75-1.0); eccentric tempo 2-4s is optimal for hypertrophy (>10s inferior); accentuated eccentric loading of 110-150% of concentric load is well supported; full ROM beats partial for hypertrophy.',
        '- Call out gaps: where the selected rep or set deviates from targets, from the set average, or from their progress trend.',
        '- You MAY ask for what the data cannot contain — perceived effort, soreness, pain, sleep, nutrition, goals — when it would change your advice.',
        '- 1-4 short sentences unless asked to go deep. No markdown headers.',
        '',
        ctx.exercise ? `EXERCISE: ${ctx.exercise}` : '',
        targetsStr ? `TARGETS: ${targetsStr} (romM meters, loadLbs/eccLbs pounds, mcvMin/mcvMax m/s concentric zone, eccSecs eccentric tempo)` : '',
        dataStr ? `DATA: ${dataStr}` : '',
        shotPath
          ? `SCREENSHOT: The charts exactly as the user currently sees them are saved at ${shotPath} — top to bottom: Range of Motion, Resistance, Velocity, Power. Read that image file before answering so you can ground visual references (shapes, the con/ecc divider, target zone cells, the white selected rep) in what they are looking at.`
          : '',
        '',
        'Conversation:',
        ...msgs.map(m => `${m.role === 'assistant' ? 'Coach' : 'User'}: ${m.text}`),
        '',
        'Reply with only the coach\'s next message.',
      ].filter(Boolean).join('\n');

      execFile('claude', ['-p', prompt, '--model', 'haiku'], { timeout: 90_000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (shotDir) fs.rmSync(shotDir, { recursive: true, force: true });
        if (err) return json(res, 502, { ok: false, error: (stderr || err.message || '').trim().slice(0, 300) });
        json(res, 200, { ok: true, data: { reply: stdout.trim() } });
      });
    });
    return;
  }

  if (pathname === '/api/targets') {
    const file = path.join(__dirname, 'targets.json');
    if (req.method === 'GET') {
      let data = {};
      if (fs.existsSync(file)) {
        try { data = JSON.parse(fs.readFileSync(file, 'utf8')); }
        catch { return json(res, 500, { ok: false, error: 'targets.json is corrupt — fix or delete it' }); }
      }
      return json(res, 200, { ok: true, data });
    }
    if (req.method === 'POST') {
      if (!requireJson(req, res)) return;
      readBody(req, res, 100_000, body => {
        try {
          JSON.parse(body);
          writeFileAtomic(file, body);
          json(res, 200, { ok: true, data: { saved: true } });
        } catch (e) {
          json(res, 400, { ok: false, error: e.message });
        }
      });
      return;
    }
  }

  const telem = pathname.match(/^\/api\/telemetry\/(\d+)$/);
  if (telem && req.method === 'GET') {
    const file = path.join(__dirname, 'telemetry', `${telem[1]}.json`);
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'no telemetry' });
    return fs.readFile(file, 'utf8', (err, data) => {
      if (err) return json(res, 500, { ok: false, error: err.message });
      try { JSON.parse(data); } catch { return json(res, 500, { ok: false, error: 'telemetry file is corrupt' }); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(`{"ok":true,"data":${data}}`);
    });
  }
  if (telem && req.method === 'POST') {
    if (!requireJson(req, res)) return;
    readBody(req, res, 20 * 1024 * 1024, body => {
      try {
        JSON.parse(body);
        fs.mkdirSync(path.join(__dirname, 'telemetry'), { recursive: true });
        writeFileAtomic(path.join(__dirname, 'telemetry', `${telem[1]}.json`), body);
        json(res, 200, { ok: true, data: { saved: true } });
      } catch (e) {
        json(res, 400, { ok: false, error: e.message });
      }
    });
    return;
  }

  if (req.method === 'GET' && !pathname.startsWith('/api/')) {
    return serveStatic(req, res);
  }

  json(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, HOST, () => {
  console.log(`VIGOR COACH → http://${HOST}:${PORT}  (voltra: ${VOLTRA_BIN})`);
});
