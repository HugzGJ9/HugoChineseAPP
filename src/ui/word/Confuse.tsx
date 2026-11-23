// "Don't confuse with" (Claude's near-synonyms, plan 2026-11-23 D10) and "Similar meaning" (offline, D11).
// For near-synonyms the point is "when to use which", so each item leads with the rule and then shows the contrasting
// pair: a sentence with the headword and one with the other word, side by side in a stack.
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../lib/store';
import { lookupWord, similarWords, type DictSense, type ExampleSentence } from '../../lib/lexicon';
import type { Explanation } from '../../lib/explain';
import { Pinyin } from '../common';
import { useWordNav } from './nav';
import { ZhBlock, ZhText } from './ZhLine';

const HAN_ONLY = /^\p{Script=Han}+$/u;

interface Item { word: string; pinyin: string; use: string; self?: ZhPair; other?: ZhPair }
interface ZhPair { zh: string; pinyin: string; tr: string }

function ItemWord({ word }: { word: string }) {
  const nav = useWordNav();
  const han = HAN_ONLY.test(word) && [...word].length <= 8;
  if (!han) return <ZhText zh={word} />;
  return (
    <button type="button" className="wx-cf-word zh" lang="zh-CN" disabled={!nav} onClick={() => nav?.open({ t: 'word', word })}>
      {word}
    </button>
  );
}

export function ConfuseSection({ x, head, onAskAgain, online }: { x: Explanation; head: string[]; onAskAgain: () => void; online: boolean }) {
  const lang = useApp((s) => s.lang);
  const old = x.confuse === undefined;
  const items: Item[] = useMemo(() => {
    const src: Item[] = x.confuse ?? x.nuance.map((n) => ({ word: n.word, pinyin: n.pinyin, use: n.diff }));
    return src.filter((i) => !head.includes(i.word));
  }, [x, head]);
  if (items.length === 0) return null;
  return (
    <section className="wx-sec" aria-label="Don't confuse with">
      <h3 className="wx-h">Don't confuse with</h3>
      <ul className="wx-card wx-cf-list" lang={lang}>
        {items.map((it, i) => (
          <li key={i} className="wx-row wx-cf">
            <div className="wx-cf-head">
              <ItemWord word={it.word} />
              {it.pinyin && <Pinyin text={it.pinyin} className="wx-cf-py" />}
            </div>
            <p className="wx-cf-use">{it.use}</p>
            {it.self && it.other && (
              <div className="wx-vs">
                <div className="wx-vs-side self">
                  <span className="wx-vs-tag zh" lang="zh-CN">{head[0]}</span>
                  <ZhBlock zh={it.self.zh} pinyin={it.self.pinyin} tr={it.self.tr} trLang={lang} head={head} />
                </div>
                <div className="wx-vs-side other">
                  <span className="wx-vs-tag zh" lang="zh-CN">{it.word}</span>
                  <ZhBlock zh={it.other.zh} pinyin={it.other.pinyin} tr={it.other.tr} trLang={lang} head={[it.word]} />
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
      {old && (
        <div className="wx-ask">
          <span className="wx-foot">From an older explanation{online ? '' : ' · needs a connection'}</span>
          <button type="button" className="btn small plain" onClick={onAskAgain} disabled={!online}>
            Ask again for example pairs
          </button>
        </div>
      )}
    </section>
  );
}

interface Similar { word: string; pinyin: string; pinyinNum: string; senses: string[]; tag?: 'EN'; example?: ExampleSentence }

export function SimilarSection({ word, mine }: { word: string; mine: boolean }) {
  const lang = useApp((s) => s.lang);
  const nav = useWordNav();
  const [list, setList] = useState<Similar[] | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    (async () => {
      const r = await similarWords(word);
      if (!r.ok) return [];
      const out: Similar[] = [];
      for (const w of r.words) {
        const l = await lookupWord(w).catch(() => null);
        if (!l || !l.ok) continue;
        const fr = lang === 'fr' && l.info.fr.length > 0;
        const d: DictSense | undefined = (fr ? l.info.fr : l.info.en)[0];
        if (!d) continue;
        out.push({ word: w, pinyin: d.pinyin, pinyinNum: d.pinyinNum, senses: d.senses.slice(0, 2), tag: lang === 'fr' && !fr ? 'EN' : undefined, example: l.info.examples[0] });
      }
      return out;
    })().then((v) => live && setList(v), () => live && setList([]));
    return () => {
      live = false;
    };
  }, [word, lang]);

  if (!list || list.length === 0) return null;
  return (
    <section className="wx-sec" aria-label="Similar meaning">
      <h3 className="wx-h">Similar meaning</h3>
      <ul className="wx-card wx-cf-list">
        {list.map((s) => {
          const own = lang === 'fr' ? s.example?.fr : s.example?.en;
          const text = own ?? (lang === 'fr' ? s.example?.en : s.example?.fr);
          return (
            <li key={s.word} className="wx-row wx-cf">
              <div className="wx-cf-head">
                <button type="button" className="wx-cf-word zh" lang="zh-CN" disabled={!nav} onClick={() => nav?.open({ t: 'word', word: s.word, pinyinNum: s.pinyinNum })}>
                  {s.word}
                </button>
                <Pinyin text={s.pinyin} className="wx-cf-py" />
              </div>
              <p className="wx-cf-use" lang={s.tag ? 'en' : lang}>{s.tag && <span className="tag">{s.tag}</span>} {s.senses.join('; ')}</p>
              {s.example && <ZhBlock zh={s.example.zh} tr={text} trLang={own ? lang : lang === 'fr' ? 'en' : 'fr'} trTag={!own && text ? (lang === 'fr' ? 'EN' : 'FR') : undefined} head={[s.word]} />}
            </li>
          );
        })}
      </ul>
      <p className="wx-foot">
        Words that share a dictionary meaning with {word}. Compare their senses and examples.
        {mine && ' Explain more gives Claude’s comparison.'}
      </p>
    </section>
  );
}
