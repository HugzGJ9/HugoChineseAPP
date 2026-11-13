// Test helper: an in-memory Microsoft (sign-in + token endpoint) and OneDrive (Graph files + download host), served as a
// `fetch` stub, like the fake GitHub in sync.test.ts. No real credentials, no network: unknown hosts fail like a blocked
// request. Use with `vi.stubGlobal('fetch', fake.fetch)`.

import { quickXorHash } from './qxh';

export const FAKE_DOWNLOAD_HOST = 'fake.microsoftpersonalcontent.com';
const LOGIN_HOST = 'login.microsoftonline.com';
const GRAPH_HOST = 'graph.microsoft.com';

export interface FakeItem {
  id: string;
  name: string;
  /** Folder path from the root, '' for the root itself: 'Documents', 'Apps/Hugo Chinese/diag'. */
  folder: string;
  isFolder: boolean;
  bytes: Uint8Array;
  ver: number;
  cver: number;
  modified: number;
  /** Another drive (a file in a folder shared with Hugo): reached as /drives/{drive}/items/{id}, listed as a remoteItem. */
  drive?: string;
  /** False while OneDrive's search index has not caught up with the file (a fresh sync from the PC). */
  indexed?: boolean;
}

/** OneDrive search splits a name into words: "Hugo_chinese_vocab.xlsx" → hugo, chinese, vocab, xlsx. */
export function nameWords(name: string): string[] {
  return name.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/**
 * Like consumer OneDrive search: the query splits on spaces and underscores, each term (dots trimmed) must start a word of
 * the name. So the exact name "Hugo_chinese_vocab.xlsx" finds nothing (the term "vocab.xlsx" is no word), while
 * "Hugo_chinese_vocab", "Hugo chinese vocab" and ".xlsx" do.
 */
export function searchMatches(name: string, q: string): boolean {
  const terms = q.toLowerCase().split(/[\s_]+/).map((t) => t.replace(/^\.+|\.+$/g, '')).filter(Boolean);
  if (!terms.length) return false;
  const words = nameWords(name);
  return terms.every((t) => words.some((w) => w.startsWith(t)));
}

export interface FakeRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });
}

function graphError(status: number, code: string, msg = code, headers: Record<string, string> = {}): Response {
  return json(status, { error: { code, message: msg } }, headers);
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function jwt(claims: Record<string, unknown>): string {
  const part = (o: unknown) => b64url(new TextEncoder().encode(JSON.stringify(o)));
  return `${part({ alg: 'none', typ: 'JWT' })}.${part(claims)}.sig`;
}

async function bodyBytes(body: BodyInit | null | undefined): Promise<Uint8Array> {
  if (body == null) return new Uint8Array(0);
  if (typeof body === 'string') return new TextEncoder().encode(body);
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  if (ArrayBuffer.isView(body)) return new Uint8Array(body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength));
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  return new TextEncoder().encode(String(body));
}

/** `location` + `history` for Node tests: the address bar of one browser tab. `assign` records navigations. */
export class FakeLocation {
  href = '';
  origin = '';
  pathname = '';
  search = '';
  hash = '';
  assigned: string[] = [];
  constructor(url: string) {
    this.set(url);
  }
  set(url: string): void {
    const u = new URL(url);
    this.href = u.href;
    this.origin = u.origin;
    this.pathname = u.pathname;
    this.search = u.search;
    this.hash = u.hash;
  }
  assign = (url: string): void => {
    this.assigned.push(String(url));
  };
  /** A `history` whose replaceState moves this location. */
  history = {
    replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
      if (url != null) this.set(new URL(String(url), this.href).href);
    },
  };
}

/**
 * Sign in through the whole redirect round trip (app → fake Microsoft → app), for tests that need a signed-in device.
 * `auth` is the device's `./auth` module; `loc` must be stubbed as the global `location` (and `loc.history` as `history`).
 */
export async function fakeSignIn(
  ms: FakeMicrosoft,
  loc: FakeLocation,
  auth: { msSignIn(o?: { silent?: boolean }): Promise<never>; takeAuthResponse(): unknown; completeSignIn(r: never): Promise<void> },
  opts: { route?: string; silent?: boolean } = {},
): Promise<void> {
  const start = new URL(ms.redirectUri);
  loc.set(start.href + (opts.route ?? '#/sheets'));
  const before = loc.assigned.length;
  void auth.msSignIn({ silent: opts.silent });
  for (let i = 0; loc.assigned.length === before; i++) {
    if (i > 200) throw new Error('fakeSignIn: the app never navigated to Microsoft');
    await new Promise((r) => setTimeout(r, 5));
  }
  loc.set(ms.authorize(loc.assigned[loc.assigned.length - 1]));
  const r = auth.takeAuthResponse();
  if (!r) throw new Error('fakeSignIn: no sign-in reply in the address');
  await auth.completeSignIn(r as never);
}

export class FakeMicrosoft {
  readonly clientId: string;
  readonly driveId = 'drv1';
  /** The redirect URI the app must use. */
  redirectUri = 'https://hugzgj9.github.io/HugoChineseAPP/';
  /** A Microsoft session in the browser: prompt=none succeeds only while on. */
  session = true;
  /** Lifetime of access tokens, seconds. */
  accessTtl = 3600;
  /** Every request, in order (Authorization headers included, to check where tokens go). */
  requests: FakeRequest[] = [];
  account = { name: 'Test User', preferred_username: 'test@example.com', oid: 'oid-1' };
  /** Set false to make the openid-configuration (reachability) request fail. */
  reachable = true;
  /** Items per page of a children listing (@odata.nextLink beyond). */
  pageSize = 200;

  items = new Map<string, FakeItem>();
  /** Ids served by /me/drive/recent, most recent first (consumer style: each entry wraps a remoteItem). */
  recent: string[] = [];
  private codes = new Map<string, { challenge: string; scope: string; redirect: string }>();
  private access = new Set<string>();
  private refresh = new Set<string>();
  private locked = new Set<string>();
  private fail: { status: number; retryAfter?: number }[] = [];
  private n = 0;
  /** Fake clock for item times, ms. */
  now = () => Date.now();

  constructor(clientId = 'test-client') {
    this.clientId = clientId;
    this.put('', 'root', true, new Uint8Array(0), 'root');
    this.ensureFolder('Apps');
    this.put('Apps', 'Hugo Chinese', true, new Uint8Array(0), 'approot');
  }

  // ---------- controls ----------

  /** Add a file at `path` ('Documents/Hugo_chinese_vocab.xlsx'), creating folders as needed. */
  addFile(path: string, bytes: Uint8Array, at = this.now()): FakeItem {
    const parts = path.split('/');
    const name = parts.pop()!;
    const folder = parts.join('/');
    this.ensureFolder(folder);
    const it = this.put(folder, name, false, bytes);
    it.modified = at;
    return it;
  }

  /** A file in a folder another account shared with Hugo: lives on `drive`, shows in his search as a remoteItem. */
  addShared(path: string, bytes: Uint8Array, drive = 'drv2', at = this.now()): FakeItem {
    const parts = path.split('/');
    const name = parts.pop()!;
    const it = this.put(parts.join('/'), name, false, bytes);
    it.drive = drive;
    it.modified = at;
    return it;
  }

  /** Excel (or anything else) saved new content: new eTag/cTag and modified time. */
  excelSave(id: string, bytes: Uint8Array, at = this.now()): FakeItem {
    const it = this.items.get(id);
    if (!it) throw new Error(`no item ${id}`);
    it.bytes = bytes.slice();
    it.ver++;
    it.cver++;
    it.modified = at;
    return it;
  }

  /** Answer 423 Locked to writes of this item until unlock(). */
  lock(id: string): void {
    this.locked.add(id);
  }
  unlock(id: string): void {
    this.locked.delete(id);
  }

  /** The next Graph request (not sign-in, not download) answers `status`, with Retry-After in seconds if given. */
  failNext(status: number, retryAfter?: number): void {
    this.fail.push({ status, retryAfter });
  }

  /** Microsoft refuses every refresh token from now on (the 24 h limit). */
  expireRefresh(): void {
    this.refresh.clear();
  }

  /** Graph refuses the current access tokens (401) from now on; a refresh gets new ones. */
  revokeAccess(): void {
    this.access.clear();
  }

  /** The item at a path from the root. */
  byPath(path: string): FakeItem | undefined {
    for (const it of this.items.values()) if (!it.drive && this.pathOf(it) === path) return it;
    return undefined;
  }

  eTag(it: FakeItem): string {
    return `"{${it.id}},${it.ver}"`;
  }

  /**
   * Play Microsoft's sign-in page for an authorize URL the app navigated to: the URL the browser comes back to, with a
   * code (or an error, e.g. login_required for prompt=none without a session).
   */
  authorize(authorizeUrl: string): string {
    const u = new URL(authorizeUrl);
    const q = u.searchParams;
    if (u.host !== LOGIN_HOST || !u.pathname.endsWith('/oauth2/v2.0/authorize')) throw new Error(`not an authorize URL: ${authorizeUrl}`);
    const back = new URL(q.get('redirect_uri') ?? '');
    const state = q.get('state') ?? '';
    const reply = (p: Record<string, string>) => {
      for (const [k, v] of Object.entries({ ...p, state })) back.searchParams.set(k, v);
      return back.href;
    };
    if (q.get('client_id') !== this.clientId) return reply({ error: 'unauthorized_client', error_description: 'AADSTS700016: Application not found.' });
    if (back.href !== this.redirectUri) return reply({ error: 'invalid_request', error_description: 'AADSTS50011: Redirect URI mismatch.' });
    if (q.get('response_mode') !== 'query' || q.get('response_type') !== 'code') return reply({ error: 'invalid_request' });
    if (q.get('code_challenge_method') !== 'S256' || !q.get('code_challenge')) return reply({ error: 'invalid_request' });
    if (q.get('prompt') === 'none' && !this.session) {
      return reply({ error: 'login_required', error_description: 'AADSTS50058: A silent sign-in request was sent but no user is signed in.' });
    }
    this.session = true;
    const code = `code-${++this.n}`;
    this.codes.set(code, { challenge: q.get('code_challenge')!, scope: q.get('scope') ?? '', redirect: back.origin + back.pathname });
    return reply({ code });
  }

  // ---------- fetch ----------

  fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? String(input) : input.url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => (headers[k] = v));
    this.requests.push({ method, url: url.href, headers });
    if (url.host === LOGIN_HOST) return this.login(url, method, init);
    if (url.host === GRAPH_HOST) return this.graph(url, method, headers, init);
    if (url.host === FAKE_DOWNLOAD_HOST) return this.downloadHost(url, headers, init);
    throw new TypeError(`Failed to fetch (fake: ${url.host} is not served)`);
  };

  private async login(url: URL, method: string, init: RequestInit): Promise<Response> {
    if (url.pathname.endsWith('/.well-known/openid-configuration')) {
      if (!this.reachable) throw new TypeError('Failed to fetch');
      return json(200, { issuer: 'https://login.microsoftonline.com/9188040d-6c67-4c5b-b112-36a304b66dad/v2.0' });
    }
    if (method !== 'POST' || !url.pathname.endsWith('/oauth2/v2.0/token')) return json(404, {});
    const p = new URLSearchParams(String(init.body ?? ''));
    const bad = (error: string, aad: string) => json(400, { error, error_description: `${aad}: fake`, error_codes: [Number(aad.slice(6))] });
    if (p.get('client_id') !== this.clientId) return bad('unauthorized_client', 'AADSTS700016');
    let scope = '';
    if (p.get('grant_type') === 'authorization_code') {
      const c = this.codes.get(p.get('code') ?? '');
      if (!c) return bad('invalid_grant', 'AADSTS54005');
      this.codes.delete(p.get('code')!);
      const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(p.get('code_verifier') ?? ''));
      if (b64url(new Uint8Array(digest)) !== c.challenge) return bad('invalid_grant', 'AADSTS50148');
      if (p.get('redirect_uri') !== c.redirect) return bad('invalid_grant', 'AADSTS50011');
      scope = c.scope;
    } else if (p.get('grant_type') === 'refresh_token') {
      const rt = p.get('refresh_token') ?? '';
      if (!this.refresh.has(rt)) return bad('invalid_grant', 'AADSTS700084');
      this.refresh.delete(rt);
      scope = p.get('scope') ?? '';
    } else {
      return bad('unsupported_grant_type', 'AADSTS70003');
    }
    const access = `at-${++this.n}`;
    const refresh = `rt-${++this.n}`;
    this.access.add(access);
    this.refresh.add(refresh);
    return json(200, {
      token_type: 'Bearer',
      access_token: access,
      refresh_token: refresh,
      expires_in: this.accessTtl,
      id_token: jwt({ ...this.account, aud: this.clientId }),
      scope: scope.split(' ').filter((s) => !['openid', 'profile', 'offline_access'].includes(s)).join(' '),
    });
  }

  private itemJson(it: FakeItem): Record<string, unknown> {
    const parentPath = this.parentRef(it);
    return {
      id: it.id,
      name: it.name,
      eTag: this.eTag(it),
      cTag: `"c:{${it.id}},${it.cver}"`,
      size: it.bytes.length,
      lastModifiedDateTime: new Date(it.modified).toISOString(),
      parentReference: parentPath,
      ...(it.isFolder
        ? { folder: { childCount: [...this.items.values()].filter((x) => x.folder === this.pathOf(it) && x.id !== it.id).length } }
        : {
            file: { mimeType: 'application/octet-stream', hashes: { quickXorHash: quickXorHash(it.bytes) } },
            '@microsoft.graph.downloadUrl': `https://${FAKE_DOWNLOAD_HOST}/dl/${it.id}?v=${it.ver}&sig=fake`,
          }),
    };
  }

  /** How a consumer drive lists a shared file (search) or any recent file: a local entry wrapping the real item. */
  private remoteJson(it: FakeItem): Record<string, unknown> {
    return { id: `ref-${it.id}`, name: it.name, lastModifiedDateTime: new Date(it.modified).toISOString(), remoteItem: this.itemJson(it) };
  }

  private async graph(url: URL, method: string, h: Record<string, string>, init: RequestInit): Promise<Response> {
    const auth = h.authorization ?? '';
    if (!auth.startsWith('Bearer ') || !this.access.has(auth.slice(7))) {
      return graphError(401, 'InvalidAuthenticationToken', 'Access token has expired or is not yet valid.');
    }
    const f = this.fail.shift();
    if (f) return graphError(f.status, f.status === 429 ? 'activityLimitReached' : 'serviceNotAvailable', 'fake failure', f.retryAfter != null ? { 'Retry-After': String(f.retryAfter) } : {});
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\.0/, ''));

    if (path === '/me' && method === 'GET') return json(200, { displayName: this.account.name, id: this.account.oid });
    if (path === '/me/drive' && method === 'GET') return json(200, { id: this.driveId, driveType: 'personal' });

    const search = /^\/me\/drive\/root\/search\(q='(.*)'\)$/.exec(path);
    if (search && method === 'GET') {
      const q = search[1].replace(/''/g, "'");
      const hits = [...this.items.values()].filter((x) => x.id !== 'root' && x.indexed !== false && searchMatches(x.name, q));
      return json(200, { value: hits.map((x) => (x.drive ? this.remoteJson(x) : this.itemJson(x))) });
    }

    if (path === '/me/drive/recent' && method === 'GET') {
      const hits = this.recent.map((id) => this.items.get(id)).filter((x): x is FakeItem => !!x);
      return json(200, { value: hits.map((x) => this.remoteJson(x)) });
    }

    // By path from a drive root: /me/drive/root:/Documents/x.xlsx (own drive only).
    const byPath = /^(?:\/drives\/([^/]+)|\/me\/drive)\/root:\/(.+?):?$/.exec(path);
    if (byPath && method === 'GET') {
      const it = !byPath[1] || byPath[1] === this.driveId ? this.byPath(byPath[2].replace(/\/+$/, '')) : undefined;
      return it ? json(200, this.itemJson(it)) : graphError(404, 'itemNotFound', 'The resource could not be found.');
    }

    // Children of the app folder or of a folder in it, paged: special/approot[:/data:]/children[?$skiptoken=n]
    const kids = /^\/me\/drive\/special\/approot(?::\/(.+?):)?\/children$/.exec(path);
    if (kids && method === 'GET') {
      const root = this.items.get('approot')!;
      const dir = kids[1] ? this.byPath(`${this.pathOf(root)}/${kids[1]}`) : root;
      if (!dir || !dir.isFolder) return graphError(404, 'itemNotFound', 'The resource could not be found.');
      const all = [...this.items.values()].filter((x) => x.folder === this.pathOf(dir) && x.id !== dir.id && !x.drive);
      const from = Number(url.searchParams.get('$skiptoken') ?? 0);
      const page = all.slice(from, from + this.pageSize);
      const next = from + this.pageSize < all.length ? `https://${GRAPH_HOST}/v1.0${url.pathname.replace(/^\/v1\.0/, '')}?$skiptoken=${from + this.pageSize}` : undefined;
      return json(200, { value: page.map((x) => this.itemJson(x)), ...(next ? { '@odata.nextLink': next } : {}) });
    }

    // special/approot, by itself or by path: special/approot:/diag/x.bin[:/content]
    const app = /^\/me\/drive\/special\/approot(?::\/(.+?))?(:\/content|:)?$/.exec(path);
    if (app) {
      const root = this.items.get('approot')!;
      if (!app[1]) return method === 'GET' ? json(200, this.itemJson(root)) : json(405, {});
      const full = `${this.pathOf(root)}/${app[1]}`;
      const it = this.byPath(full);
      if (app[2] === ':/content' && method === 'PUT') {
        // "Must not exist": conflictBehavior=fail refuses an existing name.
        if (it && !h['if-match'] && url.searchParams.get('@microsoft.graph.conflictBehavior') === 'fail') {
          return graphError(409, 'nameAlreadyExists', 'The specified item name already exists.');
        }
        if (it) return this.replace(it, h, init);
        if (h['if-match']) return graphError(412, 'preconditionFailed');
        const parts = full.split('/');
        const name = parts.pop()!;
        this.ensureFolder(parts.join('/'));
        const created = this.put(parts.join('/'), name, false, await bodyBytes(init.body));
        return json(201, this.itemJson(created));
      }
      if (app[2] === ':/content' && method === 'GET') return it ? this.redirectToDownload(it) : graphError(404, 'itemNotFound');
      if (method === 'GET') return it ? json(200, this.itemJson(it)) : graphError(404, 'itemNotFound');
      return json(405, {});
    }

    const item = /^(?:\/drives\/([^/]+)|\/me\/drive)\/items\/([^/]+)(\/content)?$/.exec(path);
    if (item) {
      const it = this.items.get(item[2]);
      // A shared file only by its own drive; Hugo's files by his drive id or /me/drive.
      if (it && (item[1] ?? this.driveId) !== (it.drive ?? this.driveId)) return graphError(404, 'itemNotFound');
      if (!it) return graphError(404, 'itemNotFound', 'The resource could not be found.');
      if (item[3] && method === 'PUT') return this.replace(it, h, init);
      if (item[3] && method === 'GET') return this.redirectToDownload(it);
      if (method === 'GET') return json(200, this.itemJson(it));
      if (method === 'DELETE') {
        if (h['if-match'] && h['if-match'] !== this.eTag(it)) return graphError(412, 'preconditionFailed');
        this.items.delete(it.id);
        return json(204, null);
      }
    }
    return graphError(400, 'invalidRequest', `fake: ${method} ${path} not supported`);
  }

  private async replace(it: FakeItem, h: Record<string, string>, init: RequestInit): Promise<Response> {
    if (it.isFolder) return graphError(400, 'invalidRequest');
    if (this.locked.has(it.id)) return graphError(423, 'resourceLocked', 'The resource you are attempting to access is locked.');
    const m = h['if-match'];
    if (m && m !== this.eTag(it) && m !== `"c:{${it.id}},${it.cver}"`) return graphError(412, 'preconditionFailed', 'ETag does not match.');
    if (h['if-none-match'] === '*') return graphError(412, 'preconditionFailed', 'The item exists.');
    it.bytes = await bodyBytes(init.body);
    it.ver++;
    it.cver++;
    it.modified = this.now();
    return json(200, this.itemJson(it));
  }

  private redirectToDownload(it: FakeItem): Response {
    return new Response(null, { status: 302, headers: { Location: `https://${FAKE_DOWNLOAD_HOST}/dl/${it.id}?v=${it.ver}&sig=fake` } });
  }

  private downloadHost(url: URL, h: Record<string, string>, init: RequestInit): Response {
    // The real host takes the signature in the URL; an Authorization header there would leak the token to another host.
    if (h.authorization) return new Response('Authorization not expected here', { status: 400 });
    if (init.credentials && init.credentials !== 'omit') return new Response('Credentials not expected', { status: 400 });
    const m = /^\/dl\/([^/]+)$/.exec(url.pathname);
    const it = m && this.items.get(decodeURIComponent(m[1]));
    if (!it || url.searchParams.get('sig') !== 'fake') return new Response('gone', { status: 404 });
    return new Response(it.bytes.slice(), { status: 200, headers: { 'Content-Type': 'application/octet-stream' } });
  }

  // ---------- tree ----------

  private pathOf(it: FakeItem): string {
    if (it.id === 'root') return '';
    return it.folder ? `${it.folder}/${it.name}` : it.name;
  }

  private parentRef(it: FakeItem): { driveId: string; id?: string; path: string } {
    const parent = it.id === 'root' ? undefined : it.folder === '' ? this.items.get('root') : this.byPath(it.folder);
    if (it.drive) return { driveId: it.drive, id: `${it.drive}-parent`, path: `/drives/${it.drive}/root:${it.folder ? `/${it.folder}` : ''}` };
    return { driveId: this.driveId, id: parent?.id, path: `/drive/root:${it.folder ? `/${it.folder}` : ''}` };
  }

  private ensureFolder(path: string): void {
    if (!path) return;
    const parts = path.split('/');
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join('/');
      if (!this.byPath(p)) this.put(parts.slice(0, i - 1).join('/'), parts[i - 1], true, new Uint8Array(0));
    }
  }

  private put(folder: string, name: string, isFolder: boolean, bytes: Uint8Array, id?: string): FakeItem {
    const it: FakeItem = { id: id ?? `item${++this.n}`, name, folder, isFolder, bytes: bytes.slice(), ver: 1, cver: 1, modified: this.now() };
    this.items.set(it.id, it);
    return it;
  }
}
