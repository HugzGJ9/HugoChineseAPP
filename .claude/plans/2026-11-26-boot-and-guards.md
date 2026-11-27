# Boot without the full replay, narrow subscriptions, stability guards (2026-11-26)

Request: [page-stability](2026-11-26-page-stability.md) §2 (R9) and §4 Batch 3 + Batch 4, approved by Hugo: **P4, P1, P2,
P14, B1, B3, B2** (original wording: [stability-speed](2026-11-24-stability-speed.md) §4). Out of scope: B5 (removing
"Try new animations"), Batch 5 (release rhythm). P13 (preload Grammar first) is done by the lead in `src/ui/App.tsx`
before this batch starts; no package touches `App.tsx`.

**Branch:** `stability-speed-3`, stacked on `stability-speed-2` (PR #18, not merged). Open the PR against
`stability-speed-2`, or rebase on main once #18 merges. `deploy.yml` runs on pushes to main and on manual dispatch; today a
manual dispatch from a branch would also publish that branch (WP6 fixes it). Until then qa runs the browser checks here.

## Goal
Start without replaying every review through FSRS (one 280–550 ms task at 4× today): warm start long task < 200 ms,
first row < 800 ms; after a sync, replay only the words that changed. Hidden kept screens stop re-rendering on sync and
Excel ticks, list renders stop building slots for skipped rows, `qrcode` leaves the boot bundle. Guards: a sync e2e
that says why it stops, a speed check in CI, and a device error log Hugo can paste into a chat.

## Decisions
- **D1 P4 = a per-word memo of derived cards, a cache only.** For each word (note) the cards are kept with a
  fingerprint of everything `deriveCards` reads for it: kind, studied, its seed, its events and its marks (in the
  alias-resolved views). Cards are reused only when the fingerprint and the env (engine settings, time zone, app build)
  both match; anything else is replayed by the unchanged `deriveCards`. Why this one: it is the only option that
  (a) removes the task instead of moving it, (b) is exact (an "event count it covers" key misses a merge that drops one
  event and adds another; a sync file is authoritative for its device and month, so that happens), (c) gives the
  incremental sync rebuild for free (`rebuildAll` replays only words whose fingerprint changed, with no bookkeeping in
  the merge paths, which can delete events and move them between words through aliases), and (d) keeps every rebuild
  synchronous like today. Rejected: a worker replay (same wait for the first row, or a "cards not ready" state that
  every screen and `recordReview` must respect; 8,000 events and 3,600 cards cloned each way; async rebuilds racing with
  reviews and merges); rows before cards (Sheets needs cards for its due count and Cards links, and the 300–550 ms task
  still lands right after the first rows, which is R9).
- **D2 Stored as one device-only kv row `cardsMemo`** (`{ v: 1, env, at, json }`). No Dexie bump: STORE-1 (new data in
  kv rows); the old unused `cards` table stays untouched. Never synced, never in backups (backups export named rows
  only), ignored by older app versions (no code scans kv without a prefix; `cardsMemo` matches no prefix in use:
  `marks:`, `ex:`). Deleting or corrupting it costs one full replay. JSON in one string: one cheap clone on write, and
  `JSON.parse` is faster than reading 3,600 cloned objects back.
- **D3 Only full-list derivations write the memo** (`init()` and `rebuild()`). `recordReview` (incremental) and
  `rebuildNote` (marks) leave it alone: their words no longer match their fingerprint and are replayed by the next
  `rebuild()` or start. So every stored pair
  (fingerprint, cards) came out of `deriveCards` together, and the memo is written a few times per session, not per tap.
- **D4 Env includes the app build and the time zone.** `dayStart`/`addDays` are local time (seed days, sibling unlock,
  "I know this" dates); any engine change ships in a new build, so nobody has to remember a version bump. Cost: the first
  start after each deploy replays everything once, in slices (D5).
- **D5 A full replay at start runs in slices** (~30 ms each, then a yield) inside `init()`, before `ready`: nothing can
  change the store then (channel not open, sync not started). Yield with `scheduler.yield()` or a `MessageChannel`
  message, never `setTimeout`: `folder.test.ts` fakes timers around `init()`, and browsers clamp nested `setTimeout(0)`.
  Rebuilds after start stay synchronous (a first sync on a new device or a settings change still costs one long task,
  as today; rare).
- **D6 P1: `useAppPick(...keys)`** in `store.ts` next to `useApp`, written by the lead first (WP0) so the UI packages run
  in parallel with WP1. Shallow (`===`) per key; screens keep their destructuring.
- **D7 P2: slots become render functions called inside the memoised row.** `sameRow` keeps ignoring them (the D1
  contract of stability-speed holds: changing slot content reaches a row only through `rowSig`).
- **D8 P14: `qrcode-generator` is imported dynamically inside `QrCode`**, not by splitting Setup. Setup is in the entry
  chunk through two static paths (`App` → `LinkPage`, `Sheets` → `Today` → `SetupSources`); the static import is what
  puts `qrcode-*.js` in `dist/index.html`'s modulepreloads. The chunk stays precached (Workbox `**/*.js`). Moving all of
  Setup out would save a few ms of parse for a larger change; revisit only if `perf.py` shows parse time at boot.
- **D9 B1: the sync e2e checks the fake repository, not the "Synced with …" label.** That label shows as soon as
  `linkRepo` sets `idle`, before (and without) a completed sync, so on the PC side nothing proves a sync ran; any
  environment where syncs don't complete surfaces only at the phone's `.sheets` wait. The handle crash is not on this
  path (the phone never stores a directory handle; the PC's is already replaced by a marker), but it shows the sandbox
  Chromium differs in browser services. Likely cause, in order: (H1) Web Locks never granted in the sandbox, so
  `exclusive(syncOnce)` never runs; (H2) `navigator.onLine === false` there (`syncOnce` returns "Offline"; less likely:
  `offline.py`'s warm-up check, which needs `onLine`, passed in the same session); (H3) one pull/push request failing
  only there (visible as a sync error). A probe in `e2e/sandbox.py` tells which and shims only what is broken, never in CI.
- **D10 B3: `e2e/perf.py` uses only a synthetic workbook it generates** (ignores `HUGO_XLSX`), seeds 8,000 events in
  the page, and reports. Budgets are soft (exit 0) unless `PERF_STRICT=1`; a flow that breaks (target never appears)
  always exits 1. Warm-start budgets are judged only when the build reports `hz:cards` (P4 present).
- **D11 B2: the device log is kv `devlog`, scrubbed when captured** (nothing unscrubbed is ever stored), device-only,
  never synced or backed up. Sources: uncaught errors, unhandled rejections, and the sync/Excel/folder/Microsoft
  warnings already in the store (watched with `subscribe`; no change to `store.ts`, `sync.ts`, `workbook.ts`). Checked:
  sync warnings carry device ids, months and `why(e)` (a V8 JSON error quotes file content, so words); folder messages
  carry file and folder names; workbook errors carry sheet names and rows; the sync key (`hz1.…`) carries the token.

## Compatibility checklist
- **IndexedDB**: no schema change, Dexie stays v1 (STORE-1). Two new optional kv rows, `cardsMemo` and `devlog`; older
  versions never read them (no prefix collision with `marks:` / `ex:`); a missing or broken row is handled as absent.
- **Sync**: no sync file or format change; neither row is uploaded or backed up; older versions on other devices see
  nothing new.
- **Events stay the source of truth**: the memo is only ever an output of `deriveCards`, re-checked per word on every
  use; events and marks are not touched; deleting the row costs one replay.
- **iPhone Safari**: nothing here needs File System Access; the Home Screen app has its own memo and log (separate
  storage from Safari, so its diagnostics describe that app only); Safari has no `scheduler.yield`, so yields fall back to
  `MessageChannel`; `visibilitychange` saves a pending memo before iOS suspends the app; WP7 adds no inputs (16 px rule
  n/a) and sits inside the existing Settings groups (safe areas as today); all of it works offline.
- **PWA cache and CSP**: no new host, no CSP change; the `qrcode` chunk stays precached (Workbox `**/*.js`) and now loads
  on demand; `perf.py` and `sandbox.py` are test-only.

## Questions for Hugo (defaults are built if he doesn't answer)
1. B2: may "Copy diagnostics" include the device id (e.g. `iphone-1a2b3c4d`) and counts (words, reviews, marks)?
   **Default: yes**, numbers and the device id only; no words, file or folder names, account or repository.
2. B2: also record the in-app error notes ("Couldn't save that: …" at the bottom of the screen)? **Default: no**, only
   uncaught errors and the sync, Excel, folder and Microsoft warnings; it would need a hook in the toaster later.

## Cross-package contracts (don't rename)
| From → to | Contract |
|---|---|
| WP0 → WP3, WP7 | `useAppPick<K extends keyof AppState>(...keys: K[]): Pick<AppState, K>` in `src/lib/store.ts` |
| WP1 → WP2, WP5 | kv row `cardsMemo` = `{ v: 1, env: string, at: number, json: string }`; once per start, in `init()`: `performance.measure('hz:cards', { start, end, detail: { total, cached, replayed, full } })` |
| WP2 → WP7 | `diagnosticsText(): Promise<string>`, `devLogSummary(): { errors: number; warnings: number }`, `onDevLogChange(l: () => void): () => void`, `clearDevLog(): Promise<void>` in `src/lib/devlog.ts` |
| WP5 → WP6 | `python e2e/perf.py`; env `HUGO_URL`, `E2E_OUT`, `PERF_RUNS` (default 3), `PERF_STRICT=1` (hard budgets); writes `$E2E_OUT/perf.json`; appends a table to `$GITHUB_STEP_SUMMARY` when set; exit 1 only on a broken flow, or a missed budget with `PERF_STRICT=1` |

## Work packages

### WP0 — lead, before the builders: `useAppPick`
- Files: `src/lib/store.ts`, `src/lib/store.test.ts` (≈ 25 lines in all). Commit before WP1, WP3, WP7 start.
- Interface:
  ```ts
  /** Some fields of the state: re-renders only when one of them changes (===). */
  export function useAppPick<K extends keyof AppState>(...keys: K[]): Pick<AppState, K>;
  /** `prev` when every picked field is the same object, else a new pick (pure, for the test). */
  export function pickState<K extends keyof AppState>(s: AppState, keys: K[], prev: Pick<AppState, K> | null): Pick<AppState, K>;
  ```
- Steps: `useRef` keeps the last pick; `useSyncExternalStore(subscribe, () => (last.current = pickState(state, keys, last.current)))`.
- Test: same object back after `setSync` when `sync` isn't picked; a new object when a picked field changes.
- Done when: `npx vitest run src/lib/store.test.ts` and `tsc` pass.

### WP1 — engineer (opus, high effort): P4 card memo
- Files (owns): `src/lib/engine/memo.ts` (new), `src/lib/engine/memo.test.ts` (new), `src/lib/store.ts`,
  `src/lib/store.test.ts`. Read only: `src/lib/engine/schedule.ts` — do not change it (golden replay, ENG-4).
- Interfaces:
  ```ts
  // engine/memo.ts
  export interface MemoEntry { fp: string; cards: CardState[] }
  export interface CardMemo { env: string; notes: Map<string, MemoEntry> }
  export interface StoredMemo { v: 1; env: string; at: number; json: string }
  export interface DeriveResult { cards: CardState[]; memo: CardMemo; replayed: number; full: boolean }
  export function memoEnv(s: EngineSettings): string;
  export function deriveWithMemo(notes: Note[], events: ReviewEvent[], seeds: Record<string, number>,
    s: EngineSettings, marks: StatusMark[], memo: CardMemo | null): DeriveResult;
  export function deriveWithMemoAsync(/* same */ ..., sliceMs?: number): Promise<DeriveResult>;
  export function encodeMemo(m: CardMemo, at: number): StoredMemo;
  export function decodeMemo(row: unknown, env: string): CardMemo | null; // never throws
  // store.ts
  export interface CardStats { total: number; cached: number; replayed: number; full: boolean; ms: number }
  export function cardStats(): CardStats;        // last derive (start or rebuild)
  export function flushCardMemo(): Promise<void>; // save now if a save is pending
  ```
- Definitions (precision matters):
  - env = `1|<__APP_VERSION__, or 'dev'>|<tz>|<retention>|<spreadDays>|<recall 0/1>|<listen 0/1>`; tz =
    `Intl.DateTimeFormat().resolvedOptions().timeZone` (try/catch → `''`) + `|` + `getTimezoneOffset()` of 1 Jan and
    1 Jul 2001. Computed on every `rebuild()` (cheap), so a zone change mid-session replays.
  - fp(note) = 53-bit string hash (cyrb53, public domain, base 36) of
    `kind|studied 0/1|seed ?? ''|E|M`: E = the note's events from the resolved view, grouped by `noteOfCard(e.card)`,
    sorted by (t, id), each `id,typeOfCard(card),t,r`, joined by `;`; M = the note's marks (every kind), sorted by
    (t, id), each `id,a,t`. Events and marks of notes not in `notes` are ignored (as in `deriveCards`).
  - Output order = `notes` order. With `memo = null`, `deriveWithMemo(...).cards` must deep-equal `deriveCards(...)`.
  - Words to replay go through `deriveCards` in batches (only their events and marks); `deriveCards` stays as is.
- Steps:
  1. `memo.ts` with a header comment: cache, never truth; what fp and env cover and why; D3. The sync and async
     variants share one generator that yields after each batch; the async one awaits `scheduler.yield()` when present,
     else a `MessageChannel` message (close the port), only when a slice ran over `sliceMs` (default 30), so a warm or
     small start never yields.
  2. `encodeMemo`: `json = JSON.stringify([[id, fp, cards], …])`, skipping a word whose cards hold a non-finite number
     (JSON would make it `null`; that word is replayed next start). `decodeMemo` returns null unless `v === 1`, env is
     equal, the JSON parses, every entry is `[string, string, array]`, and every card has a string `id`,
     `note === <entry id>`, finite `due, stability, difficulty, scheduledDays, learningSteps, reps, lapses, last,
     nEvents`, and `state` in 0–3.
  3. `store.ts`:
     - Module `memo: CardMemo | null`, `stats: CardStats`, a save timer. `rebuild()` keeps its signature and callers;
       it uses `deriveWithMemo(…, memo)`, keeps the new memo, updates `stats`, and schedules a save when
       `replayed > 0` or words were dropped.
     - `init()`: add `kvGet('cardsMemo', null)` to the existing `Promise.all`; decode with
       `memoEnv(engineSettings(settings))`; derive with `deriveWithMemoAsync`; if `gen` changed meanwhile (a guard:
       nothing should change the store before `ready`), rebuild the views from `raw`/`rawMarks` and derive with
       `rebuild()`; keep the memo and stats and schedule a save as `rebuild()` does; record the `hz:cards` measure
       (try/catch; detail per the contract); yield once more (same yield) so the first render is its own task; then `set({ ready: true, … })` as today. Register once (browser only):
       `visibilitychange` → hidden → `flushCardMemo()`.
     - Save: debounced 3 s; skipped when `!db.isOpen()` (closed for an upgrade, or deleted by "Erase everything");
       `kvSet('cardsMemo', encodeMemo(memo, Date.now()))` inside try/catch (a failed save only costs a replay).
       `wipeAll()` clears the timer first.
     - Comments at `recordReview` and `rebuildNote`: they don't touch the memo (D3). One line in the file header.
  4. No Dexie version change, no new table, no change to sync, backup or event/mark code.
- Tests:
  - `memo.test.ts` (seeded PRNG, ≥ 200 notes, vocab and grammar, studied or not, seeds, 3,000 events incl. equal
    timestamps, marks of every kind incl. `st:*`, `flag:wrong` and an unknown kind):
    1. `deriveWithMemo(…, null)` deep-equals `deriveCards(…)`, same order.
    2. Same inputs + returned memo → `replayed 0` and the very same `CardState` objects.
    3. Each change replays only the affected words and equals a fresh `deriveCards`: add, remove, change an event
       (`r`, `t`); add, remove a mark; change kind; toggle studied; change and remove a seed; add, remove a note;
       reorder notes (no replay); an alias moving events to another word.
    4. Each env part (four settings, tz string, build) → `full`.
    5. Field guard: for every field of a fully filled `Note` fixture, a new value that changes `deriveCards`' output
       must change the fp (catches a future engine read the fp doesn't cover).
    6. Purity guard: `deriveCards` gives the same output with `Date.now` stubbed to two different values.
    7. encode/decode round trip; decode → null for another `v`, another env, bad JSON, a missing field, `NaN`, a note
       mismatch, a non-array.
    8. Async result = sync result; with `sliceMs = 0` it yields at least once.
  - `store.test.ts`, new `describe('card memo')`:
    1. First start: `cardStats().full`; after `flushCardMemo()` a second start on the same idb has `cached === total`
       and cards equal to `deriveCards` over the stored rows.
    2. After `recordReview`, `setNoteStatus`, `undoMark` (+ flush and a new start): only that word replayed; equal to a
       fresh derive.
    3. `mergeDeviceEvents` dropping and adding events of another device + `rebuildAll()`: only those words replayed.
    4. TZ changed between two starts → full; equal to a fresh derive in the new zone.
    5. Corrupt row, `v: 2` row, row from other settings → full replay, no throw, replaced after a flush.
    6. `buildBackup()` (import `./backup` after `device()`) after a flush contains no `cardsMemo` and no memo JSON.
    7. In `describe('speed')`: 2,000 notes, 20,000 events, the warm start's derive takes < 1/3 of the cold one.
- Done when: `npm test` (golden replay unchanged) and `tsc` pass; handback gives cold vs warm derive ms from test 7 and
  the decision and `src/lib/CLAUDE.md` lines for the lead (see "For the lead").

### WP2 — engineer: B2 device log (logic)
- Files (owns): `src/lib/devlog.ts` (new), `src/lib/devlog.test.ts` (new), `src/main.tsx`.
- Interfaces:
  ```ts
  export type LogKind = 'error' | 'rejection' | 'sync' | 'excel' | 'folder' | 'ms' | 'app';
  export interface LogEntry { t: number; kind: LogKind; msg: string; at?: string; n?: number } // at: file:line:col; n: repeats
  export function startDevLog(): void;                  // idempotent, never throws
  export function recordError(e: unknown, kind?: 'error' | 'rejection'): void;
  export function logWarning(kind: LogKind, msg: string): void;
  export function devLogSummary(): { errors: number; warnings: number };
  export function onDevLogChange(l: () => void): () => void;
  export function clearDevLog(): Promise<void>;
  export function diagnosticsText(): Promise<string>;
  export function scrub(text: string): string;
  ```
- Storage: kv `devlog` = `{ v: 1, entries: LogEntry[] }`, newest last, at most 60 entries. Header comment: device-only,
  never synced or backed up, what is captured, the scrub rules.
- Steps:
  1. Capture: window `error` (message; file basename:line:col; top 4 stack frames) and `unhandledrejection`
     (reason's message and stack, or `String(reason)`); ignore "ResizeObserver loop" messages. Store watch through
     `subscribe`/`getState`: new strings in `sync.warnings`; `sync.message` when `state` becomes `error`;
     `sync.updateNeeded`; `excel.writeError`, `excel.message` (state error/missing), `excel.stuck`; `folder.writeError`,
     `folder.message` (error/missing/permission); `ms.message` (reconnect/error); `needsReload`. Log a value only when
     it changes; the same kind + message as the newest entry increments `n` and updates `t`. Never `ms.account`,
     `sync.repo`, `excel.name/path`, `folder.name`, `settings.fileName`, `meta.source`.
  2. `scrub()` runs before anything is stored, in this order: (1) secrets → `[secret]`: `sk-ant-…`, `gh[pousr]_…`,
     `github_pat_…`, `hz1.…` (sync key, holds the token), JWT-like `eyJ….….…`, `Bearer …`, values of `code`, `token`,
     `access_token`, `refresh_token`, `key` query parameters; (2) emails → `[email]`; (3) URLs: the app's origin →
     file basename (+ `:line:col`), others → host only; (4) `*.xlsx|xlsm|xls|csv` names → `[workbook]`; (5) text in
     `“…”`, `‘…’` or `«…»` → `“…”` always (the app quotes folder and file names that way); text in `"…"` or `'…'` with
     any non-ASCII character or longer than 32 characters → `"…"` (keeps `reading 'note'`);
     (6) runs of Han, kana, hangul, fullwidth forms, and words with a macron or caron tone mark (ā ē ī ō ū ǎ ě ǐ ǒ ǔ ǖ ǘ
     ǚ ǜ) → `…`; (7) at most 300 characters per message, 400 per stack.
  3. Persist: entries live in memory first; stored entries are loaded once `ready` is first true and merged; writes are
     debounced 1 s, only after `ready` and when `db.isOpen()`; every storage error is swallowed (the logger never logs
     itself). Record `performance.now()` when `ready` first turns true ("ready in … ms").
  4. `diagnosticsText()` (plain text, English):
     ```
     Hugo 中文 diagnostics, 2026-11-26 14:03 (UTC+01:00)
     App 3f2a1b9c · iphone-1a2b3c4d · Home Screen app · Safari 18 · online
     Data: 1810 words, 8012 reviews, 950 marks
     Start: ready in 640 ms · cards 38 ms, 1806 of 1810 from cache        (from hz:cards; "n/a" without it)
     Sync: OneDrive, idle, last 14:00 (3 min ago) · Excel: ok, 0 waiting · Folder: off · Microsoft: ok
     Storage: persisted, 23 MB used
     Problems (newest first):
     14:01:22 error TypeError: Cannot read properties of undefined (reading 'note') at index-CfLuD67Z.js:1:2345 (×3)
     ```
     Last 20 errors and last 10 warnings, merged by time. Sync shows only "OneDrive" or "GitHub", never the repo.
  5. `src/main.tsx`: `startDevLog()` as the first statement, before `startPwa()`.
- Tests (fake-indexeddb harness like `store.test.ts`' `device()`, copied, not imported): every scrub rule incl. a V8 JSON
  error quoting `{"hanzi":"学习"…}`, a Safari JSON error (kept), a folder name in “…”, a sync key, a URL with a token,
  `reading 'note'` (kept), `Reviews 2026-10 of windows-9f8e …` (kept); cap and dedupe; the store watch logs a new
  warning once and ignores unrelated store changes; entries survive a fresh module start; `clearDevLog`; the diagnostics
  text has version, device and counts and none of: a note's hanzi, pinyin, meaning, the account, the repo, the file and
  folder names, a Claude key, a sync key (put them in state and kv first); `buildBackup()` output has no log entry.
- Done when: `npx vitest run src/lib/devlog.test.ts`, `npm test`, `tsc` pass; handback lists each message source checked.

### WP3 — ui-dev (sonnet): P1 screens, P2 row slots, P14 qrcode
- Files (owns): `src/ui/Sheets.tsx`, `src/ui/qm.tsx`, `src/ui/cards/Cards.tsx`, `src/ui/grammar/GrammarPage.tsx`,
  `src/ui/Today.tsx`, `src/ui/Stats.tsx`, `src/ui/Words.tsx`, `src/ui/Setup.tsx`. Needs WP0 (`useAppPick`).
- P1: replace each `useApp((s) => s)` with `useAppPick(...)` of exactly the keys destructured today; nothing else:
  `Sheets.tsx:209` notes, cards, events, settings, noteMap, marks, meta, lang · `cards/Cards.tsx:52` notes, events,
  lang, marks, meta · `grammar/GrammarPage.tsx:27` notes, marks, meta, lang · `Today.tsx:13` notes, cards, noteMap,
  events, settings, sync · `Stats.tsx:58` notes, cards, events, device, marks · `Words.tsx:29` notes, cards, lang, marks
  · `Words.tsx:132` notes, cards, events, device, marks, meta. (`Settings.tsx:19` is WP7.)
- P2 (`qm.tsx`): `RowProps` drops `lead/trail/answer: ReactNode` and gains `item: Item` and
  `lead?/trail?/answer?: (it: Item) => ReactNode`. `QmList` passes `item={it}` and its own three functions (cast from
  `(it: T) => ReactNode`) and no longer calls them; `QmRow` calls them in its body (`const leadEl = lead?.(item)`) and
  renders as today (`!= null` checks, `own` handlers). `sameRow` is unchanged and still ignores the slots and `item`;
  update the comments at `sameRow` and `rowSig` (slot functions are fresh on every list render; their content reaches a
  row only through `sig`). `extra`, `rowClass`, `rowSig` unchanged. Sheets' slot lambdas stay as they are.
- P14 (`Setup.tsx`): remove the top-level `import qrcode from 'qrcode-generator'` (line 2). `QrCode` loads it in an
  effect (`import('qrcode-generator')`), keeps it in state and computes the path once loaded; until then it renders the
  same `svg.qr` element with no path (its 176 px box is set in `styles.css`, so nothing moves). `vite.config.ts` stays as is.
- Tests: no vitest (UI). Run `e2e/layout.py`, `e2e/cards.py`, `e2e/grammar.py`, `e2e/offline.py`, and `e2e/sync.py`
  (it waits for `svg.qr`; if it stops at the phone step, that is B1/WP4, note it and go on).
- Done when: `tsc` and `npm run build` pass; `dist/index.html` has no `qrcode-` modulepreload and the build lists the
  `qrcode` chunk; `grep -rn "useApp((s) => s)" src/ui` finds only `Settings.tsx`; the e2e above pass; no visual change.

### WP4 — engineer (sonnet): B1 sync e2e that says why it stops
- Files (owns): `e2e/sandbox.py` (new), `e2e/sync.py`, `e2e/od_common.py`, `e2e/onedrive.py`, `e2e/onedrive_sync.py`,
  `e2e/onedrive_writeback.py`. Not `e2e/README.md` (WP5 owns it; put usage in `sandbox.py`'s docstring).
- Interfaces (`sandbox.py`):
  ```py
  async def probe(browser) -> dict            # once per process: {'locks': 'granted'|'timeout'|'none', 'online': bool}
  async def prepare(context, browser) -> None # adds an init script for what the probe found broken; prints one line per shim
  async def dump(page, who) -> str            # URL, navigator.onLine, visible .notice texts (5), #sync text (300 chars)
  ```
- Steps:
  1. Probe in a fresh context on `U` (secure origin; Web Locks need one): race `navigator.locks.request('hz-probe', …)`
     against 3 s; read `navigator.onLine`. Shims, only when broken: locks timed out → remove `navigator.locks`
     (`Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true })`; the app then
     runs syncs directly, its path for iOS before 15.4); offline → `onLine` getter returning true. Print e.g.
     `sandbox: Web Locks never granted here: the app runs syncs without them`. Never shim when the probe passes (CI).
  2. `sync.py`: `await prepare(ctx, b)` after both `new_context`; wrap the `github()` route body in try/except
     (reply 500 with the message and add it to `errs`: a raised handler leaves the request pending forever); after
     "Turn on sync" poll `files` (≤ 30 s) for `vocab.json.gz`, else print `dump(pg)` and `log[-15:]` and exit 1 with
     "the computer's first sync sent no word list"; after the PC's "Sync now" poll for an `events/<pc>/…` file; stroke
     warm-up wait up to 60 s (poll, break early); the phone's `.sheets` wait becomes a 60 s poll that fails fast on a
     visible `.notice.bad` or "no device has sent words yet", with the dump, the repo listing and the API log tail;
     replace the fixed 1.5 s waits after each "Sync now" with polls on the repo (the phone's events file appears, the
     PC sees the phone's reviews), and before the verdict poll both IndexedDB event counts until equal (≤ 30 s).
  3. `od_common.py`: `show_words(page, ms=None, timeout=90)` polls `.sheets [role=tab]` (visible); every 10 s it calls
     `poll_for_change(page)` (the app's own workbook triggers); fails fast on a visible `.notice.bad`; on timeout prints
     `dump(page)` and, with `ms`, `ms.log[-15:]`, then raises. `onedrive_sync.py` and `onedrive_writeback.py` pass `ms`.
  4. `onedrive.py`, `onedrive_sync.py`, `onedrive_writeback.py`: `await prepare(ctx, b)` after each `new_context` that
     syncs (not the service-worker context in `onedrive.py`).
  5. Run here: `sync.py`, `onedrive_sync.py`, `onedrive_writeback.py` ×3. If neither shim applies and the dump shows a
     sync error from the app, stop and report the message: the fix is then outside these files.
- Done when: `sync.py` passes in this cloud session (with the shim it needed, named in the handback); the OneDrive
  scripts pass three runs in a row; the handback gives the probe result for the "Cloud session limits" line.

### WP5 — engineer (sonnet): B3 `e2e/perf.py`
- Files (owns): `e2e/perf.py` (new), `e2e/make_big.py` (new), `e2e/README.md`.
- `make_big.py OUT.xlsx` (and `make(path, hsk4=570, hsk5=1200, grammar=40)`): deterministic (seeded) synthetic
  workbook, no personal data. Words = ordered pairs of distinct characters from a built-in table of ~60 common
  characters with tone-marked pinyin and a one-word English gloss (hanzi `c1c2`, pinyin `p1p2`, English `g1 g2`),
  unique per sheet; same headers and colour cycles as `make_sample.py` (HSK四级 A–B fills, HSK五级 A–D fills with blank
  rows); a `Grammar` sheet with the extra columns of `make_sample.py`, all 40 rows filled (HSK 1–6, a few families,
  titles, definitions, use, register, 2–3 sentences). 1,810 notes in all.
- `perf.py` setup: Chromium, `p.devices['iPhone 13']`, `bypass_csp=True` (the app CSP blocks eval),
  `service_workers='block'`, init scripts: delete `showDirectoryPicker`; a probe that records long tasks
  (`PerformanceObserver` `longtask`, buffered) and the time the first `.ql-row` inside a visible screen is in the
  DOM, then painted (next rAF, with a `setTimeout` guard). Import with
  `input[type=file][accept*=xlsx]`; seed 8,000 events in the page through IndexedDB `hugo-zhongwen`/`events`: device
  `windows-perf0001`, ids `perf-<n>`, over 60 days, 70% `#recog`, 25% `#recall`, grammar `#grammar`, ratings
  1/2/3/4 at 10/15/60/15%, `mo` = local `YYYY-MM` of `t`, `d` 2–9 s, `m: 'type'`. CPU 4× through CDP
  `Emulation.setCPUThrottlingRate` on the page's CDP session, set before the first measured reload; check once that it
  still applies after `page.reload()` (time a busy loop before and after) so boots are measured throttled. Real reloads
  with `page.reload()` only (a same-URL hash `goto` doesn't reload). Select within the visible screen (`.main:visible`, `.ql-row:visible`): hidden kept screens stay
  in the DOM.
- Actions, each run with motion off, then on (`localStorage['hz.motion'] = 'true'` + reload); `PERF_RUNS` repeats,
  median judged; in-page timing from a dispatched click to the target, long tasks in [click, target + 300 ms], empty
  frames (a frame where no `.shell > .main, .shell > main` is displayed with children, or `main[aria-busy=true]` shows):
  1. **boot cold**: wait 4 s idle (no save pending), delete kv `cardsMemo`, reload. First row ms, longest task before
     it and in the 2 s after, `hz:cards` (duration, cached/total) when present.
  2. **boot warm**: poll kv `cardsMemo.at` > the cold reload time (≤ 10 s; skip if the build has no `hz:cards`), reload.
  3. **first Grammar visit** right after a warm boot (before the 2.5 s idle preload): `nav a[href="#/grammar"]` →
     `.gr` visible. Time reported, empty frames judged.
  4. **sheet tab**: All → HSK四级 → HSK五级 → All, target = that tab `aria-selected` and the first row's hanzi is the
     sheet's first word (known from the generator).
  5. **back to a tab**: Sheets scrolled to 3000 → Grammar → Sheets, and Sheets → Settings → Sheets; target = a visible
     `.ql-row`; scroll kept (±2 px).
  6. **peek**: tap a hidden cell of a row on screen → `.peek` inside it. 7. **status apply**: chip → `menuitemradio`
     "Mastered" → that row's chip says Mastered. 8. **word panel**: scroll 1200, tap a hanzi, `.pp-panel` opens, close,
     scroll kept.
- Budgets (soft unless `PERF_STRICT=1`): tab switch < 150 ms · back to a tab < 50 ms · empty frames 0 (actions 3–5) ·
  boot first row < 1,200 ms (cold and warm) · with `hz:cards` in the build: warm first row < 800 ms and longest boot
  task < 200 ms (cold and warm) · peek < 50 ms · status apply < 150 ms (stability-speed budgets).
- Output: a table per motion setting (action, min / median / max, budget, longest task, empty frames, scroll kept, ok
  or SLOW), `$E2E_OUT/perf.json`, and a markdown table appended to `$GITHUB_STEP_SUMMARY` when set. No screenshots.
  Runtime ≤ 5 min. `README.md`: a `perf.py` and a `make_big.py` entry (what, budgets, env vars).
- Done when: runs here against the current build (before WP1 lands it reports warm boot "n/a") and against the batch
  build; exit codes as in the contract; the handback pastes both tables.

### WP6 — release (sonnet): CI wiring
- Files (owns): `.github/workflows/deploy.yml`.
- Steps: (1) after "Grammar check", a step "Speed check (report)": `python e2e/perf.py` with
  `HUGO_URL: http://localhost:4175/HugoChineseAPP/` and `E2E_OUT: ${{ runner.temp }}/e2e-out` (no `HUGO_XLSX`);
  (2) `actions/upload-artifact@v4` of `${{ runner.temp }}/e2e-out/perf.json` only (`if: always()`, name `perf`,
  14 days): the folder also holds screenshots; (3) e2e `timeout-minutes: 15` → 25; (4) `deploy` job:
  `if: github.ref == 'refs/heads/main'`, so a manual run on a branch checks build, e2e and speed without publishing.
- Done when: the YAML parses (`actionlint` if present); after the batch is pushed, the lead dispatches it on the branch
  once: e2e incl. the speed step runs, deploy is skipped.

### WP7 — ui-dev (sonnet; the lead may do it, ≈ 40 lines), after WP2: Settings
- Files (owns): `src/ui/Settings.tsx`. Needs WP0 and WP2.
- Steps: `Settings.tsx:19` → `useAppPick('settings', 'meta', 'notes')`. In `AboutSection` (below the version row): a row
  "Problems on this device" with the count from `devLogSummary()` (live through `onDevLogChange`); a "Copy diagnostics"
  button (`navigator.clipboard.writeText(await diagnosticsText())`, toast "Diagnostics copied"; on failure open the
  fold below with the text selected and toast "Select the text and copy it"); a fold "Show diagnostics" with the text in
  a `<pre>` (small, wraps, scrolls past ~12 lines; tokens only, light and dark); "Clear" only when the count is > 0.
  Existing `Section`/`Row`/`Cell`/button classes; 44 px targets; no inputs.
- Done when: `tsc`, build; in the preview a thrown test error appears in the count and the copied text (scrubbed).

## Order
```
lead:      P13 (App.tsx, in progress) → WP0 (useAppPick) → commit
parallel:  WP1 · WP2 · WP3 · WP4 · WP5 · WP6        (disjoint files)
after WP2: WP7
then:      qa (opus: src/lib and a stored shape changed) on the whole batch → lead: docs, INDEX, PR against stability-speed-2
```

## Verification for qa
1. **Unit and build**: `npm test` (memo, store `card memo` and `speed`, devlog, golden replay unchanged), `tsc`,
   `npm run build` (chunk list has `qrcode-*.js`; `dist/index.html` modulepreloads don't).
2. **Code review**: every `rebuild()` caller still gets full cards; nothing reads `cardsMemo` except `init()`, and the
   memo never feeds events, marks, sync files or backups; both save paths check `db.isOpen()`; no
   `useApp((s) => s)` left; `sameRow`/`rowSig` contract intact; `scrub()` runs before anything is stored or copied.
3. **e2e** (preview build): `layout.py`, `cards.py`, `grammar.py`, `offline.py`, `explain.py` (`LEXICON_SAMPLE=1`
   build), `sync.py` (passes here; note the shim line), `onedrive.py`, `onedrive_sync.py`, `onedrive_writeback.py` ×3,
   `perf.py` motion off and on: warm boot first row < 800 ms and longest task < 200 ms; cold boot longest task
   < 200 ms; tab switch < 150 ms; back to a tab < 50 ms; 0 empty frames; peek < 50 ms; status apply < 150 ms.
   Report misses even though the script exits 0.
4. **Browser flows** (desktop 1280 and iPhone 13 emulation): import the big workbook, reload twice → Copy diagnostics
   says all cards from cache on the second; answer 3 cards in Cards, reload → Today counts unchanged, about 3 words
   replayed; change Target retention → due counts change as before, next reload cached again; delete `cardsMemo` in
   DevTools, then set it to garbage → both reloads work (full replay); from the console run
   `setTimeout(() => { throw new Error('row of HSK五级 “OneDrive - X” Hugo_chinese_vocab.xlsx hz1.abc') })` (an error
   thrown by console code itself never reaches `window.onerror`) → the copied text shows `HSK…`, `“…”`, `[workbook]`,
   `[secret]`; Settings › Sync › Add another device shows the QR, also offline once the service worker has the chunk.
5. **Data compatibility**: same origin, one browser profile, two builds in turn on port 4173 (`dist-old` = PR #18 head,
   `dist` = this branch): old → new (memo written) → old (works, ignores `cardsMemo` and `devlog`; answer a card) →
   new (only that word replayed; due counts equal a fresh profile with the same workbook and events). A backup made by
   the new build restores in the old one. No sync file format changed (`sync.test.ts` passes untouched).
6. **Hugo** (iPhone Home Screen app, then Edge on the PC): open the app twice; the second start shows the list sooner;
   Settings › About › Copy diagnostics, paste into Notes: no words, file names, account or repository; on the PC,
   Settings › Sync › Add another device still shows the QR code.

## For the lead at the end
- INDEX row: `| 2026-11-26 | [boot-and-guards](2026-11-26-boot-and-guards.md) | <status> (branch stability-speed-3,
  stacked on PR #18) | Start without the full FSRS replay (per-word card memo in kv, cache only), useAppPick for the
  screens, row slots as render functions, qrcode off the boot bundle, sync e2e checks the fake repo + sandbox probe,
  e2e/perf.py speed check in CI (soft budgets), device log + Copy diagnostics | Hugo's iPhone check (§Verification 6);
  B5 and Batch 5 not in scope |`
- decisions.md: **STORE-2** derived cards are memoised per word in kv `cardsMemo`, a device-only cache: reused only
  when the word's fingerprint (kind, studied, seed, its events and marks in the resolved views) and the env (engine
  settings, time zone, app build) match; only full-list derivations (start, `rebuild()`) write it; never synced or backed up; old versions ignore it;
  deleting it costs one replay (this plan D1–D4). **DIAG-1** device log in kv `devlog` (60 entries): uncaught errors and
  store warnings, scrubbed at capture, device-only, Settings › About › Copy diagnostics (D11).
- `src/lib/CLAUDE.md`: map rows for `engine/memo.ts` and `devlog.ts`; gotcha: "`deriveCards` must stay a pure function
  of notes, seeds, events, marks, settings and the time zone: anything new it reads goes into the memo fingerprint or
  env (`memo.test.ts` field and purity guards)".
- `src/ui/CLAUDE.md`: "Screens use `useAppPick(...)` or a narrow `useApp` selector, never `useApp((s) => s)`"; update
  the `QmRow` line: slots are render functions called inside the row.
- `CLAUDE.md` "Cloud session limits": the probe result from WP4 and that `e2e/sandbox.py` shims it; `e2e/README.md`: a
  `sandbox.py` line.
