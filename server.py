"""CircuitPilot dev server: serves the app and proxies local LLM servers.

    python server.py [port] [--allow-ports 8080,11434] [--password SECRET]

Requests to /llm-proxy/<port>/<path> are forwarded to http://127.0.0.1:<port>/<path>,
but only for ports in --allow-ports (default 8080). This lets the browser (and phones on
the LAN or through a tunnel) reach model servers that only listen on localhost or don't
send CORS headers.

--password (or env CP_PASSWORD) protects the whole site with a login page — use it when
exposing the server publicly (e.g. a Cloudflare tunnel).
"""
import argparse
import hashlib
import hmac
import http.server
import json
import os
import re
import secrets
import socket
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request

import archive
import partsdb
import store
import knowledge
import webtools

PROXY_RE = re.compile(r"^/llm-proxy/(\d{1,5})(/.*)?$")
STATIC_RE = re.compile(r"^/(|index\.html|styles\.css|favicon\.ico|js/[\w.-]+\.js|data/kicad-footprints\.txt|data/open-parts\.txt)$")
HOP_HEADERS = {"host", "origin", "referer", "connection", "content-length", "accept-encoding",
               "cookie", "cf-connecting-ip", "cf-ray", "cf-visitor", "cf-ipcountry", "cdn-loop",
               "x-forwarded-for", "x-forwarded-proto"}
ALLOWED_PORTS = {8080}
# Cloud model APIs without browser CORS support, reached through /llm-cloud/<name>/... (fixed destinations only)
CLOUD_RE = re.compile(r"^/llm-cloud/([a-z]+)(/.*)?$")
# Any other OpenAI-compatible provider whose API refuses browser requests (no CORS): /llm-ext/<base64url of base>/<path>
EXT_RE = re.compile(r"^/llm-ext/([A-Za-z0-9_-]+)(/.*)?$")
CLOUD_HOSTS = {"ollama": "https://ollama.com"}
PASSWORD = None
LOGIN_TICKETS = {}   # one-time login links for a headless drawing window started by the MCP server: ticket -> expiry
LOGIN_PAGE = b"""<!doctype html><meta name=viewport content="width=device-width,initial-scale=1">
<title>CircuitPilot</title><body style="background:#0f1216;color:#dfe5ec;font:15px system-ui;display:grid;place-items:center;height:100vh;margin:0">
<form method=post action=/__login style="display:flex;flex-direction:column;gap:10px;width:260px">
<b style="font-size:18px">CircuitPilot</b><input type=password name=p placeholder=Password autofocus autocapitalize=off autocorrect=off autocomplete=current-password spellcheck=false
style="padding:9px;border-radius:8px;border:1px solid #2a313b;background:#161a20;color:inherit">
<button style="padding:9px;border-radius:8px;border:0;background:#5b8cff;color:#fff;font-weight:600">Enter</button>%s</form>"""


def token():
    return hashlib.sha256(("circuitpilot:" + PASSWORD).encode()).hexdigest()


# ---------------------------------------------------------------- screenshots for MCP clients
# Claude Code's MCP server runs outside the browser, so it cannot draw the schematic, PCB, 3D board or enclosure.
# It posts a request here; the CircuitPilot tab that has that project open long-polls /api/render/next, renders
# the view and posts the image back to /api/render/result, which answers the waiting request.
_rlock = threading.Condition()
_rjobs = {}   # id -> {"project", "args", "claimed", "result"}
_rtabs = {}   # project id -> last time a browser tab with it open asked for work


_rfocus = {"project": "", "t": 0.0}   # project an MCP client (Claude) is working on


def render_focus(project):
    with _rlock:
        _rfocus.update(project=project, t=time.time())
        _rlock.notify_all()


def render_next(project, wait=25.0, since=0.0):
    end = time.time() + wait
    with _rlock:
        while True:
            _rtabs[project] = time.time()
            if _rfocus["project"] and _rfocus["project"] != project and _rfocus["t"] > since:
                return {"focus": _rfocus["project"], "t": _rfocus["t"]}
            for jid, j in _rjobs.items():
                # a job claimed by a tab that went away (reloaded, closed) is offered again after 15 s
                stale = j["claimed"] and time.time() - j["claimed"] > 15
                if (not j["claimed"] or stale) and j["result"] is None and j["project"] == project:
                    j["claimed"] = time.time()
                    return {"id": jid, "args": j["args"]}
            left = end - time.time()
            if left <= 0:
                return None
            _rlock.wait(min(left, 5))


def render_result(jid, result):
    with _rlock:
        if jid in _rjobs:
            _rjobs[jid]["result"] = result
            _rlock.notify_all()


def render_request(project, args, timeout=60.0):
    now = time.time()
    with _rlock:
        live = {p: t for p, t in _rtabs.items() if now - t < 40}
        if project not in live:
            msg = ("Screenshots are drawn by the CircuitPilot app in the browser. Open http://localhost:5173 and open this "
                   "project there (it is not open in any browser tab right now)." if not live else
                   "The browser has a different project open. Open this project in the CircuitPilot tab to take screenshots.")
            return {"error": msg}, 409
        jid = os.urandom(6).hex()
        _rjobs[jid] = {"project": project, "args": args, "claimed": 0, "result": None}
        _rlock.notify_all()
        end = time.time() + timeout
        while _rjobs[jid]["result"] is None and time.time() < end:
            _rlock.wait(min(5, end - time.time()))
            _rlock.notify_all()   # let waiting tabs re-check for a job whose claimer went away
        job = _rjobs.pop(jid)
    r = job["result"]
    if r is None:
        return {"error": "The browser did not answer in time (is the CircuitPilot tab still open?)"}, 504
    if r.get("error"):
        return {"error": r["error"]}, 400
    return {k: r.get(k) for k in ("mime", "data", "w", "h")}, 200


class Handler(http.server.SimpleHTTPRequestHandler):
    def _authed(self):
        if not PASSWORD:
            return True
        auth = self.headers.get("Authorization") or ""
        if auth.startswith("Bearer ") and hmac.compare_digest(auth[7:].strip().lower(), PASSWORD.lower()):
            return True
        for part in (self.headers.get("Cookie") or "").split(";"):
            k, _, v = part.strip().partition("=")
            if k == "cp_auth" and hmac.compare_digest(v, token()):
                return True
        return False

    def _login(self, msg=b""):
        self._send(401, LOGIN_PAGE % msg, "text/html; charset=utf-8")

    def handle_one_request(self):
        try:
            super().handle_one_request()
        except (ConnectionResetError, BrokenPipeError):
            pass

    def parse_request(self):
        ok = super().parse_request()
        if not ok:
            return False
        if self.command == "POST" and self.path == "/__login":
            n = int(self.headers.get("Content-Length") or 0)
            p = urllib.parse.parse_qs(self.rfile.read(n).decode()).get("p", [""])[0].strip()
            if PASSWORD and hmac.compare_digest(p.lower(), PASSWORD.lower()):
                self.send_response(303)
                self.send_header("Set-Cookie", f"cp_auth={token()}; Path=/; Max-Age=2592000; HttpOnly; SameSite=Lax")
                self.send_header("Location", "/")
                self.send_header("Content-Length", "0")
                super().end_headers()
            else:
                self._login(b"<span style='color:#ff5d5d'>Wrong password</span>")
            return False
        if self.command == "GET" and self.path.startswith("/login-ticket?"):
            q = urllib.parse.parse_qs(self.path.split("?", 1)[1])
            t, nxt = q.get("t", [""])[0], q.get("next", ["/"])[0]
            if not nxt.startswith("/") or nxt.startswith("//"):
                nxt = "/"
            if PASSWORD and LOGIN_TICKETS.pop(t, 0) > time.time():
                self.send_response(303)
                self.send_header("Set-Cookie", f"cp_auth={token()}; Path=/; Max-Age=86400; HttpOnly; SameSite=Lax")
                self.send_header("Location", nxt)
                self.send_header("Content-Length", "0")
                super().end_headers()
            else:
                self._login()
            return False
        if not self._authed():
            self._login()
            return False
        if self.command == "POST" and self.path == "/api/login-ticket":   # only with the password (Bearer): a link valid once, for 60 s
            for k, exp in list(LOGIN_TICKETS.items()):
                if exp < time.time():
                    LOGIN_TICKETS.pop(k, None)
            t = secrets.token_urlsafe(24) if PASSWORD else None
            if t:
                LOGIN_TICKETS[t] = time.time() + 60
            self._send(200, json.dumps({"ticket": t}).encode(), "application/json")
            return False
        return True
    def end_headers(self):
        # never let browsers run stale app code after an update
        self.send_header("Cache-Control", "no-cache, must-revalidate")
        super().end_headers()

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/llm-proxy/_ping":
            return self._send(200, b'{"ok":true}', "application/json")
        if PROXY_RE.match(path):
            return self._proxy()
        if CLOUD_RE.match(path):
            return self._cloud()
        if EXT_RE.match(path):
            return self._ext()
        if path == "/api/version":  # changes whenever the app files change → open tabs offer a reload
            files = ["index.html", "styles.css"] + ["js/" + f for f in os.listdir("js") if f.endswith(".js")]
            v = max(os.path.getmtime(f) for f in files if os.path.exists(f))
            return self._send(200, json.dumps({"version": str(int(v)), "data_dir": os.path.dirname(store.DB_PATH)}).encode(), "application/json")
        if path.startswith("/api/parts/"):
            return self._parts(path)
        if path.startswith(("/api/projects", "/api/library")):
            return self._store(path)
        if path.startswith("/api/knowledge/"):
            return self._knowledge(path)
        if path.startswith("/api/web/"):
            return self._web(path)
        if path == "/api/render/tabs":   # is the app open in a browser? (Claude Desktop opens it when not)
            now = time.time()
            with _rlock:
                live = [p for p, t in _rtabs.items() if now - t < 40]
            return self._send(200, json.dumps({"tabs": len(live), "projects": live}).encode(), "application/json")
        if path == "/api/render/next":
            q = urllib.parse.parse_qs(self.path.partition("?")[2])
            job = render_next((q.get("project") or [""])[0], since=float((q.get("since") or ["0"])[0] or 0))
            return self._send(200, json.dumps(job).encode(), "application/json") if job else self._send(204, b"", "application/json")
        if not STATIC_RE.match(path):  # never serve parts.db, *.py, password file, .git ...
            return self._send(404, b"not found", "text/plain")
        super().do_GET()

    def _parts(self, path):
        q = urllib.parse.parse_qs(self.path.partition("?")[2])
        arg = lambda k, d="": (q.get(k) or [d])[0]
        try:
            if path == "/api/parts/search":
                out = partsdb.search(arg("q"), arg("limit", "20"))
            elif path == "/api/parts/local":
                out = {"source": "local", "results": partsdb.search_local(arg("q"), int(arg("limit", "50")))}
            elif path == "/api/parts/stats":
                out = partsdb.stats()
            elif path == "/api/parts/archive":
                out = archive.status()
            elif path == "/api/parts/claude-desktop":
                import desktop_link
                out = desktop_link.status()
            elif path.startswith("/api/parts/get/"):
                out = partsdb.get_part(path.rsplit("/", 1)[1])
            else:
                return self._send(404, b'{"error":"unknown endpoint"}', "application/json")
            self._send(200, json.dumps(out).encode(), "application/json")
        except Exception as e:
            self._send(502 if isinstance(e, (urllib.error.URLError, TimeoutError)) else 400,
                       json.dumps({"error": str(e)}).encode(), "application/json")

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/api/parts/claude-desktop/connect":   # add CircuitPilot to Claude Desktop's MCP servers
            if not self._authed():
                return self._send(401, b'{"error":"login required"}', "application/json")
            import desktop_link
            try:
                return self._send(200, json.dumps(desktop_link.connect()).encode(), "application/json")
            except Exception as e:
                return self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")
        if path == "/api/parts/archive/download":   # start downloading a parts archive (progress: GET /api/parts/archive)
            if not self._authed():
                return self._send(401, b'{"error":"login required"}', "application/json")
            kind = (urllib.parse.parse_qs(self.path.partition("?")[2]).get("kind") or ["basic"])[0]
            try:
                return self._send(200, json.dumps(archive.download(kind)).encode(), "application/json")
            except ValueError as e:
                return self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")
        if PROXY_RE.match(path):
            return self._proxy()
        if CLOUD_RE.match(path):
            return self._cloud()
        if EXT_RE.match(path):
            return self._ext()
        if path.startswith(("/api/projects", "/api/library")):
            return self._store(path)
        if path in ("/api/render/request", "/api/render/result", "/api/render/focus") and self.command == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if n > 30_000_000:
                return self._send(413, b'{"error":"too large"}', "application/json")
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._send(400, b'{"error":"body must be JSON"}', "application/json")
            if path == "/api/render/result":
                render_result(str(body.get("id", "")), body)
                return self._send(200, b'{"ok":true}', "application/json")
            if path == "/api/render/focus":   # an MCP client switched project: open browser tabs follow it
                render_focus(str(body.get("project") or ""))
                return self._send(200, b'{"ok":true}', "application/json")
            out, status = render_request(str(body.get("project") or ""), body.get("args") or {})
            return self._send(status, json.dumps(out).encode(), "application/json")
        if path == "/api/extract" and self.command == "POST":  # text of a file attached in the chat
            n = int(self.headers.get("Content-Length") or 0)
            if n > 40_000_000:
                return self._send(413, b'{"error":"file too large (max 40 MB)"}', "application/json")
            name = urllib.parse.parse_qs(self.path.partition("?")[2]).get("name", ["file"])[0]
            out = knowledge.extract_bytes(name, self.rfile.read(n) if n else b"")
            return self._send(200, json.dumps(out).encode(), "application/json")
        self._send(404, b"not found", "text/plain")

    do_PUT = do_DELETE = do_POST

    def _web(self, path):
        q = urllib.parse.parse_qs(self.path.partition("?")[2])
        arg = lambda k, d="": (q.get(k) or [d])[0]
        try:
            op = path.rsplit("/", 1)[1]
            if op == "search":
                out = webtools.search(arg("q"), arg("n", "8"), self.headers.get("X-Brave-Key") or None)
            elif op == "fetch":
                out = webtools.fetch(arg("url"), arg("offset", "0"), arg("length", "12000"))
            else:
                return self._send(404, b'{"error":"unknown endpoint"}', "application/json")
            self._send(200, json.dumps(out).encode(), "application/json")
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")

    def _knowledge(self, path):
        q = urllib.parse.parse_qs(self.path.partition("?")[2])
        arg = lambda k, d="": (q.get(k) or [d])[0]
        try:
            op = path.rsplit("/", 1)[1]
            if op == "list":
                out = knowledge.list_files(arg("path"))
            elif op == "read":
                out = knowledge.read_file(arg("path"), arg("file"), arg("offset", "0"), arg("length", "20000"))
            elif op == "search":
                out = knowledge.search(arg("path"), arg("q"), arg("limit", "12"))
            elif op == "digest":
                out = knowledge.digest(arg("path"), int(arg("budget", "24000")))
            else:
                return self._send(404, b'{"error":"unknown endpoint"}', "application/json")
            self._send(200, json.dumps(out).encode(), "application/json")
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")

    def _store(self, path):
        parts = [p for p in path.split("/") if p][1:]  # ["projects", id?] / ["library", key?]
        kind, key = parts[0], (parts[1] if len(parts) > 1 else None)
        try:
            body = None
            n = int(self.headers.get("Content-Length") or 0)
            if n > 30_000_000:
                return self._send(413, b'{"error":"too large"}', "application/json")
            if n:
                body = json.loads(self.rfile.read(n).decode("utf-8"))
            m = self.command
            if kind == "projects":
                if m == "GET" and key == "_deleted":
                    out = store.deleted_projects()
                elif m == "GET" and key and len(parts) > 2 and parts[2] == "meta":
                    out = store.get_meta(key)
                elif m == "GET" and key and len(parts) > 2 and parts[2] == "versions":
                    out = store.get_version(key, parts[3]) if len(parts) > 3 else store.list_versions(key)
                elif m == "POST" and key and len(parts) > 2 and parts[2] == "restore":
                    out = store.restore_version(key, (body or {}).get("version"))
                elif m == "GET":
                    out = store.get_project(key) if key else store.list_projects()
                elif m in ("PUT", "POST"):
                    out = store.save_project(key, body)
                elif m == "DELETE" and key:
                    out = store.delete_project(key)
                else:
                    raise ValueError("bad request")
            elif kind == "library":
                if m == "GET" and not key:
                    out = store.list_parts()
                elif m in ("PUT", "POST") and key:
                    out = store.save_part(key, body)
                elif m == "DELETE" and key:
                    out = store.delete_part(key)
                else:
                    raise ValueError("bad request")
            else:
                return self._send(404, b'{"error":"unknown endpoint"}', "application/json")
            self._send(200, json.dumps(out).encode(), "application/json")
        except LookupError as e:
            self._send(404, json.dumps({"error": str(e)}).encode(), "application/json")
        except Exception as e:
            self._send(400, json.dumps({"error": str(e)}).encode(), "application/json")

    def _send(self, code, body, ctype):
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _cloud(self):
        path, _, query = self.path.partition("?")
        name, rest = CLOUD_RE.match(path).groups()
        host = CLOUD_HOSTS.get(name)
        if not host:
            return self._send(404, b'{"error":{"message":"unknown cloud provider"}}', "application/json")
        url = host + (rest or "/") + (f"?{query}" if query else "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("authorization", "content-type", "accept")}
        headers["User-Agent"] = "CircuitPilot"
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:
            self._send(502, json.dumps({"error": {"message": f"Could not reach {host}: {e}"}}).encode(), "application/json")

    def _ext(self):
        """Forward to a public https LLM API given as base64url in the path (key and body passed through, nothing kept)."""
        import base64
        path, _, query = self.path.partition("?")
        enc, rest = EXT_RE.match(path).groups()
        try:
            base = base64.urlsafe_b64decode(enc + "=" * (-len(enc) % 4)).decode("utf-8").rstrip("/")
            u = urllib.parse.urlparse(base)
            if u.scheme != "https" or not u.hostname:
                raise ValueError("only https:// provider URLs can be forwarded")
            webtools._public(u.hostname)   # never into the local network
        except Exception as e:
            return self._send(400, json.dumps({"error": {"message": f"Bad provider URL: {e}"}}).encode(), "application/json")
        url = base + (rest or "/") + (f"?{query}" if query else "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() in ("authorization", "content-type", "accept")}
        headers["User-Agent"] = "CircuitPilot"
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:
            self._send(502, json.dumps({"error": {"message": f"Could not reach {u.hostname}: {e}"}}).encode(), "application/json")

    def _proxy(self):
        path, _, query = self.path.partition("?")
        port, rest = PROXY_RE.match(path).groups()
        if int(port) not in ALLOWED_PORTS:
            msg = (f'{{"error":{{"message":"Port {port} is not allowed by the proxy. '
                   f'Restart server.py with --allow-ports {port}"}}}}').encode()
            return self._send(403, msg, "application/json")
        url = f"http://127.0.0.1:{port}{rest or '/'}" + (f"?{query}" if query else "")
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        headers = {k: v for k, v in self.headers.items() if k.lower() not in HOP_HEADERS}
        req = urllib.request.Request(url, data=body, headers=headers, method=self.command)
        try:
            with urllib.request.urlopen(req, timeout=900) as r:
                self._send(r.status, r.read(), r.headers.get("Content-Type", "application/json"))
        except urllib.error.HTTPError as e:
            self._send(e.code, e.read(), e.headers.get("Content-Type", "application/json"))
        except Exception as e:  # connection refused, timeout, ...
            msg = f'{{"error":{{"message":"Proxy could not reach {url}: {e}"}}}}'.encode()
            self._send(502, msg, "application/json")

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


class _Server(http.server.ThreadingHTTPServer):
    # Windows lets a second server bind a port that is already in use (SO_REUSEADDR), and requests then go to either
    # one at random: the app window and a server.py would mix projects. Own the port exclusively instead.
    allow_reuse_address = os.name != "nt"

    def server_bind(self):
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


def run(port=5173, allow_ports="8080", password=None, bind="", ready=None):
    """start serving (blocks). The Windows app calls this from a thread with bind="127.0.0.1"."""
    global ALLOWED_PORTS, PASSWORD
    ALLOWED_PORTS = {int(p) for p in str(allow_ports).split(",") if str(p).strip()}
    PASSWORD = password or None
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    srv = _Server((bind, port), Handler)
    print(f"CircuitPilot on http://{bind or '0.0.0.0'}:{port}  proxy ports: {sorted(ALLOWED_PORTS)}  "
          f"password: {'on' if PASSWORD else 'off'}", flush=True)
    if ready:
        ready(srv)
    srv.serve_forever()


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="CircuitPilot server")
    ap.add_argument("port", nargs="?", type=int, default=5173)
    ap.add_argument("--allow-ports", default="8080", help="comma-separated local ports the LLM proxy may reach")
    ap.add_argument("--password", default=os.environ.get("CP_PASSWORD"), help="require this password (or env CP_PASSWORD)")
    ap.add_argument("--password-file", help="read the password from this file")
    a = ap.parse_args()
    if a.password_file:
        with open(a.password_file, encoding="utf-8") as f:
            a.password = f.read().strip()
    try:
        run(a.port, a.allow_ports, a.password)
    except OSError as e:
        if getattr(e, "winerror", None) in (10048, 10013) or getattr(e, "errno", None) in (48, 98):
            sys.exit(f"Port {a.port} is already in use - CircuitPilot (the app or another server.py) is probably running: "
                     f"open http://localhost:{a.port}, or start this one on another port: python server.py {a.port + 1}")
        raise
