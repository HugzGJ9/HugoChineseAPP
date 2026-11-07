// The app state over IndexedDB: month stamps, dirty months, renames, held imports, other tabs, speed.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { Note, PendingImport, ReviewEvent, VocabFile } from './types';
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

afterEach(() => {
  if (TZ == null) delete env.TZ;
  else env.TZ = TZ;
  vi.restoreAllMocks();
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
