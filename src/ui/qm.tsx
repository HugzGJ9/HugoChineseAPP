// Hide/show pieces shared by Quick memory and Sheets: layers, presets, hold-to-reveal, the row list.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Note } from '../lib/types';
import { pref, setPref } from '../lib/db';
import { speak } from '../lib/speech';
import { Meaning, Pinyin } from './common';

export type Layer = 'hz' | 'py' | 'mn';
export type Shown = Record<Layer, boolean>;
export const PRESETS: { name: string; shown: Shown; listen?: boolean }[] = [
  { name: 'Read', shown: { hz: true, py: false, mn: false } },
  { name: 'Recall', shown: { hz: false, py: false, mn: true } },
  { name: 'Tones', shown: { hz: true, py: false, mn: true } },
  { name: 'Listen', shown: { hz: false, py: false, mn: false }, listen: true },
];

/** Shown layers and preset, kept as device prefs under `<prefix>.shown` and `<prefix>.preset`. */
export function useQmShown(prefix: string, def: Shown = { hz: true, py: true, mn: false }) {
  const [shown, setShownState] = useState<Shown>(() => pref<Shown>(`${prefix}.shown`, def));
  const [preset, setPreset] = useState<string>(() => pref(`${prefix}.preset`, ''));
  const setShown = (s: Shown, p = '') => {
    setShownState(s);
    setPreset(p);
    setPref(`${prefix}.shown`, s);
    setPref(`${prefix}.preset`, p);
  };
  const toggle = (l: Layer) => setShown({ ...shown, [l]: !shown[l] });
  const listen = PRESETS.find((p) => p.name === preset)?.listen ?? false;
  return { shown, preset, listen, setShown, toggle };
}

export function LayerBar({
  shown, preset, lang, onToggle, onPreset, noPinyin = false, compact = false,
}: {
  shown: Shown; preset: string; lang: string; onToggle: (l: Layer) => void; onPreset: (s: Shown, name: string) => void; noPinyin?: boolean;
  /** Short chips only; the presets live elsewhere (Sheets "more" menu). */
  compact?: boolean;
}) {
  return (
    <div className={`qm-bar ${compact ? 'compact' : ''}`} role="group" aria-label="Show or hide">
      <button type="button" className={`chip ${shown.hz ? '' : 'off'}`} aria-pressed={shown.hz} aria-label="Hanzi" onClick={() => onToggle('hz')} title="Key 1">
        {compact ? '汉' : '汉字'}
      </button>
      {!noPinyin && (
        <button type="button" className={`chip ${shown.py ? '' : 'off'}`} aria-pressed={shown.py} aria-label="Pinyin" onClick={() => onToggle('py')} title="Key 2">
          {compact ? 'Py' : 'Pinyin'}
        </button>
      )}
      <button type="button" className={`chip ${shown.mn ? '' : 'off'}`} aria-pressed={shown.mn} aria-label={`Meaning (${lang.toUpperCase()})`} onClick={() => onToggle('mn')} title="Key 3">
        {lang.toUpperCase()}
      </button>
      {!compact && <span className="grow" />}
      {!compact && <div className="seg" role="group" aria-label="Presets">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" aria-pressed={preset === p.name} onClick={() => onPreset(p.shown, p.name)}>
            {p.name}
          </button>
        ))}
      </div>}
    </div>
  );
}

export function useHold(onHold: (on: boolean) => void) {
  const timer = useRef<number | null>(null);
  const held = useRef(false);
  return {
    held,
    props: {
      onPointerDown: () => {
        held.current = false;
        timer.current = window.setTimeout(() => {
          held.current = true;
          onHold(true);
        }, 380);
      },
      onPointerUp: () => {
        if (timer.current) clearTimeout(timer.current);
        if (held.current) onHold(false);
      },
      onPointerLeave: () => {
        if (timer.current) clearTimeout(timer.current);
        if (held.current) onHold(false);
      },
      onContextMenu: (e: React.MouseEvent) => e.preventDefault(),
    },
  };
}

export function useShift(): boolean {
  const [shift, setShift] = useState(false);
  useEffect(() => {
    const d = (e: KeyboardEvent) => e.key === 'Shift' && setShift(true);
    const u = (e: KeyboardEvent) => e.key === 'Shift' && setShift(false);
    window.addEventListener('keydown', d);
    window.addEventListener('keyup', u);
    return () => {
      window.removeEventListener('keydown', d);
      window.removeEventListener('keyup', u);
    };
  }, []);
  return shift;
}

type Item = { key: string; note: Note };

export function QmList<T extends Item>({
  items, shown, listen, lead, trail, rowClass, onKey, hidePinyin = false,
}: {
  items: T[]; shown: Shown; listen: boolean;
  lead?: (it: T) => ReactNode; trail?: (it: T) => ReactNode; rowClass?: (it: T) => string;
  onKey?: (e: KeyboardEvent, it: T) => boolean; hidePinyin?: boolean;
}) {
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState(0);
  const shift = useShift();
  const cur = Math.min(focus, items.length - 1);
  useEffect(() => setPeek({}), [shown]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const it = items[cur];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus(Math.min(items.length - 1, cur + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus(Math.max(0, cur - 1));
      } else if (e.key === ' ' && it) {
        if ((e.target as HTMLElement)?.closest?.('[role="dialog"], [role="menu"]')) return;
        e.preventDefault();
        setPeek((p) => ({ ...p, [it.key + ':all']: !p[it.key + ':all'] }));
      } else if ((e.key === 'a' || e.key === 'A') && it) speak(it.note.hanzi);
      else if (it && onKey?.(e, it)) e.preventDefault();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [items, cur, onKey]);
  useEffect(() => {
    document.getElementById(`qm-${cur}`)?.scrollIntoView({ block: 'nearest' });
  }, [cur]);
  return (
    <div className="qm-list" role="list">
      {items.map((it, i) => (
        <QmRow
          key={it.key}
          id={`qm-${i}`}
          note={it.note}
          pk={it.key}
          shown={shown}
          listen={listen}
          all={shift || !!peek[it.key + ':all']}
          peek={peek}
          focused={i === cur}
          extra={`${lead || trail ? 'x' : ''} ${hidePinyin ? 'nopy' : ''} ${rowClass?.(it) ?? ''}`}
          lead={lead?.(it)}
          trail={trail?.(it)}
          noPinyin={hidePinyin}
          onPeek={(k) => setPeek((p) => ({ ...p, [it.key + ':' + k]: !p[it.key + ':' + k] }))}
          onAll={(on) => setPeek((p) => ({ ...p, [it.key + ':all']: on }))}
          onFocus={() => setFocus(i)}
        />
      ))}
    </div>
  );
}

function QmRow({
  id, note, pk, shown, listen, all, peek, focused, extra, lead, trail, noPinyin, onPeek, onAll, onFocus,
}: {
  id: string; note: Note; pk: string; shown: Shown; listen: boolean; all: boolean; peek: Record<string, boolean>; focused: boolean;
  extra: string; lead?: ReactNode; trail?: ReactNode; noPinyin: boolean;
  onPeek: (k: Layer) => void; onAll: (on: boolean) => void; onFocus: () => void;
}) {
  const hold = useHold(onAll);
  const vis = (k: Layer) => all || shown[k] !== !!peek[pk + ':' + k];
  const tap = (k: Layer) => () => {
    if (hold.held.current) return;
    onFocus();
    if (k === 'hz' && vis('hz')) speak(note.hanzi);
    else onPeek(k);
  };
  // Buttons and menus in the lead and trail slots must not peek, hold or speak.
  const own = {
    onPointerDown: (e: React.PointerEvent) => {
      e.stopPropagation();
      onFocus();
    },
    onPointerUp: (e: React.PointerEvent) => e.stopPropagation(),
    onClick: (e: React.MouseEvent) => e.stopPropagation(),
  };
  return (
    <div id={id} role="listitem" className={`qm-row ${focused ? 'focus' : ''} ${extra}`} {...hold.props} onClick={() => listen && speak(note.hanzi)}>
      {lead != null && (
        <span className="qm-lead" {...own}>
          {lead}
        </span>
      )}
      <button type="button" className="qm-cell hz" onClick={tap('hz')} aria-label={vis('hz') ? note.hanzi : 'Hidden hanzi, tap to show'}>
        {vis('hz') ? <span className="peek">{note.hanzi}</span> : <span className="bar w-hz" />}
      </button>
      {!noPinyin && (
        <button type="button" className="qm-cell py" onClick={tap('py')} aria-label={vis('py') ? note.pinyin : 'Hidden pinyin, tap to show'}>
          {vis('py') ? <Pinyin text={note.pinyin} className="peek" /> : <span className="bar w-py" />}
        </button>
      )}
      <button type="button" className="qm-cell mn" onClick={tap('mn')} aria-label={vis('mn') ? 'Meaning' : 'Hidden meaning, tap to show'}>
        {vis('mn') ? <Meaning note={note} className="peek" /> : <span className="bar w-mn" />}
      </button>
      {trail != null && (
        <div className="qm-trail" {...own}>
          {trail}
        </div>
      )}
    </div>
  );
}
