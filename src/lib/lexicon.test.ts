import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LEXICON_SHARDS,
  examplePinyin,
  formatSense,
  lexiconCached,
  lexiconMeta,
  lexiconShard,
  lookupWord,
  prefetchLexicon,
  resetLexicon,
  sensesText,
  type ShardFile,
} from './lexicon';

// Synthetic entries written for these tests.
const WORDS: ShardFile['w'] = {
  东西: { e: [['dong1 xi1', 'east and west'], ['dong1 xi5', 'thing/stuff', '个:ge4,件:jian4']], f: [['dong1 xi5', 'chose']] },
  好: { e: [['hao4', 'to be fond of'], ['hao3', 'good/well']], x: [0, 1] },
  长: { e: [['zhang3', 'to grow'], ['chang2', 'long']] },
  使劲儿: { e: [['shi3 jin4 r5', 'to exert all one\'s strength']] },
  乐子: { e: [['le4 zi5', 'fun/see also 快樂|快乐[kuai4 le4]']] },
};
const SENTENCES: ShardFile['s'] = [
  [11, '我们是好朋友。', 'We are good friends.', 'Nous sommes de bons amis.'],
  [12, '他是好人。', 'He is a good person.', ''],
];
const INDEX = { v: 1, shards: 128, built: '2026-11-07', words: 5, sentences: 2, bytes: 1, sources: [] };

function shard(n: number): ShardFile {
  const w: ShardFile['w'] = {};
  for (const [k, v] of Object.entries(WORDS)) if (lexiconShard(k) === n) w[k] = v;
  return { v: 1, s: SENTENCES, w };
}

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('not found', { status: 404 });
let urls: string[] = [];

function serve(opts: { index?: boolean; shards?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/dict/w/index.json')) return opts.index === false ? notFound() : json(INDEX);
    const m = /\/dict\/w\/([0-9a-f]{2})\.json$/.exec(url);
    if (m && opts.shards !== false) return json(shard(parseInt(m[1], 16)));
    return notFound();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetLexicon();
  urls = [];
});
afterEach(() => vi.unstubAllGlobals());

describe('lookupWord', () => {
  it('fetches the word\'s own shard under the base path', async () => {
    serve();
    const r = await lookupWord('东西', 'dong1 xi5');
    expect(r.ok).toBe(true);
    const hex = lexiconShard('东西').toString(16).padStart(2, '0');
    expect(urls).toEqual([`${import.meta.env.BASE_URL}dict/w/${hex}.json`]);
  });
  it('orders readings exact, then toneless, then other', async () => {
    serve();
    const r = await lookupWord('东西', 'dong1 xi5');
    if (!r.ok) throw new Error(r.reason);
    expect(r.info.en.map((s) => [s.pinyinNum, s.match])).toEqual([
      ['dong1 xi5', 'exact'],
      ['dong1 xi1', 'toneless'],
    ]);
    expect(r.info.en[0]).toMatchObject({ pinyin: 'dōngxi', senses: ['thing', 'stuff'] });
    expect(r.info.en[0].measure).toEqual([{ hanzi: '个', pinyin: 'gè' }, { hanzi: '件', pinyin: 'jiàn' }]);
    expect(r.info.fr).toEqual([{ pinyinNum: 'dong1 xi5', pinyin: 'dōngxi', senses: ['chose'], measure: [], match: 'exact' }]);

    const hao = await lookupWord('好', 'hao3');
    if (!hao.ok) throw new Error(hao.reason);
    expect(hao.info.en.map((s) => [s.pinyinNum, s.match])).toEqual([['hao3', 'exact'], ['hao4', 'toneless']]);
    expect(hao.info.examples).toEqual([
      { id: 11, zh: '我们是好朋友。', en: 'We are good friends.', fr: 'Nous sommes de bons amis.' },
      { id: 12, zh: '他是好人。', en: 'He is a good person.' },
    ]);

    const chang = await lookupWord('长', 'chang2');
    if (!chang.ok) throw new Error(chang.reason);
    expect(chang.info.en.map((s) => s.pinyinNum)).toEqual(['chang2', 'zhang3']);
  });
  it('falls back to the alternative forms', async () => {
    serve();
    const r = await lookupWord('使劲', 'shi3 jin4', ['使劲儿']);
    if (!r.ok) throw new Error(r.reason);
    expect(r.info.word).toBe('使劲儿');
    expect(r.info.en[0].senses).toEqual(["to exert all one's strength"]);
  });
  it('gives empty lists for a word that is not there', async () => {
    serve();
    expect(await lookupWord('飞机', 'fei1 ji1')).toEqual({ ok: true, info: { word: '飞机', en: [], fr: [], examples: [] } });
    // a grammar pattern without Han characters, or too long to be a headword, is not even fetched
    urls = [];
    expect((await lookupWord('A + B')).ok).toBe(true);
    expect((await lookupWord('一二三四五六七八九')).ok).toBe(true);
    expect(urls).toEqual([]);
  });
  it('says nodata when the build has no lexicon (index.json 404)', async () => {
    serve({ index: false, shards: false });
    expect(await lookupWord('好', 'hao3')).toEqual({ ok: false, reason: 'nodata' });
    expect(await lexiconMeta()).toBeNull();
    expect(await lexiconCached()).toEqual({ cached: 0, total: 0 });
  });
  it('says offline when the fetch fails and nothing is cached', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    expect(await lookupWord('好', 'hao3')).toEqual({ ok: false, reason: 'offline' });
    // nothing failed is remembered: back online, it works
    serve();
    expect((await lookupWord('好', 'hao3')).ok).toBe(true);
  });
  it('keeps parsed shards in memory', async () => {
    const f = serve();
    await lookupWord('好', 'hao3');
    await lookupWord('好', 'hao4');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('lexiconMeta and prefetch', () => {
  it('reads index.json', async () => {
    serve();
    expect(await lexiconMeta()).toMatchObject({ v: 1, shards: LEXICON_SHARDS, built: '2026-11-07' });
  });
  it('fills the dictionary cache and counts it', async () => {
    const store = new Map<string, Response>();
    const cache = {
      match: async (u: string) => store.get(u),
      put: async (u: string, r: Response) => void store.set(u, r),
    };
    vi.stubGlobal('caches', { open: async () => cache });
    serve();
    expect(await lexiconCached()).toEqual({ cached: 0, total: 128 });
    const progress: number[] = [];
    expect(await prefetchLexicon((d) => progress.push(d), { batch: 8, pause: async () => {} })).toBe(0);
    expect(progress.at(-1)).toBe(128);
    expect(await lexiconCached()).toEqual({ cached: 128, total: 128 });
    expect(store.size).toBe(129); // + index.json
    urls = [];
    expect(await prefetchLexicon()).toBe(0);
    expect(urls).toEqual([]);
  });
  it('offline: reads a cached shard', async () => {
    const hex = lexiconShard('好').toString(16).padStart(2, '0');
    const cache = { match: async (u: string) => (u.endsWith(`/${hex}.json`) ? json(shard(lexiconShard('好'))) : undefined) };
    vi.stubGlobal('caches', { open: async () => cache });
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    const r = await lookupWord('好', 'hao3');
    expect(r.ok && r.info.en.length).toBe(2);
  });
});

describe('formatting', () => {
  it('formats CEDICT cross-references', () => {
    expect(formatSense('variant of 樂|乐[le4]')).toBe('variant of 乐 (lè)');
    expect(formatSense('see 乐[le4]')).toBe('see 乐 (lè)');
    expect(formatSense('see also 快樂|快乐[kuai4 le4]')).toBe('see also 快乐 (kuàilè)');
    expect(formatSense('Taiwan pr. [nu:3]')).toBe('Taiwan pr. [nu:3]');
    expect(formatSense('to study')).toBe('to study');
  });
  it('builds the prompt line from the matching readings', async () => {
    serve();
    const r = await lookupWord('东西', 'dong1 xi5');
    if (!r.ok) throw new Error(r.reason);
    expect(sensesText(r.info.en)).toBe('dong1 xi5: thing/stuff (measure words: 个, 件) | dong1 xi1: east and west');
    expect(sensesText(r.info.en, 1)).toBe('dong1 xi5: thing (measure words: 个, 件) | dong1 xi1: east and west');
    expect(sensesText([])).toBe('');
  });
  it('gives example sentences pinyin with tone marks', async () => {
    expect(await examplePinyin('我们明天去学校。')).toBe('wǒmen míngtiān qù xuéxiào.');
  });
});
