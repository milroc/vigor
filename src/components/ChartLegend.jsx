import { GRAY } from '../lib/repviz.js';
import s from './ChartLegend.module.css';

const LIME = '#c6fe28';

const Swatch = ({ children }) => (
  <svg width="24" height="13" viewBox="0 0 34 18">{children}</svg>
);

const hex = (cx, cy, r = 3.2) =>
  `M${cx},${cy - r}L${cx + r * 0.87},${cy - r / 2}L${cx + r * 0.87},${cy + r / 2}L${cx},${cy + r}L${cx - r * 0.87},${cy + r / 2}L${cx - r * 0.87},${cy - r / 2}Z`;

function Item({ swatch, name, note }) {
  return (
    <div className={s.item} title={note}>
      <Swatch>{swatch}</Swatch>
      <span className={s.label}>{name}</span>
    </div>
  );
}

export default function ChartLegend({ repCount, hasTargets, history }) {
  return (
    <div className={s.legend}>
      <div className={s.group}>
        <div className={s.groupTitle}>This Set</div>
        <Item
          name="Average of set"
          note="bold line"
          swatch={<path d="M1,13C8,13 10,4 17,4S26,12 33,9" fill="none" stroke={LIME} strokeWidth="2.5" />}
        />
        <Item
          name={repCount ? `All ${repCount} reps in set` : 'All reps in set'}
          note="faint lines"
          swatch={
            <>
              <path d="M1,14C8,14 10,6 17,6S26,13 33,10" fill="none" stroke={LIME} strokeWidth="1.5" opacity="0.35" />
              <path d="M1,12C8,12 10,2 17,2S26,10 33,7" fill="none" stroke={LIME} strokeWidth="1.5" opacity="0.2" />
              <path d="M1,15C8,15 10,8 17,8S26,15 33,12" fill="none" stroke={LIME} strokeWidth="1.5" opacity="0.28" />
            </>
          }
        />
        <Item
          name="Selected rep"
          note="white line"
          swatch={<path d="M1,13C8,13 10,4 17,4S26,12 33,9" fill="none" stroke="#ffffff" strokeWidth="2.2" />}
        />
      </div>

      {history && <div className={s.group}>
        <div className={s.groupTitle}>History</div>
        <Item
          name="Other sets"
          note="same day, gray"
          swatch={
            <>
              <path d="M1,13C8,13 10,5 17,5S26,12 33,9" fill="none" stroke={GRAY} strokeWidth="1" opacity="0.7" />
              <path d="M1,15C8,15 10,7 17,7S26,14 33,11" fill="none" stroke={GRAY} strokeWidth="1" opacity="0.5" />
            </>
          }
        />
        <Item
          name="Past year"
          note="cell = reps"
          swatch={
            <>
              {[[7, 9, 0.32], [13, 6, 0.22], [13, 12, 0.14], [19, 9, 0.26], [25, 6, 0.1], [25, 12, 0.18]].map(([cx, cy, o], i) => (
                <path key={i} d={hex(cx, cy)} fill={LIME} opacity={o} stroke="#20201b" strokeWidth="0.5" />
              ))}
            </>
          }
        />
      </div>}

      <div className={s.group}>
        <div className={s.groupTitle}>Guides</div>
        {hasTargets && (
          <Item
            name="Target zone"
            note="stay inside"
            swatch={
              <>
                {[[7, 9], [13, 6], [13, 12], [19, 9], [25, 6], [25, 12]].map(([cx, cy], i) => (
                  <path key={i} d={hex(cx, cy)} fill="#e8e8e0" fillOpacity="0.1" stroke="#b9b9ac" strokeWidth="0.8" strokeOpacity="0.7" />
                ))}
              </>
            }
          />
        )}
        <Item
          name="Con. / Ecc."
          note="press | return"
          swatch={
            <>
              <line x1="17" y1="2" x2="17" y2="16" stroke={LIME} strokeWidth="1" strokeDasharray="3,3" opacity="0.7" />
              <text x="13" y="12" textAnchor="end" fontSize="7" fill={GRAY} fontFamily="IBM Plex Mono">→</text>
              <text x="21" y="12" fontSize="7" fill={GRAY} fontFamily="IBM Plex Mono">→</text>
            </>
          }
        />
      </div>

    </div>
  );
}
