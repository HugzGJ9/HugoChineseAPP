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

## Now / next
- Now: nothing in progress.
- Next candidates: connected-saving WP13; roadmap phase 4 #1 weak-words drill, then #3 HSK level progress (needs its own
  short plan: data source and licence).

## Rules for new plans
- File name `YYYY-MM-DD-<topic>.md`; add a row here in the same commit.
- Decision ids are local to a plan (every plan has a D2). When a decision outlives its plan, copy it to
  `docs/decisions.md` with a global id and link back.
- A shipped plan is history: don't update it, update INDEX.md and decisions.md.
