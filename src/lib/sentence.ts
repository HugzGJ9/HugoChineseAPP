// Chinese lines split into tappable words (plan 2026-11-23-word-panel-v2, D2; first written for Grammar in
// 2026-11-22-grammar-v3, D4). Pure: no storage, no React.
//
// - The browser's word segmentation (Intl.Segmenter, ICU dictionary) gives the first cuts; without it, one character
//   per word.
// - Hugo's own words (`vocabIndex`) are laid over it by longest match, left to right: his words win where boundaries
//   disagree; a one-character word of his only where the segmenter also cuts on both sides.
// - `head` (the word the panel is about) goes first: each occurrence becomes its own token, flagged `head`. It wins over
//   the segmenter and over a longer word of his; a word of his that covers exactly the occurrence lends it its `note`.
// - `pattern` (the fixed characters of a grammar pattern) flags tokens whose characters all belong to it, and splits a
//   segment mixing pattern and other characters.
// - Punctuation and Latin give `word: false` (not tappable).
// Grammar imports these through `lib/grammar/list.ts`, which re-exports them.
import type { Note } from './types';

/** Hugo's words by written form → note id, and the longest form's length. */
export interface VocabIndex {
  forms: Map<string, string>;
  max: number;
}

/** Hugo's words (vocab, measure words, near-synonyms) by written form → note id; longest form first wins. */
export function vocabIndex(notes: Note[]): VocabIndex {
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
  /** An occurrence of the panel's word (`head` option of lineTokens). */
  head?: boolean;
  /** Has Chinese characters, so it can be tapped; punctuation and Latin can't. */
  word: boolean;
}

const HAN_CHAR = /[㐀-鿿\u{20000}-\u{2ffff}]/u;

/** Word segmentation of the browser (ICU dictionary); one character per word without Intl.Segmenter. */
export function browserSegments(zh: string): string[] {
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    return [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(zh)].map((x) => x.segment);
  }
  return [...zh];
}

/** Occurrences of the head forms: Han-only forms, longest first at each position, left to right, no overlaps. */
function headSpans(chars: string[], head: string[]): Map<number, number> {
  const forms = [...new Set(head.map((h) => h.trim()))]
    .map((h) => [...h])
    .filter((h) => h.length > 0 && h.every((c) => HAN_CHAR.test(c)))
    .sort((a, b) => b.length - a.length);
  const spans = new Map<number, number>();
  if (!forms.length) return spans;
  for (let i = 0; i < chars.length; ) {
    const f = forms.find((h) => h.length <= chars.length - i && h.every((c, k) => chars[i + k] === c));
    if (f) {
      spans.set(i, f.length);
      i += f.length;
    } else i++;
  }
  return spans;
}

/**
 * Split a Chinese line into tappable words: the browser's segmentation, Hugo's words over it, the panel's word (`head`)
 * over both (see the header). `segments` replaces the browser segmenter (tests).
 */
export function lineTokens(
  zh: string,
  index: VocabIndex,
  opts: { head?: string[]; pattern?: string; segments?: (s: string) => string[] } = {},
): Token[] {
  const { pattern = '', segments = browserSegments } = opts;
  const chars = [...zh];
  const cut = new Set<number>([0, chars.length]);
  let at = 0;
  for (const seg of segments(zh)) {
    at += [...seg].length;
    cut.add(at);
  }
  const heads = headSpans(chars, opts.head ?? []);
  const headAt: number[] = new Array(chars.length).fill(-1); // start of the occurrence covering each character
  for (const [s, len] of heads) {
    cut.add(s);
    cut.add(s + len);
    for (let k = s; k < s + len; k++) headAt[k] = s;
  }
  // A word of his over [i, i + l) may not cross an occurrence of the head, unless it is exactly that occurrence.
  const fitsHeads = (i: number, l: number) => {
    let clean = true;
    for (let k = i; k < i + l; k++) if (headAt[k] >= 0) clean = false;
    return clean || (headAt[i] === i && heads.get(i) === l);
  };
  // His words, greedy left to right.
  const mine = new Map<number, { len: number; id: string }>();
  for (let i = 0; i < chars.length; ) {
    let found = 0;
    for (let l = Math.min(index.max, chars.length - i); l >= 1; l--) {
      const id = index.forms.get(chars.slice(i, i + l).join(''));
      if (id && (l > 1 || (cut.has(i) && cut.has(i + 1))) && fitsHeads(i, l)) {
        mine.set(i, { len: l, id });
        found = l;
        break;
      }
    }
    i += found || 1;
  }
  const inPattern = (c: string) => HAN_CHAR.test(c) && pattern.includes(c);
  const out: Token[] = [];
  const push = (start: number, end: number, note?: string, head?: boolean) => {
    const s = chars.slice(start, end).join('');
    const han = [...s].filter((c) => HAN_CHAR.test(c));
    out.push({
      s, start, word: han.length > 0,
      ...(note ? { note } : {}),
      ...(han.length && han.every(inPattern) ? { pattern: true } : {}),
      ...(head ? { head: true } : {}),
    });
  };
  let i = 0;
  while (i < chars.length) {
    const h = heads.get(i);
    const m = mine.get(i);
    if (h) {
      push(i, i + h, m?.len === h ? m.id : undefined, true);
      i += h;
      continue;
    }
    if (m) {
      push(i, i + m.len, m.id);
      i += m.len;
      continue;
    }
    // Rest of the segmenter word, stopped at the next word of his (head occurrences are cuts already).
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

/**
 * Split an example sentence into tappable words (D4 of plan 2026-11-22-grammar-v3): `lineTokens` without a head.
 * Pattern characters are flagged; a segment mixing pattern and other characters is split between them.
 */
export function sentenceTokens(
  zh: string,
  index: VocabIndex,
  pattern = '',
  segments: (s: string) => string[] = browserSegments,
): Token[] {
  return lineTokens(zh, index, { pattern, segments });
}

/**
 * Hugo's words whose written forms (hanzi or alts) contain the character `ch`, as note ids in list order (the index
 * keeps the notes' order), each once. The current word is not removed here: the caller filters its own id.
 */
export function vocabWithChar(ch: string, index: Pick<VocabIndex, 'forms'>): string[] {
  const c = ch.trim();
  if (!c) return [];
  const ids = new Set<string>();
  for (const [form, id] of index.forms) if (form.includes(c)) ids.add(id);
  return [...ids];
}

/** Hugo's words that contain `word` or are inside it (学 → 学习, 留学), longest first, at most `max`. */
export function vocabLinks(word: string, index: Pick<VocabIndex, 'forms'>, max = 8): string[] {
  const hits: [string, string][] = [];
  for (const [form, id] of index.forms) {
    if (form !== word && (form.includes(word) || word.includes(form))) hits.push([form, id]);
  }
  hits.sort((a, b) => b[0].length - a[0].length || a[0].localeCompare(b[0]));
  const ids: string[] = [];
  for (const [, id] of hits) if (!ids.includes(id) && ids.push(id) >= max) break;
  return ids;
}
