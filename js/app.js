'use strict';
// UI glue: panels, toolbar, properties, copilot chat, settings, files & exports.
const App = (() => {
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  let view = 'sch', mode = 'agent', running = false, lastError = null;

  function toast(msg, ms = 3200) {
    const t = $('#toast'); t.textContent = msg; t.classList.add('on');
    clearTimeout(toast._t); toast._t = setTimeout(() => t.classList.remove('on'), ms);
  }
  function download(name, data, type = 'text/plain') {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const fname = ext => (Model.S.name || 'design').replace(/[^\w.-]+/g, '_') + ext;

  // ---------- views ----------
  function showView(v) {
    view = v;
    $$('.tab').forEach(b => b.classList.toggle('active', b.dataset.view === v));
    $('#schSvg').classList.toggle('hidden', v !== 'sch'); $('#pcbSvg').classList.toggle('hidden', v !== 'pcb'); $('#encView').classList.toggle('hidden', v !== 'enc'); $('#docView').classList.toggle('hidden', v !== 'doc');
    $('#schTools').classList.toggle('hidden', v !== 'sch'); $('#pcbTools').classList.toggle('hidden', v !== 'pcb'); $('#encTools').classList.toggle('hidden', v !== 'enc'); $('#docTools').classList.toggle('hidden', v !== 'doc');
    PcbView.setVisible(v === 'pcb' && !Pcb3D.ui.on);
    $('#pcb3dView').classList.toggle('hidden', !(v === 'pcb' && Pcb3D.ui.on));
    if (v === 'enc') EncView.show(); else EncView.hide();
    if (v === 'doc') DocView.show(); else DocView.hide();
    const sb = document.getElementById('sheetBar'); if (sb) sb.classList.toggle('hidden', v !== 'sch');
    renderAll();
    if (v === 'pcb') { Pcb.vp.apply(); if (!showView._pcbFit) { Pcb.fit(); showView._pcbFit = true; } } else if (v === 'sch') Sch.vp.apply();
    revealSelection(v);
  }
  function renderAll() {
    if (view === 'sch') Sch.render(); else if (view === 'pcb') Pcb.render();
    renderStatus(); renderProps();
    $('#btnUndo').disabled = !Model.canUndo(); $('#btnRedo').disabled = !Model.canRedo();
    if (document.activeElement !== $('#projName')) $('#projName').value = Model.S.name || 'Untitled';
    $('#boardW').value = Model.S.board.w || ''; $('#boardH').value = Model.S.board.h || '';
  }
  function renderStatus() {
    const S = Model.S, erc = Model.erc(), e = erc.filter(i => i.level === 'error').length, w = erc.filter(i => i.level === 'warn').length;
    let s = `${S.components.length} parts · ${Object.keys(S.nets).length} nets · <span class="${e ? 'bad' : w ? 'warn' : 'good'}" id="ercLink" title="Click for ERC details">ERC: ${e} errors, ${w} warnings</span>`;
    const st = Pcb.status();
    if (st.placed && S.board.w) s += ` · PCB ${S.board.w}×${S.board.h} mm · <span class="${st.unrouted.length ? 'warn' : 'good'}">${st.routed}/${st.nets} routed</span> · ${st.vias} vias · ${st.trace_length_mm} mm copper`;
    if (Pcb.ui.drc) s += ` · <span class="${Pcb.ui.drc.errors ? 'bad' : Pcb.ui.drc.warnings ? 'warn' : 'good'}">DRC: ${esc(Pcb.ui.drc.summary)}</span>`;
    $('#status').innerHTML = s;
    $('#ercLink').onclick = () => {
      $('#props').innerHTML = '<div class="ph">ERC report</div>' + (erc.length ? '<ul class="erc">' + erc.map(i => `<li class="${i.level}">${esc(i.msg)}</li>`).join('') + '</ul>' : '<div class="muted">No issues 🎉</div>');
    };
  }

  // ---------- parts palette ----------
  const db = { q: '', loading: false, results: [], error: null, source: '' };
  let dbTimer = null, dbSeq = 0;
  function searchDb(q) {
    clearTimeout(dbTimer);
    if (q.trim().length < 2) { db.q = ''; db.results = []; db.error = null; renderParts(); return; }
    dbTimer = setTimeout(async () => {
      const seq = ++dbSeq; db.q = q; db.loading = true; db.error = null; renderParts();
      const open = OpenLib.search(q, 12).catch(() => []);
      try { const j = await AI.partsApi('search?q=' + encodeURIComponent(q) + '&limit=25'); if (seq !== dbSeq) return; db.results = j.results; db.source = j.source; db.error = j.source === 'local' && j.error ? 'Offline — showing cached parts' : null; }
      catch (e) { if (seq !== dbSeq) return; db.results = []; db.error = e.message; }
      db.open = await open; if (seq !== dbSeq) return;
      db.loading = false; renderParts();
    }, 350);
  }
  // where a new part goes: the drop point (snapped to the 10-unit grid) or the middle of the view
  function placePoint(at) {
    if (at) return { x: Math.round(at.x / 10) * 10, y: Math.round(at.y / 10) * 10 };
    const vb = Sch.vp.vb || [0, 0, 0, 0]; return { x: vb[0] + vb[2] / 2, y: vb[1] + vb[3] / 2 };
  }
  async function placeDbPart(code, at) {
    toast('Loading ' + code + '…', 8000);
    try {
      const m = await AI.loadPart(code);
      if (view !== 'sch') showView('sch');
      const key = m.key || m.lcsc, pt = placePoint(at);
      const c = Model.mutate(() => { if (!Model.S.lib[key]) Model.setLibPart(key, m); return Model.addComponent({ part: key, x: pt.x, y: pt.y, sheet: Sch.ui.sheet }); });
      Sch.select(c.ref); toast(`Added ${c.ref} · ${m.name} (${m.pins.length} pins, ${m.footprint ? m.footprint.pads.length + ' pads' : 'no footprint'})`);
    } catch (e) { toast('Could not load ' + code + ': ' + e.message, 6000); }
  }
  // palette parts come with the real JLCPCB part behind the symbol (falls back to a generated footprint offline)
  async function placeBuiltin(type, at) {
    const d = Lib.dbDefault(type, null);
    let part = null;
    if (d) { try { part = await AI.loadPart(d.lcsc); } catch (e) { toast('Parts database unavailable — using a generated footprint', 4000); } }
    if (view !== 'sch') showView('sch');
    const pt = placePoint(at);
    const c = Model.mutate(() => Model.addComponent({ type, x: pt.x, y: pt.y, dbPart: part, sheet: Sch.ui.sheet }));
    Sch.select(c.ref);
    if (c.pinMap) toast(`${c.ref}: ${part.name} · ${c.lcscPart} · ${part.footprint.name}`, 4000);
  }
  function placeLibPart(key, at) {
    const m = Projects.myLib.find(p => p.key === key) || Model.S.lib[key];
    if (!m) { toast('Part not found: ' + key); return; }
    if (view !== 'sch') showView('sch');
    const pt = placePoint(at);
    try {
      const c = Model.mutate(() => { if (!Model.S.lib[key]) Model.setLibPart(key, m); return Model.addComponent({ part: key, x: pt.x, y: pt.y, sheet: Sch.ui.sheet }); });
      Sch.select(c.ref); toast(`Added ${c.ref} · ${m.name}`);
    } catch (e) { toast(e.message); }
  }
  function renderMyLib(q) {
    const ps = Projects.myLib.filter(p => !q || `${p.name} ${p.value} ${p.key} ${p.mfr_part || ''}`.toLowerCase().includes(q));
    if (!ps.length) return q ? '' : '<div class="pcat">My Library</div><div class="muted small">No custom parts yet. Click “＋ New part”, or edit any placed part and save it.</div>';
    return '<div class="pcat">My Library</div>' + ps.map(p => `<div class="libpart"><button class="dbpart mylib" draggable="true" data-key="${esc(p.key)}" title="Place ${esc(p.name)} (or drag it onto the schematic)">
      <div class="dbt"><b>${esc(p.name)}</b><span class="badge">${p.custom ? 'custom' : 'edited'}</span></div>
      <div class="dbs">${(p.pins || []).length} pins · ${esc((p.footprint && p.footprint.name) || 'no footprint')}</div></button>
      <button class="mini-btn" data-edit="${esc(p.key)}" title="Edit">✎</button><button class="mini-btn danger" data-del="${esc(p.key)}" title="Remove from My Library">✕</button></div>`).join('');
  }
  function renderDb() {
    if (!db.q && !db.loading) return '';
    let h = `<div class="pcat">Database · JLCPCB + EasyEDA library + community${db.loading ? ' <span class="spin"></span>' : ''}</div>`;
    if (db.error) h += `<div class="dberr">${esc(db.error)}</div>`;
    if (!db.loading && !db.results.length && !db.error) h += '<div class="muted small">No parts with a footprint found</div>';
    const arc = r => !!r.sources && r.sources.some(s => /^archive/.test(s));   // from a local parts archive (snapshot stock / price)
    const lib = r => r.sources && !r.sources.includes('jlcpcb') && !arc(r);   // found only in the EasyEDA library (no JLCPCB stock data)
    h += db.results.map(r => `<button class="dbpart" draggable="true" data-lcsc="${esc(r.lcsc)}" title="${esc([r.description, r.footprint && 'Footprint: ' + r.footprint, r.note].filter(Boolean).join('\n'))}">
      <div class="dbt"><b>${esc(r.mfr_part || r.lcsc)}</b>${r.basic ? '<span class="badge basic">Basic</span>' : ''}${arc(r) ? '<span class="badge" title="From your local parts archive (snapshot stock and price)">Archive</span>' : ''}${lib(r) ? `<span class="badge">${r.sources.includes('community') ? 'community' : 'EasyEDA lib'}</span>` : ''}</div>
      <div class="dbs">${esc(r.package || '')}${r.brand ? ' · ' + esc(r.brand) : ''}</div>
      <div class="dbs">${r.sources && r.sources.includes('community') ? 'EasyEDA user part' : esc(r.lcsc)} · ${lib(r) ? `<span class="muted">${r.sources.includes('community') ? 'by ' + esc(r.author || 'a user') + (r.supplier_part ? ' · ' + esc(r.supplier_part) : '') : /^C99/.test(r.lcsc) ? 'not sold by LCSC' : 'stock: check LCSC'}</span>` : `<span class="${r.stock > 0 ? 'good' : 'bad'}">${(r.stock || 0).toLocaleString()} in stock</span>`}${r.price != null ? ' · $' + (+r.price).toFixed(r.price < 0.1 ? 4 : 2) : ''}</div></button>`).join('');
    if (db.open && db.open.length) h += `<div class="pcat">Open libraries · KiCad, SparkFun, Digi-Key</div>` + db.open.map(r => `<button class="dbpart" draggable="true" data-lcsc="${esc(r.key)}" title="${esc([r.description, 'Footprint: ' + r.footprint, r.sourceName + ': custom part, no LCSC number — check the footprint'].filter(Boolean).join('\n'))}">
      <div class="dbt"><b>${esc(r.name)}</b><span class="badge">${esc(r.source === 'kicad' ? 'KiCad' : r.source === 'sparkfun' ? 'SparkFun' : 'Digi-Key')}</span></div>
      <div class="dbs">${esc(r.footprint.split(':').pop())}</div><div class="dbs muted">${esc((r.description || r.library).slice(0, 60))}</div></button>`).join('');
    return h;
  }
  function renderParts() {
    const q = $('#partSearch').value.toLowerCase(), cats = {};
    for (const t of Lib.types()) {
      const d = Lib.type(t); if (q && !(d.name + ' ' + t).toLowerCase().includes(q)) continue;
      (cats[d.cat] = cats[d.cat] || []).push(t);
    }
    $('#partList').innerHTML = Object.entries(cats).map(([c, ts]) => `<div class="pcat">${c}</div>` + ts.map(t => {
      const d = Lib.type(t), b = d.box({ type: t }), pad = 6;
      const db = Lib.dbDefault(t, null);
      return `<button class="part" draggable="true" data-type="${t}" title="Add ${esc(d.name)}${db ? ` — JLCPCB ${db.lcsc} (${esc(db.value)}, ${esc(db.pkg)})` : ' — standard footprint'}"><svg viewBox="${b[0] - pad} ${b[1] - pad} ${b[2] - b[0] + 2 * pad} ${b[3] - b[1] + 2 * pad}"><g class="comp mini">${d.draw({ type: t })}</g></svg><span>${esc(d.name)}</span>${db ? `<i class="jlc">${db.lcsc}</i>` : ''}</button>`;
    }).join('')).join('') + renderMyLib(q) + renderDb();
  }

  // ---------- properties ----------
  // "LCSC:C25804" → "0603 · JLCPCB C25804" (the package of the database part behind the footprint)
  function fpLabel(f) {
    const m = /^(LCSC|LIB):(.+)$/.exec(f); if (!m) return f;
    // size from the footprint itself (it may have been edited), then from the part's package
    const l = Model.S.lib[m[2]], sz = t => (String(t || '').match(/(?:^|\D)(0201|0402|0603|0805|1206|1210|2512)(?!\d)/) || [])[1];
    const fs = l && l.footprint && sz(l.footprint.name), ps = l && sz(l.package), pkg = fs || ps || (l && (l.package || (l.footprint && l.footprint.name)));
    const num = l && /^C\d+$/.test(l.lcsc || '') ? 'JLCPCB ' + l.lcsc + (l.lcsc !== m[2] ? ', own copy' : '') : m[1] === 'LCSC' ? 'JLCPCB ' + m[2] : m[2];
    return pkg ? `${pkg} · ${num}${fs && ps && fs !== ps ? ` (part is ${ps})` : ''}` : f;
  }
  function renderProps() {
    const el = $('#props');
    if (el.contains(document.activeElement) && document.activeElement.tagName !== 'BUTTON') return;
    const many = view === 'sch' ? Sch.selected() : view === 'pcb' ? PcbView.selected() : [];
    if (many.length > 1) {
      el.innerHTML = `<div class="ph">${many.length} parts selected</div><div class="muted small" style="margin-bottom:6px">${esc(many.join(', '))}</div>
        <div class="row"><button data-a="rot">⟳ Rotate</button><button data-a="dup">⧉ Duplicate</button>${view === 'pcb' ? '<button data-a="flip">⇅ Flip side</button>' : ''}</div>
        <div class="row"><button data-a="copy">Copy</button><button data-a="cut">Cut</button><button data-a="del" class="danger">Delete</button></div>
        <p class="muted small">Drag any selected part to move the group · Shift+click adds or removes a part · drag a box on empty space to select · right-click for more</p>`;
      el.querySelectorAll('[data-a]').forEach(b => b.onclick = () => act(b.dataset.a));
      return;
    }
    if (view === 'pcb' && PcbView.props(el)) return;
    if (view === 'enc' && EncView.props(el)) return;
    if (view === 'doc' && DocView.props(el)) return;
    const ref = view === 'sch' ? Sch.ui.sel : Pcb.ui.sel, net = view === 'sch' ? Sch.ui.selNet : null;
    const c = ref && Model.comp(ref);
    if (c) {
      const d = Lib.type(c.type), idx = Model.pinIndex();
      const fps = [...new Set([...Lib.fpsFor(c), c.footprint])];
      el.innerHTML = `<div class="ph">${esc(c.ref)} <span class="muted">${esc(d.name)}</span></div>
        <label>Reference<input id="pRef" value="${esc(c.ref)}"></label>
        <label>Value<input id="pVal" value="${esc(c.value)}"></label>
        ${c.lcsc && Model.S.lib[c.lcsc] ? `<div class="lcscinfo"><b>${esc(Model.S.lib[c.lcsc].name)}</b><br>${Model.S.lib[c.lcsc].custom ? '<span class="muted">Custom part · ' + esc(c.lcsc) + '</span>' : `${esc(Model.S.lib[c.lcsc].manufacturer || '')} · <span class="muted">${esc(Model.lcscOf(c) || c.lcsc)}</span>`}${Model.S.lib[c.lcsc].datasheet ? ` · <a href="${esc(Model.S.lib[c.lcsc].datasheet)}" target="_blank" rel="noopener">datasheet</a>` : ''}</div>` : ''}
        <label>Footprint<select id="pFp">${fps.map(f => `<option value="${esc(f)}" ${f === c.footprint ? 'selected' : ''}>${esc(fpLabel(f))}</option>`).join('')}</select></label>
        ${Sch.sheets().length > 1 ? `<label>Sheet<select id="pSheet">${Sch.sheets().map((s, i) => `<option value="${i}" ${Model.sheetOf(c) === i ? 'selected' : ''}>${i + 1}: ${esc(s.name || '')}</option>`).join('')}</select></label>` : ''}
        ${d.generic ? `<label>Pins (comma separated, pin 1 first)<textarea id="pPins" rows="3">${esc((c.pins || Lib.type(c.type).pins(c).map(p => p.name)).join(', '))}</textarea></label>` : ''}
        <div class="row"><button id="pRot">⟳ Rotate (R)</button><button id="pDel" class="danger">Delete</button></div>
        ${view === 'pcb' && c.pcb ? `<div class="ph small">Board side</div><div class="row edgebtns"><button data-side="top" class="${Pcb.isBottom(c) ? '' : 'on'}">▲ Top</button><button data-side="bottom" class="${Pcb.isBottom(c) ? 'on' : ''}">▼ Bottom</button></div>` : ''}
        ${view === 'pcb' && c.pcb ? `<div class="ph small">Place on board edge${c.pcbEdge ? ' · <span class="muted">' + c.pcbEdge + '</span>' : ''}</div><div class="row edgebtns"><button data-edge="left" title="Left edge">⇤ Left</button><button data-edge="top" title="Top edge">⤒ Top</button><button data-edge="bottom" title="Bottom edge">⤓ Bottom</button><button data-edge="right" title="Right edge">Right ⇥</button></div>` : ''}
        ${view === 'pcb' && c.pcb ? (() => { const L = c.pcb.silk || {}, li = Pcb.silkInfo().find(x => x.kind === 'part' && x.ref === c.ref); return `<div class="ph small">Silkscreen label${li && li.covers_pads ? ' · <span class="bad">covers pads</span>' : ''}</div>
        <label>Text<input id="pSlT" value="${esc(L.text || '')}" placeholder="${esc(c.ref)}"></label>
        <div class="row"><label style="flex:1">Size (mm)<input id="pSlH" type="number" step="0.1" min="0.6" value="${L.h || ''}" placeholder="1.0"></label><label style="flex:1">Rotation (°)<input id="pSlR" type="number" step="15" value="${L.rot || 0}"></label></div>
        <label class="chk"><input type="checkbox" id="pSlHide" ${L.hide ? 'checked' : ''}> Hide</label>
        <div class="row"><button id="pSlAuto" ${L.dx == null ? 'disabled' : ''} title="Put the label back where it covers no pad, part or label">Automatic position</button></div>
        <div class="muted small">Drag the label on the board to move it (it then moves with the part); click the label, then R rotates it and + / − change its size.</div>`; })() : ''}
        <div class="row"><button id="pEdit" style="flex:1">✎ ${c.type === 'part' ? 'Edit symbol &amp; footprint' : 'Make editable part'}</button></div>
        <div class="ph small">Pins</div><table class="pins">${Lib.type(c.type).pins(c).map(p => `<tr><td>${esc(p.num)}</td><td>${esc(p.name)}</td><td class="${idx[c.ref + '.' + p.num] ? '' : 'muted'}">${esc(idx[c.ref + '.' + p.num] || '—')}</td></tr>`).join('')}</table>`;
      const apply = (u) => { try { Model.mutate(() => Model.updateComponent(Object.assign({ ref: c.ref }, u))); if (u.new_ref) { Sch.ui.sel = u.new_ref; Pcb.ui.sel = u.new_ref; } } catch (e) { toast(e.message); } };
      $('#pRef').onchange = e => apply({ new_ref: e.target.value.trim() });
      $('#pVal').onchange = e => apply({ value: e.target.value });
      $('#pFp').onchange = e => apply({ footprint: e.target.value });
      if ($('#pSheet')) $('#pSheet').onchange = e => { const i = +e.target.value; Model.mutate(() => { const cc = Model.comp(c.ref); if (i) cc.sheet = i; else delete cc.sheet; Model.spaceOut(); }); Sch.setSheet(i); Sch.select(c.ref); };
      if ($('#pPins')) $('#pPins').onchange = e => apply({ pins: e.target.value.split(',').map(s => s.trim()).filter(Boolean) });
      $('#pRot').onclick = () => (view === 'sch' ? Sch : Pcb).key({ key: 'r' });
      $('#pDel').onclick = () => { Sch.select(null); Pcb.ui.sel = null; Model.mutate(() => Model.removeComponent(c.ref)); };
      if ($('#pSlT')) {
        const sl = o => Model.mutate(() => Pcb.setSilkLabel(c.ref, o));
        $('#pSlT').onchange = e => sl({ text: e.target.value }); $('#pSlH').onchange = e => sl({ size: +e.target.value || 1.0 });
        $('#pSlHide').onchange = e => sl({ hidden: e.target.checked }); $('#pSlAuto').onclick = () => sl({ auto: true }); $('#pSlR').onchange = e => sl({ rotation: +e.target.value || 0 });
      }
      $('#pEdit').onclick = () => editComponent(c.ref);
      el.querySelectorAll('[data-side]').forEach(b => b.onclick = () => { try { Model.mutate(() => Pcb.placeFootprint(c.ref, { side: b.dataset.side })); toast(`${c.ref} on the ${b.dataset.side} side — press Route to reconnect`); } catch (e) { toast(e.message); } });
      el.querySelectorAll('[data-edge]').forEach(b => b.onclick = () => { try { const r = Model.mutate(() => Pcb.placeFootprint(c.ref, { edge: b.dataset.edge })); toast(`${c.ref} on the ${b.dataset.edge} edge${r.outside_board ? ' — outside the board, enlarge it or move it' : ''} · press Route to reconnect`); } catch (e) { toast(e.message); } });
    } else if (net && Model.S.nets[net]) {
      el.innerHTML = `<div class="ph">Net</div><label>Name<input id="pNet" value="${esc(net)}"></label>
        <div class="ph small">Pins (${Model.S.nets[net].length})</div><div class="netpins">${Model.S.nets[net].map(esc).join(', ')}</div>
        <div class="row"><button id="pNetDel" class="danger">Delete net</button></div>`;
      $('#pNet').onchange = e => { try { const to = e.target.value.trim(); Model.mutate(() => Model.renameNet(net, to)); Sch.select(null, to); } catch (err) { toast(err.message); } };
      $('#pNetDel').onclick = () => { Sch.select(null); Model.mutate(() => Model.removeNet(net)); };
    } else {
      el.innerHTML = `<div class="muted help">${view === 'sch'
        ? '<b>Click</b> a part to select · <b>drag</b> to move · <b>R</b> rotate · <b>Del</b> delete<br><b>Click a pin, then another pin</b> to wire them<br><b>Drag a box</b> on empty space to select several · <b>Shift+click</b> adds · <b>right-click</b> for Copy / Cut / Paste / Rotate…<br><b>Right- or middle-drag</b> to pan · <b>wheel</b> to zoom'
        : '<b>Drag</b> footprints to move · <b>R</b> rotate<br><b>Drag a box</b> on empty space to select several · <b>Shift+click</b> adds · <b>right-click</b> for Copy / Paste / Flip / Lock…<br><b>Right- or middle-drag</b> to pan<br>Red = top copper · Blue = bottom · Yellow = ratsnest'}</div>`;
    }
  }

  // Edit a placed part (or convert a built-in one into an editable custom part).
  function editComponent(ref) {
    const c = Model.comp(ref); if (!c) return;
    if (c.type === 'part' && Model.S.lib[c.lcsc]) {
      // other components using the same part: the editor offers "only this one" (its own copy) or all of them
      const users = Model.S.components.filter(o => o.type === 'part' && o.lcsc === c.lcsc).map(o => o.ref);
      PartEditor.open(Model.S.lib[c.lcsc], { key: c.lcsc, saveLib: users.length < 2, ref: c.ref, users, onDone: () => Sch.select(c.ref) });
      return;
    }
    const d = PartEditor.fromBuiltin(c), key = PartEditor.newKey(d.name);
    PartEditor.open(d, {
      key, isNew: true, saveLib: true, onDone: k => {
        Model.mutate(() => { const cc = Model.comp(ref); if (!cc) return; cc.type = 'part'; cc.lcsc = k; delete cc.pins; cc.footprint = Model.fpNameFor(k); Model.invalidate(Model.netsOfComp(ref)); });
        Sch.select(ref);
      }
    });
  }

  // EasyEDA schematic: each part with an LCSC number is linked to its EasyEDA library symbol + footprint (uuid / puuid)
  // mode: 'sch' (schematic .json), 'pcb' (PCB .json) or 'project' (both in one .zip, for EasyEDA Pro / Standard import)
  async function easyedaExport(mode = 'sch') {
    // filling the pours for EasyEDA takes a while on big boards: say so before the page is busy
    const filling = () => (Model.S.pcb.pours || []).length ? (toast('Filling the copper pours for EasyEDA…', 60000), new Promise(r => setTimeout(r, 60))) : null;
    if (mode === 'pcb') {
      await filling();
      download(fname('-pcb.easyeda.json'), EasyEDA.exportPcb(), 'application/json');
      toast('EasyEDA PCB saved: footprints, tracks, vias, copper pours and the board outline. EasyEDA Pro: File → Import → EasyEDA (Standard) · Standard: File → Open → EasyEDA Source · the copper pours arrive filled and connected as in CircuitPilot (no rebuild needed; after edits use Rebuild Copper Region, Shift+B) · EasyEDA Pro checks with its own rules: set the clearance to ' + Pcb.rules().clearance + ' mm (Design → Design Rule) or it reports gaps under 6 mil as errors', 12000);
      return;
    }
    const S = Model.S, codes = [...new Set(S.components.map(c => Model.lcscOf(c)).filter(Boolean))], ids = {}, failed = [];
    toast(`Linking ${codes.length} parts to the EasyEDA library…`, 20000);
    await Promise.all(codes.map(async code => {
      try { const p = await Engine.partsApi('get/' + encodeURIComponent(code)); if (p && p.puuid) ids[code] = { uuid: p.uuid, puuid: p.puuid, package: p.package || (p.footprint && p.footprint.name) }; else failed.push(code); }
      catch (e) { failed.push(code); }
    }));
    const sch = EasyEDA.exportSchematic(ids);
    let pcb = null;
    if (mode === 'project') { await filling(); try { pcb = EasyEDA.exportPcb(ids); } catch (e) { pcb = null; } }
    if (mode === 'project') {
      const base = (S.name || 'Project').replace(/[\\/:*?"<>|]+/g, '_');
      const files = { [`SCH_${base}.json`]: sch }; if (pcb) files[`PCB_${base}.json`] = pcb;
      download(fname('-easyeda.zip'), makeZip(files));
    } else download(fname('-schematic.easyeda.json'), sch, 'application/json');
    const sz = t => (String(t || '').match(/(?:^|\D)(0201|0402|0603|0805|1206|1210|2512)(?!\d)/) || [])[1];
    const noCode = S.components.filter(c => !Model.lcscOf(c)).map(c => c.ref);
    const edited = S.components.filter(c => { const k = Model.lcscOf(c), l = c.type === 'part' ? S.lib[c.lcsc] : null, a = sz(l && l.footprint && l.footprint.name), b = sz(ids[k] && ids[k].package); return a && b && a !== b; }).map(c => c.ref);
    const notes = [noCode.length && `no LCSC part (choose the footprint in EasyEDA): ${noCode.join(', ')}`,
      failed.length && `not found in the EasyEDA library: ${failed.join(', ')}`,
      edited.length && `footprint edited here, EasyEDA uses the part's own footprint: ${edited.join(', ')}`].filter(Boolean);
    if (mode === 'project' && !pcb) notes.unshift('no PCB yet, so only the schematic is in the zip');
    toast(`EasyEDA ${mode === 'project' ? 'project (schematic' + (pcb ? ' + PCB)' : ')') : 'schematic'} saved — ${S.components.length - noCode.length - failed.length}/${S.components.length} parts linked to EasyEDA footprints${notes.length ? ' · ' + notes.join(' · ') : ''}. EasyEDA Pro: File → Import → EasyEDA (Standard) and choose the file · Standard: File → Open → EasyEDA Source${pcb && (Model.S.pcb.pours || []).length ? ' · The copper pours arrive filled and connected as in CircuitPilot (no rebuild needed; after edits use Rebuild Copper Region, Shift+B)' : ''}${pcb ? ` · EasyEDA Pro checks with its own rules: set the clearance to ${Pcb.rules().clearance} mm (Design → Design Rule) or it reports gaps under 6 mil as errors` : ''}`, 15000);
  }

  // ---------- screenshots for the AI (view_design): schematic, 2D PCB, 3D board, enclosure ----------
  // Longest side at most 1400 px (enough for a model to read labels, without wasting context); 3D views as JPEG.
  async function toAIImage(r, jpeg, max = 1400) {
    const img = new Image(); await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('could not draw the image')); img.src = r.url; });
    const s = Math.min(1, max / Math.max(r.w, r.h)), c = document.createElement('canvas');
    c.width = Math.round(r.w * s); c.height = Math.round(r.h * s);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    const url = jpeg ? c.toDataURL('image/jpeg', 0.85) : c.toDataURL('image/png');
    return { mime: jpeg ? 'image/jpeg' : 'image/png', data: url.slice(url.indexOf(',') + 1), w: c.width, h: c.height };
  }
  const blob64 = async b => { const u = new Uint8Array(await b.arrayBuffer()); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  async function renderForAI(a = {}) {
    const v = a.view, big = a.full ? 3000 : 1400;   // full: export-quality images (PNG, up to 3000 px)
    if (v === 'pdf_pcb') { const r = await PcbPdf.export({ blob: true }); return { mime: 'application/pdf', data: await blob64(r.blob), pages: r.pages }; }
    if (v === 'pdf_doc') { const b = await DocView.pdf({ blob: true }); if (!b) throw new Error('The datasheet PDF is already being built — try again'); return { mime: 'application/pdf', data: await blob64(b) }; }
    if (a.full) {
      if (v === 'schematic') { const i = Math.max(0, Math.min(Sch.sheets().length - 1, (+a.sheet || 1) - 1)); return toAIImage(await DocView.svgToPng(Sch.exportSVG(i), 3000, '#ffffff', 20), false, big); }
      if (v === 'pcb') { Pcb.render(); return toAIImage(await DocView.svgToPng(Pcb.exportSVG(), 3000, '#000', 20), false, big); }
      if (v === 'pcb_3d') { const r = await Pcb3D.snapshot(a.side || 'iso', 2400, 1600); if (!r) throw new Error('The 3D view is not available'); return toAIImage(r, false, big); }
      if (v === 'enclosure') { const r = await EncView.snapshot({ w: 2400, h: 1600, explode: !!a.exploded }); if (!r) throw new Error('No enclosure yet'); return toAIImage(r, false, big); }
    }
    // size: small (640 px JPEG, a quick look for few tokens) · normal (1400 px) · large (2000 px)
    const lim = a.size === 'small' ? 640 : a.size === 'large' ? 2000 : 1400, small = a.size === 'small';
    if (v === 'schematic') { const i = Math.max(0, Math.min(Sch.sheets().length - 1, (+a.sheet || 1) - 1)); return toAIImage(await DocView.svgToPng(Sch.exportSVG(i), Math.max(lim, 1000)), small, lim); }
    if (v === 'pcb') { Pcb.render(); return toAIImage(await DocView.svgToPng(Pcb.exportSVG(), Math.max(lim, 1000), '#000'), small, lim); }
    if (v === 'pcb_3d') { const r = await Pcb3D.snapshot(a.side || 'iso', small ? 900 : 1400, small ? 600 : 940); if (!r) throw new Error('The 3D view is not available'); return toAIImage(r, true, lim); }
    if (v === 'enclosure') { const r = await EncView.snapshot({ w: small ? 900 : 1400, h: small ? 600 : 940, explode: !!a.exploded }); if (!r) throw new Error('No enclosure yet: set one up first (set_enclosure or set_enclosure_script)'); return toAIImage(r, true, lim); }
    throw new Error('Unknown view ' + v);
  }

  // ---------- cross-probing: what is selected in the schematic is selected on the PCB, and the other way round ----------
  function syncFromSch() {
    const P = PcbView.ui, refs = Sch.selected().filter(r => { const c = Model.comp(r); return c && c.pcb; });
    P.item = null; P.sel = refs[0] || null; P.multi = new Set(refs); P.hlNet = Sch.ui.selNet || null;
  }
  function syncFromPcb() {
    const P = PcbView.ui, refs = PcbView.selected();
    Sch.ui.sel = refs[0] || null; Sch.ui.multi = new Set(refs); Sch.ui.selNet = refs.length > 1 ? null : (P.hlNet || null);
  }
  const unionBox = bs => bs.length ? [Math.min(...bs.map(b => b[0])), Math.min(...bs.map(b => b[1])), Math.max(...bs.map(b => b[2])), Math.max(...bs.map(b => b[3]))] : null;
  const netParts = net => [...new Set((Model.S.nets[net] || []).map(k => k.slice(0, k.lastIndexOf('.'))))].map(r => Model.comp(r)).filter(Boolean);
  // after switching tabs, scroll the view to the selection (and open its schematic sheet)
  function revealSelection(v) {
    if (v === 'sch') {
      let cs = Sch.selected().map(r => Model.comp(r)).filter(Boolean);
      if (!cs.length && Sch.ui.selNet) cs = netParts(Sch.ui.selNet);
      if (!cs.length) return;
      if (!cs.some(c => Model.sheetOf(c) === Sch.ui.sheet)) { Sch.ui.sheet = Model.sheetOf(cs[0]); Sch.render(); }
      Sch.vp.reveal(unionBox(cs.filter(c => Model.sheetOf(c) === Sch.ui.sheet).map(c => Model.bbox(c))), 60);
    } else if (v === 'pcb') {
      let cs = PcbView.selected().map(r => Model.comp(r)).filter(c => c && c.pcb);
      if (!cs.length && PcbView.ui.hlNet && !PcbView.ui.item) cs = netParts(PcbView.ui.hlNet).filter(c => c.pcb);
      if (!cs.length) return;
      Pcb.vp.reveal(unionBox(cs.map(c => Pcb.fpBox(c))), 2);
    }
  }

  // ---------- selection actions (schematic + PCB): copy / cut / paste / duplicate, right-click menu ----------
  let clip = null;
  const SV = () => view === 'sch' ? Sch : PcbView;
  const nParts = n => `${n} part${n > 1 ? 's' : ''}`;
  function copySel(cut) {
    const refs = SV().selected(); if (!refs.length) { toast('Select parts first — click, Shift+click, or drag a box on empty space'); return; }
    clip = Model.copyParts(refs);
    if (cut) SV().del();
    toast(`${cut ? 'Cut' : 'Copied'} ${nParts(refs.length)} — Ctrl+V pastes at the mouse`);
  }
  // o.at: world point (schematic units / board mm) for the group's centre; o.offset: shift from the originals instead
  function pasteClip(c, o = {}) {
    if (!c || !c.comps.length) { toast('Nothing to paste — copy parts first (Ctrl+C)'); return; }
    const cs = c.comps, avg = (a, f) => a.reduce((s, x) => s + f(x), 0) / a.length;
    let p;
    if (view === 'pcb') {
      const placed = cs.filter(x => x.pcb), cx = placed.length ? avg(placed, x => x.pcb.x) : 0, cy = placed.length ? avg(placed, x => x.pcb.y) : 0;
      const at = o.offset ? { x: cx + o.offset, y: cy + o.offset } : o.at || PcbView.ui.cursor || PcbView.ui.mouse || { x: Model.S.board.w / 2, y: Model.S.board.h / 2 };
      const ys = cs.map(x => x.y);
      p = { pdx: at.x - cx, pdy: at.y - cy, dx: 0, dy: Math.max(...ys) - Math.min(...ys) + 80 };   // schematic copies go below the originals
    } else {
      const cx = avg(cs, x => x.x), cy = avg(cs, x => x.y), at = o.offset ? { x: cx + o.offset * 20, y: cy + o.offset * 20 } : o.at || Sch.ui.mouse;
      p = { dx: at.x - cx, dy: at.y - cy, sheet: Sch.ui.sheet };   // not placed on the board: ⟳ Update from schematic brings them there
    }
    const refs = Model.mutate(() => Model.pasteParts(c, p));
    SV().setSelection(refs);
    toast(`Pasted ${nParts(refs.length)}: ${refs.join(', ')}${view === 'sch' && cs.some(x => x.pcb) ? ' — on the PCB tab, ⟳ Update from schematic loads them onto the board' : ''}`, 6000);
  }
  function act(a, at) {
    const V = SV(), refs = V.selected();
    if (a === 'copy') copySel(false);
    else if (a === 'cut') copySel(true);
    else if (a === 'paste') pasteClip(clip, { at });
    else if (a === 'dup') { if (refs.length) pasteClip(Model.copyParts(refs), { offset: 2 }); else toast('Select parts to duplicate'); }
    else if (a === 'del') { if (refs.length) V.del(); else if (view === 'sch' && Sch.ui.selNet) { const n = Sch.ui.selNet; Sch.select(null); Model.mutate(() => Model.removeNet(n)); } }
    else if (a === 'rot') { if (refs.length) V.rotate(); }
    else if (a === 'flip') { if (refs.length) { try { PcbView.flip(); } catch (e) { toast(e.message); } } }
    else if (a === 'lock') { const lock = !refs.every(r => Model.comp(r).pcb.locked); Model.mutate(() => { for (const r of refs) Pcb.placeFootprint(r, { lock }); }); toast(`${nParts(refs.length)} ${lock ? 'locked (Optimize and Auto-place keep them in place)' : 'unlocked'}`); }
    else if (a === 'edit') { if (refs[0]) editComponent(refs[0]); }
    else if (a === 'props') { const el = $('#props'); renderProps(); el.scrollIntoView({ block: 'start', behavior: 'smooth' }); el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
    else if (a === 'all') V.selectAll();
    else if (a === 'fit') view === 'sch' ? Sch.fit() : Pcb.fit();
  }
  function showCtx(e) {
    let m = document.getElementById('ctxMenu');
    if (!m) { m = document.createElement('div'); m.id = 'ctxMenu'; m.className = 'ctxmenu hidden'; document.body.appendChild(m); }
    const refs = SV().selected(), one = refs.length === 1 && Model.comp(refs[0]), at = view === 'sch' ? Object.assign({}, Sch.ui.mouse) : Object.assign({}, PcbView.ui.mouse);
    const it = (a, label, keyHint, dis) => `<button data-a="${a}"${dis ? ' disabled' : ''}><span>${label}</span><kbd>${keyHint || ''}</kbd></button>`;
    const items = [];
    if (refs.length) {
      items.push(`<div class="cm-h">${refs.length > 1 ? nParts(refs.length) : esc(refs[0] + ' · ' + (one.value || ''))}</div>`);
      items.push(it('cut', 'Cut', 'Ctrl+X'), it('copy', 'Copy', 'Ctrl+C'), it('paste', 'Paste', 'Ctrl+V', !clip), it('dup', 'Duplicate', 'Ctrl+D'), '<hr>');
      items.push(it('rot', 'Rotate 90°', 'R'));
      if (view === 'pcb') items.push(it('flip', 'Flip to other side', ''), it('lock', refs.every(r => Model.comp(r).pcb.locked) ? 'Unlock position' : 'Lock position', ''));
      items.push(it('del', 'Delete', 'Del'), '<hr>');
      if (one) items.push(it('props', 'Properties', ''), it('edit', one.type === 'part' ? 'Edit symbol & footprint…' : 'Make editable part…', ''));
    } else {
      if (view === 'sch' && Sch.ui.selNet) items.push(`<div class="cm-h">Net ${esc(Sch.ui.selNet)}</div>`, it('del', 'Delete net', 'Del'), '<hr>');
      items.push(it('paste', 'Paste', 'Ctrl+V', !clip), it('all', 'Select all', 'Ctrl+A'), it('fit', 'Fit view', 'F'));
    }
    while (items[items.length - 1] === '<hr>') items.pop();
    m.innerHTML = items.join('');
    m.classList.remove('hidden');
    const w = m.offsetWidth, h = m.offsetHeight;
    m.style.left = Math.min(e.x, innerWidth - w - 6) + 'px'; m.style.top = Math.min(e.y, innerHeight - h - 6) + 'px';
    m.querySelectorAll('[data-a]').forEach(b => b.onclick = () => { hideCtx(); act(b.dataset.a, at); });
  }
  function hideCtx() { const m = document.getElementById('ctxMenu'); if (m) m.classList.add('hidden'); }

  // ---------- light / dark / system theme ----------
  const THEMES = { system: ['🖥', 'Theme: follows the system — click for Light'], light: ['☀', 'Theme: Light — click for Dark'], dark: ['🌙', 'Theme: Dark — click to follow the system'] };
  function applyTheme(mode) {
    const sys = window.matchMedia && matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
    const d = mode === 'system' ? sys : mode, root = document.documentElement;
    root.setAttribute('data-theme', d); root.setAttribute('data-theme-mode', mode);
    try { localStorage.setItem('cp.theme', mode); } catch (e) { }
    $('#btnTheme').textContent = THEMES[mode][0]; $('#btnTheme').title = THEMES[mode][1];
    window.dispatchEvent(new Event('themechange'));
  }
  function initTheme() {
    let mode = 'system'; try { mode = localStorage.getItem('cp.theme') || 'system'; } catch (e) { }
    applyTheme(THEMES[mode] ? mode : 'system');
    $('#btnTheme').onclick = () => { const order = ['system', 'light', 'dark'], cur = document.documentElement.getAttribute('data-theme-mode') || 'system'; applyTheme(order[(order.indexOf(cur) + 1) % 3]); toast(THEMES[document.documentElement.getAttribute('data-theme-mode')][1].split(' — ')[0]); };
    if (window.matchMedia) matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if ((document.documentElement.getAttribute('data-theme-mode') || 'system') === 'system') applyTheme('system'); });
  }

  // ---------- autorouter in a Web Worker ----------
  let worker = null, routeReject = null, routeBest = null, routeResolve = null;
  function runRouter({ place = null, opt = {}, optimize = null } = {}) {
    if (worker) worker.terminate();
    return new Promise((resolve, reject) => {
      routeReject = reject; routeResolve = resolve; routeBest = null;
      worker = new Worker('js/route-worker.js');
      $('#routeBusy').classList.remove('hidden'); $('#routeMsg').textContent = place ? 'Placing…' : 'Routing…';
      worker.onmessage = e => {
        const m = e.data;
        if (m.type === 'best') { routeBest = m; return; }
        if (m.type === 'progress') {
          const opt = m.optimizing ? `Optimizing placement ${m.iteration}/${m.of} · ` : '';
          const time = m.budget ? ` · ${Math.round(m.elapsed)}/${Math.round(m.budget)} s` : '';
          $('#routeMsg').textContent = m.phase === 'ripup'
            ? `${opt}Rip-up & reroute · ${m.unrouted} unrouted · try ${m.iteration}${m.attempt > 1 ? ' · pass ' + m.attempt : ''}${time}`
            : `${opt}Routing ${m.net} (${(m.done ?? 0) + 1}/${m.total ?? '?'})${m.attempt > 1 ? ' · pass ' + m.attempt : ''}${time}`;
          return;
        }
        worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden');
        if (m.type === 'error') { reject(new Error(m.message)); return; }
        Model.mutate(() => {
          const S = Model.S;
          for (const [ref, pcb] of m.positions) { const c = Model.comp(ref); if (c) c.pcb = pcb; }
          S.board = m.board; S.pcb = m.pcb;
        });
        Pcb.ui.drc = null;
        resolve({ placement: m.placement, routing: m.routing, optimized: m.optimized });
      };
      worker.onerror = e => { worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden'); reject(new Error(e.message || 'Router crashed')); };
      worker.postMessage({ state: JSON.parse(Model.snapshot()), place, opt, optimize });
      if (optimize) $('#routeMsg').textContent = 'Optimizing placement…';
    });
  }

  async function jlcBom() {
    toast('Matching JLCPCB parts for every value…', 20000);
    const r = await Engine.matchJlcpcb(false);
    download(fname('-BOM-JLCPCB.csv'), bomCsv(), 'text/csv');
    toast(`JLCPCB BOM: ${r.matched}/${r.total} parts have LCSC numbers${r.matched < r.total ? ' — the rest need a part chosen (connectors / custom ICs)' : ''}`, 7000);
  }
  const bomCsv = () => Exports.bomJlc(), cplCsv = () => Exports.cpl();

  // pick-and-place file in JLCPCB's CPL format: Gerber coordinates (origin bottom-left, mm), part centre = centre of its pads

  // ---------- one-click order at JLCPCB: DRC → Gerbers + BOM + CPL → quote page ----------
  // The tab is opened inside the click (popup blockers) and sent to JLCPCB once the files are saved.
  let orderAfter = false, orderTab = null;
  const JLC_QUOTE = 'https://cart.jlcpcb.com/quote';
  function closeOrderTab() { orderAfter = false; try { if (orderTab && !orderTab.closed) orderTab.close(); } catch (e) { } orderTab = null; }
  async function orderPcb() {
    if (!Model.S.board.w || !Pcb.placed().length) { toast('No PCB yet — Generate PCB first'); return; }
    closeOrderTab();
    orderTab = window.open('', '_blank');
    try { orderTab.opener = null; orderTab.document.title = 'Preparing JLCPCB order…'; orderTab.document.body.innerHTML = '<p style="font:16px system-ui;padding:2em">Preparing your Gerber, BOM and pick-and-place files in CircuitPilot… this tab opens the JLCPCB quote page when they are saved.</p>'; } catch (e) { }
    orderAfter = true;
    toast('Matching JLCPCB parts for the assembly BOM…', 20000);
    try { await Engine.matchJlcpcb(false); } catch (e) { }
    if (!orderAfter) return;
    gerberCheck();
    if (orderAfter && !$('#gerberModal').classList.contains('hidden')) toast('Fix or accept the DRC items, then Download — the JLCPCB page opens after the files are saved', 8000);
  }
  function orderFinish() {
    orderAfter = false;
    const asm = Model.S.components.some(c => c.lcsc || c.lcscPart);
    if (asm) { download(fname('-BOM-JLCPCB.csv'), bomCsv(), 'text/csv'); download(fname('-CPL-JLCPCB.csv'), cplCsv(), 'text/csv'); }
    if (orderTab && !orderTab.closed) orderTab.location.href = JLC_QUOTE; else window.open(JLC_QUOTE, '_blank', 'noopener');
    orderTab = null;
    const b = Model.S.board;
    toast(`Files saved to Downloads. On JLCPCB click “Add gerber file” and choose ${fname('-gerbers.zip')} (board ${b.w}×${b.h} mm, layers detected automatically).${asm ? ' For assembly turn on “PCB Assembly” and upload the BOM and CPL .csv files — check part rotations in the preview.' : ''}`, 20000);
  }

  // ---------- placement optimiser ----------
  async function runOptimize(o = {}) {
    try {
      showView('pcb');
      const before = `${Model.S.board.w}×${Model.S.board.h}`;
      const r = await runRouter({ optimize: Object.assign({ time_limit_s: o.shrink ? 180 : 150, allow_grow: false, allow_bottom: false }, o) });
      const p = r.optimized; Pcb.fit();
      if (!p) { showDrc(); return; }   // stopped: best kept
      const size = `${p.board.w}×${p.board.h}`;
      toast(p.unrouted.length ? `Optimized (${p.iterations} rounds) — ${p.routed}/${p.total} routed, still unrouted: ${p.unrouted.join(', ')}. Try a GND pour, a bigger board or AI place.` : `✓ All ${p.total} nets routed${size !== before ? ` · board ${before} → ${size} mm` : ''} (${p.seconds}s)`, 9000);
      showDrc(); return p;
    } catch (e) { toast(e.message); }
  }
  // AI placement: the copilot plans the floor plan with place_footprints, then routes and fixes what is left
  // AI place: ONE model request (compact parts + nets list → JSON floor plan), then legalise + short polish + route.
  // Much faster than a tool-calling conversation, and works with small / local models.
  let aiPlacing = false, aiPlaceCtl = null;
  // pull {"placements":[…]} out of a model reply (reasoning text, code fences or braces before it are ignored)
  function parsePlan(text) {
    const t = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
    for (let i = t.lastIndexOf('"placements"'); i >= 0; i = t.lastIndexOf('"placements"', i - 1)) {
      const s = t.lastIndexOf('{', i); if (s < 0) break;
      let depth = 0, end = -1, str = false;
      for (let k = s; k < t.length; k++) { const ch = t[k]; if (ch === '"' && t[k - 1] !== '\\') str = !str; if (str) continue; if (ch === '{') depth++; else if (ch === '}' && !--depth) { end = k; break; } }
      if (end > s) { try { return JSON.parse(t.slice(s, end + 1)); } catch (e) { } }
      if (i === 0) break;
    }
    const a = t.match(/\[\s*\{[\s\S]*?\}\s*\]/g);
    if (a) for (const x of a.reverse()) { try { const v = JSON.parse(x); if (Array.isArray(v) && v.length && v[0].ref) return { placements: v }; } catch (e) { } }
    return null;
  }
  async function aiPlace() {
    const S = Model.S;
    if (!S.components.length) { toast('Add parts first'); return; }
    if (aiPlacing) { toast('AI place is already running — see the progress bar (Stop to cancel)'); return; }
    const report = msg => { AI.note(msg, '✦ AI place'); renderChat(); };
    const quick = why => {
      report(`**AI place → quick place instead.** ${why}`);
      return runRouter({ place: S.board.w > 0 ? { w: S.board.w, h: S.board.h } : { fit: true }, opt: { noRoute: true } }).then(() => { Pcb.fit(); toast('Placed with quick place — press Route', 6000); });
    };
    if (!AI.modelReady()) return quick('No AI model is set up in this browser (⚙ Settings → API key / model). Settings are stored per browser, so a phone or another browser needs its own.');
    aiPlacing = true; showView('pcb');
    const ctl = new AbortController(), t0 = Date.now(), model = AI.currentModel().label;
    aiPlaceCtl = ctl;
    const busy = $('#routeBusy'), msgEl = $('#routeMsg');
    busy.classList.remove('hidden');
    const tick = setInterval(() => { msgEl.textContent = `✦ AI is planning the layout · ${model} · ${Math.round((Date.now() - t0) / 1000)} s`; }, 500);
    let text = '';
    try {
      if (!(S.board.w > 0) || !Pcb.placed().length) { clearInterval(tick); await runRouter({ place: { fit: true }, opt: { noRoute: true } }); busy.classList.remove('hidden'); }
      const lay = await Engine.exec('get_pcb_layout', { pins: false, fields: ['value', 'type', 'size', 'edge'] });
      const idx = Model.pinIndex(), nets = {};
      for (const [n, keys] of Object.entries(Model.S.nets)) { const refs = [...new Set(keys.map(k => k.split('.')[0]))]; if (refs.length >= 2) nets[n] = refs; }
      const parts = lay.footprints.map(f => `${f.ref} | ${f.value} | ${f.type} | ${f.size[0]}x${f.size[1]} mm | ${Pcb.padsOf(Model.comp(f.ref), idx).length} pins${f.edge ? ' | CONNECTOR: must sit on a board edge' : ''}`).join('\n');
      const prompt = `Board: ${lay.board.w} x ${lay.board.h} mm, origin top-left, x right, y down. Keep every part fully inside, 1 mm from the edges, 0.5 mm apart.\n\nParts (ref | value | type | size | pins):\n${parts}\n\nNets (which parts connect):\n${Object.entries(nets).map(([n, r]) => `${n}: ${r.join(' ')}`).join('\n')}\n\n` +
        `Plan the placement like an experienced PCB layout engineer so routing is short and easy:\n- connectors on a board edge (give "edge": left|right|top|bottom), USB / power input together with the regulator\n- the biggest IC / module near the centre\n- each decoupling capacitor right next to the IC it serves (within ~2 mm)\n- crystals next to the MCU clock pins, LEDs with their resistors, buttons with their pull-ups\n- parts that share nets close together, grouped by function along the signal flow\n` +
        `Reply with JSON only, no explanation: {"placements":[{"ref":"U1","x":20,"y":15,"rot":0},{"ref":"J1","x":2,"y":15,"rot":90,"edge":"left"}]} — x, y = part centre in mm, rot 0|90|180|270. Include every part.`;
      const noThink = /qwen|deepseek-r|qwq/i.test(AI.settings.model) ? '\n/no_think' : '';
      text = await AI.complete('You are an expert PCB layout engineer. You answer with JSON only.', prompt + noThink, { json: true, maxTokens: 8192, signal: ctl.signal });
      window.__lastAiPlace = text;
      const plan = parsePlan(text);
      const list = plan && Array.isArray(plan.placements) ? plan.placements.filter(p => p && Model.comp(p.ref) && isFinite(+p.x) && isFinite(+p.y)) : [];
      if (list.length < Math.max(1, lay.footprints.length * 0.6)) throw Object.assign(new Error(`The model's reply had no usable placement (${list.length} of ${lay.footprints.length} parts).`), { unusable: true });
      for (const p of list) { p.x = +p.x; p.y = +p.y; p.rot = [0, 90, 180, 270].includes(+p.rot) ? +p.rot : 0; if (!['left', 'right', 'top', 'bottom'].includes(p.edge)) delete p.edge; }
      const r = await Engine.exec('place_footprints', { placements: list, refine: true, move_others: true });
      const secs = Math.round((Date.now() - t0) / 1000);
      clearInterval(tick);
      const rr = await runRouter({ opt: {} }); Pcb.fit();
      const ro = rr && rr.routing;
      report(`**AI place** with ${model} (${secs} s): placed ${r.placed} parts${list.length < lay.footprints.length ? ` (${lay.footprints.length - list.length} missing from the reply were kept)` : ''}${r.problems && r.problems.length ? `, ${r.problems.length} placement problems left` : ''}, polished, then routed${ro ? `: **${ro.routed}/${ro.total} nets**${ro.failed && ro.failed.length ? ` — unrouted: ${ro.failed.join(', ')} → try ✨ Optimize` : ''}` : ''}.`);
      toast(ro ? `✦ AI place + route: ${ro.routed}/${ro.total} nets` : 'AI place done', 8000);
      showDrc();
    } catch (e) {
      const why = ctl.signal.aborted ? 'Stopped.' : e.unusable ? e.message + (text ? ` Reply started with: \`${text.replace(/\s+/g, ' ').slice(0, 160)}…\`` : '') : 'The model request failed: ' + e.message;
      clearInterval(tick); busy.classList.add('hidden');
      if (ctl.signal.aborted) report('**AI place** stopped.'); else await quick(why).catch(() => { });
    } finally { clearInterval(tick); aiPlacing = false; aiPlaceCtl = null; if (!worker) busy.classList.add('hidden'); }
  }

  // ---------- update the board from schematic edits: load only (no auto placement / routing) ----------
  // New parts are lined up beside the board with their ratsnest, changed footprints take effect in place,
  // copper of deleted nets is removed. Placing and routing stay with the user (drag, Route, Auto-place, Optimize).
  function updateFromSchematic() {
    showView('pcb');
    if (!Model.S.board.w || !Pcb.placed().length) { toast('No PCB yet — use Generate PCB first'); return; }
    let r; try { r = Model.mutate(() => Pcb.syncFromSchematic({ place: false })); } catch (e) { toast(e.message); return; }
    if (r.added.length) Pcb.fit();
    const st = Pcb.status(), pl = n => n > 1 ? 's' : '';
    const what = [r.added.length && `${r.added.length} new part${pl(r.added.length)} loaded beside the board (${r.added.join(', ')}) — drag ${r.added.length > 1 ? 'them' : 'it'} into place`,
      r.removed_copper && `removed ${r.removed_copper} track${pl(r.removed_copper)}/vias of deleted nets`].filter(Boolean);
    const warn = [r.overlaps.length && `overlapping after footprint changes: ${r.overlaps.join(', ')}`,
      r.no_footprint.length && `${r.no_footprint.join(', ')} have no footprint`].filter(Boolean);
    toast(`Updated from schematic: ${what.join(' · ') || 'footprints and nets are up to date'} · ${st.routed}/${st.nets} nets routed${warn.length ? ' · ' + warn.join(' · ') : ''}`, warn.length || r.added.length ? 12000 : 6000);
  }

  // ---------- Gerber export: DRC first, then download or fix ----------
  function gerberDownload() {
    download(fname('-gerbers.zip'), makeZip(Pcb.gerbers()));
    $('#gerberModal').classList.add('hidden');
    toast('Gerbers, drill, paste & silkscreen exported — upload the zip to your PCB fab. ' + Pcb.viaSummary(), 12000);
    if (orderAfter) orderFinish();
  }
  function gerberCheck() {
    const S = Model.S;
    if (!S.board.w || !Pcb.placed().length) { closeOrderTab(); toast('No PCB yet — Generate PCB first'); return; }
    const d = showDrc(), v = d.violations;
    if (!v.length) { const o = orderAfter; gerberDownload(); if (!o) toast('✓ DRC passed — Gerbers exported'); return; }
    $('#gbSummary').innerHTML = `<p><b class="${d.errors ? 'bad' : 'warn'}">${esc(d.summary)}</b> — ${d.errors ? 'the board has errors that a fab may reject or that would make it not work.' : 'only warnings; the board can be manufactured.'}</p><p class="muted small">Click an item to see it on the board.</p>`;
    $('#gbList').innerHTML = v.map((x, i) => `<li class="${x.severity === 'error' ? 'error' : 'warn'}" data-v="${i}">${esc(x.msg)}</li>`).join('');
    $('#gbList').querySelectorAll('[data-v]').forEach(li => li.onclick = () => { const x = v[+li.dataset.v]; $('#gerberModal').classList.add('hidden'); showView('pcb'); showDrc(); if (x.x != null) Pcb.vp.fit([x.x - 3, x.y - 3, x.x + 3, x.y + 3], 1); });
    $('#gbOpt').classList.toggle('hidden', !Pcb.status().unrouted.length);
    $('#gbDownload').textContent = d.errors ? 'Download anyway' : 'Download';
    $('#gerberModal').classList.remove('hidden');
  }
  function initGerberCheck() {
    $('#gbClose').onclick = () => { closeOrderTab(); $('#gerberModal').classList.add('hidden'); };
    $('#gbDownload').onclick = gerberDownload;
    $('#gbFix').onclick = () => { closeOrderTab(); $('#gerberModal').classList.add('hidden'); showView('pcb'); showDrc(true); };
    $('#gbRoute').onclick = async () => { $('#gerberModal').classList.add('hidden'); try { await runRouter({ opt: {} }); } catch (e) { toast(e.message); } gerberCheck(); };
    $('#gbOpt').onclick = async () => { $('#gerberModal').classList.add('hidden'); await runOptimize(); gerberCheck(); };
  }

  // ---------- design rules + DRC ----------
  let rDraft = null;
  function openRules() {
    rDraft = JSON.parse(JSON.stringify(Pcb.rules()));
    $('#rPreset').innerHTML = Object.entries(Pcb.RULE_PRESETS).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
    fillRules(); $('#rulesModal').classList.remove('hidden');
  }
  function fillRules() {
    $('#rPreset').value = rDraft.preset;
    $$('#rulesModal [data-r]').forEach(el => { const v = rDraft[el.dataset.r]; if (el.type === 'checkbox') el.checked = !!v; else el.value = v == null ? '' : v; });
    $('#rNets').innerHTML = Object.entries(rDraft.netWidths).map(([n, w]) => `<div class="nr"><b>${esc(n)}</b><span>${w} mm</span><button data-rm="${esc(n)}" class="danger">✕</button></div>`).join('') || (rDraft.powerWider ? '<div class="muted small">No per-net widths — power/GND nets use the power width.</div>' : '<div class="muted small">No per-net widths — every net uses the trace width.</div>');
    $('#rNetSel').innerHTML = Object.keys(Model.S.nets).sort().map(n => `<option>${esc(n)}</option>`).join('');
    const w = Pcb.ruleWarnings(rDraft); $('#rWarn').innerHTML = w.map(x => '⚠ ' + esc(x)).join('<br>');
  }
  function readRules() {
    $$('#rulesModal [data-r]').forEach(el => { const k = el.dataset.r; if (el.type === 'checkbox') rDraft[k] = el.checked; else if (el.value !== '') rDraft[k] = el.tagName === 'SELECT' && isNaN(+el.value) ? el.value : +el.value; });
  }
  async function saveRules(route) {
    readRules();
    const u = Object.assign({}, rDraft), cur = Pcb.rules();
    const removed = Object.keys(cur.netWidths).filter(n => !(n in rDraft.netWidths));
    u.netWidths = Object.assign({}, rDraft.netWidths); removed.forEach(n => u.netWidths[n] = 0);
    try {
      const r = Model.mutate(() => { Model.S.rules = { preset: rDraft.preset, netWidths: Model.S.rules && Model.S.rules.netWidths || {} }; return Pcb.setRules(u); });
      $('#rulesModal').classList.add('hidden');
      toast(r.warnings.length ? '⚠ ' + r.warnings[0] : 'Design rules saved');
      if (route) { showView('pcb'); $('#btnRoute').click(); }
    } catch (e) { $('#rWarn').textContent = e.message; }
  }
  function initRules() {
    $('#rulesClose').onclick = $('#rulesCancel').onclick = () => $('#rulesModal').classList.add('hidden');
    // a preset sets the sizes; the other settings (track corners, via-in-pad, warnings …) stay as they are
    $('#rPreset').onchange = e => { readRules(); rDraft = Object.assign({}, rDraft, Pcb.RULE_PRESETS[e.target.value].values, { preset: e.target.value }); fillRules(); };
    $('#rulesModal').addEventListener('change', e => {
      const k = e.target.dataset && e.target.dataset.r;
      if (k === 'viaInPad' && e.target.checked) $('#rulesModal [data-r="noViaInPad"]').checked = false;
      if (k === 'noViaInPad' && e.target.checked) $('#rulesModal [data-r="viaInPad"]').checked = false;
    });
    $('#rulesModal').addEventListener('input', e => { if (e.target.dataset.r) { readRules(); $('#rWarn').innerHTML = Pcb.ruleWarnings(rDraft).map(x => '⚠ ' + esc(x)).join('<br>'); } });
    $('#rNets').onclick = e => { const b = e.target.closest('[data-rm]'); if (b) { readRules(); delete rDraft.netWidths[b.dataset.rm]; fillRules(); } };
    $('#rNetAdd').onclick = () => { readRules(); const n = $('#rNetSel').value, w = +$('#rNetW').value; if (n && w > 0) { rDraft.netWidths[n] = w; $('#rNetW').value = ''; fillRules(); } };
    $('#rulesSave').onclick = () => saveRules(false); $('#rulesRoute').onclick = () => saveRules(true);
  }
  function showDrc(goto) {
    const d = Pcb.drc(); Pcb.ui.drc = d;
    if (goto && view !== 'pcb') showView('pcb'); else Pcb.render();
    renderStatus();
    const items = d.violations;
    $('#props').innerHTML = `<div class="ph">Design rule check · <span class="${d.errors ? 'bad' : d.warnings ? 'warn' : 'good'}">${esc(d.summary || '')}</span></div>
      <div class="muted small">Rules: ${esc(Pcb.RULE_PRESETS[Pcb.rules().preset] ? Pcb.RULE_PRESETS[Pcb.rules().preset].label : 'custom')}</div>` +
      (items.length ? '<ul class="erc drc">' + items.map((v, i) => `<li class="${v.severity === 'error' ? 'error' : 'warn'}" data-v="${i}">${esc(v.msg)}</li>`).join('') + '</ul>' : '<div class="good">✓ No violations</div>');
    $('#props').querySelectorAll('[data-v]').forEach(li => li.onclick = () => { const v = items[+li.dataset.v]; if (v.x != null) Pcb.vp.fit([v.x - 3, v.y - 3, v.x + 3, v.y + 3], 1); });
    return d;
  }

  // ---------- project knowledge folder ----------
  function knowState() {
    const k = Model.S.knowledge; $('#btnKnow').classList.toggle('on', !!(k && k.path));
    $('#btnKnow').title = k && k.path ? 'Knowledge folder: ' + k.path : 'Project knowledge folder: docs & guides the AI follows';
  }
  async function showKnowFiles() {
    const k = Model.S.knowledge; $('#knowPath').value = (k && k.path) || '';
    if (!k || !k.path) { $('#knowInfo').textContent = 'No folder set for this project.'; $('#knowFiles').innerHTML = ''; return; }
    $('#knowInfo').textContent = 'Reading folder…';
    try {
      const j = await Engine.api('/api/knowledge/list?' + new URLSearchParams({ path: k.path }));
      const d = await Engine.knowledgeDigest(true);
      $('#knowInfo').innerHTML = `${j.files.length} documents in <b>${esc(j.folder)}</b> · ${(d.included_chars || 0).toLocaleString()} chars go straight into the AI context, the rest is searchable.`;
      $('#knowFiles').innerHTML = j.files.map(f => `<div class="kf"><span>${esc(f.file)}</span><span class="muted">${f.chars.toLocaleString()} chars</span></div>`).join('') || '<div class="muted">No readable documents found.</div>';
    } catch (e) { $('#knowInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; $('#knowFiles').innerHTML = ''; }
  }
  function initKnowledge() {
    $('#btnKnow').onclick = () => { $('#knowModal').classList.remove('hidden'); showKnowFiles(); };
    $('#knowClose').onclick = () => $('#knowModal').classList.add('hidden');
    $('#knowSet').onclick = async () => {
      try { await Engine.exec('set_knowledge_folder', { path: $('#knowPath').value }); knowState(); showKnowFiles(); }
      catch (e) { $('#knowInfo').innerHTML = `<span class="bad">${esc(e.message)}</span>`; }
    };
    $('#knowClear').onclick = async () => { await Engine.exec('set_knowledge_folder', { path: '' }); knowState(); showKnowFiles(); };
    Model.subscribe(knowState); knowState();
  }

  // ---------- chat ----------
  function md(src) {
    const lines = String(src || '').split('\n'), out = [];
    const inline = s => esc(s).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/(^|[^*\w])\*([^*\s][^*]*)\*/g, '$1<i>$2</i>');
    const cells = l => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim());
    let i = 0;
    while (i < lines.length) {
      const l = lines[i]; let m;
      if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push('<pre><code>' + esc(buf.join('\n')) + '</code></pre>'); continue; }
      if (/^\s*\|.*\|\s*$/.test(l) && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
        const head = cells(l); i += 2; const rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
        out.push('<div class="tw"><table><tr>' + head.map(h => '<th>' + inline(h) + '</th>').join('') + '</tr>' + rows.map(r => '<tr>' + r.map(c => '<td>' + inline(c) + '</td>').join('') + '</tr>').join('') + '</table></div>');
        continue;
      }
      if ((m = /^(#{1,4})\s+(.*)/.exec(l))) { out.push(`<h${Math.min(6, m[1].length + 2)}>${inline(m[2])}</h${Math.min(6, m[1].length + 2)}>`); i++; continue; }
      if (/^\s*([-*]|\d+\.)\s+/.test(l)) {
        const ord = /^\s*\d+\./.test(l), items = [];
        while (i < lines.length && /^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*([-*]|\d+\.)\s+/, ''));
        out.push(`<${ord ? 'ol' : 'ul'}>` + items.map(x => '<li>' + inline(x) + '</li>').join('') + `</${ord ? 'ol' : 'ul'}>`); continue;
      }
      if (!l.trim()) { i++; continue; }
      const para = [];
      while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*([-*]|\d+\.)\s+|\s*\|)/.test(lines[i])) para.push(lines[i++]);
      if (!para.length) para.push(lines[i++]);
      out.push('<p>' + para.map(inline).join('<br>') + '</p>');
    }
    return out.join('');
  }
  const SUGGEST = [
    'Design a 555 astable LED blinker at ~1 Hz powered from a 9V battery, then make the PCB',
    'Build a 5V regulated supply from a 12V input with an LM7805, input/output caps and a power LED',
    'Create a non-inverting op-amp amplifier with gain 10 using a TL071 on ±12V',
    'NPN transistor switch driving a 12V relay coil from a 3.3V GPIO, with flyback diode',
  ];
  function renderChat() {
    const H = AI.history, out = [];
    if (!H.length) {
      out.push(`<div class="welcome"><div class="wt">What should we build?</div><div class="muted">The copilot places parts, wires the schematic, checks ERC and routes the PCB. ${AI.modelReady() ? 'Choose a mode and describe your circuit.' : 'First connect an AI model. A free Google Gemini or Ollama Cloud key takes about a minute.'}</div>` +
        (AI.modelReady() ? '' : '<button class="primary connect-cta" data-connect>🔑 Connect an AI model</button>') +
        SUGGEST.map(s => `<button class="sugg">${esc(s)}</button>`).join('') + '</div>');
    }
    const results = {};
    for (const m of H) if (m.role === 'tool') for (const r of m.results) results[r.id] = r;
    H.forEach((m, i) => {
      if (m.summary) { out.push(`<div class="msg summary"><details><summary>🗜 Earlier conversation compressed${m.compressed ? ` (${m.compressed} message${m.compressed > 1 ? 's' : ''})` : ''}${m.saved ? ` — about ${fmtTok(m.saved)} tokens freed` : ''}. Show summary</summary><div class="md">${md(m.text)}</div></details></div>`); return; }
      if (m.summaryAck) return;
      const atts = (m.files || []).map(f => f.kind === 'image' && f.data ? `<img src="data:${f.mime};base64,${f.data}" alt="${esc(f.name)}" title="${esc(f.name)} (click to enlarge)" class="thumb">` : `<span class="att">${fileIcon(f)} <span class="an">${esc(f.name)}</span></span>`).join('');
      if (m.role === 'user') out.push(`<div class="msg user">${m.text ? `<div class="bub">${esc(m.text).replace(/\n/g, '<br>')}</div>` : ''}${atts ? `<div class="atts">${atts}</div>` : ''}<div class="meta">${m.mode ? `<span class="mtag ${m.mode}">${m.mode}</span>` : ''}${m.checkpoint ? `<button class="restore" data-i="${i}" title="Restore the design to how it was before this message">↺ restore checkpoint</button>` : ''}</div></div>`);
      else if (m.role === 'assistant') {
        let h = '';
        if (m.text) h += `<div class="md">${md(m.text)}</div>`;
        for (const t of m.toolCalls || []) {
          const r = results[t.id];
          h += `<details class="tool ${r ? (r.error ? 'err' : 'ok') : 'run'}"><summary><span class="dot"></span>${esc(t.name)} <span class="muted">${esc(toolHint(t))}</span></summary><pre>${esc(JSON.stringify(t.input, null, 1))}</pre>${r ? `<pre class="res">${esc(r.content.slice(0, 4000))}</pre>` : ''}</details>` + (r && r.image ? `<img class="shot" alt="Screenshot the AI looked at" src="data:${r.image.mime};base64,${r.image.data}">` : '');
        }
        const next = H[i + 1];
        if (m.mode === 'plan' && !(m.toolCalls || []).length && (!next || next.role === 'user') && !running) h += '<button class="exec">▶ Execute plan</button>';
        out.push(`<div class="msg ai">${h}<div class="meta">${esc(m.model || '')}</div></div>`);
      }
    });
    if (infoMsg) out.push(`<div class="msg info"><span class="spin"></span> ${esc(infoMsg)}</div>`);
    else if (running) out.push('<div class="msg ai"><div class="typing"><span></span><span></span><span></span></div></div>');
    if (lastError) out.push(`<div class="msg err">${esc(lastError)}</div>`);
    const chat = $('#chat'); chat.innerHTML = out.join(''); chat.scrollTop = chat.scrollHeight;
    updateCtx();
  }

  // ---------- chat extras: attachments, web toggle, folder, context meter ----------
  let pendingFiles = [], infoMsg = null;
  const fmtTok = n => n >= 1e6 ? (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + 'M' : n >= 1000 ? Math.round(n / 1000) + 'k' : String(n);
  const fileIcon = f => f.kind === 'image' ? '🖼' : f.kind === 'pdf' ? '📄' : '📝';
  function updateCtx() {
    const c = AI.contextInfo(), fill = $('#ctxFill'); if (!fill) return;
    fill.style.width = c.pct + '%'; fill.className = 'ctx-fill' + (c.pct >= 80 ? ' high' : c.pct >= 60 ? ' mid' : '');
    $('#ctxText').textContent = `${fmtTok(c.used)} / ${fmtTok(c.window)} · ${100 - c.pct}% left`;
    $('#autoCompress').checked = c.auto;
    $('#btnCompress').disabled = running || AI.history.filter(m => m.role === 'user' && !m.summary).length < 1 || AI.history.length < 2;
    $('#btnWeb').classList.toggle('on', AI.settings.webAccess !== false);
    $('#btnWeb').title = AI.settings.webAccess !== false ? 'Web search is ON — the AI can search the internet and read pages (click to turn off)' : 'Web search is OFF (click to turn on)';
    const k = Model.S.knowledge, on = !!(k && k.path);
    $('#btnFolder').classList.toggle('on', on);
    $('#btnFolder').textContent = on ? '📁 ' + k.path.split(/[\\/]/).filter(Boolean).pop() : '📁 Folder';
    $('#btnFolder').title = on ? 'AI folder: ' + k.path + ' (click to change)' : 'Point the AI to a folder of docs, guides and datasheets';
  }
  function renderAttach() {
    $('#attachList').innerHTML = pendingFiles.map((f, i) => `<span class="att${f.error ? ' err' : ''}" title="${esc(f.error || f.warn || f.name)}">${f.busy ? '<span class="spin"></span>' : f.kind === 'image' && f.data ? `<img src="data:${f.mime};base64,${f.data}">` : fileIcon(f)}<span class="an">${esc(f.name)}</span>${f.pages ? `<span class="muted">${f.pages}p</span>` : ''}${f.error ? ' ⚠' : f.warn ? ' <span class="muted">⚠</span>' : ''}<button class="x" data-i="${i}" title="Remove">✕</button></span>`).join('');
  }
  const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(r.error); r.readAsDataURL(blob); });
  async function readImage(f) {
    const ok = /^image\/(png|jpeg|webp|gif)$/.test(f.type);
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error('unsupported image format')); i.src = URL.createObjectURL(f); });
    const max = 1568, s = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    if (ok && s === 1 && f.size < 1.5e6) return { kind: 'image', mime: f.type, data: await toB64(f) };
    const c = document.createElement('canvas'); c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
    const g = c.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
    URL.revokeObjectURL(img.src);
    return { kind: 'image', mime: 'image/jpeg', data: c.toDataURL('image/jpeg', 0.85).split(',')[1] };
  }
  async function addFiles(list) {
    for (const f of [...list]) {
      if (f.size > 40e6) { toast(`${f.name} is too large (max 40 MB)`); continue; }
      const item = { name: f.name || 'pasted-image.png', size: f.size, busy: true };
      pendingFiles.push(item); renderAttach();
      try {
        if (/^image\//.test(f.type)) Object.assign(item, await readImage(f));
        else {
          const pdf = f.type === 'application/pdf' || /\.pdf$/i.test(f.name);
          let r;
          if (Projects.online) {
            const res = await fetch('/api/extract?name=' + encodeURIComponent(f.name), { method: 'POST', body: f });
            r = await res.json(); if (!res.ok) throw new Error(r.error || res.statusText);
          } else r = pdf ? { text: '', error: 'PDF text needs the app server' } : { text: await f.text() };
          if (r.binary) throw new Error('binary file — no readable text (attach a PDF, image, text or Word file)');
          Object.assign(item, { kind: pdf ? 'pdf' : 'text', text: r.text || '', pages: r.pages || undefined });
          // Claude reads PDFs natively (text + figures); other models get the extracted text
          if (pdf && f.size < 20e6 && (r.pages || 0) <= 100) item.data = await toB64(f);
          if (r.error) item.warn = r.error; else if (r.truncated) item.warn = 'long file: only the first part of the text is included';
          else if (pdf && !(r.text || '').trim()) item.warn = 'no text layer (scanned PDF?) — only Claude models can read it';
        }
      } catch (e) { item.error = e.message; }
      item.busy = false; renderAttach();
    }
  }
  function toolHint(t) {
    const i = t.input || {};
    if (t.name === 'add_components') return (i.components || []).map(c => c.ref || c.type).join(', ');
    if (t.name === 'connect') return (i.connections || []).map(c => c.net).join(', ');
    if (t.name === 'update_component') return i.ref || '';
    if (t.name === 'remove_components') return (i.refs || []).join(', ');
    return '';
  }
  async function send(text) {
    const typed = text === undefined;
    text = (text ?? $('#prompt').value).trim();
    if (running) return;
    if (typed && pendingFiles.some(f => f.busy)) { toast('Still reading the attached files…'); return; }
    const files = typed ? pendingFiles.filter(f => !f.error).map(({ busy, size, warn, error, ...f }) => f) : [];
    if (!text && !files.length) return;
    if (!AI.modelReady()) { openSetup(); return; }   // keeps the typed text in the box
    if (!text) text = 'Please look at the attached file' + (files.length > 1 ? 's.' : '.');
    if (typed) { pendingFiles = []; renderAttach(); }
    $('#prompt').value = ''; lastError = null; running = true; setRunning(true);
    const checkpoint = mode === 'agent' ? Model.snapshot() : null;
    renderChat();
    await AI.run(text, mode, {
      checkpoint, files,
      onAssistant: () => renderChat(),
      onTool: () => renderChat(),
      onInfo: msg => { infoMsg = msg; renderChat(); },
      onError: msg => { lastError = msg; }
    });
    infoMsg = null;
    running = false; setRunning(false); renderChat();
  }
  function setRunning(on) { $('#btnSend').textContent = on ? '■ Stop' : 'Send'; $('#btnSend').classList.toggle('stop', on); }
  function setMode(m) {
    mode = m; $$('#modeSeg button').forEach(b => b.classList.toggle('on', b.dataset.mode === m));
    $('#modeHint').textContent = { agent: 'Agent: edits your design (checkpointed)', ask: 'Ask: read-only questions & review', plan: 'Plan: proposes a plan before building' }[m];
  }
  function renderModels() {
    const ms = AI.allModels(), cur = AI.settings.model;
    const grp = (p, label) => { const xs = ms.filter(m => m.provider === p); return xs.length ? `<optgroup label="${label}">` + xs.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('') + '</optgroup>' : ''; };
    // one group per saved provider, so models from several providers can be picked from one menu
    const byProv = AI.settings.providers.map(p => { const xs = ms.filter(m => m.pid === p.id); return xs.length ? `<optgroup label="${esc(p.name)}">` + xs.map(m => `<option value="${esc(m.id)}" ${m.id === cur ? 'selected' : ''}>${esc(m.label)}</option>`).join('') + '</optgroup>' : ''; }).join('');
    const html = grp('anthropic', 'Anthropic') + byProv;
    $('#modelSel').innerHTML = html || '<option value="">No AI model yet</option>';
    if (html && !AI.modelReady()) $('#modelSel').insertAdjacentHTML('afterbegin', '<option value="" selected>Choose a model…</option>');
    const ready = AI.modelReady();
    $('#btnConnect').classList.toggle('hidden', ready);
    $('#modelSel').classList.toggle('hidden', !html);
  }

  // default model per provider (used when connecting and whenever the model list is refreshed)
  function preferredModel(base, ids) {
    base = String(base || '');
    if (/generativelanguage\.googleapis\.com/.test(base)) return ids.find(id => id === 'gemini-flash-lite-latest') || ids.find(id => /flash-lite/.test(id) && !/preview|exp/.test(id)) || ids.find(id => /flash/.test(id)) || ids[0];
    if (/(^|\/\/|\.)ollama\.com/.test(base)) return ids.find(id => id === 'gpt-oss:120b') || ids.find(id => /gpt-oss/.test(id)) || ids[0];
    // other providers: skip models that cannot chat (embeddings, rerankers, safety / reward models, speech)
    const chat = ids.filter(id => !/embed|rerank|retriev|safety|guard|reward|tts|whisper|parakeet|canary|ocr|deplot|clip|kosmos/i.test(id)), pool = chat.length ? chat : ids;
    if (/integrate\.api\.nvidia\.com/.test(base)) return ['nvidia/nemotron-3-super-120b-a12b', 'moonshotai/kimi-k3', 'deepseek-ai/deepseek-v4.1-flash', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b'].find(id => pool.includes(id)) || pool[0];
    return pool[0];
  }

  // ---------- first run: connect an AI model (free Gemini / Ollama Cloud guides) ----------
  const SETUP = {
    gemini: {
      base: 'https://generativelanguage.googleapis.com/v1beta/openai',
      steps: ['Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a> and sign in with your Google account.',
        'Click <b>Create API key</b> (pick or create a project if Google asks).',
        'Copy the key. It starts with <code>AIza</code>. Paste it below.'],
      note: '<b>gemini-flash-lite-latest</b> is selected for you: fast, and it has the most generous free limits. Free, no credit card. The free plan has daily limits, and Google may use free-plan prompts to improve its products, so turning on billing in AI Studio is better for confidential designs.',
      pick: ids => {
        const chat = ids.filter(id => /gemini/i.test(id) && !/embed|image|tts|audio|live|vision|aqa|imagen|veo|learnlm|gemma/i.test(id));
        const list = chat.length ? chat : ids;
        return { list, model: preferredModel(SETUP.gemini.base, list) };
      },
    },
    ollama: {
      base: 'https://ollama.com/v1',
      steps: ['Create a free account at <a href="https://ollama.com/signup" target="_blank" rel="noopener">ollama.com/signup</a>.',
        'Open <a href="https://ollama.com/settings/keys" target="_blank" rel="noopener">ollama.com/settings/keys</a> and click <b>Add API key</b>.',
        'Give it a name, copy the key and paste it below.'],
      note: 'The free plan includes a usage allowance. <b>gpt-oss:120b</b> is selected for you: it handles the copilot\'s tool calls well (it designed the wearable in the demo video). On this web version, Ollama Cloud requests go through the CircuitPilot relay, because Ollama does not accept requests straight from web pages. The relay passes them on and stores nothing; its code is public in the repo.',
      pick: ids => ({ list: ids, model: preferredModel(SETUP.ollama.base, ids) }),
    },
    claude: {
      steps: ['Open <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener">console.anthropic.com/settings/keys</a> and sign in.',
        'Add credit under <b>Billing</b> (pay as you go), then click <b>Create Key</b>.',
        'Copy the key. It starts with <code>sk-ant-</code>. Paste it below.'],
      note: 'Paid per use. Claude gives the most reliable results on large designs.',
    },
    custom: {
      steps: ['Any service with an <b>OpenAI-compatible</b> API works: OpenAI, OpenRouter, Groq, Together, DeepSeek, Mistral, xAI, or your own server (vLLM, LM Studio, llama.cpp, Ollama).',
        'Enter its base URL (usually ending in <code>/v1</code>) and your key, then Connect. The models are loaded automatically.'],
      note: 'You can save several providers and switch between their models in the menu above the chat; manage them in ⚙ Settings. Some providers (NVIDIA, for example) do not accept requests straight from web pages; CircuitPilot then sends them through its relay (or your own server.py on the desktop version), which passes them on and stores nothing.',
    },
  };
  let setupTab = 'gemini';
  function setupRender() {
    const g = SETUP[setupTab];
    $$('#aiSetup .as-tabs button').forEach(b => b.classList.toggle('on', b.dataset.p === setupTab));
    $('#asGuide').innerHTML = `<ol>${g.steps.map(s => `<li>${s}</li>`).join('')}</ol>${g.note ? `<p class="muted small">${g.note}</p>` : ''}`;
    $('#asCustom').classList.toggle('hidden', setupTab !== 'custom');
    $('#asStatus').textContent = ''; $('#asStatus').className = 'muted';
    if ($('#asOpenSettings')) $('#asOpenSettings').onclick = () => { $('#aiSetup').classList.add('hidden'); openSettings(); };
  }
  function openSetup(tab) { if (tab) setupTab = tab; $('#asKey').value = ''; setupRender(); $('#aiSetup').classList.remove('hidden'); setTimeout(() => $('#asKey').focus(), 50); }
  async function setupConnect() {
    const key = $('#asKey').value.trim(), st = $('#asStatus'), g = SETUP[setupTab];
    if (!key && setupTab !== 'custom') { st.className = 'bad'; st.textContent = 'Paste your API key first'; return; }   // custom servers may need no key
    st.className = 'muted'; st.textContent = 'Checking the key…'; $('#asConnect').disabled = true;
    try {
      let model;
      if (setupTab === 'claude') {
        const r = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' } });
        if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(AI.friendlyError(r.status, j.error && j.error.message)); }
        model = AI.MODELS.find(m => /sonnet/.test(m.id)) || AI.MODELS[0];
        AI.saveSettings({ anthropicKey: key, model: model.id }); model = model.label;
      } else if (setupTab === 'custom') {
        const base = $('#asBase').value.trim().replace(/\/+$/, ''), name = $('#asName').value.trim();
        if (!/^https?:\/\/\S+/.test(base)) throw new Error('Enter the base URL, e.g. https://api.example.com/v1');
        const ids = await AI.fetchModels(base, key), pid = AI.saveProvider({ name, base, key, models: ids });
        model = preferredModel(base, ids); AI.saveSettings({ model: pid + '::' + model });
      } else {
        const ids = await AI.fetchModels(g.base, key), p = g.pick(ids);
        if (setupTab === 'ollama') {   // Ollama lists models without a key, so check the key with a one-token request
          const base = location.origin + '/llm-cloud/ollama/v1';   // server.py's proxy, or the relay on the web version
          const r = await fetch(base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key }, body: JSON.stringify({ model: p.model, messages: [{ role: 'user', content: 'hi' }], max_tokens: 1 }), signal: AbortSignal.timeout(30000) });
          if (!r.ok) { const j = await r.json().catch(() => ({})); throw new Error(AI.friendlyError(r.status, j.error && (j.error.message || j.error))); }
        }
        const pid = AI.saveProvider({ base: g.base, key, models: p.list });
        AI.saveSettings({ model: pid + '::' + p.model }); model = p.model;
      }
      renderModels(); renderChat(); AI.probeContext().then(updateCtx);
      st.className = 'good'; st.textContent = `✓ Connected · using ${model}. You can switch models in the menu above the chat.`;
      setTimeout(() => $('#aiSetup').classList.add('hidden'), 1800);
    } catch (e) {
      st.className = 'bad'; st.textContent = '✗ ' + (e.name === 'TimeoutError' ? 'The provider did not answer in time. Check your internet connection and try again.' : e.message);
    } finally { $('#asConnect').disabled = false; }
  }

  // ---------- settings ----------
  // ---------- saved providers (⚙ Settings) ----------
  let provEditing = null;
  function provRender() {
    const ps = AI.settings.providers;
    $('#provList').innerHTML = ps.length ? ps.map(p => { const n = String(p.models || '').split(',').filter(x => x.trim()).length;
      return `<div class="prov${p.id === provEditing ? ' editing' : ''}"><div class="pinfo"><b>${esc(p.name)}</b><span class="muted small">${esc(p.base)} · ${n} model${n === 1 ? '' : 's'}${p.key ? ' · key saved' : ''}</span></div><button data-pedit="${esc(p.id)}">Edit</button><button data-pdel="${esc(p.id)}" class="danger" title="Remove this provider">✕</button></div>`; }).join('')
      : '<div class="muted small">No providers saved yet. Pick a preset below or enter any OpenAI-compatible URL.</div>';
    $('#provFormTitle').textContent = provEditing ? 'Edit provider' : 'Add a provider';
  }
  function provFill(p) {
    provEditing = p ? p.id : null;
    $('#sPName').value = p ? p.name : ''; $('#sBase').value = p ? p.base : ''; $('#sOKey').value = p ? p.key : ''; $('#sOModels').value = p ? p.models : '';
    $('#sFetchStatus').textContent = ''; provRender();
  }
  function provSaveForm(quiet) {
    const base = $('#sBase').value.trim(); if (!base) { if (!quiet) toast('Enter the base URL of the provider'); return null; }
    const models = $('#sOModels').value.split(',').map(x => x.trim()).filter(Boolean);
    const pid = AI.saveProvider({ id: provEditing, name: $('#sPName').value, base, key: $('#sOKey').value, models });
    if (models.length && !AI.modelReady()) AI.saveSettings({ model: pid + '::' + preferredModel(base, models) });
    provFill(null); renderModels(); if (!quiet) toast('Provider saved');
    return pid;
  }
  function openSettings() {
    const s = AI.settings;
    $('#sAnth').value = s.anthropicKey; provFill(null);
    $('#sMax').value = s.maxTokens; $('#sCtxWin').value = +s.contextWindow > 0 ? s.contextWindow : ''; $('#sCtx').checked = !!s.includeContext; $('#sWeb').checked = s.webAccess !== false; $('#sBrave').value = s.braveKey || ''; $('#sRelay').value = s.relayUrl || '';
    $('#presets').innerHTML = Object.entries(AI.PRESETS).map(([n, u]) => `<button data-u="${esc(u)}">${esc(n)}</button>`).join('');
    $('#modal').classList.remove('hidden');
    archiveUi(); claudeUi();
  }
  // Settings → Claude Desktop (desktop version only: writes Claude Desktop's MCP settings on this PC)
  async function claudeUi() {
    const box = $('#sClaude'); if (!box) return;
    if (document.body.classList.contains('static-web')) { box.innerHTML = '<div class="muted small">Only in the desktop version (CircuitPilot.exe or server.py on your PC).</div>'; return; }
    let st; try { st = await AI.partsApi('claude-desktop'); } catch (e) { box.innerHTML = `<div class="dberr">${esc(e.message)}</div>`; return; }
    const state = st.connected ? (st.points_here ? '<span class="good">✓ connected to this CircuitPilot</span>' : '<span class="warn">connected to another CircuitPilot copy — Connect again to use this one</span>') : st.claude_installed ? '<span class="muted">not connected</span>' : '<span class="muted">Claude Desktop does not seem to be installed (claude.ai/download)</span>';
    box.innerHTML = `<div class="row archrow"><div style="flex:1"><div class="small">${state}</div><div class="muted small">${st.node ? '' : 'Node.js not found — install it from nodejs.org (the Windows app includes it)'}</div></div><button id="sClaudeGo" ${st.node ? '' : 'disabled'}>${st.connected ? 'Connect again' : 'Connect'}</button></div>`;
    $('#sClaudeGo').onclick = async () => {
      try { const r = await AI.partsApi('claude-desktop/connect', { method: 'POST' }); toast('CircuitPilot added to Claude Desktop. ' + r.next, 12000); }
      catch (e) { toast('Could not connect Claude Desktop: ' + e.message, 9000); }
      claudeUi();
    };
  }
  // Settings → Parts archives: status, download / update, progress
  let archTimer = null;
  async function archiveUi() {
    clearTimeout(archTimer);
    const box = $('#sArch'); if (!box || $('#modal').classList.contains('hidden')) return;
    let st; try { st = await AI.partsApi('archive'); } catch (e) { box.innerHTML = `<div class="dberr">${esc(e.message)}</div>`; return; }
    let busy = false;
    box.innerHTML = ['basic', 'full'].map(k => {
      const a = st[k] || {}, j = a.job; if (j && j.state !== 'error') busy = true;
      const state = j ? (j.state === 'error' ? `<span class="bad">failed: ${esc(j.error || '')}</span>` : j.state === 'indexing' ? 'building the search index…' : `downloading ${j.total ? Math.round(100 * j.done / j.total) + '%' : (j.done / 1e6).toFixed(0) + ' MB'}…`)
        : a.present ? `<span class="good">✓ ${a.updated || ''}</span>${a.parts ? ` · ${a.parts.toLocaleString()} parts` : ''}${k === 'full' && a.indexed === false ? ' · <span class="warn">not indexed</span>' : ''}` : '<span class="muted">not downloaded</span>';
      const off = a.desktop_only ? ' disabled title="Desktop version only (server.py)"' : j && j.state !== 'error' ? ' disabled' : '';
      return `<div class="row archrow"><div style="flex:1"><b>${esc(a.name || k)}</b> <span class="muted small">${esc(a.size_about || '')}${k === 'basic' ? ' · Basic + Preferred parts only' : ' · every JLCPCB part in stock'}</span><div class="small">${state}</div></div><button data-arch="${k}"${off}>${a.present ? 'Update' : 'Download'}</button></div>`;
    }).join('');
    box.querySelectorAll('[data-arch]').forEach(b => b.onclick = async () => {
      b.disabled = true; b.textContent = 'Starting…';
      try { const r = await AI.partsApi('archive/download?kind=' + b.dataset.arch, { method: 'POST' }); if (r && r.done) toast(`Basic Parts Archive saved: ${(r.parts || 0).toLocaleString()} parts`); }
      catch (e) { toast('Archive download failed: ' + e.message, 8000); }
      archiveUi();
    });
    if (busy) archTimer = setTimeout(archiveUi, 1500);
  }
  let fetchSeq = 0;
  async function fetchModelsUI() {
    const base = $('#sBase').value.trim(), st = $('#sFetchStatus'), seq = ++fetchSeq;
    if (!base) { st.textContent = ''; return; }
    st.className = 'muted'; st.textContent = 'Fetching models…';
    try {
      const ids = await AI.fetchModels(base, $('#sOKey').value.trim());
      if (seq !== fetchSeq) return;
      $('#sOModels').value = ids.join(', ');
      st.className = 'good'; st.textContent = `✓ ${ids.length} model${ids.length > 1 ? 's' : ''} found`;
    } catch (e) {
      if (seq !== fetchSeq) return;
      st.className = 'bad'; st.textContent = '✗ ' + (e.name === 'TimeoutError' ? 'Timed out' : e.message);
    }
  }
  async function autoFetchModels() { // on startup, refresh each saved provider's model list (quietly)
    for (const p of AI.settings.providers.slice()) {
      try {
        const ids = await AI.fetchModels(p.base, p.key);
        AI.saveProvider(Object.assign({}, p, { models: ids }));
        if (String(AI.settings.model).startsWith(p.id + '::') && !ids.includes(AI.settings.model.slice(p.id.length + 2))) AI.saveSettings({ model: p.id + '::' + preferredModel(p.base, ids) });
      } catch (e) { }
    }
    if (!AI.modelReady()) { const m = AI.allModels()[0]; if (m) AI.saveSettings({ model: m.id }); }
    renderModels();
  }
  function saveSettings() {
    if ($('#sBase').value.trim()) provSaveForm(true);   // a provider typed in the form but not saved yet
    AI.saveSettings({ anthropicKey: $('#sAnth').value.trim(), maxTokens: +$('#sMax').value || 8192, contextWindow: +$('#sCtxWin').value || 0, includeContext: $('#sCtx').checked, webAccess: $('#sWeb').checked, braveKey: $('#sBrave').value.trim(), relayUrl: $('#sRelay').value.trim() });
    $('#modal').classList.add('hidden'); renderModels(); AI.probeContext().then(updateCtx); toast('Settings saved (stored only in this browser)');
  }

  // ---------- exports ----------
  // a project file's content → a new project (import, or a file opened from a PC folder)
  async function openProjectData(d, name) {
    delete d.id; if (!d.name) d.name = name;
    Model.load(d); Projects.markLoaded(); await Projects.saveNow(); Projects.close(); Sch.fit();
  }
  // ---------- everything at once: one zip with every file of the project, sorted in folders ----------
  async function exportAll(opts = {}) {
    const S = Model.S, base = Exports.slug(S.name), files = {}, skipped = [], hasPcb = !!(S.board.w && Pcb.placed().length);
    const add = (n, d) => { files[base + '/' + n] = d; };
    const b64bytes = d => Uint8Array.from(atob(d), ch => ch.charCodeAt(0));
    toast('Exporting everything…', 30000);
    add(base + '.circuit.json', Exports.project()); add(base + '-bom.csv', Exports.bom()); add(base + '.net', Exports.netlist());
    if (S.components.length) add(base + '-schematic.svg', Sch.exportSVG());
    if (hasPcb) {
      for (const [n, t] of Object.entries(Pcb.gerbers())) add('gerbers/' + n, t);
      add('jlcpcb/' + base + '-BOM-JLCPCB.csv', Exports.bomJlc()); add('jlcpcb/' + base + '-CPL-JLCPCB.csv', Exports.cpl());
      add(base + '-pcb.svg', Pcb.exportSVG());
      try { const e = Enclosure.exportFiles(); for (const [n, d] of Object.entries(e.files)) add('enclosure/' + n, d); } catch (e) { skipped.push('enclosure: ' + e.message); }
      try { const sch = EasyEDA.exportSchematic({}), pcb = EasyEDA.exportPcb(); add('easyeda/SCH_' + base + '.json', sch); add('easyeda/PCB_' + base + '.json', pcb); } catch (e) { skipped.push('EasyEDA: ' + e.message); }
    } else skipped.push('PCB files (no PCB yet)');
    const shots = [['schematic', 'schematic.png', { sheet: 1 }]].concat(Sch.sheets().slice(1).map((_, i) => ['schematic', `schematic-sheet${i + 2}.png`, { sheet: i + 2 }]))
      .concat(hasPcb ? [['pcb', 'pcb-2d.png', {}], ['pcb_3d', 'pcb-3d.png', { side: 'iso' }], ['pcb_3d', 'pcb-3d-top.png', { side: 'top' }], ['pcb_3d', 'pcb-3d-bottom.png', { side: 'bottom' }], ['enclosure', 'enclosure.png', {}]] : []);
    if (opts.images !== false) for (const [view, name, a] of shots) { try { const r = await renderForAI(Object.assign({ view, full: true }, a)); add('images/' + name, b64bytes(r.data)); } catch (e) { skipped.push(name + ': ' + e.message); } }
    if (opts.pdf !== false) {
      if (hasPcb) try { const r = await PcbPdf.export({ blob: true }); add(base + '-pcb-drawing.pdf', new Uint8Array(await r.blob.arrayBuffer())); } catch (e) { skipped.push('PCB drawing PDF: ' + e.message); }
      try { const b = await DocView.pdf({ blob: true }); if (b) add(base + '-datasheet.pdf', new Uint8Array(await b.arrayBuffer())); } catch (e) { skipped.push('datasheet PDF: ' + e.message); }
    }
    download(base + '-all.zip', makeZip(files));
    toast(`Exported ${Object.keys(files).length} files in ${base}-all.zip${skipped.length ? ' · skipped: ' + skipped.join('; ') : ''}`, 12000);
    return { zip: base + '-all.zip', files: Object.keys(files).map(n => n.slice(base.length + 1)), skipped };
  }
  function exportAs(kind) {
    const S = Model.S;
    try {
      if (kind === 'json') download(fname('.circuit.json'), JSON.stringify(S, null, 1), 'application/json');
      if (kind === 'gerber') { gerberCheck(); return; }
      if (kind === 'svg') download(fname('-schematic.svg'), Sch.exportSVG(), 'image/svg+xml');
      if (kind === 'easyeda' || kind === 'easyedaproj' || kind === 'easyedapcb') {
        if (!S.components.length) throw new Error('The schematic is empty');
        easyedaExport(kind === 'easyedaproj' ? 'project' : kind === 'easyedapcb' ? 'pcb' : 'sch');
        return;
      }
      if (kind === 'all') { exportAll().catch(e => toast('Export failed: ' + e.message, 8000)); return; }
      if (kind === 'pcbpdf') { toast('Making the PCB drawing…', 8000); PcbPdf.export().then(r => toast(`PCB drawing saved: ${r.pages} pages, ${r.scale === 1 ? 'true scale 1:1 — print at 100% (actual size)' : 'scaled to fit the page'}`, 9000)).catch(e => toast('PDF failed: ' + e.message, 8000)); return; }
      if (kind === 'pcbsvg') { if (!S.board.w) throw new Error('No PCB yet'); if (view !== 'pcb') Pcb.render(); download(fname('-pcb.svg'), Pcb.exportSVG(), 'image/svg+xml'); }
      if (kind === 'bomjlc') { jlcBom(); return; }
      if (kind === 'bom') {
        const g = {};
        for (const c of S.components) { const k = [c.type, c.value, c.footprint].join('|'); (g[k] = g[k] || []).push(c.ref); }
        const csv = 'Qty,References,Type,Value,Footprint\n' + Object.entries(g).map(([k, refs]) => { const [t, v, f] = k.split('|'); return `${refs.length},"${refs.join(' ')}",${t},"${v.replace(/"/g, '""')}",${f}`; }).join('\n');
        download(fname('-bom.csv'), csv, 'text/csv');
      }
      if (kind === 'net') {
        let s = '(export (version "E")\n  (design (source "CircuitPilot"))\n  (components\n';
        for (const c of S.components) s += `    (comp (ref "${c.ref}") (value "${c.value}") (footprint "${c.footprint}"))\n`;
        s += '  )\n  (nets\n';
        Object.entries(S.nets).forEach(([n, keys], i) => { s += `    (net (code "${i + 1}") (name "${n}")\n` + keys.map(k => { const [r, p] = [k.slice(0, k.indexOf('.')), k.slice(k.indexOf('.') + 1)]; return `      (node (ref "${r}") (pin "${p}"))`; }).join('\n') + ')\n'; });
        download(fname('.net'), s + '  )\n)\n');
      }
    } catch (e) { toast(e.message); }
  }

  // ---------- init ----------
  function init() {
    Sch.init($('#schSvg')); Pcb.init($('#pcbSvg')); PcbView.bindBar();
    Sch.ui.onSelect = () => { syncFromSch(); renderProps(); }; Pcb.ui.onSelect = () => { syncFromPcb(); renderProps(); };
    Sch.ui.onContext = showCtx; PcbView.ui.onContext = showCtx;
    document.addEventListener('mousedown', e => { if (!e.target.closest('#ctxMenu')) hideCtx(); }, true);
    window.addEventListener('blur', hideCtx); window.addEventListener('resize', hideCtx);
    let saved = null; try { saved = localStorage.getItem('cp.design'); } catch (e) { }
    if (saved) try { Model.load(saved); } catch (e) { }
    // drags fire 'move' on every mouse event: redraw at most once per frame so big boards stay smooth
    let moveFrame = 0;
    Model.subscribe(kind => {
      if (kind !== 'move') { Pcb.ui.drc = null; if (moveFrame) { cancelAnimationFrame(moveFrame); moveFrame = 0; } renderAll(); return; }
      if (!moveFrame) moveFrame = requestAnimationFrame(() => { moveFrame = 0; if (view === 'sch') Sch.render(); else if (view === 'pcb') Pcb.render(); });
    });
    initTheme();
    PartEditor.init();
    // tell open tabs (phone, other PCs) when the app has been updated
    (async () => {
      const ver = async () => { try { return (await (await fetch('/api/version')).json()).version; } catch (e) { return null; } };
      const mine = await ver(); if (!mine) return;
      setInterval(async () => {
        const v = await ver(); if (!v || v === mine || $('#updBar')) return;
        const b = document.createElement('div'); b.id = 'updBar';
        b.innerHTML = 'CircuitPilot was updated. <button>Reload now</button>'; b.querySelector('button').onclick = () => location.reload();
        document.body.appendChild(b);
      }, 30000);
    })();
    Engine.env.myLib = () => Projects.myLib;
    Engine.env.savePart = def => Projects.savePart(def).then(() => renderParts());
    Engine.env.route = runRouter;
    Engine.env.shape = code => EncView.runScript(code);
    Engine.env.searchKey = () => AI.settings.braveKey;
    Engine.env.render = renderForAI;
    Engine.env.exportAll = exportAll;
    Engine.env.ui = what => { if (what === 'fit-sch') Sch.fit(); if (what === 'show-pcb') { showView('pcb'); Pcb.fit(); } if (what === 'show-enc') { showView('enc'); EncView.rebuild(); } if (what === 'show-doc') showView('doc'); };
    EncView.init(); Pcb3D.init(); DocView.init();
    $('#btn3d').onclick = () => { const on = !Pcb3D.ui.on; PcbView.setVisible(!on); Pcb3D.setOn(on); };
    initKnowledge();
    Projects.init().then(renderParts);
    Folder.init();

    renderParts(); renderModels(); setMode('agent'); renderChat(); renderAll(); AI.probeContext().then(updateCtx).catch(() => { });
    requestAnimationFrame(() => Sch.fit());

    $('#partSearch').oninput = () => { renderParts(); searchDb($('#partSearch').value); };
    $('#partSearch').onkeydown = e => { if (e.key === 'Enter') { clearTimeout(dbTimer); searchDb($('#partSearch').value); } };
    $('#btnLibrary').onclick = () => LibPanel.open($('#partSearch').value.trim());
    $('#partList').addEventListener('dragstart', e => {
      const ml = e.target.closest('.mylib'), d = e.target.closest('.dbpart'), b = e.target.closest('.part');
      if (ml) LibPanel.dragData(e, 'lib', ml.dataset.key); else if (d) LibPanel.dragData(e, 'db', d.dataset.lcsc); else if (b) LibPanel.dragData(e, 'type', b.dataset.type);
    });
    LibPanel.initDrop($('#schSvg'), (x, y) => Sch.vp.toWorld(x, y));
    $('#partList').onclick = e => {
      const ed = e.target.closest('[data-edit]'); if (ed) { const m = Projects.myLib.find(p => p.key === ed.dataset.edit); if (m) PartEditor.open(m, { key: m.key, saveLib: true, allowPlace: true }); return; }
      const dl = e.target.closest('[data-del]'); if (dl) { if (confirm('Remove this part from My Library? (Designs that use it keep their copy.)')) Projects.deletePart(dl.dataset.del).then(renderParts).catch(err => toast(err.message)); return; }
      const ml = e.target.closest('.mylib'); if (ml) { placeLibPart(ml.dataset.key); return; }
      const d = e.target.closest('.dbpart'); if (d) { placeDbPart(d.dataset.lcsc); return; }
      const b = e.target.closest('.part'); if (b) { if (view !== 'sch') showView('sch'); placeBuiltin(b.dataset.type); }
    };
    $$('.tab').forEach(b => b.onclick = () => showView(b.dataset.view));
    $('#btnLayout').onclick = () => { Model.mutate(() => Model.autoLayout()); Sch.fit(); };
    $('#btnDbParts').onclick = async () => { toast('Loading JLCPCB parts…', 15000); const r = await Engine.useDatabaseParts(); toast(r.converted.length ? `${r.converted.length} parts now use real JLCPCB footprints${r.failed.length ? ' · ' + r.failed.length + ' failed' : ''}` : 'Every part already uses a database footprint', 6000); };
    $('#btnFitS').onclick = () => Sch.fit(); $('#btnFitP').onclick = () => Pcb.fit();
    $('#connStyle').value = Model.S.connStyle || 'auto';
    $('#connStyle').onchange = e => Model.mutate(() => { Model.S.connStyle = e.target.value; });
    $('#btnErc').onclick = () => { renderStatus(); $('#ercLink').click(); };
    const routeMsg = r => r && r.routing && r.routing.stopped ? `Stopped — kept the best routing found (${r.routing.unrouted ? r.routing.unrouted + ' nets unrouted' : 'all nets routed'})` : r && r.routing ? `Routed ${r.routing.routed}/${r.routing.total} nets${r.routing.failed.length ? ' — unrouted: ' + r.routing.failed.join(', ') : ''}${r.routing.necked_down && r.routing.necked_down.length ? ' · necked down: ' + r.routing.necked_down.join(', ') : ''}${r.routing.seconds ? ` · ${r.routing.seconds}s` : ''}${r.routing.failed.length ? ' — try ✨ Optimize (moves parts) or ⬛ Pour GND' : ''}` : 'Placed — press Route';
    const runPcb = async (place, noRoute) => { try { const r = await runRouter({ place, opt: { noRoute } }); Pcb.fit(); const pl = r && r.placement, bad = pl && pl.fits === false; toast(routeMsg(r) + (bad ? ' · ⚠ ' + pl.hint : ''), bad ? 12000 : 6000); if (!noRoute) showDrc(); } catch (e) { toast(e.message); } };
    // empty Board W×H boxes = size the board to the parts; otherwise the outline is kept and the parts are fitted inside
    const boardWH = () => { const w = +$('#boardW').value || 0, h = +$('#boardH').value || 0; return w > 0 && h > 0 ? { w, h } : { fit: true }; };
    $('#btnGen').onclick = () => runPcb(boardWH(), false);
    $('#btnPlace').onclick = () => {};   // menu: AI place / quick place
    $$('[data-place]').forEach(b => b.onclick = () => { document.activeElement && document.activeElement.blur(); if (b.dataset.place === 'ai') aiPlace(); else runPcb(boardWH(), true); });
    $('#btnRoute').onclick = () => runPcb(null, false);
    $('#btnSync').onclick = updateFromSchematic;
    $('#btnRules').onclick = openRules; $('#btnDrc').onclick = () => showDrc(true);
    $('#btnOptimize').onclick = () => {};
    $$('[data-opt]').forEach(b => b.onclick = () => { document.activeElement && document.activeElement.blur(); runOptimize({ shrink: b.dataset.opt !== 'route', allow_bottom: b.dataset.opt === 'bottom' }); });
    $('#btnPourGnd').onclick = () => {
      const S = Model.S, net = S.nets.GND ? 'GND' : prompt('Net for the copper pour', Object.keys(S.nets)[0] || 'GND');
      if (!net) return;
      try { Model.mutate(() => Pcb.addPour({ net, layer: 'both' })); showView('pcb'); toast(`${net} poured on both layers`); } catch (e) { toast(e.message); }
    };
    $('#btnShape').onclick = () => { const b = Model.S.board, sh = b.shape || { type: 'rect' }; $('#shType').value = sh.type; $('#shW').value = b.w || ''; $('#shH').value = b.h || ''; $('#shR').value = sh.r || (sh.type === 'rounded' ? 3 : 0); $('#shapeModal').classList.remove('hidden'); };
    $('#shapeClose').onclick = () => $('#shapeModal').classList.add('hidden');
    $('#shApply').onclick = () => {
      const type = $('#shType').value;
      if (type === 'polygon' && !(Model.S.board.shape && Model.S.board.shape.pts)) { $('#shDraw').click(); return; }
      try {
        const r = Model.mutate(() => Pcb.setBoardShape({ shape: type, width: +$('#shW').value, height: +$('#shH').value, corner_radius: +$('#shR').value, points: Model.S.board.shape && Model.S.board.shape.pts }));
        $('#shapeModal').classList.add('hidden'); showView('pcb'); Pcb.fit();
        toast(r.outside.length ? `⚠ Outside the outline: ${r.outside.join(', ')} — Generate PCB or move them` : 'Board outline updated');
      } catch (e) { toast(e.message); }
    };
    $('#shDraw').onclick = () => { $('#shapeModal').classList.add('hidden'); showView('pcb'); PcbView.drawOutline(+$('#shR').value); };
    initGerberCheck();
    $('#routeCancel').onclick = () => {
      if (aiPlaceCtl && !worker) { aiPlaceCtl.abort(); return; }   // stop an AI place request
      if (!worker) return;
      worker.terminate(); worker = null; $('#routeBusy').classList.add('hidden');
      if (routeBest) {   // stop = keep the best routing found so far
        const b = routeBest; routeBest = null;
        Model.mutate(() => {
          if (b.positions) for (const [ref, pcb] of b.positions) { const c = Model.comp(ref); if (c) c.pcb = pcb; }
          if (b.board) Model.S.board = b.board;
          Model.S.pcb = b.pcb;
        });
        Pcb.ui.drc = null;
        toast(`Stopped — kept the best result so far (${b.unrouted ? b.unrouted + ' nets unrouted' : 'all nets routed'})`, 5000);
        if (routeResolve) routeResolve({ routing: { stopped: true, unrouted: b.unrouted } });
      } else if (routeReject) routeReject(new Error('Routing cancelled'));
    };
    initRules();
    $('#btnUnroute').onclick = () => Model.mutate(() => { Model.S.pcb = Object.assign({}, Model.S.pcb, { traces: [], vias: [], routed: {} }); });
    const setBoard = () => Model.mutate(() => { const w = +$('#boardW').value, h = +$('#boardH').value; if (w > 0 && h > 0) { Model.S.board = { w, h }; Model.S.pcb = Object.assign({}, Model.S.pcb, { traces: [], vias: [], routed: {} }); } });
    $('#boardW').onchange = setBoard; $('#boardH').onchange = setBoard;
    $$('[data-layer]').forEach(cb => cb.onchange = () => { Pcb.ui.show[cb.dataset.layer] = cb.checked; Pcb.render(); });
    $('#btnGerber').onclick = () => exportAs('gerber');
    $('#btnOrderPcb').onclick = orderPcb;

    $('#btnUndo').onclick = () => Model.undo(); $('#btnRedo').onclick = () => Model.redo();
    $('#btnProjects').onclick = () => Projects.show();
    $('#btnNew').onclick = () => {
      if (!Projects.online) { if (confirm('Start a new empty design? (You can undo.)')) { Model.mutate(() => Model.clear()); Sch.select(null); } return; }
      const n = prompt('New project name', 'New project'); if (n !== null) Projects.create(n.trim() || 'Untitled');
    };
    $('#btnSave').onclick = async () => {
      const toFolder = Folder.onSave();   // also the PC folder this project is linked to (asks for permission again if needed)
      if (!Projects.online) { if (!(await toFolder)) exportAs('json'); else toast('Saved to ' + Folder.linked); return; }
      const ok = await Projects.saveNow(), fd = await toFolder;
      toast(ok ? 'Project saved' + (fd ? ' · also in ' + Folder.linked : '') : 'Save failed — see the status next to the name');
    };
    $('#btnSaveAs').onclick = async () => {
      if (!Projects.online) { exportAs('json'); return; }
      const n = prompt('Save project as', (Model.S.name || 'Untitled') + ' (copy)'); if (n === null) return;
      try { await Projects.saveAs(n.trim() || 'Untitled'); } catch (e) { toast('Save as failed: ' + e.message); }
    };
    $('#btnNewPart').onclick = () => PartEditor.open(PartEditor.blankDef(), { isNew: true, saveLib: true, allowPlace: true });
    $('#fileIn').onchange = async e => {
      const f = e.target.files[0]; if (!f) return;
      try {
        if (EasyEDAPro.isPro(f.name)) {   // EasyEDA Pro project → new project with schematic sheets, parts, nets and the PCB
          toast('Reading the EasyEDA Pro project…', 20000);
          const P = await EasyEDAPro.read(await f.arrayBuffer());
          let i = 0;
          if (P.boards.length > 1) {
            const list = P.boards.map((b, k) => `${k + 1}: ${b.name}${b.schematic ? ' — schematic ' + b.schematic : ''}${b.pcbName ? ' — PCB ' + b.pcbName : ''}`).join('\n');
            const a = prompt('This project has several boards. Which one to import?\n' + list, '1'); if (a === null) { toast('Import cancelled'); e.target.value = ''; return; }
            i = Math.min(P.boards.length, Math.max(1, parseInt(a, 10) || 1)) - 1;
          }
          const nd = Model.blank(); nd.name = P.boards[i].name || f.name.replace(/\.(epro2?|zip)$/i, ''); Model.load(nd);
          const r = await EasyEDAPro.importBoard(P, i);
          Projects.markLoaded(); await Projects.saveNow(); Projects.close();
          if (r.tracks || r.board_mm) { showView('pcb'); Pcb.fit(); } else Sch.fit();
          toast(`Imported ${r.format}: ${r.components} parts, ${r.nets} nets${r.sheets ? ', ' + r.sheets + ' sheet' + (r.sheets > 1 ? 's' : '') : ''}${r.board_mm ? `, PCB ${r.board_mm[0]} × ${r.board_mm[1]} mm with ${r.tracks} tracks, ${r.vias} vias` : ''}${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`, 12000);
          e.target.value = ''; return;
        }
        const d = JSON.parse(await f.text()), name = f.name.replace(/\.circuit\.json$|\.json$/i, '');
        const ee = EasyEDA.isEasyEDA(d);
        if (ee === 'schematic') throw new Error('this is an EasyEDA schematic — export the PCB document from EasyEDA (File → Export → EasyEDA Source) and import that');
        if (ee) {   // EasyEDA PCB → new project with parts, footprints, nets, tracks and a generated schematic
          const nd = Model.blank(); nd.name = name; Model.load(nd);
          const r = Model.mutate(() => EasyEDA.importPcb(d));
          Projects.markLoaded(); await Projects.saveNow(); Projects.close(); showView('pcb'); Pcb.fit();
          toast(`Imported EasyEDA PCB: ${r.components} parts, ${r.nets} nets, ${r.tracks} tracks, ${r.vias} vias${r.notes.length ? ' — ' + r.notes.join('; ') : ''}`, 9000);
          e.target.value = ''; return;
        }
        await openProjectData(d, name); toast('Imported ' + f.name + ' as a new project');
      } catch (err) { toast('Could not open: ' + err.message); }
      e.target.value = '';
    };
    $('#projName').onchange = e => Model.mutate(() => { Model.S.name = e.target.value.trim() || 'Untitled'; });
    $$('[data-exp]').forEach(b => b.onclick = () => exportAs(b.dataset.exp));

    // copilot
    $$('#modeSeg button').forEach(b => b.onclick = () => setMode(b.dataset.mode));
    $('#modelSel').onchange = e => AI.saveSettings({ model: e.target.value });
    $('#btnSend').onclick = () => running ? AI.stop() : send();
    $('#prompt').onkeydown = e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
    $('#btnNewChat').onclick = () => { if (running) return; AI.reset(); lastError = null; renderChat(); };
    // attachments: 📎 button, paste, drag & drop
    $('#btnAttach').onclick = () => $('#chatFiles').click();
    $('#chatFiles').onchange = e => { addFiles(e.target.files); e.target.value = ''; };
    $('#attachList').onclick = e => { const x = e.target.closest('.x'); if (x) { pendingFiles.splice(+x.dataset.i, 1); renderAttach(); } };
    $('#prompt').addEventListener('paste', e => { const fs = [...(e.clipboardData?.files || [])]; if (fs.length) { e.preventDefault(); addFiles(fs); } });
    const ci = $('.cp-input');
    ci.addEventListener('dragover', e => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); ci.classList.add('drop'); } });
    ci.addEventListener('dragleave', () => ci.classList.remove('drop'));
    ci.addEventListener('drop', e => { ci.classList.remove('drop'); if (e.dataTransfer.files.length) { e.preventDefault(); addFiles(e.dataTransfer.files); } });
    $('#btnWeb').onclick = () => { AI.saveSettings({ webAccess: AI.settings.webAccess === false }); updateCtx(); toast(AI.settings.webAccess ? '🌐 Web search on' : 'Web search off'); };
    $('#btnFolder').onclick = () => $('#btnKnow').click();
    $('#autoCompress').onchange = e => { AI.saveSettings({ autoCompress: e.target.checked }); updateCtx(); };
    $('#btnCompress').onclick = async () => {
      if (running) return;
      running = true; setRunning(true); infoMsg = 'Compressing the conversation…'; lastError = null; renderChat();
      try { toast((await AI.compress()) ? 'Conversation compressed' : 'Nothing to compress yet'); }
      catch (e) { lastError = 'Compress failed: ' + (e.name === 'AbortError' ? 'stopped' : e.message); }
      running = false; infoMsg = null; setRunning(false); renderChat();
    };
    $('#modelSel').addEventListener('change', () => AI.probeContext().then(updateCtx));
    Model.subscribe(k => { if (k !== 'move') updateCtx(); });
    $('#chat').onclick = e => {
      const s = e.target.closest('.sugg'); if (s) { send(s.textContent); return; }
      const im = e.target.closest('img.thumb'); if (im) { im.classList.toggle('big'); return; }
      if (e.target.closest('.exec')) { setMode('agent'); send('Execute the plan above step by step.'); return; }
      const r = e.target.closest('.restore');
      if (r) { const m = AI.history[+r.dataset.i]; if (m && m.checkpoint && confirm('Restore the design to the checkpoint taken before this message? (Undo is available.)')) { Model.load(m.checkpoint, true); Sch.fit(); toast('Checkpoint restored'); } }
    };

    // settings
    $('#btnSettings').onclick = openSettings;
    $('#sCancel').onclick = () => $('#modal').classList.add('hidden');
    $('#sSave').onclick = saveSettings;
    $('#presets').onclick = e => { const b = e.target.closest('button'); if (b) { const p = AI.settings.providers.find(x => x.base === b.dataset.u); if (p) provFill(p); else { provEditing = null; $('#sPName').value = b.textContent.trim(); $('#sBase').value = b.dataset.u; $('#sOKey').value = ''; $('#sOModels').value = ''; provRender(); } fetchModelsUI(); } };
    $('#provSave').onclick = () => provSaveForm(false);
    $('#provNew').onclick = () => provFill(null);
    $('#provList').onclick = e => {
      const ed = e.target.closest('[data-pedit]'), del = e.target.closest('[data-pdel]');
      if (ed) provFill(AI.settings.providers.find(p => p.id === ed.dataset.pedit));
      if (del) { const p = AI.settings.providers.find(x => x.id === del.dataset.pdel); if (p && confirm(`Remove ${p.name}? Its key is deleted from this browser.`)) { AI.removeProvider(p.id); if (provEditing === p.id) provFill(null); provRender(); renderModels(); } }
    };
    $('#sFetch').onclick = fetchModelsUI;
    let ft; $('#sBase').oninput = $('#sOKey').oninput = () => { clearTimeout(ft); ft = setTimeout(fetchModelsUI, 600); };
    autoFetchModels();
    // first run (or no model set up in this browser): open the connect dialog
    $('#btnConnect').onclick = () => openSetup();
    $('#asClose').onclick = () => $('#aiSetup').classList.add('hidden');
    $('#aiSetup .as-tabs').onclick = e => { const b = e.target.closest('button[data-p]'); if (b) { setupTab = b.dataset.p; setupRender(); } };
    $('#asConnect').onclick = setupConnect;
    $('#asKey').onkeydown = e => { if (e.key === 'Enter') setupConnect(); };
    $('#chat').addEventListener('click', e => { if (e.target.closest('[data-connect]')) openSetup(); });
    $('#chat').addEventListener('click', e => { const i = e.target.closest('img.shot'); if (i) i.classList.toggle('big'); });
    if (!AI.modelReady()) setTimeout(() => { if (!AI.modelReady()) openSetup(); }, 600);

    document.addEventListener('keydown', e => {
      if (!$('#edModal').classList.contains('hidden')) { if (PartEditor.key(e)) e.preventDefault(); return; }
      if (!$('#projModal').classList.contains('hidden')) { if (e.key === 'Escape') Projects.close(); return; }
      if (!$('#knowModal').classList.contains('hidden')) { if (e.key === 'Escape') $('#knowModal').classList.add('hidden'); return; }
      for (const id of ['#gerberModal', '#shapeModal', '#rulesModal', '#aiSetup']) if (!$(id).classList.contains('hidden')) { if (e.key === 'Escape') $(id).classList.add('hidden'); return; }
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName)) return;
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? Model.redo() : Model.undo(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); Model.redo(); return; }
      if (e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === 'f') { e.preventDefault(); LibPanel.open(); return; }   // Shift+F: library, as in EasyEDA
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btnSaveAs').click(); return; }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); $('#btnSave').click(); return; }
      if (view === 'enc') return;
      if (e.key === 'Escape') hideCtx();
      if ((view === 'sch' || view === 'pcb') && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
        const k = e.key.toLowerCase(), a = { c: 'copy', x: 'cut', v: 'paste', d: 'dup', a: 'all' }[k];
        if (a) { e.preventDefault(); act(a); return; }
      }
      if (e.key === 'f' || e.key === 'F') { view === 'sch' ? Sch.fit() : Pcb.fit(); return; }
      if ((view === 'sch' ? Sch : Pcb).key(e)) e.preventDefault();
    });
    // right-click belongs to CircuitPilot (pan, context menu, finish a track): the browser menu only appears in
    // text fields. On Windows the event fires on mouse-up, often over our own menu that just opened.
    document.addEventListener('contextmenu', e => { if (!e.target.closest('input, textarea, [contenteditable="true"], .allow-ctx')) e.preventDefault(); });
  }
  return { init, toast, showView, renderAll, placeLibPart, placeDbPart, placeBuiltin, refreshParts: () => renderParts(), download, openProjectData, exportProject: () => exportAs('json') };
})();
window.addEventListener('DOMContentLoaded', App.init);
