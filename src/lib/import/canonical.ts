// One shared import history (plan D3). Colour times, seeds and aliases are history, so the devices must share one
// history to agree on the statuses. The shared word list (vocab.json.gz) records the workbook content it came from
// (source.qxh, OneDrive's quickXorHash). When the list pulled from sync and the list on this device came from the same
// workbook content, they are merged by rules that don't depend on the order (earliest time, union), so every device
// converges. Pure: no database, no network.
import type { VocabFile, WordStatus } from '../types';

type Since = NonNullable<VocabFile['colourSince']>;

/**
 * Two imports of the same workbook content: per row key, the same status keeps the earliest time and a different status
 * takes the remote entry; seeds per note take the earliest; aliases are the union (the remote wins a key clash);
 * `source.app` is true if either list has it. Everything else comes from the remote.
 */
export function mergeSameVersion(local: VocabFile, remote: VocabFile): VocabFile {
  const out: VocabFile = { ...remote };

  const ls = local.colourSince;
  const rs = remote.colourSince;
  if (ls || rs) {
    const since: Since = { ...(ls ?? {}) };
    for (const [k, r] of Object.entries(rs ?? {})) {
      const l = since[k];
      since[k] = l && l[0] === r[0] ? [r[0] as WordStatus, Math.min(l[1], r[1])] : [r[0], r[1]];
    }
    out.colourSince = since;
  }

  const seeds: Record<string, number> = { ...local.seeds };
  for (const [k, t] of Object.entries(remote.seeds ?? {})) seeds[k] = seeds[k] == null ? t : Math.min(seeds[k], t);
  out.seeds = seeds;

  if (local.aliases || remote.aliases) out.aliases = { ...(local.aliases ?? {}), ...(remote.aliases ?? {}) };

  const source = { ...remote.source };
  if (local.source.app || remote.source.app) source.app = true;
  // The same content read from the folder (no item) and through Graph: keep the OneDrive item, so the workbook can be
  // found again without a search.
  if (!source.item && local.source.item) {
    source.item = local.source.item;
    if (local.source.drive) source.drive = local.source.drive;
  }
  out.source = source;
  return out;
}

/**
 * What to do with the shared list pulled from sync (step 1), given the list on this device and whether this device
 * changed it since the last push:
 * - `take`: replace the list here with the remote one;
 * - `keep`: keep the list here (it is pushed);
 * - `merge`: same workbook content: `mergeSameVersion`, pushed when it differs from the remote;
 * - `take-reimport`: the workbook content here is newer: take the remote (the shared history), then import the workbook
 *   again on top of it (sync.onRebase).
 * Lists without a content id (older app versions): the newest import wins, a list changed here wins a tie.
 */
export function vocabAction(local: VocabFile | null, localDirty: boolean, remote: VocabFile): 'take' | 'merge' | 'keep' | 'take-reimport' {
  if (!local) return 'take';
  const lq = local.source?.qxh;
  const rq = remote.source?.qxh;
  if (!lq || !rq) return localDirty && local.importedAt >= remote.importedAt ? 'keep' : 'take';
  if (lq === rq) return 'merge';
  return (remote.source.modified ?? 0) >= (local.source.modified ?? 0) ? 'take' : 'take-reimport';
}

/** JSON with object keys sorted, so equal values give equal text. */
function stable(v: unknown): string {
  if (v === undefined) return 'null';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .filter((k) => o[k] !== undefined)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
    .join(',')}}`;
}

/** Whether two lists differ in what the shared history carries (words through their hash, source, times, seeds, aliases). */
export function vocabDiffers(a: VocabFile, b: VocabFile): boolean {
  if (a.hash !== b.hash || a.importedAt !== b.importedAt) return true;
  const pick = (v: VocabFile) => stable([v.source, v.colourSince ?? {}, v.seeds ?? {}, v.aliases ?? {}]);
  return pick(a) !== pick(b);
}
