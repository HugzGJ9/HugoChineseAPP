// A backup file of everything Hugo built on this device, for when sync is off and as a safety net.
// Restoring merges: reviews and marks not stored yet are added, nothing is overwritten or deleted.
// Never in the file: the sync link and its token, sync state, the OneDrive folder handle, upload queues.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { SHARED_PREFS, collectPrefs, db, deviceId, getSettings, kvGet, kvSet, writePrefsSilently, type Settings } from './db';
import { addRestored, getState, notifyLocalChange, reloadPrefs, setVocab, updateSettings, type VocabMeta } from './store';
import type { Grade, MarkKind, ReviewEvent, StatusMark, VocabFile } from './types';

declare const __APP_VERSION__: string;

export const BACKUP_FORMAT = 'hugo-zhongwen-backup';
const BACKUP_VERSION = 1;

export interface BackupFile {
  format: typeof BACKUP_FORMAT;
  version: 1;
  exportedAt: number;
  device: string;
  appVersion?: string;
  settings: Settings;
  /** Notes + meta (seeds, aliases). */
  vocab: VocabFile | null;
  /** Raw rows from the database, of every device. */
  events: ReviewEvent[];
  marks: StatusMark[];
  /** Shared and per-device preferences (never cache markers like warm.*). */
  prefs: Record<string, unknown>;
}

export interface RestoreReport {
  events: number;
  marks: number;
  vocab: 'applied' | 'kept' | 'none';
  settings: 'applied' | 'kept';
  prefs: number;
}

const appVersion = (): string | undefined => (typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : undefined);

async function allMarks(): Promise<StatusMark[]> {
  const rows = await db.kv.where('k').startsWith('marks:').toArray();
  const out: StatusMark[] = [];
  for (const row of rows) {
    const m = /^marks:([^:]+):(\d{4}-\d{2})$/.exec(row.k);
    if (!m || !Array.isArray(row.v)) continue;
    for (const x of row.v as StatusMark[]) out.push({ ...x, dev: m[1], mo: m[2] });
  }
  return out;
}

function dateStamp(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The backup of this device, gzipped. Records when it was made (kv.lastBackup). */
export async function buildBackup(): Promise<{ bytes: Uint8Array; name: string }> {
  const [device, settings, notes, meta, events, marks] = await Promise.all([
    deviceId(),
    getSettings(),
    db.notes.orderBy('order').toArray(),
    kvGet<VocabMeta | null>('vocabMeta', null),
    db.events.toArray(),
    allMarks(),
  ]);
  const exportedAt = Date.now();
  const file: BackupFile = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    device,
    appVersion: appVersion(),
    settings,
    vocab: meta ? ({ ...meta, notes } as VocabFile) : null,
    events,
    marks,
    prefs: collectPrefs('backup'),
  };
  const bytes = gzipSync(strToU8(JSON.stringify(file)), { level: 9 });
  await kvSet('lastBackup', exportedAt);
  return { bytes, name: `hugo-zhongwen-backup-${dateStamp(exportedAt)}.json.gz` };
}

function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

/** Save the backup: the share sheet on iOS ("Save to Files"), a download elsewhere. */
export async function saveBackupFile(): Promise<void> {
  const before = await lastBackup();
  const { bytes, name } = await buildBackup();
  const type = 'application/gzip';
  const file = new File([bytes as Uint8Array<ArrayBuffer>], name, { type });
  if (isIOS() && navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: name });
      return;
    } catch (e) {
      if ((e as DOMException).name === 'AbortError') {
        // Hugo closed the share sheet: no backup was saved.
        await kvSet('lastBackup', before);
        return;
      }
      // Sharing failed: fall back to a download.
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

// ---------- restore ----------

function readJson(bytes: Uint8Array): unknown {
  const text = bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b ? strFromU8(gunzipSync(bytes)) : strFromU8(bytes);
  try {
    return JSON.parse(text.replace(/^﻿/, ''));
  } catch {
    throw new Error('This file is not a Hugo 中文 backup.');
  }
}

function checkEvents(list: unknown): ReviewEvent[] {
  if (!Array.isArray(list)) throw new Error('This backup has no review list.');
  return list.map((x: unknown, i) => {
    const e = (x ?? {}) as Partial<ReviewEvent>;
    if (typeof e.id !== 'string' || !e.id || typeof e.card !== 'string' || !e.card || ![1, 2, 3, 4].includes(e.r as number)
      || typeof e.t !== 'number' || !Number.isFinite(e.t) || typeof e.dev !== 'string' || !e.dev) {
      throw new Error(`Review ${i + 1} in this backup is damaged, so nothing was restored.`);
    }
    const ev: ReviewEvent = { id: e.id, card: e.card, r: e.r as Grade, t: e.t, d: typeof e.d === 'number' ? e.d : 0, m: typeof e.m === 'string' ? e.m : '', dev: e.dev };
    if (typeof e.mo === 'string' && /^\d{4}-\d{2}$/.test(e.mo)) ev.mo = e.mo;
    return ev;
  });
}

function checkMarks(list: unknown): StatusMark[] {
  if (list == null) return [];
  if (!Array.isArray(list)) throw new Error('This backup has a damaged list of word statuses.');
  return list.map((x: unknown, i) => {
    const m = (x ?? {}) as Partial<StatusMark>;
    if (typeof m.id !== 'string' || !m.id || typeof m.note !== 'string' || !m.note || typeof m.a !== 'string'
      || typeof m.t !== 'number' || !Number.isFinite(m.t) || typeof m.dev !== 'string' || !/^[A-Za-z0-9_-]+$/.test(m.dev)) {
      throw new Error(`Word status ${i + 1} in this backup is damaged, so nothing was restored.`);
    }
    const mark: StatusMark = { id: m.id, note: m.note, a: m.a as MarkKind, t: m.t, dev: m.dev };
    if (typeof m.mo === 'string' && /^\d{4}-\d{2}$/.test(m.mo)) mark.mo = m.mo;
    return mark;
  });
}

const isObject = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);

/**
 * Restore a backup file (or the older reviews-only export `{ exportedAt, events }`), plain or gzipped.
 * Everything is checked before anything is written.
 */
export async function restoreBackup(bytes: Uint8Array): Promise<RestoreReport> {
  const j = readJson(bytes);
  if (!isObject(j)) throw new Error('This file is not a Hugo 中文 backup.');
  let file: Partial<BackupFile>;
  if (j.format === BACKUP_FORMAT) {
    if (typeof j.version !== 'number' || j.version > BACKUP_VERSION) throw new Error('This backup was made by a newer app version. Update the app, then restore it.');
    file = j as Partial<BackupFile>;
  } else if (Array.isArray(j.events) && typeof j.exportedAt === 'number') {
    file = { events: j.events as ReviewEvent[] }; // reviews-only export of older versions
  } else {
    throw new Error('This file is not a Hugo 中文 backup.');
  }
  const events = checkEvents(file.events);
  const marks = checkMarks(file.marks);
  const vf = isObject(file.vocab) && file.vocab.version === 1 && Array.isArray(file.vocab.notes) && isObject(file.vocab.seeds) ? (file.vocab as VocabFile) : null;
  const rs = isObject(file.settings) && typeof file.settings.updatedAt === 'number' ? (file.settings as Settings) : null;

  // Vocabulary only on a device without a word list: otherwise Excel or sync is the source.
  let vocab: RestoreReport['vocab'] = vf ? 'kept' : 'none';
  if (vf && !getState().notes.length && !getState().meta) {
    await setVocab(vf, true);
    vocab = 'applied';
  }

  const added = await addRestored(events, marks);

  // Settings: the newer change wins. Queued for upload, so sync compares it with the shared settings.
  let settings: RestoreReport['settings'] = 'kept';
  const local = getState().settings;
  if (rs && rs.updatedAt > (local.updatedAt ?? 0)) {
    await updateSettings(rs, true);
    await kvSet('settingsDirty', true);
    notifyLocalChange();
    settings = 'applied';
  }

  // Preferences: per-device ones always; shared ones only with the settings they belong to (or if none are set here).
  let prefs = 0;
  if (isObject(file.prefs)) {
    const takeShared = settings === 'applied' || !local.prefs;
    const p = Object.fromEntries(Object.entries(file.prefs).filter(([k]) => takeShared || !SHARED_PREFS.includes(k)));
    prefs = writePrefsSilently(p);
    reloadPrefs();
  }
  return { ...added, vocab, settings, prefs };
}

export function lastBackup(): Promise<number | null> {
  return kvGet<number | null>('lastBackup', null).then((v) => (typeof v === 'number' && v > 0 ? v : null));
}

// ---------- storage ----------

export async function storageStatus(): Promise<{ persisted: boolean | null; usage?: number; quota?: number }> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  let persisted: boolean | null = null;
  try {
    if (s?.persisted) persisted = await s.persisted();
  } catch {
    // unknown
  }
  try {
    if (s?.estimate) {
      const e = await s.estimate();
      return { persisted, usage: e.usage, quota: e.quota };
    }
  } catch {
    // no estimate
  }
  return { persisted };
}

/** Ask the browser not to clear this app's storage. Returns whether it is protected now. */
export async function requestPersist(): Promise<boolean> {
  const s = typeof navigator !== 'undefined' ? navigator.storage : undefined;
  try {
    if (s?.persist) return await s.persist();
  } catch {
    // refused
  }
  return false;
}
