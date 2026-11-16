// The answer field in the Sheets list (D10): the kind of answer is told apart from what was typed.
// Pure helpers on top of grade.ts. "Right" means verdict 'right' only; tones/near count as wrong.
import type { Note } from './types';
import { checkHanzi, checkPinyin, targets, type Check } from './engine/grade';
import { HAN } from './pinyin';

export type AnswerKind = 'hanzi' | 'tones' | 'pinyin';

/** Any Han character → hanzi; digits and spaces only → tones; otherwise pinyin. Empty → null. */
export function answerKind(typed: string): AnswerKind | null {
  if (!typed.trim()) return null;
  if (HAN.test(typed)) return 'hanzi';
  if (/^[\d\s]+$/.test(typed)) return 'tones';
  return 'pinyin';
}

/** One digit per syllable: 1-4, 5 or 0 for neutral. Spaces ignored. Any accepted reading may match. */
export function checkTones(typed: string, note: Note): Check {
  const expected = note.pinyin;
  const digits = typed.replace(/\s+/g, '');
  if (!/^\d+$/.test(digits)) return { verdict: 'wrong', expected };
  const got = [...digits].map((d) => (d === '0' ? 5 : Number(d)));
  const ok = targets(note).some((syls) => syls.length === got.length && syls.every((s, i) => s.t === got[i]));
  return { verdict: ok ? 'right' : 'wrong', expected };
}

export function checkListAnswer(typed: string, note: Note): { kind: AnswerKind; right: boolean } | null {
  const kind = answerKind(typed);
  if (!kind) return null;
  const c = kind === 'hanzi' ? checkHanzi(typed, note) : kind === 'tones' ? checkTones(typed, note) : checkPinyin(typed, note);
  return { kind, right: c.verdict === 'right' };
}
