// Small bottom-sheet menus for the compact Sheets toolbar: status filter and the "more" overflow.
import type { ReactNode } from 'react';
import type { WordStatus } from '../../lib/types';
import { STATUS_LABEL, WORD_STATUSES } from '../../lib/status';
import { PresetSeg, type Shown } from '../qm';
import { Icon, LangSwitch } from '../common';
import { StatusIcon } from '../StatusPicker';
import { Sheet } from '../panel';

export type Filter = 'all' | WordStatus;

function MenuShell({ label, onClose, children, after }: { label: string; onClose: () => void; children: ReactNode; after?: ReactNode }) {
  return (
    <Sheet variant="menu" size="content" label={label} onClose={onClose}>
      <div role="menu" aria-label={label} className="pop-menu">
        {children}
      </div>
      {after}
      <button type="button" className="btn block" onClick={onClose}>
        Close
      </button>
    </Sheet>
  );
}

export function FilterMenu({ value, counts, onPick, onClose }: { value: Filter; counts: Record<Filter, number>; onPick: (f: Filter) => void; onClose: () => void }) {
  return (
    <MenuShell label="Filter by status" onClose={onClose}>
      {(['all', ...WORD_STATUSES] as Filter[]).map((f) => (
        <button key={f} type="button" role="menuitemradio" aria-checked={value === f} className={`pop-item ${f === 'all' ? 'mn-all' : `st-${f}`}`} onClick={() => onPick(f)}>
          {f === 'all' ? <Icon name="list" className="pop-st" /> : <StatusIcon status={f} className="pop-st" />}
          {f === 'all' ? 'All' : STATUS_LABEL[f]}
          <span className="sh-count mn-count">{counts[f]}</span>
          <span className="mn-check">{value === f && <Icon name="check" />}</span>
        </button>
      ))}
    </MenuShell>
  );
}

export function MoreMenu({
  paint, reviewHref, reviewCount, due, preset, hasAnswers = false, onPaint, onScratch, onClearAnswers, onPreset, onClose,
}: {
  paint: boolean; reviewHref: string | null; reviewCount: number; due: number; preset: string; hasAnswers?: boolean;
  onPaint: () => void; onScratch: () => void; onClearAnswers?: () => void; onPreset: (s: Shown, name: string) => void; onClose: () => void;
}) {
  return (
    <MenuShell
      label="More"
      onClose={onClose}
      after={
        <div className="mn-group">
          <div className="mn-row pop-lang">
            <span>Meaning language</span>
            <LangSwitch />
          </div>
          <div className="mn-row mn-col">
            <span id="quiz-mode-label">Quiz mode</span>
            <PresetSeg preset={preset} onPreset={onPreset} id="quiz-mode-label" />
          </div>
        </div>
      }
    >
      <button type="button" role="menuitem" className="pop-item mn-act" onClick={onPaint}>
        <Icon name="check-circle" className="mn-glyph" />
        <span className="grow">{paint ? 'Stop painting' : 'Paint statuses'}</span>
      </button>
      {reviewHref && (
        <a role="menuitem" className="pop-item mn-act" href={reviewHref} onClick={onClose}>
          <Icon name="bolt" className="mn-glyph" />
          <span className="grow">Review these</span>
          <span className="sh-count mn-count">{reviewCount}</span>
        </a>
      )}
      {due > 0 && (
        <a role="menuitem" className="pop-item mn-act" href="#/review" onClick={onClose}>
          <Icon name="clock" className="mn-glyph" />
          <span className="grow">Due reviews</span>
          <span className="sh-count mn-count">{due}</span>
        </a>
      )}
      <button type="button" role="menuitem" className="pop-item mn-act" onClick={onScratch}>
        <Icon name="pen" className="mn-glyph" />
        <span className="grow">Scratch pad</span>
      </button>
      {hasAnswers && onClearAnswers && (
        <button type="button" role="menuitem" className="pop-item mn-act" onClick={onClearAnswers}>
          <Icon name="close" className="mn-glyph" />
          <span className="grow">Clear answers</span>
        </button>
      )}
    </MenuShell>
  );
}
