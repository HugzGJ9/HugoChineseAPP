import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { parseFamily, parseHsk, parseRegister } from './families';
import * as sentence from '../sentence';
import { browserSegments, fold, formulaParts, grammarItems, itemTitle, matchItem, patternChars, pick, pickList, sentenceTokens, vocabIndex, vocabLinks } from './list';
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

describe('patternChars', () => {
  it('keeps the fixed Chinese of the pattern and its alts', () => {
    expect(patternChars({ hanzi: '除非A，才（会/能）B', alts: [] })).toBe('除非才会能');
    expect(patternChars({ hanzi: '一+V+就+Result', alts: ['一…就'] })).toBe('一就一就');
  });
});

describe('tokenizer re-export', () => {
  it('keeps the moved tokenizer importable from list.ts (tests in ../sentence.test.ts)', () => {
    expect(sentenceTokens).toBe(sentence.sentenceTokens);
    expect(vocabIndex).toBe(sentence.vocabIndex);
    expect(vocabLinks).toBe(sentence.vocabLinks);
    expect(browserSegments).toBe(sentence.browserSegments);
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
