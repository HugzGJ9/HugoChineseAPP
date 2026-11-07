// Two devices syncing through an in-memory stand-in for the GitHub API.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { gzipSync } from 'fflate';
import type { Note, ReviewEvent, VocabFile } from './types';
import { fromBase64, toBase64 } from './github';

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
beforeEach(() => {
  gh = new FakeGitHub();
  vi.stubGlobal('fetch', gh.fetch);
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
        // The computer saves newer settings just before the phone's write lands.
        raced = true;
        await new Promise((r) => setTimeout(r, 2));
        await pc.store.updateSettings({ maxReviews: 50 });
        await pc.sync.syncNow();
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
