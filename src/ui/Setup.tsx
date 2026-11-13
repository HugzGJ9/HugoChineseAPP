import { useEffect, useMemo, useState, type ReactNode } from 'react';
import qrcode from 'qrcode-generator';
import { useApp } from '../lib/store';
import { allowFolder, checkFolder, folderSupported, linkFolder, unlinkFolder, writeCopy } from '../lib/folder';
import {
  decodeKey,
  encodeKey,
  getLink,
  githubReading,
  knownDevices,
  linkOneDrive,
  linkRepo,
  nextAutoSync,
  stopReadingGitHub,
  SYNC_CAPS,
  syncNow,
  syncTarget,
  unlinkOneDrive,
  unlinkRepo,
  type SyncTarget,
} from '../lib/sync';
import { parseRepo } from '../lib/github';
import { Cell, formatAgo, Icon, Row, Section, toast, TopBar, useNow } from './common';
import { FileImportButton, PendingImportNotice } from './Today';
import { msConfigured } from '../lib/ms/auth';
import { MicrosoftPanel } from './Microsoft';

const DATA_REPO = 'HugoChineseData';
/** 'X.xlsx' → 'X (app).xlsx': the copy that carries Hugo's statuses as colours. */
const copyName = (f: string) => f.replace(/\.xlsx$/i, '') + ' (app).xlsx';

function isStandalone(): boolean {
  return matchMedia('(display-mode: standalone)').matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
}

/** A folded row inside a group: title and chevron, content below when open. */
function Fold({ title, children, open }: { title: string; children: ReactNode; open?: boolean }) {
  return (
    <details className="cell-details" open={open}>
      <summary className="cell tap">
        <span className="cell-body">
          <span className="cell-label">{title}</span>
        </span>
        <Icon name="chevron" className="cell-chev" />
      </summary>
      <div className="cell cell-pad">{children}</div>
    </details>
  );
}

/** First-run choices for getting the words onto this device. */
export function SetupSources({ linked = false }: { linked?: boolean }) {
  // With Microsoft: sign in first, the rest folded. Computer without it: link the folder first. Phone: the sync key first.
  const computer = folderSupported();
  const folderBody = (
    <div className="stack">
      <LinkFolderButton label="Choose the OneDrive folder" primary />
    </div>
  );
  const folderNote =
    'Pick the folder that holds Hugo_chinese_vocab.xlsx. The app reads the file when it changes and writes a copy next to it with your statuses as colours. The original is never changed.';
  const keyBody = (
    <div className="stack">
      <p className="cell-detail">On the device that has your words, open Settings › Sync › Add another device, and paste the sync key here.</p>
      <KeyForm />
    </div>
  );
  const fileBody = (
    <div className="stack">
      <p className="cell-detail">
        Pick Hugo_chinese_vocab.xlsx.
        {!computer && ' On iPhone, choose it in the Files app (OneDrive appears under Browse once the OneDrive app is installed).'}
      </p>
      <FileImportButton />
    </div>
  );
  if (msConfigured()) {
    return (
      <div className="groups">
        <MicrosoftPanel />
        <Section title="Other ways (without Microsoft)">
          {computer && (
            <Fold title="Link your OneDrive folder">
              <p className="cell-detail">{folderNote}</p>
              {folderBody}
            </Fold>
          )}
          {!linked && <Fold title={computer ? 'Join with a sync key' : 'Get your words from your computer'}>{keyBody}</Fold>}
          <Fold title="Import the file by hand">{fileBody}</Fold>
        </Section>
      </div>
    );
  }
  if (computer) {
    return (
      <div className="groups">
        <Section title="Link your OneDrive folder" footer={folderNote}>
          <Cell>{folderBody}</Cell>
        </Section>
        <Section title="Other ways">
          {!linked && <Fold title="Join with a sync key">{keyBody}</Fold>}
          <Fold title="Import the file by hand">{fileBody}</Fold>
        </Section>
      </div>
    );
  }
  return (
    <div className="groups">
      {!linked && (
        <Section title="Get your words from your computer">
          <Cell>{keyBody}</Cell>
        </Section>
      )}
      <Section title="Other ways">
        <Fold title="Import the file by hand">{fileBody}</Fold>
      </Section>
    </div>
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
          className={`btn ${primary ? 'primary block' : ''} ${small ? 'small' : ''}`}
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

/** The workbook source: Microsoft first, the OneDrive folder link (computer) under "Without Microsoft". Sits inside a Cell. */
export function SourceSettings() {
  const configured = msConfigured();
  return (
    <div className="stack">
      <PendingImportNotice />
      <MicrosoftPanel bare explainOff />
      {configured ? (
        <details>
          <summary>Without Microsoft</summary>
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
    return <p className="cell-detail">On this device, new words arrive through sync, or from a file you pick.</p>;
  }
  if (folder.state === 'off') {
    return (
      <div className="stack">
        <p className="cell-detail">
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
      <span className="cell-body">
        <span className="cell-label">Folder “{folder.name}”</span>
        <span className="cell-detail">
          {fileName} checked {formatAgo(folder.checked, now)}.{' '}
          {folder.written ? `${copyName(fileName)} written ${formatAgo(folder.written, now)}.` : ''}
        </span>
      </span>
      {folder.message && <p className="notice bad">{folder.message}</p>}
      {folder.writeError && <p className="notice">{folder.writeError}</p>}
      <div className="cell-actions">
        <button type="button" className="btn small" onClick={() => checkFolder(true)}>
          Read Excel now
        </button>
        <button type="button" className="btn small" onClick={() => writeCopy(true)}>
          Write the copy now
        </button>
        <LinkFolderButton label="Change folder" small />
        <button type="button" className="btn small danger" onClick={() => unlinkFolder()}>
          Unlink
        </button>
      </div>
    </div>
  );
}

type Devices = Awaited<ReturnType<typeof knownDevices>>;
type GhRead = Awaited<ReturnType<typeof githubReading>>;

/** What the Sync section needs from the sync engine: the target, the GitHub read-only pull, the devices seen. */
function useSyncExtras() {
  const sync = useApp((s) => s.sync);
  const [target, setTarget] = useState<SyncTarget | null | undefined>(undefined);
  const [gh, setGh] = useState<GhRead>(null);
  const [devices, setDevices] = useState<Devices>([]);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let live = true;
    (async () => {
      const t = await syncTarget();
      const [g, d] = await Promise.all([githubReading(), t === 'onedrive' ? knownDevices() : Promise.resolve([] as Devices)]);
      if (live) {
        setTarget(t);
        setGh(g);
        setDevices(d);
      }
    })().catch(() => undefined);
    return () => {
      live = false;
    };
  }, [sync.state, sync.last, sync.repo, tick]);
  // Until the engine answers, read the target off the status line.
  const guess: SyncTarget | null = sync.state === 'off' ? null : sync.repo === 'OneDrive' ? 'onedrive' : 'github';
  return { target: sync.state === 'off' ? null : (target ?? guess), gh, devices, reload: () => setTick((n) => n + 1) };
}

const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

/** Sync: through OneDrive (Apps/Hugo Chinese) or, without Microsoft, a private GitHub repository. */
export function SyncSettings() {
  const sync = useApp((s) => s.sync);
  const ms = useApp((s) => s.ms.state);
  const device = useApp((s) => s.device);
  const now = useNow(30000);
  const { target, gh, devices, reload } = useSyncExtras();
  const [share, setShare] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<void>, fail: string) => {
    setBusy(true);
    try {
      await fn();
    } catch (e) {
      toast(`${fail}: ${(e as Error).message}`);
    } finally {
      setBusy(false);
      reload();
    }
  };
  const retry = sync.state === 'error' && nextAutoSync() > now ? `Trying again at ${clock(nextAutoSync())}.` : '';
  const notices = (
    <>
      {sync.message && (
        <Cell>
          <p className={`notice ${sync.state === 'error' ? 'bad' : ''}`}>
            {sync.message} {retry}
          </p>
        </Cell>
      )}
      {sync.updateNeeded && (
        <Cell>
          <div className="notice row wrap">
            <span className="grow">A newer version of the app saved your words. Update to read them.</span>
            <button type="button" className="btn small" onClick={() => location.reload()}>
              Update the app
            </button>
          </div>
        </Cell>
      )}
      {sync.warnings?.map((w) => (
        <Cell key={w}>
          <p className="notice">{w}</p>
        </Cell>
      ))}
    </>
  );
  const syncNowRow = <Row glyph="sync" tone="action" label="Sync now" disabled={sync.state === 'running'} onClick={() => void syncNow()} />;

  if (target === 'onedrive') {
    const others = devices.filter((d) => d.id !== device);
    return (
      <>
        <Section
          title="Sync"
          id="sync"
          footer="Your reviews, statuses, explanations and settings are kept in a private OneDrive folder that only this app uses."
        >
          <Row
            glyph="cloud"
            label={sync.state === 'running' ? 'Syncing…' : 'Synced through OneDrive'}
            detail={`Apps/Hugo Chinese · ${sync.last ? formatAgo(sync.last, now) : 'not yet'}`}
          />
          {notices}
          {syncNowRow}
          {gh?.on && (
            <Row
              glyph="x-circle"
              label="Stop reading GitHub"
              detail={gh.waiting.length ? `Still reading it for ${gh.waiting.join(', ')}, which have not moved to OneDrive yet.` : 'Every device has moved to OneDrive.'}
              onClick={() => {
                if (!gh.waiting.length || window.confirm(`${gh.waiting.join(', ')} still sync through GitHub. Stop reading it anyway?`)) {
                  void run(stopReadingGitHub, 'Could not stop');
                }
              }}
            />
          )}
        </Section>
        {others.length > 0 && (
          <Section title="Devices">
            {devices.map((d) => {
              const mine = d.id === device;
              const older = d.caps < SYNC_CAPS;
              return (
                <Row
                  key={d.id}
                  icon="device"
                  iconBg="var(--badge-gray)"
                  label={d.id}
                  value={mine ? 'This device' : undefined}
                  detail={mine ? undefined : older ? 'Older version: open the app on that device to update it' : d.seen ? `Seen ${formatAgo(d.seen, now)}` : undefined}
                />
              );
            })}
          </Section>
        )}
        <Section footer="This device keeps its words and reviews. Other devices keep syncing.">
          <Row
            tone="destructive"
            center
            label="Stop syncing"
            onClick={() => {
              if (window.confirm('Stop syncing this device? Words and reviews stay on it.')) void run(unlinkOneDrive, 'Could not stop syncing');
            }}
          />
        </Section>
      </>
    );
  }

  if (target === 'github') {
    return (
      <>
        <Section
          title="Sync"
          id="sync"
          footer={`Through the private GitHub repository ${sync.repo ?? ''}. This device is ${device}.`}
        >
          <Row glyph="cloud" label={sync.state === 'running' ? 'Syncing…' : `Synced with ${sync.repo}`} detail={sync.last ? formatAgo(sync.last, now) : 'not yet'} />
          {notices}
          {syncNowRow}
          {ms === 'ok' && (
            <Row
              glyph="cloud"
              tone="action"
              label="Move sync to OneDrive"
              detail="GitHub is still read, never written, until your other devices have moved."
              disabled={busy}
              onClick={() => void run(linkOneDrive, 'Could not move sync')}
            />
          )}
          <Row glyph="key" label={share ? 'Hide the key' : 'Add another device'} onClick={() => setShare(!share)} />
          {share && (
            <Cell>
              <ShareKey />
            </Cell>
          )}
        </Section>
        <Section footer="This device keeps its words and reviews.">
          <Row
            tone="destructive"
            center
            label="Stop syncing"
            onClick={() => {
              if (window.confirm('Stop syncing this device? Words and reviews stay on it.')) void run(unlinkRepo, 'Could not stop syncing');
            }}
          />
        </Section>
      </>
    );
  }

  const withMs = msConfigured();
  return (
    <Section
      title="Sync"
      id="sync"
      footer={
        withMs
          ? 'Keeps words, reviews and settings the same on your computer and iPhone.'
          : 'Keeps words, reviews and settings the same on your computer and iPhone, through a private GitHub repository that only you can read.'
      }
    >
      {withMs &&
        (ms === 'ok' ? (
          <Cell>
            <button type="button" className="btn primary block" disabled={busy} onClick={() => void run(linkOneDrive, 'Could not turn on sync')}>
              {busy ? 'Turning on…' : 'Sync through OneDrive'}
            </button>
          </Cell>
        ) : (
          <Row glyph="cloud" label="Sync through OneDrive" detail="Sign in with Microsoft above first." />
        ))}
      <Fold title={withMs ? 'Other ways (without Microsoft)' : 'Join with a sync key'} open={!withMs}>
        <p className="cell-detail">On a device that is already linked: Settings › Sync › Add another device.</p>
        <KeyForm />
        <details>
          <summary>First device: set up the repository</summary>
          <RepoForm />
        </details>
      </Fold>
    </Section>
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
        <ol className="steps cell-detail">
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
      <p className="cell-detail">Anyone with this key can read and change your sync repository. Show it only on your own devices.</p>
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
        <button type="submit" className="btn primary block" disabled={busy || !key.trim()}>
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
      <ol className="steps cell-detail">
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
      <p className="cell-detail">
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
        <button type="submit" className="btn primary block" disabled={busy || !repo.trim() || !token.trim()}>
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
      <div className="groups">
        {!valid ? (
          <Section>
            <Cell>
              <p className="notice bad">This link has no valid sync key. Open Settings › Sync › Add another device on your computer and try again.</p>
            </Cell>
          </Section>
        ) : linked ? (
          <Section>
            <Cell>
              <p className="notice ok">This device is already linked. To link it to another repository, unlink it first in Settings › Sync.</p>
            </Cell>
          </Section>
        ) : (
          <>
            {iosSafari && (
              <Section title="Using the app from the Home Screen?">
                <Cell>
                  <div className="stack">
                    <ol className="steps">
                      <li>Copy the key.</li>
                      <li>If Hugo 中文 is not on your Home Screen yet: Share › Add to Home Screen.</li>
                      <li>Open Hugo 中文 from the Home Screen and paste the key on the first screen, or in Settings › Sync.</li>
                    </ol>
                    <CopyButton text={key} />
                  </div>
                </Cell>
              </Section>
            )}
            <Section title={iosSafari ? 'Or use it here in Safari' : 'Link with this key'}>
              <Cell>
                <KeyForm initial={key} />
              </Cell>
            </Section>
          </>
        )}
      </div>
    </div>
  );
}
