"""End-to-end for app sync through OneDrive's app folder (plan 2026-11-08-connected-saving.md, WP8), mirroring sync.py:
a computer and an iPhone 13 sign in against the fake Microsoft (e2e/fake_graph.py: login, Graph incl. special/approot, and
the download host are Playwright routes; no real credentials), the phone studies and sets a status, the computer sees the
phone's reviews and status, and a language change reaches the other device. The fake lists app files in tiny pages to
exercise @odata.nextLink, and the script fails on an unconditional app PUT, an unrouted Microsoft request or any request to
api.github.com (this path must not touch GitHub). Uses HUGO_XLSX when set, otherwise the synthetic workbook.

Needs a build with a Microsoft client id (any value: the fake accepts all) and app-folder sync (WP6/WP7). Without them it
prints SKIP and exits 0, or fails when E2E_REQUIRE_MS=1 (CI). Selectors: od_common.SEL."""
import asyncio, os, re, sys
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from od_common import (SEL, S, U, NAME, SHEET, Checks, FakeMicrosoft, sample_workbook, blank_rows, skip, sign_in, show_words,
                       has, status_of, set_status, study, sync_now, event_count, preflight)  # noqa: E402


async def main():
    xlsx = sample_workbook()
    target = blank_rows(xlsx, 1)[0]
    os.makedirs(S, exist_ok=True)
    check = Checks()
    ms = FakeMicrosoft()
    ms.add_workbook(NAME, open(xlsx, 'rb').read())
    ms.page_size = 2
    github = []

    async with async_playwright() as p:
        if not await preflight(p, SEL['signin']):
            skip('No "Sign in with Microsoft" in this build (MS_CLIENT_ID empty?): onedrive sync e2e skipped.')
        b = await p.chromium.launch()

        async def block_github(route):
            github.append(route.request.url)
            await route.abort()

        pc = await b.new_context(viewport={'width': 1280, 'height': 860}, service_workers='block')
        ph = await b.new_context(**p.devices['iPhone 13'], service_workers='block')
        await ph.add_init_script("delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;")
        for c in (pc, ph):
            await ms.install(c)
            await c.route('https://api.github.com/**', block_github)
        pg, pp = await pc.new_page(), await ph.new_page()
        check.listen(pg, 'PC'); check.listen(pp, 'PHONE')

        # 1. Both sign in; sync turns on by itself (OneDrive is the default target) and the words appear.
        await sign_in(pg, '#/settings')
        if not await has(pg, SEL['synced'], 30000):
            await b.close()
            skip('Signed in, but no "Synced through OneDrive" line: this build has no app-folder sync (WP6/WP7) yet.')
        await show_words(pg)
        await sign_in(pp, '#/settings')
        check('phone: synced through OneDrive after sign-in', await has(pp, SEL['synced'], 30000))
        await show_words(pp)
        check('both devices show the sheets', await pg.locator('.sheets [role=tab]').count() >= 3
              and await pp.locator('.sheets [role=tab]').count() >= 3)
        await pg.screenshot(path=S + 'odsync-pc.png'); await pp.screenshot(path=S + 'odsync-phone.png')
        for _ in range(30):  # the list is pushed a moment after the import
            data = ms.app_files('data')
            if 'vocab.json.gz' in data and 'settings.json' in data: break
            await pg.wait_for_timeout(1000)
        check('app folder holds the shared list and settings', 'vocab.json.gz' in data and 'settings.json' in data, str(sorted(data)))
        devs = [n for n in data if re.fullmatch(r'devices\.[^.]+\.json', n)]
        check('both devices registered (devices.<id>.json)', len(devs) == 2, str(devs))

        # 2. The computer studies four cards and syncs; the phone studies three, sets a status, syncs.
        await study(pg, 4)
        await sync_now(pg)
        pc_ev = [n for n in ms.app_files('data') if re.fullmatch(r'events\.[^.]+\.\d{4}-\d{2}\.json', n)]
        check('computer events reach the app folder (events.<device>.<month>.json)', len(pc_ev) == 1, str(pc_ev))
        base_pc = await status_of(pg, target[1])
        await study(pp, 3)
        await set_status(pp, target[1], 'Mastered')
        await pp.screenshot(path=S + 'odsync-phone-mastered.png')
        await sync_now(pp)
        data = ms.app_files('data')
        check('phone events and marks reach the app folder',
              len([n for n in data if n.startswith('events.')]) == 2 and any(n.startswith('marks.') for n in data), str(sorted(data)))

        # 3. The computer picks up the phone's reviews and status.
        await sync_now(pg)
        pc_events, ph_events = await event_count(pg), await event_count(pp)
        print('events: computer', pc_events, 'iphone', ph_events)
        check('both devices hold the same events', pc_events == ph_events and pc_events > 0, f'{pc_events} vs {ph_events}')
        now = await status_of(pg, target[1])
        check('computer shows the status the phone set', 'Mastered' in now and now != base_pc, f'{now!r} (was {base_pc!r})')
        check('app folder listings were paged (@odata.nextLink followed)', any('page@2' in l for l in ms.log))

        # 4. A language change on the computer reaches the phone.
        grp = lambda page: page.get_by_role('group', name=SEL['lang_group']).first
        await pg.goto(U + '#/settings')
        await grp(pg).get_by_role('button', name='FR').click()
        await pg.wait_for_timeout(2500)  # shared preferences are saved 1.5 s after the change
        await sync_now(pg)
        settings = ms.app_json('settings.json') or {}
        check('settings.json in the app folder carries the language', (settings.get('prefs') or {}).get('lang') == 'fr', str(settings.get('prefs')))
        await sync_now(pp)
        await pp.goto(U + '#/settings')
        pressed = await grp(pp).get_by_role('button', name='FR').get_attribute('aria-pressed')
        check('phone follows the language change', pressed == 'true', str(pressed))

        # 5. Clean client: nothing unrouted, no unconditional app write, GitHub untouched.
        check('no unrouted Microsoft request', not ms.unrouted, '; '.join(ms.unrouted[:5]))
        check('no protocol violation', not ms.violations, '; '.join(ms.violations[:5]))
        check('every app PUT has If-Match or conflictBehavior=fail', not ms.app_puts_unconditional(), str(ms.app_puts_unconditional()[:3]))
        check('no request to api.github.com', not github, '; '.join(github[:3]))
        await b.close()
    check.finish(f'app folder: {sorted(ms.app_files("data"))}')


asyncio.run(main())
