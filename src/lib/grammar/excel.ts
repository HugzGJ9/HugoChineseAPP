// Reads the extra columns of the 语法 sheet into Note.grammar. Pure; called by import/build.ts for grammar rows.
import { parseFamily, parseHsk, parseRegister } from './families';
import type { GrammarInfo, GrammarSentence } from './types';

/** The extra columns, by field. Header names are matched exactly after lower-casing (see ALIASES in build.ts). */
export type GrammarField = 'gHsk' | 'gFamily' | 'gTitleEn' | 'gTitleFr' | 'gDefEn' | 'gDefFr' | 'gUseEn' | 'gUseFr' | 'gRegister' | 'gSentences';

/** Header names. Kept apart from the general aliases: "Meaning FR" or "Examples" would be taken by other fields. */
export const GRAMMAR_ALIASES: Record<GrammarField, string[]> = {
  gHsk: ['hsk', 'hsk level', 'niveau hsk'],
  gFamily: ['family', 'famille'],
  gTitleEn: ['title en', 'titre en'],
  gTitleFr: ['title fr', 'titre fr'],
  gDefEn: ['definition en', 'définition en'],
  gDefFr: ['definition fr', 'définition fr'],
  gUseEn: ['use en', 'usage en'],
  gUseFr: ['use fr', 'usage fr'],
  gRegister: ['register', 'registre'],
  gSentences: ['sentences', 'phrases'],
};

export interface GrammarProblem {
  field: GrammarField;
  problem: string;
}

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((l) => l.replace(/^[\s•·\-*]+/, '').trim())
    .filter(Boolean);

/** "中文 | français | English" lines → sentences. A line without "|" is Chinese only. */
export function parseSentences(raw: string, pinyinOf?: (zh: string) => string): GrammarSentence[] {
  return lines(raw)
    .map((l) => l.split(/\s*[|｜]\s*/))
    .filter((p) => p[0])
    .map(([zh, fr, en]) => {
      const s: GrammarSentence = { zh };
      const py = pinyinOf?.(zh);
      if (py) s.pinyin = py;
      if (fr) s.fr = fr;
      if (en) s.en = en;
      return s;
    });
}

/** Cell texts by field → GrammarInfo (undefined when every cell is empty) and the problems worth reporting. */
export function grammarFromCells(
  cell: (f: GrammarField) => string,
  pinyinOf?: (zh: string) => string,
): { info?: GrammarInfo; problems: GrammarProblem[] } {
  const problems: GrammarProblem[] = [];
  const info: GrammarInfo = {};
  const t = (f: GrammarField) => cell(f).trim();

  if (t('gHsk')) {
    const h = parseHsk(t('gHsk'));
    if (h) info.hsk = h;
    else problems.push({ field: 'gHsk', problem: `HSK level "${t('gHsk')}" not understood (use 1–6, or 7 for 7–9)` });
  }
  if (t('gFamily')) {
    const f = parseFamily(t('gFamily'));
    if (f) info.family = f;
    else problems.push({ field: 'gFamily', problem: `Unknown family "${t('gFamily')}"` });
  }
  if (t('gRegister')) {
    const r = parseRegister(t('gRegister'));
    if (r) info.register = r;
    else problems.push({ field: 'gRegister', problem: `Unknown register "${t('gRegister')}" (spoken, neutral, formal or written)` });
  }
  const pair = (en: GrammarField, fr: GrammarField) => {
    const o: { en?: string; fr?: string } = {};
    if (t(en)) o.en = t(en);
    if (t(fr)) o.fr = t(fr);
    return o.en || o.fr ? o : undefined;
  };
  const title = pair('gTitleEn', 'gTitleFr');
  if (title) info.title = title;
  const def = pair('gDefEn', 'gDefFr');
  if (def) info.def = def;
  const useEn = lines(cell('gUseEn'));
  const useFr = lines(cell('gUseFr'));
  if (useEn.length || useFr.length) info.use = { ...(useEn.length ? { en: useEn } : {}), ...(useFr.length ? { fr: useFr } : {}) };
  const sentences = parseSentences(cell('gSentences'), pinyinOf);
  if (sentences.length) info.sentences = sentences;

  return { info: Object.keys(info).length ? info : undefined, problems };
}
