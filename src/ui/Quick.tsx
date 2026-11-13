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
import { Cell, Icon, LangSwitch, Pinyin, Segmented, toast, TopBar } from './common';
import { inDialog } from './panel';
import { WordPanel } from './word/WordPanel';
import { LayerBar, PresetSeg, QmList, useQmShown, useShift, type Layer, type Shown } from './qm';
import './quick.css';

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
  const [open, setOpen] = useState<Note | null>(null);

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
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT' || inDialog(e)) return;
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
    <div className="main qk">
      <TopBar title="Quick memory">
        <LangSwitch />
      </TopBar>
      <div className="qk-body">
        <section className="group" aria-label="Quick memory options">
          <div className="group-card">
            <Cell className="qk-presets">
              <PresetSeg preset={preset} onPreset={setShown} />
            </Cell>
            <div className="cell">
              <span className="cell-body">
                <span className="cell-label">Show</span>
              </span>
              <LayerBar shown={shown} lang={lang} onToggle={toggle} />
            </div>
            <label className="cell">
              <span className="cell-body">
                <span className="cell-label">Sheet</span>
              </span>
              <span className="cell-select">
                <select value={tag} onChange={(e) => (setTag(e.target.value), setPref('qm.tag', e.target.value))} aria-label="Sheet">
                  <option value="all">All words</option>
                  {tags.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
                <Icon name="updown" />
              </span>
            </label>
            <label className="cell">
              <span className="cell-body">
                <span className="cell-label">Status</span>
              </span>
              <span className="cell-select">
                <select value={filter} onChange={(e) => (setFilter(readFilter(e.target.value)), setPref('qm.filter', e.target.value))} aria-label="Filter">
                  <option value="all">Any status</option>
                  {WORD_STATUSES.map((st) => (
                    <option key={st} value={`st:${st}`}>
                      {STATUS_LABEL[st]}
                    </option>
                  ))}
                  <option value="week">Seen this week</option>
                  <option value="missed">Missed recently</option>
                </select>
                <Icon name="updown" />
              </span>
            </label>
            <button type="button" className="cell tap has-icon action qk-shuffle" onClick={() => setSeed(seed ? '' : String(Date.now()))} aria-pressed={!!seed}>
              <Icon name={seed ? 'list' : 'shuffle'} className="cell-glyph" />
              <span className="cell-body">
                <span className="cell-label">{seed ? 'Sheet order' : 'Shuffle'}</span>
              </span>
              <span className="cell-value">{list.length} words</span>
            </button>
          </div>
        </section>
        <Segmented
          label="View"
          className="qk-view"
          value={mode}
          onChange={switchMode}
          options={[
            { value: 'list', label: 'List' },
            { value: 'card', label: 'Cards' },
          ]}
        />
        {mode === 'list' ? (
          list.length ? (
            <QmList items={list.slice(0, limit).map((n) => ({ key: n.id, note: n }))} shown={shown} listen={listen} onOpen={(it) => setOpen(it.note)} />
          ) : (
            <p className="qk-empty">No words match these filters.</p>
          )
        ) : (
          <QmCards key={seed + tag + filter} notes={list} shown={shown} listen={listen} onExplain={setOpen} />
        )}
        {mode === 'list' && list.length > limit && (
          <button type="button" className="btn tinted block" onClick={() => setLimit(limit + 200)}>
            Show more
          </button>
        )}
      </div>
      {open && <WordPanel key={open.id} note={open} tabs={['explain']} onClose={() => setOpen(null)} />}
    </div>
  );
}

function QmCards({ notes, shown, listen, onExplain }: { notes: Note[]; shown: Shown; listen: boolean; onExplain: (n: Note) => void }) {
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
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT' || inDialog(e)) return;
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

  if (!order.length) return <p className="qk-empty">No words match these filters.</p>;

  if (!n) {
    const sendBack = async () => {
      for (const w of missed) await recordReview(cardId(w.id, 'recog'), 1, 'quick', 0);
      setSent(true);
      toast(`${missed.length} word${missed.length > 1 ? 's' : ''} back in reviews`);
    };
    return (
      <div className="qk-done">
        <span className="qk-done-icon" aria-hidden="true">
          <Icon name="check-circle" />
        </span>
        <h2>Round {round} done</h2>
        <p className="qk-done-sub">
          Knew {knew}, missed {missed.length}.
        </p>
        <div className="qk-done-actions">
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
    <div className="qk-cards">
      <div className="qk-progress" aria-hidden="true">
        <i style={{ width: `${Math.round((i / order.length) * 100)}%` }} />
      </div>
      <div className="qk-count">
        {i + 1} / {order.length}
        {round > 1 ? ` · retry round ${round}` : ''}
      </div>
      <div
        className="qk-card"
        style={{ transform: dx ? `translateX(${dx}px) rotate(${dx / 40}deg)` : undefined, transition: start.current ? 'none' : undefined }}
        data-swipe={dx > 40 ? 'right' : dx < -40 ? 'left' : undefined}
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
        <button type="button" className="qk-cell qk-hz" lang="zh-CN" onClick={() => (vis('hz') ? speak(n.hanzi) : flip('hz'))} aria-label={vis('hz') ? `${n.hanzi}, play audio` : 'Hidden hanzi, tap to show'}>
          {vis('hz') ? <span className="qk-in">{n.hanzi}</span> : <span className="qk-hide" />}
        </button>
        <button type="button" className="qk-cell qk-py" onClick={() => flip('py')} aria-label={vis('py') ? n.pinyin : 'Hidden pinyin, tap to show'}>
          {vis('py') ? <Pinyin text={n.pinyin} className="qk-in" /> : <span className="qk-hide" />}
        </button>
        <button type="button" className="qk-cell qk-mn" onClick={() => flip('mn')} lang={lang} aria-label={vis('mn') ? undefined : 'Hidden meaning, tap to show'}>
          {vis('mn') ? <span className="qk-in">{meaning(n, lang).text}</span> : <span className="qk-hide" />}
        </button>
        <span className="qk-swipe qk-swipe-l" aria-hidden="true">Missed</span>
        <span className="qk-swipe qk-swipe-r" aria-hidden="true">Knew it</span>
      </div>
      <p className="qk-hint">Tap to reveal. Swipe right if you knew it, left if you missed it.</p>
      {vis('hz') && vis('mn') && (
        <button type="button" className="btn plain qk-explain" onClick={() => onExplain(n)}>
          <Icon name="sparkles" />
          Explain
        </button>
      )}
      <div className="grades qk-grades">
        <button type="button" className="g1" onClick={() => answer(false)}>
          Missed <small aria-hidden="true">←</small>
        </button>
        <button type="button" className="g3" onClick={() => answer(true)}>
          Knew it <small aria-hidden="true">→</small>
        </button>
      </div>
    </div>
  );
}
