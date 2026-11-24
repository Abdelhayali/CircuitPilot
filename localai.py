"""pcbgo-v1 on this PC (the Windows app): download the model once, then run it with llama.cpp's server — no internet needed
afterwards. The web app connects to it like any OpenAI-compatible provider (http://127.0.0.1:<port>/v1).

    status()    what is there: runtime, model file, download progress, server state
    download()  fetch the model (resumes a partial download, checks its SHA-256), in the background
    cancel()    stop a running download (the partial file is kept for resuming)
    start()     run llama-server with the model (GPU through Vulkan when there is one, else the CPU)
    stop()      stop it (also when CircuitPilot exits)
    delete()    remove the model file (2.8 GB)
"""
import atexit
import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request

MODEL = {
    "name": "pcbgo-v1",
    "file": "pcbgo-v1-Q4_K_M.gguf",
    "url": "https://huggingface.co/abdelhayali91/pcbgo-v1/resolve/main/pcbgo-v1-Q4_K_M.gguf",
    "size": 2783446464,
    "sha256": "1791b2944c84f5c3919cc4df07b2871219f0ed33bb2344dd2313c3bca17ab590",
}
LLAMA_BUILD = "b12670"   # llama.cpp version shipped with the Windows app (desktop/build_windows.py)
DATA = os.environ.get("CP_DATA_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "CircuitPilot")
MODELS = os.path.join(DATA, "models")
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))

_lock = threading.Lock()
_dl = {"active": False, "bytes": 0, "total": MODEL["size"], "phase": "", "error": None, "cancel": False, "speed": 0}
_srv = {"proc": None, "port": None, "error": None, "log": None}


def model_path():
    return os.path.join(MODELS, MODEL["file"])


def runtime():
    """llama-server.exe: next to CircuitPilot.exe (llama/), or the copy the build script keeps, or CP_LLAMA_SERVER"""
    for p in (os.environ.get("CP_LLAMA_SERVER"), os.path.join(APP_DIR, "llama", "llama-server.exe"),
              os.path.join(APP_DIR, "build", "llama", LLAMA_BUILD, "llama-server.exe")):
        if p and os.path.isfile(p):
            return p
    return None


def _healthy(port):
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=1.5) as r:
            return r.status == 200
    except Exception:
        return False


def status():
    mp = model_path()
    have = os.path.isfile(mp) and os.path.getsize(mp) == MODEL["size"]
    part = mp + ".part"
    p = _srv["proc"]
    running = bool(p and p.poll() is None)
    if p and not running and not _srv["error"]:
        _srv["error"] = "the model server stopped" + _log_tail()
    return {
        "model": MODEL["name"], "size": MODEL["size"], "runtime": bool(runtime()), "llama_build": LLAMA_BUILD,
        "present": have, "partial": os.path.getsize(part) if os.path.isfile(part) else 0, "folder": MODELS,
        "download": {k: _dl[k] for k in ("active", "bytes", "total", "phase", "error", "speed")},
        "server": {"running": running, "ready": running and _healthy(_srv["port"]), "port": _srv["port"],
                   "url": f"http://127.0.0.1:{_srv['port']}/v1" if running else None, "error": None if running else _srv["error"]},
    }


# ---------- download ----------
def download():
    with _lock:
        if _dl["active"]:
            return status()
        if os.path.isfile(model_path()) and os.path.getsize(model_path()) == MODEL["size"]:
            return status()
        _dl.update(active=True, bytes=0, phase="connecting", error=None, cancel=False, speed=0)
    threading.Thread(target=_download, daemon=True).start()
    return status()


def cancel():
    _dl["cancel"] = True
    return status()


def _download():
    os.makedirs(MODELS, exist_ok=True)
    part = model_path() + ".part"
    try:
        have = os.path.getsize(part) if os.path.isfile(part) else 0
        if have > MODEL["size"]:
            os.remove(part); have = 0
        if have < MODEL["size"]:
            req = urllib.request.Request(MODEL["url"], headers={"User-Agent": "CircuitPilot", **({"Range": f"bytes={have}-"} if have else {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                if have and r.status != 206:   # the server ignored the range: start over
                    have = 0
                _dl.update(phase="downloading", bytes=have)
                t0, b0 = time.time(), have
                with open(part, "ab" if have else "wb") as f:
                    while True:
                        if _dl["cancel"]:
                            _dl.update(phase="cancelled", active=False)
                            return
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        dt = time.time() - t0
                        _dl.update(bytes=have, speed=int((have - b0) / dt) if dt > 1 else 0)
        if have != MODEL["size"]:
            raise IOError(f"download incomplete ({have} of {MODEL['size']} bytes) — click Download again to resume")
        _dl.update(phase="checking")
        h = hashlib.sha256()
        with open(part, "rb") as f:
            for chunk in iter(lambda: f.read(8 << 20), b""):
                h.update(chunk)
        if h.hexdigest() != MODEL["sha256"]:
            os.remove(part)
            raise IOError("the downloaded file does not match pcbgo-v1's checksum (deleted) — please download again")
        os.replace(part, model_path())
        _dl.update(phase="done", active=False)
    except Exception as e:
        _dl.update(phase="error", error=str(e), active=False)


def delete():
    stop()
    for p in (model_path(), model_path() + ".part"):
        if os.path.isfile(p):
            os.remove(p)
    return status()


# ---------- model server ----------
def _free_port(start=8091):
    for port in range(start, start + 40):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port for the model server")


def _log_tail():
    try:
        with open(_srv["log"], encoding="utf-8", errors="replace") as f:
            lines = [l.strip() for l in f.read()[-4000:].splitlines() if l.strip()]
        bad = [l for l in lines if any(k in l.lower() for k in ("error", "failed", "out of memory"))]
        return ": " + (bad or lines or [""])[-1][-300:]
    except Exception:
        return ""


def start(ctx=32768):
    with _lock:
        p = _srv["proc"]
        if p and p.poll() is None:
            return status()
        exe = runtime()
        if not exe:
            raise RuntimeError("the model runtime (llama-server) is not part of this CircuitPilot — use the Windows app from pcbgo.site")
        if not (os.path.isfile(model_path()) and os.path.getsize(model_path()) == MODEL["size"]):
            raise RuntimeError("download pcbgo-v1 first")
        port = _free_port()
        _srv.update(port=port, error=None, log=os.path.join(DATA, "pcbgo-v1-server.log"))
        logf = open(_srv["log"], "w", encoding="utf-8")
        # thinking off and mild repetition penalties: how the model was trained and benchmarked
        args = [exe, "-m", model_path(), "--alias", MODEL["name"], "--host", "127.0.0.1", "--port", str(port), "-c", str(ctx),
                # CP_LLAMA_NGL: layers on the GPU (default all; 0 = processor only, e.g. for a small or busy graphics card)
                "-ngl", os.environ.get("CP_LLAMA_NGL", "99"), "-np", "1", "--jinja", "--chat-template-kwargs", json.dumps({"enable_thinking": False}),
                "--presence-penalty", "1.5", "--repeat-penalty", "1.1", "--no-webui",
                # only CircuitPilot's own pages may call it (not any web site open in a browser)
                "--cors-origins", ",".join(f"http://{h}:{os.environ.get('CP_PORT', '5173')}" for h in ("localhost", "127.0.0.1"))]
        _srv["proc"] = subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=os.path.dirname(exe),
                                        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    return status()


def stop():
    p = _srv["proc"]
    if p and p.poll() is None:
        p.terminate()
        try:
            p.wait(10)
        except Exception:
            p.kill()
    _srv.update(proc=None, port=None)
    return status()


atexit.register(stop)
