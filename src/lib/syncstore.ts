// Where the sync files live (plan D9): the private GitHub repository, or OneDrive's app folder. sync.ts runs the same
// pull-and-push against either, through this interface. Both hold the same files with the same bytes:
//
//   GitHub (paths)                       OneDrive › Apps › Hugo Chinese › data (flat names)
//   vocab.json.gz, settings.json         vocab.json.gz, settings.json
//   events/<dev>/<YYYY-MM>.json          events.<dev>.<YYYY-MM>.json   (marks and explain the same way)
//   devices/<dev>.json                   devices.<dev>.json
//
// Device ids never contain dots, so the flat names map back to the paths.

import { GitHubError, listFiles, readBlob, writeFile, type RepoLink } from './github';
import { afItem, afList, afRead, afWrite } from './ms/appfolder';
import { GraphError, type DriveItem } from './ms/graph';

export interface SyncLink extends RepoLink {
  branch: string;
  linkedAt: number;
}

export interface SyncStore {
  kind: 'github' | 'onedrive';
  /** For "Synced with …": owner/name, or OneDrive. */
  label: string;
  /** Every sync file: logical path → version tag (GitHub blob sha, OneDrive eTag). */
  list(): Promise<Map<string, string>>;
  /** The bytes of a file at the version `tag` given by the last list(). */
  read(path: string, tag: string): Promise<Uint8Array>;
  /** Create (`prevTag` undefined: must not exist) or replace the version `prevTag`. Returns the new tag. */
  write(path: string, bytes: Uint8Array, prevTag: string | undefined, message: string): Promise<string>;
}

/** A store failure (network, sign-in, conflict, throttling): stops the sync, unlike one unreadable file. */
export class StoreError extends Error {
  constructor(
    public status: number,
    message: string,
    opts: { retryAfter?: number; conflict?: boolean; auth?: boolean } = {},
  ) {
    super(message);
    this.name = 'StoreError';
    this.retryAfter = opts.retryAfter;
    this.conflict = !!opts.conflict;
    this.auth = !!opts.auth;
  }
  /** How long the server asks to wait, ms. */
  retryAfter?: number;
  /** Someone else wrote the file meanwhile: pull again and retry. */
  conflict: boolean;
  /** Sign-in refused or expired. */
  auth: boolean;
}

/** GitHubError / GraphError → StoreError; anything else unchanged. */
export function toStoreError(e: unknown): unknown {
  if (e instanceof StoreError) return e;
  if (e instanceof GitHubError) return new StoreError(e.status, e.message, { retryAfter: e.retryAfter, conflict: e.conflict, auth: e.auth });
  if (e instanceof GraphError) return new StoreError(e.status, e.message, { retryAfter: e.retryAfter, conflict: e.conflict, auth: e.auth });
  return e;
}

async function mapped<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    throw toStoreError(e);
  }
}

// ---------- GitHub ----------

export function githubStore(link: SyncLink): SyncStore {
  return {
    kind: 'github',
    label: `${link.owner}/${link.name}`,
    list: () => mapped(() => listFiles(link, link.branch)),
    read: (_path, tag) => mapped(() => readBlob(link, tag)),
    write: (path, bytes, prevTag, message) => mapped(() => writeFile(link, link.branch, path, bytes, prevTag, message)),
  };
}

// ---------- OneDrive app folder ----------

const FLAT: [RegExp, (m: RegExpExecArray) => string][] = [
  [/^(events|marks)\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2})\.json$/, (m) => `${m[1]}/${m[2]}/${m[3]}.json`],
  [/^explain\.([A-Za-z0-9_-]+)\.(\d{4}-\d{2})\.json\.gz$/, (m) => `explain/${m[1]}/${m[2]}.json.gz`],
  [/^devices\.([A-Za-z0-9_-]+)\.json$/, (m) => `devices/${m[1]}.json`],
  [/^(vocab\.json\.gz|settings\.json)$/, (m) => m[1]],
];

/** Logical path → flat file name in data/. */
export function toOdName(path: string): string {
  return path.split('/').join('.');
}

/** Flat file name → logical path; null for a file that isn't a sync file (a conflict copy, something added by hand). */
export function fromOdName(name: string): string | null {
  for (const [re, path] of FLAT) {
    const m = re.exec(name);
    if (m) return path(m);
  }
  return null;
}

export function onedriveStore(): SyncStore {
  // The items of the last listing: their download URLs save a metadata request per read.
  let items = new Map<string, DriveItem>();
  return {
    kind: 'onedrive',
    label: 'OneDrive',
    list: () =>
      mapped(async () => {
        const out = new Map<string, string>();
        items = new Map();
        for (const it of await afList('data')) {
          const path = fromOdName(it.name);
          if (!path) continue;
          items.set(path, it);
          out.set(path, it.eTag);
        }
        return out;
      }),
    read: (path) =>
      mapped(async () => {
        const it = items.get(path) ?? (await afItem('data', toOdName(path)));
        if (!it) throw new GraphError(404, 'itemNotFound', `${path} is no longer in OneDrive.`);
        return afRead(it);
      }),
    write: (path, bytes, prevTag) =>
      mapped(async () => {
        try {
          const it = await afWrite('data', toOdName(path), bytes, prevTag ?? null);
          items.set(path, it);
          return it.eTag;
        } catch (e) {
          // Replacing a file that was deleted meanwhile: list again, like any other conflict.
          if (prevTag && e instanceof GraphError && e.status === 404) throw new StoreError(404, e.message, { conflict: true });
          throw e;
        }
      }),
  };
}
