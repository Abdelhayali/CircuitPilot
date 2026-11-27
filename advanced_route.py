"""Run an explicitly installed KiCadRoutingTools CLI on a temporary local board."""

import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import threading


_RUNNING = threading.Lock()
_NET = re.compile(r"CP_(?:N[1-9][0-9]*|PAIR_[PN])")
_SCRIPTS = {"general": "route.py", "pair": "route_diff.py"}


def _installation(data_dir):
    root = Path(os.environ.get("CP_KRT_HOME") or Path(data_dir) / "KiCadRoutingTools").resolve()
    venv_python = root / ".venv" / "Scripts" / "python.exe"
    python = os.environ.get("CP_KRT_PYTHON") or (str(venv_python) if venv_python.is_file() else shutil.which("python.exe"))
    ready = bool(python) and all((root / "py_router" / script).is_file() for script in _SCRIPTS.values())
    return root, python, ready


def _number(value, name, lo=0, hi=1000):
    if type(value) not in (int, float) or not lo <= value <= hi or not math.isfinite(value):
        raise ValueError(f"Invalid {name} for Advanced Route.")
    return str(value)


def api(action, body, data_dir):
    root, python, ready = _installation(data_dir)
    if action == "status":
        return {"available": ready, "folder": str(root)}
    if action != "run" or not isinstance(body, dict):
        raise ValueError("Unknown Advanced Route command.")
    if not ready:
        raise ValueError("Set up KiCadRoutingTools on this PC before using Advanced Route.")
    mode = body.get("mode")
    if not isinstance(mode, str) or mode not in _SCRIPTS:
        raise ValueError("Choose a routing mode.")
    board = body.get("board")
    if not isinstance(board, str) or not board.startswith("(kicad_pcb ") or len(board) > 8_000_000:
        raise ValueError("Invalid board for Advanced Route.")
    r = body.get("rules") or {}
    if not isinstance(r, dict):
        raise ValueError("Invalid Advanced Route rules.")
    width = _number(r.get("width"), "track width", .01, 30)
    flags = [
        "--keep-input-copper", "--layers", "F.Cu", "B.Cu", "--track-width", width,
        "--clearance", _number(r.get("clearance"), "clearance"),
        "--board-edge-clearance", _number(r.get("edge"), "board edge clearance"),
        "--hole-to-hole-clearance", _number(r.get("holes"), "hole spacing"),
        "--via-size", _number(r.get("via"), "via diameter", .05, 30),
        "--via-drill", _number(r.get("drill"), "via drill", .01, r["via"]),
    ]
    if r.get("noViaInPad") is True:
        # KiCadRoutingTools requires a positive edge-to-edge gap to keep vias off their own pads.
        flags += ["--same-net-pad-clearance", "0.01"]
    if mode == "pair":
        flags += [
            "--nets", "CP_PAIR_P", "CP_PAIR_N",
            "--diff-pair-gap", _number(body.get("gap"), "pair gap", r["clearance"], 10),
            "--length-match-tolerance", _number(body.get("skew"), "pair length tolerance", .001, 20),
        ]
    else:
        if r.get("neckDown") is False:
            flags.append("--no-power-tap-neckdown")
        overrides = body.get("widths") or {}
        if not isinstance(overrides, dict) or len(overrides) > 200 or any(not _NET.fullmatch(k) for k in overrides):
            raise ValueError("Too many individual routing widths.")
        flags += ["--nets", "CP_*"]
        if overrides:
            flags += ["--power-nets", *overrides, "--power-nets-widths",
                      *(_number(v, "net width", .01, 30) for v in overrides.values())]

    if not _RUNNING.acquire(blocking=False):
        raise ValueError("Advanced Route is already running.")
    try:
        with tempfile.TemporaryDirectory(prefix="circuitpilot-route-") as work:
            folder = Path(work)
            source, output = folder / "source.kicad_pcb", folder / "routed.kicad_pcb"
            source.write_text(board, encoding="utf-8")
            script = root / "py_router" / _SCRIPTS[mode]
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
            try:
                with (folder / "routing.log").open("w+b") as log:
                    result = subprocess.run(
                        [python, str(script), str(source), str(output), *flags],
                        cwd=folder, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        timeout=180, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    if result.returncode or not output.is_file():
                        log.seek(max(0, log.tell() - 3500))
                        details = log.read().decode("utf-8", errors="replace").strip().replace(str(root), "KiCadRoutingTools")
                        raise ValueError("KiCadRoutingTools did not return a route. " + details[-1600:])
            except subprocess.TimeoutExpired as exc:
                raise ValueError("Advanced Route reached its 3-minute limit.") from exc
            if output.stat().st_size > 12_000_000:
                raise ValueError("The returned board is too large to preview.")
            return {"board": output.read_text(encoding="utf-8")}
    finally:
        _RUNNING.release()
