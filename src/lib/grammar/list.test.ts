import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { parseFamily, parseHsk, parseRegister } from './families';
import { fold, formulaParts, grammarItems, itemTitle, matchItem, patternChars, pick, pickList, sentenceTokens, vocabIndex, vocabLinks } from './list';
import type { GrammarInfo } from './types';

// Generic textbook patterns only: no personal data in this public repo.
function note(hanzi: string, en: string, order: number, extra: Partial<Note> = {}): Note {
  return {
    id: `g:${hanzi}`, kind: 'grammar', hanzi, alts: [], pinyin: '', pinyinNum: '', en, notes: [], tags: ['语法'],
    refs: [{ sheet: '语法', row: order + 2 }], order, studied: false, examples: [], ...extra,
  } as Note;
}
const word = (hanzi: string, alts: string[] = []) => ({ ...note(hanzi, '', 0), id: `v:${hanzi}`, kind: 'vocab', alts }) as Note;

const g = (info: GrammarInfo) => ({ grammar: info });
const unless = note('除非A，才B', 'Unless, then', 1, g({ family: 'condition', hsk: 5, title: { en: 'Unless A, only then B', fr: 'À moins que A' }, def: { en: 'A is the only condition.' } }));
const asSoon = note('一+V+就+Result', 'As soon as', 2, { examples: [{ zh: '我一到家就睡觉。' }], ...g({ sentences: [{ zh: '他一喝酒就脸红。' }] }) });
const notAs = note('A+不如+B', 'A not as good as B', 3, g({ family: 'compare', hsk: 4, title: { en: 'A is not as good as B' } }));

describe('grammarItems', () => {
  it('keeps grammar notes only, in sheet order, with their Excel labels', () => {
    const items = grammarItems([notAs, word('学习'), asSoon, unless]);
    expect(items.map((i) => i.note.hanzi)).toEqual(['除非A，才B', '一+V+就+Result', 'A+不如+B']);
    expect(items[0]).toMatchObject({ family: 'condition', hsk: 5 });
    expect(items[1].family).toBeUndefined();
  });
});

describe('itemTitle and pick', () => {
  const [u, a, n] = grammarItems([unless, asSoon, notAs]);
  it('shows the title in the reading language', () => {
    expect(itemTitle(u, 'fr')).toEqual({ text: 'À moins que A' });
    expect(itemTitle(u, 'en')).toEqual({ text: 'Unless A, only then B' });
  });
  it('falls back to the other language, tagged', () => {
    expect(itemTitle(n, 'fr')).toEqual({ text: 'A is not as good as B', fallback: 'en' });
    expect(itemTitle(a, 'fr')).toEqual({ text: 'As soon as', fallback: 'en' });
  });
  it('picks texts and bullet lists', () => {
    expect(pick({ fr: 'Seul' }, 'en')).toEqual({ text: 'Seul', fallback: 'fr' });
    expect(pick(undefined, 'en')).toBeUndefined();
    expect(pickList({ en: ['a'], fr: [] }, 'fr')).toEqual({ items: ['a'], fallback: 'en' });
    expect(pickList(undefined, 'fr')).toEqual({ items: [] });
  });
});

describe('matchItem', () => {
  const items = grammarItems([unless, asSoon, notAs]);
  const find = (q: string) => items.filter((i) => matchItem(i, q)).map((i) => i.note.hanzi);
  it('finds by hanzi in the pattern, the Excel examples and the sentences', () => {
    expect(find('除非')).toEqual(['除非A，才B']);
    expect(find('到家')).toEqual(['一+V+就+Result']);
    expect(find('喝酒')).toEqual(['一+V+就+Result']);
  });
  it('finds by English, French or the definition, ignoring case and accents', () => {
    expect(find('as soon')).toEqual(['一+V+就+Result']);
    expect(find('a moins')).toEqual(['除非A，才B']);
    expect(find('only condition')).toEqual(['除非A，才B']);
  });
  it('finds by family name and HSK level', () => {
    expect(find('comparing')).toEqual(['A+不如+B']);
    expect(find('hsk 4')).toEqual(['A+不如+B']);
  });
  it('matches everything on an empty query', () => {
    expect(find('  ')).toHaveLength(3);
  });
});

describe('formulaParts', () => {
  const show = (p: string) => formulaParts(p).map((x) => (x.t === 'slot' ? `[${x.s}]` : x.t === 'gap' ? '…' : x.s)).join(' ');
  it('splits Latin slots from fixed Chinese', () => {
    expect(show('除非A，才（会/能）B')).toBe('除非 [A] ，才（会/能） [B]');
    expect(show('V+得/不+上')).toBe('[V] 得/不上');
  });
  it('keeps multi-word slots whole and drops the + joiners', () => {
    expect(show('S+直到+Time/Event+才Action')).toBe('[S] 直到 [Time/Event] 才 [Action]');
    expect(show('至于+Question W')).toBe('至于 [Question W]');
  });
  it('turns ellipses into gaps', () => {
    expect(show('为…, 而…')).toBe('为 … ,而 …');
    expect(show('只有..., 才')).toBe('只有 … ,才');
  });
  it('reads bracketed slots', () => {
    expect(show('除非 [条件]，才 [结果]')).toBe('除非 [条件] ，才 [结果]');
  });
});

describe('sentenceTokens', () => {
  const index = vocabIndex([word('学习'), word('学'), word('中文'), word('就'), word('喝', ['喝酒']), unless]);
  // A fixed segmenter so the tests don't depend on the ICU dictionary of the machine.
  const seg = (cuts: string) => () => cuts.split(' ');
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

describe('patternChars and vocabLinks', () => {
  it('keeps the fixed Chinese of the pattern and its alts', () => {
    expect(patternChars({ hanzi: '除非A，才（会/能）B', alts: [] })).toBe('除非才会能');
    expect(patternChars({ hanzi: '一+V+就+Result', alts: ['一…就'] })).toBe('一就一就');
  });
  it('links a dictionary word to his words around it', () => {
    const index = vocabIndex([word('学习'), word('学'), word('留学'), word('中文')]);
    expect(vocabLinks('学', index)).toEqual(['v:学习', 'v:留学']);
    expect(vocabLinks('学习者', index)).toEqual(['v:学习', 'v:学']);
    expect(vocabLinks('猫', index)).toEqual([]);
  });
});

describe('Excel cell readers', () => {
  it('reads families in English, French, Chinese or as a prefix', () => {
    expect(['Comparing', 'comparer', '比较', 'Comparing & describing', 'compare'].map(parseFamily)).toEqual(Array(5).fill('compare'));
    expect(parseFamily('Formal words')).toBe('formal');
    expect(parseFamily('Mots soutenus')).toBe('formal');
    expect(parseFamily('Set phrases')).toBe('phrase');
    expect(parseFamily('nope')).toBeUndefined();
  });
  it('reads HSK levels and registers', () => {
    expect(['5', 'HSK 5', 'hsk5', '5.0', '7-9', 'HSK 7–9', '8'].map(parseHsk)).toEqual([5, 5, 5, 5, 7, 7, 7]);
    expect(parseHsk('0')).toBeUndefined();
    expect(parseHsk('five')).toBeUndefined();
    expect(['spoken', 'Écrit', 'soutenu', 'neutral', 'x'].map(parseRegister)).toEqual(['spoken', 'written', 'formal', 'neutral', undefined]);
  });
});

describe('fold', () => {
  it('folds case, accents and punctuation', () => {
    expect(fold('Règle, À moins…')).toBe('regle a moins');
  });
});
