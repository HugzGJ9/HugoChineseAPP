import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Note, ReviewEvent, StatusMark } from './types';
import { deriveCards } from './engine/schedule';
import { progressSheets, progressWorkbook } from './progress';
import { markCounts } from './stats';
import { buildXlsx, colName, excelDate } from './xlsx/write';

function note(i: number, over: Partial<Note> = {}): Note {
  return {
    id: `v:词${i}|ci${i}`,
    kind: 'vocab',
    hanzi: `词${i}`,
    alts: [],
    pinyin: 'cí',
    pinyinNum: 'ci2',
    en: `word <${i}> & "more"`,
    notes: [],
    tags: [],
    refs: [{ sheet: 'HSK四级', row: i + 2 }],
    order: i,
    studied: i % 4 === 0,
    examples: [],
    ...over,
  };
}

describe('xlsx writer', () => {
  it('names columns like Excel', () => {
    expect([0, 25, 26, 27, 51, 52, 701, 702].map(colName)).toEqual(['A', 'Z', 'AA', 'AB', 'AZ', 'BA', 'ZZ', 'AAA']);
  });

  it('dates are Excel serial numbers in local time', () => {
    expect(excelDate(new Date(2026, 10, 6, 12))).toBe(46332.5);
    expect(excelDate(new Date(2026, 6, 1))).toBe(46204);
  });

  it('writes a valid package', () => {
    const bytes = buildXlsx([{ name: 'A/B:C', columns: [{ header: 'x' }], rows: [['a\u0001b'], [1], [new Date(2026, 0, 1)], [null]] }]);
    const files = unzipSync(bytes);
    expect(Object.keys(files)[0]).toBe('[Content_Types].xml');
    expect(strFromU8(files['xl/workbook.xml'])).toContain('name="A B C"');
    const sheet = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(sheet).toContain('<t xml:space="preserve">ab</t>');
    expect(sheet).toContain('<autoFilter ref="A1:A5"/>');
  });
});

describe('progress workbook', () => {
  it('has words, daily figures and a summary', () => {
    const T0 = new Date(2026, 10, 1, 12).getTime();
    const notes = [...Array.from({ length: 30 }, (_, i) => note(i)), note(99, { id: 'g:A+不如+B', kind: 'grammar', hanzi: 'A+不如+B', en: 'A is not as good as B', refs: [{ sheet: 'Grammar', row: 4 }] })];
    const events: ReviewEvent[] = [];
    let n = 0;
    for (let d = 0; d < 5; d++)
      for (let i = 1; i < 8; i++) events.push({ id: `e${n++}`, card: `v:词${i}|ci${i}#recog`, r: ((i + d) % 4) + 1 as 1 | 2 | 3 | 4, t: T0 + d * 86400000 + i * 60000, d: 4000, m: 'reveal', dev: d % 2 ? 'iphone-1a2b' : 'windows-3c4d' });
    const seeds = Object.fromEntries(notes.filter((x) => x.studied).map((x) => [x.id, T0]));
    const cards = deriveCards(notes, events, seeds, { retention: 0.9, spreadDays: 60, recall: true, listen: false });
    const bytes = progressWorkbook({ notes, cards, events, device: 'windows-3c4d', now: T0 + 5 * 86400000 });
    const files = unzipSync(bytes);
    const wb = strFromU8(files['xl/workbook.xml']);
    expect(wb).toContain('name="Words"');
    expect(wb).toContain('name="Daily"');
    expect(wb).toContain('name="Summary"');
    const words = strFromU8(files['xl/worksheets/sheet1.xml']);
    expect(words).toContain('word &lt;3&gt; &amp; &quot;more&quot;');
    expect(words.match(/<row /g)).toHaveLength(32);
    const daily = strFromU8(files['xl/worksheets/sheet2.xml']);
    expect(daily).toContain('iphone-1a2b');
    expect(daily.match(/<row /g)).toHaveLength(7);
  });

  it('shows statuses set by Hugo: Suspended, a last "Set by you" column, summary rows', () => {
    const T0 = new Date(2026, 10, 1, 12).getTime();
    const notes = Array.from({ length: 6 }, (_, i) => note(i + 1, { studied: false }));
    const mk = (id: string, i: number, a: StatusMark['a'], t: number): StatusMark => ({ id, note: notes[i].id, a, t, dev: 'pc' });
    const marks = [
      mk('a', 0, 'known', T0),
      mk('b', 1, 'suspend', T0 + 3600000),
      mk('c', 2, 'relearn', T0),
      mk('d', 3, 'known', T0),
      mk('e', 3, 'suspend', T0 + 86400000),
      mk('f', 4, 'suspend', T0),
      mk('g', 4, 'unsuspend', T0 + 60000),
      { ...mk('h', 0, 'known', T0), note: 'v:gone|gone' },
    ];
    const cards = deriveCards(notes, [], {}, { retention: 0.9, spreadDays: 60, recall: true, listen: false }, marks);
    const [words, , summary] = progressSheets({ notes, cards, events: [], device: 'pc', now: T0 + 2 * 86400000, marks });
    const last = words.columns.length - 1;
    expect(words.columns[last].header).toBe('Set by you');
    expect(words.columns[last - 1].header).toBe('Green in Excel');
    const status = words.columns.findIndex((c) => c.header === 'Status');
    expect(words.rows.map((r) => r[status])).toEqual(['Mastered', 'Suspended', 'Learning', 'Suspended', 'New', 'New']);
    expect(words.rows.map((r) => r[last])).toEqual(['Known 2026-11-01', 'Suspended 2026-11-01', 'Relearn 2026-11-01', 'Suspended 2026-11-02', '', '']);
    const row = (label: string) => summary.rows.find((r) => r[0] === label)?.[1];
    expect(row('Suspended')).toBe(2);
    expect(row('Marked known by you')).toBe(2);
    expect(markCounts(marks, new Set(notes.map((n) => n.id)))).toEqual({ known: 2, relearn: 1, suspended: 2 });
    // Without marks the workbook has the column, empty.
    const plain = progressSheets({ notes, cards: deriveCards(notes, [], {}, { retention: 0.9, spreadDays: 60, recall: true, listen: false }), events: [], device: 'pc', now: T0 });
    expect(plain[0].rows.every((r) => r[r.length - 1] === '')).toBe(true);
  });
});
