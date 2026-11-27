import { describe, expect, it } from 'vitest';
import { pinyin } from 'pinyin-pro';
import type { XSheet, XRow } from '../xlsx/read';
import { buildVocab, isGreen, parseExamples, splitForms, sheetTag, sentencePinyin } from './build';
import { lookupFr, parseCfdict } from '../french';

const G1 = 'C5E0B4';
const G2 = 'A9D18E';
const pinyinOf = (h: string) => pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[];

function row(r: number, cells: Record<string, string | [string, string]>): XRow {
  return {
    r,
    cells: Object.fromEntries(
      Object.entries(cells).map(([c, v]) => [c, Array.isArray(v) ? { v: v[0], fill: v[1] } : { v, fill: null }]),
    ),
  };
}

const vocab4: XSheet = {
  name: 'HSK四级',
  rows: [
    row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH', E: 'Colonne1' }),
    row(2, { A: ['1', G1], B: ['0', G1], C: '0', D: 'placeholder' }),
    row(3, { A: ['2', G1], B: ['学习', G1], C: 'xué xí', D: 'to study' }),
    row(4, { A: '3', B: ' 朋友', C: 'peng2you', D: 'friend', E: 'a note' }),
    row(5, { A: '4', B: '告诉', C: '告诉', D: 'to tell' }),
    row(6, { A: '5', B: '学习', C: 'xue2xi2', D: 'learning' }),
    row(7, { A: '6', B: '一会/一会儿', C: 'yíhuìr', D: 'a moment' }),
  ],
};
const vocab5: XSheet = {
  name: 'HSK五级',
  rows: [
    row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH' }),
    row(2, { A: ['233', G2], B: ['称赞', G2], C: ['chēngzàn', G2], D: ['to praise', G2] }),
    row(3, { A: '233bis', B: '夸奖', C: 'kuājiǎng', D: 'to praise' }),
    row(4, { A: '9', B: '学习', C: 'xuéxí', D: 'to study' }),
    row(5, { A: '10', B: '高兴，开心', C: 'gāoxìng, kāixīn', D: 'happy' }),
    row(6, { A: '11', B: '本', C: '', D: 'volume' }),
  ],
};
const measure: XSheet = {
  name: 'Measure words',
  rows: [
    row(2, { B: 'Classificateur', C: 'Pinyin', D: 'Utilisation principale', E: 'Exemple' }),
    row(3, { B: '个', C: 'gè', D: 'Pour les objets en général', E: '一个苹果 (yī gè píngguǒ)\r\n一个房间 (yī gè fángjiān) ' }),
  ],
};
const grammar: XSheet = {
  name: '语法',
  rows: [
    row(1, { A: 'HANZI', B: 'ENGLISH', C: 'Exemple' }),
    row(2, { A: 'A+不如+B', B: 'A not as good as B', C: '今天不如昨天热' }),
    row(3, { A: '比如说\r\n比方说', B: 'for example' }),
  ],
};
const synonyms: XSheet = {
  name: 'Suddently',
  rows: [
    row(2, { B: 'Word', C: 'Pinyin', D: 'Core Meaning', E: 'Emotion / Tone', F: 'Opposite / Related', G: 'Sentence Example (Chinese)', H: 'Sentence Example (Pinyin)', I: 'English Translation', J: 'Key Grammar / Tip' }),
    row(3, { B: '突然', C: 'tūrán', D: 'Suddenly', E: 'Neutral', F: '慢慢', G: '他突然笑了。', H: 'Tā tūrán xiào le.', I: 'He suddenly laughed.', J: 'Fast change' }),
  ],
};
const exam: XSheet = { name: 'EXAM', rows: [row(1, { A: 'id', B: 'word' }), row(2, { A: '0.1', B: 'contract' })] };

const cfdict = parseCfdict('学习\txue2 xi2\tétudier/apprendre\n朋友\tpeng2 you5\tami\n称赞\tcheng1 zan4\tlouer\n');

function build(prevSeeds = {}) {
  return buildVocab([vocab4, vocab5, measure, grammar, synonyms, exam], {
    source: { name: 'test.xlsx', modified: 1, size: 1 },
    now: 1000,
    prevSeeds,
    pinyinOf,
    readingsOf: (h) => (cfdict.get(h) ?? []).map((e) => e.p),
    french: (h, p) => lookupFr(cfdict, h, p),
  });
}

describe('grammar columns (GRAM-1)', () => {
  const sheet: XSheet = {
    name: '语法',
    rows: [
      row(1, { A: 'HANZI', B: 'ENGLISH', C: 'Exemple', D: 'HSK', E: 'Family', F: 'Title EN', G: 'Title FR', H: 'Definition EN', I: 'Definition FR', J: 'Use EN', K: 'Use FR', L: 'Register', M: 'Sentences' }),
      row(2, {
        A: 'A+不如+B', B: 'A not as good as B', C: '今天不如昨天热', D: '4', E: 'Comparing', F: 'A is not as good as B', G: 'A ne vaut pas B',
        H: 'A is less … than B.', I: 'A est moins … que B.', J: 'A 不如 B + adj\n不如 + verb = better to', K: '• A 不如 B + adj\n• 不如 + verbe = mieux vaut', L: 'neutral',
        M: '坐车不如走路快。 | La voiture est moins rapide. | Driving is slower.\n我不如他高。',
      }),
      row(3, { A: '于', B: 'at', D: 'HSK 7-9', E: 'Bizarre', L: 'soutenu' }),
      row(4, { A: '比如说', B: 'for example' }),
    ],
  };
  const vf = buildVocab([sheet], { source: { name: 't.xlsx', modified: 1, size: 1 }, now: 1, pinyinOf });
  const get = (id: string) => vf.notes.find((n) => n.id === id)!;
  it('reads every column into note.grammar, keeps them out of the notes and keeps the Excel example', () => {
    const g = get('g:A+不如+B');
    expect(g.notes).toEqual([]);
    expect(g.examples[0].zh).toBe('今天不如昨天热');
    expect(g.grammar).toMatchObject({
      hsk: 4, family: 'compare', register: 'neutral',
      title: { en: 'A is not as good as B', fr: 'A ne vaut pas B' },
      def: { en: 'A is less … than B.', fr: 'A est moins … que B.' },
      use: { en: ['A 不如 B + adj', '不如 + verb = better to'], fr: ['A 不如 B + adj', '不如 + verbe = mieux vaut'] },
    });
    expect(g.grammar!.sentences).toHaveLength(2);
    expect(g.grammar!.sentences![0]).toMatchObject({ zh: '坐车不如走路快。', fr: 'La voiture est moins rapide.', en: 'Driving is slower.' });
    expect(g.grammar!.sentences![0].pinyin).toContain('bùrú');
    expect(g.grammar!.sentences![1]).toEqual({ zh: '我不如他高。', pinyin: expect.any(String) });
  });
  it('accepts loose HSK and register spellings and reports an unknown family', () => {
    expect(get('g:于').grammar).toEqual({ hsk: 7, register: 'formal' });
    expect(vf.issues.some((i) => i.problem.includes('Unknown family "Bizarre"'))).toBe(true);
  });
  it('leaves rows without the columns as before', () => {
    expect(get('g:比如说').grammar).toBeUndefined();
  });
});

describe("vocab columns Don't confuse and Register (word-panel D5)", () => {
  const opts = { source: { name: 't.xlsx', modified: 1, size: 1 }, now: 1, pinyinOf };
  const base = [
    row(2, { A: '1', B: '称赞', C: 'chēngzàn', D: 'to praise', E: 'a note' }),
    row(3, { A: '2', B: '夸奖', C: 'kuājiǎng', D: 'to praise' }),
    row(4, { A: '3', B: '突然', C: 'tūrán', D: 'suddenly' }),
  ];
  const plain: XSheet = { name: 'HSK五级', rows: [row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH', E: 'Colonne1' }), ...base] };
  const withCols: XSheet = {
    name: 'HSK五级',
    rows: [
      row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH', E: 'Colonne1', F: "Don't Confuse", G: 'Registre' }),
      ...base.slice(0, 2).map((r) => ({ ...r, cells: { ...r.cells } })),
      row(4, { A: '3', B: '突然', C: 'tūrán', D: 'suddenly' }),
    ],
  };
  withCols.rows[1].cells.F = { v: '• 夸奖 | 口语 | plus oral | more casual\n表扬 ｜ 书面\nnope | x', fill: null };
  withCols.rows[1].cells.G = { v: 'Soutenu', fill: null };
  withCols.rows[2].cells.G = { v: 'bizarre', fill: null };
  const vf = buildVocab([withCols], opts);
  const get = (id: string) => vf.notes.find((n) => n.id === id)!;

  it('reads both columns into the note and keeps them out of the notes', () => {
    const n = get('v:称赞|chengzan');
    expect(n.confuse).toEqual([
      { word: '夸奖', register: 'spoken', fr: 'plus oral', en: 'more casual' },
      { word: '表扬', register: 'written' },
    ]);
    expect(n.register).toBe('formal');
    expect(n.notes).toEqual(['a note']);
    expect(n.extra).toBeUndefined();
  });
  it('reports bad lines and unknown registers like the 语法 columns', () => {
    const own = vf.issues.filter((i) => i.sheet === 'HSK五级' && (i.col === 'F' || i.col === 'G'));
    expect(own.map((i) => [i.row, i.col, i.level, i.hanzi])).toEqual([
      [2, 'F', 'info', '称赞'],
      [3, 'G', 'info', '夸奖'],
    ]);
    expect(own[0].problem).toContain('"nope | x"');
    expect(get('v:夸奖|kuajiang').register).toBeUndefined();
    expect(get('v:突然|turan')).not.toHaveProperty('confuse');
    expect(get('v:突然|turan')).not.toHaveProperty('register');
  });
  it('a sheet without the columns builds exactly as before', () => {
    const a = buildVocab([plain], opts);
    const stripped: XSheet = { ...withCols, rows: withCols.rows.map((r) => ({ ...r, cells: Object.fromEntries(Object.entries(r.cells).filter(([c]) => c !== 'F' && c !== 'G')) })) };
    const b = buildVocab([stripped], opts);
    expect(b.notes).toEqual(a.notes);
    expect(b.hash).toBe(a.hash);
    expect(a.notes.every((n) => !('confuse' in n) && !('register' in n))).toBe(true);
  });
  it('reads 口语 as the Register header and English "Register" on a vocab sheet', () => {
    const s = (h: string): XSheet => ({ name: 'HSK四级', rows: [row(1, { A: 'HANZI', B: 'PINYIN', C: 'ENGLISH', D: h }), row(2, { A: '突然', B: 'tūrán', C: 'suddenly', D: 'kouyu' })] });
    for (const h of ['口语', 'Register', 'REGISTRE']) {
      const n = buildVocab([s(h)], opts).notes[0];
      expect(n.register).toBe('spoken');
      expect(n.notes).toEqual([]);
    }
  });
  it('leaves the 语法 sheet alone: Register stays grammar, 口语 and Don\'t confuse stay in its notes', () => {
    const g: XSheet = { name: '语法', rows: [row(1, { A: 'HANZI', B: 'ENGLISH', C: 'Register', D: '口语', E: "Don't confuse" }), row(2, { A: '于', B: 'at', C: 'formal', D: 'x', E: 'y' })] };
    const n = buildVocab([g], opts).notes[0];
    expect(n.grammar).toEqual({ register: 'formal' });
    expect(n.notes).toEqual(['x', 'y']);
    expect(n).not.toHaveProperty('confuse');
    expect(n).not.toHaveProperty('register');
  });
  it('merges the columns of a word found on two sheets', () => {
    const s4: XSheet = { name: 'HSK四级', rows: [row(1, { A: 'HANZI', B: 'PINYIN', C: 'ENGLISH', D: 'Confuse' }), row(2, { A: '称赞', B: 'chēngzàn', C: 'to praise', D: '夸奖' })] };
    const s5: XSheet = { name: 'HSK五级', rows: [row(1, { A: 'HANZI', B: 'PINYIN', C: 'ENGLISH', D: 'À ne pas confondre', E: 'Register' }), row(2, { A: '称赞', B: 'chēngzàn', C: 'to praise', D: '夸奖 | 口语\n表扬', E: '书面' })] };
    const n = buildVocab([s4, s5], opts).notes[0];
    expect(n.confuse).toEqual([{ word: '夸奖' }, { word: '表扬' }]);
    expect(n.register).toBe('written');
  });
});

describe('buildVocab', () => {
  const vf = build();
  const byId = (id: string) => vf.notes.find((n) => n.id === id)!;

  it('detects sheet kinds, header rows and skips EXAM', () => {
    expect(vf.report.map((r) => r.kind)).toEqual(['vocab', 'vocab', 'measure', 'grammar', 'synonym', 'skipped']);
  });
  it('keys words on hanzi + toneless pinyin and merges repeats across sheets', () => {
    const n = byId('v:学习|xuexi');
    expect(n.tags).toEqual(['HSK4', 'HSK5']);
    expect(n.refs.map((r) => r.row)).toEqual([3, 6, 4]);
    expect(n.en).toBe('to study · learning');
    expect(n.studied).toBe(true);
    expect(n.frAuto).toBe('étudier ; apprendre');
  });
  it('detects both greens on the HANZI cell or most of the row', () => {
    expect(byId('v:称赞|chengzan').studied).toBe(true);
    expect(byId('v:夸奖|kuajiang').studied).toBe(false);
    expect(isGreen(G1) && isGreen(G2) && isGreen('00B050')).toBe(true);
    expect(isGreen('FFFF00') || isGreen('FFFFFF') || isGreen('000000') || isGreen('8FAADC')).toBe(false);
  });
  it('groups bis/ter rows', () => {
    expect(byId('v:称赞|chengzan').group).toBe('HSK5:233');
    expect(byId('v:夸奖|kuajiang').group).toBe('HSK5:233');
  });
  it('normalises pinyin and reports bad cells', () => {
    expect(byId('v:朋友|pengyou').pinyin).toBe('péngyou');
    const fix = vf.issues.filter((i) => i.level === 'fix').map((i) => `${i.row}:${i.problem}`);
    expect(fix).toContain('2:No Chinese characters in this cell; row skipped');
    expect(fix).toContain('5:Chinese characters in the PINYIN cell');
    expect(fix).toContain('6:No pinyin');
    expect(byId('v:告诉|gaosu').pinyin).toMatch(/^gàos/);
    expect(byId('v:本|ben').pinyin).toBe('běn');
    expect(vf.issues.some((i) => i.row === 4 && i.problem.startsWith('Extra spaces'))).toBe(true);
  });
  it('splits several forms in one cell', () => {
    const n = byId('v:高兴|gaoxing');
    expect(n.alts).toEqual(['开心']);
    expect(n.altPinyin).toEqual(['kai1 xin1']);
    expect(byId('v:一会|yihuir').alts).toEqual(['一会儿']);
  });
  it('reads measure words, grammar and near-synonyms', () => {
    const m = byId('m:个|ge');
    expect(m.fr).toBe('Pour les objets en général');
    expect(m.examples).toEqual([{ zh: '一个苹果', pinyin: 'yī gè píngguǒ' }, { zh: '一个房间', pinyin: 'yī gè fángjiān' }]);
    const g = byId('g:A+不如+B');
    expect(g.examples[0].zh).toBe('今天不如昨天热');
    expect(g.examples[0].pinyin).toContain('bùrú');
    expect(byId('g:比如说').alts).toEqual(['比方说']);
    const s = byId('s:突然|turan');
    expect(s.set).toBe('Suddently');
    expect(s.extra?.tip).toBe('Fast change');
    expect(s.examples[0].en).toBe('He suddenly laughed.');
  });
  it('keeps the colour of every row on its ref, also when a word is merged across sheets', () => {
    const n = byId('v:学习|xuexi');
    expect(n.refs.map((r) => [r.sheet, r.row, r.colour])).toEqual([
      ['HSK四级', 3, G1],
      ['HSK四级', 6, undefined],
      ['HSK五级', 4, undefined],
    ]);
    expect(n.colour).toBe(G1);
    expect(byId('v:称赞|chengzan').refs[0].colour).toBe(G2);
    expect(byId('v:朋友|pengyou').refs[0]).not.toHaveProperty('colour');
    const merged = buildVocab(
      [
        { name: 'HSK四级', rows: [row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH' }), row(2, { A: ['1', 'EEA6A6'], B: ['学习', 'EEA6A6'], C: 'xuéxí', D: 'study' })] },
        { name: 'HSK五级', rows: [row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH' }), row(5, { A: ['9', 'FFFF00'], B: ['学习', 'FFFF00'], C: 'xuéxí', D: 'study' })] },
      ],
      { source: { name: 't.xlsx', modified: 1, size: 1 }, now: 1, pinyinOf },
    ).notes[0];
    expect(merged.refs.map((r) => r.colour)).toEqual(['EEA6A6', 'FFFF00']);
    expect(merged.colour).toBe('EEA6A6');
  });
  it('finds the columns that carry the status colour', () => {
    const cols = (name: string) => vf.report.find((r) => r.name === name)!.cols;
    // ID and hanzi coloured, the rest white.
    expect(cols('HSK四级')).toEqual({ id: 'A', hanzi: 'B', first: 'A', last: 'E', status: ['A', 'B'] });
    // Whole row coloured.
    expect(cols('HSK五级')).toEqual({ id: 'A', hanzi: 'B', first: 'A', last: 'D', status: ['A', 'B', 'C', 'D'] });
    // Nothing coloured: ID and hanzi, or hanzi alone.
    expect(cols('Measure words')).toEqual({ hanzi: 'B', first: 'B', last: 'E', status: ['B'] });
    expect(cols('语法')).toEqual({ hanzi: 'A', first: 'A', last: 'C', status: ['A'] });
    expect(cols('EXAM')).toBeUndefined();
    const plain = buildVocab([{ name: 'HSK五级', rows: [row(1, { A: 'ID', B: 'HANZI', C: 'PINYIN', D: 'ENGLISH' }), row(2, { A: '1', B: '学习', C: 'xuéxí', D: 'study' })] }], {
      source: { name: 't.xlsx', modified: 1, size: 1 },
      now: 1,
      pinyinOf,
    });
    expect(plain.report[0].cols).toEqual({ id: 'A', hanzi: 'B', first: 'A', last: 'D', status: ['A', 'B'] });
  });
  it('seeds green words once and keeps earlier seed times', () => {
    expect(vf.seeds['v:学习|xuexi']).toBe(1000);
    const again = build({ 'v:学习|xuexi': 5 });
    expect(again.seeds['v:学习|xuexi']).toBe(5);
    expect(again.hash).toBe(vf.hash);
  });
});

describe('helpers', () => {
  it('splits forms', () => {
    expect(splitForms('一本书， 一本词典，')).toEqual(['一本书', '一本词典']);
    expect(splitForms('因为\r\n因为。。。 所以')).toEqual(['因为', '因为', '所以']);
  });
  it('tags HSK sheets', () => {
    expect(sheetTag('HSK四级')).toBe('HSK4');
    expect(sheetTag('HSK五级')).toBe('HSK5');
    expect(sheetTag('Measure words')).toBe('Measure words');
  });
  it('parses examples with trailing extra examples', () => {
    expect(parseExamples('一张纸 (yī zhāng zhǐ), 一张票')).toEqual([{ zh: '一张纸', pinyin: 'yī zhāng zhǐ' }, { zh: '一张票' }]);
  });
  it('writes sentence pinyin', () => {
    expect(sentencePinyin('今天不如昨天热。', pinyinOf)).toMatch(/^jīntiān.*rè\.$/);
  });
});
