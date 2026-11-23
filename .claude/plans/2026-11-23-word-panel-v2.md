# Word panel v2: pinyin everywhere, tappable lines, Characters, Don't confuse (2026-11-23)

Architect plan. Builders read the decisions their package names and their own package only.

## Goal
Make the word panel (Sheets, Cards, Review, Words, Grammar) explain any Chinese it shows. It gets a pinyin line under
every Chinese line, on by default. Every word in those lines can be tapped, with a Back stack inside one sheet. New
sections: Characters with "Words with X", and "Don't confuse with" (Claude for his words, an honest offline fallback for
the rest). Words outside his list never go to Claude.

## Facts this plan relies on (checked 2026-11-23)
- Real lexicon build (deploy run 42389997088, 2026-11-07), reused by every deploy since:
  - CC-CEDICT 122,243 entries → 129,191 headwords.
  - 37,874 Tatoeba sentences have a translation; 16,232 words have at least 1 example.
  - `dict/w` is 19.89 MB raw / 9.22 MB gzipped; biggest shard 0.18 MB; the build takes 14 s.
- `/dict/` URLs are runtime-cached by the service worker ('dictionary', StaleWhileRevalidate) and kept out of precache.
  They are same-origin, so new dictionary files need no CSP or vite change.
- Explain sync: `decodeExplain` runs `normalizeExplanation` on every entry.
  - Old versions keep only the fields they know; they need a summary and at least 3 examples.
  - Entries from other devices are never uploaded again (`ownExplanations` only sends own entries).
- Bug today: a word not in his list gets `dictNote` with no pinyin, so every reading has `match: 'other'`. The
  Dictionary then shows all of them folded under "Other readings". D5 fixes this.
- `hz.ex.py` (the Pinyin chip, off by default) is a device-only localStorage pref: not synced, not backed up.

## Decisions

**D1. A pinyin line under every Chinese line, on by default.**
- Lines: Tatoeba examples, Claude's examples, collocations, patterns and their examples, mistakes (✗/✓), the
  Don't-confuse pairs (B3), and the per-character readings (B2).
- Claude's pinyin is used as given. When it is missing, the device computes it with `examplePinyin` (pinyin-pro; its
  chunk is precached, so this works offline).
- One "Pinyin" chip in the panel bar hides all pinyin lines, in every open level at once.
- New device-only pref `ex.pyOff` (default false) replaces `ex.py`. It is a new key so the new default reaches Hugo
  even if he once turned the old chip off. `ex.py` is left in place (harmless). Like `ex.py`, the new pref is not
  synced or backed up.
- Prose (summary, senses, "use" texts) gets no pinyin line.

**D2. Lines are tappable; the tokenizer moves to `src/lib/sentence.ts`.**
- What moves: `vocabIndex`, `Token`, `browserSegments`, `sentenceTokens` and `vocabLinks` leave `lib/grammar/list.ts`,
  because the panel now uses them for more than Grammar. `list.ts` re-exports them, so Grammar's imports don't change.
- New `lineTokens(zh, index, { head, pattern, segments })`. It keeps today's rules: the browser's segmentation, with
  his words laid over it by longest match. It adds `head`: each occurrence of the panel's word becomes its own token
  (`head: true`). That token wins over the segmenter and over a longer word of his, because the panel is about it.
- Looks (as in Grammar, UI-1):
  - his words: underlined 2 px in their status colour (Not studied uses `--fill-3`);
  - the headword: bold ink;
  - grammar pattern characters: bold;
  - other Han tokens: plain, tappable, with a pressed state only;
  - punctuation and Latin: not tappable.
- Only lines are split into tokens; prose and dictionary senses are not.
- Chinese chips (measure words, Characters, confuse words) are buttons that open the word.

**D3. One sheet with a navigation stack (iOS pattern), not sheets stacked on sheets.**
- `WordSheet` holds a stack of levels.
  - Tapping a word in a line pushes a "line" level: the sentence strip, where a tap widens or narrows the word
    (grammar-v3 D4), then that word's panel.
  - Tapping a chip pushes a "word" level, with no strip.
- Header: a `‹ <previous word>` back button at the leading edge when the stack is deeper than one level.
- Closing:
  - Back goes up one level.
  - Esc (desktop) goes up one level, and closes the sheet from the first level.
  - ×, the backdrop and a swipe down close the whole sheet. That is how iOS behaves: a swipe dismisses a sheet
    together with its stack.
- Lower levels stay mounted but hidden, so the selection, Claude's progress and computed pinyin survive. The scroll
  position is saved on push and restored on pop.
- No browser-history entries: no sheet uses history today, and the Home Screen app has no back button.
- Pushing an entry equal to the top one does nothing.
- Why not stacked sheets (today, SentenceWord opens a WordPanel on top):
  - the dark backdrops pile up;
  - a swipe closes only one level;
  - the HIG says to show one sheet at a time.

**D4. Statuses, the vocab index and navigation come from context, not props.**
- `useVocab()` (`src/ui/word/vocab.ts`) derives `{ index, statuses, byId }` from the store (`notes`, `marks`,
  `meta.colourSince`). A module-level memo means all lines share one computation per store change.
- `useWordNav()` (`src/ui/word/nav.tsx`) returns `open(entry)` from the nearest `WordSheet`.
- Callers keep their props:
  - `WordPanel` (Sheets, Cards, Review) is unchanged;
  - `SentenceWord` (Grammar) drops its `index` and `statuses` props.
- `ExplainView inline` on the Words page has no sheet around it. It wraps itself in `WordNavHost`, which opens a
  `WordSheet` on the first tap.

**D5. Reading in context.**
- A line level knows the reading of its selection: `lineReadings(zh)` runs pinyin-pro on the whole line, so polyphones
  follow context (银行 → háng); the result is sliced to the selection.
- This reading is used:
  - as the title pinyin of a word not in his list;
  - as the `pinyinNum` passed to `lookupWord`, so that reading is listed first and the others go under "Other
    readings";
  - for the Characters readings (B2).
- Chips carry the dictionary's reading.
- Bug fix: when no reading matches (no context, e.g. a measure-word chip), all readings are listed as primary instead
  of folded away.

**D6. Words not in his list never go to Claude** (grammar-v3 D5 still holds).
- The offline panel explains them with:
  - Dictionary, with the context reading first;
  - Characters and Words with X (B2);
  - Similar meaning (B3);
  - tappable examples with pinyin;
  - the existing "Your words with X" links.
- There is no "Explain more" and no status, and no prompt ever contains such a word.

**D7. Characters section (B2).**
- Shown for words of 2 or more Han characters: one card per distinct character, in order (谢谢 → one card).
- Each card shows:
  - the character, tappable;
  - its reading in this word: from D5 or `note.pinyinNum`, matched to the characters only when the syllable count
    equals the Han count, else the dictionary's first reading;
  - its core meaning: the senses of that reading from `lookupWord(char, syllable)`.
- Meaning language: French from CFDICT when the app is in FR and CFDICT has the character, else English tagged EN.
- Senses: up to 3. Senses starting with "variant of", "see …", "surname …" or "Kangxi radical …" are left out, unless
  nothing else is left.
- Meaning only: no radicals, components or decomposition.
- A single-character word gets no card, because the Dictionary section already gives that character's meaning. It gets
  only "Words with X".
- Grammar notes get no Characters section.

**D8. Words with X (B2).** For each character:
- (a) His words that contain it:
  - status chips (`StatusIcon`, as in Grammar's links), in list order, without the current word;
  - 12 shown, then "Show all";
  - a tap pushes his panel.
- (b) Common dictionary words that contain it, from the new index (D9):
  - 8 shown, then "More" (up to 24);
  - his words and the headword are left out;
  - each chip shows the hanzi and a short meaning in the app language (French when CFDICT has the word);
  - a tap pushes the offline panel.
- When the data is missing, (b) is hidden. When the device is offline and nothing is cached, one line says "Connect
  once to download the dictionary."

**D9. Character index `public/dict/c/` (new files, format v1).**
- Built in the same run as `dict/w`, from the same inputs: no new source and nothing new to download.
- Common word: 2 or more characters, a Tatoeba count of at least 1 or a CFDICT entry, and not an entry that is only a
  name or a variant ("Tom (name)", "surname Zhang", "variant of …").
- Ranking for each character:
  1. Tatoeba sentence count: how many of the 37,874 translated sentences contain the word, taken from the example index
     the build already computes;
  2. has a CFDICT entry;
  3. shorter word;
  4. code-point order (keeps the output deterministic).
- Why Tatoeba counts:
  - already downloaded and licensed (CC BY 2.0 FR, listed in SOURCES.txt);
  - everyday sentences;
  - no new data;
  - its known bias (Tom = 汤姆 and Mary = 玛丽 appear in thousands of sentences) is removed by the name filter.
- Rejected sources:
  - SUBTLEX-CH: the redistribution licence is unclear;
  - HSK lists: no clean licence;
  - Wiktionary frequency lists: a new download and more pipeline for little gain.
- Format: 64 shards by FNV-1a % 64 (B3's `n` uses the same shards).
```ts
// public/dict/c/index.json
interface CharIndex { v: 1; shards: 64; built: string; sample?: true; chars: number; words: number; bytes: number; similar?: number /* B3 */ }
// public/dict/c/00.json … 3f.json
interface CharShardFile {
  v: 1;
  /** Character → common words containing it, best first, ≤ 24: [word, pinyinNum, en, fr?] (en '' for CFDICT-only words). */
  c: Record<string, [string, string, string, string?][]>;
  /** B3: word → up to 4 words sharing a dictionary meaning, best first. Absent before B3; readers ignore unknown keys. */
  n?: Record<string, string[]>;
}
```
- Short meaning: the first sense that is not a cross-reference, variant or name. CEDICT references like `樂|乐[le4]`
  become `乐`. At most 32 characters, cut at a word boundary with "…".
- Size, estimated from the real counts above:
  - `c` is about 3–5 MB raw and about 1.2–1.8 MB gzipped, so the gzipped dictionary grows 15–20 % from 9.2 MB;
  - the build prints its stats and warns above 8 MB raw;
  - with CI set, it fails above 15 MB raw or when one shard is over 600 KB;
  - a real build must have rows for at least 3,000 characters, otherwise it counts as failed.
- A later incompatible format goes to `dict/c2/`.
- Reuse:
  - an existing build is reused only when `w` and `c` are both present and valid; otherwise everything is rebuilt;
  - if a rebuild fails, the old `w` is kept even without `c`, and the app hides the common-word lists.
- Licences: the data comes from CC-CEDICT (BY-SA 4.0), CFDICT (BY-SA 3.0) and Tatoeba (BY 2.0 FR). `c/SOURCES.txt`
  works like `w/SOURCES.txt`.
- Old app versions never request `dict/c`. The format and bytes of `dict/w` don't change.

**D10. Don't confuse with, for his words: Claude (B3).** Additive schema, prompt v2:
```ts
interface ZhItem { zh: string; pinyin: string; tr: string }
interface ConfuseItem {
  word: string; pinyin: string;
  /** When to use which: meaning, context, register, typical collocations or grammar; 1–3 sentences. */
  use: string;
  /** Contrasting pair in similar situations: a sentence with the headword, one with the other word. */
  self?: ZhItem; other?: ZhItem;
}
interface Explanation { /* … unchanged … */ confuse?: ConfuseItem[] /* prompt v2: 0–4; absent in v1 entries */ }
```
- Schema and stored entries:
  - The tool schema asks for `confuse` (required, 0–4 items, each with its pair) instead of `nuance`.
  - `normalizeExplanation` keeps `confuse`, even when empty. When the answer has no `nuance`, it fills `nuance` from
    `confuse` (`diff` = `use`). The synced file then still carries `nuance`, so a device on an older version shows
    "Close words" for new explanations instead of nothing. The cost is a few hundred bytes per entry.
  - `PROMPT_VERSION = 2` (stored as `pv`).
  - The explain file format stays `v: 1`. A bump would make old versions skip the whole file and show "Update the app".
- Display:
  - Old entries (no `confuse`) show their `nuance` in this section, without pairs, with "From an older explanation ·
    Ask again for example pairs".
  - `confuse: []` hides the section.
  - The "Close words" block leaves Claude's card.
- Request size:
  - `max_tokens` goes from 4096 to 8192: the answer grows by about 1,000 tokens, about +$0.015 per explanation at
    Sonnet prices.
  - The progress bar denominator goes from 4,500 to 6,500 characters.
- Healing:
  - Problem: a device that merged a v2 entry while still on an older version kept it without `confuse`.
  - Fix: `mergeExplanations` now replaces an entry from the same device with the same `at`, because that device's file
    is authoritative (SYNC-1).
  - Result: the entry heals the next time that month's file changes; otherwise Hugo can Ask again.

**D11. Similar meaning, offline (B3).**
- Shown for words not in his list, and for his words until Claude has explained them.
- Build, for each common word (D9; here single characters count too):
  - find the words that share a normalised dictionary meaning;
  - meanings come from the English and the French senses: lower case, without parentheses, leading "to" or articles,
    cross-references and names;
  - only meanings shared by 2–40 common words count;
  - score = Σ 1/log2(1 + df); ties go by Tatoeba count, then code point;
  - the top 4 go into `n` in the c shards.
- UI, for each similar word:
  - the word (tappable) with its pinyin;
  - its first 2 senses in the app language;
  - its first Tatoeba example (tappable, with pinyin).
- Text:
  - title "Similar meaning";
  - footer "Words that share a dictionary meaning with X. Compare their senses and examples.";
  - for his words, the footer adds "Explain more gives Claude's comparison."
- Honest limits:
  - it finds words that translate alike, not words that are interchangeable;
  - it misses near-synonyms whose dictionary wording differs;
  - generic meanings are skipped, so many words get nothing and the section is hidden;
  - it never says when to use which; only Claude does that.

**D12. Section order.** Explanations come first, references after; the offline similar list is the weakest signal, so
it comes after Characters.
- His word: Your list · Dictionary · Claude's explanation · Don't confuse with (or Similar meaning) · Characters /
  Words with X · Examples · Status.
- A word not in his list: strip · Your words with X · Dictionary · Characters / Words with X · Similar meaning ·
  Examples.

**D13. Compatibility.**
- IndexedDB: no Dexie bump (STORE-1). The only stored change is an optional field inside the explanation kv rows.
- Sync:
  - explain files change only additively (D10);
  - no new synced file;
  - `ex.pyOff` is device-only and never in settings.json or backups.
- Events, marks and cards are untouched. Nothing derived is stored; `c` and `n` are static build data.
- iPhone:
  - nothing uses File System Access;
  - the Home Screen app keeps its own storage, which matters only for `ex.pyOff`, and its default is on;
  - no new inputs, so the 16 px rule doesn't apply;
  - the back button sits in the existing sheet header, so safe areas don't change;
  - offline: the warm-up prefetches the `dict/c` shards like `dict/w`, and pinyin-pro is precached.
- PWA and CSP: no new host, no vite config change; `dict/**` stays out of precache.

## Questions for Hugo
None blocking. He can change these defaults when he reviews a batch:
1. A swipe down closes the whole sheet; Back goes up one level (D3).
2. His words without a Claude explanation show the offline "Similar meaning" (D11).
3. Common-word chips show a short meaning, not only the hanzi (D8).

## Batch 1: pinyin under every line, tappable lines

### WP1.1 Tokenizer and context readings (engineer)
Files: `src/lib/sentence.ts` (new), `src/lib/sentence.test.ts` (new), `src/lib/grammar/list.ts`,
`src/lib/grammar/list.test.ts`, `src/lib/lexicon.ts`, `src/lib/lexicon.test.ts`.
```ts
// src/lib/sentence.ts (header comment: design, cite this plan D2)
export interface VocabIndex { forms: Map<string, string>; max: number }
export function vocabIndex(notes: Note[]): VocabIndex;                                   // moved
export interface Token { s: string; start: number; note?: string; pattern?: boolean; head?: boolean; word: boolean }
export function browserSegments(zh: string): string[];                                  // moved
export function lineTokens(zh: string, index: VocabIndex,
  opts?: { head?: string[]; pattern?: string; segments?: (s: string) => string[] }): Token[];
export function sentenceTokens(zh: string, index: VocabIndex, pattern?: string,
  segments?: (s: string) => string[]): Token[];                                         // = lineTokens(zh, index, { pattern, segments })
export function vocabLinks(word: string, index: Pick<VocabIndex, 'forms'>, max?: number): string[];  // moved
// src/lib/lexicon.ts
/** One numbered syllable per code point of zh (CEDICT style: ü as v, neutral tone 5), '' for non-Han; pinyin-pro in context. */
export function lineReadings(zh: string): Promise<string[]>;
```
Steps:
1. Move the code. `list.ts` re-exports it (`export { … } from '../sentence'`) and keeps `patternChars`. Drop the unused
   `Segment` type.
2. Implement `head`:
   - only Han-only forms, longest first, left to right, without overlaps;
   - the bounds of each occurrence become cuts;
   - a word of his that overlaps an occurrence is not used there, unless it covers exactly that occurrence; then the
     head token also carries its `note`;
   - `pattern` splitting stays as it is.
3. `lineReadings` shares the `import('pinyin-pro')` with `examplePinyin` and maps tone 0 to 5.

Tests:
- Move the `sentenceTokens` and `vocabLinks` cases unchanged; they must pass as they are.
- New `lineTokens` cases:
  - head splits a segmenter word (学 in 学校);
  - head wins over his longer word (学 vs 学习);
  - a head equal to his word keeps `note`;
  - two occurrences;
  - the longest form comes first (学习 over 学);
  - Latin and punctuation give `word: false`;
  - without `head`, the output equals `sentenceTokens` on the existing cases.
- `lineReadings('我去银行。')` gives `['wo3','qu4','yin2','hang2','']`; 们 in 我们 gives `men5`.

Done when: `npx vitest run src/lib/sentence.test.ts src/lib/grammar/list.test.ts src/lib/lexicon.test.ts` and
`npx tsc --noEmit -p .` pass, and GrammarPage compiles unchanged.

### WP1.2 Word sheet stack and tappable lines (ui-dev)
This is the largest package. The lead may split it into 1.2a and 1.2b:
- 1.2a, the stack: panel, nav, vocab, WordSheet, WordPanel, SentenceWord, GrammarPage, grammar.py. It writes
  `nav.tsx` and `vocab.ts` first.
- 1.2b, the lines: ZhLine, ExplainView, word.css, explain.py.

Files: `src/ui/panel.tsx`, `src/ui/panel.css`, `src/ui/word/nav.tsx` (new), `src/ui/word/vocab.ts` (new),
`src/ui/word/WordSheet.tsx` (new), `src/ui/word/ZhLine.tsx` (new), `src/ui/word/WordPanel.tsx`,
`src/ui/word/SentenceWord.tsx`, `src/ui/word/ExplainView.tsx`, `src/ui/word/word.css`,
`src/ui/grammar/GrammarPage.tsx` (only the `SentenceWord` call), `e2e/explain.py`, `e2e/grammar.py`.
```ts
// panel.tsx (additive): leading "‹ label" button, ink, ≥ 44 px, truncates; Esc calls onBack when it is set
Sheet({ …, back }: { …; back?: { label: string; onBack: () => void } })
// nav.tsx
export type WordEntry =
  | { t: 'note'; note: Note; practiseHref?: string; rowId?: string | number; status?: WordStatus; onStatus?: (s: WordStatus) => void }
  | { t: 'line'; zh: string; start: number; length: number }
  | { t: 'word'; word: string; pinyinNum?: string };
export interface WordNav { open(entry: WordEntry): void }
export const WordNavContext: React.Context<WordNav | null>;
export function useWordNav(): WordNav | null;
export function WordNavHost({ children }: { children: ReactNode }): JSX.Element; // no sheet around: first open() shows a WordSheet (portal)
export function sameEntry(a: WordEntry, b: WordEntry): boolean;
export function retarget(s: number, e: number, k: number): [number, number];     // moved from SentenceWord.tsx
export function dictNote(word: string): Note;                                     // moved from SentenceWord.tsx
// vocab.ts
export function useVocab(): { index: VocabIndex; statuses: Map<string, WordStatus>; byId: Map<string, Note> };
// WordSheet.tsx
export function WordSheet(p: { root: WordEntry; onClose: () => void; className?: string }): JSX.Element;
// ZhLine.tsx
export function usePinyinShown(): [boolean, (shown: boolean) => void]; // pref 'ex.pyOff'; one store for all mounted levels
export function PinyinChip(): JSX.Element;                             // "Pinyin", aria-pressed = shown
export function ZhText(p: { zh: string; head?: string[]; pattern?: string }): JSX.Element;
export function ZhBlock(p: { zh: string; pinyin?: string; tr?: ReactNode; trLang?: string; trTag?: string; head?: string[];
  pattern?: string; audio?: boolean; mark?: 'wrong' | 'right'; children?: ReactNode /* after tr: the Tatoeba link */ }): JSX.Element;
// ExplainView.tsx: + reading (numbered pinyin used to rank dictionary readings)
ExplainView(p: { note: Note; inline?: boolean; mine?: boolean; reading?: string })
// Callers keep these:
WordPanel(props as today)            → <WordSheet root={{ t: 'note', … }} className="wp tall" />
SentenceWord({ zh, start, length, onClose }) → portal(<WordSheet root={{ t: 'line', … }} className="wp tall sw" />)
```
Steps:
1. WordSheet stack:
   - Levels are `{ id, entry, sel?, readings?, scroll, opener }`. The line selection lives in the level record, so the
     title follows it when the selection changes. Readings come from `lineReadings`.
   - Title: his note → hanzi + `note.pinyin` (+ `#rowId` on the root); otherwise the word + its marked reading.
   - `label` = the top level's word; e2e finds the dialog by this name.
   - Back label = the previous level's word, at most 6 characters.
   - Each level renders `<div class="wl" hidden>`; the top one has `class="wl top"`.
   - The scroll container is the sheet's `.pp-panel` (`closest('.pp-panel')`).
   - Push saves the scroll and the opener, then scrolls to 0 and focuses the new level (`preventScroll`). Pop restores
     the scroll in a layout effect, then focuses the opener.
2. Level bodies:
   - note: bar (Practise, root only, when given · PinyinChip · LangSwitch), then `ExplainView`, then Status + Details.
     The root uses its `status`/`onStatus`; pushed notes use `useVocab` + `setNoteStatus`.
   - line: strip and hint (as today); bar (In your list / Not in your list · PinyinChip · LangSwitch); "Your words with
     X" for words not in his list; `ExplainView`; Status for his words. `ExplainView` gets his note with `mine`, or
     `dictNote(word)` with `mine={false}` and `reading`.
   - word: like line, without the strip.
3. Lines:
   - `ZhText`: `lineTokens(zh, useVocab().index, { head, pattern })`, memoised. Han tokens render as
     `<button type="button" class="zt-w [mine st-x] [head] [pat]">` and call `open({ t: 'line', zh, start, length })`.
   - `ZhBlock`: grid of `zh audio / py / tr / children`. The pinyin line is `pinyin || examplePinyin(zh)`, hidden when
     the chip is off. It has an `AudioButton` "Play sentence", except on mistakes.
4. ExplainView:
   - Every Chinese line goes through `ZhBlock`/`ZhText`. `head` = the Han-only forms of `[hanzi, ...alts]`; grammar
     notes pass `pattern = patternChars(note)` instead.
   - Patterns: `ZhText` for the pattern, then its pinyin line and translation. Mistakes: `ZhBlock mark`.
   - Close-words words and measure-word chips: buttons that call `open({ t: 'word', word })`.
   - Remove `PY_PREF`, `PyChip`, the old `ZhLine` and `SentencePinyin`.
   - Call `lookupWord(note.hanzi, reading ?? note.pinyinNum, note.alts)`.
   - `DictBody`: when no reading is `exact`/`toneless`, list all readings as primary (D5).
   - `inline`: with no nav, wrap in `WordNavHost` and show a `PinyinChip` above the sections.
   - The Tatoeba link moves under the translation.
5. CSS (tokens only, light and dark):
   - `.zt-w` looks like `.gr-w`: underline 2 px `--st` with a 4 px offset; `.st-new` uses `--fill-3`; `.head` is
     weight 700; pressed state `--press`.
   - Chinese lines are at least 18 px on coarse pointers, with line-height at least 1.7 so underlines clear the pinyin.
   - Optional, only under `html.motion`: a 200 ms slide or fade between levels.
6. GrammarPage: call `<SentenceWord … onClose />` without `index` and `statuses`.

Tests (e2e, desktop and iPhone 13):
- `explain.py`:
  - Tatoeba examples show a non-empty `.wx-py` by default.
  - Add a collocation with empty pinyin to the mock: its pinyin appears, computed on the device.
  - The chip hides every pinyin line, stays off after closing and reopening, then turns back on.
  - In Claude's example 他是我的朋友。, 朋友 has `.head` and 他/我/是 have `.mine`.
  - Tap 的: `.wl.top .sw-strip` exists and `.pp-back` names 朋友; Back restores the scroll (±4 px).
  - Go 3 levels deep. Esc returns to level 2 (desktop), then × closes everything.
  - iPhone: the back button is at least 44 px tall, and a downward touch drag on a nested level closes the sheet (use
    layout.py's CDP touch helper).
  - Words page (`#/words/<id>`): tapping a word in its examples opens a sheet; × returns to the page.
  - Check that `get_by_text('他是我的朋友。')` still finds a tokenised line; if not, use
    `locator('.zt', has_text=…)`.
- `grammar.py` passes unchanged: the root line level keeps `.sw`, `.sw-c`, `.sw .wp-hz` and `.wp .wp-status`. New
  selectors are scoped to `.wl.top`, because hidden levels stay in the DOM.

Done when:
- `npm run build` passes;
- `explain.py`, `grammar.py`, `layout.py` and `cards.py` pass on a `LEXICON_SAMPLE=1` build;
- the report includes iPhone screenshots of a nested level, light and dark.

### Batch 1 order and checks
- WP1.1 and WP1.2 run in parallel. WP1.2 codes against the signatures above and runs its checks once WP1.1 reports.
- qa on opus (the batch touches `src/lib`). Hugo gets the screenshots before the deploy.
- Hugo's iPhone check after the deploy:
  - pinyin under every line;
  - a tap opens the next level;
  - Back returns to where he was;
  - a swipe closes the sheet;
  - no sideways scroll, in dark mode too.

## Batch 2: Characters and Words with X

### WP2.1 Character index: build and reader (engineer)
Files: `scripts/lexicon-lib.mjs`, `scripts/lexicon-lib.test.mjs`, `scripts/build-lexicon.mjs`,
`scripts/fixtures/lexicon/*` (synthetic additions only), `src/lib/lexicon.ts`, `src/lib/lexicon.test.ts`,
`src/lib/sentence.ts`, `src/lib/sentence.test.ts`.
```js
// scripts/lexicon-lib.mjs
export const CHAR_SHARDS = 64;
export const charShardOf = (key) => fnv1a(key) % CHAR_SHARDS;
// buildShards(...) → { files, index, stats, freq }   freq: Map<word, number> = sentences per headword (the `hits` it already builds)
export function shortGloss(senses, max = 32) /* → string */;
export function isNameOrVariant(senses) /* → boolean: every sense is a name, surname, variant or cross-reference */;
export function buildCharIndex({ cedict, cfdict, freq, similar /* B3, optional Map */, built, sample, options /* { perChar: 24 } */ })
  /* → { files: Map<'00.json'…'3f.json', string>, index: CharIndex, stats: { chars, words, bytes, biggest } } */;
```
```ts
// src/lib/lexicon.ts
export const CHAR_SHARDS = 64;
export function charShard(key: string): number;
export interface CharWord { word: string; pinyinNum: string; pinyin: string; en: string; fr?: string }
export type CharLookup = { ok: true; words: CharWord[] } | { ok: false; reason: 'nodata' | 'offline' | 'error' };
export function charWords(ch: string): Promise<CharLookup>;          // ok with [] when the character has no row
export function charGloss(senses: string[], max?: number): string;   // D7 filter, joined with '; '
// prefetchLexicon / lexiconCached also cover dict/c/index.json and its shards when that index exists
// src/lib/sentence.ts
export function vocabWithChar(ch: string, index: VocabIndex): string[]; // note ids whose forms contain ch, without duplicates
```
Steps:
1. lexicon-lib:
   - `freq` comes from `hits`.
   - `buildCharIndex` follows D9: common words, ranking, rows, sorted keys, deterministic bytes.
   - `c/SOURCES.txt` reuses `sourcesText` with a title for `c`.
2. build-lexicon.mjs:
   - Write `public/dict/c` the same way as `w` (`c.tmp`, then rename).
   - Reuse only when `w` and `c` are both valid: the c index has `v: 1` and `shards: 64`, and every shard file exists.
   - `oldUsable` keeps `w` when `c` is missing, with a warning.
   - Stats and budgets as in D9, plus the plausibility check of at least 3,000 characters.
   - Log the rows for 学, 汤 and 好. Actions artifacts can't be downloaded from the cloud shell; `gh run view --log` can
     be read.
3. Fixtures (synthetic, written for the tests):
   - add `汤姆 [Tang1 mu3] /Tom (name)/`, `汤 [tang1] /soup/`, one ordinary word with 汤, and two sentences with 汤姆;
     a test then proves names are left out despite their counts;
   - add single characters `学 [xue2]`, `校 [xiao4]` and `校 [jiao4]`; the e2e opens 学校 and needs a meaning per
     card, and the second 校 reading tests that the reading follows the word;
   - update the fixtures README.
4. lexicon.ts:
   - memoised c index and a shard LRU of 8, with the same 'nodata' / 'offline' / 'error' rules as `w`;
   - `charWords` returns marked pinyin;
   - prefetch and the cached counts include `c`, so Settings shows "x of 192".
   - Update the tests that expect 128.

Tests:
- Ranking: count, then CFDICT, then shorter, then code point.
- Name and variant words are left out; the character itself is left out; lists are cut at 24.
- 64 v1 shards, with identical bytes on two runs (extend the build-lexicon sample test to `c/`).
- `charShardOf` equals `charShard`.
- Reuse rejects a `w` without `c`.
- Reader: the right shard URL; 'nodata' without the index; 'offline' falls back to the cache; prefetch counts.
- `charGloss` drops variant, see, surname and radical senses but keeps "used in".
- `vocabWithChar`.

Done when:
- `npx vitest run scripts/lexicon-lib.test.mjs src/lib/lexicon.test.ts src/lib/sentence.test.ts` and tsc pass;
- `LEXICON_SAMPLE=1 node scripts/build-lexicon.mjs` writes `public/dict/c`;
- after the lead pushes the branch, `data.yml` passes with sizes within budget and sensible sample rows in its log.

### WP2.2 Characters section (ui-dev)
Files: `src/ui/word/Characters.tsx` (new), `src/ui/word/ExplainView.tsx`, `src/ui/word/word.css`, `e2e/explain.py`.
```ts
export function CharactersSection(p: { word: string; reading?: string; excludeId?: string }): JSX.Element | null;
```
Steps:
- Follow D7, D8 and D12. ExplainView passes the reading it used for the lookup, else the first reading it found, and
  passes `excludeId` = his note id.
- Cards use `wx-card` rows.
- The character is tappable: `open({ t: 'word', word: ch, pinyinNum: syllable })`.
- His chips reuse Grammar's link chip (`chip sw-link st-*` + `StatusIcon`).
- Common chips: hanzi + a muted meaning, one line, ellipsis.
- "More" and "Show all" are `wx-action` rows.
- Single-character words get only the "Words with X" section.

Tests (`explain.py`, must pass on sample and real data):
- Open 学校: a "Characters" heading, 2 cards (学 and 校) with readings xué and xiào and a non-empty meaning.
- The 学 card lists 学生 and 学习 among the common words. Tapping 学生 opens a nested level that says "Not in your
  list"; Back returns.
- Open 好 (single character): no "Characters" heading, and a "Words with 好" section with his 你好 chip.

Done when: the build and e2e pass on a sample build; iPhone screenshots, light and dark.

### WP2.3 Cache and data check (release, or the lead: under 10 lines)
Files: `.github/workflows/deploy.yml`, `.github/workflows/data.yml`.
Steps:
- In deploy.yml, the lexicon cache `path` covers both `public/dict/w` and `public/dict/c`.
- In data.yml, the Sizes step adds `c` (`du`, gzip total, `cat public/dict/c/index.json`) and copies the c index and
  `c/SOURCES.txt` into the artifact.

Done when: a data.yml run on the branch shows both trees.

### Batch 2 order and checks
- WP2.1, WP2.2 and WP2.3 run in parallel. WP2.2 tests once WP2.1's sample build exists.
- qa on opus.
- Hugo's iPhone check:
  - a few of his words and one word that is not in his list;
  - Characters are readable, chips can be tapped, Back works;
  - after the warm-up, in airplane mode, Characters and common words still show.

## Batch 3: Don't confuse with

### WP3.1 Explanation schema v2 (engineer)
Files: `src/lib/explain/types.ts`, `src/lib/explain/prompt.ts`, `src/lib/explain/claude.ts`, `src/lib/explain/cache.ts`,
`src/lib/explain/explain.test.ts`, `src/lib/sync.test.ts` (explain decode cases only).
Interfaces:
- The D10 types.
- `PROMPT_VERSION = 2`.
- `INPUT_SCHEMA.properties.confuse`: an array, maxItems 4. Items are `{ word, pinyin, use, self: zhItem, other: zhItem }`,
  all required.
- `confuse` goes into `required`; `nuance` leaves both the properties and `required`.

Steps:
1. System prompt:
   - Replace the nuance line with: "confuse: up to 4 words learners mix up with this one (near-synonyms, words used in
     the same slot); for each, when to use which (meaning, context, register, typical collocations or grammar) and one
     natural sentence with each word in similar situations, 6–20 characters".
   - Grammar line: "use confuse for similar structures".
2. `normalizeExplanation`:
   - caps: word 60, pinyin 200, use 600, at most 4 items;
   - drop items with no word or no use;
   - fill `nuance` from `confuse` only when the answer has none.
3. `max_tokens: 8192`.
4. Merge tie-break in `mergeExplanations`: `cur.dev > device`, so a same-device entry with the same `at` is replaced.

Tests:
- normalize keeps and caps `confuse`, keeps `[]`, and fills `nuance` only when it is absent.
- A v1 entry normalizes unchanged, with no `confuse` key.
- An encode → decode round trip keeps `confuse`.
- v1 compatibility: an encoded v2 entry's `x` has a summary, at least 3 examples and a non-empty `nuance`.
- The request body carries `max_tokens` 8192 and the new schema.
- Merge with the same `at`: the same device replaces; different devices keep the larger-id rule.

Done when: `npx vitest run src/lib/explain src/lib/sync.test.ts` and tsc pass.

### WP3.2 Similar-meaning data (engineer)
Files: `scripts/lexicon-lib.mjs`, `scripts/lexicon-lib.test.mjs`, `scripts/build-lexicon.mjs`,
`scripts/fixtures/lexicon/*`, `src/lib/lexicon.ts`, `src/lib/lexicon.test.ts`.
```js
export function glossKeys(enSenses, frSenses) /* → string[] like 'en:help', 'fr:aider' */;
export function buildSimilar({ cedict, cfdict, freq, options /* { maxDf: 40, perWord: 4 } */ }) /* → Map<word, string[]> */;
// buildCharIndex(..., similar) writes `n` and sets index.similar to the number of words with an entry
```
```ts
export function similarWords(word: string): Promise<{ ok: true; words: string[] } | { ok: false; reason: 'nodata' | 'offline' | 'error' }>;
```
Steps:
- Follow D11.
- Reuse now also requires a numeric `similar` in `c/index.json`.
- Log sample `n` rows (帮助, 朋友).
- Fixtures (synthetic):
  - 帮助 /to help/to assist/, 帮忙 /to help/to do a favor/, 协助 /to assist/;
  - 友人 /friend/, with a CFDICT line, so 朋友 has one similar word in the sample build; e2e uses it.

Tests:
- A shared rare meaning makes a candidate; a generic meaning (df above maxDf) is ignored.
- Names are left out; the ranking is deterministic.
- `n` goes into `charShardOf(word)`.
- The reader returns [] when there is no row.

Done when: tests pass, the sample build writes `n`, and the data.yml sample rows look sensible.

### WP3.3 Don't confuse / Similar meaning UI (ui-dev)
Files: `src/ui/word/Confuse.tsx` (new), `src/ui/word/ExplainView.tsx`, `src/ui/word/word.css`, `e2e/explain.py`.
```ts
export function ConfuseSection(p: { x: Explanation; head: string[]; onAskAgain: () => void; online: boolean }): JSX.Element | null;
export function SimilarSection(p: { word: string; mine: boolean }): JSX.Element | null;
```
Steps:
- Follow D10–D12. ClaudeSection renders `ConfuseSection` after Claude's card when an entry (or a fallback) is shown,
  else `SimilarSection`. For words not in his list, `SimilarSection` comes after Characters.
- Remove "Close words" from `ExplanationBody`.
- Each confuse item:
  - the word: Han-only and at most 8 characters → a button calling `open({ t: 'word' })`; otherwise `ZhText`;
  - its pinyin with `Pinyin`;
  - the `use` text;
  - `self` (head = the headword forms) and `other` (head = `[item.word]`) as `ZhBlock`s;
  - items equal to the headword are dropped.
- Old entries: their nuance items, plus a footer with "Ask again" that calls `ask(true)` and is disabled offline.
- Progress denominator: 6500.

Tests (`explain.py`):
- The mock answer gains `confuse`: 2 items with pairs, one pair line with empty pinyin. "Don't confuse with" shows 2
  items, and each pair line has a pinyin line.
- Tapping an item's word opens a nested level.
- A second mocked word gets an answer with only `nuance`, like an older answer. It shows the items without pairs and
  "Ask again for example pairs".
- Before Explain more, 朋友 shows "Similar meaning" with at least 1 item (友人 in the sample; any word in real data).

Done when: the build and e2e pass; iPhone screenshots.

### Batch 3 order and checks
- WP3.1, WP3.2 and WP3.3 run in parallel; WP3.3 runs its checks after both engineers report.
- qa on opus (stored shapes and sync).
- Hugo's iPhone check:
  - Explain more on two of his words → Don't confuse with, with pairs;
  - an old explanation shows its close words with Ask again;
  - a word not in his list shows Similar meaning;
  - the cost line in Settings looks plausible.

## Verification for qa (each batch, on top of the package tests)
- Unit: `npm test`, `npx tsc --noEmit -p .`, `npm run build`; `npm run coverage` covers the new `src/lib` code.
- Browser, desktop 1280×860 and iPhone 13, light and dark:
  - the batch's e2e plus `layout.py`, `cards.py`, `grammar.py`, `offline.py`;
  - the panel opens from Sheets, Cards, Review, Words and Grammar;
  - 3 levels deep: Back, Esc, × and swipe;
  - no sideways scroll; tappable lines at least 18 px on phones.
- Data compatibility:
  - B1:
    - no IndexedDB or sync change;
    - `hz.ex.pyOff` lives only in localStorage, never in `collectPrefs('backup' | 'shared')`.
  - B2:
    - `dict/w` bytes are unchanged for the same sample inputs: the determinism test, plus a diff of the sample `w/` of
      main against the branch;
    - the previous dist with the new `dict/` works: the panel opens and nothing requests `dict/c`;
    - after the warm-up, `dict/c` is in the 'dictionary' cache, and the offline panel shows Characters;
    - data.yml sizes are within budget and the ranking rows are sensible.
  - B3:
    - run the pre-B3 `normalizeExplanation` (`git show <base>:src/lib/explain/prompt.ts` into a throwaway file that is
      not committed) on a v2 entry: the result is non-null and `nuance` is non-empty;
    - a v1 entry renders in the new UI;
    - two fake devices sync (the `sync.test.ts` helper), one with a v1 entry and one with a v2 entry;
    - the Dexie version is unchanged and the explain file `v` is still 1.

## Risks
- Inline words are small tap targets on the iPhone (as in Grammar). Font size and line height mitigate it; Hugo judges.
- Hidden levels stay mounted. Each is a few hundred nodes and there is no cap; revisit if Hugo goes 10 or more levels
  deep.
- The quality of the common-word ranking (translationese in Tatoeba, small counts for rare words) and noise in Similar
  meaning:
  - knobs in lexicon-lib: `perChar`, `maxDf` and the filters;
  - judged from the data.yml sample rows and from Hugo's use.
- v2 answers are longer: about +$0.015 and a few seconds per explanation.
- A device that merged a v2 entry while still on an old version shows the old close words until that month's file
  changes or Hugo asks again (D10).

## Later (not in scope)
- Claude batch-writes a "Don't confuse" column into his Excel vocab sheets, like the 语法 columns (GRAM-1). Excel stays
  the source; the panel shows the column first and Claude's section second.
- Practise from nested levels; browser history for sheets.

## After shipping (lead)
- docs/decisions.md entries:
  - DICT-1: `dict/c`, its ranking and budgets (D9);
  - EXP-3: `confuse` is additive, `nuance` is filled for old versions, and the explain file stays v1 (D10);
  - UI-3: one word sheet with a stack, and context hooks instead of props (D3, D4).
- CLAUDE.md map lines: `src/lib/sentence.ts`, `src/ui/word/WordSheet.tsx`, `nav.tsx`, `vocab.ts`, `ZhLine.tsx`,
  `Characters.tsx`, `Confuse.tsx`.
