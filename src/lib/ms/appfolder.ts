// OneDrive's app folder (special/approot = OneDrive › Apps › Hugo Chinese), plan D9. Two flat folders:
//   data/     the sync files (syncstore.ts: the same files and bytes as the GitHub repository, flat names)
//   backups/  copies of the workbook taken before the app writes into it (write-back, WP9)
// Writes are conditional: `If-Match: <eTag>` to replace a file the caller has read, or "must not exist" (conflictBehavior
// fail) to create one. Either refusal (409, 412) is GraphError.conflict: read again.

import { GraphError, download, graphFetch, graphJson, type DriveItem } from './graph';

export type AppDir = 'data' | 'backups';

const ROOT = '/me/drive/special/approot';
/** More pages than this means something is wrong: a partial listing would make files look missing. */
const MAX_PAGES = 50;
const TIMEOUT = 120000;

const enc = encodeURIComponent;
const itemUrl = (dir: AppDir, name: string) => `${ROOT}:/${dir}/${enc(name)}`;

type RawItem = DriveItem & { folder?: unknown };

/** Every file in an app folder directory (folders skipped), following @odata.nextLink. A directory not created yet → []. */
export async function afList(dir: AppDir): Promise<DriveItem[]> {
  const out: DriveItem[] = [];
  let next: string | undefined = `${ROOT}:/${dir}:/children`;
  for (let page = 0; next; page++) {
    if (page >= MAX_PAGES) throw new GraphError(0, 'tooManyFiles', `Too many files in OneDrive › Apps › Hugo Chinese › ${dir} to list.`);
    let r: { value?: RawItem[]; '@odata.nextLink'?: string };
    try {
      r = await graphJson(next);
    } catch (e) {
      if (page === 0 && e instanceof GraphError && e.status === 404) return [];
      throw e;
    }
    for (const it of r.value ?? []) if (it.file && !it.folder) out.push(it);
    next = r['@odata.nextLink'];
  }
  return out;
}

/** One file's metadata (with a fresh download URL), or null when it doesn't exist. */
export async function afItem(dir: AppDir, name: string): Promise<DriveItem | null> {
  try {
    return await graphJson<DriveItem>(itemUrl(dir, name));
  } catch (e) {
    if (e instanceof GraphError && e.status === 404) return null;
    throw e;
  }
}

/**
 * A file's bytes: through the download URL of its listing (no credentials, no Authorization header), or, when that URL
 * has expired, through fresh metadata (graph.download).
 */
export async function afRead(item: DriveItem): Promise<Uint8Array> {
  const url = item['@microsoft.graph.downloadUrl'];
  if (url) {
    let res: Response;
    try {
      res = await fetch(url, {
        credentials: 'omit',
        cache: 'no-store',
        signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(TIMEOUT) : undefined,
      });
    } catch {
      throw new GraphError(0, 'network', 'OneDrive could not be reached. Check the connection.');
    }
    if (res.ok) return new Uint8Array(await res.arrayBuffer());
    // An expired or refused link: ask for a new one below. Anything else (throttling, server error) is reported.
    if (![401, 403, 404, 410].includes(res.status)) throw new GraphError(res.status, 'download', `OneDrive answered ${res.status} to a download.`);
  }
  return download(item);
}

/**
 * Create or replace `dir/name`. `ifMatch` = the eTag of the version being replaced; null = the file must not exist yet.
 * Either refusal → GraphError.conflict (409, 412). OneDrive creates the directory on the first write.
 */
export function afWrite(dir: AppDir, name: string, bytes: Uint8Array, ifMatch: string | null): Promise<DriveItem> {
  const headers: Record<string, string> = { 'Content-Type': 'application/octet-stream' };
  if (ifMatch) headers['If-Match'] = ifMatch;
  const q = ifMatch ? '' : '?@microsoft.graph.conflictBehavior=fail';
  return graphJson<DriveItem>(`${itemUrl(dir, name)}:/content${q}`, { method: 'PUT', headers, body: bytes as BodyInit });
}

/** How many workbook backups are kept in backups/. */
export const BACKUPS_KEPT = 4;

/** `Hugo_chinese_vocab.xlsx` at a time → `Hugo_chinese_vocab 2026-11-09 1042.xlsx` (UTC; sorts by time). */
export function backupName(name: string, now: number): string {
  const m = /^(.*?)(\.[^./\\]+)?$/.exec(name)!;
  const iso = new Date(now).toISOString();
  return `${m[1]} ${iso.slice(0, 10)} ${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}${m[2] ?? '.xlsx'}`;
}

/**
 * Copy the workbook's bytes into OneDrive › Apps › Hugo Chinese › backups before the app writes into it (plan D5), then
 * keep only the newest BACKUPS_KEPT there. A failed clean-up doesn't fail the backup.
 */
export async function backupWorkbook(bytes: Uint8Array, name: string, now: number): Promise<void> {
  let file = backupName(name, now);
  try {
    await afWrite('backups', file, bytes, null);
  } catch (e) {
    // The same second twice (two tabs): another name, never over an existing backup.
    if (!(e instanceof GraphError && e.conflict)) throw e;
    file = file.replace(/(\.[^.]+)$/, ` ${Math.random().toString(36).slice(2, 6)}$1`);
    await afWrite('backups', file, bytes, null);
  }
  try {
    const all = await afList('backups');
    const newest = all.sort((a, b) => Date.parse(b.lastModifiedDateTime) - Date.parse(a.lastModifiedDateTime) || (a.name < b.name ? 1 : -1));
    for (const old of newest.slice(BACKUPS_KEPT)) await afDelete(old);
  } catch {
    // Too many backups for a while is harmless; the next backup tries again.
  }
}

/** Delete a file (already gone is fine). */
export async function afDelete(item: DriveItem): Promise<void> {
  const drive = item.parentReference?.driveId;
  const path = drive ? `/drives/${enc(drive)}/items/${enc(item.id)}` : `/me/drive/items/${enc(item.id)}`;
  try {
    await graphFetch(path, { method: 'DELETE' });
  } catch (e) {
    if (!(e instanceof GraphError && e.status === 404)) throw e;
  }
}
