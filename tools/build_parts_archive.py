"""Build data/parts-archive.tsv.gz: CircuitPilot's compact copy of the JLCPCB parts catalogue (every part in stock), for
the web version's Parts Archive (and as a backup if the live search stops). Run daily by .github/workflows/pages.yml;
the file is published with the website, not stored in the repository.

One part per line, tab separated:  lcsc  mfr  package  manufacturer  class(b basic / p preferred / -)  stock  price  category  description

Source: the daily SQLite snapshot of github.com/CDFER/jlcpcb-parts-database (built from github.com/yaqwsx/jlcparts).
If it cannot be downloaded, the copy that is live on the website is kept, so the archive never disappears.

    python tools/build_parts_archive.py OUT_DIR [--keep-from https://pcbgo.site/data/]
"""
import gzip
import json
import os
import re
import sqlite3
import sys
import tempfile
import time
import urllib.request

SRC = "https://cdfer.github.io/jlcpcb-parts-database/jlcpcb-components.sqlite3"
UA = {"User-Agent": "CircuitPilot archive build"}


def download(url, path):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(path, "wb") as f:
        while True:
            b = r.read(1 << 20)
            if not b:
                break
            f.write(b)


def build(db, out_dir):
    c = sqlite3.connect(db)
    rows, n = [], 0
    for lcsc, mfr, pkg, man, lt, pref, desc, stock, price, cat, sub in c.execute(
            "SELECT lcsc, mfr, package, manufacturer, library_type, preferred, description, stock, price, category, subcategory "
            "FROM jlc_components WHERE stock > 0 ORDER BY (library_type = 'base') DESC, preferred DESC, stock DESC"):
        m = re.match(r"\s*\d+-\d*:([\d.]+)", price or "")
        clean = lambda s: re.sub(r"[\t\r\n]+", " ", s or "").strip()
        rows.append("\t".join((str(lcsc), clean(mfr), clean(pkg), clean(man), "b" if lt == "base" else "p" if pref else "-", str(stock),
                               m.group(1) if m else "", clean(sub or cat), clean(desc)[:90])))
        n += 1
    os.makedirs(out_dir, exist_ok=True)
    with gzip.open(os.path.join(out_dir, "parts-archive.tsv.gz"), "wb", compresslevel=9) as f:
        f.write(("\n".join(rows) + "\n").encode("utf-8"))
    meta = {"parts": n, "built": time.strftime("%Y-%m-%d %H:%M UTC", time.gmtime()), "source": SRC}
    with open(os.path.join(out_dir, "parts-archive.json"), "w", encoding="utf-8") as f:
        json.dump(meta, f)
    return meta


def main():
    out_dir = sys.argv[1] if len(sys.argv) > 1 else "data"
    keep = sys.argv[sys.argv.index("--keep-from") + 1] if "--keep-from" in sys.argv else None
    tmp = os.path.join(tempfile.gettempdir(), "jlcpcb-components.sqlite3")
    try:
        download(SRC, tmp)
        print("built", build(tmp, out_dir))
    except Exception as e:
        print("could not build a new archive:", e)
        if not keep:
            raise
        # keep the archive that is already published
        os.makedirs(out_dir, exist_ok=True)
        for name in ("parts-archive.tsv.gz", "parts-archive.json"):
            download(keep.rstrip("/") + "/" + name, os.path.join(out_dir, name))
        print("kept the published archive")
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


if __name__ == "__main__":
    main()
