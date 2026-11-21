// Grammar window types. The content of a grammar point comes from extra columns of Hugo's 语法 sheet
// (plan .claude/plans/2026-11-21-grammar-content.md, decision GRAM-1): it is part of the Note, imported like the rest.

/** Families group grammar points by what they do. Ids are stored in the notes; names live in families.ts. */
export type FamilyId = 'condition' | 'time' | 'formal' | 'complement' | 'emphasis' | 'compare' | 'phrase';

/** HSK level. 7 stands for the 7–9 band of HSK 3.0. */
export type HskLevel = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export type Register = 'spoken' | 'neutral' | 'formal' | 'written';

export interface GrammarSentence {
  zh: string;
  pinyin?: string;
  fr?: string;
  en?: string;
}

/**
 * What the 语法 sheet's extra columns say about a point (Note.grammar). Every field is optional: a row with none of the
 * columns has no `grammar` at all. Additive to the Note (SYNC-2): older app versions ignore it.
 */
export interface GrammarInfo {
  hsk?: HskLevel;
  family?: FamilyId;
  /** Short list titles ("Title EN" / "Title FR"). */
  title?: { en?: string; fr?: string };
  /** One-line definitions ("Definition EN" / "Definition FR"). */
  def?: { en?: string; fr?: string };
  /** "When to use" bullets, one per line in Excel ("Use EN" / "Use FR"). */
  use?: { en?: string[]; fr?: string[] };
  register?: Register;
  /** "Sentences": one per line, `中文 | français | English`; pinyin added at import. */
  sentences?: GrammarSentence[];
}

/** Title language of the list: hanzi pattern, French or English. */
export type TitleLang = 'zh' | 'fr' | 'en';

/** How the list is grouped. */
export type GroupBy = 'family' | 'hsk' | 'excel';
