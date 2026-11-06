// A small client for the GitHub REST API, limited to what sync needs:
// list every file of the private data repository with its blob id, read a blob, write a file.

export interface RepoLink {
  owner: string;
  name: string;
  token: string;
}

export class GitHubError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const API = 'https://api.github.com';

function headers(link: RepoLink, extra?: Record<string, string>): Record<string, string> {
  return {
    Authorization: `Bearer ${link.token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...extra,
  };
}

async function call<T>(link: RepoLink, path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}/repos/${encodeURIComponent(link.owner)}/${encodeURIComponent(link.name)}${path}`, {
      ...init,
      cache: 'no-store',
      headers: headers(link, init.headers as Record<string, string> | undefined),
    });
  } catch {
    throw new GitHubError(0, 'GitHub could not be reached. Check the connection.');
  }
  if (!res.ok) {
    let detail = '';
    try {
      detail = ((await res.json()) as { message?: string }).message ?? '';
    } catch {
      // no JSON body
    }
    throw new GitHubError(res.status, explain(res.status, detail));
  }
  return (await res.json()) as T;
}

function explain(status: number, detail: string): string {
  if (status === 401) return 'GitHub refused the token. It may have expired: create a new one and link again.';
  if (status === 403 && /rate limit/i.test(detail)) return 'GitHub rate limit reached. Sync resumes in a few minutes.';
  if (status === 403) return 'The token cannot write to this repository. Give it "Contents: Read and write" on this repository.';
  if (status === 404) return 'Repository not found, or the token has no access to it.';
  return `GitHub answered ${status}${detail ? `: ${detail}` : ''}`;
}

export interface RepoInfo {
  full_name: string;
  private: boolean;
  default_branch: string;
  permissions?: { push?: boolean; pull?: boolean };
}

export function repoInfo(link: RepoLink): Promise<RepoInfo> {
  return call<RepoInfo>(link, '');
}

/** Every file in the repository: path → blob sha. An empty repository gives an empty map. */
export async function listFiles(link: RepoLink, branch: string): Promise<Map<string, string>> {
  try {
    const t = await call<{ tree: { path: string; type: string; sha: string }[]; truncated: boolean }>(
      link,
      `/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    );
    return new Map(t.tree.filter((e) => e.type === 'blob').map((e) => [e.path, e.sha]));
  } catch (e) {
    // 409: "Git Repository is empty". 404: the branch has no commit yet.
    if (e instanceof GitHubError && (e.status === 409 || e.status === 404)) return new Map();
    throw e;
  }
}

export async function readBlob(link: RepoLink, sha: string): Promise<Uint8Array> {
  const b = await call<{ content: string; encoding: string }>(link, `/git/blobs/${sha}`);
  return fromBase64(b.content);
}

/** Create or replace a file. `sha` is the blob being replaced (required when the file exists). Returns the new blob sha. */
export async function writeFile(link: RepoLink, branch: string, path: string, bytes: Uint8Array, sha: string | undefined, message: string): Promise<string> {
  const r = await call<{ content: { sha: string } }>(link, `/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ message, content: toBase64(bytes), branch, ...(sha ? { sha } : {}) }),
  });
  return r.content.sha;
}

export function toBase64(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

export function fromBase64(b64: string): Uint8Array {
  const s = atob(b64.replace(/\s/g, ''));
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** "owner/name", a github.com URL, or "git@github.com:owner/name.git" → owner and name. */
export function parseRepo(input: string): { owner: string; name: string } | null {
  const m = input
    .trim()
    .replace(/\.git$/, '')
    .match(/(?:github\.com[/:])?([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+)\/?$/);
  return m ? { owner: m[1], name: m[2] } : null;
}
