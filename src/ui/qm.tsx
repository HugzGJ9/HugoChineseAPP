// Hide/show pieces shared by Quick memory and Sheets: layers, presets, hold-to-reveal, the row list.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { Note } from '../lib/types';
import { pref, setPref } from '../lib/db';
import { speak } from '../lib/speech';
import { Meaning, Pinyin } from './common';
import { inDialog } from './panel';
import './qm.css';

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

/** Show/hide toggles for the three layers. `compact` uses short labels (Sheets toolbar). */
export function LayerBar({
  shown, lang, onToggle, noPinyin = false, compact = false,
}: {
  shown: Shown; lang: string; onToggle: (l: Layer) => void; noPinyin?: boolean; compact?: boolean;
  /** Unused, kept so older call sites still type-check. */
  preset?: string; onPreset?: (s: Shown, name: string) => void;
}) {
  const chip = (l: Layer, label: string, aria: string, key: string) => (
    <button type="button" className={`ql-chip ${shown[l] ? '' : 'off'}`} aria-pressed={shown[l]} aria-label={aria} onClick={() => onToggle(l)} title={`${aria} (key ${key})`}>
      {label}
    </button>
  );
  return (
    <div className={`ql-bar ${compact ? 'compact' : ''}`} role="group" aria-label="Show or hide">
      {chip('hz', compact ? '汉' : '汉字', 'Hanzi', '1')}
      {!noPinyin && chip('py', compact ? 'Py' : 'Pinyin', 'Pinyin', '2')}
      {chip('mn', lang.toUpperCase(), `Meaning (${lang.toUpperCase()})`, '3')}
    </div>
  );
}

/** Quiz presets (which layers start hidden) as a segmented control. */
export function PresetSeg({ preset, onPreset, label = 'Presets', id }: { preset: string; onPreset: (s: Shown, name: string) => void; label?: string; id?: string }) {
  return (
    <div className="seg ql-presets" role="group" aria-label={id ? undefined : label} aria-labelledby={id}>
      {PRESETS.map((p) => (
        <button key={p.name} type="button" aria-pressed={preset === p.name} onClick={() => onPreset(p.shown, p.name)}>
          {p.name}
        </button>
      ))}
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
  items, shown, listen, lead, trail, rowClass, onKey, onOpen, hidePinyin = false,
}: {
  items: T[]; shown: Shown; listen: boolean;
  lead?: (it: T) => ReactNode; trail?: (it: T) => ReactNode; rowClass?: (it: T) => string;
  onKey?: (e: KeyboardEvent, it: T) => boolean; hidePinyin?: boolean;
  /** Called when a shown hanzi is tapped (it is still spoken). */
  onOpen?: (it: T) => void;
}) {
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState(0);
  const shift = useShift();
  const cur = Math.min(focus, items.length - 1);
  useEffect(() => setPeek({}), [shown]);
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || inDialog(e)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const it = items[cur];
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus(Math.min(items.length - 1, cur + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus(Math.max(0, cur - 1));
      } else if (e.key === ' ' && it) {
        if ((e.target as HTMLElement)?.closest?.('[role="menu"]')) return;
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
    <div className="ql" role="list">
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
          onOpen={onOpen ? () => onOpen(it) : undefined}
        />
      ))}
    </div>
  );
}

function QmRow({
  id, note, pk, shown, listen, all, peek, focused, extra, lead, trail, noPinyin, onPeek, onAll, onFocus, onOpen,
}: {
  id: string; note: Note; pk: string; shown: Shown; listen: boolean; all: boolean; peek: Record<string, boolean>; focused: boolean;
  extra: string; lead?: ReactNode; trail?: ReactNode; noPinyin: boolean;
  onPeek: (k: Layer) => void; onAll: (on: boolean) => void; onFocus: () => void; onOpen?: () => void;
}) {
  const hold = useHold(onAll);
  const vis = (k: Layer) => all || shown[k] !== !!peek[pk + ':' + k];
  const tap = (k: Layer) => () => {
    if (hold.held.current) return;
    onFocus();
    if (k === 'hz' && vis('hz')) {
      speak(note.hanzi);
      onOpen?.();
    } else onPeek(k);
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
    <div id={id} role="listitem" className={`ql-row ${focused ? 'focus' : ''} ${extra}`} {...hold.props} onClick={() => listen && speak(note.hanzi)}>
      {lead != null && (
        <span className="ql-lead" {...own}>
          {lead}
        </span>
      )}
      <div className="ql-main">
        <div className="ql-top">
          <button type="button" className="ql-cell ql-hz" onClick={tap('hz')} aria-label={vis('hz') ? note.hanzi : 'Hidden hanzi, tap to show'}>
            {vis('hz') ? <span className="peek" lang="zh-CN">{note.hanzi}</span> : <span className="ql-hide" />}
          </button>
          {!noPinyin && (
            <button type="button" className="ql-cell ql-py" onClick={tap('py')} aria-label={vis('py') ? note.pinyin : 'Hidden pinyin, tap to show'}>
              {vis('py') ? <Pinyin text={note.pinyin} className="peek" /> : <span className="ql-hide" />}
            </button>
          )}
        </div>
        <button type="button" className="ql-cell ql-mn" onClick={tap('mn')} aria-label={vis('mn') ? 'Meaning' : 'Hidden meaning, tap to show'}>
          {vis('mn') ? <Meaning note={note} className="peek" /> : <span className="ql-hide" />}
        </button>
      </div>
      {trail != null && (
        <div className="ql-trail" {...own}>
          {trail}
        </div>
      )}
    </div>
  );
}
