"""Shared pieces of the OneDrive e2e scripts (onedrive_sync.py, onedrive_writeback.py): selectors, check collector, sign-in,
status helpers, app-folder data and a synthetic workbook. Selectors follow .claude/plans/2026-11-08-connected-saving.md
(WP4, WP7, WP10); when the UI copy changes, change SEL here and nowhere else."""
import asyncio, os, re, subprocess, sys
from urllib.parse import urlsplit

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fake_graph import FakeMicrosoft  # noqa: E402,F401

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
ORIGIN = '{0.scheme}://{0.netloc}'.format(urlsplit(U))
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
REQUIRE = os.environ.get('E2E_REQUIRE_MS') == '1'
NAME = 'Hugo_chinese_vocab.xlsx'
SHEET = 'HSK五级'
GREEN, YELLOW = 'A9D18E', 'FFFF00'

SEL = dict(
    # sign-in and workbook (WP4)
    signin='button:has-text("Sign in with Microsoft")', read_now='button:has-text("Read now")',
    banner='text=Microsoft sign-in expired', restore='button:has-text("Restore")',
    changed='text=/Excel changed \\d+ status/',
    # sync through OneDrive (WP7): "Synced through OneDrive (Apps/Hugo Chinese) 2 min ago"
    synced='text=/Synced through OneDrive/', sync_now='button:has-text("Sync now")',
    # write status (WP10)
    confirm_write='button:text-is("Write")', confirm_later='button:text-is("Not now")',
    confirm_text='text=/Apps . Hugo Chinese . backups/',
    write_now='button:has-text("Write now")',
    written='text=/statuses written/', waiting_n='text=/\\d+ waiting/', open_in_excel='text=/open in Excel/',
    # status chip in a Sheets row, its menu items, the language switch
    chip='button.status-chip', menu_item='menuitemradio', lang_group='Meaning language',
)


class Checks:
    def __init__(self):
        self.errs, self.console = [], []

    def __call__(self, name, ok, detail=''):
        print(('ok   ' if ok else 'FAIL ') + name + (f' ({detail})' if detail and not ok else ''))
        if not ok:
            self.errs.append(name)

    def listen(self, page, who):
        page.on('pageerror', lambda e: self.errs.append(f'{who} PAGEERROR {e}'))
        page.on('console', lambda m: self.console.append(f'{who} {m.text}') if m.type == 'error' else None)

    def finish(self, note=''):
        sys.stdout.flush()
        print(('console errors (a 401/400 from an expired token, a 404/409/412/423 from a deliberate step are expected):\n'
               + '\n'.join(self.console[:20])) if self.console else 'no console errors')
        if note:
            print(note)
        print('PASS' if not self.errs else 'FAIL')
        sys.exit(0 if not self.errs else 1)


def sample_workbook():
    """HUGO_XLSX when set, otherwise the synthetic workbook (no personal data)."""
    path = os.environ.get('HUGO_XLSX', '')
    if not path:
        os.makedirs(S, exist_ok=True)
        path = S + 'sample.xlsx'
        subprocess.run([sys.executable, os.path.join(HERE, 'make_sample.py'), path], check=True)
    if not os.path.isfile(path):
        sys.exit(f'HUGO_XLSX is not a file: {path}')
    return path


def blank_rows(path, n):
    """[(row, hanzi)] of the first n rows of HSK五级 whose hanzi cell has no fill."""
    from openpyxl import load_workbook
    ws = load_workbook(path)[SHEET]
    out = [(r, str(ws.cell(row=r, column=2).value)) for r in range(2, ws.max_row + 1)
           if ws.cell(row=r, column=2).value and ws.cell(row=r, column=2).fill.fill_type is None]
    if len(out) < n:
        sys.exit(f'need {n} blank rows on {SHEET}, found {len(out)}')
    return out[:n]


def skip(msg):
    print(('FAIL: ' if REQUIRE else 'SKIP: ') + msg)
    sys.exit(1 if REQUIRE else 0)


async def sign_in(page, route_hash):
    """Starts on `route_hash`, signs in through the fake, waits until the return URL is clean."""
    await page.goto(U + route_hash)
    await page.wait_for_selector(SEL['signin'], timeout=15000)
    await page.click(SEL['signin'])
    await page.wait_for_function("() => !location.search.includes('code=')", timeout=20000)


async def show_words(page):
    await page.goto(U + '#/sheets')
    await page.wait_for_selector('.sheets [role=tab]', timeout=30000)


async def has(page, selector, timeout=20000):
    try:
        await page.wait_for_selector(selector, timeout=timeout)
        return True
    except Exception:
        return False


def row_of(page, hanzi):
    return page.locator('.sheets').get_by_text(hanzi, exact=True).last.locator(
        'xpath=ancestor::*[.//button[contains(@class,"status-chip")]][1]')


async def open_sheet(page):
    await page.goto(U + '#/sheets')
    await page.wait_for_selector('.sheets')
    await page.get_by_role('tab', name=re.compile(SHEET)).click()


async def status_of(page, hanzi):
    """Text, aria-label and title of the row's status chip (the phone shows only a symbol, so they are joined)."""
    await open_sheet(page)
    chip = row_of(page, hanzi).locator(SEL['chip']).first
    return ((await chip.inner_text()).strip() + ' ' + (await chip.get_attribute('aria-label') or '') + ' '
            + (await chip.get_attribute('title') or '')).strip()


async def set_status(page, hanzi, label):
    await open_sheet(page)
    await row_of(page, hanzi).locator(SEL['chip']).first.click()
    await page.get_by_role(SEL['menu_item'], name=label).click()
    await page.wait_for_timeout(500)


async def study(page, n):
    """n cards on the Review screen: reveal (Space), grade Good (3)."""
    await page.goto(U + '#/review')
    await page.wait_for_timeout(600)
    for _ in range(n):
        await page.keyboard.press('Space'); await page.wait_for_timeout(150)
        await page.keyboard.press('3'); await page.wait_for_timeout(250)


async def sync_now(page, wait=1500):
    await page.goto(U + '#/settings')
    await page.wait_for_selector(SEL['sync_now'], timeout=20000)
    await page.click(SEL['sync_now'])
    await page.wait_for_timeout(wait)


async def event_count(page):
    return await page.evaluate("() => new Promise(r => { const q = indexedDB.open('hugo-zhongwen'); q.onsuccess = () => { "
                               "const t = q.result.transaction('events').objectStore('events').count(); t.onsuccess = () => r(t.result); }; })")


async def poll_for_change(page):
    """An Excel save is noticed on focus, visibility, online or the 2 minute poll."""
    await page.evaluate("() => { window.dispatchEvent(new Event('focus')); document.dispatchEvent(new Event('visibilitychange')); "
                        "window.dispatchEvent(new Event('online')); }")


async def no_sideways_scroll(page):
    return await page.evaluate("() => document.documentElement.scrollWidth <= window.innerWidth + 1")


async def preflight(p, selector, settle=1500):
    """True when the build shows `selector` on the start page or in Settings (the Microsoft UI is hidden without a client id)."""
    b = await p.chromium.launch()
    pg = await b.new_page()
    await pg.goto(U)
    await pg.wait_for_timeout(settle)
    found = await pg.locator(selector).count() > 0
    if not found:
        await pg.goto(U + '#/settings'); await pg.wait_for_timeout(800)
        found = await pg.locator(selector).count() > 0
    await b.close()
    return found
