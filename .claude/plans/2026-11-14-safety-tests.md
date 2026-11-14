# Safety tests for the data-writing paths (2026-11-14)

## Goal
Unit tests for the untested branches that write Hugo's data. Found with a coverage run: `src/lib` is ~90% covered, but
`folder.ts` (56%), `sources.ts` (68%) and some data-safety branches of `workbook.ts` and `sync.ts` are not.
**Tests only: no change to production code.**

## Rules for every package
- Write only the files your package owns. Don't edit production code under `src/`.
- If a test shows behaviour that looks wrong, don't fix it: keep the test with `it.skip('BUG: …')`, a one-line comment
  saying what you expected and what happened, and list it in your report.
- Reuse the existing fakes and patterns: fake Microsoft/OneDrive in `src/lib/ms/fake.ts`, the inline import and patch
  mocks at the top of `src/lib/writeback.test.ts`, the fake GitHub and the `device()` helper in `src/lib/sync.test.ts`.
  Copy the few helpers you need into your file rather than exporting them from another test file.
- Devices run one after the other, never one inside another (Node's global `navigator.locks` is shared).
- Done when: `npx vitest run <your file>` passes, then `npx tsc --noEmit -p .` and `npm test` pass.
- No new dependency.

## WP1. Workbook write-back (`workbook.ts`) — new file `src/lib/workbook.safety.test.ts`
1. The workbook backup to the app folder fails → no PUT to the workbook, `excel` state shows the error. (lines ~574–580)
2. Backup cadence: a backup before the first write, none on the next write within a week, a new one after a week.
3. The file is saved again between the metadata read and the download (downloaded bytes' quickXorHash ≠ metadata) →
   the run starts over and writes only against the new version.
4. The linked item returns 404 (moved to another drive or deleted and re-created) → found again by name, link updated,
   not reported as missing. Renamed or moved within the drive → link name/path updated.
5. The same write keeps failing → marked stuck (kv `excelStuck`), not retried in a loop; a change to the fills clears it.

## WP2. Held imports (`sources.ts`) — new file `src/lib/sources.test.ts`
1. A suspicious import (guard check fails) applies nothing: notes unchanged, `vocabDirty` not set, `pendingImport` set.
2. `rejectPendingImport` → the same file (same vocab hash) is not held again; a changed file is.
3. `acceptPendingImport` after the list was replaced meanwhile (e.g. by sync) → renames and seeds are recomputed against
   the current list, then applied; `vocabDirty` set; `pendingImport` cleared.
4. Two `importBytes` calls started together run one after the other; the second is compared with the first's result.
5. `isOlderThanList`: older `modified` → true; same qxh → false; missing times → false.

## WP3. PC copy without Microsoft (`folder.ts`) — new files `src/lib/folder.test.ts` and, if needed, `src/lib/fakefs.ts`
An in-memory FileSystemDirectoryHandle / FileHandle / writable (`queryPermission`, `requestPermission`, `getFileHandle`
with `create`, `getFile`, `createWritable` with `write`/`close`/`abort`), with switches to deny permission or make a
write throw `NoModificationAllowedError`.
1. Signed in to Microsoft (write target = original) → `writeCopy` writes nothing.
2. Only `<stem> (app).xlsx` is ever written; the original's bytes are unchanged after every test.
3. Unchanged statuses and file (same signature) → no second write; `force` rewrites.
4. The original changed since the last import → no copy; a re-import is started first.
5. `WorkbookChangedError` from the patcher → no copy; after a second read, `folder.writeError` names the row.
6. The copy is open in Excel (write throws `NoModificationAllowedError`) → the writable is aborted, the message says
   to close it in Excel.
7. `checkFolder`: permission lost → state `permission`; file gone → state `missing`; unchanged file → not re-imported.

## WP4. Switching sync stores (`sync.ts`) — existing file `src/lib/sync.test.ts` (new `describe` at the end)
1. `unlinkOneDrive` with a GitHub repo still linked → every month of this device's events, marks and own explanations
   is queued, and after the sync GitHub holds all of them (nothing lost).
2. `unlinkRepo` while the target is OneDrive → OneDrive stays the target; sync keeps working.
3. During a move to OneDrive with the read-only GitHub pull on: a newer word list found on GitHub is forwarded to
   OneDrive; an older or identical one is not.
4. `stopReadingGitHub` → the next sync no longer reads GitHub.
