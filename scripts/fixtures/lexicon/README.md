Synthetic fixtures for `LEXICON_SAMPLE=1 node scripts/build-lexicon.mjs` and `scripts/lexicon-lib.test.mjs`.
Every entry, definition and sentence here was written for Hugo 中文 tests, in the source file formats only
(CC-CEDICT text, the cfdict.tsv that build-cfdict.mjs writes, Tatoeba TSV exports). No real dictionary data, no
personal word list. Traps: 说中 (must not be found in 他会说中文), proper nouns (张, 水), CL measure words, merged
entries (干 gan1), a 9-character headword (dropped), sentences in traditional characters, with Latin letters,
too short, or with no translation (all dropped).
For the character index (dict/c): 汤姆 (a name with two sentences, must be left out despite its count), 汤 and 鸡汤
(common through CFDICT only), 汤匙 (no sentence, no CFDICT: not common), 学说 (only a cross-reference in both
dictionaries), and the single characters 学, 校 [jiao4] and 校 [xiao4] (the e2e opens 学校; the first 校 reading is
not the one in the word).
