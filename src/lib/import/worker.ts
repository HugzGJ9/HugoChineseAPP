/// <reference lib="webworker" />
// Parses the workbook off the main thread: unzip, read cells and fills, build notes, look up French.
import { pinyin } from 'pinyin-pro';
import { readWorkbook } from '../xlsx/read';
import { buildVocab } from './build';
import { lookupFr, parseCfdict, type FrDict } from '../french';
import type { ImportRequest, ImportResponse } from './index';

let dict: FrDict | null = null;

async function loadDict(url: string): Promise<FrDict | null> {
  if (dict) return dict;
  try {
    const res = await fetch(url);
    if (res.ok) dict = parseCfdict(await res.text());
  } catch {
    // offline and not cached yet: French falls back to English
  }
  return dict;
}

const pinyinOf = (h: string) => pinyin(h, { toneType: 'num', type: 'array', v: true, nonZh: 'removed' }) as string[];

self.onmessage = async (e: MessageEvent<ImportRequest>) => {
  const req = e.data;
  try {
    const d = await loadDict(req.dictUrl);
    const sheets = readWorkbook(req.bytes);
    const vocab = buildVocab(sheets, {
      source: req.source,
      now: req.now,
      device: req.device,
      prevSeeds: req.prevSeeds,
      pinyinOf,
      readingsOf: d ? (h) => (d.get(h) ?? []).map((x) => x.p) : undefined,
      french: d ? (h, p) => lookupFr(d, h, p) : undefined,
    });
    const msg: ImportResponse = { ok: true, vocab, french: !!d };
    (self as unknown as Worker).postMessage(msg);
  } catch (err) {
    const msg: ImportResponse = { ok: false, error: err instanceof Error ? err.message : String(err) };
    (self as unknown as Worker).postMessage(msg);
  }
};
