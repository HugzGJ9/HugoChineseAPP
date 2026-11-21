// Pure helpers for the Grammar window: one item per grammar note, titles in 中/FR/EN, search, grouping,
// and the pattern split into fixed words and slots. No storage, no React.
import type { Note } from '../types';
import { family, FAMILIES, hskLabel, HSK_LEVELS } from './families';
import type { FamilyId, GrammarLabel, GroupBy, HskLevel, LessonEntry, TitleLang } from './types';

export interface GrammarItem {
  note: Note;
  label?: GrammarLabel;
  lesson?: LessonEntry;
  /** Effective labels: Hugo's or Claude's label, else the lesson's suggestion. */
  hsk?: HskLevel;
  family?: FamilyId;
}

export function grammarItems(notes: Note[], labels: ReadonlyMap<string, GrammarLabel>, lessons: ReadonlyMap<string, LessonEntry>): GrammarItem[] {
  return notes
    .filter((n) => n.kind === 'grammar')
    .sort((a, b) => a.order - b.order)
    .map((note) => {
      const label = labels.get(note.id);
      const lesson = lessons.get(note.id);
      const sug = lesson?.x.suggested;
      return { note, label, lesson, hsk: label?.hsk ?? sug?.hsk, family: label?.family ?? sug?.family };
    });
}

/** Title in the chosen language. `fallback` is true when the language is missing and English (or the pattern) is shown. */
export function itemTitle(item: GrammarItem, lang: TitleLang): { text: string; fallback: boolean } {
  const { note, lesson } = item;
  if (lang === 'zh') return { text: note.hanzi, fallback: false };
  if (lang === 'fr') {
    const fr = lesson?.x.title.fr || note.fr;
    if (fr) return { text: fr, fallback: false };
  }
  const en = lesson?.x.title.en || note.en;
  return en ? { text: en, fallback: lang === 'fr' } : { text: note.hanzi, fallback: true };
}

/** The line under the title: the pattern when the title is a translation, else the meaning. */
export function itemSubtitle(item: GrammarItem, lang: TitleLang): string {
  if (lang !== 'zh') return item.note.hanzi;
  return item.lesson?.x.title.en || item.note.en;
}

/** Lower case, accents and punctuation folded, so "regle" finds "règle" and "as soon" finds "As soon as". */
export function fold(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s,.;:!?()（）、，。…/+'"-]+/g, ' ')
    .trim();
}

/** Search across the pattern, its alternative forms, English, French, lesson titles and the family names. */
export function matchItem(item: GrammarItem, query: string): boolean {
  const q = query.trim();
  if (!q) return true;
  const { note, lesson } = item;
  if (/[㐀-鿿]/.test(q)) {
    const han = q.replace(/[^㐀-鿿]/g, '');
    const hay = [note.hanzi, ...note.alts, ...note.examples.map((e) => e.zh), ...(lesson?.x.examples.map((e) => e.zh) ?? [])].join(' ');
    return [...han].every((c) => hay.includes(c));
  }
  const fq = fold(q);
  const fam = family(item.family);
  const hay = fold([note.en, note.fr ?? '', lesson?.x.title.en ?? '', lesson?.x.title.fr ?? '', fam?.en ?? '', fam?.fr ?? '', item.hsk ? hskLabel(item.hsk) : ''].join(' | '));
  return fq.split(' ').every((w) => hay.includes(w));
}

export interface ItemGroup {
  key: string;
  title: string;
  items: GrammarItem[];
}

/** Groups in display order; unlabelled points go last. 'excel' is one group in sheet order. */
export function groupItems(items: GrammarItem[], by: GroupBy, lang: TitleLang): ItemGroup[] {
  if (by === 'excel') return items.length ? [{ key: 'all', title: '语法', items }] : [];
  const groups: ItemGroup[] =
    by === 'family'
      ? FAMILIES.map((f) => ({ key: f.id, title: lang === 'fr' ? f.fr : lang === 'zh' ? `${f.zh} · ${f.en}` : f.en, items: items.filter((i) => i.family === f.id) }))
      : HSK_LEVELS.map((h) => ({ key: `hsk${h}`, title: hskLabel(h), items: items.filter((i) => i.hsk === h) }));
  const none = items.filter((i) => (by === 'family' ? !i.family : !i.hsk));
  groups.push({ key: 'none', title: lang === 'fr' ? 'Pas encore classé' : 'Not labelled yet', items: none });
  return groups.filter((g) => g.items.length);
}

export type FormulaPart = { t: 'fixed'; s: string } | { t: 'slot'; s: string } | { t: 'gap' };

/**
 * Split a pattern into fixed Chinese, slots and gaps, for colouring:
 * "除非A，才（会/能）B" → 除非 · [A] · ，才（会/能） · [B];  "V+得/不+上" → [V] · 得/不 · 上.
 * Latin runs (A, B, S, SB, V, Verb, Time/Event, Question W…) are slots; "+" only joins; "…", "...", "。。。" are gaps.
 * A lesson's formula writes slots in square brackets, which wins over the Latin rule.
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
