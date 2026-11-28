# Screen map — files and checks per screen

Read this instead of exploring `src/ui`. Open only the files on the row you touch. Keep each row one line; update it when
a file moves.

| Screen (route) | Files | Unit tests | e2e to run | Hugo's iPhone check |
|---|---|---|---|---|
| Sheets (`#/sheets`) | `Sheets.tsx`, `qm.tsx`, `qm.css`, `sheets/Menus.tsx`, `sheets/sheets.css`, `StatusPicker.tsx`, `status.css` | `status.test.ts`, `wrong.test.ts`, `colours.test.ts` | `layout.py`, `perf.py` (if speed) | scroll, tap cells, change a status |
| Scratch pad / writing | `sheets/ScratchPad.tsx`, `sheets/scratch.css`, `WritePad.tsx`, `writepad.css` | — | `layout.py` | write a character |
| Cards (`#/cards`) | `cards/Cards.tsx`, `cards/cards.css`, `keyboard.ts` | `answer.test.ts`, `pinyin.test.ts`, `quick.test.ts` | `cards.py`, `layout.py` | answer 5 cards, keyboard stays up, screen doesn't move |
| Review session | `Review.tsx`, `review/*.tsx`, `review/review.css` | `answer.test.ts` | `cards.py` | one review |
| Word panel | `word/WordSheet.tsx`, `word/WordPanel.tsx`, `word/ExplainView.tsx`, `word/Confuse.tsx`, `word/Characters.tsx`, `word/SentenceWord.tsx`, `word/ZhLine.tsx`, `word/nav.tsx`, `word/word.css`, `panel.tsx`, `panel.css` | `lexicon.test.ts`, `register.test.ts`, `sentence.test.ts` | `explain.py` (build with `LEXICON_SAMPLE=1`) | open 3 words, Back, close: list stays in place |
| Grammar (`#/grammar`) | `grammar/GrammarPage.tsx`, `grammar/grammar.css`, `src/lib/grammar/` | `src/lib/grammar/*.test.ts` | `grammar.py` | filters, open a point, tap a word |
| Settings (`#/settings`) | `Settings.tsx`, `Microsoft.tsx`, `screens.css` | — | `layout.py`; `sync.py` if Sync moved | Audio, import workbook |
| Settings › Advanced | `SettingsAdvanced.tsx`, `Setup.tsx`, `Today.tsx`, `Stats.tsx`, `Words.tsx` | — | `sync.py` (Sync, QR) | link a device |
| Shell, tabs, routes, motion | `App.tsx`, `common.tsx`, `motion.ts`, `motion.css`, `src/styles.css` | `pwa.test.ts` | `layout.py`, `perf.py` | switch tabs, no flash |

## Logic → checks (src/lib)
| Area | Unit tests | e2e |
|---|---|---|
| Sync, sync store | `sync.test.ts`, `store.test.ts` | `sync.py`, `onedrive_sync.py` |
| Excel import / write-back | `src/lib/import/*.test.ts`, `workbook*.test.ts`, `writeback.test.ts`, `folder.test.ts` | `onedrive.py`, `onedrive_writeback.py` |
| Engine, cards memo | `src/lib/engine/*.test.ts`, `store.test.ts` | `cards.py`, `perf.py` |
| Lexicon, dictionary data | `lexicon.test.ts` | `explain.py`, `offline.py` |
| Backup, device log | `backup.test.ts`, `devlog.test.ts` | — |

Always: `npx tsc --noEmit -p .` and `npm run build`. Full e2e set only once per batch, before the push.
