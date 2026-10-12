'use strict';
// Documentation tab: a product datasheet built from the design — description, features, key specifications,
// schematic, PCB (3D renders + layout), mechanical drawing with dimensions, connector pinouts, enclosure with
// dimensions, BOM and fabrication data. Live preview here, PDF via jsPDF (cdnjs). The AI can write the text parts.
const DocView = (() => {
  const $ = s => document.querySelector(s);
  let active = false, imgs = {}, imgKey = '', building = false, libs = null;
  const ACCENT = [37, 99, 235];
  const doc = () => Object.assign({ title: Model.S.name || 'Untitled', subtitle: '', version: '1.0', company: '', description: '', features: '', applications: '', notes: '' }, Model.S.doc || {});
  const setDoc = u => Model.mutate(() => { Model.S.doc = Object.assign({}, Model.S.doc || {}, u); }, 'doc');
  const nat = (a, b) => String(a).localeCompare(String(b), undefined, { numeric: true });

  // ---------- data ----------
  function collect() {
    const S = Model.S, idx = Model.pinIndex(), R = Pcb.rules(), placed = Pcb.placed(), hasPcb = S.board.w > 0 && placed.length > 0;
    const libOf = c => (c.lcsc && S.lib[c.lcsc]) || (c.dbfp && c.footprint === 'LCSC:' + c.dbfp && S.lib[c.dbfp]) || null;
    const g = {};
    for (const c of S.components) {
      const lib = libOf(c), fp = (lib && lib.footprint && lib.footprint.name) || c.footprint || '';
      const lcsc = Model.lcscOf(c);
      const desc = (lib && (lib.mfr_part || lib.name)) || ((Lib.type(c.type) || {}).name) || c.type;
      const k = [c.value || '', fp, lcsc, desc].join('|'); (g[k] = g[k] || []).push(c.ref);
    }
    const bom = Object.entries(g).map(([k, refs]) => { const [value, fp, lcsc, desc] = k.split('|'); return { qty: refs.length, refs: refs.sort(nat).join(', '), value, fp, lcsc, desc }; }).sort((a, b) => nat(a.refs, b.refs));
    const nets = Object.keys(S.nets), power = nets.filter(n => Model.isPower(n) && !Model.isGround(n)).sort(nat);
    const ics = S.components.filter(c => ['part', 'ic', 'regulator', 'opamp'].includes(c.type)).map(c => { const lib = libOf(c); return { ref: c.ref, value: c.value, desc: lib ? [lib.manufacturer, lib.mfr_part || lib.name].filter(Boolean).join(' ') : ((Lib.type(c.type) || {}).name || c.type) }; }).sort((a, b) => nat(a.ref, b.ref));
    const conns = S.components.filter(c => c.type === 'connector' || /^(J|USB|CN|P)\d+$/i.test(c.ref) || (hasPcb && c.pcb && Pcb.edgeInfo(c)))
      .map(c => { let edge = ''; if (hasPcb && c.pcb) { const b = Pcb.fpBox(c), gaps = [['left', b[0]], ['right', S.board.w - b[2]], ['top', b[1]], ['bottom', S.board.h - b[3]]].sort((a, q) => a[1] - q[1]); if (gaps[0][1] < 2) edge = gaps[0][0]; } return { ref: c.ref, value: c.value, edge, pins: Model.pinsWorld(c).map(p => ({ num: p.num, name: p.name, net: idx[p.key] || '—' })) }; }).sort((a, b) => nat(a.ref, b.ref));
    const st = hasPcb ? Pcb.status() : null, drc = hasPcb ? Pcb.drc() : null, ercIssues = Model.erc();
    const ercE = ercIssues.filter(i => i.level === 'error').length, ercW = ercIssues.filter(i => i.level === 'warn').length;
    const holes = S.pcb.holes || [], shape = (S.board.shape || { type: 'rect' }).type;
    const specs = [
      ['Board size', hasPcb ? `${S.board.w} × ${S.board.h} mm` : '—'], ['Outline', { rect: 'Rectangle', rounded: 'Rounded rectangle', ellipse: 'Round / elliptical', polygon: 'Custom outline' }[shape] || shape],
      ['Layers', R.layers === 1 ? '1 (single-sided)' : '2 (top + bottom copper)'], ['Material / thickness', 'FR-4, 1.6 mm, 1 oz copper'],
      ['Min. track / spacing', `${R.traceWidth} / ${R.clearance} mm`], ['Power tracks', `${R.powerTraceWidth} mm`], ['Vias', `Ø${R.viaDiameter} mm, drill ${R.viaDrill} mm`],
      ['Mounting holes', holes.length ? `${holes.length} × Ø${holes[0].d} mm` : 'none'], ['Components', `${S.components.length}${placed.filter(c => Pcb.isBottom(c)).length ? ` (${placed.filter(c => Pcb.isBottom(c)).length} on the bottom side)` : ''}`],
      ['Nets', String(nets.length)], ['Routing', st ? `${st.routed}/${st.nets} nets, ${st.vias} vias, ${st.trace_length_mm} mm of track` : '—'],
      ['Design-rule check', drc ? drc.summary : '—'], ['Electrical-rule check', ercE ? `${ercE} errors, ${ercW} warnings` : ercW ? `0 errors, ${ercW} warnings` : 'passed'],
    ];
    let enc = null;
    try {
      if (Enclosure.mode() === 'custom') { const r = EncView.ui.custom && EncView.ui.custom.r; if (r) enc = { kind: 'Custom 3D enclosure', rows: r.parts.map(p => [p.name, `${p.size_mm.map(v => v.toFixed(1)).join(' × ')} mm`, `${p.volume_cm3} cm³`]) }; }
      else if (hasPcb) { const de = Enclosure.describe(); enc = { kind: 'Box with snap-fit lid', outer: de.outer_mm, rows: [['Outer size (W × D × H)', `${de.outer_mm.join(' × ')} mm`], ['Base height', `${de.base_height} mm`], ['Lid thickness', `${de.lid_thickness} mm`], ['Wall', `${de.params.wall} mm`], ['PCB support', de.mounting_holes ? `${de.mounting_holes} screw standoffs` : `${de.supports} corner supports`], ['Openings', de.cutouts.map(c => c.label || c.side).join(', ') || 'none']] }; }
    } catch (e) { }
    return { S, hasPcb, bom, power, ics, conns, specs, enc, nets, st, drc };
  }

  // ---------- images ----------
  function svgToPng(svg, maxW = 2400, bg = '#ffffff') {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      img.onload = () => {
        const w0 = img.naturalWidth || 1200, h0 = img.naturalHeight || 800, s = Math.min(4, maxW / w0, 3000 / h0);
        const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(w0 * s)); c.height = Math.max(1, Math.round(h0 * s));
        const g = c.getContext('2d'); g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height); g.drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url); res({ url: c.toDataURL('image/png'), w: c.width, h: c.height });
      };
      img.onerror = () => { URL.revokeObjectURL(url); rej(new Error('could not render image')); };
      img.src = url;
    });
  }
  // mechanical drawing: outline, dimensions, mounting holes, edge connectors (board coordinates, mm)
  function mechSVG() {
    const S = Model.S, W = S.board.w, H = S.board.h, poly = Pcb.boardPoly(), m = 16, f = 2.4, idx = Model.pinIndex();
    const pts = poly.map(q => q.map(v => +v.toFixed(3)).join(',')).join(' ');
    const arrow = (x1, y1, x2, y2) => `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" class="dim" marker-start="url(#a)" marker-end="url(#a)"/>`;
    let s = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-m} ${-m} ${W + 2 * m} ${H + 2 * m}" width="${(W + 2 * m) * 20}" height="${(H + 2 * m) * 20}">
<defs><marker id="a" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse"><path d="M0 1 L10 5 L0 9 z" fill="#1f2937"/></marker></defs>
<style>.o{fill:#eef6ee;stroke:#166534;stroke-width:0.3}.dim{stroke:#1f2937;stroke-width:0.15}.ext{stroke:#6b7280;stroke-width:0.1;stroke-dasharray:0.8 0.5}.t{font:${f}px sans-serif;fill:#111827}.s{font:${f * 0.8}px sans-serif;fill:#374151}.c{fill:#dbeafe;stroke:#1d4ed8;stroke-width:0.2}.h{fill:#fff;stroke:#b91c1c;stroke-width:0.25}.p{fill:#f3f4f6;stroke:#9ca3af;stroke-width:0.1}</style>
<rect x="${-m}" y="${-m}" width="${W + 2 * m}" height="${H + 2 * m}" fill="#fff"/>
<polygon class="o" points="${pts}"/>`;
    for (const c of Pcb.placed()) { const b = Pcb.fpBox(c); s += `<rect class="p" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`; }
    for (const c of Pcb.placed().filter(c => Pcb.edgeInfo(c) || c.pcbEdge)) {
      const b = Pcb.fpBox(c); s += `<rect class="c" x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/><text class="s" x="${(b[0] + b[2]) / 2}" y="${(b[1] + b[3]) / 2 + 0.8}" text-anchor="middle">${c.ref}</text>`;
    }
    (S.pcb.holes || []).forEach((h, i) => { s += `<circle class="h" cx="${h.x}" cy="${h.y}" r="${h.d / 2}"/><text class="s" x="${h.x + h.d / 2 + 0.8}" y="${h.y - h.d / 2 - 0.5}">H${i + 1} Ø${h.d} (${h.x.toFixed(1)}, ${h.y.toFixed(1)})</text>`; });
    // overall dimensions
    s += `<line class="ext" x1="0" y1="${H}" x2="0" y2="${H + 9}"/><line class="ext" x1="${W}" y1="${H}" x2="${W}" y2="${H + 9}"/>${arrow(0, H + 7, W, H + 7)}<text class="t" x="${W / 2}" y="${H + 6}" text-anchor="middle">${W} mm</text>`;
    s += `<line class="ext" x1="${W}" y1="0" x2="${W + 9}" y2="0"/><line class="ext" x1="${W}" y1="${H}" x2="${W + 9}" y2="${H}"/>${arrow(W + 7, 0, W + 7, H)}<text class="t" transform="translate(${W + 6} ${H / 2}) rotate(-90)" text-anchor="middle">${H} mm</text>`;
    s += `<circle cx="0" cy="0" r="0.6" fill="#b91c1c"/><text class="s" x="-1" y="-1.5" text-anchor="end">0,0</text><text class="s" x="${-m + 2}" y="${-m + 4}">All dimensions in mm · PCB 1.6 mm · top view</text></svg>`;
    return s;
  }
  async function ensureImages(force) {
    const key = Model.snapshot().length + ':' + (Model.S.pcb.traces || []).length + ':' + JSON.stringify(Model.S.board) + ':' + (Model.S.enclosure ? JSON.stringify(Model.S.enclosure).length : 0);
    if (!force && key === imgKey && Object.keys(imgs).length) return imgs;
    const out = {}, S = Model.S, step = t => { const el = $('#docStatus'); if (el) el.textContent = t; };
    try { if (S.components.length) { step('Rendering schematic…'); Sch.render(); out.schs = []; for (let i = 0; i < Sch.sheets().length; i++) { if (!Model.S.components.some(c => Model.sheetOf(c) === i)) continue; out.schs.push(Object.assign(await svgToPng(Sch.exportSVG(i), 2600), { sheet: i + 1, name: Sch.sheets()[i].name || '' })); } out.sch = out.schs[0]; } } catch (e) { }
    if (S.board.w > 0 && Pcb.placed().length) {
      try { step('Rendering PCB layout…'); Pcb.render(); out.pcb2d = await svgToPng(Pcb.exportSVG(), 2200, '#000'); } catch (e) { }
      try { step('Rendering mechanical drawing…'); out.mech = await svgToPng(mechSVG(), 2400); } catch (e) { }
      for (const v of ['iso', 'top', 'bottom']) { try { step(`Rendering 3D board (${v})…`); const r = await Pcb3D.snapshot(v, v === 'iso' ? 1600 : 1300, v === 'iso' ? 1050 : 900); if (r) out['pcb3d_' + v] = r; } catch (e) { } }
      try { step('Rendering enclosure…'); const a = await EncView.snapshot({ w: 1500, h: 1000 }); if (a) out.enc = a; const b = await EncView.snapshot({ w: 1500, h: 1000, explode: true }); if (b) out.encx = b; } catch (e) { }
    }
    step('');
    imgs = out; imgKey = key;
    return out;
  }

  // ---------- preview (HTML) ----------
  const esc2 = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lines = s => String(s || '').split('\n').map(x => x.replace(/^[-•*]\s*/, '').trim()).filter(Boolean);
  const tbl = (head, rows, widths) => `<table class="dtab">${widths ? `<colgroup>${widths.map(w => `<col style="width:${w}%">`).join('')}</colgroup>` : ''}<thead><tr>${head.map(h => `<th>${esc2(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${esc2(c)}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
  const img = (im, cls = '') => im ? `<img class="dimg ${cls}" src="${im.url}">` : '';
  async function render() {
    const el = $('#docPages'); if (!el) return;
    const d = doc();
    if (!Model.S.components.length) { el.innerHTML = '<div class="dpage"><h1>No design yet</h1><p class="muted">Add parts (or ask the AI copilot to design a circuit) — the datasheet is generated from the schematic, PCB and enclosure.</p></div>'; return; }
    const I = await ensureImages(false), D = collect();   // images first: they build the custom enclosure
    const keySpecs = [['Board', D.hasPcb ? `${D.S.board.w} × ${D.S.board.h} mm, ${Pcb.rules().layers === 1 ? '1' : '2'}-layer` : '—'], ['Power rails', D.power.join(', ') || '—'], ['Main ICs', D.ics.slice(0, 4).map(i => `${i.ref} ${i.value}`).join(', ') || '—'], ['Connectors', D.conns.map(c => `${c.ref} ${c.value}`).join(', ') || '—'], ['Components', String(D.S.components.length)]].concat(D.enc && D.enc.outer ? [['Enclosure', `${D.enc.outer.join(' × ')} mm`]] : []);
    let h = `<div class="dpage cover"><div class="dhead"><span>${esc2(d.title)}</span><span>Datasheet · Rev ${esc2(d.version)}</span></div>
      <h1>${esc2(d.title)}</h1>${d.subtitle ? `<div class="dsub">${esc2(d.subtitle)}</div>` : ''}
      ${img(I.pcb3d_iso, 'hero') || img(I.sch, 'hero')}
      <h2>Key specifications</h2>${tbl(['', ''], keySpecs, [30, 70])}
      ${d.description ? `<h2>Description</h2><p>${esc2(d.description).replace(/\n/g, '<br>')}</p>` : '<p class="muted">Add a description in the panel on the left (or ✦ Write with AI).</p>'}</div>`;
    if (d.features || d.applications) h += `<div class="dpage">${d.features ? `<h2>Features</h2><ul>${lines(d.features).map(x => `<li>${esc2(x)}</li>`).join('')}</ul>` : ''}${d.applications ? `<h2>Applications</h2><ul>${lines(d.applications).map(x => `<li>${esc2(x)}</li>`).join('')}</ul>` : ''}
      ${D.ics.length ? `<h2>Main components</h2>${tbl(['Ref', 'Part', 'Description'], D.ics.map(i => [i.ref, i.value, i.desc]))}` : ''}</div>`;
    for (const s of I.schs || []) h += `<div class="dpage"><h2>Schematic${(I.schs || []).length > 1 ? ` — sheet ${s.sheet}: ${esc2(s.name)}` : ''}</h2>${img(s)}</div>`;
    if (D.hasPcb) h += `<div class="dpage"><h2>PCB</h2><div class="dgrid">${img(I.pcb3d_top)}${img(I.pcb3d_bottom)}</div><div class="dcap"><span>Top</span><span>Bottom</span></div>${img(I.pcb2d)}<div class="dcap"><span>Copper layout (red: top, blue: bottom)</span></div><h2>PCB specifications</h2>${tbl(['Parameter', 'Value'], D.specs)}</div>`;
    if (D.hasPcb) h += `<div class="dpage"><h2>Mechanical drawing</h2>${img(I.mech)}${D.conns.length ? '<h2>Connector pinout</h2>' + D.conns.map(c => `<h3>${esc2(c.ref)} — ${esc2(c.value)}${c.edge ? ` <span class="muted">(${c.edge} edge)</span>` : ''}</h3>${tbl(['Pin', 'Name', 'Signal'], c.pins.map(p => [p.num, p.name, p.net]))}`).join('') : ''}</div>`;
    if (D.enc) h += `<div class="dpage"><h2>Enclosure</h2><div class="dgrid">${img(I.enc)}${img(I.encx)}</div><div class="dcap"><span>Assembled</span><span>Exploded</span></div><p class="muted">${esc2(D.enc.kind)} — 3D-printable (STL + OpenSCAD in the Enclosure tab).</p>${tbl(D.enc.outer ? ['Dimension', 'Value'] : ['Part', 'Size (W × D × H)', 'Volume'], D.enc.rows)}</div>`;
    h += `<div class="dpage"><h2>Bill of materials</h2>${tbl(['Qty', 'References', 'Value', 'Footprint', 'Description', 'LCSC'], D.bom.map(b => [b.qty, b.refs, b.value, b.fp, b.desc, b.lcsc]), [7, 17, 14, 23, 25, 14])}${d.notes ? `<h2>Notes</h2><p>${esc2(d.notes).replace(/\n/g, '<br>')}</p>` : ''}</div>`;
    el.innerHTML = h;
  }

  // ---------- PDF ----------
  function loadLibs() {
    if (libs) return libs;
    const add = src => new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load the PDF library (needs internet)')); document.head.appendChild(s); });
    libs = add('https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js').then(() => add('https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/3.8.2/jspdf.plugin.autotable.min.js'));
    libs.catch(() => { libs = null; });
    return libs;
  }
  async function pdf() {
    if (building) return; building = true;
    try {
      App.toast('Building the PDF datasheet…', 20000);
      await loadLibs();
      const d = doc(), I = await ensureImages(false), D = collect();
      const P = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
      const M = 15, PW = 210, PH = 297, CW = PW - 2 * M, date = new Date().toISOString().slice(0, 10);
      let y = 0;
      const drawHeader = () => { P.setFillColor(...ACCENT); P.rect(0, 0, PW, 3.5, 'F'); P.setFont('helvetica', 'normal'); P.setFontSize(8.5); P.setTextColor(100); P.text(d.title, M, 10); P.text(`Datasheet · Rev ${d.version}`, PW - M, 10, { align: 'right' }); P.setDrawColor(225); P.setLineWidth(0.2); P.line(M, 12.5, PW - M, 12.5); };
      const newPage = () => { P.addPage(); drawHeader(); y = 20; };
      const need = hh => { if (y + hh > PH - 16) newPage(); };
      const h2 = t => { need(14); P.setFont('helvetica', 'bold'); P.setFontSize(13); P.setTextColor(17, 24, 39); P.text(t, M, y); y += 2; P.setDrawColor(...ACCENT); P.setLineWidth(0.7); P.line(M, y, M + 16, y); P.setLineWidth(0.2); y += 6; P.setFont('helvetica', 'normal'); };
      const h3 = t => { need(9); P.setFont('helvetica', 'bold'); P.setFontSize(10); P.setTextColor(31, 41, 55); P.text(t, M, y); y += 5; P.setFont('helvetica', 'normal'); };
      const para = (t, size = 9.5) => { P.setFontSize(size); P.setTextColor(55, 65, 81); for (const ln of P.splitTextToSize(String(t), CW)) { need(5); P.text(ln, M, y); y += size * 0.45; } y += 2.5; };
      const bullets = items => { P.setFontSize(9.5); P.setTextColor(55, 65, 81); for (const it of items) { const ls = P.splitTextToSize(it, CW - 6); need(ls.length * 4.5); P.setFillColor(...ACCENT); P.circle(M + 1.3, y - 1.2, 0.7, 'F'); ls.forEach((ln, i) => { P.text(ln, M + 5, y); y += 4.4; }); y += 0.6; } y += 2; };
      const image = (im, maxW = CW, maxH = 110, x0 = null) => { if (!im) return 0; const r = Math.min(maxW / im.w, maxH / im.h), w = im.w * r, h = im.h * r; if (x0 == null) { need(h + 3); P.addImage(im.url, 'PNG', M + (CW - w) / 2, y, w, h, undefined, 'FAST'); y += h + 3; } else P.addImage(im.url, 'PNG', x0 + (maxW - w) / 2, y, w, h, undefined, 'FAST'); return h; };
      const caption = t => { P.setFontSize(8); P.setTextColor(107, 114, 128); P.text(t, PW / 2, y, { align: 'center' }); y += 6; };
      const table = (head, body, opts = {}) => { need(16); P.autoTable(Object.assign({ startY: y, head: [head], body, margin: { left: M, right: M, top: 18 }, theme: 'grid', styles: { fontSize: 8.3, cellPadding: 1.5, lineColor: [229, 231, 235], textColor: [31, 41, 55] }, headStyles: { fillColor: ACCENT, textColor: 255, fontStyle: 'bold' }, alternateRowStyles: { fillColor: [248, 250, 252] }, didDrawPage: () => drawHeader() }, opts)); y = P.lastAutoTable.finalY + 6; };

      // cover
      drawHeader(); y = 30;
      P.setFont('helvetica', 'bold'); P.setFontSize(26); P.setTextColor(17, 24, 39); P.text(P.splitTextToSize(d.title, CW), M, y); y += 11;
      if (d.subtitle) { P.setFont('helvetica', 'normal'); P.setFontSize(12.5); P.setTextColor(75, 85, 99); for (const ln of P.splitTextToSize(d.subtitle, CW)) { P.text(ln, M, y); y += 6; } }
      y += 4;
      image(I.pcb3d_iso || I.sch, CW, 95);
      const keySpecs = [['Board', D.hasPcb ? `${D.S.board.w} × ${D.S.board.h} mm, ${Pcb.rules().layers === 1 ? '1' : '2'}-layer FR-4` : '—'], ['Power rails', D.power.join(', ') || '—'], ['Main ICs', D.ics.slice(0, 4).map(i => `${i.ref} ${i.value}`).join(', ') || '—'], ['Connectors', D.conns.map(c => `${c.ref} ${c.value}`).join(', ') || '—'], ['Components', String(D.S.components.length)]].concat(D.enc && D.enc.outer ? [['Enclosure', `${D.enc.outer.join(' × ')} mm`]] : D.enc ? [['Enclosure', D.enc.kind]] : []);
      h2('Key specifications'); table(['Parameter', 'Value'], keySpecs, { columnStyles: { 0: { cellWidth: 45, fontStyle: 'bold' } } });
      if (d.description) { h2('Description'); para(d.description); }
      // features
      if (d.features || d.applications || D.ics.length) {
        newPage();
        if (d.features) { h2('Features'); bullets(lines(d.features)); }
        if (d.applications) { h2('Applications'); bullets(lines(d.applications)); }
        if (D.ics.length) { h2('Main components'); table(['Ref', 'Part', 'Description'], D.ics.map(i => [i.ref, i.value, i.desc])); }
        if (D.power.length) { h2('Power'); para(`Supply rails: ${D.power.join(', ')}. Ground: ${D.nets.filter(n => Model.isGround(n)).join(', ') || 'GND'}.`); }
      }
      // schematic
      for (const s of I.schs || []) { newPage(); h2((I.schs || []).length > 1 ? `Schematic — sheet ${s.sheet}: ${s.name}` : 'Schematic'); image(s, CW, PH - 50); }
      // pcb
      if (D.hasPcb) {
        newPage(); h2('PCB');
        if (I.pcb3d_top || I.pcb3d_bottom) { need(70); const half = (CW - 6) / 2, ha = image(I.pcb3d_top, half, 70, M), hb = image(I.pcb3d_bottom, half, 70, M + half + 6); y += Math.max(ha, hb) + 2; P.setFontSize(8); P.setTextColor(107, 114, 128); P.text('Top', M + half / 2, y, { align: 'center' }); P.text('Bottom', M + half + 6 + half / 2, y, { align: 'center' }); y += 6; }
        if (I.pcb2d) { image(I.pcb2d, CW, 85); caption('Copper layout — red: top layer, blue: bottom layer'); }
        h2('PCB specifications'); table(['Parameter', 'Value'], D.specs, { columnStyles: { 0: { cellWidth: 55, fontStyle: 'bold' } } });
        newPage(); h2('Mechanical drawing'); image(I.mech, CW, 140);
        if (D.conns.length) { h2('Connector pinout'); for (const c of D.conns) { h3(`${c.ref} — ${c.value}${c.edge ? ` (${c.edge} edge)` : ''}`); table(['Pin', 'Name', 'Signal'], c.pins.map(p => [p.num, p.name, p.net])); } }
      }
      // enclosure
      if (D.enc) {
        newPage(); h2('Enclosure');
        if (I.enc || I.encx) { need(75); const half = (CW - 6) / 2, ha = image(I.enc, half, 75, M), hb = image(I.encx, half, 75, M + half + 6); y += Math.max(ha, hb) + 2; P.setFontSize(8); P.setTextColor(107, 114, 128); P.text('Assembled', M + half / 2, y, { align: 'center' }); P.text('Exploded', M + half + 6 + half / 2, y, { align: 'center' }); y += 7; }
        para(`${D.enc.kind}. 3D-printable — STL files (high resolution, oriented for printing) and OpenSCAD source are exported from the Enclosure tab.`);
        table(D.enc.outer ? ['Dimension', 'Value'] : ['Part', 'Size (W × D × H)', 'Volume'], D.enc.rows);
      }
      // BOM + notes
      newPage(); h2('Bill of materials');
      table(['Qty', 'References', 'Value', 'Footprint', 'Description', 'LCSC'], D.bom.map(b => [b.qty, b.refs, b.value, b.fp, b.desc, b.lcsc]), { columnStyles: { 0: { cellWidth: 10, halign: 'center' }, 1: { cellWidth: 32 }, 5: { cellWidth: 18 } } });
      if (d.notes) { h2('Notes'); para(d.notes); }
      h2('Revision'); table(['Rev', 'Date', 'Description'], [[d.version, date, 'Generated from the design files']]);
      // footers
      const n = P.getNumberOfPages();
      for (let i = 1; i <= n; i++) { P.setPage(i); P.setFontSize(8); P.setTextColor(140); P.text(`${d.company ? d.company + ' · ' : ''}${d.title} · Rev ${d.version} · ${date}`, M, PH - 8); P.text(`Page ${i} of ${n}`, PW - M, PH - 8, { align: 'right' }); }
      P.save(`${(d.title || 'datasheet').replace(/[^\w.-]+/g, '_')}-datasheet.pdf`);
      App.toast(`✓ PDF datasheet saved (${n} pages)`, 5000);
    } catch (e) { App.toast('PDF: ' + e.message, 7000); }
    finally { building = false; }
  }

  // ---------- AI text ----------
  async function aiWrite() {
    if (!AI.modelReady()) { App.toast('Set up an AI model in ⚙ Settings first'); return; }
    const D = collect(), d = doc(), st = $('#docStatus');
    if (st) st.textContent = '✦ AI is writing the product text…';
    const summary = { name: d.title, board: D.hasPcb ? `${D.S.board.w} x ${D.S.board.h} mm, ${Pcb.rules().layers}-layer` : 'no PCB yet', main_ics: D.ics.map(i => `${i.ref}: ${i.value} (${i.desc})`), connectors: D.conns.map(c => `${c.ref}: ${c.value} pins ${c.pins.map(p => p.name + '=' + p.net).join(', ')}`), power_rails: D.power, nets: D.nets.slice(0, 60), parts: D.bom.map(b => `${b.qty}x ${b.value} ${b.desc}`), enclosure: D.enc ? (D.enc.outer ? D.enc.outer.join('x') + ' mm box' : D.enc.kind) : 'none' };
    try {
      const txt = await AI.complete('You write concise, accurate electronics product datasheets. Answer with JSON only.',
        `Write datasheet text for this product. Base every statement on the design data; do not invent ratings that are not implied by the parts.\n${JSON.stringify(summary)}\n\nReply with JSON: {"subtitle":"one-line product tagline","description":"2-3 short paragraphs: what it is, how it works, main blocks","features":["6-10 short feature bullets"],"applications":["3-6 application bullets"]}${/qwen|qwq|deepseek-r/i.test(AI.settings.model) ? '\n/no_think' : ''}`, { json: true, maxTokens: 4000 });
      const m = txt.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/); const j = m ? JSON.parse(m[0]) : null;
      if (!j) throw new Error('no JSON in the reply');
      setDoc({ subtitle: j.subtitle || d.subtitle, description: j.description || d.description, features: (j.features || []).join('\n') || d.features, applications: (j.applications || []).join('\n') || d.applications });
      App.toast('✦ Text written — edit it in the panel', 5000);
    } catch (e) { App.toast('AI text: ' + e.message, 6000); }
    finally { if (st) st.textContent = ''; App.renderAll(); render(); }
  }

  // ---------- panel + lifecycle ----------
  function props(el) {
    const d = doc();
    el.innerHTML = `<div class="ph">Datasheet</div>
      <label class="dfield">Title<input data-d="title" value="${esc2(d.title)}"></label>
      <label class="dfield">Tagline<input data-d="subtitle" value="${esc2(d.subtitle)}" placeholder="e.g. Low-power ESP32-C3 sensor node with USB-C"></label>
      <div class="encgrid"><label>Revision<input data-d="version" value="${esc2(d.version)}"></label><label>Company / author<input data-d="company" value="${esc2(d.company)}"></label></div>
      <label class="dfield">Description<textarea data-d="description" rows="6">${esc2(d.description)}</textarea></label>
      <label class="dfield">Features (one per line)<textarea data-d="features" rows="6">${esc2(d.features)}</textarea></label>
      <label class="dfield">Applications (one per line)<textarea data-d="applications" rows="4">${esc2(d.applications)}</textarea></label>
      <label class="dfield">Notes<textarea data-d="notes" rows="3">${esc2(d.notes)}</textarea></label>
      <div class="muted small">Everything else (specifications, schematic, PCB renders, mechanical drawing, pinouts, enclosure, BOM) comes from the design automatically.</div>`;
    el.querySelectorAll('[data-d]').forEach(i => i.onchange = () => { setDoc({ [i.dataset.d]: i.value }); render(); });
    return true;
  }
  function init() {
    $('#docView').innerHTML = '<div id="docStatus" class="docstatus"></div><div id="docPages" class="docpages"></div>';
    $('#docPdf').onclick = pdf;
    $('#docAi').onclick = aiWrite;
    $('#docRefresh').onclick = async () => { await ensureImages(true); render(); };
    Model.subscribe(kind => { if (kind === 'move' || kind === 'doc' || !active) return; clearTimeout(init._t); init._t = setTimeout(render, 900); });
  }
  function show() { active = true; render(); }
  function hide() { active = false; }
  return { init, show, hide, props, pdf, render, collect, mechSVG, svgToPng };
})();
