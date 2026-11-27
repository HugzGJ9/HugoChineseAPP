"""Finds out what this browser lacks and shims only that, so the sync e2e scripts can run in a sandbox (cloud sessions) and
say why they stop when they cannot. Never shims anything in an environment where the probe passes (CI, a normal PC).

  probe(browser)         once per process -> {'locks': 'granted'|'timeout'|'none', 'online': bool}
  prepare(context, b)    adds an init script for what the probe found broken; prints one line per shim
  dump(page, who)        one-string picture of a page for a failure message: URL, navigator.onLine, visible notices, #sync

Why: the sync scripts used to stop at "the phone shows no sheets" with no hint. Hypotheses for a sandbox where syncs never
complete (plan 2026-11-26-boot-and-guards.md, D9): (H1) navigator.locks.request is never granted, so exclusive(syncOnce)
never runs; (H2) navigator.onLine is false, so syncOnce returns "Offline"; (H3) a request fails only there. The probe
tests H1 and H2; H3 shows up in the dump and the API log.

Shims: no Web Locks -> the property is removed (the app then runs syncs directly, as on iOS before 15.4); offline -> an
onLine getter that returns true."""
import asyncio, os
from urllib.parse import urlsplit

U = os.environ.get('HUGO_URL', 'http://localhost:4173/HugoChineseAPP/')

_result = None

PROBE_JS = """async () => {
  const out = { online: navigator.onLine, locks: 'none' };
  if (navigator.locks && navigator.locks.request) {
    out.locks = await Promise.race([
      navigator.locks.request('hz-probe', async () => 'granted'),
      new Promise(r => setTimeout(() => r('timeout'), 3000)),
    ]);
  }
  return out;
}"""

NO_LOCKS = "Object.defineProperty(Navigator.prototype, 'locks', { get: () => undefined, configurable: true });"
ONLINE = "Object.defineProperty(Navigator.prototype, 'onLine', { get: () => true, configurable: true });"


async def probe(browser):
    """Runs once per process in a fresh context on the app's own (secure) origin."""
    global _result
    if _result is not None:
        return _result
    ctx = await browser.new_context(service_workers='block')
    try:
        page = await ctx.new_page()
        await page.goto(U.split('#')[0], wait_until='domcontentloaded')
        r = await page.evaluate(PROBE_JS)
        _result = {'locks': r['locks'], 'online': bool(r['online'])}
    finally:
        await ctx.close()
    print(f"sandbox probe: Web Locks {_result['locks']}, navigator.onLine {_result['online']}")
    return _result


async def prepare(context, browser):
    """Adds the init scripts the probe says are needed. Call after new_context, before the first page."""
    r = await probe(browser)
    if r['locks'] != 'granted':
        why = 'never granted here' if r['locks'] == 'timeout' else 'missing here'
        print(f'sandbox: Web Locks {why}: the app runs syncs without them')
        await context.add_init_script(NO_LOCKS)
    if not r['online']:
        print('sandbox: navigator.onLine is false here: reported as true')
        await context.add_init_script(ONLINE)


async def dump(page, who=''):
    """URL, navigator.onLine, up to 5 visible .notice texts and the first 300 characters of #sync."""
    try:
        info = await page.evaluate("""() => {
          const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
          const notices = [...document.querySelectorAll('.notice')].filter(vis).slice(0, 5)
            .map(e => (e.className + ': ' + e.textContent).replace(/\\s+/g, ' ').trim().slice(0, 200));
          const s = document.querySelector('#sync');
          return { url: location.href, online: navigator.onLine, notices,
                   sync: s ? s.textContent.replace(/\\s+/g, ' ').trim().slice(0, 300) : null,
                   body: document.body.innerText.replace(/\\s+/g, ' ').trim().slice(0, 200) };
        }""")
    except Exception as e:  # the page may be closed or navigating
        return f'[{who}] page not readable: {e}'
    return (f"[{who}] url={info['url']} onLine={info['online']}\n  notices={info['notices']}\n  #sync={info['sync']!r}\n  body={info['body']!r}")
