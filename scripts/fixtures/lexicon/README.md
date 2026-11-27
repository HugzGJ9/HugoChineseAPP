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
Also for dict/c: 汤博乐 (a proper noun only, capitalised pinyin, with a CFDICT entry: left out), 好处 (two readings:
the one with more senses, hao3 chu5, is the one listed) and 很好 (CFDICT only, a phrase: left out).
For similar meanings (dict/c `n`): 帮助 /to help/to assist/, 帮忙 /to help/ and 协助 /to assist/ (帮助 → 帮忙, 协助),
and 友人 /friend/ with a CFDICT line, so 朋友 has one similar word (友人); the e2e uses it.
For the Tatoeba examples (plan 2026-11-27-word-panel-settings, D6–D8): `cmn_sentences_detailed.tsv` (the same sentences
with made-up owners `mei` and `lin`), `cmn_user_languages.tsv` (mei native, lin not), `cmn_tags.tsv` (1108 我只喝水
tagged @check: dropped; OK on 1022 and 1101), `cmn_sentences_with_audio.tsv`, `cmn_transcriptions.tsv` (reviewed
pinyin for 1103 行 hang2, 1105 还 huan2, 1107 只 zhi3; an unreviewed, wrong one for 1104, ignored), and the polyphones
行, 还, 只, 了 with 银行 and 了解 (whose 行 / 了 must not count). 友人 has one sentence so 朋友 → 友人 survives the
"no candidate in no sentence" rule. `traps.tsv` (sentence, word, 1 when the word itself is used, its reading) and
`traps-words.txt` (a hand-written stand-in for CC-CEDICT headwords) are the segmenter test set.
After the first real run (2026-11-28): 音乐会 and 下一场音乐会将在六月份举办 (会 must not count inside 音乐会), 1112
他在这一行工作 (reviewed hang2, so 行 has a hang2 list of 2), and the real failures appended to `traps.tsv` (了 le5, 得 de5,
只 zhi1/zhi3, 觉 jiao4, 多行不义必自毙), on which no reading may be wrong.
