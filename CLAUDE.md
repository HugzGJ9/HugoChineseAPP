# Hugo 中文 — project brief

Personal Chinese study PWA for one user, Hugo (French speaker, learning HSK vocabulary from his own Excel file).
Live: https://hugzgj9.github.io/HugoChineseAPP/ (GitHub Pages, base path `/HugoChineseAPP/`). Used in Edge on a Windows PC
and as an iPhone Home Screen app. No backend: data lives in IndexedDB on each device and syncs through OneDrive's app
folder (default) or a private GitHub repo (legacy).

<!-- Budget: this file is loaded by every session AND every agent. Keep it under ~70 lines. Module detail goes in
     src/lib/CLAUDE.md and src/ui/CLAUDE.md (loaded only when work touches those folders). -->

## Read first (in this order, stop when you have enough)
1. This file.
2. `.claude/plans/INDEX.md` — what's shipped, what's in progress, which plan section to open. Never read a whole plan
   unless you are its architect; builders read only their work package.
3. `docs/decisions.md` — durable decisions (data formats, sync, compatibility). Check before "fixing" something odd.
4. `docs/screen-map.md` — files, tests and e2e per screen. Then the folder note: `src/lib/CLAUDE.md` or `src/ui/CLAUDE.md`.
5. File headers: most `src/lib` files open with a comment block explaining the design. Read it before the body.

## Hard rules
- This repo is public. Never commit personal data: `*.xlsx`, word lists, progress, review logs, tokens, screenshots of his
  words. Real test files stay outside the repo and are passed by path (see `e2e/README.md`).
- Tokens (GitHub, Microsoft, Claude key) stay on Hugo's devices. A new network host must be added to the CSP in
  `index.html` (`connect-src`), or it is blocked.
- Old app versions keep running on other devices until their service worker updates. Sync files and IndexedDB changes
  must stay backward compatible: additive fields, versioned formats, Dexie `version(n+1)` with an upgrade.
- Review events and marks are the source of truth; cards are derived (`deriveCards`). Never store derived state as truth;
  never rewrite or reuse event ids.
- Code, UI text, commits and docs in English. Talk to Hugo in the language he writes in.

## Commands
- `npm test` (vitest + fake-indexeddb) · `npx tsc --noEmit -p .` · `npm run build` (stroke data, CFDICT, type-check, vite)
- Single test file: `npx vitest run src/lib/sync.test.ts` — prefer this over the full suite while iterating.
- `npm run coverage`: line/branch coverage of `src/lib` (UI is covered by `e2e/`, not unit tests).
- Preview: `npm run build && npx vite preview --port 4173` → http://localhost:4173/HugoChineseAPP/
- Browser checks: Python Playwright (`e2e/`, see `e2e/README.md`). In cloud sessions Chromium + Playwright are
  preinstalled; never run `playwright install`.

## Product (what Hugo wants)
"My Excel, with a bit more design." Home = **Sheets**: one tab per Excel sheet in workbook order, rows in Excel order.
Each word has a status **Hugo sets himself** (Not studied, Studying, Not known, Mastered), seeded from his Excel colours;
the newer of his change and the Excel colour wins. FSRS review is optional and never sets a status.
Statuses reach Excel two ways:
- Signed in with Microsoft → written into his real workbook on OneDrive (`workbook.ts`: If-Match, never overwrite Excel
  edits, backup first).
- No Microsoft sign-in → PC only, a copy `Hugo_chinese_vocab (app).xlsx` next to the original (`folder.ts`); the original
  is never written from there.
Nav: Sheets · Grammar · Settings (Today, Stats, Words under Settings › Advanced). Grammar (`#/grammar`) lists the 语法
points (filters, EN|FR, tap any word in examples). Sheets is the one list (All tab, answer field per row) with a List | Cards switch; Cards (`#/cards`) is the full-screen drill. Tapping a word opens a panel: Explain, status, Practise this word.

## Top-level map
- `src/main.tsx` boot order · `src/lib/` logic, storage, sync (→ `src/lib/CLAUDE.md`) · `src/ui/` screens (→ `src/ui/CLAUDE.md`)
- `scripts/` data builds (strokes, CFDICT, lexicon) · `e2e/` Playwright checks · `.github/workflows/` deploy.yml, data.yml
- `.claude/agents/` agent definitions · `.claude/plans/` plans (+ INDEX.md) · `docs/decisions.md`

## Cloud session limits
- The shell's network is allowlisted: github.io, mdbg.net, tatoeba.org, Microsoft docs and Actions artifact downloads are
  unreachable. Check deploys with `gh run …`; test real lexicon data with the `data.yml` workflow on a branch.
- The Pages settings API is blocked: Hugo changes repository settings himself, from exact click-steps.
- Headless Chromium crashes reading a FileSystemDirectoryHandle back from IndexedDB; `e2e/sync.py` works around it.
- `e2e/sandbox.py` probes Web Locks and `navigator.onLine` and shims only what fails; in cloud sessions both work, so all
  sync e2e scripts run as in CI (their old stop at "Link this device" was an app bug, fixed by `nav-hold` in keyboard.ts).

## How work is run
The main session is the lead: it talks to Hugo, routes work, integrates, commits and pushes. Agents: `.claude/agents/`.

**Solo first.** The lead does the work itself unless a team trigger applies (the `team-or-solo` routing skill
decides). Team triggers: a stored shape, sync file or event/mark logic changes · ≥ 3 modules or > ~300 lines ·
an unclear design Hugo has not settled · a data build in `scripts/` · ≥ 3 independent packages worth running in parallel.
Without a clear repro (screen, steps, device, Copy diagnostics), ask Hugo for one before running any measurement campaign.

| Work | Who | Model |
|---|---|---|
| UI tweak, copy, style, one-screen feature or fix, Excel content (no team trigger) | lead, no agent | — |
| Find code, trace calls, summarise a failed CI log | scout | haiku |
| Review libraries, repos, browser support or licences on the web | researcher | sonnet |
| Feature across modules, unclear design | architect → plan (≤ 1 page) + INDEX.md row | opus, medium effort |
| Data, sync or stored-format change | architect → plan + INDEX.md row | opus, high effort |
| Data, sync, stored-format or engine logic | engineer | opus (set with `model`) |
| Other logic in `src/lib`, scripts, refactors | engineer | sonnet |
| Screens, styles, copy, simple features, single-module fixes | ui-dev | sonnet |
| CI and workflows (deploy.yml, data.yml), Pages, PWA/service worker, build config, deps | release | sonnet |
| Independent check of a batch that touches sync files or stored shapes | qa | opus |
| Independent check of any other batch | qa | sonnet; skipped for UI-only batches |

Cost rules:
0. Run only the unit tests and e2e scripts for what changed (`docs/screen-map.md`); the full e2e set once per batch, before the push.
1. Plans: one page max, no full code interfaces unless a stored shape changes. Give Hugo the decisions to make in one list.
2. Merge a PR before starting a stacked batch. Aim for one deploy a day.
3. Give agents file paths, the plan file and the work-package heading, never pasted code.
4. One architect plan per request, split into work packages with disjoint files; builders run in parallel, in the background.
5. qa once per batch, not per package. Copy/style-only batches skip qa: the lead runs `npm test` and the build.
6. Set a row's model or effort with the Agent tool's `model` / `effort` parameters when it differs from the agent file.
   Escalate one tier (haiku → sonnet → opus) only after an agent fails twice. Fable is the last step, only for
   architect or engineer on data/sync/format work after opus fails twice; never a default.
7. Agents end with a short report (files changed, checks and results, open questions), never code dumps.
8. Agents don't spawn agents, commit or push unless the lead's prompt says so. After a push the lead watches the run.
9. qa FAIL: the lead sends each problem to the builder that owns the file, then reruns qa on those problems only.

## End of session (lead)
- Update `.claude/plans/INDEX.md` (status, what's left). Rewrite its "Now / next" as ≤ 5 lines: what shipped, what is
  open, what Hugo must check. A new chat starts from those lines, not from the plans.
- Release: merged PRs go out in one deploy a day; give Hugo one iPhone checklist (rows of `docs/screen-map.md`).
- New durable decision → one entry in `docs/decisions.md`. New gotcha or moved file → the right CLAUDE.md, in one line.
- If this file grew past ~70 lines, move detail down into a folder note.
