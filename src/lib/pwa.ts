// Service worker registration and the update flow.
// The worker uses skipWaiting + clientsClaim, so a new version takes control by itself ("controllerchange").
// The page that is already open still runs the old JS, so we tell the user, and reload by ourselves
// when they are not studying.
const BASE = import.meta.env.BASE_URL;
const UPDATE_CHECK_MS = 30 * 60 * 1000;
const RELOAD_DELAY_MS = 2500;

/** Routes where a reload would interrupt a card on screen. */
const STUDY_ROUTES = new Set(['review', 'quick']);

export function routeOf(hash: string): string {
  return (hash.replace(/^#\/?/, '').split('?')[0] || 'today').split('/')[0];
}

/** Reload on our own only when the app is visible, not on a study screen and not in the middle of typing. */
export function shouldAutoReload(s: { hash: string; visible: boolean; editing: boolean }): boolean {
  return s.visible && !s.editing && !STUDY_ROUTES.has(routeOf(s.hash));
}

let ready = false;
let reloading = false;
let timer: ReturnType<typeof setTimeout> | undefined;
const listeners = new Set<() => void>();

function editing(): boolean {
  const el = document.activeElement as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

/** Calls f when a new version is installed and waiting for a reload. Returns an unsubscribe function. */
export function onUpdateReady(f: () => void): () => void {
  listeners.add(f);
  if (ready) f();
  return () => listeners.delete(f);
}

export function applyUpdate(): void {
  if (reloading) return;
  reloading = true;
  location.reload();
}

function maybeReload() {
  if (!ready || reloading) return;
  clearTimeout(timer);
  if (!shouldAutoReload({ hash: location.hash, visible: document.visibilityState === 'visible', editing: editing() })) return;
  // A short pause so the banner is seen; the state is checked again when it ends.
  timer = setTimeout(() => {
    if (shouldAutoReload({ hash: location.hash, visible: document.visibilityState === 'visible', editing: editing() })) applyUpdate();
  }, RELOAD_DELAY_MS);
}

export function startPwa(): void {
  if (!('serviceWorker' in navigator) || import.meta.env.DEV) return;
  const sw = navigator.serviceWorker;
  // Without a controller at boot, the first controllerchange is the first install claiming this page: not an update.
  let hadController = !!sw.controller;
  sw.addEventListener('controllerchange', () => {
    if (!hadController) {
      hadController = true;
      return;
    }
    ready = true;
    for (const f of [...listeners]) f();
    maybeReload();
  });
  window.addEventListener('hashchange', maybeReload);
  document.addEventListener('focusout', () => setTimeout(maybeReload, 300));

  let lastCheck = Date.now();
  let reg: ServiceWorkerRegistration | undefined;
  const check = () => {
    lastCheck = Date.now();
    reg?.update().catch(() => {});
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    maybeReload();
    if (Date.now() - lastCheck > UPDATE_CHECK_MS) check();
  });
  sw.register(`${BASE}sw.js`, { scope: BASE })
    .then((r) => {
      reg = r;
      check();
    })
    .catch(() => {});
}
