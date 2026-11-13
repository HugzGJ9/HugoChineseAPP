// Runs patchWorkbookFills in a Web Worker (unzip, patch, re-zip of a ~12 MB sheet stays off the main thread). Used by the
// folder copy writer (folder.ts) and by the write-back into the workbook in OneDrive (workbook.ts).
import { WorkbookChangedError, type PatchRequest, type PatchResponse, type PatchResult } from './patch';

/** Patch the workbook in a Web Worker; the bytes are moved there and back (the caller's buffer is detached). */
export function patchInWorker(req: PatchRequest): Promise<PatchResult> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./patch.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent<PatchResponse>) => {
      worker.terminate();
      const d = e.data;
      if (d.ok) resolve(d.result);
      else reject(d.changed ? new WorkbookChangedError(d.changed.sheet, d.changed.row) : new Error(d.error));
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message || 'The workbook could not be patched'));
    };
    worker.postMessage(req, [req.bytes.buffer]);
  });
}
