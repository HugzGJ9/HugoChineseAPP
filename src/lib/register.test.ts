import { describe, expect, it } from 'vitest';
import { differenceLine, isSpoken, registerTag } from './register';

describe('isSpoken', () => {
  it('reads the Excel register first', () => {
    expect(isSpoken({ register: 'spoken', en: 'to eat' })).toBe(true);
    expect(isSpoken({ register: 'neutral', en: 'to eat' })).toBe(false);
  });
  it('reads his meaning', () => {
    expect(isSpoken({ en: 'to chat (colloquial)' })).toBe(true);
    expect(isSpoken({ en: 'to chat, coll.' })).toBe(true);
    expect(isSpoken({ en: 'very kouyu', fr: 'très kouyu' })).toBe(true);
    expect(isSpoken({ en: 'bavarder', fr: 'parler 口语' })).toBe(true);
    expect(isSpoken({ en: 'a collection' })).toBe(false);
  });
  it('reads dictionary senses', () => {
    expect(isSpoken({ en: 'to eat' }, ['to eat (coll.)'])).toBe(true);
    expect(isSpoken({ en: 'x' }, ['(colloquial) pal'])).toBe(true);
    expect(isSpoken({ en: 'x' }, ['mec (fam.)'])).toBe(true);
    expect(isSpoken({ en: 'x' }, ['cadre familier'])).toBe(true);
    expect(isSpoken({ en: 'x' }, ['to eat'])).toBe(false);
    expect(isSpoken(undefined, undefined)).toBe(false);
  });
});

describe('registerTag', () => {
  it('uses his register or all-tagged senses', () => {
    expect(registerTag({ register: 'written' })).toBe('书面');
    expect(registerTag({ register: 'formal' })).toBe('书面');
    expect(registerTag({ register: 'spoken' }, ['(literary) x'])).toBeUndefined();
    expect(registerTag(undefined, ['(literary) to begin', '(formal) to start'])).toBe('书面');
    expect(registerTag(undefined, ['(literary) to begin', 'to start'])).toBeUndefined();
    expect(registerTag(undefined, [])).toBeUndefined();
  });
});

describe('differenceLine', () => {
  it('keeps the senses with no shared word', () => {
    expect(differenceLine(['to begin', 'to start'], ['to start (a task)', 'to set out; to open (a shop)'])).toEqual(['to set out; to open (a shop)']);
  });
  it('ignores stopwords and parentheses', () => {
    expect(differenceLine(['to eat'], ['to eat (a meal)', 'to be in the mood of'])).toEqual(['to be in the mood of']);
  });
  it('falls back to the first sense and honours max', () => {
    expect(differenceLine(['to begin'], ['to begin', 'begin again'])).toEqual(['to begin']);
    expect(differenceLine(['x'], ['alpha', 'beta', 'gamma'], 2)).toEqual(['alpha', 'beta']);
    expect(differenceLine(['x'], [])).toEqual([]);
  });
});
