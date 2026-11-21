// Grammar window (#/grammar, #/grammar/<note id>): every point of the 语法 sheet, titled in 中/FR/EN, grouped by family
// or HSK level; tapping one opens its page (formula, meaning, when to use, examples). Content comes from the 语法 sheet's
// extra columns (GRAM-1, plan .claude/plans/2026-11-21-grammar-content.md).
import { useMemo, useState } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { setNoteStatus, useApp } from '../../lib/store';
import { noteStatuses, sheetRows, STATUS_MARK } from '../../lib/status';
import { family as familyOf, hskLabel, REGISTER_LABEL } from '../../lib/grammar/families';
import { formulaParts, grammarItems, groupItems, itemSubtitle, itemTitle, matchItem, segmentSentence, vocabIndex, type GrammarItem } from '../../lib/grammar/list';
import { readTitleLang, saveTitleLang } from '../../lib/grammar/titleLang';
import type { GroupBy, TitleLang } from '../../lib/grammar/types';
import { AudioButton, Icon, Section, Segmented, TopBar } from '../common';
import { StatusIcon, StatusPicker } from '../StatusPicker';
import { WordPanel } from '../word/WordPanel';
import '../screens.css';
import './grammar.css';

const BASE = '#/grammar';
const href = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function GrammarPage({ id }: { id?: string }) {
  const { notes, marks, meta } = useApp((s) => s);
  const [lang, setLangState] = useState<TitleLang>(readTitleLang);
  const setLang = (l: TitleLang) => {
    setLangState(l);
    saveTitleLang(l);
  };
  const [q, setQ] = useState('');
  const [by, setBy] = useState<GroupBy>('family');
  const items = useMemo(() => grammarItems(notes), [notes]);
  const statuses = useMemo(() => noteStatuses(sheetRows(notes, marks, meta?.colourSince)), [notes, marks, meta]);
  const shown = useMemo(() => items.filter((i) => matchItem(i, q)), [items, q]);
  const groups = useMemo(() => groupItems(shown, by, lang), [shown, by, lang]);
  const selected = id ? items.find((i) => i.note.id === id) : undefined;
  const filled = items.filter((i) => i.note.grammar).length;

  return (
    <div className={`main wide gr${selected ? ' has-sel' : ''}`}>
      <TopBar title="Grammar">
        <Segmented
          label="Title language"
          value={lang}
          onChange={setLang}
          options={[
            { value: 'zh', label: '中' },
            { value: 'fr', label: 'FR' },
            { value: 'en', label: 'EN' },
          ]}
        />
      </TopBar>
      <div className="split wd">
        <div className="stack-l gr-list">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search 汉字, français or English" aria-label="Search grammar" />
          <Segmented
            label="Group by"
            className="gr-by"
            value={by}
            onChange={setBy}
            options={[
              { value: 'family', label: 'Family' },
              { value: 'hsk', label: 'HSK' },
              { value: 'excel', label: 'Excel order' },
            ]}
          />
          {items.length > 0 && filled === 0 && (
            <p className="notice small">
              Families, levels, short titles and examples come from extra columns of your 语法 sheet (HSK, Family, Title EN, Title FR…). Add them in
              Excel to fill this page.
            </p>
          )}
          {groups.map((g) => (
            <Section key={g.key} title={`${g.title} · ${g.items.length}`}>
              {g.items.map((it) => (
                <GrammarRow key={it.note.id} item={it} lang={lang} status={statuses.get(it.note.id) ?? 'new'} by={by} sel={it.note.id === id} />
              ))}
            </Section>
          ))}
          {items.length === 0 && <p className="muted wd-empty">No grammar yet. Points come from the 语法 sheet of your Excel file.</p>}
          {items.length > 0 && shown.length === 0 && <p className="muted wd-empty">No matches.</p>}
        </div>
        <div className="detail">
          {selected ? (
            <GrammarDetail key={selected.note.id} item={selected} items={items} lang={lang} statuses={statuses} />
          ) : (
            <p className="muted wd-empty gr-pick">Pick a grammar point.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function GrammarRow({ item, lang, status, by, sel }: { item: GrammarItem; lang: TitleLang; status: WordStatus; by: GroupBy; sel: boolean }) {
  const title = itemTitle(item, lang);
  const fam = familyOf(item.family);
  return (
    <a className={`cell tap gr-row${sel ? ' sel' : ''}`} href={href(item.note.id)} aria-current={sel ? 'true' : undefined}>
      <span className={`st-${status} gr-st`}>
        <StatusIcon status={status} />
      </span>
      <span className="cell-body">
        <span className={`gr-title${lang === 'zh' ? ' zh' : ''}`}>
          {title.text}
          {title.fallback && lang === 'fr' && <span className="tag">EN</span>}
        </span>
        <span className={`gr-sub${lang !== 'zh' ? ' zh' : ''}`}>{itemSubtitle(item, lang)}</span>
      </span>
      <span className="gr-tags">
        {by !== 'hsk' && item.hsk && <span className="tag">{hskLabel(item.hsk)}</span>}
        {by !== 'family' && fam && <span className="tag">{lang === 'fr' ? fam.fr : fam.en}</span>}
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

function GrammarDetail({ item, items, lang, statuses }: { item: GrammarItem; items: GrammarItem[]; lang: TitleLang; statuses: Map<string, WordStatus> }) {
  const { note, info } = item;
  const notes = useApp((s) => s.notes);
  const index = useMemo(() => vocabIndex(notes), [notes]);
  const [open, setOpen] = useState<Note | null>(null);
  // Reading language for bullets and translations: French unless the switch says English.
  const rl: 'fr' | 'en' = lang === 'en' ? 'en' : 'fr';
  const other: 'fr' | 'en' = rl === 'fr' ? 'en' : 'fr';
  const titles = [info.title?.[rl], info.title?.[other]].filter((t): t is string => !!t);
  const defs = (
    [
      [rl, info.def?.[rl]],
      [other, info.def?.[other]],
    ] as const
  ).filter((d): d is readonly ['fr' | 'en', string] => !!d[1]);
  const use = info.use?.[rl]?.length ? info.use[rl]! : (info.use?.[other] ?? []);
  const fam = familyOf(item.family);
  const sameFamily = item.family ? items.filter((i) => i.family === item.family && i.note.id !== note.id) : [];
  const skip = [note.hanzi, ...note.alts].join('');
  const examples = [
    ...note.examples.map((e) => ({ zh: e.zh, pinyin: e.pinyin, tr: e.en, excel: true })),
    ...(info.sentences ?? [])
      .filter((s) => !note.examples.some((e) => e.zh.replace(/[。.]$/, '') === s.zh.replace(/[。.]$/, '')))
      .map((s) => ({ zh: s.zh, pinyin: s.pinyin, tr: s[rl] || s[other], excel: false })),
  ];
  const status = statuses.get(note.id) ?? 'new';

  return (
    <div className="stack-l wd-detail gr-detail">
      <a className="gr-back" href={BASE}>
        <Icon name="back" />
        <span>All grammar</span>
      </a>

      <div className="panel stack">
        <Formula pattern={note.hanzi} />
        <p className="gr-head">{titles[0] ?? note.en}</p>
        {titles[1] && <p className="small muted">{titles[1]}</p>}
        {(item.hsk || fam || info.register) && (
          <div className="row wrap gr-labels">
            {item.hsk && <span className="tag">{hskLabel(item.hsk)}</span>}
            {fam && <span className="tag">{rl === 'fr' ? fam.fr : fam.en}</span>}
            {info.register && <span className="tag">{REGISTER_LABEL[info.register][rl]}</span>}
          </div>
        )}
      </div>

      <Section title={rl === 'fr' ? 'Sens' : 'Meaning'}>
        <div className="cell cell-pad stack gr-meaning">
          {defs.length ? (
            defs.map(([l, t]) => (
              <p key={l}>
                <span className="tag">{l.toUpperCase()}</span> {t}
              </p>
            ))
          ) : (
            <p>{note.en}</p>
          )}
          {use.length > 0 && (
            <>
              <h3 className="gr-h">{rl === 'fr' ? 'Quand l’utiliser' : 'When to use'}</h3>
              <ul className="gr-use">
                {use.map((u, i) => (
                  <li key={i}>{u}</li>
                ))}
              </ul>
            </>
          )}
        </div>
      </Section>

      <Section
        title={rl === 'fr' ? 'Exemples' : 'Examples'}
        footer={examples.length ? (rl === 'fr' ? 'Soulignés : tes mots, dans la couleur de leur statut. Touche un mot pour l’ouvrir.' : 'Underlined: your words, in their status colour. Tap one to open it.') : undefined}
      >
        {examples.map((e, i) => (
          <div key={i} className="cell cell-pad gr-ex">
            <div className="cell-body">
              <span className="zh gr-ex-zh" lang="zh-CN">
                {segmentSentence(e.zh, index, skip).map((s, j) =>
                  s.note ? (
                    <button key={j} type="button" className={`gr-w st-${statuses.get(s.note) ?? 'new'}`} onClick={() => setOpen(notes.find((n) => n.id === s.note) ?? null)}>
                      {s.s}
                    </button>
                  ) : (
                    <span key={j}>{s.s}</span>
                  ),
                )}
                {e.excel && <span className="tag gr-ex-tag">Excel</span>}
              </span>
              {e.pinyin && <span className="small muted">{e.pinyin}</span>}
              {e.tr && <span className="small">{e.tr}</span>}
            </div>
            <AudioButton text={e.zh} label="Play sentence" />
          </div>
        ))}
        {examples.length === 0 && <div className="cell cell-pad muted">No example yet: add a Sentences column to your 语法 sheet.</div>}
      </Section>

      {sameFamily.length > 0 && fam && (
        <Section title={`${rl === 'fr' ? 'Même famille' : 'Same family'} · ${rl === 'fr' ? fam.fr : fam.en}`}>
          {sameFamily.map((i) => (
            <a key={i.note.id} className="cell tap" href={href(i.note.id)}>
              <span className="cell-body">
                <span className="zh">{i.note.hanzi}</span>
                <span className="small muted">{itemTitle(i, rl).text}</span>
              </span>
              <Icon name="chevron" className="cell-chev" />
            </a>
          ))}
        </Section>
      )}

      <div className="panel stack">
        <h3 className="gr-h">{rl === 'fr' ? 'Ton statut' : 'Your status'}</h3>
        <StatusPicker value={status} onChange={(st) => void setNoteStatus(note.id, STATUS_MARK[st])} />
      </div>

      {open && (
        <WordPanel
          key={open.id}
          note={open}
          status={statuses.get(open.id) ?? 'new'}
          onStatus={(st) => void setNoteStatus(open.id, STATUS_MARK[st])}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}
