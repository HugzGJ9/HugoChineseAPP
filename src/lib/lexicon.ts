// Offline dictionary and example sentences: CC-CEDICT (English), CFDICT (French) and Tatoeba sentences, built in CI by
// scripts/build-lexicon.mjs into 128 shards under public/dict/w/ and cached by the service worker ('dictionary').
// One word lives in exactly one shard (FNV-1a of the word, the same hash as scripts/lexicon-lib.mjs), so one fetch
// gives everything about it. No data in the build (local builds) → 'nodata'; offline and not cached → 'offline'.
// The character index (public/dict/c/, 64 shards by FNV-1a of the character; plan 2026-11-23-word-panel-v2, D9) gives
// the common words containing a character, read by charWords with the same rules. It is cached and prefetched with
// dict/w when its index exists; a build without it (an old dict/w kept after a failed rebuild) gives 'nodata'.
// The same shards carry `n` (D11): a word → words sharing a dictionary meaning, read by similarWords.
// Word entries may carry `xr` (plan 2026-11-27-word-panel-settings, D7): examples per reading for words with several
// CC-CEDICT readings; lookupWord picks the list of the note's reading and falls back to `x` (older builds have no `xr`).
import { HAN, numberedToMarked } from './pinyin';
import { fnv1a, sentencePinyin } from './import/build';

export const LEXICON_SHARDS = 128;
export const CHAR_SHARDS = 64;
/** Longest headword kept by the build (characters). */
const MAX_WORD = 8;
/** Parsed shards kept in memory. */
const LRU_SIZE = 12;
/** Parsed character shards kept in memory. */
const CHAR_LRU_SIZE = 8;
const CACHE = 'dictionary';

/**
 * Shard file format v1 (see .claude/plans/2026-11-07-word-explain.md, D2; additive since: `xr`, plan
 * 2026-11-27-word-panel-settings D7). Per word: e = CC-CEDICT [pinyin, senses '/', measure words?], f = CFDICT
 * [pinyin, senses], x = best examples (indices into s), xr = numbered CC-CEDICT reading ('hang2', 'xue2 sheng5') → best
 * examples where the word is read so (same indices and cap as x; only for words with 2+ readings, and only lists that
 * differ from x). Old app versions read x only.
 */
export interface ShardFile {
  v: 1;
  /** Sentences used in this shard: [tatoebaId, zh, en, fr] ('' when missing). */
  s: [number, string, string, string][];
  w: Record<string, { e?: [string, string, string?][]; f?: [string, string][]; x?: number[]; xr?: Record<string, number[]> }>;
}

export interface LexiconIndex {
  v: 1;
  shards: number;
  built: string;
  sample?: true;
  words: number;
  sentences: number;
  bytes: number;
  /** Built with the strict match, quality ranking and `xr` reading lists (D6–D8). Absent in older builds. */
  xr?: true;
  sources: { name: string; url: string; licence: string; licenceUrl: string; date?: string }[];
}

export interface DictSense {
  /** CEDICT-style numbered pinyin, space separated, ü as v (xue2 xi2). */
  pinyinNum: string;
  /** Tone marks (xuéxí). */
  pinyin: string;
  /** Senses, already passed through formatSense. */
  senses: string[];
  measure: { hanzi: string; pinyin: string }[];
  /** How the reading compares with the note's pinyin. */
  match: 'exact' | 'toneless' | 'other';
}
export interface ExampleSentence {
  id: number;
  zh: string;
  en?: string;
  fr?: string;
}
export interface WordInfo {
  /** The form that was found (the note's hanzi, or one of its alts); the hanzi when nothing was found. */
  word: string;
  /** Readings in order: exact, then toneless, then other. */
  en: DictSense[];
  fr: DictSense[];
  examples: ExampleSentence[];
}
export type Lookup = { ok: true; info: WordInfo } | { ok: false; reason: 'nodata' | 'offline' | 'error' };

/** Character index format v1 (plan 2026-11-23-word-panel-v2, D9): public/dict/c/index.json. */
export interface CharIndex {
  v: 1;
  shards: number;
  built: string;
  sample?: true;
  chars: number;
  words: number;
  bytes: number;
  similar?: number;
}
/** public/dict/c/00.json … 3f.json */
export interface CharShardFile {
  v: 1;
  /** Character → common words containing it, best first, ≤ 24: [word, pinyinNum, en, fr?] (en '' for CFDICT-only words). */
  c: Record<string, [string, string, string, string?][]>;
  /** B3: word → up to 4 words sharing a dictionary meaning. Absent before B3. */
  n?: Record<string, string[]>;
}
/** A common word containing a character. */
export interface CharWord {
  word: string;
  /** CEDICT numbered pinyin (xue2 sheng5). */
  pinyinNum: string;
  /** Tone marks (xuésheng). */
  pinyin: string;
  /** Short English meaning; '' for a word only in CFDICT. */
  en: string;
  /** Short French meaning, when CFDICT has the word. */
  fr?: string;
}
export type CharLookup = { ok: true; words: CharWord[] } | { ok: false; reason: 'nodata' | 'offline' | 'error' };

export function lexiconShard(word: string): number {
  return parseInt(fnv1a(word), 16) % LEXICON_SHARDS;
}
/** Shard of the character index holding a character (or, from B3, a word's `n` row). */
export function charShard(key: string): number {
  return parseInt(fnv1a(key), 16) % CHAR_SHARDS;
}

const shardName = (n: number) => n.toString(16).padStart(2, '0');
const abs = (p: string) => (typeof location !== 'undefined' ? new URL(p, location.href).href : p);
const indexUrl = () => abs(`${import.meta.env.BASE_URL}dict/w/index.json`);
const shardUrl = (n: number) => abs(`${import.meta.env.BASE_URL}dict/w/${shardName(n)}.json`);
const charIndexUrl = () => abs(`${import.meta.env.BASE_URL}dict/c/index.json`);
const charShardUrl = (n: number) => abs(`${import.meta.env.BASE_URL}dict/c/${shardName(n)}.json`);
const hasCaches = () => typeof caches !== 'undefined';

type Got = { state: 'ok'; data: unknown } | { state: 'missing' | 'offline' | 'error' };

/** Fetch JSON; a 404 or a non-JSON answer (a dev server's HTML fallback) is 'missing'; a failed fetch falls back to the cache. */
async function getJson(url: string): Promise<Got> {
  let res: Response;
  try {
    res = await fetch(url);
  } catch {
    if (hasCaches()) {
      try {
        const hit = await (await caches.open(CACHE)).match(url);
        if (hit) return { state: 'ok', data: await hit.json() };
      } catch {
        // unreadable cache entry: same as offline
      }
    }
    return { state: 'offline' };
  }
  if (res.status === 404) return { state: 'missing' };
  if (!res.ok) return { state: 'error' };
  try {
    return { state: 'ok', data: await res.json() };
  } catch {
    return { state: 'missing' };
  }
}

const isIndex = (d: unknown): d is LexiconIndex =>
  !!d && typeof d === 'object' && (d as LexiconIndex).v === 1 && typeof (d as LexiconIndex).shards === 'number';
const isShard = (d: unknown): d is ShardFile =>
  !!d && typeof d === 'object' && (d as ShardFile).v === 1 && Array.isArray((d as ShardFile).s) && typeof (d as ShardFile).w === 'object';
const isCharIndex = (d: unknown): d is CharIndex =>
  !!d && typeof d === 'object' && (d as CharIndex).v === 1 && (d as CharIndex).shards === CHAR_SHARDS;
const isCharShard = (d: unknown): d is CharShardFile =>
  !!d && typeof d === 'object' && (d as CharShardFile).v === 1 && !!(d as CharShardFile).c && typeof (d as CharShardFile).c === 'object';

type IndexState<T = LexiconIndex> = { state: 'ok'; index: T } | { state: 'nodata' | 'offline' };

/** A memoised index loader: only a definite answer is kept for the session; offline is asked again next time. */
function indexLoader<T>(url: () => string, valid: (d: unknown) => d is T) {
  let memo: Promise<IndexState<T>> | null = null;
  const load = (): Promise<IndexState<T>> => {
    if (!memo) {
      const p = getJson(url()).then((g): IndexState<T> => {
        if (g.state === 'ok' && valid(g.data)) return { state: 'ok', index: g.data };
        if (g.state === 'missing' || g.state === 'ok') return { state: 'nodata' };
        return { state: 'offline' };
      });
      memo = p;
      p.then((s) => s.state === 'offline' && memo === p && (memo = null));
    }
    return memo;
  };
  return { load, reset: () => void (memo = null) };
}

const wIndex = indexLoader(indexUrl, isIndex);
const cIndex = indexLoader(charIndexUrl, isCharIndex);
const loadIndex = wIndex.load;

/** The build's index.json (sources, dates, counts), or null when the build has no lexicon or it can't be reached. */
export async function lexiconMeta(): Promise<LexiconIndex | null> {
  const s = await loadIndex();
  return s.state === 'ok' ? s.index : null;
}

type ShardState<T = ShardFile> = { ok: true; shard: T } | { ok: false; reason: 'nodata' | 'offline' | 'error' };

/** Parsed shards in an LRU; a failure is not kept. A missing or invalid shard is 'nodata' when the index is missing too. */
function shardLoader<T>(url: (n: number) => string, valid: (d: unknown) => d is T, index: () => Promise<IndexState<unknown>>, size: number) {
  const lru = new Map<number, Promise<ShardState<T>>>();
  const load = (n: number): Promise<ShardState<T>> => {
    const hit = lru.get(n);
    if (hit) {
      lru.delete(n); // move to the most recent end
      lru.set(n, hit);
      return hit;
    }
    const p = getJson(url(n)).then(async (g): Promise<ShardState<T>> => {
      if (g.state === 'ok' && valid(g.data)) return { ok: true, shard: g.data };
      if (g.state === 'offline') return { ok: false, reason: 'offline' };
      if (g.state === 'error') return { ok: false, reason: 'error' };
      // missing, or not a v1 shard: no data at all, or a broken deploy
      return { ok: false, reason: (await index()).state === 'nodata' ? 'nodata' : 'error' };
    });
    p.then((s) => !s.ok && lru.get(n) === p && lru.delete(n));
    lru.set(n, p);
    while (lru.size > size) lru.delete(lru.keys().next().value!);
    return p;
  };
  return { load, clear: () => lru.clear() };
}

const wShards = shardLoader(shardUrl, isShard, loadIndex, LRU_SIZE);
const cShards = shardLoader(charShardUrl, isCharShard, cIndex.load, CHAR_LRU_SIZE);
const loadShard = wShards.load;

/** For tests: forget the memoised indexes and shards. */
export function resetLexicon(): void {
  wIndex.reset();
  cIndex.reset();
  wShards.clear();
  cShards.clear();
}

/**
 * Common dictionary words containing a character, best first (≤ 24), with marked pinyin. ok with [] when the
 * character has no row (or isn't a single Han character); 'nodata' when the build has no character index.
 */
export async function charWords(ch: string): Promise<CharLookup> {
  const c = ch.trim();
  if ([...c].length !== 1 || !HAN.test(c)) return { ok: true, words: [] };
  const r = await cShards.load(charShard(c));
  if (!r.ok) return r;
  const rows = r.shard.c[c];
  if (!Array.isArray(rows)) return { ok: true, words: [] };
  const words: CharWord[] = [];
  for (const row of rows) {
    if (!Array.isArray(row) || typeof row[0] !== 'string' || !row[0]) continue;
    const [word, py = '', en = '', fr] = row;
    const w: CharWord = { word, pinyinNum: py, pinyin: py ? markedPy(py) : '', en: en || '' };
    if (fr) w.fr = fr;
    words.push(w);
  }
  return { ok: true, words };
}

/**
 * Words sharing a dictionary meaning with `word` (plan 2026-11-23-word-panel-v2, D11), best first (≤ 4), from the `n`
 * row in the word's c shard. ok with [] when the word has no row, the shard predates `n`, or the word can't be a
 * headword; 'nodata' when the build has no character index.
 */
export async function similarWords(word: string): Promise<{ ok: true; words: string[] } | { ok: false; reason: 'nodata' | 'offline' | 'error' }> {
  const w = word.trim();
  if (!lookupable(w)) return { ok: true, words: [] };
  const r = await cShards.load(charShard(w));
  if (!r.ok) return r;
  const n = r.shard.n;
  const row = n && typeof n === 'object' ? n[w] : undefined;
  if (!Array.isArray(row)) return { ok: true, words: [] };
  const words: string[] = [];
  for (const x of row) if (typeof x === 'string' && x && x !== w && lookupable(x) && !words.includes(x)) words.push(x);
  return { ok: true, words };
}

// Senses that only point elsewhere or name someone (D7). "used in …" stays: for many characters it is the meaning.
const SKIP_SENSE = [
  /^(?:[\w-]+\s){0,2}variant of\b/i,
  /^see\b/i,
  /^surname\b/i,
  /^Kangxi radical\b/i,
  /^(?:\S+\s)?variante (?:de|graphique)\b/i,
  /^voir\b/i,
  /^nom de famille\b/i,
  /^(?:radical|clé) (?:de )?Kangxi\b/i,
];

/** A character's core meaning for its card (D7): up to `max` senses without variant / see / surname / radical senses, unless nothing else is left; joined with '; '. */
export function charGloss(senses: string[], max = 3): string {
  const all = senses.map((s) => s.trim()).filter(Boolean);
  const kept = all.filter((s) => !SKIP_SENSE.some((r) => r.test(s)));
  return (kept.length ? kept : all).slice(0, max).join('; ');
}

const normPy = (p: string) => p.toLowerCase().replace(/ü/g, 'v').replace(/u:/g, 'v').replace(/['\s]+/g, '');
const tonelessPy = (p: string) => normPy(p).replace(/[0-5]/g, '');

/** Tone marks for CEDICT numbered pinyin (peng2 you5 → péngyou); non-syllable tokens (·, letters) stay as they are. */
const markedPy = (p: string) => numberedToMarked(p.split(/\s+/).filter(Boolean));

function parseMeasure(cl: string | undefined): { hanzi: string; pinyin: string }[] {
  if (!cl) return [];
  return cl
    .split(',')
    .map((x) => {
      const i = x.indexOf(':');
      return i < 0 ? { hanzi: x, pinyin: '' } : { hanzi: x.slice(0, i), pinyin: markedPy(x.slice(i + 1)) };
    })
    .filter((m) => m.hanzi);
}

function toSenses(list: ([string, string, string?] | [string, string])[] | undefined, pinyinNum: string | undefined): DictSense[] {
  if (!list?.length) return [];
  const want = pinyinNum ? normPy(pinyinNum) : '';
  const wantTl = pinyinNum ? tonelessPy(pinyinNum) : '';
  const rank = { exact: 0, toneless: 1, other: 2 } as const;
  return list
    .map(([py, senses, cl]): DictSense => {
      const match = want && normPy(py) === want ? 'exact' : wantTl && tonelessPy(py) === wantTl ? 'toneless' : 'other';
      return {
        pinyinNum: py,
        pinyin: markedPy(py),
        senses: senses.split('/').map(formatSense).filter(Boolean),
        measure: parseMeasure(cl),
        match,
      };
    })
    .map((s, i) => ({ s, i }))
    .sort((a, b) => rank[a.s.match] - rank[b.s.match] || a.i - b.i)
    .map((x) => x.s);
}

const lookupable = (w: string) => HAN.test(w) && [...w].length <= MAX_WORD;

type WordEntry = ShardFile['w'][string];

/**
 * The example indices to show (D7): the note's reading is resolved to one of the word's CC-CEDICT readings (exact,
 * else the only one with the same letters); its `xr` list when there is one, else `x`. Exported for tests.
 */
export function pickExamples(entry: WordEntry, pinyinNum?: string): number[] {
  const x = Array.isArray(entry.x) ? entry.x : [];
  const xr = entry.xr;
  if (!pinyinNum || !xr || typeof xr !== 'object') return x;
  const readings = (entry.e ?? []).map((r) => r?.[0]).filter((r): r is string => typeof r === 'string');
  const want = normPy(pinyinNum);
  let reading = readings.find((r) => normPy(r) === want);
  if (!reading) {
    const same = [...new Set(readings.filter((r) => tonelessPy(r) === tonelessPy(pinyinNum)))];
    if (same.length === 1) reading = same[0];
  }
  const list = reading !== undefined && Object.prototype.hasOwnProperty.call(xr, reading) ? xr[reading] : undefined;
  return Array.isArray(list) && list.length ? list : x;
}

/**
 * Dictionary senses and examples for a note's word. Tries the hanzi, then its alternative forms. A word that is not in
 * the dictionary (most grammar patterns) gives empty lists. With pinyinNum (the note's or the tapped reading), the
 * examples are those of that reading when the build has them (`xr`), else the word's best examples (`x`).
 */
export async function lookupWord(hanzi: string, pinyinNum?: string, alts?: string[]): Promise<Lookup> {
  const forms = [...new Set([hanzi, ...(alts ?? [])].map((w) => w.trim()))].filter(lookupable);
  let failure: 'nodata' | 'offline' | 'error' | null = null;
  for (const w of forms) {
    const r = await loadShard(lexiconShard(w));
    if (!r.ok) {
      if (r.reason === 'nodata') return { ok: false, reason: 'nodata' };
      failure ??= r.reason;
      continue;
    }
    const entry = r.shard.w[w];
    if (!entry) continue;
    const examples: ExampleSentence[] = [];
    for (const i of pickExamples(entry, pinyinNum)) {
      const s = r.shard.s[i];
      if (!s) continue;
      const ex: ExampleSentence = { id: s[0], zh: s[1] };
      if (s[2]) ex.en = s[2];
      if (s[3]) ex.fr = s[3];
      examples.push(ex);
    }
    return { ok: true, info: { word: w, en: toSenses(entry.e, pinyinNum), fr: toSenses(entry.f, pinyinNum), examples } };
  }
  if (failure) return { ok: false, reason: failure };
  return { ok: true, info: { word: hanzi.trim(), en: [], fr: [], examples: [] } };
}

/** CEDICT cross-references for display: 樂|乐[le4] and 乐[le4] → 乐 (lè). */
export function formatSense(s: string): string {
  return s
    .replace(/(?:[^\s|[\]/,;()]+\|)?([^\s|[\]/,;()]+)\[([^\]]+)\]/gu, (_m, simp: string, py: string) => `${simp} (${markedPy(py)})`)
    .trim();
}

/** Compact dictionary line for the Claude prompt: matching readings (else all), "xue2 xi2: to learn/to study". */
export function sensesText(list: DictSense[], max = 6): string {
  const matching = list.filter((s) => s.match !== 'other');
  return (matching.length ? matching : list)
    .slice(0, 3)
    .map((s) => {
      const cl = s.measure.length ? ` (measure words: ${s.measure.map((m) => m.hanzi).join(', ')})` : '';
      return `${s.pinyinNum}: ${s.senses.slice(0, max).join('/')}${cl}`;
    })
    .join(' | ');
}

/** pinyin-pro, loaded on first use (its own chunk, precached by the service worker). */
let pinyinPro: Promise<typeof import('pinyin-pro')> | null = null;
const loadPinyinPro = () => (pinyinPro ??= import('pinyin-pro'));

/** Readings Hugo already knows: a Han-only written form → his numbered pinyin (from his list), longest form length. */
export interface KnownReadings { get(word: string): string | undefined; max: number }

/**
 * Pinyin with tone marks for a sentence, word by word (pinyin-pro is loaded on first use). With `known`, his own words
 * (longest match, left to right) take the pinyin of his list, so light tones follow it: pinyin-pro reads 朋友 as
 * péngyǒu, his list says péngyou. A reading whose syllable count doesn't match the word is ignored.
 */
export async function examplePinyin(zh: string, known?: KnownReadings): Promise<string> {
  const { pinyin } = await loadPinyinPro();
  return sentencePinyin(zh, (h) => {
    const nums = pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[];
    return known ? overlayKnown(h, nums, known) : nums;
  });
}

/** nums has one syllable per Han character of zh; his words replace theirs. Exported for tests. */
export function overlayKnown(zh: string, nums: string[], known: KnownReadings): string[] {
  const han = [...zh].filter((c) => HAN.test(c));
  if (han.length !== nums.length) return nums;
  const out = [...nums];
  for (let i = 0; i < han.length; ) {
    let used = 0;
    for (let l = Math.min(known.max, han.length - i); l >= 2; l--) {
      const py = known.get(han.slice(i, i + l).join(''));
      const syl = py?.trim().toLowerCase().replace(/u:/g, 'v').split(/\s+/);
      if (syl && syl.length === l && syl.every((x) => /^[a-zv]+[0-5]$/.test(x))) {
        syl.forEach((x, k) => (out[i + k] = x.replace(/0$/, '5')));
        used = l;
        break;
      }
    }
    i += used || 1;
  }
  return out;
}

/**
 * One numbered syllable per code point of zh (CEDICT style: ü as v, neutral tone 5), '' for non-Han; pinyin-pro in
 * context, so polyphones follow the line (银行 → hang2). Tone sandhi is off (一个 → yi1), as in CEDICT, because these
 * readings rank dictionary readings (plan 2026-11-23-word-panel-v2, D5).
 */
export async function lineReadings(zh: string): Promise<string[]> {
  const { pinyin } = await loadPinyinPro();
  const out: string[] = [];
  for (const r of pinyin(zh, { toneType: 'num', type: 'all', v: true, toneSandhi: false })) {
    const cps = [...r.origin];
    if (r.isZh && cps.length === 1 && r.pinyin) out.push(r.pinyin.replace(/0$/, '5'));
    else out.push(...cps.map(() => ''));
  }
  // pinyin-pro gives one entry per character; pad or trim if a future version groups them differently.
  const n = [...zh].length;
  while (out.length < n) out.push('');
  return out.slice(0, n);
}

/** Shard URLs to keep offline: dict/w, plus dict/c when its index exists. null when the build has no lexicon. */
async function allShardUrls(): Promise<{ urls: string[]; indexes: string[] } | null> {
  const meta = await lexiconMeta();
  if (!meta) return null;
  const urls = Array.from({ length: meta.shards }, (_, n) => shardUrl(n));
  const indexes = [indexUrl()];
  const c = await cIndex.load();
  if (c.state === 'ok') {
    for (let n = 0; n < c.index.shards; n++) urls.push(charShardUrl(n));
    indexes.push(charIndexUrl());
  }
  return { urls, indexes };
}

/** How many shards (dict/w and dict/c) are in the offline cache. total is 0 when the build has no lexicon (or it can't be reached). */
export async function lexiconCached(): Promise<{ cached: number; total: number }> {
  const all = await allShardUrls();
  if (!all) return { cached: 0, total: 0 };
  const total = all.urls.length;
  if (!hasCaches()) return { cached: 0, total };
  const cache = await caches.open(CACHE);
  let cached = 0;
  for (const u of all.urls) if (await cache.match(u)) cached++;
  return { cached, total };
}

/**
 * Save every shard missing from the offline cache. Returns the number that failed (0 when there is no lexicon).
 * The warm-up passes batch + pause to download in idle batches; Settings' Download runs it straight through.
 */
export async function prefetchLexicon(
  onProgress?: (done: number, total: number) => void,
  opts: { batch?: number; pause?: () => Promise<void>; online?: () => boolean } = {},
): Promise<number> {
  if (!hasCaches()) return 0;
  const all = await allShardUrls();
  if (!all) return 0;
  const cache = await caches.open(CACHE);
  for (const u of all.indexes) {
    if (await cache.match(u)) continue;
    try {
      const res = await fetch(u);
      if (res.ok) await cache.put(u, res);
    } catch {
      // the shards still work; the index is fetched again next time
    }
  }
  const todo: string[] = [];
  for (const u of all.urls) if (!(await cache.match(u))) todo.push(u);
  const batch = opts.batch ?? todo.length;
  let done = 0;
  let failed = 0;
  onProgress?.(0, todo.length);
  for (let i = 0; i < todo.length; i += batch) {
    if (opts.online && !opts.online()) return failed + todo.length - i;
    if (opts.pause) await opts.pause();
    const queue = todo.slice(i, i + batch);
    const worker = async () => {
      while (queue.length) {
        const url = queue.shift()!;
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res);
          else failed++;
        } catch {
          failed++;
        }
        onProgress?.(++done, todo.length);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, queue.length) }, worker));
  }
  return failed;
}
