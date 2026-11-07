// Turns the sheets of Hugo_chinese_vocab.xlsx into notes, with an import report.
// Pure: the pinyin dictionary and French lookup are passed in, so this runs in a worker or in tests.
import type { XRow, XSheet } from '../xlsx/read';
import { indexToCol, rgbToHsl } from '../xlsx/read';
import type { Example, ImportIssue, Note, NoteKind, SheetCols, SheetReport, SourceRef, VocabFile } from '../types';
import { HAN, hanCount, numberedToMarked, parsePinyin, syllablesFromNumbered, toMarked, toNumbered, toToneless, type Syl } from '../pinyin';

export interface BuildOptions {
  source: { name: string; modified: number; size: number };
  now: number;
  device?: string;
  prevSeeds?: Record<string, number>;
  /** Dictionary reading of a word, numbered syllables per character (pinyin-pro). */
  pinyinOf: (hanzi: string) => string[];
  /** Readings of a word in CFDICT, numbered (da3 ban5). */
  readingsOf?: (hanzi: string) => string[];
  /** French meaning from CFDICT. */
  french?: (hanzi: string, pinyinNum: string) => string | undefined;
}

/** The two greens used in the workbook; any other green shade also counts (hue check). */
export const GREENS = new Set(['C5E0B4', 'A9D18E']);

export function isGreen(hex: string | null | undefined): boolean {
  if (!hex) return false;
  const h = hex.toUpperCase();
  if (GREENS.has(h)) return true;
  const [hue, s, l] = rgbToHsl([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
  return hue >= 75 && hue <= 165 && s >= 0.2 && l >= 0.2 && l <= 0.9;
}

const CN_DIGITS: Record<string, string> = { 一: '1', 二: '2', 三: '3', 四: '4', 五: '5', 六: '6', 七: '7' };
export function sheetTag(name: string): string {
  const m = /^HSK\s*([一二三四五六七]|\d)/i.exec(name);
  if (m) return 'HSK' + (CN_DIGITS[m[1]] ?? m[1]);
  return name;
}

type Field =
  | 'id' | 'hanzi' | 'pinyin' | 'en' | 'fr' | 'example' | 'exampleFr'
  | 'core' | 'tone' | 'related' | 'exZh' | 'exPy' | 'exEn' | 'tip';

interface Layout {
  kind: NoteKind | 'skipped';
  header: number;
  cols: Partial<Record<Field, string>>;
  noteCols: { col: string; label: string }[];
}

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

const ALIASES: Record<Field, string[]> = {
  id: ['id', 'n°', 'no', '#'],
  hanzi: ['hanzi', '汉字', '中文', 'chinese', 'word', 'mot', 'classificateur', 'pattern', 'structure'],
  pinyin: ['pinyin', '拼音'],
  en: ['english', 'meaning', 'anglais', 'meaningen', 'translation', 'core meaning'],
  fr: ['meaningfr', 'meaning fr', 'french', 'français', 'francais', 'fr', 'utilisation principale', 'explanationfr'],
  example: ['exemple', 'example', 'examples', 'exemples', '例句'],
  exampleFr: ['examplefr', 'exemplefr'],
  core: ['core meaning'],
  tone: ['emotion / tone', 'tone', 'emotion'],
  related: ['opposite / related', 'related', 'opposite'],
  exZh: ['sentence example (chinese)'],
  exPy: ['sentence example (pinyin)'],
  exEn: ['english translation'],
  tip: ['key grammar / tip', 'tip', 'key grammar'],
};

function detectLayout(sheet: XSheet): Layout {
  if (/^exam$/i.test(sheet.name.trim())) return { kind: 'skipped', header: 0, cols: {}, noteCols: [] };
  for (const row of sheet.rows.slice(0, 10)) {
    const cols: Partial<Record<Field, string>> = {};
    const labels: Record<string, string> = {};
    for (const [col, cell] of Object.entries(row.cells)) {
      const v = norm(cell.v);
      labels[col] = cell.v.trim();
      for (const f of Object.keys(ALIASES) as Field[]) {
        if (cols[f]) continue;
        if (ALIASES[f].includes(v)) {
          // the first matching field wins for this column
          if (!Object.values(cols).includes(col)) cols[f] = col;
        }
      }
    }
    const used = new Set(Object.values(cols));
    const others = Object.keys(row.cells)
      .filter((c) => !used.has(c))
      .map((c) => ({ col: c, label: labels[c] }));
    const has = (f: Field) => !!cols[f];
    const vals = Object.values(row.cells).map((c) => norm(c.v));
    if (vals.includes('classificateur')) {
      return { kind: 'measure', header: row.r, cols, noteCols: [] };
    }
    if (vals.includes('core meaning')) {
      const c: Partial<Record<Field, string>> = { ...cols };
      for (const [col, cell] of Object.entries(row.cells)) {
        const v = norm(cell.v);
        if (v === 'core meaning') { c.en = col; c.core = col; }
        if (v === 'english translation') c.exEn = col;
      }
      return { kind: 'synonym', header: row.r, cols: c, noteCols: [] };
    }
    if (has('hanzi') && has('pinyin') && has('en')) return { kind: 'vocab', header: row.r, cols, noteCols: others };
    if (has('hanzi') && has('en')) return { kind: 'grammar', header: row.r, cols, noteCols: others.filter((o) => o.col !== cols.example) };
  }
  return { kind: 'skipped', header: 0, cols: {}, noteCols: [] };
}

const FORM_SPLIT = /[\s,，、/;；]+/;
const FORM_STRIP = /[。．.…!！?？()（）「」“”"'‘’:：]+/g;

export function splitForms(raw: string): string[] {
  return raw
    .split(FORM_SPLIT)
    .map((f) => f.replace(FORM_STRIP, '').trim())
    .filter((f) => HAN.test(f));
}

export function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface PinyinResult {
  syls: Syl[];
  display: string;
  issues: { level: 'fix' | 'info'; problem: string; suggestion?: string }[];
}

const SANDHI = new Set(['一', '不']);

const marked = (syls: Syl[]) => numberedToMarked(syls.map((x) => x.s + x.t));
const sameSyls = (a: Syl[], b: Syl[]) => a.length === b.length && a.every((x, i) => x.s === b[i].s && x.t === b[i].t);

/**
 * Check and normalise the pinyin written for a word. Readings come from CFDICT (which knows
 * neutral tones and polyphones) and, as a fallback, from pinyin-pro.
 */
export function checkPinyin(
  raw: string,
  hanzi: string,
  pinyinOf: (h: string) => string[],
  readingsOf?: (h: string) => string[],
): PinyinResult {
  const issues: PinyinResult['issues'] = [];
  const chars = [...hanzi].filter((c) => HAN.test(c));
  const word = chars.join('');
  const expected = chars.length;
  const pp = syllablesFromNumbered(pinyinOf(word));
  const readings = (readingsOf?.(word) ?? [])
    .map((r) => syllablesFromNumbered(r.split(' ')))
    .filter((r) => r.length === expected);
  const best = readings.find((r) => toToneless(r) === toToneless(pp)) ?? readings[0] ?? pp;
  const useDict = (level: 'fix' | 'info', problem: string): PinyinResult => {
    issues.push({ level, problem, suggestion: marked(best) });
    return { syls: best, display: marked(best), issues };
  };
  const text = raw.trim();
  if (!text) return useDict('fix', 'No pinyin');
  if (HAN.test(text)) return useDict('fix', 'Chinese characters in the PINYIN cell');
  const p = parsePinyin(text, expected);
  if (!p.ok) return useDict('fix', `Not valid pinyin (${p.error})`);
  const syls = p.syls;
  const core = syls.filter((s, i) => !(s.s === 'r' && i > 0 && syls.length > expected)); // erhua without 儿
  if (core.length !== expected) return useDict('fix', `${syls.length} syllables for ${expected} characters`);

  const refs = [...readings, pp];
  const sameLetters = refs.filter((r) => toToneless(r) === toToneless(core));
  if (!sameLetters.length) {
    issues.push({ level: 'fix', problem: 'Pinyin differs from the dictionary reading', suggestion: marked(best) });
    return { syls, display: toMarked(p), issues };
  }
  const ref = sameLetters[0];
  const fromCfdict = readings.includes(ref);
  if (!p.marks && !p.digits) {
    // No tones at all: borrow the dictionary's tones.
    if (ref.some((d) => d.t !== 5)) {
      issues.push({ level: 'fix', problem: 'No tones', suggestion: marked(ref) });
      const fixed = syls.map((s, i) => (ref[i] ? { ...ref[i] } : s));
      return { syls: fixed, display: toMarked({ ...p, syls: fixed }), issues };
    }
    return { syls, display: toMarked(p), issues };
  }
  if (p.marks && p.digits) issues.push({ level: 'info', problem: 'Tone marks and numbers mixed (converted)', suggestion: toMarked(p) });
  else if (p.digits) issues.push({ level: 'info', problem: 'Tone numbers (converted to marks)', suggestion: toMarked(p) });
  if (sameLetters.some((r) => sameSyls(r, core))) return { syls, display: toMarked(p), issues };
  const missing: string[] = [];
  const differ: string[] = [];
  core.forEach((s, i) => {
    const d = ref[i];
    if (SANDHI.has(chars[i])) return;
    // pinyin-pro gives citation tones, so an untoned last syllable may well be a neutral tone
    if (!s.toned && d.t !== 5 && (fromCfdict || i < core.length - 1 || core.length === 1)) missing.push(chars[i]);
    else if (s.toned && s.t !== 5 && d.t !== 5 && s.t !== d.t && fromCfdict) differ.push(chars[i]);
  });
  if (missing.length) issues.push({ level: 'info', problem: `No tone on ${missing.join(', ')}`, suggestion: marked(ref) });
  if (differ.length) issues.push({ level: 'info', problem: `Tone on ${differ.join(', ')} differs from the dictionary`, suggestion: marked(ref) });
  return { syls, display: toMarked(p), issues };
}

function cellText(row: XRow, col: string | undefined): string {
  if (!col) return '';
  return row.cells[col]?.v ?? '';
}

function rowStudied(row: XRow, hanziCol: string | undefined): boolean {
  if (hanziCol && isGreen(row.cells[hanziCol]?.fill)) return true;
  const cells = Object.values(row.cells);
  if (!cells.length) return false;
  const greens = cells.filter((c) => isGreen(c.fill)).length;
  return greens * 2 > cells.length;
}

function rowColour(row: XRow, cols: string[]): string | undefined {
  for (const c of cols) {
    const f = row.cells[c]?.fill;
    if (f && f !== 'FFFFFF') return f;
  }
  return undefined;
}

/** "一个人 (yī gè rén)" lines → examples. */
export function parseExamples(raw: string): Example[] {
  return raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l): Example[] => {
      const m = /^(.*?)\s*[(（]([^()（）]*)[)）]\s*(.*)$/.exec(l);
      if (m && HAN.test(m[1]) && !HAN.test(m[2])) {
        const rest = m[3].replace(/^[\s,，;；、]+/, '').trim();
        const ex: Example[] = [{ zh: m[1].trim(), pinyin: m[2].trim() }];
        if (rest && HAN.test(rest)) ex.push(...parseExamples(rest));
        else if (rest) ex[0].en = rest;
        return ex;
      }
      return [{ zh: l.replace(/[，,;；]+$/, '').trim() }];
    })
    .flat();
}

function cleanMeaning(s: string): string {
  return s.replace(/\r\n/g, '\n').trim();
}

export function buildVocab(sheets: XSheet[], opts: BuildOptions): VocabFile {
  const notes = new Map<string, Note>();
  const issues: ImportIssue[] = [];
  const report: SheetReport[] = [];
  const exampleCache = new Map<string, string>();
  const examplePinyin = (zh: string) => {
    if (!exampleCache.has(zh)) exampleCache.set(zh, sentencePinyin(zh, opts.pinyinOf));
    return exampleCache.get(zh)!;
  };

  sheets.forEach((sheet, sheetIndex) => {
    const layout = detectLayout(sheet);
    const rep: SheetReport = { name: sheet.name, kind: layout.kind, rows: 0, notes: 0, studied: 0, colours: {} };
    report.push(rep);
    if (layout.kind === 'skipped') {
      rep.rows = sheet.rows.length;
      return;
    }
    const { cols } = layout;
    const tag = sheetTag(sheet.name);
    const rows = sheet.rows.filter((r) => r.r > layout.header);
    rep.rows = rows.length;
    const created = new Set<string>();
    // Coloured rows, for the columns that carry the status colour (SheetReport.cols).
    const coloured: { row: XRow; colour: string }[] = [];

    // Related-word groups: 233 + 233bis + 233ter on the same sheet.
    const idNum = (id: string) => /^\s*(\d+)\s*([a-z]*)\s*$/i.exec(id);
    const suffixed = new Set<string>();
    if (cols.id) for (const r of rows) {
      const m = idNum(cellText(r, cols.id));
      if (m && m[2]) suffixed.add(m[1]);
    }

    for (const row of rows) {
      const issue = (level: 'fix' | 'info', problem: string, extra: Partial<ImportIssue> = {}) =>
        issues.push({ level, sheet: sheet.name, row: row.r, problem, ...extra });
      const hanziRaw = cellText(row, cols.hanzi);
      if (!hanziRaw.trim() && !cellText(row, cols.en).trim()) continue;
      const colour = rowColour(row, [cols.hanzi!, cols.id!].filter(Boolean));
      if (colour) {
        rep.colours[colour] = (rep.colours[colour] || 0) + 1;
        coloured.push({ row, colour });
      }
      const studied = rowStudied(row, cols.hanzi);
      const order = sheetIndex * 100000 + row.r;
      const idRaw = cellText(row, cols.id).trim();
      const ref: SourceRef = { sheet: sheet.name, row: row.r, ...(idRaw ? { id: idRaw } : {}), ...(colour ? { colour } : {}) };

      let note: Note | null = null;

      if (layout.kind === 'grammar') {
        const lines = hanziRaw.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
        if (!lines.length) { issue('fix', 'No pattern in HANZI; row skipped', { col: cols.hanzi }); continue; }
        const en = cleanMeaning(cellText(row, cols.en));
        const ex = cellText(row, cols.example);
        const examples = ex ? parseExamples(ex).map((e) => ({ ...e, pinyin: e.pinyin || examplePinyin(e.zh) })) : [];
        note = {
          id: 'g:' + lines[0],
          kind: 'grammar',
          hanzi: lines[0],
          alts: lines.slice(1),
          pinyin: '',
          pinyinNum: '',
          en,
          ...(cols.fr && cellText(row, cols.fr).trim() ? { fr: cellText(row, cols.fr).trim() } : {}),
          notes: noteCells(row, layout),
          tags: [tag],
          refs: [ref],
          order,
          studied,
          ...(colour ? { colour } : {}),
          examples,
        };
        if (!en) issue('fix', 'No explanation', { col: cols.en, hanzi: lines[0] });
      } else {
        const forms = splitForms(hanziRaw);
        if (!forms.length) {
          issue('fix', 'No Chinese characters in this cell; row skipped', { col: cols.hanzi, hanzi: hanziRaw.trim() || undefined });
          continue;
        }
        if (hanziRaw !== hanziRaw.trim() || /\s{2,}/.test(hanziRaw.trim().replace(/\r?\n/g, ' '))) {
          issue('info', 'Extra spaces around the word (trimmed)', { col: cols.hanzi, hanzi: forms[0] });
        }
        // Pinyin: one segment per form when the cell lists several (shǎojiàn, hǎnjiàn).
        const pinyinRaw = cellText(row, cols.pinyin);
        const segs = pinyinRaw.split(/[,，;；/\r\n]+/).map((s) => s.trim()).filter(Boolean);
        let mainRaw = pinyinRaw;
        const altPinyin: string[] = [];
        if (segs.length > 1 && segs.length === forms.length) {
          mainRaw = segs[0];
          segs.slice(1).forEach((s, i) => {
            const p = parsePinyin(s, hanCount(forms[i + 1]));
            altPinyin.push(p.ok ? toNumbered(p.syls, ' ') : opts.pinyinOf(forms[i + 1]).join(' '));
          });
        } else if (forms.length > 1) {
          // One pinyin for several forms: find the form it was written for.
          const nat = parsePinyin(pinyinRaw);
          const n = nat.ok ? nat.syls.length : -1;
          const fits = (f: string) => n === hanCount(f) || (n === hanCount(f) + 1 && nat.syls[n - 1].s === 'r');
          const owner = fits(forms[0]) ? 0 : forms.findIndex(fits);
          if (owner > 0) forms.unshift(...forms.splice(owner, 1));
          else if (owner < 0 && nat.ok && n === hanCount(forms.join(''))) {
            mainRaw = marked(nat.syls.slice(0, hanCount(forms[0])));
          }
        }
        const primary = forms[0];
        const alts = forms.slice(1);
        if (pinyinRaw !== pinyinRaw.trim() && pinyinRaw.trim()) issue('info', 'Extra spaces in the pinyin (trimmed)', { col: cols.pinyin, hanzi: primary });
        const pc = checkPinyin(mainRaw, primary, opts.pinyinOf, opts.readingsOf);
        for (const i of pc.issues) issue(i.level, i.problem, { col: cols.pinyin, hanzi: primary, suggestion: i.suggestion });
        const pinyinNum = toNumbered(pc.syls, ' ');
        const toneless = toToneless(pc.syls);
        let en = cleanMeaning(cellText(row, cols.en));
        let fr: string | undefined;
        const examples: Example[] = [];
        const extra: Record<string, string> = {};
        if (layout.kind === 'measure') {
          fr = cleanMeaning(cellText(row, cols.fr));
          en = '';
          const ex = cellText(row, cols.example);
          if (ex) examples.push(...parseExamples(ex).map((e) => ({ ...e, pinyin: e.pinyin ? prettyIfPossible(e.pinyin) : examplePinyin(e.zh) })));
          if (!fr) issue('fix', 'No explanation', { col: cols.fr, hanzi: primary });
        } else if (layout.kind === 'synonym') {
          const zh = cellText(row, cols.exZh).trim();
          if (zh) examples.push({ zh, pinyin: cellText(row, cols.exPy).trim() || examplePinyin(zh), en: cellText(row, cols.exEn).trim() || undefined });
          for (const [k, f] of [['tone', 'tone'], ['related', 'related'], ['tip', 'tip']] as const) {
            const v = cellText(row, cols[f]).trim();
            if (v) extra[k] = v;
          }
          if (!en) issue('fix', 'No meaning', { col: cols.en, hanzi: primary });
        } else {
          if (cols.fr && cellText(row, cols.fr).trim()) fr = cellText(row, cols.fr).trim();
          if (!en && !fr) {
            issue('fix', 'No meaning; row skipped', { col: cols.en, hanzi: primary });
            continue;
          }
        }
        const prefix = layout.kind === 'vocab' ? 'v' : layout.kind === 'measure' ? 'm' : 's';
        let group: string | undefined;
        const m = idNum(idRaw);
        if (layout.kind === 'vocab' && m && suffixed.has(m[1])) group = `${tag}:${m[1]}`;
        note = {
          id: `${prefix}:${primary}|${toneless}`,
          kind: layout.kind,
          hanzi: primary,
          alts,
          pinyin: pc.display,
          pinyinNum,
          ...(altPinyin.length ? { altPinyin } : {}),
          en,
          ...(fr ? { fr } : {}),
          notes: noteCells(row, layout),
          tags: [tag],
          refs: [ref],
          order,
          studied,
          ...(colour ? { colour } : {}),
          examples,
          ...(group ? { group } : {}),
          ...(layout.kind === 'synonym' ? { set: sheet.name } : {}),
          ...(Object.keys(extra).length ? { extra } : {}),
        };
      }

      const prev = notes.get(note.id);
      if (prev) {
        merge(prev, note);
        if (created.has(note.id)) {
          const first = prev.refs[0];
          issues.push({ level: 'info', sheet: sheet.name, row: row.r, hanzi: note.hanzi, problem: `Same word as ${first.sheet} row ${first.row}; merged` });
        } else {
          const first = prev.refs[0];
          issues.push({ level: 'info', sheet: sheet.name, row: row.r, hanzi: note.hanzi, problem: `Also in ${first.sheet} (row ${first.row}); merged into one word` });
        }
      } else {
        notes.set(note.id, note);
        rep.notes++;
      }
      created.add(note.id);
    }
    rep.studied = [...notes.values()].filter((n) => n.studied && n.refs.some((r) => r.sheet === sheet.name)).length;
    const sc = sheetCols(sheet, layout, coloured);
    if (sc) rep.cols = sc;
  });

  const list = [...notes.values()].sort((a, b) => a.order - b.order);
  if (opts.french) {
    for (const n of list) {
      if (n.kind === 'grammar' || n.kind === 'measure' || n.fr) continue;
      const fr = opts.french(n.hanzi, n.pinyinNum);
      if (fr) n.frAuto = fr;
    }
  }
  const seeds: Record<string, number> = { ...(opts.prevSeeds || {}) };
  for (const n of list) if (n.studied && !(n.id in seeds)) seeds[n.id] = opts.now;

  return {
    version: 1,
    importedAt: opts.now,
    ...(opts.device ? { device: opts.device } : {}),
    source: opts.source,
    hash: fnv1a(JSON.stringify(list)),
    notes: list,
    issues,
    seeds,
    report,
  };
}

function colToIndex(col: string): number {
  let n = 0;
  for (const ch of col) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

/**
 * Columns of a sheet for the workbook copy: the header row's text columns, and the columns whose fill equals the row
 * colour in at least half of the coloured rows (fallback: ID and hanzi).
 */
function sheetCols(sheet: XSheet, layout: Layout, coloured: { row: XRow; colour: string }[]): SheetCols | undefined {
  const header = sheet.rows.find((r) => r.r === layout.header);
  const idx = Object.entries(header?.cells ?? {})
    .filter(([, c]) => c.v.trim())
    .map(([col]) => colToIndex(col))
    .sort((a, b) => a - b);
  if (!idx.length) return undefined;
  const lo = idx[0];
  const hi = idx[idx.length - 1];
  const { id, hanzi } = layout.cols;
  let status: string[] = [];
  if (coloured.length) {
    for (let i = lo; i <= hi; i++) {
      const col = indexToCol(i);
      const same = coloured.filter(({ row, colour }) => row.cells[col]?.fill === colour).length;
      if (same * 2 >= coloured.length) status.push(col);
    }
  }
  if (!status.length) status = [id, hanzi].filter((c): c is string => !!c).sort((a, b) => colToIndex(a) - colToIndex(b));
  return { ...(id ? { id } : {}), ...(hanzi ? { hanzi } : {}), first: indexToCol(lo), last: indexToCol(hi), status };
}

function noteCells(row: XRow, layout: Layout): string[] {
  return layout.noteCols.map((c) => row.cells[c.col]?.v?.trim()).filter((v): v is string => !!v);
}

function merge(into: Note, from: Note) {
  for (const t of from.tags) if (!into.tags.includes(t)) into.tags.push(t);
  into.refs.push(...from.refs);
  into.studied = into.studied || from.studied;
  if (from.en && !splitMeaningsLoose(into.en).includes(from.en.toLowerCase().trim())) {
    into.en = into.en ? `${into.en} · ${from.en}` : from.en;
  }
  if (from.fr && !into.fr) into.fr = from.fr;
  for (const a of from.alts) if (!into.alts.includes(a) && a !== into.hanzi) into.alts.push(a);
  for (const n of from.notes) if (!into.notes.includes(n)) into.notes.push(n);
  for (const e of from.examples) if (!into.examples.some((x) => x.zh === e.zh)) into.examples.push(e);
  if (!into.colour && from.colour) into.colour = from.colour;
  if (!into.group && from.group) into.group = from.group;
}

function splitMeaningsLoose(s: string): string[] {
  return [s.toLowerCase().trim(), ...s.split(' · ').map((x) => x.toLowerCase().trim())];
}

function prettyIfPossible(p: string): string {
  const parsed = parsePinyin(p);
  return parsed.ok ? toMarked(parsed) : p;
}

const PUNCT: Record<string, string> = { '，': ',', '。': '.', '！': '!', '？': '?', '；': ';', '：': ':', '、': ',', '“': '"', '”': '"', '（': '(', '）': ')' };

/** Pinyin for a sentence, word by word (pinyin-pro handles polyphones in context). */
export function sentencePinyin(zh: string, pinyinOf: (h: string) => string[]): string {
  const nums = pinyinOf(zh); // one syllable per Han character
  let k = 0;
  const seg =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(zh)].map((x) => x.segment)
      : [...zh];
  let out = '';
  for (const word of seg) {
    const han = [...word].filter((c) => HAN.test(c));
    if (han.length) {
      const w = numberedToMarked(han.map(() => nums[k++] ?? ''));
      out += (out && !/[\s(“"]$/.test(out) ? ' ' : '') + w;
    } else if (/^\s+$/.test(word)) {
      continue;
    } else {
      const p = [...word].map((c) => PUNCT[c] ?? c).join('');
      out += /^[,.!?;:)"]/.test(p) ? p : (out ? ' ' : '') + p;
    }
  }
  return out.trim();
}
