/// <reference lib="webworker" />
// Builds the workbook copy off the main thread (unzip, patch, re-zip of a ~12 MB sheet).
import { patchWorkbookFills, WorkbookChangedError, type PatchRequest, type PatchResponse } from './patch';

self.onmessage = (e: MessageEvent<PatchRequest>) => {
  let msg: PatchResponse;
  try {
    const result = patchWorkbookFills(e.data);
    msg = { ok: true, result };
    (self as unknown as Worker).postMessage(msg, [result.bytes.buffer]);
    return;
  } catch (err) {
    msg = {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      ...(err instanceof WorkbookChangedError ? { changed: { sheet: err.sheet, row: err.row } } : {}),
    };
  }
  (self as unknown as Worker).postMessage(msg);
};
