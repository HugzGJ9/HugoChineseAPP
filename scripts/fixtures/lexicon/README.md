Synthetic fixtures for `LEXICON_SAMPLE=1 node scripts/build-lexicon.mjs` and `scripts/lexicon-lib.test.mjs`.
Every entry, definition and sentence here was written for Hugo 中文 tests, in the source file formats only
(CC-CEDICT text, the cfdict.tsv that build-cfdict.mjs writes, Tatoeba TSV exports). No real dictionary data, no
personal word list. Traps: 说中 (must not be found in 他会说中文), proper nouns (张, 水), CL measure words, merged
entries (干 gan1), a 9-character headword (dropped), sentences in traditional characters, with Latin letters,
too short, or with no translation (all dropped).
