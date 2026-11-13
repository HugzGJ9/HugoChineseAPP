import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { updateSettings, useApp, wipeAll } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { chineseVoices, setVoice, speak, speechAvailable } from '../lib/speech';
import { countCached, getWarmStatus, onWarmStatus, prefetchStrokes, uniqueChars } from '../lib/strokes';
import { lastBackup, requestPersist, restoreBackup, saveBackupFile, storageStatus } from '../lib/backup';
import { CFDICT_CREDIT } from '../lib/french';
import { dictUrl } from '../lib/import';
import { claudeKeyHint, ClaudeError, explainUsage, EXPLAIN_MODEL, onExplainChange, removeClaudeKey, setClaudeKey, testClaudeKey } from '../lib/explain';
import { LEXICON_SHARDS, lexiconCached, lexiconMeta, prefetchLexicon } from '../lib/lexicon';
import { Cell, formatAgo, Icon, LangSwitch, Row, Section, SwitchRow, toast, TopBar } from './common';
import { FileImportButton } from './Today';
import { SourceSettings, SyncSettings } from './Setup';
import { MicrosoftDiagnostics } from './Microsoft';

// Settings follows the iOS Settings app: inset grouped lists, grey section headers, footers for the fine print.
export function Settings() {
  const { settings, meta, notes } = useApp((s) => s);
  return (
    <div className="main">
      <TopBar title="Settings" />
      <div className="groups">
        <Section>
          <Row href="#/today" icon="today" iconBg="var(--badge-red)" label="Today's reviews" />
          <Row href="#/stats" icon="stats" iconBg="var(--badge-blue)" label="Stats" />
          <Row href="#/words" icon="words" iconBg="var(--badge-orange)" label="Words" />
          <Row href="#/report" icon="doc" iconBg="var(--badge-gray)" label="Import report" />
        </Section>

        <Section title="Your words" id="words-src">
          {meta ? (
            <Row
              label={`${notes.length} notes`}
              detail={`From ${meta.source.name}, imported ${formatAgo(meta.importedAt)}${meta.device ? ` on ${meta.device}` : ''}`}
            />
          ) : (
            <Row label="No words yet" />
          )}
          <Cell>
            <SourceSettings />
          </Cell>
          <Cell className="cell-actions">
            <FileImportButton label="Import a file instead" />
          </Cell>
        </Section>

        <SyncSettings />

        <Section title="Study" footer="These settings are shared by all your devices.">
          <NumberRow label="New words a day" value={settings.newVocab} min={0} max={100} onChange={(v) => updateSettings({ newVocab: v })} />
          <NumberRow label="New grammar a day" value={settings.newOther} min={0} max={20} onChange={(v) => updateSettings({ newOther: v })} />
          <NumberRow label="Most reviews a day" value={settings.maxReviews} min={10} max={1000} onChange={(v) => updateSettings({ maxReviews: v })} />
          <NumberRow label="Target retention" unit="%" value={Math.round(settings.retention * 100)} min={70} max={97} onChange={(v) => updateSettings({ retention: v / 100 })} />
          <NumberRow label="Spread green words over" unit="days" value={settings.spreadDays} min={1} max={365} onChange={(v) => updateSettings({ spreadDays: v })} />
          <SwitchRow label="Recall cards" detail="Meaning → write or type the hanzi" checked={settings.recall} onChange={(v) => updateSettings({ recall: v })} />
          <SwitchRow label="Listening cards" detail="Audio → hanzi or meaning" checked={settings.listen} onChange={(v) => updateSettings({ listen: v })} />
        </Section>

        <Section title="Meanings and answers" footer={`${CFDICT_CREDIT}.`}>
          <Row label="Show meanings in" trailing={<LangSwitch />} />
          <PrefSwitch k="acceptBoth" def={true} label="Accept English or French" detail="For typed meanings" />
        </Section>

        <ClaudeSettings />
        <AudioSettings />
        <OfflineSettings />

        <DataSettings />
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

function AudioSettings() {
  const [voices, setVoices] = useState(() => chineseVoices());
  const [voice, setV] = useState(() => pref('voice', ''));
  const [rate, setRate] = useState(() => pref('rate', 0.85));
  useEffect(() => {
    const t = setTimeout(() => setVoices(chineseVoices()), 500);
    return () => clearTimeout(t);
  }, []);
  if (!speechAvailable()) return null;
  const pct = ((rate - 0.5) / 0.7) * 100;
  return (
    <Section
      title="Audio"
      footer={
        voices.length
          ? undefined
          : 'No Chinese voice found. On Windows: Settings › Time & language › Speech › Add voices › Chinese (Simplified, China). On iPhone: Settings › Accessibility › Spoken Content › Voices › Chinese.'
      }
    >
      {voices.length > 0 && (
        <label className="cell">
          <span className="cell-body">
            <span className="cell-label">Voice</span>
          </span>
          <span className="cell-select">
            <select value={voice} aria-label="Voice" onChange={(e) => (setV(e.target.value), setVoice(e.target.value))}>
              <option value="">Automatic</option>
              {voices.map((v) => (
                <option key={v.voiceURI} value={v.voiceURI}>
                  {v.name} {v.localService ? '(offline)' : '(online)'}
                </option>
              ))}
            </select>
            <Icon name="updown" />
          </span>
        </label>
      )}
      <div className="cell cell-col">
        <div className="cell-line">
          <span className="cell-label" id="rate-l">
            Speed
          </span>
          <span className="cell-value">{rate.toFixed(2)}×</span>
        </div>
        <div className="cell-slider">
          <span className="tiny faint" aria-hidden="true">
            Slow
          </span>
          <input
            type="range"
            aria-labelledby="rate-l"
            min={0.5}
            max={1.2}
            step={0.05}
            value={rate}
            style={{ ['--p' as string]: `${pct}%` }}
            onChange={(e) => (setRate(Number(e.target.value)), setPref('rate', Number(e.target.value)))}
          />
          <span className="tiny faint" aria-hidden="true">
            Fast
          </span>
        </div>
      </div>
      <Row tone="action" glyph="sound" label="Test voice" chevron={false} onClick={() => speak('你好，我们开始学习吧。')} />
    </Section>
  );
}

function OfflineSettings() {
  const notes = useApp((s) => s.notes);
  const chars = useMemo(() => uniqueChars(notes.filter((n) => n.kind !== 'grammar').map((n) => n.hanzi + n.alts.join(''))), [notes]);
  const [cached, setCached] = useState<number | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [dict, setDict] = useState<boolean | null>(null);
  const warm = useSyncExternalStore(onWarmStatus, getWarmStatus);
  useEffect(() => {
    countCached(chars).then(setCached);
    if ('caches' in window) caches.match(dictUrl()).then((r) => setDict(!!r));
  }, [chars, warm.phase, warm.done]);
  const ready = cached != null && cached >= chars.length;
  return (
    <Section title="Offline">
      <Row
        label="Stroke data"
        value={ready ? <Ready text="Ready" /> : `${cached ?? '…'} of ${chars.length}`}
        detail={
          warm.phase === 'strokes'
            ? `Saving in the background: ${warm.done} of ${warm.total} new characters.`
            : ready
              ? 'All your characters are on this device.'
              : undefined
        }
      />
      {!ready && (
        <Row
          tone="action"
          glyph="download"
          chevron={false}
          disabled={!!progress}
          label={progress ? `Downloading ${progress}` : 'Download stroke data'}
          onClick={async () => {
            const missing = await prefetchStrokes(chars, (d, t) => setProgress(`${d} / ${t}`));
            setProgress(null);
            setCached(await countCached(chars));
            toast(missing ? `${missing} characters have no stroke data` : 'Stroke data saved for offline use');
          }}
        />
      )}
      <Row
        label="French dictionary"
        value={dict ? <Ready text="Saved" /> : 'On first import'}
        detail={warm.phase === 'dict' ? 'Saving for offline use…' : undefined}
      />
      <LexiconOffline />
    </Section>
  );
}

function Ready({ text }: { text: string }) {
  return (
    <span className="ok-value">
      <Icon name="check-circle" /> {text}
    </span>
  );
}

function LexiconOffline() {
  const [c, setC] = useState<{ cached: number; total: number } | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const warm = useSyncExternalStore(onWarmStatus, getWarmStatus);
  const refresh = () => lexiconCached().then(setC, () => setC(null));
  useEffect(() => void refresh(), [warm.phase, warm.done]);
  const total = c?.total ?? LEXICON_SHARDS;
  const done = c?.cached ?? 0;
  return (
    <>
      <Row
        label="Dictionary and examples"
        value={c && done >= total ? <Ready text="Ready" /> : `${c ? done : '…'} of ${total}`}
        detail={warm.phase === 'lexicon' ? 'Saving in the background…' : undefined}
      />
      {c && done < total && (
        <Row
          tone="action"
          glyph="download"
          chevron={false}
          disabled={!!progress}
          label={progress ? `Downloading ${progress}` : 'Download dictionary and examples'}
          onClick={async () => {
            const failed = await prefetchLexicon((d, t) => setProgress(`${d} / ${t}`));
            setProgress(null);
            await refresh();
            toast(failed ? `${failed} parts could not be downloaded` : 'Dictionary saved for offline use');
          }}
        />
      )}
    </>
  );
}

function money(x: number): string {
  return x < 0.01 ? 'under $0.01' : `$${x.toFixed(2)}`;
}

function ClaudeSettings() {
  const [hint, setHint] = useState<{ hint: string; savedAt: number } | null | undefined>(undefined);
  const [usage, setUsage] = useState<{ saved: number; mineThisMonth: number; costThisMonth: number } | null>(null);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ text: string; bad?: boolean } | null>(null);
  const refresh = () => {
    claudeKeyHint().then(setHint, () => setHint(null));
    explainUsage().then(setUsage, () => setUsage(null));
  };
  useEffect(() => {
    refresh();
    return onExplainChange(refresh);
  }, []);
  const fail = (err: unknown) => setNote({ text: err instanceof ClaudeError ? err.message : "Couldn't check the key.", bad: true });
  const save = async () => {
    const key = value.trim();
    if (!key) return;
    setBusy(true);
    setNote(null);
    try {
      let msg = 'Key saved on this device.';
      try {
        const r = await testClaudeKey(key);
        if (!r.checked) msg = "Key saved on this device. Couldn't check it.";
        else if (r.modelListed === false) msg = `Key saved. It works, but ${EXPLAIN_MODEL} was not in its model list.`;
        else msg = 'Key saved on this device and checked.';
      } catch (err) {
        if (err instanceof ClaudeError && err.kind === 'key') {
          fail(err);
          return;
        }
        msg = "Key saved on this device. Couldn't check it.";
      }
      await setClaudeKey(key);
      setValue('');
      setNote({ text: msg });
      refresh();
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  const test = async () => {
    setBusy(true);
    setNote(null);
    try {
      // The saved key is never read back into the page; test what was typed.
      const r = await testClaudeKey(value.trim());
      setNote({ text: r.checked ? 'The key works.' : "Couldn't check the key. Check the connection." });
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Section
      title="Explanations by Claude"
      id="claude"
      footer={
        <>
          The key stays on this device (it is not synced or backed up) and is only sent to api.anthropic.com. The words you explain are sent to Anthropic.
        </>
      }
    >
      <Cell>
        <p className="small muted">
          Tap Explain more on a word to get a precise meaning, nuances, collocations and example sentences from Claude (Anthropic). It needs your own API key.
        </p>
      </Cell>
      <details className="cell-details">
        <summary className="cell tap">
          <span className="cell-body">
            <span className="cell-label">How to get a key</span>
          </span>
          <Icon name="chevron" className="cell-chev" />
        </summary>
        <div className="cell cell-pad">
          <ol className="small muted steps">
            <li>Go to console.anthropic.com › API keys › Create key. Name it "Hugo 中文" and the device, for example "Hugo 中文 iPhone".</li>
            <li>Add a little credit, then set a monthly spend limit (Settings › Limits).</li>
            <li>Use one key per device, and paste it here. On iPhone, do this in the Home Screen app.</li>
          </ol>
          <p className="small muted">
            Cost: about 2 to 3 cents per word, paid once, because each explanation is saved and shared between your devices. 300 words come to about $8.
          </p>
        </div>
      </details>
      {hint && <Row label="Saved on this device" value={<code>{hint.hint}</code>} detail={formatAgo(hint.savedAt)} />}
      <label className="cell">
        <span className="cell-label cell-fixed">{hint ? 'New key' : 'API key'}</span>
        <input
          type="password"
          className="cell-input left"
          aria-label="Claude API key"
          autoComplete="off"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder="sk-ant-…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
        />
      </label>
      <Cell className="cell-actions">
        <button type="button" className="btn primary" disabled={busy || !value.trim()} onClick={save}>
          Save key
        </button>
        <button type="button" className="btn" disabled={busy || !value.trim()} onClick={test}>
          Test key
        </button>
      </Cell>
      {note && (
        <Cell>
          <p className={`notice ${note.bad ? 'bad' : 'ok'}`} role="status">
            {note.text}
          </p>
        </Cell>
      )}
      {usage && (
        <Row
          label="This month"
          value={money(usage.costThisMonth)}
          detail={`${usage.mineThisMonth} explanations on this device. Saved in all: ${usage.saved}.`}
        />
      )}
      {hint && (
        <Row
          tone="destructive"
          label="Remove key"
          disabled={busy}
          onClick={async () => {
            if (!window.confirm('Remove the Claude key from this device?')) return;
            await removeClaudeKey();
            setNote({ text: 'Key removed from this device.' });
            refresh();
          }}
        />
      )}
    </Section>
  );
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
      <Section title="About">
        <Row label="Hugo 中文" value={typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'} />
      </Section>
      <Section
        title="Sources"
        id="about"
        footer={
          <>
            {meta && !meta.sample && <>Dictionary and examples built on {meta.built}, adapted: filtered and reformatted. </>}
            Explanations: Claude (Anthropic), with your own key.
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
