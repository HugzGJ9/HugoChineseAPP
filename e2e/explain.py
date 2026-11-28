"""Run against the preview of a `LEXICON_SAMPLE=1 npm run build`. Plays the word panel: section order (Your list, Dictionary,
Characters, Similar words, Examples), no Claude anywhere, nested levels, Characters cards. Fully offline: no API is called.
Runs on desktop and with iPhone 13 emulation. Uses a synthetic workbook made by e2e/make_sample.py (no personal data)."""
import asyncio, json, os, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
os.makedirs(S, exist_ok=True)
XLSX = S + 'sample-explain.xlsx'
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)


def extend_sample(path):
    """Synthetic additions for Similar words: his group (16bis), a Don't confuse + Register column, a colloquial meaning."""
    from openpyxl import load_workbook
    wb = load_workbook(path)
    ws = wb['HSK五级']
    ws['E1'], ws['F1'] = "Don't confuse", 'Register'
    for r in range(2, ws.max_row + 1):
        if ws.cell(row=r, column=2).value == '朋友':
            ws.cell(row=r, column=5).value = '伙伴 | 口语 | camarade | pal, mate\n同事 | | collègue de travail | co-worker'
    ws.append(['16bis', '同伴', 'tóngbàn', 'companion, partner'])
    ws.append([19, '聊天', 'liáotiān', 'to chat (colloquial)'])
    wb.save(path)


extend_sample(XLSX)
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


async def drag_down(cdp, x, y, dist=300, steps=14):
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        await asyncio.sleep(0.012)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + dist * i / steps}]})
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


async def word_levels(pg, _unused, device):
    """Pinyin under every line, tappable lines, the level stack (plan 2026-11-23 WP1.2)."""
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    top = d.locator('.wl.top')
    # Pinyin: Tatoeba examples show it by default; a collocation with no pinyin gets it computed on the device.
    await pg.wait_for_function("() => [...document.querySelectorAll('.wx-ex .wx-py')].some(e => e.textContent.trim())", timeout=8000)
    check(True, 'Tatoeba examples show a non-empty pinyin line by default')
    # The chip hides every pinyin line, survives closing and reopening, then turns back on.
    chip = top.locator('.wx-pychip').first
    await chip.click()
    check(await top.locator('.wx-py').count() == 0, 'chip off: no pinyin line')
    await pg.keyboard.press('Escape')
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    top = d.locator('.wl.top')
    check(await top.locator('.wx-py').count() == 0, 'chip stays off after reopening')
    await top.locator('.wx-pychip').first.click()
    await top.locator('.wx-py').first.wait_for(timeout=5000)
    check(True, 'chip back on: pinyin lines are back')
    # Tappable lines: the word is bold, his words are underlined.
    # Any example works (CI runs on the real dictionary, whose ranking changes): the first one holding the panel word.
    ex = top.locator('.wx-ex .zb')
    line = ex.filter(has=pg.locator('.zt-w.head')).first
    check(await line.locator('.zt-w.head', has_text='朋友').count() >= 1, 'the panel word is bold (.head) in a Tatoeba example')
    check(await top.locator('.wx-ex .zt-w.mine').count() >= 1, 'his words in a line are marked (.mine)')
    await line.locator('.zt-w:not(.head)').first.click()
    top = d.locator('.wl.top')
    await top.locator('.sw-strip').wait_for(timeout=5000)
    check(await d.locator('.wl.top .sw-strip').count() == 1, 'tap another word in the line: a level with the sentence strip')
    back = d.locator('.pp-back')
    check('朋友' in (await back.get_attribute('aria-label') or '') and '朋友' in await back.inner_text(), 'Back button names 朋友')
    if device:
        check((await back.bounding_box())['height'] >= 44, 'Back button is at least 44 px tall')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll on a nested level')
    # Back restores the scroll.
    await back.click()
    check(await d.locator('.pp-back').count() == 0 and await d.locator('.wl.top .sw-strip').count() == 0, 'Back returns to the first level')
    # Scroll restore: scroll down, push, pop.
    tgt = d.locator('.wl.top .zt-w', has_text='朋友').first
    await tgt.scroll_into_view_if_needed()
    await d.evaluate("el => { el.scrollTop = el.scrollTop + 40 }")
    before = await d.evaluate('el => el.scrollTop')
    await tgt.click()
    await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
    check(await d.evaluate('el => el.scrollTop') <= 4, 'a new level starts at the top')
    await d.locator('.pp-back').click()
    await pg.wait_for_timeout(100)
    after = await d.evaluate('el => el.scrollTop')
    check(abs(after - before) <= 4, f'Back restores the scroll ({before:.0f} -> {after:.0f})')
    # Three levels: Esc goes up one level (desktop), then the close button closes everything.
    await d.locator('.wl.top .zt-w', has_text='朋友').first.click()
    await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
    await d.locator('.wl.top .wx-ex .zt-w:not(.head)').first.click()
    await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 3")
    check(await d.locator('.wl').count() == 3, 'three levels deep')
    if not device:
        await pg.keyboard.press('Escape')
        await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 2")
        check(await d.count() == 1, 'Esc returns to level 2')
        await d.locator('.wl.top .wx-ex .zt-w:not(.head)').first.click()
        await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 3")
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    check(True, 'x closes the whole stack')
    if device:
        # A downward touch drag on a nested level closes the sheet.
        await pg.get_by_text('朋友', exact=True).first.click()
        d = pg.locator('.pp-panel')
        await d.locator('.wl.top .zt-w', has_text='朋友').first.wait_for(timeout=10000)
        await d.locator('.wl.top .zt-w', has_text='朋友').first.click()
        await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
        cdp = await pg.context.new_cdp_session(pg)
        box = await d.locator('.sw-hint').bounding_box()
        await drag_down(cdp, box['x'] + 40, box['y'] + 4)
        await pg.locator('.pp-panel').wait_for(state='detached', timeout=3000)
        check(True, 'a swipe down on a nested level closes the sheet')
    # Words page: a word tapped in its examples opens a sheet; x returns to the page.
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    href = await d.get_by_role('link', name='Details').get_attribute('href')
    await pg.keyboard.press('Escape') if not device else await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    await pg.goto(U + href)
    await pg.locator('.wx .zt-w').first.wait_for(timeout=10000)
    await pg.locator('.wx .zt-w').first.click()
    await pg.locator('.pp-panel').wait_for(timeout=5000)
    check(True, 'Words page: tapping a word in its examples opens a sheet')
    await pg.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    check('#/words/' in pg.url, 'Words page: x returns to the page')


async def characters(pg, device):
    """Characters cards and "Words with X" (plan 2026-11-23 WP2.2)."""
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    await pg.get_by_text('学校', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Characters', exact=True).wait_for(timeout=10000)
    cards = d.locator('.wl.top .wx-char')
    await cards.nth(1).wait_for(timeout=8000)
    check(await cards.count() == 2, '学校: two character cards')
    t0, t1 = await cards.nth(0).inner_text(), await cards.nth(1).inner_text()
    check('学' in t0 and 'xué' in t0 and '校' in t1 and 'xiào' in t1, '学校: readings xué and xiào')
    glosses = [(await cards.nth(0).locator('.wx-char-gloss').inner_text()).strip(), (await cards.nth(1).locator('.wx-char-gloss').inner_text()).strip()]
    check(all(len(g) > 2 for g in glosses), '学校: each card has a meaning')
    sec = d.locator('.wl.top section[aria-label="Words with 学"]')
    await sec.wait_for(timeout=8000)
    await sec.get_by_role('button', name='学生').wait_for(timeout=5000)
    check(await sec.get_by_role('button', name='学习').count() == 1, '学 lists 学生 and 学习 among the common words')
    await sec.get_by_role('button', name='学生').click()
    await d.locator('.wl.top .sw-tag', has_text='Not in your list').wait_for(timeout=5000)
    check(True, 'tapping 学生 opens a nested level: Not in your list')
    await d.locator('.pp-back').click()
    await d.locator('.wl.top .wx-char').first.wait_for(timeout=5000)
    check(await d.locator('.pp-back').count() == 0, 'Back returns to 学校')
    if device:
        box = await d.locator('.wl.top .wx-char-zh').first.bounding_box()
        check(box['height'] >= 44 and box['width'] >= 44, 'character button is at least 44 px')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with Characters')
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    # A single character: no Characters heading, only Words with 好 and his 你好.
    await pg.get_by_role('tab', name='HSK四级').click()
    await pg.get_by_text('好', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    sec = d.locator('.wl.top section[aria-label="Words with 好"]')
    await sec.wait_for(timeout=8000)
    check(await d.get_by_role('heading', name='Characters', exact=True).count() == 0, '好: no Characters heading')
    check(await sec.get_by_role('button', name='你好').count() == 1, '好: Words with 好 has his 你好 chip')
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')


async def run(p, label, device):
    print(f'--- {label}')
    b = await p.chromium.launch()
    ctx = await b.new_context(**(p.devices[device] if device else {'viewport': {'width': 1280, 'height': 800}}))
    pg = await ctx.new_page()
    await pg.goto(U)
    await pg.evaluate("navigator.serviceWorker.ready.then(() => 1)")

    # Import the synthetic workbook through the file input in Settings.
    await pg.goto(U + '#/settings')
    await pg.locator('input[type=file][accept*=xlsx]').first.set_input_files(XLSX)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    hz = pg.get_by_role('button', name='Hanzi')
    if await hz.count() and await hz.first.get_attribute('aria-pressed') == 'false':
        await hz.first.click()

    async def open_panel():
        await pg.get_by_text('朋友', exact=True).first.click()
        d = pg.get_by_role('dialog', name='朋友')
        await d.wait_for(timeout=10000)
        return d

    d = await open_panel()
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    check(True, 'panel shows Dictionary')
    await d.get_by_role('heading', name='Examples').wait_for(timeout=10000)
    check(await d.locator('.zh').count() >= 1, 'at least one example sentence')

    # Layout: panel flush with the bottom of the viewport, no sideways scroll (after the slide-up animation ends).
    await d.evaluate('el => Promise.all(el.getAnimations().map(a => a.finished))')
    box = await d.bounding_box()
    vh = await pg.evaluate('innerHeight')
    check(abs(box['y'] + box['height'] - vh) <= 1, f'panel bottom {box["y"] + box["height"]:.0f} equals viewport bottom {vh}')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with the panel open')

    # Section order and no Claude: Your list, Dictionary, Characters, Similar words, Examples.
    sim = d.locator('section[aria-label="Similar words"]')
    await sim.wait_for(timeout=10000)
    # Dictionary items load last; which ones depends on the dictionary (sample here, the real one in CI).
    await sim.get_by_text('From the dictionary.').wait_for(timeout=10000)
    check(await sim.get_by_role('heading', name='Similar words').count() == 1, 'section is titled Similar words')
    n_items = await sim.locator('.wx-cf').count()
    check(1 <= n_items <= 6, f'Similar words has 1-6 items ({n_items})')
    check(await sim.locator('.wx-cf-word', has_text='同伴').count() == 1, 'Similar words lists his group word 同伴 (16bis)')
    check('companion' in await sim.locator('.wx-cf', has_text='同伴').inner_text(), 'his group word shows his meaning')
    check(await sim.locator('.wx-cf-word', has_text='伙伴').count() == 1, "Similar words lists the Don't confuse word 伙伴")
    check('pal, mate' in await sim.locator('.wx-cf', has_text='伙伴').inner_text(), "the Don't confuse text is shown")
    check(n_items >= 4, 'Similar words lists dictionary words after his own (3)')
    check('From the dictionary.' in await sim.inner_text(), 'footer for the offline items')
    check(await sim.locator('.zb, .zt, .zt-w, .wx-py').count() == 0, 'no sentence block in Similar words')
    check(await sim.locator('.wx-cf', has_text='伙伴').get_by_role('img', name='Colloquial (口语)').count() == 1, '伙伴 (口语 in his column) has the crown')
    check(await sim.locator('.wx-cf', has_text='同事').get_by_role('img', name='Colloquial (口语)').count() == 0, 'a neutral word has no crown')
    check(await d.locator('.wp-crown').count() == 0, 'no crown in the title of 朋友')
    check('Explain more' not in await sim.inner_text(), 'Similar words footer does not mention Explain more')
    await d.locator('section[aria-label="Characters"]').wait_for(timeout=10000)
    order = await d.evaluate("el => [...el.querySelectorAll('section.wx-sec')].map((s) => s.getAttribute('aria-label')).filter((n) => !n.startsWith('Words with'))")
    want = ['Your list', 'Dictionary', 'Characters', 'Similar words', 'Examples']
    check(order == want, f'section order {order} == {want}')
    check(order.index('Dictionary') < order.index('Characters'), 'Dictionary comes before Characters')
    text = await d.inner_text()
    check('Claude' not in text, 'no "Claude" text in the panel')
    check(await d.get_by_role('button', name='Explain more').count() == 0, 'no Explain more button')
    check(await d.get_by_role('button', name='Ask again').count() == 0 and await d.locator('section[aria-label="Don\'t confuse with"]').count() == 0, 'no Ask again, no Don\'t confuse with')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with Similar words')
    await d.locator('.wx-cf-word', has_text='友人').click()
    d = pg.locator('.pp-panel')
    await d.locator('.pp-back').wait_for(timeout=5000)
    check(await d.locator('.wl').count() == 2, 'tapping a similar word opens a nested level')
    await d.locator('.pp-back').click()
    await pg.keyboard.press('Escape') if not device else await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')

    # A word whose meaning says "colloquial": crown next to the pinyin in the title.
    await pg.get_by_text('聊天', exact=True).first.click()
    c = pg.get_by_role('dialog', name='聊天')
    await c.wait_for(timeout=10000)
    check(await c.locator('.wp-title').get_by_role('img', name='Colloquial (口语)').count() == 1, '聊天 (meaning says colloquial): crown in the title')
    await pg.keyboard.press('Escape') if not device else await c.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')

    await word_levels(pg, None, device)
    await characters(pg, device)

    # Offline reload: the panel still shows the dictionary and examples, in the same order.
    await ctx.set_offline(True)
    await pg.reload()
    await pg.wait_for_selector('#root *', timeout=10000)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    d = await open_panel()
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    check('Claude' not in await d.inner_text(), 'offline: dictionary shows, no Claude text')
    await ctx.set_offline(False)
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', None)
        await run(p, 'iPhone 13', 'iPhone 13')
    sys.exit(1 if fail else 0)

asyncio.run(main())
