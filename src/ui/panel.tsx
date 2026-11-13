// Shared dialog shell for the word, practice and scratch panels: an iOS sheet on phones (grabber, drag down to close),
// a side panel on wide screens. Esc closes, focus moves in and returns on close.
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './common';
import './panel.css';

export function Shell({
  title, label, head, onClose, children, className = '',
}: {
  title: ReactNode; label: string; head?: ReactNode; onClose: () => void; children: ReactNode; className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    ref.current?.focus({ preventScroll: true });
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      before?.focus?.({ preventScroll: true });
    };
  }, []);
  const drag = useSheetDrag(ref, () => close.current());
  return (
    <>
      <div className="pp-backdrop" onClick={onClose} aria-hidden="true" />
      <div className={`pp-panel ${className}`} role="dialog" aria-label={label} ref={ref} tabIndex={-1} {...drag}>
        <div className="pp-grabber" aria-hidden="true" />
        <div className="pp-head">
          <h2 className="pp-title">{title}</h2>
          {head}
          <button type="button" className="pp-close" onClick={onClose} aria-label="Close" title="Close (Esc)">
            <span aria-hidden="true">
              <Icon name="close" />
            </span>
          </button>
        </div>
        {children}
      </div>
    </>
  );
}

/**
 * Drag the sheet down by its top (grabber and header) to close it, like an iOS sheet. Touch only, phones only, and only
 * when the sheet is scrolled to the top; buttons and fields in the header keep working.
 */
function useSheetDrag(ref: React.RefObject<HTMLDivElement | null>, onClose: () => void) {
  const st = useRef<{ y: number; t: number; id: number; dy: number } | null>(null);
  const end = (e: React.PointerEvent) => {
    const s = st.current;
    const el = ref.current;
    if (!s || !el || e.pointerId !== s.id) return;
    st.current = null;
    const v = s.dy / Math.max(1, performance.now() - s.t);
    if (s.dy > 110 || (s.dy > 40 && v > 0.6)) {
      el.style.transition = 'transform 0.22s ease-in';
      el.style.transform = 'translateY(100%)';
      setTimeout(onClose, 200);
    } else {
      el.style.transition = 'transform 0.35s var(--ease)';
      el.style.transform = '';
    }
  };
  return {
    onPointerDown: (e: React.PointerEvent) => {
      const el = ref.current;
      if (!el || e.pointerType !== 'touch' || matchMedia('(min-width: 900px)').matches || el.scrollTop > 0) return;
      const t = e.target as HTMLElement;
      if (!t.closest('.pp-head, .pp-grabber')) return;
      if (t.closest('button, a, input, select, textarea, [role="group"]')) return;
      st.current = { y: e.clientY, t: performance.now(), id: e.pointerId, dy: 0 };
      el.style.transition = 'none';
    },
    onPointerMove: (e: React.PointerEvent) => {
      const s = st.current;
      const el = ref.current;
      if (!s || !el || e.pointerId !== s.id) return;
      s.dy = Math.max(0, e.clientY - s.y);
      el.style.transform = s.dy ? `translateY(${s.dy}px)` : '';
    },
    onPointerUp: end,
    onPointerCancel: end,
  };
}

/** True when a key event comes from inside an open panel or menu: list, card and grade keys must ignore it. */
export const inDialog = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('[role="dialog"]');
