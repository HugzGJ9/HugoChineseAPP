// A small Microsoft Graph client for OneDrive files: item metadata, search, download, replace with If-Match (D1).
// The access token goes only to graph.microsoft.com. Download URLs carry their own authorization, so they are fetched
// without credentials and without an Authorization header.

import { GRAPH_BASE } from './config';
import { MsAuthError, msToken } from './auth';
import { setMs } from '../store';

export interface DriveItem {
  id: string;
  name: string;
  eTag: string;
  cTag: string;
  size: number;
  lastModifiedDateTime: string;
  parentReference?: { driveId?: string; id?: string; path?: string };
  file?: { hashes?: { quickXorHash?: string } };
  '@microsoft.graph.downloadUrl'?: string;
}

export class GraphError extends Error {
  constructor(
    /** HTTP status; 0 = OneDrive could not be reached (offline, timeout, blocked). */
    public status: number,
    /** Graph's `error.code`, or a code of ours (`network`, `unauthenticated`). */
    public code: string,
    message: string,
    /** How long Graph asks to wait (Retry-After), in ms. */
    public retryAfter?: number,
  ) {
    super(message);
  }
  /** Someone else changed the item meanwhile (409, 412): read again. */
  get conflict(): boolean {
    return this.status === 409 || this.status === 412;
  }
  /** The file is locked, e.g. open in desktop Excel (423). */
  get locked(): boolean {
    return this.status === 423;
  }
  /** Still refused after a token refresh, or the sign-in expired: Reconnect. */
  get auth(): boolean {
    return this.status === 401;
  }
}

const TIMEOUT = 120000;
const GRAPH_HOST = new URL(GRAPH_BASE).host;

function timeout(): AbortSignal | undefined {
  return typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT) : undefined;
}

function message(status: number, code: string, detail: string): string {
  if (status === 401) return 'Microsoft sign-in expired. Reconnect to continue.';
  if (status === 403) return 'OneDrive refused access to this file.';
  if (status === 404) return 'Not found on OneDrive.';
  if (status === 409 || status === 412) return 'The file changed on OneDrive meanwhile.';
  if (status === 423) return 'The file is locked on OneDrive (open in Excel?).';
  if (status === 429 || status === 503) return 'OneDrive asks to wait. Trying again later.';
  if (status === 507) return 'OneDrive is full.';
  return `OneDrive answered ${status}${code ? ` (${code})` : ''}${detail ? `: ${detail}` : ''}`;
}

/** Retry-After in seconds or as an HTTP date → ms. */
function retryAfter(h: Headers): number | undefined {
  const v = h.get('retry-after');
  if (!v) return undefined;
  const s = Number(v);
  if (Number.isFinite(s) && s >= 0) return s * 1000;
  const d = Date.parse(v);
  return Number.isFinite(d) ? Math.max(0, d - Date.now()) : undefined;
}

async function toError(res: Response): Promise<GraphError> {
  let code = '';
  let detail = '';
  try {
    const b = (await res.json()) as { error?: { code?: string; message?: string } };
    code = b.error?.code ?? '';
    detail = b.error?.message ?? '';
  } catch {
    // no JSON body
  }
  return new GraphError(res.status, code, message(res.status, code, detail), retryAfter(res.headers));
}

async function token(reject?: string): Promise<string> {
  try {
    return await msToken(reject ? { reject } : {});
  } catch (e) {
    if (e instanceof MsAuthError) {
      throw e.needsSignIn ? new GraphError(401, 'unauthenticated', e.message) : new GraphError(0, 'network', e.message);
    }
    throw e;
  }
}

/**
 * A Graph request with the access token: `path` is relative to /v1.0, or an absolute graph.microsoft.com URL (paging
 * links). 2 min timeout, never cached. A 401 refreshes the token once and retries. Throws GraphError unless the answer is ok.
 */
export async function graphFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const url = /^https:\/\//.test(path) ? path : GRAPH_BASE + path;
  if (new URL(url).host !== GRAPH_HOST) throw new GraphError(0, 'badHost', 'Refused to send the Microsoft token outside Graph.');
  const send = async (tok: string): Promise<Response> => {
    const headers = new Headers(init.headers);
    headers.set('Authorization', `Bearer ${tok}`);
    try {
      return await fetch(url, { ...init, headers, cache: 'no-store', signal: init.signal ?? timeout() });
    } catch {
      throw new GraphError(0, 'network', 'OneDrive could not be reached. Check the connection.');
    }
  };
  const first = await token();
  let res = await send(first);
  if (res.status === 401) {
    res = await send(await token(first));
    if (res.status === 401) {
      const err = await toError(res);
      setMs({ state: 'reconnect', message: err.message });
      throw err;
    }
  }
  if (!res.ok) throw await toError(res);
  return res;
}

/** graphFetch + JSON body. */
export async function graphJson<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await graphFetch(path, init)).json()) as T;
}

const enc = encodeURIComponent;

function itemPath(drive: string | undefined, id: string): string {
  return drive ? `/drives/${enc(drive)}/items/${enc(id)}` : `/me/drive/items/${enc(id)}`;
}

/** An item as Graph returns it: in a consumer OneDrive, files shared with Hugo (and every `recent` entry) come as a
 * local entry whose real item, on its own drive, is in `remoteItem`. */
type RawItem = DriveItem & { folder?: unknown; remoteItem?: Partial<DriveItem> & { folder?: unknown } };

/** The real item: `remoteItem` (with its own drive id) when present, else the item itself. */
export function realItem(raw: RawItem): DriveItem & { folder?: unknown } {
  const r = raw.remoteItem;
  if (!r?.id) {
    const { remoteItem: _, ...rest } = raw;
    return rest;
  }
  const { remoteItem: _, ...outer } = raw;
  return {
    ...outer,
    ...r,
    id: r.id,
    name: r.name ?? outer.name,
    parentReference: r.parentReference ?? outer.parentReference,
    ...(r.file || outer.file ? { file: r.file ?? outer.file } : {}),
    ...(r.folder || outer.folder ? { folder: r.folder ?? outer.folder } : {}),
  } as DriveItem & { folder?: unknown };
}

const isFile = (it: DriveItem & { folder?: unknown }) => !!it.file && !it.folder;

/** Item metadata, including a short-lived download URL. */
export async function getItem(drive: string, id: string): Promise<DriveItem> {
  return realItem(await graphJson<RawItem>(itemPath(drive, id)));
}

/** The item at `path` from the root of a drive (`/Documents/x.xlsx`; Hugo's own drive when `drive` is empty). 404 → GraphError. */
export async function getByPath(drive: string | undefined, path: string): Promise<DriveItem & { folder?: unknown }> {
  const segs = path.split('/').filter(Boolean).map(enc).join('/');
  return realItem(await graphJson<RawItem>(`${drive ? `/drives/${enc(drive)}` : '/me/drive'}/root:/${segs}`));
}

/** Files from a paged Graph collection, real items (remoteItem resolved), at most `limit`. */
async function collectFiles(first: string, limit: number): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let next: string | undefined = first;
  for (let page = 0; next && page < 10 && out.length < limit; page++) {
    const r: { value?: RawItem[]; '@odata.nextLink'?: string } = await graphJson(next);
    for (const raw of r.value ?? []) {
      const it = realItem(raw);
      if (isFile(it) && out.length < limit) out.push(it);
    }
    next = r['@odata.nextLink'];
  }
  return out;
}

/**
 * Files OneDrive's search returns for `q` (at most `limit`). Consumer search matches words, not names: an exact name with
 * underscores and an extension may find nothing, so callers filter the results by name themselves.
 */
export function searchFiles(q: string, limit = 200): Promise<DriveItem[]> {
  const term = q.trim();
  if (!term) return Promise.resolve([]);
  return collectFiles(`/me/drive/root/search(q='${enc(term.replace(/'/g, "''"))}')`, limit);
}

/** Files Hugo opened recently (`/me/drive/recent`), real items. */
export function recentFiles(limit = 200): Promise<DriveItem[]> {
  return collectFiles('/me/drive/recent', limit);
}

/** The current content of a file: fresh metadata for its download URL, then that URL without credentials. */
export async function download(item: DriveItem): Promise<Uint8Array> {
  const meta = await getItem(item.parentReference?.driveId ?? '', item.id);
  const url = meta['@microsoft.graph.downloadUrl'];
  if (!url) throw new GraphError(404, 'noDownloadUrl', 'OneDrive gave no download link for this file.');
  let res: Response;
  try {
    res = await fetch(url, { credentials: 'omit', cache: 'no-store', signal: timeout() });
  } catch {
    throw new GraphError(0, 'network', 'The file could not be downloaded. Check the connection.');
  }
  if (!res.ok) throw new GraphError(res.status, 'download', message(res.status, '', ''), retryAfter(res.headers));
  return new Uint8Array(await res.arrayBuffer());
}

/** Replace a file's content, only if it is still at `ifMatch` (its eTag): 412 → GraphError.conflict. */
export function uploadReplace(drive: string, id: string, bytes: Uint8Array, ifMatch: string): Promise<DriveItem> {
  return graphJson<DriveItem>(`${itemPath(drive, id)}/content`, {
    method: 'PUT',
    headers: { 'If-Match': ifMatch, 'Content-Type': 'application/octet-stream' },
    body: bytes as BodyInit,
  });
}
