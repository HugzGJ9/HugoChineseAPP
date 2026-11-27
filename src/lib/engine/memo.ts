// Per-word memo of derived cards (plan 2026-11-26-boot-and-guards D1–D5, decisions STORE-2). A cache, never truth:
// review events and marks stay the source of truth, and every card here came out of the unchanged `deriveCards`.
//
// For each word (note) the memo keeps its cards with a fingerprint (fp) of everything `deriveCards` reads for it:
// kind, studied, its seed time, its events (id, card type, t, r) and its marks of every kind (id, a, t), taken from the
// alias-resolved views the store passes in. The note id is the memo key, so it needs no place in the fp. Everything
// else `deriveCards` depends on is the same for every word and goes into the env: the engine settings (retention,
// spreadDays, recall, listen), the time zone (day starts, sibling unlock and "I know this" dates are local time) and the
// app build (any engine change ships in a new build, so no version number has to be remembered). Cards are reused only
// when both the env and the word's fp match; any other word is replayed, in batches of words, by `deriveCards`.
// So a sync merge that deletes, adds or moves events between words (aliases) needs no bookkeeping: those words simply
// no longer match their fp.
//
// Only full-list derivations (store `init()` and `rebuild()`) produce and store a memo (D3). `recordReview` and
// `rebuildNote` update single cards in place and leave the memo alone; their words no longer match their fp and are
// replayed by the next full derivation. So every stored (fp, cards) pair came out of `deriveCards` together.
//
// Stored as one device-only kv row `cardsMemo` = { v: 1, env, at, json } (no Dexie bump, STORE-1): never synced, never
// backed up, ignored by older app versions. A missing, foreign or broken row decodes to null and costs one full replay.
//
// If `deriveCards` ever reads something new (a Note field, a mark field, a clock), it must go into the fp or the env:
// `memo.test.ts` has a field guard and a purity guard for that.
import type { CardState, Note, ReviewEvent, StatusMark } from '../types';
import { cardTypes, deriveCards, noteOfCard, typeOfCard, type EngineSettings } from './schedule';

declare const __APP_VERSION__: string;

export interface MemoEntry {
  fp: string;
  cards: CardState[];
}
export interface CardMemo {
  env: string;
  notes: Map<string, MemoEntry>;
}
export interface StoredMemo {
  v: 1;
  env: string;
  at: number;
  json: string;
}
export interface DeriveResult {
  cards: CardState[];
  memo: CardMemo;
  /** Words replayed through `deriveCards` (the rest came from the memo). */
  replayed: number;
  /** No usable memo (none, or another env): every word was replayed. */
  full: boolean;
}

/** Words replayed per `deriveCards` call; the async variant may yield between batches. */
const BATCH = 32;
/** Words fingerprinted between two yield points when nothing needs replaying. */
const SCAN = 512;

function appBuild(): string {
  return typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
}

/** Time zone name plus the UTC offsets of 1 Jan and 1 Jul (a zone whose rules changed, or no Intl). */
export function tzKey(): string {
  let zone = '';
  try {
    zone = Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    zone = '';
  }
  return `${zone}|${new Date(2001, 0, 1).getTimezoneOffset()}|${new Date(2001, 6, 1).getTimezoneOffset()}`;
}

/** Everything every word's cards depend on. `build` and `tz` are parameters for the tests only. */
export function memoEnv(s: EngineSettings, build = appBuild(), tz = tzKey()): string {
  return `1|${build}|${tz}|${s.retention}|${s.spreadDays}|${s.recall ? 1 : 0}|${s.listen ? 1 : 0}`;
}

/** cyrb53, a 53-bit string hash (public domain, bryc), in base 36. */
export function cyrb53(str: string, seed = 0): string {
  let h1 = 0xdeadbeef ^ seed;
  let h2 = 0x41c6ce57 ^ seed;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

const byTimeThenId = (a: { t: number; id: string }, b: { t: number; id: string }) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * What the fingerprint of one word hashes: `kind|studied 0/1|seed|E|M`, E = its events `id,type,t,r` joined by `;`,
 * M = its marks `id,a,t` joined by `;`, both sorted by (t, id) (the lists are sorted here, in place).
 */
export function fingerprintText(note: Note, seed: number | undefined, events: ReviewEvent[] = [], marks: StatusMark[] = []): string {
  events.sort(byTimeThenId);
  marks.sort(byTimeThenId);
  const e = events.map((x) => `${x.id},${typeOfCard(x.card)},${x.t},${x.r}`).join(';');
  const m = marks.map((x) => `${x.id},${x.a},${x.t}`).join(';');
  return `${note.kind}|${note.studied ? 1 : 0}|${seed ?? ''}|${e}|${m}`;
}

/** Fingerprint of one word: cyrb53 of `fingerprintText` (V8 builds and hashes that string faster than a streamed hash). */
export function fingerprint(note: Note, seed: number | undefined, events: ReviewEvent[] = [], marks: StatusMark[] = []): string {
  return cyrb53(fingerprintText(note, seed, events, marks));
}

/** The shared walk: yields after each replayed batch and every SCAN words, so the async driver can give way. */
function* walk(
  notes: Note[],
  events: ReviewEvent[],
  seeds: Record<string, number>,
  s: EngineSettings,
  marks: StatusMark[],
  memo: CardMemo | null,
): Generator<void, DeriveResult, void> {
  const env = memoEnv(s);
  const old = memo && memo.env === env ? memo.notes : null;
  const ids = new Set(notes.map((n) => n.id));
  // Events and marks of words not in `notes` are ignored, as in deriveCards.
  const evBy = new Map<string, ReviewEvent[]>();
  for (const e of events) {
    const n = noteOfCard(e.card);
    if (!ids.has(n)) continue;
    let l = evBy.get(n);
    if (!l) evBy.set(n, (l = []));
    l.push(e);
  }
  const mBy = new Map<string, StatusMark[]>();
  for (const m of marks) {
    if (!ids.has(m.note)) continue;
    let l = mBy.get(m.note);
    if (!l) mBy.set(m.note, (l = []));
    l.push(m);
  }

  const next = new Map<string, MemoEntry>();
  const slots: CardState[][] = new Array(notes.length);
  const fps: string[] = new Array(notes.length);
  let pending: number[] = [];
  let inBatch = new Set<string>();
  let replayed = 0;

  const flush = () => {
    const evs: ReviewEvent[] = [];
    const ms: StatusMark[] = [];
    for (const i of pending) {
      const id = notes[i].id;
      for (const e of evBy.get(id) ?? []) evs.push(e);
      for (const m of mBy.get(id) ?? []) ms.push(m);
    }
    const out = deriveCards(
      pending.map((i) => notes[i]),
      evs,
      seeds,
      s,
      ms,
    );
    // deriveCards emits each note's cards together, in `notes` order, one per card type.
    let k = 0;
    for (const i of pending) {
      const n = cardTypes(notes[i], s).length;
      const cards = out.slice(k, k + n);
      k += n;
      slots[i] = cards;
      next.set(notes[i].id, { fp: fps[i], cards });
    }
    replayed += pending.length;
    pending = [];
    inBatch = new Set();
  };

  for (let i = 0; i < notes.length; i++) {
    const note = notes[i];
    const fp = fingerprint(note, seeds[note.id], evBy.get(note.id), mBy.get(note.id));
    const hit = old?.get(note.id);
    if (hit && hit.fp === fp) {
      slots[i] = hit.cards;
      next.set(note.id, hit);
    } else {
      // The same id twice (never expected): its events must not go into one deriveCards call twice.
      if (inBatch.has(note.id)) flush();
      fps[i] = fp;
      pending.push(i);
      inBatch.add(note.id);
      if (pending.length >= BATCH) {
        flush();
        yield;
      }
    }
    if (i % SCAN === SCAN - 1) yield;
  }
  if (pending.length) flush();

  const cards: CardState[] = [];
  for (const l of slots) for (const c of l) cards.push(c);
  return { cards, memo: { env, notes: next }, replayed, full: !old };
}

/** Cards of every note, reusing the memo's cards of words whose fingerprint and env match. Synchronous. */
export function deriveWithMemo(
  notes: Note[],
  events: ReviewEvent[],
  seeds: Record<string, number>,
  s: EngineSettings,
  marks: StatusMark[],
  memo: CardMemo | null,
): DeriveResult {
  const it = walk(notes, events, seeds, s, marks, memo);
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
  }
}

/** Give the main thread a turn: `scheduler.yield()` where it exists, else a MessageChannel message (never setTimeout). */
export function yieldToMain(): Promise<void> {
  const sch = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
  if (sch && typeof sch.yield === 'function') return sch.yield();
  if (typeof MessageChannel === 'undefined') return Promise.resolve();
  return new Promise((resolve) => {
    const ch = new MessageChannel();
    ch.port1.onmessage = () => {
      ch.port1.close();
      ch.port2.close();
      resolve();
    };
    ch.port2.postMessage(null);
  });
}

/** `deriveWithMemo` in slices: yields only when a slice ran for `sliceMs` or more, so a warm or small start never yields. */
export async function deriveWithMemoAsync(
  notes: Note[],
  events: ReviewEvent[],
  seeds: Record<string, number>,
  s: EngineSettings,
  marks: StatusMark[],
  memo: CardMemo | null,
  sliceMs = 30,
): Promise<DeriveResult> {
  const it = walk(notes, events, seeds, s, marks, memo);
  let t0 = performance.now();
  for (;;) {
    const r = it.next();
    if (r.done) return r.value;
    if (performance.now() - t0 >= sliceMs) {
      await yieldToMain();
      t0 = performance.now();
    }
  }
}

/** Every number in the card (and its mark) is finite: JSON would turn NaN or Infinity into null. */
function finiteCard(c: CardState): boolean {
  for (const v of Object.values(c)) {
    if (typeof v === 'number' && !Number.isFinite(v)) return false;
    if (v && typeof v === 'object') for (const w of Object.values(v)) if (typeof w === 'number' && !Number.isFinite(w)) return false;
  }
  return true;
}

/** The kv row. A word with a non-finite number is left out (replayed at the next start). */
export function encodeMemo(m: CardMemo, at: number): StoredMemo {
  const entries: [string, string, CardState[]][] = [];
  for (const [id, e] of m.notes) if (e.cards.every(finiteCard)) entries.push([id, e.fp, e.cards]);
  return { v: 1, env: m.env, at, json: JSON.stringify(entries) };
}

const NUMS = ['due', 'stability', 'difficulty', 'scheduledDays', 'learningSteps', 'reps', 'lapses', 'last', 'nEvents'] as const;

function validCard(c: unknown, note: string): c is CardState {
  if (!c || typeof c !== 'object') return false;
  const x = c as Record<string, unknown>;
  if (typeof x.id !== 'string' || x.note !== note || typeof x.type !== 'string') return false;
  for (const k of NUMS) if (typeof x[k] !== 'number' || !Number.isFinite(x[k])) return false;
  return x.state === 0 || x.state === 1 || x.state === 2 || x.state === 3;
}

/** The memo in a kv row, or null unless it is a well-formed v1 row for this env. Never throws. */
export function decodeMemo(row: unknown, env: string): CardMemo | null {
  try {
    if (!row || typeof row !== 'object') return null;
    const r = row as Partial<StoredMemo>;
    if (r.v !== 1 || r.env !== env || typeof r.json !== 'string') return null;
    const list: unknown = JSON.parse(r.json);
    if (!Array.isArray(list)) return null;
    const notes = new Map<string, MemoEntry>();
    for (const entry of list) {
      if (!Array.isArray(entry) || entry.length !== 3) return null;
      const [id, fp, cards] = entry as unknown[];
      if (typeof id !== 'string' || typeof fp !== 'string' || !Array.isArray(cards)) return null;
      if (!cards.every((c) => validCard(c, id))) return null;
      notes.set(id, { fp, cards: cards as CardState[] });
    }
    return { env, notes };
  } catch {
    return null;
  }
}
