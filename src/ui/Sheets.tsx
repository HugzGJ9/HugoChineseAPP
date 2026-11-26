// Sheets: the Excel workbook as tabs. Rows in Excel order, hanzi / pinyin / meaning with Quick memory's hide/show,
// and a status per row that Hugo sets himself (menu, or Paint mode for one tap per row).
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from 'react';
import type { Note, WordStatus } from '../lib/types';
import { clearExcelChanges, setLang, setNoteStatus, setWrong, undoMark, useApp } from '../lib/store';
import { pref, setPref } from '../lib/db';
import { cardId } from '../lib/engine/schedule';
import { buildQueue } from '../lib/engine/queue';
import { normMeaning } from '../lib/engine/grade';
import { checkListAnswer } from '../lib/answer';
import { allRows, cardsHref, filterRows, LIST_FILTERS, readListFilter, recentByNote, type ListFilter } from '../lib/quick';
import { wrongNotes } from '../lib/wrong';
import { sheetRows, STATUS_LABEL, STATUS_MARK, WORD_STATUSES, type SheetRow } from '../lib/status';
import { formatDate, Icon, LangSwitch, Pinyin, Segmented, toast, TopBar, useNow } from './common';
import { WriteLine } from './Microsoft';
import { HomeNotices, NoWords } from './Today';
import { revealAboveKeyboard } from './keyboard';
import { LayerBar, QmList, useQmShown } from './qm';
import { Sheet } from './panel';
import { StatusChip, StatusIcon, StatusPicker } from './StatusPicker';
import { FILTER_LABEL, FilterMenu, MoreMenu } from './sheets/Menus';
import { ScratchPanel } from './sheets/ScratchPad';
import { WordPanel } from './word/WordPanel';
import { motionOn } from './motion';
import './sheets/sheets.css';

/** The All tab: every sheet, a word once. Not a sheet name anyone would type. */
const ALL_TAB = '\u0000all';
const PAGE_OLD = 150;
const PAGE_MOTION = 400; // plan 2026-11-22-ui-polish D6: with content-visibility rows, a bigger page is cheap
const pageSize = () => (motionOn() ? PAGE_MOTION : PAGE_OLD);
// Rows drawn at once when the list changes (mount, sheet tab, filter, search); the rest of the page follows in steps
// of GROW_STEP, so a tab switch paints in one short frame instead of a 300–500 ms freeze on the iPhone.
const FIRST_ROWS = 30;
const GROW_STEP = 60;
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

/** Statuses that an Excel edit changed, with a way back. */
function ExcelChangesNotice() {
  const changes = useApp((s) => s.excelChanges);
  const [all, setAll] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!changes?.length) return null;
  const shown = all ? changes : changes.slice(0, 5);
  const restore = async () => {
    setBusy(true);
    try {
      for (const c of changes) await setNoteStatus(c.note, STATUS_MARK[c.from]);
      clearExcelChanges();
      toast('Statuses restored');
    } catch (err) {
      toast(`Couldn't restore: ${(err as Error).message}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="notice hs-excel" role="status">
      <span className="hs-excel-t">
        Excel changed {changes.length} {changes.length === 1 ? 'status' : 'statuses'}:{' '}
        {shown.map((c, i) => (
          <span key={c.note}>
            {i > 0 && ', '}
            <span lang="zh-CN">{c.hanzi}</span> {STATUS_LABEL[c.from]} → {STATUS_LABEL[c.to]}
          </span>
        ))}
        {changes.length > 5 && !all && (
          <>
            {', '}
            <button type="button" className="btn small ghost" onClick={() => setAll(true)}>
              and {changes.length - 5} more
            </button>
          </>
        )}
      </span>
      <div className="hs-excel-actions">
        <button type="button" className="btn small" disabled={busy} onClick={restore}>
          Restore
        </button>
        <button type="button" className="btn small" disabled={busy} onClick={clearExcelChanges}>
          OK
        </button>
      </div>
    </div>
  );
}

/**
 * True once the sticky part of the header (the whole head on wide screens, the toolbar on phones) is pinned under the
 * navigation bar: it then takes the bar material and the nav bar drops its own hairline, so the two read as one bar.
 */
function useStuck(...refs: React.RefObject<HTMLElement | null>[]): boolean {
  const [stuck, setStuck] = useState(false);
  useEffect(() => {
    let raf = 0;
    const check = () => {
      raf = 0;
      let on = false;
      for (const r of refs) {
        const el = r.current;
        if (!el) continue;
        const cs = getComputedStyle(el);
        if (cs.position !== 'sticky') continue;
        on = window.scrollY > 0 && el.getBoundingClientRect().top <= parseFloat(cs.top) + 0.5;
      }
      setStuck(on);
    };
    const on = () => {
      if (!raf) raf = requestAnimationFrame(check);
    };
    check();
    window.addEventListener('scroll', on, { passive: true });
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on);
      window.removeEventListener('resize', on);
      if (raf) cancelAnimationFrame(raf);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return stuck;
}

/** What Hugo typed in a row's answer field and how it was judged (undefined = not checked yet). Session only. */
type Answer = { text: string; ok?: boolean };

/**
 * The answer field at the end of a row (D10). Checks on Return or on leaving the field; editing clears the colour.
 * Nothing is stored: the text goes up to Sheets' state only so that it survives a tab switch.
 */
function AnswerField({ row, init, onCommit }: { row: SheetRow; init?: Answer; onCommit: (key: string, a: Answer | undefined) => void }) {
  const [text, setText] = useState(init?.text ?? '');
  const [ok, setOk] = useState<boolean | undefined>(init?.ok);
  const done = useRef(init?.text ?? '');
  const check = (value: string) => {
    const r = checkListAnswer(value, row.note);
    setOk(r ? r.right : undefined);
    done.current = value;
    onCommit(row.key, r ? { text: value, ok: r.right } : undefined);
  };
  const verdict = ok === undefined ? '' : ok ? 'right' : 'wrong';
  return (
    <span className={`ql-ans ${verdict}`}>
      <input
        type="text"
        inputMode="text"
        value={text}
        lang="zh-CN"
        placeholder="汉字·1–4"
        aria-label={`Answer for ${row.note.hanzi}`}
        aria-invalid={ok === false || undefined}
        enterKeyHint="next"
        autoCapitalize="off"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          if (ok !== undefined) {
            setOk(undefined);
            onCommit(row.key, undefined);
          }
        }}
        onBlur={() => {
          if (text.trim() && (ok === undefined || done.current !== text)) check(text);
          else if (!text.trim() && done.current) {
            done.current = '';
            onCommit(row.key, undefined);
          }
        }}
        onKeyDown={(e) => {
          if (e.key !== 'Enter' || e.nativeEvent.isComposing) return;
          e.preventDefault();
          if (text.trim()) check(text);
          const next = e.currentTarget.closest('.ql-row')?.nextElementSibling?.querySelector<HTMLInputElement>('.ql-ans input');
          if (next) {
            next.focus({ preventScroll: true });
            requestAnimationFrame(() => revealAboveKeyboard(next));
          } else e.currentTarget.blur();
        }}
      />
      {verdict && (
        <span className="ql-ans-mark" aria-hidden="true">
          {ok ? '✓' : '✗'}
        </span>
      )}
      <span className="sr" role="status">
        {verdict === 'right' ? 'Right' : verdict === 'wrong' ? 'Wrong' : ''}
      </span>
    </span>
  );
}

export function Sheets() {
  const { notes, cards, events, settings, noteMap, marks, meta, lang } = useApp((s) => s);
  const now = useNow(300000);
  const { shown, preset, listen, setShown, toggle } = useQmShown('sh');
  const [tab, setTab] = useState<string>(() => pref('sh.tab', ''));
  const [filter, setFilterState] = useState<ListFilter>(() => readListFilter(pref<unknown>('sh.filter', 'all')));
  const [paint, setPaintState] = useState<WordStatus | null>(() => readStatus(pref<unknown>('sh.paint', null)));
  const [q, setQ] = useState('');
  const dq = useDeferredValue(q);
  const [limit, setLimit] = useState(pageSize);
  // How many of the `limit` rows are drawn yet, for this list (`grow.key`). A new list starts at FIRST_ROWS.
  const listKey = `${tab}|${filter}|${dq}`;
  const [grow, setGrow] = useState({ key: listKey, n: FIRST_ROWS });
  if (grow.key !== listKey) {
    setGrow({ key: listKey, n: FIRST_ROWS });
    setLimit(pageSize());
  }
  useEffect(() => {
    if (grow.n >= limit) return;
    // In steps of GROW_STEP rows, each a short plain update after the frame is painted. Not a transition: with
    // "Try new animations" on, every transition update runs a page-wide View Transition (seconds of work for a list).
    const t = setTimeout(() => setGrow((g) => (g.key === grow.key ? { key: g.key, n: Math.min(limit, g.n + GROW_STEP) } : g)), 16);
    return () => clearTimeout(t);
  }, [grow, limit]);
  const [menu, setMenu] = useState<string | null>(null);
  const [panel, setPanel] = useState<string | null>(null);
  const [scratch, setScratch] = useState(false);
  const [dlg, setDlg] = useState<'filter' | 'more' | null>(null);
  const [answers, setAnswers] = useState<Record<string, Answer>>({});
  const [answerGen, setAnswerGen] = useState(0);
  const [undo, setUndo] = useState<{ id: string; text: string } | null>(null);
  const search = useRef<HTMLInputElement>(null);
  const head = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const tabBox = useRef<HTMLDivElement>(null);
  const stuck = useStuck(head, bar);

  const bySheet = useMemo(() => sheetRows(notes, marks, meta?.colourSince), [notes, marks, meta]);
  const sheetTabs = useMemo(() => {
    const names = (meta?.report.map((r) => r.name) ?? []).filter((n) => bySheet.has(n));
    for (const n of bySheet.keys()) if (!names.includes(n)) names.push(n);
    return names.filter((n) => !HIDDEN_SHEETS.test(n));
  }, [meta, bySheet]);
  const tabs = useMemo(() => (sheetTabs.length ? [ALL_TAB, ...sheetTabs] : []), [sheetTabs]);
  const current = tabs.includes(tab) ? tab : tabs[0] ?? '';
  const isAll = current === ALL_TAB;
  const tabName = isAll ? 'All' : current;
  const allWords = useMemo(() => allRows(new Map(sheetTabs.map((n) => [n, bySheet.get(n) ?? []] as const))), [sheetTabs, bySheet]);
  const all = useMemo(() => (isAll ? allWords : [...(bySheet.get(current) ?? [])].sort((a, b) => a.ref.row - b.ref.row)), [isAll, allWords, bySheet, current]);
  const wrong = useMemo(() => wrongNotes(marks), [marks]);
  const recent = useMemo(() => recentByNote(events, now), [events, now]);
  const hidePinyin = all.length > 0 && all.every((r) => !r.note.pinyin);

  const match = useMemo(() => matcher(dq), [dq]);
  const found = useMemo(() => (match ? all.filter((r) => match(r.note)) : all), [all, match]);
  const counts = useMemo(() => {
    const c = {} as Record<ListFilter, number>;
    for (const f of LIST_FILTERS) c[f] = filterRows(found, f, { wrong, recent }).length;
    return c;
  }, [found, wrong, recent]);
  const list = useMemo(() => filterRows(found, filter, { wrong, recent }), [found, filter, wrong, recent]);
  const elsewhere = useMemo(() => {
    if (!match) return [];
    return sheetTabs.filter((t) => t !== current).map((t) => ({ t, n: (bySheet.get(t) ?? []).filter((r) => match(r.note)).length })).filter((x) => x.n > 0);
  }, [match, sheetTabs, current, bySheet]);

  const due = useMemo(() => {
    if (!notes.length) return 0;
    const c = buildQueue([...cards.values()], noteMap, events, settings, now).counts;
    return c.due + c.learning;
  }, [notes.length, cards, noteMap, events, settings, now]);

  // Keep the selected sheet tab in view inside the scrolling tab strip (without scrolling the page).
  useEffect(() => {
    const box = tabBox.current;
    const el = box?.querySelector<HTMLElement>('[aria-selected="true"]');
    if (!box || !el) return;
    const left = el.offsetLeft - box.offsetLeft;
    if (left < box.scrollLeft + 16 || left + el.offsetWidth > box.scrollLeft + box.clientWidth - 16)
      box.scrollTo({ left: Math.max(0, left - 16), behavior: 'smooth' });
  }, [current, tabs.length]);

  const pickTab = (t: string) => {
    setTab(t);
    setPref('sh.tab', t);
  };
  const setFilter = (f: ListFilter) => {
    setFilterState(f);
    setPref('sh.filter', f);
  };
  const setPaint = (s: WordStatus | null) => {
    setPaintState(s);
    setPref('sh.paint', s);
  };

  const commitAnswer = useCallback((key: string, a: Answer | undefined) => {
    setAnswers((cur) => {
      if (!a) {
        if (!(key in cur)) return cur;
        const { [key]: _drop, ...rest } = cur;
        return rest;
      }
      return { ...cur, [key]: a };
    });
  }, []);

  const cardsLink = useCallback(
    (at?: string) => cardsHref({ sheet: isAll ? 'all' : current, status: filter, at }),
    [isAll, current, filter],
  );
  const clearWrong = async (ids: string[], text: string) => {
    try {
      await setWrong(ids, false);
      toast(text);
    } catch (err) {
      toast(`Couldn't clear that: ${(err as Error).message}`);
    }
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

  // Rows are memoised (QmList.rowSig): their buttons read the paint mode and the Cards link from here, never from a
  // closure that a skipped row would keep.
  const live = useRef({ paint, cardsLink });
  live.current = { paint, cardsLink };

  const dialogOpen = !!menu || !!panel || scratch || !!dlg;
  // Sheets stays mounted while another screen shows (App <Activity>), and the word panel is portalled to <body>:
  // close every menu and panel on leaving, so none is still open (or covering Cards) when Hugo comes back.
  useEffect(
    () => () => {
      setMenu(null);
      setPanel(null);
      setScratch(false);
      setDlg(null);
    },
    [],
  );

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
      if (dialogOpen || (e.target as HTMLElement)?.tagName === 'INPUT') return false;
      const k = e.key.toLowerCase();
      const s: WordStatus | undefined = k === 'm' ? 'mastered' : k === 'k' ? 'notknown' : k === 's' ? 'studying' : k === 'u' ? 'new' : undefined;
      if (s) {
        void apply(row, s);
        return true;
      }
      if (k === 'w') {
        location.hash = cardsLink(row.note.id);
        return true;
      }
      if (k === 'e') {
        setPanel(row.key);
        return true;
      }
      return false;
    },
    [apply, dialogOpen, cardsLink],
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
  const panelRow = panel ? all.find((r) => r.key === panel) : undefined;
  const reviewIds = [...new Set(list.map((r) => r.note))]
    .slice(0, 100)
    .map((n) => cardId(n.id, n.kind === 'vocab' ? 'recog' : n.kind))
    .filter((id) => cards.has(id));

  return (
    <div className={`main sheets${stuck ? ' stuck' : ''}`}>
      <TopBar title="Sheets">
        <span className="hs-lang">
          <LangSwitch />
        </span>
        <button type="button" className="icon-btn hs-morebtn" aria-haspopup="menu" aria-label="More actions" title="More actions" onClick={() => setDlg('more')}>
          <span className="hs-morecircle" aria-hidden="true">
            <Icon name="more" />
          </span>
        </button>
      </TopBar>
      <div className="hs-notices">
        <ExcelChangesNotice />
        <HomeNotices />
        <WriteLine />
      </div>
      <div className="hs-head" ref={head}>
        {tabs.length > 0 && (
          <div className="hs-tabs" role="tablist" aria-label="Sheets" ref={tabBox}>
            {tabs.map((t) => (
              <button key={t} type="button" role="tab" aria-selected={t === current} className="hs-tab" onClick={() => pickTab(t)}>
                {t === ALL_TAB ? 'All' : t} <span className="hs-tab-n">{t === ALL_TAB ? allWords.length : bySheet.get(t)?.length ?? 0}</span>
              </button>
            ))}
          </div>
        )}
        {tabs.length > 0 && (
          <Segmented
            label="View"
            className="hs-view"
            value="list"
            onChange={(v) => {
              if (v === 'cards') location.hash = cardsLink();
            }}
            options={[
              { value: 'list', label: 'List' },
              { value: 'cards', label: 'Cards' },
            ]}
          />
        )}
        <div className="hs-search">
          <input
            ref={search}
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && q) {
                e.preventDefault();
                setQ('');
              }
            }}
            placeholder={`Search ${tabName}`}
            aria-label={`Search ${tabName}`}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            enterKeyHint="search"
            title="Hanzi, pinyin or meaning (key /)"
          />
          {q && (
            <button
              type="button"
              className="hs-clear"
              aria-label="Clear search"
              onClick={() => {
                setQ('');
                search.current?.focus();
              }}
            >
              <span aria-hidden="true" />
            </button>
          )}
        </div>
        <div className="hs-sticky" ref={bar}>
          <div className="hs-bar">
            <LayerBar shown={shown} lang={lang} onToggle={toggle} noPinyin={hidePinyin} compact />
            <button type="button" className={`hs-filter${filter !== 'all' ? ` ${WORD_STATUSES.includes(filter as WordStatus) ? `st-${filter}` : `fl-${filter}`}` : ''}`} aria-haspopup="menu" aria-pressed={filter !== 'all'} onClick={() => setDlg('filter')}>
              {filter === 'all' ? (
                <Icon name="filter" />
              ) : WORD_STATUSES.includes(filter as WordStatus) ? (
                <StatusIcon status={filter as WordStatus} />
              ) : (
                <Icon name={filter === 'wrong' ? 'x-circle' : filter === 'week' ? 'clock' : 'bolt'} />
              )}
              <span className="hs-filter-l">{FILTER_LABEL[filter]}</span>
              <span className="hs-count">{counts[filter]}</span>
              <Icon name="chevron-down" className="hs-filter-chev" />
              <span className="sr">, filter by status</span>
            </button>
          </div>
          {paint && (
            <div className="hs-paint">
              <div className="hs-paint-h">
                <span>
                  Painting <b>{STATUS_LABEL[paint]}</b>: tap a row's status.
                </span>
                <button type="button" className="btn small plain" onClick={() => setPaint(null)}>
                  Done
                </button>
              </div>
              <StatusPicker value={paint} onChange={setPaint} compact />
            </div>
          )}
        </div>
      </div>
      {elsewhere.length > 0 && (
        <div className="hs-elsewhere" aria-label="Also found in other sheets">
          {elsewhere.map((x) => (
            <button key={x.t} type="button" className="chip" onClick={() => pickTab(x.t)}>
              Also in {x.t} <span className="hs-count">{x.n}</span>
            </button>
          ))}
        </div>
      )}
      {list.length === 0 ? (
        <div className="hs-empty">
          <Icon name={all.length === 0 ? 'sheets' : 'search'} />
          <p>{all.length === 0 ? 'No rows on this sheet.' : filter === 'wrong' && !match ? 'Nothing marked Wrong.' : 'No rows match.'}</p>
        </div>
      ) : (
        <QmList
          items={list.slice(0, Math.min(limit, grow.n))}
          shown={shown}
          listen={listen}
          hidePinyin={hidePinyin}
          rowClass={(r) => `st-${r.status}`}
          rowSig={(r) => `${r.status}|${wrong.has(r.note.id) ? 'w' : ''}|${answerGen}|${r.ref.id ?? r.ref.row}`}
          lead={(r) => <span className="hs-id">{r.ref.id ?? r.ref.row}</span>}
          trail={(r) => (
            <>
              {wrong.has(r.note.id) && (
                <button
                  type="button"
                  className="hs-wrong"
                  aria-label={`Wrong: ${r.note.hanzi}. Tap to clear`}
                  title="Tap to clear Wrong"
                  onClick={() => void clearWrong([r.note.id], `Wrong cleared: ${r.note.hanzi}`)}
                >
                  <span className="hs-wrong-pill">
                    <Icon name="x-circle" />
                    Wrong
                  </span>
                </button>
              )}
              <StatusChip
                status={r.status}
                onClick={() => {
                  const p = live.current.paint;
                  if (p) void apply(r, p);
                  else setMenu(r.key);
                }}
              />
              <button type="button" className="icon-btn hs-practise" onClick={() => (location.hash = live.current.cardsLink(r.note.id))} aria-label={`Practise ${r.note.hanzi}`} title="Practise (W)">
                <Icon name="pen" />
              </button>
            </>
          )}
          answer={(r) => <AnswerField key={`${r.key}:${answerGen}`} row={r} init={answers[r.key]} onCommit={commitAnswer} />}
          onKey={onRowKey}
          onOpen={(r) => setPanel(r.key)}
        />
      )}
      {list.length > limit && grow.n >= limit && (
        <button type="button" className="btn tinted block hs-showmore" onClick={() => setLimit(limit + (motionOn() ? 400 : 200))}>
          Show more
        </button>
      )}
      <p className="hs-foot" aria-live="polite">
        {list.length === all.length ? `${all.length} rows` : `${list.length} of ${all.length} rows`}
      </p>

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
      {panel && panelRow && (
        <WordPanel
          key={panelRow.key}
          note={panelRow.note}
          practiseHref={cardsLink(panelRow.note.id)}
          rowId={panelRow.ref.id ?? panelRow.ref.row}
          status={panelRow.status}
          onStatus={(s) => void apply(panelRow, s)}
          onClose={() => setPanel(null)}
        />
      )}
      {dlg === 'filter' && (
        <FilterMenu
          value={filter}
          counts={counts}
          onPick={(f) => {
            setFilter(f);
            setDlg(null);
          }}
          onClearWrong={() => {
            setDlg(null);
            const ids = list.map((r) => r.note.id);
            void clearWrong(ids, `Wrong cleared on ${ids.length} ${ids.length === 1 ? 'word' : 'words'}`);
          }}
          onClose={() => setDlg(null)}
        />
      )}
      {dlg === 'more' && (
        <MoreMenu
          paint={!!paint}
          reviewHref={reviewIds.length > 0 ? `#/review?cards=${reviewIds.map(encodeURIComponent).join(',')}` : null}
          reviewCount={reviewIds.length}
          due={due}
          preset={preset}
          hasAnswers={Object.keys(answers).length > 0}
          onClearAnswers={() => {
            setAnswers({});
            setAnswerGen((g) => g + 1);
            setDlg(null);
          }}
          onPaint={() => {
            setPaint(paint ? null : 'mastered');
            setDlg(null);
          }}
          onScratch={() => {
            setDlg(null);
            setScratch(true);
          }}
          onPreset={(s, name) => {
            setShown(s, name);
            setDlg(null);
          }}
          onClose={() => setDlg(null)}
        />
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
  const onKeyDown = (e: React.KeyboardEvent) => {
    const items = [...e.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
    const i = items.indexOf(document.activeElement as HTMLElement);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus();
    } else if (e.key === 'Tab') {
      e.preventDefault();
      items[(i + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  };
  const own = row.mark && row.mark.t > row.since;
  return (
    <Sheet variant="menu" size="content" className="hs-pop" label={`Status of ${row.note.hanzi}`} onClose={onClose} onKeyDown={onKeyDown}>
      <>
        <div className="hs-pop-head">
          <span className="zh hs-pop-hz" lang="zh-CN">
            {row.note.hanzi}
          </span>
          {row.note.pinyin && <Pinyin text={row.note.pinyin} className="hs-pop-py" />}
        </div>
        <div className="hs-pop-group">
          <div role="menu" aria-label="Set status" className="pop-menu">
            {WORD_STATUSES.map((s) => (
              <button key={s} type="button" role="menuitemradio" aria-checked={row.status === s} className={`pop-item st-${s}`} onClick={() => onPick(s)}>
                <StatusIcon status={s} className="pop-st" />
                <span className="grow">{STATUS_LABEL[s]}</span>
                {row.status === s && <Icon name="check" />}
              </button>
            ))}
          </div>
          <p className="hs-pop-foot">
            Excel colour: {STATUS_LABEL[row.excel]}.{' '}
            {own ? `You set ${STATUS_LABEL[row.status]} on ${formatDate(row.mark!.t)}.` : 'Following the Excel colour.'}
          </p>
        </div>
        <button type="button" className="btn block" onClick={onClose}>
          Cancel
        </button>
      </>
    </Sheet>
  );
}
