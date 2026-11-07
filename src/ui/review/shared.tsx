// Types and small helpers shared by the review components.
import type { Grade } from '../../lib/types';
import type { Check } from '../../lib/engine/grade';
import { fnv1a } from '../../lib/import/build';
import { HAN } from '../../lib/pinyin';

export type Mode = 'reveal' | 'type-pinyin' | 'type-hanzi' | 'type-meaning' | 'write-guided' | 'write-free' | 'choice' | 'build';

export interface Answered {
  check?: Check;
  auto?: Grade;
  mode: Mode;
  note?: string;
}

export const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

export function VerdictLine({ a, lang }: { a: Answered; lang: string }) {
  const c = a.check!;
  const text =
    c.verdict === 'right'
      ? 'Right'
      : c.verdict === 'tones'
        ? a.mode.startsWith('write')
          ? 'Almost'
          : 'Tones wrong'
        : c.verdict === 'near'
          ? 'Close: check it'
          : 'Not quite';
  return (
    <div className={`verdict ${c.verdict}`} role="status" lang={lang}>
      {text}
      {a.note ? ` · ${a.note}` : ''}
    </div>
  );
}

export function seeded<T>(list: T[], seed: string): T[] {
  return [...list].sort((a, b) => (fnv1a(seed + JSON.stringify(a)) < fnv1a(seed + JSON.stringify(b)) ? -1 : 1));
}

export function segment(zh: string): string[] {
  const words =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(zh)].map((s) => s.segment)
      : [...zh];
  const out: string[] = [];
  for (const w of words) {
    if (!w.trim()) continue;
    if (!HAN.test(w) && out.length) out[out.length - 1] += w;
    else out.push(w);
  }
  return out.length >= 3 ? out : [...zh].filter((c) => c.trim());
}
