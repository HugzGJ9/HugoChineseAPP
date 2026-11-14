# Quick cards: typed answers, and the deck survives leaving the screen (2026-11-14)

## Goal
1. In Quick › Cards, Hugo types the answer and the app says right or wrong, instead of "Missed" / "Knew it".
2. Leaving Quick (another tab, another app, a reload) and coming back shows the same card, same order, same counts.

## Causes of 2 (checked in code)
- `App.tsx` renders only the active route: leaving Quick unmounts `QmCards`, whose `order`, `i`, `missed`, `knew`,
  `round` are `useState`. The shuffle `seed` in `Quick` is `useState('')` too, so a shuffled deck comes back in sheet order.
- Full reloads lose it as well: `pwa.ts` applies a waiting update once the route is not a study route (e.g. on Sheets),
  and iOS discards a backgrounded Home Screen app.
- List ↔ Cards also unmounts `QmCards`.

## Decisions (Hugo, 2026-11-14)
- D1. Hugo picks what he types: **Hanzi**, **Pinyin** (typed with tone numbers, `ni3 hao3`; tone marks accepted too) or
  **French** (the French meaning; English also accepted when Settings › "Accept English or French" is on). That layer
  stays hidden until he checks.
- D2. **Only right or wrong.** `grade.ts` verdicts `tones` and `near` count as wrong. No "Almost", no override button.
- D3. The card session is saved on the device only (localStorage `hz.qm.cards`; not shared, not backed up, not synced).
  One saved deck at a time, keyed by sheet + status filter + shuffle seed. The seed is kept as `hz.qm.seed` and the
  answer choice as `hz.qm.answer`, both device-only. No review events except the existing "Send missed to reviews".

## Contract (stub in `src/lib/quick.ts`, written by the lead)
`Target`, `TARGETS`, `checkAnswer(target, typed, note, acceptBoth)`, `isRight(verdict)`, `CardSession`,
`sessionKey(tag, filter, seed)`, `saveSession(s)`, `loadSession(key, alive)`, `clearSession()`. Doc comments in the stub
are the spec. Don't change the signatures; if one is wrong, say so in the report.

## WP-A. Logic (engineer) — owns `src/lib/quick.ts`, new `src/lib/quick.test.ts`
1. `checkAnswer`: hanzi → `checkHanzi`; pinyin → `checkPinyin`; fr → `checkMeaning(typed, [French, English if acceptBoth])`
   with the French and English texts from `meaning(note, 'fr' | 'en')` in `store.ts` (falls back like the rest of the app).
2. `isRight`: `v === 'right'`.
3. Session: `sessionKey` stable and unambiguous (a `|` inside a sheet name must not collide); `saveSession` through
   `setPref('qm.cards', …)`; `loadSession` per the stub comment, also null on bad JSON shape, `v !== 1`, negative or
   non-integer numbers; `clearSession` removes the key.
4. Tests: each target right/wrong, tone numbers right, wrong tones → `tones` → `isRight` false, near French miss → false,
   acceptBoth on/off, round trip, other key → null, deleted ids before/after i, all ids gone → null, garbage → null,
   finished round (i = ids.length) restores.
Done when `npx vitest run src/lib/quick.test.ts`, `npx tsc --noEmit -p .` and `npm test` pass. No new dependency.

## WP-B. Screen (ui-dev) — owns `src/ui/Quick.tsx`, `src/ui/quick.css`, new `e2e/quick.py`
1. `seed` from `pref('qm.seed', '')`, saved on Shuffle / Sheet order.
2. `QmCards`: start from `loadSession(sessionKey(tag, filter, seed), all note ids)`, resolving ids against every note in
   the store (not the filtered list); otherwise a fresh deck. `saveSession` after every answer, on retry round and on
   Start over (fresh deck). Done screen also restores.
3. Answer UI replaces the Missed / Knew it bar, the swipe grading and its labels, and the ← → keys: a "Answer with"
   segmented control (Hanzi · Pinyin · French, pref `qm.answer`, default Hanzi); the chosen layer is hidden whatever
   `shown` says; a text input (reuse attributes of `Practice.tsx` `TypeMode`: autocorrect off, `lang`, `enterKeyHint`;
   placeholder `汉字` / `ni3 hao3` / `sens en français`; 16 px so iOS doesn't zoom). Enter = Check → verdict "Right" or
   "Wrong" (`role=status`, reuse `.verdict right|wrong` styles) and the whole card revealed with the expected answer
   (pinyin also shown with tone numbers); Enter or "Next" = next card. Focus the input on PC, not on touch (as Practice).
4. Done screen: "Right N, wrong M"; Retry the wrong ones, Send to reviews, Start over unchanged in behaviour.
5. Copy in English. iOS tokens, light and dark (`src/ui/CLAUDE.md`, ios-design §5).
6. `e2e/quick.py` (pattern of `e2e/sync.py`/`offline.py`, sample from `make_sample.py`, desktop + iPhone 13): Cards,
   type a right and a wrong answer, check verdicts, go to Sheets and back → same "n / total" and counts; reload → same;
   Start over → 1. No screenshots of real words committed.
Done when `npx tsc --noEmit -p .` passes and `e2e/quick.py` passes against a preview build (after WP-A lands).

## Checks (qa, once for the batch)
tsc, `npm test`, `npm run build`, `e2e/quick.py` and `e2e/offline.py`, diff review: no new shared/backed-up pref, no
review events except Send to reviews, test hooks in `src/ui/CLAUDE.md` untouched, no personal data.
