// Tick-box filters of the Grammar list (plan 2026-11-22-grammar-v3, D3): HSK level, family, Hugo's status. Inside a
// group the boxes are OR (HSK 4 + HSK 5); across groups AND. Device-only UI state in localStorage, like QUICK-1: not a
// pref, never synced. Pure apart from read/save.
import type { WordStatus } from '../types';
import type { GrammarItem } from './list';
import type { FamilyId, HskLevel } from './types';

/** 'none' = points without that label. */
export interface GrammarFilter {
  hsk: (HskLevel | 'none')[];
  family: (FamilyId | 'none')[];
  status: WordStatus[];
}

export type FilterGroup = keyof GrammarFilter;

export const NO_FILTER: GrammarFilter = { hsk: [], family: [], status: [] };

const KEY = 'hz.gr.f';

export function readFilter(): GrammarFilter {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<GrammarFilter> | null;
    const arr = <T>(x: unknown): T[] => (Array.isArray(x) ? (x as T[]) : []);
    return v && typeof v === 'object' ? { hsk: arr(v.hsk), family: arr(v.family), status: arr(v.status) } : { ...NO_FILTER };
  } catch {
    return { ...NO_FILTER };
  }
}

export function saveFilter(f: GrammarFilter): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* private mode: filters still work for this visit */
  }
}

export function activeCount(f: GrammarFilter): number {
  return f.hsk.length + f.family.length + f.status.length;
}

/** The value of one group for an item. */
function valueOf(item: GrammarItem, group: FilterGroup, statuses: Map<string, WordStatus>): string | number {
  if (group === 'hsk') return item.hsk ?? 'none';
  if (group === 'family') return item.family ?? 'none';
  return statuses.get(item.note.id) ?? 'new';
}

function passes(item: GrammarItem, f: GrammarFilter, statuses: Map<string, WordStatus>, skip?: FilterGroup): boolean {
  return (Object.keys(f) as FilterGroup[]).every((g) => g === skip || !f[g].length || (f[g] as (string | number)[]).includes(valueOf(item, g, statuses)));
}

export function applyFilter(items: GrammarItem[], f: GrammarFilter, statuses: Map<string, WordStatus>): GrammarItem[] {
  return items.filter((i) => passes(i, f, statuses));
}

/** Toggle one box. */
export function toggle<G extends FilterGroup>(f: GrammarFilter, group: G, value: GrammarFilter[G][number]): GrammarFilter {
  const list = f[group] as GrammarFilter[G][number][];
  const next = list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
  return { ...f, [group]: next };
}

/**
 * How many points each box would show, given the boxes ticked in the other groups (the usual faceted count): ticking it
 * inside its own group adds exactly that many.
 */
export function filterCounts(items: GrammarItem[], f: GrammarFilter, statuses: Map<string, WordStatus>): Record<FilterGroup, Map<string | number, number>> {
  const out = { hsk: new Map(), family: new Map(), status: new Map() } as Record<FilterGroup, Map<string | number, number>>;
  for (const g of Object.keys(out) as FilterGroup[]) {
    for (const i of items) {
      if (!passes(i, f, statuses, g)) continue;
      const v = valueOf(i, g, statuses);
      out[g].set(v, (out[g].get(v) ?? 0) + 1);
    }
  }
  return out;
}

/** Previous and next point in the list as shown (search + filters applied), for the detail page. */
export function neighbours<T extends { note: { id: string } }>(shown: T[], id: string): { prev?: T; next?: T } {
  const i = shown.findIndex((x) => x.note.id === id);
  if (i < 0) return {};
  return { prev: shown[i - 1], next: shown[i + 1] };
}
