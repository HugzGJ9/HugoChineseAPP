// Review session: the card, Type / Write / Reveal answers, automatic grades, grade buttons.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CardState, CardType, Grade, Note } from '../lib/types';
import { getState, meaning, recordReview, undoReview, useApp } from '../lib/store';
import { buildQueue, reinsertIndex } from '../lib/engine/queue';
import { formatInterval, gradeName, noteOfCard, previewIntervals } from '../lib/engine/schedule';
import { checkHanzi, checkMeaning, checkPinyin, gradeFor, gradeWriting, type Check } from '../lib/engine/grade';
import { pref, setPref } from '../lib/db';
import { speak } from '../lib/speech';
import { AudioButton, GridWord, Icon, LangSwitch, Meaning, Pinyin, toast } from './common';
import { StrokeAnimation, WritePad } from './WritePad';
import { fnv1a } from '../lib/import/build';
import { HAN } from '../lib/pinyin';

type Mode = 'reveal' | 'type-pinyin' | 'type-hanzi' | 'type-meaning' | 'write-guided' | 'write-free' | 'choice' | 'build';

const coarse = typeof matchMedia !== 'undefined' && matchMedia('(pointer: coarse)').matches;

const MODES: Partial<Record<CardType, Mode[]>> = {
  recog: ['reveal', 'type-pinyin', 'type-meaning'],
  recall: ['write-guided', 'write-free', 'type-hanzi', 'type-pinyin', 'reveal'],
  listen: ['type-hanzi', 'type-pinyin', 'type-meaning', 'write-guided', 'reveal'],
};
const DEFAULT_MODE: Partial<Record<CardType, Mode>> = {
  recog: 'reveal',
  recall: coarse ? 'write-guided' : 'type-hanzi',
  listen: coarse ? 'reveal' : 'type-hanzi',
};
const MODE_LABEL: Record<Mode, string> = {
  reveal: 'Reveal',
  'type-pinyin': 'Pinyin',
  'type-hanzi': 'Hanzi',
  'type-meaning': 'Meaning',
  'write-guided': 'Write',
  'write-free': 'Write, free',
  choice: 'Choose',
  build: 'Build',
};

interface Session {
  queue: string[];
  pos: number;
  fresh: Set<string>;
  done: number;
  right: number;
  started: number;
  last?: { eventId: string; queue: string[]; pos: number; done: number; right: number };
}

function parseHash(): { cards?: string[] } {
  const q = location.hash.split('?')[1];
  if (!q) return {};
  const p = new URLSearchParams(q);
  const cards = p.get('cards');
  return cards ? { cards: cards.split(',').map(decodeURIComponent) } : {};
}

export function Review() {
  const ready = useApp((s) => s.ready);
  const [session, setSession] = useState<Session | null>(null);

  useEffect(() => {
    if (!ready || session) return;
    const s = getState();
    const custom = parseHash().cards;
    if (custom) {
      setSession({ queue: custom.filter((c) => s.cards.has(c)), pos: 0, fresh: new Set(), done: 0, right: 0, started: Date.now() });
      return;
    }
    const q = buildQueue([...s.cards.values()], s.noteMap, s.events, s.settings, Date.now());
    setSession({ queue: q.cards, pos: 0, fresh: q.fresh, done: 0, right: 0, started: Date.now() });
  }, [ready, session]);

  if (!session) return <div className="main" />;
  const cardId = session.queue[session.pos];

  const undo = async () => {
    const last = session.last;
    if (!last) return;
    await undoReview(last.eventId);
    setSession({ ...session, queue: last.queue, pos: last.pos, done: last.done, right: last.right, last: undefined });
    toast('Last answer undone');
  };

  return (
    <div className="main">
      <header className="topbar">
        <a className="icon-btn" href="#/today" aria-label="End session">
          <Icon name="close" />
        </a>
        <div className="grow">
          <div className="progress" aria-label={`${session.done} done, ${session.queue.length - session.pos} left`}>
            <i style={{ width: `${(session.pos / Math.max(1, session.queue.length)) * 100}%` }} />
          </div>
        </div>
        <span className="small muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {Math.max(0, session.queue.length - session.pos)}
        </span>
        <button type="button" className="icon-btn" onClick={undo} disabled={!session.last} aria-label="Undo last answer" title="Undo last answer">
          <Icon name="undo" />
        </button>
        <LangSwitch />
      </header>
      {cardId ? (
        <CardView
          key={`${cardId}:${session.pos}`}
          cardId={cardId}
          fresh={session.fresh.has(cardId)}
          onGraded={async (g, mode, ms) => {
            const ev = await recordReview(cardId, g, mode, ms);
            const after = getState().cards.get(cardId);
            const queue = [...session.queue];
            if (after && (after.state === 1 || after.state === 3) && after.due - Date.now() < 30 * 60000) {
              queue.splice(reinsertIndex(queue, session.pos + 1, after.due - Date.now()), 0, cardId);
            }
            setSession({
              ...session,
              queue,
              pos: session.pos + 1,
              done: session.done + 1,
              right: session.right + (g > 1 ? 1 : 0),
              last: { eventId: ev.id, queue: session.queue, pos: session.pos, done: session.done, right: session.right },
            });
          }}
        />
      ) : (
        <Finished session={session} onMore={() => setSession(null)} />
      )}
    </div>
  );
}

function Finished({ session, onMore }: { session: Session; onMore: () => void }) {
  const mins = Math.max(1, Math.round((Date.now() - session.started) / 60000));
  return (
    <div className="card">
      <h2>{session.done ? 'Session done' : 'Nothing due right now'}</h2>
      {session.done > 0 && (
        <p className="muted">
          {session.done} answers, {Math.round((session.right / session.done) * 100)}% remembered, {mins} min.
        </p>
      )}
      <div className="row">
        <a className="btn primary" href="#/today">
          Back to Today
        </a>
        <button type="button" className="btn" onClick={onMore}>
          Check for more
        </button>
      </div>
    </div>
  );
}

interface Answered {
  check?: Check;
  auto?: Grade;
  mode: Mode;
  note?: string;
}

function CardView({ cardId, fresh, onGraded }: { cardId: string; fresh: boolean; onGraded: (g: Grade, mode: string, ms: number) => void }) {
  const card = useApp((s) => s.cards.get(cardId));
  const note = useApp((s) => s.noteMap.get(noteOfCard(cardId)));
  const lang = useApp((s) => s.lang);
  const retention = useApp((s) => s.settings.retention);
  const start = useRef(Date.now());
  const type = card?.type ?? 'recog';
  const [mode, setModeState] = useState<Mode>(() => pref<Mode>(`mode.${type}`, DEFAULT_MODE[type] ?? 'reveal'));
  const [answered, setAnswered] = useState<Answered | null>(fresh ? { mode: 'reveal', note: 'New' } : null);

  const setMode = (m: Mode) => {
    setModeState(m);
    setPref(`mode.${type}`, m);
  };

  useEffect(() => {
    if (!note) return;
    if (type === 'listen' || (fresh && note.kind === 'vocab')) speak(note.hanzi);
  }, [note, type, fresh]);

  const grade = useCallback(
    (g: Grade) => onGraded(g, answered?.mode ?? mode, Date.now() - start.current),
    [onGraded, answered, mode],
  );

  // Keyboard: Space/Enter reveal or accept, 1–4 grade, A audio.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const typing = (e.target as HTMLElement)?.tagName === 'INPUT';
      if (e.key === 'a' && !typing && note) speak(note.hanzi);
      if (!answered) {
        if (!typing && (e.key === ' ' || e.key === 'Enter') && mode === 'reveal') {
          e.preventDefault();
          setAnswered({ mode: 'reveal' });
        }
        return;
      }
      if (typing) return;
      if (['1', '2', '3', '4'].includes(e.key)) grade(Number(e.key) as Grade);
      if ((e.key === ' ' || e.key === 'Enter') && answered.auto) {
        e.preventDefault();
        grade(answered.auto);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [answered, mode, grade, note]);

  if (!card || !note) return <p className="muted">This card is no longer in your list.</p>;

  const submitCheck = (m: Mode, check: Check) => {
    const auto = gradeFor(check.verdict, Date.now() - start.current);
    setAnswered({ check, auto, mode: m });
  };

  let front: React.ReactNode;
  let input: React.ReactNode = null;
  const modes = MODES[type];

  if (type === 'recog') {
    front = <GridWord text={note.hanzi} onClick={() => speak(note.hanzi)} />;
  } else if (type === 'recall') {
    front = (
      <div className="stack center">
        <Meaning note={note} className="prompt" />
        {note.tags.length > 0 && <span className="faint small">{note.tags.join(', ')} · {[...note.hanzi].length} character{[...note.hanzi].length > 1 ? 's' : ''}</span>}
      </div>
    );
  } else if (type === 'listen') {
    front = (
      <button type="button" className="btn" style={{ minHeight: 88, minWidth: 88, borderRadius: '50%' }} onClick={() => speak(note.hanzi)} aria-label="Play again">
        <Icon name="sound" />
      </button>
    );
  }

  if (!answered && modes) {
    if (mode.startsWith('type-')) {
      input = <TypeAnswer key={mode} kind={mode.slice(5) as 'pinyin' | 'hanzi' | 'meaning'} note={note} onCheck={(c) => submitCheck(mode, c)} />;
    } else if (mode.startsWith('write')) {
      input = (
        <WritePad
          word={note.hanzi}
          guided={mode === 'write-guided'}
          onDone={(r) => {
            const g = r.missing.length ? undefined : gradeWriting(r.mistakes, r.hints);
            setAnswered({
              mode,
              auto: g,
              check: { verdict: g === 3 ? 'right' : g === 2 ? 'tones' : g === 1 ? 'wrong' : 'near', expected: note.hanzi },
              note: r.missing.length ? 'No stroke data for some characters: grade yourself' : `${r.mistakes} mistake${r.mistakes === 1 ? '' : 's'}${r.hints ? ', outline shown' : ''}`,
            });
          }}
        />
      );
    } else {
      input = (
        <button type="button" className="btn primary block" onClick={() => setAnswered({ mode: 'reveal' })}>
          Show answer <span className="faint small">Space</span>
        </button>
      );
    }
  }

  if (type === 'grammar' || type === 'measure' || type === 'synonym') {
    return (
      <OtherCard
        card={card}
        note={note}
        fresh={fresh}
        answered={answered}
        onAnswer={(a) => setAnswered(a)}
        onGrade={grade}
        retention={retention}
        start={start.current}
      />
    );
  }

  return (
    <>
      <div className="card">
        {fresh && <span className="tag">New word</span>}
        {front}
        {!answered && modes && (
          <div className="modes" role="group" aria-label="Answer with">
            {modes.map((m) => (
              <button key={m} type="button" className="chip" aria-pressed={mode === m} onClick={() => setMode(m)}>
                {MODE_LABEL[m]}
              </button>
            ))}
          </div>
        )}
        {!answered && <div className="answer">{input}</div>}
        {answered && (
          <>
            {answered.check && <VerdictLine a={answered} lang={lang} />}
            {answered.note && !answered.check && answered.note !== 'New' && <p className="small muted">{answered.note}</p>}
            <VocabBack note={note} type={type} />
          </>
        )}
      </div>
      {answered && <GradeBar card={card} retention={retention} auto={answered.auto} onGrade={grade} />}
    </>
  );
}

function VerdictLine({ a, lang }: { a: Answered; lang: string }) {
  const c = a.check!;
  const text =
    c.verdict === 'right'
      ? 'Right'
      : c.verdict === 'tones'
        ? a.mode.startsWith('write')
          ? 'Almost'
          : 'Tones wrong'
        : c.verdict === 'near'
          ? 'Close: check it'
          : 'Not quite';
  return (
    <div className={`verdict ${c.verdict}`} role="status" lang={lang}>
      {text}
      {a.note ? ` · ${a.note}` : ''}
    </div>
  );
}

function TypeAnswer({ kind, note, onCheck }: { kind: 'pinyin' | 'hanzi' | 'meaning'; note: Note; onCheck: (c: Check) => void }) {
  const [v, setV] = useState('');
  const lang = useApp((s) => s.lang);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!coarse) ref.current?.focus();
  }, []);
  const submit = () => {
    if (kind === 'pinyin') onCheck(checkPinyin(v, note));
    else if (kind === 'hanzi') onCheck(checkHanzi(v, note));
    else {
      const both = pref<boolean>('acceptBoth', true);
      const m = meaning(note, lang).text;
      const other = meaning(note, lang === 'en' ? 'fr' : 'en').text;
      onCheck(checkMeaning(v, both ? [m, other] : [m]));
    }
  };
  const placeholder = kind === 'pinyin' ? 'peng2you or péngyou' : kind === 'hanzi' ? '汉字' : lang === 'fr' ? 'sens en français' : 'meaning in English';
  return (
    <form
      className="stack"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={ref}
        type="text"
        value={v}
        onChange={(e) => setV(e.target.value)}
        placeholder={placeholder}
        aria-label={`Type the ${kind}`}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        lang={kind === 'hanzi' ? 'zh-CN' : kind === 'meaning' ? lang : 'en'}
        enterKeyHint="done"
      />
      <div className="row">
        <button type="button" className="btn grow" onClick={() => onCheck({ verdict: 'wrong', expected: '' })}>
          I don't know
        </button>
        <button type="submit" className="btn primary grow">
          Check
        </button>
      </div>
    </form>
  );
}

export function VocabBack({ note, type }: { note: Note; type?: CardType }) {
  const all = useApp((s) => s.notes);
  const groupWords = useMemo(() => (note.group ? all.filter((n) => n.group === note.group && n.id !== note.id) : []), [all, note]);
  const [strokes, setStrokes] = useState(false);
  return (
    <div className="back">
      {type !== 'recog' && <GridWord text={note.hanzi} onClick={() => speak(note.hanzi)} />}
      <div className="row" style={{ justifyContent: 'center' }}>
        <Pinyin text={note.pinyin} className="big" />
        <AudioButton text={note.hanzi} />
      </div>
      <Meaning note={note} className="meaning" />
      {note.alts.length > 0 && (
        <p className="small muted">
          Also: <span className="zh">{note.alts.join('、')}</span>
        </p>
      )}
      {groupWords.length > 0 && (
        <p className="small muted">
          Related: <span className="zh">{groupWords.map((w) => w.hanzi).join('、')}</span>
        </p>
      )}
      {note.examples.map((ex, i) => (
        <div key={i} className="small">
          <span className="zh">{ex.zh}</span> {ex.pinyin && <span className="muted">{ex.pinyin}</span>} {ex.en && <span className="muted">· {ex.en}</span>}
        </div>
      ))}
      {note.notes.length > 0 && (
        <div className="notes">
          {note.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
      {strokes ? (
        <StrokeAnimation word={note.hanzi} size={120} />
      ) : (
        <button type="button" className="btn small ghost" onClick={() => setStrokes(true)}>
          <Icon name="pen" /> Stroke order
        </button>
      )}
    </div>
  );
}

export function GradeBar({ card, retention, auto, onGrade }: { card: CardState; retention: number; auto?: Grade; onGrade: (g: Grade) => void }) {
  const iv = useMemo(() => previewIntervals(card, Date.now(), retention), [card, retention]);
  const [changing, setChanging] = useState(false);
  if (auto && !changing) {
    return (
      <div className="dock">
        <div className="row">
          <button type="button" className="btn ghost small" onClick={() => setChanging(true)}>
            Change grade
          </button>
          <span className="grow small muted center">
            Graded {gradeName(auto)} · next in {formatInterval(iv[auto])}
          </span>
          <button type="button" className="btn primary" onClick={() => onGrade(auto)} autoFocus={!coarse}>
            Next
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="dock">
      <div className="grades" role="group" aria-label="How well did you remember?">
        {([1, 2, 3, 4] as Grade[]).map((g) => (
          <button key={g} type="button" className={`g${g} ${auto === g ? 'picked' : ''}`} onClick={() => onGrade(g)} title={`${gradeName(g)} (${g})`}>
            {gradeName(g)}
            <small>{formatInterval(iv[g])}</small>
          </button>
        ))}
      </div>
    </div>
  );
}

// ---- grammar, measure words, near-synonyms -------------------------------------------

function seeded<T>(list: T[], seed: string): T[] {
  return [...list].sort((a, b) => (fnv1a(seed + JSON.stringify(a)) < fnv1a(seed + JSON.stringify(b)) ? -1 : 1));
}

function segment(zh: string): string[] {
  const words =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? [...new Intl.Segmenter('zh', { granularity: 'word' }).segment(zh)].map((s) => s.segment)
      : [...zh];
  const out: string[] = [];
  for (const w of words) {
    if (!w.trim()) continue;
    if (!HAN.test(w) && out.length) out[out.length - 1] += w;
    else out.push(w);
  }
  return out.length >= 3 ? out : [...zh].filter((c) => c.trim());
}

function OtherCard({
  card,
  note,
  fresh,
  answered,
  onAnswer,
  onGrade,
  retention,
  start,
}: {
  card: CardState;
  note: Note;
  fresh: boolean;
  answered: Answered | null;
  onAnswer: (a: Answered) => void;
  onGrade: (g: Grade) => void;
  retention: number;
  start: number;
}) {
  const notes = useApp((s) => s.notes);
  const ex = note.examples.find((e) => e.zh.includes(note.hanzi)) ?? note.examples[0];
  const drill: 'build' | 'choice' | 'explain' = useMemo(() => {
    if (note.kind === 'grammar') return ex && segment(ex.zh).length >= 3 && card.reps % 2 === 0 ? 'build' : 'explain';
    if (ex && ex.zh.includes(note.hanzi)) return 'choice';
    return 'explain';
  }, [note, ex, card.reps]);

  const options = useMemo(() => {
    if (drill !== 'choice') return [];
    const pool = notes.filter((n) => n.kind === note.kind && n.id !== note.id && (note.kind !== 'synonym' || n.set === note.set) && !ex.zh.includes(n.hanzi));
    const others = seeded(pool, card.id + card.reps).slice(0, 3).map((n) => n.hanzi);
    return seeded([note.hanzi, ...others], card.id);
  }, [drill, notes, note, ex, card.id, card.reps]);

  const [picked, setPicked] = useState<string | null>(null);
  const showAnswer = answered || fresh;

  let front: React.ReactNode;
  if (drill === 'choice' && ex) {
    const parts = ex.zh.split(note.hanzi);
    front = (
      <div className="stack center">
        <p className="sentence">
          {parts.map((p, i) => (
            <span key={i}>
              {p}
              {i < parts.length - 1 && (showAnswer ? <b className="zh" style={{ color: 'var(--jade)' }}>{note.hanzi}</b> : <span className="blank" aria-label="blank" />)}
            </span>
          ))}
        </p>
        {ex.en && <p className="muted">{ex.en}</p>}
        {!showAnswer && <p className="small faint">{note.kind === 'measure' ? 'Which measure word fits?' : 'Which word fits?'}</p>}
      </div>
    );
  } else if (drill === 'build' && ex) {
    front = <SentenceBuilder key={card.id} zh={ex.zh} prompt={note} done={!!showAnswer} onDone={(ok) => onAnswer({ mode: 'build', check: { verdict: ok ? 'right' : 'wrong', expected: ex.zh }, auto: gradeFor(ok ? 'right' : 'wrong', Date.now() - start) })} />;
  } else {
    front = (
      <div className="stack center">
        {note.kind === 'grammar' ? <p className="sentence">{note.hanzi}</p> : <GridWord text={note.hanzi} onClick={() => speak(note.hanzi)} />}
        {note.kind === 'grammar' && !note.examples.length && <span className="tag">Needs an example</span>}
        {!showAnswer && <p className="small faint">{note.kind === 'grammar' ? 'What does it mean, how is it used?' : 'What is it used for?'}</p>}
      </div>
    );
  }

  return (
    <>
      <div className="card">
        {fresh && <span className="tag">New {note.kind === 'grammar' ? 'grammar point' : note.kind === 'measure' ? 'measure word' : 'word'}</span>}
        {front}
        {!showAnswer && drill === 'choice' && (
          <div className="choices">
            {options.map((o) => (
              <button
                key={o}
                type="button"
                className={picked ? (o === note.hanzi ? 'right' : o === picked ? 'wrong' : '') : ''}
                onClick={() => {
                  setPicked(o);
                  const ok = o === note.hanzi;
                  speak(ex!.zh);
                  onAnswer({ mode: 'choice', check: { verdict: ok ? 'right' : 'wrong', expected: note.hanzi }, auto: gradeFor(ok ? 'right' : 'wrong', Date.now() - start) });
                }}
              >
                {o}
              </button>
            ))}
          </div>
        )}
        {!showAnswer && drill === 'explain' && (
          <div className="answer">
            <button type="button" className="btn primary block" onClick={() => onAnswer({ mode: 'reveal' })}>
              Show answer
            </button>
          </div>
        )}
        {answered?.check && <VerdictLine a={answered} lang="en" />}
        {showAnswer && <OtherBack note={note} />}
      </div>
      {showAnswer && <GradeBar card={card} retention={retention} auto={answered?.auto} onGrade={onGrade} />}
    </>
  );
}

function OtherBack({ note }: { note: Note }) {
  return (
    <div className="back">
      {note.kind === 'grammar' ? (
        <>
          <p className="sentence">{note.hanzi}</p>
          {note.alts.length > 0 && <p className="small muted zh">{note.alts.join('、')}</p>}
        </>
      ) : (
        <div className="row" style={{ justifyContent: 'center' }}>
          <span className="zh" style={{ fontSize: '2rem' }}>{note.hanzi}</span>
          <Pinyin text={note.pinyin} className="big" />
          <AudioButton text={note.hanzi} />
        </div>
      )}
      <Meaning note={note} className="meaning" />
      {note.extra?.tone && <p className="small muted">Tone: {note.extra.tone}</p>}
      {note.extra?.related && <p className="small muted">Opposite / related: <span className="zh">{note.extra.related}</span></p>}
      {note.extra?.tip && <p className="small">{note.extra.tip}</p>}
      {note.examples.map((ex, i) => (
        <div key={i} className="small">
          <span className="zh" style={{ fontSize: '1.1rem' }}>{ex.zh}</span> <AudioButton text={ex.zh} label="Play sentence" />
          <div className="muted">{ex.pinyin}</div>
          {ex.en && <div className="muted">{ex.en}</div>}
        </div>
      ))}
    </div>
  );
}

function SentenceBuilder({ zh, prompt, done, onDone }: { zh: string; prompt: Note; done: boolean; onDone: (ok: boolean) => void }) {
  const tokens = useMemo(() => segment(zh), [zh]);
  const shuffled = useMemo(() => {
    let s = seeded(tokens.map((t, i) => ({ t, i })), zh + Date.now());
    if (s.every((x, k) => x.i === k)) s = [...s].reverse();
    return s;
  }, [tokens, zh]);
  const [placed, setPlaced] = useState<number[]>([]);
  useEffect(() => {
    if (placed.length === tokens.length && !done) {
      const built = placed.map((k) => shuffled[k].t).join('');
      onDone(built === tokens.join(''));
    }
  }, [placed, tokens, shuffled, done, onDone]);
  const lang = useApp((s) => s.lang);
  return (
    <div className="stack center" style={{ width: '100%' }}>
      <p className="muted">{meaning(prompt, lang).text}</p>
      <p className="zh muted">{prompt.hanzi}</p>
      <div className="tiles target" aria-label="Your sentence">
        {placed.map((k, j) => (
          <button key={j} type="button" className="tile" onClick={() => !done && setPlaced(placed.filter((_, x) => x !== j))}>
            {shuffled[k].t}
          </button>
        ))}
      </div>
      {!done && (
        <div className="tiles" aria-label="Words to place">
          {shuffled.map((x, k) =>
            placed.includes(k) ? null : (
              <button key={k} type="button" className="tile placed" onClick={() => setPlaced([...placed, k])}>
                {x.t}
              </button>
            ),
          )}
        </div>
      )}
      {done && <p className="sentence">{zh}</p>}
    </div>
  );
}
