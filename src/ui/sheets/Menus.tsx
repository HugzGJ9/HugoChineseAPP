// Small bottom-sheet menus for the compact Sheets toolbar: status filter and the "more" overflow.
import type { ReactNode } from 'react';
import type { ListFilter } from '../../lib/quick';
import { STATUS_LABEL } from '../../lib/status';
import { PresetSeg, type Shown } from '../qm';
import { Icon, LangSwitch } from '../common';
import { StatusIcon } from '../StatusPicker';
import { Sheet } from '../panel';

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

export const FILTER_LABEL: Record<ListFilter, string> = {
  all: 'All', new: STATUS_LABEL.new, studying: STATUS_LABEL.studying, notknown: STATUS_LABEL.notknown, mastered: STATUS_LABEL.mastered,
  wrong: 'Wrong', week: 'Seen this week', missed: 'Missed recently',
};
const FILTER_ICON: Partial<Record<ListFilter, string>> = { all: 'list', wrong: 'x-circle', week: 'clock', missed: 'bolt' };
const FILTER_ORDER: ListFilter[] = ['all', 'new', 'studying', 'notknown', 'mastered', 'wrong', 'week', 'missed'];

/** Status filters first, then the three that look at what Hugo did (Wrong, Seen this week, Missed recently). */
export function FilterMenu({
  value, counts, onPick, onClearWrong, onClose,
}: { value: ListFilter; counts: Record<ListFilter, number>; onPick: (f: ListFilter) => void; onClearWrong?: () => void; onClose: () => void }) {
  return (
    <MenuShell label="Filter" onClose={onClose}>
      {FILTER_ORDER.map((f) => {
        const icon = FILTER_ICON[f];
        return (
          <button
            key={f}
            type="button"
            role="menuitemradio"
            aria-checked={value === f}
            className={`pop-item ${icon ? `mn-all mn-${f}` : `st-${f}`}`}
            onClick={() => onPick(f)}
          >
            {icon ? <Icon name={icon} className="pop-st" /> : <StatusIcon status={f as 'new'} className="pop-st" />}
            {FILTER_LABEL[f]}
            <span className="sh-count mn-count">{counts[f]}</span>
            <span className="mn-check">{value === f && <Icon name="check" />}</span>
          </button>
        );
      })}
      {value === 'wrong' && counts.wrong > 0 && onClearWrong && (
        <button type="button" role="menuitem" className="pop-item mn-act" onClick={onClearWrong}>
          <Icon name="close" className="mn-glyph" />
          <span className="grow">Clear Wrong</span>
          <span className="sh-count mn-count">{counts.wrong}</span>
        </button>
      )}
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
