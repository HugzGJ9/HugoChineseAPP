# Page changes, stability and load time — measured causes and roadmap (2026-11-26)

Hugo: "major graphical issue: when pages change or actions are made, the display is not stable, graphics bugs, low
speed, high time to load." Follows [stability-speed](2026-11-24-stability-speed.md) (Batch 1: Cards screen drop,
memoised rows, update reload, warm-up scan). This plan records what was measured on main (c05c3f3), what Batch 2
(branch `stability-speed-2`) fixes, and the ranked work after it. Lead-run (UI only, no stored shape touched).

## 1. How it was measured
- Synthetic workbook the size of Hugo's: HSK四级 570, HSK五级 1,200, 40 grammar rows (1,810 notes), 8,000 review events
  over 60 days seeded into IndexedDB. Preview build, Playwright iPhone 13, **CPU throttled 4×**, "Try new animations" off
  and on. In-page probe per action: time to the target element, long tasks, frames with no screen (empty page), layout
  shift, page scroll after coming back. Throwaway scripts stay outside the repo; the stable part became `kept_tabs` in
  `e2e/layout.py` (fails on main, passes on the branch).

## 2. Root causes (main)

| # | Symptom | Root cause | Evidence (4×) |
|---|---|---|---|
| R6 | First visit to Grammar or Settings flashes an empty page | Lazy screens load at first visit; the route change was not a transition, so `<Suspense>` swapped the screen for an empty `aria-busy` page while the chunk loaded | 18–19 empty frames (≈ 380–420 ms) |
| R7 | Coming back to Sheets freezes and lands at the top | Sheets unmounted on every route change: 150 rows rebuilt (225–430 ms single task); `window.scrollTo(0, 0)` on every change | 240–430 ms frozen; scroll 3000 → 219 |
| R8 | Sheet tab switch (All / HSK四级 / HSK五级) freezes | All 150 rows of the new list rendered and laid out in one task | 330–480 ms frozen |
| R9 | White screen at launch | App rendered `null` until storage was read and every card replayed (`deriveCards`, one 490–550 ms task); 130–250 ms more long tasks right after the first rows | first row 1.30–1.53 s |
| **R10** | **With "Try new animations" on, everything freezes ~3 s** | Every status chip ran `ios-haptics` `hapticTrigger` on mount: it reads `getComputedStyle` right after inserting DOM, so 400 chips forced 400 style recalculations in a row (trace: 648 ms `UpdateLayoutTree` unthrottled). Motion pages are 400 rows | boot 4.1–4.6 s (3.3–3.8 s task); every return to Sheets and every tab switch 3.0–3.5 s |
| R11 | Open a word halfway down Sheets, close it: back at the top | The sheet lock set `overflow: hidden` on both `html` and `body`; both are `height: 100%`, so body became a viewport-tall clip box and the page scroll fell to 0 (also on the PC in Edge) | scroll 1200 → 0 on open, stays 0 |
| R12 | Scroll bar jumps while scrolling Sheets (motion on) | `content-visibility` row estimate 60 px; real phone rows are 98 px | measured row heights |

## 3. Batch 2 — this branch (`stability-speed-2`)

| Id | Change | Files | Result (4×, motion off · motion on) |
|---|---|---|---|
| F5 | Sheets, Grammar and Settings stay mounted once visited (`<Activity>`, hidden with display: none); each tab's page scroll is saved on leaving and restored; overlays (word panel, menus, sentence word) close on leaving, because the word panels are portalled to `<body>` | `App.tsx`, `Sheets.tsx`, `grammar/GrammarPage.tsx` | back to Sheets: 240–430 ms → 3–10 ms · 3.0–3.5 s → 7–30 ms; scroll kept (3000 → 3000) |
| F6 | Route changes always in a transition (old screen stays until the new one is ready); every screen chunk preloaded once the app is idle (2.5 s after start) | `App.tsx` | empty frames 18–19 → 0 |
| F7 | `content-visibility: auto` rows for everyone, estimates 98 px phone / 52 px wide | `sheets/sheets.css` | reveal and tab cost cut; no scroll bar jumps |
| F8 | Progressive rows: a new list (mount, tab, filter, search) draws 30 rows, then 60 more per step (plain timed updates; transitions would each start a page-wide View Transition with motion on) | `Sheets.tsx` | tab switch 330–480 ms → 45–78 ms · 3.0–3.3 s → 76–144 ms |
| F9 | Own haptic helper (same trick as ios-haptics, MIT) without `getComputedStyle`; chip is `position: relative` in CSS; `ios-haptics` dependency removed | `StatusPicker.tsx`, `status.css`, `package.json` | motion boot first row 4.1–4.6 s → 1.12–1.22 s |
| F10 | Sheet lock on `<html>` only | `panel.css` | scroll kept with a panel open and after closing |
| F11 | Shell and tab bar drawn while storage loads (no white screen) | `App.tsx` | first row 1.30–1.53 s → 1.07–1.16 s; no long task after it |
| F12 | QmList scrolls to the focused row only when the focus moves (effects re-run when a kept screen is shown) | `qm.tsx` | kept scroll position |

Checks: `npm test` 557/557, `tsc`, `npm run build`, `e2e/layout.py` 180 ok (new `kept_tabs`, motion off and on),
`cards.py` 140, `grammar.py` 101, `offline.py` 6. `e2e/sync.py` stops at the phone's "Link this device" in this cloud
session on main as well (B1, passes in CI); its `.main` screenshot now targets `.main:visible`.

Hugo's checks before deploy (iPhone, then PC):
1. Sheets: scroll halfway, open a word, close it: the list stays where it was. With the word open, the list behind must
   not scroll (the lock is now on `<html>` only; check it holds on iOS).
2. Scroll halfway, go to Grammar, then Sheets: same place, no flash. Switch HSK四级 / HSK五级: the first rows at once,
   the rest fills in below.
3. Settings › Look and feel › Try new animations on: same three steps; the status chip still ticks (haptic) on a tap.

qa (sonnet): PASS. Fixed after qa: scroll saved under the screen still on show (two quick route changes filed Sheets'
scroll under Grammar); "Show more" waits until the rows have filled in. Left: toggling "Try new animations" remounts
the kept screens once (filters and typed answers reset; reload after the switch avoids it) → B5 removes the switch.

## 4. Next batches (ranked)

### Batch 3 — speed that is left (engineer + ui-dev)
- P4 **Boot replay** (now the biggest single task: 280–550 ms before the first row). Persist derived cards with the
  event count they cover (cache only, never truth — CLAUDE.md), or replay in a worker; after a sync, replay only the notes
  touched by merged files. Needs an architect plan (stored shape). Budget: boot long task < 200 ms, first row < 800 ms.
- P1 **Narrow store subscriptions** (from stability-speed): 8 screens use `useApp((s) => s)`; with kept screens this
  matters more, a sync or Excel tick re-renders hidden screens when they are shown again. `useAppPick(keys)`.
- P2 **Row slots**: lead/trail/answer elements are still created for every row on every list render; pass render
  functions into the memoised row.
- P13 First visit to Grammar with motion on still takes ≈ 480 ms (chunk + View Transition snapshot) when it happens
  before the idle preload; preload Grammar first, or right after the first rows.
- P14 Boot bundle: `qrcode` (7 KB gz) loads at start through Sheets → Today → Setup; split `SetupSources` from Setup.

### Batch 4 — stability guards (qa + engineer)
- B1 Fix `e2e/sync.py` at "Link this device" in cloud sessions; `od_common.py:97` wait (from stability-speed).
- B3 **`e2e/perf.py` in CI**: the measurement above as a script (synthetic workbook, 4× throttle, motion off and on) with
  budgets as soft fails: tab switch < 150 ms, back to a tab < 50 ms, 0 empty frames, boot first row < 1.2 s. R10 would
  have been caught the day it shipped.
- B2 Device error log in Settings › About with "Copy diagnostics" (from stability-speed).
- B5 One code path: ship ui-polish C/D, then remove the "Try new animations" switch (R10 lived only behind it, untested
  by e2e until now).

### Batch 5 — release rhythm (release)
- One deploy a day after Hugo's iPhone check (each deploy re-warms every device).

## 5. Decisions
- D1 Tab screens (Sheets, Grammar, Settings) stay mounted once visited (UI-3 in decisions.md). Anything they portal to
  `<body>` must close in an effect cleanup; effects re-run each time the screen is shown again, so an effect must not
  scroll or reset state on mount unless that is wanted every time the tab is shown.
- D2 Route changes are always transitions. Under "Try new animations" every transition update in a screen starts a
  View Transition: never use `startTransition` for background work inside a screen.
- D3 Nothing that renders once per list row may read layout (`getComputedStyle`, `offset*`, `getBoundingClientRect`) at
  mount.
