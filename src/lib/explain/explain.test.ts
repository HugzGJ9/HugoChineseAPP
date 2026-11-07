// Claude client and explanation cache, against a mocked fetch (never the real API). Keys are fake.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import type { Note, VocabFile } from '../types';
import type { ExplainEntry, Explanation } from './types';

const KEY = 'sk-ant-test-0123456789abcdefSECRET1a2b';

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

async function app() {
  vi.resetModules();
  Dexie.dependencies.indexedDB = new IDBFactory();
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const store = await import('../store');
  const db = await import('../db');
  const ex = await import('./index');
  const claude = await import('./claude');
  const prompt = await import('./prompt');
  claude.claudeTiming.retry = 0;
  await store.init();
  return { store, db, ex, claude, prompt };
}

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'v:学习|xuexi',
    kind: 'vocab',
    hanzi: '学习',
    alts: [],
    pinyin: 'xuéxí',
    pinyinNum: 'xue2 xi2',
    en: 'to study',
    fr: 'étudier',
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK五级', row: 3 }],
    order: 0,
    studied: false,
    examples: [{ zh: '我在学习中文。', pinyin: 'wǒ zài xuéxí zhōngwén.', en: 'I am studying Chinese.' }],
    group: '12',
    ...over,
  };
}

function vocab(notes: Note[], aliases?: Record<string, string>): VocabFile {
  return {
    version: 1,
    importedAt: 1,
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: 1, size: 1 },
    hash: 'h',
    notes,
    issues: [],
    seeds: {},
    report: [],
    ...(aliases ? { aliases } : {}),
  };
}

const ex5 = (w = '学习') => Array.from({ length: 5 }, (_, i) => ({ zh: `我们每天${w}${i}个小时。`, pinyin: 'wǒmen …', tr: `example ${i}` }));
const GOOD: Explanation = {
  summary: '  To learn, to study: acquiring knowledge or a skill.  ',
  senses: [{ meaning: 'to study', pos: 'verb' }],
  register: 'neutral',
  nuance: [{ word: '读书', pinyin: 'dú shū', diff: 'school study' }],
  collocations: [
    { zh: '学习中文', pinyin: 'xuéxí zhōngwén', tr: 'study Chinese' },
    { zh: '努力学习', pinyin: 'nǔlì xuéxí', tr: 'study hard' },
    { zh: '学习方法', pinyin: 'xuéxí fāngfǎ', tr: 'study method' },
  ],
  patterns: [],
  mistakes: [],
  examples: ex5(),
};

/** A streamed answer: the tool input split into several deltas, and the bytes split mid-line. */
function sse(input: unknown, opts: { error?: { type: string; message: string }; signal?: AbortSignal | null; hang?: boolean } = {}): Response {
  const json = typeof input === 'string' ? input : JSON.stringify(input);
  const parts = [json.slice(0, 20), json.slice(20, 200), json.slice(200)];
  const evs: object[] = [
    { type: 'message_start', message: { model: 'claude-sonnet-5-5-20261001', usage: { input_tokens: 1500, cache_read_input_tokens: 100, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'word_explanation', input: {} } },
    { type: 'ping' },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: parts[0] } },
    ...(opts.error ? [{ type: 'error', error: opts.error }] : []),
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: parts[1] } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: parts[2] } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 1400 } },
    { type: 'message_stop' },
  ];
  const text = evs.map((e) => `event: ${(e as { type: string }).type}\r\ndata: ${JSON.stringify(e)}\r\n\r\n`).join('');
  const bytes = new TextEncoder().encode(text);
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      opts.signal?.addEventListener('abort', () => c.error(new DOMException('aborted', 'AbortError')));
      if (opts.hang) return;
      for (let i = 0; i < bytes.length; i += 97) c.enqueue(bytes.slice(i, i + 97));
      c.close();
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
}

const apiError = (status: number, type: string, message: string, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify({ type: 'error', error: { type, message } }), { status, headers: { 'content-type': 'application/json', ...headers } });

interface Call {
  url: string;
  init: RequestInit;
}
let calls: Call[];
let answers: ((init: RequestInit) => Response | Promise<Response>)[];

function mockFetch() {
  calls = [];
  answers = [];
  vi.stubGlobal('fetch', async (input: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(input), init });
    const a = answers.shift();
    if (!a) throw new TypeError('no answer queued');
    return a(init);
  });
}

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
  mockFetch();
});
afterEach(() => {
  // Every request went to Anthropic only.
  for (const c of calls) expect(new URL(c.url).host).toBe('api.anthropic.com');
  vi.unstubAllGlobals();
});

const errorOf = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    return e as Error & { kind: string; status: number; retryAfter?: number };
  }
  throw new Error('did not fail');
};

describe('Claude request', () => {
  it('sends the documented request and saves the entry', async () => {
    const { ex, store, db } = await app();
    await store.setVocab(vocab([note(), note({ id: 'v:学生|xuesheng', hanzi: '学生', order: 1 }), note({ id: 'v:书|shu', hanzi: '书', group: '9', order: 2 })]));
    await ex.setClaudeKey(KEY);
    answers.push(() => sse(GOOD));
    const e = await ex.requestExplanation(note(), 'fr', { dict: 'xue2 xi2: to learn/to study' });

    expect(calls).toHaveLength(1);
    const { url, init } = calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      'x-api-key': KEY,
      'anthropic-version': '2023-06-01',
      'anthropic-dangerous-direct-browser-access': 'true',
      'content-type': 'application/json',
    });
    const body = JSON.parse(String(init.body));
    expect(body).toMatchObject({ model: 'claude-sonnet-5-5', max_tokens: 4096, stream: true, tool_choice: { type: 'tool', name: 'word_explanation' } });
    expect(body.temperature).toBeUndefined();
    expect(body.tools[0].name).toBe('word_explanation');
    expect(body.system[0]).toMatchObject({ type: 'text', cache_control: { type: 'ephemeral' } });
    expect(body.system[0].text).toMatch(/in French/);
    const user: string = body.messages[0].content;
    expect(user).toContain('Word: 学习 (xuéxí), vocabulary word, sheet HSK五级');
    expect(user).toContain('"to study" (EN, his list) / "étudier" (FR, his list)');
    expect(user).toContain('Dictionary (CC-CEDICT): xue2 xi2: to learn/to study');
    expect(user).toContain('Related words he is learning: 学生');
    expect(user).not.toContain('书');
    expect(user).toContain('His example: 我在学习中文。');
    expect(user).toMatch(/Answer in French\.$/);
    // No ids, no progress.
    expect(JSON.stringify(body)).not.toContain('v:学习');

    expect(e).toMatchObject({ k: 'v:学习|xuexi|fr', hz: '学习', py: 'xuéxí', lang: 'fr', model: 'claude-sonnet-5-5-20261001', pv: 1, u: [1600, 1400] });
    expect(e.x.summary).toBe('To learn, to study: acquiring knowledge or a skill.');
    expect(e.x.examples).toHaveLength(5);
    expect(await ex.getExplanation(note(), 'fr')).toEqual(e);
    expect(await ex.getExplanation(note(), 'en')).toBeNull();
    const month = db.monthKey(e.at);
    expect(Object.keys(await ex.dirtyExplainMonths())).toEqual([month]);
    expect(await ex.ownExplanations(month)).toEqual([expect.not.objectContaining({ dev: expect.anything() })]);
    expect((await ex.ownExplanations(month))[0].k).toBe(e.k);
    const usage = await ex.explainUsage();
    expect(usage).toMatchObject({ saved: 1, mineThisMonth: 1 });
    expect(usage.costThisMonth).toBeCloseTo((1600 * 3 + 1400 * 15) / 1e6, 6);

    // Cached: no second call.
    expect((await ex.requestExplanation(note(), 'fr')).at).toBe(e.at);
    expect(calls).toHaveLength(1);
  });

  it('two requests at once make one call; progress and the job are visible meanwhile', async () => {
    const { ex } = await app();
    await ex.setClaudeKey(KEY);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    answers.push(async () => {
      await gate;
      return sse(GOOD);
    });
    let changes = 0;
    ex.onExplainChange(() => changes++);
    const a = ex.requestExplanation(note(), 'en');
    const b = ex.requestExplanation(note(), 'en');
    expect(ex.explainJob(note(), 'en')).toMatchObject({ chars: 0 });
    expect(ex.explainJob(note(), 'fr')).toBeNull();
    await vi.waitFor(() => expect(calls).toHaveLength(1));
    release();
    const [x, y] = await Promise.all([a, b]);
    expect(x).toEqual(y);
    expect(calls).toHaveLength(1);
    expect(ex.explainJob(note(), 'en')).toBeNull();
    expect(changes).toBeGreaterThanOrEqual(2);
  });

  it('"again" asks once more and saves a newer entry', async () => {
    const { ex } = await app();
    await ex.setClaudeKey(KEY);
    answers.push(() => sse(GOOD), () => sse({ ...GOOD, summary: 'Second answer.' }));
    const first = await ex.requestExplanation(note(), 'en');
    const second = await ex.requestExplanation(note(), 'en', { again: true });
    expect(calls).toHaveLength(2);
    expect(second.at).toBeGreaterThan(first.at);
    expect(second.x.summary).toBe('Second answer.');
    expect((await ex.getExplanation(note(), 'en'))?.x.summary).toBe('Second answer.');
  });

  it('finds an explanation saved under the id the word had before a rename', async () => {
    const { ex, store } = await app();
    const renamed = note({ id: 'v:学习|xuexi2' });
    await store.setVocab(vocab([renamed], { 'v:学习|xuexi': 'v:学习|xuexi2' }));
    const old: ExplainEntry = { k: 'v:学习|xuexi|en', hz: '学习', py: 'xuéxí', lang: 'en', at: 5, model: 'm', pv: 1, x: GOOD };
    expect(await ex.mergeExplanations('iphone-1', '2026-11', [old])).toBe(true);
    expect((await ex.getExplanation(renamed, 'en'))?.at).toBe(5);
    expect((await ex.getExplanation(renamed, 'en'))?.dev).toBe('iphone-1');
    // No key and no call needed for it.
    expect((await ex.requestExplanation(renamed, 'en')).at).toBe(5);
    expect(calls).toHaveLength(0);
    // A merged entry is not this device's: never uploaded from here.
    expect(await ex.ownExplanations('2026-11')).toEqual([]);
  });
});

describe('errors', () => {
  it('no key, offline', async () => {
    const { ex } = await app();
    expect(await ex.hasClaudeKey()).toBe(false);
    const e = await errorOf(ex.requestExplanation(note(), 'en'));
    expect(e).toBeInstanceOf(ex.ClaudeError);
    expect(e.kind).toBe('nokey');
    expect(e.message).toMatch(/Add your Claude API key/);
    expect(ex.explainJob(note(), 'en')?.error?.kind).toBe('nokey');
    await ex.setClaudeKey(KEY);
    vi.stubGlobal('navigator', { onLine: false });
    expect((await errorOf(ex.requestExplanation(note(), 'en'))).kind).toBe('offline');
    expect(calls).toHaveLength(0);
  });

  it('maps HTTP errors, retries 529 once, and never shows the key', async () => {
    const { ex } = await app();
    await ex.setClaudeKey(KEY);
    const cases: [Response[], string, number][] = [
      [[apiError(401, 'authentication_error', 'invalid x-api-key')], 'key', 1],
      [[apiError(400, 'invalid_request_error', 'Your credit balance is too low to access the Anthropic API.')], 'credit', 1],
      [[apiError(404, 'not_found_error', 'model: claude-sonnet-5-5')], 'model', 1],
      [[apiError(403, 'permission_error', 'no access')], 'model', 1],
      [[apiError(529, 'overloaded_error', 'Overloaded'), apiError(529, 'overloaded_error', 'Overloaded')], 'busy', 2],
      [[apiError(500, 'api_error', 'Internal'), apiError(500, 'api_error', 'Internal')], 'busy', 2],
      [[apiError(400, 'invalid_request_error', `bad header ${KEY}`)], 'other', 1],
    ];
    for (const [res, kind, n] of cases) {
      calls = [];
      answers = res.map((r) => () => r);
      const e = await errorOf(ex.requestExplanation(note(), 'en'));
      expect([e.kind, calls.length]).toEqual([kind, n]);
      expect(e.message).not.toContain(KEY);
      expect(e.message).not.toContain('SECRET');
      expect(String(e.stack)).not.toContain(KEY);
    }
    calls = [];
    answers = [() => apiError(429, 'rate_limit_error', 'slow down', { 'retry-after': '12' })];
    const e = await errorOf(ex.requestExplanation(note(), 'en'));
    expect([e.kind, e.status, e.retryAfter, calls.length]).toEqual(['rate', 429, 12, 1]);
    expect(e.message).toBe('Too many requests. Try again in 12 s.');
  });

  it('a mid-stream error: retried once when overloaded, then reported', async () => {
    const { ex } = await app();
    await ex.setClaudeKey(KEY);
    answers.push(() => sse(GOOD, { error: { type: 'overloaded_error', message: 'Overloaded' } }), () => sse(GOOD));
    expect((await ex.requestExplanation(note(), 'en')).x.examples).toHaveLength(5);
    expect(calls).toHaveLength(2);

    answers.push(
      () => sse(GOOD, { error: { type: 'overloaded_error', message: 'Overloaded' } }),
      () => sse(GOOD, { error: { type: 'overloaded_error', message: 'Overloaded' } }),
    );
    const e = await errorOf(ex.requestExplanation(note(), 'fr'));
    expect(e.kind).toBe('busy');
    expect(e.message).toBe('Claude is busy. Try again in a minute.');
    expect(ex.explainJob(note(), 'fr')?.error?.kind).toBe('busy');
    expect(await ex.getExplanation(note(), 'fr')).toBeNull();
    // Retry after an error starts a new job.
    answers.push(() => sse(GOOD));
    expect((await ex.requestExplanation(note(), 'fr')).lang).toBe('fr');
    expect(ex.explainJob(note(), 'fr')).toBeNull();
  });

  it('unreadable output is asked once more, then reported as invalid', async () => {
    const { ex } = await app();
    await ex.setClaudeKey(KEY);
    answers.push(() => sse('{"summary": "x", "exam'), () => sse({ ...GOOD, examples: GOOD.examples.slice(0, 2) }));
    const e = await errorOf(ex.requestExplanation(note(), 'en'));
    expect([e.kind, calls.length]).toEqual(['invalid', 2]);
    expect(e.message).toBe('The answer could not be read. Try again.');
    answers.push(() => sse({ nope: 1 }), () => sse(GOOD));
    expect((await ex.requestExplanation(note(), 'en')).x.summary).toMatch(/^To learn/);
    expect(calls).toHaveLength(4);
  });

  it('network failure and timeouts', async () => {
    const { ex, claude } = await app();
    await ex.setClaudeKey(KEY);
    answers.push(() => {
      throw new TypeError('Failed to fetch');
    });
    expect((await errorOf(ex.requestExplanation(note(), 'en'))).kind).toBe('network');
    claude.claudeTiming.idle = 50;
    answers.push((init) => sse(GOOD, { signal: init.signal, hang: true }));
    const e = await errorOf(ex.requestExplanation(note(), 'en'));
    expect(e.kind).toBe('timeout');
    expect(e.message).toBe('Claude took too long. Try again.');
  });
});

describe('the key', () => {
  it('stays in this device database only, with a masked hint', async () => {
    const { ex, db } = await app();
    await ex.setClaudeKey(`  ${KEY}\n`);
    expect(await ex.hasClaudeKey()).toBe(true);
    const hint = await ex.claudeKeyHint();
    expect(hint?.hint).toBe('sk-ant-…1a2b');
    expect(hint?.savedAt).toBeGreaterThan(0);
    expect((await db.kvGet<{ key: string }>('claudeKey', { key: '' })).key).toBe(KEY);
    const ls = localStorage as MemStorage;
    for (let i = 0; i < ls.length; i++) expect(ls.getItem(ls.key(i)!)).not.toContain('sk-ant');
    await ex.removeClaudeKey();
    expect(await ex.hasClaudeKey()).toBe(false);
    expect(await ex.claudeKeyHint()).toBeNull();
  });

  it('is tested by listing the models', async () => {
    const { ex } = await app();
    answers.push(() => new Response(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }, { id: 'claude-sonnet-5-5-20261001' }], has_more: false }), { status: 200 }));
    expect(await ex.testClaudeKey(KEY)).toEqual({ checked: true, modelListed: true });
    expect(calls[0].url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/models/);
    expect(calls[0].init.method).toBe('GET');
    expect((calls[0].init.headers as Record<string, string>)['x-api-key']).toBe(KEY);
    expect((calls[0].init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe('true');

    answers.push(() => new Response(JSON.stringify({ data: [{ id: 'claude-haiku-5-5' }] }), { status: 200 }));
    expect(await ex.testClaudeKey(KEY)).toEqual({ checked: true, modelListed: false });
    answers.push(() => apiError(401, 'authentication_error', 'invalid x-api-key'));
    const e = await errorOf(ex.testClaudeKey(KEY));
    expect(e.kind).toBe('key');
    expect(e.message).not.toContain(KEY);
    answers.push(() => {
      throw new TypeError('CORS');
    });
    expect(await ex.testClaudeKey(KEY)).toEqual({ checked: false });
    // Testing does not save.
    expect(await ex.hasClaudeKey()).toBe(false);
  });
});

describe('merge', () => {
  const entry = (at: number, summary = 's', k = 'v:学习|xuexi|en'): ExplainEntry => ({ k, hz: '学习', py: 'xuéxí', lang: 'en', at, model: 'm', pv: 1, x: { ...GOOD, summary } });

  it('the newest wins; on a tie the larger device id', async () => {
    const { ex } = await app();
    const n = note();
    expect(await ex.mergeExplanations('iphone-b', '2026-11', [entry(10, 'b10')])).toBe(true);
    expect(await ex.mergeExplanations('iphone-a', '2026-11', [entry(9, 'a9')])).toBe(false);
    expect((await ex.getExplanation(n, 'en'))?.x.summary).toBe('b10');
    expect(await ex.mergeExplanations('iphone-a', '2026-11', [entry(10, 'a10')])).toBe(false);
    expect(await ex.mergeExplanations('iphone-c', '2026-11', [entry(10, 'c10')])).toBe(true);
    expect((await ex.getExplanation(n, 'en'))?.x.summary).toBe('c10');
    expect(await ex.mergeExplanations('iphone-a', '2026-12', [entry(11, 'a11')])).toBe(true);
    expect(await ex.getExplanation(n, 'en')).toMatchObject({ dev: 'iphone-a', mo: '2026-12', at: 11 });
    // The same entry again changes nothing.
    expect(await ex.mergeExplanations('iphone-a', '2026-12', [entry(11, 'a11')])).toBe(false);
    expect((await ex.explainUsage()).saved).toBe(1);
  });
});

describe('normalizeExplanation', () => {
  it('trims, caps lists and requires a summary and 3 Chinese examples', async () => {
    const { prompt } = await app();
    const N = prompt.normalizeExplanation;
    expect(N(null)).toBeNull();
    expect(N([])).toBeNull();
    expect(N('text')).toBeNull();
    expect(N({ ...GOOD, summary: '   ' })).toBeNull();
    expect(N({ ...GOOD, examples: [...ex5().slice(0, 2), { zh: 'no han here', pinyin: '', tr: '' }, { zh: '', tr: 'x' }] })).toBeNull();
    expect(N({ summary: 'ok', examples: ex5().slice(0, 3) })).toEqual({
      summary: 'ok',
      senses: [],
      register: '',
      nuance: [],
      collocations: [],
      patterns: [],
      mistakes: [],
      examples: ex5().slice(0, 3),
    });
    const many = Array.from({ length: 12 }, (_, i) => ({ zh: `词${i}`, pinyin: 'cí', tr: `w${i}`, extra: 1 }));
    const x = N({
      ...GOOD,
      check: '  Too broad.\n',
      senses: [...Array.from({ length: 6 }, (_, i) => ({ meaning: `m${i}`, pos: ' ' })), { pos: 'verb' }],
      nuance: [{ word: '读', diff: '' }, ...Array.from({ length: 6 }, (_, i) => ({ word: `w${i}`, diff: 'd' }))],
      collocations: [...many, 'str', null],
      patterns: [{ pattern: '把 + O + V', tr: 'ba', example: { zh: '把书给我。', pinyin: 'bǎ shū gěi wǒ.', tr: 'Give me the book.' } }, { tr: 'no pattern' }],
      mistakes: [{ why: 'w1', wrong: ' ' }, { wrong: 'x' }, { why: 'w2' }, { why: 'w3' }, { why: 'w4' }],
      examples: [...many, ...ex5()],
      register: 7,
    })!;
    expect(x.check).toBe('Too broad.');
    expect(x.senses).toHaveLength(4);
    expect(x.senses[0]).toEqual({ meaning: 'm0' });
    expect(x.nuance).toEqual(Array.from({ length: 4 }, (_, i) => ({ word: `w${i}`, pinyin: '', diff: 'd' })));
    expect(x.collocations).toHaveLength(8);
    expect(x.collocations[0]).toEqual({ zh: '词0', pinyin: 'cí', tr: 'w0' });
    expect(x.patterns).toEqual([{ pattern: '把 + O + V', tr: 'ba', example: { zh: '把书给我。', pinyin: 'bǎ shū gěi wǒ.', tr: 'Give me the book.' } }]);
    expect(x.mistakes).toEqual([{ why: 'w1' }, { why: 'w2' }, { why: 'w3' }]);
    expect(x.examples).toHaveLength(5);
    expect(x.register).toBe('');
    expect(N({ ...GOOD, summary: 'x'.repeat(5000) })!.summary.length).toBe(1200);
  });

  it('the user prompt handles a grammar point with no French and no group', async () => {
    const { prompt } = await app();
    const g = note({ id: 'g:把|ba', kind: 'grammar', hanzi: '把 + O + V', pinyin: '', fr: undefined, frAuto: 'prendre', examples: [], group: undefined });
    const text = prompt.buildUserPrompt(g, 'en', { related: ['把'] });
    expect(text).toBe('Word: 把 + O + V, grammar point, sheet HSK五级\nHis meaning: "to study" (EN, his list) / "prendre" (FR, from CFDICT)\nRelated words he is learning: 把\nAnswer in English.');
    expect(prompt.systemPrompt('en')).toMatch(/in English/);
  });
});
