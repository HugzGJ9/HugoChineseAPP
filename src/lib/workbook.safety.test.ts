// Safety branches of the workbook write-back (plan 2026-11-14 safety tests, WP1): a failed backup, the backup cadence,
// a save between the metadata read and the download, a link that went stale (404, renamed, moved), and writes that
// keep failing (stuck rows, errors). Same set-up as writeback.test.ts: the fake Microsoft, the real Graph client, a
// stand-in workbook (JSON rows [hanzi, colour] on sheet HSK五级) read by an inline import and patched inline.
// Devices run one after the other, never one inside another (Node's global navigator.locks is shared).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { ImportRequest } from './import';
import type { Note, VocabFile } from './types';
import type { PatchRequest, PatchResult } from './xlsx/patch';
import { FAKE_DOWNLOAD_HOST, FakeLocation, FakeMicrosoft, fakeSignIn, type FakeItem } from './ms/fake';
import { quickXorHash } from './ms/qxh';

type Rows = [string, string | null][];

const h = vi.hoisted(() => ({
  patches: 0,
  /** Rows (Excel row numbers) the patcher finds no place for. */
  skip: new Set<number>(),
  imports: 0,
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
      if (rows[i][0] !== f.hanzi) throw new WorkbookChangedError(f.sheet, f.row);
      rows[i][1] = f.fill;
      done++;
    }
    return { bytes: wb(rows), rows: done, cells: done * 4, xfsAdded: 0, fillsAdded: 0, skipped };
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
const T0 = Date.UTC(2026, 10, 14, 9);
const DAY = 86400000;
const BK = 'Apps/Hugo Chinese/backups';
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
/** Runs before the fake answers a request (to inject a race or a failure); return a Response to answer instead. */
let before: ((url: URL, init: RequestInit) => Response | void) | null;
let wbItem: FakeItem;
const devices: { workbook: { unlinkWorkbook(): Promise<void> } }[] = [];

const method = (init: RequestInit) => (init.method ?? 'GET').toUpperCase();
/** A PUT of the workbook's content (whatever item now holds it). */
const isWorkbookPut = (m: string, url: string) => m === 'PUT' && /\/items\/[^/]+\/content/.test(url);
const workbookPuts = () => ms.requests.filter((r) => isWorkbookPut(r.method, r.url));
const isBackupPut = (url: URL, init: RequestInit) => method(init) === 'PUT' && decodeURIComponent(url.pathname).includes('approot:/backups/');
const isDownload = (url: URL) => url.host === FAKE_DOWNLOAD_HOST;
const downloads = () => ms.requests.filter((r) => new URL(r.url).host === FAKE_DOWNLOAD_HOST);
const backups = () => [...ms.items.values()].filter((x) => x.folder === BK);
const graphAnswer = (status: number, code: string) =>
  new Response(JSON.stringify({ error: { code, message: `fake ${status}` } }), { status, headers: { 'Content-Type': 'application/json' } });

const routed = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  const instead = before?.(url, init);
  if (instead) return instead;
  return ms.fetch(input, init);
};

async function dev(idb = new IDBFactory()) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const workbook = await import('./workbook');
  const intents = await import('./writeIntents');
  const db = await import('./db');
  const auth = await import('./ms/auth');
  await store.init();
  await fakeSignIn(ms, loc, auth);
  const d = { store, workbook, intents, db, auth, idb };
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

/** Every excel state the device shows from now on (to check a state never appeared). */
function states(d: Dev): string[] {
  const seen: string[] = [];
  d.store.subscribe(() => seen.push(d.store.getState().excel.state));
  return seen;
}

const linkOf = (d: Dev) => d.db.kvGet<{ drive: string; item: string; name: string; path?: string } | null>('odWorkbook', null);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: T0 });
  ms = new FakeMicrosoft('test-client');
  ms.redirectUri = START;
  loc = new FakeLocation(START);
  before = null;
  h.patches = 0;
  h.skip.clear();
  h.imports = 0;
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
  for (const d of devices.splice(0)) await d.workbook.unlinkWorkbook();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('the backup before a write', () => {
  it('a failed backup stops the write: no upload, no intent, the error shows; written once the backup works', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    let tries = 0;
    before = (url, init) => {
      if (isBackupPut(url, init)) {
        tries++;
        return graphAnswer(507, 'quotaLimitReached');
      }
    };
    await p.workbook.writeBack();
    expect(tries).toBe(1);
    expect(workbookPuts()).toHaveLength(0);
    expect(colourOf(wbItem, '朋友')).toBeNull();
    const ex = p.store.getState().excel;
    expect(ex.writeError).toMatch(/backup in OneDrive › Apps › Hugo Chinese › backups failed first/);
    expect(ex.writeError).toMatch(/OneDrive is full/);
    expect(ex).toMatchObject({ waiting: 'retry', pending: 1 });
    expect(ex.waitUntil).toBe(Date.now() + 60000);
    expect(await p.intents.liveIntents()).toEqual([]);
    expect(await p.db.kvGet('excelBackupAt', 0)).toBe(0);
    expect(backups()).toHaveLength(0);

    // "Write now" doesn't skip the backup either.
    await p.workbook.writeBack({ force: true });
    expect(tries).toBe(2);
    expect(workbookPuts()).toHaveLength(0);

    // The app folder works again: backup first, then the write.
    before = null;
    await p.workbook.writeBack({ force: true });
    expect(backups()).toHaveLength(1);
    expect(new TextDecoder().decode(backups()[0].bytes)).toBe(JSON.stringify(ROWS));
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(p.store.getState().excel).toMatchObject({ writeError: undefined, waiting: undefined, pending: 0 });
    expect(await p.db.kvGet('excelBackupAt', 0)).toBe(Date.now());
  });

  it('backs up before the first write, not again within a week, again after a week', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(backups()).toHaveLength(1);
    expect(new TextDecoder().decode(backups()[0].bytes)).toBe(JSON.stringify(ROWS));
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    const first = Date.now();
    expect(await p.db.kvGet('excelBackupAt', 0)).toBe(first);

    // Six days later (signed in again: the browser's refresh token lasts 24 h): written without a backup.
    advance(6 * DAY);
    await fakeSignIn(ms, loc, p.auth);
    await p.store.setNoteStatus(id('工作'), 'st:notknown');
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '工作')).toBe(YELLOW);
    expect(backups()).toHaveLength(1);
    expect(await p.db.kvGet('excelBackupAt', 0)).toBe(first);

    // Exactly a week after the backup: still none.
    advance(DAY);
    await fakeSignIn(ms, loc, p.auth);
    await p.store.setNoteStatus(id('学习'), 'st:studying');
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '学习')).not.toBe(GREEN);
    expect(backups()).toHaveLength(1);

    // Past a week: a new backup, of the version just before this write.
    advance(1);
    const beforeWrite = new TextDecoder().decode(wbItem.bytes);
    await p.store.setNoteStatus(id('告诉'), 'st:mastered');
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '告诉')).toBe(GREEN);
    expect(backups()).toHaveLength(2);
    const newest = backups().sort((a, b) => b.modified - a.modified)[0];
    expect(new TextDecoder().decode(newest.bytes)).toBe(beforeWrite);
    expect(await p.db.kvGet('excelBackupAt', 0)).toBe(Date.now());
  });
});

describe('a save between the metadata and the download', () => {
  it('starts over and writes only against the new version (Excel’s change kept)', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    // No cached bytes of this version: the write downloads them.
    await p.db.kvSet('excelCache', null);
    const dl = downloads().length;
    const excelRows = rowsOf(wbItem);
    excelRows[3][1] = YELLOW; // 工作, coloured in Excel
    let saved = false;
    before = (url) => {
      if (!saved && isDownload(url)) {
        saved = true;
        ms.excelSave(wbItem.id, wb(excelRows), T0 - 10 * 60000);
      }
    };
    const imports = h.imports;
    await p.workbook.writeBack();
    expect(saved).toBe(true);
    // The download that didn't match the metadata, then the new version.
    expect(downloads().length - dl).toBe(2);
    expect(h.imports).toBeGreaterThan(imports);
    expect(p.store.getState().excelChanges).toEqual([{ note: id('工作'), hanzi: '工作', from: 'new', to: 'notknown' }]);
    // One upload, conditional on Excel's version, patched from it.
    const puts = workbookPuts();
    expect(puts).toHaveLength(1);
    expect(puts[0].headers['if-match']).toBe(`"{${wbItem.id}},2"`);
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(colourOf(wbItem, '工作')).toBe(YELLOW);
    // The backup is of the version the write started from, not of the one it replaced unread.
    expect(backups()).toHaveLength(1);
    expect(new TextDecoder().decode(backups()[0].bytes)).toBe(JSON.stringify(excelRows));
    expect(p.store.getState().meta!.source.qxh).toBe(quickXorHash(wbItem.bytes));
  });

  it('a workbook that keeps changing under the write: no upload lands over it, the app backs off', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.db.kvSet('excelCache', null);
    let saves = 0;
    let last = '';
    before = (url) => {
      if (isDownload(url)) {
        saves++;
        const rows = rowsOf(wbItem);
        rows[3][1] = saves % 2 ? YELLOW : null; // 工作, toggled in Excel each time
        rows[0][1] = `${saves}`.padStart(6, '0'); // a different file every time
        ms.excelSave(wbItem.id, wb(rows), T0 - 30 * 60000 + saves * 1000);
        last = new TextDecoder().decode(wbItem.bytes);
      }
    };
    await p.workbook.writeBack();
    expect(saves).toBeGreaterThanOrEqual(3);
    // Whatever was tried, the file is Excel's last save, the status not written over it.
    expect(new TextDecoder().decode(wbItem.bytes)).toBe(last);
    expect(colourOf(wbItem, '朋友')).toBeNull();
    const ex = p.store.getState().excel;
    expect(ex).toMatchObject({ waiting: 'busy', pending: 1 });
    expect(ex.waitUntil).toBe(Date.now() + 60000);
    expect(await p.intents.liveIntents()).toEqual([]);
  });
});

describe('the linked workbook moved', () => {
  it('moved to another drive (404): found again by name, link updated, never missing, written there', async () => {
    const p = await ready(await dev());
    const seen = states(p);
    wbItem.drive = 'drv2';
    await p.workbook.checkWorkbook();
    expect(await linkOf(p)).toMatchObject({ drive: 'drv2', item: wbItem.id, name: NAME });
    expect(seen).not.toContain('missing');
    expect(p.store.getState().excel.state).toBe('ok');
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(workbookPuts().at(-1)!.url).toContain(`/drives/drv2/items/${wbItem.id}/content`);
    expect(seen).not.toContain('missing');
  });

  it('deleted and re-created (404): the new item is linked, never missing; the write goes to it after a new confirmation', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    const seen = states(p);
    const old = wbItem.id;
    ms.items.delete(old);
    wbItem = ms.addFile(NAME, wb(ROWS), T0 - 30 * 60000);
    await p.workbook.writeBack();
    expect((await linkOf(p))?.item).toBe(wbItem.id);
    expect(seen).not.toContain('missing');
    // Confirmation is per item: a re-created file asks again before the first write into it.
    expect(p.store.getState().excel).toMatchObject({ state: 'ok', waiting: 'confirm', pending: 1 });
    expect(workbookPuts()).toHaveLength(0);
    await p.workbook.confirmFirstWrite();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(workbookPuts().every((r) => r.url.includes(`/items/${wbItem.id}/content`))).toBe(true);
    expect(ms.items.has(old)).toBe(false);
  });

  it('renamed or moved within the drive: the link keeps the item, with the new name and path', async () => {
    const p = await ready(await dev());
    const seen = states(p);
    wbItem.name = 'Hugo vocab 2026.xlsx';
    await p.workbook.checkWorkbook();
    expect(await linkOf(p)).toMatchObject({ item: wbItem.id, name: 'Hugo vocab 2026.xlsx', path: '/drive/root:' });
    expect(p.store.getState().excel).toMatchObject({ state: 'ok', name: 'Hugo vocab 2026.xlsx' });

    ms.addFile('Documents/Chinese/placeholder.txt', new Uint8Array(1));
    wbItem.folder = 'Documents/Chinese';
    await p.workbook.checkWorkbook();
    expect(await linkOf(p)).toMatchObject({ item: wbItem.id, name: 'Hugo vocab 2026.xlsx', path: '/drive/root:/Documents/Chinese' });
    expect(p.store.getState().excel).toMatchObject({ state: 'ok', path: '/drive/root:/Documents/Chinese' });

    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(seen).not.toContain('missing');
    // Same item: no new search, no new confirmation.
    expect(ms.requests.some((r) => r.url.includes('/search('))).toBe(false);
  });
});

describe('a write that keeps failing', () => {
  it('rows the patcher cannot place: marked stuck, not retried in a loop, cleared by a change to the fills', async () => {
    const p = await ready(await dev());
    h.skip.add(3); // 朋友
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    await p.workbook.writeBack();
    expect(h.patches).toBe(1);
    expect(workbookPuts()).toHaveLength(0);
    expect(await p.db.kvGet('excelStuck', null)).toMatchObject({ count: 1, sig: expect.stringContaining(quickXorHash(wbItem.bytes)) });
    expect(p.store.getState().excel).toMatchObject({ stuck: 1, pending: 1 });

    // Automatic runs: no request, no patch.
    const n = ms.requests.length;
    await p.workbook.writeBack();
    await p.workbook.writeBack();
    expect(ms.requests.length).toBe(n);
    expect(h.patches).toBe(1);
    // "Write now" reads the metadata but doesn't patch the same rows again.
    await p.workbook.writeBack({ force: true });
    expect(h.patches).toBe(1);
    expect(workbookPuts()).toHaveLength(0);

    // Hugo changes that word's status (and the patcher can place it now): tried, written, no longer stuck.
    h.skip.clear();
    advance(1000);
    await p.store.setNoteStatus(id('朋友'), 'st:studying');
    await p.workbook.writeBack();
    expect(h.patches).toBe(2);
    expect(workbookPuts()).toHaveLength(1);
    expect(colourOf(wbItem, '朋友')).not.toBeNull();
    expect(await p.db.kvGet('excelStuck', null)).toBeNull();
    expect(p.store.getState().excel).toMatchObject({ stuck: undefined, pending: 0 });
  });

  it('an upload that keeps failing: a growing back-off, no request before it ends, no intent left behind', async () => {
    const p = await ready(await dev());
    await p.store.setNoteStatus(id('朋友'), 'st:mastered');
    let fails = 0;
    before = (url, init) => {
      if (isWorkbookPut(method(init), url.href)) {
        fails++;
        return graphAnswer(500, 'generalException');
      }
    };
    await p.workbook.writeBack();
    expect(fails).toBe(1);
    let ex = p.store.getState().excel;
    expect(ex).toMatchObject({ waiting: 'retry', pending: 1 });
    expect(ex.writeError).toMatch(/could not be written into the workbook: OneDrive answered 500/);
    expect(ex.waitUntil).toBe(Date.now() + 60000);
    expect(await p.intents.liveIntents()).toEqual([]);

    // Before the back-off ends: nothing sent.
    const n = ms.requests.length;
    advance(30000);
    await p.workbook.writeBack();
    expect(ms.requests.length).toBe(n);

    advance(30001);
    await p.workbook.writeBack();
    expect(fails).toBe(2);
    ex = p.store.getState().excel;
    expect(ex.waitUntil).toBe(Date.now() + 2 * 60000);
    advance(2 * 60000 + 1);
    await p.workbook.writeBack();
    expect(fails).toBe(3);
    expect(p.store.getState().excel.waitUntil).toBe(Date.now() + 4 * 60000);
    expect(await p.intents.liveIntents()).toEqual([]);
    expect(colourOf(wbItem, '朋友')).toBeNull();

    // OneDrive works again: written, the error and the back-off gone.
    before = null;
    advance(4 * 60000 + 1);
    await p.workbook.writeBack();
    expect(colourOf(wbItem, '朋友')).toBe(GREEN);
    expect(p.store.getState().excel).toMatchObject({ writeError: undefined, waiting: undefined, waitUntil: undefined, pending: 0 });
  });
});
