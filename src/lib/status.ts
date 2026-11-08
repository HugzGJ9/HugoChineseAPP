// Word statuses Hugo sets himself (Sheets): Not studied, Studying, Not known, Mastered. Separate from FSRS.
// A row's status starts from its Excel colour; a status mark (st:* kinds, or the legacy known/relearn) wins when it is
// newer than the time that colour was first seen (VocabFile.colourSince). Pure, so every device computes the same.
import type { Explained, MarkKind, Note, RowFill, SourceRef, StatusChange, StatusMark, VocabFile, WordStatus } from './types';
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

/**
 * Status an Excel colour gives a new row on a sheet: every HSK四级 row starts Mastered, whatever its colour. Later
 * colour class changes there count as Excel edits (colourSinceFor, rule 3).
 */
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
/** The previous word list, as far as colour times need it. */
export type PrevColours = Pick<VocabFile, 'notes' | 'colourSince'>;

function entry(map: VocabFile['colourSince'], key: string): [WordStatus, number] | undefined {
  const e = map?.[key];
  return Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'number' && Number.isFinite(e[1]) ? e : undefined;
}

const isHsk4 = (sheet: string) => sheetTag(sheet) === 'HSK4';

/**
 * Whether a recorded colour status can stand for a row of this colour: on general sheets only the colour's own status;
 * on HSK四级 also Mastered (every HSK四级 row is Mastered until Hugo changes its colour class in Excel).
 */
function accepts(sheet: string, status: WordStatus, colour: string | undefined): boolean {
  const cls = generalColourStatus(colour);
  return status === cls || (isHsk4(sheet) && status === 'mastered');
}

/** A list written before rows carried their own colour: only the note's colour (its first coloured row) is known. */
const legacyNote = (n: Note) => !!n.colour && !n.refs.some((r) => r.colour != null);

/** Colour class (generalColourStatus) of every row of a list whose colours are known, by row key. */
function rowClasses(notes: Note[]): Map<string, WordStatus> {
  const out = new Map<string, WordStatus>();
  for (const n of notes) {
    if (legacyNote(n)) continue;
    eachRow(n, (key, ref) => out.set(key, generalColourStatus(ref.colour)));
  }
  return out;
}

function explainedEntry(e: unknown): [WordStatus, WordStatus, number] | undefined {
  return Array.isArray(e) && typeof e[0] === 'string' && typeof e[1] === 'string' && typeof e[2] === 'number' && Number.isFinite(e[2])
    ? (e as [WordStatus, WordStatus, number])
    : undefined;
}

/**
 * Per row: the status the Excel colour gives and since when it holds, by diffing this workbook version with the previous
 * list (plan 2026-11-08 D4). A row's previous colour is the previous list's note (through `renames`), same k-th row in
 * that sheet.
 * 1. New row: its colour status (HSK四级 → Mastered) at `t`. With no previous list (or one without colour times), every
 *    row gets 0, so marks set before win.
 * 2. Same colour class as before (none, green, yellow, other) → the previous entry, status and time.
 * 3. The class changed → an Excel edit: the new class's status at `t`, on every sheet, HSK四级 included. Unless one of
 *    this device's write intents (`explained`) shows this exact change on this row: then that mark's time (the app's own
 *    write is not an Excel edit).
 * 4. Previous colour unknown (lists from older versions, or a bare colour-time map) → the previous entry when it still
 *    fits the colour, else the colour status at `t`.
 */
export function colourSinceFor(
  notes: Note[],
  prev: PrevColours | VocabFile['colourSince'] | null,
  renames: Record<string, string>,
  t: number,
  explained?: Explained,
): Since {
  const list = prev && Array.isArray((prev as PrevColours).notes) ? (prev as PrevColours) : null;
  const map: VocabFile['colourSince'] = list ? list.colourSince : ((prev as VocabFile['colourSince'] | null) ?? undefined);
  const before = list ? rowClasses(list.notes) : new Map<string, WordStatus>();
  const out: Since = {};
  const back = new Map<string, string>();
  for (const [from, to] of Object.entries(renames)) back.set(to, from);
  for (const note of notes) {
    const old = back.get(note.id);
    const legacy = legacyNote(note);
    eachRow(note, (key, ref, i, k) => {
      const colour = refColour(note, i);
      const st = colourStatus(ref.sheet, colour);
      if (!map) {
        out[key] = [st, 0];
        return;
      }
      const oldKey = old != null ? rowKey(old, ref.sheet, k) : undefined;
      const p = (oldKey != null ? entry(map, oldKey) : undefined) ?? entry(map, key);
      const was = legacy ? undefined : (oldKey != null ? before.get(oldKey) : undefined) ?? before.get(key);
      const cls = generalColourStatus(colour);
      if (was === undefined || was === cls) {
        // Rules 1, 2 and 4.
        out[key] = p && accepts(ref.sheet, p[0], colour) ? [p[0], p[1]] : [st, t];
        return;
      }
      // Rule 3: an Excel edit, or the app's own write.
      const e = explainedEntry(explained?.[key]) ?? (oldKey != null ? explainedEntry(explained?.[oldKey]) : undefined);
      out[key] = e && e[0] === was && e[1] === cls ? [cls, e[2]] : [cls, t];
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
  /** Status given by the Excel colour (on HSK四级: Mastered, or the colour's class once Hugo changed it in Excel). */
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
 * An HSK四级 row takes its recorded status when it is Mastered or its colour's class (an Excel recolour, colourSinceFor
 * rule 3); otherwise Mastered with time 0.
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
      const e = entry(since, key);
      // A time recorded for another status (a list re-imported by an older app version) says nothing about this colour.
      const ok = !!e && accepts(ref.sheet, e[0], colour);
      const excel = ok ? e![0] : colourStatus(ref.sheet, colour);
      const s = ok ? e![1] : 0;
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
 * Fills for the workbook: rows whose effective status differs from their colour status, unless the row's colour
 * already expresses that status under the general rules (a pink row stays pink for Studying). In sheet, then row order.
 * Each fill carries its row key, the status written and the winning mark's time (for write intents, fillsExplained).
 */
export function copyFills(rows: Map<string, SheetRow[]>): RowFill[] {
  const out: RowFill[] = [];
  for (const [sheet, list] of rows) {
    for (const r of list) {
      if (r.status === r.excel || generalColourStatus(r.colour) === r.status) continue;
      out.push({
        sheet,
        row: r.ref.row,
        hanzi: r.note.hanzi,
        from: r.colour ?? null,
        fill: STATUS_FILL[r.status],
        key: r.key,
        status: r.status,
        t: r.mark?.t ?? 0,
      });
    }
  }
  return out;
}

/**
 * Write-intent rows for fills about to be uploaded (plan D6): row key → [class before, status written, mark time].
 * Fills without a key (built by older code) are left out.
 */
export function fillsExplained(fills: RowFill[]): Explained {
  const out: Explained = {};
  for (const f of fills) {
    if (f.key == null || f.status == null || typeof f.t !== 'number') continue;
    out[f.key] = [generalColourStatus(f.from), f.status, f.t];
  }
  return out;
}

/**
 * Effective statuses a new word list changed, for the "Excel changed N statuses" notice: notes present in both lists
 * (same id) whose status differs, in the new list's order. `before`/`after` are noteStatuses of the old and new list.
 */
export function statusChanges(before: Map<string, WordStatus>, after: Map<string, WordStatus>, notes: Note[]): StatusChange[] {
  const out: StatusChange[] = [];
  for (const n of [...notes].sort((a, b) => a.order - b.order)) {
    const from = before.get(n.id);
    const to = after.get(n.id);
    if (from && to && from !== to) out.push({ note: n.id, hanzi: n.hanzi, from, to });
  }
  return out;
}
