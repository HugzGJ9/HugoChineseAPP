// Grammar families and HSK levels: display names, and the lenient readers for the 语法 sheet's Family / HSK / Register
// cells (Hugo types them by hand).
import type { FamilyId, HskLevel, Register } from './types';

export interface Family {
  id: FamilyId;
  en: string;
  fr: string;
  zh: string;
  /** Other words accepted in the Family cell (folded, matched as a prefix). */
  also: string[];
}

export const FAMILIES: Family[] = [
  { id: 'condition', en: 'Conditions', fr: 'Conditions', zh: '条件', also: ['condition'] },
  { id: 'time', en: 'Time', fr: 'Temps', zh: '时间', also: ['time & starting points', 'temps'] },
  { id: 'formal', en: 'Formal words', fr: 'Mots soutenus', zh: '书面语', also: ['formal', 'mots formels', 'soutenu'] },
  { id: 'complement', en: 'Complements', fr: 'Compléments', zh: '补语', also: ['complement'] },
  { id: 'emphasis', en: 'Emphasis', fr: 'Insistance', zh: '强调', also: ['emphase'] },
  { id: 'compare', en: 'Comparing', fr: 'Comparer et décrire', zh: '比较', also: ['comparing & describing', 'comparison', 'comparer', 'comparaison'] },
  { id: 'phrase', en: 'Set phrases', fr: 'Expressions figées', zh: '固定搭配', also: ['phrases', 'set phrase', 'expressions', 'expression figee'] },
];

const BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

export function family(id: FamilyId | undefined): Family | undefined {
  return id ? BY_ID.get(id) : undefined;
}

const foldCell = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** "Comparing", "comparer", "比较", "compare"… → FamilyId; undefined when nothing matches. */
export function parseFamily(raw: string): FamilyId | undefined {
  const v = foldCell(raw);
  if (!v) return undefined;
  for (const f of FAMILIES) {
    const names = [f.id, f.en, f.fr, f.zh, ...f.also].map(foldCell);
    if (names.includes(v)) return f.id;
  }
  for (const f of FAMILIES) {
    const names = [f.en, f.fr, ...f.also].map(foldCell);
    if (names.some((n) => n.startsWith(v) || v.startsWith(n))) return f.id;
  }
  return undefined;
}

export const HSK_LEVELS: HskLevel[] = [1, 2, 3, 4, 5, 6, 7];

export function hskLabel(h: HskLevel): string {
  return h === 7 ? 'HSK 7–9' : `HSK ${h}`;
}

/** "5", "HSK 5", "hsk5", 5, "7-9", "HSK 7–9" → level; undefined otherwise. */
export function parseHsk(raw: string): HskLevel | undefined {
  const m = /^(?:hsk)?\s*([1-9])(?:\s*[-–~]\s*9)?(?:\.0+)?$/i.exec(raw.trim());
  if (!m) return undefined;
  const n = Number(m[1]);
  return (n >= 7 ? 7 : n) as HskLevel;
}

const REGISTERS: Record<string, Register> = {
  spoken: 'spoken', oral: 'spoken', 口语: 'spoken', familier: 'spoken', casual: 'spoken',
  neutral: 'neutral', neutre: 'neutral',
  formal: 'formal', soutenu: 'formal', formel: 'formal',
  written: 'written', ecrit: 'written', 书面: 'written', 书面语: 'written', literary: 'written',
};

export function parseRegister(raw: string): Register | undefined {
  return REGISTERS[foldCell(raw)];
}

export const REGISTER_LABEL: Record<Register, { en: string; fr: string }> = {
  spoken: { en: 'Spoken', fr: 'Oral' },
  neutral: { en: 'Neutral', fr: 'Neutre' },
  formal: { en: 'Formal', fr: 'Soutenu' },
  written: { en: 'Written', fr: 'Écrit' },
};
