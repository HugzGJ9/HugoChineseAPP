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
import { formatAgo, LangSwitch, toast, TopBar } from './common';
import { FileImportButton } from './Today';
import { SourceSettings, SyncSettings } from './Setup';

export function Settings() {
  const { settings, meta, notes } = useApp((s) => s);
  return (
    <div className="main">
      <TopBar title="Settings" />
      <div className="stack-l">
        <section className="panel stack">
          <h2>More</h2>
          <nav className="more-links" aria-label="More screens">
            <a href="#/today">Today's reviews</a>
            <a href="#/stats">Stats</a>
            <a href="#/words">Words</a>
            <a href="#/report">Import report</a>
          </nav>
        </section>

        <section className="panel stack">
          <h2>Your words</h2>
          {meta ? (
            <p className="small muted">
              {notes.length} notes from {meta.source.name}, imported {formatAgo(meta.importedAt)}
              {meta.device ? ` on ${meta.device}` : ''}. <a href="#/report">Import report</a>
            </p>
          ) : (
            <p className="small muted">No words yet.</p>
          )}
          <SourceSettings />
          <div>
            <FileImportButton label="Import a file instead" />
          </div>
        </section>

        <SyncSettings />

        <section className="panel stack">
          <h2>Study</h2>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <NumberField label="New words a day" value={settings.newVocab} min={0} max={100} onChange={(v) => updateSettings({ newVocab: v })} />
            <NumberField label="New grammar a day" value={settings.newOther} min={0} max={20} onChange={(v) => updateSettings({ newOther: v })} />
            <NumberField label="Most reviews a day" value={settings.maxReviews} min={10} max={1000} onChange={(v) => updateSettings({ maxReviews: v })} />
          </div>
          <div className="row wrap" style={{ alignItems: 'flex-end' }}>
            <NumberField label="Target retention (%)" value={Math.round(settings.retention * 100)} min={70} max={97} onChange={(v) => updateSettings({ retention: v / 100 })} />
            <NumberField label="Spread green words over (days)" value={settings.spreadDays} min={1} max={365} onChange={(v) => updateSettings({ spreadDays: v })} />
          </div>
          <label className="check">
            <input type="checkbox" checked={settings.recall} onChange={(e) => updateSettings({ recall: e.target.checked })} />
            Recall cards (meaning → write or type the hanzi)
          </label>
          <label className="check">
            <input type="checkbox" checked={settings.listen} onChange={(e) => updateSettings({ listen: e.target.checked })} />
            Listening cards (audio → hanzi or meaning)
          </label>
          <p className="small muted">These settings are shared by all your devices.</p>
        </section>

        <section className="panel stack">
          <h2>Meanings and answers</h2>
          <div className="row">
            <span className="grow">Show meanings in</span>
            <LangSwitch />
          </div>
          <PrefCheck k="acceptBoth" def={true} label="Accept typed meanings in either English or French" />
          <p className="small muted">{CFDICT_CREDIT}.</p>
        </section>

        <ClaudeSettings />
        <AudioSettings />
        <OfflineSettings />

        <DataSettings />
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
    <section className="panel stack">
      <h2>Your data</h2>
      <p className="small muted">{events.length} reviews stored on this device.</p>
      {syncOff && isIosSafariTab() && (
        <p className="notice bad">
          Safari clears data from websites you haven't opened for 7 days. Add this app to your Home Screen, or turn on sync, so your progress is kept.
        </p>
      )}
      <p className="small muted">
        Storage: {store.persisted === true ? 'protected from automatic clearing.' : store.persisted === false ? 'may be cleared by the browser.' : 'status unknown.'}
        {syncOff ? ` ${last ? `Last backup ${formatAgo(last)}.` : 'No backup yet.'}` : ''}
      </p>
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
      <div className="row wrap">
        <button type="button" className="btn" disabled={busy} onClick={() => run(saveBackupFile)}>
          Back up to a file
        </button>
        <button type="button" className="btn" disabled={busy} onClick={() => input.current?.click()}>
          Restore from a file
        </button>
        {store.persisted === false && (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                toast((await requestPersist()) ? 'Storage protected' : 'The browser did not allow it');
              })
            }
          >
            Protect storage
          </button>
        )}
        <button
          type="button"
          className="btn danger"
          onClick={() => {
            if (confirmWipe(syncOff)) wipeAll();
          }}
        >
          Clear this device
        </button>
      </div>
      <p className="small muted">
        The backup file holds words, reviews, status changes and settings, but never the sync link. Restoring adds what is missing and removes nothing. Clearing removes words, reviews and the sync link from this device only. Reviews already synced come back when you link it again.
      </p>
    </section>
  );
}

function NumberField({ label, value, min, max, onChange }: { label: string; value: number; min: number; max: number; onChange: (v: number) => void }) {
  const [v, setV] = useState(String(value));
  useEffect(() => setV(String(value)), [value]);
  return (
    <label className="field" style={{ flex: '1 1 160px' }}>
      <span className="small">{label}</span>
      <input
        type="number"
        inputMode="numeric"
        value={v}
        min={min}
        max={max}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = Math.max(min, Math.min(max, Math.round(Number(v))));
          if (Number.isFinite(n) && n !== value) onChange(n);
          else setV(String(value));
        }}
      />
    </label>
  );
}

function PrefCheck({ k, def, label }: { k: string; def: boolean; label: string }) {
  const [on, setOn] = useState(() => pref(k, def));
  return (
    <label className="check">
      <input type="checkbox" checked={on} onChange={(e) => (setOn(e.target.checked), setPref(k, e.target.checked))} />
      {label}
    </label>
  );
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
  return (
    <section className="panel stack">
      <h2>Audio</h2>
      {voices.length ? (
        <label className="field">
          Voice
          <select value={voice} onChange={(e) => (setV(e.target.value), setVoice(e.target.value))}>
            <option value="">Automatic (on-device first)</option>
            {voices.map((v) => (
              <option key={v.voiceURI} value={v.voiceURI}>
                {v.name} {v.localService ? '(offline)' : '(online)'}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <p className="notice">
          No Chinese voice found. On Windows: Settings › Time & language › Speech › Add voices › Chinese (Simplified, China). On iPhone: Settings › Accessibility › Spoken Content › Voices › Chinese.
        </p>
      )}
      <label className="field">
        Speed {rate.toFixed(2)}
        <input type="range" min={0.5} max={1.2} step={0.05} value={rate} onChange={(e) => (setRate(Number(e.target.value)), setPref('rate', Number(e.target.value)))} />
      </label>
      <div>
        <button type="button" className="btn small" onClick={() => speak('你好，我们开始学习吧。')}>
          Test
        </button>
      </div>
    </section>
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
    <section className="panel stack">
      <h2>Offline</h2>
      <div className={`notice ${ready ? 'ok' : ''}`}>
        {ready ? 'Ready for offline: stroke data for all your characters is on this device.' : `Stroke data: ${cached ?? '…'} of ${chars.length} characters on this device.`}
      </div>
      {warm.phase === 'dict' && <p className="small muted">Saving the French dictionary for offline use…</p>}
      {warm.phase === 'strokes' && (
        <p className="small muted">
          Saving stroke data in the background: {warm.done} of {warm.total} new characters. You can keep using the app.
        </p>
      )}
      {!ready && (
        <div>
          <button
            type="button"
            className="btn"
            disabled={!!progress}
            onClick={async () => {
              const missing = await prefetchStrokes(chars, (d, t) => setProgress(`${d} / ${t}`));
              setProgress(null);
              setCached(await countCached(chars));
              toast(missing ? `${missing} characters have no stroke data` : 'Stroke data saved for offline use');
            }}
          >
            {progress ? `Downloading ${progress}` : 'Download stroke data'}
          </button>
        </div>
      )}
      <p className="small muted">
        French dictionary {dict ? 'saved on this device' : 'downloads on the first import'}.
      </p>
      <LexiconOffline />
    </section>
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
      <p className="small muted">
        Dictionary and examples: {c ? done : '…'} of {total} parts on this device.
        {warm.phase === 'lexicon' ? ' Saving in the background…' : ''}
      </p>
      {c && done < total && (
        <div>
          <button
            type="button"
            className="btn"
            disabled={!!progress}
            onClick={async () => {
              const failed = await prefetchLexicon((d, t) => setProgress(`${d} / ${t}`));
              setProgress(null);
              await refresh();
              toast(failed ? `${failed} parts could not be downloaded` : 'Dictionary saved for offline use');
            }}
          >
            {progress ? `Downloading ${progress}` : 'Download dictionary and examples'}
          </button>
        </div>
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
    <section className="panel stack" aria-labelledby="claude-h">
      <h2 id="claude-h">Explanations by Claude</h2>
      <p className="small muted">
        Tap Explain more on a word to get a precise meaning, nuances, collocations and example sentences from Claude (Anthropic). It needs your own API key.
      </p>
      <ol className="small muted" style={{ paddingLeft: '1.2em', margin: 0 }}>
        <li>
          Go to console.anthropic.com › API keys › Create key. Name it "Hugo 中文" and the device, for example "Hugo 中文 iPhone".
        </li>
        <li>Add a little credit, then set a monthly spend limit (Settings › Limits).</li>
        <li>Use one key per device, and paste it here. On iPhone, do this in the Home Screen app.</li>
      </ol>
      <p className="small muted">
        Cost: about 2 to 3 cents per word, paid once, because each explanation is saved and shared between your devices. 300 words come to about $8.
      </p>
      {hint && (
        <p className="small">
          Saved on this device: <code>{hint.hint}</code>, {formatAgo(hint.savedAt)}.
        </p>
      )}
      <label className="field">
        <span className="small">{hint ? 'Replace the key' : 'Claude API key'}</span>
        <input
          type="password"
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
      <div className="row wrap">
        <button type="button" className="btn primary" disabled={busy || !value.trim()} onClick={save}>
          Save key
        </button>
        <button type="button" className="btn" disabled={busy || !value.trim()} onClick={test}>
          Test key
        </button>
        {hint && (
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              if (!window.confirm('Remove the Claude key from this device?')) return;
              await removeClaudeKey();
              setNote({ text: 'Key removed from this device.' });
              refresh();
            }}
          >
            Remove key
          </button>
        )}
      </div>
      {note && (
        <p className={`notice ${note.bad ? 'bad' : 'ok'}`} role="status">
          {note.text}
        </p>
      )}
      <p className="small muted">
        The key stays on this device (it is not synced or backed up) and is only sent to api.anthropic.com. The words you explain are sent to Anthropic.
      </p>
      {usage && (
        <p className="small muted">
          This device this month: {usage.mineThisMonth} explanations, about {money(usage.costThisMonth)}. Saved explanations: {usage.saved}.
        </p>
      )}
    </section>
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
    <section className="panel stack" aria-labelledby="about-h">
      <h2 id="about-h">About</h2>
      <p className="small muted">Hugo 中文, version {typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev'}.</p>
      <ul className="small" style={{ paddingLeft: '1.2em', margin: 0 }}>
        {SOURCES.map((s) => (
          <li key={s.name}>
            {s.name}: {s.use}.{' '}
            <a href={s.url} target="_blank" rel="noopener noreferrer">
              {s.licence}
            </a>
          </li>
        ))}
      </ul>
      {meta && !meta.sample && (
        <p className="small muted">Dictionary and examples built on {meta.built}, adapted: filtered and reformatted.</p>
      )}
      <p className="small muted">Explanations: Claude (Anthropic), with your own key.</p>
    </section>
  );
}
