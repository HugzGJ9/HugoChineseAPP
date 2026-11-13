// Everything about one word: his meaning, dictionary senses, Claude's explanation (on demand) and real example sentences.
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import type { Note } from '../../lib/types';
import { useApp, type Lang } from '../../lib/store';
import { pref, setPref } from '../../lib/db';
import { speak } from '../../lib/speech';
import { examplePinyin, formatSense, lookupWord, sensesText, type DictSense, type ExampleSentence, type Lookup } from '../../lib/lexicon';
import {
  ClaudeError, explainJob, getExplanation, onExplainChange, requestExplanation,
  type ExplainEntry, type Explanation,
} from '../../lib/explain';
import { formatDate, Icon, Meaning, Pinyin } from '../common';
import './word.css';

const FIRST = 6;
const PY_PREF = 'ex.py';

function errorText(e: unknown): ReactNode {
  if (!(e instanceof ClaudeError)) return 'Something went wrong. Try again.';
  switch (e.kind) {
    case 'nokey': return <>Add your Claude API key in <a href="#/settings">Settings</a> to get explanations.</>;
    case 'offline': return 'Needs a connection. Explanations you already have still show.';
    case 'key': return <>Claude refused the API key. Check it in <a href="#/settings">Settings</a>.</>;
    case 'credit': return 'Your Anthropic credit is used up. Add credit in the Anthropic Console.';
    case 'model': return "This key can't use the model.";
    case 'rate': return e.retryAfter ? `Too many requests. Try again in ${e.retryAfter} s.` : 'Too many requests. Try again in a minute.';
    case 'busy': return 'Claude is busy. Try again in a minute.';
    case 'network': return 'Claude could not be reached. Check the connection.';
    case 'timeout': return 'Claude took too long. Try again.';
    case 'invalid': return 'The answer could not be read. Try again.';
    default: return 'Something went wrong. Try again.';
  }
}

function useOnline(): boolean {
  const [on, setOn] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const up = () => setOn(true);
    const down = () => setOn(false);
    window.addEventListener('online', up);
    window.addEventListener('offline', down);
    return () => {
      window.removeEventListener('online', up);
      window.removeEventListener('offline', down);
    };
  }, []);
  return on;
}

export function ExplainView({ note, inline = false }: { note: Note; inline?: boolean }) {
  const lang = useApp((s) => s.lang);
  const online = useOnline();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const [py, setPyState] = useState<boolean>(() => pref<boolean>(PY_PREF, false));
  const setPy = (v: boolean) => {
    setPyState(v);
    setPref(PY_PREF, v);
  };

  useEffect(() => {
    let live = true;
    setLookup(null);
    lookupWord(note.hanzi, note.pinyinNum, note.alts).then(
      (r) => live && setLookup(r),
      () => live && setLookup({ ok: false, reason: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [note.id, note.hanzi, note.pinyinNum, note.alts]);

  return (
    <div className={`wx ${inline ? 'inline' : ''}`}>
      <section className="wx-sec" aria-label="Your list">
        <h3 className="wx-h">Your list</h3>
        <div className="wx-card wx-pad wx-mine">
          <Meaning note={note} />
        </div>
      </section>
      <DictionarySection lookup={lookup} lang={lang} />
      <ClaudeSection note={note} lang={lang} online={online} lookup={lookup} py={py} setPy={setPy} />
      <ExamplesSection lookup={lookup} lang={lang} py={py} setPy={setPy} />
    </div>
  );
}

/* ---- Dictionary ---- */

function DictionarySection({ lookup, lang }: { lookup: Lookup | null; lang: Lang }) {
  const [all, setAll] = useState(false);
  return (
    <section className="wx-sec" aria-label="Dictionary">
      <h3 className="wx-h">Dictionary</h3>
      {!lookup ? (
        <p className="wx-card wx-pad wx-dim" aria-busy="true">Loading…</p>
      ) : !lookup.ok ? (
        <p className="wx-card wx-pad wx-dim">
          {lookup.reason === 'nodata'
            ? "The dictionary isn't included in this version."
            : lookup.reason === 'offline'
              ? 'The dictionary is not on this device yet. Connect once to download it.'
              : "Couldn't read the dictionary."}
        </p>
      ) : (
        <DictBody info={lookup.info} lang={lang} all={all} onAll={() => setAll(true)} />
      )}
    </section>
  );
}

function DictBody({ info, lang, all, onAll }: { info: { en: DictSense[]; fr: DictSense[] }; lang: Lang; all: boolean; onAll: () => void }) {
  const useFr = lang === 'fr' && info.fr.length > 0;
  const list = useFr ? info.fr : info.en;
  const primary = list.filter((d) => d.match !== 'other');
  const other = list.filter((d) => d.match === 'other');
  // Measure words are listed in English entries only.
  const measure = [...info.en, ...info.fr].filter((d) => d.match !== 'other').flatMap((d) => d.measure);
  const measureUniq = measure.filter((m, i) => measure.findIndex((x) => x.hanzi === m.hanzi) === i);
  const total = primary.reduce((n, d) => n + d.senses.length, 0);
  let budget = all ? Infinity : FIRST;

  if (list.length === 0) return <p className="wx-card wx-pad wx-dim">No dictionary entry for this word.</p>;
  return (
    <div className="wx-card">
      {lang === 'fr' && !useFr && <p className="wx-row wx-note"><span className="tag">EN</span> No French entry in CFDICT.</p>}
      {primary.map((d, i) => {
        const take = Math.max(0, Math.min(d.senses.length, budget));
        budget -= take;
        if (take === 0) return null;
        return (
          <div key={i} className="wx-row wx-reading">
            {primary.length > 1 && <Pinyin text={d.pinyin} className="wx-rpy" />}
            <ol className="wx-senses" lang={useFr ? 'fr' : 'en'}>
              {d.senses.slice(0, take).map((s, k) => (
                <li key={k}>{formatSense(s)}</li>
              ))}
            </ol>
          </div>
        );
      })}
      {!all && total > FIRST && (
        <button type="button" className="wx-row wx-action" onClick={onAll}>
          Show all {total} senses
          <Icon name="chevron-down" />
        </button>
      )}
      {measureUniq.length > 0 && (
        <div className="wx-row wx-measure">
          <span className="wx-label">Measure words</span>
          <div className="wx-chips">
            {measureUniq.map((m) => (
              <span key={m.hanzi} className="wx-chip">
                <span className="zh" lang="zh-CN">{m.hanzi}</span> <span className="muted">{m.pinyin}</span>
              </span>
            ))}
          </div>
        </div>
      )}
      {other.length > 0 && (
        <details className="wx-row wx-other">
          <summary>
            <span className="grow">Other readings ({other.length})</span>
            <Icon name="chevron" className="wx-chev" />
          </summary>
          {other.map((d, i) => (
            <div key={i} className="wx-reading">
              <Pinyin text={d.pinyin} className="wx-rpy" />
              <ol className="wx-senses" lang={useFr ? 'fr' : 'en'}>
                {d.senses.map((s, k) => (
                  <li key={k}>{formatSense(s)}</li>
                ))}
              </ol>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}

/* ---- Claude ---- */

function PyChip({ on, set }: { on: boolean; set: (v: boolean) => void }) {
  return (
    <button type="button" className="chip wx-pychip" aria-pressed={on} onClick={() => set(!on)}>
      Pinyin
    </button>
  );
}

function ClaudeSection({ note, lang, online, lookup, py, setPy }: { note: Note; lang: Lang; online: boolean; lookup: Lookup | null; py: boolean; setPy: (v: boolean) => void }) {
  const other: Lang = lang === 'en' ? 'fr' : 'en';
  const [tick, setTick] = useState(0);
  const [entry, setEntry] = useState<ExplainEntry | null>(null);
  const [fallback, setFallback] = useState<ExplainEntry | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => onExplainChange(() => setTick((t) => t + 1)), []);
  useEffect(() => {
    let live = true;
    Promise.all([getExplanation(note, lang), getExplanation(note, other)]).then(
      ([a, b]) => {
        if (!live) return;
        setEntry(a);
        setFallback(a ? null : b);
      },
      () => {},
    );
    return () => {
      live = false;
    };
  }, [note, lang, other, tick]);
  useEffect(() => setError(null), [note.id, lang]);

  const job = explainJob(note, lang);
  const running = busy || (!!job && !job.error);
  const shownError = error ?? job?.error ?? null;

  const ask = useCallback(
    async (again: boolean) => {
      setError(null);
      setBusy(true);
      try {
        const e = await requestExplanation(note, lang, { again, dict: lookup?.ok ? sensesText(lookup.info.en) : undefined });
        setEntry(e);
        setFallback(null);
      } catch (err) {
        setError(err);
      } finally {
        setBusy(false);
      }
    },
    [note, lang, lookup],
  );

  const shown = entry ?? fallback;
  const dev = shown ? (shown as ExplainEntry & { dev?: string }).dev : undefined;
  const progress = job ? Math.min(0.95, job.chars / 4500) : 0;

  return (
    <section className="wx-sec" aria-label="Claude's explanation">
      <div className="wx-sech">
        <h3 className="wx-h">Claude's explanation</h3>
        {shown && <PyChip on={py} set={setPy} />}
      </div>
      {shown && (
        <>
          {!entry && fallback && (
            <p className="wx-foot">
              In {fallback.lang === 'fr' ? 'French' : 'English'} ·{' '}
              <button type="button" className="wx-link" onClick={() => void ask(false)} disabled={running || !online}>
                Explain in {lang === 'fr' ? 'French' : 'English'}
              </button>
            </p>
          )}
          <ExplanationBody x={shown.x} lang={shown.lang} py={py} />
          <p className="wx-foot">
            Claude · {formatDate(shown.at)}
            {dev ? ` · ${dev}` : ''}
          </p>
        </>
      )}
      {running && (
        <div className="wx-run" role="status">
          <div className="progress" aria-hidden="true">
            <i style={{ width: `${Math.round(Math.max(0.04, progress) * 100)}%` }} />
          </div>
          <span className="wx-foot">Asking Claude…</span>
        </div>
      )}
      {shownError != null && !running && (
        <div className="wx-err" role="alert">
          <span>{errorText(shownError)}</span>
          {!(shownError instanceof ClaudeError && shownError.kind === 'nokey') && (
            <button type="button" className="btn small" onClick={() => void ask(!!entry)} disabled={!online}>
              Retry
            </button>
          )}
        </div>
      )}
      {!entry && !fallback && !running && (
        <div className="wx-ask wx-ask-first">
          <button type="button" className="btn tinted block" onClick={() => void ask(false)} disabled={!online}>
            <Icon name="sparkles" />
            Explain more
          </button>
          <span className="wx-foot">{online ? `Claude explains in ${lang === 'fr' ? 'French' : 'English'}, in about 20 s.` : 'Needs a connection.'}</span>
        </div>
      )}
      {entry && !running && (
        <div className="wx-ask">
          <button type="button" className="btn small plain" onClick={() => void ask(true)} disabled={!online}>
            <Icon name="sync" />
            Ask again
          </button>
          {!online && <span className="wx-foot">Needs a connection</span>}
        </div>
      )}
    </section>
  );
}

function ZhLine({ zh, pinyin, tr, show }: { zh: string; pinyin?: string; tr?: ReactNode; show: boolean }) {
  return (
    <>
      <button type="button" className="wx-zh zh" lang="zh-CN" onClick={() => speak(zh)} aria-label={`${zh}, play audio`}>
        {zh}
      </button>
      {show && pinyin && <div className="wx-py">{pinyin}</div>}
      {tr != null && <div className="wx-tr">{tr}</div>}
    </>
  );
}

function ExplanationBody({ x, lang, py }: { x: Explanation; lang: Lang; py: boolean }) {
  const t = lang;
  return (
    <div className="wx-claude" lang={t}>
      <p className="wx-summary">{x.summary}</p>
      {x.check && (
        <p className="wx-check">
          <b>Your meaning:</b> {x.check}
        </p>
      )}
      {x.senses.length > 0 && (
        <ol className="wx-senses">
          {x.senses.map((s, i) => (
            <li key={i}>
              {s.pos && <span className="tag">{s.pos}</span>} {s.meaning}
              {s.note && <div className="small muted">{s.note}</div>}
            </li>
          ))}
        </ol>
      )}
      {x.register && (
        <p>
          <b>Register:</b> {x.register}
        </p>
      )}
      {x.nuance.length > 0 && (
        <>
          <h4>Close words</h4>
          <ul className="wx-list">
            {x.nuance.map((n, i) => (
              <li key={i}>
                <span className="zh" lang="zh-CN">{n.word}</span> <span className="muted">{n.pinyin}</span>
                <div>{n.diff}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      {x.collocations.length > 0 && (
        <>
          <h4>Collocations</h4>
          <ul className="wx-list">
            {x.collocations.map((c, i) => (
              <li key={i}>
                <ZhLine zh={c.zh} pinyin={c.pinyin} tr={c.tr} show={py} />
              </li>
            ))}
          </ul>
        </>
      )}
      {x.patterns.length > 0 && (
        <>
          <h4>Patterns</h4>
          <ul className="wx-list">
            {x.patterns.map((p, i) => (
              <li key={i}>
                <span className="zh" lang="zh-CN">{p.pattern}</span>
                <div>{p.tr}</div>
                {p.example && (
                  <div className="wx-sub">
                    <ZhLine zh={p.example.zh} pinyin={p.example.pinyin} tr={p.example.tr} show={py} />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
      {x.mistakes.length > 0 && (
        <>
          <h4>Common mistakes</h4>
          <ul className="wx-list">
            {x.mistakes.map((m, i) => (
              <li key={i}>
                {m.wrong && <div className="wx-wrong zh" lang="zh-CN">✗ {m.wrong}</div>}
                {m.right && <div className="wx-right zh" lang="zh-CN">✓ {m.right}</div>}
                <div>{m.why}</div>
              </li>
            ))}
          </ul>
        </>
      )}
      <h4>Examples</h4>
      <ul className="wx-list">
        {x.examples.map((e, i) => (
          <li key={i}>
            <ZhLine zh={e.zh} pinyin={e.pinyin} tr={e.tr} show={py} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- Tatoeba examples ---- */

function SentencePinyin({ zh }: { zh: string }) {
  const [text, setText] = useState('');
  useEffect(() => {
    let live = true;
    examplePinyin(zh).then((t) => live && setText(t), () => {});
    return () => {
      live = false;
    };
  }, [zh]);
  return <div className="wx-py">{text}</div>;
}

function ExamplesSection({ lookup, lang, py, setPy }: { lookup: Lookup | null; lang: Lang; py: boolean; setPy: (v: boolean) => void }) {
  const list: ExampleSentence[] = lookup?.ok ? lookup.info.examples : [];
  if (list.length === 0) return null;
  return (
    <section className="wx-sec" aria-label="Examples">
      <div className="wx-sech">
        <h3 className="wx-h">Examples</h3>
        <PyChip on={py} set={setPy} />
      </div>
      <ul className="wx-card wx-ex">
        {list.map((s) => {
          const own = lang === 'fr' ? s.fr : s.en;
          const text = own ?? (lang === 'fr' ? s.en : s.fr);
          const tag = !own && text ? (lang === 'fr' ? 'EN' : 'FR') : null;
          return (
            <li key={s.id} className="wx-row">
              <button type="button" className="wx-zh zh" lang="zh-CN" onClick={() => speak(s.zh)} aria-label={`${s.zh}, play audio`}>
                {s.zh}
              </button>
              {py && <SentencePinyin zh={s.zh} />}
              {text && (
                <div className="wx-tr" lang={own ? lang : lang === 'fr' ? 'en' : 'fr'}>
                  {tag && <span className="tag">{tag}</span>} {text}
                </div>
              )}
              <a className="wx-src" href={`https://tatoeba.org/en/sentences/show/${s.id}`} target="_blank" rel="noopener">
                Tatoeba
                <Icon name="external" />
              </a>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
