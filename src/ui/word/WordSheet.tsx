// One word sheet with a navigation stack (plan 2026-11-23 D3, D5). The first level is what opened it (his word, or a
// word tapped in a sentence). Tapping a word in any line pushes a level, with a "‹ word" button to go back. Lower levels
// stay mounted but hidden, so the selection and computed pinyin survive; the scroll is saved on push
// and restored on pop. × , the backdrop and a swipe down close the whole sheet.
import { lazy, Suspense, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Note, WordStatus } from '../../lib/types';
import { setNoteStatus } from '../../lib/store';
import { STATUS_MARK } from '../../lib/status';
import { lineReadings } from '../../lib/lexicon';
import { numberedToMarked } from '../../lib/pinyin';
import { vocabLinks } from '../../lib/sentence';
import { AudioButton, Icon, LangSwitch, Pinyin } from '../common';
import { Sheet } from '../panel';
import { StatusIcon, StatusPicker } from '../StatusPicker';
import { dictNote, retarget, sameEntry, WordNavContext, type WordEntry, type WordNav } from './nav';
import { useVocab, type Vocab } from './vocab';
import { PinyinChip } from './ZhLine';
import './word.css';

const ExplainView = lazy(() => import('./ExplainView').then((m) => ({ default: m.ExplainView })));
const HAN = /[㐀-鿿\u{20000}-\u{2ffff}]/u;

interface Level {
  id: number;
  entry: WordEntry;
  sel?: [number, number];
  readings?: string[];
  scroll: number;
  opener: HTMLElement | null;
}

interface Resolved { word: string; note?: Note; reading?: string }

function resolve(l: Level, v: Vocab): Resolved {
  const e = l.entry;
  if (e.t === 'note') return { word: e.note.hanzi, note: e.note };
  let word: string;
  let reading: string | undefined;
  if (e.t === 'line') {
    const [s, k] = l.sel ?? [e.start, e.start + e.length];
    word = [...e.zh].slice(s, k).join('');
    const r = l.readings?.slice(s, k).filter(Boolean);
    reading = r && r.length ? r.join(' ') : undefined;
  } else {
    word = e.word;
    reading = e.pinyinNum;
  }
  const id = v.index.forms.get(word);
  return { word, note: id ? v.byId.get(id) : undefined, reading };
}

const shorten = (w: string) => [...w].slice(0, 6).join('');

export function WordSheet({ root, onClose, className = 'wp tall' }: { root: WordEntry; onClose: () => void; className?: string }) {
  const vocab = useVocab();
  const ids = useRef(1);
  const [levels, setLevels] = useState<Level[]>(() => [{ id: 0, entry: root, sel: root.t === 'line' ? [root.start, root.start + root.length] : undefined, scroll: 0, opener: null }]);
  const host = useRef<HTMLDivElement>(null);
  const prevLen = useRef(1);
  const popped = useRef<Level | null>(null);
  const asked = useRef(new Set<number>());
  const levelsRef = useRef(levels);
  levelsRef.current = levels;

  const scroller = () => host.current?.closest<HTMLElement>('.pp-panel') ?? null;

  const open = useCallback((entry: WordEntry) => {
    const cur = levelsRef.current;
    const top = cur[cur.length - 1];
    if (sameEntry(top.entry, entry)) return;
    const saved = scroller()?.scrollTop ?? 0;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setLevels((ls) => [
      ...ls.slice(0, -1),
      { ...ls[ls.length - 1], scroll: saved },
      { id: ids.current++, entry, sel: entry.t === 'line' ? [entry.start, entry.start + entry.length] : undefined, scroll: 0, opener },
    ]);
  }, []);
  const nav = useMemo<WordNav>(() => ({ open }), [open]);

  const pop = useCallback(() => {
    setLevels((ls) => {
      if (ls.length < 2) return ls;
      popped.current = ls[ls.length - 1];
      return ls.slice(0, -1);
    });
  }, []);

  // Push: top of the new level, focus on it. Pop: put the scroll back, focus the word that opened the level.
  useLayoutEffect(() => {
    const was = prevLen.current;
    prevLen.current = levels.length;
    if (levels.length === was) return;
    const sc = scroller();
    const top = host.current?.querySelector<HTMLElement>('.wl.top');
    if (levels.length > was) {
      if (sc) sc.scrollTop = 0;
      top?.focus({ preventScroll: true });
    } else {
      if (sc) sc.scrollTop = levels[levels.length - 1].scroll;
      const op = popped.current?.opener;
      popped.current = null;
      if (op && op.isConnected) op.focus({ preventScroll: true });
      else top?.focus({ preventScroll: true });
    }
  }, [levels]);

  // The reading of a tapped word follows its sentence (银行 → háng).
  useEffect(() => {
    for (const l of levels) {
      if (l.entry.t !== 'line' || l.readings || asked.current.has(l.id)) continue;
      asked.current.add(l.id);
      const { zh } = l.entry;
      lineReadings(zh).then(
        (r) => setLevels((ls) => ls.map((x) => (x.id === l.id ? { ...x, readings: r } : x))),
        () => {},
      );
    }
  }, [levels]);

  const setSel = (id: number, sel: [number, number]) => setLevels((ls) => ls.map((x) => (x.id === id ? { ...x, sel } : x)));

  // The root's note, status and onStatus come from the caller and change after a status tap (Sheets re-renders the
  // panel): read them from the prop, not from the copy taken when the sheet opened (qa 2026-11-23).
  const shown = levels.map((l) => (l.id === 0 && root.t === 'note' ? { ...l, entry: root } : l));
  const top = shown[shown.length - 1];
  const t = resolve(top, vocab);
  const prev = shown.length > 1 ? resolve(shown[shown.length - 2], vocab) : null;
  const rootNote = top.entry.t === 'note' && top.id === 0 ? top.entry : null;
  const titlePy = t.note
    ? t.note.kind !== 'grammar' ? t.note.pinyin : ''
    : t.reading ? numberedToMarked(t.reading.split(' ')) : '';

  return (
    <WordNavContext.Provider value={nav}>
      <Sheet
        className={className}
        label={t.word}
        onClose={onClose}
        back={prev ? { label: shorten(prev.word), onBack: pop } : undefined}
        title={
          <span className="wp-title">
            <span className="zh wp-hz" lang="zh-CN">{t.word}</span>
            {titlePy && <Pinyin text={titlePy} className="wp-py" />}
            {rootNote?.rowId != null && <span className="wp-id">#{rootNote.rowId}</span>}
          </span>
        }
        head={<AudioButton text={t.word} />}
      >
        <div className="wl-host" ref={host}>
          {shown.map((l, i) => (
            <div key={l.id} className={`wl${i === shown.length - 1 ? ' top' : ''}`} hidden={i !== shown.length - 1} tabIndex={-1}>
              <LevelBody level={l} root={l.id === 0} vocab={vocab} onSel={(sel) => setSel(l.id, sel)} />
            </div>
          ))}
        </div>
      </Sheet>
    </WordNavContext.Provider>
  );
}

const Loading = <p className="wp-loading" aria-busy="true">Loading…</p>;

function LevelBody({ level, root, vocab, onSel }: { level: Level; root: boolean; vocab: Vocab; onSel: (s: [number, number]) => void }) {
  const e = level.entry;
  const r = resolve(level, vocab);
  if (e.t === 'note') return <NoteBody entry={e} root={root} vocab={vocab} />;
  return <LineBody level={level} r={r} vocab={vocab} onSel={onSel} />;
}

function StatusGroup({ note, status, onStatus, details }: { note: Note; status: WordStatus; onStatus: (s: WordStatus) => void; details?: boolean }) {
  const href = `#/${note.kind === 'grammar' ? 'grammar' : 'words'}/${encodeURIComponent(note.id)}`;
  return (
    <section className="pp-group wp-status" aria-label="Status">
      <h3 className="pp-group-h">
        <span>Status</span>
        {details && <a href={href} className="wp-details">Details</a>}
      </h3>
      <StatusPicker value={status} onChange={onStatus} compact />
    </section>
  );
}

function NoteBody({ entry, root, vocab }: { entry: Extract<WordEntry, { t: 'note' }>; root: boolean; vocab: Vocab }) {
  const { note } = entry;
  const status = root ? entry.status : (vocab.statuses.get(note.id) ?? 'new');
  const onStatus = root ? entry.onStatus : (s: WordStatus) => void setNoteStatus(note.id, STATUS_MARK[s]);
  return (
    <>
      <div className="wp-bar">
        {root && entry.practiseHref ? (
          <a className="btn small tinted wp-practise" href={entry.practiseHref}>
            <Icon name="pen" />
            Practise this word
          </a>
        ) : (
          <span className="grow" />
        )}
        <PinyinChip />
        <LangSwitch />
      </div>
      <Suspense fallback={Loading}>
        <ExplainView key={note.id} note={note} />
      </Suspense>
      {onStatus && status && <StatusGroup note={note} status={status} onStatus={onStatus} details />}
    </>
  );
}

function LineBody({ level, r, vocab, onSel }: { level: Level; r: Resolved; vocab: Vocab; onSel: (s: [number, number]) => void }) {
  const e = level.entry;
  const nav = useContext(WordNavContext);
  const chars = useMemo(() => (e.t === 'line' ? [...e.zh] : []), [e]);
  const [s, k] = level.sel ?? [0, 0];
  const { note, word } = r;
  const links = useMemo(
    () => (note ? [] : vocabLinks(word, vocab.index).map((x) => vocab.byId.get(x)).filter((n): n is Note => !!n)),
    [note, word, vocab],
  );
  const status = note ? (vocab.statuses.get(note.id) ?? 'new') : undefined;
  return (
    <>
      {e.t === 'line' && (
        <>
          <div className="sw-strip" lang="zh-CN" aria-label="Sentence: tap characters to widen or narrow the word">
            {chars.map((c, i) =>
              HAN.test(c) ? (
                <button
                  key={i}
                  type="button"
                  className={`sw-c zh${i >= s && i < k ? ' on' : ''}${i === s ? ' first' : ''}${i === k - 1 ? ' last' : ''}`}
                  aria-pressed={i >= s && i < k}
                  onClick={() => onSel(retarget(s, k, i))}
                >
                  {c}
                </button>
              ) : (
                <span key={i} className="sw-c zh punct">{c}</span>
              ),
            )}
          </div>
          <p className="sw-hint">Tap a character to widen or narrow the word.</p>
        </>
      )}
      <div className="wp-bar">
        <span className="sw-tag">{note ? 'In your list' : 'Not in your list'}</span>
        <PinyinChip />
        <LangSwitch />
      </div>
      {links.length > 0 && (
        <section className="pp-group sw-links" aria-label="Your words">
          <h3 className="pp-group-h">Your words with {word}</h3>
          <div className="sw-link-list">
            {links.map((n) => (
              <button
                key={n.id}
                type="button"
                className={`chip sw-link st-${vocab.statuses.get(n.id) ?? 'new'}`}
                onClick={() => nav?.open({ t: 'note', note: n })}
              >
                <StatusIcon status={vocab.statuses.get(n.id) ?? 'new'} />
                <span className="zh">{n.hanzi}</span>
              </button>
            ))}
          </div>
        </section>
      )}
      <Suspense fallback={Loading}>
        {note ? (
          <ExplainView key={note.id} note={note} />
        ) : (
          <ExplainView key={`${word}|${r.reading ?? ''}`} note={dictNote(word)} mine={false} reading={r.reading} />
        )}
      </Suspense>
      {note && status && <StatusGroup note={note} status={status} onStatus={(st) => void setNoteStatus(note.id, STATUS_MARK[st])} />}
    </>
  );
}
