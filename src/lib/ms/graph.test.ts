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
  const store = await import('../store');
  const db = await import('../db');
  if (signIn && clientId) await fakeSignIn(ms, loc, auth);
  return { auth, graph, diagnostics, store, db };
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
    const [found] = await graph.findByName('Hugo_chinese_vocab.xlsx');
    ms.excelSave(it0.id, bytes(4100, 3)); // a newer version than the search result: download gets the current one
    const got = await graph.download(found);
    expect(got).toEqual(bytes(4100, 3));
    const dl = ms.requests.filter((r) => new URL(r.url).host === FAKE_DOWNLOAD_HOST);
    expect(dl).toHaveLength(1);
    expect(dl[0].headers.authorization).toBeUndefined();
    // The token only ever went to Graph.
    for (const r of ms.requests) if (r.headers.authorization) expect(new URL(r.url).host).toBe('graph.microsoft.com');
  });

  it('findByName: exact name, case-insensitive, files only', async () => {
    ms.addFile(WB, bytes(10));
    ms.addFile('Old/hugo_chinese_vocab.XLSX', bytes(11));
    ms.addFile('Documents/Hugo_chinese_vocab (app).xlsx', bytes(12));
    ms.addFile('Documents/Hugo_chinese_vocab.xlsx.bak', bytes(13));
    ms.addFile('Hugo_chinese_vocab.xlsx/readme.txt', bytes(14)); // a folder with the name
    const { graph } = await device();
    const found = await graph.findByName("Hugo_chinese_vocab.xlsx");
    expect(found.map((x) => x.parentReference?.path).sort()).toEqual(['/drive/root:/Documents', '/drive/root:/Old']);
    expect(await graph.findByName("it's.xlsx")).toEqual([]);
    expect(ms.requests.at(-1)!.url).toContain("search(q='it''s.xlsx')");
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
    await db.kvSet('odWorkbook', { drive: ms.driveId, item: wb.id, name: 'Hugo_chinese_vocab.xlsx', linkedAt: 1 });
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
