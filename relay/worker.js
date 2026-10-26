// CircuitPilot relay — a Cloudflare Worker for the web version (GitHub Pages).
//
// The JLCPCB parts catalogue, the EasyEDA part library and DuckDuckGo search do not accept
// requests from other websites (no CORS), so the browser asks this relay instead. It only forwards to those fixed
// services (plus plain web pages / datasheets for the AI's web_fetch) and only for the origins in ALLOWED_ORIGINS.
// It stores nothing and handles no API keys: AI providers and Brave search are not forwarded (on the web version keys only
// ever go straight from the browser to the provider; the desktop version reaches the others from the user's own PC).

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36 CircuitPilot';
const JLC_SEARCH = 'https://jlcpcb.com/api/overseas-pcb-order/v1/shoppingCart/smtGood/selectSmtComponentList';
const EE_SEARCH = 'https://pro.easyeda.com/api/devices/search';
const EE_CODES = 'https://pro.easyeda.com/api/devices/searchByCodes';
const MAX_BYTES = 15_000_000;
const DEFAULT_ORIGINS = 'https://pcbgo.site,https://www.pcbgo.site,https://bodynet.net,https://www.bodynet.net,https://abdelhayali.github.io,http://localhost:5173,http://127.0.0.1:5173';

function corsHeaders(origin) {
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'content-type',
    'Access-Control-Expose-Headers': 'content-type, x-final-url',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}
const json = (obj, status, cors) => new Response(JSON.stringify(obj), { status, headers: Object.assign({ 'content-type': 'application/json' }, cors) });

// web_fetch: public http(s) pages only (Workers cannot reach private networks anyway; refuse obvious local names too)
function publicUrl(raw) {
  let u; try { u = new URL(raw); } catch (e) { throw new Error('Invalid URL'); }
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs can be fetched');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || h.startsWith('[')) throw new Error('Refusing to fetch a local address');
  return u;
}

async function relay(req, url) {
  const p = url.pathname;
  let m;
  if (p === '/jlcpcb/search' && req.method === 'POST')
    return fetch(JLC_SEARCH, { method: 'POST', headers: { 'content-type': 'application/json', 'accept': 'application/json', 'user-agent': UA }, body: await req.text() });
  // EasyEDA library: keyword search and the batch footprint check (form-encoded POST bodies, forwarded as they are)
  if ((p === '/easyeda/search' || p === '/easyeda/codes') && req.method === 'POST')
    return fetch(p === '/easyeda/search' ? EE_SEARCH : EE_CODES, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json', 'user-agent': UA }, body: await req.text() });
  // EasyEDA community library: keyword search (form POST) and one symbol / footprint document by uuid
  if (p === '/easyeda/community' && req.method === 'POST')
    return fetch('https://easyeda.com/api/components/search', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'accept': 'application/json', 'user-agent': UA }, body: await req.text() });
  if ((m = /^\/easyeda\/doc\/([0-9a-f]{32})$/.exec(p)))
    return fetch('https://easyeda.com/api/components/' + m[1], { headers: { 'accept': 'application/json', 'user-agent': UA } });
  if ((m = /^\/easyeda\/components\/(C\d{1,10})$/.exec(p)))
    return fetch(`https://easyeda.com/api/products/${m[1]}/components`, { headers: { 'accept': 'application/json', 'user-agent': UA } });
  if (p === '/ddg') {
    // DuckDuckGo's HTML endpoints answer some requests with a bot check (HTTP 202): try the full page, then the lite page
    const q = url.searchParams.get('q') || '';
    const a = await fetch('https://html.duckduckgo.com/html/?' + new URLSearchParams({ q }), { headers: { 'user-agent': UA, 'accept': 'text/html', 'accept-language': 'en' } });
    const text = a.status === 200 ? await a.text() : '';
    if (text.includes('result__a')) return new Response(text, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
    return fetch('https://lite.duckduckgo.com/lite/', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': UA, 'accept-language': 'en' }, body: new URLSearchParams({ q }).toString() });
  }
  if (p === '/fetch') {
    const target = publicUrl(url.searchParams.get('url') || '');
    const r = await fetch(target.toString(), { redirect: 'follow', headers: { 'user-agent': UA, 'accept': 'text/html,application/xhtml+xml,application/pdf,application/json,text/plain;q=0.9,*/*;q=0.5', 'accept-language': 'en' } });
    publicUrl(r.url);   // the final address after redirects must be public too
    if (+(r.headers.get('content-length') || 0) > MAX_BYTES) throw new Error('Document larger than 15 MB');
    const out = new Response(r.body, r); out.headers.set('x-final-url', r.url); return out;
  }
  if (p === '/' || p === '/health') return json({ ok: true, service: 'circuitpilot-relay' }, 200, {});
  return null;
}

export default {
  async fetch(req, env) {
    const origin = req.headers.get('Origin') || '';
    const allowed = String((env && env.ALLOWED_ORIGINS) || DEFAULT_ORIGINS).split(',').map(s => s.trim()).filter(Boolean);
    const ok = allowed.includes(origin);
    const cors = ok ? corsHeaders(origin) : {};
    const url = new URL(req.url);
    if (req.method === 'OPTIONS') return new Response(null, { status: ok ? 204 : 403, headers: cors });
    if (!ok && url.pathname !== '/' && url.pathname !== '/health') return json({ error: 'This relay only serves the CircuitPilot web app (origin not allowed: ' + (origin || 'none') + ')' }, 403, {});
    try {
      const r = await relay(req, url);
      if (!r) return json({ error: 'Unknown relay route ' + url.pathname }, 404, cors);
      const h = new Headers(cors);
      for (const k of ['content-type', 'x-final-url']) { const v = r.headers.get(k); if (v) h.set(k, v); }
      return new Response(r.body, { status: r.status, headers: h });
    } catch (e) {
      return json({ error: String((e && e.message) || e) }, 502, cors);
    }
  },
};
