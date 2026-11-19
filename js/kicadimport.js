'use strict';
// Import a KiCad project (KiCad 6–9: a .kicad_pcb and its .kicad_sch sheets) as a new CircuitPilot project: every part with
// its real footprint (pads, holes) and pin names, the nets of the board, the board outline, tracks, vias, copper zones and
// keep-out zones on up to 4 copper layers, mounting holes, silkscreen texts, and the schematic sheets with the parts
// where KiCad has them. Coordinates: KiCad mm (y down) shifted so the board outline starts at 0, 0.
const KiCadImport = (() => {
  const n4 = v => +(+v).toFixed(4);
  // ---------- S-expressions (iterative: board files are megabytes) ----------
  function parse(text) {
    const root = [], stack = [root], n = text.length; let i = 0;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 40) { const l = []; stack[stack.length - 1].push(l); stack.push(l); i++; }
      else if (c === 41) { if (stack.length > 1) stack.pop(); i++; }
      else if (c <= 32) i++;
      else if (c === 34) {
        let j = i + 1, s = '';
        while (j < n) {
          const d = text.charCodeAt(j);
          if (d === 34) break;
          if (d === 92) { const e = text[j + 1]; s += e === 'n' ? '\n' : e; j += 2; continue; }
          const k = j; while (j < n) { const e = text.charCodeAt(j); if (e === 34 || e === 92) break; j++; } s += text.slice(k, j);
        }
        stack[stack.length - 1].push(s); i = j + 1;
      } else {
        let j = i; while (j < n) { const d = text.charCodeAt(j); if (d <= 32 || d === 40 || d === 41) break; j++; }
        stack[stack.length - 1].push(text.slice(i, j)); i = j;
      }
    }
    return root[0];
  }
  const all = (node, tag) => Array.isArray(node) ? node.filter(x => Array.isArray(x) && x[0] === tag) : [];
  const one = (node, tag) => all(node, tag)[0] || null;
  const xy = node => node ? [+node[1], +node[2]] : null;
  const prop = (node, name) => { for (const p of all(node, 'property')) if (p[1] === name) return p[2]; return null; };
  const CU = { 'F.Cu': 'F', 'B.Cu': 'B', 'In1.Cu': 'In1', 'In2.Cu': 'In2' };
  // KiCad turns counter-clockwise on screen (y down): (x, y) by a degrees
  const krot = (x, y, a) => { const t = a * Math.PI / 180, c = Math.cos(t), s = Math.sin(t); return [x * c + y * s, -x * s + y * c]; };
  // points of an arc through start, mid, end
  function arc3(s, m, e, step = 15) {
    const ax = s[0], ay = s[1], bx = m[0], by = m[1], cx = e[0], cy = e[1], d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by));
    if (Math.abs(d) < 1e-9) return [s, e];
    const ux = ((ax * ax + ay * ay) * (by - cy) + (bx * bx + by * by) * (cy - ay) + (cx * cx + cy * cy) * (ay - by)) / d;
    const uy = ((ax * ax + ay * ay) * (cx - bx) + (bx * bx + by * by) * (ax - cx) + (cx * cx + cy * cy) * (bx - ax)) / d, r = Math.hypot(ax - ux, ay - uy);
    const a0 = Math.atan2(ay - uy, ax - ux), am = Math.atan2(by - uy, bx - ux), a1 = Math.atan2(cy - uy, cx - ux);
    const norm = v => ((v % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
    let sweep = norm(a1 - a0); if (norm(am - a0) > sweep) sweep -= 2 * Math.PI;   // go through the mid point
    const k = Math.max(2, Math.ceil(Math.abs(sweep) * 180 / Math.PI / step)), out = [];
    for (let i = 0; i <= k; i++) { const a = a0 + sweep * i / k; out.push([ux + r * Math.cos(a), uy + r * Math.sin(a)]); }
    return out;
  }
  // net names: the last part of a hierarchical name ("/sheet/3V3" -> "3V3"), KiCad's own names for unnamed nets kept readable
  function netNamer() {
    const used = new Map();
    return full => {
      full = String(full || '').trim(); if (!full) return '';
      if (used.has(full)) return used.get(full);
      let n = full.split('/').filter(Boolean).pop() || full;
      n = n.replace(/^Net-\((.*)\)$/, 'N_$1').replace(/[^\w+\-.]+/g, '_').replace(/^_+|_+$/g, '') || 'NET';
      const taken = new Set(used.values()); if (taken.has(n)) { let k = 2; while (taken.has(n + '_' + k)) k++; n = n + '_' + k; }
      used.set(full, n); return n;
    };
  }

  // ---------- the board ----------
  function readPcb(text, notes) {
    const T = parse(text); if (!T || T[0] !== 'kicad_pcb') throw new Error('this is not a KiCad board file (.kicad_pcb)');
    const netById = {}; for (const n of all(T, 'net')) netById[n[1]] = n[2];
    const netOf = node => { const n = one(node, 'net'); if (!n) return ''; if (n.length > 2) return n[2]; return netById[n[1]] != null ? netById[n[1]] : (isNaN(+n[1]) ? n[1] : ''); };
    const cuLayers = (one(T, 'layers') || []).filter(l => Array.isArray(l) && /\.Cu$/.test(l[1])).map(l => l[1]);
    if (cuLayers.length > 4) notes.push(`the board has ${cuLayers.length} copper layers: only top, bottom, In1 and In2 are imported`);
    const B = { layers: cuLayers.length >= 4 ? 4 : cuLayers.length <= 1 ? 1 : 2, comps: [], tracks: [], vias: [], zones: [], keepouts: [], holes: [], texts: [], edges: [], thickness: +((one(one(T, 'general'), 'thickness') || [])[1]) || 1.6 };
    // board outline pieces (Edge.Cuts), board level and inside footprints
    const edge = (g, tf) => {
      const L = one(g, 'layer'); if (!L || L[1] !== 'Edge.Cuts') return;
      const P = q => tf ? tf(q) : q, t = g[0].replace(/^(gr|fp)_/, '');
      if (t === 'line') B.edges.push([P(xy(one(g, 'start'))), P(xy(one(g, 'end')))]);
      else if (t === 'arc') { const pts = arc3(xy(one(g, 'start')), xy(one(g, 'mid')), xy(one(g, 'end'))).map(P); for (let i = 1; i < pts.length; i++) B.edges.push([pts[i - 1], pts[i]]); }
      else if (t === 'rect') { const a = xy(one(g, 'start')), b = xy(one(g, 'end')), q = [[a[0], a[1]], [b[0], a[1]], [b[0], b[1]], [a[0], b[1]]].map(P); for (let i = 0; i < 4; i++) B.edges.push([q[i], q[(i + 1) % 4]]); }
      else if (t === 'circle') { const c = xy(one(g, 'center')), e = xy(one(g, 'end')), r = Math.hypot(e[0] - c[0], e[1] - c[1]), k = 36, q = []; for (let i = 0; i < k; i++) q.push(P([c[0] + r * Math.cos(i * 2 * Math.PI / k), c[1] + r * Math.sin(i * 2 * Math.PI / k)])); for (let i = 0; i < k; i++) B.edges.push([q[i], q[(i + 1) % k]]); B.circles = (B.circles || []).concat([{ c: P(c), d: 2 * r, q }]); }
      else if (t === 'poly') { const q = all(one(g, 'pts'), 'xy').map(xy).map(P); for (let i = 0; i < q.length; i++) B.edges.push([q[i], q[(i + 1) % q.length]]); }
    };
    for (const g of T) if (Array.isArray(g) && /^gr_/.test(g[0])) edge(g, null);
    // silkscreen texts
    for (const g of all(T, 'gr_text')) { const L = one(g, 'layer'); if (!L || !/SilkS$/.test(L[1])) continue; const at = one(g, 'at'), f = one(one(one(g, 'effects'), 'font'), 'size'); if (at && g[1]) B.texts.push({ text: String(g[1]), x: +at[1], y: +at[2], rot: +at[3] || 0, h: f ? +f[2] || 1 : 1, side: L[1].startsWith('B') ? 'B' : 'F' }); }
    // footprints
    for (const fp of all(T, 'footprint')) {
      const at = one(fp, 'at'), fx = +at[1], fy = +at[2], fa = +at[3] || 0, bottom = ((one(fp, 'layer') || [])[1]) === 'B.Cu';
      const fpText = kind => { const t = all(fp, 'fp_text').find(x => x[1] === kind); return t ? t[2] : null; };
      const ref = String(prop(fp, 'Reference') || fpText('reference') || '').trim(), value = String(prop(fp, 'Value') || fpText('value') || '').trim();
      const tf = q => { const r = krot(q[0], q[1], fa); return [fx + r[0], fy + r[1]]; };
      for (const g of fp) if (Array.isArray(g) && /^fp_/.test(g[0])) edge(g, tf);
      const pads = [];
      for (const p of all(fp, 'pad')) {
        const type = p[2], shape = p[3], pat = one(p, 'at'), sz = one(p, 'size'), dr = one(p, 'drill');
        let lx = +pat[1], ly = +pat[2], w = +sz[1], h = +sz[2] || +sz[1], shp = shape;
        const pa = +pat[3] || 0, rel0 = (((pa - fa) % 360) + 360) % 360;
        // rounded rectangles: round ends (ratio ≥ 0.4) become ovals / circles, the rest rectangles
        if (shape === 'roundrect') { const rr = +((one(p, 'roundrect_rratio') || [])[1]) || 0; shp = rr >= 0.4 ? (Math.abs(w - h) < 1e-6 ? 'circle' : 'oval') : 'rect'; }
        // custom pads: the box round the anchor and its drawn shapes (pad frame), the pad moved to the box centre
        if (shape === 'custom') {
          const xs = [-w / 2, w / 2], ys = [-h / 2, h / 2], addP = (q, r = 0) => { xs.push(q[0] - r, q[0] + r); ys.push(q[1] - r, q[1] + r); };
          for (const g of one(p, 'primitives') || []) {
            if (!Array.isArray(g)) continue; const wd = +((one(g, 'width') || [])[1]) / 2 || 0;
            if (g[0] === 'gr_poly') for (const q of all(one(g, 'pts'), 'xy')) addP(xy(q), wd);
            else if (g[0] === 'gr_rect' || g[0] === 'gr_line') { addP(xy(one(g, 'start')), wd); addP(xy(one(g, 'end')), wd); }
            else if (g[0] === 'gr_circle') { const c = xy(one(g, 'center')), e = xy(one(g, 'end')); addP(c, Math.hypot(e[0] - c[0], e[1] - c[1]) + wd); }
            else if (g[0] === 'gr_arc') for (const k of ['start', 'mid', 'end']) addP(xy(one(g, k)), wd);
          }
          const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys), o = krot((x0 + x1) / 2, (y0 + y1) / 2, rel0);
          lx += o[0]; ly += o[1]; w = x1 - x0; h = y1 - y0; shp = 'rect'; notes.custom = (notes.custom || 0) + 1;
        }
        let drill = 0; if (dr) { const v = dr.slice(1).filter(x => !Array.isArray(x)); drill = v[0] === 'oval' ? Math.min(+v[1], +v[2] || +v[1]) : +v[0] || 0; if (v[0] === 'oval') notes.slot = (notes.slot || 0) + 1; }
        const layers = (one(p, 'layers') || []).slice(1);
        const abs = tf([lx, ly]);
        if (type === 'np_thru_hole') { if (drill > 0) B.holes.push({ x: abs[0], y: abs[1], d: drill }); continue; }
        // an SMD pad on the other side of the board than its part (KiCad stores a bottom part's layers already flipped)
        const hasF = layers.some(l => l === 'F.Cu' || l === '*.Cu'), hasB = layers.some(l => l === 'B.Cu' || l === '*.Cu');
        pads.push({ num: String(p[1] == null ? '' : p[1]), type, shape: shp, lx, ly, rel: rel0, w, h, drill: type === 'thru_hole' ? drill : 0, abs, net: netOf(p), back: type !== 'thru_hole' && (bottom ? hasF && !hasB : hasB && !hasF) });
      }
      B.comps.push({ ref, value, fpName: String(fp[1] || '').split(':').pop() || 'FOOTPRINT', libId: String(fp[1] || ''), fx, fy, fa, bottom, pads, lcsc: prop(fp, 'LCSC') || prop(fp, 'LCSC Part') || prop(fp, 'JLCPCB Part #') || '' });
    }
    // copper
    for (const s of all(T, 'segment')) { const L = CU[(one(s, 'layer') || [])[1]]; if (!L) continue; B.tracks.push({ net: netOf(s), layer: L, w: +one(s, 'width')[1], pts: [xy(one(s, 'start')), xy(one(s, 'end'))] }); }
    for (const s of all(T, 'arc')) { const L = CU[(one(s, 'layer') || [])[1]]; if (!L) continue; B.tracks.push({ net: netOf(s), layer: L, w: +one(s, 'width')[1], pts: arc3(xy(one(s, 'start')), xy(one(s, 'mid')), xy(one(s, 'end')), 10) }); }
    for (const v of all(T, 'via')) B.vias.push({ net: netOf(v), x: +one(v, 'at')[1], y: +one(v, 'at')[2], d: +one(v, 'size')[1], drill: +one(v, 'drill')[1] });
    for (const z of all(T, 'zone')) {
      const pts = all(one(one(z, 'polygon'), 'pts'), 'xy').map(xy); if (pts.length < 3) continue;
      const ls = (one(z, 'layers') || one(z, 'layer') || []).slice(1).map(l => l === '*.Cu' ? Object.keys(CU) : [l]).flat().map(l => CU[l]).filter(Boolean);
      const keep = one(z, 'keepout'), name = (one(z, 'net_name') || [])[1] || netOf(z), prio = +((one(z, 'priority') || [])[1]) || 0, zcl = +((one(one(z, 'connect_pads'), 'clearance') || [])[1]) || 0;
      if (keep) { const has = k => ((one(keep, k) || [])[1]) === 'not_allowed'; B.keepouts.push({ pts, layers: ls, tracks: has('tracks'), vias: has('vias'), pours: has('copperpour') }); }
      else if (name && ls.length) for (const L of ls) B.zones.push({ net: name, layer: L, pts, priority: prio, clearance: zcl });
    }
    return B;
  }
  // the board outline: Edge.Cuts pieces chained into loops; the biggest is the board, round ones inside become holes
  function outline(edges, notes) {
    const key = p => Math.round(p[0] * 100) + ',' + Math.round(p[1] * 100), segs = edges.filter(e => e[0] && e[1] && Math.hypot(e[1][0] - e[0][0], e[1][1] - e[0][1]) > 1e-6);
    const at = new Map(); segs.forEach((s, i) => { for (const p of s) { const k = key(p); if (!at.has(k)) at.set(k, []); at.get(k).push(i); } });
    const used = new Set(), loops = [];
    for (let i = 0; i < segs.length; i++) {
      if (used.has(i)) continue; used.add(i);
      const loop = [segs[i][0], segs[i][1]]; let cur = segs[i][1];
      for (let g = 0; g < segs.length; g++) {
        if (key(cur) === key(loop[0])) break;
        const j = (at.get(key(cur)) || []).find(x => !used.has(x)); if (j == null) break;
        used.add(j); const s = segs[j], nx = key(s[0]) === key(cur) ? s[1] : s[0]; loop.push(nx); cur = nx;
      }
      if (key(loop[loop.length - 1]) === key(loop[0])) loop.pop();
      if (loop.length >= 3) loops.push(loop);
    }
    const area = l => Math.abs(l.reduce((a, p, i) => { const q = l[(i + 1) % l.length]; return a + p[0] * q[1] - q[0] * p[1]; }, 0) / 2);
    loops.sort((a, b) => area(b) - area(a));
    if (loops.length > 1) notes.push(`${loops.length - 1} cut-out${loops.length > 2 ? 's' : ''} inside the board outline ${loops.length > 2 ? 'are' : 'is'} not imported (round ones become mounting holes)`);
    return loops;
  }

  // ---------- the schematic ----------
  function readSchematic(files, rootName) {
    const docs = {}; for (const [name, text] of Object.entries(files)) if (/\.kicad_sch$/i.test(name)) { try { docs[name.split('/').pop()] = parse(text); } catch (e) { } }
    const names = Object.keys(docs); if (!names.length) return null;
    const root = names.find(n => n.replace(/\.kicad_sch$/i, '') === rootName) || names.find(n => all(docs[n], 'sheet').length) || names[0];
    const sheets = [], seen = new Set();
    const walk = (file, title) => {
      if (seen.has(file) || !docs[file]) return; seen.add(file);
      const D = docs[file], lib = {};
      for (const s of all(one(D, 'lib_symbols'), 'symbol')) {   // pins of every unit of the library symbol
        const pins = {}, grab = node => { for (const p of all(node, 'pin')) { const num = (one(p, 'number') || [])[1], name = (one(p, 'name') || [])[1], a = +((one(p, 'at') || [])[3]) || 0; if (num != null && !(num in pins)) pins[num] = { name: name && name !== '~' ? name : String(num), side: a === 0 ? 'L' : a === 180 ? 'R' : a === 90 ? 'B' : 'T' }; } for (const u of all(node, 'symbol')) grab(u); };
        grab(s); lib[s[1]] = { pins, power: !!one(s, 'power') };
      }
      const parts = [];
      for (const s of all(D, 'symbol')) {
        const libId = (one(s, 'lib_id') || [])[1] || '', L = lib[libId] || { pins: {} }; let ref = String(prop(s, 'Reference') || '').trim();
        if (/\?$/.test(ref)) { const inst = one(s, 'instances'); const r = inst && JSON.stringify(inst).match(/"reference","([^"]+)"/); if (r) ref = r[1]; }
        if (!ref || ref.startsWith('#') || L.power) continue;
        const at = one(s, 'at');
        parts.push({ ref, libId, value: prop(s, 'Value') || '', footprint: prop(s, 'Footprint') || '', lcsc: prop(s, 'LCSC') || prop(s, 'LCSC Part') || prop(s, 'JLCPCB Part #') || '', x: +at[1], y: +at[2], pins: L.pins });
      }
      if (parts.length) sheets.push({ name: title, parts });
      for (const sh of all(D, 'sheet')) { const f = String(prop(sh, 'Sheetfile') || prop(sh, 'Sheet file') || '').split('/').pop(); walk(f, prop(sh, 'Sheetname') || prop(sh, 'Sheet name') || f.replace(/\.kicad_sch$/i, '')); }
    };
    walk(root, (prop(docs[root], 'title') || root.replace(/\.kicad_sch$/i, '')));
    for (const n of names) walk(n, n.replace(/\.kicad_sch$/i, ''));   // sheets not reached from the root
    return sheets;
  }

  // ---------- build the CircuitPilot project (call inside Model.mutate, on a blank project) ----------
  function importProject(files) {
    const S = Model.S, notes = [], names = Object.keys(files);
    const pcbName = names.find(n => /\.kicad_pcb$/i.test(n));
    if (!pcbName) throw new Error('no .kicad_pcb in the project — CircuitPilot imports a KiCad project with its board (the nets come from the board)');
    const base = pcbName.split('/').pop().replace(/\.kicad_pcb$/i, '');
    const B = readPcb(files[pcbName], notes), sheets = readSchematic(files, base) || [];
    const loops = outline(B.edges, notes); if (!loops.length) throw new Error('the board has no closed outline on Edge.Cuts');
    const out = loops[0], ox = Math.min(...out.map(p => p[0])), oy = Math.min(...out.map(p => p[1]));
    const sh = p => [n4(p[0] - ox), n4(p[1] - oy)];
    // round cut-outs inside the board: mounting holes
    for (const l of loops.slice(1)) { const c = (B.circles || []).find(q => q.q.length === l.length && Math.hypot(q.q[0][0] - l[0][0], q.q[0][1] - l[0][1]) < 0.05); if (c) B.holes.push({ x: c.c[0], y: c.c[1], d: c.d }); }
    // schematic parts without a footprint on the board are left out; sheets left empty by that are dropped
    const onBoard = new Set(B.comps.filter(c => c.ref && c.pads.length).map(c => c.ref)), allRefs = new Set(sheets.flatMap(s0 => s0.parts.map(p => p.ref)));
    for (let i = sheets.length - 1; i >= 0; i--) if (!sheets[i].parts.some(p => onBoard.has(p.ref))) sheets.splice(i, 1);
    const nn = netNamer(), sch = new Map(); sheets.forEach((s, si) => { for (const p of s.parts) if (!sch.has(p.ref)) sch.set(p.ref, Object.assign({ sheet: si }, p)); });
    // rules: the board's copper layer count; JLCPCB's tightest no-extra-cost preset as the baseline the DRC checks against
    const vip = B.comps.some(c => c.pads.some(p => !p.drill && B.vias.some(v => Math.abs(v.x - p.abs[0]) < Math.min(p.w, p.h) / 2 && Math.abs(v.y - p.abs[1]) < Math.min(p.w, p.h) / 2)));
    S.rules = Object.assign({}, S.rules || {}, { preset: B.layers === 4 ? 'jlcpcb_4layer_tight' : 'jlcpcb_tight', layers: B.layers }, B.layers === 4 ? { planes: { In1: null, In2: null } } : {}, vip ? { noViaInPad: false, viaInPad: true } : {}, B.zones.length ? { pourMinArea: 0.01 } : {}, { epKeepout: false });
    if (vip) notes.push('the board has vias in SMD pads: via-in-pad is allowed in the rules (JLCPCB fills them: extra cost)');
    // parts
    const defs = new Map(); let made = 0, odd = 0, back = 0, placedN = 0;
    const comps = B.comps.filter(c => c.ref && !c.ref.startsWith('#'));
    for (const fc of comps) {
      if (!fc.pads.length) { notes.noPads = (notes.noPads || 0) + 1; continue; }
      const sp = sch.get(fc.ref);
      if (fc.pads.some(p => p.back)) back++;
      // pads in the part's own frame (top side, unrotated) when it sits at a multiple of 90°, else as placed (rotation 0)
      const square = Math.abs(fc.fa / 90 - Math.round(fc.fa / 90)) < 1e-6;
      const padDef = (p, i) => {
        const rel = square ? p.rel : (((p.rel + fc.fa) % 360) + 360) % 360, swap = Math.round(rel / 90) % 2 === 1;
        if (Math.abs(rel / 90 - Math.round(rel / 90)) > 1e-6) odd++;
        let x, y; if (square) { x = p.lx; y = p.ly; } else { x = p.abs[0] - fc.fx; y = p.abs[1] - fc.fy; }
        if (fc.bottom) x = -x;
        return Object.assign({ num: p.num || 'MP' + (i + 1), x: n4(x), y: n4(y), w: n4(Math.max(0.05, swap ? p.h : p.w)), h: n4(Math.max(0.05, swap ? p.w : p.h)), shape: p.shape === 'circle' ? 'round' : p.shape === 'oval' ? 'oval' : 'rect' }, p.drill ? { drill: n4(p.drill) } : {}, p.back ? { back: true } : {});
      };
      const fp = fc.pads.map(padDef), nums = [...new Set(fp.map(p => p.num))].sort((a, b) => String(a).localeCompare(String(b), undefined, { numeric: true }));
      const pins = nums.map((num, i) => { const sp2 = sp && sp.pins && sp.pins[num]; return { num, name: sp2 ? sp2.name : num, side: sp2 ? sp2.side : (i < Math.ceil(nums.length / 2) ? 'L' : 'R') }; });
      const lcsc = /^C\d+$/.test(fc.lcsc || (sp && sp.lcsc) || '') ? (fc.lcsc || sp.lcsc) : '';
      const sig = JSON.stringify([lcsc, fc.fpName, fp, pins.map(p => p.name)]);
      let key = null; for (const [k, s] of defs) if (s === sig) { key = k; break; }
      if (!key) {
        const kb = ('KC_' + fc.fpName.replace(/[^\w.-]+/g, '_')).slice(0, 44); key = kb;
        for (let n = 2; defs.has(key) || S.lib[key]; n++) key = kb + '_' + n;
        const xs = fp.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = fp.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
        Model.setLibPart(key, { name: (sp && sp.value) || fc.value || fc.fpName, value: fc.value || fc.fpName, prefix: fc.ref.replace(/\d+.*$/, '') || 'U', pins, footprint: { name: fc.fpName, pads: fp, body: [n4(Math.min(...xs)), n4(Math.min(...ys)), n4(Math.max(...xs)), n4(Math.max(...ys))] }, custom: !lcsc, lcsc: lcsc || key, source: 'KiCad import (' + fc.libId + ')' });
        defs.set(key, sig); made++;
      }
      const spec = { part: key, ref: fc.ref, value: fc.value || undefined };
      if (sp) { spec.x = Math.round(sp.x * 7.874 / 10) * 10; spec.y = Math.round(sp.y * 7.874 / 10) * 10; if (sp.sheet) spec.sheet = sp.sheet; }
      else { spec.x = Math.round((fc.fx - ox) * 30 / 10) * 10; spec.y = Math.round((fc.fy - oy) * 30 / 10) * 10; }
      const c = Model.addComponent(spec);
      // place it: CircuitPilot turns clockwise on the board, KiCad counter-clockwise; checked against KiCad's own pad spots
      const target = fc.pads.map(p => [p.abs[0] - ox, p.abs[1] - oy]);
      const fits = rot => { c.pcb = { x: n4(fc.fx - ox), y: n4(fc.fy - oy), rot }; if (fc.bottom) c.pcb.side = 'B'; const got = Pcb.padsOf(c, null); return got.length === target.length && got.every((q, i) => Math.hypot(q.x - target[i][0], q.y - target[i][1]) < 0.02); };
      if (!square || !(fits((360 - Math.round(fc.fa)) % 360) || fits(Math.round(fc.fa) % 360) || fits(0))) fits(square ? (360 - Math.round(fc.fa)) % 360 : 0);
      if (!square || fits(c.pcb.rot)) placedN++;
      c.pcb.locked = true;
    }
    if (sheets.length) S.sheets = sheets.map(s => ({ name: s.name }));
    // nets: every pad's net from the board (only pads that exist on the part)
    const byNet = {};
    for (const fc of comps) { const c = Model.comp(fc.ref); if (!c) continue; fc.pads.forEach((p, i) => { const n = nn(p.net); if (n) (byNet[n] = byNet[n] || []).push(fc.ref + '.' + (p.num || 'MP' + (i + 1))); }); }
    let netCount = 0; for (const [n, keys] of Object.entries(byNet)) { Model.connect(n, [...new Set(keys)]); netCount++; }
    // board and copper
    const pts = out.map(sh), w = n4(Math.max(...pts.map(p => p[0]))), h = n4(Math.max(...pts.map(p => p[1])));
    S.board = Object.assign({}, S.board, { w, h, shape: { type: 'polygon', pts, r: 0 } });
    const known = n => !n || S.nets[n];
    S.pcb = {
      traces: B.tracks.map(t => ({ net: nn(t.net) || null, layer: t.layer, w: n4(t.w), pts: t.pts.map(sh), manual: true, locked: true })).filter(t => known(t.net)),
      vias: B.vias.map(v => ({ net: nn(v.net) || null, x: n4(v.x - ox), y: n4(v.y - oy), d: n4(v.d), drill: n4(v.drill), manual: true, locked: true })).filter(v => known(v.net)),
      holes: B.holes.map(q => ({ x: n4(q.x - ox), y: n4(q.y - oy), d: n4(q.d) })),
      pours: B.zones.map(z => Object.assign({ net: nn(z.net), layer: z.layer, pts: z.pts.map(sh) }, z.priority ? { priority: z.priority } : {}, z.clearance >= 0.05 ? { clearance: n4(z.clearance) } : {})).filter(p => S.nets[p.net]),
      keepouts: B.keepouts.map(k => ({ pts: k.pts.map(sh), layer: k.layers.includes('F') && k.layers.includes('B') ? 'both' : k.layers.includes('B') ? 'B' : 'F', tracks: k.tracks, vias: k.vias, pours: k.pours })),
      texts: B.texts.map(t => ({ text: t.text, x: n4(t.x - ox), y: n4(t.y - oy), h: t.h, rot: t.rot, side: t.side })),
      routed: {},
    };
    try { Model.spaceOut(); } catch (e) { }
    if (back) notes.push(`${back} part${back > 1 ? 's have' : ' has'} SMD pads on the other side of the board (kept there)`);
    if (odd) notes.push(`${odd} pads sit at an angle that is not a multiple of 90° — imported square to the board`);
    if (notes.custom) notes.push(`${notes.custom} custom-shaped pads are imported as the rectangle round them`);
    if (notes.slot) notes.push(`${notes.slot} slotted holes are imported as round holes (the slot width)`);
    if (notes.noPads) notes.push(`${notes.noPads} footprints without pads (logos, fiducials …) are not imported`);
    const missing = [...allRefs].filter(r => !Model.comp(r));
    if (missing.length) notes.push(`${missing.length} schematic part${missing.length > 1 ? 's are' : ' is'} not on the board (no footprint): ${missing.slice(0, 8).join(', ')}${missing.length > 8 ? ' …' : ''}`);
    return { name: base, components: comps.filter(c => Model.comp(c.ref)).length, placed_exactly: placedN, footprints: made, nets: netCount, sheets: Math.max(1, sheets.length), layers: B.layers, board_mm: [w, h], tracks: S.pcb.traces.length, vias: S.pcb.vias.length, pours: S.pcb.pours.length, keepouts: S.pcb.keepouts.length, holes: S.pcb.holes.length, notes: notes.filter(x => typeof x === 'string') };
  }
  // the files of a KiCad project from a zip (browser): { name: text } for .kicad_pcb / .kicad_sch / .kicad_pro
  async function filesFromZip(buf) {
    const z = await EasyEDAPro._internal.unzip(buf), out = {};
    for (const n of z.names) if (/\.(kicad_pcb|kicad_sch|kicad_pro)$/i.test(n)) out[n] = await z.text(n);
    return out;
  }
  const isKiCad = (name, names) => /\.kicad_(pcb|pro|sch)$/i.test(name) || (names || []).some(n => /\.kicad_pcb$/i.test(n));
  return { importProject, filesFromZip, isKiCad, _internal: { parse, outline, readPcb, readSchematic } };
})();
if (typeof module !== 'undefined') module.exports = KiCadImport;
