// The four word statuses: a one-tap picker (segmented, coloured by status), the row chip and the status glyph.
import type { WordStatus } from '../lib/types';
import { STATUS_LABEL, WORD_STATUSES } from '../lib/status';
import './status.css';

/** Text glyphs, kept for screens that print a status inline. New UI uses StatusIcon. */
export const STATUS_GLYPH: Record<WordStatus, string> = { new: '○', studying: '◐', notknown: '✕', mastered: '✓' };

/** SF-like status symbol: empty circle, half circle, cross in a circle, check in a filled circle. */
export function StatusIcon({ status, className = '' }: { status: WordStatus; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={`icon st-icon ${className}`} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {status === 'new' && <circle cx="12" cy="12" r="8" strokeDasharray="2.6 2.6" />}
      {status === 'studying' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4a8 8 0 010 16z" fill="currentColor" stroke="none" />
        </>
      )}
      {status === 'notknown' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
        </>
      )}
      {status === 'mastered' && (
        <>
          <circle cx="12" cy="12" r="9" fill="currentColor" stroke="none" />
          <path d="M8 12.4l2.7 2.7L16.2 9.6" stroke="var(--st-on, #fff)" strokeWidth="2" />
        </>
      )}
    </svg>
  );
}

export function StatusPicker({ value, onChange, compact = false }: { value: WordStatus; onChange: (s: WordStatus) => void; compact?: boolean }) {
  return (
    <div className={`st-seg ${compact ? 'compact' : ''}`} role="radiogroup" aria-label="Status">
      {WORD_STATUSES.map((s) => (
        <button key={s} type="button" role="radio" aria-checked={value === s} className={`st-${s}`} onClick={() => onChange(s)}>
          <StatusIcon status={s} />
          <span>{STATUS_LABEL[s]}</span>
        </button>
      ))}
    </div>
  );
}

/** The status of one row: a 44px button holding a tinted capsule (icon, and the label when there is room). */
export function StatusChip({ status, onClick }: { status: WordStatus; onClick: () => void }) {
  return (
    <button type="button" className="status-chip" onClick={onClick} aria-label={`Status: ${STATUS_LABEL[status]}`} aria-haspopup="menu">
      <span className={`sc-pill st-${status}`}>
        <StatusIcon status={status} />
        <span className="sc-label">{STATUS_LABEL[status]}</span>
      </span>
    </button>
  );
}
