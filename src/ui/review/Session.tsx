// Review session: builds the queue, records answers, progress, undo, end screen.
import { useEffect, useRef, useState } from 'react';
import type { StatusMark } from '../../lib/types';
import { getState, recordReview, undoMark, undoReview, useApp } from '../../lib/store';
import { ReviewActionsContext } from './GradeBar';
import { buildQueue, reinsertIndex } from '../../lib/engine/queue';
import { Icon, LangSwitch, toast } from '../common';
import { CardView } from './CardView';

interface Session {
  queue: string[];
  pos: number;
  fresh: Set<string>;
  done: number;
  right: number;
  started: number;
  last?: { kind: 'review' | 'mark'; id: string; queue: string[]; pos: number; done: number; right: number };
}

function parseHash(): { cards?: string[]; fresh?: string[] } {
  const q = location.hash.split('?')[1];
  if (!q) return {};
  const p = new URLSearchParams(q);
  const list = (k: string) => p.get(k)?.split(',').filter(Boolean).map(decodeURIComponent);
  return { cards: list('cards'), fresh: list('fresh') };
}

export function Review() {
  const ready = useApp((s) => s.ready);
  const [session, setSession] = useState<Session | null>(null);
  // Blocks a second grade (double tap, held key) until the next card is shown.
  const busy = useRef(false);
  /** When the current card appeared: a tap that lands right after a card change was meant for the previous card. */
  const shownAt = useRef(0);

  useEffect(() => {
    if (!ready || session) return;
    const s = getState();
    const { cards: custom, fresh: customFresh } = parseHash();
    if (custom) {
      setSession({ queue: custom.filter((c) => s.cards.has(c)), pos: 0, fresh: new Set(customFresh ?? []), done: 0, right: 0, started: Date.now() });
      return;
    }
    const q = buildQueue([...s.cards.values()], s.noteMap, s.events, s.settings, Date.now());
    setSession({ queue: q.cards, pos: 0, fresh: q.fresh, done: 0, right: 0, started: Date.now() });
  }, [ready, session]);

  useEffect(() => {
    busy.current = false;
    shownAt.current = performance.now();
  }, [session?.pos, session?.queue]);

  if (!session) return <div className="main" />;
  const cardId = session.queue[session.pos];

  const undo = async () => {
    const last = session.last;
    if (!last) return;
    if (last.kind === 'mark') await undoMark(last.id);
    else await undoReview(last.id);
    setSession({ ...session, queue: last.queue, pos: last.pos, done: last.done, right: last.right, last: undefined });
    toast(last.kind === 'mark' ? 'Status change undone' : 'Last answer undone');
  };

  const onMarked = (m: StatusMark) => {
    busy.current = true;
    const queue = session.queue.filter((id, i) => i < session.pos || !id.startsWith(m.note + '#'));
    setSession({
      ...session,
      queue,
      last: { kind: 'mark', id: m.id, queue: session.queue, pos: session.pos, done: session.done, right: session.right },
    });
    toast(m.a === 'known' ? 'Marked as known: next check in about 3 months' : 'Suspended');
  };

  const total = session.queue.length;

  return (
    <div className="main">
      <header className="topbar">
        <a
          className="icon-btn"
          href="#/today"
          aria-label="End session"
          onClick={(e) => {
            if (cardId && session.pos > 0 && !window.confirm('End this session? Your answers so far are saved.')) e.preventDefault();
          }}
        >
          <Icon name="close" />
        </a>
        <div className="grow">
          <div
            className="progress"
            role="progressbar"
            aria-label="Session progress"
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(session.pos, total)}
            aria-valuetext={`${session.done} done, ${Math.max(0, total - session.pos)} left`}
          >
            <i style={{ width: `${(session.pos / Math.max(1, total)) * 100}%` }} />
          </div>
        </div>
        <span className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.max(0, total - session.pos)}
        </span>
        <button type="button" className="icon-btn" onClick={undo} disabled={!session.last} aria-label="Undo last answer" title="Undo last answer">
          <Icon name="undo" />
        </button>
        <LangSwitch />
      </header>
      {cardId ? (
        <ReviewActionsContext.Provider value={{ onMarked }}>
        <CardView
          key={`${cardId}:${session.pos}`}
          cardId={cardId}
          fresh={session.fresh.has(cardId)}
          onGraded={async (g, mode, ms) => {
            if (busy.current || performance.now() - shownAt.current < 400) return;
            busy.current = true;
            try {
              const ev = await recordReview(cardId, g, mode, ms);
              const after = getState().cards.get(cardId);
              const queue = [...session.queue];
              if (after && (after.state === 1 || after.state === 3) && after.due - Date.now() < 30 * 60000) {
                queue.splice(reinsertIndex(queue, session.pos + 1, after.due - Date.now()), 0, cardId);
              }
              setSession({
                ...session,
                queue,
                pos: session.pos + 1,
                done: session.done + 1,
                right: session.right + (g > 1 ? 1 : 0),
                last: { kind: 'review', id: ev.id, queue: session.queue, pos: session.pos, done: session.done, right: session.right },
              });
            } catch (err) {
              busy.current = false;
              throw err;
            }
          }}
        />
        </ReviewActionsContext.Provider>
      ) : (
        <Finished session={session} onMore={() => setSession(null)} />
      )}
    </div>
  );
}

function Finished({ session, onMore }: { session: Session; onMore: () => void }) {
  const mins = Math.max(1, Math.round((Date.now() - session.started) / 60000));
  return (
    <div className="card">
      <h2>{session.done ? 'Session done' : 'Nothing due right now'}</h2>
      {session.done > 0 && (
        <p className="muted">
          {session.done} answers, {Math.round((session.right / session.done) * 100)}% remembered, {mins} min.
        </p>
      )}
      <div className="row">
        <a className="btn primary" href="#/today">
          Back to Today
        </a>
        <button type="button" className="btn" onClick={onMore}>
          Check for more
        </button>
      </div>
    </div>
  );
}
