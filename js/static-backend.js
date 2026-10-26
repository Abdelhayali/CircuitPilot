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
  // Opened at whatever version exists (never forcing an upgrade an older CircuitPilot tab could block), upgraded only
  // when a store is missing; a blocked or broken open gives up after a few seconds instead of hanging every request.
  // The parts archive lives in its own database, so adding it never needs an upgrade here.
  const DBS = { circuitpilot: [['projects', 'id'], ['library', 'key'], ['parts', 'lcsc'], ['models', 'lcsc'], ['footprints', 'lcsc']], 'circuitpilot-archive': [['archive', 'kind']] };
  const dbps = {};
  function openDb(name) {
    if (!dbps[name]) dbps[name] = new Promise((res, rej) => {
      const go = ver => {
        const r = ver ? indexedDB.open(name, ver) : indexedDB.open(name);
        const timer = setTimeout(() => rej(new Error('Browser storage is busy — close other CircuitPilot tabs (or reload them), then reload this page')), 4000);
        r.onupgradeneeded = () => { const d = r.result; for (const [s, k] of DBS[name]) if (!d.objectStoreNames.contains(s)) d.createObjectStore(s, { keyPath: k }); };
        r.onsuccess = () => {
          clearTimeout(timer); const d = r.result;
          if (DBS[name].some(([s]) => !d.objectStoreNames.contains(s))) { const v = d.version + 1; d.close(); go(v); return; }
          d.onversionchange = () => { d.close(); delete dbps[name]; };   // let a newer CircuitPilot tab upgrade
          res(d);
        };
        r.onerror = () => { clearTimeout(timer); rej(r.error || new Error('Browser storage is unavailable')); };
      };
      go(0);
    }).catch(e => { delete dbps[name]; throw e; });
    return dbps[name];
  }
  async function tx(store, fn, write) {
    const d = await openDb(store === 'archive' ? 'circuitpilot-archive' : 'circuitpilot');
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
  // EasyEDA library (about 1.6 M LCSC parts with symbol + footprint): same rules as partsdb.py
  const brand = t => String(t || '').replace(/\([^)]*[\u4e00-\u9fff][^)]*\)/g, '').trim();
  function eeRow(x) {
    const a = x.attributes || {}, code = String(a['Supplier Part'] || x.product_code || '').trim().toUpperCase();
    const fp = (x.footprint || {}).display_title || a['Supplier Footprint'] || 'footprint';
    return { lcsc: code, mfr_part: a['Manufacturer Part'] || x.display_title, brand: brand(a.Manufacturer), package: a['Supplier Footprint'] || fp, category: '',
      description: String(a['LCSC Part Name'] || x.description || '').slice(0, 300), stock: null, basic: a['JLCPCB Part Class'] === 'Basic Part' ? 1 : 0, price: null,
      datasheet: a.Datasheet, footprint: a.Footprint ? fp : '' };
  }
  const form = pairs => pairs.map(([k, v]) => encodeURIComponent(k) + '=' + encodeURIComponent(v)).join('&');
  const postForm = (path, pairs) => realFetch(needRelay() + path, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(pairs), signal: AbortSignal.timeout(12000) })
    .then(r => { if (!r.ok) throw new Error('EasyEDA library request failed (' + r.status + ')'); return r.json(); });
  const NO_FP_TTL = 7 * 86400;
  // {code: footprint name, '' = none in the library, null = could not be checked}
  async function footprints(codes) {
    codes = [...new Set(codes.filter(Boolean))];
    const out = {}, now = Date.now() / 1000;
    const known = await Promise.all(codes.map(c => dbGet('footprints', c).catch(() => null)));
    codes.forEach((c, i) => { const r = known[i]; if (r && (r.footprint || now - r.updated < NO_FP_TTL)) out[c] = r.footprint; });
    const todo = codes.filter(c => !(c in out));
    for (let i = 0; i < todo.length; i += 50) {
      const part = todo.slice(i, i + 50);
      try {
        const j = await postForm('/easyeda/codes', part.map(c => ['codes[]', c])), found = {};
        for (const x of (j && j.result) || []) { const r = eeRow(x); if (r.footprint) found[r.lcsc] = r.footprint; }
        for (const c of part) out[c] = found[c] || '';
        dbPutMany('footprints', part.map(c => ({ lcsc: c, footprint: out[c], updated: now }))).catch(() => { });
      } catch (e) { for (const c of part) out[c] = null; }
    }
    return out;
  }
  // EasyEDA community library: parts drawn by EasyEDA users (keys EE-<uuid>); only ones with a footprint attached
  async function searchCommunity(q, limit) {
    const j = await postForm('/easyeda/community', [['type', 3], ['doctype[]', 2], ['returnListStyle', 'classifyarr'], ['wd', q], ['uid', 'user'], ['page', 1]]);
    const out = [];
    for (const x of ((((j || {}).result || {}).lists || {}).user) || []) {
      const head = ((x.dataStr || {}).head) || {}, para = head.c_para || {};
      if (!head.puuid || !/^[0-9a-f]{32}$/.test(x.uuid || '')) continue;
      const sup = para['Supplier Part'] || '';
      out.push({ lcsc: 'EE-' + x.uuid.toUpperCase(), mfr_part: para['Manufacturer Part'] || x.title, brand: brand(para.Manufacturer), package: para.package || '', category: '',
        description: String(x.description || x.title || '').slice(0, 300), stock: null, basic: 0, price: null, datasheet: para.link, footprint: para.package || 'footprint',
        author: (x.owner || {}).username || '', supplier_part: /^C\d+$/.test(sup) ? sup : '' });
      if (out.length >= limit) break;
    }
    return out;
  }
  async function searchLocal(q, limit = 50) {
    const words = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const all = await dbAll('parts'), none = new Set((await dbAll('footprints').catch(() => [])).filter(f => f.footprint === '').map(f => f.lcsc));
    return all.filter(p => { if (none.has(p.lcsc)) return false; const t = [p.lcsc, p.mfr_part, p.description, p.package, p.category].join(' ').toLowerCase(); return words.every(w => t.includes(w)); })
      .sort((a, b) => (b.stock || 0) - (a.stock || 0)).slice(0, limit);
  }
  // ---------- Basic Parts Archive: basic + preferred JLCPCB parts (~1.3 MB CSV, daily snapshot by
  // github.com/CDFER/jlcpcb-parts-database from github.com/yaqwsx/jlcparts), kept in this browser so part search
  // still works when the live JLCPCB search does not. The full Parts Archive (~360 MB) is desktop only.
  const ARCH_URL = 'https://cdfer.github.io/jlcpcb-parts-database/jlcpcb-components-basic-preferred.csv';
  let archRows = null;
  function parseCsv(text) {
    const rows = []; let row = [], f = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(f); f = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(f); f = ''; if (row.length > 1) rows.push(row); row = []; }
      else f += ch;
    }
    if (f || row.length) { row.push(f); rows.push(row); }
    const head = rows.shift() || [];
    return rows.map(r => Object.fromEntries(head.map((h, i) => [h, r[i] || ''])));
  }
  async function archiveRows() {
    if (archRows) return archRows;
    const rec = await dbGet('archive', 'basic').catch(() => null); if (!rec) return null;
    archRows = parseCsv(rec.text).map(r => Object.assign(r, { _text: [r.lcsc, 'c' + r.lcsc, r.mfr, r.package, r.manufacturer, r.description, r.category, r.subcategory].join(' ').toLowerCase() }));
    return archRows;
  }
  // ---------- full Parts Archive (web): CircuitPilot's compact copy of every JLCPCB part in stock, published with the
  // website by .github/workflows/pages.yml (data/parts-archive.tsv.gz, ~12 MB). Kept compressed in this browser and
  // searched as one text: lines are "lcsc  mfr  package  manufacturer  class  stock  price  category  description",
  // sorted Basic → Preferred → stock, so the first matches are the best ones.
  const FULL_URL = 'data/parts-archive.tsv.gz';
  let fullText = null, fullLoading = null;
  async function fullArchiveText() {
    if (fullText) return fullText;
    if (!fullLoading) fullLoading = (async () => {
      const rec = await dbGet('archive', 'full').catch(() => null); if (!rec) return null;
      const t = await new Response(rec.blob.stream().pipeThrough(new DecompressionStream('gzip'))).text();
      fullText = t; return t;
    })().finally(() => { fullLoading = null; });
    return fullLoading;
  }
  async function downloadFull() {
    const r = await realFetch(FULL_URL, { cache: 'no-cache' }); if (!r.ok) throw httpError(502, 'Could not download the Parts Archive (' + r.status + ')');
    const blob = await r.blob(), meta = await realFetch('data/parts-archive.json', { cache: 'no-cache' }).then(x => x.json()).catch(() => ({}));
    await dbPut('archive', { kind: 'full', blob, updated: Date.now(), parts: meta.parts || null, built: meta.built || '' });
    fullText = null; const t = await fullArchiveText();
    return { started: true, done: true, parts: meta.parts || (t.match(/\n/g) || []).length };
  }
  const esc = w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  function scanFull(text, words, limit) {
    const out = [], codes = words.filter(w => /^c\d{1,10}$/.test(w));
    if (codes.length && codes.length === words.length) {   // LCSC numbers: the line that starts with the number
      for (const c of codes) { const i = text.startsWith(c.slice(1) + '\t') ? 0 : text.indexOf('\n' + c.slice(1) + '\t'); if (i >= 0) { const st = i ? i + 1 : 0, e = text.indexOf('\n', st); out.push(text.slice(st, e < 0 ? undefined : e)); } }
      return out;
    }
    const anchor = words.reduce((a, b) => (b.length > a.length ? b : a)), re = new RegExp(esc(anchor), 'gi');
    let m;
    while (out.length < limit && (m = re.exec(text))) {
      const st = text.lastIndexOf('\n', m.index) + 1, e = text.indexOf('\n', m.index), line = text.slice(st, e < 0 ? undefined : e);
      const low = ('c' + line).toLowerCase();
      if (words.every(w => low.includes(w))) out.push(line);
      re.lastIndex = e < 0 ? text.length : e + 1;
    }
    return out;
  }
  function fullRow(line) {
    const [lcsc, mfr, pkg, man, cls, stock, price, cat, desc] = line.split('\t');
    return { lcsc: 'C' + lcsc, mfr_part: mfr, brand: man, package: pkg, category: cat || '', description: desc || '', stock: +stock || 0,
      basic: cls === 'b' ? 1 : 0, preferred: cls === 'p' ? 1 : 0, price: price ? +price : null, datasheet: '', sources: ['archive'] };
  }
  async function archiveDownload(kind) {
    if (kind === 'full') return downloadFull();
    const r = await realFetch(ARCH_URL); if (!r.ok) throw httpError(502, 'Could not download the Basic Parts Archive (' + r.status + ')');
    const text = await r.text(); await dbPut('archive', { kind: 'basic', text, updated: Date.now() }); archRows = null;
    return { started: true, done: true, parts: (await archiveRows()).length };
  }
  async function archiveStatus() {
    const rec = await dbGet('archive', 'basic').catch(() => null);
    return { basic: Object.assign({ name: 'Basic Parts Archive', size_about: '~1.3 MB', present: !!rec }, rec ? { size: rec.text.length, updated: new Date(rec.updated).toISOString().slice(0, 16).replace('T', ' '), parts: (await archiveRows()).length } : {}),
      full: await (async () => { const f = await dbGet('archive', 'full').catch(() => null);
        return Object.assign({ name: 'Parts Archive', size_about: '~12 MB download' }, f ? { present: true, updated: (f.built || new Date(f.updated).toISOString().slice(0, 16).replace('T', ' ')), parts: f.parts } : { present: false }); })() };
  }
  const priceOf = s => { const m = /^\s*\d+-\d*:([\d.]+)/.exec(s || ''); return m ? +m[1] : null; };
  async function archiveSearch(q, limit) {
    const words = String(q || '').toLowerCase().split(/[\s,]+/).filter(Boolean); if (!words.length) return [];
    const full = await fullArchiveText().catch(() => null);
    if (full) return scanFull(full, words, limit).map(fullRow);   // the full archive covers the basic one
    const rows = await archiveRows(); if (!rows) return [];
    return rows.filter(r => words.every(w => r._text.includes(w))).sort((a, b) => (a.library_type !== 'base') - (b.library_type !== 'base') || (+b.stock || 0) - (+a.stock || 0)).slice(0, limit)
      .map(r => ({ lcsc: 'C' + r.lcsc, mfr_part: r.mfr, brand: r.manufacturer, package: r.package, category: [r.category, r.subcategory].filter(Boolean).join(' / '), description: String(r.description || '').slice(0, 300), stock: +r.stock || 0,
        basic: r.library_type === 'base' ? 1 : 0, preferred: +r.preferred ? 1 : 0, price: priceOf(r.price), datasheet: r.datasheet, sources: ['archive-basic'] }));
  }

  // JLCPCB catalogue + EasyEDA library + community, merged by LCSC number; parts without a footprint are left out
  const SLOW_SOURCE = 3500, recent = new Map();   // a database that has not answered in 3.5 s is skipped; repeats come from memory for 10 min
  async function partsSearch(q, limit) {
    q = String(q || '').trim(); if (!q) return { source: 'none', results: [] };
    limit = Math.max(1, Math.min(+limit || 20, 100));
    needRelay();
    const ck = q.toLowerCase() + '|' + limit, hit = recent.get(ck);
    if (hit && Date.now() - hit.t < 600000) return hit.out;
    const errors = [], t0 = Date.now();
    const within = (p, name, extra = 0) => new Promise(res => {
      const timer = setTimeout(() => { errors.push(`${name}: no answer within ${SLOW_SOURCE / 1000} s, skipped`); res([]); }, Math.max(300, SLOW_SOURCE + extra - (Date.now() - t0)));
      p.then(v => { clearTimeout(timer); res(v); }, e => { clearTimeout(timer); errors.push(name + ': ' + e.message); res([]); });
    });
    const pj = realFetch(needRelay() + '/jlcpcb/search', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keyword: q, currentPage: 1, pageSize: limit }) })
      .then(async r => { if (!r.ok) throw new Error('JLCPCB search failed (' + r.status + ')'); const j = await r.json(); return ((((j || {}).data || {}).componentPageInfo || {}).list || []).map(row).filter(x => x.lcsc); });
    const pe = postForm('/easyeda/search', [['wd', q], ['page', 1], ['pageSize', limit]])
      .then(j => ((((j || {}).result || {}).lists || {}).lcsc || []).map(eeRow).filter(r => /^C\d{1,12}$/.test(r.lcsc)));
    const pc = searchCommunity(q, limit);
    // the footprint check of the JLCPCB results starts as soon as they arrive, while the libraries are still answering
    const jlcP = within(pj, 'JLCPCB', 4000);
    let fpP = jlcP.then(rows => footprints(rows.map(r => r.lcsc)));
    let [jlc, ee, com] = await Promise.all([jlcP, within(pe, 'EasyEDA'), within(pc, 'EasyEDA community')]);
    // Basic Parts Archive: when the live search failed and there is no copy yet, fetch one now (if reachable)
    if (!jlc.length && !(await archiveRows())) await archiveDownload('basic').catch(() => null);
    const seenJ = new Set(jlc.map(r => r.lcsc));
    const arch = (await archiveSearch(q, limit).catch(() => [])).filter(r => !seenJ.has(r.lcsc)).slice(0, jlc.length ? Math.max(Math.floor(limit / 3), limit - jlc.length) : limit);
    jlc = jlc.concat(arch);
    if (arch.length) { const base = fpP; fpP = Promise.all([base, footprints(arch.map(r => r.lcsc))]).then(([a, b]) => Object.assign({}, a, b)); }
    if (!jlc.length && !ee.length && !com.length && errors.length) return { source: 'local', error: errors.join('; '), results: await searchLocal(q, limit) };
    const inEe = new Map(ee.map(r => [r.lcsc, r.footprint]));
    const fp = Object.assign(await fpP, Object.fromEntries(inEe));
    let dropped = 0;
    const keep = [];
    for (const r of jlc) { const f = fp[r.lcsc]; if (f === '') { dropped++; continue; } const src = r.sources || ['jlcpcb']; keep.push(Object.assign({}, r, { footprint: f, sources: inEe.has(r.lcsc) ? src.concat('easyeda') : src })); }
    const seen = new Set(jlc.map(r => r.lcsc)), norm = t => String(t || '').toLowerCase().replace(/[^0-9a-z.]+/g, ''), words = q.split(/\s+/).map(norm).filter(Boolean), extra = [];
    for (const r of ee) {
      if (seen.has(r.lcsc)) continue;
      const text = norm([r.lcsc, r.mfr_part, r.brand, r.package, r.description, r.footprint].join(' '));
      if (!words.every(w => text.includes(w))) continue;   // the library search is loose; library-only extras must contain every word
      if (!r.footprint) { dropped++; continue; }
      extra.push(Object.assign({}, r, { sources: ['easyeda'], note: 'EasyEDA library part, not in the JLCPCB results: ' + (r.lcsc.startsWith('C99') ? 'placeholder code, not sold by LCSC' : 'check LCSC / JLCPCB stock') }));
    }
    const community = com.filter(r => { const t = norm([r.mfr_part, r.brand, r.package, r.description].join(' ')); return words.every(w => t.includes(w)); })
      .map(r => Object.assign({}, r, { sources: ['community'], note: 'EasyEDA community part by ' + (r.author || 'a user') + ': placed as a custom part (check the footprint against the datasheet)' }));
    // official-library parts get at least a third of the list, community parts at least a fifth
    const nCom = Math.min(community.length, Math.max(limit - keep.length - extra.length, Math.floor(limit / 5)));
    const nExtra = Math.min(extra.length, Math.max(limit - keep.length - nCom, Math.floor(limit / 3)));
    const rows = keep.slice(0, limit - nExtra - nCom).concat(extra.slice(0, nExtra), community.slice(0, nCom)), now = Date.now() / 1000;
    dbPutMany('footprints', ee.map(r => ({ lcsc: r.lcsc, footprint: r.footprint, updated: now }))).catch(() => { });
    dbPutMany('parts', keep.map(x => Object.assign({ updated: now }, x))).catch(() => { });
    const out = { source: [jlc.some(r => !r.sources) && 'jlcpcb', arch.length && 'archive', ee.length && 'easyeda', com.length && 'community'].filter(Boolean).join('+'), results: rows, removed_without_footprint: dropped };
    if (errors.length) out.error = errors.join('; ');
    else { recent.set(ck, { t: Date.now(), out }); if (recent.size > 200) recent.delete(recent.keys().next().value); }
    return out;
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
    return { name: pkg.title || 'footprint', pads: out, body: [r4(Math.min(...bx), 3), r4(Math.min(...by), 3), r4(Math.max(...bx), 3), r4(Math.max(...by), 3)], model3d: model3d(ds.shape || [], ox, oy) };
  }
  // the footprint's 3D model (EasyEDA library OBJ): offset from the pad centre in mm (y down), bottom height, rotation (same as partsdb.py)
  function model3d(shapes, ox, oy) {
    for (const s of shapes) {
      if (!s.startsWith('SVGNODE~')) continue;
      let n; try { n = JSON.parse(s.slice(8)); } catch (e) { continue; }
      const a = n.attrs || {};
      if (a.c_etype !== 'outline3D' || !/^[0-9a-f]{32}$/.test(a.uuid || '')) continue;
      let [x, y] = String(a.c_origin || '0,0').split(',').map(num), w = null, h = null;
      const rot = String(a.c_rotation || '0,0,0').split(',').map(num), pts = [];
      for (const c of n.childNodes || []) { const v = String((c.attrs || {}).points || '').trim().split(/\s+/).map(num); for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]); }
      if (pts.length) {   // the drawn outline is where the model really sits (c_origin is wrong on some footprints)
        const bx = pts.map(p => p[0]), by = pts.map(p => p[1]);
        x = (Math.min(...bx) + Math.max(...bx)) / 2; y = (Math.min(...by) + Math.max(...by)) / 2; w = r4((Math.max(...bx) - Math.min(...bx)) * U, 3); h = r4((Math.max(...by) - Math.min(...by)) * U, 3);
      }
      return { uuid: a.uuid, x: r4((x - ox) * U), y: r4(((y || 0) - oy) * U), z: r4(num(a.z) * U), rx: rot[0] || 0, ry: rot[1] || 0, rz: rot[2] || 0, w, h, title: a.title || '' };
    }
    return null;
  }
  function symbolPins(ds, fp) {
    const head = ds.head || {};
    const pins = parsePins(ds.shapes, num(head.x), num(head.y)), order = { L: 0, T: 1, R: 2, B: 3 }, seen = new Set(), uniq = [];
    pins.sort((a, b) => (order[a.side] - order[b.side]) || ((a.side === 'T' || a.side === 'B' ? a.x - b.x : a.y - b.y)) || (a.y - b.y));
    for (const p of pins) if (!seen.has(p.num)) { seen.add(p.num); uniq.push({ num: p.num, name: p.name, side: p.side }); }
    if (!uniq.length && fp) [...new Set(fp.pads.map(p => p.num))].forEach((n, i) => uniq.push({ num: n, name: n, side: i % 2 ? 'R' : 'L' }));   // symbol without readable pins
    return uniq;
  }
  // EasyEDA community part: symbol document + its footprint document (same EasyEDA Standard format as LCSC parts)
  async function getCommunity(key) {
    const get = async u => { const r = await realFetch(needRelay() + '/easyeda/doc/' + u, { signal: AbortSignal.timeout(15000) }); const j = await r.json().catch(() => ({})); return j && j.success ? j.result : null; };
    const r = await get(key.slice(3).toLowerCase());
    if (!r) throw httpError(404, `EasyEDA community part ${key} not found`);
    const ds = r.dataStr || {}, head = ds.head || {}, para = head.c_para || {};
    if (!head.puuid) throw httpError(404, `EasyEDA community part ${key} has no footprint`);
    const fp = parseFootprint((await get(head.puuid)) || {});
    if (!fp) throw httpError(404, `The footprint of EasyEDA community part ${key} has no pads`);
    let shapes = (ds.shape || []).slice();
    for (const sp of r.subparts || []) shapes = shapes.concat(((sp.dataStr || {}).shape) || []);
    const sup = /^C\d+$/.test(para['Supplier Part'] || '') ? para['Supplier Part'] : '', owner = (r.owner || {}).username || '';
    const model = { key, lcsc: sup, custom: !sup, name: para.name || r.title, mfr_part: para['Manufacturer Part'], manufacturer: para.Manufacturer, package: para.package,
      prefix: String(para.pre || 'U?').replace(/\?+$/, '') || 'U', value: para.Value || para['Manufacturer Part'] || r.title,
      pins: symbolPins({ head, shapes }, fp), footprint: fp, datasheet: para.link,
      source: 'EasyEDA community library' + (owner ? ` (by ${owner})` : '') + ' — check the footprint against the datasheet', no_uuid: true };
    dbPut('models', { lcsc: key, data: model, updated: Date.now() / 1000 }).catch(() => { });
    return model;
  }
  async function getPart(code) {
    const lcsc = String(code || '').trim().toUpperCase();
    const community = /^EE-[0-9A-F]{32}$/.test(lcsc);
    if (!community && !/^C\d{1,10}$/.test(lcsc)) throw httpError(400, `"${lcsc}" is not an LCSC part number (e.g. C2838502) or an EasyEDA community key (EE-…)`);
    const cached = await dbGet('models', lcsc).catch(() => null);
    if (community) { if (cached) return cached.data; return getCommunity(lcsc); }
    if (cached && cached.data && (cached.data.uuid || cached.data.no_uuid) && (!cached.data.footprint || 'model3d' in cached.data.footprint)) return cached.data;
    const res = await realFetch(needRelay() + '/easyeda/components/' + lcsc, { signal: AbortSignal.timeout(15000) });
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
    // a Brave key would have to go through the relay (Brave refuses browser requests): desktop version only
    if (braveKey && false) {
      const r = await realFetch(base + '/brave?' + new URLSearchParams({ q, count: n }), { headers: { 'x-brave-key': braveKey } });
      const j = await r.json(); if (!r.ok) throw httpError(502, (j && j.error) || 'Brave search failed');
      return { engine: 'brave', query: q, results: (((j.web || {}).results) || []).slice(0, n).map(x => ({ title: x.title || '', url: x.url || '', snippet: String(x.description || '').replace(/<[^>]+>/g, '') })) };
    }
    const r = await realFetch(base + '/ddg?' + new URLSearchParams({ q }));
    if (!r.ok) throw httpError(502, 'DuckDuckGo search failed (' + r.status + ') — try again (a Brave Search key works in the desktop version)');
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
    // API keys never go through a CircuitPilot server: providers that refuse browser requests (Ollama Cloud, NVIDIA …)
    // work only in the desktop version, where requests leave from the user's own PC
    if (p.startsWith('/llm-cloud/') || p.startsWith('/llm-ext/')) return json({ error: 'This provider does not accept requests from web pages. In CircuitPilot on the web, API keys only go straight to the provider, never through our servers — use this provider in the desktop version.' }, 403);
    if (p.startsWith('/llm-proxy/')) return json({ error: 'Local model servers are reached directly in the web version' }, 404);
    const seg = p.split('/').filter(Boolean).slice(1).map(decodeURIComponent);   // ['projects', id, 'meta'] …
    if (seg[0] === 'projects') return json(await projects(method, seg.slice(1), method === 'PUT' || method === 'POST' ? await bodyJson() : null));
    if (seg[0] === 'library') return json(await library(method, seg[1], method === 'PUT' || method === 'POST' ? await bodyJson() : null));
    if (p === '/api/parts/search') return json(await partsSearch(q.get('q'), q.get('limit')));
    if (p === '/api/parts/local') return json({ source: 'local', results: await searchLocal(q.get('q'), +q.get('limit') || 50) });
    if (p === '/api/parts/archive' && method !== 'POST') return json(await archiveStatus());
    if (p === '/api/parts/archive/download') return json(await archiveDownload(q.get('kind') || 'basic'));
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
