'use strict';
// EasyEDA Pro import: a project exported from EasyEDA Pro (.epro / .epro2 / .zip) becomes a CircuitPilot project —
// schematic parts with their real pin names and sheets, footprints (LCSC numbers kept), nets, and the PCB with
// placement, top/bottom side, tracks, vias, copper pours and the board outline.
//   .epro  (Pro 1.x/2.0): zip with project.json + SHEET/*.esch, PCB/*.epcb, SYMBOL/*.esym, FOOTPRINT/*.efoo (JSON lines)
//   .epro2 (Pro 2.2+):    zip with project2.json + one *.epru file: documents one after the other, each line
//                         "<header json>||<record json>|", a DOCHEAD line starting each document
// CircuitPilot boards are 2-layer: copper on inner layers is skipped (reported).
const EasyEDAPro = (() => {
  const MIL = 0.0254, n4 = v => +(+v).toFixed(4);

  // ---------- zip (store + deflate; DecompressionStream in browsers and Node 18+) ----------
  async function inflate(bytes) {
    const ds = new DecompressionStream('deflate-raw');
    const out = new Response(new Blob([bytes]).stream().pipeThrough(ds));
    return new Uint8Array(await out.arrayBuffer());
  }
  async function unzip(buf) {
    const b = new Uint8Array(buf), dv = new DataView(b.buffer, b.byteOffset, b.byteLength), files = new Map();
    let eocd = -1; for (let i = b.length - 22; i >= Math.max(0, b.length - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('not a zip file');
    const n = dv.getUint16(eocd + 10, true); let p = dv.getUint32(eocd + 16, true);
    const dec = new TextDecoder('utf-8');
    for (let k = 0; k < n; k++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true), nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true), off = dv.getUint32(p + 42, true);
      const name = dec.decode(b.subarray(p + 46, p + 46 + nlen)); p += 46 + nlen + xlen + clen;
      if (name.endsWith('/')) continue;
      const lnl = dv.getUint16(off + 26, true), lxl = dv.getUint16(off + 28, true), start = off + 30 + lnl + lxl, raw = b.subarray(start, start + csize);
      files.set(name, { method, raw });
    }
    return { names: [...files.keys()], text: async name => { const f = files.get(name); if (!f) return null; const d = f.method === 8 ? await inflate(f.raw) : f.raw; return dec.decode(d); } };
  }

  // ---------- normal form ----------
  // sym:  { name, type (18 power port, 19 net port, 2 part…), pins: [{ num, name, x, y, rot, part }] }
  // foot: { name, pads: [{ num, x, y, w, h, shape, drill, rot, layer }] }   (mil, source coordinates)
  // sheet: { name, comps: [{ id, part, x, y, rot, mirror, attrs }], wires: [{ id, segs: [[x1,y1,x2,y2]], net }], texts }
  // pcb:  { comps: [{ id, x, y, angle, layer, attrs }], padNets: [[compId, pad, net]], lines, arcs, vias, outline: [path], pours: [{ net, layer, paths }] }
  const lines = t => (t || '').split(/\r?\n/).filter(l => l.trim()).map(l => { try { return JSON.parse(l); } catch (e) { return null; } }).filter(Boolean);
  function v1Attrs(recs) { const by = {}; for (const r of recs) if (r[0] === 'ATTR') (by[r[2]] = by[r[2]] || {})[r[3]] = r[4]; return by; }
  function v1Symbol(text, meta) {
    const recs = lines(text), at = v1Attrs(recs), pins = []; let part = '';
    for (const r of recs) {
      if (r[0] === 'PART') part = r[1];
      else if (r[0] === 'PIN') { const a = at[r[1]] || {}; pins.push({ num: String(a.NUMBER ?? a['Pin Number'] ?? ''), name: String(a.NAME ?? a['Pin Name'] ?? ''), x: +r[4], y: +r[5], rot: +r[7] || 0, part }); }
    }
    const root = at[''] || {};
    return { name: root.Symbol || (meta && meta.title) || '', type: meta && meta.type != null ? +meta.type : 2, pins };
  }
  function v1Pad(r) {
    const hole = Array.isArray(r[9]) ? r[9] : null, shp = Array.isArray(r[10]) ? r[10] : ['RECT', 10, 10];
    let w = +shp[1] || 0, h = +shp[2] || 0;
    if (/^POLY/.test(shp[0]) && Array.isArray(shp[1])) { const bb = pathBox([shp[1]]); if (bb) { w = bb[2] - bb[0]; h = bb[3] - bb[1]; } }
    return { num: String(r[5]), x: +r[6], y: +r[7], rot: +r[8] || 0, w, h, shape: /ELLIPSE/.test(shp[0]) ? 'round' : /OVAL/.test(shp[0]) ? 'oval' : 'rect', drill: hole && (+hole[1] > 0) ? Math.min(+hole[1], +hole[2] || +hole[1]) : 0, layer: +r[4], net: r[3] || '' };
  }
  function v1Foot(text, meta) {
    const recs = lines(text), pads = [];
    for (const r of recs) if (r[0] === 'PAD') pads.push(v1Pad(r));
    return { name: (v1Attrs(recs)[''] || {}).Footprint || (meta && meta.title) || 'FOOTPRINT', pads };
  }
  function v1Sheet(text, name) {
    const recs = lines(text), at = v1Attrs(recs), comps = [], wires = [];
    for (const r of recs) {
      if (r[0] === 'COMPONENT') comps.push({ id: r[1], part: r[2], x: +r[3], y: +r[4], rot: +r[5] || 0, mirror: !!r[6], attrs: at[r[1]] || {} });
      else if (r[0] === 'WIRE') wires.push({ id: r[1], segs: (r[2] || []).filter(s => s.length >= 4).flatMap(s => { const o = []; for (let i = 0; i + 3 < s.length; i += 2) o.push([+s[i], +s[i + 1], +s[i + 2], +s[i + 3]]); return o; }), net: (at[r[1]] || {}).NET || '' });
    }
    return { name, comps, wires };
  }
  function v1Pcb(text) {
    const recs = lines(text), at = {}, pcb = { comps: [], padNets: [], lines: [], arcs: [], vias: [], outline: [], pours: [], pads: [] };
    for (const r of recs) if (r[0] === 'ATTR') (at[r[3]] = at[r[3]] || {})[r[7]] = r[8];
    for (const r of recs) {
      const t = r[0];
      if (t === 'COMPONENT') pcb.comps.push({ id: r[1], layer: +r[3], x: +r[4], y: +r[5], angle: +r[6] || 0, attrs: Object.assign({}, r[7] || {}, at[r[1]] || {}) });
      else if (t === 'PAD_NET') pcb.padNets.push([r[1], String(r[2]), r[3] || '']);
      else if (t === 'LINE') pcb.lines.push({ net: r[3] || '', layer: +r[4], x1: +r[5], y1: +r[6], x2: +r[7], y2: +r[8], w: +r[9] });
      else if (t === 'ARC') pcb.arcs.push({ net: r[3] || '', layer: +r[4], x1: +r[5], y1: +r[6], x2: +r[7], y2: +r[8], angle: +r[9], w: +r[10] });
      else if (t === 'VIA') pcb.vias.push({ net: r[3] || '', x: +r[5], y: +r[6], drill: +r[7], d: +r[8] });
      else if (t === 'POLY' && +r[4] === 11) pcb.outline.push(r[6]);
      else if (t === 'POUR') pcb.pours.push({ net: r[3] || '', layer: +r[4], paths: r[8] || [] });
      else if (t === 'PAD') pcb.pads.push(v1Pad(r));
    }
    return pcb;
  }

  // .epro2: "<header>||<record>|" lines, documents started by DOCHEAD. Its schematics and symbols are y-down: y is negated
  // on reading so both formats share one (y-up, counter-clockwise) convention; PCBs and footprints are y-up in both.
  function v2Docs(text) {
    const docs = []; let cur = null;
    for (const l of (text || '').split(/\r?\n/)) {
      if (!l) continue;
      const i = l.indexOf('||'); if (i < 0) continue;
      let h, p = null; try { h = JSON.parse(l.slice(0, i)); const rest = l.slice(i + 2).replace(/\|$/, ''); p = rest ? JSON.parse(rest) : null; } catch (e) { continue; }
      if (h.type === 'DOCHEAD') { cur = { head: p || {}, recs: [] }; docs.push(cur); } else if (cur) cur.recs.push([h, p || {}]);
    }
    return docs;
  }
  const v2Attrs = recs => { const by = {}; for (const [h, p] of recs) if (h.type === 'ATTR') (by[p.parentId || ''] = by[p.parentId || ''] || {})[p.key] = p.value; return by; };
  const v2Meta = d => { const m = d.recs.find(([h]) => h.type === 'META'); return m ? m[1] : {}; };
  function v2Symbol(d) {
    const at = v2Attrs(d.recs), pins = [], meta = v2Meta(d);
    for (const [h, p] of d.recs) if (h.type === 'PIN') { const a = at[h.id] || {}; pins.push({ num: String(a['Pin Number'] ?? a.NUMBER ?? ''), name: String(a['Pin Name'] ?? a.NAME ?? ''), x: +p.x, y: -p.y, rot: +p.rotation || 0, part: p.partId || '' }); }
    return { name: (at[''] || {}).Symbol || meta.title || '', type: meta.docType != null ? +meta.docType : 2, pins };
  }
  function v2Pad(p) {
    const s = p.defaultPad || {}; let w = +s.width || 0, h = +s.height || 0;
    if (/POLY/.test(s.padType || '') && s.path) { const bb = pathBox(Array.isArray(s.path[0]) ? s.path : [s.path]); if (bb) { w = bb[2] - bb[0]; h = bb[3] - bb[1]; } }
    const hole = p.hole && (+p.hole.width > 0) ? Math.min(+p.hole.width, +p.hole.height || +p.hole.width) : 0;
    return { num: String(p.num), x: +p.centerX, y: +p.centerY, rot: +p.padAngle || 0, w, h, shape: /ELLIPSE/.test(s.padType || '') ? 'round' : /OVAL/.test(s.padType || '') ? 'oval' : 'rect', drill: hole, layer: +p.layerId, net: p.netName || '' };
  }
  function v2Foot(d) {
    const pads = d.recs.filter(([h]) => h.type === 'PAD').map(([, p]) => v2Pad(p));
    return { name: (v2Attrs(d.recs)[''] || {}).Footprint || v2Meta(d).title || 'FOOTPRINT', pads };
  }
  function v2Sheet(d) {
    const at = v2Attrs(d.recs), comps = [], wires = new Map();
    for (const [h, p] of d.recs) {
      if (h.type === 'COMPONENT') comps.push({ id: h.id, part: p.partId || '', x: +p.x, y: -p.y, rot: +p.rotation || 0, mirror: !!p.isMirror, attrs: at[h.id] || {} });
      else if (h.type === 'WIRE') wires.set(h.id, { id: h.id, segs: [], net: (at[h.id] || {}).NET || '' });
    }
    for (const [h, p] of d.recs) if (h.type === 'LINE' && p.lineGroup && wires.has(p.lineGroup)) wires.get(p.lineGroup).segs.push([+p.startX, -p.startY, +p.endX, -p.endY]);
    return { name: v2Meta(d).title || 'Sheet', comps, wires: [...wires.values()] };
  }
  function v2Pcb(d) {
    const at = {}, pcb = { comps: [], padNets: [], lines: [], arcs: [], vias: [], outline: [], pours: [], pads: [] };
    for (const [h, p] of d.recs) if (h.type === 'ATTR') (at[p.parentId] = at[p.parentId] || {})[p.key] = p.value;
    for (const [h, p] of d.recs) {
      const t = h.type;
      if (t === 'COMPONENT') pcb.comps.push({ id: h.id, layer: +p.layerId, x: +p.x, y: +p.y, angle: +p.angle || 0, attrs: Object.assign({}, p.attrs || {}, at[h.id] || {}) });
      else if (t === 'PAD_NET') { let k; try { k = JSON.parse(h.id); } catch (e) { k = null; } if (k) pcb.padNets.push([k[1], String(k[2]), p.padNet || '']); }
      else if (t === 'LINE') pcb.lines.push({ net: p.netName || '', layer: +p.layerId, x1: +p.startX, y1: +p.startY, x2: +p.endX, y2: +p.endY, w: +p.width });
      else if (t === 'ARC') pcb.arcs.push({ net: p.netName || '', layer: +p.layerId, x1: +p.startX, y1: +p.startY, x2: +p.endX, y2: +p.endY, angle: +p.angle, w: +p.width });
      else if (t === 'VIA') pcb.vias.push({ net: p.netName || '', x: +p.centerX, y: +p.centerY, drill: +p.holeDiameter, d: +p.viaDiameter });
      else if (t === 'POLY' && (+p.layerId === 11 || p.polyType === 'BOARD_OUTLINE')) pcb.outline.push(p.path);
      else if (t === 'POUR') pcb.pours.push({ net: p.netName || '', layer: +p.layerId, paths: p.path || [] });
      else if (t === 'PAD') pcb.pads.push(v2Pad(p));
    }
    return pcb;
  }

  // ---------- Pro paths: numbers = point, "L" lines, "ARC"/"CARC" angle x y, "C" bezier, "CIRCLE" cx cy r, "R" x y w h angle r ----------
  function arcPts(x0, y0, x1, y1, ang, steps) {
    const th = ang * Math.PI / 180, dx = x1 - x0, dy = y1 - y0, c = Math.hypot(dx, dy);
    if (!c || Math.abs(th) < 1e-6) return [[x1, y1]];
    const R = c / (2 * Math.sin(Math.abs(th) / 2)), d = R * Math.cos(th / 2) * Math.sign(th), mx = (x0 + x1) / 2, my = (y0 + y1) / 2;
    const cx = mx - dy / c * d, cy = my + dx / c * d, a0 = Math.atan2(y0 - cy, x0 - cx), n = steps || Math.max(4, Math.ceil(Math.abs(ang) / 10)), out = [];
    for (let k = 1; k <= n; k++) { const a = a0 + th * k / n; out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]); }
    return out;
  }
  function pathPts(path) {
    if (!Array.isArray(path)) return [];
    if (path[0] === 'CIRCLE') { const [, cx, cy, r] = path.map(Number); return Array.from({ length: 48 }, (_, i) => [cx + r * Math.cos(i / 48 * 2 * Math.PI), cy + r * Math.sin(i / 48 * 2 * Math.PI)]); }
    if (path[0] === 'R') { const [, x, y, w, h] = path.map(Number); return [[x, y], [x + w, y], [x + w, y - h], [x, y - h]]; }
    const out = []; let i = 0, mode = 'L';
    while (i < path.length) {
      const v = path[i];
      if (typeof v === 'string') { mode = v; i++; continue; }
      if (mode === 'ARC' || mode === 'CARC') { const p0 = out[out.length - 1] || [0, 0]; out.push(...arcPts(p0[0], p0[1], +path[i + 1], +path[i + 2], +v)); i += 3; continue; }
      if (mode === 'C') { const p0 = out[out.length - 1] || [0, 0], q = path.slice(i, i + 6).map(Number); for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; out.push([u * u * u * p0[0] + 3 * u * u * t * q[0] + 3 * u * t * t * q[2] + t * t * t * q[4], u * u * u * p0[1] + 3 * u * u * t * q[1] + 3 * u * t * t * q[3] + t * t * t * q[5]]); } i += 6; continue; }
      out.push([+v, +path[i + 1]]); i += 2;
    }
    return out;
  }
  function pathBox(paths) {
    const pts = paths.flatMap(pathPts); if (!pts.length) return null;
    return [Math.min(...pts.map(p => p[0])), Math.min(...pts.map(p => p[1])), Math.max(...pts.map(p => p[0])), Math.max(...pts.map(p => p[1]))];
  }

  // ---------- read a project file ----------
  async function read(buf) {
    const z = await unzip(buf), P = { symbols: {}, footprints: {}, devices: {}, boards: [] };
    if (z.names.includes('project.json')) {   // .epro
      const pj = JSON.parse(await z.text('project.json'));
      P.format = 'EasyEDA Pro (.epro)';
      for (const [u, m] of Object.entries(pj.symbols || {})) { const t = await z.text('SYMBOL/' + u + '.esym'); if (t) P.symbols[u] = v1Symbol(t, m); }
      for (const [u, m] of Object.entries(pj.footprints || {})) { const t = await z.text('FOOTPRINT/' + u + '.efoo'); if (t) P.footprints[u] = v1Foot(t, m); }
      for (const [u, d] of Object.entries(pj.devices || {})) P.devices[u] = { title: d.title || '', attrs: d.attributes || {} };
      const sheetsOf = async uuid => { const s = (pj.schematics || {})[uuid]; if (!s) return []; const out = []; for (const sh of (s.sheets || []).slice().sort((a, b) => a.id - b.id)) { const t = await z.text(`SHEET/${uuid}/${sh.id}.esch`); if (t) out.push(v1Sheet(t, sh.name || 'Sheet ' + sh.id)); } return out; };
      const pcbName = u => { const v = (pj.pcbs || {})[u]; return typeof v === 'string' ? v : v && v.title || 'PCB'; };
      const usedSch = new Set();
      for (const [name, b] of Object.entries(pj.boards || {})) {
        usedSch.add(b.schematic);
        P.boards.push({ name, schematic: (pj.schematics[b.schematic] || {}).name || null, load: async () => ({ sheets: await sheetsOf(b.schematic), pcb: b.pcb && await z.text('PCB/' + b.pcb + '.epcb') ? v1Pcb(await z.text('PCB/' + b.pcb + '.epcb')) : null }), pcbName: b.pcb ? pcbName(b.pcb) : null });
      }
      for (const [u, s] of Object.entries(pj.schematics || {})) if (!usedSch.has(u)) P.boards.push({ name: s.name || 'Schematic', schematic: s.name, pcbName: null, load: async () => ({ sheets: await sheetsOf(u), pcb: null }) });
    } else {   // .epro2
      const epru = z.names.find(n => /\.epru$/i.test(n)); if (!epru) throw new Error('This zip is not an EasyEDA Pro project (no project.json or .epru inside)');
      P.format = 'EasyEDA Pro (.epro2)';
      const docs = v2Docs(await z.text(epru)), of = t => docs.filter(d => d.head.docType === t);
      for (const d of of('SYMBOL')) P.symbols[d.head.uuid] = v2Symbol(d);
      for (const d of of('FOOTPRINT')) P.footprints[d.head.uuid] = v2Foot(d);
      for (const d of of('DEVICE')) { const m = v2Meta(d); P.devices[d.head.uuid] = { title: m.title || '', attrs: m.attributes || {} }; }
      const schs = of('SCH'), pages = of('SCH_PAGE'), pcbs = of('PCB');
      const sheetsOf = schUuid => pages.filter(d => v2Meta(d).schematic === schUuid).sort((a, b) => (+v2Meta(a).zIndex || 0) - (+v2Meta(b).zIndex || 0)).map(v2Sheet);
      const usedSch = new Set();
      for (const b of of('BOARD')) {
        const sch = schs.find(d => v2Meta(d).board === b.head.uuid), pcb = pcbs.find(d => v2Meta(d).board === b.head.uuid);
        if (sch) usedSch.add(sch.head.uuid);
        P.boards.push({ name: v2Meta(b).title || 'Board', schematic: sch ? v2Meta(sch).title : null, pcbName: pcb ? v2Meta(pcb).title : null, load: async () => ({ sheets: sch ? sheetsOf(sch.head.uuid) : [], pcb: pcb ? v2Pcb(pcb) : null }) });
      }
      for (const s of schs) if (!usedSch.has(s.head.uuid)) P.boards.push({ name: v2Meta(s).title || 'Schematic', schematic: v2Meta(s).title, pcbName: null, load: async () => ({ sheets: sheetsOf(s.head.uuid), pcb: null }) });
      for (const d of pcbs) if (!v2Meta(d).board) P.boards.push({ name: v2Meta(d).title || 'PCB', schematic: null, pcbName: v2Meta(d).title, load: async () => ({ sheets: [], pcb: v2Pcb(d) }) });
    }
    if (!P.boards.length) throw new Error('No schematic or PCB found in this EasyEDA Pro project');
    return P;
  }

  // ---------- geometry helpers ----------
  const rotS = (x, y, a) => { const t = a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [x * c - y * s, x * s + y * c]; };
  // world position of a footprint pad in source coordinates, for one convention variant
  // (bottom parts: EasyEDA Pro mirrors the footprint in y, then rotates — the score below confirms it per file)
  const padWorld = (c, p, v) => { let x = p.x, y = p.y; if (c.layer === 2) { if (v.mirror === 'x') x = -x; else y = -y; } const [u, w] = rotS(x, y, c.angle * v.sign); return [c.x + u, c.y + w]; };

  // ---------- build the CircuitPilot project ----------
  // load the board's documents (async), then build inside one undoable Model.mutate
  async function importBoard(P, idx) {
    const B = P.boards[idx || 0], D = await B.load();
    return Model.mutate(() => build(P, B, D));
  }
  function build(P, B, D) {
    const S = Model.S, notes = [];
    const devOf = attrs => P.devices[attrs.Device] || null;
    const lcscOf = attrs => { const d = devOf(attrs), v = (d && (d.attrs['Supplier Part'] || d.attrs['LCSC Part'] || d.attrs['JLCPCB Part'])) || attrs['Supplier Part'] || ''; return /^C\d+$/.test(v) ? v : ''; };
    const symOf = attrs => P.symbols[attrs.Symbol] || P.symbols[(devOf(attrs) || { attrs: {} }).attrs.Symbol] || null;
    const footOf = attrs => P.footprints[attrs.Footprint] || P.footprints[(devOf(attrs) || { attrs: {} }).attrs.Footprint] || null;
    const valueOf = attrs => { const d = devOf(attrs); return String(attrs.Value || attrs.Name || (d && (d.attrs.Value || d.attrs.Name)) || (d && d.title) || ''); };
    const netName = n => String(n || '').trim().replace(/\s+/g, '_');

    // --- schematic parts (by designator; multi-unit symbols are one part) and positions
    const schParts = new Map();
    D.sheets.forEach((sh, si) => {
      for (const c of sh.comps) {
        const ref = String(c.attrs.Designator || '').trim();
        if (!ref || /\?$/.test(ref)) continue;
        if (!schParts.has(ref)) schParts.set(ref, { ref, sheet: si, x: c.x, y: c.y, attrs: c.attrs, comps: [] });
        schParts.get(ref).comps.push(Object.assign({ sheet: si }, c));
      }
    });

    // --- nets
    let nets = {};   // name -> Set of "REF.PIN"
    const add = (n, k) => { if (!n) return; (nets[n] = nets[n] || new Set()).add(k); };
    if (D.pcb && D.pcb.padNets.length) {
      const refOf = new Map(D.pcb.comps.map(c => [c.id, String(c.attrs.Designator || '').trim()]));
      for (const [cid, pad, net] of D.pcb.padNets) { const ref = refOf.get(cid); if (ref && net) add(netName(net), ref + '.' + pad); }
    } else nets = schematicNets(D.sheets, P, symOf);

    // --- PCB placement: pick the coordinate convention that lands the most pads on their tracks
    let place = null;
    if (D.pcb && D.pcb.comps.length) place = pcbPlacement(D.pcb, footOf, notes);

    // --- library parts + components
    const used = new Set(), defs = new Map(), padsByRef = new Map();
    const refs = place ? place.comps.map(c => String(c.attrs.Designator || '').trim()).filter(Boolean) : [...schParts.keys()];
    let made = 0, skipped = 0;
    for (const ref of refs) {
      if (used.has(ref)) continue;
      const pc = place ? place.comps.find(c => String(c.attrs.Designator || '').trim() === ref) : null, sp = schParts.get(ref);
      const attrs = Object.assign({}, sp ? sp.attrs : {}, pc ? pc.attrs : {});
      const foot = footOf(attrs), sym = symOf(sp ? sp.attrs : attrs);
      let fp = null, r = 0, side = 'F', at = null;
      if (pc && place.local.has(pc.id)) ({ pads: fp, r, side, at } = place.local.get(pc.id));
      else if (foot && foot.pads.length) fp = foot.pads.map(p => Object.assign({ num: p.num, x: n4(p.x * MIL), y: n4(-p.y * MIL), w: n4(Math.max(0.05, p.w * MIL)), h: n4(Math.max(0.05, p.h * MIL)), shape: p.shape }, p.drill ? { drill: n4(p.drill * MIL) } : {}));
      if (!fp || !fp.length) { skipped++; continue; }
      const names = new Map(); if (sym) for (const p of sym.pins) if (p.num && !names.has(p.num)) names.set(p.num, p.name || p.num);
      const sides = new Map(); if (sym) for (const p of sym.pins) { const a = ((p.rot % 360) + 360) % 360; sides.set(p.num, a === 0 ? 'L' : a === 180 ? 'R' : a === 90 ? 'B' : 'T'); }
      const nums = [...new Set(fp.map(p => p.num))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
      const pins = nums.map((num, i) => ({ num, name: names.get(num) || num, side: sides.get(num) || (i < Math.ceil(nums.length / 2) ? 'L' : 'R') }));
      const lcsc = lcscOf(attrs), dev = devOf(attrs) || { attrs: {}, title: '' }, fpName = (foot && foot.name) || 'FOOTPRINT';
      const sig = JSON.stringify([lcsc, fpName, fp.map(p => [p.num, p.x, p.y, p.w, p.h, p.shape, p.drill || 0]), pins.map(p => p.name)]);
      let key = null; for (const [k, s] of defs) if (s === sig) { key = k; break; }
      if (!key) {
        const base = (lcsc || ('EP_' + fpName.replace(/[^\w.-]+/g, '_'))).slice(0, 44);
        key = base; for (let n = 2; defs.has(key) || (S.lib[key] && !defs.has(key)); n++) key = base + '_' + n;
        const xs = fp.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = fp.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
        const def = { name: dev.attrs['Manufacturer Part'] || dev.title || fpName, value: valueOf(attrs) || fpName, prefix: ref.replace(/\d+.*$/, '') || 'U', pins, footprint: { name: fpName, pads: fp, body: [n4(Math.min(...xs)), n4(Math.min(...ys)), n4(Math.max(...xs)), n4(Math.max(...ys))] }, custom: !lcsc, lcsc: lcsc || key, source: 'EasyEDA Pro import' };
        if (lcsc) Object.assign(def, { mfr_part: dev.attrs['Manufacturer Part'] || '', manufacturer: dev.attrs.Manufacturer || '' });
        Model.setLibPart(key, def); defs.set(key, sig); made++;
      }
      const spec = { part: key, ref, value: valueOf(attrs) || undefined };
      if (sp) { spec.x = Math.round(sp.x * 2 / 10) * 10; spec.y = Math.round(-sp.y * 2 / 10) * 10; if (sp.sheet) spec.sheet = sp.sheet; }
      else if (at) { spec.x = Math.round(at[0] * 3) * 10; spec.y = Math.round(at[1] * 3) * 10; }   // PCB only: symbols where the parts sit on the board
      const c = Model.addComponent(spec); used.add(c.ref);
      if (at) { c.pcb = { x: at[0], y: at[1], rot: r }; if (side === 'B') c.pcb.side = 'B'; }
      padsByRef.set(c.ref, new Set(fp.map(p => p.num)));
    }
    if (D.sheets.length > 1) S.sheets = D.sheets.map(s => ({ name: s.name }));

    // --- connect (only pins that exist on the part)
    let netCount = 0;
    for (const [n, keys] of Object.entries(nets)) {
      const ok = [...keys].filter(k => { const i = k.lastIndexOf('.'), s = padsByRef.get(k.slice(0, i)); return s && s.has(k.slice(i + 1)); });
      if (ok.length) { Model.connect(n, ok); netCount++; }
    }

    // --- board + copper
    if (place) {
      S.board.w = place.bw; S.board.h = place.bh;
      if (place.poly) S.board.shape = { type: 'polygon', pts: place.poly, r: 0 }; else delete S.board.shape;
      S.pcb = { traces: place.traces, vias: place.vias, holes: [], pours: place.pours.filter(p => S.nets[p.net]), routed: {} };
    }
    try { if (!place && !D.sheets.length) Model.autoLayout(); else Model.spaceOut(); } catch (e) { }
    if (skipped) notes.push(`${skipped} part${skipped > 1 ? 's' : ''} without a footprint were left out`);
    return { board: B.name, format: P.format, components: used.size, footprints: made, nets: netCount, sheets: D.sheets.length, pad_fit: place ? Math.round(place.fit * 100) + "%" : null, tracks: place ? place.traces.length : 0, vias: place ? place.vias.length : 0, pours: place ? S.pcb.pours.length : 0, board_mm: place ? [+place.bw.toFixed(2), +place.bh.toFixed(2)] : null, notes };
  }

  // Schematic connectivity: pins touch wire ends / wire segments; net names from wire NET labels and power / net ports.
  function schematicNets(sheets, P, symOf) {
    const nets = {}; let auto = 0;
    sheets.forEach(sh => {
      const parent = new Map(), name = new Map(), key = (x, y) => Math.round(x * 2) + ',' + Math.round(y * 2);
      const find = k => { while (parent.get(k) !== k) { parent.set(k, parent.get(parent.get(k))); k = parent.get(k); } return k; };
      const mk = k => { if (!parent.has(k)) parent.set(k, k); return k; };
      const union = (a, b) => { a = find(mk(a)); b = find(mk(b)); if (a !== b) parent.set(a, b); };
      const segs = [];
      for (const w of sh.wires) {
        let first = null;
        for (const s of w.segs) { const a = mk(key(s[0], s[1])), b = mk(key(s[2], s[3])); union(a, b); if (!first) first = a; else union(first, a); segs.push(s.concat([first])); }
        if (w.net && first) name.set(first, netNameOf(w.net));
      }
      const onSeg = (x, y) => { for (const s of segs) { const [x1, y1, x2, y2] = s; if (Math.min(x1, x2) - 0.5 <= x && x <= Math.max(x1, x2) + 0.5 && Math.min(y1, y2) - 0.5 <= y && y <= Math.max(y1, y2) + 0.5 && Math.abs((x2 - x1) * (y - y1) - (y2 - y1) * (x - x1)) <= 0.5 * Math.hypot(x2 - x1, y2 - y1)) return s[4]; } return null; };
      // wire ends touching other wires (T-junctions)
      for (const s of segs) for (const [x, y] of [[s[0], s[1]], [s[2], s[3]]]) { const o = onSeg(x, y); if (o) union(key(x, y), o); }
      const pinKey = new Map();   // point key -> [ref.pin, ...]
      for (const c of sh.comps) {
        const sym = symOf(c.attrs); if (!sym) continue;
        const ref = String(c.attrs.Designator || '').trim(), port = c.attrs['Global Net Name'] || ((sym.type === 18 || sym.type === 19) ? (c.attrs.Name || sym.name) : '');
        for (const p of sym.pins) {
          if (c.part && p.part && p.part !== c.part) continue;   // other unit of a multi-unit symbol
          let [px, py] = [c.mirror ? -p.x : p.x, p.y]; [px, py] = rotS(px, py, c.rot);
          const x = c.x + px, y = c.y + py, k = mk(key(x, y)); const o = onSeg(x, y); if (o) union(k, o);
          if (port) { const r = find(k); if (!name.has(r)) name.set(r, netNameOf(port)); }
          else if (ref && !/\?$/.test(ref)) (pinKey.get(k) || pinKey.set(k, []).get(k)).push(ref + '.' + p.num);
        }
      }
      // gather names per root after all unions
      const rootName = new Map(); for (const [k, n] of name) { const r = find(k); if (!rootName.has(r)) rootName.set(r, n); }
      const groups = new Map(); for (const [k, pins] of pinKey) { const r = find(k); (groups.get(r) || groups.set(r, []).get(r)).push(...pins); }
      for (const [r, pins] of groups) {
        const n = rootName.get(r) || (pins.length > 1 ? 'N$EP' + (++auto) : null); if (!n) continue;
        for (const p of pins) (nets[n] = nets[n] || new Set()).add(p);
      }
    });
    return nets;
  }
  const netNameOf = n => String(n || '').trim().replace(/\s+/g, '_');

  // PCB: choose how the file's angles / bottom-side mirroring work by checking pads against track and via ends.
  function pcbPlacement(pcb, footOf, notes) {
    const byNet = new Map(), addPt = (net, x, y) => { if (!net) return; (byNet.get(net) || byNet.set(net, []).get(net)).push([x, y]); };
    for (const l of pcb.lines) if (l.layer === 1 || l.layer === 2) { addPt(l.net, l.x1, l.y1); addPt(l.net, l.x2, l.y2); }
    for (const v of pcb.vias) addPt(v.net, v.x, v.y);
    const padNet = new Map(pcb.padNets.map(([c, p, n]) => [c + '|' + p, n]));
    const score = (v, bottom) => {
      let hit = 0, tot = 0;
      for (const c of pcb.comps) { if ((c.layer === 2) !== bottom) continue; const f = footOf(c.attrs); if (!f) continue;
        for (const p of f.pads) { const n = padNet.get(c.id + '|' + p.num), pts = n && byNet.get(n); if (!pts) continue; tot++;
          const [x, y] = padWorld(c, p, v), r = Math.max(p.w, p.h) / 2 + 1;
          if (pts.some(q => Math.abs(q[0] - x) <= r && Math.abs(q[1] - y) <= r)) hit++; } }
      return [hit, tot];
    };
    // angle direction from the top-side parts, then the bottom mirror axis
    const sign = score({ sign: 1, mirror: 'y' }, false)[0] >= score({ sign: -1, mirror: 'y' }, false)[0] ? 1 : -1;
    const by = score({ sign, mirror: 'y' }, true), bx = score({ sign, mirror: 'x' }, true);
    const best = { sign, mirror: bx[0] > by[0] ? 'x' : 'y' }, top = score(best, false), bot = best.mirror === 'x' ? bx : by;
    const bs = (top[0] + bot[0]) / Math.max(1, top[1] + bot[1]);
    if (bs < 0.5) notes.push(`only ${Math.round(bs * 100)}% of pads line up with their tracks: check the imported placement`);

    // board frame: outline box (source y up) → CircuitPilot mm, y down, origin top-left
    const allPts = pcb.outline.flatMap(pathPts);
    let x0, y1, x1, y0;
    if (allPts.length) { x0 = Math.min(...allPts.map(p => p[0])); x1 = Math.max(...allPts.map(p => p[0])); y0 = Math.min(...allPts.map(p => p[1])); y1 = Math.max(...allPts.map(p => p[1])); }
    else { const ps = pcb.comps.map(c => [c.x, c.y]); x0 = Math.min(...ps.map(p => p[0])) - 120; x1 = Math.max(...ps.map(p => p[0])) + 120; y0 = Math.min(...ps.map(p => p[1])) - 120; y1 = Math.max(...ps.map(p => p[1])) + 120; notes.push('no board outline: the board is sized to the parts'); }
    const T = (x, y) => [n4((x - x0) * MIL), n4((y1 - y) * MIL)];
    const bw = n4((x1 - x0) * MIL), bh = n4((y1 - y0) * MIL);
    let poly = null;
    if (pcb.outline.length) { const pts = pathPts(pcb.outline.slice().sort((a, b) => pathPts(b).length - pathPts(a).length)[0]).map(p => T(p[0], p[1])); const rect = pts.length === 4 && pts.every(q => (Math.abs(q[0]) < 0.01 || Math.abs(q[0] - bw) < 0.01) && (Math.abs(q[1]) < 0.01 || Math.abs(q[1] - bh) < 0.01)); if (!rect && pts.length >= 3) poly = pts; }

    // per component: pads in board mm, then a CircuitPilot footprint + rotation that reproduces them
    const local = new Map(); let skewed = 0;
    for (const c of pcb.comps) {
      const f = footOf(c.attrs); if (!f || !f.pads.length) continue;
      const side = c.layer === 2 ? 'B' : 'F', at = T(c.x, c.y);
      const world = f.pads.map(p => { const [x, y] = padWorld(c, p, best), a = (((((c.layer === 2 ? -p.rot : p.rot) + c.angle * best.sign) % 360) + 360) % 360), q = T(x, y); return { p, x: q[0], y: q[1], a }; });
      // the footprint as drawn (mm, y down); CircuitPilot pads are unrotated, so a pad turned 90° swaps w / h
      const size = (p, a) => { let w = p.w * MIL, h = p.h * MIL; const aa = ((a % 180) + 180) % 180; if (Math.abs(aa - 90) < 1) [w, h] = [h, w]; else if (aa > 1 && aa < 179) { const t = aa * Math.PI / 180, cc = Math.abs(Math.cos(t)), s = Math.abs(Math.sin(t)); [w, h] = [w * cc + h * s, w * s + h * cc]; } return [w, h]; };
      const mkPad = (p, x, y, a) => { const [w, h] = size(p, a); return Object.assign({ num: p.num, x: n4(x), y: n4(y), w: n4(Math.max(0.05, w)), h: n4(Math.max(0.05, h)), shape: p.shape }, p.drill ? { drill: n4(p.drill * MIL) } : {}); };
      const canon = f.pads.map(p => mkPad(p, p.x * MIL, -p.y * MIL, p.rot));
      // the 90° step that puts the drawn footprint's pads where the board has them (CircuitPilot: at + rot(mirror(pad), r))
      const cpr = ((Math.round(-c.angle * best.sign / 90) * 90) % 360 + 360) % 360;
      let r = [cpr, 0, 90, 180, 270].find(r => canon.every((q, i) => { const [x, y] = Lib.rot(side === 'B' ? -q.x : q.x, q.y, r); return Math.abs(at[0] + x - world[i].x) < 0.02 && Math.abs(at[1] + y - world[i].y) < 0.02; }));
      let fp = canon;
      if (r == null) {   // odd angle (e.g. 45°): keep every pad exactly where it is, unrotated part
        skewed++; r = 0;
        fp = world.map(({ p, x, y, a }) => mkPad(p, side === 'B' ? -(x - at[0]) : x - at[0], y - at[1], a));
      }
      local.set(c.id, { pads: fp, r, side, at });
    }
    if (skewed) notes.push(`${skewed} part${skewed > 1 ? 's are' : ' is'} rotated at a non-90° angle: pads are kept in place, the part outline is axis-aligned`);

    const lay = l => l === 1 ? 'F' : l === 2 ? 'B' : null; let inner = 0;
    const traces = [];
    for (const l of pcb.lines) { const L = lay(l.layer); if (!L) { if (l.layer >= 15 && l.layer <= 44) inner++; continue; } traces.push({ net: netNameOf(l.net), layer: L, w: n4(Math.max(0.05, l.w * MIL)), pts: [T(l.x1, l.y1), T(l.x2, l.y2)] }); }
    for (const a of pcb.arcs) { const L = lay(a.layer); if (!L) { if (a.layer >= 15) inner++; continue; } traces.push({ net: netNameOf(a.net), layer: L, w: n4(Math.max(0.05, a.w * MIL)), pts: [[a.x1, a.y1], ...arcPts(a.x1, a.y1, a.x2, a.y2, a.angle)].map(q => T(q[0], q[1])) }); }
    if (inner) notes.push(`${inner} track segments on inner layers were skipped (CircuitPilot boards are 2-layer)`);
    const vias = pcb.vias.map(v => { const q = T(v.x, v.y); return { net: netNameOf(v.net), x: q[0], y: q[1], d: n4(Math.max(0.3, v.d * MIL)), drill: n4(Math.max(0.15, v.drill * MIL)) }; });
    const pours = [];
    for (const p of pcb.pours) { const L = lay(p.layer); if (!L) continue; const paths = Array.isArray(p.paths[0]) || (p.paths[0] && typeof p.paths[0] === 'object') ? p.paths : [p.paths]; const pts = pathPts(paths[0]).map(q => T(q[0], q[1])); if (pts.length >= 3) pours.push({ net: netNameOf(p.net) || 'GND', layer: L, pts }); }
    return { comps: pcb.comps, local, bw, bh, poly, traces, vias, pours, fit: bs };
  }

  const isPro = name => /\.(epro2?|zip)$/i.test(name || '');
  return { read, importBoard, isPro, _internal: { unzip, v2Docs, pathPts, arcPts } };
})();
if (typeof module !== 'undefined') module.exports = EasyEDAPro;
