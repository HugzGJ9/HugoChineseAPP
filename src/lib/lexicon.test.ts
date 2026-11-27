import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CHAR_SHARDS,
  LEXICON_SHARDS,
  charGloss,
  charShard,
  charWords,
  examplePinyin,
  formatSense,
  lexiconCached,
  lexiconMeta,
  lexiconShard,
  lineReadings,
  lookupWord,
  pickExamples,
  prefetchLexicon,
  resetLexicon,
  sensesText,
  similarWords,
  type CharShardFile,
  type ShardFile,
  overlayKnown,
} from './lexicon';

// Synthetic entries written for these tests.
const WORDS: ShardFile['w'] = {
  东西: { e: [['dong1 xi1', 'east and west'], ['dong1 xi5', 'thing/stuff', '个:ge4,件:jian4']], f: [['dong1 xi5', 'chose']] },
  好: { e: [['hao4', 'to be fond of'], ['hao3', 'good/well']], x: [0, 1] },
  长: { e: [['zhang3', 'to grow'], ['chang2', 'long']] },
  使劲儿: { e: [['shi3 jin4 r5', 'to exert all one\'s strength']] },
  乐子: { e: [['le4 zi5', 'fun/see also 快樂|快乐[kuai4 le4]']] },
  // D7: x is the overall best list; xr has the lists that differ from it
  行: { e: [['hang2', 'row'], ['xing2', 'to walk/OK']], x: [2, 3], xr: { hang2: [3], xing2: [2] } },
  了: { e: [['le5', 'completed action'], ['liao3', 'to finish'], ['liao4', 'to look far']], x: [2, 3], xr: { liao4: [3] } },
};
const SENTENCES: ShardFile['s'] = [
  [11, '我们是好朋友。', 'We are good friends.', 'Nous sommes de bons amis.'],
  [12, '他是好人。', 'He is a good person.', ''],
  [13, '这样行不行？', 'Is this OK?', ''],
  [14, '我不喜欢这一行。', 'I do not like this trade.', ''],
];
const INDEX = { v: 1, shards: 128, built: '2026-11-07', words: 7, sentences: 4, bytes: 1, sources: [] };
// Synthetic character rows.
const CHARS: CharShardFile['c'] = {
  学: [['学生', 'xue2 sheng5', 'student', 'étudiant'], ['学习', 'xue2 xi2', 'to study'], ['汉堡', 'han4 bao3', '', 'hamburger']],
  校: [],
};
// Synthetic similar-meaning rows (B3); 学校's row is malformed on purpose.
const SIMILAR: Record<string, unknown> = {
  帮助: ['帮忙', '协助'],
  学校: ['校', 7, '', '学校', '校', 'A B'],
  朋友: [],
};
const C_INDEX = { v: 1, shards: 64, built: '2026-11-23', chars: 2, words: 3, bytes: 1, similar: 2 };
let withN = true;
function charShardFile(n: number): CharShardFile {
  const c: CharShardFile['c'] = {};
  for (const [k, v] of Object.entries(CHARS)) if (charShard(k) === n) c[k] = v;
  if (!withN) return { v: 1, c };
  const nn: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(SIMILAR)) if (charShard(k) === n) nn[k] = v;
  return { v: 1, c, n: nn as CharShardFile['n'] };
}

function shard(n: number): ShardFile {
  const w: ShardFile['w'] = {};
  for (const [k, v] of Object.entries(WORDS)) if (lexiconShard(k) === n) w[k] = v;
  return { v: 1, s: SENTENCES, w };
}

const json = (d: unknown) => new Response(JSON.stringify(d), { status: 200, headers: { 'content-type': 'application/json' } });
const notFound = () => new Response('not found', { status: 404 });
let urls: string[] = [];

function serve(opts: { index?: boolean; shards?: boolean; chars?: boolean } = {}) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    if (url.endsWith('/dict/w/index.json')) return opts.index === false ? notFound() : json(INDEX);
    const m = /\/dict\/w\/([0-9a-f]{2})\.json$/.exec(url);
    if (m && opts.shards !== false) return json(shard(parseInt(m[1], 16)));
    if (opts.chars === false) return notFound();
    if (url.endsWith('/dict/c/index.json')) return json(C_INDEX);
    const c = /\/dict\/c\/([0-9a-f]{2})\.json$/.exec(url);
    if (c) return json(charShardFile(parseInt(c[1], 16)));
    return notFound();
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  resetLexicon();
  urls = [];
  withN = true;
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
  it('D7: picks the examples of the note\'s reading (xr), else the word\'s best examples (x)', async () => {
    serve();
    const zh = async (w: string, py?: string) => {
      const r = await lookupWord(w, py);
      if (!r.ok) throw new Error(r.reason);
      return r.info.examples.map((e) => e.zh);
    };
    expect(await zh('行', 'hang2')).toEqual(['我不喜欢这一行。']);
    expect(await zh('行', 'xing2')).toEqual(['这样行不行？']);
    // toneless: the only reading with the same letters
    expect(await zh('行', 'xing')).toEqual(['这样行不行？']);
    expect(await zh('行', 'Xing2')).toEqual(['这样行不行？']);
    // no reading, or one that is not the word's: x
    expect(await zh('行')).toEqual(['这样行不行？', '我不喜欢这一行。']);
    expect(await zh('行', 'heng2')).toEqual(['这样行不行？', '我不喜欢这一行。']);
    // a reading of the word without its own list means its list is x (equal lists are left out by the build):
    // liao3 must not fall to the liao4 list by letters
    expect(await zh('了', 'liao3')).toEqual(['这样行不行？', '我不喜欢这一行。']);
    expect(await zh('了', 'liao4')).toEqual(['我不喜欢这一行。']);
    // two readings with the same letters (liao3, liao4): toneless is ambiguous → x
    expect(await zh('了', 'liao')).toEqual(['这样行不行？', '我不喜欢这一行。']);
    // a word without xr (an older build) works as before
    expect(await zh('好', 'hao3')).toEqual(['我们是好朋友。', '他是好人。']);
  });
  it('pickExamples ignores malformed xr', () => {
    const e = { e: [['hang2', 'row'], ['xing2', 'OK']] as [string, string][], x: [0, 1] };
    expect(pickExamples({ ...e, xr: { hang2: 'no' } as unknown as Record<string, number[]> }, 'hang2')).toEqual([0, 1]);
    expect(pickExamples({ ...e, xr: { hang2: [] } }, 'hang2')).toEqual([0, 1]);
    expect(pickExamples({ ...e, xr: null as unknown as Record<string, number[]> }, 'hang2')).toEqual([0, 1]);
    expect(pickExamples({ ...e, xr: { toString: [5] } as Record<string, number[]> }, 'toString')).toEqual([0, 1]);
    expect(pickExamples({ xr: { hang2: [1] } }, 'hang2')).toEqual([]);
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
    const total = LEXICON_SHARDS + CHAR_SHARDS; // 192
    expect(await lexiconCached()).toEqual({ cached: 0, total });
    const progress: number[] = [];
    expect(await prefetchLexicon((d) => progress.push(d), { batch: 8, pause: async () => {} })).toBe(0);
    expect(progress.at(-1)).toBe(total);
    expect(await lexiconCached()).toEqual({ cached: total, total });
    expect(store.size).toBe(total + 2); // + both index.json
    expect([...store.keys()].filter((u) => u.includes('/dict/c/'))).toHaveLength(CHAR_SHARDS + 1);
    urls = [];
    expect(await prefetchLexicon()).toBe(0);
    expect(urls).toEqual([]);
  });
  it('without dict/c (an old build kept after a failed rebuild), prefetch and counts cover dict/w only', async () => {
    const store = new Map<string, Response>();
    const cache = { match: async (u: string) => store.get(u), put: async (u: string, r: Response) => void store.set(u, r) };
    vi.stubGlobal('caches', { open: async () => cache });
    serve({ chars: false });
    expect(await lexiconCached()).toEqual({ cached: 0, total: 128 });
    expect(await prefetchLexicon()).toBe(0);
    expect(store.size).toBe(129);
    expect(await charWords('学')).toEqual({ ok: false, reason: 'nodata' });
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

describe('charWords', () => {
  it('fetches the character\'s own c shard and gives marked pinyin', async () => {
    serve();
    const r = await charWords('学');
    const hex = charShard('学').toString(16).padStart(2, '0');
    expect(urls).toEqual([`${import.meta.env.BASE_URL}dict/c/${hex}.json`]);
    expect(r).toEqual({
      ok: true,
      words: [
        { word: '学生', pinyinNum: 'xue2 sheng5', pinyin: 'xuésheng', en: 'student', fr: 'étudiant' },
        { word: '学习', pinyinNum: 'xue2 xi2', pinyin: 'xuéxí', en: 'to study' },
        { word: '汉堡', pinyinNum: 'han4 bao3', pinyin: 'hànbǎo', en: '', fr: 'hamburger' },
      ],
    });
  });
  it('ok with [] for a character without a row, an empty row, or something that is not one Han character', async () => {
    serve();
    expect(await charWords('校')).toEqual({ ok: true, words: [] });
    expect(await charWords('飞')).toEqual({ ok: true, words: [] });
    urls = [];
    expect(await charWords('学习')).toEqual({ ok: true, words: [] });
    expect(await charWords('A')).toEqual({ ok: true, words: [] });
    expect(urls).toEqual([]);
  });
  it('nodata without the c index; offline falls back to the cache, else says offline', async () => {
    serve({ chars: false });
    expect(await charWords('学')).toEqual({ ok: false, reason: 'nodata' });

    resetLexicon();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await charWords('学')).toEqual({ ok: false, reason: 'offline' });
    const hex = charShard('学').toString(16).padStart(2, '0');
    vi.stubGlobal('caches', { open: async () => ({ match: async (u: string) => (u.endsWith(`/dict/c/${hex}.json`) ? json(charShardFile(charShard('学'))) : undefined) }) });
    const r = await charWords('学');
    expect(r.ok && r.words.map((w) => w.word)).toEqual(['学生', '学习', '汉堡']);
  });
  it('a server error is an error, and nothing failed is kept', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })));
    expect(await charWords('学')).toEqual({ ok: false, reason: 'error' });
    serve();
    expect((await charWords('学')).ok).toBe(true);
  });
  it('keeps parsed c shards in memory', async () => {
    const f = serve();
    await charWords('学');
    await charWords('学');
    expect(f).toHaveBeenCalledTimes(1);
  });
});

describe('similarWords', () => {
  it('reads the word\'s row from its own c shard', async () => {
    serve();
    expect(await similarWords('帮助')).toEqual({ ok: true, words: ['帮忙', '协助'] });
    const hex = charShard('帮助').toString(16).padStart(2, '0');
    expect(urls).toEqual([`${import.meta.env.BASE_URL}dict/c/${hex}.json`]);
  });
  it('gives [] when there is no row, an empty row, or a shard built before `n`', async () => {
    serve();
    expect(await similarWords('朋友')).toEqual({ ok: true, words: [] });
    expect(await similarWords('飞机')).toEqual({ ok: true, words: [] });
    urls = [];
    expect(await similarWords('A + B')).toEqual({ ok: true, words: [] });
    expect(await similarWords('一二三四五六七八九')).toEqual({ ok: true, words: [] });
    expect(urls).toEqual([]);
    resetLexicon();
    withN = false;
    expect(await similarWords('帮助')).toEqual({ ok: true, words: [] });
  });
  it('drops malformed items, the word itself and repeats', async () => {
    serve();
    expect(await similarWords(' 学校 ')).toEqual({ ok: true, words: ['校'] });
  });
  it('nodata without the c index; offline without a cached shard', async () => {
    serve({ chars: false });
    expect(await similarWords('帮助')).toEqual({ ok: false, reason: 'nodata' });
    resetLexicon();
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('offline'))));
    expect(await similarWords('帮助')).toEqual({ ok: false, reason: 'offline' });
  });
});

describe('charGloss', () => {
  it('drops variant, see, surname and radical senses but keeps "used in"; up to 3', () => {
    expect(charGloss(['surname Le', 'variant of 乐 (lè)', 'happy', 'glad', 'cheerful', 'joyful'])).toBe('happy; glad; cheerful');
    expect(charGloss(['old variant of 学 (xué)', 'see 学问 (xuéwèn)', 'Kangxi radical 39', 'used in 枇杷 (pípa)'])).toBe('used in 枇杷 (pípa)');
    expect(charGloss(['to learn', 'school'], 1)).toBe('to learn');
    expect(charGloss(['nom de famille Le', 'variante de 乐', 'joyeux'])).toBe('joyeux');
  });
  it('keeps the senses when nothing else is left', () => {
    expect(charGloss(['surname Zhang', 'variant of 张 (zhāng)'])).toBe('surname Zhang; variant of 张 (zhāng)');
    expect(charGloss([])).toBe('');
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

describe('lineReadings', () => {
  it('gives one numbered syllable per character, in context, empty for non-Han', async () => {
    expect(await lineReadings('我去银行。')).toEqual(['wo3', 'qu4', 'yin2', 'hang2', '']);
  });
  it('writes the neutral tone as 5 and ü as v, without tone sandhi (CEDICT style)', async () => {
    expect((await lineReadings('我们'))[1]).toBe('men5');
    expect(await lineReadings('女儿')).toEqual(['nv3', 'er2']);
    expect(await lineReadings('一个')).toEqual(['yi1', 'ge4']);
  });
  it('keeps code point offsets with Latin, spaces and astral characters', async () => {
    const zh = '好 OK, 𠮷好！';
    const r = await lineReadings(zh);
    expect(r).toHaveLength([...zh].length);
    expect(r[0]).toBe('hao3');
    expect(r[7]).toBe('hao3');
    expect(r.filter(Boolean)).toHaveLength(2);
  });
});

describe('overlayKnown', () => {
  const known = { get: (w: string) => ({ 朋友: 'peng2 you5', 老师: 'lao3 shi1', 学: 'xue2' } as Record<string, string>)[w], max: 2 };
  it('his multi-character words take his reading, the rest stays', () => {
    expect(overlayKnown('我的朋友是老师。', ['wo3', 'de5', 'peng2', 'you3', 'shi4', 'lao3', 'shi1'], known))
      .toEqual(['wo3', 'de5', 'peng2', 'you5', 'shi4', 'lao3', 'shi1']);
  });
  it('ignores one-character words, malformed readings and misaligned input', () => {
    expect(overlayKnown('学', ['xue2'], known)).toEqual(['xue2']);
    expect(overlayKnown('朋友', ['peng2'], known)).toEqual(['peng2']);
    expect(overlayKnown('好坏', ['hao3', 'huai4'], { get: () => 'bad reading', max: 2 })).toEqual(['hao3', 'huai4']);
  });
});
