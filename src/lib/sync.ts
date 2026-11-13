// Sync between devices through a store only Hugo can read (syncstore.ts): OneDrive's app folder (OneDrive › Apps › Hugo
// Chinese › data, after "Sign in with Microsoft") or a private GitHub repository. One target per device (kv syncTarget;
// absent with a GitHub link = GitHub). Both hold the same files with the same bytes:
//   vocab.json.gz                  the word list, written by the device that last imported the Excel file. It records the
//                                  workbook content it came from (source.qxh): devices share one import history (D3)
//   settings.json                  study settings shared by every device (newest wins)
//   events/<device>/<YYYY-MM>.json each device's own review log, one file per month; only that device writes it
//   marks/<device>/<YYYY-MM>.json  each device's own status marks ("I know this", "Suspend"…), same rules as the logs
//   explain/<device>/<YYYY-MM>.json.gz  each device's own saved Claude explanations (gzipped), same rules; a cache
//   devices/<device>.json          written when a device links, and again when its app version or caps change
//
// Every device replays all logs through the same scheduler, so they agree on every card.
// A device that moves from GitHub to OneDrive keeps reading GitHub (never writing it) until every device seen there has
// written to OneDrive, or until Hugo stops it: older app versions keep syncing through GitHub meanwhile.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { db, kvGet, kvSet, monthOf, type Settings } from './db';
import { clearExplainDirty, dirtyExplainMonths, mergeExplanations, normalizeExplanation, ownExplanations, type ExplainEntry } from './explain';
import type { SavedExplanation } from './explain';
import { GitHubError, repoInfo, type RepoLink } from './github';
import { mergeSameVersion, vocabAction, vocabDiffers } from './import/canonical';
import { GraphError } from './ms/graph';
import {
  clearDirty,
  clearMarkDirty,
  dirtyMarkMonths,
  dirtyMonths,
  getState,
  hasOwnEvents,
  mergeDeviceEvents,
  mergeDeviceMarks,
  onLocalChange,
  ownMonthEvents,
  ownMonthMarks,
  rebuildAll,
  renewDeviceId,
  setSync,
  setVocab,
  subscribe,
  updateSettings,
  type VocabMeta,
} from './store';
import { StoreError, githubStore, onedriveStore, type SyncLink, type SyncStore } from './syncstore';
import type { Grade, MarkKind, ReviewEvent, StatusMark, VocabFile } from './types';

export type { SyncLink } from './syncstore';

export const VOCAB_PATH = 'vocab.json.gz';
export const SETTINGS_PATH = 'settings.json';
const EVENTS_PATH = /^events\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json$/;
export const eventsPath = (device: string, month: string) => `events/${device}/${month}.json`;
const MARKS_PATH = /^marks\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json$/;
export const marksPath = (device: string, month: string) => `marks/${device}/${month}.json`;
export const EXPLAIN_PATH = /^explain\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json\.gz$/;
export const explainPath = (device: string, month: string) => `explain/${device}/${month}.json.gz`;
const DEVICE_PATH = /^devices\/([A-Za-z0-9_-]+)\.json$/;
export const devicePath = (device: string) => `devices/${device}.json`;
/** Any file that belongs to one device: its id. */
const DEVICE_OF = /^(?:devices\/([A-Za-z0-9_-]+)\.json|(?:events|marks|explain)\/([A-Za-z0-9_-]+)\/)/;

/**
 * What this app version understands, written into devices/<id>.json. 1 (or absent) = before the shared import history;
 * 2 = shared import history (source.qxh) and Excel write-back. The app warns before writing to Excel while another device
 * last reported less.
 */
export const SYNC_CAPS = 2;
declare const __APP_VERSION__: string;
const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';

// ---------- review log files ----------

const FIELDS = ['id', 'card', 'r', 't', 'd', 'm'] as const;

export function encodeEvents(device: string, month: string, events: ReviewEvent[]): string {
  const rows = [...events].sort((a, b) => a.t - b.t).map((e) => JSON.stringify([e.id, e.card, e.r, e.t, e.d, e.m]));
  return `{"device":${JSON.stringify(device)},"month":${JSON.stringify(month)},"fields":${JSON.stringify(FIELDS)},"events":[\n${rows.join(',\n')}\n]}\n`;
}

/** Columns are found through the file's `fields` header, so a later version may add or reorder them. */
export function decodeEvents(text: string, device: string): ReviewEvent[] {
  const j = JSON.parse(text) as { fields?: unknown; events?: unknown };
  if (!Array.isArray(j.events)) throw new Error('no event list');
  const fields: readonly string[] = Array.isArray(j.fields) && j.fields.every((f) => typeof f === 'string') ? (j.fields as string[]) : FIELDS;
  const [ci, cc, cr, ct, cd, cm] = FIELDS.map((f) => fields.indexOf(f));
  if (ci < 0 || cc < 0 || cr < 0 || ct < 0) throw new Error('missing columns');
  return j.events.map((row: unknown, i) => {
    const x = Array.isArray(row) ? (row as unknown[]) : [];
    const [id, card, r, t, d, m] = [x[ci], x[cc], x[cr], x[ct], cd < 0 ? 0 : x[cd], cm < 0 ? '' : x[cm]];
    if (typeof id !== 'string' || !id || typeof card !== 'string' || ![1, 2, 3, 4].includes(r as number) || typeof t !== 'number' || !Number.isFinite(t)) {
      // Refuse the whole file rather than drop a row: merging a partial file would delete that review here.
      throw new Error(`event ${i + 1} is malformed`);
    }
    return { id, card, r: r as Grade, t, d: typeof d === 'number' ? d : 0, m: typeof m === 'string' ? m : '', dev: device };
  });
}

// ---------- status mark files ----------

const MARKS_VERSION = 1;
const MARK_FIELDS = ['id', 'note', 'a', 't'] as const;

/** A marks file written by a newer app version: not applied (and its blob id not recorded) until this app is updated. */
export class MarksTooNewError extends Error {
  constructor(v: number) {
    super(`saved by a newer app version (format ${v})`);
    this.name = 'MarksTooNewError';
  }
}

export function encodeMarks(device: string, month: string, marks: StatusMark[]): string {
  const rows = [...marks].sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : 1)).map((m) => JSON.stringify([m.id, m.note, m.a, m.t]));
  return `{"device":${JSON.stringify(device)},"month":${JSON.stringify(month)},"v":${MARKS_VERSION},"fields":${JSON.stringify(MARK_FIELDS)},"marks":[\n${rows.join(',\n')}\n]}\n`;
}

/**
 * Columns are found through the `fields` header. A bad row refuses the whole file (a partial merge would delete marks);
 * a row with an action this version does not know is kept as is (the engine ignores it).
 */
export function decodeMarks(text: string, device: string): StatusMark[] {
  const j = JSON.parse(text) as { v?: unknown; fields?: unknown; marks?: unknown };
  if (typeof j.v === 'number' && j.v > MARKS_VERSION) throw new MarksTooNewError(j.v);
  if (!Array.isArray(j.marks)) throw new Error('no mark list');
  const fields: readonly string[] = Array.isArray(j.fields) && j.fields.every((f) => typeof f === 'string') ? (j.fields as string[]) : MARK_FIELDS;
  const [ci, cn, ca, ct] = MARK_FIELDS.map((f) => fields.indexOf(f));
  if (ci < 0 || cn < 0 || ca < 0 || ct < 0) throw new Error('missing columns');
  return j.marks.map((row: unknown, i) => {
    const x = Array.isArray(row) ? (row as unknown[]) : [];
    const [id, note, a, t] = [x[ci], x[cn], x[ca], x[ct]];
    if (typeof id !== 'string' || !id || typeof note !== 'string' || !note || typeof a !== 'string' || typeof t !== 'number' || !Number.isFinite(t)) {
      throw new Error(`mark ${i + 1} is malformed`);
    }
    return { id, note, a: a as MarkKind, t, dev: device };
  });
}

// ---------- explanation files ----------

const EXPLAIN_VERSION = 1;

/** An explanations file written by a newer app version: not applied (and its blob id not recorded) until this app is updated. */
export class ExplainTooNewError extends Error {
  constructor(v: number) {
    super(`saved by a newer app version (format ${v})`);
    this.name = 'ExplainTooNewError';
  }
}

/** Only the synced fields, in a fixed order (never the local dev / mo / own). */
function explainRow(e: ExplainEntry): ExplainEntry {
  return { k: e.k, hz: e.hz, py: e.py, lang: e.lang, at: e.at, model: e.model, pv: e.pv, ...(e.u ? { u: e.u } : {}), x: e.x };
}

export function encodeExplain(device: string, month: string, entries: ExplainEntry[]): Uint8Array {
  const rows = [...entries].sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : a.at - b.at)).map((e) => JSON.stringify(explainRow(e)));
  const text = `{"device":${JSON.stringify(device)},"month":${JSON.stringify(month)},"v":${EXPLAIN_VERSION},"entries":[\n${rows.join(',\n')}\n]}\n`;
  return gzipSync(strToU8(text), { level: 9, mtime: 0 });
}

/**
 * The entries of an explanations file. A malformed entry is skipped on its own: this is a cache, so a partial file
 * deletes nothing. Throws ExplainTooNewError for a newer format, and an error when there is no entry list at all.
 */
export function decodeExplain(bytes: Uint8Array): ExplainEntry[] {
  const j = JSON.parse(strFromU8(gunzipSync(bytes))) as { v?: unknown; entries?: unknown };
  if (typeof j.v === 'number' && j.v > EXPLAIN_VERSION) throw new ExplainTooNewError(j.v);
  if (!Array.isArray(j.entries)) throw new Error('no explanation list');
  const out: ExplainEntry[] = [];
  for (const raw of j.entries as unknown[]) {
    if (!raw || typeof raw !== 'object') continue;
    const e = raw as Record<string, unknown>;
    const lang = e.lang;
    if (lang !== 'en' && lang !== 'fr') continue;
    if (typeof e.k !== 'string' || !e.k.endsWith(`|${lang}`) || e.k.length <= 3) continue;
    if (typeof e.at !== 'number' || !Number.isFinite(e.at)) continue;
    const x = normalizeExplanation(e.x);
    if (!x) continue;
    const u = Array.isArray(e.u) && e.u.length === 2 && e.u.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (e.u as [number, number]) : undefined;
    out.push({
      k: e.k,
      hz: typeof e.hz === 'string' ? e.hz : '',
      py: typeof e.py === 'string' ? e.py : '',
      lang,
      at: e.at,
      model: typeof e.model === 'string' ? e.model : '',
      pv: typeof e.pv === 'number' ? e.pv : 0,
      ...(u ? { u } : {}),
      x,
    });
  }
  return out;
}

// ---------- sync key: what another device needs to join ----------

const KEY_PREFIX = 'hz1.';

export function encodeKey(l: RepoLink): string {
  const json = JSON.stringify({ o: l.owner, n: l.name, t: l.token });
  return KEY_PREFIX + btoa(unescape(encodeURIComponent(json))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function decodeKey(key: string): RepoLink | null {
  const s = key.trim().replace(/^.*#\/link\//, '');
  if (!s.startsWith(KEY_PREFIX)) return null;
  try {
    const b64 = s.slice(KEY_PREFIX.length).replace(/-/g, '+').replace(/_/g, '/');
    const j = JSON.parse(decodeURIComponent(escape(atob(b64)))) as { o?: string; n?: string; t?: string };
    return j.o && j.n && j.t ? { owner: j.o, name: j.n, token: j.t } : null;
  } catch {
    return null;
  }
}

// ---------- target ----------

export type SyncTarget = 'github' | 'onedrive';

const K_TARGET = 'syncTarget';
/** Known version tag per path: GitHub blob shas (syncShas, as before) and OneDrive eTags (syncTags). */
const knownKey = (kind: SyncStore['kind']) => (kind === 'github' ? 'syncShas' : 'syncTags');
/** When this device linked the OneDrive folder (its link stamp, as in devices/<id>.json). */
const K_OD_LINKED = 'syncOdLinkedAt';
/** caps|app last written into this device's devices file, per store. */
const K_DEV_SIG = 'syncDeviceSig';
/** What the other devices last reported (devices files) and when their files last changed. */
const K_DEVICES = 'syncDevices';
/** After a move to OneDrive: still reading GitHub, and the devices seen there that haven't written to OneDrive yet. */
const K_GH_READ = 'syncGithubRead';

interface GithubRead {
  on: boolean;
  waiting: string[];
  checked?: number;
}

interface DeviceRecord {
  caps: number;
  app?: string;
  seen?: number;
}

export function getLink(): Promise<SyncLink | null> {
  return kvGet<SyncLink | null>('syncLink', null);
}

/** Where this device syncs: OneDrive when chosen, else GitHub when a repository is linked, else nowhere. */
export async function syncTarget(): Promise<SyncTarget | null> {
  if ((await kvGet<SyncTarget | null>(K_TARGET, null)) === 'onedrive') return 'onedrive';
  return (await getLink()) ? 'github' : null;
}

/** Whether this device syncs at all. */
export async function syncLinked(): Promise<boolean> {
  return (await syncTarget()) !== null;
}

async function activeStore(): Promise<SyncStore | null> {
  const t = await syncTarget();
  if (t === 'onedrive') return onedriveStore();
  const link = t === 'github' ? await getLink() : null;
  return link ? githubStore(link) : null;
}

// ---------- hooks ----------

const rebaseHooks: (() => Promise<void>)[] = [];
/**
 * Called after a sync that replaced this device's list with an older shared one (`take-reimport`): import the workbook
 * again on top of the shared history. Registered by main.tsx (a hook, so sync.ts doesn't import the readers).
 */
export function onRebase(f: () => Promise<void>): void {
  rebaseHooks.push(f);
}

const sharedHooks: ((shared: VocabMeta) => void)[] = [];
/**
 * Called with the shared list (without its notes) whenever sync knows the store holds it: after a pull that read it,
 * and after this device pushed its own. Write-back (WP9) drops the write intents it covers.
 */
export function onSharedList(f: (shared: VocabMeta) => void): void {
  sharedHooks.push(f);
}

function sharedList(v: VocabMeta | VocabFile): void {
  const { notes: _, ...meta } = v as VocabFile;
  for (const f of sharedHooks) {
    try {
      f(meta);
    } catch {
      // a hook never stops the sync
    }
  }
}

let rebasePending = false;

async function runRebase(): Promise<void> {
  for (const f of rebaseHooks) {
    try {
      await f();
    } catch {
      // the reader reports its own errors
    }
  }
  // The re-imported list goes out at once, not after the usual pause.
  if (await kvGet<boolean>('vocabDirty', false)) void syncNow();
}

// ---------- link ----------

function deviceBody(me: string, linkedAt: number): string {
  return JSON.stringify(
    { id: me, linkedAt, agent: typeof navigator !== 'undefined' ? navigator.userAgent : '', caps: SYNC_CAPS, app: APP_VERSION },
    null,
    1,
  );
}

const devSig = () => `${SYNC_CAPS}|${APP_VERSION}`;

async function setDevSig(kind: SyncStore['kind']): Promise<void> {
  await kvSet(K_DEV_SIG, { ...(await kvGet<Record<string, string>>(K_DEV_SIG, {})), [kind]: devSig() });
}

/** Check the repository and the token, record this device in it, then run a first sync. GitHub becomes the target. */
export async function linkRepo(repo: RepoLink): Promise<void> {
  const info = await repoInfo(repo);
  if (!info.private) {
    throw new Error(`${info.full_name} is public. Sync needs a private repository, because it holds your words and reviews.`);
  }
  const link: SyncLink = { ...repo, owner: info.full_name.split('/')[0], name: info.full_name.split('/')[1], branch: info.default_branch || 'main', linkedAt: Date.now() };
  const store = githubStore(link);
  const files = await store.list();
  const me = await claimId(store, files);
  const path = devicePath(me);
  // Writing this file proves the token can write.
  const sha = await store.write(path, strToU8(deviceBody(me, link.linkedAt)), files.get(path), `${me}: linked`);
  await kvSet('linkStamps', [...(await kvGet<number[]>('linkStamps', [])), link.linkedAt]);
  await kvSet('syncLink', link);
  await kvSet(K_TARGET, 'github');
  await db.kv.delete(K_GH_READ);
  await kvSet('syncShas', { [path]: sha });
  await setDevSig('github');
  // Joining devices take the shared word list; the computer sends a newer one when it next reads the Excel file.
  if (files.has(VOCAB_PATH)) await kvSet('vocabDirty', false);
  setSync({ state: 'idle', repo: info.full_name, message: undefined });
  installTriggers();
  await syncNow();
}

/**
 * Sync through OneDrive's app folder from now on (needs Microsoft sign-in). Records this device there (same id checks
 * as linkRepo) and sends everything it holds. A device that synced through GitHub first finishes a last GitHub sync,
 * then keeps reading GitHub (never writing it) until every device seen there has moved too (D9).
 */
export async function linkOneDrive(): Promise<void> {
  const migrating = (await syncTarget()) === 'github';
  if (migrating) await syncNow();
  const store = onedriveStore();
  const files = await store.list();
  const me = await claimId(store, files);
  const linkedAt = Date.now();
  const path = devicePath(me);
  const tag = await store.write(path, strToU8(deviceBody(me, linkedAt)), files.get(path), `${me}: linked`);
  await kvSet('linkStamps', [...(await kvGet<number[]>('linkStamps', [])), linkedAt]);
  await kvSet(K_OD_LINKED, linkedAt);
  await kvSet('syncTags', { [path]: tag });
  await setDevSig('onedrive');
  await kvSet(K_TARGET, 'onedrive');
  // Reviews, marks and explanations made before linking (or sent only to GitHub so far) all go to the folder.
  await queueAllOwn(me);
  if (migrating) {
    await kvSet(K_GH_READ, { on: true, waiting: [] } satisfies GithubRead);
    await kvSet('settingsDirty', true);
    if (getState().meta) await kvSet('vocabDirty', true);
  } else if (files.has(VOCAB_PATH)) {
    // Like linkRepo: the shared list decides (vocabAction); a list imported here first is merged or re-imported on top.
    await kvSet('vocabDirty', false);
  }
  setSync({ state: 'idle', repo: store.label, message: undefined, warnings: undefined });
  installTriggers();
  await syncNow();
}

/**
 * Stop syncing through GitHub. When GitHub is the target, sync turns off; after a move to OneDrive, only the read-only
 * GitHub pull stops.
 */
export async function unlinkRepo(): Promise<void> {
  const target = await syncTarget();
  await kvSet('syncLink', null);
  await kvSet('syncShas', {});
  await db.kv.delete(K_GH_READ);
  if (target === 'onedrive') return;
  await db.kv.delete(K_TARGET);
  setSync({ state: 'off', repo: undefined, message: undefined, last: undefined });
}

/** Stop syncing through OneDrive. A GitHub repository still linked becomes the target again (and gets everything). */
export async function unlinkOneDrive(): Promise<void> {
  await db.kv.delete(K_TARGET);
  await kvSet('syncTags', {});
  await db.kv.delete(K_GH_READ);
  const link = await getLink();
  if (!link) {
    setSync({ state: 'off', repo: undefined, message: undefined, last: undefined, warnings: undefined });
    return;
  }
  await queueAllOwn(getState().device);
  setSync({ state: 'idle', repo: `${link.owner}/${link.name}`, message: undefined, warnings: undefined });
  void syncNow();
}

/** Stop the read-only GitHub pull after a move to OneDrive ("Stop reading GitHub"). */
export async function stopReadingGitHub(): Promise<void> {
  const cur = await kvGet<GithubRead | null>(K_GH_READ, null);
  if (cur) await kvSet(K_GH_READ, { ...cur, on: false } satisfies GithubRead);
}

/** After a move to OneDrive: whether GitHub is still read, and the devices seen there that haven't moved yet. */
export async function githubReading(): Promise<{ on: boolean; waiting: string[] } | null> {
  if ((await syncTarget()) !== 'onedrive' || !(await getLink())) return null;
  const cur = await kvGet<GithubRead | null>(K_GH_READ, null);
  return cur ? { on: cur.on, waiting: [...cur.waiting] } : null;
}

/** This device and the others the sync store has shown: the caps and app version they last reported. */
export async function knownDevices(): Promise<{ id: string; caps: number; app?: string; seen?: number }[]> {
  const me = getState().device;
  const devs = await kvGet<Record<string, DeviceRecord>>(K_DEVICES, {});
  const others = Object.entries(devs)
    .filter(([id]) => id !== me)
    .map(([id, d]) => ({ id, caps: d.caps, ...(d.app ? { app: d.app } : {}), ...(d.seen ? { seen: d.seen } : {}) }))
    .sort((a, b) => (b.seen ?? 0) - (a.seen ?? 0) || (a.id < b.id ? -1 : 1));
  return [{ id: me, caps: SYNC_CAPS, app: APP_VERSION, seen: Date.now() }, ...others];
}

/** This device's id in a store: a fresh one when another device uses it and nothing was recorded here yet. */
async function claimId(store: SyncStore, files: Map<string, string>): Promise<string> {
  let me = getState().device;
  if (idUsed(files, me)) {
    // Either this device linked before, or another device drew the same id (older ids are short).
    if (!(await hasOwnEvents())) {
      do me = await renewDeviceId();
      while (idUsed(files, me));
    } else if (!(await isOurs(store, files, me))) {
      const where = store.kind === 'github' ? 'repository' : 'OneDrive folder';
      throw new Error(
        `Another device in this ${where} already uses the id ${me}. Linking would mix the two review logs, so it was stopped. Export your progress, then reset this device and link again.`,
      );
    }
  }
  return me;
}

function idUsed(files: Map<string, string>, id: string): boolean {
  if (files.has(devicePath(id))) return true;
  for (const p of files.keys()) {
    if (p.startsWith(`events/${id}/`) || p.startsWith(`marks/${id}/`) || p.startsWith(`explain/${id}/`)) return true;
  }
  return false;
}

const isStoreFailure = (e: unknown) => e instanceof StoreError || e instanceof GitHubError || e instanceof GraphError;

/** Whether the files under this id in the store were written by this device (it linked before). */
async function isOurs(store: SyncStore, files: Map<string, string>, id: string): Promise<boolean> {
  const dev = files.get(devicePath(id));
  if (dev) {
    try {
      const j = JSON.parse(strFromU8(await store.read(devicePath(id), dev))) as { linkedAt?: number };
      if ((await kvGet<number[]>('linkStamps', [])).includes(j.linkedAt as number)) return true;
    } catch (e) {
      if (isStoreFailure(e)) throw e;
    }
  }
  // Linked before link stamps existed: the latest review log under this id holds reviews stored here.
  const logs = [...files.keys()].filter((p) => p.startsWith(`events/${id}/`)).sort();
  const latest = logs[logs.length - 1];
  if (!latest) return false;
  try {
    const evs = decodeEvents(strFromU8(await store.read(latest, files.get(latest)!)), id);
    const here = await db.events.bulkGet(evs.map((e) => e.id));
    return here.some((e) => e?.dev === id);
  } catch (e) {
    if (isStoreFailure(e)) throw e;
    return false;
  }
}

/** Queue every month this device holds reviews, marks or explanations for, so a new store gets all of it. */
async function queueAllOwn(me: string): Promise<void> {
  await db.transaction('rw', db.events, db.kv, async () => {
    const events = await db.events.where('dev').equals(me).toArray();
    const evMonths = new Set(events.map((e) => e.mo ?? monthOf(e)));
    const prefix = `marks:${me}:`;
    const markMonths = (await db.kv.where('k').startsWith(prefix).toArray())
      .filter((r) => Array.isArray(r.v) && r.v.length > 0)
      .map((r) => r.k.slice(prefix.length));
    const exMonths = new Set(
      (await db.kv.where('k').startsWith('ex:').toArray())
        .map((r) => r.v as SavedExplanation | undefined)
        .filter((e): e is SavedExplanation => !!e?.own && typeof e.mo === 'string')
        .map((e) => e.mo),
    );
    const stamp = Math.max(Date.now(), (await kvGet<number>('dirtyStamp', 0)) + 1);
    const bump = async (key: string, months: Iterable<string>) => {
      const dirty = await kvGet<Record<string, number>>(key, {});
      for (const m of months) dirty[m] = Math.max(stamp, dirty[m] ?? 0);
      await kvSet(key, dirty);
    };
    await bump('dirty', evMonths);
    await bump('marksDirty', markMonths);
    await bump('explainDirty', exMonths);
    await kvSet('dirtyStamp', stamp);
  });
}

// ---------- one sync ----------

let running: Promise<void> | null = null;
let again = false;
let pendingLocal = false;
// After a failed sync, automatic syncs wait: 1, 2, 4… up to 30 minutes, or as long as the server asks.
let failures = 0;
let retryAt = 0;

/** When automatic syncs resume after a failure (0 = no back-off). The Sync button doesn't wait. */
export function nextAutoSync(): number {
  return retryAt;
}

export function backoffDelay(failures: number, retryAfter?: number): number {
  const minutes = Math.min(30, 2 ** Math.max(0, failures - 1));
  return Math.max(minutes * 60000, retryAfter ?? 0);
}

/** One sync at a time across every tab of the app (Web Locks; iOS before 15.4 has none and runs directly). */
function exclusive(fn: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
  if (!locks?.request) return fn();
  return locks.request('hz-sync', fn) as Promise<void>;
}

/** Pull what the other devices wrote, then push this device's changes. Safe to call at any time. */
export function syncNow(): Promise<void> {
  if (running) {
    again = true;
    return running;
  }
  running = (async () => {
    try {
      do {
        again = false;
        await exclusive(syncOnce);
      } while (again);
    } finally {
      running = null;
    }
    // Outside the sync (the hook may read the workbook, which may ask for a sync).
    if (rebasePending) {
      rebasePending = false;
      void runRebase();
    }
  })();
  return running;
}

function reconnectText(): string {
  return getState().ms.state === 'off'
    ? 'Sign in with Microsoft to sync through OneDrive. Changes are kept until then.'
    : 'Microsoft sign-in expired. Reconnect to Microsoft to sync; changes are kept until then.';
}

async function syncOnce(): Promise<void> {
  const store = await activeStore();
  if (!store) {
    setSync({ state: 'off' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setSync({ state: 'idle', message: 'Offline. Changes are kept and sent when the connection is back.' });
    return;
  }
  const hadLocal = pendingLocal;
  pendingLocal = false;
  setSync({ state: 'running', repo: store.label });
  let report = newReport();
  try {
    let listing: Map<string, string>;
    try {
      listing = await pullAndPush(store, report);
    } catch (e) {
      // Another device wrote the same file in the meantime: pull again and retry once.
      if (e instanceof StoreError && e.conflict) listing = await pullAndPush(store, (report = newReport()));
      else throw e;
    }
    if (store.kind === 'onedrive') {
      await readGitHub(listing, report);
      if (report.forwarded) again = true;
    }
    const last = Date.now();
    await kvSet('syncLast', last);
    failures = 0;
    retryAt = 0;
    setSync({
      state: 'idle',
      last,
      message: undefined,
      warnings: report.warnings.length ? report.warnings : undefined,
      updateNeeded: report.updateNeeded || undefined,
    });
  } catch (e) {
    // Changes not sent yet stay queued (the dirty months are kept too).
    pendingLocal ||= hadLocal;
    const warnings = report.warnings.length ? report.warnings : undefined;
    if (store.kind === 'onedrive' && e instanceof StoreError && e.auth) {
      // Only a new sign-in helps: no back-off (the next try costs no request), sync resumes on Reconnect.
      setSync({ state: 'error', message: reconnectText(), warnings });
      return;
    }
    // Automatic syncs back off.
    failures++;
    retryAt = Date.now() + backoffDelay(failures, e instanceof StoreError ? e.retryAfter : undefined);
    setSync({ state: 'error', message: (e as Error).message, warnings });
  }
}

/** After a move to OneDrive: read what older app versions still send to GitHub (never write there). */
async function readGitHub(onedrive: Map<string, string>, report: SyncReport): Promise<void> {
  const cur = await kvGet<GithubRead | null>(K_GH_READ, null);
  const link = cur?.on ? await getLink() : null;
  if (!link) return;
  try {
    const files = await pullAndPush(githubStore(link), report, { push: false, skip: onedrive });
    const moved = deviceIds(onedrive);
    const waiting = [...deviceIds(files)].filter((id) => !moved.has(id)).sort();
    // Every device seen in GitHub has written to OneDrive: what it sent to GitHub is read, the rest comes to OneDrive.
    await kvSet(K_GH_READ, { on: waiting.length > 0, waiting, checked: Date.now() } satisfies GithubRead);
  } catch (e) {
    report.warnings.push(`The old GitHub sync could not be read (${why(e)}). It is tried again at the next sync.`);
  }
}

function deviceIds(files: Map<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const p of files.keys()) {
    const m = DEVICE_OF.exec(p);
    if (m) ids.add(m[1] ?? m[2]);
  }
  return ids;
}

interface SyncReport {
  warnings: string[];
  updateNeeded: boolean;
  /** The read-only pull queued something for the target (newer settings or word list): push it now. */
  forwarded?: boolean;
}
const newReport = (): SyncReport => ({ warnings: [], updateNeeded: false });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

function currentVocab(): VocabFile | null {
  const { meta, notes } = getState();
  return meta ? { ...meta, notes } : null;
}

/**
 * Pull the other devices' files from `store`, then push this device's changes. With `push: false` (the read-only GitHub
 * pull after a move) nothing is written to the store: what it brings that is newer is queued for the target instead, and
 * paths in `skip` (already in the target) are not read. Returns the store's listing.
 */
async function pullAndPush(store: SyncStore, report: SyncReport, opts: { push?: boolean; skip?: Map<string, string> } = {}): Promise<Map<string, string>> {
  const push = opts.push !== false;
  // A device's own file that is in the target already: the target's copy is the newer one (the device moved).
  const skipped = (path: string) => !!opts.skip?.has(path) && DEVICE_OF.test(path);
  const me = getState().device;
  const remote = await store.list();
  const knownAt = knownKey(store.kind);
  const known = await kvGet<Record<string, string>>(knownAt, {});
  const read = (path: string, tag: string) => store.read(path, tag);
  const write = async (path: string, bytes: Uint8Array, message: string) => {
    const tag = await store.write(path, bytes, remote.get(path), message);
    remote.set(path, tag);
    known[path] = tag;
    await kvSet(knownAt, known);
  };

  // Each remote file is read on its own: one that cannot be read is reported and retried at the next sync (its version
  // tag is not recorded), and this device's changes are still sent. Store errors (network, sign-in, rate limit) stop the sync.
  const isolate = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (isStoreFailure(e)) throw e;
      report.warnings.push(`${what} could not be read (${why(e)}). It is tried again at the next sync.`);
    }
  };
  let vocabTooNew = false;
  const seen = new Set<string>();

  try {
    // 1. Word list: one shared import history (D3).
    let vocabDirty = await kvGet<boolean>('vocabDirty', false);
    const vTag = remote.get(VOCAB_PATH);
    if (vTag && known[VOCAB_PATH] !== vTag && !skipped(VOCAB_PATH)) {
      await isolate('The shared word list', async () => {
        const v = JSON.parse(strFromU8(gunzipSync(await read(VOCAB_PATH, vTag)))) as VocabFile;
        if (typeof v.version !== 'number' || (v.version as number) > 1) {
          // Written by a newer app version: neither apply it nor overwrite it.
          vocabTooNew = true;
          report.updateNeeded = true;
          report.warnings.push('Update the app to read this word list: it was saved by a newer version.');
          return;
        }
        if (!Array.isArray(v.notes) || !v.seeds) throw new Error('no word list inside');
        const local = currentVocab();
        const action = vocabAction(local, vocabDirty, v);
        if (push) {
          if (action === 'merge') {
            // Same workbook content: earliest times, union. Sent back only when it adds to the shared list.
            const m = mergeSameVersion(local!, v);
            if (vocabDiffers(m, local!)) await setVocab(m, true);
            vocabDirty = vocabDiffers(m, v);
            await kvSet('vocabDirty', vocabDirty);
          } else if (action !== 'keep') {
            await setVocab(v, true);
            vocabDirty = false;
            await kvSet('vocabDirty', false);
            // The workbook here is newer than the shared list: read it again on top of the shared history.
            if (action === 'take-reimport') rebasePending = true;
          }
          sharedList(v);
        } else {
          // Read-only: a newer list (or more history for the same content) goes on to the target.
          const newer = action === 'take' && !!(!local || (local.source?.qxh && v.source?.qxh) || v.importedAt > local.importedAt);
          const next = action === 'merge' ? mergeSameVersion(local!, v) : newer ? v : null;
          if (next && (!local || vocabDiffers(next, local))) {
            await setVocab(next, true);
            vocabDirty = true;
            await kvSet('vocabDirty', true);
            report.forwarded = true;
          }
        }
        known[VOCAB_PATH] = vTag;
      });
    }

    // 2. Settings: the most recent change wins.
    let settingsDirty = await kvGet<boolean>('settingsDirty', false);
    const sTag = remote.get(SETTINGS_PATH);
    if (sTag && known[SETTINGS_PATH] !== sTag && !skipped(SETTINGS_PATH)) {
      await isolate('The shared settings', async () => {
        const rs = JSON.parse(strFromU8(await read(SETTINGS_PATH, sTag))) as Settings;
        if (!rs || typeof rs !== 'object' || typeof rs.updatedAt !== 'number') throw new Error('no settings inside');
        if (push) {
          if (!settingsDirty || rs.updatedAt > getState().settings.updatedAt) {
            await updateSettings(rs, true);
            settingsDirty = false;
            await kvSet('settingsDirty', false);
          }
        } else if (rs.updatedAt > getState().settings.updatedAt) {
          await updateSettings(rs, true);
          settingsDirty = true;
          await kvSet('settingsDirty', true);
          report.forwarded = true;
        }
        known[SETTINGS_PATH] = sTag;
      });
    }

    // 3. Review logs (3a) and status marks (3b) of the other devices. Cards are rebuilt once, after every file is merged.
    let merged = false;
    try {
      for (const [path, tag] of remote) {
        const m = EVENTS_PATH.exec(path);
        if (!m || m[1] === me || known[path] === tag || skipped(path)) continue;
        await isolate(`Reviews ${m[2]} of ${m[1]}`, async () => {
          const evs = decodeEvents(strFromU8(await read(path, tag)), m[1]);
          if (await mergeDeviceEvents(m[1], m[2], evs, { rebuild: false })) merged = true;
          known[path] = tag;
          seen.add(m[1]);
        });
      }
      for (const [path, tag] of remote) {
        const m = MARKS_PATH.exec(path);
        if (!m || m[1] === me || known[path] === tag || skipped(path)) continue;
        await isolate(`Word statuses ${m[2]} of ${m[1]}`, async () => {
          let marks: StatusMark[];
          try {
            marks = decodeMarks(strFromU8(await read(path, tag)), m[1]);
          } catch (e) {
            if (!(e instanceof MarksTooNewError)) throw e;
            // Neither applied nor recorded: read again once this app is updated.
            report.updateNeeded = true;
            report.warnings.push(`Update the app to read the word statuses ${m[2]} of ${m[1]}: they were saved by a newer version.`);
            return;
          }
          if (await mergeDeviceMarks(m[1], m[2], marks, { rebuild: false })) merged = true;
          known[path] = tag;
          seen.add(m[1]);
        });
      }
    } finally {
      if (merged) rebuildAll();
    }

    // 3c. Saved explanations of the other devices (a cache: no card is involved).
    for (const [path, tag] of remote) {
      const m = EXPLAIN_PATH.exec(path);
      if (!m || m[1] === me || known[path] === tag || skipped(path)) continue;
      await isolate(`Explanations ${m[2]} of ${m[1]}`, async () => {
        let entries: ExplainEntry[];
        try {
          entries = decodeExplain(await read(path, tag));
        } catch (e) {
          if (!(e instanceof ExplainTooNewError)) throw e;
          report.updateNeeded = true;
          report.warnings.push(`Update the app to read the explanations ${m[2]} of ${m[1]}: they were saved by a newer version.`);
          return;
        }
        await mergeExplanations(m[1], m[2], entries);
        known[path] = tag;
        seen.add(m[1]);
      });
    }

    // 3d. What the other devices report about themselves (app version, caps), for the device list and the Excel warning.
    await readDevices(remote, known, me, read, skipped, seen);
    await kvSet(knownAt, known);
    if (!push) return remote;

    // 4. This device's review log, month by month, read from the database (it also holds reviews made in other tabs).
    for (const [month, stamp] of Object.entries(await dirtyMonths())) {
      const evs = await ownMonthEvents(month);
      await write(eventsPath(me, month), strToU8(encodeEvents(me, month, evs)), `${me}: reviews ${month}`);
      await clearDirty(month, stamp);
    }

    // 4b. This device's status marks, the same way.
    for (const [month, stamp] of Object.entries(await dirtyMarkMonths())) {
      const marks = await ownMonthMarks(month);
      const path = marksPath(me, month);
      // A mark set and undone before any upload: nothing to send.
      if (marks.length || remote.has(path)) await write(path, strToU8(encodeMarks(me, month, marks)), `${me}: marks ${month}`);
      await clearMarkDirty(month, stamp);
    }

    // 4c. This device's saved explanations, the same way.
    for (const [month, stamp] of Object.entries(await dirtyExplainMonths())) {
      const entries = await ownExplanations(month);
      const path = explainPath(me, month);
      if (entries.length || remote.has(path)) await write(path, encodeExplain(me, month, entries), `${me}: explanations ${month}`);
      await clearExplainDirty(month, stamp);
    }

    // 5. Settings changed here (or none in the store yet).
    if (settingsDirty || !remote.has(SETTINGS_PATH)) {
      const s = getState().settings;
      await write(SETTINGS_PATH, strToU8(JSON.stringify(s, null, 1) + '\n'), `${me}: settings`);
      if (getState().settings.updatedAt === s.updatedAt) await kvSet('settingsDirty', false);
    }

    // 6. A word list imported or merged here (or none in the store yet).
    const { meta, notes } = getState();
    if ((vocabDirty || !remote.has(VOCAB_PATH)) && meta && !vocabTooNew) {
      const vf: VocabFile = { ...meta, notes };
      await write(VOCAB_PATH, gzipSync(strToU8(JSON.stringify(vf)), { level: 9 }), `${me}: words from ${meta.source.name}`);
      const now = getState().meta;
      if (now && !vocabDiffers({ ...now, notes: [] }, { ...meta, notes: [] })) await kvSet('vocabDirty', false);
      sharedList(meta);
    }

    // 7. This device's own file, when its app version or caps changed since it was written.
    const dPath = devicePath(me);
    const sigs = await kvGet<Record<string, string>>(K_DEV_SIG, {});
    if (sigs[store.kind] !== devSig() || !remote.has(dPath)) {
      const linkedAt = store.kind === 'github' ? ((await getLink())?.linkedAt ?? 0) : await kvGet<number>(K_OD_LINKED, 0);
      await write(dPath, strToU8(deviceBody(me, linkedAt)), `${me}: app ${APP_VERSION}`);
      await setDevSig(store.kind);
    }
    return remote;
  } finally {
    await kvSet(knownAt, known);
  }
}

/** Read the devices files that changed, and note which devices sent something new. */
async function readDevices(
  remote: Map<string, string>,
  known: Record<string, string>,
  me: string,
  read: (path: string, tag: string) => Promise<Uint8Array>,
  skipped: (path: string) => boolean,
  seen: Set<string>,
): Promise<void> {
  const devs = await kvGet<Record<string, DeviceRecord>>(K_DEVICES, {});
  let changed = false;
  const now = Date.now();
  for (const [path, tag] of remote) {
    const m = DEVICE_PATH.exec(path);
    if (!m || m[1] === me || known[path] === tag || skipped(path)) continue;
    let rec: DeviceRecord = { caps: 1 };
    try {
      const j = JSON.parse(strFromU8(await read(path, tag))) as { caps?: unknown; app?: unknown };
      rec = { caps: typeof j.caps === 'number' && Number.isFinite(j.caps) ? j.caps : 1, ...(typeof j.app === 'string' && j.app ? { app: j.app } : {}) };
    } catch (e) {
      if (isStoreFailure(e)) throw e;
      // An unreadable devices file: an older version, as far as anyone can tell.
    }
    devs[m[1]] = { ...rec, seen: now };
    known[path] = tag;
    changed = true;
  }
  for (const id of seen) {
    devs[id] = { caps: devs[id]?.caps ?? 1, ...(devs[id]?.app ? { app: devs[id].app } : {}), seen: now };
    changed = true;
  }
  if (changed) await kvSet(K_DEVICES, devs);
}

// ---------- when to sync ----------

let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Called once at start-up. */
export async function startSync(): Promise<void> {
  const store = await activeStore();
  if (!store) {
    setSync({ state: 'off' });
    return;
  }
  setSync({ state: 'idle', last: (await kvGet<number>('syncLast', 0)) || undefined, repo: store.label });
  installTriggers();
  void syncNow();
}

function installTriggers(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const since = () => Date.now() - (getState().sync.last ?? 0);
  // Automatic syncs wait out the back-off after a failure; the Sync button (syncNow) does not.
  const auto = () => {
    if (Date.now() >= retryAt) void syncNow();
  };
  // Reviews and settings: upload after a short pause, so a session is not sent card by card.
  onLocalChange(() => {
    pendingLocal = true;
    clearTimeout(timer);
    timer = setTimeout(auto, 20000);
  });
  window.addEventListener('online', () => {
    retryAt = 0;
    void syncNow();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (pendingLocal) auto();
    } else if (since() > 60000) {
      auto();
    }
  });
  // Signed in to Microsoft again (Reconnect): OneDrive sync resumes at once.
  let ms = getState().ms.state;
  subscribe(() => {
    const now = getState().ms.state;
    if (now === ms) return;
    ms = now;
    if (now === 'ok') {
      void syncTarget().then((t) => {
        if (t !== 'onedrive') return;
        retryAt = 0;
        void syncNow();
      });
    }
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && (pendingLocal || since() > 10 * 60000)) auto();
  }, 60000);
}
