// Minimal, fast .xlsx reader: values + resolved cell fill colours.
// Written for large sheets full of styled empty cells (only cells with a value are kept).
import { unzipSync, strFromU8 } from 'fflate';

export interface XCell {
  v: string;
  /** Resolved fill colour as RRGGBB, or null when the cell has no solid fill. */
  fill: string | null;
}
export interface XRow {
  r: number;
  cells: Record<string, XCell>;
}
export interface XSheet {
  name: string;
  rows: XRow[];
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeXml(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (_, e: string) => {
    if (e[0] === '#') {
      const code = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return String.fromCodePoint(code);
    }
    return ENT[e];
  });
}

function attr(tag: string, name: string): string | null {
  const m = new RegExp(`\\b${name}="([^"]*)"`).exec(tag);
  return m ? m[1] : null;
}

/** Text of an <si> or <is> element, skipping phonetic runs (<rPh>). */
function richText(xml: string): string {
  const noPh = xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '');
  let out = '';
  const re = /<t\b[^>]*>([\s\S]*?)<\/t>|<t\b[^>]*\/>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(noPh))) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}

// --- colours -------------------------------------------------------------

function hexToRgb(hex: string): [number, number, number] {
  return [parseInt(hex.slice(0, 2), 16), parseInt(hex.slice(2, 4), 16), parseInt(hex.slice(4, 6), 16)];
}
function rgbToHex([r, g, b]: [number, number, number]): string {
  return [r, g, b].map((x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, '0')).join('').toUpperCase();
}
export function rgbToHsl([r, g, b]: [number, number, number]): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h = 0;
  if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return [h * 60, s, l];
}
function hslToRgb([h, s, l]: [number, number, number]): [number, number, number] {
  if (s === 0) return [l * 255, l * 255, l * 255];
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hh = h / 360;
  return [hue(p, q, hh + 1 / 3) * 255, hue(p, q, hh) * 255, hue(p, q, hh - 1 / 3) * 255];
}
function applyTint(hex: string, tint: number): string {
  if (!tint) return hex;
  const [h, s, l] = rgbToHsl(hexToRgb(hex));
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return rgbToHex(hslToRgb([h, s, nl]));
}

// Excel's legacy indexed palette (first 64 entries).
const INDEXED = [
  '000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF','000000','FFFFFF','FF0000','00FF00','0000FF','FFFF00','FF00FF','00FFFF',
  '800000','008000','000080','808000','800080','008080','C0C0C0','808080','9999FF','993366','FFFFCC','CCFFFF','660066','FF8080','0066CC','CCCCFF',
  '000080','FF00FF','FFFF00','00FFFF','800080','800000','008080','0000FF','00CCFF','CCFFFF','CCFFCC','FFFF99','99CCFF','FF99CC','CC99FF','FFCC99',
  '3366FF','33CCCC','99CC00','FFCC00','FF9900','FF6600','666699','969696','003366','339966','003300','333300','993300','993366','333399','333333',
];

function parseTheme(xml: string | null): string[] {
  // Theme colour index order used by cell styles: lt1, dk1, lt2, dk2, accent1..6, hlink, folHlink
  const fallback = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];
  if (!xml) return fallback;
  const get = (name: string): string | null => {
    const m = new RegExp(`<a:${name}>([\\s\\S]*?)</a:${name}>`).exec(xml);
    if (!m) return null;
    return attr(m[1], 'lastClr') || attr(m[1], 'val');
  };
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  return order.map((n, i) => {
    const v = get(n);
    return v && /^[0-9A-Fa-f]{6}$/.test(v) ? v.toUpperCase() : fallback[i];
  });
}

function resolveColor(colorTag: string, theme: string[]): string | null {
  const rgb = attr(colorTag, 'rgb');
  const tint = parseFloat(attr(colorTag, 'tint') || '0');
  if (rgb) return applyTint(rgb.slice(-6).toUpperCase(), tint);
  const th = attr(colorTag, 'theme');
  if (th != null) {
    const base = theme[parseInt(th, 10)];
    return base ? applyTint(base, tint) : null;
  }
  const idx = attr(colorTag, 'indexed');
  if (idx != null) {
    const i = parseInt(idx, 10);
    return i < INDEXED.length ? applyTint(INDEXED[i], tint) : null;
  }
  return null;
}

/** For every cellXfs entry, the resolved solid fill colour (or null). */
function parseStyles(xml: string | null, theme: string[]): (string | null)[] {
  if (!xml) return [];
  const fillsXml = /<fills\b[^>]*>([\s\S]*?)<\/fills>/.exec(xml)?.[1] ?? '';
  const fills: (string | null)[] = [];
  const fre = /<fill>([\s\S]*?)<\/fill>|<fill\/>/g;
  let m: RegExpExecArray | null;
  while ((m = fre.exec(fillsXml))) {
    const inner = m[1] || '';
    const pat = /<patternFill\b([^>]*)/.exec(inner);
    const type = pat ? attr(pat[1], 'patternType') : null;
    if (type !== 'solid') {
      fills.push(null);
      continue;
    }
    const fg = /<fgColor\b[^>]*\/?>/.exec(inner);
    fills.push(fg ? resolveColor(fg[0], theme) : null);
  }
  const xfsXml = /<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/.exec(xml)?.[1] ?? '';
  const out: (string | null)[] = [];
  const xre = /<xf\b([^>]*?)(\/>|>)/g;
  while ((m = xre.exec(xfsXml))) {
    const fillId = parseInt(attr(m[1], 'fillId') || '0', 10);
    out.push(fills[fillId] ?? null);
  }
  return out;
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}
export function indexToCol(n: number): string {
  let s = '';
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

export function readWorkbook(data: ArrayBuffer | Uint8Array): XSheet[] {
  const u8 = data instanceof Uint8Array ? data : new Uint8Array(data);
  const files = unzipSync(u8, {
    filter: (f) => /^(xl\/(workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|styles\.xml|theme\/theme1\.xml|worksheets\/[^/]+\.xml))$/.test(f.name),
  });
  const text = (p: string): string | null => (files[p] ? strFromU8(files[p]) : null);

  const theme = parseTheme(text('xl/theme/theme1.xml'));
  const styleFill = parseStyles(text('xl/styles.xml'), theme);

  const shared: string[] = [];
  const ssXml = text('xl/sharedStrings.xml');
  if (ssXml) {
    const re = /<si>([\s\S]*?)<\/si>|<si\/>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(ssXml))) shared.push(m[1] ? richText(m[1]) : '');
  }

  const rels: Record<string, string> = {};
  const relXml = text('xl/_rels/workbook.xml.rels') || '';
  for (const m of relXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = attr(m[1], 'Id');
    const target = attr(m[1], 'Target');
    if (id && target) rels[id] = target.replace(/^\/?xl\//, '').replace(/^\//, '');
  }

  const sheets: XSheet[] = [];
  const wbXml = text('xl/workbook.xml') || '';
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(attr(m[1], 'name') || '');
    const rid = attr(m[1], 'r:id');
    if (!rid || !rels[rid]) continue;
    const xml = text('xl/' + rels[rid]);
    if (!xml) continue;
    sheets.push({ name, rows: parseSheet(xml, shared, styleFill) });
  }
  return sheets;
}

function parseSheet(xml: string, shared: string[], styleFill: (string | null)[]): XRow[] {
  const rows: XRow[] = [];
  const rowRe = /<row\b([^>]*)>([\s\S]*?)<\/row>/g;
  const cellRe = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let rm: RegExpExecArray | null;
  while ((rm = rowRe.exec(xml))) {
    const body = rm[2];
    if (body.indexOf('<v>') < 0 && body.indexOf('<is>') < 0) continue; // only styled empty cells
    const r = parseInt(attr(rm[1], 'r') || '0', 10);
    const cells: Record<string, XCell> = {};
    let cm: RegExpExecArray | null;
    cellRe.lastIndex = 0;
    let colCounter = 0;
    while ((cm = cellRe.exec(body))) {
      const a = cm[1];
      const inner = cm[2];
      colCounter++;
      if (!inner) continue;
      const ref = attr(a, 'r');
      const col = ref ? ref.replace(/\d+/g, '') : indexToCol(colCounter);
      const t = attr(a, 't');
      let v: string | null = null;
      if (t === 'inlineStr') {
        const is = /<is>([\s\S]*?)<\/is>/.exec(inner);
        v = is ? richText(is[1]) : null;
      } else {
        const vm = /<v>([\s\S]*?)<\/v>/.exec(inner);
        if (vm) {
          if (t === 's') v = shared[parseInt(vm[1], 10)] ?? '';
          else v = decodeXml(vm[1]);
        }
      }
      if (v == null || v === '') continue;
      const s = parseInt(attr(a, 's') || '0', 10);
      cells[col] = { v, fill: styleFill[s] ?? null };
      if (ref) colCounter = colToIndex(col);
    }
    if (Object.keys(cells).length) rows.push({ r, cells });
  }
  return rows;
}
