// Quick memory cards: typed answers and the saved card session. Plan: .claude/plans/2026-11-14-quick-typed.md.
// Answers: Hugo picks what he types (hanzi, pinyin with tone numbers, or the French meaning); the verdict is only right
// or wrong ('tones' and 'near' from grade.ts count as wrong).
// Session: deck order, position, missed words, counts and round live in localStorage `hz.qm.cards` on this device only.
// It is not a shared pref, not backed up and never synced (decisions.md QUICK-1). One saved deck at a time; restoring
// resolves ids against the current notes, so a word deleted from Excel meanwhile is skipped. Anything unreadable (bad
// JSON, wrong shape, newer format) reads as no session: the deck simply starts over, nothing else depends on it.
import type { Note } from './types';
import { checkHanzi, checkMeaning, checkPinyin, type Check, type Verdict } from './engine/grade';
import { meaning } from './store';
import { pref, setPref } from './db';

/** What Hugo types: the hanzi, the pinyin (tone numbers; tone marks are accepted too), or the French meaning. */
export type Target = 'hanzi' | 'pinyin' | 'fr';
export const TARGETS: readonly Target[] = ['hanzi', 'pinyin', 'fr'];

/** Checks a typed answer. 'fr' compares with the French meaning, plus the English one when `acceptBoth` is on. */
export function checkAnswer(target: Target, typed: string, note: Note, acceptBoth: boolean): Check {
  if (target === 'hanzi') return checkHanzi(typed, note);
  if (target === 'pinyin') return checkPinyin(typed, note);
  const accepted = [meaning(note, 'fr').text];
  if (acceptBoth) accepted.push(meaning(note, 'en').text);
  return checkMeaning(typed, [...new Set(accepted.filter((t) => t.trim()))]);
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
