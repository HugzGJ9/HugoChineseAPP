// "Try new animations" (plan 2026-11-22-ui-polish D1/D10): a device-only switch (`hz.motion`, never synced or backed
// up). While it is on, `<html>` carries the class `motion`: new motion and the Kai webfont are scoped under
// `html.motion` in CSS, and scripts check `motionOn()`. Off = the app as before.
import { pref, setPref } from '../lib/db';

export const motionOn = (): boolean => pref<boolean>('motion', false);

/** Puts `motion` on `<html>` to match the switch. Called at boot and whenever the switch changes. */
export function syncMotionClass(): void {
  if (typeof document !== 'undefined') document.documentElement.classList.toggle('motion', motionOn());
}

export function setMotion(on: boolean): void {
  setPref('motion', on);
  syncMotionClass();
}
