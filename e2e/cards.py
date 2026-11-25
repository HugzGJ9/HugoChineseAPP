"""Run against the preview build. Sheets › Cards: typed answers (Right / Wrong), tone digits, the Draw pad, the deck surviving
leaving Cards and a reload, the end of a round, the Wrong label (set by a wrong answer, cleared from Sheets, still
cleared after a reload), and Answer by Choose (4 options, no field) and Flip (Show answer, Not known / Known). Desktop and iPhone 13 emulation, synthetic workbook from make_sample.py (no personal data).
Screenshots are not taken; nothing is written to E2E_OUT except the generated sample workbook."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
if not XLSX:
    os.makedirs(S, exist_ok=True)
    XLSX = S + 'cards-sample.xlsx'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


def pinyin_of():
    """hanzi -> pinyin with tone marks, from the sample workbook."""
    from openpyxl import load_workbook
    out = {}
    for ws in load_workbook(XLSX).worksheets:
        if ws.title == 'Grammar':
            continue
        for r in ws.iter_rows(min_row=2, values_only=True):
            cells = [str(c) for c in r if c is not None]
            for h, pin in zip(cells, cells[1:]):
                if any('一' <= ch <= '鿿' for ch in h) and not any('一' <= ch <= '鿿' for ch in pin):
                    out.setdefault(h, pin)
                    break
    return out


async def boot(p, ctx_args):
    """A fresh browser with the sample workbook imported; returns (browser, page, page errors)."""
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
    return b, pg, errs


async def answer_with(pg, label):
    """Open the settings sheet of Cards, pick the answer type, close the sheet."""
    await pg.get_by_role('button', name='Cards settings').click()
    dlg = pg.get_by_role('dialog', name='Cards settings')
    await dlg.get_by_role('group', name='Answer with').get_by_role('button', name=label, exact=True).click()
    await dlg.get_by_role('button', name='Close').click()
    await dlg.wait_for(state='hidden')


async def open_cards(pg):
    """Sheets › View › Cards."""
    await pg.get_by_role('group', name='View').get_by_role('button', name='Cards').click()
    await pg.locator('.qk-count').wait_for()


async def main_flow(p, name, ctx_args):
    print(f'-- {name}: deck and typed answers')
    b, pg, errs = await boot(p, ctx_args)
    py = pinyin_of()

    await open_cards(pg)
    check(pg.url.endswith('#/cards'), 'Sheets › Cards opens #/cards')
    count = pg.locator('.qk-count')
    total = int(re.search(r'/ (\d+)', await count.inner_text()).group(1))
    check(total > 3, f'deck of {total} words')
    check(await pg.get_by_role('button', name='Close').count() >= 1, 'Close button in the top bar')

    # Hanzi is the default answer type: nothing but the box and the buttons.
    check(await pg.get_by_text('Knew it').count() == 0, 'no "Knew it" button')
    await answer_with(pg, 'Pinyin')
    inp = pg.get_by_label('Type the pinyin')
    check(await inp.get_attribute('placeholder') == 'ni3 hao3 or 3 3', 'pinyin placeholder')
    size = await inp.evaluate('e => parseFloat(getComputedStyle(e).fontSize)')
    check(size >= 16, f'input font {size}px (>= 16)')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no sideways scroll')

    # Card 1: reveal the hanzi, type its pinyin with tone marks -> Right.
    hz = pg.locator('.qk-hz')
    label = await hz.get_attribute('aria-label')
    if label.startswith('Hidden'):
        await hz.click()
        label = await hz.get_attribute('aria-label')
    hanzi = label.split(',')[0]
    check(await pg.locator('.qk-py .qk-hide').count() == 1, 'target layer (pinyin) stays hidden before checking')
    check(not await pg.get_by_role('button', name='Check').is_enabled(), 'Check disabled while the box is empty')
    await inp.fill(py[hanzi])
    check(await pg.get_by_role('button', name='Check').is_enabled(), 'Check enabled with text')
    await inp.press('Enter')
    v = pg.locator('.qk-verdict')
    await v.wait_for()
    check((await v.inner_text()).strip() == 'Right', f'right answer for {hanzi} says Right')
    check('right' in (await inp.get_attribute('class')).split(), 'field turns right after Check')
    check(await pg.locator('.qk-expected').count() == 1, 'expected answer shown')
    box = await pg.get_by_role('button', name='Next').bounding_box()
    check(box['height'] >= 44, f'Next is {box["height"]:.0f}px tall')
    await inp.press('Enter')
    await pg.get_by_text(f'2 / {total}').wait_for()
    check(await v.count() == 0, 'verdict cleared on the next card')
    check(await inp.input_value() == '', 'input cleared')

    # Card 2: wrong answer.
    await inp.fill('zzz')
    await inp.press('Enter')
    await v.wait_for()
    check((await v.inner_text()).strip() == 'Wrong', 'wrong answer says Wrong')
    check('wrong' in (await v.get_attribute('class')), 'verdict styled as wrong')
    check('wrong' in (await inp.get_attribute('class')).split(), 'field turns wrong after Check')
    check(await pg.locator('.qk-card-tag').count() == 1, 'wrong card shows its Wrong tag at once')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no sideways scroll after Check')

    # Leave on the verdict (Close → Sheets) and open Cards again; then a reload.
    await pg.get_by_role('button', name='Close').first.click()
    await pg.get_by_role('tab', name='HSK五级').wait_for()
    check(pg.url.endswith('#/sheets'), 'Close returns to Sheets')
    await open_cards(pg)
    await pg.get_by_text(f'3 / {total}').wait_for(timeout=5000)
    check(True, f'back from Sheets: 3 / {total}')
    await pg.goto(U + '#/sheets')
    await pg.goto(U + '#/cards')
    await pg.get_by_text(f'3 / {total}').wait_for(timeout=5000)
    check(True, f'#/cards typed by hand keeps the deck: 3 / {total}')
    await pg.get_by_role('button', name='Cards settings').click()
    pressed = await pg.get_by_role('group', name='Answer with').get_by_role('button', name='Pinyin', exact=True).get_attribute('aria-pressed')
    check(pressed == 'true', 'answer choice kept')
    await pg.get_by_role('dialog', name='Cards settings').get_by_role('button', name='Close').click()
    await pg.reload()
    await pg.get_by_text(f'3 / {total}').wait_for(timeout=10000)
    check(True, f'after reload: 3 / {total}')
    check(await pg.evaluate("localStorage.getItem('hz.qm.cards') !== null"), 'session stored in localStorage hz.qm.cards')

    if name == 'desktop':
        # Digits type into the box (tone numbers); Escape leaves it and the shortcuts work again.
        inp = pg.get_by_label('Type the pinyin')
        mn_hidden = await pg.locator('.qk-mn .qk-hide').count()
        await inp.focus()
        await inp.press('Escape')
        await pg.keyboard.press('Space')
        check(await pg.locator('.qk-mn .qk-hide').count() != mn_hidden, 'Escape, then Space peeks the other layers')
        check(await inp.input_value() == '', 'the Space was not typed into the box')
        await pg.keyboard.press('Space')

    # Finish the round with "Show answer" (counts as wrong).
    for _ in range(total):
        sa = pg.get_by_role('button', name='Show answer')
        if not await sa.count():
            break
        await sa.click()
        try:
            await pg.get_by_role('button', name='Next').click(timeout=3000)
        except Exception:
            print(await pg.locator('.qk-cards, .qk-done').first.inner_html()); raise
    await pg.get_by_role('heading', name='Round 1 done').wait_for(timeout=5000)
    sub = f'Right 1, wrong {total - 1}.'
    check(await pg.get_by_text(sub).count() == 1, f'done screen: {sub}')
    check(await pg.locator('.qk-miss .qk-wrongtag').count() == total - 1, 'every wrong word in the list carries the Wrong tag')
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for()
    await pg.goto(U + '#/cards')
    await pg.get_by_text(sub).wait_for(timeout=5000)
    check(True, 'done screen restored after leaving')
    await pg.reload()
    await pg.get_by_text(sub).wait_for(timeout=10000)
    check(True, 'done screen restored after reload')

    # Retry the wrong ones, then shuffle and start over.
    await pg.get_by_role('button', name=re.compile('Retry the')).click()
    await pg.get_by_text(re.compile(r'1 / \d+ . retry round 2')).wait_for()
    check(True, 'retry round 2 starts at 1')
    await pg.goto(U + '#/sheets')
    await pg.goto(U + '#/cards')
    await pg.get_by_text(re.compile(r'1 / \d+ . retry round 2')).wait_for(timeout=5000)
    check(True, 'retry round survives leaving')
    await pg.get_by_role('button', name='Cards settings').click()
    await pg.get_by_role('dialog', name='Cards settings').get_by_role('button', name=re.compile('Shuffle')).click()
    check(bool(await pg.evaluate("localStorage.getItem('hz.qm.seed')")), 'shuffle seed stored')
    await pg.get_by_text(f'1 / {total}').wait_for()
    await pg.get_by_role('dialog', name='Cards settings').get_by_role('button', name='Close').click()
    await pg.reload()
    await pg.get_by_text(f'1 / {total}').wait_for(timeout=10000)
    await pg.get_by_role('button', name='Cards settings').click()
    check(await pg.get_by_role('button', name='Sheet order').count() == 1, 'shuffle kept after reload')
    await pg.get_by_role('button', name='Sheet order').click()
    await pg.get_by_text(f'1 / {total}').wait_for()
    await pg.get_by_role('dialog', name='Cards settings').get_by_role('button', name='Close').click()
    for _ in range(total):
        sa = pg.get_by_role('button', name='Show answer')
        if not await sa.count():
            break
        await sa.click()
        await pg.get_by_role('button', name='Next').click()
    await pg.get_by_role('button', name='Start over').click()
    await pg.get_by_text(f'1 / {total}').wait_for()
    check(True, 'Start over goes back to 1')
    print(errs or 'no page errors')
    check(not errs, f'{name}: no page errors')
    await b.close()


async def tones_draw_wrong(p, name, ctx_args):
    print(f'-- {name}: tones, Draw, the Wrong label')
    b, pg, errs = await boot(p, ctx_args)
    tab = pg.get_by_role('tab', name='HSK五级')
    await tab.click()
    pen = pg.get_by_role('button', name='Practise 少')

    class practise:  # the row pencil on wide screens; on phones (no pencil, plan 2026-11-17 D3) the word panel's link
        @staticmethod
        async def click():
            if await pen.is_visible():
                await pen.click()
            else:
                await pg.get_by_role('button', name='少', exact=True).first.click()
                await pg.get_by_role('link', name='Practise this word').click()
    wrong_tag = pg.locator('.hs-wrong')

    async def to_shao():
        """Open Cards on 少 shǎo (row pencil, or the word panel on phones) with pinyin answers."""
        await pg.get_by_role('tab', name='HSK五级').click()
        await practise.click()
        await pg.locator('.qk-count').wait_for()
        await pg.get_by_label('Type the pinyin').wait_for()

    # Pinyin answers from the pencil on 少.
    await practise.click()
    await pg.locator('.qk-count').wait_for()
    check('at=' not in pg.url, 'the deep link is read once, then the address is #/cards')
    await answer_with(pg, 'Pinyin')
    inp = pg.get_by_label('Type the pinyin')
    check(await pg.locator('.qk-hz').get_attribute('aria-label') == '少, play audio', 'starts on 少')
    await inp.fill('3')
    await inp.press('Enter')
    await pg.locator('.qk-verdict').wait_for()
    check((await pg.locator('.qk-verdict').inner_text()).strip() == 'Right', 'tone "3" is right for 少 shǎo')
    check(await pg.locator('.qk-card-tag').count() == 0, 'a right answer leaves no Wrong tag')

    await pg.goto(U + '#/sheets')
    check(await wrong_tag.count() == 0, 'no Wrong tag in Sheets after a right answer')
    await to_shao()
    await pg.get_by_label('Type the pinyin').fill('2')
    await pg.get_by_label('Type the pinyin').press('Enter')
    await pg.locator('.qk-verdict').wait_for()
    check((await pg.locator('.qk-verdict').inner_text()).strip() == 'Wrong', 'tone "2" is wrong for 少 shǎo')
    check(await pg.locator('.qk-card-tag').count() == 1, 'the card shows the Wrong tag at once')

    # Draw: a writing pad instead of the box.
    await answer_with(pg, 'Draw')
    await pg.locator('.qk-padbox .pad-cell').first.wait_for()
    check(await pg.get_by_label('Type the pinyin').count() == 0, 'Draw: no text box')
    check(await pg.locator('.qk-padbox .pad-cell').first.is_visible(), 'Draw: the pad is shown')
    check(await pg.get_by_role('button', name='Show answer').count() == 1, 'Draw: Show answer is there')
    await answer_with(pg, 'Pinyin')

    # Back in Sheets: the tag on the row, the count in the Wrong filter, then clear it.
    await pg.get_by_role('button', name='Close').first.click()
    await tab.wait_for()
    await tab.click()
    await wrong_tag.first.wait_for()
    check(await wrong_tag.count() == 1, 'the row of 少 has the Wrong tag')
    check(await pg.locator('.hs-wrong').get_attribute('aria-label') == 'Wrong: 少. Tap to clear', 'the tag is on 少')
    await pg.locator('.hs-filter').click()
    item = pg.get_by_role('menuitemradio', name=re.compile('^Wrong'))
    check((await item.locator('.mn-count').inner_text()).strip() == '1', 'Wrong filter count is 1')
    await item.click()
    check(await pg.locator('.ql-row').count() == 1, 'the Wrong filter lists one row')
    await pg.locator('.hs-filter').click()
    await pg.get_by_role('menuitemradio', name=re.compile('^All')).click()
    await wrong_tag.click()
    await wrong_tag.wait_for(state='detached')
    check(True, 'tapping the tag clears it')
    await pg.wait_for_timeout(800)
    await pg.reload()
    await tab.wait_for(timeout=10000)
    await tab.click()
    await pg.locator('.ql-row').first.wait_for()
    check(await wrong_tag.count() == 0, 'still cleared after a reload')
    await pg.locator('.hs-filter').click()
    item = pg.get_by_role('menuitemradio', name=re.compile('^Wrong'))
    check((await item.locator('.mn-count').inner_text()).strip() == '0', 'Wrong filter count is 0 after the reload')
    await pg.keyboard.press('Escape')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no sideways scroll in Sheets')
    check(not errs, f'{name}: no page errors')
    await b.close()


async def answer_by(p, name, args):
    """Cards settings › Answer by: Choose and Flip need no keyboard, so no text field."""
    print(f'-- {name}: Answer by Choose and Flip')
    b, pg, errs = await boot(p, args)
    await open_cards(pg)
    await answer_with(pg, 'Hanzi')
    await pg.get_by_role('button', name='Cards settings').click()
    dlg = pg.get_by_role('dialog', name='Cards settings')
    await dlg.get_by_role('group', name='Answer by').get_by_role('button', name='Choose', exact=True).click()
    await dlg.get_by_role('button', name='Close').click()
    await dlg.wait_for(state='hidden')
    opts = pg.locator('.qk-choice')
    await opts.first.wait_for()
    check(await opts.count() == 4, 'Choose: 4 options')
    check(await pg.locator('.qk-input').count() == 0, 'Choose: no text field')
    texts = [t.strip() for t in await opts.all_inner_texts()]
    check(len(set(texts)) == 4, f'Choose: 4 different options {texts}')
    label = await pg.locator('.qk-py').get_attribute('aria-label')
    # The right option is the hanzi of the card: read it off the deck's first word by elimination after answering.
    await opts.first.click()
    await pg.locator('.qk-choice.right').wait_for()
    right = (await pg.locator('.qk-choice.right .qk-ch-hz').inner_text()).strip()
    check(right in await pg.locator('.qk-hz').inner_text(), f'Choose: the green option is the card ({right})')
    picked_right = 'right' in (await opts.first.get_attribute('class')).split()
    check((await pg.locator('.qk-sr').inner_text()).strip() == ('Right' if picked_right else 'Wrong'), 'Choose: verdict read out')
    check(await pg.locator('.qk-card-tag').count() == (0 if picked_right else 1), 'Choose: Wrong tag only after a wrong pick')
    await pg.get_by_role('button', name='Next').click()
    await pg.get_by_text(re.compile(r'^2 / \d+')).wait_for()
    check(await pg.locator('.qk-choice.right').count() == 0, 'Choose: next card unanswered')
    # Flip
    await pg.get_by_role('button', name='Cards settings').click()
    await dlg.get_by_role('group', name='Answer by').get_by_role('button', name='Flip', exact=True).click()
    await dlg.get_by_role('button', name='Close').click()
    await dlg.wait_for(state='hidden')
    await answer_with(pg, 'Pinyin')
    check(await pg.locator('.qk-py .qk-hide').count() == 1, 'Flip: pinyin hidden before Show answer')
    check(await pg.get_by_role('button', name='Known').count() == 0, 'Flip: no grade buttons before Show answer')
    await pg.get_by_role('button', name='Show answer').click()
    check(await pg.locator('.qk-py .qk-hide').count() == 0, 'Flip: Show answer reveals the pinyin')
    await pg.get_by_role('button', name='Not known').click()
    await pg.get_by_text(re.compile(r'^3 / \d+')).wait_for()
    check(await pg.locator('.qk-py .qk-hide').count() == 1, 'Flip: Not known moves on to a hidden card')
    await pg.get_by_role('button', name='Show answer').click()
    await pg.get_by_role("button", name="Known", exact=True).click()
    await pg.get_by_text(re.compile(r'^4 / \d+')).wait_for()
    check(True, 'Flip: Known moves on')
    check(not errs, f'{name}: no page errors' + (f' {errs}' if errs else ''))
    await b.close()


async def main():
    async with async_playwright() as p:
        for name, args in (('desktop', {'viewport': {'width': 1280, 'height': 860}}), ('iPhone 13', p.devices['iPhone 13'])):
            await main_flow(p, name, args)
            await tones_draw_wrong(p, name, args)
            await answer_by(p, name, args)
    sys.exit(1 if fail else 0)

asyncio.run(main())
