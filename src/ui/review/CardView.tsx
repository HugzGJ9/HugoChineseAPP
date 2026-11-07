// One card: front, Type / Write / Reveal answers, verdict, back and grade bar.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CardType, Grade, Note } from '../../lib/types';
import { meaning, useApp } from '../../lib/store';
import { noteOfCard } from '../../lib/engine/schedule';
import { checkHanzi, checkMeaning, checkPinyin, gradeFor, gradeWriting, type Check } from '../../lib/engine/grade';
import { pref, setPref } from '../../lib/db';
import { speak } from '../../lib/speech';
import { GridWord, Icon, Meaning } from '../common';
import { WritePad } from '../WritePad';
import { GradeBar } from './GradeBar';
import { OtherCard } from './OtherCard';
import { VocabBack } from './VocabBack';
import { VerdictLine, coarse, type Answered, type Mode } from './shared';

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

export function CardView({ cardId, fresh, onGraded }: { cardId: string; fresh: boolean; onGraded: (g: Grade, mode: string, ms: number) => void }) {
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

  // Keyboard: Space/Enter reveal or accept, 1–4 grade, A audio. Held keys (repeat) are ignored.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat) return;
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
          onSkip={(kind) =>
            kind === 'unknown'
              ? setAnswered({ mode, auto: 1, check: { verdict: 'wrong', expected: note.hanzi }, note: "Didn't know" })
              : setAnswered({ mode })
          }
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
