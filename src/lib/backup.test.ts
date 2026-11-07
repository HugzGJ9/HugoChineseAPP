// Backup files: what goes in (never the token), and restores that only ever add.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import type { Note, ReviewEvent, VocabFile } from './types';

/** localStorage for Node: one per browser profile. */
class MemStorage implements Storage {
  private m = new Map<string, string>();
  get length() {
    return this.m.size;
  }
  key(i: number) {
    return [...this.m.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}

/** A fresh copy of the app's modules. `id` keeps a device id across a wipe. */
async function device(idb = new IDBFactory(), id?: string) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const db = await import('./db');
  const backup = await import('./backup');
  if (id) await db.kvSet('deviceId', id);
  await store.init();
  return { store, db, backup, idb, id: store.getState().device };
}

function note(i: number): Note {
  return {
    id: `v:词${i}|ci${i}`,
    kind: 'vocab',
    hanzi: `词${i}`,
    alts: [],
    pinyin: 'cí',
    pinyinNum: 'ci2',
    en: `word ${i}`,
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK四级', row: i + 2 }],
    order: i,
    studied: false,
    examples: [],
  };
}

const T0 = new Date(2026, 10, 2, 10).getTime();
const TOKEN = 'github_pat_SECRET_token_123';

function vocab(n: number, hash = `h${n}`): VocabFile {
  return {
    version: 1,
    importedAt: T0,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: T0, size: 1000 },
    hash,
    notes: Array.from({ length: n }, (_, i) => note(i)),
    issues: [],
    seeds: {},
    report: [],
  };
}

const W = 'v:词1|ci1';

/** A device with words, reviews of its own and of another device, marks, settings, prefs and a sync link. */
async function filled() {
  const d = await device();
  await d.store.setVocab(vocab(4));
  await d.store.recordReview(`${W}#recog`, 3, 'reveal', 1000, T0);
  await d.store.recordReview('v:词2|ci2#recog', 1, 'type-pinyin', 2000, T0 + 1000);
  const other: ReviewEvent = { id: 'o1', card: 'v:词3|ci3#recog', r: 4, t: T0 + 2000, d: 1, m: 'reveal', dev: 'iphone-1' };
  await d.store.mergeDeviceEvents('iphone-1', '2026-11', [other]);
  await d.store.mergeDeviceMarks('iphone-1', '2026-10', [{ id: 'om', note: 'v:词0|ci0', a: 'suspend', t: T0 - 20 * 86400000, dev: 'iphone-1' }]);
  await d.store.setNoteStatus(W, 'known', T0 + 3000);
  await d.store.updateSettings({ newVocab: 7 });
  d.db.setPref('voice', 'com.apple.voice.Tingting');
  d.db.setPref('mode.recall', 'write-free');
  d.db.setPref('warm.dict.abc', true);
  d.store.setLang('fr');
  await d.db.kvSet('syncLink', { owner: 'me', name: 'data', token: TOKEN, branch: 'main', linkedAt: 1 });
  await d.db.kvSet('syncShas', { 'settings.json': 'abc' });
  return d;
}

const ids = (d: { store: { getState(): { events: ReviewEvent[] } } }) => d.store.getState().events.map((e) => e.id).sort();

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('backup file', () => {
  it('holds everything but the sync link, and records when it was made', async () => {
    const d = await filled();
    expect(await d.backup.lastBackup()).toBeNull();
    const { bytes, name } = await d.backup.buildBackup();
    expect(name).toMatch(/^hugo-zhongwen-backup-\d{4}-\d{2}-\d{2}\.json\.gz$/);
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const text = strFromU8(gunzipSync(bytes));
    expect(text).not.toContain(TOKEN);
    expect(strFromU8(bytes, true)).not.toContain(TOKEN);
    const j = JSON.parse(text);
    expect(j).toMatchObject({ format: 'hugo-zhongwen-backup', version: 1, device: d.id });
    const keys = ['device', 'events', 'exportedAt', 'format', 'marks', 'prefs', 'settings', 'version', 'vocab'];
    expect(Object.keys(j).filter((k) => k !== 'appVersion').sort()).toEqual(keys);
    expect(j.events).toHaveLength(3);
    expect(j.marks).toHaveLength(2);
    expect(j.vocab.notes).toHaveLength(4);
    expect(j.settings.newVocab).toBe(7);
    expect(j.prefs).toEqual({ lang: 'fr', voice: 'com.apple.voice.Tingting', 'mode.recall': 'write-free' });
    expect(text).not.toContain('syncShas');
    expect(await d.backup.lastBackup()).toBe(j.exportedAt);
  });

  it('never holds the Claude key nor the saved explanations', async () => {
    const d = await filled();
    const explain = await import('./explain');
    await explain.setClaudeKey('sk-ant-test-backup-9z9z');
    const x = { summary: 'meaning', senses: [], register: '', nuance: [], collocations: [], patterns: [], mistakes: [], examples: Array.from({ length: 3 }, () => ({ zh: '我学习。', pinyin: '', tr: 'EXPLAINED' })) };
    await explain.mergeExplanations('iphone-1', '2026-11', [{ k: `${W}|en`, hz: '词1', py: 'cí', lang: 'en', at: T0, model: 'm', pv: 1, x }]);
    const { bytes } = await d.backup.buildBackup();
    const text = strFromU8(gunzipSync(bytes));
    expect(text).not.toContain('sk-ant');
    expect(text).not.toContain('claudeKey');
    expect(text).not.toContain('EXPLAINED');
    expect(text).not.toContain('explainDirty');
  });

  it('a wiped device gets everything back, and its own months are sent again', async () => {
    const a = await filled();
    await vi.waitFor(() => expect(a.store.getState().settings.prefs?.lang).toBe('fr'), { timeout: 4000, interval: 100 });
    const { bytes } = await a.backup.buildBackup();
    const before = a.store.getState();
    // "Clear this device", keeping the device id (the backup's device id is not adopted yet).
    await a.db.db.delete();
    vi.stubGlobal('localStorage', new MemStorage());
    const b = await device(new IDBFactory(), a.id);
    expect(b.store.getState().events).toHaveLength(0);

    const r = await b.backup.restoreBackup(bytes);
    expect(r).toEqual({ events: 3, marks: 2, vocab: 'applied', settings: 'applied', prefs: 3 });
    const s = b.store.getState();
    expect(ids(b)).toEqual(ids(a));
    expect(s.marks.map((m) => m.id).sort()).toEqual(before.marks.map((m) => m.id).sort());
    expect(s.notes).toHaveLength(4);
    expect(s.settings.newVocab).toBe(7);
    expect(s.settings.updatedAt).toBe(before.settings.updatedAt);
    expect(s.lang).toBe('fr');
    expect(b.db.pref('voice', '')).toBe('com.apple.voice.Tingting');
    expect(b.db.pref('mode.recall', '')).toBe('write-free');
    expect(b.db.pref('warm.dict.abc', false)).toBe(false);
    expect([...s.cards.values()].sort((x, y) => (x.id < y.id ? -1 : 1))).toEqual([...before.cards.values()].sort((x, y) => (x.id < y.id ? -1 : 1)));
    // Own months queued for upload again, in both queues; months of other devices are not.
    expect(Object.keys(await b.store.dirtyMonths())).toEqual(['2026-11']);
    expect(Object.keys(await b.store.dirtyMarkMonths())).toEqual(['2026-11']);
    expect(await b.db.kvGet('settingsDirty', false)).toBe(true);
    // Rows of other devices keep their month.
    expect((await b.db.db.events.get('o1'))?.mo).toBe('2026-11');
    expect(await b.db.kvGet('marks:iphone-1:2026-10', [])).toHaveLength(1);
    expect(await b.db.kvGet('syncLink', null)).toBeNull();

    // Restoring twice adds nothing.
    expect(await b.backup.restoreBackup(bytes)).toMatchObject({ events: 0, marks: 0, vocab: 'kept', settings: 'kept' });
    expect(b.store.getState().events).toHaveLength(3);
    expect(b.store.getState().marks).toHaveLength(2);
  });

  it('a restore never overwrites: the local word list and newer settings are kept', async () => {
    const a = await filled();
    const { bytes } = await a.backup.buildBackup();
    vi.stubGlobal('localStorage', new MemStorage());
    const b = await device();
    await b.store.setVocab(vocab(2, 'mine'));
    await new Promise((r) => setTimeout(r, 5));
    await b.store.updateSettings({ newVocab: 3, prefs: { lang: 'en' } });
    const r = await b.backup.restoreBackup(bytes);
    expect(r.vocab).toBe('kept');
    expect(r.settings).toBe('kept');
    expect(r.events).toBe(3);
    const s = b.store.getState();
    expect(s.meta?.hash).toBe('mine');
    expect(s.notes).toHaveLength(2);
    expect(s.settings.newVocab).toBe(3);
    // Per-device prefs come in; shared ones belong to the settings that were kept.
    expect(r.prefs).toBe(2);
    expect(s.lang).toBe('en');
    // Rows of the backup's device (another id) are not this device's: nothing queued.
    expect(await b.store.dirtyMonths()).toEqual({});
    expect(await b.store.dirtyMarkMonths()).toEqual({});
  });

  it('the older reviews-only export is accepted, plain and gzipped', async () => {
    const a = await filled();
    const events = await a.db.db.events.toArray();
    const legacy = JSON.stringify({ exportedAt: Date.now(), events }, null, 1);
    for (const bytes of [strToU8(legacy), gzipSync(strToU8(legacy))]) {
      const b = await device();
      const r = await b.backup.restoreBackup(bytes);
      expect(r).toEqual({ events: 3, marks: 0, vocab: 'none', settings: 'kept', prefs: 0 });
      expect(await b.db.db.events.count()).toBe(3);
    }
  });

  it('refuses other files, newer formats and damaged rows without writing anything', async () => {
    const b = await device();
    await expect(b.backup.restoreBackup(strToU8('hello'))).rejects.toThrow(/not a Hugo/);
    await expect(b.backup.restoreBackup(strToU8('{"a":1}'))).rejects.toThrow(/not a Hugo/);
    await expect(b.backup.restoreBackup(strToU8(JSON.stringify({ format: 'hugo-zhongwen-backup', version: 2, events: [] })))).rejects.toThrow(/newer app version/);
    const ok: ReviewEvent = { id: 'e1', card: `${W}#recog`, r: 3, t: T0, d: 1, m: 'reveal', dev: 'pc-1' };
    const bad = JSON.stringify({ exportedAt: 1, events: [ok, { ...ok, id: 'e2', r: 7 }] });
    await expect(b.backup.restoreBackup(strToU8(bad))).rejects.toThrow(/Review 2/);
    expect(await b.db.db.events.count()).toBe(0);
  });
});

describe('storage', () => {
  it('reports what the browser says, and asks for protection', async () => {
    const b = await device();
    vi.stubGlobal('navigator', { storage: { persisted: async () => false, persist: async () => true, estimate: async () => ({ usage: 10, quota: 100 }) } });
    expect(await b.backup.storageStatus()).toEqual({ persisted: false, usage: 10, quota: 100 });
    expect(await b.backup.requestPersist()).toBe(true);
    vi.stubGlobal('navigator', {});
    expect(await b.backup.storageStatus()).toEqual({ persisted: null });
    expect(await b.backup.requestPersist()).toBe(false);
  });
});
