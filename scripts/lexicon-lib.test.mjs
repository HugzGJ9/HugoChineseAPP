import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SHARDS,
  addLink,
  attachTranslations,
  buildShards,
  filterSentences,
  indexSentences,
  parseCedict,
  parseCfdictTsv,
  rankExamples,
  reusable,
  shardName,
  shardOf,
  tradOnlyChars,
} from './lexicon-lib.mjs';
import { lexiconShard } from '../src/lib/lexicon';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIX = join(HERE, 'fixtures/lexicon');
const SCRIPT = join(HERE, 'build-lexicon.mjs');
const zh = new Intl.Segmenter('zh', { granularity: 'word' });
/** A segmenter with boundaries chosen by the test: '图书|馆看书' is segmented as 图书 / 馆看书. */
const cut = (...marked) => {
  const map = new Map(marked.map((m) => [m.replace(/\|/g, ''), m.split('|')]));
  return { segment: (s) => (map.get(s) ?? [s]).map((segment) => ({ segment })) };
};

describe('parseCedict', () => {
  const text = [
    '# comment',
    '#! date=2026-10-31T01:02:03Z',
    '朋友 朋友 [peng2 you5] /friend/CL:個|个[ge4],位[wei4]/',
    '女兒 女儿 [nu:3 er2] /daughter/',
    '張 张 [Zhang1] /surname Zhang/',
    '張 张 [zhang1] /to open/',
    '北京 北京 [Bei3 jing1] /Beijing/',
    '乾 干 [gan1] /dry/',
    '干 干 [gan1] /to concern/dry/',
    '幹 干 [gan4] /to do/',
    '只 只 [zhi1] /CL:個|个[ge4]/',
    '一二三四五六七八九 一二三四五六七八九 [yi1 er4 san1 si4 wu3 liu4 qi1 ba1 jiu3] /too long/',
    'garbage line',
  ].join('\n');
  const { entries, date } = parseCedict(text);
  const by = (s) => entries.filter((e) => e.simp === s);

  it('reads CL measure words and the date', () => {
    expect(by('朋友')).toEqual([{ trad: ['朋友'], simp: '朋友', pinyin: 'peng2 you5', senses: ['friend'], cl: ['个:ge4', '位:wei4'] }]);
    expect(date).toBe('2026-10-31');
  });
  it('lower-cases pinyin and writes u: as v', () => {
    expect(by('女儿')[0].pinyin).toBe('nv3 er2');
  });
  it('keeps proper nouns only when there is no common entry', () => {
    expect(by('张').map((e) => e.senses)).toEqual([['to open']]);
    expect(by('北京')).toHaveLength(1);
    expect(by('北京')[0].pinyin).toBe('bei3 jing1');
  });
  it('merges the same simplified form and pinyin', () => {
    expect(by('干')).toEqual([
      { trad: ['乾', '干'], simp: '干', pinyin: 'gan1', senses: ['dry', 'to concern'], cl: [] },
      { trad: ['幹'], simp: '干', pinyin: 'gan4', senses: ['to do'], cl: [] },
    ]);
  });
  it('drops entries without senses and headwords over 8 characters', () => {
    expect(by('只')).toEqual([]);
    expect(entries.some((e) => e.simp.length > 8)).toBe(false);
  });
});

describe('sentences', () => {
  const { entries } = parseCedict(readFileSync(join(FIX, 'cedict.txt'), 'utf8'));
  const trad = tradOnlyChars(entries);

  it('finds traditional-only characters', () => {
    for (const c of '們學說國') expect(trad.has(c)).toBe(true);
    // 干 is both a traditional and a simplified form
    for (const c of '们学干我') expect(trad.has(c)).toBe(false);
  });
  it('filters by script, length and Latin letters; duplicates keep the lowest id', () => {
    const kept = filterSentences(
      [
        [9, '我们明天去学校。'],
        [1, '你好！'],
        [2, '我們明天去學校。'],
        [3, '他喜欢看NBA比赛。'],
        [4, '我们明天去学校。'],
        [5, '一二三四五六七八九十一二三四五六七八九十一二三四五'],
      ],
      { tradOnly: trad },
    );
    expect(kept).toEqual([[4, '我们明天去学校。']]);
  });
  it('French: a direct link first, else through English; the lowest id wins', () => {
    const links = new Map();
    for (const [a, b] of [
      [1, 22], [1, 21], [1, 31], // direct fra 31
      [2, 23], [23, 33], [23, 32], // via English: lowest 32
      [3, 34], // French only
      [4, 99], // linked to nothing known
    ]) addLink(links, a, b);
    const eng = new Map([[21, 'one'], [22, 'one bis'], [23, 'two']]);
    const fra = new Map([[31, 'un'], [32, 'deux'], [33, 'deux bis'], [34, 'trois']]);
    const out = attachTranslations([[1, '甲'], [2, '乙'], [3, '丙'], [4, '丁']], { links, eng, fra });
    expect(out).toEqual([
      { id: 1, zh: '甲', en: 'one', fr: 'un' },
      { id: 2, zh: '乙', en: 'two', fr: 'deux' },
      { id: 3, zh: '丙', en: '', fr: 'trois' },
    ]);
  });
});

describe('indexSentences', () => {
  const heads = new Set(['说', '说中', '中文', '会', '他', '图书馆', '图书', '馆', '看书']);
  it('does not index a two-character word across a word boundary (他会说中文)', () => {
    const idx = indexSentences([{ zh: '他会说中文。' }], heads, zh);
    expect(idx.has('说中')).toBe(false);
    for (const w of ['他', '会', '说', '中文']) expect(idx.get(w)).toEqual([0]);
  });
  it('finds words inside a segment and 3+ character words across segments', () => {
    const idx = indexSentences([{ zh: '图书馆看书' }, { zh: '她在图书馆看书。' }], heads, cut('图书|馆看书', '她在|图书|馆|看书|。'));
    expect(idx.get('图书馆')).toEqual([0, 1]);
    expect(idx.get('看书')).toEqual([0, 1]);
    expect(idx.get('馆')).toEqual([0, 1]);
  });
});

describe('rankExamples', () => {
  const s = (id, zh, en, fr) => ({ id, zh, en, fr });
  const list = [
    s(5, '一二三四五六七八九十一二', 'x', ''), // 12, no fr
    s(4, '一二三四五六', 'x', 'y'), // 6
    s(3, '一二三四五六七八九十', 'x', 'y'), // 10
    s(2, '一二三四五六七八九十一二三四', 'x', 'y'), // 14
    s(1, '一二三四五六七八九十一二三四五六', 'x', 'y'), // 16
    s(6, '一二三四五六七八', 'x', 'y'), // 8
    s(7, '一二三四五六七八九十一二', '', 'y'), // 12, no en
    s(8, '一二三四五六七八九十一二', 'x', 'y'), // 12
  ];
  it('puts both languages first, then the length closest to 12, then the lowest id, and keeps 6', () => {
    const got = rankExamples(list.map((_, i) => i), list).map((i) => list[i].id);
    expect(got).toEqual([8, 2, 3, 1, 6, 4]);
    expect(rankExamples(list.map((_, i) => i), list, { examples: 2 })).toHaveLength(2);
  });
});

describe('buildShards', () => {
  const cedict = parseCedict(readFileSync(join(FIX, 'cedict.txt'), 'utf8')).entries;
  const cfdict = parseCfdictTsv(readFileSync(join(FIX, 'cfdict.tsv'), 'utf8'));
  const sentences = [
    { id: 11, zh: '我们是好朋友。', en: 'We are good friends.', fr: 'Nous sommes de bons amis.' },
    { id: 12, zh: '他会说中文。', en: 'He can speak Chinese.', fr: '' },
  ];
  const build = () => buildShards({ cedict, cfdict, sentences, segmenter: zh, built: '2026-11-07', sources: [] });
  const shardFor = (files, w) => JSON.parse(files.get(`${shardName(shardOf(w))}.json`));

  it('writes 128 v1 shards, each word in its own shard', () => {
    const { files, index } = build();
    expect([...files.keys()]).toHaveLength(SHARDS);
    expect(files.has('00.json') && files.has('7f.json')).toBe(true);
    const sh = shardFor(files, '朋友');
    expect(sh.v).toBe(1);
    expect(sh.w['朋友']).toEqual({ e: [['peng2 you5', 'friend', '个:ge4,位:wei4']], f: [['peng2 you5', 'ami/amie']], x: [0] });
    expect(sh.s[0]).toEqual([11, '我们是好朋友。', 'We are good friends.', 'Nous sommes de bons amis.']);
    expect(shardFor(files, '说中').w['说中'].x).toBeUndefined();
    expect(shardFor(files, '汉堡').w['汉堡']).toEqual({ f: [['han4 bao3', 'hamburger']] });
    expect(index).toMatchObject({ v: 1, shards: 128, built: '2026-11-07', sentences: 2 });
    expect(index.sample).toBeUndefined();
    let total = 0;
    for (const [name, json] of files) {
      const parsed = JSON.parse(json);
      total += Buffer.byteLength(json);
      expect(Object.keys(parsed)).toEqual(['v', 's', 'w']);
      for (const w of Object.keys(parsed.w)) expect(shardName(shardOf(w)) + '.json').toBe(name);
      // sentences are deduplicated within a shard
      expect(new Set(parsed.s.map((x) => x[0])).size).toBe(parsed.s.length);
    }
    expect(index.bytes).toBe(total);
  });
  it('gives identical bytes for the same inputs', () => {
    const a = build();
    const b = build();
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    expect(JSON.stringify(a.index)).toBe(JSON.stringify(b.index));
  });
  it('shardOf matches lexiconShard in the app', () => {
    const words = cedict.map((e) => e.simp).slice(0, 50);
    expect(words).toHaveLength(50);
    for (const w of words) expect(shardOf(w)).toBe(lexiconShard(w));
  });
});

describe('reusable', () => {
  const idx = { v: 1, shards: 128, built: '2026-11-01', words: 100000, sentences: 30000 };
  const opts = { minWords: 80000, minSentences: 5000, today: '2026-11-07' };
  it('reuses recent plausible real data only', () => {
    expect(reusable(idx, opts).ok).toBe(true);
    expect(reusable({ ...idx, built: '2026-09-01' }, opts)).toMatchObject({ ok: false, stale: true });
    expect(reusable({ ...idx, words: 10 }, opts).ok).toBe(false);
    expect(reusable({ ...idx, sample: true }, opts).ok).toBe(false);
    expect(reusable({ ...idx, v: 2 }, opts).ok).toBe(false);
    expect(reusable(null, opts).ok).toBe(false);
  });
});

describe('build-lexicon.mjs', () => {
  const run = (cwd, env) =>
    spawnSync(process.execPath, [SCRIPT], {
      cwd,
      encoding: 'utf8',
      // no network: a refused local port for every download
      env: { ...process.env, CI: '', LEXICON_SAMPLE: '', CEDICT_URL: 'http://127.0.0.1:9/cedict.gz', TATOEBA_BASE: 'http://127.0.0.1:9', ...env },
    });
  const tmp = () => mkdtempSync(join(tmpdir(), 'lexicon-test-'));
  const read = (dir) => Object.fromEntries(readdirSync(dir).sort().map((f) => [f, readFileSync(join(dir, f), 'utf8')]));

  it('builds the sample twice with identical bytes', () => {
    const a = tmp();
    const b = tmp();
    try {
      expect(run(a, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      expect(run(b, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      const out = read(join(a, 'public/dict/w'));
      expect(Object.keys(out)).toHaveLength(SHARDS + 2);
      expect(JSON.parse(out['index.json'])).toMatchObject({ v: 1, sample: true });
      expect(out['SOURCES.txt']).toContain('CC BY 2.0 FR');
      expect(out).toEqual(read(join(b, 'public/dict/w')));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
  it('falls back to the global links file with the same result', () => {
    const a = tmp();
    const b = tmp();
    const dir = join(b, 'tatoeba');
    try {
      mkdirSync(dir);
      for (const f of ['cmn_sentences.tsv', 'eng_sentences.tsv', 'fra_sentences.tsv', 'links.csv']) copyFileSync(join(FIX, f), join(dir, f));
      expect(run(a, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      const r = run(b, { LEXICON_SAMPLE: '1', TATOEBA_DIR: dir });
      expect(r.status).toBe(0);
      expect(r.stdout + r.stderr).toContain('global links');
      expect(read(join(b, 'public/dict/w'))).toEqual(read(join(a, 'public/dict/w')));
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });
  it('without data: warns and exits 0 on a laptop (removing sample data), fails in CI', () => {
    const a = tmp();
    try {
      expect(run(a, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      const laptop = run(a, {});
      expect(laptop.status).toBe(0);
      expect(laptop.stderr).toContain('Lexicon not available');
      expect(existsSync(join(a, 'public/dict/w'))).toBe(false);
      const ci = run(a, { CI: '1' });
      expect(ci.status).toBe(1);
      expect(ci.stderr).toContain('failing the build');
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});
