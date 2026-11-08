// Microsoft sign-in against the in-memory fake (fake.ts): no real credentials, no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import Dexie from 'dexie';
import { FakeLocation, FakeMicrosoft } from './fake';

// The redirect URI is the start URL: origin + BASE_URL ('/HugoChineseAPP/' in the build, '/' under vitest).
const START = `https://hugzgj9.github.io${import.meta.env.BASE_URL}`;
const HOUR = 3600000;

let ms: FakeMicrosoft;
let loc: FakeLocation;

/** Fresh modules and an empty IndexedDB: one device. */
async function device(clientId = 'test-client', idb = new IDBFactory()) {
  vi.resetModules();
  vi.stubEnv('VITE_MS_CLIENT_ID', clientId);
  Dexie.dependencies.indexedDB = idb;
  Dexie.dependencies.IDBKeyRange = IDBKeyRange;
  const auth = await import('./auth');
  const store = await import('../store');
  const db = await import('../db');
  return { auth, store, db, idb };
}
type Device = Awaited<ReturnType<typeof device>>;

/** The whole redirect round trip: app → Microsoft → app. */
async function signIn(d: Device, route = '#/settings/more', silent = false) {
  loc.set(START + route);
  void d.auth.msSignIn({ silent });
  await vi.waitFor(() => expect(loc.assigned.length).toBeGreaterThan(0));
  const back = ms.authorize(loc.assigned.pop()!);
  loc.set(back);
  const r = d.auth.takeAuthResponse();
  expect(r).not.toBeNull();
  await d.auth.completeSignIn(r!);
  return r!;
}

async function b64urlSha256(s: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  return btoa(String.fromCharCode(...d)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

beforeEach(() => {
  ms = new FakeMicrosoft('test-client');
  ms.redirectUri = START;
  loc = new FakeLocation(START);
  vi.stubGlobal('fetch', ms.fetch);
  vi.stubGlobal('location', loc);
  vi.stubGlobal('history', loc.history);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('configuration', () => {
  it('is off without a client id, and makes no request', async () => {
    const d = await device('');
    expect(d.auth.msConfigured()).toBe(false);
    expect(await d.auth.shouldRenewAtStart(Date.now())).toBe(false);
    await expect(d.auth.msSignIn()).rejects.toThrow(/not configured/);
    expect(ms.requests).toHaveLength(0);
    expect(d.store.getState().ms.state).toBe('off');
  });

  it('treats the all-zero GUID as a placeholder', async () => {
    const d = await device('00000000-0000-0000-0000-000000000000');
    expect(d.auth.msConfigured()).toBe(false);
  });
});

describe('sign-in redirect', () => {
  it('sends a S256 PKCE challenge of the saved verifier, and the route in state', async () => {
    const d = await device();
    loc.set(START + '#/sheets');
    void d.auth.msSignIn();
    await vi.waitFor(() => expect(loc.assigned).toHaveLength(1));
    const u = new URL(loc.assigned[0]);
    expect(u.origin + u.pathname).toBe('https://login.microsoftonline.com/consumers/oauth2/v2.0/authorize');
    const q = u.searchParams;
    const pkce = await d.db.kvGet<{ verifier: string; nonce: string; silent: boolean }>('msPkce', { verifier: '', nonce: '', silent: true });
    expect(pkce.verifier).toMatch(/^[\w-]{43}$/);
    expect(pkce.silent).toBe(false);
    expect(q.get('code_challenge_method')).toBe('S256');
    expect(q.get('code_challenge')).toBe(await b64urlSha256(pkce.verifier));
    expect(q.get('response_mode')).toBe('query');
    expect(q.get('redirect_uri')).toBe(START);
    expect(q.get('scope')).toBe('openid profile offline_access User.Read Files.ReadWrite');
    expect(q.get('state')!.startsWith(pkce.nonce + '.')).toBe(true);
    expect(q.get('prompt')).toBeNull();
  });

  it('comes back, restores the route before render, and stores the tokens', async () => {
    const d = await device();
    await signIn(d, '#/settings/more');
    expect(loc.href).toBe(START + '#/settings/more');
    expect(loc.search).toBe('');
    expect(d.store.getState().ms).toEqual({ state: 'ok', account: 'test@example.com' });
    const a = await d.db.kvGet<{ access: string; refresh: string; refreshExp: number; signInAt: number; oid: string; name: string }>('msAuth', null as never);
    expect(a.access).toMatch(/^at-/);
    expect(a.refresh).toMatch(/^rt-/);
    expect(a.refreshExp - a.signInAt).toBe(24 * HOUR);
    expect(a.oid).toBe('oid-1');
    expect(a.name).toBe('Test User');
    expect(await d.db.kvGet('msPkce', null)).toBeNull();
    expect(await d.auth.msToken()).toBe(a.access);
  });

  it('ignores an address without a sign-in reply', async () => {
    const d = await device();
    loc.set(START + '?x=1#/sheets');
    expect(d.auth.takeAuthResponse()).toBeNull();
    expect(loc.href).toBe(START + '?x=1#/sheets');
  });

  it('rejects a reply whose state does not match the saved nonce', async () => {
    const d = await device();
    loc.set(START + '#/sheets');
    void d.auth.msSignIn();
    await vi.waitFor(() => expect(loc.assigned).toHaveLength(1));
    const back = new URL(ms.authorize(loc.assigned[0]));
    back.searchParams.set('state', 'forged.' + back.searchParams.get('state')!.split('.')[1]);
    loc.set(back.href);
    const r = d.auth.takeAuthResponse()!;
    expect(loc.href).toBe(START + '#/sheets');
    await d.auth.completeSignIn(r);
    expect(d.store.getState().ms.state).toBe('error');
    expect(await d.db.kvGet('msAuth', null)).toBeNull();
    // The code was never redeemed.
    expect(ms.requests.filter((x) => x.url.endsWith('/token'))).toHaveLength(0);
  });

  it('says where to sign in when the reply reaches a window that did not start it (iPhone Safari)', async () => {
    const d = await device();
    loc.set(START + '?code=abc&state=nonce.' + btoa('#/sheets').replace(/=+$/, ''));
    const r = d.auth.takeAuthResponse()!;
    await d.auth.completeSignIn(r);
    expect(d.store.getState().ms).toMatchObject({ state: 'error', message: expect.stringMatching(/Home Screen app/) });
  });

  it('maps a cancelled sign-in to a short message', async () => {
    const d = await device();
    loc.set(START);
    void d.auth.msSignIn();
    await vi.waitFor(() => expect(loc.assigned).toHaveLength(1));
    const back = new URL(ms.authorize(loc.assigned[0]));
    back.searchParams.delete('code');
    back.searchParams.set('error', 'access_denied');
    loc.set(back.href);
    await d.auth.completeSignIn(d.auth.takeAuthResponse()!);
    expect(d.store.getState().ms).toMatchObject({ state: 'error', message: 'Sign-in was cancelled.' });
    // The start-up check that follows (main.tsx) keeps the reply's outcome on screen.
    expect(await d.auth.shouldRenewAtStart(Date.now())).toBe(false);
    expect(d.store.getState().ms).toMatchObject({ state: 'error', message: 'Sign-in was cancelled.' });
  });

  it('a silent try that comes back with an error only sets reconnect, and keeps the account', async () => {
    const d = await device();
    await signIn(d);
    ms.session = false;
    await signIn(d, '#/sheets', true);
    expect(d.store.getState().ms).toMatchObject({ state: 'reconnect', account: 'test@example.com' });
    expect(await d.db.kvGet('msAuth', null)).not.toBeNull();
    await d.auth.shouldRenewAtStart(Date.now());
    expect(d.store.getState().ms.state).toBe('reconnect');
    expect(loc.href).toBe(START + '#/sheets');
  });

  it('a silent renewal with a live session starts a new 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1_800_000_000_000);
    const d = await device();
    await signIn(d);
    vi.setSystemTime(1_800_000_000_000 + 21 * HOUR);
    await signIn(d, '#/sheets', true);
    const a = await d.db.kvGet<{ signInAt: number; refreshExp: number }>('msAuth', null as never);
    // (vi.waitFor moves the fake clock by a few ms)
    expect(a.signInAt - (1_800_000_000_000 + 21 * HOUR)).toBeLessThan(1000);
    expect(a.refreshExp - a.signInAt).toBe(24 * HOUR);
    expect(d.store.getState().ms.state).toBe('ok');
  });
});

describe('tokens', () => {
  it('refreshes an expired access token without extending the 24 hours', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const d = await device();
    await signIn(d);
    const first = await d.auth.msToken();
    vi.setSystemTime(t0 + 2 * HOUR);
    const second = await d.auth.msToken();
    expect(second).not.toBe(first);
    const a = await d.db.kvGet<{ refreshExp: number; signInAt: number }>('msAuth', null as never);
    expect(a.signInAt - t0).toBeLessThan(1000); // vi.waitFor moves the fake clock by a few ms
    expect(a.refreshExp - a.signInAt).toBe(24 * HOUR);
    // cached while valid
    const n = ms.requests.length;
    expect(await d.auth.msToken()).toBe(second);
    expect(ms.requests.length).toBe(n);
  });

  it('refreshes when Graph rejected the current token, once across concurrent callers', async () => {
    const d = await device();
    await signIn(d);
    const bad = await d.auth.msToken();
    const [a, b] = await Promise.all([d.auth.msToken({ reject: bad }), d.auth.msToken({ reject: bad })]);
    expect(a).not.toBe(bad);
    expect(b).toBe(a);
    expect(ms.requests.filter((x) => x.url.endsWith('/token'))).toHaveLength(2); // code + one refresh
  });

  it('a refused refresh token → needsSignIn and the reconnect state, then no more requests', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const d = await device();
    await signIn(d);
    ms.expireRefresh();
    vi.setSystemTime(t0 + 2 * HOUR);
    const err = await d.auth.msToken().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(d.auth.MsAuthError);
    expect((err as InstanceType<typeof d.auth.MsAuthError>).needsSignIn).toBe(true);
    expect(d.store.getState().ms).toMatchObject({ state: 'reconnect', account: 'test@example.com' });
    const n = ms.requests.length;
    await expect(d.auth.msToken()).rejects.toMatchObject({ needsSignIn: true });
    expect(ms.requests.length).toBe(n);
  });

  it('past the 24 hours → reconnect without asking Microsoft', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const d = await device();
    await signIn(d);
    vi.setSystemTime(t0 + 25 * HOUR);
    const n = ms.requests.length;
    await expect(d.auth.msToken()).rejects.toMatchObject({ needsSignIn: true });
    expect(ms.requests.length).toBe(n);
    expect(d.store.getState().ms.state).toBe('reconnect');
  });

  it('offline → a passing error, the sign-in stays', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = 1_800_000_000_000;
    vi.setSystemTime(t0);
    const d = await device();
    await signIn(d);
    vi.setSystemTime(t0 + 2 * HOUR);
    vi.stubGlobal('fetch', () => Promise.reject(new TypeError('Failed to fetch')));
    await expect(d.auth.msToken()).rejects.toMatchObject({ needsSignIn: false });
    expect(d.store.getState().ms.state).toBe('ok');
  });

  it('sign-out forgets the tokens', async () => {
    const d = await device();
    await signIn(d);
    await d.auth.msSignOut();
    expect(await d.db.kvGet('msAuth', null)).toBeNull();
    expect(d.store.getState().ms.state).toBe('off');
    await expect(d.auth.msToken()).rejects.toMatchObject({ needsSignIn: true });
  });
});

describe('shouldRenewAtStart', () => {
  const t0 = 1_800_000_000_000;

  /** Signed in at `t`, then the app is opened again later (a new page: same IndexedDB, fresh modules). */
  async function signedInAt(t: number) {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(t);
    const first = await device();
    await signIn(first);
    first.db.db.close();
    return device('test-client', first.idb);
  }

  it('is false without a sign-in, and loads the off state', async () => {
    const d = await device();
    expect(await d.auth.shouldRenewAtStart(t0)).toBe(false);
    expect(d.store.getState().ms.state).toBe('off');
  });

  it('waits until the sign-in is over 20 hours old', async () => {
    const d = await signedInAt(t0);
    expect(d.store.getState().ms.state).toBe('off'); // before the start-up check
    expect(await d.auth.shouldRenewAtStart(t0 + 19 * HOUR)).toBe(false);
    expect(d.store.getState().ms.state).toBe('ok'); // loaded from kv
    expect(await d.auth.shouldRenewAtStart(t0 + 21 * HOUR)).toBe(true);
    expect(await d.db.kvGet('msAutoAt', 0)).toBe(t0 + 21 * HOUR);
  });

  it('tries at most once per 6 hours', async () => {
    const d = await signedInAt(t0);
    expect(await d.auth.shouldRenewAtStart(t0 + 21 * HOUR)).toBe(true);
    expect(await d.auth.shouldRenewAtStart(t0 + 26 * HOUR)).toBe(false);
    expect(d.store.getState().ms.state).toBe('reconnect'); // past 24 h, no try: the banner
    expect(await d.auth.shouldRenewAtStart(t0 + 27.5 * HOUR)).toBe(true);
  });

  it('skips when offline or when Microsoft is unreachable, without using up the 6 hours', async () => {
    const d = await signedInAt(t0);
    vi.stubGlobal('navigator', { onLine: false });
    expect(await d.auth.shouldRenewAtStart(t0 + 21 * HOUR)).toBe(false);
    vi.stubGlobal('navigator', { onLine: true });
    ms.reachable = false;
    expect(await d.auth.shouldRenewAtStart(t0 + 21 * HOUR)).toBe(false);
    expect(await d.db.kvGet('msAutoAt', 0)).toBe(0);
    ms.reachable = true;
    expect(await d.auth.shouldRenewAtStart(t0 + 21 * HOUR)).toBe(true);
  });
});

describe('authMessage', () => {
  it('maps common AADSTS codes to short English messages', async () => {
    const { auth } = await device();
    expect(auth.authMessage('invalid_grant', 'AADSTS700084: The refresh token was issued to a single page app…')).toMatch(/24 hours/);
    expect(auth.authMessage('invalid_request', 'AADSTS50011: The redirect URI…')).toMatch(/redirect URI/);
    expect(auth.authMessage('invalid_request', 'AADSTS9002326: Cross-origin token redemption…')).toMatch(/Single-page application/);
    expect(auth.authMessage('weird')).toBe('Microsoft sign-in failed (weird).');
  });
});
