// French meanings from CFDICT (https://chine.in, CC BY-SA 3.0), served as public/dict/cfdict.tsv.
import { toToneless, syllablesFromNumbered } from './pinyin';

export type FrDict = Map<string, { p: string; d: string }[]>;

export function parseCfdict(text: string): FrDict {
  const dict: FrDict = new Map();
  for (const line of text.split('\n')) {
    if (!line) continue;
    const a = line.indexOf('\t');
    const b = line.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    const simp = line.slice(0, a);
    let list = dict.get(simp);
    if (!list) dict.set(simp, (list = []));
    list.push({ p: line.slice(a + 1, b), d: line.slice(b + 1) });
  }
  return dict;
}

const toneless = (p: string) => toToneless(syllablesFromNumbered(p.split(' ')));

/** French for a word: the entry with the same reading, else the same letters, else the first entry. */
export function lookupFr(dict: FrDict, hanzi: string, pinyinNum: string, maxSenses = 4): string | undefined {
  const list = dict.get(hanzi);
  if (!list?.length) return undefined;
  const want = pinyinNum.toLowerCase();
  const tl = toneless(want);
  const hits = list.filter((e) => e.p === want);
  const pick = hits.length ? hits : list.filter((e) => toneless(e.p) === tl);
  const chosen = pick.length ? pick : list.slice(0, 1);
  const senses: string[] = [];
  for (const e of chosen) for (const s of e.d.split('/')) if (!senses.includes(s)) senses.push(s);
  return senses.slice(0, maxSenses).join(' ; ');
}

export const CFDICT_CREDIT = 'French meanings: CFDICT by Chine Informations (chine.in), CC BY-SA 3.0';
