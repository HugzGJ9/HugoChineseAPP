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


def recolour_none(xlsx: bytes, sheet: str, row: int, cols=(1, 2, 3, 4)) -> bytes:
    """What 'Excel reverted a row to no fill' looks like."""
    from openpyxl import load_workbook
    from openpyxl.styles import PatternFill
    wb = load_workbook(io.BytesIO(xlsx))
    ws = wb[sheet]
    for c in cols:
        ws.cell(row=row, column=c).fill = PatternFill(fill_type=None)
    out = io.BytesIO(); wb.save(out)
    return out.getvalue()


def fill_of(xlsx: bytes, sheet: str, row: int, col=2):
    """The solid fill of a cell as 'RRGGBB' (upper case), or None."""
    from openpyxl import load_workbook
    c = load_workbook(io.BytesIO(xlsx))[sheet].cell(row=row, column=col)
    rgb = c.fill.fgColor.rgb if c.fill.fill_type == 'solid' else None
    return rgb[-6:].upper() if isinstance(rgb, str) else None


def zip_changed(before: bytes, after: bytes):
    """Names of zip entries that differ (or were added/removed/reordered as 'ENTRY LIST') between two workbooks."""
    import zipfile
    zb, za = zipfile.ZipFile(io.BytesIO(before)), zipfile.ZipFile(io.BytesIO(after))
    out = [] if zb.namelist() == za.namelist() else ['ENTRY LIST']
    out += [n for n in zb.namelist() if n in za.namelist() and zb.read(n) != za.read(n)]
    return out


def sheet_xml_name(xlsx: bytes, sheet: str):
    from openpyxl import load_workbook
    return f'xl/worksheets/sheet{load_workbook(io.BytesIO(xlsx), read_only=True).sheetnames.index(sheet) + 1}.xml'


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
        self.uploads = []        # (item id, bytes, status) of every workbook PUT, in order
        self.before_put = []     # [(item id, bytes)]: Excel saves just before the next PUT to that item is judged (-> 412)
        self.app_puts = []       # (dir, name, if-match, conflictBehavior, status) for app folder PUTs
        self.app_dirs = set()    # created app folder directories ('data', 'backups', ...)
        self.page_size = 200     # app folder children per page; set small to exercise @odata.nextLink
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

    def excel_saves_during_next_put(self, item_id, data):
        """Excel saves `data` between the app's metadata read and its PUT: that PUT then fails with 412."""
        self.before_put.append((item_id, data))

    # App folder (OneDrive/Apps/Hugo Chinese): flat files per directory, 'data' and 'backups'.
    def app_ids(self, d='data'):
        return {it['name']: i for i, it in self.items.items() if it.get('app') == d}
    def app_files(self, d='data'):
        return {n: self.items[i]['bytes'] for n, i in self.app_ids(d).items()}
    def app_json(self, name, d='data'):
        raw = self.app_files(d).get(name)
        if raw is None: return None
        if raw[:2] == b'\x1f\x8b':
            import gzip; raw = gzip.decompress(raw)
        return json.loads(raw)
    def app_puts_unconditional(self):
        return [p for p in self.app_puts if not p[2] and p[3] != 'fail' and p[0] != 'diag']

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
            'parentReference': {'driveId': DRIVE, 'id': 'FAKEROOT', 'path': '/drive/root:' + (
                f"/Apps/Hugo%20Chinese/{it['app']}" if it.get('app') else f"/{quote(it['folder'])}" if it.get('folder') else '')},
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
            hits = [self._item_json(i) for i, it in self.items.items() if it.get('indexed', True) and not it.get('app') and search_matches(it['name'], q)]
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
        m = re.match(r'^(?:/me/drive|/drives/[^/]+)/(?:special/)?approot(?::/(.+?)(?::(/content|/children)?)?|(/children))?$', path)
        if m:
            return await self._approot(route, req, u, reply, gerr, (m.group(1) or '').strip('/'), m.group(2) or m.group(3) or '')
        m = re.match(r'^(?:/me/drive|/drives/[^/]+)/items/([^/]+)(/content|/children)?$', path)
        if m and m.group(1) in self.items:
            iid = m.group(1)
            it = self.items[iid]
            if not m.group(2) and req.method == 'GET':
                return await reply(200, self._item_json(iid))
            if m.group(2) == '/content' and req.method == 'PUT':
                if it.get('app'):
                    return await self._app_put(route, req, u, reply, gerr, it['app'], it['name'])
                if self.before_put and self.before_put[0][0] == iid:
                    self.excel_save(iid, self.before_put.pop(0)[1])
                im = req.headers.get('if-match', '')
                self.puts.append((iid, im, None))
                status = 200
                if iid in self.locked: status = 423
                elif im and im != self._item_json(iid)['eTag']: status = 412
                if not im:
                    self.violations.append(f'PUT {iid} without If-Match')
                self.puts[-1] = (iid, im, status)
                data = req.post_data_buffer or b''
                self.uploads.append((iid, data, status))
                if status == 423: return await gerr(423, 'resourceLocked')
                if status == 412: return await gerr(412, 'resourceModified')
                self.excel_save(iid, data)
                return await reply(200, self._item_json(iid))
            if m.group(2) == '/content' and req.method == 'GET':
                return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/octet-stream'}, body=it['bytes'])
            if req.method == 'DELETE':
                im = req.headers.get('if-match', '')
                if im and im != self._item_json(iid)['eTag']: return await gerr(412, 'resourceModified')
                if iid in self.locked: return await gerr(423, 'resourceLocked')
                del self.items[iid]
                return await reply(204)
        if m:
            return await gerr(404, 'itemNotFound')
        self.unrouted.append(f'{req.method} {req.url}')
        return await gerr(404, 'itemNotFound')

    # ----- app folder -----
    async def _approot(self, route, req, u, reply, gerr, sub, tail):
        """special/approot and below: 'data/<name>' files (PUT, GET, metadata), 'data' listings (paged), folder creation."""
        parts = [x for x in sub.split('/') if x]
        if not parts:
            if tail == '/children' and req.method == 'GET':
                return await self._children(route, req, u, reply, None)
            return await reply(200, {'id': 'FAKEAPPROOT', 'name': 'Hugo Chinese', 'folder': {'childCount': len(self.app_dirs)},
                                     'parentReference': {'driveId': DRIVE, 'path': '/drive/root:/Apps'}})
        if len(parts) == 1 and tail in ('/children', ''):
            d = parts[0]
            if tail == '/children' and req.method == 'POST':
                body = json.loads(req.post_data or '{}')
                if body.get('folder') is not None:
                    self.app_dirs.add(body.get('name') or d)
                    return await reply(201, {'id': 'FAKEDIR-' + (body.get('name') or d), 'name': body.get('name') or d, 'folder': {}})
            if d not in self.app_dirs:
                return await gerr(404, 'itemNotFound')
            if tail == '/children' and req.method == 'GET':
                return await self._children(route, req, u, reply, d)
            if req.method == 'GET':
                return await reply(200, {'id': 'FAKEDIR-' + d, 'name': d, 'folder': {'childCount': len(self.app_ids(d))}})
        if len(parts) == 2:
            d, name = parts
            ids = self.app_ids(d)
            if tail == '/content' and req.method == 'PUT':
                return await self._app_put(route, req, u, reply, gerr, d, name)
            if name not in ids:
                return await gerr(404, 'itemNotFound')
            if tail == '/content' and req.method == 'GET':
                return await route.fulfill(status=200, headers={**CORS, 'content-type': 'application/octet-stream'}, body=self.items[ids[name]]['bytes'])  # a real 302 would not be routable
            if tail == '' and req.method == 'GET':
                return await reply(200, self._item_json(ids[name]))
            if tail == '' and req.method == 'DELETE':
                im = req.headers.get('if-match', '')
                if im and im != self._item_json(ids[name])['eTag']: return await gerr(412, 'resourceModified')
                del self.items[ids[name]]
                return await reply(204)
        self.unrouted.append(f'{req.method} {req.url}')
        return await gerr(404, 'itemNotFound')

    async def _children(self, route, req, u, reply, d):
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        names = sorted(self.app_ids(d)) if d else []
        start = int(q.get('$skiptoken', '0') or 0)
        size = min(self.page_size, int(q.get('$top', '1000') or 1000))
        page = names[start:start + size]
        body = {'value': [self._item_json(self.app_ids(d)[n]) for n in page]}
        if start + size < len(names):
            body['@odata.nextLink'] = f'https://graph.microsoft.com{u.path}?$top={size}&$skiptoken={start + size}'
        self.log.append(f'LIST {d} page@{start} ({len(page)})')
        return await reply(200, body)

    async def _app_put(self, route, req, u, reply, gerr, d, name):
        """App data: If-Match for an existing file, or conflictBehavior=fail for a file that must not exist yet."""
        q = {k: v[0] for k, v in parse_qs(u.query).items()}
        im = req.headers.get('if-match', '')
        cb = q.get('@microsoft.graph.conflictBehavior', '')
        ids = self.app_ids(d)
        iid = ids.get(name)
        status = 200 if iid else 201
        if iid in self.locked: status = 423
        elif iid and cb == 'fail': status = 409
        elif iid and im and im != self._item_json(iid)['eTag']: status = 412
        elif not iid and im: status = 412
        self.app_puts.append((d, name, im, cb, status))
        if status in (409, 412, 423):
            return await gerr(status, {409: 'nameAlreadyExists', 412: 'resourceModified', 423: 'resourceLocked'}[status])
        data = req.post_data_buffer or b''
        self.app_dirs.add(d)
        if iid:
            self.excel_save(iid, data)
        else:
            iid = f'APP{len(self.items) + 1}-{secrets.token_hex(2)}'
            self.items[iid] = dict(name=name, bytes=data, n=1, modified=time.time(), folder='@approot/' + d, indexed=False, app=d)
        return await reply(status, self._item_json(iid))

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
