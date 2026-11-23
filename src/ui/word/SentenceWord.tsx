// A word tapped in a grammar example sentence (plan 2026-11-22-grammar-v3, D4–D5), now the first level of a WordSheet
// (plan 2026-11-23 D3). The sentence sits at the top with the word highlighted: tap a character outside it to widen, its
// first or last character to narrow, one inside to keep only that one. One of his words → his meaning, dictionary, Claude,
// status; any other word → the offline dictionary only, plus links to his words that contain it or sit inside it.
import { createPortal } from 'react-dom';
import { WordSheet } from './WordSheet';

export function SentenceWord({ zh, start, length, onClose }: { zh: string; start: number; length: number; onClose: () => void }) {
  // Portal: the grammar page renders this inside its sticky detail pane, which would trap the sheet under the top bar
  // on desktop (qa 2026-11-22).
  return createPortal(<WordSheet root={{ t: 'line', zh, start, length }} onClose={onClose} className="wp tall sw" />, document.body);
}
