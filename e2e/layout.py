"""Run against the preview build. Phone layout checks, light and dark, on iPhone 13 emulation and a plain 390x844 phone:
- Cards: for each answer type the field (or the writing pad) and the Check button (Draw: Show answer) are inside the
  viewport with no page scroll, and nothing on screen shows the answer before Check.
- Sheets: the word panel's top edge is the same on two different words; the status menu and the filter menu close on a
  downward touch drag (CDP Input.dispatchTouchEvent); a list answer field turns green for 少 and red for 2 on 少 shǎo;
  a tone-1 pinyin span and a Not known chip have different computed colours; no sideways scroll.
Synthetic workbook from make_sample.py (no personal data). Screenshots are not taken; nothing is written to E2E_OUT except
the generated sample workbook."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
if not XLSX:
    os.makedirs(S, exist_ok=True)
    XLSX = S + 'layout-sample.xlsx'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


def first_word():
    """(hanzi, pinyin with tone marks, English) of the first vocabulary row of the first sheet."""
    from openpyxl import load_workbook
    ws = load_workbook(XLSX).worksheets[0]
    for r in ws.iter_rows(min_row=2, values_only=True):
        cells = [str(c) for c in r if c is not None]
        for i, h in enumerate(cells):
            if any('一' <= ch <= '鿿' for ch in h) and i + 2 < len(cells):
                return h, cells[i + 1], cells[i + 2]
    raise SystemExit('no word in the sample workbook')


async def boot(p, ctx_args):
    b = await p.chromium.launch()
    ctx = await b.new_context(**ctx_args)
    pg = await ctx.new_page()
    errs = []
    pg.on('pageerror', lambda e: errs.append(str(e)))
    await pg.goto(U)
    await pg.evaluate('navigator.serviceWorker.ready.then(() => 1)')
    await pg.goto(U + '#/settings')
    await pg.locator('input[type=file][accept*=xlsx]').first.set_input_files(XLSX)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for(timeout=15000)
    await pg.locator('.ql-row').first.wait_for()
    return b, ctx, pg, errs


async def drag_down(cdp, x, y, dist=280, steps=14):
    """A finger drag downwards, as real touch input."""
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        await asyncio.sleep(0.012)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + dist * i / steps}]})
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


async def inside(pg, loc, what):
    """The element's box lies fully inside the viewport."""
    vw, vh = await pg.evaluate('[innerWidth, innerHeight]')
    box = await loc.bounding_box()
    ok = bool(box) and box['x'] >= 0 and box['y'] >= 0 and box['x'] + box['width'] <= vw + 0.5 and box['y'] + box['height'] <= vh + 0.5
    check(ok, f'{what} inside the {vw}x{vh} viewport' + ('' if ok else f' (box {box})'))


async def no_scroll(pg, what):
    ok = await pg.evaluate('(() => { const e = document.scrollingElement; return e.scrollHeight <= innerHeight && e.scrollWidth <= innerWidth && scrollY === 0 })()')
    check(ok, f'{what}: no page scroll')


async def answer_type(pg, label):
    await pg.get_by_role('button', name='Cards settings').click()
    dlg = pg.get_by_role('dialog', name='Cards settings')
    await dlg.get_by_role('group', name='Answer with').get_by_role('button', name=label, exact=True).click()
    await dlg.get_by_role('button', name='Close').click()
    await dlg.wait_for(state='hidden')
    await pg.wait_for_timeout(300)


async def cards_checks(pg, word):
    hanzi, pinyin, english = word
    await pg.get_by_role('group', name='View').get_by_role('button', name='Cards').click()
    await pg.locator('.qk-count').wait_for()
    # The first card of the All deck is the first row of the first sheet.
    secrets = {
        'Hanzi': [hanzi],
        'Pinyin': [pinyin, re.sub(r'\s+', ' ', pinyin)],
        'French': [english],
        'Draw': [hanzi],
    }
    for label in ('Hanzi', 'Pinyin', 'French', 'Draw'):
        await pg.get_by_role('button', name='Cards settings').click()
        dlg = pg.get_by_role('dialog', name='Cards settings')
        await dlg.get_by_role('group', name='Answer with').get_by_role('button', name=label, exact=True).click()
        await dlg.get_by_role('button', name='Close').click()
        await dlg.wait_for(state='hidden')
        await pg.wait_for_timeout(300)
        if label == 'Draw':
            await pg.locator('.qk-padbox .pad-cell').first.wait_for()
            await inside(pg, pg.locator('.qk-padbox .pad-cell').first, f'{label}: the pad')
            await inside(pg, pg.get_by_role('button', name='Show answer'), f'{label}: Show answer')
        else:
            await inside(pg, pg.locator('.qk-input'), f'{label}: the field')
            await inside(pg, pg.get_by_role('button', name='Check'), f'{label}: Check')
        await no_scroll(pg, f'Cards, {label}')
        # Nothing the reader can see or hear about (text, labels, titles, placeholders) holds the answer yet.
        seen = await pg.evaluate("""() => {
          const root = document.querySelector('.cd');
          const bits = [root.innerText];
          for (const e of root.querySelectorAll('*')) for (const a of ['aria-label', 'title', 'placeholder', 'alt', 'value'])
            if (e.getAttribute(a)) bits.push(e.getAttribute(a));
          return bits.join(' | ').replace(/\\s+/g, ' ').toLowerCase();
        }""")
        leaked = [s for s in secrets[label] if s.lower() in seen]
        check(not leaked, f'{label}: no answer text before Check' + (f' (found {leaked})' if leaked else ''))
    # Checking an answer must not move the card or the dock, and must keep the focus in the field (on the iPhone a lost
    # focus closes the keyboard and the whole screen drops; plan 2026-11-24-stability-speed F1).
    await answer_type(pg, 'Pinyin')
    field = pg.locator('.qk-input')
    await field.focus()
    await field.fill('x')
    before = (await pg.locator('.qk-card').bounding_box(), await pg.locator('.qk-dock').bounding_box())
    await pg.get_by_role('button', name='Check').click()
    await pg.locator('.qk-verdict').wait_for()
    after = (await pg.locator('.qk-card').bounding_box(), await pg.locator('.qk-dock').bounding_box())
    moved = [round(abs(a['y'] - b['y']) + abs(a['height'] - b['height'])) for a, b in zip(before, after)]
    check(max(moved) <= 1, f'Cards: Check moves neither the card nor the dock (moved {moved} px)')
    check(await pg.evaluate("document.activeElement?.classList.contains('qk-input')"), 'Cards: the field keeps the focus after Check')
    await pg.get_by_role('button', name='Next').click()
    check(await pg.evaluate("document.activeElement?.classList.contains('qk-input')"), 'Cards: the field keeps the focus after Next')
    await pg.get_by_role('button', name='Close').first.click()
    await pg.get_by_role('tab', name='HSK五级').wait_for()


async def sheets_checks(pg, ctx, word):
    hanzi = word[0]
    cdp = await ctx.new_cdp_session(pg)
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Sheets: no sideways scroll')

    # Two-line phone rows (plan 2026-11-17): no id column, tags on line 1, meaning + answer on line 2.
    row = pg.locator('.ql-row').first
    check(not await row.locator('.ql-lead').is_visible(), 'phone rows hide the id column')
    check(not await row.locator('.hs-practise').is_visible(), 'phone rows hide the Practise pencil')
    hz, trail, mn, ans = [await row.locator(c).bounding_box() for c in ('.ql-hz', '.ql-trail', '.ql-mn', '.ql-answer')]
    rbox = await row.bounding_box()
    mid = lambda b: b['y'] + b['height'] / 2
    check(abs(mid(trail) - mid(hz)) < 10, f'row tags on the hanzi line (trail mid {mid(trail):.0f}, hanzi mid {mid(hz):.0f})')
    check(mn['width'] >= 180, f'meaning cell {mn["width"]:.0f} px wide (>= 180)')
    check(ans['width'] >= 112, f'answer field {ans["width"]:.0f} px wide (>= 112)')
    check(rbox['height'] <= 100, f'row {rbox["height"]:.0f} px tall (<= 100)')

    # Typing: the tab bar hides while a field has focus, and comes back after.
    field = row.locator('.ql-ans input')
    await field.focus()
    check(not await pg.locator('nav.nav').is_visible(), 'tab bar hidden while typing')
    await field.evaluate('e => e.blur()')
    check(await pg.locator('nav.nav').is_visible(), 'tab bar back after typing')

    # Word panel: the same top edge for two different words.
    tops = []
    for idx in (0, 5):
        row = pg.locator('.ql-row').nth(idx)
        name = (await row.locator('.ql-hz').get_attribute('aria-label')).strip()
        await row.locator('.ql-hz').click()
        dlg = pg.get_by_role('dialog', name=name)
        await dlg.wait_for()
        await pg.wait_for_timeout(700)
        box = await dlg.bounding_box()
        tops.append((name, box['y']))
        await dlg.get_by_role('button', name='Close').first.click()
        await dlg.wait_for(state='hidden')
    check(abs(tops[0][1] - tops[1][1]) < 1, f'word panel top edge {tops[0][1]:.1f} ({tops[0][0]}) = {tops[1][1]:.1f} ({tops[1][0]})')

    # Status menu closes on a downward drag; then set Not known (for the colour check below).
    await pg.locator('.ql-row').first.get_by_role('button', name=re.compile('^Status:')).click()
    dlg = pg.get_by_role('dialog', name=f'Status of {hanzi}')
    await dlg.wait_for()
    await pg.wait_for_timeout(500)
    box = await dlg.bounding_box()
    await drag_down(cdp, box['x'] + box['width'] / 2, box['y'] + 18)
    try:
        await dlg.wait_for(state='hidden', timeout=3000)
        check(True, 'status menu closes on a downward touch drag')
    except Exception:
        check(False, 'status menu closes on a downward touch drag')
        await pg.keyboard.press('Escape')
    await pg.locator('.ql-row').first.get_by_role('button', name=re.compile('^Status:')).click()
    await pg.get_by_role('dialog', name=f'Status of {hanzi}').wait_for()
    await pg.get_by_role('menuitemradio', name='Not known').click()
    await pg.get_by_role('dialog', name=f'Status of {hanzi}').wait_for(state='hidden')

    # Filter menu closes on a downward drag.
    await pg.locator('.hs-filter').click()
    dlg = pg.get_by_role('dialog', name='Filter')
    await dlg.wait_for()
    await pg.wait_for_timeout(500)
    box = await dlg.bounding_box()
    await drag_down(cdp, box['x'] + box['width'] / 2, box['y'] + 18)
    try:
        await dlg.wait_for(state='hidden', timeout=3000)
        check(True, 'filter menu closes on a downward touch drag')
    except Exception:
        check(False, 'filter menu closes on a downward touch drag')
        await pg.keyboard.press('Escape')

    # Colours: a tone-1 pinyin span against the Not known chip (D1/D2 keep them apart).
    t1 = await pg.locator('.ql-row .pinyin .t1').first.evaluate('e => getComputedStyle(e).color')
    chip = await pg.locator('.sc-pill.st-notknown').first.evaluate('e => getComputedStyle(e).color')
    check(t1 != chip, f'tone-1 pinyin {t1} differs from the Not known chip {chip}')
    t1bg = await pg.locator('.sc-pill.st-notknown').first.evaluate('e => getComputedStyle(e).backgroundColor')
    check(t1bg not in ('rgba(0, 0, 0, 0)', 'transparent'), f'Not known chip has a tint ({t1bg})')

    # List answer field: 少 right, 2 wrong. Colour read from computed styles.
    await pg.get_by_role('tab', name='HSK五级').click()
    field = pg.get_by_label('Answer for 少')
    box_ = pg.locator('.ql-ans', has=field)
    await field.scroll_into_view_if_needed()
    await field.fill('少')
    await field.press('Enter')
    await pg.locator('.ql-ans.right').first.wait_for()
    await pg.wait_for_timeout(600)  # the border colour fades in
    border = await box_.evaluate('e => getComputedStyle(e).borderTopColor')
    r, g, b = [int(x) for x in re.findall(r'\d+', border)[:3]]
    check(g > r and g > b, f'answer field for 少 is green ({border})')
    await field.fill('2')
    check('right' not in (await box_.get_attribute('class')), 'editing clears the colour')
    await field.press('Enter')
    await pg.locator('.ql-ans.wrong').first.wait_for()
    await pg.wait_for_timeout(600)
    border = await box_.evaluate('e => getComputedStyle(e).borderTopColor')
    r, g, b = [int(x) for x in re.findall(r'\d+', border)[:3]]
    check(r > g and r > b, f'answer field for 2 is red ({border})')
    check(await pg.locator('.hs-wrong').count() == 0, 'a list answer leaves no Wrong tag')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Sheets: no sideways scroll with answers')


async def run(p, name, scheme, ctx_args):
    print(f'-- {name}, {scheme}')
    b, ctx, pg, errs = await boot(p, {**ctx_args, 'color_scheme': scheme})
    check(await pg.evaluate(f"matchMedia('(prefers-color-scheme: {scheme})').matches"), f'{scheme} scheme active')
    word = first_word()
    await sheets_checks(pg, ctx, word)
    await cards_checks(pg, word)
    check(not errs, f'{name}, {scheme}: no page errors' + (f' {errs}' if errs else ''))
    await b.close()


# iOS keeps the layout viewport and pans the page under the keyboard (visualViewport.offsetTop), then pans back. Fixed
# elements are laid out in layout coordinates, so what Hugo sees is rect.top - offsetTop. Chromium has no such keyboard:
# a stand-in visualViewport is driven by hand (plan 2026-11-24-stability-speed F5).
FAKE_VV = """(() => { const t = new EventTarget(); let h = innerHeight, top = 0;
  for (const [k, f] of [['height', () => h], ['offsetTop', () => top], ['width', () => innerWidth], ['offsetLeft', () => 0], ['scale', () => 1]])
    Object.defineProperty(t, k, { get: f });
  Object.defineProperty(window, 'visualViewport', { get: () => t });
  window.__vv = (nh, nt) => { h = nh; top = nt; t.dispatchEvent(new Event('resize')); t.dispatchEvent(new Event('scroll')); }; })();"""


async def cards_ios_pan(p):
    print('-- Cards under a panned iOS keyboard')
    b = await p.chromium.launch()
    ctx = await b.new_context(**p.devices['iPhone 13'])
    await ctx.add_init_script(FAKE_VV)
    pg = await ctx.new_page()
    await pg.goto(U)
    await pg.evaluate('navigator.serviceWorker.ready.then(() => 1)')
    await pg.goto(U + '#/settings')
    await pg.locator('input[type=file][accept*=xlsx]').first.set_input_files(XLSX)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for(timeout=15000)
    await pg.get_by_role('group', name='View').get_by_role('button', name='Cards').click()
    await pg.locator('.qk-card').wait_for()
    h = await pg.evaluate('innerHeight')
    seen = []
    for off in (0, 120, 60, 0):
        await pg.evaluate(f'window.__vv({h - 300}, {off})')
        await pg.wait_for_timeout(100)
        bar, card, dock = [await pg.locator(sel).bounding_box() for sel in ('.qk-bar', '.qk-card', '.qk-dock')]
        seen.append((round(bar['y'] - off), round(card['y'] - off), round(dock['y'] + dock['height'] - off)))
    check(len(set(seen)) == 1, f'Cards: bar, card and dock stay put on screen while iOS pans (seen {seen})')
    check(seen[0][2] <= h - 300 + 1, 'Cards: the dock ends above the keyboard')
    await b.close()


# iOS pans to a field that takes focus below where the keyboard will end. This stand-in does the same: at focus time it
# pans by however much the field's box (as iOS sees it then) would sit under a 336 px keyboard, and sends the
# visualViewport events 400 ms later, as iOS does after its animation. Cards must focus without being panned.
IOS_KB = 336
FAKE_IOS = """(() => { const t = new EventTarget(); let h = null, top = 0; const K = %d;
  for (const [k, f] of [['height', () => h ?? innerHeight], ['offsetTop', () => top], ['width', () => innerWidth], ['offsetLeft', () => 0], ['scale', () => 1]])
    Object.defineProperty(t, k, { get: f });
  Object.defineProperty(window, 'visualViewport', { get: () => t });
  window.__pan = -1;
  document.addEventListener('focusin', (e) => { if (!e.target.matches('input')) return;
    const r = e.target.getBoundingClientRect();
    top = r.bottom <= 0 ? 0 : Math.max(0, Math.min(K, Math.ceil(r.bottom + 12 - (innerHeight - K)))); h = innerHeight - K; window.__pan = top;
    setTimeout(() => { t.dispatchEvent(new Event('resize')); t.dispatchEvent(new Event('scroll')); }, 400); }, true); })();""" % IOS_KB


async def cards_no_pan(p):
    print('-- Cards: tapping the field on a 375x812 iPhone (stand-in iOS keyboard)')
    b = await p.chromium.launch()
    dev = dict(p.devices['iPhone 13'])
    dev['viewport'] = dev['screen'] = {'width': 375, 'height': 812}
    ctx = await b.new_context(**dev)
    await ctx.add_init_script(FAKE_IOS)
    pg = await ctx.new_page()
    await pg.goto(U)
    await pg.evaluate('navigator.serviceWorker.ready.then(() => 1)')
    await pg.goto(U + '#/settings')
    await pg.locator('input[type=file][accept*=xlsx]').first.set_input_files(XLSX)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for(timeout=15000)
    await pg.get_by_role('group', name='View').get_by_role('button', name='Cards').click()
    await pg.locator('.qk-card').wait_for()
    await pg.add_style_tag(content='.cd { --safe-t: 47px !important; --safe-b: 34px !important; }')  # iPhone safe areas
    await answer_type(pg, 'Pinyin')
    fs = await pg.evaluate("parseFloat(getComputedStyle(document.querySelector('.qk-input')).fontSize)")
    check(fs >= 16, f'Cards: field font {fs}px (>= 16: no iOS zoom)')
    await pg.wait_for_timeout(3500)  # the import toast has gone
    await pg.locator('.qk-input').tap()
    await pg.wait_for_timeout(150)
    check(await pg.evaluate('window.__pan') == 0, f'Cards: the tap focuses the field without an iOS pan (pan {await pg.evaluate("window.__pan")})')
    check(await pg.evaluate("document.activeElement?.classList.contains('qk-input')"), 'Cards: the tap focuses the field')
    vis = 812 - IOS_KB
    for phase in ('while the keyboard opens', 'keyboard open'):
        pan = await pg.evaluate('window.__pan')  # what is on screen is the layout box moved up by the pan
        boxes = {s: await pg.locator(s).bounding_box() for s in ('.qk-bar', '.qk-card', '.qk-input', '.qk-actions')}
        ok = all(bx['y'] - pan >= 0 and bx['y'] - pan + bx['height'] <= vis + 0.5 for bx in boxes.values())
        check(ok, f'Cards, {phase}: bar, card, field and buttons inside the {vis}px above the keyboard' + ('' if ok else f' {boxes}'))
        cut = await pg.evaluate("(() => { const c = document.querySelector('.qk-card'); return c.scrollHeight - c.clientHeight })()")
        check(cut <= 1, f'Cards, {phase}: nothing cut off the card ({cut}px)')
        await pg.wait_for_timeout(700)
    await no_scroll(pg, 'Cards, keyboard open')
    await b.close()


async def kept_tabs(p, motion):
    """Plan 2026-11-26-page-stability: the tab screens stay mounted. Leaving Sheets for Grammar and coming back keeps the
    page scroll, closes the word panel (portalled to <body>), and never shows an empty page on the way."""
    what = 'kept tabs' + (' (motion on)' if motion else '')
    b, ctx, pg, errs = await boot(p, dict(p.devices['iPhone 13']))
    if motion:
        await pg.evaluate("localStorage.setItem('hz.motion', 'true')")
        await pg.reload()
        await pg.locator('.ql-row').first.wait_for()
    await pg.wait_for_timeout(800)  # rows past the first ones are drawn in steps
    y = min(1200, await pg.evaluate('document.scrollingElement.scrollHeight - innerHeight'))
    await pg.evaluate(f'window.scrollTo(0, {y})')
    await pg.wait_for_timeout(200)
    # A row on screen, so the tap itself does not scroll the page.
    i = await pg.evaluate("[...document.querySelectorAll('.ql-row')].findIndex(r => { const b = r.getBoundingClientRect(); return b.top > 150 && b.bottom < innerHeight - 120 && r.querySelector('.ql-hz .peek'); })")
    row = pg.locator('.ql-row').nth(i)
    y = await pg.evaluate('scrollY')
    await row.locator('.ql-hz').click()
    await pg.locator('.pp-panel').wait_for()
    check(abs(await pg.evaluate('scrollY') - y) <= 2, f'{what}: opening the word panel keeps the page scroll ({y})')
    blank = await pg.evaluate("""() => new Promise(res => { let n = 0, f = 0; location.hash = '#/grammar';
      const t = () => { f++; const m = [...document.querySelectorAll('.shell > .main, .shell > main')].filter(e => getComputedStyle(e).display !== 'none');
        if (!m.length || m.some(e => !e.childElementCount)) n++;
        f < 30 ? requestAnimationFrame(t) : res(n); }; requestAnimationFrame(t); })""")
    check(blank == 0, f'{what}: no empty page frame on the way to Grammar ({blank})')
    await pg.locator('.gr').wait_for()
    check(await pg.locator('.pp-panel:visible').count() == 0, f'{what}: the word panel closed on leaving Sheets')
    await pg.locator('nav a[href="#/sheets"]').click()
    await pg.locator('.ql-row:visible').first.wait_for()
    await pg.wait_for_timeout(300)
    back = await pg.evaluate('scrollY')
    check(abs(back - y) <= 2, f'{what}: Sheets is back at the same scroll position ({y} → {back})')
    check(not errs, f'{what}: no page errors')
    await b.close()


async def main():
    async with async_playwright() as p:
        await kept_tabs(p, False)
        await kept_tabs(p, True)
        await cards_ios_pan(p)
        await cards_no_pan(p)
        phones = (
            ('iPhone 13', p.devices['iPhone 13']),
            ('390x844', {'viewport': {'width': 390, 'height': 844}, 'device_scale_factor': 3, 'is_mobile': True, 'has_touch': True}),
        )
        for name, args in phones:
            for scheme in ('light', 'dark'):
                await run(p, name, scheme, args)
    sys.exit(1 if fail else 0)

asyncio.run(main())
