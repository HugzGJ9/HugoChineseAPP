import { lazy, startTransition, Suspense, useEffect, useState, ViewTransition } from 'react';
import { applyUpdate, onUpdateReady } from '../lib/pwa';
import { useApp } from '../lib/store';
import { Icon, Toaster } from './common';
import { useKeyboardInset } from './keyboard';
import { motionOn, syncMotionClass } from './motion';
import { Sheets } from './Sheets';
import { Today } from './Today';
import { LinkPage } from './Setup';
import { ReconnectBanner } from './Microsoft';

// Screens other than the Sheets home load on demand; the service worker precaches every chunk.
const Review = lazy(() => import('./Review').then((m) => ({ default: m.Review })));
const CardsPage = lazy(() => import('./cards/Cards').then((m) => ({ default: m.CardsPage })));
const Words = lazy(() => import('./Words').then((m) => ({ default: m.Words })));
const GrammarPage = lazy(() => import('./grammar/GrammarPage').then((m) => ({ default: m.GrammarPage })));
const Stats = lazy(() => import('./Stats').then((m) => ({ default: m.Stats })));
const Report = lazy(() => import('./Stats').then((m) => ({ default: m.Report })));
const Settings = lazy(() => import('./Settings').then((m) => ({ default: m.Settings })));

function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'sheets').split('/').map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      // Plan 2026-11-22-ui-polish WP0: with "Try new animations" on (device only), screens change in a transition.
      if (motionOn()) startTransition(() => setRoute(read()));
      else setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

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
  useKeyboardInset();
  // Old Quick links (bookmarks, the Home Screen app reopening on them) land on Sheets.
  useEffect(() => {
    if (page === 'quick') location.replace('#/sheets');
  }, [page]);
  const inReview = page === 'review' || page === 'cards';
  useEffect(() => {
    document.title = page === 'sheets' ? 'Hugo 中文' : `${TITLES[page] ?? 'Hugo 中文'} · Hugo 中文`;
  }, [page]);
  if (!ready) return null;
  let view: React.ReactNode;
  switch (page) {
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
    case 'grammar':
      view = <GrammarPage id={rest.join('/') || undefined} />;
      break;
    case 'stats':
      view = <Stats />;
      break;
    case 'settings':
      view = <Settings />;
      break;
    case 'report':
      view = <Report />;
      break;
    case 'link':
      view = <LinkPage keyText={rest.join('/')} />;
      break;
    case 'quick':
      view = null;
      break;
    default:
      view = <Sheets />;
  }
  return (
    <div className={`shell ${inReview ? 'focus' : ''}`}>
      {!inReview && (
        <nav className="nav" aria-label="Main">
          <div className="brand">
            <img src="icons/icon-192.png" alt="" width="32" height="32" />
            Hugo 中文
          </div>
          {TABS.map((t) => {
            const on = page === t.id || (t.id === 'settings' && UNDER_SETTINGS.includes(page));
            return (
              <a key={t.id} href={`#/${t.id}`} aria-current={on ? 'page' : undefined}>
                <Icon name={t.icon} filled={on} />
                <span>{t.label}</span>
              </a>
            );
          })}
        </nav>
      )}
      <Suspense fallback={<main className="page" aria-busy="true" />}>
        {motionOn() ? (
          <ViewTransition key={page} default="vt-fade">
            {view}
          </ViewTransition>
        ) : (
          view
        )}
      </Suspense>
      <div className="banners">
        <ReconnectBanner />
        <UpdateBanner />
      </div>
      <Toaster />
    </div>
  );
}
