"""Perf and stability probe on the preview build: iPhone 13 emulation, CPU throttled 4x, a Hugo-sized synthetic workbook
(make_big.py, 1,810 notes) and 8,000 review events seeded in the page. Plan 2026-11-26-boot-and-guards D10 / WP5.
Measures, with "Try new animations" off and then on: cold and warm boot (first row, long tasks, hz:cards), the first Grammar
visit, sheet tabs, back to a kept tab, peek, status change, word panel; each repeated PERF_RUNS times (median judged).
Budgets are soft (exit 0) unless PERF_STRICT=1; a flow that breaks (its target never appears) always exits 1.
Env: HUGO_URL, E2E_OUT (perf.json), PERF_RUNS (3), PERF_STRICT, PERF_MOTION (off|on|both, default both), GITHUB_STEP_SUMMARY.
Only a generated workbook is used (HUGO_XLSX is ignored); nothing personal is read or written."""
import asyncio
import json
import os
import statistics
import sys
import time

from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from make_big import make  # noqa: E402

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
OUT = os.environ.get('E2E_OUT', 'e2e-out')
RUNS = max(1, int(os.environ.get('PERF_RUNS', '3')))
STRICT = os.environ.get('PERF_STRICT') == '1'
MODES = {'off': [False], 'on': [True], 'both': [False, True]}[os.environ.get('PERF_MOTION', 'both')]
SUMMARY = os.environ.get('GITHUB_STEP_SUMMARY')
os.makedirs(OUT, exist_ok=True)

# Budgets (ms unless noted); soft unless PERF_STRICT=1.
B_TAB, B_BACK, B_PEEK, B_STATUS, B_BOOT, B_BOOT_P4, B_TASK_P4 = 150, 50, 50, 150, 1200, 800, 200
# With "Try new animations" on, a screen change is a View Transition: the browser captures the old page before the new
# one is drawn, ≈ 110 ms more at 4× on a long Sheets list (measured 136–281 ms, median 164). Not a regression; the
# animation's own cost. Motion off keeps 50 ms.
B_BACK_MOTION = 200

INIT = r"""
window.__lt = []; window.__first = {};
try { new PerformanceObserver(l => { for (const e of l.getEntries()) __lt.push([e.startTime, e.duration]); }).observe({ type: 'longtask', buffered: true }); } catch (e) {}
try { delete window.showDirectoryPicker; } catch (e) {}
window.__vis = el => !!el && el.getClientRects().length > 0;
// An empty frame: no displayed screen with content, or the busy placeholder showing.
window.__empty = () => {
  const ms = [...document.querySelectorAll('.shell > .main, .shell > main')].filter(__vis);
  return ms.length === 0 || ms.some(m => m.matches('[aria-busy=true]')) || !ms.some(m => m.children.length > 0);
};
// Runs `act`, then watches until `target` (an expression) is true; counts empty frames and long tasks until 300 ms later.
window.__run = (act, target) => new Promise(res => {
  const A = new Function(act), T = new Function('return (' + target + ')');
  const t0 = performance.now(); let seen = null, frames = 0, empty = 0, done = false;
  const check = () => { if (seen === null) { let ok = false; try { ok = !!T(); } catch (e) {} if (ok) seen = performance.now(); } };
  const mo = new MutationObserver(check);
  mo.observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  const finish = r => { if (!done) { done = true; mo.disconnect(); res(r); } };
  const kill = setTimeout(() => finish({ timeout: true }), 15000);
  try { A(); } catch (e) { clearTimeout(kill); return finish({ error: String(e) }); }
  check();
  const tick = () => {
    frames++; if (__empty()) empty++; check();
    if (seen !== null && performance.now() - seen > 300) {
      clearTimeout(kill);
      setTimeout(() => {
        const end = seen + 300, lt = __lt.filter(x => x[0] + x[1] >= t0 && x[0] <= end);
        finish({ ms: +(seen - t0).toFixed(1), frames, empty, tasks: lt.length, longest: Math.round(Math.max(0, ...lt.map(x => x[1]))) });
      }, 250);
    } else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
});
const mo = new MutationObserver(() => {
  if (__first.row !== undefined) return;
  const r = document.querySelector('.ql-row');
  if (!r || !__vis(r)) return;
  __first.row = performance.now(); mo.disconnect();
  requestAnimationFrame(() => { __first.paint = performance.now();
    if (sessionStorage.getItem('perf-grammar') === '1') {
      sessionStorage.removeItem('perf-grammar');
      __run("[...document.querySelectorAll('nav a[href=\"#/grammar\"]')].find(__vis).click()", "[...document.querySelectorAll('.gr')].some(__vis)").then(r => { window.__gr = r; });
    } });
  setTimeout(() => { if (__first.paint === undefined) __first.paint = performance.now(); }, 150);
});
document.addEventListener('DOMContentLoaded', () => mo.observe(document.documentElement, { subtree: true, childList: true }));
"""

BOOT_JS = """() => {
  const p = __first.paint ?? __first.row, lt = __lt;
  const cards = performance.getEntriesByName('hz:cards', 'measure')[0];
  const mx = a => Math.round(Math.max(0, ...a.map(x => x[1])));
  return { row: Math.round(__first.row), paint: Math.round(p),
    before: mx(lt.filter(x => x[0] < p)), after: mx(lt.filter(x => x[0] >= p && x[0] <= p + 2000)),
    cards: cards ? { ms: Math.round(cards.duration), ...(cards.detail || {}) } : null };
}"""

SEED_JS = """async () => {
  const db = await new Promise((res, rej) => { const r = indexedDB.open('hugo-zhongwen'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); });
  const notes = await new Promise((res, rej) => { const q = db.transaction('notes').objectStore('notes').getAll(); q.onsuccess = () => res(q.result); q.onerror = () => rej(q.error); });
  const vocab = notes.filter(n => n.kind !== 'grammar').map(n => n.id), gram = notes.filter(n => n.kind === 'grammar').map(n => n.id);
  let s = 12345; const rnd = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const now = Date.now(), N = 8000, span = 60 * 864e5, rows = [];
  for (let i = 0; i < N; i++) {
    const t = Math.round(now - span + (i + rnd()) * (span / N)), u = rnd(), g = rnd(), d = new Date(t);
    let card;
    if (u < 0.7 || !gram.length) card = vocab[Math.floor(rnd() * vocab.length)] + '#recog';
    else if (u < 0.95) card = vocab[Math.floor(rnd() * vocab.length)] + '#recall';
    else card = gram[Math.floor(rnd() * gram.length)] + '#grammar';
    rows.push({ id: 'perf-' + i, card, r: g < 0.10 ? 1 : g < 0.25 ? 2 : g < 0.85 ? 3 : 4, t, d: 2000 + Math.floor(rnd() * 7000), m: 'type',
      dev: 'windows-perf0001', mo: d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') });
  }
  await new Promise((res, rej) => { const tx = db.transaction('events', 'readwrite'), st = tx.objectStore('events');
    rows.forEach(r => st.put(r)); tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  db.close();
  return [vocab.length, gram.length, rows.length];
}"""

DEL_MEMO_JS = """() => new Promise((res, rej) => { const r = indexedDB.open('hugo-zhongwen'); r.onsuccess = () => {
  const db = r.result, tx = db.transaction('kv', 'readwrite'); tx.objectStore('kv').delete('cardsMemo');
  tx.oncomplete = () => { db.close(); res(1); }; tx.onerror = () => rej(tx.error); }; r.onerror = () => rej(r.error); })"""

MEMO_AT_JS = """() => new Promise(res => { const r = indexedDB.open('hugo-zhongwen'); r.onsuccess = () => {
  const db = r.result, q = db.transaction('kv').objectStore('kv').get('cardsMemo');
  q.onsuccess = () => { db.close(); res(q.result && q.result.v ? q.result.v.at : 0); }; q.onerror = () => { db.close(); res(0); }; }; r.onerror = () => res(0); })"""

BUSY_JS = "() => { let best = 1e9; for (let k = 0; k < 3; k++) { const t = performance.now(); let x = 0; for (let i = 0; i < 3e6; i++) x += i % 7; best = Math.min(best, performance.now() - t); } return best; }"

VIS_ROWS = "[...document.querySelectorAll('.ql-row')].filter(__vis)"

results = {}
broken = []


def med(xs):
    return statistics.median(xs) if xs else None


def summarise(name, samples, budget=None, extra=None):
    """samples: dicts from __run (ms, empty, longest, kept). Returns the table row."""
    ms = [s['ms'] for s in samples if 'ms' in s]
    return {
        'action': name, 'n': len(ms), 'min': min(ms) if ms else None, 'median': med(ms), 'max': max(ms) if ms else None,
        'budget': budget, 'longest': max([s.get('longest', 0) for s in samples] or [0]),
        'empty': sum(s.get('empty', 0) for s in samples),
        'kept': (all(s['kept'] for s in samples if 'kept' in s) if any('kept' in s for s in samples) else None),
        'note': extra,
    }


def judge(row, limit_ms=None, empty0=False, kept=False, task=None):
    why = []
    if limit_ms is not None and (row['median'] is None or row['median'] >= limit_ms):
        why.append('median %s ms >= %s' % (None if row['median'] is None else round(row['median']), limit_ms))
    if empty0 and row['empty'] > 0:
        why.append('%d empty frames' % row['empty'])
    if kept and row['kept'] is False:
        why.append('scroll lost')
    if task is not None and row['longest'] >= task:
        why.append('long task %d ms >= %d' % (row['longest'], task))
    row['result'] = 'ok' if not why else 'SLOW (' + '; '.join(why) + ')'
    return row


async def run(pg, act, target, name):
    r = await pg.evaluate('([a, t]) => __run(a, t)', [act, target])
    if 'ms' not in r:
        broken.append('%s: %s' % (name, r))
        raise RuntimeError('flow broken: %s %s' % (name, r))
    return r


async def settle(pg, ms=700):
    await asyncio.sleep(ms / 1000)


async def go_sheets(pg):
    await pg.evaluate("location.hash = '#/sheets'")
    await pg.locator('.ql-row:visible').first.wait_for(timeout=30000)
    await settle(pg)


async def pick_row(pg, scroll, need=None):
    """Scrolls to `scroll`, then returns the id of the k-th row fully in the viewport (below the sticky header) that has `need`."""
    await pg.evaluate('y => window.scrollTo(0, y)', scroll)
    await settle(pg, 500)
    return await pg.evaluate("""([need]) => { const rows = %s; const h = innerHeight;
      const ok = rows.filter(r => { const b = r.getBoundingClientRect(); return b.top > 170 && b.bottom < h - 110 && (!need || r.querySelector(need)); });
      return ok.length ? ok[Math.min(ok.length - 1, (window.__pickN = ((window.__pickN || 0) + 1) %% 3))].id : null; }""" % VIS_ROWS, [need])


async def boot_once(pg, kind):
    """kind: cold | warm | grammar. Returns the boot dict (+ 'gr' for grammar)."""
    await pg.evaluate("location.hash = '#/sheets'")
    if kind == 'grammar':
        await pg.evaluate("sessionStorage.setItem('perf-grammar', '1')")
    await pg.reload()
    await pg.locator('.ql-row:visible').first.wait_for(timeout=60000)
    if kind == 'grammar':
        await pg.wait_for_function('window.__gr !== undefined', timeout=30000)
        await asyncio.sleep(1.0)
        gr = await pg.evaluate('window.__gr')
        if 'ms' not in gr:
            broken.append('first Grammar visit: %s' % gr)
            raise RuntimeError('flow broken: first Grammar visit %s' % gr)
        return gr
    await asyncio.sleep(2.4)
    return await pg.evaluate(BOOT_JS)


def boot_row(name, boots, limit, task_limit):
    ms = [b['paint'] for b in boots]
    longest = max(max(b['before'], b['after']) for b in boots)
    c = boots[-1].get('cards')
    note = ('hz:cards %dms, %s/%s cached%s' % (c['ms'], c.get('cached'), c.get('total'), ', full replay' if c.get('full') else '')) if c else 'no hz:cards'
    row = {'action': name, 'n': len(ms), 'min': min(ms), 'median': med(ms), 'max': max(ms), 'budget': limit, 'longest': longest,
           'empty': None, 'kept': None, 'note': note + '; before row %d ms, after %d ms' % (max(b['before'] for b in boots), max(b['after'] for b in boots))}
    return judge(row, limit_ms=limit, task=task_limit)


async def measure_mode(pg, cdp, motion, first_words):
    mode = 'motion on' if motion else 'motion off'
    rows = []
    await pg.evaluate("v => localStorage.setItem('hz.motion', v)", 'true' if motion else 'false')
    await go_sheets(pg)
    print('--', mode, flush=True)

    # 1 and 2: boot cold and warm; 3: first Grammar visit
    has_cards = None
    cold, warm, gram = [], [], []
    try:
        await asyncio.sleep(4)
        for i in range(RUNS):
            await pg.evaluate(DEL_MEMO_JS)
            t0 = int(time.time() * 1000) - 1000
            cold.append(await boot_once(pg, 'cold'))
            if has_cards is None:
                has_cards = cold[0]['cards'] is not None
            print('  cold', cold[-1], flush=True)
            if has_cards:
                ok = False
                for _ in range(40):
                    if await pg.evaluate(MEMO_AT_JS) > t0:
                        ok = True
                        break
                    await asyncio.sleep(0.25)
                if not ok:
                    broken.append('warm boot: cardsMemo never written (%s)' % mode)
                    raise RuntimeError('cardsMemo never written')
                warm.append(await boot_once(pg, 'warm'))
                print('  warm', warm[-1], flush=True)
            gram.append(await boot_once(pg, 'grammar'))
            print('  grammar', gram[-1], flush=True)
    except Exception as e:  # noqa: BLE001
        print('  boot flow stopped:', e, flush=True)
    if cold:
        task = B_TASK_P4 if has_cards else None
        rows.append(boot_row('boot cold (first row)', cold, B_BOOT, task))
    if has_cards and warm:
        rows.append(boot_row('boot warm (first row)', warm, B_BOOT_P4, B_TASK_P4))
    elif cold:
        rows.append({'action': 'boot warm (first row)', 'n': 0, 'min': None, 'median': None, 'max': None, 'budget': B_BOOT_P4, 'longest': 0,
                     'empty': None, 'kept': None, 'note': 'no hz:cards in this build', 'result': 'n/a'})
    if gram:
        rows.append(judge(summarise('first Grammar visit', gram), empty0=True))

    # actions run on Sheets, with the kept screens visited once first
    try:
        await go_sheets(pg)
        for h, sel in (('grammar', '.gr'), ('settings', '.groups')):
            await pg.evaluate("h => location.hash = '#/' + h", h)
            await pg.locator(sel + ':visible').first.wait_for(timeout=30000)
            await settle(pg)
        await go_sheets(pg)
        hz = lambda sheet: "(() => { const r = %s[0]; return !!r && r.querySelector('.ql-hz').textContent === %s; })()" % (VIS_ROWS, json.dumps(first_words[sheet]))
        tab = lambda name: ("[...document.querySelectorAll('.hs-tab')].filter(__vis).find(b => b.textContent.startsWith(%s)).click()" % json.dumps(name),
                            "(() => { const b = [...document.querySelectorAll('.hs-tab')].filter(__vis).find(b => b.textContent.startsWith(%s)); return !!b && b.getAttribute('aria-selected') === 'true'; })() && %s" % (json.dumps(name), hz('HSK四级' if name == 'All' else name)))
        tabs, backs, peeks, stats, panels = [], [], [], [], []
        for i in range(RUNS):
            await pg.evaluate('window.scrollTo(0, 0)')
            await settle(pg, 400)
            for name in ('HSK四级', 'HSK五级', 'All'):
                tabs.append(await run(pg, *tab(name), 'sheet tab ' + name))
                await settle(pg)
        rows.append(judge(summarise('sheet tab', tabs, B_TAB), limit_ms=B_TAB, empty0=True))
        print('  tabs', [t['ms'] for t in tabs], flush=True)

        for i in range(RUNS):
            for other, sel in (('grammar', '.gr'), ('settings', '.groups')):
                await pg.evaluate('window.scrollTo(0, 3000)')
                await settle(pg, 500)
                before = await pg.evaluate('scrollY')
                await pg.evaluate("h => location.hash = '#/' + h", other)
                await pg.locator(sel + ':visible').first.wait_for(timeout=30000)
                await settle(pg, 900)
                r = await run(pg, "location.hash = '#/sheets'", "%s.length > 0" % VIS_ROWS, 'back to Sheets from ' + other)
                await settle(pg, 400)
                after = await pg.evaluate('scrollY')
                r['kept'] = abs(after - before) <= 2 and before > 100
                backs.append(r)
        b_back = B_BACK_MOTION if motion else B_BACK
        rows.append(judge(summarise('back to a tab (Sheets)', backs, b_back), limit_ms=b_back, empty0=True, kept=True))
        print('  backs', [(t['ms'], t['kept']) for t in backs], flush=True)

        for i in range(RUNS):
            rid = await pick_row(pg, 0 if i == 0 else 400 * i, '.ql-mn .ql-hide')
            if not rid:
                broken.append('peek: no row with a hidden meaning')
                raise RuntimeError('peek: no row')
            sel = "document.getElementById(%s)" % json.dumps(rid)
            peeks.append(await run(pg, "%s.querySelector('.ql-mn').click()" % sel, "!!%s.querySelector('.ql-mn .peek')" % sel, 'peek'))
            await settle(pg, 400)
        rows.append(judge(summarise('peek (hidden meaning)', peeks, B_PEEK), limit_ms=B_PEEK))
        print('  peek', [t['ms'] for t in peeks], flush=True)

        # Every HSK四级 row starts Mastered whatever its colour, so changes are measured on HSK五级 (mixed colours).
        await run(pg, *tab('HSK五级'), 'sheet tab HSK五级')
        await settle(pg)
        for i in range(RUNS):
            rid = await pick_row(pg, 600 + 300 * i, 'button.status-chip:not([aria-label$="Mastered"])')
            if not rid:
                broken.append('status: no row to change')
                raise RuntimeError('status: no row')
            sel = "document.getElementById(%s)" % json.dumps(rid)
            await pg.evaluate("() => %s.querySelector('button.status-chip').click()" % sel)
            await pg.locator('[role=menuitemradio]').first.wait_for(timeout=10000)
            await settle(pg, 400)
            stats.append(await run(pg, "[...document.querySelectorAll('[role=menuitemradio]')].find(e => /Mastered/.test(e.textContent)).click()",
                                   "%s.querySelector('button.status-chip').getAttribute('aria-label') === 'Status: Mastered'" % sel, 'status apply'))
            await settle(pg, 900)
        rows.append(judge(summarise('status apply (Mastered)', stats, B_STATUS), limit_ms=B_STATUS))
        print('  status', [t['ms'] for t in stats], flush=True)

        for i in range(RUNS):
            rid = await pick_row(pg, 1200, '.ql-hz .peek')
            if not rid:
                broken.append('panel: no row')
                raise RuntimeError('panel: no row')
            before = await pg.evaluate('scrollY')
            sel = "document.getElementById(%s)" % json.dumps(rid)
            r = await run(pg, "%s.querySelector('.ql-hz').click()" % sel, "[...document.querySelectorAll('.pp-panel')].some(__vis)", 'word panel')
            await settle(pg, 800)
            await pg.evaluate("document.querySelector('.pp-panel .pp-close').click()")
            await pg.wait_for_function("document.querySelectorAll('.pp-panel').length === 0", timeout=5000)
            await settle(pg, 600)
            r['kept'] = abs(await pg.evaluate('scrollY') - before) <= 2
            panels.append(r)
        rows.append(judge(summarise('word panel open (scrolled 1200)', panels), kept=True))
        print('  panel', [(t['ms'], t['kept']) for t in panels], flush=True)
    except Exception as e:  # noqa: BLE001
        print('  action flow stopped:', e, flush=True)
        if not broken:
            broken.append(str(e))
    return rows


def fmt(v):
    return '-' if v is None else (str(round(v)) if isinstance(v, (int, float)) else str(v))


def table_text(rows):
    head = ['action', 'n', 'min', 'median', 'max', 'budget', 'longest task', 'empty frames', 'scroll kept', 'result']
    lines = [head]
    for r in rows:
        lines.append([r['action'], fmt(r['n']), fmt(r['min']), fmt(r['median']), fmt(r['max']), fmt(r['budget']), fmt(r['longest']),
                      fmt(r['empty']), '-' if r['kept'] is None else ('yes' if r['kept'] else 'NO'), r['result']])
    w = [max(len(str(l[i])) for l in lines) for i in range(len(head))]
    txt = '\n'.join('  '.join(str(c).ljust(w[i]) for i, c in enumerate(l)) for l in lines)
    md = '| ' + ' | '.join(head) + ' |\n|' + '---|' * len(head) + '\n' + '\n'.join('| ' + ' | '.join(str(c) for c in l) + ' |' for l in lines[1:])
    notes = [r for r in rows if r.get('note')]
    return txt + ''.join('\n  - %s: %s' % (r['action'], r['note']) for r in notes), md


async def main():
    t_start = time.time()
    big = os.path.join(OUT, 'perf-synthetic.xlsx')
    first_words = make(big)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context(**p.devices['iPhone 13'], bypass_csp=True, service_workers='block')
        await ctx.add_init_script(INIT)
        pg = await ctx.new_page()
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        cdp = await ctx.new_cdp_session(pg)
        await pg.goto(U)
        await pg.goto(U + '#/settings')
        await asyncio.sleep(1)
        await pg.locator('.main:visible input[type=file][accept*=xlsx]').first.set_input_files(big)
        await pg.goto(U + '#/sheets')
        await pg.locator('.ql-row:visible').first.wait_for(timeout=60000)
        await asyncio.sleep(2)
        seeded = await pg.evaluate(SEED_JS)
        print('imported and seeded (vocab, grammar, events):', seeded, flush=True)
        if seeded[2] != 8000 or seeded[0] < 1000:
            broken.append('setup: seeded %s' % seeded)
        # CPU 4x, and check it still applies after a reload
        base = await pg.evaluate(BUSY_JS)
        await cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
        slow = await pg.evaluate(BUSY_JS)
        await pg.reload()
        await pg.locator('.ql-row:visible').first.wait_for(timeout=60000)
        again = await pg.evaluate(BUSY_JS)
        if again < base * 2:
            await cdp.send('Emulation.setCPUThrottlingRate', {'rate': 4})
            again2 = await pg.evaluate(BUSY_JS)
            print('WARNING: throttle was lost by the reload (%.0f vs %.0f ms), set again: %.0f ms' % (again, base, again2), flush=True)
            again = again2
        throttle = {'unthrottled_ms': round(base), 'throttled_ms': round(slow), 'after_reload_ms': round(again)}
        print('cpu throttle check', throttle, flush=True)
        all_rows = {}
        for motion in MODES:
            rows = await measure_mode(pg, cdp, motion, first_words)
            all_rows['motion on' if motion else 'motion off'] = rows
        await b.close()
    secs = round(time.time() - t_start)
    md_all = []
    for mode, rows in all_rows.items():
        txt, md = table_text(rows)
        print('\n== %s ==\n%s' % (mode, txt))
        md_all.append('#### perf.py, %s (iPhone 13, CPU 4x, %d runs)\n\n%s\n' % (mode, RUNS, md))
    slow_rows = [(m, r['action'], r['result']) for m, rows in all_rows.items() for r in rows if r['result'].startswith('SLOW')]
    print('\nrun time %d s; slow: %d; broken: %d; page errors: %d' % (secs, len(slow_rows), len(broken), len(errs)))
    for e in errs[:5]:
        print('  page error:', e[:200])
    json.dump({'runs': RUNS, 'throttle': throttle, 'seconds': secs, 'modes': all_rows, 'broken': broken, 'pageErrors': errs[:20]},
              open(os.path.join(OUT, 'perf.json'), 'w'), indent=1, ensure_ascii=False)
    if SUMMARY:
        with open(SUMMARY, 'a') as f:
            f.write('\n'.join(md_all) + ('\nBroken flows: %s\n' % broken if broken else ''))
    try:
        os.remove(big)
    except OSError:
        pass
    if broken:
        print('FAIL: broken flow(s):', broken)
        sys.exit(1)
    if STRICT and slow_rows:
        print('FAIL (PERF_STRICT=1): budgets missed:', slow_rows)
        sys.exit(1)
    print('done (soft budgets%s)' % (' not met' if slow_rows else ' met'))


asyncio.run(main())
