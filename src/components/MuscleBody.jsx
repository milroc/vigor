import { useEffect, useRef } from 'react';
import { BodyChart, ViewSide, MUSCLE_MAP } from 'body-muscles';
import s from './MuscleBody.module.css';

// Muscle groups map 1:1 to the Cortex action catalog typeIds.
export const MUSCLE_GROUPS = {
  2: 'Legs', 3: 'Back', 4: 'Chest', 5: 'Shoulders',
  6: 'Biceps', 7: 'Triceps', 8: 'Core', 10: 'Full Body', 1: 'Free Exercises',
};

// Map body-muscles ids to Cortex typeIds by prefix. Unlisted regions
// (head, hands, forearms, joints) stay unmapped and inert.
const PREFIX_TO_TYPE = [
  ['biceps', 6],
  ['triceps', 7],
  ['chest', 4],
  ['shoulder', 5], ['deltoid', 5], ['traps', 5],
  ['lats', 3], ['lower-back', 3], ['spine', 3],
  ['abs', 8], ['obliques', 8], ['serratus', 8],
  ['gluteus', 2], ['quads', 2], ['hamstrings', 2], ['adductors', 2],
  ['tibialis', 2], ['calves', 2], ['hip-flexor', 2],
];

const MUSCLE_TO_TYPE = Object.fromEntries(
  MUSCLE_MAP
    .map(({ id }) => [id, PREFIX_TO_TYPE.find(([p]) => id.startsWith(p))?.[1]])
    .filter(([, t]) => t)
);

// stateFor(typeId) -> BodyPartState for every mapped muscle of that group.
function bodyStateBy(stateFor) {
  return Object.fromEntries(
    Object.entries(MUSCLE_TO_TYPE).map(([id, typeId]) => [id, stateFor(typeId)])
  );
}

function Chart({ view, label, bodyState, width = 150, onSelect }) {
  const ref = useRef(null);
  const chartRef = useRef(null);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  useEffect(() => {
    chartRef.current = new BodyChart(ref.current, {
      view,
      bodyState: {},
      showViewLabel: false,
      onMuscleClick: id => {
        const typeId = MUSCLE_TO_TYPE[id];
        if (typeId) onSelectRef.current?.(typeId);
      },
    });
    return () => chartRef.current?.destroy();
  }, [view]);

  useEffect(() => {
    chartRef.current?.update({ bodyState });
  }, [bodyState]);

  return (
    <div className={s.figure}>
      <div ref={ref} className={onSelect ? s.chart : `${s.chart} ${s.static}`} style={{ width }} />
      {label && <div className={s.viewLabel}>{label}</div>}
    </div>
  );
}

// Non-interactive variant: highlights the muscles a given exercise works.
// compact drops the view labels and tightens the gap for inline use.
export function MuscleHighlight({ primary = [], secondary = [], width = 92, side = null, compact = false }) {
  const p = new Set(primary), sec = new Set(secondary);
  const opposite = side === 'left' ? '-right' : side === 'right' ? '-left' : null;
  const bodyState = Object.fromEntries(
    Object.entries(MUSCLE_TO_TYPE).map(([id, typeId]) => [id, {
      intensity: (opposite && id.endsWith(opposite)) ? 0
        : p.has(typeId) ? 8 : sec.has(typeId) ? 3 : 0,
      selected: false,
    }])
  );

  return (
    <div className={s.wrap} style={{ gap: compact ? 4 : 10 }}>
      <Chart view={ViewSide.FRONT} label={compact ? null : 'Front'} bodyState={bodyState} width={width} />
      <Chart view={ViewSide.BACK} label={compact ? null : 'Back'} bodyState={bodyState} width={width} />
    </div>
  );
}

export default function MuscleBody({ selected, groupsWithData, onSelect }) {
  const bodyState = bodyStateBy(typeId => ({
    intensity: groupsWithData.has(typeId) ? 4 : 0,
    selected: selected === typeId,
  }));

  return (
    <div className={s.wrap}>
      <Chart view={ViewSide.FRONT} label="Front" bodyState={bodyState} onSelect={onSelect} />
      <Chart view={ViewSide.BACK} label="Back" bodyState={bodyState} onSelect={onSelect} />
      <div className={s.extraRow}>
        {[10, 1].map(t => (
          <button
            key={t}
            className={s.extraBtn + (selected === t ? ` ${s.active}` : '')}
            onClick={() => onSelect(t)}
          >
            {MUSCLE_GROUPS[t]}
          </button>
        ))}
      </div>
    </div>
  );
}
