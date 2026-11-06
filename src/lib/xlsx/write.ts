// A minimal .xlsx writer: inline strings, numbers, dates, a bold header row, frozen panes,
// filters and column widths. Enough for the progress workbook; no dependency beyond fflate.
import { strToU8, zipSync } from 'fflate';

export type ColumnFormat = 'text' | 'int' | 'dec1' | 'pct' | 'date' | 'datetime';

export interface Column {
  header: string;
  width?: number;
  format?: ColumnFormat;
}

/** A cell: text, number, a date given as a Date, empty, or a value with its own format. */
export type Cell = string | number | Date | null | undefined | { v: number | Date; f: ColumnFormat };

export interface Sheet {
  name: string;
  columns: Column[];
  rows: Cell[][];
  /** Freeze the header row and add filters. Default true. */
  table?: boolean;
}

const STYLE: Record<ColumnFormat | 'header', number> = { text: 0, header: 1, date: 2, datetime: 3, pct: 4, dec1: 5, int: 6 };

const STYLES_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3"><numFmt numFmtId="164" formatCode="yyyy\\-mm\\-dd"/><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd hh:mm"/><numFmt numFmtId="166" formatCode="0.0"/></numFmts>
<fonts count="2"><font><sz val="11"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><name val="Calibri"/><family val="2"/></font></fonts>
<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FFEFE9DD"/><bgColor indexed="64"/></patternFill></fill></fills>
<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="7">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
</cellXfs>
<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
</styleSheet>`;

export function colName(i: number): string {
  let s = '';
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function esc(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Local date and time as an Excel serial number (days since 1899-12-30). */
export function excelDate(d: Date): number {
  return (d.getTime() - d.getTimezoneOffset() * 60000) / 86400000 + 25569;
}

function cellXml(ref: string, cell: Cell, colFormat: ColumnFormat): string {
  let v = cell;
  let format = colFormat;
  if (v != null && typeof v === 'object' && !(v instanceof Date)) {
    format = v.f;
    v = v.v;
  }
  if (v == null || v === '') return '';
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return '';
    return `<c r="${ref}" s="${STYLE[format === 'datetime' ? 'datetime' : 'date']}"><v>${excelDate(v)}</v></c>`;
  }
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return '';
    // A date format on a plain number would show a date: numbers in date columns stay plain.
    const s = format === 'date' || format === 'datetime' ? 0 : STYLE[format];
    return `<c r="${ref}"${s ? ` s="${s}"` : ''}><v>${v}</v></c>`;
  }
  return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
}

function sheetXml(sheet: Sheet, first: boolean): string {
  const table = sheet.table !== false;
  const nCols = Math.max(1, sheet.columns.length);
  const last = `${colName(nCols - 1)}${sheet.rows.length + 1}`;
  const header = `<row r="1">${sheet.columns.map((c, i) => `<c r="${colName(i)}1" t="inlineStr" s="${STYLE.header}"><is><t xml:space="preserve">${esc(c.header)}</t></is></c>`).join('')}</row>`;
  const body = sheet.rows
    .map((row, r) => `<row r="${r + 2}">${row.map((v, i) => cellXml(`${colName(i)}${r + 2}`, v, sheet.columns[i]?.format ?? 'text')).join('')}</row>`)
    .join('');
  const cols = sheet.columns.map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 12}" customWidth="1"/>`).join('');
  const pane = table ? '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft" activeCell="A2" sqref="A2"/>' : '';
  return (
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
    `<dimension ref="A1:${last}"/>` +
    `<sheetViews><sheetView workbookViewId="0"${first ? ' tabSelected="1"' : ''}>${pane}</sheetView></sheetViews>` +
    '<sheetFormatPr defaultRowHeight="15"/>' +
    (cols ? `<cols>${cols}</cols>` : '') +
    `<sheetData>${header}${body}</sheetData>` +
    (table && sheet.rows.length ? `<autoFilter ref="A1:${last}"/>` : '') +
    '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>' +
    '</worksheet>'
  );
}

export function sheetName(s: string): string {
  return s.replace(/[[\]:*?/\\]/g, ' ').slice(0, 31) || 'Sheet';
}

export function buildXlsx(sheets: Sheet[]): Uint8Array {
  const names = sheets.map((s) => sheetName(s.name));
  const files: Record<string, Uint8Array> = {};
  const put = (path: string, xml: string) => (files[path] = strToU8(xml));
  put(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>' +
      '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
      sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('') +
      '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>' +
      '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>' +
      '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>' +
      '</Types>',
  );
  put(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
      '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>' +
      '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>' +
      '</Relationships>',
  );
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  put(
    'docProps/core.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">' +
      `<dc:creator>Hugo 中文</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>` +
      '</cp:coreProperties>',
  );
  put(
    'docProps/app.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Hugo 中文</Application></Properties>',
  );
  const filters = sheets
    .map((s, i) => (s.table !== false && s.rows.length ? `<definedName name="_xlnm._FilterDatabase" localSheetId="${i}" hidden="1">'${names[i].replace(/'/g, "''")}'!$A$1:$${colName(Math.max(1, s.columns.length) - 1)}$${s.rows.length + 1}</definedName>` : ''))
    .join('');
  put(
    'xl/workbook.xml',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
      '<bookViews><workbookView activeTab="0"/></bookViews><sheets>' +
      names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
      '</sheets>' +
      (filters ? `<definedNames>${filters}</definedNames>` : '') +
      '</workbook>',
  );
  put(
    'xl/_rels/workbook.xml.rels',
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
      sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
      `<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
      '</Relationships>',
  );
  put('xl/styles.xml', STYLES_XML);
  sheets.forEach((s, i) => put(`xl/worksheets/sheet${i + 1}.xml`, sheetXml(s, i === 0)));
  return zipSync(files, { level: 6 });
}
