// Cards: the drill. One word at a time, one layer hidden (hanzi, pinyin, French) or drawn from memory (Draw).
// Route `#/cards`, on the focus shell. Deep link `#/cards?sheet=&status=&at=` builds the deck from a Sheets tab and
// filter, then the URL is reset to `#/cards`; with no query the last deck (device pref `cards.deck`) is used.
// Free practice: typed answers record no review events except "Send to reviews". A wrong answer sets the Wrong label
// (marks, mobile-ux D6). The session (deck order, position, counts) is device-only UI state, see QUICK-1.
import { useEffect, useMemo, useRef, useState } from 'react';
import type { Note } from '../../lib/types';
import { meaning, recordReview, setLang, setWrong, useApp } from '../../lib/store';
import { pref, setPref } from '../../lib/db';
import { speak } from '../../lib/speech';
import { cardId } from '../../lib/engine/schedule';
import { sheetRows, STATUS_LABEL } from '../../lib/status';
import { fnv1a } from '../../lib/import/build';
import { HAN } from '../../lib/pinyin';
import { wrongNotes } from '../../lib/wrong';
import {
  allRows, checkAnswer, clearSession, drawVerdict, filterRows, isRight, loadSession, readCardsQuery, readListFilter, recentByNote, saveSession,
  sessionKey, startIndex, TARGETS, type ListFilter, type Target,
} from '../../lib/quick';
import { Icon, Pinyin, Segmented, toast } from '../common';
import { inDialog, Sheet } from '../panel';
import { StrokeAnimation, WritePad, type WriteResult } from '../WritePad';
import { ScratchPanel } from '../sheets/ScratchPad';
import { WordPanel } from '../word/WordPanel';
import { LayerBar, PresetSeg, useQmShown, useShift, type Layer, type Shown } from '../qm';
import './cards.css';

const FILTER_LABEL = (f: ListFilter) => (f === 'all' ? 'All' : f === 'wrong' ? 'Wrong' : f === 'week' ? 'Seen this week' : f === 'missed' ? 'Missed recently' : STATUS_LABEL[f]);

const TARGET_LABEL: Record<Target, string> = { hanzi: 'Hanzi', pinyin: 'Pinyin', fr: 'French', draw: 'Draw' };
const TARGET_LAYER: Record<Target, Layer> = { hanzi: 'hz', pinyin: 'py', fr: 'mn', draw: 'hz' };
const PLACEHOLDER: Record<Target, string> = { hanzi: '汉字', pinyin: 'ni3 hao3 or 3 3', fr: 'sens en français', draw: '' };
const readTarget = (v: string): Target => (TARGETS.includes(v as Target) ? (v as Target) : 'hanzi');
const KINDS = ['vocab', 'synonym', 'measure'];

interface Deck {
  sheet: string; // '' = the All tab
  status: ListFilter;
}

export function CardsPage() {
  const { notes, events, lang, marks, meta } = useApp((s) => s);
  const { shown, preset, listen, setShown, toggle } = useQmShown('qm');
  const [q] = useState(() => readCardsQuery(location.hash));
  const [deck] = useState<Deck>(() => {
    const given = q.sheet !== undefined || q.status !== undefined || q.at !== undefined;
    if (!given) {
      const d = pref<Partial<Deck>>('cards.deck', {});
      return { sheet: typeof d.sheet === 'string' ? d.sheet : '', status: readListFilter(d.status) };
    }
    return { sheet: q.sheet ?? '', status: readListFilter(q.status) };
  });
  const [at, setAt] = useState(q.at);
  const [seed, setSeed] = useState<string>(() => pref('qm.seed', ''));
  const changeSeed = (v: string) => {
    setSeed(v);
    setPref('qm.seed', v);
    setAt(undefined);
  };
  const [settings, setSettings] = useState(false);

  useEffect(() => {
    if (location.hash.includes('?')) history.replaceState(null, '', '#/cards');
    setPref('cards.deck', deck);
  }, [deck]);

  const byId = useMemo(() => new Map(notes.map((n) => [n.id, n] as const)), [notes]);
  const wrong = useMemo(() => wrongNotes(marks), [marks]);
  const bySheet = useMemo(() => sheetRows(notes, marks, meta?.colourSince), [notes, marks, meta]);
  const sheet = bySheet.has(deck.sheet) ? deck.sheet : '';
  const list = useMemo(() => {
    const rows = sheet ? bySheet.get(sheet) ?? [] : allRows(bySheet);
    const out = filterRows(rows, deck.status, { wrong, recent: recentByNote(events, Date.now()) })
      .map((r) => r.note)
      .filter((n) => KINDS.includes(n.kind));
    return seed ? [...out].sort((a, b) => (fnv1a(seed + a.id) < fnv1a(seed + b.id) ? -1 : 1)) : out;
  }, [bySheet, sheet, deck.status, wrong, events, seed]);

  const caption = `${sheet || 'All'} · ${FILTER_LABEL(deck.status)}`;

  return (
    <Round
      key={sessionKey(sheet, deck.status, seed)}
      deckKey={sessionKey(sheet, deck.status, seed)}
      legacyKey={legacyQuickKey(sheet, deck.status, seed)}
      caption={caption}
      byId={byId}
      notes={list}
      wrong={wrong}
      at={at}
      shown={shown}
      preset={preset}
      listen={listen}
      lang={lang}
      setShown={setShown}
      toggle={toggle}
      seed={seed}
      onSeed={changeSeed}
      settings={settings}
      setSettings={setSettings}
    />
  );
}

/** Device-only pref: how many characters long the answer is decides how the pad is laid out. */
const hanCount = (w: string) => [...w].filter((c) => HAN.test(c)).length;

function Round({
  deckKey, legacyKey, caption, byId, notes, wrong, at, shown, preset, listen, lang, setShown, toggle, seed, onSeed, settings, setSettings,
}: {
  deckKey: string;
  /** Key the old Quick screen saved this deck under, so a round started there resumes here once. */
  legacyKey: string | null;
  caption: string;
  byId: Map<string, Note>;
  notes: Note[];
  wrong: ReadonlySet<string>;
  at?: string;
  shown: Shown;
  preset: string;
  listen: boolean;
  lang: 'en' | 'fr';
  setShown: (s: Shown, p?: string) => void;
  toggle: (l: Layer) => void;
  seed: string;
  onSeed: (v: string) => void;
  settings: boolean;
  setSettings: (v: boolean) => void;
}) {
  // The saved session (this device only) wins over a fresh deck, unless a deep link names the word to start on.
  const [saved] = useState(() => {
    if (at) return null;
    const alive = new Set(byId.keys());
    return loadSession(deckKey, alive) ?? (legacyKey ? loadSession(legacyKey, alive) : null);
  });
  const pick = (ids: string[]) => ids.map((id) => byId.get(id)).filter((x): x is Note => !!x);
  const [order, setOrder] = useState<Note[]>(() => (saved ? pick(saved.ids) : notes));
  const [i, setI] = useState(() => (saved ? saved.i : startIndex(notes.map((x) => x.id), at)));
  const [peek, setPeek] = useState<Record<string, boolean>>({});
  const [missed, setMissed] = useState<Note[]>(() => (saved ? pick(saved.missed) : []));
  const [knew, setKnew] = useState(saved?.knew ?? 0);
  const [round, setRound] = useState(saved?.round ?? 1);
  const [sent, setSent] = useState(saved?.sent ?? false);
  const [target, setTarget] = useState<Target>(() => readTarget(pref('qm.answer', 'hanzi')));
  const [typed, setTyped] = useState('');
  // done: this card was answered. ok null = no verdict (tracing with the outline, or no stroke data).
  const [done, setDone] = useState<{ ok: boolean | null; note?: string } | null>(null);
  const [guided, setGuided] = useState<boolean>(() => pref('cards.outline', true));
  const [run, setRun] = useState(0);
  const [justWrong, setJustWrong] = useState<ReadonlySet<string>>(new Set());
  const [scratch, setScratch] = useState(false);
  const [open, setOpen] = useState<Note | null>(null);
  const shift = useShift();
  const n = order[i];
  const input = useRef<HTMLInputElement>(null);
  const counted = useRef(-1);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const draw = target === 'draw';

  const save = (o: Note[], at: number, m: Note[], k: number, r: number, s = false) =>
    saveSession({ key: deckKey, ids: o.map((x) => x.id), i: at, missed: m.map((x) => x.id), knew: k, round: r, sent: s });

  // A fresh deck is saved at once, so a reload before the first answer keeps the position.
  useEffect(() => {
    if (!saved && order.length) save(order, i, missed, knew, round);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => setPeek({}), [i, shown]);
  useEffect(() => {
    if (n && listen) speak(n.hanzi);
  }, [n, listen]);
  useEffect(() => {
    if (n && !coarse && !draw) input.current?.focus();
  }, [n, coarse, draw]);

  const chooseTarget = (t: Target) => {
    setTarget(t);
    setPref('qm.answer', t);
    setTyped('');
    setDone(null);
    setRun((r) => r + 1);
  };
  const chooseOutline = () => {
    setGuided(!guided);
    setPref('cards.outline', !guided);
    setRun((r) => r + 1);
  };

  // The result counts now and is saved with the next card, so leaving on the verdict neither loses nor repeats it.
  const finish = (ok: boolean | null, note?: string) => {
    if (!n || done) return;
    setDone({ ok, note });
    const key = round * 1e6 + i;
    if (counted.current === key) return;
    counted.current = key;
    let m = missed;
    let k = knew;
    if (ok !== null) {
      if (ok) k++;
      else {
        if (!missed.includes(n)) m = [...missed, n];
        void setWrong([n.id], true);
        setJustWrong((s) => new Set(s).add(n.id));
      }
    }
    setMissed(m);
    setKnew(k);
    save(order, i + 1, m, k, round);
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const submit = (given: string) => {
    if (!n || done) return;
    const c = given ? checkAnswer(target, given, n, pref<boolean>('acceptBoth', true)) : null;
    finish(c ? isRight(c.verdict) : false);
  };
  const onPad = (r: WriteResult) => {
    const v = drawVerdict({ guided, hints: r.hints, missing: r.missing });
    finishRef.current(v === null ? null : v === 'right', v === null ? (r.missing.length ? 'No stroke data' : 'Traced') : undefined);
  };
  const reveal = () => {
    const v = drawVerdict({ guided, revealed: true });
    finish(v === null ? null : v === 'right', v === null ? 'Answer shown' : undefined);
  };
  const next = () => {
    setDone(null);
    setTyped('');
    setRun((r) => r + 1);
    setI(i + 1);
    if (!coarse || document.activeElement === input.current) input.current?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || inDialog(e)) return;
      if (e.key === 'Enter' && done && tag !== 'BUTTON') next();
      else if (e.key === ' ' && !draw && tag !== 'BUTTON') {
        e.preventDefault();
        setPeek((p) => ({ ...p, all: !p.all }));
      } else if ((e.key === 'a' || e.key === 'A') && n) speak(n.hanzi);
      else if ((e.key === 'l' || e.key === 'L') && !draw) setLang(lang === 'en' ? 'fr' : 'en');
      else if (e.key === 'Escape') location.hash = '#/sheets';
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const restart = (o: Note[]) => {
    counted.current = -1;
    setOrder(o);
    setMissed([]);
    setKnew(0);
    setI(0);
    setDone(null);
    setTyped('');
  };

  const bar = (
    <>
      <header className="qk-bar">
        <button type="button" className="icon-btn" aria-label="Close" title="Close" onClick={() => (location.hash = '#/sheets')}>
          <Icon name="close" />
        </button>
        <div className="qk-count" aria-live="polite">
          {n ? `${i + 1} / ${order.length}` : `${order.length} / ${order.length}`}
          {round > 1 ? ` · retry round ${round}` : ''}
        </div>
        <button type="button" className="icon-btn" aria-label="Cards settings" title="Settings" onClick={() => setSettings(true)}>
          <Icon name="settings" />
        </button>
      </header>
      <div className="qk-progress" aria-hidden="true">
        <i style={{ width: `${order.length ? Math.round((Math.min(i, order.length) / order.length) * 100) : 0}%` }} />
      </div>
      <p className="qk-caption">
        {caption} · {order.length} word{order.length === 1 ? '' : 's'} · {TARGET_LABEL[target]}
      </p>
    </>
  );
  const overlays = (
    <>
      {settings && (
        <Sheet title="Cards" label="Cards settings" size="content" onClose={() => setSettings(false)}>
          <div className="cd-set">
            <Segmented
              label="Answer with"
              className="cd-seg"
              value={target}
              onChange={chooseTarget}
              options={TARGETS.map((t) => ({ value: t, label: TARGET_LABEL[t] }))}
            />
            <p className="cd-hint">The answer layer stays hidden until you check.</p>
          </div>
          <div className="cd-set">
            <span className="cd-label">Show</span>
            <LayerBar shown={shown} lang={lang} onToggle={toggle} />
            <PresetSeg preset={preset} onPreset={setShown} />
          </div>
          <button type="button" className="btn block cd-shuffle" aria-pressed={!!seed} onClick={() => onSeed(seed ? '' : String(Date.now()))}>
            <Icon name={seed ? 'list' : 'shuffle'} />
            {seed ? 'Sheet order' : 'Shuffle'}
          </button>
        </Sheet>
      )}
      {scratch && <ScratchPanel onClose={() => setScratch(false)} />}
      {open && <WordPanel key={open.id} note={open} tabs={['explain']} onClose={() => setOpen(null)} />}
    </>
  );

  if (!order.length) {
    return (
      <div className="cd">
        {bar}
        <p className="qk-empty">No words match this deck.</p>
        {overlays}
      </div>
    );
  }

  if (!n) {
    const sendBack = async () => {
      // Saved before recording, so a reload during or after it can't send the same words twice.
      setSent(true);
      save(order, i, missed, knew, round, true);
      for (const w of missed) await recordReview(cardId(w.id, 'recog'), 1, 'quick', 0);
      toast(`${missed.length} word${missed.length > 1 ? 's' : ''} back in reviews`);
    };
    return (
      <div className="cd">
        {bar}
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
                  restart(missed);
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
                restart(notes);
                setRound(1);
                if (notes.length) save(notes, 0, [], 0, 1);
                else clearSession();
              }}
            >
              Start over
            </button>
          </div>
          {missed.length > 0 && (
            <ul className="qk-miss" aria-label="Wrong words">
              {missed.map((w) => (
                <li key={w.id}>
                  <button type="button" className="qk-miss-row" onClick={() => setOpen(w)}>
                    <span className="qk-miss-hz" lang="zh-CN">{w.hanzi}</span>
                    <Pinyin text={w.pinyin} className="qk-miss-py" />
                    <span className="qk-miss-mn">{meaning(w, lang).text}</span>
                  </button>
                  {(wrong.has(w.id) || justWrong.has(w.id)) && (
                    <button
                      type="button"
                      className="qk-miss-clear"
                      aria-label={`Clear Wrong for ${w.hanzi}`}
                      onClick={() => {
                        setJustWrong((s) => new Set([...s].filter((id) => id !== w.id)));
                        void setWrong([w.id], false);
                        toast(`Wrong cleared for ${w.hanzi}`);
                      }}
                    >
                      <WrongTag />
                    </button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
        {overlays}
      </div>
    );
  }

  const hidden = TARGET_LAYER[target];
  const vis = (k: Layer) => !!done || (draw ? k !== 'hz' : k !== hidden && (shift || !!peek.all || shown[k] !== !!peek[k]));
  const flip = (k: Layer) => k !== hidden && !draw && setPeek((p) => ({ ...p, [k]: !p[k] }));
  const ok = done?.ok ?? null;
  const isWrong = wrong.has(n.id) || justWrong.has(n.id);
  // Tapping Show answer / Check / Next must not take focus from the answer field: on the iPhone that closes the keyboard,
  // the column (bottom: var(--kb)) grows by the keyboard's height and the whole screen drops, then jumps back up at the
  // next card. Preventing the mousedown default keeps the focus (and the keyboard) where it is; the click still fires.
  const keep = (e: { preventDefault: () => void }) => {
    if (document.activeElement === input.current) e.preventDefault();
  };
  const scratchBtn = (
    <button type="button" className="btn qk-tool" onClick={() => setScratch(true)} aria-label="Scratch" title="Scratch pad">
      <Icon name="pen" />
    </button>
  );

  return (
    <div className="cd qk-cards">
      {bar}
      <div className="qk-stage">
        <div className={`qk-card ${draw ? 'draw' : ''}`}>
          {isWrong && <WrongTag className="qk-card-tag" />}
          {done && (
            <button type="button" className="icon-btn qk-explain" aria-label="Explain" title="Explain" onClick={() => setOpen(n)}>
              <Icon name="sparkles" />
            </button>
          )}
          {!(draw && !done) && (
            <button
              type="button"
              className="qk-cell qk-hz"
              lang="zh-CN"
              onClick={() => (vis('hz') ? speak(n.hanzi) : flip('hz'))}
              aria-label={vis('hz') ? `${n.hanzi}, play audio` : hidden === 'hz' ? 'Hidden hanzi, type it below' : 'Hidden hanzi, tap to show'}
            >
              {vis('hz') ? <span className="qk-in">{n.hanzi}</span> : <span className="qk-hide" />}
            </button>
          )}
          <button
            type="button"
            className="qk-cell qk-py"
            onClick={() => flip('py')}
            aria-label={vis('py') ? n.pinyin : hidden === 'py' ? 'Hidden pinyin, type it below' : 'Hidden pinyin, tap to show'}
          >
            {vis('py') ? <Pinyin text={n.pinyin} className="qk-in" /> : <span className="qk-hide" />}
          </button>
          <button
            type="button"
            className="qk-cell qk-mn"
            onClick={() => flip('mn')}
            lang={lang}
            aria-label={vis('mn') ? undefined : hidden === 'mn' ? 'Hidden meaning, type it below' : 'Hidden meaning, tap to show'}
          >
            {vis('mn') ? <span className="qk-in">{meaning(n, lang).text}</span> : <span className="qk-hide" />}
          </button>
          {draw && <DrawArea key={`${n.id}-${run}-${guided}`} note={n} guided={guided} done={!!done} onDone={onPad} />}
        </div>
      </div>
      <form
        className="qk-dock"
        onSubmit={(e) => {
          e.preventDefault();
          if (done) next();
          else if (!draw && typed.trim()) submit(typed);
        }}
      >
        {!draw && (
          <input
            ref={input}
            className={`qk-input${done && ok !== null ? (ok ? ' right' : ' wrong') : ''}`}
            type="text"
            value={typed}
            aria-invalid={done && ok === false ? true : undefined}
            onChange={(e) => !done && setTyped(e.target.value)}
            // Digits are tone numbers here, so 1 2 3 L Space type into the box; Escape leaves it to get the shortcuts back.
            onKeyDown={(e) => e.key === 'Escape' && e.currentTarget.blur()}
            placeholder={PLACEHOLDER[target]}
            aria-label={`Type the ${TARGET_LABEL[target].toLowerCase()}`}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            lang={target === 'hanzi' ? 'zh-CN' : target === 'fr' ? 'fr' : 'en'}
            enterKeyHint={done ? 'next' : 'done'}
          />
        )}
        {/* The verdict line keeps its room before the answer, so checking does not push the card up (and Next down). */}
        <div className="qk-result" role="status">
          {done && (
            <>
              <span className={`qk-verdict verdict ${ok === null ? 'near' : ok ? 'right' : 'wrong'}`}>{ok === null ? done.note : ok ? 'Right' : 'Wrong'}</span>
              {!draw && (
                <span className="qk-expected" lang={target === 'hanzi' ? 'zh-CN' : target === 'fr' ? 'fr' : undefined}>
                  {target === 'hanzi' ? n.hanzi : target === 'pinyin' ? <Pinyin text={n.pinyin} /> : meaning(n, 'fr').text}
                </span>
              )}
            </>
          )}
        </div>
        <div className="qk-actions">
          {done ? (
            <>
              {scratchBtn}
              <button key="next" type="submit" className="btn primary grow" onMouseDown={keep}>
                Next
              </button>
            </>
          ) : draw ? (
            <>
              <button key="outline" type="button" className="btn grow qk-tool" aria-pressed={guided} aria-label="Outline" title={guided ? 'Outline on: tracing, not recorded' : 'Outline off: from memory'} onClick={chooseOutline}>
                <OutlineIcon />
              </button>
              <button key="reveal" type="button" className="btn grow qk-tool" aria-label="Show answer" title="Show answer" onClick={reveal}>
                <EyeIcon />
              </button>
              {scratchBtn}
            </>
          ) : (
            <>
              {scratchBtn}
              <button key="show" type="button" className="btn grow" onMouseDown={keep} onClick={() => submit('')}>
                Show answer
              </button>
              <button key="check" type="submit" className="btn primary grow" disabled={!typed.trim()} onMouseDown={keep}>
                Check
              </button>
            </>
          )}
        </div>
      </form>
      {overlays}
    </div>
  );
}

/** Key the old Quick screen used for the same deck: tag 'all' or the sheet, filter 'all' | 'st:<status>' | 'week' | 'missed'. */
function legacyQuickKey(sheet: string, status: ListFilter, seed: string): string | null {
  const filter = status === 'all' || status === 'week' || status === 'missed' ? status : status === 'wrong' ? null : `st:${status}`;
  return filter ? sessionKey(sheet || 'all', filter, seed) : null;
}

function WrongTag({ className = '' }: { className?: string }) {
  return (
    <span className={`qk-wrongtag ${className}`}>
      <Icon name="x-circle" />
      Wrong
    </span>
  );
}

/** The writing square sized to the room left in the card; after the answer, the stroke animation instead. */
function DrawArea({ note, guided, done, onDone }: { note: Note; guided: boolean; done: boolean; onDone: (r: WriteResult) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [dim, setDim] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const fit = () => setDim({ w: el.clientWidth, h: el.clientHeight });
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const c = hanCount(note.hanzi);
  const strip = c > 1 ? 76 : 0; // the small cells above the square
  const side = Math.floor(Math.min(dim.w, dim.h - strip));
  const anim = Math.max(64, Math.min(140, Math.floor((dim.w - (c - 1) * 8) / Math.max(1, c)), dim.h - 4));
  return (
    <div className="qk-padbox" ref={box}>
      {side >= 100 && !done && <WritePad word={note.hanzi} guided={guided} size={side} bare onDone={onDone} />}
      {done && dim.h > 0 && <StrokeAnimation word={note.hanzi} size={anim} />}
    </div>
  );
}

function OutlineIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="4" y="4" width="16" height="16" rx="3" strokeDasharray="3 3" />
      <path d="M8 9h8M12 9v7M9 16h6" />
    </svg>
  );
}
function EyeIcon() {
  return (
    <svg viewBox="0 0 24 24" className="icon" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  );
}
