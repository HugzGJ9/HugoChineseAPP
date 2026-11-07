// Word renames: a note id is kind + hanzi + toneless pinyin, so fixing a pinyin letter in Excel gives the word a new id.
// detectRenames pairs such old and new ids so the review history follows the word (VocabFile.aliases).
// Events are never rewritten: the alias is applied to an in-memory view only (resolveEventCards in engine/schedule.ts).
import type { Note, SourceRef } from '../types';

function sameRow(a: SourceRef | undefined, b: SourceRef | undefined): boolean {
  if (!a || !b || a.sheet !== b.sheet) return false;
  return a.row === b.row || (!!a.id && !!b.id && a.id === b.id);
}

/** A pair matches when both notes are the same kind on the same sheet row (or ID cell); words must also keep their hanzi. */
function matches(o: Note, n: Note): boolean {
  if (o.kind !== n.kind) return false;
  if (o.kind !== 'grammar' && o.hanzi !== n.hanzi) return false;
  return sameRow(o.refs[0], n.refs[0]);
}

/** Old note id → new note id, for unique 1:1 matches between notes that disappeared and notes that appeared. */
export function detectRenames(prev: Note[], next: Note[]): Record<string, string> {
  const prevIds = new Set(prev.map((n) => n.id));
  const nextIds = new Set(next.map((n) => n.id));
  const gone = prev.filter((n) => !nextIds.has(n.id));
  const added = next.filter((n) => !prevIds.has(n.id));
  if (!gone.length || !added.length) return {};

  const candidates = new Map<string, Note[]>();
  const backCount = new Map<string, number>();
  for (const o of gone) {
    const c = added.filter((n) => matches(o, n));
    candidates.set(o.id, c);
    for (const n of c) backCount.set(n.id, (backCount.get(n.id) ?? 0) + 1);
  }
  const out: Record<string, string> = {};
  for (const o of gone) {
    const c = candidates.get(o.id)!;
    if (c.length === 1 && backCount.get(c[0].id) === 1) out[o.id] = c[0].id;
  }
  return out;
}

/** Aliases accumulate across imports; the newest pairing of an old id wins. */
export function mergeAliases(...maps: (Record<string, string> | undefined)[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of maps) if (m) for (const [k, v] of Object.entries(m)) if (k !== v) out[k] = v;
  return out;
}

/** A renamed green word keeps its seed time: it moves to the new id when the new id has none yet. */
export function migrateSeeds(
  seeds: Record<string, number>,
  prevSeeds: Record<string, number>,
  renames: Record<string, string>,
): Record<string, number> {
  const out = { ...seeds };
  for (const [from, to] of Object.entries(renames)) {
    if (prevSeeds[from] != null && prevSeeds[to] == null) out[to] = prevSeeds[from];
  }
  return out;
}
