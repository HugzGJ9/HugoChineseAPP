// Everything about one word, offline: his meaning, dictionary senses, characters, similar words and real example sentences.
import { useEffect, useMemo, useState } from 'react';
import type { Note } from '../../lib/types';
import { useApp, type Lang } from '../../lib/store';
import { formatSense, lookupWord, type DictSense, type ExampleSentence, type Lookup } from '../../lib/lexicon';
import { patternChars } from '../../lib/grammar/list';
import { Icon, Meaning, Pinyin } from '../common';
import { WordNavHost, useWordNav } from './nav';
import { PinyinChip, ZhBlock } from './ZhLine';
import { CharactersSection } from './Characters';
import { SimilarWords } from './Confuse';
import './word.css';

const FIRST = 6;
const HAN_ONLY = /^\p{Script=Han}+$/u;

/**
 * `mine={false}`: a word that is not in his list (tapped in a sentence): no "Your list" block, only the
 * offline dictionary, characters, similar words and examples. `reading` = numbered pinyin of the word in its sentence (ranks the readings).
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
      {!grammar && lookup && (
        <CharactersSection word={note.hanzi} reading={reading || note.pinyinNum || (lookup.ok ? lookup.info.en[0]?.pinyinNum : undefined)} excludeId={mine ? note.id : undefined} />
      )}
      {!grammar && lookup && <SimilarWords note={note} />}
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
