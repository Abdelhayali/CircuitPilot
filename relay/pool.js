// Shared AI pool (on the relay): the owner's provider accounts behind one OpenAI-compatible endpoint, for users who do
// not bring their own key. Accounts are tried in the order set on the admin page; an account that runs out of quota
// or fails is put to rest and the next one answers, automatically. Keys live in the POOL key-value store and never
// leave the relay: the admin page shows only their last four characters. Users sign in with GitHub (the token is
// checked with GitHub and not stored) and get a daily request limit.
//
// Routes (worker.js sends /pool/* and /admin* here):
//   GET  /pool/status               signed-in user: requests used today and the limit
//   GET  /pool/v1/models            the one model name the app uses
//   POST /pool/v1/chat/completions  OpenAI-compatible chat, failover between accounts
//   GET  /admin, /admin/api/*       admin page and API (the ADMIN_LOGIN GitHub account only)
// Bindings: POOL (KV namespace), ADMIN_LOGIN (secret: the GitHub login that administers the pool).

const PRESETS = {
  google: { name: 'Google Gemini', base: 'https://generativelanguage.googleapis.com/v1beta/openai' },
  nvidia: { name: 'NVIDIA NIM', base: 'https://integrate.api.nvidia.com/v1' },
  ollama: { name: 'Ollama Cloud', base: 'https://ollama.com/v1' },
  openrouter: { name: 'OpenRouter', base: 'https://openrouter.ai/api/v1' },
  openai: { name: 'OpenAI', base: 'https://api.openai.com/v1' },
  custom: { name: 'Custom', base: '' },
};
const DEFAULTS = { dailyLimit: 20, maxTokens: 4096, rpm: 10, context: 262144 };   // rpm: requests per minute per account (0 = no cap)
const CIRCUIT_MODEL = 'circuitpilot';

const day = () => new Date().toISOString().slice(0, 10);
const midnight = () => { const d = new Date(); d.setUTCHours(24, 0, 0, 0); return d.getTime(); };
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

// the GitHub login of the bearer token (null when there is none or GitHub does not accept it)
async function login(req) {
  const m = /^Bearer\s+(\S{10,300})$/.exec(req.headers.get('authorization') || '');
  if (!m) return null;
  const r = await fetch('https://api.github.com/user', { headers: { authorization: 'Bearer ' + m[1], accept: 'application/vnd.github+json', 'user-agent': 'CircuitPilot-relay' } });
  if (!r.ok) return null;
  const j = await r.json().catch(() => null);
  return j && j.login ? String(j.login).toLowerCase() : null;
}
const isAdmin = (who, env) => !!who && !!env.ADMIN_LOGIN && who === String(env.ADMIN_LOGIN).trim().toLowerCase();

async function load(env) {
  const p = (await env.POOL.get('pool', 'json')) || {};
  return { entries: Array.isArray(p.entries) ? p.entries : [], settings: Object.assign({}, DEFAULTS, p.settings || {}) };
}
const save = (env, p) => env.POOL.put('pool', JSON.stringify(p));
const num = async (env, k) => Number(await env.POOL.get(k)) || 0;
// context window of a model as the provider reports it (OpenRouter, vLLM, LM Studio … report one; some report none)
const ctxOf = m => Number(m && (m.context_length || m.max_model_len || m.context_window || m.max_context_length || m.input_token_limit || m.max_seq_len || (m.top_provider && m.top_provider.context_length) || (m.meta && m.meta.n_ctx_train))) || 0;
async function listModels(base, key) {
  const r = await fetch(base + '/models', { headers: { authorization: 'Bearer ' + key, accept: 'application/json' } });
  const j = await r.json().catch(() => null);
  if (!r.ok) throw new Error('The provider answered ' + r.status + (j && j.error ? ': ' + String(j.error.message || j.error).slice(0, 200) : ''));
  const models = [], contexts = {};
  for (const m of ((j && (j.data || j.models)) || [])) {
    const id = String(m.id || m.name || '').replace(/^models\//, '');
    if (!id) continue;
    models.push(id);
    const c = ctxOf(m); if (c > 0) contexts[id] = c;
  }
  return { models: [...new Set(models)].sort(), contexts };
}
// the default context window (256K tokens) when an account's provider does not report one
const CTX_DEFAULT = 262144;

// one chat request: the first account that is ready answers; a failing account is put to rest and the next is tried
async function chat(req, env) {
  const who = await login(req);
  if (!who) return json({ error: 'Sign in with GitHub to use the shared AI (Connect an AI model → CircuitPilot shared).' }, 401);
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.messages)) return json({ error: 'A chat request with messages is needed.' }, 400);
  const pool = await load(env), d = day(), limit = pool.settings.dailyLimit, uk = 'u:' + who + ':' + d;
  const used = await num(env, uk);
  if (used >= limit) return json({ error: `You used today's shared AI requests (${limit}). They reset at midnight UTC, or use your own key.`, limit, used }, 429);
  body.max_tokens = Math.min(Number(body.max_tokens) || pool.settings.maxTokens, pool.settings.maxTokens);
  const now = Date.now();
  let changed = false, tried = 0, capped = 0;
  for (const e of pool.entries) {
    if (!e.enabled || !e.key || !e.base || !e.model || (e.cooldown_until || 0) > now) continue;
    const rpm = e.rpm == null ? pool.settings.rpm : e.rpm, mk = `m:${e.id}:${Math.floor(now / 60000)}`;
    const minuteUsed = await num(env, mk);
    if (rpm && minuteUsed >= rpm) { capped++; continue; }
    await env.POOL.put(mk, String(minuteUsed + 1), { expirationTtl: 180 });
    tried++;
    let up;
    try {
      up = await fetch(e.base + '/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.key, accept: body.stream ? 'text/event-stream' : 'application/json' },
        body: JSON.stringify(Object.assign({}, body, { model: e.model })),
      });
    } catch (err) {
      e.cooldown_until = now + 60000; e.last_error = 'network: ' + String(err && err.message || err).slice(0, 160); changed = true; continue;
    }
    if (up.ok) {
      const ck = `c:${e.id}:${d}`;
      await env.POOL.put(ck, String((await num(env, ck)) + 1));
      await env.POOL.put(uk, String(used + 1), { expirationTtl: 172800 });
      await seen(env, who, true);
      if (changed) await save(env, pool);
      return new Response(up.body, { status: 200, headers: { 'content-type': up.headers.get('content-type') || 'application/json', 'cache-control': 'no-store' } });
    }
    const msg = (await up.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300);
    if (up.status === 400 || up.status === 413 || up.status === 422) {   // the request itself was refused: another account would refuse it too
      if (changed) await save(env, pool);
      return json({ error: 'The request was refused: ' + msg }, 400);
    }
    // out of quota (daily) → rest until midnight UTC; rate limit → 2 min; bad key / no access → a day; model missing → an hour
    const daily = up.status === 402 || (up.status === 429 && /daily|per day|billing|credit|exhaust|quota/i.test(msg));
    e.cooldown_until = daily ? midnight() : up.status === 429 ? now + 120000 : (up.status === 401 || up.status === 403) ? now + 86400000 : up.status === 404 ? now + 3600000 : now + 60000;
    e.last_error = up.status + ' ' + msg.slice(0, 160);
    changed = true;
  }
  if (changed) await save(env, pool);
  if (!tried && capped) {
    const wait = 60 - Math.floor((now % 60000) / 1000);
    return new Response(JSON.stringify({ error: 'The shared AI is at its request limit for this minute. It continues by itself in a moment.' }), { status: 429, headers: { 'content-type': 'application/json', 'retry-after': String(wait), 'x-pool-busy': '1', 'cache-control': 'no-store' } });
  }
  return json({ error: tried ? 'The shared AI is busy or used up right now. Try again later, or use your own key.' : 'The shared AI has no account ready yet. The owner needs to add one.' }, 503);
}

async function status(req, env) {
  const who = await login(req);
  if (!who) return json({ error: 'Sign in with GitHub first' }, 401);
  await seen(env, who, false);
  const pool = await load(env), used = await num(env, 'u:' + who + ':' + day());
  return json({ used, limit: pool.settings.dailyLimit, ready: pool.entries.some(e => e.enabled && e.key && (e.cooldown_until || 0) <= Date.now()) });
}

// the admin page and its API (POST for changes)
async function admin(req, url, env) {
  const p = url.pathname;
  if (p === '/admin' || p === '/admin/') return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY', 'referrer-policy': 'no-referrer' } });
  if (!isAdmin(await login(req), env)) return json({ error: 'Only the admin GitHub account can use this. Paste that account\'s token.' }, 403);
  const pool = await load(env), d = day(), now = Date.now();
  if (p === '/admin/api/state' && req.method === 'GET') {
    const entries = [];
    for (const e of pool.entries) entries.push({ id: e.id, label: e.label, provider: e.provider, base: e.base, model: e.model, enabled: !!e.enabled, keyTail: String(e.key || '').slice(-4), cooling: (e.cooldown_until || 0) > now ? e.cooldown_until : 0, last_error: e.last_error || '', usedToday: await num(env, `c:${e.id}:${d}`), context: e.context || null, context_eff: e.context || pool.settings.context || CTX_DEFAULT, context_auto: !!e.context_auto, rpm: e.rpm == null ? null : e.rpm, minuteUsed: await num(env, `m:${e.id}:${Math.floor(now / 60000)}`) });
    return json({ entries, settings: pool.settings, presets: Object.fromEntries(Object.entries(PRESETS).map(([k, v]) => [k, v.name])), usedToday: entries.reduce((a, e) => a + e.usedToday, 0), day: d, limit: pool.settings.dailyLimit, users: await allUsers(env, d) });
  }
  if (req.method !== 'POST') return json({ error: 'Use POST for changes' }, 405);
  const body = await req.json().catch(() => ({}));
  const find = () => pool.entries.find(e => e.id === String(body.id || ''));
  if (p === '/admin/api/models') {
    const prov = PRESETS[body.provider] ? String(body.provider) : 'custom';
    const base = prov === 'custom' ? String(body.base || '').trim().replace(/\/+$/, '') : PRESETS[prov].base;
    if (!/^https:\/\/\S+$/.test(base)) return json({ error: 'The address must start with https://' }, 400);
    let key = String(body.key || '').trim();
    if (!key) { const e = find(); if (e) key = e.key; }   // editing an account: its saved key
    if (!key) return json({ error: 'Paste the API key first' }, 400);
    try { const { models, contexts } = await listModels(base, key); return json({ models, contexts }); }
    catch (err) { return json({ error: err.message }, 502); }
  }
  if (p === '/admin/api/entry') {
    const prov = PRESETS[body.provider] ? String(body.provider) : 'custom';
    const base = prov === 'custom' ? String(body.base || '').trim().replace(/\/+$/, '') : PRESETS[prov].base;
    if (!/^https:\/\/\S+$/.test(base)) return json({ error: 'The address must start with https://' }, 400);
    const model = String(body.model || '').trim();
    if (!model) return json({ error: 'Enter the model name (check the provider\'s list of models)' }, 400);
    let e = find();
    if (!e) {
      const key = String(body.key || '').trim();
      if (!key) return json({ error: 'Paste the API key of the account' }, 400);
      e = { id: crypto.randomUUID().slice(0, 8), key, cooldown_until: 0, last_error: '', added: d };
      pool.entries.push(e);
    } else if (String(body.key || '').trim()) e.key = String(body.key).trim();
    if (e.model !== model || e.base !== base) { e.cooldown_until = 0; e.last_error = ''; }
    if (String(body.rpm === undefined ? '' : body.rpm).trim() === '') e.rpm = null;
    else { const rpm = Math.round(Number(body.rpm)); if (!(rpm >= 0 && rpm <= 600)) return json({ error: 'Requests per minute: 0 to 600 (0 = no limit), or empty for the default' }, 400); e.rpm = rpm; }
    const cw = Math.round(Number(body.context));
    if (cw > 0) { e.context = cw; e.context_auto = false; }
    else {
      e.context = null; e.context_auto = false;
      try { const { contexts } = await listModels(base, e.key); if (contexts[model] > 0) { e.context = contexts[model]; e.context_auto = true; } } catch (err) { /* no list: the default applies */ }
    }
    const same = pool.entries.filter(x => x.provider === prov).length;
    Object.assign(e, { provider: prov, base, model, label: String(body.label || '').trim().slice(0, 60) || `${PRESETS[prov].name} ${same}`, enabled: body.enabled !== false });
    await save(env, pool);
    return json({ ok: true, id: e.id });
  }
  if (p === '/admin/api/user/reset') {
    if (body.all) {   // everyone's count for today (the rolling daily counters of this day only)
      let cursor;
      do {
        const r = await env.POOL.list({ prefix: 'u:', cursor });
        for (const k of r.keys) if (k.name.endsWith(':' + d)) await env.POOL.delete(k.name);
        cursor = r.list_complete ? undefined : r.cursor;
      } while (cursor);
      return json({ ok: true });
    }
    const who = String(body.login || '').trim().toLowerCase();
    if (!who) return json({ error: 'Which user?' }, 400);
    await env.POOL.delete(`u:${who}:${d}`);
    return json({ ok: true });
  }
  if (p === '/admin/api/delete') { pool.entries = pool.entries.filter(e => e.id !== String(body.id || '')); await save(env, pool); return json({ ok: true }); }
  if (p === '/admin/api/move') {
    const i = pool.entries.findIndex(e => e.id === String(body.id || '')), j = i + (body.dir < 0 ? -1 : 1);
    if (i >= 0 && j >= 0 && j < pool.entries.length) [pool.entries[i], pool.entries[j]] = [pool.entries[j], pool.entries[i]];
    await save(env, pool); return json({ ok: true });
  }
  if (p === '/admin/api/reset') { const e = find(); if (!e) return json({ error: 'No such account' }, 404); e.cooldown_until = 0; e.last_error = ''; await save(env, pool); return json({ ok: true }); }
  if (p === '/admin/api/settings') {
    const dl = Math.round(Number(body.dailyLimit)), mt = Math.round(Number(body.maxTokens));
    if (dl >= 1 && dl <= 10000) pool.settings.dailyLimit = dl;
    if (mt >= 256 && mt <= 32000) pool.settings.maxTokens = mt;
    const rp = Math.round(Number(body.rpm)); if (rp >= 1 && rp <= 600) pool.settings.rpm = rp;
    const cx = Math.round(Number(body.context)); if (cx >= 1024 && cx <= 2000000) pool.settings.context = cx;
    await save(env, pool); return json({ ok: true, settings: pool.settings });
  }
  if (p === '/admin/api/test') {   // one tiny request to check an account (the admin sees the provider's answer)
    const e = find(); if (!e) return json({ error: 'No such account' }, 404);
    const r = await fetch(e.base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + e.key }, body: JSON.stringify({ model: e.model, messages: [{ role: 'user', content: 'Reply with OK.' }], max_tokens: 5 }) });
    const t = (await r.text()).replace(/\s+/g, ' ').slice(0, 300);
    return json({ ok: r.ok, status: r.status, detail: r.ok ? 'answered' : t });
  }
  return json({ error: 'Unknown admin route' }, 404);
}

// users who signed in with GitHub: first and last sign-in and the total of shared requests (kept under user:<login>)
async function seen(env, who, counted) {
  const k = 'user:' + who, t = new Date().toISOString();
  const u = (await env.POOL.get(k, 'json')) || { login: who, first: t, total: 0 };
  u.last = t;
  if (counted) u.total = (u.total || 0) + 1;
  await env.POOL.put(k, JSON.stringify(u));
}
// every user with today's use, for the admin page (newest sign-in first)
async function allUsers(env, d) {
  const out = []; let cursor;
  do {
    const r = await env.POOL.list({ prefix: 'user:', cursor });
    for (const k of r.keys) { const u = await env.POOL.get(k.name, 'json'); if (u) out.push(u); }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor && out.length < 2000);
  const have = new Set(out.map(u => u.login));
  cursor = undefined;
  do {
    const r = await env.POOL.list({ prefix: 'u:', cursor });
    for (const k of r.keys) {
      if (!k.name.endsWith(':' + d)) continue;
      const login = k.name.slice(2, -(d.length + 1));
      if (login && !have.has(login)) { have.add(login); out.push({ login, first: '', last: '', total: 0 }); }
    }
    cursor = r.list_complete ? undefined : r.cursor;
  } while (cursor);
  for (const u of out) u.usedToday = await num(env, `u:${u.login}:${d}`);
  return out.sort((a, b) => String(b.last).localeCompare(String(a.last)));
}

export async function poolRoute(req, url, env) {
  if (!env || !env.POOL) return json({ error: 'The shared AI is not set up on this relay (POOL key-value store missing).' }, 503);
  const p = url.pathname;
  if (p.startsWith('/admin')) return admin(req, url, env);
  if (p === '/pool/status' && req.method === 'GET') return status(req, env);
  if (p === '/pool/v1/models' && req.method === 'GET') {
    const pool = await load(env), sizes = pool.entries.filter(e => e.enabled).map(e => e.context || pool.settings.context || CTX_DEFAULT);
    const context_length = sizes.length ? Math.min(...sizes) : (pool.settings.context || CTX_DEFAULT);
    return json({ object: 'list', data: [{ id: CIRCUIT_MODEL, object: 'model', owned_by: 'circuitpilot', context_length }] });
  }
  if (p === '/pool/v1/chat/completions' && req.method === 'POST') return chat(req, env);
  return null;
}

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>CircuitPilot shared AI admin</title>
<style>
body{font:14px system-ui,sans-serif;margin:16px;background:#f6f6f6;color:#222}
h1{font-size:20px} h2{font-size:16px;margin:18px 0 6px}
table{border-collapse:collapse;width:100%;background:#fff} td,th{border:1px solid #ddd;padding:6px;text-align:left;vertical-align:top} th{background:#eee}
input,select{padding:5px;font:inherit;max-width:100%} button{padding:5px 9px;font:inherit;cursor:pointer;margin:1px}
.bad{color:#b00} .good{color:#060} .muted{color:#666;font-size:12px}
.box{background:#fff;border:1px solid #ddd;padding:10px;margin-top:8px} .row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}
@media (max-width:700px){table{font-size:12px}}
</style></head><body>
<h1>CircuitPilot shared AI</h1>
<p class="muted">Accounts are tried in the order below. When one runs out of quota or fails, the next one answers automatically. A saved key is never shown again (only its last four characters).</p>
<div class="box row"><input id="tok" type="password" placeholder="GitHub token of the admin account" size="40"><button id="login">Load</button><span id="msg" class="muted"></span></div>
<div id="main" style="display:none">
<h2>Accounts (order = priority)</h2>
<table><thead><tr><th>#</th><th>Label</th><th>Provider</th><th>Model</th><th>Key</th><th>Status</th><th>Today</th><th>This minute</th><th>Actions</th></tr></thead><tbody id="rows"></tbody></table>
<p class="muted" id="total"></p>
<h2>Add or edit an account</h2>
<div class="box">
<input type="hidden" id="eid">
<div class="row"><input id="elabel" placeholder="Label, e.g. Google 1"><select id="eprov"></select><input id="ebase" placeholder="https://... (custom only)" size="36"></div>
<div class="row" style="margin-top:6px"><input id="emodel" list="mlist" placeholder="Model name (or Fetch models)" size="36"><button id="fetch">Fetch models</button><datalist id="mlist"></datalist><input id="ekey" type="password" placeholder="API key (empty when editing = keep it)" size="36"></div>
<div class="row" style="margin-top:6px"><input id="ermp" type="number" min="0" max="600" placeholder="Requests per minute (empty = default)" style="width:230px"><input id="ectx" type="number" min="1024" placeholder="Context in tokens: empty = from provider, else 256K" style="width:230px"><label><input type="checkbox" id="eon" checked> enabled</label><button id="save">Save account</button><button id="clear">New account</button><span id="emsg" class="muted"></span></div>
</div>
<h2>Users (signed in with GitHub)</h2>
<div class="box"><p class="muted" id="ustats"></p>
<div class="row"><button id="resetAll">Reset everyone's count for today</button><span id="umsg" class="muted"></span></div>
<table><thead><tr><th>GitHub login</th><th>First seen</th><th>Last seen</th><th>Total requests</th><th>Today</th><th></th></tr></thead><tbody id="urows"></tbody></table></div>
<h2>Limits</h2>
<div class="box row">Requests per user per day <input id="dl" type="number" min="1" max="10000" style="width:90px"> Max output tokens per request <input id="mt" type="number" min="256" max="32000" style="width:90px"> Requests per minute per account <input id="rpm" type="number" min="1" max="600" style="width:90px"> Default context window (tokens) <input id="cx" type="number" min="1024" max="2000000" style="width:120px"><button id="saveSet">Save limits</button><span id="smsg" class="muted"></span></div>
</div>
<script>
var state = null;
function $(id) { return document.getElementById(id); }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
function when(t) { if (!t) return '-'; var d = new Date(t); return isNaN(d) ? '-' : d.toISOString().slice(0, 16).replace('T', ' ') + ' UTC'; }
function api(path, body) {
  var tok = sessionStorage.getItem('cpAdminTok') || '';
  return fetch(path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok }, body: body ? JSON.stringify(body) : undefined })
    .then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || ('HTTP ' + r.status)); return j; }); });
}
function say(id, text, bad) { $(id).className = bad ? 'bad' : 'good'; $(id).textContent = text; }
function load() {
  var tok = $('tok').value.trim();
  if (tok) sessionStorage.setItem('cpAdminTok', tok);
  $('msg').textContent = 'Loading...';
  api('/admin/api/state').then(function (s) {
    state = s; $('msg').textContent = 'Admin signed in.'; $('main').style.display = ''; paint();
  }).catch(function (e) { $('msg').className = 'bad'; $('msg').textContent = e.message; });
}
function paint() {
  var prov = $('eprov'), keep = prov.value;
  prov.innerHTML = Object.keys(state.presets).map(function (k) { return '<option value="' + esc(k) + '">' + esc(state.presets[k]) + '</option>'; }).join('');
  if (keep) prov.value = keep;
  var now = Date.now();
  $('rows').innerHTML = state.entries.map(function (e, i) {
    var st = !e.enabled ? 'off' : (e.cooling && e.cooling > now) ? 'resting until ' + when(e.cooling) : 'ready';
    if (e.last_error) st += ' (last: ' + e.last_error + ')';
    var id = esc(e.id);
    return '<tr><td>' + (i + 1) + '</td><td>' + esc(e.label) + '</td><td>' + esc(state.presets[e.provider] || e.provider) + '<br><span class="muted">' + esc(e.base) + '</span></td>' +
      '<td>' + esc(e.model) + '<br><span class="muted">' + e.context_eff + ' tokens' + (e.context ? (e.context_auto ? ' (from provider)' : '') : ' (default)') + '</span>' + '</td><td>••••' + esc(e.keyTail) + '</td><td class="' + (st === 'ready' ? 'good' : 'bad') + '">' + esc(st) + '</td><td>' + e.usedToday + '</td><td>' + e.minuteUsed + ' / ' + (e.rpm == null ? state.settings.rpm : (e.rpm || 'no limit')) + '</td><td>' +
      '<button data-a="up" data-id="' + id + '">▲</button><button data-a="down" data-id="' + id + '">▼</button>' +
      '<button data-a="edit" data-id="' + id + '">Edit</button><button data-a="test" data-id="' + id + '">Test</button>' +
      '<button data-a="reset" data-id="' + id + '">Wake up</button><button data-a="delete" data-id="' + id + '">Delete</button></td></tr>';
  }).join('') || '<tr><td colspan="9" class="muted">No account yet. Add one below: users then get the shared AI.</td></tr>';
  var today = state.users.reduce(function (a, u) { return a + u.usedToday; }, 0), active = state.users.filter(function (u) { return u.usedToday > 0; }).length;
  $('ustats').textContent = state.users.length + ' users signed in · ' + active + ' used the shared AI today · ' + today + ' requests today · daily limit ' + state.settings.dailyLimit + ' per user';
  $('urows').innerHTML = state.users.map(function (u) {
    var over = u.usedToday >= state.settings.dailyLimit;
    return '<tr><td>' + esc(u.login) + '</td><td>' + esc(when(u.first)) + '</td><td>' + esc(when(u.last)) + '</td><td>' + u.total + '</td><td class="' + (over ? 'bad' : '') + '">' + u.usedToday + ' / ' + state.settings.dailyLimit + '</td><td><button data-u="' + esc(u.login) + '">Reset today</button></td></tr>';
  }).join('') || '<tr><td colspan="6" class="muted">No user has signed in yet.</td></tr>';
  $('total').textContent = 'Requests today: ' + state.usedToday + ' (day ' + state.day + ' UTC)';
  $('dl').value = state.settings.dailyLimit; $('mt').value = state.settings.maxTokens; $('rpm').value = state.settings.rpm; $('cx').value = state.settings.context;
}
function refresh(msgId, text, bad) { if (msgId) say(msgId, text, bad); return api('/admin/api/state').then(function (s) { state = s; paint(); }); }
$('login').onclick = load;
var ctxMap = {};
function fetchModels(quiet) {
  var key = $('ekey').value.trim(), id = $('eid').value;
  if (!key && !id) { if (!quiet) say('emsg', 'Paste the API key first (or edit a saved account).', true); return; }
  if (!quiet) say('emsg', 'Fetching models...');
  api('/admin/api/models', { id: id, provider: $('eprov').value, base: $('ebase').value, key: key }).then(function (r) {
    ctxMap = r.contexts || {};
    $('mlist').innerHTML = r.models.map(function (m) { return '<option value="' + esc(m) + '">'; }).join('');
    if (ctxMap[$('emodel').value.trim()]) $('ectx').value = ctxMap[$('emodel').value.trim()];
    if (!$('emodel').value.trim() && r.models.length) $('emodel').value = r.models[0];
    say('emsg', r.models.length + ' models found. Pick one in the Model field (suggestions appear when you click it).');
  }).catch(function (e) { if (!quiet) say('emsg', e.message, true); });
}
$('fetch').onclick = function () { fetchModels(false); };
$('emodel').onchange = function () { var c = ctxMap[$('emodel').value.trim()]; if (c) $('ectx').value = c; };
$('ekey').onchange = function () { if ($('ekey').value.trim()) fetchModels(true); };
$('rows').onclick = function (ev) {
  var b = ev.target.closest('[data-a]'); if (!b) return;
  var id = b.getAttribute('data-id'), a = b.getAttribute('data-a');
  if (a === 'edit') {
    var e = state.entries.filter(function (x) { return x.id === id; })[0]; if (!e) return;
    $('eid').value = e.id; $('elabel').value = e.label; $('eprov').value = e.provider; $('ebase').value = e.base; $('emodel').value = e.model; $('ekey').value = ''; $('eon').checked = !!e.enabled; $('ermp').value = e.rpm == null ? '' : e.rpm; $('ectx').value = e.context || '';
    say('emsg', 'Editing ' + e.label + ' (empty key = keep the saved one)');
    fetchModels(true);
    return;
  }
  if (a === 'delete' && !window.confirm('Delete this account? Its key is removed from the relay.')) return;
  if (a === 'test') { say('emsg', 'Testing...'); api('/admin/api/test', { id: id }).then(function (r) { say('emsg', r.ok ? 'Account answered (HTTP ' + r.status + ').' : 'Account failed (HTTP ' + r.status + '): ' + r.detail, !r.ok); }).catch(function (e) { say('emsg', e.message, true); }); return; }
  var path = { up: '/admin/api/move', down: '/admin/api/move', reset: '/admin/api/reset', delete: '/admin/api/delete' }[a];
  var body = { id: id }; if (a === 'up') body.dir = -1; if (a === 'down') body.dir = 1;
  api(path, body).then(function () { return refresh(); }).catch(function (e) { say('emsg', e.message, true); });
};
$('urows').onclick = function (ev) {
  var b = ev.target.closest('[data-u]'); if (!b) return;
  api('/admin/api/user/reset', { login: b.getAttribute('data-u') }).then(function () { return refresh('umsg', 'Count reset for ' + b.getAttribute('data-u') + '.'); }).catch(function (e) { say('umsg', e.message, true); });
};
$('resetAll').onclick = function () {
  if (!window.confirm("Reset every user's count for today?")) return;
  api('/admin/api/user/reset', { all: true }).then(function () { return refresh('umsg', "Everyone's count for today is reset."); }).catch(function (e) { say('umsg', e.message, true); });
};
$('save').onclick = function () {
  api('/admin/api/entry', { id: $('eid').value, label: $('elabel').value, provider: $('eprov').value, base: $('ebase').value, model: $('emodel').value, key: $('ekey').value, enabled: $('eon').checked, rpm: $('ermp').value, context: $('ectx').value })
    .then(function () { $('ekey').value = ''; return refresh('emsg', 'Saved.'); }).catch(function (e) { say('emsg', e.message, true); });
};
$('clear').onclick = function () { $('eid').value = ''; $('elabel').value = ''; $('ebase').value = ''; $('emodel').value = ''; $('ekey').value = ''; $('eon').checked = true; $('ermp').value = ''; $('ectx').value = ''; say('emsg', 'New account: paste its key.'); };
$('saveSet').onclick = function () {
  api('/admin/api/settings', { dailyLimit: $('dl').value, maxTokens: $('mt').value, rpm: $('rpm').value, context: $('cx').value }).then(function () { return refresh('smsg', 'Saved.'); }).catch(function (e) { say('smsg', e.message, true); });
};
if (sessionStorage.getItem('cpAdminTok')) { $('tok').value = sessionStorage.getItem('cpAdminTok'); load(); }
</script></body></html>`;
