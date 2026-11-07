# Word explain: dictionary, examples and "Explain more" (2026-11-07)

## Goal
Hugo taps a word anywhere he studies it and gets more than his Excel translation. **Instantly and offline**, the app shows
full dictionary senses (CC-CEDICT in English, CFDICT in French), measure words and real example sentences (Tatoeba).
**On demand**, "Explain more" asks Claude, with his own key, for the precise meaning, nuance against near-synonyms,
register, collocations and structures, common mistakes, and 5 example sentences at HSK 4–5 level. The result is saved
per (word, language) and synced through his private repo. Everything follows the EN/FR meaning switch.

## Feasibility (checked from this cloud session, 2026-11-07)
- **Unreachable here (proxy CONNECT 403):** www.mdbg.net (CC-CEDICT), downloads.tatoeba.org and tatoeba.org, and the
  docs/pricing sites (docs.claude.com, platform.claude.com, anthropic.com).
- **Reachable here:** chine.in (CFDICT), raw.githubusercontent.com, registry.npmjs.org, and api.anthropic.com (401
  without a key, so the API itself can be reached).
- **Assumption:** GitHub-hosted runners have open egress, so CI can download CC-CEDICT and Tatoeba. This is confirmed
  by a branch run of the new `data.yml` workflow (WP5) **before** merging to main.
  - Fallback if a source is down: the CI cache keeps the last good data.
  - With no data and no cache, the CI build fails. The live site then stays as it is, like CFDICT today.
- **Exact Tatoeba file names cannot be checked here.** WP1 uses the documented per-language exports. If a per-pair links
  file is missing, it falls back to the global `links.tar.bz2` (D2). The first `data.yml` run confirms which one works.
- **Local and cloud builds have no real data.** `build-lexicon.mjs` warns and exits 0, and the app degrades gracefully
  (D3). `LEXICON_SAMPLE=1` builds shards from synthetic fixtures, for tests and e2e here.
  - Not used: npm `cedict-json@1.3.20251213` (CC BY-SA 4.0, reachable here) could feed `CEDICT_FILE` for local
    experiments only.
- **Prices could not be checked (pricing page blocked).** Cost estimates assume the current tier prices: Sonnet $3 / $15
  and Haiku $1 / $5 per million tokens (input / output). The lead confirms them before quoting them to Hugo.

## Decisions

**D1. Two layers.**
- (a) **Lexicon:** static data built in CI, lazily fetched and cached by the service worker, shown at once.
- (b) **Claude:** called only when Hugo taps "Explain more". The result is cached in IndexedDB and synced.
- With no key, offline, or with no lexicon in the build, each layer degrades on its own.

**D2. Lexicon data (`scripts/build-lexicon.mjs` + pure `scripts/lexicon-lib.mjs`).**
- **Sources:**
  - CC-CEDICT (`https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz`, CC BY-SA 4.0).
  - French senses from the `public/dict/cfdict.tsv` that build-cfdict.mjs already produces. It is not downloaded again,
    so it must run after build-cfdict.
  - Tatoeba (CC BY 2.0 FR), base `https://downloads.tatoeba.org/exports/per_language`:
    - Sentences: `cmn/cmn_sentences.tsv.bz2`, `eng/eng_sentences.tsv.bz2`, `fra/fra_sentences.tsv.bz2`.
    - Links: `cmn/cmn-eng_links.tsv.bz2`, `cmn/cmn-fra_links.tsv.bz2`, `eng/eng-fra_links.tsv.bz2`.
    - If any links file is missing (404), fall back to `https://downloads.tatoeba.org/exports/links.tar.bz2`.
    - Decompress with the system `bzip2 -dc` / `tar -xjO` through child_process, streamed line by line. Both are on
      ubuntu-latest, so no new dependency is needed.
  - Overrides: `CEDICT_URL`, `CEDICT_FILE`, `TATOEBA_BASE`, `TATOEBA_DIR` (pre-downloaded files, plain or .bz2),
    `LEXICON_REFRESH=1`, `LEXICON_SAMPLE=1`.
- **No personal list is involved.** Every CC-CEDICT headword of 8 characters or fewer is kept.
  - Proper-noun entries (capitalised pinyin) are kept only when the word has no common entry (the cfdict rule).
- **Sentence filter:**
  - Simplified only. A sentence is dropped if it contains a "traditional-only" character: one that appears in CEDICT
    traditional forms and never in a simplified form.
  - 4–24 Han characters, no Latin letters.
  - At least one English or French translation.
  - French: a direct cmn→fra link first, else via an English translation (cmn→eng→fra). If none, the UI shows the English
    with the existing "EN" tag.
  - When there are several translations, take the lowest id, so the output is deterministic.
- **Which words a sentence illustrates.** Segment with `Intl.Segmenter('zh', {granularity:'word'})` (Node 24 full-ICU).
  Index:
  - every segment that is a headword;
  - every headword that is a substring inside a segment;
  - headwords of 3 or more characters found anywhere in the sentence.
  - This avoids boundary false hits. Example: 他会说中文 must **not** illustrate 说中.
- **Ranking:**
  - Sentences with both en and fr come first.
  - Then the length closest to 12 Han characters.
  - Then the lowest Tatoeba id.
  - Keep at most **6 examples per word**.
- **Sharding:** **128 shards** by `shardOf(word) = parseInt(fnv1a(word), 16) % 128`, using the same FNV-1a as
  `fnv1a` in `src/lib/import/build.ts`. The .mjs re-implements it, and a test asserts both agree.
  - One word lives in exactly one shard, so one fetch gives everything for that word and the shards never need to
    agree with each other.
  - Output: `public/dict/w/00.json … 7f.json`, plus `index.json` and `SOURCES.txt` (attribution and licences; the data
    is "adapted: filtered and reformatted").
  - Shard format (v1):
  ```ts
  interface ShardFile {
    v: 1;
    /** Sentences used in this shard: [tatoebaId, zh, en, fr] ('' when missing), deduplicated within the shard. */
    s: [number, string, string, string][];
    w: Record<string /* simplified */, {
      e?: [string /* pinyinNum "xue2 xi2", u: → v */, string /* senses joined by '/' */, string? /* CL "个:ge4,本:ben3" */][];
      f?: [string, string][];     // CFDICT [pinyinNum, senses '/']
      x?: number[];               // indexes into s, best first
    }>;
  }
  interface LexiconIndex { v: 1; shards: 128; built: string /* YYYY-MM-DD */; sample?: true; words: number; sentences: number;
    bytes: number; sources: { name: string; url: string; licence: string; licenceUrl: string; date?: string }[] }
  ```
- **Size.** Estimate: about 20 MB raw, about 7 MB gzipped, roughly 150 KB raw (about 60 KB gzipped) per shard.
  - The script prints its stats.
  - It warns above 35 MB total.
  - With CI set, it fails above 60 MB total or if any shard is over 1.5 MB.
  - Knobs: examples per word, maximum length, maximum word length.
  - A future incompatible format moves to a new path, `dict/w2/`.
- **Reuse and refresh.**
  - An existing `index.json` with `v:1`, no `sample` flag and plausible counts is reused while `built` is under 30 days
    old.
  - When it is older, the script tries to rebuild. If the download fails, it keeps the old data (warns, exits 0).
  - With no data at all: CI exits 1, a laptop warns and exits 0 (the same pattern as build-cfdict).
  - A `sample` build is never reused without `LEXICON_SAMPLE=1`, so CI never ships fixtures.
- **Determinism:** sorted keys and stable order, so the same inputs give identical bytes.

**D3. Runtime lookup and offline (`src/lib/lexicon.ts`).**
- Shards live under `/dict/`. The existing Workbox setup already excludes them from the precache, denies the navigate
  fallback, and serves them with the runtime **StaleWhileRevalidate** cache `dictionary`. So **vite.config.ts needs no
  change**, and a monthly data update reaches the device on use.
- **Warm-up:** a new phase `'lexicon'` in `strokes.ts`'s `warmOffline()`, **after** strokes. It fetches `index.json`.
  If that answers 404, there is no data, so it skips.
  - Then it puts each shard missing from `caches.open('dictionary')` into the cache, in idle batches of 8.
  - This is checked at each launch (cheap `cache.match`). No version key.
- **No data / offline:** `lookupWord` returns a reason:
  - `'nodata'` when `index.json` is 404.
  - `'offline'` when the fetch fails and nothing is cached.
  - The panel says so and still offers Explain more.
- **Pinyin for Tatoeba sentences** is computed at runtime: lazy `import('pinyin-pro')` plus the existing
  `sentencePinyin` from `src/lib/import/build.ts`.
  - build.ts is already in the main bundle through `engine/schedule.ts`.
  - The pinyin-pro chunk is precached through `globPatterns`.
  - This saves about 5 MB of data.
- **Reading choice:** like `lookupFr`. Entries with the note's exact `pinyinNum` come first, then the same toneless
  reading, then the other readings (shown collapsed).
  - If `hanzi` is not found, try `alts`.
  - Grammar patterns are usually not found; that is fine.
- **CEDICT cross-references:** `樂|乐[le4]` and `乐[le4]` render as `乐 (lè)` (`formatSense`).

**D4. Claude call (`src/lib/explain/`).**
- **Model:** `claude-sonnet-5-5`, the constant `EXPLAIN_MODEL` (Q1).
  - Why: Hugo's complaint is precision and nuance. Each word is paid once (cached and synced), so the stronger model is
    worth about 2–3¢ a word.
- **Per call:** about 1,600 input tokens (system prompt, tool schema, word context) and about 1,400–1,600 output.
  - Sonnet ≈ **$0.025–0.03** a call and about 20 s.
  - Haiku `claude-haiku-5-5` ≈ **$0.009** and about 10 s (prices assumed, see Feasibility).
  - 300 words ≈ $8 (Sonnet) or $3 (Haiku).
- **Request:** `POST https://api.anthropic.com/v1/messages`.
  - Headers: `x-api-key`, `anthropic-version: 2023-06-01`, `anthropic-dangerous-direct-browser-access: true`,
    `content-type: application/json`.
  - Body: `model`, `max_tokens: 4096`, `stream: true`, and `system` as one block with
    `cache_control: {type:'ephemeral'}` (harmless when below the caching minimum).
  - Structured JSON through **forced tool use**: `tools:[{name:'word_explanation', input_schema}]`,
    `tool_choice:{type:'tool', name:'word_explanation'}`. This is stable on every model and needs no beta header.
  - No temperature.
- **Streaming, for progress only:** handle `message_start` (input tokens), `content_block_delta` / `input_json_delta`
  (append), `message_delta` (output tokens, stop_reason), `message_stop`, and `error`.
  - Parse once at the end.
  - Timeouts: 120 s total, or 30 s with no data.
- **Validation:** `normalizeExplanation(input)` trims strings and caps the list lengths. It needs `summary` and at least
  3 examples with Han characters, else it fails as 'invalid'. One automatic retry on invalid output, 500 or 529.
- **Error kinds** (`ClaudeError.kind`). The key never appears in messages or logs.

| kind | when | message (UI, English) |
|---|---|---|
| nokey | no key | Add your Claude API key in Settings to get explanations. |
| offline | `navigator.onLine === false` | Needs a connection. Explanations you already have still show. |
| key | 401 | Claude refused the API key. Check it in Settings. |
| credit | 400 with "credit balance" | Your Anthropic credit is used up. Add credit in the Anthropic Console. |
| model | 404 / 403 | This key can't use the model. |
| rate | 429 (`retry-after`) | Too many requests. Try again in N s. |
| busy | 500 / 529 / stream `overloaded_error` | Claude is busy. Try again in a minute. |
| network / timeout | fetch failure / abort | Claude could not be reached. Check the connection. / Claude took too long. Try again. |
| invalid | bad output twice | The answer could not be read. Try again. |

- **Prompt (prompt.ts, `PROMPT_VERSION = 1`).**
  - System prompt, in English:
    - Hugo is a native French speaker at HSK 4–5, learning simplified Mandarin from his own list.
    - Answer only through the tool.
    - Write all explanations and translations in {English|French}.
    - Pinyin with tone marks, words separated by spaces, matching the sentence.
    - Precision over breadth.
    - Common senses first, at most 4. Say which sense his meaning refers to.
    - Put `check` only when his meaning is wrong, too broad or misses a common use.
    - `register` in one line.
    - `collocations`: 3–8.
    - `patterns`: 0–4, each with an example.
    - `mistakes`: 0–3 typical errors of French or English speakers. Never invent mistakes to fill the list.
    - Exactly 5 natural example sentences of 8–20 characters, each showing a different use, mostly HSK 1–5 words.
    - For a grammar point, explain the structure, and use `nuance` for similar structures.
    - Never invent usages; say so when unsure or regional.
  - User message, for example:
    ```
    Word: 学习 (xuéxí), vocabulary word, sheet HSK五级
    His meaning: "to study" (EN, his list) / "étudier" (FR)
    Dictionary (CC-CEDICT): xue2 xi2: to learn/to study
    Related words he is learning: …
    His example: …
    Answer in French.
    ```
    - The related words are the hanzi of notes with the same `group` or `set`, up to 6.
    - At most 2 of his examples.
    - The dictionary line is passed by the UI from the lexicon; it is omitted when unavailable.
  ```ts
  interface Explanation {
    summary: string;                                   // precise meaning, 1–3 sentences
    check?: string;                                    // how his own meaning compares (only if off/incomplete)
    senses: { meaning: string; pos?: string; note?: string }[];          // 1–4
    register: string;
    nuance: { word: string; pinyin: string; diff: string }[];            // 0–4 near-synonyms
    collocations: { zh: string; pinyin: string; tr: string }[];         // 3–8
    patterns: { pattern: string; tr: string; example?: { zh: string; pinyin: string; tr: string } }[]; // 0–4
    mistakes: { wrong?: string; right?: string; why: string }[];        // 0–3
    examples: { zh: string; pinyin: string; tr: string }[];             // 5
  }
  ```
- **What is sent to Anthropic:** the word, its pinyin, his meanings and examples, the related words and the dictionary
  line. No ids and no progress. Settings says that the words he explains are sent to Anthropic.

**D5. API key: on this device only.**
- Stored in kv `claudeKey` → `{ key, savedAt }` (IndexedDB, like `syncLink`).
- Never in localStorage prefs, `settings.json`, sync files, backups, the link key or the QR code, the React state, or logs.
- **Per-device keys:** Hugo creates a second key for the iPhone in the Anthropic Console. Each key can be revoked on its
  own and its spend is visible on its own (Q3).
- On the iPhone, the key must be entered in the Home Screen app, because its storage is separate from Safari.
- `testClaudeKey` calls `GET /v1/models` with the same headers. It costs nothing and checks that `EXPLAIN_MODEL` is
  listed. If CORS or the network fails, the key is still saved, with the note "couldn't check".
- "Clear this device" (`db.delete`) removes it.

**D6. Explanation cache and sync (additive; Dexie stays v1).**
- **Storage:** one kv row per key, `ex:<k>`, holding `ExplainEntry & { dev: string; mo: string; own?: true }`.
  - `k = \`${note.id}|${lang}\`` (e.g. `v:学习|xuexi|fr`).
  - The kind is part of the note id, so a grammar point and a word never share an entry.
  - Lookup also tries old ids that `meta.aliases` maps to this note.
  - `dev`, `mo` and `own` are local only. `mo` is the creation month, frozen.
  - `own` does not depend on the device id, so `renewDeviceId` cannot strand entries.
- **Upload queue:** kv `explainDirty` (month → stamp), apart from `dirty` and `marksDirty`, so older versions never
  touch it.
- **Repo file:** `explain/<device>/<YYYY-MM>.json.gz`. Each device writes only its own, gzipped. Content:
  `{"device","month","v":1,"entries":[ExplainEntry…]}`.
  ```ts
  interface ExplainEntry { k: string; hz: string; py: string; lang: 'en' | 'fr'; at: number; model: string; pv: number;
    u?: [number, number] /* input, output tokens */; x: Explanation }
  ```
- **Pull:** step 3c of `pullAndPush`, after the marks, through `isolate()`.
  - A file with `v > 1` is neither applied nor recorded, and sets `updateNeeded` with a warning (the marks pattern).
  - Malformed entries are skipped one by one. This is a cache, so a partial file deletes nothing.
  - Merge: the **newest `at` wins** per key; on a tie, the larger device id.
  - No `rebuildAll`, since cards are not involved.
- **Push:** step 4c: for each dirty month, write `ownExplanations(month)` and clear the month with its stamp.
- **When it syncs:** saving an entry calls `notifyLocalChange()`, which schedules the debounced sync.
- `idUsed()` also counts `explain/<id>/`.
- **Backups do not include explanations** (they can be regenerated, sync holds them, and the backup format stays
  unchanged). They never include the key.
- **Old clients:** the deployed sync processes only VOCAB / SETTINGS / EVENTS / MARKS paths (regex), and `idUsed` checks
  only devices/events/marks. Unknown `explain/` files are ignored, and the tree grows by 1 file per device per month.
- **Events stay the source of truth:** explanations are external content, never derived state, and never touch cards.
- **In-flight jobs live at module level** and survive closing the panel. They are deduplicated per key, and progress is
  throttled to about 300 ms through `onExplainChange`.
  - A cross-tab broadcast is not needed: panels read again when they open. Don't post to the `hz` channel, because old
    tabs reload on any message there.

**D7. Language follows the app switch** (`useApp(s => s.lang)`, with a LangSwitch in the panel head):
- Dictionary senses: FR uses CFDICT, else CEDICT with the "EN" tag.
- Example translations: fra, else eng with the "EN" tag.
- Claude: requested in the current language. If only the other language is cached, show it with "In English · Explain
  in French" (no automatic second call).

**D8. UI: one word panel, mobile-first.**
- The existing Practice `Shell` moves to `src/ui/panel.tsx` + `panel.css`: a bottom sheet on phones (`max-height: 92dvh`,
  safe-area bottom padding), a right panel of 400 px at ≥ 900 px.
- **`WordPanel`:**
  - Title: the hanzi.
  - Head: audio and LangSwitch.
  - Tabs **Explain | Practise**. Practise is the current PracticePanel body.
  - The footer (status picker and Details) shows on both tabs, but only when `onStatus` is given.
  - `ExplainView` is lazy-loaded, so the Sheets home bundle stays small.
- **`ExplainView`** (also shown inline in Words detail), in this order:
  1. His meaning (Excel).
  2. **Dictionary**: senses of the matching reading (first 6, then "Show all"), measure words as chips, other readings
     collapsed.
  3. **Claude's explanation**: if one is cached, it shows expanded. Otherwise:
     - an **Explain more** button with the hint "about 20 s";
     - a progress bar while it streams;
     - the error kinds from D4, with Retry;
     - the no-key message, linking to `#/settings`;
     - Offline: disabled.
     - Footer: "Claude · date · device", plus a small **Ask again** button (regenerate).
  4. **Examples** (Tatoeba):
     - zh: tap to speak.
     - Pinyin is hidden by default, behind a Pinyin chip (device pref `ex.py`). It applies to Claude's examples too.
     - The translation.
     - A "Tatoeba" link to `https://tatoeba.org/en/sentences/show/<id>` (`target=_blank rel=noopener`).
- Chinese text gets `lang="zh-CN"` and class `zh`.
- **Entry points:**
  - **Sheets:**
    - Tapping a **shown** hanzi opens WordPanel on Explain. It still speaks the word (Q2).
    - The pen opens it on Practise, unchanged.
    - Keys: `E` opens Explain, `W` opens Practise.
    - Row layout unchanged (no new button).
    - The state becomes `panel: { key; tab } | null`.
  - **Quick:** in list mode, the same QmList `onOpen` opens an Explain-only panel without the footer. In cards mode, an
    "Explain" button on the revealed card.
  - **Review answer side:**
    - An **Explain** button in VocabBack and in OtherCard's back.
    - Key `e` when answered.
    - The panel state lives in CardView.
    - CardView, Quick and QmList key handlers ignore events whose target is inside `[role="dialog"]`, so 1–4 never
      grade while reading.
  - **Words detail:** ExplainView inline in NoteDetail, as an "Explanation" section.
- **Selector contract (for e2e):**
  - The panel has `role="dialog"` and `aria-label="<hanzi>"`.
  - Buttons: "Explain", "Practise", "Explain more", "Ask again".
  - Headings: "Dictionary", "Claude's explanation", "Examples".
  - The no-key text contains "Add your Claude API key".
  - Settings: an input with `aria-label="Claude API key"` (type password, 16 px on touch, already in styles.css), and
    buttons "Save key" and "Remove key".

**D9. Settings.**
- **Section "Explanations by Claude":**
  - The key field (never prefilled), Save key (tests, then saves), and a masked hint `sk-ant-…1a2b` with the saved date.
  - Test and Remove (confirm).
  - Steps:
    1. console.anthropic.com › API keys › Create key, named "Hugo 中文 <device>".
    2. Set a monthly spend limit (Settings › Limits).
    3. Use one key per device.
  - Privacy text: the key stays on this device and only goes to api.anthropic.com; the words he explains are sent to
    Anthropic.
  - Usage: "This device this month: N explanations, about $X. Saved explanations: M."
- **Offline:** "Dictionary and examples: X of 128 parts on this device", plus a Download button when incomplete.
- **New "About" section,** replacing the faint credits line:
  - The app version.
  - Each source with its licence link: CC-CEDICT/MDBG CC BY-SA 4.0, CFDICT CC BY-SA 3.0, Tatoeba CC BY 2.0 FR, Hanzi
    Writer/Make Me a Hanzi, ts-fsrs, pinyin-pro.
  - The note: "Explanations: Claude (Anthropic), with your own key".
  - The lexicon dates come from `lexiconMeta()`.

**D10. Compatibility checklist.**
- **IndexedDB:** only new kv keys (`ex:*`, `explainDirty`, `claudeKey`). No table and no index change, so no Dexie bump.
- **Sync:** only a new additive path; old clients ignore it. settings.json, events, marks, the vocab file and the sync
  key are unchanged.
- **Events:** untouched.
- **iPhone:**
  - 16 px inputs.
  - Bottom sheet with safe areas.
  - The key goes in the Home Screen app.
  - Offline: lexicon from the cache, explanations from IndexedDB, and a clear "needs a connection" for new ones.
  - Fetch streaming works in Safari 14.5+.
- **PWA:**
  - New chunks (ExplainView, pinyin-pro) are precached automatically.
  - `dict/w/*` uses the runtime cache.
  - Cross-origin POSTs bypass the service worker.
- **CSP:** add `https://api.anthropic.com` to `connect-src`. Tatoeba links are navigations, so no CSP change for them.
- **Public repo:** fixtures are synthetic (definitions and sentences we write ourselves). Tests use fake keys
  (`sk-ant-test-…`).

## Contracts (binding; engineers write these exports first, stubs allowed, so ui-dev compiles in parallel)
```ts
// src/lib/lexicon.ts  (WP1)
export const LEXICON_SHARDS = 128;
export function lexiconShard(word: string): number;
export interface DictSense { pinyinNum: string; pinyin: string /* tone marks */; senses: string[]; measure: { hanzi: string; pinyin: string }[]; match: 'exact' | 'toneless' | 'other' }
export interface ExampleSentence { id: number; zh: string; en?: string; fr?: string }
export interface WordInfo { word: string; en: DictSense[]; fr: DictSense[]; examples: ExampleSentence[] }
export type Lookup = { ok: true; info: WordInfo } | { ok: false; reason: 'nodata' | 'offline' | 'error' };
export function lookupWord(hanzi: string, pinyinNum?: string, alts?: string[]): Promise<Lookup>;
export function lexiconMeta(): Promise<LexiconIndex | null>;
export function lexiconCached(): Promise<{ cached: number; total: number }>;
export function prefetchLexicon(onProgress?: (done: number, total: number) => void): Promise<number>; // failures
export function formatSense(s: string): string;
export function sensesText(list: DictSense[], max?: number): string;   // compact line for the prompt
export function examplePinyin(zh: string): Promise<string>;            // lazy pinyin-pro + sentencePinyin
// src/lib/strokes.ts (WP1): WarmStatus.phase becomes 'idle' | 'dict' | 'strokes' | 'lexicon' | 'done'

// src/lib/explain/index.ts  (WP2)
export type { Explanation, ExplainEntry } from './types';
export const EXPLAIN_MODEL: string;  // 'claude-sonnet-5-5'
export class ClaudeError extends Error { kind: 'nokey'|'offline'|'key'|'credit'|'model'|'rate'|'busy'|'network'|'timeout'|'invalid'|'other'; status: number; retryAfter?: number }
export function getExplanation(note: Note, lang: Lang): Promise<ExplainEntry | null>;
export function requestExplanation(note: Note, lang: Lang, opts?: { again?: boolean; dict?: string }): Promise<ExplainEntry>;
export function explainJob(note: Note, lang: Lang): { since: number; chars: number; error?: ClaudeError } | null;
export function onExplainChange(l: () => void): () => void;   // entries, jobs and key changes
export function explainUsage(): Promise<{ saved: number; mineThisMonth: number; costThisMonth: number }>;
export function hasClaudeKey(): Promise<boolean>;
export function claudeKeyHint(): Promise<{ hint: string; savedAt: number } | null>;
export function setClaudeKey(key: string): Promise<void>;
export function removeClaudeKey(): Promise<void>;
export function testClaudeKey(key: string): Promise<{ checked: boolean; modelListed?: boolean }>; // throws ClaudeError
// sync side
export function mergeExplanations(device: string, month: string, entries: ExplainEntry[]): Promise<boolean>;
export function ownExplanations(month: string): Promise<ExplainEntry[]>;
export function dirtyExplainMonths(): Promise<Record<string, number>>;
export function clearExplainDirty(month: string, stamp: number): Promise<void>;
// src/lib/sync.ts (WP2): EXPLAIN_PATH, explainPath(device, month), encodeExplain(device, month, entries): Uint8Array (gz),
//   decodeExplain(bytes): ExplainEntry[] (throws ExplainTooNewError when v > 1)
```

## Questions for Hugo
1. **Model.** Sonnet (best nuance, about 3¢ and about 20 s a word) or Haiku (about 1¢, about 10 s)? **Default: Sonnet.**
2. **Tapping a shown hanzi in Sheets / Quick** opens the word panel and still speaks the word. Or should a tap keep
   only speaking, with explanations behind a small ⓘ button? **Default: open the panel and speak.**
3. **Claude key on the iPhone.** Create a second key there (2 minutes in the Anthropic Console), or carry it inside the
   sync link QR code? **Default: a second key.** Nothing goes in the QR code, and each key can be revoked on its own.

## Work packages

### WP1. Lexicon data and lookup (engineer)
**Owns:** `scripts/build-lexicon.mjs`, `scripts/lexicon-lib.mjs`, `scripts/lexicon-lib.test.mjs`,
`scripts/fixtures/lexicon/**` (all new); `src/lib/lexicon.ts` and `src/lib/lexicon.test.ts` (new); `src/lib/strokes.ts`.

**Steps:**
1. Write the `lexicon.ts` contract exports first (stubs are fine).
2. In `lexicon-lib.mjs`, write the pure functions:
   - `parseCedict(text)`: CL parsing, `u:`→`v`, lower-case pinyin, proper-noun rule, merging of identical simp+pinyin.
   - `tradOnlyChars(entries)`.
   - `parseCfdictTsv(text)`.
   - `filterSentences`.
   - `indexSentences(sentences, headwords, segmenter)` (D2 rules).
   - `rankExamples`.
   - `buildShards(...)` → `{ files: Map<name, string>, index }`.
   - `shardOf` (the FNV-1a of build.ts).
3. In `build-lexicon.mjs`:
   - The env and reuse rules (D2).
   - Downloads to a temp dir (`os.tmpdir()`, 120 s timeout each), with the links fallback.
   - Streaming `bzip2 -dc`.
   - Read only the eng/fra sentence ids that are needed: links first, then a stream over the big sentence files.
   - Write the output, stats and budgets. CI exit codes like build-cfdict.
4. Fixtures, all synthetic and written by us:
   - A CEDICT-format sample for the e2e/make_sample.py words (你好, 朋友, 学校, 吃…), plus traps: 说中, a proper noun, a
     CL, a traditional-only sentence.
   - cmn/eng/fra TSVs plus link TSVs.
   - `LEXICON_SAMPLE=1` uses them and writes `sample: true`.
5. `lexicon.ts`:
   - Fetch `dict/w/<hex>.json` through `import.meta.env.BASE_URL`.
   - An LRU of 12 parsed shards.
   - Reading order, alts fallback, `formatSense`, `sensesText`, `examplePinyin`.
6. `strokes.ts`: the `'lexicon'` warm-up phase after strokes (D3).

**Tests:**
- `lexicon-lib.test.mjs`:
  - parse cases;
  - trad filter;
  - 说中 not indexed for 他会说中文;
  - 3+ character words found across segments;
  - K cap and ranking;
  - French direct vs via English;
  - deterministic output;
  - `shardOf` equals `lexiconShard` on 50 words (import the TS);
  - format v1.
- `lexicon.test.ts` (mocked fetch):
  - exact, then toneless, then other reading;
  - alts fallback;
  - not found → empty arrays;
  - `index.json` 404 → `nodata`;
  - fetch throws and nothing cached → `offline`;
  - `formatSense` for `樂|乐[le4]`;
  - `examplePinyin('我们明天去学校。')` → `wǒmen míngtiān qù xuéxiào.`

**Done when:**
- `npm test` and `npx tsc --noEmit -p .` pass.
- `LEXICON_SAMPLE=1 node scripts/build-lexicon.mjs` writes the shards plus index.json, and two runs give identical bytes.
- A plain run here warns and exits 0.
- `CI=1` with no network and no data exits 1 with a clear message.

### WP2. Claude client, explanation cache, sync (engineer)
**Owns:** `src/lib/explain/{types,prompt,claude,cache,index}.ts` and `src/lib/explain/explain.test.ts` (new);
`src/lib/sync.ts`, `src/lib/sync.test.ts`, `src/lib/backup.test.ts`. Do not touch store.ts or db.ts: use `kvGet`,
`kvSet`, `db.kv`, `getState`, `notifyLocalChange`.

**Steps:**
1. Write the contract exports first.
2. `prompt.ts`: system text, tool schema, `buildUserPrompt(note, lang, ctx)` and `normalizeExplanation` (D4).
3. `claude.ts`: the key in kv, `testClaudeKey`, `callClaude` (streaming, errors from the D4 table, timeouts, one
   retry).
4. `cache.ts`:
   - kv rows, alias fallback, jobs map, `onExplainChange`, `explainDirty` stamps, merge (newest wins), `ownExplanations`.
   - Usage from `u`, priced with `PRICES` `{ sonnet: [3, 15], haiku: [1, 5] }` per MTok. Mark it "approximate".
5. `sync.ts`:
   - `EXPLAIN_PATH` and encode/decode (gzip, `v`, too-new error).
   - Pull 3c, push 4c.
   - `idUsed` also counts `explain/<id>/`.

**Tests:**
- `explain.test.ts`:
  - request shape: URL, the four headers, model, `tool_choice`, `stream`;
  - SSE parsing from a mocked ReadableStream, including a mid-stream error event;
  - the 401, 400 (credit), 404, 429 (retry-after) and 529 mapping;
  - invalid output → one retry, then `invalid`;
  - two parallel requests → one fetch;
  - `again` → a new entry with a newer `at`;
  - the alias fallback;
  - the key never appears in any error message;
  - `normalizeExplanation` edge cases.
- `sync.test.ts` (FakeGitHub, two `device()`s):
  - the PC saves an explanation and syncs → the file `explain/<pc>/<month>.json.gz` decodes;
  - the phone syncs → `getExplanation` returns the entry, and the phone writes no explain file;
  - a `v:2` file → a warning, its sha not recorded, the rest of the sync goes through;
  - a malformed entry is skipped;
  - newest wins both ways;
  - events and marks are unchanged.
- `backup.test.ts`: with a key set, the backup contains no `sk-ant`.

**Done when:** tests and tsc pass, and no request goes to any host other than api.anthropic.com (asserted on the fetch
mocks).

### WP3. Word panel and entry points (ui-dev)
**Owns:** `src/ui/panel.tsx`, `src/ui/panel.css`, `src/ui/word/WordPanel.tsx`, `src/ui/word/ExplainView.tsx`,
`src/ui/word/word.css` (new); `src/ui/sheets/Practice.tsx`, `src/ui/sheets/practice.css`, `src/ui/Sheets.tsx`,
`src/ui/qm.tsx`, `src/ui/Quick.tsx`, `src/ui/review/CardView.tsx`, `src/ui/review/VocabBack.tsx`,
`src/ui/review/OtherCard.tsx`, `src/ui/Words.tsx`, `src/ui/common.tsx` (new icons).

**Interfaces:**
- `WordPanel({ note, tab?: 'explain' | 'practise', tabs?: ('explain' | 'practise')[], status?, onStatus?, onClose })`.
- `ExplainView({ note, inline?: boolean })`.
- `QmList` gains `onOpen?: (it: T) => void`.
- `VocabBack` and `OtherCard` gain `onExplain?: () => void`.

**Steps:** D8, in order:
1. The Shell move (Practice and Scratch keep working).
2. WordPanel with the Practise tab.
3. Sheets wiring.
4. ExplainView: lexicon, then Claude block, then examples.
5. Quick, review, Words.
6. The dialog key guards.

Pass `dict: sensesText(info.en)` to `requestExplanation`. Use the selector contract.

**Done when:** tsc and tests pass. In the preview with `LEXICON_SAMPLE=1`, every entry point opens the panel. Practice,
status and Undo in Sheets work as before. With the panel open, 1–4 do not grade.

### WP4. Settings, About, e2e (ui-dev)
**Owns:** `src/ui/Settings.tsx`; `e2e/explain.py` (new); `e2e/README.md`.

**Steps:**
1. D9: the Claude section, the Offline line plus Download, and About.
2. `e2e/explain.py`, Playwright, on the preview build:
   - Import `make_sample.py`'s workbook through the file input.
   - Sheets: tap 朋友 → the dialog shows "Dictionary" and at least one example.
   - "Explain more" → the no-key text.
   - Settings: a fake key. Mock `/v1/models` with `page.route`. Save.
   - Explain more. Mock `/v1/messages` with a canned SSE `tool_use` stream.
   - "Claude's explanation" shows with 5 examples. Assert the request headers.
   - Reopen → no new request (cached).
   - Go offline and reload → the explanation and the dictionary still show.
   - The key is not in `localStorage`.
   - Run once on desktop and once with `iPhone 13` emulation: the panel's bottom equals the viewport's bottom, the key
     input's computed font-size is at least 16 px, and there is no horizontal scroll.

**Done when:** `python3 e2e/explain.py` passes against `LEXICON_SAMPLE=1 npm run build` plus the preview.

### WP5. CI, CSP, build (release)
**Owns:** `index.html`, `package.json`, `.github/workflows/deploy.yml`, `.github/workflows/data.yml` (new);
`vite.config.ts` (verify only).

**Steps:**
1. CSP `connect-src`: add `https://api.anthropic.com`.
2. `build` and `dev`: insert `node scripts/build-lexicon.mjs` after build-cfdict.
3. deploy.yml:
   - Split the cache into `public/dict/cfdict.tsv`, keyed as today, and `public/dict/w`, keyed
     `lexicon-${{ hashFiles('scripts/build-lexicon.mjs', 'scripts/lexicon-lib.mjs') }}-${{ ym }}` with restore-keys on
     that prefix.
   - Add an e2e step `python e2e/explain.py`, with the same env as sync.py.
4. `data.yml`: on workflow_dispatch and on pushes to non-main branches that touch `scripts/**`. It runs build-cfdict and
   build-lexicon with CI set, and uploads `public/dict/w/index.json`, one shard and the stats log as an artifact.
5. Verify, after `npm run build`:
   - `dist/sw.js` precaches no `dict/` file;
   - the pinyin-pro chunk is precached;
   - the runtime `/dict/` route is intact.

**Done when:**
- The YAML is valid.
- A local build without data passes.
- After the lead pushes a branch, the `data.yml` run downloads every source. Report its stats: sizes, words, sentences,
  which links source was used.

## Order
- **All five packages start together.**
  - WP1 and WP2 write their contract exports first.
  - WP3 and WP4 code against the Contracts and do the lib-dependent parts last. If an export is missing, they report it
    and do not edit lib files.
  - WP5 is independent.
- **After all report:**
  1. The lead runs `npx tsc --noEmit -p .`, `npm test`, `LEXICON_SAMPLE=1 npm run build` and the e2e suite.
  2. The lead pushes a **branch** and checks `data.yml` (`gh run watch`, `gh run download`). This confirms the CI
     downloads and the real sizes.
  3. qa runs once.
  4. The lead merges to main.
- The lead updates the CLAUDE.md map and the sync-repo layout (`explain/<device>/<YYYY-MM>.json.gz`), and notes in
  Cloud session limits that mdbg.net and tatoeba.org are blocked here.

## Verification for qa
- **Unit tests:** `npm test` (the new lexicon, lexicon-lib, explain and sync explain tests; backup has no key); `npx tsc`.
- **Build:** a plain build here passes without data and the panel says the dictionary isn't available.
  `LEXICON_SAMPLE=1` builds work.
- **Browser, desktop (preview), and `e2e/explain.py`:**
  - The side panel at ≥ 900 px; clicking another row's hanzi swaps it.
  - Practise tab, status footer and Undo unchanged.
  - Review: the Explain button on the answer side only; `e` opens it; 1–4 ignored inside the panel.
  - Quick list and cards entry points.
  - Words detail shows the explanation inline.
  - EN/FR switch: FR shows CFDICT senses or the EN tag, French translations, and "Explain in French" when only English
    is cached.
- **iPhone emulation:** the bottom sheet inside the safe areas, 16 px input, no zoom or sideways scroll, readable
  sections, tap a sentence to speak it.
- **Offline:** after warm-up, every 128 shards are in the `dictionary` cache (Settings shows 128 of 128). An offline
  reload shows dictionary, examples and cached explanations. Explain more says it needs a connection.
- **Error paths** (route mocks): 401, 429 with retry-after, 529, stream error, invalid JSON. Each message matches the
  D4 table, and Retry works.
- **Data compatibility:**
  - Check `git show HEAD:src/lib/sync.ts`: an old client ignores `explain/` (only regex paths), and `idUsed` is fine.
  - The sync test with a `v:2` explain file.
  - No Dexie version change (`db.ts` untouched).
  - The backup format is unchanged and has no key.
  - settings.json and the link key are unchanged.
- **Security:** grep the bundle and code. The key is only sent in `x-api-key` to api.anthropic.com. It is not in
  localStorage, sync files, backups or logs. The CSP has `https://api.anthropic.com`.
- **Licences:** About lists CC-CEDICT (CC BY-SA 4.0), CFDICT (CC BY-SA 3.0) and Tatoeba (CC BY 2.0 FR) with links.
  `dict/w/SOURCES.txt` is deployed. Tatoeba links open the sentence.
- **Repo hygiene:** no xlsx, word list, key or real data committed. Fixtures are synthetic.
