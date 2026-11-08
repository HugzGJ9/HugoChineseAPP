// App state in memory, persisted to IndexedDB. Cards are always derived from notes + seeds + events.
import { useSyncExternalStore } from 'react';
import {
  SHARED_PREFS,
  collectPrefs,
  db,
  deviceId,
  getSettings,
  kvGet,
  kvSet,
  monthKey,
  monthOf,
  newDeviceId,
  onDbVersionChange,
  onSharedPrefChange,
  pref,
  saveSettings,
  setPref,
  sharedPrefsChangedAt,
  uid,
  writePrefsSilently,
  type Settings,
} from './db';
import type { CardState, Grade, MarkKind, Note, PendingImport, ReviewEvent, StatusChange, StatusMark, VocabFile, WordStatus } from './types';
import { addDays, applyReview, dayStart, deriveCards, noteOfCard, resolveEventCards, resolveMarkNotes } from './engine/schedule';
import { noteStatuses, sheetRows } from './status';

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
  /** Last time the workbook copy was written. */
  written?: number;
  writeError?: string;
}

/** Microsoft sign-in. */
export interface MsInfo {
  state: 'off' | 'ok' | 'reconnect' | 'error';
  account?: string;
  message?: string;
}
/** The workbook on OneDrive. */
export interface ExcelInfo {
  state: 'off' | 'ok' | 'missing' | 'error';
  name?: string;
  path?: string;
  checked?: number;
  written?: number;
  pending?: number;
  waiting?: string;
  waitUntil?: number;
  stuck?: number;
  writeError?: string;
  message?: string;
  /** How long the last patch took (ms), to check the iPhone. */
  patchMs?: number;
}

export interface AppState {
  ready: boolean;
  device: string;
  notes: Note[];
  noteMap: Map<string, Note>;
  cards: Map<string, CardState>;
  events: ReviewEvent[];
  /** Status marks set by Hugo (every device), with renamed words resolved (aliases). */
  marks: StatusMark[];
  settings: Settings;
  meta: VocabMeta | null;
  lang: Lang;
  sync: SyncInfo;
  folder: FolderInfo;
  ms: MsInfo;
  excel: ExcelInfo;
  /** Statuses an Excel edit changed, for the notice in Sheets. */
  excelChanges?: StatusChange[];
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
  marks: [],
  settings: {} as Settings,
  meta: null,
  lang: pref<Lang>('lang', 'en'),
  sync: { state: 'off' },
  folder: { state: 'off' },
  ms: { state: 'off' },
  excel: { state: 'off' },
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
// Changes made on this device (reviews, undo, settings, a new import), for sync and the workbook copy.
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

function rebuild(notes: Note[], events: ReviewEvent[], seeds: Record<string, number>, settings: Settings, marks: StatusMark[]): Map<string, CardState> {
  const cards = deriveCards(notes, events, seeds, engineSettings(settings), marks);
  return new Map(cards.map((c) => [c.id, c]));
}

// Every stored event, as stored (raw card ids). `state.events` is a view of it with renamed words resolved (aliases);
// the stored rows and the uploaded files keep the raw events, so events are never rewritten.
let raw: ReviewEvent[] = [];
// The same for status marks (raw note ids).
let rawMarks: StatusMark[] = [];
// Bumped on every in-memory change, so a reload that read the database before it does not overwrite it.
let gen = 0;

function eventsView(events: ReviewEvent[], notes: Note[], meta: VocabMeta | null): ReviewEvent[] {
  const aliases = meta?.aliases;
  if (!aliases || !Object.keys(aliases).length) return events;
  return resolveEventCards(events, aliases, new Set(notes.map((n) => n.id)));
}

function marksView(marks: StatusMark[], notes: Note[], meta: VocabMeta | null): StatusMark[] {
  const aliases = meta?.aliases;
  if (!aliases || !Object.keys(aliases).length || !marks.length) return marks;
  return resolveMarkNotes(marks, aliases, new Set(notes.map((n) => n.id)));
}

// ---------- status marks in the database ----------
// One kv row per device and month: `marks:<device>:<YYYY-MM>` → StatusMark[] (device ids contain no ':').
// The upload queue is kv.marksDirty (month → stamp), apart from kv.dirty so older app versions never touch it.

const MARKS_PREFIX = 'marks:';
const markKey = (device: string, month: string) => `${MARKS_PREFIX}${device}:${month}`;

function parseMarkKey(k: string): { device: string; month: string } | null {
  const m = /^marks:([^:]+):(\d{4}-\d{2})$/.exec(k);
  return m ? { device: m[1], month: m[2] } : null;
}

/** Every stored mark, stamped with the device and month of the row it is stored in. */
async function loadMarks(): Promise<StatusMark[]> {
  const rows = await db.kv.where('k').startsWith(MARKS_PREFIX).toArray();
  const out: StatusMark[] = [];
  for (const row of rows) {
    const key = parseMarkKey(row.k);
    if (!key || !Array.isArray(row.v)) continue;
    for (const m of row.v as StatusMark[]) out.push({ ...m, dev: key.device, mo: key.month });
  }
  return out;
}

async function markRow(device: string, month: string): Promise<StatusMark[]> {
  const v = await kvGet<StatusMark[] | null>(markKey(device, month), null);
  return Array.isArray(v) ? v : [];
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

function broadcast(what: 'review' | 'undo' | 'mark' | 'merge' | 'vocab' | 'settings' | 'pending' | 'device') {
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
    const [device, settings, notes, events, meta, pendingImport, marks] = await Promise.all([
      deviceId(),
      getSettings(),
      db.notes.orderBy('order').toArray(),
      db.events.toArray(),
      kvGet<VocabMeta | null>('vocabMeta', null),
      kvGet<PendingImport | null>('pendingImport', null),
      loadMarks(),
    ]);
    if (g !== gen) continue; // this tab changed something meanwhile: read again
    raw = events;
    rawMarks = marks;
    const view = eventsView(events, notes, meta);
    const mview = marksView(marks, notes, meta);
    set({
      device,
      settings,
      notes,
      noteMap: new Map(notes.map((n) => [n.id, n])),
      events: view,
      marks: mview,
      meta,
      pendingImport: pendingImport ?? undefined,
      cards: rebuild(notes, view, meta?.seeds ?? {}, settings, mview),
      // localStorage is shared by the tabs: another tab may have changed the language.
      lang: langPref(state.lang),
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
  const [settings, notes, events, meta, pendingImport, marks] = await Promise.all([
    getSettings(),
    db.notes.orderBy('order').toArray(),
    db.events.toArray(),
    kvGet<VocabMeta | null>('vocabMeta', null),
    kvGet<PendingImport | null>('pendingImport', null),
    loadMarks(),
  ]);
  raw = events;
  rawMarks = marks;
  gen++;
  const view = eventsView(events, notes, meta);
  const mview = marksView(marks, notes, meta);
  const cards = rebuild(notes, view, meta?.seeds ?? {}, settings, mview);
  // Shared preferences saved in the settings (from sync) take over, unless one was changed here after them.
  applySharedPrefs(settings);
  set({
    ready: true,
    device: me,
    settings,
    notes,
    noteMap: new Map(notes.map((n) => [n.id, n])),
    events: view,
    marks: mview,
    meta,
    cards,
    pendingImport: pendingImport ?? undefined,
    lang: langPref(state.lang),
  });
  openChannel();
  watchSharedPrefs();
  onDbVersionChange(() => set({ needsReload: true }));
  if (typeof navigator !== 'undefined' && navigator.storage?.persist) navigator.storage.persist().catch(() => undefined);
}

// ---------- shared preferences (meaning language, Quick filters) ----------
// Changed here: saved into Settings.prefs after a pause, which bumps updatedAt and queues settings.json for upload.
// Arrived from sync (or present at start-up): written to localStorage without echo. Nothing is pushed at start-up,
// so a device that was off for a while never overwrites newer settings.

const PREFS_DEBOUNCE_MS = 1500;
let prefsTimer: ReturnType<typeof setTimeout> | undefined;
let prefsWatched = false;

function langPref(fallback: Lang): Lang {
  const l = pref<string>('lang', fallback);
  return l === 'fr' || l === 'en' ? l : fallback;
}

function sharedOnly(p: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(p).filter(([k]) => SHARED_PREFS.includes(k)));
}

/** Write the shared preferences of these settings to localStorage, unless one was changed here after them. */
function applySharedPrefs(s: Partial<Settings>): boolean {
  const p = s.prefs;
  if (!p || typeof p !== 'object' || Array.isArray(p)) return false;
  if (sharedPrefsChangedAt() > (s.updatedAt ?? 0)) return false;
  return writePrefsSilently(sharedOnly(p)) > 0;
}

async function flushSharedPrefs(): Promise<void> {
  clearTimeout(prefsTimer);
  prefsTimer = undefined;
  // Every shared key is read again: a change missed because the app closed early is carried by this one.
  await updateSettings({ prefs: collectPrefs('shared') });
}

function watchSharedPrefs() {
  if (prefsWatched) return;
  prefsWatched = true;
  onSharedPrefChange(() => {
    clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => void flushSharedPrefs().catch(() => undefined), PREFS_DEBOUNCE_MS);
  });
  if (typeof document !== 'undefined') {
    // The app is being hidden (iPhone: swiped away): save a pending change now.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden' && prefsTimer) void flushSharedPrefs().catch(() => undefined);
    });
  }
}

/** Read the language again from localStorage (after a restore wrote preferences). */
export function reloadPrefs(): void {
  const lang = langPref(state.lang);
  if (lang !== state.lang) set({ lang });
}

/** Effective status per note, from what is in memory. */
function currentStatuses(notes: Note[], marks: StatusMark[], meta: VocabMeta | null): Map<string, WordStatus> {
  return noteStatuses(sheetRows(notes, marks, meta?.colourSince));
}

/**
 * Notes present before and after a list change whose effective status it changed (an Excel edit, here or on another
 * device). Added to `excelChanges`: a note already listed keeps its first `from`, and drops out once it is back to it.
 */
function statusChanges(before: Map<string, WordStatus>, after: Map<string, WordStatus>, noteMap: Map<string, Note>): StatusChange[] {
  const out: StatusChange[] = [];
  for (const [id, to] of after) {
    const from = before.get(id);
    if (from != null && from !== to) out.push({ note: id, hanzi: noteMap.get(id)?.hanzi ?? '', from, to });
  }
  return out;
}

function addExcelChanges(changes: StatusChange[]): StatusChange[] | undefined {
  const list = [...(state.excelChanges ?? [])];
  for (const c of changes) {
    const i = list.findIndex((x) => x.note === c.note);
    if (i < 0) list.push(c);
    else if (list[i].from === c.to) list.splice(i, 1);
    else list[i] = { ...list[i], hanzi: c.hanzi, to: c.to };
  }
  return list.length ? list : undefined;
}

/**
 * Replace the word list with a fresh import (from Excel), or with the shared list from sync (`exactSeeds`).
 * Returns the effective statuses the new list changed (none for the first list); they are also added to `excelChanges`.
 */
export async function setVocab(vf: VocabFile, exactSeeds = false): Promise<StatusChange[]> {
  const before = state.meta && state.notes.length ? currentStatuses(state.notes, state.marks, state.meta) : null;
  const { notes, ...meta } = vf;
  // Keep the seed times already known on this device; the shared list from sync is taken as is, so every device agrees.
  meta.seeds = exactSeeds ? { ...vf.seeds } : { ...vf.seeds, ...pickOlder(state.meta?.seeds ?? {}, vf.seeds) };
  // Renames accumulate. A list written by an older app version has no aliases: keep the ones known here.
  const aliases = { ...(state.meta?.aliases ?? {}), ...(vf.aliases ?? {}) };
  if (Object.keys(aliases).length) meta.aliases = aliases;
  else delete meta.aliases;
  // Row colour times: a list written by an older app version has none, keep the ones known here.
  const colourSince = vf.colourSince ?? state.meta?.colourSince;
  if (colourSince) meta.colourSince = colourSince;
  else delete meta.colourSince;
  await db.transaction('rw', db.notes, db.kv, async () => {
    await db.notes.clear();
    await db.notes.bulkPut(notes);
    await kvSet('vocabMeta', meta);
  });
  gen++;
  const events = eventsView(raw, notes, meta);
  const marks = marksView(rawMarks, notes, meta);
  const cards = rebuild(notes, events, meta.seeds, state.settings, marks);
  const noteMap = new Map(notes.map((n) => [n.id, n]));
  const changes = before ? statusChanges(before, currentStatuses(notes, marks, meta), noteMap) : [];
  set({ notes, noteMap, meta, events, marks, cards, ...(changes.length ? { excelChanges: addExcelChanges(changes) } : {}) });
  broadcast('vocab');
  return changes;
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
  // Shared preferences from another device: into localStorage, without echo.
  const prefsChanged = fromSync && applySharedPrefs(patch);
  gen++;
  set({
    settings,
    ...(engineChanged ? { cards: rebuild(state.notes, state.events, state.meta?.seeds ?? {}, settings, state.marks) } : {}),
    ...(prefsChanged ? { lang: langPref(state.lang) } : {}),
  });
  broadcast('settings');
  if (!fromSync) notifyLocalChange();
}

/** Meaning language. A shared preference: setPref queues it for settings.json. */
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

export function setMs(p: Partial<MsInfo>, replace = false) {
  set({ ms: replace ? ({ state: 'off', ...p } as MsInfo) : { ...state.ms, ...p } });
}

export function setExcel(p: Partial<ExcelInfo>, replace = false) {
  set({ excel: replace ? ({ state: 'off', ...p } as ExcelInfo) : { ...state.excel, ...p } });
}

export function clearExcelChanges() {
  set({ excelChanges: undefined });
}

// Months of this device's review log changed since the last upload: month → stamp of the last change.
// The stamp never goes backwards (clock changes), and stays close to Date.now() for older app versions in other tabs.
// Call inside a transaction that covers db.kv.
// The status marks use the same scheme with kv.marksDirty, sharing the one dirtyStamp.
async function bumpDirty(key: 'dirty' | 'marksDirty', month: string) {
  const dirty = await kvGet<Record<string, number>>(key, {});
  const last = await kvGet<number>('dirtyStamp', 0);
  const stamp = Math.max(Date.now(), last + 1, (dirty[month] ?? 0) + 1);
  dirty[month] = stamp;
  await kvSet(key, dirty);
  await kvSet('dirtyStamp', stamp);
}
const markDirty = (month: string) => bumpDirty('dirty', month);
const markMarksDirty = (month: string) => bumpDirty('marksDirty', month);

async function clearDirtyKey(key: 'dirty' | 'marksDirty', month: string, stamp: number): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const dirty = await kvGet<Record<string, number>>(key, {});
    if ((dirty[month] ?? 0) <= stamp) delete dirty[month];
    await kvSet(key, dirty);
  });
}

export async function dirtyMonths(): Promise<Record<string, number>> {
  return { ...(await kvGet<Record<string, number>>('dirty', {})) };
}

/** Forget a month once uploaded, unless it changed again after `stamp`. */
export function clearDirty(month: string, stamp: number): Promise<void> {
  return clearDirtyKey('dirty', month, stamp);
}

/** Months of this device's status marks changed since the last upload: month → stamp. */
export async function dirtyMarkMonths(): Promise<Record<string, number>> {
  return { ...(await kvGet<Record<string, number>>('marksDirty', {})) };
}

export function clearMarkDirty(month: string, stamp: number): Promise<void> {
  return clearDirtyKey('marksDirty', month, stamp);
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

/** Rebuild the events and marks views and every card from what is in memory (after merges made with `rebuild: false`). */
export function rebuildAll(): void {
  const events = eventsView(raw, state.notes, state.meta);
  const marks = marksView(rawMarks, state.notes, state.meta);
  set({ events, marks, cards: rebuild(state.notes, events, state.meta?.seeds ?? {}, state.settings, marks) });
}

// ---------- status marks set by Hugo ----------

/** New marks view, and the cards of one note derived again (a mark changes only its own word). */
function rebuildNote(noteIds: string[]): void {
  const marks = marksView(rawMarks, state.notes, state.meta);
  const cards = new Map(state.cards);
  for (const id of new Set(noteIds)) {
    const note = state.noteMap.get(id);
    if (!note) continue;
    const evs = state.events.filter((e) => noteOfCard(e.card) === id);
    const ms = marks.filter((m) => m.note === id);
    for (const c of deriveCards([note], evs, state.meta?.seeds ?? {}, engineSettings(state.settings), ms)) cards.set(c.id, c);
  }
  set({ marks, cards });
}

/** Note ids a raw mark applies to in the current view (it may point at a renamed word). */
function viewNote(m: StatusMark): string {
  const aliases = state.meta?.aliases;
  if (!aliases || !Object.keys(aliases).length) return m.note;
  return resolveMarkNotes([m], aliases, new Set(state.notes.map((n) => n.id)))[0]?.note ?? m.note;
}

/** Hugo sets the status of a word (every card of it): saved as a mark on this device, replayed with the reviews. */
export async function setNoteStatus(noteId: string, a: MarkKind, t = Date.now()): Promise<StatusMark> {
  const mark: StatusMark = { id: uid(), note: noteId, a, t, dev: state.device, mo: monthKey(t) };
  // The mark and its dirty month are saved together: a mark is never stored without being queued for upload.
  await db.transaction('rw', db.kv, async () => {
    const row = await markRow(mark.dev, mark.mo!);
    await kvSet(markKey(mark.dev, mark.mo!), [...row, mark]);
    await markMarksDirty(mark.mo!);
  });
  gen++;
  rawMarks = [...rawMarks, mark];
  rebuildNote([viewNote(mark)]);
  broadcast('mark');
  notifyLocalChange();
  return mark;
}

/** Undo a mark set on this device. Marks of other devices are never changed here. */
export async function undoMark(markId: string): Promise<void> {
  const me = state.device;
  const gone = await db.transaction('rw', db.kv, async () => {
    const rows = await db.kv.where('k').startsWith(`${MARKS_PREFIX}${me}:`).toArray();
    for (const row of rows) {
      const key = parseMarkKey(row.k);
      if (!key || key.device !== me || !Array.isArray(row.v)) continue;
      const list = row.v as StatusMark[];
      const found = list.find((m) => m.id === markId);
      if (!found) continue;
      await kvSet(row.k, list.filter((m) => m.id !== markId));
      await markMarksDirty(key.month);
      return { ...found, dev: me, mo: key.month };
    }
    return null;
  });
  if (!gone) return;
  gen++;
  rawMarks = rawMarks.filter((m) => m.id !== markId);
  rebuildNote([viewNote(gone)]);
  broadcast('undo');
  notifyLocalChange();
}

const sameMarks = (a: StatusMark[], b: StatusMark[]) => {
  if (a.length !== b.length) return false;
  const key = (m: StatusMark) => JSON.stringify([m.id, m.note, m.a, m.t]);
  const x = a.map(key).sort();
  const y = b.map(key).sort();
  return x.every((k, i) => k === y[i]);
};

/**
 * Merge one marks file of another device (sync): the file is authoritative for that device and month, so it replaces
 * that row. Pass `rebuild: false` when merging many files, then call `rebuildAll()` once. Returns whether anything changed.
 */
export async function mergeDeviceMarks(device: string, month: string, marks: StatusMark[], opts: { rebuild?: boolean } = {}): Promise<boolean> {
  if (device === state.device) return false; // this device's marks are written only here
  const incoming = marks.map((m) => ({ ...m, dev: device, mo: month }));
  const changed = await db.transaction('rw', db.kv, async () => {
    const current = await markRow(device, month);
    if (sameMarks(current, incoming)) return false;
    await kvSet(markKey(device, month), incoming);
    return true;
  });
  if (!changed) return false;
  gen++;
  rawMarks = [...rawMarks.filter((m) => !(m.dev === device && m.mo === month)), ...incoming];
  if (opts.rebuild !== false) rebuildAll();
  broadcast('merge');
  return true;
}

/** This device's marks of one month, from the database (also those set in another tab), oldest first. */
export async function ownMonthMarks(month: string): Promise<StatusMark[]> {
  const me = state.device;
  const marks = (await markRow(me, month)).map((m) => ({ ...m, dev: me, mo: month }));
  return marks.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
}

/**
 * Add reviews and marks from a backup file: only ids not stored yet are added, nothing is overwritten. Rows of this
 * device have their months queued for upload again; rows of other devices keep their month, and their sync files stay
 * authoritative when they come in. Returns how many were added.
 */
export async function addRestored(events: ReviewEvent[], marks: StatusMark[]): Promise<{ events: number; marks: number }> {
  const me = state.device;
  const res = await db.transaction('rw', db.events, db.kv, async () => {
    const have = await db.events.bulkGet(events.map((e) => e.id));
    const seen = new Set<string>();
    const newEvents: ReviewEvent[] = [];
    events.forEach((e, i) => {
      if (have[i] || seen.has(e.id)) return;
      seen.add(e.id);
      newEvents.push({ ...e, mo: e.mo ?? monthKey(e.t) });
    });
    if (newEvents.length) await db.events.bulkAdd(newEvents);
    for (const mo of new Set(newEvents.filter((e) => e.dev === me).map((e) => e.mo!))) await markDirty(mo);

    const markIds = new Set((await loadMarks()).map((m) => m.id));
    const groups = new Map<string, StatusMark[]>();
    for (const m of marks) {
      if (markIds.has(m.id)) continue;
      markIds.add(m.id);
      const mo = m.mo ?? monthKey(m.t);
      const k = markKey(m.dev, mo);
      let g = groups.get(k);
      if (!g) groups.set(k, (g = []));
      g.push({ ...m, mo });
    }
    const newMarks: StatusMark[] = [];
    for (const [k, g] of groups) {
      const cur = await kvGet<unknown>(k, []);
      await kvSet(k, [...(Array.isArray(cur) ? (cur as StatusMark[]) : []), ...g]);
      newMarks.push(...g);
    }
    for (const mo of new Set(newMarks.filter((m) => m.dev === me).map((m) => m.mo!))) await markMarksDirty(mo);
    return { newEvents, newMarks };
  });
  const { newEvents, newMarks } = res;
  if (newEvents.length || newMarks.length) {
    gen++;
    raw = [...raw, ...newEvents];
    rawMarks = [...rawMarks, ...newMarks];
    rebuildAll();
    broadcast('merge');
    if ([...newEvents, ...newMarks].some((x) => x.dev === me)) notifyLocalChange();
  }
  return { events: newEvents.length, marks: newMarks.length };
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

/** Whether this device recorded anything under its id: reviews or status marks. */
export async function hasOwnEvents(): Promise<boolean> {
  if ((await db.events.where('dev').equals(state.device).count()) > 0) return true;
  const rows = await db.kv.where('k').startsWith(`${MARKS_PREFIX}${state.device}:`).toArray();
  return rows.some((r) => Array.isArray(r.v) && r.v.length > 0);
}

/** Give this device a new id (the id is already used by another device in the repository). Only before any review or mark. */
export async function renewDeviceId(): Promise<string> {
  if (await hasOwnEvents()) throw new Error('This device already has reviews under its id.');
  const id = newDeviceId();
  await db.transaction('rw', db.kv, async () => {
    await kvSet('deviceId', id);
    await kvSet('dirty', {});
    await kvSet('marksDirty', {});
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
