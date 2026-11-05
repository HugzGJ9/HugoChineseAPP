import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { Icon, Toaster } from './common';
import { Today } from './Today';
import { Review } from './Review';
import { Quick } from './Quick';
import { Grammar, Words } from './Words';
import { Report, Stats } from './Stats';
import { Settings } from './Settings';

function useRoute(): string[] {
  const read = () => (location.hash.replace(/^#\/?/, '').split('?')[0] || 'today').split('/').map(decodeURIComponent);
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
  { id: 'today', label: 'Today', icon: 'today' },
  { id: 'quick', label: 'Quick memory', icon: 'quick' },
  { id: 'words', label: 'Words', icon: 'words' },
  { id: 'grammar', label: 'Grammar', icon: 'grammar' },
  { id: 'stats', label: 'Stats', icon: 'stats' },
  { id: 'settings', label: 'Settings', icon: 'settings' },
];

export function App() {
  const ready = useApp((s) => s.ready);
  const [page, ...rest] = useRoute();
  const inReview = page === 'review';
  useEffect(() => {
    document.title = page === 'today' ? 'Hugo 中文' : `${TABS.find((t) => t.id === page)?.label ?? 'Review'} · Hugo 中文`;
  }, [page]);
  if (!ready) return null;
  let view: React.ReactNode;
  switch (page) {
    case 'review':
      view = <Review />;
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
    default:
      view = <Today />;
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
            <a key={t.id} href={`#/${t.id}`} aria-current={page === t.id || (page === 'report' && t.id === 'settings') ? 'page' : undefined} className={t.id === 'settings' ? 'nav-settings' : undefined}>
              <Icon name={t.icon} />
              <span>{t.label === 'Quick memory' ? 'Quick' : t.label}</span>
            </a>
          ))}
        </nav>
      )}
      {view}
      <Toaster />
    </div>
  );
}
