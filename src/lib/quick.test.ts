// Quick cards: typed answers (right or wrong only) and the device-only saved session.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note, ReviewEvent, WordStatus } from './types';
import {
  allRows,
  cardsHref,
  checkAnswer,
  clearSession,
  drawVerdict,
  filterRows,
  isRight,
  LIST_FILTERS,
  loadSession,
  readCardsQuery,
  readListFilter,
  recentByNote,
  saveSession,
  sessionKey,
  startIndex,
  TARGETS,
  type CardSession,
  type ListFilter,
} from './quick';
import { DAY } from './engine/schedule';
import { SHARED_PREFS, DEVICE_PREFS, collectPrefs } from './db';

/** localStorage for Node (one per browser profile). */
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

beforeEach(() => {
  vi.stubGlobal('localStorage', new MemStorage());
});

function note(over: Partial<Note> = {}): Note {
  return {
    id: 'v:你好|nihao',
    kind: 'vocab',
    hanzi: '你好',
    alts: [],
    pinyin: 'nǐ hǎo',
    pinyinNum: 'ni3 hao3',
    en: 'hello',
    fr: 'bonjour',
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK一级', row: 2 }],
    order: 0,
    studied: false,
    examples: [],
    ...over,
  };
}

const right = (...a: Parameters<typeof checkAnswer>) => isRight(checkAnswer(...a).verdict);

describe('checkAnswer', () => {
  it('lists the four targets, draw last', () => {
    expect(TARGETS).toEqual(['hanzi', 'pinyin', 'fr', 'draw']);
  });

  it('hanzi: right and wrong', () => {
    expect(right('hanzi', '你好', note(), false)).toBe(true);
    expect(right('hanzi', ' 你好 ', note(), false)).toBe(true);
    expect(right('hanzi', '你们', note(), false)).toBe(false);
    expect(right('hanzi', '', note(), false)).toBe(false);
    expect(checkAnswer('hanzi', '你们', note(), false).expected).toBe('你好');
  });

  it('pinyin: tone numbers and tone marks are right', () => {
    expect(right('pinyin', 'ni3 hao3', note(), false)).toBe(true);
    expect(right('pinyin', 'ni3hao3', note(), false)).toBe(true);
    expect(right('pinyin', 'nǐ hǎo', note(), false)).toBe(true);
  });

  it('pinyin: wrong tones grade as tones and count as wrong', () => {
    const c = checkAnswer('pinyin', 'ni2 hao3', note(), false);
    expect(c.verdict).toBe('tones');
    expect(isRight(c.verdict)).toBe(false);
    expect(right('pinyin', 'nihao', note(), false)).toBe(false);
    expect(right('pinyin', 'xie4 xie5', note(), false)).toBe(false);
  });

  it('pinyin: digits alone are tones (D10), letters are full pinyin', () => {
    const shao = note({ id: 'v:少|shao', hanzi: '少', pinyin: 'shǎo', pinyinNum: 'shao3' });
    expect(right('pinyin', '3', shao, false)).toBe(true);
    expect(right('pinyin', ' 3 ', shao, false)).toBe(true);
    expect(right('pinyin', '4', shao, false)).toBe(false);
    expect(right('pinyin', '4', { ...shao, altPinyin: ['shao4'] }, false)).toBe(true);
    expect(right('pinyin', 'shao3', shao, false)).toBe(true);
    expect(right('pinyin', 'shǎo', shao, false)).toBe(true);
    expect(right('pinyin', 'shao4', shao, false)).toBe(false);
    expect(right('pinyin', '3 3', note(), false)).toBe(true);
    expect(right('pinyin', '33', note(), false)).toBe(true);
    expect(right('pinyin', '3', note(), false)).toBe(false);
    expect(checkAnswer('pinyin', '2', shao, false).expected).toBe('shǎo');
  });

  it('draw: a typed hanzi is checked as hanzi', () => {
    expect(right('draw', '你好', note(), false)).toBe(true);
    expect(right('draw', '你', note(), false)).toBe(false);
  });

  it('fr: right, near miss is wrong, wrong', () => {
    expect(right('fr', 'bonjour', note(), false)).toBe(true);
    expect(right('fr', 'Bonjour', note(), false)).toBe(true);
    const near = checkAnswer('fr', 'bonjo', note(), false);
    expect(near.verdict).toBe('near');
    expect(isRight(near.verdict)).toBe(false);
    expect(right('fr', 'merci', note(), false)).toBe(false);
  });

  it('fr: English only counts when acceptBoth is on', () => {
    expect(right('fr', 'hello', note(), false)).toBe(false);
    expect(right('fr', 'hello', note(), true)).toBe(true);
    expect(right('fr', 'bonjour', note(), true)).toBe(true);
    expect(checkAnswer('fr', 'x', note(), true).expected).toBe('bonjour / hello');
  });

  it('fr: falls back to CFDICT French, then English, like the rest of the app', () => {
    expect(right('fr', 'salut', note({ fr: undefined, frAuto: 'salut' }), false)).toBe(true);
    expect(right('fr', 'hello', note({ fr: undefined, frAuto: undefined }), false)).toBe(true);
    // Same text twice is shown once.
    expect(checkAnswer('fr', 'x', note({ fr: undefined }), true).expected).toBe('hello');
  });
});

describe('isRight', () => {
  it('only right is right', () => {
    expect(isRight('right')).toBe(true);
    expect(isRight('tones')).toBe(false);
    expect(isRight('near')).toBe(false);
    expect(isRight('wrong')).toBe(false);
  });
});

describe('session', () => {
  const key = sessionKey('HSK四级', 'studying', 's1');
  const ids = ['a', 'b', 'c', 'd', 'e'];
  const base = { key, ids, i: 2, missed: ['a'], knew: 1, round: 1 };
  const all = new Set(ids);

  it('sessionKey is stable and a | in a sheet name does not collide', () => {
    expect(sessionKey('A', 'b', 'c')).toBe(sessionKey('A', 'b', 'c'));
    expect(sessionKey('A|b', 'c', 'd')).not.toBe(sessionKey('A', 'b|c', 'd'));
    expect(sessionKey('A', 'b|c', 'd')).not.toBe(sessionKey('A', 'b', 'c|d'));
    expect(sessionKey('A', '', 's')).not.toBe(sessionKey('A', 's', ''));
  });

  it('round trip sets v and at', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_700_000_000_000);
    try {
      saveSession(base);
      const s = loadSession(key, all);
      expect(s).toEqual({ v: 1, at: 1_700_000_000_000, ...base });
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps "Send to reviews" done, so a reload cannot send the same words twice', () => {
    saveSession({ ...base, i: ids.length, sent: true });
    expect(loadSession(key, all)?.sent).toBe(true);
    saveSession({ ...base, i: ids.length, sent: false });
    expect(loadSession(key, all)?.sent).toBeUndefined();
  });

  it('is stored under hz.qm.cards, device only (not shared, not backed up)', () => {
    saveSession(base);
    expect(localStorage.getItem('hz.qm.cards')).not.toBeNull();
    expect(SHARED_PREFS).not.toContain('qm.cards');
    expect(DEVICE_PREFS).not.toContain('qm.cards');
    expect(collectPrefs('backup')).not.toHaveProperty('qm.cards');
    expect(collectPrefs('shared')).not.toHaveProperty('qm.cards');
  });

  it('another deck reads as null; saving one deck replaces the other', () => {
    saveSession(base);
    expect(loadSession(sessionKey('HSK四级', 'studying', 's2'), all)).toBeNull();
    expect(loadSession(sessionKey('HSK五级', 'studying', 's1'), all)).toBeNull();
    const other = sessionKey('HSK五级', 'all', 's1');
    saveSession({ ...base, key: other });
    expect(loadSession(key, all)).toBeNull();
    expect(loadSession(other, all)?.key).toBe(other);
  });

  it('none saved, or cleared, reads as null', () => {
    expect(loadSession(key, all)).toBeNull();
    saveSession(base);
    clearSession();
    expect(localStorage.getItem('hz.qm.cards')).toBeNull();
    expect(loadSession(key, all)).toBeNull();
    clearSession(); // twice is fine
  });

  it('deleted ids before i move i back; after i they do not', () => {
    saveSession(base); // on 'c'
    const before = loadSession(key, new Set(['b', 'c', 'd', 'e']));
    expect(before?.ids).toEqual(['b', 'c', 'd', 'e']);
    expect(before?.i).toBe(1);
    expect(before?.ids[before.i]).toBe('c');
    expect(before?.missed).toEqual([]);

    const after = loadSession(key, new Set(['a', 'b', 'c', 'e']));
    expect(after?.ids).toEqual(['a', 'b', 'c', 'e']);
    expect(after?.i).toBe(2);
    expect(after?.missed).toEqual(['a']);
  });

  it('the card on screen deleted: the next card shows', () => {
    saveSession(base);
    const s = loadSession(key, new Set(['a', 'b', 'd', 'e']));
    expect(s?.i).toBe(2);
    expect(s?.ids[s.i]).toBe('d');
  });

  it('all ids gone reads as null', () => {
    saveSession(base);
    expect(loadSession(key, new Set(['x']))).toBeNull();
    expect(loadSession(key, new Set())).toBeNull();
  });

  it('a finished round (i = ids.length) restores, also after deletions', () => {
    saveSession({ ...base, i: ids.length, missed: ['a', 'd'], knew: 3 });
    const s = loadSession(key, all);
    expect(s?.i).toBe(5);
    expect(s?.missed).toEqual(['a', 'd']);
    const fewer = loadSession(key, new Set(['a', 'b', 'c']));
    expect(fewer?.ids).toEqual(['a', 'b', 'c']);
    expect(fewer?.i).toBe(3);
    expect(fewer?.missed).toEqual(['a']);
  });

  it('garbage reads as null', () => {
    const good: CardSession = { v: 1, at: 1, ...base };
    const bad: unknown[] = [
      'not json',
      '"a string"',
      '42',
      'null',
      '[]',
      JSON.stringify({ ...good, v: 2 }),
      JSON.stringify({ ...good, v: undefined }),
      JSON.stringify({ ...good, ids: 'a,b' }),
      JSON.stringify({ ...good, ids: ['a', 3] }),
      JSON.stringify({ ...good, missed: null }),
      JSON.stringify({ ...good, i: -1 }),
      JSON.stringify({ ...good, i: 1.5 }),
      JSON.stringify({ ...good, i: '2' }),
      JSON.stringify({ ...good, i: ids.length + 1 }),
      JSON.stringify({ ...good, knew: -1 }),
      JSON.stringify({ ...good, round: 0.5 }),
      JSON.stringify({ ...good, at: 'yesterday' }),
      JSON.stringify({ ...good, key: undefined }),
    ];
    for (const raw of bad) {
      localStorage.setItem('hz.qm.cards', raw as string);
      expect(loadSession(key, all), String(raw)).toBeNull();
    }
    localStorage.setItem('hz.qm.cards', JSON.stringify(good));
    expect(loadSession(key, all)).not.toBeNull();
  });

  it('saving copies the arrays (later edits by the screen do not leak in)', () => {
    const live = { ...base, ids: [...ids], missed: [...base.missed] };
    saveSession(live);
    live.ids.push('z');
    live.missed.push('b');
    expect(loadSession(key, new Set([...ids, 'z']))?.ids).toEqual(ids);
  });
});

describe('drawVerdict (D7)', () => {
  it('outline on is tracing: no verdict', () => {
    expect(drawVerdict({ guided: true })).toBeNull();
    expect(drawVerdict({ guided: true, revealed: true, hints: 3 })).toBeNull();
  });
  it('outline off: right with no hint, wrong when revealed or hinted', () => {
    expect(drawVerdict({ guided: false })).toBe('right');
    expect(drawVerdict({ guided: false, hints: 0, revealed: false, missing: [] })).toBe('right');
    expect(drawVerdict({ guided: false, hints: 1 })).toBe('wrong');
    expect(drawVerdict({ guided: false, revealed: true })).toBe('wrong');
    expect(drawVerdict({ guided: false, revealed: true, hints: 2 })).toBe('wrong');
  });
  it('words without stroke data count as neither', () => {
    expect(drawVerdict({ guided: false, missing: ['㐀'] })).toBeNull();
    expect(drawVerdict({ guided: false, missing: ['㐀'], revealed: true })).toBeNull();
  });
});

describe('deep link', () => {
  it('builds #/cards with the parts given', () => {
    expect(cardsHref({})).toBe('#/cards');
    expect(cardsHref({ sheet: '', status: undefined })).toBe('#/cards');
    expect(cardsHref({ sheet: 'HSK五级' }).startsWith('#/cards?sheet=')).toBe(true);
    expect(cardsHref({ sheet: 'A', status: 'wrong', at: 'v:少|shao' })).toMatch(/^#\/cards\?sheet=A&status=wrong&at=v%3A/);
  });

  it('round-trips sheet names with spaces, ?, &, /, #, + and Chinese', () => {
    const cases = [
      { sheet: 'HSK五级' },
      { sheet: 'My words 2', status: 'studying' },
      { sheet: 'a?b&c=d/e#f+g%h', status: 'missed', at: 'v:你好|nihao' },
      { sheet: '成语 / idioms & more?', at: 'v:一|yi1#x' },
      { status: 'week' },
      {},
    ];
    for (const c of cases) {
      const href = cardsHref(c);
      expect(href.slice(1).includes('#'), href).toBe(false);
      expect(readCardsQuery(href)).toEqual(c);
      expect(readCardsQuery(href.slice(1))).toEqual(c);
    }
  });

  it('reads nothing from a hash without a query, and ignores other keys', () => {
    expect(readCardsQuery('#/cards')).toEqual({});
    expect(readCardsQuery('')).toEqual({});
    expect(readCardsQuery('#/cards?x=1&sheet=&at=a')).toEqual({ at: 'a' });
  });

  it('startIndex: the index of at, else 0', () => {
    expect(startIndex(['a', 'b', 'c'], 'c')).toBe(2);
    expect(startIndex(['a', 'b', 'c'], 'z')).toBe(0);
    expect(startIndex(['a', 'b', 'c'])).toBe(0);
    expect(startIndex([], 'a')).toBe(0);
  });
});

describe('list filter (D11)', () => {
  const NOW = Date.UTC(2026, 10, 17, 12);
  const n = (i: number, sheet = 'HSK五级') => note({ id: `v:词${i}|ci${i}`, hanzi: `词${i}`, refs: [{ sheet, row: i + 2 }], order: i });
  const ev = (id: string, noteId: string, r: 1 | 2 | 3 | 4, t: number, type = 'recog'): ReviewEvent => ({ id, card: `${noteId}#${type}`, r, t, d: 0, m: 'reveal', dev: 'pc' });
  const row = (i: number, status: WordStatus, sheet = 'HSK五级') => ({ key: `${i}@${sheet}`, note: n(i, sheet), status });

  it('recentByNote: seen in the last 7 days, Again in the last 14, as Quick did', () => {
    const a = 'v:词1|ci1', b = 'v:词2|ci2', c = 'v:词3|ci3', d = 'v:词4|ci4';
    const r = recentByNote(
      [
        ev('1', a, 3, NOW - 2 * DAY),
        ev('2', a, 1, NOW - DAY, 'recall'),
        ev('3', b, 1, NOW - 10 * DAY),
        ev('4', c, 1, NOW - 20 * DAY),
        ev('5', c, 3, NOW - 7 * DAY), // exactly 7 days: not this week
        ev('6', d, 3, NOW - 7 * DAY + 1),
        ev('7', d, 1, NOW - 14 * DAY), // exactly 14 days: not recent
      ],
      NOW,
    );
    expect(r.get(a)).toEqual({ last: NOW - DAY, missed: true });
    expect(r.get(b)).toEqual({ last: 0, missed: true });
    expect(r.get(c)).toEqual({ last: 0, missed: false });
    expect(r.get(d)).toEqual({ last: NOW - 7 * DAY + 1, missed: false });
    expect(r.has('v:词9|ci9')).toBe(false);
  });

  it('filterRows: each filter, rows kept in order', () => {
    const rows = [row(1, 'new'), row(2, 'studying'), row(3, 'mastered'), row(4, 'notknown'), row(5, 'studying')];
    const recent = recentByNote([ev('a', 'v:词2|ci2', 3, NOW - DAY), ev('b', 'v:词4|ci4', 1, NOW - 10 * DAY), ev('c', 'v:词5|ci5', 1, NOW - DAY)], NOW);
    const ctx = { wrong: new Set(['v:词3|ci3', 'v:词5|ci5']), recent };
    const keep = (f: ListFilter) => filterRows(rows, f, ctx).map((r) => r.note.hanzi);
    expect(keep('all')).toEqual(['词1', '词2', '词3', '词4', '词5']);
    expect(filterRows(rows, 'all', ctx)).not.toBe(rows);
    expect(keep('new')).toEqual(['词1']);
    expect(keep('studying')).toEqual(['词2', '词5']);
    expect(keep('notknown')).toEqual(['词4']);
    expect(keep('mastered')).toEqual(['词3']);
    expect(keep('wrong')).toEqual(['词3', '词5']);
    expect(keep('week')).toEqual(['词2', '词5']);
    expect(keep('missed')).toEqual(['词4', '词5']);
    // Extra row fields are kept (generic).
    expect(filterRows(rows, 'new', ctx)[0].key).toBe('1@HSK五级');
  });

  it('readListFilter: known values, anything else is all', () => {
    for (const f of LIST_FILTERS) expect(readListFilter(f)).toBe(f);
    expect(LIST_FILTERS).toEqual(['all', 'new', 'studying', 'notknown', 'mastered', 'wrong', 'week', 'missed']);
    expect(readListFilter('st:new')).toBe('all');
    expect(readListFilter(undefined)).toBe('all');
    expect(readListFilter(3)).toBe('all');
  });

  it('allRows: workbook order, one row per note (its first)', () => {
    const bySheet = new Map([
      ['HSK四级', [row(3, 'new', 'HSK四级'), row(1, 'mastered', 'HSK四级')]],
      ['HSK五级', [row(2, 'studying'), row(1, 'notknown'), row(4, 'new')]],
      ['Empty', []],
      ['Extra', [row(4, 'mastered', 'Extra'), row(5, 'new', 'Extra')]],
    ]);
    const all = allRows(bySheet);
    expect(all.map((r) => [r.note.hanzi, r.status])).toEqual([
      ['词3', 'new'],
      ['词1', 'mastered'],
      ['词2', 'studying'],
      ['词4', 'new'],
      ['词5', 'new'],
    ]);
    expect(all[1]).toBe(bySheet.get('HSK四级')![1]);
    expect(allRows(new Map())).toEqual([]);
  });
});

describe('saved sessions from the Quick screen (D8)', () => {
  it('a session saved by the Quick version (v: 1, same fields) still loads', () => {
    const key = sessionKey('HSK四级', 'st:studying', 'abc');
    // Exactly what the Quick screen's saveSession wrote.
    localStorage.setItem(
      'hz.qm.cards',
      JSON.stringify({ v: 1, key, ids: ['a', 'b', 'c'], i: 1, missed: ['a'], knew: 0, round: 2, sent: true, at: 1_763_000_000_000 }),
    );
    expect(loadSession(key, new Set(['a', 'b', 'c']))).toEqual({
      v: 1,
      key,
      ids: ['a', 'b', 'c'],
      i: 1,
      missed: ['a'],
      knew: 0,
      round: 2,
      sent: true,
      at: 1_763_000_000_000,
    });
    // And one without the optional field.
    localStorage.setItem('hz.qm.cards', JSON.stringify({ v: 1, key, ids: ['a'], i: 0, missed: [], knew: 0, round: 1, at: 1 }));
    expect(loadSession(key, new Set(['a']))?.sent).toBeUndefined();
    expect(loadSession(key, new Set(['a']))?.ids).toEqual(['a']);
  });
});
