import { describe, expect, it } from 'vitest';
import { parsePinyin, toMarked, toNumbered, toToneless, prettyPinyin, markSyllable } from './pinyin';

const num = (s: string, n?: number) => {
  const p = parsePinyin(s, n);
  expect(p.ok, `${s}: ${p.error}`).toBe(true);
  return toNumbered(p.syls, ' ');
};

describe('parsePinyin', () => {
  it('reads tone marks', () => {
    expect(num('gōng zuò')).toBe('gong1 zuo4');
    expect(num('kāixīn')).toBe('kai1 xin1');
    expect(num("tiān'ān")).toBe('tian1 an1');
  });
  it('reads tone numbers and mixes', () => {
    expect(num('hao3kan4')).toBe('hao3 kan4');
    expect(num('dǎdian4hua4', 3)).toBe('da3 dian4 hua4');
    expect(num('míngbai5')).toBe('ming2 bai5');
    expect(num('lv4')).toBe('lv4');
    expect(num('nu:3er2')).toBe('nv3 er2');
  });
  it('handles capitals, tabs and neutral tones', () => {
    expect(num('Běijīng')).toBe('bei3 jing1');
    expect(num('\tzǎo shang')).toBe('zao3 shang5');
    expect(num('péngyou')).toBe('peng2 you5');
  });
  it('uses the character count to split ambiguous text', () => {
    expect(num("xi'an", 2)).toBe('xi5 an5');
    expect(num('xīān', 2)).toBe('xi1 an1');
    expect(num('xian', 1)).toBe('xian5');
    expect(num('fangai', 2)).toBe('fan5 gai5');
  });
  it('prefers a plausible reading over forcing the count', () => {
    expect(parsePinyin('gàn', 2).syls.length).toBe(1);
    expect(parsePinyin('zhuàng', 3).syls.length).toBe(1);
  });
  it('keeps erhua', () => {
    expect(num('yìdiǎnr', 3)).toBe('yi4 dian3 r5');
  });
  it('rejects non-pinyin', () => {
    expect(parsePinyin('你好').ok).toBe(false);
    expect(parsePinyin('ni34').ok).toBe(false);
    expect(parsePinyin('').ok).toBe(false);
    expect(parsePinyin('qqq').ok).toBe(false);
  });
});

describe('formatting', () => {
  it('places tone marks by the standard rules', () => {
    expect(markSyllable('xue', 2)).toBe('xué');
    expect(markSyllable('gou', 3)).toBe('gǒu');
    expect(markSyllable('gui', 4)).toBe('guì');
    expect(markSyllable('liu', 2)).toBe('liú');
    expect(markSyllable('lv', 4)).toBe('lǜ');
    expect(markSyllable('lve', 4)).toBe('lüè');
    expect(markSyllable('de', 5)).toBe('de');
  });
  it('keeps word breaks and adds apostrophes', () => {
    expect(toMarked(parsePinyin('xi1 an1', 2))).toBe("xī ān");
    expect(toMarked(parsePinyin('xi1an1', 2))).toBe("xī'ān");
    expect(prettyPinyin('kan4 diànyǐng')).toBe('kàn diànyǐng');
  });
  it('gives toneless keys', () => {
    expect(toToneless(parsePinyin('xué xí').syls)).toBe('xuexi');
  });
});
