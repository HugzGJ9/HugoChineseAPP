// Copies Hanzi Writer stroke data (one JSON per character) into public/hw so the
// app serves it from its own origin and can cache it for offline writing practice.
import { cpSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const src = 'node_modules/hanzi-writer-data';
const dest = 'public/hw';
if (!existsSync(src)) {
  console.warn('hanzi-writer-data not installed; writing practice will be unavailable');
  process.exit(0);
}
if (existsSync(join(dest, '学.json'))) process.exit(0);
mkdirSync(dest, { recursive: true });
let n = 0;
for (const f of readdirSync(src)) {
  if (!f.endsWith('.json') || f === 'package.json' || f === 'all.json') continue;
  cpSync(join(src, f), join(dest, f));
  n++;
}
console.log(`copied ${n} stroke files to ${dest}`);
