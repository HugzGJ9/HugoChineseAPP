// Two devices syncing through an in-memory stand-in for the GitHub API.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { Note, VocabFile } from './types';
import { fromBase64, toBase64 } from './github';

class FakeGitHub {
  files = new Map<string, { sha: string; bytes: Uint8Array }>();
  blobs = new Map<string, Uint8Array>();
  commits = 0;
  private next = 0;
  repos: Record<string, { private: boolean }> = { 'me/data': { private: true }, 'me/public': { private: false } };

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
      return json(200, { tree: [...this.files].map(([path, f]) => ({ path, type: 'blob', sha: f.sha })), truncated: false });
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

/** A fresh copy of the app's modules with their own empty IndexedDB: one device. */
async function device() {
  vi.resetModules();
  Dexie.dependencies.indexedDB = new IDBFactory();
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('./store');
  const sync = await import('./sync');
  const db = await import('./db');
  await store.init();
  return { store, sync, db, id: store.getState().device };
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
beforeEach(() => {
  gh = new FakeGitHub();
  vi.stubGlobal('fetch', gh.fetch);
});

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
