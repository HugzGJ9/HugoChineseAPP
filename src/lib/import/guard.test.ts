import { describe, expect, it } from 'vitest';
import { pinyin } from 'pinyin-pro';
import type { Note, NoteKind, RowFill, SheetReport, StatusMark, VocabFile, WordStatus } from '../types';
import type { XSheet } from '../xlsx/read';
import { checkImport, prepareImport } from './guard';
import { buildVocab } from './build';
import { copyFills, fillsExplained, noteStatuses, rowKey, sheetRows, statusChanges } from '../status';
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

  it('sets the row colour times: 0 on the first import, then the file time for changed rows', () => {
    const k = (id: string) => rowKey(id, 'HSK四级', 0);
    const [w1, w2] = ['v:学习|xuexi', 'v:朋友|pengyou'];
    const first = prepareImport(null, vocab([note(w1, 2), note(w2, 3)], { importedAt: 5000, source: { name: 'x.xlsx', modified: 4000, size: 1 } }));
    expect(first.vocab.colourSince).toEqual({ [k(w1)]: ['mastered', 0], [k(w2)]: ['mastered', 0] });
    // A colour the incoming list carries is never trusted: it is computed here.
    const stale = vocab([note(w1, 2, { refs: [{ sheet: 'Measure words', row: 2, colour: 'FFFF00' }] })], {
      importedAt: 9000,
      source: { name: 'x.xlsx', modified: 0, size: 1 },
      colourSince: { bogus: ['new', 1] },
    });
    const second = prepareImport(first.vocab, stale);
    expect(second.vocab.colourSince).toEqual({ [rowKey(w1, 'Measure words', 0)]: ['notknown', 9000] });
    // Saved after the import time (clock skew): the import time.
    const third = prepareImport(second.vocab, { ...stale, importedAt: 9500, source: { name: 'x.xlsx', modified: 99999, size: 1 }, notes: [note(w2, 3, { refs: [{ sheet: 'Measure words', row: 3 }] })] });
    expect(third.vocab.colourSince).toEqual({ [rowKey(w2, 'Measure words', 0)]: ['new', 9500] });
  });

  it('a held import, once accepted, gets its colour times against the list as it is then', () => {
    const t = (n: number) => ({ importedAt: n, source: { name: 'x.xlsx', modified: n, size: 1 } });
    const k = (id: string) => rowKey(id, 'Measure words', 0);
    const m = (id: string, row: number, colour?: string) => note(id, row, { refs: [{ sheet: 'Measure words', row, ...(colour ? { colour } : {}) }] });
    const prev = prepareImport(null, vocab([m('v:学习|xuexu', 2, 'FFFF00'), ...words(99, 'HSK四级', 10)], t(100))).vocab;
    const held = prepareImport(prev, vocab([m('v:学习|xuexi', 2, 'FFFF00'), ...words(10, 'HSK四级', 10)], t(200)));
    expect(held.check.ok).toBe(false);
    // Meanwhile the list changed (sync): the row's colour time is newer there.
    const now = { ...prev, colourSince: { ...prev.colourSince, [k('v:学习|xuexu')]: ['notknown', 150] as [WordStatus, number] } };
    const accepted = prepareImport(now, held.vocab).vocab;
    expect(accepted.colourSince![k('v:学习|xuexi')]).toEqual(['notknown', 150]);
    expect(Object.keys(accepted.colourSince!)).toHaveLength(11);
  });

  it('holds a broken import but still reports its renames', () => {
    const prev = vocab([note('v:学习|xuexu', 2), ...words(99, 'HSK四级', 10)]);
    const p = prepareImport(prev, vocab([note('v:学习|xuexi', 2), ...words(10, 'HSK四级', 10)]));
    expect(p.check.ok).toBe(false);
    expect(p.renames).toEqual({ 'v:学习|xuexu': 'v:学习|xuexi' });
  });
});

// ---- Golden: the e2e sample workbook (e2e/make_sample.py), read as the importer sees it ----

const HSK4 = ['你好', '谢谢', '再见', '请', '对不起', '没关系', '我', '你', '他', '她', '们', '是', '不', '有', '好', '大', '小', '多'];
const HSK5 = ['少', '人', '水', '茶', '米饭', '吃', '喝', '看', '说', '去', '来', '今天', '明天', '学校', '老师', '朋友', '中国', '大'];
/** make_sample's fills: HSK四级 A–B cycle green, pink, yellow, none; HSK五级 A–D cycle green, yellow, red, blue, none, none. */
const FILLS4 = ['C5E0B4', 'EEA6A6', 'FDF95F', null];
const FILLS5 = ['A9D18E', 'FFFF00', 'FF0000', '8EA9DB', null, null];
const pinyinOf = (h: string) => pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[];

/** The sample as XSheets; `fill(sheet, row)` overrides a row's colour (undefined = the sample's). */
function sample(fill: (sheet: string, row: number) => string | null | undefined = () => undefined): XSheet[] {
  const sheet = (name: string, words: string[], fills: (string | null)[], cols: string[]): XSheet => ({
    name,
    rows: [
      { r: 1, cells: Object.fromEntries(['ID', 'Hanzi', 'Pinyin', 'English'].map((v, i) => ['ABCD'[i], { v, fill: null }])) },
      ...words.map((w, i) => {
        const r = i + 2;
        const over = fill(name, r);
        const f = over !== undefined ? over : fills[i % fills.length];
        const vals = [String(i + 1), w, pinyin(w), 'meaning'];
        return { r, cells: Object.fromEntries(vals.map((v, j) => ['ABCD'[j], { v, fill: cols.includes('ABCD'[j]) ? f : null }])) };
      }),
    ],
  });
  return [
    sheet('HSK四级', HSK4, FILLS4, ['A', 'B']),
    sheet('HSK五级', HSK5, FILLS5, ['A', 'B', 'C', 'D']),
    { name: 'Grammar', rows: [
      { r: 1, cells: { A: { v: 'Pattern', fill: null }, B: { v: 'English', fill: null }, C: { v: 'Example', fill: null } } },
      { r: 2, cells: { A: { v: '不 + verb', fill: null }, B: { v: 'negation', fill: null }, C: { v: '我不吃肉。', fill: null } } },
      { r: 3, cells: { A: { v: '是……的', fill: null }, B: { v: 'emphasis', fill: null }, C: { v: '我是昨天来的。', fill: null } } },
    ] },
  ];
}
const read = (sheets: XSheet[], at: number) => buildVocab(sheets, { source: { name: 'sample.xlsx', modified: at, size: 1 }, now: at, pinyinOf });
/** The workbook after the app wrote `fills` into it (the patcher colours the row's status cells). */
const patched = (fills: RowFill[]) => sample((sheet, row) => {
  const f = fills.find((x) => x.sheet === sheet && x.row === row);
  return f ? f.fill : undefined;
});
const statuses = (v: VocabFile, marks: StatusMark[]) => noteStatuses(sheetRows(v.notes, marks, v.colourSince));
const smark = (note: string, a: StatusMark['a'], t: number, id: string): StatusMark => ({ id, note, a, t, dev: 'pc' });

describe('golden: the sample workbook', () => {
  const v0 = prepareImport(null, read(sample(), 1000)).vocab;
  const id = (hanzi: string) => v0.notes.find((n) => n.hanzi === hanzi)!.id;

  it('reads the expected statuses: HSK四级 all Mastered, HSK五级 by colour', () => {
    const st = statuses(v0, []);
    expect(HSK4.filter((h) => h !== '大').map((h) => st.get(id(h)))).toEqual(HSK4.filter((h) => h !== '大').map(() => 'mastered'));
    expect(['少', '人', '水', '茶', '米饭', '吃'].map((h) => st.get(id(h)))).toEqual(['mastered', 'notknown', 'studying', 'studying', 'new', 'new']);
    expect(Object.values(v0.colourSince!).every(([, t]) => t === 0)).toBe(true);
  });

  it('re-imported over itself keeps every status and colour time', () => {
    const marks = [smark(id('少'), 'st:notknown', 500, 'a'), smark(id('谢谢'), 'st:new', 500, 'b'), smark(id('米饭'), 'st:mastered', 500, 'c')];
    const v1 = prepareImport(v0, read(sample(), 2000)).vocab;
    expect(v1.colourSince).toEqual(v0.colourSince);
    expect(statuses(v1, marks)).toEqual(statuses(v0, marks));
    expect(statuses(v1, [])).toEqual(statuses(v0, []));
    const v2 = prepareImport(v1, read(sample(), 3000)).vocab;
    expect(v2.colourSince).toEqual(v0.colourSince);
  });

  it('the app\'s own write, re-imported with its intent, keeps every status and leaves nothing to write', () => {
    const marks = [
      smark(id('少'), 'st:notknown', 500, 'a'), // HSK五级 green → yellow
      smark(id('谢谢'), 'st:new', 500, 'b'), // HSK四级 pink → no fill
      smark(id('请'), 'st:notknown', 500, 'c'), // HSK四级 blank → yellow
      smark(id('米饭'), 'st:studying', 500, 'd'), // HSK五级 blank → blue
      smark(id('你好'), 'st:mastered', 500, 'e'), // already green: nothing to write
    ];
    const fills = copyFills(sheetRows(v0.notes, marks, v0.colourSince));
    expect(fills.map((f) => [f.hanzi, f.fill])).toEqual([['谢谢', null], ['请', 'FFFF00'], ['少', 'FFFF00'], ['米饭', '8FAADC']]);
    const before = statuses(v0, marks);
    const v1 = prepareImport(v0, read(patched(fills), 4000), fillsExplained(fills)).vocab;
    expect(statuses(v1, marks)).toEqual(before);
    expect(copyFills(sheetRows(v1.notes, marks, v1.colourSince))).toEqual([]);
    for (const f of fills) expect(v1.colourSince![f.key!]).toEqual([f.status, 500]);
    // Without the intent the write reads as Excel edits at the upload time: same statuses, but a newer mark from the
    // other device would lose to it.
    const naive = prepareImport(v0, read(patched(fills), 4000)).vocab;
    for (const f of fills) expect(naive.colourSince![f.key!]).toEqual([f.status, 4000]);
    const later = [...marks, smark(id('少'), 'st:mastered', 600, 'f')];
    expect(statuses(v1, later).get(id('少'))).toBe('mastered');
    expect(statuses(naive, later).get(id('少'))).toBe('notknown');
  });

  it('an HSK四级 recolour in Excel is an edit: it beats an older mark and is reported by the status diff', () => {
    const marks = [smark(id('再见'), 'st:notknown', 500, 'a')];
    expect(statuses(v0, marks).get(id('再见'))).toBe('notknown');
    // Hugo colours 再见 (row 4, yellow) green in Excel at 900.
    const v1 = prepareImport(v0, read(sample((s, r) => (s === 'HSK四级' && r === 4 ? 'C5E0B4' : undefined)), 900)).vocab;
    expect(v1.colourSince![rowKey(id('再见'), 'HSK四级', 0)]).toEqual(['mastered', 900]);
    expect(statuses(v1, marks).get(id('再见'))).toBe('mastered');
    expect(copyFills(sheetRows(v1.notes, marks, v1.colourSince))).toEqual([]);
    expect(statusChanges(statuses(v0, marks), statuses(v1, marks), v1.notes)).toEqual([{ note: id('再见'), hanzi: '再见', from: 'notknown', to: 'mastered' }]);
  });
});
