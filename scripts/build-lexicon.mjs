// Builds public/dict/w/ (128 shards + index.json + SOURCES.txt): CC-CEDICT senses (English), CFDICT senses (French,
// from public/dict/cfdict.tsv, so this runs after build-cfdict.mjs) and Tatoeba example sentences.
// In the same run, from the same inputs: public/dict/c/ (64 shards + index.json + SOURCES.txt), the common words for
// each character, ranked by Tatoeba sentence counts, and (D11) for each common word up to 4 words sharing a dictionary
// meaning (`n`).
// Rules and format: .claude/plans/2026-11-07-word-explain.md (D2), 2026-11-23-word-panel-v2.md (D9, D11),
// 2026-11-27-word-panel-settings.md (D6 strict match, D7 `xr` reading lists, D8 sentence quality); the pure parts are in
// lexicon-lib.mjs.
// Tatoeba inputs (per_language/cmn/): cmn_sentences_detailed (owner; else cmn_sentences), and, each optional (missing →
// logged, built without it): cmn_tags (doubtful tags dropped, OK boosted), cmn_sentences_with_audio, cmn_user_languages
// (level 5 = native owner), cmn_transcriptions (reviewed pinyin, for the reading check). Usernames never reach the shards.
//
// Env: CEDICT_URL / CEDICT_FILE (plain or .gz), TATOEBA_BASE / TATOEBA_DIR (pre-downloaded files, plain or .bz2),
// LEXICON_REFRESH=1 (rebuild even when the data is recent), LEXICON_SAMPLE=1 (synthetic fixtures from
// scripts/fixtures/lexicon unless CEDICT_FILE / TATOEBA_DIR say otherwise, written with sample: true; never reused by a
// normal run).
// An existing build is reused while under 30 days old, and only when both dict/w and dict/c are complete (dict/c with its
// similar-meaning rows: index.similar is a number); when a
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
  dictSegmenter,
  isDoubtful,
  makeReader,
  markQuality,
  nativeSpeakers,
  parseTranscription,
  buildCharIndex,
  buildShards,
  buildSimilar,
  charReusable,
  charShardOf,
  filterSentences,
  parseCedict,
  parseCfdictTsv,
  reusable,
  shardName,
  shardOf,
  shortGloss,
  sourcesText,
  tradOnlyChars,
  hanCount,
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

/**
 * id → text of a sentences file (id, lang, text). With owners (a Map), the file is sentences_detailed
 * (id, lang, text, username, date_added, date_last_modified): the text stops at the next tab and the owner is kept.
 */
async function readSentences(file, keep, owners) {
  const out = new Map();
  for await (const line of lines(file)) {
    const a = line.indexOf('\t');
    const b = line.indexOf('\t', a + 1);
    if (a < 0 || b < 0) continue;
    const id = Number(line.slice(0, a));
    if (keep && !keep(id)) continue;
    if (owners) {
      const c = line.indexOf('\t', b + 1);
      if (c < 0) {
        out.set(id, line.slice(b + 1));
        continue;
      }
      out.set(id, line.slice(b + 1, c));
      const d = line.indexOf('\t', c + 1);
      const user = line.slice(c + 1, d < 0 ? undefined : d);
      if (user && user !== '\\N') owners.set(id, user);
    } else out.set(id, line.slice(b + 1));
  }
  return out;
}

/** Rows (tab-separated fields) of an optional Tatoeba file; null when it is not there (logged). */
async function optionalRows(rel, what) {
  let file;
  try {
    file = await tatoeba(rel);
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    console.warn(`Lexicon: ${e.message}; built without ${what}.`);
    return null;
  }
  const rows = [];
  for await (const line of lines(file)) if (line) rows.push(line.split('\t'));
  return rows;
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
let similar;
const glosses = new Map(); // word → a short English meaning, for the sample rows in the log
let linksSource = 'per-language';
try {
  const t0 = Date.now();
  const cedict = parseCedict(await readCedict());
  console.log(`Lexicon: CC-CEDICT ${cedict.entries.length} entries (${cedict.date ?? 'no date'})`);
  const cfFile = SAMPLE ? join(FIXTURES, 'cfdict.tsv') : CFDICT;
  const cfdict = existsSync(cfFile) ? parseCfdictTsv(readFileSync(cfFile, 'utf8')) : new Map();
  if (!cfdict.size) console.warn(`Lexicon: ${cfFile} missing; no French senses.`);

  const tradOnly = tradOnlyChars(cedict.entries);
  // D8: owners from sentences_detailed (else plain sentences, no owners), tags, audio, native speakers
  const owners = new Map();
  let cmnRaw;
  try {
    cmnRaw = await readSentences(await tatoeba('cmn/cmn_sentences_detailed.tsv.bz2'), null, owners);
  } catch (e) {
    if (!(e instanceof NotFound)) throw e;
    console.warn(`Lexicon: ${e.message}; using cmn_sentences (no owners).`);
    cmnRaw = await readSentences(await tatoeba('cmn/cmn_sentences.tsv.bz2'));
  }
  const tags = new Map();
  for (const [id, tag] of (await optionalRows('cmn/cmn_tags.tsv.bz2', 'tags')) ?? []) {
    if (!tag) continue;
    const n = Number(id);
    let t = tags.get(n);
    if (!t) tags.set(n, (t = new Set()));
    t.add(tag);
  }
  const audio = new Set(((await optionalRows('cmn/cmn_sentences_with_audio.tsv.bz2', 'audio')) ?? []).map((r) => Number(r[0])));
  const natives = nativeSpeakers((await optionalRows('cmn/cmn_user_languages.tsv.bz2', 'native speakers')) ?? []);
  const doubtful = [...cmnRaw.keys()].filter((id) => isDoubtful(tags.get(id))).length;
  const cmn = filterSentences(
    [...cmnRaw.entries()].filter(([id]) => !isDoubtful(tags.get(id))),
    { tradOnly },
  );
  const cmnIds = new Set(cmn.map((s) => s[0]));
  console.log(
    `Lexicon: ${cmn.length} Mandarin sentences kept (${doubtful} with a doubtful tag dropped; ${owners.size} owners, ` +
      `${natives.size} native speakers, ${tags.size} tagged, ${audio.size} with audio)`,
  );

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
  const { kept: sentences } = markQuality(attachTranslations(cmn, { links, eng, fra }), { owners, natives, audio, tags });
  const flag = (k) => sentences.filter((s) => s[k]).length;
  console.log(
    `Lexicon: ${sentences.length} sentences with a translation (${eng.size} English, ${fra.size} French; links: ${linksSource}); ` +
      `native owner ${flag('native')}, audio ${flag('audio')}, OK tag ${flag('ok')}`,
  );

  // D7: readings of each sentence: reviewed Tatoeba transcriptions (username set), else pinyin-pro in context
  const transcriptions = new Map();
  const zhById = new Map(sentences.map((s) => [s.id, s.zh]));
  let reviewed = 0;
  let unparsed = 0;
  for (const [id, lang, script, user, text] of (await optionalRows('cmn/cmn_transcriptions.tsv.bz2', 'transcriptions')) ?? []) {
    const zh = zhById.get(Number(id));
    if (!zh || lang !== 'cmn' || script !== 'Latn' || !user || user === '\\N') continue;
    reviewed++;
    const syl = parseTranscription(text ?? '', hanCount(zh));
    if (syl) transcriptions.set(Number(id), syl);
    else unparsed++;
  }
  console.log(`Lexicon: ${reviewed} reviewed pinyin transcriptions, ${transcriptions.size} used (${unparsed} not aligned)`);
  let pinyin = null;
  try {
    ({ pinyin } = await import('pinyin-pro'));
  } catch (e) {
    console.warn(`Lexicon: pinyin-pro not installed (${e.message}); reading check from transcriptions only.`);
  }
  const reader = makeReader({ pinyin, transcriptions });
  if (!reader) console.warn('Lexicon: no reader; built without reading lists (xr).');

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
    // D6: Intl.Segmenter, with segments that are not CC-CEDICT words split into words (会说 → 会|说)
    segmenter: dictSegmenter(new Intl.Segmenter('zh', { granularity: 'word' }), new Set(cedict.entries.map((e) => e.simp))),
    reader,
    built: today,
    sample: SAMPLE,
    sources,
  });
  similar = buildSimilar({ cedict: cedict.entries, cfdict, freq: result.freq });
  chars = buildCharIndex({ cedict: cedict.entries, cfdict, freq: result.freq, similar, built: today, sample: SAMPLE });
  for (const e of cedict.entries) if (!glosses.has(e.simp)) glosses.set(e.simp, shortGloss(e.senses, 24));
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
if (stats.xr) {
  const x = stats.xr;
  console.log(
    `Lexicon: reading lists (xr): ${x.words} of ${x.polyphones} words with several readings, ${x.lists} lists; ` +
      `${x.read} hits read, ${x.unsure} unsure`,
  );
}
// sample entries, to check the strict match and the reading lists in the CI log
for (const w of ['会', '学', '行', '了', '得', '还', '只', '长', '便', '觉']) {
  const e = JSON.parse(files.get(`${shardName(shardOf(w))}.json`));
  const entry = e.w[w];
  if (!entry) continue;
  const zh = (l) => (l ?? []).map((i) => e.s[i][1]).join(' ');
  const xr = Object.entries(entry.xr ?? {}).map(([r, l]) => ` | ${r}: ${zh(l)}`).join('');
  console.log(`Lexicon: ${w} x: ${zh(entry.x) || '(none)'}${xr}`);
}
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
console.log(
  `Lexicon: ${chars.stats.similar} words with similar-meaning words, ` +
    `${mb(chars.stats.similarBytes)} raw of ${C_OUT} (included above)`,
);
for (const w of ['帮助', '朋友', '知道', '认识', '开始']) {
  const row = similar.get(w) ?? [];
  const g = (x) => `${x}${glosses.get(x) ? ` (${glosses.get(x)})` : ''}`;
  console.log(`Lexicon: similar ${g(w)} → ${row.length ? row.map(g).join(' · ') : '(no row)'}`);
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
