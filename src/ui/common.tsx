import { useEffect, useState, type ReactNode } from 'react';
import type { Note } from '../lib/types';
import { toneClasses } from '../lib/pinyin';
import { meaning, setLang, useApp, type Lang } from '../lib/store';
import { speak } from '../lib/speech';

const paths: Record<string, ReactNode> = {
  sheets: <><path d="M4 5h16v14H4z" /><path d="M4 10h16M4 15h16M10 5v14" /></>,
  today: <path d="M4 5h16v15H4zM4 9h16M9 3v4M15 3v4" />,
  quick: <><path d="M3 12s3.5-6 9-6 9 6 9 6-3.5 6-9 6-9-6-9-6z" /><circle cx="12" cy="12" r="2.5" /></>,
  words: <><path d="M5 4h11l3 3v13H5z" /><path d="M9 10h6M9 14h6" /></>,
  grammar: <><path d="M4 6h7M4 12h10M4 18h6" /><path d="M16 15l3 3 3-6" /></>,
  stats: <path d="M5 20V11M10 20V5M15 20v-7M20 20V9" />,
  settings: <><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></>,
  sound: <><path d="M4 9h4l5-4v14l-5-4H4z" /><path d="M16.5 8.5a5 5 0 010 7M19 6a8.5 8.5 0 010 12" /></>,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  back: <path d="M15 5l-7 7 7 7" />,
  undo: <><path d="M9 14L4 9l5-5" /><path d="M4 9h10a6 6 0 010 12h-3" /></>,
  sync: <><path d="M20 11a8 8 0 00-14.3-4.9L4 8" /><path d="M4 4v4h4M4 13a8 8 0 0014.3 4.9L20 16" /><path d="M20 20v-4h-4" /></>,
  pen: <path d="M4 20l4-1 11-11-3-3L5 16zM14 6l3 3" />,
  shuffle: <><path d="M3 7h4l10 10h4M3 17h4l3-3M14 10l3-3h4" /><path d="M18 4l3 3-3 3M18 14l3 3-3 3" /></>,
  check: <path d="M5 12l5 5 9-10" />,
};

export function Icon({ name, title }: { name: keyof typeof paths | string; title?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden={title ? undefined : true} role={title ? 'img' : undefined}>
      {title && <title>{title}</title>}
      {paths[name]}
    </svg>
  );
}

export function Pinyin({ text, className = '' }: { text: string; className?: string }) {
  if (!text) return null;
  return (
    <span className={`pinyin ${className}`}>
      {toneClasses(text).map((p, i) => (
        <span key={i} className={p.tone ? `t${p.tone}` : undefined}>
          {p.text}
        </span>
      ))}
    </span>
  );
}

/** A word written in practice-grid squares, one per character. */
export function GridWord({ text, cell, onClick, label }: { text: string; cell?: number; onClick?: () => void; label?: string }) {
  const chars = [...text];
  const style = cell ? ({ '--cell': `${cell}px` } as React.CSSProperties) : undefined;
  const size = chars.length > 4 ? 'gw-s' : chars.length > 2 ? 'gw-m' : 'big';
  const auto = !cell ? (size === 'gw-s' ? 56 : size === 'gw-m' ? 84 : undefined) : undefined;
  const st = auto ? ({ '--cell': `${auto}px` } as React.CSSProperties) : style;
  const inner = chars.map((c, i) => (
    <span key={i} className="grid-cell" aria-hidden="true">
      {c}
    </span>
  ));
  return onClick ? (
    <button type="button" className={`grid-word ${size}`} style={{ ...st, border: 0, padding: 0, background: 'none' }} onClick={onClick} aria-label={label ?? `${text}, play audio`}>
      {inner}
    </button>
  ) : (
    <span className={`grid-word ${size}`} style={st} role="img" aria-label={label ?? text}>
      {inner}
    </span>
  );
}

export function Meaning({ note, lang, className = '' }: { note: Note; lang?: Lang; className?: string }) {
  const current = useApp((s) => s.lang);
  const m = meaning(note, lang ?? current);
  return (
    <span className={className}>
      {m.text}{' '}
      {m.source === 'auto' && <span className="tag auto" title="French from CFDICT (chine.in)">auto</span>}
      {m.source === 'en' && (lang ?? current) === 'fr' && <span className="tag" title="No French meaning yet">EN</span>}
    </span>
  );
}

export function LangSwitch() {
  const lang = useApp((s) => s.lang);
  return (
    <div className="seg" role="group" aria-label="Meaning language">
      {(['en', 'fr'] as Lang[]).map((l) => (
        <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function AudioButton({ text, label = 'Play audio' }: { text: string; label?: string }) {
  return (
    <button type="button" className="icon-btn" onClick={() => speak(text)} aria-label={label} title={`${label} (A)`}>
      <Icon name="sound" />
    </button>
  );
}

let toastSet: ((m: string | null) => void) | null = null;
export function toast(m: string) {
  toastSet?.(m);
}
export function Toaster() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    toastSet = setMsg;
    return () => {
      toastSet = null;
    };
  }, []);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 3200);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}

export function TopBar({ title, children, back }: { title: ReactNode; children?: ReactNode; back?: string }) {
  return (
    <header className="topbar">
      {back && (
        <a className="icon-btn" href={back} aria-label="Back">
          <Icon name="back" />
        </a>
      )}
      <h1>{title}</h1>
      {children}
    </header>
  );
}

export function StatusPill({ status }: { status: string }) {
  const label = status[0].toUpperCase() + status.slice(1);
  return <span className={`status s-${status}`}>{label}</span>;
}

export function formatAgo(t: number | undefined, now = Date.now()): string {
  if (!t) return 'never';
  const m = Math.round((now - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function formatDate(t: number): string {
  return new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: new Date(t).getFullYear() !== new Date().getFullYear() ? 'numeric' : undefined });
}

export function useNow(intervalMs = 60000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    const vis = () => document.visibilityState === 'visible' && setNow(Date.now());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, [intervalMs]);
  return now;
}
