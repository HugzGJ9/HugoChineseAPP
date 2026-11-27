# Word panel v3 + simple Settings — roadmap (2026-11-27)

Status: built on `word-panel-v3`, waiting for Hugo's merge · Architect: lead · Hugo reviews before each deploy.

Hugo's asks (2026-11-27):
1. Word panel ("summary/explanations"): 1.1 remove Claude's explanation; 1.2 similar words show *how and when each is
   used* (no sentence) and a crown when the word is 口语; 1.3 Characters right after Dictionary; 1.4 Tatoeba sentences
   often don't use the word properly → improve.
2. Settings is long; only Audio and Import workbook are used → clean and simple.

His answers: similar-word text from a new Excel column written by Claude, offline dictionary fallback · crown on similar
words **and** on the opened word (not Sheets/Cards) · Tatoeba: strict match + reading check, and a quality filter ·
Settings: Workbook + Audio on the page, the rest behind one "Advanced" row; Claude, Offline, Look and feel deleted.

---

## 1. What the code does today (findings)

| Ask | Where | Finding |
|---|---|---|
| 1.1 | `src/ui/word/ExplainView.tsx` `ClaudeSection`, `ExplanationBody` | "Explain more" calls Claude (`lib/explain`), result cached in IndexedDB and synced (`explain/<device>/<month>.json.gz`, `lib/sync.ts`). "Don't confuse with" (`Confuse.tsx` `ConfuseSection`) only exists inside a Claude explanation. |
| 1.2 | `Confuse.tsx` `SimilarSection` | Offline "Similar meaning" (D11 of word-panel-v2): first 2 dictionary senses + first Tatoeba sentence per word. No usage/context, no register. Noise: rare literary words (发轫 for 开始). |
| 1.2 | `src/lib/types.ts` `Note.group`, `Note.set` | His own confusables are already imported: bis rows (产生/生产 #638, 运用/使用/利用 #662, 显示/表示/表明 #863) → `group`; the Suddently sheet (Core meaning, Emotion/Tone, Tip) → `set`. The panel ignores both. His meanings already carry register notes ("very coll.", "très kouyu"). |
| 1.3 | `ExplainView.tsx` `ExplainBody` | Order: Your list → Dictionary → Claude → Characters → Examples. |
| 1.4 | `scripts/lexicon-lib.mjs` `indexSentences`, `rankExamples` | (a) A word counts for a sentence when it appears **inside** a segment, so 会 gets 会议 sentences, 学 gets 学生. (b) No reading check: 行 háng and xíng share examples. (c) Ranking = has EN+FR, length near 12, lowest id: no quality signal. Only `cmn_sentences`, links, eng/fra sentences are downloaded. |
| 2 | `src/ui/Settings.tsx` (663 lines) | 13 sections: shortcuts (Today, Stats, Words, Import report), Your words, Sync, Study, Meanings, Look and feel, Claude, Audio, Offline, Your data, Clear device, Troubleshooting, About/Sources, Diagnostics. Today/Stats/Words are reachable only from here. Sources is a licence duty (CC-CEDICT CC BY-SA, Tatoeba CC BY): it must stay somewhere. |

---

## 2. Decisions

- **D1 No Claude in the word panel.** `ClaudeSection`, `ExplanationBody`, `ConfuseSection` and their CSS go. `lib/explain`
  stays dormant: old devices still sync `explain/` files and must keep reading them (backward compatibility rule); no new
  call is ever made from the panel. Stored explanations are not deleted, only no longer shown.
- **D2 Panel order:** Your list → Dictionary → Characters → Similar words → Examples. Same order for words not in his
  list (`mine={false}`), minus Your list.
- **D3 Similar words = one list, no sentences.** Each item: word (tappable, opens a level as today) · pinyin · 👑 if
  口语 · one or two lines "when to use it" in the app language (EN/FR). Sources, first match wins per word, merged
  without duplicates, max 6:
  1. **His own groups:** other notes with the same `group` (bis rows) or `set` (Suddently). Text = his meaning; for a
     Suddently row: Core meaning · Emotion/Tone · Tip.
  2. **New Excel column "Don't confuse"** on vocab sheets (written by Claude, pasted by Hugo, like the 语法 columns).
     One line per word: `词 | 口语 | usage FR | usage EN` (2nd field empty or 口语 / 书面 / 中性).
  3. **Offline fallback** (any word, his or not): `similarWords` + a dictionary line = the senses the other word does
     **not** share with the headword (the difference), plus its register tag. Never a sentence.
- **D4 Crown (口语).** A word is 口语 when, in order: his Excel says so (new optional "Register" column on vocab
  sheets, read with the grammar `parseRegister`; or the 2nd field of a Don't-confuse line); else his meaning contains
  coll./colloquial/kouyu/口语; else a CC-CEDICT sense is tagged `(coll.)`/`colloquial` or CFDICT `(fam.)`/`familier`.
  Shown in the Similar list and next to the pinyin in the panel title (`WordSheet.tsx`). Not in Sheets or Cards.
  Literary/formal tags are shown as a small text tag (书面), no icon.
- **D5 Note fields are additive:** `Note.confuse?: { word; register?; fr?; en? }[]`, `Note.register?: Register`. The two
  new headers get aliases so they don't fall into `notes`/`extra`. Old app versions ignore them.
- **D6 Tatoeba, strict match.** A 1–2 character word counts only when it **is** a segment (or the exact join of
  segments); 3+ character words keep the "anywhere" rule. Segmenter: Intl.Segmenter stays the default; the researcher
  checks jieba (MIT, build-time only, zero bundle cost) on a fixed test set, and we switch only if it wins.
- **D7 Tatoeba, reading check.** At build, read each kept sentence with pinyin-pro (already used) and Tatoeba's own cmn
  transcriptions when present (`transcriptions.tar.bz2`, partly human-checked). For words with several CC-CEDICT
  readings, the shard gets `xr: { "hang2": [ids], "xing2": [ids] }` next to `x` (additive; old apps keep reading `x`).
  At runtime `lookupWord` picks the list that matches `note.pinyinNum` (or the tapped reading), else `x`.
- **D8 Tatoeba, quality.** New inputs: `sentences_detailed` (owner), `user_languages` (cmn level 5 = native),
  `users_sentences` (ratings), `sentences_with_audio`, `tags`. **Drop**: any −1 rating, tags like "@needs native check" /
  "@change" / "@check". **Rank**: native owner, audio, +1 rating, then EN+FR, length near 12, id. Only clear negatives
  are dropped, so rare words still get examples.
- **D9 Settings page = two sections:** "Your workbook" (Microsoft sign-in, folder, Import a file, pending-import
  notice) and "Audio". Then one row **Advanced ›** (`#/settings/advanced`): Today, Stats, Words, Import report · Sync
  (keeps `id="sync"`) · Your data + Clear this device · Study · Accept English or French · Troubleshooting + Copy
  diagnostics · About + Sources.
- **D10 Deleted:** Explanations by Claude (the stored key is removed from the device on first launch of the new version),
  Offline (dictionary and strokes keep downloading by themselves), Look and feel, the EN/FR switch row (still in the word
  panel and Grammar). The motion switch goes with Look and feel: **default = off** (the app as today) unless Hugo says
  "turn the new animations on for everyone" (ui-polish B5).

---

## 3. Batches and work packages

Files are disjoint inside a batch, so packages run in parallel.

### Batch 1 — panel clean-up + Settings (UI only, quick)
- **WP1 Panel order, Claude out** (ui-dev, sonnet) — `src/ui/word/ExplainView.tsx`, `Confuse.tsx`, `word.css`.
  D1, D2. Keep the current `SimilarSection` for now (rebuilt in WP4). Retire `e2e/explain.py`'s Claude steps; keep its
  dictionary checks.
- **WP2 Settings + Advanced** (ui-dev, sonnet) — `src/ui/Settings.tsx`, new `src/ui/SettingsAdvanced.tsx`, `App.tsx`
  route, `screens.css`. D9, D10. Update e2e that open Sync from Settings (`sync.py`, `onedrive*.py`, `od_common.py`)
  to go through Advanced; drop the Claude-key hooks from `src/ui/CLAUDE.md`.
- Checks: `npm test`, build, `e2e/explain.py`, `e2e/sync.py`, `e2e/perf.py`. qa sonnet (UI only).

### Batch 2 — Similar words v2 + crown
- **WP3 Excel columns** (engineer, opus) — `src/lib/import/build.ts`, `src/lib/types.ts`, new
  `src/lib/import/confuse.ts` + test. D5: read "Don't confuse" / "À ne pas confondre" and "Register" / "Registre" on
  vocab sheets; problems listed in the import report like the 语法 columns.
- **WP4 Similar list + crown** (ui-dev, sonnet) — `Confuse.tsx` (new `SimilarWords`), `WordSheet.tsx` title,
  `word.css`, new `src/lib/register.ts` (pure: D4 rules + D3 dictionary "difference" line) + test. D3, D4.
- **WP5 Content** (lead, in chat) — Claude writes the "Don't confuse" and "Register" columns, HSK五级 first (the sheet
  he is studying), then HSK四级, in the tone of his Suddently sheet. Delivered as an .xlsx to paste; never in the repo.
- Checks: unit tests, `e2e/explain.py` extended (his group shown, crown, no sentence). qa opus (stored shapes).

### Batch 3 — Tatoeba examples (data build)
- **WP6 Build** (engineer, opus) — `scripts/lexicon-lib.mjs` + tests, `scripts/build-lexicon.mjs`. D6, D7, D8; also
  down-rank literary/rare words in `similarWords` (the 发轫 noise). Test set of known traps in the fixtures: 会/会议,
  学/学生, 行 háng/xíng, 了 le/liǎo, 得 de/děi, 还 hái/huán, 只 zhǐ/zhī, 长 cháng/zhǎng.
- **WP7 Runtime pick** (engineer, opus) — `src/lib/lexicon.ts` (`xr` reading, fall back to `x`) + test.
- **WP8 Data run** (release, sonnet) — `data.yml` on the branch: download time, shard size (budget: dict/w ≤ +15 %),
  and a before/after report on 40 common HSK 4–5 words (generic list, not his).
- **Research first** (researcher, sonnet): exact export file names under `per_language/cmn/`, tag names in use, jieba vs
  Intl.Segmenter on the test set.
- qa opus (shard format).

Order: Batch 1 → Batch 2 → Batch 3. WP5 content can start as soon as WP3's column format is frozen.

---

## 4. Verification (Hugo, on iPhone and PC)
1. Open 坚强: no Claude block; Characters right below Dictionary.
2. Open 产生: 生产 listed first with his own note; no sentence under similar words.
3. A 口语 word (瞧, 俩): crown in the title and in any similar list where it appears.
4. Open 会, 行 (háng in 银行), 学: examples use the word itself, with the right reading.
5. Settings: Your workbook + Audio, then Advanced; Sync still links a new device from Advanced.

## 5. Open questions (defaults used if no answer)
- Motion switch: off for everyone (default) or new animations on for everyone?
- Content order: HSK五级 then HSK四级 (default)?
- Hide a bad sentence by hand: not chosen now; can come later as a synced per-word hide list.
