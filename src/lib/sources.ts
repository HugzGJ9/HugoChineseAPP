// Getting the Excel file into the app: a file picked by hand (iPhone Files app, any computer)
// or the linked OneDrive folder (folder.ts). Sync then carries the word list to the other devices.
// A local import that looks broken (many words gone, a sheet unreadable) is held until Hugo decides (import/guard.ts).
import { importWorkbook } from './import';
import { prepareImport } from './import/guard';
import { kvGet, kvSet } from './db';
import { getState, notifyLocalChange, setPendingImport, setVocab } from './store';
import type { PendingImport, VocabFile } from './types';

export type ImportOutcome = {
  vocab: VocabFile;
  /** False when the import was held for review (or matches a list Hugo already turned down). */
  applied: boolean;
  /** Why it was held. */
  reasons?: string[];
  /** Words renamed in Excel whose history was kept (old id → new id). */
  renames?: Record<string, string>;
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

async function apply(vocab: VocabFile): Promise<void> {
  const before = getState().meta?.hash;
  await setVocab(vocab);
  if (getState().pendingImport) await setPending(null);
  if (vocab.hash !== before) {
    // A new word list for the other devices.
    await kvSet('vocabDirty', true);
    notifyLocalChange();
  }
}

export async function importBytes(bytes: ArrayBuffer, source: VocabFile['source']): Promise<ImportOutcome> {
  const s = getState();
  const raw = await importWorkbook({ bytes, source, now: Date.now(), device: s.device, prevSeeds: s.meta?.seeds ?? {} });
  // Compare with the list as it is now (sync may have replaced it while the worker ran).
  const prev = currentVocab();
  const { vocab, renames, check } = prepareImport(prev, raw);
  const r = Object.keys(renames).length ? { renames } : {};
  if (!check.ok) {
    // Nothing applied, nothing marked for sync.
    if ((await kvGet<string>(REJECTED, '')) !== vocab.hash) {
      await setPending({ vocab, reasons: check.reasons, prevCount: prev?.notes.length ?? 0 });
    }
    return { vocab, applied: false, reasons: check.reasons, ...r };
  }
  await apply(vocab);
  return { vocab, applied: true, ...r };
}

export async function importFile(file: File): Promise<ImportOutcome> {
  const bytes = await file.arrayBuffer();
  return importBytes(bytes, { name: file.name, modified: file.lastModified, size: file.size });
}

async function pending(): Promise<PendingImport | null> {
  return getState().pendingImport ?? (await kvGet<PendingImport | null>(PENDING, null));
}

/** "Use the new list": apply the held import. */
export async function acceptPendingImport(): Promise<void> {
  const p = await pending();
  if (!p) return;
  // Renames and seeds again, against the list as it is now.
  const { vocab } = prepareImport(currentVocab(), p.vocab);
  await apply(vocab);
  await setPending(null);
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
    return summary(v.vocab) + (n ? `, ${n} renamed word${n > 1 ? 's' : ''} kept ${n > 1 ? 'their' : 'its'} history` : '');
  }
  const fixes = v.issues.filter((i) => i.level === 'fix').length;
  const studied = v.notes.filter((n) => n.studied).length;
  return `${v.notes.length} notes imported, ${studied} already studied${fixes ? `, ${fixes} cells to fix` : ''}`;
}
