// The Wrong label (mobile-ux D6): flag:wrong / unflag:wrong marks, latest by (t, id) wins, invisible to statuses,
// the engine and older app versions.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { Note, ReviewEvent, StatusMark, VocabFile } from './types';
import { latestWrongMarks, wrongNotes, WRONG_OFF, WRONG_ON } from './wrong';
import { DAY, deriveCards, latestMarks } from './engine/schedule';
import { latestStatusMarks, markStatus, noteStatuses, sheetRows } from './status';

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

/** A fresh copy of the app's modules with its own IndexedDB (pass `idb` again for a reload of the same device). */
async function device(idb = new IDBFactory()) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const db = await import('./db');
  const sync = await import('./sync');
  const backup = await import('./backup');
  const wrong = await import('./wrong');
  await store.init();
  return { store, db, sync, backup, wrong, idb, id: store.getState().device };
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
    refs: [{ sheet: 'HSK五级', row: i + 2 }],
    order: i,
    studied: false,
    examples: [],
    ...over,
  };
}

const T0 = new Date(2026, 10, 2, 10).getTime();

function vocab(notes: Note[], over: Partial<VocabFile> = {}): VocabFile {
  return {
    version: 1,
    importedAt: T0,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: T0, size: 1000 },
    hash: 'h' + notes.length,
    notes,
    issues: [],
    seeds: {},
    report: [],
    ...over,
  };
}

const W = 'v:词1|ci1';
const mk = (id: string, a: StatusMark['a'], t: number, n = W, dev = 'pc-1'): StatusMark => ({ id, note: n, a, t, dev });

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wrongNotes', () => {
  it('the kinds are the two D6 names', () => {
    expect([WRONG_ON, WRONG_OFF]).toEqual(['flag:wrong', 'unflag:wrong']);
  });

  it('latest of the two kinds wins, by time then id, whatever the order of the list', () => {
    const a = mk('a', 'flag:wrong', 1);
    const b = mk('b', 'unflag:wrong', 2);
    expect(wrongNotes([a])).toEqual(new Set([W]));
    expect(wrongNotes([a, b])).toEqual(new Set());
    expect(wrongNotes([b, a])).toEqual(new Set());
    expect(wrongNotes([b, a, mk('c', 'flag:wrong', 3)])).toEqual(new Set([W]));
    // Same time: the larger id wins, on every device.
    const on = mk('y', 'flag:wrong', 5);
    const off = mk('x', 'unflag:wrong', 5);
    expect(wrongNotes([on, off])).toEqual(new Set([W]));
    expect(wrongNotes([off, on])).toEqual(new Set([W]));
    expect(wrongNotes([mk('x', 'flag:wrong', 5), mk('y', 'unflag:wrong', 5)])).toEqual(new Set());
    expect(latestWrongMarks([off, on]).get(W)?.id).toBe('y');
  });

  it('per note, and other kinds are ignored', () => {
    const n2 = 'v:词2|ci2';
    const marks = [
      mk('a', 'flag:wrong', 1),
      mk('b', 'st:mastered', 9),
      mk('c', 'known', 10),
      mk('d', 'flag:wrong', 1, n2),
      mk('e', 'unflag:wrong', 2, n2),
      mk('f', 'st:notknown', 3, 'v:词3|ci3'),
    ];
    expect(wrongNotes(marks)).toEqual(new Set([W]));
    expect(wrongNotes([])).toEqual(new Set());
    // An unflag with no flag before it is simply "not Wrong".
    expect(wrongNotes([mk('z', 'unflag:wrong', 1)])).toEqual(new Set());
  });
});

describe('compatibility (no format bump)', () => {
  it('no status: markStatus, latestStatusMarks, sheetRows and noteStatuses ignore the new kinds', () => {
    expect(markStatus('flag:wrong')).toBeNull();
    expect(markStatus('unflag:wrong')).toBeNull();
    const notes = [note(1), note(2, { refs: [{ sheet: 'HSK五级', row: 4 }, { sheet: 'HSK六级', row: 2 }] })];
    const st = [mk('s1', 'st:studying', 10), mk('s2', 'st:mastered', 10, 'v:词2|ci2')];
    const wrong = [mk('w1', 'flag:wrong', 20), mk('w2', 'flag:wrong', 5, 'v:词2|ci2'), mk('w3', 'unflag:wrong', 30, 'v:词2|ci2')];
    expect(latestStatusMarks([...st, ...wrong])).toEqual(latestStatusMarks(st));
    const plain = sheetRows(notes, st, undefined);
    const mixed = sheetRows(notes, [...wrong, ...st], undefined);
    expect(mixed).toEqual(plain);
    expect(noteStatuses(mixed)).toEqual(new Map([[W, 'studying'], ['v:词2|ci2', 'mastered']]));
    // Wrong marks alone leave every row on its Excel colour.
    expect(sheetRows(notes, wrong, undefined)).toEqual(sheetRows(notes, [], undefined));
  });

  it('the engine ignores them: latestMarks skips them and deriveCards gives the same cards', () => {
    const tz = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
    const before = tz.TZ;
    tz.TZ = 'UTC';
    try {
      expect(latestMarks([mk('w', 'flag:wrong', 1), mk('u', 'unflag:wrong', 2)]).size).toBe(0);
      const t0 = Date.UTC(2026, 0, 5, 9);
      const words = [note(1), note(2, { studied: true }), note(3)];
      const seeds = { 'v:词2|ci2': t0 - 10 * DAY };
      const grades: [string, 1 | 2 | 3 | 4, number][] = [
        [`${W}#recog`, 3, 0],
        [`${W}#recog`, 1, DAY],
        [`${W}#recall`, 3, 2 * DAY],
        ['v:词2|ci2#recog', 4, 12 * DAY],
        ['v:词3|ci3#recog', 2, 3 * DAY],
      ];
      const events: ReviewEvent[] = grades.map(([card, r, dt], i) => ({ id: `g${i}`, card, r, t: t0 + dt, d: 3000, m: 'reveal', dev: 'pc' }));
      const settings = { retention: 0.9, spreadDays: 60, recall: true, listen: true };
      const base = [mk('k1', 'known', t0 + 5 * DAY, 'v:词3|ci3'), mk('s1', 'suspend', t0 + 6 * DAY, 'v:词2|ci2')];
      // Wrong marks interleaved with the reviews and the other marks, same times included.
      const wrong = words.flatMap((w, i) => [
        mk(`wa${i}`, 'flag:wrong', t0 + i * DAY, w.id),
        mk(`wb${i}`, 'unflag:wrong', t0 + 5 * DAY, w.id),
        mk(`wc${i}`, 'flag:wrong', t0 + 40 * DAY, w.id, 'phone'),
      ]);
      expect(deriveCards(words, events, seeds, settings, [...base, ...wrong])).toEqual(deriveCards(words, events, seeds, settings, base));
      expect(deriveCards(words, events, seeds, settings, wrong)).toEqual(deriveCards(words, events, seeds, settings));
    } finally {
      if (before == null) delete tz.TZ;
      else tz.TZ = before;
    }
  });

  it('a marks file holding the new kinds round-trips through encodeMarks / decodeMarks', async () => {
    const { sync } = await device();
    const marks = [mk('a', 'st:studying', 1), mk('b', 'flag:wrong', 2), mk('c', 'unflag:wrong', 3), mk('d', 'known', 4)];
    const text = sync.encodeMarks('pc-1', '2026-11', marks.map((m) => ({ ...m, mo: '2026-11' })));
    expect(JSON.parse(text).v).toBe(1);
    expect(sync.decodeMarks(text, 'pc-1')).toEqual(marks);
  });
});

describe('setWrong', () => {
  it('writes one mark per note whose state differs, skips the rest, and returns the count', async () => {
    const d = await device();
    await d.store.setVocab(vocab([note(1), note(2), note(3)]));
    const ids = ['v:词1|ci1', 'v:词2|ci2'];
    expect(await d.store.setWrong(ids, true, T0)).toBe(2);
    expect(d.wrong.wrongNotes(d.store.getState().marks)).toEqual(new Set(ids));
    // Already Wrong: nothing written. Duplicates and unknown ids are skipped.
    expect(await d.store.setWrong([...ids, W, 'v:nope|nope'], true, T0 + 1)).toBe(0);
    expect(d.store.getState().marks).toHaveLength(2);
    // Clearing a word that is not Wrong writes nothing; clearing one that is writes unflag:wrong.
    expect(await d.store.setWrong(['v:词3|ci3', W], false, T0 + 2)).toBe(1);
    const s = d.store.getState();
    expect(s.marks.map((m) => [m.note, m.a])).toEqual([
      [W, 'flag:wrong'],
      ['v:词2|ci2', 'flag:wrong'],
      [W, 'unflag:wrong'],
    ]);
    expect(d.wrong.wrongNotes(s.marks)).toEqual(new Set(['v:词2|ci2']));
    expect(await d.store.setWrong([], true)).toBe(0);
  });

  it('is stored with its dirty month, survives a reload and changes no card nor status', async () => {
    const d = await device();
    await d.store.setVocab(vocab([note(1), note(2)]));
    await d.store.recordReview(`${W}#recog`, 3, 'reveal', 1000, T0);
    await d.store.setNoteStatus(W, 'st:studying', T0 + 1000);
    const cards = d.store.getState().cards;
    const rows = sheetRows(d.store.getState().notes, d.store.getState().marks, undefined);
    expect(await d.store.setWrong([W], true, T0 + 2000)).toBe(1);
    expect(d.store.getState().cards).toEqual(cards);
    expect(sheetRows(d.store.getState().notes, d.store.getState().marks, undefined)).toEqual(rows);
    expect(Object.keys(await d.store.dirtyMarkMonths())).toEqual(['2026-11']);
    expect((await d.store.ownMonthMarks('2026-11')).map((m) => m.a)).toEqual(['st:studying', 'flag:wrong']);

    const again = await device(d.idb);
    expect(again.wrong.wrongNotes(again.store.getState().marks)).toEqual(new Set([W]));
    expect(again.store.getState().cards).toEqual(cards);
  });

  it('marks in several months go into their own rows, all queued', async () => {
    const d = await device();
    await d.store.setVocab(vocab([note(1), note(2)]));
    // Another device flagged word 2 with its clock far ahead (December): clearing it here still wins.
    const dec = new Date(2026, 11, 3, 10).getTime();
    await d.store.mergeDeviceMarks('phone-1', '2026-12', [mk('p1', 'flag:wrong', dec, 'v:词2|ci2', 'phone-1')]);
    expect(await d.store.setWrong([W], true, T0)).toBe(1);
    expect(await d.store.setWrong([W, 'v:词2|ci2'], false, T0 + 1000)).toBe(2);
    const s = d.store.getState();
    expect(d.wrong.wrongNotes(s.marks)).toEqual(new Set());
    const off2 = s.marks.find((m) => m.note === 'v:词2|ci2' && m.a === 'unflag:wrong')!;
    expect(off2.t).toBe(dec + 1);
    expect(off2.mo).toBe('2026-12');
    expect(Object.keys(await d.store.dirtyMarkMonths()).sort()).toEqual(['2026-11', '2026-12']);
    expect((await d.store.ownMonthMarks('2026-12')).map((m) => m.a)).toEqual(['unflag:wrong']);
  });

  it('judges a renamed word on the marks shown, so it is not flagged twice', async () => {
    const d = await device();
    await d.store.setVocab(vocab([note(1), note(2)]));
    expect(await d.store.setWrong([W], true, T0)).toBe(1);
    const renamed = 'v:词1|cii1';
    await d.store.setVocab(vocab([note(1, { id: renamed }), note(2)], { hash: 'h2b', aliases: { [W]: renamed } }));
    expect(d.wrong.wrongNotes(d.store.getState().marks)).toEqual(new Set([renamed]));
    expect(await d.store.setWrong([renamed], true, T0 + 1)).toBe(0);
    expect(await d.store.setWrong([renamed], false, T0 + 2)).toBe(1);
    expect(d.wrong.wrongNotes(d.store.getState().marks)).toEqual(new Set());
  });

  it('a backup holds the Wrong marks and a restore brings the label back', async () => {
    const d = await device();
    await d.store.setVocab(vocab([note(1), note(2)]));
    await d.store.setWrong([W, 'v:词2|ci2'], true, T0);
    await d.store.setWrong(['v:词2|ci2'], false, T0 + 1000);
    const { bytes } = await d.backup.buildBackup();

    const fresh = await device();
    const report = await fresh.backup.restoreBackup(bytes);
    expect(report.marks).toBe(3);
    expect(fresh.wrong.wrongNotes(fresh.store.getState().marks)).toEqual(new Set([W]));
    expect(fresh.store.getState().marks.map((m) => m.a).sort()).toEqual(['flag:wrong', 'flag:wrong', 'unflag:wrong']);
  });
});
