# Connected saving: Excel in OneDrive, the PC and the iPhone in one loop (2026-11-08)

Roadmap in phases. A builder reads **Decisions** and its own work package. Facts marked *(verify)* are checked on Hugo's
real account by the P1 diagnostics before P3 relies on them. Microsoft's docs can't be opened from the sandbox, so the
lead's November 2026 checks are taken as given.

## Goal
Hugo's workbook in OneDrive becomes the hub:
- Excel edits made anywhere (Excel on the PC, Excel online, Excel for iPhone) reach both app devices.
- A status set on the PC or the phone is written into the workbook by whichever app is open. The PC app doesn't need to
  be open.
- Both devices show the same statuses.
- Reviews, statuses, explanations and settings sync through OneDrive's app folder. "Sign in with Microsoft" becomes the
  only setup step on each device.

| Path | Today | Target |
|---|---|---|
| Excel → app | PC only (File System Access on the synced folder), while the PC app is open | Any open app, through Microsoft Graph |
| App → Excel | PC only, into the `… (app).xlsx` copy | Any open app, into the workbook itself (Q1) |
| App ↔ app | Private GitHub repo (not set up yet) | OneDrive app folder (Q3); GitHub stays as an option |
| Phone | No OneDrive access; edits wait for the PC | Reads and writes the workbook itself |

## Decisions

**D1. OneDrive file APIs, whole-file round trips.**
- The Excel workbook API doesn't exist for personal accounts.
- Reading: the app downloads the .xlsx and imports it as today, in the worker.
- Writing: it patches the downloaded bytes with `patchWorkbookFills`, then replaces the file with
  `PUT /drives/{d}/items/{id}/content` and `If-Match: <eTag>`. The file is about 1.5 MB, so a simple upload is enough.
- Changes are found by polling the item's metadata (about 1 KB). Webhooks are not an option, because they need a server.
- OneDrive version history stays as a safety net.

**D2. Content identity = OneDrive quickXorHash.**
- `src/lib/ms/qxh.ts` (about 40 lines) computes `source.qxh` for every import and upload. It's base64, the same value as
  `file.hashes.quickXorHash`.
- Why:
  - It exists on personal and business drives. sha1Hash is being phased out on personal drives.
  - A device skips the 1.5 MB download when the shared list already has that content.
  - The folder watcher and the Graph reader stop re-importing each other's results. Their `modified` times differ.
- *(verify: the hash in the metadata equals the one computed locally.)*

**D3. One shared import history.** Colour times, seeds and aliases are history, so the devices must share one history
to agree. The shared word list (`vocab.json.gz`) records the workbook content it came from (`source.qxh`, `source.item`).

- A device imports a workbook version only when its list (after pulling) isn't for that content.
- A device never imports a version whose `lastModifiedDateTime` is older than the current list's `source.modified`. That
  would be a cloud copy lagging behind a local save on the PC. "Read now" (`force`) skips this rule.
- The list is marked dirty when its notes hash **or** its `source.qxh` changes, so other devices can skip the download.
- On pull (sync step 1), when both lists carry `qxh`:
  - **Same `qxh`** → `mergeSameVersion`:
    - Per row key, same status → the earliest time. Different status → the remote entry.
    - Seeds per note → the earliest.
    - Aliases → union; the remote wins a key clash.
    - `source.app` → true if either list has it.
    - Everything else comes from the remote.
    - Push only when the merge differs from the remote.
  - **Remote content newer or equal** (by `source.modified`) → take the remote.
  - **Local content newer** → take the remote, then re-import the workbook on top of the shared history. That makes the
    list dirty again.
- Either list without `qxh` (older app versions) → today's `importedAt` rule.

Why the earliest time:
- Two imports of the same content differ only in when a colour was first seen, or in which mark caused an app write. The
  earliest is the truer one.
- The minimum doesn't depend on order and only ever decreases, so every device converges.

**D4. Per-row change times.** Excel gives one `lastModifiedDateTime` per file. The app attributes changes per row by
diffing each imported version against the previous shared list (`colourSinceFor`, called from `prepareImport`). Rules:
1. New row: its colour status (HSK四级 → Mastered) at t = min(version time, import time). With no previous list at all,
   the time is 0 (marks win), as today.
2. The row's colour class is the same as in the previous list → keep the previous entry (status and time). The class is
   `generalColourStatus`: none, green, yellow or other.
3. The class changed → an Excel edit. The status is the class of the new colour, **on every sheet, HSK四级 included**,
   at time t. Exception: when one of this device's write intents (D6) shows this exact change on this row (same class
   before and after), the time is that mark's time.
4. Previous colour unknown (lists from older versions) → today's rule (status equality).

`sheetRows` accepts an HSK四级 entry when its status is Mastered or the class of the row's current colour. Otherwise it
falls back to Mastered with time 0.

Why rule 3 covers HSK四级:
- Today every HSK四级 row is Mastered, so an Excel recolour there is invisible to the app.
- Say Hugo sets Not studied or Not known in the app, then later colours the row green in Excel. The app would write its
  status back over the green, clobbering his Excel edit.
- Rows keep Mastered until their colour class changes, so nothing changes at upgrade.

Why classes and not raw RGB: Excel online may re-save colours slightly differently (theme, tint). A class change is a
real edit.

Ambiguity: the same word may change in Excel and in the app between two checks. The order within that window is unknown.
- Excel wins (time = the version's time).
- Every list change, whether imported here or received through sync, reports the notes whose effective status it
  changed.
- Sheets lists them with **Restore**, which puts the previous statuses back as new marks (time = now). The app then
  writes them to Excel.
- Polling every 2 minutes while the app is open keeps the window small.
- The same notice catches Excel overwriting an app write (a co-authoring conflict).

**D5. Where statuses are written (Q1). Default: into the workbook itself.**
- A copy is safe but one-way:
  - Hugo edits the original, so the copy can't carry his Excel edits.
  - Anything typed into the copy is lost at the next rebuild.
  - Excel on his phone shows app statuses only if he opens the copy.
- Writing the original is what makes "connected" true. Safety nets:
  - `If-Match`: the app never replaces a version it hasn't read.
  - A one-time confirmation per device.
  - A backup of the workbook in the app folder before the first write, then weekly (the newest 4 are kept).
  - OneDrive version history.
  - No writes while an import is held.
  - `WorkbookChangedError`: the app never colours a row that doesn't hold the expected word.
- If Hugo picks the copy: P3 writes `<stem> (app).xlsx` through Graph from any device. It's a stateless rebuild, with no
  intent or confirmation needed. The rest of the plan is unchanged.

**D6. Write-back = stateless projection + write intents.**
- **What to write:** `copyFills(sheetRows(notes, marks, colourSince))`, against the list for the current workbook content.
  - Empty → nothing to write.
  - After a write, the colours express the statuses. Writing is idempotent and safe from any device at any time.
- **Write intents** (kv `excelIntent`, a short list, local to the device).
  - One entry per upload attempt: `{ qxh, at, rows: Explained }`. Each row is `[class before, status written, mark time]`.
  - Saved before the upload.
  - Every import applies the live intents: a row whose class changes exactly as an intent row says gets that mark's
    time (D4 rule 3).
  - An intent is dropped when any of these happens:
    - its upload got an HTTP error response (412, 423, other 4xx/5xx), so it didn't land. A network error or a timeout
      keeps the intent, because the upload may have landed;
    - a sync shows the shared list at this content or newer;
    - this device has no sync and has imported this content or newer;
    - it's 24 h old.
  - Why: the app's own writes must never count as Excel edits. Such an "echo" would beat a newer mark from the other
    device. Intents keep that true even when the upload's answer was lost (iPhone suspended mid-upload), or when a
    re-import runs on top of another device's list. The "class before" check stops an old intent from claiming a later,
    real Excel edit.
- **After the upload:**
  - The writer imports its own patched bytes, in the worker, with the intents. The shared list moves to the new content
    without anyone downloading it.
  - The source is marked `app: true`.
  - The writer syncs straight away, not after the usual 20 s.
- **Stuck rows:** rows the patcher skipped (no columns, row missing) are remembered by signature (kv `excelStuck`). They
  are not retried until the list or the marks change, and the panel shows them.

**D7. Concurrency with Excel and with the other device.**
- **One run** (Web Lock `hz-excel`, per device):
  1. Sync: pull marks and the shared list.
  2. Read the item metadata.
  3. Import if the content is new. Use cached bytes when their qxh matches.
  4. Compute the fills.
  5. Wait checks (below).
  6. Patch, in the worker.
  7. Save the intent.
  8. `PUT` with `If-Match: <eTag from step 2>`.
- **412** (someone saved meanwhile): read again, import, recompute and re-patch. Up to 3 tries, then back off. The upload
  is always built from the latest version, so Hugo's edits are never overwritten.
- **Wait checks:**
  - The current content wasn't written by the app (the list for this qxh lacks `source.app`) and is less than 5 minutes
    old → wait until it's 5 minutes old ("Excel may be open").
  - 423 Locked → wait 2, 4, 8… minutes.
  - On the PC with the folder linked, wait when either of these is true:
    - Excel's owner file exists: try `~$` + name, and `~$` + name minus its first 2 characters.
    - The local file is newer than the cloud version and its qxh differs (local edits not uploaded yet).
  - "Write now" skips the 5-minute wait only. `If-Match` still applies.
- **When a run starts:**
  - 30 s after the last status change.
  - After imports and syncs that leave fills.
  - At start-up.
  - When the app is hidden (best effort).
  - On `online`.
  - A device leaves rows to the device that set them when the winning mark is less than 2 minutes old. This avoids two
    devices uploading the same change.
- **Errors:**
  - 429/503 → `Retry-After`, or `backoffDelay`.
  - 401 → one token refresh, then "Reconnect".
  - Offline → nothing runs, and the count of waiting statuses shows.
- **Budget:** a metadata GET every 2 minutes while visible, plus on focus and `online`; one sync per change burst; one
  upload per 30 s burst. That's far below Graph's limits.
- **iPhone:**
  - JS runs only while the app is open, so writes happen while it's open.
  - The hide-flush may be cut short. The intent makes the next run safe.
  - Patching the 11.6 MB sheet runs in the worker. P3 measures it on the iPhone (target: under 5 s).

**D8. Microsoft sign-in with a small PKCE client, not MSAL.**
- **Settings:**
  - Authority `https://login.microsoftonline.com/consumers`.
  - Scopes `openid profile offline_access User.Read Files.ReadWrite` (Q4).
  - SPA redirect URI = the app's start URL, with `response_mode=query`. The hash router keeps `#/…`. The route travels
    in `state` and is restored before the first render.
- **Storage and traffic:**
  - The PKCE state goes in kv `msPkce`. IndexedDB survives the out-of-app navigation better than sessionStorage.
  - Tokens go in kv `msAuth`, on the device only. They are never synced, never in backups, and wiped by "Reset this
    device".
  - Tokens are sent only to login.microsoftonline.com and graph.microsoft.com. Download URLs carry their own auth, so
    they get no `Authorization` header.
- **The 24-hour limit:** Microsoft caps refresh tokens of browser-only apps at 24 h from sign-in.
  - At start-up, a silent renewal runs when all of these hold:
    - the device is online;
    - the refresh token is more than 20 h old;
    - there was no try in the last 6 h (kv `msAutoAt`);
    - a 3 s reachability check of the authority succeeds.
  - The renewal is a top-level redirect with `prompt=none`. With a live Microsoft session it comes straight back (a short
    flash). Otherwise it comes back with an error, and a "Reconnect to Microsoft" banner waits for a tap.
  - No popups: on iOS they open outside the Home Screen app. No hidden iframes: Safari blocks them; they're an option on
    the PC in P4.
- **Why not MSAL:**
  - It's a large dependency, built around popups, iframes and account types we don't use.
  - Its redirect handling would have to be bent around our hash router.
  - Our flow is about 200 lines, tested with the same fetch stubs as sync.

**D9. App data in OneDrive's app folder (Q3).**
- `special/approot` (= `OneDrive/Apps/Hugo Chinese/`) works on personal accounts with `Files.ReadWrite` *(verify)*.
- **Files:**
  - Same files and encodings as the GitHub repo.
  - Flat names in `data/`: `events/<dev>/<m>.json` ↔ `events.<dev>.<m>.json`, the same for `marks` and `explain`, then
    `devices.<dev>.json`, `vocab.json.gz` and `settings.json`. Device ids never contain dots.
  - Each device writes only its own files.
  - Writes use `If-Match`, or "must not exist" for new files. Conflicts retry once, as today.
- **Engine:** `sync.ts` runs against a `SyncStore` interface (GitHub or OneDrive), with one target per device. GitHub
  stays for devices that use it, and for the no-Microsoft path.
- **Why:** one sign-in replaces the repo, the token and the QR key, and the data stays in Hugo's OneDrive with its
  versions. **Cost:** when the Microsoft session lapses, app sync also waits for Reconnect. GitHub tokens last longer.
- **Migration** (only for a device that already syncs with GitHub; Hugo hasn't set it up):
  1. A final GitHub sync.
  2. The target becomes OneDrive.
  3. All of the device's own months, its settings and the list are marked dirty.
  4. The device keeps pulling GitHub read-only until Hugo turns it off, or until every device seen in GitHub has written
     to OneDrive.

  Older versions keep using GitHub in the meantime, and the migrated device still reads them, so nothing is lost.
- **Version check:** `devices/<id>.json` gains `caps: 2` and `app`, rewritten when they change. Before the first write to
  Excel, the app warns when another device last reported older caps.

**D10. The folder link (File System Access) stays, in a smaller role.**
- It's the no-Microsoft fallback (read + copy), unchanged.
- On the PC it's also a local signal:
  - fresh local saves, imported at once (same qxh rule);
  - the `~$` owner file;
  - unsynced local edits.
- It never writes the original, because it can't use `If-Match`.
- When the workbook is linked through Microsoft and Q1 = original, the copy writer stops.

**D11. Storage: no Dexie version bump.** Only new things are added:
- **kv keys:** `msPkce`, `msAuth`, `msAutoAt`, `odWorkbook`, `excelIntent`, `excelCache` {qxh, bytes}, `excelStuck`,
  `excelBackupAt`, `excelConfirmed`, `excelLastUpload`, `syncTarget`, `syncTags`.
- **Optional fields:** `VocabFile.source.qxh/drive/item/app` and `RowFill.key/status/t`.
- `VocabFile.version` stays 1.
- Older versions ignore the new fields. Their imports have no `qxh`, so they fall back to today's rules (D3).

**D12. Business account fallback.** The same design works with authority `organizations` and CSP
`https://*.sharepoint.com`. Differences:
- The tenant may require admin consent.
- Files open in desktop Excel are locked (423, already handled).
- SharePoint may rewrite properties on upload. The cache then misses and the app downloads again. Intents apply by row
  transition, not by hash, so they still work.
- The workbook API exists there (cell writes merge with co-authoring), but it isn't planned.

**D13. Fallback without Microsoft sign-in.** Today's design stays:
- The PC reads the folder and writes the copy.
- GitHub syncs the devices.
- The phone imports the file from Files › OneDrive by hand.
- Excel ↔ app then needs the PC app open.

## Questions for Hugo
1. **Where should the app write your statuses: into your workbook itself, or into the separate "(app)" copy as now?**
   - Workbook: Excel everywhere shows your statuses, and your Excel edits flow back.
   - Copy: your original is never touched, but the copy is one-way. Anything you change in it is lost, and Excel shows
     the app's statuses only in the copy.

   Default: **the workbook**. A backup goes to OneDrive › Apps › Hugo Chinese › backups before the first write and then
   weekly, on top of OneDrive's version history.
2. **Is your Microsoft account a personal one (OneDrive opens at onedrive.live.com)? And are these OK with you?**
   - A one-time app registration, about 10 minutes, steps below. Microsoft now asks a personal account to create a free
     Azure account first: phone number and card for an identity check, nothing charged.
   - Signing in once on the PC and once in the iPhone Home Screen app.
   - A short automatic Microsoft redirect about once a day when you open the app. Web apps without a server get 24-hour
     sign-ins.

   Default: **yes, personal**. If not, see D12/D13.
3. **Should reviews, statuses, explanations and settings sync through your OneDrive (a private folder, Apps/Hugo Chinese)
   instead of a GitHub repository?** Then signing in with Microsoft is the whole setup. GitHub stays available.
   Default: **OneDrive**.
4. **May the app access your whole OneDrive, or only its own folder?**
   - Whole OneDrive: the file stays where it is.
   - Own folder only: you move Hugo_chinese_vocab.xlsx once into OneDrive › Apps › Hugo Chinese, and the app asks only
     for `Files.ReadWrite.AppFolder`.

   Default: **whole OneDrive** (`Files.ReadWrite`).

## Phases

| Phase | Delivers | Hugo does | Main risks |
|---|---|---|---|
| **P0** Decisions + registration | Answers, client id | Answers Q1–Q4. Checks the account type. Registers the app (steps below) and sends the Application (client) ID | A personal account needs a directory (free Azure account with card) → fallback D13 |
| **P1** Sign-in + read | Both devices read the workbook from OneDrive. Merge rules (pure). Diagnostics. "Excel changed N statuses" notice | Signs in on the PC (Edge) and in the iPhone Home Screen app. Runs Settings › More › Microsoft diagnostics and sends the report. Changes a colour in Excel online and checks the phone | The iOS redirect must come back into the Home Screen app (go/no-go). CSP hosts |
| **P2** App data in OneDrive | Sync through the app folder. Shared import history. GitHub migration path | Nothing: it starts after sign-in. If a GitHub link exists, taps "Move sync to OneDrive" | Older versions during the switch (D9) |
| **P3** Write statuses back | Any open app writes statuses into the workbook safely | Confirms the first write. Does the co-authoring checks (verification) and says what Excel showed | Excel co-authoring conflicts. iPhone patch time and memory |
| **P4** Cleanup + options | Microsoft-first setup. Optional extras | Decides whether to delete the old "(app)" copy and the progress file | — |

P2 comes before P3 because a safe write-back needs the other device's marks and the shared history (D3, D6). Without
them, two devices changing the same word can end on the older change. WP6 (P2) shares no files with P1 and can start
early.

### P0: app registration steps for Hugo
1. Open https://entra.microsoft.com and sign in with the Microsoft account that holds your OneDrive.
2. If it says applications can't be created outside a directory, or there's no "App registrations" menu:
   - Create a free Azure account at https://azure.microsoft.com/free with the same Microsoft account. It asks for a phone
     number and a card for an identity check. Nothing is charged unless you upgrade, and nothing runs in Azure.
   - This creates a "Default Directory", which stays even when the free trial ends.
   - Then go back to step 1.
3. Open Identity › Applications › App registrations › New registration. In portal.azure.com it's Microsoft Entra ID ›
   App registrations.
4. Fill in the form:
   - Name: **Hugo Chinese**. This becomes the folder name OneDrive › Apps › Hugo Chinese.
   - Supported account types: **Personal Microsoft accounts only**. For a work account, choose "Accounts in this
     organizational directory only" and say so.
   - Redirect URI: **Single-page application (SPA)**, `https://hugzgj9.github.io/HugoChineseAPP/`.
   - Click **Register**.
5. Open Authentication › Single-page application:
   - Click **Add URI** and enter `http://localhost:4173/HugoChineseAPP/`.
   - Leave both implicit-grant boxes (Access tokens, ID tokens) unticked.
   - Click **Save**.
6. Open API permissions › **Add a permission** › Microsoft Graph › Delegated permissions:
   - Add **Files.ReadWrite** (or **Files.ReadWrite.AppFolder** if Q4 = own folder) and **offline_access**.
   - User.Read is already there.
   - No "Grant admin consent" step and no client secret are needed.
7. On Overview, copy the **Application (client) ID** and send it. It isn't a secret: the lead commits it to
   `src/lib/ms/config.ts`, like any web app's client id.

If the screens differ (Microsoft changes them often), send a screenshot of where you are stuck, without personal data.

## Work packages

### P1: Microsoft sign-in, diagnostics, reading the workbook

**WP0 (lead, first, about 60 lines): types and empty state slots.** Files: `src/lib/types.ts`, `src/lib/store.ts`.
```ts
// types.ts
export interface WorkbookSource {
  name: string; modified: number; size: number;
  /** OneDrive quickXorHash of the file bytes (base64). */ qxh?: string;
  /** OneDrive drive and item id of the workbook. */ drive?: string; item?: string;
  /** This content was written by the app (write-back). */ app?: boolean;
}
// VocabFile.source: WorkbookSource            (was an inline { name; modified; size })
// RowFill gains: key?: string; status?: WordStatus; t?: number   (rowKey, status written, winning mark's time)
/** rowKey → [class before, status the app wrote, time of the mark it came from]. */
export type Explained = Record<string, [WordStatus, WordStatus, number]>;
/** An effective status that a new word list changed (an Excel edit), for the notice in Sheets. */
export interface StatusChange { note: string; hanzi: string; from: WordStatus; to: WordStatus }
// store.ts: fields and setters only
export interface MsInfo { state: 'off' | 'ok' | 'reconnect' | 'error'; account?: string; message?: string }
export interface ExcelInfo { state: 'off' | 'ok' | 'missing' | 'error'; name?: string; path?: string; checked?: number;
  written?: number; pending?: number; waiting?: string; waitUntil?: number; stuck?: number; writeError?: string; message?: string;
  /** How long the last patch took (ms), to check the iPhone. */ patchMs?: number }
// AppState gains: ms: MsInfo; excel: ExcelInfo; excelChanges?: StatusChange[]
export function setMs(p: Partial<MsInfo>, replace?: boolean): void;
export function setExcel(p: Partial<ExcelInfo>, replace?: boolean): void;
export function clearExcelChanges(): void;
```

**WP1 (engineer, opus): Microsoft auth, Graph client, quickXorHash, diagnostics, fake drive.**

Files:
- `src/lib/ms/config.ts`, `auth.ts`, `graph.ts`, `qxh.ts`, `diagnostics.ts`.
- `fake.ts` (test helper).
- Tests: `auth.test.ts`, `graph.test.ts`, `qxh.test.ts`.

Interfaces:
```ts
// config.ts
export const MS_CLIENT_ID: string;            // '' until Hugo sends it → msConfigured() false, Microsoft UI hidden
export const MS_AUTHORITY = 'https://login.microsoftonline.com/consumers';
export const MS_SCOPES: string[];             // openid profile offline_access User.Read Files.ReadWrite
// auth.ts
export interface AuthResponse { code?: string; state: string; error?: string; errorDescription?: string }
export class MsAuthError extends Error { needsSignIn: boolean }
export function msConfigured(): boolean;
export function takeAuthResponse(): AuthResponse | null;            // sync, before render: strips ?code/state/error, restores the #route carried in state
export async function completeSignIn(r: AuthResponse): Promise<void>; // checks the state nonce against kv msPkce, PKCE exchange → kv msAuth, setMs
export async function msSignIn(opts?: { silent?: boolean }): Promise<never>; // saves kv msPkce, top-level redirect; silent → prompt=none
export async function msSignOut(): Promise<void>;                   // forgets tokens (no Microsoft sign-out page)
export async function msToken(): Promise<string>;                   // cached → refresh (Web Lock 'hz-ms-token') → MsAuthError
export async function shouldRenewAtStart(now: number): Promise<boolean>;
// graph.ts
export interface DriveItem { id: string; name: string; eTag: string; cTag: string; size: number; lastModifiedDateTime: string;
  parentReference?: { driveId?: string; id?: string; path?: string }; file?: { hashes?: { quickXorHash?: string } };
  '@microsoft.graph.downloadUrl'?: string }
export class GraphError extends Error { status: number; code: string; retryAfter?: number;
  readonly conflict: boolean /* 409, 412 */; readonly locked: boolean /* 423 */; readonly auth: boolean /* 401 after a refresh */ }
export async function graphFetch(path: string, init?: RequestInit): Promise<Response>; // token, 2 min timeout, no-store, GraphError
export async function getItem(drive: string, id: string): Promise<DriveItem>;
export async function findByName(name: string): Promise<DriveItem[]>;   // search; exact name (case-insensitive), files only
export async function download(item: DriveItem): Promise<Uint8Array>;    // via downloadUrl, never with an Authorization header
export async function uploadReplace(drive: string, id: string, bytes: Uint8Array, ifMatch: string): Promise<DriveItem>;
// qxh.ts
export function quickXorHash(bytes: Uint8Array): string;   // base64, as OneDrive reports it
// diagnostics.ts
export async function runDiagnostics(): Promise<string>;   // plain text; no names, emails or paths
```

Steps:
1. **`qxh.ts`:** port rclone's Go `backend/onedrive/quickxorhash` (MIT, readable with `gh api`) together with its test
   vectors. The empty input gives `AAAAAAAAAAAAAAAAAAAAAAAAAAA=`.
2. **`auth.ts`:**
   - S256 PKCE via `crypto.subtle`. Before redirecting, save `{verifier, nonce, silent}` in kv `msPkce`.
   - `state` = nonce + `.` + base64url(route). `takeAuthResponse` can then put the route back synchronously, before the
     router renders (`history.replaceState` to BASE + route); `completeSignIn` checks the nonce.
   - Token request: a form-encoded POST. Take the name, `preferred_username` and `oid` from the id_token payload.
   - `refreshExp` = sign-in time + 24 h. Refreshes **don't** extend it.
   - `invalid_grant` or `interaction_required` → `ms.state = 'reconnect'`.
   - A silent try that comes back with an error only sets `reconnect`.
   - `shouldRenewAtStart` covers the 6 h guard and the 3 s reachability check (D8).
   - Map the common AADSTS codes to short English messages.
3. **`graph.ts`:**
   - Base URL `https://graph.microsoft.com/v1.0`.
   - 401 → refresh once and retry.
   - Map error bodies (`error.code`, `Retry-After`) to `GraphError`. A network error → status 0, "OneDrive could not be
     reached".
   - `download` reads the metadata including `@microsoft.graph.downloadUrl`, then fetches that URL with no credentials.
4. **`diagnostics.ts`** (run from Settings › More only). It touches only `approot/diag/`:
   - `/me/drive` driveType.
   - Upload a 3 KB file and compare the quickXorHash in its metadata with `quickXorHash()`.
   - A stale `If-Match` PUT → expect 412.
   - The download-URL host, and whether fetching it worked or CSP blocked it.
   - Whether the linked workbook's metadata has hashes.
   - Delete the test file.
5. **`fake.ts`:** an in-memory drive plus a token endpoint, served as a `fetch` stub like the fake GitHub in
   `sync.test.ts`.
   - Each item carries eTag/cTag counters and its quickXorHash.
   - It supports search, metadata, the download host, and PUT with If-Match (412).
   - Controls: `lock(id)` (423), `failNext(status, retryAfter)`, `excelSave(id, bytes, at)`, `expireRefresh()`.

Tests:
- PKCE: the challenge is right, and a state mismatch is rejected.
- Code exchange stores the tokens. Refresh works. Expiry → `needsSignIn` and the reconnect state.
- `shouldRenewAtStart` timing and its guards.
- Graph:
  - the If-Match header is sent;
  - 412 → `conflict`, 423 → `locked`, 429 → `retryAfter`;
  - 401 → one refresh, then a retry;
  - `download` never sends Authorization to the download host.
- qxh vectors.

Done when: `npm test` and `tsc` pass, with no new npm dependency.

**WP2 (engineer, opus): OneDrive workbook reader, content identity, notices, boot.**

Files: `src/lib/workbook.ts` (new) + `workbook.test.ts`, `src/lib/store.ts` (logic after WP0), `src/lib/sources.ts`,
`src/lib/folder.ts`, `src/main.tsx`.

Interfaces:
```ts
// store.ts
export async function setVocab(vf: VocabFile, exactSeeds?: boolean): Promise<StatusChange[]>;   // also appended to excelChanges
// sources.ts
export async function importBytes(bytes: ArrayBuffer, source: WorkbookSource, opts?: { explained?: Explained }): Promise<ImportOutcome>;
// ImportOutcome gains: changes?: StatusChange[]
export function isOlderThanList(source: WorkbookSource): boolean;
// workbook.ts
export interface OdWorkbook { drive: string; item: string; name: string; path?: string; linkedAt: number }   // kv odWorkbook
export async function findWorkbooks(): Promise<DriveItem[]>;
export async function linkWorkbook(item: DriveItem): Promise<void>;
export async function unlinkWorkbook(): Promise<void>;
export async function checkWorkbook(force?: boolean): Promise<void>;
export async function startWorkbook(): Promise<void>;
```

Steps:
1. **`store.setVocab`:** for every list change (import or sync, when a previous list exists), compare `noteStatuses`
   before and after for the notes present both times. Append the differences to `excelChanges`.
2. **`sources.ts`:**
   - Fill `source.qxh` when the caller didn't: folder, Graph, and a file picked by hand.
   - Serialize `importBytes` calls with a promise chain.
   - Dirty on a hash **or** qxh change.
   - Pass `explained` to `prepareImport`.
   - Return the changes in the outcome, for the toast.
3. **`workbook.ts`, linking:**
   - Use `meta.source.drive/item` when that item exists.
   - Otherwise `findByName(settings.fileName)`: exactly one match → link it; several → the UI picker.
   - Exclude `(app)` copies and conflict copies (`name-<PC>.xlsx`).
   - With Q4 = own folder: link by path `special/approot:/<fileName>` instead of searching.
4. **`workbook.ts`, checking:**
   - Read the metadata.
     - 404 → `missing`, then relink by name when there is exactly one match.
     - Same qxh as the list → `ok`.
     - `isOlderThanList` without `force` → skip.
   - If sync is linked and hasn't run since the item's `lastModifiedDateTime`, sync first: another device may already have
     imported this content.
   - Otherwise download, and keep the bytes in `excelCache`.
   - `importBytes` with the source `{name, modified: Date.parse(lastModifiedDateTime), size, qxh, drive, item}`.
   - Toast as `checkFolder` does. A held import shows today's notice.
   - Single-flight. Does nothing offline or when `ms.state !== 'ok'`.
   - Triggers: start, focus, visible, every 2 minutes while visible, `online`.
5. **`folder.ts`:**
   - Compute the local file's qxh only when name, modified or size differ from a cached stat. Equal to
     `meta.source.qxh` → no import.
   - `writeCopy`'s "same file" check uses qxh equality, falling back to today's check when the list has no qxh.
6. **`main.tsx`, in order:**
   1. `startPwa()`.
   2. `const auth = takeAuthResponse()`.
   3. Render.
   4. `init()`.
   5. `if (auth) await completeSignIn(auth)`.
   6. `if (await shouldRenewAtStart(Date.now())) return void msSignIn({ silent: true })`.
   7. `startFolder()`, `startWorkbook()`, `startSync()`, warm-up.

Tests: stub `./ms/graph` with `vi.mock`. Add one integration test on `fake.ts` once WP1 is merged.
- Auto-link from `source.item`. One match links; several don't.
- 404 → `missing`.
- Same qxh → no download.
- New content → import with qxh/drive/item in the source.
- An older version is skipped unless `force`.
- Offline → no request.
- `setVocab` from sync reports changed statuses; the first import reports none.
- A qxh-only change marks the list dirty.
- Imports are serialized.
- Folder: same qxh → no re-import. The copy is still written when the list came from Graph (different `modified`).

Done when:
- A device without a folder link imports a workbook "saved by Excel" in the fake, shows the toast and the notice.
- The folder and Graph readers never re-import each other's results.
- Existing tests pass.

**WP3 (engineer, opus): merge rules, pure. Runs in parallel; needed before P3.**

Files: `src/lib/status.ts`, `src/lib/import/guard.ts`, `src/lib/status.test.ts`, `src/lib/import/guard.test.ts`.

Interfaces:
```ts
export function colourSinceFor(notes: Note[], prev: Pick<VocabFile, 'notes' | 'colourSince'> | null,
  renames: Record<string, string>, t: number, explained?: Explained): NonNullable<VocabFile['colourSince']>;
export function prepareImport(prev: VocabFile | null, next: VocabFile, explained?: Explained): PreparedImport;
export function copyFills(rows: Map<string, SheetRow[]>): RowFill[];   // also sets key, status, t; selects the same rows as today
```

Steps:
- Implement D4 rules 1–4. A row's previous colour is the previous list's note (through renames), same k-th ref in that
  sheet.
- In `sheetRows`, add the HSK四级 acceptance rule.
- In `copyFills`, set the new fields.

Tests (table-driven):
- Same class keeps its time (green → another green). A class change gets t.
- HSK四级:
  - App sets Not studied, then Hugo greens the row in Excel → Excel wins, and `copyFills` is empty (no clobber).
  - App writes yellow with `explained` → `[notknown, markT]`. The mark ties, and `copyFills` is empty.
- `explained` is ignored when the class before or after doesn't match.
- Echo: PC M1 (mastered, t1), phone M2 (notknown, t2 > t1). The PC uploads green at t3 with
  `explained {R: [new, mastered, t1]}` → Not known, and `copyFills` asks for yellow.
- Stale intent: the row went green → yellow (Excel) → green (Excel). The old `[new, mastered, t1]` intent doesn't apply,
  because the class before is yellow.
- A mark inside the window loses to an Excel class change.
- A legacy previous list without ref colours → status equality.
- Golden: the `make_sample` workbook re-imported over itself keeps every status.

Done when: every existing status/guard test passes unchanged, and the new ones pass.

**WP4 (ui-dev, sonnet): Microsoft panel, reconnect banner, "Excel changed" notice.**

Files: `src/ui/Microsoft.tsx` (new), `src/ui/Setup.tsx`, `src/ui/Settings.tsx`, `src/ui/App.tsx`, `src/ui/Sheets.tsx`,
`src/styles.css`.

Steps:
1. **`MicrosoftPanel`** (hidden when `!msConfigured()`):
   - **Off:** a "Sign in with Microsoft" button. Text: "Reads Hugo_chinese_vocab.xlsx from your OneDrive. Sign in once on
     each device; on iPhone, in the Home Screen app."
   - **On:**
     - The account, and the workbook line ("Hugo_chinese_vocab.xlsx, read 2 min ago").
     - Buttons: Read now, Change workbook, Sign out.
     - A picker (folder and modified date) when several files match.
     - Notices for missing or error.
2. **Settings › More › "Microsoft diagnostics":** runs `runDiagnostics()`. The report goes in a read-only 16 px textarea
   with Copy.
3. **`App.tsx` › `ReconnectBanner`:** like UpdateBanner, with the top safe area. Text: "Microsoft sign-in expired.
   Excel and sync are waiting. [Reconnect]".
4. **`Setup.tsx`:**
   - `SetupSources`: when Microsoft is configured, its panel comes first on both devices, and today's panels fold under
     "Other ways".
   - `SourceSettings`: shows the OneDrive workbook status when it's linked. The folder link folds under "Without
     Microsoft".
5. **`Sheets.tsx` › `ExcelChangesNotice`** above the list:
   - Text: "Excel changed 3 statuses: 学习 Mastered → Not known, …", collapsed after 5 items.
   - Buttons: [Restore] and [OK].
   - Restore calls `setNoteStatus(note, STATUS_MARK[from])` for each note, then `clearExcelChanges()`.

Done when:
- The flows work against the e2e fake.
- Desktop and iPhone 13 screenshots show no sideways scroll, 44 px targets and 16 px inputs.
- All copy is in English.

**WP5 (release, sonnet): CSP, e2e fake Microsoft, CI.**

Files: `index.html`, `e2e/fake_graph.py` (new), `e2e/onedrive.py` (new), `e2e/README.md`, `.github/workflows/deploy.yml`.

Steps:
1. **CSP and service worker:**
   - Add to `connect-src`:
     `https://login.microsoftonline.com https://graph.microsoft.com https://*.microsoftpersonalcontent.com https://*.1drv.com`.
     The lead trims this to the hosts the diagnostics report.
   - No `frame-src`.
   - Check that the service worker answers the return navigation `/HugoChineseAPP/?code=…&state=…` with index.html
     (navigateFallback).
2. **`fake_graph.py`:** Playwright `route` handlers.
   - **Auth:**
     - authorize → 302 back with `code` and `state`, or with `error=login_required` for `prompt=none` while the fake
       session is off;
     - token → code and refresh grants, with configurable expiry.
   - **Graph:**
     - `/me`, `/me/drive`, search;
     - item metadata: eTag, cTag, quickXorHash (Python port), and a downloadUrl on a fake
       `*.microsoftpersonalcontent.com` host;
     - PUT with If-Match (412), lock (423), throttle (429).
   - **Everything else** under Microsoft domains → `route.abort()`.
3. **`onedrive.py`**, with a "pc" context and a "phone" context (iPhone 13, no `showDirectoryPicker`):
   - Both sign in, link by search and show the words.
   - openpyxl recolours a row (new eTag). After focus or a poll, both show the new status and the notice; Restore works.
   - The refresh token expires → the banner shows → Reconnect.
   - Offline → no errors.
4. **Workflow and docs:** run `onedrive.py` after `sync.py`. In `e2e/README.md`, describe the fake (no real credentials;
   never `playwright install` in cloud sessions).

Done when: CI is green, with no unrouted Microsoft request.

### P2: app data in OneDrive

**WP6 (engineer, opus): SyncStore, OneDrive app folder store, shared import history, migration.** Starts once WP1 is
merged.

Files:
- New: `src/lib/syncstore.ts`, `src/lib/ms/appfolder.ts`, `src/lib/import/canonical.ts` + `canonical.test.ts`.
- Changed: `src/lib/sync.ts`, `src/lib/sync.test.ts`, `src/lib/github.ts` (error mapping only), `src/lib/ms/fake.ts`
  (app folder).

Interfaces:
```ts
// syncstore.ts
export interface SyncStore {
  kind: 'github' | 'onedrive'; label: string;
  list(): Promise<Map<string, string>>;                          // logical path → version tag (blob sha | eTag)
  read(path: string, tag: string): Promise<Uint8Array>;
  write(path: string, bytes: Uint8Array, prevTag: string | undefined, message: string): Promise<string>; // new tag
}
export class StoreError extends Error { status: number; retryAfter?: number; conflict: boolean; auth: boolean }
export function githubStore(link: SyncLink): SyncStore;
export function onedriveStore(): SyncStore;                       // approot/data, flat names
export function toOdName(path: string): string; export function fromOdName(name: string): string | null;
// appfolder.ts
export async function afList(dir: 'data' | 'backups'): Promise<DriveItem[]>;   // paged (@odata.nextLink)
export async function afRead(item: DriveItem): Promise<Uint8Array>;
export async function afWrite(dir: 'data' | 'backups', name: string, bytes: Uint8Array, ifMatch: string | null): Promise<DriveItem>;
export async function afDelete(item: DriveItem): Promise<void>;
// canonical.ts
export function mergeSameVersion(local: VocabFile, remote: VocabFile): VocabFile;
export function vocabAction(local: VocabFile | null, localDirty: boolean, remote: VocabFile): 'take' | 'merge' | 'keep' | 'take-reimport';
// sync.ts
export type SyncTarget = 'github' | 'onedrive';                    // kv syncTarget; absent with a syncLink = github
export async function linkOneDrive(): Promise<void>;
export function onRebase(f: () => Promise<void>): void;           // re-import hook (avoids an import cycle)
export function onSharedList(f: (shared: VocabMeta) => void): void; // the shared list is known to be at least this one
export async function knownDevices(): Promise<{ id: string; caps: number; app?: string; seen?: number }[]>;
```

Steps:
1. **Store interface:** move `pullAndPush` onto `SyncStore`. The GitHub store wraps `github.ts`, and its behaviour stays
   identical: existing sync tests pass unchanged.
2. **OneDrive store:**
   - Creates `data/` on first use.
   - Writes go to `PUT …/approot:/data/<name>:/content`, with `If-Match` or with
     `@microsoft.graph.conflictBehavior=fail`.
   - 409/412 → `conflict`.
   - Auth errors set the sync state to error, "Reconnect to Microsoft", without making the back-off grow.
3. **Known tags per store:** `syncShas` (GitHub, unchanged) and `syncTags` (OneDrive).
4. **Shared list:** sync step 1 uses `vocabAction` (D3). `take-reimport` takes the remote, then calls `onRebase`.
5. **Shared-list hook:** `onSharedList` is called after a pull that read the remote list, and after a successful push of
   the local list. WP9 uses it to drop covered write intents (D6).
6. **`linkOneDrive()`:**
   - Runs the same device-id collision checks as `linkRepo`.
   - Writes `devices.<id>.json` with `caps`, `app` and `agent`.
   - Runs a first sync.
   - Rewrites the device file when `caps` or `app` change. `knownDevices()` feeds the UI.
7. **Migration and read-only GitHub pull,** as in D9: `pullAndPush(store, report, { push: false })`.
8. **Lead wiring in `main.tsx` when integrating:**
   - `onRebase(() => checkWorkbook(true))`, or `checkFolder(true)` for lists without `item`.
   - `linkOneDrive()` after `completeSignIn` when the device has no target (the Q3 default).

Tests:
- `sync.test.ts` runs, parametrized, over both fake stores.
- `toOdName`/`fromOdName` round-trip.
- 412 and 409 → one retry.
- `mergeSameVersion`: earliest times, the remote status on a clash, earliest seeds, alias union, `source.app` kept.
  Idempotent, and the times don't depend on the order.
- `vocabAction` matrix: with and without qxh; older, newer and equal versions.
- Migration:
  1. Two devices sync with GitHub, and A moves to OneDrive.
  2. B (old version) writes to GitHub → A reads it with the read-only pull.
  3. B moves → A sees B's files in OneDrive.
  4. The read-only pull never writes to GitHub.
- Auth error → reconnect state, and the back-off doesn't grow.

Done when: a two-device test syncs marks, events, explanations, settings and the list through the fake app folder, as
it does through GitHub.

**WP7 (ui-dev, sonnet): OneDrive sync UI.** Runs after WP4 (same files).

Files: `src/ui/Setup.tsx`, `src/ui/Microsoft.tsx`.

Steps:
- **`SyncSettings`:**
  - When the target is OneDrive: "Synced through OneDrive (Apps/Hugo Chinese) 2 min ago".
  - GitHub folds under "Other ways".
  - When a GitHub link exists and Microsoft is signed in: "Move sync to OneDrive". Once every device has moved: "Stop
    reading GitHub".
- **Device list** from `knownDevices`, with "Older version: open the app on that device to update it".

Done when: the e2e flows pass and the copy has been reviewed.

**WP8 (release, sonnet): e2e sync through the fake app folder.**

Files: `e2e/fake_graph.py`, `e2e/onedrive.py`, `e2e/README.md`.

Steps:
- Add the app folder routes: children with paging, PUT with If-Match/conflictBehavior, delete.
- Scenario, mirroring `sync.py`:
  1. The PC and the phone sign in.
  2. The phone studies and sets statuses.
  3. The PC sees the phone's reviews and statuses.
  4. A language change syncs.

Done when: CI is green.

### P3: writing statuses into the workbook

**WP9 (engineer, opus): write-back.**

Files:
- New: `src/lib/xlsx/patchClient.ts` (`patchInWorker` moved out of `folder.ts`).
- Changed: `src/lib/workbook.ts`, `src/lib/folder.ts`, `src/lib/ms/appfolder.ts`, `src/lib/db.ts` (`DEVICE_PREFS` +=
  `'excel.write'`, default on = write automatically), `src/lib/workbook.test.ts`.

Interfaces:
```ts
// workbook.ts
export const WRITE_TARGET: 'original' | 'copy';                    // from Q1
export async function writeBack(opts?: { force?: boolean }): Promise<void>;
export function pendingFills(): RowFill[];
export async function confirmFirstWrite(): Promise<void>;          // kv excelConfirmed[item] = now, then writeBack()
// folder.ts (PC only)
export async function folderSignals(): Promise<{ excelOpen: boolean; localNewer: boolean } | null>;
// appfolder.ts
export async function backupWorkbook(bytes: Uint8Array, name: string, now: number): Promise<void>; // backups/, keeps the newest 4
```

Steps:
1. **Run order and wait checks** as in D7. Each stop sets `excel.pending` and `excel.waiting`/`waitUntil`. The run also
   stops for:
   - no confirmation yet on this device (`waiting = 'confirm'`);
   - `excel.write` off, unless `force`;
   - an import that's held;
   - missing columns → one forced re-import;
   - the stuck signature.
2. **Bytes and backup:**
   - Use `excelCache` bytes when their qxh matches the item; otherwise download.
   - Back up the pre-patch bytes when `excelBackupAt` is unset or more than 7 days old.
3. **Upload:**
   - Save the intent `{qxh of the patched bytes, at, rows}` (rows from the fills: `[class of from, status, t]`).
   - `uploadReplace(… If-Match)`.
   - On an HTTP error response, drop that intent:
     - 412 → back to step 1 (3 tries);
     - 423 → waiting, with back-off;
     - any other HTTP error → `writeError` and back-off.
   - On a network error or a timeout, **keep** the intent (the upload may have landed), then back off.
4. **After a successful upload:**
   - Cache the patched bytes, and save `excelLastUpload` {cTag, eTag, qxh, at}.
   - Import the patched bytes with the live intents and the new item's tags, `app: true`.
   - `syncNow()`.
   - Set `excel.written` and `excel.patchMs`, and clear the stuck signature.
5. **Intents:**
   - Register `onSharedList`, and drop the intents the shared list covers. Covered means either:
     - its `source.qxh` equals the intent's `qxh`; or
     - its `source.modified` is later than the upload's server time (`lastModifiedDateTime` from the PUT answer, added to
       the intent).
   - When the answer was lost, only the qxh test applies.
   - Without sync, drop an intent once this device has imported that content or a later version.
   - Drop any intent older than 24 h.
6. **Triggers:**
   - `subscribe` to marks/meta changes → 30 s debounce.
   - Hidden → flush.
   - Start-up and `online`.
   - After imports and syncs, when `pendingFills()` isn't empty.
7. **`folder.ts`:**
   - Import `patchInWorker` from `patchClient.ts`.
   - Turn the copy writer off when `odWorkbook` is linked and `WRITE_TARGET === 'original'`.
   - Add `folderSignals()`: the `~$` owner file; the local file newer than the list's source with a different qxh.
8. **If Q1 = copy:**
   - Write `<stem> (app).xlsx` in the original's folder: `PUT …/items/{parent}:/{copy}:/content`, with `If-Match` on the
     copy when it exists.
   - No intent, no confirmation.

Tests: fake drive, two devices run one after the other, never one inside another (`navigator.locks`).
- The phone sets a status → the fake workbook has the fill (re-import the fake's bytes and read the row colour). The
  shared list has the upload's qxh, `app: true`, and the row time = the mark time.
- 412: "Excel" saves another row between the metadata read and the PUT → both changes are in the file.
- An Excel edit newer than a mark on the same row → no write, and the status is Excel's.
- The D4 echo scenario across two devices → the newest mark wins.
- Two writers with different marks (injected 412) → both sets end up in the file.
- The PUT lands but its response is dropped → at the next start the intent applies, and there's no echo.
- `take-reimport` on the writer after another device pushed an older list → the intent still applies.
- Waits:
  - last Excel change 1 min ago → waits; `force` writes;
  - 423 → waiting, then written after the unlock;
  - a held import → no write;
  - `WorkbookChangedError` → one re-import, then an error, and no upload;
  - stuck rows → no loop.
- Backups: on the first write, then weekly. The newest 4 are kept.
- Offline → nothing; back online → written.
- **Every PUT to the workbook carries If-Match** (asserted in the fake).

Done when: all of the above pass, and the patched file opens in LibreOffice in e2e.

**WP10 (ui-dev, sonnet): write status UI.**

Files: `src/ui/Microsoft.tsx`, `src/ui/Sheets.tsx`, `src/styles.css`.

Steps:
1. **Workbook line:**
   - "Your statuses written 1 min ago."
   - "3 waiting: the workbook was edited 2 min ago (Excel may be open); writing at 10:42 [Write now]."
   - "The workbook is open in Excel: waiting."
   - Errors.
   - "2 rows could not be written (row not found)."
   - In small text: "Last write took 2.1 s" (`patchMs`).
2. **First-write confirmation,** once per device:
   - How many rows will change.
   - "A backup goes to OneDrive › Apps › Hugo Chinese › backups."
   - The warning about older devices (from WP7).
   - Buttons: [Write] [Not now].
3. **Per-device toggle:** "Write my statuses into the workbook automatically" (`excel.write`). When it's off, "Write now"
   stays.
4. **Sheets top bar:** a small pending count that opens the panel.

Done when: desktop and iPhone screenshots are checked (safe areas, 44 px targets).

**WP11 (release, sonnet): e2e write-back.**

Files: `e2e/onedrive.py`, `e2e/fake_graph.py`, `e2e/README.md`.

Scenarios:
- The phone sets a status and confirms → openpyxl reads the fill in the fake file. Every zip entry except `styles.xml`
  and that sheet is unchanged.
- "Excel" saves during the write (412) → both edits are present.
- Lock (423) → the waiting text shows.
- "Excel" reverts an app-written row → the notice shows; Restore writes the row again.
- Offline, then online → written.
- A screenshot of the confirmation on the iPhone viewport.

Done when: CI is green.

### P4: cleanup and options (after P3 has run for a week)
- **WP12 (ui-dev): Microsoft-first setup everywhere.** The folder link, the GitHub sync key and the file picked by hand
  live under "Other ways (without Microsoft)". Files: `Setup.tsx`, `Settings.tsx`.
- **WP13 (engineer, optional):**
  - Share the PC's `~$` signal through the app folder (`presence.<dev>.json`, 10 min TTL), so the phone also waits while
    Excel desktop is open.
  - Delete the dormant `progress.ts` and its test.
  - Silent renewal through a hidden iframe on desktop. Release then adds `frame-src` for the two login hosts.
- **Lead:** update the CLAUDE.md map, the "Sync repo" section (store choice, app folder layout, new kv keys) and
  `e2e/README.md`.

## Order
- **P0** first: Hugo's answers and the client id. Code can start before the id arrives, because an empty `MS_CLIENT_ID`
  hides the Microsoft UI.
- **P1** (one qa batch):
  - WP0 (lead) goes first.
  - Then WP1, WP2, WP3, WP4 and WP5 run in parallel. WP2 codes against WP1's signatures with `vi.mock`. The lead merges
    WP1 before WP2's integration test.
  - The lead may push sign-in and diagnostics first (WP0, WP1, WP5 and the sign-in part of WP4). Hugo then tries sign-in
    in the iPhone Home Screen app early: that's the go/no-go for the whole plan.
- **P2** (one qa batch):
  - WP6 starts once WP1 is merged.
  - WP8 runs once WP5 is merged, in parallel with WP6.
  - WP7 runs once WP4 is merged.
- **P3** (one qa batch) after P1 and P2:
  - WP9, WP10 and WP11 run in parallel.
  - Then Hugo's real-account checks. Writing stays behind the first-write confirmation.
- **P4**, a week later: mostly copy and structure. No qa; the lead runs `npm test` and the build.

## Verification for qa

**Unit** (`npm test`, `tsc`):
- Everything listed in the WPs.
- The existing sync tests run unchanged against the GitHub store.
- The status golden tests are unchanged.
- No test or fixture holds a real token or a real workbook.

**Browser** (`e2e/onedrive.py` with the fake Microsoft endpoints; `sync.py` and `offline.py` still pass):
- Sign-in redirect, with the route restored.
- Reading in two contexts.
- An Excel edit → the notice → Restore.
- The Reconnect banner.
- Sync through the app folder.
- Write-back with 412, 423 and offline.
- Zip diff of the patched file.
- Offline reload with Microsoft linked: the app works, and the Graph calls simply wait.

**Desktop, real account** (Hugo with the lead; never in CI):
- Sign-in from Edge.
- The diagnostics report: driveType personal, quickXorHash match, stale If-Match → 412, download host allowed.
- A status written while the workbook is closed → Excel online shows it.
- Excel online open and idle → the write comes after 5 minutes of quiet. Note what Excel shows.
- Excel desktop open with AutoSave and an unsaved edit, on the PC with the folder linked → the app waits (the `~$`
  signal). Once Excel is closed, the status is written.
- OneDrive version history lists the app's versions.
- A backup exists in Apps/Hugo Chinese/backups.

**iPhone, Home Screen app (Hugo):**
- The sign-in comes back into the app, not Safari.
- After killing and reopening the app, it's still signed in.
- The next day: the silent renewal flash, or the banner.
- A status set while open is written within about a minute.
- In airplane mode the app shows "1 waiting"; the status is written once back online.
- An edit in Excel for iPhone is visible in the app after reopening it.
- The patch takes under 5 s (shown in the Microsoft panel).
- No zoom on inputs. Banners clear the notch and the home indicator.

**Data compatibility:**
- A list written by the current version (no qxh, all HSK四级 entries Mastered) imports and merges without status changes.
- A list without `colourSince` → rule 4.
- Old marks, events and explain files decode the same from both stores.
- A devices file without `caps` shows as an older version.
- The IndexedDB version is still 1.
- Backups hold none of the new kv keys.
- "Reset this device" removes the Microsoft tokens.
- Older app version: in a `git worktree` of the current main, a vitest script loads a `vocab.json.gz` written by the new
  code through `setVocab` and `sheetRows`. Expect no crash and the same words.

## Risks
| Risk | Mitigation | If it happens |
|---|---|---|
| A personal account can't register apps without a directory (a card is needed) | Steps above; Hugo decides in P0 | D13: today's PC folder + GitHub |
| The iOS Home Screen app sends the sign-in to Safari, or loses it | P1 go/no-go on the device, before P2/P3 | The phone stays on GitHub sync + import by hand; the PC still does Excel and the app folder |
| The daily sign-in renewal annoys Hugo | Silent `prompt=none` at start; banner otherwise | P4 iframe renewal on the PC |
| Excel co-authoring overwrites an app write, or shows conflict dialogs | 5-minute quiet period, `~$` signal, 423, If-Match, the "Excel changed" notice with Restore, backups, version history | Hugo turns automatic writing off on a device and uses "Write now" |
| Graph behaves differently from expectations (download host, If-Match on a simple PUT, approot with Files.ReadWrite) | P1 diagnostics on his account, before P3 | Upload session with If-Match on `createUploadSession`; update the CSP host list |
| Excel online re-saves the XML in a shape the patcher doesn't expect | The patcher works on attributes generically. WP9 tests rows with `spans`, `x14ac:*` and inline strings. `WorkbookChangedError` stops a wrong write | Re-import, then error, no upload |
| Clock skew between device clocks (marks) and OneDrive time (colours) | Devices keep NTP time; skew only matters for near-simultaneous edits | Shows in the "Excel changed" notice |
| An older app version imports during the switch (no qxh, old HSK四级 rule) | Additive formats; the `caps` warning before the first write; the update flow usually upgrades in one launch | A few colour times are wrong until the next import; the notice shows the statuses that changed |
