// Automatic grading of typed and written answers. Everything runs on the device.
import type { Grade, Note } from '../types';
import { HAN, parsePinyin, syllablesFromNumbered, toToneless, type Syl } from '../pinyin';

export type Verdict = 'right' | 'tones' | 'near' | 'wrong';

export interface Check {
  verdict: Verdict;
  /** Index of wrong syllables (pinyin) for highlighting. */
  wrongAt?: number[];
  /** What the answer was compared with. */
  expected: string;
}

function targets(note: Note): Syl[][] {
  const list = [note.pinyinNum, ...(note.altPinyin ?? [])].filter(Boolean);
  return list.map((p) => syllablesFromNumbered(p.split(' ')));
}

/** Pinyin typed with tone numbers (peng2you), tone marks, or v for ü. */
export function checkPinyin(typed: string, note: Note): Check {
  const all = targets(note);
  const expected = note.pinyin;
  if (!typed.trim() || !all.length) return { verdict: 'wrong', expected };
  let best: Check = { verdict: 'wrong', expected };
  for (const target of all) {
    const p = parsePinyin(typed, target.length);
    if (!p.ok) {
      // Can't split it: compare letters only.
      const letters = typed.toLowerCase().replace(/[^a-zü]/g, '').replace(/ü/g, 'v');
      if (letters && letters === toToneless(target)) best = better(best, { verdict: 'tones', expected });
      continue;
    }
    const got = p.syls.filter((s, i) => !(s.s === 'r' && i > 0 && p.syls.length > target.length));
    if (toToneless(got) !== toToneless(target) || got.length !== target.length) {
      if (toToneless(got) === toToneless(target)) best = better(best, { verdict: 'tones', expected });
      continue;
    }
    const wrongAt: number[] = [];
    got.forEach((s, i) => {
      const t = target[i].t;
      if (t === 5) return; // neutral: any tone is accepted
      if (s.t !== t) wrongAt.push(i);
    });
    best = better(best, wrongAt.length ? { verdict: 'tones', wrongAt, expected } : { verdict: 'right', expected });
  }
  return best;
}

const RANK: Record<Verdict, number> = { wrong: 0, near: 1, tones: 2, right: 3 };
function better(a: Check, b: Check): Check {
  return RANK[b.verdict] > RANK[a.verdict] ? b : a;
}

/** Hanzi typed with the system keyboard. Alternative forms count. */
export function checkHanzi(typed: string, note: Note): Check {
  const clean = (s: string) => [...s].filter((c) => HAN.test(c)).join('');
  const t = clean(typed);
  const forms = [note.hanzi, ...note.alts].map(clean);
  if (t && forms.includes(t)) return { verdict: 'right', expected: note.hanzi };
  // 一会 / 一会儿
  if (t && forms.some((f) => f.replace(/儿$/, '') === t.replace(/儿$/, ''))) return { verdict: 'right', expected: note.hanzi };
  return { verdict: 'wrong', expected: note.hanzi };
}

const ARTICLES_EN = /^(to|the|a|an|be|to be)\s+/;
const ARTICLES_FR = /^(le|la|les|l'|un|une|des|du|de|se|s'|d')\s*/;

export function normMeaning(s: string): string {
  let x = s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`]/g, "'")
    .replace(/\([^)]*\)?|\[[^\]]*\]?|（[^）]*）?/g, ' ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  for (let k = 0; k < 2; k++) x = x.replace(ARTICLES_EN, '').replace(ARTICLES_FR, '').trim();
  return x;
}

/** Each meaning in a cell (split on , ; / · and line breaks), normalised. */
export function meaningsOf(text: string): string[] {
  const parts = text
    .split(/[,;/、·\n，；|]+/)
    .map((p) => p.replace(/\p{Script=Han}+/gu, ' '))
    .map(normMeaning)
    .filter((p) => p.length > 0);
  return [...new Set(parts)];
}

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  const dp = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

/** Meaning typed in English or French: right on a match or a one-letter typo; near on a close miss. */
export function checkMeaning(typed: string, accepted: string[]): Check {
  const t = normMeaning(typed);
  const expected = accepted.join(' / ');
  if (!t) return { verdict: 'wrong', expected };
  const all = accepted.flatMap(meaningsOf);
  if (all.includes(t)) return { verdict: 'right', expected };
  for (const m of all) {
    const d = levenshtein(t, m);
    if (d <= 1 && m.length >= 4) return { verdict: 'right', expected };
  }
  for (const m of all) {
    const d = levenshtein(t, m);
    if ((d <= 2 && m.length >= 5) || (t.length >= 4 && (` ${m} `.includes(` ${t} `) || ` ${t} `.includes(` ${m} `)))) {
      return { verdict: 'near', expected };
    }
  }
  return { verdict: 'wrong', expected };
}

/** Grade for a typed answer. Fast right answers are Easy. */
export function gradeFor(verdict: Verdict, ms: number): Grade {
  switch (verdict) {
    case 'right':
      return ms < 5000 ? 4 : 3;
    case 'tones':
      return 2;
    case 'near':
      return 3;
    default:
      return 1;
  }
}

/** Grade for handwriting: 0 mistakes Good, 1–2 Hard, a hint or 3+ Again. */
export function gradeWriting(mistakes: number, hints: number): Grade {
  if (hints > 0 || mistakes >= 3) return 1;
  if (mistakes > 0) return 2;
  return 3;
}
