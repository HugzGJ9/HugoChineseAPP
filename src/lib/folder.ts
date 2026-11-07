// The OneDrive folder on a computer, through the File System Access API (Edge and Chrome).
// The app reads Hugo_chinese_vocab.xlsx whenever it changes, and writes "Hugo_chinese_vocab (app).xlsx" next to it: a
// copy of his workbook with his statuses as cell fills. The original is only ever read.
// OneDrive's own client does the uploading, so no Microsoft sign-in is needed.
import { kvGet, kvSet } from './db';
import { fnv1a } from './import/build';
import { importBytes, summary, wasRejected } from './sources';
import { copyFills, sheetRows } from './status';
import { getState, setFolder, subscribe } from './store';
import type { RowFill, SheetCols } from './types';
import { copyFileName, WorkbookChangedError, type PatchRequest, type PatchResponse, type PatchResult } from './xlsx/patch';

type Mode = { mode: 'read' | 'readwrite' };
interface DirHandle extends FileSystemDirectoryHandle {
  queryPermission(d: Mode): Promise<PermissionState>;
  requestPermission(d: Mode): Promise<PermissionState>;
}
type PickerWindow = Window & { showDirectoryPicker?: (o?: { id?: string; mode?: 'read' | 'readwrite'; startIn?: string }) => Promise<DirHandle> };

const RW: Mode = { mode: 'readwrite' };

export function folderSupported(): boolean {
  return typeof window !== 'undefined' && typeof (window as PickerWindow).showDirectoryPicker === 'function';
}

let notify: (m: string) => void = () => undefined;
/** Where to show "words updated" messages (the toaster). */
export function onFolderMessage(f: (m: string) => void) {
  notify = f;
}

async function handle(): Promise<DirHandle | null> {
  return kvGet<DirHandle | null>('folderHandle', null);
}

/** Ask for the folder (needs a click). Throws if the Excel file is not in it. */
export async function linkFolder(): Promise<boolean> {
  const pick = (window as PickerWindow).showDirectoryPicker!;
  let dir: DirHandle;
  try {
    dir = await pick({ id: 'hugo-onedrive', mode: 'readwrite', startIn: 'documents' });
  } catch (e) {
    if ((e as DOMException).name === 'AbortError') return false;
    throw e;
  }
  const fileName = getState().settings.fileName;
  try {
    await dir.getFileHandle(fileName);
  } catch {
    throw new Error(`${fileName} is not in “${dir.name}”. Pick the folder that contains it.`);
  }
  await kvSet('folderHandle', dir);
  await kvSet(COPY_SIG, '');
  setFolder({ state: 'ok', name: dir.name, message: undefined, writeError: undefined }, true);
  await checkFolder(true);
  return true;
}

export async function unlinkFolder(): Promise<void> {
  await kvSet('folderHandle', null);
  setFolder({ state: 'off' }, true);
}

/** Grant access again after the browser forgot it (needs a click). */
export async function allowFolder(): Promise<void> {
  const dir = await handle();
  if (!dir) return;
  if ((await dir.requestPermission(RW)) === 'granted') {
    setFolder({ state: 'ok', message: undefined });
    await checkFolder();
  }
}

let checking = false;
/** name|modified|size of the last Excel file that was held for review, not applied. */
let heldSig = '';

/** Read the Excel file if it changed since the last import. */
export async function checkFolder(force = false): Promise<void> {
  if (checking) return;
  const dir = await handle();
  if (!dir) {
    setFolder({ state: 'off' }, true);
    return;
  }
  checking = true;
  try {
    if ((await dir.queryPermission(RW)) !== 'granted') {
      setFolder({ state: 'permission', name: dir.name });
      return;
    }
    const fileName = getState().settings.fileName;
    let file: File;
    try {
      file = await (await dir.getFileHandle(fileName)).getFile();
    } catch {
      setFolder({ state: 'missing', name: dir.name, message: `${fileName} is no longer in “${dir.name}”.` });
      return;
    }
    const src = getState().meta?.source;
    const sig = `${file.name}|${file.lastModified}|${file.size}`;
    const changed = !src || src.name !== file.name || src.modified !== file.lastModified || src.size !== file.size;
    // A held file is not read again until it changes (or Hugo links the folder again).
    if (force || (changed && sig !== heldSig)) {
      const prevHash = getState().meta?.hash;
      const o = await importBytes(await file.arrayBuffer(), { name: file.name, modified: file.lastModified, size: file.size });
      if (o.applied) {
        heldSig = '';
        // A forced re-read of the same file (columns for the copy, a failed copy check) stays quiet.
        if (src && (changed || o.vocab.hash !== prevHash)) notify(`Words updated from Excel: ${summary(o)}`);
        scheduleWrite(1000);
      } else {
        heldSig = sig;
        if (!(await wasRejected(o.vocab))) notify(`${fileName} changed a lot, so the new word list is held for review. ${(o.reasons ?? []).join(' ')}`);
      }
    }
    setFolder({ state: 'ok', name: dir.name, message: undefined, checked: Date.now() });
  } catch (e) {
    setFolder({ state: 'error', name: dir.name, message: `Could not read the folder: ${(e as Error).message}` });
  } finally {
    checking = false;
  }
}

const COPY_SIG = 'copySig';

/** Columns per sheet, found at import (none for a list imported by an older app version). */
function sheetCols(): Record<string, SheetCols> {
  const out: Record<string, SheetCols> = {};
  for (const r of getState().meta?.report ?? []) if (r.cols) out[r.name] = r.cols;
  return out;
}

function colsMissing(): boolean {
  return (getState().meta?.report ?? []).some((r) => r.kind !== 'skipped' && r.notes > 0 && !r.cols);
}

/** Patch the workbook in a Web Worker; the bytes are moved there and back. */
function patchInWorker(req: PatchRequest): Promise<PatchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./xlsx/patch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PatchResponse>) => {
      worker.terminate();
      const d = e.data;
      if (d.ok) resolve(d.result);
      else reject(d.changed ? new WorkbookChangedError(d.changed.sheet, d.changed.row) : new Error(d.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The copy could not be built'));
    };
    worker.postMessage(req, [req.bytes.buffer]);
  });
}

async function exists(dir: DirHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name);
    return true;
  } catch {
    return false;
  }
}

let writing = false;
let again = false;
/** The last write failed (file open in Excel…): retried when the window gets the focus. */
let failed = false;
/** Forced re-reads already asked for (file sig + list hash), so a list that stays odd is not re-read in a loop. */
let colsReread = '';
let checkReread = '';

/**
 * Write "<file> (app).xlsx" next to the Excel file: the original's bytes with the rows whose status Hugo changed
 * filled in his colours. Rebuilt from the original every time; skipped when neither the file nor the fills changed.
 */
export async function writeCopy(force = false): Promise<void> {
  if (writing) {
    again = true;
    return;
  }
  const s = getState();
  if (!s.notes.length || !s.meta) return;
  const dir = await handle();
  if (!dir || (await dir.queryPermission(RW)) !== 'granted') return;
  const fileName = s.settings.fileName;
  const copyName = copyFileName(fileName);
  writing = true;
  let fileSig = '';
  try {
    let file: File;
    try {
      file = await (await dir.getFileHandle(fileName)).getFile();
    } catch {
      return; // checkFolder reports the missing file
    }
    fileSig = `${file.name}|${file.lastModified}|${file.size}`;
    const src = s.meta.source;
    if (src.name !== file.name || src.modified !== file.lastModified || src.size !== file.size) {
      // The rows must match this exact file: read it first, the import schedules the copy again.
      void checkFolder();
      return;
    }
    const reread = `${fileSig}|${s.meta.hash}`;
    if (colsMissing() && colsReread !== reread) {
      // Imported by an older app version: read the file again to find the columns to colour.
      colsReread = reread;
      void checkFolder(true);
      return;
    }
    const fills: RowFill[] = copyFills(sheetRows(s.notes, s.marks, s.meta.colourSince));
    const sig = `${fileSig}|${fnv1a(JSON.stringify(fills))}`;
    if (!force && sig === (await kvGet<string>(COPY_SIG, '')) && (await exists(dir, copyName))) return;
    const bytes = new Uint8Array(await file.arrayBuffer());
    const out = fills.length ? (await patchInWorker({ bytes, rows: fills, cols: sheetCols() })).bytes : bytes;
    const fh = await dir.getFileHandle(copyName, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(out as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    await kvSet(COPY_SIG, sig);
    failed = false;
    setFolder({ written: Date.now(), writeError: undefined });
  } catch (e) {
    if (e instanceof WorkbookChangedError) {
      // The words no longer sit where the import saw them: never write a copy that colours the wrong rows.
      failed = false;
      const key = `${fileSig}|${s.meta.hash}`;
      if (checkReread !== key) {
        checkReread = key;
        void checkFolder(true);
      } else {
        setFolder({ writeError: `${copyName} was not written: row ${e.row} of ${e.sheet} does not hold the word the app expects. Save ${fileName} again in Excel.` });
      }
      return;
    }
    failed = true;
    const name = (e as DOMException).name;
    setFolder({
      writeError:
        name === 'NoModificationAllowedError' || name === 'InvalidStateError'
          ? `${copyName} is open in Excel. Close it and the app updates it on the next change.`
          : `Could not write ${copyName}: ${(e as Error).message}`,
    });
  } finally {
    writing = false;
    if (again) {
      again = false;
      scheduleWrite(500);
    }
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleWrite(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => {
    timer = undefined;
    void writeCopy();
  }, ms);
}

/** Write now what is waiting (the tab is being hidden). */
function flushWrite() {
  if (timer === undefined && !failed) return;
  clearTimeout(timer);
  timer = undefined;
  void writeCopy();
}

let started = false;

/** Called once at start-up on every device; does nothing without a linked folder. */
export async function startFolder(): Promise<void> {
  if (started || !folderSupported()) return;
  started = true;
  const dir = await handle();
  if (dir) setFolder({ state: 'ok', name: dir.name });
  await checkFolder();
  // Also re-reads the file once when the list has no columns yet (imported by an older version).
  void writeCopy();
  // Status marks here or from the other devices, or a new word list from sync: refresh the copy after a pause.
  // (A list imported from the folder schedules its own, shorter, write in checkFolder.)
  let { marks, meta } = getState();
  subscribe(() => {
    const now = getState();
    if (now.marks !== marks || now.meta !== meta) {
      ({ marks, meta } = now);
      scheduleWrite(4000);
    }
  });
  window.addEventListener('focus', () => {
    void checkFolder();
    if (failed) void writeCopy();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkFolder();
    else flushWrite();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkFolder();
  }, 5 * 60000);
}
