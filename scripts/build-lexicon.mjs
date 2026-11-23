// Builds public/dict/w/ (128 shards + index.json + SOURCES.txt): CC-CEDICT senses (English), CFDICT senses (French,
// from public/dict/cfdict.tsv, so this runs after build-cfdict.mjs) and Tatoeba example sentences.
// In the same run, from the same inputs: public/dict/c/ (64 shards + index.json + SOURCES.txt), the common words for
// each character, ranked by Tatoeba sentence counts.
// Rules and format: .claude/plans/2026-11-07-word-explain.md (D2), 2026-11-23-word-panel-v2.md (D9); the pure parts
// are in lexicon-lib.mjs.
//
// Env: CEDICT_URL / CEDICT_FILE (plain or .gz), TATOEBA_BASE / TATOEBA_DIR (pre-downloaded files, plain or .bz2),
// LEXICON_REFRESH=1 (rebuild even when the data is recent), LEXICON_SAMPLE=1 (synthetic fixtures from
// scripts/fixtures/lexicon unless CEDICT_FILE / TATOEBA_DIR say otherwise, written with sample: true; never reused by a
// normal run).
// An existing build is reused while under 30 days old, and only when both dict/w and dict/c are complete; when a
// rebuild fails, an old dict/w is kept even without dict/c (the app then hides the common-word lists). With CI set and no data at all the build fails; on a laptop it
// only warns (the app then says the dictionary isn't available).
import { spawn } from 'node:child_process';
import { createReadStream, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { gunzipSync, gzipSync } from 'node:zlib';
import {
  CHAR_SHARDS,
  SHARDS,
  SOURCES_TITLE,
  addLink,
  attachTranslations,
  buildCharIndex,
  buildShards,
  charReusable,
  charShardOf,
  filterSentences,
  parseCedict,
  parseCfdictTsv,
  reusable,
  shardName,
  sourcesText,
  tradOnlyChars,
} from './lexicon-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = 'public/dict/w';
const C_OUT = 'public/dict/c';
const CFDICT = 'public/dict/cfdict.tsv';
const FIXTURES = join(HERE, 'fixtures/lexicon');
const CI = !!process.env.CI;
const SAMPLE = process.env.LEXICON_SAMPLE === '1';
const REFRESH = process.env.LEXICON_REFRESH === '1';
const CEDICT_URL = process.env.CEDICT_URL || 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz';
const TATOEBA_BASE = (process.env.TATOEBA_BASE || 'https://downloads.tatoeba.org/exports/per_language').replace(/\/+$/, '');
const TATOEBA_LINKS = `${TATOEBA_BASE.replace(/\/per_language$/, '')}/links.tar.bz2`;
// Plausibility of a real build (CC-CEDICT has about 120k entries, Tatoeba about 70k Mandarin sentences).
const MIN_WORDS = 80000;
const MIN_SENTENCES = 5000;
// Budgets (bytes): warn above WARN_TOTAL; with CI set, fail above MAX_TOTAL or if one shard exceeds MAX_SHARD.
const WARN_TOTAL = 35e6;
const MAX_TOTAL = 60e6;
const MAX_SHARD = 1.5e6;
// The same for dict/c, plus the plausibility of a real build (D9).
const C_WARN_TOTAL = 8e6;
const C_MAX_TOTAL = 15e6;
const C_MAX_SHARD = 600e3;
const MIN_CHARS = 3000;
const DOWNLOAD_MS = 120000;
const today = new Date().toISOString().slice(0, 10);

const readIndex = (dir = OUT) => {
  try {
    return JSON.parse(readFileSync(join(dir, 'index.json'), 'utf8'));
  } catch {
    return null;
  }
};
const present = (dir, n) => Array.from({ length: n }, (_, i) => i).every((i) => existsSync(join(dir, `${i.toString(16).padStart(2, '0')}.json`)));
const shardsPresent = () => present(OUT, SHARDS);

// ---------- reuse ----------
const old = readIndex();
const oldC = readIndex(C_OUT);
const check = reusable(old, { sample: SAMPLE, minWords: MIN_WORDS, minSentences: MIN_SENTENCES, today });
const checkC = charReusable(oldC, { present: present(C_OUT, CHAR_SHARDS), sample: SAMPLE, minChars: MIN_CHARS });
const oldUsable = !!old && !old.sample && !SAMPLE && old.v === 1 && old.words >= MIN_WORDS && shardsPresent();
if (!SAMPLE && !REFRESH && check.ok && shardsPresent()) {
  if (checkC.ok) {
    console.log(`Lexicon: reusing ${OUT} (built ${old.built}, ${old.words} words, ${old.sentences} sentences) and ${C_OUT} (${oldC.chars} characters).`);
    process.exit(0);
  }
  console.log(`Lexicon: ${OUT} is recent but ${C_OUT} is not usable (${checkC.why}); rebuilding both.`);
}

function unavailable(why) {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (oldUsable) {
    console.warn(`Lexicon: rebuild failed (${why}); keeping the data built ${old.built}.`);
    if (!checkC.ok) console.warn(`Lexicon: no usable ${C_OUT} (${checkC.why}); the app hides the common-word lists.`);
    process.exit(0);
  }
  if (CI) {
    console.error(`Lexicon: ${why}. No dictionary/examples data and nothing cached: failing the build.`);
    process.exit(1);
  }
  if (old?.sample || oldC?.sample) {
    // never ship fixtures from a normal build
    rmSync(OUT, { recursive: true, force: true });
    rmSync(C_OUT, { recursive: true, force: true });
    console.warn(`Lexicon: removed the sample data in ${OUT} and ${C_OUT}.`);
  }
  console.warn(`Lexicon not available (${why}); the app will say the dictionary isn't available.`);
  process.exit(0);
}

// ---------- inputs ----------
let tmp;
const tmpDir = () => (tmp ??= mkdtempSync(join(tmpdir(), 'lexicon-')));

class NotFound extends Error {}

/** fetch with a timeout and an error that names the URL and the cause (fetch only says "fetch failed"). */
async function get(url, ms = DOWNLOAD_MS) {
  try {
    return await fetch(url, { signal: AbortSignal.timeout(ms) });
  } catch (e) {
    throw new Error(`can't download ${url} (${e.cause?.message || e.cause?.code || e.message})`);
  }
}

async function download(url, name, ms = DOWNLOAD_MS) {
  const file = join(tmpDir(), name);
  const res = await get(url, ms);
  if (res.status === 404) throw new NotFound(`${url}: HTTP 404`);
  if (!res.ok || !res.body) throw new Error(`${url}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  return file;
}

/** Lines of a plain, .bz2 or .tar.bz2 file, streamed. */
async function* lines(file) {
  let child;
  let input;
  if (file.endsWith('.tar.bz2')) child = spawn('tar', ['-xjOf', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  else if (file.endsWith('.bz2')) child = spawn('bzip2', ['-dc', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  if (child) input = child.stdout;
  else input = createReadStream(file);
  const done = child
    ? new Promise((resolve, reject) => {
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`${child.spawnargs.join(' ')} exited with ${code}`))));
      })
    : null;
  done?.catch(() => {});
  yield* createInterface({ input, crlfDelay: Infinity });
  if (done) await done;
}

/** A Tatoeba file ('cmn/cmn_sentences.tsv.bz2') from TATOEBA_DIR (lang/name or name, plain or .bz2), else downloaded. */
async function tatoeba(rel) {
  const dir = process.env.TATOEBA_DIR || (SAMPLE ? FIXTURES : '');
  if (dir) {
    const base = rel.replace(/\.bz2$/, '');
    const flat = base.split('/').pop();
    for (const c of [base, `${base}.bz2`, flat, `${flat}.bz2`]) if (existsSync(join(dir, c))) return join(dir, c);
    throw new NotFound(`${rel} not in ${dir}`);
  }
  return download(`${TATOEBA_BASE}/${rel}`, rel.replace(/\//g, '_'));
}

async function globalLinks() {
  const dir = process.env.TATOEBA_DIR || (SAMPLE ? FIXTURES : '');
  if (dir) {
    for (const c of ['links.tar.bz2', 'links.csv', 'links.tsv']) if (existsSync(join(dir, c))) return join(dir, c);
    throw new NotFound(`links.tar.bz2 not in ${dir}`);
  }
  return download(TATOEBA_LINKS, 'links.tar.bz2', 3 * DOWNLOAD_MS);
}

async function readSentences(file, keep) {
  const out = new Map();
  for await (const line of lines(file)) {
    const a = line.indexOf('\t');
    const b = line.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    const id = Number(line.slice(0, a));
    if (!keep || keep(id)) out.set(id, line.slice(b + 1));
  }
  return out;
}

/** Add links touching ids in `from` (either column), from one or more link files. */
async function readLinks(files, from, links) {
  for (const f of files) {
    for await (const line of lines(f)) {
      const t = line.indexOf('\t');
      if (t < 0) continue;
      const a = Number(line.slice(0, t));
      const b = Number(line.slice(t + 1));
      if (from.has(a) || from.has(b)) addLink(links, a, b);
    }
  }
}

async function readCedict() {
  const file = process.env.CEDICT_FILE || (SAMPLE ? join(FIXTURES, 'cedict.txt') : '');
  let buf;
  if (file) buf = readFileSync(file);
  else {
    const res = await get(CEDICT_URL);
    if (!res.ok) throw new Error(`${CEDICT_URL}: HTTP ${res.status}`);
    buf = Buffer.from(await res.arrayBuffer());
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = gunzipSync(buf);
  return buf.toString('utf8');
}

let result;
let chars;
let linksSource = 'per-language';
try {
  const t0 = Date.now();
  const cedict = parseCedict(await readCedict());
  console.log(`Lexicon: CC-CEDICT ${cedict.entries.length} entries (${cedict.date ?? 'no date'})`);
  const cfFile = SAMPLE ? join(FIXTURES, 'cfdict.tsv') : CFDICT;
  const cfdict = existsSync(cfFile) ? parseCfdictTsv(readFileSync(cfFile, 'utf8')) : new Map();
  if (!cfdict.size) console.warn(`Lexicon: ${cfFile} missing; no French senses.`);

  const tradOnly = tradOnlyChars(cedict.entries);
  const cmn = filterSentences([...(await readSentences(await tatoeba('cmn/cmn_sentences.tsv.bz2'))).entries()], { tradOnly });
  const cmnIds = new Set(cmn.map((s) => s[0]));
  console.log(`Lexicon: ${cmn.length} Mandarin sentences kept`);

  // links: per-language pair files, else the global links file (D2)
  const links = new Map();
  let pairFiles;
  try {
    pairFiles = {
      a: [await tatoeba('cmn/cmn-eng_links.tsv.bz2'), await tatoeba('cmn/cmn-fra_links.tsv.bz2')],
      b: [await tatoeba('eng/eng-fra_links.tsv.bz2')],
    };
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    console.warn(`Lexicon: ${e.message}; using the global links file.`);
    const all = await globalLinks();
    pairFiles = { a: [all], b: [all] };
    linksSource = 'global links.tar.bz2';
  }
  await readLinks(pairFiles.a, cmnIds, links);
  const wanted = new Set();
  for (const id of cmnIds) for (const t of links.get(id) ?? []) if (!cmnIds.has(t)) wanted.add(t);
  const eng = await readSentences(await tatoeba('eng/eng_sentences.tsv.bz2'), (id) => wanted.has(id));
  await readLinks(pairFiles.b, new Set(eng.keys()), links);
  for (const id of eng.keys()) for (const t of links.get(id) ?? []) if (!cmnIds.has(t)) wanted.add(t);
  const fra = await readSentences(await tatoeba('fra/fra_sentences.tsv.bz2'), (id) => wanted.has(id) && !eng.has(id));
  const sentences = attachTranslations(cmn, { links, eng, fra });
  console.log(`Lexicon: ${sentences.length} sentences with a translation (${eng.size} English, ${fra.size} French; links: ${linksSource})`);

  const sources = [
    {
      name: 'CC-CEDICT',
      url: 'https://www.mdbg.net/chinese/dictionary?page=cedict',
      licence: 'CC BY-SA 4.0',
      licenceUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      ...(cedict.date ? { date: cedict.date } : {}),
    },
    { name: 'CFDICT', url: 'https://chine.in/mandarin/dictionnaire/CFDICT/', licence: 'CC BY-SA 3.0', licenceUrl: 'https://creativecommons.org/licenses/by-sa/3.0/' },
    { name: 'Tatoeba', url: 'https://tatoeba.org', licence: 'CC BY 2.0 FR', licenceUrl: 'https://creativecommons.org/licenses/by/2.0/fr/', date: today },
  ];
  result = buildShards({
    cedict: cedict.entries,
    cfdict,
    sentences,
    segmenter: new Intl.Segmenter('zh', { granularity: 'word' }),
    built: today,
    sample: SAMPLE,
    sources,
  });
  chars = buildCharIndex({ cedict: cedict.entries, cfdict, freq: result.freq, built: today, sample: SAMPLE });
  console.log(`Lexicon: built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (!SAMPLE && result.stats.words < MIN_WORDS) throw new Error(`only ${result.stats.words} words, expected at least ${MIN_WORDS}`);
  if (!SAMPLE && result.stats.sentences < MIN_SENTENCES) throw new Error(`only ${result.stats.sentences} example sentences, expected at least ${MIN_SENTENCES}`);
  if (!SAMPLE && chars.stats.chars < MIN_CHARS) throw new Error(`only ${chars.stats.chars} characters in ${C_OUT}, expected at least ${MIN_CHARS}`);
} catch (e) {
  unavailable(e.message);
}
if (tmp) rmSync(tmp, { recursive: true, force: true });

// ---------- budgets, output ----------
const { files, index, stats } = result;
let gz = 0;
for (const json of files.values()) gz += gzipSync(json).length;
const mb = (n) => `${(n / 1e6).toFixed(2)} MB`;
console.log(
  `Lexicon: ${stats.words} words (${stats.withExamples} with examples), ${stats.sentences} sentences, ` +
    `${mb(stats.bytes)} raw / ${mb(gz)} gzipped, biggest shard ${mb(stats.biggest)}`,
);
let cgz = 0;
for (const json of chars.files.values()) cgz += gzipSync(json).length;
console.log(
  `Lexicon: ${chars.stats.chars} characters, ${chars.stats.words} common words listed, ` +
    `${mb(chars.stats.bytes)} raw / ${mb(cgz)} gzipped, biggest shard ${mb(chars.stats.biggest)}`,
);
// sample rows, to check the ranking in the CI log
for (const ch of ['学', '汤', '好', '中', '汉', '英', '东']) {
  const shard = JSON.parse(chars.files.get(`${shardName(charShardOf(ch))}.json`));
  const row = (shard.c[ch] ?? []).map((r) => `${r[0]} ${r[2] || r[3] || ''}`.trim());
  console.log(`Lexicon: ${ch} → ${row.length ? row.join(' · ') : '(no row)'}`);
}
if (stats.bytes > WARN_TOTAL) console.warn(`Lexicon: total ${mb(stats.bytes)} is above ${mb(WARN_TOTAL)}.`);
if (chars.stats.bytes > C_WARN_TOTAL) console.warn(`Lexicon: ${C_OUT} total ${mb(chars.stats.bytes)} is above ${mb(C_WARN_TOTAL)}.`);
if (CI && (stats.bytes > MAX_TOTAL || stats.biggest > MAX_SHARD)) {
  console.error(`Lexicon: over budget (total ${mb(stats.bytes)} / max ${mb(MAX_TOTAL)}, biggest shard ${mb(stats.biggest)} / max ${mb(MAX_SHARD)}).`);
  process.exit(1);
}
if (CI && (chars.stats.bytes > C_MAX_TOTAL || chars.stats.biggest > C_MAX_SHARD)) {
  console.error(
    `Lexicon: ${C_OUT} over budget (total ${mb(chars.stats.bytes)} / max ${mb(C_MAX_TOTAL)}, ` +
      `biggest shard ${mb(chars.stats.biggest)} / max ${mb(C_MAX_SHARD)}).`,
  );
  process.exit(1);
}

/** Write a tree to `dir.tmp`; the renames happen once both trees are written. */
function stage(dir, shardFiles, idx, title) {
  const next = `${dir}.tmp`;
  rmSync(next, { recursive: true, force: true });
  mkdirSync(next, { recursive: true });
  for (const [name, json] of shardFiles) writeFileSync(join(next, name), json);
  writeFileSync(join(next, 'index.json'), JSON.stringify(idx));
  writeFileSync(join(next, 'SOURCES.txt'), sourcesText({ built: idx.built, sources: index.sources }, title));
  return next;
}
const nextW = stage(OUT, files, index, SOURCES_TITLE.w);
const nextC = stage(C_OUT, chars.files, chars.index, SOURCES_TITLE.c);
rmSync(OUT, { recursive: true, force: true });
renameSync(nextW, OUT);
rmSync(C_OUT, { recursive: true, force: true });
renameSync(nextC, C_OUT);
console.log(`Lexicon: wrote ${files.size} shards to ${OUT} and ${chars.files.size} to ${C_OUT}${SAMPLE ? ' (SAMPLE data, for tests only)' : ''}.`);
