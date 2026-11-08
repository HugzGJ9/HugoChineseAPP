"""End-to-end for the Microsoft path: a computer and an iPhone (iPhone 13 emulation, no folder picker) sign in against a fake
Microsoft (e2e/fake_graph.py: login, Graph and the download host are Playwright routes; no real credentials), link the
workbook by search, show the words, pick up an "Excel" recolour with its notice and Restore, hit the expired-refresh
Reconnect banner, and stay quiet offline. Uses HUGO_XLSX when set, otherwise a synthetic workbook (e2e/make_sample.py).
Screenshots go to E2E_OUT (default e2e-out/, git-ignored).

Needs a build whose src/lib/ms/config.ts has a non-empty MS_CLIENT_ID (any value: the fake accepts every client id).
Without one the Microsoft UI is hidden; the script then says so and exits 0 unless E2E_REQUIRE_MS=1 (CI sets it).
Selectors follow .claude/plans/2026-11-08-connected-saving.md (WP4); adjust SEL if the UI copy differs."""
import asyncio, os, re, subprocess, sys
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fake_graph import FakeMicrosoft, recolour, quick_xor_hash  # noqa: E402

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
ORIGIN = '{0.scheme}://{0.netloc}'.format(urlsplit(U))
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
REQUIRE = os.environ.get('E2E_REQUIRE_MS') == '1'
NAME = 'Hugo_chinese_vocab.xlsx'
SHEET = 'HSK五级'
SEL = dict(
    signin='button:has-text("Sign in with Microsoft")', read_now='button:has-text("Read now")', sign_out='text=Sign out', reconnect='text=Reconnect',
    banner='text=Microsoft sign-in expired', restore='button:has-text("Restore")', ok='button:has-text("OK")',
    changed='text=/Excel changed \\d+ status/',
)

if not XLSX:
    os.makedirs(S, exist_ok=True)
    XLSX = S + 'sample.xlsx'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)


def blank_row(path):
    from openpyxl import load_workbook
    ws = load_workbook(path)[SHEET]
    for r in range(2, ws.max_row + 1):
        c = ws.cell(row=r, column=2)
        if c.value and c.fill.fill_type is None:
            return r, str(c.value)
    return None


async def sign_in(page, route_hash):
    """Starts on `route_hash`, signs in through the fake, and checks the route comes back and the URL is clean."""
    await page.goto(U + route_hash)
    await page.wait_for_selector(SEL['signin'], timeout=15000)
    await page.click(SEL['signin'])
    await page.wait_for_function("() => !location.search.includes('code=')", timeout=20000)
    return page.url


async def show_words(page):
    """Waits for the Sheets list after linking (auto-link on one match; falls back to Read now)."""
    try:
        await page.wait_for_selector('.sheets [role=tab]', timeout=20000)
    except Exception:
        await page.goto(U + '#/settings')
        await page.click(SEL['read_now'])
        await page.goto(U + '#/sheets')
        await page.wait_for_selector('.sheets [role=tab]', timeout=20000)


async def status_of(page, hanzi):
    await page.goto(U + '#/sheets'); await page.wait_for_selector('.sheets')
    await page.get_by_role('tab', name=re.compile(SHEET)).click()
    row = page.locator('.sheets').get_by_text(hanzi, exact=True).last.locator(
        'xpath=ancestor::*[.//button[contains(@class,"status-chip")]][1]')
    chip=row.locator('button.status-chip').first; return ((await chip.inner_text()).strip()+' '+(await chip.get_attribute('aria-label') or '')+' '+(await chip.get_attribute('title') or '')).strip()


async def poll_for_change(page):
    """An Excel save is noticed on focus, visibility, online or the 2 minute poll."""
    await page.evaluate("() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('online')); }")


async def main():
    if not os.path.isfile(XLSX):
        sys.exit(f'HUGO_XLSX is not a file: {XLSX}')
    os.makedirs(S, exist_ok=True)
    target = blank_row(XLSX)
    if target is None:
        sys.exit('no blank row on ' + SHEET)
    errs, checks, console = [], [], []
    def check(name, ok, detail=''):
        checks.append(name)
        print(('ok   ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
        if not ok: errs.append(name)
    data = open(XLSX, 'rb').read()
    ms = FakeMicrosoft()
    item = ms.add_workbook(NAME, data)

    async with async_playwright() as p:
        b = await p.chromium.launch()
        def listeners(pg, who):
            pg.on('pageerror', lambda e: errs.append(f'{who} PAGEERROR {e}'))
            # Aborted/blocked Microsoft requests would show up here as console errors.
            pg.on('console', lambda m: console.append(f'{who} {m.text}') if m.type == 'error' else None)

        pc = await b.new_context(viewport={'width': 1280, 'height': 860}, service_workers='block')
        ph = await b.new_context(**p.devices['iPhone 13'], service_workers='block')
        await ph.add_init_script("delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;")
        for c in (pc, ph):
            await ms.install(c)
        pg, pp = await pc.new_page(), await ph.new_page()
        listeners(pg, 'PC'); listeners(pp, 'PHONE')

        # 1. Sign in on both; the route is restored and the URL has no code/state left.
        url = await sign_in(pg, '#/settings')
        check('pc: route restored after sign-in', url.endswith('#/settings') and 'state=' not in url, url)
        url = await sign_in(pp, '#/settings')
        check('phone: route restored after sign-in', url.endswith('#/settings') and 'state=' not in url, url)
        await show_words(pg); await show_words(pp)
        check('pc: sheet tabs shown', await pg.locator('.sheets [role=tab]').count() >= 3)
        check('phone: sheet tabs shown', await pp.locator('.sheets [role=tab]').count() >= 3)
        check('no folder picker needed on the phone', await pp.evaluate("() => !('showDirectoryPicker' in window)"))
        await pg.screenshot(path=S + 'od-pc-sheets.png'); await pp.screenshot(path=S + 'od-phone-sheets.png')
        # The chip's text differs by layout (the phone shows only the symbol), so each device is compared with itself.
        base_phone = await status_of(pp, target[1])

        # 2. "Excel" recolours the blank row yellow (Not known): both devices notice it, with the notice, and Restore works.
        ms.excel_save(item, recolour(data, SHEET, target[0], 'FFFF00'))
        for page, who in ((pg, 'pc'), (pp, 'phone')):
            await page.goto(U + '#/sheets'); await page.wait_for_selector('.sheets')
            await poll_for_change(page)
            try:
                await page.wait_for_selector(SEL['changed'], timeout=20000)
                seen = True
            except Exception:
                seen = False
            check(f'{who}: Excel change notice shown', seen)
            now = await status_of(page, target[1]) if seen else ''
            check(f'{who}: status follows Excel', 'Not known' in now, now)
        await pp.goto(U + '#/sheets'); await pp.wait_for_selector('.sheets')
        if await pp.locator(SEL['restore']).count():
            await pp.screenshot(path=S + 'od-phone-notice.png')
            await pp.click(SEL['restore']); await pp.wait_for_timeout(500)
            got = await status_of(pp, target[1])
            check('phone: Restore puts the previous status back', got == base_phone, f'{got!r}, {base_phone!r} expected')
        else:
            check('phone: Restore button present', False)

        # 3. Same content again: no second download (metadata only).
        dl = sum(1 for l in ms.log if 'microsoftpersonalcontent.com' in l)
        await poll_for_change(pg); await pg.wait_for_timeout(1500)
        check('unchanged workbook is not downloaded again', sum(1 for l in ms.log if 'microsoftpersonalcontent.com' in l) == dl)

        # 4. The refresh token expires (24 h limit): the banner shows; Reconnect signs in again (the fake session is live).
        ms.expire_refresh(); ms.revive_refresh()   # old tokens dead, a new sign-in works
        ms.excel_save(item, recolour(data, SHEET, target[0], 'FF0000'))   # forces a Graph call with the dead token
        await pg.goto(U + '#/sheets'); await pg.wait_for_selector('.sheets')
        await poll_for_change(pg)
        try:
            await pg.wait_for_selector(SEL['banner'], timeout=20000); banner = True
        except Exception:
            banner = False
        check('reconnect banner shows when the refresh token expired', banner)
        if banner:
            await pg.screenshot(path=S + 'od-pc-banner.png')
            await pg.click(f'{SEL["banner"]} >> xpath=.. >> button:has-text("Reconnect")')
            await pg.wait_for_function("() => !location.search.includes('code=')", timeout=20000)
            await pg.wait_for_selector(SEL['banner'], state='detached', timeout=20000)
            check('banner gone after Reconnect', True)

        # 5. Offline: no Graph requests, no errors; the app still works.
        await pg.wait_for_timeout(4000); before = len(ms.log)
        await pp.context.set_offline(True)
        await pp.evaluate("() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); }"); await pp.wait_for_timeout(1500)
        await pp.screenshot(path=S+'offline-phone.png'); check('offline: no Microsoft request attempted', len(ms.log) == before, f'{len(ms.log) - before} new')
        check('offline: sheets still usable', await pp.locator('.sheets [role=tab]').count() >= 3)
        await pp.context.set_offline(False)

        # 6. The fake saw a clean client. Consumer search finds nothing for the exact name: the workbook was linked by path.
        check('exact-name search finds nothing in the fake (tokenised like consumer OneDrive)', all(n == 0 for q, n in ms.searches if q == NAME), str(ms.searches[:6]))
        check('workbook linked by its path', any(f'root:/{NAME}' in l for l in ms.log))
        check('no unrouted Microsoft request', not ms.unrouted, '; '.join(ms.unrouted[:5]))
        check('no protocol violation (If-Match, download host without Authorization, PKCE)', not ms.violations, '; '.join(ms.violations[:5]))

        # 6b. Nothing named like the workbook: the panel says how to pick it, and "Show all Excel files" lists it.
        ms2 = FakeMicrosoft()
        ms2.add_workbook('Chinese words.xlsx', data, folder='Documents', item_id='FAKEITEM2')
        ms2.add_workbook('notes.docx', b'x', folder='Documents', item_id='FAKEDOC')
        c3 = await b.new_context(viewport={'width': 1280, 'height': 860}, service_workers='block')
        await ms2.install(c3)
        p3 = await c3.new_page(); listeners(p3, 'PC2')
        await sign_in(p3, '#/settings')
        try:
            await p3.wait_for_selector(f"text=Couldn't find {NAME} in your OneDrive", timeout=20000); missing = True
        except Exception:
            missing = False
        check('missing workbook: "Couldn\'t find … pick it with Change workbook" shown', missing)
        if missing:
            await p3.click('button:has-text("Change workbook")')
            await p3.wait_for_selector('button:has-text("Show all Excel files")', timeout=20000)
            await p3.click('button:has-text("Show all Excel files")')
            await p3.wait_for_selector('button:has-text("Chinese words.xlsx")', timeout=20000)
            check('Excel list has no other file types', await p3.locator('button:has-text("notes.docx")').count() == 0)
            await p3.screenshot(path=S + 'od-pc-all-excel.png')
            await p3.click('button:has-text("Chinese words.xlsx")')
            await p3.goto(U + '#/sheets')
            try:
                await p3.wait_for_selector('.sheets [role=tab]', timeout=20000); picked = True
            except Exception:
                picked = False
            check('picked Excel file is read', picked)
        check('second drive: no unrouted Microsoft request', not ms2.unrouted, '; '.join(ms2.unrouted[:5]))
        await b.close()

        # 7. Service worker answers the sign-in return navigation with the app shell (needs the SW on, so a fresh context).
        b2 = await p.chromium.launch()
        sw = await b2.new_context(service_workers='allow')
        pw = await sw.new_page()
        await pw.goto(U)
        await pw.wait_for_function("() => navigator.serviceWorker && navigator.serviceWorker.controller", timeout=30000)
        await sw.set_offline(True)
        await pw.goto(U + '?code=x&state=y.z')
        await pw.wait_for_selector('#root >> *', timeout=15000, state='attached')
        check('service worker serves the app for /?code=&state= while offline', await pw.locator('#root >> *').count() > 0)
        await b2.close()

    sys.stdout.flush()
    # Step 4 logs a 401 (Graph, dead token) and a 400 (token endpoint, invalid_grant) on purpose: shown, not failed.
    print('console errors:\n' + '\n'.join(console[:20]) if console else 'no console errors')
    print('PASS' if not errs else 'FAIL')
    sys.exit(0 if not errs else 1)


async def preflight():
    """Skip (or fail in CI) when the build hides the Microsoft UI because MS_CLIENT_ID is empty."""
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page()
        await pg.goto(U)
        await pg.wait_for_timeout(1500)
        found = await pg.locator(SEL['signin']).count() > 0
        if not found:
            await pg.goto(U + '#/settings'); await pg.wait_for_timeout(800)
            found = await pg.locator(SEL['signin']).count() > 0
        await b.close()
    return found


if not asyncio.run(preflight()):
    msg = 'No "Sign in with Microsoft" in this build (MS_CLIENT_ID empty?): onedrive e2e skipped.'
    print(('FAIL: ' if REQUIRE else 'SKIP: ') + msg)
    sys.exit(1 if REQUIRE else 0)
asyncio.run(main())
