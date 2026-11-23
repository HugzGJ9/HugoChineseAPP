// His vocabulary as the word sheet sees it: the longest-match index, each note's status and a lookup by id. One
// computation is shared by every line on screen (module memo, keyed on the store arrays) (plan 2026-11-23 D4).
import type { Note, WordStatus } from '../../lib/types';
import { useApp } from '../../lib/store';
import { noteStatuses, sheetRows } from '../../lib/status';
import { vocabIndex, type VocabIndex } from '../../lib/sentence';

export interface Vocab { index: VocabIndex; statuses: Map<string, WordStatus>; byId: Map<string, Note> }

let memo: { notes: unknown; marks: unknown; meta: unknown; out: Vocab } | null = null;

export function useVocab(): Vocab {
  const notes = useApp((s) => s.notes);
  const marks = useApp((s) => s.marks);
  const meta = useApp((s) => s.meta);
  if (!memo || memo.notes !== notes || memo.marks !== marks || memo.meta !== meta) {
    memo = {
      notes, marks, meta,
      out: {
        index: vocabIndex(notes),
        statuses: noteStatuses(sheetRows(notes, marks, meta?.colourSince)),
        byId: new Map(notes.map((n) => [n.id, n])),
      },
    };
  }
  return memo.out;
}
