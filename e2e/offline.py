"""Run against the preview build. Checks: the service worker installs, the French dictionary is saved by the warm-up,
an offline reload still shows the app, and the "New version" flow (banner; no reload during a review, reload when idle)."""
import os
import sys
import asyncio
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context()
        pg = await ctx.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type in ('error', 'warning') else None)
        await pg.goto(U)
        r = await pg.evaluate("navigator.serviceWorker.ready.then(r => r.active && r.active.state)")
        check(r in ('activated', 'activating'), f'service worker active ({r})')

        dict_cached = False
        for _ in range(60):
            dict_cached = await pg.evaluate("caches.open('dictionary').then(c => c.keys()).then(k => k.length > 0)")
            if dict_cached:
                break
            await pg.wait_for_timeout(500)
        check(dict_cached, 'dictionary saved by the offline warm-up')

        await ctx.set_offline(True)
        await pg.reload()
        await pg.wait_for_selector('#root *', timeout=10000)
        check(True, 'offline reload shows the app')
        await ctx.set_offline(False)

        # Update flow. A real update fires "controllerchange" on a page that already had a controller.
        await pg.goto(U + '#/review')
        await pg.wait_for_selector('#root *')
        await pg.evaluate("window.__marker = 1")
        await pg.evaluate("navigator.serviceWorker.dispatchEvent(new Event('controllerchange'))")
        await pg.wait_for_selector('text=New version', timeout=3000)
        check(True, 'banner shown after an update')
        await pg.wait_for_timeout(4000)
        check(await pg.evaluate("window.__marker") == 1, 'no reload during a review')
        await pg.evaluate("location.hash = '#/stats'")
        await pg.wait_for_function("() => window.__marker === undefined", timeout=8000)
        check(True, 'reloads by itself once the review is left')

        print(errs or 'no errors')
        await b.close()
    sys.exit(1 if fail else 0)

asyncio.run(main())
