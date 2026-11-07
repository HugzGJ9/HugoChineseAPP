// Small bottom-sheet menus for the compact Sheets toolbar: status filter and the "more" overflow.
import { useEffect, useRef, type ReactNode } from 'react';
import type { WordStatus } from '../../lib/types';
import { STATUS_LABEL, WORD_STATUSES } from '../../lib/status';
import { PRESETS, type Shown } from '../qm';
import { Icon, LangSwitch } from '../common';

export type Filter = 'all' | WordStatus;

function MenuShell({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
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
        <button key={f} type="button" role="menuitemradio" aria-checked={value === f} className="pop-item" onClick={() => onPick(f)}>
          {f === 'all' ? 'All' : STATUS_LABEL[f]}
          <span className="sh-count faint">{counts[f]}</span>
          {value === f && <Icon name="check" />}
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
    <MenuShell label="More" onClose={onClose}>
      <button type="button" role="menuitem" className="pop-item" onClick={onPaint}>
        <Icon name="pen" /> {paint ? 'Stop painting' : 'Paint statuses'}
      </button>
      {reviewHref && (
        <a role="menuitem" className="pop-item" href={reviewHref} onClick={onClose}>
          Review these ({reviewCount})
        </a>
      )}
      {due > 0 && (
        <a role="menuitem" className="pop-item" href="#/review" onClick={onClose}>
          Due reviews ({due})
        </a>
      )}
      <button type="button" role="menuitem" className="pop-item" onClick={onScratch}>
        Scratch pad
      </button>
      <div className="pop-lang">
        <div className="small muted pop-sub">Meaning language</div>
        <LangSwitch />
      </div>
      <div className="small muted pop-sub" id="quiz-mode-label">Quiz mode</div>
      <div className="seg pop-seg" role="group" aria-labelledby="quiz-mode-label">
        {PRESETS.map((p) => (
          <button key={p.name} type="button" aria-pressed={preset === p.name} onClick={() => onPreset(p.shown, p.name)}>
            {p.name}
          </button>
        ))}
      </div>
    </MenuShell>
  );
}
