// The per-word card memo (memo.ts): exact equality with deriveCards, what makes a word replay, the env, the kv row,
// and the guards that catch a future engine read the fingerprint doesn't cover.
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MarkKind, Note, NoteKind, ReviewEvent, StatusMark } from '../types';
import { cardTypes, deriveCards, resolveEventCards, resolveMarkNotes, type EngineSettings } from './schedule';
import { cyrb53, decodeMemo, deriveWithMemo, deriveWithMemoAsync, encodeMemo, fingerprint, fingerprintText, memoEnv, tzKey, type CardMemo } from './memo';

const S: EngineSettings = { retention: 0.9, spreadDays: 30, recall: true, listen: true };
const HOUR = 3600000;
const DAY = 24 * HOUR;
const T = new Date(2026, 0, 5, 9).getTime();
const KINDS: MarkKind[] = ['known', 'relearn', 'suspend', 'unsuspend', 'st:new', 'st:studying', 'st:notknown', 'st:mastered', 'flag:wrong', 'unflag:wrong'];

/** mulberry32: a small seeded PRNG, so every run gets the same fixture. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function note(id: string, over: Partial<Note> = {}): Note {
  return { id, kind: 'vocab', hanzi: id, alts: [], pinyin: '', pinyinNum: '', en: 'x', notes: [], tags: [], refs: [], order: 0, studied: false, examples: [], ...over };
}

interface Inputs {
  notes: Note[];
  events: ReviewEvent[];
  seeds: Record<string, number>;
  marks: StatusMark[];
  s: EngineSettings;
}

/** 240 words (vocab, grammar, measure, synonym), seeds, 3,000 events on hour ticks (many equal times), 400 marks. */
function fixture(seed = 1): Inputs {
  const r = rng(seed);
  const pick = <T,>(l: T[]): T => l[Math.floor(r() * l.length)];
  const notes: Note[] = [];
  const seeds: Record<string, number> = {};
  for (let i = 0; i < 240; i++) {
    const kind: NoteKind = i % 6 === 0 ? 'grammar' : i % 17 === 0 ? 'measure' : i % 23 === 0 ? 'synonym' : 'vocab';
    const n = note(`${kind[0]}:词${i}|ci${i}`, { kind, order: i, studied: r() < 0.3 });
    notes.push(n);
    if (r() < 0.4) seeds[n.id] = T + Math.floor(r() * 30) * DAY;
  }
  const events: ReviewEvent[] = [];
  for (let k = 0; k < 3000; k++) {
    const n = pick(notes);
    events.push({ id: `e${k}`, card: `${n.id}#${pick(cardTypes(n, S))}`, r: (1 + Math.floor(r() * 4)) as 1 | 2 | 3 | 4, t: T + Math.floor(r() * 1500) * HOUR, d: 1000, m: 'reveal', dev: 'pc' });
  }
  const marks: StatusMark[] = [];
  for (let k = 0; k < 400; k++) {
    const a = k % 40 === 0 ? ('zz:future' as MarkKind) : pick(KINDS);
    marks.push({ id: `m${k}`, note: pick(notes).id, a, t: T + Math.floor(r() * 1500) * HOUR, dev: 'pc' });
  }
  return { notes, events, seeds, marks, s: S };
}

const derive = (x: Inputs) => deriveCards(x.notes, x.events, x.seeds, x.s, x.marks);
const withMemo = (x: Inputs, memo: CardMemo | null) => deriveWithMemo(x.notes, x.events, x.seeds, x.s, x.marks, memo);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('deriveWithMemo', () => {
  const base = fixture();
  const first = withMemo(base, null);
  // A word with events and marks, and the next one with events: the targets of the changes below.
  const A = base.notes.find((n) => base.events.some((e) => e.card.startsWith(`${n.id}#`)) && base.marks.some((m) => m.note === n.id))!.id;
  const B = base.notes.find((n) => n.id !== A && base.events.some((e) => e.card.startsWith(`${n.id}#`)))!.id;

  it('without a memo equals deriveCards, in the same order', () => {
    expect(base.events.length).toBe(3000);
    expect(new Set(base.events.map((e) => e.t)).size).toBeLessThan(1500);
    expect(first.full).toBe(true);
    expect(first.replayed).toBe(base.notes.length);
    expect(first.cards).toEqual(derive(base));
    expect(first.memo.notes.size).toBe(base.notes.length);
  });

  it('the same inputs again replay nothing and give back the very same card objects', () => {
    const again = withMemo(base, first.memo);
    expect(again.replayed).toBe(0);
    expect(again.full).toBe(false);
    expect(again.cards).toHaveLength(first.cards.length);
    again.cards.forEach((c, i) => expect(c).toBe(first.cards[i]));
  });

  /** `next` from the base memo: only `words` are replayed, the rest are the same objects, all equal to a fresh derive. */
  function onlyReplays(next: Inputs, words: string[]) {
    const r = withMemo(next, first.memo);
    expect(r.cards).toEqual(derive(next));
    expect(r.full).toBe(false);
    expect(r.replayed).toBe(words.length);
    const old = new Map(first.cards.map((c) => [c.id, c]));
    for (const c of r.cards) {
      if (words.includes(c.note)) continue;
      expect(c).toBe(old.get(c.id));
    }
    return r;
  }

  const ofNote = (id: string) => base.events.filter((e) => e.card.startsWith(`${id}#`));

  it('an added, removed or changed event replays its word only', () => {
    const add: ReviewEvent = { ...ofNote(A)[0], id: 'new1', t: ofNote(A)[0].t + HOUR };
    onlyReplays({ ...base, events: [...base.events, add] }, [A]);
    const gone = ofNote(B)[0].id;
    onlyReplays({ ...base, events: base.events.filter((e) => e.id !== gone) }, [B]);
    const target = ofNote(A)[0].id;
    onlyReplays({ ...base, events: base.events.map((e) => (e.id === target ? { ...e, r: (e.r === 4 ? 1 : 4) as 1 | 4 } : e)) }, [A]);
    onlyReplays({ ...base, events: base.events.map((e) => (e.id === target ? { ...e, t: e.t + 7 } : e)) }, [A]);
    // Another event with the same id and time, on another card of the word: the type is in the fingerprint.
    const recog = ofNote(A).find((e) => e.card.endsWith('#recog'));
    if (recog) onlyReplays({ ...base, events: base.events.map((e) => (e.id === recog.id ? { ...e, card: `${A}#recall` } : e)) }, [A]);
  });

  it('an added or removed mark of any kind replays its word only', () => {
    for (const a of [...KINDS, 'zz:future' as MarkKind]) {
      onlyReplays({ ...base, marks: [...base.marks, { id: `x-${a}`, note: B, a, t: T + 5 * DAY, dev: 'pc' }] }, [B]);
    }
    const gone = base.marks.find((m) => m.note === A)!.id;
    onlyReplays({ ...base, marks: base.marks.filter((m) => m.id !== gone) }, [A]);
  });

  it('kind, studied and seed changes replay their word only', () => {
    const swap = (id: string, over: Partial<Note>) => base.notes.map((n) => (n.id === id ? { ...n, ...over } : n));
    onlyReplays({ ...base, notes: swap(A, { kind: base.notes.find((n) => n.id === A)!.kind === 'grammar' ? 'vocab' : 'grammar' }) }, [A]);
    onlyReplays({ ...base, notes: swap(B, { studied: !base.notes.find((n) => n.id === B)!.studied }) }, [B]);
    onlyReplays({ ...base, seeds: { ...base.seeds, [A]: T - 3 * DAY } }, [A]);
    const seeded = Object.keys(base.seeds)[0];
    const { [seeded]: _drop, ...fewer } = base.seeds;
    onlyReplays({ ...base, seeds: fewer }, [seeded]);
  });

  it('added, removed and reordered words', () => {
    const added = note('v:新|xin', { order: 999, studied: true });
    onlyReplays({ ...base, notes: [...base.notes, added], seeds: { ...base.seeds, [added.id]: T } }, [added.id]);
    const removed = onlyReplays({ ...base, notes: base.notes.filter((n) => n.id !== A) }, []);
    expect(removed.memo.notes.has(A)).toBe(false);
    expect(removed.memo.notes.size).toBe(base.notes.length - 1);
    const reordered = onlyReplays({ ...base, notes: [...base.notes].reverse() }, []);
    expect(reordered.cards[0].note).toBe(base.notes[base.notes.length - 1].id);
  });

  it('an alias that moves events and marks to another word replays both words', () => {
    const ids = new Set(base.notes.map((n) => n.id));
    const oldEvents: ReviewEvent[] = [0, 1, 2].map((i) => ({ id: `old${i}`, card: 'v:旧|jiu#recog', r: 3, t: T + i * DAY, d: 1, m: 'reveal', dev: 'pc' }));
    const oldMark: StatusMark = { id: 'oldm', note: 'v:旧|jiu', a: 'suspend', t: T + DAY, dev: 'pc' };
    const view = (to: string): Inputs => ({
      ...base,
      events: resolveEventCards([...base.events, ...oldEvents], { 'v:旧|jiu': to }, ids),
      marks: resolveMarkNotes([...base.marks, oldMark], { 'v:旧|jiu': to }, ids),
    });
    const toA = withMemo(view(A), first.memo);
    expect(toA.replayed).toBe(1);
    const toB = withMemo(view(B), toA.memo);
    expect(toB.cards).toEqual(derive(view(B)));
    expect(toB.replayed).toBe(2);
    // Events of a word that is not in the list are ignored, as in deriveCards: no replay.
    const nowhere = withMemo({ ...base, events: [...base.events, ...oldEvents], marks: [...base.marks, oldMark] }, first.memo);
    expect(nowhere.replayed).toBe(0);
  });

  it('a change of any engine setting, the time zone or the build replays everything', () => {
    for (const s of [{ ...S, retention: 0.85 }, { ...S, spreadDays: 31 }, { ...S, recall: false }, { ...S, listen: false }]) {
      const r = withMemo({ ...base, s }, first.memo);
      expect(r.full).toBe(true);
      expect(r.replayed).toBe(base.notes.length);
      expect(r.cards).toEqual(derive({ ...base, s }));
    }
    expect(memoEnv(S, 'b1', 'Europe/Paris|-60|-120')).not.toBe(memoEnv(S, 'b1', 'Asia/Shanghai|-480|-480'));
    expect(memoEnv(S, 'b1', 'Europe/Paris|-60|-120')).not.toBe(memoEnv(S, 'b2', 'Europe/Paris|-60|-120'));
    expect(memoEnv(S)).toBe(first.memo.env);
    for (const env of [memoEnv(S, 'another-build'), memoEnv(S, undefined, 'Elsewhere|0|0')]) {
      const r = withMemo(base, { ...first.memo, env });
      expect(r.full).toBe(true);
      expect(r.replayed).toBe(base.notes.length);
    }
    expect(tzKey()).toMatch(/\|-?\d+\|-?\d+$/);
  });

  it('field guard: any Note field that changes deriveCards output changes the fingerprint', () => {
    const full: Required<Note> = {
      id: 'v:学习|xuexi',
      kind: 'vocab',
      hanzi: '学习',
      alts: ['学'],
      pinyin: 'xuéxí',
      pinyinNum: 'xue2 xi2',
      altPinyin: ['xue2'],
      en: 'to study',
      fr: 'étudier',
      frAuto: 'apprendre',
      notes: ['n'],
      tags: ['HSK一级'],
      refs: [{ sheet: 'HSK一级', row: 3, id: '7', colour: '92D050' }],
      order: 4,
      studied: true,
      colour: '92D050',
      examples: [{ zh: '我学习', pinyin: 'wo3', en: 'I study' }],
      group: '233',
      set: 's1',
      extra: { a: 'b' },
      grammar: { hsk: 3, family: 'time', title: { en: 'a' } },
      confuse: [{ word: '学', register: 'spoken', fr: 'f', en: 'e' }],
      register: 'spoken',
    };
    // Another value for every field (a new Note field fails to compile here until it gets one).
    const other: { [K in keyof Required<Note>]: Note[K][] } = {
      id: [],
      kind: ['grammar', 'measure', 'synonym'],
      hanzi: ['学'],
      alts: [[]],
      pinyin: ['x'],
      pinyinNum: ['xue2'],
      altPinyin: [[]],
      en: ['y'],
      fr: ['z'],
      frAuto: ['w'],
      notes: [[]],
      tags: [[]],
      refs: [[]],
      order: [5],
      studied: [false],
      colour: ['FFFFFF'],
      examples: [[]],
      group: ['234'],
      set: ['s2'],
      extra: [{}],
      grammar: [undefined],
      confuse: [[], undefined],
      register: ['written', undefined],
    };
    expect(Object.keys(other).sort()).toEqual(Object.keys(full).sort());
    // Two situations where most fields could matter: a seeded word without events, and one with events and marks.
    const evs: ReviewEvent[] = [{ id: 'a', card: `${full.id}#recog`, r: 3, t: T + DAY, d: 1, m: 'reveal', dev: 'pc' }];
    const ms: StatusMark[] = [{ id: 'k', note: full.id, a: 'known', t: T + 2 * DAY, dev: 'pc' }];
    let checked = 0;
    for (const [e, m] of [[[], []], [evs, ms]] as [ReviewEvent[], StatusMark[]][]) {
      const seeds = { [full.id]: T };
      const ref = deriveCards([full], e, seeds, S, m);
      const fp = fingerprint(full, T, [...e], [...m]);
      for (const key of Object.keys(other) as (keyof Note)[]) {
        // The id is the memo's key, not part of the fingerprint.
        if (key === 'id') continue;
        for (const v of other[key]) {
          const changed = { ...full, [key]: v } as Note;
          const out = deriveCards([changed], e, seeds, S, m);
          if (JSON.stringify(out) === JSON.stringify(ref)) continue;
          checked++;
          expect(fingerprint(changed, T, [...e], [...m]), `field ${key}`).not.toBe(fp);
        }
      }
    }
    // kind (3 values) in both situations, studied in the seeded one.
    expect(checked).toBeGreaterThanOrEqual(7);
  });

  it('the fingerprint is cyrb53 of kind|studied|seed|events|marks', () => {
    expect(cyrb53('')).toBe(cyrb53('', 0));
    expect(cyrb53('a')).not.toBe(cyrb53('b'));
    for (const n of base.notes.slice(0, 60)) {
      const e = base.events.filter((x) => x.card.startsWith(`${n.id}#`));
      const m = base.marks.filter((x) => x.note === n.id);
      expect(fingerprint(n, base.seeds[n.id], [...e], [...m])).toBe(cyrb53(fingerprintText(n, base.seeds[n.id], [...e], [...m])));
    }
    const n = base.notes.find((x) => x.id === A)!;
    expect(fingerprintText(n, 5, [{ id: 'b', card: `${A}#recog`, r: 2, t: 9, d: 0, m: '', dev: '' }, { id: 'a', card: `${A}#recall`, r: 4, t: 9, d: 0, m: '', dev: '' }], [{ id: 'k', note: A, a: 'known', t: 1, dev: '' }])).toBe(
      `${n.kind}|${n.studied ? 1 : 0}|5|a,recall,9,4;b,recog,9,2|k,known,1`,
    );
  });

  it('purity guard: deriveCards does not read the clock or Math.random', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T);
    vi.spyOn(Math, 'random').mockReturnValue(0.1);
    const a = derive(base);
    vi.setSystemTime(T + 400 * DAY);
    vi.spyOn(Math, 'random').mockReturnValue(0.9);
    const b = derive(base);
    expect(b).toEqual(a);
    expect(a).toEqual(first.cards);
  });
});

describe('the kv row', () => {
  const base = fixture(2);
  const { memo } = withMemo(base, null);

  it('encodes and decodes to the same memo', () => {
    const row = encodeMemo(memo, 1234);
    expect(row).toMatchObject({ v: 1, env: memo.env, at: 1234 });
    expect(typeof row.json).toBe('string');
    const back = decodeMemo(structuredClone(row), memo.env)!;
    expect(back.env).toBe(memo.env);
    expect([...back.notes.keys()]).toEqual([...memo.notes.keys()]);
    for (const [id, e] of memo.notes) expect(back.notes.get(id)).toEqual(e);
    // A decoded memo reproduces the cards with no replay.
    const r = withMemo(base, back);
    expect(r.replayed).toBe(0);
    expect(r.cards).toEqual(derive(base));
  });

  it('a word whose cards hold a non-finite number is left out, and replayed next time', () => {
    const [id, e] = [...memo.notes][0];
    const bad: CardMemo = { env: memo.env, notes: new Map([...memo.notes].map(([k, v]) => [k, k === id ? { ...e, cards: [{ ...e.cards[0], stability: NaN }] } : v])) };
    const back = decodeMemo(encodeMemo(bad, 1), memo.env)!;
    expect(back.notes.has(id)).toBe(false);
    expect(back.notes.size).toBe(memo.notes.size - 1);
    const r = withMemo(base, back);
    expect(r.replayed).toBe(1);
    expect(r.cards).toEqual(derive(base));
  });

  it('decodes to null for anything but a well-formed v1 row of this env, and never throws', () => {
    const row = encodeMemo(memo, 1);
    const entries = JSON.parse(row.json) as [string, string, Record<string, unknown>[]][];
    const withCard = (f: (c: Record<string, unknown>) => void) => {
      const copy = structuredClone(entries);
      f(copy[0][2][0]);
      return { ...row, json: JSON.stringify(copy) };
    };
    const bad: unknown[] = [
      null,
      undefined,
      'x',
      42,
      [],
      { ...row, v: 2 },
      { ...row, env: memoEnv({ ...S, retention: 0.8 }) },
      { ...row, json: '{not json' },
      { ...row, json: undefined },
      { ...row, json: '{}' },
      { ...row, json: JSON.stringify([['a', 'b']]) },
      { ...row, json: JSON.stringify([['a', 1, []]]) },
      { ...row, json: JSON.stringify([['a', 'b', {}]]) },
      { ...row, json: JSON.stringify([null]) },
      withCard((c) => delete c.due),
      withCard((c) => delete c.id),
      withCard((c) => (c.reps = 'x')),
      withCard((c) => (c.stability = null)), // what JSON makes of NaN
      withCard((c) => (c.note = 'someone else')),
      withCard((c) => (c.state = 4)),
      withCard((c) => (c.type = 7)),
    ];
    for (const b of bad) expect(decodeMemo(b, memo.env), JSON.stringify(b)?.slice(0, 80)).toBeNull();
    expect(decodeMemo(row, memo.env)).not.toBeNull();
    expect(decodeMemo({ ...row, json: '[]' }, memo.env)?.notes.size).toBe(0);
  });
});

describe('deriveWithMemoAsync', () => {
  const base = fixture(3);

  it('gives the same result as the sync variant, and yields between slices only when one ran long', async () => {
    const calls = vi.fn(() => Promise.resolve());
    vi.stubGlobal('scheduler', { yield: calls });
    const sync = withMemo(base, null);
    const cold = await deriveWithMemoAsync(base.notes, base.events, base.seeds, S, base.marks, null, 0);
    expect(cold.cards).toEqual(sync.cards);
    expect(cold.replayed).toBe(sync.replayed);
    expect(cold.full).toBe(true);
    expect(calls).toHaveBeenCalled();
    calls.mockClear();
    // A warm start never yields: the walk is far below one slice.
    const warm = await deriveWithMemoAsync(base.notes, base.events, base.seeds, S, base.marks, sync.memo);
    expect(warm.replayed).toBe(0);
    expect(warm.cards).toEqual(sync.cards);
    expect(calls).not.toHaveBeenCalled();
  });

  it('falls back to a MessageChannel message without scheduler.yield', async () => {
    vi.stubGlobal('scheduler', undefined);
    const r = await deriveWithMemoAsync(base.notes, base.events, base.seeds, S, base.marks, null, 0);
    expect(r.cards).toEqual(derive(base));
  });
});
