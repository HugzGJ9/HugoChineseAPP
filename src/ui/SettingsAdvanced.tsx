import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { updateSettings, useApp, useAppPick, wipeAll } from '../lib/store';
import { clearDevLog, devLogSummary, diagnosticsText, onDevLogChange } from '../lib/devlog';
import { pref, setPref } from '../lib/db';
import { lastBackup, requestPersist, restoreBackup, saveBackupFile, storageStatus } from '../lib/backup';
import { CFDICT_CREDIT } from '../lib/french';
import { lexiconMeta } from '../lib/lexicon';
import { Cell, formatAgo, Icon, Row, Section, SwitchRow, toast, TopBar } from './common';
import { SyncSettings } from './Setup';
import { MicrosoftDiagnostics } from './Microsoft';
import './screens.css';

/** `#/settings/advanced`: everything that is not day-to-day (D9 of plan 2026-11-27-word-panel-settings). */
export function SettingsAdvanced() {
  const { settings } = useAppPick('settings');
  return (
    <div className="main">
      <TopBar title="Advanced" back="#/settings" />
      <div className="groups">
        <Section>
          <Row href="#/today" icon="today" iconBg="var(--badge-red)" label="Today's reviews" />
          <Row href="#/stats" icon="stats" iconBg="var(--badge-blue)" label="Stats" />
          <Row href="#/words" icon="words" iconBg="var(--badge-orange)" label="Words" />
          <Row href="#/report" icon="doc" iconBg="var(--badge-gray)" label="Import report" />
        </Section>

        <SyncSettings />

        <DataSettings />

        <Section title="Study" footer="These settings are shared by all your devices.">
          <NumberRow label="New words a day" value={settings.newVocab} min={0} max={100} onChange={(v) => updateSettings({ newVocab: v })} />
          <NumberRow label="New grammar a day" value={settings.newOther} min={0} max={20} onChange={(v) => updateSettings({ newOther: v })} />
          <NumberRow label="Most reviews a day" value={settings.maxReviews} min={10} max={1000} onChange={(v) => updateSettings({ maxReviews: v })} />
          <NumberRow label="Target retention" unit="%" value={Math.round(settings.retention * 100)} min={70} max={97} onChange={(v) => updateSettings({ retention: v / 100 })} />
          <NumberRow label="Spread green words over" unit="days" value={settings.spreadDays} min={1} max={365} onChange={(v) => updateSettings({ spreadDays: v })} />
          <SwitchRow label="Recall cards" detail="Meaning → write or type the hanzi" checked={settings.recall} onChange={(v) => updateSettings({ recall: v })} />
          <SwitchRow label="Listening cards" detail="Audio → hanzi or meaning" checked={settings.listen} onChange={(v) => updateSettings({ listen: v })} />
        </Section>

        <Section title="Answers" footer={`${CFDICT_CREDIT}.`}>
          <PrefSwitch k="acceptBoth" def={true} label="Accept English or French" detail="For typed meanings" />
        </Section>

        <Section title="Troubleshooting">
          <Cell>
            <MicrosoftDiagnostics />
          </Cell>
        </Section>
        <AboutSection />
      </div>
    </div>
  );
}

function confirmWipe(syncOff: boolean): boolean {
  // A deliberate, rare action: a native confirm is acceptable here.
  return window.confirm(
    `Clear all words, reviews and settings stored on this device?${syncOff ? '\n\nSync is off. Back up to a file first, or this history is lost.' : ''}`,
  );
}

function isIosSafariTab(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = (navigator as unknown as { standalone?: boolean }).standalone === true || matchMedia('(display-mode: standalone)').matches;
  return ios && !standalone;
}

function DataSettings() {
  const events = useApp((s) => s.events);
  const syncOff = useApp((s) => s.sync.state === 'off');
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [last, setLast] = useState<number | null>(null);
  const [store, setStore] = useState<{ persisted: boolean | null }>({ persisted: null });
  const refresh = () => {
    lastBackup().then(setLast, () => setLast(null));
    storageStatus().then(setStore, () => undefined);
  };
  useEffect(refresh, []);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try {
      await fn();
    } catch (err) {
      toast(`Couldn't do that: ${(err as Error).message}`);
    } finally {
      setBusy(false);
      refresh();
    }
  };
  return (
    <>
      <Section
        title="Your data"
        id="data"
        footer="The backup file holds words, reviews, status changes and settings, but never the sync link. Restoring adds what is missing and removes nothing."
      >
        {syncOff && isIosSafariTab() && (
          <Cell>
            <p className="notice bad">
              Safari clears data from websites you haven't opened for 7 days. Add this app to your Home Screen, or turn on sync, so your progress is kept.
            </p>
          </Cell>
        )}
        <Row label="Reviews on this device" value={events.length.toLocaleString()} />
        <Row
          label="Storage"
          value={store.persisted === true ? 'Protected' : store.persisted === false ? 'May be cleared' : 'Unknown'}
          detail={store.persisted === false ? 'The browser may clear it to free space.' : undefined}
        />
        {syncOff && <Row label="Last backup" value={last ? formatAgo(last) : 'Never'} />}
        <input
          ref={input}
          type="file"
          className="sr"
          aria-label="Backup file to restore"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = '';
            if (!f) return;
            run(async () => {
              const r = await restoreBackup(new Uint8Array(await f.arrayBuffer()));
              toast(`Restored ${r.events} reviews and ${r.marks} status changes${r.vocab === 'applied' ? ', and your word list' : ''}`);
            });
          }}
        />
        <Row tone="action" glyph="upload" label="Back up to a file" disabled={busy} onClick={() => run(saveBackupFile)} chevron={false} />
        <Row tone="action" glyph="download" label="Restore from a file" disabled={busy} onClick={() => input.current?.click()} chevron={false} />
        {store.persisted === false && (
          <Row
            tone="action"
            glyph="lock"
            label="Protect storage"
            disabled={busy}
            chevron={false}
            onClick={() =>
              run(async () => {
                toast((await requestPersist()) ? 'Storage protected' : 'The browser did not allow it');
              })
            }
          />
        )}
      </Section>
      <Section footer="Clearing removes words, reviews and the sync link from this device only. Reviews already synced come back when you link it again.">
        <Row
          tone="destructive"
          center
          label="Clear this device"
          onClick={() => {
            if (confirmWipe(syncOff)) wipeAll();
          }}
        />
      </Section>
    </>
  );
}

function NumberRow({ label, unit, value, min, max, onChange }: { label: string; unit?: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="cell">
      <span className="cell-body">
        <span className="cell-label">{label}</span>
      </span>
      <span className="cell-num">
        <input
          type="number"
          inputMode="numeric"
          className="cell-input"
          aria-label={unit ? `${label} (${unit})` : label}
          value={v}
          min={min}
          max={max}
          onChange={(e) => setV(e.target.value)}
          onFocus={(e) => e.currentTarget.select()}
          onKeyDown={(e) => e.key === 'Enter' && e.currentTarget.blur()}
          onBlur={() => {
            const n = Math.max(min, Math.min(max, Math.round(Number(v))));
            if (Number.isFinite(n) && n !== value) onChange(n);
            else setV(String(value));
          }}
        />
        {unit && <span className="cell-unit">{unit}</span>}
      </span>
    </label>
  );
}

function PrefSwitch({ k, def, label, detail }: { k: string; def: boolean; label: string; detail?: string }) {
  const [on, setOn] = useState(() => pref(k, def));
  return <SwitchRow label={label} detail={detail} checked={on} onChange={(v) => (setOn(v), setPref(k, v))} />;
}

const SOURCES: { name: string; use: string; licence: string; url: string }[] = [
  { name: 'CC-CEDICT (MDBG)', use: 'English dictionary', licence: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
  { name: 'CFDICT', use: 'French dictionary', licence: 'CC BY-SA 3.0', url: 'https://creativecommons.org/licenses/by-sa/3.0/' },
  { name: 'Tatoeba', use: 'example sentences', licence: 'CC BY 2.0 FR', url: 'https://creativecommons.org/licenses/by/2.0/fr/' },
  { name: 'Hanzi Writer / Make Me a Hanzi', use: 'stroke data', licence: 'open licences', url: 'https://github.com/skishore/makemeahanzi' },
  { name: 'ts-fsrs', use: 'review scheduling (FSRS)', licence: 'MIT', url: 'https://github.com/open-spaced-repetition/ts-fsrs' },
  { name: 'pinyin-pro', use: 'pinyin', licence: 'MIT', url: 'https://github.com/zh-lx/pinyin-pro' },
];

declare const __APP_VERSION__: string;

function AboutSection() {
  const [meta, setMeta] = useState<Awaited<ReturnType<typeof lexiconMeta>>>(null);
  useEffect(() => {
    lexiconMeta().then(setMeta, () => setMeta(null));
  }, []);
  return (
    <>
      <Section
        title="About"
        footer="Diagnostics hold the app version, sync state, counts and the last errors on this device, never your words, files or account. Paste them into a chat when something goes wrong."
      >
        <Row label="Hugo 中文" value={typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'} />
        <Diagnostics />
      </Section>
      <Section
        title="Sources"
        id="about"
        footer={
          <>
            {meta && !meta.sample && <>Dictionary and examples built on {meta.built}, adapted: filtered and reformatted. </>}
            
          </>
        }
      >
        {SOURCES.map((s) => (
          <Row key={s.name} href={s.url} external label={s.name} detail={`${s.use[0].toUpperCase()}${s.use.slice(1)} · ${s.licence}`} />
        ))}
      </Section>
    </>
  );
}

/** Settings › About: problems logged on this device (lib/devlog, plan 2026-11-26-boot-and-guards WP7). */
function Diagnostics() {
  const sum = useSyncExternalStore(onDevLogChange, () => {
    const n = devLogSummary();
    return n.errors * 1000 + n.warnings;
  });
  const errors = Math.floor(sum / 1000);
  const warnings = sum % 1000;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const pre = useRef<HTMLPreElement>(null);
  const load = async () => {
    const t = await diagnosticsText();
    setText(t);
    return t;
  };
  const copy = async () => {
    const t = await load();
    try {
      await navigator.clipboard.writeText(t);
      toast('Diagnostics copied');
    } catch {
      setOpen(true);
      requestAnimationFrame(() => {
        const el = pre.current;
        if (!el) return;
        const r = document.createRange();
        r.selectNodeContents(el);
        const sel = window.getSelection();
        sel?.removeAllRanges();
        sel?.addRange(r);
      });
      toast('Select the text and copy it');
    }
  };
  const count = errors + warnings;
  const value = count === 0 ? 'None' : [errors && `${errors} error${errors > 1 ? 's' : ''}`, warnings && `${warnings} warning${warnings > 1 ? 's' : ''}`].filter(Boolean).join(', ');
  return (
    <>
      <Row label="Problems on this device" value={value} />
      <Row tone="action" label="Copy diagnostics" chevron={false} onClick={() => void copy()} />
      <details
        className="cell-details"
        open={open}
        onToggle={(e) => {
          const o = (e.currentTarget as HTMLDetailsElement).open;
          setOpen(o);
          if (o) void load();
        }}
      >
        <summary className="cell tap">
          <span className="cell-body">
            <span className="cell-label">Show diagnostics</span>
          </span>
          <Icon name="chevron" className="cell-chev" />
        </summary>
        <div className="cell cell-pad">
          <pre className="diag-text" ref={pre}>
            {text || '…'}
          </pre>
          {count > 0 && (
            <button
              type="button"
              className="btn small"
              onClick={() =>
                void clearDevLog().then(() => {
                  void load();
                  toast('Problems cleared');
                })
              }
            >
              Clear
            </button>
          )}
        </div>
      </details>
    </>
  );
}

