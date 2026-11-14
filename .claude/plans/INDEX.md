# Plans index

<!-- Read this instead of the plans. One row per plan. The lead updates it at the end of each session.
     Status: proposed · in progress · shipped · superseded (by …). Plans total ~2,900 lines; never load them all. -->

| Date | Plan | Lines | Status | One-line summary | Still open |
|---|---|---|---|---|---|
| 2026-11-06 | [roadmap](2026-11-06-roadmap.md) | 397 | TODO | Four-agent review: data safety first (timezones, multi-tab, bad imports, renames, pinning) | TODO: which phases are done? |
| 2026-11-07 | [word-status](2026-11-07-word-status.md) | 374 | TODO (superseded by sheets D1–D2?) | Marks stream, "I know this"/Relearn/Suspend, prefs sync, backup file | |
| 2026-11-07 | [sheets](2026-11-07-sheets.md) | 422 | TODO | Sheets home, WordStatus, colour seeding, workbook copy | D5 copy → partly superseded by connected-saving D5? |
| 2026-11-07 | [word-explain](2026-11-07-word-explain.md) | 606 | TODO | Offline lexicon (CEDICT/CFDICT/Tatoeba) + "Explain more" via Claude | |
| 2026-11-08 | [connected-saving](2026-11-08-connected-saving.md) | 943 | TODO | OneDrive hub: Microsoft sign-in, app-folder sync, write-back into the real workbook | TODO: phases P1–P? status |
| 2026-11-09 | [ios-design](2026-11-09-ios-design.md) | 136 | TODO (wave 1 shipped? wave 2?) | Native iOS look; tokens, components, screen specs | TODO: which screens done |

## Now / next
- Now: TODO
- Next: TODO
- Parked ideas: TODO

## Rules for new plans
- File name `YYYY-MM-DD-<topic>.md`; add a row here in the same commit.
- Decision ids are local to a plan (every plan has a D2). When a decision outlives its plan, copy it to
  `docs/decisions.md` with a global id and link back.
- A shipped plan is history: don't update it, update INDEX.md and decisions.md.
