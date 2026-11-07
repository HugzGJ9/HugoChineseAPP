import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { daily, forecast, groupCards, retention30, statusCounts, streak } from '../lib/stats';
import { StatusPill, TopBar } from './common';

function Bars({ values, labels, cls, title, extra }: { values: number[]; labels: string[]; cls: string; title: string; extra?: number[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(600);
  const [sel, setSel] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setW(Math.max(240, Math.round(el.clientWidth)));
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = Math.max(1, ...values.map((v, i) => v + (extra?.[i] ?? 0)));
  const h = 150;
  const pad = 28;
  const bw = (w - pad) / values.length;
  const step = Math.max(1, Math.ceil(52 / bw));
  const text = (i: number) => `${labels[i]}: ${values[i] + (extra?.[i] ?? 0)}${extra ? ` (${extra[i]} new)` : ''}`;
  return (
    <div ref={ref}>
      <p className="small chart-read" aria-live="polite">{sel == null ? 'Tap a bar to see its value.' : text(sel)}</p>
      <svg className="chart" width={w} height={h + 22} viewBox={`0 0 ${w} ${h + 22}`} role="img" aria-label={title}>
        <line x1={pad} x2={w} y1={h} y2={h} />
        <text x={0} y={12}>{max}</text>
        <text x={0} y={h}>0</text>
        {values.map((v, i) => {
          const bh = (v / max) * (h - 8);
          const eh = ((extra?.[i] ?? 0) / max) * (h - 8);
          const x = pad + i * bw;
          return (
            <g key={i} onClick={() => setSel(i)}>
              <title>{text(i)}</title>
              <rect x={x} y={0} width={bw} height={h} fill="transparent" />
              <rect className={cls} x={x + 1} y={h - bh} width={Math.max(1, bw - 2)} height={bh} rx={2} opacity={sel == null || sel === i ? 1 : 0.45} />
              {extra && eh > 0 && <rect className="bar-n" x={x + 1} y={h - bh - eh} width={Math.max(1, bw - 2)} height={eh} rx={2} opacity={sel == null || sel === i ? 1 : 0.45} />}
              {i % step === 0 && (
                <text x={Math.min(x + bw / 2, w - 20)} y={h + 16} textAnchor="middle">
                  {labels[i]}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

export function Stats() {
  const { notes, cards, events, device } = useApp((s) => s);
  const now = Date.now();
  const days = useMemo(() => daily(events, 30, now), [events, now]);
  const fc = useMemo(() => forecast([...cards.values()], 30, now), [cards, now]);
  const ret = useMemo(() => retention30(events, now), [events, now]);
  const counts = useMemo(() => statusCounts(notes.filter((n) => n.kind === 'vocab'), groupCards(cards.values()), now), [notes, cards, now]);
  const st = useMemo(() => streak(events, now), [events, now]);
  const devices = useMemo(() => {
    const m: Record<string, number> = {};
    for (const e of events) m[e.dev] = (m[e.dev] ?? 0) + 1;
    return m;
  }, [events]);
  const label = (t: number) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
  const week = days.slice(-7).reduce((a, d) => a + d.reviews, 0);
  const minutes = Math.round(days.slice(-7).reduce((a, d) => a + d.ms, 0) / 60000);

  return (
    <div className="main">
      <TopBar title="Stats" />
      <div className="stack-l">
        <div className="counts">
          <div><b>{week}</b><span>reviews this week</span></div>
          <div><b>{ret == null ? '–' : `${Math.round(ret * 100)}%`}</b><span>remembered, 30 days</span></div>
          <div><b>{st}</b><span>day streak</span></div>
        </div>
        <section className="stack">
          <h2>Reviews per day</h2>
          <p className="small muted">Last 30 days; new words in red. {minutes} min of study this week.</p>
          <Bars values={days.map((d) => d.reviews - d.newWords)} extra={days.map((d) => d.newWords)} labels={days.map((d) => label(d.start))} cls="bar-r" title="Reviews per day, last 30 days" />
        </section>
        <section className="stack">
          <h2>Coming up</h2>
          <p className="small muted">Cards falling due each day for the next 30 days (anything overdue counts today).</p>
          <Bars values={fc} labels={fc.map((_, i) => label(now + i * 86400000))} cls="bar-f" title="Forecast, next 30 days" />
        </section>
        <section className="stack">
          <h2>Words</h2>
          <div className="row wrap">
            {(Object.keys(counts) as (keyof typeof counts)[]).map((k) => (
              <span key={k} className="row" style={{ gap: 6 }}>
                <StatusPill status={k} /> <b>{counts[k]}</b>
              </span>
            ))}
          </div>
          <p className="small muted">Mastered = next review 21 days or more away. Leech = forgotten 8 times: try a new mnemonic in Excel.</p>
        </section>
        {Object.keys(devices).length > 0 && (
          <section className="stack">
            <h2>Devices</h2>
            <table className="plain">
              <tbody>
                {Object.entries(devices).map(([d, n]) => (
                  <tr key={d}>
                    <td>{d}{d === device ? ' (this device)' : ''}</td>
                    <td>{n} reviews</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        )}
      </div>
    </div>
  );
}

export function Report() {
  const meta = useApp((s) => s.meta);
  if (!meta) return <div className="main"><TopBar title="Import report" back="#/settings" /><p className="muted">Import your Excel file first.</p></div>;
  const fixes = meta.issues.filter((i) => i.level === 'fix');
  const infos = meta.issues.filter((i) => i.level === 'info');
  const Table = ({ rows }: { rows: typeof meta.issues }) => (
    <table className="plain small">
      <thead>
        <tr><th>Where</th><th>Word</th><th>Problem</th><th>Suggestion</th></tr>
      </thead>
      <tbody>
        {rows.map((i, k) => (
          <tr key={k}>
            <td style={{ whiteSpace: 'nowrap' }}>{i.sheet} {i.col ?? ''}{i.row}</td>
            <td className="zh">{i.hanzi}</td>
            <td>{i.problem}</td>
            <td>{i.suggestion}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
  return (
    <div className="main wide">
      <TopBar title="Import report" back="#/settings" />
      <div className="stack-l">
        <p className="muted">
          {meta.source.name}, imported {new Date(meta.importedAt).toLocaleString()}{meta.device ? ` on ${meta.device}` : ''}. Until a cell is fixed in Excel, the app uses the suggestion.
        </p>
        <table className="plain small">
          <thead><tr><th>Sheet</th><th>Read as</th><th>Rows</th><th>Notes</th><th>Green</th></tr></thead>
          <tbody>
            {meta.report.map((r) => (
              <tr key={r.name}>
                <td>{r.name}</td><td>{r.kind === 'skipped' ? 'skipped' : r.kind}</td><td>{r.rows}</td><td>{r.notes}</td><td>{r.studied}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <section className="stack">
          <h2>To fix in Excel ({fixes.length})</h2>
          {fixes.length ? <Table rows={fixes} /> : <p className="muted">Nothing to fix.</p>}
        </section>
        <section className="stack">
          <h2>Notes ({infos.length})</h2>
          <p className="small muted">Handled automatically: converted formats, merged repeats, possible neutral tones.</p>
          {infos.length > 0 && <Table rows={infos} />}
        </section>
      </div>
    </div>
  );
}
