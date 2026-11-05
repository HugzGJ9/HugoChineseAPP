import type { CardState, Note, ReviewEvent } from './types';
import { addDays, dayKey, dayStart, noteOfCard, noteStatus, type Status, DAY } from './engine/schedule';

export function streak(events: ReviewEvent[], now: number): number {
  const days = new Set(events.map((e) => dayKey(e.t)));
  let n = 0;
  let t = dayStart(now);
  if (!days.has(dayKey(t))) t = addDays(t, -1);
  while (days.has(dayKey(t))) {
    n++;
    t = addDays(t, -1);
  }
  return n;
}

export interface DayRow {
  key: string;
  start: number;
  reviews: number;
  newWords: number;
  correct: number;
  ms: number;
  byDevice: Record<string, number>;
}

/** Per-day figures for the last `days` days (oldest first). */
export function daily(events: ReviewEvent[], days: number, now: number): DayRow[] {
  const firstOfNote = new Map<string, number>();
  for (const e of events) {
    const n = noteOfCard(e.card);
    const f = firstOfNote.get(n);
    if (f == null || e.t < f) firstOfNote.set(n, e.t);
  }
  const rows: DayRow[] = [];
  const index = new Map<string, DayRow>();
  for (let i = days - 1; i >= 0; i--) {
    const start = addDays(dayStart(now), -i);
    const row = { key: dayKey(start), start, reviews: 0, newWords: 0, correct: 0, ms: 0, byDevice: {} };
    rows.push(row);
    index.set(row.key, row);
  }
  for (const e of events) {
    const row = index.get(dayKey(e.t));
    if (!row) continue;
    row.reviews++;
    if (e.r > 1) row.correct++;
    row.ms += Math.min(e.d, 120000);
    row.byDevice[e.dev] = (row.byDevice[e.dev] ?? 0) + 1;
  }
  for (const [, t] of firstOfNote) {
    const row = index.get(dayKey(t));
    if (row) row.newWords++;
  }
  return rows;
}

/** Share of reviews of known cards (not first sightings) answered Hard or better, over the last 30 days. */
export function retention30(events: ReviewEvent[], now: number): number | null {
  const since = now - 30 * DAY;
  const seen = new Set<string>();
  let n = 0;
  let ok = 0;
  for (const e of [...events].sort((a, b) => a.t - b.t)) {
    const first = !seen.has(e.card);
    seen.add(e.card);
    if (e.t < since || first) continue;
    n++;
    if (e.r > 1) ok++;
  }
  return n ? ok / n : null;
}

/** Cards falling due on each of the next `days` days. */
export function forecast(cards: CardState[], days: number, now: number): number[] {
  const out = new Array(days).fill(0);
  const start = dayStart(now);
  for (const c of cards) {
    if (c.locked || c.state === 0) continue;
    const d = Math.floor((c.due - start) / DAY);
    out[Math.max(0, Math.min(days - 1, d))] += d < days ? 1 : 0;
  }
  return out;
}

export function statusCounts(notes: Note[], cardsByNote: Map<string, CardState[]>, now: number): Record<Status, number> {
  const out: Record<Status, number> = { new: 0, learning: 0, review: 0, mastered: 0, leech: 0 };
  for (const n of notes) out[noteStatus(cardsByNote.get(n.id) ?? [], now)]++;
  return out;
}

export function groupCards(cards: Iterable<CardState>): Map<string, CardState[]> {
  const m = new Map<string, CardState[]>();
  for (const c of cards) {
    let l = m.get(c.note);
    if (!l) m.set(c.note, (l = []));
    l.push(c);
  }
  return m;
}
