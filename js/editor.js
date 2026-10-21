'use strict';
// Part editor: create / modify a part's symbol (pins) and footprint (pads).
const PartEditor = (() => {
  const $ = s => document.querySelector(s);
  let def = null, selPad = -1, drag = null, onDone = null, isNew = false, scope = null;

  const clone = o => JSON.parse(JSON.stringify(o));
  const r4 = v => Math.round(v * 10000) / 10000;
  const newKey = name => 'LIB_' + (String(name || 'PART').toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 30) || 'PART') + '_' + Math.random().toString(36).slice(2, 6).toUpperCase();

  // Build an editable definition from a placed built-in component (keeps its pin numbers).
  function fromBuiltin(c) {
    const d = Lib.type(c.type), fp = Lib.footprint(c.footprint);
    const side = p => p.dx < 0 ? 'L' : p.dx > 0 ? 'R' : p.dy < 0 ? 'T' : 'B';
    return {
      name: c.value || d.name, prefix: d.prefix, value: c.value || d.value,
      pins: d.pins(c).map(p => ({ num: p.num, name: p.name, side: side(p) })),
      footprint: fp ? { name: c.footprint, pads: clone(fp.pads), body: fp.body ? clone(fp.body) : null } : { name: 'custom', pads: [], body: null }
    };
  }
  function blankDef() {
    return { name: 'New part', prefix: 'U', value: 'New part', pins: [{ num: '1', name: 'VCC', side: 'L' }, { num: '2', name: 'GND', side: 'L' }, { num: '3', name: 'OUT', side: 'R' }, { num: '4', name: 'IN', side: 'R' }], footprint: { name: 'SOIC-4', pads: clone(Lib.footprint('SOIC-4').pads), body: null } };
  }

  // ---------- open / save ----------
  function open(d, opts = {}) {
    def = clone(d); isNew = !!opts.isNew; onDone = opts.onDone || null; selPad = -1;
    scope = opts.ref && opts.users && opts.users.length > 1 ? { ref: opts.ref, users: opts.users } : null;
    $('#edScopeL').classList.toggle('hidden', !scope);
    if (scope) $('#edScope').innerHTML = `<option value="one">only ${esc(scope.ref)}</option><option value="all">all ${scope.users.length} (${esc(scope.users.join(', '))})</option>`;
    def.pins = def.pins || []; def.footprint = def.footprint || { name: 'custom', pads: [], body: null };
    if (!def.key) def.key = opts.key || newKey(def.name);
    $('#edTitle').textContent = isNew ? 'New part' : 'Edit part';
    $('#edKey').textContent = def.key + (/^C\d+$/.test(def.key) ? ' · database part (JLCPCB/LCSC)' : '');
    $('#edName').value = def.name || ''; $('#edPrefix').value = def.prefix || 'U'; $('#edValue').value = def.value || '';
    $('#edSaveLib').checked = opts.saveLib !== false;
    $('#edPlace').classList.toggle('hidden', !opts.allowPlace);
    $('#edModal').classList.remove('hidden');
    renderPins(); renderSym(); renderFp(); fitFp(); showCurrentFp();
  }
  // footprint menu starts on the part's current footprint (listed as "Current: …" when it is not a standard pattern)
  function showCurrentFp() {
    const f = def.footprint, nm = String(f.name || 'custom'), sel = $('#edGen'), old = sel.querySelector('option[data-cur]');
    if (old) old.remove();
    let pat = null, n = null, m;
    if (Lib.FOOTPRINT_PATTERNS.includes(nm)) pat = nm;
    else if ((m = /^(DIP|SOIC|TSSOP|QFN)-(\d+)(-EP)?$/.exec(nm))) { pat = m[1] + '-<n>' + (m[3] || ''); n = +m[2]; }
    else if ((m = /^PinHeader_1x(\d+)$/.exec(nm))) { pat = 'PinHeader_1x<n>'; n = +m[1]; }
    if (pat && Lib.FOOTPRINT_PATTERNS.includes(pat)) { sel.value = pat; if (n) $('#edGenN').value = n; return; }
    const size = (nm.match(/(?:^|\D)(0201|0402|0603|0805|1206|1210|2512)(?!\d)/) || [])[1];
    sel.insertAdjacentHTML('afterbegin', `<option value="" data-cur>Current: ${esc(nm)}${size ? ' (' + size + ')' : ''} · ${f.pads.length} pads</option>`);
    sel.value = '';
  }
  function close() { $('#edModal').classList.add('hidden'); def = null; }
  function readMeta() { def.name = $('#edName').value.trim() || 'Part'; def.prefix = ($('#edPrefix').value.trim() || 'U').replace(/[^A-Za-z]/g, '') || 'U'; def.value = $('#edValue').value.trim() || def.name; }
  function validate() {
    const nums = def.pins.map(p => String(p.num).trim());
    if (!nums.length) return 'Add at least one pin';
    if (nums.some(n => !n)) return 'Every pin needs a number';
    const dup = nums.find((n, i) => nums.indexOf(n) !== i); if (dup) return `Pin number ${dup} is used twice`;
    return null;
  }
  async function save(place) {
    readMeta();
    const err = validate(); if (err) { App.toast(err); return; }
    const f = def.footprint;
    f.pads = f.pads.map(p => ({ ...p, num: String(p.num), x: r4(+p.x), y: r4(+p.y), w: r4(Math.max(0.05, +p.w)), h: r4(Math.max(0.05, +p.h)), ...(p.drill ? { drill: r4(+p.drill) } : {}) }));
    f.pads.forEach(p => { if (!p.drill) delete p.drill; });
    f.body = bodyOf(f);
    const out = { key: def.key, name: def.name, prefix: def.prefix, value: def.value, pins: def.pins.map(p => ({ num: String(p.num).trim(), name: String(p.name || p.num).trim(), side: p.side || 'L' })), footprint: f, custom: !/^C\d+$/.test(def.key), source: def.source, lcsc: def.lcsc, manufacturer: def.manufacturer, mfr_part: def.mfr_part, datasheet: def.datasheet, package: def.package };
    // "only this one": the component gets its own copy of the part (same LCSC number for the BOM), the others keep theirs
    const one = scope && $('#edScope').value === 'one';
    if (one) {
      const base = String(def.key).replace(/-[A-Za-z]+\d+$/, ''), lib = Model.S.lib;
      let k = base + '-' + scope.ref; for (let i = 2; lib[k] && k !== def.key; i++) k = base + '-' + scope.ref + '_' + i;
      out.key = k; out.lcsc = Model.lcscOf({ type: 'part', lcsc: def.key }) || out.lcsc; out.custom = !out.lcsc;
    }
    const n = Model.mutate(() => { const r = Model.setLibPart(out.key, out); if (one) { Model.assignPart(scope.ref, out.key); return 1; } return r; });
    if ($('#edSaveLib').checked) { try { await Projects.savePart(out); App.refreshParts(); } catch (e) { App.toast(e.message); } }
    const k = out.key; close();
    if (place) App.placeLibPart(k);
    const sz = t => (String(t || '').match(/(?:^|\D)(0201|0402|0603|0805|1206|1210|2512)(?!\d)/) || [])[1], fs = sz(f.name), ps = sz(out.package);
    App.toast(`Saved ${out.name}${n ? ` — updated ${n} placed part${n > 1 ? 's' : ''}` : ''}${!out.custom && fs && ps && fs !== ps ? ` · note: the footprint is now ${fs} but JLCPCB part ${out.lcsc || out.key} is ${ps} — pick a ${fs} part for assembly` : ''}`, 9000);
    onDone && onDone(k);
  }

  // ---------- pins ----------
  function renderPins() {
    const fpNums = new Set(def.footprint.pads.map(p => String(p.num)));
    $('#edPins').innerHTML = def.pins.map((p, i) => `<tr data-i="${i}">
      <td><input data-f="num" value="${esc(p.num)}" class="${fpNums.has(String(p.num)) ? '' : 'warnin'}" title="${fpNums.has(String(p.num)) ? '' : 'No pad with this number in the footprint'}"></td>
      <td><input data-f="name" value="${esc(p.name)}"></td>
      <td><select data-f="side">${['L', 'R', 'T', 'B'].map(s => `<option ${p.side === s ? 'selected' : ''}>${s}</option>`).join('')}</select></td>
      <td class="pbtn"><button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button><button data-a="del" class="danger" title="Delete">✕</button></td></tr>`).join('');
    pinInfo();
  }
  function pinInfo() {
    const fpNums = new Set(def.footprint.pads.map(p => String(p.num))), pinNums = new Set(def.pins.map(p => String(p.num)));
    $('#edPins').querySelectorAll('input[data-f=num]').forEach(i => i.classList.toggle('warnin', !fpNums.has(i.value.trim())));
    const orphan = [...fpNums].filter(n => !pinNums.has(n));
    $('#edPinInfo').innerHTML = `${def.pins.length} pins` + (orphan.length ? ` · <span class="warn">pads without a pin: ${esc(orphan.slice(0, 12).join(', '))}${orphan.length > 12 ? '…' : ''}</span>` : '');
  }
  function onPinInput(e) {
    const tr = e.target.closest('tr'), f = e.target.dataset.f; if (!tr || !f) return;
    def.pins[+tr.dataset.i][f] = e.target.value;
    renderSym(); if (f === 'num') renderFp(false);
  }
  function onPinClick(e) {
    const b = e.target.closest('button[data-a]'); if (!b) return;
    const i = +b.closest('tr').dataset.i, P = def.pins;
    if (b.dataset.a === 'del') P.splice(i, 1);
    if (b.dataset.a === 'up' && i > 0) [P[i - 1], P[i]] = [P[i], P[i - 1]];
    if (b.dataset.a === 'down' && i < P.length - 1) [P[i + 1], P[i]] = [P[i], P[i + 1]];
    renderPins(); renderSym(); renderFp();
  }
  function addPin() {
    const nums = def.pins.map(p => +p.num).filter(n => !isNaN(n));
    const n = String((nums.length ? Math.max(...nums) : 0) + 1);
    const left = def.pins.filter(p => p.side === 'L' || p.side === 'T').length, right = def.pins.length - left;
    def.pins.push({ num: n, name: 'P' + n, side: left <= right ? 'L' : 'R' });
    renderPins(); renderSym(); renderFp();
    const rows = $('#edPins').querySelectorAll('tr'); rows[rows.length - 1]?.querySelector('[data-f=name]')?.select();
  }
  function pinsFromPads() {
    const have = new Set(def.pins.map(p => String(p.num)));
    const add = [...new Set(def.footprint.pads.map(p => String(p.num)))].filter(n => !have.has(n)).sort((a, b) => (+a - +b) || a.localeCompare(b));
    add.forEach((n, i) => def.pins.push({ num: n, name: n, side: i % 2 ? 'R' : 'L' }));
    renderPins(); renderSym(); renderFp(); App.toast(add.length ? `Added ${add.length} pins` : 'Every pad already has a pin');
  }
  function bulkEdit() {
    const cur = def.pins.map(p => `${p.num}:${p.name}:${p.side}`).join('\n');
    const t = prompt('One pin per line as  number:name:side  (side = L, R, T or B). Separate with commas or new lines.', cur);
    if (t === null) return;
    const pins = t.split(/[\n,]+/).map(s => s.trim()).filter(Boolean).map((s, i) => {
      const [num, name, side] = s.split(':').map(x => (x || '').trim());
      return { num: num || String(i + 1), name: name || num || String(i + 1), side: /^[LRTB]$/i.test(side || '') ? side.toUpperCase() : (i % 2 ? 'R' : 'L') };
    });
    def.pins = pins; renderPins(); renderSym(); renderFp();
  }

  // ---------- symbol preview ----------
  function renderSym() {
    if (!def) return;
    const { g, svg } = Lib.drawPart(def), pad = 40;
    const tx = [];
    for (const p of g.pins) {
      const ax = p.x - p.dx * p.len;
      if (p.show) {
        tx.push(`<text class="pinname" x="${ax - p.dx * 4}" y="${p.y + 3}" text-anchor="${p.dx < 0 ? 'start' : 'end'}">${esc(p.name)}</text>`);
        tx.push(`<text class="pinnum" x="${(p.x + ax) / 2}" y="${p.y - 2}" text-anchor="middle">${esc(p.num)}</text>`);
      }
    }
    const w = 2 * (g.hw + 20) + 2 * pad, h = 2 * g.hh + 2 * pad;
    $('#edSym').setAttribute('viewBox', `${-w / 2} ${-h / 2} ${w} ${h}`);
    $('#edSym').innerHTML = `<g class="comp">${svg}</g>${tx.join('')}<text class="ref" x="0" y="${-g.hh - 6}" text-anchor="middle">${esc(($('#edPrefix').value || 'U') + '?')}</text><text class="val" x="0" y="${g.hh + 14}" text-anchor="middle">${esc($('#edValue').value || def.value || '')}</text>`;
  }

  // ---------- footprint editor ----------
  function bodyOf(f) {
    if (!f.pads.length) return f.body || [-1, -1, 1, 1];
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    for (const p of f.pads) b = [Math.min(b[0], p.x - p.w / 2), Math.min(b[1], p.y - p.h / 2), Math.max(b[2], p.x + p.w / 2), Math.max(b[3], p.y + p.h / 2)];
    if (f.body) b = [Math.min(b[0], f.body[0]), Math.min(b[1], f.body[1]), Math.max(b[2], f.body[2]), Math.max(b[3], f.body[3])];
    return b.map(v => r4(v));
  }
  let fvb = [-6, -6, 12, 12];
  function fitFp() {
    const b = bodyOf(def.footprint), el = $('#edFp').getBoundingClientRect();
    const m = 1.5, w = b[2] - b[0] + 2 * m, h = b[3] - b[1] + 2 * m, asp = (el.width || 400) / (el.height || 300);
    const W = Math.max(w, h * asp), H = W / asp;
    fvb = [(b[0] + b[2]) / 2 - W / 2, (b[1] + b[3]) / 2 - H / 2, W, H]; renderFp();
  }
  function renderFp(full = true) {
    if (!def) return;
    const f = def.footprint, b = bodyOf(f), pinName = {};
    def.pins.forEach(p => pinName[String(p.num)] = p.name);
    const fs = Math.max(0.25, Math.min(1, fvb[2] / 40));
    const out = [`<rect class="board" x="${fvb[0]}" y="${fvb[1]}" width="${fvb[2]}" height="${fvb[3]}" style="stroke:none"/>`,
      `<path class="edaxis" d="M${fvb[0]} 0H${fvb[0] + fvb[2]}M0 ${fvb[1]}V${fvb[1] + fvb[3]}" stroke-width="${fs * 0.05}"/>`,
      `<rect class="silk" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`];
    f.pads.forEach((p, i) => {
      const cls = 'pad' + (i === selPad ? ' padsel' : '') + (pinName[String(p.num)] == null ? ' padorphan' : '');
      out.push(p.shape === 'round' ? `<circle class="${cls}" data-i="${i}" cx="${p.x}" cy="${p.y}" r="${p.w / 2}"/>` :
        `<rect class="${cls}" data-i="${i}" x="${p.x - p.w / 2}" y="${p.y - p.h / 2}" width="${p.w}" height="${p.h}" rx="${p.shape === 'oval' ? Math.min(p.w, p.h) / 2 : 0.03}"/>`);
      if (p.drill) out.push(`<circle class="drill" cx="${p.x}" cy="${p.y}" r="${p.drill / 2}" pointer-events="none"/>`);
      out.push(`<text class="padnum" x="${p.x}" y="${p.y + Math.min(p.w, p.h) * 0.18}" text-anchor="middle" style="font-size:${Math.min(fs, Math.min(p.w, p.h) * 0.55)}px" pointer-events="none">${esc(p.num)}</text>`);
    });
    $('#edFp').setAttribute('viewBox', fvb.join(' '));
    $('#edFp').innerHTML = out.join('');
    $('#edFpName').textContent = `${f.name || 'custom'} · ${f.pads.length} pads · ${(b[2] - b[0]).toFixed(2)} × ${(b[3] - b[1]).toFixed(2)} mm`;
    if (full) renderPadForm();
    pinInfo();
  }
  function renderPadForm() {
    const p = def.footprint.pads[selPad], el = $('#edPad');
    if (!p) { el.innerHTML = '<span class="muted">Click a pad to edit it · drag to move (0.05 mm snap) · Del removes it</span>'; return; }
    const fld = (k, step) => `<label>${k}<input data-pf="${k}" type="number" step="${step}" value="${p[k] ?? ''}"></label>`;
    el.innerHTML = `<label>num<input data-pf="num" value="${esc(p.num)}"></label>${fld('x', 0.05)}${fld('y', 0.05)}${fld('w', 0.05)}${fld('h', 0.05)}
      <label>shape<select data-pf="shape">${['rect', 'round', 'oval'].map(s => `<option ${p.shape === s ? 'selected' : ''}>${s}</option>`).join('')}</select></label>${fld('drill', 0.05)}
      <button id="edPadDel" class="danger">Delete pad</button>`;
  }
  function onPadForm(e) {
    const k = e.target.dataset.pf, p = def.footprint.pads[selPad]; if (!k || !p) return;
    let v = e.target.value;
    if (k === 'num' || k === 'shape') p[k] = v; else if (k === 'drill') { if (+v > 0) p.drill = +v; else delete p.drill; } else if (v !== '' && !isNaN(+v)) p[k] = +v;
    if (k === 'shape' && v === 'round') p.h = p.w;
    renderFp(false);
  }
  function fpPoint(e) {
    const r = $('#edFp').getBoundingClientRect(), s = fvb[2] / r.width;
    return { x: fvb[0] + (e.clientX - r.left) * s, y: fvb[1] + (e.clientY - r.top) * (fvb[3] / r.height) };
  }
  function fpDown(e) {
    const el = e.target.closest('[data-i]'), pt = fpPoint(e);
    if (el) { selPad = +el.dataset.i; const p = def.footprint.pads[selPad]; drag = { kind: 'pad', ox: pt.x - p.x, oy: pt.y - p.y }; }
    else { selPad = -1; drag = { kind: 'pan', x: e.clientX, y: e.clientY }; }
    renderFp();
  }
  function fpMove(e) {
    if (!drag || !def) return;
    if (drag.kind === 'pan') {
      const r = $('#edFp').getBoundingClientRect(), s = fvb[2] / r.width;
      fvb[0] -= (e.clientX - drag.x) * s; fvb[1] -= (e.clientY - drag.y) * s; drag.x = e.clientX; drag.y = e.clientY; renderFp(); return;
    }
    const pt = fpPoint(e), p = def.footprint.pads[selPad]; if (!p) return;
    p.x = r4(Math.round((pt.x - drag.ox) / 0.05) * 0.05); p.y = r4(Math.round((pt.y - drag.oy) / 0.05) * 0.05); renderFp();
  }
  function fpWheel(e) {
    e.preventDefault(); const pt = fpPoint(e), k = Math.exp(e.deltaY * 0.0015);
    fvb = [pt.x - (pt.x - fvb[0]) * k, pt.y - (pt.y - fvb[1]) * k, fvb[2] * k, fvb[3] * k]; renderFp();
  }
  function addPad() {
    const P = def.footprint.pads, last = P[selPad] || P[P.length - 1];
    const nums = P.map(p => +p.num).filter(n => !isNaN(n)), num = String((nums.length ? Math.max(...nums) : 0) + 1);
    P.push(last ? { ...last, num, x: r4(last.x + 1.27) } : { num, x: 0, y: 0, w: 1.5, h: 1.5, shape: 'rect' });
    selPad = P.length - 1; renderFp();
  }
  function generate() {
    let name = $('#edGen').value; const n = +$('#edGenN').value || 8;
    if (!name) { App.toast('Choose a footprint on the left, then Update'); return; }
    if (name.includes('<n>')) name = name.replace('<n>', n);
    const fp = Lib.footprint(name); if (!fp) { App.toast('Cannot generate ' + name); return; }
    if (def.footprint.pads.length && !confirm(`Replace the ${def.footprint.pads.length} current pads with ${name}?`)) return;
    def.footprint = { name, pads: clone(fp.pads), body: fp.body ? clone(fp.body) : null }; selPad = -1; fitFp(); showCurrentFp();
  }

  // ---------- KiCad official footprint library ----------
  let kiTimer = null, kiSeq = 0;
  function kicadToggle() {
    const box = $('#edKicadBox'), open = box.classList.toggle('hidden') === false;
    if (open) { const q = $('#edKicadQ'); if (!q.value) q.value = String(def.footprint.name || '').replace(/[<>]/g, '').replace(/^custom$/, ''); q.focus(); q.select(); kicadSearch(); }
  }
  function kicadSearch() {
    clearTimeout(kiTimer);
    kiTimer = setTimeout(async () => {
      const seq = ++kiSeq, q = $('#edKicadQ').value.trim(), list = $('#edKicadList');
      if (q.length < 2) { list.innerHTML = '<div class="muted small">Type at least 2 characters</div>'; return; }
      list.innerHTML = '<div class="muted small">Searching… <span class="spin"></span></div>';
      try {
        const hits = await KiCad.search(q, 60); if (seq !== kiSeq) return;
        list.innerHTML = hits.length ? hits.map(h => { const i = h.indexOf('/'); return `<button class="kifp" data-path="${esc(h)}" title="${esc(h)}"><b>${esc(h.slice(i + 1))}</b><span class="muted">${esc(h.slice(0, i).replace(/\.pretty$/, ''))}</span></button>`; }).join('')
          : '<div class="muted small">No KiCad footprint matches. Try fewer words, e.g. "QFN-32" or "SOT-23".</div>';
      } catch (e) { if (seq === kiSeq) list.innerHTML = `<div class="dberr">${esc(e.message)}</div>`; }
    }, 200);
  }
  async function kicadPick(path) {
    if (def.footprint.pads.length && !confirm(`Replace the ${def.footprint.pads.length} current pads with KiCad ${path.slice(path.indexOf('/') + 1)}?`)) return;
    App.toast('Downloading ' + path + '…', 8000);
    try {
      const f = await KiCad.load(path);
      def.footprint = { name: f.name, pads: f.pads, body: f.body };
      selPad = -1; fitFp(); showCurrentFp(); $('#edKicadBox').classList.add('hidden');
      const nums = new Set(f.pads.map(p => p.num)), missing = [...nums].filter(n => !def.pins.some(p => String(p.num) === n));
      App.toast(`KiCad footprint ${f.name}: ${f.pads.length} pads${f.skipped ? ` (${f.skipped} mechanical / paste-only pads left out)` : ''}${missing.length ? ` · ${missing.length} pad number${missing.length > 1 ? 's have' : ' has'} no pin yet: use “Pins from pads”` : ''}`, 9000);
    } catch (e) { App.toast(e.message, 8000); }
  }

  function key(e) {
    if ($('#edModal').classList.contains('hidden')) return false;
    if (e.key === 'Escape') { close(); return true; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && selPad >= 0 && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName)) {
      def.footprint.pads.splice(selPad, 1); selPad = -1; renderFp(); return true;
    }
    return /^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement.tagName) ? false : true;
  }

  function init() {
    $('#edGen').innerHTML = Lib.FOOTPRINT_PATTERNS.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join('');
    $('#edGen').value = 'SOIC-<n>';
    $('#edPins').addEventListener('input', onPinInput); $('#edPins').addEventListener('click', onPinClick);
    $('#edAddPin').onclick = addPin; $('#edBulk').onclick = bulkEdit; $('#edFromPads').onclick = pinsFromPads;
    $('#edAddPad').onclick = addPad; $('#edGenBtn').onclick = generate; $('#edFit').onclick = fitFp;
    $('#edKicad').onclick = kicadToggle; $('#edKicadQ').addEventListener('input', kicadSearch);
    $('#edKicadList').addEventListener('click', e => { const b = e.target.closest('[data-path]'); if (b) kicadPick(b.dataset.path); });
    $('#edPad').addEventListener('input', onPadForm);
    $('#edPad').addEventListener('click', e => { if (e.target.id === 'edPadDel') { def.footprint.pads.splice(selPad, 1); selPad = -1; renderFp(); } });
    ['edName', 'edPrefix', 'edValue'].forEach(id => $('#' + id).addEventListener('input', renderSym));
    $('#edFp').addEventListener('mousedown', fpDown); window.addEventListener('mousemove', fpMove); window.addEventListener('mouseup', () => drag = null);
    $('#edFp').addEventListener('wheel', fpWheel, { passive: false });
    $('#edCancel').onclick = close; $('#edSave').onclick = () => save(false); $('#edPlace').onclick = () => save(true);
  }
  return { init, open, close, key, fromBuiltin, blankDef, newKey };
})();
