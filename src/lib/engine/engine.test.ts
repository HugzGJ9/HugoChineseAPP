import { describe, expect, it } from 'vitest';
import type { Note, ReviewEvent } from '../types';
import { addDays, cardId, dayStart, deriveCards, noteStatus, seedOffset, DAY } from './schedule';
import { buildQueue } from './queue';
import { checkHanzi, checkMeaning, checkPinyin, gradeFor, gradeWriting, meaningsOf } from './grade';

function note(id: string, over: Partial<Note> = {}): Note {
  return {
    id,
    kind: 'vocab',
    hanzi: id.slice(2).split('|')[0],
    alts: [],
    pinyin: '',
    pinyinNum: '',
    en: 'x',
    notes: [],
    tags: ['HSK4'],
    refs: [{ sheet: 'HSK四级', row: 1 }],
    order: 1,
    studied: false,
    examples: [],
    ...over,
  };
}

const S = { retention: 0.9, spreadDays: 60, recall: true, listen: false };
const T0 = new Date(2026, 10, 1, 12).getTime();
let n = 0;
const ev = (card: string, r: 1 | 2 | 3 | 4, t: number, dev = 'pc'): ReviewEvent => ({ id: `e${n++}`, card, r, t, d: 3000, m: 'reveal', dev });

describe('deriveCards', () => {
  it('seeds green words as known, first due spread over 60 days', () => {
    const notes = Array.from({ length: 600 }, (_, i) => note(`v:词${i}|ci`, { studied: true, order: i }));
    const seeds = Object.fromEntries(notes.map((x) => [x.id, T0]));
    const cards = deriveCards(notes, [], seeds, S).filter((c) => c.type === 'recog');
    expect(cards.every((c) => c.state === 2 && c.seeded)).toBe(true);
    const days = cards.map((c) => Math.round((c.due - dayStart(T0)) / DAY));
    expect(Math.min(...days)).toBeGreaterThanOrEqual(1);
    expect(Math.max(...days)).toBeLessThanOrEqual(61);
    const perDay = new Map<number, number>();
    for (const d of days) perDay.set(d, (perDay.get(d) ?? 0) + 1);
    expect(perDay.size).toBeGreaterThan(50);
    expect(Math.max(...perDay.values())).toBeLessThan(30);
  });

  it('puts a word’s recall card on a different day from its recognition card', () => {
    expect(seedOffset('v:学习|xuexi', 'recog', 60)).not.toBe(seedOffset('v:学习|xuexi', 'recall', 60));
  });

  it('locks recall until the word is first seen, then unlocks it the next day', () => {
    const a = note('v:学习|xuexi');
    let cards = deriveCards([a], [], {}, S);
    expect(cards.find((c) => c.type === 'recall')!.locked).toBe(true);
    cards = deriveCards([a], [ev(cardId(a.id, 'recog'), 3, T0)], {}, S);
    const recall = cards.find((c) => c.type === 'recall')!;
    expect(recall.locked).toBeUndefined();
    expect(recall.due).toBe(addDays(dayStart(T0), 1));
    expect(cards.find((c) => c.type === 'recog')!.state).toBe(1);
  });

  it('gives the same states whatever the order events arrive in (two devices)', () => {
    const a = note('v:学习|xuexi');
    const c = cardId(a.id, 'recog');
    const evs = [ev(c, 3, T0, 'pc'), ev(c, 3, T0 + 600000, 'iphone'), ev(c, 1, T0 + 3 * DAY, 'pc'), ev(c, 3, T0 + 3 * DAY + 600000, 'iphone')];
    const x = deriveCards([a], evs, {}, S);
    const y = deriveCards([a], [...evs].reverse(), {}, S);
    expect(x).toEqual(y);
    expect(x[0].lapses).toBe(1);
  });

  it('keeps history over a later green fill', () => {
    const a = note('v:学习|xuexi', { studied: true });
    const c = cardId(a.id, 'recog');
    const cards = deriveCards([a], [ev(c, 3, T0)], { [a.id]: T0 + DAY }, S);
    expect(cards[0].seeded).toBeUndefined();
    expect(cards[0].reps).toBe(1);
  });

  it('replays reviews on top of the seed', () => {
    const a = note('v:学习|xuexi', { studied: true });
    const c = cardId(a.id, 'recog');
    const cards = deriveCards([a], [ev(c, 3, T0 + 10 * DAY)], { [a.id]: T0 }, S);
    expect(cards[0].seeded).toBe(true);
    expect(cards[0].due).toBeGreaterThan(T0 + 30 * DAY);
  });

  it('reports a word as new until reviewed', () => {
    const a = note('v:学习|xuexi');
    expect(noteStatus(deriveCards([a], [], {}, S), T0)).toBe('new');
  });
});

describe('buildQueue', () => {
  it('takes due reviews and new words up to the daily limit, one card per word', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => note(`v:新${i}|xin`, { order: 100 + i }));
    const green = Array.from({ length: 5 }, (_, i) => note(`v:旧${i}|jiu`, { studied: true, order: i }));
    const notes = [...green, ...fresh];
    const seeds = Object.fromEntries(green.map((x) => [x.id, T0 - 70 * DAY]));
    const cards = deriveCards(notes, [], seeds, S);
    const q = buildQueue(cards, new Map(notes.map((x) => [x.id, x])), [], { newVocab: 10, newOther: 2, maxReviews: 100 }, T0);
    const noteIds = q.cards.map((c) => c.slice(0, c.lastIndexOf('#')));
    expect(new Set(noteIds).size).toBe(noteIds.length);
    expect(q.fresh.size).toBe(10);
    expect(q.counts.due).toBe(5);
    expect([...q.fresh][0]).toBe(cardId('v:新0|xin', 'recog'));
  });

  it('counts words introduced today on any device against the limit', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => note(`v:新${i}|xin`, { order: i }));
    const evs = fresh.slice(0, 4).map((x) => ev(cardId(x.id, 'recog'), 3, T0 - 3600000, 'iphone'));
    const cards = deriveCards(fresh, evs, {}, S);
    const q = buildQueue(cards, new Map(fresh.map((x) => [x.id, x])), evs, { newVocab: 10, newOther: 2, maxReviews: 100 }, T0);
    expect(q.counts.newVocabLeft).toBe(6);
  });
});

describe('grading', () => {
  const w = note('v:朋友|pengyou', { hanzi: '朋友', pinyin: 'péngyou', pinyinNum: 'peng2 you5', en: 'friend (to make friends', alts: [] });
  it('checks pinyin with numbers or marks, neutral tones free', () => {
    expect(checkPinyin('peng2you', w).verdict).toBe('right');
    expect(checkPinyin('péngyǒu', w).verdict).toBe('right');
    expect(checkPinyin('peng3you', w).verdict).toBe('tones');
    expect(checkPinyin('pengyou', w).verdict).toBe('tones');
    expect(checkPinyin('pengyue', w).verdict).toBe('wrong');
  });
  it('accepts alternative pinyin and forms', () => {
    const x = note('v:高兴|gaoxing', { hanzi: '高兴', alts: ['开心'], pinyinNum: 'gao1 xing4', altPinyin: ['kai1 xin1'] });
    expect(checkPinyin('kai1xin1', x).verdict).toBe('right');
    expect(checkHanzi('开心', x).verdict).toBe('right');
    expect(checkHanzi(' 高兴 ', x).verdict).toBe('right');
    expect(checkHanzi('高', x).verdict).toBe('wrong');
  });
  it('checks meanings, ignoring case, accents, "to", articles, notes and one-letter typos', () => {
    expect(meaningsOf('to attract (interest; to dry (of weather')).toEqual(['attract', 'dry']);
    expect(checkMeaning('Friend', [w.en]).verdict).toBe('right');
    expect(checkMeaning('freind', ['to study, learn']).verdict).toBe('wrong');
    expect(checkMeaning('studdy', ['to study, learn']).verdict).toBe('right');
    expect(checkMeaning("l'ami", ['ami ; camarade']).verdict).toBe('right');
    expect(checkMeaning('etudier', ['étudier ; apprendre']).verdict).toBe('right');
    expect(checkMeaning('make friends', ['to make friends with someone']).verdict).toBe('near');
    expect(checkMeaning('table', ['friend']).verdict).toBe('wrong');
  });
  it('maps verdicts and handwriting to grades', () => {
    expect(gradeFor('right', 2000)).toBe(4);
    expect(gradeFor('right', 9000)).toBe(3);
    expect(gradeFor('tones', 2000)).toBe(2);
    expect(gradeFor('wrong', 2000)).toBe(1);
    expect(gradeWriting(0, 0)).toBe(3);
    expect(gradeWriting(2, 0)).toBe(2);
    expect(gradeWriting(0, 1)).toBe(1);
    expect(gradeWriting(3, 0)).toBe(1);
  });
});
