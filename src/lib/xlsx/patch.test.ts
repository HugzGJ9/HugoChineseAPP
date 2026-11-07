import { describe, expect, it } from 'vitest';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { pinyin } from 'pinyin-pro';
import type { RowFill, SheetCols } from '../types';
import { buildVocab } from '../import/build';
import { colourStatus } from '../status';
import { readWorkbook } from './read';
import { copyFileName, patchWorkbookFills, WorkbookChangedError } from './patch';

// ---- synthetic workbook ----

const WORDS = ['ID', 'HANZI', 'PINYIN', 'ENGLISH', '学习', '工作', '朋友', '电脑', '老师', '书', '桌子', 'a note', '同学'];
const S = (w: string) => WORDS.indexOf(w);

const STYLES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
  '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="14"/><name val="Calibri"/></font></fonts>' +
  '<fills count="7">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFA9D18E"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFF0000"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor theme="5" tint="0.39997558519241921"/><bgColor indexed="64"/></patternFill></fill>' +
  '<fill><patternFill patternType="solid"><fgColor rgb="FF000000"/><bgColor indexed="64"/></patternFill></fill>' +
  '</fills>' +
  '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="8">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' + // 0 default
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 1 header
  '<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>' + // 2 green
  '<xf numFmtId="0" fontId="0" fillId="3" borderId="0" xfId="0" applyFill="1"/>' + // 3 red
  '<xf numFmtId="0" fontId="0" fillId="4" borderId="0" xfId="0" applyFill="1"/>' + // 4 yellow
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyAlignment="1"><alignment wrapText="1"/></xf>' + // 5 plain
  '<xf numFmtId="0" fontId="0" fillId="5" borderId="0" xfId="0" applyFill="1"/>' + // 6 theme orange
  '<xf numFmtId="0" fontId="1" fillId="6" borderId="0" xfId="0" applyFill="1"/>' + // 7 black
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' + // 8 row style
  '</cellXfs>' +
  '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>' +
  '</styleSheet>';

const sst = (i: number, s: number, col: string, r: number) => `<c r="${col}${r}" s="${s}" t="s"><v>${i}</v></c>`;
const num = (v: number, s: number, col: string, r: number) => `<c r="${col}${r}" s="${s}"><v>${v}</v></c>`;
const empty = (s: number, col: string, r: number) => `<c r="${col}${r}" s="${s}"/>`;
const header = (r = 1) => `<row r="${r}" spans="1:5">${['ID', 'HANZI', 'PINYIN', 'ENGLISH'].map((w, i) => sst(S(w), 1, 'ABCD'[i], r)).join('')}</row>`;
/** A vocab row: ID, hanzi, pinyin, meaning with one style each. */
function vrow(r: number, id: number, hz: string, st: [number, number, number, number], extra = ''): string {
  return `<row r="${r}" spans="1:5">${num(id, st[0], 'A', r)}${sst(S(hz), st[1], 'B', r)}<c r="C${r}" s="${st[2]}" t="inlineStr"><is><t>py</t></is></c><c r="D${r}" s="${st[3]}" t="inlineStr"><is><t>mean</t></is></c>${extra}</row>`;
}
const sheetXml = (rows: string, cols = '') =>
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
  `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:F9"/>${cols}<sheetData>${rows}</sheetData><pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`;

// HSK五级: whole rows coloured (A–D).
const SHEET5 = sheetXml(
  header() +
    vrow(2, 1, '学习', [2, 2, 2, 2], sst(S('a note'), 3, 'E', 2)) + // green, red note in E (off table)
    vrow(3, 2, '工作', [4, 4, 4, 4]) + // yellow
    vrow(4, 3, '朋友', [5, 5, 5, 5]) + // blank
    vrow(5, 4, '电脑', [5, 5, 7, 7]) + // blank, black C–D
    vrow(6, 5, '老师', [6, 6, 6, 6]) + // theme orange
    vrow(7, 6, '同学', [2, 2, 2, 2]) + // green
    `<row r="8" spans="1:5">${empty(5, 'A', 8)}${empty(5, 'B', 8)}</row>`,
);
// HSK四级: ID + hanzi coloured (A–B), a row style and a missing ID cell.
const SHEET4 = sheetXml(
  header() +
    vrow(2, 1, '书', [2, 2, 5, 5]) +
    `<row r="3" spans="1:5" s="8" customFormat="1"><c r="B3" s="5" t="inlineStr"><is><t>桌子</t></is></c><c r="D3" s="5" t="inlineStr"><is><t>desk</t></is></c></row>` +
    vrow(4, 3, '工作', [3, 3, 5, 5]),
  '<cols><col min="1" max="4" width="12" customWidth="1"/></cols>',
);

const ENTRIES: [string, string][] = [
  ['[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'],
  ['_rels/.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'],
  ['xl/workbook.xml', '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="HSK四级" sheetId="1" r:id="rId2"/><sheet name="HSK五级" sheetId="2" r:id="rId1"/></sheets></workbook>'],
  ['xl/_rels/workbook.xml.rels', '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="/xl/worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'],
  ['xl/worksheets/sheet1.xml', SHEET5],
  ['xl/worksheets/sheet2.xml', SHEET4],
  ['xl/styles.xml', STYLES],
  ['xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${WORDS.length}" uniqueCount="${WORDS.length}">${WORDS.map((w) => `<si><t>${w}</t></si>`).join('')}</sst>`],
  ['docProps/app.xml', '<?xml version="1.0" encoding="UTF-8"?><Properties/>'],
];

function workbook(entries = ENTRIES): Uint8Array {
  return zipSync(Object.fromEntries(entries.map(([n, x]) => [n, strToU8(x)])), { level: 6 });
}

const COLS: Record<string, SheetCols> = {
  'HSK五级': { id: 'A', hanzi: 'B', first: 'A', last: 'D', status: ['A', 'B', 'C', 'D'] },
  'HSK四级': { id: 'A', hanzi: 'B', first: 'A', last: 'D', status: ['A', 'B'] },
};
const GREEN = 'A9D18E';
const YELLOW = 'FFFF00';
const BLUE = '8FAADC';
const rf = (sheet: string, row: number, hanzi: string, from: string | null, fill: string | null): RowFill => ({ sheet, row, hanzi, from, fill });

const ROWS: RowFill[] = [
  rf('HSK五级', 2, '学习', GREEN, YELLOW), // existing yellow fill reused
  rf('HSK五级', 4, '朋友', null, GREEN), // blank row → status columns
  rf('HSK五级', 5, '电脑', null, BLUE), // blank row, black C–D stay; new fill
  rf('HSK五级', 7, '同学', GREEN, YELLOW), // same clone as row 2
  rf('HSK四级', 2, '书', GREEN, null), // Not studied → no fill
  rf('HSK四级', 3, '桌子', null, BLUE), // row style, missing A3
];

const files = (u8: Uint8Array) => unzipSync(u8);
const text = (u8: Uint8Array, p: string) => strFromU8(files(u8)[p]);
/** Style index of every cell of a sheet (empty cells too). */
function fillsOf(u8: Uint8Array, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of text(u8, path).matchAll(/<c r="([A-Z]+\d+)" s="(\d+)"/g)) out[m[1]] = m[2];
  return out;
}
function xfList(styles: string): string[] {
  const sec = /<cellXfs[^>]*>([\s\S]*?)<\/cellXfs>/.exec(styles)![1];
  return [...sec.matchAll(/<xf\b[^>]*\/>|<xf\b[^>]*>[\s\S]*?<\/xf>/g)].map((m) => m[0]);
}
function fillList(styles: string): string[] {
  const sec = /<fills[^>]*>([\s\S]*?)<\/fills>/.exec(styles)![1];
  return [...sec.matchAll(/<fill>[\s\S]*?<\/fill>|<fill\/>/g)].map((m) => m[0]);
}
/** Row elements by number. */
function rowsOf(xml: string): Map<number, string> {
  return new Map([...xml.matchAll(/<row r="(\d+)"[^>]*?(?:\/>|>[\s\S]*?<\/row>)/g)].map((m) => [Number(m[1]), m[0]]));
}

describe('copyFileName', () => {
  it('adds (app) before the extension', () => {
    expect(copyFileName('Hugo_chinese_vocab.xlsx')).toBe('Hugo_chinese_vocab (app).xlsx');
    expect(copyFileName('my.list.xlsx')).toBe('my.list (app).xlsx');
    expect(copyFileName('noext')).toBe('noext (app).xlsx');
  });
});

describe('patchWorkbookFills', () => {
  const src = workbook();
  const res = patchWorkbookFills({ bytes: src.slice(), rows: ROWS, cols: COLS });
  const out = res.bytes;
  const styles = text(out, 'xl/styles.xml');
  const xfs = xfList(styles);
  const s5 = fillsOf(out, 'xl/worksheets/sheet1.xml');
  const s4 = fillsOf(out, 'xl/worksheets/sheet2.xml');
  const fillOfXf = (s: string) => /fillId="(\d+)"/.exec(xfs[Number(s)])![1];

  it('reports what it did', () => {
    expect(res.rows).toBe(6);
    // 4 + 4 + 2 + 4 + 2 + 2 (A3 inserted, B3)
    expect(res.cells).toBe(18);
    expect(res.fillsAdded).toBe(1); // 8FAADC only
    // (2,yellow) (5,green) (5,blue) (2,none) (8,blue) (5,blue) shared with row 5 of HSK五级
    expect(res.xfsAdded).toBe(5);
    expect(res.skipped).toBe(0);
  });

  it('changes only the cells with the row colour, inside the table', () => {
    for (const c of ['A2', 'B2', 'C2', 'D2', 'A7', 'B7', 'C7', 'D7']) expect(fillOfXf(s5[c])).toBe('4'); // existing yellow
    expect(s5.A2).toBe(s5.A7); // memoised clone
    expect(s5.E2).toBe('3'); // red note off the table
    expect(s5.A3).toBe('4'); // untouched row
    expect(s5.A6).toBe('6');
  });

  it('fills the status columns of a blank row and leaves cells with their own colour', () => {
    for (const c of ['A4', 'B4', 'C4', 'D4']) expect(fillOfXf(s5[c])).toBe('2');
    expect(fillOfXf(s5.A5)).toBe('7');
    expect(s5.C5).toBe('7');
    expect(s5.D5).toBe('7');
    expect(fillList(styles)[7]).toBe('<fill><patternFill patternType="solid"><fgColor rgb="FF8FAADC"/><bgColor indexed="64"/></patternFill></fill>');
  });

  it('inserts a missing status cell in column order, styled from the row', () => {
    const row3 = rowsOf(text(out, 'xl/worksheets/sheet2.xml')).get(3)!;
    expect(row3).toMatch(/^<row r="3" spans="1:5" s="8" customFormat="1"><c r="A3" s="(\d+)"\/><c r="B3" s="(\d+)" t="inlineStr">/);
    const a3 = xfs[Number(s4.A3)];
    expect(a3).toContain('fontId="1"'); // from row style 8
    expect(a3).toContain('fillId="7"');
    expect(a3).toContain('applyFill="1"');
    expect(fillOfXf(s4.B3)).toBe('7');
    expect(s4.D3).toBe('5');
    // B3 was style 5 (with <alignment>): its clone keeps it
    expect(xfs[Number(s4.B3)]).toBe('<xf numFmtId="0" fontId="1" fillId="7" borderId="0" xfId="0" applyFont="1" applyAlignment="1" applyFill="1"><alignment wrapText="1"/></xf>');
  });

  it('fill: null → a clone with fillId 0 that keeps font and alignment', () => {
    expect(s4.A2).toBe(s4.B2);
    expect(xfs[Number(s4.A2)]).toBe('<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf>');
    expect(s4.C2).toBe('5');
    expect(s4.A4).toBe('3');
  });

  it('updates both counts and only appends to styles.xml', () => {
    expect(styles).toContain(`<fills count="${fillList(styles).length}">`);
    expect(styles).toContain(`<cellXfs count="${xfs.length}">`);
    expect(fillList(styles).length).toBe(8);
    expect(xfs.length).toBe(9 + 5);
    expect(xfList(STYLES)).toEqual(xfs.slice(0, 9));
    const strip = (x: string) => x.replace(/<fills[\s\S]*<\/fills>/, '').replace(/<cellXfs[\s\S]*<\/cellXfs>/, '');
    expect(strip(styles)).toBe(strip(STYLES));
  });

  it('keeps every other entry identical, in order, and the sheet text outside edited rows', () => {
    const a = files(src);
    const b = files(out);
    expect(Object.keys(b)).toEqual(Object.keys(a));
    for (const n of Object.keys(a)) {
      if (n === 'xl/styles.xml' || n.startsWith('xl/worksheets/')) continue;
      expect(strFromU8(b[n])).toBe(strFromU8(a[n]));
    }
    for (const [path, edited] of [['xl/worksheets/sheet1.xml', [2, 4, 5, 7]], ['xl/worksheets/sheet2.xml', [2, 3]]] as const) {
      const before = strFromU8(a[path]);
      const after = strFromU8(b[path]);
      const rb = rowsOf(before);
      const ra = rowsOf(after);
      for (const [n, x] of rb) if (!(edited as readonly number[]).includes(n)) expect(ra.get(n)).toBe(x);
      const outside = (x: string) => x.replace(/<sheetData>[\s\S]*<\/sheetData>/, '');
      expect(outside(after)).toBe(outside(before));
      // in edited rows, only s attributes changed (and the inserted cell)
      for (const n of edited) expect(ra.get(n)!.replace(/ s="\d+"/g, '').replace(/<c r="A3"\/>/, '')).toBe(rb.get(n)!.replace(/ s="\d+"/g, ''));
    }
  });

  it('never touches the input bytes', () => {
    const bytes = workbook();
    const copy = bytes.slice();
    patchWorkbookFills({ bytes, rows: ROWS, cols: COLS });
    expect(bytes).toEqual(copy);
  });

  it('reads back with the expected fills and statuses', () => {
    const sheets = readWorkbook(out);
    const cell = (sheet: string, r: number, c: string) => sheets.find((s) => s.name === sheet)!.rows.find((x) => x.r === r)!.cells[c];
    expect(cell('HSK五级', 2, 'B').fill).toBe(YELLOW);
    expect(cell('HSK五级', 2, 'E').fill).toBe('FF0000');
    expect(cell('HSK五级', 4, 'D').fill).toBe(GREEN);
    expect(cell('HSK五级', 5, 'B').fill).toBe(BLUE);
    expect(cell('HSK五级', 5, 'C').fill).toBe('000000');
    expect(cell('HSK四级', 2, 'B').fill).toBeNull();
    expect(cell('HSK四级', 3, 'B').fill).toBe(BLUE);

    const pinyinOf = (h: string) => pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[];
    const vf = buildVocab(sheets, { source: { name: 'x.xlsx', modified: 1, size: 1 }, now: 1, pinyinOf });
    const status = (sheet: string, row: number) => {
      for (const n of vf.notes) {
        const ref = n.refs.find((r) => r.sheet === sheet && r.row === row);
        if (ref) return colourStatus(sheet, ref.colour ?? (n.refs[0] === ref ? n.colour : undefined));
      }
      return undefined;
    };
    expect(status('HSK五级', 2)).toBe('notknown');
    expect(status('HSK五级', 3)).toBe('notknown'); // untouched yellow
    expect(status('HSK五级', 4)).toBe('mastered');
    expect(status('HSK五级', 5)).toBe('studying');
    expect(status('HSK五级', 7)).toBe('notknown');
    expect(status('HSK四级', 3)).toBe('mastered'); // HSK四级 reads as mastered whatever the colour
  });

  it('throws WorkbookChangedError when a row no longer holds the word', () => {
    let err: unknown;
    try {
      patchWorkbookFills({ bytes: workbook(), rows: [ROWS[0], rf('HSK五级', 3, '朋友', YELLOW, GREEN)], cols: COLS });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorkbookChangedError);
    expect((err as WorkbookChangedError).sheet).toBe('HSK五级');
    expect((err as WorkbookChangedError).row).toBe(3);
  });

  it('reuses a fill whose theme colour resolves to the target', () => {
    const entries = ENTRIES.map(([n, x]): [string, string] => [n, n === 'xl/styles.xml' ? x.replace('theme="5"', 'theme="4"') : x]);
    const r = patchWorkbookFills({ bytes: workbook(entries), rows: [rf('HSK五级', 4, '朋友', null, BLUE)], cols: COLS });
    expect(r).toMatchObject({ rows: 1, cells: 4, fillsAdded: 0, xfsAdded: 1 });
    expect(xfList(text(r.bytes, 'xl/styles.xml'))[9]).toContain('fillId="5"');
  });

  it('accepts a word written with extra punctuation in the cell', () => {
    const entries = ENTRIES.map(([n, x]): [string, string] => [n, n === 'xl/sharedStrings.xml' ? x.replace('<t>工作</t>', '<t> 工作（ ）</t>') : x]);
    expect(patchWorkbookFills({ bytes: workbook(entries), rows: [rf('HSK五级', 3, '工作', YELLOW, GREEN)], cols: COLS }).rows).toBe(1);
  });

  it('skips and counts rows missing from the XML and sheets without columns', () => {
    const r = patchWorkbookFills({
      bytes: workbook(),
      rows: [rf('HSK五级', 40, '学习', GREEN, YELLOW), rf('Nope', 2, '学习', GREEN, YELLOW), rf('HSK四级', 2, '书', GREEN, YELLOW)],
      cols: { 'HSK五级': COLS['HSK五级'] },
    });
    expect(r).toMatchObject({ rows: 0, cells: 0, skipped: 3, xfsAdded: 0 });
  });

  it('fails the word check on an empty self-closing row', () => {
    const entries = ENTRIES.map(([n, x]): [string, string] => [
      n,
      n === 'xl/worksheets/sheet2.xml' ? x.replace('</sheetData>', '<row r="9" s="8" customFormat="1"/></sheetData>') : x,
    ]);
    const cols = { 'HSK四级': { ...COLS['HSK四级'], hanzi: undefined, first: 'A', last: 'A', status: ['A'] } };
    expect(() => patchWorkbookFills({ bytes: workbook(entries), rows: [rf('HSK四级', 9, '书', null, GREEN)], cols })).toThrow(WorkbookChangedError);
  });

  it('patches a 12 MB sheet of styled empty cells quickly', () => {
    const N = 2400;
    const W = 220;
    const rows: string[] = [header()];
    const targets: RowFill[] = [];
    const filler = Array.from({ length: W - 4 }, (_, i) => i);
    for (let r = 2; r <= N; r++) {
      const green = r % 3 === 0;
      const st: [number, number, number, number] = green ? [2, 2, 2, 2] : [5, 5, 5, 5];
      // styled empty cells from E to HN
      const tail = filler.map((i) => `<c r="${colName(i + 5)}${r}" s="5"/>`).join('');
      rows.push(vrow(r, r, '学习', st, tail));
      if (targets.length < 1000 && r % 2 === 0) targets.push(rf('HSK五级', r, '学习', green ? GREEN : null, green ? YELLOW : BLUE));
    }
    const big = sheetXml(rows.join(''));
    expect(big.length).toBeGreaterThan(11_000_000);
    const entries = ENTRIES.map(([n, x]): [string, string] => [n, n === 'xl/worksheets/sheet1.xml' ? big : x]);
    const bytes = workbook(entries);
    const t0 = performance.now();
    const r = patchWorkbookFills({ bytes, rows: targets, cols: COLS });
    const ms = performance.now() - t0;
    expect(r.rows).toBe(1000);
    expect(r.skipped).toBe(0);
    expect(ms).toBeLessThan(3000);
  }, 20000);
});

function colName(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
