// "Similar meaning": offline words that share a dictionary meaning with the headword (plan 2026-11-27 D3, rebuilt later).
import { useEffect, useMemo, useState } from 'react';
import { useApp } from '../../lib/store';
import { lookupWord, similarWords, type DictSense, type ExampleSentence } from '../../lib/lexicon';
import { Pinyin } from '../common';
import { useWordNav } from './nav';
import { ZhBlock } from './ZhLine';

interface Similar { word: string; pinyin: string; pinyinNum: string; senses: string[]; tag?: 'EN'; example?: ExampleSentence }

export function SimilarSection({ word }: { word: string }) {
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
      </p>
    </section>
  );
}
