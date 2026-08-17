import { useState } from 'react';
import { runVoltra } from '../api.js';
import shared from '../styles/shared.module.css';
import s from './QuickActions.module.css';

export default function QuickActions({ loaded, onAction, log }) {
  const [busy, setBusy] = useState(false);
  const [devices, setDevices] = useState(null);
  const [weight, setWeight] = useState('');

  async function run(label, args) {
    if (busy) return null;
    setBusy(true);
    log(`${label}…`);
    try {
      const data = await runVoltra(args);
      log(`${label} ok`);
      return data;
    } catch (e) {
      log(`${label} failed: ${e.message}`, true);
      return null;
    } finally {
      setBusy(false);
    }
  }

  const scan = async () => setDevices(await run('scan', ['scan', '--json']));

  const connect = async name => {
    const ok = await run(`connect ${name}`, ['connect', name, '--json']);
    if (ok) { setDevices(null); onAction(); }
  };

  const simple = (label, args) => async () => {
    const ok = await run(label, args);
    if (ok !== null) onAction();
  };

  const engageLoad = async () => {
    if (!window.confirm('Engage load? The motor will apply physical force to the cable.')) return;
    const ok = await run('load', ['load', '--json']);
    if (ok !== null) onAction();
  };

  const setLbs = async () => {
    const lbs = parseInt(weight, 10);
    if (!Number.isFinite(lbs) || lbs < 0 || lbs > 200) return log('enter a weight 0-200 lbs', true);
    const ok = await run(`set-weight ${lbs}`, ['set-weight', String(lbs), '--json']);
    if (ok !== null) onAction();
  };

  return (
    <section className={shared.section}>
      <h2 className={shared.title}>Quick Actions</h2>
      <div className={s.actions}>
        <button className={shared.btn} onClick={scan} disabled={busy}>Scan</button>
        <button className={shared.btn} onClick={simple('reconnect', ['reconnect', '--json'])} disabled={busy}>Reconnect</button>
        <button className={shared.btn} onClick={simple('unload', ['unload', '--json'])} disabled={busy}>Unload</button>
        <button className={shared.btn} onClick={onAction} disabled={busy}>Refresh</button>
        <button
          className={`${shared.btn} ${shared.hazard} ${s.full}` + (loaded ? ` ${shared.armed}` : '')}
          onClick={engageLoad} disabled={busy}
        >
          Load ▮ Engage
        </button>
      </div>
      <div className={s.weightRow}>
        <input
          type="number" min="0" max="200" step="1" placeholder="50"
          value={weight} onChange={e => setWeight(e.target.value)}
        />
        <button className={shared.btn} onClick={setLbs} disabled={busy}>Set lbs</button>
      </div>
      {devices && (
        <div className={s.devices}>
          {devices.length === 0 && <div className={s.deviceRow} style={{ cursor: 'default' }}><span>no devices found</span></div>}
          {devices.map(d => (
            <button key={d.id} className={s.deviceRow} onClick={() => connect(d.name)}>
              <span>{d.name}</span><span className={s.rssi}>{d.rssi} dBm</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
