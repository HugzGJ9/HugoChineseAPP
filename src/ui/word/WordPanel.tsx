// One panel per word: Explain (dictionary, Claude, examples), "Practise this word" (opens Cards on it) and the status
// picker when allowed.
import { lazy, Suspense } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { AudioButton, Icon, LangSwitch, Pinyin } from '../common';
import { Sheet } from '../panel';
import { StatusPicker } from '../StatusPicker';
import './word.css';

const ExplainView = lazy(() => import('./ExplainView').then((m) => ({ default: m.ExplainView })));

export function WordPanel({
  note, practiseHref, status, onStatus, onClose,
}: {
  note: Note;
  /** `tabs` is kept for older callers; the panel only has Explain now. */
  tabs?: string[];
  /** Where "Practise this word" goes (a `#/cards?…` link); the button is left out without it. */
  practiseHref?: string;
  status?: WordStatus; onStatus?: (s: WordStatus) => void; onClose: () => void;
}) {
  const details = `#/${note.kind === 'grammar' ? 'grammar' : 'words'}/${encodeURIComponent(note.id)}`;
  return (
    <Sheet
      className="wp tall"
      label={note.hanzi}
      onClose={onClose}
      title={
        <span className="wp-title">
          <span className="zh wp-hz" lang="zh-CN">{note.hanzi}</span>
          {note.kind !== 'grammar' && note.pinyin && <Pinyin text={note.pinyin} className="wp-py" />}
        </span>
      }
      head={<AudioButton text={note.hanzi} />}
    >
      <div className="wp-bar">
        {practiseHref ? (
          <a className="btn small tinted wp-practise" href={practiseHref}>
            <Icon name="pen" />
            Practise this word
          </a>
        ) : (
          <span className="grow" />
        )}
        <LangSwitch />
      </div>
      <Suspense fallback={<p className="wp-loading" aria-busy="true">Loading…</p>}>
        <ExplainView note={note} />
      </Suspense>
      {onStatus && status && (
        <section className="pp-group wp-status" aria-labelledby="pp-status-label">
          <h3 className="pp-group-h">
            <span id="pp-status-label">Status</span>
            <a href={details} className="wp-details">
              Details
            </a>
          </h3>
          <StatusPicker value={status} onChange={onStatus} compact />
        </section>
      )}
    </Sheet>
  );
}
