// Software keyboard inset. Chrome/Android resizes the layout with `interactive-widget=resizes-content` (index.html);
// iOS Safari does not, so we read visualViewport and publish, on <html>:
//   --kb   px the keyboard covers (0 when closed);
//   --vvh  the visible height (visualViewport.height), the dvh that iOS never gives us while the keyboard is up;
//   --vvt  how far iOS panned the page under the keyboard (visualViewport.offsetTop), so a fixed screen can sit on the
//          visible area (Cards: top --vvt, height --vvh) instead of sliding up and dropping back.
// Sheets pad their bottom with max(var(--kb), env(safe-area-inset-bottom)) so the last field and button stay reachable.
//
// iOS pans because, when a field takes focus, it is below where the keyboard will end. `useNoPan` (Cards) stops the pan
// at its source, the pattern react-aria's usePreventScroll uses: on touchend the field is moved far above the page for
// one frame while it takes focus, so iOS finds nothing to scroll to; the window is kept at scrollY 0 while the screen is
// up. visualViewport events arrive only after the keyboard animation, so the last keyboard height (this device) is
// applied at focus time and corrected when the real numbers come in.
import { useEffect, useState } from 'react';

const KB_KEY = 'hz.kb';
let refresh: (() => void) | null = null;

/** iPhone, iPod, or an iPad that reports itself as a Mac. */
export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  return /iP(hone|od|ad)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

function lastKb(): number {
  try {
    return Number(localStorage.getItem(KB_KEY)) || 0;
  } catch {
    return 0;
  }
}

/** Pixels covered by the keyboard (0 when closed). Also sets `--kb`, `--vvh`, `--vvt` on documentElement. Mount once, in App. */
export function useKeyboardInset(): number {
  const [kb, setKb] = useState(0);
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.documentElement;
    const update = () => {
      const top = vv ? Math.max(0, Math.round(vv.offsetTop)) : 0;
      const px = vv ? Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop)) : 0;
      root.style.setProperty('--kb', `${px}px`);
      root.style.setProperty('--vvt', `${top}px`);
      if (vv) root.style.setProperty('--vvh', `${Math.round(vv.height)}px`);
      else root.style.removeProperty('--vvh');
      root.classList.toggle('kb-open', px > 80);
      if (px > 80) {
        try {
          localStorage.setItem(KB_KEY, String(px));
        } catch {
          /* private mode: no prediction next time */
        }
      }
      setKb(px);
    };
    refresh = update;
    update();
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    return () => {
      refresh = null;
      vv?.removeEventListener('resize', update);
      vv?.removeEventListener('scroll', update);
      for (const v of ['--kb', '--vvt', '--vvh']) root.style.removeProperty(v);
      root.classList.remove('kb-open');
    };
  }, []);
  return kb;
}

/**
 * Focus a field without iOS panning the page: the field is translated far above the top while it takes focus (iOS does
 * not scroll to a field it cannot reach), then put back on the next frame. Elsewhere a plain focus without scrolling.
 */
export function focusNoPan(el: HTMLElement): void {
  if (!isIOS()) {
    el.focus({ preventScroll: true });
    return;
  }
  el.style.transform = 'translateY(-2000px)';
  el.focus({ preventScroll: true });
  requestAnimationFrame(() => (el.style.transform = ''));
  // The keyboard's height arrives after its animation: lay out for the last one now, the real numbers follow.
  // First time on this device: a portrait iPhone keyboard with its suggestion bar is about 41% of the screen.
  const k = lastKb() || (window.innerHeight > window.innerWidth ? Math.round(window.innerHeight * 0.41) : 0);
  if (k > 80 && window.innerHeight - k > 200) {
    const root = document.documentElement;
    root.style.setProperty('--kb', `${k}px`);
    root.style.setProperty('--vvt', '0px');
    root.style.setProperty('--vvh', `${window.innerHeight - k}px`);
    root.classList.add('kb-open');
  }
  // No keyboard after all (hardware keyboard, focus refused): fall back to what visualViewport says.
  setTimeout(() => refresh?.(), 700);
}

/**
 * While `on`, a tap on `field` focuses it with `focusNoPan` and the window stays at the top (iOS only; elsewhere
 * nothing changes). For full-screen fixed layouts such as Cards.
 */
export function useNoPan(field: { current: HTMLElement | null }, on = true): void {
  useEffect(() => {
    if (!on || !isIOS()) return;
    const root = document.documentElement;
    root.classList.add('no-pan');
    const onTouchEnd = (e: TouchEvent) => {
      const el = field.current;
      if (!el || e.target !== el || document.activeElement === el) return; // already focused: let the caret move
      e.preventDefault(); // no native focus, which would scroll
      focusNoPan(el);
    };
    const toTop = () => {
      if (window.scrollY !== 0) window.scrollTo(0, 0);
    };
    document.addEventListener('touchend', onTouchEnd, { passive: false, capture: true });
    window.addEventListener('scroll', toTop);
    window.visualViewport?.addEventListener('scroll', toTop);
    return () => {
      root.classList.remove('no-pan');
      document.removeEventListener('touchend', onTouchEnd, { capture: true });
      window.removeEventListener('scroll', toTop);
      window.visualViewport?.removeEventListener('scroll', toTop);
    };
  }, [field, on]);
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
