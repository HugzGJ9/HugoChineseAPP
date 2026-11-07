# Hugo 中文 — project brief

Personal Chinese study PWA for one user, Hugo (French speaker, learning HSK vocabulary from his own Excel file).
Live: https://hugzgj9.github.io/HugoChineseAPP/ (GitHub Pages, base path `/HugoChineseAPP/`). Used in Edge on a Windows PC
and as an iPhone Home Screen app. No backend: data lives in IndexedDB on each device and syncs through a private GitHub repo.

## Hard rules
- This repo is public. Never commit personal data: `*.xlsx`, word lists, progress, review logs, tokens, screenshots of his
  words. Real test files stay outside the repo and are passed by path (see `e2e/README.md`).
- The GitHub token stays on Hugo's devices and is only sent to api.github.com. A new network host must be added to the CSP
  in `index.html` (`connect-src`), or it is blocked.
- Old app versions keep running on other devices until their service worker updates. Sync files and IndexedDB changes
  must stay backward compatible: additive fields, versioned formats, Dexie `version(n+1)` with an upgrade.
- Review events are the source of truth. Cards are derived from notes + seeds + events (`deriveCards`), so every device
  replays the same events and agrees. Never store derived state as truth; never rewrite or reuse event ids.
- Code, UI text, commits and docs in English. Talk to Hugo in the language he writes in.

## Commands
- `npm test` (vitest + fake-indexeddb) · `npx tsc --noEmit -p .` · `npm run build` (stroke data, CFDICT, type-check, vite)
- Preview: `npm run build && npx vite preview --port 4173` → http://localhost:4173/HugoChineseAPP/
- Browser checks: Python Playwright (`e2e/`). In cloud sessions Chromium + Playwright are preinstalled; never run
  `playwright install`.

## Product (what Hugo wants)
"My Excel, with a bit more design." Home = **Sheets**: one tab per Excel sheet in workbook order, rows in Excel order,
hanzi/pinyin/meaning with Quick memory's hide/show. Each word has a status **Hugo sets himself** (Not studied, Studying,
Not known, Mastered), seeded from his Excel colours (HSK四级 all Mastered; HSK五级 green Mastered, yellow Not known, blank
Not studied, other colours Studying); the newer of his change and the Excel colour wins. He manages his own review rhythm:
FSRS review is an optional tool and never sets a status. On the PC the app writes `Hugo_chinese_vocab (app).xlsx` next to
the original (same bytes, only status fills changed); the original is never written. Nav: Sheets · Quick · Settings
(Today, Stats, Words under Settings › More). Plans: `.claude/plans/` (latest: 2026-11-07-sheets.md).

## Map
- `src/main.tsx` boot: `store.init` → folder → sync → PWA update flow (`src/lib/pwa.ts`) → offline warm-up (strokes.ts)
- `src/lib/types.ts` Note, VocabFile (aliases, colourSince), ReviewEvent (mo), CardState, StatusMark/MarkKind (incl. `st:*`),
  WordStatus, SheetCols, RowFill, PendingImport
- `src/lib/db.ts` Dexie DB `hugo-zhongwen` (still v1: no index changes, see roadmap D2): notes, events, kv (settings, sync
  state, dirty months, marks per device+month, folderHandle, copySig…); device/shared prefs (localStorage, `sh.` prefix)
- `src/lib/store.ts` state + subscribe; init (one-time migrations), setVocab, recordReview/undoReview, setNoteStatus/undoMark,
  pending imports, BroadcastChannel `hz` between tabs
- `src/lib/status.ts` colour → status rules, status labels/fills/marks, sheet rows
- `src/lib/engine/` schedule.ts (FSRS via ts-fsrs pinned, day starts 04:00, deriveCards replays events + marks), queue.ts,
  grade.ts
- `src/lib/import/` Excel → VocabFile in a worker: build.ts, guard.ts (holds suspicious imports), renames.ts (aliases keep
  history); `src/lib/xlsx/` read.ts, write.ts, patch.ts + patch.worker.ts (in-place fill patch for the copy)
- `src/lib/sources.ts` importBytes / accept / reject pending import · `src/lib/folder.ts` OneDrive folder, re-import on change,
  `writeCopy()`
- `src/lib/github.ts` REST client (2 min timeout) · `src/lib/sync.ts` Web-Lock sync, per-file error isolation, marks, prefs
- `src/lib/backup.ts` backup file / restore · stats.ts, progress.ts (legacy workbook, no longer written), pinyin.ts, speech.ts
- `src/ui/` App.tsx (routes; default `sheets`), Sheets.tsx (+ sheets/Practice.tsx, ScratchPad.tsx), qm.tsx (shared hide/show
  list), StatusPicker.tsx, Quick.tsx, review/* (Session, CardView, GradeBar, VocabBack, OtherCard; Review.tsx re-exports),
  WritePad.tsx, Words, Today, Stats, Settings (Your data: backup), Setup (folder, sync, QR/key, link page), common.tsx
- `e2e/` offline.py, sync.py, make_sample.py (synthetic coloured workbook; CI uses it) · `.github/workflows/deploy.yml`
  push to main → test → build → e2e → Pages (docs/agents/plans don't deploy)

## Sync repo (private, Hugo's own: HugoChineseData)
`vocab.json.gz` · `settings.json` (latest `updatedAt` wins; `prefs` field) · `events/<device>/<YYYY-MM>.json` and
`marks/<device>/<YYYY-MM>.json` (each device writes only its own; month frozen in `mo`) · `devices/<device>.json`.
Write conflicts (409/422) retry once. Tests: Node 24 has global `navigator.locks` — never run one device's sync inside another's.

## Cloud session limits
- The shell's network is allowlisted: github.io and most docs sites are unreachable. Check deploys with `gh run …` and
  `gh api repos/HugzGJ9/HugoChineseAPP/deployments?environment=github-pages`. The Pages settings API is blocked: Hugo
  changes repository settings himself, from exact click-steps.
- Headless Chromium crashes when reading a FileSystemDirectoryHandle back from IndexedDB; `e2e/sync.py` works around it.
  Real Edge is fine.

## How work is run
The main session is the lead: it talks to Hugo, routes work, integrates, commits and pushes. Agents live in `.claude/agents/`.

| Work | Who | Model |
|---|---|---|
| Tiny, obvious change (≤ ~30 lines, 1–2 files) | lead, no agent | — |
| Find code, trace calls, summarise a failed CI log | scout | haiku |
| Feature or change across modules, data/sync/format change, unclear design | architect → plan in `.claude/plans/` | opus, max effort |
| Logic in `src/lib` (sync, engine, store, db, import, xlsx, folder), refactors | engineer | opus |
| Screens, styles, copy, simple features, single-module fixes | ui-dev | sonnet |
| CI, Pages, PWA/service worker, build config, dependencies | release | sonnet |
| Independent check of a batch before push | qa | sonnet |

Cost rules:
1. Give agents file paths and the plan file, never pasted code. They already receive this brief.
2. One architect plan per request, split into work packages with disjoint files; builders run in parallel, in the background.
3. qa once per batch, not per package. Copy/style-only batches skip qa: the lead runs `npm test` and the build.
4. Escalate one model tier (haiku → sonnet → opus) only after an agent fails twice, with `model` on the call. Fable is not used.
5. Agents end with a short report (files changed, checks and results, open questions), never code dumps.
6. Agents don't spawn agents, commit or push unless the lead's prompt says so. After a push the lead watches the run;
   release is called only if it fails.
