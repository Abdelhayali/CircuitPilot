"""JLCPCB Open Platform (https://api.jlcpcb.com) client: signed requests with your app's keys.

Keys are read from jlcapi-keys.json next to this file (never committed — see .gitignore) or from the environment:
    {"app_id": "...", "access_key": "...", "secret_key": "..."}
    JLC_APP_ID / JLC_ACCESS_KEY / JLC_SECRET_KEY

Signature (docs: API Request Signature): HMAC-SHA256 over
    "<METHOD>\\n<path>\\n<unix time>\\n<32-char nonce>\\n<body>\\n"
with the SecretKey, Base64-encoded, sent as
    Authorization: JOP appid="…",accesskey="…",nonce="…",timestamp="…",signature="…"
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

BASE = os.environ.get("JLC_API_BASE", "https://open.jlcpcb.com")  # endpoint from the JLCPCB SDK usage guide
KEY_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "jlcapi-keys.json")
_ALNUM = string.ascii_letters + string.digits


def keys():
    k = {"app_id": os.environ.get("JLC_APP_ID"), "access_key": os.environ.get("JLC_ACCESS_KEY"), "secret_key": os.environ.get("JLC_SECRET_KEY")}
    if not all(k.values()) and os.path.exists(KEY_FILE):
        with open(KEY_FILE, encoding="utf-8") as f:
            k.update({a: b for a, b in json.load(f).items() if b})
    return k if all(k.get(n) for n in ("app_id", "access_key", "secret_key")) else None


def sign(method, path, timestamp, nonce, body, secret_key):
    msg = f"{method.upper()}\n{path}\n{timestamp}\n{nonce}\n{body}\n"
    return base64.b64encode(hmac.new(secret_key.encode(), msg.encode(), hashlib.sha256).digest()).decode()


def auth_header(method, path, body, k, timestamp=None, nonce=None):
    timestamp = str(timestamp or int(time.time()))
    nonce = nonce or "".join(secrets.choice(_ALNUM) for _ in range(32))
    sig = sign(method, path, timestamp, nonce, body, k["secret_key"])
    return f'JOP appid="{k["app_id"]}",accesskey="{k["access_key"]}",nonce="{nonce}",timestamp="{timestamp}",signature="{sig}"'


def post(path, payload, base=BASE):
    """Signed POST (every Open Platform call is a JSON POST). Raises if no keys are configured."""
    k = keys()
    if not k:
        raise RuntimeError("JLCPCB API keys are not configured (jlcapi-keys.json or JLC_* environment variables)")
    body = json.dumps(payload, separators=(",", ":"), ensure_ascii=False)
    req = urllib.request.Request(base + path, data=body.encode("utf-8"), method="POST", headers={
        "Content-Type": "application/json", "Accept": "application/json", "Authorization": auth_header("POST", path, body, k)})
    with urllib.request.urlopen(req, timeout=20) as r:
        return json.loads(r.read().decode("utf-8"))


DETAIL_PATH = "/overseas/openapi/component/getComponentDetailByCode"
_denied_until = 0.0   # after a refusal (no keys / API not authorised yet) stay quiet for 10 minutes


def _num(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def component_details(codes):
    """{C-number: {stock, price, basic, mfr_part, package, description, datasheet}} from the official Components API.
    Returns {} when no keys are configured or the API refuses (e.g. not authorised yet) — callers fall back."""
    global _denied_until
    codes = [c for c in dict.fromkeys(codes) if c and c.startswith("C") and c[1:].isdigit()]
    if not codes or not keys() or time.time() < _denied_until:
        return {}
    out = {}
    for i in range(0, len(codes), 50):
        try:
            j = post(DETAIL_PATH, {"componentCodes": codes[i:i + 50]})
        except Exception:
            _denied_until = time.time() + 600
            return out
        if not (j.get("success") or j.get("code") == 200):
            _denied_until = time.time() + 600
            return out
        data = j.get("data")
        if isinstance(data, dict):
            data = data.get("componentDetailResponseVOList") or data.get("list") or []
        for d in data or []:
            code = (d.get("componentCode") or "").upper()
            if not code:
                continue
            prices = sorted(d.get("priceRanges") or d.get("prices") or [], key=lambda p: _num(p.get("startQuantity") or p.get("startNumber")) or 0)
            lib = str(d.get("componentLibraryType") or d.get("libraryType") or "").lower()
            out[code] = {
                "stock": int(_num(d.get("stockCount")) or 0),
                "price": _num((prices[0].get("unitPrice") or prices[0].get("productPrice"))) if prices else None,
                "basic": 1 if lib in ("base", "basic") else 0 if lib else None,
                "mfr_part": d.get("componentModel") or d.get("componentModelEn"), "package": d.get("componentSpecification") or d.get("componentSpecificationEn"),
                "description": d.get("description") or d.get("describe"), "datasheet": d.get("datasheetUrl") or d.get("dataManualUrl"),
            }
    return out


if __name__ == "__main__":  # self-test with the worked example from the JLCPCB docs
    ex = sign("POST", "/order/v1/createOrder", "1625208260", "IZHEJYNIHYZIE8S0LLC0VWTPJVRRTO50",
              '{"goodsId":100,"quantity":52,"createdTime":"2024-03-21 10:03:20"}', "z0BWlikshimuyiwBsH1i2qwnzMb3j3kA")
    print("signature", ex, "OK" if ex == "sygwKhKBkLwHVv0c7D+a/A7JTEJjGH/kLugFKh16918=" else "MISMATCH")
    print("keys configured:", bool(keys()))
    if keys():
        try:
            print("component detail C2040:", post(DETAIL_PATH, {"componentCodes": ["C2040"]}))
        except urllib.error.HTTPError as e:
            print("component detail C2040: HTTP", e.code, e.read().decode()[:300])
