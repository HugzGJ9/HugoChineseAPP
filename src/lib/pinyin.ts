// Pinyin parsing and formatting. Accepts tone marks, tone numbers, a mix of both,
// v or u: for ü, capitals, apostrophes and unspaced syllables (tángang1qin2 → tángāngqín).

/** Every Mandarin syllable, toneless, with ü written as v. Includes interjections and erhua r. */
const SYLLABLE_LIST =
  'a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo m n ng hm hng r';

export const SYLLABLES = new Set(SYLLABLE_LIST.split(' '));
const INTERJECTIONS = new Set(['m', 'n', 'ng', 'hm', 'hng']);

export interface Syl {
  /** Toneless syllable, ü written as v. */
  s: string;
  /** 1–4, or 5 for neutral / not written. */
  t: number;
  /** A tone mark or number was written for this syllable. */
  toned: boolean;
}

export interface ParsedPinyin {
  ok: boolean;
  syls: Syl[];
  /** Index of the first syllable of every written word (spaces and apostrophes kept for display). */
  wordStarts: number[];
  marks: boolean;
  digits: boolean;
  error?: string;
}

const MARKED: Record<string, [string, number]> = {};
const add = (base: string, chars: string) => [...chars].forEach((c, i) => (MARKED[c] = [base, i + 1]));
add('a', 'āáǎà');
add('e', 'ēéěè');
add('i', 'īíǐì');
add('o', 'ōóǒò');
add('u', 'ūúǔù');
add('v', 'ǖǘǚǜ');
add('n', 'ńňǹ');
MARKED['ḿ'] = ['m', 2];
MARKED['ü'] = ['v', 0];
MARKED['ê'] = ['e', 0];

const SEP = /[\s'’‘`´\-·,，、;；/.。]/;

/**
 * Parse a pinyin string. `expected` (number of syllables, usually the number of hanzi)
 * guides the split of unspaced text when several splits are possible.
 */
export function parsePinyin(input: string, expected?: number): ParsedPinyin {
  const src = input.normalize('NFC').toLowerCase().replace(/u:/g, 'v');
  const letters: string[] = [];
  const marks: number[] = [];
  const digitAt = new Map<number, number>(); // tone digit written after letter index
  const boundary = new Set<number>([0]); // letter indices where a syllable must start
  const wordBreak = new Set<number>([0]); // letter indices where a written word starts
  let sawMarks = false;
  let sawDigits = false;
  for (const ch of src) {
    if (SEP.test(ch)) {
      boundary.add(letters.length);
      wordBreak.add(letters.length);
      continue;
    }
    if (/[0-5]/.test(ch)) {
      if (!letters.length || digitAt.has(letters.length - 1)) return fail(input, `tone number in the wrong place`);
      digitAt.set(letters.length - 1, ch === '0' ? 5 : Number(ch));
      sawDigits = true;
      boundary.add(letters.length);
      continue;
    }
    if (/[a-z]/.test(ch)) {
      letters.push(ch);
      marks.push(0);
      continue;
    }
    const m = MARKED[ch];
    if (m) {
      letters.push(m[0]);
      marks.push(m[1]);
      if (m[1]) sawMarks = true;
      continue;
    }
    return fail(input, /\p{Script=Han}/u.test(ch) ? 'Chinese characters in the pinyin' : `unexpected character “${ch}”`);
  }
  const n = letters.length;
  if (!n) return fail(input, 'empty');

  // DP over (position, syllable count): cost = syllables + penalty for a vowel-initial
  // syllable glued to the previous one (pinyin would need an apostrophe there).
  const INF = 1e9;
  const maxK = n + 1;
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(maxK + 1).fill(INF));
  const back: number[][] = Array.from({ length: n + 1 }, () => new Array(maxK + 1).fill(-1));
  cost[0][0] = 0;
  for (let i = 1; i <= n; i++) {
    for (let j = Math.max(0, i - 6); j < i; j++) {
      // a syllable may not cross a written boundary
      let crosses = false;
      for (let b = j + 1; b < i; b++) if (boundary.has(b)) crosses = true;
      if (crosses) continue;
      const syl = letters.slice(j, i).join('');
      if (!SYLLABLES.has(syl)) continue;
      // tone numbers only at the end of a syllable, at most one tone per syllable
      let tones = 0;
      let bad = false;
      for (let k = j; k < i; k++) {
        if (marks[k]) tones++;
        if (digitAt.has(k) && k !== i - 1) bad = true;
      }
      if (digitAt.has(i - 1)) tones++;
      if (bad || tones > 1) continue;
      const glued = j > 0 && !boundary.has(j) && /^[aoe]/.test(syl) ? 40 : 0;
      const rare = INTERJECTIONS.has(syl) ? 100 : 0;
      for (let k = 0; k < maxK; k++) {
        if (cost[j][k] >= INF) continue;
        const c = cost[j][k] + 1 + glued + rare;
        if (c < cost[i][k + 1]) {
          cost[i][k + 1] = c;
          back[i][k + 1] = j;
        }
      }
    }
  }
  let bestK = -1;
  let bestScore = INF;
  for (let k = 1; k <= maxK; k++) {
    if (cost[n][k] >= INF) continue;
    const score = cost[n][k] + (expected ? Math.abs(k - expected) * 30 : 0);
    if (score < bestScore) {
      bestScore = score;
      bestK = k;
    }
  }
  if (bestK < 0) return fail(input, 'not valid pinyin');
  const cuts: number[] = [];
  for (let i = n, k = bestK; i > 0; k--) {
    cuts.push(i);
    i = back[i][k];
  }
  cuts.reverse();
  const syls: Syl[] = [];
  const wordStarts: number[] = [];
  let start = 0;
  for (const end of cuts) {
    let t = 0;
    for (let k = start; k < end; k++) if (marks[k]) t = marks[k];
    if (digitAt.has(end - 1)) t = digitAt.get(end - 1)!;
    if (wordBreak.has(start)) wordStarts.push(syls.length);
    syls.push({ s: letters.slice(start, end).join(''), t: t || 5, toned: t > 0 });
    start = end;
  }
  return { ok: true, syls, wordStarts: dedupe(wordStarts), marks: sawMarks, digits: sawDigits };
}

function dedupe(a: number[]): number[] {
  return [...new Set(a)].sort((x, y) => x - y);
}

function fail(input: string, error: string): ParsedPinyin {
  return { ok: false, syls: [], wordStarts: [], marks: false, digits: false, error: input.trim() ? error : 'empty' };
}

const TONE_CHARS: Record<string, string> = {
  a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', v: 'ǖǘǚǜ', n: 'ńňǹn', m: 'mḿmm',
};

/** One syllable with its tone mark (xue + 2 → xué). */
export function markSyllable(s: string, t: number): string {
  const disp = (x: string) => x.replace(/v/g, 'ü');
  if (t < 1 || t > 4) return disp(s);
  let idx = s.indexOf('a');
  if (idx < 0) idx = s.indexOf('e');
  if (idx < 0 && s.includes('ou')) idx = s.indexOf('o');
  if (idx < 0) {
    for (let k = s.length - 1; k >= 0; k--) if ('iouv'.includes(s[k])) { idx = k; break; }
  }
  if (idx < 0) {
    if (s === 'n' || s === 'ng' || s === 'hng') idx = s.indexOf('n');
    else if (s === 'm' || s === 'hm') idx = s.indexOf('m');
  }
  if (idx < 0) return disp(s);
  const ch = TONE_CHARS[s[idx]]?.[t - 1] ?? s[idx];
  return disp(s.slice(0, idx)) + ch + disp(s.slice(idx + 1));
}

/** Display form with tone marks, keeping the writer's word breaks. */
export function toMarked(p: ParsedPinyin): string {
  let out = '';
  p.syls.forEach((syl, i) => {
    if (i > 0) {
      if (p.wordStarts.includes(i)) out += ' ';
      else if (/^[aoe]/.test(syl.s)) out += "'";
    }
    out += markSyllable(syl.s, syl.t);
  });
  return out;
}

/** xue2xi2 form (neutral tone = 5). */
export function toNumbered(syls: Syl[], sep = ''): string {
  return syls.map((s) => s.s + s.t).join(sep);
}

export function toToneless(syls: Syl[]): string {
  return syls.map((s) => s.s).join('');
}

/** Convert any pinyin string to tone marks; returns the input unchanged if it can't be parsed. */
export function prettyPinyin(input: string, expected?: number): string {
  const p = parsePinyin(input, expected);
  return p.ok ? toMarked(p) : input;
}

/** Tone-mark display for pinyin-pro style numbered syllables (['xue2','xi2']). */
export function numberedToMarked(nums: string[]): string {
  return nums
    .map((x, i) => {
      const m = /^([a-zü:v]+)([0-5])?$/i.exec(x.toLowerCase().replace('ü', 'v').replace('u:', 'v'));
      if (!m) return x;
      const s = markSyllable(m[1], m[2] ? (m[2] === '0' ? 5 : Number(m[2])) : 5);
      return i > 0 && /^[aoe]/.test(m[1]) ? "'" + s : s;
    })
    .join('');
}

export function syllablesFromNumbered(nums: string[]): Syl[] {
  return nums.map((x) => {
    const m = /^([a-zv]+)([0-5])?$/.exec(x.toLowerCase().replace(/ü/g, 'v').replace(/u:/g, 'v'));
    if (!m) return { s: x, t: 5, toned: false };
    const t = m[2] ? (m[2] === '0' ? 5 : Number(m[2])) : 5;
    return { s: m[1], t, toned: !!m[2] && m[2] !== '0' };
  });
}

export const HAN = /\p{Script=Han}/u;
export const HAN_G = /\p{Script=Han}/gu;

export function hanCount(s: string): number {
  return (s.match(HAN_G) || []).length;
}

/** Tone of each syllable as a CSS class name suffix (t1..t5). */
export function toneClasses(display: string): { text: string; tone: number }[] {
  const p = parsePinyin(display);
  if (!p.ok) return [{ text: display, tone: 0 }];
  const out: { text: string; tone: number }[] = [];
  p.syls.forEach((syl, i) => {
    let prefix = '';
    if (i > 0) {
      if (p.wordStarts.includes(i)) prefix = ' ';
      else if (/^[aoe]/.test(syl.s)) prefix = "'";
    }
    if (prefix) out.push({ text: prefix, tone: 0 });
    out.push({ text: markSyllable(syl.s, syl.t), tone: syl.t });
  });
  return out;
}
