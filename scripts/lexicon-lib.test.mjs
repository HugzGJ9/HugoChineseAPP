import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CHAR_SHARDS,
  SHARDS,
  addLink,
  attachTranslations,
  buildCharIndex,
  buildShards,
  buildSimilar,
  charReusable,
  charShardOf,
  filterSentences,
  glossKeys,
  indexSentences,
  isNameOrVariant,
  parseCedict,
  parseCfdictTsv,
  rankExamples,
  reusable,
  shardName,
  shardOf,
  shortGloss,
  sourcesText,
  tradOnlyChars,
} from './lexicon-lib.mjs';
import { charShard, lexiconShard } from '../src/lib/lexicon';

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
    expect(by('北京')[0].proper).toBe(true);
    expect(by('张')[0].proper).toBeUndefined();
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

describe('shortGloss and isNameOrVariant', () => {
  it('detects entries that are only a name, a surname, a variant or a cross-reference', () => {
    expect(isNameOrVariant(['Tom (name)'])).toBe(true);
    expect(isNameOrVariant('surname Zhang')).toBe(true);
    expect(isNameOrVariant(['Japanese surname Ito'])).toBe(true);
    expect(isNameOrVariant(['old variant of 學|学[xue2]', 'see 學問|学问[xue2 wen4]'])).toBe(true);
    expect(isNameOrVariant('variante de 学')).toBe(true);
    expect(isNameOrVariant(['surname Le', 'happy'])).toBe(false);
    expect(isNameOrVariant(['to name (sb)'])).toBe(false);
    expect(isNameOrVariant(['used in 枇杷[pi2 pa5]'])).toBe(false);
  });
  it('takes the first real sense, turns references into the simplified form, cuts at a word boundary', () => {
    expect(shortGloss(['surname Le', 'variant of 乐[le4]', 'happy', 'glad'])).toBe('happy');
    expect(shortGloss(['abbr. for 北京大學|北京大学[Bei3 jing1 Da4 xue2]'])).toBe('abbr. for 北京大学');
    expect(shortGloss('bouillon de poulet/soupe')).toBe('bouillon de poulet');
    const long = shortGloss(['to make a thorough study of a subject, in great detail']);
    expect(long).toBe('to make a thorough study of a…');
    expect([...long].length).toBeLessThanOrEqual(32);
    expect(shortGloss(['abcdefghij'], 5)).toBe('abcd…');
    expect(shortGloss(['see 學問|学问[xue2 wen4]'])).toBe('');
  });
});

describe('buildCharIndex', () => {
  const cedict = parseCedict(readFileSync(join(FIX, 'cedict.txt'), 'utf8')).entries;
  const cfdict = parseCfdictTsv(readFileSync(join(FIX, 'cfdict.tsv'), 'utf8'));
  const e = (simp, pinyin, ...senses) => ({ trad: [simp], simp, pinyin, senses, cl: [] });
  const rowsOf = (out, ch) => JSON.parse(out.files.get(`${shardName(charShardOf(ch))}.json`)).c[ch];

  it('ranks by sentence count, then CFDICT, then shorter, then code point', () => {
    const ced = [
      e('大学', 'da4 xue2', 'university'), // count 1
      e('学生', 'xue2 sheng5', 'student'), // count 3
      e('学习', 'xue2 xi2', 'to study'), // count 1, CFDICT
      e('留学生', 'liu2 xue2 sheng1', 'foreign student'), // count 1, CFDICT, longer
      e('学院', 'xue2 yuan4', 'college'), // count 1, CFDICT, after 学习 by code point (习 < 院)
      e('学者', 'xue2 zhe3', 'scholar'), // no count, no CFDICT: not common
    ];
    const cf = new Map([['学习', [['xue2 xi2', 'étudier']]], ['留学生', [['liu2 xue2 sheng1', 'étudiant étranger']]], ['学院', [['xue2 yuan4', 'institut']]]]);
    const freq = new Map([['大学', 1], ['学生', 3], ['学习', 1], ['留学生', 1], ['学院', 1]]);
    const out = buildCharIndex({ cedict: ced, cfdict: cf, freq, built: '2026-11-23' });
    expect(rowsOf(out, '学').map((r) => r[0])).toEqual(['学生', '学习', '学院', '留学生', '大学']);
    expect(rowsOf(out, '学')[0]).toEqual(['学生', 'xue2 sheng5', 'student']);
    expect(rowsOf(out, '学')[1]).toEqual(['学习', 'xue2 xi2', 'to study', 'étudier']);
  });
  it('needs a CC-CEDICT entry: CFDICT-only words (mostly phrases) are left out, CFDICT still gives the French', () => {
    const cf = new Map([['很好', [['hen3 hao3', 'très bien']]], ['好人', [['hao3 ren2', 'brave homme']]]]);
    const out = buildCharIndex({ cedict: [e('好人', 'hao3 ren2', 'good person')], cfdict: cf, freq: new Map([['很好', 9]]), built: '2026-11-23' });
    expect(rowsOf(out, '好')).toEqual([['好人', 'hao3 ren2', 'good person', 'brave homme']]);
    expect(rowsOf(out, '很')).toBeUndefined();
  });
  it('leaves out proper nouns (every CEDICT reading capitalised), unless properMin lets frequent ones in', () => {
    const p = (simp, pinyin, ...senses) => ({ ...e(simp, pinyin, ...senses), proper: true });
    const ced = [p('汤博乐', 'Tang1 bo2 le4', 'Tumblr (microblogging platform)'), p('中文', 'Zhong1 wen2', 'Chinese language'), e('鸡汤', 'ji1 tang1', 'chicken soup')];
    const freq = new Map([['汤博乐', 1], ['中文', 40], ['鸡汤', 1]]);
    // Default (properMin 10): frequent proper nouns such as 中文 stay, rare ones such as Tumblr go.
    const def = buildCharIndex({ cedict: ced, freq, built: '2026-11-23' });
    expect(rowsOf(def, '汤').map((r) => r[0])).toEqual(['鸡汤']);
    expect(rowsOf(def, '中').map((r) => r[0])).toEqual(['中文']);
    const never = buildCharIndex({ cedict: ced, freq, built: '2026-11-23', options: { properMin: Infinity } });
    expect(rowsOf(never, '中')).toBeUndefined();
    expect(rowsOf(never, '汤').map((r) => r[0])).toEqual(['鸡汤']);
  });
  it('takes the reading with the most real senses, ties in file order, and glosses from it', () => {
    const ced = [
      e('好处', 'hao3 chu4', 'easy to get along with'),
      e('好处', 'hao3 chu5', 'benefit', 'advantage', 'merit'),
      e('东西', 'dong1 xi1', 'east and west'),
      e('东西', 'dong1 xi5', 'thing', 'stuff', 'person'),
      e('长大', 'zhang3 da4', 'to grow up'),
      e('长大', 'chang2 da4', 'long and big'),
      e('乐子', 'le4 zi5', 'see 快乐[kuai4 le4]', 'old variant of 乐子', 'variant of 乐子'),
      e('乐子', 'le4 zi5', 'fun'),
    ];
    const cf = new Map([['好处', [['hao3 chu4', 'facile à vivre'], ['hao3 chu5', 'avantage']]]]);
    const freq = new Map(ced.map((x) => [x.simp, 1]));
    const out = buildCharIndex({ cedict: ced, cfdict: cf, freq, built: '2026-11-23' });
    expect(rowsOf(out, '处')).toEqual([['好处', 'hao3 chu5', 'benefit', 'avantage']]);
    expect(rowsOf(out, '东')).toEqual([['东西', 'dong1 xi5', 'thing']]);
    expect(rowsOf(out, '长')).toEqual([['长大', 'zhang3 da4', 'to grow up']]);
    // references don't count as senses
    expect(rowsOf(out, '乐')).toEqual([['乐子', 'le4 zi5', 'fun']]);
  });
  it('leaves out names and variants despite their counts, single characters, and words that are not common', () => {
    const freq = buildShards({ cedict, cfdict, sentences: [
      { id: 1, zh: '汤姆是我的朋友。', en: 'Tom is my friend.', fr: '' },
      { id: 2, zh: '汤姆喜欢喝茶。', en: 'Tom likes tea.', fr: '' },
    ], segmenter: zh, built: '2026-11-23' }).freq;
    expect(freq.get('汤姆')).toBe(2);
    const out = buildCharIndex({ cedict, cfdict, freq, built: '2026-11-23' });
    // 汤姆 (name) is out; 鸡汤 is in through CFDICT; 汤匙 has neither a sentence nor CFDICT; 汤 itself is never listed
    // 汤博乐 is a proper noun only, despite its CFDICT entry
    expect(rowsOf(out, '汤')).toEqual([['鸡汤', 'ji1 tang1', 'chicken soup', 'bouillon de poulet']]);
    expect(rowsOf(out, '处')).toEqual([['好处', 'hao3 chu5', 'benefit', 'avantage']]);
    expect(rowsOf(out, '很')).toBeUndefined();
    expect(rowsOf(out, '姆')).toBeUndefined();
    // 学说 is only a cross-reference (in both dictionaries)
    expect(rowsOf(out, '说')?.map((r) => r[0]) ?? []).not.toContain('学说');
    for (const [, json] of out.files) for (const rows of Object.values(JSON.parse(json).c)) for (const r of rows) expect([...r[0]].length).toBeGreaterThan(1);
  });
  it('a repeated character lists the word once; lists are cut at perChar', () => {
    const ced = Array.from({ length: 30 }, (_, i) => e(`好${String.fromCodePoint(0x4e00 + i)}`, 'hao3 x', `w${i}`));
    ced.push(e('好好', 'hao3 hao3', 'well'));
    const freq = new Map(ced.map((x) => [x.simp, x.simp === '好好' ? 2 : 1]));
    const rows = rowsOf(buildCharIndex({ cedict: ced, freq, built: '2026-11-23' }), '好');
    expect(rows).toHaveLength(24);
    expect(rows.filter((r) => r[0] === '好好')).toHaveLength(1);
    expect(rows[0][0]).toBe('好好');
    expect(rowsOf(buildCharIndex({ cedict: ced, freq, built: '2026-11-23', options: { perChar: 3 } }), '好')).toHaveLength(3);
  });
  it('writes 64 v1 shards with sorted keys, an index, and identical bytes on two runs', () => {
    const freq = new Map([['学校', 2], ['学生', 1], ['你好', 1]]);
    const build = () => buildCharIndex({ cedict, cfdict, freq, built: '2026-11-23', sample: true });
    const a = build();
    expect([...a.files.keys()]).toHaveLength(CHAR_SHARDS);
    expect(a.files.has('00.json') && a.files.has('3f.json')).toBe(true);
    let total = 0;
    let chars = 0;
    for (const [name, json] of a.files) {
      total += Buffer.byteLength(json);
      const f = JSON.parse(json);
      expect(Object.keys(f)).toEqual(['v', 'c']);
      expect(f.v).toBe(1);
      const keys = Object.keys(f.c);
      chars += keys.length;
      expect(keys).toEqual([...keys].sort((x, y) => x.codePointAt(0) - y.codePointAt(0)));
      for (const k of keys) expect(`${shardName(charShardOf(k))}.json`).toBe(name);
    }
    expect(a.index).toEqual({ v: 1, shards: 64, built: '2026-11-23', sample: true, chars, words: a.stats.words, bytes: total });
    const b = build();
    expect([...a.files.entries()]).toEqual([...b.files.entries()]);
    expect(JSON.stringify(a.index)).toBe(JSON.stringify(b.index));
  });
  it('B3: writes `n` rows in the word\'s shard when a similar map is given', () => {
    const out = buildCharIndex({ cedict, cfdict, freq: new Map(), similar: new Map([['学习', ['学']], ['朋友', []]]), built: '2026-11-23' });
    expect(JSON.parse(out.files.get(`${shardName(charShardOf('学习'))}.json`)).n).toEqual({ 学习: ['学'] });
    expect(out.index.similar).toBe(1);
  });
  it('charShardOf matches charShard in the app', () => {
    for (const k of ['学', '校', '汤', '好', '𠮷', ...cedict.map((x) => x.simp).slice(0, 40)]) expect(charShardOf(k)).toBe(charShard(k));
  });
  it('SOURCES.txt takes a title', () => {
    const t = sourcesText({ built: '2026-11-23', sources: [{ name: 'Tatoeba', url: 'https://tatoeba.org', licence: 'CC BY 2.0 FR', licenceUrl: 'x' }] }, 'Title c');
    expect(t.split('\n')[0]).toBe('Title c');
    expect(t).toContain('CC BY 2.0 FR');
  });
});

describe('glossKeys', () => {
  it('lower-cases, drops parentheses, leading "to" and articles, sb/sth placeholders; English first, unique', () => {
    expect(glossKeys(['to help', 'To assist (sb)', 'a friend', 'to help sb'], 'aider/un ami/l\'école (f)/Aider')).toEqual([
      'en:help', 'en:assist', 'en:friend', 'fr:aider', 'fr:ami', 'fr:école',
    ]);
    expect(glossKeys('to ask sb to do sth; to request', [])).toEqual(['en:ask to do', 'en:request']);
    expect(glossKeys(['fig. to take the lead', 'the West'], ['les gens'])).toEqual(['en:take the lead', 'en:west', 'fr:gens']);
  });
  it('gives no key for names, variants, cross-references or empty senses', () => {
    expect(glossKeys(['Tom (name)', 'surname Zhang', 'variant of 學|学[xue2]', 'see 學問|学问[xue2 wen4]',
      'abbr. for 北京大學|北京大学[Bei3 jing1 Da4 xue2]', 'used in 枇杷[pi2 pa5]', '(onom.)', '...'], ['nom de famille Zhang', 'voir 学问']))
      .toEqual([]);
    expect(glossKeys(undefined, undefined)).toEqual([]);
  });
});

describe('buildSimilar', () => {
  const e = (simp, pinyin, ...senses) => ({ trad: [simp], simp, pinyin, senses, cl: [] });
  const all = (ced, n = 1) => new Map(ced.map((x) => [x.simp, n]));

  it('pairs words that share a rare meaning, scored by Σ 1/log2(1 + df); a generic meaning is ignored', () => {
    const ced = [
      e('帮助', 'bang1 zhu4', 'to help', 'to assist', 'thing'),
      e('帮忙', 'bang1 mang2', 'to help', 'to do a favor', 'thing'),
      e('协助', 'xie2 zhu4', 'to assist', 'thing'),
      e('援助', 'yuan2 zhu4', 'to help', 'to assist', 'thing'),
      e('东西', 'dong1 xi5', 'thing'),
      e('事情', 'shi4 qing5', 'affair'),
    ];
    // "thing" is shared by 5 words, over maxDf 4: it never makes a pair (东西 gets nothing)
    const out = buildSimilar({ cedict: ced, freq: all(ced), options: { maxDf: 4 } });
    // 援助 shares help (df 3) and assist (df 3); 帮忙 only help; 协助 only assist: 协助 (U+534F) before 帮忙 (U+5E2E)
    expect(out.get('帮助')).toEqual(['援助', '协助', '帮忙']);
    expect(out.get('协助')).toEqual(['帮助', '援助']);
    expect(out.has('东西')).toBe(false);
    expect(out.has('事情')).toBe(false);
    // with the default maxDf, "thing" counts again
    expect(buildSimilar({ cedict: ced, freq: all(ced) }).get('东西')).toEqual(['协助', '帮助', '帮忙', '援助']);
  });
  it('French meanings count too, words sharing both rank first, a rarer meaning weighs more; perWord cuts the list', () => {
    const ced = [e('朋友', 'peng2 you5', 'friend'), e('友人', 'you3 ren2', 'friend'), e('友', 'you3', 'friend'), e('伙伴', 'huo3 ban4', 'partner')];
    const cf = new Map([['朋友', [['peng2 you5', 'ami/copain']]], ['伙伴', [['huo3 ban4', 'compagnon/copain']]], ['友人', [['you3 ren2', 'ami']]]]);
    const out = buildSimilar({ cedict: ced, cfdict: cf, freq: new Map([['友', 1]]) });
    // 友人: friend + ami; 伙伴: copain (df 2, weight 0.63); 友: friend (df 3, weight 0.5)
    expect(out.get('朋友')).toEqual(['友人', '伙伴', '友']);
    expect(buildSimilar({ cedict: ced, cfdict: cf, freq: new Map([['友', 1]]), options: { perWord: 1 } }).get('朋友')).toEqual(['友人']);
  });
  it('ties go by Tatoeba count, then code point; the output is deterministic', () => {
    const ced = [e('甲', 'jia3', 'first'), e('乙', 'yi3', 'first'), e('丙', 'bing3', 'first'), e('丁', 'ding1', 'first')];
    const freq = new Map([['甲', 1], ['乙', 1], ['丙', 5], ['丁', 1]]);
    // 丙 has the most sentences; 丁 (U+4E01) < 乙 (U+4E59) < 甲 (U+7532)
    expect(buildSimilar({ cedict: ced, freq }).get('甲')).toEqual(['丙', '丁', '乙']);
    const a = buildSimilar({ cedict: ced, freq });
    const b = buildSimilar({ cedict: [...ced].reverse(), freq });
    expect([...a]).toEqual([...b]);
  });
  it('leaves out names, rare proper nouns, CFDICT-only words and words that are not common', () => {
    const p = (simp, pinyin, ...senses) => ({ ...e(simp, pinyin, ...senses), proper: true });
    const ced = [
      e('汤姆', 'Tang1 mu3', 'Tom (name)'),
      e('汤米', 'Tang1 mi3', 'Tom (name)'),
      p('北京', 'Bei3 jing1', 'Beijing'),
      p('燕京', 'Yan1 jing1', 'Beijing'),
      e('首都', 'shou3 du1', 'capital', 'Beijing'),
      e('京城', 'jing1 cheng2', 'capital'),
      e('京师', 'jing1 shi1', 'capital'), // no count, no CFDICT: not common
    ];
    const cf = new Map([['都城', [['du1 cheng2', 'capitale']]], ['首都', [['shou3 du1', 'capitale']]]]);
    const freq = new Map([['汤姆', 50], ['汤米', 50], ['北京', 3], ['燕京', 3], ['首都', 1], ['京城', 1]]);
    const out = buildSimilar({ cedict: ced, cfdict: cf, freq });
    expect([...out.keys()].sort()).toEqual(['京城', '首都']);
    expect(out.get('首都')).toEqual(['京城']);
    // a frequent proper noun (properMin) is a word like any other
    expect(buildSimilar({ cedict: ced, cfdict: cf, freq: new Map([...freq, ['北京', 10], ['燕京', 10]]) }).get('北京')).toEqual(['燕京', '首都']);
  });
  it('the rows go into `n` of charShardOf(word), and index.similar counts them', () => {
    const ced = [e('帮助', 'bang1 zhu4', 'to help'), e('帮忙', 'bang1 mang2', 'to help'), e('东西', 'dong1 xi5', 'thing')];
    const similar = buildSimilar({ cedict: ced, freq: all(ced) });
    const out = buildCharIndex({ cedict: ced, freq: all(ced), similar, built: '2026-11-23' });
    for (const w of ['帮助', '帮忙']) {
      expect(JSON.parse(out.files.get(`${shardName(charShardOf(w))}.json`)).n[w]).toEqual([w === '帮助' ? '帮忙' : '帮助']);
    }
    expect(out.index.similar).toBe(2);
    expect(out.stats).toMatchObject({ similar: 2 });
    let nBytes = 0;
    for (const json of out.files.values()) nBytes += Buffer.byteLength(JSON.stringify(JSON.parse(json).n));
    expect(out.stats.similarBytes).toBe(nBytes);
  });
});

describe('charReusable', () => {
  const idx = { v: 1, shards: 64, built: '2026-11-01', chars: 5000, words: 40000, bytes: 1, similar: 30000 };
  it('needs a v1 64-shard index, every shard, the same sample flag and a plausible count', () => {
    expect(charReusable(idx, { minChars: 3000 }).ok).toBe(true);
    expect(charReusable(idx, { present: false, minChars: 3000 }).ok).toBe(false);
    expect(charReusable({ ...idx, shards: 128 }).ok).toBe(false);
    expect(charReusable({ ...idx, v: 2 }).ok).toBe(false);
    expect(charReusable({ ...idx, chars: 10 }, { minChars: 3000 }).ok).toBe(false);
    expect(charReusable({ ...idx, sample: true }).ok).toBe(false);
    expect(charReusable(null).ok).toBe(false);
    // a build from before similar-meaning rows (B3) is rebuilt
    const { similar: _, ...old } = idx;
    expect(charReusable(old, { minChars: 3000 })).toMatchObject({ ok: false, why: 'character index without similar words' });
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
      const c = read(join(a, 'public/dict/c'));
      expect(Object.keys(c)).toHaveLength(CHAR_SHARDS + 2);
      expect(JSON.parse(c['index.json'])).toMatchObject({ v: 1, shards: 64, sample: true });
      expect(c['SOURCES.txt']).toContain('dict/c');
      expect(c['SOURCES.txt']).toContain('CC BY-SA 3.0');
      expect(c).toEqual(read(join(b, 'public/dict/c')));
      // the sample rows the e2e relies on
      const rows = (ch) => JSON.parse(c[`${shardName(charShardOf(ch))}.json`]).c[ch].map((r) => r[0]);
      expect(rows('学')).toEqual(expect.arrayContaining(['学生', '学习', '学校']));
      expect(rows('汤')).toEqual(['鸡汤']);
      // the similar-meaning rows the e2e relies on
      const n = (w) => JSON.parse(c[`${shardName(charShardOf(w))}.json`]).n[w];
      expect(n('朋友')).toEqual(['友人']);
      expect(n('帮助')).toEqual(['帮忙', '协助']);
      expect(JSON.parse(c['index.json']).similar).toBeGreaterThan(0);
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
      expect(read(join(b, 'public/dict/c'))).toEqual(read(join(a, 'public/dict/c')));
      expect(run(a, { LEXICON_SAMPLE: '1' }).stdout).toContain('Lexicon: similar 朋友 (friend) → 友人 (friend)');
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
      expect(existsSync(join(a, 'public/dict/c'))).toBe(false);
      const ci = run(a, { CI: '1' });
      expect(ci.status).toBe(1);
      expect(ci.stderr).toContain('failing the build');
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
  it('reuses recent real data only when dict/c is there too; a failed rebuild keeps dict/w without it', () => {
    const a = tmp();
    const today = new Date().toISOString().slice(0, 10);
    // make the sample look like a recent real build
    const fake = (dir, extra) => {
      const f = join(a, dir, 'index.json');
      const idx = JSON.parse(readFileSync(f, 'utf8'));
      delete idx.sample;
      writeFileSync(f, JSON.stringify({ ...idx, built: today, ...extra }));
    };
    try {
      expect(run(a, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      fake('public/dict/w', { words: 100000, sentences: 30000 });
      fake('public/dict/c', { chars: 5000 });
      const ok = run(a, { CI: '1' });
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('reusing');

      rmSync(join(a, 'public/dict/c'), { recursive: true, force: true });
      const noC = run(a, { CI: '1' });
      expect(noC.status).toBe(0);
      expect(noC.stdout).not.toContain('Lexicon: reusing');
      expect(noC.stdout).toContain('rebuilding both');
      expect(noC.stderr).toContain('keeping the data built');
      expect(noC.stderr).toContain('hides the common-word lists');
      expect(existsSync(join(a, 'public/dict/w/index.json'))).toBe(true);

      // a dict/c with a shard missing is not reused either
      expect(run(a, { LEXICON_SAMPLE: '1' }).status).toBe(0);
      fake('public/dict/w', { words: 100000, sentences: 30000 });
      fake('public/dict/c', { chars: 5000 });
      rmSync(join(a, 'public/dict/c/3f.json'));
      expect(run(a, { CI: '1' }).stdout).toContain('rebuilding both');
    } finally {
      rmSync(a, { recursive: true, force: true });
    }
  });
});
