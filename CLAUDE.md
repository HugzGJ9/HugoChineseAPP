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

## Map
- `src/main.tsx` boot: `store.init` → `startFolder` → `startSync`
- `src/lib/types.ts` Note, VocabFile, ReviewEvent, CardState, Settings
- `src/lib/db.ts` Dexie DB `hugo-zhongwen` (v1): notes, events, kv (settings, syncLink, syncShas, dirty, vocabDirty,
  settingsDirty, folderHandle, progressSig…)
- `src/lib/store.ts` app state + subscribe; init, setVocab, recordReview/undoReview, updateSettings, dirty months, folder state
- `src/lib/engine/` schedule.ts (FSRS via ts-fsrs, day starts 04:00, seeding of known "green" words, deriveCards, statuses),
  queue.ts (today's queue and limits), grade.ts (checks typed pinyin/hanzi/meaning → grade)
- `src/lib/import/` Excel → VocabFile in a worker; build.ts (sheets → notes, green rows = already studied, examples,
  pinyin checks); `src/lib/xlsx/read.ts` (zip + XML + cell colours); `src/lib/french.ts` (CFDICT French meanings)
- `src/lib/sources.ts` importBytes (hash compare, sets vocabDirty)
- `src/lib/folder.ts` File System Access: OneDrive folder, re-import on change, writes `Hugo_chinese_progress.xlsx`
  (progress.ts + xlsx/write.ts)
- `src/lib/github.ts` minimal GitHub REST client · `src/lib/sync.ts` repo sync, sync key `hz1.…`, triggers
- `src/lib/` stats.ts, pinyin.ts, strokes.ts (Hanzi Writer data in public/hw), speech.ts (TTS)
- `src/ui/` App.tsx (hash routes: today, review, quick, words, grammar, stats, settings, report, link), Today, Review (all
  answer modes, WritePad), Quick, Words, Stats, Settings, Setup (folder, sync, QR/key, link page), common.tsx; `src/styles.css`
- `scripts/` copy-hw.mjs, build-cfdict.mjs (downloads CFDICT at build time) · `.github/workflows/deploy.yml` push to main →
  test → build → Pages

## Sync repo (private, Hugo's own: HugoChineseData)
`vocab.json.gz` · `settings.json` (latest `updatedAt` wins) · `events/<device>/<YYYY-MM>.json` (each device writes only its
own) · `devices/<device>.json`. Write conflicts (409/422) retry once.

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
