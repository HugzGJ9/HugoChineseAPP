// The workbook copy: Hugo's own .xlsx with his statuses written as cell fills.
// The XML is patched in place: styles.xml gets the fills and cell formats it needs, and in each sheet only the `s`
// attribute of the targeted cells changes (or a missing styled cell is inserted). Everything else keeps its content.
// Sheets can be large (11 MB of styled empty cells), so a sheet is walked once, forward, with indexOf.
import { strFromU8, strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import type { RowFill, SheetCols } from '../types';
import { colToIndex, decodeXml, indexToCol, parseFills, parseStyles, parseTheme, richText, sheetPaths } from './read';

/** A target row no longer holds the word it held at import: the file changed, the copy must not be written. */
export class WorkbookChangedError extends Error {
  sheet: string;
  row: number;
  constructor(sheet: string, row: number) {
    super(`Row ${row} of ${sheet} no longer holds the expected word.`);
    this.name = 'WorkbookChangedError';
    this.sheet = sheet;
    this.row = row;
  }
}

export interface PatchRequest {
  bytes: Uint8Array;
  rows: RowFill[];
  cols: Record<string, SheetCols>;
}

export interface PatchResult {
  bytes: Uint8Array;
  /** Rows changed. */
  rows: number;
  /** Cells restyled or inserted. */
  cells: number;
  xfsAdded: number;
  fillsAdded: number;
  /** Target rows not found (sheet unknown, no columns, or row missing from the XML). */
  skipped: number;
}

/** Worker reply (patch.worker.ts). */
export type PatchResponse =
  | { ok: true; result: PatchResult }
  | { ok: false; error: string; changed?: { sheet: string; row: number } };

/** 'Hugo_chinese_vocab.xlsx' → 'Hugo_chinese_vocab (app).xlsx'. */
export function copyFileName(fileName: string): string {
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(fileName)!;
  return `${m[1]} (app)${m[2] ?? '.xlsx'}`;
}

// ---- attributes (precompiled: these run once per cell) ----

const R_ATTR = /\sr="([^"]*)"/;
const S_ATTR = /\ss="([^"]*)"/;
const T_ATTR = /\st="([^"]*)"/;
const CF_ATTR = /\scustomFormat="(1|true)"/;

function setAttr(tag: string, name: string, value: string): string {
  const re = new RegExp(`(\\s${name}=")[^"]*"`);
  if (re.test(tag)) return tag.replace(re, `$1${value}"`);
  const end = tag.endsWith('/>') ? tag.length - 2 : tag.length - 1;
  return `${tag.slice(0, end)} ${name}="${value}"${tag.slice(end)}`;
}

function isTagEnd(ch: number): boolean {
  // space, tab, LF, CR, '>' or '/'
  return ch === 32 || ch === 9 || ch === 10 || ch === 13 || ch === 62 || ch === 47;
}

/** Index of the next `<name` element start at or after pos (not `<nameOther`), or -1. */
function nextTag(xml: string, name: string, pos: number, end = xml.length): number {
  const open = '<' + name;
  for (;;) {
    const i = xml.indexOf(open, pos);
    if (i < 0 || i >= end) return -1;
    if (isTagEnd(xml.charCodeAt(i + open.length))) return i;
    pos = i + open.length;
  }
}

// ---- styles.xml ----

class StyleBook {
  private xml: string;
  /** Resolved colour of each fill / of each cellXfs entry. */
  private fills: (string | null)[];
  readonly xfFill: (string | null)[];
  private xfs: { tag: string; rest: string; fillId: number }[] = [];
  private newFills: string[] = [];
  private newXfs: string[] = [];
  private fillOf = new Map<string, number>();
  private memo = new Map<string, number>();

  constructor(xml: string, theme: string[]) {
    this.xml = xml;
    this.fills = parseFills(xml, theme);
    this.xfFill = parseStyles(xml, theme);
    const sec = this.section('cellXfs');
    if (sec) {
      let p = sec.start;
      for (;;) {
        const i = nextTag(xml, 'xf', p, sec.end);
        if (i < 0) break;
        const te = xml.indexOf('>', i);
        const tag = xml.slice(i, te + 1);
        let end = te + 1;
        if (!tag.endsWith('/>')) end = xml.indexOf('</xf>', te) + 5;
        const fid = /\sfillId="(\d+)"/.exec(tag);
        this.xfs.push({ tag, rest: xml.slice(te + 1, end), fillId: fid ? parseInt(fid[1], 10) : 0 });
        p = end;
      }
    }
  }

  /** Inner range of <name …>…</name>. */
  private section(name: string): { open: number; openEnd: number; start: number; end: number } | null {
    const open = nextTag(this.xml, name, 0);
    if (open < 0) return null;
    const openEnd = this.xml.indexOf('>', open);
    if (this.xml[openEnd - 1] === '/') return null;
    const end = this.xml.indexOf(`</${name}>`, openEnd);
    return end < 0 ? null : { open, openEnd, start: openEnd + 1, end };
  }

  get xfsAdded() {
    return this.newXfs.length;
  }
  get fillsAdded() {
    return this.newFills.length;
  }
  get changed() {
    return this.newXfs.length > 0 || this.newFills.length > 0;
  }

  /** Fill id for a target colour: none → 0, else an existing solid fill of that colour, else a new one. */
  fillId(hex: string | null): number {
    if (!hex) return 0;
    const h = hex.toUpperCase();
    let id = this.fillOf.get(h);
    if (id == null) {
      id = this.fills.indexOf(h);
      if (id < 0) {
        id = this.fills.length + this.newFills.length;
        this.newFills.push(`<fill><patternFill patternType="solid"><fgColor rgb="FF${h}"/><bgColor indexed="64"/></patternFill></fill>`);
      }
      this.fillOf.set(h, id);
    }
    return id;
  }

  /** Style index like `s` but with fill `fillId` (a clone, memoised; `s` itself when it already has that fill). */
  withFill(s: number, fillId: number): number {
    const base = s < this.xfs.length ? s : 0;
    const xf = this.xfs[base];
    if (!xf) return s;
    if (xf.fillId === fillId) return base;
    const key = `${base}|${fillId}`;
    let id = this.memo.get(key);
    if (id == null) {
      id = this.xfs.length + this.newXfs.length;
      this.newXfs.push(setAttr(setAttr(xf.tag, 'fillId', String(fillId)), 'applyFill', '1') + xf.rest);
      this.memo.set(key, id);
    }
    return id;
  }

  serialize(): string {
    let xml = this.xml;
    // cellXfs comes after fills: edit it first so the fills offsets stay valid.
    const edits: [string, string[], number][] = [
      ['cellXfs', this.newXfs, this.xfs.length],
      ['fills', this.newFills, this.fills.length],
    ];
    for (const [name, added, had] of edits) {
      if (!added.length) continue;
      this.xml = xml;
      const sec = this.section(name);
      if (!sec) throw new Error(`styles.xml has no <${name}>`);
      const openTag = setAttr(xml.slice(sec.open, sec.openEnd + 1), 'count', String(had + added.length));
      xml = xml.slice(0, sec.open) + openTag + xml.slice(sec.start, sec.end) + added.join('') + xml.slice(sec.end);
    }
    this.xml = xml;
    return xml;
  }
}

// ---- sheets ----

/** Strip spaces and the punctuation the importer strips from word forms, so 捡（起） still contains 捡起. */
function normWord(s: string): string {
  return s.replace(/[\s。．.…!！?？()（）「」“”"'‘’:：]+/g, '');
}

function colStyles(xml: string, dataStart: number): (idx: number) => number | undefined {
  const head = xml.slice(0, dataStart);
  const ranges: [number, number, number][] = [];
  for (const m of head.matchAll(/<col\b([^>]*)\/?>/g)) {
    const min = /\smin="(\d+)"/.exec(m[1]);
    const max = /\smax="(\d+)"/.exec(m[1]);
    const st = /\sstyle="(\d+)"/.exec(m[1]);
    if (min && st) ranges.push([parseInt(min[1], 10), parseInt((max ?? min)[1], 10), parseInt(st[1], 10)]);
  }
  return (idx) => ranges.find(([a, b]) => idx >= a && idx <= b)?.[2];
}

interface Cell {
  start: number;
  tagEnd: number; // index after the opening tag's '>'
  end: number; // index after the element
  tag: string;
  idx: number;
  s: number;
}

interface SheetCtx {
  sheet: string;
  cols: SheetCols;
  styles: StyleBook;
  shared: () => string[];
  stats: { rows: number; cells: number; skipped: number };
}

function cellText(body: string, c: Cell, shared: () => string[]): string {
  if (c.end - c.tagEnd <= 0) return '';
  const inner = body.slice(c.tagEnd, c.end);
  const t = T_ATTR.exec(c.tag)?.[1];
  if (t === 'inlineStr') {
    const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
    return is ? richText(is[1]) : '';
  }
  const v = /<v>([\s\S]*?)<\/v>/.exec(inner);
  if (!v) return '';
  return t === 's' ? shared()[parseInt(v[1], 10)] ?? '' : decodeXml(v[1]);
}

function parseCells(body: string): Cell[] {
  const cells: Cell[] = [];
  let p = 0;
  let implied = 0;
  for (;;) {
    const i = nextTag(body, 'c', p);
    if (i < 0) break;
    const te = body.indexOf('>', i) + 1;
    const tag = body.slice(i, te);
    const end = tag.endsWith('/>') ? te : body.indexOf('</c>', te) + 4;
    const ref = R_ATTR.exec(tag)?.[1];
    const idx = ref ? colToIndex(ref.replace(/[^A-Z]/gi, '').toUpperCase()) : implied + 1;
    implied = idx;
    const s = parseInt(S_ATTR.exec(tag)?.[1] ?? '0', 10);
    cells.push({ start: i, tagEnd: te, end, tag, idx, s });
    p = end;
  }
  return cells;
}

/** Patch one sheet's XML for its target rows (sorted by row). */
function patchSheet(xml: string, targets: RowFill[], ctx: SheetCtx): string {
  const { cols, styles, stats } = ctx;
  const dataStart = nextTag(xml, 'sheetData', 0);
  if (dataStart < 0) {
    stats.skipped += targets.length;
    return xml;
  }
  const colStyle = colStyles(xml, dataStart);
  const first = colToIndex(cols.first);
  const last = colToIndex(cols.last);
  const hanziIdx = cols.hanzi ? colToIndex(cols.hanzi) : 0;
  const statusIdx = [...new Set(cols.status.map(colToIndex))].sort((a, b) => a - b);

  const out: string[] = [];
  let copied = 0;
  let pos = dataStart;
  let implied = 0;

  for (const t of targets) {
    // Find <row r="t.row"> going forward; rows are in ascending order.
    let rowStart = -1;
    let tagEnd = 0;
    for (;;) {
      const i = nextTag(xml, 'row', pos);
      if (i < 0) break;
      const te = xml.indexOf('>', i) + 1;
      const r = R_ATTR.exec(xml.slice(i, te));
      const n = r ? parseInt(r[1], 10) : implied + 1;
      if (n < t.row) {
        implied = n;
        pos = te;
        continue;
      }
      if (n === t.row) {
        implied = n;
        rowStart = i;
        tagEnd = te;
      }
      break;
    }
    if (rowStart < 0) {
      stats.skipped++;
      continue;
    }
    const rowTag = xml.slice(rowStart, tagEnd);
    const selfClosing = rowTag.endsWith('/>');
    const rowEnd = selfClosing ? tagEnd : xml.indexOf('</row>', tagEnd) + 6;
    pos = rowEnd;
    const body = selfClosing ? '' : xml.slice(tagEnd, rowEnd - 6);
    const cells = parseCells(body);

    // Safety: the row still holds the word.
    const want = normWord(t.hanzi);
    const holds = (c: Cell) => normWord(cellText(body, c, ctx.shared)).includes(want);
    const ok = hanziIdx
      ? cells.some((c) => c.idx === hanziIdx && holds(c))
      : cells.some((c) => c.idx >= first && c.idx <= last && holds(c));
    if (!ok) throw new WorkbookChangedError(ctx.sheet, t.row);

    const fillId = styles.fillId(t.fill);
    const fillOfCell = (c: Cell) => styles.xfFill[c.s] ?? null;
    // Cells of the table that carry the row's colour…
    let edit = t.from ? cells.filter((c) => c.idx >= first && c.idx <= last && fillOfCell(c) === t.from) : [];
    const inserts: { idx: number; s: number }[] = [];
    if (!edit.length) {
      // …or, for a row without colour, the sheet's status columns (cells with a colour of their own stay).
      const rowS = CF_ATTR.test(rowTag) ? parseInt(S_ATTR.exec(rowTag)?.[1] ?? '0', 10) : undefined;
      for (const idx of statusIdx) {
        const c = cells.find((x) => x.idx === idx);
        if (c) {
          const f = fillOfCell(c);
          if (!f || f === 'FFFFFF') edit.push(c);
        } else {
          inserts.push({ idx, s: styles.withFill(rowS ?? colStyle(idx) ?? 0, fillId) });
        }
      }
    }
    edit = edit.filter((c) => styles.withFill(c.s, fillId) !== c.s);
    if (!edit.length && !inserts.length) continue;

    // Rebuild the row: untouched slices, edited opening tags, inserted cells in column order.
    const editSet = new Set(edit);
    const parts: string[] = [];
    let bp = 0;
    let k = 0;
    const flushInserts = (before: number) => {
      while (k < inserts.length && inserts[k].idx < before) {
        parts.push(`<c r="${indexToCol(inserts[k].idx)}${t.row}" s="${inserts[k].s}"/>`);
        k++;
      }
    };
    for (const c of cells) {
      if (k < inserts.length && inserts[k].idx < c.idx) {
        parts.push(body.slice(bp, c.start));
        bp = c.start;
        flushInserts(c.idx);
      }
      if (editSet.has(c)) {
        parts.push(body.slice(bp, c.start), setAttr(c.tag, 's', String(styles.withFill(c.s, fillId))));
        bp = c.tagEnd;
      }
    }
    parts.push(body.slice(bp));
    flushInserts(Infinity);
    const openTag = selfClosing ? rowTag.slice(0, -2).trimEnd() + '>' : rowTag;
    out.push(xml.slice(copied, rowStart), openTag, parts.join(''), '</row>');
    copied = rowEnd;
    stats.rows++;
    stats.cells += edit.length + inserts.length;
  }
  if (!out.length) return xml;
  out.push(xml.slice(copied));
  return out.join('');
}

function sharedStrings(xml: string | null): string[] {
  const out: string[] = [];
  if (!xml) return out;
  const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) out.push(m[1] ? richText(m[1]) : '');
  return out;
}

/** The workbook with the given rows' fills changed. Throws WorkbookChangedError when a row no longer holds its word. */
export function patchWorkbookFills(req: PatchRequest): PatchResult {
  const files = unzipSync(req.bytes);
  const names = Object.keys(files);
  const text = (p: string): string | null => (files[p] ? strFromU8(files[p]) : null);
  const stylesXml = text('xl/styles.xml');
  if (!stylesXml) throw new Error('The workbook has no styles.xml');
  const styles = new StyleBook(stylesXml, parseTheme(text('xl/theme/theme1.xml')));
  const paths = new Map(sheetPaths(text('xl/workbook.xml') || '', text('xl/_rels/workbook.xml.rels') || '').map((x) => [x.name, x.path]));
  let shared: string[] | null = null;
  const getShared = () => (shared ??= sharedStrings(text('xl/sharedStrings.xml')));
  const stats = { rows: 0, cells: 0, skipped: 0 };

  const bySheet = new Map<string, RowFill[]>();
  for (const r of req.rows) {
    const l = bySheet.get(r.sheet);
    if (l) l.push(r);
    else bySheet.set(r.sheet, [r]);
  }
  for (const [sheet, list] of bySheet) {
    const path = paths.get(sheet);
    const cols = req.cols[sheet];
    if (!path || !cols || !files[path]) {
      stats.skipped += list.length;
      continue;
    }
    list.sort((a, b) => a.row - b.row);
    const xml = strFromU8(files[path]);
    const patched = patchSheet(xml, list, { sheet, cols, styles, shared: getShared, stats });
    if (patched !== xml) files[path] = strToU8(patched);
  }
  if (styles.changed) files['xl/styles.xml'] = strToU8(styles.serialize());

  const zip: Zippable = {};
  for (const n of names) zip[n] = files[n];
  return {
    bytes: zipSync(zip, { level: 6 }),
    rows: stats.rows,
    cells: stats.cells,
    xfsAdded: styles.xfsAdded,
    fillsAdded: styles.fillsAdded,
    skipped: stats.skipped,
  };
}
