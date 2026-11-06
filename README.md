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

## Set up

1. **Publish the app (once):** Settings › Pages › Build and deployment › Source: **GitHub Actions**. Each push to
   `main` then builds and publishes it at https://hugzgj9.github.io/HugoChineseAPP/.
2. **Computer:** open that address in Edge or Chrome, choose **Link your OneDrive folder** and pick the folder that
   holds `Hugo_chinese_vocab.xlsx`. Install the app from the address bar if you like.
3. **Sync (once):** create a private repository, for example `HugoChineseData`, and a
   [fine-grained token](https://github.com/settings/personal-access-tokens/new) limited to that repository with
   *Contents: Read and write*. In the app: Settings › Sync › First device, fill in both.
4. **iPhone:** on the computer, Settings › Sync › Add another device shows a QR code and a sync key. Scan the code with
   the Camera, copy the key, add the page to the Home Screen, open it from there and paste the key.

### What sync stores

```
vocab.json.gz                   the word list, from the device that last read the Excel file
settings.json                   study settings shared by all devices (latest change wins)
events/<device>/<YYYY-MM>.json  each device's review log; only that device writes it
devices/<device>.json           written when a device links
```

Every device replays all review logs through the same scheduler, so cards agree everywhere. Sync runs at start-up,
20 seconds after you stop answering, when the app goes to the background and every few minutes while it is open.

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
