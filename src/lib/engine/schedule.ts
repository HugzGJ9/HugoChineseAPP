// Card states are derived data: notes + seeds + review events → FSRS state of every card.
// Every device replays the same events through the same scheduler, so they agree.
import { createEmptyCard, fsrs, generatorParameters, Rating, type Card, type FSRS } from 'ts-fsrs';
import type { CardState, CardType, Grade, Note, ReviewEvent, StatusMark } from '../types';
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

/** Longest alias chain followed (a→b→c…); also stops cycles left by renames that were reverted. */
const MAX_ALIAS_DEPTH = 10;

/**
 * Current note id for an id that may have been renamed in Excel (VocabFile.aliases).
 * A current note id is never redirected (the rename was reverted); an id that leads to no current note stays as is.
 */
export function resolveNoteId(id: string, aliases: Record<string, string>, noteIds: Set<string>): string {
  let cur = id;
  for (let i = 0; i < MAX_ALIAS_DEPTH; i++) {
    if (noteIds.has(cur)) return cur;
    const next = aliases[cur];
    if (next == null) return id;
    cur = next;
  }
  return noteIds.has(cur) ? cur : id;
}

/**
 * Events with their `card` pointed at the renamed note. A view for deriving cards and stats only: changed events are
 * copies, the stored and uploaded events keep their original card ids.
 */
export function resolveEventCards(events: ReviewEvent[], aliases: Record<string, string>, noteIds: Set<string>): ReviewEvent[] {
  if (!aliases || !Object.keys(aliases).length) return events;
  const memo = new Map<string, string>();
  return events.map((e) => {
    const note = noteOfCard(e.card);
    let to = memo.get(note);
    if (to == null) memo.set(note, (to = resolveNoteId(note, aliases, noteIds)));
    return to === note ? e : { ...e, card: `${to}#${typeOfCard(e.card)}` };
  });
}

/** Marks with their `note` pointed at the renamed note. A view only, like resolveEventCards: stored marks keep their ids. */
export function resolveMarkNotes(marks: StatusMark[], aliases: Record<string, string>, noteIds: Set<string>): StatusMark[] {
  if (!aliases || !Object.keys(aliases).length || !marks.length) return marks;
  const memo = new Map<string, string>();
  return marks.map((m) => {
    let to = memo.get(m.note);
    if (to == null) memo.set(m.note, (to = resolveNoteId(m.note, aliases, noteIds)));
    return to === m.note ? m : { ...m, note: to };
  });
}

/** Replay order of events and marks: time, then id, so every device gets the same order. */
const byTimeThenId = (a: { t: number; id: string }, b: { t: number; id: string }) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Per note: the latest "known"/"relearn" mark and the latest "suspend"/"unsuspend" mark. Unknown kinds are ignored. */
export function latestMarks(marks: StatusMark[]): Map<string, { status?: StatusMark; suspend?: StatusMark }> {
  const out = new Map<string, { status?: StatusMark; suspend?: StatusMark }>();
  const later = (a: StatusMark | undefined, b: StatusMark) => (!a || byTimeThenId(a, b) < 0 ? b : a);
  for (const m of marks) {
    const slot = m.a === 'known' || m.a === 'relearn' ? 'status' : m.a === 'suspend' || m.a === 'unsuspend' ? 'suspend' : null;
    if (!slot) continue;
    let e = out.get(m.note);
    if (!e) out.set(m.note, (e = {}));
    e[slot] = later(e[slot], m);
  }
  return out;
}

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
    ...carried(s),
  });
}

/** Fields set by marks, kept through every review. */
function carried(s: CardState): Partial<CardState> {
  return {
    ...(s.seeded ? { seeded: true } : {}),
    ...(s.suspended ? { suspended: true } : {}),
    ...(s.mark ? { mark: s.mark } : {}),
    ...(s.leechBase != null ? { leechBase: s.leechBase } : {}),
  };
}

/** "I know this": first check 90–119 days after the mark, spread per card so marked words don't all come due together. */
export const KNOWN_DAYS = 90;
export const KNOWN_SPREAD = 30;

export function knownDays(cardIdStr: string): number {
  return KNOWN_DAYS + (parseInt(fnv1a(cardIdStr), 16) % KNOWN_SPREAD);
}

/** Apply one status mark set by Hugo. Deterministic: depends only on the card, the mark and the settings. */
export function applyMark(s: CardState, m: Pick<StatusMark, 'a' | 't'>, settings: EngineSettings): CardState {
  switch (m.a) {
    case 'known': {
      const days = knownDays(s.id);
      const out: CardState = {
        ...s,
        state: 2,
        due: addDays(dayStart(m.t), days),
        stability: days,
        scheduledDays: days,
        learningSteps: 0,
        difficulty: s.state === 0 ? 5 : s.difficulty,
        last: m.t,
        reps: Math.max(s.reps, 1),
        first: s.first ?? m.t,
        leechBase: s.lapses,
        mark: { a: 'known', t: m.t },
      };
      delete out.locked;
      return out;
    }
    case 'relearn': {
      const next = scheduler(settings.retention).next(createEmptyCard(new Date(m.t)), new Date(m.t), Rating.Again).card;
      return toState(s.id, s.note, s.type, { ...next, reps: s.reps, lapses: s.lapses }, {
        nEvents: s.nEvents,
        first: s.first ?? m.t,
        ...carried(s),
        leechBase: s.lapses,
        mark: { a: 'relearn', t: m.t },
      });
    }
    case 'suspend':
      return { ...s, suspended: true };
    case 'unsuspend': {
      const out = { ...s };
      delete out.suspended;
      return out;
    }
    default:
      // A kind added by a newer app version: kept in storage, ignored here.
      return s;
  }
}

type Step = { kind: 'e'; t: number; id: string; e: ReviewEvent } | { kind: 'm'; t: number; id: string; m: StatusMark };

/** Rebuild every card from notes, seeds, review events and status marks (marks: alias-resolved, per note). */
export function deriveCards(
  notes: Note[],
  events: ReviewEvent[],
  seeds: Record<string, number>,
  settings: EngineSettings,
  marks: StatusMark[] = [],
): CardState[] {
  const byCard = new Map<string, ReviewEvent[]>();
  for (const e of events) {
    let l = byCard.get(e.card);
    if (!l) byCard.set(e.card, (l = []));
    l.push(e);
  }
  for (const l of byCard.values()) l.sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1));
  const byNote = new Map<string, StatusMark[]>();
  for (const m of marks) {
    let l = byNote.get(m.note);
    if (!l) byNote.set(m.note, (l = []));
    l.push(m);
  }

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
      // Green rows vs marks: the later one wins. When the seed is used, "known"/"relearn" set before it are skipped.
      const ms = (byNote.get(note.id) ?? []).filter((m) => !useSeed || m.t >= seed || (m.a !== 'known' && m.a !== 'relearn'));
      if (!ms.length) {
        for (const e of evs) st = applyReview(st, e, settings.retention);
      } else {
        const steps: Step[] = [
          ...evs.map((e): Step => ({ kind: 'e', t: e.t, id: e.id, e })),
          ...ms.map((m): Step => ({ kind: 'm', t: m.t, id: m.id, m })),
        ].sort(byTimeThenId);
        for (const x of steps) st = x.kind === 'e' ? applyReview(st, x.e, settings.retention) : applyMark(st, x.m, settings);
      }
      if (evs.length) delete st.locked;
      out.push(st);
    }
  }
  return out;
}

/** 8+ lapses since the word was last marked "I know this" / "Relearn" (the lapse count itself is never erased). */
export function isLeech(c: CardState): boolean {
  return c.lapses - (c.leechBase ?? 0) >= 8;
}

export type Status = 'new' | 'learning' | 'review' | 'mastered' | 'leech' | 'suspended';

/** Word status for lists and the progress workbook. */
export function cardStatus(c: CardState, now: number): Status {
  if (c.suspended) return 'suspended';
  if (isLeech(c)) return 'leech';
  if (c.state === 0) return 'new';
  if (c.state === 1 || c.state === 3) return 'learning';
  return c.due - now >= 21 * DAY ? 'mastered' : 'review';
}

const RANK: Record<Status, number> = { new: 0, learning: 1, review: 2, mastered: 3, leech: -1, suspended: -2 };

/** Status of a note = its weakest card that has been studied (suspended, then leech, win); new until any card is studied. */
export function noteStatus(cards: CardState[], now: number): Status {
  const st = cards.filter((c) => !c.locked).map((c) => cardStatus(c, now));
  if (st.includes('suspended')) return 'suspended';
  if (st.includes('leech')) return 'leech';
  const started = st.filter((s) => s !== 'new');
  if (!started.length) return 'new';
  return started.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));
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
