// "Similar words" (plan 2026-11-27 D3, D4): one list, no sentences. Sources, first match per word wins, max 6:
// his own groups (Note.group / Note.set), his "Don't confuse" column (Note.confuse), then the offline dictionary.
import { useEffect, useState } from 'react';
import { useApp, type Lang } from '../../lib/store';
import { lookupWord, similarWords, type DictSense } from '../../lib/lexicon';
import { differenceLine, isSpoken, registerTag } from '../../lib/register';
import type { Note } from '../../lib/types';
import { Icon, Pinyin } from '../common';
import { useWordNav, type WordEntry } from './nav';
import { useVocab } from './vocab';

const MAX = 6;

interface Line { text: string; tag?: 'EN' | 'FR' }
interface Item { word: string; pinyin: string; entry: WordEntry; spoken: boolean; written: boolean; lines: Line[]; dict?: boolean }

const primary = (list: DictSense[]) => {
  const m = list.filter((d) => d.match !== 'other');
  return m.length ? m : list;
};

/** His meaning in the app language, with a tag when it falls back to the other language. */
function mean(n: Note, lang: Lang): Line {
  if (lang === 'fr') {
    const f = n.fr ?? n.frAuto;
    if (f) return { text: f };
    return n.en ? { text: n.en, tag: 'EN' } : { text: '' };
  }
  return { text: n.en };
}

function ownItem(n: Note, lang: Lang): Item {
  const lines: Line[] = [mean(n, lang)];
  if (n.kind === 'synonym' && n.extra) {
    const more = [n.extra.tone && `Tone: ${n.extra.tone}`, n.extra.tip && `Tip: ${n.extra.tip}`].filter(Boolean) as string[];
    if (more.length) lines.push({ text: more.join(' · ') });
  }
  return { word: n.hanzi, pinyin: n.pinyin, entry: { t: 'note', note: n }, spoken: isSpoken(n), written: registerTag(n) !== undefined, lines: lines.filter((l) => l.text) };
}

export function SimilarWords({ note }: { note: Note }) {
  const lang = useApp((s) => s.lang);
  const notes = useApp((s) => s.notes);
  const vocab = useVocab();
  const nav = useWordNav();
  const [list, setList] = useState<Item[] | null>(null);

  useEffect(() => {
    let live = true;
    setList(null);
    (async () => {
      const out: Item[] = [];
      const has = (w: string) => w === note.hanzi || note.alts.includes(w) || out.some((o) => o.word === w);
      const room = () => out.length < MAX;
      // (a) his own groups
      if (note.group || note.set) {
        for (const n of notes) {
          if (!room()) break;
          if (n.id === note.id || n.kind === 'grammar' || has(n.hanzi)) continue;
          if ((note.group && n.group === note.group) || (note.set && n.set === note.set)) out.push(ownItem(n, lang));
        }
      }
      // (b) his "Don't confuse" column
      for (const c of note.confuse ?? []) {
        if (!room()) break;
        if (has(c.word)) continue;
        const text: Line = lang === 'fr'
          ? c.fr ? { text: c.fr } : c.en ? { text: c.en, tag: 'EN' } : { text: '' }
          : c.en ? { text: c.en } : c.fr ? { text: c.fr, tag: 'FR' } : { text: '' };
        const id = vocab.index.forms.get(c.word);
        const mine = id ? vocab.byId.get(id) : undefined;
        let pinyin = mine?.pinyin ?? '';
        let pinyinNum: string | undefined = mine?.pinyinNum;
        let senses: string[] | undefined;
        if (!pinyin || (!c.register && !mine)) {
          const l = await lookupWord(c.word, mine?.pinyinNum).catch(() => null);
          if (l && l.ok) {
            const d = primary(l.info.en)[0] ?? primary(l.info.fr)[0];
            if (d && !pinyin) { pinyin = d.pinyin; pinyinNum = d.pinyinNum; }
            senses = [...l.info.en, ...l.info.fr].flatMap((x) => x.senses);
          }
        }
        const reg = c.register;
        out.push({
          word: c.word,
          pinyin,
          entry: mine ? { t: 'note', note: mine } : { t: 'word', word: c.word, pinyinNum },
          spoken: reg ? reg === 'spoken' : isSpoken(mine, senses),
          written: reg ? reg === 'written' || reg === 'formal' : registerTag(mine, senses) !== undefined,
          lines: text.text ? [text] : [],
        });
      }
      // (c) offline: what the other word means that the headword does not
      if (room()) {
        const r = await similarWords(note.hanzi).catch(() => null);
        if (r && r.ok && r.words.some((w) => !has(w))) {
          const head = await lookupWord(note.hanzi, note.pinyinNum, note.alts).catch(() => null);
          const useFr = lang === 'fr';
          const headList = head && head.ok ? (useFr && head.info.fr.length ? head.info.fr : head.info.en) : [];
          const headSenses = primary(headList).flatMap((d) => d.senses);
          for (const w of r.words) {
            if (!room()) break;
            if (has(w)) continue;
            const l = await lookupWord(w).catch(() => null);
            if (!l || !l.ok) continue;
            const fr = useFr && l.info.fr.length > 0;
            const d = primary(fr ? l.info.fr : l.info.en)[0];
            if (!d) continue;
            const all = [...l.info.en, ...l.info.fr].flatMap((x) => x.senses);
            const diff = differenceLine(headSenses, d.senses);
            const id = vocab.index.forms.get(w);
            const mine = id ? vocab.byId.get(id) : undefined;
            out.push({
              word: w,
              pinyin: d.pinyin,
              entry: { t: 'word', word: w, pinyinNum: d.pinyinNum },
              spoken: isSpoken(mine, all),
              written: registerTag(mine, d.senses) !== undefined,
              lines: diff.length ? [{ text: diff.join('; '), tag: useFr && !fr ? 'EN' : undefined }] : [],
              dict: true,
            });
          }
        }
      }
      return out;
    })().then((v) => live && setList(v), () => live && setList([]));
    return () => {
      live = false;
    };
  }, [note.id, note.pinyinNum, lang, notes, vocab]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list || list.length === 0) return null;
  return (
    <section className="wx-sec" aria-label="Similar words">
      <h3 className="wx-h">Similar words</h3>
      <ul className="wx-card wx-cf-list">
        {list.map((s) => (
          <li key={s.word} className="wx-row wx-cf">
            <div className="wx-cf-head">
              <button type="button" className="wx-cf-word zh" lang="zh-CN" disabled={!nav} onClick={() => nav?.open(s.entry)}>
                {s.word}
              </button>
              {s.pinyin && <Pinyin text={s.pinyin} className="wx-cf-py" />}
              {s.spoken && (
                <span className="wx-crown" role="img" aria-label="Colloquial (口语)">
                  <Icon name="crown" />
                </span>
              )}
              {!s.spoken && s.written && <span className="tag wx-reg">书面</span>}
            </div>
            {s.lines.map((l, i) => (
              <p key={i} className="wx-cf-use" lang={l.tag ? l.tag.toLowerCase() : lang}>{l.tag && <span className="tag">{l.tag}</span>} {l.text}</p>
            ))}
          </li>
        ))}
      </ul>
      {list.some((s) => s.dict) && <p className="wx-foot">From the dictionary.</p>}
    </section>
  );
}
