// Microsoft sign-in, the OneDrive workbook line, diagnostics, and the reconnect banner.
import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { msConfigured, msSignIn, msSignOut } from '../lib/ms/auth';
import { runDiagnostics } from '../lib/ms/diagnostics';
import type { DriveItem } from '../lib/ms/graph';
import { knownDevices } from '../lib/sync';
import {
  checkWorkbook, confirmFirstWrite, excelWriteOn, findExcelFiles, findWorkbooks, linkWorkbook, missingText, setExcelWrite, unlinkWorkbook,
  writeBack, type WriteWait,
} from '../lib/workbook';
import { Cell, formatAgo, formatDate, Icon, Section, Switch, toast, useNow } from './common';

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
          className={`btn block ${primary ? 'primary' : ''}`}
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

function WorkbookPicker({ items, fileName, onDone }: { items: DriveItem[]; fileName: string; onDone: () => void }) {
  const [busy, setBusy] = useState('');
  const [all, setAll] = useState<DriveItem[] | null>(null);
  const [listing, setListing] = useState(false);
  const shown = all ?? items;
  const showAll = async () => {
    setListing(true);
    try {
      setAll(await findExcelFiles());
    } catch (e) {
      toast(errText(e));
    } finally {
      setListing(false);
    }
  };
  return (
    <div className="stack" style={{ gap: 8 }}>
      {all ? (
        <p className="small">
          {all.length ? `Excel files in your OneDrive (${all.length}${all.length >= 200 ? ', the first 200' : ''}). Pick your workbook:` : 'OneDrive listed no Excel files.'}
        </p>
      ) : items.length ? (
        <p className="small">Pick your workbook:</p>
      ) : (
        <p className="small">
          No file named <b style={{ overflowWrap: 'anywhere' }}>{fileName}</b> found. OneDrive can take a while to list a file synced
          from the PC: show all Excel files and pick yours.
        </p>
      )}
      {shown.map((it) => (
        <button
          key={`${it.parentReference?.driveId ?? ''}|${it.id}`}
          type="button"
          className="btn block"
          style={{ justifyContent: 'flex-start', textAlign: 'left', height: 'auto', padding: '8px 14px', minHeight: 44, whiteSpace: 'normal' }}
          aria-label={`${it.name}, ${folderOf(it)}`}
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
            <span className="cell-detail" style={{ display: 'block' }}>
              {folderOf(it)} · {formatDate(Date.parse(it.lastModifiedDateTime))}
            </span>
          </span>
        </button>
      ))}
      <div className="cell-actions">
        {!all && (
          <button type="button" className="btn small" disabled={listing || !!busy} onClick={showAll}>
            {listing ? 'Listing…' : 'Show all Excel files'}
          </button>
        )}
        <button type="button" className="btn small ghost" onClick={onDone}>
          Cancel
        </button>
      </div>
    </div>
  );
}


// ---------- writing statuses into the workbook ----------

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** Why waiting statuses are not written yet, in plain words. */
function whyText(w: WriteWait | string | undefined, until: number | undefined, err: string | undefined): string {
  const at = until ? `; writing at ${clock(until)}` : '';
  switch (w) {
    case 'off': return 'automatic writing is off';
    case 'quiet': return `the workbook was edited a moment ago (Excel may be open)${at}`;
    case 'open':
    case 'locked': return `the workbook is open in Excel${at}`;
    case 'local': return 'this PC has edits OneDrive has not received yet';
    case 'behind': return 'OneDrive has not received the newest file yet';
    case 'busy': return 'another write is running';
    case 'retry': return `the last write failed${err ? ` (${err})` : ''}${until ? `; trying again at ${clock(until)}` : ''}`;
    case 'held': return 'a new workbook version needs your review first';
    case 'other': return `your other device is writing them${at}`;
    case 'offline': return 'no connection';
    case 'signin': return 'Microsoft sign-in expired';
    default: return '';
  }
}

/** One line for the write state, or null when there is nothing to say. `full` adds the "written" line. */
function useWriteLine(full: boolean) {
  const excel = useApp((s) => s.excel);
  const now = useNow(30000);
  if (excel.state === 'off' || excel.state === 'missing') return null;
  const n = excel.pending ?? 0;
  const confirm = excel.waiting === 'confirm' && n > 0;
  let text = '';
  let bad = false;
  if (n > 0) {
    if (confirm) text = `${plural(n, 'status', 'statuses')} not written to your workbook yet`;
    else {
      const why = whyText(excel.waiting, excel.waitUntil, excel.writeError);
      text = `${n} waiting${why ? `: ${why}` : ''}`;
      bad = excel.waiting === 'retry';
    }
  } else if (excel.stuck) {
    text = `${plural(excel.stuck, 'row', 'rows')} could not be written (row not found)`;
    bad = true;
  } else if (excel.writeError) {
    text = excel.writeError;
    bad = true;
  } else if (full && excel.written) text = `Your statuses written ${formatAgo(excel.written, now)}`;
  if (!text) return null;
  const stuckNote = n > 0 && excel.stuck ? ` · ${plural(excel.stuck, 'row', 'rows')} could not be written` : '';
  return { text: text + stuckNote, bad, confirm, canWrite: n > 0 && !confirm, patchMs: excel.patchMs };
}

function WriteNowButton() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      disabled={busy}
      onClick={async () => {
        setBusy(true);
        try {
          await writeBack({ force: true });
        } catch (e) {
          toast(errText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy ? 'Writing…' : 'Write now'}
    </button>
  );
}

/** The first-write confirmation: what will change and what protects the workbook. */
function WriteConfirmBody({ onLater }: { onLater: () => void }) {
  const n = useApp((s) => s.excel.pending ?? 0);
  const [busy, setBusy] = useState(false);
  const [older, setOlder] = useState(false);
  useEffect(() => {
    let live = true;
    knownDevices()
      .then((d) => live && setOlder(d.some((x) => x.caps < 2)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="stack" style={{ gap: 10 }}>
      <b>Write your statuses into your workbook?</b>
      <p className="small" style={{ margin: 0 }}>
        {plural(n, 'row', 'rows')} will change. Only the status colours change in your real Hugo_chinese_vocab.xlsx; words and everything else stay
        as they are.
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        A backup goes to OneDrive › Apps › Hugo Chinese › backups first, then weekly. OneDrive version history keeps every earlier version too.
      </p>
      {older && (
        <p className="small notice" style={{ margin: 0 }}>
          Another device runs an older version. Open the app there to update it first.
        </p>
      )}
      <div className="cell-actions">
        <button
          type="button"
          className="btn primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await confirmFirstWrite();
            } catch (e) {
              toast(errText(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          Write
        </button>
        <button type="button" className="btn" disabled={busy} onClick={onLater}>
          Not now
        </button>
      </div>
    </div>
  );
}

/** Sheets: one calm line above the tabs. Hidden when everything is written. */
export function WriteLine() {
  const line = useWriteLine(false);
  const [dlg, setDlg] = useState(false);
  if (!line) return null;
  return (
    <>
      <div className={`notice hs-write${line.bad ? ' bad' : ''}`} role="status">
        <span className="hs-write-t">{line.text}</span>
        <span className="hs-write-actions">
          {line.confirm && (
            <button type="button" className="btn small" onClick={() => setDlg(true)}>
              Review
            </button>
          )}
          {line.canWrite && <WriteNowButton />}
          <a className="btn small ghost" href="#/settings" aria-label="Write details in Settings">
            Details
          </a>
        </span>
      </div>
      {dlg && (
        <div className="pop-backdrop" onClick={() => setDlg(false)}>
          <div className="pop" role="dialog" aria-modal="true" aria-label="Write to workbook" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.key === 'Escape' && setDlg(false)}>
            <WriteConfirmBody onLater={() => setDlg(false)} />
          </div>
        </div>
      )}
    </>
  );
}

/** Microsoft panel: details, the switch, and the first-write confirmation. */
function WriteSection() {
  const line = useWriteLine(true);
  const [later, setLater] = useState(false);
  const [on, setOn] = useState(excelWriteOn());
  return (
    <div className="stack" style={{ gap: 8 }}>
      {line?.confirm && !later ? (
        <WriteConfirmBody onLater={() => setLater(true)} />
      ) : (
        line && (
          <>
            <p className={`small ${line.bad ? 'notice bad' : ''}`} style={{ margin: 0 }}>{line.text}</p>
            {line.confirm && (
              <div>
                <button type="button" className="btn small" onClick={() => setLater(false)}>
                  Review
                </button>
              </div>
            )}
            {line.canWrite && (
              <div>
                <WriteNowButton />
              </div>
            )}
            {line.patchMs ? <p className="small muted" style={{ margin: 0 }}>Last write took {(line.patchMs / 1000).toFixed(1)} s</p> : null}
          </>
        )
      )}
      <label className="hs-switchline">
        <span>Write my statuses into the workbook automatically</span>
        <Switch
          checked={on}
          label="Write my statuses into the workbook automatically"
          onChange={(v) => {
            setExcelWrite(v);
            setOn(v);
          }}
        />
      </label>
    </div>
  );
}

/** The signed-in account and the linked workbook. */
function SignedIn() {
  const ms = useApp((s) => s.ms);
  const excel = useApp((s) => s.excel);
  const fileName = useApp((s) => s.settings.fileName);
  const now = useNow(30000);
  const [choices, setChoices] = useState<DriveItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true);
    try {
      const found = await findWorkbooks({ all: true });
      if (found.length === 1 && excel.state === 'off') await linkWorkbook(found[0]);
      else setChoices(found);
    } catch (e) {
      toast(errText(e));
    } finally {
      setBusy(false);
    }
  };
  const linked = excel.state !== 'off';
  const name = excel.name ?? fileName;
  return (
    <div className="stack">
      {linked && excel.state !== 'missing' ? (
        <span className="cell-body">
          <span className="cell-label">{name}</span>
          <span className="cell-detail">{excel.checked ? `Read ${formatAgo(excel.checked, now)}` : 'Not read yet'}</span>
        </span>
      ) : (
        !choices && excel.state !== 'missing' && <span className="cell-detail">No workbook linked yet.</span>
      )}
      {ms.account && <span className="cell-detail" style={{ overflowWrap: 'anywhere' }}>Signed in as {ms.account}</span>}
      {ms.state === 'error' && ms.message && <p className="notice bad">{ms.message}</p>}
      {excel.state === 'missing' && <p className="notice bad">{missingText(name)}</p>}
      {excel.state === 'error' && excel.message && <p className="notice bad">{excel.message}</p>}
      {linked && excel.state !== 'missing' && !choices && <WriteSection />}
      {choices ? (
        <WorkbookPicker items={choices} fileName={fileName} onDone={() => setChoices(null)} />
      ) : (
        <div className="cell-actions">
          {linked && (
            <button type="button" className="btn small" onClick={() => checkWorkbook(true).catch((e) => toast(errText(e)))}>
              Read now
            </button>
          )}
          <button type="button" className={`btn small ${linked ? '' : 'primary'}`} disabled={busy} onClick={find}>
            {busy ? 'Searching…' : linked ? 'Change workbook' : 'Find workbook'}
          </button>
          {linked && (
            <button type="button" className="btn small danger" onClick={() => unlinkWorkbook()}>
              Unlink
            </button>
          )}
          <button
            type="button"
            className="btn small danger"
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
  const off = ms.state === 'off';
  const body = off ? (
    <>
      {bare && <p className="muted small">Reads Hugo_chinese_vocab.xlsx from your OneDrive. Sign in once on each device; on iPhone, in the Home Screen app.</p>}
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
    <Section
      title="Microsoft"
      id="ms"
      footer={
        off
          ? 'Reads Hugo_chinese_vocab.xlsx from your OneDrive and keeps your devices in sync. Sign in once on each device; on iPhone, in the Home Screen app.'
          : undefined
      }
    >
      <Cell>
        <div className="stack">{body}</div>
      </Cell>
    </Section>
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
          className="btn small"
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
    <div className="banner" role="status">
      <span className="banner-icon" aria-hidden="true">
        <Icon name="cloud" />
      </span>
      <span className="grow" style={{ fontWeight: 600 }}>
        Microsoft sign-in expired
        <span className="banner-sub" style={{ fontWeight: 400 }}>
          Excel and sync are waiting.
        </span>
      </span>
      <button
        type="button"
        className="btn small primary"
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
