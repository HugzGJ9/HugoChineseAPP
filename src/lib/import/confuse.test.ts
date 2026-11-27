import { describe, expect, it } from 'vitest';
import { parseConfuse, parseWordRegister, readRegister } from './confuse';

describe('parseConfuse', () => {
  it('reads all four fields with "|" or the full-width "｜"', () => {
    expect(parseConfuse('夸奖 | 口语 | plus oral | more casual\n表扬｜书面｜écrit｜written').items).toEqual([
      { word: '夸奖', register: 'spoken', fr: 'plus oral', en: 'more casual' },
      { word: '表扬', register: 'written', fr: 'écrit', en: 'written' },
    ]);
  });
  it('accepts a word alone and empty fields', () => {
    const { items, problems } = parseConfuse('夸奖\n表扬 | | | only EN\n赞美 | 中性 |\n称颂 || seulement FR');
    expect(items).toEqual([
      { word: '夸奖' },
      { word: '表扬', en: 'only EN' },
      { word: '赞美', register: 'neutral' },
      { word: '称颂', fr: 'seulement FR' },
    ]);
    expect(problems).toEqual([]);
  });
  it('strips bullets, blank lines and Windows line ends', () => {
    expect(parseConfuse('• 夸奖\r\n\r\n- 表扬 | coll.\r\n* 赞美\r\n· 称颂').items.map((i) => i.word)).toEqual(['夸奖', '表扬', '赞美', '称颂']);
  });
  it('skips and reports lines without a Chinese word first', () => {
    const { items, problems } = parseConfuse('kuajiang | 口语\n | 口语 | fr\n夸奖');
    expect(items).toEqual([{ word: '夸奖' }]);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toContain('"kuajiang | 口语"');
  });
  it('keeps a line with an unknown register, without the register, and reports it', () => {
    const { items, problems } = parseConfuse('夸奖 | sometimes | fr | en');
    expect(items).toEqual([{ word: '夸奖', fr: 'fr', en: 'en' }]);
    expect(problems[0]).toContain('unknown register "sometimes"');
  });
  it('skips the word itself and repeats, and reports extra fields', () => {
    const { items, problems } = parseConfuse('称赞\n夸奖 | 口语\n夸奖 | 书面\n表扬 | | a | b | c', '称赞');
    expect(items).toEqual([{ word: '夸奖', register: 'spoken' }, { word: '表扬', fr: 'a', en: 'b' }]);
    expect(problems).toHaveLength(3);
  });
  it('gives nothing for an empty cell', () => {
    expect(parseConfuse('')).toEqual({ items: [], problems: [] });
    expect(parseConfuse('  \n ')).toEqual({ items: [], problems: [] });
  });
});

describe('register spellings', () => {
  it.each([
    ['口语', 'spoken'], ['kouyu', 'spoken'], ['Kǒuyǔ', 'spoken'], ['coll', 'spoken'], ['Coll.', 'spoken'], ['COLLOQUIAL', 'spoken'],
    ['oral', 'spoken'], ['Familier', 'spoken'],
    ['中性', 'neutral'], ['neutral', 'neutral'], ['Neutre', 'neutral'],
    ['formal', 'formal'], ['Soutenu', 'formal'],
    ['书面', 'written'], ['written', 'written'], ['Literary', 'written'], ['écrit', 'written'],
  ])('%s → %s', (raw, reg) => {
    expect(readRegister(raw)).toBe(reg);
  });
  it('reads the Register cell', () => {
    expect(parseWordRegister('')).toEqual({});
    expect(parseWordRegister(' 口语 ')).toEqual({ register: 'spoken' });
    expect(parseWordRegister('maybe').problem).toContain('Unknown register "maybe"');
  });
});
