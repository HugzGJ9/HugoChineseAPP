# Grammar content from Excel — plan (2026-11-21)

Supersedes grammar-window WP2–WP5 (in-app labels, lessons by Claude, their sync). Hugo used the WP1 window and
reported: FR titles empty, no families or HSK levels, EN/FR titles too long, the Lesson box and Explain more useless,
the meaning unclear, too few examples. His answers (2026-11-21) are D1–D4.

## 1. Decisions
- **D1. Grammar content lives in extra columns of the 语法 sheet** (→ docs/decisions.md GRAM-1). Claude wrote the 41
  rows once, in chat, as a sheet Hugo pastes next to his columns (never in this public repo). Excel stays the single
  source: Hugo edits a cell, the app follows at the next import. No in-app labels, no lesson store, no new sync file.
- **D2. Columns** (header names, exact, case-insensitive): `HSK` (1–6, 7 = 7–9; "HSK 5", "7-9" accepted), `Family`
  (Conditions, Time, Formal words, Complements, Emphasis, Comparing, Set phrases; French/Chinese names and prefixes
  accepted), `Title EN`, `Title FR` (≤ 6 words), `Definition EN`, `Definition FR` (one line), `Use EN`, `Use FR` (one
  bullet per line), `Register` (spoken / neutral / formal / written), `Sentences` (one per line, `中文 | français |
  English`, pinyin added at import). "Meaning FR" and "Examples" were avoided: they already map to other fields.
  Unknown family, level or register → an info line in the import report, value ignored.
- **D3. Meaning card**: definitions in both languages (reading language first), "When to use" bullets and the
  register. Reading language = French unless the switch says EN.
- **D4. Examples** = the Excel `Exemple` cell plus `Sentences`, translated in the reading language. Words from his
  vocabulary sheets are underlined in their status colour (UI-1); tapping one opens its word panel. Single characters
  of the pattern itself are not marked.
- Removed: Lesson box, Explain more, label editor, mistakes / "don't confuse" / Excel-notes sections, the in-memory
  store (`lib/grammar/store.ts`). Title language stays device-only (`titleLang.ts`, `hz.gr.lang`).

## 2. Files
- `src/lib/grammar/types.ts` (GrammarInfo), `families.ts` (names + lenient cell readers), `excel.ts` (columns →
  GrammarInfo, header aliases), `list.ts` (items, titles, search, groups, formula, `vocabIndex` / `segmentSentence`),
  `titleLang.ts`; tests in `list.test.ts`, `import/build.test.ts` ("grammar columns").
- `src/lib/types.ts`: `Note.grammar?` (additive; older versions ignore it, SYNC-2). `src/lib/import/build.ts`: the
  aliases and one call in the grammar branch.
- `src/ui/grammar/GrammarPage.tsx`, `grammar.css`; `e2e/make_sample.py` (generic grammar columns), `e2e/grammar.py`.

## 3. Later (not started)
- Examples that favour Studying / Not known words, written by Claude in the app with Hugo's key.
- A "Don't confuse with" column (只要…就 vs 只有…才, 以后 vs 之后).
- Grammar practice (fill the slot, reorder, translate) built on the Sentences column.
