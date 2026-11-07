import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { updateSettings, useApp, wipeAll } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { chineseVoices, setVoice, speak, speechAvailable } from '../lib/speech';
import { countCached, getWarmStatus, onWarmStatus, prefetchStrokes, uniqueChars } from '../lib/strokes';
import { CFDICT_CREDIT } from '../lib/french';
import { dictUrl } from '../lib/import';
import { formatAgo, LangSwitch, toast, TopBar } from './common';
import { FileImportButton } from './Today';
import { SourceSettings, SyncSettings } from './Setup';

export function Settings() {
  const { settings, meta, notes, events } = useApp((s) => s);
  return (
    <div className="main">
      <TopBar title="Settings" />
      <div className="stack-l">
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

        <AudioSettings />
        <OfflineSettings />

        <section className="panel stack">
          <h2>Your data</h2>
          <p className="small muted">{events.length} reviews stored on this device.</p>
          <div className="row wrap">
            <button
              type="button"
              className="btn"
              onClick={() => {
                const blob = new Blob([JSON.stringify({ exportedAt: Date.now(), events }, null, 1)], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `hugo-zhongwen-reviews-${new Date().toISOString().slice(0, 10)}.json`;
                a.click();
                URL.revokeObjectURL(a.href);
              }}
            >
              Export review history
            </button>
            <button
              type="button"
              className="btn danger"
              onClick={() => {
                if (confirmWipe()) wipeAll();
              }}
            >
              Clear this device
            </button>
          </div>
          <p className="small muted">Clearing removes words, reviews and the sync link from this device only. Reviews already synced come back when you link it again.</p>
        </section>
        <p className="small faint center">
          Stroke data: Hanzi Writer / Make Me a Hanzi. Scheduling: FSRS (ts-fsrs). Pinyin: pinyin-pro.
        </p>
      </div>
    </div>
  );
}

function confirmWipe(): boolean {
  // A deliberate, rare action: a native confirm is acceptable here.
  return window.confirm('Clear all words, reviews and settings stored on this device?');
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
  const [persisted, setPersisted] = useState<boolean | null>(null);
  const warm = useSyncExternalStore(onWarmStatus, getWarmStatus);
  useEffect(() => {
    countCached(chars).then(setCached);
    if ('caches' in window) caches.match(dictUrl()).then((r) => setDict(!!r));
    navigator.storage?.persisted?.().then(setPersisted).catch(() => setPersisted(null));
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
        {persisted === false ? ' The browser may clear storage when space runs low; your reviews are safe once synced.' : ''}
      </p>
    </section>
  );
}
