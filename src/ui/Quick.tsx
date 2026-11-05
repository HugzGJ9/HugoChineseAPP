// Quick memory: hide or show hanzi, pinyin or meaning for every word, in list or card mode.
// Free practice: it never changes review schedules unless you send missed words back.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../lib/types';
import { meaning, recordReview, setLang, useApp } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { speak } from '../lib/speech';
import { cardId, DAY, noteStatus } from '../lib/engine/schedule';
import { groupCards } from '../lib/stats';
import { fnv1a } from '../lib/import/build';
import { Meaning, Pinyin, toast, TopBar } from './common';

type Layer = 'hz' | 'py' | 'mn';
type Shown = Record<Layer, boolean>;
const PRESETS: { name: string; shown: Shown; listen?: boolean }[] = [
  { name: 'Read', shown: { hz: true, py: false, mn: false } },
  { name: 'Recall', shown: { hz: false, py: false, mn: true } },
  { name: 'Tones', shown: { hz: true, py: false, mn: true } },
  { name: 'Listen', shown: { hz: false, py: false, mn: false }, listen: true },
];
type Filter = 'all' | 'studied' | 'new' | 'week' | 'missed';

export function Quick() {
  const { notes, cards, events, lang } = useApp((s) => s);
  const [shown, setShownState] = useState<Shown>(() => pref<Shown>('qm.shown', { hz: true, py: true, mn: false }));
  const [preset, setPreset] = useState<string>(() => pref('qm.preset', ''));
  const [mode, setMode] = useState<'list' | 'card'>(() => pref('qm.mode', 'list'));
  const [tag, setTag] = useState<string>(() => pref('qm.tag', 'all'));
  const [filter, setFilter] = useState<Filter>(() => pref('qm.filter', 'all'));
  const [seed, setSeed] = useState<string>('');
  const [limit, setLimit] = useState(100);
  const listen = PRESETS.find((p) => p.name === preset)?.listen ?? false;

  const setShown = (s: Shown, p = '') => {
    setShownState(s);
    setPreset(p);
    setPref('qm.shown', s);
    setPref('qm.preset', p);
  };
  const toggle = (l: Layer) => setShown({ ...shown, [l]: !shown[l] });

  const tags = useMemo(() => [...new Set(notes.filter((n) => n.kind === 'vocab').flatMap((n) => n.tags))], [notes]);
  const list = useMemo(() => {
    const now = Date.now();
    const byNote = groupCards(cards.values());
    const recent = new Map<string, { last: number; missed: boolean }>();
    for (const e of events) {
      const n = e.card.slice(0, e.card.lastIndexOf('#'));
      const r = recent.get(n) ?? { last: 0, missed: false };
      if (e.t > now - 7 * DAY) r.last = Math.max(r.last, e.t);
      if (e.t > now - 14 * DAY && e.r === 1) r.missed = true;
      recent.set(n, r);
    }
    let out = notes.filter((n) => n.kind === 'vocab' || n.kind === 'synonym' || n.kind === 'measure');
    if (tag !== 'all') out = out.filter((n) => n.tags.includes(tag));
    if (filter === 'studied') out = out.filter((n) => n.studied || noteStatus(byNote.get(n.id) ?? [], now) !== 'new');
    if (filter === 'new') out = out.filter((n) => !n.studied && noteStatus(byNote.get(n.id) ?? [], now) === 'new');
    if (filter === 'week') out = out.filter((n) => (recent.get(n.id)?.last ?? 0) > 0);
    if (filter === 'missed') out = out.filter((n) => recent.get(n.id)?.missed);
    if (seed) out = [...out].sort((a, b) => (fnv1a(seed + a.id) < fnv1a(seed + b.id) ? -1 : 1));
    return out;
  }, [notes, cards, events, tag, filter, seed]);

  // Keys: 1 2 3 layers, L language, Tab list/card.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === '1') toggle('hz');
      else if (e.key === '2') toggle('py');
      else if (e.key === '3') toggle('mn');
      else if (e.key === 'l' || e.key === 'L') setLang(lang === 'en' ? 'fr' : 'en');
      else if (e.key === 'Tab' && !e.shiftKey && document.activeElement === document.body) {
        e.preventDefault();
        switchMode(mode === 'list' ? 'card' : 'list');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const switchMode = (m: 'list' | 'card') => {
    setMode(m);
    setPref('qm.mode', m);
  };

  return (
    <div className="main">
      <TopBar title="Quick memory">
        <div className="seg" role="group" aria-label="Meaning language">
          {(['en', 'fr'] as const).map((l) => (
            <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)}>
              {l.toUpperCase()}
            </button>
          ))}
        </div>
      </TopBar>
      <div className="stack">
        <div className="qm-bar" role="group" aria-label="Show or hide">
          <button type="button" className={`chip ${shown.hz ? '' : 'off'}`} aria-pressed={shown.hz} onClick={() => toggle('hz')} title="Key 1">
            汉字
          </button>
          <button type="button" className={`chip ${shown.py ? '' : 'off'}`} aria-pressed={shown.py} onClick={() => toggle('py')} title="Key 2">
            Pinyin
          </button>
          <button type="button" className={`chip ${shown.mn ? '' : 'off'}`} aria-pressed={shown.mn} onClick={() => toggle('mn')} title="Key 3">
            {lang.toUpperCase()}
          </button>
          <span className="grow" />
          <div className="seg" role="group" aria-label="Presets">
            {PRESETS.map((p) => (
              <button key={p.name} type="button" aria-pressed={preset === p.name} onClick={() => setShown(p.shown, p.name)}>
                {p.name}
              </button>
            ))}
          </div>
        </div>
        <div className="row wrap">
          <select value={tag} onChange={(e) => (setTag(e.target.value), setPref('qm.tag', e.target.value))} aria-label="Sheet" style={{ width: 'auto' }}>
            <option value="all">All words</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={filter} onChange={(e) => (setFilter(e.target.value as Filter), setPref('qm.filter', e.target.value))} aria-label="Filter" style={{ width: 'auto' }}>
            <option value="all">Any status</option>
            <option value="studied">Studied</option>
            <option value="new">New</option>
            <option value="week">Seen this week</option>
            <option value="missed">Missed recently</option>
          </select>
          <button type="button" className="btn small" onClick={() => setSeed(seed ? '' : String(Date.now()))} aria-pressed={!!seed}>
            {seed ? 'Sheet order' : 'Shuffle'}
          </button>
          <span className="small muted">{list.length} words</span>
        </div>
        {mode === 'list' ? (
          <QmList notes={list.slice(0, limit)} shown={shown} listen={listen} />
        ) : (
          <QmCards key={seed + tag + filter} notes={list} shown={shown} listen={listen} />
        )}
        {mode === 'list' && list.length > limit && (
          <button type="button" className="btn" onClick={() => setLimit(limit + 200)}>
            Show more
          </button>
        )}
        <div className="dock" style={{ display: 'flex', justifyContent: 'center' }}>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'list'} onClick={() => switchMode('list')}>
              List
            </button>
            <button type="button" aria-pressed={mode === 'card'} onClick={() => switchMode('card')}>
              Cards
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function useHold(onHold: (on: boolean) => void) {
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

function useShift(): boolean {
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

function QmList({ notes, shown, listen }: { notes: Note[]; shown: Shown; listen: boolean }) {
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [focus, setFocus] = useState(0);
  const shift = useShift();
  useEffect(() => setPeek({}), [shown]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setFocus((f) => Math.min(notes.length - 1, f + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setFocus((f) => Math.max(0, f - 1));
      } else if (e.key === ' ' && notes[focus]) {
        e.preventDefault();
        const id = notes[focus].id;
        setPeek((p) => ({ ...p, [id + ':all']: !p[id + ':all'] }));
      } else if ((e.key === 'a' || e.key === 'A') && notes[focus]) speak(notes[focus].hanzi);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [notes, focus]);
  useEffect(() => {
    document.getElementById(`qm-${focus}`)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);
  return (
    <div className="qm-list" role="list">
      {notes.map((n, i) => (
        <QmRow
          key={n.id}
          id={`qm-${i}`}
          note={n}
          shown={shown}
          listen={listen}
          all={shift || !!peek[n.id + ':all']}
          peek={peek}
          focused={i === focus}
          onPeek={(k) => setPeek((p) => ({ ...p, [n.id + ':' + k]: !p[n.id + ':' + k] }))}
          onAll={(on) => setPeek((p) => ({ ...p, [n.id + ':all']: on }))}
          onFocus={() => setFocus(i)}
        />
      ))}
    </div>
  );
}

function QmRow({
  id, note, shown, listen, all, peek, focused, onPeek, onAll, onFocus,
}: {
  id: string; note: Note; shown: Shown; listen: boolean; all: boolean; peek: Record<string, boolean>; focused: boolean;
  onPeek: (k: Layer) => void; onAll: (on: boolean) => void; onFocus: () => void;
}) {
  const hold = useHold(onAll);
  const vis = (k: Layer) => all || shown[k] !== !!peek[note.id + ':' + k];
  const tap = (k: Layer) => () => {
    if (hold.held.current) return;
    onFocus();
    if (k === 'hz' && vis('hz')) speak(note.hanzi);
    else onPeek(k);
  };
  return (
    <div id={id} role="listitem" className={`qm-row ${focused ? 'focus' : ''}`} {...hold.props} onClick={() => listen && speak(note.hanzi)}>
      <button type="button" className="qm-cell hz" onClick={tap('hz')} aria-label={vis('hz') ? note.hanzi : 'Hidden hanzi, tap to show'}>
        {vis('hz') ? <span className="peek">{note.hanzi}</span> : <span className="bar w-hz" />}
      </button>
      <button type="button" className="qm-cell" onClick={tap('py')} aria-label={vis('py') ? note.pinyin : 'Hidden pinyin, tap to show'}>
        {vis('py') ? <Pinyin text={note.pinyin} className="peek" /> : <span className="bar w-py" />}
      </button>
      <button type="button" className="qm-cell mn" onClick={tap('mn')} aria-label={vis('mn') ? 'Meaning' : 'Hidden meaning, tap to show'}>
        {vis('mn') ? <Meaning note={note} className="peek" /> : <span className="bar w-mn" />}
      </button>
    </div>
  );
}

function QmCards({ notes, shown, listen }: { notes: Note[]; shown: Shown; listen: boolean }) {
  const [order, setOrder] = useState<Note[]>(notes);
  const [i, setI] = useState(0);
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [missed, setMissed] = useState<Note[]>([]);
  const [knew, setKnew] = useState(0);
  const [round, setRound] = useState(1);
  const [sent, setSent] = useState(false);
  const shift = useShift();
  const lang = useApp((s) => s.lang);
  const n = order[i];
  const start = useRef<{ x: number; y: number } | null>(null);
  const [dx, setDx] = useState(0);

  useEffect(() => setPeek({}), [i, shown]);
  useEffect(() => {
    if (n && listen) speak(n.hanzi);
  }, [n, listen]);

  const answer = (ok: boolean) => {
    if (!n) return;
    if (ok) setKnew((k) => k + 1);
    else setMissed((m) => (m.includes(n) ? m : [...m, n]));
    setI(i + 1);
    setDx(0);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      if (e.key === 'ArrowRight') answer(true);
      else if (e.key === 'ArrowLeft') answer(false);
      else if (e.key === ' ') {
        e.preventDefault();
        setPeek((p) => ({ ...p, all: !p.all }));
      } else if ((e.key === 'a' || e.key === 'A') && n) speak(n.hanzi);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (!order.length) return <p className="muted">No words match these filters.</p>;

  if (!n) {
    const sendBack = async () => {
      for (const w of missed) await recordReview(cardId(w.id, 'recog'), 1, 'quick', 0);
      setSent(true);
      toast(`${missed.length} word${missed.length > 1 ? 's' : ''} back in reviews`);
    };
    return (
      <div className="panel stack center">
        <h2>Round {round} done</h2>
        <p className="muted">
          Knew {knew}, missed {missed.length}.
        </p>
        <div className="row wrap" style={{ justifyContent: 'center' }}>
          {missed.length > 0 && (
            <button
              type="button"
              className="btn primary"
              onClick={() => {
                setOrder(missed);
                setMissed([]);
                setKnew(0);
                setI(0);
                setRound(round + 1);
                setSent(false);
              }}
            >
              Retry the {missed.length} missed
            </button>
          )}
          {missed.length > 0 && !sent && (
            <button type="button" className="btn" onClick={sendBack}>
              Send missed to reviews
            </button>
          )}
          <button
            type="button"
            className="btn"
            onClick={() => {
              setOrder(notes);
              setMissed([]);
              setKnew(0);
              setI(0);
              setRound(1);
            }}
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  const vis = (k: Layer) => shift || !!peek.all || shown[k] !== !!peek[k];
  const flip = (k: Layer) => setPeek((p) => ({ ...p, [k]: !p[k] }));
  return (
    <div className="stack">
      <div className="small muted center">
        {i + 1} / {order.length}
        {round > 1 ? ` · retry round ${round}` : ''}
      </div>
      <div
        className="panel qm-card"
        style={{ transform: `translateX(${dx}px) rotate(${dx / 40}deg)`, transition: start.current ? 'none' : 'transform 0.15s' }}
        onPointerDown={(e) => (start.current = { x: e.clientX, y: e.clientY })}
        onPointerMove={(e) => start.current && setDx(e.clientX - start.current.x)}
        onPointerUp={() => {
          start.current = null;
          if (dx > 90) answer(true);
          else if (dx < -90) answer(false);
          else setDx(0);
        }}
        onPointerCancel={() => ((start.current = null), setDx(0))}
      >
        <button type="button" className="qm-cell hz" style={{ fontFamily: 'var(--kai)', fontSize: '4.5rem' }} onClick={() => (vis('hz') ? speak(n.hanzi) : flip('hz'))}>
          {vis('hz') ? n.hanzi : <span className="bar" style={{ width: 120, height: 64 }} />}
        </button>
        <button type="button" className="qm-cell" style={{ fontSize: '1.4rem' }} onClick={() => flip('py')}>
          {vis('py') ? <Pinyin text={n.pinyin} /> : <span className="bar w-py" />}
        </button>
        <button type="button" className="qm-cell" style={{ fontSize: '1.1rem', textAlign: 'center' }} onClick={() => flip('mn')} lang={lang}>
          {vis('mn') ? meaning(n, lang).text : <span className="bar w-mn" />}
        </button>
      </div>
      <div className="grades" style={{ gridTemplateColumns: '1fr 1fr' }}>
        <button type="button" className="g1" onClick={() => answer(false)}>
          Missed <small>← or swipe left</small>
        </button>
        <button type="button" className="g3" onClick={() => answer(true)}>
          Knew it <small>→ or swipe right</small>
        </button>
      </div>
    </div>
  );
}
