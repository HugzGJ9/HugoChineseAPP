# Plans index

<!-- Read this instead of the plans. One row per plan. The lead updates it at the end of each session.
     Status: proposed · in progress · shipped · superseded (by …). Plans total ~2,900 lines; never load them all. -->

| Date | Plan | Status | Summary | Still open |
|---|---|---|---|---|
| 2026-11-06 | [roadmap](2026-11-06-roadmap.md) | Phases 1–3 shipped (4c62102) | Review findings; data safety (timezones, multi-tab, bad imports, renames, pinning), reliability/deploy, study UX | Phase 4+ ranked features (§4): #2 Review ahead shipped, #4 covered by word-status marks; #1 weak-words drill, #3 HSK level progress, #5 dictation, #6 hints, #7 heatmap, #8 nudge not started. §5 questions unanswered |
| 2026-11-07 | [word-status](2026-11-07-word-status.md) | Shipped (1392e8b); status model superseded by sheets D1–D2 | Marks stream, prefs sync in settings.json, backup file, storage status | Legacy marks `known`/`relearn` are still read as statuses |
| 2026-11-07 | [sheets](2026-11-07-sheets.md) | Shipped (fa49f6e) | Sheets home, WordStatus, colour seeding, `colourSince`, writing area | D5 copy is now only the no-Microsoft path (connected-saving D5, D13) |
| 2026-11-07 | [word-explain](2026-11-07-word-explain.md) | Shipped (524c2d2, 6c22081) | Offline lexicon (CEDICT, CFDICT, Tatoeba) + "Explain more" via Claude | — |
| 2026-11-08 | [connected-saving](2026-11-08-connected-saving.md) | P1–P3 shipped (0d1e311, 63facb6); P4 partly | Microsoft sign-in (PKCE), app-folder sync, write-back into the real workbook | P4 WP13: PC `~$` presence for the phone, delete dormant `progress.ts`, silent renewal via iframe (+ `frame-src`) |
| 2026-11-09 | [ios-design](2026-11-09-ios-design.md) | Shipped (63facb6) | Native iOS look: tokens, components, every screen; §7 theme colours done | Spec stays the reference for new screens |
| 2026-11-14 | [safety-tests](2026-11-14-safety-tests.md) | Shipped | 34 unit tests for untested data-writing branches: workbook write-back, held imports, PC copy, sync store switch; each checked against a deliberate break | Not done (medium): sync timers, multi-device convergence with random order, `pwa.ts` update flow |
| 2026-11-14 | [quick-typed](2026-11-14-quick-typed.md) | Shipped (PR #3) | Quick cards: type hanzi / pinyin (tone numbers) / French, right or wrong only; card session survives tab switch and reload (device-only, QUICK-1); `e2e/quick.py` in CI | Not covered by e2e: Quick list mode (unchanged) |
| 2026-11-16 | [mobile-ux](2026-11-16-mobile-ux.md) | Shipped (Batch 1 PR #4, Batch 2 PR #5) | iPhone UX: one meaning per colour (ink controls, Excel status colours, re-picked tone hues), one bottom sheet that swipes closed and follows the keyboard, Sheets as the one list (All tab, List | Hugo's real-iPhone check (keyboard, swipes); `WordPanel` still accepts an ignored `tabs` prop (CardView, Cards pass it); `onedrive_writeback.py` timed out once in qa (flaky wait at `od_common.py:97`); open defaults: Review does not set Wrong, neutral Hard/Good/Easy | | Batch 1: WP1 colours ∥ WP2 sheet + keyboard, then WP8 answer field. Batch 2: WP7 → WP3 (engineer) ∥ WP4, then WP5, WP6. |
| 2026-11-17 | [sheets-phone-row](2026-11-17-sheets-phone-row.md) | Shipped (PR #6) | iPhone Sheets rows on two lines (no id column or pen on phones, compact status and Wrong badge, wider meaning); tab bar hides while typing, Return → next field scrolls above the keyboard | Hugo's real-iPhone check (keyboard, Return walk); optional swipe-left Practise |
| 2026-11-20 | [grammar-window](2026-11-20-grammar-window.md) | WP1 shipped (PR #8); WP2–WP5 superseded by grammar-content | Grammar tab: 语法 points titled 中/FR/EN with search, grouped by family or HSK; lesson page; labels by Claude, edited by Hugo; lessons by Claude, saved and synced | WP2 store + sync (in-memory today), WP3 Claude lessons and labels, WP4 buttons, WP5 qa |
| 2026-11-21 | [grammar-content](2026-11-21-grammar-content.md) | App shipped; content pending in Hugo's Excel | Grammar content from extra 语法 columns (HSK, Family, titles, definitions, use, register, sentences) → Note.grammar; page rebuilt: meaning card, examples with his words underlined; lesson box, Explain more and in-app store removed | Hugo pastes the columns into his Excel; later: studying-word examples, "don't confuse" column, grammar practice |
| 2026-11-22 | [grammar-v3](2026-11-22-grammar-v3.md) | Shipped | Grammar: tick-box filters (HSK, family, status) replace grouping; one app-wide EN/FR language; any word in examples tappable (dictionary-only panel, tap to widen/narrow, links to his words); translations hidden until tapped; Previous/Next; Same family removed; grammar.py now in CI | Hugo pastes the regenerated 语法 columns (all EN + FR); grammar practice (E5) later |
| 2026-11-22 | [ui-polish](2026-11-22-ui-polish.md) | Batches 0, A, B shipped behind the switch | Motion at 0 KB (View Transitions, sheet exits, springs, reduced motion = fades), LXGW WenKai on iPhone, Cards feedback (shake, tone highlight, typo retry, haptics, swipe Next), auto-animate on small lists | Hugo tries Settings › Look and feel › Try new animations on the iPhone (slides, sheet exits, WenKai on Cards); then C (Cards feedback), D (auto-animate), then the switch goes (motion for all); half-height Word panel parked |

## Now / next
- Now: ui-polish batches A+B (behind the device-only "Try new animations" switch) wait for Hugo's iPhone check. grammar-v3 shipped; Hugo pastes the regenerated 语法 columns into his Excel (file sent in chat, never in the repo).
  `onedrive_writeback.py` flaked again in CI at `od_common.py:97` (passed on rerun): worth fixing the wait.
- Next candidates: connected-saving WP13; roadmap phase 4 #1 weak-words drill, then #3 HSK level progress (needs its own
  short plan: data source and licence).

## Rules for new plans
- File name `YYYY-MM-DD-<topic>.md`; add a row here in the same commit.
- Decision ids are local to a plan (every plan has a D2). When a decision outlives its plan, copy it to
  `docs/decisions.md` with a global id and link back.
- A shipped plan is history: don't update it, update INDEX.md and decisions.md.
