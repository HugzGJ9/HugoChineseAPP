// Title language of the Grammar list: device-only UI state (like QUICK-1: not a pref, never synced).
import type { TitleLang } from './types';

const KEY = 'hz.gr.lang';

export function readTitleLang(): TitleLang {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'fr' || v === 'en' ? v : 'zh';
  } catch {
    return 'zh';
  }
}

export function saveTitleLang(l: TitleLang): void {
  try {
    localStorage.setItem(KEY, l);
  } catch {
    /* private mode: the switch still works for this visit */
  }
}
