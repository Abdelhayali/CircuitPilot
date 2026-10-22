"""CircuitPilot for Windows (CircuitPilot.exe): runs the CircuitPilot server on this PC and shows the app in its own
window (Microsoft Edge in app mode — no tabs, no address bar). Closing the window stops the server, unless Claude
Desktop is using it.

    CircuitPilot.exe                    start (or, if already running, just open a window)
    CircuitPilot.exe --open URL         open a window at URL (used by the Claude Desktop connection)
    CircuitPilot.exe --server-only      run only the server, no window (started by Claude Desktop when needed)
    CircuitPilot.exe --connect-claude   add CircuitPilot to Claude Desktop and exit
    CircuitPilot.exe --port 5173 --lan  serve on another port / also to phones on the same network (needs --password)

User data (projects, parts cache, archives) lives in %LOCALAPPDATA%\\CircuitPilot.
"""
import argparse
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request

FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA = os.environ.get("CP_DATA_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "CircuitPilot")
os.makedirs(DATA, exist_ok=True)
os.environ.setdefault("CP_DATA_DIR", DATA)
# the Node.js bundled next to the exe runs the Claude Desktop connection (MCP server)
_node = os.path.join(APP_DIR, "node", "node.exe")
if os.path.exists(_node):
    os.environ.setdefault("CP_NODE", _node)
if not FROZEN:
    sys.path.insert(0, APP_DIR)

LOG = os.path.join(DATA, "circuitpilot.log")
# a windowed exe has no console (sys.stdout / stderr are None): the server's request log would fail — write it to a file
if sys.stdout is None or sys.stderr is None:
    try:
        if os.path.exists(LOG) and os.path.getsize(LOG) > 5_000_000:
            os.replace(LOG, LOG + ".old")
        _logf = open(LOG, "a", encoding="utf-8", buffering=1)
    except OSError:
        _logf = open(os.devnull, "w")
    sys.stdout = sys.stdout or _logf
    sys.stderr = sys.stderr or _logf


def log(*a):
    try:
        with open(LOG, "a", encoding="utf-8") as f:
            f.write(time.strftime("%Y-%m-%d %H:%M:%S ") + " ".join(str(x) for x in a) + "\n")
    except OSError:
        pass


def running(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/version", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def edge():
    for base in (os.environ.get("ProgramFiles(x86)"), os.environ.get("ProgramFiles"), os.environ.get("LOCALAPPDATA")):
        if base:
            p = os.path.join(base, "Microsoft", "Edge", "Application", "msedge.exe")
            if os.path.exists(p):
                return p
    return None


def open_window(url, wait=False):
    """the app in its own window; returns the window process (None when it fell back to the default browser)"""
    e = edge()
    if e:
        # a separate profile, so the window is its own process (we can tell when it is closed) and keeps its own storage
        prof = os.path.join(DATA, "window")
        p = subprocess.Popen([e, f"--app={url}", f"--user-data-dir={prof}", "--no-first-run", "--no-default-browser-check", "--window-size=1500,950"])
        if wait:
            p.wait()
        return p
    import webbrowser
    webbrowser.open(url)
    return None


def serve(port, lan, password):
    os.environ["CP_PORT"] = str(port)
    import server   # noqa: E402  (after CP_DATA_DIR is set)
    started = threading.Event()
    holder = {}

    def ready(srv):
        holder["srv"] = srv
        started.set()

    t = threading.Thread(target=server.run, kwargs=dict(port=port, allow_ports="8080,11434,1234", password=password,
                                                        bind="" if lan else "127.0.0.1", ready=ready), daemon=True)
    t.start()
    if not started.wait(15):
        raise RuntimeError(f"Could not start the server on port {port} (is another program using it?)")
    return holder["srv"]


def message(title, text):
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, title, 0x40)
    except Exception:
        print(title + ": " + text)


def main():
    ap = argparse.ArgumentParser(description="CircuitPilot for Windows")
    ap.add_argument("--port", type=int, default=5173)
    ap.add_argument("--server-only", action="store_true")
    ap.add_argument("--open", metavar="URL")
    ap.add_argument("--connect-claude", action="store_true")
    ap.add_argument("--lan", action="store_true", help="also serve to other devices on the network (requires --password)")
    ap.add_argument("--password")
    a = ap.parse_args()
    url = f"http://localhost:{a.port}"
    if a.lan and not a.password:
        message("CircuitPilot", "--lan needs --password, so nobody else on the network can use your AI keys.")
        return 2

    if a.connect_claude:
        import desktop_link
        try:
            r = desktop_link.connect(a.port)
            message("CircuitPilot", f"CircuitPilot was added to Claude Desktop.\n\n{r['next']}")
        except Exception as e:
            message("CircuitPilot", f"Could not connect Claude Desktop:\n{e}")
        return 0

    if running(a.port):          # already running (another window, or started by Claude Desktop)
        if not a.server_only:
            open_window(a.open or url)
        return 0

    log("start", "server-only" if a.server_only else "window", a.port)
    try:
        srv = serve(a.port, a.lan, a.password)
    except Exception as e:
        log("server failed", e)
        message("CircuitPilot", str(e))
        return 1
    if a.server_only:
        # started by Claude Desktop: keep serving until Claude no longer needs it (the PC session ends / it is stopped)
        while True:
            time.sleep(3600)
    win = open_window(a.open or url)
    if win is None:   # no Edge: the default browser shows the app; keep serving until the user says stop
        message("CircuitPilot", f"CircuitPilot is running at {url} in your browser.\n\nClick OK to stop it.")
    else:
        win.wait()
        # the window is closed; if another window or Claude Desktop still uses the server, keep it a little longer
        while True:
            time.sleep(20)
            if not _in_use(a.port):
                break
    srv.shutdown()
    log("stop")
    return 0


def _in_use(port):
    """a CircuitPilot tab is still open (it polls the render bridge) or Claude is mid-task"""
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/render/tabs", timeout=2) as r:
            return bool(json.loads(r.read() or b"{}").get("tabs"))
    except Exception:
        return False


if __name__ == "__main__":
    sys.exit(main())
