// Offline dictionary and example sentences: CC-CEDICT (English), CFDICT (French) and Tatoeba sentences, built in CI by
// scripts/build-lexicon.mjs into 128 shards under public/dict/w/ and cached by the service worker ('dictionary').
// One word lives in exactly one shard (FNV-1a of the word, the same hash as scripts/lexicon-lib.mjs), so one fetch
// gives everything about it. No data in the build (local builds) → 'nodata'; offline and not cached → 'offline'.
import { HAN, numberedToMarked } from './pinyin';
import { fnv1a, sentencePinyin } from './import/build';

export const LEXICON_SHARDS = 128;
/** Longest headword kept by the build (characters). */
const MAX_WORD = 8;
/** Parsed shards kept in memory. */
const LRU_SIZE = 12;
const CACHE = 'dictionary';

/** Shard file format v1 (see .claude/plans/2026-11-07-word-explain.md, D2). */
export interface ShardFile {
  v: 1;
  /** Sentences used in this shard: [tatoebaId, zh, en, fr] ('' when missing). */
  s: [number, string, string, string][];
  w: Record<string, { e?: [string, string, string?][]; f?: [string, string][]; x?: number[] }>;
}

export interface LexiconIndex {
  v: 1;
  shards: number;
  built: string;
  sample?: true;
  words: number;
  sentences: number;
  bytes: number;
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

export function lexiconShard(word: string): number {
  return parseInt(fnv1a(word), 16) % LEXICON_SHARDS;
}

const shardName = (n: number) => n.toString(16).padStart(2, '0');
const abs = (p: string) => (typeof location !== 'undefined' ? new URL(p, location.href).href : p);
const indexUrl = () => abs(`${import.meta.env.BASE_URL}dict/w/index.json`);
const shardUrl = (n: number) => abs(`${import.meta.env.BASE_URL}dict/w/${shardName(n)}.json`);
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

type IndexState = { state: 'ok'; index: LexiconIndex } | { state: 'nodata' | 'offline' };
let indexMemo: Promise<IndexState> | null = null;

function loadIndex(): Promise<IndexState> {
  if (!indexMemo) {
    indexMemo = getJson(indexUrl()).then((g): IndexState => {
      if (g.state === 'ok' && isIndex(g.data)) return { state: 'ok', index: g.data };
      if (g.state === 'missing' || g.state === 'ok') return { state: 'nodata' };
      return { state: 'offline' };
    });
    // only a definite answer is kept for the session; offline or a server error is asked again next time
    indexMemo.then((s) => s.state === 'offline' && (indexMemo = null));
  }
  return indexMemo;
}

/** The build's index.json (sources, dates, counts), or null when the build has no lexicon or it can't be reached. */
export async function lexiconMeta(): Promise<LexiconIndex | null> {
  const s = await loadIndex();
  return s.state === 'ok' ? s.index : null;
}

type ShardState = { ok: true; shard: ShardFile } | { ok: false; reason: 'nodata' | 'offline' | 'error' };
const shards = new Map<number, Promise<ShardState>>();

function loadShard(n: number): Promise<ShardState> {
  const hit = shards.get(n);
  if (hit) {
    shards.delete(n); // move to the most recent end
    shards.set(n, hit);
    return hit;
  }
  const p = getJson(shardUrl(n)).then(async (g): Promise<ShardState> => {
    if (g.state === 'ok' && isShard(g.data)) return { ok: true, shard: g.data };
    if (g.state === 'offline') return { ok: false, reason: 'offline' };
    if (g.state === 'error') return { ok: false, reason: 'error' };
    // missing, or not a v1 shard: no data at all, or a broken deploy
    return { ok: false, reason: (await loadIndex()).state === 'nodata' ? 'nodata' : 'error' };
  });
  p.then((s) => !s.ok && shards.get(n) === p && shards.delete(n));
  shards.set(n, p);
  while (shards.size > LRU_SIZE) shards.delete(shards.keys().next().value!);
  return p;
}

/** For tests: forget the memoised index and shards. */
export function resetLexicon(): void {
  indexMemo = null;
  shards.clear();
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

/**
 * Dictionary senses and examples for a note's word. Tries the hanzi, then its alternative forms. A word that is not in
 * the dictionary (most grammar patterns) gives empty lists.
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
    for (const i of entry.x ?? []) {
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

/** Pinyin with tone marks for a Tatoeba sentence, word by word (pinyin-pro is loaded on first use). */
export async function examplePinyin(zh: string): Promise<string> {
  const { pinyin } = await import('pinyin-pro');
  return sentencePinyin(zh, (h) => pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[]);
}

/** How many shards are in the offline cache. total is 0 when the build has no lexicon (or it can't be reached). */
export async function lexiconCached(): Promise<{ cached: number; total: number }> {
  const meta = await lexiconMeta();
  if (!meta) return { cached: 0, total: 0 };
  const total = meta.shards;
  if (!hasCaches()) return { cached: 0, total };
  const cache = await caches.open(CACHE);
  let cached = 0;
  for (let n = 0; n < total; n++) if (await cache.match(shardUrl(n))) cached++;
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
  const meta = await lexiconMeta();
  if (!meta) return 0;
  const cache = await caches.open(CACHE);
  if (!(await cache.match(indexUrl()))) {
    try {
      const res = await fetch(indexUrl());
      if (res.ok) await cache.put(indexUrl(), res);
    } catch {
      // the shards still work; the index is fetched again next time
    }
  }
  const todo: number[] = [];
  for (let n = 0; n < meta.shards; n++) if (!(await cache.match(shardUrl(n)))) todo.push(n);
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
        const url = shardUrl(queue.shift()!);
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
