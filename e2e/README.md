# Browser checks

Python Playwright scripts that run against the preview build. In cloud sessions Chromium and Playwright are preinstalled;
don't run `playwright install`.

```sh
npm run build && npx vite preview --port 4173 &   # serves http://localhost:4173/HugoChineseAPP/
python3 e2e/offline.py                            # service worker, dictionary warm-up, offline reload, update flow
python3 e2e/sync.py                               # uses a synthetic workbook from make_sample.py
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

- `make_sample.py OUT.xlsx` writes a made-up workbook with the colour layout of the real file: HSK四级 (A-B coloured),
  HSK五级 (A-D coloured, blank rows) and a Grammar sheet; needs `openpyxl`. CI uses it, so nothing personal is involved. `sync.py` calls it when `HUGO_XLSX` is unset.
- CI runs both scripts in the `e2e` job of `.github/workflows/deploy.yml`; a failure blocks the deploy.
- `HUGO_URL` changes the app URL.
- `E2E_OUT` changes the output folder (default `e2e-out/`). It holds screenshots and `copy-e2e.xlsx` (the workbook copy), which show
  Hugo's words: it is git-ignored and must never be committed.
- A real Excel file is never in the repo. Ask Hugo for a copy, or reuse one already in the session's scratchpad.
- The only expected console error is the first 409 from the empty fake repository.
