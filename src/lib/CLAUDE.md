# src/lib — logic, storage, sync

<!-- Loaded only when a session works in src/lib. Detail moved here from the root brief. Keep each line a pointer, not
     an explanation: the file headers carry the design. -->

## Invariants (break one and Hugo loses data)
- Events and marks are append-only; ids are never reused. Each device writes only its own `events/`, `marks/`,
  `explain/` files; the month is frozen in `mo`.
- Dexie DB `hugo-zhongwen` is still v1 (docs/decisions.md STORE-1). Any index or stored-shape change = `version(n+1)` + upgrade.
- Sync formats are additive only; older app versions must still read them (SYNC-2).
- Write-back to the workbook: If-Match always; never overwrite an Excel edit; backup into the app folder first.

## Map
| Area | Files | Notes |
|---|---|---|
| Types | `types.ts` | Note, VocabFile (aliases, colourSince), ReviewEvent (mo), StatusMark/MarkKind (`st:*`), WordStatus… |
| Storage | `db.ts` | tables: notes, events, kv (settings, sync state, dirty months, marks, folderHandle, copySig, msAuth…) |
| State | `store.ts` | init (migrations), setVocab, recordReview/undoReview, setNoteStatus/undoMark, BroadcastChannel `hz` |
| Status | `status.ts` | colour → status rules, labels/fills/marks, `sheetRows` |
| Engine | `engine/schedule.ts`, `queue.ts`, `grade.ts` | FSRS (ts-fsrs pinned), day starts 04:00, `deriveCards` |
| Import | `import/build.ts`, `guard.ts`, `renames.ts`, `worker.ts`; `sources.ts` | Excel → VocabFile in a worker; guard holds suspicious imports |
| Excel files | `xlsx/read.ts`, `write.ts`, `patch.ts` (+ worker, client) | in-place fill patch |
| PC folder | `folder.ts` | File System Access link, re-import on change, `writeCopy()` (no-Microsoft path) |
| Workbook on OneDrive | `workbook.ts`, `writeIntents.ts` | read by quickXorHash, write-back with intents |
| Microsoft | `ms/auth.ts` (PKCE, no MSAL), `graph.ts`, `appfolder.ts`, `find.ts`, `qxh.ts`, `config.ts`, `diagnostics.ts` | |
| Sync | `sync.ts`, `syncstore.ts`, `github.ts` | Web-Lock sync, per-file error isolation; same files on GitHub and OneDrive |
| Dictionary | `lexicon.ts`, `french.ts` | shards in public/dict/w (built in CI; `LEXICON_SAMPLE=1` locally) |
| Explain | `explain/` | Claude client, key in kv `claudeKey` (never synced/backed up), cache, prompt |
| Other | `backup.ts`, `stats.ts`, `pinyin.ts`, `speech.ts`, `strokes.ts`, `pwa.ts` | `progress.ts` = legacy, not written |

`progress.ts` is dormant (only its test imports it); deleting it is connected-saving WP13.

## Sync file layout
`vocab.json.gz` · `settings.json` (latest `updatedAt` wins; `prefs` field) · `events/<dev>/<YYYY-MM>.json` ·
`marks/<dev>/<YYYY-MM>.json` · `explain/<dev>/<YYYY-MM>.json.gz` · `devices/<dev>.json`.
OneDrive uses flat names (`events.<dev>.<YYYY-MM>.json`), see `syncstore.ts`. Write conflicts (409/412/422) retry once.

## Testing
- Fakes: fake GitHub + `device()` helper in `sync.test.ts`; fake Microsoft/OneDrive in `ms/fake.ts`
  (`vi.stubGlobal('fetch', fake.fetch)`); in-memory folder (File System Access) in `fakefs.ts`. No test touches the network.
- Node 24 has global `navigator.locks`: never run one device's sync inside another's.
- `sync.test.ts` is ~1,500 lines: grep for the `describe` you need, don't read it whole.
- Run first, by area: sync → `sync.test.ts`; workbook write-back → `writeback.test.ts`, `workbook.safety.test.ts`,
  `workbook.test.ts`, `xlsx/patch.test.ts`; PC copy → `folder.test.ts`; held imports → `sources.test.ts`; statuses → `status.test.ts`, `store.test.ts`; engine → `engine/engine.test.ts`;
  import → `import/*.test.ts`; Microsoft → `ms/*.test.ts`; explain → `explain/explain.test.ts`.

## Gotchas
- Add one line each, at the end of sessions that hit them.
