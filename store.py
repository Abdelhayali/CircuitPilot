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
    return con


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
    with _lock, _db() as con:
        con.execute("""INSERT INTO projects(id, name, json, created, updated) VALUES(?,?,?,?,?)
                       ON CONFLICT(id) DO UPDATE SET name=excluded.name, json=excluded.json, updated=excluded.updated""",
                    (pid, name, json.dumps(data), now, now))
    return {"id": pid, "name": name, "updated": now}


def delete_project(pid):
    with _lock, _db() as con:
        con.execute("DELETE FROM projects WHERE id=?", (_check(pid),))
    return {"ok": True}


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
