// A Chinese line in the word sheet (plan 2026-11-23 D1, D2): every Han word is a button that opens that word, and a
// pinyin line sits under it unless the chip is off. ZhText = the tappable text; ZhBlock = text, audio, pinyin, translation.
import { useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { pref, setPref } from '../../lib/db';
import { examplePinyin, type KnownReadings } from '../../lib/lexicon';
import { lineTokens } from '../../lib/sentence';
import { AudioButton } from '../common';
import { useWordNav } from './nav';
import { useVocab } from './vocab';
import './word.css';

const PY_OFF = 'ex.pyOff'; // device-only; a new key so the new default (on) reaches every device

const listeners = new Set<() => void>();
let shown = !pref<boolean>(PY_OFF, false);

/** The Pinyin chip's state. One store, so every mounted level follows it. */
export function usePinyinShown(): [boolean, (shown: boolean) => void] {
  const v = useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => shown,
    () => true,
  );
  return [v, (s) => {
    shown = s;
    setPref(PY_OFF, !s);
    listeners.forEach((l) => l());
  }];
}

export function PinyinChip() {
  const [on, set] = usePinyinShown();
  return (
    <button type="button" className="chip wx-pychip" aria-pressed={on} onClick={() => set(!on)}>
      Pinyin
    </button>
  );
}

export function ZhText({ zh, head, pattern }: { zh: string; head?: string[]; pattern?: string }) {
  const { index, statuses } = useVocab();
  const nav = useWordNav();
  const headKey = head?.join('|') ?? '';
  const tokens = useMemo(
    () => lineTokens(zh, index, { head: head?.length ? head : undefined, pattern }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [zh, index, headKey, pattern],
  );
  return (
    <span className="zt zh" lang="zh-CN">
      {tokens.map((t, i) =>
        t.word && nav ? (
          <button
            key={i}
            type="button"
            className={`zt-w${t.note ? ` mine st-${statuses.get(t.note) ?? 'new'}` : ''}${t.head ? ' head' : ''}${t.pattern ? ' pat' : ''}`}
            onClick={() => nav.open({ t: 'line', zh, start: t.start, length: [...t.s].length })}
          >
            {t.s}
          </button>
        ) : (
          <span key={i}>{t.s}</span>
        ),
      )}
    </span>
  );
}

/** Pinyin for a line: the given one, else computed on the device (offline). */
function useLinePinyin(zh: string, given: string | undefined, want: boolean): string {
  const [text, setText] = useState('');
  const { index, byId } = useVocab();
  // Multi-character words of his list read as in his list (péngyou, not péngyǒu).
  const known = useMemo<KnownReadings>(
    () => ({ get: (w) => { const id = index.forms.get(w); return id ? byId.get(id)?.pinyinNum : undefined; }, max: index.max }),
    [index, byId],
  );
  useEffect(() => {
    if (given || !want) return;
    let live = true;
    examplePinyin(zh, known).then((t) => live && setText(t), () => {});
    return () => {
      live = false;
    };
  }, [zh, given, want, known]);
  return given || text;
}

export function ZhBlock({
  zh, pinyin, tr, trLang, trTag, head, pattern, audio = true, mark, children,
}: {
  zh: string; pinyin?: string; tr?: ReactNode; trLang?: string; trTag?: string; head?: string[]; pattern?: string;
  audio?: boolean; mark?: 'wrong' | 'right'; children?: ReactNode;
}) {
  const [on] = usePinyinShown();
  const py = useLinePinyin(zh, pinyin, on);
  return (
    <div className={`zb${mark ? ` ${mark === 'wrong' ? 'wx-wrong' : 'wx-right'}` : ''}`}>
      <div className="zb-zh">
        {mark && <span className="zb-mark" aria-label={mark === 'wrong' ? 'Wrong' : 'Right'}>{mark === 'wrong' ? '✗' : '✓'} </span>}
        <ZhText zh={zh} head={head} pattern={pattern} />
      </div>
      {audio && !mark && <AudioButton text={zh} label="Play sentence" />}
      {on && py && <div className="wx-py zb-py">{py}</div>}
      {tr != null && tr !== '' && (
        <div className="wx-tr zb-tr" lang={trLang}>
          {trTag && <span className="tag">{trTag}</span>} {tr}
        </div>
      )}
      {children}
    </div>
  );
}
