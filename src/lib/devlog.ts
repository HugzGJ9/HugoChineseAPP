// Device log: what went wrong on this device, for "Copy diagnostics" in Settings (plan 2026-11-26-boot-and-guards D11).
// Stored in kv `devlog` = { v: 1, entries: LogEntry[] } (newest last, at most 60). Device-only: never synced, never in a
// backup (backups export named rows only), ignored by older app versions (no kv prefix scan matches it).
// Captured: uncaught errors and unhandled rejections (message, file:line:col, top stack frames), and the warnings the
// store already holds (sync warnings and errors, "update needed", Excel and folder write errors and messages, stuck rows,
// Microsoft reconnect/error, "reload needed"), each logged once when it changes. Never read: the account, the repository,
// workbook names and paths, the folder name, the file name setting, the import source.
// Everything is scrubbed when captured (`scrub`), so nothing unscrubbed is ever stored. In this order:
//   1. secrets → [secret]: Claude keys, GitHub tokens, sync keys (hz1.…, they hold the token), JWTs, Bearer values,
//      code/token/access_token/refresh_token/key query parameters;
//   2. emails → [email];
//   3. URLs: on the app's origin → file basename (+ :line:col), elsewhere → host only;
//   4. workbook file names (*.xlsx, xlsm, xls, csv) → [workbook];
//   5. quoted text: “…” ‘…’ «…» always emptied (the app quotes folder and file names that way); "…" and '…' emptied
//      when they hold a non-ASCII character or more than 32 characters (keeps `reading 'note'`); the source snippet of a
//      V8 JSON error ("… is not valid JSON") always;
//   6. Han, kana, hangul, fullwidth runs, and words with a pinyin tone mark (any of the four) → …;
//   7. at most 300 characters per message, 400 per stack.
// The logger never throws and never logs its own storage errors. Entries live in memory first; the stored ones are
// merged in once the store is ready, and writes wait for that (debounced 1 s, only while the database is open).
import { db, kvGet, kvSet } from './db';
import { getState, subscribe, type AppState } from './store';
import { syncTarget } from './sync';

declare const __APP_VERSION__: string;

export type LogKind = 'error' | 'rejection' | 'sync' | 'excel' | 'folder' | 'ms' | 'app';
/** `at`: file:line:col; `n`: repeats; `stack`: top frames, scrubbed. */
export interface LogEntry {
  t: number;
  kind: LogKind;
  msg: string;
  at?: string;
  n?: number;
  stack?: string;
}

const KEY = 'devlog';
const MAX_ENTRIES = 60;
const MAX_MSG = 300;
const MAX_STACK = 400;
const SAVE_DELAY_MS = 1000;
const STACK_FRAMES = 4;

interface Stored {
  v: 1;
  entries: LogEntry[];
}

let entries: LogEntry[] = [];
let started = false;
let loaded = false;
let loading: Promise<void> | null = null;
let readyMs: number | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let saving: Promise<void> = Promise.resolve();
const listeners = new Set<() => void>();

// ---------- scrub ----------

const SECRETS: [RegExp, string][] = [
  [/\bsk-ant-[\w-]+/g, '[secret]'],
  [/\bgithub_pat_\w+/g, '[secret]'],
  [/\bgh[pousr]_[A-Za-z0-9]+/g, '[secret]'],
  [/\bhz1\.[\w-]+/g, '[secret]'],
  [/\beyJ[\w-]*\.[\w-]+\.[\w-]*/g, '[secret]'],
  [/\bBearer\s+[^\s,;"']+/gi, 'Bearer [secret]'],
  [/(^|[?&#;\s])(code|token|access_token|refresh_token|id_token|key)=[^&#\s"']+/gi, '$1$2=[secret]'],
  [/"(code|token|access_token|refresh_token|id_token|key)"\s*:\s*"[^"]*"/gi, '"$1":"[secret]"'],
];
const EMAIL = /[\w.%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
const URL_RE = /\b(?:blob:)?(?:https?|wss?|file):\/\/[^\s()"'<>{}]+/g;
const WORKBOOK = /[^\s"'“”‘’«»<>|\\/:*?()[\]]+(?: \([^()\s]*\))?\.(?:xlsx|xlsm|xls|csv)\b/gi;
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}　-〿＀-￯]+/gu;
// Any tone mark, rising and falling included (kèrén, xuéxí): browser error messages are English, so a French word
// caught here (réseau) costs little, a pinyin word let through would be one of Hugo's words.
const TONED = /[\p{L}\p{M}]*[āēīōūǎěǐǒǔǖǘǚǜáéíóúàèìòùĀĒĪŌŪǍĚǏǑǓǕǗǙǛÁÉÍÓÚÀÈÌÒÙ\u0300\u0301\u0304\u030C][\p{L}\p{M}]*/gu;

function appOrigin(): string | undefined {
  try {
    return typeof location !== 'undefined' && location.origin && location.origin !== 'null' ? location.origin : undefined;
  } catch {
    return undefined;
  }
}

function shortUrl(raw: string, origin: string | undefined): string {
  const tail = /[.,;!?]+$/.exec(raw)?.[0] ?? '';
  let u = tail ? raw.slice(0, -tail.length) : raw;
  // A stack location (…/index-x.js:1:2345), not a port: only after a path.
  const m = /^((?:blob:)?[a-z]+:\/\/[^/]+\/.*?)((?::\d+){1,2})$/i.exec(u);
  const lc = m ? m[2] : '';
  if (m) u = m[1];
  try {
    const url = new URL(u.replace(/^blob:/i, ''));
    if (origin && url.origin === origin) {
      const base = url.pathname.split('/').filter(Boolean).pop() ?? '';
      return (base || url.host) + lc + tail;
    }
    return (url.host || 'url') + tail;
  } catch {
    return 'url' + tail;
  }
}

function emptyQuoted(open: string, close: string) {
  return (_: string, inner: string) => (/[^\x20-\x7E]/.test(inner) || inner.length > 32 ? `${open}…${close}` : `${open}${inner}${close}`);
}

function cap(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function clean(text: string, max: number): string {
  let s = text;
  for (const [re, to] of SECRETS) s = s.replace(re, to);
  s = s.replace(EMAIL, '[email]');
  const origin = appOrigin();
  s = s.replace(URL_RE, (u) => shortUrl(u, origin));
  s = s.replace(WORKBOOK, '[workbook]');
  s = s
    .replace(/, "[\s\S]*" is not valid JSON/g, ', "…" is not valid JSON')
    .replace(/“[^”]*”/g, '“…”')
    .replace(/‘[^’]*’/g, '“…”')
    .replace(/«[^»]*»/g, '“…”')
    .replace(/"([^"\n]*)"/g, emptyQuoted('"', '"'))
    .replace(/(?<![A-Za-z0-9])'([^'\n]*)'(?![A-Za-z0-9])/g, emptyQuoted("'", "'"));
  s = s.replace(CJK, '…').replace(TONED, '…').replace(/…(?:[ \t]*…)+/g, '…');
  return cap(s, max);
}

/** The text with secrets, emails, URLs, file names, quoted names and Chinese words taken out (see the header). */
export function scrub(text: string): string {
  try {
    return clean(String(text ?? ''), MAX_MSG);
  } catch {
    return '[unreadable]';
  }
}

// ---------- entries ----------

function notify() {
  for (const l of [...listeners]) {
    try {
      l();
    } catch {
      // a listener's problem is not the log's
    }
  }
}

function add(e: Omit<LogEntry, 't' | 'n'>) {
  const last = entries[entries.length - 1];
  const t = Date.now();
  if (last && last.kind === e.kind && last.msg === e.msg && last.at === e.at) {
    entries = [...entries.slice(0, -1), { ...last, t, n: (last.n ?? 1) + 1 }];
  } else {
    entries = [...entries, { t, ...e }].slice(-MAX_ENTRIES);
  }
  scheduleSave();
  notify();
}

/** An uncaught error or rejection (or one the app caught and wants on record). */
export function recordError(e: unknown, kind: 'error' | 'rejection' = 'error'): void {
  try {
    const { msg, stack } = describe(e);
    if (/ResizeObserver loop/i.test(msg)) return;
    add({ kind, msg: scrub(msg), ...located(undefined, stack) });
  } catch {
    // never throws
  }
}

/** A warning shown by the app (sync, Excel, folder, Microsoft). */
export function logWarning(kind: LogKind, msg: string): void {
  try {
    if (!msg) return;
    add({ kind, msg: scrub(msg) });
  } catch {
    // never throws
  }
}

function describe(e: unknown): { msg: string; stack?: string } {
  if (e instanceof Error || (e && typeof e === 'object' && 'message' in e)) {
    const err = e as Error;
    const name = typeof err.name === 'string' && err.name ? err.name : 'Error';
    const message = typeof err.message === 'string' ? err.message : String(err.message);
    return { msg: message ? `${name}: ${message}` : name, stack: typeof err.stack === 'string' ? err.stack : undefined };
  }
  try {
    return { msg: typeof e === 'string' ? e : String(e) };
  } catch {
    return { msg: 'Unknown error' };
  }
}

/** Top frames (scrubbed) and the first frame's file:line:col, unless the event gave one. */
function located(at: string | undefined, stack: string | undefined): { at?: string; stack?: string } {
  const out: { at?: string; stack?: string } = {};
  if (at) out.at = clean(at, 120);
  if (!stack) return out;
  const frames = stack
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^at\s|@|:\d+:\d+\)?$/.test(l))
    .slice(0, STACK_FRAMES);
  if (!frames.length) return out;
  out.stack = clean(frames.join('\n'), MAX_STACK);
  if (!out.at) {
    const loc = /([^\s()@]+:\d+:\d+)\)?$/.exec(out.stack.split('\n')[0]);
    if (loc) out.at = loc[1];
  }
  return out;
}

function onError(ev: Event) {
  try {
    const e = ev as ErrorEvent;
    const msg = e.error != null ? describe(e.error).msg : String(e.message ?? 'Script error');
    if (/ResizeObserver loop/i.test(msg)) return;
    const at = e.filename ? `${e.filename}:${e.lineno ?? 0}:${e.colno ?? 0}` : undefined;
    const stack = e.error && typeof (e.error as Error).stack === 'string' ? (e.error as Error).stack : undefined;
    add({ kind: 'error', msg: scrub(msg), ...located(at, stack) });
  } catch {
    // never throws
  }
}

function onRejection(ev: Event) {
  try {
    recordError((ev as PromiseRejectionEvent).reason, 'rejection');
  } catch {
    // never throws
  }
}

// ---------- store watch ----------

interface Seen {
  warnings: readonly string[];
  syncError?: string;
  updateNeeded?: boolean;
  excelWrite?: string;
  excelMsg?: string;
  stuck?: number;
  folderWrite?: string;
  folderMsg?: string;
  msMsg?: string;
  reload?: boolean;
}
let seen: Seen = { warnings: [] };

const changed = <T>(next: T | undefined, prev: T | undefined): next is T => next !== undefined && next !== prev;

function watch(s: AppState) {
  const next: Seen = {
    warnings: s.sync.warnings ?? [],
    syncError: s.sync.state === 'error' ? s.sync.message || 'Sync failed.' : undefined,
    updateNeeded: s.sync.updateNeeded || undefined,
    excelWrite: s.excel.writeError || undefined,
    excelMsg: s.excel.state === 'error' || s.excel.state === 'missing' ? s.excel.message || `Workbook ${s.excel.state}.` : undefined,
    stuck: s.excel.stuck || undefined,
    folderWrite: s.folder.writeError || undefined,
    folderMsg:
      s.folder.state === 'error' || s.folder.state === 'missing' || s.folder.state === 'permission'
        ? s.folder.message || `Folder: ${s.folder.state === 'permission' ? 'permission needed' : s.folder.state}.`
        : undefined,
    msMsg: s.ms.state === 'reconnect' || s.ms.state === 'error' ? s.ms.message || `Microsoft sign-in: ${s.ms.state}.` : undefined,
    reload: s.needsReload || undefined,
  };
  const prev = seen;
  seen = next;
  for (const w of next.warnings) if (!prev.warnings.includes(w)) logWarning('sync', w);
  if (changed(next.syncError, prev.syncError)) logWarning('sync', next.syncError);
  if (changed(next.updateNeeded, prev.updateNeeded)) logWarning('sync', 'The synced data was saved by a newer app version: update needed.');
  if (changed(next.excelWrite, prev.excelWrite)) logWarning('excel', next.excelWrite);
  if (changed(next.excelMsg, prev.excelMsg)) logWarning('excel', next.excelMsg);
  if (changed(next.stuck, prev.stuck)) logWarning('excel', `${next.stuck} statuses stuck: their rows no longer hold the expected word.`);
  if (changed(next.folderWrite, prev.folderWrite)) logWarning('folder', next.folderWrite);
  if (changed(next.folderMsg, prev.folderMsg)) logWarning('folder', next.folderMsg);
  if (changed(next.msMsg, prev.msMsg)) logWarning('ms', next.msMsg);
  if (changed(next.reload, prev.reload)) logWarning('app', 'Another tab opened a newer version of the database: reload needed.');
}

function onStore() {
  try {
    const s = getState();
    if (s.ready && readyMs === undefined) {
      readyMs = typeof performance !== 'undefined' ? Math.round(performance.now()) : undefined;
      readyMs ??= 0;
      void load();
    }
    watch(s);
  } catch {
    // never throws
  }
}

// ---------- storage ----------

function load(): Promise<void> {
  loading ??= (async () => {
    try {
      const row = await kvGet<Stored | null>(KEY, null);
      const old = row && row.v === 1 && Array.isArray(row.entries) ? row.entries.filter(validEntry) : [];
      if (old.length) {
        entries = [...old, ...entries].sort((a, b) => a.t - b.t).slice(-MAX_ENTRIES);
        notify();
      }
    } catch {
      // unreadable row: start a new log
    }
    loaded = true;
    if (entries.length) scheduleSave();
  })();
  return loading;
}

function validEntry(e: unknown): e is LogEntry {
  const x = e as LogEntry;
  return !!x && typeof x === 'object' && typeof x.t === 'number' && typeof x.kind === 'string' && typeof x.msg === 'string';
}

function scheduleSave() {
  if (!loaded) return; // saved once the stored entries are merged in
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void save(), SAVE_DELAY_MS);
}

function save(): Promise<void> {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  saving = saving.then(async () => {
    try {
      if (!loaded || !db.isOpen()) return;
      await kvSet(KEY, { v: 1, entries } satisfies Stored);
    } catch {
      // the logger never logs itself
    }
  });
  return saving;
}

/** Write a pending change now (the app goes to the background; tests). */
export async function flushDevLog(): Promise<void> {
  try {
    if (loading) await loading;
    if (saveTimer !== undefined) await save();
    else await saving;
  } catch {
    // never throws
  }
}

// ---------- public ----------

/** Start capturing. Call first thing at boot; idempotent, never throws. */
export function startDevLog(): void {
  if (started) return;
  started = true;
  try {
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('error', onError);
      window.addEventListener('unhandledrejection', onRejection);
      window.addEventListener('pagehide', () => void flushDevLog());
    }
    if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') void flushDevLog();
      });
    }
    subscribe(onStore);
    onStore();
  } catch {
    // never throws
  }
}

/** The entries, oldest first. */
export function devLogEntries(): LogEntry[] {
  return entries;
}

const isError = (e: LogEntry) => e.kind === 'error' || e.kind === 'rejection';

export function devLogSummary(): { errors: number; warnings: number } {
  let errors = 0;
  for (const e of entries) if (isError(e)) errors++;
  return { errors, warnings: entries.length - errors };
}

export function onDevLogChange(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export async function clearDevLog(): Promise<void> {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  entries = [];
  notify();
  try {
    await saving;
    if (db.isOpen()) await db.kv.delete(KEY);
  } catch {
    // swallowed
  }
}

// ---------- diagnostics ----------

const pad = (n: number) => String(n).padStart(2, '0');
const hhmm = (d: Date) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

function utcOffset(d: Date): string {
  const off = -d.getTimezoneOffset();
  const a = Math.abs(off);
  return `UTC${off < 0 ? '-' : '+'}${pad(Math.floor(a / 60))}:${pad(a % 60)}`;
}

function ago(t: number, now: number): string {
  const min = Math.round((now - t) / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.round(min / 60);
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
}

function browser(): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent || '' : '';
  const v = (re: RegExp) => re.exec(ua)?.[1];
  if (v(/Edg(?:A|iOS)?\/(\d+)/)) return `Edge ${v(/Edg(?:A|iOS)?\/(\d+)/)}`;
  if (v(/(?:Firefox|FxiOS)\/(\d+)/)) return `Firefox ${v(/(?:Firefox|FxiOS)\/(\d+)/)}`;
  if (v(/(?:Chrome|CriOS)\/(\d+)/)) return `Chrome ${v(/(?:Chrome|CriOS)\/(\d+)/)}`;
  const ios = /(?:iPhone|iPad|iPod).* OS (\d+)_(\d+)/.exec(ua);
  if (v(/Version\/(\d+(?:\.\d+)?).*Safari/)) return `Safari ${v(/Version\/(\d+(?:\.\d+)?).*Safari/)}`;
  if (ios) return `Safari (iOS ${ios[1]}.${ios[2]})`;
  if (/Node\.js|node/i.test(ua)) return 'Node';
  return 'unknown browser';
}

function displayMode(): string {
  try {
    const standalone =
      (typeof navigator !== 'undefined' && (navigator as Navigator & { standalone?: boolean }).standalone === true) ||
      (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches);
    return standalone ? 'Home Screen app' : 'browser tab';
  } catch {
    return 'browser tab';
  }
}

function cardsLine(): string {
  try {
    if (typeof performance === 'undefined' || typeof performance.getEntriesByName !== 'function') return 'cards n/a';
    const m = performance.getEntriesByName('hz:cards', 'measure')[0] as PerformanceMeasure | undefined;
    const d = m?.detail as { total?: number; cached?: number; replayed?: number; full?: boolean } | undefined;
    if (!m || !d || typeof d.total !== 'number') return 'cards n/a';
    const ms = Math.round(m.duration);
    return d.full ? `cards ${ms} ms, full replay of ${d.total}` : `cards ${ms} ms, ${d.cached ?? 0} of ${d.total} from cache`;
  } catch {
    return 'cards n/a';
  }
}

async function storageLine(): Promise<string> {
  try {
    const st = typeof navigator !== 'undefined' ? navigator.storage : undefined;
    if (!st) return 'n/a';
    const [persisted, est] = await Promise.all([
      st.persisted ? st.persisted().catch(() => undefined) : undefined,
      st.estimate ? st.estimate().catch(() => undefined) : undefined,
    ]);
    const parts: string[] = [persisted === true ? 'persisted' : persisted === false ? 'not persisted' : 'persistence n/a'];
    if (est?.usage != null) parts.push(`${Math.round(est.usage / (1024 * 1024))} MB used`);
    return parts.join(', ');
  } catch {
    return 'n/a';
  }
}

function problemLine(e: LogEntry, now: Date): string {
  const d = new Date(e.t);
  const time = `${ymd(d) === ymd(now) ? '' : `${ymd(d)} `}${hhmm(d)}:${pad(d.getSeconds())}`;
  let line = `${time} ${e.kind} ${e.msg}`;
  if (e.at) line += ` at ${e.at}`;
  if (e.n && e.n > 1) line += ` (×${e.n})`;
  if (e.stack) line += '\n' + e.stack.split('\n').map((f) => `    ${f}`).join('\n');
  return line;
}

/** Plain text for Hugo to paste into a chat: versions, counts, states and the last problems; no words, names or tokens. */
export async function diagnosticsText(): Promise<string> {
  const now = new Date();
  const s = getState();
  const version = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
  const online = typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online';
  let target = 'off';
  try {
    const t = await syncTarget();
    target = t === 'onedrive' ? 'OneDrive' : t === 'github' ? 'GitHub' : 'off';
  } catch {
    target = 'n/a';
  }
  let sync = target === 'off' ? 'off' : `${target}, ${s.sync.state}`;
  if (target !== 'off' && s.sync.last) sync += `, last ${hhmm(new Date(s.sync.last))} (${ago(s.sync.last, now.getTime())})`;
  if (s.sync.warnings?.length) sync += `, ${s.sync.warnings.length} warnings`;
  const excel = s.excel.state === 'off' ? 'off' : `${s.excel.state}, ${s.excel.pending ?? 0} waiting${s.excel.stuck ? `, ${s.excel.stuck} stuck` : ''}`;
  const errors = entries.filter(isError).slice(-20);
  const warnings = entries.filter((e) => !isError(e)).slice(-10);
  const order = new Map(entries.map((e, i) => [e, i]));
  const problems = [...errors, ...warnings].sort((a, b) => order.get(b)! - order.get(a)!);
  const lines = [
    `Hugo 中文 diagnostics, ${ymd(now)} ${hhmm(now)} (${utcOffset(now)})`,
    `App ${version} · ${s.device || 'no device id'} · ${displayMode()} · ${browser()} · ${online}`,
    `Data: ${s.notes.length} words, ${s.events.length} reviews, ${s.marks.length} marks`,
    `Start: ${readyMs !== undefined ? `ready in ${readyMs} ms` : 'not ready'} · ${cardsLine()}`,
    `Sync: ${sync} · Excel: ${excel} · Folder: ${s.folder.state} · Microsoft: ${s.ms.state}`,
    `Storage: ${await storageLine()}`,
    problems.length ? 'Problems (newest first):' : 'Problems: none',
    ...problems.map((e) => problemLine(e, now)),
  ];
  return lines.join('\n');
}
