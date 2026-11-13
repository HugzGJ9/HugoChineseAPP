// Write intents (plan 2026-11-08 D6): before the app uploads statuses into the workbook, this device records what the
// upload changes, row by row (kv excelIntent, local to the device, never synced or backed up). Every import of the
// workbook (Graph, the PC folder, a re-import after sync) applies the live intents, so the app's own write is never taken
// for an Excel edit, even when the upload's answer was lost or the import runs on top of another device's list.
// An intent is dropped when its upload got an HTTP error answer (it didn't land), when the shared list holds that content
// or a later one, when this device has no sync and has imported it, or after 24 hours.
import { kvGet, kvSet } from './db';
import type { Explained, WorkbookSource } from './types';

/** Where statuses are written (plan Q1, Hugo's choice): into the workbook itself, not into the "(app)" copy. */
export const WRITE_TARGET: 'original' | 'copy' = 'original';

export interface WriteIntent {
  /** quickXorHash of the uploaded (patched) bytes. */
  qxh: string;
  /** When the upload started (also the intent's id). */
  at: number;
  /** OneDrive item written. */
  item: string;
  /** Row key → [class before, status written, mark time]. */
  rows: Explained;
  /** The server's lastModifiedDateTime of the upload, once its answer came back. */
  server?: number;
}

const KEY = 'excelIntent';
export const INTENT_TTL = 24 * 3600000;

async function all(): Promise<WriteIntent[]> {
  const v = await kvGet<WriteIntent[] | null>(KEY, null);
  return Array.isArray(v) ? v.filter((i) => i && typeof i.qxh === 'string' && typeof i.at === 'number' && i.rows) : [];
}

/** Intents younger than 24 h, oldest first (older ones are forgotten on the way). */
export async function liveIntents(now = Date.now()): Promise<WriteIntent[]> {
  const list = await all();
  const live = list.filter((i) => now - i.at < INTENT_TTL && i.at <= now + INTENT_TTL);
  if (live.length !== list.length) await kvSet(KEY, live);
  return live.sort((a, b) => a.at - b.at);
}

/** The rows of every live intent, for an import (a later intent wins a row); undefined when there are none. */
export async function liveExplained(now = Date.now()): Promise<Explained | undefined> {
  const live = await liveIntents(now);
  if (!live.length) return undefined;
  const out: Explained = {};
  for (const i of live) Object.assign(out, i.rows);
  return out;
}

export async function addIntent(i: WriteIntent): Promise<void> {
  await kvSet(KEY, [...(await all()).filter((x) => x.at !== i.at), i]);
}

export async function updateIntent(at: number, patch: Partial<WriteIntent>): Promise<void> {
  await kvSet(
    KEY,
    (await all()).map((x) => (x.at === at ? { ...x, ...patch, at } : x)),
  );
}

/** The upload got an HTTP error answer: it didn't land. */
export async function dropIntent(at: number): Promise<void> {
  const list = await all();
  const next = list.filter((x) => x.at !== at);
  if (next.length !== list.length) await kvSet(KEY, next);
}

/**
 * A list known to hold this content (the shared list; or, without sync, the list imported here): drop the intents it
 * covers. Covered = the same content, or a later version than the upload (by the server's time, known only when the
 * upload's answer came back).
 */
export async function dropCovered(source: Pick<WorkbookSource, 'qxh' | 'modified'> | undefined): Promise<number> {
  if (!source) return 0;
  const list = await all();
  const next = list.filter((i) => !((source.qxh && source.qxh === i.qxh) || (i.server != null && (source.modified ?? 0) > i.server)));
  if (next.length !== list.length) await kvSet(KEY, next);
  return list.length - next.length;
}
