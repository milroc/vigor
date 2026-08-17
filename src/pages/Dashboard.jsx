import { useCallback, useEffect, useState } from 'react';
import { runVoltra, listTelemetry } from '../api.js';
import StatusPanel from '../components/StatusPanel.jsx';
import QuickActions from '../components/QuickActions.jsx';
import WeeklyMinutes from '../components/WeeklyMinutes.jsx';
import WorkoutsTable from '../components/WorkoutsTable.jsx';
import s from './Dashboard.module.css';

export default function Dashboard({ status, onStatusChange }) {
  const [workouts, setWorkouts] = useState([]);
  const [telemetryIds, setTelemetryIds] = useState([]);
  const [logMsg, setLogMsg] = useState({ text: 'ready', err: false });

  const log = useCallback((text, err = false) => setLogMsg({ text, err }), []);

  const refresh = useCallback(() => {
    runVoltra(['status', '--json']).then(onStatusChange).catch(() => onStatusChange(null));
    runVoltra(['workout', 'list', '--json', '--local-time', '--page-size', '50'])
      .then(data => setWorkouts(data.list || []))
      .catch(e => log(`workouts: ${e.message}`, true));
    listTelemetry().then(setTelemetryIds).catch(() => {});
  }, [onStatusChange, log]);

  useEffect(() => { refresh(); }, [refresh]);

  return (
    <>
      <main className={s.dashboard}>
        <div className={s.col}>
          <StatusPanel status={status} />
          <QuickActions loaded={!!status?.parameters?.power_enabled} onAction={refresh} log={log} />
        </div>
        <div className={s.col}>
          <WeeklyMinutes workouts={workouts} />
          <WorkoutsTable workouts={workouts} telemetryIds={telemetryIds} />
        </div>
      </main>
      <div className={s.log + (logMsg.err ? ` ${s.err}` : '')}>{logMsg.text}</div>
    </>
  );
}
