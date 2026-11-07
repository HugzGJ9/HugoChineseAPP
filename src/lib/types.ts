export type NoteKind = 'vocab' | 'grammar' | 'measure' | 'synonym';

export interface Example {
  zh: string;
  pinyin?: string;
  en?: string;
}

export interface SourceRef {
  sheet: string;
  row: number;
  /** ID cell as written (233, 233bis…). */
  id?: string;
}

/** One thing to learn, built from one or more Excel rows. */
export interface Note {
  /** kind + hanzi + toneless pinyin, e.g. v:学习|xuexi */
  id: string;
  kind: NoteKind;
  /** Word, grammar pattern or classifier. */
  hanzi: string;
  /** Other forms written in the same cell (捡 捡起, 使劲/使劲儿). Accepted as answers. */
  alts: string[];
  /** Display pinyin with tone marks. */
  pinyin: string;
  /** Numbered syllables, space separated (xue2 xi2). Neutral tone = 5. */
  pinyinNum: string;
  /** Numbered pinyin of the alternative forms, when the cell gives it. */
  altPinyin?: string[];
  /** Meaning as written in Excel (English for vocab; French for measure words). */
  en: string;
  /** French from Excel (a French column, or a French-language sheet). */
  fr?: string;
  /** French from CFDICT, used when Excel has none. */
  frAuto?: string;
  notes: string[];
  tags: string[];
  refs: SourceRef[];
  order: number;
  /** Row coloured green in Excel = already studied. */
  studied: boolean;
  /** Fill colour of the row in Excel, if any (RRGGBB). */
  colour?: string;
  examples: Example[];
  /** Related-words group (233, 233bis, 233ter… on the same sheet). */
  group?: string;
  /** Near-synonym set (Suddently sheet). */
  set?: string;
  extra?: Record<string, string>;
}

export type CardType = 'recog' | 'recall' | 'listen' | 'grammar' | 'measure' | 'synonym';

export type Grade = 1 | 2 | 3 | 4;

export interface ReviewEvent {
  id: string;
  card: string;
  r: Grade;
  /** Review time, ms. */
  t: number;
  /** Time spent, ms. */
  d: number;
  /** Answer mode: reveal, type-pinyin, type-hanzi, type-meaning, write-guided, write-free, choice, build, quick. */
  m: string;
  dev: string;
  /** Month (YYYY-MM) of the sync file the event belongs to. Local only, never written into sync files. */
  mo?: string;
}

/** Scheduling state of one card, derived from the note and its review events. */
export interface CardState {
  id: string;
  note: string;
  type: CardType;
  due: number;
  stability: number;
  difficulty: number;
  scheduledDays: number;
  learningSteps: number;
  reps: number;
  lapses: number;
  /** 0 new, 1 learning, 2 review, 3 relearning (ts-fsrs State). */
  state: 0 | 1 | 2 | 3;
  last: number;
  nEvents: number;
  first?: number;
  seeded?: boolean;
  /** Sibling card not unlocked yet (recall/listen before the word was first seen). */
  locked?: boolean;
}

export interface ImportIssue {
  level: 'fix' | 'info';
  sheet: string;
  row: number;
  /** Column letter of the cell concerned. */
  col?: string;
  hanzi?: string;
  problem: string;
  suggestion?: string;
}

export interface SheetReport {
  name: string;
  kind: NoteKind | 'skipped';
  rows: number;
  notes: number;
  studied: number;
  colours: Record<string, number>;
}

export interface VocabFile {
  version: 1;
  /** Old note id → new note id, for words renamed in Excel (history follows the word). */
  aliases?: Record<string, string>;
  importedAt: number;
  /** Device that imported the file. */
  device?: string;
  source: { name: string; modified: number; size: number };
  /** Hash of the notes, to tell whether anything changed. */
  hash: string;
  notes: Note[];
  issues: ImportIssue[];
  /** noteId → time the word was first imported as green. Keeps seeding identical on every device. */
  seeds: Record<string, number>;
  report: SheetReport[];
}

/** An import held back because it looks broken (many words gone, a sheet skipped). */
export interface PendingImport {
  vocab: VocabFile;
  reasons: string[];
  prevCount: number;
}
