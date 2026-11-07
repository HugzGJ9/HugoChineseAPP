import { useMemo, useState } from 'react';
import type { Note } from '../lib/types';
import { meaning, useApp } from '../lib/store';
import { cardStatus, formatInterval, noteStatus, type Status } from '../lib/engine/schedule';
import { groupCards } from '../lib/stats';
import { speak } from '../lib/speech';
import { AudioButton, formatDate, GridWord, LangSwitch, Meaning, Pinyin, StatusPill, TopBar } from './common';
import { StrokeAnimation } from './WritePad';
import { normMeaning } from '../lib/engine/grade';

const CARD_LABEL: Record<string, string> = { recog: 'Recognition', recall: 'Recall', listen: 'Listening', grammar: 'Grammar', measure: 'Measure word', synonym: 'Which word fits' };
const MODE_LABEL: Record<string, string> = {
  reveal: 'reveal', 'type-pinyin': 'typed pinyin', 'type-hanzi': 'typed hanzi', 'type-meaning': 'typed meaning',
  'write-guided': 'written', 'write-free': 'written, free', choice: 'choice', build: 'sentence builder', quick: 'Quick memory',
};

export function Words({ id, kinds = ['vocab', 'measure', 'synonym'], title = 'Words', base = '#/words' }: { id?: string; kinds?: Note['kind'][]; title?: string; base?: string }) {
  const { notes, cards, lang } = useApp((s) => s);
  const [q, setQ] = useState('');
  const [tag, setTag] = useState('all');
  const [status, setStatus] = useState<Status | 'all' | 'studied'>('all');
  const now = Date.now();
  const byNote = useMemo(() => groupCards(cards.values()), [cards]);
  const pool = useMemo(() => notes.filter((n) => kinds.includes(n.kind)), [notes, kinds]);
  const tags = useMemo(() => [...new Set(pool.flatMap((n) => n.tags))], [pool]);
  const list = useMemo(() => {
    const query = q.trim().toLowerCase();
    const tl = query.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s\d']/g, '');
    const nq = normMeaning(query);
    return pool.filter((n) => {
      if (tag !== 'all' && !n.tags.includes(tag)) return false;
      if (status === 'studied' && !n.studied) return false;
      if (status !== 'all' && status !== 'studied' && noteStatus(byNote.get(n.id) ?? [], now) !== status) return false;
      if (!query) return true;
      if (n.hanzi.includes(query) || n.alts.some((a) => a.includes(query))) return true;
      if (tl && n.pinyinNum.replace(/[\s\d]/g, '').startsWith(tl)) return true;
      const m = normMeaning(`${n.en} ${n.fr ?? ''} ${n.frAuto ?? ''}`);
      return !!nq && m.includes(nq);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pool, q, tag, status, byNote]);
  const [limit, setLimit] = useState(150);
  const selected = id ? notes.find((n) => n.id === id) : undefined;

  return (
    <div className="main wide">
      <TopBar title={title}>
        <LangSwitch />
      </TopBar>
      <div className="split">
        <div className="stack" style={selected ? undefined : undefined}>
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search hanzi, pinyin or meaning" aria-label="Search" />
          <div className="row wrap">
            {tags.length > 1 && (
              <select value={tag} onChange={(e) => setTag(e.target.value)} aria-label="Sheet" style={{ width: 'auto' }}>
                <option value="all">All sheets</option>
                {tags.map((t) => (
                  <option key={t}>{t}</option>
                ))}
              </select>
            )}
            <select value={status} onChange={(e) => setStatus(e.target.value as Status)} aria-label="Status" style={{ width: 'auto' }}>
              <option value="all">Any status</option>
              <option value="studied">Green in Excel</option>
              <option value="new">New</option>
              <option value="learning">Learning</option>
              <option value="review">Review</option>
              <option value="mastered">Mastered</option>
              <option value="leech">Leech</option>
            </select>
            <span className="small muted" aria-live="polite">
              {list.length === pool.length ? `${pool.length} ${pool.length === 1 ? 'entry' : 'entries'}` : `${list.length} of ${pool.length}`}
            </span>
          </div>
          <div className="list">
            {list.slice(0, limit).map((n) => (
              <a key={n.id} className="list-item" href={`${base}/${encodeURIComponent(n.id)}`} aria-current={n.id === id ? 'true' : undefined} style={n.id === id ? { background: 'var(--sheet-2)' } : undefined}>
                {n.colour && <span className="dot" style={{ background: `#${n.colour}` }} title="Row colour in Excel" />}
                <span className="hz">{n.hanzi}</span>
                <span className="grow">
                  <Pinyin text={n.pinyin} className="small" />
                  <span
                    className="mn"
                    style={{ display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', whiteSpace: 'normal', overflow: 'hidden', overflowWrap: 'break-word' }}
                  >
                    {meaning(n, lang).text}
                  </span>
                </span>
                <StatusPill status={noteStatus(byNote.get(n.id) ?? [], now)} />
              </a>
            ))}
          </div>
          {list.length > limit && (
            <button type="button" className="btn" onClick={() => setLimit(limit + 300)}>
              Show more
            </button>
          )}
        </div>
        <div className="detail">{selected ? <NoteDetail note={selected} /> : <p className="muted">Pick a word to see its details and review history.</p>}</div>
      </div>
    </div>
  );
}

export function NoteDetail({ note }: { note: Note }) {
  const { cards, events, device } = useApp((s) => s);
  const own = useMemo(() => [...cards.values()].filter((c) => c.note === note.id), [cards, note.id]);
  const history = useMemo(() => events.filter((e) => e.card.startsWith(note.id + '#')).sort((a, b) => b.t - a.t), [events, note.id]);
  const [strokes, setStrokes] = useState(false);
  const now = Date.now();
  return (
    <div className="panel stack">
      {note.kind === 'grammar' ? (
        <h2 className="sentence">{note.hanzi}</h2>
      ) : (
        <div className="row wrap">
          <GridWord text={note.hanzi} cell={72} onClick={() => speak(note.hanzi)} />
          <div className="stack" style={{ gap: 2 }}>
            <Pinyin text={note.pinyin} className="big" />
            <AudioButton text={note.hanzi} />
          </div>
        </div>
      )}
      {note.alts.length > 0 && <p className="small muted">Also: <span className="zh">{note.alts.join('、')}</span></p>}
      <div>
        <p><Meaning note={note} lang="en" /></p>
        <p className="muted"><Meaning note={note} lang="fr" /></p>
      </div>
      {note.extra && Object.entries(note.extra).map(([k, v]) => <p key={k} className="small"><span className="muted">{k === 'tip' ? 'Tip' : k === 'tone' ? 'Tone' : 'Opposite / related'}:</span> {v}</p>)}
      {note.examples.map((ex, i) => (
        <div key={i}>
          <span className="zh" style={{ fontSize: '1.1rem' }}>{ex.zh}</span> <AudioButton text={ex.zh} label="Play sentence" />
          {ex.pinyin && <div className="small muted">{ex.pinyin}</div>}
          {ex.en && <div className="small muted">{ex.en}</div>}
        </div>
      ))}
      {note.notes.length > 0 && <div className="small">{note.notes.map((x, i) => <p key={i}>{x}</p>)}</div>}
      <p className="small faint">
        {note.refs.map((r) => `${r.sheet} row ${r.row}${r.id ? ` (ID ${r.id})` : ''}`).join(' · ')}
        {note.studied ? ' · green in Excel' : ''}
      </p>
      {note.kind !== 'grammar' &&
        (strokes ? <StrokeAnimation word={note.hanzi} size={110} /> : <button type="button" className="btn small" onClick={() => setStrokes(true)}>Stroke order</button>)}
      <div className="divider" />
      <h3>Cards</h3>
      <table className="plain">
        <tbody>
          {own.map((c) => (
            <tr key={c.id}>
              <td>{CARD_LABEL[c.type]}</td>
              <td><StatusPill status={c.locked ? 'new' : cardStatus(c, now)} /></td>
              <td className="small muted">
                {c.locked ? 'after first review' : c.state === 0 ? 'not started' : c.due <= now ? 'due now' : `next ${formatDate(c.due)} (in ${formatInterval(c.due - now)})`}
                {c.lapses ? ` · ${c.lapses} lapse${c.lapses > 1 ? 's' : ''}` : ''}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <a className="btn small" href={`#/review?cards=${own.filter((c) => !c.locked).map((c) => encodeURIComponent(c.id)).join(',')}`}>
          Review now
        </a>
      </div>
      {history.length > 0 && (
        <>
          <h3>History</h3>
          <table className="plain small">
            <tbody>
              {history.slice(0, 40).map((e) => (
                <tr key={e.id}>
                  <td>{new Date(e.t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}</td>
                  <td>{CARD_LABEL[e.card.slice(e.card.lastIndexOf('#') + 1)]}</td>
                  <td>{['', 'Again', 'Hard', 'Good', 'Easy'][e.r]}</td>
                  <td className="muted">{MODE_LABEL[e.m] ?? e.m}{e.dev !== device ? ` · ${e.dev}` : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </div>
  );
}

export function Grammar({ id }: { id?: string }) {
  return <Words id={id} kinds={['grammar']} title="Grammar" base="#/grammar" />;
}
