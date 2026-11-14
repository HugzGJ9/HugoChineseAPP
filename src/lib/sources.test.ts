// Held imports (sources.ts): a suspicious local import is held until Hugo picks the old or the new list; a list he
// turned down is not offered again; accepting recomputes against the list as it is then; imports run one at a time.
// The import worker is inline: the "workbook" is JSON { sheet: [[hanzi, pinyin, colour?], ...] }, one note per row.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { ImportRequest } from './import';
import type { Note, SheetReport, VocabFile, WorkbookSource } from './types';

type Row = [string, string, string?];
type Book = Record<string, Row[]>;

const h = vi.hoisted(() => ({
  /** Calls to the import worker, in order: 'start <n>' / 'end <n>'. */
  log: [] as string[],
  calls: 0,
  /** When set, the next import waits for it before answering. */
  gate: null as Promise<void> | null,
}));

vi.mock('./import', () => ({
  importWorkbook: async (req: Omit<ImportRequest, 'dictUrl'>) => {
    const n = ++h.calls;
    h.log.push(`start ${n}`);
    const gate = h.gate;
    h.gate = null;
    if (gate) await gate;
    const book = JSON.parse(new TextDecoder().decode(new Uint8Array(req.bytes))) as Book;
    h.log.push(`end ${n}`);
    return fakeVocab(book, req.source, req.now, req.device, req.prevSeeds);
  },
}));

const GREEN = 'A9D18E';
const NAME = 'Hugo_chinese_vocab.xlsx';
const T0 = Date.UTC(2026, 10, 9, 9);

function fakeVocab(book: Book, source: WorkbookSource, now: number, device: string, prevSeeds: Record<string, number>): VocabFile {
  const notes: Note[] = [];
  const report: SheetReport[] = [];
  let order = 0;
  for (const [sheet, rows] of Object.entries(book)) {
    rows.forEach(([hanzi, py, colour], i) => {
      notes.push({
        id: `v:${hanzi}|${py}`,
        kind: 'vocab',
        hanzi,
        alts: [],
        pinyin: py,
        pinyinNum: py,
        en: `${hanzi} (en)`,
        notes: [],
        tags: [],
        refs: [{ sheet, row: i + 2, ...(colour ? { colour } : {}) }],
        order: order++,
        studied: colour === GREEN,
        ...(colour ? { colour } : {}),
        examples: [],
      });
    });
    report.push({ name: sheet, kind: 'vocab', rows: rows.length, notes: rows.length, studied: 0, colours: {} });
  }
  const seeds: Record<string, number> = {};
  for (const n of notes) if (n.studied) seeds[n.id] = prevSeeds[n.id] ?? now;
  return {
    version: 1,
    importedAt: now,
    device,
    source,
    hash: `h:${notes.map((n) => `${n.id}=${n.colour ?? ''}`).join(',')}`,
    notes,
    issues: [],
    seeds,
    report,
  };
}

const bytes = (book: Book): ArrayBuffer => new TextEncoder().encode(JSON.stringify(book)).buffer as ArrayBuffer;
const src = (over: Partial<WorkbookSource> = {}): WorkbookSource => ({ name: NAME, modified: T0, size: 1000, ...over });

const SHEET_A: Row[] = [
  ['学习', 'xuexi', GREEN],
  ['朋友', 'pengyou'],
  ['告诉', 'gaosu'],
  ['工作', 'gongzuo'],
  ['时间', 'shijian'],
];
const SHEET_B: Row[] = [
  ['经济', 'jingji'],
  ['环境', 'huanjing'],
  ['政府', 'zhengfu'],
  ['社会', 'shehui'],
];
const L1: Book = { HSK五级: SHEET_A, HSK六级: SHEET_B };
/** Sheet HSK六级 gone: held by the guard. */
const BROKEN: Book = { HSK五级: SHEET_A };
const ids = (notes: Note[]) => notes.map((n) => n.id);

/** localStorage for Node (device preferences). */
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) {
    return this.m.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
}

/** A fresh copy of the app's modules on a new database. */
async function device() {
  vi.resetModules();
  Dexie.dependencies.indexedDB = new IDBFactory();
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const sources = await import('./sources');
  const db = await import('./db');
  await store.init();
  return { store, sources, db };
}
type Dev = Awaited<ReturnType<typeof device>>;

/** A device with list L1 imported and nothing left to sync. */
async function withList(): Promise<Dev> {
  const d = await device();
  const out = await d.sources.importBytes(bytes(L1), src());
  expect(out.applied).toBe(true);
  await d.db.kvSet('vocabDirty', false);
  return d;
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
  h.log = [];
  h.calls = 0;
  h.gate = null;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a suspicious import', () => {
  it('applies nothing: notes unchanged, vocabDirty not set, pendingImport set', async () => {
    const d = await withList();
    const before = d.store.getState().notes;
    const metaBefore = d.store.getState().meta;

    const out = await d.sources.importBytes(bytes(BROKEN), src({ modified: T0 + 60000 }));

    expect(out.applied).toBe(false);
    expect(out.reasons?.join(' ')).toContain('HSK六级');
    expect(d.store.getState().notes).toBe(before);
    expect(d.store.getState().meta).toEqual(metaBefore);
    expect(ids(await d.db.db.notes.toArray()).sort()).toEqual(ids(before).sort());
    expect((await d.db.kvGet<{ hash: string }>('vocabMeta', { hash: '' })).hash).toBe(metaBefore!.hash);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);
    const p = d.store.getState().pendingImport;
    expect(p?.vocab.hash).toBe(out.vocab.hash);
    expect(p?.prevCount).toBe(9);
    expect(p?.reasons).toEqual(out.reasons);
    expect((await d.db.kvGet<{ vocab: VocabFile } | null>('pendingImport', null))?.vocab.hash).toBe(out.vocab.hash);
  });
});

describe('rejectPendingImport', () => {
  it('the same file is not held again; a changed file is', async () => {
    const d = await withList();
    const first = await d.sources.importBytes(bytes(BROKEN), src({ modified: T0 + 60000 }));
    expect(d.store.getState().pendingImport).toBeTruthy();

    await d.sources.rejectPendingImport();
    expect(d.store.getState().pendingImport).toBeUndefined();
    expect(await d.db.kvGet('pendingImport', null)).toBeNull();
    expect(await d.sources.wasRejected(first.vocab)).toBe(true);

    // The folder watcher reads the same file again (same content, so the same vocab hash).
    const again = await d.sources.importBytes(bytes(BROKEN), src({ modified: T0 + 120000 }));
    expect(again.applied).toBe(false);
    expect(again.vocab.hash).toBe(first.vocab.hash);
    expect(d.store.getState().pendingImport).toBeUndefined();
    expect(await d.db.kvGet('pendingImport', null)).toBeNull();
    expect(ids(d.store.getState().notes)).toEqual(ids(fakeVocab(L1, src(), 0, '', {}).notes));
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);

    // Hugo edits the file again, still without the second sheet: a new question.
    const changed: Book = { HSK五级: [...SHEET_A, ['电脑', 'diannao']] };
    const third = await d.sources.importBytes(bytes(changed), src({ modified: T0 + 180000 }));
    expect(third.applied).toBe(false);
    expect(third.vocab.hash).not.toBe(first.vocab.hash);
    expect(await d.sources.wasRejected(third.vocab)).toBe(false);
    expect(d.store.getState().pendingImport?.vocab.hash).toBe(third.vocab.hash);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);
  });
});

describe('acceptPendingImport', () => {
  it('recomputes renames and seeds against the list sync put in meanwhile, then applies', async () => {
    const d = await withList();
    const held = await d.sources.importBytes(bytes(BROKEN), src({ modified: T0 + 60000 }));
    expect(held.applied).toBe(false);
    // Against L1 nothing was renamed.
    expect(held.renames).toBeUndefined();
    expect(d.store.getState().pendingImport?.vocab.aliases).toBeUndefined();

    // Meanwhile sync brings another device's list: 朋友 there has the pinyin "pengyuo" (same row) and a seed.
    const SEED = T0 - 86400000;
    const synced = fakeVocab(
      { HSK五级: SHEET_A.map((r) => (r[0] === '朋友' ? (['朋友', 'pengyuo', GREEN] as Row) : r)), HSK六级: SHEET_B },
      src({ modified: T0 + 30000, qxh: 'other' }),
      T0 + 30000,
      'other-device',
      {},
    );
    synced.seeds['v:朋友|pengyuo'] = SEED;
    await d.store.setVocab(synced, true);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);
    expect(d.store.getState().pendingImport).toBeTruthy();

    await d.sources.acceptPendingImport();

    const s = d.store.getState();
    expect(ids(s.notes)).toEqual(ids(held.vocab.notes));
    // The rename between the synced list and the held one is found now, and the seed follows the word.
    expect(s.meta?.aliases?.['v:朋友|pengyuo']).toBe('v:朋友|pengyou');
    expect(s.meta?.seeds['v:朋友|pengyou']).toBe(SEED);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(true);
    expect(s.pendingImport).toBeUndefined();
    expect(await d.db.kvGet('pendingImport', null)).toBeNull();
  });

  it('does nothing when nothing is held', async () => {
    const d = await withList();
    const meta = d.store.getState().meta;
    await d.sources.acceptPendingImport();
    expect(d.store.getState().meta).toBe(meta);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);
  });
});

describe('importBytes', () => {
  it('two imports started together run one after the other; the second is compared with the first', async () => {
    const d = await withList();
    h.log = [];
    h.calls = 0;
    // First: 朋友's pinyin fixed in Excel (a rename). Second: the same plus a new word.
    const L2: Book = { HSK五级: SHEET_A.map((r) => (r[0] === '朋友' ? (['朋友', 'pengyou2'] as Row) : r)), HSK六级: SHEET_B };
    const L3: Book = { HSK五级: [...L2.HSK五级, ['电脑', 'diannao']], HSK六级: SHEET_B };
    let open!: () => void;
    h.gate = new Promise<void>((r) => (open = r));

    const p1 = d.sources.importBytes(bytes(L2), src({ modified: T0 + 60000 }));
    const p2 = d.sources.importBytes(bytes(L3), src({ modified: T0 + 120000 }));
    await new Promise((r) => setTimeout(r, 20));
    // The second has not reached the worker while the first is still in it.
    expect(h.log).toEqual(['start 1']);
    open();
    const [o1, o2] = await Promise.all([p1, p2]);

    expect(h.log).toEqual(['start 1', 'end 1', 'start 2', 'end 2']);
    expect(o1.applied).toBe(true);
    expect(o1.renames).toEqual({ 'v:朋友|pengyou': 'v:朋友|pengyou2' });
    expect(o2.applied).toBe(true);
    // Compared with L2 (the first's result), not L1: no rename again.
    expect(o2.renames).toBeUndefined();
    const s = d.store.getState();
    expect(ids(s.notes)).toContain('v:电脑|diannao');
    expect(ids(s.notes)).toContain('v:朋友|pengyou2');
    expect(s.meta?.aliases).toEqual({ 'v:朋友|pengyou': 'v:朋友|pengyou2' });
    expect(s.meta?.hash).toBe(o2.vocab.hash);
  });

  it('a failing import does not block the next one', async () => {
    const d = await withList();
    await expect(d.sources.importBytes(new TextEncoder().encode('not json').buffer as ArrayBuffer, src())).rejects.toThrow();
    const L2: Book = { HSK五级: [...SHEET_A, ['电脑', 'diannao']], HSK六级: SHEET_B };
    const out = await d.sources.importBytes(bytes(L2), src({ modified: T0 + 60000 }));
    expect(out.applied).toBe(true);
    expect(ids(d.store.getState().notes)).toContain('v:电脑|diannao');
  });
});

describe('isOlderThanList', () => {
  it('compares the workbook version with the one the list came from', async () => {
    const d = await device();
    // No list yet.
    expect(d.sources.isOlderThanList(src({ modified: T0 - 1, qxh: 'a' }))).toBe(false);
    await d.sources.importBytes(bytes(L1), src({ qxh: 'cur' }));
    expect(d.store.getState().meta?.source.qxh).toBe('cur');

    expect(d.sources.isOlderThanList(src({ modified: T0 - 1000, qxh: 'old' }))).toBe(true);
    expect(d.sources.isOlderThanList(src({ modified: T0 - 1000 }))).toBe(true);
    // Same content, whatever its time says.
    expect(d.sources.isOlderThanList(src({ modified: T0 - 1000, qxh: 'cur' }))).toBe(false);
    expect(d.sources.isOlderThanList(src({ modified: T0, qxh: 'old' }))).toBe(false);
    expect(d.sources.isOlderThanList(src({ modified: T0 + 1000, qxh: 'new' }))).toBe(false);
    // Missing time on the version offered.
    expect(d.sources.isOlderThanList(src({ modified: 0, qxh: 'old' }))).toBe(false);
  });

  it('is false when the current list has no time', async () => {
    const d = await device();
    await d.sources.importBytes(bytes(L1), src({ modified: 0, qxh: 'cur' }));
    expect(d.sources.isOlderThanList(src({ modified: T0 - 1000, qxh: 'old' }))).toBe(false);
  });
});
