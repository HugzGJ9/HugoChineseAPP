// The Anthropic Messages API, called straight from the browser with Hugo's own key.
// The key lives in kv `claudeKey` on this device only: never in prefs, settings, sync files, backups, the QR code or logs.
// It is only ever sent in the x-api-key header to api.anthropic.com.
import { kvGet, kvSet } from '../db';
import { normalizeExplanation, TOOL, TOOL_NAME } from './prompt';
import type { ClaudeErrorKind, Explanation } from './types';

export const EXPLAIN_MODEL = 'claude-sonnet-5-5';
export const API_BASE = 'https://api.anthropic.com/v1';
const KEY_KV = 'claudeKey';

/** Timeouts and retry pause (ms). Mutable for tests only. */
export const claudeTiming = { total: 120000, idle: 30000, retry: 1500 };

const MESSAGES: Record<ClaudeErrorKind, string> = {
  nokey: 'Add your Claude API key in Settings to get explanations.',
  offline: 'Needs a connection. Explanations you already have still show.',
  key: 'Claude refused the API key. Check it in Settings.',
  credit: 'Your Anthropic credit is used up. Add credit in the Anthropic Console.',
  model: "This key can't use the model.",
  rate: 'Too many requests. Try again in a minute.',
  busy: 'Claude is busy. Try again in a minute.',
  network: 'Claude could not be reached. Check the connection.',
  timeout: 'Claude took too long. Try again.',
  invalid: 'The answer could not be read. Try again.',
  other: 'Claude answered with an error.',
};

export class ClaudeError extends Error {
  kind: ClaudeErrorKind;
  /** HTTP status, 0 when there was no response. */
  status: number;
  /** Seconds to wait (429). */
  retryAfter?: number;
  constructor(kind: ClaudeErrorKind, status = 0, opts: { retryAfter?: number; detail?: string } = {}) {
    let message = MESSAGES[kind];
    if (kind === 'rate' && opts.retryAfter) message = `Too many requests. Try again in ${opts.retryAfter} s.`;
    if (kind === 'other' && opts.detail) message = `${message.slice(0, -1)}: ${opts.detail}`;
    super(message);
    this.name = 'ClaudeError';
    this.kind = kind;
    this.status = status;
    if (opts.retryAfter) this.retryAfter = opts.retryAfter;
  }
}

// ---------- the key ----------

interface StoredKey {
  key: string;
  savedAt: number;
}

export async function getClaudeKey(): Promise<string | null> {
  const s = await kvGet<StoredKey | null>(KEY_KV, null);
  return s && typeof s.key === 'string' && s.key ? s.key : null;
}

export async function saveClaudeKey(key: string): Promise<void> {
  const k = key.trim();
  if (!k) throw new Error('The key is empty.');
  await kvSet(KEY_KV, { key: k, savedAt: Date.now() } satisfies StoredKey);
}

export async function deleteClaudeKey(): Promise<void> {
  await kvSet(KEY_KV, null);
}

/** `sk-ant-…1a2b` and when it was saved, never the key itself. */
export async function claudeKeyHint(): Promise<{ hint: string; savedAt: number } | null> {
  const s = await kvGet<StoredKey | null>(KEY_KV, null);
  if (!s?.key) return null;
  const head = s.key.startsWith('sk-ant-') ? 'sk-ant-' : s.key.slice(0, 3);
  return { hint: `${head}…${s.key.length > 12 ? s.key.slice(-4) : ''}`, savedAt: s.savedAt };
}

function headers(key: string, json = false): Record<string, string> {
  const h: Record<string, string> = {
    'x-api-key': key,
    'anthropic-version': '2023-06-01',
    'anthropic-dangerous-direct-browser-access': 'true',
  };
  if (json) h['content-type'] = 'application/json';
  return h;
}

/** Remove the key from any text that leaves this module (API messages are not expected to hold it, but never risk it). */
function scrub(text: string, key: string): string {
  let t = text;
  if (key) t = t.split(key).join('[key]');
  return t.replace(/sk-ant-[\w-]+/g, 'sk-ant-…').slice(0, 300);
}

const offline = () => typeof navigator !== 'undefined' && navigator.onLine === false;

/** Map an HTTP error answer to a ClaudeError. */
async function httpError(res: Response, key: string): Promise<ClaudeError> {
  let type = '';
  let msg = '';
  try {
    const j = JSON.parse(await res.text()) as { error?: { type?: string; message?: string } };
    type = j.error?.type ?? '';
    msg = j.error?.message ?? '';
  } catch {
    // not JSON
  }
  const s = res.status;
  if (s === 401) return new ClaudeError('key', s);
  if (s === 400 && /credit balance/i.test(msg)) return new ClaudeError('credit', s);
  if (s === 403 || s === 404) return new ClaudeError('model', s);
  if (s === 429) {
    const ra = Number.parseInt(res.headers.get('retry-after') ?? '', 10);
    return new ClaudeError('rate', s, { retryAfter: Number.isFinite(ra) && ra > 0 ? ra : undefined });
  }
  if (s === 500 || s === 502 || s === 503 || s === 529 || type === 'overloaded_error') return new ClaudeError('busy', s);
  return new ClaudeError('other', s, { detail: scrub(msg || `HTTP ${s}`, key) });
}

/**
 * Check a key without spending anything: list the models. `checked: false` when the check itself could not run
 * (network, CORS); the key may still be fine. Throws a ClaudeError when Anthropic refuses it.
 */
export async function testClaudeKey(key: string): Promise<{ checked: boolean; modelListed?: boolean }> {
  const k = key.trim();
  if (!k) throw new ClaudeError('nokey');
  if (offline()) return { checked: false };
  let res: Response;
  try {
    res = await fetch(`${API_BASE}/models?limit=1000`, { method: 'GET', headers: headers(k) });
  } catch {
    return { checked: false };
  }
  if (!res.ok) {
    const e = await httpError(res, k);
    // A refused key is reported; anything else (busy, odd answers) does not make the key wrong.
    if (e.kind === 'key' || e.kind === 'credit') throw e;
    if (e.kind === 'model') throw new ClaudeError('key', res.status);
    return { checked: false };
  }
  try {
    const j = (await res.json()) as { data?: { id?: string }[] };
    const ids = (j.data ?? []).map((m) => m.id ?? '');
    return { checked: true, modelListed: ids.some((id) => id === EXPLAIN_MODEL || id.startsWith(`${EXPLAIN_MODEL}-`)) };
  } catch {
    return { checked: true };
  }
}

// ---------- one call ----------

export interface ClaudeAnswer {
  input: unknown;
  /** Input tokens (including cache reads and writes), output tokens. */
  usage: [number, number];
  model: string;
}

interface StreamEvent {
  type?: string;
  message?: { model?: string; usage?: Record<string, number> };
  index?: number;
  content_block?: { type?: string; name?: string };
  delta?: { type?: string; partial_json?: string; stop_reason?: string };
  usage?: Record<string, number>;
  error?: { type?: string; message?: string };
}

/**
 * One streamed call with forced tool use. `onProgress` gets the number of JSON characters received so far.
 * The tool input is parsed once, at the end.
 */
export async function callClaude(
  key: string,
  system: string,
  user: string,
  onProgress?: (chars: number) => void,
): Promise<ClaudeAnswer> {
  if (offline()) throw new ClaudeError('offline');
  const ctrl = new AbortController();
  let why: 'total' | 'idle' | null = null;
  const total = setTimeout(() => {
    why = 'total';
    ctrl.abort();
  }, claudeTiming.total);
  let idle: ReturnType<typeof setTimeout> | undefined;
  const touch = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      why = 'idle';
      ctrl.abort();
    }, claudeTiming.idle);
  };
  const body = {
    model: EXPLAIN_MODEL,
    max_tokens: 4096,
    stream: true,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: [TOOL],
    tool_choice: { type: 'tool', name: TOOL_NAME },
    messages: [{ role: 'user', content: user }],
  };
  try {
    touch();
    let res: Response;
    try {
      res = await fetch(`${API_BASE}/messages`, { method: 'POST', headers: headers(key, true), body: JSON.stringify(body), signal: ctrl.signal });
    } catch {
      throw new ClaudeError(why ? 'timeout' : offline() ? 'offline' : 'network');
    }
    if (!res.ok) throw await httpError(res, key);
    if (!res.body) throw new ClaudeError('network', res.status);

    let json = '';
    let toolIndex = -1;
    let input = 0;
    let output = 0;
    let model = EXPLAIN_MODEL;
    let stop = '';
    let done = false;
    const handle = (ev: StreamEvent) => {
      switch (ev.type) {
        case 'message_start': {
          const u = ev.message?.usage ?? {};
          input = (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0);
          output = u.output_tokens ?? 0;
          if (ev.message?.model) model = ev.message.model;
          break;
        }
        case 'content_block_start':
          if (ev.content_block?.type === 'tool_use' && ev.content_block.name === TOOL_NAME && toolIndex < 0) toolIndex = ev.index ?? 0;
          break;
        case 'content_block_delta':
          if (ev.delta?.type === 'input_json_delta' && (ev.index ?? 0) === toolIndex) {
            json += ev.delta.partial_json ?? '';
            onProgress?.(json.length);
          }
          break;
        case 'message_delta':
          if (typeof ev.usage?.output_tokens === 'number') output = ev.usage.output_tokens;
          if (ev.delta?.stop_reason) stop = ev.delta.stop_reason;
          break;
        case 'message_stop':
          done = true;
          break;
        case 'error': {
          const t = ev.error?.type ?? '';
          if (t === 'overloaded_error' || t === 'api_error') throw new ClaudeError('busy', 200);
          if (t === 'rate_limit_error') throw new ClaudeError('rate', 200);
          throw new ClaudeError('other', 200, { detail: scrub(ev.error?.message || t || 'stream error', key) });
        }
      }
    };

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const line = (raw: string) => {
      const l = raw.replace(/\r$/, '');
      if (!l.startsWith('data:')) return;
      const data = l.slice(5).trim();
      if (!data || data === '[DONE]') return;
      let ev: StreamEvent;
      try {
        ev = JSON.parse(data) as StreamEvent;
      } catch {
        return;
      }
      handle(ev);
    };
    try {
      for (;;) {
        let chunk: ReadableStreamReadResult<Uint8Array>;
        try {
          chunk = await reader.read();
        } catch {
          throw new ClaudeError(why ? 'timeout' : offline() ? 'offline' : 'network');
        }
        if (chunk.done) break;
        touch();
        buf += dec.decode(chunk.value, { stream: true });
        let nl: number;
        while ((nl = buf.indexOf('\n')) >= 0) {
          line(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
        if (done) break;
      }
      buf += dec.decode();
      if (buf) line(buf);
    } finally {
      reader.cancel().catch(() => {});
    }
    if (!done && !json) throw new ClaudeError('network', res.status);
    if (stop === 'max_tokens') throw new ClaudeError('invalid', res.status);
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      throw new ClaudeError('invalid', res.status);
    }
    return { input: parsed, usage: [input, output], model };
  } finally {
    clearTimeout(total);
    clearTimeout(idle);
  }
}

/** Ask, check the answer, and try once more after unreadable output or a busy server (500 / 529). */
export async function explainWithClaude(
  key: string,
  system: string,
  user: string,
  onProgress?: (chars: number) => void,
): Promise<{ x: Explanation; usage: [number, number]; model: string }> {
  for (let attempt = 0; ; attempt++) {
    try {
      const a = await callClaude(key, system, user, onProgress);
      const x = normalizeExplanation(a.input);
      if (!x) throw new ClaudeError('invalid', 200);
      return { x, usage: a.usage, model: a.model };
    } catch (e) {
      // Busy: HTTP 500 / 529, or an overloaded error in the stream (status 200).
      const retry = e instanceof ClaudeError && (e.kind === 'invalid' || (e.kind === 'busy' && [200, 500, 529].includes(e.status)));
      if (!retry || attempt >= 1) throw e instanceof ClaudeError ? e : new ClaudeError('other');
      onProgress?.(0);
      if (e.kind === 'busy') await new Promise((r) => setTimeout(r, claudeTiming.retry));
    }
  }
}
