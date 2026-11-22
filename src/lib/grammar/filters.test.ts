import { beforeEach, describe, expect, it } from 'vitest';
import type { Note, WordStatus } from '../types';
import { activeCount, applyFilter, filterCounts, neighbours, NO_FILTER, readFilter, saveFilter, toggle } from './filters';
import { grammarItems } from './list';

// Generic textbook patterns only: no personal data in this public repo.
const note = (hanzi: string, order: number, grammar?: Note['grammar']) =>
  ({ id: `g:${hanzi}`, kind: 'grammar', hanzi, alts: [], pinyin: '', pinyinNum: '', en: hanzi, notes: [], tags: [], refs: [], order, studied: false, examples: [], grammar }) as Note;

const items = grammarItems([
  note('除非A，才B', 1, { hsk: 5, family: 'condition' }),
  note('只要A，就B', 2, { hsk: 4, family: 'condition' }),
  note('A不如B', 3, { hsk: 4, family: 'compare' }),
  note('绝不', 4),
]);
const statuses = new Map<string, WordStatus>([['g:A不如B', 'notknown']]);
const ids = (f = NO_FILTER) => applyFilter(items, f, statuses).map((i) => i.note.hanzi);

describe('applyFilter', () => {
  it('shows everything without boxes ticked', () => {
    expect(ids()).toHaveLength(4);
  });
  it('ORs inside a group and ANDs across groups', () => {
    let f = toggle(NO_FILTER, 'hsk', 4);
    f = toggle(f, 'hsk', 5);
    expect(ids(f)).toEqual(['除非A，才B', '只要A，就B', 'A不如B']);
    f = toggle(f, 'family', 'compare');
    expect(ids(f)).toEqual(['A不如B']);
    expect(activeCount(f)).toBe(3);
  });
  it('filters unlabelled points and statuses (no status = not studied)', () => {
    expect(ids(toggle(NO_FILTER, 'family', 'none'))).toEqual(['绝不']);
    expect(ids(toggle(NO_FILTER, 'status', 'notknown'))).toEqual(['A不如B']);
    expect(ids(toggle(NO_FILTER, 'status', 'new'))).toHaveLength(3);
  });
  it('toggles a box off again', () => {
    expect(toggle(toggle(NO_FILTER, 'hsk', 4), 'hsk', 4).hsk).toEqual([]);
  });
});

describe('filterCounts', () => {
  it('counts each box given the other groups', () => {
    const c = filterCounts(items, toggle(NO_FILTER, 'family', 'condition'), statuses);
    expect(c.hsk.get(4)).toBe(1);
    expect(c.hsk.get(5)).toBe(1);
    expect(c.family.get('compare')).toBe(1); // own group ignored
    expect(c.status.get('new')).toBe(2);
  });
});

describe('neighbours', () => {
  it('walks the shown list', () => {
    const n = neighbours(items, 'g:只要A，就B');
    expect([n.prev?.note.hanzi, n.next?.note.hanzi]).toEqual(['除非A，才B', 'A不如B']);
    expect(neighbours(items, 'g:绝不').next).toBeUndefined();
    expect(neighbours(items, 'nope')).toEqual({});
  });
});

describe('read/save', () => {
  beforeEach(() => {
    const m = new Map<string, string>();
    globalThis.localStorage = {
      getItem: (k: string) => m.get(k) ?? null,
      setItem: (k: string, v: string) => void m.set(k, v),
      clear: () => m.clear(),
    } as unknown as Storage;
  });
  it('round-trips and survives bad data', () => {
    saveFilter(toggle(NO_FILTER, 'hsk', 4));
    expect(readFilter().hsk).toEqual([4]);
    localStorage.setItem('hz.gr.f', '{bad');
    expect(readFilter()).toEqual(NO_FILTER);
    localStorage.setItem('hz.gr.f', '{"hsk":"x"}');
    expect(readFilter()).toEqual(NO_FILTER);
  });
});
