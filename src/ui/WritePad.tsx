// Handwritten answers with Hanzi Writer: one practice square per character.
// Guided: outline shown, hint after 3 misses. Free: blank square, write from memory.
import { useEffect, useRef, useState } from 'react';
import HanziWriter from 'hanzi-writer';
import { charDataLoader } from '../lib/strokes';
import { HAN } from '../lib/pinyin';
import './writepad.css';

export interface WriteResult {
  mistakes: number;
  hints: number;
  /** Characters with no stroke data (checked by eye instead). */
  missing: string[];
}

function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

export function WritePad({
  word,
  guided,
  onDone,
  onSkip,
}: {
  word: string;
  guided: boolean;
  onDone: (r: WriteResult) => void;
  /** "I don't know" (caller grades Again) or "Show answer" (caller lets the user grade). */
  onSkip?: (kind: 'unknown' | 'reveal') => void;
}) {
  const chars = [...word].filter((c) => HAN.test(c));
  const [index, setIndex] = useState(0);
  const [mistakes, setMistakes] = useState<number[]>(() => chars.map(() => 0));
  const [, setHint] = useState(0);
  const [missing, setMissing] = useState<string[]>([]);
  const host = useRef<HTMLDivElement>(null);
  const writer = useRef<HanziWriter | null>(null);
  const totals = useRef({ mistakes: 0, hints: 0, missing: [] as string[] });

  useEffect(() => {
    totals.current = { mistakes: 0, hints: 0, missing: [] };
    setIndex(0);
    setMistakes(chars.map(() => 0));
    setMissing([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, guided]);

  useEffect(() => {
    const el = host.current;
    if (!el || index >= chars.length) return;
    el.innerHTML = '';
    let timer: ReturnType<typeof setTimeout> | undefined;
    const size = el.clientWidth || 220;
    const ch = chars[index];
    const w = HanziWriter.create(el, ch, {
      width: size,
      height: size,
      padding: Math.round(size * 0.06),
      showCharacter: false,
      showOutline: guided,
      strokeColor: cssVar('--ink', '#1b231f'),
      outlineColor: cssVar('--line', '#cad6cd'),
      drawingColor: cssVar('--ink', '#1b231f'),
      highlightColor: cssVar('--blue', '#2f5fb3'),
      drawingWidth: Math.max(14, Math.round(size / 14)),
      charDataLoader,
      onLoadCharDataError: () => {
        totals.current.missing.push(ch);
        setMissing((m) => [...m, ch]);
        next();
      },
    });
    writer.current = w;
    w.quiz({
      showHintAfterMisses: guided ? 3 : false,
      leniency: guided ? 1.1 : 1.25,
      onMistake: (s) => {
        totals.current.mistakes++;
        setMistakes((m) => m.map((x, i) => (i === index ? s.totalMistakes : x)));
        if (guided && s.mistakesOnStroke === 3) totals.current.hints++;
      },
      onComplete: () => {
        timer = setTimeout(next, 350);
      },
    });
    function next() {
      if (index + 1 >= chars.length) onDone({ ...totals.current, missing: totals.current.missing });
      else setIndex(index + 1);
    }
    return () => {
      clearTimeout(timer);
      writer.current = null;
      try {
        w.cancelQuiz();
      } catch {
        // already finished
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [index, word, guided]);

  const giveHint = () => {
    const w = writer.current;
    if (!w) return;
    totals.current.hints++;
    setHint((h) => h + 1);
    w.showOutline();
  };

  return (
    <div className="pad">
      <div className="pad-cells" aria-hidden={chars.length > 1 ? undefined : true}>
        {chars.length > 1 &&
          chars.map((c, i) => (
            <div key={i} className={`pad-cell small ${i === index ? 'active' : ''} ${i < index ? 'done' : ''}`}>
              {i < index && <span className="grid-cell" style={{ ['--cell' as string]: '61px', border: 0 }}>{c}</span>}
              {mistakes[i] > 0 && <span className="mist">{mistakes[i]}</span>}
            </div>
          ))}
      </div>
      <div className="pad-cell" ref={host} role="application" aria-label={`Write character ${index + 1} of ${chars.length}`} />
      <div className="row">
        <span className="small muted">
          Character {Math.min(index + 1, chars.length)} of {chars.length}
          {mistakes[index] ? ` · ${mistakes[index]} mistake${mistakes[index] > 1 ? 's' : ''}` : ''}
          {missing.length ? ` · no stroke data for ${missing.join('')}` : ''}
        </span>
        {!guided && (
          <button type="button" className="btn small ghost" onClick={giveHint}>
            Show outline
          </button>
        )}
      </div>
      {onSkip && (
        <div className="row">
          <button type="button" className="btn grow" onClick={() => onSkip('unknown')}>
            I don't know
          </button>
          <button type="button" className="btn grow" onClick={() => onSkip('reveal')}>
            Show answer
          </button>
        </div>
      )}
    </div>
  );
}

/** Stroke-order animation for a word, character by character. */
export function StrokeAnimation({ word, size = 150 }: { word: string; size?: number }) {
  const chars = [...word].filter((c) => HAN.test(c));
  const refs = useRef<(HTMLDivElement | null)[]>([]);
  useEffect(() => {
    const writers: HanziWriter[] = [];
    let cancelled = false;
    chars.forEach((ch, i) => {
      const el = refs.current[i];
      if (!el) return;
      el.innerHTML = '';
      writers.push(
        HanziWriter.create(el, ch, {
          width: size,
          height: size,
          padding: 8,
          showOutline: true,
          showCharacter: false,
          strokeColor: cssVar('--ink', '#1b231f'),
          outlineColor: cssVar('--line', '#cad6cd'),
          radicalColor: cssVar('--seal', '#b8322a'),
          delayBetweenStrokes: 120,
          charDataLoader,
        }),
      );
    });
    (async () => {
      for (const w of writers) {
        if (cancelled) return;
        await w.animateCharacter();
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [word, size]);
  return (
    <div className="pad-cells">
      {chars.map((c, i) => (
        <div key={i} className="pad-cell" style={{ ['--pad' as string]: `${size}px` }} ref={(el) => void (refs.current[i] = el)} aria-label={`Stroke order of ${c}`} />
      ))}
    </div>
  );
}
