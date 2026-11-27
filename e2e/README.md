# Browser checks

Python Playwright scripts that run against the preview build. In cloud sessions Chromium and Playwright are preinstalled;
don't run `playwright install`.

```sh
npm run build && npx vite preview --port 4173 &   # serves http://localhost:4173/HugoChineseAPP/
python3 e2e/offline.py                            # service worker, dictionary warm-up, offline reload, update flow
python3 e2e/sync.py                               # uses a synthetic workbook from make_sample.py
python3 e2e/sandbox.py                            # probe: Web Locks, onLine; sync scripts shim only what fails here
python3 e2e/cards.py                              # Sheets › Cards: typed answers, tones, Draw, deck kept, the Wrong label
python3 e2e/layout.py                             # phone layout, light and dark: Check in view, panel top edge, menu drags, colours
python3 e2e/grammar.py                            # Grammar tab: 中/FR/EN titles, families, search, meaning card, underlined words, phone back
python3 e2e/explain.py                            # word panel: section order, dictionary, characters, examples (needs LEXICON_SAMPLE=1 build)
HUGO_XLSX=/path/to/Hugo_chinese_vocab.xlsx python3 e2e/sync.py   # or a real file
```

`sync.py` plays a computer and an iPhone (iPhone 13 emulation):
1. The computer links a simulated OneDrive folder (OPFS) holding the Excel file (home screen: Sheets), turns on sync,
   studies four cards and writes the copy.
2. The iPhone opens the link page, pastes the sync key, gets the words, studies three cards and sets a blank HSK五级 row
   to Mastered (status chip, then the Mastered menu item).
3. The computer picks up the iPhone's reviews and status, then writes `Hugo_chinese_vocab (app).xlsx`. The script checks
   that the row's hanzi cell is filled A9D18E, that every zip entry except `styles.xml` and that sheet is identical to the
   original, and that the original's sha256 is unchanged.

It fakes the GitHub API in memory, so nothing is sent anywhere. It exits non-zero when the two devices disagree.

- `cards.py` (desktop and iPhone 13) drives Sheets › View › Cards: typed pinyin answers (Right, Wrong, 16 px field, no
  sideways scroll), the deck kept after Close, a hand-typed `#/cards` and a reload, the end of a round, retry, Shuffle and
  Start over; then in a fresh browser tone digits ("3" right, "2" wrong for 少 shǎo), the Draw pad, and the Wrong label (a
  wrong answer tags the row in Sheets, the Wrong filter counts 1, tapping the tag clears it, still cleared after a reload)); Answer by Choose (4 different options, the green one is the card, verdict read out) and Flip (Show
  answer, Not known / Known move on).
- `layout.py` (iPhone 13 and 390×844, light and dark) fails when the layout breaks on a phone: in Cards, for each answer
  type, the field or pad and Check (Draw: Show answer) are inside the viewport with no page scroll and no answer text is on
  screen before Check; the word panel's top edge is the same on two words; the status and filter menus close on a real
  downward touch drag (CDP `Input.dispatchTouchEvent`); a list answer field is green for 少 and red for 2; a tone-1 pinyin
  span and a Not known chip have different computed colours; Sheets rows are two lines on phones (no id or pen, tags on
  the hanzi line, meaning ≥ 180 px, row ≤ 100 px) and the tab bar hides while an answer field has focus. In Cards, Check must move neither the card nor the dock, and the field keeps the focus after Check and Next. On a 375x812 iPhone with a
  stand-in iOS keyboard (pans at focus time like iOS, events 400 ms late, 47/34 px safe areas), tapping the field must not pan
  and the bar, card, field and buttons stay above the keyboard with nothing cut off, while it opens and once open.
- `onedrive.py` plays a computer and an iPhone 13 against a fake Microsoft (`fake_graph.py`: Playwright routes for
  login.microsoftonline.com, graph.microsoft.com and a fake `*.microsoftpersonalcontent.com` download host; PKCE checked,
  tokens and quickXorHash made up in memory). No real credentials or requests; any other Microsoft host is aborted and
  recorded, and the script fails on an unrouted request, a workbook PUT without `If-Match`, or an `Authorization` header
  sent to the download host. It checks sign-in with the route restored, linking by search, an "Excel" recolour (notice
  and Restore), no re-download of unchanged content, the Reconnect banner after the refresh token dies, offline silence,
  and the service worker answering `/?code=&state=` offline. It needs a build with a non-empty `MS_CLIENT_ID` (any value);
  otherwise it prints SKIP and exits 0, or fails when `E2E_REQUIRE_MS=1`. `python3 e2e/fake_graph.py` self-checks the
  hash port. Never run `playwright install` in cloud sessions.
- `onedrive_sync.py` (plan WP8) plays the same two devices against the fake Microsoft's **app folder**
  (`special/approot`, flat files under `data/`, listed in pages of 2 to exercise `@odata.nextLink`; `PUT` with `If-Match` or
  `conflictBehavior=fail`, `DELETE`). Both sign in (sync turns on by itself), the computer and the phone study, the phone sets
  a status, the computer sees the reviews and the status (same event counts), and a language change reaches the phone
  (`settings.json` prefs). It fails on an unconditional app `PUT`, an unrouted Microsoft request, or any request to
  `api.github.com`.
- `onedrive_writeback.py` (plan WP11) plays an iPhone 13 writing statuses into the fake workbook while "Excel" (the script)
  edits it: first-write confirmation (screenshot, no sideways scroll), the green fill read back with openpyxl, only
  `styles.xml` and the sheet changed, the backup in the app folder, no echo notice; Excel saving during the upload (412, both
  edits present); a lock (423, waiting text, written after the unlock); Excel reverting an app-written row (notice, Restore
  writes it again); offline (waiting count, no request) then online. Every workbook `PUT` must carry `If-Match`.
- Both new scripts need app-folder sync / write-back in the build (WP6/WP7, WP9/WP10); without them they print SKIP and exit
  0, or fail when `E2E_REQUIRE_MS=1` (CI). Selectors for the new UI live in one place, `SEL` in `od_common.py` (shared
  helpers: sign-in, status chips, event counts); `fake_graph.py` gained `excel_saves_during_next_put`, `app_files`,
  `app_json`, `lock`, `fill_of`, `recolour_none` and `zip_changed`. They take ~2 minutes each (waits for "Write now" and
  the 423 back-off).
- `make_sample.py OUT.xlsx` writes a made-up workbook with the colour layout of the real file: HSK四级 (A-B coloured),
  HSK五级 (A-D coloured, blank rows) and a Grammar sheet; needs `openpyxl`. CI uses it, so nothing personal is involved. `sync.py` calls it when `HUGO_XLSX` is unset.
- `explain.py` needs a build made with `LEXICON_SAMPLE=1 npm run build` (synthetic dictionary and sentences). It checks the
  word panel on desktop and iPhone 13 emulation (bottom flush with the viewport, no sideways scroll), the section order
  (Your list, Dictionary, Characters, Similar meaning, Examples), that no Claude block remains, and offline reload.
- `make_big.py OUT.xlsx` writes a Hugo-sized synthetic workbook (HSK四级 570 words, HSK五级 1,200, Grammar 40; deterministic, made up
  from ~60 common characters, no personal data); needs `openpyxl`. `perf.py` uses it.
- `perf.py` (iPhone 13, CPU throttled 4x, `service_workers='block'`, 8,000 review events seeded in the page) times the boot
  (cold, and warm when the build reports `hz:cards`), the first Grammar visit, sheet tabs, back to a kept tab, peek, a status
  change and the word panel, with "Try new animations" off and then on (`PERF_MOTION=off|on|both`). Median of `PERF_RUNS`
  (default 3) is judged against the budgets: tab < 150 ms, back to a tab < 50 ms, boot first row < 1,200 ms, peek < 50 ms,
  status < 150 ms, 0 empty frames; with `hz:cards`: warm first row < 800 ms, longest boot task < 200 ms. Budgets are soft (exit 0)
  unless `PERF_STRICT=1`; a flow whose target never appears always exits 1. Writes `$E2E_OUT/perf.json` and appends a
  markdown table to `$GITHUB_STEP_SUMMARY` when set. It ignores `HUGO_XLSX` and takes about 3 minutes.
- CI runs the e2e scripts in the `e2e` job of `.github/workflows/deploy.yml`; a failure blocks the deploy.
- `HUGO_URL` changes the app URL.
- `E2E_OUT` changes the output folder (default `e2e-out/`). It holds screenshots and `copy-e2e.xlsx` (the workbook copy), which show
  Hugo's words: it is git-ignored and must never be committed.
- A real Excel file is never in the repo. Ask Hugo for a copy, or reuse one already in the session's scratchpad.
- The only expected console error is the first 409 from the empty fake repository.
