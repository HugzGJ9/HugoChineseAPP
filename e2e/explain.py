"""Run against the preview of a `LEXICON_SAMPLE=1 npm run build`. Plays the word panel and "Explain more" with the Anthropic
API mocked through page.route: no real key and no real request ever. Runs on desktop and with iPhone 13 emulation.
Uses a synthetic workbook made by e2e/make_sample.py (no personal data)."""
import asyncio, json, os, subprocess, sys
from playwright.async_api import async_playwright

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')
S = os.environ.get('E2E_OUT', 'e2e-out').rstrip('/') + '/'
os.makedirs(S, exist_ok=True)
XLSX = S + 'sample-explain.xlsx'
subprocess.run([sys.executable, os.path.join(os.path.dirname(os.path.abspath(__file__)), 'make_sample.py'), XLSX], check=True)
FAKE_KEY = 'sk-ant-test-0000000000000000e2e1'
MODEL = 'claude-sonnet-5-5'
fail = []


def check(ok, what):
    print(('ok   ' if ok else 'FAIL ') + what)
    if not ok:
        fail.append(what)


def ex(zh, py, tr):
    return {'zh': zh, 'pinyin': py, 'tr': tr}


EXPLANATION = {
    'summary': 'A person you know and like, someone who is not family. Mock answer for tests.',
    'senses': [{'meaning': 'friend', 'pos': 'noun'}],
    'register': 'Neutral, used in speech and writing.',
    'nuance': [],
    'collocations': [ex('好朋友', 'hǎo péngyou', 'good friend'), ex('交朋友', 'jiāo péngyou', 'make friends'), ex('老朋友', 'lǎo péngyou', 'old friend')],
    'patterns': [],
    'mistakes': [],
    'examples': [
        ex('他是我的朋友。', 'tā shì wǒ de péngyou.', 'He is my friend.'),
        ex('我和朋友去学校。', 'wǒ hé péngyou qù xuéxiào.', 'I go to school with a friend.'),
        ex('你有几个朋友？', 'nǐ yǒu jǐ ge péngyou?', 'How many friends do you have?'),
        ex('朋友们明天来吃饭。', 'péngyoumen míngtiān lái chīfàn.', 'My friends come to eat tomorrow.'),
        ex('我想交新朋友。', 'wǒ xiǎng jiāo xīn péngyou.', 'I want to make new friends.'),
    ],
}


def sse(obj):
    body = json.dumps(obj, ensure_ascii=False)
    chunks = [body[i:i + 120] for i in range(0, len(body), 120)]
    ev = lambda name, d: f'event: {name}\ndata: {json.dumps(d)}\n\n'
    out = ev('message_start', {'type': 'message_start', 'message': {'id': 'msg_test', 'usage': {'input_tokens': 1500, 'output_tokens': 1}}})
    out += ev('content_block_start', {'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'tool_use', 'id': 'tu_1', 'name': 'word_explanation', 'input': {}}})
    for c in chunks:
        out += ev('content_block_delta', {'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'input_json_delta', 'partial_json': c}})
    out += ev('content_block_stop', {'type': 'content_block_stop', 'index': 0})
    out += ev('message_delta', {'type': 'message_delta', 'delta': {'stop_reason': 'tool_use'}, 'usage': {'output_tokens': 1400}})
    out += ev('message_stop', {'type': 'message_stop'})
    return out


CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS'}


async def run(p, label, device):
    print(f'--- {label}')
    b = await p.chromium.launch()
    ctx = await b.new_context(**(p.devices[device] if device else {'viewport': {'width': 1280, 'height': 800}}))
    pg = await ctx.new_page()
    calls = {'messages': [], 'models': 0, 'other': []}

    async def anthropic(route):
        req = route.request
        if req.method == 'OPTIONS':
            return await route.fulfill(status=204, headers=CORS)
        if req.url.split('?')[0].endswith('/v1/models'):
            calls['models'] += 1
            return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps({'data': [{'id': MODEL}]}))
        if req.url.split('?')[0].endswith('/v1/messages'):
            calls['messages'].append({'headers': req.headers, 'body': json.loads(req.post_data or '{}')})
            return await route.fulfill(status=200, headers={**CORS, 'content-type': 'text/event-stream'}, body=sse(EXPLANATION))
        calls['other'].append(req.url)
        return await route.fulfill(status=404, headers=CORS, body='{}')

    await ctx.route('https://api.anthropic.com/**', anthropic)
    await pg.goto(U)
    await pg.evaluate("navigator.serviceWorker.ready.then(() => 1)")

    # Import the synthetic workbook through the file input in Settings.
    await pg.goto(U + '#/settings')
    await pg.locator('input[type=file][accept*=xlsx]').first.set_input_files(XLSX)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    hz = pg.get_by_role('button', name='Hanzi')
    if await hz.count() and await hz.first.get_attribute('aria-pressed') == 'false':
        await hz.first.click()

    async def open_panel():
        await pg.get_by_text('朋友', exact=True).first.click()
        d = pg.get_by_role('dialog', name='朋友')
        await d.wait_for(timeout=10000)
        return d

    d = await open_panel()
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    check(True, 'panel shows Dictionary')
    await d.get_by_role('heading', name='Examples').wait_for(timeout=10000)
    check(await d.locator('.zh').count() >= 1, 'at least one example sentence')

    # Layout: panel flush with the bottom of the viewport, no sideways scroll.
    box = await d.bounding_box()
    vh = await pg.evaluate('innerHeight')
    check(abs(box['y'] + box['height'] - vh) <= 1, f'panel bottom {box["y"] + box["height"]:.0f} equals viewport bottom {vh}')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with the panel open')

    # No key.
    await d.get_by_role('button', name='Explain more').click()
    await d.get_by_text('Add your Claude API key').wait_for(timeout=5000)
    check(True, 'no key: asks for a key')
    check(len(calls['messages']) == 0, 'no request without a key')
    await pg.keyboard.press('Escape')

    # Settings: save a fake key.
    await pg.goto(U + '#/settings')
    inp = pg.get_by_label('Claude API key')
    await inp.wait_for()
    size = await inp.evaluate('e => parseFloat(getComputedStyle(e).fontSize)')
    if device:
        check(size >= 16, f'key input font-size {size}px >= 16')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll in Settings')
    await inp.fill(FAKE_KEY)
    await pg.get_by_role('button', name='Save key').click()
    await pg.get_by_text('Key saved').wait_for(timeout=5000)
    check(calls['models'] >= 1, 'key checked with GET /v1/models')
    check(await pg.get_by_role('button', name='Remove key').count() == 1, 'Remove key is offered once saved')
    check(FAKE_KEY not in (await pg.inner_text('body')), 'full key is not shown on the page')

    # Explain more.
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    d = await open_panel()
    await d.get_by_role('button', name='Explain more').click()
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=10000)
    for _ in range(50):  # the heading can appear before the request is recorded
        if calls['messages']:
            break
        await pg.wait_for_timeout(100)
    await pg.wait_for_timeout(300)
    check(len(calls['messages']) == 1, 'one request to /v1/messages')
    if calls['messages']:
        h, body = calls['messages'][0]['headers'], calls['messages'][0]['body']
        check(h.get('x-api-key') == FAKE_KEY, 'x-api-key header sent')
        check(h.get('anthropic-version') == '2023-06-01', 'anthropic-version header')
        check(h.get('anthropic-dangerous-direct-browser-access') == 'true', 'direct browser access header')
        check(body.get('model') == MODEL and body.get('stream') is True, 'model and stream in the body')
        check(FAKE_KEY not in json.dumps(body), 'key is not in the request body')
    await d.get_by_text('他是我的朋友。').wait_for(timeout=5000)
    check(await d.get_by_text('我想交新朋友。').count() >= 1, 'Claude block shows all 5 examples')
    check(calls['other'] == [], 'no other Anthropic URL called')

    # Reopen: cached, no new request.
    await pg.keyboard.press('Escape')
    d = await open_panel()
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=5000)
    await pg.wait_for_timeout(500)
    check(len(calls['messages']) == 1, 'reopen: cached, no new request')
    await pg.keyboard.press('Escape')

    # Key not in localStorage / sessionStorage.
    stores = await pg.evaluate("JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)])")
    check(FAKE_KEY not in stores, 'key not in localStorage or sessionStorage')

    # Offline reload: dictionary and the saved explanation still show.
    await ctx.set_offline(True)
    await pg.reload()
    await pg.wait_for_selector('#root *', timeout=10000)
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    d = await open_panel()
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=10000)
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    check(True, 'offline: explanation and dictionary still show')
    check(len(calls['messages']) == 1, 'offline: no new request')
    await ctx.set_offline(False)
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', None)
        await run(p, 'iPhone 13', 'iPhone 13')
    sys.exit(1 if fail else 0)

asyncio.run(main())
