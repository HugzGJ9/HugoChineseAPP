import { describe, expect, it } from 'vitest';
import type { Note } from '../types';
import { fold, formulaParts, grammarItems, groupItems, itemTitle, matchItem } from './list';
import type { GrammarLabel, LessonEntry } from './types';

// Generic textbook patterns only: no personal data in this public repo.
function note(hanzi: string, en: string, order: number, extra: Partial<Note> = {}): Note {
  return {
    id: `g:${hanzi}|`, kind: 'grammar', hanzi, alts: [], pinyin: '', pinyinNum: '', en, notes: [], tags: ['语法'],
    refs: [{ sheet: '语法', row: order + 2 }], order, studied: false, examples: [], ...extra,
  } as Note;
}

const unless = note('除非A，才B', 'Unless A, then B', 1);
const asSoon = note('一+V+就+Result', 'As soon as', 2, { examples: [{ zh: '我一到家就睡觉。' }] as Note['examples'] });
const notAs = note('A+不如+B', 'A is not as good as B', 3);
const vocab = { ...note('学习', 'to study', 0), kind: 'vocab' } as Note;

const lesson = (k: string, fr: string, extra: Partial<LessonEntry['x']> = {}): LessonEntry => ({
  k, at: 1, model: 'test', pv: 1,
  x: { title: { fr, en: '' }, formula: '', meaning: { fr: '', en: '' }, register: 'neutral', rules: [], examples: [], mistakes: [], related: [], ...extra },
});

describe('grammarItems', () => {
  it('keeps grammar notes only, in sheet order, and prefers labels over lesson suggestions', () => {
    const labels = new Map<string, GrammarLabel>([[unless.id, { family: 'condition', src: 'hugo', at: 1 }]]);
    const lessons = new Map([[unless.id, lesson(unless.id, 'À moins que', { suggested: { family: 'time', hsk: 5 } })], [notAs.id, lesson(notAs.id, 'A moins bien que B', { suggested: { family: 'compare' } })]]);
    const items = grammarItems([notAs, vocab, asSoon, unless], labels, lessons);
    expect(items.map((i) => i.note.hanzi)).toEqual(['除非A，才B', '一+V+就+Result', 'A+不如+B']);
    expect(items[0]).toMatchObject({ family: 'condition', hsk: 5 });
    expect(items[2].family).toBe('compare');
    expect(items[1].family).toBeUndefined();
  });
});

describe('itemTitle', () => {
  const [withLesson] = grammarItems([unless], new Map(), new Map([[unless.id, lesson(unless.id, 'À moins que A, alors B')]]));
  const [bare] = grammarItems([asSoon], new Map(), new Map());
  it('shows the pattern, the French or the English title', () => {
    expect(itemTitle(withLesson, 'zh').text).toBe('除非A，才B');
    expect(itemTitle(withLesson, 'fr')).toEqual({ text: 'À moins que A, alors B', fallback: false });
    expect(itemTitle(withLesson, 'en').text).toBe('Unless A, then B');
  });
  it('falls back to English, flagged, when there is no French yet', () => {
    expect(itemTitle(bare, 'fr')).toEqual({ text: 'As soon as', fallback: true });
  });
});

describe('matchItem', () => {
  const items = grammarItems([unless, asSoon, notAs], new Map([[notAs.id, { family: 'compare', hsk: 4, src: 'claude', at: 1 } as GrammarLabel]]), new Map([[unless.id, lesson(unless.id, 'À moins que')]]));
  const find = (q: string) => items.filter((i) => matchItem(i, q)).map((i) => i.note.hanzi);
  it('finds by hanzi in the pattern or the examples', () => {
    expect(find('除非')).toEqual(['除非A，才B']);
    expect(find('到家')).toEqual(['一+V+就+Result']);
  });
  it('finds by English or French, ignoring case and accents', () => {
    expect(find('as soon')).toEqual(['一+V+就+Result']);
    expect(find('a moins')).toEqual(['除非A，才B']);
  });
  it('finds by family name and HSK level', () => {
    expect(find('comparing')).toEqual(['A+不如+B']);
    expect(find('hsk 4')).toEqual(['A+不如+B']);
  });
  it('matches everything on an empty query', () => {
    expect(find('  ')).toHaveLength(3);
  });
});

describe('groupItems', () => {
  const items = grammarItems([unless, asSoon, notAs], new Map<string, GrammarLabel>([[notAs.id, { family: 'compare', hsk: 4, src: 'hugo', at: 1 }], [unless.id, { family: 'condition', src: 'hugo', at: 1 }]]), new Map());
  it('groups by family in family order, unlabelled last', () => {
    expect(groupItems(items, 'family', 'en').map((g) => [g.key, g.items.length])).toEqual([['condition', 1], ['compare', 1], ['none', 1]]);
  });
  it('groups by HSK level', () => {
    expect(groupItems(items, 'hsk', 'fr').map((g) => g.title)).toEqual(['HSK 4', 'Pas encore classé']);
  });
  it('keeps the sheet order as one group', () => {
    expect(groupItems(items, 'excel', 'zh')[0].items).toHaveLength(3);
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
  it('reads bracketed slots from a lesson formula', () => {
    expect(show('除非 [条件]，才 [结果]')).toBe('除非 [条件] ，才 [结果]');
  });
});

describe('fold', () => {
  it('folds case, accents and punctuation', () => {
    expect(fold('Règle, À moins…')).toBe('regle a moins');
  });
});
