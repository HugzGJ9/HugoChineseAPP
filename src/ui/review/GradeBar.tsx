// Grade buttons (or the automatic grade with Next) in the bottom dock.
import { useMemo, useState } from 'react';
import type { CardState, Grade } from '../../lib/types';
import { formatInterval, gradeName, previewIntervals } from '../../lib/engine/schedule';
import { coarse } from './shared';

/** Slot for "I know this / Relearn / Suspend" on the answer side. Not implemented yet. */
export function CardActions(_props: { card: CardState }) {
  return null;
}

export function GradeBar({ card, retention, auto, onGrade }: { card: CardState; retention: number; auto?: Grade; onGrade: (g: Grade) => void }) {
  const iv = useMemo(() => previewIntervals(card, Date.now(), retention), [card, retention]);
  const [changing, setChanging] = useState(false);
  if (auto && !changing) {
    return (
      <div className="dock">
        <CardActions card={card} />
        <div className="row">
          <button type="button" className="btn ghost small" onClick={() => setChanging(true)}>
            Change grade
          </button>
          <span className="grow small muted center">
            Graded {gradeName(auto)} · next in {formatInterval(iv[auto])}
          </span>
          <button type="button" className="btn primary" onClick={() => onGrade(auto)} autoFocus={!coarse}>
            Next
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="dock">
      <CardActions card={card} />
      <div className="grades" role="group" aria-label="How well did you remember?">
        {([1, 2, 3, 4] as Grade[]).map((g) => (
          <button key={g} type="button" className={`g${g} ${auto === g ? 'picked' : ''}`} onClick={() => onGrade(g)} title={`${gradeName(g)} (${g})`}>
            {gradeName(g)}
            <small>{formatInterval(iv[g])}</small>
          </button>
        ))}
      </div>
    </div>
  );
}
