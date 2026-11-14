# Hugo 中文

A personal app for learning Chinese vocabulary and grammar from your own Excel file.
It runs in the browser on a computer and installs on an iPhone home screen; study works offline.

- **Words** come from `Hugo_chinese_vocab.xlsx` in your OneDrive. Its row colours set each word's starting status
  (Mastered, Studying, Not known, Not studied); after that you set statuses yourself.
- **Sign in with Microsoft** (PC and iPhone): the app reads the workbook from OneDrive, writes the statuses you set back
  into it as cell fills (only the fills change, never a version you haven't seen, a backup first), and syncs your
  devices through a private OneDrive folder, `Apps/Hugo Chinese`.
- **Without Microsoft:** link the OneDrive folder on the computer (Edge or Chrome); the app writes a copy,
  `Hugo_chinese_vocab (app).xlsx`, next to the original and never writes the original. Devices then sync through a
  private GitHub repository with a fine-grained token.
- **Study:** spaced repetition (FSRS, optional; it never changes a status), Quick memory (show or hide hanzi, pinyin,
  meaning), typed and handwritten answers, dictionary senses and example sentences offline, "Explain more" with your own
  Claude key, English or French meanings, audio.

This repository holds only the app's code. Your words and progress never go here.

## Set up

1. **Publish the app (once):** Settings › Pages › Build and deployment › Source: **GitHub Actions**. Each push to
   `main` then builds and publishes it at https://hugzgj9.github.io/HugoChineseAPP/.
2. **Each device:** open that address (on the iPhone, add it to the Home Screen and open it from there) and choose
   **Sign in with Microsoft**. The app finds the workbook in your OneDrive; sync then runs on its own.
3. **Other ways (without Microsoft):** under the same name in Setup: link the OneDrive folder, join with a sync key
   (GitHub repository + token, see Settings › Sync), or import the file by hand.

### What sync stores

```
vocab.json.gz                          the word list, from the device that last read the workbook
settings.json                          study settings shared by all devices (latest change wins)
events/<device>/<YYYY-MM>.json         each device's review log; only that device writes it
marks/<device>/<YYYY-MM>.json          the statuses you set, per device
explain/<device>/<YYYY-MM>.json.gz     saved "Explain more" answers
devices/<device>.json                  written when a device links
```

In the OneDrive folder the same files have flat names (`events.<device>.<YYYY-MM>.json`). Every device replays all
logs through the same scheduler, so cards and statuses agree everywhere.

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
- French meanings: [CFDICT](https://chine.in/mandarin/dictionnaire/CFDICT/) by Chine Informations (CC BY-SA 3.0).
- QR codes: [qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator).
