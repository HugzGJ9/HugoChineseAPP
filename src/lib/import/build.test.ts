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
