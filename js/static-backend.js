'use strict';
// Browser-only backend for the web version (GitHub Pages or any static host).
//
// The app talks to server.py through /api/* requests. When the page is not served by server.py, this file answers
// those requests in the browser instead, so the rest of the app does not change:
//   projects + My Library      → IndexedDB in this browser
//   parts search / part models → JLCPCB + EasyEDA through the CircuitPilot relay (relay/worker.js), cached in IndexedDB
//   web search / fetch         → DuckDuckGo or Brave and the page itself through the relay; PDFs read with pdf.js
//   chat attachments (PDF)     → pdf.js in the browser
//   Ollama Cloud               → through the relay
//   knowledge folders          → not available (they read files on your computer)
// With server.py running, every request goes to the server as before.
(() => {
  const realFetch = window.fetch.bind(window);
  const U = 0.254;   // EasyEDA library unit (10 mil) in mm
  const SOURCE = 'JLCPCB/LCSC catalogue · symbols & footprints: JLCEDA/EasyEDA official library (easyeda.com, lceda.cn)';
  let mode = null, probing = null;

  // ---------- server or static? ----------
  function detect() {
    if (mode) return Promise.resolve(mode);
    if (!probing) probing = (async () => {
      if (location.protocol === 'file:') return (mode = 'static');
      try {
        const r = await realFetch('/api/version', { cache: 'no-store' });
        const j = r.ok ? await r.json().catch(() => null) : null;
        mode = j && j.version ? 'server' : 'static';
      } catch (e) { mode = 'static'; }
      if (mode === 'static') {
        const mark = () => document.body && document.body.classList.add('static-web');
        if (document.body) mark(); else document.addEventListener('DOMContentLoaded', mark);
      }
      return mode;
    })();
    return probing;
  }
  detect();

  const settings = () => { try { return JSON.parse(localStorage.getItem('cp.settings') || '{}'); } catch (e) { return {}; } };
  const relayBase = () => String(settings().relayUrl || (window.CP_CONFIG && window.CP_CONFIG.relay) || '').trim().replace(/\/+$/, '');
  function needRelay() {
    const b = relayBase();
    if (!b) throw httpError(503, 'Part search, web search and Ollama Cloud need the CircuitPilot relay. Add its address in ⚙ Settings → Relay (see relay/README.md), or run the desktop version with server.py.');
    return b;
  }
  const httpError = (status, message) => Object.assign(new Error(message), { status });
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });

  // ---------- IndexedDB ----------
  let dbp = null;
  function db() {
    if (!dbp) dbp = new Promise((res, rej) => {
      const r = indexedDB.open('circuitpilot', 1);
      r.onupgradeneeded = () => { const d = r.result; for (const [s, k] of [['projects', 'id'], ['library', 'key'], ['parts', 'lcsc'], ['models', 'lcsc']]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: k }); };
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error || new Error('Browser storage is unavailable'));
    });
    return dbp;
  }
  async function tx(store, fn, write) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction(store, write ? 'readwrite' : 'readonly'), s = t.objectStore(store);
      let out; const req = fn(s); if (req) req.onsuccess = () => { out = req.result; };
      t.oncomplete = () => res(out); t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('Storage aborted'));
    });
  }
  const dbGet = (s, k) => tx(s, st => st.get(k));
  const dbAll = s => tx(s, st => st.getAll());
  const dbPut = (s, v) => tx(s, st => st.put(v), true);
  const dbDel = (s, k) => tx(s, st => st.delete(k), true);
  const dbPutMany = (s, vs) => tx(s, st => { for (const v of vs) st.put(v); }, true);

  // ---------- projects + My Library (same answers as store.py) ----------
  const newId = () => Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(16).padStart(2, '0')).join('');
  async function projects(method, parts, body) {
    const [id, sub] = parts;
    if (method === 'GET' && !id) {
      const all = await dbAll('projects');
      return all.sort((a, b) => b.updated - a.updated).map(p => { const d = p.data || {}; return { id: p.id, name: p.name, created: p.created, updated: p.updated, parts: (d.components || []).length, nets: Object.keys(d.nets || {}).length, pcb: !!(d.board && d.board.w) }; });
    }
    if (method === 'GET') {
      const p = await dbGet('projects', id); if (!p) throw httpError(404, 'project not found');
      return sub === 'meta' ? { id: p.id, name: p.name, updated: p.updated } : p.data;
    }
    if (method === 'PUT' || method === 'POST') {
      if (!body || typeof body !== 'object') throw httpError(400, 'project must be a JSON object');
      const pid = id || newId(), now = Date.now() / 1000, old = id ? await dbGet('projects', pid) : null;
      body.id = pid; const name = String(body.name || 'Untitled').slice(0, 200);
      await dbPut('projects', { id: pid, name, data: body, created: old ? old.created : now, updated: now });
      return { id: pid, name, updated: now };
    }
    if (method === 'DELETE' && id) { await dbDel('projects', id); return { ok: true }; }
    throw httpError(404, 'unknown endpoint');
  }
  async function library(method, key, body) {
    if (method === 'GET') return (await dbAll('library')).map(r => r.data).sort((a, b) => String(a.name || a.key).localeCompare(String(b.name || b.key), undefined, { sensitivity: 'base' }));
    if (method === 'PUT' || method === 'POST') {
      if (!body || !Array.isArray(body.pins)) throw httpError(400, 'part must be an object with a pins list');
      body.key = key; await dbPut('library', { key, data: body }); return { ok: true, key };
    }
    if (method === 'DELETE') { await dbDel('library', key); return { ok: true }; }
    throw httpError(404, 'unknown endpoint');
  }

  // ---------- parts: JLCPCB search + EasyEDA models (ports of partsdb.py) ----------
  const num = v => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const r4 = (v, d = 4) => +(+v).toFixed(d);
  function row(x) {
    const prices = x.componentPrices || [];
    return { lcsc: x.componentCode, mfr_part: x.componentModelEn, brand: x.componentBrandEn, package: x.componentSpecificationEn, category: x.componentTypeEn,
      description: String(x.describe || '').slice(0, 300), stock: x.stockCount || 0, basic: x.componentLibraryType === 'base' ? 1 : 0,
      price: prices[0] ? prices[0].productPrice : null, datasheet: x.dataManualUrl };
  }
  async function searchLocal(q, limit = 50) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = await dbAll('parts');
    return all.filter(p => { const t = [p.lcsc, p.mfr_part, p.description, p.package, p.category].join(' ').toLowerCase(); return words.every(w => t.includes(w)); })
      .sort((a, b) => (b.stock || 0) - (a.stock || 0)).slice(0, limit);
  }
  async function partsSearch(q, limit) {
    q = String(q || '').trim(); if (!q) return { source: 'none', results: [] };
    limit = Math.max(1, Math.min(+limit || 20, 50));
    try {
      const r = await realFetch(needRelay() + '/jlcpcb/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyword: q, currentPage: 1, pageSize: limit }) });
      if (!r.ok) throw new Error('JLCPCB search failed (' + r.status + ')');
      const j = await r.json();
      const rows = ((((j || {}).data || {}).componentPageInfo || {}).list || []).map(row).filter(x => x.lcsc);
      dbPutMany('parts', rows.map(x => Object.assign({ updated: Date.now() / 1000 }, x))).catch(() => { });
      return { source: 'jlcpcb', results: rows };
    } catch (e) {
      if (e.status === 503) throw e;
      return { source: 'local', error: e.message, results: await searchLocal(q, limit) };
    }
  }
  function parsePins(shapes, cx, cy) {
    const pins = [];
    for (const s of shapes) {
      if (!s.startsWith('P~')) continue;
      const seg = s.split('^^'), f0 = seg[0].split('~');
      const x = f0.length > 4 ? num(f0[4]) : 0, y = f0.length > 5 ? num(f0[5]) : 0;
      let n = null, name = null;
      if (seg.length > 4) { const t = seg[4].split('~'); if (t.length > 4) n = t[4]; }
      if (seg.length > 3) { const t = seg[3].split('~'); if (t.length > 4) name = t[4]; }
      n = String(n || (f0.length > 3 ? f0[3] : '') || '').trim(); name = String(name || n).trim();
      let side = x < cx ? 'L' : 'R';
      if (seg.length > 2) { const m = /([hv])\s*(-?[\d.]+)/.exec(seg[2]); if (m) { const d = parseFloat(m[2]); side = m[1] === 'h' ? (d < 0 ? 'R' : 'L') : (d > 0 ? 'T' : 'B'); } }
      if (n) pins.push({ num: n, name, side, x, y });
    }
    return pins;
  }
  function padShape(f) {
    const shape = f[1]; let x = num(f[2]), y = num(f[3]), w = num(f[4]), h = num(f[5]);
    const layer = f[6], number = f[8] || '', holeR = num(f[9]), points = f[10]; let rot = f.length > 11 ? num(f[11]) : 0;
    if (shape === 'POLYGON' && points) {
      const p = points.split(/\s+/).filter(Boolean).map(num), xs = p.filter((_, i) => i % 2 === 0), ys = p.filter((_, i) => i % 2 === 1);
      if (xs.length && ys.length) { const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys); x = (x0 + x1) / 2; y = (y0 + y1) / 2; w = x1 - x0; h = y1 - y0; rot = 0; }
    }
    if (((Math.round(rot) % 180) + 180) % 180 === 90) [w, h] = [h, w];
    const kind = shape === 'RECT' || shape === 'POLYGON' ? 'rect' : Math.abs(w - h) < 1e-6 ? 'round' : 'oval';
    return { num: number.trim(), x, y, w, h, shape: kind, drill: holeR > 0 ? holeR * 2 * U : null, layer };
  }
  function parseFootprint(pkg) {
    const ds = (pkg && pkg.dataStr) || {}, pads = [], silk = [];
    for (const s of ds.shape || []) {
      const f = s.split('~');
      if (s.startsWith('PAD~') && f.length > 10) pads.push(padShape(f));
      else if (s.startsWith('TRACK~') && f.length > 4 && f[2] === '3') { const p = f[4].split(/\s+/).filter(Boolean).map(num); for (let i = 0; i + 1 < p.length; i += 2) silk.push([p[i], p[i + 1]]); }
    }
    if (!pads.length) return null;
    const xs = pads.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = pads.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
    const ox = (Math.min(...xs) + Math.max(...xs)) / 2, oy = (Math.min(...ys) + Math.max(...ys)) / 2;
    const out = pads.map(p => Object.assign({ num: p.num, x: r4((p.x - ox) * U), y: r4((p.y - oy) * U), w: r4(p.w * U), h: r4(p.h * U), shape: p.shape }, p.drill ? { drill: r4(p.drill, 3) } : {}));
    const bx = silk.map(q => (q[0] - ox) * U).concat(xs.map(v => (v - ox) * U)), by = silk.map(q => (q[1] - oy) * U).concat(ys.map(v => (v - oy) * U));
    return { name: pkg.title || 'footprint', pads: out, body: [r4(Math.min(...bx), 3), r4(Math.min(...by), 3), r4(Math.max(...bx), 3), r4(Math.max(...by), 3)] };
  }
  async function getPart(code) {
    const lcsc = String(code || '').trim().toUpperCase();
    if (!/^C\d{1,10}$/.test(lcsc)) throw httpError(400, `"${lcsc}" is not an LCSC part number (e.g. C2838502)`);
    const cached = await dbGet('models', lcsc).catch(() => null);
    if (cached && cached.data && (cached.data.uuid || cached.data.no_uuid)) return cached.data;
    const res = await realFetch(needRelay() + '/easyeda/components/' + lcsc);
    const j = await res.json().catch(() => ({}));
    const r = j && j.success ? j.result : null;
    if (!r) { if (cached) return cached.data; throw httpError(404, `No symbol/footprint found for ${lcsc}`); }
    const ds = r.dataStr || {}, head = ds.head || {}, para = head.c_para || {};
    let shapes = (ds.shape || []).slice();
    for (const sp of r.subparts || []) shapes = shapes.concat(((sp.dataStr || {}).shape) || []);
    const pins = parsePins(shapes, num(head.x), num(head.y)), order = { L: 0, T: 1, R: 2, B: 3 }, seen = new Set(), uniq = [];
    pins.sort((a, b) => (order[a.side] - order[b.side]) || ((a.side === 'T' || a.side === 'B' ? a.x - b.x : a.y - b.y)) || (a.y - b.y));
    for (const p of pins) if (!seen.has(p.num)) { seen.add(p.num); uniq.push({ num: p.num, name: p.name, side: p.side }); }
    const pd = r.packageDetail || {};
    const model = {
      lcsc, name: para.name || r.title, mfr_part: para['Manufacturer Part'], manufacturer: para.Manufacturer, package: para.package,
      prefix: String(para.pre || 'U?').replace(/\?+$/, '') || 'U', value: para.Value || para['Manufacturer Part'] || r.title,
      pins: uniq, footprint: parseFootprint(pd), datasheet: (((pd.dataStr || {}).head || {}).c_para || {}).link, source: SOURCE,
      uuid: r.uuid, puuid: head.puuid || pd.uuid,
    };
    if (!model.uuid) model.no_uuid = true;
    dbPut('models', { lcsc, data: model, updated: Date.now() / 1000 }).catch(() => { });
    return model;
  }

  // ---------- web search + fetch (ports of webtools.py) ----------
  function cleanDdg(u) {
    if (u.startsWith('//')) u = 'https:' + u;
    try { const p = new URL(u, 'https://duckduckgo.com'); if (p.hostname.endsWith('duckduckgo.com') && p.pathname.startsWith('/l/')) return p.searchParams.get('uddg') || u; return p.href; } catch (e) { return u; }
  }
  async function webSearch(q, n, braveKey) {
    q = String(q || '').trim(); if (!q) throw httpError(400, 'Empty query');
    n = Math.max(1, Math.min(+n || 8, 20));
    const base = needRelay();
    if (braveKey) {
      const r = await realFetch(base + '/brave?' + new URLSearchParams({ q, count: n }), { headers: { 'x-brave-key': braveKey } });
      const j = await r.json(); if (!r.ok) throw httpError(502, (j && j.error) || 'Brave search failed');
      return { engine: 'brave', query: q, results: (((j.web || {}).results) || []).slice(0, n).map(x => ({ title: x.title || '', url: x.url || '', snippet: String(x.description || '').replace(/<[^>]+>/g, '') })) };
    }
    const r = await realFetch(base + '/ddg?' + new URLSearchParams({ q }));
    if (!r.ok) throw httpError(502, 'DuckDuckGo search failed (' + r.status + ') — add a Brave Search key in ⚙ Settings for reliable web search');
    const doc = new DOMParser().parseFromString(await r.text(), 'text/html'), results = [];
    const add = (a, sn) => {
      const url = cleanDdg(a.getAttribute('href') || '');
      if (!/^https?:/.test(url) || url.includes('duckduckgo.com/y.js')) return;   // ads
      results.push({ title: a.textContent.replace(/\s+/g, ' ').trim(), url, snippet: sn ? sn.textContent.replace(/\s+/g, ' ').trim() : '' });
    };
    for (const a of doc.querySelectorAll('a.result__a')) {   // html.duckduckgo.com
      if (results.length >= n) break;
      const box = a.closest('.result, .web-result') || a.parentElement; add(a, box && box.querySelector('.result__snippet'));
    }
    if (!results.length) for (const a of doc.querySelectorAll('a.result-link')) {   // lite.duckduckgo.com: snippet in the next table row
      if (results.length >= n) break;
      const tr = a.closest('tr'), next = tr && tr.nextElementSibling; add(a, next && next.querySelector('.result-snippet'));
    }
    return Object.assign({ engine: 'duckduckgo', query: q, results }, results.length ? {} : { note: 'DuckDuckGo returned no results (it sometimes blocks automated searches). For reliable web search add a free Brave Search API key in ⚙ Settings.' });
  }
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'NAV', 'FOOTER', 'HEADER', 'FORM', 'IFRAME', 'TEMPLATE']);
  const BLOCK = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'SECTION', 'ARTICLE', 'TABLE', 'UL', 'OL', 'PRE', 'BLOCKQUOTE']);
  function htmlToText(html) {
    const doc = new DOMParser().parseFromString(html, 'text/html'), out = [];
    (function walk(n) {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) { out.push(c.nodeValue); continue; }
        if (c.nodeType !== 1 || SKIP.has(c.tagName)) continue;
        if (BLOCK.has(c.tagName)) out.push('\n');
        if (c.tagName === 'TD' || c.tagName === 'TH') out.push(' | ');
        if (/^H[123]$/.test(c.tagName)) out.push('\n## ');
        walk(c);
        if (BLOCK.has(c.tagName)) out.push('\n');
      }
    })(doc.body || doc.documentElement);
    let t = out.join('').replace(/[ \t\r\f\v]+/g, ' ').replace(/\n## *(?=\n)/g, '').replace(/\n\s*\n\s*(\n\s*)+/g, '\n\n').trim();
    return { title: ((doc.querySelector('title') || {}).textContent || '').replace(/\s+/g, ' ').trim(), text: t };
  }
  let pdfjs = null;
  function loadPdfJs() {
    if (!pdfjs) pdfjs = new Promise((res, rej) => {
      const v = '3.11.174', s = document.createElement('script');
      s.src = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${v}/pdf.min.js`;
      s.onload = () => { window.pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${v}/pdf.worker.min.js`; res(window.pdfjsLib); };
      s.onerror = () => { pdfjs = null; rej(new Error('Could not load the PDF reader (pdf.js)')); };
      document.head.appendChild(s);
    });
    return pdfjs;
  }
  async function pdfText(buf, maxPages = 300) {
    const lib = await loadPdfJs(), doc = await lib.getDocument({ data: new Uint8Array(buf) }).promise, pages = [];
    for (let i = 1; i <= Math.min(doc.numPages, maxPages); i++) {
      const c = await (await doc.getPage(i)).getTextContent();
      pages.push(`[page ${i}]\n` + c.items.map(it => it.str + (it.hasEOL ? '\n' : ' ')).join('').replace(/[ \t]+\n/g, '\n'));
    }
    let title = ''; try { title = ((await doc.getMetadata()).info || {}).Title || ''; } catch (e) { }
    return { title, text: pages.join('\n\n'), pages: doc.numPages };
  }
  const fetchCache = new Map();
  async function relayGet(url) {
    const r = await realFetch(needRelay() + '/fetch?' + new URLSearchParams({ url }));
    if (!r.ok) { const j = await r.json().catch(() => null); throw httpError(502, (j && j.error) || `Fetch failed (${r.status})`); }
    return { final: r.headers.get('x-final-url') || url, ctype: (r.headers.get('content-type') || '').toLowerCase(), buf: await r.arrayBuffer() };
  }
  async function toText(ctype, buf) {
    const head = new Uint8Array(buf.slice(0, 5));
    if (ctype.includes('pdf') || String.fromCharCode(...head) === '%PDF-') { const p = await pdfText(buf, 200); return { title: p.title, text: p.text, kind: 'application/pdf' }; }
    const s = new TextDecoder('utf-8').decode(buf);
    if (ctype.includes('html') || /^\s*<(!doctype|html)/i.test(s.slice(0, 40))) { const h = htmlToText(s); return { title: h.title, text: h.text, kind: 'text/html', raw: s }; }
    return { title: '', text: s, kind: ctype || 'text/plain' };
  }
  async function webFetch(url, offset, length) {
    url = String(url || '').trim(); if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    offset = Math.max(0, +offset || 0); length = Math.max(1000, Math.min(+length || 12000, 40000));
    let hit = fetchCache.get(url);
    if (!hit || Date.now() - hit.t > 1800e3) {
      let g = await relayGet(url), t = await toText(g.ctype, g.buf);
      if (t.kind === 'text/html' && t.text.length < 600) {   // thin wrapper pages (e.g. LCSC datasheet viewers): follow the embedded PDF
        const pdfs = (t.raw.match(/(?:https?:)?\/\/[^"'\s<>]+?\.pdf(?:\?[^"'\s<>]*)?/g) || []).map(u => u.startsWith('http') ? u : 'https:' + u).filter(u => u.split('?')[0] !== g.final.split('?')[0] && !u.includes('viewer.html'));
        if (pdfs.length) { g = await relayGet(pdfs[0].replace(/&amp;/g, '&')); t = await toText(g.ctype, g.buf); }
      }
      hit = { t: Date.now(), url: g.final, title: t.title, text: t.text, type: t.kind };
      fetchCache.set(url, hit); if (fetchCache.size > 60) fetchCache.delete(fetchCache.keys().next().value);
    }
    return { url: hit.url, title: hit.title, content_type: hit.type, total_chars: hit.text.length, offset, more: offset + length < hit.text.length, text: hit.text.slice(offset, offset + length) };
  }

  // ---------- chat attachments ----------
  async function extract(name, buf) {
    const MAX = 400000, head = String.fromCharCode(...new Uint8Array(buf.slice(0, 5)));
    let text, pages = null;
    if (/\.pdf$/i.test(name) || head === '%PDF-') { const p = await pdfText(buf); text = p.text; pages = p.pages; }
    else if (/\.docx$/i.test(name)) return { name, text: '', error: 'Word files are read by the desktop version (server.py). In the web version, save the document as PDF and attach that.' };
    else { if (new Uint8Array(buf.slice(0, 4096)).includes(0)) return { name, text: '', binary: true }; text = new TextDecoder('utf-8').decode(buf); }
    text = text.replace(/[ \t]+\n/g, '\n');
    return { name, text: text.slice(0, MAX), chars: text.length, truncated: text.length > MAX, pages };
  }

  // ---------- router ----------
  async function handle(method, url, init, req) {
    const p = url.pathname, q = url.searchParams;
    const bodyText = async () => req ? req.text() : (init && init.body != null ? (typeof init.body === 'string' ? init.body : await new Response(init.body).text()) : '');
    const bodyJson = async () => { const t = await bodyText(); return t ? JSON.parse(t) : null; };
    const bodyBuf = async () => req ? req.arrayBuffer() : new Response(init && init.body).arrayBuffer();
    const header = k => { const h = new Headers((req && req.headers) || (init && init.headers) || {}); return h.get(k); };
    if (p === '/api/version' || p === '/llm-proxy/_ping') return json({ error: 'not running with server.py' }, 404);
    if (p.startsWith('/llm-cloud/ollama')) {   // Ollama Cloud through the relay (keeps streaming responses)
      const target = needRelay() + '/ollama' + p.slice('/llm-cloud/ollama'.length) + url.search;
      return realFetch(target, { method, headers: (req && req.headers) || (init && init.headers), body: method === 'GET' || method === 'HEAD' ? undefined : await bodyBuf(), signal: (init && init.signal) || (req && req.signal) });
    }
    if (p.startsWith('/llm-ext/')) {   // OpenAI-compatible providers that refuse browser requests, through the relay
      return realFetch(needRelay() + '/llm/' + p.slice('/llm-ext/'.length) + url.search, { method, headers: (req && req.headers) || (init && init.headers), body: method === 'GET' || method === 'HEAD' ? undefined : await bodyBuf(), signal: (init && init.signal) || (req && req.signal) });
    }
    if (p.startsWith('/llm-proxy/')) return json({ error: 'Local model servers are reached directly in the web version' }, 404);
    const seg = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent);   // ['projects', id, 'meta'] …
    if (seg[0] === 'projects') return json(await projects(method, seg.slice(1), method === 'PUT' || method === 'POST' ? await bodyJson() : null));
    if (seg[0] === 'library') return json(await library(method, seg[1], method === 'PUT' || method === 'POST' ? await bodyJson() : null));
    if (p === '/api/parts/search') return json(await partsSearch(q.get('q'), q.get('limit')));
    if (p === '/api/parts/local') return json({ source: 'local', results: await searchLocal(q.get('q'), +q.get('limit') || 50) });
    if (p === '/api/parts/stats') return json({ parts: (await dbAll('parts')).length, models: (await dbAll('models')).length, path: 'this browser (IndexedDB)' });
    if (p.startsWith('/api/parts/get/')) return json(await getPart(seg[seg.length - 1]));
    if (p === '/api/web/search') return json(await webSearch(q.get('q'), q.get('n'), header('x-brave-key')));
    if (p === '/api/web/fetch') return json(await webFetch(q.get('url'), q.get('offset'), q.get('length')));
    if (p === '/api/extract' && method === 'POST') return json(await extract(q.get('name') || 'file', await bodyBuf()));
    if (p.startsWith('/api/knowledge/')) throw httpError(400, 'Knowledge folders read files on your computer, so they need the desktop version (server.py). In the web version, attach the documents in the chat instead.');
    throw httpError(404, 'unknown endpoint ' + p);
  }

  window.fetch = async function (input, init) {
    const req = typeof Request !== 'undefined' && input instanceof Request ? input : null;
    let url; try { url = new URL(req ? req.url : String(input), location.href); } catch (e) { return realFetch(input, init); }
    if (url.origin !== location.origin || !/^\/(api|llm-cloud|llm-proxy|llm-ext)\//.test(url.pathname)) return realFetch(input, init);
    if ((await detect()) === 'server') return realFetch(input, init);
    const method = String((init && init.method) || (req && req.method) || 'GET').toUpperCase();
    try { return await handle(method, url, init, req); }
    catch (e) { return json({ error: e.message || String(e) }, e.status || 500); }
  };
  window.CPStatic = { detect, get mode() { return mode; }, relayBase };
})();
