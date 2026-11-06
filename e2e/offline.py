"""Service worker installs and an offline reload still shows the app. Run against the preview build."""
import os
import asyncio
from playwright.async_api import async_playwright
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch()
        ctx = await b.new_context()
        pg = await ctx.new_page()
        errs = []
        pg.on('console', lambda m: errs.append(m.text) if m.type in ('error', 'warning') else None)
        await pg.goto(os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/'))
        r = await pg.evaluate("navigator.serviceWorker.ready.then(r => r.active && r.active.state)")
        print('SW', r)
        await ctx.set_offline(True)
        await pg.reload()
        await pg.wait_for_selector('#root *', timeout=10000)
        print('offline reload OK')
        print(errs or 'no errors')
        await b.close()
asyncio.run(main())
