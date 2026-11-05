// Stroke data for Hanzi Writer, served from this site (public/hw, from hanzi-writer-data)
// and cached by the service worker, so writing practice works offline.
import { HAN } from './pinyin';

const BASE = import.meta.env.BASE_URL;

export function strokeUrl(ch: string): string {
  return `${BASE}hw/${encodeURIComponent(ch)}.json`;
}

const memo = new Map<string, Promise<unknown>>();

export function loadStrokes(ch: string): Promise<unknown> {
  let p = memo.get(ch);
  if (!p) {
    p = fetch(strokeUrl(ch)).then((r) => {
      if (!r.ok) throw new Error(`No stroke data for ${ch}`);
      return r.json();
    });
    p.catch(() => memo.delete(ch));
    memo.set(ch, p);
  }
  return p;
}

export function charDataLoader(ch: string, onLoad: (data: never) => void, onError: (e?: unknown) => void) {
  loadStrokes(ch).then((d) => onLoad(d as never), onError);
}

export function uniqueChars(texts: string[]): string[] {
  const set = new Set<string>();
  for (const t of texts) for (const c of t) if (HAN.test(c)) set.add(c);
  return [...set];
}

/** How many of these characters are already in the offline cache. */
export async function countCached(chars: string[]): Promise<number> {
  if (!('caches' in window)) return 0;
  const cache = await caches.open('strokes');
  let n = 0;
  for (const c of chars) {
    const url = new URL(strokeUrl(c), location.href).href;
    if (await cache.match(url)) n++;
  }
  return n;
}

/** Download stroke data for every character (fills the service worker cache). */
export async function prefetchStrokes(chars: string[], onProgress?: (done: number, total: number) => void): Promise<number> {
  if (!('caches' in window)) return 0;
  const cache = await caches.open('strokes');
  let done = 0;
  let missing = 0;
  const queue = [...chars];
  const worker = async () => {
    while (queue.length) {
      const c = queue.shift()!;
      const url = new URL(strokeUrl(c), location.href).href;
      if (!(await cache.match(url))) {
        try {
          const res = await fetch(url);
          if (res.ok) await cache.put(url, res.clone());
          else missing++;
        } catch {
          missing++;
        }
      }
      onProgress?.(++done, chars.length);
    }
  };
  await Promise.all(Array.from({ length: 6 }, worker));
  return missing;
}
