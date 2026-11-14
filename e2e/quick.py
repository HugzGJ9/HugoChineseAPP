"""Run against the preview build. Quick › Cards: typed answers (Right / Wrong), and the deck surviving a tab change, a
reload and a finished round. Desktop and iPhone 13 emulation, synthetic workbook from make_sample.py (no personal data).
Screenshots are not taken; nothing is written to E2E_OUT except the generated sample workbook."""
import asyncio, os, re, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
if not XLSX:
    os.makedirs(S, exist_ok=True)
    XLSX = S + 'quick-sample.xlsx'
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
                if any('\u4e00' <= ch <= '\u9fff' for ch in h) and not any('\u4e00' <= ch <= '\u9fff' for ch in pin):
                    out.setdefault(h, pin)
                    break
    return out


async def run(p, name, ctx_args):
    print(f'-- {name}')
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
    py = pinyin_of()

    await pg.goto(U + '#/quick')
    await pg.get_by_role('group', name='View').get_by_role('button', name='Cards').click()
    count = pg.locator('.qk-count')
    await count.wait_for()
    total = int(re.search(r'/ (\d+)', await count.inner_text()).group(1))
    check(total > 3, f'deck of {total} words')

    # The answer controls replace Missed / Knew it.
    check(await pg.get_by_text('Knew it').count() == 0, 'no "Knew it" button')
    await pg.get_by_role('group', name='Answer with').get_by_role('button', name='Pinyin').click()
    inp = pg.get_by_label('Type the pinyin')
    check(await inp.get_attribute('placeholder') == 'ni3 hao3', 'pinyin placeholder')
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
    await inp.fill(py[hanzi])
    check(await pg.get_by_role('button', name='Check').is_enabled(), 'Check enabled with text')
    await inp.press('Enter')
    v = pg.locator('.qk-verdict')
    await v.wait_for()
    check((await v.inner_text()).strip() == 'Right', f'right answer for {hanzi} says Right')
    check(await pg.locator('.qk-expected').count() == 1, 'expected answer shown')
    nxt = pg.get_by_role('button', name='Next')
    box = await nxt.bounding_box()
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

    # Leave on the verdict: Sheets and back, then a reload.
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for()
    await pg.goto(U + '#/quick')
    await pg.get_by_text(f'3 / {total}').wait_for(timeout=5000)
    check(True, f'back from Sheets: 3 / {total}')
    check(await pg.get_by_role('group', name='Answer with').get_by_role('button', name='Pinyin').get_attribute('aria-pressed') == 'true', 'answer choice kept')
    await pg.reload()
    await pg.get_by_text(f'3 / {total}').wait_for(timeout=10000)
    check(True, f'after reload: 3 / {total}')
    check(await pg.evaluate("localStorage.getItem('hz.qm.cards') !== null"), 'session stored in localStorage hz.qm.cards')

    if name == 'desktop':
        # Digits type into the box (tone numbers); Escape leaves it and the 1 2 3 shortcuts work again.
        mn_hidden = await pg.locator('.qk-mn .qk-hide').count()
        await inp.focus()
        await inp.press('Escape')
        await pg.keyboard.press('3')
        check(await pg.locator('.qk-mn .qk-hide').count() != mn_hidden, 'Escape, then 3 toggles the meaning layer')
        check(await inp.input_value() == '', 'the 3 was not typed into the box')
        await pg.keyboard.press('3')

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
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').wait_for()
    await pg.goto(U + '#/quick')
    await pg.get_by_text(sub).wait_for(timeout=5000)
    check(True, 'done screen restored after leaving')
    await pg.reload()
    await pg.get_by_text(sub).wait_for(timeout=10000)
    check(True, 'done screen restored after reload')

    # Retry the wrong ones, then Start over.
    await pg.get_by_role('button', name=re.compile('Retry the')).click()
    await pg.get_by_text(re.compile(r'1 / \d+ . retry round 2')).wait_for()
    check(True, 'retry round 2 starts at 1')
    await pg.goto(U + '#/sheets')
    await pg.goto(U + '#/quick')
    await pg.get_by_text(re.compile(r'1 / \d+ . retry round 2')).wait_for(timeout=5000)
    check(True, 'retry round survives leaving')
    # Shuffle is stored on this device and the deck changes with it.
    await pg.get_by_role('button', name=re.compile('Shuffle')).click()
    check(bool(await pg.evaluate("localStorage.getItem('hz.qm.seed')")), 'shuffle seed stored')
    await pg.get_by_text(f'1 / {total}').wait_for()
    await pg.reload()
    await pg.get_by_text(f'1 / {total}').wait_for(timeout=10000)
    check(await pg.get_by_role('button', name='Sheet order').count() == 1, 'shuffle kept after reload')
    await pg.get_by_role('button', name='Show answer').click()
    await pg.get_by_role('button', name='Next').click()
    await pg.get_by_text(f'2 / {total}').wait_for()
    await pg.get_by_role('button', name='Sheet order').click()
    await pg.get_by_text(f'1 / {total}').wait_for()
    check(True, 'new deck starts at 1')
    await pg.get_by_role('button', name='Show answer').click()
    await pg.get_by_role('button', name='Next').click()
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
    check(not errs, 'no page errors')
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', {})
        await run(p, 'iPhone 13', p.devices['iPhone 13'])
    sys.exit(1 if fail else 0)

asyncio.run(main())
