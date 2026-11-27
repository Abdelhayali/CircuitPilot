"""Run the local KiCadRoutingTools CLI on a temporary board."""

import json
import math
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading


_RUNNING = threading.Lock()
_NET = re.compile(r"CP_(?:N[1-9][0-9]*|PAIR_[PN])")
_SCRIPTS = {"general": "route.py", "pair": "route_diff.py"}


def _installation(data_dir):
    bundle = Path(sys.executable).resolve().parent / "router"
    if getattr(sys, "frozen", False):
        tools, python = bundle / "tools", bundle / "python" / "python.exe"
        ready = python.is_file() and all((tools / "py_router" / f).is_file()
                                         for f in (*_SCRIPTS.values(), "grid_router.pyd"))
        return tools, str(python), ready
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
        raise ValueError("The Advanced Route engine is missing. Open CircuitPilot from the complete Windows download.")
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
    edge = _number(r.get("edge"), "board edge clearance")
    holes = _number(r.get("holes"), "hole spacing")
    clearance = _number(r.get("clearance"), "clearance")
    via = _number(r.get("via"), "via diameter", .05, 30)
    drill = _number(r.get("drill"), "via drill", .01, r["via"])
    min_width = _number(r.get("minWidth", r["width"]), "minimum track width", .01, r["width"])
    hole_clearance = _number(r.get("holeClearance", 0), "copper-to-hole clearance")
    annular = _number(r.get("annular", 0), "annular ring")
    timeout = float(_number(r.get("seconds", 180), "routing time", 5, 1800))
    rules = {
        "min_clearance": float(clearance), "min_track_width": float(min_width),
        "min_copper_edge_clearance": float(edge), "min_hole_to_hole": float(holes),
        "min_hole_clearance": float(hole_clearance), "min_via_diameter": float(via),
        "min_via_drill": float(drill), "min_via_annular_width": float(annular),
    }
    flags = [
        "--keep-input-copper", "--no-fix-drc-settings", "--layers", "F.Cu", "B.Cu",
        "--track-width", width, "--clearance", clearance, "--board-edge-clearance", edge,
        "--hole-to-hole-clearance", holes, "--via-size", via, "--via-drill", drill,
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
            source.with_suffix(".kicad_pro").write_text(
                json.dumps({"board": {"design_settings": {"rules": rules}}}), encoding="utf-8")
            script = root / "py_router" / _SCRIPTS[mode]
            env = {**os.environ, "PYTHONUTF8": "1", "PYTHONUNBUFFERED": "1"}
            try:
                with (folder / "routing.log").open("w+b") as log:
                    result = subprocess.run(
                        [python, str(script), str(source), str(output), *flags],
                        cwd=folder, env=env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                        timeout=timeout, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
                    )
                    if result.returncode or not output.is_file():
                        log.seek(max(0, log.tell() - 3500))
                        details = log.read().decode("utf-8", errors="replace").strip().replace(str(root), "KiCadRoutingTools")
                        raise ValueError("KiCadRoutingTools did not return a route. " + details[-1600:])
            except subprocess.TimeoutExpired as exc:
                raise ValueError(f"Advanced Route reached the board's {timeout:g}-second routing limit.") from exc
            if output.stat().st_size > 12_000_000:
                raise ValueError("The returned board is too large to import.")
            return {"board": output.read_text(encoding="utf-8")}
    finally:
        _RUNNING.release()
