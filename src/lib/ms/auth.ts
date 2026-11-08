// Microsoft sign-in for a browser-only app: OAuth 2.0 authorization code flow with PKCE, by top-level redirect (D8).
// No popups (iOS opens them outside the Home Screen app), no iframes (Safari blocks them), no MSAL.
//
// kv `msPkce`  { verifier, nonce, silent, at }: the sign-in in flight, one use.
// kv `msAuth`  tokens and the account, on this device only: never synced, never backed up, gone with "Reset this device".
// kv `msAutoAt` when the last automatic (silent) renewal was tried.
// Tokens are only ever sent to login.microsoftonline.com (here) and graph.microsoft.com (graph.ts).

import { kvGet, kvSet, db } from '../db';
import { setMs } from '../store';
import { toBase64 } from '../github';
import { MS_AUTHORITY, MS_CLIENT_ID, MS_SCOPES, clientIdValid } from './config';

export interface AuthResponse {
  code?: string;
  state: string;
  error?: string;
  errorDescription?: string;
}

export class MsAuthError extends Error {
  constructor(
    message: string,
    /** True when only a new sign-in (Reconnect) can fix it; false for a passing problem (offline, server error). */
    public needsSignIn: boolean,
  ) {
    super(message);
  }
}

/** Stored tokens (kv msAuth). */
export interface MsAuth {
  access: string;
  /** When the access token expires (ms). */
  accessExp: number;
  refresh: string;
  /** When the refresh token expires: sign-in + 24 h. Refreshing doesn't extend it. 0 = refused by Microsoft. */
  refreshExp: number;
  /** When the code was redeemed (the start of the 24 h). */
  signInAt: number;
  scope?: string;
  name?: string;
  username?: string;
  oid?: string;
}

interface Pkce {
  verifier: string;
  nonce: string;
  silent: boolean;
  at: number;
}

const HOUR = 3600000;
/** Browser-only apps get refresh tokens that end 24 h after sign-in, whatever is refreshed meanwhile. */
const REFRESH_LIFE = 24 * HOUR;
/** Renew silently at start once the sign-in is older than this. */
const RENEW_AFTER = 20 * HOUR;
/** At most one automatic renewal per this long (a failed one comes back with an error and the banner). */
const AUTO_GUARD = 6 * HOUR;
/** Access tokens are refreshed this long before they expire. */
const EARLY = 5 * 60000;
/** A sign-in reply older than this is refused. */
const PKCE_LIFE = HOUR;

const K_PKCE = 'msPkce';
const K_AUTH = 'msAuth';
const K_AUTO = 'msAutoAt';

export function msConfigured(): boolean {
  return clientIdValid(MS_CLIENT_ID);
}

/** The app's start URL, registered as the SPA redirect URI. */
export function redirectUri(): string {
  return new URL(import.meta.env.BASE_URL, location.origin).href;
}

// ---------- small helpers ----------

function b64url(bytes: Uint8Array): string {
  return toBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): string {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  return atob(b + '='.repeat((4 - (b.length % 4)) % 4));
}

function utf8ToB64url(s: string): string {
  return b64url(new TextEncoder().encode(s));
}

function b64urlToUtf8(s: string): string {
  const bin = fromB64url(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function randomUrlSafe(n: number): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)));
}

/** S256 code challenge of a PKCE verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return b64url(new Uint8Array(digest));
}

/** `state` = nonce + '.' + base64url(route). base64url never contains a dot. */
function makeState(nonce: string, route: string): string {
  return `${nonce}.${utf8ToB64url(route)}`;
}

function parseState(state: string): { nonce: string; route: string } {
  const dot = state.indexOf('.');
  if (dot < 0) return { nonce: state, route: '' };
  let route = '';
  try {
    route = b64urlToUtf8(state.slice(dot + 1));
  } catch {
    route = '';
  }
  // Only a hash route of this app goes back into the address bar.
  if (!/^#\/[^\s<>"]*$/.test(route)) route = '';
  return { nonce: state.slice(0, dot), route };
}

/** The claims of an id_token (not verified: it comes straight from the token endpoint over TLS). */
function idClaims(idToken: string | undefined): { name?: string; preferred_username?: string; oid?: string } {
  if (!idToken) return {};
  try {
    return JSON.parse(b64urlToUtf8(idToken.split('.')[1] ?? '')) as { name?: string; preferred_username?: string; oid?: string };
  } catch {
    return {};
  }
}

function accountLabel(a: Pick<MsAuth, 'name' | 'username'>): string | undefined {
  return a.username || a.name || undefined;
}

const RECONNECT_ERRORS = new Set(['invalid_grant', 'interaction_required', 'login_required', 'consent_required']);

/** Short English messages for the sign-in errors Hugo may meet. */
export function authMessage(error: string | undefined, description?: string): string {
  const code = /AADSTS(\d+)/.exec(description ?? '')?.[1];
  switch (code) {
    case '50058':
      return 'Microsoft needs you to sign in again.';
    case '700084':
    case '70008':
    case '700082':
      return 'Microsoft sign-in expired (browser apps get 24 hours). Reconnect to continue.';
    case '65001':
    case '65004':
      return 'The app was not given access. Sign in again and accept the permissions.';
    case '50011':
      return 'This address is not registered for sign-in. Add it as a Single-page application redirect URI.';
    case '9002326':
    case '7000218':
      return 'The redirect URI must be registered as a Single-page application, not Web.';
    case '700016':
      return 'The app registration was not found. Check the client id in src/lib/ms/config.ts.';
    case '50020':
    case '500200':
    case '90072':
      return 'This Microsoft account type is not allowed by the app registration.';
    case '54005':
      return 'This sign-in reply was already used. Sign in again.';
    case '70011':
      return 'Microsoft refused the requested permissions.';
    case '50076':
    case '50079':
      return 'Microsoft asks for an extra check. Sign in again.';
  }
  switch (error) {
    case 'access_denied':
      return 'Sign-in was cancelled.';
    case 'login_required':
    case 'interaction_required':
    case 'consent_required':
      return 'Microsoft needs you to sign in again.';
    case 'invalid_grant':
      return 'Microsoft sign-in expired. Reconnect to continue.';
    case 'temporarily_unavailable':
    case 'server_error':
      return 'Microsoft sign-in is unavailable for now. Try again later.';
  }
  return `Microsoft sign-in failed${error ? ` (${error})` : ''}.`;
}

async function getAuth(): Promise<MsAuth | null> {
  return kvGet<MsAuth | null>(K_AUTH, null);
}

let tabChain: Promise<unknown> = Promise.resolve();
/**
 * One token refresh at a time: queued within this tab, and across tabs with a Web Lock (iOS before 15.4 has none).
 * A refresh token is single-use, so two refreshes at once would make the second one fail.
 */
function exclusive<T>(fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? (navigator as { locks?: LockManager }).locks : undefined;
  const run = () => (locks?.request ? (locks.request('hz-ms-token', fn) as Promise<T>) : fn());
  const p = tabChain.then(run, run);
  tabChain = p.catch(() => undefined);
  return p;
}

interface TokenReply {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  id_token?: string;
  scope?: string;
  error?: string;
  error_description?: string;
}

/** POST to the token endpoint. A network failure throws MsAuthError (not a sign-in problem). */
async function tokenRequest(params: Record<string, string>): Promise<{ ok: boolean; body: TokenReply }> {
  let res: Response;
  try {
    res = await fetch(`${MS_AUTHORITY}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: MS_CLIENT_ID, ...params }).toString(),
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(120000) : undefined,
    });
  } catch {
    throw new MsAuthError('Microsoft could not be reached. Check the connection.', false);
  }
  let body: TokenReply = {};
  try {
    body = (await res.json()) as TokenReply;
  } catch {
    // no JSON body
  }
  return { ok: res.ok && !!body.access_token, body };
}

// ---------- state at start ----------

/** completeSignIn ran in this page: its outcome (an error, a failed silent try) is the state to show, not the stored one. */
let replied = false;

/**
 * Put the stored sign-in into the app state (ok, reconnect or off), unless a sign-in reply was just handled. Called by
 * shouldRenewAtStart at every start.
 */
export async function loadMsState(now = Date.now()): Promise<MsAuth | null> {
  if (!msConfigured()) {
    setMs({ state: 'off' }, true);
    return null;
  }
  const a = await getAuth();
  if (replied) return a;
  if (!a) setMs({ state: 'off' }, true);
  else if (a.refreshExp > now || a.accessExp - EARLY > now) setMs({ state: 'ok', account: accountLabel(a) }, true);
  else setMs({ state: 'reconnect', account: accountLabel(a), message: 'Microsoft sign-in expired. Reconnect to continue.' }, true);
  return a;
}

// ---------- the redirect ----------

/**
 * Before the first render: when the address holds a sign-in reply (`?code=…&state=…` or `?error=…`), take it out of the
 * address bar and put back the route carried in `state`. Synchronous so the router never sees the reply.
 */
export function takeAuthResponse(): AuthResponse | null {
  if (typeof location === 'undefined' || !location.search) return null;
  const q = new URLSearchParams(location.search);
  const state = q.get('state');
  const code = q.get('code') ?? undefined;
  const error = q.get('error') ?? undefined;
  if (!state || (!code && !error)) return null;
  const { route } = parseState(state);
  try {
    history.replaceState(null, '', import.meta.env.BASE_URL + route);
  } catch {
    // keep going: the reply is still handled
  }
  return { code, state, error, errorDescription: q.get('error_description') ?? undefined };
}

/** Finish a sign-in from its reply: check the nonce, redeem the code (PKCE), store the tokens. Never throws. */
export async function completeSignIn(r: AuthResponse): Promise<void> {
  replied = true;
  const pkce = await kvGet<Pkce | null>(K_PKCE, null);
  await db.kv.delete(K_PKCE); // one use, whatever happens
  const prev = await getAuth();
  const failed = (message: string, reconnect = !!prev) =>
    setMs(reconnect ? { state: 'reconnect', account: prev ? accountLabel(prev) : undefined, message } : { state: 'error', message }, true);

  const { nonce } = parseState(r.state);
  if (!pkce || pkce.nonce !== nonce || Date.now() - pkce.at > PKCE_LIFE) {
    failed(
      pkce
        ? 'This sign-in reply does not match the sign-in started here. Sign in again.'
        : 'This sign-in was started in another window. On iPhone, sign in from the Home Screen app.',
    );
    return;
  }
  if (r.error || !r.code) {
    // A silent renewal that comes back with an error only asks for Reconnect.
    if (pkce.silent) failed(authMessage(r.error, r.errorDescription), true);
    else failed(authMessage(r.error, r.errorDescription));
    return;
  }
  let reply: { ok: boolean; body: TokenReply };
  try {
    reply = await tokenRequest({
      grant_type: 'authorization_code',
      code: r.code,
      redirect_uri: redirectUri(),
      code_verifier: pkce.verifier,
      scope: MS_SCOPES.join(' '),
    });
  } catch (e) {
    failed((e as Error).message);
    return;
  }
  const b = reply.body;
  if (!reply.ok || !b.access_token) {
    failed(authMessage(b.error, b.error_description));
    return;
  }
  const now = Date.now();
  const c = idClaims(b.id_token);
  const auth: MsAuth = {
    access: b.access_token,
    accessExp: now + (b.expires_in ?? 3600) * 1000,
    refresh: b.refresh_token ?? '',
    refreshExp: b.refresh_token ? now + REFRESH_LIFE : 0,
    signInAt: now,
    scope: b.scope,
    name: c.name,
    username: c.preferred_username,
    oid: c.oid,
  };
  await kvSet(K_AUTH, auth);
  setMs({ state: 'ok', account: accountLabel(auth) }, true);
}

/** Leave the app for Microsoft's sign-in page; it comes back to the start URL with a code. `silent` → prompt=none. */
export async function msSignIn(opts: { silent?: boolean } = {}): Promise<never> {
  if (!msConfigured()) throw new MsAuthError('Microsoft sign-in is not configured.', true);
  const verifier = randomUrlSafe(32);
  const nonce = randomUrlSafe(16);
  const silent = !!opts.silent;
  await kvSet(K_PKCE, { verifier, nonce, silent, at: Date.now() } satisfies Pkce);
  const prev = await getAuth();
  const route = typeof location !== 'undefined' && location.hash.startsWith('#/') ? location.hash : '';
  const q = new URLSearchParams({
    client_id: MS_CLIENT_ID,
    response_type: 'code',
    redirect_uri: redirectUri(),
    response_mode: 'query',
    scope: MS_SCOPES.join(' '),
    state: makeState(nonce, route),
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (silent) q.set('prompt', 'none');
  if (prev?.username) q.set('login_hint', prev.username);
  location.assign(`${MS_AUTHORITY}/oauth2/v2.0/authorize?${q}`);
  return new Promise<never>(() => {});
}

/** Forget the tokens on this device. (No Microsoft sign-out page: other Microsoft sites stay signed in.) */
export async function msSignOut(): Promise<void> {
  await db.kv.bulkDelete([K_AUTH, K_PKCE, K_AUTO]);
  setMs({ state: 'off' }, true);
}

/**
 * A valid Graph access token: the stored one, or a refreshed one. `reject` = a token Graph just refused (401): refresh
 * unless another tab already did. Throws MsAuthError; `needsSignIn` → the Reconnect state is set.
 */
export async function msToken(opts: { reject?: string } = {}): Promise<string> {
  const fresh = (a: MsAuth): boolean => !!a.access && a.access !== opts.reject && a.accessExp - EARLY > Date.now();
  const a = await getAuth();
  if (!a) throw new MsAuthError('Not signed in to Microsoft.', true);
  if (fresh(a)) return a.access;
  return exclusive(async () => {
    const cur = await getAuth();
    if (!cur) throw new MsAuthError('Not signed in to Microsoft.', true);
    if (fresh(cur)) return cur.access;
    const now = Date.now();
    const expired = (message: string): never => {
      setMs({ state: 'reconnect', account: accountLabel(cur), message }, true);
      throw new MsAuthError(message, true);
    };
    if (!cur.refresh || cur.refreshExp <= now) expired('Microsoft sign-in expired. Reconnect to continue.');
    const { ok, body } = await tokenRequest({ grant_type: 'refresh_token', refresh_token: cur.refresh, scope: MS_SCOPES.join(' ') });
    if (!ok || !body.access_token) {
      const message = authMessage(body.error, body.error_description);
      if (RECONNECT_ERRORS.has(body.error ?? '')) {
        await kvSet(K_AUTH, { ...cur, refreshExp: 0, accessExp: 0 } satisfies MsAuth);
        expired(message);
      }
      throw new MsAuthError(message, false);
    }
    const next: MsAuth = {
      ...cur,
      access: body.access_token,
      accessExp: now + (body.expires_in ?? 3600) * 1000,
      refresh: body.refresh_token ?? cur.refresh,
      scope: body.scope ?? cur.scope,
    };
    await kvSet(K_AUTH, next);
    return next.access;
  });
}

/** Is Microsoft's sign-in reachable within 3 s? */
async function reachable(): Promise<boolean> {
  try {
    const res = await fetch(`${MS_AUTHORITY}/v2.0/.well-known/openid-configuration`, {
      cache: 'no-store',
      signal: typeof AbortSignal !== 'undefined' && 'timeout' in AbortSignal ? AbortSignal.timeout(3000) : undefined,
    });
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * At start-up: load the sign-in state, then say whether to renew silently now (a prompt=none redirect). True when online,
 * the sign-in is over 20 h old, no automatic try in the last 6 h, and Microsoft answers within 3 s. Records the try.
 */
export async function shouldRenewAtStart(now: number): Promise<boolean> {
  const a = await loadMsState(now);
  if (!a?.signInAt) return false;
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  if (now - a.signInAt <= RENEW_AFTER) return false;
  const last = await kvGet<number>(K_AUTO, 0);
  if (last && now - last < AUTO_GUARD && last <= now) return false;
  if (!(await reachable())) return false;
  await kvSet(K_AUTO, now);
  return true;
}
