// Card states are derived data: notes + seeds + review events → FSRS state of every card.
// Every device replays the same events through the same scheduler, so they agree.
import { createEmptyCard, fsrs, generatorParameters, type Card, type FSRS } from 'ts-fsrs';
import type { CardState, CardType, Grade, Note, ReviewEvent } from '../types';
import { fnv1a } from '../import/build';

export const DAY = 86400000;
/** The study day starts at 4 am local time, so a late-night session counts for the day before. */
export const DAY_START_HOUR = 4;

export function dayStart(t: number): number {
  const d = new Date(t);
  d.setHours(DAY_START_HOUR, 0, 0, 0);
  if (d.getTime() > t) d.setDate(d.getDate() - 1);
  return d.getTime();
}

export function dayKey(t: number): string {
  const d = new Date(dayStart(t));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function addDays(t: number, n: number): number {
  const d = new Date(t);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

export interface EngineSettings {
  retention: number;
  spreadDays: number;
  recall: boolean;
  listen: boolean;
}

const schedulers = new Map<number, FSRS>();
export function scheduler(retention: number): FSRS {
  let f = schedulers.get(retention);
  if (!f) {
    // No fuzz: the same events must give the same dates on every device.
    f = fsrs(generatorParameters({ request_retention: retention, enable_fuzz: false, enable_short_term: true, maximum_interval: 36500 }));
    schedulers.set(retention, f);
  }
  return f;
}

export function cardTypes(note: Note, s: Pick<EngineSettings, 'recall' | 'listen'>): CardType[] {
  switch (note.kind) {
    case 'vocab':
      return ['recog', ...(s.recall ? (['recall'] as const) : []), ...(s.listen ? (['listen'] as const) : [])];
    case 'grammar':
      return ['grammar'];
    case 'measure':
      return ['measure'];
    case 'synonym':
      return ['synonym'];
  }
}

export const cardId = (noteId: string, type: CardType) => `${noteId}#${type}`;
export const noteOfCard = (id: string) => id.slice(0, id.lastIndexOf('#'));
export const typeOfCard = (id: string) => id.slice(id.lastIndexOf('#') + 1) as CardType;

/** Stability given to words already studied in Excel ("known for about three weeks"). */
export const SEED_STABILITY = 20;
const SIBLING_SHIFT: Partial<Record<CardType, number>> = { recall: 0.5, listen: 0.25 };

/** Days after the seed day when a green word's card first comes up: spread over spreadDays, stable per word. */
export function seedOffset(noteId: string, type: CardType, spreadDays: number): number {
  const h = parseInt(fnv1a(noteId), 16) % spreadDays;
  const shift = Math.floor((SIBLING_SHIFT[type] ?? 0) * spreadDays);
  return 1 + ((h + shift) % spreadDays);
}

export function seededCard(seedTime: number, offset: number): Card {
  const start = dayStart(seedTime);
  return {
    due: new Date(addDays(start, offset)),
    stability: SEED_STABILITY,
    difficulty: 5,
    scheduled_days: offset,
    learning_steps: 0,
    reps: 1,
    lapses: 0,
    state: 2,
    last_review: new Date(start),
  };
}

export function toState(id: string, note: string, type: CardType, c: Card, extra: Partial<CardState>): CardState {
  return {
    id,
    note,
    type,
    due: c.due.getTime(),
    stability: c.stability,
    difficulty: c.difficulty,
    scheduledDays: c.scheduled_days,
    learningSteps: c.learning_steps,
    reps: c.reps,
    lapses: c.lapses,
    state: c.state as 0 | 1 | 2 | 3,
    last: c.last_review ? c.last_review.getTime() : 0,
    nEvents: 0,
    ...extra,
  };
}

export function fromState(s: CardState): Card {
  return {
    due: new Date(s.due),
    stability: s.stability,
    difficulty: s.difficulty,
    scheduled_days: s.scheduledDays,
    learning_steps: s.learningSteps,
    reps: s.reps,
    lapses: s.lapses,
    state: s.state,
    last_review: s.last ? new Date(s.last) : undefined,
  };
}

/** Apply one review to a card state. */
export function applyReview(s: CardState, ev: Pick<ReviewEvent, 'r' | 't'>, retention: number): CardState {
  const f = scheduler(retention);
  const base: Card = s.state === 0 && !s.nEvents && !s.seeded ? createEmptyCard(new Date(ev.t)) : fromState(s);
  const next = f.next(base, new Date(ev.t), ev.r).card;
  return toState(s.id, s.note, s.type, next, {
    nEvents: s.nEvents + 1,
    first: s.first ?? ev.t,
    ...(s.seeded ? { seeded: true } : {}),
  });
}

/** Rebuild every card from notes, seeds and events. */
export function deriveCards(
  notes: Note[],
  events: ReviewEvent[],
  seeds: Record<string, number>,
  settings: EngineSettings,
): CardState[] {
  const byCard = new Map<string, ReviewEvent[]>();
  for (const e of events) {
    let l = byCard.get(e.card);
    if (!l) byCard.set(e.card, (l = []));
    l.push(e);
  }
  for (const l of byCard.values()) l.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));

  const out: CardState[] = [];
  for (const note of notes) {
    const types = cardTypes(note, settings);
    const seed = seeds[note.id];
    const firstSeen = types
      .map((t) => byCard.get(cardId(note.id, t))?.[0]?.t)
      .filter((x): x is number => x != null)
      .sort((a, b) => a - b)[0];
    for (const type of types) {
      const id = cardId(note.id, type);
      const evs = byCard.get(id) ?? [];
      const useSeed = seed != null && (note.studied || evs.length > 0) && (!evs.length || seed <= evs[0].t);
      let st: CardState;
      if (useSeed) {
        st = toState(id, note.id, type, seededCard(seed, seedOffset(note.id, type, settings.spreadDays)), { seeded: true });
      } else {
        st = toState(id, note.id, type, createEmptyCard(new Date(0)), {});
        if (type === 'recall' || type === 'listen') {
          // A sibling unlocks the day after the word was first seen.
          if (firstSeen == null) st.locked = true;
          else st.due = addDays(dayStart(firstSeen), 1);
        }
      }
      for (const e of evs) st = applyReview(st, e, settings.retention);
      if (evs.length) delete st.locked;
      out.push(st);
    }
  }
  return out;
}

export function isLeech(c: CardState): boolean {
  return c.lapses >= 8;
}

export type Status = 'new' | 'learning' | 'review' | 'mastered' | 'leech';

/** Word status for lists and the progress workbook. */
export function cardStatus(c: CardState, now: number): Status {
  if (isLeech(c)) return 'leech';
  if (c.state === 0) return 'new';
  if (c.state === 1 || c.state === 3) return 'learning';
  return c.due - now >= 21 * DAY ? 'mastered' : 'review';
}

const RANK: Record<Status, number> = { new: 0, learning: 1, review: 2, mastered: 3, leech: -1 };

/** Status of a note = its weakest card (leech wins). */
export function noteStatus(cards: CardState[], now: number): Status {
  if (!cards.length) return 'new';
  const st = cards.filter((c) => !c.locked).map((c) => cardStatus(c, now));
  if (st.includes('leech')) return 'leech';
  if (!st.length) return 'new';
  return st.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
}

export function gradeName(r: Grade): string {
  return ['', 'Again', 'Hard', 'Good', 'Easy'][r];
}

/** Next interval for each grade, for the buttons. */
export function previewIntervals(s: CardState, now: number, retention: number): Record<Grade, number> {
  const out = {} as Record<Grade, number>;
  for (const r of [1, 2, 3, 4] as Grade[]) out[r] = applyReview(s, { r, t: now }, retention).due - now;
  return out;
}

export function formatInterval(ms: number): string {
  const m = ms / 60000;
  if (m < 60) return `${Math.max(1, Math.round(m))}m`;
  const h = m / 60;
  if (h < 24) return `${Math.round(h)}h`;
  const d = h / 24;
  if (d < 30) return `${Math.round(d)}d`;
  if (d < 365) return `${Math.round(d / 30)}mo`;
  return `${(d / 365).toFixed(1)}y`;
}
