// The shared import history (plan D3): merging two imports of the same workbook content, and what sync does with the
// shared list it pulls.
import { describe, expect, it } from 'vitest';
import type { VocabFile, WordStatus } from '../types';
import { mergeSameVersion, vocabAction, vocabDiffers } from './canonical';

const T = 1_800_000_000_000;

function list(over: Partial<VocabFile> = {}, source: Partial<VocabFile['source']> = {}): VocabFile {
  return {
    version: 1,
    importedAt: T,
    device: 'pc-1',
    source: { name: 'Hugo_chinese_vocab.xlsx', modified: T - 1000, size: 1500, qxh: 'Q1', ...source },
    hash: 'h1',
    notes: [],
    issues: [],
    seeds: {},
    report: [],
    ...over,
  };
}

const cs = (o: Record<string, [WordStatus, number]>) => o;

describe('mergeSameVersion', () => {
  const local = list(
    {
      importedAt: T + 50,
      device: 'phone-1',
      colourSince: cs({ a: ['mastered', T + 10], b: ['notknown', T + 5], c: ['studying', T + 7] }),
      seeds: { n1: T + 3, n2: T + 9 },
      aliases: { old1: 'n1', clash: 'local' },
    },
    { app: true },
  );
  const remote = list({
    colourSince: cs({ a: ['mastered', T + 20], b: ['new', T + 30], d: ['new', T + 1] }),
    seeds: { n1: T + 8, n3: T + 2 },
    aliases: { old3: 'n3', clash: 'remote' },
  });

  it('keeps the earliest time, the remote status on a clash, the earliest seeds and the union of aliases', () => {
    const m = mergeSameVersion(local, remote);
    expect(m.colourSince).toEqual({ a: ['mastered', T + 10], b: ['new', T + 30], c: ['studying', T + 7], d: ['new', T + 1] });
    expect(m.seeds).toEqual({ n1: T + 3, n2: T + 9, n3: T + 2 });
    expect(m.aliases).toEqual({ old1: 'n1', old3: 'n3', clash: 'remote' });
    // source.app survives from either side; everything else comes from the remote.
    expect(m.source.app).toBe(true);
    expect(m.importedAt).toBe(remote.importedAt);
    expect(m.device).toBe('pc-1');
    expect(m.hash).toBe(remote.hash);
  });

  it('is idempotent, and the times do not depend on the order', () => {
    const m = mergeSameVersion(local, remote);
    expect(mergeSameVersion(m, remote)).toEqual(m);
    expect(mergeSameVersion(m, m)).toEqual(m);
    expect(vocabDiffers(mergeSameVersion(m, remote), m)).toBe(false);
    // Same statuses on both sides: the same times whichever side is the remote.
    const x = list({ colourSince: cs({ a: ['mastered', T + 4], b: ['new', T + 9] }), seeds: { n1: T + 4 } });
    const y = list({ colourSince: cs({ a: ['mastered', T + 6], b: ['new', T + 2] }), seeds: { n1: T + 1 } });
    expect(mergeSameVersion(x, y).colourSince).toEqual(mergeSameVersion(y, x).colourSince);
    expect(mergeSameVersion(x, y).seeds).toEqual(mergeSameVersion(y, x).seeds);
  });

  it('works with lists from older versions (no colour times, no aliases)', () => {
    const m = mergeSameVersion(list(), list({ colourSince: cs({ a: ['new', T] }) }));
    expect(m.colourSince).toEqual({ a: ['new', T] });
    expect(m.aliases).toBeUndefined();
    expect(mergeSameVersion(list(), list()).colourSince).toBeUndefined();
    expect(m.source.app).toBeUndefined();
  });

  it('keeps the OneDrive item when the remote came from the folder', () => {
    const m = mergeSameVersion(list({}, { drive: 'd1', item: 'i1' }), list({}, { modified: T - 5 }));
    expect(m.source).toMatchObject({ drive: 'd1', item: 'i1', modified: T - 5 });
  });
});

describe('vocabAction', () => {
  it('takes the remote when there is no list here', () => {
    expect(vocabAction(null, false, list())).toBe('take');
    expect(vocabAction(null, true, list({}, { qxh: undefined }))).toBe('take');
  });

  it('same content → merge, whatever the times and the dirty flag', () => {
    expect(vocabAction(list({ importedAt: T + 9 }), false, list())).toBe('merge');
    expect(vocabAction(list({ importedAt: T - 9 }), true, list())).toBe('merge');
  });

  it('other content: the remote when it is newer or equal, else take it and import again', () => {
    const older = list({}, { qxh: 'Q0', modified: T - 5000 });
    const newer = list({}, { qxh: 'Q2', modified: T + 5000 });
    const equal = list({}, { qxh: 'Q3' });
    expect(vocabAction(older, false, list())).toBe('take');
    expect(vocabAction(older, true, list())).toBe('take');
    expect(vocabAction(equal, true, list())).toBe('take');
    expect(vocabAction(newer, false, list())).toBe('take-reimport');
    expect(vocabAction(newer, true, list())).toBe('take-reimport');
  });

  it('either list without a content id → the newest import wins, a list changed here wins a tie', () => {
    const legacy = (importedAt: number) => list({ importedAt }, { qxh: undefined });
    expect(vocabAction(legacy(T), true, list())).toBe('keep');
    expect(vocabAction(legacy(T + 1), true, list())).toBe('keep');
    expect(vocabAction(legacy(T - 1), true, list())).toBe('take');
    expect(vocabAction(legacy(T + 1), false, list())).toBe('take');
    expect(vocabAction(list({ importedAt: T + 1 }), true, legacy(T))).toBe('keep');
    expect(vocabAction(list({ importedAt: T - 1 }), true, legacy(T))).toBe('take');
  });
});

describe('vocabDiffers', () => {
  it('sees the shared history, not key order', () => {
    const a = list({ colourSince: cs({ a: ['new', T], b: ['mastered', T] }), seeds: { x: 1, y: 2 } });
    const b = list({ colourSince: cs({ b: ['mastered', T], a: ['new', T] }), seeds: { y: 2, x: 1 } });
    expect(vocabDiffers(a, b)).toBe(false);
    expect(vocabDiffers(a, { ...b, seeds: { x: 0, y: 2 } })).toBe(true);
    expect(vocabDiffers(a, { ...b, source: { ...b.source, app: true } })).toBe(true);
    expect(vocabDiffers(a, { ...b, hash: 'h2' })).toBe(true);
  });
});
