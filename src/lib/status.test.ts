import { describe, expect, it } from 'vitest';
import type { MarkKind, Note, SourceRef, StatusMark, VocabFile, WordStatus } from './types';
import {
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_MARK,
  WORD_STATUSES,
  colourSinceFor,
  colourStatus,
  copyFills,
  fillsExplained,
  generalColourStatus,
  latestStatusMarks,
  markStatus,
  noteStatuses,
  rowKey,
  sheetRows,
  statusChanges,
} from './status';

const H4 = 'HSK四级';
const H5 = 'HSK五级';

function note(id: string, refs: SourceRef[], over: Partial<Note> = {}): Note {
  return {
    id,
    kind: 'vocab',
    hanzi: id.slice(2).split('|')[0],
    alts: [],
    pinyin: '',
    pinyinNum: '',
    en: 'x',
    notes: [],
    tags: [],
    refs,
    order: refs[0].row,
    studied: false,
    examples: [],
    ...over,
  };
}

let k = 0;
const mark = (noteId: string, a: MarkKind | string, t: number, id = `m${k++}`): StatusMark => ({ id, note: noteId, a: a as MarkKind, t, dev: 'pc' });

describe('constants', () => {
  it('lists the statuses in display order, with labels, fills and mark kinds', () => {
    expect(WORD_STATUSES).toEqual(['new', 'studying', 'notknown', 'mastered']);
    expect(WORD_STATUSES.map((s) => STATUS_LABEL[s])).toEqual(['Not studied', 'Studying', 'Not known', 'Mastered']);
    expect(STATUS_FILL).toEqual({ mastered: 'A9D18E', notknown: 'FFFF00', studying: '8FAADC', new: null });
    for (const s of WORD_STATUSES) expect(markStatus(STATUS_MARK[s])).toBe(s);
  });
});

describe('colour rules', () => {
  it('maps every colour of the workbook on general sheets', () => {
    const table: [string | null | undefined, string][] = [
      ['A9D18E', 'mastered'],
      ['C5E0B4', 'mastered'],
      ['00B050', 'mastered'],
      ['a9d18e', 'mastered'],
      ['FFFF00', 'notknown'],
      ['FDF95F', 'notknown'],
      ['FFF200', 'notknown'],
      [null, 'new'],
      [undefined, 'new'],
      ['', 'new'],
      ['FFFFFF', 'new'],
      ['FF0000', 'studying'],
      ['8FAADC', 'studying'],
      ['EEA6A6', 'studying'],
      ['7193FF', 'studying'],
      // Light red and a dark olive are not "Not known".
      ['FFC7CE', 'studying'],
      ['808000', 'studying'],
    ];
    for (const [c, s] of table) expect([c, generalColourStatus(c)]).toEqual([c, s]);
    for (const [c, s] of table) expect(colourStatus(H5, c)).toBe(s);
    expect(colourStatus('Measure words', 'FFFF00')).toBe('notknown');
    expect(colourStatus('语法', null)).toBe('new');
  });

  it('gives Mastered to every HSK四级 row, blank included', () => {
    for (const c of ['A9D18E', 'FFFF00', 'FDF95F', 'EEA6A6', 'FF0000', 'FFFFFF', null, undefined]) expect(colourStatus(H4, c)).toBe('mastered');
    expect(colourStatus('HSK 4', null)).toBe('mastered');
  });
});

describe('marks', () => {
  it('reads st:* and the legacy known/relearn as statuses; anything else sets none', () => {
    expect(markStatus('st:new')).toBe('new');
    expect(markStatus('st:studying')).toBe('studying');
    expect(markStatus('st:notknown')).toBe('notknown');
    expect(markStatus('st:mastered')).toBe('mastered');
    expect(markStatus('known')).toBe('mastered');
    expect(markStatus('relearn')).toBe('notknown');
    for (const a of ['suspend', 'unsuspend', 'pin', 'st:other', 'toString', '']) expect(markStatus(a)).toBeNull();
  });

  it('keeps the latest status mark per note, by time then id, ignoring other kinds', () => {
    const ms = [mark('a', 'st:studying', 5, 'x2'), mark('a', 'st:mastered', 5, 'x1'), mark('a', 'suspend', 9), mark('b', 'known', 1), mark('b', 'pin', 3)];
    const l = latestStatusMarks(ms);
    expect(l.get('a')?.id).toBe('x2');
    expect(latestStatusMarks([...ms].reverse()).get('a')?.id).toBe('x2');
    expect(l.get('b')?.a).toBe('known');
    expect(l.size).toBe(2);
  });
});

describe('colourSinceFor', () => {
  const T = 1000;
  const n1 = note('v:学习|xuexi', [{ sheet: H5, row: 3, colour: 'A9D18E' }]);
  const n2 = note('v:朋友|pengyou', [{ sheet: H5, row: 4 }]);

  it('gives every row 0 when there is no previous map', () => {
    expect(colourSinceFor([n1, n2], undefined, {}, T)).toEqual({
      [rowKey(n1.id, H5, 0)]: ['mastered', 0],
      [rowKey(n2.id, H5, 0)]: ['new', 0],
    });
  });

  it('keeps the time of an unchanged status, gives t to a change and to a new row', () => {
    const prev = { [rowKey(n1.id, H5, 0)]: ['mastered', 50], [rowKey(n2.id, H5, 0)]: ['new', 60] } as VocabFile['colourSince'];
    const recoloured = { ...n2, refs: [{ sheet: H5, row: 4, colour: 'FFFF00' }] };
    const added = note('v:高兴|gaoxing', [{ sheet: H5, row: 5 }]);
    expect(colourSinceFor([n1, recoloured, added], prev, {}, T)).toEqual({
      [rowKey(n1.id, H5, 0)]: ['mastered', 50],
      [rowKey(n2.id, H5, 0)]: ['notknown', T],
      [rowKey(added.id, H5, 0)]: ['new', T],
    });
    // An empty previous map is a map: new rows get t.
    expect(colourSinceFor([n2], {}, {}, T)).toEqual({ [rowKey(n2.id, H5, 0)]: ['new', T] });
  });

  it('moves the times of renamed words to their new keys', () => {
    const old = 'v:学习|xuexu';
    const prev = { [rowKey(old, H5, 0)]: ['mastered', 50] } as VocabFile['colourSince'];
    expect(colourSinceFor([n1], prev, { [old]: n1.id }, T)).toEqual({ [rowKey(n1.id, H5, 0)]: ['mastered', 50] });
    expect(colourSinceFor([n1], prev, {}, T)).toEqual({ [rowKey(n1.id, H5, 0)]: ['mastered', T] });
  });

  it('uses the note colour for the first row of a list written by an older version', () => {
    const legacy = note('v:学习|xuexi', [{ sheet: H5, row: 3 }, { sheet: 'Measure words', row: 9 }], { colour: 'FFFF00' });
    expect(colourSinceFor([legacy], undefined, {}, T)).toEqual({
      [rowKey(legacy.id, H5, 0)]: ['notknown', 0],
      [rowKey(legacy.id, 'Measure words', 0)]: ['new', 0],
    });
  });
});

describe('sheetRows', () => {
  const a = note('v:学习|xuexi', [{ sheet: H4, row: 7, colour: 'EEA6A6' }, { sheet: H5, row: 2, colour: 'A9D18E' }], { order: 7 });
  const b = note('v:朋友|pengyou', [{ sheet: H4, row: 3 }], { order: 3 });
  const c = note('v:本|ben', [{ sheet: H5, row: 9 }, { sheet: H5, row: 4, colour: 'FF0000' }], { order: 100009 });
  const notes = [b, a, c];

  it('lists rows per sheet in Excel order, with #0 and #1 for two rows of one note', () => {
    const rows = sheetRows(notes, [], undefined);
    expect([...rows.keys()]).toEqual([H4, H5]);
    expect(rows.get(H4)!.map((r) => [r.ref.row, r.key, r.excel])).toEqual([
      [3, rowKey(b.id, H4, 0), 'mastered'],
      [7, rowKey(a.id, H4, 0), 'mastered'],
    ]);
    expect(rows.get(H5)!.map((r) => [r.ref.row, r.key, r.excel, r.colour])).toEqual([
      [2, rowKey(a.id, H5, 0), 'mastered', 'A9D18E'],
      [4, rowKey(c.id, H5, 1), 'studying', 'FF0000'],
      [9, rowKey(c.id, H5, 0), 'new', undefined],
    ]);
    expect(rows.get(H5)!.every((r) => r.status === r.excel && !r.mark && r.since === 0)).toBe(true);
  });

  it('a newer mark wins, an older one loses, a tie goes to Excel', () => {
    const since = {
      [rowKey(c.id, H5, 0)]: ['new', 100],
      [rowKey(c.id, H5, 1)]: ['studying', 300],
    } as VocabFile['colourSince'];
    const m = mark(c.id, 'st:mastered', 200);
    const rows = sheetRows(notes, [m], since).get(H5)!;
    const r9 = rows.find((r) => r.ref.row === 9)!;
    const r4 = rows.find((r) => r.ref.row === 4)!;
    expect(r9).toMatchObject({ since: 100, status: 'mastered', mark: m });
    expect(r4).toMatchObject({ since: 300, status: 'studying' });
    expect(r4.mark).toBeUndefined();
    const tie = sheetRows(notes, [mark(c.id, 'st:mastered', 100)], since).get(H5)!.find((r) => r.ref.row === 9)!;
    expect(tie.status).toBe('new');
    // Legacy "I know this" shows as Mastered; a suspend mark sets no status.
    const legacy = sheetRows([b], [mark(b.id, 'relearn', 5), mark(b.id, 'suspend', 9)], undefined).get(H4)![0];
    expect(legacy.status).toBe('notknown');
  });

  it('a time recorded for another status counts as unknown (0)', () => {
    const since = { [rowKey(c.id, H5, 0)]: ['mastered', 500] } as VocabFile['colourSince'];
    const r = sheetRows([c], [mark(c.id, 'st:notknown', 10)], since).get(H5)!.find((x) => x.ref.row === 9)!;
    expect(r).toMatchObject({ excel: 'new', since: 0, status: 'notknown' });
  });
});

describe('noteStatuses', () => {
  const a = note('v:学习|xuexi', [{ sheet: H4, row: 7, colour: 'EEA6A6' }, { sheet: H5, row: 2, colour: 'FFFF00' }], { order: 7 });

  it('takes a winning mark, else the row with the latest colour time, a tie going to the later sheet', () => {
    expect(noteStatuses(sheetRows([a], [], undefined)).get(a.id)).toBe('notknown');
    const h4Later = { [rowKey(a.id, H4, 0)]: ['mastered', 20], [rowKey(a.id, H5, 0)]: ['notknown', 10] } as VocabFile['colourSince'];
    expect(noteStatuses(sheetRows([a], [], h4Later)).get(a.id)).toBe('mastered');
    // The mark is newer than one row only: it still decides the word.
    expect(noteStatuses(sheetRows([a], [mark(a.id, 'st:studying', 15)], h4Later)).get(a.id)).toBe('studying');
    expect(noteStatuses(sheetRows([a], [mark(a.id, 'st:studying', 5)], h4Later)).get(a.id)).toBe('mastered');
  });
});

describe('copyFills', () => {
  const h5 = (id: string, row: number, colour?: string) => note(id, [{ sheet: H5, row, ...(colour ? { colour } : {}) }], { order: 100000 + row });
  const blank = h5('v:一|yi', 2);
  const pink = h5('v:二|er', 3, 'EEA6A6');
  const green = h5('v:三|san', 4, 'A9D18E');
  const same = h5('v:四|si', 5, 'FF0000');
  const h4 = note('v:五|wu', [{ sheet: H4, row: 6, colour: 'EEA6A6' }], { order: 6 });
  const h4m = note('v:六|liu', [{ sheet: H4, row: 7 }], { order: 7 });
  const h4p = note('v:七|qi', [{ sheet: H4, row: 8, colour: 'EEA6A6' }], { order: 8 });

  it('lists only rows whose status differs from their colour, with the target fill', () => {
    const marks = [
      mark(blank.id, 'st:mastered', 10),
      mark(pink.id, 'st:studying', 10),
      mark(green.id, 'st:new', 10),
      mark(same.id, 'st:studying', 10),
      mark(h4.id, 'st:notknown', 10),
      mark(h4m.id, 'st:mastered', 10),
      // Pink already says Studying under the general rules: the row stays pink.
      mark(h4p.id, 'st:studying', 10),
    ];
    const fills = copyFills(sheetRows([h4m, h4, h4p, same, green, pink, blank], marks, undefined));
    expect(fills).toEqual([
      { sheet: H4, row: 6, hanzi: '五', from: 'EEA6A6', fill: 'FFFF00', key: rowKey(h4.id, H4, 0), status: 'notknown', t: 10 },
      { sheet: H5, row: 2, hanzi: '一', from: null, fill: 'A9D18E', key: rowKey(blank.id, H5, 0), status: 'mastered', t: 10 },
      { sheet: H5, row: 4, hanzi: '三', from: 'A9D18E', fill: null, key: rowKey(green.id, H5, 0), status: 'new', t: 10 },
    ]);
    // Nothing changed: nothing to write.
    expect(copyFills(sheetRows([h4m, h4, same, green, pink, blank], [], undefined))).toEqual([]);
  });

  it('writes Studying blue on a blank row, and Not studied on an HSK四级 row as no fill', () => {
    const fills = copyFills(sheetRows([h4, blank], [mark(h4.id, 'st:new', 1), mark(blank.id, 'st:studying', 1)], undefined));
    expect(fills).toEqual([
      { sheet: H4, row: 6, hanzi: '五', from: 'EEA6A6', fill: null, key: rowKey(h4.id, H4, 0), status: 'new', t: 1 },
      { sheet: H5, row: 2, hanzi: '一', from: null, fill: '8FAADC', key: rowKey(blank.id, H5, 0), status: 'studying', t: 1 },
    ]);
  });
});

// ---- Merge rules between Excel colour changes and app marks (plan 2026-11-08, D4/D6) ----

const GREEN = 'A9D18E';
const GREEN2 = 'C5E0B4';
const YELLOW = 'FFFF00';
const YELLOW2 = 'FDF95F';
const PINK = 'EEA6A6';
const RED = 'FF0000';
const BLUE = '8FAADC';

/** A one-row note on a sheet (order follows the sheet: HSK四级 first). */
const one = (id: string, sheet: string, row: number, colour?: string) =>
  note(id, [{ sheet, row, ...(colour ? { colour } : {}) }], { order: (sheet === H4 ? 0 : 100000) + row });
/** The same note with every row recoloured, as the next workbook version shows it. */
const recolour = (n: Note, colour?: string): Note => ({
  ...n,
  refs: n.refs.map(({ colour: _c, ...r }) => ({ ...r, ...(colour ? { colour } : {}) })),
});
type Since = NonNullable<VocabFile['colourSince']>;
const list = (notes: Note[], colourSince: Since) => ({ notes, colourSince });
const statusOf = (notes: Note[], marks: StatusMark[], since: Since | undefined, id: string) => noteStatuses(sheetRows(notes, marks, since)).get(id);

describe('colourSinceFor: per-row colour class diffing', () => {
  const T = 9000;
  const id = 'v:学习|xuexi';

  it('keeps the entry when the colour class is the same, gives t to a class change, on every sheet', () => {
    const table: [string, string | undefined, string | undefined, [WordStatus, number], [WordStatus, number]][] = [
      // sheet, colour before, colour after, entry before, entry after
      [H5, GREEN, GREEN2, ['mastered', 50], ['mastered', 50]],
      [H5, YELLOW, YELLOW2, ['notknown', 50], ['notknown', 50]],
      [H5, RED, PINK, ['studying', 50], ['studying', 50]],
      [H5, undefined, 'FFFFFF', ['new', 50], ['new', 50]],
      [H5, GREEN, YELLOW, ['mastered', 50], ['notknown', T]],
      [H5, YELLOW, undefined, ['notknown', 50], ['new', T]],
      [H5, undefined, RED, ['new', 50], ['studying', T]],
      ['Measure words', BLUE, GREEN, ['studying', 50], ['mastered', T]],
      // HSK四级: rows stay Mastered until their class changes; then the class decides, like everywhere else.
      [H4, undefined, undefined, ['mastered', 50], ['mastered', 50]],
      [H4, PINK, RED, ['mastered', 50], ['mastered', 50]],
      [H4, GREEN2, GREEN, ['mastered', 50], ['mastered', 50]],
      [H4, undefined, GREEN2, ['mastered', 50], ['mastered', T]],
      [H4, GREEN2, YELLOW2, ['mastered', 50], ['notknown', T]],
      [H4, YELLOW2, undefined, ['notknown', 50], ['new', T]],
      [H4, PINK, undefined, ['mastered', 50], ['new', T]],
      [H4, YELLOW2, YELLOW, ['notknown', 50], ['notknown', 50]],
    ];
    for (const [sheet, a, b, was, want] of table) {
      const prev = one(id, sheet, 3, a);
      const got = colourSinceFor([recolour(prev, b)], list([prev], { [rowKey(id, sheet, 0)]: was }), {}, T)[rowKey(id, sheet, 0)];
      expect([sheet, a, b, got]).toEqual([sheet, a, b, want]);
    }
  });

  it('gives a new row its colour status at t (HSK四级: Mastered), and 0 with no previous list', () => {
    const prev = one('v:朋友|pengyou', H5, 2);
    const added = [one(id, H4, 3, YELLOW2), one('v:高兴|gaoxing', H5, 4, YELLOW)];
    const since = colourSinceFor([prev, ...added], list([prev], { [rowKey(prev.id, H5, 0)]: ['new', 10] }), {}, T);
    expect(since).toEqual({
      [rowKey(prev.id, H5, 0)]: ['new', 10],
      [rowKey(id, H4, 0)]: ['mastered', T],
      [rowKey('v:高兴|gaoxing', H5, 0)]: ['notknown', T],
    });
    expect(colourSinceFor(added, null, {}, T)).toEqual({
      [rowKey(id, H4, 0)]: ['mastered', 0],
      [rowKey('v:高兴|gaoxing', H5, 0)]: ['notknown', 0],
    });
    // A previous list without colour times (very old) counts as none.
    expect(colourSinceFor(added, { notes: [prev] }, {}, T)[rowKey(id, H4, 0)]).toEqual(['mastered', 0]);
  });

  it('compares the k-th row of a note in a sheet, and follows renames', () => {
    const two = note(id, [{ sheet: H5, row: 3, colour: GREEN }, { sheet: H5, row: 8 }], { order: 100003 });
    const since: Since = { [rowKey(id, H5, 0)]: ['mastered', 50], [rowKey(id, H5, 1)]: ['new', 60] };
    const next = note(id, [{ sheet: H5, row: 3, colour: GREEN }, { sheet: H5, row: 8, colour: YELLOW }], { order: 100003 });
    expect(colourSinceFor([next], list([two], since), {}, T)).toEqual({
      [rowKey(id, H5, 0)]: ['mastered', 50],
      [rowKey(id, H5, 1)]: ['notknown', T],
    });
    const old = 'v:学习|xuexu';
    const before = one(old, H4, 3, YELLOW);
    const prevSince: Since = { [rowKey(old, H4, 0)]: ['notknown', 50] };
    expect(colourSinceFor([one(id, H4, 3, YELLOW2)], list([before], prevSince), { [old]: id }, T)).toEqual({ [rowKey(id, H4, 0)]: ['notknown', 50] });
    expect(colourSinceFor([one(id, H4, 3, GREEN)], list([before], prevSince), { [old]: id }, T)).toEqual({ [rowKey(id, H4, 0)]: ['mastered', T] });
  });

  it('falls back to status equality when the previous colours are unknown (older lists, bare maps)', () => {
    // An older list: the note's colour only, no colour per row.
    const legacy5 = note(id, [{ sheet: H5, row: 3 }], { colour: YELLOW, order: 100003 });
    const since5: Since = { [rowKey(id, H5, 0)]: ['notknown', 50] };
    expect(colourSinceFor([one(id, H5, 3, YELLOW2)], list([legacy5], since5), {}, T)).toEqual({ [rowKey(id, H5, 0)]: ['notknown', 50] });
    expect(colourSinceFor([one(id, H5, 3, RED)], list([legacy5], since5), {}, T)).toEqual({ [rowKey(id, H5, 0)]: ['studying', T] });
    // HSK四级 under the old rule: Mastered still fits any colour, so nothing changes.
    const legacy4 = note(id, [{ sheet: H4, row: 3 }], { colour: PINK, order: 3 });
    const since4: Since = { [rowKey(id, H4, 0)]: ['mastered', 50] };
    expect(colourSinceFor([one(id, H4, 3, GREEN)], list([legacy4], since4), {}, T)).toEqual({ [rowKey(id, H4, 0)]: ['mastered', 50] });
    expect(colourSinceFor([one(id, H4, 3, GREEN)], since4, {}, T)).toEqual({ [rowKey(id, H4, 0)]: ['mastered', 50] });
    // An HSK四级 entry that no longer fits the colour (yellow recorded, now red) falls back to Mastered at t.
    expect(colourSinceFor([one(id, H4, 3, RED)], { [rowKey(id, H4, 0)]: ['notknown', 50] }, {}, T)).toEqual({ [rowKey(id, H4, 0)]: ['mastered', T] });
  });

  it('a list written by the current version (HSK四级 all Mastered) re-imports without any status change', () => {
    const rows = [one('v:一|yi', H4, 2, GREEN2), one('v:二|er', H4, 3, PINK), one('v:三|san', H4, 4, YELLOW2), one('v:四|si', H4, 5)];
    const since = colourSinceFor(rows, null, {}, T);
    expect(Object.values(since).every(([st, t]) => st === 'mastered' && t === 0)).toBe(true);
    const marks = [mark('v:二|er', 'st:notknown', 100), mark('v:四|si', 'st:new', 100)];
    const again = colourSinceFor(rows, list(rows, since), {}, T + 1);
    expect(again).toEqual(since);
    expect(noteStatuses(sheetRows(rows, marks, again))).toEqual(noteStatuses(sheetRows(rows, marks, since)));
    expect(copyFills(sheetRows(rows, marks, again))).toEqual(copyFills(sheetRows(rows, marks, since)));
  });
});

describe('sheetRows: HSK四级 acceptance', () => {
  const id = 'v:学习|xuexi';
  const k = rowKey(id, H4, 0);
  it('takes a recorded status that is Mastered or the class of the row colour, else Mastered at 0', () => {
    const table: [string | undefined, [WordStatus, number] | undefined, WordStatus, number][] = [
      [YELLOW2, ['notknown', 5], 'notknown', 5],
      [YELLOW2, ['mastered', 5], 'mastered', 5],
      [undefined, ['new', 5], 'new', 5],
      [PINK, ['studying', 5], 'studying', 5],
      [GREEN, ['notknown', 5], 'mastered', 0],
      [undefined, ['studying', 5], 'mastered', 0],
      [YELLOW2, undefined, 'mastered', 0],
    ];
    for (const [colour, e, excel, since] of table) {
      const r = sheetRows([one(id, H4, 3, colour)], [], e ? { [k]: e } : undefined).get(H4)![0];
      expect([colour, e, r.excel, r.since, r.status]).toEqual([colour, e, excel, since, excel]);
    }
  });
});

describe('merge scenarios: Excel edits, app marks and the app\'s own writes', () => {
  const R = 'v:学习|xuexi';
  /** Import a new version of the rows over the previous list (t = the version's time). */
  const step = (prev: { notes: Note[]; colourSince: Since }, notes: Note[], t: number, explained?: Parameters<typeof colourSinceFor>[4]) =>
    list(notes, colourSinceFor(notes, prev, {}, t, explained));

  it('HSK四级: the app sets Not studied, then Hugo colours the row green in Excel → Excel wins, nothing is written back', () => {
    for (const start of [PINK, undefined]) {
      const v0 = list([one(R, H4, 3, start)], colourSinceFor([one(R, H4, 3, start)], null, {}, 1000));
      const marks = [mark(R, 'st:new', 10)];
      expect(statusOf(v0.notes, marks, v0.colourSince, R)).toBe('new');
      const v1 = step(v0, [one(R, H4, 3, GREEN2)], 20);
      expect(v1.colourSince[rowKey(R, H4, 0)]).toEqual(['mastered', 20]);
      expect(statusOf(v1.notes, marks, v1.colourSince, R)).toBe('mastered');
      expect(copyFills(sheetRows(v1.notes, marks, v1.colourSince))).toEqual([]);
    }
  });

  it('HSK四级: the app writes yellow with its intent → [notknown, mark time]; the mark ties and nothing is left to write', () => {
    const v0 = list([one(R, H4, 3)], colourSinceFor([one(R, H4, 3)], null, {}, 1000));
    const marks = [mark(R, 'st:notknown', 10)];
    const fills = copyFills(sheetRows(v0.notes, marks, v0.colourSince));
    expect(fills).toEqual([{ sheet: H4, row: 3, hanzi: '学习', from: null, fill: 'FFFF00', key: rowKey(R, H4, 0), status: 'notknown', t: 10 }]);
    const explained = fillsExplained(fills);
    expect(explained).toEqual({ [rowKey(R, H4, 0)]: ['new', 'notknown', 10] });
    const v1 = step(v0, [one(R, H4, 3, fills[0].fill!)], 50, explained);
    expect(v1.colourSince[rowKey(R, H4, 0)]).toEqual(['notknown', 10]);
    const row = sheetRows(v1.notes, marks, v1.colourSince).get(H4)![0];
    expect(row).toMatchObject({ excel: 'notknown', since: 10, status: 'notknown' });
    expect(row.mark).toBeUndefined();
    expect(copyFills(sheetRows(v1.notes, marks, v1.colourSince))).toEqual([]);
  });

  it('ignores an intent whose class before or after does not match the change', () => {
    const k = rowKey(R, H5, 0);
    const v0 = list([one(R, H5, 3)], { [k]: ['new', 5] });
    // Class before differs (the intent saw a yellow row).
    expect(step(v0, [one(R, H5, 3, GREEN)], 50, { [k]: ['notknown', 'mastered', 10] }).colourSince[k]).toEqual(['mastered', 50]);
    // Class after differs (the app wrote green, Excel shows red).
    expect(step(v0, [one(R, H5, 3, RED)], 50, { [k]: ['new', 'mastered', 10] }).colourSince[k]).toEqual(['studying', 50]);
    // Another row's intent, or a malformed one, does nothing.
    expect(step(v0, [one(R, H5, 3, GREEN)], 50, { other: ['new', 'mastered', 10] }).colourSince[k]).toEqual(['mastered', 50]);
    expect(step(v0, [one(R, H5, 3, GREEN)], 50, { [k]: ['new', 'mastered', NaN] }).colourSince[k]).toEqual(['mastered', 50]);
    // Matching: the mark's time.
    expect(step(v0, [one(R, H5, 3, GREEN)], 50, { [k]: ['new', 'mastered', 10] }).colourSince[k]).toEqual(['mastered', 10]);
  });

  it('echo: the PC writes an older mark; the phone\'s newer mark still wins and is written next', () => {
    const [t1, t2, t3] = [100, 200, 300];
    const v0 = list([one(R, H5, 3)], { [rowKey(R, H5, 0)]: ['new', 5] });
    // The PC only knows M1 when it builds its upload.
    const m1 = mark(R, 'st:mastered', t1);
    const pcFills = copyFills(sheetRows(v0.notes, [m1], v0.colourSince));
    expect(pcFills.map((f) => f.fill)).toEqual([GREEN]);
    const explained = fillsExplained(pcFills);
    expect(explained).toEqual({ [rowKey(R, H5, 0)]: ['new', 'mastered', t1] });
    // The phone's M2 arrives; the PC's upload (t3) comes back as a new version.
    const m2 = mark(R, 'st:notknown', t2);
    const v1 = step(v0, [one(R, H5, 3, GREEN)], t3, explained);
    expect(v1.colourSince[rowKey(R, H5, 0)]).toEqual(['mastered', t1]);
    expect(statusOf(v1.notes, [m1, m2], v1.colourSince, R)).toBe('notknown');
    expect(copyFills(sheetRows(v1.notes, [m1, m2], v1.colourSince))).toMatchObject([{ from: GREEN, fill: YELLOW, status: 'notknown', t: t2 }]);
    // Without the intent the upload would have counted as an Excel edit at t3 and beaten M2.
    const naive = step(v0, [one(R, H5, 3, GREEN)], t3);
    expect(statusOf(naive.notes, [m1, m2], naive.colourSince, R)).toBe('mastered');
  });

  it('stale intent: green → yellow → green in Excel; the old intent does not claim the last edit', () => {
    const k = rowKey(R, H5, 0);
    const [t1, t2, t4, t5] = [100, 200, 400, 500];
    const v0 = list([one(R, H5, 3)], { [k]: ['new', 5] });
    const m1 = mark(R, 'st:mastered', t1);
    const explained = fillsExplained(copyFills(sheetRows(v0.notes, [m1], v0.colourSince)));
    const v1 = step(v0, [one(R, H5, 3, GREEN)], 300, explained);
    expect(v1.colourSince[k]).toEqual(['mastered', t1]);
    const v2 = step(v1, [one(R, H5, 3, YELLOW)], t4, explained);
    expect(v2.colourSince[k]).toEqual(['notknown', t4]);
    const v3 = step(v2, [one(R, H5, 3, GREEN)], t5, explained);
    expect(v3.colourSince[k]).toEqual(['mastered', t5]);
    // A mark from before the last Excel edit loses to it.
    expect(statusOf(v3.notes, [m1, mark(R, 'st:notknown', t2)], v3.colourSince, R)).toBe('mastered');
  });

  it('a mark inside the window loses to an Excel class change; a mark after the save wins', () => {
    const k = rowKey(R, H5, 0);
    const v0 = list([one(R, H5, 3)], { [k]: ['new', 10] });
    const saved = 40;
    const imported = 50;
    const v1 = list([one(R, H5, 3, YELLOW)], colourSinceFor([one(R, H5, 3, YELLOW)], v0, {}, Math.min(saved, imported)));
    expect(statusOf(v1.notes, [mark(R, 'st:mastered', 30)], v1.colourSince, R)).toBe('notknown');
    expect(statusOf(v1.notes, [mark(R, 'st:mastered', 45)], v1.colourSince, R)).toBe('mastered');
    expect(copyFills(sheetRows(v1.notes, [mark(R, 'st:mastered', 30)], v1.colourSince))).toEqual([]);
  });

  it('is deterministic: re-importing the same version over itself changes nothing', () => {
    const notes = [one(R, H4, 3, YELLOW2), one('v:朋友|pengyou', H5, 4, GREEN), one('v:本|ben', H5, 5)];
    const v0 = list(notes, colourSinceFor(notes, null, {}, 1));
    const v1 = step(v0, notes.map((n, i) => recolour(n, [GREEN, YELLOW, RED][i])), 100);
    expect(step(v1, v1.notes, 200).colourSince).toEqual(v1.colourSince);
    expect(step(v1, v1.notes, 200, { [rowKey(R, H4, 0)]: ['notknown', 'mastered', 1] }).colourSince).toEqual(v1.colourSince);
  });
});

describe('fillsExplained', () => {
  it('maps fills to [class before, status written, mark time], skipping fills without a key', () => {
    expect(
      fillsExplained([
        { sheet: H5, row: 2, hanzi: '一', from: PINK, fill: GREEN, key: 'a', status: 'mastered', t: 7 },
        { sheet: H5, row: 3, hanzi: '二', from: null, fill: BLUE, key: 'b', status: 'studying', t: 8 },
        { sheet: H5, row: 4, hanzi: '三', from: GREEN2, fill: null, key: 'c', status: 'new', t: 9 },
        { sheet: H5, row: 5, hanzi: '四', from: null, fill: GREEN },
      ]),
    ).toEqual({ a: ['studying', 'mastered', 7], b: ['new', 'studying', 8], c: ['mastered', 'new', 9] });
  });

  it('every status fill reads back as its own class', () => {
    for (const s of WORD_STATUSES) expect(generalColourStatus(STATUS_FILL[s])).toBe(s);
  });
});

describe('statusChanges', () => {
  it('lists notes in both lists whose status changed, in Excel order', () => {
    const a = one('v:一|yi', H5, 9);
    const b = one('v:二|er', H4, 2);
    const c = one('v:三|san', H5, 3);
    const before = new Map<string, WordStatus>([[a.id, 'new'], [b.id, 'mastered'], [c.id, 'notknown'], ['v:gone|x', 'new']]);
    const after = new Map<string, WordStatus>([[a.id, 'mastered'], [b.id, 'notknown'], [c.id, 'notknown'], ['v:added|x', 'new']]);
    expect(statusChanges(before, after, [a, c, b])).toEqual([
      { note: b.id, hanzi: '二', from: 'mastered', to: 'notknown' },
      { note: a.id, hanzi: '一', from: 'new', to: 'mastered' },
    ]);
    expect(statusChanges(before, before, [a, b, c])).toEqual([]);
  });
});
