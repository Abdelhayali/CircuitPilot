"""Local AI for the Windows app: run a GGUF model on this PC — no internet needed once the model is here.

Models: a short catalog (pcbgo-v1 and a few larger open models), any GGUF from Hugging Face (search the site from the
app), or a GGUF file already on this PC (Browse). Engines: llama.cpp's server (the official Vulkan build that ships with
the app, or any llama-server.exe you choose, e.g. a CUDA build), or an external engine started by your own command
(e.g. Maya's start-maya.bat for Inkling-2-Mini) that serves an OpenAI-compatible API on the port it is given.
The web app connects to it like any OpenAI-compatible provider (http://127.0.0.1:<port>/v1).

    api(op, body)   one entry point for the server routes (status, download, start, settings, browse, hf_search …)
"""
import atexit
import hashlib
import json
import os
import re
import shlex
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request

LLAMA_BUILD = "b12670"   # llama.cpp version shipped with the Windows app (desktop/build_windows.py)
DATA = os.environ.get("CP_DATA_DIR") or os.path.join(os.environ.get("LOCALAPPDATA") or os.path.expanduser("~"), "CircuitPilot")
STATE = os.path.join(DATA, "localai.json")
FROZEN = bool(getattr(sys, "frozen", False))
APP_DIR = os.path.dirname(sys.executable) if FROZEN else os.path.dirname(os.path.abspath(__file__))
NOWIN = getattr(subprocess, "CREATE_NO_WINDOW", 0)
SUSPEND = 0x4 if os.name == "nt" else 0   # CREATE_SUSPENDED: resumed once it is in the job (_in_job)
# NVIDIA CUDA build of the same llama.cpp (CUDA 12.4: still runs Volta / V100, and sees compute-only TCC cards that Vulkan
# cannot), downloaded on demand from the llama.cpp release and checked against its published SHA-256
CUDA_DIR = os.path.join(DATA, "llama-cuda", LLAMA_BUILD)
CUDA_ZIPS = [(f"llama-{LLAMA_BUILD}-bin-win-cuda-12.4-x64.zip", 358130713, "a7061f8f59053cc1bb2a62a93fde609ad58401b61ff6fbad57469da9a6d41229"),
             ("cudart-llama-bin-win-cuda-12.4-x64.zip", 391443627, "8c79a9b226de4b3cacfd1f83d24f962d0773be79f1e7b75c6af4ded7e32ae1d6")]

# catalog: Hugging Face repo + file; size and SHA-256 come from Hugging Face's own file list when downloading
CATALOG = [
    {"id": "pcbgo-v1", "name": "pcbgo v1 — CircuitPilot's own design model (4B)", "repo": "abdelhayali91/pcbgo-v1", "file": "pcbgo-v1-Q4_K_M.gguf",
     "size": 2783446464, "sha256": "1791b2944c84f5c3919cc4df07b2871219f0ed33bb2344dd2313c3bca17ab590", "alias": "pcbgo-v1",
     "note": "2.8 GB · trained on CircuitPilot's tools (compact tools, thinking off) · runs on most PCs, also the processor"},
    {"id": "qwen3.6-35b-a3b", "name": "Qwen3.6-35B-A3B (MoE, 3B active)", "repo": "unsloth/Qwen3.6-35B-A3B-MTP-GGUF", "file": "Qwen3.6-35B-A3B-UD-Q4_K_M.gguf",
     "alias": "qwen3.6-35b-a3b", "note": "22.7 GB · fast for its size (only 3B active): a 24 GB GPU, or GPU + RAM"},
    {"id": "qwen3.8-27b", "name": "Qwen3.8-27B", "repo": "unsloth/Qwen3.8-27B-GGUF", "file": "Qwen3.8-27B-UD-Q4_K_M.gguf",
     "alias": "qwen3.8-27b", "note": "16.6 GB · dense · PCB Bench 78.6 · a 20–24 GB GPU or two GPUs"},
    {"id": "gemma4-31b-ara-heretic", "name": "Gemma-4-31B ARA heretic", "repo": "mradermacher/gemma-4-31B-it-ARA-heretic-i1-GGUF",
     "file": "gemma-4-31B-it-ARA-heretic.i1-Q4_K_M.gguf", "alias": "gemma4-31b-ara-heretic", "note": "18.7 GB · dense · a 24 GB GPU or two GPUs"},
    {"id": "inkling-2-mini-maya", "name": "Inkling-2-Mini (Maya engine)", "repo": "unsloth/Inkling-2-Mini-GGUF", "file": "Inkling-2-Mini-UD-Q4_K_XL.gguf",
     "alias": "inkling-2-mini", "engine": "external",
     "note": "17.6 GB · runs on Maya's own engine (maya-ik2, built for your GPU): set its start command under Engine → External"},
]
DEFAULTS = {
    "models_dir": "",            # "" = %LOCALAPPDATA%\CircuitPilot\models
    "engine": "builtin",         # builtin | custom (llama-server.exe below) — per model "external" uses the command
    "server_exe": "",
    "device": "auto",            # auto | gpu | cpu
    "gpus": [],                  # e.g. ["Vulkan0", "Vulkan1"] (empty = all)
    "split": "",                 # tensor split for several GPUs, e.g. "60,40"
    "split_mode": "layer",       # layer | row | none
    "ngl": 99,                   # layers on the GPU
    "ctx": 65536,
    "kv": "f16",                 # f16 | bf16 | q8_0 | q5_1 | q5_0 | q4_1 | q4_0 | iq4_nl (quantised V needs flash attention)
    "flash": "auto",             # auto | on | off
    "threads": 0,                # 0 = llama.cpp decides
    "batch": 0, "ubatch": 0,     # 0 = defaults (2048 / 512)
    "thinking": False,           # reasoning models: think before answering (slower)
    "mlock": False, "no_mmap": False,
    "extra": "",                 # any other llama-server options, e.g. --temp 0.7 --top-k 20
    "external_cmd": "",          # external engine, e.g. D:\DualGPU\start-maya.bat 64k-new {port}
    "external_cwd": "",
    "start_timeout": 600,
}

_lock = threading.Lock()
_dl = {"active": False, "id": None, "bytes": 0, "total": 0, "phase": "", "error": None, "cancel": False, "speed": 0}
_srv = {"proc": None, "port": None, "error": None, "log": None, "id": None, "alias": None, "engine": None, "started": 0}
_dev_cache = {"t": 0, "list": None}
_job = {"h": None}


def _in_job(p):
    """put the model server in a Windows job that is killed when CircuitPilot ends (closed, crashed or killed), so no
    llama-server / external engine stays behind holding the GPU. The process starts suspended, so its own children
    (cmd → an external engine's server) are in the job too."""
    if os.name != "nt":
        return p
    try:
        import ctypes
        from ctypes import wintypes
        k32 = ctypes.WinDLL("kernel32", use_last_error=True)
        if not _job["h"]:
            k32.CreateJobObjectW.restype = wintypes.HANDLE
            h = k32.CreateJobObjectW(None, None)

            class BASIC(ctypes.Structure):
                _fields_ = [("a", ctypes.c_int64), ("b", ctypes.c_int64), ("LimitFlags", wintypes.DWORD), ("c", ctypes.c_size_t),
                            ("d", ctypes.c_size_t), ("e", wintypes.DWORD), ("f", ctypes.c_size_t), ("g", wintypes.DWORD), ("h", wintypes.DWORD)]

            class IO(ctypes.Structure):
                _fields_ = [(n, ctypes.c_uint64) for n in ("r", "w", "o", "rb", "wb", "ob")]

            class EXT(ctypes.Structure):
                _fields_ = [("Basic", BASIC), ("Io", IO), ("a", ctypes.c_size_t), ("b", ctypes.c_size_t), ("c", ctypes.c_size_t), ("d", ctypes.c_size_t)]
            info = EXT()
            info.Basic.LimitFlags = 0x2000   # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if not k32.SetInformationJobObject(h, 9, ctypes.byref(info), ctypes.sizeof(info)):   # JobObjectExtendedLimitInformation
                raise OSError(ctypes.get_last_error())
            _job["h"] = h
        k32.AssignProcessToJobObject(wintypes.HANDLE(_job["h"]), wintypes.HANDLE(int(p._handle)))
    except Exception:
        pass
    finally:
        try:
            import ctypes
            ctypes.WinDLL("ntdll").NtResumeProcess(ctypes.c_void_p(int(p._handle)))
        except Exception:
            pass
    return p


# ---------- state ----------
def _load():
    try:
        with open(STATE, encoding="utf-8") as f:
            st = json.load(f)
    except Exception:
        st = {}
    st.setdefault("models", [])
    st["settings"] = dict(DEFAULTS, **(st.get("settings") or {}))
    st.setdefault("active", "pcbgo-v1")
    return st


def _save(st):
    os.makedirs(DATA, exist_ok=True)
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=1)
    os.replace(tmp, STATE)


def models_dir(st=None):
    d = (st or _load())["settings"].get("models_dir") or os.path.join(DATA, "models")
    os.makedirs(d, exist_ok=True)
    return d


def _models(st):
    """catalog + models the user added; each with where its file is"""
    out = []
    for m in CATALOG + [m for m in st["models"] if m["id"] not in {c["id"] for c in CATALOG}]:
        m = dict(m)
        m.setdefault("engine", "llama")
        if m.get("path"):
            m["files"] = [m["path"]]
        else:
            m["files"] = [os.path.join(models_dir(st), os.path.basename(f)) for f in (m.get("parts") or [m["file"]])]
        out.append(m)
    return out


def _find(st, mid):
    m = next((m for m in _models(st) if m["id"] == mid), None)
    if not m:
        raise ValueError(f"no model {mid}")
    return m


def _present(m):
    if m.get("path"):
        return os.path.isfile(m["path"])
    if not all(os.path.isfile(f) for f in m["files"]):
        return False
    return not m.get("size") or sum(os.path.getsize(f) for f in m["files"]) == m["size"]


# ---------- runtime ----------
def runtime(st=None):
    st = st or _load()
    s = st["settings"]
    if s.get("engine") == "custom" and s.get("server_exe"):
        return s["server_exe"] if os.path.isfile(s["server_exe"]) else None
    if s.get("engine") == "cuda":
        exe = os.path.join(CUDA_DIR, "llama-server.exe")
        return exe if os.path.isfile(exe) else None
    for p in (os.environ.get("CP_LLAMA_SERVER"), os.path.join(APP_DIR, "llama", "llama-server.exe"),
              os.path.join(APP_DIR, "build", "llama", LLAMA_BUILD, "llama-server.exe")):
        if p and os.path.isfile(p):
            return p
    return None


def devices(refresh=False):
    """GPUs llama.cpp sees (llama-server --list-devices): [{id: Vulkan0, name, mib, free_mib}]"""
    if _dev_cache["list"] is not None and not refresh and time.time() - _dev_cache["t"] < 600:
        return _dev_cache["list"]
    out = []
    exe = runtime()
    if exe:
        try:
            r = subprocess.run([exe, "--list-devices"], capture_output=True, text=True, timeout=60, creationflags=NOWIN, cwd=os.path.dirname(exe))
            for l in (r.stdout + r.stderr).splitlines():
                m = re.match(r"\s*([A-Za-z]+\d+):\s*(.+?)\s*\((\d+) MiB,\s*(\d+) MiB free\)", l)
                if m:
                    out.append({"id": m.group(1), "name": m.group(2), "mib": int(m.group(3)), "free_mib": int(m.group(4))})
        except Exception:
            pass
    # NVIDIA cards this engine does not list (Vulkan cannot use compute-only TCC cards such as a Tesla V100)
    seen = [d["name"].lower() for d in out]
    cuda = bool(exe) and os.path.dirname(exe) == CUDA_DIR
    for g in _nvidia():
        n = g["name"].lower()
        hit = next((x for x in seen if n in x or x in n), None)
        if hit:
            seen.remove(hit)
            continue
        why = "compute-only (TCC) mode: the Vulkan engine cannot use it" if g["tcc"] else "not seen by this engine"
        out.append({"id": "", "name": g["name"], "mib": g["mib"], "free_mib": g["free_mib"], "missing": True,
                    "why": why + ("" if cuda else " — get the NVIDIA CUDA engine")})
    _dev_cache.update(t=time.time(), list=out)
    return out


def _nvidia():
    """NVIDIA cards from nvidia-smi: [{name, tcc, mib, free_mib}] ([] without an NVIDIA driver)"""
    try:
        r = subprocess.run(["nvidia-smi", "--query-gpu=name,driver_model.current,memory.total,memory.free", "--format=csv,noheader,nounits"],
                           capture_output=True, text=True, timeout=20, creationflags=NOWIN)
        out = []
        for l in r.stdout.splitlines():
            f = [x.strip() for x in l.split(",")]
            if len(f) == 4 and f[0]:
                out.append({"name": f[0], "tcc": f[1].upper() == "TCC", "mib": int(f[2]) if f[2].isdigit() else 0, "free_mib": int(f[3]) if f[3].isdigit() else 0})
        return out
    except Exception:
        return []


def cuda_present():
    return os.path.isfile(os.path.join(CUDA_DIR, "llama-server.exe")) and os.path.isfile(os.path.join(CUDA_DIR, "ggml-cuda.dll"))


def get_cuda():
    with _lock:
        if _dl["active"]:
            raise ValueError("another download is running — wait for it or pause it")
        if cuda_present():
            return status()
        _dl.update(active=True, id="cuda-engine", bytes=0, total=sum(z[1] for z in CUDA_ZIPS), phase="downloading", error=None, cancel=False, speed=0)
    threading.Thread(target=_get_cuda, daemon=True).start()
    return status()


def _get_cuda():
    import zipfile
    try:
        tmp = CUDA_DIR + ".download"
        os.makedirs(tmp, exist_ok=True)
        done, t0, b0 = 0, time.time(), None
        for name, size, sha in CUDA_ZIPS:
            dest = os.path.join(tmp, name)
            have = os.path.getsize(dest) if os.path.isfile(dest) else 0
            if have > size:
                os.remove(dest); have = 0
            if b0 is None:
                b0 = done + have
            if have < size:
                url = f"https://github.com/ggml-org/llama.cpp/releases/download/{LLAMA_BUILD}/{name}"
                req = urllib.request.Request(url, headers={"User-Agent": "CircuitPilot", **({"Range": f"bytes={have}-"} if have else {})})
                with urllib.request.urlopen(req, timeout=60) as r:
                    if have and r.status != 206:
                        have = 0
                    with open(dest, "ab" if have else "wb") as f:
                        while True:
                            if _dl["cancel"]:
                                _dl.update(phase="paused", active=False)
                                return
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
                            dt = time.time() - t0
                            _dl.update(bytes=done + have, speed=int((done + have - b0) / dt) if dt > 1 else 0)
            _dl.update(phase="checking")
            h = hashlib.sha256()
            with open(dest, "rb") as f:
                for chunk in iter(lambda: f.read(8 << 20), b""):
                    h.update(chunk)
            if h.hexdigest() != sha:
                os.remove(dest)
                raise IOError(f"{name} does not match its published SHA-256 (deleted) — click again to download it again")
            done += size
            _dl.update(phase="downloading", bytes=done)
        _dl.update(phase="unpacking")
        os.makedirs(CUDA_DIR, exist_ok=True)
        for name, _, _ in CUDA_ZIPS:
            with zipfile.ZipFile(os.path.join(tmp, name)) as z:
                for n in z.namelist():   # the server and its DLLs, not the other tools
                    b = os.path.basename(n)
                    if b and (b.lower().endswith(".dll") or b in ("llama-server.exe", "LICENSE")):
                        with z.open(n) as src, open(os.path.join(CUDA_DIR, b), "wb") as dst:
                            shutil.copyfileobj(src, dst, 8 << 20)
        for name, _, _ in CUDA_ZIPS:
            os.remove(os.path.join(tmp, name))
        os.rmdir(tmp)
        st = _load()
        st["settings"].update(engine="cuda", gpus=[])
        _save(st)
        _dev_cache.update(list=None)
        _dl.update(phase="done", active=False, bytes=_dl["total"])
    except Exception as e:
        _dl.update(phase="error", error=str(e), active=False)


def _healthy(port):
    for path in ("/health", "/v1/models"):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:
            pass
    return False


def _log_tail(n=400):
    try:
        with open(_srv["log"], encoding="utf-8", errors="replace") as f:
            lines = [l.strip() for l in f.read()[-6000:].splitlines() if l.strip()]
        bad = [l for l in lines if any(k in l.lower() for k in ("error", "failed", "out of memory", "unknown argument", "invalid"))]
        return (bad or lines or [""])[-1][-n:]
    except Exception:
        return ""


def status():
    st = _load()
    p = _srv["proc"]
    running = bool(p and p.poll() is None)
    if p and not running and not _srv["error"]:
        _srv["error"] = "the model server stopped: " + _log_tail()
    models = []
    for m in _models(st):
        part = sum(os.path.getsize(f + ".part") for f in m["files"] if os.path.isfile(f + ".part"))
        models.append({k: m.get(k) for k in ("id", "name", "repo", "file", "path", "size", "alias", "engine", "note", "source")} |
                      {"present": _present(m), "partial": part, "where": m["files"][0]})
    return {
        "models": models, "active": st["active"], "settings": st["settings"], "models_dir": models_dir(st),
        "runtime": bool(runtime(st)), "runtime_path": runtime(st), "llama_build": LLAMA_BUILD, "devices": _dev_cache["list"], "cuda": cuda_present(),
        "download": {k: _dl[k] for k in ("active", "id", "bytes", "total", "phase", "error", "speed")},
        "server": {"running": running, "ready": running and _healthy(_srv["port"]), "port": _srv["port"], "id": _srv["id"], "alias": _srv["alias"],
                   "engine": _srv["engine"], "url": f"http://127.0.0.1:{_srv['port']}/v1" if running else None,
                   "error": None if running else _srv["error"], "seconds": int(time.time() - _srv["started"]) if running else 0},
    }


# ---------- Hugging Face ----------
def _get_json(url, timeout=30):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "CircuitPilot"}), timeout=timeout) as r:
        return json.loads(r.read())


def hf_search(q):
    q = str(q or "").strip()
    url = "https://huggingface.co/api/models?" + urllib.parse.urlencode({"search": q, "filter": "gguf", "sort": "downloads", "direction": "-1", "limit": "30"})
    return [{"repo": m["id"], "downloads": m.get("downloads", 0), "likes": m.get("likes", 0), "updated": m.get("lastModified", "")[:10]} for m in _get_json(url)]


def _tree(repo):
    if not re.match(r"^[\w.-]+/[\w.-]+$", repo or ""):
        raise ValueError("a Hugging Face repo is owner/name")
    return _get_json(f"https://huggingface.co/api/models/{repo}/tree/main?recursive=1")


def hf_files(repo):
    """GGUF files of a repo; split models (-00001-of-00003) as one entry; vision projectors (mmproj) marked"""
    files, groups = [], {}
    for f in _tree(repo):
        p = f.get("path", "")
        if f.get("type") != "file" or not p.lower().endswith(".gguf"):
            continue
        m = re.match(r"(.+)-(\d{5})-of-(\d{5})\.gguf$", p)
        if m:
            g = groups.setdefault(m.group(1), {"file": None, "parts": [], "size": 0})
            g["parts"].append(p); g["size"] += f.get("size", 0)
            if m.group(2) == "00001":
                g["file"] = p
            continue
        files.append({"file": p, "size": f.get("size", 0), "mmproj": "mmproj" in p.lower()})
    for g in groups.values():
        if g["file"]:
            files.append({"file": g["file"], "size": g["size"], "parts": sorted(g["parts"]), "mmproj": False})
    return sorted(files, key=lambda x: (x["mmproj"], x["size"]))


def add_hf(repo, file):
    st = _load()
    entry = next((f for f in hf_files(repo) if f["file"] == file), None)
    if not entry:
        raise ValueError(f"{file} is not a GGUF file in {repo}")
    base = re.sub(r"(-\d{5}-of-\d{5})?\.gguf$", "", os.path.basename(file))
    mid = re.sub(r"[^a-z0-9.]+", "-", base.lower()).strip("-")[:60]
    st["models"] = [m for m in st["models"] if m["id"] != mid] + [{"id": mid, "name": f"{base} ({repo.split('/')[0]})", "repo": repo, "file": file,
                                                                   "parts": entry.get("parts"), "size": entry["size"], "alias": mid, "source": "hf",
                                                                   "note": f"{entry['size'] / 1e9:.1f} GB · huggingface.co/{repo}"}]
    st["active"] = mid
    _save(st)
    return status()


def add_local(path):
    path = os.path.abspath(str(path or "").strip().strip('"'))
    if not (path.lower().endswith(".gguf") and os.path.isfile(path)):
        raise ValueError("choose a .gguf model file that exists on this PC")
    st = _load()
    base = re.sub(r"(-\d{5}-of-\d{5})?\.gguf$", "", os.path.basename(path))
    mid = "local-" + re.sub(r"[^a-z0-9.]+", "-", base.lower()).strip("-")[:54]
    st["models"] = [m for m in st["models"] if m["id"] != mid] + [{"id": mid, "name": base + " (this PC)", "path": path, "alias": re.sub(r"[^a-z0-9.]+", "-", base.lower())[:60],
                                                                   "source": "local", "note": f"{os.path.getsize(path) / 1e9:.1f} GB · {path}"}]
    st["active"] = mid
    _save(st)
    return status()


def remove(mid):
    st = _load()
    if mid in {c["id"] for c in CATALOG}:
        raise ValueError("catalog models stay in the list (use Delete to remove the file)")
    st["models"] = [m for m in st["models"] if m["id"] != mid]
    if st["active"] == mid:
        st["active"] = "pcbgo-v1"
    _save(st)
    return status()


# ---------- download ----------
def download(mid):
    st = _load()
    m = _find(st, mid)
    if m.get("path"):
        raise ValueError("this model is a file on this PC already")
    with _lock:
        if _dl["active"]:
            raise ValueError("another download is running — wait for it or pause it")
        if _present(m):
            return status()
        _dl.update(active=True, id=mid, bytes=0, total=m.get("size") or 0, phase="connecting", error=None, cancel=False, speed=0)
    threading.Thread(target=_download, args=(m,), daemon=True).start()
    return status()


def cancel():
    _dl["cancel"] = True
    return status()


def _download(m):
    try:
        # sizes and SHA-256 from Hugging Face's file list (pcbgo-v1's are also pinned above)
        info = {f["path"]: f for f in _tree(m["repo"])}
        names = m.get("parts") or [m["file"]]
        want = [(n, info[n]["size"], (info[n].get("lfs") or {}).get("oid") or (m.get("sha256") if len(names) == 1 else None)) for n in names]
        if m.get("sha256") and len(names) == 1 and want[0][2] != m["sha256"]:
            raise IOError("the file on Hugging Face is not the one this app expects (checksum changed)")
        total = sum(s for _, s, _ in want)
        _dl.update(total=total, phase="downloading")
        done = 0
        t0, b0 = time.time(), None
        for (name, size, sha), dest in zip(want, m["files"]):
            part = dest + ".part"
            if os.path.isfile(dest) and os.path.getsize(dest) == size:
                done += size
                continue
            have = os.path.getsize(part) if os.path.isfile(part) else 0
            if have > size:
                os.remove(part); have = 0
            if b0 is None:
                b0 = done + have
            if have < size:
                url = f"https://huggingface.co/{m['repo']}/resolve/main/{urllib.parse.quote(name)}"
                req = urllib.request.Request(url, headers={"User-Agent": "CircuitPilot", **({"Range": f"bytes={have}-"} if have else {})})
                with urllib.request.urlopen(req, timeout=60) as r:
                    if have and r.status != 206:
                        have = 0
                    with open(part, "ab" if have else "wb") as f:
                        while True:
                            if _dl["cancel"]:
                                _dl.update(phase="paused", active=False)
                                return
                            chunk = r.read(1 << 20)
                            if not chunk:
                                break
                            f.write(chunk)
                            have += len(chunk)
                            dt = time.time() - t0
                            _dl.update(bytes=done + have, speed=int((done + have - b0) / dt) if dt > 1 else 0)
            if have != size:
                raise IOError(f"download incomplete ({have} of {size} bytes) — click Download again to resume")
            if sha:
                _dl.update(phase="checking")
                h = hashlib.sha256()
                with open(part, "rb") as f:
                    for chunk in iter(lambda: f.read(8 << 20), b""):
                        h.update(chunk)
                if h.hexdigest() != sha:
                    os.remove(part)
                    raise IOError(f"{name} does not match its SHA-256 on Hugging Face (deleted) — download again")
                _dl.update(phase="downloading")
            os.replace(part, dest)
            done += size
        _dl.update(phase="done", active=False, bytes=total)
    except Exception as e:
        _dl.update(phase="error", error=str(e), active=False)


def delete(mid):
    st = _load()
    m = _find(st, mid)
    if m.get("path"):
        raise ValueError("this file is yours on this PC — CircuitPilot does not delete it (use Remove to take it off the list)")
    if _srv["id"] == mid:
        stop()
    for f in m["files"]:
        for p in (f, f + ".part"):
            if os.path.isfile(p):
                os.remove(p)
    return status()


# ---------- settings ----------
NUM = {"ngl": (0, 999), "ctx": (512, 1048576), "threads": (0, 512), "batch": (0, 65536), "ubatch": (0, 65536), "start_timeout": (30, 3600)}
CHOICE = {"device": ("auto", "gpu", "cpu"), "split_mode": ("layer", "row", "none"), "engine": ("builtin", "cuda", "custom"),
          "kv": ("f16", "bf16", "f32", "q8_0", "q5_1", "q5_0", "q4_1", "q4_0", "iq4_nl"), "flash": ("auto", "on", "off")}


def settings(body):
    st = _load()
    s = st["settings"]
    engine0 = s.get("engine")
    for k, v in (body or {}).items():
        if k in NUM:
            lo, hi = NUM[k]
            s[k] = max(lo, min(hi, int(float(v or 0))))
        elif k in CHOICE:
            if v not in CHOICE[k]:
                raise ValueError(f"{k}: one of {', '.join(CHOICE[k])}")
            if k == "engine" and v == "cuda" and not cuda_present():
                raise ValueError("get the NVIDIA CUDA engine first (Graphics cards → Get the CUDA engine)")
            if k == "engine" and v != s.get("engine"):
                _dev_cache.update(list=None)
            s[k] = v
        elif k in ("thinking", "mlock", "no_mmap"):
            s[k] = bool(v)
        elif k == "gpus":
            s[k] = [str(g) for g in (v or []) if re.match(r"^[A-Za-z]+\d+$", str(g))]
        elif k == "split":
            v = str(v or "").replace(" ", "")
            if v and not re.match(r"^\d+(\.\d+)?(,\d+(\.\d+)?)+$", v):
                raise ValueError("GPU split: numbers per GPU, e.g. 60,40")
            s[k] = v
        elif k in ("models_dir", "server_exe", "external_cwd"):
            v = str(v or "").strip().strip('"')
            if v and k != "server_exe" and not os.path.isdir(v):
                raise ValueError(f"{v} is not a folder")
            if v and k == "server_exe" and not (os.path.isfile(v) and v.lower().endswith(".exe")):
                raise ValueError("choose llama-server.exe")
            s[k] = v
        elif k in ("extra", "external_cmd"):
            s[k] = str(v or "")[:2000]
        elif k == "active":
            _find(st, v); st["active"] = v
    if s.get("engine") != engine0:
        s["gpus"] = []   # Vulkan0 / CUDA0 names differ between engines
    _save(st)
    return status()


# ---------- model server ----------
def _free_port(start=8091):
    for port in range(start, start + 60):
        with socket.socket() as s:
            try:
                s.bind(("127.0.0.1", port))
                return port
            except OSError:
                continue
    raise RuntimeError("no free port for the model server")


def _llama_args(exe, m, s, port):
    origins = ",".join([f"http://{h}:{os.environ.get('CP_PORT', '5173')}" for h in ("localhost", "127.0.0.1")] + ["https://pcbgo.site", "https://www.pcbgo.site"])
    a = [exe, "-m", m["files"][0], "--alias", m["alias"], "--host", "127.0.0.1", "--port", str(port), "-c", str(s["ctx"]), "-np", "1",
         "--jinja", "--no-webui", "--cors-origins", origins]   # only CircuitPilot's own pages (and its website) may call it
    if s["device"] == "cpu":
        a += ["--device", "none", "-ngl", "0"]
    else:
        a += ["-ngl", str(s["ngl"])]
        if s["gpus"]:
            a += ["--device", ",".join(s["gpus"])]
        if s["split"]:
            a += ["--tensor-split", s["split"]]
        if s["split_mode"] != "layer":
            a += ["-sm", s["split_mode"]]
    if s["kv"] != "f16":
        a += ["-ctk", s["kv"], "-ctv", s["kv"]]
    a += ["-fa", s["flash"]]
    for k, f in (("threads", "-t"), ("batch", "-b"), ("ubatch", "-ub")):
        if s[k]:
            a += [f, str(s[k])]
    if s["mlock"]:
        a.append("--mlock")
    if s["no_mmap"]:
        a.append("--no-mmap")
    if not s["thinking"]:
        a += ["--chat-template-kwargs", json.dumps({"enable_thinking": False})]
    if m["id"] == "pcbgo-v1":   # how pcbgo-v1 was trained and benchmarked
        a += ["--presence-penalty", "1.5", "--repeat-penalty", "1.1"]
    if s["extra"].strip():
        a += shlex.split(s["extra"], posix=False)
    return a


def start(mid=None):
    with _lock:
        p = _srv["proc"]
        if p and p.poll() is None:
            stop()
        st = _load()
        mid = mid or st["active"]
        m = _find(st, mid)
        s = st["settings"]
        if not _present(m):
            raise RuntimeError(f"download {m['name']} first")
        port = _free_port()
        os.makedirs(DATA, exist_ok=True)
        _srv.update(port=port, error=None, log=os.path.join(DATA, "local-model-server.log"), id=mid, alias=m["alias"], engine=m["engine"], started=time.time())
        logf = open(_srv["log"], "w", encoding="utf-8")
        if m["engine"] == "external":
            cmd = s["external_cmd"].strip()
            if not cmd:
                raise RuntimeError(f"{m['name']} runs on its own engine: set its start command under Engine → External command (with {{port}})")
            cmd = cmd.replace("{port}", str(port)).replace("{model}", m["files"][0]).replace("{ctx}", str(s["ctx"]))
            logf.write("> " + cmd + "\n"); logf.flush()
            _srv["proc"] = _in_job(subprocess.Popen(["cmd", "/c", cmd], stdout=logf, stderr=subprocess.STDOUT, cwd=s["external_cwd"] or None, creationflags=NOWIN | SUSPEND))
        else:
            exe = runtime(st)
            if not exe:
                raise RuntimeError("no llama-server: use the Windows app from pcbgo.site, or choose a llama-server.exe under Engine")
            args = _llama_args(exe, m, s, port)
            logf.write("> " + subprocess.list2cmdline(args) + "\n"); logf.flush()
            _srv["proc"] = _in_job(subprocess.Popen(args, stdout=logf, stderr=subprocess.STDOUT, cwd=os.path.dirname(exe), creationflags=NOWIN | SUSPEND))
        st["active"] = mid
        _save(st)
    return status()


def stop():
    p = _srv["proc"]
    if p and p.poll() is None:
        # the whole process tree (an external engine's command starts its own server process)
        subprocess.run(["taskkill", "/T", "/F", "/PID", str(p.pid)], capture_output=True, creationflags=NOWIN)
        try:
            p.wait(10)
        except Exception:
            p.kill()
    _srv.update(proc=None, port=None)
    return status()


def log(n=60):
    try:
        with open(_srv["log"] or "", encoding="utf-8", errors="replace") as f:
            return {"log": "\n".join(f.read().splitlines()[-n:])}
    except Exception:
        return {"log": ""}


# ---------- native dialogs on this PC (the Windows app) ----------
def browse(kind):
    """kind: gguf | exe | folder → the chosen path ("" if cancelled)"""
    if os.name != "nt":
        raise RuntimeError("Browse works in the Windows app; type the path instead")
    if kind == "folder":
        ps = "$f=New-Object System.Windows.Forms.FolderBrowserDialog; $f.Description='Folder for CircuitPilot models'; if($f.ShowDialog($o) -eq 'OK'){$f.SelectedPath}"
    else:
        flt = "GGUF model (*.gguf)|*.gguf" if kind == "gguf" else "llama-server.exe|llama-server.exe|Programs (*.exe)|*.exe"
        ps = f"$f=New-Object System.Windows.Forms.OpenFileDialog; $f.Filter='{flt}'; if($f.ShowDialog($o) -eq 'OK'){{$f.FileName}}"
    script = "Add-Type -AssemblyName System.Windows.Forms; $o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true}; " + ps
    r = subprocess.run(["powershell", "-NoProfile", "-STA", "-Command", script], capture_output=True, text=True, timeout=600, creationflags=NOWIN)
    return {"path": r.stdout.strip()}


# ---------- one entry point ----------
def api(op, body=None):
    body = body or {}
    if op == "status":
        return status()
    if op == "devices":
        return {"devices": devices(refresh=True)}
    if op == "download":
        return download(body.get("id") or _load()["active"])
    if op == "cancel":
        return cancel()
    if op == "get_cuda":
        return get_cuda()
    if op == "start":
        return start(body.get("id"))
    if op == "stop":
        return stop()
    if op == "delete":
        return delete(body.get("id") or _load()["active"])
    if op == "remove":
        return remove(body.get("id"))
    if op == "settings":
        return settings(body)
    if op == "add_local":
        return add_local(body.get("path"))
    if op == "add_hf":
        return add_hf(body.get("repo"), body.get("file"))
    if op == "hf_search":
        return {"results": hf_search(body.get("q"))}
    if op == "hf_files":
        return {"files": hf_files(body.get("repo"))}
    if op == "browse":
        return browse(body.get("kind") or "gguf")
    if op == "log":
        return log()
    raise ValueError("unknown operation " + op)


atexit.register(stop)
