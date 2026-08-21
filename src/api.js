async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : '{}',
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data.data;
}

async function get(url) {
  const res = await fetch(url);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'request failed');
  return data.data;
}

export const runVoltra = args => post('/api/run', { args });
export const startBackup = () => post('/api/backup');
export const getBackupStatus = () => get('/api/backup/status');
export const startPelotonBackup = () => post('/api/backup/peloton');
export const getPelotonBackupStatus = () => get('/api/backup/peloton/status');
export const getProfile = () => get('/api/profile');
export const getPelotonWorkouts = () => get('/api/peloton/workouts');
export const getPelotonFitness = (dir, params) => {
  const q = new URLSearchParams({ dir });
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  return get(`/api/peloton/fitness?${q}`);
};
export const getPelotonMetrics = (dir, workoutId) =>
  get(`/api/peloton/metrics?dir=${encodeURIComponent(dir)}&workout=${encodeURIComponent(workoutId)}`);
export const listBackups = () => get('/api/backups');
export const sendChat = (messages, context, screenshot) => post('/api/chat', { messages, context, screenshot });
export const getTargets = () => get('/api/targets');
export const saveTargets = targets => post('/api/targets', targets);
export const listTelemetry = () => get('/api/telemetry');
export const getTelemetry = workoutId => get(`/api/telemetry/${workoutId}`);
export const saveTelemetry = (workoutId, data) => post(`/api/telemetry/${workoutId}`, data);
export const startHealthIngest = () => post('/api/health/ingest');
export const getHealthIngestStatus = () => get('/api/health/ingest/status');
export const getHealthSummary = () => get('/api/health/summary');
export const getHealthNeat = () => get('/api/health/neat');
export const getHealthCardio = () => get('/api/health/cardio');
export const getHealthDay = date => get(`/api/health/day?date=${encodeURIComponent(date)}`);
