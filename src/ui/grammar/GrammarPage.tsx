// Grammar window (#/grammar, #/grammar/<note id>): every point of the 语法 sheet, titled in 中/FR/EN, grouped by family
// or HSK level; tapping one opens its lesson. Plan: .claude/plans/2026-11-20-grammar-window.md.
// Skeleton: labels and lessons are in memory only (lib/grammar/store.ts); "Explain more" (existing) already works.
import { useMemo, useState } from 'react';
import type { WordStatus } from '../../lib/types';
import { setNoteStatus, useApp } from '../../lib/store';
import { noteStatuses, sheetRows, STATUS_MARK } from '../../lib/status';
import { family as familyOf, FAMILIES, hskLabel, HSK_LEVELS } from '../../lib/grammar/families';
import { formulaParts, grammarItems, groupItems, itemSubtitle, itemTitle, matchItem, type GrammarItem } from '../../lib/grammar/list';
import { LESSONS_READY, readTitleLang, saveTitleLang, setLabel, useGrammar } from '../../lib/grammar/store';
import type { FamilyId, GroupBy, HskLevel, TitleLang } from '../../lib/grammar/types';
import { AudioButton, Icon, Section, Segmented, TopBar } from '../common';
import { StatusIcon, StatusPicker } from '../StatusPicker';
import { ExplainView } from '../word/ExplainView';
import '../screens.css';
import './grammar.css';

const BASE = '#/grammar';
const href = (id: string) => `${BASE}/${encodeURIComponent(id)}`;

export function GrammarPage({ id }: { id?: string }) {
  const { notes, marks, meta } = useApp((s) => s);
  const { labels, lessons } = useGrammar();
  const [lang, setLangState] = useState<TitleLang>(readTitleLang);
  const setLang = (l: TitleLang) => {
    setLangState(l);
    saveTitleLang(l);
  };
  const [q, setQ] = useState('');
  const [by, setBy] = useState<GroupBy>('family');
  const items = useMemo(() => grammarItems(notes, labels, lessons), [notes, labels, lessons]);
  const statuses = useMemo(() => noteStatuses(sheetRows(notes.filter((n) => n.kind === 'grammar'), marks, meta?.colourSince)), [notes, marks, meta]);
  const shown = useMemo(() => items.filter((i) => matchItem(i, q)), [items, q]);
  const groups = useMemo(() => groupItems(shown, by, lang), [shown, by, lang]);
  const selected = id ? items.find((i) => i.note.id === id) : undefined;

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
          <p className="small muted" aria-live="polite">
            {shown.length === items.length ? `${items.length} points` : `${shown.length} of ${items.length} points`}
          </p>
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
            <GrammarDetail key={selected.note.id} item={selected} items={items} lang={lang} status={statuses.get(selected.note.id) ?? 'new'} />
          ) : (
            <p className="muted wd-empty gr-pick">Pick a grammar point to see its lesson.</p>
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
      <span className={`st-${status} gr-st`} title={status}>
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

function GrammarDetail({ item, items, lang, status }: { item: GrammarItem; items: GrammarItem[]; lang: TitleLang; status: WordStatus }) {
  const { note, lesson, label } = item;
  const x = lesson?.x;
  const tr = lang === 'fr' ? 'fr' : 'en';
  const title = itemTitle(item, lang === 'zh' ? 'en' : lang);
  const sameFamily = item.family ? items.filter((i) => i.family === item.family && i.note.id !== note.id) : [];
  const findPoint = (pattern: string) => items.find((i) => i.note.hanzi === pattern || i.note.alts.includes(pattern));

  return (
    <div className="stack-l wd-detail gr-detail">
      <a className="gr-back" href={BASE}>
        <Icon name="back" />
        <span>All grammar</span>
      </a>

      <div className="panel stack">
        <Formula pattern={x?.formula || note.hanzi} />
        {x?.formula && x.formula !== note.hanzi && <p className="small faint zh">Excel: {note.hanzi}</p>}
        <p className="gr-head">{title.text}</p>
        <Labels item={item} />
        {label?.src === 'claude' && <p className="small faint">Labels suggested by Claude. Change them anytime.</p>}
      </div>

      <Section title="Meaning">
        <div className="cell cell-pad stack">
          <p>
            <span className="tag">EN</span> {x?.meaning.en || note.en}
          </p>
          {(x?.meaning.fr || note.fr) && (
            <p>
              <span className="tag">FR</span> {x?.meaning.fr || note.fr}
            </p>
          )}
          {x && <p className="small muted">Register: {x.register}</p>}
        </div>
      </Section>

      {x ? (
        <>
          {x.rules.length > 0 && (
            <Section title="How to use it">
              {x.rules.map((r, i) => (
                <div key={i} className="cell cell-pad">{r[tr]}</div>
              ))}
            </Section>
          )}
          {x.tip && (
            <Section title="Tip">
              <div className="cell cell-pad">{x.tip[tr]}</div>
            </Section>
          )}
        </>
      ) : (
        <Section title="Lesson" footer={LESSONS_READY ? undefined : 'Lesson generation comes in the next step (plan WP3). Explain more, below, already works.'}>
          <div className="cell cell-pad stack">
            <p className="muted">No lesson yet: formula, rules, tip, French and English examples, common mistakes and related points.</p>
            <button type="button" className="btn tinted" disabled={!LESSONS_READY}>
              Write the lesson with Claude
            </button>
          </div>
        </Section>
      )}

      <Section title="Examples">
        {note.examples.map((e, i) => (
          <Example key={`x${i}`} zh={e.zh} pinyin={e.pinyin} tr={e.en} source="Excel" />
        ))}
        {x?.examples.map((e, i) => <Example key={`l${i}`} zh={e.zh} pinyin={e.pinyin} tr={e[tr]} />)}
        {!note.examples.length && !x?.examples.length && <div className="cell cell-pad muted">No example in Excel yet.</div>}
      </Section>

      {x && x.mistakes.length > 0 && (
        <Section title="Common mistakes">
          {x.mistakes.map((m, i) => (
            <div key={i} className="cell cell-pad stack gr-mistake">
              <p className="zh">
                <span className="gr-wrong">✕ {m.wrong}</span>
              </p>
              <p className="zh">✓ {m.right}</p>
              <p className="small muted">{m.why[tr]}</p>
            </div>
          ))}
        </Section>
      )}

      {x && x.related.length > 0 && (
        <Section title="Don't confuse with">
          {x.related.map((r, i) => {
            const target = findPoint(r.pattern);
            const body = (
              <span className="cell-body">
                <span className="zh">{r.pattern}</span>
                <span className="small muted">{r.diff[tr]}</span>
              </span>
            );
            return target ? (
              <a key={i} className="cell tap" href={href(target.note.id)}>
                {body}
                <Icon name="chevron" className="cell-chev" />
              </a>
            ) : (
              <div key={i} className="cell">
                {body}
              </div>
            );
          })}
        </Section>
      )}

      {x?.excelNotes && x.excelNotes.length > 0 && (
        <Section title="Check your Excel row" footer="Suggestions only: nothing is changed in Excel.">
          {x.excelNotes.map((n, i) => (
            <div key={i} className="cell cell-pad stack">
              <p>{n.text}</p>
              {n.suggestion && <p className="zh small">→ {n.suggestion}</p>}
            </div>
          ))}
        </Section>
      )}

      {sameFamily.length > 0 && (
        <Section title={`Same family · ${familyOf(item.family)?.[tr] ?? ''}`}>
          {sameFamily.map((i) => (
            <a key={i.note.id} className="cell tap" href={href(i.note.id)}>
              <span className="cell-body zh">{i.note.hanzi}</span>
              <Icon name="chevron" className="cell-chev" />
            </a>
          ))}
        </Section>
      )}

      <div className="panel stack">
        <h3>Your status</h3>
        <StatusPicker value={status} onChange={(st) => void setNoteStatus(note.id, STATUS_MARK[st])} />
      </div>

      <div className="panel stack">
        <h3>Explain more</h3>
        <ExplainView note={note} inline />
      </div>
    </div>
  );
}

function Example({ zh, pinyin, tr, source }: { zh: string; pinyin?: string; tr?: string; source?: string }) {
  return (
    <div className="cell cell-pad gr-ex">
      <div className="cell-body">
        <span className="zh gr-ex-zh">
          {zh} {source && <span className="tag">{source}</span>}
        </span>
        {pinyin && <span className="small muted">{pinyin}</span>}
        {tr && <span className="small muted">{tr}</span>}
      </div>
      <AudioButton text={zh} label="Play sentence" />
    </div>
  );
}

function Labels({ item }: { item: GrammarItem }) {
  const id = item.note.id;
  return (
    <div className="row wrap gr-labels">
      <label className="gr-select">
        <select aria-label="HSK level" value={item.hsk ?? ''} onChange={(e) => setLabel(id, { hsk: e.target.value ? (Number(e.target.value) as HskLevel) : undefined, family: item.label?.family ?? item.family })}>
          <option value="">HSK ?</option>
          {HSK_LEVELS.map((h) => (
            <option key={h} value={h}>
              {hskLabel(h)}
            </option>
          ))}
        </select>
      </label>
      <label className="gr-select">
        <select aria-label="Family" value={item.family ?? ''} onChange={(e) => setLabel(id, { family: (e.target.value || undefined) as FamilyId | undefined, hsk: item.label?.hsk ?? item.hsk })}>
          <option value="">Family ?</option>
          {FAMILIES.map((f) => (
            <option key={f.id} value={f.id}>
              {f.en}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

