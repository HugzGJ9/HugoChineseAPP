// Sync between devices through a private GitHub repository that only Hugo can read.
//
// Repository layout:
//   vocab.json.gz                  the word list, written by the device that last imported the Excel file
//   settings.json                  study settings shared by every device (newest wins)
//   events/<device>/<YYYY-MM>.json each device's own review log, one file per month; only that device writes it
//   devices/<device>.json          written when a device links
//
// Every device replays all logs through the same scheduler, so they agree on every card.
import { gunzipSync, gzipSync, strFromU8, strToU8 } from 'fflate';
import { kvGet, kvSet, type Settings } from './db';
import { GitHubError, listFiles, readBlob, repoInfo, writeFile, type RepoLink } from './github';
import { clearDirty, dirtyMonths, eventsOf, getState, mergeDeviceEvents, onLocalChange, setSync, setVocab, updateSettings } from './store';
import type { Grade, ReviewEvent, VocabFile } from './types';

export interface SyncLink extends RepoLink {
  branch: string;
  linkedAt: number;
}

export const VOCAB_PATH = 'vocab.json.gz';
export const SETTINGS_PATH = 'settings.json';
const EVENTS_PATH = /^events\/([A-Za-z0-9_-]+)\/(\d{4}-\d{2})\.json$/;
export const eventsPath = (device: string, month: string) => `events/${device}/${month}.json`;

// ---------- review log files ----------

const FIELDS = ['id', 'card', 'r', 't', 'd', 'm'] as const;

export function encodeEvents(device: string, month: string, events: ReviewEvent[]): string {
  const rows = [...events].sort((a, b) => a.t - b.t).map((e) => JSON.stringify([e.id, e.card, e.r, e.t, e.d, e.m]));
  return `{"device":${JSON.stringify(device)},"month":${JSON.stringify(month)},"fields":${JSON.stringify(FIELDS)},"events":[\n${rows.join(',\n')}\n]}\n`;
}

export function decodeEvents(text: string, device: string): ReviewEvent[] {
  const j = JSON.parse(text) as { events: [string, string, number, number, number, string][] };
  return j.events.map(([id, card, r, t, d, m]) => ({ id, card, r: r as Grade, t, d, m, dev: device }));
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
  const me = getState().device;
  const path = `devices/${me}.json`;
  const body = JSON.stringify({ id: me, linkedAt: link.linkedAt, agent: typeof navigator !== 'undefined' ? navigator.userAgent : '' }, null, 1);
  // Writing this file proves the token can write.
  const sha = await writeFile(link, link.branch, path, strToU8(body), files.get(path), `${me}: linked`);
  await kvSet('syncLink', link);
  await kvSet('syncShas', { [path]: sha });
  // Joining devices take the shared word list; the computer sends a newer one when it next reads the Excel file.
  if (files.has(VOCAB_PATH)) await kvSet('vocabDirty', false);
  setSync({ state: 'idle', repo: info.full_name, message: undefined });
  installTriggers();
  await syncNow();
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
        await syncOnce();
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
  pendingLocal = false;
  setSync({ state: 'running', repo: `${link.owner}/${link.name}` });
  try {
    try {
      await pullAndPush(link);
    } catch (e) {
      // Another device wrote the same file in the meantime: pull again and retry once.
      if (e instanceof GitHubError && (e.status === 409 || e.status === 422)) await pullAndPush(link);
      else throw e;
    }
    const last = Date.now();
    await kvSet('syncLast', last);
    setSync({ state: 'idle', last, message: undefined });
  } catch (e) {
    setSync({ state: 'error', message: (e as Error).message });
  }
}

async function pullAndPush(link: SyncLink): Promise<void> {
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

  try {
    // 1. Word list.
    let vocabDirty = await kvGet<boolean>('vocabDirty', false);
    const vSha = remote.get(VOCAB_PATH);
    if (vSha && known[VOCAB_PATH] !== vSha) {
      const v = JSON.parse(strFromU8(gunzipSync(await read(vSha)))) as VocabFile;
      const local = getState().meta;
      const keepLocal = vocabDirty && local && local.importedAt >= v.importedAt;
      if (!keepLocal) {
        await setVocab(v, true);
        vocabDirty = false;
        await kvSet('vocabDirty', false);
      }
      known[VOCAB_PATH] = vSha;
    }

    // 2. Settings: the most recent change wins.
    let settingsDirty = await kvGet<boolean>('settingsDirty', false);
    const sSha = remote.get(SETTINGS_PATH);
    if (sSha && known[SETTINGS_PATH] !== sSha) {
      const rs = JSON.parse(strFromU8(await read(sSha))) as Settings;
      if (!settingsDirty || rs.updatedAt > getState().settings.updatedAt) {
        await updateSettings(rs, true);
        settingsDirty = false;
        await kvSet('settingsDirty', false);
      }
      known[SETTINGS_PATH] = sSha;
    }

    // 3. Review logs of the other devices.
    for (const [path, sha] of remote) {
      const m = EVENTS_PATH.exec(path);
      if (!m || m[1] === me || known[path] === sha) continue;
      await mergeDeviceEvents(m[1], m[2], decodeEvents(strFromU8(await read(sha)), m[1]));
      known[path] = sha;
    }
    await kvSet('syncShas', known);

    // 4. This device's review log, month by month.
    for (const [month, stamp] of Object.entries(await dirtyMonths())) {
      await write(eventsPath(me, month), strToU8(encodeEvents(me, month, eventsOf(me, month))), `${me}: reviews ${month}`);
      await clearDirty(month, stamp);
    }

    // 5. Settings changed here (or none in the repository yet).
    if (settingsDirty || !remote.has(SETTINGS_PATH)) {
      const s = getState().settings;
      await write(SETTINGS_PATH, strToU8(JSON.stringify(s, null, 1) + '\n'), `${me}: settings`);
      if (getState().settings.updatedAt === s.updatedAt) await kvSet('settingsDirty', false);
    }

    // 6. A word list imported here (or none in the repository yet).
    const { meta, notes } = getState();
    if ((vocabDirty || !remote.has(VOCAB_PATH)) && meta) {
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
  // Reviews and settings: upload after a short pause, so a session is not sent card by card.
  onLocalChange(() => {
    pendingLocal = true;
    clearTimeout(timer);
    timer = setTimeout(() => void syncNow(), 20000);
  });
  window.addEventListener('online', () => void syncNow());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (pendingLocal) void syncNow();
    } else if (since() > 60000) {
      void syncNow();
    }
  });
  setInterval(() => {
    if (document.visibilityState === 'visible' && (pendingLocal || since() > 10 * 60000)) void syncNow();
  }, 60000);
}
