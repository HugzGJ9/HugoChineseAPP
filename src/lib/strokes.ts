// Stroke data for Hanzi Writer, served from this site (public/hw, from hanzi-writer-data)
// and cached by the service worker, so writing practice works offline.
import { HAN } from './pinyin';
import { pref, setPref } from './db';
import { getState, subscribe } from './store';
import { dictUrl } from './import';

declare const __APP_VERSION__: string;

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

// ---------- offline warm-up ----------
// After the first online launch (and after each new app version) save the French dictionary, then the stroke data
// of Hugo's own words in idle batches of 50, so the import report and WritePad work offline without any tap.

export interface WarmStatus {
  phase: 'idle' | 'dict' | 'strokes' | 'done';
  done: number;
  total: number;
}

let status: WarmStatus = { phase: 'idle', done: 0, total: 0 };
const statusListeners = new Set<() => void>();
function setStatus(s: WarmStatus) {
  status = s;
  for (const l of statusListeners) l();
}
export const getWarmStatus = (): WarmStatus => status;
export function onWarmStatus(l: () => void): () => void {
  statusListeners.add(l);
  return () => statusListeners.delete(l);
}

const idle = () =>
  new Promise<void>((r) => {
    const ric = (window as unknown as { requestIdleCallback?: (f: () => void, o?: { timeout: number }) => void }).requestIdleCallback;
    if (ric) ric(() => r(), { timeout: 2000 });
    else setTimeout(r, 200);
  });

let running = false;
let again = false;
const noData = new Set<string>();

/** Characters of the vocabulary (grammar patterns have no stroke data worth keeping). */
function ownChars(): string[] {
  return uniqueChars(getState().notes.filter((n) => n.kind !== 'grammar').map((n) => n.hanzi + n.alts.join('')));
}

export async function warmOffline(): Promise<void> {
  if (!('caches' in window) || !navigator.onLine) return;
  if (running) {
    again = true;
    return;
  }
  running = true;
  try {
    const key = `warm.dict.${__APP_VERSION__}`;
    if (!pref(key, false)) {
      setStatus({ phase: 'dict', done: 0, total: 0 });
      try {
        const res = await fetch(dictUrl());
        if (res.ok) {
          await (await caches.open('dictionary')).put(dictUrl(), res);
          setPref(key, true);
        }
      } catch {
        // offline or blocked: tried again at the next launch
      }
    }
    const all = ownChars().filter((c) => !noData.has(c));
    const cache = await caches.open('strokes');
    const todo: string[] = [];
    for (const c of all) if (!(await cache.match(new URL(strokeUrl(c), location.href).href))) todo.push(c);
    let done = 0;
    for (let i = 0; i < todo.length && navigator.onLine; i += 50) {
      setStatus({ phase: 'strokes', done, total: todo.length });
      await idle();
      const batch = todo.slice(i, i + 50);
      await prefetchStrokes(batch);
      for (const c of batch) if (!(await cache.match(new URL(strokeUrl(c), location.href).href))) noData.add(c);
      done += batch.length;
    }
    setStatus({ phase: 'done', done, total: todo.length });
  } finally {
    running = false;
    if (again) {
      again = false;
      void warmOffline();
    }
  }
}

/** Runs the warm-up now (the dictionary does not need words) and again whenever the word list changes (a sync can bring it in later). */
export function startWarmOffline(): void {
  let seen: unknown = null;
  const run = () => {
    const notes = getState().notes;
    if (notes === seen) return;
    seen = notes;
    void warmOffline().catch(() => {});
  };
  subscribe(run);
  window.addEventListener('online', () => ((seen = null), run()));
  run();
}
