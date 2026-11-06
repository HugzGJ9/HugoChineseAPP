import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import type { Note, ReviewEvent } from './types';
import { deriveCards } from './engine/schedule';
import { progressWorkbook } from './progress';
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
});
