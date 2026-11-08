// Microsoft sign-in, the OneDrive workbook line, diagnostics, and the reconnect banner.
import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { msConfigured, msSignIn, msSignOut } from '../lib/ms/auth';
import { runDiagnostics } from '../lib/ms/diagnostics';
import type { DriveItem } from '../lib/ms/graph';
import { checkWorkbook, findWorkbooks, linkWorkbook, unlinkWorkbook } from '../lib/workbook';
import { formatAgo, formatDate, toast, useNow } from './common';

const errText = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

/** Where a file sits, without the drive prefix: "/drive/root:/Documents" → "Documents". */
function folderOf(it: DriveItem): string {
  const p = it.parentReference?.path ?? '';
  const i = p.indexOf(':');
  return (i >= 0 ? p.slice(i + 1) : p).replace(/^\/+/, '') || 'OneDrive';
}

function SignInButton({ label = 'Sign in with Microsoft', primary = true }: { label?: string; primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <button
          type="button"
          className={`btn ${primary ? 'primary' : ''}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              await msSignIn();
            } catch (e) {
              setError(errText(e));
              setBusy(false);
            }
          }}
        >
          {busy ? 'Opening Microsoft…' : label}
        </button>
      </div>
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}

function WorkbookPicker({ items, onDone }: { items: DriveItem[]; onDone: () => void }) {
  const [busy, setBusy] = useState('');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <p className="small">Pick your workbook:</p>
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          className="btn block"
          style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '8px 14px', minHeight: 44, whiteSpace: 'normal' }}
          disabled={!!busy}
          onClick={async () => {
            setBusy(it.id);
            try {
              await linkWorkbook(it);
              onDone();
            } catch (e) {
              toast(errText(e));
              setBusy('');
            }
          }}
        >
          <span style={{ display: 'block', minWidth: 0, overflowWrap: 'anywhere' }}>
            {it.name}
            <span className="small muted" style={{ display: 'block' }}>
              {folderOf(it)} · {formatDate(Date.parse(it.lastModifiedDateTime))}
            </span>
          </span>
        </button>
      ))}
      <div>
        <button type="button" className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** The signed-in account and the linked workbook. */
function SignedIn() {
  const ms = useApp((s) => s.ms);
  const excel = useApp((s) => s.excel);
  const now = useNow(30000);
  const [choices, setChoices] = useState<DriveItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true);
    try {
      const found = await findWorkbooks();
      if (!found.length) toast('No matching workbook found in your OneDrive');
      else if (found.length === 1 && excel.state === 'off') await linkWorkbook(found[0]);
      else setChoices(found);
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const linked = excel.state !== 'off';
  return (
    <div className="stack">
      <p className="small">
        Signed in{ms.account ? <> as <b style={{ overflowWrap: 'anywhere' }}>{ms.account}</b></> : ''}.
      </p>
      {ms.state === 'error' && ms.message && <p className="notice bad">{ms.message}</p>}
      {linked && (
        <p className="small" style={{ overflowWrap: 'anywhere' }}>
          {excel.name ?? 'Workbook'}
          {excel.checked ? `, read ${formatAgo(excel.checked, now)}` : ''}.
        </p>
      )}
      {excel.state === 'missing' && <p className="notice bad">The workbook is not in your OneDrive any more. Change workbook to pick it again.</p>}
      {excel.state === 'error' && excel.message && <p className="notice bad">{excel.message}</p>}
      {!linked && !choices && <p className="small muted">No workbook linked yet.</p>}
      {choices ? (
        <WorkbookPicker items={choices} onDone={() => setChoices(null)} />
      ) : (
        <div className="row wrap">
          {linked && (
            <button type="button" className="btn small" onClick={() => checkWorkbook(true).catch((e) => toast(errText(e)))}>
              Read now
            </button>
          )}
          <button type="button" className="btn small" disabled={busy} onClick={find}>
            {busy ? 'Searching…' : linked ? 'Change workbook' : 'Find workbook'}
          </button>
          {linked && (
            <button type="button" className="btn small ghost" onClick={() => unlinkWorkbook()}>
              Unlink
            </button>
          )}
          <button
            type="button"
            className="btn small ghost"
            onClick={async () => {
              if (window.confirm('Sign out of Microsoft on this device? Words and reviews stay on it.')) await msSignOut();
            }}
          >
            Sign out
          </button>
        </div>
      )}
    </div>
  );
}

/** Microsoft panel for the first-run screen and Settings. Hidden until the app has a client id. */
export function MicrosoftPanel({ bare = false, explainOff = false }: { bare?: boolean; explainOff?: boolean }) {
  const ms = useApp((s) => s.ms);
  if (!msConfigured()) return explainOff ? <MicrosoftNotConfigured /> : null;
  const body =
    ms.state === 'off' ? (
      <>
        <p className="muted small">Reads Hugo_chinese_vocab.xlsx from your OneDrive. Sign in once on each device; on iPhone, in the Home Screen app.</p>
        <SignInButton />
      </>
    ) : ms.state === 'reconnect' ? (
      <>
        <p className="notice">Microsoft sign-in expired. Excel and sync are waiting.</p>
        <SignInButton label="Reconnect" />
      </>
    ) : (
      <SignedIn />
    );
  if (bare) return <div className="stack">{body}</div>;
  return (
    <section className="panel stack" aria-labelledby="ms-h">
      <h2 id="ms-h">Microsoft</h2>
      {body}
    </section>
  );
}

/** Shown when Microsoft is not set up in this build (the client id is still the placeholder). */
function MicrosoftNotConfigured() {
  return <p className="small muted">Microsoft sign-in is not configured yet.</p>;
}

/** Settings › More: runs the checks against the real account and shows a plain-text report. */
export function MicrosoftDiagnostics() {
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState('');
  const [copied, setCopied] = useState(false);
  const ms = useApp((s) => s.ms.state);
  if (!msConfigured()) return <p className="small muted">Microsoft diagnostics: Microsoft sign-in is not configured yet.</p>;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <button
          type="button"
          className="btn"
          disabled={busy || ms !== 'ok'}
          onClick={async () => {
            setBusy(true);
            setReport('');
            try {
              setReport(await runDiagnostics());
            } catch (e) {
              setReport(`Diagnostics failed: ${errText(e)}`);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Running…' : 'Microsoft diagnostics'}
        </button>
      </div>
      {ms !== 'ok' && <p className="small muted">Sign in with Microsoft first.</p>}
      {report && (
        <>
          <textarea readOnly aria-label="Microsoft diagnostics report" value={report} rows={10} style={{ fontSize: 16 }} onFocus={(e) => e.currentTarget.select()} />
          <div>
            <button
              type="button"
              className="btn small"
              onClick={async () => {
                try {
                  await navigator.clipboard.writeText(report);
                  setCopied(true);
                  setTimeout(() => setCopied(false), 2000);
                } catch {
                  toast('Copy failed: select the text and copy it by hand');
                }
              }}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
        </>
      )}
    </div>
  );
}

/** Top banner when the Microsoft sign-in has expired. */
export function ReconnectBanner() {
  const state = useApp((s) => s.ms.state);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (state !== 'reconnect') setBusy(false);
  }, [state]);
  if (state !== 'reconnect') return null;
  return (
    <div
      className="notice row"
      role="status"
      style={{ position: 'fixed', top: 'calc(8px + env(safe-area-inset-top))', left: 12, right: 12, maxWidth: 420, margin: '0 auto', zIndex: 59, alignItems: 'center', boxShadow: '0 2px 10px rgba(0,0,0,.18)' }}
    >
      <span className="grow">Microsoft sign-in expired. Excel and sync are waiting.</span>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          msSignIn().catch(() => setBusy(false));
        }}
      >
        Reconnect
      </button>
    </div>
  );
}
