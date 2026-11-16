import { describe, expect, it } from 'vitest';
import type { Note } from './types';
import { answerKind, checkListAnswer, checkTones } from './answer';

const mk = (hanzi: string, pinyin: string, pinyinNum: string, extra: Partial<Note> = {}): Note =>
  ({ id: `v:${hanzi}`, kind: 'vocab', hanzi, alts: [], pinyin, pinyinNum, en: 'x', notes: [], tags: [], refs: [], ...extra }) as Note;
const shao = mk('少', 'shǎo', 'shao3');
const pengyou = mk('朋友', 'péngyou', 'peng2 you5');
const alt = mk('一会', 'yíhuì', 'yi2 hui4', { altPinyin: ['yi1 hui4'] });
const right = (t: string, n: Note) => checkListAnswer(t, n)?.right;

describe('answerKind', () => {
  it('tells the kinds apart', () => {
    expect(answerKind('少')).toBe('hanzi');
    expect(answerKind('3')).toBe('tones');
    expect(answerKind('2 5')).toBe('tones');
    expect(answerKind('shao3')).toBe('pinyin');
    expect(answerKind('shǎo')).toBe('pinyin');
  });
  it('is null for empty or spaces', () => {
    expect(answerKind('')).toBeNull();
    expect(answerKind('   ')).toBeNull();
    expect(checkListAnswer('  ', shao)).toBeNull();
  });
});

describe('checkListAnswer', () => {
  it('少 shǎo', () => {
    for (const t of ['少', '3', 'shao3', 'shǎo']) expect(right(t, shao)).toBe(true);
    for (const t of ['2', 'xiao3']) expect(right(t, shao)).toBe(false);
  });
  it('朋友 péngyou', () => {
    for (const t of ['25', '20', '2 5']) expect(right(t, pengyou)).toBe(true);
    for (const t of ['2', '253']) expect(right(t, pengyou)).toBe(false);
  });
  it('accepts the tones of any reading', () => {
    expect(right('24', alt)).toBe(true);
    expect(right('14', alt)).toBe(true);
    expect(right('34', alt)).toBe(false);
  });
  it('near-miss pinyin is wrong', () => {
    expect(right('shao2', shao)).toBe(false);
    expect(checkTones('x', shao).verdict).toBe('wrong');
  });
});
