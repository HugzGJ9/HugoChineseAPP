// The four word statuses: a one-tap picker, and the small chip that shows a row's status.
import type { WordStatus } from '../lib/types';
import { STATUS_LABEL, WORD_STATUSES } from '../lib/status';

export const STATUS_GLYPH: Record<WordStatus, string> = { new: '○', studying: '◐', notknown: '✕', mastered: '✓' };

export function StatusPicker({ value, onChange, compact = false }: { value: WordStatus; onChange: (s: WordStatus) => void; compact?: boolean }) {
  return (
    <div className={`status-picker ${compact ? 'compact' : ''}`} role="radiogroup" aria-label="Status">
      {WORD_STATUSES.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} className={`sp-${s}`} onClick={() => onChange(s)}>
          <span aria-hidden="true">{STATUS_GLYPH[s]}</span> {STATUS_LABEL[s]}
        </button>
      ))}
    </div>
  );
}

export function StatusChip({ status, onClick }: { status: WordStatus; onClick: () => void }) {
  return (
    <button type="button" className={`status-chip sp-${status}`} onClick={onClick} aria-label={`Status: ${STATUS_LABEL[status]}`} aria-haspopup="menu">
      <span aria-hidden="true">{STATUS_GLYPH[status]}</span>
      <span className="sc-label">{STATUS_LABEL[status]}</span>
    </button>
  );
}
