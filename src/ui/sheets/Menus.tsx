// Small bottom-sheet menus for the compact Sheets toolbar: status filter and the "more" overflow.
import { useEffect, useRef, type ReactNode } from 'react';
import type { WordStatus } from '../../lib/types';
import { STATUS_LABEL, WORD_STATUSES } from '../../lib/status';
import { PresetSeg, type Shown } from '../qm';
import { Icon, LangSwitch } from '../common';
import { StatusIcon } from '../StatusPicker';

export type Filter = 'all' | WordStatus;

function MenuShell({ label, onClose, children, after }: { label: string; onClose: () => void; children: ReactNode; after?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    const first = ref.current?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], .pop-item');
    first?.focus();
    return () => back?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    }
  };
  return (
    <div className="pop-backdrop" onClick={onClose}>
      <div ref={ref} className="pop" role="dialog" aria-modal="true" aria-label={label} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div role="menu" aria-label={label} className="pop-menu">
          {children}
        </div>
        {after}
        <button type="button" className="btn block" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
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
  paint, reviewHref, reviewCount, due, preset, onPaint, onScratch, onPreset, onClose,
}: {
  paint: boolean; reviewHref: string | null; reviewCount: number; due: number; preset: string;
  onPaint: () => void; onScratch: () => void; onPreset: (s: Shown, name: string) => void; onClose: () => void;
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
    </MenuShell>
  );
}
