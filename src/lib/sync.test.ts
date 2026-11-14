// Two devices syncing through an in-memory stand-in for the GitHub API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { gunzipSync, gzipSync } from 'fflate';
import type { Note, ReviewEvent, StatusMark, VocabFile } from './types';
import { fromBase64, toBase64 } from './github';
import { latestMarks } from './engine/schedule';
import { sheetRows } from './status';
import { FakeLocation, FakeMicrosoft, fakeSignIn } from './ms/fake';
import { fromOdName, toOdName } from './syncstore';

class FakeGitHub {
  files = new Map<string, { sha: string; bytes: Uint8Array }>();
  blobs = new Map<string, Uint8Array>();
  commits = 0;
  private next = 0;
  repos: Record<string, { private: boolean }> = { 'me/data': { private: true }, 'me/public': { private: false } };
  truncated = false;

  fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const h = init.headers as Record<string, string>;
    if (h.Authorization !== 'Bearer tok') return json(401, { message: 'Bad credentials' });
    const m = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(\/.*)?$/);
    const repo = m && this.repos[`${m[1]}/${m[2]}`];
    if (!m || !repo) return json(404, { message: 'Not Found' });
    const rest = m[3] ?? '';
    if (!rest) return json(200, { full_name: `${m[1]}/${m[2]}`, private: repo.private, default_branch: 'main' });
    if (rest.startsWith('/git/trees/main')) {
      if (!this.files.size) return json(409, { message: 'Git Repository is empty.' });
      return json(200, { tree: [...this.files].map(([path, f]) => ({ path, type: 'blob', sha: f.sha })), truncated: this.truncated });
    }
    const blob = rest.match(/^\/git\/blobs\/(\w+)$/);
    if (blob) {
      const b = this.blobs.get(blob[1]);
      return b ? json(200, { content: toBase64(b).replace(/(.{60})/g, '$1\n'), encoding: 'base64' }) : json(404, {});
    }
    const put = rest.match(/^\/contents\/(.+)$/);
    if (put && init.method === 'PUT') {
      const path = put[1].split('/').map(decodeURIComponent).join('/');
      const body = JSON.parse(String(init.body)) as { content: string; sha?: string };
      const cur = this.files.get(path);
      if (cur && !body.sha) return json(422, { message: '"sha" wasn\'t supplied.' });
      if (cur && body.sha !== cur.sha) return json(409, { message: `${path} does not match ${body.sha}` });
      const bytes = fromBase64(body.content);
      const sha = `b${(this.next++).toString(16).padStart(8, '0')}`;
      this.files.set(path, { sha, bytes });
      this.blobs.set(sha, bytes);
      this.commits++;
      return json(cur ? 200 : 201, { content: { sha, path } });
    }
    return json(404, { message: 'Not Found' });
  };

  text(path: string): string {
    return new TextDecoder().decode(this.files.get(path)!.bytes);
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/**
 * A fresh copy of the app's modules with their own empty IndexedDB: one device.
 * Pass the `idb` of another device to get a second tab of that device (same database, separate memory).
 */
async function device(idb = new IDBFactory()) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const sync = await import('./sync');
  const db = await import('./db');
  const explain = await import('./explain');
  await store.init();
  return { store, sync, db, explain, idb, id: store.getState().device };
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
    studied: i % 3 === 0,
    examples: [],
    ...over,
  };
}

function vocab(n: number, importedAt: number, extra = ''): VocabFile {
  const notes = Array.from({ length: n }, (_, i) => note(i, extra ? { en: `word ${i} ${extra}` } : {}));
  return {
    version: 1,
    importedAt,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: importedAt, size: 1000 + n },
    hash: `h${n}${extra}`,
    notes,
    issues: [],
    seeds: Object.fromEntries(notes.filter((x) => x.studied).map((x) => [x.id, importedAt])),
    report: [],
  };
}

const T0 = new Date(2026, 10, 2, 10).getTime();
const LINK = { owner: 'me', name: 'data', token: 'tok' };

function snapshot(cards: Map<string, { due: number; stability: number; reps: number; state: number }>) {
  return [...cards.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([id, c]) => [id, c.due, c.stability.toFixed(6), c.reps, c.state]);
}

let gh: FakeGitHub;
// Node re-reads TZ when it changes at run time. (No Node types in this project, hence the cast.)
const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
const TZ = env.TZ;
function setTZ(tz: string | undefined) {
  if (tz == null) delete env.TZ;
  else env.TZ = tz;
}
/** localStorage for Node: one per browser profile (device). */
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
  gh = new FakeGitHub();
  vi.stubGlobal('fetch', gh.fetch);
  vi.stubGlobal('localStorage', new MemStorage());
});
afterEach(() => {
  setTZ(TZ);
  vi.unstubAllGlobals();
});

/** Ids of the events in a review log file of the fake repository. */
function fileIds(path: string): string[] {
  return JSON.parse(gh.text(path)).events.map((r: unknown[]) => r[0]);
}

function putFile(path: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const sha = `x${Math.random().toString(16).slice(2, 10)}`;
  gh.files.set(path, { sha, bytes });
  gh.blobs.set(sha, bytes);
}

describe('sync key', () => {
  it('round-trips, also from the full link URL', async () => {
    const { sync } = await device();
    const key = sync.encodeKey({ owner: 'HugzGJ9', name: 'HugoChineseData', token: 'github_pat_11ABC_xyz' });
    expect(key.startsWith('hz1.')).toBe(true);
    expect(key).toMatch(/^[\w.-]+$/);
    expect(sync.decodeKey(key)).toEqual({ owner: 'HugzGJ9', name: 'HugoChineseData', token: 'github_pat_11ABC_xyz' });
    expect(sync.decodeKey(`https://hugzgj9.github.io/HugoChineseAPP/#/link/${key}`)?.name).toBe('HugoChineseData');
    expect(sync.decodeKey('github_pat_xyz')).toBeNull();
    expect(sync.decodeKey('hz1.%%%')).toBeNull();
  });

  it('review logs round-trip', async () => {
    const { sync } = await device();
    const evs = [
      { id: 'b', card: 'v:学|xue#recog', r: 3 as const, t: 2, d: 1500, m: 'reveal', dev: 'pc-1' },
      { id: 'a', card: 'v:学|xue#recall', r: 1 as const, t: 1, d: 900, m: 'write-free', dev: 'pc-1' },
    ];
    const text = sync.encodeEvents('pc-1', '2026-11', evs);
    expect(sync.decodeEvents(text, 'pc-1')).toEqual([evs[1], evs[0]]);
    // The month stamp stays local: files are unchanged for older app versions.
    expect(sync.encodeEvents('pc-1', '2026-11', evs.map((e) => ({ ...e, mo: '2026-11' })))).toBe(text);
  });

  it('review logs are read through their fields header', async () => {
    const { sync } = await device();
    const text = JSON.stringify({ fields: ['t', 'id', 'x', 'card', 'r'], events: [[5, 'a', 'later', 'v:学|xue#recog', 4]] });
    expect(sync.decodeEvents(text, 'pc-1')).toEqual([{ id: 'a', card: 'v:学|xue#recog', r: 4, t: 5, d: 0, m: '', dev: 'pc-1' }]);
    // A malformed row refuses the whole file rather than dropping (and so deleting) a review.
    expect(() => sync.decodeEvents(JSON.stringify({ events: [['a', 'c#recog', 7, 1, 0, 'reveal']] }), 'pc-1')).toThrow(/malformed/);
    expect(() => sync.decodeEvents('{"events":', 'pc-1')).toThrow();
  });

  it('backs off after failures, up to 30 minutes, longer when GitHub asks', async () => {
    const { sync } = await device();
    expect([1, 2, 3, 6, 9].map((n) => sync.backoffDelay(n) / 60000)).toEqual([1, 2, 4, 30, 30]);
    expect(sync.backoffDelay(1, 45 * 60000)).toBe(45 * 60000);
  });
});

describe('linking', () => {
  it('refuses a public repository and a bad token', async () => {
    const { sync } = await device();
    await expect(sync.linkRepo({ ...LINK, name: 'public' })).rejects.toThrow(/public/);
    await expect(sync.linkRepo({ ...LINK, token: 'nope' })).rejects.toThrow(/token/i);
    await expect(sync.linkRepo({ ...LINK, name: 'missing' })).rejects.toThrow(/not found/i);
    expect(await sync.getLink()).toBeNull();
  });

  it('new devices get 8 hex digits', async () => {
    const { id } = await device();
    expect(id).toMatch(/^[a-z]+-[0-9a-f]{8}$/);
  });

  it('takes a new id when another device already uses this one, before any review', async () => {
    const phone = await device();
    const old = phone.id;
    putFile(`devices/${old}.json`, '{"id":"x","linkedAt":1}');
    putFile(`events/${old}/2026-10.json`, '{"events":[]}');
    await phone.sync.linkRepo(LINK);
    const id = phone.store.getState().device;
    expect(id).not.toBe(old);
    expect(await phone.db.kvGet('deviceId', '')).toBe(id);
    expect(gh.text(`devices/${old}.json`)).toBe('{"id":"x","linkedAt":1}');
    expect(gh.files.has(`devices/${id}.json`)).toBe(true);
    const ev = await phone.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    expect(ev.dev).toBe(id);
  });

  it('refuses to link when another device uses this id and this one has reviews', async () => {
    const phone = await device();
    await phone.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    putFile(`devices/${phone.id}.json`, '{"id":"x","linkedAt":1}');
    await expect(phone.sync.linkRepo(LINK)).rejects.toThrow(/already uses the id/);
    expect(await phone.sync.getLink()).toBeNull();
    expect(gh.text(`devices/${phone.id}.json`)).toBe('{"id":"x","linkedAt":1}');
  });

  it('a device that unlinks can link again under its own id', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    await pc.sync.linkRepo(LINK);
    await pc.sync.unlinkRepo();
    await pc.sync.linkRepo(LINK);
    expect(pc.store.getState().device).toBe(pc.id);
    // Linked by an older version (no link stamp kept): its reviews in the repository prove the id is its own.
    await pc.sync.unlinkRepo();
    await pc.db.kvSet('linkStamps', []);
    await pc.sync.linkRepo(LINK);
    expect(pc.store.getState().device).toBe(pc.id);
    expect(pc.store.getState().sync.state).toBe('idle');
  });
});

describe('two devices', () => {
  it('computer and iPhone end with the same words, settings and cards', async () => {
    // Computer: words from Excel, a few reviews, then link.
    const pc = await device();
    await pc.store.setVocab(vocab(12, T0));
    await pc.db.kvSet('vocabDirty', true);
    await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 2000, T0 + 1000);
    await pc.store.recordReview('v:词2|ci2#recog', 1, 'type-pinyin', 4000, T0 + 2000);
    await pc.sync.linkRepo(LINK);
    expect(pc.store.getState().sync.state).toBe('idle');
    expect([...gh.files.keys()].sort()).toEqual([`devices/${pc.id}.json`, `events/${pc.id}/2026-11.json`, 'settings.json', 'vocab.json.gz']);
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);

    // A setting changed on the computer.
    await pc.store.updateSettings({ newVocab: 15 });
    await pc.sync.syncNow();
    expect(JSON.parse(gh.text('settings.json')).newVocab).toBe(15);

    // iPhone: links with the key, gets everything.
    const phone = await device();
    expect(phone.id).not.toBe(pc.id);
    await phone.sync.linkRepo(phone.sync.decodeKey(pc.sync.encodeKey(LINK))!);
    expect(phone.store.getState().notes).toHaveLength(12);
    expect(phone.store.getState().settings.newVocab).toBe(15);
    expect(phone.store.getState().events).toHaveLength(2);
    expect(snapshot(phone.store.getState().cards)).toEqual(snapshot(pc.store.getState().cards));
    // Pulling the shared list does not send it back.
    expect(await phone.db.kvGet('vocabDirty', false)).toBe(false);

    // iPhone studies, undoes one answer; the computer catches up.
    await phone.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 2500, T0 + 86400000);
    const wrong = await phone.store.recordReview('v:词4|ci4#recog', 1, 'reveal', 2500, T0 + 86400000 + 5000);
    await phone.store.undoReview(wrong.id);
    await phone.store.recordReview('v:词4|ci4#recog', 4, 'reveal', 2500, T0 + 86400000 + 6000);
    await phone.sync.syncNow();
    expect(gh.files.has(`events/${phone.id}/2026-11.json`)).toBe(true);

    await pc.sync.syncNow();
    expect(pc.store.getState().events).toHaveLength(4);
    expect(snapshot(pc.store.getState().cards)).toEqual(snapshot(phone.store.getState().cards));

    // Nothing changed: a sync writes nothing.
    const commits = gh.commits;
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(gh.commits).toBe(commits);

    // New words in Excel on the computer reach the iPhone.
    await pc.store.setVocab(vocab(14, T0 + 2 * 86400000, 'v2'));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(phone.store.getState().notes).toHaveLength(14);
    expect(phone.store.getState().meta?.hash).toBe('h14v2');
    expect(snapshot(phone.store.getState().cards)).toEqual(snapshot(pc.store.getState().cards));
  });

  it('a device that imported a file before joining takes the shared word list', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(5, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.store.setVocab(vocab(3, T0 + 1000, 'old copy'));
    await phone.db.kvSet('vocabDirty', true);
    await phone.sync.linkRepo(LINK);
    expect(phone.store.getState().notes).toHaveLength(5);
    await pc.sync.syncNow();
    expect(pc.store.getState().notes).toHaveLength(5);
  });

  it('settings: the latest change wins', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);

    await pc.store.updateSettings({ maxReviews: 200 });
    await new Promise((r) => setTimeout(r, 5));
    await phone.store.updateSettings({ maxReviews: 80 });
    await pc.sync.syncNow();
    await phone.sync.syncNow(); // newer: overwrites
    await pc.sync.syncNow();
    expect(pc.store.getState().settings.maxReviews).toBe(80);
    expect(phone.store.getState().settings.maxReviews).toBe(80);
  });

  it('keeps reviews made while offline and sends them later', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await pc.store.recordReview('v:词0|ci0#recog', 3, 'reveal', 1000, T0 + 5000);
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.state).toBe('error');
    expect(pc.store.getState().sync.message).toMatch(/could not be reached/);
    vi.stubGlobal('fetch', gh.fetch);
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.state).toBe('idle');
    expect(gh.text(`events/${pc.id}/2026-11.json`)).toContain('v:词0|ci0#recog');
  });
});

describe('time zones (month files)', () => {
  const DAY = 86400000;
  const NOV = Date.UTC(2026, 10, 15, 10);
  const EDGE = Date.UTC(2026, 10, 30, 20); // 1 December in Shanghai, 30 November in Paris
  const DEC = Date.UTC(2026, 11, 10, 10);

  async function writerInShanghai() {
    setTZ('Asia/Shanghai');
    const pc = await device();
    await pc.store.setVocab(vocab(6, NOV - DAY));
    await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, NOV);
    const edge = await pc.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, EDGE);
    await pc.store.recordReview('v:词3|ci3#recog', 3, 'reveal', 1000, DEC);
    await pc.sync.linkRepo(LINK);
    return { pc, edge };
  }
  const ids = (d: { store: { getState(): { events: ReviewEvent[] } } }) => d.store.getState().events.map((e) => e.id).sort();

  it('a reader in another time zone keeps a boundary review, whatever the merge order', async () => {
    const { pc, edge } = await writerInShanghai();
    expect(fileIds(`events/${pc.id}/2026-12.json`)).toContain(edge.id);
    const nov = pc.sync.decodeEvents(gh.text(`events/${pc.id}/2026-11.json`), pc.id);
    const dec = pc.sync.decodeEvents(gh.text(`events/${pc.id}/2026-12.json`), pc.id);
    const all = ids(pc);

    setTZ('Europe/Paris');
    const orders: [string, ReviewEvent[]][][] = [
      [['2026-11', nov], ['2026-12', dec], ['2026-11', nov]],
      [['2026-12', dec], ['2026-11', nov], ['2026-12', dec]],
    ];
    for (const order of orders) {
      const reader = await device();
      await reader.store.setVocab(vocab(6, NOV - DAY));
      for (const [month, evs] of order) await reader.store.mergeDeviceEvents(pc.id, month, evs);
      expect(ids(reader)).toEqual(all);
      expect(await reader.db.db.events.count()).toBe(3);
    }

    // Through sync, also when the November file changes again later.
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    expect(ids(phone)).toEqual(all);
    setTZ('Asia/Shanghai');
    const late = await pc.store.recordReview('v:词4|ci4#recog', 2, 'reveal', 1000, NOV + DAY);
    await pc.sync.syncNow();
    setTZ('Europe/Paris');
    await phone.sync.syncNow();
    expect(ids(phone)).toEqual([...all, late.id].sort());
  });

  it('a review recorded before travelling stays in its month file', async () => {
    setTZ('Asia/Shanghai');
    const pc = await device();
    await pc.store.setVocab(vocab(6, NOV - DAY));
    await pc.sync.linkRepo(LINK);
    const edge = await pc.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, EDGE);
    setTZ('Europe/Paris');
    await pc.sync.syncNow();
    expect(fileIds(`events/${pc.id}/2026-12.json`)).toEqual([edge.id]);
    expect(gh.files.has(`events/${pc.id}/2026-11.json`)).toBe(false);
    // A review one hour later, recorded in Paris, is on 30 November there.
    const later = await pc.store.recordReview('v:词3|ci3#recog', 3, 'reveal', 1000, EDGE + 3600000);
    await pc.sync.syncNow();
    expect(fileIds(`events/${pc.id}/2026-11.json`)).toEqual([later.id]);
    expect(fileIds(`events/${pc.id}/2026-12.json`)).toEqual([edge.id]);
  });

  it('the one-time repair restores a review the old month bug deleted', async () => {
    const { pc, edge } = await writerInShanghai();
    setTZ('Europe/Paris');
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    const own = await phone.store.recordReview('v:词4|ci4#recog', 3, 'reveal', 1000, DEC + 1000);
    await phone.sync.syncNow();
    expect(phone.store.getState().events).toHaveLength(4);

    // What an older version left behind: no month stamps, the boundary review deleted, the repair not run yet.
    const { db } = phone.db;
    await db.events.toCollection().modify((e) => {
      delete e.mo;
    });
    await db.events.delete(edge.id);
    await phone.db.kvSet('migr.mo', false);
    const commits = gh.commits;

    // The app starts again with this version.
    const again = await device(phone.idb);
    expect(again.store.getState().events).toHaveLength(3);
    expect((await db.events.get(own.id))?.mo).toBe('2026-12');
    expect(Object.keys(await again.db.kvGet<Record<string, string>>('syncShas', {})).some((p) => p.startsWith(`events/${pc.id}/`))).toBe(false);
    await again.sync.syncNow();
    expect(ids(again)).toContain(edge.id);
    expect(again.store.getState().events).toHaveLength(4);
    expect(gh.commits).toBe(commits);
    expect(await again.db.kvGet('migr.mo', false)).toBe(true);
  });
});

describe('robustness', () => {
  it('an upload includes reviews recorded in another tab', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    const tab2 = await device(pc.idb);
    const ev = await tab2.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0 + 5000);
    // An older app version in a third tab writes directly, with no month stamp.
    await tab2.db.db.events.put({ id: 'old-tab', card: 'v:词2|ci2#recog', r: 4, t: T0 + 6000, d: 800, m: 'reveal', dev: pc.id });
    await tab2.db.kvSet('dirty', { '2026-11': Date.now() + 1000 });
    // The first tab never saw these reviews in memory.
    await pc.sync.syncNow();
    expect(fileIds(`events/${pc.id}/2026-11.json`).sort()).toEqual([ev.id, 'old-tab'].sort());
    expect(await pc.store.dirtyMonths()).toEqual({});
    // It catches up through the broadcast from the other tab.
    await vi.waitFor(() => expect(pc.store.getState().events.map((e) => e.id)).toContain(ev.id), { timeout: 3000 });
  });

  it('one unreadable file does not stop the rest of the sync', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    const tab = (id: string, t: number): ReviewEvent => ({ id, card: 'v:词1|ci1#recog', r: 3, t, d: 1, m: 'reveal', dev: 'tablet-1' });
    putFile('events/tablet-1/2026-10.json', '{"events":[["a"');
    putFile('events/tablet-1/2026-11.json', pc.sync.encodeEvents('tablet-1', '2026-11', [tab('t1', T0 + 1)]));
    putFile('settings.json', 'not json');
    const ev = await pc.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, T0 + 2000);
    await pc.store.updateSettings({ newVocab: 7 });
    await pc.sync.syncNow();
    let s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(s.sync.warnings).toHaveLength(2);
    expect(s.sync.warnings!.join(' ')).toMatch(/2026-10 of tablet-1/);
    expect(s.events.map((e) => e.id)).toContain('t1');
    expect(fileIds(`events/${pc.id}/2026-11.json`)).toEqual([ev.id]);
    expect(JSON.parse(gh.text('settings.json')).newVocab).toBe(7);

    // A file that turns malformed later keeps the reviews already merged.
    putFile('events/tablet-1/2026-11.json', JSON.stringify({ events: [['t1', 'v:词1|ci1#recog', 9, T0, 1, 'reveal']] }));
    await pc.sync.syncNow();
    expect(pc.store.getState().events.map((e) => e.id)).toContain('t1');

    // Fixed: read again, and the warnings go away.
    putFile('events/tablet-1/2026-10.json', pc.sync.encodeEvents('tablet-1', '2026-10', [tab('t0', T0 - 10 * 86400000)]));
    putFile('events/tablet-1/2026-11.json', pc.sync.encodeEvents('tablet-1', '2026-11', [tab('t1', T0 + 1)]));
    await pc.sync.syncNow();
    s = pc.store.getState();
    expect(s.sync.warnings).toBeUndefined();
    expect(s.events.map((e) => e.id).sort()).toEqual([ev.id, 't0', 't1'].sort());
  });

  it('a write conflict pulls again and retries once', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    await phone.store.updateSettings({ maxReviews: 80 });
    let conflicts = 0;
    let raced = false;
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      if (!raced && init.method === 'PUT' && String(input).endsWith('/contents/settings.json')) {
        // The computer saves newer settings just before the phone's write lands. Written straight into the repository:
        // running the computer's sync here would wait on the phone's sync lock (navigator.locks exists in Node 24).
        raced = true;
        const newer = { ...pc.store.getState().settings, maxReviews: 50, updatedAt: Date.now() + 1000 };
        putFile('settings.json', JSON.stringify(newer, null, 1) + '\n');
      }
      const res = await gh.fetch(input, init);
      if (res.status === 409) conflicts++;
      return res;
    });
    await phone.sync.syncNow();
    expect(conflicts).toBe(1);
    expect(phone.store.getState().sync.state).toBe('idle');
    expect(phone.store.getState().settings.maxReviews).toBe(50);
    expect(JSON.parse(gh.text('settings.json')).maxReviews).toBe(50);
  });

  it('cards are rebuilt once for many merged files', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(10, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    for (let m = 0; m < 6; m++) {
      const t = Date.UTC(2026, 11 + m, 10);
      await pc.store.recordReview(`v:词${m}|ci${m}#recog`, 3, 'reveal', 1000, t);
    }
    await pc.sync.syncNow();

    let calls = 0;
    vi.doMock('./engine/schedule', async (importOriginal) => {
      const m = await importOriginal<typeof import('./engine/schedule')>();
      return { ...m, deriveCards: (...a: Parameters<typeof m.deriveCards>) => (calls++, m.deriveCards(...a)) };
    });
    const counted = await device(phone.idb);
    vi.doUnmock('./engine/schedule');
    calls = 0;
    await counted.sync.syncNow();
    expect(counted.store.getState().events).toHaveLength(6);
    expect(calls).toBe(1);
  });

  it('a word list from a newer app version is neither applied nor overwritten', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.linkRepo(LINK);
    const future = { ...vocab(5, T0 + 1000, 'future'), version: 2 };
    putFile('vocab.json.gz', '');
    const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(future)));
    const sha = gh.files.get('vocab.json.gz')!.sha;
    gh.files.set('vocab.json.gz', { sha, bytes });
    gh.blobs.set(sha, bytes);
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.notes).toHaveLength(3);
    expect(s.sync.updateNeeded).toBe(true);
    expect(s.sync.warnings?.[0]).toMatch(/Update the app/);
    expect(gh.files.get('vocab.json.gz')!.sha).toBe(sha);
  });

  it('a truncated file listing stops the sync with a clear message', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    gh.truncated = true;
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.state).toBe('error');
    expect(pc.store.getState().sync.message).toMatch(/too many files/);
  });

  it('a rate limit is reported as such', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    vi.stubGlobal('fetch', async () => new Response('{"message":"slow down"}', { status: 429, headers: { 'retry-after': '120' } }));
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.message).toMatch(/rate limit/);
  });
});

describe('status marks', () => {
  const W = 'v:词1|ci1';
  const mark = (id: string, t: number, a = 'known', note = W): StatusMark => ({ id, note, a: a as StatusMark['a'], t, dev: 'tablet-1' });
  /** Ids of the marks in a marks file of the fake repository. */
  const markIds = (path: string): string[] => JSON.parse(gh.text(path)).marks.map((r: unknown[]) => r[0]);

  it('mark files round-trip and are read through their fields header', async () => {
    const { sync } = await device();
    const marks = [mark('b', 2, 'suspend'), mark('a', 1), mark('c', 2, 'later-kind')];
    const text = sync.encodeMarks('tablet-1', '2026-11', marks.map((m) => ({ ...m, mo: '2026-11' })));
    const j = JSON.parse(text);
    expect(j).toMatchObject({ device: 'tablet-1', month: '2026-11', v: 1, fields: ['id', 'note', 'a', 't'] });
    expect(sync.decodeMarks(text, 'tablet-1')).toEqual([marks[1], marks[0], marks[2]]);
    expect(sync.decodeMarks(JSON.stringify({ v: 1, fields: ['t', 'x', 'a', 'id', 'note'], marks: [[5, 0, 'relearn', 'z', W]] }), 'pc-1')).toEqual([
      { id: 'z', note: W, a: 'relearn', t: 5, dev: 'pc-1' },
    ]);
    // A bad row refuses the whole file.
    expect(() => sync.decodeMarks(JSON.stringify({ v: 1, marks: [['a', W, 'known', 1], ['b', '', 'known', 2]] }), 'pc-1')).toThrow(/mark 2 is malformed/);
    expect(() => sync.decodeMarks(JSON.stringify({ v: 1, marks: [['a', W, 'known', 'x']] }), 'pc-1')).toThrow(/malformed/);
    expect(() => sync.decodeMarks(JSON.stringify({ v: 2, marks: [] }), 'pc-1')).toThrow(sync.MarksTooNewError);
    // Review logs never read as marks, nor the other way round.
    expect(() => sync.decodeEvents(text, 'tablet-1')).toThrow();
  });

  it('a mark set on one device reaches the other; undo takes it back', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(6, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);

    const m = await pc.store.setNoteStatus(W, 'known', T0 + 1000);
    await pc.store.setNoteStatus('v:词2|ci2', 'suspend', T0 + 2000);
    await pc.sync.syncNow();
    const path = `marks/${pc.id}/2026-11.json`;
    expect(markIds(path)).toHaveLength(2);
    expect(await pc.store.dirtyMarkMonths()).toEqual({});
    // Marks are not reviews: the review logs are untouched.
    expect(gh.files.has(`events/${pc.id}/2026-11.json`)).toBe(false);

    await phone.sync.syncNow();
    expect(phone.store.getState().marks.map((x) => x.id).sort()).toEqual(pc.store.getState().marks.map((x) => x.id).sort());
    expect(phone.store.getState().cards.get(`${W}#recog`)?.state).toBe(2);
    expect(phone.store.getState().cards.get('v:词2|ci2#recog')?.suspended).toBe(true);
    expect(snapshot(phone.store.getState().cards)).toEqual(snapshot(pc.store.getState().cards));
    // The phone does not send the computer's marks back.
    expect(gh.files.has(`marks/${phone.id}/2026-11.json`)).toBe(false);

    await pc.store.undoMark(m.id);
    await pc.sync.syncNow();
    expect(markIds(path)).toHaveLength(1);
    await phone.sync.syncNow();
    expect(phone.store.getState().cards.get(`${W}#recog`)?.state).toBe(pc.store.getState().cards.get(`${W}#recog`)?.state);
    expect(phone.store.getState().cards.get(`${W}#recog`)?.mark).toBeUndefined();
    expect(snapshot(phone.store.getState().cards)).toEqual(snapshot(pc.store.getState().cards));

    // Nothing changed: no commit.
    const commits = gh.commits;
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(gh.commits).toBe(commits);
  });

  it('status marks (st:*) round-trip, reach the other device and change no card', async () => {
    const { sync } = await device();
    const st = [mark('s1', 1, 'st:mastered'), mark('s2', 2, 'st:notknown'), mark('s3', 3, 'st:studying'), mark('s4', 4, 'st:new')];
    expect(sync.decodeMarks(sync.encodeMarks('tablet-1', '2026-11', st), 'tablet-1')).toEqual(st);
    expect(latestMarks(st).size).toBe(0);

    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    const before = snapshot(phone.store.getState().cards);
    const m = await phone.store.setNoteStatus(W, 'st:mastered', T0 + 1000);
    await phone.sync.syncNow();
    expect(JSON.parse(gh.text(`marks/${phone.id}/2026-11.json`)).marks).toEqual([[m.id, W, 'st:mastered', T0 + 1000]]);
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.marks.map((x) => [x.id, x.a])).toEqual([[m.id, 'st:mastered']]);
    expect(snapshot(s.cards)).toEqual(before);
    const status = (st: typeof s) => sheetRows(st.notes, st.marks, st.meta?.colourSince).get('HSK四级')!.find((r) => r.note.id === W)!;
    expect(status(s)).toMatchObject({ status: 'mastered', mark: { id: m.id } });
  });

  it('row colour times travel with the word list, and a list from an older app version keeps them', async () => {
    const since = { 'v:词1|ci1@HSK四级#0': ['mastered', T0] as ['mastered', number] };
    const pc = await device();
    await pc.store.setVocab({ ...vocab(3, T0), colourSince: since });
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    expect(phone.store.getState().meta?.colourSince).toEqual(since);
    // An older app version imports and uploads a list without the field.
    const old = vocab(4, T0 + 5000, 'old');
    const bytes = gzipSync(new TextEncoder().encode(JSON.stringify(old)));
    const sha = 'xold0001';
    gh.files.set('vocab.json.gz', { sha, bytes });
    gh.blobs.set(sha, bytes);
    await phone.sync.syncNow();
    expect(phone.store.getState().notes).toHaveLength(4);
    expect(phone.store.getState().meta?.colourSince).toEqual(since);
  });

  it('a mark set and undone before an upload sends nothing', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    const m = await pc.store.setNoteStatus(W, 'known', T0);
    await pc.store.undoMark(m.id);
    const commits = gh.commits;
    await pc.sync.syncNow();
    expect(gh.commits).toBe(commits);
    expect(await pc.store.dirtyMarkMonths()).toEqual({});
  });

  it('a malformed marks file is reported; other files still merge and own marks are still sent', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    putFile('marks/tablet-1/2026-10.json', '{"v":1,"marks":[["a"');
    putFile('marks/tablet-1/2026-11.json', pc.sync.encodeMarks('tablet-1', '2026-11', [mark('t1', T0 + 1, 'suspend')]));
    const own = await pc.store.setNoteStatus('v:词2|ci2', 'known', T0 + 2000);
    await pc.sync.syncNow();
    let s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(s.sync.warnings).toHaveLength(1);
    expect(s.sync.warnings![0]).toMatch(/2026-10 of tablet-1/);
    expect(s.marks.map((x) => x.id).sort()).toEqual(['t1', own.id].sort());
    expect(s.cards.get(`${W}#recog`)?.suspended).toBe(true);
    expect(markIds(`marks/${pc.id}/2026-11.json`)).toEqual([own.id]);
    // Its blob id is not recorded: read again once fixed.
    putFile('marks/tablet-1/2026-10.json', pc.sync.encodeMarks('tablet-1', '2026-10', [mark('t0', T0 - 10 * 86400000, 'known', 'v:词3|ci3')]));
    await pc.sync.syncNow();
    s = pc.store.getState();
    expect(s.sync.warnings).toBeUndefined();
    expect(s.marks.map((x) => x.id).sort()).toEqual(['t0', 't1', own.id].sort());
  });

  it('a marks file from a newer app version is not applied and asks for an update', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    putFile('marks/tablet-1/2026-11.json', JSON.stringify({ device: 'tablet-1', month: '2026-11', v: 2, fields: ['id', 'note', 'a', 't'], marks: [['n1', W, 'known', T0]] }));
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(s.sync.updateNeeded).toBe(true);
    expect(s.sync.warnings?.[0]).toMatch(/Update the app/);
    expect(s.marks).toEqual([]);
    expect(Object.keys(await pc.db.kvGet<Record<string, string>>('syncShas', {}))).not.toContain('marks/tablet-1/2026-11.json');
  });

  it('marks files are never read as review logs', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    putFile('marks/tablet-1/2026-11.json', pc.sync.encodeMarks('tablet-1', '2026-11', [mark('t1', T0)]));
    putFile('marks/tablet-1/notes.txt', 'whatever');
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.sync.warnings).toBeUndefined();
    expect(s.events).toEqual([]);
    expect(s.marks.map((x) => x.id)).toEqual(['t1']);
  });

  it('an upload includes a mark written straight into the database by another tab', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    const m: StatusMark = { id: 'tab-mark', note: W, a: 'suspend', t: T0 + 5000, dev: pc.id, mo: '2026-11' };
    await pc.db.kvSet(`marks:${pc.id}:2026-11`, [m]);
    await pc.db.kvSet('marksDirty', { '2026-11': Date.now() + 1000 });
    await pc.sync.syncNow();
    expect(markIds(`marks/${pc.id}/2026-11.json`)).toEqual(['tab-mark']);
    expect(await pc.store.dirtyMarkMonths()).toEqual({});
  });

  it('linking sees an id used by marks files, and keeps the id of a device that has marks', async () => {
    const phone = await device();
    const old = phone.id;
    putFile(`marks/${old}/2026-10.json`, '{"v":1,"marks":[]}');
    await phone.sync.linkRepo(LINK);
    expect(phone.store.getState().device).not.toBe(old);

    const tablet = await device();
    await tablet.store.setNoteStatus(W, 'known', T0);
    putFile(`marks/${tablet.id}/2026-10.json`, '{"v":1,"marks":[]}');
    await expect(tablet.sync.linkRepo(LINK)).rejects.toThrow(/already uses the id/);
    expect(tablet.store.getState().device).toBe(tablet.id);
  });
});

describe('shared preferences', () => {
  it('the meaning language follows to the other device; per-device prefs do not', async () => {
    const pcLS = new MemStorage();
    const phoneLS = new MemStorage();
    vi.stubGlobal('localStorage', pcLS);
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    vi.stubGlobal('localStorage', phoneLS);
    const phone = await device();
    await phone.sync.linkRepo(LINK);

    vi.stubGlobal('localStorage', pcLS);
    pc.db.setPref('mode.recog', 'type-pinyin');
    pc.store.setLang('fr');
    await vi.waitFor(() => expect(pc.store.getState().settings.prefs?.lang).toBe('fr'), { timeout: 4000, interval: 100 });
    await pc.sync.syncNow();
    expect(JSON.parse(gh.text('settings.json')).prefs).toEqual({ lang: 'fr' });

    vi.stubGlobal('localStorage', phoneLS);
    await phone.sync.syncNow();
    expect(phone.store.getState().lang).toBe('fr');
    expect(phoneLS.getItem('hz.lang')).toBe('"fr"');
    expect(phoneLS.getItem('hz.mode.recog')).toBeNull();
    // Taking it in does not send it back.
    expect(await phone.db.kvGet('settingsDirty', false)).toBe(false);
  });

  it('an older app version saving settings keeps the shared prefs', async () => {
    const pc = await device();
    await pc.sync.linkRepo(LINK);
    pc.store.setLang('fr');
    await vi.waitFor(() => expect(pc.store.getState().settings.prefs?.lang).toBe('fr'), { timeout: 4000, interval: 100 });
    await pc.sync.syncNow();
    // An older version: {...current, ...patch}, uploaded whole.
    const cur = JSON.parse(gh.text('settings.json'));
    putFile('settings.json', JSON.stringify({ ...cur, newVocab: 4, updatedAt: Date.now() + 1000 }));
    await pc.sync.syncNow();
    expect(pc.store.getState().settings.newVocab).toBe(4);
    expect(pc.store.getState().settings.prefs).toEqual({ lang: 'fr' });
  });
});

describe('explanations', () => {
  const KEY = 'sk-ant-test-sync-0000';
  const ex5 = Array.from({ length: 5 }, (_, i) => ({ zh: `我们每天学习${i}个小时。`, pinyin: 'wǒmen …', tr: `example ${i}` }));
  const X = (summary: string) => ({ summary, senses: [{ meaning: 'm' }], register: 'neutral', nuance: [], collocations: [], patterns: [], mistakes: [], examples: ex5 });
  let claudeCalls = 0;
  let nextSummary = 'first';

  /** Anthropic's streamed answer with a forced tool call. */
  function sse(input: unknown): Response {
    const evs = [
      { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 1600, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'word_explanation', input: {} } },
      { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
      { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1500 } },
      { type: 'message_stop' },
    ];
    return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
  }

  beforeEach(() => {
    claudeCalls = 0;
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      if (url.host === 'api.anthropic.com') {
        expect((init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
        claudeCalls++;
        return sse(X(nextSummary));
      }
      expect(url.host).toBe('api.github.com');
      expect(JSON.stringify(init.body ?? '')).not.toContain('sk-ant');
      return gh.fetch(input, init);
    });
  });

  const explainFiles = () => [...gh.files.keys()].filter((p) => p.startsWith('explain/'));
  const fileOf = (sync: { decodeExplain(b: Uint8Array): unknown[] }, path: string) => sync.decodeExplain(gh.files.get(path)!.bytes) as { k: string; at: number; x: { summary: string } }[];
  const gz = (o: unknown) => gzipSync(new TextEncoder().encode(JSON.stringify(o)));
  function putBytes(path: string, bytes: Uint8Array) {
    const sha = `x${Math.random().toString(16).slice(2, 10)}`;
    gh.files.set(path, { sha, bytes });
    gh.blobs.set(sha, bytes);
  }

  it('one device explains, the other gets it without asking; no other file changes', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(4, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    await pc.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, T0 + 500);
    await pc.store.setNoteStatus('v:词3|ci3', 'st:mastered', T0 + 600);
    await pc.sync.syncNow();
    const before = new Map([...gh.files].map(([p, f]) => [p, f.sha]));

    const word = pc.store.getState().notes[1];
    await pc.explain.setClaudeKey(KEY);
    const e = await pc.explain.requestExplanation(word, 'fr');
    expect(claudeCalls).toBe(1);
    await pc.sync.syncNow();
    const path = `explain/${pc.id}/${pc.db.monthKey(e.at)}.json.gz`;
    expect(explainFiles()).toEqual([path]);
    const bytes = gh.files.get(path)!.bytes;
    expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
    const j = JSON.parse(new TextDecoder().decode(gunzipSync(bytes)));
    expect(j).toMatchObject({ device: pc.id, month: pc.db.monthKey(e.at), v: 1 });
    expect(Object.keys(j.entries[0]).sort()).toEqual(['at', 'hz', 'k', 'lang', 'model', 'pv', 'py', 'u', 'x']);
    expect(fileOf(pc.sync, path)).toEqual([{ k: `${word.id}|fr`, hz: word.hanzi, py: word.pinyin, lang: 'fr', at: e.at, model: 'claude-sonnet-5-5', pv: 1, u: [1600, 1500], x: e.x }]);
    expect(new TextDecoder().decode(gunzipSync(bytes))).not.toContain('sk-ant');
    expect(await pc.explain.dirtyExplainMonths()).toEqual({});
    // Reviews, marks, settings and the word list are untouched.
    for (const [p, sha] of before) expect(gh.files.get(p)?.sha).toBe(sha);

    await phone.sync.syncNow();
    const got = await phone.explain.getExplanation(word, 'fr');
    expect(got).toMatchObject({ k: e.k, at: e.at, dev: pc.id });
    expect(got?.x).toEqual(e.x);
    expect(await phone.explain.getExplanation(word, 'en')).toBeNull();
    expect((await phone.explain.requestExplanation(word, 'fr')).at).toBe(e.at);
    expect(claudeCalls).toBe(1);
    expect(phone.store.getState().events.map((x) => x.id)).toEqual(pc.store.getState().events.map((x) => x.id));
    expect(snapshot(phone.store.getState().cards)).toEqual(snapshot(pc.store.getState().cards));
    expect(phone.store.getState().marks.map((m) => m.a)).toEqual(['st:mastered']);
    // The phone does not send the computer's explanation back, and a sync with no change commits nothing.
    expect(explainFiles()).toEqual([path]);
    expect(await phone.explain.ownExplanations(pc.db.monthKey(e.at))).toEqual([]);
    const commits = gh.commits;
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(gh.commits).toBe(commits);
  });

  it('the newest explanation wins, both ways', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    const phone = await device();
    await phone.sync.linkRepo(LINK);
    const word = pc.store.getState().notes[0];
    await pc.explain.setClaudeKey(KEY);
    await phone.explain.setClaudeKey(KEY);

    nextSummary = 'pc 1';
    await pc.explain.requestExplanation(word, 'en');
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    nextSummary = 'phone 2';
    const p2 = await phone.explain.requestExplanation(word, 'en', { again: true });
    await phone.sync.syncNow();
    expect(explainFiles().sort()).toHaveLength(2);
    await pc.sync.syncNow();
    expect((await pc.explain.getExplanation(word, 'en'))?.x.summary).toBe('phone 2');
    nextSummary = 'pc 3';
    const p3 = await pc.explain.requestExplanation(word, 'en', { again: true });
    expect(p3.at).toBeGreaterThan(p2.at);
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect((await phone.explain.getExplanation(word, 'en'))?.x.summary).toBe('pc 3');
    expect((await pc.explain.getExplanation(word, 'en'))?.x.summary).toBe('pc 3');
    // An older file read later changes nothing.
    expect(await phone.explain.mergeExplanations('tablet-1', '2026-01', [{ ...p2, at: p2.at - 1 }])).toBe(false);
  });

  it('a file from a newer app version is not applied; a malformed entry is skipped; the rest syncs', async () => {
    const pc = await device();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkRepo(LINK);
    const W = 'v:词1|ci1';
    const good = { k: `${W}|en`, hz: '词1', py: 'cí', lang: 'en', at: T0, model: 'm', pv: 1, x: X('from tablet') };
    putBytes('explain/tablet-1/2026-11.json.gz', gz({ device: 'tablet-1', month: '2026-11', v: 2, entries: [good] }));
    putBytes('explain/tablet-2/2026-11.json.gz', gz({
      device: 'tablet-2',
      month: '2026-11',
      v: 1,
      entries: [{ ...good, k: 'v:词2|ci2|en', x: { summary: 'no examples' } }, { ...good, k: 'v:词0|ci0|xx' }, 'junk', { ...good, at: 'soon' }, { ...good, x: X('from tablet 2') }],
    }));
    putBytes('explain/tablet-3/2026-10.json.gz', new TextEncoder().encode('not gzip'));
    putFile('marks/tablet-1/2026-11.json', pc.sync.encodeMarks('tablet-1', '2026-11', [{ id: 't1', note: W, a: 'suspend', t: T0 + 1, dev: 'tablet-1' }]));
    const own = await pc.store.setNoteStatus('v:词2|ci2', 'known', T0 + 2000);
    await pc.sync.syncNow();

    const s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(s.sync.updateNeeded).toBe(true);
    expect(s.sync.warnings).toHaveLength(2);
    expect(s.sync.warnings!.some((w) => /Update the app to read the explanations 2026-11 of tablet-1/.test(w))).toBe(true);
    expect(s.sync.warnings!.some((w) => /Explanations 2026-10 of tablet-3 could not be read/.test(w))).toBe(true);
    const shas = await pc.db.kvGet<Record<string, string>>('syncShas', {});
    expect(Object.keys(shas)).not.toContain('explain/tablet-1/2026-11.json.gz');
    expect(Object.keys(shas)).not.toContain('explain/tablet-3/2026-10.json.gz');
    expect(Object.keys(shas)).toContain('explain/tablet-2/2026-11.json.gz');
    const n1 = s.noteMap.get(W)!;
    expect(await pc.explain.getExplanation(n1, 'en')).toMatchObject({ dev: 'tablet-2', x: { summary: 'from tablet 2' } });
    expect(await pc.explain.getExplanation(s.noteMap.get('v:词2|ci2')!, 'en')).toBeNull();
    expect((await pc.explain.explainUsage()).saved).toBe(1);
    // The rest went through.
    expect(s.cards.get(`${W}#recog`)?.suspended).toBe(true);
    expect(JSON.parse(gh.text(`marks/${pc.id}/2026-11.json`)).marks.map((r: unknown[]) => r[0])).toEqual([own.id]);
    expect(pc.sync.decodeExplain(pc.sync.encodeExplain('a', '2026-11', []))).toEqual([]);
    expect(() => pc.sync.decodeExplain(gz({ v: 1 }))).toThrow(/no explanation list/);
  });

  it('linking sees an id used only by explanation files', async () => {
    const phone = await device();
    const old = phone.id;
    putBytes(`explain/${old}/2026-10.json.gz`, phone.sync.encodeExplain(old, '2026-10', []));
    await phone.sync.linkRepo(LINK);
    expect(phone.store.getState().device).not.toBe(old);
  });
});

// ---------- OneDrive app folder (plan WP6) ----------

const START = `https://hugzgj9.github.io${import.meta.env.BASE_URL}`;
const DATA = 'Apps/Hugo Chinese/data';
let ms: FakeMicrosoft;
let loc: FakeLocation;

/** GitHub calls go to the fake GitHub, Anthropic to `claude` when set, everything else to the fake Microsoft. */
let claude: ((init: RequestInit) => Response) | null = null;
const routed = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
  if (url.host === 'api.github.com') return gh.fetch(String(input), init);
  if (url.host === 'api.anthropic.com' && claude) return claude(init);
  return ms.fetch(input, init);
};

function msSetup() {
  beforeEach(() => {
    ms = new FakeMicrosoft('test-client');
    ms.redirectUri = START;
    loc = new FakeLocation(START);
    claude = null;
    vi.stubEnv('VITE_MS_CLIENT_ID', 'test-client');
    vi.stubGlobal('fetch', routed);
    vi.stubGlobal('location', loc);
    vi.stubGlobal('history', loc.history);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });
}

/** A device signed in to Microsoft (its own tokens in its own database). */
async function msDevice(idb?: IDBFactory, signIn = true) {
  const d = await device(idb);
  const auth = await import('./ms/auth');
  if (signIn) await fakeSignIn(ms, loc, auth);
  return { ...d, auth };
}
type Dev = Awaited<ReturnType<typeof msDevice>>;

const odItem = (path: string) => ms.byPath(`${DATA}/${toOdName(path)}`);
const odText = (path: string) => new TextDecoder().decode(odItem(path)!.bytes);
const odPaths = () =>
  [...ms.items.values()]
    .filter((x) => x.folder === DATA)
    .map((x) => fromOdName(x.name) ?? `?${x.name}`)
    .sort();
function odPut(path: string, bytes: Uint8Array) {
  const it = odItem(path);
  if (it) ms.excelSave(it.id, bytes);
  else ms.addFile(`${DATA}/${toOdName(path)}`, bytes);
}
const dataPuts = () => ms.requests.filter((r) => r.method === 'PUT' && r.url.includes('/special/approot:/data/'));

/** The same tests through either store. */
interface Backend {
  link(d: Dev): Promise<void>;
  paths(): string[];
  text(path: string): string;
  put(path: string, bytes: Uint8Array): void;
  writes(): number;
  /** URL ending of a write of this path, to inject a race. */
  writeUrl(path: string): string;
}
const backends: Record<'github' | 'onedrive', Backend> = {
  github: {
    link: (d) => d.sync.linkRepo(LINK),
    paths: () => [...gh.files.keys()].sort(),
    text: (p) => gh.text(p),
    put: (p, bytes) => {
      const sha = `x${Math.random().toString(16).slice(2, 10)}`;
      gh.files.set(p, { sha, bytes });
      gh.blobs.set(sha, bytes);
    },
    writes: () => gh.commits,
    writeUrl: (p) => `/contents/${p}`,
  },
  onedrive: {
    link: (d) => d.sync.linkOneDrive(),
    paths: odPaths,
    text: odText,
    put: odPut,
    writes: () => dataPuts().length,
    writeUrl: (p) => `/data/${toOdName(p)}:/content`,
  },
};

const enc = (s: string) => new TextEncoder().encode(s);

describe.each(['github', 'onedrive'] as const)('sync through %s', (kind) => {
  msSetup();
  const B = backends[kind];

  it('two devices end with the same words, settings, reviews, statuses and cards; an idle sync writes nothing', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(12, T0));
    await pc.db.kvSet('vocabDirty', true);
    await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 2000, T0 + 1000);
    await B.link(pc);
    expect(pc.store.getState().sync.state).toBe('idle');
    expect(B.paths()).toEqual([`devices/${pc.id}.json`, `events/${pc.id}/2026-11.json`, 'settings.json', 'vocab.json.gz']);
    expect(JSON.parse(B.text(`devices/${pc.id}.json`))).toMatchObject({ id: pc.id, caps: 2 });
    await pc.store.updateSettings({ newVocab: 15 });
    await pc.sync.syncNow();

    const phone = await msDevice();
    await B.link(phone);
    let p = phone.store.getState();
    expect(p.notes).toHaveLength(12);
    expect(p.settings.newVocab).toBe(15);
    expect(p.events).toHaveLength(1);
    expect(snapshot(p.cards)).toEqual(snapshot(pc.store.getState().cards));
    expect(await phone.db.kvGet('vocabDirty', true)).toBe(false);

    await phone.store.recordReview('v:词2|ci2#recog', 1, 'type-pinyin', 2500, T0 + 86400000);
    const st = await phone.store.setNoteStatus('v:词3|ci3', 'st:mastered', T0 + 86400000 + 10);
    await phone.store.setNoteStatus('v:词4|ci4', 'suspend', T0 + 86400000 + 20);
    await phone.sync.syncNow();
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.events).toHaveLength(2);
    expect(s.marks.map((m) => m.id)).toContain(st.id);
    expect(s.cards.get('v:词4|ci4#recog')?.suspended).toBe(true);
    expect(snapshot(s.cards)).toEqual(snapshot(phone.store.getState().cards));

    const writes = B.writes();
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(B.writes()).toBe(writes);

    await pc.store.setVocab(vocab(14, T0 + 2 * 86400000, 'v2'));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    p = phone.store.getState();
    expect(p.notes).toHaveLength(14);
    expect(p.meta?.hash).toBe('h14v2');
    expect(snapshot(p.cards)).toEqual(snapshot(pc.store.getState().cards));
  });

  it('settings: the latest change wins', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await B.link(pc);
    const phone = await msDevice();
    await B.link(phone);
    await pc.store.updateSettings({ maxReviews: 200 });
    await new Promise((r) => setTimeout(r, 5));
    await phone.store.updateSettings({ maxReviews: 80 });
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    await pc.sync.syncNow();
    expect(pc.store.getState().settings.maxReviews).toBe(80);
    expect(phone.store.getState().settings.maxReviews).toBe(80);
  });

  it('an explanation made on one device reaches the other', async () => {
    const ex5 = Array.from({ length: 5 }, (_, i) => ({ zh: `我们每天学习${i}个小时。`, pinyin: 'wǒmen …', tr: `example ${i}` }));
    const x = { summary: 'from the pc', senses: [{ meaning: 'm' }], register: 'neutral', nuance: [], collocations: [], patterns: [], mistakes: [], examples: ex5 };
    claude = () => {
      const evs = [
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'word_explanation', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(x) } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
    };
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await B.link(pc);
    const phone = await msDevice();
    await B.link(phone);
    const word = pc.store.getState().notes[1];
    await pc.explain.setClaudeKey('sk-ant-test-0000');
    const e = await pc.explain.requestExplanation(word, 'fr');
    await pc.sync.syncNow();
    expect(B.paths()).toContain(`explain/${pc.id}/${pc.db.monthKey(e.at)}.json.gz`);
    await phone.sync.syncNow();
    expect((await phone.explain.getExplanation(word, 'fr'))?.x.summary).toBe('from the pc');
  });

  it('a write conflict pulls again and retries once', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await B.link(pc);
    const phone = await msDevice();
    await B.link(phone);
    await phone.store.updateSettings({ maxReviews: 80 });
    let conflicts = 0;
    let raced = false;
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      if (!raced && init.method === 'PUT' && new URL(String(input)).pathname.endsWith(B.writeUrl(SETTINGS))) {
        // The computer saves newer settings just before the phone's write lands (straight into the store: its sync
        // would wait on the phone's lock).
        raced = true;
        B.put(SETTINGS, enc(JSON.stringify({ ...pc.store.getState().settings, maxReviews: 50, updatedAt: Date.now() + 1000 }, null, 1) + '\n'));
      }
      const res = await routed(input, init);
      if (res.status === 409 || res.status === 412) conflicts++;
      return res;
    });
    await phone.sync.syncNow();
    expect(conflicts).toBe(1);
    expect(phone.store.getState().sync.state).toBe('idle');
    expect(phone.store.getState().settings.maxReviews).toBe(50);
    expect(JSON.parse(B.text(SETTINGS)).maxReviews).toBe(50);
  });

  it('keeps reviews made while offline and sends them later', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await B.link(pc);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('Failed to fetch');
    });
    await pc.store.recordReview('v:词0|ci0#recog', 3, 'reveal', 1000, T0 + 5000);
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.state).toBe('error');
    expect(pc.store.getState().sync.message).toMatch(/could not be reached/);
    expect(pc.sync.nextAutoSync()).toBeGreaterThan(Date.now());
    vi.stubGlobal('fetch', routed);
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.state).toBe('idle');
    expect(B.text(`events/${pc.id}/2026-11.json`)).toContain('v:词0|ci0#recog');
  });

  it('one unreadable file does not stop the rest of the sync', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(4, T0));
    await B.link(pc);
    const tab = (id: string, t: number): ReviewEvent => ({ id, card: 'v:词1|ci1#recog', r: 3, t, d: 1, m: 'reveal', dev: 'tablet-1' });
    B.put('events/tablet-1/2026-10.json', enc('{"events":[["a"'));
    B.put('events/tablet-1/2026-11.json', enc(pc.sync.encodeEvents('tablet-1', '2026-11', [tab('t1', T0 + 1)])));
    B.put(SETTINGS, enc('not json'));
    const ev = await pc.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, T0 + 2000);
    await pc.store.updateSettings({ newVocab: 7 });
    await pc.sync.syncNow();
    const s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(s.sync.warnings).toHaveLength(2);
    expect(s.events.map((e) => e.id).sort()).toEqual([ev.id, 't1'].sort());
    expect(JSON.parse(B.text(SETTINGS)).newVocab).toBe(7);
  });
});

const SETTINGS = 'settings.json';

describe('OneDrive app folder', () => {
  msSetup();

  it('flat names map back to the sync paths', () => {
    const paths = ['events/pc-1a2b3c4d/2026-11.json', 'marks/phone-0f0f0f0f/2027-01.json', 'explain/pc-1/2026-12.json.gz', 'devices/pc-1.json', 'vocab.json.gz', 'settings.json'];
    for (const p of paths) expect(fromOdName(toOdName(p))).toBe(p);
    expect(toOdName('events/pc-1/2026-11.json')).toBe('events.pc-1.2026-11.json');
    // Files that aren't sync files are ignored.
    for (const n of ['settings 1.json', 'events.pc-1.2026-11.json.tmp', 'notes.txt', 'events.pc.1.2026-11.json']) expect(fromOdName(n)).toBeNull();
  });

  it('lists every page; every write is conditional; nothing else is touched', async () => {
    ms.pageSize = 2;
    const other = ms.addFile('Documents/keep.txt', enc('mine'));
    const pc = await msDevice();
    await pc.store.setVocab(vocab(6, T0));
    for (let m = 0; m < 4; m++) await pc.store.recordReview(`v:词${m}|ci${m}#recog`, 3, 'reveal', 1000, Date.UTC(2026, 10 + m, 10));
    await pc.sync.linkOneDrive();
    expect(odPaths()).toHaveLength(7);
    const phone = await msDevice();
    await phone.sync.linkOneDrive();
    expect(phone.store.getState().events).toHaveLength(4);
    expect(ms.requests.some((r) => r.url.includes('$skiptoken'))).toBe(true);
    for (const r of dataPuts()) expect(!!r.headers['if-match'] || new URL(r.url).searchParams.get('@microsoft.graph.conflictBehavior') === 'fail').toBe(true);
    // Only the app folder; the Microsoft token only to Microsoft.
    expect(ms.requests.filter((r) => r.method !== 'GET' && !r.url.includes('/special/approot') && !r.url.includes('login.microsoftonline.com'))).toEqual([]);
    expect(ms.items.get(other.id)!.ver).toBe(1);
    for (const r of ms.requests) if (r.headers.authorization) expect(new URL(r.url).host).toBe('graph.microsoft.com');
  });

  it('two devices creating the same file: the second is refused (409), pulls again and retries once', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await pc.store.updateSettings({ newVocab: 4 });
    const phone = await msDevice();
    await phone.store.updateSettings({ newVocab: 6 });
    // Linked at the same moment: the phone listed an empty folder, then the pc created settings.json.
    let raced = false;
    let refused = 0;
    vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
      if (!raced && init.method === 'PUT' && String(input).includes('/data/settings.json:/content')) {
        raced = true;
        odPut(SETTINGS, enc(JSON.stringify({ ...pc.store.getState().settings, updatedAt: Date.now() + 1000 })));
      }
      const res = await routed(input, init);
      if (res.status === 409) refused++;
      return res;
    });
    await phone.sync.linkOneDrive();
    expect(refused).toBe(1);
    expect(phone.store.getState().sync.state).toBe('idle');
    expect(phone.store.getState().settings.newVocab).toBe(4);
  });

  it('sign-in expired: Reconnect, no back-off, nothing lost; sync resumes after signing in again', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(3, T0));
    await pc.sync.linkOneDrive();
    ms.expireRefresh();
    ms.revokeAccess();
    const ev = await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0 + 5000);
    await pc.sync.syncNow();
    let s = pc.store.getState();
    expect(s.sync.state).toBe('error');
    expect(s.sync.message).toMatch(/Reconnect to Microsoft/);
    expect(s.ms.state).toBe('reconnect');
    expect(pc.sync.nextAutoSync()).toBe(0);
    await pc.sync.syncNow();
    expect(pc.sync.nextAutoSync()).toBe(0);
    expect(await pc.store.dirtyMonths()).toHaveProperty('2026-11');

    await fakeSignIn(ms, loc, pc.auth);
    await pc.sync.syncNow();
    s = pc.store.getState();
    expect(s.sync.state).toBe('idle');
    expect(odText(`events/${pc.id}/2026-11.json`)).toContain(ev.id);
  });

  it('signed out: asks to sign in', async () => {
    const pc = await msDevice();
    await pc.sync.linkOneDrive();
    await pc.auth.msSignOut();
    await pc.sync.syncNow();
    expect(pc.store.getState().sync.message).toMatch(/Sign in with Microsoft/);
    expect(pc.sync.nextAutoSync()).toBe(0);
  });

  it('devices report their caps; an older one shows as caps 1; the own file follows the app version', async () => {
    odPut('devices/old-1.json', enc('{"id":"old-1","linkedAt":1}'));
    odPut('events/old-1/2026-10.json', enc('{"events":[]}'));
    const pc = await msDevice();
    await pc.sync.linkOneDrive();
    const phone = await msDevice();
    await phone.sync.linkOneDrive();
    await pc.sync.syncNow();
    const devs = await pc.sync.knownDevices();
    expect(devs[0]).toMatchObject({ id: pc.id, caps: 2 });
    expect(devs.find((d) => d.id === phone.id)).toMatchObject({ caps: 2 });
    expect(devs.find((d) => d.id === 'old-1')).toMatchObject({ caps: 1 });
    // A new app version rewrites the devices file once.
    const before = odItem(`devices/${pc.id}.json`)!.ver;
    await pc.db.kvSet('syncDeviceSig', { onedrive: '2|older' });
    await pc.sync.syncNow();
    await pc.sync.syncNow();
    expect(odItem(`devices/${pc.id}.json`)!.ver).toBe(before + 1);
    expect(JSON.parse(odText(`devices/${pc.id}.json`)).linkedAt).toBe(await pc.db.kvGet('syncOdLinkedAt', 0));
  });

  it('a device that relinks keeps its id; another device with the same id and reviews is refused', async () => {
    const pc = await msDevice();
    await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0);
    await pc.sync.linkOneDrive();
    await pc.sync.unlinkOneDrive();
    expect(pc.store.getState().sync.state).toBe('off');
    await pc.sync.linkOneDrive();
    expect(pc.store.getState().device).toBe(pc.id);
    const tablet = await msDevice();
    await tablet.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, T0);
    odPut(`devices/${tablet.id}.json`, enc('{"id":"x","linkedAt":1}'));
    await expect(tablet.sync.linkOneDrive()).rejects.toThrow(/already uses the id/);
    expect(await tablet.sync.syncTarget()).toBeNull();
  });
});

describe('shared import history (OneDrive)', () => {
  msSetup();
  type Since = NonNullable<VocabFile['colourSince']>;
  function qvocab(n: number, importedAt: number, qxh: string, modified: number, colourSince?: Since): VocabFile {
    const v = vocab(n, importedAt);
    return { ...v, source: { ...v.source, qxh, modified }, ...(colourSince ? { colourSince } : {}) };
  }

  it('same workbook content on both devices: one merged history, earliest times; then nothing to send', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(qvocab(6, T0, 'Q1', T0 - 1000, { a: ['mastered', T0 + 500], b: ['new', T0 + 100] }));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.linkOneDrive();
    const phone = await msDevice();
    await phone.store.setVocab(qvocab(6, T0 + 1000, 'Q1', T0 - 1000, { a: ['mastered', T0 + 200], b: ['notknown', T0 + 300], c: ['studying', T0 + 50] }));
    await phone.db.kvSet('vocabDirty', true);
    const shared: string[] = [];
    phone.sync.onSharedList((m) => shared.push(`${m.source.qxh}:${m.importedAt}`));
    await phone.sync.linkOneDrive();
    const want = { a: ['mastered', T0 + 200], b: ['new', T0 + 100], c: ['studying', T0 + 50] };
    expect(phone.store.getState().meta?.colourSince).toEqual(want);
    // Seeds: the earliest (the pc's import).
    expect(phone.store.getState().meta?.seeds['v:词0|ci0']).toBe(T0);
    expect(shared[0]).toBe(`Q1:${T0}`);
    const remote = JSON.parse(new TextDecoder().decode(gunzipSync(odItem('vocab.json.gz')!.bytes))) as VocabFile;
    expect(remote.colourSince).toEqual(want);
    await pc.sync.syncNow();
    expect(pc.store.getState().meta?.colourSince).toEqual(want);
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);
    const writes = dataPuts().length;
    await pc.sync.syncNow();
    await phone.sync.syncNow();
    expect(dataPuts().length).toBe(writes);
  });

  it('newer content in the folder is taken; newer content here takes the shared history, then imports again', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(qvocab(3, T0, 'QA', T0));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.linkOneDrive();

    const phone = await msDevice();
    const B4 = qvocab(4, T0 + 5000, 'QB', T0 + 4000);
    await phone.store.setVocab(B4);
    await phone.db.kvSet('vocabDirty', true);
    let rebased = 0;
    phone.sync.onRebase(async () => {
      rebased++;
      // What the workbook reader does: import the newer workbook on top of the list just taken.
      expect(phone.store.getState().meta?.source.qxh).toBe('QA');
      await phone.store.setVocab(B4);
      await phone.db.kvSet('vocabDirty', true);
    });
    const shared: string[] = [];
    phone.sync.onSharedList((m) => shared.push(m.source.qxh!));
    await phone.sync.linkOneDrive();
    await vi.waitFor(() => expect(JSON.parse(new TextDecoder().decode(gunzipSync(odItem('vocab.json.gz')!.bytes))).source.qxh).toBe('QB'), { timeout: 4000 });
    await vi.waitFor(() => expect(phone.store.getState().sync.state).toBe('idle'));
    expect(rebased).toBe(1);
    expect(shared).toEqual(['QA', 'QB']);

    await pc.sync.syncNow();
    expect(pc.store.getState().notes).toHaveLength(4);
    expect(pc.store.getState().meta?.source.qxh).toBe('QB');
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);
  });
});

describe('moving sync from GitHub to OneDrive', () => {
  msSetup();

  it('the moved device reads the old one through GitHub, never writes there, and stops once every device moved', async () => {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(6, T0));
    await pc.db.kvSet('vocabDirty', true);
    const r1 = await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0 + 1000);
    await pc.sync.linkRepo(LINK);
    const phone = await msDevice();
    await phone.sync.linkRepo(LINK);
    const r2 = await phone.store.recordReview('v:词2|ci2#recog', 3, 'reveal', 1000, T0 + 2000);
    await phone.sync.syncNow();

    // 1. The pc moves: a last GitHub sync, then everything it holds goes to OneDrive.
    await pc.sync.linkOneDrive();
    expect(await pc.sync.syncTarget()).toBe('onedrive');
    expect(pc.store.getState().sync).toMatchObject({ state: 'idle', repo: 'OneDrive' });
    expect(odPaths()).toEqual([`devices/${pc.id}.json`, `events/${pc.id}/2026-11.json`, 'settings.json', 'vocab.json.gz']);
    expect(pc.sync.decodeEvents(odText(`events/${pc.id}/2026-11.json`), pc.id).map((e) => e.id)).toEqual([r1.id]);
    expect(pc.store.getState().events.map((e) => e.id).sort()).toEqual([r1.id, r2.id].sort());
    expect(await pc.sync.githubReading()).toEqual({ on: true, waiting: [phone.id] });

    // 2. The phone (an older version) keeps writing to GitHub; the pc reads it there and passes the settings on.
    const r3 = await phone.store.recordReview('v:词3|ci3#recog', 4, 'reveal', 1000, T0 + 3000);
    const m3 = await phone.store.setNoteStatus('v:词4|ci4', 'st:mastered', T0 + 3100);
    await phone.store.updateSettings({ newVocab: 9 });
    await phone.sync.syncNow();
    const commits = gh.commits;
    await pc.sync.syncNow();
    expect(gh.commits).toBe(commits);
    let s = pc.store.getState();
    expect(s.events.map((e) => e.id)).toContain(r3.id);
    expect(s.marks.map((m) => m.id)).toContain(m3.id);
    expect(s.settings.newVocab).toBe(9);
    expect(JSON.parse(odText(SETTINGS)).newVocab).toBe(9);

    // 3. The phone moves too: its files are in OneDrive, the pc stops reading GitHub.
    await phone.sync.linkOneDrive();
    const moved = gh.commits;
    expect(odPaths()).toContain(`events/${phone.id}/2026-11.json`);
    expect(odPaths()).toContain(`marks/${phone.id}/2026-11.json`);
    await pc.sync.syncNow();
    expect(await pc.sync.githubReading()).toEqual({ on: false, waiting: [] });
    const r4 = await phone.store.recordReview('v:词5|ci5#recog', 3, 'reveal', 1000, T0 + 4000);
    await phone.sync.syncNow();
    const msCalls = ms.requests.length;
    await pc.sync.syncNow();
    s = pc.store.getState();
    expect(s.events.map((e) => e.id).sort()).toEqual([r1.id, r2.id, r3.id, r4.id].sort());
    expect(snapshot(s.cards)).toEqual(snapshot(phone.store.getState().cards));
    // Nothing writes to GitHub any more.
    expect(gh.commits).toBe(moved);
    expect(ms.requests.length).toBeGreaterThan(msCalls);
  });
});

// ---------- switching sync stores (safety-tests plan WP4) ----------

describe('switching sync stores', () => {
  msSetup();

  const DAY = 86400000;
  const VOCAB = 'vocab.json.gz';
  /** Put a file straight into the fake repository (another device's write). */
  const ghPut = (path: string, bytes: Uint8Array) => {
    const sha = `x${Math.random().toString(16).slice(2, 10)}`;
    gh.files.set(path, { sha, bytes });
    gh.blobs.set(sha, bytes);
  };
  const gz = (v: VocabFile) => gzipSync(enc(JSON.stringify(v)));
  const odVocab = () => JSON.parse(new TextDecoder().decode(gunzipSync(odItem(VOCAB)!.bytes))) as VocabFile;
  const vocabPuts = () => dataPuts().filter((r) => r.url.includes(`/data/${toOdName(VOCAB)}:`)).length;
  /** Route every call as usual, counting the ones that reach GitHub. */
  function countGitHub(): { calls: number } {
    const c = { calls: 0 };
    vi.stubGlobal('fetch', async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
      if (url.host === 'api.github.com') c.calls++;
      return routed(input, init);
    });
    return c;
  }
  /** pc and phone linked to GitHub, then the pc moves to OneDrive (the phone, an older version, stays). */
  async function moved() {
    const pc = await msDevice();
    await pc.store.setVocab(vocab(6, T0));
    await pc.db.kvSet('vocabDirty', true);
    await pc.sync.linkRepo(LINK);
    const phone = await msDevice();
    await phone.sync.linkRepo(LINK);
    await pc.sync.linkOneDrive();
    expect(await pc.sync.githubReading()).toEqual({ on: true, waiting: [phone.id] });
    return { pc, phone };
  }

  it('unlinkOneDrive with a repository still linked sends every month of reviews, marks and explanations to GitHub', async () => {
    const ex5 = Array.from({ length: 5 }, (_, i) => ({ zh: `我们每天学习${i}个小时。`, pinyin: 'wǒmen …', tr: `example ${i}` }));
    const x = { summary: 'mine', senses: [{ meaning: 'm' }], register: 'neutral', nuance: [], collocations: [], patterns: [], mistakes: [], examples: ex5 };
    claude = () => {
      const evs = [
        { type: 'message_start', message: { model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 1 } } },
        { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'word_explanation', input: {} } },
        { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(x) } },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 10 } },
        { type: 'message_stop' },
      ];
      return new Response(evs.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(''), { status: 200 });
    };
    const pc = await msDevice();
    await pc.store.setVocab(vocab(6, T0));
    await pc.db.kvSet('vocabDirty', true);
    const rOct = await pc.store.recordReview('v:词1|ci1#recog', 3, 'reveal', 1000, T0 - 10 * DAY);
    await pc.sync.linkRepo(LINK);
    const OCT = `events/${pc.id}/2026-10.json`;
    expect(fileIds(OCT)).toEqual([rOct.id]);
    await pc.sync.linkOneDrive();

    // Made after the move: sent to OneDrive only.
    const rNov = await pc.store.recordReview('v:词2|ci2#recog', 4, 'reveal', 1000, T0 + 1000);
    const mark = await pc.store.setNoteStatus('v:词3|ci3', 'st:mastered', T0 + 2000);
    await pc.explain.setClaudeKey('sk-ant-test-0000');
    const word = pc.store.getState().notes[1];
    const ex = await pc.explain.requestExplanation(word, 'fr');
    await pc.sync.syncNow();
    const NOV = `events/${pc.id}/2026-11.json`;
    const MARKS = `marks/${pc.id}/2026-11.json`;
    const EXPL = `explain/${pc.id}/${pc.db.monthKey(ex.at)}.json.gz`;
    expect(odPaths()).toEqual(expect.arrayContaining([NOV, MARKS, EXPL]));
    for (const p of [NOV, MARKS, EXPL]) expect(gh.files.has(p)).toBe(false);
    // A month already sent to GitHub before the move goes again too (here: lost from the repository meanwhile).
    gh.files.delete(OCT);

    await pc.sync.unlinkOneDrive();
    await pc.sync.syncNow();
    expect(await pc.sync.syncTarget()).toBe('github');
    expect(pc.store.getState().sync).toMatchObject({ state: 'idle', repo: 'me/data' });
    expect(fileIds(OCT)).toEqual([rOct.id]);
    expect(fileIds(NOV)).toEqual([rNov.id]);
    expect(pc.sync.decodeMarks(gh.text(MARKS), pc.id).map((m) => m.id)).toEqual([mark.id]);
    expect(pc.sync.decodeExplain(gh.files.get(EXPL)!.bytes).map((e) => [e.k, e.x.summary])).toEqual([[`${word.id}|fr`, 'mine']]);
    // Nothing left queued, and the OneDrive copies are untouched.
    expect(await pc.db.kvGet('dirty', {})).toEqual({});
    expect(await pc.db.kvGet('marksDirty', {})).toEqual({});
    expect(await pc.db.kvGet('explainDirty', {})).toEqual({});
    expect(odPaths()).toEqual(expect.arrayContaining([NOV, MARKS, EXPL]));
  });

  it('unlinkRepo while the target is OneDrive keeps OneDrive as the target, and sync keeps working', async () => {
    const { pc } = await moved();
    await pc.sync.unlinkRepo();
    expect(await pc.sync.syncTarget()).toBe('onedrive');
    expect(await pc.sync.getLink()).toBeNull();
    expect(await pc.sync.githubReading()).toBeNull();
    expect(pc.store.getState().sync.state).not.toBe('off');

    const gc = countGitHub();
    const commits = gh.commits;
    const r = await pc.store.recordReview('v:词4|ci4#recog', 3, 'reveal', 1000, T0 + 5000);
    await pc.sync.syncNow();
    expect(pc.store.getState().sync).toMatchObject({ state: 'idle', repo: 'OneDrive' });
    expect(pc.sync.decodeEvents(odText(`events/${pc.id}/2026-11.json`), pc.id).map((e) => e.id)).toContain(r.id);
    expect(gc.calls).toBe(0);
    expect(gh.commits).toBe(commits);
  });

  it('the read-only GitHub pull forwards a newer word list to OneDrive, not an older or identical one', async () => {
    const { pc } = await moved();
    const commits = gh.commits;
    const before = odVocab();
    expect(before.hash).toBe('h6');
    let puts = vocabPuts();

    // An older list on GitHub.
    ghPut(VOCAB, gz(vocab(5, T0 - DAY, 'old')));
    await pc.sync.syncNow();
    expect(pc.store.getState().meta?.hash).toBe('h6');
    expect(pc.store.getState().notes).toHaveLength(6);
    expect(vocabPuts()).toBe(puts);
    expect(odVocab()).toEqual(before);
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);

    // The same list as here, written again (new version tag).
    const { meta, notes } = pc.store.getState();
    ghPut(VOCAB, gz({ ...meta!, notes }));
    await pc.sync.syncNow();
    expect(pc.store.getState().meta?.hash).toBe('h6');
    expect(vocabPuts()).toBe(puts);
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);

    // A newer list: taken here and sent on to OneDrive in the same sync.
    ghPut(VOCAB, gz(vocab(8, T0 + DAY, 'v2')));
    await pc.sync.syncNow();
    expect(pc.store.getState().meta?.hash).toBe('h8v2');
    expect(pc.store.getState().notes).toHaveLength(8);
    expect(vocabPuts()).toBe(puts + 1);
    puts = vocabPuts();
    expect(odVocab()).toMatchObject({ hash: 'h8v2', importedAt: T0 + DAY });
    expect(await pc.db.kvGet('vocabDirty', true)).toBe(false);
    // Never written to GitHub.
    expect(gh.commits).toBe(commits);

    // Read once: the next sync does not forward it again.
    await pc.sync.syncNow();
    expect(vocabPuts()).toBe(puts);
  });

  it('stopReadingGitHub: the next sync no longer reads GitHub', async () => {
    const { pc, phone } = await moved();
    await pc.sync.stopReadingGitHub();
    expect(await pc.sync.githubReading()).toEqual({ on: false, waiting: [phone.id] });

    // The phone keeps writing to GitHub.
    const r = await phone.store.recordReview('v:词5|ci5#recog', 3, 'reveal', 1000, T0 + 6000);
    await phone.sync.syncNow();
    expect(fileIds(`events/${phone.id}/2026-11.json`)).toContain(r.id);

    const gc = countGitHub();
    const mine = await pc.store.recordReview('v:词0|ci0#recog', 3, 'reveal', 1000, T0 + 7000);
    await pc.sync.syncNow();
    expect(gc.calls).toBe(0);
    expect(pc.store.getState().sync.state).toBe('idle');
    expect(pc.store.getState().events.map((e) => e.id)).not.toContain(r.id);
    expect(pc.sync.decodeEvents(odText(`events/${pc.id}/2026-11.json`), pc.id).map((e) => e.id)).toContain(mine.id);
    // Still off at the following sync.
    await pc.sync.syncNow();
    expect(gc.calls).toBe(0);
    expect(await pc.sync.githubReading()).toEqual({ on: false, waiting: [phone.id] });
  });
});
