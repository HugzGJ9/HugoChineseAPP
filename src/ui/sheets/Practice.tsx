// Writing area for one row: type pinyin or hanzi, draw stroke by stroke, or use a free pad.
// Practice never records review events and never changes the status by itself.
import { useEffect, useRef, useState } from 'react';
import type { Note } from '../../lib/types';
import { checkHanzi, checkPinyin, type Check } from '../../lib/engine/grade';
import { AudioButton, Meaning, Pinyin, Segmented } from '../common';
import { StrokeAnimation, WritePad, type WriteResult } from '../WritePad';
import { Shell } from '../panel';
import { ScratchPad } from './ScratchPad';
import './practice.css';

type Mode = 'pinyin' | 'hanzi' | 'draw' | 'free';
const MODE_LABEL: Record<Mode, string> = { pinyin: 'Pinyin', hanzi: 'Hanzi', draw: 'Draw', free: 'Free pad' };

function verdictText(c: Check): string {
  return c.verdict === 'right' ? 'Right' : c.verdict === 'tones' ? 'Right letters but wrong tones' : c.verdict === 'near' ? 'Almost' : 'Not quite';
}

export function ScratchPanel({ onClose }: { onClose: () => void }) {
  return (
    <Shell title="Scratch pad" label="Scratch pad" onClose={onClose} className="pp-scratch">
      <ScratchPad height={320} />
    </Shell>
  );
}

/** The Practise tab: type pinyin or hanzi, draw, or a free pad. */
export function PracticeBody({ note }: { note: Note }) {
  const grammar = note.kind === 'grammar';
  const modes: Mode[] = grammar ? ['free'] : ['pinyin', 'hanzi', 'draw', 'free'];
  const [mode, setMode] = useState<Mode>(modes[0]);
  return (
    <>
      {modes.length > 1 && (
        <Segmented label="Practice mode" className="pp-modes" value={mode} onChange={setMode} options={modes.map((m) => ({ value: m, label: MODE_LABEL[m] }))} />
      )}
      {mode === 'pinyin' && <TypeMode key={`p${note.id}`} kind="pinyin" note={note} />}
      {mode === 'hanzi' && <TypeMode key={`h${note.id}`} kind="hanzi" note={note} />}
      {mode === 'draw' && <DrawMode key={`d${note.id}`} note={note} />}
      {mode === 'free' && <ScratchPad height={grammar ? 300 : 260} />}
    </>
  );
}

function TypeMode({ kind, note }: { kind: 'pinyin' | 'hanzi'; note: Note }) {
  const [v, setV] = useState('');
  const [check, setCheck] = useState<Check | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const coarse = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  useEffect(() => {
    if (!coarse) input.current?.focus();
  }, [coarse]);

  const submit = () => setCheck(kind === 'pinyin' ? checkPinyin(v, note) : checkHanzi(v, note));
  const again = () => {
    setV('');
    setCheck(null);
    input.current?.focus();
  };

  return (
    <form
      className="pp-type"
      onSubmit={(e) => {
        e.preventDefault();
        if (check) again();
        else submit();
      }}
    >
      <div className="pp-card pp-prompt">
        {kind === 'pinyin' ? <span className="pp-hanzi" lang="zh-CN">{note.hanzi}</span> : <Pinyin text={note.pinyin} className="pp-bigpy" />}
        <Meaning note={note} className="pp-mn" />
      </div>
      <input
        ref={input}
        className="pp-input"
        type="text"
        value={v}
        onChange={(e) => {
          setV(e.target.value);
          if (check) setCheck(null);
        }}
        placeholder={kind === 'pinyin' ? 'peng2you or péngyou' : '汉字'}
        aria-label={kind === 'pinyin' ? 'Type the pinyin' : 'Type the hanzi'}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        spellCheck={false}
        lang={kind === 'hanzi' ? 'zh-CN' : 'en'}
        enterKeyHint="done"
      />
      {check && (
        <>
          <div className={`pp-verdict verdict ${check.verdict}`} role="status">
            {verdictText(check)}
          </div>
          <div className="pp-card pp-answer">
            <span className="pp-hanzi" lang="zh-CN">{note.hanzi}</span>
            <Pinyin text={note.pinyin} />
            <AudioButton text={note.hanzi} />
          </div>
        </>
      )}
      <div className="pp-actions">
        <button type="button" className="btn grow" onClick={() => (check ? again() : setCheck({ verdict: 'wrong', expected: kind === 'pinyin' ? note.pinyin : note.hanzi }))}>
          {check ? 'Try again' : 'Show answer'}
        </button>
        {!check && (
          <button type="submit" className="btn primary grow">
            Check
          </button>
        )}
      </div>
    </form>
  );
}

function DrawMode({ note }: { note: Note }) {
  const [guided, setGuided] = useState(true);
  const [run, setRun] = useState(0);
  const [result, setResult] = useState<WriteResult | { revealed: true } | null>(null);
  const done = result !== null;
  const stats = result && 'mistakes' in result ? result : null;

  const restart = () => {
    setResult(null);
    setRun((r) => r + 1);
  };

  return (
    <div className="pp-draw">
      <div className="pp-card pp-prompt">
        <Pinyin text={note.pinyin} className="pp-bigpy" />
        <Meaning note={note} className="pp-mn" />
      </div>
      <Segmented
        label="Outline"
        className="pp-outline"
        value={guided ? 'on' : 'off'}
        onChange={(v) => {
          setGuided(v === 'on');
          restart();
        }}
        options={[
          { value: 'on', label: 'Outline on' },
          { value: 'off', label: 'Outline off' },
        ]}
      />
      {!done && <WritePad key={`${run}-${guided}`} word={note.hanzi} guided={guided} onDone={setResult} onSkip={() => setResult({ revealed: true })} />}
      {done && (
        <>
          <div className={`pp-verdict verdict ${stats ? (stats.mistakes === 0 && !stats.hints ? 'right' : 'tones') : 'near'}`} role="status">
            {stats
              ? stats.missing.length
                ? 'Done. No stroke data for some characters.'
                : `Done: ${stats.mistakes} mistake${stats.mistakes === 1 ? '' : 's'}${stats.hints ? ', outline shown' : ''}`
              : 'Answer shown'}
          </div>
          <div className="pp-card pp-answer pp-answer-col">
            <div className="pp-answer">
              <span className="pp-hanzi" lang="zh-CN">{note.hanzi}</span>
              <AudioButton text={note.hanzi} />
            </div>
            <StrokeAnimation word={note.hanzi} size={110} />
          </div>
          <button type="button" className="btn block" onClick={restart}>
            Try again
          </button>
        </>
      )}
    </div>
  );
}
