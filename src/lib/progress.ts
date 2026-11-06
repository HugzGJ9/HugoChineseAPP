// The progress workbook written next to the Excel file: the status of every word and daily figures.
import type { CardState, Note, ReviewEvent } from './types';
import { DAY, dayStart, noteOfCard, noteStatus, type Status } from './engine/schedule';
import { daily, groupCards, retention30, statusCounts, streak } from './stats';
import { buildXlsx, type Sheet } from './xlsx/write';

export const PROGRESS_FILE = 'Hugo_chinese_progress.xlsx';

const STATUS_LABEL: Record<Status, string> = { new: 'New', learning: 'Learning', review: 'Review', mastered: 'Mastered', leech: 'Leech' };
const KIND_LABEL: Record<Note['kind'], string> = { vocab: 'Word', grammar: 'Grammar', measure: 'Measure word', synonym: 'Near-synonym' };

export interface ProgressInput {
  notes: Note[];
  cards: Iterable<CardState>;
  events: ReviewEvent[];
  device: string;
  now: number;
}

export function progressSheets({ notes, cards, events, now }: ProgressInput): Sheet[] {
  const byNote = groupCards(cards);
  const evByNote = new Map<string, { n: number; ok: number; last: number }>();
  for (const e of events) {
    const k = noteOfCard(e.card);
    const s = evByNote.get(k) ?? { n: 0, ok: 0, last: 0 };
    s.n++;
    if (e.r > 1) s.ok++;
    s.last = Math.max(s.last, e.t);
    evByNote.set(k, s);
  }

  const words: Sheet = {
    name: 'Words',
    columns: [
      { header: 'Sheet', width: 14 },
      { header: 'Row', width: 6, format: 'int' },
      { header: 'Hanzi', width: 14 },
      { header: 'Pinyin', width: 16 },
      { header: 'Meaning', width: 36 },
      { header: 'Type', width: 13 },
      { header: 'Status', width: 10 },
      { header: 'Next review', width: 12, format: 'date' },
      { header: 'Reviews', width: 9, format: 'int' },
      { header: 'Correct', width: 9, format: 'pct' },
      { header: 'Lapses', width: 8, format: 'int' },
      { header: 'First studied', width: 13, format: 'date' },
      { header: 'Last review', width: 12, format: 'date' },
      { header: 'Memory (days)', width: 14, format: 'dec1' },
      { header: 'Green in Excel', width: 14 },
    ],
    rows: [...notes]
      .sort((a, b) => a.order - b.order)
      .map((n) => {
        const cs = (byNote.get(n.id) ?? []).filter((c) => !c.locked);
        const started = cs.filter((c) => c.state !== 0);
        const ev = evByNote.get(n.id);
        const ref = n.refs[0];
        const next = started.length ? Math.min(...started.map((c) => c.due)) : undefined;
        const first = cs.map((c) => c.first).filter((x): x is number => x != null);
        return [
          ref?.sheet ?? '',
          ref?.row,
          n.hanzi,
          n.pinyin,
          n.en || n.fr || n.frAuto || '',
          KIND_LABEL[n.kind],
          STATUS_LABEL[noteStatus(cs, now)],
          next != null ? new Date(next) : null,
          ev?.n ?? 0,
          ev?.n ? ev.ok / ev.n : null,
          cs.reduce((a, c) => a + c.lapses, 0),
          first.length ? new Date(Math.min(...first)) : null,
          ev?.last ? new Date(ev.last) : null,
          started.length ? Math.round(Math.min(...started.map((c) => c.stability)) * 10) / 10 : null,
          n.studied ? 'Yes' : '',
        ];
      }),
  };

  const firstEvent = events.reduce((m, e) => Math.min(m, e.t), now);
  const nDays = Math.min(3650, Math.max(1, Math.round((dayStart(now) - dayStart(firstEvent)) / DAY) + 1));
  const days = daily(events, nDays, now).reverse();
  const devices = [...new Set(events.map((e) => e.dev))].sort();
  const dailySheet: Sheet = {
    name: 'Daily',
    columns: [
      { header: 'Date', width: 12, format: 'date' },
      { header: 'Reviews', width: 9, format: 'int' },
      { header: 'Correct', width: 9, format: 'pct' },
      { header: 'New words', width: 11, format: 'int' },
      { header: 'Minutes', width: 9, format: 'dec1' },
      ...devices.map((d) => ({ header: d, width: Math.max(12, d.length + 2), format: 'int' as const })),
    ],
    rows: days.map((d) => [
      new Date(d.start),
      d.reviews,
      d.reviews ? d.correct / d.reviews : null,
      d.newWords,
      Math.round(d.ms / 6000) / 10,
      ...devices.map((dev) => d.byDevice[dev] ?? 0),
    ]),
  };

  const counts = statusCounts(notes, byNote, now);
  const kinds = (k: Note['kind']) => notes.filter((n) => n.kind === k).length;
  const week = events.filter((e) => e.t >= now - 7 * DAY).length;
  const ret = retention30(events, now);
  const dueTomorrow = [...byNote.values()].flat().filter((c) => !c.locked && c.state !== 0 && c.due < dayStart(now) + 2 * DAY).length;
  const summary: Sheet = {
    name: 'Summary',
    table: false,
    columns: [
      { header: 'Hugo 中文', width: 28 },
      { header: '', width: 20, format: 'datetime' },
    ],
    rows: [
      ['Updated', new Date(now)],
      ['Words', kinds('vocab')],
      ['Grammar points', kinds('grammar')],
      ['Measure words', kinds('measure')],
      ['Near-synonyms', kinds('synonym')],
      [],
      ['New', counts.new],
      ['Learning', counts.learning],
      ['Review', counts.review],
      ['Mastered (next review in 3+ weeks)', counts.mastered],
      ['Leech (8+ lapses)', counts.leech],
      [],
      ['Reviews, all time', events.length],
      ['Reviews, last 7 days', week],
      ['Retention, last 30 days', ret == null ? null : { v: ret, f: 'pct' }],
      ['Streak (days)', streak(events, now)],
      ['Due by tomorrow', dueTomorrow],
      ['Devices', devices.join(', ')],
    ],
  };
  return [words, dailySheet, summary];
}

export function progressWorkbook(input: ProgressInput): Uint8Array {
  return buildXlsx(progressSheets(input));
}
