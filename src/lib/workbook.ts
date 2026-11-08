// The workbook in Hugo's OneDrive, read through Microsoft Graph on any device (the iPhone too).
// Linked once (by the item the shared list came from, or by name), then its metadata (about 1 KB) is checked on start,
// focus, every 2 minutes while visible and when the connection comes back. The 1.5 MB file is downloaded only when its
// content id (quickXorHash) is not the one the word list came from, and imported as a picked file would be.
import { kvGet, kvSet } from './db';
import { msConfigured } from './ms/auth';
import { download, findByName, getItem, GraphError, type DriveItem } from './ms/graph';
import { quickXorHash } from './ms/qxh';
import { importBytes, isOlderThanList, summary, wasRejected } from './sources';
import { getState, setExcel, subscribe } from './store';
import { getLink, syncNow } from './sync';
import type { WorkbookSource } from './types';
import { copyFileName } from './xlsx/patch';

/** The linked workbook (kv odWorkbook). */
export interface OdWorkbook {
  drive: string;
  item: string;
  name: string;
  path?: string;
  linkedAt: number;
}

/** Bytes of the last workbook version read or written (kv excelCache), so the same content is not downloaded twice. */
interface ExcelCache {
  qxh: string;
  bytes: Uint8Array;
  /** cTag of the item the bytes came from: identifies the content when the metadata carries no hash. */
  cTag?: string;
}

const LINK = 'odWorkbook';
const CACHE = 'excelCache';
const POLL_MS = 2 * 60000;

let notify: (m: string) => void = () => undefined;
/** Where to show "words updated" messages (the toaster). */
export function onWorkbookMessage(f: (m: string) => void) {
  notify = f;
}

const linked = () => kvGet<OdWorkbook | null>(LINK, null);
const isGraph404 = (e: unknown) => e instanceof GraphError && e.status === 404;

/** A file that may be Hugo's workbook: the exact name, not the app's copy nor a OneDrive conflict copy (name-PC.xlsx). */
function candidate(item: DriveItem, fileName: string): boolean {
  const name = item.name.toLowerCase();
  if (name !== fileName.toLowerCase()) return false;
  return name !== copyFileName(fileName).toLowerCase() && !/ \(app\)\.xlsx$/i.test(item.name);
}

/** Files in OneDrive named like the workbook, newest first (several → Hugo picks one). */
export async function findWorkbooks(): Promise<DriveItem[]> {
  const fileName = getState().settings.fileName;
  const found = (await findByName(fileName)).filter((i) => candidate(i, fileName));
  return found.sort((a, b) => Date.parse(b.lastModifiedDateTime) - Date.parse(a.lastModifiedDateTime));
}

async function saveLink(item: DriveItem): Promise<OdWorkbook> {
  const link: OdWorkbook = {
    drive: item.parentReference?.driveId ?? '',
    item: item.id,
    name: item.name,
    ...(item.parentReference?.path ? { path: item.parentReference.path } : {}),
    linkedAt: Date.now(),
  };
  await kvSet(LINK, link);
  setExcel({ state: 'ok', name: link.name, path: link.path, message: undefined }, true);
  return link;
}

/** Read this file from now on (Hugo picked it), and read it now. */
export async function linkWorkbook(item: DriveItem): Promise<void> {
  await saveLink(item);
  heldQxh = '';
  await checkWorkbook(true);
}

export async function unlinkWorkbook(): Promise<void> {
  await kvSet(LINK, null);
  await kvSet(CACHE, null);
  heldQxh = '';
  setExcel({ state: 'off' }, true);
}

/**
 * Find the workbook without asking: the item the word list came from when it still exists, else the one file with the
 * workbook's name. Several files → the panel's picker (findWorkbooks). Returns the item, linked, or null.
 */
async function autoLink(): Promise<DriveItem | null> {
  const src = getState().meta?.source;
  if (src?.drive && src.item) {
    try {
      const item = await getItem(src.drive, src.item);
      await saveLink(item);
      return item;
    } catch (e) {
      if (!isGraph404(e)) throw e;
    }
  }
  return linkByName();
}

async function linkByName(): Promise<DriveItem | null> {
  const fileName = getState().settings.fileName;
  const found = await findWorkbooks();
  if (found.length === 1) {
    await saveLink(found[0]);
    return found[0];
  }
  if (found.length) {
    setExcel({ state: 'off', name: fileName, message: `${found.length} files in OneDrive are named ${fileName}. Pick the one to read.` });
  } else {
    setExcel({ state: 'missing', name: fileName, message: `${fileName} was not found in your OneDrive.` });
  }
  return null;
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

/** Content id of a held version: not read again until the workbook changes (or Hugo reads it now). */
let heldQxh = '';
let running: Promise<void> | null = null;
let again: boolean | null = null;

/** Read the workbook if its content isn't the one the word list came from. Single-flight; nothing offline or signed out. */
export function checkWorkbook(force = false): Promise<void> {
  if (getState().ms.state !== 'ok' || !online()) return Promise.resolve();
  if (running) {
    again = (again ?? false) || force;
    return running;
  }
  running = (async () => {
    try {
      let f: boolean = force;
      for (;;) {
        await checkOnce(f);
        if (again === null) break;
        f = again;
        again = null;
      }
    } finally {
      running = null;
      again = null;
    }
  })();
  return running;
}

async function checkOnce(force: boolean): Promise<void> {
  let link = await linked();
  let item: DriveItem | null = null;
  try {
    if (!link) {
      item = await autoLink();
      if (!item) return;
      link = (await linked())!;
    } else {
      try {
        item = await getItem(link.drive, link.item);
      } catch (e) {
        if (!isGraph404(e)) throw e;
        // Deleted or moved to another drive: look for it by name again.
        setExcel({ state: 'missing', name: link.name, message: `${link.name} is no longer in your OneDrive.` });
        item = await linkByName();
        if (!item) return;
        link = (await linked())!;
      }
      if (item.name !== link.name || (item.parentReference?.path ?? link.path) !== link.path) {
        // Renamed or moved: still the same file.
        link = { ...link, name: item.name, ...(item.parentReference?.path ? { path: item.parentReference.path } : {}) };
        await kvSet(LINK, link);
      }
    }
    await readItem(link, item, force);
    setExcel({ state: 'ok', name: link.name, path: link.path, checked: Date.now(), message: undefined });
  } catch (e) {
    setExcel({ state: 'error', name: link?.name, message: `Could not read the workbook in OneDrive: ${(e as Error).message}` });
  }
}

async function readItem(link: OdWorkbook, item: DriveItem, force: boolean): Promise<void> {
  const cache = await kvGet<ExcelCache | null>(CACHE, null);
  // The content id: from OneDrive, else known from the cached bytes of the same version.
  const known = item.file?.hashes?.quickXorHash || (cache?.cTag && cache.cTag === item.cTag ? cache.qxh : undefined);
  const source: WorkbookSource = {
    name: item.name,
    modified: Date.parse(item.lastModifiedDateTime) || 0,
    size: item.size,
    ...(known ? { qxh: known } : {}),
    drive: link.drive,
    item: item.id,
  };
  const current = () => getState().meta?.source;
  const same = () => !!known && current()?.qxh === known;
  if (!force) {
    if (same()) return;
    if (isOlderThanList(source)) return;
    if (known && known === heldQxh) return;
    // Another device may already have imported this version: take the shared list first, it holds the history.
    // (At start-up the sync state may not be set yet: the link tells.)
    const sync = getState().sync;
    if ((sync.last ?? 0) < source.modified && (sync.state !== 'off' || (await getLink()))) {
      await syncNow().catch(() => undefined);
      if (same() || isOlderThanList(source)) return;
    }
  }
  let bytes: Uint8Array;
  if (cache && known && cache.qxh === known) {
    bytes = cache.bytes;
  } else {
    bytes = await download(item);
    const qxh = known ?? quickXorHash(bytes);
    source.qxh = qxh;
    await kvSet(CACHE, { qxh, bytes, cTag: item.cTag } satisfies ExcelCache);
    if (!force && (current()?.qxh === qxh || qxh === heldQxh)) return;
  }
  const hadList = !!getState().meta;
  const prevHash = getState().meta?.hash;
  // The worker takes the bytes it is given: hand it a copy, the cache keeps its own.
  const o = await importBytes(bytes.slice().buffer, source);
  if (o.applied) {
    heldQxh = '';
    if (hadList && (o.vocab.hash !== prevHash || o.changes?.length)) notify(`Words updated from Excel: ${summary(o)}`);
  } else {
    heldQxh = source.qxh ?? '';
    if (!(await wasRejected(o.vocab))) {
      notify(`${item.name} changed a lot, so the new word list is held for review. ${(o.reasons ?? []).join(' ')}`);
    }
  }
}

let started = false;

/** Called once at start-up on every device; does nothing until Microsoft is signed in. */
export async function startWorkbook(): Promise<void> {
  if (started || !msConfigured()) return;
  started = true;
  const link = await linked();
  if (link) setExcel({ state: 'ok', name: link.name, path: link.path });
  void checkWorkbook();
  if (typeof window === 'undefined') return;
  // Signed in again (Reconnect): read what was missed.
  let ms = getState().ms.state;
  subscribe(() => {
    const now = getState().ms.state;
    if (now === ms) return;
    ms = now;
    if (now === 'ok') void checkWorkbook();
  });
  window.addEventListener('focus', () => void checkWorkbook());
  window.addEventListener('online', () => void checkWorkbook());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkWorkbook();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkWorkbook();
  }, POLL_MS);
}
