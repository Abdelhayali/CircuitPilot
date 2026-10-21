"""Build data/kicad-footprints.txt: the names of every footprint in the official KiCad library
(gitlab.com/kicad/libraries/kicad-footprints), one "Library.pretty/Name" per line.

The part editor's "KiCad library" picker searches this list and downloads the chosen .kicad_mod file
from GitLab. Run again to pick up new footprints:  python tools/kicad_footprint_index.py
"""
import json
import os
import urllib.parse
import urllib.request

API = "https://gitlab.com/api/v4/projects/kicad%2Flibraries%2Fkicad-footprints/repository/tree"
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "data", "kicad-footprints.txt")


def main():
    names, url = [], API + "?" + urllib.parse.urlencode({"recursive": "true", "per_page": 100, "pagination": "keyset", "ref": "master"})
    while url:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "CircuitPilot"}), timeout=60) as r:
            names += [x["path"] for x in json.loads(r.read()) if x["type"] == "blob" and x["path"].endswith(".kicad_mod")]
            link = r.headers.get("Link") or ""
        url = next((p.split(";")[0].strip()[1:-1] for p in link.split(",") if 'rel="next"' in p), None)
        print(f"\r{len(names)} footprints", end="", flush=True)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(n[:-len(".kicad_mod")] for n in sorted(names)) + "\n")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()
