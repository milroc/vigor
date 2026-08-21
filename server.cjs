const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const PORT = process.env.PORT || 4321;
const HOST = '127.0.0.1';

const VOLTRA_BIN = fs.existsSync(path.join(os.homedir(), '.voltra/bin/voltra'))
  ? path.join(os.homedir(), '.voltra/bin/voltra')
  : 'voltra';

// Apple Health store: DuckDB over partitioned Parquet under store/. The
// connection is created lazily (first ingest or query) so the server has no
// hard dependency on the native binding until the feature is used.
const { healthState, runHealthIngest, setupViews, STORE } = require('./scripts/ingestHealth.cjs');
// Trainer-session reproduction logic lives with its ground-truth labels.
let _duckCon = null, _duckInit = null;
function duck() {
  if (_duckCon) return Promise.resolve(_duckCon);
  if (!_duckInit) _duckInit = (async () => {
    const { DuckDBInstance } = require('@duckdb/node-api');
    fs.mkdirSync(path.join(__dirname, 'store'), { recursive: true });
    const inst = await DuckDBInstance.create(path.join(__dirname, 'store', 'app.duckdb'));
    const con = await inst.connect();
    await setupViews(con).catch(() => {}); // no-op until the first ingest exists
    _duckCon = con;
    return con;
  })();
  return _duckInit;
}

// Newest backups/*-apple-health/ dir that still holds its source export.zip.
function latestHealthBackup() {
  const root = path.join(__dirname, 'backups');
  if (!fs.existsSync(root)) return null;
  const dir = fs.readdirSync(root)
    .filter(n => n.endsWith('-apple-health') && fs.existsSync(path.join(root, n, 'export.zip')))
    .sort((a, b) => b.localeCompare(a))[0];
  return dir ? { dir: path.join(root, dir), zip: path.join(root, dir, 'export.zip') } : null;
}

const READ_ONLY_SQL = /^\s*(SELECT|WITH|DESCRIBE|SUMMARIZE|EXPLAIN|PRAGMA|SHOW|VALUES|FROM)\b/i;

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
    source: 'voltra',
    counts: { workouts: workoutRows.length, sets: setRows.length, reps: repRows.length },
    note: 'All weights in lbs, distances in mm, timestamps UTC. IDs are Beyond cloud IDs.',
  }, null, 2));
  return { dir, workouts: workoutRows.length, sets: setRows.length, reps: repRows.length };
}

// ---- Peloton ---------------------------------------------------------------
// Peloton has no official public API; this drives the same REST endpoints the
// web app uses. Credentials come from PELOTON_LOGIN / PELOTON_PASSWORD env
// vars (av inject) or the gitignored .env fallback.
const PELO_API = 'https://api.onepeloton.com';

(function loadEnvFile() {
  const file = path.join(__dirname, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*(\w+)\s*=\s*(.*?)\s*$/);
    if (!m || !m[2] || m[1] in process.env) continue;
    let v = m[2];
    if (/^".*"$/.test(v) || /^'.*'$/.test(v)) v = v.slice(1, -1);
    process.env[m[1]] = v;
  }
})();

// Peloton killed plain password login in late 2025; this is the members-site
// Auth0 OAuth + PKCE flow, ported from peloton-to-garmin v6
// (github.com/philosowaffle/peloton-to-garmin issue #795).
const PELO_AUTH = 'https://auth.onepeloton.com';
const PELO_CLIENT_ID = 'WVoJxVDdPoFx4RNewvvg6ch2mZ7bwnsM';
const PELO_REDIRECT = 'https://members.onepeloton.com/callback';
const PELO_SCOPE = 'offline_access openid peloton-api.members:default';
const PELO_AUTH0_CLIENT = 'eyJuYW1lIjoiYXV0aDAuanMtdWxwIiwidmVyc2lvbiI6IjkuMTQuMyJ9';
const PELO_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';

const b64url = buf => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
const randStr = n => b64url(crypto.randomBytes(n)).slice(0, n);

function peloAccounts() {
  const { PELOTON_LOGIN, PELOTON_PASSWORD, PELOTON_LOGIN_2, PELOTON_PASSWORD_2 } = process.env;
  const acc = [];
  if (PELOTON_LOGIN && PELOTON_PASSWORD) acc.push({ login: PELOTON_LOGIN, password: PELOTON_PASSWORD });
  if (PELOTON_LOGIN_2 && PELOTON_PASSWORD_2) acc.push({ login: PELOTON_LOGIN_2, password: PELOTON_PASSWORD_2 });
  return acc;
}

async function peloOAuthLogin(login, password) {
  // Minimal per-host cookie jar + manual redirect follower; fetch has neither.
  const jar = new Map();
  const storeCookies = (url, res) => {
    const host = new URL(url).host;
    for (const sc of res.headers.getSetCookie()) {
      const [pair] = sc.split(';');
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      if (!jar.has(host)) jar.set(host, new Map());
      jar.get(host).set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
  };
  const request = async (url, opts = {}) => {
    const hops = [];
    for (let i = 0; i < 15; i++) {
      const cookies = jar.get(new URL(url).host);
      const cookie = cookies?.size ? [...cookies].map(([k, v]) => `${k}=${v}`).join('; ') : null;
      const res = await fetch(url, {
        ...opts,
        headers: { 'User-Agent': PELO_UA, ...(opts.headers || {}), ...(cookie ? { Cookie: cookie } : {}) },
        redirect: 'manual',
        signal: AbortSignal.timeout(30_000),
      });
      storeCookies(url, res);
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).href;
        hops.push(url);
        // 307/308 must preserve method and body; other 3xx downgrade to GET.
        if (res.status !== 307 && res.status !== 308) opts = { method: 'GET' };
        continue;
      }
      return { res, finalUrl: url, hops };
    }
    throw new Error('too many redirects');
  };
  const findCode = r => [r.finalUrl, ...r.hops]
    .map(u => new URL(u).searchParams.get('code')).find(Boolean);

  // 1. /authorize → login page URL + state + CSRF cookie
  const verifier = randStr(64);
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const nonce = randStr(32);
  const init = await request(PELO_AUTH + '/authorize?' + new URLSearchParams({
    client_id: PELO_CLIENT_ID, audience: PELO_API + '/', scope: PELO_SCOPE,
    response_type: 'code', response_mode: 'query', redirect_uri: PELO_REDIRECT,
    state: randStr(32), nonce, code_challenge: challenge,
    code_challenge_method: 'S256', auth0Client: PELO_AUTH0_CLIENT,
  }));
  const loginUrl = init.hops[0] || init.finalUrl;
  const state = new URL(loginUrl).searchParams.get('state');
  const csrf = jar.get(new URL(PELO_AUTH).host)?.get('_csrf');
  if (!csrf || !state) throw new Error('peloton authorize flow changed: missing csrf/state');

  // 2. submit credentials
  const cred = await request(PELO_AUTH + '/usernamepassword/login', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json', Accept: '*/*',
      Origin: PELO_AUTH, Referer: loginUrl, 'Auth0-Client': PELO_AUTH0_CLIENT,
    },
    body: JSON.stringify({
      client_id: PELO_CLIENT_ID, redirect_uri: PELO_REDIRECT, tenant: 'peloton-prod',
      response_type: 'code', scope: PELO_SCOPE, audience: PELO_API + '/',
      _csrf: csrf, state, _intstate: 'deprecated', nonce,
      username: login, password, connection: 'pelo-user-password',
      code_challenge: challenge, code_challenge_method: 'S256',
    }),
  });
  if (cred.res.status >= 400) {
    throw new Error(`peloton login failed for ${login} (HTTP ${cred.res.status}) — check credentials`);
  }

  // 3. Auth0 returns a self-submitting form that lands on callback?code=…
  let code = findCode(cred);
  if (!code) {
    const html = await cred.res.text();
    const action = html.match(/<form[^>]*action="([^"]*)"/i)?.[1];
    if (!action) throw new Error('peloton login flow changed: no redirect and no callback form');
    const decode = s => s.replace(/&#(\d+);/g, (_, d) => String.fromCharCode(d))
      .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
    const fields = new URLSearchParams();
    for (const inp of html.matchAll(/<input[^>]+type="hidden"[^>]*>/gi)) {
      const name = inp[0].match(/name="([^"]*)"/i)?.[1];
      if (name) fields.set(name, decode(inp[0].match(/value="([^"]*)"/i)?.[1] ?? ''));
    }
    const form = await request(new URL(action, PELO_AUTH).href, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: fields.toString(),
    });
    code = findCode(form);
    if (!code) throw new Error('peloton login flow changed: no authorization code');
  }

  // 4. exchange code for tokens
  const res = await fetch(PELO_AUTH + '/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': PELO_UA },
    body: JSON.stringify({
      grant_type: 'authorization_code', client_id: PELO_CLIENT_ID,
      code_verifier: verifier, code, redirect_uri: PELO_REDIRECT,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  const token = await res.json().catch(() => ({}));
  if (!res.ok || !token.access_token) throw new Error(`peloton token exchange failed (HTTP ${res.status})`);
  return token;
}

// Tokens last 48h and come with a refresh token; cache per login so repeat
// backups skip the whole browser dance.
const peloTokens = new Map();

async function getPeloToken(acc) {
  const cached = peloTokens.get(acc.login);
  if (cached && Date.now() < cached.expiresAt - 60_000) return cached.accessToken;
  let token = null;
  if (cached?.refreshToken) {
    const res = await fetch(PELO_AUTH + '/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': PELO_UA },
      body: JSON.stringify({
        grant_type: 'refresh_token', client_id: PELO_CLIENT_ID, refresh_token: cached.refreshToken,
      }),
      signal: AbortSignal.timeout(30_000),
    }).catch(() => null);
    if (res?.ok) token = await res.json().catch(() => null);
  }
  if (!token?.access_token) token = await peloOAuthLogin(acc.login, acc.password);
  peloTokens.set(acc.login, {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || cached?.refreshToken,
    expiresAt: Date.now() + (token.expires_in || 3600) * 1000,
  });
  return token.access_token;
}

async function peloApi(pathname, accessToken) {
  for (let attempt = 0; ; attempt++) {
    await sleep(300);
    const res = await fetch(PELO_API + pathname, {
      headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'User-Agent': PELO_UA },
      signal: AbortSignal.timeout(30_000),
    });
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status >= 500) && attempt < 2) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`peloton ${pathname.split('?')[0]} → HTTP ${res.status}`);
  }
}

const pelotonState = {
  running: false, phase: 'idle', error: null, result: null, startedAt: null,
  username: null, accountsDone: 0, accountsTotal: 0,
  totalWorkouts: 0, processedWorkouts: 0, samples: 0,
};

async function backupPelotonAccount(acc) {
  Object.assign(pelotonState, {
    phase: 'login', username: acc.login,
    totalWorkouts: 0, processedWorkouts: 0, samples: 0,
  });
  const token = await getPeloToken(acc);
  const me = await peloApi('/api/me', token);
  pelotonState.username = me.username;

  pelotonState.phase = 'listing';
  const workouts = [];
  for (let page = 0, pages = 1; page < pages; page++) {
    const res = await peloApi(
      `/api/user/${me.id}/workouts?joins=ride,ride.instructor&limit=100&page=${page}`, token);
    workouts.push(...(res.data || []));
    pages = res.page_count || 1;
  }

  pelotonState.phase = 'workouts';
  pelotonState.totalWorkouts = workouts.length;
  const workoutRows = [], metricRows = [], muscleRows = [];
  for (const w of workouts) {
    const row = {
      id: w.id,
      start: w.start_time ? new Date(w.start_time * 1000).toISOString() : '',
      end: w.end_time ? new Date(w.end_time * 1000).toISOString() : '',
      discipline: w.fitness_discipline,
      type: w.workout_type,
      status: w.status,
      title: w.ride?.title ?? w.title ?? '',
      instructor: w.ride?.instructor?.name ?? '',
      duration_secs: w.ride?.duration ?? '',
      total_work: w.total_work,
    };
    try {
      const graph = await peloApi(`/api/workout/${w.id}/performance_graph?every_n=1`, token);
      for (const sum of graph.summaries || []) row[sum.slug] = sum.value;
      const ez = graph.effort_zones;
      if (ez) {
        row.strive_score = ez.total_effort_points;
        const zones = ez.heart_rate_zone_durations || {};
        for (let i = 1; i <= 5; i++) row[`hr_z${i}_secs`] = zones[`heart_rate_z${i}_duration`];
      }
      // "Body Activity" in the app: per-muscle-group scores.
      for (const m of graph.muscle_group_score || []) muscleRows.push({ workoutId: w.id, ...m });
      const metrics = graph.metrics || [];
      for (const m of metrics) {
        row[`avg_${m.slug}`] = m.average_value;
        row[`max_${m.slug}`] = m.max_value;
      }
      const secs = graph.seconds_since_pedaling_start || [];
      for (let i = 0; i < secs.length; i++) {
        const mr = { workoutId: w.id, second: secs[i] };
        for (const m of metrics) mr[m.slug] = m.values?.[i];
        metricRows.push(mr);
      }
      pelotonState.samples = metricRows.length;
    } catch (err) {
      // Some disciplines (meditation, stretching) have no performance graph.
      row.graph_error = err.message;
    }
    workoutRows.push(row);
    pelotonState.processedWorkouts++;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const user = String(me.username || 'user').replace(/[^\w.-]/g, '');
  const dir = path.join(__dirname, 'backups', `${stamp}-peloton-${user}`);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'workouts.csv'), toCsv(workoutRows));
  fs.writeFileSync(path.join(dir, 'metrics.csv'), toCsv(metricRows));
  fs.writeFileSync(path.join(dir, 'muscle_groups.csv'), toCsv(muscleRows));
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    createdAt: new Date().toISOString(),
    source: 'peloton',
    user: me.username,
    counts: { workouts: workoutRows.length, samples: metricRows.length, muscles: muscleRows.length },
    note: 'Per-second metrics at every_n=1. Strive score + HR zones + muscle groups from effort_zones/muscle_group_score. Timestamps UTC. IDs are Peloton cloud IDs.',
  }, null, 2));
  return { dir, username: me.username, workouts: workoutRows.length, samples: metricRows.length };
}

async function backupPeloton() {
  const accounts = peloAccounts();
  if (!accounts.length) {
    throw new Error('no Peloton credentials in env — start the server via: '
      + 'av inject +PELOTON_LOGIN +PELOTON_PASSWORD -- npm run serve');
  }
  Object.assign(pelotonState, {
    running: true, phase: 'login', error: null, result: null,
    startedAt: new Date().toISOString(),
    username: null, accountsDone: 0, accountsTotal: accounts.length,
    totalWorkouts: 0, processedWorkouts: 0, samples: 0,
  });
  const results = [];
  for (const acc of accounts) {
    results.push(await backupPelotonAccount(acc));
    pelotonState.accountsDone++;
  }
  return results;
}

function listBackups() {
  const root = path.join(__dirname, 'backups');
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .filter(name => fs.existsSync(path.join(root, name, 'manifest.json')))
    .map(name => {
      try {
        const m = JSON.parse(fs.readFileSync(path.join(root, name, 'manifest.json'), 'utf8'));
        return { name, createdAt: m.createdAt, counts: m.counts, source: m.source || 'voltra', user: m.user };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.name.localeCompare(a.name));
}

// Inverse of toCsv, with quote support; '' → null, numeric strings → numbers.
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
    // ID columns stay strings: a 32-char hex Peloton id that happens to be
    // all digits would otherwise be mangled into float notation.
    if (v !== '' && !/id$/i.test(name) && /^-?\d+(\.\d+)?$/.test(v)) v = Number(v);
    return [name, v === '' ? null : v];
  })));
}

// Newest peloton backup per user.
function latestPelotonBackups() {
  const byUser = new Map();
  for (const b of listBackups()) {
    if (b.source === 'peloton' && b.user && !byUser.has(b.user)) byUser.set(b.user, b);
  }
  return [...byUser.values()];
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

  if (req.method === 'POST' && pathname === '/api/backup/peloton') {
    if (!requireJson(req, res)) return;
    if (pelotonState.running) return json(res, 409, { ok: false, error: 'peloton backup already running' });
    backupPeloton()
      .then(result => { pelotonState.phase = 'done'; pelotonState.result = result; })
      .catch(err => { pelotonState.phase = 'error'; pelotonState.error = err.message; })
      .finally(() => { pelotonState.running = false; });
    return json(res, 202, { ok: true, data: { started: true } });
  }

  if (req.method === 'GET' && pathname === '/api/backup/peloton/status') {
    return json(res, 200, { ok: true, data: pelotonState });
  }

  // Hand-maintained profile (labels/profile.json): analysis parameters the
  // APIs cannot provide — body weight, age, sex. Future: Apple Health.
  if (req.method === 'GET' && pathname === '/api/profile') {
    const file = path.join(__dirname, 'labels', 'profile.json');
    if (!fs.existsSync(file)) return json(res, 200, { ok: true, data: {} });
    try {
      return json(res, 200, { ok: true, data: JSON.parse(fs.readFileSync(file, 'utf8')) });
    } catch {
      return json(res, 500, { ok: false, error: 'labels/profile.json is corrupt' });
    }
  }

  if (req.method === 'GET' && pathname === '/api/peloton/workouts') {
    try {
      const data = latestPelotonBackups().map(b => ({
        user: b.user, dir: b.name, createdAt: b.createdAt,
        workouts: fromCsv(fs.readFileSync(path.join(__dirname, 'backups', b.name, 'workouts.csv'), 'utf8')),
      }));
      return json(res, 200, { ok: true, data });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/peloton/metrics') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const dir = q.get('dir') || '', workout = q.get('workout') || '';
    // /^\.+$/ blocks '.', '..' — the character class alone admits them.
    if (!/^[\w.-]+$/.test(dir) || /^\.+$/.test(dir) || !/^[\w-]+$/.test(workout)) {
      return json(res, 400, { ok: false, error: 'bad dir or workout param' });
    }
    const file = path.join(__dirname, 'backups', dir, 'metrics.csv');
    if (!fs.existsSync(file)) return json(res, 404, { ok: false, error: 'no metrics for that backup' });
    try {
      // metrics.csv is hundreds of thousands of rows; workoutId is the first
      // column and never quoted, so cheap line filtering beats full parsing.
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      const keep = [lines[0], ...lines.filter((l, i) => i > 0 && l.startsWith(workout + ','))];
      const musclesFile = path.join(__dirname, 'backups', dir, 'muscle_groups.csv');
      const muscles = fs.existsSync(musclesFile)
        ? fromCsv(fs.readFileSync(musclesFile, 'utf8')).filter(r => String(r.workoutId) === workout)
        : [];
      return json(res, 200, { ok: true, data: { metrics: fromCsv(keep.join('\n')), muscles } });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  // Per-ride cardio fitness numbers (no aggregation): EF = steady-state
  // watts per heartbeat, decoupling = EF fade first half → second half.
  if (req.method === 'GET' && pathname === '/api/peloton/fitness') {
    const q = new URL(req.url, 'http://localhost').searchParams;
    const dir = q.get('dir') || '';
    if (!/^[\w.-]+$/.test(dir) || /^\.+$/.test(dir)) {
      return json(res, 400, { ok: false, error: 'bad dir param' });
    }
    const base = path.join(__dirname, 'backups', dir);
    if (!fs.existsSync(path.join(base, 'workouts.csv'))) {
      return json(res, 404, { ok: false, error: 'no such backup' });
    }
    try {
      const title = q.get('title'), discipline = q.get('discipline');
      // Custom sets span disciplines and bound duration, e.g. "trainer
      // sessions" = strength+stretching at 45-65 minutes.
      const disciplines = (q.get('disciplines') || '').split(',').filter(Boolean);
      const minSecs = Number(q.get('minSecs')) || 0;
      const maxSecs = Number(q.get('maxSecs')) || Infinity;
      const from = q.get('from'), to = q.get('to');
      const weightKg = q.get('weightLbs') ? Number(q.get('weightLbs')) * 0.45359 : null;
      const WARMUP = 120;
      // Below any living resting HR — strap dropout noise, treated as missing.
      const HR_FLOOR = 30;
      const all = fromCsv(fs.readFileSync(path.join(base, 'workouts.csv'), 'utf8'));
      const inDiscipline = w =>
        (disciplines.length ? disciplines.includes(w.discipline) : !discipline || w.discipline === discipline);
      // Personal HRmax proxy: 3rd-highest per-workout max within the requested
      // discipline(s) — a single strap spike would permanently inflate a plain
      // max, and HRmax differs across modalities.
      const hrPool = ((disciplines.length || discipline) ? all.filter(inDiscipline) : all)
        .map(w => w.max_heart_rate).filter(v => v > 0).sort((a, b) => b - a);
      const hrMax = hrPool.length ? hrPool[Math.min(2, hrPool.length - 1)] : null;
      const candidates = all
        .filter(w => w.status === 'COMPLETE'
          && inDiscipline(w)
          && (!title || (w.title || '') === title)
          && (!from || String(w.start) >= from)
          && (!to || String(w.start).slice(0, 10) <= to))
        .sort((a, b) => String(a.start).localeCompare(String(b.start)));

      // Optionally merge back-to-back recordings (paused/restarted mid-
      // session) into one logical session. The duration band then applies
      // to the merged wall-clock span, so a split trainer hour still counts.
      const mergeGap = Number(q.get('mergeGapMins')) || 0;
      const clusters = [];
      for (const w of candidates) {
        const startMs = Date.parse(w.start), endMs = Date.parse(w.end || w.start) || startMs;
        const prev = clusters[clusters.length - 1];
        if (mergeGap > 0 && prev && (startMs - prev.endMs) / 60_000 <= mergeGap) {
          prev.members.push({ w, offset: Math.round((startMs - prev.startMs) / 1000) });
          prev.endMs = Math.max(prev.endMs, endMs);
        } else {
          clusters.push({ startMs, endMs, members: [{ w, offset: 0 }] });
        }
      }
      const byId = new Map();
      const workouts = clusters.map(c => {
        const ws = c.members.map(m => m.w);
        let session = ws[0];
        if (ws.length > 1) {
          const sum = pick => ws.reduce((total, w) => total + (pick(w) || 0), 0);
          const durSum = sum(w => w.duration_secs) || 1;
          session = {
            ...ws[0],
            title: `${ws[0].title || ws[0].discipline} (+${ws.length - 1} merged)`,
            duration_secs: Math.round((c.endMs - c.startMs) / 1000),
            end: ws[ws.length - 1].end,
            avg_heart_rate: ws.some(w => w.avg_heart_rate)
              ? sum(w => (w.avg_heart_rate || 0) * (w.duration_secs || 0)) / durSum : null,
            max_heart_rate: Math.max(...ws.map(w => w.max_heart_rate || 0)) || null,
            strive_score: ws.some(w => w.strive_score != null) ? sum(w => w.strive_score) : null,
            calories: ws.some(w => (w.calories ?? w.total_calories) != null)
              ? sum(w => w.calories ?? w.total_calories) : null,
            total_calories: null,
            total_output: ws.some(w => (w.total_output ?? w.total_total_output) != null)
              ? sum(w => w.total_output ?? w.total_total_output) : null,
            total_total_output: null,
            distance: ws.some(w => (w.distance ?? w.total_distance) != null)
              ? sum(w => w.distance ?? w.total_distance) : null,
            total_distance: null,
          };
          for (let z = 1; z <= 5; z++) {
            session[`hr_z${z}_secs`] = sum(w => w[`hr_z${z}_secs`]) || null;
          }
        }
        return { session, members: c.members };
      }).filter(({ session }) =>
        (session.duration_secs || 0) >= minSecs && (session.duration_secs || 0) <= maxSecs
      ).map(({ session, members }) => {
        // Per-second metrics of every member recording accumulate into the
        // session, with seconds offset onto the merged timeline.
        for (const m of members) byId.set(String(m.w.id), { session, offset: m.offset });
        return session;
      });

      // Workload signal, in preference order: power, speed, then pace
      // (outdoor walks record pace only; inverted to speed below so higher
      // is always better). With none, the analysis degrades to HR-only
      // intensity metrics.
      const countWith = key => workouts.filter(w => w[`avg_${key}`] != null).length;
      const wKey = countWith('output') >= 3 ? 'output'
        : countWith('speed') >= 3 ? 'speed'
        : countWith('pace') >= 3 ? 'pace' : null;

      // Single pass over metrics.csv with plain accumulators — the file is
      // hundreds of thousands of rows, so no per-row object churn.
      const lines = fs.readFileSync(path.join(base, 'metrics.csv'), 'utf8').split('\n');
      const header = (lines[0] || '').split(',');
      const iId = header.indexOf('workoutId'), iSec = header.indexOf('second');
      const iW = wKey ? header.indexOf(wKey) : -1, iHr = header.indexOf('heart_rate');
      const acc = new Map();
      for (let i = 1; i < lines.length; i++) {
        const parts = lines[i].split(',');
        const hit = byId.get(parts[iId]);
        if (!hit) continue;
        const w = hit.session;
        const sec = +parts[iSec] + hit.offset;
        let a = acc.get(String(w.id));
        if (!a) {
          acc.set(String(w.id), a = {
            wSum: 0, wN: 0, hrSum: 0, hrN: 0, maxHr: 0,
            h: [[0, 0, 0], [0, 0, 0]], mins: [], hr10: [], wl10: [],
          });
        }
        const hrRaw = parts[iHr] === '' || parts[iHr] == null ? 0 : +parts[iHr];
        const hr = hrRaw >= HR_FLOOR ? hrRaw : 0;
        let wl = iW < 0 || parts[iW] === '' || parts[iW] == null ? null : +parts[iW];
        // Pace is min/mi (lower = faster): invert to mph so the workload
        // scale runs the same direction as power and speed.
        if (wKey === 'pace') wl = wl > 0 ? 60 / wl : null;
        // Full start→finish 10s HR + workload bins for the overlay chart —
        // unlike the fitness accumulators, no warmup skip.
        if (hr > 0) {
          const b = Math.floor(sec / 10);
          const bin = a.hr10[b] || (a.hr10[b] = [0, 0]);
          bin[0] += hr; bin[1]++;
        }
        if (wl != null) {
          const b = Math.floor(sec / 10);
          const bin = a.wl10[b] || (a.wl10[b] = [0, 0]);
          bin[0] += wl; bin[1]++;
        }
        if (!(sec > WARMUP)) continue;
        if (wl != null) { a.wSum += wl; a.wN++; }
        if (hr > 0) { a.hrSum += hr; a.hrN++; }
        if (hr > a.maxHr) a.maxHr = hr;
        if (wl != null && hr > 0) {
          const mid = WARMUP + ((w.duration_secs || 1200) - WARMUP) / 2;
          const half = a.h[sec <= mid ? 0 : 1];
          half[0] += wl; half[1] += hr; half[2]++;
          // Minute bins for the VO2 proxy regression. HR lags power by
          // ~30-60s, so per-second pairs flatten the slope and wildly
          // over-extrapolate; minute means plus a 30s HR shift (HR is
          // credited to the minute of the power that caused it) absorb it.
          const mw = Math.floor(sec / 60);
          const wBin = a.mins[mw] || (a.mins[mw] = [0, 0, 0, 0]);
          wBin[0] += wl; wBin[1]++;
          const mh = Math.floor((sec - 30) / 60);
          if (mh >= 0) {
            const hBin = a.mins[mh] || (a.mins[mh] = [0, 0, 0, 0]);
            hBin[2] += hr; hBin[3]++;
          }
        }
      }

      const rides = workouts.map(w => {
        const a = acc.get(String(w.id));
        const [h1, h2] = a?.h || [[0, 0, 0], [0, 0, 0]];
        const pairs = h1[2] + h2[2];
        // Zone durations came from effort_zones at backup time; Edwards
        // TRIMP = Σ minutes-in-zone × zone number, the standard HR-only
        // training-load measure.
        const zones = [1, 2, 3, 4, 5].map(z => w[`hr_z${z}_secs`] || 0);
        const zoneTotal = zones.reduce((sum, v) => sum + v, 0);
        // [secondsFromStart, value] pairs; forEach skips sparse-array holes.
        const hrSeries = [];
        (a?.hr10 || []).forEach((bin, i) => {
          if (bin && bin[1]) hrSeries.push([i * 10, Math.round(bin[0] / bin[1])]);
        });
        const outSeries = [];
        (a?.wl10 || []).forEach((bin, i) => {
          if (bin && bin[1]) outSeries.push([i * 10, +(bin[0] / bin[1]).toFixed(1)]);
        });
        const ride = {
          id: w.id, start: w.start, title: w.title,
          avgOutput: a?.wN ? a.wSum / a.wN : null,
          avgHr: a?.hrN ? a.hrSum / a.hrN : null,
          maxHr: a?.maxHr || null,
          pctHrMax: a?.hrN && hrMax ? (a.hrSum / a.hrN / hrMax) * 100 : null,
          trimp: zoneTotal ? zones.reduce((sum, secs, i) => sum + (secs / 60) * (i + 1), 0) : null,
          zones: zoneTotal ? zones : null,
          ef: null, decoupling: null,
          totalOutput: w.total_output ?? w.total_total_output ?? null,
          distance: w.distance ?? w.total_distance ?? null,
          calories: w.calories ?? w.total_calories ?? null,
          strive: w.strive_score ?? null,
          hr: hrSeries.length > 1 ? hrSeries : null,
          out: outSeries.length > 1 ? outSeries : null,
        };
        // EF over sums == meanOutput/meanHr; require ~5min of paired samples.
        if (pairs >= 300) {
          ride.ef = (h1[0] + h2[0]) / (h1[1] + h2[1]);
          // ≥2min of paired samples per half; a sliver of HR in one half
          // makes the ratio meaningless.
          if (h1[2] >= 120 && h2[2] >= 120) {
            const ef1 = h1[0] / h1[1], ef2 = h2[0] / h2[1];
            ride.decoupling = ((ef1 - ef2) / ef1) * 100;
          }
          // Submaximal VO2max proxy (YMCA-style): OLS of minute-mean HR on
          // minute-mean power, extrapolated to personal HRmax = predicted
          // max aerobic power. ACSM cycling equation converts to ml/kg/min
          // when weight is known. Guards: enough bins, real power variance
          // within the ride, physiological slope — otherwise the ride is
          // too steady to extrapolate and gets no estimate.
          const bins = (a.mins || [])
            .filter(bin => bin && bin[1] >= 30 && bin[3] >= 30)
            .map(bin => ({ w: bin[0] / bin[1], hr: bin[2] / bin[3] }));
          // The extrapolation and ACSM conversion are power equations only.
          if (wKey === 'output' && hrMax && bins.length >= 8) {
            const ws = bins.map(bin => bin.w);
            const n = bins.length;
            const sW = ws.reduce((sum, v) => sum + v, 0);
            const sH = bins.reduce((sum, bin) => sum + bin.hr, 0);
            const sWH = bins.reduce((sum, bin) => sum + bin.w * bin.hr, 0);
            const sW2 = ws.reduce((sum, v) => sum + v * v, 0);
            const den = n * sW2 - sW * sW;
            const range = Math.max(...ws) - Math.min(...ws);
            if (den > 0 && range >= 30) {
              const slope = (n * sWH - sW * sH) / den;
              const intercept = (sH - slope * sW) / n;
              if (slope >= 0.1) {
                // Fitted HR at a fixed reference workload — falling over
                // time = fitter. Only emitted when 100W actually sits
                // inside the ridden power band (interpolation, never
                // extrapolation).
                if (Math.min(...ws) <= 100 && Math.max(...ws) >= 100) {
                  ride.hrAt100 = intercept + slope * 100;
                }
                const wMax = (hrMax - intercept) / slope;
                if (wMax > 100 && wMax < 500) {
                  ride.wAtHrMax = wMax;
                  if (weightKg) ride.vo2 = (10.8 * wMax + 7 * weightKg) / weightKg;
                }
              }
            }
          }
        }
        return ride;
      });
      // Pace is served as speed after inversion, so the client only ever
      // sees two workload flavors.
      return json(res, 200, {
        ok: true,
        data: { rides, hrMax, workloadKey: wKey === 'pace' ? 'speed' : wKey },
      });
    } catch (e) {
      return json(res, 500, { ok: false, error: e.message });
    }
  }

  if (req.method === 'GET' && pathname === '/api/backups') {
    return json(res, 200, { ok: true, data: listBackups() });
  }

  // --- Apple Health ingest + query (DuckDB/Parquet store) ---
  if (req.method === 'POST' && pathname === '/api/health/ingest') {
    if (!requireJson(req, res)) return;
    if (healthState.running) return json(res, 409, { ok: false, error: 'ingest already running' });
    const found = latestHealthBackup();
    if (!found) return json(res, 400, { ok: false, error: 'no apple-health backup with export.zip under backups/' });
    duck()
      .then(con => runHealthIngest(con, found.zip, found.dir))
      .catch(() => { /* errors surface via healthState.phase */ });
    return json(res, 202, { ok: true, data: { started: true } });
  }

  if (req.method === 'GET' && pathname === '/api/health/ingest/status') {
    return json(res, 200, { ok: true, data: healthState });
  }

  if (req.method === 'GET' && pathname === '/api/health/summary') {
    if (!fs.existsSync(path.join(STORE, 'records'))) {
      return json(res, 200, { ok: true, data: { ingested: false } });
    }
    duck().then(async con => {
      await setupViews(con);
      const one = async sql => (await con.runAndReadAll(sql)).getRowObjectsJson();
      const [overview] = await one(
        `SELECT count(*) AS records, count(DISTINCT metric) AS metrics,
                min(start_ts)::VARCHAR AS from_ts, max(start_ts)::VARCHAR AS to_ts FROM ah_records`);
      const top = await one(`SELECT metric, count(*) AS n FROM ah_records GROUP BY 1 ORDER BY n DESC LIMIT 20`);
      const sources = await one(`SELECT source, count(*) AS n FROM ah_records GROUP BY 1 ORDER BY n DESC LIMIT 12`);
      let workouts = [];
      if (fs.existsSync(path.join(STORE, 'workouts.parquet'))) {
        workouts = await one(`SELECT activity, count(*) AS n, round(sum(duration)/60, 1) AS hours
                              FROM ah_workouts GROUP BY 1 ORDER BY n DESC LIMIT 20`);
      }
      json(res, 200, { ok: true, data: { ingested: true, overview, top, sources, workouts } });
    }).catch(e => json(res, 500, { ok: false, error: e.message }));
    return;
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
          shotDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vigor-chat-'));
          shotPath = path.join(shotDir, 'charts.png');
          fs.writeFileSync(shotPath, Buffer.from(parsed.screenshot.slice('data:image/png;base64,'.length), 'base64'));
        } catch { shotDir = shotPath = null; }
      }

      const prompt = [
        'You are a strength coach embedded in VIGOR, a personal health dashboard whose Lift page controls a VOLTRA cable machine with per-rep telemetry (ROM, resistance, velocity, power).',
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
  console.log(`VIGOR → http://${HOST}:${PORT}  (voltra: ${VOLTRA_BIN})`);
});
