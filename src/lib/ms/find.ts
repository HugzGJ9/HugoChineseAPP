// Finding a file in Hugo's OneDrive by its name, robustly. Consumer OneDrive search splits names into words (underscores,
// the extension) and can lag behind a file synced from the PC, so the exact name alone often finds nothing. In order:
//   1. direct path lookups (the drive root, the folder the file was last linked in),
//   2. searches for the name's words (without extension, underscores as spaces) and the full name,
//   3. the recent files list.
// Only exact (case-insensitive) name matches count, deduplicated by drive + item id. Each lookup reports its hit count,
// for the diagnostics (no file names or paths in the report).
import { GraphError, getByPath, recentFiles, searchFiles, type DriveItem } from './graph';

export interface LookupStep {
  /** What ran, without names or paths: 'path: root', 'search: words', 'recent'. */
  step: string;
  /** Exact-name matches it gave, or why it failed ('failed: 503'). */
  hits: number | string;
}

export interface Lookup {
  items: DriveItem[];
  steps: LookupStep[];
}

export interface LookupHints {
  /** The folder the file was last linked in: its drive and parentReference.path ('/drive/root:/Chinese'). */
  drive?: string;
  folder?: string;
  /** Run every lookup even after one found the file (the picker, diagnostics). */
  all?: boolean;
}

/** '/drive/root:/Chinese%20notes' → '/Chinese notes'; '' for the root or an unknown form. */
export function folderPath(parentPath: string | undefined): string {
  if (!parentPath) return '';
  const i = parentPath.indexOf(':');
  if (i < 0) return '';
  const rest = parentPath.slice(i + 1);
  let p: string = rest;
  try {
    p = decodeURIComponent(rest);
  } catch {
    // not percent-encoded
  }
  p = p.replace(/^\/+|\/+$/g, '');
  return p ? `/${p}` : '';
}

const key = (it: DriveItem) => `${it.parentReference?.driveId ?? ''}|${it.id}`;

/** Sign-in or network trouble stops the lookup: it says nothing about where the file is. */
const fatal = (e: unknown) => !(e instanceof GraphError) || e.status === 0 || e.status === 401;

function describe(e: unknown): string {
  return e instanceof GraphError ? `failed: ${e.status}${e.code ? ` ${e.code}` : ''}` : 'failed';
}

/** Files named exactly `name` (case-insensitive), found by path, search or the recent list. */
export async function locateFile(name: string, hints: LookupHints = {}): Promise<Lookup> {
  const fileName = name.trim();
  const want = fileName.toLowerCase();
  const steps: LookupStep[] = [];
  const found = new Map<string, DriveItem>();
  if (!want) return { items: [], steps };
  let ran = 0;
  let firstError: unknown;
  const run = async (step: string, get: () => Promise<DriveItem[]>) => {
    try {
      const hits = (await get()).filter((it) => it.name.toLowerCase() === want);
      for (const it of hits) if (!found.has(key(it))) found.set(key(it), it);
      steps.push({ step, hits: hits.length });
      ran++;
    } catch (e) {
      if (fatal(e)) throw e;
      firstError ??= e;
      steps.push({ step, hits: describe(e) });
    }
  };
  const byPath = (drive: string | undefined, path: string) => async () => {
    try {
      const it = await getByPath(drive, path);
      return it.file && !(it as { folder?: unknown }).folder ? [it] : [];
    } catch (e) {
      if (e instanceof GraphError && e.status === 404) return [];
      throw e;
    }
  };

  // 1. Direct paths.
  await run('path: root', byPath(undefined, `/${fileName}`));
  const folder = folderPath(hints.folder);
  if (folder) await run('path: last folder', byPath(hints.drive || undefined, `${folder}/${fileName}`));
  if (found.size && !hints.all) return done();

  // 2. Search: the words first (what consumer search matches), the full name last.
  const stem = fileName.replace(/\.[^./]+$/, '');
  const queries: [string, string][] = [
    ['search: name without extension', stem],
    ['search: words', stem.replace(/_+/g, ' ').trim()],
    ['search: full name', fileName],
  ];
  const seen = new Set<string>();
  for (const [step, q] of queries) {
    if (!q || seen.has(q.toLowerCase())) continue;
    seen.add(q.toLowerCase());
    await run(step, () => searchFiles(q));
  }
  if (found.size && !hints.all) return done();

  // 3. Recently opened files.
  await run('recent', () => recentFiles());
  return done();

  function done(): Lookup {
    // Every lookup failed (Graph errors, not "not found"): that is an error, not a missing file.
    if (!ran && firstError) throw firstError;
    return { items: [...found.values()], steps };
  }
}

/** Excel files OneDrive lists (search for the extension, then recent files), newest first, at most `limit`: for picking by hand. */
export async function listExcelFiles(limit = 200): Promise<Lookup> {
  const steps: LookupStep[] = [];
  const found = new Map<string, DriveItem>();
  let ran = 0;
  let firstError: unknown;
  for (const [step, get] of [
    ['search: .xlsx', () => searchFiles('.xlsx', limit)],
    ['search: xlsx', () => searchFiles('xlsx', limit)],
    ['recent', () => recentFiles(limit)],
  ] as [string, () => Promise<DriveItem[]>][]) {
    if (found.size >= limit) break;
    try {
      const hits = (await get()).filter((it) => /\.xlsx$/i.test(it.name));
      for (const it of hits) if (found.size < limit && !found.has(key(it))) found.set(key(it), it);
      steps.push({ step, hits: hits.length });
      ran++;
    } catch (e) {
      if (fatal(e)) throw e;
      firstError ??= e;
      steps.push({ step, hits: describe(e) });
    }
  }
  if (!ran && firstError) throw firstError;
  const items = [...found.values()].sort((a, b) => Date.parse(b.lastModifiedDateTime) - Date.parse(a.lastModifiedDateTime));
  return { items, steps };
}

/** One line per lookup for the diagnostics: 'path: root 0, search: words 1, recent 0'. */
export function formatSteps(steps: LookupStep[]): string {
  return steps.map((s) => `${s.step} ${s.hits}`).join(', ') || 'none';
}
