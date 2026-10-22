"""Parts archives: local copies of the JLCPCB parts catalogue, so part search keeps working when the live JLCPCB
search is unavailable (or offline).

    Basic Parts Archive  basic + preferred parts, ~1.3 MB CSV   (also used by the web version, in the browser)
    Parts Archive        every part in stock, ~360 MB SQLite    (desktop only)

Both are daily snapshots published by github.com/CDFER/jlcpcb-parts-database (built from github.com/yaqwsx/jlcparts).
They are downloaded on request into archive/ (not part of the repository). After downloading the full archive a
full-text index is built here (the published file has an empty one), so a search takes milliseconds.
"""
import csv
import io
import json
import os
import re
import sqlite3
import threading
import time
import urllib.request

ROOT = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(os.environ.get("CP_DATA_DIR") or ROOT, "archive")
BASE = "https://cdfer.github.io/jlcpcb-parts-database/"
FILES = {
    "basic": {"name": "Basic Parts Archive", "url": BASE + "jlcpcb-components-basic-preferred.csv", "file": "basic-preferred.csv", "about": "~1.3 MB"},
    "full": {"name": "Parts Archive", "url": BASE + "jlcpcb-components.sqlite3", "file": "jlcpcb-components.sqlite3", "about": "~360 MB"},
}
_lock = threading.Lock()
_jobs = {}            # kind -> {"done", "total", "state", "error"}
_basic_rows = None    # parsed CSV, cached


def _path(kind):
    return os.path.join(DIR, FILES[kind]["file"])


def status():
    out = {}
    for k, f in FILES.items():
        p = _path(k)
        info = {"name": f["name"], "size_about": f["about"], "present": os.path.exists(p)}
        if info["present"]:
            info.update(size=os.path.getsize(p), updated=time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(p))))
            if k == "full":
                info["indexed"] = _indexed()
        job = _jobs.get(k)
        if job and job["state"] != "done":
            info["job"] = dict(job)
        out[k] = info
    return out


def download(kind):
    """start downloading (and for the full archive: indexing) in the background; see status() for progress"""
    if kind not in FILES:
        raise ValueError("unknown archive " + kind)
    with _lock:
        j = _jobs.get(kind)
        if j and j["state"] in ("downloading", "indexing"):
            return {"started": False, "job": dict(j)}
        _jobs[kind] = {"state": "downloading", "done": 0, "total": 0, "error": None}
    threading.Thread(target=_run, args=(kind,), daemon=True).start()
    return {"started": True}


def _run(kind):
    job = _jobs[kind]
    os.makedirs(DIR, exist_ok=True)
    tmp = _path(kind) + ".part"
    try:
        req = urllib.request.Request(FILES[kind]["url"], headers={"User-Agent": "CircuitPilot"})
        with urllib.request.urlopen(req, timeout=60) as r, open(tmp, "wb") as f:
            job["total"] = int(r.headers.get("Content-Length") or 0)
            while True:
                b = r.read(1 << 20)
                if not b:
                    break
                f.write(b)
                job["done"] += len(b)
        if kind == "full":
            job["state"] = "indexing"
            _build_index(tmp)
        global _basic_rows
        with _lock:
            os.replace(tmp, _path(kind))
            _basic_rows = None
        job["state"] = "done"
    except Exception as e:
        job.update(state="error", error=str(e))
        try:
            os.remove(tmp)
        except OSError:
            pass


def _build_index(path):
    con = sqlite3.connect(path)
    try:
        # the published full-text table is empty: fill it from the parts table (rowid = LCSC number)
        con.execute("INSERT INTO jlc_components_fts(jlc_components_fts) VALUES('rebuild')")
        con.execute("CREATE TABLE IF NOT EXISTS cp_meta(key TEXT PRIMARY KEY, value TEXT)")
        con.execute("INSERT OR REPLACE INTO cp_meta VALUES('indexed', ?)", (time.strftime("%Y-%m-%d %H:%M"),))
        con.commit()
    finally:
        con.close()


def _indexed():
    try:
        con = sqlite3.connect(_path("full"))
        try:
            return bool(con.execute("SELECT value FROM cp_meta WHERE key='indexed'").fetchone())
        finally:
            con.close()
    except sqlite3.Error:
        return False


# ---------------------------------------------------------------- search
def _price(s):
    m = re.match(r"\s*\d+-\d*:([\d.]+)", s or "")
    return float(m.group(1)) if m else None


def _row(lcsc, mfr, package, manufacturer, library_type, preferred, description, datasheet, stock, price, category, source):
    return {
        "lcsc": "C%s" % lcsc, "mfr_part": mfr, "brand": manufacturer, "package": package, "category": category or "",
        "description": (description or "")[:300], "stock": int(stock or 0), "basic": 1 if library_type == "base" else 0,
        "preferred": 1 if str(preferred) == "1" else 0, "price": _price(price), "datasheet": datasheet,
        "sources": [source],
    }


def _basic():
    global _basic_rows
    if _basic_rows is None:
        p = _path("basic")
        if not os.path.exists(p):
            return []
        with open(p, encoding="utf-8", newline="") as f:
            _basic_rows = [r for r in csv.DictReader(f)]
            for r in _basic_rows:
                r["_text"] = " ".join((r.get("lcsc", ""), "c" + r.get("lcsc", ""), r.get("mfr", ""), r.get("package", ""), r.get("manufacturer", ""),
                                       r.get("description", ""), r.get("category", ""), r.get("subcategory", ""))).lower()
    return _basic_rows


def available():
    return os.path.exists(_path("full")) or os.path.exists(_path("basic"))


def search(q, limit=20):
    """search the full archive when present (indexed: full-text, otherwise a slower scan), else the basic archive"""
    words = [w for w in re.split(r"[\s,]+", (q or "").lower()) if w]
    if not words:
        return []
    full = _path("full")
    if os.path.exists(full):
        con = sqlite3.connect("file:%s?mode=ro" % full.replace("\\", "/"), uri=True)
        try:
            cols = "j.lcsc, j.mfr, j.package, j.manufacturer, j.library_type, j.preferred, j.description, j.datasheet, j.stock, j.price, j.category || ' / ' || j.subcategory"
            codes = [int(w[1:]) for w in words if re.fullmatch(r"c\d{1,10}", w)]
            if codes and len(codes) == len(words):   # LCSC numbers: direct lookup
                rows = con.execute(f"SELECT {cols} FROM jlc_components j WHERE j.lcsc IN ({','.join('?' * len(codes))})", codes).fetchall()
            elif _indexed():
                # each word as a prefix; "esp32-c3" style words are split the way the index splits them
                terms = [t for w in words for t in re.split(r"[^0-9a-z]+", w) if t]
                match = " ".join('"%s"*' % t for t in terms)
                rows = con.execute(f"SELECT {cols} FROM jlc_components_fts f JOIN jlc_components j ON j.lcsc = f.rowid WHERE jlc_components_fts MATCH ? "
                                   "ORDER BY (j.library_type = 'base') DESC, j.preferred DESC, j.stock DESC LIMIT ?", (match, limit)).fetchall()
            else:
                cond = " AND ".join("(j.mfr LIKE ? OR j.description LIKE ? OR j.package LIKE ? OR ('C' || j.lcsc) LIKE ?)" for _ in words)
                args = [a for w in words for a in ("%" + w + "%",) * 4]
                rows = con.execute(f"SELECT {cols} FROM jlc_components j WHERE {cond} ORDER BY j.stock DESC LIMIT ?", args + [limit]).fetchall()
        finally:
            con.close()
        return [_row(*r, source="archive") for r in rows]
    hits = [r for r in _basic() if all(w in r["_text"] for w in words)]
    hits.sort(key=lambda r: (r.get("library_type") != "base", -int(r.get("stock") or 0)))
    return [_row(r["lcsc"], r["mfr"], r["package"], r["manufacturer"], r["library_type"], r.get("preferred"), r["description"], r["datasheet"],
                 r["stock"], r["price"], " / ".join(x for x in (r.get("category"), r.get("subcategory")) if x), "archive-basic") for r in hits[:limit]]
