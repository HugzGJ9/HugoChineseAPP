// Getting the Excel file into the app: a file picked by hand (iPhone Files app, any computer).
// The OneDrive folder link and GitHub sync build on importBytes.
import { importWorkbook } from './import';
import { getState, setVocab } from './store';
import type { VocabFile } from './types';

export async function importBytes(bytes: ArrayBuffer, source: VocabFile['source']): Promise<VocabFile> {
  const s = getState();
  const vocab = await importWorkbook({ bytes, source, now: Date.now(), device: s.device, prevSeeds: s.meta?.seeds ?? {} });
  await setVocab(vocab);
  return vocab;
}

export async function importFile(file: File): Promise<VocabFile> {
  const bytes = await file.arrayBuffer();
  return importBytes(bytes, { name: file.name, modified: file.lastModified, size: file.size });
}

export function summary(v: VocabFile): string {
  const fixes = v.issues.filter((i) => i.level === 'fix').length;
  const studied = v.notes.filter((n) => n.studied).length;
  return `${v.notes.length} notes imported, ${studied} already studied${fixes ? `, ${fixes} cells to fix` : ''}`;
}
