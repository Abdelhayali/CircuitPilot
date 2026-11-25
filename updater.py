"""App updates for the Windows app: is there a newer CircuitPilot release on GitHub? Download it, check it, install it, restart.

    api(op)   check | download | cancel | install   (status in every answer)

The installed version is version.txt next to CircuitPilot.exe (written by desktop/build_windows.py). Only the public release
list is read (no personal data is sent). The zip is checked against the SHA-256 GitHub publishes for it, unpacked into
%LOCALAPPDATA%\\CircuitPilot\\update, and a small script copies it over the app folder once CircuitPilot has closed, then
starts it again. Projects and settings live in %LOCALAPPDATA%\\CircuitPilot and are not touched.
"""
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import urllib.request
import zipfile

REPO = "Abdelhayali/CircuitPilot"
ASSET = "CircuitPilot-Windows.zip"
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
DATA = os.environ.get("CP_DATA_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "CircuitPilot")
UPD = os.path.join(DATA, "update")
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)

_cache = {"t": 0, "rel": None, "error": None}
_dl = {"active": False, "tag": None, "bytes": 0, "total": 0, "phase": None, "error": None, "cancel": False, "ready": None}
_lock = threading.Lock()


def current():
    for p in (os.path.join(APP_DIR, "version.txt"), os.path.join(APP_DIR, "_internal", "version.txt")):
        try:
            with open(p, encoding="utf-8") as f:
                return f.read().strip() or None
        except OSError:
            pass
    return None


def _num(tag):
    return tuple(int(x) for x in re.findall(r"\d+", tag or ""))


def _latest(force=False):
    if _cache["rel"] is not None and not force and time.time() - _cache["t"] < 3600:
        return _cache["rel"]
    try:
        req = urllib.request.Request(f"https://api.github.com/repos/{REPO}/releases/latest",
                                     headers={"User-Agent": "CircuitPilot", "Accept": "application/vnd.github+json"})
        with urllib.request.urlopen(req, timeout=20) as r:
            j = json.loads(r.read())
        a = next((x for x in j.get("assets", []) if x.get("name") == ASSET), None)
        rel = {"tag": j.get("tag_name"), "name": j.get("name") or j.get("tag_name"), "notes": (j.get("body") or "")[:4000],
               "page": j.get("html_url"), "date": (j.get("published_at") or "")[:10],
               "url": a and a.get("browser_download_url"), "size": a and a.get("size"),
               "sha256": a and (a.get("digest") or "").replace("sha256:", "") or None}
        _cache.update(t=time.time(), rel=rel, error=None)
    except Exception as e:
        _cache.update(t=time.time(), error=str(e))
    return _cache["rel"]


def status(force=False):
    cur, rel = current(), _latest(force)
    newer = bool(cur and _num(cur) and rel and rel.get("tag") and _num(rel["tag"]) > _num(cur))
    return {"current": cur, "app": FROZEN and os.name == "nt", "latest": rel, "newer": newer, "error": _cache["error"],
            "download": {k: _dl[k] for k in ("active", "tag", "bytes", "total", "phase", "error")} | {"ready": bool(_dl["ready"])}}


def download():
    if not (FROZEN and os.name == "nt"):
        raise RuntimeError("updates install in the Windows app; download the new version from the release page")
    rel = _latest(True)
    if not (rel and rel.get("url")):
        raise RuntimeError("the latest release has no Windows download")
    with _lock:
        if _dl["active"]:
            return status()
        if _dl["ready"] and _dl["tag"] == rel["tag"]:
            return status()
        _dl.update(active=True, tag=rel["tag"], bytes=0, total=rel.get("size") or 0, phase="downloading", error=None, cancel=False, ready=None)
    threading.Thread(target=_download, args=(rel,), daemon=True).start()
    return status()


def _download(rel):
    try:
        os.makedirs(UPD, exist_ok=True)
        zp = os.path.join(UPD, f"CircuitPilot-{rel['tag']}.zip")
        size = rel.get("size") or 0
        have = os.path.getsize(zp) if os.path.isfile(zp) else 0
        if size and have > size:
            os.remove(zp); have = 0
        if not size or have < size:
            req = urllib.request.Request(rel["url"], headers={"User-Agent": "CircuitPilot", **({"Range": f"bytes={have}-"} if have else {})})
            with urllib.request.urlopen(req, timeout=60) as r:
                if have and r.status != 206:
                    have = 0
                with open(zp, "ab" if have else "wb") as f:
                    while True:
                        if _dl["cancel"]:
                            _dl.update(phase="paused", active=False)
                            return
                        chunk = r.read(1 << 20)
                        if not chunk:
                            break
                        f.write(chunk)
                        have += len(chunk)
                        _dl["bytes"] = have
        _dl.update(phase="checking", bytes=have)
        if rel.get("sha256"):
            h = hashlib.sha256()
            with open(zp, "rb") as f:
                for chunk in iter(lambda: f.read(8 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != rel["sha256"]:
                os.remove(zp)
                raise IOError("the download does not match the SHA-256 GitHub publishes for it (deleted) — try again")
        _dl["phase"] = "unpacking"
        out = os.path.join(UPD, rel["tag"])
        shutil.rmtree(out, ignore_errors=True)
        with zipfile.ZipFile(zp) as z:
            for n in z.namelist():
                if n.startswith("/") or ".." in n.replace("\\", "/").split("/"):
                    raise IOError("unexpected file in the update: " + n)
            z.extractall(out)
        src = os.path.join(out, "CircuitPilot")
        if not os.path.isfile(os.path.join(src, "CircuitPilot.exe")):
            raise IOError("the update has no CircuitPilot.exe")
        os.remove(zp)
        for d in os.listdir(UPD):   # older unpacked updates
            if d != rel["tag"]:
                p = os.path.join(UPD, d)
                shutil.rmtree(p, ignore_errors=True) if os.path.isdir(p) else None
        _dl.update(phase="ready", active=False, ready=src)
    except Exception as e:
        _dl.update(phase="error", error=str(e), active=False)


def cancel():
    _dl["cancel"] = True
    return status()


def install(port=5173):
    """close CircuitPilot, copy the new version over the app folder, start it again"""
    src = _dl["ready"]
    if not (src and os.path.isfile(os.path.join(src, "CircuitPilot.exe"))):
        raise RuntimeError("download the update first")
    exe = os.path.join(APP_DIR, "CircuitPilot.exe")
    bat = os.path.join(UPD, "install-update.bat")
    log = os.path.join(UPD, "install-update.log")
    # ping, not timeout: timeout fails without a console. The app starts again with the arguments it has now (e.g. --port)
    with open(bat, "w", encoding="utf-8", newline="") as f:
        f.write("@echo off\r\n"
                f":wait\r\ntasklist /FI \"PID eq {os.getpid()}\" | find \"{os.getpid()}\" >nul && (ping -n 2 127.0.0.1 >nul & goto wait)\r\n"
                f"robocopy \"{src}\" \"{APP_DIR}\" /E /R:5 /W:1 /NP > \"{log}\"\r\n"
                f"if %ERRORLEVEL% LSS 8 rmdir /S /Q \"{os.path.dirname(src)}\"\r\n"
                f"start \"\" \"{exe}\" {subprocess.list2cmdline(sys.argv[1:])}\r\n")
    # outside CircuitPilot's process tree and job, so it lives on after CircuitPilot closes
    flags = NOWIN | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    try:
        subprocess.Popen(["cmd", "/c", bat], creationflags=flags | 0x01000000, close_fds=True, cwd=UPD)   # CREATE_BREAKAWAY_FROM_JOB
    except OSError:
        subprocess.Popen(["cmd", "/c", bat], creationflags=flags, close_fds=True, cwd=UPD)

    def quit_app():
        time.sleep(1.5)   # let the answer reach the page
        try:
            import localai
            localai.stop()
        except Exception:
            pass
        # the app's own window (Edge with CircuitPilot's profile): the new version opens a fresh one
        prof = os.path.join(DATA, "window").replace("'", "''")
        subprocess.run(["powershell", "-NoProfile", "-Command",
                        f"Get-CimInstance Win32_Process -Filter \"Name='msedge.exe'\" | Where-Object {{ $_.CommandLine -like '*{prof}*' }} | "
                        "ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"],
                       capture_output=True, timeout=30, creationflags=NOWIN)
        os._exit(0)
    threading.Thread(target=quit_app, daemon=True).start()
    return {"installing": True}


def api(op, body=None):
    if op == "check":
        return status(force=bool((body or {}).get("force")))
    if op == "download":
        return download()
    if op == "cancel":
        return cancel()
    if op == "install":
        return install()
    raise ValueError("unknown update operation " + op)
