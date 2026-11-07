// Explanations of a word by Claude, cached per (note, language) and synced in explain/<device>/<YYYY-MM>.json.gz.

/** Claude's structured explanation of one word or grammar point (the tool input, normalised). */
export interface Explanation {
  /** Precise meaning, 1–3 sentences. */
  summary: string;
  /** How his own meaning compares (only when it is off or incomplete). */
  check?: string;
  /** 1–4 senses, common first. */
  senses: { meaning: string; pos?: string; note?: string }[];
  register: string;
  /** 0–4 near-synonyms. */
  nuance: { word: string; pinyin: string; diff: string }[];
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
