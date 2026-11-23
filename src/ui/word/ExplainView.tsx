// Everything about one word: his meaning, dictionary senses, Claude's explanation (on demand) and real example sentences.
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Note } from '../../lib/types';
import { useApp, type Lang } from '../../lib/store';
import { formatSense, lookupWord, sensesText, type DictSense, type ExampleSentence, type Lookup } from '../../lib/lexicon';
import {
  ClaudeError, explainJob, getExplanation, onExplainChange, requestExplanation,
  type ExplainEntry, type Explanation,
} from '../../lib/explain';
import { patternChars } from '../../lib/grammar/list';
import { formatDate, Icon, Meaning, Pinyin } from '../common';
import { WordNavHost, useWordNav } from './nav';
import { PinyinChip, ZhBlock } from './ZhLine';
import { CharactersSection } from './Characters';
import { ConfuseSection, SimilarSection } from './Confuse';
import './word.css';

const FIRST = 6;
const HAN_ONLY = /^\p{Script=Han}+$/u;

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

/**
 * `mine={false}`: a word that is not in his list (tapped in a sentence): no "Your list" block and no Claude, only the
 * offline dictionary and its examples. `reading` = numbered pinyin of the word in its sentence (ranks the readings).
 * `inline` (Words page): no sheet around, so it brings its own WordNavHost.
 */
export function ExplainView({ note, inline = false, mine = true, reading }: { note: Note; inline?: boolean; mine?: boolean; reading?: string }) {
  const nav = useWordNav();
  if (inline && !nav) {
    return (
      <WordNavHost>
        <ExplainBody note={note} inline mine={mine} reading={reading} />
      </WordNavHost>
    );
  }
  return <ExplainBody note={note} inline={inline} mine={mine} reading={reading} />;
}

function ExplainBody({ note, inline, mine, reading }: { note: Note; inline: boolean; mine: boolean; reading?: string }) {
  const lang = useApp((s) => s.lang);
  const online = useOnline();
  const [lookup, setLookup] = useState<Lookup | null>(null);
  const altsKey = note.alts.join('|');
  // The panel's own word(s) are bold in every line; a grammar note marks its fixed characters instead.
  const grammar = note.kind === 'grammar';
  const head = useMemo(() => (grammar ? undefined : [note.hanzi, ...note.alts].filter((f) => HAN_ONLY.test(f))), [grammar, note.hanzi, altsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const pattern = useMemo(() => (grammar ? patternChars(note) : undefined), [grammar, note.hanzi, altsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let live = true;
    setLookup(null);
    lookupWord(note.hanzi, reading ?? note.pinyinNum, note.alts).then(
      (r) => live && setLookup(r),
      () => live && setLookup({ ok: false, reason: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [note.id, note.hanzi, note.pinyinNum, note.alts, reading]);

  return (
    <div className={`wx ${inline ? 'inline' : ''}`}>
      {inline && (
        <div className="wx-inline-bar">
          <PinyinChip />
        </div>
      )}
      {mine && (
        <section className="wx-sec" aria-label="Your list">
          <h3 className="wx-h">Your list</h3>
          <div className="wx-card wx-pad wx-mine">
            <Meaning note={note} />
          </div>
        </section>
      )}
      <DictionarySection lookup={lookup} lang={lang} />
      {mine && <ClaudeSection note={note} lang={lang} online={online} lookup={lookup} head={head} pattern={pattern} similar={!grammar} />}
      {!grammar && lookup && (
        <CharactersSection word={note.hanzi} reading={reading || note.pinyinNum || (lookup.ok ? lookup.info.en[0]?.pinyinNum : undefined)} excludeId={mine ? note.id : undefined} />
      )}
      {!mine && !grammar && lookup && <SimilarSection word={note.hanzi} mine={false} />}
      <ExamplesSection lookup={lookup} lang={lang} head={head} pattern={pattern} />
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
  const nav = useWordNav();
  const useFr = lang === 'fr' && info.fr.length > 0;
  const list = useFr ? info.fr : info.en;
  // No reading matches (no context, e.g. a measure-word chip): list them all as primary instead of folding them away (D5).
  const anyMatch = list.some((d) => d.match !== 'other');
  const primary = anyMatch ? list.filter((d) => d.match !== 'other') : list;
  const other = anyMatch ? list.filter((d) => d.match === 'other') : [];
  // Measure words are listed in English entries only.
  const measure = [...info.en, ...info.fr].filter((d) => !anyMatch || d.match !== 'other').flatMap((d) => d.measure);
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
              <button key={m.hanzi} type="button" className="wx-chip" onClick={() => nav?.open({ t: 'word', word: m.hanzi })} disabled={!nav}>
                <span className="zh" lang="zh-CN">{m.hanzi}</span> <span className="muted">{m.pinyin}</span>
              </button>
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

function ClaudeSection({ note, lang, online, lookup, head, pattern, similar }: { note: Note; lang: Lang; online: boolean; lookup: Lookup | null; head?: string[]; pattern?: string; similar: boolean }) {
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
  const progress = job ? Math.min(0.95, job.chars / 6500) : 0;

  return (
    <>
    <section className="wx-sec" aria-label="Claude's explanation">
      <h3 className="wx-h">Claude's explanation</h3>
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
          <ExplanationBody x={shown.x} lang={shown.lang} head={head} pattern={pattern} />
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
    {shown && head && head.length > 0 && <ConfuseSection x={shown.x} head={head} onAskAgain={() => void ask(true)} online={online} />}
    {!shown && similar && <SimilarSection word={note.hanzi} mine />}
    </>
  );
}

function ExplanationBody({ x, lang, head, pattern }: { x: Explanation; lang: Lang; head?: string[]; pattern?: string }) {
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
      {x.collocations.length > 0 && (
        <>
          <h4>Collocations</h4>
          <ul className="wx-list">
            {x.collocations.map((c, i) => (
              <li key={i}>
                <ZhBlock zh={c.zh} pinyin={c.pinyin} tr={c.tr} trLang={t} head={head} pattern={pattern} />
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
                <ZhBlock zh={p.pattern} tr={p.tr} trLang={t} head={head} pattern={pattern} audio={false} />
                {p.example && (
                  <div className="wx-sub">
                    <ZhBlock zh={p.example.zh} pinyin={p.example.pinyin} tr={p.example.tr} trLang={t} head={head} pattern={pattern} />
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
                {m.wrong && <ZhBlock zh={m.wrong} mark="wrong" head={head} pattern={pattern} />}
                {m.right && <ZhBlock zh={m.right} mark="right" head={head} pattern={pattern} />}
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
            <ZhBlock zh={e.zh} pinyin={e.pinyin} tr={e.tr} trLang={t} head={head} pattern={pattern} />
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---- Tatoeba examples ---- */

function ExamplesSection({ lookup, lang, head, pattern }: { lookup: Lookup | null; lang: Lang; head?: string[]; pattern?: string }) {
  const list: ExampleSentence[] = lookup?.ok ? lookup.info.examples : [];
  if (list.length === 0) return null;
  return (
    <section className="wx-sec" aria-label="Examples">
      <h3 className="wx-h">Examples</h3>
      <ul className="wx-card wx-ex">
        {list.map((s) => {
          const own = lang === 'fr' ? s.fr : s.en;
          const text = own ?? (lang === 'fr' ? s.en : s.fr);
          const tag = !own && text ? (lang === 'fr' ? 'EN' : 'FR') : undefined;
          return (
            <li key={s.id} className="wx-row">
              <ZhBlock zh={s.zh} tr={text} trLang={own ? lang : lang === 'fr' ? 'en' : 'fr'} trTag={tag} head={head} pattern={pattern}>
                <a className="wx-src" href={`https://tatoeba.org/en/sentences/show/${s.id}`} target="_blank" rel="noopener">
                  Tatoeba
                  <Icon name="external" />
                </a>
              </ZhBlock>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
