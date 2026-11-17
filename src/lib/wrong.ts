// The Wrong label (plan 2026-11-16-mobile-ux D6): a word answered wrong in Cards carries a red "Wrong" tag until Hugo
// clears it. Stored as two mark kinds in the existing marks stream (ENG-2): `flag:wrong` and `unflag:wrong`. Per note,
// the latest of the two by (t, id) wins, so every device agrees whatever order the files arrive in.
// - Separate from status: `markStatus` returns null for both kinds, so `sheetRows` and the Excel write-back ignore them;
//   the engine (`applyMark` default branch, `latestMarks`) ignores them too, so cards and the golden replay are unchanged.
// - Older app versions keep the rows (`decodeMarks` accepts any kind string) and ignore them: no format bump.
// - Clearing writes `unflag:wrong`, never `undoMark` (which only removes this device's own marks).
// Pure helpers here; the writer is `setWrong` in store.ts.
import type { StatusMark } from './types';

export const WRONG_ON = 'flag:wrong', WRONG_OFF = 'unflag:wrong';

const isWrongKind = (a: string) => a === WRONG_ON || a === WRONG_OFF;
const later = (a: StatusMark, b: StatusMark) => b.t > a.t || (b.t === a.t && b.id > a.id);

/** Latest `flag:wrong` / `unflag:wrong` mark per note, by (t, id). Other kinds are ignored. */
export function latestWrongMarks(marks: StatusMark[]): Map<string, StatusMark> {
  const out = new Map<string, StatusMark>();
  for (const m of marks) {
    if (!isWrongKind(m.a)) continue;
    const cur = out.get(m.note);
    if (!cur || later(cur, m)) out.set(m.note, m);
  }
  return out;
}

/** Note ids that are Wrong: the latest of the two kinds is `flag:wrong`. Pass the alias-resolved marks (state.marks). */
export function wrongNotes(marks: StatusMark[]): Set<string> {
  const out = new Set<string>();
  for (const [note, m] of latestWrongMarks(marks)) if (m.a === WRONG_ON) out.add(note);
  return out;
}
