// Pure functions for scripts/build-lexicon.mjs (no I/O), tested in scripts/lexicon-lib.test.mjs.
// Format and rules: .claude/plans/2026-11-07-word-explain.md, D2 (dict/w); 2026-11-23-word-panel-v2.md, D9 (dict/c).
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
 * merged; proper nouns (capitalised pinyin) are kept only for words without a common entry; headwords longer than
 * maxWord characters are dropped. Also returns the file date (#! date=…) when there is one.
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
    for (const e of common.length ? common : list) entries.push({ trad: e.trad, simp: e.simp, pinyin: e.pinyin, senses: e.senses, cl: e.cl });
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

/**
 * Which headwords each sentence illustrates (index into sentences): every word segment that is a headword, every
 * headword inside a segment, and headwords of 3+ characters anywhere in the sentence. Two-character words that only
 * straddle a word boundary (说中 in 他会说中文) are not counted.
 * segmenter: an Intl.Segmenter('zh', { granularity: 'word' }) or anything with the same segment() shape.
 */
export function indexSentences(sentences, headwords, segmenter, { maxWord = DEFAULTS.maxWord } = {}) {
  const index = new Map();
  const add = (w, i) => {
    let list = index.get(w);
    if (!list) index.set(w, (list = []));
    if (list[list.length - 1] !== i) list.push(i);
  };
  sentences.forEach((s, i) => {
    const hits = new Set();
    const subs = (chars, minLen) => {
      for (let a = 0; a < chars.length; a++) {
        if (!HAN.test(chars[a])) continue;
        for (let n = minLen; n <= maxWord && a + n <= chars.length; n++) {
          const w = chars.slice(a, a + n).join('');
          if (headwords.has(w)) hits.add(w);
        }
      }
    };
    for (const seg of segmenter.segment(s.zh)) {
      const chars = [...seg.segment];
      if (!chars.some((c) => HAN.test(c))) continue;
      subs(chars, 1);
    }
    subs([...s.zh], 3);
    for (const w of [...hits].sort(cmp)) add(w, i);
  });
  return index;
}

/** Best examples first: with both en and fr, then length closest to targetHan Han characters, then lowest id. */
export function rankExamples(idxs, sentences, { examples = DEFAULTS.examples, targetHan = DEFAULTS.targetHan } = {}) {
  const key = (i) => {
    const s = sentences[i];
    return [s.en && s.fr ? 0 : 1, Math.abs(hanCount(s.zh) - targetHan), s.id];
  };
  return [...idxs]
    .map((i) => ({ i, k: key(i) }))
    .sort((a, b) => a.k[0] - b.k[0] || a.k[1] - b.k[1] || a.k[2] - b.k[2])
    .slice(0, examples)
    .map((x) => x.i);
}

/**
 * Build the shard files.
 * cedict: parseCedict(...).entries; cfdict: parseCfdictTsv(...); sentences: attachTranslations(...) output.
 * Returns { files: Map<'00.json'…'7f.json', string>, index } with deterministic bytes (sorted words, stable order).
 */
export function buildShards({ cedict, cfdict = new Map(), sentences = [], segmenter, built, sample = false, sources = [], options = {} }) {
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
  const hits = segmenter ? indexSentences(sentences, headwords, segmenter, opt) : new Map();

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
      if (best.length) {
        entry.x = best.map((i) => {
          if (!pos.has(i)) {
            const t = sentences[i];
            pos.set(i, s.length);
            s.push([t.id, t.zh, t.en || '', t.fr || '']);
            used.add(t.id);
          }
          return pos.get(i);
        });
        withExamples++;
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
  const freq = new Map();
  for (const [w, list] of hits) freq.set(w, list.length);
  return { files, index, stats: { words: words.size, withExamples, sentences: used.size, bytes, biggest }, freq };
}

// ---------- character index: public/dict/c (plan 2026-11-23-word-panel-v2, D9) ----------

export const CHAR_SHARDS = 64;
export const charShardOf = (key) => fnv1a(key) % CHAR_SHARDS;
export const CHAR_DEFAULTS = { perChar: 24 };

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

/**
 * Build public/dict/c: for each character, the common words containing it, best first (D9).
 * cedict: parseCedict(...).entries; cfdict: parseCfdictTsv(...); freq: buildShards(...).freq (sentences per word);
 * similar (B3, optional): Map<word, string[]> written as `n` in the word's shard.
 * Returns { files: Map<'00.json'…'3f.json', string>, index, stats: { chars, words, bytes, biggest } }, deterministic bytes.
 */
export function buildCharIndex({ cedict, cfdict = new Map(), freq = new Map(), similar, built, sample = false, options = {} }) {
  const opt = { ...CHAR_DEFAULTS, ...options };
  const ced = new Map(); // simp → entries
  for (const e of cedict) {
    let l = ced.get(e.simp);
    if (!l) ced.set(e.simp, (l = []));
    l.push(e);
  }
  const words = new Set([...ced.keys(), ...cfdict.keys()]);
  const common = []; // { w, n, cf, row }
  for (const w of words) {
    const cps = [...w];
    if (cps.length < 2 || !ALL_HAN.test(w)) continue;
    const n = freq.get(w) ?? 0;
    const cf = cfdict.get(w) ?? [];
    if (n < 1 && !cf.length) continue;
    const ce = ced.get(w) ?? [];
    let row;
    if (ce.length) {
      const e = ce.find((x) => !isNameOrVariant(x.senses));
      if (!e) continue;
      const en = shortGloss(e.senses);
      const f = cf.find((x) => x[0] === e.pinyin && !isNameOrVariant(x[1])) ?? cf.find((x) => !isNameOrVariant(x[1]));
      const fr = f ? shortGloss(f[1]) : '';
      row = fr ? [w, e.pinyin, en, fr] : [w, e.pinyin, en];
    } else {
      const f = cf.find((x) => !isNameOrVariant(x[1]));
      if (!f) continue;
      row = [w, f[0], '', shortGloss(f[1])];
    }
    common.push({ w, n, cf: cf.length > 0, len: cps.length, row });
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
  for (let s = 0; s < CHAR_SHARDS; s++) {
    const c = {};
    for (const ch of byShard[s].c) c[ch] = byChar.get(ch);
    const file = { v: 1, c };
    if (similar) {
      const n = {};
      for (const w of byShard[s].n) n[w] = similar.get(w);
      file.n = n;
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
  return { files, index, stats: { chars: byChar.size, words: listed.size, bytes, biggest } };
}

/** Is an existing dict/c index (with all its shard files, `present`) good enough to reuse alongside dict/w? */
export function charReusable(index, { present = true, sample = false, minChars = 0 } = {}) {
  if (!index || index.v !== 1 || index.shards !== CHAR_SHARDS) return { ok: false, why: 'no usable character index' };
  if (!present) return { ok: false, why: 'character index shards missing' };
  if (!!index.sample !== sample) return { ok: false, why: index.sample ? 'sample character index' : 'real character index in a sample run' };
  if (!sample && !(index.chars >= minChars)) return { ok: false, why: 'implausible character count' };
  return { ok: true };
}

/** Is an existing index.json good enough to reuse? */
export function reusable(index, { sample = false, minWords = 0, minSentences = 0, today, maxAgeDays = 30 } = {}) {
  if (!index || index.v !== 1 || index.shards !== SHARDS) return { ok: false, why: 'no usable index' };
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
