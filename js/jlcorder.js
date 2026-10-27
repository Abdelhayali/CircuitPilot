'use strict';
// Order the PCB at JLCPCB through the JLCPCB Open API (server.py /api/jlc/…, which holds the keys): the Gerbers are
// uploaded, JLCPCB prices them live (quantity, colour, finish, build time, shipping), and "Place order" creates the
// order on the user's JLCPCB account — it is then paid on jlcpcb.com. Without API keys the old flow (files + quote
// page) runs instead.
const JlcOrder = (() => {
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const COLORS = [[0, 'Green'], [1, 'Red'], [2, 'Yellow'], [3, 'Blue'], [4, 'White'], [5, 'Black'], [6, 'Purple']];
  const FINISH = [[1, 'Lead-free HASL'], [0, 'HASL (with lead)'], [2, 'ENIG'], [3, 'OSP']];
  const QTY = [5, 10, 15, 20, 25, 30, 40, 50, 75, 100, 150, 200, 250, 300, 500];
  const ADDR = [['firstName', 'First name'], ['lastName', 'Last name'], ['companyName', 'Company (optional)'], ['streetAddress', 'Street address'], ['addressLine2', 'Address line 2 (optional)'], ['city', 'City'], ['province', 'State / province'], ['postalCode', 'Postal code'], ['country', 'Country code (e.g. EG, US, DE)'], ['cellOrMobileNumber', 'Phone'], ['taxNumber', 'Tax / VAT number (optional)']];
  let st = null, statusCache = null;

  async function call(path, body, raw) {
    const r = await fetch('/api/jlc/' + path, body === undefined ? {} : { method: 'POST', headers: raw ? { 'content-type': 'application/zip' } : { 'content-type': 'application/json' }, body: raw ? body : JSON.stringify(body) });
    const j = await r.json().catch(() => ({ code: r.status, message: r.statusText }));
    if (!r.ok) throw new Error(j.error || j.message || r.statusText);
    return j;
  }
  async function available() {
    if (statusCache && Date.now() - statusCache.t < 120e3) return statusCache.ok;
    try { const s = await call('status'); statusCache = { t: Date.now(), ok: !!s.ok, msg: s.message }; } catch (e) { statusCache = { t: Date.now(), ok: false, msg: e.message }; }
    return statusCache.ok;
  }

  const pcbParam = o => Pcb.jlcPcbParam(o);   // board → JLCPCB fields (shared with the AI tools)

  const fresh = () => ({ fileKey: null, opts: { qty: 5, color: 0, finish: 1, thickness: 1.6, achieveDate: null, ship: null, remark: '' }, quote: null, addr: {} });
  async function uploadGerbers() {
    const blob = makeZip(Pcb.gerbers()), name = (Model.S.name || 'board').replace(/[^\w.-]+/g, '_').slice(0, 60) + '-gerbers.zip';
    const up = await call('pcb/upload?name=' + encodeURIComponent(name), blob, true);
    if (up.code !== 200 || !up.data) throw new Error(`JLCPCB did not accept the Gerbers (${up.code}: ${up.message || 'no file key'})`);
    return up.data;
  }
  const failed = e => { show(`<p class="bad">${esc(e.message)}</p><p class="muted">You can still use the website: <button id="jlcWeb">Download files and open JLCPCB ↗</button></p>`); $('#jlcWeb').onclick = () => { close(); App.orderWebsite(); }; };

  // Order: upload, price live, place the order (fileKey: Gerbers already uploaded by "Upload to JLCPCB")
  async function open(fileKey) {
    if (!Model.S.board.w || !Pcb.placed().length) { App.toast('No PCB yet — Generate PCB first'); return; }
    st = fresh(); title('Order at JLCPCB');
    show(fileKey ? '<p class="muted">Pricing at JLCPCB…</p>' : '<p class="muted">Uploading the Gerbers to JLCPCB…</p>');
    try {
      st.fileKey = fileKey || await uploadGerbers();
      try { st.addr = await call('address'); } catch (e) { st.addr = {}; }
      await requote();
    } catch (e) { failed(e); }
  }

  // Upload to JLCPCB without ordering: the Gerbers go to JLCPCB, which reviews them (board size, layer files, smallest
  // track / gap, problems) and prices the board at the default options. Nothing is ordered; "Order…" continues with
  // the same upload.
  async function check() {
    if (!Model.S.board.w || !Pcb.placed().length) { App.toast('No PCB yet — Generate PCB first'); return; }
    title('Upload to JLCPCB');
    show('<p class="muted">Uploading the Gerbers to JLCPCB…</p>');
    let key;
    try { key = await uploadGerbers(); } catch (e) { return failed(e); }
    show('<p class="muted">Uploaded ✓ — JLCPCB is reviewing the files (this takes up to a minute)…</p>');
    let addr = {}; try { addr = await call('address'); } catch (e) { }
    const priceP = call('pcb/quote', { orderType: 1, pcbParam: Pcb.jlcPcbParam({}), achieveDate: 96, fileKey: key, country: (addr.country || 'EG').toUpperCase() }).catch(e => ({ code: 0, message: e.message }));
    let a = null, err = null;
    for (let i = 0; i < 30 && !a; i++) {   // the review is ready after a few seconds; until then JLCPCB answers 2501
      try { const r = await call('pcb/audit', { key }); if (r.code === 200 && r.data) a = r.data; else if (r.code !== 2501) err = `${r.code}: ${r.message}`; } catch (e) { err = e.message; }
      if (!a) { if (err && i > 3) break; await new Promise(res => setTimeout(res, 3000)); }
      if ($('#jlcModal').classList.contains('hidden')) return;   // closed meanwhile
    }
    const q = await priceP, S = Model.S, d = a || {}, rec = d.technologyDiscernRecordResult || {};
    const clean = s => String(s).replace(/\(null\)|:null/g, '').trim();
    const list = (k, cls, head) => (rec[k] || []).length ? `<p class="${cls}"><b>${head}</b></p><ul class="small">${rec[k].map(x => `<li>${esc(clean(x))}</li>`).join('')}</ul>` : '';
    const sizeOk = d.setLength && Math.abs(Math.max(d.setLength, d.setWidth) - Math.max(S.board.w, S.board.h)) < 0.3 && Math.abs(Math.min(d.setLength, d.setWidth) - Math.min(S.board.w, S.board.h)) < 0.3;
    const files = [...(rec.blue || []), ...(rec.green || [])].map(clean);
    const pcb = q.code === 200 && q.data ? +q.data.priceWithoutFreight : null;
    const noProblems = !(rec.red || []).length && !(rec.yellow || []).length;
    show(`
      <p class="good">✓ Gerbers uploaded to JLCPCB — nothing has been ordered.</p>
      ${a ? `<div class="jlc-grid small">
        <div>Board size found <b>${d.setLength} × ${d.setWidth} mm</b> ${sizeOk ? '✓' : `<span class="bad">(design: ${S.board.w} × ${S.board.h} mm)</span>`}</div>
        <div>Smallest track <b>${d.minLineWidth ?? '–'} mm</b> · smallest gap <b>${d.minLineDist ?? '–'} mm</b></div>
        <div>Layer files recognised <b>${files.length}</b>${d.stencilLayer ? ` · paste layers ${d.stencilLayer}` : ''}</div>
      </div>
      ${list('red', 'bad', 'Problems JLCPCB found')}${list('yellow', 'warn', 'Warnings')}
      ${noProblems ? '<p class="small">No problems reported by the JLCPCB file review.</p>' : ''}
      ${files.length ? `<details><summary class="muted small">Files JLCPCB recognised</summary><ul class="small">${files.map(f => `<li>${esc(f)}</li>`).join('')}</ul></details>` : ''}
      ${d.gerberTop ? `<div class="jlc-prev"><img src="${esc(d.gerberTop)}" alt="top"><img src="${esc(d.gerberBottom || '')}" alt="bottom"></div>` : ''}`
      : `<p class="warn">The JLCPCB file review did not answer${err ? ` (${esc(err)})` : ' in time'} — the upload itself worked.</p>`}
      ${pcb != null ? `<div class="jlc-price"><div>Price for 5 pcs (green, lead-free HASL, 1.6 mm) <b>$${pcb.toFixed(2)}</b> <span class="muted">+ shipping</span></div></div>` : q.message ? `<p class="muted small">No price: ${esc(q.message)}</p>` : ''}
      <div class="row end">${d.url ? `<a class="btn" href="${esc(d.url)}" target="_blank" rel="noopener">Open in the JLCPCB Gerber viewer ↗</a>` : ''}<button id="jlcWeb">Website + assembly files ↗</button><button id="jlcGoOrder" class="primary">Order…</button></div>`);
    $('#jlcWeb').onclick = () => { close(); App.orderWebsite(); };
    $('#jlcGoOrder').onclick = () => open(key);
  }

  async function requote() {
    const o = st.opts, body = { orderType: 1, pcbParam: pcbParam(o), achieveDate: o.achieveDate || 96, fileKey: st.fileKey, country: (st.addr.country || 'EG').toUpperCase() };
    if (o.ship) body.shippingMethod = o.ship;
    setBusy(true);
    try {
      const q = await call('pcb/quote', body);
      if (q.code !== 200) throw new Error(`${q.code}: ${q.message || 'JLCPCB could not price this board'}`);
      st.quote = q.data || {};
      const lead = (st.quote.achieveDateList || []), ship = st.quote.shipList || [];
      if (!o.achieveDate) { const c = lead.find(x => x.achieveChecked) || lead[0]; if (c) o.achieveDate = +c.achieveDate; }
      if (!o.ship && ship.length) o.ship = ship.filter(x => x.day).sort((a, b) => +a.cost - +b.cost)[0]?.options || ship[0].options;
      st.err = null;
    } catch (e) { st.err = e.message; }
    setBusy(false); render();
  }

  function render() {
    const o = st.opts, q = st.quote || {}, S = Model.S, flex = S.pcb.flex && S.pcb.flex.on;
    const lead = q.achieveDateList || [], ship = q.shipList || [], pc = q.pcbCostInfo || {};
    const l = lead.find(x => +x.achieveDate === +o.achieveDate), s = ship.find(x => x.options === o.ship);
    const pcb = +q.priceWithoutFreight || 0, build = l ? +l.achievePrice || 0 : 0, freight = s ? +s.cost || 0 : 0, total = pcb + freight;
    const sel = (id, list, v) => `<select id="${id}">${list.map(([k, n]) => `<option value="${esc(k)}" ${String(k) === String(v) ? 'selected' : ''}>${esc(n)}</option>`).join('')}</select>`;
    const missing = ADDR.filter(([k, n]) => !/optional/.test(n) && !String(st.addr[k] || '').trim()).map(x => x[1]);
    show(`
      <p class="muted small">${esc(S.name || 'Board')} · ${S.board.w} × ${S.board.h} mm · ${Pcb.rules().layers === 1 ? '1' : '2'} layers${flex ? ' · flex' : ''} · Gerbers uploaded ✓</p>
      <div class="jlc-grid">
        <label>Quantity ${sel('jlcQty', QTY.map(n => [n, n]), o.qty)}</label>
        <label>Solder mask ${sel('jlcColor', COLORS, o.color)}</label>
        <label>Surface finish ${sel('jlcFinish', FINISH, o.finish)}</label>
        ${flex ? '' : `<label>Thickness ${sel('jlcThick', [[0.8, '0.8 mm'], [1.0, '1.0 mm'], [1.2, '1.2 mm'], [1.6, '1.6 mm'], [2.0, '2.0 mm']], o.thickness)}</label>`}
        <label>Build time ${sel('jlcLead', lead.map(x => [x.achieveDate, `${x.achieveName}${lead.filter(y => y.achieveName === x.achieveName).length > 1 ? ` (${x.achieveDate} h)` : ''}${+x.achievePrice ? ` +$${(+x.achievePrice).toFixed(2)}` : ''}`]), o.achieveDate)}</label>
        <label>Shipping ${sel('jlcShip', ship.map(x => [x.options, `${x.showOptions} — $${(+x.cost).toFixed(2)}${x.day ? ' · ' + x.day : ''}`]), o.ship)}</label>
      </div>
      ${st.err ? `<p class="bad">${esc(st.err)}</p>` : `<div class="jlc-price"><div>PCB <b>$${pcb.toFixed(2)}</b>${pc.specialFlag ? ' <span class="muted">(special offer)</span>' : ''}${build ? ` <span class="muted">incl. build time $${build.toFixed(2)}</span>` : ''}</div><div>Shipping <b>$${freight.toFixed(2)}</b></div><div class="jlc-total">Total <b>$${total.toFixed(2)}</b> <span class="muted small">(taxes / duties may apply)</span></div></div>`}
      ${q.gerberTop ? `<div class="jlc-prev"><img src="${esc(q.gerberTop)}" alt="top"><img src="${esc(q.gerberBottom || '')}" alt="bottom"></div>` : ''}
      <details ${missing.length ? 'open' : ''}><summary>Shipping address ${missing.length ? '<span class="bad">— needed to place the order</span>' : '✓'}</summary>
        <div class="jlc-grid">${ADDR.map(([k, n]) => `<label>${esc(n)}<input data-a="${k}" value="${esc(st.addr[k] || '')}"></label>`).join('')}</div>
        <div class="row end"><button id="jlcSaveAddr">Save address</button></div>
      </details>
      <label>Remark for JLCPCB (optional)<input id="jlcRemark" value="${esc(o.remark)}" maxlength="200"></label>
      <p class="muted small">Assembly (PCBA) is not in the API yet: for assembled boards use “Website + assembly files”.</p>
      <div class="row end"><button id="jlcWeb">Website + assembly files ↗</button><button id="jlcPlace" class="primary" ${st.err || missing.length ? 'disabled' : ''}>Place order — $${total.toFixed(2)}</button></div>`);
    const re = (k, v) => { o[k] = v; if (k === 'qty' || k === 'color' || k === 'finish' || k === 'thickness') o.achieveDate = null; requote(); };
    $('#jlcQty').onchange = e => re('qty', +e.target.value); $('#jlcColor').onchange = e => re('color', +e.target.value); $('#jlcFinish').onchange = e => re('finish', +e.target.value);
    if ($('#jlcThick')) $('#jlcThick').onchange = e => re('thickness', +e.target.value);
    $('#jlcLead').onchange = e => { o.achieveDate = +e.target.value; requote(); }; $('#jlcShip').onchange = e => { o.ship = e.target.value; render(); };
    $('#jlcRemark').onchange = e => { o.remark = e.target.value; };
    const readAddr = () => { document.querySelectorAll('#jlcBody [data-a]').forEach(i => { st.addr[i.dataset.a] = i.value.trim(); }); if (st.addr.country) st.addr.country = st.addr.country.toUpperCase(); };
    $('#jlcSaveAddr').onclick = async () => { readAddr(); try { st.addr = await call('address', st.addr); App.toast('Address saved on this PC'); } catch (e) { App.toast(e.message); } requote(); };
    $('#jlcWeb').onclick = () => { close(); App.orderWebsite(); };
    $('#jlcPlace').onclick = () => place(total);
  }

  async function place(total) {
    const o = st.opts, a = st.addr;
    if (!confirm(`Place this order at JLCPCB?\n\n${o.qty} × ${Model.S.name || 'PCB'} (${Model.S.board.w} × ${Model.S.board.h} mm)\nTotal about $${total.toFixed(2)} with shipping — paid on jlcpcb.com\nShip to: ${a.firstName} ${a.lastName}, ${a.city}, ${a.country}`)) return;
    const shipTo = { firstName: a.firstName, lastName: a.lastName, companyName: a.companyName || undefined, streetAddress: a.streetAddress, addressLine2: a.addressLine2 || undefined, city: a.city, country: a.country, province: a.province, postalCode: a.postalCode, cellOrMobileNumber: a.cellOrMobileNumber };
    const body = { fileKey: st.fileKey, orderType: 1, pcbParam: pcbParam(o), achieveDate: o.achieveDate, shippingMethod: o.ship, shippingAddress: shipTo, billingAddressFlag: 1, ...(a.taxNumber ? { TaxOrVATNumber: a.taxNumber } : {}) };
    setBusy(true);
    try {
      const r = await call('pcb/create', body);
      if (r.code !== 200) throw new Error(`${r.code}: ${r.message || 'JLCPCB did not create the order'}`);
      const d = r.data || {}, ref = typeof d === 'string' ? d : d.batchNum || d.orderUUID || d.orderNo || '';
      show(`<p class="good">✓ Order created at JLCPCB${ref ? ` — <b>${esc(ref)}</b>` : ''}.</p><p>Pay for it on JLCPCB to start production.</p>
        <details><summary class="muted small">JLCPCB's answer</summary><pre class="small">${esc(JSON.stringify(d, null, 1)).slice(0, 2000)}</pre></details>
        <div class="row end"><a class="btn primary" href="https://jlcpcb.com/user-center/orders" target="_blank" rel="noopener">Pay at JLCPCB ↗</a></div>`);
      App.toast('Order created at JLCPCB — pay for it there', 10000);
    } catch (e) { setBusy(false); App.toast(e.message, 12000); render(); const p = $('#jlcBody'); if (p) p.insertAdjacentHTML('afterbegin', `<p class="bad">${esc(e.message)}</p>`); }
  }

  function show(html) {
    let m = $('#jlcModal');
    if (!m) {
      m = document.createElement('div'); m.id = 'jlcModal'; m.className = 'modal';
      m.innerHTML = '<div class="dlg wide"><div class="row-h"><h2 id="jlcTitle">Order at JLCPCB</h2><button id="jlcClose">✕</button></div><div id="jlcBody"></div></div>';
      document.body.appendChild(m); $('#jlcClose').onclick = close;
    }
    m.classList.remove('hidden'); $('#jlcBody').innerHTML = html;
  }
  const title = t => { show(''); $('#jlcTitle').textContent = t; };
  const close = () => { const m = $('#jlcModal'); if (m) m.classList.add('hidden'); };
  const setBusy = b => { const m = $('#jlcBody'); if (m) m.style.opacity = b ? 0.55 : ''; };

  return { open, check, available, close, pcbParam };
})();
