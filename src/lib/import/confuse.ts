// Readers for the two optional columns of vocab sheets (plan 2026-11-27-word-panel-settings D3, D5):
// - "Don't confuse": one line per word, `词 | register | usage FR | usage EN` ("|" or "｜"); every field after the word
//   may be empty; a line with only `词` is valid. Lines whose word has no Han character are reported and skipped.
// - "Register": the word's own register (口语, 书面, 中性…).
// Pure; called by import/build.ts for vocab rows. Results land in the additive Note.confuse / Note.register.
import type { ConfuseItem, Register } from '../types';
import { parseRegister } from '../grammar/families';
import { HAN } from '../pinyin';

const fold = (s: string) => s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[.。]+$/, '').replace(/\s+/g, ' ').trim();

/** Spellings the grammar reader (parseRegister) doesn't know, folded (lower case, no accents, no final dot). */
const MORE: Record<string, Register> = {
  kouyu: 'spoken', coll: 'spoken', colloq: 'spoken', colloquial: 'spoken', familiar: 'spoken', fam: 'spoken',
  中性: 'neutral',
  shumian: 'written', litteraire: 'written', lit: 'written',
};

/** "口语", "kǒuyǔ", "coll.", "Colloquial", "soutenu", "书面", "中性"… → Register; undefined when nothing matches. */
export function readRegister(raw: string): Register | undefined {
  return parseRegister(raw) ?? parseRegister(fold(raw)) ?? MORE[fold(raw)];
}

const REGISTER_HINT = '口语, 书面 or 中性';

/** The "Register" cell of a vocab row. Empty cell → nothing; unknown text → a problem. */
export function parseWordRegister(raw: string): { register?: Register; problem?: string } {
  const t = raw.trim();
  if (!t) return {};
  const register = readRegister(t);
  return register ? { register } : { problem: `Unknown register "${t}" (${REGISTER_HINT})` };
}

/** Same bullet prefixes as the 语法 sheet's Sentences (grammar/excel.ts). */
const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•·\-*]+/, '').trim())
    .filter(Boolean);

/**
 * The "Don't confuse" cell of a vocab row → items in Excel order, plus the problems worth reporting.
 * `self`: the row's own word; a line naming it is skipped. A word listed twice keeps its first line.
 */
export function parseConfuse(raw: string, self?: string): { items: ConfuseItem[]; problems: string[] } {
  const items: ConfuseItem[] = [];
  const problems: string[] = [];
  for (const line of lines(raw)) {
    const [first, reg = '', fr = '', en = '', ...rest] = line.split(/\s*[|｜]\s*/).map((f) => f.trim());
    const word = first ?? '';
    if (!HAN.test(word)) {
      problems.push(`Don't confuse: "${line}" has no Chinese word first; line skipped`);
      continue;
    }
    if (word === self) {
      problems.push(`Don't confuse: "${word}" is the word itself; line skipped`);
      continue;
    }
    if (items.some((i) => i.word === word)) {
      problems.push(`Don't confuse: "${word}" is listed twice; the first line is kept`);
      continue;
    }
    const item: ConfuseItem = { word };
    if (reg) {
      const r = readRegister(reg);
      if (r) item.register = r;
      else problems.push(`Don't confuse: unknown register "${reg}" for ${word} (${REGISTER_HINT}, or empty)`);
    }
    if (fr) item.fr = fr;
    if (en) item.en = en;
    if (rest.some(Boolean)) problems.push(`Don't confuse: more than 4 fields for ${word}; the extra ones are ignored`);
    items.push(item);
  }
  return { items, problems };
}
