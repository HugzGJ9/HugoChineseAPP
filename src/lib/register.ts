// Register (口语 / 书面) and the "difference" line of the Similar words list (plan 2026-11-27 D3, D4). Pure.
import type { Note, Register } from './types';

type RegNote = Pick<Note, 'register' | 'en' | 'fr'>;

const MEANING_SPOKEN = /\b(coll\.?|colloquial|kouyu|kǒuyǔ)\b|口语|très kouyu/i;
const SENSE_SPOKEN = /\((coll\.|colloquial)\)|\bcolloquial\b|\(fam\.\)|familier/i;
const SENSE_WRITTEN = /\((lit\.|literary|formal|written)\)|\b(literary|formal|written)\b|littéraire|soutenu|\(sout\.\)|\(litt\.\)/i;

/** D4: his Excel register, else his meaning, else a dictionary sense tagged colloquial. */
export function isSpoken(note?: RegNote, senses?: string[]): boolean {
  if (note?.register === 'spoken') return true;
  // His own Register cell decides when set (neutral/formal/written → no crown).
  if (note?.register) return false;
  if (note && (MEANING_SPOKEN.test(note.en ?? '') || MEANING_SPOKEN.test(note.fr ?? ''))) return true;
  return !!senses?.some((s) => SENSE_SPOKEN.test(s));
}

/** '书面' for a written/formal word (his register, or every dictionary sense tagged literary/formal/written). */
export function registerTag(note?: Pick<Note, 'register'>, senses?: string[]): '书面' | undefined {
  const r: Register | undefined = note?.register;
  if (r === 'written' || r === 'formal') return '书面';
  if (r) return undefined;
  if (senses && senses.length > 0 && senses.every((s) => SENSE_WRITTEN.test(s))) return '书面';
  return undefined;
}

const STOP = new Set([
  'to', 'a', 'an', 'the', 'of', 'in', 'on', 'at', 'for', 'and', 'or', 'be', 'is', 'sb', 'sth', 'one', 'ones', 'by', 'with', 'as', 'it', 'its',
  'le', 'la', 'les', 'de', 'du', 'des', 'un', 'une', 'et', 'ou', 'qn', 'qch', 'se', 's', 'en', 'au', 'aux', 'qui', 'que',
]);

function words(sense: string): Set<string> {
  const plain = sense.replace(/\([^)]*\)/g, ' ').replace(/\[[^\]]*\]/g, ' ').toLowerCase();
  const out = new Set<string>();
  for (const w of plain.split(/[^\p{L}]+/u)) if (w.length > 1 && !STOP.has(w)) out.add(w);
  return out;
}

/** The other word's senses that share no meaningful word with any headword sense (≤ max); its first sense when all are shared. */
export function differenceLine(head: string[], other: string[], max = 2): string[] {
  const seen = new Set<string>();
  for (const s of head) for (const w of words(s)) seen.add(w);
  const own = other.filter((s) => s.trim());
  const diff = own.filter((s) => {
    const w = words(s);
    if (w.size === 0) return false;
    for (const x of w) if (seen.has(x)) return false;
    return true;
  });
  const out = diff.length ? diff : own.slice(0, 1);
  return out.slice(0, max);
}
