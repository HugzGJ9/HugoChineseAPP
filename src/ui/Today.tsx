import { useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { buildQueue } from '../lib/engine/queue';
import { streak } from '../lib/stats';
import { importFile, summary } from '../lib/sources';
import { formatAgo, Icon, LangSwitch, toast, TopBar, useNow } from './common';
import { SetupSources } from './Setup';
import { allowFolder } from '../lib/folder';

export function Today() {
  const now = useNow();
  const { notes, cards, noteMap, events, settings, meta, sync, folder } = useApp((s) => s);
  const q = useMemo(() => buildQueue([...cards.values()], noteMap, events, settings, now), [cards, noteMap, events, settings, now]);
  const fixes = meta?.issues.filter((i) => i.level === 'fix').length ?? 0;
  const days = useMemo(() => streak(events, now), [events, now]);

  if (!notes.length && sync.state === 'running') {
    return (
      <div className="main">
        <TopBar title="Hugo 中文" />
        <p className="notice">Getting your words from sync…</p>
      </div>
    );
  }

  if (!notes.length) {
    return (
      <div className="main">
        <TopBar title="Hugo 中文" />
        <div className="stack-l">
          <p className="muted" style={{ maxWidth: '52ch' }}>
            Your words come from Hugo_chinese_vocab.xlsx. Choose how this device gets them; you only do this once.
          </p>
          {sync.state !== 'off' && <p className="notice">Sync is on, but no device has sent words yet. Link the OneDrive folder on your computer, or import the Excel file.</p>}
          <SetupSources linked={sync.state !== 'off'} />
        </div>
      </div>
    );
  }

  const due = q.counts.due + q.counts.learning;
  const total = q.cards.length;
  return (
    <div className="main">
      <TopBar title="Today">
        <LangSwitch />
        <a className="icon-btn" href="#/settings" aria-label="Settings">
          <Icon name="settings" />
        </a>
      </TopBar>
      <div className="stack-l">
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
            <p className="notice ok">All caught up for today. Quick memory is always open for free practice.</p>
          )}
          <p className="small muted">
            {days > 0 ? `${days}-day streak. ` : ''}
            {q.counts.newVocabLeft === 0 && q.counts.introducedToday > 0 ? 'Daily new words reached. ' : ''}
            {sync.state !== 'off' ? `Synced ${formatAgo(sync.last, now)}.` : ''}
          </p>
        </section>
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
            <span className="grow">Allow access to “{folder.name}” so the app can read new words and update your progress file.</span>
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
        <section className="row wrap">
          <a className="btn" href="#/quick">
            <Icon name="quick" /> Quick memory
          </a>
          <a className="btn" href="#/grammar">
            <Icon name="grammar" /> Grammar
          </a>
          <a className="btn" href="#/stats">
            <Icon name="stats" /> Stats
          </a>
        </section>
      </div>
    </div>
  );
}

export function FileImportButton({ label = 'Import the Excel file', primary = false }: { label?: string; primary?: boolean }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
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
    </>
  );
}
