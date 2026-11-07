# Word status set by Hugo, and "achievements are never lost" (2026-11-07)

## Goal
Hugo can set a word's status himself: "I know this", "Relearn", "Suspend" / "Unsuspend". He can do it from the Words
detail and from Review (the `CardActions` slot). The change is saved as an append-only, event-sourced **mark**, replayed
together with the reviews. It survives Excel re-imports, syncs, and shows in Stats and in `Hugo_chinese_progress.xlsx`.
The same batch closes the gaps found by the "never lost" audit (section 3): shared prefs sync, a backup file, and storage status.

## 1. Decisions

**D1. Marks are a new event stream, not review events.** Type in `types.ts`:
```ts
export type MarkKind = 'known' | 'relearn' | 'suspend' | 'unsuspend';
export interface StatusMark { id: string; note: string; a: MarkKind; t: number; dev: string; mo?: string }
```
- Marks apply to a **note** (every card type of the word), because Hugo thinks in words, not cards.
- They are not a `ReviewEvent`. The reason: old `decodeEvents` rejects a whole file when `r` is outside 1–4, and Phase-1-era
  clients don't isolate files, so their whole sync would abort. With `m: 'mark'` and a valid `r`, old clients would replay the
  mark as a real review. Both outcomes are unacceptable.
- Ids come from `uid()`. They are never reused or rewritten. Undo deletes only one of this device's own marks, the same way
  `undoReview` works.

**D2. Sync file `marks/<device>/<YYYY-MM>.json`, with the same rules as the event files.**
- Each device writes only its own files. A file is authoritative for its device and month, and it is rewritten in full.
  The month is frozen in `mo` when the mark is recorded.
- Format (versioned, columns found by name):
  ```json
  {"device":"iphone-1a2b3c4d","month":"2026-11","v":1,"fields":["id","note","a","t"],"marks":[
  ["<uuid>","v:学习|xuexi","known",1762500000000]
  ]}
  ```
- `decodeMarks` refuses the whole file if a row has a bad `id`, `note` or `t`, so a partial merge never deletes marks.
  A row with an unknown `a` is **kept and stored**, but the engine ignores it. A file with `v > 1` is not applied: it raises
  the existing `updateNeeded` warning and keeps its old sha.
- Old app versions: `EVENTS_PATH` is anchored to `events/`, so they never read `marks/` and never delete anything there. Until
  they update, they show statuses from reviews only. A review made on an old device after a mark replays after the mark
  everywhere, which is fine. Nothing is misread as a review.
- `idUsed()` (linking) also checks `marks/<id>/`. `hasOwnEvents()` also counts own marks, so `renewDeviceId` refuses to
  change the id when only marks exist, and it resets `marksDirty`.

**D3. No Dexie version bump (same reason as roadmap D2).**
- Marks live in the `kv` table, one row per device and month: key `marks:<device>:<YYYY-MM>`, value `StatusMark[]`. Device
  ids can't contain `:`.
- At a few hundred marks per year, no index is needed. Load them with `db.kv.where('k').startsWith('marks:')`.
- The upload queue is `kv.marksDirty: Record<month, stamp>`. It is separate from `kv.dirty`, so an old-version tab never
  touches it. It shares the monotonic `dirtyStamp`.
- A mark row and its dirty month are written in **one** `rw` transaction over `db.kv`.
- Old-version tabs ignore unknown kv keys. Merging a remote file replaces that file's row, so no time-window search is needed.

**D4. Replay: `deriveCards(notes, events, seeds, settings, marks = [])`.** The optional last argument keeps every existing
caller and the golden snapshot unchanged.
- Each card replays one timeline: its review events plus its note's marks, sorted by `t`, then `id`.
- `applyMark(st, mark, settings)` (all deterministic, no clock):
  - `known`:
    - `days = KNOWN_DAYS + hash(noteId#type) % KNOWN_SPREAD` (90 + 0–29), so marked words don't all come due on one day.
    - The card becomes: `state 2`, `due = addDays(dayStart(t), days)`, `stability = days`, `scheduledDays = days`,
      `learningSteps 0`, `last = t`, `reps = max(reps, 1)`.
    - `difficulty` stays as it is (5 if the card was new). `first ??= t`. `locked` is removed. `leechBase = lapses`.
      `mark = { a: 'known', t }`.
  - `relearn`:
    - The card is rebuilt as `scheduler(retention).next(createEmptyCard(t), t, Rating.Again).card`. That puts it in learning,
      due in about a minute, and so in today's queue.
    - It keeps `lapses` and `reps`. `leechBase = lapses`, `first ??= t`, `locked` is removed, and `mark = { a: 'relearn', t }`.
  - `suspend` sets `suspended: true`. `unsuspend` deletes it. Neither touches the schedule.
  - An unknown `a` is a no-op.
- `applyReview` carries `suspended`, `mark` and `leechBase` over. The fast path in `recordReview` uses `applyReview`, so it
  keeps them too.
- `isLeech(c) = c.lapses - (c.leechBase ?? 0) >= 8`. With this, "I know this" or "Relearn" on a leech clears the leech
  status without erasing its lapse count.
- Marks are resolved through `aliases`, like events. They are a view only, through a new
  `resolveMarkNotes(marks, aliases, noteIds)` in schedule.ts. Stored rows keep the raw note id.

**D5. Green rows vs manual marks: the later one wins.**
- The seed time is when the word first came in green. `pickOlder` keeps it across re-imports, so re-importing the same
  Excel never overrides a mark.
- The existing rule stays: the seed is used only when it is not after the first review (no change to replay for reviews).
- New rule: when the seed is used, `known` and `relearn` marks older than the seed are skipped. Marks after the seed apply
  over it. Suspend and unsuspend always apply.
- Result:
  - Hugo marks a green word "Relearn": it stays in learning after any number of re-imports.
  - He marks a word "Relearn" and colours its row green *later*: green wins (seeded state).
  - He removes the green colour: the word goes back to "new", unless reviews or marks exist (current behaviour).

**D6. Status and queue.**
- `Status` gains `'suspended'`. `cardStatus` returns it first. `noteStatus` returns `'suspended'` when any unlocked card is
  suspended (marks are per note, so all of them are).
- `buildQueue`, `moreNew` (through buildQueue) and `reviewAhead` skip `c.suspended` cards.
- An explicit "Review now" from Words (custom `#/review?cards=`) still works on a suspended word.
- A `known` card has state 2, so it is not counted as a new word and doesn't use up a daily new slot (`introducedToday` is
  event-based).
- Status `mastered` (due 3+ weeks away) follows from the far due date. About 3 weeks before the due date it shows `review`,
  which is honest.

**D7. Shared preferences sync inside `settings.json`, as the additive field `Settings.prefs?: Record<string, unknown>`.**
- Old clients keep unknown settings fields: they save `{...current, ...patch}` and upload the whole object. So `prefs`
  survives a round trip through an old device.
- `SHARED_PREFS = ['lang', 'acceptBoth', 'qm.shown', 'qm.preset', 'qm.tag', 'qm.filter']`.
- Per-device prefs, not synced: `voice` and `rate` (voices differ by device), `qm.mode`, and `mode.<cardType>` (iPhone
  writes, PC types; see Q2). `warm.*` are cache markers, not prefs.
- `setPref` on a shared key notifies a listener that `store.init` registered. After 1.5 s (debounced), the store runs
  `updateSettings({ prefs: collectSharedPrefs() })`. This reads every shared key from localStorage, so a change missed
  because the app closed early is carried by the next one. It also bumps `updatedAt` and `settingsDirty`, which makes sync
  upload it.
- Settings that arrive from sync with `prefs`, and the settings at init, are written to localStorage **without** notifying
  (no echo), and `state.lang` is updated.
- Conflicts: the whole `settings.json` goes to the latest `updatedAt`, as today. One user rarely changes two devices at once.
  This is documented, not engineered.
- Nothing pushes at boot. Otherwise a stale device would overwrite newer settings.

**D8. Backup file, for when sync is off and as a safety net.** New `src/lib/backup.ts`. No new dependency: gzip comes from
`fflate`, which is already used.
```ts
export interface BackupFile {
  format: 'hugo-zhongwen-backup'; version: 1; exportedAt: number; device: string; appVersion?: string;
  settings: Settings; vocab: VocabFile | null;          // notes + meta (seeds, aliases)
  events: ReviewEvent[]; marks: StatusMark[];            // raw rows from the DB, every device
  prefs: Record<string, unknown>;                         // SHARED_PREFS + per-device prefs, never warm.*
}
```
- **Never included:** `syncLink` (token), `syncShas`, `folderHandle`, dirty flags, `pendingImport`.
- Restore is a merge, never a replacement:
  - Events and marks: only ids that are not already present are added. Nothing is overwritten.
  - Rows whose `dev` is this device have their months marked dirty, so they are uploaded again.
  - Rows from other devices are stored with the `mo` they had in the backup (fallback `monthKey(t)`). When those devices'
    files come in through sync, the files stay authoritative.
  - Vocab: applied only when this device has no word list. Otherwise the local list is kept, because Excel or sync is the source.
  - Settings: the newer `updatedAt` wins. Prefs are written to localStorage.
- Restore also accepts the old reviews-only export (`{ exportedAt, events }`), plain or gzipped (magic bytes `1f 8b`).
- Out of scope (follow-up): adopting the backup's device id when restoring a wiped device with sync off. Two devices with
  one id would overwrite each other's files in the repo.

**D9. iPhone specifics.**
- Saving the backup on iOS: `navigator.share({ files: [File] })` when `canShare` says yes, so Hugo can use "Save to Files".
  Otherwise, and on desktop, an `<a download>`.
- Restoring: `<input type="file">` with no MIME filter, which is the most reliable on iOS. The file type is detected from
  the bytes.
- Safari tabs (not Home Screen apps) lose script storage after 7 days without use (ITP). Settings shows a warning when the
  app runs on iOS outside standalone mode with sync off.
- Storage status comes from `navigator.storage.persisted()`, plus a "Protect storage" button that calls `persist()` when
  available. `init` already requests it.
- The new buttons are `.btn.small` (44px on coarse pointers). There are no new inputs, so the 16px input rule doesn't apply.
- Marks work offline and sync later, like reviews.
- No new assets and no new hosts, so no PWA precache or CSP change.

**D10. The progress workbook and Stats count marks.**
- `progress.ts`:
  - `STATUS_LABEL.suspended = 'Suspended'`.
  - A new **last** column, "Set by you": `Known 2026-11-07`, `Relearn …` or `Suspended …`, from the latest mark of the word.
    It goes last so Hugo's existing column positions don't move.
  - Summary rows: "Suspended" and "Marked known by you".
- `folder.ts` adds the mark count and the last mark time to `signature()`, so a mark rewrites the workbook.
- `stats.ts`: `statusCounts` gains `suspended`, and a new `markCounts` feeds a "Set by you" line in Stats.

## 2. Questions for Hugo
1. **When you tap "I know this", how far away should the next check be?** Default: in 3 to 4 months (90–119 days, spread out).
2. **Should the answer style per card type (typing, writing, choice…) be the same on all your devices?** Default: no, each
   device keeps its own (writing on the iPhone, typing on the PC). Meaning language and Quick filters are shared.
3. **Should suspended words still show up in Quick memory (free practice)?** Default: yes. Suspending only removes a word
   from scheduled reviews.

## 3. Audit: where every action is saved

| Action / preference | Saved in | Synced | In backup (new) | Fix in this batch |
|---|---|---|---|---|
| Review | `db.events` + `kv.dirty`, in one transaction | `events/<dev>/<mo>.json` | yes | none |
| Undo review | the own event is deleted and its month marked dirty | file rewritten | yes | none |
| Word status (new) | `kv['marks:<dev>:<mo>']` + `kv.marksDirty`, in one transaction | `marks/<dev>/<mo>.json` | yes | **new** |
| Study settings | `kv.settings` | `settings.json` (latest wins) | yes | none |
| Meaning language `lang`, `acceptBoth`, Quick `qm.shown/preset/tag/filter` | localStorage `hz.*`, per device | **no** | yes | **sync through `settings.prefs`** |
| Answer mode `mode.<type>`, `qm.mode`, `voice`, `rate` | localStorage, per device | no, by design (Q2) | yes | none |
| Word list, seeds, aliases | `db.notes` + `kv.vocabMeta` | `vocab.json.gz` | yes | none |
| Held-import decision | `kv.pendingImport` / `rejectedImportHash`, local | no (it belongs to the importing device) | no | none |
| OneDrive folder link | `kv.folderHandle` (PC only; Edge asks for permission again after a restart) | can't be synced | no | none |
| Sync link and token | `kv.syncLink` | never | **never** (security) | test that the backup has no token |
| Device id | `kv.deviceId` | `devices/<id>.json` | id recorded as `device` | none |
| Session in progress | memory; each answer is saved at once | — | — | none |
| Whole device | IndexedDB, evictable; Safari tabs are cleared after 7 idle days | via sync only | **new backup file** | **backup/restore, storage status, iOS Safari warning, Today nudge when sync is off** |

## 4. Work packages

**WP0 (lead, about 10 lines, before the rest).**
- `src/lib/types.ts`: add `MarkKind` and `StatusMark` (D1). Add these to `CardState`:
  `suspended?: boolean; mark?: { a: 'known' | 'relearn'; t: number }; leechBase?: number`.
- `src/lib/engine/schedule.ts` line 218: `export type Status = 'new' | 'learning' | 'review' | 'mastered' | 'leech' | 'suspended';`.
  This is the only edit the lead makes in that file; WP1a owns the rest.

**WP1a: engine, queue, stats, workbook (engineer, opus, M).**
- **Files:** `src/lib/engine/schedule.ts`, `src/lib/engine/queue.ts`, `src/lib/stats.ts`, `src/lib/progress.ts`,
  `src/lib/engine/engine.test.ts`, `src/lib/progress.test.ts`.
- **Interfaces:**
  ```ts
  // schedule.ts
  export const KNOWN_DAYS = 90, KNOWN_SPREAD = 30;
  export function deriveCards(notes: Note[], events: ReviewEvent[], seeds: Record<string, number>, settings: EngineSettings, marks?: StatusMark[]): CardState[]
  export function applyMark(s: CardState, m: Pick<StatusMark, 'a' | 't'>, settings: EngineSettings): CardState
  export function resolveMarkNotes(marks: StatusMark[], aliases: Record<string, string>, noteIds: Set<string>): StatusMark[]
  export function isLeech(c: CardState): boolean            // uses leechBase
  export function latestMarks(marks: StatusMark[]): Map<string, { status?: StatusMark; suspend?: StatusMark }> // per note: last known/relearn, last suspend/unsuspend
  // stats.ts
  export function statusCounts(...): Record<Status, number>  // + suspended
  export function markCounts(marks: StatusMark[], noteIds: Set<string>): { known: number; relearn: number; suspended: number }
  // progress.ts
  export interface ProgressInput { …; marks?: StatusMark[] }
  ```
- **Steps:**
  - D4–D6 in schedule.ts: group marks by note, merge them into each card's timeline, apply the seed-precedence rule, and
    carry the new fields over in `applyReview`. Add `'suspended'` in `cardStatus`/`noteStatus`/`RANK`.
  - In queue.ts, filter `c.suspended` out of `active` (buildQueue) and out of `reviewAhead`.
  - Update stats.ts and progress.ts (D10).
- **Tests:**
  - A `known` mark on a new word gives `mastered` and a due date 90–119 days out. The word is not in the new-card queue and
    doesn't count toward `introducedToday`.
  - A review after `known` continues from the known state.
  - `relearn` on a mature card: state learning, due within 2 min, in `buildQueue().cards`, lapses kept.
  - `known` on a leech: no longer a leech, and the lapses are kept.
  - `suspend` removes the card from buildQueue, moreNew and reviewAhead, and gives status `suspended`. `unsuspend` restores
    the earlier schedule.
  - Seed precedence: a relearn mark after the seed wins, and a seed after the relearn mark wins. Re-import with the same seeds
    leaves the cards unchanged.
  - Marks given in shuffled order give identical cards (determinism, ties broken by id).
  - An unknown `a` is a no-op.
  - Marks on an old id resolve to the renamed note.
  - The **golden snapshot is unchanged** with `marks` omitted.
  - progress: the "Suspended" label, the "Set by you" column is last, and the summary rows.
- **Done when:** `npm test` passes and `npx tsc --noEmit -p .` is clean, apart from errors in WP1b/WP2 files that are still in flight.

**WP1b: store, sync, prefs, backup (engineer, opus, L). Runs in parallel with WP1a and codes against the signatures above.**
- **Files:** `src/lib/store.ts`, `src/lib/db.ts`, `src/lib/sync.ts`, `src/lib/folder.ts`, new `src/lib/backup.ts`,
  `src/lib/store.test.ts`, `src/lib/sync.test.ts`, new `src/lib/backup.test.ts`.
- **Interfaces:**
  ```ts
  // db.ts
  Settings.prefs?: Record<string, unknown>
  export const SHARED_PREFS: readonly string[]; export const DEVICE_PREFS: readonly string[] /* + 'mode.' prefix */
  export function onSharedPrefChange(l: (key: string) => void): () => void   // fired by setPref for SHARED_PREFS only
  export function collectPrefs(keys: 'shared' | 'backup'): Record<string, unknown>
  export function writePrefsSilently(p: Record<string, unknown>): void
  // store.ts
  AppState.marks: StatusMark[]                     // alias-resolved view; raw kept in a module variable like `raw`
  export async function setNoteStatus(noteId: string, a: MarkKind, t?: number): Promise<StatusMark>
  export async function undoMark(markId: string): Promise<void>       // own device only
  export async function mergeDeviceMarks(device: string, month: string, marks: StatusMark[], opts?: { rebuild?: boolean }): Promise<boolean>
  export async function ownMonthMarks(month: string): Promise<StatusMark[]>
  export async function dirtyMarkMonths(): Promise<Record<string, number>>
  export async function clearMarkDirty(month: string, stamp: number): Promise<void>
  export async function addRestored(events: ReviewEvent[], marks: StatusMark[]): Promise<{ events: number; marks: number }>
  // sync.ts
  export const marksPath: (device: string, month: string) => string
  export function encodeMarks(device: string, month: string, marks: StatusMark[]): string
  export function decodeMarks(text: string, device: string): StatusMark[]   // throws on a bad row or on v > 1 (typed error → updateNeeded)
  // backup.ts
  export async function buildBackup(): Promise<{ bytes: Uint8Array; name: string }>   // .json.gz; sets kv.lastBackup
  export async function saveBackupFile(): Promise<void>                               // share sheet on iOS, else download
  export async function restoreBackup(bytes: Uint8Array): Promise<RestoreReport>
  export interface RestoreReport { events: number; marks: number; vocab: 'applied' | 'kept' | 'none'; settings: 'applied' | 'kept'; prefs: number }
  export async function lastBackup(): Promise<number | null>
  export async function storageStatus(): Promise<{ persisted: boolean | null; usage?: number; quota?: number }>
  export async function requestPersist(): Promise<boolean>
  ```
- **Steps:**
  - store:
    - Load the marks in `init` and `reloadFromDb`, and pass them to `deriveCards`.
    - `setNoteStatus`: write the mark and its dirty month in one kv transaction. Then rebuild only that note's cards: call
      `deriveCards([note], eventsOfNote, seeds, s, marksOfNote)` and replace them in the map.
    - Run `broadcast('mark')` and `notifyLocalChange()`.
    - Update `undoMark`, `hasOwnEvents` (D2) and `renewDeviceId` (D2) to match.
  - Prefs (D7): `setLang` goes through `setPref`. The init listener is debounced. Apply `prefs` in `updateSettings(fromSync)`
    and at init.
  - sync:
    - Pull: step 3b reads marks files of the other devices. A file's sha is remembered only once it is merged. It shares the
      one `rebuildAll` at the end.
    - Push: step 4b uploads own dirty mark months. Commit message: `<dev>: marks <month>`.
    - Update `idUsed` (D2).
  - folder: `signature()` includes marks, and `progressWorkbook` is given `marks` (D10).
  - backup.ts: D8 and D9.
- **Tests:**
  - store:
    - `setNoteStatus` survives a fresh `init()` (fake-indexeddb).
    - The mark row and `marksDirty` are written together.
    - `undoMark` refuses another device's mark.
    - `mergeDeviceMarks` replaces its device-month row and ignores this device's own marks.
    - `setVocab` with a re-import keeps the effect of the mark.
    - A shared pref change → after the debounce, `settings.prefs`, `settingsDirty` and a newer `updatedAt`.
    - `updateSettings(rs with prefs, true)` → localStorage and `state.lang` updated, with no echo (no new dirty flag).
  - sync:
    - Encode/decode round trip. A malformed marks file → a warning, other files still merge, and own marks are still pushed.
    - `v: 2` → `updateNeeded`.
    - A `marks/` path is never decoded as events.
    - The upload contains a mark written straight into kv (simulating a second tab).
    - `idUsed` sees `marks/<id>/`.
  - backup:
    - build → `db.delete()` + `init` → restore gives the same events, marks, settings and prefs.
    - The bytes contain no token string.
    - Restoring twice adds 0.
    - Own months come back marked dirty in both `dirty` and `marksDirty`.
    - The legacy `{exportedAt, events}` file is accepted, both plain and gzipped.
    - Vocab is kept when a local list exists.
- **Done when:** all tests pass, `tsc` is clean once WP1a has landed, and `e2e/sync.py` still passes.

**WP2: UI (ui-dev, sonnet, M). Runs in parallel with WP1a and WP1b, and codes against the signatures above.**
- **Files:** `src/ui/Words.tsx`, `src/ui/review/GradeBar.tsx`, `src/ui/review/Session.tsx`, `src/ui/Stats.tsx`,
  `src/ui/Settings.tsx`, `src/ui/Today.tsx`, `src/styles.css`.
- **Steps:**
  - **Words detail (`NoteDetail`):**
    - Add a "Your status" row: "I know this", "Relearn" (hidden while the word is new), and "Suspend" or "Unsuspend".
    - After a tap, show an inline "Marked as known. Undo" (component state holds the mark id → `undoMark`). Add a line
      "Set by you: Known on 7 Nov 2026 (iphone-…)" from `state.marks`.
    - The History table mixes in marks as rows ("Set as known", etc.).
    - The status filter gains "Suspended" and "Set by you". The list rows stay links, with no buttons inside: on the phone,
      one tap opens the detail.
  - **Review:**
    - `GradeBar.tsx` exports `ReviewActionsContext = createContext<{ onMarked(m: StatusMark): void } | null>(null)`.
    - `CardActions` renders two ghost small buttons, "I know this" and "Suspend". They call `setNoteStatus(card.note, …)`,
      then `ctx.onMarked`. Show nothing when there is no context.
    - "Relearn" is left out of Review because "Again" covers it there.
    - Fresh cards already show the GradeBar, so "I know this" also appears on the new-word intro. That is the main use.
  - **Session.tsx:**
    - Provide the context. On a mark, use the `busy` guard, drop the remaining queue entries of the same note, and advance
      `pos` without counting an answer.
    - `last` becomes `{ kind: 'review' | 'mark'; id; …snapshot }`, and the topbar undo calls `undoReview` or `undoMark`.
    - Toast: "Marked as known: next check in about 3 months" / "Suspended".
  - **Stats:** add a "Suspended" cell in the Words status block, and a "Set by you: N known, M suspended" line (`markCounts`).
  - **Settings, "Your data":**
    - "Back up to a file" (`saveBackupFile`), and "Restore from a file" (a hidden file input → `restoreBackup` → a toast
      with the report counts).
    - A line with the last backup date. The storage line: "Protected" or "May be cleared by the browser", with a
      "Protect storage" button.
    - The iOS-Safari-tab warning (D9).
    - Replace "Export review history" with the backup. Change the "Clear this device" confirm to suggest a backup first
      when sync is off.
    - Move the persisted text out of `OfflineSettings`, to avoid saying it twice.
  - **Today:** when sync is off and the device has reviews, and the last backup is missing or more than 7 days old, show a
    one-line notice with a "Back up now" button.
  - **styles.css:** add `.status.s-suspended` (muted ink with a dashed border, readable at 4.5:1) and a compact `.card-actions` row inside `.dock`
    that respects the existing safe-area padding.
- **Done when:**
  - Words → "I know this" → the pill shows Mastered. Reloading keeps it.
  - Review → "Suspend" on a fresh card → the next card shows, undo brings it back, and Today's counts drop by one.
  - Backup on desktop and restore in a fresh profile both work.

## 5. Order
1. WP0 (lead).
2. WP1a, WP1b and WP2 in parallel, in the background. The files are disjoint, and every cross-package name is fixed in this plan.
3. The lead integrates and runs `npx tsc --noEmit -p .`, `npm test` and `npm run build`. Name mismatches are fixed by the lead
   (under ~30 lines) or sent back to the owning package.
4. One qa pass (this changes sync formats, so qa is required).

## 6. Verification for qa
- **Unit:** all the tests listed in WP1a and WP1b; the golden replay snapshot unchanged; and the perf budget (2,000 notes,
  200k events plus 1,000 marks under 3 s).
- **Browser (preview, `e2e/`, synthetic workbook):**
  - Import → Words → mark a word known, suspend another, relearn a green one → reload: all three kept.
  - Re-import the same file: all three still kept.
  - Re-import with the relearned word's row still green: still in learning (the seed is older).
  - Review: "I know this" on the intro, then undo, then "Suspend" → it leaves the queue. Today's count updates.
  - Two tabs: marking in tab A shows in tab B within 1 s.
  - Progress workbook (folder flow, or calling `progressSheets` in a test): Suspended status and the "Set by you" column, last.
  - Settings: back up, "Clear this device", restore → the same review count, marks and lang.
- **Sync (`e2e/sync.py` with a scratch private repo):**
  - Device A marks → `marks/<A>/<month>.json` appears in the repo. Device B shows the status after a sync.
  - Undo on A → the file is rewritten without the mark → B reverts.
  - Change the meaning language on A → B picks it up after a sync and a reload.
  - Push a hand-made marks file with `v: 2` → a warning, and nothing applied.
- **Old-version compatibility:**
  - Check out the commit before this batch and run it on a second profile against the same repo. It syncs with no
    warnings, ignores `marks/`, and keeps `settings.prefs` when it saves settings (check `settings.json` after it changes
    a setting).
  - An old-version tab open on the same DB keeps working; there is no versionchange.
- **iPhone (Home Screen app, plus a Safari tab):**
  - The status buttons sit above the grade buttons and clear the home indicator, at 44px targets.
  - Back up opens the share sheet → Save to Files. Restore from Files works.
  - The Safari-tab warning shows only in Safari with sync off.
  - Marks made offline sync once the connection is back.
- **Data hygiene:** no backup files, xlsx or word lists are committed (`git status` clean of `*.json.gz`/`*.xlsx`).
