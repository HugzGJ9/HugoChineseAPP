// Grammar points, measure words and near-synonyms: choice, sentence builder or explain.
import { useEffect, useMemo, useState } from 'react';
import type { CardState, Grade, Note } from '../../lib/types';
import { meaning, useApp } from '../../lib/store';
import { gradeFor } from '../../lib/engine/grade';
import { speak } from '../../lib/speech';
import { AudioButton, GridWord, Meaning, Pinyin } from '../common';
import { GradeBar } from './GradeBar';
import { VerdictLine, seeded, segment, type Answered } from './shared';

export function OtherCard({
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
