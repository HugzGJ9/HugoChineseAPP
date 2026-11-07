import { useEffect, useMemo, useRef, useState } from 'react';
import { getState, useApp } from '../lib/store';
import { buildQueue, moreNew, reviewAhead } from '../lib/engine/queue';
import { streak } from '../lib/stats';
import { acceptPendingImport, importFile, rejectPendingImport, summary, type ImportOutcome } from '../lib/sources';
import { formatAgo, Icon, LangSwitch, toast, TopBar, useNow } from './common';
import { SetupSources } from './Setup';
import { allowFolder } from '../lib/folder';
import { lastBackup, saveBackupFile } from '../lib/backup';

export function Today() {
  const now = useNow();
  const { notes, cards, noteMap, events, settings, sync } = useApp((s) => s);
  const q = useMemo(() => buildQueue([...cards.values()], noteMap, events, settings, now), [cards, noteMap, events, settings, now]);
  const days = useMemo(() => streak(events, now), [events, now]);

  // Only needed once today's queue is empty.
  const caughtUp = notes.length > 0 && q.cards.length === 0;
  const more = useMemo(
    () => (caughtUp ? moreNew([...cards.values()], noteMap, events, settings, now, 5) : []),
    [caughtUp, cards, noteMap, events, settings, now],
  );
  const ahead = useMemo(() => (caughtUp ? reviewAhead([...cards.values()], noteMap, now, 20) : []), [caughtUp, cards, noteMap, now]);

  if (!notes.length) {
    return (
      <div className="main">
        <TopBar title="Hugo 中文" />
        <NoWords />
      </div>
    );
  }

  const due = q.counts.due + q.counts.learning;
  const total = q.cards.length;
  return (
    <div className="main">
      <TopBar title="Today" back="#/settings">
        <LangSwitch />
      </TopBar>
      <div className="stack-l">
        <HomeNotices />
        <section className="stack">
          <div className="today-figure">
            <span className="n">{total}</span>
            <span className="muted">{total === 1 ? 'card to study' : 'cards to study'}</span>
          </div>
          <div className="counts">
            <div>
              <b>{due}</b>
              <span>reviews due</span>
            </div>
            <div>
              <b>{q.counts.newAvailable}</b>
              <span>new today</span>
            </div>
            <div>
              <b>{q.counts.reviewedToday}</b>
              <span>done today</span>
            </div>
          </div>
          {total ? (
            <a className="btn primary block" href="#/review" style={{ minHeight: 56, fontSize: '1.05rem' }}>
              Start
            </a>
          ) : (
            <>
              <p className="notice ok">All caught up for today.</p>
              {(more.length > 0 || ahead.length > 0) && (
                <div className="stack" style={{ gap: 8 }}>
                  {more.length > 0 && (
                    <a className="btn primary block" href={cardsHref(more, more)}>
                      Learn {more.length} more new
                    </a>
                  )}
                  {ahead.length > 0 && (
                    <a className="btn block" href={cardsHref(ahead)}>
                      Review ahead ({ahead.length})
                    </a>
                  )}
                </div>
              )}
            </>
          )}
          <p className="small muted">
            {days > 0 ? `${days}-day streak. ` : ''}
            {q.counts.newVocabLeft === 0 && q.counts.introducedToday > 0 ? 'Daily new words reached. ' : ''}
            {sync.state !== 'off' ? `Synced ${formatAgo(sync.last, now)}.` : ''}
          </p>
        </section>
        <section className="row wrap">
          <a className="btn" href="#/quick">
            <Icon name="quick" /> Quick memory
          </a>
          <a className="btn" href="#/sheets">
            <Icon name="sheets" /> Sheets
          </a>
          <a className="btn" href="#/stats">
            <Icon name="stats" /> Stats
          </a>
        </section>
      </div>
    </div>
  );
}

/** The two "no words yet" screens: waiting for sync, or choosing how to get the words. */
export function NoWords() {
  const notes = useApp((s) => s.notes);
  const sync = useApp((s) => s.sync);
  if (notes.length) return null;
  if (sync.state === 'running') return <p className="notice">Getting your words from sync…</p>;
  return (
    <div className="stack-l">
      <AppNotices />
      <p className="muted" style={{ maxWidth: '52ch' }}>
        Your words come from Hugo_chinese_vocab.xlsx. Choose how this device gets them; you only do this once.
      </p>
      {sync.state !== 'off' && <p className="notice">Sync is on, but no device has sent words yet. Link the OneDrive folder on your computer, or import the Excel file.</p>}
      <SetupSources linked={sync.state !== 'off'} />
    </div>
  );
}

/** Notices for the home screens: reload, held import, import fixes, sync error, folder access, backup. */
export function HomeNotices() {
  const fixes = useApp((s) => s.meta?.issues.filter((i) => i.level === 'fix').length ?? 0);
  const sync = useApp((s) => s.sync);
  const folder = useApp((s) => s.folder);
  return (
    <>
      <AppNotices />
      <BackupNudge />
      {fixes > 0 && (
        <a className="notice" href="#/report" style={{ textDecoration: 'none', display: 'block' }}>
          {fixes} cell{fixes > 1 ? 's' : ''} in your Excel file need a fix. See the import report.
        </a>
      )}
      {sync.state === 'error' && sync.message && (
        <a className="notice bad" href="#/settings" style={{ textDecoration: 'none', display: 'block' }}>
          Sync: {sync.message}
        </a>
      )}
      {folder.state === 'permission' && (
        <div className="notice row wrap">
          <span className="grow">Allow access to “{folder.name}” so the app can read new words and write the copy of your workbook.</span>
          <button type="button" className="btn small" onClick={() => allowFolder()}>
            Allow
          </button>
        </div>
      )}
      {(folder.state === 'missing' || folder.state === 'error') && folder.message && (
        <a className="notice bad" href="#/settings" style={{ textDecoration: 'none', display: 'block' }}>
          {folder.message}
        </a>
      )}
    </>
  );
}

/** Sync off, reviews exist, and no recent backup file: one line with a button. */
function BackupNudge() {
  const syncOff = useApp((s) => s.sync.state === 'off');
  const hasReviews = useApp((s) => s.events.length > 0);
  const [last, setLast] = useState<number | null | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (syncOff && hasReviews) lastBackup().then(setLast, () => setLast(undefined));
  }, [syncOff, hasReviews]);
  if (!syncOff || !hasReviews || last === undefined) return null;
  if (last != null && Date.now() - last < 7 * 86400000) return null;
  return (
    <div className="notice row wrap">
      <span className="grow">{last == null ? 'No backup yet. Sync is off, so your reviews live only on this device.' : `Last backup ${formatAgo(last)}. Sync is off.`}</span>
      <button
        type="button"
        className="btn small"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await saveBackupFile();
            setLast(await lastBackup());
          } catch (err) {
            toast(`Couldn't back up: ${(err as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      >
        Back up now
      </button>
    </div>
  );
}

/** Review link for a custom list of cards; `fresh` marks the ones that are new words (for the intro screen). */
function cardsHref(ids: string[], fresh: string[] = []): string {
  const enc = (l: string[]) => l.map(encodeURIComponent).join(',');
  return `#/review?cards=${enc(ids)}${fresh.length ? `&fresh=${enc(fresh)}` : ''}`;
}

/** Notices that matter on any screen with words: reload, newer app needed, held import. */
export function AppNotices() {
  const needsReload = useApp((s) => s.needsReload);
  const updateNeeded = useApp((s) => s.sync.updateNeeded);
  return (
    <>
      {needsReload && (
        <div className="notice row wrap" role="status">
          <span className="grow">The app was updated in another tab or window. Reload to keep working.</span>
          <button type="button" className="btn small" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      )}
      {updateNeeded && (
        <div className="notice row wrap" role="status">
          <span className="grow">Your words were saved by a newer version of the app. Reload to update.</span>
          <button type="button" className="btn small" onClick={() => location.reload()}>
            Update the app
          </button>
        </div>
      )}
      <PendingImportNotice />
    </>
  );
}

/** A new Excel list that looks broken is held here until Hugo chooses. */
export function PendingImportNotice() {
  const pending = useApp((s) => s.pendingImport);
  const [busy, setBusy] = useState(false);
  if (!pending) return null;
  const run = async (fn: () => Promise<void>, done: string) => {
    setBusy(true);
    try {
      await fn();
      toast(done);
    } catch (err) {
      toast(`Couldn't do that: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice bad stack" style={{ gap: 8 }} role="alert">
      <b>New word list held for review</b>
      <span>
        The Excel file now has {pending.vocab.notes.length} words; the list in the app has {pending.prevCount}.
      </span>
      <ul className="small" style={{ margin: 0, paddingLeft: 18 }}>
        {pending.reasons.map((r) => (
          <li key={r}>{r}</li>
        ))}
      </ul>
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy} onClick={() => run(rejectPendingImport, 'Kept the current list')}>
          Keep current list
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => run(acceptPendingImport, 'New list applied')}>
          Use the new list
        </button>
      </div>
    </div>
  );
}

function ImportResult({ outcome }: { outcome: ImportOutcome }) {
  const noteMap = getState().noteMap;
  const renamed = Object.values(outcome.renames ?? {}).map((id) => noteMap.get(id)?.hanzi ?? id);
  if (!outcome.applied) return <p className="notice">{summary(outcome)}</p>;
  return (
    <div className="notice ok stack" style={{ gap: 4 }}>
      <span>{summary(outcome.vocab)}</span>
      {renamed.length > 0 && (
        <span className="small">
          Renamed in Excel, history kept ({renamed.length}): <span className="zh">{renamed.slice(0, 12).join('、')}</span>
          {renamed.length > 12 ? '…' : ''}
        </span>
      )}
    </div>
  );
}

export function FileImportButton({ label = 'Import the Excel file', primary = false }: { label?: string; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        className="sr"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (!f) return;
          setBusy(true);
          try {
            const v = await importFile(f);
            setOutcome(v);
            toast(summary(v));
          } catch (err) {
            toast(`Couldn't read ${f.name}: ${(err as Error).message}`);
          } finally {
            setBusy(false);
          }
        }}
      />
      <button type="button" className={`btn ${primary ? 'primary' : ''}`} disabled={busy} onClick={() => input.current?.click()}>
        {busy ? 'Reading…' : label}
      </button>
      {outcome && <ImportResult outcome={outcome} />}
    </>
  );
}
