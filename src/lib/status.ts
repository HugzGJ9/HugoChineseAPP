// Word statuses Hugo sets himself (Sheets): Not studied, Studying, Not known, Mastered. Separate from FSRS.
// A row's status starts from its Excel colour; a status mark (st:* kinds, or the legacy known/relearn) wins when it is
// newer than the time that colour was first seen (VocabFile.colourSince). Pure, so every device computes the same.
import type { MarkKind, Note, RowFill, SourceRef, StatusMark, VocabFile, WordStatus } from './types';
import { rgbToHsl } from './xlsx/read';
import { isGreen, sheetTag } from './import/build';

/** Display order. */
export const WORD_STATUSES: WordStatus[] = ['new', 'studying', 'notknown', 'mastered'];

export const STATUS_LABEL: Record<WordStatus, string> = {
  new: 'Not studied',
  studying: 'Studying',
  notknown: 'Not known',
  mastered: 'Mastered',
};

/** Fill written into the workbook copy for a status (RRGGBB, null = no fill). */
export const STATUS_FILL: Record<WordStatus, string | null> = {
  mastered: 'A9D18E',
  notknown: 'FFFF00',
  studying: '8FAADC',
  new: null,
};

export const STATUS_MARK: Record<WordStatus, MarkKind> = {
  new: 'st:new',
  studying: 'st:studying',
  notknown: 'st:notknown',
  mastered: 'st:mastered',
};

const FROM_MARK: Record<string, WordStatus> = {
  'st:new': 'new',
  'st:studying': 'studying',
  'st:notknown': 'notknown',
  'st:mastered': 'mastered',
  // Legacy "I know this" / "Relearn" marks keep showing as statuses.
  known: 'mastered',
  relearn: 'notknown',
};

/** Status a mark sets, or null for marks that set none (suspend, unknown kinds). */
export function markStatus(a: string): WordStatus | null {
  return Object.prototype.hasOwnProperty.call(FROM_MARK, a) ? FROM_MARK[a] : null;
}

const YELLOWS = new Set(['FFFF00', 'FDF95F']);

function isYellow(h: string): boolean {
  if (YELLOWS.has(h)) return true;
  if (!/^[0-9A-F]{6}$/.test(h)) return false;
  const [hue, s, l] = rgbToHsl([parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]);
  return hue >= 45 && hue <= 65 && s >= 0.6 && l >= 0.5;
}

/** Colour rules of every sheet but HSK四级: green = Mastered, yellow = Not known, none = Not studied, other = Studying. */
export function generalColourStatus(colour?: string | null): WordStatus {
  const h = (colour ?? '').trim().toUpperCase();
  if (!h || h === 'FFFFFF') return 'new';
  if (isGreen(h)) return 'mastered';
  if (isYellow(h)) return 'notknown';
  return 'studying';
}

/** Status an Excel colour gives on a sheet: every HSK四级 row is Mastered, whatever its colour. */
export function colourStatus(sheet: string, colour?: string | null): WordStatus {
  if (sheetTag(sheet) === 'HSK4') return 'mastered';
  return generalColourStatus(colour);
}

/** Key of one Excel row of a note: k = nth ref of that note in that sheet. */
export function rowKey(noteId: string, sheet: string, k: number): string {
  return `${noteId}@${sheet}#${k}`;
}

/** Colour of a note's ref. Lists written by older app versions have only the note's colour, which is its first row's. */
export function refColour(note: Note, i: number): string | undefined {
  const ref = note.refs[i];
  return ref?.colour ?? (i === 0 ? note.colour : undefined);
}

/** Every row of a note with its key: (key, ref, ref index, nth in its sheet). */
function eachRow(note: Note, f: (key: string, ref: SourceRef, i: number, k: number) => void): void {
  const seen = new Map<string, number>();
  note.refs.forEach((ref, i) => {
    const k = seen.get(ref.sheet) ?? 0;
    seen.set(ref.sheet, k + 1);
    f(rowKey(note.id, ref.sheet, k), ref, i, k);
  });
}

type Since = NonNullable<VocabFile['colourSince']>;

function entry(map: VocabFile['colourSince'], key: string): [WordStatus, number] | undefined {
  const e = map?.[key];
  return Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1]) ? e : undefined;
}

/**
 * Per row: the colour status and since when it holds. The same status as before keeps its time; a changed status or a
 * new row gets `t`. With no previous map at all, every row gets 0, so marks set before win.
 * Renamed words (old id → new id) keep the times of their old row keys.
 */
export function colourSinceFor(notes: Note[], prev: VocabFile['colourSince'], renames: Record<string, string>, t: number): Since {
  const out: Since = {};
  const back = new Map<string, string>();
  for (const [from, to] of Object.entries(renames)) back.set(to, from);
  for (const note of notes) {
    const old = back.get(note.id);
    eachRow(note, (key, ref, i, k) => {
      const st = colourStatus(ref.sheet, refColour(note, i));
      if (!prev) {
        out[key] = [st, 0];
        return;
      }
      const p = (old != null ? entry(prev, rowKey(old, ref.sheet, k)) : undefined) ?? entry(prev, key);
      out[key] = p && p[0] === st ? [st, p[1]] : [st, t];
    });
  }
  return out;
}

const later = (a: StatusMark, b: StatusMark) => b.t > a.t || (b.t === a.t && b.id > a.id);

/** Latest status-setting mark per note (by time, then id, so every device agrees). */
export function latestStatusMarks(marks: StatusMark[]): Map<string, StatusMark> {
  const out = new Map<string, StatusMark>();
  for (const m of marks) {
    if (!markStatus(m.a)) continue;
    const cur = out.get(m.note);
    if (!cur || later(cur, m)) out.set(m.note, m);
  }
  return out;
}

export interface SheetRow {
  /** rowKey of this row. */
  key: string;
  note: Note;
  ref: SourceRef;
  /** Excel fill of the row (RRGGBB). */
  colour?: string;
  /** Status given by the Excel colour. */
  excel: WordStatus;
  /** Since when the Excel colour has given that status (0 = unknown, any mark wins). */
  since: number;
  /** Effective status. */
  status: WordStatus;
  /** The mark the status comes from, when a mark wins over the colour. */
  mark?: StatusMark;
}

/**
 * Rows per sheet, in Excel order (sheets in workbook order as far as the notes tell). `marks` are the alias-resolved
 * marks (state.marks). A mark wins when it is newer than the row's colour time; a tie goes to Excel.
 */
export function sheetRows(notes: Note[], marks: StatusMark[], since: VocabFile['colourSince']): Map<string, SheetRow[]> {
  const latest = latestStatusMarks(marks);
  const bySheet = new Map<string, SheetRow[]>();
  const sheetIdx = new Map<string, number>();
  for (const note of notes) {
    const first = note.refs[0]?.sheet;
    if (first != null) {
      const idx = Math.floor(note.order / 100000);
      if (!(sheetIdx.get(first)! <= idx)) sheetIdx.set(first, idx);
    }
    const m = latest.get(note.id);
    eachRow(note, (key, ref, i) => {
      const colour = refColour(note, i);
      const excel = colourStatus(ref.sheet, colour);
      const e = entry(since, key);
      // A time recorded for another status (a list re-imported by an older app version) says nothing about this colour.
      const s = e && e[0] === excel ? e[1] : 0;
      const wins = !!m && m.t > s;
      const row: SheetRow = {
        key,
        note,
        ref,
        ...(colour ? { colour } : {}),
        excel,
        since: s,
        status: wins ? markStatus(m!.a)! : excel,
        ...(wins ? { mark: m } : {}),
      };
      let list = bySheet.get(ref.sheet);
      if (!list) bySheet.set(ref.sheet, (list = []));
      list.push(row);
    });
  }
  const names = [...bySheet.keys()];
  const pos = new Map(names.map((n, i) => [n, i]));
  names.sort((a, b) => (sheetIdx.get(a) ?? Infinity) - (sheetIdx.get(b) ?? Infinity) || pos.get(a)! - pos.get(b)!);
  const out = new Map<string, SheetRow[]>();
  for (const n of names) {
    const list = bySheet.get(n)!;
    list.sort((a, b) => a.ref.row - b.ref.row || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    out.set(n, list);
  }
  return out;
}

/** One status per note: a winning mark, else the row with the latest colour time (a tie goes to the later sheet). */
export function noteStatuses(rows: Map<string, SheetRow[]>): Map<string, WordStatus> {
  const marked = new Map<string, WordStatus>();
  const best = new Map<string, { since: number; status: WordStatus }>();
  for (const list of rows.values()) {
    for (const r of list) {
      if (r.mark) {
        marked.set(r.note.id, r.status);
        continue;
      }
      const b = best.get(r.note.id);
      if (!b || r.since >= b.since) best.set(r.note.id, { since: r.since, status: r.excel });
    }
  }
  const out = new Map<string, WordStatus>();
  for (const [id, b] of best) out.set(id, b.status);
  for (const [id, s] of marked) out.set(id, s);
  return out;
}

/**
 * Fills for the workbook copy: rows whose effective status differs from their colour status, unless the row's colour
 * already expresses that status under the general rules (a pink row stays pink for Studying). In sheet, then row order.
 */
export function copyFills(rows: Map<string, SheetRow[]>): RowFill[] {
  const out: RowFill[] = [];
  for (const [sheet, list] of rows) {
    for (const r of list) {
      if (r.status === r.excel || generalColourStatus(r.colour) === r.status) continue;
      out.push({ sheet, row: r.ref.row, hanzi: r.note.hanzi, from: r.colour ?? null, fill: STATUS_FILL[r.status] });
    }
  }
  return out;
}
