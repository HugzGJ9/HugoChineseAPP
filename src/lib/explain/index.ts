// "Explain more": Claude's explanation of a word, asked with Hugo's own key, saved per (word, language) and synced.
import { claudeKeyHint, ClaudeError, deleteClaudeKey, EXPLAIN_MODEL, getClaudeKey, saveClaudeKey, testClaudeKey } from './claude';
import { emitExplainChange } from './cache';

export type { Explanation, ExplainEntry, StoredEntry as SavedExplanation, ClaudeErrorKind } from './types';
export { ClaudeError, EXPLAIN_MODEL, claudeKeyHint, testClaudeKey };
export {
  clearExplainDirty,
  dirtyExplainMonths,
  explainJob,
  explainUsage,
  getExplanation,
  mergeExplanations,
  onExplainChange,
  ownExplanations,
  requestExplanation,
  PRICES,
} from './cache';
export { normalizeExplanation, PROMPT_VERSION } from './prompt';

export async function hasClaudeKey(): Promise<boolean> {
  return (await getClaudeKey()) != null;
}

/** Save the key on this device only (Settings tests it first with testClaudeKey). */
export async function setClaudeKey(key: string): Promise<void> {
  await saveClaudeKey(key);
  emitExplainChange();
}

export async function removeClaudeKey(): Promise<void> {
  await deleteClaudeKey();
  emitExplainChange();
}
