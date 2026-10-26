"""JLCPCB Open API client (PCB, Parts, 3D printing): signed requests with the keys in jlcapi-keys.json.

The keys never leave this machine's server: the browser app and the MCP server call /api/jlc/... on server.py, which
signs the request here. Signature (JOP scheme): HMAC-SHA256 with the SecretKey over
"METHOD\\nPATH\\nTIMESTAMP\\nNONCE\\nBODY\\n", base64; header
Authorization: JOP appid="…",accesskey="…",timestamp="…",nonce="…",signature="…".
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import string
import time
import urllib.error
import urllib.request
import uuid

ENDPOINT = os.environ.get("JLCPCB_ENDPOINT", "https://open.jlcpcb.com")
_HERE = os.path.dirname(os.path.abspath(__file__))


def _keys():
    for d in [os.environ.get("CP_DATA_DIR"), _HERE, os.path.join(os.environ.get("LOCALAPPDATA", ""), "CircuitPilot")]:
        if not d:
            continue
        p = os.path.join(d, "jlcapi-keys.json")
        if os.path.isfile(p):
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    if os.environ.get("JLCPCB_ACCESS_KEY"):
        return {"app_id": os.environ.get("JLCPCB_APP_ID", ""), "access_key": os.environ["JLCPCB_ACCESS_KEY"], "secret_key": os.environ["JLCPCB_SECRET_KEY"]}
    return None


def configured():
    k = _keys()
    return bool(k and k.get("access_key") and k.get("secret_key"))


def _auth(method, path, body, k):
    nonce = "".join(secrets.choice(string.ascii_letters + string.digits) for _ in range(32))
    ts = str(int(time.time()))
    sts = f"{method}\n{path}\n{ts}\n{nonce}\n{body}\n"
    sig = base64.b64encode(hmac.new(k["secret_key"].encode(), sts.encode(), hashlib.sha256).digest()).decode()
    return f'JOP appid="{k.get("app_id", "")}",accesskey="{k["access_key"]}",timestamp="{ts}",nonce="{nonce}",signature="{sig}"'


def _send(req, timeout=60):
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read().decode("utf-8", "replace")
            status = r.status
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        status = e.code
    try:
        j = json.loads(raw) if raw else {}
    except ValueError:
        j = {"code": status, "message": raw[:300]}
    if not isinstance(j, dict):
        j = {"code": status, "data": j}
    j.setdefault("code", status)
    j["http_status"] = status
    return j


def post(path, payload=None, timeout=60):
    k = _keys()
    if not k:
        return {"code": 401, "message": "No JLCPCB API keys (jlcapi-keys.json)"}
    body = json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":"))
    req = urllib.request.Request(ENDPOINT + path, data=body.encode("utf-8"), method="POST",
                                 headers={"Content-Type": "application/json", "Accept": "application/json", "Authorization": _auth("POST", path, body, k)})
    return _send(req, timeout)


def upload(path, filename, data, meta=None, timeout=120):
    """multipart POST: a 'meta' JSON field (signed as the body) and the file"""
    k = _keys()
    if not k:
        return {"code": 401, "message": "No JLCPCB API keys (jlcapi-keys.json)"}
    meta_s = json.dumps(meta or {}, ensure_ascii=False, separators=(",", ":"))
    b = "----cp" + uuid.uuid4().hex
    parts = [f'--{b}\r\nContent-Disposition: form-data; name="meta"\r\n\r\n{meta_s}\r\n'.encode("utf-8"),
             f'--{b}\r\nContent-Disposition: form-data; name="file"; filename="{filename}"\r\nContent-Type: application/zip\r\n\r\n'.encode("utf-8"),
             data, f"\r\n--{b}--\r\n".encode("utf-8")]
    req = urllib.request.Request(ENDPOINT + path, data=b"".join(parts), method="POST",
                                 headers={"Content-Type": f"multipart/form-data; boundary={b}", "Accept": "application/json", "Authorization": _auth("POST", path, meta_s, k)})
    return _send(req, timeout)


# ---------- Parts ----------
def part_details(codes):
    return post("/overseas/openapi/component/getComponentDetailByCode", {"componentCodes": list(codes)[:50]})


# ---------- PCB ----------
def upload_gerber(filename, data):
    return upload("/overseas/openapi/pcb/uploadGerber", filename, data, {})


def pcb_quote(payload):
    return post("/overseas/openapi/pcb/calculate", payload)


def pcb_audit(file_key, language=1):
    return post("/overseas/openapi/pcb/audit/get", {"key": file_key, "language": language})


def pcb_create(payload):
    return post("/overseas/openapi/pcb/create", payload)


def pcb_order(batch_num):
    return post("/overseas/openapi/pcb/order/detail", {"batchNum": batch_num})


def pcb_progress(order_uuid):
    return post("/overseas/openapi/pcb/wip/get", {"orderUUID": order_uuid})


if __name__ == "__main__":   # quick check: python jlcapi.py C25804
    import sys
    print(json.dumps(part_details(sys.argv[1:] or ["C25804"]), indent=1)[:2000])
