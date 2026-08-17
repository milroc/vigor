import s from './BarChart.module.css';

// bars: [{ label, a, b? }] — a is the primary (lime) series, b an optional
// secondary (dim) series rendered side-by-side. fmt formats the value caption.
export default function BarChart({ bars, fmt = v => v, legendA, legendB }) {
  const max = Math.max(...bars.flatMap(x => [x.a, x.b ?? 0]), 1e-9);
  const showLegend = legendA && bars.some(x => x.b != null);

  return (
    <div>
      <div className={s.chart}>
        {bars.map((x, i) => (
          <div key={i} className={s.group} title={`${x.label}: ${fmt(x.a)}`}>
            <div className={s.value}>{fmt(x.a)}</div>
            <div className={s.bars}>
              <div className={s.barA} style={{ height: `${(x.a / max) * 100}%` }} />
              {x.b != null && <div className={s.barB} style={{ height: `${(x.b / max) * 100}%` }} />}
            </div>
            <div className={s.label}>{x.label}</div>
          </div>
        ))}
      </div>
      {showLegend && (
        <div className={s.legend}>
          <span><i className={s.a} />{legendA}</span>
          {legendB && <span><i className={s.b} />{legendB}</span>}
        </div>
      )}
    </div>
  );
}

export function MetricToggles({ options, value, onChange }) {
  return (
    <div className={s.toggles}>
      {options.map(o => (
        <button
          key={o.key}
          className={s.toggle + (value === o.key ? ` ${s.active}` : '')}
          onClick={() => onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
