// Pure functions for scripts/build-lexicon.mjs (no I/O), tested in scripts/lexicon-lib.test.mjs.
// Format and rules: .claude/plans/2026-11-07-word-explain.md, D2 (dict/w); 2026-11-23-word-panel-v2.md, D9 (dict/c), D11 (`n`);
// 2026-11-27-word-panel-settings.md, D6 (strict match), D7 (`xr` reading lists), D8 (sentence quality).
// The runtime reader is src/lib/lexicon.ts.

export const SHARDS = 128;
export const DEFAULTS = { examples: 6, minHan: 4, maxHan: 24, maxWord: 8, targetHan: 12 };

const HAN = /\p{Script=Han}/u;
const HAN_G = /\p{Script=Han}/gu;
const LATIN = /[A-Za-zＡ-Ｚａ-ｚ]/;

export const hanCount = (s) => (s.match(HAN_G) || []).length;
const len = (s) => [...s].length;
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** The FNV-1a of src/lib/import/build.ts (fnv1a), as a number. */
export function fnv1a(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const shardOf = (word) => fnv1a(word) % SHARDS;
export const shardName = (n) => n.toString(16).padStart(2, '0');

const normPinyin = (p) => p.trim().toLowerCase().replace(/u:/g, 'v').replace(/\s+/g, ' ');

/** "CL:個|个[ge4],本[ben3]" → ["个:ge4", "本:ben3"] */
function parseCl(def) {
  return def
    .slice(3)
    .split(',')
    .map((x) => /^(?:[^|[\]]+\|)?([^|[\]]+)\[([^\]]+)\]$/.exec(x.trim()))
    .filter(Boolean)
    .map((m) => `${m[1]}:${normPinyin(m[2])}`);
}

const LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s*\/(.*)\/\s*$/;

/**
 * CC-CEDICT text → entries { trad: string[], simp, pinyin, senses: string[], cl: string[] } in file order.
 * Pinyin lower case with u: → v; CL senses become measure words; entries with the same simplified form and pinyin are
 * merged; proper nouns (capitalised pinyin) are kept only for words without a common entry, flagged `proper: true`;
 * headwords longer than maxWord characters are dropped. Also returns the file date (#! date=…) when there is one.
 */
export function parseCedict(text, { maxWord = DEFAULTS.maxWord } = {}) {
  const bySimp = new Map();
  let date;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw) continue;
    if (raw.startsWith('#')) {
      const d = /^#!\s*date=(\d{4}-\d{2}-\d{2})/.exec(raw);
      if (d) date = d[1];
      continue;
    }
    const m = LINE.exec(raw.replace(/\u200b/g, ''));
    if (!m) continue;
    const [, trad, simp, py, body] = m;
    if (!HAN.test(simp) || len(simp) > maxWord) continue;
    const proper = /^[A-Z]/.test(py.trim());
    const pinyin = normPinyin(py);
    const senses = [];
    const cl = [];
    for (const d of body.split('/')) {
      const s = d.trim().replace(/\t/g, ' ');
      if (!s) continue;
      if (/^CL:/.test(s)) cl.push(...parseCl(s));
      else senses.push(s);
    }
    if (!senses.length) continue;
    let list = bySimp.get(simp);
    if (!list) bySimp.set(simp, (list = []));
    const same = list.find((e) => e.pinyin === pinyin && e.proper === proper);
    if (same) {
      if (!same.trad.includes(trad)) same.trad.push(trad);
      for (const s of senses) if (!same.senses.includes(s)) same.senses.push(s);
      for (const c of cl) if (!same.cl.includes(c)) same.cl.push(c);
    } else {
      list.push({ trad: [trad], simp, pinyin, senses, cl, proper });
    }
  }
  const entries = [];
  for (const list of bySimp.values()) {
    const common = list.filter((e) => !e.proper);
    for (const e of common.length ? common : list) {
      const out = { trad: e.trad, simp: e.simp, pinyin: e.pinyin, senses: e.senses, cl: e.cl };
      if (e.proper) out.proper = true;
      entries.push(out);
    }
  }
  return { entries, date };
}

/** Characters that appear in CEDICT traditional forms and never in a simplified form. */
export function tradOnlyChars(entries) {
  const simp = new Set();
  const trad = new Set();
  for (const e of entries) {
    for (const c of e.simp) simp.add(c);
    for (const t of e.trad) for (const c of t) if (HAN.test(c)) trad.add(c);
  }
  for (const c of simp) trad.delete(c);
  return trad;
}

/** public/dict/cfdict.tsv (simplified \t pinyin \t senses '/') → Map<simp, [pinyin, senses][]>. */
export function parseCfdictTsv(text, { maxWord = DEFAULTS.maxWord } = {}) {
  const out = new Map();
  for (const line of text.split(/\r?\n/)) {
    const [simp, py, senses] = line.split('\t');
    if (!simp || py === undefined || !senses || !HAN.test(simp) || len(simp) > maxWord) continue;
    let list = out.get(simp);
    if (!list) out.set(simp, (list = []));
    const pinyin = normPinyin(py);
    if (!list.some((x) => x[0] === pinyin && x[1] === senses)) list.push([pinyin, senses]);
  }
  return out;
}

/**
 * Mandarin sentences [id, text] worth showing: simplified only (no traditional-only character), minHan–maxHan Han
 * characters, no Latin letters. Sorted by id; the same text twice keeps the lowest id.
 */
export function filterSentences(sentences, { tradOnly = new Set(), minHan = DEFAULTS.minHan, maxHan = DEFAULTS.maxHan } = {}) {
  const seen = new Set();
  const out = [];
  for (const [id, raw] of [...sentences].sort((a, b) => a[0] - b[0])) {
    const zh = raw.trim();
    if (!zh || seen.has(zh) || LATIN.test(zh)) continue;
    const n = hanCount(zh);
    if (n < minHan || n > maxHan) continue;
    if ([...zh].some((c) => tradOnly.has(c))) continue;
    seen.add(zh);
    out.push([id, zh]);
  }
  return out;
}

const lowest = (ids, texts) => {
  let best;
  for (const id of ids ?? []) if (texts.has(id) && (best === undefined || id < best)) best = id;
  return best;
};

/**
 * Attach translations: { id, zh, en, fr } ('' when missing); sentences with neither are dropped.
 * links: Map<id, Set<id>> in both directions (any language); eng / fra: Map<id, text>.
 * English: the lowest linked eng id. French: the lowest directly linked fra id, else the lowest fra id linked to any
 * linked English sentence.
 */
export function attachTranslations(cmn, { links, eng, fra }) {
  const out = [];
  for (const [id, zh] of cmn) {
    const direct = links.get(id);
    const enId = lowest(direct, eng);
    let frId = lowest(direct, fra);
    if (frId === undefined) {
      for (const e of direct ?? []) {
        if (!eng.has(e)) continue;
        const f = lowest(links.get(e), fra);
        if (f !== undefined && (frId === undefined || f < frId)) frId = f;
      }
    }
    const en = enId === undefined ? '' : eng.get(enId);
    const fr = frId === undefined ? '' : fra.get(frId);
    if (en || fr) out.push({ id, zh, en, fr });
  }
  return out;
}

/** Record a link both ways. */
export function addLink(links, a, b) {
  let s = links.get(a);
  if (!s) links.set(a, (s = new Set()));
  s.add(b);
  let t = links.get(b);
  if (!t) links.set(b, (t = new Set()));
  t.add(a);
}

// ---------- segmentation and strict match (plan 2026-11-27-word-panel-settings, D6) ----------

/**
 * Intl.Segmenter over-merges (我会说中文 → 我|会说|中文, 吃了饭 is one segment). This wrapper re-splits every Han segment
 * of 2+ characters that is not itself a dictionary word into dictionary words: the fewest pieces, ties to the longest
 * first piece, single characters always allowed (会说 → 会|说, 我还没 → 我|还没). Segments that are words stay whole
 * (会议, 学生, 银行), so their characters don't count as the 1–2 character words 会, 学, 行.
 * segmenter: anything with Intl.Segmenter's segment() shape; words: Set of headwords (CC-CEDICT simplified forms).
 */
export function dictSegmenter(segmenter, words, { maxWord = DEFAULTS.maxWord } = {}) {
  const split = (cps) => {
    const n = cps.length;
    const best = Array(n + 1).fill(null);
    best[n] = [];
    for (let i = n - 1; i >= 0; i--) {
      for (let l = Math.min(maxWord, n - i); l >= 1; l--) {
        const w = cps.slice(i, i + l).join('');
        if (l > 1 && !words.has(w)) continue;
        const rest = best[i + l];
        if (rest && (!best[i] || rest.length + 1 < best[i].length)) best[i] = [w, ...rest];
      }
    }
    return best[0];
  };
  return {
    segment(text) {
      const out = [];
      for (const { segment } of segmenter.segment(text)) {
        const cps = [...segment];
        if (cps.length > 1 && !words.has(segment) && cps.some((c) => HAN.test(c))) for (const p of split(cps)) out.push({ segment: p });
        else out.push({ segment });
      }
      return out;
    },
  };
}

/**
 * Which headwords each sentence illustrates (index into sentences), D6 strict match: a word of 1–2 characters counts
 * only when it is a whole segment or the exact join of consecutive whole segments (会 in 我|会|说, not in 会议; 中文 in
 * 中|文); a word of 3+ characters counts anywhere in the sentence. Two-character words that only straddle a word
 * boundary (说中 in 他会说中文) are not counted.
 * Whatever the segmentation, a 1–2 character hit does not count where a 3+ character word of `guard` (default: the
 * headwords; buildShards passes the CC-CEDICT forms) covers it in the sentence: 会 in 音乐会, 得 in 不得不, 行 in
 * 多行不义必自毙.
 * segmenter: an Intl.Segmenter('zh', { granularity: 'word' }) (best wrapped in dictSegmenter) or anything with the same
 * segment() shape. at (optional): Map<word, Map>; for the words that are keys, the code-point starts of every hit go
 * into at.get(word) as sentence index → starts (used for the reading check, D7).
 */
export function indexSentences(sentences, headwords, segmenter, { maxWord = DEFAULTS.maxWord, at, guard = headwords } = {}) {
  const index = new Map();
  sentences.forEach((s, i) => {
    const chars = [...s.zh];
    // spans [a, b) of 3+ character guard words
    const cover = [];
    for (let a = 0; a < chars.length; a++) {
      if (!HAN.test(chars[a])) continue;
      for (let n = 3; n <= maxWord && a + n <= chars.length; n++) if (guard.has(chars.slice(a, a + n).join(''))) cover.push([a, a + n]);
    }
    const hits = new Map(); // word → starts
    const hit = (w, start) => {
      const n = [...w].length;
      if (n < 3 && cover.some(([a, b]) => a <= start && start + n <= b)) return;
      let l = hits.get(w);
      if (!l) hits.set(w, (l = []));
      if (!l.includes(start)) l.push(start);
    };
    const segs = [];
    let pos = 0;
    for (const { segment } of segmenter.segment(s.zh)) {
      const cps = [...segment];
      segs.push({ start: pos, cps });
      pos += cps.length;
    }
    for (let a = 0; a < segs.length; a++) {
      let w = '';
      let n = 0;
      for (let b = a; b < segs.length; b++) {
        n += segs[b].cps.length;
        if (n > 2) break;
        w += segs[b].cps.join('');
        if (HAN.test(w) && headwords.has(w)) hit(w, segs[a].start);
      }
    }
    for (let a = 0; a < chars.length; a++) {
      if (!HAN.test(chars[a])) continue;
      for (let n = 3; n <= maxWord && a + n <= chars.length; n++) {
        const w = chars.slice(a, a + n).join('');
        if (headwords.has(w)) hit(w, a);
      }
    }
    for (const w of [...hits.keys()].sort(cmp)) {
      let list = index.get(w);
      if (!list) index.set(w, (list = []));
      list.push(i);
      if (at?.has(w)) at.get(w).set(i, hits.get(w).sort((x, y) => x - y));
    }
  });
  return index;
}

// ---------- sentence quality (D8) ----------

/** Tatoeba tags that mean "this sentence may be wrong": such sentences are dropped. */
export const DOUBTFUL_TAGS = ['@change', '@check', '@needs native check', '@delete', '@delete maybe'];
/** The tag that says a sentence was checked. */
export const OK_TAG = 'OK';
const normTag = (t) => String(t).trim().toLowerCase().replace(/\s+/g, ' ');
const DOUBTFUL = new Set(DOUBTFUL_TAGS.map(normTag));

/** A sentence's tags (any iterable of tag names) contain a doubtful one. */
export const isDoubtful = (tags) => !!tags && [...tags].some((t) => DOUBTFUL.has(normTag(t)));

/** Usernames that give Mandarin (cmn) skill level 5 in user_languages rows [lang, skillLevel, username, …]. */
export function nativeSpeakers(rows) {
  const out = new Set();
  for (const [lang, level, user] of rows) if (lang === 'cmn' && String(level).trim() === '5' && user && user !== '\\N') out.add(user);
  return out;
}

/**
 * D8 flags on attachTranslations(...) sentences: native (owner is a native Mandarin speaker), audio, ok (tagged OK).
 * Sentences with a doubtful tag are dropped. owners: Map<id, username>; natives: Set<username>; audio: Set<id>;
 * tags: Map<id, Set<tag>>. Returns { kept, dropped } (dropped: the number left out). The flags only rank; they are
 * never written to the shards.
 */
export function markQuality(sentences, { owners = new Map(), natives = new Set(), audio = new Set(), tags = new Map() } = {}) {
  const kept = [];
  let dropped = 0;
  const ok = normTag(OK_TAG);
  for (const s of sentences) {
    const t = tags.get(s.id);
    if (isDoubtful(t)) {
      dropped++;
      continue;
    }
    const out = { ...s };
    const owner = owners.get(s.id);
    if (owner && natives.has(owner)) out.native = true;
    if (audio.has(s.id)) out.audio = true;
    if (t && [...t].some((x) => normTag(x) === ok)) out.ok = true;
    kept.push(out);
  }
  return { kept, dropped };
}

/**
 * Best examples first: the D8 quality boosts (native owner, audio, OK tag: one point each, most points first), then
 * both en and fr, then length closest to targetHan Han characters, then lowest id.
 */
export function rankExamples(idxs, sentences, { examples = DEFAULTS.examples, targetHan = DEFAULTS.targetHan } = {}) {
  const key = (i) => {
    const s = sentences[i];
    return [-((s.native ? 1 : 0) + (s.audio ? 1 : 0) + (s.ok ? 1 : 0)), s.en && s.fr ? 0 : 1, Math.abs(hanCount(s.zh) - targetHan), s.id];
  };
  return [...idxs]
    .map((i) => ({ i, k: key(i) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2] || a.k[3] - b.k[3])
    .slice(0, examples)
    .map((x) => x.i);
}

// ---------- reading check (D7) ----------

// The syllable list of src/lib/pinyin.ts (SYLLABLES), for reading Tatoeba's pinyin transcriptions; a test keeps them equal.
export const SYLLABLE_LIST =
  'a ai an ang ao ba bai ban bang bao bei ben beng bi bian biao bie bin bing bo bu ca cai can cang cao ce cen ceng cha chai chan chang chao che chen cheng chi chong chou chu chua chuai chuan chuang chui chun chuo ci cong cou cu cuan cui cun cuo da dai dan dang dao de dei den deng di dia dian diao die ding diu dong dou du duan dui dun duo e ei en eng er fa fan fang fei fen feng fo fou fu ga gai gan gang gao ge gei gen geng gong gou gu gua guai guan guang gui gun guo ha hai han hang hao he hei hen heng hong hou hu hua huai huan huang hui hun huo ji jia jian jiang jiao jie jin jing jiong jiu ju juan jue jun ka kai kan kang kao ke kei ken keng kong kou ku kua kuai kuan kuang kui kun kuo la lai lan lang lao le lei leng li lia lian liang liao lie lin ling liu lo long lou lu luan lun luo lv lve ma mai man mang mao me mei men meng mi mian miao mie min ming miu mo mou mu na nai nan nang nao ne nei nen neng ni nian niang niao nie nin ning niu nong nou nu nuan nuo nv nve o ou pa pai pan pang pao pei pen peng pi pian piao pie pin ping po pou pu qi qia qian qiang qiao qie qin qing qiong qiu qu quan que qun ran rang rao re ren reng ri rong rou ru ruan rui run ruo sa sai san sang sao se sen seng sha shai shan shang shao she shei shen sheng shi shou shu shua shuai shuan shuang shui shun shuo si song sou su suan sui sun suo ta tai tan tang tao te tei teng ti tian tiao tie ting tong tou tu tuan tui tun tuo wa wai wan wang wei wen weng wo wu xi xia xian xiang xiao xie xin xing xiong xiu xu xuan xue xun ya yan yang yao ye yi yin ying yo yong you yu yuan yue yun za zai zan zang zao ze zei zen zeng zha zhai zhan zhang zhao zhe zhei zhen zheng zhi zhong zhou zhu zhua zhuai zhuan zhuang zhui zhun zhuo zi zong zou zu zuan zui zun zuo m n ng hm hng r';
const SYL = new Set(SYLLABLE_LIST.split(' '));
const MARK = {};
for (const [base, marks] of [['a', 'āáǎà'], ['e', 'ēéěè'], ['i', 'īíǐì'], ['o', 'ōóǒò'], ['u', 'ūúǔù'], ['v', 'ǖǘǚǜ']]) [...marks].forEach((c, i) => (MARK[c] = [base, i + 1]));

/**
 * A Tatoeba pinyin transcription (tone numbers, tone marks or both; words written together: Zhong1wen2, Zhōngwén) →
 * one numbered syllable per Han character (neutral tone 5), or null when it doesn't split into exactly `n` syllables.
 */
export function parseTranscription(text, n) {
  const out = [];
  for (const chunk of String(text).normalize('NFC').toLowerCase().replace(/[uü]:/g, 'v').replace(/ü/g, 'v').split(/[^a-zāáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ1-5]+/)) {
    if (!chunk) continue;
    // letters with their tone (from a mark, or a digit after the syllable); a digit also ends a syllable
    let run = [];
    const flush = () => {
      if (!run.length) return true;
      // split the run into syllables: fewest syllables, longest first
      const m = run.length;
      const best = Array(m + 1).fill(null);
      best[m] = [];
      for (let i = m - 1; i >= 0; i--) {
        for (let l = Math.min(6, m - i); l >= 1; l--) {
          if (!best[i + l] || !SYL.has(run.slice(i, i + l).map((x) => x.c).join(''))) continue;
          if (!best[i] || best[i + l].length + 1 < best[i].length) best[i] = [[i, l], ...best[i + l]];
        }
      }
      if (!best[0]) return false;
      for (const [i, l] of best[0]) {
        const part = run.slice(i, i + l);
        out.push(`${part.map((x) => x.c).join('')}${part.reduce((t, x) => x.t || t, 0) || 5}`);
      }
      run = [];
      return true;
    };
    for (const c of chunk) {
      if (/[1-5]/.test(c)) {
        if (!run.length) return null;
        run[run.length - 1].t = Number(c);
        if (!flush()) return null;
      } else run.push(MARK[c] ? { c: MARK[c][0], t: MARK[c][1] } : { c, t: 0 });
    }
    if (!flush()) return null;
  }
  return out.length === n ? out : null;
}

/**
 * Reader for the reading check (D7): read(s) → { syl, reviewed }, syl = one numbered syllable per code point of zh ('' for
 * non-Han), reviewed = it comes from a reviewed Tatoeba transcription; alone(text) → pinyin-pro's reading of the text
 * on its own (its default, for telling a reading found in context from one it falls back to).
 * transcriptions: Map<id, string[]> (parseTranscription output, one per Han character, reviewed only), used first;
 * then pinyin, the pinyin function of pinyin-pro, on the whole sentence (context; tone sandhi off, as lineReadings in
 * src/lib/lexicon.ts). null when there is neither.
 */
export function makeReader({ pinyin, transcriptions = new Map() } = {}) {
  if (!pinyin && !transcriptions.size) return null;
  const nums = (text) => {
    const cps = [...text];
    if (!pinyin) return cps.map(() => '');
    const out = [];
    for (const r of pinyin(text, { toneType: 'num', type: 'all', v: true, toneSandhi: false })) {
      const o = [...r.origin];
      if (r.isZh && o.length === 1 && r.pinyin) out.push(r.pinyin.replace(/0$/, '5'));
      else out.push(...o.map(() => ''));
    }
    while (out.length < cps.length) out.push('');
    return out.slice(0, cps.length);
  };
  const alone = new Map();
  return {
    read(s) {
      const t = transcriptions.get(s.id);
      if (t) {
        let k = 0;
        const syl = [...s.zh].map((c) => (HAN.test(c) ? t[k++] ?? '' : ''));
        if (k === t.length) return { syl, reviewed: true };
      }
      return { syl: nums(s.zh), reviewed: false };
    },
    alone(text) {
      let r = alone.get(text);
      if (!r) alone.set(text, (r = nums(text)));
      return r;
    },
  };
}

/**
 * Which of a word's CC-CEDICT readings a read occurrence is: syls (one numbered syllable per character) against
 * readings ('hang2', 'xing2'): the exact reading, else the only reading with the same letters (a light tone written
 * with a tone: xue2 sheng1 → xue2 sheng5). null when unsure.
 */
export function matchReading(syls, readings) {
  if (!syls.length || syls.some((x) => !x)) return null;
  const got = syls.join(' ');
  if (readings.includes(got)) return got;
  const letters = (r) => r.split(' ').map((x) => x.replace(/[0-5]$/, '')).join(' ');
  const gl = letters(got);
  const same = readings.filter((r) => letters(r) === gl);
  return same.length === 1 ? same[0] : null;
}

/** Words whose reading pinyin-pro can't be trusted with, whatever their readings: only a reviewed transcription counts. */
export const UNRELIABLE_READING = new Set(['了']);

/** Two readings of the word differ only by tone (de2 / de5, zhi1 / zhi3, liao3 / liao4). */
const sharesLetters = (readings) => {
  const l = readings.map((r) => r.split(' ').map((x) => x.replace(/[0-5]$/, '')).join(' '));
  return new Set(l).size < l.length;
};

/**
 * The reading of a word at one hit (D7), or null (unsure: the sentence goes to no `xr` list).
 * word, readings: its CC-CEDICT readings; s: the sentence; start: code-point start of the hit; reader: makeReader(...);
 * compounds: Map<word, readings[]> of CC-CEDICT words (2+ characters) for the lexical override.
 * - A reviewed transcription decides (exact reading, else the only one with the same letters).
 * - Else, for a word with readings that differ only by tone, or in UNRELIABLE_READING (了): unsure.
 * - Else pinyin-pro in context, when it reads the word differently from the word on its own (the context decided).
 *   When it gives the word's own default, the context said nothing: the reading comes from a longer CC-CEDICT word of
 *   the sentence covering the hit (睡觉 → jiao4, 银行 → hang2), when all such words agree; otherwise unsure.
 */
export function readingAt({ word, readings, s, start, reader, compounds = new Map(), maxWord = DEFAULTS.maxWord }) {
  const n = [...word].length;
  const { syl, reviewed } = reader.read(s);
  const at = syl.slice(start, start + n);
  if (reviewed) return matchReading(at, readings);
  if (UNRELIABLE_READING.has(word) || sharesLetters(readings)) return null;
  const own = reader.alone(word);
  if (at.join(' ') !== own.join(' ')) return matchReading(at, readings);
  const chars = [...s.zh];
  const found = new Set();
  for (let a = Math.max(0, start + n - maxWord); a <= start; a++) {
    for (let b = start + n; b <= Math.min(chars.length, a + maxWord); b++) {
      if (b - a <= n) continue;
      const rs = compounds.get(chars.slice(a, b).join(''));
      if (!rs) continue;
      for (const r of rs) {
        const p = r.split(' ');
        if (p.length !== b - a) continue;
        const m = matchReading(p.slice(start - a, start - a + n), readings);
        found.add(m);
      }
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

/**
 * Build the shard files.
 * cedict: parseCedict(...).entries; cfdict: parseCfdictTsv(...); sentences: attachTranslations(...) output, optionally
 * with markQuality(...) flags; reader (D7, optional): makeReader(...). With a reader, a word with 2+ CC-CEDICT readings
 * gets `xr`: reading → its examples (indices into `s`, ranked and capped like `x`), from readingAt for each hit; a list
 * of fewer than 2 sentences or equal to `x` is left out (the app falls back to `x`), and index.xr is true.
 * Returns { files: Map<'00.json'…'7f.json', string>, index } with deterministic bytes (sorted words, stable order).
 */
export function buildShards({ cedict, cfdict = new Map(), sentences = [], segmenter, reader, built, sample = false, sources = [], options = {} }) {
  const opt = { ...DEFAULTS, ...options };
  const words = new Map(); // simp → { e, f }
  for (const e of cedict) {
    let w = words.get(e.simp);
    if (!w) words.set(e.simp, (w = { e: [], f: [] }));
    const row = [e.pinyin, e.senses.join('/')];
    if (e.cl.length) row.push(e.cl.join(','));
    w.e.push(row);
  }
  for (const [simp, list] of cfdict) {
    let w = words.get(simp);
    if (!w) words.set(simp, (w = { e: [], f: [] }));
    for (const [py, senses] of list) w.f.push([py, senses]);
  }
  const headwords = new Set(words.keys());
  // D7: words with several CC-CEDICT readings, and where each of their hits is
  const poly = new Map();
  if (reader) {
    for (const [simp, w] of words) {
      const rs = [...new Set(w.e.map((r) => r[0]))];
      if (rs.length > 1) poly.set(simp, rs);
    }
  }
  const at = new Map([...poly.keys()].map((w) => [w, new Map()]));
  const cedictForms = new Set(cedict.map((e) => e.simp));
  const hits = segmenter ? indexSentences(sentences, headwords, segmenter, { ...opt, at, guard: cedictForms }) : new Map();
  // the lexical override (readingAt) reads CC-CEDICT words of 2+ characters; one read per sentence
  const compounds = new Map();
  if (reader) for (const [simp, w] of words) if ([...simp].length > 1 && w.e.length) compounds.set(simp, [...new Set(w.e.map((r) => r[0]))]);
  const readCache = new Map();
  const cached = reader && {
    read: (s) => {
      let r = readCache.get(s);
      if (!r) readCache.set(s, (r = reader.read(s)));
      return r;
    },
    alone: (t) => reader.alone(t),
  };
  const xrStats = { words: 0, lists: 0, read: 0, unsure: 0 };
  /** reading → sentence indices for a polyphonic word, in CC-CEDICT order; a sentence can carry two readings. */
  const byReading = (simp) => {
    const rs = poly.get(simp);
    const out = new Map(rs.map((r) => [r, []]));
    for (const [i, starts] of at.get(simp) ?? []) {
      for (const st of starts) {
        const r = readingAt({ word: simp, readings: rs, s: sentences[i], start: st, reader: cached, compounds, maxWord: opt.maxWord });
        if (r === null) {
          xrStats.unsure++;
          continue;
        }
        xrStats.read++;
        const l = out.get(r);
        if (l[l.length - 1] !== i) l.push(i);
      }
    }
    return out;
  };

  const byShard = Array.from({ length: SHARDS }, () => []);
  for (const simp of [...words.keys()].sort(cmp)) byShard[shardOf(simp)].push(simp);

  const files = new Map();
  let bytes = 0;
  let biggest = 0;
  const used = new Set();
  let withExamples = 0;
  for (let n = 0; n < SHARDS; n++) {
    const s = [];
    const pos = new Map(); // sentence index → position in s
    const w = {};
    for (const simp of byShard[n]) {
      const src = words.get(simp);
      const entry = {};
      if (src.e.length) entry.e = src.e;
      if (src.f.length) entry.f = src.f;
      const best = hits.has(simp) ? rankExamples(hits.get(simp), sentences, opt) : [];
      const place = (i) => {
        if (!pos.has(i)) {
          const t = sentences[i];
          pos.set(i, s.length);
          s.push([t.id, t.zh, t.en || '', t.fr || '']);
          used.add(t.id);
        }
        return pos.get(i);
      };
      if (best.length) {
        entry.x = best.map(place);
        withExamples++;
        if (poly.has(simp)) {
          const xr = {};
          for (const [r, list] of byReading(simp)) {
            // fewer than 2 sentences, or the same list as x: left out (the app shows x)
            const ranked = list.length >= 2 ? rankExamples(list, sentences, opt) : [];
            if (!ranked.length || (ranked.length === best.length && ranked.every((i, k) => i === best[k]))) continue;
            xr[r] = ranked.map(place);
            xrStats.lists++;
          }
          if (Object.keys(xr).length) {
            entry.xr = xr;
            xrStats.words++;
          }
        }
      }
      w[simp] = entry;
    }
    const json = JSON.stringify({ v: 1, s, w });
    const size = Buffer.byteLength(json);
    bytes += size;
    biggest = Math.max(biggest, size);
    files.set(`${shardName(n)}.json`, json);
  }
  const index = { v: 1, shards: SHARDS, built };
  if (sample) index.sample = true;
  Object.assign(index, { words: words.size, sentences: used.size, bytes, sources });
  if (reader) index.xr = true;
  const freq = new Map();
  for (const [w, list] of hits) freq.set(w, list.length);
  const stats = { words: words.size, withExamples, sentences: used.size, bytes, biggest };
  if (reader) stats.xr = { polyphones: poly.size, ...xrStats };
  return { files, index, stats, freq };
}

// ---------- character index: public/dict/c (plan 2026-11-23-word-panel-v2, D9) ----------

export const CHAR_SHARDS = 64;
export const charShardOf = (key) => fnv1a(key) % CHAR_SHARDS;
/**
 * perChar: words kept per character. properMin: Tatoeba count from which a proper-noun-only word (every CEDICT reading
 * capitalised: 中文, 汤博乐 Tumblr) is listed anyway; Infinity = never.
 */
export const CHAR_DEFAULTS = { perChar: 24, properMin: 10 };

/** Code-point order (JS string < compares UTF-16 units, which differs for characters outside the BMP). */
const cmpCp = (a, b) => {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
};

// Senses that only point elsewhere or name someone (English from CC-CEDICT, French from CFDICT).
const NAME_SENSE = [
  /\((?:[\w\s'-]*\s)?(?:name|surname)\)$/i, // Tom (name), Zhang (Japanese surname)
  /^(?:[\w-]+\s)?(?:surname|given name|personal name)\b/i, // surname Zhang, Japanese surname Ito
  /^nom (?:de famille|propre|de personne)\b/i,
  /^(?:prénom|patronyme)\b/i,
  /\((?:nom|prénom|nom de famille)\)$/i,
];
const REF_SENSE = [
  /^(?:[\w-]+\s){0,2}variant of\b/i, // variant of, old variant of, Japanese variant of
  /^see(?: also)?\b/i,
  /^same as\b/i,
  /^(?:Taiwan |also )pr\./i,
  /^(?:\S+\s)?variante (?:de|graphique)\b/i,
  /^voir\b/i,
];
const isName = (s) => NAME_SENSE.some((r) => r.test(s.trim()));
const isRef = (s) => REF_SENSE.some((r) => r.test(s.trim()));
const sensesOf = (senses) => (Array.isArray(senses) ? senses : String(senses).split('/')).map((s) => s.trim()).filter(Boolean);

/** Every sense is a name, surname, variant or cross-reference (or there is none). Takes an array or a '/' string. */
export function isNameOrVariant(senses) {
  return sensesOf(senses).every((s) => isName(s) || isRef(s));
}

/**
 * Short meaning for a chip: the first sense that is not a cross-reference, variant or name; CEDICT references like
 * 樂|乐[le4] become 乐. At most `max` characters, cut at a word boundary with "…". '' when nothing is left.
 */
export function shortGloss(senses, max = 32) {
  const first = sensesOf(senses).find((s) => !isName(s) && !isRef(s));
  if (!first) return '';
  const s = first
    .replace(/(?:[^\s|[\]/,;()]+\|)?([^\s|[\]/,;()]+)\[[^\]]+\]/gu, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const cps = [...s];
  if (cps.length <= max) return s;
  const head = cps.slice(0, max - 1).join('');
  // cut at the last space or punctuation that leaves something; CJK text has no spaces, so cut anywhere then
  const at = Math.max(head.lastIndexOf(' '), head.lastIndexOf(','), head.lastIndexOf(';'));
  return `${(at > 0 ? head.slice(0, at) : head).replace(/[\s,;:(]+$/, '')}…`;
}

const ALL_HAN = /^\p{Script=Han}+$/u;

/** CC-CEDICT entries grouped by simplified form, in file order. */
function groupCedict(cedict) {
  const ced = new Map();
  for (const e of cedict) {
    let l = ced.get(e.simp);
    if (!l) ced.set(e.simp, (l = []));
    l.push(e);
  }
  return ced;
}

/**
 * The D9 "common word" test, without the length rule: Han only, a Tatoeba count or a CFDICT entry, and not only proper
 * nouns unless frequent (properMin). ce: the word's CC-CEDICT entries (required); n: its count; cf: its CFDICT rows.
 */
const isCommon = (w, ce, n, cf, properMin) =>
  ALL_HAN.test(w) && (n >= 1 || cf.length > 0) && !(ce.every((x) => x.proper) && !(n >= properMin));

/**
 * Build public/dict/c: for each character, the common words containing it, best first (D9).
 * A listed word needs a CC-CEDICT entry (CFDICT alone is mostly phrases: 很好, 学生们) that is not only a proper noun,
 * a name or a variant; CFDICT only adds the French gloss and the ranking bonus. Its reading is the usable CEDICT
 * reading with the most real senses, ties in file order (好处 hao3 chu5 "benefit", not hao3 chu4).
 * cedict: parseCedict(...).entries; cfdict: parseCfdictTsv(...); freq: buildShards(...).freq (sentences per word);
 * similar (B3, optional): Map<word, string[]> written as `n` in the word's shard.
 * Returns { files: Map<'00.json'…'3f.json', string>, index, stats: { chars, words, bytes, biggest } }, deterministic bytes.
 */
export function buildCharIndex({ cedict, cfdict = new Map(), freq = new Map(), similar, built, sample = false, options = {} }) {
  const opt = { ...CHAR_DEFAULTS, ...options };
  const ced = groupCedict(cedict); // simp → entries
  const realSenses = (senses) => sensesOf(senses).filter((x) => !isName(x) && !isRef(x)).length;
  const common = []; // { w, n, cf, len, row }
  for (const [w, ce] of ced) {
    const cps = [...w];
    if (cps.length < 2) continue;
    const n = freq.get(w) ?? 0;
    const cf = cfdict.get(w) ?? [];
    if (!isCommon(w, ce, n, cf, opt.properMin)) continue;
    let e;
    let best = 0;
    for (const x of ce) {
      const k = realSenses(x.senses);
      if (k > best) [e, best] = [x, k];
    }
    if (!e) continue;
    const en = shortGloss(e.senses);
    const f = cf.find((x) => x[0] === e.pinyin && !isNameOrVariant(x[1])) ?? cf.find((x) => !isNameOrVariant(x[1]));
    const fr = f ? shortGloss(f[1]) : '';
    common.push({ w, n, cf: cf.length > 0, len: cps.length, row: fr ? [w, e.pinyin, en, fr] : [w, e.pinyin, en] });
  }
  common.sort((a, b) => b.n - a.n || (b.cf ? 1 : 0) - (a.cf ? 1 : 0) || a.len - b.len || cmpCp(a.w, b.w));

  const byChar = new Map();
  for (const c of common) {
    for (const ch of new Set(c.w)) {
      let l = byChar.get(ch);
      if (!l) byChar.set(ch, (l = []));
      if (l.length < opt.perChar) l.push(c.row);
    }
  }
  const byShard = Array.from({ length: CHAR_SHARDS }, () => ({ c: [], n: [] }));
  const listed = new Set();
  for (const ch of [...byChar.keys()].sort(cmpCp)) {
    byShard[charShardOf(ch)].c.push(ch);
    for (const r of byChar.get(ch)) listed.add(r[0]);
  }
  let nSimilar = 0;
  if (similar) {
    for (const w of [...similar.keys()].sort(cmpCp)) {
      if (!similar.get(w)?.length) continue;
      byShard[charShardOf(w)].n.push(w);
      nSimilar++;
    }
  }
  const files = new Map();
  let bytes = 0;
  let biggest = 0;
  let similarBytes = 0;
  for (let s = 0; s < CHAR_SHARDS; s++) {
    const c = {};
    for (const ch of byShard[s].c) c[ch] = byChar.get(ch);
    const file = { v: 1, c };
    if (similar) {
      const n = {};
      for (const w of byShard[s].n) n[w] = similar.get(w);
      file.n = n;
      similarBytes += Buffer.byteLength(JSON.stringify(n));
    }
    const json = JSON.stringify(file);
    const size = Buffer.byteLength(json);
    bytes += size;
    biggest = Math.max(biggest, size);
    files.set(`${shardName(s)}.json`, json);
  }
  const index = { v: 1, shards: CHAR_SHARDS, built };
  if (sample) index.sample = true;
  Object.assign(index, { chars: byChar.size, words: listed.size, bytes });
  if (similar) index.similar = nSimilar;
  const stats = { chars: byChar.size, words: listed.size, bytes, biggest };
  if (similar) Object.assign(stats, { similar: nSimilar, similarBytes });
  return { files, index, stats };
}

// ---------- similar meaning: `n` in public/dict/c (plan 2026-11-23-word-panel-v2, D11) ----------

/**
 * maxDf/minDf: a meaning counts when 2–40 common words share it; perWord: similar words kept per word; freqWeight: the
 * Tatoeba bonus that settles near-ties (rank = score × (1 + freqWeight × log2(1 + count)): +3 % for 1 sentence, +20 %
 * for 100, +30 % for 1,000), so a common word passes a rare one with a slightly rarer shared meaning, but not one that
 * shares more meanings. minCount: a word in at least this many Tatoeba sentences gets no candidate that is in none
 * (plan 2026-11-27, WP6: 发轫 for 开始).
 */
export const SIMILAR_DEFAULTS = { maxDf: 40, minDf: 2, perWord: 4, properMin: CHAR_DEFAULTS.properMin, freqWeight: 0.03, minCount: 5 };

// Placeholders and leading words that don't change a meaning: "to help sb" = "help", "un ami" = "ami".
const GLOSS_NOISE = /(?:^|\s)(?:sb|sth|qqn|qqch|qn|qch|qc)(?:'s)?(?=\s|$)|\betc\b\.?/gu;
const GLOSS_LEAD = {
  en: /^(?:to\s+)?(?:(?:a|an|the)\s+)?/u,
  fr: /^(?:(?:le|la|les|un|une|des|du)\s+|l['’]\s*)/u,
};
const GLOSS_TRIM = /^[\s.,;:!?…"'“”«»‘’-]+|[\s.,;:!?…"'“”«»‘’-]+$/gu;

function normGloss(sense, lang) {
  const s = sense.trim();
  if (!s || isName(s) || isRef(s)) return '';
  let t = s.toLowerCase();
  // parentheses (also nested, once), CEDICT readings [hao3]
  for (let i = 0; i < 2; i++) t = t.replace(/\([^()]*\)|（[^（）]*）/gu, ' ');
  t = t.replace(/\[[^\]]*\]/g, ' ');
  if (HAN.test(t)) return ''; // still points at another word: abbr. for 北京大学, used in 枇杷
  t = t
    .replace(/^\s*(?:lit|fig)\.\s*/u, '')
    .replace(GLOSS_NOISE, ' ')
    .replace(/\s+/g, ' ')
    .replace(GLOSS_TRIM, '');
  t = t.replace(GLOSS_LEAD[lang], '').replace(GLOSS_TRIM, '');
  return /\p{L}/u.test(t) ? t : '';
}

/**
 * Normalised meanings of a word, as keys 'en:help', 'fr:aider' (D11): lower case, no parentheses, no leading "to" or
 * article, no sb/sth placeholders; names, variants and cross-references give no key. Senses are split on '/' and ';'.
 * Takes arrays or '/' strings; unique keys, English first, in sense order.
 */
export function glossKeys(enSenses, frSenses) {
  const out = new Set();
  for (const [lang, senses] of [['en', enSenses], ['fr', frSenses]]) {
    for (const sense of sensesOf(senses ?? [])) {
      for (const part of sense.split(/[;；]/)) {
        const k = normGloss(part, lang);
        if (k) out.add(`${lang}:${k}`);
      }
    }
  }
  return [...out];
}

/**
 * Words that share a dictionary meaning (D11), for each common word: the D9 rules (a CC-CEDICT entry; a Tatoeba count or
 * a CFDICT entry; rare proper nouns out), single characters included. English senses come from every CC-CEDICT reading,
 * French from every CFDICT row. A meaning counts when minDf–maxDf words share it; score = Σ 1/log2(1 + df) over the
 * shared meanings, times the Tatoeba bonus (freqWeight); ties by Tatoeba count, then code point. A word of 2 or more
 * characters gets no single-character candidates: those are mostly bound morphemes (朋, 识, 始) that the Characters
 * section already shows; a single character keeps them. Never offered: slang, dialect, old and bookish words (every
 * sense literary/archaic/classical/old, or one sense marked formal), and words in no Tatoeba sentence when the word
 * itself is in minCount or more. Returns Map<word, string[]> (≤ perWord, best first), only for words with at least one
 * similar word; deterministic.
 */
const ODD_SENSE = /^\((?:Internet |coll\. |)slang|^\((?:dialect|old|archaic|Cantonese|Taiwanese|Tw)\b/i;
// Bookish words (the 发轫 for 开始 noise, plan 2026-11-27 WP6): every sense literary, archaic, classical or old, or a
// single sense marked formal.
const BOOKISH_SENSE = /^\((?:literary|archaic|classical|old)\b/i;
const FORMAL_SENSE = /^\(formal\)/i;
const bookish = (senses) => senses.length > 0 && (senses.every((t) => BOOKISH_SENSE.test(t)) || (senses.length === 1 && FORMAL_SENSE.test(senses[0])));

export function buildSimilar({ cedict, cfdict = new Map(), freq = new Map(), options = {} }) {
  const opt = { ...SIMILAR_DEFAULTS, ...options };
  const words = []; // { w, n, keys, one: a single character }
  for (const [w, ce] of groupCedict(cedict)) {
    const n = freq.get(w) ?? 0;
    const cf = cfdict.get(w) ?? [];
    if (!isCommon(w, ce, n, cf, opt.properMin)) continue;
    const keys = glossKeys(ce.flatMap((x) => x.senses), cf.flatMap((x) => sensesOf(x[1])));
    // Slang, dialect and old words (every sense marked so, 盆友 "(Internet slang) friend") get a row but are never
    // offered as a similar word: Hugo should not pick them up in place of the common word.
    const all = ce.flatMap((x) => x.senses);
    const odd = all.every((t) => ODD_SENSE.test(t)) || bookish(all);
    if (keys.length) words.push({ w, n, keys, one: [...w].length === 1, odd });
  }
  words.sort((a, b) => cmpCp(a.w, b.w));
  const post = new Map(); // key → word indexes
  words.forEach((x, i) => {
    for (const k of x.keys) {
      let l = post.get(k);
      if (!l) post.set(k, (l = []));
      l.push(i);
    }
  });
  const out = new Map();
  words.forEach((x, i) => {
    const score = new Map();
    const one = x.one;
    for (const k of [...x.keys].sort()) {
      const l = post.get(k);
      if (l.length < opt.minDf || l.length > opt.maxDf) continue;
      const wgt = 1 / Math.log2(1 + l.length);
      for (const j of l) {
        if (j === i || words[j].odd || (!one && words[j].one)) continue;
        // a word never seen in Tatoeba is not offered for a word seen often (minCount): rare or bookish
        if (words[j].n === 0 && x.n >= opt.minCount) continue;
        score.set(j, (score.get(j) ?? 0) + wgt);
      }
    }
    if (!score.size) return;
    // rounded, so sums of the same weights in another order still tie
    const ranked = [...score].map(([j, s]) => ({ j, s: Math.round(s * (1 + opt.freqWeight * Math.log2(1 + words[j].n)) * 1e9) }));
    ranked.sort((a, b) => b.s - a.s || words[b.j].n - words[a.j].n || cmpCp(words[a.j].w, words[b.j].w));
    out.set(x.w, ranked.slice(0, opt.perWord).map((r) => words[r.j].w));
  });
  return out;
}

/** Is an existing dict/c index (with all its shard files, `present`) good enough to reuse alongside dict/w? */
export function charReusable(index, { present = true, sample = false, minChars = 0 } = {}) {
  if (!index || index.v !== 1 || index.shards !== CHAR_SHARDS) return { ok: false, why: 'no usable character index' };
  if (typeof index.similar !== 'number') return { ok: false, why: 'character index without similar words' };
  if (!present) return { ok: false, why: 'character index shards missing' };
  if (!!index.sample !== sample) return { ok: false, why: index.sample ? 'sample character index' : 'real character index in a sample run' };
  if (!sample && !(index.chars >= minChars)) return { ok: false, why: 'implausible character count' };
  return { ok: true };
}

/** Is an existing index.json good enough to reuse? */
export function reusable(index, { sample = false, minWords = 0, minSentences = 0, today, maxAgeDays = 30 } = {}) {
  if (!index || index.v !== 1 || index.shards !== SHARDS) return { ok: false, why: 'no usable index' };
  // a build from before the strict match, quality ranking and reading lists (plan 2026-11-27, D6–D8) is rebuilt
  if (index.xr !== true) return { ok: false, why: 'index without reading lists' };
  if (!!index.sample !== sample) return { ok: false, why: index.sample ? 'sample data' : 'real data in a sample run' };
  if (!sample && (index.words < minWords || index.sentences < minSentences)) return { ok: false, why: 'implausible counts' };
  const age = (Date.parse(today) - Date.parse(index.built)) / 86400000;
  if (!(age >= 0 && age < maxAgeDays)) return { ok: false, stale: true, why: `built ${index.built}` };
  return { ok: true };
}

export const SOURCES_TITLE = {
  w: 'Hugo 中文: offline dictionary and example sentences (dict/w/*.json)',
  c: 'Hugo 中文: common words for each character (dict/c/*.json), ranked by Tatoeba sentence counts',
};

/** SOURCES.txt for a build: index needs `built` and `sources`; title defaults to the dict/w one. */
export function sourcesText(index, title = SOURCES_TITLE.w) {
  const lines = [
    title,
    `Built ${index.built}. Adapted: filtered and reformatted from the sources below.`,
    '',
  ];
  for (const s of index.sources) {
    lines.push(`${s.name}${s.date ? ` (${s.date})` : ''}`, `  ${s.url}`, `  Licence: ${s.licence} ${s.licenceUrl}`, '');
  }
  return lines.join('\n');
}
