// Sheets: the Excel workbook as tabs. Rows in Excel order, hanzi / pinyin / meaning with Quick memory's hide/show,
// and a status per row that Hugo sets himself (menu, or Paint mode for one tap per row).
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, WordStatus } from '../lib/types';
import { setLang, setNoteStatus, undoMark, useApp } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { cardId } from '../lib/engine/schedule';
import { buildQueue } from '../lib/engine/queue';
import { normMeaning } from '../lib/engine/grade';
import { sheetRows, STATUS_LABEL, STATUS_MARK, WORD_STATUSES, type SheetRow } from '../lib/status';
import { formatDate, Icon, LangSwitch, toast, TopBar, useNow } from './common';
import { HomeNotices, NoWords } from './Today';
import { LayerBar, QmList, useQmShown } from './qm';
import { StatusChip, StatusPicker, STATUS_GLYPH } from './StatusPicker';
import { PracticePanel, ScratchPanel } from './sheets/Practice';

type Filter = 'all' | WordStatus;
const PAGE = 150;
const HIDDEN_SHEETS = /^exam$/i;

function matcher(q: string): ((n: Note) => boolean) | null {
  const query = q.trim().toLowerCase();
  if (!query) return null;
  const tl = query.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\d']/g, '');
  const nq = normMeaning(query);
  return (n) =>
    n.hanzi.includes(query) ||
    n.alts.some((a) => a.includes(query)) ||
    (!!tl && n.pinyinNum.toLowerCase().replace(/[\s\d]/g, '').includes(tl)) ||
    (!!nq && normMeaning(`${n.en} ${n.fr ?? ''} ${n.frAuto ?? ''}`).includes(nq));
}

const readStatus = (v: unknown): WordStatus | null => (WORD_STATUSES.includes(v as WordStatus) ? (v as WordStatus) : null);

export function Sheets() {
  const { notes, cards, events, settings, noteMap, marks, meta, lang } = useApp((s) => s);
  const now = useNow(300000);
  const { shown, preset, listen, setShown, toggle } = useQmShown('sh');
  const [tab, setTab] = useState<string>(() => pref('sh.tab', ''));
  const [filter, setFilterState] = useState<Filter>(() => readStatus(pref('sh.filter', 'all')) ?? 'all');
  const [paint, setPaintState] = useState<WordStatus | null>(() => readStatus(pref<unknown>('sh.paint', null)));
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [limit, setLimit] = useState(PAGE);
  const [menu, setMenu] = useState<string | null>(null);
  const [practice, setPractice] = useState<string | null>(null);
  const [scratch, setScratch] = useState(false);
  const [undo, setUndo] = useState<{ id: string; text: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);

  const bySheet = useMemo(() => sheetRows(notes, marks, meta?.colourSince), [notes, marks, meta]);
  const tabs = useMemo(() => {
    const names = (meta?.report.map((r) => r.name) ?? []).filter((n) => bySheet.has(n));
    for (const n of bySheet.keys()) if (!names.includes(n)) names.push(n);
    return names.filter((n) => !HIDDEN_SHEETS.test(n));
  }, [meta, bySheet]);
  const current = tabs.includes(tab) ? tab : tabs[0] ?? '';
  const all = useMemo(() => [...(bySheet.get(current) ?? [])].sort((a, b) => a.ref.row - b.ref.row), [bySheet, current]);
  const hidePinyin = all.length > 0 && all.every((r) => !r.note.pinyin);

  const match = useMemo(() => matcher(dq), [dq]);
  const found = useMemo(() => (match ? all.filter((r) => match(r.note)) : all), [all, match]);
  const counts = useMemo(() => {
    const c: Record<Filter, number> = { all: found.length, new: 0, studying: 0, notknown: 0, mastered: 0 };
    for (const r of found) c[r.status]++;
    return c;
  }, [found]);
  const list = useMemo(() => (filter === 'all' ? found : found.filter((r) => r.status === filter)), [found, filter]);
  const elsewhere = useMemo(() => {
    if (!match) return [];
    return tabs.filter((t) => t !== current).map((t) => ({ t, n: (bySheet.get(t) ?? []).filter((r) => match(r.note)).length })).filter((x) => x.n > 0);
  }, [match, tabs, current, bySheet]);

  const due = useMemo(() => {
    if (!notes.length) return 0;
    const c = buildQueue([...cards.values()], noteMap, events, settings, now).counts;
    return c.due + c.learning;
  }, [notes.length, cards, noteMap, events, settings, now]);

  useEffect(() => setLimit(PAGE), [current, filter, dq]);

  const pickTab = (t: string) => {
    setTab(t);
    setPref('sh.tab', t);
  };
  const setFilter = (f: Filter) => {
    setFilterState(f);
    setPref('sh.filter', f);
  };
  const setPaint = (s: WordStatus | null) => {
    setPaintState(s);
    setPref('sh.paint', s);
  };

  const apply = useCallback(async (row: SheetRow, s: WordStatus) => {
    if (s === row.status) return;
    try {
      const m = await setNoteStatus(row.note.id, STATUS_MARK[s]);
      setUndo({ id: m.id, text: `${row.note.hanzi}: ${STATUS_LABEL[s]}` });
    } catch (err) {
      toast(`Couldn't save that: ${(err as Error).message}`);
    }
  }, []);

  useEffect(() => {
    if (!undo) return;
    const t = setTimeout(() => setUndo(null), 8000);
    return () => clearTimeout(t);
  }, [undo]);

  const dialogOpen = !!menu || !!practice || scratch;

  // Keys: 1 2 3 layers, L language, / search. Row keys (m k s u w) come through QmList.onKey.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || e.ctrlKey || e.metaKey || e.altKey || dialogOpen) return;
      if (e.key === '1') toggle('hz');
      else if (e.key === '2' && !hidePinyin) toggle('py');
      else if (e.key === '3') toggle('mn');
      else if (e.key === 'l' || e.key === 'L') setLang(lang === 'en' ? 'fr' : 'en');
      else if (e.key === '/') {
        e.preventDefault();
        search.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const onRowKey = useCallback(
    (e: KeyboardEvent, row: SheetRow) => {
      if (dialogOpen) return false;
      const k = e.key.toLowerCase();
      const s: WordStatus | undefined = k === 'm' ? 'mastered' : k === 'k' ? 'notknown' : k === 's' ? 'studying' : k === 'u' ? 'new' : undefined;
      if (s) {
        void apply(row, s);
        return true;
      }
      if (k === 'w') {
        setPractice(row.key);
        return true;
      }
      return false;
    },
    [apply, dialogOpen],
  );

  if (!notes.length) {
    return (
      <div className="main">
        <TopBar title="Hugo 中文" />
        <NoWords />
      </div>
    );
  }

  const menuRow = menu ? all.find((r) => r.key === menu) : undefined;
  const practiceRow = practice ? all.find((r) => r.key === practice) : undefined;
  const reviewIds = [...new Set(list.map((r) => r.note))]
    .slice(0, 100)
    .map((n) => cardId(n.id, n.kind === 'vocab' ? 'recog' : n.kind))
    .filter((id) => cards.has(id));

  return (
    <div className="main sheets">
      <TopBar title="Sheets">
        <LangSwitch />
      </TopBar>
      <div className="stack">
        <HomeNotices />
        {tabs.length > 0 && (
          <div className="sh-tabs" role="tablist" aria-label="Sheets">
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={t === current} className="sh-tab" onClick={() => pickTab(t)}>
                {t} <span className="faint">{bySheet.get(t)?.length ?? 0}</span>
              </button>
            ))}
          </div>
        )}
        <input
          ref={search}
          type="search"
          className="sh-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search hanzi, pinyin or meaning"
          aria-label={`Search ${current}`}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          title="Key /"
        />
        {elsewhere.length > 0 && (
          <div className="row wrap" aria-label="Also found in other sheets">
            {elsewhere.map((x) => (
              <button key={x.t} type="button" className="chip" onClick={() => pickTab(x.t)}>
                also in {x.t} ({x.n})
              </button>
            ))}
          </div>
        )}
        <LayerBar shown={shown} preset={preset} lang={lang} onToggle={toggle} onPreset={setShown} noPinyin={hidePinyin} />
        <div className="sh-filters" role="group" aria-label="Filter by status">
          {(['all', ...WORD_STATUSES] as Filter[]).map((f) => (
            <button key={f} type="button" className={`chip sp-${f}`} aria-pressed={filter === f} onClick={() => setFilter(f)}>
              {f === 'all' ? 'All' : STATUS_LABEL[f]} <span className="sh-count">{counts[f]}</span>
            </button>
          ))}
        </div>
        <div className="row wrap">
          <button type="button" className="chip" aria-pressed={!!paint} onClick={() => setPaint(paint ? null : 'mastered')} title="Pick a status, then tap chips to apply it">
            <Icon name="pen" /> Paint
          </button>
          {reviewIds.length > 0 && (
            <a className="btn small" href={`#/review?cards=${reviewIds.map(encodeURIComponent).join(',')}`}>
              Review these ({reviewIds.length})
            </a>
          )}
          <button type="button" className="btn small" onClick={() => setScratch(true)}>
            Scratch pad
          </button>
          {due > 0 && (
            <a className="btn small ghost" href="#/review">
              Due reviews ({due})
            </a>
          )}
          <span className="grow" />
          <span className="small muted" aria-live="polite">
            {list.length === all.length ? `${all.length} rows` : `${list.length} of ${all.length}`}
          </span>
        </div>
        {paint && (
          <div className="stack" style={{ gap: 6 }}>
            <StatusPicker value={paint} onChange={setPaint} compact />
            <p className="small muted">Paint: tap a status chip on a row to set it to {STATUS_LABEL[paint]}.</p>
          </div>
        )}
        {list.length === 0 ? (
          <p className="muted">{all.length === 0 ? 'No rows on this sheet.' : 'No rows match.'}</p>
        ) : (
          <QmList
            items={list.slice(0, limit)}
            shown={shown}
            listen={listen}
            hidePinyin={hidePinyin}
            rowClass={(r) => `st-${r.status}`}
            lead={(r) => <span className="sh-id">{r.ref.id ?? r.ref.row}</span>}
            trail={(r) => (
              <>
                <StatusChip status={r.status} onClick={() => (paint ? void apply(r, paint) : setMenu(r.key))} />
                <button type="button" className="icon-btn" onClick={() => setPractice(r.key)} aria-label={`Practise ${r.note.hanzi}`} title="Practise (W)">
                  <Icon name="pen" />
                </button>
              </>
            )}
            onKey={onRowKey}
          />
        )}
        {list.length > limit && (
          <button type="button" className="btn" onClick={() => setLimit(limit + 200)}>
            Show more
          </button>
        )}
      </div>

      {menuRow && (
        <StatusMenu
          row={menuRow}
          onPick={(s) => {
            void apply(menuRow, s);
            setMenu(null);
          }}
          onClose={() => setMenu(null)}
        />
      )}
      {practiceRow && (
        <PracticePanel note={practiceRow.note} status={practiceRow.status} onStatus={(s) => void apply(practiceRow, s)} onClose={() => setPractice(null)} />
      )}
      {scratch && <ScratchPanel onClose={() => setScratch(false)} />}
      {undo && (
        <div className="undo-bar" role="status">
          <span className="grow">{undo.text}</span>
          <button
            type="button"
            className="btn small"
            onClick={async () => {
              await undoMark(undo.id);
              setUndo(null);
            }}
          >
            Undo
          </button>
        </div>
      )}
    </div>
  );
}

/** Four-choice menu for one row, as a bottom sheet on phones and a centred card on wide screens. */
function StatusMenu({ row, onPick, onClose }: { row: SheetRow; onPick: (s: WordStatus) => void; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const back = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus();
    return () => back?.focus?.();
  }, []);
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...(ref.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      onClose();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  const own = row.mark && row.mark.t > row.since;
  return (
    <div className="pop-backdrop" onClick={onClose}>
      <div ref={ref} className="pop" role="dialog" aria-modal="true" aria-label={`Status of ${row.note.hanzi}`} onClick={(e) => e.stopPropagation()} onKeyDown={onKeyDown}>
        <div className="pop-head">
          <span className="zh pop-hz">{row.note.hanzi}</span>
          <div className="small muted">
            Excel colour: {STATUS_LABEL[row.excel]}
            <br />
            {own ? `You set ${STATUS_LABEL[row.status]} on ${formatDate(row.mark!.t)}.` : 'Following the Excel colour.'}
          </div>
        </div>
        <div role="menu" aria-label="Set status" className="pop-menu">
          {WORD_STATUSES.map((s) => (
            <button key={s} type="button" role="menuitemradio" aria-checked={row.status === s} className={`pop-item sp-${s}`} onClick={() => onPick(s)}>
              <span aria-hidden="true" className="pop-glyph">
                {STATUS_GLYPH[s]}
              </span>
              {STATUS_LABEL[s]}
              {row.status === s && <Icon name="check" />}
            </button>
          ))}
        </div>
        <button type="button" className="btn block" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}
