import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MarkKind, Note, ReviewEvent, StatusMark } from '../types';
import {
  addDays,
  applyReview,
  cardId,
  dayStart,
  deriveCards,
  isLeech,
  KNOWN_DAYS,
  KNOWN_SPREAD,
  latestMarks,
  noteStatus,
  resolveMarkNotes,
  seedOffset,
  DAY,
} from './schedule';
import { buildQueue, moreNew, reviewAhead } from './queue';
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

  it('a word stops being new once one of its cards is studied', () => {
    const a = note('v:学习|xuexi');
    const cards = deriveCards([a], [ev(cardId(a.id, 'recog'), 3, T0)], {}, S);
    expect(cards.find((c) => c.type === 'recall')?.state).toBe(0);
    expect(noteStatus(cards, T0 + 60000)).toBe('learning');
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

  it('moreNew gives the next words beyond the limit, and the following ones after they are learned', () => {
    const fresh = Array.from({ length: 30 }, (_, i) => note(`v:新${i}|xin`, { order: i }));
    const map = new Map(fresh.map((x) => [x.id, x]));
    const s = { newVocab: 3, newOther: 2, maxReviews: 100 };
    const evs = fresh.slice(0, 3).map((x) => ev(cardId(x.id, 'recog'), 3, T0 - 3600000));
    let more = moreNew(deriveCards(fresh, evs, {}, S), map, evs, s, T0, 5);
    expect(more).toEqual(fresh.slice(3, 8).map((x) => cardId(x.id, 'recog')));
    const evs2 = [...evs, ...fresh.slice(3, 8).map((x) => ev(cardId(x.id, 'recog'), 3, T0 - 1800000))];
    more = moreNew(deriveCards(fresh, evs2, {}, S), map, evs2, s, T0, 5);
    expect(more[0]).toBe(cardId(fresh[8].id, 'recog'));
    expect(more).toHaveLength(5);
  });

  it('reviewAhead lists later reviews soonest first, one per word', () => {
    const green = Array.from({ length: 4 }, (_, i) => note(`v:旧${i}|jiu`, { studied: true, order: i }));
    const seeds = Object.fromEntries(green.map((x) => [x.id, T0]));
    const cards = deriveCards(green, [], seeds, S);
    const ahead = reviewAhead(cards, new Map(green.map((x) => [x.id, x])), T0, 3);
    expect(ahead).toHaveLength(3);
    const due = ahead.map((id) => cards.find((c) => c.id === id)!.due);
    expect(due).toEqual([...due].sort((a, b) => a - b));
    expect(new Set(ahead.map((id) => id.slice(0, id.lastIndexOf('#')))).size).toBe(3);
  });
});

describe('status marks', () => {
  let k = 0;
  const mark = (note: string, a: MarkKind | string, t: number, id = `m${k++}`): StatusMark => ({ id, note, a: a as MarkKind, t, dev: 'pc' });
  const Q = { newVocab: 10, newOther: 2, maxReviews: 100 };
  const mapOf = (notes: Note[]) => new Map(notes.map((x) => [x.id, x]));

  it('"I know this" on a new word: mastered, first check 90–119 days out, not a new word today', () => {
    const a = note('v:学习|xuexi');
    const others = Array.from({ length: 3 }, (_, i) => note(`v:新${i}|xin`, { order: 10 + i }));
    const notes = [a, ...others];
    const cards = deriveCards(notes, [], {}, S, [mark(a.id, 'known', T0)]);
    const own = cards.filter((c) => c.note === a.id);
    expect(own).toHaveLength(2);
    for (const c of own) {
      expect(c.state).toBe(2);
      expect(c.locked).toBeUndefined();
      expect(c.mark).toEqual({ a: 'known', t: T0 });
      expect(c.difficulty).toBe(5);
      expect(c.first).toBe(T0);
      const days = Math.round((c.due - dayStart(T0)) / DAY);
      expect(days).toBeGreaterThanOrEqual(KNOWN_DAYS);
      expect(days).toBeLessThan(KNOWN_DAYS + KNOWN_SPREAD);
      expect(c.stability).toBe(days);
    }
    expect(noteStatus(own, T0 + 60000)).toBe('mastered');
    const q = buildQueue(cards, mapOf(notes), [], Q, T0 + 60000);
    expect(q.cards.some((id) => id.startsWith(a.id))).toBe(false);
    expect(q.fresh.size).toBe(3);
    expect(q.counts.introducedToday).toBe(0);
    expect(q.counts.newVocabLeft).toBe(10);
  });

  it('spreads known words over the 30-day window', () => {
    const notes = Array.from({ length: 300 }, (_, i) => note(`v:词${i}|ci`, { order: i }));
    const cards = deriveCards(notes, [], {}, S, notes.map((x) => mark(x.id, 'known', T0)));
    const days = new Set(cards.map((c) => Math.round((c.due - dayStart(T0)) / DAY)));
    expect(days.size).toBeGreaterThan(20);
  });

  it('a review after "I know this" continues from the known state', () => {
    const a = note('v:学习|xuexi');
    const c = cardId(a.id, 'recog');
    const [known] = deriveCards([a], [], {}, S, [mark(a.id, 'known', T0)]);
    const later = T0 + 100 * DAY;
    const [st] = deriveCards([a], [ev(c, 3, later)], {}, S, [mark(a.id, 'known', T0)]);
    expect(st).toEqual(applyReview(known, { r: 3, t: later }, S.retention));
    expect(st.state).toBe(2);
    expect(st.stability).toBeGreaterThan(known.stability);
    expect(st.reps).toBe(known.reps + 1);
    expect(st.nEvents).toBe(1);
    expect(st.mark).toEqual({ a: 'known', t: T0 });
    expect(st.first).toBe(T0);
  });

  it('"Relearn" on a mature card: learning, due within 2 minutes, in today’s queue, lapses kept', () => {
    const a = note('v:学习|xuexi', { studied: true });
    const c = cardId(a.id, 'recog');
    const evs = [ev(c, 1, T0 + 20 * DAY), ev(c, 3, T0 + 20 * DAY + 600000), ev(c, 3, T0 + 40 * DAY), ev(c, 4, T0 + 80 * DAY)];
    const seeds = { [a.id]: T0 };
    const before = deriveCards([a], evs, seeds, S).find((x) => x.type === 'recog')!;
    expect(before.state).toBe(2);
    expect(before.lapses).toBe(1);
    const t = T0 + 90 * DAY;
    const cards = deriveCards([a], evs, seeds, S, [mark(a.id, 'relearn', t)]);
    const st = cards.find((x) => x.type === 'recog')!;
    expect(st.state).toBe(1);
    expect(st.due - t).toBeLessThanOrEqual(2 * 60000);
    expect(st.lapses).toBe(1);
    expect(st.reps).toBe(before.reps);
    expect(st.nEvents).toBe(4);
    expect(st.leechBase).toBe(1);
    expect(st.mark).toEqual({ a: 'relearn', t });
    expect(noteStatus(cards, t + 1000)).toBe('learning');
    expect(buildQueue(cards, mapOf([a]), evs, Q, t + 1000).cards).toContain(st.id);
  });

  it('"I know this" on a leech clears the leech status and keeps the lapses', () => {
    const a = note('v:学习|xuexi', { studied: true });
    const c = cardId(a.id, 'recog');
    const evs: ReviewEvent[] = [];
    for (let i = 0; i < 9; i++) evs.push(ev(c, 1, T0 + (2 + 3 * i) * DAY), ev(c, 3, T0 + (2 + 3 * i) * DAY + 600000));
    const seeds = { [a.id]: T0 };
    const before = deriveCards([a], evs, seeds, S).find((x) => x.type === 'recog')!;
    expect(isLeech(before)).toBe(true);
    const t = T0 + 40 * DAY;
    const cards = deriveCards([a], evs, seeds, S, [mark(a.id, 'known', t)]);
    const st = cards.find((x) => x.type === 'recog')!;
    expect(isLeech(st)).toBe(false);
    expect(st.lapses).toBe(before.lapses);
    expect(st.leechBase).toBe(before.lapses);
    expect(noteStatus(cards, t + 1000)).toBe('mastered');
    // Lapses after the mark count again from there.
    const more = [...evs];
    for (let i = 0; i < 8; i++) more.push(ev(c, 1, t + (120 + 3 * i) * DAY), ev(c, 3, t + (120 + 3 * i) * DAY + 600000));
    expect(isLeech(deriveCards([a], more, seeds, S, [mark(a.id, 'known', t)]).find((x) => x.type === 'recog')!)).toBe(true);
  });

  it('"Suspend" takes a word out of buildQueue, moreNew and reviewAhead; "Unsuspend" restores its schedule', () => {
    const green = Array.from({ length: 4 }, (_, i) => note(`v:旧${i}|jiu`, { studied: true, order: i }));
    const fresh = Array.from({ length: 10 }, (_, i) => note(`v:新${i}|xin`, { order: 10 + i }));
    const notes = [...green, ...fresh];
    const map = mapOf(notes);
    const seeds = Object.fromEntries(green.map((x) => [x.id, T0 - 70 * DAY]));
    const s = { newVocab: 2, newOther: 2, maxReviews: 100 };
    const plain = deriveCards(notes, [], seeds, S);
    expect(buildQueue(plain, map, [], s, T0).cards).toContain(cardId(green[0].id, 'recog'));
    expect(moreNew(plain, map, [], s, T0, 2)).toEqual([cardId(fresh[2].id, 'recog'), cardId(fresh[3].id, 'recog')]);

    const ms = [green[0], fresh[0], fresh[2]].map((x) => mark(x.id, 'suspend', T0 - DAY));
    const cards = deriveCards(notes, [], seeds, S, ms);
    const q = buildQueue(cards, map, [], s, T0);
    for (const x of [green[0], fresh[0], fresh[2]]) expect(q.cards.some((id) => id.startsWith(x.id))).toBe(false);
    expect([...q.fresh]).toEqual([cardId(fresh[1].id, 'recog'), cardId(fresh[3].id, 'recog')]);
    expect(moreNew(cards, map, [], s, T0, 2)).toEqual([cardId(fresh[4].id, 'recog'), cardId(fresh[5].id, 'recog')]);
    const later = deriveCards(green, [], { [green[0].id]: T0, [green[1].id]: T0 }, S, [mark(green[0].id, 'suspend', T0)]);
    expect(reviewAhead(later, mapOf(green), T0, 20).some((id) => id.startsWith(green[0].id))).toBe(false);
    expect(reviewAhead(later, mapOf(green), T0, 20).some((id) => id.startsWith(green[1].id))).toBe(true);
    expect(noteStatus(cards.filter((c) => c.note === green[0].id), T0)).toBe('suspended');
    expect(noteStatus(cards.filter((c) => c.note === fresh[0].id), T0)).toBe('suspended');

    const back = deriveCards(notes, [], seeds, S, [...ms, ...ms.map((m) => mark(m.note, 'unsuspend', T0))]);
    expect(back).toEqual(plain);
  });

  it('a review of a suspended word keeps it suspended', () => {
    const a = note('v:学习|xuexi');
    const c = cardId(a.id, 'recog');
    const [st] = deriveCards([a], [ev(c, 3, T0 + DAY)], {}, S, [mark(a.id, 'suspend', T0)]);
    expect(st.suspended).toBe(true);
    expect(st.nEvents).toBe(1);
  });

  it('green rows vs marks: the later one wins, and a re-import with the same seeds changes nothing', () => {
    const a = note('v:学习|xuexi', { studied: true });
    // Green first, then "Relearn": the mark wins.
    const relearnAfter = deriveCards([a], [], { [a.id]: T0 }, S, [mark(a.id, 'relearn', T0 + 5 * DAY, 'r1')]);
    expect(relearnAfter.every((c) => c.state === 1 && c.mark?.a === 'relearn')).toBe(true);
    // "Relearn", then the row coloured green: the seed wins.
    const greenAfter = deriveCards([a], [], { [a.id]: T0 + 5 * DAY }, S, [mark(a.id, 'relearn', T0, 'r1')]);
    expect(greenAfter).toEqual(deriveCards([a], [], { [a.id]: T0 + 5 * DAY }, S));
    expect(greenAfter.every((c) => c.state === 2 && c.seeded)).toBe(true);
    // Suspend before the seed still applies.
    const sus = deriveCards([a], [], { [a.id]: T0 + 5 * DAY }, S, [mark(a.id, 'suspend', T0, 's1')]);
    expect(sus.every((c) => c.suspended)).toBe(true);
    // Re-import: fresh note objects, same seeds.
    const again = deriveCards([structuredClone(a)], [], { [a.id]: T0 }, S, [mark(a.id, 'relearn', T0 + 5 * DAY, 'r1')]);
    expect(again).toEqual(relearnAfter);
    // Green colour removed: the mark still holds.
    const ungreen = deriveCards([{ ...a, studied: false }], [], { [a.id]: T0 }, S, [mark(a.id, 'known', T0 + 5 * DAY, 'k1')]);
    expect(ungreen.every((c) => c.state === 2 && c.mark?.a === 'known')).toBe(true);
  });

  it('gives identical cards whatever order marks and events arrive in (ties broken by id)', () => {
    const a = note('v:学习|xuexi');
    const b = note('v:朋友|pengyou', { order: 2 });
    const ca = cardId(a.id, 'recog');
    const evs = [ev(ca, 3, T0), ev(ca, 3, T0 + 600000), ev(ca, 1, T0 + 5 * DAY), ev(cardId(b.id, 'recog'), 3, T0 + DAY)];
    const ms = [
      mark(a.id, 'known', T0 + 2 * DAY, 'x1'),
      mark(a.id, 'suspend', T0 + 3 * DAY, 'x2'),
      mark(a.id, 'unsuspend', T0 + 3 * DAY, 'x3'),
      mark(b.id, 'relearn', T0 + 2 * DAY, 'x4'),
      mark(b.id, 'known', T0 + 2 * DAY, 'x5'),
      mark(a.id, 'relearn', T0 + 5 * DAY, 'x0'),
    ];
    const x = deriveCards([a, b], evs, {}, S, ms);
    const y = deriveCards([a, b], [...evs].reverse(), {}, S, [ms[3], ms[5], ms[1], ms[4], ms[0], ms[2]]);
    expect(x).toEqual(y);
    expect(x.find((c) => c.id === ca)!.suspended).toBeUndefined();
    expect(x.find((c) => c.id === cardId(b.id, 'recog'))!.mark?.a).toBe('known');
    // Same time: the mark x0 ("e…" ids sort first) replays after the Again of that moment.
    expect(x.find((c) => c.id === ca)!.mark).toEqual({ a: 'relearn', t: T0 + 5 * DAY });
    expect(latestMarks(ms).get(a.id)?.suspend?.a).toBe('unsuspend');
    expect(latestMarks([...ms].reverse()).get(b.id)?.status?.id).toBe('x5');
  });

  it('ignores a mark kind from a newer app version', () => {
    const a = note('v:学习|xuexi');
    const evs = [ev(cardId(a.id, 'recog'), 3, T0)];
    expect(deriveCards([a], evs, {}, S, [mark(a.id, 'pin', T0 + DAY)])).toEqual(deriveCards([a], evs, {}, S));
    expect(latestMarks([mark(a.id, 'pin', T0)]).size).toBe(0);
  });

  it('resolves marks on an old note id to the renamed note, without changing the stored marks', () => {
    const renamed = note('v:学习|xuexi2');
    const raw = [mark('v:学习|xuexi', 'known', T0, 'old1'), mark('v:不在|buzai', 'known', T0, 'gone')];
    const view = resolveMarkNotes(raw, { 'v:学习|xuexi': renamed.id }, new Set([renamed.id]));
    expect(view.map((m) => m.note)).toEqual([renamed.id, 'v:不在|buzai']);
    expect(raw[0].note).toBe('v:学习|xuexi');
    expect(view[1]).toBe(raw[1]);
    const cards = deriveCards([renamed], [], {}, S, view);
    expect(cards.every((c) => c.state === 2 && c.mark?.a === 'known')).toBe(true);
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

// Golden replay: ts-fsrs is pinned, and any change to scheduling (a library bump, new parameters) must show up here
// before it reaches Hugo's devices, because every device has to derive the same card states from the same events.
describe('golden replay (ts-fsrs 6.0.0)', () => {
  // Node applies a runtime TZ change; the snapshot must not depend on the machine's timezone.
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  let tz: string | undefined;
  beforeAll(() => {
    tz = env.TZ;
    env.TZ = 'UTC';
  });
  afterAll(() => {
    if (tz == null) delete env.TZ;
    else env.TZ = tz;
  });

  it('replays fixed events into the same card states', () => {
    const t0 = Date.UTC(2026, 0, 5, 9);
    const H = 3600000;
    const words = [
      note('v:学习|xuexi', { order: 1 }),
      note('v:朋友|pengyou', { order: 2, studied: true }),
      note('v:高兴|gaoxing', { order: 3 }),
      note('g:越来越', { kind: 'grammar', hanzi: '越来越', order: 4 }),
    ];
    const seeds = { 'v:朋友|pengyou': t0 - 10 * DAY };
    const grades: [string, 1 | 2 | 3 | 4, number][] = [
      ['v:学习|xuexi#recog', 3, 0],
      ['v:学习|xuexi#recog', 3, 10 * 60000],
      ['v:学习|xuexi#recog', 4, DAY + H],
      ['v:学习|xuexi#recall', 1, DAY + 2 * H],
      ['v:学习|xuexi#recall', 3, DAY + 2 * H + 5 * 60000],
      ['v:学习|xuexi#recog', 3, 6 * DAY],
      ['v:学习|xuexi#recall', 2, 4 * DAY],
      ['v:学习|xuexi#recog', 1, 30 * DAY],
      ['v:学习|xuexi#recog', 3, 30 * DAY + 10 * 60000],
      ['v:朋友|pengyou#recog', 3, 12 * DAY],
      ['v:朋友|pengyou#recog', 4, 60 * DAY],
      ['v:高兴|gaoxing#recog', 2, 2 * DAY],
      ['v:高兴|gaoxing#recog', 1, 2 * DAY + 5 * 60000],
      ['v:高兴|gaoxing#recog', 3, 2 * DAY + 15 * 60000],
      ['g:越来越#grammar', 3, 3 * DAY],
      ['g:越来越#grammar', 3, 5 * DAY],
    ];
    const events: ReviewEvent[] = grades.map(([card, r, dt], i) => ({ id: `g${i}`, card, r, t: t0 + dt, d: 3000, m: 'reveal', dev: 'pc' }));
    const cards = deriveCards(words, events, seeds, { retention: 0.9, spreadDays: 60, recall: true, listen: true });
    const out = cards.map((c) => ({
      id: c.id,
      due: new Date(c.due).toISOString(),
      s: +c.stability.toFixed(6),
      d: +c.difficulty.toFixed(6),
      days: c.scheduledDays,
      steps: c.learningSteps,
      reps: c.reps,
      lapses: c.lapses,
      state: c.state,
      n: c.nEvents,
      ...(c.seeded ? { seeded: true } : {}),
      ...(c.locked ? { locked: true } : {}),
    }));
    expect(out).toMatchInlineSnapshot(`
      [
        {
          "d": 7.015191,
          "days": 3,
          "due": "2026-02-07T09:10:00.000Z",
          "id": "v:学习|xuexi#recog",
          "lapses": 1,
          "n": 6,
          "reps": 6,
          "s": 2.589853,
          "state": 2,
          "steps": 0,
        },
        {
          "d": 7.596785,
          "days": 0,
          "due": "2026-01-09T09:05:30.000Z",
          "id": "v:学习|xuexi#recall",
          "lapses": 0,
          "n": 3,
          "reps": 3,
          "s": 1.906225,
          "state": 1,
          "steps": 1,
        },
        {
          "d": 0,
          "days": 0,
          "due": "2026-01-06T04:00:00.000Z",
          "id": "v:学习|xuexi#listen",
          "lapses": 0,
          "n": 0,
          "reps": 0,
          "s": 0,
          "state": 0,
          "steps": 0,
        },
        {
          "d": 3.301425,
          "days": 219,
          "due": "2026-10-11T09:00:00.000Z",
          "id": "v:朋友|pengyou#recog",
          "lapses": 0,
          "n": 2,
          "reps": 3,
          "s": 218.584295,
          "seeded": true,
          "state": 2,
          "steps": 0,
        },
        {
          "d": 5,
          "days": 31,
          "due": "2026-01-26T04:00:00.000Z",
          "id": "v:朋友|pengyou#recall",
          "lapses": 0,
          "n": 0,
          "reps": 1,
          "s": 20,
          "seeded": true,
          "state": 2,
          "steps": 0,
        },
        {
          "d": 5,
          "days": 16,
          "due": "2026-01-11T04:00:00.000Z",
          "id": "v:朋友|pengyou#listen",
          "lapses": 0,
          "n": 0,
          "reps": 1,
          "s": 20,
          "seeded": true,
          "state": 2,
          "steps": 0,
        },
        {
          "d": 8.365482,
          "days": 0,
          "due": "2026-01-07T09:25:00.000Z",
          "id": "v:高兴|gaoxing#recog",
          "lapses": 0,
          "n": 3,
          "reps": 3,
          "s": 0.499783,
          "state": 1,
          "steps": 1,
        },
        {
          "d": 0,
          "days": 0,
          "due": "2026-01-08T04:00:00.000Z",
          "id": "v:高兴|gaoxing#recall",
          "lapses": 0,
          "n": 0,
          "reps": 0,
          "s": 0,
          "state": 0,
          "steps": 0,
        },
        {
          "d": 0,
          "days": 0,
          "due": "2026-01-08T04:00:00.000Z",
          "id": "v:高兴|gaoxing#listen",
          "lapses": 0,
          "n": 0,
          "reps": 0,
          "s": 0,
          "state": 0,
          "steps": 0,
        },
        {
          "d": 2.111214,
          "days": 11,
          "due": "2026-01-21T09:00:00.000Z",
          "id": "g:越来越#grammar",
          "lapses": 0,
          "n": 2,
          "reps": 2,
          "s": 10.964332,
          "state": 2,
          "steps": 0,
        },
      ]
    `);
  });
});
