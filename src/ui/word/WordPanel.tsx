// One panel per word: Explain (dictionary, Claude, examples) and Practise tabs, with the status picker when allowed.
import { lazy, Suspense, useState } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { AudioButton, LangSwitch, Pinyin, Segmented } from '../common';
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
        {tabs.length > 1 ? (
          <Segmented label="Panel view" className="wp-tabs" value={cur} onChange={setCur} options={tabs.map((t) => ({ value: t, label: TAB_LABEL[t] }))} />
        ) : (
          <span className="grow" />
        )}
        <LangSwitch />
      </div>
      {cur === 'explain' ? (
        <Suspense fallback={<p className="wp-loading" aria-busy="true">Loading…</p>}>
          <ExplainView note={note} />
        </Suspense>
      ) : (
        <PracticeBody note={note} />
      )}
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
    </Shell>
  );
}
