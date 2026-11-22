// Pure helpers for the Grammar window: one item per grammar note, texts in the reading language (EN | FR, GRAM-2),
// search, the pattern split into fixed words and slots, and example sentences split into tappable words with Hugo's own
// words laid over them. No storage, no React.
import type { Note } from '../types';
import { family, hskLabel } from './families';
import type { FamilyId, GrammarInfo, HskLevel, ReadLang } from './types';

export interface GrammarItem {
  note: Note;
  info: GrammarInfo;
  hsk?: HskLevel;
  family?: FamilyId;
}

export function grammarItems(notes: Note[]): GrammarItem[] {
  return notes
    .filter((n) => n.kind === 'grammar')
    .sort((a, b) => a.order - b.order)
    .map((note) => {
      const info = note.grammar ?? {};
      return { note, info, hsk: info.hsk, family: info.family };
    });
}

/**
 * A text in the reading language. `fallback` names the language actually shown when the chosen one is missing, so the
 * screen can tag it; undefined when there is nothing in either language.
 */
export function pick(pair: { en?: string; fr?: string } | undefined, lang: ReadLang): { text: string; fallback?: ReadLang } | undefined {
  const other: ReadLang = lang === 'fr' ? 'en' : 'fr';
  if (pair?.[lang]) return { text: pair[lang]! };
  if (pair?.[other]) return { text: pair[other]!, fallback: other };
  return undefined;
}

/** "When to use" bullets in the reading language, or the other one, tagged. */
export function pickList(pair: { en?: string[]; fr?: string[] } | undefined, lang: ReadLang): { items: string[]; fallback?: ReadLang } {
  const other: ReadLang = lang === 'fr' ? 'en' : 'fr';
  if (pair?.[lang]?.length) return { items: pair[lang]! };
  if (pair?.[other]?.length) return { items: pair[other]!, fallback: other };
  return { items: [] };
}

/**
 * Short title in the reading language: the Title column, then the Excel meaning (French column or the English cell).
 * `fallback` is set when the text is in the other language.
 */
export function itemTitle(item: GrammarItem, lang: ReadLang): { text: string; fallback?: ReadLang } {
  const { note, info } = item;
  const t = pick({ en: info.title?.en || note.en, fr: info.title?.fr || note.fr }, lang);
  return t ?? { text: '' };
}

/** Lower case, accents and punctuation folded, so "regle" finds "règle" and "as soon" finds "As soon as". */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s,.;:!?()（）、，。…/+'"«»-]+/g, ' ')
    .trim();
}

/** Search across the pattern, examples, titles, definitions, the Excel meaning, the family and the HSK level. */
export function matchItem(item: GrammarItem, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const { note, info } = item;
  if (/[㐀-鿿]/.test(q)) {
    const han = q.replace(/[^㐀-鿿]/g, '');
    const hay = [note.hanzi, ...note.alts, ...note.examples.map((e) => e.zh), ...(info.sentences ?? []).map((e) => e.zh)].join(' ');
    return [...han].every((c) => hay.includes(c));
  }
  const fam = family(item.family);
  const hay = fold(
    [note.en, note.fr ?? '', info.title?.en ?? '', info.title?.fr ?? '', info.def?.en ?? '', info.def?.fr ?? '', fam?.en ?? '', fam?.fr ?? '', item.hsk ? hskLabel(item.hsk) : ''].join(' | '),
  );
  return fold(q)
    .split(' ')
    .every((w) => hay.includes(w));
}

export type FormulaPart = { t: 'fixed'; s: string } | { t: 'slot'; s: string } | { t: 'gap' };

/**
 * Split a pattern into fixed Chinese, slots and gaps, for display:
 * "除非A，才（会/能）B" → 除非 · [A] · ，才（会/能） · [B];  "V+得/不+上" → [V] · 得/不上.
 * Latin runs (A, B, S, SB, V, Verb, Time/Event, Question W…) are slots; "+" only joins; "…", "...", "。。。" are gaps.
 * Square brackets mark a slot explicitly and win over the Latin rule.
 */
export function formulaParts(pattern: string): FormulaPart[] {
  const out: FormulaPart[] = [];
  const push = (p: FormulaPart) => {
    const last = out[out.length - 1];
    if (p.t === 'fixed' && last?.t === 'fixed') last.s += p.s;
    else if (p.t === 'gap' && last?.t === 'gap') return;
    else out.push(p);
  };
  const re = /\[([^\]]+)\]|(…+|\.{2,}|。{2,})|([A-Za-z][A-Za-z /]*[A-Za-z]|[A-Za-z])|(\s*\+\s*)|(\s+)|([^[A-Za-z+….。\s]+|[.。])/g;
  for (const m of pattern.trim().matchAll(re)) {
    if (m[1]) push({ t: 'slot', s: m[1].trim() });
    else if (m[2]) push({ t: 'gap' });
    else if (m[3]) push({ t: 'slot', s: m[3].trim() });
    else if (m[4] || m[5]) continue;
    else if (m[6]) push({ t: 'fixed', s: m[6] });
  }
  return out;
}

export type Segment = { s: string; note?: string };

/** Hugo's words (vocab, measure words, near-synonyms) by written form → note id; longest form first wins. */
export function vocabIndex(notes: Note[]): { forms: Map<string, string>; max: number } {
  const forms = new Map<string, string>();
  let max = 1;
  for (const n of notes) {
    if (n.kind === 'grammar') continue;
    for (const f of [n.hanzi, ...n.alts]) {
      if (!/^[㐀-鿿]+$/.test(f) || forms.has(f)) continue;
      forms.set(f, n.id);
      max = Math.max(max, f.length);
    }
  }
  return { forms, max };
}

export interface Token {
  s: string;
  /** Offset of the token in the sentence, in characters (code points). */
  start: number;
  /** Hugo's word (note id) when the token is one of his words. */
  note?: string;
  /** Every character belongs to the grammar pattern itself (就 in an 一…就 example). */
  pattern?: boolean;
  /** Has Chinese characters, so it can be tapped; punctuation and Latin can't. */
  word: boolean;
}

const HAN_CHAR = /[\u3400-\u9fff]/;

/** Word segmentation of the browser (ICU dictionary); one character per word without Intl.Segmenter. */
export function browserSegments(zh: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(zh)].map((x) => x.segment);
  }
  return [...zh];
}

/** The fixed Chinese characters of a pattern and its alternative forms (除非A，才B → 除非才). */
export function patternChars(note: Pick<Note, 'hanzi' | 'alts'>): string {
  return [note.hanzi, ...note.alts]
    .flatMap((p) => formulaParts(p))
    .map((p) => (p.t === 'fixed' ? p.s : ''))
    .join('')
    .replace(/[^\u3400-\u9fff]/g, '');
}

/**
 * Split an example sentence into tappable words (D4 of plan 2026-11-22-grammar-v3): the browser's segmentation, with
 * Hugo's own words laid over it by longest match (his words win where boundaries disagree; a one-character word of his
 * only where the segmenter also cuts there). Pattern characters are flagged; a segment mixing pattern and other
 * characters is split between them.
 */
export function sentenceTokens(
  zh: string,
  index: { forms: Map<string, string>; max: number },
  pattern = '',
  segments: (s: string) => string[] = browserSegments,
): Token[] {
  const chars = [...zh];
  const cut = new Set<number>([0, chars.length]);
  let at = 0;
  for (const seg of segments(zh)) {
    at += [...seg].length;
    cut.add(at);
  }
  // His words, greedy left to right.
  const mine = new Map<number, { len: number; id: string }>();
  for (let i = 0; i < chars.length; ) {
    let found = 0;
    for (let l = Math.min(index.max, chars.length - i); l >= 1; l--) {
      const id = index.forms.get(chars.slice(i, i + l).join(''));
      if (id && (l > 1 || (cut.has(i) && cut.has(i + 1)))) {
        mine.set(i, { len: l, id });
        found = l;
        break;
      }
    }
    i += found || 1;
  }
  const inPattern = (c: string) => HAN_CHAR.test(c) && pattern.includes(c);
  const out: Token[] = [];
  const push = (start: number, end: number, note?: string) => {
    const s = chars.slice(start, end).join('');
    const han = [...s].filter((c) => HAN_CHAR.test(c));
    out.push({
      s, start, word: han.length > 0,
      ...(note ? { note } : {}),
      ...(han.length && han.every(inPattern) ? { pattern: true } : {}),
    });
  };
  let i = 0;
  while (i < chars.length) {
    const m = mine.get(i);
    if (m) {
      push(i, i + m.len, m.id);
      i += m.len;
      continue;
    }
    // Rest of the segmenter word, stopped at the next word of his.
    let end = i + 1;
    while (end < chars.length && !cut.has(end) && !mine.has(end)) end++;
    // Split runs of pattern / non-pattern characters inside a segment.
    let s = i;
    for (let k = i + 1; k <= end; k++) {
      if (k === end || inPattern(chars[k]) !== inPattern(chars[k - 1]) || !HAN_CHAR.test(chars[k]) !== !HAN_CHAR.test(chars[k - 1])) {
        push(s, k);
        s = k;
      }
    }
    i = end;
  }
  return out;
}

/** Hugo's words that contain `word` or are inside it (学 → 学习, 留学), longest first, at most `max`. */
export function vocabLinks(word: string, index: { forms: Map<string, string> }, max = 8): string[] {
  const hits: [string, string][] = [];
  for (const [form, id] of index.forms) {
    if (form !== word && (form.includes(word) || word.includes(form))) hits.push([form, id]);
  }
  hits.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  const ids: string[] = [];
  for (const [, id] of hits) if (!ids.includes(id) && ids.push(id) >= max) break;
  return ids;
}
