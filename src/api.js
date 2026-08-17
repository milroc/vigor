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
export const listBackups = () => get('/api/backups');
export const sendChat = (messages, context, screenshot) => post('/api/chat', { messages, context, screenshot });
export const getTargets = () => get('/api/targets');
export const saveTargets = targets => post('/api/targets', targets);
export const listTelemetry = () => get('/api/telemetry');
export const getTelemetry = workoutId => get(`/api/telemetry/${workoutId}`);
export const saveTelemetry = (workoutId, data) => post(`/api/telemetry/${workoutId}`, data);
