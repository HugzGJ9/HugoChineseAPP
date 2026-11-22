"""Run against the preview build. Grammar window (plans 2026-11-20-grammar-window, 2026-11-21-grammar-content), desktop
and iPhone 13:
- the Grammar tab is in the main nav and opens #/grammar with one row per grammar point of the workbook;
- grammar-v3 (plan 2026-11-22-grammar-v3): rows show the pattern, then the title in the app's EN | FR language (EN-tagged
  fallback without a French title); no 中/FR/EN switch, no grouping; search matches hanzi, English and French;
- tick-box filters (HSK, family, status): OR inside a group, AND across, removable chips, kept after a reload;
- a row opens #/grammar/<id>: formula (slots boxed), labels, Meaning in one language only, examples with translations
  hidden until asked, every word tappable (his words → word panel with status; others → dictionary-only panel that
  widens on a tap), pattern words bold, previous/next; no Same family, no Lesson box, no Explain more;
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


async def subs(pg):
    return [t.strip() for t in await pg.locator('.gr-row .gr-sub').all_inner_texts()]


async def lang(pg, l):
    await pg.get_by_role('group', name='Meaning language').first.get_by_role('button', name=l).click()


async def filt(pg, labels):
    await pg.locator('.gr-filter-btn').click()
    sheet = pg.locator('.gr-fs')
    await sheet.wait_for()
    for l in labels:
        await sheet.locator('label.gr-box', has_text=l).click()
    await sheet.locator('.gr-fs-foot .btn.primary').click()
    await sheet.wait_for(state='detached')


async def run(p, name, ctx_args, phone):
    b, ctx, pg, errs = await boot(p, ctx_args)
    tab = pg.locator('nav.nav a[href="#/grammar"]')
    check(await tab.count() == 1, f'{name}: Grammar tab in the nav')
    await tab.click()
    await pg.locator('.gr-row').first.wait_for()
    n = await pg.locator('.gr-row').count()
    check(n == 3, f'{name}: one row per grammar point ({n})')
    check(await titles(pg) == ['不 + verb', '是……的', '有 + noun'], f'{name}: rows show the pattern, in Excel order')
    check(await pg.get_by_role('group', name='Title language').count() == 0, f'{name}: no 中/FR/EN switch')
    check(await pg.get_by_role('group', name='Group by').count() == 0, f'{name}: no Group by')
    check(await pg.locator('.gr-list .group-h').count() == 0, f'{name}: no group headers')
    await lang(pg, 'EN')
    t = await subs(pg)
    check('Not + verb' in t and 'to have' in t, f'{name}: EN titles under the pattern ({t})')
    await lang(pg, 'FR')
    t = await subs(pg)
    check('Ne pas + verbe' in t, f'{name}: FR titles ({t})')
    check(await pg.locator('.gr-row .gr-sub .gr-fb', has_text='EN').count() == 1, f'{name}: only the row without French is tagged EN')
    check(await pg.locator('.gr-row .tag', has_text='Insistance').count() == 2, f'{name}: family tags in French')
    await pg.screenshot(path=f'{S}grammar-{name}-list-fr.png', full_page=True)

    search = pg.get_by_label('Search grammar')
    await search.fill('昨天')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: hanzi search')
    await search.fill('to have')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: English search while reading French')
    await search.fill('verbe')
    check(await pg.locator('.gr-row').count() == 1, f'{name}: French search')
    await search.fill('')

    await filt(pg, ['HSK 1', 'HSK 2'])
    check(await pg.locator('.gr-row').count() == 2, f'{name}: two HSK boxes = either level')
    check(await pg.locator('.gr-active .gr-chip').count() == 2, f'{name}: active filters shown as chips')
    await pg.screenshot(path=f'{S}grammar-{name}-filtered.png', full_page=True)
    await filt(pg, ['Sans famille'])
    check(await pg.locator('.gr-row').count() == 0, f'{name}: groups combine with AND')
    await pg.locator('.gr-active .gr-chip', has_text='Sans famille').click()
    check(await pg.locator('.gr-row').count() == 2, f'{name}: a chip removes its filter')
    await pg.reload()
    await pg.locator('.gr-row').first.wait_for()
    check(await pg.locator('.gr-row').count() == 2, f'{name}: filters kept after a reload')
    pressed = await pg.get_by_role('group', name='Meaning language').first.get_by_role('button', name='FR').get_attribute('aria-pressed')
    check(pressed == 'true', f'{name}: language kept after a reload')
    await pg.locator('.gr-active button', has_text='Clear').click()
    check(await pg.locator('.gr-row').count() == 3, f'{name}: Clear shows everything')
    await filt(pg, ['Not studied'])
    check(await pg.locator('.gr-row').count() == 3, f'{name}: status filter (all not studied)')
    await pg.locator('.gr-active button', has_text='Clear').click()

    await pg.locator('.gr-row', has_text='Ne pas + verbe').click()
    await pg.locator('.gr-formula').wait_for()
    check('#/grammar/' in pg.url, f'{name}: a row opens #/grammar/<id>')
    check(await pg.locator('.gf-slot').count() >= 1, f'{name}: formula shows boxed slots')
    meaning = await pg.locator('.gr-meaning').inner_text()
    check('Nie un verbe' in meaning and 'Negates a verb' not in meaning, f'{name}: Meaning in French only')
    check('On dit 没 pour le passé' in meaning, f'{name}: French "when to use" bullets')
    check(await pg.locator('.gr-detail').get_by_text('Not + verb').count() == 0, f'{name}: no English title on a French page')
    check(await pg.locator('.gr-labels .tag', has_text='HSK 1').count() == 1, f'{name}: HSK label on the page')
    check(await pg.locator('.gr-ex').count() == 3, f'{name}: Excel example plus two sentences')
    check(not await pg.get_by_text('Je ne bois pas de thé.').is_visible(), f'{name}: translations hidden at first')
    await pg.locator('.gr-ex .gr-show').first.click()
    check(await pg.locator('.gr-ex .gr-tr').count() == 1, f'{name}: one translation shown on tap')
    await pg.locator('.gr-reveal-all').click()
    check(await pg.get_by_text('Je ne bois pas de thé.').is_visible(), f'{name}: Show all reveals the French translations')
    check(await pg.get_by_text("I don't drink tea.").count() == 0, f'{name}: no English translation on a French page')
    for gone in ['Lesson', 'Explain more', 'Same family', 'Même famille']:
        check(await pg.get_by_text(gone).count() == 0, f'{name}: no {gone}')
    check(await pg.locator('.gr-detail .st-seg').count() == 1, f'{name}: status picker on the page')
    check(await pg.locator('.gr-ex button.gr-w.pat', has_text='不').count() >= 1, f'{name}: pattern words in bold')

    await pg.locator('.gr-ex button.gr-w.mine').first.click()
    await pg.locator('.wp').wait_for()
    check(await pg.locator('.wp .wp-status').count() == 1, f'{name}: his word opens with its status')
    await pg.keyboard.press('Escape')
    await pg.locator('.wp').wait_for(state='detached')
    other = pg.locator('.gr-ex button.gr-w:not(.mine)', has_text='肉')
    check(await other.count() == 1, f'{name}: a word not in his list is tappable')
    await other.click()
    await pg.locator('.sw').wait_for()
    check(await pg.locator('.sw').get_by_text('Not in your list').count() == 1, f'{name}: dictionary-only panel')
    check(await pg.locator('.sw .wp-status').count() == 0 and await pg.locator('.sw').get_by_text('Your list', exact=True).count() == 0,
          f'{name}: no status and no "Your list" for a dictionary word')
    await pg.screenshot(path=f'{S}grammar-{name}-word.png')
    first = (await pg.locator('.sw .wp-hz').inner_text()).strip()   # 肉 or 吃肉, depending on the browser's word split
    await pg.locator('.sw-c', has_text='我').click()
    await pg.locator('.sw .wp-hz', has_text='我不').wait_for(timeout=3000)
    hz = (await pg.locator('.sw .wp-hz').inner_text()).strip()
    check(hz.startswith('我') and hz.endswith('肉'), f'{name}: tapping a character before widens the word ({first} → {hz})')
    check(await pg.locator('.sw').get_by_text(f'Your words with {hz}').count() == 1, f'{name}: links to his words inside it')
    await pg.locator('.sw-c', has_text='我').click()
    await pg.wait_for_function("!document.querySelector('.sw .wp-hz')?.textContent.startsWith('我')", timeout=3000)
    hz = (await pg.locator('.sw .wp-hz').inner_text()).strip()
    check(hz == '不' + first, f'{name}: tapping its first character narrows it again ({hz})')
    await pg.keyboard.press('Escape')
    await pg.locator('.sw').wait_for(state='detached')

    check(await pg.locator('.gr-nav-a.prev').count() == 0 and await pg.locator('.gr-nav-a.next').count() == 1, f'{name}: first point has Next only')
    await pg.locator('.gr-nav-a.next').click()
    await pg.locator('.gr-formula', has_text='是').wait_for()
    check(await pg.locator('.gr-nav-a.prev').count() == 1, f'{name}: Next goes to the next point, which has Previous')
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
