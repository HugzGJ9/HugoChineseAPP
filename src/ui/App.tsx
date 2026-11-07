import { useEffect, useState } from 'react';
import { applyUpdate, onUpdateReady } from '../lib/pwa';
import { useApp } from '../lib/store';
import { Icon, Toaster } from './common';
import { Today } from './Today';
import { Sheets } from './Sheets';
import { Review } from './Review';
import { Quick } from './Quick';
import { Grammar, Words } from './Words';
import { Report, Stats } from './Stats';
import { Settings } from './Settings';
import { LinkPage } from './Setup';

function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'sheets').split('/').map(decodeURIComponent);
  const [route, setRoute] = useState(read);
  useEffect(() => {
    const on = () => {
      setRoute(read());
      window.scrollTo(0, 0);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return route;
}

const TABS = [
  { id: 'sheets', label: 'Sheets', icon: 'sheets' },
  { id: 'quick', label: 'Quick', icon: 'quick' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];
const TITLES: Record<string, string> = { sheets: 'Sheets', quick: 'Quick memory', settings: 'Settings', today: 'Today', words: 'Words', grammar: 'Grammar', stats: 'Stats', report: 'Import report', link: 'Link', review: 'Review' };
// Screens reached from Settings → More keep the Settings tab lit.
const UNDER_SETTINGS = ['today', 'words', 'grammar', 'stats', 'report'];

function UpdateBanner() {
  const [on, setOn] = useState(false);
  useEffect(() => onUpdateReady(() => setOn(true)), []);
  if (!on) return null;
  return (
    <div
      className="notice ok row"
      role="status"
      style={{ position: 'fixed', top: 'calc(8px + env(safe-area-inset-top))', left: 12, right: 12, maxWidth: 420, margin: '0 auto', zIndex: 60, alignItems: 'center', boxShadow: '0 2px 10px rgba(0,0,0,.18)' }}
    >
      <span className="grow">New version.</span>
      <button type="button" className="btn small" onClick={applyUpdate}>
        Reload
      </button>
    </div>
  );
}

export function App() {
  const ready = useApp((s) => s.ready);
  const [page, ...rest] = useRoute();
  const inReview = page === 'review';
  useEffect(() => {
    document.title = page === 'sheets' ? 'Hugo 中文' : `${TITLES[page] ?? 'Hugo 中文'} · Hugo 中文`;
  }, [page]);
  if (!ready) return null;
  let view: React.ReactNode;
  switch (page) {
    case 'review':
      view = <Review />;
      break;
    case 'today':
      view = <Today />;
      break;
    case 'quick':
      view = <Quick />;
      break;
    case 'words':
      view = <Words id={rest.join('/') || undefined} />;
      break;
    case 'grammar':
      view = <Grammar id={rest.join('/') || undefined} />;
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
    default:
      view = <Sheets />;
  }
  return (
    <div className={`shell ${inReview ? 'focus' : ''}`}>
      {!inReview && (
        <nav className="nav" aria-label="Main">
          <div className="brand">
            <span className="grid-cell" style={{ ['--cell' as string]: '34px' }}>学</span>
            Hugo 中文
          </div>
          {TABS.map((t) => (
            <a key={t.id} href={`#/${t.id}`} aria-current={page === t.id || (t.id === 'settings' && UNDER_SETTINGS.includes(page)) ? 'page' : undefined}>
              <Icon name={t.icon} />
              <span>{t.label}</span>
            </a>
          ))}
        </nav>
      )}
      {view}
      <UpdateBanner />
      <Toaster />
    </div>
  );
}
