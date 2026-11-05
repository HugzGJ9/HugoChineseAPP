import { FileImportButton } from './Today';

/** First-run choices for getting the words onto this device. */
export function SetupSources() {
  return (
    <div className="panel stack">
      <h2>Import from a file</h2>
      <p className="muted small">
        Pick Hugo_chinese_vocab.xlsx. On iPhone, choose it in the Files app (OneDrive appears under Browse once the OneDrive app is installed).
      </p>
      <div>
        <FileImportButton primary />
      </div>
    </div>
  );
}

/** OneDrive folder link (computer). */
export function SourceSettings() {
  return null;
}

/** Sync through the private GitHub repository. */
export function SyncSettings() {
  return null;
}
