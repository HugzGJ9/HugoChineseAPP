# Hugo 中文

A personal app for learning Chinese vocabulary and grammar from your own Excel file.
It runs in the browser on a computer and installs on an iPhone home screen; study works offline.

- **Words** come from `Hugo_chinese_vocab.xlsx` in your OneDrive. Rows filled green count as already studied.
- **Computer (Edge or Chrome on Windows):** link your OneDrive folder once; the app reads the Excel file from it
  and writes `Hugo_chinese_progress.xlsx` (status of every word, daily stats) back next to it.
- **iPhone:** add the site to the Home Screen; words and progress arrive through sync.
- **Sync** between devices goes through a private GitHub repository that only you can read, using a
  fine-grained token limited to that repository. No Microsoft or Azure registration is needed.
- **Study:** spaced repetition (FSRS), Quick memory (show or hide hanzi, pinyin, meaning), typed answers
  (pinyin, hanzi, meaning) and handwritten answers (stroke by stroke or free), English or French meanings, audio.

This repository holds only the app's code. Your words and progress never go here.

## Develop

```bash
npm install
npm run dev     # http://localhost:5173/HugoChineseAPP/
npm test
npm run build
```

Pushing to `main` deploys to GitHub Pages through `.github/workflows/deploy.yml`.

## Credits

- Stroke data: [Hanzi Writer](https://github.com/chanind/hanzi-writer) and hanzi-writer-data, derived from
  Make Me a Hanzi (Arphic Public License).
- Scheduling: [ts-fsrs](https://github.com/open-spaced-repetition/ts-fsrs). Pinyin: [pinyin-pro](https://github.com/zh-lx/pinyin-pro).
