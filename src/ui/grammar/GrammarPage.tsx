// Grammar window (#/grammar, #/grammar/<note id>): every point of the 语法 sheet in Excel order, pattern first and its
// short title in the app's reading language (EN | FR, GRAM-2), narrowed by search and tick-box filters (HSK, family,
// status). A point's page: formula, meaning, when to use, examples where any word can be tapped, status, previous/next.
// Content comes from the 语法 sheet's extra columns (GRAM-1); plan .claude/plans/2026-11-22-grammar-v3.md.
import { useMemo, useState } from 'react';
import type { WordStatus } from '../../lib/types';
import { setNoteStatus, useApp } from '../../lib/store';
import { noteStatuses, sheetRows, STATUS_LABEL, STATUS_MARK, WORD_STATUSES } from '../../lib/status';
import { family as familyOf, FAMILIES, hskLabel, HSK_LEVELS, REGISTER_LABEL } from '../../lib/grammar/families';
import { activeCount, applyFilter, filterCounts, neighbours, NO_FILTER, readFilter, saveFilter, toggle, type FilterGroup, type GrammarFilter } from '../../lib/grammar/filters';
import { formulaParts, grammarItems, itemTitle, matchItem, patternChars, pick, pickList, sentenceTokens, vocabIndex, type GrammarItem } from '../../lib/grammar/list';
import type { ReadLang } from '../../lib/grammar/types';
import { AudioButton, Icon, LangSwitch, Section, TopBar } from '../common';
import { Sheet } from '../panel';
import { StatusIcon, StatusPicker } from '../StatusPicker';
import { SentenceWord } from '../word/SentenceWord';
import '../screens.css';
import './grammar.css';

const BASE = '#/grammar';
const href = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

/** Small tag naming the language shown when the reading language is missing. */
const Fallback = ({ lang }: { lang?: ReadLang }) => (lang ? <span className="tag gr-fb">{lang.toUpperCase()}</span> : null);

export function GrammarPage({ id }: { id?: string }) {
  const { notes, marks, meta, lang } = useApp((s) => s);
  const [q, setQ] = useState('');
  const [filter, setFilterState] = useState<GrammarFilter>(readFilter);
  const setFilter = (f: GrammarFilter) => {
    setFilterState(f);
    saveFilter(f);
  };
  const [panel, setPanel] = useState(false);
  const items = useMemo(() => grammarItems(notes), [notes]);
  const statuses = useMemo(() => noteStatuses(sheetRows(notes, marks, meta?.colourSince)), [notes, marks, meta]);
  const searched = useMemo(() => items.filter((i) => matchItem(i, q)), [items, q]);
  const shown = useMemo(() => applyFilter(searched, filter, statuses), [searched, filter, statuses]);
  const selected = id ? items.find((i) => i.note.id === id) : undefined;
  const filled = items.filter((i) => i.note.grammar).length;
  const active = activeCount(filter);

  return (
    <div className={`main wide gr${selected ? ' has-sel' : ''}`}>
      <TopBar title="Grammar">
        <LangSwitch />
      </TopBar>
      <div className="split wd">
        <div className="stack-l gr-list">
          <div className="gr-searchbar">
            <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 汉字, français or English" aria-label="Search grammar" />
            <button type="button" className={`chip gr-filter-btn${active ? ' on' : ''}`} aria-pressed={active > 0} onClick={() => setPanel(true)}>
              <Icon name="filter" />
              Filter{active > 0 && <span className="gr-badge">{active}</span>}
            </button>
          </div>
          {active > 0 && <ActiveChips filter={filter} lang={lang} onChange={setFilter} shown={shown.length} total={searched.length} />}
          {items.length > 0 && filled === 0 && (
            <p className="notice small">
              Levels, families, short titles and examples come from extra columns of your 语法 sheet (HSK, Family, Title EN, Title FR…). Add them in
              Excel to fill this page.
            </p>
          )}
          {shown.length > 0 && (
            <Section>
              {shown.map((it) => (
                <GrammarRow key={it.note.id} item={it} lang={lang} status={statuses.get(it.note.id) ?? 'new'} sel={it.note.id === id} />
              ))}
            </Section>
          )}
          {items.length === 0 && <p className="muted wd-empty">No grammar yet. Points come from the 语法 sheet of your Excel file.</p>}
          {items.length > 0 && shown.length === 0 && (
            <p className="muted wd-empty">
              No matches.{' '}
              {active > 0 && (
                <button type="button" className="btn small plain" onClick={() => setFilter({ ...NO_FILTER })}>
                  Clear filters
                </button>
              )}
            </p>
          )}
        </div>
        <div className="detail">
          {selected ? (
            <GrammarDetail key={selected.note.id} item={selected} shown={shown} lang={lang} statuses={statuses} />
          ) : (
            <p className="muted wd-empty gr-pick">Pick a grammar point.</p>
          )}
        </div>
      </div>
      {panel && <FilterSheet items={searched} filter={filter} statuses={statuses} lang={lang} onChange={setFilter} onClose={() => setPanel(false)} />}
    </div>
  );
}

function familyName(id: GrammarFilter['family'][number], lang: ReadLang): string {
  if (id === 'none') return lang === 'fr' ? 'Sans famille' : 'No family';
  const f = familyOf(id);
  return f ? f[lang] : id;
}
const levelName = (h: GrammarFilter['hsk'][number], lang: ReadLang) => (h === 'none' ? (lang === 'fr' ? 'Sans niveau' : 'No level') : hskLabel(h));

function ActiveChips({ filter, lang, onChange, shown, total }: { filter: GrammarFilter; lang: ReadLang; onChange: (f: GrammarFilter) => void; shown: number; total: number }) {
  const chips: { key: string; label: string; off: () => GrammarFilter }[] = [
    ...filter.hsk.map((h) => ({ key: `h${h}`, label: levelName(h, lang), off: () => toggle(filter, 'hsk', h) })),
    ...filter.family.map((f) => ({ key: `f${f}`, label: familyName(f, lang), off: () => toggle(filter, 'family', f) })),
    ...filter.status.map((s) => ({ key: `s${s}`, label: STATUS_LABEL[s], off: () => toggle(filter, 'status', s) })),
  ];
  return (
    <div className="gr-active" aria-label="Active filters">
      {chips.map((c) => (
        <button key={c.key} type="button" className="chip gr-chip" aria-label={`Remove filter ${c.label}`} onClick={() => onChange(c.off())}>
          {c.label}
          <Icon name="close" />
        </button>
      ))}
      <span className="gr-count">
        {shown} of {total}
      </span>
      <button type="button" className="btn small plain" onClick={() => onChange({ ...NO_FILTER })}>
        Clear
      </button>
    </div>
  );
}

function FilterSheet({
  items, filter, statuses, lang, onChange, onClose,
}: {
  items: GrammarItem[]; filter: GrammarFilter; statuses: Map<string, WordStatus>; lang: ReadLang; onChange: (f: GrammarFilter) => void; onClose: () => void;
}) {
  const counts = useMemo(() => filterCounts(items, filter, statuses), [items, filter, statuses]);
  const shown = useMemo(() => applyFilter(items, filter, statuses).length, [items, filter, statuses]);
  const all = useMemo(() => filterCounts(items, NO_FILTER, statuses), [items, statuses]);
  // Only boxes that exist in his sheet; 'none' only when some point lacks the label.
  const hsk = [...HSK_LEVELS, 'none' as const].filter((h) => all.hsk.has(h));
  const fams = [...FAMILIES.map((f) => f.id), 'none' as const].filter((f) => all.family.has(f));
  const box = <G extends FilterGroup>(group: G, value: GrammarFilter[G][number], label: React.ReactNode, lead?: React.ReactNode) => {
    const on = (filter[group] as unknown[]).includes(value);
    const n = counts[group].get(value as string | number) ?? 0;
    return (
      <label key={String(value)} className={`cell tap gr-box${on ? ' on' : ''}${!n && !on ? ' empty' : ''}`}>
        <input type="checkbox" checked={on} onChange={() => onChange(toggle(filter, group, value))} />
        {lead}
        <span className="cell-body">{label}</span>
        <span className="gr-box-n">{n}</span>
        <span className="gr-tick" aria-hidden="true">
          {on && <Icon name="check" />}
        </span>
      </label>
    );
  };
  return (
    <Sheet className="gr-fs" label="Filter grammar" title="Filter" onClose={onClose} size="content">
      <div className="gr-fs-body">
        {hsk.length > 0 && <Section title="HSK level">{hsk.map((h) => box('hsk', h, levelName(h, lang)))}</Section>}
        {fams.length > 0 && <Section title={lang === 'fr' ? 'Famille' : 'Family'}>{fams.map((f) => box('family', f, familyName(f, lang)))}</Section>}
        <Section title="My status">
          {WORD_STATUSES.map((s) =>
            box(
              'status',
              s,
              STATUS_LABEL[s],
              <span className={`st-${s} gr-st`}>
                <StatusIcon status={s} />
              </span>,
            ),
          )}
        </Section>
      </div>
      <div className="gr-fs-foot">
        <button type="button" className="btn plain" disabled={!activeCount(filter)} onClick={() => onChange({ ...NO_FILTER })}>
          Clear
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          Show {shown} {shown === 1 ? 'point' : 'points'}
        </button>
      </div>
    </Sheet>
  );
}

function GrammarRow({ item, lang, status, sel }: { item: GrammarItem; lang: ReadLang; status: WordStatus; sel: boolean }) {
  const title = itemTitle(item, lang);
  const fam = familyOf(item.family);
  return (
    <a className={`cell tap gr-row${sel ? ' sel' : ''}`} href={href(item.note.id)} aria-current={sel ? 'true' : undefined}>
      <span className={`st-${status} gr-st`}>
        <StatusIcon status={status} />
      </span>
      <span className="cell-body">
        <span className="gr-title zh" lang="zh-CN">
          {item.note.hanzi}
        </span>
        {title.text && (
          <span className="gr-sub">
            {title.text}
            <Fallback lang={title.fallback} />
          </span>
        )}
      </span>
      <span className="gr-tags">
        {item.hsk && <span className="tag">{hskLabel(item.hsk)}</span>}
        {fam && <span className="tag">{fam[lang]}</span>}
      </span>
      <Icon name="chevron" className="cell-chev" />
    </a>
  );
}

/** The pattern with its slots boxed: fixed words in ink, slots outlined (no status or tone colour, UI-1). */
export function Formula({ pattern, className = '' }: { pattern: string; className?: string }) {
  return (
    <p className={`gr-formula ${className}`} aria-label={pattern}>
      {formulaParts(pattern).map((p, i) =>
        p.t === 'fixed' ? (
          <span key={i} className="gf-fixed zh">
            {p.s}
          </span>
        ) : p.t === 'slot' ? (
          <span key={i} className="gf-slot">
            {p.s}
          </span>
        ) : (
          <span key={i} className="gf-gap">
            …
          </span>
        ),
      )}
    </p>
  );
}

const T = {
  meaning: { en: 'Meaning', fr: 'Sens' },
  use: { en: 'When to use', fr: 'Quand l’utiliser' },
  examples: { en: 'Examples', fr: 'Exemples' },
  status: { en: 'Your status', fr: 'Ton statut' },
  show: { en: 'Show translation', fr: 'Voir la traduction' },
  showAll: { en: 'Show all', fr: 'Tout afficher' },
  hideAll: { en: 'Hide all', fr: 'Tout masquer' },
  exFoot: {
    en: 'Tap any word to look it up. Underlined: your words, in their status colour. Bold: the pattern.',
    fr: 'Touche un mot pour l’ouvrir. Soulignés : tes mots, dans la couleur de leur statut. En gras : la structure.',
  },
  noEx: { en: 'No example yet: add a Sentences column to your 语法 sheet.', fr: 'Pas encore d’exemple : ajoute une colonne Sentences à ta feuille 语法.' },
  prev: { en: 'Previous', fr: 'Précédent' },
  next: { en: 'Next', fr: 'Suivant' },
};

function GrammarDetail({ item, shown, lang, statuses }: { item: GrammarItem; shown: GrammarItem[]; lang: ReadLang; statuses: Map<string, WordStatus> }) {
  const { note, info } = item;
  const notes = useApp((s) => s.notes);
  const index = useMemo(() => vocabIndex(notes), [notes]);
  const pattern = useMemo(() => patternChars(note), [note]);
  const [tap, setTap] = useState<{ zh: string; start: number; length: number } | null>(null);
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const title = itemTitle(item, lang);
  const def = pick(info.def, lang);
  const use = pickList(info.use, lang);
  const fam = familyOf(item.family);
  const examples = [
    ...note.examples.map((e) => ({ zh: e.zh, pinyin: e.pinyin, tr: pick({ en: e.en }, lang), excel: true })),
    ...(info.sentences ?? [])
      .filter((s) => !note.examples.some((e) => e.zh.replace(/[。.]$/, '') === s.zh.replace(/[。.]$/, '')))
      .map((s) => ({ zh: s.zh, pinyin: s.pinyin, tr: pick({ en: s.en, fr: s.fr }, lang), excel: false })),
  ];
  const allShown = examples.length > 0 && examples.every((_, i) => revealed.has(i));
  const status = statuses.get(note.id) ?? 'new';
  const { prev, next } = neighbours(shown, note.id);

  return (
    <div className="stack-l wd-detail gr-detail">
      <a className="gr-back" href={BASE}>
        <Icon name="back" />
        <span>All grammar</span>
      </a>

      <div className="panel stack">
        <Formula pattern={note.hanzi} />
        {title.text && (
          <p className="gr-head">
            {title.text}
            <Fallback lang={title.fallback} />
          </p>
        )}
        {(item.hsk || fam || info.register) && (
          <div className="row wrap gr-labels">
            {item.hsk && <span className="tag">{hskLabel(item.hsk)}</span>}
            {fam && <span className="tag">{fam[lang]}</span>}
            {info.register && <span className="tag">{REGISTER_LABEL[info.register][lang]}</span>}
          </div>
        )}
      </div>

      <Section title={T.meaning[lang]}>
        <div className="cell cell-pad stack gr-meaning">
          {def ? (
            <p>
              {def.text}
              <Fallback lang={def.fallback} />
            </p>
          ) : (
            <p>{title.text || note.en}</p>
          )}
          {use.items.length > 0 && (
            <>
              <h3 className="gr-h">
                {T.use[lang]}
                <Fallback lang={use.fallback} />
              </h3>
              <ul className="gr-use">
                {use.items.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Section>

      <Section
        title={
          <span className="gr-ex-h">
            <span>{T.examples[lang]}</span>
            {examples.length > 0 && (
              <button
                type="button"
                className="btn small plain gr-reveal-all"
                onClick={() => setRevealed(allShown ? new Set() : new Set(examples.map((_, i) => i)))}
              >
                {allShown ? T.hideAll[lang] : T.showAll[lang]}
              </button>
            )}
          </span>
        }
        footer={examples.length ? T.exFoot[lang] : undefined}
      >
        {examples.map((e, i) => {
          const open = revealed.has(i);
          return (
            <div key={i} className="cell cell-pad gr-ex">
              <div className="cell-body">
                <span className="zh gr-ex-zh" lang="zh-CN">
                  {sentenceTokens(e.zh, index, pattern).map((t, j) =>
                    t.word ? (
                      <button
                        key={j}
                        type="button"
                        className={`gr-w${t.note ? ` mine st-${statuses.get(t.note) ?? 'new'}` : ''}${t.pattern ? ' pat' : ''}`}
                        onClick={() => setTap({ zh: e.zh, start: t.start, length: [...t.s].length })}
                      >
                        {t.s}
                      </button>
                    ) : (
                      <span key={j}>{t.s}</span>
                    ),
                  )}
                  {e.excel && <span className="tag gr-ex-tag">Excel</span>}
                </span>
                {open ? (
                  <button type="button" className="gr-tr" onClick={() => setRevealed(new Set([...revealed].filter((x) => x !== i)))}>
                    {e.pinyin && <span className="small muted">{e.pinyin}</span>}
                    {e.tr && (
                      <span className="small">
                        {e.tr.text}
                        <Fallback lang={e.tr.fallback} />
                      </span>
                    )}
                  </button>
                ) : (
                  <button type="button" className="btn small plain gr-show" onClick={() => setRevealed(new Set([...revealed, i]))}>
                    {T.show[lang]}
                  </button>
                )}
              </div>
              <AudioButton text={e.zh} label="Play sentence" />
            </div>
          );
        })}
        {examples.length === 0 && <div className="cell cell-pad muted">{T.noEx[lang]}</div>}
      </Section>

      <div className="panel stack">
        <h3 className="gr-h">{T.status[lang]}</h3>
        <StatusPicker value={status} onChange={(st) => void setNoteStatus(note.id, STATUS_MARK[st])} />
      </div>

      {(prev || next) && (
        <nav className="gr-nav" aria-label="Previous and next point">
          {prev ? (
            <a className="gr-nav-a prev" href={href(prev.note.id)}>
              <Icon name="back" />
              <span>
                <span className="gr-nav-l">{T.prev[lang]}</span>
                <span className="zh">{prev.note.hanzi}</span>
              </span>
            </a>
          ) : (
            <span />
          )}
          {next && (
            <a className="gr-nav-a next" href={href(next.note.id)}>
              <span>
                <span className="gr-nav-l">{T.next[lang]}</span>
                <span className="zh">{next.note.hanzi}</span>
              </span>
              <Icon name="chevron" />
            </a>
          )}
        </nav>
      )}

      {tap && <SentenceWord key={`${tap.zh}:${tap.start}`} {...tap} onClose={() => setTap(null)} />}
    </div>
  );
}
