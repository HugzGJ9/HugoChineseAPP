// The app state over IndexedDB: month stamps, dirty months, renames, held imports, other tabs, status marks,
// shared preferences, speed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { Note, PendingImport, ReviewEvent, StatusMark, VocabFile } from './types';
import { deriveCards, resolveEventCards } from './engine/schedule';

/** A fresh copy of the app's modules. Pass the `idb` of another one for a second tab on the same database. */
async function device(idb = new IDBFactory()) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const db = await import('./db');
  await store.init();
  return { store, db, idb, id: store.getState().device };
}

function note(i: number, over: Partial<Note> = {}): Note {
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
    ...over,
  };
}

function vocab(notes: Note[], over: Partial<VocabFile> = {}): VocabFile {
  return {
    version: 1,
    importedAt: T0,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: T0, size: 1000 },
    hash: `h${notes.length}`,
    notes,
    issues: [],
    seeds: {},
    report: [],
    ...over,
  };
}

const T0 = new Date(2026, 10, 2, 10).getTime();
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const TZ = env.TZ;

/** localStorage for Node (one per browser profile). */
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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});

afterEach(() => {
  if (TZ == null) delete env.TZ;
  else env.TZ = TZ;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('own reviews', () => {
  it('are stored with their month and queued for upload together', async () => {
    const { store, db } = await device();
    await store.setVocab(vocab([note(1)]));
    const ev = await store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    expect(ev.mo).toBe('2026-11');
    expect((await db.db.events.get(ev.id))?.mo).toBe('2026-11');
    expect(Object.keys(await store.dirtyMonths())).toEqual(['2026-11']);
    expect((await store.ownMonthEvents('2026-11')).map((e) => e.id)).toEqual([ev.id]);
  });

  it('dirty stamps never go backwards, even when the clock does', async () => {
    const { store } = await device();
    await store.setVocab(vocab([note(1)]));
    await store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    const first = (await store.dirtyMonths())['2026-11'];
    // An upload started now remembers this stamp; then the clock jumps back and another review comes in.
    vi.spyOn(Date, 'now').mockReturnValue(first - 3600000);
    await store.recordReview('v:词1|ci1#recog', 4, 'reveal', 1000, T0 + 60000);
    const second = (await store.dirtyMonths())['2026-11'];
    expect(second).toBeGreaterThan(first);
    await store.clearDirty('2026-11', first);
    expect(await store.dirtyMonths()).toEqual({ '2026-11': second });
  });

  it('undo marks the month the review was stored in, whatever the time zone now', async () => {
    env.TZ = 'Asia/Shanghai';
    const { store } = await device();
    await store.setVocab(vocab([note(1)]));
    const ev = await store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, Date.UTC(2026, 10, 30, 20));
    expect(ev.mo).toBe('2026-12');
    await store.clearDirty('2026-12', Number.MAX_SAFE_INTEGER);
    env.TZ = 'Europe/Paris';
    await store.undoReview(ev.id);
    expect(Object.keys(await store.dirtyMonths())).toEqual(['2026-12']);
    expect(store.getState().events).toHaveLength(0);
  });

  it('events of other devices are only changed by merges, and own events never by a merge', async () => {
    const { store, db, id } = await device();
    await store.setVocab(vocab([note(1)]));
    const own = await store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    expect(await store.mergeDeviceEvents(id, '2026-11', [])).toBe(false);
    expect(await db.db.events.get(own.id)).toBeTruthy();
    await store.undoReview('missing');
    const other: ReviewEvent = { id: 'o1', card: 'v:词1|ci1#recog', r: 4, t: T0 + 1000, d: 1, m: 'reveal', dev: 'iphone-1' };
    expect(await store.mergeDeviceEvents('iphone-1', '2026-11', [other])).toBe(true);
    expect(await store.mergeDeviceEvents('iphone-1', '2026-11', [other])).toBe(false);
    // Undo only removes this device's reviews.
    await store.undoReview('o1');
    expect(store.getState().events).toHaveLength(2);
    expect((await db.db.events.get('o1'))?.mo).toBe('2026-11');
    expect(store.getState().cards.get('v:词1|ci1#recog')?.nEvents).toBe(2);
  });
});

describe('renamed words', () => {
  it('history follows the new id in memory; stored events keep their original card', async () => {
    const { store, db } = await device();
    await store.setVocab(vocab([note(1), note(2)]));
    const ev = await store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    const renamed = note(1, { id: 'v:词1|cii1' });
    await store.setVocab(vocab([renamed, note(2)], { hash: 'h2b', aliases: { 'v:词1|ci1': 'v:词1|cii1' } }));
    let s = store.getState();
    expect(s.events[0].card).toBe('v:词1|cii1#recog');
    expect(s.cards.get('v:词1|cii1#recog')?.nEvents).toBe(1);
    expect((await db.db.events.get(ev.id))?.card).toBe('v:词1|ci1#recog');
    expect((await store.ownMonthEvents('2026-11'))[0].card).toBe('v:词1|ci1#recog');

    // A list from an older app version (no aliases) keeps the renames known here.
    await store.setVocab(vocab([renamed, note(2)], { hash: 'h2c' }), true);
    s = store.getState();
    expect(s.meta?.aliases).toEqual({ 'v:词1|ci1': 'v:词1|cii1' });
    expect(s.cards.get('v:词1|cii1#recog')?.nEvents).toBe(1);
  });

  it('the view survives a restart', async () => {
    const first = await device();
    await first.store.setVocab(vocab([note(1)]));
    await first.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    await first.store.setVocab(vocab([note(1, { id: 'v:词1|cii1' })], { hash: 'x', aliases: { 'v:词1|ci1': 'v:词1|cii1' } }));
    const again = await device(first.idb);
    expect(again.store.getState().events[0].card).toBe('v:词1|cii1#recog');
    expect(again.store.getState().cards.get('v:词1|cii1#recog')?.nEvents).toBe(1);
  });
});

describe('row colour times', () => {
  it('a list without colourSince (older app version) keeps the local one; a list with one replaces it', async () => {
    const a = await device();
    const since = { 'v:词1|ci1@HSK四级#0': ['mastered', 5] as ['mastered', number] };
    await a.store.setVocab(vocab([note(1)], { colourSince: since }));
    expect(a.store.getState().meta?.colourSince).toEqual(since);
    await a.store.setVocab(vocab([note(1)], { hash: 'old' }), true);
    expect(a.store.getState().meta?.colourSince).toEqual(since);
    const again = await device(a.idb);
    expect(again.store.getState().meta?.colourSince).toEqual(since);
    const next = { 'v:词1|ci1@HSK四级#0': ['mastered', 9] as ['mastered', number] };
    await again.store.setVocab(vocab([note(1)], { hash: 'new', colourSince: next }), true);
    expect(again.store.getState().meta?.colourSince).toEqual(next);
    // None anywhere: no key at all.
    const b = await device();
    await b.store.setVocab(vocab([note(1)]));
    expect(b.store.getState().meta).not.toHaveProperty('colourSince');
  });
});

describe('held import', () => {
  it('is kept across restarts until dropped', async () => {
    const first = await device();
    const p: PendingImport = { vocab: vocab([note(1)]), reasons: ['Sheet HSK四级 is gone'], prevCount: 40 };
    await first.store.setPendingImport(p);
    expect(first.store.getState().pendingImport?.reasons).toEqual(p.reasons);
    const again = await device(first.idb);
    expect(again.store.getState().pendingImport?.prevCount).toBe(40);
    await again.store.setPendingImport(undefined);
    expect(again.store.getState().pendingImport).toBeUndefined();
    expect((await device(first.idb)).store.getState().pendingImport).toBeUndefined();
  });
});

describe('other tabs', () => {
  it('a tab reloads what another tab wrote', async () => {
    const a = await device();
    await a.store.setVocab(vocab([note(1)]));
    const b = await device(a.idb);
    await b.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    await b.store.updateSettings({ newVocab: 3 });
    await a.store.reloadFromDb();
    expect(a.store.getState().events).toHaveLength(1);
    expect(a.store.getState().settings.newVocab).toBe(3);
    expect(a.store.getState().cards.get('v:词1|ci1#recog')?.nEvents).toBe(1);
  });

  it('a newer version opening the database asks this tab to reload', async () => {
    const a = await device();
    const newer = new Dexie('hugo-zhongwen', { indexedDB: a.idb, IDBKeyRange });
    newer.version(2).stores({ notes: 'id, kind, order', cards: 'id, note, due, type', events: 'id, card, t, dev', kv: 'k' });
    await newer.open();
    expect(a.store.getState().needsReload).toBe(true);
    newer.close();
  });
});

describe('status marks', () => {
  const W = 'v:词1|ci1';

  it('a mark survives a restart, and its row and dirty month are written together', async () => {
    const a = await device();
    await a.store.setVocab(vocab([note(1), note(2)]));
    const m = await a.store.setNoteStatus(W, 'known', T0);
    expect(m).toMatchObject({ note: W, a: 'known', t: T0, dev: a.id, mo: '2026-11' });
    expect(a.store.getState().marks.map((x) => x.id)).toEqual([m.id]);
    expect(a.store.getState().cards.get(`${W}#recog`)?.state).toBe(2);
    expect(await a.db.kvGet(`marks:${a.id}:2026-11`, [])).toEqual([m]);
    expect(Object.keys(await a.store.dirtyMarkMonths())).toEqual(['2026-11']);
    // Review months are a separate queue, untouched by marks (older app versions read it).
    expect(await a.store.dirtyMonths()).toEqual({});
    expect(await a.store.ownMonthMarks('2026-11')).toEqual([m]);

    const again = await device(a.idb);
    const s = again.store.getState();
    expect(s.marks).toEqual([m]);
    expect(s.cards.get(`${W}#recog`)).toEqual(a.store.getState().cards.get(`${W}#recog`));
    expect(s.cards.get(`${W}#recog`)?.mark).toEqual({ a: 'known', t: T0 });
  });

  it('a failed save stores neither the mark nor its dirty month', async () => {
    const { store, db, id } = await device();
    await store.setVocab(vocab([note(1)]));
    const put = db.db.kv.put.bind(db.db.kv);
    vi.spyOn(db.db.kv, 'put').mockImplementation(((row: { k: string; v: unknown }) => {
      if (row.k === 'marksDirty') throw new Error('disk full');
      return put(row);
    }) as typeof db.db.kv.put);
    await expect(store.setNoteStatus(W, 'suspend', T0)).rejects.toThrow(/disk full/);
    vi.restoreAllMocks();
    expect(await db.kvGet(`marks:${id}:2026-11`, null)).toBeNull();
    expect(await store.dirtyMarkMonths()).toEqual({});
    expect(store.getState().marks).toEqual([]);
  });

  it('undo removes an own mark only, and queues its month again', async () => {
    const { store, db, id } = await device();
    await store.setVocab(vocab([note(1), note(2)]));
    const before = store.getState().cards.get(`${W}#recog`);
    const own = await store.setNoteStatus(W, 'suspend', T0);
    expect(store.getState().cards.get(`${W}#recog`)?.suspended).toBe(true);
    await store.clearMarkDirty('2026-11', Number.MAX_SAFE_INTEGER);
    const other: StatusMark = { id: 'o1', note: 'v:词2|ci2', a: 'known', t: T0 + 1, dev: 'iphone-1' };
    expect(await store.mergeDeviceMarks('iphone-1', '2026-11', [other])).toBe(true);
    await store.undoMark('o1');
    await store.undoMark('missing');
    expect(store.getState().marks.map((m) => m.id).sort()).toEqual(['o1', own.id].sort());
    await store.undoMark(own.id);
    expect(store.getState().marks.map((m) => m.id)).toEqual(['o1']);
    expect(store.getState().cards.get(`${W}#recog`)).toEqual(before);
    expect(await db.kvGet(`marks:${id}:2026-11`, null)).toEqual([]);
    expect(Object.keys(await store.dirtyMarkMonths())).toEqual(['2026-11']);
  });

  it('a merge replaces its device-month row and never touches own marks', async () => {
    const { store, db, id } = await device();
    await store.setVocab(vocab([note(1), note(2)]));
    const own = await store.setNoteStatus(W, 'known', T0);
    expect(await store.mergeDeviceMarks(id, '2026-11', [])).toBe(false);
    expect(store.getState().marks).toEqual([own]);
    const o = (i: string, t: number): StatusMark => ({ id: i, note: 'v:词2|ci2', a: 'suspend', t, dev: 'x' });
    expect(await store.mergeDeviceMarks('iphone-1', '2026-11', [o('o1', T0), o('o2', T0 + 1)])).toBe(true);
    expect(await store.mergeDeviceMarks('iphone-1', '2026-11', [o('o2', T0 + 1), o('o1', T0)])).toBe(false);
    expect(store.getState().cards.get('v:词2|ci2#recog')?.suspended).toBe(true);
    expect(await store.mergeDeviceMarks('iphone-1', '2026-11', [o('o2', T0 + 1)])).toBe(true);
    expect(await store.mergeDeviceMarks('iphone-1', '2026-10', [o('o0', T0 - 86400000 * 20)])).toBe(true);
    const ids = store.getState().marks.map((m) => m.id).sort();
    expect(ids).toEqual(['o0', 'o2', own.id].sort());
    expect(await db.kvGet('marks:iphone-1:2026-11', null)).toEqual([{ ...o('o2', T0 + 1), dev: 'iphone-1', mo: '2026-11' }]);
    // An emptied file empties its row; marks of another device are never queued for upload here.
    expect(await store.mergeDeviceMarks('iphone-1', '2026-11', [])).toBe(true);
    expect(await store.mergeDeviceMarks('iphone-1', '2026-10', [])).toBe(true);
    expect(store.getState().marks).toEqual([own]);
    expect(store.getState().cards.get('v:词2|ci2#recog')?.suspended).toBeUndefined();
    expect(Object.keys(await store.dirtyMarkMonths())).toEqual(['2026-11']);
    await store.clearMarkDirty('2026-11', Number.MAX_SAFE_INTEGER);
    await store.mergeDeviceMarks('iphone-1', '2026-11', [o('o3', T0)]);
    expect(await store.dirtyMarkMonths()).toEqual({});
  });

  it('a re-import of the word list keeps the effect of a mark', async () => {
    const { store } = await device();
    const studied = note(1, { studied: true });
    await store.setVocab(vocab([studied, note(2)], { seeds: { [W]: T0 - 86400000 } }));
    expect(store.getState().cards.get(`${W}#recog`)?.seeded).toBe(true);
    await store.setNoteStatus(W, 'relearn', T0);
    const after = store.getState().cards.get(`${W}#recog`)!;
    expect(after.state).toBe(1);
    // The same Excel again (the row is still green, seed time is older than the mark).
    await store.setVocab(vocab([studied, note(2)], { hash: 'again', importedAt: T0 + 1000, seeds: { [W]: T0 + 1000 } }));
    expect(store.getState().meta?.seeds[W]).toBe(T0 - 86400000);
    expect(store.getState().cards.get(`${W}#recog`)).toEqual(after);
  });

  it('a mark on a renamed word follows it; the stored mark keeps its id', async () => {
    const { store, db, id } = await device();
    await store.setVocab(vocab([note(1)]));
    const m = await store.setNoteStatus(W, 'suspend', T0);
    await store.setVocab(vocab([note(1, { id: 'v:词1|cii1' })], { hash: 'r', aliases: { [W]: 'v:词1|cii1' } }));
    expect(store.getState().marks[0].note).toBe('v:词1|cii1');
    expect(store.getState().cards.get('v:词1|cii1#recog')?.suspended).toBe(true);
    expect((await db.kvGet<StatusMark[]>(`marks:${id}:2026-11`, []))[0].note).toBe(W);
    await store.undoMark(m.id);
    expect(store.getState().cards.get('v:词1|cii1#recog')?.suspended).toBeUndefined();
  });

  it('own marks count as having recorded something: the device id is kept', async () => {
    const { store } = await device();
    expect(await store.hasOwnEvents()).toBe(false);
    await store.mergeDeviceMarks('iphone-1', '2026-11', [{ id: 'o1', note: W, a: 'known', t: T0, dev: 'iphone-1' }]);
    expect(await store.hasOwnEvents()).toBe(false);
    await store.setNoteStatus(W, 'known', T0);
    expect(await store.hasOwnEvents()).toBe(true);
    await expect(store.renewDeviceId()).rejects.toThrow();
  });

  it('renewing the id drops the mark upload queue', async () => {
    const { store, db } = await device();
    await db.kvSet('marksDirty', { '2026-11': 5 });
    await store.renewDeviceId();
    expect(await store.dirtyMarkMonths()).toEqual({});
  });

  it('a status mark survives a restart and leaves the cards as they were', async () => {
    const a = await device();
    await a.store.setVocab(vocab([note(1), note(2)]));
    const before = a.store.getState().cards.get(`${W}#recog`);
    const m = await a.store.setNoteStatus(W, 'st:mastered', T0);
    expect(a.store.getState().cards.get(`${W}#recog`)).toEqual(before);
    expect(Object.keys(await a.store.dirtyMarkMonths())).toEqual(['2026-11']);
    const again = await device(a.idb);
    expect(again.store.getState().marks).toEqual([m]);
    expect(again.store.getState().marks[0].a).toBe('st:mastered');
    expect(again.store.getState().cards.get(`${W}#recog`)).toEqual(before);
    await again.store.undoMark(m.id);
    expect((await device(a.idb)).store.getState().marks).toEqual([]);
  });

  it('another tab sees a mark after a reload', async () => {
    const a = await device();
    await a.store.setVocab(vocab([note(1)]));
    const b = await device(a.idb);
    const m = await b.store.setNoteStatus(W, 'known', T0);
    await a.store.reloadFromDb();
    expect(a.store.getState().marks).toEqual([m]);
    expect(a.store.getState().cards.get(`${W}#recog`)?.state).toBe(2);
  });
});

describe('shared preferences', () => {
  it('a change is saved into the settings after a pause, and queued for upload', async () => {
    const { store, db } = await device();
    const before = store.getState().settings.updatedAt;
    expect(await db.kvGet('settingsDirty', false)).toBe(false);
    db.setPref('qm.tag', 'HSK四级');
    db.setPref('voice', 'x-voice'); // per device: never in the settings
    db.setPref('warm.dict.1', true); // a cache marker
    store.setLang('fr');
    expect(store.getState().lang).toBe('fr');
    expect(store.getState().settings.prefs).toBeUndefined();
    await vi.waitFor(() => expect(store.getState().settings.prefs).toEqual({ lang: 'fr', 'qm.tag': 'HSK四级' }), { timeout: 4000, interval: 100 });
    expect(store.getState().settings.updatedAt).toBeGreaterThan(before);
    expect(await db.kvGet('settingsDirty', false)).toBe(true);
    expect((await db.getSettings()).prefs).toEqual({ lang: 'fr', 'qm.tag': 'HSK四级' });
  });

  it('prefs from sync are written to localStorage without echo', async () => {
    const { store, db } = await device();
    const rs = { ...store.getState().settings, prefs: { lang: 'fr', acceptBoth: false, voice: 'not-shared', 'mode.recog': 'write-free' }, updatedAt: Date.now() + 1000 };
    await store.updateSettings(rs, true);
    expect(store.getState().lang).toBe('fr');
    expect(localStorage.getItem('hz.lang')).toBe('"fr"');
    expect(db.pref('acceptBoth', true)).toBe(false);
    // Only shared keys come in through sync.
    expect(db.pref('voice', '')).toBe('');
    expect(db.pref('mode.recog', '')).toBe('');
    await new Promise((r) => setTimeout(r, 1700));
    expect(await db.kvGet('settingsDirty', false)).toBe(false);
    expect(store.getState().settings.updatedAt).toBe(rs.updatedAt);
  });

  it('are applied at start-up, unless one was changed here after them', async () => {
    const a = await device();
    await a.db.kvSet('settings', { ...a.store.getState().settings, prefs: { lang: 'fr' }, updatedAt: Date.now() - 1000 });
    const b = await device(a.idb);
    expect(b.store.getState().lang).toBe('fr');
    // Changed here, then the app closed before it was saved: the newer local value stays.
    b.db.setPref('lang', 'en');
    const c = await device(a.idb);
    expect(c.store.getState().lang).toBe('en');
    // Nothing was pushed at start-up.
    expect(await c.db.kvGet('settingsDirty', false)).toBe(false);
  });
});

describe('device preferences', () => {
  it('Sheets preferences (sh.*) are backed up and restored, never shared', async () => {
    const { db } = await device();
    db.setPref('sh.tab', 'HSK五级');
    db.setPref('sh.filter', 'notknown');
    db.setPref('lang', 'fr');
    expect(db.collectPrefs('backup')).toMatchObject({ 'sh.tab': 'HSK五级', 'sh.filter': 'notknown', lang: 'fr' });
    expect(db.collectPrefs('shared')).toEqual({ lang: 'fr' });
    expect(db.SHARED_PREFS.some((k) => k.startsWith('sh.'))).toBe(false);
    localStorage.clear();
    expect(db.writePrefsSilently({ 'sh.paint': 'mastered', 'xx.other': 1 })).toBe(1);
    expect(db.pref('sh.paint', '')).toBe('mastered');
  });
});

describe('speed', () => {
  const N_NOTES = 2000;
  const notes = Array.from({ length: N_NOTES }, (_, i) => note(i));
  const T = Date.UTC(2024, 0, 1);
  const event = (i: number, dev = 'iphone-1'): ReviewEvent => ({
    id: `${dev}-${i}`,
    card: `v:词${i % N_NOTES}|ci${i % N_NOTES}#recog`,
    r: ((i % 4) + 1) as 1 | 2 | 3 | 4,
    t: T + i * 400000,
    d: 1000,
    m: 'reveal',
    dev,
  });

  it('2,000 words and 200,000 reviews are replayed in under 3 s', () => {
    const events = Array.from({ length: 200000 }, (_, i) => event(i));
    const aliases = { 'v:词0|old': 'v:词0|ci0' };
    const t0 = performance.now();
    const view = resolveEventCards(events, aliases, new Set(notes.map((n) => n.id)));
    const cards = deriveCards(notes, view, {}, { retention: 0.9, spreadDays: 60, recall: true, listen: false });
    expect(cards).toHaveLength(2 * N_NOTES);
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it('start-up, a month merge and an upload read stay fast on a large log', async () => {
    const { store, db, idb } = await device();
    await store.setVocab(vocab(notes));
    // 20,000 stored events (fake-indexeddb writes slowly, so the database part is tested at a tenth of the size).
    const events = Array.from({ length: 20000 }, (_, i) => event(i));
    await db.db.events.bulkPut(events);
    const t0 = performance.now();
    const again = await device(idb);
    const month = '2024-02';
    const inMonth = events.filter((e) => again.db.monthKey(e.t) === month);
    expect(inMonth.length).toBeGreaterThan(1000);
    expect(await again.store.mergeDeviceEvents('iphone-1', month, inMonth.slice(1), { rebuild: false })).toBe(true);
    again.store.rebuildAll();
    await again.store.ownMonthEvents(month);
    expect(performance.now() - t0).toBeLessThan(3000);
    expect(again.store.getState().events).toHaveLength(20000 - 1);
  }, 30000);
});
