// The OneDrive folder on a computer, through the File System Access API (Edge and Chrome).
// The app reads Hugo_chinese_vocab.xlsx whenever it changes and writes Hugo_chinese_progress.xlsx next to it.
// OneDrive's own client does the uploading, so no Microsoft sign-in is needed.
import { dayKey } from './engine/schedule';
import { kvGet, kvSet } from './db';
import { PROGRESS_FILE, progressWorkbook } from './progress';
import { importBytes, summary, wasRejected } from './sources';
import { getState, onLocalChange, setFolder, subscribe } from './store';

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
  await kvSet('progressSig', '');
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
      const o = await importBytes(await file.arrayBuffer(), { name: file.name, modified: file.lastModified, size: file.size });
      if (o.applied) {
        heldSig = '';
        if (src) notify(`Words updated from Excel: ${summary(o)}`);
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

function signature(): string {
  const { events, meta } = getState();
  const last = events.reduce((m, e) => Math.max(m, e.t), 0);
  return `${meta?.hash}|${events.length}|${last}|${dayKey(Date.now())}`;
}

let writing = false;

/** Write Hugo_chinese_progress.xlsx next to the Excel file, unless nothing changed. */
export async function writeProgress(force = false): Promise<void> {
  const s = getState();
  if (writing || !s.notes.length) return;
  const dir = await handle();
  if (!dir || (await dir.queryPermission(RW)) !== 'granted') return;
  const sig = signature();
  if (!force && sig === (await kvGet<string>('progressSig', ''))) return;
  writing = true;
  try {
    const bytes = progressWorkbook({ notes: s.notes, cards: s.cards.values(), events: s.events, device: s.device, now: Date.now() });
    const fh = await dir.getFileHandle(PROGRESS_FILE, { create: true });
    const w = await fh.createWritable();
    try {
      await w.write(bytes as Uint8Array<ArrayBuffer>);
      await w.close();
    } catch (e) {
      await w.abort().catch(() => undefined);
      throw e;
    }
    await kvSet('progressSig', sig);
    setFolder({ written: Date.now(), writeError: undefined });
  } catch (e) {
    const name = (e as DOMException).name;
    setFolder({
      writeError:
        name === 'NoModificationAllowedError' || name === 'InvalidStateError'
          ? `${PROGRESS_FILE} is open in Excel. Close it and the app updates it on the next change.`
          : `Could not write ${PROGRESS_FILE}: ${(e as Error).message}`,
    });
  } finally {
    writing = false;
  }
}

let timer: ReturnType<typeof setTimeout> | undefined;
function scheduleWrite(ms: number) {
  clearTimeout(timer);
  timer = setTimeout(() => void writeProgress(), ms);
}

let started = false;

/** Called once at start-up on every device; does nothing without a linked folder. */
export async function startFolder(): Promise<void> {
  if (started || !folderSupported()) return;
  started = true;
  const dir = await handle();
  if (dir) setFolder({ state: 'ok', name: dir.name });
  await checkFolder();
  void writeProgress();
  // New reviews, here or from the other devices: refresh the workbook after a pause.
  let events = getState().events;
  subscribe(() => {
    const now = getState().events;
    if (now !== events) {
      events = now;
      scheduleWrite(30000);
    }
  });
  onLocalChange(() => scheduleWrite(30000));
  window.addEventListener('focus', () => void checkFolder());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkFolder();
    else void writeProgress();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkFolder();
  }, 5 * 60000);
}
