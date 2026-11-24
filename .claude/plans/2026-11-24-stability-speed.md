# Stability and speed — root causes and roadmap (2026-11-24)

Hugo: "recent developments are great, but minor bugs and slowness happen often; in Cards, answering moves the screen down."
This plan records what was measured, what Batch 1 fixes (branch `stability-speed-1`), and the ranked work after it.

## 1. How it was measured

- Synthetic workbook the size of Hugo's (HSK四级 570 rows, HSK五级 1,200 rows, 40 grammar rows → 1,713 notes), 8,000 seeded
  review events over 60 days. Preview build, Playwright iPhone 13 emulation, **CPU throttled 4×** (a rough iPhone stand-in).
- Long tasks (`PerformanceObserver('longtask')`), in-page timing from tap to next frame, bounding boxes of the Cards card
  and dock before/after Check. Scripts stay outside the repo (they are throwaway); the Cards check became part of `e2e/layout.py`.

## 2. Root causes

| # | Symptom | Root cause | Evidence (4× throttle) |
|---|---|---|---|
| R1 | Cards: screen drops when answering, jumps back at Next | (a) Tapping Show answer / Check / Next takes the focus from the field: on the iPhone the keyboard closes, `--kb` goes to 0, the fixed column grows by the keyboard height and everything drops. (b) The verdict line is inserted into the dock only after the answer (+48 px), so the centred card moves 28 px; it leaves again at Next. (c) The hidden-hanzi block is 72 px, the revealed hanzi line 81 px. | card y 205→177, h 224→233, dock y 548→500 on every answer |
| R2 | Sheets feels slow: every tap, status change, menu | `QmRow` is not memoised and Sheets subscribes to the whole store (`useApp((s) => s)`): every peek tap, focus change, menu open, answer check and every store change (sync state, Excel check, folder check) re-renders all 150 rows (400 with "Try new animations"), each with tone-coloured pinyin, meaning, chip and answer field. A status change also rebuilds every row object (`sheetRows`). | peek tap 100–180 ms; status menu open ≈ 450–540 ms; status apply ≈ 500 ms |
| R3 | "Random" reloads / lost typing in Cards | Update flow: `STUDY_ROUTES` still listed `review` and `quick`, not `cards` (QUICK-2 moved the drill there). After a deploy, the first focusout on Cards (tapping Show answer) reloaded the app 2.5 s later. Also reloaded with a word panel or menu open. Hugo deploys several times a day, so every device hits this often. | `pwa.ts` |
| R4 | Slow first seconds after opening the app | Offline warm-up ran at **every launch and after every sync that changes the word list**: one `cache.match` per character (≈ 1,500) and per dictionary shard (≈ 200+), sequentially, competing with IndexedDB reads and sync on the iPhone. | `strokes.ts` `warmOffline` |
| R5 | Boot | One 450–550 ms long task at start: `deriveCards` replays every event (FSRS) for every card, again after each sync merge (`rebuildAll`). Acceptable today, grows with history. | boot to Sheets ≈ 1.5 s |

## 3. Batch 1 — this branch (`stability-speed-1`)

| Id | Change | Files | Result |
|---|---|---|---|
| F1 | Dock buttons keep the focus (`mousedown` default prevented while the field has focus); the verdict line always keeps its room; the hidden hanzi block is one hanzi line tall | `cards/Cards.tsx`, `cards/cards.css` | card and dock move 0 px on Check and Next; field keeps focus (new `e2e/layout.py` checks) |
| F2 | `QmRow` memoised with `sameRow` (note, peeks, shown layers, classes, `rowSig`); Sheets passes `rowSig` (status, Wrong, answerGen, id) and its row buttons read `paint` / `cardsLink` from a live ref | `qm.tsx`, `Sheets.tsx` | peek tap ≈ 2–3× faster (150 rows: 70–155 → 24–76 ms; 400 rows: 99–179 → 41–94 ms) |
| F3 | `cards` is a study route; no auto-reload while a sheet or menu is open | `lib/pwa.ts` (+ test) | update waits for Sheets/Settings with nothing open |
| F4 | Warm-up remembers a full pass (`warm.strokes`: hash of Hugo's characters; `warm.lexicon`: app version), rechecked weekly | `lib/strokes.ts` | no Cache API scan at launch once warmed |

Checks: `npm test` 551/551, `tsc`, `npm run build`, `e2e/cards.py`, `e2e/layout.py`, `e2e/offline.py` pass.
`e2e/sync.py` fails at the phone's "Link this device" step in this cloud session **on main as well** (see B1).

Hugo's iPhone check before deploy: open Cards with the keyboard, answer 5 cards with Check, Show answer and Return; the
screen must not move and the keyboard must stay up. Tap pinyin/meaning cells in Sheets and change a few statuses.

## 4. Next batches (ranked)

### Batch 2 — speed (engineer + ui-dev)
- P1 **Narrow store subscriptions.** Add `useAppPick(keys)` (shallow-equal selector) and use it in the 8 screens on
  `useApp((s) => s)` (Sheets, Cards, Grammar, Settings, Today, Stats, Words×2), so sync/Excel/folder ticks stop re-rendering screens.
- P2 **Sheets list cost.** Slots (lead/trail/answer) are still created for every row on each list render: pass render
  functions into the row instead of elements; turn on `content-visibility` rows for everyone (today only with the motion
  switch), then consider windowing instead of "Show more".
- P3 **Status change.** Patch only the changed rows in `sheetRows` (marks are per note) and compute the `due` badge from
  the changed cards instead of `buildQueue` over every card.
- P4 **Boot and sync replay.** Persist the derived cards with the event count they cover (derived, so a cache only; never
  truth — CLAUDE.md rule) or replay in a worker; replay only the notes touched by merged files after a sync.
- Budget to hold (4× throttle, 1.7 k notes, 8 k events): peek < 50 ms, status apply < 150 ms, boot long task < 200 ms.

### Batch 3 — fewer bugs, easier to trace (engineer + qa)
- B1 Fix `e2e/sync.py` at "Link this device" (fails here on main too; INDEX already notes it flaking in CI) and the
  `od_common.py:97` wait in `onedrive_writeback.py`. Flaky checks hide real regressions.
- B2 **Device error log.** Capture `error` / `unhandledrejection` and sync/write-back warnings into a small ring buffer in
  kv (device-only, never synced), shown in Settings › About with "Copy diagnostics" (app version, last sync, warnings,
  last 20 errors). Hugo pastes it into a chat instead of describing the bug.
- B3 **Perf regression check in CI.** Turn the measurement into `e2e/perf.py` (synthetic workbook, 4× throttle) with the
  budgets above as soft fails.
- B4 Known small bugs from INDEX: 4-char word header pinyin overlapping YOUR LIST; Settings "of 128" before 192 loads;
  one-char words not underlined where `Intl.Segmenter` joins them (他是).

### Batch 4 — release rhythm (release)
- Each deploy updates and re-warms every device. Group merges into one deploy per day after Hugo's iPhone check, and
  remove the "Try new animations" switch once batches C/D of ui-polish land, so there is one code path to test.

## 5. Decisions
- D1 Memoised rows read changing state through a ref (`QmList.rowSig` contract). New row content must enter `rowSig` or
  the row will not update.
- D2 Study routes (no auto-reload): `review`, `quick`, `cards`; never with a dialog or menu open.
