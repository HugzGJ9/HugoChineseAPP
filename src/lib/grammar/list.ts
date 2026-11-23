// Pure helpers for the Grammar window: one item per grammar note, texts in the reading language (EN | FR, GRAM-2),
// search, and the pattern split into fixed words and slots. The sentence tokenizer moved to ../sentence.ts (plan
// 2026-11-23-word-panel-v2, D2) and is re-exported here, so Grammar's imports don't change. No storage, no React.
import type { Note } from '../types';
import { family, hskLabel } from './families';
import type { FamilyId, GrammarInfo, HskLevel, ReadLang } from './types';

export { browserSegments, sentenceTokens, vocabIndex, vocabLinks, type Token, type VocabIndex } from '../sentence';

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

/** The fixed Chinese characters of a pattern and its alternative forms (除非A，才B → 除非才). */
export function patternChars(note: Pick<Note, 'hanzi' | 'alts'>): string {
  return [note.hanzi, ...note.alts]
    .flatMap((p) => formulaParts(p))
    .map((p) => (p.t === 'fixed' ? p.s : ''))
    .join('')
    .replace(/[^\u3400-\u9fff]/g, '');
}
