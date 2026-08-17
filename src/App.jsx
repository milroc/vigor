import { useEffect, useState } from 'react';
import { Routes, Route, NavLink } from 'react-router-dom';
import { runVoltra } from './api.js';
import Dashboard from './pages/Dashboard.jsx';
import Backup from './pages/Backup.jsx';
import Workout from './pages/Workout.jsx';
import VizLab from './pages/VizLab.jsx';
import s from './App.module.css';

export default function App() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    const poll = () =>
      runVoltra(['status', '--json'])
        .then(st => alive && setStatus(st))
        .catch(() => alive && setStatus(null));
    poll();
    const id = setInterval(poll, 8000);
    return () => { alive = false; clearInterval(id); };
  }, []);

  const connected = !!status?.parameters;
  const deviceName = status?.device?.name;
  const navClass = ({ isActive }) => s.navLink + (isActive ? ` ${s.active}` : '');

  return (
    <>
      <header className={s.header}>
        <NavLink to="/" className={s.wordmark}>VIGOR<small>COACH</small></NavLink>
        <nav className={s.nav}>
          <NavLink to="/" end className={navClass}>Lift</NavLink>
          <NavLink to="/backup" className={navClass}>Backup</NavLink>
          <NavLink to="/viz" className={navClass}>Movement Report</NavLink>
        </nav>
        <div className={s.connBadge}>
          <span className={s.connDot + (connected ? ` ${s.on}` : '')} />
          <span>{connected ? `Connected · ${deviceName ?? ''}` : 'Disconnected'}</span>
        </div>
      </header>
      <Routes>
        <Route path="/" element={<Dashboard status={status} onStatusChange={setStatus} />} />
        <Route path="/backup" element={<Backup />} />
        <Route path="/workout/:id" element={<Workout />} />
        <Route path="/viz" element={<VizLab />} />
      </Routes>
    </>
  );
}
