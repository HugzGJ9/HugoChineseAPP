// The Graph client and the diagnostics against the in-memory fake (fake.ts): no real credentials, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { FAKE_DOWNLOAD_HOST, FakeLocation, FakeMicrosoft, fakeSignIn } from './fake';
import { quickXorHash } from './qxh';

const START = `https://hugzgj9.github.io${import.meta.env.BASE_URL}`;
const WB = 'Documents/Hugo_chinese_vocab.xlsx';

let ms: FakeMicrosoft;
let loc: FakeLocation;

async function device(clientId = 'test-client', signIn = true) {
  vi.resetModules();
  vi.stubEnv('VITE_MS_CLIENT_ID', clientId);
  Dexie.dependencies.indexedDB = new IDBFactory();
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const auth = await import('./auth');
  const graph = await import('./graph');
  const diagnostics = await import('./diagnostics');
  const find = await import('./find');
  const store = await import('../store');
  const db = await import('../db');
  if (signIn && clientId) await fakeSignIn(ms, loc, auth);
  return { auth, graph, diagnostics, find, store, db };
}

const bytes = (n: number, seed = 7) => Uint8Array.from({ length: n }, (_, i) => (i * 31 + seed) & 0xff);
const tokenCalls = () => ms.requests.filter((r) => r.url.endsWith('/oauth2/v2.0/token')).length;

beforeEach(() => {
  ms = new FakeMicrosoft('test-client');
  ms.redirectUri = START;
  loc = new FakeLocation(START);
  vi.stubGlobal('fetch', ms.fetch);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', loc.history);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('graph', () => {
  it('reads item metadata with the quickXorHash OneDrive reports', async () => {
    const it0 = ms.addFile(WB, bytes(5000), Date.parse('2026-11-01T10:00:00Z'));
    const { graph } = await device();
    const item = await graph.getItem(ms.driveId, it0.id);
    expect(item).toMatchObject({ id: it0.id, name: 'Hugo_chinese_vocab.xlsx', size: 5000, lastModifiedDateTime: '2026-11-01T10:00:00.000Z' });
    expect(item.file?.hashes?.quickXorHash).toBe(quickXorHash(bytes(5000)));
    expect(item.parentReference?.driveId).toBe(ms.driveId);
  });

  it('replaces with If-Match; a stale eTag → 412 conflict', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph } = await device();
    const before = await graph.getItem(ms.driveId, it0.id);
    const after = await graph.uploadReplace(ms.driveId, it0.id, bytes(120, 1), before.eTag);
    const put = ms.requests.filter((r) => r.method === 'PUT').at(-1)!;
    expect(put.headers['if-match']).toBe(before.eTag);
    expect(after.eTag).not.toBe(before.eTag);
    expect(after.size).toBe(120);
    const err = await graph.uploadReplace(ms.driveId, it0.id, bytes(130, 2), before.eTag).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(graph.GraphError);
    expect(err).toMatchObject({ status: 412, conflict: true, locked: false, auth: false });
    expect(ms.items.get(it0.id)!.bytes.length).toBe(120);
  });

  it('a locked file → 423 locked', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph } = await device();
    const meta = await graph.getItem(ms.driveId, it0.id);
    ms.lock(it0.id);
    await expect(graph.uploadReplace(ms.driveId, it0.id, bytes(10), meta.eTag)).rejects.toMatchObject({ status: 423, locked: true, conflict: false });
  });

  it('429 → retryAfter from Retry-After', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph } = await device();
    ms.failNext(429, 30);
    await expect(graph.getItem(ms.driveId, it0.id)).rejects.toMatchObject({ status: 429, retryAfter: 30000, code: 'activityLimitReached' });
    ms.failNext(503);
    await expect(graph.getItem(ms.driveId, it0.id)).rejects.toMatchObject({ status: 503, retryAfter: undefined });
    expect((await graph.getItem(ms.driveId, it0.id)).id).toBe(it0.id);
  });

  it('401 → one token refresh, then the retry succeeds', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph, store } = await device();
    await graph.getItem(ms.driveId, it0.id);
    const n = tokenCalls();
    ms.revokeAccess();
    expect((await graph.getItem(ms.driveId, it0.id)).id).toBe(it0.id);
    expect(tokenCalls()).toBe(n + 1);
    expect(store.getState().ms.state).toBe('ok');
  });

  it('401 when the refresh is refused too → GraphError.auth and Reconnect', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph, store } = await device();
    ms.revokeAccess();
    ms.expireRefresh();
    const err = await graph.getItem(ms.driveId, it0.id).catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 401, auth: true });
    expect(store.getState().ms.state).toBe('reconnect');
  });

  it('not signed in → GraphError.auth without a Graph request', async () => {
    const { graph } = await device('test-client', false);
    await expect(graph.getItem(ms.driveId, 'x')).rejects.toMatchObject({ status: 401, auth: true });
    expect(ms.requests).toHaveLength(0);
  });

  it('a network error → status 0, "OneDrive could not be reached"', async () => {
    const it0 = ms.addFile(WB, bytes(100));
    const { graph } = await device();
    await graph.getItem(ms.driveId, it0.id); // token cached
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(graph.getItem(ms.driveId, it0.id)).rejects.toMatchObject({ status: 0, message: expect.stringMatching(/OneDrive could not be reached/) });
  });

  it('404 → status 404 with Graph\'s code', async () => {
    const { graph } = await device();
    await expect(graph.getItem(ms.driveId, 'nope')).rejects.toMatchObject({ status: 404, code: 'itemNotFound' });
  });

  it('never sends the token to another host', async () => {
    const { graph } = await device();
    await expect(graph.graphFetch(`https://${FAKE_DOWNLOAD_HOST}/dl/x`)).rejects.toMatchObject({ status: 0, code: 'badHost' });
    expect(ms.requests.some((r) => r.url.includes(FAKE_DOWNLOAD_HOST))).toBe(false);
  });

  it('download fetches the download URL without Authorization or credentials', async () => {
    const it0 = ms.addFile(WB, bytes(4000));
    const { graph } = await device();
    const [found] = await graph.searchFiles('Hugo chinese vocab');
    ms.excelSave(it0.id, bytes(4100, 3)); // a newer version than the search result: download gets the current one
    const got = await graph.download(found);
    expect(got).toEqual(bytes(4100, 3));
    const dl = ms.requests.filter((r) => new URL(r.url).host === FAKE_DOWNLOAD_HOST);
    expect(dl).toHaveLength(1);
    expect(dl[0].headers.authorization).toBeUndefined();
    // The token only ever went to Graph.
    for (const r of ms.requests) if (r.headers.authorization) expect(new URL(r.url).host).toBe('graph.microsoft.com');
  });

  it('searchFiles: files only, words matched like consumer OneDrive (the exact name finds nothing)', async () => {
    ms.addFile(WB, bytes(10));
    ms.addFile('Hugo_chinese_vocab.xlsx/readme.txt', bytes(14)); // a folder with the name
    const { graph } = await device();
    expect(await graph.searchFiles('Hugo_chinese_vocab.xlsx')).toEqual([]);
    expect((await graph.searchFiles('Hugo_chinese_vocab')).map((x) => x.name)).toEqual(['Hugo_chinese_vocab.xlsx']);
    expect((await graph.searchFiles('Hugo chinese vocab')).map((x) => x.name)).toEqual(['Hugo_chinese_vocab.xlsx']);
    expect(await graph.searchFiles("it's.xlsx")).toEqual([]);
    expect(ms.requests.at(-1)!.url).toContain("search(q='it''s.xlsx')");
  });

  it('getByPath, and remoteItem entries resolve to the real item on its own drive', async () => {
    const own = ms.addFile('Documents/Hugo chinese.xlsx', bytes(10));
    const shared = ms.addShared('Shared/Hugo_chinese_vocab.xlsx', bytes(20), 'drv2');
    ms.recent = [own.id];
    const { graph } = await device();
    expect((await graph.getByPath(undefined, '/Documents/Hugo chinese.xlsx')).id).toBe(own.id);
    expect(ms.requests.at(-1)!.url).toContain('/me/drive/root:/Documents/Hugo%20chinese.xlsx');
    await expect(graph.getByPath(undefined, '/Hugo chinese.xlsx')).rejects.toMatchObject({ status: 404 });
    const [s] = await graph.searchFiles('Hugo_chinese_vocab');
    expect(s).toMatchObject({ id: shared.id, name: 'Hugo_chinese_vocab.xlsx', parentReference: { driveId: 'drv2' } });
    expect(s).not.toHaveProperty('remoteItem');
    expect(await graph.download(s)).toEqual(bytes(20));
    const [r] = await graph.recentFiles();
    expect(r).toMatchObject({ id: own.id, parentReference: { driveId: ms.driveId } });
  });
});

describe('finding the workbook (find.ts)', () => {
  const NAME = 'Hugo_chinese_vocab.xlsx';
  const steps = (r: { steps: { step: string; hits: number | string }[] }) => Object.fromEntries(r.steps.map((x) => [x.step, x.hits]));

  it('at the root: one path lookup, no search', async () => {
    const wb = ms.addFile(NAME, bytes(10));
    const { find } = await device();
    const r = await find.locateFile(NAME);
    expect(r.items.map((i) => i.id)).toEqual([wb.id]);
    expect(r.steps).toEqual([{ step: 'path: root', hits: 1 }]);
    expect(ms.requests.some((x) => x.url.includes('/search('))).toBe(false);
  });

  it('in a folder: the exact-name search finds nothing, the words do', async () => {
    const wb = ms.addFile(WB, bytes(10));
    ms.addFile('Documents/Hugo_chinese_vocab (app).xlsx', bytes(11));
    ms.addFile('Old/hugo_chinese_vocab.XLSX', bytes(12));
    const { find } = await device();
    const r = await find.locateFile(NAME);
    expect(r.items.map((i) => i.parentReference?.path).sort()).toEqual(['/drive/root:/Documents', '/drive/root:/Old']);
    expect(steps(r)).toEqual({ 'path: root': 0, 'search: name without extension': 2, 'search: words': 2, 'search: full name': 0 });
    expect(r.items.filter((i) => i.id === wb.id)).toHaveLength(1); // deduplicated
  });

  it('the last folder by path, when search has not indexed the file yet', async () => {
    const wb = ms.addFile('Chinese/Notes 2026/Hugo_chinese_vocab.xlsx', bytes(10));
    wb.indexed = false;
    const { find } = await device();
    const r = await find.locateFile(NAME, { drive: ms.driveId, folder: '/drive/root:/Chinese/Notes%202026' });
    expect(r.items.map((i) => i.id)).toEqual([wb.id]);
    expect(r.steps).toEqual([{ step: 'path: root', hits: 0 }, { step: 'path: last folder', hits: 1 }]);
    expect(find.folderPath('/drive/root:')).toBe('');
    expect(find.folderPath('/drives/abc/root:/A%20B/')).toBe('/A B');
  });

  it('not indexed, not at a known path: the recent list finds it', async () => {
    const wb = ms.addFile(WB, bytes(10));
    wb.indexed = false;
    ms.recent = [ms.addFile('Other.xlsx', bytes(3)).id, wb.id];
    const { find } = await device();
    const r = await find.locateFile(NAME);
    expect(r.items.map((i) => i.id)).toEqual([wb.id]);
    expect(steps(r)).toMatchObject({ 'search: words': 0, recent: 1 });
  });

  it('a file in a folder shared with Hugo: its own drive id', async () => {
    const wb = ms.addShared('Shared/Hugo_chinese_vocab.xlsx', bytes(10), 'drv2');
    const { find, graph } = await device();
    const [it0] = (await find.locateFile(NAME)).items;
    expect(it0).toMatchObject({ id: wb.id, parentReference: { driveId: 'drv2' } });
    expect((await graph.getItem('drv2', wb.id)).id).toBe(wb.id);
  });

  it('a failing lookup is reported and the others still run; all failing is an error', async () => {
    ms.addFile(WB, bytes(10));
    const { find } = await device();
    ms.failNext(503); // the root path lookup
    const r = await find.locateFile(NAME);
    expect(r.items).toHaveLength(1);
    expect(steps(r)['path: root']).toBe('failed: 503 serviceNotAvailable');
    for (let i = 0; i < 5; i++) ms.failNext(503);
    await expect(find.locateFile(NAME)).rejects.toMatchObject({ status: 503 });
  });

  it('nothing found: every lookup ran, zero hits; the Excel list shows xlsx files only', async () => {
    const a = ms.addFile('Documents/Chinese list.xlsx', bytes(10), 1000);
    const b = ms.addFile('Other/vocab v2.XLSX', bytes(11), 2000);
    ms.addFile('Documents/notes.docx', bytes(12));
    const { find } = await device();
    const r = await find.locateFile(NAME, { all: true });
    expect(r.items).toEqual([]);
    expect(r.steps.map((x) => x.hits)).toEqual([0, 0, 0, 0, 0]);
    const x = await find.listExcelFiles(200);
    expect(x.items.map((i) => i.id)).toEqual([b.id, a.id]);
    expect((await find.listExcelFiles(1)).items).toHaveLength(1);
  });
});

describe('diagnostics', () => {
  it('says "not configured" without a client id, with no request', async () => {
    const { diagnostics } = await device('');
    const report = await diagnostics.runDiagnostics();
    expect(report).toMatch(/Microsoft sign-in: not configured/);
    expect(ms.requests).toHaveLength(0);
  });

  it('checks drive type, hash, If-Match, download host and the linked workbook, then deletes its file', async () => {
    const wb = ms.addFile(WB, bytes(2000));
    const { diagnostics, db } = await device();
    await db.kvSet('odWorkbook', { drive: ms.driveId, item: wb.id, name: 'Hugo_chinese_vocab.xlsx', path: '/drive/root:/Documents', linkedAt: 1 });
    const itemsBefore = ms.items.size;
    const report = await diagnostics.runDiagnostics();
    expect(report).toContain('Drive type: personal');
    expect(report).toContain('App folder: ok');
    expect(report).toContain('Upload 3 KB: ok');
    expect(report).toContain('quickXorHash: match');
    expect(report).toContain('Replace with the current eTag: ok (new eTag)');
    expect(report).toContain('Replace with a stale eTag: refused with 412 (expected)');
    expect(report).toContain(`Download host: ${FAKE_DOWNLOAD_HOST}`);
    expect(report).toContain('Download: ok (same bytes)');
    expect(report).toContain('Delete the test file: ok');
    expect(report).toMatch(/Linked workbook: found, 2 KB, hashes: quickXorHash/);
    expect(report).toContain('Workbook lookups: path: root 0, path: last folder 1, search: name without extension 1, search: words 1, search: full name 0, recent 0');
    expect(report).toContain('Workbook files found: 1');
    expect(report).toMatch(/Excel files listed: 1 \(search: \.xlsx 1, search: xlsx 1, recent 0\)/);
    // No names, emails, file names or paths.
    for (const secret of ['test@example.com', 'Test User', 'Hugo_chinese_vocab', 'Documents', 'oid-1', 'at-', 'rt-']) expect(report).not.toContain(secret);
    // Only approot/diag was touched, and the test file is gone (the diag folder stays).
    expect([...ms.items.values()].filter((x) => x.folder.startsWith('Apps/Hugo Chinese/diag'))).toHaveLength(0);
    expect(ms.items.size).toBe(itemsBefore + 1);
    for (const r of ms.requests.filter((x) => x.method !== 'GET' && new URL(x.url).host === 'graph.microsoft.com')) {
      const u = decodeURIComponent(new URL(r.url).pathname);
      expect(u.includes('special/approot:/diag/') || /\/items\/item\d+(\/content)?$/.test(u)).toBe(true);
      expect(u).not.toContain(wb.id + '/');
    }
  });

  it('reports failures and keeps going', async () => {
    const { diagnostics } = await device();
    ms.failNext(503);
    const report = await diagnostics.runDiagnostics();
    expect(report).toContain('Drive type: failed: 503 serviceNotAvailable');
    expect(report).toContain('quickXorHash: match');
    expect(report).toContain('Linked workbook: none');
  });
});
