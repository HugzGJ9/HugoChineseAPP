// Answer side of a vocabulary card.
import { useMemo, useState } from 'react';
import type { CardType, Note } from '../../lib/types';
import { useApp } from '../../lib/store';
import { speak } from '../../lib/speech';
import { AudioButton, GridWord, Icon, Meaning, Pinyin } from '../common';
import { StrokeAnimation } from '../WritePad';

export function VocabBack({ note, type, onExplain }: { note: Note; type?: CardType; onExplain?: () => void }) {
  const all = useApp((s) => s.notes);
  const groupWords = useMemo(() => (note.group ? all.filter((n) => n.group === note.group && n.id !== note.id) : []), [all, note]);
  const [strokes, setStrokes] = useState(false);
  return (
    <div className="back">
      {type !== 'recog' && <GridWord text={note.hanzi} onClick={() => speak(note.hanzi)} />}
      <div className="row" style={{ justifyContent: 'center' }}>
        <Pinyin text={note.pinyin} className="big" />
        <AudioButton text={note.hanzi} />
      </div>
      <Meaning note={note} className="meaning" />
      {note.alts.length > 0 && (
        <p className="small muted">
          Also: <span className="zh">{note.alts.join('、')}</span>
        </p>
      )}
      {groupWords.length > 0 && (
        <p className="small muted">
          Related: <span className="zh">{groupWords.map((w) => w.hanzi).join('、')}</span>
        </p>
      )}
      {note.examples.map((ex, i) => (
        <div key={i} className="small">
          <span className="zh">{ex.zh}</span> {ex.pinyin && <span className="muted">{ex.pinyin}</span>} {ex.en && <span className="muted">· {ex.en}</span>}
        </div>
      ))}
      {note.notes.length > 0 && (
        <div className="notes">
          {note.notes.map((n, i) => (
            <p key={i}>{n}</p>
          ))}
        </div>
      )}
      {onExplain && (
        <button type="button" className="btn small tinted" onClick={onExplain} title="Explain (E)">
          <Icon name="sparkles" /> Explain <span className="faint small">E</span>
        </button>
      )}
      {strokes ? (
        <StrokeAnimation word={note.hanzi} size={120} />
      ) : (
        <button type="button" className="btn small ghost" onClick={() => setStrokes(true)}>
          <Icon name="pen" /> Stroke order
        </button>
      )}
    </div>
  );
}
