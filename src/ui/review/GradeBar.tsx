// Grade buttons (or the automatic grade with Next) in the bottom dock.
import { createContext, useContext, useMemo, useState } from 'react';
import type { CardState, Grade, StatusMark } from '../../lib/types';
import { formatInterval, gradeName, previewIntervals } from '../../lib/engine/schedule';
import { setNoteStatus } from '../../lib/store';
import { coarse } from './shared';

/** Lets the session react when a word is marked from the dock. Without it, no actions are shown. */
export const ReviewActionsContext = createContext<{ onMarked(m: StatusMark): void } | null>(null);

/** "I know this" and "Suspend" above the grade buttons. "Relearn" is left out: Again covers it here. */
export function CardActions({ card }: { card: CardState }) {
  const ctx = useContext(ReviewActionsContext);
  const [busy, setBusy] = useState(false);
  if (!ctx) return null;
  const mark = async (a: 'known' | 'suspend') => {
    if (busy) return;
    setBusy(true);
    try {
      ctx.onMarked(await setNoteStatus(card.note, a));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card-actions">
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => mark('known')}>
        I know this
      </button>
      <button type="button" className="btn ghost small" disabled={busy} onClick={() => mark('suspend')}>
        Suspend
      </button>
    </div>
  );
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
