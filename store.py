"""Persistent storage for projects and the user's own part library (SQLite: projects.db)."""
import json
import os
import re
import sqlite3
import threading
import time
import uuid

DB_PATH = os.path.join(os.environ.get("CP_DATA_DIR") or os.path.dirname(os.path.abspath(__file__)), "projects.db")
_lock = threading.Lock()
KEY_RE = re.compile(r"^[A-Za-z0-9_.-]{1,80}$")


def _db():
    con = sqlite3.connect(DB_PATH)
    con.execute("""CREATE TABLE IF NOT EXISTS projects(
        id TEXT PRIMARY KEY, name TEXT, json TEXT, created REAL, updated REAL)""")
    con.execute("CREATE TABLE IF NOT EXISTS userparts(key TEXT PRIMARY KEY, name TEXT, json TEXT, updated REAL)")
    # earlier states of every project (kept on save and on delete), so an overwrite can be undone
    con.execute("CREATE TABLE IF NOT EXISTS versions(vid INTEGER PRIMARY KEY AUTOINCREMENT, pid TEXT, name TEXT, parts INTEGER, json TEXT, saved REAL, reason TEXT)")
    con.execute("CREATE INDEX IF NOT EXISTS versions_pid ON versions(pid, saved)")
    return con


KEEP_VERSIONS = 60        # per project
VERSION_EVERY = 600       # s: autosave keeps at most one version per 10 minutes …


def _parts_of(js):
    try:
        return len(json.loads(js).get("components", []))
    except ValueError:
        return 0


def _keep_version(con, pid, name, js, reason, force=False):
    """Store the project's previous state. Autosaves are thinned out unless parts disappear (a big drop is always kept)."""
    if not force:
        last = con.execute("SELECT saved, json FROM versions WHERE pid=? ORDER BY saved DESC LIMIT 1", (pid,)).fetchone()
        if last and last[1] == js:
            return
        if last and time.time() - last[0] < VERSION_EVERY and reason == "save":
            return
    con.execute("INSERT INTO versions(pid, name, parts, json, saved, reason) VALUES(?,?,?,?,?,?)", (pid, name, _parts_of(js), js, time.time(), reason))
    con.execute("DELETE FROM versions WHERE pid=? AND vid NOT IN (SELECT vid FROM versions WHERE pid=? ORDER BY saved DESC LIMIT ?)", (pid, pid, KEEP_VERSIONS))


def _check(key):
    if not KEY_RE.match(key or ""):
        raise ValueError("invalid id")
    return key


# ---------------------------------------------------------------- projects
def list_projects():
    with _lock, _db() as con:
        rows = con.execute("SELECT id, name, json, created, updated FROM projects ORDER BY updated DESC").fetchall()
    out = []
    for pid, name, js, created, updated in rows:
        try:
            d = json.loads(js)
            parts, nets, board = len(d.get("components", [])), len(d.get("nets", {})), bool((d.get("board") or {}).get("w"))
        except ValueError:
            parts = nets = 0
            board = False
        out.append({"id": pid, "name": name, "created": created, "updated": updated, "parts": parts, "nets": nets, "pcb": board})
    return out


def get_project(pid):
    with _lock, _db() as con:
        row = con.execute("SELECT json FROM projects WHERE id=?", (_check(pid),)).fetchone()
    if not row:
        raise LookupError("project not found")
    return json.loads(row[0])


def get_meta(pid):
    with _lock, _db() as con:
        row = con.execute("SELECT id, name, updated FROM projects WHERE id=?", (_check(pid),)).fetchone()
    if not row:
        raise LookupError("project not found")
    return {"id": row[0], "name": row[1], "updated": row[2]}


def save_project(pid, data):
    if not isinstance(data, dict):
        raise ValueError("project must be a JSON object")
    pid = _check(pid or uuid.uuid4().hex[:12])
    data["id"] = pid
    name = str(data.get("name") or "Untitled")[:200]
    now = time.time()
    js = json.dumps(data)
    with _lock, _db() as con:
        old = con.execute("SELECT name, json FROM projects WHERE id=?", (pid,)).fetchone()
        if old and old[1] != js:
            before, after = _parts_of(old[1]), len(data.get("components", []))
            drop = after < before and (before - after >= 3 or after < before * 0.8)
            _keep_version(con, pid, old[0], old[1], "parts removed" if drop else "save", force=drop)
        con.execute("""INSERT INTO projects(id, name, json, created, updated) VALUES(?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated=excluded.updated""",
                    (pid, name, js, now, now))
    return {"id": pid, "name": name, "updated": now}


def list_versions(pid):
    with _lock, _db() as con:
        rows = con.execute("SELECT vid, name, parts, saved, reason FROM versions WHERE pid=? ORDER BY saved DESC", (_check(pid),)).fetchall()
    return [{"version": v, "name": n, "parts": p, "saved": s, "reason": r} for v, n, p, s, r in rows]


def get_version(pid, vid):
    with _lock, _db() as con:
        row = con.execute("SELECT json FROM versions WHERE pid=? AND vid=?", (_check(pid), int(vid))).fetchone()
    if not row:
        raise LookupError("version not found")
    return json.loads(row[0])


def restore_version(pid, vid):
    """Make an earlier state current again; the state it replaces is kept as a version too."""
    data = get_version(pid, vid)
    with _lock, _db() as con:
        cur = con.execute("SELECT name, json FROM projects WHERE id=?", (pid,)).fetchone()
        if cur:
            _keep_version(con, pid, cur[0], cur[1], "before restore", force=True)
    with _lock, _db() as con:   # save_project would thin this out — write directly
        now, js = time.time(), json.dumps(dict(data, id=pid))
        con.execute("""INSERT INTO projects(id, name, json, created, updated) VALUES(?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated=excluded.updated""",
                    (pid, str(data.get("name") or "Untitled")[:200], js, now, now))
    return {"id": pid, "restored": int(vid), "parts": len(data.get("components", [])), "updated": now}


def delete_project(pid):
    with _lock, _db() as con:
        old = con.execute("SELECT name, json FROM projects WHERE id=?", (_check(pid),)).fetchone()
        if old:
            _keep_version(con, pid, old[0], old[1], "deleted", force=True)
        con.execute("DELETE FROM projects WHERE id=?", (pid,))
    return {"ok": True}


def deleted_projects():
    """Projects that were deleted but still have saved versions (restore_version brings them back)."""
    with _lock, _db() as con:
        rows = con.execute("""SELECT v.pid, v.name, v.parts, MAX(v.saved) FROM versions v LEFT JOIN projects p ON p.id = v.pid
                              WHERE p.id IS NULL GROUP BY v.pid ORDER BY MAX(v.saved) DESC""").fetchall()
    return [{"id": i, "name": n, "parts": p, "deleted": s} for i, n, p, s in rows]


# ---------------------------------------------------------------- user part library
def list_parts():
    with _lock, _db() as con:
        rows = con.execute("SELECT json FROM userparts ORDER BY name COLLATE NOCASE").fetchall()
    return [json.loads(r[0]) for r in rows]


def save_part(key, data):
    if not isinstance(data, dict) or not isinstance(data.get("pins"), list):
        raise ValueError("part must be an object with a pins list")
    key = _check(key)
    data["key"] = key
    with _lock, _db() as con:
        con.execute("INSERT OR REPLACE INTO userparts VALUES(?,?,?,?)",
                    (key, str(data.get("name") or key)[:200], json.dumps(data), time.time()))
    return {"ok": True, "key": key}


def delete_part(key):
    with _lock, _db() as con:
        con.execute("DELETE FROM userparts WHERE key=?", (_check(key),))
    return {"ok": True}
