import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Note } from '../lib/types';
import { toneClasses } from '../lib/pinyin';
import { meaning, setLang, useApp, type Lang } from '../lib/store';
import { speak } from '../lib/speech';

// SF-Symbols-like line icons: 24px grid, 1.6 stroke, round caps. `filled` variants exist for tab bar icons.
const GEAR =
  'M9.97 4.37L10.31 2.14h3.38l.34 2.23a7.9 7.9 0 011.93.8l1.81-1.34 2.4 2.4-1.34 1.81a7.9 7.9 0 01.8 1.93l2.23.34v3.38l-2.23.34a7.9 7.9 0 01-.8 1.93l1.34 1.81-2.4 2.4-1.81-1.34a7.9 7.9 0 01-1.93.8l-.34 2.23h-3.38l-.34-2.23a7.9 7.9 0 01-1.93-.8l-1.81 1.34-2.4-2.4 1.34-1.81a7.9 7.9 0 01-.8-1.93l-2.23-.34v-3.38l2.23-.34a7.9 7.9 0 01.8-1.93L3.83 6.23l2.4-2.4 1.81 1.34a7.9 7.9 0 011.93-.8z';
const EYE = 'M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z';

const paths: Record<string, ReactNode> = {
  sheets: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><path d="M3.5 9.5h17M3.5 14.5h17M9.5 9.5v10" /></>,
  today: <><rect x="3.5" y="5" width="17" height="15" rx="2.5" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
  quick: <><path d={EYE} /><circle cx="12" cy="12" r="3" /></>,
  words: <><path d="M5 4.5A1.5 1.5 0 016.5 3H19v15H6.5A1.5 1.5 0 005 19.5z" /><path d="M5 19.5A1.5 1.5 0 006.5 21H19v-3M9 7.5h6" /></>,
  grammar: <><path d="M4 6h8M4 12h10M4 18h6" /><path d="M15 16l2.5 2.5L21 13" /></>,
  stats: <path d="M5 20v-7M10 20V5M15 20v-9M20 20V9" />,
  settings: <><path d={GEAR} /><circle cx="12" cy="12" r="3" /></>,
  sound: <><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" /><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" /></>,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  back: <path d="M15 4.5L7.5 12l7.5 7.5" />,
  chevron: <path d="M9.5 6l6 6-6 6" />,
  'chevron-down': <path d="M6 9.5l6 6 6-6" />,
  updown: <path d="M8 9.5l4-4 4 4M8 14.5l4 4 4-4" />,
  undo: <><path d="M8.5 13.5L4 9l4.5-4.5" /><path d="M4 9h10.5a5.5 5.5 0 010 11H11" /></>,
  sync: <><path d="M19.5 11A7.5 7.5 0 006.2 6.7L4.5 8.5" /><path d="M4.5 4.5v4h4M4.5 13a7.5 7.5 0 0013.3 4.3l1.7-1.8" /><path d="M19.5 19.5v-4h-4" /></>,
  pen: <path d="M4.5 19.5l1-4L16 5a2.1 2.1 0 013 3L8.5 18.5zM14 7l3 3" />,
  shuffle: <><path d="M3 7h3.5c2 0 3.2 1 4.3 2.6l2.4 3.8c1 1.6 2.3 2.6 4.3 2.6H21" /><path d="M3 17h3.5c1.4 0 2.4-.5 3.2-1.3M14 8.3c.8-.8 1.8-1.3 3.2-1.3H21" /><path d="M18.5 4.5L21 7l-2.5 2.5M18.5 14.5L21 17l-2.5 2.5" /></>,
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  more: <><circle cx="6" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.4" fill="currentColor" stroke="none" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="M15.5 15.5l5 5" /></>,
  filter: <path d="M4 6h16M7 12h10M10 18h4" />,
  plus: <path d="M12 5v14M5 12h14" />,
  trash: <><path d="M4.5 6.5h15M9.5 6.5V4.5h5v2M6.5 6.5l1 13h9l1-13" /><path d="M10 10.5v6M14 10.5v6" /></>,
  upload: <><path d="M12 15V3.5M8 7.5l4-4 4 4" /><path d="M8 10.5H6.5a2 2 0 00-2 2v6a2 2 0 002 2h11a2 2 0 002-2v-6a2 2 0 00-2-2H16" /></>,
  download: <><path d="M12 3.5V15M8 11l4 4 4-4" /><path d="M4.5 15.5v3a2 2 0 002 2h11a2 2 0 002-2v-3" /></>,
  folder: <path d="M3.5 7.5a2 2 0 012-2h4l2 2h7a2 2 0 012 2v8a2 2 0 01-2 2h-13a2 2 0 01-2-2z" />,
  cloud: <path d="M7 18.5a4.5 4.5 0 01-.6-9A6 6 0 0118 8.6a5 5 0 01-.5 9.9z" />,
  key: <><circle cx="8" cy="15" r="4" /><path d="M11 12l8-8M16 7l2.5 2.5M14 9l2 2" /></>,
  globe: <><circle cx="12" cy="12" r="8.5" /><path d="M3.5 12h17M12 3.5c2.5 2.6 3.5 5.4 3.5 8.5s-1 5.9-3.5 8.5c-2.5-2.6-3.5-5.4-3.5-8.5s1-5.9 3.5-8.5z" /></>,
  info: <><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><circle cx="12" cy="7.8" r="0.6" fill="currentColor" /></>,
  sparkles: <><path d="M10 3.5l1.6 4.4L16 9.5l-4.4 1.6L10 15.5l-1.6-4.4L4 9.5l4.4-1.6z" /><path d="M17.5 13.5l.8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8z" /></>,
  book: <><path d="M12 6.5C10 5 7 4.5 3.5 5v13c3.5-.5 6.5 0 8.5 1.5 2-1.5 5-2 8.5-1.5V5C17 4.5 14 5 12 6.5z" /><path d="M12 6.5v13" /></>,
  clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7v5l3.5 2" /></>,
  lock: <><rect x="5" y="10.5" width="14" height="10" rx="2" /><path d="M8 10.5V8a4 4 0 018 0v2.5" /></>,
  doc: <><path d="M6.5 3.5h7l4.5 4.5v12.5h-11.5z" /><path d="M13.5 3.5V8H18M9.5 12.5h5M9.5 16h5" /></>,
  external: <><path d="M14 4.5h5.5V10M19.5 4.5L11 13" /><path d="M17 14v4a2 2 0 01-2 2H6a2 2 0 01-2-2V9a2 2 0 012-2h4" /></>,
  list: <><path d="M9 6.5h11M9 12h11M9 17.5h11" /><circle cx="4.75" cy="6.5" r="0.9" fill="currentColor" /><circle cx="4.75" cy="12" r="0.9" fill="currentColor" /><circle cx="4.75" cy="17.5" r="0.9" fill="currentColor" /></>,
  'check-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M8 12.3l2.8 2.8L16.2 9.5" /></>,
  'x-circle': <><circle cx="12" cy="12" r="8.5" /><path d="M9 9l6 6M15 9l-6 6" /></>,
  bolt: <path d="M13 3L5.5 13.5H11L10 21l8-11h-5.5z" />,
  device: <><rect x="6.5" y="2.5" width="11" height="19" rx="2.5" /><path d="M10.5 18.5h3" /></>,
  wifi: <><path d="M3 9.5a13 13 0 0118 0M6 12.8a8.5 8.5 0 0112 0M9 16a4 4 0 016 0" /><circle cx="12" cy="19" r="0.8" fill="currentColor" /></>,
};

// Filled (selected) variants for the tab bar: real holes (even-odd), so they work on any background.
const RING = 'M15.2 12a3.2 3.2 0 11-6.4 0 3.2 3.2 0 016.4 0z';
const SHEET_FILLED =
  'M6 4.5h12a2.5 2.5 0 012.5 2.5v10a2.5 2.5 0 01-2.5 2.5H6A2.5 2.5 0 013.5 17V7A2.5 2.5 0 016 4.5z' +
  'M5 10.3h3.8v3.5H5zM10.2 10.3H19v3.5h-8.8zM5 15.2h3.8v2.9H5zM10.2 15.2H19v2.9h-8.8z';
const filledPaths: Record<string, ReactNode> = {
  sheets: <path d={SHEET_FILLED} fill="currentColor" fillRule="evenodd" stroke="none" />,
  quick: <path d={EYE + RING} fill="currentColor" fillRule="evenodd" strokeWidth="1" />,
  settings: <path d={GEAR + RING} fill="currentColor" fillRule="evenodd" strokeWidth="1" />,
};

export type IconName = keyof typeof paths;

export function Icon({ name, title, filled = false, className }: { name: IconName | string; title?: string; filled?: boolean; className?: string }) {
  const body = (filled && filledPaths[name]) || paths[name];
  return (
    <svg
      viewBox="0 0 24 24"
      className={className ? `icon ${className}` : 'icon'}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title && <title>{title}</title>}
      {body}
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
    <Segmented
      label="Meaning language"
      value={lang}
      onChange={setLang}
      options={[
        { value: 'en', label: 'EN' },
        { value: 'fr', label: 'FR' },
      ]}
    />
  );
}

/** iOS segmented control. Buttons keep aria-pressed so screens and tests that read it still work. */
export function Segmented<T extends string>({
  options,
  value,
  onChange,
  label,
  className = '',
}: {
  options: { value: T; label: ReactNode; title?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  className?: string;
}) {
  return (
    <div className={`seg ${className}`} role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" aria-pressed={value === o.value} title={o.title} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** iOS switch: a checkbox with role="switch". Put it inside a <label> (see SwitchRow) or give it a label. */
export function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label?: string; disabled?: boolean }) {
  return <input type="checkbox" role="switch" className="switch" checked={checked} disabled={disabled} aria-label={label} onChange={(e) => onChange(e.target.checked)} />;
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
    const t = setTimeout(() => setMsg(null), 2400);
    return () => clearTimeout(t);
  }, [msg]);
  return msg ? (
    <div className="toast" role="status">
      {msg}
    </div>
  ) : null;
}

const BACK_LABEL: Record<string, string> = { '#/settings': 'Settings', '#/today': 'Today', '#/sheets': 'Sheets', '#/quick': 'Quick', '#/words': 'Words' };

/**
 * iOS navigation bar with a large title. The large title scrolls with the page; once it passes under the bar,
 * the bar turns translucent and shows the inline title. `children` are trailing actions (keep them compact).
 */
export function TopBar({ title, children, back, backLabel }: { title: ReactNode; children?: ReactNode; back?: string; backLabel?: string }) {
  const bar = useRef<HTMLDivElement>(null);
  const big = useRef<HTMLHeadingElement>(null);
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      const b = bar.current?.getBoundingClientRect();
      const t = big.current?.getBoundingClientRect();
      if (b && t) setScrolled(t.bottom - 8 <= b.bottom);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
  }, []);
  const bare = !back && !children;
  const label = backLabel ?? (back ? BACK_LABEL[back] : undefined) ?? 'Back';
  return (
    <header className={`topbar lt${bare ? ' bare' : ''}`}>
      <div ref={bar} className={`navbar${scrolled ? ' on' : ''}`}>
        <div className="nb-lead">
          {back && (
            <a className="nb-back" href={back} aria-label={label === 'Back' ? 'Back' : `Back to ${label}`}>
              <Icon name="back" />
              <span>{label}</span>
            </a>
          )}
        </div>
        <div className="nb-title" aria-hidden="true">
          {title}
        </div>
        <div className="nb-trail">{children}</div>
      </div>
      <h1 ref={big} className="large-title">
        {title}
      </h1>
    </header>
  );
}

/** Inset grouped section: small header above, rounded card, optional footer below. */
export function Section({ title, footer, children, id, className = '' }: { title?: ReactNode; footer?: ReactNode; children: ReactNode; id?: string; className?: string }) {
  const hid = id ? `${id}-h` : undefined;
  return (
    <section className={`group ${className}`} id={id} aria-labelledby={title && hid ? hid : undefined}>
      {title && (
        <h2 className="group-h" id={hid}>
          {title}
        </h2>
      )}
      <div className="group-card">{children}</div>
      {footer && <div className="group-f">{footer}</div>}
    </section>
  );
}

type RowProps = {
  label: ReactNode;
  /** Second line under the label, smaller and grey. */
  detail?: ReactNode;
  /** Grey value on the trailing side (iOS "value1" style). */
  value?: ReactNode;
  /** Leading icon in a coloured rounded square (Settings style). */
  icon?: string;
  iconBg?: string;
  /** Leading icon tinted, no badge. */
  glyph?: string;
  trailing?: ReactNode;
  href?: string;
  external?: boolean;
  onClick?: () => void;
  disabled?: boolean;
  chevron?: boolean;
  tone?: 'action' | 'destructive';
  center?: boolean;
  className?: string;
};

/** One row of an inset list: a link, a button, or static content. */
export function Row({ label, detail, value, icon, iconBg, glyph, trailing, href, external, onClick, disabled, chevron, tone, center, className = '' }: RowProps) {
  const tap = !!(href || onClick);
  const cls = ['cell', tap && 'tap', (icon || glyph) && 'has-icon', tone, center && 'center', className].filter(Boolean).join(' ');
  const inner = (
    <>
      {icon && (
        <span className="cell-badge" style={{ background: iconBg ?? 'var(--gray)' }} aria-hidden="true">
          <Icon name={icon} />
        </span>
      )}
      {glyph && <Icon name={glyph} className="cell-glyph" />}
      <span className="cell-body">
        <span className="cell-label">{label}</span>
        {detail && <span className="cell-detail">{detail}</span>}
      </span>
      {value != null && <span className="cell-value">{value}</span>}
      {trailing}
      {(chevron ?? (!!href && !external)) && <Icon name="chevron" className="cell-chev" />}
      {external && <Icon name="external" className="cell-chev" />}
    </>
  );
  if (href)
    return (
      <a className={cls} href={href} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
        {inner}
      </a>
    );
  if (onClick)
    return (
      <button type="button" className={cls} onClick={onClick} disabled={disabled}>
        {inner}
      </button>
    );
  return <div className={cls}>{inner}</div>;
}

/** A row with a trailing iOS switch; the whole row toggles it. */
export function SwitchRow({ label, detail, checked, onChange, disabled }: { label: ReactNode; detail?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label className="cell">
      <span className="cell-body">
        <span className="cell-label">{label}</span>
        {detail && <span className="cell-detail">{detail}</span>}
      </span>
      <Switch checked={checked} onChange={onChange} disabled={disabled} />
    </label>
  );
}

/** Free content inside a group card (forms, notices, button rows), with the row padding and separators. */
export function Cell({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`cell cell-pad ${className}`}>{children}</div>;
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
