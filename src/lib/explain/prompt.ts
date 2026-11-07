// What Claude is asked, and how its answer is checked. Pure: no network, no database.
import type { Note } from '../types';
import type { Lang } from '../store';
import type { Explanation } from './types';

/** Bumped when the prompt or the schema changes in a way that makes older explanations worth asking again. */
export const PROMPT_VERSION = 1;
export const TOOL_NAME = 'word_explanation';

const LANG_NAME: Record<Lang, string> = { en: 'English', fr: 'French' };

export function systemPrompt(lang: Lang): string {
  const L = LANG_NAME[lang];
  return [
    'You explain Chinese words to Hugo, a native French speaker at HSK 4–5 level who learns simplified Mandarin from his own vocabulary list.',
    `Answer only by calling the ${TOOL_NAME} tool. Write every explanation and translation in ${L}.`,
    'Pinyin uses tone marks, with words separated by spaces, and matches the Chinese sentence exactly.',
    'Precision matters more than breadth.',
    '- summary: the precise meaning in 1–3 sentences.',
    '- senses: the common senses first, at most 4. Say which sense his own meaning refers to.',
    '- check: only when his meaning is wrong, too broad or misses a common use; otherwise leave it out.',
    '- register: one line (spoken, written, formal, neutral, slang, regional…).',
    '- nuance: up to 4 near-synonyms, each with how it differs.',
    '- collocations: 3–8 frequent combinations.',
    '- patterns: 0–4 sentence structures built on the word, each with an example.',
    '- mistakes: 0–3 typical errors of French or English speakers. Never invent mistakes to fill the list.',
    '- examples: exactly 5 natural sentences of 8–20 characters, each showing a different use, mostly with HSK 1–5 words.',
    'For a grammar point, explain the structure, and use nuance for similar structures.',
    'Never invent usages. Say so when you are unsure or when a use is regional.',
  ].join('\n');
}

const zhItem = {
  type: 'object',
  properties: { zh: { type: 'string' }, pinyin: { type: 'string' }, tr: { type: 'string', description: 'Translation' } },
  required: ['zh', 'pinyin', 'tr'],
};

/** JSON schema of the tool input (= Explanation). */
export const INPUT_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'Precise meaning, 1–3 sentences' },
    check: { type: 'string', description: "How his own meaning compares; only if it is wrong, too broad or incomplete" },
    senses: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: { meaning: { type: 'string' }, pos: { type: 'string', description: 'Part of speech' }, note: { type: 'string' } },
        required: ['meaning'],
      },
    },
    register: { type: 'string', description: 'One line' },
    nuance: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: { word: { type: 'string' }, pinyin: { type: 'string' }, diff: { type: 'string', description: 'How it differs' } },
        required: ['word', 'pinyin', 'diff'],
      },
    },
    collocations: { type: 'array', minItems: 3, maxItems: 8, items: zhItem },
    patterns: {
      type: 'array',
      maxItems: 4,
      items: {
        type: 'object',
        properties: { pattern: { type: 'string' }, tr: { type: 'string' }, example: zhItem },
        required: ['pattern', 'tr'],
      },
    },
    mistakes: {
      type: 'array',
      maxItems: 3,
      items: {
        type: 'object',
        properties: { wrong: { type: 'string' }, right: { type: 'string' }, why: { type: 'string' } },
        required: ['why'],
      },
    },
    examples: { type: 'array', minItems: 5, maxItems: 5, items: zhItem },
  },
  required: ['summary', 'senses', 'register', 'nuance', 'collocations', 'patterns', 'mistakes', 'examples'],
} as const;

export const TOOL = {
  name: TOOL_NAME,
  description: 'Record the explanation of the word for Hugo.',
  input_schema: INPUT_SCHEMA,
};

const KIND: Record<Note['kind'], string> = {
  vocab: 'vocabulary word',
  grammar: 'grammar point',
  measure: 'measure word',
  synonym: 'word from a set of near-synonyms',
};

export interface PromptContext {
  /** Dictionary line from the lexicon (sensesText), when available. */
  dict?: string;
  /** Hanzi of related words he is learning (same group or set). */
  related?: string[];
}

const q = (s: string) => `"${s.replace(/\s+/g, ' ').trim()}"`;

export function buildUserPrompt(note: Note, lang: Lang, ctx: PromptContext = {}): string {
  const lines: string[] = [];
  const sheet = note.refs[0]?.sheet;
  lines.push(`Word: ${note.hanzi}${note.pinyin ? ` (${note.pinyin})` : ''}, ${KIND[note.kind] ?? 'word'}${sheet ? `, sheet ${sheet}` : ''}`);
  if (note.alts.length) lines.push(`Other forms: ${note.alts.join(', ')}`);
  const mine: string[] = [];
  if (note.en.trim()) mine.push(`${q(note.en)} (EN, his list)`);
  if (note.fr?.trim()) mine.push(`${q(note.fr)} (FR, his list)`);
  else if (note.frAuto?.trim()) mine.push(`${q(note.frAuto)} (FR, from CFDICT)`);
  if (mine.length) lines.push(`His meaning: ${mine.join(' / ')}`);
  if (note.notes.length) lines.push(`His notes: ${note.notes.slice(0, 3).join(' · ')}`);
  if (ctx.dict?.trim()) lines.push(`Dictionary (CC-CEDICT): ${ctx.dict.trim()}`);
  const related = (ctx.related ?? []).filter((h) => h && h !== note.hanzi).slice(0, 6);
  if (related.length) lines.push(`Related words he is learning: ${related.join(', ')}`);
  for (const ex of note.examples.slice(0, 2)) {
    const tr = ex.en?.trim() ? ` — ${ex.en.trim()}` : '';
    lines.push(`His example: ${ex.zh}${ex.pinyin ? ` (${ex.pinyin})` : ''}${tr}`);
  }
  lines.push(`Answer in ${LANG_NAME[lang]}.`);
  return lines.join('\n');
}

// ---------- checking the answer ----------

const HAN = /\p{Script=Han}/u;
const MAX_TEXT = 1200;

const str = (v: unknown, max = MAX_TEXT): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const opt = (v: unknown, max = MAX_TEXT): string | undefined => str(v, max) || undefined;
const list = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object' && !Array.isArray(x)) as Record<string, unknown>[]) : [];

function zhItemOf(o: Record<string, unknown>): { zh: string; pinyin: string; tr: string } | null {
  const zh = str(o.zh, 200);
  if (!zh) return null;
  return { zh, pinyin: str(o.pinyin, 400), tr: str(o.tr, 600) };
}

function compact<T>(xs: (T | null)[], cap: number): T[] {
  return xs.filter((x): x is T => x != null).slice(0, cap);
}

/** Clean Claude's tool input: trimmed strings, capped lists. Null when it has no summary or fewer than 3 Chinese examples. */
export function normalizeExplanation(input: unknown): Explanation | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const o = input as Record<string, unknown>;
  const summary = str(o.summary);
  const examples = compact(
    list(o.examples).map((e) => {
      const x = zhItemOf(e);
      return x && HAN.test(x.zh) ? x : null;
    }),
    5,
  );
  if (!summary || examples.length < 3) return null;
  const x: Explanation = {
    summary,
    senses: compact(
      list(o.senses).map((s) => {
        const meaning = str(s.meaning);
        return meaning ? { meaning, ...(opt(s.pos, 60) ? { pos: opt(s.pos, 60) } : {}), ...(opt(s.note) ? { note: opt(s.note) } : {}) } : null;
      }),
      4,
    ),
    register: str(o.register, 400),
    nuance: compact(
      list(o.nuance).map((n) => {
        const word = str(n.word, 60);
        const diff = str(n.diff);
        return word && diff ? { word, pinyin: str(n.pinyin, 200), diff } : null;
      }),
      4,
    ),
    collocations: compact(list(o.collocations).map(zhItemOf), 8),
    patterns: compact(
      list(o.patterns).map((p) => {
        const pattern = str(p.pattern, 200);
        if (!pattern) return null;
        const ex = p.example && typeof p.example === 'object' ? zhItemOf(p.example as Record<string, unknown>) : null;
        return { pattern, tr: str(p.tr), ...(ex ? { example: ex } : {}) };
      }),
      4,
    ),
    mistakes: compact(
      list(o.mistakes).map((m) => {
        const why = str(m.why);
        if (!why) return null;
        const wrong = opt(m.wrong, 300);
        const right = opt(m.right, 300);
        return { ...(wrong ? { wrong } : {}), ...(right ? { right } : {}), why };
      }),
      3,
    ),
    examples,
  };
  const check = opt(o.check);
  if (check) x.check = check;
  return x;
}
