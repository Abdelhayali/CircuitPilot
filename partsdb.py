"""Component database: JLCPCB/LCSC catalogue + EasyEDA (LCSC) library search, part symbols/footprints, cached in SQLite.

Search asks two databases at once: the JLCPCB parts catalogue (stock, price, Basic/Extended) and the EasyEDA
official library (about 1.6 million LCSC parts with symbol + footprint, including modules JLCPCB does not stock).
Parts without a footprint are left out of the results (checked in one batch request, remembered in parts.db).

Search results and every part model that is fetched are stored in parts.db, so the local
database grows as you use it and keeps working offline for parts seen before.

Data sources: JLCPCB parts catalogue (https://jlcpcb.com/parts) and the
JLCEDA/EasyEDA official library (https://easyeda.com, https://lceda.cn).
"""
import json
import os
import re
import sqlite3
import threading
import time
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "parts.db")
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) CircuitPilot"
U = 0.254  # library unit (10 mil) in mm
SOURCE = "JLCPCB/LCSC catalogue · symbols & footprints: JLCEDA/EasyEDA official library (easyeda.com, lceda.cn)"
_lock = threading.Lock()


def _db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS parts(
        lcsc TEXT PRIMARY KEY, mfr_part TEXT, brand TEXT, package TEXT, category TEXT,
        description TEXT, stock INTEGER, basic INTEGER, price REAL, datasheet TEXT, updated REAL)""")
    con.execute("CREATE TABLE IF NOT EXISTS models(lcsc TEXT PRIMARY KEY, json TEXT, updated REAL)")
    # footprint per part number ('' = the EasyEDA library has none for it)
    con.execute("CREATE TABLE IF NOT EXISTS footprints(lcsc TEXT PRIMARY KEY, footprint TEXT, updated REAL)")
    return con


def _http(url, body=None, form=None):
    headers = {"User-Agent": UA, "Accept": "application/json"}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    elif form is not None:
        data = urllib.parse.urlencode(form).encode()
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers, method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


# ---------------------------------------------------------------- search
def _row(x):
    prices = x.get("componentPrices") or []
    return {
        "lcsc": x.get("componentCode"), "mfr_part": x.get("componentModelEn"), "brand": x.get("componentBrandEn"),
        "package": x.get("componentSpecificationEn"), "category": x.get("componentTypeEn"),
        "description": (x.get("describe") or "")[:300], "stock": x.get("stockCount") or 0,
        "basic": 1 if x.get("componentLibraryType") == "base" else 0,
        "price": prices[0].get("productPrice") if prices else None, "datasheet": x.get("dataManualUrl"),
    }


JLC_SEARCH = "https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList"
EE_SEARCH = "https://pro.easyeda.com/api/devices/search"
EE_CODES = "https://pro.easyeda.com/api/devices/searchByCodes"
NO_FP_TTL = 7 * 86400  # re-check parts without a footprint after a week (the library keeps growing)
COLS = "lcsc,mfr_part,brand,package,category,description,stock,basic,price,datasheet"


def _brand(s):
    return re.sub(r"\([^)]*[\u4e00-\u9fff][^)]*\)", "", s or "").strip()  # "Bosch(博世)" -> "Bosch"


def _ee_row(x):
    a = x.get("attributes") or {}
    code = (a.get("Supplier Part") or x.get("product_code") or "").strip().upper()
    fp = (x.get("footprint") or {}).get("display_title") or a.get("Supplier Footprint") or "footprint"
    return {
        "lcsc": code, "mfr_part": a.get("Manufacturer Part") or x.get("display_title"), "brand": _brand(a.get("Manufacturer")),
        "package": a.get("Supplier Footprint") or fp, "category": "", "description": (a.get("LCSC Part Name") or x.get("description") or "")[:300],
        "stock": None, "basic": 1 if a.get("JLCPCB Part Class") == "Basic Part" else 0, "price": None, "datasheet": a.get("Datasheet"),
        "footprint": fp if a.get("Footprint") else "",
    }


def _search_jlc(q, limit):
    j = _http(JLC_SEARCH, {"keyword": q, "currentPage": 1, "pageSize": limit})
    rows = [_row(x) for x in (j.get("data") or {}).get("componentPageInfo", {}).get("list", []) or []]
    return [r for r in rows if r["lcsc"]]


def _search_ee(q, limit):
    j = _http(EE_SEARCH, form={"wd": q, "page": 1, "pageSize": limit})
    lst = ((j.get("result") or {}).get("lists") or {}).get("lcsc") or []
    return [r for r in map(_ee_row, lst) if re.fullmatch(r"C\d{1,12}", r["lcsc"])]


def footprints(codes):
    """{code: footprint name, '' when the library has none, None when it could not be checked (offline)}"""
    codes = [c for c in dict.fromkeys(codes) if c]
    out, now = {}, time.time()
    with _lock, _db() as con:
        for c in codes:
            r = con.execute("SELECT footprint, updated FROM footprints WHERE lcsc=?", (c,)).fetchone()
            if r and (r[0] or now - r[1] < NO_FP_TTL):
                out[c] = r[0]
    todo = [c for c in codes if c not in out]
    for i in range(0, len(todo), 50):
        part = todo[i:i + 50]
        try:
            j = _http(EE_CODES, form=[("codes[]", c) for c in part])
        except Exception:
            for c in part:
                out[c] = None
            continue
        found = {}
        for x in j.get("result") or []:
            r = _ee_row(x)
            if r["footprint"]:
                found[r["lcsc"]] = r["footprint"]
        with _lock, _db() as con:
            for c in part:
                out[c] = found.get(c, "")
                con.execute("INSERT OR REPLACE INTO footprints VALUES(?,?,?)", (c, out[c], now))
    return out


def search(q, limit=20):
    """JLCPCB catalogue + EasyEDA library, merged by LCSC number; parts without a footprint are left out.
    JLCPCB parts (stock, price, assembly) come first, then parts found only in the EasyEDA library."""
    q = (q or "").strip()
    if not q:
        return {"source": "none", "results": []}
    limit = max(1, min(int(limit or 20), 50))
    jlc, ee, errors = [], [], []
    with ThreadPoolExecutor(2) as ex:
        fj, fe = ex.submit(_search_jlc, q, limit), ex.submit(_search_ee, q, limit)
        try:
            jlc = fj.result()
        except Exception as e:
            errors.append(f"JLCPCB: {e}")
        try:
            ee = fe.result()
        except Exception as e:
            errors.append(f"EasyEDA: {e}")
    if not jlc and not ee and errors:  # offline / blocked -> local cache
        return {"source": "local", "error": "; ".join(errors), "results": search_local(q, limit)}
    in_ee = {r["lcsc"]: r["footprint"] for r in ee}
    fp = dict(in_ee)
    fp.update(footprints([r["lcsc"] for r in jlc if r["lcsc"] not in in_ee]))
    keep, dropped = [], 0
    for r in jlc:
        f = fp.get(r["lcsc"])
        if f == "":
            dropped += 1
            continue
        keep.append(dict(r, footprint=f, sources=["jlcpcb", "easyeda"] if r["lcsc"] in in_ee else ["jlcpcb"]))
    seen = {r["lcsc"] for r in jlc}
    norm = lambda t: re.sub(r"[^0-9a-z.]+", "", (t or "").lower())
    words = [norm(w) for w in q.split() if norm(w)]
    extra = []
    for r in ee:
        if r["lcsc"] in seen:
            continue
        text = norm(" ".join(str(r.get(k) or "") for k in ("lcsc", "mfr_part", "brand", "package", "description", "footprint")))
        if not all(w in text for w in words):  # the library search is loose; library-only extras must contain every word
            continue
        if not r["footprint"]:
            dropped += 1
            continue
        extra.append(dict(r, sources=["easyeda"], note="EasyEDA library part, not in the JLCPCB results: "
                          + ("placeholder code, not sold by LCSC" if r["lcsc"].startswith("C99") else "check LCSC / JLCPCB stock")))
    n_extra = min(len(extra), max(limit - len(keep), limit // 3))  # library-only parts get at least a third of the list
    rows = keep[:limit - n_extra] + extra[:n_extra]
    now = time.time()
    with _lock, _db() as con:
        con.executemany("INSERT OR REPLACE INTO footprints VALUES(?,?,?)", [(r["lcsc"], r["footprint"], now) for r in ee])
        sql = f"INTO parts({COLS},updated) VALUES(:{',:'.join(COLS.split(','))},{now})"
        con.executemany("INSERT OR REPLACE " + sql, [r for r in jlc if fp.get(r["lcsc"]) != ""])
        con.executemany("INSERT OR IGNORE " + sql, [dict(r, stock=0) for r in extra])
    out = {"source": "+".join(n for n, l in (("jlcpcb", jlc), ("easyeda", ee)) if l), "results": rows, "removed_without_footprint": dropped}
    if errors:
        out["error"] = "; ".join(errors)
    return out


def search_local(q, limit=50):
    like = "%" + "%".join((q or "").split()) + "%"
    with _lock, _db() as con:
        con.row_factory = sqlite3.Row
        cur = con.execute("""SELECT * FROM parts WHERE (lcsc LIKE ? OR mfr_part LIKE ? OR description LIKE ?
                             OR package LIKE ? OR category LIKE ?)
                             AND lcsc NOT IN (SELECT lcsc FROM footprints WHERE footprint='') ORDER BY stock DESC LIMIT ?""",
                          (like, like, like, like, like, limit))
        return [dict(r) for r in cur.fetchall()]


def stats():
    with _lock, _db() as con:
        return {"parts": con.execute("SELECT COUNT(*) FROM parts").fetchone()[0],
                "models": con.execute("SELECT COUNT(*) FROM models").fetchone()[0], "path": DB_PATH}


# ---------------------------------------------------------------- part model (pins + footprint)
def _num(s):
    try:
        return float(s)
    except (TypeError, ValueError):
        return 0.0


def _parse_pins(shapes, cx, cy):
    pins = []
    for s in shapes:
        if not s.startswith("P~"):
            continue
        seg = s.split("^^")
        f0 = seg[0].split("~")
        num = name = None
        x, y = _num(f0[4]) if len(f0) > 4 else 0, _num(f0[5]) if len(f0) > 5 else 0
        if len(seg) > 4:
            num = seg[4].split("~")[4] if len(seg[4].split("~")) > 4 else None
        if len(seg) > 3:
            name = seg[3].split("~")[4] if len(seg[3].split("~")) > 4 else None
        num = (num or (f0[3] if len(f0) > 3 else "")).strip()
        name = (name or num).strip()
        side = "L" if x < cx else "R"
        if len(seg) > 2:  # pin line "M x y h d" / "v d": direction from the tip into the body
            m = re.search(r"([hv])\s*(-?[\d.]+)", seg[2])
            if m:
                d = float(m.group(2))
                if m.group(1) == "h":
                    side = "R" if d < 0 else "L"
                else:
                    side = "T" if d > 0 else "B"
        if num:
            pins.append({"num": num, "name": name, "side": side, "x": x, "y": y})
    return pins


def _pad_shape(f):
    shape, x, y, w, h = f[1], _num(f[2]), _num(f[3]), _num(f[4]), _num(f[5])
    layer, number, hole_r, points, rot = f[6], f[8], _num(f[9]), f[10], _num(f[11]) if len(f) > 11 else 0
    if shape == "POLYGON" and points:
        p = [_num(v) for v in points.split()]
        xs, ys = p[0::2], p[1::2]
        if xs and ys:
            x, y, w, h = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, max(xs) - min(xs), max(ys) - min(ys)
            rot = 0
    if round(rot) % 180 == 90:
        w, h = h, w
    kind = "rect" if shape in ("RECT", "POLYGON") else ("round" if abs(w - h) < 1e-6 else "oval")
    return {"num": number.strip(), "x": x, "y": y, "w": w, "h": h, "shape": kind,
            "drill": hole_r * 2 * U if hole_r > 0 else None, "layer": layer}


def _parse_footprint(pkg):
    ds = pkg.get("dataStr") or {}
    pads, silk = [], []
    for s in ds.get("shape", []):
        f = s.split("~")
        if s.startswith("PAD~") and len(f) > 10:
            pads.append(_pad_shape(f))
        elif s.startswith("TRACK~") and len(f) > 4 and f[2] == "3":  # top silkscreen
            p = [_num(v) for v in f[4].split()]
            silk += list(zip(p[0::2], p[1::2]))
    if not pads:
        return None
    xs = [p["x"] - p["w"] / 2 for p in pads] + [p["x"] + p["w"] / 2 for p in pads]
    ys = [p["y"] - p["h"] / 2 for p in pads] + [p["y"] + p["h"] / 2 for p in pads]
    ox, oy = (min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2  # center on the pads
    out = []
    for p in pads:
        out.append({"num": p["num"], "x": round((p["x"] - ox) * U, 4), "y": round((p["y"] - oy) * U, 4),
                    "w": round(p["w"] * U, 4), "h": round(p["h"] * U, 4), "shape": p["shape"],
                    **({"drill": round(p["drill"], 3)} if p["drill"] else {})})
    bx = [(x - ox) * U for x, _ in silk] + [(v - ox) * U for v in xs]
    by = [(y - oy) * U for _, y in silk] + [(v - oy) * U for v in ys]
    body = [round(min(bx), 3), round(min(by), 3), round(max(bx), 3), round(max(by), 3)]
    return {"name": pkg.get("title") or "footprint", "pads": out, "body": body}


def get_part(lcsc):
    lcsc = (lcsc or "").strip().upper()
    if not re.fullmatch(r"C\d{1,10}", lcsc):
        raise ValueError(f'"{lcsc}" is not an LCSC part number (e.g. C2838502)')
    with _lock, _db() as con:
        row = con.execute("SELECT json FROM models WHERE lcsc=?", (lcsc,)).fetchone()
    if row:
        m = json.loads(row[0])
        if m.get("uuid") or m.get("no_uuid"):
            return m
        # cached before the EasyEDA library ids were kept: fetch once more (fall back to the cached copy offline)
        try:
            return _fetch_part(lcsc)
        except Exception:
            return m
    return _fetch_part(lcsc)


def _fetch_part(lcsc):
    j = _http(f"https://easyeda.com/api/products/{lcsc}/components")
    r = j.get("result") if j.get("success") else None
    if not r:
        raise LookupError(f"No symbol/footprint found for {lcsc}")
    ds = r.get("dataStr") or {}
    head = ds.get("head") or {}
    para = head.get("c_para") or {}
    shapes = list(ds.get("shape") or [])
    for sp in r.get("subparts") or []:  # multi-unit symbols
        shapes += (sp.get("dataStr") or {}).get("shape") or []
    pins = _parse_pins(shapes, _num(head.get("x")), _num(head.get("y")))
    seen, uniq = set(), []
    order = {"L": 0, "T": 1, "R": 2, "B": 3}
    for p in sorted(pins, key=lambda p: (order[p["side"]], p["x"] if p["side"] in "TB" else p["y"], p["y"])):
        if p["num"] not in seen:
            seen.add(p["num"])
            uniq.append({"num": p["num"], "name": p["name"], "side": p["side"]})
    fp = _parse_footprint(r.get("packageDetail") or {})
    model = {
        "lcsc": lcsc, "name": para.get("name") or r.get("title"), "mfr_part": para.get("Manufacturer Part"),
        "manufacturer": para.get("Manufacturer"), "package": para.get("package"), "prefix": (para.get("pre") or "U?").rstrip("?") or "U",
        "value": para.get("Value") or para.get("Manufacturer Part") or r.get("title"),
        "pins": uniq, "footprint": fp, "datasheet": ((r.get("packageDetail") or {}).get("dataStr") or {}).get("head", {}).get("c_para", {}).get("link"),
        "source": SOURCE,
        # EasyEDA library ids: symbol (uuid) and footprint (puuid) — exported schematics link parts with them
        "uuid": r.get("uuid"), "puuid": head.get("puuid") or (r.get("packageDetail") or {}).get("uuid"),
    }
    if not model["uuid"]:
        model["no_uuid"] = True
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO models VALUES(?,?,?)", (lcsc, json.dumps(model), time.time()))
    return model
