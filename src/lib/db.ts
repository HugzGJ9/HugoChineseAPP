import Dexie, { type Table } from 'dexie';
import type { CardState, Note, ReviewEvent } from './types';

export interface KV {
  k: string;
  v: unknown;
}

class AppDB extends Dexie {
  notes!: Table<Note, string>;
  cards!: Table<CardState, string>;
  events!: Table<ReviewEvent, string>;
  kv!: Table<KV, string>;
  constructor() {
    super('hugo-zhongwen');
    this.version(1).stores({
      notes: 'id, kind, order',
      cards: 'id, note, due, type',
      events: 'id, card, t, dev',
      kv: 'k',
    });
  }
}

export const db = new AppDB();

export async function kvGet<T>(k: string, fallback: T): Promise<T> {
  const row = await db.kv.get(k);
  return row ? (row.v as T) : fallback;
}

export async function kvSet(k: string, v: unknown): Promise<void> {
  await db.kv.put({ k, v });
}

export function uid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID();
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
}

/** Settings shared by every device (synced through settings.json). */
export interface Settings {
  newVocab: number;
  newOther: number;
  maxReviews: number;
  retention: number;
  spreadDays: number;
  recall: boolean;
  listen: boolean;
  fileName: string;
  updatedAt: number;
}

export const DEFAULT_SETTINGS: Settings = {
  newVocab: 10,
  newOther: 2,
  maxReviews: 150,
  retention: 0.9,
  spreadDays: 60,
  recall: true,
  listen: false,
  fileName: 'Hugo_chinese_vocab.xlsx',
  updatedAt: 0,
};

export async function getSettings(): Promise<Settings> {
  return { ...DEFAULT_SETTINGS, ...(await kvGet<Partial<Settings>>('settings', {})) };
}

export async function saveSettings(patch: Partial<Settings>, fromSync = false): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  if (!fromSync) next.updatedAt = Date.now();
  await kvSet('settings', next);
  if (!fromSync) await kvSet('settingsDirty', true);
  return next;
}

export async function deviceId(): Promise<string> {
  let id = await kvGet<string>('deviceId', '');
  if (!id) {
    const ua = typeof navigator !== 'undefined' ? navigator.userAgent : '';
    const kind = /iPhone/.test(ua) ? 'iphone' : /iPad/.test(ua) ? 'ipad' : /Android/.test(ua) ? 'android' : /Windows/.test(ua) ? 'windows' : /Mac/.test(ua) ? 'mac' : 'device';
    id = `${kind}-${Math.random().toString(16).slice(2, 6)}`;
    await kvSet('deviceId', id);
  }
  return id;
}

/** Month of a timestamp, for log files (YYYY-MM, local time). */
export function monthKey(t: number): string {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Per-device preferences that are not synced (kept in localStorage). */
export function pref<T>(key: string, fallback: T): T {
  try {
    const v = localStorage.getItem('hz.' + key);
    return v == null ? fallback : (JSON.parse(v) as T);
  } catch {
    return fallback;
  }
}

export function setPref(key: string, v: unknown): void {
  try {
    localStorage.setItem('hz.' + key, JSON.stringify(v));
  } catch {
    // storage unavailable (private mode): the preference lasts for this session only
  }
}
