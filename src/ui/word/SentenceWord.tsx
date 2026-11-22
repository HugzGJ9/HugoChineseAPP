// A word tapped in a grammar example sentence (plan 2026-11-22-grammar-v3, D4–D5). The sentence sits at the top with the
// word highlighted: tap a character outside it to widen, its first or last character to narrow, one inside to keep
// only that one (fixes a bad cut without a long-press). One of his words → his meaning, dictionary, Claude, status;
// any other word → the offline dictionary only, plus links to his words that contain it or sit inside it.
import { lazy, Suspense, useMemo, useState } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { setNoteStatus, useApp } from '../../lib/store';
import { STATUS_MARK } from '../../lib/status';
import { vocabLinks } from '../../lib/grammar/list';
import { AudioButton, LangSwitch, Pinyin } from '../common';
import { Sheet } from '../panel';
import { StatusIcon, StatusPicker } from '../StatusPicker';
import { WordPanel } from './WordPanel';
import './word.css';

const ExplainView = lazy(() => import('./ExplainView').then((m) => ({ default: m.ExplainView })));

const HAN = /[㐀-鿿]/;

/** A lookup target for a word that is not in his list. Never stored. */
export function dictNote(word: string): Note {
  return {
    id: `dict:${word}`, kind: 'vocab', hanzi: word, alts: [], pinyin: '', pinyinNum: '', en: '', notes: [], tags: [], refs: [],
    order: 0, studied: false, examples: [],
  } as Note;
}

/** Next selection after tapping character `k` of the sentence, selection [s, e). */
export function retarget(s: number, e: number, k: number): [number, number] {
  if (k < s) return [k, e];
  if (k >= e) return [s, k + 1];
  if (e - s === 1) return [s, e];
  if (k === s) return [s + 1, e];
  if (k === e - 1) return [s, e - 1];
  return [k, k + 1];
}

export function SentenceWord({
  zh, start, length, index, statuses, onClose,
}: {
  zh: string;
  start: number;
  length: number;
  index: { forms: Map<string, string>; max: number };
  statuses: Map<string, WordStatus>;
  onClose: () => void;
}) {
  const notes = useApp((s) => s.notes);
  const chars = useMemo(() => [...zh], [zh]);
  const [[s, e], setSel] = useState<[number, number]>([start, start + length]);
  const [open, setOpen] = useState<Note | null>(null);
  const word = chars.slice(s, e).join('');
  const id = index.forms.get(word);
  const note = id ? notes.find((n) => n.id === id) : undefined;
  const links = useMemo(
    () => (note ? [] : vocabLinks(word, index).map((x) => notes.find((n) => n.id === x)).filter((n): n is Note => !!n)),
    [note, word, index, notes],
  );
  const status = note ? (statuses.get(note.id) ?? 'new') : undefined;

  return (
    <>
    <Sheet
      className="wp tall sw"
      label={word}
      onClose={onClose}
      title={
        <span className="wp-title">
          <span className="zh wp-hz" lang="zh-CN">{word}</span>
          {note?.pinyin && <Pinyin text={note.pinyin} className="wp-py" />}
        </span>
      }
      head={<AudioButton text={word} />}
    >
      <div className="sw-strip" lang="zh-CN" aria-label="Sentence: tap characters to widen or narrow the word">
        {chars.map((c, k) =>
          HAN.test(c) ? (
            <button
              key={k}
              type="button"
              className={`sw-c zh${k >= s && k < e ? ' on' : ''}${k === s ? ' first' : ''}${k === e - 1 ? ' last' : ''}`}
              aria-pressed={k >= s && k < e}
              onClick={() => setSel(retarget(s, e, k))}
            >
              {c}
            </button>
          ) : (
            <span key={k} className="sw-c zh punct">
              {c}
            </span>
          ),
        )}
      </div>
      <p className="sw-hint">Tap a character to widen or narrow the word.</p>
      <div className="wp-bar">
        <span className="sw-tag">{note ? 'In your list' : 'Not in your list'}</span>
        <LangSwitch />
      </div>
      {links.length > 0 && (
        <section className="pp-group sw-links" aria-label="Your words">
          <h3 className="pp-group-h">Your words with {word}</h3>
          <div className="sw-link-list">
            {links.map((n) => (
              <button key={n.id} type="button" className={`chip sw-link st-${statuses.get(n.id) ?? 'new'}`} onClick={() => setOpen(n)}>
                <StatusIcon status={statuses.get(n.id) ?? 'new'} />
                <span className="zh">{n.hanzi}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <Suspense fallback={<p className="wp-loading" aria-busy="true">Loading…</p>}>
        {note ? <ExplainView key={note.id} note={note} /> : <ExplainView key={word} note={dictNote(word)} mine={false} />}
      </Suspense>
      {note && status && (
        <section className="pp-group wp-status" aria-label="Status">
          <h3 className="pp-group-h">Status</h3>
          <StatusPicker value={status} onChange={(st) => void setNoteStatus(note.id, STATUS_MARK[st])} compact />
        </section>
      )}
    </Sheet>
      {open && (
        <WordPanel
          key={open.id}
          note={open}
          status={statuses.get(open.id) ?? 'new'}
          onStatus={(st) => void setNoteStatus(open.id, STATUS_MARK[st])}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  );
}
