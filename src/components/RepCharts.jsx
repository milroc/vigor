import { useMemo } from 'react';
import LineChart from './LineChart.jsx';
import ChartLegend from './ChartLegend.jsx';
import { CHARTS, durations, repSeries, averageRep, targetBands } from '../lib/repviz.js';
import s from './RepCharts.module.css';

// Real imported telemetry only — no synthetic history layers here: this view
// must never present generated data as the user's own.
export default function RepCharts({ telemRows, apiReps, targets }) {
  const n = telemRows.length;
  const { perRep, avgSeries, tMin, tMax } = useMemo(() => {
    const durs = telemRows.map((row, i) => durations(row, apiReps?.[i]));
    const perRep = telemRows.map((row, i) => repSeries(row, durs[i]));
    const avg = averageRep(telemRows, durs);
    const avgSeries = repSeries(avg.telem, avg.durs);
    const allT = perRep.flatMap(r => r.velocity.map(p => p.t));
    return { perRep, avgSeries, tMin: Math.min(...allT), tMax: Math.max(...allT) };
  }, [telemRows, apiReps]);

  const bands = useMemo(
    () => (targets?.romM ? targetBands(targets) : null),
    [targets]
  );

  const seriesFor = key => [
    ...perRep.map(r => ({ samples: r[key], opacity: 0.1, width: 1.5 })),
    { samples: avgSeries[key], opacity: 1, width: 2.5, label: 'avg' },
  ];

  return (
    <div className={s.wrap}>
      <ChartLegend repCount={n} hasTargets={!!targets} />
      {CHARTS.map(c => (
        <LineChart
          key={c.key}
          title={c.title}
          unit={c.unit}
          seriesList={seriesFor(c.key)}
          color={c.color}
          dividerT={0}
          zeroLine={c.zeroLine}
          targetBand={bands?.[c.key] ?? null}
          xLabelLeft={`${tMin.toFixed(2)}s`}
          xLabel={`+${tMax.toFixed(2)}s`}
        />
      ))}
    </div>
  );
}
