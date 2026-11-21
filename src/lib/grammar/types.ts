// Grammar window: labels (HSK level, family) and lessons for the notes of kind 'grammar' (the 语法 sheet).
// Plan: .claude/plans/2026-11-20-grammar-window.md. Skeleton: shapes are not stored or synced yet (see store.ts).

/** Families group grammar points by what they do. Ids are stable (stored); labels live in families.ts. */
export type FamilyId =
  | 'condition' // 只有…才, 只要…就, 除非…才, 万一, 要是…就好了, 一…就
  | 'time' // 以后, 之后, 直到…才, 从头, 从…说起
  | 'formal' // 于, 位于, 对于, 至于, 根据…来, 用…来, 为…而, 在…看来
  | 'complement' // V得/不上, V得/不了, V上, V见
  | 'emphasis' // 绝不, 简直, 非…不可, 凡是…都
  | 'compare' // 不如, 之一, 相对来说, 一致, 分别, 也就是说, 把A叫作B
  | 'phrase'; // 跟…交往, 对…不离不弃, 就可以了

/** HSK level. 7 stands for the 7–9 band of HSK 3.0. */
export type HskLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

/** Labels of one grammar point. Claude suggests them; a value Hugo set (src 'hugo') is never replaced by a suggestion. */
export interface GrammarLabel {
  hsk?: HskLevel;
  family?: FamilyId;
  src: 'claude' | 'hugo';
  /** Last change, ms. */
  at: number;
}

/** Text in both of Hugo's reading languages. */
export interface Bi {
  fr: string;
  en: string;
}

/** Claude's lesson for one grammar point, generated once in French and English together. */
export interface GrammarLesson {
  /** Short title for the list ("Unless A, then B"). */
  title: Bi;
  /** The pattern rewritten with clean slots: `除非 [A]，才 [B]`. Slots are in square brackets. */
  formula: string;
  /** What it means and when it is used, 1–3 sentences. */
  meaning: Bi;
  register: 'spoken' | 'neutral' | 'formal' | 'written';
  /** Usage rules, 1–4. */
  rules: Bi[];
  tip?: Bi;
  /** 3–5, built from HSK 1–5 vocabulary. */
  examples: { zh: string; pinyin: string; fr: string; en: string }[];
  /** 0–3. */
  mistakes: { wrong: string; right: string; why: Bi }[];
  /** Confusable or related points (other rows of the sheet when possible), 0–4. */
  related: { pattern: string; diff: Bi }[];
  /** Problems Claude spotted in the Excel row (typo in the example, half-finished example). Shown, never applied. */
  excelNotes?: { field: 'pattern' | 'meaning' | 'example'; text: string; suggestion?: string }[];
  /** Claude's label suggestion, made with the lesson. */
  suggested?: { hsk?: HskLevel; family?: FamilyId };
}

/** One saved lesson. */
export interface LessonEntry {
  /** Note id. */
  k: string;
  /** Creation time, ms. Newest wins per key. */
  at: number;
  model: string;
  /** Prompt version. */
  pv: number;
  x: GrammarLesson;
}

/** Title language of the list: hanzi pattern, French or English. */
export type TitleLang = 'zh' | 'fr' | 'en';

/** How the list is grouped. */
export type GroupBy = 'family' | 'hsk' | 'excel';
