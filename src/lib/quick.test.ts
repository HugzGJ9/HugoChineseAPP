// Quick cards: typed answers (right or wrong only) and the device-only saved session.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Note } from './types';
import { checkAnswer, clearSession, isRight, loadSession, saveSession, sessionKey, TARGETS, type CardSession } from './quick';
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
  it('lists the three targets', () => {
    expect(TARGETS).toEqual(['hanzi', 'pinyin', 'fr']);
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
