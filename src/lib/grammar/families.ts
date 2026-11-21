// The grammar families, in display order. Ids are stored (labels); names are UI only.
import type { FamilyId, HskLevel } from './types';

export interface Family {
  id: FamilyId;
  en: string;
  fr: string;
  zh: string;
}

export const FAMILIES: Family[] = [
  { id: 'condition', en: 'Conditions', fr: 'Conditions', zh: '条件' },
  { id: 'time', en: 'Time & starting points', fr: 'Temps et point de départ', zh: '时间' },
  { id: 'formal', en: 'Formal words', fr: 'Mots formels', zh: '书面语' },
  { id: 'complement', en: 'Complements', fr: 'Compléments', zh: '补语' },
  { id: 'emphasis', en: 'Emphasis', fr: 'Insistance', zh: '强调' },
  { id: 'compare', en: 'Comparing & describing', fr: 'Comparer et décrire', zh: '比较' },
  { id: 'phrase', en: 'Set phrases', fr: 'Expressions figées', zh: '固定搭配' },
];

const BY_ID = new Map(FAMILIES.map((f) => [f.id, f]));

export function family(id: FamilyId | undefined): Family | undefined {
  return id ? BY_ID.get(id) : undefined;
}

export function isFamilyId(v: unknown): v is FamilyId {
  return typeof v === 'string' && BY_ID.has(v as FamilyId);
}

export const HSK_LEVELS: HskLevel[] = [1, 2, 3, 4, 5, 6, 7];

export function hskLabel(h: HskLevel): string {
  return h === 7 ? 'HSK 7–9' : `HSK ${h}`;
}

export function isHskLevel(v: unknown): v is HskLevel {
  return typeof v === 'number' && HSK_LEVELS.includes(v as HskLevel);
}
