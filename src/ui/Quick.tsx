// Quick memory: hide or show hanzi, pinyin or meaning for every word, in list or card mode.
// Free practice: it never changes review schedules unless you send missed words back.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note, WordStatus } from '../lib/types';
import { meaning, recordReview, setLang, useApp } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { speak } from '../lib/speech';
import { cardId, DAY } from '../lib/engine/schedule';
import { noteStatuses, sheetRows, STATUS_LABEL, WORD_STATUSES } from '../lib/status';
import { fnv1a } from '../lib/import/build';
import { LangSwitch, Pinyin, toast, TopBar } from './common';
import { LayerBar, QmList, useQmShown, useShift, type Layer, type Shown } from './qm';

type Filter = 'all' | `st:${WordStatus}` | 'week' | 'missed';
const FILTERS: Filter[] = ['all', ...WORD_STATUSES.map((s) => `st:${s}` as const), 'week', 'missed'];
// Older versions stored 'studied' and 'new': they read as "any".
const readFilter = (v: string): Filter => (FILTERS.includes(v as Filter) ? (v as Filter) : 'all');

export function Quick() {
  const { notes, events, lang, marks, meta } = useApp((s) => s);
  const { shown, preset, listen, setShown, toggle } = useQmShown('qm');
  const [mode, setMode] = useState<'list' | 'card'>(() => pref('qm.mode', 'list'));
  const [tag, setTag] = useState<string>(() => pref('qm.tag', 'all'));
  const [filter, setFilter] = useState<Filter>(() => readFilter(pref('qm.filter', 'all')));
  const [seed, setSeed] = useState<string>('');
  const [limit, setLimit] = useState(100);

  const tags = useMemo(() => [...new Set(notes.filter((n) => n.kind === 'vocab').flatMap((n) => n.tags))], [notes]);
  const list = useMemo(() => {
    const now = Date.now();
    const statuses = noteStatuses(sheetRows(notes, marks, meta?.colourSince));
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
    if (filter.startsWith('st:')) out = out.filter((n) => (statuses.get(n.id) ?? 'new') === filter.slice(3));
    if (filter === 'week') out = out.filter((n) => (recent.get(n.id)?.last ?? 0) > 0);
    if (filter === 'missed') out = out.filter((n) => recent.get(n.id)?.missed);
    if (seed) out = [...out].sort((a, b) => (fnv1a(seed + a.id) < fnv1a(seed + b.id) ? -1 : 1));
    return out;
  }, [notes, marks, meta, events, tag, filter, seed]);

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
        <LangSwitch />
      </TopBar>
      <div className="stack">
        <LayerBar shown={shown} preset={preset} lang={lang} onToggle={toggle} onPreset={setShown} />
        <div className="row wrap">
          <select value={tag} onChange={(e) => (setTag(e.target.value), setPref('qm.tag', e.target.value))} aria-label="Sheet" style={{ width: 'auto' }}>
            <option value="all">All words</option>
            {tags.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
          <select value={filter} onChange={(e) => (setFilter(readFilter(e.target.value)), setPref('qm.filter', e.target.value))} aria-label="Filter" style={{ width: 'auto' }}>
            <option value="all">Any status</option>
            {WORD_STATUSES.map((st) => (
              <option key={st} value={`st:${st}`}>
                {STATUS_LABEL[st]}
              </option>
            ))}
            <option value="week">Seen this week</option>
            <option value="missed">Missed recently</option>
          </select>
          <button type="button" className="btn small" onClick={() => setSeed(seed ? '' : String(Date.now()))} aria-pressed={!!seed}>
            {seed ? 'Sheet order' : 'Shuffle'}
          </button>
          <span className="small muted">{list.length} words</span>
          <div className="seg" role="group" aria-label="View">
            <button type="button" aria-pressed={mode === 'list'} onClick={() => switchMode('list')}>
              List
            </button>
            <button type="button" aria-pressed={mode === 'card'} onClick={() => switchMode('card')}>
              Cards
            </button>
          </div>
        </div>
        {mode === 'list' ? (
          <QmList items={list.slice(0, limit).map((n) => ({ key: n.id, note: n }))} shown={shown} listen={listen} />
        ) : (
          <QmCards key={seed + tag + filter} notes={list} shown={shown} listen={listen} />
        )}
        {mode === 'list' && list.length > limit && (
          <button type="button" className="btn" onClick={() => setLimit(limit + 200)}>
            Show more
          </button>
        )}
      </div>
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
