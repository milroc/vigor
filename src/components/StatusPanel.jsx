import shared from '../styles/shared.module.css';
import s from './StatusPanel.module.css';

export default function StatusPanel({ status }) {
  const p = status?.parameters;
  const ep = status?.ep_status;
  const battery = ep?.local_battery_percent;

  return (
    <section className={shared.section}>
      <h2 className={shared.title}>Device Status</h2>
      <div className={s.statGrid}>
        <div className={s.stat}>
          <label>Battery</label>
          <div className={`${s.val} ${s.lit}`}>{battery ?? '--'}<span className={s.unit}>%</span></div>
        </div>
        <div className={s.stat}>
          <label>Mode</label>
          <div className={s.val}>{p ? (p.training_mode === 'none' ? 'IDLE' : p.training_mode) : '--'}</div>
        </div>
        <div className={s.batteryBar}>
          <div className={s.batteryFill} style={{ width: `${battery ?? 0}%` }} />
        </div>
        <div className={s.stat}>
          <label>Load State</label>
          <div className={s.val + (p?.power_enabled ? ` ${s.lit}` : '')}>
            {p ? (p.power_enabled ? 'LOADED' : 'UNLOADED') : '--'}
          </div>
        </div>
        <div className={s.stat}>
          <label>Weight</label>
          <div className={s.val}>{p?.base_weight_lbs ?? '--'}<span className={s.unit}>lbs</span></div>
        </div>
        <div className={s.stat}>
          <label>Unit</label>
          <div className={`${s.val} ${s.small}`}>{status?.device?.name ?? '--'}</div>
        </div>
        <div className={s.stat}>
          <label>Eccentric</label>
          <div className={s.val}>{p?.eccentric_lbs ?? '--'}<span className={s.unit}>lbs</span></div>
        </div>
      </div>
    </section>
  );
}
