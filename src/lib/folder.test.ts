// The PC copy without Microsoft (folder.ts, plan 2026-11-14-safety-tests WP3): the linked OneDrive folder is an
// in-memory File System Access folder (fakefs.ts). The workbook is a stand-in (JSON rows [hanzi, colour] on sheet
// HSK五级) read by an inline import and patched by an inline patcher, like writeback.test.ts; the real xlsx patcher has
// its own tests. Every test checks that only "<stem> (app).xlsx" is written and the original's bytes stay as Excel saved
// them. Timers are fake so the copy writes planned by folder.ts run only when a test advances them.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { ImportRequest } from './import';
import type { Note, VocabFile } from './types';
import type { PatchRequest, PatchResult } from './xlsx/patch';
import { FakeDir } from './fakefs';

type Rows = [string, string | null][];

const h = vi.hoisted(() => ({
  patches: 0,
  /** The patcher says the row no longer holds its word. */
  changed: false,
  imports: 0,
  /** Folder handle served from kv (functions can't be stored in IndexedDB). */
  dir: null as unknown,
}));

// The worker, inline: JSON rows [hanzi, colour] on sheet HSK五级.
vi.mock('./import', () => ({
  importWorkbook: async (req: Omit<ImportRequest, 'dictUrl'>) => {
    h.imports++;
    const rows = JSON.parse(new TextDecoder().decode(new Uint8Array(req.bytes))) as Rows;
    return fakeVocab(rows, req.source, req.now, req.device);
  },
}));
// The patch worker, inline: sets the colours of the JSON rows, checks the word like the real patcher.
vi.mock('./xlsx/patchClient', () => ({
  patchInWorker: async (req: PatchRequest): Promise<PatchResult> => {
    // This test's copy of the module (vi.resetModules gives every test its own).
    const { WorkbookChangedError } = await import('./xlsx/patch');
    h.patches++;
    const rows = JSON.parse(new TextDecoder().decode(req.bytes)) as Rows;
    let done = 0;
    for (const f of req.rows) {
      const i = f.row - 2;
      if (h.changed || rows[i]?.[0] !== f.hanzi) throw new WorkbookChangedError(f.sheet, f.row);
      rows[i][1] = f.fill;
      done++;
    }
    return { bytes: wb(rows), rows: done, cells: done * 4, xfsAdded: 0, fillsAdded: 0, skipped: 0 };
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

function fakeVocab(rows: Rows, source: VocabFile['source'], now: number, device = ''): VocabFile {
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
const COPY = 'Hugo_chinese_vocab (app).xlsx';
const T0 = Date.UTC(2026, 10, 14, 9);
const ROWS: Rows = [
  ['学习', GREEN],
  ['朋友', null],
  ['告诉', YELLOW],
  ['工作', null],
];
const id = (hz: string) => `v:${hz}|w${ROWS.findIndex((r) => r[0] === hz)}`;
function wb(rows: Rows): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}
const rowsOf = (b: Uint8Array | undefined) => JSON.parse(new TextDecoder().decode(b)) as Rows;
const colourIn = (b: Uint8Array | undefined, hz: string) => rowsOf(b).find((r) => r[0] === hz)![1];

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

let dir: FakeDir;
/** The original as Excel last saved it (undefined once deleted): the app never changes it. */
let excel: Uint8Array | undefined;

/** Excel (or OneDrive's client) saves the original. */
function saveExcel(rows: Rows, modified = Date.now()) {
  excel = wb(rows);
  dir.put(NAME, excel, modified);
}

// Node's setImmediate (not in the DOM types; not faked): one task later, after fake-indexeddb's work.
const nextTask = () => new Promise<void>((r) => (globalThis as unknown as { setImmediate(f: () => void): void }).setImmediate(r));

/** Lets the work started without await (checkFolder from writeCopy, planned writes) run. setImmediate is not faked. */
async function until(cond: () => boolean, tries = 500) {
  for (let i = 0; i < tries && !cond(); i++) await nextTask();
  expect(cond()).toBe(true);
}
async function settle(n = 200) {
  for (let i = 0; i < n; i++) await nextTask();
}

async function dev() {
  vi.resetModules();
  // doMock after the reset: a fresh db module (and database) per test.
  vi.doMock('./db', async (importOriginal) => {
    const m = await importOriginal<typeof import('./db')>();
    return { ...m, kvGet: <T,>(k: string, f: T) => (k === 'folderHandle' ? Promise.resolve((h.dir ?? f) as T) : m.kvGet(k, f)) };
  });
  Dexie.dependencies.indexedDB = new IDBFactory();
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const folder = await import('./folder');
  const db = await import('./db');
  await store.init();
  const messages: string[] = [];
  folder.onFolderMessage((m) => messages.push(m));
  return { store, folder, db, messages };
}
type Dev = Awaited<ReturnType<typeof dev>>;

/** A device with the folder linked: the workbook read, and the copy its import plans written. */
async function linked(): Promise<Dev> {
  const p = await dev();
  h.dir = dir;
  await p.folder.checkFolder(true);
  expect(h.imports).toBe(1);
  vi.advanceTimersByTime(1000);
  // `written` is set once the copy's signature is saved and the writer is free again.
  await until(() => !!p.store.getState().folder.written);
  expect(dir.written).toEqual([COPY]);
  vi.advanceTimersByTime(1000);
  return p;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'], now: T0 });
  vi.stubGlobal('localStorage', new MemStorage());
  h.patches = 0;
  h.changed = false;
  h.imports = 0;
  h.dir = null;
  dir = new FakeDir();
  // Saved by Excel an hour ago.
  saveExcel(ROWS, T0 - 3600000);
});

afterEach(async () => {
  // Work a test started without await ends here, not in the next test.
  await settle();
  // Only the copy was ever opened for writing; the original holds what Excel saved.
  expect(dir.opened.filter((n) => n !== COPY)).toEqual([]);
  expect(dir.written.filter((n) => n !== COPY)).toEqual([]);
  expect(dir.bytes(NAME)).toEqual(excel);
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('the "(app)" copy next to the workbook', () => {
  it('linking writes the copy, the original bytes as they are while no status differs from Excel', async () => {
    await linked();
    expect(dir.written).toEqual([COPY]);
    expect(dir.bytes(COPY)).toEqual(excel);
    expect(h.patches).toBe(0);
  });

  it('signed in to Microsoft with the workbook linked there: writes nothing; signed out again: writes', async () => {
    const p = await dev();
    p.store.setMs({ state: 'ok', account: 'a@b.c' });
    await p.db.kvSet('odWorkbook', { drive: 'd1', item: 'i1', name: NAME });
    h.dir = dir;
    await p.folder.checkFolder(true);
    vi.advanceTimersByTime(1000);
    await settle();
    vi.advanceTimersByTime(1000);
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.folder.writeCopy(true);
    expect(dir.opened).toEqual([]);
    expect(h.patches).toBe(0);
    expect(dir.files.has(COPY)).toBe(false);
    // Signed out: the copy is the way statuses reach Excel again.
    p.store.setMs({ state: 'off' }, true);
    await p.folder.writeCopy();
    expect(dir.written).toEqual([COPY]);
    expect(colourIn(dir.bytes(COPY), '朋友')).toBe(GREEN);
  });

  it('writes a changed status into the copy only, once; force rewrites; a deleted copy is written again', async () => {
    const p = await linked();
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(1); // nothing changed
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(2);
    const copy = dir.bytes(COPY);
    expect(colourIn(copy, '朋友')).toBe(GREEN);
    expect(rowsOf(copy).filter(([hz]) => hz !== '朋友')).toEqual(ROWS.filter(([hz]) => hz !== '朋友'));
    expect(p.store.getState().folder).toMatchObject({ written: Date.now(), writeError: undefined });
    // Same file, same statuses: no second write.
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(2);
    expect(h.patches).toBe(1);
    await p.folder.writeCopy(true);
    expect(dir.written).toHaveLength(3);
    expect(dir.bytes(COPY)).toEqual(copy);
    dir.files.delete(COPY);
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(4);
    expect(dir.bytes(COPY)).toEqual(copy);
  });

  it('the original changed since the last import: no copy, it is read first, then the copy follows the new file', async () => {
    const p = await linked();
    vi.advanceTimersByTime(60000);
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    vi.advanceTimersByTime(60000);
    saveExcel([...ROWS, ['新', null]]);
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(1);
    expect(h.patches).toBe(0);
    // The read ends with the folder checked (after it planned the copy).
    await until(() => p.store.getState().folder.checked === Date.now());
    expect(h.imports).toBe(2);
    expect(p.store.getState().meta!.source.modified).toBe(Date.now());
    expect(p.store.getState().notes.map((n) => n.hanzi)).toContain('新');
    expect(p.messages).toEqual([expect.stringMatching(/^Words updated from Excel/)]);
    // The import plans the copy.
    vi.advanceTimersByTime(1000);
    await until(() => p.store.getState().folder.written === Date.now());
    expect(dir.written).toHaveLength(2);
    const copy = rowsOf(dir.bytes(COPY));
    expect(copy).toHaveLength(5);
    expect(colourIn(dir.bytes(COPY), '朋友')).toBe(GREEN);
    expect(colourIn(dir.bytes(COPY), '新')).toBeNull();
  });

  it('the same content saved again (other times, same hash): copied without a re-import', async () => {
    const p = await linked();
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    vi.advanceTimersByTime(60000);
    saveExcel(ROWS);
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(2);
    expect(h.imports).toBe(1);
    expect(colourIn(dir.bytes(COPY), '朋友')).toBe(GREEN);
  });

  it('a row that no longer holds its word: no copy; one re-read, then an error naming the row', async () => {
    const p = await linked();
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    const before = dir.bytes(COPY);
    h.changed = true;
    await p.folder.writeCopy();
    expect(h.patches).toBe(1);
    expect(p.store.getState().folder.writeError).toBeUndefined();
    // The forced re-read, done once the folder is checked (after it planned the copy).
    await until(() => p.store.getState().folder.checked === Date.now());
    expect(h.imports).toBe(2);
    expect(p.messages).toEqual([]); // the same file: quiet
    // Its planned copy fails the same way: now the error.
    vi.advanceTimersByTime(1000);
    await until(() => !!p.store.getState().folder.writeError);
    expect(h.patches).toBe(2);
    expect(p.store.getState().folder.writeError).toMatch(/^Hugo_chinese_vocab \(app\)\.xlsx was not written: row 3 of HSK五级 does not hold the word/);
    expect(dir.written).toHaveLength(1);
    expect(dir.opened).toHaveLength(1);
    expect(dir.bytes(COPY)).toEqual(before);
    // No re-read loop.
    await p.folder.writeCopy();
    await settle();
    expect(h.imports).toBe(2);
    expect(dir.written).toHaveLength(1);
  });

  it('the copy is open in Excel: the writable is aborted, the message says to close it; written once it is closed', async () => {
    const p = await linked();
    const before = dir.bytes(COPY);
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    dir.failWrite = 'NoModificationAllowedError';
    await p.folder.writeCopy();
    expect(dir.aborted).toBe(1);
    expect(dir.written).toHaveLength(1);
    expect(dir.bytes(COPY)).toEqual(before);
    expect(p.store.getState().folder.writeError).toBe(`${COPY} is open in Excel. Close it and the app updates it on the next change.`);
    // Closed in Excel: the next run writes it (the failed write saved no signature).
    dir.failWrite = null;
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(2);
    expect(colourIn(dir.bytes(COPY), '朋友')).toBe(GREEN);
    expect(p.store.getState().folder.writeError).toBeUndefined();
  });

  it('another write error: aborted, reported with its message', async () => {
    const p = await linked();
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    dir.failWrite = 'QuotaExceededError';
    await p.folder.writeCopy();
    expect(dir.aborted).toBe(1);
    expect(p.store.getState().folder.writeError).toMatch(/^Could not write Hugo_chinese_vocab \(app\)\.xlsx: cannot write/);
  });

  it('no permission: writes nothing', async () => {
    const p = await linked();
    await p.store.setNoteStatus(id('工作'), 'st:notknown');
    dir.permission = 'prompt';
    await p.folder.writeCopy(true);
    expect(dir.written).toHaveLength(1);
    expect(h.patches).toBe(0);
    dir.permission = 'granted';
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(2);
    expect(colourIn(dir.bytes(COPY), '工作')).toBe(YELLOW);
  });
});

describe('checkFolder', () => {
  it('permission lost → "permission"; allowed again → read', async () => {
    const p = await linked();
    dir.permission = 'prompt';
    await p.folder.checkFolder();
    expect(p.store.getState().folder).toMatchObject({ state: 'permission', name: 'OneDrive' });
    dir.grant = 'denied';
    await p.folder.allowFolder();
    expect(p.store.getState().folder.state).toBe('permission');
    dir.grant = 'granted';
    await p.folder.allowFolder();
    expect(p.store.getState().folder).toMatchObject({ state: 'ok', message: undefined });
  });

  it('the file is gone → "missing", nothing read or written', async () => {
    const p = await linked();
    dir.files.delete(NAME);
    excel = undefined;
    await p.folder.checkFolder();
    expect(p.store.getState().folder).toMatchObject({ state: 'missing', message: `${NAME} is no longer in “OneDrive”.` });
    expect(h.imports).toBe(1);
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.folder.writeCopy();
    expect(dir.written).toHaveLength(1);
  });

  it('an unchanged file is not read again; the same content with other times neither; a changed file is', async () => {
    const p = await linked();
    const checked = p.store.getState().folder.checked;
    vi.advanceTimersByTime(5 * 60000);
    await p.folder.checkFolder();
    expect(h.imports).toBe(1);
    expect(p.store.getState().folder).toMatchObject({ state: 'ok' });
    expect(p.store.getState().folder.checked).toBeGreaterThan(checked!);
    saveExcel(ROWS); // saved again, same bytes
    await p.folder.checkFolder();
    expect(h.imports).toBe(1);
    saveExcel([...ROWS, ['新', null]]);
    await p.folder.checkFolder();
    expect(h.imports).toBe(2);
    expect(p.messages).toHaveLength(1);
    await p.folder.checkFolder();
    expect(h.imports).toBe(2);
  });

  it('a folder read error → "error"', async () => {
    const p = await linked();
    dir.queryPermission = async () => {
      throw new Error('disk gone');
    };
    await p.folder.checkFolder();
    expect(p.store.getState().folder).toMatchObject({ state: 'error', message: 'Could not read the folder: disk gone' });
  });
});
