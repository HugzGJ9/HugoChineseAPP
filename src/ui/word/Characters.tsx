// "Characters" (one card per distinct character of a word) and "Words with X" (his words and common dictionary words
// that contain the character). Plan 2026-11-23 D7, D8, D12. Meaning only: no radicals or components.
import { useEffect, useMemo, useState } from 'react';
import { useApp, type Lang } from '../../lib/store';
import { charGloss, charWords, lookupWord, type CharLookup, type CharWord, type DictSense } from '../../lib/lexicon';
import { vocabWithChar } from '../../lib/sentence';
import { numberedToMarked } from '../../lib/pinyin';
import { Icon, Pinyin } from '../common';
import { StatusIcon } from '../StatusPicker';
import { useWordNav } from './nav';
import { useVocab } from './vocab';

const HAN_G = /\p{Script=Han}/gu;
const HIS_FIRST = 12;
const COMMON_FIRST = 8;

interface CharCard { ch: string; syllable?: string; meaning: string; tag?: 'EN'; reading: string }

/** The distinct Han characters of a word, in order, each with the syllable it has in this word (when the counts agree). */
export function charSyllables(word: string, reading?: string): { ch: string; syllable?: string }[] {
  const han = word.match(HAN_G) ?? [];
  const syls = (reading ?? '').trim().split(/\s+/).filter(Boolean);
  const aligned = syls.length === han.length;
  const seen = new Set<string>();
  const out: { ch: string; syllable?: string }[] = [];
  han.forEach((ch, i) => {
    if (seen.has(ch)) return;
    seen.add(ch);
    out.push({ ch, syllable: aligned ? syls[i] : undefined });
  });
  return out;
}

export function CharactersSection({ word, reading, excludeId }: { word: string; reading?: string; excludeId?: string }) {
  const chars = useMemo(() => charSyllables(word, reading), [word, reading]);
  const total = (word.match(HAN_G) ?? []).length;
  if (chars.length === 0) return null;
  return (
    <>
      {total >= 2 && <CardsSection chars={chars} />}
      {chars.map((c) => (
        <WordsWith key={c.ch} ch={c.ch} word={word} excludeId={excludeId} />
      ))}
    </>
  );
}

function pickSenses(list: DictSense[], syllable?: string): DictSense | undefined {
  return (syllable ? list.find((d) => d.match !== 'other') : undefined) ?? list[0];
}

function CardsSection({ chars }: { chars: { ch: string; syllable?: string }[] }) {
  const lang = useApp((s) => s.lang);
  const nav = useWordNav();
  const [cards, setCards] = useState<CharCard[] | null>(null);
  const key = chars.map((c) => c.ch + (c.syllable ?? '')).join('|');

  useEffect(() => {
    let live = true;
    setCards(null);
    Promise.all(
      chars.map(async ({ ch, syllable }): Promise<CharCard> => {
        const r = await lookupWord(ch, syllable).catch(() => null);
        if (!r || !r.ok) return { ch, syllable, meaning: '', reading: syllable ?? '' };
        const useFr = lang === 'fr' && r.info.fr.length > 0;
        const d = pickSenses(useFr ? r.info.fr : r.info.en, syllable) ?? pickSenses(r.info.en, syllable);
        const num = syllable ?? d?.pinyinNum.split(/\s+/)[0] ?? '';
        return { ch, syllable: syllable ?? (num || undefined), meaning: d ? charGloss(d.senses, 3) : '', tag: lang === 'fr' && !useFr ? 'EN' : undefined, reading: num };
      }),
    ).then((c) => live && setCards(c));
    return () => {
      live = false;
    };
  }, [key, lang]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <section className="wx-sec" aria-label="Characters">
      <h3 className="wx-h">Characters</h3>
      <div className="wx-card">
        {!cards ? (
          <p className="wx-row wx-dim" aria-busy="true">Loading…</p>
        ) : (
          cards.map((c) => (
            <div key={c.ch} className="wx-row wx-char">
              <button
                type="button"
                className="wx-char-zh zh"
                lang="zh-CN"
                aria-label={`Open ${c.ch}`}
                disabled={!nav}
                onClick={() => nav?.open({ t: 'word', word: c.ch, pinyinNum: c.syllable })}
              >
                {c.ch}
              </button>
              <div className="wx-char-body">
                {c.reading && <Pinyin text={numberedToMarked([c.reading])} className="wx-rpy" />}
                <span className="wx-char-gloss" lang={c.tag ? 'en' : lang}>
                  {c.meaning ? <>{c.tag && <span className="tag">{c.tag}</span>} {c.meaning}</> : <span className="wx-dim">No meaning found.</span>}
                </span>
              </div>
            </div>
          ))
        )}
      </div>
    </section>
  );
}

function WordsWith({ ch, word, excludeId }: { ch: string; word: string; excludeId?: string }) {
  const lang = useApp((s) => s.lang);
  const nav = useWordNav();
  const vocab = useVocab();
  const [res, setRes] = useState<CharLookup | null>(null);
  const [allHis, setAllHis] = useState(false);
  const [more, setMore] = useState(false);

  useEffect(() => {
    let live = true;
    setRes(null);
    charWords(ch).then(
      (r) => live && setRes(r),
      () => live && setRes({ ok: false, reason: 'error' }),
    );
    return () => {
      live = false;
    };
  }, [ch]);

  const his = useMemo(() => {
    const ids = new Set(vocabWithChar(ch, vocab.index));
    if (excludeId) ids.delete(excludeId);
    const out = [];
    for (const n of vocab.byId.values()) if (ids.has(n.id)) out.push(n); // list order
    return out;
  }, [ch, vocab, excludeId]);

  const common: CharWord[] = useMemo(
    () => (res?.ok ? res.words.filter((w) => w.word !== word && !vocab.index.forms.has(w.word)) : []),
    [res, word, vocab],
  );
  const offline = !!res && !res.ok && res.reason === 'offline';
  if (his.length === 0 && common.length === 0 && !offline) return null;

  const hisShown = allHis ? his : his.slice(0, HIS_FIRST);
  const commonShown = more ? common : common.slice(0, COMMON_FIRST);
  return (
    <section className="wx-sec" aria-label={`Words with ${ch}`}>
      <h3 className="wx-h">Words with {ch}</h3>
      <div className="wx-card wx-pad wx-ww">
        {his.length > 0 && (
          <div className="wx-chips">
            {hisShown.map((n) => {
              const st = vocab.statuses.get(n.id) ?? 'new';
              return (
                <button key={n.id} type="button" className={`chip sw-link st-${st}`} disabled={!nav} onClick={() => nav?.open({ t: 'note', note: n })}>
                  <StatusIcon status={st} />
                  <span className="zh" lang="zh-CN">{n.hanzi}</span>
                </button>
              );
            })}
          </div>
        )}
        {common.length > 0 && (
          <>
            {his.length > 0 && <span className="wx-label">Common words</span>}
            <div className="wx-chips">
              {commonShown.map((w) => {
                const gloss = lang === 'fr' && w.fr ? w.fr : w.en;
                return (
                  <button key={w.word} type="button" className="wx-chip wx-cw" disabled={!nav} onClick={() => nav?.open({ t: 'word', word: w.word, pinyinNum: w.pinyinNum })}>
                    <span className="zh" lang="zh-CN">{w.word}</span>
                    <span className="muted wx-cw-gloss" lang={lang === 'fr' && w.fr ? 'fr' : 'en'}>{gloss}</span>
                  </button>
                );
              })}
            </div>
          </>
        )}
        {offline && <p className="wx-dim wx-note">Connect once to download the dictionary.</p>}
      </div>
      {(!allHis && his.length > HIS_FIRST || !more && common.length > COMMON_FIRST) && (
        <div className="wx-card wx-actions">
          {!allHis && his.length > HIS_FIRST && (
            <button type="button" className="wx-row wx-action" onClick={() => setAllHis(true)}>
              Show all {his.length} of your words
              <Icon name="chevron-down" />
            </button>
          )}
          {!more && common.length > COMMON_FIRST && (
            <button type="button" className="wx-row wx-action" onClick={() => setMore(true)}>
              More common words
              <Icon name="chevron-down" />
            </button>
          )}
        </div>
      )}
    </section>
  );
}
