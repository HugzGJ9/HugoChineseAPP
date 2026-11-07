// Shared dialog shell for the word, practice and scratch panels: Esc closes, focus moves in and returns on close.
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './common';
import './panel.css';

export function Shell({ title, label, head, onClose, children }: { title: ReactNode; label: string; head?: ReactNode; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      before?.focus?.({ preventScroll: true });
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <>
      <div className="pp-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="pp-panel" role="dialog" aria-label={label} ref={ref} tabIndex={-1}>
        <div className="pp-head">
          <h2>{title}</h2>
          {head}
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close">
            <Icon name="close" />
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/** True when a key event comes from inside an open panel or menu: list, card and grade keys must ignore it. */
export const inDialog = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('[role="dialog"]');
