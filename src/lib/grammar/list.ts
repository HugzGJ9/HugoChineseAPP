// Pure helpers for the Grammar window: one item per grammar note, titles in 中/FR/EN, search, grouping, the pattern
// split into fixed words and slots, and example sentences split on Hugo's vocabulary. No storage, no React.
import type { Note } from '../types';
import { family, FAMILIES, hskLabel, HSK_LEVELS } from './families';
import type { FamilyId, GrammarInfo, GroupBy, HskLevel, TitleLang } from './types';

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

/** Title in the chosen language. `fallback` is true when that language is missing and another is shown. */
export function itemTitle(item: GrammarItem, lang: TitleLang): { text: string; fallback: boolean } {
  const { note, info } = item;
  if (lang === 'zh') return { text: note.hanzi, fallback: false };
  if (lang === 'fr') {
    const fr = info.title?.fr || note.fr;
    if (fr) return { text: fr, fallback: false };
  }
  const en = info.title?.en || note.en;
  return en ? { text: en, fallback: lang === 'fr' } : { text: note.hanzi, fallback: true };
}

/** The line under the title: the pattern when the title is a translation; the French or English title under 中. */
export function itemSubtitle(item: GrammarItem, lang: TitleLang): string {
  if (lang !== 'zh') return item.note.hanzi;
  return item.info.title?.fr || item.info.title?.en || item.note.en;
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

export interface ItemGroup {
  key: string;
  title: string;
  items: GrammarItem[];
}

/** Groups in display order; points without the label go last. 'excel' is one group in sheet order. */
export function groupItems(items: GrammarItem[], by: GroupBy, lang: TitleLang): ItemGroup[] {
  if (by === 'excel') return items.length ? [{ key: 'all', title: '语法', items }] : [];
  const groups: ItemGroup[] =
    by === 'family'
      ? FAMILIES.map((f) => ({ key: f.id, title: lang === 'fr' ? f.fr : lang === 'zh' ? `${f.zh} · ${f.en}` : f.en, items: items.filter((i) => i.family === f.id) }))
      : HSK_LEVELS.map((h) => ({ key: `hsk${h}`, title: hskLabel(h), items: items.filter((i) => i.hsk === h) }));
  const none = items.filter((i) => (by === 'family' ? !i.family : !i.hsk));
  groups.push({ key: 'none', title: lang === 'fr' ? (by === 'family' ? 'Sans famille' : 'Sans niveau') : by === 'family' ? 'No family' : 'No level', items: none });
  return groups.filter((g) => g.items.length);
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

/**
 * Split a sentence into Hugo's words and the rest, greedy longest match. Single characters that belong to the grammar
 * pattern itself (`skip`) are not marked, so 就 in an 一…就 example stays plain.
 */
export function segmentSentence(zh: string, index: { forms: Map<string, string>; max: number }, skip = ''): Segment[] {
  const out: Segment[] = [];
  const plain = (c: string) => {
    const last = out[out.length - 1];
    if (last && !last.note) last.s += c;
    else out.push({ s: c });
  };
  const chars = [...zh];
  let i = 0;
  while (i < chars.length) {
    let hit: string | undefined;
    let len = 0;
    for (let l = Math.min(index.max, chars.length - i); l >= 1; l--) {
      const w = chars.slice(i, i + l).join('');
      const id = index.forms.get(w);
      if (id && !(l === 1 && skip.includes(w))) {
        hit = id;
        len = l;
        break;
      }
    }
    if (hit) {
      out.push({ s: chars.slice(i, i + len).join(''), note: hit });
      i += len;
    } else {
      plain(chars[i]);
      i += 1;
    }
  }
  return out;
}
