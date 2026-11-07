// Saved explanations: one kv row `ex:<note id>|<lang>` each, with the device that made it and its (frozen) month.
// Own entries are uploaded month by month (kv explainDirty, apart from the review and mark queues, so older app versions
// never touch it). This is a cache of external content: it never touches cards, events or marks.
import { db, kvGet, kvSet, monthKey } from '../db';
import { getState, notifyLocalChange, type Lang } from '../store';
import type { Note } from '../types';
import { ClaudeError, explainWithClaude, getClaudeKey } from './claude';
import { buildUserPrompt, PROMPT_VERSION, systemPrompt } from './prompt';
import type { ExplainEntry, StoredEntry } from './types';

const PREFIX = 'ex:';
const DIRTY = 'explainDirty';

export const entryKey = (noteId: string, lang: Lang) => `${noteId}|${lang}`;
const rowKey = (k: string) => `${PREFIX}${k}`;

/** Price per million tokens [input, output], US dollars. Approximate: not checked against the live price list. */
export const PRICES: Record<'sonnet' | 'haiku', [number, number]> = { sonnet: [3, 15], haiku: [1, 5] };

// ---------- change listeners ----------

const listeners = new Set<() => void>();
export function onExplainChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export function emitExplainChange(): void {
  for (const l of listeners) l();
}
let progressTimer: ReturnType<typeof setTimeout> | undefined;
/** Progress updates, at most about every 300 ms. */
function emitProgress(): void {
  if (progressTimer) return;
  progressTimer = setTimeout(() => {
    progressTimer = undefined;
    emitExplainChange();
  }, 300);
}

// ---------- reading ----------

/** Strip the local-only fields. */
export function toEntry(s: StoredEntry): ExplainEntry {
  const { dev: _d, mo: _m, own: _o, ...e } = s;
  return e;
}

/** Ids this note had before it was renamed in Excel (the word list's aliases). */
function oldIds(noteId: string): string[] {
  const aliases = getState().meta?.aliases ?? {};
  return Object.keys(aliases).filter((old) => aliases[old] === noteId && old !== noteId);
}

/** The saved explanation of a note in one language (also under the ids the note had before a rename). */
export async function getExplanation(note: Note, lang: Lang): Promise<StoredEntry | null> {
  const own = await kvGet<StoredEntry | null>(rowKey(entryKey(note.id, lang)), null);
  if (own) return own;
  let best: StoredEntry | null = null;
  for (const old of oldIds(note.id)) {
    const e = await kvGet<StoredEntry | null>(rowKey(entryKey(old, lang)), null);
    if (e && (!best || e.at > best.at)) best = e;
  }
  return best;
}

async function allStored(): Promise<StoredEntry[]> {
  const rows = await db.kv.where('k').startsWith(PREFIX).toArray();
  return rows.map((r) => r.v as StoredEntry).filter((v) => v && typeof v === 'object' && typeof v.k === 'string');
}

// ---------- asking ----------

interface Job {
  since: number;
  chars: number;
  error?: ClaudeError;
  promise?: Promise<StoredEntry>;
}
const jobs = new Map<string, Job>();

/** The request in flight (or the last one that failed) for this note and language. */
export function explainJob(note: Note, lang: Lang): { since: number; chars: number; error?: ClaudeError } | null {
  const j = jobs.get(entryKey(note.id, lang));
  return j ? { since: j.since, chars: j.chars, ...(j.error ? { error: j.error } : {}) } : null;
}

/** Hanzi of the words he learns next to this one (same related-words group or synonym set). */
function relatedWords(note: Note): string[] {
  if (!note.group && !note.set) return [];
  const out: string[] = [];
  for (const n of getState().notes) {
    if (n.id === note.id || out.includes(n.hanzi)) continue;
    if ((note.group && n.group === note.group) || (note.set && n.set === note.set)) out.push(n.hanzi);
    if (out.length >= 6) break;
  }
  return out;
}

/**
 * The explanation of a note, asking Claude when none is saved (or always, with `again`). Requests for the same note and
 * language share one call; it goes on when the panel is closed.
 */
export function requestExplanation(note: Note, lang: Lang, opts: { again?: boolean; dict?: string } = {}): Promise<StoredEntry> {
  const k = entryKey(note.id, lang);
  const running = jobs.get(k)?.promise;
  if (running) return running;
  const job: Job = { since: Date.now(), chars: 0 };
  const promise = (async () => {
    if (!opts.again) {
      const have = await getExplanation(note, lang);
      if (have) return have;
    }
    const key = await getClaudeKey();
    if (!key) throw new ClaudeError('nokey');
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new ClaudeError('offline');
    const prev = await getExplanation(note, lang);
    const user = buildUserPrompt(note, lang, { dict: opts.dict, related: relatedWords(note) });
    const r = await explainWithClaude(key, systemPrompt(lang), user, (chars) => {
      job.chars = chars;
      emitProgress();
    });
    // Newer than any saved one, so it wins on every device.
    const at = Math.max(Date.now(), (prev?.at ?? 0) + 1);
    const entry: StoredEntry = {
      k,
      hz: note.hanzi,
      py: note.pinyin,
      lang,
      at,
      model: r.model,
      pv: PROMPT_VERSION,
      u: r.usage,
      x: r.x,
      dev: getState().device,
      mo: monthKey(at),
      own: true,
    };
    await saveOwn(entry);
    return entry;
  })();
  job.promise = promise;
  jobs.set(k, job);
  emitExplainChange();
  promise.then(
    () => {
      if (jobs.get(k) === job) jobs.delete(k);
      emitExplainChange();
    },
    (e: unknown) => {
      if (jobs.get(k) !== job) return;
      job.error = e instanceof ClaudeError ? e : new ClaudeError('other');
      job.promise = undefined;
      emitExplainChange();
    },
  );
  return promise.catch((e: unknown) => {
    throw e instanceof ClaudeError ? e : new ClaudeError('other');
  });
}

/** Save an entry made on this device and queue its month for upload, together. */
async function saveOwn(entry: StoredEntry): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    await kvSet(rowKey(entry.k), entry);
    const dirty = await kvGet<Record<string, number>>(DIRTY, {});
    dirty[entry.mo] = Math.max(Date.now(), (dirty[entry.mo] ?? 0) + 1);
    await kvSet(DIRTY, dirty);
  });
  notifyLocalChange();
}

// ---------- sync side ----------

/**
 * Take in the entries of another device's file: per key, the newest `at` wins (on a tie, the larger device id).
 * Nothing is ever deleted. Returns whether anything changed.
 */
export async function mergeExplanations(device: string, month: string, entries: ExplainEntry[]): Promise<boolean> {
  if (!entries.length) return false;
  const changed = await db.transaction('rw', db.kv, async () => {
    const rows = await db.kv.bulkGet(entries.map((e) => rowKey(e.k)));
    const put: { k: string; v: StoredEntry }[] = [];
    const taken = new Map<string, StoredEntry>();
    entries.forEach((e, i) => {
      const cur = taken.get(e.k) ?? (rows[i]?.v as StoredEntry | undefined);
      if (cur && (cur.at > e.at || (cur.at === e.at && cur.dev >= device))) return;
      const v: StoredEntry = { ...toEntry(e as StoredEntry), dev: device, mo: month };
      taken.set(e.k, v);
      put.push({ k: rowKey(e.k), v });
    });
    if (put.length) await db.kv.bulkPut(put);
    return put.length > 0;
  });
  if (changed) emitExplainChange();
  return changed;
}

/** This device's entries of one month, for its sync file (sorted by key). */
export async function ownExplanations(month: string): Promise<ExplainEntry[]> {
  return (await allStored())
    .filter((e) => e.own && e.mo === month)
    .map(toEntry)
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
}

/** Months of this device's explanations saved since the last upload: month → stamp. */
export async function dirtyExplainMonths(): Promise<Record<string, number>> {
  return { ...(await kvGet<Record<string, number>>(DIRTY, {})) };
}

/** Forget a month once uploaded, unless it changed again after `stamp`. */
export async function clearExplainDirty(month: string, stamp: number): Promise<void> {
  await db.transaction('rw', db.kv, async () => {
    const dirty = await kvGet<Record<string, number>>(DIRTY, {});
    if ((dirty[month] ?? 0) <= stamp) delete dirty[month];
    await kvSet(DIRTY, dirty);
  });
}

/** Saved explanations, and what this device asked for this month (cost approximate, from the token counts). */
export async function explainUsage(now = Date.now()): Promise<{ saved: number; mineThisMonth: number; costThisMonth: number }> {
  const all = await allStored();
  const month = monthKey(now);
  let mine = 0;
  let cost = 0;
  for (const e of all) {
    if (!e.own || e.mo !== month) continue;
    mine++;
    if (!e.u) continue;
    const [pi, po] = /haiku/i.test(e.model) ? PRICES.haiku : PRICES.sonnet;
    cost += (e.u[0] * pi + e.u[1] * po) / 1e6;
  }
  return { saved: all.length, mineThisMonth: mine, costThisMonth: Math.round(cost * 10000) / 10000 };
}
