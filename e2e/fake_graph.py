"""In-memory stand-in for Microsoft sign-in (login.microsoftonline.com), Microsoft Graph and the OneDrive download host,
served through Playwright routes. No real credentials, no real request: every Microsoft host that is not handled here is
aborted and recorded in FakeMicrosoft.unrouted, which the e2e script asserts is empty.

    ms = FakeMicrosoft(); ms.add_workbook('Hugo_chinese_vocab.xlsx', bytes); await ms.install(context)
Contexts (computer, iPhone) can share one instance: they see the same drive."""
import base64, hashlib, io, json, re, time, secrets
from urllib.parse import urlsplit, parse_qs, unquote, quote

DRIVE = 'FAKEDRIVE1'
CORS = {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'authorization, content-type, if-match, if-none-match, prefer, accept',
    'access-control-allow-methods': 'GET, PUT, POST, DELETE, PATCH, OPTIONS',
    'access-control-expose-headers': 'etag, retry-after',
}
HOSTS = re.compile(r'^https://([^/]*\.)?(microsoftonline\.com|microsoft\.com|microsoftpersonalcontent\.com|1drv\.com|'
                   r'live\.com|sharepoint\.com|office\.com|windows\.net)(/|$)')


def quick_xor_hash(data: bytes) -> str:
    """OneDrive quickXorHash (port of rclone's backend/onedrive/quickxorhash): 160 bits, shift 11, length xor-ed in."""
    width, mask = 160, (1 << 160) - 1
    acc = 0
    # Bytes at the same shift position (i mod 160 cycles of 11-bit steps) repeat every 160 bytes: xor them first.
    for i, b in enumerate(data):
        if b:
            v = b << ((i * 11) % width)
            acc ^= (v | (v >> width)) & mask
    raw = bytearray(acc.to_bytes(20, 'little'))
    for k, lb in enumerate(len(data).to_bytes(8, 'little')):
        raw[12 + k] ^= lb
    return base64.b64encode(bytes(raw)).decode()


def recolour(xlsx: bytes, sheet: str, row: int, rgb: str, cols=(1, 2, 3, 4)) -> bytes:
    """What 'Excel saved a recoloured row' looks like: re-saves the workbook with openpyxl (needs openpyxl)."""
    from openpyxl import load_workbook
    from openpyxl.styles import PatternFill
    from openpyxl.styles.colors import Color
    wb = load_workbook(io.BytesIO(xlsx))
    ws = wb[sheet]
    for c in cols:
        ws.cell(row=row, column=c).fill = PatternFill('solid', fgColor=Color(rgb='FF' + rgb))
    out = io.BytesIO(); wb.save(out)
    return out.getvalue()


def name_words(name):
    """OneDrive search splits a name into words: 'Hugo_chinese_vocab.xlsx' -> hugo, chinese, vocab, xlsx."""
    return [w for w in re.split(r'[\W_]+', name.lower()) if w]


def search_matches(name, q):
    """Like consumer OneDrive search (and src/lib/ms/fake.ts): the query splits on spaces and underscores, each term (dots
    trimmed) must start a word of the name. The exact name 'Hugo_chinese_vocab.xlsx' finds nothing; its words do."""
    terms = [t.strip('.') for t in re.split(r'[\s_]+', q.lower())]
    terms = [t for t in terms if t]
    words = name_words(name)
    return bool(terms) and all(any(w.startswith(t) for w in words) for t in terms)


def _iso(t):
    return time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime(t))


class FakeMicrosoft:
    def __init__(self, account='Test User', email='test.user@example.invalid'):
        self.account, self.email = account, email
        self.items = {}          # id -> dict(name, bytes, n, modified)
        self.session = True      # a live Microsoft session: prompt=none succeeds
        self.access_ttl = 3600   # seconds
        self.refresh_alive = True
        self.codes = {}          # code -> dict(challenge, scope)
        self.access = {}         # token -> expires_at
        self.refresh = {}        # token -> alive?
        self.locked = set()
        self.fail = []           # [(status, retry_after)] consumed by the next Graph requests
        self.log = []            # 'METHOD host/path'
        self.unrouted = []       # Microsoft requests nobody handled (aborted or 404)
        self.violations = []     # protocol problems: workbook PUT without If-Match, Authorization sent to download host
        self.puts = []           # (item id, if-match, status)
        self.recent = []         # item ids served by /me/drive/recent (as remoteItem entries, like a consumer drive)
        self.searches = []       # (query, hits)
        self._n = 0

    # ----- controls -----
    def add_workbook(self, name, data, at=None, item_id='FAKEITEM1', folder='', indexed=True):
        """A file at `folder` ('' = the drive root, 'Documents/Chinese'); indexed=False: search does not see it yet."""
        self.items[item_id] = dict(name=name, bytes=data, n=1, modified=at or time.time() - 3600, folder=folder.strip('/'),
                                   indexed=indexed)
        return item_id

    def excel_save(self, item_id, data, at=None):
        """Excel (or Excel online) saves the file: new bytes, new eTag/cTag, new modified time."""
        it = self.items[item_id]
        it.update(bytes=data, n=it['n'] + 1, modified=at or time.time())

    def lock(self, item_id): self.locked.add(item_id)
    def unlock(self, item_id): self.locked.discard(item_id)
    def fail_next(self, status, retry_after=None, count=1): self.fail += [(status, retry_after)] * count
    def set_session(self, on): self.session = on
    def expire_access(self): self.access.clear()
    def expire_refresh(self):
        """The 24 h browser-app limit hit: the refresh token is dead (invalid_grant)."""
        self.refresh_alive = False
        for k in self.refresh: self.refresh[k] = False
        self.access.clear()
    def revive_refresh(self): self.refresh_alive = True
    def bytes_of(self, item_id): return self.items[item_id]['bytes']
    def hash_of(self, item_id): return quick_xor_hash(self.items[item_id]['bytes'])
    def puts_without_if_match(self): return [p for p in self.puts if not p[1]]

    # ----- install -----
    async def install(self, context):
        await context.route(HOSTS, self._dispatch)

    async def _dispatch(self, route):
        req = route.request
        u = urlsplit(req.url)
        self.log.append(f'{req.method} {u.netloc}{u.path}')
        if req.method == 'OPTIONS':
            return await route.fulfill(status=204, headers=CORS)
        host = u.netloc
        if host == 'login.microsoftonline.com':
            return await self._login(route, req, u)
        if host == 'graph.microsoft.com':
            return await self._graph(route, req, u)
        if host.endswith('.microsoftpersonalcontent.com'):
            return await self._download(route, req, u)
        self.unrouted.append(f'{req.method} {req.url}')
        return await route.abort()

    # ----- sign-in -----
    async def _login(self, route, req, u):
        m = re.match(r'^/(consumers|organizations|common)/oauth2/v2\.0/(authorize|token)$', u.path)
        if not m:
            self.unrouted.append(f'{req.method} {req.url}')
            return await route.abort()
        if m.group(2) == 'authorize':
            q = {k: v[0] for k, v in parse_qs(u.query).items()}
            redirect, state = q.get('redirect_uri', ''), q.get('state', '')
            if not redirect or q.get('code_challenge_method') != 'S256' or not q.get('code_challenge'):
                self.violations.append('authorize without S256 PKCE or redirect_uri')
                return await route.fulfill(status=400, body='bad authorize request')
            sep = '&' if '?' in redirect else '?'
            if q.get('prompt') == 'none' and not self.session:
                loc = f'{redirect}{sep}error=login_required&error_description=AADSTS50058+no+session&state={quote(state)}'
            else:
                code = secrets.token_hex(8)
                self.codes[code] = dict(challenge=q['code_challenge'], scope=q.get('scope', ''))
                self.session = True
                loc = f'{redirect}{sep}code={code}&state={quote(state)}'
            return await route.fulfill(status=302, headers={'location': loc, 'cache-control': 'no-store'})
        # token endpoint (POST, form-encoded)
        form = {k: v[0] for k, v in parse_qs(req.post_data or '').items()}
        def err(code, desc, status=400):
            return route.fulfill(status=status, headers={**CORS, 'content-type': 'application/json'},
                                 body=json.dumps({'error': code, 'error_description': desc}))
        grant = form.get('grant_type')
        if grant == 'authorization_code':
            c = self.codes.pop(form.get('code', ''), None)
            if not c:
                return await err('invalid_grant', 'AADSTS70000: unknown code')
            digest = base64.urlsafe_b64encode(hashlib.sha256(form.get('code_verifier', '').encode()).digest()).rstrip(b'=').decode()
            if digest != c['challenge']:
                return await err('invalid_grant', 'AADSTS50148: PKCE verifier mismatch')
            scope = c['scope']
        elif grant == 'refresh_token':
            rt = form.get('refresh_token', '')
            if not self.refresh.get(rt) or not self.refresh_alive:
                return await err('invalid_grant', 'AADSTS700084: the refresh token has expired (24 h browser limit)')
            scope = form.get('scope', '')
        else:
            return await err('unsupported_grant_type', 'unsupported')
        at, rt = 'fake-at-' + secrets.token_hex(8), 'fake-rt-' + secrets.token_hex(8)
        self.access[at] = time.time() + self.access_ttl
        self.refresh[rt] = True
        def b64(d): return base64.urlsafe_b64encode(json.dumps(d).encode()).rstrip(b'=').decode()
        id_token = '.'.join([b64({'alg': 'none'}), b64({'name': self.account, 'preferred_username': self.email,
                                                         'oid': '00000000-0000-0000-0000-000000000001'}), 'sig'])
        body = dict(token_type='Bearer', scope=scope, expires_in=self.access_ttl, access_token=at, refresh_token=rt, id_token=id_token)
        return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/json'}, body=json.dumps(body))

    # ----- Graph -----
    def _item_json(self, item_id):
        it = self.items[item_id]
        return {
            'id': item_id, 'name': it['name'], 'size': len(it['bytes']),
            'eTag': f'"{{FAKE-{item_id}}},{it["n"]}"', 'cTag': f'"c:{{FAKE-{item_id}}},{it["n"]}"',
            'lastModifiedDateTime': _iso(it['modified']),
            'parentReference': {'driveId': DRIVE, 'id': 'FAKEROOT', 'path': '/drive/root:' + (f"/{quote(it['folder'])}" if it.get('folder') else '')},
            'file': {'hashes': {'quickXorHash': quick_xor_hash(it['bytes'])}},
            '@microsoft.graph.downloadUrl': f'https://fake-{secrets.token_hex(3)}.microsoftpersonalcontent.com/dl/{item_id}/{it["n"]}',
        }

    async def _graph(self, route, req, u):
        def reply(status, body=None, extra=None):
            return route.fulfill(status=status, headers={**CORS, 'content-type': 'application/json', **(extra or {})},
                                 body=json.dumps(body) if body is not None else '')
        def gerr(status, code, retry=None):
            return reply(status, {'error': {'code': code, 'message': code}}, {'retry-after': str(retry)} if retry else None)
        auth = req.headers.get('authorization', '')
        tok = auth[7:] if auth.startswith('Bearer ') else ''
        if self.access.get(tok, 0) < time.time():
            return await gerr(401, 'InvalidAuthenticationToken')
        if self.fail:
            status, retry = self.fail.pop(0)
            return await gerr(status, 'generalException' if status != 429 else 'activityLimitReached', retry)
        path = unquote(re.sub(r'^/v1\.0', '', u.path))
        if path == '/me':
            return await reply(200, {'displayName': self.account, 'userPrincipalName': self.email, 'id': '00000000-0000-0000-0000-000000000001'})
        if path in ('/me/drive', f'/drives/{DRIVE}'):
            return await reply(200, {'id': DRIVE, 'driveType': 'personal'})
        m = re.match(r"^(/me/drive|/drives/[^/]+)/root/search\(q='(.*)'\)$", path)
        if m:
            q = m.group(2).replace("''", "'")
            hits = [self._item_json(i) for i, it in self.items.items() if it.get('indexed', True) and search_matches(it['name'], q)]
            self.searches.append((q, len(hits)))
            return await reply(200, {'value': hits})
        if path == '/me/drive/recent':
            hits = [dict(id='REF-' + i, name=self.items[i]['name'], remoteItem=self._item_json(i)) for i in self.recent if i in self.items]
            return await reply(200, {'value': hits})
        m = re.match(r'^(?:/me/drive|/drives/([^/]+))/root:/(.+?):?$', path)
        if m:
            want = m.group(2).strip('/').lower()
            if m.group(1) in (None, DRIVE):
                for iid, it in self.items.items():
                    full = (it.get('folder') + '/' if it.get('folder') else '') + it['name']
                    if full.lower() == want:
                        return await reply(200, self._item_json(iid))
            return await gerr(404, 'itemNotFound')
        m = re.match(r'^(?:/me/drive|/drives/[^/]+)/items/([^/]+)(/content)?$', path)
        if m and m.group(1) in self.items:
            iid = m.group(1)
            it = self.items[iid]
            if not m.group(2) and req.method == 'GET':
                return await reply(200, self._item_json(iid))
            if m.group(2) and req.method == 'GET':
                return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/octet-stream'}, body=it['bytes'])
            if m.group(2) and req.method == 'PUT':
                im = req.headers.get('if-match', '')
                self.puts.append((iid, im, None))
                status = 200
                if iid in self.locked: status = 423
                elif im and im != self._item_json(iid)['eTag']: status = 412
                if not im:
                    self.violations.append(f'PUT {iid} without If-Match')
                self.puts[-1] = (iid, im, status)
                if status == 423: return await gerr(423, 'resourceLocked')
                if status == 412: return await gerr(412, 'resourceModified')
                data = req.post_data_buffer or b''
                self.excel_save(iid, data)
                return await reply(200, self._item_json(iid))
        if m:
            return await gerr(404, 'itemNotFound')
        self.unrouted.append(f'{req.method} {req.url}')
        return await gerr(404, 'itemNotFound')

    # ----- download host -----
    async def _download(self, route, req, u):
        if req.headers.get('authorization'):
            self.violations.append('Authorization header sent to the download host')
        m = re.match(r'^/dl/([^/]+)/(\d+)$', u.path)
        if not m or m.group(1) not in self.items:
            self.unrouted.append(f'{req.method} {req.url}')
            return await route.fulfill(status=404, headers=CORS, body='not found')
        return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/octet-stream'},
                                   body=self.items[m.group(1)]['bytes'])


if __name__ == '__main__':
    # Self-check of the hash port: the empty input and a length-only vector.
    assert quick_xor_hash(b'') == 'AAAAAAAAAAAAAAAAAAAAAAAAAAA=', quick_xor_hash(b'')
    print('quick_xor_hash(empty) ok;', quick_xor_hash(b'a'))
