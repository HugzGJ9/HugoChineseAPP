// Copies the LXGW WenKai Medium web font (OFL-1.1, pre-split into unicode-range woff2 chunks) into
// public/kai so the app serves it from its own origin. The browser fetches only the chunks of the
// characters on screen; the service worker caches them at runtime and never precaches them.
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/@chinese-fonts/lxgwwenkai/dist/LXGWWenKai-Medium';
const dest = 'public/kai';
if (!existsSync(src)) {
  console.warn('@chinese-fonts/lxgwwenkai not installed; the Kai font will be unavailable');
  process.exit(0);
}
if (existsSync(join(dest, 'kai.css'))) process.exit(0);
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith('.woff2')) continue;
  cpSync(join(src, f), join(dest, f));
  n++;
}
copyFileSync(join(src, 'result.css'), join(dest, 'kai.css'));
copyFileSync('scripts/kai-OFL.txt', join(dest, 'OFL.txt'));
console.log(`copied ${n} font chunks to ${dest}`);
