"""End-to-end: a computer (OneDrive folder simulated with OPFS) and an iPhone (iPhone 13 emulation) syncing through an
in-memory stand-in for the GitHub API. Needs a real vocab file: HUGO_XLSX=/path/to/Hugo_chinese_vocab.xlsx.
Screenshots and the progress workbook go to E2E_OUT (default e2e-out/, git-ignored: it holds personal data)."""
import asyncio, base64, json, re, sys, os
from urllib.parse import urlsplit
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
ORIGIN = '{0.scheme}://{0.netloc}'.format(urlsplit(U))
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
XLSX = os.environ.get('HUGO_XLSX', '')
TOKEN = 'test-token-not-real'

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

async def main():
    if not os.path.isfile(XLSX):
        sys.exit('Set HUGO_XLSX to a copy of Hugo_chinese_vocab.xlsx (never commit it).')
    os.makedirs(S, exist_ok=True)
    errs = []
    async with async_playwright() as p:
        b = await p.chromium.launch()
        # ---------- computer ----------
        pc = await b.new_context(viewport={'width': 1280, 'height': 860}, service_workers='block')
        await pc.add_init_script(PICKER)
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
        await pg.wait_for_selector('.today-figure', timeout=30000)
        print('PC words:', await pg.inner_text('.today-figure'))

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
        await pg.click('text=Write progress now')
        await pg.wait_for_timeout(1500)
        await pg.click('text=Add another device')
        await pg.wait_for_selector('svg.qr')
        key = await pg.input_value('.share-key textarea')
        sync_panel = pg.locator('#sync')
        await sync_panel.screenshot(path=S + 's-pc-sync.png')
        await pg.locator('section.panel').first.screenshot(path=S + 's-pc-words.png')
        prog = await pg.evaluate("""async () => {
          const root = await navigator.storage.getDirectory();
          const dir = await root.getDirectoryHandle('OneDrive');
          const f = await (await dir.getFileHandle('Hugo_chinese_progress.xlsx')).getFile();
          const buf = new Uint8Array(await f.arrayBuffer());
          let s = ''; for (const x of buf) s += String.fromCharCode(x);
          return btoa(s);
        }""")
        open(S + 'progress-e2e.xlsx', 'wb').write(base64.b64decode(prog))
        ev_pc = [p for p in files if p.startswith('events/')]
        print('Repo after reviews:', sorted(files))
        print('key length', len(key))

        # ---------- iPhone ----------
        iphone = p.devices['iPhone 13']
        ph = await b.new_context(**iphone, service_workers='block')
        await ph.route('https://api.github.com/**', github)
        # Safari on iPhone has no folder picker.
        await ph.add_init_script("delete Window.prototype.showDirectoryPicker; delete window.showDirectoryPicker;")
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
        await pp.wait_for_selector('.today-figure', timeout=30000)
        await pp.wait_for_timeout(800)
        await pp.screenshot(path=S + 's-phone-today.png')
        print('PHONE today:', await pp.inner_text('.today-figure'))
        await pp.goto(U + '#/stats'); await pp.wait_for_timeout(500)
        await pp.goto(U + '#/review'); await pp.wait_for_timeout(600)
        for _ in range(3):
            await pp.keyboard.press('Space'); await pp.wait_for_timeout(150)
            await pp.keyboard.press('3'); await pp.wait_for_timeout(250)
        await pp.goto(U + '#/settings'); await pp.wait_for_timeout(300)
        await pp.click('text=Sync now'); await pp.wait_for_timeout(1500)
        await pp.locator('#sync').screenshot(path=S + 's-phone-sync.png')

        # Computer picks up the iPhone's reviews.
        await pg.click('text=Sync now'); await pg.wait_for_timeout(1500)
        pc_events = await pg.evaluate("() => new Promise(r => { const q = indexedDB.open('hugo-zhongwen'); q.onsuccess = () => { const t = q.result.transaction('events').objectStore('events').count(); t.onsuccess = () => r(t.result); }; })")
        ph_events = await pp.evaluate("() => new Promise(r => { const q = indexedDB.open('hugo-zhongwen'); q.onsuccess = () => { const t = q.result.transaction('events').objectStore('events').count(); t.onsuccess = () => r(t.result); }; })")
        print('events: computer', pc_events, 'iphone', ph_events)
        print('Repo at end:', sorted(files))
        await pg.goto(U + '#/stats'); await pg.wait_for_timeout(600)
        await pg.screenshot(path=S + 's-pc-stats.png', full_page=True)
        print('API calls:', len(log))
        print('\n'.join(errs[:20]) or 'no console errors')
        await b.close()
    ok = pc_events == ph_events and pc_events > 0
    print('PASS' if ok else 'FAIL: devices disagree')
    sys.exit(0 if ok else 1)

asyncio.run(main())
