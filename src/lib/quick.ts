// Cards (plan 2026-11-16-mobile-ux D5, D7, D8, D11; was Quick memory cards, plan 2026-11-14-quick-typed.md).
// Answers: Hugo picks what he types (hanzi, pinyin, or the French meaning) or draws the hanzi; the verdict is only right
// or wrong ('tones' and 'near' from grade.ts count as wrong). Pinyin follows the Sheets answer field (D10): digits alone
// are tones ("3"), letters are full pinyin ("shao3", tone marks accepted too).
// Draw: `drawVerdict` (D7) — tracing with the outline has no verdict; words without stroke data have none either.
// Deck: built from a Sheets tab (or All, `allRows`) and one list filter (`filterRows`, shared with the Sheets list).
// Deep link `#/cards?sheet=…&status=…&at=…` (`cardsHref` / `readCardsQuery`, `startIndex`).
// Session: deck order, position, missed words, counts and round live in localStorage `hz.qm.cards` on this device only.
// It is not a shared pref, not backed up and never synced (decisions.md QUICK-1). One saved deck at a time; restoring
// resolves ids against the current notes, so a word deleted from Excel meanwhile is skipped. Anything unreadable (bad
// JSON, wrong shape, newer format) reads as no session: the deck simply starts over, nothing else depends on it.
// The format stays v: 1 (D8): a session saved by the Quick screen still loads.
import type { Note, ReviewEvent, WordStatus } from './types';
import { checkHanzi, checkMeaning, checkPinyin, type Check, type Verdict } from './engine/grade';
import { DAY, noteOfCard } from './engine/schedule';
import { answerKind, checkTones } from './answer';
import { meaning } from './store';
import { pref, setPref } from './db';
import { fnv1a } from './import/build';

/** What Hugo answers with: the hanzi, the pinyin (tones alone or full pinyin), the French meaning, or drawing the hanzi. */
export type Target = 'hanzi' | 'pinyin' | 'fr' | 'draw';
export const TARGETS: readonly Target[] = ['hanzi', 'pinyin', 'fr', 'draw'];

/**
 * Checks a typed answer. 'pinyin': digits only (spaces ignored) → tones (`checkTones`), anything else → `checkPinyin`.
 * 'fr' compares with the French meaning, plus the English one when `acceptBoth` is on. 'draw' has no typed answer: a
 * hanzi typed there is checked as hanzi (Draw verdicts come from `drawVerdict`).
 */
export function checkAnswer(target: Target, typed: string, note: Note, acceptBoth: boolean): Check {
  if (target === 'hanzi' || target === 'draw') return checkHanzi(typed, note);
  if (target === 'pinyin') return answerKind(typed) === 'tones' ? checkTones(typed, note) : checkPinyin(typed, note);
  const accepted = [meaning(note, 'fr').text];
  if (acceptBoth) accepted.push(meaning(note, 'en').text);
  return checkMeaning(typed, [...new Set(accepted.filter((t) => t.trim()))]);
}

/**
 * Draw verdict (D7). Outline on (`guided`) = tracing: null, nothing recorded. Words without stroke data (`missing`
 * not empty): null. Outline off: wrong when the answer was revealed or a hint was used, else right.
 */
export function drawVerdict(r: { guided: boolean; revealed?: boolean; hints?: number; missing?: string[] }): 'right' | 'wrong' | null {
  if (r.guided) return null;
  if (r.missing?.length) return null;
  return r.revealed || (r.hints ?? 0) > 0 ? 'wrong' : 'right';
}

// ---------- deep link ----------

const QUERY_KEYS = ['sheet', 'status', 'at'] as const;
type CardsQuery = { sheet?: string; status?: string; at?: string };

/** `#/cards`, with `?sheet=…&status=…&at=…` for the parts given (URL-encoded; empty parts are left out). */
export function cardsHref(o: CardsQuery): string {
  const q = new URLSearchParams();
  for (const k of QUERY_KEYS) if (o[k]) q.set(k, o[k]!);
  const s = q.toString();
  return s ? `#/cards?${s}` : '#/cards';
}

/** The query of a `#/cards?…` hash (with or without the leading '#'); missing or empty parts are absent. */
export function readCardsQuery(hash: string): CardsQuery {
  const i = hash.indexOf('?');
  if (i < 0) return {};
  const q = new URLSearchParams(hash.slice(i + 1));
  const out: CardsQuery = {};
  for (const k of QUERY_KEYS) {
    const v = q.get(k);
    if (v) out[k] = v;
  }
  return out;
}

/** Index of `at` in the deck, else 0. */
export function startIndex(ids: string[], at?: string): number {
  if (at == null) return 0;
  return Math.max(0, ids.indexOf(at));
}

// ---------- list filter (D11: the Sheets list and the Cards deck) ----------

/** All, one status, Wrong (D6), Seen this week, Missed recently. */
export type ListFilter = 'all' | WordStatus | 'wrong' | 'week' | 'missed';
export const LIST_FILTERS: readonly ListFilter[] = ['all', 'new', 'studying', 'notknown', 'mastered', 'wrong', 'week', 'missed'];
/** A stored filter value; anything unknown (an older or newer app version) reads as 'all'. */
export function readListFilter(v: unknown): ListFilter {
  return LIST_FILTERS.includes(v as ListFilter) ? (v as ListFilter) : 'all';
}

/**
 * Per note: when it was last reviewed in the last 7 days (`last`, 0 = not this week) and whether it got an Again
 * (grade 1) in the last 14 days (`missed`). Every reviewed note has an entry. Pass the alias-resolved events (state.events).
 */
export function recentByNote(events: ReviewEvent[], now: number): Map<string, { last: number; missed: boolean }> {
  const recent = new Map<string, { last: number; missed: boolean }>();
  for (const e of events) {
    const n = noteOfCard(e.card);
    const r = recent.get(n) ?? { last: 0, missed: false };
    if (e.t > now - 7 * DAY) r.last = Math.max(r.last, e.t);
    if (e.t > now - 14 * DAY && e.r === 1) r.missed = true;
    recent.set(n, r);
  }
  return recent;
}

/** The rows the filter keeps, in their order. Status filters use each row's own status (as shown in the list). */
export function filterRows<R extends { note: Note; status: WordStatus }>(
  rows: R[],
  f: ListFilter,
  ctx: { wrong: ReadonlySet<string>; recent: Map<string, { last: number; missed: boolean }> },
): R[] {
  switch (f) {
    case 'all':
      return rows.slice();
    case 'wrong':
      return rows.filter((r) => ctx.wrong.has(r.note.id));
    case 'week':
      return rows.filter((r) => (ctx.recent.get(r.note.id)?.last ?? 0) > 0);
    case 'missed':
      return rows.filter((r) => !!ctx.recent.get(r.note.id)?.missed);
    default:
      return rows.filter((r) => r.status === f);
  }
}

/** Every sheet's rows in workbook order (the Map's order), a word in several sheets once, at its first row. */
export function allRows<R extends { note: Note }>(bySheet: Map<string, R[]>): R[] {
  const seen = new Set<string>();
  const out: R[] = [];
  for (const list of bySheet.values()) {
    for (const r of list) {
      if (seen.has(r.note.id)) continue;
      seen.add(r.note.id);
      out.push(r);
    }
  }
  return out;
}

// ---------- answer by (Cards settings › Answer by) ----------

/**
 * How Hugo answers a card: type it (the keyboard), choose it among 4 (Quizlet / Pleco multiple choice: no keyboard), or
 * flip it (Anki / Pleco self-graded: Show answer, then Not known / Known). Device-only pref `cards.by`, default 'type'.
 * Draw ignores it.
 */
export type AnswerBy = 'type' | 'choose' | 'flip';
export const ANSWER_BY: readonly AnswerBy[] = ['type', 'choose', 'flip'];
export const readAnswerBy = (v: unknown): AnswerBy => (ANSWER_BY.includes(v as AnswerBy) ? (v as AnswerBy) : 'type');

const norm = (s: string) => s.normalize('NFC').toLowerCase().replace(/[\s'’·.,;:!?()（）]/g, '');

/**
 * The options of a multiple-choice card: `answer` plus up to `count - 1` distractors from `pool`, in a stable order for a
 * given `salt` (same card, same round → same options after a reload). A distractor never reads the same as the answer
 * (`key`, ignoring case, spaces and punctuation), so homophones and shared meanings can't make two options right. Options
 * close in length to the answer come first, so the right one does not stand out by its size. Fewer options when the
 * pool is small; the answer is always in.
 */
export function pickChoices<T extends { id: string }>(answer: T, pool: readonly T[], key: (x: T) => string, salt: string, count = 4): T[] {
  const want = norm(key(answer));
  const len = [...key(answer)].length;
  const seen = new Set([want]);
  const cands: { x: T; d: number; h: string }[] = [];
  for (const x of pool) {
    if (x.id === answer.id) continue;
    const k = norm(key(x));
    if (!k || seen.has(k)) continue;
    seen.add(k);
    cands.push({ x, d: Math.min(3, Math.abs([...key(x)].length - len)), h: fnv1a(`${salt}|${x.id}`) });
  }
  cands.sort((a, b) => a.d - b.d || (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const out = cands.slice(0, count - 1).map((c) => c.x);
  // Where the answer goes, then the distractors in hash order around it.
  out.sort((a, b) => (fnv1a(`${salt}#${a.id}`) < fnv1a(`${salt}#${b.id}`) ? -1 : 1));
  const at = parseInt(fnv1a(`${salt}@${answer.id}`).slice(0, 6), 16) % (out.length + 1);
  out.splice(at, 0, answer);
  return out;
}

/** Only 'right' counts as right. */
export function isRight(v: Verdict): boolean {
  return v === 'right';
}

export interface CardSession {
  v: 1;
  /** sessionKey(tag, filter, seed) of the deck it belongs to. */
  key: string;
  /** Note ids in deck order for the current round. */
  ids: string[];
  /** Index of the card on screen; ids.length = round finished. */
  i: number;
  /** Note ids answered wrong this round, in answer order. */
  missed: string[];
  /** Right answers this round. */
  knew: number;
  round: number;
  /** "Send to reviews" was used for this round's wrong words (absent = not yet). */
  sent?: boolean;
  /** When it was saved (ms). */
  at: number;
}

const KEY = 'qm.cards';

/** JSON of the three parts, so a separator inside a sheet name can't make two decks share a key. */
export function sessionKey(tag: string, filter: string, seed: string): string {
  return JSON.stringify([tag, filter, seed]);
}

/** Saves the session (sets v and at). */
export function saveSession(s: Omit<CardSession, 'v' | 'at'>): void {
  const saved: CardSession = {
    v: 1,
    key: s.key,
    ids: [...s.ids],
    i: s.i,
    missed: [...s.missed],
    knew: s.knew,
    round: s.round,
    ...(s.sent ? { sent: true as const } : {}),
    at: Date.now(),
  };
  setPref(KEY, saved);
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0;
const strings = (a: unknown): a is string[] => Array.isArray(a) && a.every((x) => typeof x === 'string');

/**
 * The saved session for this deck, or null (none, another deck, unreadable, newer format, or no word left).
 * Ids not in `alive` are dropped from ids and missed; i moves back by the dropped ids before it and stays in 0..ids.length.
 */
export function loadSession(key: string, alive: ReadonlySet<string>): CardSession | null {
  const raw = pref<unknown>(KEY, null);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  if (s.v !== 1 || s.key !== key) return null;
  if (!strings(s.ids) || !strings(s.missed)) return null;
  if (!count(s.i) || !count(s.knew) || !count(s.round) || !count(s.at)) return null;
  if (s.i > s.ids.length) return null;
  const ids = s.ids.filter((id) => alive.has(id));
  if (!ids.length) return null;
  const droppedBefore = s.ids.slice(0, s.i).filter((id) => !alive.has(id)).length;
  const i = Math.min(Math.max(0, s.i - droppedBefore), ids.length);
  return {
    v: 1,
    key,
    ids,
    i,
    missed: s.missed.filter((id) => alive.has(id)),
    knew: s.knew,
    round: s.round,
    ...(s.sent === true ? { sent: true as const } : {}),
    at: s.at,
  };
}

export function clearSession(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem('hz.' + KEY);
  } catch {
    // storage unavailable (private mode): nothing was kept
  }
}
