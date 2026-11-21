# Grammar window — plan (2026-11-20)

Goal: a Grammar tab that lists every point of the 语法 sheet, well designed, titled in 中 / FR / EN, labelled with an HSK
level and a family; tapping one opens a lesson (formula, meaning, rules, examples with translation, mistakes, related
points). Hugo's answers (2026-11-20) are D1–D4.

## 1. Decisions
- **D1. Labels: Claude suggests, Hugo edits.** Each point has `hsk` (1–6, 7 = HSK 7–9) and `family` (7 fixed ids,
  `lib/grammar/families.ts`). A label Hugo set (`src: 'hugo'`) is never replaced by a suggestion. Labels are not
  written to Excel.
- **D2. Title language: a 中 | FR | EN switch plus search across all three.** Device-only UI state in localStorage
  `hz.gr.lang` (like QUICK-1: not a pref, not synced). Search folds case and accents, and matches the pattern, examples,
  EN, FR, lesson titles, family names and "HSK n". FR falls back to EN with an `EN` tag until a lesson exists.
- **D3. Lessons: Claude writes each one once, saved and synced, with a Regenerate button.** One call gives French and
  English together (`GrammarLesson`, `lib/grammar/types.ts`). Generated when Hugo opens a point and taps the button, or
  in one "Write all lessons" batch from the list. Works offline after.
- **D4. Placement: its own tab.** Nav is Sheets · Grammar · Settings. `#/grammar` is the list, `#/grammar/<note id>` the
  lesson. Desktop shows both side by side; a phone shows one page at a time with an "All grammar" back link. The
  old Words-based Grammar list is gone (`WordPanel`'s details link still lands on `#/grammar/<id>`).
- **D5. Excel stays the source of the points.** The list is the notes of kind `grammar` (import unchanged). Claude's
  remarks on a row (typo in an example, half-finished example) show in "Check your Excel row" and are never applied.
- **D6. Colours follow UI-1.** Fixed words in ink, slots in a neutral dashed box, status colour only on the status glyph,
  red only for the wrong sentence in a mistake. HSK and family are neutral `.tag`s.

## 2. Shipped in WP1 (skeleton, this branch)
- `src/lib/grammar/types.ts`, `families.ts`, `list.ts` (+ `list.test.ts`: items, titles, search, grouping, formula
  split), `store.ts` (**in memory only**; `requestLesson` / `suggestAllLabels` throw `NotReadyError`, `LESSONS_READY = false`).
- `src/ui/grammar/GrammarPage.tsx` + `grammar.css`: list (switch, search, Group by Family | HSK | Excel order, status
  glyph, tags) and lesson page (formula, labels editor, Meaning, Lesson placeholder, Examples, mistakes, related,
  Excel notes, same family, status picker, existing Explain more).
- `App.tsx`: Grammar tab and route. `e2e/grammar.py`: desktop + iPhone 13 checks.

## 3. Work packages left
| WP | Who | Files | What |
|---|---|---|---|
| WP2 store + sync | engineer (opus, max effort) | `lib/grammar/store.ts`, `lib/sync.ts`, `lib/syncstore.ts`, `lib/backup.ts`, tests | §4. Replace the in-memory store; labels and lessons survive reloads and sync PC ↔ iPhone |
| WP3 Claude | engineer (opus) | `lib/grammar/prompt.ts`, `lib/grammar/claude.ts` (reuse `explain/claude.ts` client and key), tests | §5. `requestLesson`, `suggestAllLabels`, batch with progress and cost; `LESSONS_READY = true` |
| WP4 UI wiring | ui-dev (sonnet) | `ui/grammar/*` | Generate / Regenerate / Write all buttons with progress and errors (reuse ExplainView's error texts), "Suggest labels" on the Not labelled group, FR family names in the select |
| WP5 checks | qa (opus, touches stored shapes) | — | Old app version + new one on the same sync folder; two devices editing labels; offline |

WP2 and WP3 have disjoint files and run in parallel; WP4 after both.

## 4. Storage and sync (WP2)
- kv rows: `gl:<note id>` → `GrammarLabel & { dev, mo }`; `gx:<note id>` → `LessonEntry & { dev, mo, own? }`. No Dexie
  version change (kv only, STORE-1).
- Sync: own entries go to `grammar/<dev>/<YYYY-MM>.json.gz` (OneDrive flat: `grammar.<dev>.<YYYY-MM>.json.gz`) with a
  separate dirty queue `grammarDirty`, exactly like explain (EXP-2). File body: `{ v: 1, labels: GrammarLabel&{k}[],
  lessons: LessonEntry[] }`. Merge: newest `at` wins per key; for labels a `hugo` entry beats any `claude` entry
  whatever the time.
- **Check first:** older app versions must ignore an unknown `grammar/` prefix when they list the sync folder (read
  `sync.ts` listing and both stores). If they don't, stop and ask: it decides the file name.
- Backups (`backup.ts`) include both; the Claude key never does (EXP-1).
- Renames: follow `meta.aliases` like `explain/cache.ts` `oldIds`, so a pattern edited in Excel keeps its lesson.

## 5. Claude (WP3)
- Model and key: same client and key as Explain (`explain/claude.ts`, `EXPLAIN_MODEL`); tool-use output validated and
  normalised like `normalizeExplanation`; `pv` = prompt version.
- Lesson prompt input: pattern, Excel meaning, Excel examples, the other patterns of the sheet (for `related`), the list of
  family ids. Asks for: title fr/en (≤ 6 words), formula with `[slot]`s, meaning fr/en, register, 1–4 rules, tip, 3–5
  examples using HSK 1–5 words (zh, pinyin, fr, en), 0–3 mistakes, 0–4 related points (prefer other rows of the sheet),
  `excelNotes` for typos in his row, `suggested` labels.
- Labels: one call with all unlabelled patterns → `{ id, hsk, family }[]`; ids not in the request are dropped.
- Cost (approximate, unverified prices from `PRICES`): ~1.5k tokens in + ~1.5k out per lesson on Sonnet ≈ $0.03; 43
  points ≈ $1.3. Show the estimate before "Write all".

## 6. Open questions
- Should grammar points written as vocabulary notes (不仅…还, 即使…也, A由B组成, 与其…不如) join the list as extra
  "points from your vocab"? Not in scope until Hugo says so.
- Grammar practice (fill the slot, reorder, translate) is a later plan; the lesson's examples and mistakes are its data.
