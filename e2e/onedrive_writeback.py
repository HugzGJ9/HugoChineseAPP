"""End-to-end for writing statuses into the workbook in OneDrive (plan 2026-11-08-connected-saving.md, WP11): an iPhone 13
signs in against the fake Microsoft (e2e/fake_graph.py; no real credentials), sets statuses and watches them land in the
fake workbook, while "Excel" (the script) edits the same file.

Scenarios, each asserted on the bytes the fake holds (openpyxl reads the fills; zip entries are compared):
  A. first write: the confirmation (screenshot on the iPhone viewport), then the row's fill is GREEN, only styles.xml and the
     HSK五级 sheet differ, the pre-write file is backed up in the app folder, and the app's own write is not an "Excel change".
  B. "Excel" saves while the app uploads: the PUT gets 412, the app re-reads and re-patches, and both edits are in the file.
  C. Lock (423): the waiting text shows; after the unlock the row is written.
  D. "Excel" reverts an app-written row: the notice shows; Restore writes the row again.
  E. Offline: the status waits ("N waiting") and no Microsoft request is made; online, it is written.
Every workbook PUT must carry If-Match (asserted in the fake). Nothing of the file outside the colours changes.

Needs a build with a Microsoft client id (any value) and write-back (WP9/WP10). Without them it prints SKIP and exits 0, or
fails when E2E_REQUIRE_MS=1 (CI). The 30 s debounce is skipped through "Write now"; selectors: od_common.SEL."""
import asyncio, os, sys, time
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from od_common import (SEL, S, U, NAME, SHEET, GREEN, YELLOW, Checks, FakeMicrosoft, sample_workbook, blank_rows, skip, sign_in,
                       show_words, has, status_of, set_status, poll_for_change, no_sideways_scroll, preflight)  # noqa: E402
from fake_graph import fill_of, recolour, recolour_none, zip_changed, sheet_xml_name  # noqa: E402


async def drive_write(page, ms, uploads_before, timeout=90, want=200):
    """Waits until the fake has seen a workbook PUT with status `want` beyond `uploads_before`; taps "Write now" whenever the
    panel offers it (the 30 s debounce and the 5 minute quiet period are not what this script tests)."""
    page.set_default_timeout(3000)
    await page.goto(U + '#/settings')
    end = time.time() + timeout
    last_click = 0
    while time.time() < end:
        if any(u[2] == want for u in ms.uploads[uploads_before:]):
            page.set_default_timeout(30000)
            return True
        if time.time() - last_click > 3 and await page.locator(SEL['write_now']).count():
            await page.locator(SEL['write_now']).first.click(); last_click = time.time()
        await page.wait_for_timeout(500)
    page.set_default_timeout(30000)
    return False


async def main():
    xlsx = sample_workbook()
    rows = blank_rows(xlsx, 5)
    os.makedirs(S, exist_ok=True)
    check = Checks()
    original = open(xlsx, 'rb').read()
    ms = FakeMicrosoft()
    item = ms.add_workbook(NAME, original)
    sheet_xml = sheet_xml_name(original, SHEET)
    allowed = {'xl/styles.xml', sheet_xml}

    def only_colours(before, after):
        extra = [n for n in zip_changed(before, after) if n not in allowed]
        return not extra, ', '.join(extra)

    async with async_playwright() as p:
        if not await preflight(p, SEL['signin']):
            skip('No "Sign in with Microsoft" in this build (MS_CLIENT_ID empty?): write-back e2e skipped.')
        b = await p.chromium.launch()
        ph = await b.new_context(**p.devices['iPhone 13'], service_workers='block')
        await ph.add_init_script("delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;")
        await ms.install(ph)
        pp = await ph.new_page()
        check.listen(pp, 'PHONE')
        await sign_in(pp, '#/settings')
        await show_words(pp)
        (r1, h1), (r2, h2), (r3, h3), (r4, h4), (r5, h5) = rows

        # A. First write: confirmation, then the fill; the app's own write is no Excel edit.
        await set_status(pp, h1, 'Mastered')
        await pp.goto(U + '#/settings')
        if not await has(pp, SEL['confirm_write'], 60000):
            await b.close()
            skip('A status was set, but no first-write confirmation appeared: this build has no write-back (WP9/WP10) yet.')
        await pp.screenshot(path=S + 'odwrite-phone-confirm.png', full_page=True)
        check('confirmation: no sideways scroll on the iPhone viewport', await no_sideways_scroll(pp))
        check('confirmation names the backup folder', await pp.locator(SEL['confirm_text']).count() > 0)
        check('nothing written before the confirmation', not ms.uploads)
        n = len(ms.uploads)
        await pp.click(SEL['confirm_write'])
        check('A: the PUT lands after Write', await drive_write(pp, ms, n, 40))
        after = ms.bytes_of(item)
        check(f'A: row {r1} hanzi is filled {GREEN} in the workbook', fill_of(after, SHEET, r1) == GREEN, str(fill_of(after, SHEET, r1)))
        ok, extra = only_colours(original, after)
        check('A: only styles.xml and the sheet differ from the original', ok, extra)
        backups = ms.app_files('backups')
        check('A: the pre-write workbook is backed up in the app folder', len(backups) == 1 and list(backups.values())[0] == original, str(sorted(backups)))
        check('A: every PUT carried If-Match', not ms.puts_without_if_match(), str(ms.puts_without_if_match()))
        await pp.goto(U + '#/settings')
        check('A: the panel says the statuses were written', await has(pp, SEL['written'], 15000))
        await pp.screenshot(path=S + 'odwrite-phone-written.png', full_page=True)
        await pp.goto(U + '#/sheets'); await pp.wait_for_timeout(1500)
        check('A: the app does not report its own write as an Excel change', await pp.locator(SEL['changed']).count() == 0)

        # B. Excel saves between the app's read and its PUT: 412, then both edits are in the file.
        excel_version = recolour(ms.bytes_of(item), SHEET, r3, YELLOW)
        ms.excel_saves_during_next_put(item, excel_version)
        n = len(ms.uploads)
        await set_status(pp, h2, 'Mastered')
        check('B: the write completes', await drive_write(pp, ms, n, 100))
        statuses = [u[2] for u in ms.uploads[n:]]
        check('B: the first PUT was refused with 412 and a retry landed', statuses[:1] == [412] and statuses[-1:] == [200], str(statuses))
        after = ms.bytes_of(item)
        check(f'B: the app row ({r2}) is {GREEN}', fill_of(after, SHEET, r2) == GREEN, str(fill_of(after, SHEET, r2)))
        check(f"B: Excel's edit (row {r3}) is still {YELLOW}", fill_of(after, SHEET, r3) == YELLOW, str(fill_of(after, SHEET, r3)))
        check(f'B: the earlier write (row {r1}) is still {GREEN}', fill_of(after, SHEET, r1) == GREEN)
        ok, extra = only_colours(excel_version, after)
        check("B: relative to Excel's version only styles.xml and the sheet differ", ok, extra)
        check('B: every PUT carried If-Match', not ms.puts_without_if_match())
        await poll_for_change(pp)
        check("B: Excel's edit shows as a notice", await has(pp, SEL['changed'], 20000))
        await pp.screenshot(path=S + 'odwrite-phone-excel-edit.png')
        if await pp.locator('button:has-text("OK")').count():
            await pp.click('button:has-text("OK")')

        # C. Locked (423): the waiting text; unlocked, the row is written.
        ms.lock(item)
        n = len(ms.uploads)
        await set_status(pp, h4, 'Mastered')
        await drive_write(pp, ms, n, 70, want=423)
        await pp.goto(U + '#/settings')
        check('C: the 423 reached the fake', any(u[2] == 423 for u in ms.uploads[n:]))
        check('C: the panel says the workbook is open in Excel (waiting)', await has(pp, SEL['open_in_excel'], 15000))
        await pp.screenshot(path=S + 'odwrite-phone-locked.png', full_page=True)
        check(f'C: nothing was written while locked (row {r4})', fill_of(ms.bytes_of(item), SHEET, r4) is None)
        ms.unlock(item)
        check('C: after the unlock the row is written', await drive_write(pp, ms, n, 150))
        check(f'C: row {r4} is {GREEN}', fill_of(ms.bytes_of(item), SHEET, r4) == GREEN, str(fill_of(ms.bytes_of(item), SHEET, r4)))

        # D. Excel reverts an app-written row: Excel wins and shows a notice; Restore writes it again.
        ms.excel_save(item, recolour_none(ms.bytes_of(item), SHEET, r1))
        check(f'D: Excel cleared row {r1}', fill_of(ms.bytes_of(item), SHEET, r1) is None)
        await pp.goto(U + '#/sheets'); await pp.wait_for_selector('.sheets')
        await poll_for_change(pp)
        check('D: the Excel change notice shows', await has(pp, SEL['changed'], 20000))
        await pp.screenshot(path=S + 'odwrite-phone-reverted.png')
        if await pp.locator(SEL['restore']).count():
            n = len(ms.uploads)
            await pp.click(SEL['restore'])
            check('D: Restore writes the row again', await drive_write(pp, ms, n, 100))
            check(f'D: row {r1} is {GREEN} again', fill_of(ms.bytes_of(item), SHEET, r1) == GREEN, str(fill_of(ms.bytes_of(item), SHEET, r1)))
        else:
            check('D: Restore button present', False)

        # E. Offline: the status waits and nothing is requested; online, it is written.
        await pp.goto(U + '#/settings'); await pp.wait_for_timeout(1500)
        await ph.set_offline(True)
        n, calls = len(ms.uploads), len(ms.log)
        await set_status(pp, h5, 'Mastered')
        await pp.goto(U + '#/settings')
        check('E: the panel counts the waiting status offline', await has(pp, SEL['waiting_n'], 20000))
        await pp.wait_for_timeout(1500)
        check('E: offline makes no Microsoft request', len(ms.log) == calls, f'{len(ms.log) - calls} new')
        await pp.screenshot(path=S + 'odwrite-phone-offline.png', full_page=True)
        await ph.set_offline(False)
        await pp.evaluate("() => window.dispatchEvent(new Event('online'))")
        check('E: back online, the row is written', await drive_write(pp, ms, n, 100))
        check(f'E: row {r5} is {GREEN}', fill_of(ms.bytes_of(item), SHEET, r5) == GREEN, str(fill_of(ms.bytes_of(item), SHEET, r5)))

        # Final: the phone still shows what Hugo set, and the fake saw a clean client.
        now = await status_of(pp, h5)
        check('the phone still shows its status', 'Mastered' in now, now)
        check('every workbook PUT carried If-Match', not ms.puts_without_if_match(), str(ms.puts_without_if_match()))
        check('no unrouted Microsoft request', not ms.unrouted, '; '.join(ms.unrouted[:5]))
        check('no protocol violation', not ms.violations, '; '.join(ms.violations[:5]))
        await b.close()
    check.finish('workbook PUT statuses: ' + ' '.join(str(u[2]) for u in ms.uploads))


asyncio.run(main())
