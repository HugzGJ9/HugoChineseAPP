// App state in memory, persisted to IndexedDB. Cards are always derived from notes + seeds + events.
import { useSyncExternalStore } from 'react';
import { db, deviceId, getSettings, kvGet, kvSet, monthKey, monthOf, newDeviceId, onDbVersionChange, pref, saveSettings, setPref, uid, type Settings } from './db';
import type { CardState, Grade, Note, PendingImport, ReviewEvent, VocabFile } from './types';
import { addDays, applyReview, dayStart, deriveCards, resolveEventCards } from './engine/schedule';

export type Lang = 'en' | 'fr';

export type VocabMeta = Omit<VocabFile, 'notes'>;

export interface SyncInfo {
  state: 'off' | 'idle' | 'running' | 'error';
  message?: string;
  last?: number;
  /** owner/name of the linked repository. */
  repo?: string;
  /** Problems with single files during the last sync (the rest of the sync went through). */
  warnings?: string[];
  /** The repository holds a word list from a newer app version: this one must be updated to read it. */
  updateNeeded?: boolean;
}

/** The OneDrive folder linked on a computer (File System Access). */
export interface FolderInfo {
  state: 'off' | 'ok' | 'permission' | 'missing' | 'error';
  name?: string;
  message?: string;
  /** Last time the Excel file was checked. */
  checked?: number;
  /** Last time the progress workbook was written. */
  written?: number;
  writeError?: string;
}

export interface AppState {
  ready: boolean;
  device: string;
  notes: Note[];
  noteMap: Map<string, Note>;
  cards: Map<string, CardState>;
  events: ReviewEvent[];
  settings: Settings;
  meta: VocabMeta | null;
  lang: Lang;
  sync: SyncInfo;
  folder: FolderInfo;
  /** An import held back because it looks broken; Hugo decides (see sources.ts). */
  pendingImport?: PendingImport;
  /** Another tab opened a newer version of the database: this tab's connection is closed and the app must reload. */
  needsReload?: boolean;
  /** Bumped on every change, for memoised selectors. */
  rev: number;
}

let state: AppState = {
  ready: false,
  device: '',
  notes: [],
  noteMap: new Map(),
  cards: new Map(),
  events: [],
  settings: {} as Settings,
  meta: null,
  lang: pref<Lang>('lang', 'en'),
  sync: { state: 'off' },
  folder: { state: 'off' },
  rev: 0,
};

const listeners = new Set<() => void>();
export function getState(): AppState {
  return state;
}
function set(patch: Partial<AppState>) {
  state = { ...state, ...patch, rev: state.rev + 1 };
  for (const l of listeners) l();
}
export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
// Changes made on this device (reviews, undo, settings, a new import), for sync and the progress workbook.
const localListeners = new Set<() => void>();
export function onLocalChange(l: () => void): () => void {
  localListeners.add(l);
  return () => localListeners.delete(l);
}
export function notifyLocalChange() {
  for (const l of localListeners) l();
}
export function useApp<T>(sel: (s: AppState) => T): T {
  return useSyncExternalStore(subscribe, () => sel(state));
}

function engineSettings(s: Settings) {
  return { retention: s.retention, spreadDays: s.spreadDays, recall: s.recall, listen: s.listen };
}

function rebuild(notes: Note[], events: ReviewEvent[], seeds: Record<string, number>, settings: Settings): Map<string, CardState> {
  const cards = deriveCards(notes, events, seeds, engineSettings(settings));
  return new Map(cards.map((c) => [c.id, c]));
}

// Every stored event, as stored (raw card ids). `state.events` is a view of it with renamed words resolved (aliases);
// the stored rows and the uploaded files keep the raw events, so events are never rewritten.
let raw: ReviewEvent[] = [];
// Bumped on every in-memory change, so a reload that read the database before it does not overwrite it.
let gen = 0;

function eventsView(events: ReviewEvent[], notes: Note[], meta: VocabMeta | null): ReviewEvent[] {
  const aliases = meta?.aliases;
  if (!aliases || !Object.keys(aliases).length) return events;
  return resolveEventCards(events, aliases, new Set(notes.map((n) => n.id)));
}

// ---------- other tabs ----------
// Tabs of this app share the database. After a write, a tab tells the others, which reload from the database.

let channel: BroadcastChannel | null = null;
let reloadTimer: ReturnType<typeof setTimeout> | undefined;

function openChannel() {
  if (channel || typeof BroadcastChannel === 'undefined') return;
  channel = new BroadcastChannel('hz');
  channel.onmessage = () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void reloadFromDb().catch(() => undefined), 300);
  };
  (channel as unknown as { unref?: () => void }).unref?.();
}

function broadcast(what: 'review' | 'undo' | 'merge' | 'vocab' | 'settings' | 'pending' | 'device') {
  try {
    channel?.postMessage({ what });
  } catch {
    // channel closed
  }
}

/** Read everything again from the database (another tab changed it). */
export async function reloadFromDb(): Promise<void> {
  for (let tries = 0; tries < 5; tries++) {
    const g = gen;
    const [device, settings, notes, events, meta, pendingImport] = await Promise.all([
      deviceId(),
      getSettings(),
      db.notes.orderBy('order').toArray(),
      db.events.toArray(),
      kvGet<VocabMeta | null>('vocabMeta', null),
      kvGet<PendingImport | null>('pendingImport', null),
    ]);
    if (g !== gen) continue; // this tab changed something meanwhile: read again
    raw = events;
    const view = eventsView(events, notes, meta);
    set({
      device,
      settings,
      notes,
      noteMap: new Map(notes.map((n) => [n.id, n])),
      events: view,
      meta,
      pendingImport: pendingImport ?? undefined,
      cards: rebuild(notes, view, meta?.seeds ?? {}, settings),
    });
    return;
  }
}

// ---------- start-up ----------

/**
 * One-time repair of the month bug: events used to be grouped by month in the reader's time zone, so reviews near a month
 * boundary could be deleted by a merge. Own events are frozen to their current month; the review logs of other devices are
 * read again at the next sync (their known blob ids are forgotten), which restores anything deleted.
 */
async function migrateMonths(me: string): Promise<void> {
  if (await kvGet<boolean>('migr.mo', false)) return;
  await db.transaction('rw', db.events, db.kv, async () => {
    const own = await db.events.where('dev').equals(me).toArray();
    const stamp = own.filter((e) => !e.mo).map((e) => ({ ...e, mo: monthKey(e.t) }));
    if (stamp.length) await db.events.bulkPut(stamp);
    const shas = await kvGet<Record<string, string>>('syncShas', {});
    for (const path of Object.keys(shas)) {
      const m = /^events\/([^/]+)\//.exec(path);
      if (m && m[1] !== me) delete shas[path];
    }
    await kvSet('syncShas', shas);
    await kvSet('migr.mo', true);
  });
}

export async function init(): Promise<void> {
  const me = await deviceId();
  await migrateMonths(me);
  const [settings, notes, events, meta, pendingImport] = await Promise.all([
    getSettings(),
    db.notes.orderBy('order').toArray(),
    db.events.toArray(),
    kvGet<VocabMeta | null>('vocabMeta', null),
    kvGet<PendingImport | null>('pendingImport', null),
  ]);
  raw = events;
  gen++;
  const view = eventsView(events, notes, meta);
  const cards = rebuild(notes, view, meta?.seeds ?? {}, settings);
  set({
    ready: true,
    device: me,
    settings,
    notes,
    noteMap: new Map(notes.map((n) => [n.id, n])),
    events: view,
    meta,
    cards,
    pendingImport: pendingImport ?? undefined,
  });
  openChannel();
  onDbVersionChange(() => set({ needsReload: true }));
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) navigator.storage.persist().catch(() => undefined);
}

/** Replace the word list with a fresh import (from Excel), or with the shared list from sync (`exactSeeds`). */
export async function setVocab(vf: VocabFile, exactSeeds = false): Promise<void> {
  const { notes, ...meta } = vf;
  // Keep the seed times already known on this device; the shared list from sync is taken as is, so every device agrees.
  meta.seeds = exactSeeds ? { ...vf.seeds } : { ...vf.seeds, ...pickOlder(state.meta?.seeds ?? {}, vf.seeds) };
  // Renames accumulate. A list written by an older app version has no aliases: keep the ones known here.
  const aliases = { ...(state.meta?.aliases ?? {}), ...(vf.aliases ?? {}) };
  if (Object.keys(aliases).length) meta.aliases = aliases;
  else delete meta.aliases;
  await db.transaction('rw', db.notes, db.kv, async () => {
    await db.notes.clear();
    await db.notes.bulkPut(notes);
    await kvSet('vocabMeta', meta);
  });
  gen++;
  const events = eventsView(raw, notes, meta);
  const cards = rebuild(notes, events, meta.seeds, state.settings);
  set({ notes, noteMap: new Map(notes.map((n) => [n.id, n])), meta, events, cards });
  broadcast('vocab');
}

/** Hold (or drop, with no argument) an import that looks broken, until Hugo decides. Kept across restarts. */
export async function setPendingImport(p?: PendingImport): Promise<void> {
  gen++;
  set({ pendingImport: p });
  if (p) await kvSet('pendingImport', p);
  else await db.kv.delete('pendingImport');
  broadcast('pending');
}

function pickOlder(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) if (b[k] == null || v < b[k]) out[k] = v;
  return out;
}

export async function updateSettings(patch: Partial<Settings>, fromSync = false): Promise<void> {
  const settings = await saveSettings(patch, fromSync);
  const engineChanged = ['retention', 'spreadDays', 'recall', 'listen'].some((k) => k in patch);
  gen++;
  set({ settings, ...(engineChanged ? { cards: rebuild(state.notes, state.events, state.meta?.seeds ?? {}, settings) } : {}) });
  broadcast('settings');
  if (!fromSync) notifyLocalChange();
}

export function setLang(lang: Lang) {
  setPref('lang', lang);
  set({ lang });
}

export function setSync(sync: Partial<SyncInfo>) {
  set({ sync: { ...state.sync, ...sync } });
}

export function setFolder(folder: Partial<FolderInfo>, replace = false) {
  set({ folder: replace ? ({ state: 'off', ...folder } as FolderInfo) : { ...state.folder, ...folder } });
}

// Months of this device's review log changed since the last upload: month → stamp of the last change.
// The stamp never goes backwards (clock changes), and stays close to Date.now() for older app versions in other tabs.
// Call inside a transaction that covers db.kv.
async function markDirty(month: string) {
  const dirty = await kvGet<Record<string, number>>('dirty', {});
  const last = await kvGet<number>('dirtyStamp', 0);
  const stamp = Math.max(Date.now(), last + 1, (dirty[month] ?? 0) + 1);
  dirty[month] = stamp;
  await kvSet('dirty', dirty);
  await kvSet('dirtyStamp', stamp);
}

export async function dirtyMonths(): Promise<Record<string, number>> {
  return { ...(await kvGet<Record<string, number>>('dirty', {})) };
}

/** Forget a month once uploaded, unless it changed again after `stamp`. */
export async function clearDirty(month: string, stamp: number): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const dirty = await kvGet<Record<string, number>>('dirty', {});
    if ((dirty[month] ?? 0) <= stamp) delete dirty[month];
    await kvSet('dirty', dirty);
  });
}

/** Record one review on this device and update the card at once. */
export async function recordReview(cardId: string, r: Grade, mode: string, durationMs: number, t = Date.now()): Promise<ReviewEvent> {
  const ev: ReviewEvent = { id: uid(), card: cardId, r, t, d: Math.round(durationMs), m: mode, dev: state.device, mo: monthKey(t) };
  // The event and its dirty month are saved together: a review is never stored without being queued for upload.
  await db.transaction('rw', db.events, db.kv, async () => {
    await db.events.put(ev);
    await markDirty(ev.mo!);
  });
  gen++;
  raw = [...raw, ev];
  const events = [...state.events, ev];
  const cards = new Map(state.cards);
  const prev = cards.get(cardId);
  if (prev) {
    const next = applyReview(prev, ev, state.settings.retention);
    cards.set(cardId, next);
    // Unlock siblings (recall/listen) once the word has been seen.
    for (const c of cards.values()) {
      if (c.note === prev.note && c.locked) {
        const { locked: _l, ...rest } = c;
        cards.set(c.id, { ...rest, due: addDays(dayStart(t), 1) });
      }
    }
  }
  set({ events, cards });
  broadcast('review');
  notifyLocalChange();
  return ev;
}

/** Undo a review recorded on this device. */
export async function undoReview(eventId: string): Promise<void> {
  const me = state.device;
  const done = await db.transaction('rw', db.events, db.kv, async () => {
    const ev = await db.events.get(eventId);
    if (!ev || ev.dev !== me) return false;
    await db.events.delete(eventId);
    await markDirty(monthOf(ev));
    return true;
  });
  if (!done) return;
  gen++;
  raw = raw.filter((e) => e.id !== eventId);
  rebuildAll();
  broadcast('undo');
  notifyLocalChange();
}

/** Rebuild the events view and every card from what is in memory (after merges made with `rebuild: false`). */
export function rebuildAll(): void {
  const events = eventsView(raw, state.notes, state.meta);
  set({ events, cards: rebuild(state.notes, events, state.meta?.seeds ?? {}, state.settings) });
}

// Events of month M have their time within M in the time zone of the device that wrote them (UTC−12 to UTC+14):
// a window of M ± 3 days holds them all, and lets the `t` index do the work instead of scanning every event.
function monthWindow(month: string): [number, number] {
  const [y, m] = month.split('-').map(Number);
  const pad = 3 * 86400000;
  return [Date.UTC(y, m - 1, 1) - pad, Date.UTC(y, m, 1) + pad];
}

async function storedMonth(device: string, month: string): Promise<ReviewEvent[]> {
  const [lo, hi] = monthWindow(month);
  // One bulk read, filtered here: much faster than a filtered cursor.
  const near = await db.events.where('t').between(lo, hi, true, true).toArray();
  return near.filter((e) => e.dev === device && monthOf(e) === month);
}

/**
 * Merge one review log file of another device (sync): the file is authoritative for that device and month.
 * Events in the database for that device and month that are not in the file are deleted; the file's events are stored,
 * stamped with the file's month. Pass `rebuild: false` when merging many files, then call `rebuildAll()` once.
 * Returns whether any event changed.
 */
export async function mergeDeviceEvents(device: string, month: string, events: ReviewEvent[], opts: { rebuild?: boolean } = {}): Promise<boolean> {
  if (device === state.device) return false; // this device's log is written only here
  const incoming = events.map((e) => ({ ...e, dev: device, mo: month }));
  const ids = new Set(incoming.map((e) => e.id));
  const { changed, removed } = await db.transaction('rw', db.events, async () => {
    const current = await storedMonth(device, month);
    const byId = new Map(current.map((e) => [e.id, e]));
    const removed = current.filter((e) => !ids.has(e.id)).map((e) => e.id);
    let changed = removed.length > 0;
    let write = changed;
    for (const e of incoming) {
      const c = byId.get(e.id);
      if (!c || c.card !== e.card || c.r !== e.r || c.t !== e.t || c.d !== e.d || c.m !== e.m) {
        changed = write = true;
        break;
      }
      if (c.mo !== month) write = true; // same event, not stamped yet
    }
    if (write) {
      if (removed.length) await db.events.bulkDelete(removed);
      await db.events.bulkPut(incoming);
    }
    return { changed, removed };
  });
  if (!changed) return false;
  gen++;
  const gone = new Set(removed);
  raw = [...raw.filter((e) => !gone.has(e.id) && !ids.has(e.id)), ...incoming];
  if (opts.rebuild !== false) rebuildAll();
  broadcast('merge');
  return true;
}

/** This device's events of one month, from the database (also those recorded in another tab), oldest first. */
export async function ownMonthEvents(month: string): Promise<ReviewEvent[]> {
  const events = await storedMonth(state.device, month);
  return events.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
}

export async function hasOwnEvents(): Promise<boolean> {
  return (await db.events.where('dev').equals(state.device).count()) > 0;
}

/** Give this device a new id (the id is already used by another device in the repository). Only before any review. */
export async function renewDeviceId(): Promise<string> {
  if (await hasOwnEvents()) throw new Error('This device already has reviews under its id.');
  const id = newDeviceId();
  await db.transaction('rw', db.kv, async () => {
    await kvSet('deviceId', id);
    await kvSet('dirty', {});
  });
  gen++;
  set({ device: id });
  broadcast('device');
  return id;
}

/** Meaning in the chosen language, with where it came from. */
export function meaning(note: Note, lang: Lang): { text: string; source: 'excel' | 'auto' | 'en' | 'fr' } {
  if (lang === 'fr') {
    if (note.fr) return { text: note.fr, source: 'excel' };
    if (note.frAuto) return { text: note.frAuto, source: 'auto' };
    return { text: note.en, source: 'en' };
  }
  if (note.en) return { text: note.en, source: 'excel' };
  if (note.fr) return { text: note.fr, source: 'fr' };
  return { text: note.frAuto ?? '', source: 'auto' };
}

export async function wipeAll(): Promise<void> {
  await db.delete();
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('hz.')) localStorage.removeItem(k);
  } catch {
    // ignore
  }
  location.reload();
}
