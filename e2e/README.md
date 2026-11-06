# Browser checks

Python Playwright scripts that run against the preview build. In cloud sessions Chromium and Playwright are preinstalled;
don't run `playwright install`.

```sh
npm run build && npx vite preview --port 4173 &   # serves http://localhost:4173/HugoChineseAPP/
python3 e2e/offline.py                            # service worker installs, offline reload works
HUGO_XLSX=/path/to/Hugo_chinese_vocab.xlsx python3 e2e/sync.py
```

`sync.py` plays a computer and an iPhone (iPhone 13 emulation):
1. The computer links a simulated OneDrive folder (OPFS) holding the real Excel file, turns on sync, studies four cards
   and writes the progress workbook.
2. The iPhone opens the link page, pastes the sync key, gets the words and studies three cards.
3. The computer picks up the iPhone's reviews.

It fakes the GitHub API in memory, so nothing is sent anywhere. It exits non-zero when the two devices disagree.

- `HUGO_URL` changes the app URL.
- `E2E_OUT` changes the output folder (default `e2e-out/`). It holds screenshots and `progress-e2e.xlsx`, which show
  Hugo's words: it is git-ignored and must never be committed.
- The real Excel file is never in the repo. Ask Hugo for a copy, or reuse one already in the session's scratchpad.
- The only expected console error is the first 409 from the empty fake repository.
