# Browser checks

Python Playwright scripts that run against the preview build. In cloud sessions Chromium and Playwright are preinstalled;
don't run `playwright install`.

```sh
npm run build && npx vite preview --port 4173 &   # serves http://localhost:4173/HugoChineseAPP/
python3 e2e/offline.py                            # service worker, dictionary warm-up, offline reload, update flow
python3 e2e/sync.py                               # uses a synthetic workbook from make_sample.py
python3 e2e/explain.py                            # word panel, Settings key, "Explain more" (needs LEXICON_SAMPLE=1 build)
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

- `onedrive.py` plays a computer and an iPhone 13 against a fake Microsoft (`fake_graph.py`: Playwright routes for
  login.microsoftonline.com, graph.microsoft.com and a fake `*.microsoftpersonalcontent.com` download host; PKCE checked,
  tokens and quickXorHash made up in memory). No real credentials or requests; any other Microsoft host is aborted and
  recorded, and the script fails on an unrouted request, a workbook PUT without `If-Match`, or an `Authorization` header
  sent to the download host. It checks sign-in with the route restored, linking by search, an "Excel" recolour (notice
  and Restore), no re-download of unchanged content, the Reconnect banner after the refresh token dies, offline silence,
  and the service worker answering `/?code=&state=` offline. It needs a build with a non-empty `MS_CLIENT_ID` (any value);
  otherwise it prints SKIP and exits 0, or fails when `E2E_REQUIRE_MS=1`. `python3 e2e/fake_graph.py` self-checks the
  hash port. Never run `playwright install` in cloud sessions.
- `make_sample.py OUT.xlsx` writes a made-up workbook with the colour layout of the real file: HSK四级 (A-B coloured),
  HSK五级 (A-D coloured, blank rows) and a Grammar sheet; needs `openpyxl`. CI uses it, so nothing personal is involved. `sync.py` calls it when `HUGO_XLSX` is unset.
- `explain.py` needs a build made with `LEXICON_SAMPLE=1 npm run build` (synthetic dictionary and sentences). The Anthropic
  API is mocked with `page.route` (models list and a canned SSE `tool_use` stream) and the key is a fake `sk-ant-test-…`:
  no real key and no real request. It checks the panel on desktop and iPhone 13 emulation (bottom flush with the viewport,
  16 px key input, no sideways scroll), the no-key message, the request headers, the cache on reopen, offline reload, and
  that the key is not in `localStorage`.
- CI runs the e2e scripts in the `e2e` job of `.github/workflows/deploy.yml`; a failure blocks the deploy.
- `HUGO_URL` changes the app URL.
- `E2E_OUT` changes the output folder (default `e2e-out/`). It holds screenshots and `copy-e2e.xlsx` (the workbook copy), which show
  Hugo's words: it is git-ignored and must never be committed.
- A real Excel file is never in the repo. Ask Hugo for a copy, or reuse one already in the session's scratchpad.
- The only expected console error is the first 409 from the empty fake repository.
