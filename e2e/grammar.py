"""Run against the preview build. Grammar window (plan 2026-11-20-grammar-window, WP1 skeleton), desktop and iPhone 13:
- the Grammar tab is in the main nav and opens #/grammar with one row per grammar point of the workbook;
- the 中 | FR | EN switch changes the row titles, survives a reload (device-only, hz.gr.lang);
- search matches hanzi and English; Group by Family | HSK | Excel order regroups;
- a row opens #/grammar/<id> with the formula (slots boxed), Meaning, Examples, status and Explain more;
- on a phone the list and the lesson are two pages ("All grammar" goes back); no sideways scroll.
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
    check(await pg.locator('.gr-row', has_text='不 + verb').count() == 1 or '不 + verb' in ' '.join(await titles(pg)), f'{name}: hanzi titles by default')
    await pg.screenshot(path=f'{S}grammar-{name}-list-zh.png', full_page=True)

    await pg.get_by_role('group', name='Title language').get_by_role('button', name='EN').click()
    check('negation' in await titles(pg), f'{name}: EN switch shows English titles')
    await pg.get_by_role('group', name='Title language').get_by_role('button', name='FR').click()
    check(await pg.locator('.gr-row .gr-title .tag', has_text='EN').count() >= 1, f'{name}: FR without a lesson falls back to English, tagged EN')
    await pg.reload()
    await pg.locator('.gr-row').first.wait_for()
    pressed = await pg.get_by_role('group', name='Title language').get_by_role('button', name='FR').get_attribute('aria-pressed')
    check(pressed == 'true', f'{name}: title language kept after a reload')
    await pg.screenshot(path=f'{S}grammar-{name}-list-fr.png', full_page=True)

    search = pg.get_by_label('Search grammar')
    await search.fill('是')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: hanzi search')
    await search.fill('to have')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: English search')
    await search.fill('')
    await pg.get_by_role('group', name='Group by').get_by_role('button', name='Excel order').click()
    check(await pg.locator('.gr section.group').count() == 1, f'{name}: Excel order is one group')

    await pg.locator('.gr-row').first.click()
    await pg.locator('.gr-formula').wait_for()
    check('#/grammar/' in pg.url, f'{name}: a row opens #/grammar/<id>')
    check(await pg.locator('.gf-slot').count() >= 1, f'{name}: formula shows boxed slots')
    for h in ['Meaning', 'Examples']:
        check(await pg.locator('.gr-detail .group-h', has_text=h).count() == 1, f'{name}: lesson has {h}')
    check(await pg.locator('.gr-detail .st-seg').count() == 1, f'{name}: status picker on the lesson')
    if phone:
        check(not await pg.locator('.gr-list').is_visible(), f'{name}: phone shows the lesson alone')
        await pg.screenshot(path=f'{S}grammar-{name}-lesson.png', full_page=True)
        await pg.get_by_role('link', name='All grammar').click()
        await pg.locator('.gr-row').first.wait_for()
        check(await pg.locator('.gr-list').is_visible(), f'{name}: All grammar goes back to the list')
    else:
        check(await pg.locator('.gr-list').is_visible(), f'{name}: desktop shows list and lesson side by side')
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
