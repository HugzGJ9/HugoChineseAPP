// One panel per word: Explain (dictionary, Claude, examples) and Practise tabs, with the status footer when allowed.
import { lazy, Suspense, useState } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { AudioButton, LangSwitch, Pinyin } from '../common';
import { Shell } from '../panel';
import { StatusPicker } from '../StatusPicker';
import { PracticeBody } from '../sheets/Practice';
import './word.css';

const ExplainView = lazy(() => import('./ExplainView').then((m) => ({ default: m.ExplainView })));

export type PanelTab = 'explain' | 'practise';
const TAB_LABEL: Record<PanelTab, string> = { explain: 'Explain', practise: 'Practise' };

export function WordPanel({
  note, tab = 'explain', tabs = ['explain', 'practise'], status, onStatus, onClose,
}: {
  note: Note; tab?: PanelTab; tabs?: PanelTab[]; status?: WordStatus; onStatus?: (s: WordStatus) => void; onClose: () => void;
}) {
  const [cur, setCur] = useState<PanelTab>(tabs.includes(tab) ? tab : tabs[0]);
  const details = `#/${note.kind === 'grammar' ? 'grammar' : 'words'}/${encodeURIComponent(note.id)}`;
  return (
    <Shell
      label={note.hanzi}
      onClose={onClose}
      title={
        <span className="wp-title">
          <span className="zh wp-hz" lang="zh-CN">{note.hanzi}</span>
          {note.kind !== 'grammar' && <Pinyin text={note.pinyin} className="wp-py" />}
        </span>
      }
      head={
        <>
          <AudioButton text={note.hanzi} />
          <LangSwitch />
        </>
      }
    >
      {tabs.length > 1 && (
        <div className="wp-tabs" role="group" aria-label="Panel view">
          {tabs.map((t) => (
            <button key={t} type="button" className="chip" aria-pressed={cur === t} onClick={() => setCur(t)}>
              {TAB_LABEL[t]}
            </button>
          ))}
        </div>
      )}
      {cur === 'explain' ? (
        <Suspense fallback={<p className="muted" aria-busy="true">Loading…</p>}>
          <ExplainView note={note} />
        </Suspense>
      ) : (
        <PracticeBody note={note} />
      )}
      {onStatus && status && (
        <div className="pp-foot">
          <div className="small muted">
            <span id="pp-status-label">Set status</span>
            <a href={details}>Details</a>
          </div>
          <StatusPicker value={status} onChange={onStatus} compact />
        </div>
      )}
    </Shell>
  );
}
