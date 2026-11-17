// Software keyboard inset. Chrome/Android resizes the layout with `interactive-widget=resizes-content` (index.html);
// iOS Safari does not, so we read visualViewport and publish the px the keyboard covers as `--kb` on <html>.
// Sheets pad their bottom with max(var(--kb), env(safe-area-inset-bottom)) so the last field and button stay reachable.
import { useEffect, useState } from 'react';

/** Pixels covered by the keyboard (0 when closed). Also sets `--kb` on documentElement. Mount once, in App. */
export function useKeyboardInset(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      const px = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      root.style.setProperty('--kb', `${px}px`);
      root.classList.toggle('kb-open', px > 80);
      setKb(px);
    };
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      root.style.removeProperty('--kb');
      root.classList.remove('kb-open');
    };
  }, []);
  return kb;
}

/**
 * Scroll the page so `el` sits inside the visible area: below its scroll-margin-top (the sticky header) and above the
 * keyboard. Works on the visual viewport, which iOS pans instead of resizing the page, unlike scrollIntoView.
 */
export function revealAboveKeyboard(el: HTMLElement, margin = 16): void {
  const vv = window.visualViewport;
  const r = el.getBoundingClientRect();
  const visTop = (vv?.offsetTop ?? 0) + (parseFloat(getComputedStyle(el).scrollMarginTop) || 0);
  const visBottom = (vv ? vv.offsetTop + vv.height : window.innerHeight) - margin;
  const dy = r.bottom > visBottom ? r.bottom - visBottom : r.top < visTop ? r.top - visTop : 0;
  if (dy) window.scrollBy({ top: dy, behavior: 'auto' });
}
