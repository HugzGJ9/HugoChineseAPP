import { Activity, addTransitionType, lazy, startTransition, Suspense, useEffect, useLayoutEffect, useRef, useState, ViewTransition, type ReactNode } from 'react';
import { applyUpdate, onUpdateReady } from '../lib/pwa';
import { useApp } from '../lib/store';
import { Icon, Toaster } from './common';
import { useKeyboardInset } from './keyboard';
import { motionOn, syncMotionClass } from './motion';
import { Sheets } from './Sheets';
import './motion.css';
import { Today } from './Today';
import { LinkPage } from './Setup';
import { ReconnectBanner } from './Microsoft';

// Screens other than the Sheets home load on demand; the service worker precaches every chunk, and `preloadScreens`
// fetches them all once the app is idle, so a first visit never shows an empty page while its chunk loads.
const load = {
  review: () => import('./Review'),
  cards: () => import('./cards/Cards'),
  words: () => import('./Words'),
  grammar: () => import('./grammar/GrammarPage'),
  stats: () => import('./Stats'),
  settings: () => import('./Settings'),
};
const Review = lazy(() => load.review().then((m) => ({ default: m.Review })));
const CardsPage = lazy(() => load.cards().then((m) => ({ default: m.CardsPage })));
const Words = lazy(() => load.words().then((m) => ({ default: m.Words })));
const GrammarPage = lazy(() => load.grammar().then((m) => ({ default: m.GrammarPage })));
const Stats = lazy(() => load.stats().then((m) => ({ default: m.Stats })));
const Report = lazy(() => load.stats().then((m) => ({ default: m.Report })));
const Settings = lazy(() => load.settings().then((m) => ({ default: m.Settings })));

let preloaded = false;
/** Fetches every screen chunk once, after start-up work (sync, warm-up) has had its turn. */
function preloadScreens(): void {
  if (preloaded) return;
  preloaded = true;
  const run = () => {
    for (const f of Object.values(load)) f().catch(() => undefined);
  };
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }).requestIdleCallback;
  setTimeout(() => (idle ? idle(run, { timeout: 4000 }) : run()), 2500);
}

// The three tabs stay mounted once visited (hidden with <Activity>): going back to one is instant and keeps its
// scroll position, its open sheet tab, filter and typed answers. Everything else mounts on each visit.
const KEPT = ['sheets', 'grammar', 'settings'] as const;
type Kept = (typeof KEPT)[number];
const isKept = (p: string): p is Kept => (KEPT as readonly string[]).includes(p);
const ROUTES = ['review', 'cards', 'today', 'words', 'grammar', 'stats', 'settings', 'report', 'link', 'quick', 'sheets'];

// How deep a route is: tabs 0; a Grammar point, or a screen under Settings → More, 1; a Words entry 2. Full-screen
// Cards, Review and the link page are not part of the hierarchy (null: they fade).
function depth(r: string[]): number | null {
  const [p, ...rest] = r;
  if (p === 'review' || p === 'cards' || p === 'link') return null;
  if (p === 'words') return rest.length ? 2 : 1;
  if (p === 'today' || p === 'stats' || p === 'report') return 1;
  if (p === 'grammar') return rest.length ? 1 : 0;
  return 0;
}

function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'sheets').split('/').map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  const last = useRef(route);
  // Page scroll of each tab screen when it was left (window scroll is shared by all screens).
  const scrolls = useRef<Record<string, number>>({});
  const shownRoute = useRef(route);
  useEffect(() => {
    const on = () => {
      const next = read();
      // Saved under the screen still on show (the last committed route): two quick changes must not file Sheets'
      // scroll under a screen that never drew.
      const on = shownRoute.current;
      if (isKept(screenOf(on[0]))) scrolls.current[on.join('/')] = window.scrollY;
      // Always a transition: the current screen stays on show until the next one is ready (a chunk still loading, a
      // long list), instead of an empty page. "Try new animations" on (device only): deeper slides in from the right,
      // shallower back from the left, anything else cross-fades.
      startTransition(() => {
        if (motionOn()) {
          const a = depth(last.current);
          const b = depth(next);
          addTransitionType(a === null || b === null || a === b ? 'vt-fade' : b > a ? 'vt-fwd' : 'vt-back');
        }
        setRoute(next);
      });
      last.current = next;
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  // Scroll once the new screen is committed (so the old one doesn't jump before it goes): back where a tab was left,
  // else to the top.
  useLayoutEffect(() => {
    shownRoute.current = route;
    const key = route.join('/');
    window.scrollTo(0, isKept(screenOf(route[0])) ? scrolls.current[key] ?? 0 : 0);
  }, [route]);
  return route;
}

const screenOf = (page: string): string => (ROUTES.includes(page) ? page : 'sheets');

syncMotionClass();

const TABS = [
  { id: 'sheets', label: 'Sheets', icon: 'sheets' },
  { id: 'grammar', label: 'Grammar', icon: 'grammar' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const TITLES: Record<string, string> = { sheets: 'Sheets', settings: 'Settings', today: 'Today', words: 'Words', grammar: 'Grammar', stats: 'Stats', report: 'Import report', link: 'Link', review: 'Review', cards: 'Cards' };
// Screens reached from Settings → More keep the Settings tab lit.
const UNDER_SETTINGS = ['today', 'words', 'stats', 'report'];

function UpdateBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => onUpdateReady(() => setOn(true)), []);
  if (!on) return null;
  return (
    <div className="banner" role="status">
      <span className="banner-icon" aria-hidden="true">
        <Icon name="download" />
      </span>
      <span className="grow">
        <b>New version ready</b>
        <span className="banner-sub">Reload to update.</span>
      </span>
      <button type="button" className="btn small primary" onClick={applyUpdate}>
        Reload
      </button>
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const [page, ...rest] = useRoute();
  const screen = screenOf(page);
  useKeyboardInset();
  // Old Quick links (bookmarks, the Home Screen app reopening on them) land on Sheets.
  useEffect(() => {
    if (page === 'quick') location.replace('#/sheets');
  }, [page]);
  const inReview = screen === 'review' || screen === 'cards';
  useEffect(() => {
    document.title = screen === 'sheets' ? 'Hugo 中文' : `${TITLES[screen] ?? 'Hugo 中文'} · Hugo 中文`;
  }, [screen]);
  useEffect(() => {
    if (ready) preloadScreens();
  }, [ready]);
  // Tab screens visited so far, and the route each one last showed (a hidden Grammar keeps its open point).
  const visited = useRef(new Map<Kept, string[]>());
  if (ready && isKept(screen)) visited.current.set(screen, rest);

  const nav = !inReview && (
    <nav className="nav" aria-label="Main">
      <div className="brand">
        <img src="icons/icon-192.png" alt="" width="32" height="32" />
        Hugo 中文
      </div>
      {TABS.map((t) => {
        const on = screen === t.id || (t.id === 'settings' && UNDER_SETTINGS.includes(screen));
        return (
          <a key={t.id} href={`#/${t.id}`} aria-current={on ? 'page' : undefined}>
            <Icon name={t.icon} filled={on} />
            <span>{t.label}</span>
          </a>
        );
      })}
    </nav>
  );
  // Before the words are read from storage: the shell and tab bar, not a white screen.
  if (!ready) {
    return (
      <div className={`shell ${inReview ? 'focus' : ''}`}>
        {nav}
        <main className="page" aria-busy="true" />
      </div>
    );
  }

  const motion = motionOn();
  const keptView = (k: Kept, r: string[]): ReactNode =>
    k === 'grammar' ? <GrammarPage id={r.join('/') || undefined} /> : k === 'settings' ? <Settings /> : <Sheets />;
  // With motion on, a screen slides or fades in and out: when its Activity is shown or hidden, or a keyed screen mounts.
  const vt = (child: ReactNode, key?: string) =>
    motion ? (
      <ViewTransition
        key={key}
        default="vt-fade"
        enter={{ 'vt-fwd': 'vt-fwd', 'vt-back': 'vt-back', default: 'vt-fade' }}
        exit={{ 'vt-fwd': 'vt-fwd', 'vt-back': 'vt-back', default: 'vt-fade' }}
        update={{ 'vt-fwd': 'vt-fwd', 'vt-back': 'vt-back', default: 'none' }}
      >
        {child}
      </ViewTransition>
    ) : (
      child
    );

  let view: ReactNode = null;
  switch (screen) {
    case 'review':
      view = <Review />;
      break;
    case 'cards':
      view = <CardsPage />;
      break;
    case 'today':
      view = <Today />;
      break;
    case 'words':
      view = <Words id={rest.join('/') || undefined} />;
      break;
    case 'stats':
      view = <Stats />;
      break;
    case 'report':
      view = <Report />;
      break;
    case 'link':
      view = <LinkPage keyText={rest.join('/')} />;
      break;
  }
  return (
    <div className={`shell ${inReview ? 'focus' : ''}`}>
      {nav}
      <Suspense fallback={<main className="page" aria-busy="true" />}>
        {[...visited.current].map(([k, r]) => (
          <Activity key={k} mode={k === screen ? 'visible' : 'hidden'}>
            {vt(keptView(k, r))}
          </Activity>
        ))}
        {view && vt(view, screen)}
      </Suspense>
      <div className="banners">
        <ReconnectBanner />
        <UpdateBanner />
      </div>
      <Toaster />
    </div>
  );
}
