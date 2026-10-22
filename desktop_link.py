"""Connect CircuitPilot to the Claude Desktop app: adds the CircuitPilot MCP server to claude_desktop_config.json
(a backup of the old file is kept next to it). Used by Settings → Claude Desktop and by the Windows app.

In the Windows app (CircuitPilot.exe) the MCP server runs on the Node.js bundled next to the exe and starts the exe
itself when Claude needs it; in the Python setup it uses the node on PATH and starts server.py with this Python.
"""
import json
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
FROZEN = bool(getattr(sys, "frozen", False))


def config_path():
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or os.path.join(os.path.expanduser("~"), "AppData", "Roaming")
    elif sys.platform == "darwin":
        base = os.path.join(os.path.expanduser("~"), "Library", "Application Support")
    else:
        base = os.path.join(os.path.expanduser("~"), ".config")
    return os.path.join(base, "Claude", "claude_desktop_config.json")


def node_path():
    p = os.environ.get("CP_NODE")
    if p and os.path.exists(p):
        return p
    return shutil.which("node")


def mcp_script():
    return os.path.join(ROOT, "mcp", "circuitpilot-mcp.mjs")


def _entry(port):
    env = {"CP_URL": f"http://localhost:{port}"}
    if FROZEN:
        env["CP_APP_EXE"] = sys.executable          # the MCP server starts CircuitPilot.exe --server-only when needed
    else:
        env["CP_PYTHON"] = sys.executable           # … or server.py with this Python
    return {"command": node_path(), "args": [mcp_script()], "env": env}


def _read(path):
    if not os.path.exists(path):
        return {}
    with open(path, encoding="utf-8") as f:
        txt = f.read().strip()
    return json.loads(txt) if txt else {}


def status(port=None):
    path = config_path()
    try:
        cur = (_read(path).get("mcpServers") or {}).get("circuitpilot")
    except ValueError:
        cur = None
    node = node_path()
    return {
        "config": path, "claude_installed": os.path.isdir(os.path.dirname(path)), "node": node,
        "connected": bool(cur), "points_here": bool(cur) and os.path.normcase(str((cur.get("args") or [""])[0])) == os.path.normcase(mcp_script()),
        "app": "CircuitPilot.exe" if FROZEN else "server.py",
    }


def connect(port=None):
    port = port or int(os.environ.get("CP_PORT") or 5173)
    if not node_path():
        raise RuntimeError("Node.js was not found. Install it from https://nodejs.org (LTS), or use the Windows app, which includes it.")
    path = config_path()
    try:
        data = _read(path)
    except ValueError:
        raise RuntimeError(f"{path} is not valid JSON — fix or remove it, then try again")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    if os.path.exists(path):
        shutil.copyfile(path, path + ".backup-before-circuitpilot")
    data.setdefault("mcpServers", {})["circuitpilot"] = _entry(port)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    return {"connected": True, "config": path, "entry": data["mcpServers"]["circuitpilot"],
            "next": "Quit Claude Desktop completely (also from the system tray) and open it again, then ask it to design a board."}
