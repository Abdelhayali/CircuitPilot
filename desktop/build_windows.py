"""Build the Windows app: dist/CircuitPilot/CircuitPilot.exe (+ its files) and dist/CircuitPilot-Windows.zip.

    python desktop/build_windows.py

Needs: Python 3.10+ with PyInstaller and Pillow (pip install pyinstaller pillow), internet (downloads Node.js once).
The folder holds:
    CircuitPilot.exe     the app: server + its own window (Microsoft Edge app mode)
    node/node.exe        Node.js (official build, LTS) — runs the Claude Desktop connection (MCP server)
    _internal/           Python runtime, the web app (index.html, js/, data/), the MCP server (mcp/)
User data goes to %LOCALAPPDATA%\\CircuitPilot, so the folder can live anywhere (also read-only).
"""
import datetime
import hashlib
import io
import json
import os
import shutil
import subprocess
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BUILD, DIST = os.path.join(ROOT, "build"), os.path.join(ROOT, "dist")
APP = os.path.join(DIST, "CircuitPilot")


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": "CircuitPilot build"}), timeout=120) as r:
        return r.read()


def node_exe():
    """newest Node.js LTS that is at least two weeks old; checked against the published SHA-256"""
    cache = os.path.join(BUILD, "node")
    os.makedirs(cache, exist_ok=True)
    rel = json.loads(get("https://nodejs.org/dist/index.json"))
    cutoff = (datetime.date.today() - datetime.timedelta(days=14)).isoformat()
    r = next(x for x in rel if x.get("lts") and "win-x64-zip" in x.get("files", []) and x["date"] <= cutoff)
    ver = r["version"]
    exe = os.path.join(cache, ver, "node.exe")
    if os.path.exists(exe):
        return exe, ver
    name = f"node-{ver}-win-x64.zip"
    print("downloading", name)
    data = get(f"https://nodejs.org/dist/{ver}/{name}")
    sums = get(f"https://nodejs.org/dist/{ver}/SHASUMS256.txt").decode()
    want = next(l.split()[0] for l in sums.splitlines() if l.endswith(" " + name))
    if hashlib.sha256(data).hexdigest() != want:
        raise SystemExit("Node.js download does not match its published checksum")
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member = next(n for n in z.namelist() if n.endswith("/node.exe"))
        os.makedirs(os.path.dirname(exe), exist_ok=True)
        with z.open(member) as src, open(exe, "wb") as dst:
            shutil.copyfileobj(src, dst)
        lic = next((n for n in z.namelist() if n.endswith("/LICENSE")), None)
        if lic:
            with z.open(lic) as src, open(os.path.join(os.path.dirname(exe), "LICENSE"), "wb") as dst:
                shutil.copyfileobj(src, dst)
    return exe, ver


def icon():
    """CircuitPilot icon (the waveform logo) as .ico"""
    from PIL import Image, ImageDraw
    path = os.path.join(BUILD, "circuitpilot.ico")
    S = 256
    im = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle([8, 8, S - 8, S - 8], radius=56, fill=(91, 140, 255, 255))
    pts = [(3, 12), (7, 12), (9, 7), (13, 17), (15, 12), (21, 12)]   # the logo path on a 24×24 grid
    k = (S - 64) / 18
    d.line([(32 + (x - 3) * k, S / 2 + (y - 12) * k) for x, y in pts], fill=(255, 255, 255, 255), width=22, joint="curve")
    im.save(path, sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
    return path


def main():
    os.makedirs(BUILD, exist_ok=True)
    node, ver = node_exe()
    ico = icon()
    sep = os.pathsep
    data = [("index.html", "."), ("styles.css", "."), ("js", "js"), ("data", "data"), ("mcp", "mcp"), ("LICENSE", "."), ("NOTICE", ".")]
    args = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--windowed", "--name", "CircuitPilot", "--icon", ico,
            "--distpath", DIST, "--workpath", os.path.join(BUILD, "pyinstaller"), "--specpath", BUILD, "--paths", ROOT,
            "--hidden-import", "server", "--hidden-import", "desktop_link", "--hidden-import", "jlcapi"]
    # packages on the build PC that CircuitPilot does not use (pypdf / python-docx / lxml / cryptography stay: datasheets)
    for mod in ("numpy", "PIL", "pygame", "matplotlib", "scipy", "pandas", "tkinter", "IPython", "jupyter"):
        args += ["--exclude-module", mod]
    for src, dst in data:
        p = os.path.join(ROOT, src)
        if os.path.exists(p):
            args += ["--add-data", f"{p}{sep}{dst}"]
    args.append(os.path.join(ROOT, "desktop", "circuitpilot_app.py"))
    print(" ".join(args))
    subprocess.check_call(args)
    os.makedirs(os.path.join(APP, "node"), exist_ok=True)
    shutil.copy2(node, os.path.join(APP, "node", "node.exe"))
    lic = os.path.join(os.path.dirname(node), "LICENSE")
    if os.path.exists(lic):
        shutil.copy2(lic, os.path.join(APP, "node", "LICENSE"))
    with open(os.path.join(APP, "README.txt"), "w", encoding="utf-8") as f:
        f.write("CircuitPilot for Windows\n\nDouble-click CircuitPilot.exe. Your projects are kept in %LOCALAPPDATA%\\CircuitPilot.\n"
                "Claude Desktop: in CircuitPilot open Settings -> Claude Desktop -> Connect (or run CircuitPilot.exe --connect-claude),\n"
                "then quit Claude Desktop completely and open it again.\n\n"
                f"Includes Node.js {ver} (MIT licence, node/LICENSE) to run the Claude Desktop connection.\n")
    zp = os.path.join(DIST, "CircuitPilot-Windows.zip")
    if os.path.exists(zp):
        os.remove(zp)
    shutil.make_archive(zp[:-4], "zip", DIST, "CircuitPilot")
    size = sum(os.path.getsize(os.path.join(dp, f)) for dp, _, fs in os.walk(APP) for f in fs)
    print(f"\nbuilt {APP} ({size / 1e6:.0f} MB) and {zp} ({os.path.getsize(zp) / 1e6:.0f} MB), Node.js {ver}")


if __name__ == "__main__":
    main()
