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
    await pg.get_by_role('button', name='Close').first.click()
    await pg.get_by_role('tab', name='HSK五级').wait_for()


async def sheets_checks(pg, ctx, word):
    hanzi = word[0]
    cdp = await ctx.new_cdp_session(pg)
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Sheets: no sideways scroll')

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


async def main():
    async with async_playwright() as p:
        phones = (
            ('iPhone 13', p.devices['iPhone 13']),
            ('390x844', {'viewport': {'width': 390, 'height': 844}, 'device_scale_factor': 3, 'is_mobile': True, 'has_touch': True}),
        )
        for name, args in phones:
            for scheme in ('light', 'dark'):
                await run(p, name, scheme, args)
    sys.exit(1 if fail else 0)

asyncio.run(main())
