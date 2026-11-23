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
    'nuance': [{'word': '友人', 'pinyin': 'yǒurén', 'diff': 'Literary.'}, {'word': '同学', 'pinyin': 'tóngxué', 'diff': 'A schoolmate.'}],
    'confuse': [
        {'word': '友人', 'pinyin': 'yǒurén', 'use': 'Literary and formal; 朋友 is what you say in daily speech.',
         'self': ex('他是我的朋友。', 'tā shì wǒ de péngyou.', 'He is my friend.'), 'other': ex('他是我的友人。', 'tā shì wǒ de yǒurén.', 'He is my friend (formal).')},
        {'word': '同学', 'pinyin': 'tóngxué', 'use': 'Someone you study with; a friend does not have to be a classmate.',
         'self': ex('我和朋友去学校。', 'wǒ hé péngyou qù xuéxiào.', 'I go to school with a friend.'), 'other': ex('我和同学去学校。', '', 'I go to school with a classmate.')},
    ],
    'collocations': [ex('朋友圈', '', 'circle of friends'), ex('好朋友', 'hǎo péngyou', 'good friend'), ex('交朋友', 'jiāo péngyou', 'make friends'), ex('老朋友', 'lǎo péngyou', 'old friend')],
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


# An answer like the ones saved before prompt v2: close words only, no `confuse`.
OLD_EXPLANATION = {k: v for k, v in EXPLANATION.items() if k != 'confuse'}
OLD_EXPLANATION['nuance'] = [{'word': '学生', 'pinyin': 'xuésheng', 'diff': 'A student, not a teacher.'}]

CORS = {'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET, POST, OPTIONS'}


async def drag_down(cdp, x, y, dist=300, steps=14):
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchStart', 'touchPoints': [{'x': x, 'y': y}]})
    for i in range(1, steps + 1):
        await asyncio.sleep(0.012)
        await cdp.send('Input.dispatchTouchEvent', {'type': 'touchMove', 'touchPoints': [{'x': x, 'y': y + dist * i / steps}]})
    await cdp.send('Input.dispatchTouchEvent', {'type': 'touchEnd', 'touchPoints': []})


async def word_levels(pg, _unused, device):
    """Pinyin under every line, tappable lines, the level stack (plan 2026-11-23 WP1.2)."""
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=10000)
    top = d.locator('.wl.top')
    # Pinyin: Tatoeba examples show it by default; a collocation with no pinyin gets it computed on the device.
    await pg.wait_for_function("() => [...document.querySelectorAll('.wx-ex .wx-py')].some(e => e.textContent.trim())", timeout=8000)
    check(True, 'Tatoeba examples show a non-empty pinyin line by default')
    col = top.locator('.zb', has_text='朋友圈').first
    await col.locator('.wx-py').wait_for(timeout=8000)
    check(bool((await col.locator('.wx-py').inner_text()).strip()), 'collocation with no pinyin: computed on the device')
    # The chip hides every pinyin line, survives closing and reopening, then turns back on.
    chip = top.locator('.wx-pychip').first
    await chip.click()
    check(await top.locator('.wx-py').count() == 0, 'chip off: no pinyin line')
    await pg.keyboard.press('Escape')
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=10000)
    top = d.locator('.wl.top')
    check(await top.locator('.wx-py').count() == 0, 'chip stays off after reopening')
    await top.locator('.wx-pychip').first.click()
    await top.locator('.wx-py').first.wait_for(timeout=5000)
    check(True, 'chip back on: pinyin lines are back')
    # Tappable lines: the word is bold, his words are underlined.
    line = top.locator('.zb', has_text='他是我的朋友。').first
    check(await line.locator('.zt-w.head', has_text='朋友').count() == 1, 'the panel word is bold (.head) in Claude\'s example')
    check(await line.locator('.zt-w.mine').count() >= 1, 'his words in a line are marked (.mine)')
    await line.locator('.zt-w', has_text='的').first.click()
    top = d.locator('.wl.top')
    await top.locator('.sw-strip').wait_for(timeout=5000)
    check(await d.locator('.wl.top .sw-strip').count() == 1, 'tap 的: a level with the sentence strip')
    back = d.locator('.pp-back')
    check('朋友' in (await back.get_attribute('aria-label') or '') and '朋友' in await back.inner_text(), 'Back button names 朋友')
    if device:
        check((await back.bounding_box())['height'] >= 44, 'Back button is at least 44 px tall')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll on a nested level')
    # Back restores the scroll.
    await back.click()
    check(await d.locator('.pp-back').count() == 0 and await d.locator('.wl.top .sw-strip').count() == 0, 'Back returns to the first level')
    # Scroll restore: scroll down, push, pop.
    await d.evaluate("el => { el.scrollTop = 120 }")
    before = await d.evaluate('el => el.scrollTop')
    await d.locator('.wl.top .zt-w', has_text='朋友').first.click()
    await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
    check(await d.evaluate('el => el.scrollTop') <= 4, 'a new level starts at the top')
    await d.locator('.pp-back').click()
    await pg.wait_for_timeout(100)
    after = await d.evaluate('el => el.scrollTop')
    check(abs(after - before) <= 4, f'Back restores the scroll ({before:.0f} -> {after:.0f})')
    # Three levels: Esc goes up one level (desktop), then the close button closes everything.
    await d.locator('.wl.top .zt-w', has_text='朋友').first.click()
    await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
    await d.locator('.wl.top .zb', has_text='好朋友').first.locator('.zt-w').first.click()
    await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 3")
    check(await d.locator('.wl').count() == 3, 'three levels deep')
    if not device:
        await pg.keyboard.press('Escape')
        await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 2")
        check(await d.count() == 1, 'Esc returns to level 2')
        await d.locator('.wl.top .zb', has_text='好朋友').first.locator('.zt-w').first.click()
        await pg.wait_for_function("() => document.querySelectorAll('.wl').length === 3")
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    check(True, 'x closes the whole stack')
    if device:
        # A downward touch drag on a nested level closes the sheet.
        await pg.get_by_text('朋友', exact=True).first.click()
        d = pg.locator('.pp-panel')
        await d.locator('.wl.top .zt-w', has_text='朋友').first.wait_for(timeout=10000)
        await d.locator('.wl.top .zt-w', has_text='朋友').first.click()
        await d.locator('.wl.top .sw-strip').wait_for(timeout=5000)
        cdp = await pg.context.new_cdp_session(pg)
        box = await d.locator('.sw-hint').bounding_box()
        await drag_down(cdp, box['x'] + 40, box['y'] + 4)
        await pg.locator('.pp-panel').wait_for(state='detached', timeout=3000)
        check(True, 'a swipe down on a nested level closes the sheet')
    # Words page: a word tapped in its examples opens a sheet; x returns to the page.
    await pg.get_by_text('朋友', exact=True).first.click()
    d = pg.locator('.pp-panel')
    href = await d.get_by_role('link', name='Details').get_attribute('href')
    await pg.keyboard.press('Escape') if not device else await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    await pg.goto(U + href)
    await pg.locator('.wx .zt-w').first.wait_for(timeout=10000)
    await pg.locator('.wx .zt-w').first.click()
    await pg.locator('.pp-panel').wait_for(timeout=5000)
    check(True, 'Words page: tapping a word in its examples opens a sheet')
    await pg.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    check('#/words/' in pg.url, 'Words page: x returns to the page')


async def characters(pg, device):
    """Characters cards and "Words with X" (plan 2026-11-23 WP2.2)."""
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    await pg.get_by_text('学校', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Characters', exact=True).wait_for(timeout=10000)
    cards = d.locator('.wl.top .wx-char')
    await cards.nth(1).wait_for(timeout=8000)
    check(await cards.count() == 2, '学校: two character cards')
    t0, t1 = await cards.nth(0).inner_text(), await cards.nth(1).inner_text()
    check('学' in t0 and 'xué' in t0 and '校' in t1 and 'xiào' in t1, '学校: readings xué and xiào')
    glosses = [(await cards.nth(0).locator('.wx-char-gloss').inner_text()).strip(), (await cards.nth(1).locator('.wx-char-gloss').inner_text()).strip()]
    check(all(len(g) > 2 for g in glosses), '学校: each card has a meaning')
    sec = d.locator('.wl.top section[aria-label="Words with 学"]')
    await sec.wait_for(timeout=8000)
    await sec.get_by_role('button', name='学生').wait_for(timeout=5000)
    check(await sec.get_by_role('button', name='学习').count() == 1, '学 lists 学生 and 学习 among the common words')
    await sec.get_by_role('button', name='学生').click()
    await d.locator('.wl.top .sw-tag', has_text='Not in your list').wait_for(timeout=5000)
    check(True, 'tapping 学生 opens a nested level: Not in your list')
    await d.locator('.pp-back').click()
    await d.locator('.wl.top .wx-char').first.wait_for(timeout=5000)
    check(await d.locator('.pp-back').count() == 0, 'Back returns to 学校')
    if device:
        box = await d.locator('.wl.top .wx-char-zh').first.bounding_box()
        check(box['height'] >= 44 and box['width'] >= 44, 'character button is at least 44 px')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with Characters')
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    # A single character: no Characters heading, only Words with 好 and his 你好.
    await pg.get_by_role('tab', name='HSK四级').click()
    await pg.get_by_text('好', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('heading', name='Dictionary').wait_for(timeout=10000)
    sec = d.locator('.wl.top section[aria-label="Words with 好"]')
    await sec.wait_for(timeout=8000)
    check(await d.get_by_role('heading', name='Characters', exact=True).count() == 0, '好: no Characters heading')
    check(await sec.get_by_role('button', name='你好').count() == 1, '好: Words with 好 has his 你好 chip')
    await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')


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
            return await route.fulfill(status=200, headers={**CORS, 'content-type': 'text/event-stream'}, body=sse(OLD_EXPLANATION if '老师' in json.dumps(calls['messages'][-1]['body'], ensure_ascii=False) else EXPLANATION))
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

    # Layout: panel flush with the bottom of the viewport, no sideways scroll (after the slide-up animation ends).
    await d.evaluate('el => Promise.all(el.getAnimations().map(a => a.finished))')
    box = await d.bounding_box()
    vh = await pg.evaluate('innerHeight')
    check(abs(box['y'] + box['height'] - vh) <= 1, f'panel bottom {box["y"] + box["height"]:.0f} equals viewport bottom {vh}')
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with the panel open')

    # Before Explain more, a word with a dictionary neighbour shows "Similar meaning" (友人 in the sample build).
    sim = d.locator('section[aria-label="Similar meaning"]')
    await sim.wait_for(timeout=10000)
    check(await sim.locator('.wx-cf').count() >= 1, 'before Explain more: Similar meaning has at least 1 item')
    check(await sim.locator('.wx-cf-word', has_text='友人').count() == 1, 'Similar meaning lists 友人')

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
    await d.get_by_text('他是我的朋友。').first.wait_for(timeout=5000)
    check(await d.get_by_text('我想交新朋友。').count() >= 1, 'Claude block shows all 5 examples')
    check(calls['other'] == [], 'no other Anthropic URL called')

    # Don't confuse with: when to use which, plus a contrasting pair per item.
    cf = d.locator('section[aria-label="Don\'t confuse with"]')
    await cf.wait_for(timeout=5000)
    check(await d.locator('section[aria-label="Similar meaning"]').count() == 0, 'after Explain more: Similar meaning gives way to Don\'t confuse with')
    check(await cf.locator('.wx-cf').count() == 2, 'Don\'t confuse with shows 2 items')
    pairs = cf.locator('.wx-vs-side .zb')
    check(await pairs.count() == 4, 'each item has a pair (4 lines)')
    await cf.locator('.wx-vs-side .wx-py').nth(3).wait_for(timeout=8000)
    texts = [(await cf.locator('.wx-vs-side .zb').nth(i).locator('.wx-py').inner_text()).strip() if await cf.locator('.wx-vs-side .zb').nth(i).locator('.wx-py').count() else '' for i in range(4)]
    check(all(texts), 'every pair line has a pinyin line (the empty one is computed)')
    check(await cf.locator('.wx-foot').count() == 0, 'a v2 answer has no "older explanation" footer')
    await cf.locator('.wx-cf-word', has_text='友人').click()
    d = pg.locator('.pp-panel')
    await d.locator('.pp-back').wait_for(timeout=5000)
    check(await d.locator('.wl').count() == 2, 'tapping an item\'s word opens a nested level')
    await d.locator('.pp-back').click()
    check(await pg.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'no horizontal scroll with Don\'t confuse with')

    # Reopen: cached, no new request.
    await pg.keyboard.press('Escape')
    d = await open_panel()
    await d.get_by_role('heading', name="Claude's explanation").wait_for(timeout=5000)
    await pg.wait_for_timeout(500)
    check(len(calls['messages']) == 1, 'reopen: cached, no new request')
    await pg.keyboard.press('Escape')

    await word_levels(pg, None, device)
    await characters(pg, device)

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

    # An answer without `confuse` (as saved before v2): items without pairs, and Ask again.
    await pg.keyboard.press('Escape') if not device else await d.get_by_role('button', name='Close').click()
    await pg.locator('.pp-panel').wait_for(state='detached')
    await pg.goto(U + '#/sheets')
    await pg.get_by_role('tab', name='HSK五级').click()
    await pg.get_by_text('老师', exact=True).first.click()
    d = pg.locator('.pp-panel')
    await d.get_by_role('button', name='Explain more').click()
    cf = d.locator('section[aria-label="Don\'t confuse with"]')
    await cf.wait_for(timeout=10000)
    check(await cf.locator('.wx-cf').count() == 1 and await cf.locator('.wx-vs').count() == 0, 'old answer: its close words show, without pairs')
    check(await cf.get_by_role('button', name='Ask again for example pairs').count() == 1, 'old answer: "Ask again for example pairs"')
    await b.close()


async def main():
    async with async_playwright() as p:
        await run(p, 'desktop', None)
        await run(p, 'iPhone 13', 'iPhone 13')
    sys.exit(1 if fail else 0)

asyncio.run(main())
