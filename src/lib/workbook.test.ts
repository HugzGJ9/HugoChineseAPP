// Reading the workbook from OneDrive (Microsoft Graph stubbed), content identity across the two readers, the
// "Excel changed" list, and the import queue.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { DriveItem } from './ms/graph';
import type { ImportRequest } from './import';
import type { Note, VocabFile } from './types';
import { quickXorHash } from './ms/qxh';

const h = vi.hoisted(() => {
  class GraphError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  }
  type Item = { meta: Record<string, unknown>; bytes: Uint8Array };
  return {
    GraphError,
    items: new Map<string, Item>(),
    calls: [] as string[],
    /** Runs inside the next syncNow(). */
    onSync: null as null | (() => Promise<void>),
    syncs: 0,
    syncLinked: false,
    /** Holds an import in the worker until released. */
    gate: null as null | Promise<void>,
    imports: [] as string[],
    /** Folder handle served from kv (functions can't be stored in IndexedDB). */
    dir: null as unknown,
  };
});

vi.mock('./ms/graph', () => ({
  GraphError: h.GraphError,
  getItem: async (drive: string, id: string) => {
    h.calls.push(`get ${id}`);
    const it = h.items.get(id);
    if (!it || it.meta.parentReference === undefined || (it.meta.parentReference as { driveId: string }).driveId !== drive) {
      throw new h.GraphError(404, 'itemNotFound', 'Item not found');
    }
    return { ...it.meta };
  },
  findByName: async (name: string) => {
    h.calls.push(`find ${name}`);
    // Like Graph search: anything containing the words; the reader filters.
    const stem = name.replace(/\.xlsx$/i, '').toLowerCase();
    return [...h.items.values()].filter((i) => String(i.meta.name).toLowerCase().includes(stem)).map((i) => ({ ...i.meta }));
  },
  download: async (item: { id: string }) => {
    h.calls.push(`download ${item.id}`);
    return h.items.get(item.id)!.bytes.slice();
  },
}));
vi.mock('./ms/auth', () => ({ msConfigured: () => true }));
vi.mock('./sync', () => ({
  getLink: async () => (h.syncLinked ? { owner: 'me', name: 'data', token: 'tok' } : null),
  syncNow: async () => {
    h.syncs++;
    await h.onSync?.();
  },
}));
// The worker, run inline: a fake workbook is JSON rows [hanzi, colour] on sheet HSK五级.
vi.mock('./import', () => ({
  importWorkbook: async (req: Omit<ImportRequest, 'dictUrl'>) => {
    const rows = JSON.parse(new TextDecoder().decode(new Uint8Array(req.bytes))) as [string, string | null][];
    h.imports.push(`start ${req.source.qxh}`);
    if (h.gate) await h.gate;
    h.imports.push(`end ${req.source.qxh}`);
    return fakeVocab(rows, req.source, req.now, req.device);
  },
}));

function fakeNote(hanzi: string, i: number, colour: string | null): Note {
  return {
    id: `v:${hanzi}|w${i}`,
    kind: 'vocab',
    hanzi,
    alts: [],
    pinyin: 'cí',
    pinyinNum: 'ci2',
    en: `word ${i}`,
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK五级', row: i + 2, ...(colour ? { colour } : {}) }],
    order: 100000 + i,
    studied: false,
    ...(colour ? { colour } : {}),
    examples: [],
  };
}

function fakeVocab(rows: [string, string | null][], source: VocabFile['source'], now: number, device = ''): VocabFile {
  const notes = rows.map(([hz, c], i) => fakeNote(hz, i, c));
  return {
    version: 1,
    importedAt: now,
    device,
    source,
    hash: `h:${notes.map((n) => n.hanzi).join(',')}`,
    notes,
    issues: [],
    seeds: {},
    report: [{ name: 'HSK五级', cols: { hanzi: 'B', first: 'A', last: 'D', status: ['A', 'B'] }, kind: 'vocab', rows: notes.length, notes: notes.length, studied: 0, colours: {} }],
  };
}

const GREEN = 'A9D18E';
const YELLOW = 'FFFF00';
const NAME = 'Hugo_chinese_vocab.xlsx';
const T0 = Date.UTC(2026, 10, 8, 9);
const ROWS: [string, string | null][] = [
  ['学习', GREEN],
  ['朋友', null],
  ['告诉', YELLOW],
];
const wb = (rows: [string, string | null][]) => new TextEncoder().encode(JSON.stringify(rows));
const qxh = (rows: [string, string | null][]) => quickXorHash(wb(rows));

/** Put a version of a file in the fake drive ("saved by Excel" at `at`). */
function put(id: string, rows: [string, string | null][], at: number, opts: { name?: string; drive?: string; noHash?: boolean } = {}) {
  const bytes = wb(rows);
  const prev = h.items.get(id);
  const n = prev ? Number(String(prev.meta.cTag).slice(1)) + 1 : 1;
  h.items.set(id, {
    bytes,
    meta: {
      id,
      name: opts.name ?? NAME,
      eTag: `e${n}`,
      cTag: `c${n}`,
      size: bytes.length,
      lastModifiedDateTime: new Date(at).toISOString(),
      parentReference: { driveId: opts.drive ?? 'd1', id: 'root', path: '/drive/root:/Chinese' },
      file: opts.noHash ? {} : { hashes: { quickXorHash: quickXorHash(bytes) } },
    } satisfies DriveItem as unknown as Record<string, unknown>,
  });
}

async function device(idb = new IDBFactory()) {
  vi.resetModules();
  // A fresh database module per device, serving the folder handle (functions can't be stored in IndexedDB).
  vi.doMock('./db', async (importOriginal) => {
    const m = await importOriginal<typeof import('./db')>();
    return { ...m, kvGet: <T,>(k: string, f: T) => (k === 'folderHandle' ? Promise.resolve((h.dir ?? f) as T) : m.kvGet(k, f)) };
  });
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const sources = await import('./sources');
  const workbook = await import('./workbook');
  const folder = await import('./folder');
  const db = await import('./db');
  await store.init();
  const toasts: string[] = [];
  workbook.onWorkbookMessage((m) => toasts.push(m));
  folder.onFolderMessage((m) => toasts.push(m));
  store.setMs({ state: 'ok', account: 'hugo' });
  return { store, sources, workbook, folder, db, toasts };
}
type Device = Awaited<ReturnType<typeof device>>;

/** A list as an earlier import left it. */
async function seedList(d: Device, rows: [string, string | null][], source: Partial<VocabFile['source']> = {}) {
  const src = { name: NAME, modified: T0, size: 10, ...source };
  await d.store.setVocab(fakeVocab(rows, src, T0), true);
}

const linkOf = (d: Device) => d.db.kvGet<{ item: string } | null>('odWorkbook', null);

beforeEach(() => {
  h.items.clear();
  h.calls = [];
  h.onSync = null;
  h.syncs = 0;
  h.syncLinked = false;
  h.gate = null;
  h.imports = [];
  h.dir = null;
  vi.useFakeTimers({ toFake: ['Date'], now: T0 + 3600000 });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('linking the workbook', () => {
  it('uses the item the shared list came from, without searching', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    await seedList(d, ROWS, { qxh: qxh(ROWS), drive: 'd1', item: 'w1' });
    await d.workbook.checkWorkbook();
    expect((await linkOf(d))?.item).toBe('w1');
    expect(h.calls).toEqual(['get w1']);
    expect(d.store.getState().excel).toMatchObject({ state: 'ok', name: NAME, path: '/drive/root:/Chinese' });
  });

  it('links the one file with the workbook name, ignoring the app copy and conflict copies', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    put('copy', ROWS, T0, { name: 'Hugo_chinese_vocab (app).xlsx' });
    put('conflict', ROWS, T0, { name: 'Hugo_chinese_vocab-DESKTOP-1.xlsx' });
    await d.workbook.checkWorkbook();
    expect((await linkOf(d))?.item).toBe('w1');
    expect(d.store.getState().notes.map((n) => n.hanzi)).toEqual(['学习', '朋友', '告诉']);
  });

  it('does not pick between several files with the name', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    put('w2', ROWS, T0 + 1000, { name: 'hugo_chinese_vocab.xlsx' });
    await d.workbook.checkWorkbook();
    expect(await linkOf(d)).toBeNull();
    expect(h.calls.some((c) => c.startsWith('download'))).toBe(false);
    expect(d.store.getState().excel.message).toMatch(/2 files/);
    expect((await d.workbook.findWorkbooks()).map((i) => i.id)).toEqual(['w2', 'w1']);
    await d.workbook.linkWorkbook((await d.workbook.findWorkbooks())[1]);
    expect((await linkOf(d))?.item).toBe('w1');
    expect(d.store.getState().meta?.source).toMatchObject({ item: 'w1', drive: 'd1', qxh: qxh(ROWS) });
  });

  it('reports a deleted workbook as missing, and links it again by name', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    await d.workbook.checkWorkbook();
    h.items.delete('w1');
    await d.workbook.checkWorkbook();
    expect(d.store.getState().excel.state).toBe('missing');
    expect(await linkOf(d)).not.toBeNull(); // kept, in case it comes back
    put('w9', ROWS, T0 + 5000);
    await d.workbook.checkWorkbook();
    expect((await linkOf(d))?.item).toBe('w9');
    expect(d.store.getState().excel.state).toBe('ok');
  });
});

describe('checking the workbook', () => {
  it('imports new content with its OneDrive identity, shows a toast and the Excel changes', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    await d.workbook.checkWorkbook();
    expect(d.store.getState().excelChanges).toBeUndefined(); // the first list changes nothing
    expect(d.toasts).toEqual([]);
    const next: [string, string | null][] = [['学习', YELLOW], ['朋友', null], ['告诉', YELLOW]];
    put('w1', next, T0 + 60000);
    await d.workbook.checkWorkbook();
    const src = d.store.getState().meta!.source;
    expect(src).toEqual({ name: NAME, modified: T0 + 60000, size: wb(next).length, qxh: qxh(next), drive: 'd1', item: 'w1' });
    expect(d.store.getState().excelChanges).toEqual([{ note: 'v:学习|w0', hanzi: '学习', from: 'mastered', to: 'notknown' }]);
    expect(d.toasts).toEqual(['Words updated from Excel: 3 notes imported, 0 already studied, 1 status changed']);
    expect(await d.db.kvGet('vocabDirty', false)).toBe(true);
  });

  it('does not download content the list already has', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    await seedList(d, ROWS, { qxh: qxh(ROWS), drive: 'd1', item: 'w1' });
    await d.workbook.checkWorkbook();
    await d.workbook.checkWorkbook();
    expect(h.calls).toEqual(['get w1', 'get w1']);
    expect(h.imports).toEqual([]);
  });

  it('skips a version older than the list unless forced', async () => {
    const d = await device();
    const newer: [string, string | null][] = [['学习', null]];
    await seedList(d, newer, { modified: T0 + 60000, qxh: qxh(newer) });
    put('w1', ROWS, T0);
    await d.workbook.checkWorkbook();
    expect(h.calls.some((c) => c.startsWith('download'))).toBe(false);
    expect(d.store.getState().meta!.source.qxh).toBe(qxh(newer));
    await d.workbook.checkWorkbook(true);
    expect(d.store.getState().meta!.source.qxh).toBe(qxh(ROWS));
  });

  it('sends nothing offline or signed out', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    vi.stubGlobal('navigator', { onLine: false });
    await d.workbook.checkWorkbook(true);
    vi.unstubAllGlobals();
    d.store.setMs({ state: 'reconnect' });
    await d.workbook.checkWorkbook(true);
    expect(h.calls).toEqual([]);
  });

  it('takes the shared list first when sync has not run since the save', async () => {
    const d = await device();
    put('w1', ROWS, T0 + 60000);
    // Linked, before startSync has set the sync state.
    h.syncLinked = true;
    // The other device imported this version already.
    h.onSync = () => d.store.setVocab(fakeVocab(ROWS, { name: NAME, modified: T0 + 60000, size: 1, qxh: qxh(ROWS), item: 'w1' }, T0), true).then(() => undefined);
    await d.workbook.checkWorkbook();
    expect(h.syncs).toBe(1);
    expect(h.calls.some((c) => c.startsWith('download'))).toBe(false);
    expect(h.imports).toEqual([]);
  });

  it('reads cached bytes, and the cache identifies content when the metadata has no hash', async () => {
    const d = await device();
    put('w1', ROWS, T0, { noHash: true });
    await d.workbook.checkWorkbook();
    expect(h.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect(d.store.getState().meta!.source.qxh).toBe(qxh(ROWS));
    await d.workbook.checkWorkbook();
    await d.workbook.checkWorkbook(true); // Read now: imported again, from the cache
    expect(h.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect(h.imports).toHaveLength(4);
  });

  it('runs one check at a time', async () => {
    const d = await device();
    put('w1', ROWS, T0);
    await Promise.all([d.workbook.checkWorkbook(), d.workbook.checkWorkbook(), d.workbook.checkWorkbook()]);
    expect(h.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
    expect(h.imports).toHaveLength(2);
  });
});

describe('importBytes', () => {
  it('marks the list dirty when only the workbook version changed', async () => {
    const d = await device();
    await d.sources.importBytes(wb(ROWS).slice().buffer, { name: NAME, modified: T0, size: 1, qxh: 'A' });
    await d.db.kvSet('vocabDirty', false);
    await d.sources.importBytes(wb(ROWS).slice().buffer, { name: NAME, modified: T0, size: 1, qxh: 'A' });
    expect(await d.db.kvGet('vocabDirty', false)).toBe(false);
    await d.sources.importBytes(wb(ROWS).slice().buffer, { name: NAME, modified: T0 + 1, size: 1, qxh: 'B' });
    expect(await d.db.kvGet('vocabDirty', false)).toBe(true);
  });

  it('fills in the content id of a file picked by hand', async () => {
    const d = await device();
    const o = await d.sources.importBytes(wb(ROWS).slice().buffer, { name: NAME, modified: T0, size: 1 });
    expect(o.vocab.source.qxh).toBe(qxh(ROWS));
  });

  it('runs imports one after the other', async () => {
    const d = await device();
    let release!: () => void;
    h.gate = new Promise((r) => (release = r));
    const a = d.sources.importBytes(wb(ROWS).slice().buffer, { name: NAME, modified: T0, size: 1, qxh: 'A' });
    const b = d.sources.importBytes(wb([['学习', null]]).slice().buffer, { name: NAME, modified: T0 + 1, size: 1, qxh: 'B' });
    await vi.waitFor(() => expect(h.imports).toEqual(['start A']));
    h.gate = null;
    release();
    await Promise.all([a, b]);
    expect(h.imports).toEqual(['start A', 'end A', 'start B', 'end B']);
    // B was compared with A's list: the colour change shows.
    expect(d.store.getState().excelChanges).toEqual([{ note: 'v:学习|w0', hanzi: '学习', from: 'mastered', to: 'new' }]);
  });
});

describe('setVocab reports changed statuses', () => {
  it('for a list from sync, none for the first list, and folds repeated changes', async () => {
    const d = await device();
    expect(await d.store.setVocab(fakeVocab(ROWS, { name: NAME, modified: T0, size: 1 }, T0), true)).toEqual([]);
    const v2 = fakeVocab([['学习', null], ['朋友', GREEN], ['告诉', YELLOW]], { name: NAME, modified: T0 + 1, size: 1 }, T0 + 1);
    const changes = await d.store.setVocab({ ...v2, colourSince: {} }, true);
    expect(changes).toEqual([
      { note: 'v:学习|w0', hanzi: '学习', from: 'mastered', to: 'new' },
      { note: 'v:朋友|w1', hanzi: '朋友', from: 'new', to: 'mastered' },
    ]);
    // 学习 back to green: it leaves the list; 朋友 keeps where it started.
    const v3 = fakeVocab([['学习', GREEN], ['朋友', YELLOW], ['告诉', YELLOW]], { name: NAME, modified: T0 + 2, size: 1 }, T0 + 2);
    await d.store.setVocab({ ...v3, colourSince: {} }, true);
    expect(d.store.getState().excelChanges).toEqual([{ note: 'v:朋友|w1', hanzi: '朋友', from: 'new', to: 'notknown' }]);
    d.store.clearExcelChanges();
    expect(d.store.getState().excelChanges).toBeUndefined();
  });
});

// ---------- the folder reader (PC) ----------

type FakeFile = { bytes: Uint8Array; modified: number };
function fakeDir(files: Map<string, FakeFile>) {
  return {
    name: 'OneDrive',
    queryPermission: async () => 'granted',
    requestPermission: async () => 'granted',
    getFileHandle: async (name: string, o?: { create?: boolean }) => {
      if (!files.has(name)) {
        if (!o?.create) throw new DOMException('not found', 'NotFoundError');
        files.set(name, { bytes: new Uint8Array(), modified: Date.now() });
      }
      return {
        getFile: async () => {
          const f = files.get(name)!;
          return new File([f.bytes.slice()], name, { lastModified: f.modified });
        },
        createWritable: async () => {
          let out = new Uint8Array();
          return {
            write: async (b: Uint8Array) => void (out = b.slice()),
            close: async () => void files.set(name, { bytes: out, modified: Date.now() }),
            abort: async () => undefined,
          };
        },
      };
    },
  };
}

describe('the folder and the Microsoft reader', () => {
  it('never re-import each other’s results', async () => {
    const d = await device();
    const files = new Map<string, FakeFile>([[NAME, { bytes: wb(ROWS), modified: T0 }]]);
    h.dir = fakeDir(files);
    // The cloud copy of the same save: same bytes, a later time.
    put('w1', ROWS, T0 + 5000);
    await d.workbook.checkWorkbook();
    expect(h.imports).toHaveLength(2);
    await d.folder.checkFolder();
    expect(h.imports).toHaveLength(2); // same content: not read again
    // The other way round: a local save read by the folder, then seen in the cloud.
    const next: [string, string | null][] = [['学习', YELLOW], ['朋友', null], ['告诉', YELLOW]];
    files.set(NAME, { bytes: wb(next), modified: T0 + 60000 });
    await d.folder.checkFolder();
    expect(h.imports).toHaveLength(4);
    // The folder knows the OneDrive item of the same workbook.
    expect(d.store.getState().meta!.source).toMatchObject({ qxh: qxh(next), item: 'w1', drive: 'd1', modified: T0 + 60000 });
    put('w1', next, T0 + 65000);
    await d.workbook.checkWorkbook();
    expect(h.imports).toHaveLength(4);
    expect(h.calls.filter((c) => c.startsWith('download'))).toHaveLength(1);
  });

  it('does not read a local file older than a list read through Microsoft', async () => {
    const d = await device();
    const newer: [string, string | null][] = [['学习', null]];
    await seedList(d, newer, { modified: T0 + 60000, qxh: qxh(newer), drive: 'd1', item: 'w1' });
    h.dir = fakeDir(new Map([[NAME, { bytes: wb(ROWS), modified: T0 }]]));
    await d.folder.checkFolder();
    expect(h.imports).toEqual([]);
    await d.folder.checkFolder(true);
    expect(h.imports).toHaveLength(2);
  });

  it('writes the copy when the list came from Microsoft (other times, same content)', async () => {
    const d = await device();
    const files = new Map<string, FakeFile>([[NAME, { bytes: wb(ROWS), modified: T0 }]]);
    h.dir = fakeDir(files);
    await seedList(d, ROWS, { modified: T0 + 5000, size: wb(ROWS).length, qxh: qxh(ROWS), drive: 'd1', item: 'w1' });
    await d.folder.writeCopy();
    const copy = files.get('Hugo_chinese_vocab (app).xlsx');
    expect(copy && new TextDecoder().decode(copy.bytes)).toBe(JSON.stringify(ROWS));
    expect(h.imports).toEqual([]);
  });
});
