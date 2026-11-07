// Bad-import guard: an Excel file saved half-way, a sheet renamed or emptied by mistake must not wipe the word list.
// A suspicious import is held until Hugo picks the old or the new list (sources.ts). Pure, so it is easy to test.
import type { VocabFile } from '../types';
import { detectRenames, mergeAliases, migrateSeeds } from './renames';
import { colourSinceFor } from '../status';

/** Whole list: held when it shrinks below this share of the previous size… */
const KEEP_SHARE = 0.8;
/** …and at least this many notes are gone (small lists can lose a few words without a prompt). */
const MIN_DROP = 20;
/** One sheet: held when it loses more than this share of its notes… */
const SHEET_SHARE = 0.5;
/** …and at least this many (a 3-row sheet losing 2 rows is a normal edit). */
const SHEET_MIN_DROP = 3;

export type ImportCheck = { ok: true } | { ok: false; reasons: string[] };

export function checkImport(prev: VocabFile | null, next: VocabFile): ImportCheck {
  if (!prev || !prev.notes.length) return { ok: true };
  const reasons: string[] = [];

  const before = prev.notes.length;
  const after = next.notes.length;
  if (after < KEEP_SHARE * before && before - after >= MIN_DROP) {
    reasons.push(`The new file has ${after} notes instead of ${before} (${before - after} fewer).`);
  }

  const nextSheets = new Map(next.report.map((s) => [s.name, s]));
  for (const old of prev.report) {
    if (old.kind === 'skipped' || old.notes <= 0) continue;
    const cur = nextSheets.get(old.name);
    if (!cur) reasons.push(`Sheet “${old.name}” (${old.notes} notes) is missing.`);
    else if (cur.kind === 'skipped') reasons.push(`Sheet “${old.name}” (${old.notes} notes) could not be read any more.`);
    else {
      const lost = old.notes - cur.notes;
      if (lost > SHEET_SHARE * old.notes && lost >= SHEET_MIN_DROP) {
        reasons.push(`Sheet “${old.name}” went from ${old.notes} to ${cur.notes} notes.`);
      }
    }
  }
  return reasons.length ? { ok: false, reasons } : { ok: true };
}

export interface PreparedImport {
  /** The new list with the accumulated aliases, the seeds of renamed words moved over and the row colour times. */
  vocab: VocabFile;
  /** Renames found in this import only (old id → new id). */
  renames: Record<string, string>;
  check: ImportCheck;
}

/**
 * Compare a fresh local import with the current list: renames, aliases, seeds, row colour times, and whether to hold it.
 * Run again on a held import once accepted, so everything is computed against the list as it is then.
 */
export function prepareImport(prev: VocabFile | null, next: VocabFile): PreparedImport {
  const renames = prev ? detectRenames(prev.notes, next.notes) : {};
  const aliases = mergeAliases(prev?.aliases, next.aliases, renames);
  const seeds = migrateSeeds(next.seeds, prev?.seeds ?? {}, renames);
  // A colour seen for the first time holds from when the file was saved (never later than the import).
  const t = Math.min(next.source.modified || next.importedAt, next.importedAt);
  const colourSince = colourSinceFor(next.notes, prev?.colourSince, renames, t);
  const { aliases: _old, colourSince: _since, ...rest } = next;
  const vocab: VocabFile = { ...rest, seeds, colourSince, ...(Object.keys(aliases).length ? { aliases } : {}) };
  return { vocab, renames, check: checkImport(prev, vocab) };
}
