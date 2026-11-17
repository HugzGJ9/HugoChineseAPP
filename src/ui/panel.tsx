// One bottom sheet for every dialog on phones (grabber, drag down to close from anywhere), a side panel (variant
// "panel") or a centred card (variant "menu") from 900px. Esc closes the top sheet, focus moves in and returns on close,
// the page behind does not scroll while a sheet is open.
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './common';
import './panel.css';

const open: symbol[] = []; // open sheets, last = top: only the top one handles Escape
let locks = 0;

export function Sheet({
  title, label, head, onClose, children, className = '', size, variant = 'panel', onKeyDown,
}: {
  title?: ReactNode; label: string; head?: ReactNode; size?: 'full' | 'content'; variant?: 'panel' | 'menu';
  onClose: () => void; children: ReactNode; className?: string; onKeyDown?: (e: React.KeyboardEvent) => void;
}) {
  const menu = variant === 'menu';
  const full = (size ?? (menu ? 'content' : 'full')) === 'full';
  const ref = useRef<HTMLDivElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = menu ? el?.querySelector<HTMLElement>('[aria-checked="true"], [aria-pressed="true"], .pop-item') : null;
    (first ?? el)?.focus({ preventScroll: true });
    const me = Symbol();
    open.push(me);
    if (locks++ === 0) document.documentElement.classList.add('sheet-open');
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && open[open.length - 1] === me) {
        e.preventDefault();
        close.current();
      }
    };
    document.addEventListener('keydown', key);
    return () => {
      document.removeEventListener('keydown', key);
      open.splice(open.indexOf(me), 1);
      if (--locks === 0) document.documentElement.classList.remove('sheet-open');
      before?.focus?.({ preventScroll: true });
    };
  }, [menu]);
  useSheetDrag(ref, close);
  const body = (
    <div
      className={`${menu ? 'pop pp-sheet' : 'pp-panel'} ${full ? 'pp-full' : 'pp-content'} ${className}`}
      role="dialog"
      aria-modal={menu ? true : undefined}
      aria-label={label}
      ref={ref}
      tabIndex={-1}
      onKeyDown={onKeyDown}
    >
      {!menu && (
        <>
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
        </>
      )}
      {children}
    </div>
  );
  if (menu) {
    return (
      <div className="pop-backdrop" onClick={onClose}>
        {/* clicks inside must not reach the backdrop */}
        <div style={{ display: 'contents' }} onClick={(e) => e.stopPropagation()}>
          {body}
        </div>
      </div>
    );
  }
  return (
    <>
      <div className="pp-backdrop" onClick={onClose} aria-hidden="true" />
      {body}
    </>
  );
}

const NO_DRAG = '.pad-cell, .sp-canvas, input[type="range"], [data-sheet-nodrag]';

/** True when the touch starts where a drag would fight the content: a writing surface, a slider, or a scroller. */
function blocked(t: HTMLElement, root: HTMLElement): boolean {
  if (t.closest(NO_DRAG)) return true;
  for (let n: HTMLElement | null = t; n && n !== root; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (/(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1) return true;
    if (/(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1 && n.scrollTop > 0) return true;
  }
  return false;
}

/**
 * Drag the sheet down from anywhere to close it, like an iOS sheet. Touch only, phones only, and only when the sheet is
 * scrolled to the top. Native touch listeners (non-passive) so the drag can take over from scrolling.
 */
function useSheetDrag(ref: React.RefObject<HTMLDivElement | null>, close: React.RefObject<() => void>) {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let s: { x: number; y: number; t: number; dy: number; on: boolean } | null = null;
    const start = (e: TouchEvent) => {
      s = null;
      if (e.touches.length !== 1 || matchMedia('(min-width: 900px)').matches || el.scrollTop > 0) return;
      if (blocked(e.target as HTMLElement, el)) return;
      s = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: performance.now(), dy: 0, on: false };
    };
    const move = (e: TouchEvent) => {
      if (!s) return;
      const dy = e.touches[0].clientY - s.y;
      const dx = e.touches[0].clientX - s.x;
      if (!s.on) {
        if (el.scrollTop > 0 || dy < -6 || Math.abs(dx) > Math.abs(dy) + 6) {
          s = null;
          return;
        }
        if (dy < 8) return;
        s.on = true;
        s.t = performance.now();
        s.y = e.touches[0].clientY;
        el.style.transition = 'none';
        return;
      }
      if (e.cancelable) e.preventDefault();
      s.dy = Math.max(0, e.touches[0].clientY - s.y);
      el.style.transform = s.dy ? `translateY(${s.dy}px)` : '';
    };
    const end = () => {
      const d = s;
      s = null;
      if (!d?.on) return;
      const v = d.dy / Math.max(1, performance.now() - d.t);
      if (d.dy > 110 || (d.dy > 40 && v > 0.6)) {
        el.style.transition = 'transform 0.22s ease-in';
        el.style.transform = 'translateY(100%)';
        setTimeout(() => close.current(), 200);
      } else {
        el.style.transition = 'transform 0.35s var(--ease)';
        el.style.transform = '';
      }
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [ref, close]);
}

/** True when a key event comes from inside an open panel or menu: list, card and grade keys must ignore it. */
export const inDialog = (e: Event) => !!(e.target as HTMLElement | null)?.closest?.('[role="dialog"]');
