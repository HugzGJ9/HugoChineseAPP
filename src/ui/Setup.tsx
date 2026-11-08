import { useEffect, useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { useApp } from '../lib/store';
import { allowFolder, checkFolder, folderSupported, linkFolder, unlinkFolder, writeCopy } from '../lib/folder';
import { decodeKey, encodeKey, getLink, linkRepo, syncNow, unlinkRepo } from '../lib/sync';
import { parseRepo } from '../lib/github';
import { formatAgo, toast, TopBar, useNow } from './common';
import { FileImportButton, PendingImportNotice } from './Today';
import { msConfigured } from '../lib/ms/auth';
import { MicrosoftPanel } from './Microsoft';

const DATA_REPO = 'HugoChineseData';
/** 'X.xlsx' → 'X (app).xlsx': the copy that carries Hugo's statuses as colours. */
const copyName = (f: string) => f.replace(/\.xlsx$/i, '') + ' (app).xlsx';

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** First-run choices for getting the words onto this device. */
export function SetupSources({ linked = false }: { linked?: boolean }) {
  // Computer (can open a folder): link the folder first. Phone: the sync key first. The other ways stay folded.
  const computer = folderSupported();
  const folderPanel = (
    <div className="panel stack">
      <h2>Link your OneDrive folder</h2>
      <p className="muted small">
        Pick the folder that holds Hugo_chinese_vocab.xlsx. The app reads the file each time it changes and writes Hugo_chinese_vocab (app).xlsx next to it, a copy with your statuses as colours. The original is never changed. You can allow
        access on every visit when the browser asks.
      </p>
      <LinkFolderButton label="Choose the OneDrive folder" primary />
    </div>
  );
  const keyPanel = (
    <div className="stack">
      <h2>{computer ? 'Already set up on another device?' : 'Get your words from your computer'}</h2>
      <p className="muted small">On the device that has your words, open Settings › Sync › Add another device, and paste the sync key here.</p>
      <KeyForm />
    </div>
  );
  const filePanel = (
    <div className="stack">
      <h2>Import the file by hand</h2>
      <p className="muted small">
        Pick Hugo_chinese_vocab.xlsx.
        {!computer && ' On iPhone, choose it in the Files app (OneDrive appears under Browse once the OneDrive app is installed).'}
      </p>
      <div className="stack" style={{ gap: 8 }}>
        <FileImportButton />
      </div>
    </div>
  );
  const fold = (title: string, body: ReactNode) => (
    <details className="panel">
      <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>{title}</summary>
      <div className="stack" style={{ marginTop: 8 }}>
        {body}
      </div>
    </details>
  );
  if (msConfigured()) {
    return (
      <>
        <MicrosoftPanel />
        {fold(
          'Other ways',
          <>
            {computer && folderPanel}
            {!linked && keyPanel}
            {filePanel}
          </>,
        )}
      </>
    );
  }
  if (computer) {
    return (
      <>
        {folderPanel}
        {!linked && fold('Already set up on another device?', keyPanel)}
        {fold('Import the file by hand', filePanel)}
      </>
    );
  }
  return (
    <>
      {!linked && <div className="panel">{keyPanel}</div>}
      {fold('Import the file by hand', filePanel)}
    </>
  );
}

function LinkFolderButton({ label, primary = false, small = false }: { label: string; primary?: boolean; small?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <div className="stack" style={{ gap: 8 }}>
      <div>
        <button
          type="button"
          className={`btn ${primary ? 'primary' : ''} ${small ? 'small' : ''}`}
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            setError('');
            try {
              if (await linkFolder()) toast('OneDrive folder linked');
            } catch (e) {
              setError((e as Error).message);
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? 'Reading…' : label}
        </button>
      </div>
      {error && <p className="notice bad">{error}</p>}
    </div>
  );
}

/** OneDrive folder link (computer). */
export function SourceSettings() {
  const configured = msConfigured();
  return (
    <div className="stack">
      <PendingImportNotice />
      <MicrosoftPanel bare explainOff />
      {configured ? (
        <details>
          <summary style={{ minHeight: 44, display: 'flex', alignItems: 'center' }}>Without Microsoft</summary>
          <div className="stack" style={{ marginTop: 8 }}>
            <SourceBody />
          </div>
        </details>
      ) : (
        <SourceBody />
      )}
    </div>
  );
}

function SourceBody() {
  const folder = useApp((s) => s.folder);
  const fileName = useApp((s) => s.settings.fileName);
  const now = useNow(30000);
  if (!folderSupported()) {
    return <p className="small muted">On this device, new words arrive through sync, or from a file you pick.</p>;
  }
  if (folder.state === 'off') {
    return (
      <div className="stack">
        <p className="small muted">
          Link the OneDrive folder that holds {fileName}: the app then reads it whenever it changes and writes {copyName(fileName)} next to it, a copy with your statuses as colours. The original is never changed.
        </p>
        <LinkFolderButton label="Link your OneDrive folder" />
      </div>
    );
  }
  if (folder.state === 'permission') {
    return (
      <div className="notice stack" style={{ gap: 8 }}>
        <span>The browser needs your permission again to open “{folder.name}”.</span>
        <div>
          <button type="button" className="btn small" onClick={() => allowFolder()}>
            Allow access
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="stack">
      <p className="small">
        Folder “{folder.name}” linked. {fileName} checked {formatAgo(folder.checked, now)}.{' '}
        {folder.written ? `${copyName(fileName)} written ${formatAgo(folder.written, now)}.` : ''}
      </p>
      {folder.message && <p className="notice bad">{folder.message}</p>}
      {folder.writeError && <p className="notice">{folder.writeError}</p>}
      <div className="row wrap">
        <button type="button" className="btn small" onClick={() => checkFolder(true)}>
          Read Excel now
        </button>
        <button type="button" className="btn small" onClick={() => writeCopy(true)}>
          Write the copy now
        </button>
        <LinkFolderButton label="Change folder" small />
        <button type="button" className="btn small ghost" onClick={() => unlinkFolder()}>
          Unlink
        </button>
      </div>
    </div>
  );
}

/** Sync through the private GitHub repository. */
export function SyncSettings() {
  const sync = useApp((s) => s.sync);
  const device = useApp((s) => s.device);
  const now = useNow(30000);
  const [share, setShare] = useState(false);
  if (sync.state === 'off') {
    return (
      <section className="panel stack" id="sync">
        <h2>Sync</h2>
        <p className="small muted">
          Keeps words, reviews and settings the same on your computer and iPhone, through a private GitHub repository that only you can read.
        </p>
        <h3>Join with a sync key</h3>
        <p className="small muted">On a device that is already linked: Settings › Sync › Add another device.</p>
        <KeyForm />
        <details>
          <summary>First device: set up the repository</summary>
          <RepoForm />
        </details>
      </section>
    );
  }
  return (
    <section className="panel stack" id="sync">
      <h2>Sync</h2>
      <p className="small">
        {sync.state === 'running' ? 'Syncing…' : `Synced with ${sync.repo} ${formatAgo(sync.last, now)}.`} This device is <b>{device}</b>.
      </p>
      {sync.message && <p className={`notice ${sync.state === 'error' ? 'bad' : ''}`}>{sync.message}</p>}
      {sync.updateNeeded && (
        <div className="notice row wrap">
          <span className="grow">A newer version of the app saved your words. Update to read them.</span>
          <button type="button" className="btn small" onClick={() => location.reload()}>
            Update the app
          </button>
        </div>
      )}
      {sync.warnings?.map((w) => (
        <p key={w} className="notice">
          {w}
        </p>
      ))}
      <div className="row wrap">
        <button type="button" className="btn small" disabled={sync.state === 'running'} onClick={() => syncNow()}>
          Sync now
        </button>
        <button type="button" className="btn small" onClick={() => setShare(!share)}>
          {share ? 'Hide the key' : 'Add another device'}
        </button>
        <button
          type="button"
          className="btn small ghost"
          onClick={async () => {
            if (window.confirm('Stop syncing this device? Words and reviews stay on it.')) await unlinkRepo();
          }}
        >
          Unlink
        </button>
      </div>
      {share && <ShareKey />}
    </section>
  );
}

function linkUrl(key: string): string {
  return new URL(`${import.meta.env.BASE_URL}#/link/${key}`, location.origin).href;
}

function QrCode({ text }: { text: string }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'L');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, size: n + 8 };
  }, [text]);
  return (
    <svg className="qr" viewBox={`0 0 ${path.size} ${path.size}`} role="img" aria-label="QR code of the sync link" shapeRendering="crispEdges">
      <rect width={path.size} height={path.size} fill="#fff" />
      <path d={path.d} fill="#000" />
    </svg>
  );
}

function ShareKey() {
  const [key, setKey] = useState('');
  useEffect(() => {
    getLink().then((l) => l && setKey(encodeKey(l)));
  }, []);
  if (!key) return null;
  return (
    <div className="stack share-key">
      <div className="row wrap" style={{ alignItems: 'flex-start', gap: 20 }}>
        <QrCode text={linkUrl(key)} />
        <ol className="small steps">
          <li>On the iPhone, scan this code with the Camera and open the link.</li>
          <li>Tap “Copy the key”, then add the page to the Home Screen (Share › Add to Home Screen) if it is not there yet.</li>
          <li>Open Hugo 中文 from the Home Screen and paste the key. The Home Screen app keeps its own storage, separate from Safari.</li>
        </ol>
      </div>
      <label className="field">
        <span className="small">Sync key</span>
        <textarea readOnly value={key} rows={3} onFocus={(e) => e.currentTarget.select()} />
      </label>
      <div className="row wrap">
        <CopyButton text={key} />
      </div>
      <p className="small muted">Anyone with this key can read and change your sync repository. Show it only on your own devices.</p>
    </div>
  );
}

function CopyButton({ text, label = 'Copy the key' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="btn small"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setDone(true);
          setTimeout(() => setDone(false), 2000);
        } catch {
          toast('Copy failed: select the key and copy it by hand');
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  );
}

function KeyForm({ initial = '' }: { initial?: string }) {
  const [key, setKey] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        const link = decodeKey(key);
        if (!link) {
          setError('This is not a sync key. A key starts with hz1.');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await linkRepo(link);
          toast('Linked. Your words and reviews are on their way.');
          location.hash = '#/sheets';
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label className="field">
        <span className="small">Sync key</span>
        <textarea
          value={key}
          rows={3}
          placeholder="hz1.…"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => setKey(e.target.value)}
        />
      </label>
      {error && <p className="notice bad">{error}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={busy || !key.trim()}>
          {busy ? 'Linking…' : 'Link this device'}
        </button>
      </div>
    </form>
  );
}

function RepoForm() {
  const [repo, setRepo] = useState('');
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const newRepo = `https://github.com/new?name=${DATA_REPO}&visibility=private&description=${encodeURIComponent('Hugo 中文: words and reviews (private)')}`;
  const newToken = `https://github.com/settings/personal-access-tokens/new?name=${encodeURIComponent('Hugo 中文 sync')}&description=${encodeURIComponent('Sync for the Hugo 中文 app')}&contents=write`;
  return (
    <form
      className="stack"
      style={{ marginTop: 12 }}
      onSubmit={async (e) => {
        e.preventDefault();
        const r = parseRepo(repo);
        if (!r) {
          setError('Write the repository as owner/name, for example HugzGJ9/HugoChineseData.');
          return;
        }
        setBusy(true);
        setError('');
        try {
          await linkRepo({ ...r, token: token.trim() });
          toast('Sync is on');
        } catch (err) {
          setError((err as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <ol className="small steps">
        <li>
          <a href={newRepo} target="_blank" rel="noreferrer">
            Create a private repository
          </a>{' '}
          named {DATA_REPO}. Keep it <b>Private</b>; nothing else to tick.
        </li>
        <li>
          <a href={newToken} target="_blank" rel="noreferrer">
            Create a fine-grained token
          </a>
          : Repository access › Only select repositories › {DATA_REPO}. Permissions › Repository permissions › Contents › Read and write. Expiration: the
          longest offered. Copy the token, which starts with github_pat_.
        </li>
        <li>Fill in both below. The token stays on your devices and is only sent to GitHub.</li>
      </ol>
      <p className="small muted">
        Keep the token fine-grained, for this one repository, with an expiry date. If a phone is lost, revoke the token on GitHub and link your devices again
        with a new one.
      </p>
      <label className="field">
        <span className="small">Repository</span>
        <input type="text" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={`HugzGJ9/${DATA_REPO}`} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      </label>
      <label className="field">
        <span className="small">Token</span>
        <input type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder="github_pat_…" autoComplete="off" />
      </label>
      {error && <p className="notice bad">{error}</p>}
      <div>
        <button type="submit" className="btn primary" disabled={busy || !repo.trim() || !token.trim()}>
          {busy ? 'Checking…' : 'Turn on sync'}
        </button>
      </div>
    </form>
  );
}

/** #/link/<key>: opened from the QR code. */
export function LinkPage({ keyText }: { keyText: string }) {
  const [key] = useState(keyText);
  const linked = useApp((s) => s.sync.state !== 'off');
  const valid = !!decodeKey(key);
  useEffect(() => {
    // Keep the key out of the address bar and the history.
    if (keyText) history.replaceState(null, '', `${location.pathname}${location.search}#/link`);
  }, [keyText]);
  const iosSafari = /iPhone|iPad/.test(navigator.userAgent) && !isStandalone();
  return (
    <div className="main">
      <TopBar title="Link this device" back="#/today" />
      <div className="stack-l">
        {!valid ? (
          <p className="notice bad">This link has no valid sync key. Open Settings › Sync › Add another device on your computer and try again.</p>
        ) : linked ? (
          <p className="notice ok">This device is already linked. To link it to another repository, unlink it first in Settings › Sync.</p>
        ) : (
          <>
            {iosSafari && (
              <div className="panel stack">
                <h2>Using the app from the Home Screen?</h2>
                <ol className="small steps">
                  <li>Copy the key.</li>
                  <li>If Hugo 中文 is not on your Home Screen yet: Share › Add to Home Screen.</li>
                  <li>Open Hugo 中文 from the Home Screen and paste the key on the first screen, or in Settings › Sync.</li>
                </ol>
                <div>
                  <CopyButton text={key} />
                </div>
              </div>
            )}
            <div className="panel stack">
              <h2>{iosSafari ? 'Or use it here in Safari' : 'Link with this key'}</h2>
              <KeyForm initial={key} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
