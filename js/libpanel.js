'use strict';
// Library panel (like EasyEDA's): a floating window that searches every parts source at once and shows each part's
// symbol and footprint beside the results. Place with the button or a double-click, or drag a row onto the schematic.
// It does not cover the canvas with a backdrop, so parts can be dragged out of it; move it by its title bar.
const LibPanel = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const SOURCES = [['all', 'All'], ['jlcpcb', 'JLCPCB'], ['easyeda', 'EasyEDA lib'], ['community', 'Community'], ['archive', 'Archive'], ['open', 'KiCad / open libs'], ['mine', 'My Library'], ['builtin', 'Built-in']];
  let el = null, rows = [], sel = -1, filter = 'all', timer = null, seq = 0, loading = false, error = '', lim = 60, full = false;
  const models = new Map();   // preview cache: row id -> part definition (or a promise)

  // ---------- drag & drop: rows here and in the left palette carry { kind, id } ----------
  const DND = 'application/x-circuitpilot-part';
  function dragData(e, kind, id) { e.dataTransfer.setData(DND, JSON.stringify({ kind, id })); e.dataTransfer.setData('text/plain', id); e.dataTransfer.effectAllowed = 'copy'; }
  function readDrag(e) { try { return JSON.parse(e.dataTransfer.getData(DND)); } catch (err) { return null; } }

  function build() {
    el = document.createElement('div');
    el.id = 'libPanel'; el.className = 'libpanel hidden';
    el.innerHTML = `<div class="lp-head"><b>Library</b><input id="lpQ" placeholder="Search parts: ESP32-C3, AMS1117 3.3, USB-C 16pin, 10k 0603…" autocomplete="off">
        <span class="lp-hint muted small">double-click or drag to place</span><button id="lpClose" title="Close (Esc)">✕</button></div>
      <div class="lp-src">${SOURCES.map(([k, n]) => `<button data-src="${k}" class="${k === filter ? 'on' : ''}">${n}</button>`).join('')}<span id="lpCount" class="muted small"></span></div>
      <div class="lp-body"><div class="lp-list"><table><thead><tr><th>Part</th><th>Footprint / package</th><th>Source</th><th>Code</th><th>Stock</th><th>Price</th></tr></thead><tbody id="lpRows"></tbody></table><div id="lpMsg" class="muted small"></div></div>
        <div class="lp-prev"><div class="lp-cap">Symbol</div><svg id="lpSym"></svg><div class="lp-cap">Footprint <span id="lpFpName" class="muted"></span></div><svg id="lpFp"></svg>
          <div id="lpInfo" class="lp-info muted small">Select a part to see its symbol and footprint.</div>
          <div class="row"><button id="lpPlace" class="primary" disabled>Place</button><a id="lpDs" class="hidden" target="_blank" rel="noopener">Datasheet ↗</a></div></div></div>`;
    document.body.appendChild(el);
    $('#lpClose').onclick = close;
    $('#lpQ').addEventListener('input', () => { lim = 60; search(150); });
    $('#lpQ').addEventListener('keydown', e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'Enter') { if (sel >= 0) place(rows[sel]); else search(0); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); const v = visible(); if (!v.length) return; const i = Math.max(0, v.indexOf(sel)); select(v[Math.min(v.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]); }
    });
    el.querySelector('.lp-src').onclick = e => { const b = e.target.closest('[data-src]'); if (!b) return; filter = b.dataset.src; el.querySelectorAll('.lp-src button').forEach(x => x.classList.toggle('on', x === b)); renderRows(); };
    const tb = $('#lpRows');
    tb.onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) select(+tr.dataset.i); };
    tb.ondblclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) place(rows[+tr.dataset.i]); };
    tb.addEventListener('dragstart', e => { const tr = e.target.closest('tr[data-i]'); if (!tr) return; const r = rows[+tr.dataset.i]; dragData(e, r.kind, r.id); });
    $('#lpPlace').onclick = () => sel >= 0 && place(rows[sel]);
    // move by the title bar
    const head = el.querySelector('.lp-head');
    head.addEventListener('mousedown', e => {
      if (e.target.closest('input,button')) return;
      const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
      const mv = ev => { el.style.left = Math.max(0, Math.min(innerWidth - 80, ev.clientX - dx)) + 'px'; el.style.top = Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy)) + 'px'; el.style.right = 'auto'; };
      const up = () => { removeEventListener('mousemove', mv); removeEventListener('mouseup', up); };
      addEventListener('mousemove', mv); addEventListener('mouseup', up); e.preventDefault();
    });
  }

  function open(q) {
    if (!el) build();
    el.classList.remove('hidden');
    const inp = $('#lpQ'); if (q != null && q !== '') inp.value = q;
    inp.focus(); inp.select();
    if (inp.value.trim().length >= 2 && !rows.length) search(0); else if (!inp.value.trim()) renderRows();
  }
  function close() { if (!el) return; if (el.contains(document.activeElement)) document.activeElement.blur(); el.classList.add('hidden'); }
  const isOpen = () => !!el && !el.classList.contains('hidden');

  // ---------- search: database (JLCPCB + EasyEDA + community) + My Library + built-in symbols ----------
  function search(delay) {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = $('#lpQ').value.trim(), my = ++seq, ql = q.toLowerCase(), words = ql.split(/\s+/).filter(Boolean);
      const local = [];
      for (const p of Projects.myLib || []) if (words.every(w => `${p.name} ${p.value} ${p.key} ${p.mfr_part || ''} ${(p.footprint && p.footprint.name) || ''}`.toLowerCase().includes(w)))
        local.push({ kind: 'lib', id: p.key, src: 'mine', name: p.name, pkg: (p.footprint && p.footprint.name) || '', code: p.key, def: p });
      for (const t of Lib.types()) { const d = Lib.type(t); if (words.length && words.every(w => `${d.name} ${t}`.toLowerCase().includes(w))) { const db = Lib.dbDefault(t, null); local.push({ kind: 'type', id: t, src: 'builtin', name: d.name, pkg: db ? db.pkg : '', code: db ? db.lcsc : '' }); } }
      rows = local; sel = -1; error = ''; loading = q.length >= 2; renderRows();
      if (q.length < 2) return;
      const openP = OpenLib.search(q, 30).catch(() => []);
      try {
        const j = await AI.partsApi('search?q=' + encodeURIComponent(q) + '&limit=' + lim); full = j.results.length >= lim - 5;
        if (my !== seq) return;
        rows = local.concat(j.results.map(r => ({ kind: 'db', id: r.lcsc, src: (r.sources || ['jlcpcb'])[0], name: r.mfr_part || r.lcsc, brand: r.brand, pkg: r.footprint || r.package || '', code: /^EE-/.test(r.lcsc) ? (r.supplier_part || '') : r.lcsc,
          stock: r.stock, price: r.price, basic: r.basic, desc: r.description, note: r.note, author: r.author, datasheet: r.datasheet, srcs: r.sources || [] })));
        if (j.error) error = j.source === 'local' ? 'Offline: showing cached parts' : j.error;
      } catch (e) { if (my === seq) error = e.message; }
      const open = await openP; if (my !== seq) return;
      rows = rows.concat(open.map(r => ({ kind: 'db', id: r.key, src: 'open', name: r.name, brand: r.sourceName, pkg: r.footprint.split(':').pop(), code: r.mpn || '', desc: r.description, note: r.sourceName + ': custom part (no LCSC number) — check the footprint' })));
      loading = false; renderRows();
      const v = visible(); if (v.length) select(v[0]);
    }, delay);
  }
  // a part found in several sources is listed once but counts under each of their tabs
  const visible = () => rows.map((r, i) => i).filter(i => { const r = rows[i], all = [r.src].concat(r.srcs || []); return filter === 'all' || all.includes(filter) || (filter === 'archive' && all.some(s => /^archive/.test(s))); });
  const SRC_NAME = { archive: 'Archive', 'archive-basic': 'Archive', jlcpcb: 'JLCPCB', easyeda: 'EasyEDA lib', community: 'Community', open: 'Open lib', mine: 'My Library', builtin: 'Built-in' };
  function renderRows() {
    if (!el) return;
    const v = visible();
    $('#lpRows').innerHTML = v.map(i => {
      const r = rows[i], stock = r.src === 'jlcpcb' || /^archive/.test(r.src) ? `<span class="${r.stock > 0 ? 'good' : 'bad'}">${(r.stock || 0).toLocaleString()}</span>` : '<span class="muted">—</span>';
      return `<tr data-i="${i}" draggable="true" class="${i === sel ? 'on' : ''}" title="${esc([r.desc, r.note].filter(Boolean).join('\n'))}">
        <td><b>${esc(r.name)}</b>${r.basic ? ' <span class="badge basic">Basic</span>' : ''}${r.brand ? `<div class="muted small">${esc(r.brand)}</div>` : ''}</td>
        <td>${esc(r.pkg)}</td><td><span class="lp-tag lp-${r.src}">${SRC_NAME[r.src] || r.src}</span></td><td class="mono">${esc(r.code || '')}</td><td>${stock}</td>
        <td>${r.price != null ? '$' + (+r.price).toFixed(r.price < 0.1 ? 4 : 2) : ''}</td></tr>`;
    }).join('');
    $('#lpCount').textContent = rows.length ? `${v.length} of ${rows.length} parts${loading ? '…' : ''}` : '';
    const more = !loading && full && lim < 100 ? ' <button id="lpMore">More results</button>' : '';
    $('#lpMsg').innerHTML = (loading ? 'Searching JLCPCB, the EasyEDA library and the community library… <span class="spin"></span>' : error ? `<span class="bad">${esc(error)}</span>` : !v.length && $('#lpQ').value.trim().length >= 2 ? (filter === 'archive' ? 'Nothing in your parts archive. The Basic Parts Archive only has Basic + Preferred parts: download the full Parts Archive in ⚙ Settings → Parts archives.' : 'No parts with a footprint found here. Try another source tab or fewer words.') : '') + more;
    const mb = $('#lpMore'); if (mb) mb.onclick = () => { lim = 100; search(0); };
  }

  // ---------- preview: symbol + footprint ----------
  function modelOf(r) {
    if (r.def) return Promise.resolve(r.def);
    const k = r.kind + ':' + r.id;
    if (!models.has(k)) {
      const p = r.kind === 'type' ? builtinModel(r.id) : AI.loadPart(r.id);
      models.set(k, p.then(m => (models.set(k, Promise.resolve(m)), m), e => { models.delete(k); throw e; }));
    }
    return models.get(k);
  }
  // built-in symbols: the database part behind them when there is one, else the generic symbol + standard footprint
  async function builtinModel(t) {
    const d = Lib.type(t), db = Lib.dbDefault(t, null);
    let part = null; if (db) try { part = await AI.loadPart(db.lcsc); } catch (e) { }
    const c = { type: t }, fpn = Lib.fpsFor(c)[0], fp = part && part.footprint ? part.footprint : Lib.footprint(fpn);
    return { builtin: d, type: t, name: d.name, value: d.value, footprint: fp ? { name: (part && part.footprint && part.footprint.name) || fpn, pads: fp.pads, body: fp.body } : null, mfr_part: part && part.mfr_part, manufacturer: part && part.manufacturer, datasheet: part && part.datasheet, lcsc: db && db.lcsc, pins: d.pins(c) };
  }
  async function select(i) {
    sel = i;   // only move the highlight: re-rendering the rows would break a double-click on them
    el.querySelectorAll('#lpRows tr.on').forEach(t => t.classList.remove('on'));
    const r = rows[i]; if (!r) return;
    const tr = el.querySelector(`tr[data-i="${i}"]`); if (tr) { tr.classList.add('on'); tr.scrollIntoView({ block: 'nearest' }); }
    $('#lpPlace').disabled = false;
    $('#lpInfo').innerHTML = 'Loading symbol and footprint… <span class="spin"></span>'; $('#lpSym').innerHTML = ''; $('#lpFp').innerHTML = ''; $('#lpFpName').textContent = '';
    try {
      const m = await modelOf(r); if (sel !== i) return;
      drawSym(m); drawFp(m.footprint);
      const pins = m.builtin ? m.pins.length : (m.pins || []).length;
      $('#lpInfo').innerHTML = [`<b>${esc(m.name || r.name)}</b>`, m.mfr_part && m.mfr_part !== m.name ? esc(m.mfr_part) : '', m.manufacturer ? esc(m.manufacturer) : '',
        `${pins} pins · ${m.footprint ? m.footprint.pads.length + ' pads' : 'no footprint'}`, r.src === 'community' ? `Community part by ${esc(r.author || 'a user')}: check the footprint against the datasheet` : '', r.note && r.src !== 'community' ? esc(r.note) : ''].filter(Boolean).join('<br>');
      const ds = $('#lpDs'), url = m.datasheet || r.datasheet; ds.classList.toggle('hidden', !/^https?:/.test(url || '')); if (url) ds.href = url;
    } catch (e) { if (sel === i) $('#lpInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
  }
  function drawSym(m) {
    const svg = $('#lpSym');
    if (m.builtin) {   // generic symbol drawn like on the schematic
      const c = { type: m.type }, b = m.builtin.box(c), pad = 24;
      svg.setAttribute('viewBox', `${b[0] - pad} ${b[1] - pad} ${b[2] - b[0] + 2 * pad} ${b[3] - b[1] + 2 * pad}`);
      svg.innerHTML = `<g class="comp">${m.builtin.draw(c)}</g>`; return;
    }
    const { g, svg: body } = Lib.drawPart(m), pad = 30, tx = [];
    for (const p of g.pins) {
      const ax = p.x - p.dx * p.len;
      if (p.show) { tx.push(`<text class="pinname" x="${ax - p.dx * 4}" y="${p.y + 3}" text-anchor="${p.dx < 0 ? 'start' : 'end'}">${esc(p.name)}</text>`); tx.push(`<text class="pinnum" x="${(p.x + ax) / 2}" y="${p.y - 2}" text-anchor="middle">${esc(p.num)}</text>`); }
    }
    const w = 2 * (g.hw + 20) + 2 * pad, h = 2 * g.hh + 2 * pad;
    svg.setAttribute('viewBox', `${-w / 2} ${-h / 2} ${w} ${h}`);
    svg.innerHTML = `<g class="comp">${body}</g>${tx.join('')}<text class="ref" x="0" y="${-g.hh - 6}" text-anchor="middle">${esc((m.prefix || 'U') + '?')}</text><text class="val" x="0" y="${g.hh + 14}" text-anchor="middle">${esc(m.value || '')}</text>`;
  }
  function drawFp(f) {
    const svg = $('#lpFp');
    if (!f || !f.pads || !f.pads.length) { svg.removeAttribute('viewBox'); svg.innerHTML = ''; $('#lpFpName').textContent = 'none'; return; }
    const xs = f.pads.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = f.pads.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
    let b = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    if (f.body) b = [Math.min(b[0], f.body[0]), Math.min(b[1], f.body[1]), Math.max(b[2], f.body[2]), Math.max(b[3], f.body[3])];
    const m = Math.max(0.6, 0.12 * Math.max(b[2] - b[0], b[3] - b[1])), fs = Math.max(0.25, Math.min(...f.pads.map(p => Math.min(p.w, p.h))) * 0.55);
    svg.setAttribute('viewBox', `${b[0] - m} ${b[1] - m} ${b[2] - b[0] + 2 * m} ${b[3] - b[1] + 2 * m}`);
    const out = [];
    if (f.body) out.push(`<rect class="lp-body" x="${f.body[0]}" y="${f.body[1]}" width="${f.body[2] - f.body[0]}" height="${f.body[3] - f.body[1]}"/>`);
    for (const p of f.pads) {
      out.push(p.shape === 'round' ? `<circle class="lp-pad" cx="${p.x}" cy="${p.y}" r="${p.w / 2}"/>` : `<rect class="lp-pad" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : 0.03}"/>`);
      if (p.drill) out.push(`<circle class="lp-drill" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}"/>`);
    }
    if (f.pads.length <= 80) for (const p of f.pads) out.push(`<text class="lp-num" x="${p.x}" y="${p.y + fs * 0.35}" font-size="${fs}" text-anchor="middle">${esc(p.num)}</text>`);
    svg.innerHTML = out.join('');
    $('#lpFpName').textContent = `${f.name || ''} · ${f.pads.length} pads · ${(b[2] - b[0]).toFixed(2)} × ${(b[3] - b[1]).toFixed(2)} mm`;
  }

  function place(r, at) {
    if (!r) return;
    if (r.kind === 'db') App.placeDbPart(r.id, at);
    else if (r.kind === 'lib') App.placeLibPart(r.id, at);
    else App.placeBuiltin(r.id, at);
  }
  // drop target: the schematic canvas
  function initDrop(svg, toWorld) {
    svg.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes(DND)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; } });
    svg.addEventListener('drop', e => { const d = readDrag(e); if (!d) return; e.preventDefault(); place({ kind: d.kind, id: d.id }, toWorld(e.clientX, e.clientY)); });
  }
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && isOpen() && el.contains(document.activeElement)) close(); });

  return { open, close, isOpen, dragData, initDrop };
})();
