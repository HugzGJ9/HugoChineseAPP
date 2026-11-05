import type { VocabFile } from '../types';

export interface ImportRequest {
  bytes: ArrayBuffer;
  source: VocabFile['source'];
  now: number;
  device: string;
  prevSeeds: Record<string, number>;
  dictUrl: string;
}

export type ImportResponse = { ok: true; vocab: VocabFile; french: boolean } | { ok: false; error: string };

export function dictUrl(): string {
  return new URL(`${import.meta.env.BASE_URL}dict/cfdict.tsv`, location.href).href;
}

/** Parse an .xlsx in a Web Worker and build the vocabulary file. */
export function importWorkbook(req: Omit<ImportRequest, 'dictUrl'>): Promise<VocabFile> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<ImportResponse>) => {
      worker.terminate();
      if (e.data.ok) resolve(e.data.vocab);
      else reject(new Error(e.data.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The Excel file could not be read'));
    };
    const full: ImportRequest = { ...req, dictUrl: dictUrl() };
    worker.postMessage(full, [req.bytes]);
  });
}
