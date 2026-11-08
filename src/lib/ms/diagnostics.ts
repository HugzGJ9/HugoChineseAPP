// Microsoft diagnostics (Settings › More): checks on Hugo's real account what the plan takes as given (the "verify"
// facts), and reports in plain text he can copy. No names, emails, file names or paths in the report.
// Touches only OneDrive › Apps › Hugo Chinese › diag, and deletes its test file.

import { getSettings, kvGet } from '../db';
import { MS_CLIENT_ID } from './config';
import type { MsAuth } from './auth';
import { msConfigured, msToken } from './auth';
import { formatSteps, listExcelFiles, locateFile } from './find';
import { GraphError, getItem, graphFetch, graphJson, type DriveItem } from './graph';
import { quickXorHash } from './qxh';

declare const __APP_VERSION__: string;

function describe(e: unknown): string {
  if (e instanceof GraphError) return `failed: ${e.status || 'no answer'}${e.code ? ` ${e.code}` : ''}`;
  return `failed: ${(e as Error)?.name ?? 'error'}`;
}

function hours(ms: number): string {
  return `${(ms / 3600000).toFixed(1)} h`;
}

function testBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/** Fetch a download URL without credentials; tell a CSP block apart from other failures where the browser says so. */
async function tryDownload(url: string, want: Uint8Array): Promise<string> {
  const host = new URL(url).host;
  let blocked = false;
  const onViolation = (ev: Event) => {
    const uri = (ev as Event & { blockedURI?: string }).blockedURI ?? '';
    if (uri.includes(host)) blocked = true;
  };
  const doc = typeof document !== 'undefined' ? document : undefined;
  doc?.addEventListener('securitypolicyviolation', onViolation);
  try {
    const res = await fetch(url, { credentials: 'omit', cache: 'no-store' });
    if (!res.ok) return `answered ${res.status}`;
    const got = new Uint8Array(await res.arrayBuffer());
    const same = got.length === want.length && got.every((x, i) => x === want[i]);
    return same ? 'ok (same bytes)' : `ok but different bytes (${got.length} B)`;
  } catch {
    await new Promise((r) => setTimeout(r, 50)); // the violation event comes after the rejection
    return blocked ? 'BLOCKED by the Content Security Policy (add the host to connect-src)' : 'failed (network, CORS or CSP)';
  } finally {
    doc?.removeEventListener('securitypolicyviolation', onViolation);
  }
}

/** Run the checks and return the report. Never throws. */
export async function runDiagnostics(): Promise<string> {
  const out: string[] = [];
  const line = (k: string, v: string) => out.push(`${k}: ${v}`);
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  out.push(`Hugo 中文 Microsoft diagnostics, app ${version}, ${new Date().toISOString()}`);
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const standalone =
    (nav as Navigator & { standalone?: boolean } | undefined)?.standalone === true ||
    (typeof matchMedia !== 'undefined' && matchMedia('(display-mode: standalone)').matches);
  line('Device', `${/iPhone|iPad/.test(nav?.userAgent ?? '') ? 'iOS' : /Windows/.test(nav?.userAgent ?? '') ? 'Windows' : 'other'}, ${standalone ? 'Home Screen app' : 'browser tab'}, ${nav?.onLine === false ? 'offline' : 'online'}`);

  if (!msConfigured()) {
    line('Microsoft sign-in', MS_CLIENT_ID ? 'not configured (the client id in src/lib/ms/config.ts is not valid)' : 'not configured (no client id in src/lib/ms/config.ts yet)');
    return out.join('\n');
  }
  line('Client id', `${MS_CLIENT_ID.slice(0, 8)}…`);

  const auth = await kvGet<MsAuth | null>('msAuth', null);
  if (!auth) {
    line('Signed in', 'no');
    return out.join('\n');
  }
  const now = Date.now();
  line('Signed in', `yes, ${hours(now - auth.signInAt)} ago; refresh token ${auth.refreshExp > now ? `ends in ${hours(auth.refreshExp - now)}` : 'expired'}`);
  line('Granted scopes', auth.scope || '(not reported)');

  try {
    await msToken();
    line('Access token', 'ok');
  } catch (e) {
    line('Access token', `${(e as Error).message}`);
    return out.join('\n');
  }

  try {
    const d = await graphJson<{ driveType?: string }>('/me/drive?$select=driveType');
    line('Drive type', d.driveType ?? '(not reported)');
  } catch (e) {
    line('Drive type', describe(e));
  }

  try {
    await graphJson<DriveItem>('/me/drive/special/approot?$select=id');
    line('App folder', 'ok');
  } catch (e) {
    line('App folder', describe(e));
  }

  // A 3 KB test file in approot/diag: hash, If-Match, download host. Deleted at the end.
  const name = `hz-diag-${now.toString(36)}.bin`;
  const path = `/me/drive/special/approot:/diag/${name}:/content`;
  const first = testBytes(3072);
  let item: DriveItem | undefined;
  try {
    item = await graphJson<DriveItem>(path, { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: first as BodyInit });
    line('Upload 3 KB', 'ok');
  } catch (e) {
    line('Upload 3 KB', describe(e));
  }

  if (item) {
    const drive = item.parentReference?.driveId ?? '';
    try {
      let remote = item.file?.hashes?.quickXorHash;
      if (!remote) remote = (await getItem(drive, item.id)).file?.hashes?.quickXorHash;
      const local = quickXorHash(first);
      line('quickXorHash', !remote ? 'MISSING in the metadata' : remote === local ? 'match' : 'DIFFERENT from the local hash');
    } catch (e) {
      line('quickXorHash', describe(e));
    }

    let current = item;
    let currentBytes = first;
    const second = testBytes(3072);
    try {
      current = await graphJson<DriveItem>(`/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item.id)}/content`, {
        method: 'PUT',
        headers: { 'If-Match': item.eTag, 'Content-Type': 'application/octet-stream' },
        body: second as BodyInit,
      });
      currentBytes = second;
      line('Replace with the current eTag', current.eTag !== item.eTag ? 'ok (new eTag)' : 'ok but the eTag did not change');
    } catch (e) {
      line('Replace with the current eTag', describe(e));
    }
    try {
      await graphFetch(`/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item.id)}/content`, {
        method: 'PUT',
        headers: { 'If-Match': item.eTag, 'Content-Type': 'application/octet-stream' },
        body: first as BodyInit,
      });
      currentBytes = first;
      line('Replace with a stale eTag', current.eTag !== item.eTag ? 'ACCEPTED (expected 412)' : 'accepted (the eTag had not changed)');
    } catch (e) {
      line('Replace with a stale eTag', e instanceof GraphError && e.status === 412 ? 'refused with 412 (expected)' : describe(e));
    }

    try {
      const meta = await getItem(drive, item.id);
      const url = meta['@microsoft.graph.downloadUrl'];
      if (!url) line('Download URL', 'MISSING in the metadata');
      else {
        line('Download host', new URL(url).host);
        line('Download', await tryDownload(url, currentBytes));
      }
    } catch (e) {
      line('Download URL', describe(e));
    }

    try {
      await graphFetch(`/drives/${encodeURIComponent(drive)}/items/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
      line('Delete the test file', 'ok');
    } catch (e) {
      line('Delete the test file', describe(e));
    }
  }

  const wb = await kvGet<{ drive?: string; item?: string; path?: string } | null>('odWorkbook', null);
  if (!wb?.item) line('Linked workbook', 'none');
  else {
    try {
      const meta = await getItem(wb.drive ?? '', wb.item);
      const hashes = Object.keys((meta.file as { hashes?: Record<string, unknown> } | undefined)?.hashes ?? {});
      line('Linked workbook', `found, ${Math.round(meta.size / 1024)} KB, hashes: ${hashes.length ? hashes.join(', ') : 'none'}${meta.parentReference?.driveId && meta.parentReference.driveId !== wb.drive ? ', on another drive' : ''}`);
    } catch (e) {
      line('Linked workbook', describe(e));
    }
  }

  // Every lookup the app uses to find the workbook by name, with its exact-name hit count (no names or paths).
  try {
    const r = await locateFile((await getSettings()).fileName, { drive: wb?.drive, folder: wb?.path, all: true });
    line('Workbook lookups', formatSteps(r.steps));
    const shared = r.items.filter((i) => wb?.drive && i.parentReference?.driveId && i.parentReference.driveId !== wb.drive).length;
    line('Workbook files found', `${r.items.length}${shared ? ` (${shared} on another drive)` : ''}`);
  } catch (e) {
    line('Workbook lookups', describe(e));
  }
  try {
    const x = await listExcelFiles(200);
    line('Excel files listed', `${x.items.length} (${formatSteps(x.steps)})`);
  } catch (e) {
    line('Excel files listed', describe(e));
  }
  return out.join('\n');
}
