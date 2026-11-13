// Writing statuses into the workbook in OneDrive (plan 2026-11-08 WP9): devices signed in to the fake Microsoft, the
// real Graph client, sync through the fake app folder. The workbook is a stand-in (JSON rows [hanzi, colour] on sheet
// HSK五级) read by an inline import and patched by an inline patcher; the real xlsx patcher has its own tests.
// Devices run one after the other, never one inside another (Node's global navigator.locks is shared).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { gzipSync, strToU8 } from 'fflate';
import type { ImportRequest } from './import';
import type { Note, VocabFile } from './types';
import type { PatchRequest, PatchResult } from './xlsx/patch';
import { FakeLocation, FakeMicrosoft, fakeSignIn, type FakeItem } from './ms/fake';
import { quickXorHash } from './ms/qxh';

type Rows = [string, string | null][];

const h = vi.hoisted(() => ({
  patches: 0,
  /** Rows (Excel row numbers) the patcher finds no place for. */
  skip: new Set<number>(),
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
vi.mock('./xlsx/patchClient', () => {
  return {
    patchInWorker: async (req: PatchRequest): Promise<PatchResult> => {
      // This device's copy of the module (every device has its own after vi.resetModules).
      const { WorkbookChangedError } = await import('./xlsx/patch');
      h.patches++;
      const rows = JSON.parse(new TextDecoder().decode(req.bytes)) as Rows;
      let done = 0;
      let skipped = 0;
      for (const f of req.rows) {
        const i = f.row - 2;
        if (!req.cols[f.sheet] || h.skip.has(f.row) || !rows[i]) {
          skipped++;
          continue;
        }
        if (h.changed || rows[i][0] !== f.hanzi) throw new WorkbookChangedError(f.sheet, f.row);
        rows[i][1] = f.fill;
        done++;
      }
      return { bytes: wb(rows), rows: done, cells: done * 4, xfsAdded: 0, fillsAdded: 0, skipped };
    },
  };
});

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
const T0 = Date.UTC(2026, 10, 9, 9);
const ROWS: Rows = [
  ['学习', GREEN],
  ['朋友', null],
  ['告诉', YELLOW],
  ['工作', null],
];
const id = (hz: string) => `v:${hz}|w${ROWS.findIndex((r) => r[0] === hz)}`;
const key = (hz: string) => `${id(hz)}@HSK五级#0`;
function wb(rows: Rows): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(rows));
}
const rowsOf = (it: FakeItem) => JSON.parse(new TextDecoder().decode(it.bytes)) as Rows;
const colourOf = (it: FakeItem, hz: string) => rowsOf(it).find((r) => r[0] === hz)![1];
const advance = (ms: number) => vi.setSystemTime(Date.now() + ms);

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

const START = `https://hugzgj9.github.io${import.meta.env.BASE_URL}`;
let ms: FakeMicrosoft;
let loc: FakeLocation;
/** Runs before the fake answers a request (to inject a race); return a Response to answer instead. */
let before: ((url: URL, init: RequestInit) => Response | void) | null;
/** Runs after the fake answered (to lose the answer). */
let after: ((url: URL, init: RequestInit) => void) | null;
let wbItem: FakeItem;
/** Devices of the running test (their planned runs are stopped after it). */
const devices: { workbook: { unlinkWorkbook(): Promise<void> } }[] = [];

const isWorkbookPut = (method: string, url: string) => method === 'PUT' && url.includes(`/items/${wbItem.id}/content`);
const workbookPuts = () => ms.requests.filter((r) => isWorkbookPut(r.method, r.url));

const routed = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const instead = before?.(url, init);
  if (instead) return instead;
  const res = await ms.fetch(input, init);
  after?.(url, init);
  return res;
};

async function dev(idb = new IDBFactory(), signIn = true) {
  vi.resetModules();
  vi.doMock('./db', async (importOriginal) => {
    const m = await importOriginal<typeof import('./db')>();
    return { ...m, kvGet: <T,>(k: string, f: T) => (k === 'folderHandle' ? Promise.resolve((h.dir ?? f) as T) : m.kvGet(k, f)) };
  });
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const sync = await import('./sync');
  const workbook = await import('./workbook');
  const intents = await import('./writeIntents');
  const db = await import('./db');
  const auth = await import('./ms/auth');
  await store.init();
  if (signIn) await fakeSignIn(ms, loc, auth);
  else await auth.loadMsState();
  const d = { store, sync, workbook, intents, db, auth, idb };
  devices.push(d);
  return d;
}
type Dev = Awaited<ReturnType<typeof dev>>;

/** A device that has read the workbook and confirmed writing into it. */
async function ready(d: Dev) {
  await d.workbook.checkWorkbook();
  await d.workbook.confirmFirstWrite();
  return d;
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  ms = new FakeMicrosoft('test-client');
  ms.redirectUri = START;
  loc = new FakeLocation(START);
  before = null;
  after = null;
  h.patches = 0;
  h.skip.clear();
  h.changed = false;
  h.imports = 0;
  h.dir = null;
  vi.stubEnv('VITE_MS_CLIENT_ID', 'test-client');
  vi.stubGlobal('fetch', routed);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', loc.history);
  vi.stubGlobal('localStorage', new MemStorage());
  // Saved by Excel an hour ago.
  wbItem = ms.addFile(NAME, wb(ROWS), T0 - 3600000);
});

afterEach(async () => {
  // Every write into the workbook was conditional.
  for (const r of workbookPuts()) expect(r.headers['if-match'], r.url).toBeTruthy();
  // Planned runs of these devices stop (unlinked devices write nothing).
  for (const d of devices.splice(0)) await d.workbook.unlinkWorkbook();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('writing statuses into the workbook', () => {
  it('asks once, backs up, writes the fill, and the list follows without counting it as an Excel edit', async () => {
    const p = await dev();
    await p.workbook.checkWorkbook();
    const mark = await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    expect(p.workbook.pendingFills()).toMatchObject([{ row: 3, hanzi: '朋友', fill: GREEN, status: 'mastered', t: mark.t }]);
    await p.workbook.writeBack();
    expect(p.store.getState().excel).toMatchObject({ waiting: 'confirm', pending: 1 });
    expect(workbookPuts()).toHaveLength(0);

    advance(1000);
    await p.workbook.confirmFirstWrite();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(rowsOf(wbItem).filter(([hz]) => hz !== '朋友')).toEqual(ROWS.filter(([hz]) => hz !== '朋友'));
    const s = p.store.getState();
    expect(s.meta!.source).toMatchObject({ qxh: quickXorHash(wbItem.bytes), item: wbItem.id, app: true, modified: wbItem.modified });
    expect(s.meta!.colourSince![key('朋友')]).toEqual(['mastered', mark.t]);
    expect(s.excelChanges).toBeUndefined();
    expect(p.workbook.pendingFills()).toEqual([]);
    expect(s.excel).toMatchObject({ pending: 0, written: Date.now(), waiting: undefined, writeError: undefined });
    expect(typeof s.excel.patchMs).toBe('number');
    // The original, backed up first.
    const backups = [...ms.items.values()].filter((x) => x.folder === 'Apps/Hugo Chinese/backups');
    expect(backups).toHaveLength(1);
    expect(new TextDecoder().decode(backups[0].bytes)).toBe(JSON.stringify(ROWS));
    // No sync: the intent is gone once the list holds the content.
    expect(await p.intents.liveIntents()).toEqual([]);
    // Nothing more to write: no request.
    const n = ms.requests.length;
    await p.workbook.writeBack();
    expect(ms.requests.length).toBe(n);
  });

  it('412: Excel saved another row meanwhile → both changes are in the file', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    let raced = false;
    before = (url, init) => {
      if (!raced && isWorkbookPut(init.method ?? 'GET', url.href)) {
        raced = true;
        const rows = rowsOf(wbItem);
        rows[3][1] = YELLOW; // 工作, coloured in Excel
        ms.excelSave(wbItem.id, wb(rows));
      }
    };
    await p.workbook.writeBack();
    // Excel's version is read; it was saved a moment ago, so the app waits for Excel to be done.
    expect(workbookPuts().map((r) => r.headers['if-match'])).toHaveLength(1);
    expect(p.store.getState().excel).toMatchObject({ waiting: 'quiet', waitUntil: wbItem.modified + 5 * 60000, pending: 1 });
    expect(p.store.getState().excelChanges).toEqual([{ note: id('工作'), hanzi: '工作', from: 'new', to: 'notknown' }]);
    expect(await p.intents.liveIntents()).toEqual([]); // the refused upload left no intent
    advance(5 * 60000);
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(colourOf(wbItem, '工作')).toBe(YELLOW);
    expect(workbookPuts()).toHaveLength(2);
  });

  it('never writes over an Excel edit newer than the status', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    advance(60000);
    const rows = rowsOf(wbItem);
    rows[1][1] = YELLOW;
    ms.excelSave(wbItem.id, wb(rows));
    advance(10 * 60000);
    await p.workbook.writeBack();
    expect(workbookPuts()).toHaveLength(0);
    expect(colourOf(wbItem, '朋友')).toBe(YELLOW);
    expect(p.workbook.pendingFills()).toEqual([]);
    expect(p.store.getState().excelChanges).toEqual([{ note: id('朋友'), hanzi: '朋友', from: 'mastered', to: 'notknown' }]);
  });

  it('waits while the workbook was just edited; "Write now" writes; automatic writing can be off', async () => {
    ms.excelSave(wbItem.id, wb(ROWS), T0 - 60000);
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(p.store.getState().excel).toMatchObject({ waiting: 'quiet', waitUntil: T0 + 4 * 60000 });
    expect(workbookPuts()).toHaveLength(0);
    p.workbook.setExcelWrite(false);
    advance(10 * 60000);
    await p.workbook.writeBack();
    expect(p.store.getState().excel.waiting).toBe('off');
    await p.workbook.writeBack({ force: true });
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(p.workbook.excelWriteOn()).toBe(false);
  });

  it('423: waits with a back-off, written after the unlock', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    ms.lock(wbItem.id);
    await p.workbook.writeBack();
    const ex = p.store.getState().excel;
    expect(ex).toMatchObject({ waiting: 'locked', pending: 1 });
    expect(ex.waitUntil).toBe(Date.now() + 2 * 60000);
    expect(await p.intents.liveIntents()).toEqual([]);
    // An automatic run before the back-off ends sends nothing.
    const n = ms.requests.length;
    await p.workbook.writeBack();
    expect(ms.requests.length).toBe(n);
    ms.unlock(wbItem.id);
    advance(2 * 60000 + 1);
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(p.store.getState().excel.waiting).toBeUndefined();
  });

  it('a held import: no write', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.store.setPendingImport({ vocab: fakeVocab([['学习', null]], { name: NAME, modified: T0, size: 1 }, T0), reasons: ['many words gone'], prevCount: 4 });
    await p.workbook.writeBack({ force: true });
    expect(p.store.getState().excel.waiting).toBe('held');
    expect(workbookPuts()).toHaveLength(0);
  });

  it('a row that no longer holds its word: one re-read, then an error, no upload', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    h.changed = true;
    const imports = h.imports;
    await p.workbook.writeBack();
    expect(h.patches).toBe(2);
    expect(h.imports).toBe(imports + 1);
    expect(p.store.getState().excel.writeError).toMatch(/row 3 of HSK五级 does not hold the word/);
    expect(workbookPuts()).toHaveLength(0);
  });

  it('rows the patcher cannot place are not retried until the statuses change', async () => {
    const p = await ready(await dev());
    h.skip.add(3); // 朋友
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(workbookPuts()).toHaveLength(0);
    expect(p.store.getState().excel).toMatchObject({ stuck: 1, pending: 1 });
    await p.workbook.writeBack();
    expect(h.patches).toBe(1);
    // Another status: written; the stuck row stays stuck, without a loop.
    await p.store.setNoteStatus(id('工作'), 'st:notknown');
    await p.workbook.writeBack();
    expect(h.patches).toBe(2);
    expect(colourOf(wbItem, '工作')).toBe(YELLOW);
    expect(colourOf(wbItem, '朋友')).toBeNull();
    expect(p.store.getState().excel).toMatchObject({ stuck: 1, pending: 1 });
    const n = ms.requests.length;
    await p.workbook.writeBack();
    expect(h.patches).toBe(2);
    expect(ms.requests.length).toBe(n);
  });

  it('backs up before the first write, then weekly, keeping the newest 4', async () => {
    const BK = 'Apps/Hugo Chinese/backups';
    for (let i = 0; i < 4; i++) ms.addFile(`${BK}/old ${i}.xlsx`, wb([]), T0 - (10 - i) * 86400000);
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    const names = () => [...ms.items.values()].filter((x) => x.folder === BK).map((x) => x.name).sort();
    expect(names()).toEqual(['Hugo_chinese_vocab 2026-11-09 090000.xlsx', 'old 1.xlsx', 'old 2.xlsx', 'old 3.xlsx']);
    advance(3600000);
    await p.store.setNoteStatus(id('工作'), 'st:notknown');
    await p.workbook.writeBack();
    expect(names()).toHaveLength(4);
    expect(names()).toContain('old 1.xlsx');
    await p.db.kvSet('excelBackupAt', Date.now() - 8 * 86400000);
    await p.store.setNoteStatus(id('告诉'), 'st:studying');
    await p.workbook.writeBack();
    expect(names()).not.toContain('old 1.xlsx');
    expect(names().filter((n) => n.startsWith('Hugo'))).toHaveLength(2);
  });

  it('offline: nothing is sent; back online, written', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    vi.stubGlobal('navigator', { onLine: false });
    const n = ms.requests.length;
    await p.workbook.writeBack();
    expect(ms.requests.length).toBe(n);
    expect(p.store.getState().excel).toMatchObject({ waiting: 'offline', pending: 1 });
    vi.stubGlobal('navigator', { onLine: true });
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
  });

  it('an upload whose answer was lost: the intent keeps the next start from taking it for an Excel edit', async () => {
    const p = await ready(await dev());
    const mark = await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    after = (url, init) => {
      if (isWorkbookPut(init.method ?? 'GET', url.href)) {
        after = null;
        throw new TypeError('Failed to fetch');
      }
    };
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN); // it landed
    expect(p.store.getState().excel.writeError).toMatch(/could not be reached/);
    expect(await p.intents.liveIntents()).toHaveLength(1);
    // The app restarts (the same database).
    advance(10 * 60000);
    const again = await dev(p.idb, false);
    await again.workbook.checkWorkbook();
    const s = again.store.getState();
    expect(s.meta!.source.qxh).toBe(quickXorHash(wbItem.bytes));
    expect(s.meta!.colourSince![key('朋友')]).toEqual(['mastered', mark.t]);
    expect(s.excelChanges).toBeUndefined();
    expect(await again.intents.liveIntents()).toEqual([]);
  });
});

describe('on the PC with the OneDrive folder linked', () => {
  function fakeDir(files: Map<string, { bytes: Uint8Array; modified: number }>) {
    return {
      name: 'OneDrive',
      queryPermission: async () => 'granted',
      requestPermission: async () => 'granted',
      getFileHandle: async (name: string) => {
        const f = files.get(name);
        if (!f) throw new DOMException('not found', 'NotFoundError');
        return { getFile: async () => new File([f.bytes.slice()], name, { lastModified: f.modified }) };
      },
    };
  }

  it('waits while Excel has the workbook open or local edits are not uploaded; no "(app)" copy', async () => {
    const files = new Map([[NAME, { bytes: wb(ROWS), modified: T0 - 3600000 }]]);
    h.dir = fakeDir(files);
    const p = await ready(await dev());
    const folder = await import('./folder');
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    files.set(`~$${NAME}`, { bytes: new Uint8Array(1), modified: T0 });
    await p.workbook.writeBack({ force: true });
    expect(p.store.getState().excel.waiting).toBe('open');
    files.delete(`~$${NAME}`);
    files.set(`~$${NAME.slice(2)}`, { bytes: new Uint8Array(1), modified: T0 });
    expect(await folder.folderSignals()).toEqual({ excelOpen: true, localNewer: false });
    files.delete(`~$${NAME.slice(2)}`);
    files.set(NAME, { bytes: wb([...ROWS, ['新', null]]), modified: T0 + 1000 });
    await p.workbook.writeBack({ force: true });
    expect(p.store.getState().excel.waiting).toBe('local');
    expect(workbookPuts()).toHaveLength(0);
    // OneDrive uploaded it: written.
    ms.excelSave(wbItem.id, files.get(NAME)!.bytes, T0 - 600000);
    await p.workbook.writeBack({ force: true });
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    await folder.writeCopy(true);
    expect(files.has('Hugo_chinese_vocab (app).xlsx')).toBe(false);
  });
});

describe('two devices', () => {
  it('the newest status wins: the app’s own write is no Excel edit on the other device (D4 echo)', async () => {
    const pc = await ready(await dev());
    await pc.sync.linkOneDrive();
    const phone = await dev();
    await phone.sync.linkOneDrive();
    await ready(phone);
    expect(h.imports).toBe(1); // the phone took the shared list, no download
    const m1 = await pc.store.setNoteStatus(id('朋友'), 'st:mastered');
    advance(10000);
    const m2 = await phone.store.setNoteStatus(id('朋友'), 'st:notknown');
    advance(3 * 60000);
    // The PC hasn't seen the phone's status: it writes green.
    await pc.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(pc.store.getState().meta!.colourSince![key('朋友')]).toEqual(['mastered', m1.t]);
    // The shared list holds the write: the PC's intent is dropped.
    await vi.waitFor(async () => expect(await pc.intents.liveIntents()).toEqual([]));
    // The phone takes that list: its newer status still wins, and it writes it.
    await phone.workbook.writeBack();
    expect(phone.store.getState().meta!.source.qxh).not.toBeUndefined();
    expect(colourOf(wbItem, '朋友')).toBe(YELLOW);
    expect(phone.store.getState().meta!.colourSince![key('朋友')]).toEqual(['notknown', m2.t]);
    expect(phone.store.getState().excelChanges).toBeUndefined();
    await pc.sync.syncNow();
    for (const d of [pc, phone]) {
      const { sheetRows, noteStatuses } = await import('./status');
      const s = d.store.getState();
      expect(noteStatuses(sheetRows(s.notes, s.marks, s.meta!.colourSince)).get(id('朋友'))).toBe('notknown');
      expect(d.workbook.pendingFills()).toEqual([]);
    }
  });

  it('an older shared list pushed during the write (take-reimport): the own write is still no Excel edit', async () => {
    const pc = await ready(await dev());
    await pc.sync.linkOneDrive();
    // What main.tsx registers.
    let rebased = 0;
    pc.sync.onRebase(() => {
      rebased++;
      return pc.workbook.checkWorkbook(true);
    });
    const mark = await pc.store.setNoteStatus(id('朋友'), 'st:mastered');
    advance(60000);
    before = (url, init) => {
      if (!isWorkbookPut(init.method ?? 'GET', url.href)) return;
      before = null;
      // Meanwhile the phone pushed its list of the version before (imported later than the PC's).
      const s = pc.store.getState();
      const older: VocabFile = { ...s.meta!, notes: s.notes, importedAt: Date.now(), device: 'phone' };
      ms.excelSave(ms.byPath('Apps/Hugo Chinese/data/vocab.json.gz')!.id, gzipSync(strToU8(JSON.stringify(older))));
    };
    await pc.workbook.writeBack();
    const written = quickXorHash(wbItem.bytes);
    await vi.waitFor(async () => {
      expect(pc.store.getState().meta!.source.qxh).toBe(written);
      expect(await pc.intents.liveIntents()).toEqual([]);
    });
    expect(rebased).toBe(1);
    expect(pc.store.getState().meta!.colourSince![key('朋友')]).toEqual(['mastered', mark.t]);
    expect(pc.store.getState().excelChanges).toBeUndefined();
    expect(pc.workbook.pendingFills()).toEqual([]);
  });

  it('a status the other device set a moment ago is left to it', async () => {
    const pc = await ready(await dev());
    await pc.sync.linkOneDrive();
    const phone = await dev();
    await phone.sync.linkOneDrive();
    await ready(phone);
    const m = await phone.store.setNoteStatus(id('朋友'), 'st:mastered');
    await phone.sync.syncNow();
    advance(30000);
    await pc.sync.syncNow();
    await pc.workbook.writeBack();
    expect(workbookPuts()).toHaveLength(0);
    expect(pc.store.getState().excel).toMatchObject({ waiting: 'other', waitUntil: m.t + 2 * 60000 });
    advance(2 * 60000);
    await pc.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
  });

  it('two writers with different statuses (412 between them): both end up in the file', async () => {
    const pc = await ready(await dev());
    await pc.sync.linkOneDrive();
    const phone = await dev();
    await phone.sync.linkOneDrive();
    await ready(phone);
    await pc.store.setNoteStatus(id('朋友'), 'st:mastered');
    await phone.store.setNoteStatus(id('工作'), 'st:notknown');
    advance(3 * 60000);
    // The PC's upload is held back (503), its bytes kept, and lands just before the phone's own upload: the phone's
    // If-Match is stale (412). (Devices never run inside each other here, so the race is replayed on the fake.)
    let pcBytes: Uint8Array | null = null;
    before = (url, init) => {
      if (!isWorkbookPut(init.method ?? 'GET', url.href)) return;
      pcBytes = (init.body as Uint8Array).slice();
      before = null;
      return new Response(JSON.stringify({ error: { code: 'serviceNotAvailable', message: 'busy' } }), { status: 503 });
    };
    await pc.workbook.writeBack();
    expect(pc.store.getState().excel.waiting).toBe('busy');
    expect(await pc.intents.liveIntents()).toEqual([]);
    before = (url, init) => {
      if (!isWorkbookPut(init.method ?? 'GET', url.href)) return;
      before = null;
      ms.excelSave(wbItem.id, pcBytes!);
    };
    await phone.workbook.writeBack();
    // The phone's upload was refused (412; the PC's 503 never reached the fake), and it read the new version.
    expect(workbookPuts()).toHaveLength(1);
    expect(phone.store.getState().meta!.source.qxh).toBe(quickXorHash(pcBytes!));
    expect(phone.store.getState().excel.waiting).toBe('quiet');
    // The PC's write looks like a fresh edit to the phone (no list of it yet): "Write now".
    await phone.workbook.writeBack({ force: true });
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(colourOf(wbItem, '工作')).toBe(YELLOW);
    await pc.sync.syncNow();
    for (const d of [pc, phone]) expect(d.workbook.pendingFills()).toEqual([]);
  });
});

describe('write intents', () => {
  it('apply until the shared list covers them; an older shared list (take-reimport) keeps them', async () => {
    const p = await dev();
    const I = (await import('./writeIntents')) as typeof import('./writeIntents');
    await I.addIntent({ qxh: 'U', at: T0, item: 'w', rows: { k: ['new', 'mastered', T0 - 5] } });
    await I.updateIntent(T0, { server: T0 + 10 });
    expect(await I.liveExplained()).toEqual({ k: ['new', 'mastered', T0 - 5] });
    await I.dropCovered({ qxh: 'P', modified: T0 - 1000 }); // older content
    expect(await I.liveIntents()).toHaveLength(1);
    await I.dropCovered({ qxh: 'V', modified: T0 + 20 }); // a later version
    expect(await I.liveIntents()).toHaveLength(0);
    await I.addIntent({ qxh: 'U', at: T0, item: 'w', rows: {} });
    await I.dropCovered({ qxh: 'U', modified: 0 });
    expect(await I.liveIntents()).toHaveLength(0);
    await I.addIntent({ qxh: 'U', at: T0, item: 'w', rows: {} });
    advance(24 * 3600000);
    expect(await I.liveIntents()).toHaveLength(0);
    expect(p).toBeTruthy();
  });
});
