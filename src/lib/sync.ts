// Sync between devices through a private GitHub repository that only Hugo can read.
//
// Repository layout:
//   vocab.json.gz                  the word list, written by the device that last imported the Excel file
//   settings.json                  study settings shared by every device (newest wins)
//   events/<device>/<YYYY-MM>.json each device's own review log, one file per month; only that device writes it
//   marks/<device>/<YYYY-MM>.json  each device's own status marks ("I know this", "Suspend"…), same rules as the logs
//   explain/<device>/<YYYY-MM>.json.gz  each device's own saved Claude explanations (gzipped), same rules; a cache
//   devices/<device>.json          written when a device links
//
// Every device replays all logs through the same scheduler, so they agree on every card.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { db, kvGet, kvSet, type Settings } from './db';
import { clearExplainDirty, dirtyExplainMonths, mergeExplanations, normalizeExplanation, ownExplanations, type ExplainEntry } from './explain';
import { GitHubError, listFiles, readBlob, repoInfo, writeFile, type RepoLink } from './github';
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
  updateSettings,
} from './store';
import type { Grade, MarkKind, ReviewEvent, StatusMark, VocabFile } from './types';

export interface SyncLink extends RepoLink {
  branch: string;
  linkedAt: number;
}

export const VOCAB_PATH = 'vocab.json.gz';
export const SETTINGS_PATH = 'settings.json';
const EVENTS_PATH = /^events\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json$/;
export const eventsPath = (device: string, month: string) => `events/${device}/${month}.json`;
const MARKS_PATH = /^marks\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json$/;
export const marksPath = (device: string, month: string) => `marks/${device}/${month}.json`;
export const EXPLAIN_PATH = /^explain\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json\.gz$/;
export const explainPath = (device: string, month: string) => `explain/${device}/${month}.json.gz`;

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

// ---------- link ----------

export function getLink(): Promise<SyncLink | null> {
  return kvGet<SyncLink | null>('syncLink', null);
}

/** Check the repository and the token, record this device in it, then run a first sync. */
export async function linkRepo(repo: RepoLink): Promise<void> {
  const info = await repoInfo(repo);
  if (!info.private) {
    throw new Error(`${info.full_name} is public. Sync needs a private repository, because it holds your words and reviews.`);
  }
  const link: SyncLink = { ...repo, owner: info.full_name.split('/')[0], name: info.full_name.split('/')[1], branch: info.default_branch || 'main', linkedAt: Date.now() };
  const files = await listFiles(link, link.branch);
  let me = getState().device;
  if (idUsed(files, me)) {
    // Either this device linked before, or another device drew the same id (older ids are short).
    if (!(await hasOwnEvents())) {
      do me = await renewDeviceId();
      while (idUsed(files, me));
    } else if (!(await isOurs(link, files, me))) {
      throw new Error(
        `Another device in this repository already uses the id ${me}. Linking would mix the two review logs, so it was stopped. Export your progress, then reset this device and link again.`,
      );
    }
  }
  const path = `devices/${me}.json`;
  const body = JSON.stringify({ id: me, linkedAt: link.linkedAt, agent: typeof navigator !== 'undefined' ? navigator.userAgent : '' }, null, 1);
  // Writing this file proves the token can write.
  const sha = await writeFile(link, link.branch, path, strToU8(body), files.get(path), `${me}: linked`);
  await kvSet('linkStamps', [...(await kvGet<number[]>('linkStamps', [])), link.linkedAt]);
  await kvSet('syncLink', link);
  await kvSet('syncShas', { [path]: sha });
  // Joining devices take the shared word list; the computer sends a newer one when it next reads the Excel file.
  if (files.has(VOCAB_PATH)) await kvSet('vocabDirty', false);
  setSync({ state: 'idle', repo: info.full_name, message: undefined });
  installTriggers();
  await syncNow();
}

function idUsed(files: Map<string, string>, id: string): boolean {
  if (files.has(`devices/${id}.json`)) return true;
  for (const p of files.keys()) {
    if (p.startsWith(`events/${id}/`) || p.startsWith(`marks/${id}/`) || p.startsWith(`explain/${id}/`)) return true;
  }
  return false;
}

/** Whether the files under this id in the repository were written by this device (it linked before). */
async function isOurs(link: SyncLink, files: Map<string, string>, id: string): Promise<boolean> {
  const dev = files.get(`devices/${id}.json`);
  if (dev) {
    try {
      const j = JSON.parse(strFromU8(await readBlob(link, dev))) as { linkedAt?: number };
      if ((await kvGet<number[]>('linkStamps', [])).includes(j.linkedAt as number)) return true;
    } catch (e) {
      if (e instanceof GitHubError) throw e;
    }
  }
  // Linked before link stamps existed: the latest review log under this id holds reviews stored here.
  const logs = [...files.keys()].filter((p) => p.startsWith(`events/${id}/`)).sort();
  const latest = logs[logs.length - 1];
  if (!latest) return false;
  try {
    const evs = decodeEvents(strFromU8(await readBlob(link, files.get(latest)!)), id);
    const here = await db.events.bulkGet(evs.map((e) => e.id));
    return here.some((e) => e?.dev === id);
  } catch (e) {
    if (e instanceof GitHubError) throw e;
    return false;
  }
}

export async function unlinkRepo(): Promise<void> {
  await kvSet('syncLink', null);
  await kvSet('syncShas', {});
  setSync({ state: 'off', repo: undefined, message: undefined, last: undefined });
}

// ---------- one sync ----------

let running: Promise<void> | null = null;
let again = false;
let pendingLocal = false;
// After a failed sync, automatic syncs wait: 1, 2, 4… up to 30 minutes, or as long as GitHub asks.
let failures = 0;
let retryAt = 0;

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
  })();
  return running;
}

async function syncOnce(): Promise<void> {
  const link = await getLink();
  if (!link) {
    setSync({ state: 'off' });
    return;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    setSync({ state: 'idle', message: 'Offline. Changes are kept and sent when the connection is back.' });
    return;
  }
  const hadLocal = pendingLocal;
  pendingLocal = false;
  setSync({ state: 'running', repo: `${link.owner}/${link.name}` });
  let report = newReport();
  try {
    try {
      await pullAndPush(link, report);
    } catch (e) {
      // Another device wrote the same file in the meantime: pull again and retry once.
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) await pullAndPush(link, (report = newReport()));
      else throw e;
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
    // Changes not sent yet stay queued (the dirty months are kept too), and automatic syncs back off.
    pendingLocal ||= hadLocal;
    failures++;
    retryAt = Date.now() + backoffDelay(failures, e instanceof GitHubError ? e.retryAfter : undefined);
    setSync({ state: 'error', message: (e as Error).message, warnings: report.warnings.length ? report.warnings : undefined });
  }
}

interface SyncReport {
  warnings: string[];
  updateNeeded: boolean;
}
const newReport = (): SyncReport => ({ warnings: [], updateNeeded: false });
const why = (e: unknown) => (e instanceof Error ? e.message : String(e));

async function pullAndPush(link: SyncLink, report: SyncReport): Promise<void> {
  const me = getState().device;
  const remote = await listFiles(link, link.branch);
  const known = await kvGet<Record<string, string>>('syncShas', {});
  const read = async (sha: string) => readBlob(link, sha);
  const write = async (path: string, bytes: Uint8Array, message: string) => {
    const sha = await writeFile(link, link.branch, path, bytes, remote.get(path), message);
    remote.set(path, sha);
    known[path] = sha;
    await kvSet('syncShas', known);
  };

  // Each remote file is read on its own: one that cannot be read is reported and retried at the next sync (its blob id
  // is not recorded), and this device's changes are still sent. GitHub errors (network, token, rate limit) stop the sync.
  const isolate = async (what: string, fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (e) {
      if (e instanceof GitHubError) throw e;
      report.warnings.push(`${what} could not be read (${why(e)}). It is tried again at the next sync.`);
    }
  };
  let vocabTooNew = false;

  try {
    // 1. Word list.
    let vocabDirty = await kvGet<boolean>('vocabDirty', false);
    const vSha = remote.get(VOCAB_PATH);
    if (vSha && known[VOCAB_PATH] !== vSha) {
      await isolate('The shared word list', async () => {
        const v = JSON.parse(strFromU8(gunzipSync(await read(vSha)))) as VocabFile;
        if (typeof v.version !== 'number' || (v.version as number) > 1) {
          // Written by a newer app version: neither apply it nor overwrite it.
          vocabTooNew = true;
          report.updateNeeded = true;
          report.warnings.push('Update the app to read this word list: it was saved by a newer version.');
          return;
        }
        if (!Array.isArray(v.notes) || !v.seeds) throw new Error('no word list inside');
        const local = getState().meta;
        const keepLocal = vocabDirty && local && local.importedAt >= v.importedAt;
        if (!keepLocal) {
          await setVocab(v, true);
          vocabDirty = false;
          await kvSet('vocabDirty', false);
        }
        known[VOCAB_PATH] = vSha;
      });
    }

    // 2. Settings: the most recent change wins.
    let settingsDirty = await kvGet<boolean>('settingsDirty', false);
    const sSha = remote.get(SETTINGS_PATH);
    if (sSha && known[SETTINGS_PATH] !== sSha) {
      await isolate('The shared settings', async () => {
        const rs = JSON.parse(strFromU8(await read(sSha))) as Settings;
        if (!rs || typeof rs !== 'object' || typeof rs.updatedAt !== 'number') throw new Error('no settings inside');
        if (!settingsDirty || rs.updatedAt > getState().settings.updatedAt) {
          await updateSettings(rs, true);
          settingsDirty = false;
          await kvSet('settingsDirty', false);
        }
        known[SETTINGS_PATH] = sSha;
      });
    }

    // 3. Review logs (3a) and status marks (3b) of the other devices. Cards are rebuilt once, after every file is merged.
    let merged = false;
    try {
      for (const [path, sha] of remote) {
        const m = EVENTS_PATH.exec(path);
        if (!m || m[1] === me || known[path] === sha) continue;
        await isolate(`Reviews ${m[2]} of ${m[1]}`, async () => {
          const evs = decodeEvents(strFromU8(await read(sha)), m[1]);
          if (await mergeDeviceEvents(m[1], m[2], evs, { rebuild: false })) merged = true;
          known[path] = sha;
        });
      }
      for (const [path, sha] of remote) {
        const m = MARKS_PATH.exec(path);
        if (!m || m[1] === me || known[path] === sha) continue;
        await isolate(`Word statuses ${m[2]} of ${m[1]}`, async () => {
          let marks: StatusMark[];
          try {
            marks = decodeMarks(strFromU8(await read(sha)), m[1]);
          } catch (e) {
            if (!(e instanceof MarksTooNewError)) throw e;
            // Neither applied nor recorded: read again once this app is updated.
            report.updateNeeded = true;
            report.warnings.push(`Update the app to read the word statuses ${m[2]} of ${m[1]}: they were saved by a newer version.`);
            return;
          }
          if (await mergeDeviceMarks(m[1], m[2], marks, { rebuild: false })) merged = true;
          known[path] = sha;
        });
      }
    } finally {
      if (merged) rebuildAll();
    }

    // 3c. Saved explanations of the other devices (a cache: no card is involved).
    for (const [path, sha] of remote) {
      const m = EXPLAIN_PATH.exec(path);
      if (!m || m[1] === me || known[path] === sha) continue;
      await isolate(`Explanations ${m[2]} of ${m[1]}`, async () => {
        let entries: ExplainEntry[];
        try {
          entries = decodeExplain(await read(sha));
        } catch (e) {
          if (!(e instanceof ExplainTooNewError)) throw e;
          report.updateNeeded = true;
          report.warnings.push(`Update the app to read the explanations ${m[2]} of ${m[1]}: they were saved by a newer version.`);
          return;
        }
        await mergeExplanations(m[1], m[2], entries);
        known[path] = sha;
      });
    }
    await kvSet('syncShas', known);

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

    // 5. Settings changed here (or none in the repository yet).
    if (settingsDirty || !remote.has(SETTINGS_PATH)) {
      const s = getState().settings;
      await write(SETTINGS_PATH, strToU8(JSON.stringify(s, null, 1) + '\n'), `${me}: settings`);
      if (getState().settings.updatedAt === s.updatedAt) await kvSet('settingsDirty', false);
    }

    // 6. A word list imported here (or none in the repository yet).
    const { meta, notes } = getState();
    if ((vocabDirty || !remote.has(VOCAB_PATH)) && meta && !vocabTooNew) {
      const vf: VocabFile = { ...meta, notes };
      await write(VOCAB_PATH, gzipSync(strToU8(JSON.stringify(vf)), { level: 9 }), `${me}: words from ${meta.source.name}`);
      if (getState().meta?.hash === meta.hash) await kvSet('vocabDirty', false);
    }
  } finally {
    await kvSet('syncShas', known);
  }
}

// ---------- when to sync ----------

let installed = false;
let timer: ReturnType<typeof setTimeout> | undefined;

/** Called once at start-up. */
export async function startSync(): Promise<void> {
  const link = await getLink();
  if (!link) {
    setSync({ state: 'off' });
    return;
  }
  setSync({ state: 'idle', last: (await kvGet<number>('syncLast', 0)) || undefined, repo: `${link.owner}/${link.name}` });
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
  setInterval(() => {
    if (document.visibilityState === 'visible' && (pendingLocal || since() > 10 * 60000)) auto();
  }, 60000);
}
