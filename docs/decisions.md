# Durable decisions

<!-- The decisions every future change must respect, pulled out of the plans so nobody reads 900-line plans to find
     them. One entry = the rule, why, source. Global ids (AREA-n) so "see D2" is never ambiguous. Plans live in
     .claude/plans/; the source column names the plan and its local decision id. -->

## Storage
- **STORE-1. Dexie stays at v1; new data goes into `kv` rows and optional fields.** A version bump closes the IndexedDB
  connection of any old-version tab still open, and its next write throws. Bump only when an index must change, with an
  upgrade; `db.on('versionchange')` already asks old tabs to reload. Source: roadmap D2, word-status D3, connected-saving D11.

## Events, marks and the engine
- **ENG-1. Events carry their month (`ReviewEvent.mo`), frozen at record or merge time.** Grouping by `e.mo ?? monthKey(e.t)`
  makes merges independent of the reader's timezone. `mo` is never written into files: the path carries the month.
  Source: roadmap D1.
- **ENG-2. Marks are their own append-only stream (`marks/<dev>/<YYYY-MM>.json`), not review events.** Old clients would
  either reject a whole events file or replay a mark as a real review. Marks apply to a note, ids are never reused, undo
  deletes only this device's own mark. Replay: `deriveCards(notes, events, seeds, settings, marks)`.
  Source: word-status D1, D2, D4.
- **ENG-3. Status (`WordStatus`: new, studying, notknown, mastered) is separate from FSRS.** Review and practice never set
  a status; status marks (`st:*`) are no-ops in the engine, so the golden snapshot is unchanged. Source: sheets D1, D2.
- **ENG-4. ts-fsrs is pinned (6.0.0) and guarded by a golden replay test.** Any bump that changes scheduling fails CI.
  Source: roadmap D8.

## Sync
- **SYNC-1. Each device writes only its own monthly files; a file is authoritative for its device and month.** Every
  remote file is parsed and merged in its own try/catch and keeps its old sha on failure; rebuild once after all merges.
  Source: roadmap D5, word-status D2.
- **SYNC-2. Formats are versioned and read by column name.** A file with `v > 1` (or vocab `version > 1`) is not applied
  and shows "Update the app"; unknown mark kinds are kept but ignored. Source: roadmap D8, word-status D2.
- **SYNC-3. One sync run at a time per device (Web Lock `hz-sync`); tabs tell each other over BroadcastChannel `hz`.**
  A review and its dirty stamp are written in one transaction; the stamp is monotonic. Source: roadmap D3, D4.
- **SYNC-4. Shared prefs travel inside `settings.json` as the additive `prefs` field.** Old clients keep unknown fields,
  so prefs survive a round trip. Device-only prefs (voice, rate, modes) are not synced. Source: word-status D7.
- **SYNC-5. GitHub and the OneDrive app folder hold the same files with the same bytes**, behind the `SyncStore`
  interface (`syncstore.ts`); OneDrive uses flat names in `data/`. Writes use If-Match or "must not exist"; conflicts
  retry once. Source: connected-saving D9.

## Import and Excel
- **XL-1. Suspicious imports are held, not applied** (big note drop, a sheet gone or halved). Hugo picks old or new; a
  rejected hash isn't asked again. Applies only to local imports. Source: roadmap D6.
- **XL-2. Renames keep history through `VocabFile.aliases`, resolved in memory only.** DB rows and uploaded files keep
  raw events; events are never rewritten. Source: roadmap D7.
- **XL-3. Hugo's change wins over the Excel colour when newer** (`colourSince` per row; no previous map → t = 0, so his
  marks win). All devices share one import history keyed by the workbook's quickXorHash. Source: sheets D3,
  connected-saving D2–D4.
- **XL-4. Where statuses are written:** with Microsoft sign-in, into the real workbook; without it, into the PC copy
  `<stem> (app).xlsx`, rebuilt from the original's bytes (the original is only read there). Source: sheets D5,
  connected-saving D5, D13.
- **XL-5. Write-back is a stateless projection plus write intents.** Only status fills change; every upload uses
  If-Match from the metadata just read; a backup goes to the app folder first (newest 4 kept); intents stop the app's own
  write from being read as an Excel edit; `WorkbookChangedError` stops a row being coloured if it doesn't hold the
  expected word. Source: connected-saving D5–D7.

## Microsoft
- **MS-1. Sign-in is a small PKCE client by top-level redirect: no MSAL, no popups, no iframes.** Popups open outside the
  iOS Home Screen app and Safari blocks iframes. Tokens stay in kv `msAuth`, never synced or backed up.
  Source: connected-saving D8.
- **MS-2. Whole-file round trips; changes found by polling item metadata.** The Excel workbook API doesn't exist for
  personal accounts and webhooks need a server. Source: connected-saving D1.

## Explain
- **EXP-1. The Claude key lives on one device only** (kv `claudeKey`): never in prefs, sync files, backups, the link key,
  React state or logs. One key per device. Source: word-explain D5.
- **EXP-2. Explanations are cached per (note, language) in kv `ex:*` and synced as `explain/<dev>/<YYYY-MM>.json.gz`**,
  with their own dirty queue so old versions never touch it. Source: word-explain D6.

## Quick memory
- **QUICK-1. The Quick card session is device-only UI state** (localStorage `hz.qm.cards`, plus `hz.qm.seed` and
  `hz.qm.answer`): not a shared pref, not backed up, never synced, and never a source of truth. It only restores the deck
  after a tab switch or reload; typed answers record no review events except "Send to reviews". Typed verdicts are right
  or wrong only (`tones` and `near` count as wrong). Source: quick-typed D1–D3.
