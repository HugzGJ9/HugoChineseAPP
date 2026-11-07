import { describe, expect, it } from 'vitest';
import { routeOf, shouldAutoReload } from './pwa';

const idle = { visible: true, editing: false };

describe('shouldAutoReload', () => {
  it('reloads on non-study screens', () => {
    for (const hash of ['', '#/', '#/today', '#/words/abc', '#/settings', '#/stats']) expect(shouldAutoReload({ hash, ...idle })).toBe(true);
  });
  it('never reloads during a review or quick memory session', () => {
    for (const hash of ['#/review', '#/review?x=1', '#/quick', '#/quick/abc']) expect(shouldAutoReload({ hash, ...idle })).toBe(false);
  });
  it('waits while hidden or typing', () => {
    expect(shouldAutoReload({ hash: '#/today', visible: false, editing: false })).toBe(false);
    expect(shouldAutoReload({ hash: '#/settings', visible: true, editing: true })).toBe(false);
  });
  it('parses routes like the app does', () => {
    expect(routeOf('#/words/a%20b')).toBe('words');
    expect(routeOf('')).toBe('today');
  });
});
