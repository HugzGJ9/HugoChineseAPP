import { useEffect, useState } from 'react';
import { useAppPick } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { chineseVoices, setVoice, speak, speechAvailable } from '../lib/speech';
import { Cell, formatAgo, Icon, Row, Section, TopBar } from './common';
import { FileImportButton } from './Today';
import { SourceSettings } from './Setup';
import { SettingsAdvanced } from './SettingsAdvanced';
import './screens.css';

// Settings follows the iOS Settings app: inset grouped lists, grey section headers, footers for the fine print.
// `#/settings` is the short page; `#/settings/advanced` holds the rest (SettingsAdvanced).
export function Settings({ sub }: { sub?: string }) {
  if (sub === 'advanced') return <SettingsAdvanced />;
  return <SettingsMain />;
}

function SettingsMain() {
  const { meta, notes } = useAppPick('meta', 'notes');
  return (
    <div className="main">
      <TopBar title="Settings" />
      <div className="groups">
        <Section title="Your workbook" id="words-src">
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

        <AudioSettings />

        <Section>
          <Row href="#/settings/advanced" icon="settings" iconBg="var(--badge-gray)" label="Advanced" />
        </Section>
      </div>
    </div>
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
