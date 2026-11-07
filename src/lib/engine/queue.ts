// Today's study queue: due reviews (most overdue first) + new cards up to the daily limits.
import type { CardState, Note, ReviewEvent } from '../types';
import { addDays, dayStart, noteOfCard } from './schedule';

export interface QueueSettings {
  newVocab: number;
  newOther: number;
  maxReviews: number;
}

export interface TodayCounts {
  due: number;
  learning: number;
  newAvailable: number;
  newVocabLeft: number;
  newOtherLeft: number;
  introducedToday: number;
  reviewedToday: number;
}

/** Notes whose first review (any card, any device) happened today. */
export function introducedToday(events: ReviewEvent[], now: number): Set<string> {
  const start = dayStart(now);
  const first = new Map<string, number>();
  for (const e of events) {
    const n = noteOfCard(e.card);
    const f = first.get(n);
    if (f == null || e.t < f) first.set(n, e.t);
  }
  const out = new Set<string>();
  for (const [n, t] of first) if (t >= start) out.add(n);
  return out;
}

export interface Queue {
  /** Card ids in study order. */
  cards: string[];
  /** Cards shown for the first time in this queue (get an intro screen). */
  fresh: Set<string>;
  counts: TodayCounts;
}

export function buildQueue(
  cards: CardState[],
  notes: Map<string, Note>,
  events: ReviewEvent[],
  s: QueueSettings,
  now: number,
): Queue {
  const end = addDays(dayStart(now), 1);
  const intro = introducedToday(events, now);
  let vocabIntro = 0;
  let otherIntro = 0;
  for (const n of intro) {
    const note = notes.get(n);
    if (!note) continue;
    if (note.kind === 'vocab') vocabIntro++;
    else otherIntro++;
  }
  const reviewedToday = events.filter((e) => e.t >= dayStart(now)).length;

  const active = cards.filter((c) => !c.locked && notes.has(c.note));
  const due = active.filter((c) => c.state !== 0 && c.due < end).sort((a, b) => a.due - b.due);
  // Siblings that unlocked (recall after recognition) are new cards that don't count as new words.
  const siblings = active.filter((c) => c.state === 0 && c.nEvents === 0 && (c.type === 'recall' || c.type === 'listen') && c.due < end && c.due > 0);

  // New notes: never reviewed, not seeded, in sheet order.
  const newByNote = new Map<string, CardState>();
  for (const c of active) {
    if (c.state !== 0 || c.nEvents || c.seeded) continue;
    if (c.type === 'recall' || c.type === 'listen') continue;
    if (!newByNote.has(c.note)) newByNote.set(c.note, c);
  }
  const newNotes = [...newByNote.values()].sort((a, b) => notes.get(a.note)!.order - notes.get(b.note)!.order);
  const newVocabLeft = Math.max(0, s.newVocab - vocabIntro);
  const newOtherLeft = Math.max(0, s.newOther - otherIntro);
  const newVocab = newNotes.filter((c) => notes.get(c.note)!.kind === 'vocab').slice(0, newVocabLeft);
  const newOther = newNotes.filter((c) => notes.get(c.note)!.kind !== 'vocab').slice(0, newOtherLeft);

  // One card per note per day: bury siblings of a note already in the queue.
  const seen = new Set<string>();
  const pick = (list: CardState[], limit = Infinity) => {
    const out: CardState[] = [];
    for (const c of list) {
      if (out.length >= limit) break;
      if (seen.has(c.note)) continue;
      seen.add(c.note);
      out.push(c);
    }
    return out;
  };
  const learning = pick(due.filter((c) => c.state === 1 || c.state === 3));
  const reviews = pick(due.filter((c) => c.state === 2), Math.max(0, s.maxReviews - reviewedToday));
  const fresh = pick([...newOther, ...newVocab]);
  const sibs = pick(siblings);

  // Interleave: one new card after every few reviews.
  const order: CardState[] = [...learning];
  const newOnes = [...fresh, ...sibs];
  const gap = newOnes.length ? Math.max(1, Math.floor(reviews.length / newOnes.length)) : Infinity;
  let r = 0;
  for (const n of newOnes) {
    for (let k = 0; k < gap && r < reviews.length; k++) order.push(reviews[r++]);
    order.push(n);
  }
  while (r < reviews.length) order.push(reviews[r++]);

  return {
    cards: order.map((c) => c.id),
    fresh: new Set(fresh.map((c) => c.id)),
    counts: {
      due: reviews.length,
      learning: learning.length,
      newAvailable: fresh.length + sibs.length,
      newVocabLeft,
      newOtherLeft,
      introducedToday: intro.size,
      reviewedToday,
    },
  };
}

/**
 * Next `n` new words beyond today's limit, for "Learn more" once the daily new words are done.
 * Stateless: words introduced by an earlier "more" count as introduced, so each call returns the following ones.
 */
export function moreNew(cards: CardState[], notes: Map<string, Note>, events: ReviewEvent[], s: QueueSettings, now: number, n = 5): string[] {
  const base = buildQueue(cards, notes, events, s, now);
  let vocabIntro = 0;
  for (const id of introducedToday(events, now)) if (notes.get(id)?.kind === 'vocab') vocabIntro++;
  const wider = buildQueue(cards, notes, events, { ...s, newVocab: Math.max(s.newVocab, vocabIntro) + n }, now);
  return wider.cards.filter((id) => wider.fresh.has(id) && !base.fresh.has(id));
}

/** Reviews due after today, soonest first, one card per word. Normal reviews: FSRS handles the early ones. */
export function reviewAhead(cards: CardState[], notes: Map<string, Note>, now: number, limit = 20): string[] {
  const end = addDays(dayStart(now), 1);
  const seen = new Set<string>();
  const out: string[] = [];
  const list = cards.filter((c) => !c.locked && c.state !== 0 && c.due >= end && notes.has(c.note)).sort((a, b) => a.due - b.due);
  for (const c of list) {
    if (out.length >= limit) break;
    if (seen.has(c.note)) continue;
    seen.add(c.note);
    out.push(c.id);
  }
  return out;
}

/** Where a card that is still in (re)learning goes back into the running session. */
export function reinsertIndex(queue: string[], pos: number, dueIn: number): number {
  // Short steps come back after a few cards; longer ones at the end.
  const after = dueIn <= 2 * 60000 ? 3 : dueIn <= 15 * 60000 ? 8 : Infinity;
  return Math.min(queue.length, pos + after);
}
