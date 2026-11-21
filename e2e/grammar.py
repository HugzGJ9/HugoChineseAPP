"""Run against the preview build. Grammar window (plans 2026-11-20-grammar-window, 2026-11-21-grammar-content), desktop
and iPhone 13:
- the Grammar tab is in the main nav and opens #/grammar with one row per grammar point of the workbook;
- the 中 | FR | EN switch shows the pattern, the "Title FR" / "Title EN" columns (EN-tagged fallback without a French
  title), and survives a reload (device-only, hz.gr.lang);
- the Family column groups the list; search matches hanzi, English and French; Excel order is one group;
- a row opens #/grammar/<id>: formula (slots boxed), labels, Meaning with both definitions and "when to use", examples
  from Excel and the Sentences column with his words underlined (tap opens the word panel), status; no Lesson box and
  no Explain more;
- on a phone the list and the page are two pages ("All grammar" goes back); no sideways scroll.
Synthetic workbook from make_sample.py (no personal data). Screenshots go to E2E_OUT (git-ignored)."""
import asyncio, os, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
os.makedirs(S, exist_ok=True)
XLSX = os.environ.get('HUGO_XLSX', '')
if not XLSX:
    XLSX = S + 'grammar-sample.xlsx'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


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
    await pg.locator('.ql-row').first.wait_for(timeout=15000)
    return b, ctx, pg, errs


async def titles(pg):
    return [t.strip() for t in await pg.locator('.gr-row .gr-title').all_inner_texts()]


async def run(p, name, ctx_args, phone):
    b, ctx, pg, errs = await boot(p, ctx_args)
    tab = pg.locator('nav.nav a[href="#/grammar"]')
    check(await tab.count() == 1, f'{name}: Grammar tab in the nav')
    await tab.click()
    await pg.locator('.gr-row').first.wait_for()
    n = await pg.locator('.gr-row').count()
    check(n >= 3, f'{name}: one row per grammar point ({n})')
    check('不 + verb' in await titles(pg), f'{name}: hanzi titles by default')
    await pg.screenshot(path=f'{S}grammar-{name}-list-zh.png', full_page=True)

    await pg.get_by_role('group', name='Title language').get_by_role('button', name='EN').click()
    t = await titles(pg)
    check('Not + verb' in t, f'{name}: EN switch shows the Title EN column')
    check('to have' in t, f'{name}: EN falls back to the Excel meaning without a title')
    await pg.get_by_role('group', name='Title language').get_by_role('button', name='FR').click()
    check('Ne pas + verbe' in await titles(pg), f'{name}: FR switch shows the Title FR column')
    check(await pg.locator('.gr-row .gr-title .tag', has_text='EN').count() == 1, f'{name}: only the row without a French title is tagged EN')
    await pg.reload()
    await pg.locator('.gr-row').first.wait_for()
    pressed = await pg.get_by_role('group', name='Title language').get_by_role('button', name='FR').get_attribute('aria-pressed')
    check(pressed == 'true', f'{name}: title language kept after a reload')
    heads = ' | '.join(await pg.locator('.gr .group-h').all_inner_texts())
    check('Insistance · 2' in heads and 'Sans famille · 1' in heads, f'{name}: grouped by the Family column ({heads})')
    await pg.screenshot(path=f'{S}grammar-{name}-list-fr.png', full_page=True)

    search = pg.get_by_label('Search grammar')
    await search.fill('昨天')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: hanzi search')
    await search.fill('to have')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: English search')
    await search.fill('verbe')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: French search')
    await search.fill('')
    await pg.get_by_role('group', name='Group by').get_by_role('button', name='HSK').click()
    check(await pg.locator('.gr .group-h', has_text='HSK 1').count() == 1, f'{name}: grouped by the HSK column')
    await pg.get_by_role('group', name='Group by').get_by_role('button', name='Excel order').click()
    check(await pg.locator('.gr section.group').count() == 1, f'{name}: Excel order is one group')

    await pg.locator('.gr-row', has_text='Ne pas + verbe').click()
    await pg.locator('.gr-formula').wait_for()
    check('#/grammar/' in pg.url, f'{name}: a row opens #/grammar/<id>')
    check(await pg.locator('.gf-slot').count() >= 1, f'{name}: formula shows boxed slots')
    meaning = await pg.locator('.gr-meaning').inner_text()
    check('Nie un verbe' in meaning and 'Negates a verb' in meaning, f'{name}: Meaning shows both definitions')
    check('On dit 没 pour le passé' in meaning, f'{name}: Meaning shows the French "when to use" bullets')
    check(await pg.locator('.gr-labels .tag', has_text='HSK 1').count() == 1, f'{name}: HSK label on the page')
    check(await pg.locator('.gr-ex').count() == 3, f'{name}: Excel example plus two sentences')
    check(await pg.locator('.gr-ex', has_text='Je ne bois pas de thé.').count() == 1, f'{name}: sentence translated in French')
    for gone in ['Lesson', 'Explain more']:
        check(await pg.get_by_text(gone, exact=True).count() == 0, f'{name}: no {gone}')
    check(await pg.locator('.gr-detail .st-seg').count() == 1, f'{name}: status picker on the page')
    w = pg.locator('.gr-ex button.gr-w').first
    check(await w.count() == 1, f'{name}: his words are underlined in the examples')
    await w.click()
    await pg.locator('.wp').wait_for()
    check(await pg.locator('.wp').is_visible(), f'{name}: tapping a word opens its panel')
    await pg.keyboard.press('Escape')
    await pg.locator('.wp').wait_for(state='detached')
    if phone:
        check(not await pg.locator('.gr-list').is_visible(), f'{name}: phone shows the page alone')
        await pg.screenshot(path=f'{S}grammar-{name}-lesson.png', full_page=True)
        await pg.get_by_role('link', name='All grammar').click()
        await pg.locator('.gr-row').first.wait_for()
        check(await pg.locator('.gr-list').is_visible(), f'{name}: All grammar goes back to the list')
    else:
        check(await pg.locator('.gr-list').is_visible(), f'{name}: desktop shows list and page side by side')
        await pg.screenshot(path=f'{S}grammar-{name}-lesson.png', full_page=True)
    wide = await pg.evaluate('document.scrollingElement.scrollWidth > innerWidth')
    check(not wide, f'{name}: no sideways scroll')
    check(not errs, f'{name}: no page errors {errs[:2]}')
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', {'viewport': {'width': 1280, 'height': 860}}, False)
        await run(p, 'iphone', {**p.devices['iPhone 13']}, True)
    if fail:
        print(f'{len(fail)} failed')
        sys.exit(1)
    print('all ok')


asyncio.run(main())
