import { describe, expect, it } from 'vitest';
import type { MarkKind, Note, SourceRef, StatusMark, VocabFile } from './types';
import {
  STATUS_FILL,
  STATUS_LABEL,
  STATUS_MARK,
  WORD_STATUSES,
  colourSinceFor,
  colourStatus,
  copyFills,
  generalColourStatus,
  latestStatusMarks,
  markStatus,
  noteStatuses,
  rowKey,
  sheetRows,
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
      { sheet: H4, row: 6, hanzi: '五', from: 'EEA6A6', fill: 'FFFF00' },
      { sheet: H5, row: 2, hanzi: '一', from: null, fill: 'A9D18E' },
      { sheet: H5, row: 4, hanzi: '三', from: 'A9D18E', fill: null },
    ]);
    // Nothing changed: nothing to write.
    expect(copyFills(sheetRows([h4m, h4, same, green, pink, blank], [], undefined))).toEqual([]);
  });

  it('writes Studying blue on a blank row, and Not studied on an HSK四级 row as no fill', () => {
    const fills = copyFills(sheetRows([h4, blank], [mark(h4.id, 'st:new', 1), mark(blank.id, 'st:studying', 1)], undefined));
    expect(fills).toEqual([
      { sheet: H4, row: 6, hanzi: '五', from: 'EEA6A6', fill: null },
      { sheet: H5, row: 2, hanzi: '一', from: null, fill: '8FAADC' },
    ]);
  });
});
