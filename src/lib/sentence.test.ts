import { describe, expect, it } from 'vitest';
import type { Note } from './types';
import { lineTokens, sentenceTokens, vocabIndex, vocabLinks, vocabWithChar, type Token } from './sentence';

// Generic textbook words only: no personal data in this public repo.
function note(hanzi: string, en: string, order: number, extra: Partial<Note> = {}): Note {
  return {
    id: `g:${hanzi}`, kind: 'grammar', hanzi, alts: [], pinyin: '', pinyinNum: '', en, notes: [], tags: ['语法'],
    refs: [{ sheet: '语法', row: order + 2 }], order, studied: false, examples: [], ...extra,
  } as Note;
}
const word = (hanzi: string, alts: string[] = []) => ({ ...note(hanzi, '', 0), id: `v:${hanzi}`, kind: 'vocab', alts }) as Note;
const unless = note('除非A，才B', 'Unless, then', 1);

// A fixed segmenter so the tests don't depend on the ICU dictionary of the machine.
const seg = (cuts: string) => () => cuts.split(' ');

describe('sentenceTokens', () => {
  const index = vocabIndex([word('学习'), word('学'), word('中文'), word('就'), word('喝', ['喝酒']), unless]);
  const show = (zh: string, cuts: string, pattern = '') =>
    sentenceTokens(zh, index, pattern, seg(cuts))
      .map((t) => (t.note ? `[${t.s}]` : t.word ? `{${t.s}}` : t.s) + (t.pattern ? '*' : ''))
      .join('');
  it('lays his words over the segmenter, longest first', () => {
    expect(show('我在学习中文。', '我 在 学习 中文 。')).toBe('{我}{在}[学习][中文]。');
    expect(show('他一喝酒就脸红。', '他 一 喝酒 就 脸红 。')).toBe('{他}{一}[喝酒][就]{脸红}。');
  });
  it('his words win over segmenter boundaries; one-character words only where the segmenter cuts', () => {
    expect(show('学习者', '学 习者')).toBe('[学习]{者}');
    expect(show('学校很大', '学校 很 大')).toBe('{学校}{很}{大}');
    expect(show('他学得快', '他 学 得 快')).toBe('{他}[学]{得}{快}');
  });
  it('flags pattern characters and splits mixed segments', () => {
    expect(show('他一听就懂', '他 一听 就 懂', '一就')).toBe('{他}{一}*{听}[就]*{懂}');
  });
  it('keeps punctuation and Latin untappable, with offsets', () => {
    const t = sentenceTokens('好，OK', index, '', seg('好 ， OK'));
    expect(t.map((x) => [x.s, x.start, x.word])).toEqual([['好', 0, true], ['，', 1, false], ['OK', 2, false]]);
  });
  it('works with the browser segmenter or without it', () => {
    expect(sentenceTokens('我在学习中文。', index).map((t) => t.s).join('')).toBe('我在学习中文。');
    expect(sentenceTokens('我在学习', index).find((t) => t.note)?.s).toBe('学习');
  });
});

describe('vocabLinks', () => {
  it('links a dictionary word to his words around it', () => {
    const index = vocabIndex([word('学习'), word('学'), word('留学'), word('中文')]);
    expect(vocabLinks('学', index)).toEqual(['v:学习', 'v:留学']);
    expect(vocabLinks('学习者', index)).toEqual(['v:学习', 'v:学']);
    expect(vocabLinks('猫', index)).toEqual([]);
  });
});

describe('vocabWithChar', () => {
  it('lists his words containing a character, in list order, once each, alts included', () => {
    const index = vocabIndex([word('留学'), word('学习'), word('中文'), word('学'), word('上课', ['上学']), word('学生', ['学生们']), unless]);
    expect(vocabWithChar('学', index)).toEqual(['v:留学', 'v:学习', 'v:学', 'v:上课', 'v:学生']);
    expect(vocabWithChar('文', index)).toEqual(['v:中文']);
    expect(vocabWithChar('猫', index)).toEqual([]);
    expect(vocabWithChar('', index)).toEqual([]);
    // grammar notes are not in the index
    expect(vocabWithChar('非', index)).toEqual([]);
  });
});

describe('lineTokens', () => {
  const index = vocabIndex([word('学习'), word('中文'), word('就'), word('喝', ['喝酒']), word('朋友'), unless]);
  const withXue = vocabIndex([word('学习'), word('学'), word('中文')]);
  // [his word] {other word} <head> (head that is also his word: <[x]>), * = pattern, punctuation and Latin bare.
  const fmt = (ts: Token[]) =>
    ts
      .map((t) => {
        const core = t.note ? `[${t.s}]` : t.word ? `{${t.s}}` : t.s;
        return (t.head ? `<${t.note ? core : t.s}>` : core) + (t.pattern ? '*' : '');
      })
      .join('');
  const show = (zh: string, cuts: string, head?: string[], idx = index) => fmt(lineTokens(zh, idx, { head, segments: seg(cuts) }));

  it('splits a segmenter word around the head (学 in 学校)', () => {
    expect(show('我去学校。', '我 去 学校 。', ['学'])).toBe('{我}{去}<学>{校}。');
  });
  it('wins over a longer word of his (学 vs 学习)', () => {
    expect(show('我学习中文。', '我 学习 中文 。', ['学'])).toBe('{我}<学>{习}[中文]。');
  });
  it('carries the note when his word is exactly the head', () => {
    const t = lineTokens('他是我的朋友。', index, { head: ['朋友'], segments: seg('他 是 我 的 朋友 。') });
    expect(t.find((x) => x.head)).toEqual({ s: '朋友', start: 4, word: true, head: true, note: 'v:朋友' });
    expect(show('我学习中文。', '我 学 习 中文 。', ['学'], withXue)).toBe('{我}<[学]>{习}[中文]。');
  });
  it('marks every occurrence, with offsets', () => {
    const t = lineTokens('学了又学', index, { head: ['学'], segments: seg('学 了 又 学') });
    expect(t.filter((x) => x.head).map((x) => x.start)).toEqual([0, 3]);
    expect(fmt(t)).toBe('<学>{了}{又}<学>');
  });
  it('takes the longest form first (学习 over 学)', () => {
    expect(show('学习好，学好', '学习 好 ， 学 好', ['学', '学习'])).toBe('<[学习]>{好}，<学>{好}');
  });
  it('ignores forms that are not Han only', () => {
    expect(show('他一喝酒就脸红。', '他 一 喝酒 就 脸红 。', ['一+V+就', '', ' '])).toBe('{他}{一}[喝酒][就]{脸红}。');
  });
  it('keeps Latin and punctuation untappable', () => {
    const t = lineTokens('学，OK!', index, { head: ['学'], segments: seg('学 ， OK !') });
    expect(t.map((x) => [x.s, x.word, !!x.head])).toEqual([['学', true, true], ['，', false, false], ['OK', false, false], ['!', false, false]]);
  });
  it('flags pattern characters on the head as well', () => {
    expect(fmt(lineTokens('他一听就懂', index, { head: ['就'], pattern: '一就', segments: seg('他 一听 就 懂') }))).toBe('{他}{一}*{听}<[就]>*{懂}');
  });
  it('equals sentenceTokens without a head', () => {
    const cases: [string, string, string][] = [
      ['我在学习中文。', '我 在 学习 中文 。', ''],
      ['他一喝酒就脸红。', '他 一 喝酒 就 脸红 。', ''],
      ['学习者', '学 习者', ''],
      ['学校很大', '学校 很 大', ''],
      ['他学得快', '他 学 得 快', ''],
      ['他一听就懂', '他 一听 就 懂', '一就'],
      ['好，OK', '好 ， OK', ''],
    ];
    for (const idx of [index, withXue]) {
      for (const [zh, cuts, pattern] of cases) {
        const want = sentenceTokens(zh, idx, pattern, seg(cuts));
        expect(lineTokens(zh, idx, { pattern, segments: seg(cuts) })).toEqual(want);
        expect(lineTokens(zh, idx, { pattern, head: [], segments: seg(cuts) })).toEqual(want);
      }
    }
  });
});
