// Explanations of a word by Claude, cached per (note, language) and synced in explain/<device>/<YYYY-MM>.json.gz.

/** A Chinese line with its pinyin and translation. */
export interface ZhItem {
  zh: string;
  pinyin: string;
  tr: string;
}

/** A word learners mix up with this one (prompt v2). */
export interface ConfuseItem {
  word: string;
  pinyin: string;
  /** When to use which: meaning, context, register, typical collocations or grammar; 1–3 sentences. */
  use: string;
  /** Contrasting pair in similar situations: a sentence with the headword, one with the other word. */
  self?: ZhItem;
  other?: ZhItem;
}

/**
 * Claude's structured explanation of one word or grammar point (the tool input, normalised).
 * Prompt v2 asks for `confuse` instead of `nuance`; `nuance` is then filled from `confuse` so that older app versions,
 * which only know `nuance`, still show the close words (word-panel-v2 D10).
 */
export interface Explanation {
  /** Precise meaning, 1–3 sentences. */
  summary: string;
  /** How his own meaning compares (only when it is off or incomplete). */
  check?: string;
  /** 1–4 senses, common first. */
  senses: { meaning: string; pos?: string; note?: string }[];
  register: string;
  /** 0–4 near-synonyms. Prompt v2: filled from `confuse` (diff = use) when the answer has none. */
  nuance: { word: string; pinyin: string; diff: string }[];
  /** Prompt v2: 0–4 words not to confuse with, kept even when empty; absent in v1 entries. */
  confuse?: ConfuseItem[];
  /** 3–8. */
  collocations: { zh: string; pinyin: string; tr: string }[];
  /** 0–4. */
  patterns: { pattern: string; tr: string; example?: { zh: string; pinyin: string; tr: string } }[];
  /** 0–3. */
  mistakes: { wrong?: string; right?: string; why: string }[];
  /** 5 (at least 3 after validation). */
  examples: { zh: string; pinyin: string; tr: string }[];
}

/** One saved explanation, as written into the sync file. */
export interface ExplainEntry {
  /** `${note.id}|${lang}` */
  k: string;
  hz: string;
  py: string;
  lang: 'en' | 'fr';
  /** Creation time, ms. The newest wins per key. */
  at: number;
  model: string;
  /** Prompt version. */
  pv: number;
  /** Input and output tokens. */
  u?: [number, number];
  x: Explanation;
}

/** How an entry is stored in kv `ex:<k>`: plus the device that made it, its month (frozen) and whether it is ours. */
export type StoredEntry = ExplainEntry & { dev: string; mo: string; own?: true };

export type ClaudeErrorKind = 'nokey' | 'offline' | 'key' | 'credit' | 'model' | 'rate' | 'busy' | 'network' | 'timeout' | 'invalid' | 'other';
