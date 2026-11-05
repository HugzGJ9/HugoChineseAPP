// Builds public/dict/cfdict.tsv (simplified \t pinyin \t meanings) from CFDICT,
// the free Chinese–French dictionary by Chine Informations (https://chine.in), CC BY-SA 3.0.
// Source: CFDICT_FILE (a local cfdict.u8) or the official download. Set CFDICT_REFRESH=1 to rebuild.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const URL = 'https://chine.in/assets/cfdict/cfdict.u8';
const OUT = 'public/dict/cfdict.tsv';

if (existsSync(OUT) && !process.env.CFDICT_REFRESH) process.exit(0);

let text;
try {
  if (process.env.CFDICT_FILE) {
    text = readFileSync(process.env.CFDICT_FILE, 'utf8');
  } else {
    const res = await fetch(URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  }
} catch (e) {
  console.warn(`CFDICT not available (${e.message}); French meanings will fall back to English.`);
  process.exit(0);
}

const LINE = /^(\S+)\s+(\S+)\s+\[([^\]]*)\]\s*\/(.*)\/\s*$/;
const bySimp = new Map();
let n = 0;
for (const raw of text.split(/\r?\n/)) {
  if (!raw || raw.startsWith('#')) continue;
  const m = LINE.exec(raw.replace(/\u200b/g, ''));
  if (!m) continue;
  const simp = m[2];
  if (!/\p{Script=Han}/u.test(simp)) continue;
  const proper = /^[A-Z]/.test(m[3].trim());
  const pinyin = m[3].trim().toLowerCase().replace(/u:/g, 'v').replace(/\s+/g, ' ');
  const defs = m[4]
    .split('/')
    .map((d) => d.trim().replace(/\t/g, ' '))
    .filter((d) => d && !/^CL:/.test(d));
  if (!defs.length) continue;
  if (!bySimp.has(simp)) bySimp.set(simp, []);
  bySimp.get(simp).push({ pinyin, defs, proper });
  n++;
}

const lines = [];
for (const [simp, entries] of [...bySimp.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
  const common = entries.filter((e) => !e.proper);
  for (const e of common.length ? common : entries) lines.push(`${simp}\t${e.pinyin}\t${e.defs.join('/')}`);
}
mkdirSync('public/dict', { recursive: true });
writeFileSync(OUT, lines.join('\n') + '\n');
console.log(`CFDICT: ${n} entries → ${lines.length} lines in ${OUT}`);
