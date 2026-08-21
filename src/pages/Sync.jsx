import { useCallback, useEffect, useRef, useState } from 'react';
import {
  startBackup, getBackupStatus, startPelotonBackup, getPelotonBackupStatus, listBackups,
  startHealthIngest, getHealthIngestStatus, getHealthSummary,
} from '../api.js';
import ProgressBar from '../components/ProgressBar.jsx';
import shared from '../styles/shared.module.css';
import s from './Sync.module.css';

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
      // A 409 means a job is already running (other tab, double-click):
      // poll anyway so the in-flight job is visible.
      poll();
    }
  };

  return { state, confirming, setConfirming, error, begin, running: !!state?.running };
}

// Apple Health ingest has no known total up front, so the bar stays
// indeterminate and we surface the live parsed-record count instead.
function HealthProgress({ state }) {
  const phaseLabel = {
    parsing: 'Parsing export.xml', loading: 'Writing Parquet', views: 'Building views',
  }[state.phase] || state.phase;
  return (
    <div>
      <div className={s.track}><div className={`${s.fill} ${s.indeterminate}`} /></div>
      <div className={s.progMeta}>
        <span className={s.phase}>{phaseLabel}…</span>
        <span>{(state.records ?? 0).toLocaleString()} records · {state.workouts ?? 0} workouts</span>
      </div>
    </div>
  );
}

function HealthSummary({ summary }) {
  const o = summary.overview || {};
  const from = o.from_ts ? String(o.from_ts).slice(0, 10) : '—';
  const to = o.to_ts ? String(o.to_ts).slice(0, 10) : '—';
  const top = summary.top || [];
  const maxN = top.length ? Math.max(...top.map(m => Number(m.n))) : 1;
  return (
    <div>
      <div className={s.statGrid}>
        <div className={s.stat}>
          <div className={s.k}>Records</div>
          <div className={s.v}>{Number(o.records || 0).toLocaleString()}</div>
          <div className={s.sub}>{Number(o.metrics || 0)} metric types</div>
        </div>
        <div className={s.stat}>
          <div className={s.k}>Workouts</div>
          <div className={s.v}>{(summary.workouts || []).reduce((a, w) => a + Number(w.n), 0).toLocaleString()}</div>
          <div className={s.sub}>{(summary.workouts || []).length} activities</div>
        </div>
        <div className={s.stat}>
          <div className={s.k}>Span</div>
          <div className={s.v} style={{ fontSize: 15 }}>{from}</div>
          <div className={s.sub}>through {to}</div>
        </div>
      </div>
      <div className={s.metricBars}>
        {top.slice(0, 12).map(m => (
          <div key={m.metric} className={s.metricRow}>
            <span className={s.name}>{m.metric}</span>
            <span className={s.bar} style={{ width: `${Math.max(2, (Number(m.n) / maxN) * 100)}%` }} />
            <span className={s.num}>{Number(m.n).toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function Sync() {
  const [backups, setBackups] = useState([]);
  const [summary, setSummary] = useState(null);

  const refreshBackups = useCallback(() => {
    listBackups().then(setBackups).catch(() => {});
  }, []);
  const refreshSummary = useCallback(() => {
    getHealthSummary().then(setSummary).catch(() => {});
  }, []);
  const onHealthDone = useCallback(() => { refreshBackups(); refreshSummary(); }, [refreshBackups, refreshSummary]);

  useEffect(refreshBackups, [refreshBackups]);
  useEffect(refreshSummary, [refreshSummary]);

  const voltra = useBackupJob(startBackup, getBackupStatus, refreshBackups);
  const peloton = useBackupJob(startPelotonBackup, getPelotonBackupStatus, refreshBackups);
  const health = useBackupJob(startHealthIngest, getHealthIngestStatus, onHealthDone);

  const ingested = summary?.ingested;

  return (
    <main className={s.main}>
      <h2 className={shared.title}>Apple Health</h2>
      <p className={s.intro}>
        Ingests the <strong>full Apple Health export</strong> (<code>export.zip</code> staged under{' '}
        <code>backups/</code>) into the app's query layer: the ~2GB <code>export.xml</code> is stream-parsed
        and written as <strong>partitioned Parquet</strong> under <code>store/apple-health/</code>, queried
        by DuckDB. Every sample — heart rate, HRV, sleep, body mass, workouts — becomes queryable in seconds,
        with multi-source duplicates removed via the <code>ah_records_dedup</code> view.
      </p>

      {ingested && !health.running && <HealthSummary summary={summary} />}

      {!health.running && !health.confirming && (
        <button className={`${shared.btn} ${shared.hazard}`} onClick={() => health.setConfirming(true)}>
          {ingested ? 'Re-ingest Apple Health' : 'Ingest Apple Health → Parquet'}
        </button>
      )}

      {health.confirming && (
        <div className={`${shared.panel} ${s.confirmPanel}`}>
          <p>
            This stream-parses the staged <code>export.zip</code> and rebuilds{' '}
            <code>store/apple-health/</code>. Millions of samples, but it runs in seconds and does not
            touch the source archive under <code>backups/</code>. Proceed?
          </p>
          <div className={s.confirmRow}>
            <button className={`${shared.btn} ${s.go}`} onClick={health.begin}>Start Ingest</button>
            <button className={shared.btn} onClick={() => health.setConfirming(false)}>Cancel</button>
          </div>
        </div>
      )}

      {health.running && health.state && (
        <div className={shared.panel}><HealthProgress state={health.state} /></div>
      )}

      {!health.running && health.state?.phase === 'done' && health.state.result && (
        <div className={s.done}>
          Ingest complete: <strong>{health.state.result.records.toLocaleString()} records</strong>,{' '}
          <strong>{health.state.result.workouts} workouts</strong>
          <div className={s.dir}>{health.state.result.dir}</div>
        </div>
      )}

      {(health.error || (!health.running && health.state?.phase === 'error')) && (
        <div className={s.error}>ingest failed: {health.error || health.state.error}</div>
      )}

      <section className={s.section}>
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
      </section>

      <section className={s.section}>
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
        <h2 className={shared.title}>Previous Imports</h2>
        {backups.length === 0 && <p className={s.intro}>No imports yet.</p>}
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
