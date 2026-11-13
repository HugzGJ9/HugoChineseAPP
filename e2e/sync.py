"""End-to-end: a computer (OneDrive folder simulated with OPFS) and an iPhone (iPhone 13 emulation) syncing through an
in-memory stand-in for the GitHub API. Uses HUGO_XLSX=/path/to/Hugo_chinese_vocab.xlsx when set, otherwise a synthetic
workbook made by e2e/make_sample.py (no personal data).
Screenshots and the workbook copy go to E2E_OUT (default e2e-out/, git-ignored: it holds personal data)."""
import asyncio, base64, hashlib, io, json, re, sys, os, zipfile
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
ORIGIN = '{0.scheme}://{0.netloc}'.format(urlsplit(U))
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
if not XLSX:
    import subprocess
    os.makedirs(S, exist_ok=True)
    XLSX = S + 'sample.xlsx'
    subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)
TOKEN = 'test-token-not-real'
ORIG_NAME = 'Hugo_chinese_vocab.xlsx'
COPY_NAME = 'Hugo_chinese_vocab (app).xlsx'
TARGET_SHEET = 'HSK五级'

def blank_row(path):
    """(row, hanzi) of the first row of HSK五级 whose hanzi cell has no fill, or None."""
    from openpyxl import load_workbook
    ws = load_workbook(path)[TARGET_SHEET]
    for r in range(2, ws.max_row + 1):
        c = ws.cell(row=r, column=2)
        if c.value and c.fill.fill_type is None:
            return r, str(c.value)
    return None

async def opfs_read(page, name):
    b64 = await page.evaluate("""async (name) => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('OneDrive');
      const f = await (await dir.getFileHandle(name)).getFile();
      const buf = new Uint8Array(await f.arrayBuffer());
      let s = ''; for (let i = 0; i < buf.length; i += 8192) s += String.fromCharCode(...buf.subarray(i, i + 8192));
      return btoa(s);
    }""", name)
    return base64.b64decode(b64)

def check_copy(orig, copy, target):
    """Problems found comparing the copy with the original; empty list = good."""
    from openpyxl import load_workbook
    bad = []
    zo, zc = zipfile.ZipFile(io.BytesIO(orig)), zipfile.ZipFile(io.BytesIO(copy))
    if zo.namelist() != zc.namelist():
        bad.append('zip entry list or order differs')
    names = load_workbook(io.BytesIO(orig), read_only=True).sheetnames
    sheet_xml = f'xl/worksheets/sheet{names.index(TARGET_SHEET) + 1}.xml'
    for n in zo.namelist():
        if n in ('xl/styles.xml', sheet_xml): continue
        if n in zc.namelist() and zo.read(n) != zc.read(n):
            bad.append('content differs: ' + n)
    row, hanzi = target
    cell = load_workbook(io.BytesIO(copy))[TARGET_SHEET].cell(row=row, column=2)
    if str(cell.value) != hanzi: bad.append(f'hanzi changed: {cell.value!r}')
    rgb = cell.fill.fgColor.rgb if cell.fill.fill_type == 'solid' else None
    if not (isinstance(rgb, str) and rgb.upper().endswith('A9D18E')):
        bad.append(f'row {row} hanzi fill is {rgb!r}, expected A9D18E')
    return bad

files = {}   # path -> (sha, bytes)
blobs = {}
log = []
n = [0]
CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization, content-type, x-github-api-version, accept',
        'access-control-allow-methods': 'GET, PUT, OPTIONS', 'content-type': 'application/json'}

async def github(route):
    req = route.request
    if req.method == 'OPTIONS':
        return await route.fulfill(status=204, headers=CORS)
    def reply(status, body):
        return route.fulfill(status=status, headers=CORS, body=json.dumps(body))
    if req.headers.get('authorization') != f'Bearer {TOKEN}':
        return await reply(401, {'message': 'Bad credentials'})
    path = re.sub(r'^https://api\.github\.com', '', req.url).split('?')[0]
    m = re.match(r'^/repos/HugzGJ9/HugoChineseData(/.*)?$', path)
    if not m:
        return await reply(404, {'message': 'Not Found'})
    rest = m.group(1) or ''
    log.append(f'{req.method} {rest or "/"}')
    if rest == '':
        return await reply(200, {'full_name': 'HugzGJ9/HugoChineseData', 'private': True, 'default_branch': 'main'})
    if rest.startswith('/git/trees/main'):
        if not files:
            return await reply(409, {'message': 'Git Repository is empty.'})
        return await reply(200, {'tree': [{'path': p, 'type': 'blob', 'sha': s} for p, (s, _) in files.items()], 'truncated': False})
    mb = re.match(r'^/git/blobs/(\w+)$', rest)
    if mb:
        return await reply(200, {'content': base64.b64encode(blobs[mb.group(1)]).decode(), 'encoding': 'base64'})
    mc = re.match(r'^/contents/(.+)$', rest)
    if mc and req.method == 'PUT':
        from urllib.parse import unquote
        p = '/'.join(unquote(x) for x in mc.group(1).split('/'))
        body = json.loads(req.post_data)
        cur = files.get(p)
        if cur and body.get('sha') != cur[0]:
            return await reply(409, {'message': 'conflict'})
        data = base64.b64decode(body['content'])
        n[0] += 1
        sha = f'{n[0]:040x}'
        files[p] = (sha, data)
        blobs[sha] = data
        return await reply(201, {'content': {'sha': sha, 'path': p}})
    return await reply(404, {'message': 'Not Found'})

PICKER = """
window.showDirectoryPicker = async () => {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle('OneDrive', { create: true });
};
// This sandboxed Chromium crashes when a file handle is read back from IndexedDB (real Edge/Chrome do not):
// keep the handle in memory and store a marker instead.
navigator.storage.getDirectory().then(r => r.getDirectoryHandle('OneDrive', { create: true })).then(h => { window.__fsHandle = h; });
const origPut = IDBObjectStore.prototype.put;
IDBObjectStore.prototype.put = function (value, key) {
  if (value && typeof FileSystemDirectoryHandle !== 'undefined' && value.v instanceof FileSystemDirectoryHandle) {
    window.__fsHandle = value.v;
    value = { ...value, v: '__FS_HANDLE__' };
  }
  return key === undefined ? origPut.call(this, value) : origPut.call(this, value, key);
};
const desc = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'result');
Object.defineProperty(IDBRequest.prototype, 'result', { get() {
  const r = desc.get.call(this);
  return r && r.v === '__FS_HANDLE__' ? { ...r, v: window.__fsHandle ?? null } : r;
} });
"""

# This script checks the path without Microsoft (folder + GitHub). When the build has a Microsoft client id, Setup and
# Settings fold those panels under "Other ways" / "Without Microsoft": open those folds as soon as they appear.
UNFOLD = """
new MutationObserver(() => {
  for (const d of document.querySelectorAll('details:not([open])')) {
    const t = d.querySelector(':scope > summary')?.textContent?.trim();
    if (['Other ways', 'Without Microsoft', 'Other ways (without Microsoft)', 'Link your OneDrive folder', 'Get your words from your computer', 'Join with a sync key'].includes(t)) d.open = true;
  }
}).observe(document, { childList: true, subtree: true });
"""

async def main():
    if not os.path.isfile(XLSX):
        sys.exit(f'HUGO_XLSX is not a file: {XLSX}')
    os.makedirs(S, exist_ok=True)
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---------- computer ----------
        pc = await b.new_context(viewport={'width': 1280, 'height': 860}, service_workers='block')
        await pc.add_init_script(PICKER)
        await pc.add_init_script(UNFOLD)
        await pc.route('https://api.github.com/**', github)
        await pc.grant_permissions(['clipboard-read', 'clipboard-write'], origin=ORIGIN)
        pg = await pc.new_page()
        pg.on('pageerror', lambda e: errs.append('PC PAGEERROR ' + str(e)))
        pg.on('console', lambda m: errs.append('PC ' + m.text) if m.type == 'error' else None)
        await pg.goto(U)
        # Put the Excel file in the simulated OneDrive folder.
        b64 = base64.b64encode(open(XLSX, 'rb').read()).decode()
        await pg.evaluate("""async (b64) => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('OneDrive', { create: true });
          const fh = await dir.getFileHandle('Hugo_chinese_vocab.xlsx', { create: true });
          const w = await fh.createWritable();
          await w.write(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
          await w.close();
        }""", b64)
        await pg.wait_for_selector('text=Link your OneDrive folder')
        await pg.screenshot(path=S + 's-pc-first.png', full_page=True)
        await pg.click('text=Choose the OneDrive folder')
        await pg.wait_for_selector('.sheets', timeout=30000)
        print('PC sheet tabs:', await pg.locator('.sheets [role=tab]').all_inner_texts())
        orig_before = await opfs_read(pg, ORIG_NAME)

        # Offline warm-up: stroke data of the imported words is saved in the background (cache API, no worker needed).
        strokes = 0
        for _ in range(40):
            strokes = await pg.evaluate("caches.open('strokes').then(c => c.keys()).then(k => k.length)")
            if strokes > 0: break
            await pg.wait_for_timeout(500)
        print('Stroke files cached by the warm-up:', strokes)
        if strokes == 0:
            errs.append('PC warm-up saved no stroke data')

        # Turn on sync (first device).
        await pg.goto(U + '#/settings')
        await pg.click('text=First device: set up the repository')
        await pg.fill('input[placeholder="HugzGJ9/HugoChineseData"]', 'https://github.com/HugzGJ9/HugoChineseData')
        await pg.fill('input[type=password]', TOKEN)
        await pg.click('text=Turn on sync')
        await pg.wait_for_selector('text=/Synced with HugzGJ9\\/HugoChineseData/', timeout=20000)
        print('Repo after link:', sorted(files))

        # Study a few cards.
        await pg.goto(U + '#/review')
        await pg.wait_for_timeout(600)
        for _ in range(4):
            await pg.keyboard.press('Space'); await pg.wait_for_timeout(150)
            await pg.keyboard.press('3'); await pg.wait_for_timeout(250)
        await pg.goto(U + '#/settings')
        await pg.click('text=Sync now')
        await pg.wait_for_timeout(1500)
        await pg.click('text=Write the copy now')
        await pg.wait_for_timeout(1500)
        await pg.click('text=Add another device')
        await pg.wait_for_selector('svg.qr')
        key = await pg.input_value('.share-key textarea')
        sync_panel = pg.locator('#sync')
        await sync_panel.screenshot(path=S + 's-pc-sync.png')
        await pg.locator('.main').first.screenshot(path=S + 's-pc-words.png')
        ev_pc = [p for p in files if p.startswith('events/')]
        print('Repo after reviews:', sorted(files))
        print('key length', len(key))

        # ---------- iPhone ----------
        iphone = p.devices['iPhone 13']
        ph = await b.new_context(**iphone, service_workers='block')
        await ph.route('https://api.github.com/**', github)
        # Safari on iPhone has no folder picker.
        await ph.add_init_script("delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;")
        await ph.add_init_script(UNFOLD)
        pp = await ph.new_page()
        pp.on('pageerror', lambda e: errs.append('PHONE PAGEERROR ' + str(e)))
        pp.on('console', lambda m: errs.append('PHONE ' + m.text) if m.type == 'error' else None)
        # Opened from the QR code in Safari.
        await pp.goto(U + '#/link/' + key)
        await pp.wait_for_selector('text=Using the app from the Home Screen?')
        print('Address bar after link page:', pp.url)
        await pp.screenshot(path=S + 's-phone-linkpage.png', full_page=True)
        # Home Screen app: first run, paste the key.
        await pp.goto(U)
        await pp.wait_for_selector('text=Get your words from your computer')
        await pp.screenshot(path=S + 's-phone-first.png', full_page=True)
        await pp.fill('textarea', key)
        await pp.click('text=Link this device')
        await pp.wait_for_selector('.sheets', timeout=30000)
        await pp.wait_for_timeout(800)
        await pp.screenshot(path=S + 's-phone-sheets.png')
        print('PHONE sheet tabs:', await pp.locator('.sheets [role=tab]').all_inner_texts())
        await pp.goto(U + '#/stats'); await pp.wait_for_timeout(500)
        await pp.goto(U + '#/review'); await pp.wait_for_timeout(600)
        for _ in range(3):
            await pp.keyboard.press('Space'); await pp.wait_for_timeout(150)
            await pp.keyboard.press('3'); await pp.wait_for_timeout(250)
        await pp.goto(U + '#/settings'); await pp.wait_for_timeout(300)
        await pp.click('text=Sync now'); await pp.wait_for_timeout(1500)
        await pp.locator('#sync').screenshot(path=S + 's-phone-sync.png')

        # The phone sets a blank HSK五级 row to Mastered; the PC's copy of the workbook must then show it as green.
        target = blank_row(XLSX)
        if target is None:
            errs.append('no blank row on ' + TARGET_SHEET + ': status check skipped')
        else:
            await pp.goto(U + '#/sheets'); await pp.wait_for_selector('.sheets')
            await pp.get_by_role('tab', name=re.compile(TARGET_SHEET)).click()
            row_el = pp.locator('.sheets').get_by_text(target[1], exact=True).first.locator(
                'xpath=ancestor::*[.//button[contains(@class,"status-chip")]][1]')
            await row_el.locator('button.status-chip').first.click()
            await pp.get_by_role('menuitemradio', name='Mastered').click()
            await pp.wait_for_timeout(500)
            await pp.screenshot(path=S + 's-phone-mastered.png')
        await pp.goto(U + '#/settings'); await pp.wait_for_timeout(300)
        await pp.click('text=Sync now'); await pp.wait_for_timeout(1500)

        # Computer picks up the iPhone's reviews and status.
        await pg.click('text=Sync now'); await pg.wait_for_timeout(1500)
        await pg.click('text=Write the copy now'); await pg.wait_for_timeout(2500)
        copy_bytes = await opfs_read(pg, COPY_NAME)
        orig_after = await opfs_read(pg, ORIG_NAME)
        open(S + 'copy-e2e.xlsx', 'wb').write(copy_bytes)
        copy_ok = True
        if hashlib.sha256(orig_before).hexdigest() != hashlib.sha256(orig_after).hexdigest():
            errs.append('the original workbook was modified'); copy_ok = False
        if target is not None:
            for problem in check_copy(orig_after, copy_bytes, target):
                errs.append('copy: ' + problem); copy_ok = False
            print('Copy check:', 'ok' if copy_ok else 'FAILED', f'(row {target[0]} of {TARGET_SHEET})')
        pc_events = await pg.evaluate("() => new Promise(r => { const q = indexedDB.open('hugo-zhongwen'); q.onsuccess = () => { const t = q.result.transaction('events').objectStore('events').count(); t.onsuccess = () => r(t.result); }; })")
        ph_events = await pp.evaluate("() => new Promise(r => { const q = indexedDB.open('hugo-zhongwen'); q.onsuccess = () => { const t = q.result.transaction('events').objectStore('events').count(); t.onsuccess = () => r(t.result); }; })")
        print('events: computer', pc_events, 'iphone', ph_events)
        print('Repo at end:', sorted(files))
        await pg.goto(U + '#/stats'); await pg.wait_for_timeout(600)
        await pg.screenshot(path=S + 's-pc-stats.png', full_page=True)
        print('API calls:', len(log))
        print('\n'.join(errs[:20]) or 'no console errors')
        await b.close()
    ok = pc_events == ph_events and pc_events > 0 and not any('warm-up' in e for e in errs) and copy_ok
    print('PASS' if ok else 'FAIL: devices disagree')
    sys.exit(0 if ok else 1)

asyncio.run(main())
