// Navigation inside the word sheet (plan 2026-11-23 D3, D4). Anything under a WordSheet, or under a WordNavHost, can
// call useWordNav().open(entry): the sheet pushes a level instead of opening another sheet on top.
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { Note, WordStatus } from '../../lib/types';

export type WordEntry =
  | { t: 'note'; note: Note; practiseHref?: string; rowId?: string | number; status?: WordStatus; onStatus?: (s: WordStatus) => void }
  | { t: 'line'; zh: string; start: number; length: number }
  | { t: 'word'; word: string; pinyinNum?: string };

export interface WordNav { open(entry: WordEntry): void }

export const WordNavContext = createContext<WordNav | null>(null);
export function useWordNav(): WordNav | null {
  return useContext(WordNavContext);
}

// Static import: WordSheet imports this file back, but both only use each other while rendering.
import { WordSheet } from './WordSheet';

/** For a page that shows words with no sheet around them (the Words page): the first open() shows a WordSheet. */
export function WordNavHost({ children }: { children: ReactNode }) {
  const [root, setRoot] = useState<WordEntry | null>(null);
  const open = useCallback((e: WordEntry) => setRoot((r) => r ?? e), []);
  const nav = useMemo(() => ({ open }), [open]);
  return (
    <WordNavContext.Provider value={nav}>
      {children}
      {root && createPortal(
        <WordSheet root={root} onClose={() => setRoot(null)} className="wp tall" />,
        document.body,
      )}
    </WordNavContext.Provider>
  );
}

export function sameEntry(a: WordEntry, b: WordEntry): boolean {
  if (a.t !== b.t) return false;
  if (a.t === 'note' && b.t === 'note') return a.note.id === b.note.id;
  if (a.t === 'line' && b.t === 'line') return a.zh === b.zh && a.start === b.start && a.length === b.length;
  if (a.t === 'word' && b.t === 'word') return a.word === b.word && (a.pinyinNum ?? '') === (b.pinyinNum ?? '');
  return false;
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

/** A lookup target for a word that is not in his list. Never stored. */
export function dictNote(word: string): Note {
  return {
    id: `dict:${word}`, kind: 'vocab', hanzi: word, alts: [], pinyin: '', pinyinNum: '', en: '', notes: [], tags: [], refs: [],
    order: 0, studied: false, examples: [],
  } as Note;
}
