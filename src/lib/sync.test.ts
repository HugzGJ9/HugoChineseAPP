// Two devices syncing through an in-memory stand-in for the GitHub API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { gzipSync } from 'fflate';
import type { Note, ReviewEvent, StatusMark, VocabFile } from './types';
import { fromBase64, toBase64 } from './github';
import { latestMarks } from './engine/schedule';
import { sheetRows } from './status';

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
  await store.init();
  return { store, sync, db, idb, id: store.getState().device };
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
