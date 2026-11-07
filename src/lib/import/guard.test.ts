import { describe, expect, it } from 'vitest';
import type { Note, NoteKind, SheetReport, VocabFile } from '../types';
import { checkImport, prepareImport } from './guard';
import { detectRenames, mergeAliases } from './renames';
import { cardId, deriveCards, resolveEventCards, resolveNoteId } from '../engine/schedule';

function note(id: string, row: number, over: Partial<Note> = {}): Note {
  const kind: NoteKind = id.startsWith('g:') ? 'grammar' : 'vocab';
  return {
    id,
    kind,
    hanzi: kind === 'grammar' ? id.slice(2) : id.slice(2).split('|')[0],
    alts: [],
    pinyin: '',
    pinyinNum: '',
    en: 'x',
    notes: [],
    tags: ['HSK4'],
    refs: [{ sheet: kind === 'grammar' ? 'Grammar' : 'HSK四级', row }],
    order: row,
    studied: false,
    examples: [],
    ...over,
  };
}

function report(notes: Note[], extra: SheetReport[] = []): SheetReport[] {
  const by = new Map<string, SheetReport>();
  for (const n of notes) {
    const s = n.refs[0].sheet;
    const r = by.get(s) ?? { name: s, kind: n.kind, rows: 0, notes: 0, studied: 0, colours: {} };
    r.rows++;
    r.notes++;
    by.set(s, r);
  }
  return [...by.values(), ...extra];
}

function vocab(notes: Note[], over: Partial<VocabFile> = {}): VocabFile {
  return {
    version: 1,
    importedAt: 0,
    source: { name: 'x.xlsx', modified: 0, size: 0 },
    hash: String(notes.length),
    notes,
    issues: [],
    seeds: {},
    report: report(notes),
    ...over,
  };
}

const words = (n: number, sheet = 'HSK四级', from = 0) =>
  Array.from({ length: n }, (_, i) => note(`v:词${from + i}|ci`, from + i + 2, { refs: [{ sheet, row: from + i + 2 }] }));

describe('checkImport', () => {
  it('lets the first import and typical edits through', () => {
    const prev = vocab([...words(100), ...words(10, 'HSK五级', 200)]);
    expect(checkImport(null, prev)).toEqual({ ok: true });
    // Five words deleted, three added, one sheet slightly smaller.
    const next = vocab([...words(95), ...words(3, 'HSK四级', 300), ...words(8, 'HSK五级', 200)]);
    expect(checkImport(prev, next)).toEqual({ ok: true });
  });

  it('holds a list that lost a quarter of its notes', () => {
    const prev = vocab([...words(100), ...words(100, 'HSK五级', 200)]);
    const next = vocab([...words(100), ...words(50, 'HSK五级', 200)]);
    const c = checkImport(prev, next);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reasons[0]).toContain('150 notes instead of 200');
  });

  it('does not hold a small list for a small drop', () => {
    const prev = vocab(words(40));
    expect(checkImport(prev, vocab(words(30))).ok).toBe(true);
  });

  it('holds when a sheet that had notes is skipped or missing', () => {
    const prev = vocab([...words(100), ...words(5, 'Mesure', 200)]);
    const skipped = vocab(words(100), {
      report: [...report(words(100)), { name: 'Mesure', kind: 'skipped', rows: 5, notes: 0, studied: 0, colours: {} }],
    });
    const c = checkImport(prev, skipped);
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reasons.join(' ')).toContain('Mesure');
    const missing = checkImport(prev, vocab(words(100)));
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reasons.join(' ')).toContain('“Mesure” (5 notes) is missing');
  });

  it('holds when one sheet lost more than half of its notes', () => {
    const prev = vocab([...words(200), ...words(10, 'HSK五级', 300)]);
    const c = checkImport(prev, vocab([...words(200), ...words(4, 'HSK五级', 300)]));
    expect(c.ok).toBe(false);
    if (!c.ok) expect(c.reasons).toEqual(['Sheet “HSK五级” went from 10 to 4 notes.']);
  });
});

describe('detectRenames', () => {
  it('pairs a pinyin-letter fix on the same row (history follows the word)', () => {
    const prev = [note('v:学习|xuexu', 5), note('v:朋友|pengyou', 6)];
    const next = [note('v:学习|xuexi', 5), note('v:朋友|pengyou', 6)];
    expect(detectRenames(prev, next)).toEqual({ 'v:学习|xuexu': 'v:学习|xuexi' });
  });

  it('pairs by ID cell when rows moved, and grammar patterns by row', () => {
    const prev = [note('v:学习|xuexu', 5, { refs: [{ sheet: 'HSK四级', row: 5, id: '233' }] }), note('g:越来越', 3)];
    const next = [note('v:学习|xuexi', 9, { refs: [{ sheet: 'HSK四级', row: 9, id: '233' }] }), note('g:越来越…', 3)];
    expect(detectRenames(prev, next)).toEqual({ 'v:学习|xuexu': 'v:学习|xuexi', 'g:越来越': 'g:越来越…' });
  });

  it('ignores ambiguous pairs, other hanzi and other kinds', () => {
    // Two new candidates for the same old row (ID cell and row both match).
    const prev = [note('v:学习|xuexu', 5, { refs: [{ sheet: 'HSK四级', row: 5, id: '7' }] })];
    const next = [
      note('v:学习|xuexi', 5, { refs: [{ sheet: 'HSK四级', row: 5 }] }),
      note('v:学习|xuexie', 8, { refs: [{ sheet: 'HSK四级', row: 8, id: '7' }] }),
    ];
    expect(detectRenames(prev, next)).toEqual({});
    // A different word on the same row is not a rename.
    expect(detectRenames([note('v:学习|xuexi', 5)], [note('v:学校|xuexiao', 5)])).toEqual({});
    // Same row, other kind.
    expect(detectRenames([note('v:学习|xuexi', 5)], [note('m:学习|xuexi', 5, { kind: 'measure' })])).toEqual({});
  });
});

describe('aliases', () => {
  const S = { retention: 0.9, spreadDays: 60, recall: false, listen: false };
  const T0 = Date.UTC(2026, 10, 1, 12);
  const ev = (id: string, card: string, t: number) => ({ id, card, r: 3 as const, t, d: 3000, m: 'reveal', dev: 'pc' });

  it('counts old-id events for the renamed note, without touching the stored events', () => {
    const old = 'v:学习|xuexu';
    const neu = 'v:学习|xuexi';
    const events = [ev('e1', cardId(old, 'recog'), T0), ev('e2', cardId(old, 'recog'), T0 + 86400000)];
    const frozen = JSON.stringify(events);
    const view = resolveEventCards(events, { [old]: neu }, new Set([neu]));
    expect(JSON.stringify(events)).toBe(frozen);
    const cards = deriveCards([note(neu, 5)], view, {}, S);
    expect(cards[0].nEvents).toBe(2);
    expect(cards[0].reps).toBe(2);
  });

  it('follows chains and ignores an alias whose source is a current note again (revert)', () => {
    const aliases = { a: 'b', b: 'c' };
    expect(resolveNoteId('a', aliases, new Set(['c']))).toBe('c');
    // Reverted: a is a note again.
    expect(resolveNoteId('a', { a: 'b', b: 'a' }, new Set(['a']))).toBe('a');
    expect(resolveNoteId('b', { a: 'b', b: 'a' }, new Set(['a']))).toBe('a');
    // Leads nowhere (word deleted) or loops: unchanged.
    expect(resolveNoteId('a', aliases, new Set(['x']))).toBe('a');
    expect(resolveNoteId('a', { a: 'b', b: 'a' }, new Set(['x']))).toBe('a');
  });

  it('a pinyin fix then its revert keeps the history on the current word', () => {
    const a = 'v:学习|xuexi';
    const b = 'v:学习|xuexu';
    const first = prepareImport(vocab([note(a, 5)]), vocab([note(b, 5)]));
    expect(first.vocab.aliases).toEqual({ [a]: b });
    const second = prepareImport(first.vocab, vocab([note(a, 5)]));
    expect(second.vocab.aliases).toEqual({ [a]: b, [b]: a });
    const events = [ev('e1', cardId(a, 'recog'), T0), ev('e2', cardId(b, 'recog'), T0 + 86400000)];
    const view = resolveEventCards(events, second.vocab.aliases!, new Set([a]));
    expect(view.map((e) => e.card)).toEqual([cardId(a, 'recog'), cardId(a, 'recog')]);
  });

  it('accumulates aliases (chain a→b→c) and moves seeds of renamed green words', () => {
    const a = 'v:学习|xuexa';
    const b = 'v:学习|xuexu';
    const c = 'v:学习|xuexi';
    const v1 = vocab([note(a, 5, { studied: true })], { seeds: { [a]: T0 } });
    // The worker gives the renamed green word a fresh seed time; the old one is kept.
    const v2 = prepareImport(v1, vocab([note(b, 5, { studied: true })], { seeds: { [a]: T0, [b]: T0 + 9e8 } })).vocab;
    expect(v2.seeds[b]).toBe(T0);
    const v3 = prepareImport(v2, vocab([note(c, 5, { studied: true })], { seeds: { ...v2.seeds, [c]: T0 + 9e9 } })).vocab;
    expect(v3.aliases).toEqual({ [a]: b, [b]: c });
    expect(v3.seeds[c]).toBe(T0);
    expect(resolveNoteId(a, v3.aliases!, new Set([c]))).toBe(c);
    expect(mergeAliases(v3.aliases, { x: 'x' })).toEqual(v3.aliases);
  });

  it('holds a broken import but still reports its renames', () => {
    const prev = vocab([note('v:学习|xuexu', 2), ...words(99, 'HSK四级', 10)]);
    const p = prepareImport(prev, vocab([note('v:学习|xuexi', 2), ...words(10, 'HSK四级', 10)]));
    expect(p.check.ok).toBe(false);
    expect(p.renames).toEqual({ 'v:学习|xuexu': 'v:学习|xuexi' });
  });
});
