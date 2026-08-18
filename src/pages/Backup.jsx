import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startBackup, getBackupStatus, startPelotonBackup, getPelotonBackupStatus, listBackups,
} from '../api.js';
import ProgressBar from '../components/ProgressBar.jsx';
import shared from '../styles/shared.module.css';
import s from './Backup.module.css';

function useBackupJob(start, getStatus, onDone) {
  const [state, setState] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState(null);
  const pollRef = useRef(null);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const poll = useCallback(() => {
    stopPolling();
    pollRef.current = setInterval(async () => {
      try {
        const st = await getStatus();
        setState(st);
        if (!st.running && st.phase !== 'idle') {
          stopPolling();
          if (st.phase === 'done') onDone();
        }
      } catch { /* server briefly unreachable; keep polling */ }
    }, 1000);
  }, [stopPolling, getStatus, onDone]);

  useEffect(() => {
    getStatus().then(st => {
      setState(st);
      if (st.running) poll();
    }).catch(() => {});
    return stopPolling;
  }, [getStatus, poll, stopPolling]);

  const begin = async () => {
    setConfirming(false);
    setError(null);
    try {
      await start();
      poll();
    } catch (e) {
      setError(e.message);
    }
  };

  return { state, confirming, setConfirming, error, begin, running: !!state?.running };
}

export default function Backup() {
  const [backups, setBackups] = useState([]);

  const refreshBackups = useCallback(() => {
    listBackups().then(setBackups).catch(() => {});
  }, []);

  useEffect(refreshBackups, [refreshBackups]);

  const voltra = useBackupJob(startBackup, getBackupStatus, refreshBackups);
  const peloton = useBackupJob(startPelotonBackup, getPelotonBackupStatus, refreshBackups);

  return (
    <main className={s.main}>
      <h2 className={shared.title}>Backup VOLTRA</h2>
      <p className={s.intro}>
        Exhaustively pulls your <strong>entire training history</strong> from the Beyond cloud —
        every workout, every set, every rep with full concentric/eccentric force, velocity, and power
        detail — and writes it to timestamped CSVs (<code>workouts.csv</code>, <code>sets.csv</code>,{' '}
        <code>reps.csv</code> + <code>manifest.json</code>) under <code>backups/</code>.
        Requests are spaced ~1s apart to respect Beyond's API rate limits, so expect
        roughly 2–5 minutes depending on history size.
      </p>

      {!voltra.running && !voltra.confirming && (
        <button className={`${shared.btn} ${shared.hazard}`} onClick={() => voltra.setConfirming(true)}>
          Backup VOLTRA → CSV
        </button>
      )}

      {voltra.confirming && (
        <div className={`${shared.panel} ${s.confirmPanel}`}>
          <p>
            This will make one Beyond API request per workout and per set, throttled to
            ~1 per second. Your API key was rate-limited once already today — avoid running
            other data-heavy commands while this is in flight. Proceed?
          </p>
          <div className={s.confirmRow}>
            <button className={`${shared.btn} ${s.go}`} onClick={voltra.begin}>Start Backup</button>
            <button className={shared.btn} onClick={() => voltra.setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {voltra.running && voltra.state && (
        <div className={shared.panel}>
          <ProgressBar state={voltra.state} />
        </div>
      )}

      {!voltra.running && voltra.state?.phase === 'done' && voltra.state.result && (
        <div className={s.done}>
          Backup complete: <strong>{voltra.state.result.workouts} workouts</strong>,{' '}
          <strong>{voltra.state.result.sets} sets</strong>, <strong>{voltra.state.result.reps} reps</strong>
          <div className={s.dir}>{voltra.state.result.dir}</div>
        </div>
      )}

      {(voltra.error || (!voltra.running && voltra.state?.phase === 'error')) && (
        <div className={s.error}>backup failed: {voltra.error || voltra.state.error}</div>
      )}

      <section className={s.prevSection}>
        <h2 className={shared.title}>Backup Peloton</h2>
        <p className={s.intro}>
          Pulls the <strong>full Peloton history for every configured user</strong> — workout list
          with class and instructor plus <strong>per-second performance metrics</strong> (output,
          cadence, resistance, speed, heart rate where available) — into timestamped CSVs
          (<code>workouts.csv</code>, <code>metrics.csv</code> + <code>manifest.json</code>) under{' '}
          <code>backups/</code>, one folder per user. The server needs Peloton credentials in its
          environment: start it via{' '}
          <code>av inject +PELOTON_LOGIN +PELOTON_PASSWORD -- npm run serve</code>{' '}
          (add <code>+PELOTON_LOGIN_2 +PELOTON_PASSWORD_2</code> for the second user).
        </p>

        {!peloton.running && !peloton.confirming && (
          <button className={`${shared.btn} ${shared.hazard}`} onClick={() => peloton.setConfirming(true)}>
            Backup Peloton → CSV
          </button>
        )}

        {peloton.confirming && (
          <div className={`${shared.panel} ${s.confirmPanel}`}>
            <p>
              This logs in to Peloton as each configured user and makes one API request per
              workout, spaced ~300ms apart — expect a few minutes per user. Proceed?
            </p>
            <div className={s.confirmRow}>
              <button className={`${shared.btn} ${s.go}`} onClick={peloton.begin}>Start Backup</button>
              <button className={shared.btn} onClick={() => peloton.setConfirming(false)}>Cancel</button>
            </div>
          </div>
        )}

        {peloton.running && peloton.state && (
          <div className={shared.panel}>
            <ProgressBar
              state={peloton.state}
              detail={`user ${peloton.state.accountsDone + 1}/${peloton.state.accountsTotal} · ${peloton.state.samples.toLocaleString()} samples`}
            />
          </div>
        )}

        {!peloton.running && peloton.state?.phase === 'done' && peloton.state.result && (
          <div className={s.done}>
            {peloton.state.result.map(r => (
              <div key={r.username}>
                <strong>{r.username}</strong>: {r.workouts} workouts,{' '}
                {r.samples.toLocaleString()} metric samples
                <div className={s.dir}>{r.dir}</div>
              </div>
            ))}
          </div>
        )}

        {(peloton.error || (!peloton.running && peloton.state?.phase === 'error')) && (
          <div className={s.error}>backup failed: {peloton.error || peloton.state.error}</div>
        )}
      </section>

      <section className={s.prevSection}>
        <h2 className={shared.title}>Previous Backups</h2>
        {backups.length === 0 && <p className={s.intro}>No backups yet.</p>}
        {backups.length > 0 && (
          <table className={shared.table}>
            <thead>
              <tr>
                <th>Created</th><th>Source</th><th>User</th>
                <th className={shared.num}>Workouts</th><th className={shared.num}>Detail</th>
              </tr>
            </thead>
            <tbody>
              {backups.map(b => (
                <tr key={b.name}>
                  <td>{new Date(b.createdAt).toLocaleString()}</td>
                  <td>{b.source}</td>
                  <td>{b.user || '—'}</td>
                  <td className={shared.num}>{b.counts.workouts}</td>
                  <td className={shared.num}>
                    {b.counts.samples != null
                      ? `${b.counts.samples.toLocaleString()} samples`
                      : `${b.counts.sets} sets · ${b.counts.reps} reps`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  );
}
