import 'fake-indexeddb/auto';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import Dexie from 'dexie';
import { gunzipSync, strFromU8 } from 'fflate';
import type { Note, VocabFile } from './types';

const T0 = Date.UTC(2026, 10, 1, 12);

/** A fresh copy of the app's modules, the log started first as in main.tsx. Pass the `idb` of another for a restart. */
async function device(idb = new IDBFactory()) {
  vi.resetModules();
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const log = await import('./devlog');
  const store = await import('./store');
  const db = await import('./db');
  log.startDevLog();
  await store.init();
  await log.flushDevLog();
  return { log, store, db, idb };
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'v:学习|xuexi',
    kind: 'vocab',
    hanzi: '学习',
    alts: [],
    pinyin: 'xuéxí',
    pinyinNum: 'xue2xi2',
    en: 'to study',
    fr: 'étudier',
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK四级', row: 2 }],
    order: 0,
    studied: false,
    examples: [],
    ...over,
  } as Note;
}

function vocab(notes: Note[]): VocabFile {
  return {
    version: 1,
    importedAt: T0,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: T0, size: 1000 },
    hash: 'h1',
    notes,
    issues: [],
    seeds: {},
    report: [],
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('scrub', () => {
  it('removes secrets', async () => {
    const { scrub } = await import('./devlog');
    expect(scrub('key sk-ant-api03-AbC_d-123 rejected')).toBe('key [secret] rejected');
    expect(scrub('token ghp_abcDEF123456 and gho_x1 and github_pat_11AB_cd')).toBe('token [secret] and [secret] and [secret]');
    expect(scrub('Join with hz1.eyJvIjoiaHVnbyIsIm4iOiJ2b2NhYiIsInQiOiJnaHBfeCJ9 here')).toBe('Join with [secret] here');
    expect(scrub('jwt eyJhbGciOi.eyJzdWIiOjF9.c2ln end')).toBe('jwt [secret] end');
    expect(scrub('Authorization: Bearer abc.def-ghi')).toBe('Authorization: Bearer [secret]');
    expect(scrub('{"refresh_token":"0.AXYZ","x":1}')).toBe('{"refresh_token":"[secret]","x":1}');
  });

  it('keeps the host of a URL, drops its path and token', async () => {
    const { scrub } = await import('./devlog');
    expect(scrub('GET https://login.microsoftonline.com/common/oauth2/token?code=SECRET123&state=a failed')).toBe(
      'GET login.microsoftonline.com failed',
    );
    expect(scrub('see http://localhost:4173/HugoChineseAPP/#/link/hz1.abc')).toBe('see localhost:4173');
    expect(scrub('redirect ?code=M.C5_abc&session_state=1')).toBe('redirect ?code=[secret]&session_state=1');
  });

  it('turns URLs on the app origin into file:line:col', async () => {
    vi.stubGlobal('location', { origin: 'https://hugzgj9.github.io' });
    const { scrub } = await import('./devlog');
    expect(scrub('at f (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:2345)')).toBe('at f (index-CfLuD67Z.js:1:2345)');
    expect(scrub('f@https://hugzgj9.github.io/HugoChineseAPP/assets/worker-x.js:3:9')).toBe('f@worker-x.js:3:9');
    expect(scrub('at https://api.github.com/repos/hugo/private/contents/x.json:1:2')).toBe('at api.github.com');
  });

  it('removes emails, workbook names and quoted names', async () => {
    const { scrub } = await import('./devlog');
    expect(scrub('Signed in as hugo.name+x@outlook.fr.')).toBe('Signed in as [email].');
    expect(scrub('Hugo_chinese_vocab.xlsx is no longer in “Chinois perso”.')).toBe('[workbook] is no longer in “…”.');
    expect(scrub('Hugo_chinese_vocab (app).xlsx was not written')).toBe('[workbook] was not written');
    expect(scrub('Could not read ‘Mon dossier’ or «Dossier»')).toBe('Could not read “…” or “…”');
    expect(scrub('Cannot read properties of undefined (reading \'note\')')).toBe("Cannot read properties of undefined (reading 'note')");
    expect(scrub('Bad name "a very long quoted name that is over the limit"')).toBe('Bad name "…"');
    expect(scrub("It couldn't open 'Café'")).toBe("It couldn't open '…'");
  });

  it('removes Chinese text and toned pinyin', async () => {
    const { scrub } = await import('./devlog');
    expect(scrub('row 5 of HSK四级 does not hold 学习')).toBe('row 5 of HSK… does not hold …');
    expect(scrub('word māma or nǐ hǎo')).toBe('word … or …');
    expect(scrub('ＡＢＣ and かな and 한국어')).toBe('… and … and …');
  });

  it('removes the source a V8 JSON error quotes, keeps a Safari one', async () => {
    const { scrub } = await import('./devlog');
    const v8 = 'Reviews 2026-10 of windows-9f8e could not be read (Unexpected token \'x\', "x{"hanzi":"学习","pinyin":"xuéxí","en":"to study"}" is not valid JSON). It is tried again at the next sync.';
    const out = scrub(v8);
    expect(out).toBe('Reviews 2026-10 of windows-9f8e could not be read (Unexpected token \'x\', "…" is not valid JSON). It is tried again at the next sync.');
    expect(scrub('JSON Parse error: Unexpected identifier "x"')).toBe('JSON Parse error: Unexpected identifier "x"');
    expect(scrub('Reviews 2026-10 of windows-9f8e could not be read')).toBe('Reviews 2026-10 of windows-9f8e could not be read');
  });

  it('caps the length', async () => {
    const { scrub } = await import('./devlog');
    expect(scrub('a'.repeat(1000)).length).toBe(300);
  });
});

describe('device log', () => {
  it('caps at 60 entries and counts repeats of the newest', async () => {
    const { log } = await device();
    log.logWarning('sync', 'same');
    log.logWarning('sync', 'same');
    log.logWarning('sync', 'same');
    expect(log.devLogEntries()).toHaveLength(1);
    expect(log.devLogEntries()[0].n).toBe(3);
    for (let i = 0; i < 70; i++) log.logWarning('excel', `w${i}`);
    expect(log.devLogEntries()).toHaveLength(60);
    expect(log.devLogEntries().at(-1)!.msg).toBe('w69');
    log.recordError(new TypeError('boom'));
    expect(log.devLogSummary()).toEqual({ errors: 1, warnings: 59 });
  });

  it('logs a store warning once and ignores unrelated changes', async () => {
    const { log, store } = await device();
    const changes = vi.fn();
    log.onDevLogChange(changes);
    store.setSync({ state: 'idle', repo: 'hugo/private-vocab', warnings: ['Reviews 2026-10 of windows-9f8e could not be read'] });
    store.setSync({ state: 'running' });
    store.setSync({ state: 'idle', last: Date.now() });
    await store.setVocab(vocab([note()]));
    expect(log.devLogEntries().map((e) => e.msg)).toEqual(['Reviews 2026-10 of windows-9f8e could not be read']);
    expect(changes).toHaveBeenCalledTimes(1);

    store.setSync({ state: 'error', message: 'Bad credentials' });
    store.setSync({ state: 'error', message: 'Bad credentials' });
    store.setExcel({ state: 'ok', name: 'Secret workbook name', path: '/Documents/Private', writeError: 'Write failed' });
    store.setExcel({ stuck: 2 });
    store.setFolder({ state: 'missing', name: 'Mon dossier', message: 'Hugo_chinese_vocab.xlsx is no longer in “Mon dossier”.' });
    store.setMs({ state: 'reconnect', account: 'hugo@outlook.fr', message: 'Microsoft sign-in expired. Reconnect to continue.' });
    store.setSync({ updateNeeded: true });
    const kinds = log.devLogEntries().map((e) => `${e.kind}: ${e.msg}`);
    expect(kinds).toEqual([
      'sync: Reviews 2026-10 of windows-9f8e could not be read',
      'sync: Bad credentials',
      'excel: Write failed',
      'excel: 2 statuses stuck: their rows no longer hold the expected word.',
      'folder: [workbook] is no longer in “…”.',
      'ms: Microsoft sign-in expired. Reconnect to continue.',
      'sync: The synced data was saved by a newer app version: update needed.',
    ]);
    const all = JSON.stringify(log.devLogEntries());
    for (const s of ['private-vocab', 'Secret workbook', 'Private', 'Mon dossier', 'hugo@']) expect(all).not.toContain(s);
  });

  it('captures uncaught errors and rejections, not ResizeObserver noise', async () => {
    vi.stubGlobal('location', { origin: 'https://hugzgj9.github.io' });
    const win = new EventTarget();
    vi.stubGlobal('window', win);
    const { log } = await device();
    const err = new TypeError("Cannot read properties of undefined (reading 'note')");
    err.stack = [
      "TypeError: Cannot read properties of undefined (reading 'note')",
      '    at row (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:2345)',
      '    at a (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:10)',
      '    at b (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:20)',
      '    at c (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:30)',
      '    at d (https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js:1:40)',
    ].join('\n');
    const ev = Object.assign(new Event('error'), {
      message: err.message,
      error: err,
      filename: 'https://hugzgj9.github.io/HugoChineseAPP/assets/index-CfLuD67Z.js',
      lineno: 1,
      colno: 2345,
    });
    win.dispatchEvent(ev);
    win.dispatchEvent(Object.assign(new Event('error'), { message: 'ResizeObserver loop completed with undelivered notifications.' }));
    win.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'Failed to fetch 学习' }));
    const [e1, e2] = log.devLogEntries();
    expect(log.devLogEntries()).toHaveLength(2);
    expect(e1).toMatchObject({ kind: 'error', msg: "TypeError: Cannot read properties of undefined (reading 'note')", at: 'index-CfLuD67Z.js:1:2345' });
    expect(e1.stack!.split('\n')).toHaveLength(4);
    expect(e1.stack).not.toContain('github.io');
    expect(e2).toMatchObject({ kind: 'rejection', msg: 'Failed to fetch …' });
  });

  it('keeps entries across a restart and clears them', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const a = await device();
    a.log.logWarning('folder', 'Could not read the folder: NotFoundError');
    vi.advanceTimersByTime(1100);
    await a.log.flushDevLog();
    vi.useRealTimers();
    const row = (await a.db.kvGet<{ v: number; entries: unknown[] } | null>('devlog', null))!;
    expect(row.v).toBe(1);
    expect(row.entries).toHaveLength(1);

    a.db.db.close();
    const b = await device(a.idb);
    b.log.logWarning('sync', 'later');
    expect(b.log.devLogEntries().map((e) => e.msg)).toEqual(['Could not read the folder: NotFoundError', 'later']);
    await b.log.flushDevLog();
    await b.log.clearDevLog();
    expect(b.log.devLogEntries()).toEqual([]);
    expect(await b.db.kvGet('devlog', null)).toBeNull();
  });

  it('writes diagnostics without words, names, account, repo or keys; backups hold no log', async () => {
    const { log, store, db } = await device();
    await store.setVocab(vocab([note()]));
    await db.kvSet('syncTarget', 'onedrive');
    await db.kvSet('claudeKey', 'sk-ant-api03-SECRETKEY');
    store.setSync({ state: 'idle', repo: 'hugo/private-vocab', last: Date.now() - 3 * 60000 });
    store.setMs({ state: 'ok', account: 'hugo@outlook.fr' });
    store.setExcel({ state: 'ok', name: 'Hugo_chinese_vocab.xlsx', path: '/Documents/Chinois', pending: 0 });
    store.setFolder({ state: 'ok', name: 'Chinois perso' });
    store.setSync({
      warnings: [
        'Reviews 2026-10 of windows-9f8e could not be read (Unexpected token \'x\', "x{"hanzi":"学习","pinyin":"xuéxí","en":"to study","fr":"étudier"}" is not valid JSON). It is tried again at the next sync.',
      ],
    });
    log.logWarning('sync', 'Join with hz1.eyJvIjoiaHVnbyJ9 failed');
    log.recordError(new Error('Claude said no to sk-ant-api03-SECRETKEY for 学习'));
    store.setFolder({ state: 'error', message: 'Could not read the folder: “Chinois perso” is gone' });

    const text = await log.diagnosticsText();
    expect(text).toMatch(/^Hugo 中文 diagnostics, \d{4}-\d\d-\d\d \d\d:\d\d \(UTC[+-]\d\d:\d\d\)/);
    expect(text).toMatch(new RegExp(`\\nApp \\w+ · ${store.getState().device} · browser tab · \\w+ · online\\n`));
    expect(text).toContain('Data: 1 words, 0 reviews, 0 marks');
    expect(text).toContain('Start: ready in ');
    expect(text).toContain('cards n/a');
    expect(text).toContain('Sync: OneDrive, idle, last ');
    expect(text).toContain('(3 min ago)');
    expect(text).toContain('Microsoft: ok');
    expect(text).toContain('Problems (newest first):');
    expect(text).toContain('windows-9f8e could not be read');
    for (const s of ['学习', '学', 'xuéxí', 'to study', 'étudier', 'hugo@', 'outlook', 'private-vocab', 'Hugo_chinese_vocab', 'Chinois', 'SECRETKEY', 'sk-ant', 'hz1.']) {
      expect(text, s).not.toContain(s);
    }
    // The problems are newest first.
    const problems = text.split('Problems (newest first):\n')[1].split('\n');
    expect(problems[0]).toContain('folder Could not read the folder: “…” is gone');

    await log.flushDevLog();
    const { buildBackup } = await import('./backup');
    const json = strFromU8(gunzipSync((await buildBackup()).bytes));
    expect(json).not.toContain('devlog');
    expect(json).not.toContain('windows-9f8e could not be read');
  });

  it('reads the card timings when the start measured them', async () => {
    const { log } = await device();
    performance.measure('hz:cards', { start: 0, end: 38, detail: { total: 1810, cached: 1806, replayed: 4, full: false } });
    try {
      expect(await log.diagnosticsText()).toContain('cards 38 ms, 1806 of 1810 from cache');
    } finally {
      performance.clearMeasures('hz:cards');
    }
  });
});
