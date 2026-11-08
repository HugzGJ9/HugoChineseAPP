// Getting the Excel file into the app: a file picked by hand (iPhone Files app, any computer), the linked OneDrive
// folder (folder.ts) or the workbook in OneDrive through Microsoft Graph (workbook.ts). Sync then carries the word list
// to the other devices. Every import records the workbook content it came from (source.qxh, OneDrive's quickXorHash),
// so the readers and the devices can tell a version they already have from a new one.
// A local import that looks broken (many words gone, a sheet unreadable) is held until Hugo decides (import/guard.ts).
import { importWorkbook } from './import';
import { prepareImport } from './import/guard';
import { kvGet, kvSet } from './db';
import { quickXorHash } from './ms/qxh';
import { getState, notifyLocalChange, setPendingImport, setVocab } from './store';
import type { Explained, PendingImport, StatusChange, VocabFile, WorkbookSource } from './types';

export type ImportOutcome = {
  vocab: VocabFile;
  /** False when the import was held for review (or matches a list Hugo already turned down). */
  applied: boolean;
  /** Why it was held. */
  reasons?: string[];
  /** Words renamed in Excel whose history was kept (old id → new id). */
  renames?: Record<string, string>;
  /** Effective statuses the new list changed (Excel edits). */
  changes?: StatusChange[];
};

/** Hash of the last held list Hugo turned down: the folder watcher doesn't ask again until the file changes. */
const REJECTED = 'rejectedImportHash';
const PENDING = 'pendingImport';

function currentVocab(): VocabFile | null {
  const s = getState();
  return s.meta ? { ...s.meta, notes: s.notes } : null;
}

/** Held import, in memory and in kv.pendingImport (store.setPendingImport keeps both). */
async function setPending(p: PendingImport | null): Promise<void> {
  await setPendingImport(p ?? undefined);
}

// Imports and accepts run one at a time: each is compared with the list the previous one left.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
}

async function apply(vocab: VocabFile): Promise<StatusChange[]> {
  const before = getState().meta;
  const changes = await setVocab(vocab);
  if (getState().pendingImport) await setPending(null);
  if (vocab.hash !== before?.hash || vocab.source.qxh !== before?.source.qxh) {
    // A new word list, or the same words from another workbook version: the other devices need it (the version
    // tells them they have this content already).
    await kvSet('vocabDirty', true);
    notifyLocalChange();
  }
  return changes;
}

/** Whether a workbook version is older than the one the current list came from (a cloud copy lagging behind). */
export function isOlderThanList(source: WorkbookSource): boolean {
  const cur = getState().meta?.source;
  if (!cur || !cur.modified || !source.modified) return false;
  if (cur.qxh && source.qxh && cur.qxh === source.qxh) return false;
  return source.modified < cur.modified;
}

export function importBytes(bytes: ArrayBuffer, source: WorkbookSource, opts: { explained?: Explained } = {}): Promise<ImportOutcome> {
  // The content id is taken before the bytes move to the worker.
  const src: WorkbookSource = source.qxh ? source : { ...source, qxh: quickXorHash(new Uint8Array(bytes)) };
  return serial(() => importNow(bytes, src, opts.explained));
}

async function importNow(bytes: ArrayBuffer, source: WorkbookSource, explained?: Explained): Promise<ImportOutcome> {
  const s = getState();
  const raw = await importWorkbook({ bytes, source, now: Date.now(), device: s.device, prevSeeds: s.meta?.seeds ?? {} });
  // Compare with the list as it is now (sync may have replaced it while the worker ran).
  const prev = currentVocab();
  const { vocab, renames, check } = prepareImport(prev, raw, explained);
  const r = Object.keys(renames).length ? { renames } : {};
  if (!check.ok) {
    // Nothing applied, nothing marked for sync.
    if ((await kvGet<string>(REJECTED, '')) !== vocab.hash) {
      await setPending({ vocab, reasons: check.reasons, prevCount: prev?.notes.length ?? 0 });
    }
    return { vocab, applied: false, reasons: check.reasons, ...r };
  }
  const changes = await apply(vocab);
  return { vocab, applied: true, ...r, ...(changes.length ? { changes } : {}) };
}

export async function importFile(file: File): Promise<ImportOutcome> {
  const bytes = await file.arrayBuffer();
  return importBytes(bytes, { name: file.name, modified: file.lastModified, size: file.size });
}

async function pending(): Promise<PendingImport | null> {
  return getState().pendingImport ?? (await kvGet<PendingImport | null>(PENDING, null));
}

/** "Use the new list": apply the held import. */
export function acceptPendingImport(): Promise<void> {
  return serial(async () => {
    const p = await pending();
    if (!p) return;
    // Renames and seeds again, against the list as it is now.
    const { vocab } = prepareImport(currentVocab(), p.vocab);
    await apply(vocab);
    await setPending(null);
  });
}

/** "Keep the old list": drop the held import and don't ask again for the same file. */
export async function rejectPendingImport(): Promise<void> {
  const p = await pending();
  if (p) await kvSet(REJECTED, p.vocab.hash);
  await setPending(null);
}

/** Whether a held import is one Hugo already turned down (no need to tell him again). */
export async function wasRejected(vocab: VocabFile): Promise<boolean> {
  return (await kvGet<string>(REJECTED, '')) === vocab.hash;
}

export function summary(v: VocabFile | ImportOutcome): string {
  if ('applied' in v) {
    if (!v.applied) return `New word list held for review: ${(v.reasons ?? []).join(' ')}`;
    const n = Object.keys(v.renames ?? {}).length;
    const c = v.changes?.length ?? 0;
    return (
      summary(v.vocab) +
      (n ? `, ${n} renamed word${n > 1 ? 's' : ''} kept ${n > 1 ? 'their' : 'its'} history` : '') +
      (c ? `, ${c} status${c > 1 ? 'es' : ''} changed` : '')
    );
  }
  const fixes = v.issues.filter((i) => i.level === 'fix').length;
  const studied = v.notes.filter((n) => n.studied).length;
  return `${v.notes.length} notes imported, ${studied} already studied${fixes ? `, ${fixes} cells to fix` : ''}`;
}
