// The workbook in Hugo's OneDrive, read and written through Microsoft Graph on any device (the iPhone too).
// Reading: linked once (by the item the shared list came from, or by name), then its metadata (about 1 KB) is checked on
// start, focus, every 2 minutes while visible and when the connection comes back. The 1.5 MB file is downloaded only when
// its content id (quickXorHash) is not the one the word list came from, and imported as a picked file would be.
// Writing (plan 2026-11-08 D5–D7): the statuses Hugo set that the colours don't show yet are patched into the workbook's
// fills (nothing else changes) and uploaded with If-Match, so a version the app hasn't read is never replaced: when
// Excel saved meanwhile (412) the app reads that version, re-patches and tries again. Before the upload a write intent is
// saved (writeIntents.ts), so the app's own write never counts as an Excel edit. A backup goes to the app folder first.
import { fnv1a } from './import/build';
import { kvGet, kvSet, pref, setPref } from './db';
import { colsMissing, folderSignals, sheetCols } from './folder';
import { msConfigured } from './ms/auth';
import { backupWorkbook } from './ms/appfolder';
import { locateFile, listExcelFiles, type LookupStep } from './ms/find';
import { download, getItem, GraphError, uploadReplace, type DriveItem } from './ms/graph';
import { quickXorHash } from './ms/qxh';
import { importBytes, isOlderThanList, summary, wasRejected } from './sources';
import { copyFills, fillsExplained, sheetRows } from './status';
import { getState, setExcel, subscribe, type ExcelInfo } from './store';
import { backoffDelay, onSharedList, syncLinked, syncNow } from './sync';
import type { RowFill, StatusMark, WorkbookSource } from './types';
import { addIntent, dropCovered, dropIntent, liveExplained, updateIntent, WRITE_TARGET } from './writeIntents';
import { copyFileName, WorkbookChangedError } from './xlsx/patch';
import { patchInWorker } from './xlsx/patchClient';

export { WRITE_TARGET };

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

/**
 * Why statuses are waiting to be written (ExcelInfo.waiting), for the panel:
 * - `confirm`: this device hasn't confirmed the first write yet (confirmFirstWrite);
 * - `off`: automatic writing is off on this device (`excel.write`); "Write now" still writes;
 * - `quiet`: the workbook was edited less than 5 minutes ago (Excel may be open), writing at `waitUntil`;
 * - `open`: on the PC, Excel has the workbook open (its owner file `~$…`);
 * - `local`: on the PC, the local file holds edits OneDrive hasn't uploaded yet;
 * - `behind`: OneDrive's version is older than the word list (a save not uploaded yet, maybe on the other device);
 * - `locked`: OneDrive answered 423 (open in Excel), tried again at `waitUntil`;
 * - `busy`: OneDrive asked to wait (429/503), or the workbook kept changing during the write (3 × 412);
 * - `retry`: the last write failed (`writeError`), tried again at `waitUntil`;
 * - `held`: a new version of the workbook is held for review (Sheets), no write until Hugo decides;
 * - `other`: the other device set these statuses a moment ago and writes them itself; this one takes over at `waitUntil`;
 * - `offline`, `signin`: no connection, or the Microsoft sign-in expired (Reconnect).
 */
export type WriteWait = 'confirm' | 'off' | 'quiet' | 'open' | 'local' | 'behind' | 'locked' | 'busy' | 'retry' | 'held' | 'other' | 'offline' | 'signin';

const LINK = 'odWorkbook';
const CACHE = 'excelCache';
const STUCK = 'excelStuck';
const BACKUP_AT = 'excelBackupAt';
const CONFIRMED = 'excelConfirmed';
const LAST_UPLOAD = 'excelLastUpload';
const WRITE_PREF = 'excel.write';
const POLL_MS = 2 * 60000;
/** A pause after the last status change, so a burst of changes is one upload. */
const DEBOUNCE_MS = 30000;
/** A workbook edited less recently than this is not open in Excel any more, as far as anyone can tell. */
export const QUIET_MS = 5 * 60000;
/** A status the other device set less than this ago is left to it (it writes it itself). */
const LEAVE_MS = 2 * 60000;
/** A backup before the first write, then weekly. */
const BACKUP_EVERY = 7 * 86400000;
/** Local signals (Excel open on the PC, local edits) are checked again after this. */
const SIGNAL_RECHECK = 60000;

let notify: (m: string) => void = () => undefined;
/** Where to show "words updated" messages (the toaster). */
export function onWorkbookMessage(f: (m: string) => void) {
  notify = f;
}

const linked = () => kvGet<OdWorkbook | null>(LINK, null);
const isGraph404 = (e: unknown) => e instanceof GraphError && e.status === 404;

/** Whether a workbook is linked (kept in memory for the pending count). */
let linkedNow = false;

/** A file that may be Hugo's workbook: the exact name, not the app's copy nor a OneDrive conflict copy (name-PC.xlsx). */
function candidate(item: DriveItem, fileName: string): boolean {
  const name = item.name.toLowerCase();
  if (name !== fileName.toLowerCase()) return false;
  return name !== copyFileName(fileName).toLowerCase() && !/ \(app\)\.xlsx$/i.test(item.name);
}

/** Files in OneDrive named like the workbook, newest first (several → Hugo picks one). Path lookups, then searches, then
 * recent files (ms/find.ts); `all` runs every lookup instead of stopping at the first that finds it (the picker). */
export async function findWorkbooks(opts: { all?: boolean } = {}): Promise<DriveItem[]> {
  const fileName = getState().settings.fileName;
  const link = await linked();
  const r = await locateFile(fileName, { drive: link?.drive, folder: link?.path, all: opts.all });
  lastSteps = r.steps;
  const items = r.items.filter((i) => candidate(i, fileName));
  return items.sort((a, b) => Date.parse(b.lastModifiedDateTime) - Date.parse(a.lastModifiedDateTime));
}

let lastSteps: LookupStep[] = [];
/** What each lookup of the last findWorkbooks gave (tests, diagnostics). */
export const lastLookup = (): LookupStep[] => lastSteps;

/** Every Excel file OneDrive lists (up to 200, newest first), except the app's copy: when the name finds nothing. */
export async function findExcelFiles(): Promise<DriveItem[]> {
  const copy = copyFileName(getState().settings.fileName).toLowerCase();
  return (await listExcelFiles(200)).items.filter((i) => i.name.toLowerCase() !== copy && !/ \(app\)\.xlsx$/i.test(i.name));
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
  linkedNow = true;
  confirmedNow = await isConfirmed(link.item);
  setExcel({ state: 'ok', name: link.name, path: link.path, message: undefined }, true);
  refreshPending();
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
  linkedNow = false;
  clearTimeout(writeTimer);
  writeTimer = undefined;
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

export const missingText = (fileName: string) => `Couldn't find ${fileName} in your OneDrive — pick it with Change workbook.`;

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
    setExcel({ state: 'missing', name: fileName, message: missingText(fileName) });
  }
  return null;
}

function online(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

// Reading and writing take turns (each compares with the list the other left).
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

/** One write-back at a time across the tabs of this device (Web Locks; iOS before 15.4 has none and runs directly). */
function exclusive(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
  if (!locks?.request) return fn();
  return locks.request('hz-excel', fn) as Promise<void>;
}

/** Content id of a held version: not read again until the workbook changes (or Hugo reads it now). */
let heldQxh = '';
let running: Promise<void> | null = null;
let again: boolean | null = null;

/** Read the workbook if its content isn't the one the word list came from. Single-flight; nothing offline or signed out. */
export function checkWorkbook(force = false): Promise<void> {
  if (getState().ms.state !== 'ok' || !online()) return Promise.resolve();
  installHooks();
  if (running) {
    again = (again ?? false) || force;
    return running;
  }
  running = (async () => {
    try {
      let f: boolean = force;
      for (;;) {
        await serial(() => checkOnce(f));
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

/** The linked item, found again when it moved or was replaced; null when there is none (the state says why). */
async function currentItem(): Promise<{ link: OdWorkbook; item: DriveItem } | null> {
  let link = await linked();
  let item: DriveItem | null = null;
  if (!link) {
    item = await autoLink();
    if (!item) return null;
    link = (await linked())!;
  } else {
    try {
      item = await getItem(link.drive, link.item);
    } catch (e) {
      if (!isGraph404(e)) throw e;
      // Deleted, or moved to another drive: look for it again (by path, search, recent). 'missing' only if none finds it.
      item = await linkByName();
      if (!item) return null;
      link = (await linked())!;
    }
    if (item.name !== link.name || (item.parentReference?.path ?? link.path) !== link.path) {
      // Renamed or moved: still the same file.
      link = { ...link, name: item.name, ...(item.parentReference?.path ? { path: item.parentReference.path } : {}) };
      await kvSet(LINK, link);
    }
  }
  linkedNow = true;
  return { link, item };
}

async function checkOnce(force: boolean): Promise<void> {
  let name: string | undefined;
  try {
    const cur = await currentItem();
    if (!cur) return;
    name = cur.link.name;
    await readItem(cur.link, cur.item, force);
    setExcel({ state: 'ok', name: cur.link.name, path: cur.link.path, checked: Date.now(), message: undefined });
  } catch (e) {
    setExcel({ state: 'error', name: name ?? getState().excel.name, message: `Could not read the workbook in OneDrive: ${(e as Error).message}` });
  }
}

type ReadState = 'same' | 'imported' | 'held' | 'older';

/** The content id OneDrive gives an item, else the one known from the cached bytes of the same version. */
function knownQxh(item: DriveItem, cache: ExcelCache | null): string | undefined {
  return item.file?.hashes?.quickXorHash || (cache?.cTag && cache.cTag === item.cTag ? cache.qxh : undefined);
}

/**
 * Bring the word list to this version of the workbook: nothing when it already is (`same`), skipped when OneDrive's
 * version is older than the list (`older`) or held for review (`held`), else imported with this device's write intents.
 */
async function readItem(link: OdWorkbook, item: DriveItem, force: boolean): Promise<ReadState> {
  const cache = await kvGet<ExcelCache | null>(CACHE, null);
  const known = knownQxh(item, cache);
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
    if (same()) return 'same';
    if (isOlderThanList(source)) return 'older';
    if (known && known === heldQxh) return 'held';
    // Another device may already have imported this version: take the shared list first, it holds the history.
    if ((getState().sync.last ?? 0) < source.modified && (await syncLinked())) {
      await syncNow().catch(() => undefined);
      if (same()) return 'same';
      if (isOlderThanList(source)) return 'older';
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
    if (!force && current()?.qxh === qxh) return 'same';
    if (!force && qxh === heldQxh) return 'held';
  }
  const hadList = !!getState().meta;
  const prevHash = getState().meta?.hash;
  // The worker takes the bytes it is given: hand it a copy, the cache keeps its own.
  const o = await importBytes(bytes.slice().buffer, source, { explained: await liveExplained() });
  if (o.applied) {
    heldQxh = '';
    if (hadList && (o.vocab.hash !== prevHash || o.changes?.length)) notify(`Words updated from Excel: ${summary(o)}`);
    await dropImported();
    return 'imported';
  }
  heldQxh = source.qxh ?? '';
  if (!(await wasRejected(o.vocab))) {
    notify(`${item.name} changed a lot, so the new word list is held for review. ${(o.reasons ?? []).join(' ')}`);
  }
  return 'held';
}

// ---------- writing statuses into the workbook ----------

/** Rows whose status the workbook's colours don't show yet (against the current list), in sheet and row order. */
export function pendingFills(): RowFill[] {
  const s = getState();
  if (!s.meta || !s.notes.length) return [];
  return copyFills(sheetRows(s.notes, s.marks, s.meta.colourSince));
}

/**
 * The fills this device writes now. A row whose winning mark the other device set less than 2 minutes ago is its to
 * write; when every row is like that, none is written here before `deferUntil`.
 */
function writableFills(now: number): { fills: RowFill[]; deferUntil: number } {
  const s = getState();
  if (!s.meta || !s.notes.length) return { fills: [], deferUntil: 0 };
  const rows = sheetRows(s.notes, s.marks, s.meta.colourSince);
  const fills = copyFills(rows);
  const marks = new Map<string, StatusMark>();
  for (const list of rows.values()) for (const r of list) if (r.mark) marks.set(r.key, r.mark);
  let deferUntil = 0;
  let ours = false;
  for (const f of fills) {
    const m = f.key != null ? marks.get(f.key) : undefined;
    if (m && m.dev !== s.device && now - m.t < LEAVE_MS) {
      const at = m.t + LEAVE_MS;
      deferUntil = deferUntil ? Math.min(deferUntil, at) : at;
    } else {
      ours = true;
    }
  }
  // Something of this device's to write: one upload carries every row.
  return ours ? { fills, deferUntil: 0 } : { fills: [], deferUntil };
}

/** Whether this device writes automatically (Settings toggle, per device; default on). */
export function excelWriteOn(): boolean {
  return pref<boolean>(WRITE_PREF, true) !== false;
}

/** Turn automatic writing on or off on this device. Off: statuses wait until "Write now". */
export function setExcelWrite(on: boolean): void {
  setPref(WRITE_PREF, on);
  if (on) scheduleWrite(1000);
  else if (getState().excel.pending) setExcel({ waiting: 'off', waitUntil: undefined });
}

let confirmedNow: boolean | null = null;

async function isConfirmed(item: string): Promise<boolean> {
  return !!(await kvGet<Record<string, number>>(CONFIRMED, {}))[item];
}

/** Hugo confirmed the first write into this workbook on this device: write now. */
export async function confirmFirstWrite(): Promise<void> {
  const link = await linked();
  if (!link) return;
  await kvSet(CONFIRMED, { ...(await kvGet<Record<string, number>>(CONFIRMED, {})), [link.item]: Date.now() });
  confirmedNow = true;
  if (getState().excel.waiting === 'confirm') setExcel({ waiting: undefined, waitUntil: undefined });
  await writeBack();
}

/** The pending count (and the confirmation it waits for), refreshed whenever the marks or the list change. */
function refreshPending(): void {
  const ex = getState().excel;
  if (!linkedNow || WRITE_TARGET !== 'original') {
    if (ex.pending !== undefined) setExcel({ pending: undefined });
    return;
  }
  const n = pendingFills().length;
  const patch: Partial<ExcelInfo> = {};
  if (ex.pending !== n) patch.pending = n;
  if (n && confirmedNow === false && ex.waiting !== 'confirm') Object.assign(patch, { waiting: 'confirm', waitUntil: undefined });
  if (!n && ex.waiting && ex.waiting !== 'signin') Object.assign(patch, { waiting: undefined, waitUntil: undefined });
  if (!n && ex.stuck) patch.stuck = undefined;
  if (Object.keys(patch).length) setExcel(patch);
}

/** Stuck rows (the patcher found no row or no columns for them): not retried until the list or the marks change. */
interface Stuck {
  sig: string;
  count: number;
}
const stuckSig = (qxh: string, fills: RowFill[]) => `${qxh}|${fnv1a(JSON.stringify(fills))}`;

// Automatic runs wait until `retryAt` after a failure (423, throttling, errors); "Write now" doesn't.
let retryAt = 0;
let failures = 0;
let lockFailures = 0;
/** Forced re-reads already made (content + list hash), so a list that stays odd is not re-read in a loop. */
let colsTried = '';
let changedTried = '';

function wait(waiting: WriteWait, until?: number): void {
  setExcel({ waiting, waitUntil: until, pending: pendingFills().length });
  if (until) scheduleAt(until);
}

let writing: Promise<void> | null = null;
let writeAgain: boolean | null = null;

/**
 * Write the statuses that the workbook's colours don't show yet into the workbook in OneDrive. Single-flight, one
 * device-wide run at a time. Waits (ExcelInfo.waiting) instead of writing while Excel may be editing the file; `force`
 * ("Write now") skips the 5-minute quiet period, the back-off and the automatic-writing switch, never If-Match.
 */
export function writeBack(opts: { force?: boolean } = {}): Promise<void> {
  const force = !!opts.force;
  installHooks();
  if (writing) {
    writeAgain = (writeAgain ?? false) || force;
    return writing;
  }
  clearTimeout(writeTimer);
  writeTimer = undefined;
  writing = (async () => {
    try {
      let f = force;
      for (;;) {
        await serial(() => exclusive(() => writeRun(f)));
        if (writeAgain === null) break;
        f = writeAgain;
        writeAgain = null;
      }
    } finally {
      writing = null;
      writeAgain = null;
    }
  })();
  return writing;
}

async function writeRun(force: boolean): Promise<void> {
  if (WRITE_TARGET !== 'original' || !(await linked())) return;
  if (!force) {
    // Nothing to write, or only rows already found stuck: no request at all.
    const meta = getState().meta;
    const fills = pendingFills();
    if (!fills.length) return refreshPending();
    const stuck = await kvGet<Stuck | null>(STUCK, null);
    if (stuck && meta?.source.qxh && stuck.sig === stuckSig(meta.source.qxh, writableFills(Date.now()).fills)) {
      setExcel({ pending: fills.length, stuck: stuck.count });
      return;
    }
  }
  // Not confirmed on this device yet: nothing to ask OneDrive.
  if (confirmedNow === false) return wait('confirm');
  if (getState().ms.state !== 'ok') return wait('signin');
  if (!online()) return wait('offline');
  if (!force && Date.now() < retryAt) return scheduleAt(retryAt);
  try {
    await writeOnce(force);
  } catch (e) {
    if (e instanceof GraphError && e.auth) {
      // Only a new sign-in helps; writing resumes on Reconnect.
      setExcel({ waiting: 'signin', waitUntil: undefined, writeError: e.message });
      return;
    }
    failures++;
    retryAt = Date.now() + backoffDelay(failures, e instanceof GraphError ? e.retryAfter : undefined);
    if (e instanceof GraphError && (e.status === 429 || e.status === 503)) return wait('busy', retryAt);
    setExcel({ writeError: `Your statuses could not be written into the workbook: ${(e as Error).message}` });
    wait('retry', retryAt);
  }
}

async function writeOnce(force: boolean): Promise<void> {
  if (getState().pendingImport) return wait('held');
  // 1. The other devices' statuses and the shared list first: the write projects all of them.
  if (await syncLinked()) await syncNow().catch(() => undefined);
  await hookWork;
  for (let conflicts = 0; conflicts < 3; ) {
    // 2. The workbook as it is now.
    const cur = await currentItem();
    if (!cur) return;
    const { link, item } = cur;
    // 3. The list must be for this content.
    const read = await readItem(link, item, false);
    if (read === 'held') return wait('held');
    if (read === 'older') return wait('behind', Date.now() + SIGNAL_RECHECK);
    const cache = await kvGet<ExcelCache | null>(CACHE, null);
    const qxh = knownQxh(item, cache);
    const meta = getState().meta;
    if (!meta || !qxh || meta.source.qxh !== qxh) return wait('held');
    // 4. What to write.
    const now = Date.now();
    const { fills, deferUntil } = writableFills(now);
    if (!fills.length) {
      if (deferUntil) return wait('other', deferUntil);
      setExcel({ pending: pendingFills().length, waiting: undefined, waitUntil: undefined, writeError: undefined });
      return;
    }
    const sig = stuckSig(qxh, fills);
    const stuck = await kvGet<Stuck | null>(STUCK, null);
    if (stuck?.sig === sig) {
      setExcel({ pending: pendingFills().length, stuck: stuck.count, waiting: undefined, waitUntil: undefined });
      return;
    }
    const tried = `${qxh}|${meta.hash}`;
    if (colsMissing() && colsTried !== tried) {
      // Imported by an older app version: read the file again to find the columns to colour.
      colsTried = tried;
      await readItem(link, item, true);
      continue;
    }
    // 5. Wait checks.
    if (!confirmedNow && !(await isConfirmed(item.id))) {
      confirmedNow = false;
      return wait('confirm');
    }
    confirmedNow = true;
    if (!force && !excelWriteOn()) return wait('off');
    const modified = Date.parse(item.lastModifiedDateTime) || 0;
    if (!force && !meta.source.app && now - modified < QUIET_MS) return wait('quiet', modified + QUIET_MS);
    const signals = await folderSignals().catch(() => null);
    if (signals?.excelOpen) return wait('open', now + SIGNAL_RECHECK);
    if (signals?.localNewer) return wait('local', now + SIGNAL_RECHECK);
    // 6. The bytes of exactly this version, backed up before the first write and then weekly.
    let bytes: Uint8Array;
    if (cache && cache.qxh === qxh) {
      bytes = cache.bytes;
    } else {
      bytes = await download(item);
      if (quickXorHash(bytes) !== qxh) {
        // Saved again between the metadata and the download: start over from the new version.
        conflicts++;
        continue;
      }
      await kvSet(CACHE, { qxh, bytes, cTag: item.cTag } satisfies ExcelCache);
    }
    const backupAt = await kvGet<number>(BACKUP_AT, 0);
    if (!backupAt || now - backupAt > BACKUP_EVERY) {
      try {
        await backupWorkbook(bytes, item.name, now);
      } catch (e) {
        if (e instanceof GraphError && e.auth) throw e;
        throw new Error(`its backup in OneDrive › Apps › Hugo Chinese › backups failed first (${(e as Error).message})`);
      }
      await kvSet(BACKUP_AT, now);
    }
    // 7. Patch, off the main thread.
    const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
    let out: Uint8Array;
    try {
      const res = await patchInWorker({ bytes: bytes.slice(), rows: fills, cols: sheetCols() });
      if (!res.rows) {
        await kvSet(STUCK, { sig, count: fills.length } satisfies Stuck);
        setExcel({ pending: pendingFills().length, stuck: fills.length, waiting: undefined, waitUntil: undefined });
        return;
      }
      out = res.bytes;
    } catch (e) {
      if (!(e instanceof WorkbookChangedError)) throw e;
      // The words no longer sit where the list says: never colour the wrong rows. Read this version again once.
      if (changedTried !== tried) {
        changedTried = tried;
        await readItem(link, item, true);
        continue;
      }
      setExcel({
        writeError: `Your statuses were not written: row ${e.row} of ${e.sheet} does not hold the word the app expects. Read the workbook again (Read now), or save it again in Excel.`,
        waiting: undefined,
        waitUntil: undefined,
        pending: pendingFills().length,
      });
      return;
    }
    const patchMs = Math.round((typeof performance !== 'undefined' ? performance.now() : Date.now()) - t0);
    // 8. The intent first, then the upload, only over the version just read.
    const outQxh = quickXorHash(out);
    const at = Date.now();
    await addIntent({ qxh: outQxh, at, item: item.id, rows: fillsExplained(fills) });
    let up: DriveItem;
    try {
      up = await uploadReplace(link.drive || item.parentReference?.driveId || '', item.id, out, item.eTag);
    } catch (e) {
      // An HTTP answer means the upload didn't land; without one (network, timeout) it may have: the intent stays.
      if (e instanceof GraphError && e.status > 0) await dropIntent(at);
      if (e instanceof GraphError && e.conflict) {
        // Saved meanwhile (Excel, the other device): read that version and patch it.
        conflicts++;
        continue;
      }
      if (e instanceof GraphError && e.locked) {
        lockFailures++;
        retryAt = Date.now() + Math.min(30, 2 ** lockFailures) * 60000;
        return wait('locked', retryAt);
      }
      throw e;
    }
    await afterUpload(link, up, out, outQxh, at, fills, patchMs);
    return;
  }
  // The workbook kept changing under the write: back off.
  failures++;
  retryAt = Date.now() + backoffDelay(failures);
  wait('busy', retryAt);
}

/** The upload landed: the list moves to the new content without a download, and the other devices hear of it at once. */
async function afterUpload(link: OdWorkbook, up: DriveItem, out: Uint8Array, outQxh: string, at: number, fills: RowFill[], patchMs: number) {
  const server = Date.parse(up.lastModifiedDateTime) || Date.now();
  await updateIntent(at, { server });
  // OneDrive's hash of what it stored (it may rewrite properties on business drives); ours when it gives none.
  const serverQxh = up.file?.hashes?.quickXorHash;
  const qxh = serverQxh || outQxh;
  if (qxh === outQxh) await kvSet(CACHE, { qxh, bytes: out, cTag: up.cTag } satisfies ExcelCache);
  await kvSet(LAST_UPLOAD, { cTag: up.cTag, eTag: up.eTag, qxh, at });
  failures = 0;
  lockFailures = 0;
  retryAt = 0;
  const source: WorkbookSource = { name: up.name || link.name, modified: server, size: up.size ?? out.length, qxh, drive: link.drive, item: up.id || link.item, app: true };
  await importBytes(out.slice().buffer, source, { explained: await liveExplained() });
  heldQxh = '';
  // Rows still to write that this upload carried: the patcher found no place for them.
  const left = writableFills(Date.now()).fills;
  const carried = new Set(fills.map((f) => `${f.key}|${f.status}`));
  const stuck = left.length && left.every((f) => carried.has(`${f.key}|${f.status}`)) ? left.length : 0;
  await kvSet(STUCK, stuck ? ({ sig: stuckSig(qxh, left), count: stuck } satisfies Stuck) : null);
  const done = Date.now();
  setExcel({ written: done, checked: done, patchMs, stuck: stuck || undefined, writeError: undefined, waiting: undefined, waitUntil: undefined, pending: pendingFills().length });
  if (await syncLinked()) await syncNow().catch(() => undefined);
  else await dropImported();
}

/** Without sync, an intent is no longer needed once this device's list holds that content or a later version. */
async function dropImported(): Promise<void> {
  if (!(await syncLinked())) await dropCovered(getState().meta?.source);
}

/** Intents dropped by the shared-list hook (awaited before a write reads them). */
let hookWork: Promise<unknown> = Promise.resolve();
let hooked = false;
function installHooks(): void {
  if (hooked) return;
  hooked = true;
  // The shared list holds this content or a later one: every device knows the app's write from it.
  onSharedList((shared) => {
    hookWork = hookWork.then(() => dropCovered(shared.source)).catch(() => undefined);
  });
}

// ---------- when to write ----------

let writeTimer: ReturnType<typeof setTimeout> | undefined;
let writeAt = 0;

/** A run at `at` (an earlier planned run stays). */
function scheduleAt(at: number): void {
  if (writeTimer !== undefined && writeAt <= at) return;
  clearTimeout(writeTimer);
  writeAt = at;
  writeTimer = setTimeout(
    () => {
      writeTimer = undefined;
      void writeBack();
    },
    Math.max(1000, at - Date.now()),
  );
}

/** A run `ms` from now, replacing any planned one (the debounce after status changes). */
function scheduleWrite(ms: number): void {
  clearTimeout(writeTimer);
  writeTimer = undefined;
  scheduleAt(Date.now() + ms);
}

/** The app is being hidden (iPhone: swiped away): write what is waiting now; an intent covers a cut-short upload. */
function flushWrite(): void {
  if (writeTimer === undefined || Date.now() < retryAt) return;
  void writeBack();
}

let started = false;

/** Called once at start-up on every device; does nothing until Microsoft is signed in. */
export async function startWorkbook(): Promise<void> {
  if (started || !msConfigured()) return;
  started = true;
  installHooks();
  const link = await linked();
  if (link) {
    linkedNow = true;
    confirmedNow = await isConfirmed(link.item);
    const stuck = await kvGet<Stuck | null>(STUCK, null);
    setExcel({ state: 'ok', name: link.name, path: link.path, ...(stuck ? { stuck: stuck.count } : {}) });
    refreshPending();
  }
  void checkWorkbook().then(() => {
    if (pendingFills().length) scheduleWrite(3000);
  });
  if (typeof window === 'undefined') return;
  // Signed in again (Reconnect): read what was missed, write what waits.
  let ms = getState().ms.state;
  let { marks, meta } = getState();
  subscribe(() => {
    const s = getState();
    if (s.ms.state !== ms) {
      ms = s.ms.state;
      if (ms === 'ok') {
        void checkWorkbook();
        if (pendingFills().length) scheduleWrite(3000);
      }
    }
    // Status marks here or from the other devices, or a new word list: write after a pause.
    if (s.marks !== marks || s.meta !== meta) {
      ({ marks, meta } = s);
      refreshPending();
      if (getState().excel.pending) scheduleWrite(DEBOUNCE_MS);
    }
  });
  window.addEventListener('focus', () => void checkWorkbook());
  window.addEventListener('online', () => {
    retryAt = 0;
    void checkWorkbook().then(() => writeBack());
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void checkWorkbook();
    else flushWrite();
  });
  setInterval(() => {
    if (document.visibilityState === 'visible') void checkWorkbook();
  }, POLL_MS);
}
