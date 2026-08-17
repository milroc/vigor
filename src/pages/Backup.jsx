import { useCallback, useEffect, useRef, useState } from 'react';
import { startBackup, getBackupStatus, listBackups } from '../api.js';
import ProgressBar from '../components/ProgressBar.jsx';
import shared from '../styles/shared.module.css';
import s from './Backup.module.css';

export default function Backup() {
  const [state, setState] = useState(null);
  const [backups, setBackups] = useState([]);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const refreshBackups = useCallback(() => {
    listBackups().then(setBackups).catch(() => {});
  }, []);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await getBackupStatus();
        setState(st);
        if (!st.running && st.phase !== 'idle') {
          stopPolling();
          if (st.phase === 'done') refreshBackups();
        }
      } catch { /* server briefly unreachable; keep polling */ }
    }, 1000);
  }, [stopPolling, refreshBackups]);

  useEffect(() => {
    getBackupStatus().then(st => {
      setState(st);
      if (st.running) poll();
    }).catch(() => {});
    refreshBackups();
    return stopPolling;
  }, [poll, refreshBackups, stopPolling]);

  const begin = async () => {
    setConfirming(false);
    setError(null);
    try {
      await startBackup();
      poll();
    } catch (e) {
      setError(e.message);
    }
  };

  const running = !!state?.running;

  return (
    <main className={s.main}>
      <h2 className={shared.title}>Backup All Data</h2>
      <p className={s.intro}>
        Exhaustively pulls your <strong>entire training history</strong> from the Beyond cloud —
        every workout, every set, every rep with full concentric/eccentric force, velocity, and power
        detail — and writes it to timestamped CSVs (<code>workouts.csv</code>, <code>sets.csv</code>,{' '}
        <code>reps.csv</code> + <code>manifest.json</code>) under <code>backups/</code>.
        Requests are spaced ~1s apart to respect Beyond's API rate limits, so expect
        roughly 2–5 minutes depending on history size.
      </p>

      {!running && !confirming && (
        <button className={`${shared.btn} ${shared.hazard}`} onClick={() => setConfirming(true)}>
          Backup All Data → CSV
        </button>
      )}

      {confirming && (
        <div className={`${shared.panel} ${s.confirmPanel}`}>
          <p>
            This will make one Beyond API request per workout and per set, throttled to
            ~1 per second. Your API key was rate-limited once already today — avoid running
            other data-heavy commands while this is in flight. Proceed?
          </p>
          <div className={s.confirmRow}>
            <button className={`${shared.btn} ${s.go}`} onClick={begin}>Start Backup</button>
            <button className={shared.btn} onClick={() => setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {running && state && (
        <div className={shared.panel}>
          <ProgressBar state={state} />
        </div>
      )}

      {!running && state?.phase === 'done' && state.result && (
        <div className={s.done}>
          Backup complete: <strong>{state.result.workouts} workouts</strong>,{' '}
          <strong>{state.result.sets} sets</strong>, <strong>{state.result.reps} reps</strong>
          <div className={s.dir}>{state.result.dir}</div>
        </div>
      )}

      {(error || (!running && state?.phase === 'error')) && (
        <div className={s.error}>backup failed: {error || state.error}</div>
      )}

      <section className={s.prevSection}>
        <h2 className={shared.title}>Previous Backups</h2>
        {backups.length === 0 && <p className={s.intro}>No backups yet.</p>}
        {backups.length > 0 && (
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Created</th><th className={shared.num}>Workouts</th>
                <th className={shared.num}>Sets</th><th className={shared.num}>Reps</th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.name}>
                  <td>{new Date(b.createdAt).toLocaleString()}</td>
                  <td className={shared.num}>{b.counts.workouts}</td>
                  <td className={shared.num}>{b.counts.sets}</td>
                  <td className={shared.num}>{b.counts.reps}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
