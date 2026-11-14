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
import { checkAnswer, clearSession, isRight, loadSession, saveSession, sessionKey, TARGETS, type Target } from '../lib/quick';
import type { Check } from '../lib/engine/grade';
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
  const [seed, setSeed] = useState<string>(() => pref('qm.seed', ''));
  const changeSeed = (v: string) => (setSeed(v), setPref('qm.seed', v));
  const [limit, setLimit] = useState(100);
  const [open, setOpen] = useState<Note | null>(null);

  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n] as const)), [notes]);
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
            <button type="button" className="cell tap has-icon action qk-shuffle" onClick={() => changeSeed(seed ? '' : String(Date.now()))} aria-pressed={!!seed}>
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
          <QmCards key={seed + tag + filter} deck={sessionKey(tag, filter, seed)} byId={byId} notes={list} shown={shown} listen={listen} onExplain={setOpen} />
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

const TARGET_LABEL: Record<Target, string> = { hanzi: 'Hanzi', pinyin: 'Pinyin', fr: 'French' };
const TARGET_LAYER: Record<Target, Layer> = { hanzi: 'hz', pinyin: 'py', fr: 'mn' };
const PLACEHOLDER: Record<Target, string> = { hanzi: '汉字', pinyin: 'ni3 hao3', fr: 'sens en français' };
const readTarget = (v: string): Target => (TARGETS.includes(v as Target) ? (v as Target) : 'hanzi');

function QmCards({
  deck,
  byId,
  notes,
  shown,
  listen,
  onExplain,
}: {
  deck: string;
  byId: Map<string, Note>;
  notes: Note[];
  shown: Shown;
  listen: boolean;
  onExplain: (n: Note) => void;
}) {
  // The saved session (this device only) wins over a fresh deck; ids are resolved against every note, not the filtered list.
  const [saved] = useState(() => loadSession(deck, new Set(byId.keys())));
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((x): x is Note => !!x);
  const [order, setOrder] = useState<Note[]>(() => (saved ? pick(saved.ids) : notes));
  const [i, setI] = useState(saved?.i ?? 0);
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [missed, setMissed] = useState<Note[]>(() => (saved ? pick(saved.missed) : []));
  const [knew, setKnew] = useState(saved?.knew ?? 0);
  const [round, setRound] = useState(saved?.round ?? 1);
  const [sent, setSent] = useState(saved?.sent ?? false);
  const [target, setTarget] = useState<Target>(() => readTarget(pref('qm.answer', 'hanzi')));
  const [typed, setTyped] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const shift = useShift();
  const lang = useApp((s) => s.lang);
  const n = order[i];
  const input = useRef<HTMLInputElement>(null);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;

  const save = (o: Note[], at: number, m: Note[], k: number, r: number, s = false) =>
    saveSession({ key: deck, ids: o.map((x) => x.id), i: at, missed: m.map((x) => x.id), knew: k, round: r, sent: s });

  useEffect(() => setPeek({}), [i, shown]);
  useEffect(() => {
    if (n && listen) speak(n.hanzi);
  }, [n, listen]);
  useEffect(() => {
    if (n && !coarse) input.current?.focus();
  }, [n, coarse]);

  const chooseTarget = (t: Target) => {
    setTarget(t);
    setPref('qm.answer', t);
    setTyped('');
  };

  // The result counts now and is saved with the next card, so leaving on the verdict neither loses nor repeats it.
  const submit = (given: string) => {
    if (!n || check) return;
    const c: Check = given ? checkAnswer(target, given, n, pref<boolean>('acceptBoth', true)) : { verdict: 'wrong', expected: '' };
    const ok = isRight(c.verdict);
    const m = ok || missed.includes(n) ? missed : [...missed, n];
    const k = knew + (ok ? 1 : 0);
    setCheck(c);
    setMissed(m);
    setKnew(k);
    save(order, i + 1, m, k, round);
  };
  const next = () => {
    setCheck(null);
    setTyped('');
    setI(i + 1);
    if (!coarse || document.activeElement === input.current) input.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || inDialog(e)) return;
      if (e.key === 'Enter' && check && tag !== 'BUTTON') next();
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
      // Saved before recording, so a reload during or after it can't send the same words twice.
      setSent(true);
      save(order, i, missed, knew, round, true);
      for (const w of missed) await recordReview(cardId(w.id, 'recog'), 1, 'quick', 0);
      toast(`${missed.length} word${missed.length > 1 ? 's' : ''} back in reviews`);
    };
    return (
      <div className="qk-done">
        <span className="qk-done-icon" aria-hidden="true">
          <Icon name="check-circle" />
        </span>
        <h2>Round {round} done</h2>
        <p className="qk-done-sub">
          Right {knew}, wrong {missed.length}.
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
                save(missed, 0, [], 0, round + 1);
              }}
            >
              Retry the {missed.length} wrong
            </button>
          )}
          {missed.length > 0 && !sent && (
            <button type="button" className="btn" onClick={sendBack}>
              Send to reviews
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
              if (notes.length) save(notes, 0, [], 0, 1);
              else clearSession();
            }}
          >
            Start over
          </button>
        </div>
      </div>
    );
  }

  const hidden = TARGET_LAYER[target];
  const vis = (k: Layer) => !!check || (k !== hidden && (shift || !!peek.all || shown[k] !== !!peek[k]));
  const flip = (k: Layer) => k !== hidden && setPeek((p) => ({ ...p, [k]: !p[k] }));
  const ok = check ? isRight(check.verdict) : false;
  const answer = target === 'hanzi' ? n.hanzi : target === 'pinyin' ? n.pinyinNum || n.pinyin : meaning(n, 'fr').text;
  return (
    <div className="qk-cards">
      <div className="qk-progress" aria-hidden="true">
        <i style={{ width: `${Math.round((i / order.length) * 100)}%` }} />
      </div>
      <div className="qk-count">
        {i + 1} / {order.length}
        {round > 1 ? ` · retry round ${round}` : ''}
      </div>
      <Segmented
        label="Answer with"
        className="qk-answer-with"
        value={target}
        onChange={chooseTarget}
        options={TARGETS.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
      />
      <div className="qk-card">
        <button type="button" className="qk-cell qk-hz" lang="zh-CN" onClick={() => (vis('hz') ? speak(n.hanzi) : flip('hz'))} aria-label={vis('hz') ? `${n.hanzi}, play audio` : hidden === 'hz' ? 'Hidden hanzi, type it below' : 'Hidden hanzi, tap to show'}>
          {vis('hz') ? <span className="qk-in">{n.hanzi}</span> : <span className="qk-hide" />}
        </button>
        <button type="button" className="qk-cell qk-py" onClick={() => flip('py')} aria-label={vis('py') ? n.pinyin : hidden === 'py' ? 'Hidden pinyin, type it below' : 'Hidden pinyin, tap to show'}>
          {vis('py') ? <Pinyin text={n.pinyin} className="qk-in" /> : <span className="qk-hide" />}
        </button>
        <button type="button" className="qk-cell qk-mn" onClick={() => flip('mn')} lang={lang} aria-label={vis('mn') ? undefined : hidden === 'mn' ? 'Hidden meaning, type it below' : 'Hidden meaning, tap to show'}>
          {vis('mn') ? <span className="qk-in">{meaning(n, lang).text}</span> : <span className="qk-hide" />}
        </button>
      </div>
      <form
        className="qk-type"
        onSubmit={(e) => {
          e.preventDefault();
          if (check) next();
          else if (typed.trim()) submit(typed);
        }}
      >
        <input
          ref={input}
          className="qk-input"
          type="text"
          value={typed}
          readOnly={!!check}
          onChange={(e) => setTyped(e.target.value)}
          // Digits are tone numbers here, so 1 2 3 L Space type into the box; Escape leaves it to get the shortcuts back.
          onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
          placeholder={PLACEHOLDER[target]}
          aria-label={`Type the ${TARGET_LABEL[target].toLowerCase()}`}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          lang={target === 'hanzi' ? 'zh-CN' : target === 'fr' ? 'fr' : 'en'}
          enterKeyHint={check ? 'next' : 'done'}
        />
        {check && (
          <>
            <div className={`qk-verdict verdict ${ok ? 'right' : 'wrong'}`} role="status">
              {ok ? 'Right' : 'Wrong'}
            </div>
            <p className="qk-expected" lang={target === 'hanzi' ? 'zh-CN' : target === 'fr' ? 'fr' : undefined}>
              {answer}
            </p>
          </>
        )}
        <div className="qk-actions">
          {check ? (
            <button key="next" type="submit" className="btn primary grow">
              Next
            </button>
          ) : (
            <>
              <button key="show" type="button" className="btn grow" onClick={() => submit('')}>
                Show answer
              </button>
              <button key="check" type="submit" className="btn primary grow" disabled={!typed.trim()}>
                Check
              </button>
            </>
          )}
        </div>
      </form>
      {vis('hz') && vis('mn') && (
        <button type="button" className="btn plain qk-explain" onClick={() => onExplain(n)}>
          <Icon name="sparkles" />
          Explain
        </button>
      )}
    </div>
  );
}
