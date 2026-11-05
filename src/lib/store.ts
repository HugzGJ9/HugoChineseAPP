// App state in memory, persisted to IndexedDB. Cards are always derived from notes + seeds + events.
import { useSyncExternalStore } from 'react';
import { db, deviceId, getSettings, kvGet, kvSet, monthKey, pref, saveSettings, setPref, uid, type Settings } from './db';
import type { CardState, Grade, Note, ReviewEvent, VocabFile } from './types';
import { addDays, applyReview, dayStart, deriveCards } from './engine/schedule';

export type Lang = 'en' | 'fr';

export type VocabMeta = Omit<VocabFile, 'notes'>;

export interface SyncInfo {
  state: 'off' | 'idle' | 'running' | 'error';
  message?: string;
  last?: number;
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

export async function init(): Promise<void> {
  const [device, settings, notes, events, meta] = await Promise.all([
    deviceId(),
    getSettings(),
    db.notes.orderBy('order').toArray(),
    db.events.toArray(),
    kvGet<VocabMeta | null>('vocabMeta', null),
  ]);
  const cards = rebuild(notes, events, meta?.seeds ?? {}, settings);
  set({ ready: true, device, settings, notes, noteMap: new Map(notes.map((n) => [n.id, n])), events, meta, cards });
  if (navigator.storage?.persist) navigator.storage.persist().catch(() => undefined);
}

/** Replace the word list with a fresh import (from Excel or from sync). */
export async function setVocab(vf: VocabFile): Promise<void> {
  const { notes, ...meta } = vf;
  // Keep the seed times already known on this device.
  meta.seeds = { ...vf.seeds, ...pickOlder(state.meta?.seeds ?? {}, vf.seeds) };
  await db.transaction('rw', db.notes, db.kv, async () => {
    await db.notes.clear();
    await db.notes.bulkPut(notes);
    await kvSet('vocabMeta', meta);
  });
  const cards = rebuild(notes, state.events, meta.seeds, state.settings);
  set({ notes, noteMap: new Map(notes.map((n) => [n.id, n])), meta, cards });
}

function pickOlder(a: Record<string, number>, b: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(a)) if (b[k] == null || v < b[k]) out[k] = v;
  return out;
}

export async function updateSettings(patch: Partial<Settings>, fromSync = false): Promise<void> {
  const settings = await saveSettings(patch, fromSync);
  const engineChanged = ['retention', 'spreadDays', 'recall', 'listen'].some((k) => k in patch);
  set({ settings, ...(engineChanged ? { cards: rebuild(state.notes, state.events, state.meta?.seeds ?? {}, settings) } : {}) });
}

export function setLang(lang: Lang) {
  setPref('lang', lang);
  set({ lang });
}

export function setSync(sync: Partial<SyncInfo>) {
  set({ sync: { ...state.sync, ...sync } });
}

async function markDirty(t: number) {
  const months = await kvGet<string[]>('dirtyMonths', []);
  const m = monthKey(t);
  if (!months.includes(m)) await kvSet('dirtyMonths', [...months, m]);
}

/** Record one review on this device and update the card at once. */
export async function recordReview(cardId: string, r: Grade, mode: string, durationMs: number, t = Date.now()): Promise<ReviewEvent> {
  const ev: ReviewEvent = { id: uid(), card: cardId, r, t, d: Math.round(durationMs), m: mode, dev: state.device };
  await db.events.put(ev);
  await markDirty(t);
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
  return ev;
}

/** Undo a review recorded on this device. */
export async function undoReview(eventId: string): Promise<void> {
  const ev = state.events.find((e) => e.id === eventId);
  if (!ev || ev.dev !== state.device) return;
  await db.events.delete(eventId);
  await markDirty(ev.t);
  const events = state.events.filter((e) => e.id !== eventId);
  set({ events, cards: rebuild(state.notes, events, state.meta?.seeds ?? {}, state.settings) });
}

/** Merge events from other devices (sync). Each device's own log is authoritative for its events. */
export async function mergeDeviceEvents(device: string, month: string, events: ReviewEvent[]): Promise<boolean> {
  const inMonth = (e: ReviewEvent) => e.dev === device && monthKey(e.t) === month;
  const current = state.events.filter(inMonth);
  const same =
    current.length === events.length && current.every((e) => events.some((x) => x.id === e.id && x.r === e.r && x.t === e.t));
  if (same) return false;
  await db.transaction('rw', db.events, async () => {
    await db.events.bulkDelete(current.map((e) => e.id));
    await db.events.bulkPut(events);
  });
  const all = [...state.events.filter((e) => !inMonth(e)), ...events];
  set({ events: all, cards: rebuild(state.notes, all, state.meta?.seeds ?? {}, state.settings) });
  return true;
}

export function eventsOf(device: string, month: string): ReviewEvent[] {
  return state.events.filter((e) => e.dev === device && monthKey(e.t) === month).sort((a, b) => a.t - b.t);
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
