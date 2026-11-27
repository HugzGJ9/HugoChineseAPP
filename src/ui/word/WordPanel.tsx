// One panel per word: Explain (dictionary, characters, similar words, examples), "Practise this word" (opens Cards on it) and the status
// picker when allowed. The panel is a WordSheet (plan 2026-11-23 D3): words tapped inside it open as levels of the same sheet.
import type { Note, WordStatus } from '../../lib/types';
import { WordSheet } from './WordSheet';

export function WordPanel({
  note, practiseHref, rowId, status, onStatus, onClose,
}: {
  note: Note;
  /** `tabs` is kept for older callers; the panel only has Explain now. */
  tabs?: string[];
  /** Where "Practise this word" goes (a `#/cards?…` link); the button is left out without it. */
  practiseHref?: string;
  /** The Excel row id; shown in the title because phone rows hide the id column. */
  rowId?: string | number;
  status?: WordStatus; onStatus?: (s: WordStatus) => void; onClose: () => void;
}) {
  return <WordSheet root={{ t: 'note', note, practiseHref, rowId, status, onStatus }} onClose={onClose} className="wp tall" />;
}
