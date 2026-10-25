'use strict';
// Interchange with EasyEDA (Standard edition "EasyEDA Source" JSON, also importable into EasyEDA Pro):
//  - exportSchematic(): the current schematic as an EasyEDA schematic document (docType 1; several sheets: docType 5, one page per sheet)
//  - exportPcb():       the current PCB as an EasyEDA PCB document (docType 3): footprints with their pads, tracks, vias,
//                       holes, copper pours and the board outline (EasyEDA Pro: File → Import → EasyEDA (Standard))
//  - importPcb(json):   an EasyEDA PCB document (docType 3) → parts, footprints, placement, nets, tracks, vias, pours, outline
// Format reference: EasyEDA "Document Format" documentation. 1 EasyEDA unit = 10 mil = 0.254 mm, Y points down.
const EasyEDA = (() => {
  const U = 0.254;
  const n4 = v => +(+v).toFixed(4), n2 = v => +(+v).toFixed(2);

  // ---------- SVG geometry → polylines (used for symbol graphics and PCB arcs / areas) ----------
  function pathToPolys(d, steps = 8) {
    const toks = String(d).match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) || [];
    const out = []; let cur = null, x = 0, y = 0, sx = 0, sy = 0, cmd = '', i = 0;
    const num = () => +toks[i++];
    const add = (px, py) => { if (!cur) { cur = [[x, y]]; out.push(cur); } cur.push([px, py]); x = px; y = py; };
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      if (!cmd) cmd = cur ? 'L' : 'M';   // numbers without a command: a plain point list
      const rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase();
      if (C === 'Z') { if (cur) { cur.push([sx, sy]); x = sx; y = sy; } cur = null; continue; }
      if (i >= toks.length) break;
      if (C === 'M') { x = num() + (rel ? x : 0); y = num() + (rel ? y : 0); sx = x; sy = y; cur = [[x, y]]; out.push(cur); cmd = rel ? 'l' : 'L'; }
      else if (C === 'L') { const px = num() + (rel ? x : 0), py = num() + (rel ? y : 0); add(px, py); }
      else if (C === 'H') add(num() + (rel ? x : 0), y);
      else if (C === 'V') add(x, num() + (rel ? y : 0));
      else if (C === 'Q') { const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0), x0 = x, y0 = y; for (let k = 1; k <= steps; k++) { const t = k / steps, a = (1 - t) * (1 - t), b = 2 * t * (1 - t), c = t * t; add(a * x0 + b * x1 + c * x2, a * y0 + b * y1 + c * y2); } }
      else if (C === 'C') { const x1 = num() + (rel ? x : 0), y1 = num() + (rel ? y : 0), x2 = num() + (rel ? x : 0), y2 = num() + (rel ? y : 0), x3 = num() + (rel ? x : 0), y3 = num() + (rel ? y : 0), x0 = x, y0 = y; for (let k = 1; k <= steps; k++) { const t = k / steps, u = 1 - t; add(u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3); } }
      else if (C === 'A') { const rx = num(), ry = num(), ph = num(), la = num(), sw = num(), ex = num() + (rel ? x : 0), ey = num() + (rel ? y : 0); for (const p of arcPts(x, y, rx, ry, ph, la, sw, ex, ey, steps * 2)) add(p[0], p[1]); }
      else i++; // unsupported command: skip a token
    }
    return out.filter(p => p.length >= 2);
  }
  // SVG endpoint arc → points (excluding the start point)
  function arcPts(x1, y1, rx, ry, phi, fa, fs, x2, y2, n) {
    if (!rx || !ry) return [[x2, y2]];
    const p = phi * Math.PI / 180, cp = Math.cos(p), sp = Math.sin(p);
    const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2, x1p = cp * dx + sp * dy, y1p = -sp * dx + cp * dy;
    rx = Math.abs(rx); ry = Math.abs(ry);
    const lam = x1p * x1p / (rx * rx) + y1p * y1p / (ry * ry); if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
    let s = Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p) / (rx * rx * y1p * y1p + ry * ry * x1p * x1p)));
    if (+fa === +fs) s = -s;
    const cxp = s * rx * y1p / ry, cyp = -s * ry * x1p / rx, cx = cp * cxp - sp * cyp + (x1 + x2) / 2, cy = sp * cxp + cp * cyp + (y1 + y2) / 2;
    const ang = (ux, uy, vx, vy) => { const a = Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy); return a; };
    const t1 = ang(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry); let dt = ang((x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry);
    if (!+fs && dt > 0) dt -= 2 * Math.PI; else if (+fs && dt < 0) dt += 2 * Math.PI;
    const k = Math.max(2, Math.ceil(n * Math.abs(dt) / Math.PI)), out = [];
    for (let i = 1; i <= k; i++) { const t = t1 + dt * i / k, ex = rx * Math.cos(t), ey = ry * Math.sin(t); out.push([cp * ex - sp * ey + cx, sp * ex + cp * ey + cy]); }
    return out;
  }
  // our symbol SVG fragment (local coordinates) → polylines / circles
  function svgFragment(svg) {
    const items = [], attr = (s, k) => { const m = new RegExp('\\s' + k + '="([^"]*)"').exec(s); return m ? m[1] : null; };
    for (const m of String(svg).matchAll(/<(path|rect|circle|line|polyline|polygon|ellipse)\b([^>]*)\/?>/g)) {
      const [, tag, a] = m, cls = attr(a, 'class') || '', fill = /\bfill\b/.test(cls);
      if (tag === 'path') for (const pl of pathToPolys(attr(a, 'd') || '')) items.push({ k: 'pl', pts: pl, fill });
      else if (tag === 'rect') { const x = +attr(a, 'x') || 0, y = +attr(a, 'y') || 0, w = +attr(a, 'width') || 0, h = +attr(a, 'height') || 0; items.push({ k: 'pl', pts: [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]], fill }); }
      else if (tag === 'circle') items.push({ k: 'c', cx: +attr(a, 'cx') || 0, cy: +attr(a, 'cy') || 0, r: +attr(a, 'r') || 1, fill });
      else if (tag === 'ellipse') items.push({ k: 'c', cx: +attr(a, 'cx') || 0, cy: +attr(a, 'cy') || 0, r: (+attr(a, 'rx') + +attr(a, 'ry')) / 2 || 1, fill });
      else if (tag === 'line') items.push({ k: 'pl', pts: [[+attr(a, 'x1'), +attr(a, 'y1')], [+attr(a, 'x2'), +attr(a, 'y2')]] });
      else { const v = (attr(a, 'points') || '').trim().split(/[\s,]+/).map(Number), pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push([v[i], v[i + 1]]); if (tag === 'polygon' && pts.length) pts.push(pts[0]); items.push({ k: 'pl', pts, fill }); }
    }
    return items;
  }

  // ---------- schematic export ----------
  // One sheet: an EasyEDA schematic document (docType 1). Several sheets: a multi-sheet schematic (docType 5) with one
  // page per sheet, named like the sheets here; net labels with the same name connect the pages, as they do here.
  // ids: { LCSC number: { uuid, puuid, package } } from the EasyEDA library — with them EasyEDA links each part to its
  // library symbol and footprint (otherwise "Footprints Verification: can't find this footprint on the server").
  // EasyEDA Pro pairs a schematic symbol with its PCB footprint by the LIB id, so both exports derive it from the designator
  const libId = ref => 'ggeL' + String(ref).replace(/[^A-Za-z0-9]/g, '_');
  function exportSchematic(ids = {}) {
    const S = Model.S, sheetOf = c => (Model.sheetOf ? Model.sheetOf(c) : 0);
    const used = [...new Set(S.components.map(sheetOf))].sort((a, b) => a - b);
    if (used.length <= 1) return exportSchematicRaw(ids, null, S.name || 'Sheet_1');
    const names = (S.sheets || []).map(s => s && s.name);
    const pages = used.map((i, k) => {
      const title = String(names[i] || `Sheet_${k + 1}`).replace(/[~^`]/g, '-');
      // the page data both at the top of the sheet entry and in dataStr: readers take either form
      const doc = JSON.parse(exportSchematicRaw(ids, S.components.filter(c => sheetOf(c) === i), title));
      return Object.assign({ docType: '1', title, description: '' }, doc, { dataStr: doc });
    });
    return JSON.stringify({ editorVersion: '6.5.22', docType: '5', title: S.name || 'Schematic', description: 'Exported by CircuitPilot', colors: {}, schematics: pages });
  }
  function exportSchematicRaw(ids, only = null, title = null) {
    const S = Model.S, shapes = [];
    let gid = 0; const id = () => 'gge' + (++gid).toString(36) + 'cp';
    const bb = [Infinity, Infinity, -Infinity, -Infinity], grow = (x, y) => { bb[0] = Math.min(bb[0], x); bb[1] = Math.min(bb[1], y); bb[2] = Math.max(bb[2], x); bb[3] = Math.max(bb[3], y); };
    const idx = Model.pinIndex();
    for (const c of only || S.components) {
      const d = Lib.type(c.type); if (!d) continue;
      const tf = (x, y) => { const [rx, ry] = Lib.rot(x, y, c.rot || 0); return [n2(c.x + rx), n2(c.y + ry)]; };
      const lib = c.lcsc && S.lib[c.lcsc];
      const fp = (lib && lib.footprint && lib.footprint.name) || c.footprint || '';
      const lcsc = Model.lcscOf(c), link = (lcsc && ids[lcsc]) || null;
      // "pre" is the designator in EasyEDA ("R?" = not annotated: EasyEDA Pro then cannot pair the symbol with its footprint)
      const para = ['package', link && link.puuid && link.package ? link.package : fp, 'pre', c.ref, 'spicePre', (c.ref.replace(/\d+$/, '') || d.prefix || 'U'), 'Contributor', 'CircuitPilot', 'Supplier', lcsc ? 'LCSC' : '', 'Supplier Part', lcsc, 'Manufacturer Part', (lib && lib.mfr_part) || c.value || '', 'Manufacturer', (lib && lib.manufacturer) || ''];
      const sub = [];
      // graphics
      let svg = '';
      try { svg = c.type === 'part' && lib ? Lib.drawPart(lib).svg : d.draw(c); } catch (e) { svg = ''; }
      if (!svg && d.box) { const b = d.box(c); svg = `<rect x="${b[0]}" y="${b[1]}" width="${b[2] - b[0]}" height="${b[3] - b[1]}"/>`; }
      for (const it of svgFragment(svg)) {
        if (it.k === 'c') { const [cx, cy] = tf(it.cx, it.cy); sub.push(`E~${cx}~${cy}~${n2(it.r)}~${n2(it.r)}~#A00000~1~0~${it.fill ? '#A00000' : 'none'}~${id()}~0`); grow(cx, cy); }
        else { const pts = it.pts.map(p => tf(p[0], p[1])); pts.forEach(p => grow(p[0], p[1])); sub.push(`${it.fill ? 'PG' : 'PL'}~${pts.map(p => p.join(' ')).join(' ')}~#A00000~1~0~${it.fill ? '#A00000' : 'none'}~${id()}~0`); }
      }
      // pins: connection point at the pin tip, line toward the body
      const pins = Model.pinsWorld(c);
      for (const p of pins) {
        const tip = [n2(p.x), n2(p.y)], body = [n2(p.ax), n2(p.ay)];
        const ang = p.dx > 0 ? 0 : p.dx < 0 ? 180 : p.dy > 0 ? 90 : 270;
        const showName = p.show !== false && c.type !== 'resistor' ? 1 : 0;
        const nameX = n2(body[0] - p.dx * 3), nameY = n2(body[1] - p.dy * 3 + 3), numX = n2((tip[0] + body[0]) / 2), numY = n2((tip[1] + body[1]) / 2 - 2);
        sub.push(`P~show~0~${p.num}~${tip[0]}~${tip[1]}~${ang}~${id()}~0^^${tip[0]}~${tip[1]}^^M ${tip[0]} ${tip[1]} L ${body[0]} ${body[1]}~#880000^^${showName}~${nameX}~${nameY}~0~${String(p.name || p.num).replace(/[~^`#@$]/g, '_')}~${p.dx > 0 ? 'end' : 'start'}~~~#0000FF^^1~${numX}~${numY}~0~${p.num}~middle~~~#0000FF^^0~${tip[0]}~${tip[1]}^^0~M 0 0`);
        grow(tip[0], tip[1]);
      }
      const b = Model.bbox(c);
      sub.unshift(`T~N~${n2(b[0])}~${n2(b[3] + 10)}~0~#000080~Arial~~~~~comment~${String(c.value || '').replace(/~/g, '-')}~1~start~${id()}~0~`);
      sub.unshift(`T~P~${n2(b[0])}~${n2(b[1] - 4)}~0~#000080~Arial~~~~~comment~${c.ref}~1~start~${id()}~0~`);
      // LIB tail as EasyEDA writes it: rotation ~ importFlag ~ id ~ footprint uuid (puuid) ~ symbol uuid ~ 0 ~ ~ yes ~ yes
      const hex = v => /^[0-9a-f]{16,40}$/i.test(v || '') ? v : '';
      shapes.push([`LIB~${n2(c.x)}~${n2(c.y)}~${para.join('`')}\`~${c.rot || 0}~0~${libId(c.ref)}~${hex(link && link.puuid)}~${hex(link && link.uuid)}~0~~yes~yes`, ...sub].join('#@$'));
      // nets: a short stub wire and a net label at every connected pin (labels with the same name are connected)
      for (const p of pins) {
        const net = idx[p.key]; if (!net) continue;
        const ex = n2(p.x + p.dx * 10), ey = n2(p.y + p.dy * 10);
        shapes.push(`W~${n2(p.x)} ${n2(p.y)} ${ex} ${ey}~#008800~1~0~none~${id()}~0`);
        const anchor = p.dx < 0 ? 'end' : 'start';
        shapes.push(`N~${ex}~${ey}~${p.dy ? 270 : 0}~#000080~${net.replace(/~/g, '_')}~${id()}~${anchor}~${n2(ex + (p.dx < 0 ? -2 : 2))}~${n2(ey - 2)}~Times New Roman~7pt~0`);
        grow(ex, ey);
      }
    }
    if (!isFinite(bb[0])) { bb[0] = bb[1] = 0; bb[2] = bb[3] = 100; }
    const doc = {
      head: { docType: '1', editorVersion: '6.5.22', newgId: true, c_para: { 'Prefix Start': '1' }, c_spiceCmd: null, hasIdFlag: true, title: title || S.name || 'Sheet_1' },
      canvas: `CA~1000~1000~#FFFFFF~yes~#CCCCCC~5~1000~1000~line~5~pixel~5~0~0`,
      shape: shapes, BBox: { x: bb[0] - 20, y: bb[1] - 20, width: bb[2] - bb[0] + 40, height: bb[3] - bb[1] + 40 }, colors: {},
    };
    return JSON.stringify(doc);
  }

  // Pads of a pour's net that the exported copper (pour fills, tracks, vias) does not join to the rest: the pour reaches
  // them only through a neck thinner than its clearance allows, so EasyEDA reports them unconnected
  function pourSplits(fills, idx) {
    const inside = (rings, x, y) => { let n = 0; for (const rg of rings) for (let i = 0, k = rg.length - 1; i < rg.length; k = i++) { const [xi, yi] = rg[i], [xk, yk] = rg[k]; if ((yi > y) !== (yk > y) && x < (xk - xi) * (y - yi) / (yk - yi) + xi) n++; } return n % 2 === 1; };
    const out = [];
    for (const net of [...new Set(fills.map(f => f.p.net))]) {
      const pads = []; for (const c of Pcb.placed()) for (const p of Pcb.padsOf(c, idx)) if (p.net === net) pads.push(p);
      const vias = Model.S.pcb.vias.filter(v => v.net === net), on = (p, L) => p.drill || p.layer === L, mine = fills.filter(f => f.p.net === net);
      // pads grouped by what connects them; island(f, x, y) names the piece of pour copper at a point (or '')
      const groups = island => {
        const par = new Map(), add = a => { if (!par.has(a)) par.set(a, a); }, find = a => { while (par.get(a) !== a) a = par.get(a); return a; }, uni = (a, b) => { add(a); add(b); par.set(find(a), find(b)); };
        pads.forEach(p => add('p' + p.key));
        Model.S.pcb.traces.filter(t => t.net === net).forEach((t, ti) => { add('t' + ti); for (const q of t.pts) {
          for (const p of pads) if (on(p, t.layer) && Math.abs(q[0] - p.x) <= p.w / 2 && Math.abs(q[1] - p.y) <= p.h / 2) uni('t' + ti, 'p' + p.key);
          vias.forEach((v, i) => { if (Math.hypot(q[0] - v.x, q[1] - v.y) <= v.d / 2) uni('t' + ti, 'v' + i); }); } });
        mine.forEach((f, fi) => {
          for (const p of pads) if (on(p, f.p.layer)) for (let a = -0.45; a <= 0.45; a += 0.15) for (let b = -0.45; b <= 0.45; b += 0.15) { const k = island(f, p.x + a * p.w, p.y + b * p.h); if (k) uni(fi + ':' + k, 'p' + p.key); }
          vias.forEach((v, i) => { for (let a = 0; a < 8; a++) { const k = island(f, v.x + Math.cos(a * Math.PI / 4) * v.d * 0.45, v.y + Math.sin(a * Math.PI / 4) * v.d * 0.45); if (k) uni(fi + ':' + k, 'v' + i); } });
        });
        const g = new Map(); for (const p of pads) g.set(p.key, find('p' + p.key)); return g;
      };
      const exp = groups((f, x, y) => { const k = f.fr.findIndex(rs => inside(rs, x, y)); return k < 0 ? '' : 'x' + k; });
      const own = groups((f, x, y) => { const r = f.raster || (f.raster = Pcb.pourRaster(Object.assign({}, f.p, { _margin: 0.075 }))), k = r.at(x, y); return k ? 'r' + k : ''; });
      // a piece of the exported copper that CircuitPilot's own pour joins to other pads
      const seen = new Set();
      for (const p of pads) {
        const g = exp.get(p.key); if (seen.has(g)) continue; seen.add(g);
        const part = pads.filter(q => exp.get(q.key) === g), joined = pads.some(q => exp.get(q.key) !== g && own.get(q.key) === own.get(p.key));
        if (joined && part.length < pads.length / 2 + 0.1) out.push(`${net}: ${part.map(q => q.key).join(', ')} reach the rest of ${net} only through pour copper thinner than the clearance — add a via or a track`);
      }
    }
    return out;
  }

  // ---------- PCB export ----------
  // Same records the importer below reads. Footprints are written in full (pads in board coordinates), so EasyEDA needs no
  // library lookup; net names on pads, tracks, vias and pours are the schematic's net names.
  function exportPcb(ids = {}) {
    const S = Model.S, idx = Model.pinIndex(), cs = Pcb.placed();
    if (!cs.length || !S.board.w) throw new Error('No PCB yet: create the PCB first (PCB tab)');
    const OX = 4000, OY = 3000, u = v => n2(v / U), X = x => n2(OX + x / U), Y = y => n2(OY + y / U);
    let gid = 0; const id = () => 'gge' + (++gid).toString(36) + 'cp';
    const clean = s => String(s == null ? '' : s).replace(/[~`#@$^]/g, '_');
    const shapes = [], cuL = l => l === 'B' ? 2 : 1, dn = v => Math.floor(v / U * 100 + 1e-6) / 100;   // minimums: rounded down
    for (const c of cs) {
      const lib = c.type === 'part' ? S.lib[c.lcsc] : null, bot = Pcb.isBottom(c), lcsc = Model.lcscOf(c);
      const link = (lcsc && ids[lcsc]) || null;   // the EasyEDA library footprint the schematic symbol points to
      const pkg = clean(link && link.puuid && link.package ? link.package : (lib && lib.footprint && lib.footprint.name) || c.footprint || 'FOOTPRINT');
      const para = ['package', pkg, 'pre', clean(c.ref), 'Contributor', 'CircuitPilot', 'Supplier', lcsc ? 'LCSC' : '', 'Supplier Part', lcsc, 'Manufacturer Part', clean((lib && lib.mfr_part) || c.value || ''), 'Manufacturer', clean((lib && lib.manufacturer) || '')];
      const sub = [];
      // pads in the footprint's own orientation plus the part's rotation (board-oriented sizes would make every rotated
      // copy a different footprint for EasyEDA Pro, which then "fixes" them by turning the pads 90°)
      // EasyEDA turns counter-clockwise on screen, CircuitPilot clockwise: a part at 90° here is at 270° in EasyEDA
      const rot = ((c.pcb.rot || 0) % 360 + 360) % 360, sw = rot === 90 || rot === 270, erot = (360 - rot) % 360;
      // footprint shapes rounded relative to the part's origin: rounded on the board, two copies of a footprint could differ
      // by 0.01 and EasyEDA Pro would see different footprints of the same name ("Modify Footprint 1206 → 1206")
      const ox = X(c.pcb.x), oy = Y(c.pcb.y), FX = v => n2(ox + n2((v - c.pcb.x) / U)), FY = v => n2(oy + n2((v - c.pcb.y) / U));
      for (const p of Pcb.padsOf(c, idx)) {
        const x = FX(p.x), y = FY(p.y), w = u(p.w), h = u(p.h), layer = p.drill ? 11 : cuL(p.layer), lw = sw ? h : w, lh = sw ? w : h;
        const shape = p.shape === 'round' ? 'ELLIPSE' : p.shape === 'oval' ? 'OVAL' : 'RECT';
        const x0 = FX(p.x - p.w / 2), x1 = FX(p.x + p.w / 2), y0 = FY(p.y - p.h / 2), y1 = FY(p.y + p.h / 2);
        const pts = shape === 'RECT' ? `${x0} ${y0} ${x1} ${y0} ${x1} ${y1} ${x0} ${y1}` : '';
        sub.push(`PAD~${shape}~${x}~${y}~${lw}~${lh}~${layer}~${clean(p.net || '')}~${clean(p.num)}~${p.drill ? u(p.drill / 2) : 0}~${pts}~${erot}~${id()}~0~~Y~0~0~0.2~${x},${y}`);
      }
      // outline and texts from the footprint's own box, turned with the part (so they are the same in every copy)
      const b0 = Lib.footprint(c.footprint).box, m = bot ? [-b0[2], b0[1], -b0[0], b0[3]] : b0, silk = bot ? 4 : 3;
      const W = (x, y) => { const [rx, ry] = Lib.rot(x, y, rot); return FX(c.pcb.x + rx) + ' ' + FY(c.pcb.y + ry); }, WT = (x, y) => W(x, y).replace(' ', '~');
      sub.push(`TRACK~0.6~${silk}~~${[[m[0], m[1]], [m[2], m[1]], [m[2], m[3]], [m[0], m[3]], [m[0], m[1]]].map(q => W(q[0], q[1])).join(' ')}~${id()}~0`);
      sub.push(`TEXT~P~${WT(m[0], m[1] - 2 * U)}~0.6~${erot}~${bot ? 1 : 0}~${silk}~~4~${clean(c.ref)}~~~${id()}~0~pinpart`);
      sub.push(`TEXT~N~${WT(m[0], m[3] + 6 * U)}~0.6~${erot}~${bot ? 1 : 0}~${bot ? 14 : 13}~~4~${clean(c.value || '')}~~none~${id()}~0~pinpart`);
      // LIB: x ~ y ~ attributes ~ rotation ~ importFlag ~ id ~ layer (1 top, 2 bottom)
      const hexId = v => /^[0-9a-f]{16,40}$/i.test(v || '') ? v : '';
      shapes.push([`LIB~${ox}~${oy}~${para.join('`')}\`~${erot}~0~${libId(c.ref)}~${bot ? 2 : 1}~${hexId(link && link.puuid)}`, ...sub].join('#@$'));
    }
    for (const t of S.pcb.traces || []) if (t.pts && t.pts.length >= 2) shapes.push(`TRACK~${u(t.w)}~${cuL(t.layer)}~${clean(t.net)}~${t.pts.map(q => X(q[0]) + ' ' + Y(q[1])).join(' ')}~${id()}~0`);
    for (const v of S.pcb.vias || []) shapes.push(`VIA~${X(v.x)}~${Y(v.y)}~${u(v.d)}~${clean(v.net)}~${u((v.drill || 0.3) / 2)}~${id()}~0`);
    for (const h of S.pcb.holes || []) shapes.push(`HOLE~${X(h.x)}~${Y(h.y)}~${u(h.d / 2)}~${id()}~0`);
    // copper pours: COPPERAREA ~ stroke ~ layer ~ net ~ points "x y x y …" ~ clearance ~ solid ~ id ~ thermal ~ keep island ~ fill
    // (empty: EasyEDA fills it — Rebuild copper areas) ~ locked. The outline is the pour's real one (whole board, polygon or clipped);
    // EasyEDA keeps the fill off the board edge with its own rule.
    // fill grid: 0.05 mm on small boards (the traced copper then needs only 0.04 mm extra margin), 0.1 mm on big ones
    const fineFill = S.board.w * S.board.h <= 2500, fg = fineFill ? 0.05 : 0.1, fm = fineFill ? 0.04 : 0.08, fills = [];
    exportPcb.warnings = [];
    for (const p of S.pcb.pours || []) {
      const pts = Pcb.pourPoly(p); if (!pts || pts.length < 3 || !S.nets[p.net]) continue;
      // the fill as EasyEDA stores it: one path per piece of copper, its outer ring and holes as sub-paths of the same
      // string (a hole as a separate string would be drawn as copper)
      let fill = '[]';
      try { const fr = Pcb.pourFillRings(p, fg, fm); fills.push({ p, fr }); fill = JSON.stringify(fr.map(rings => [rings.map(rg => 'M' + rg.map(q => X(q[0]) + ',' + Y(q[1])).join(' ') + 'z').join(' ')])); } catch (e) { fill = '[]'; }
      shapes.push(`COPPERAREA~${u(0.254)}~${cuL(p.layer)}~${clean(p.net)}~${pts.map(q => X(q[0]) + ' ' + Y(q[1])).join(' ')}~${u(Pcb.pourCl(Pcb.rules(), p))}~solid~${id()}~direct~none~${fill}~0`);
    }
    try { exportPcb.warnings = pourSplits(fills, idx); } catch (e) { }
    // free silkscreen text and the board name (part designators travel inside their footprints). EasyEDA anchors a
    // text at the start of its baseline and turns it counter-clockwise, as CircuitPilot's labels do
    for (const side of ['F', 'B']) for (const l of Pcb.silkLabels(side)) {
      if (l.kind !== 'text' && l.kind !== 'board') continue;
      const r0 = l.rect0, rot = ((+l.rot || 0) % 360 + 360) % 360, bot = side === 'B';
      let ax = bot ? r0[2] - 0.1 : r0[0] + 0.1, ay = r0[3] - 0.1;
      if (rot) [ax, ay] = Pcb.rotPt(ax, ay, (r0[0] + r0[2]) / 2, (r0[1] + r0[3]) / 2, rot);
      shapes.push(`TEXT~L~${X(ax)}~${Y(ay)}~${u(l.w)}~${rot}~${bot ? 1 : 0}~${bot ? 4 : 3}~~${u(l.h)}~${clean(l.text)}~~~${id()}~0`);
    }
    const poly = Pcb.boardPoly(), loop = poly.concat([poly[0]]);
    shapes.push(`TRACK~1~10~~${loop.map(q => X(q[0]) + ' ' + Y(q[1])).join(' ')}~${id()}~0`);
    const layers = ['1~TopLayer~#FF0000~true~true~true~', '2~BottomLayer~#0000FF~true~false~true~', '3~TopSilkLayer~#FFCC00~true~false~true~', '4~BottomSilkLayer~#66CC33~true~false~true~',
      '5~TopPasteMaskLayer~#808080~true~false~true~', '6~BottomPasteMaskLayer~#800000~true~false~true~', '7~TopSolderMaskLayer~#800080~true~false~true~0.3', '8~BottomSolderMaskLayer~#AA00FF~true~false~true~0.3',
      '10~BoardOutLine~#FF00FF~true~false~true~', '11~Multi-Layer~#C0C0C0~true~false~true~', '12~Document~#FFFFFF~true~false~true~', '13~TopAssembly~#33CC99~false~false~false~', '14~BottomAssembly~#5555FF~false~false~false~'];
    const bw = u(S.board.w), bh = u(S.board.h);
    return JSON.stringify({
      head: { docType: '3', editorVersion: '6.5.22', newgId: true, c_para: {}, x: OX, y: OY, hasIdFlag: true, importFlag: 0, transformList: '', title: (S.name || 'PCB') + ' PCB' },
      canvas: `CA~${n2(OX * 2)}~${n2(OY * 2)}~#000000~yes~#FFFFFF~10~1000~1000~line~0.5~mm~1~45~visible~0.5~${OX}~${OY}~0~yes`,
      shape: shapes, layers, objects: [], BBox: { x: OX - 10, y: OY - 10, width: bw + 20, height: bh + 20 }, preference: { hideFootprints: '', hideNets: '' },
      // the design rules the board was routed with (EasyEDA units, 10 mil): otherwise EasyEDA checks against its own default (6 mil)
      DRCRULE: (R => ({ Default: { trackWidth: dn(Math.min(R.traceWidth, ...(S.pcb.traces || []).map(t => +t.w || R.traceWidth))), clearance: dn(R.clearance), viaHoleDiameter: u(R.viaDiameter), viaHoleD: u(R.viaDrill) }, isRealtime: true, isDrcOnRoutingOrPlaceVia: false, checkObjectToCopperarea: true, showDRCRangeLine: true }))(Pcb.rules()), netColors: [],
    });
  }

  // ---------- PCB import ----------
  function unwrap(j) {
    if (typeof j === 'string') j = JSON.parse(j);
    for (let guard = 0; guard < 5; guard++) {
      if (j && j.result && (j.result.dataStr || j.result.shape)) { j = j.result.dataStr || j.result; continue; }
      if (j && j.pcbs && j.pcbs.length) { j = j.pcbs[0]; continue; }
      if (j && j.dataStr && !j.shape) { j = typeof j.dataStr === 'string' ? JSON.parse(j.dataStr) : j.dataStr; continue; }
      break;
    }
    if (!j || !Array.isArray(j.shape)) throw new Error('Not an EasyEDA document (expected the JSON from EasyEDA Standard: File → Export → EasyEDA Source)');
    const t = String((j.head && j.head.docType) || j.docType || '');
    if (t && t !== '3') throw new Error(t === '1' ? 'This is an EasyEDA schematic — open the PCB document (docType 3) instead' : `Unsupported EasyEDA document type ${t} (need a PCB, docType 3)`);
    return j;
  }
  const para = s => { const o = {}, a = String(s || '').split('`'); for (let i = 0; i + 1 < a.length; i += 2) if (a[i]) o[a[i]] = a[i + 1]; return o; };

  function importPcb(json) {
    const j = unwrap(json), log = [], P = v => +v * U;
    const pads = [], libs = [], tracks = [], vias = [], holes = [], outline = [], areas = [], texts = [];
    const copper = l => l === '1' ? 'F' : l === '2' ? 'B' : null;
    const arcPoly = (path, w) => pathToPolys(path, 6).map(pl => pl.map(q => [P(q[0]), P(q[1])]));
    function padRec(f) {
      // PAD~shape~x~y~w~h~layer~net~number~holeR~points~rotation~id~holeLength~slotPoints~plated~...
      const shape = f[1], x = P(f[2]), y = P(f[3]); let w = P(f[4]), h = P(f[5]);
      const rot = ((+f[11] || 0) % 180 + 180) % 180, holeR = +f[9] || 0;
      const pts = String(f[10] || '').trim().split(/\s+/).map(Number).filter(v => !isNaN(v));
      if ((shape === 'RECT' || shape === 'POLYGON') && pts.length >= 6) { const xs = pts.filter((_, i) => !(i & 1)).map(P), ys = pts.filter((_, i) => i & 1).map(P); w = Math.max(...xs) - Math.min(...xs); h = Math.max(...ys) - Math.min(...ys); }
      else if (Math.abs(rot - 90) < 1) [w, h] = [h, w];
      else if (rot > 1 && rot < 179 && shape !== 'ELLIPSE') { const a = rot * Math.PI / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a)); [w, h] = [w * c + h * s, w * s + h * c]; }
      return { x, y, w: Math.max(0.05, w), h: Math.max(0.05, h), shape: shape === 'ELLIPSE' ? 'round' : shape === 'OVAL' ? 'oval' : 'rect', drill: holeR > 0 ? 2 * holeR * U : 0, plated: f[15] !== 'N', layer: f[6], net: f[7] || '', num: String(f[8] || '').trim() };
    }
    for (const s of j.shape) {
      if (typeof s !== 'string') continue;
      const f = s.split('~'), k = f[0];
      if (k === 'LIB') {
        const parts = s.split('#@$'), h = parts[0].split('~'), lib = { x: P(h[1]), y: P(h[2]), para: para(h[3]), rot: +h[4] || 0, side: h[7] === '2' ? 'B' : 'F', pads: [], silk: [], ref: '', value: '' };
        for (const sub of parts.slice(1)) {
          const g = sub.split('~');
          if (g[0] === 'PAD') lib.pads.push(padRec(g));
          else if (g[0] === 'TEXT' && g[1] === 'P') lib.ref = g[10] || '';
          else if (g[0] === 'TEXT' && g[1] === 'N') lib.value = g[10] || '';
          else if (g[0] === 'TRACK' && ['3', '4', '13', '14', '99'].includes(g[2])) { const v = String(g[4] || '').trim().split(/\s+/).map(Number); for (let i = 0; i + 1 < v.length; i += 2) lib.silk.push([P(v[i]), P(v[i + 1])]); }
          else if (g[0] === 'CIRCLE' && ['3', '4', '13', '14', '99'].includes(g[5])) { const cx = P(g[1]), cy = P(g[2]), r = P(g[3]); lib.silk.push([cx - r, cy - r], [cx + r, cy + r]); }
        }
        libs.push(lib);
      } else if (k === 'PAD') pads.push(padRec(f));
      else if (k === 'TRACK') {
        const v = String(f[4] || '').trim().split(/\s+/).map(Number), pts = []; for (let i = 0; i + 1 < v.length; i += 2) pts.push([P(v[i]), P(v[i + 1])]);
        if (f[2] === '10') outline.push(pts); else if (copper(f[2]) && pts.length >= 2) tracks.push({ net: f[3] || '', layer: copper(f[2]), w: P(f[1]), pts });
      } else if (k === 'ARC') {
        for (const pl of arcPoly(f[4])) { if (f[2] === '10') outline.push(pl); else if (copper(f[2])) tracks.push({ net: f[3] || '', layer: copper(f[2]), w: P(f[1]), pts: pl }); }
      } else if (k === 'CIRCLE' && f[5] === '10') {
        const cx = P(f[1]), cy = P(f[2]), r = P(f[3]); outline.push(Array.from({ length: 65 }, (_, i) => [cx + r * Math.cos(i / 64 * 2 * Math.PI), cy + r * Math.sin(i / 64 * 2 * Math.PI)]));
      } else if (k === 'RECT' && f[5] === '10') {
        const x = P(f[1]), y = P(f[2]), w = P(f[3]), h = P(f[4]); outline.push([[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]]);
      } else if (k === 'VIA') vias.push({ x: P(f[1]), y: P(f[2]), d: P(f[3]), net: f[4] || '', drill: 2 * (+f[5] || 0) * U });
      else if (k === 'HOLE') holes.push({ x: P(f[1]), y: P(f[2]), d: 2 * (+f[3] || 0) * U });
      // free text on a silkscreen layer: x / y = start of the baseline (end when mirrored on the bottom)
      else if (k === 'TEXT' && (f[7] === '3' || f[7] === '4') && String(f[10] || '').trim()) texts.push({ text: String(f[10]).trim(), x: P(f[2]), y: P(f[3]), h: P(f[9]) || 1.2, rot: ((+f[5] || 0) % 360 + 360) % 360, side: f[7] === '4' ? 'B' : 'F' });
      // COPPERAREA points: EasyEDA writes a plain point list "x y x y …" (older CircuitPilot exports: an SVG path)
      else if (k === 'COPPERAREA' && copper(f[2])) { const pl = pathToPolys(/[a-zA-Z]/.test(f[4]) ? f[4] : 'M ' + f[4] + ' Z', 6)[0]; if (pl && pl.length >= 3) areas.push({ net: f[3] || '', layer: copper(f[2]), pts: pl.map(q => [P(q[0]), P(q[1])]), clearance: P(f[5] || 0) }); }
    }
    if (!libs.length) throw new Error('No footprints found in this EasyEDA PCB');
    for (const p of pads) if (p.drill && !p.plated) holes.push({ x: p.x, y: p.y, d: p.drill });
    if (pads.some(p => p.drill && p.plated)) log.push(`${pads.filter(p => p.drill && p.plated).length} free-standing plated pads were skipped`);

    // ---- board outline: chain the edge segments into the largest closed loop
    let loop = null;
    if (outline.length) {
      const segs = outline.map(pl => pl.slice()), loops = [], near = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]) < 0.02;
      while (segs.length) {
        let cur = segs.shift();
        for (let grew = true; grew && !near(cur[0], cur[cur.length - 1]);) {
          grew = false;
          for (let i = 0; i < segs.length; i++) {
            const s = segs[i], e = cur[cur.length - 1];
            if (near(s[0], e)) { cur = cur.concat(s.slice(1)); segs.splice(i, 1); grew = true; break; }
            if (near(s[s.length - 1], e)) { cur = cur.concat(s.slice(0, -1).reverse()); segs.splice(i, 1); grew = true; break; }
          }
        }
        loops.push(cur);
      }
      const area = L => { let a = 0; for (let i = 0; i < L.length - 1; i++) a += L[i][0] * L[i + 1][1] - L[i + 1][0] * L[i][1]; return Math.abs(a / 2); };
      loop = loops.filter(L => L.length >= 4).sort((a, b) => area(b) - area(a))[0] || null;
      if (loop && near(loop[0], loop[loop.length - 1])) loop = loop.slice(0, -1);
    }
    // everything relative to the outline's top-left corner
    const allX = loop ? loop.map(q => q[0]) : libs.flatMap(l => l.pads.map(p => p.x)), allY = loop ? loop.map(q => q[1]) : libs.flatMap(l => l.pads.map(p => p.y));
    const margin = loop ? 0 : 3, ox = Math.min(...allX) - margin, oy = Math.min(...allY) - margin;
    const bw = n4(Math.max(...allX) + margin - ox), bh = n4(Math.max(...allY) + margin - oy);
    const mv = q => [n4(q[0] - ox), n4(q[1] - oy)];

    // ---- library parts: one definition per distinct footprint (and LCSC part)
    const S = Model.S, defs = new Map(), used = new Set(S.components.map(c => c.ref));
    const nearest90 = r => ((Math.round(r / 90) * 90) % 360 + 360) % 360;
    let made = 0, skewed = 0;
    for (const L of libs) {
      if (!L.pads.length) continue;
      const exact = Math.abs(L.rot - Math.round(L.rot / 90) * 90) < 0.5;
      const r = exact ? (360 - nearest90(L.rot)) % 360 : 0; if (!exact) skewed++;   // EasyEDA turns the other way
      const bot = L.side === 'B', sw = r === 90 || r === 270;
      const local = (x, y) => { let [u, v] = Lib.rot(x - L.x, y - L.y, (360 - r) % 360); if (bot) u = -u; return [n4(u), n4(v)]; };
      const fpPads = L.pads.map(p => { const [x, y] = local(p.x, p.y); const q = { num: p.num || '?', x, y, w: n4(sw ? p.h : p.w), h: n4(sw ? p.w : p.h), shape: p.shape }; if (p.drill) q.drill = n4(p.drill); return q; });
      const xs = fpPads.flatMap(p => [p.x - p.w / 2, p.x + p.w / 2]), ys = fpPads.flatMap(p => [p.y - p.h / 2, p.y + p.h / 2]);
      for (const q of L.silk) { const [x, y] = local(q[0], q[1]); xs.push(x); ys.push(y); }
      const body = [n4(Math.min(...xs)), n4(Math.min(...ys)), n4(Math.max(...xs)), n4(Math.max(...ys))];
      const pkg = L.para.package || 'FOOTPRINT', lcsc = /^C\d+$/.test(L.para['Supplier Part'] || '') ? L.para['Supplier Part'] : '';
      const sig = JSON.stringify(fpPads.map(p => [p.num, p.x, p.y, p.w, p.h, p.shape, p.drill || 0]));
      let key = null;
      for (const [k, d] of defs) if (d.sig === sig && d.lcsc === lcsc) { key = k; break; }
      if (!key) {
        key = lcsc || ('EE_' + pkg.replace(/[^\w.-]+/g, '_')).slice(0, 48);
        for (let n = 2; defs.has(key) || (S.lib[key] && !defs.has(key)); n++) key = (lcsc || ('EE_' + pkg.replace(/[^\w.-]+/g, '_')).slice(0, 44)) + '_' + n;
        const nums = [...new Set(fpPads.map(p => p.num))];
        const pins = nums.map((num, i) => ({ num, name: num, side: i < Math.ceil(nums.length / 2) ? 'L' : 'R' }));
        const prefix = (L.para.pre || L.ref || 'U').replace(/[^A-Za-z]/g, '') || 'U';
        const def = { name: L.para['Manufacturer Part'] || pkg, value: L.value || pkg, prefix, pins, footprint: { name: pkg, pads: fpPads, body }, custom: !lcsc, lcsc: lcsc || key, source: 'EasyEDA import' };
        if (lcsc) Object.assign(def, { lcsc, mfr_part: L.para['Manufacturer Part'] || '', manufacturer: L.para.Manufacturer || '' });
        Model.setLibPart(key, def); defs.set(key, { sig, lcsc }); made++;
      }
      // the component
      let ref = (L.ref || '').trim().replace(/\s+/g, '');
      if (!ref || used.has(ref)) ref = undefined;
      const c = Model.addComponent({ part: key, ref, value: L.value || undefined });
      used.add(c.ref);
      const [cx, cy] = mv([L.x, L.y]);
      c.pcb = { x: cx, y: cy, rot: r }; if (bot) c.pcb.side = 'B';
      L.c = c;
    }
    // ---- nets from pad net names
    const nets = {};
    for (const L of libs) if (L.c) for (const p of L.pads) if (p.net) (nets[p.net] = nets[p.net] || new Set()).add(L.c.ref + '.' + (p.num || '?'));
    for (const [n, keys] of Object.entries(nets)) if (keys.size) Model.connect(n.replace(/\s+/g, '_'), [...keys]);
    // ---- board, copper
    S.board.w = bw; S.board.h = bh;
    const isRect = loop && loop.length === 4 && loop.every(q => (Math.abs(q[0] - ox) < 0.01 || Math.abs(q[0] - (ox + bw)) < 0.01) && (Math.abs(q[1] - oy) < 0.01 || Math.abs(q[1] - (oy + bh)) < 0.01));
    if (loop && !isRect) S.board.shape = { type: 'polygon', pts: loop.map(mv), r: 0 }; else delete S.board.shape;
    const netName = n => n ? n.replace(/\s+/g, '_') : '';
    S.pcb = {
      traces: tracks.map(t => ({ net: netName(t.net), layer: t.layer, w: n4(t.w), pts: t.pts.map(mv) })),
      vias: vias.map(v => ({ net: netName(v.net), x: mv([v.x, v.y])[0], y: mv([v.x, v.y])[1], d: n4(v.d), drill: n4(v.drill || 0.3) })),
      holes: holes.map(h => ({ x: mv([h.x, h.y])[0], y: mv([h.x, h.y])[1], d: n4(h.d) })),
      texts: texts.map(t => {   // CircuitPilot text: x / y = middle of the text, before turning
        const tw = Pcb.textWidth(t.text, t.h), cx = t.side === 'B' ? t.x - tw / 2 : t.x + tw / 2, cy = t.y - t.h / 2;
        const [mx, my] = t.rot ? Pcb.rotPt(cx, cy, t.x, t.y, t.rot) : [cx, cy], q = mv([mx, my]);
        return Object.assign({ text: t.text, x: q[0], y: q[1], h: n4(t.h), side: t.side }, t.rot ? { rot: t.rot } : {});
      }),
      pours: areas.filter(a => !a.net || S.nets[netName(a.net)]).map(a => Object.assign({ net: netName(a.net) || 'GND', layer: a.layer, pts: a.pts.map(mv) }, a.clearance > 0 ? { clearance: n4(a.clearance) } : {})),
      routed: {},
    };
    // schematic: symbols where the parts sit on the board, then spread so labels don't overlap (autoLayout is far too slow for big boards)
    for (const L of libs) if (L.c) { L.c.x = Math.round(L.c.pcb.x * 3) * 10; L.c.y = Math.round(L.c.pcb.y * 3) * 10; }
    try { Model.spaceOut(); } catch (e) { log.push('schematic spacing: ' + e.message); }
    if (skewed) log.push(`${skewed} footprints were placed at a non-90° angle — their pads are kept in place but the footprint outline is axis-aligned`);
    return { components: libs.filter(l => l.c).length, footprints: made, nets: Object.keys(nets).length, tracks: tracks.length, vias: vias.length, pours: S.pcb.pours.length, board_mm: [bw, bh], outline: loop ? (isRect ? 'rectangle' : 'polygon') : 'none (sized to the parts)', notes: log };
  }
  const isEasyEDA = j => { try { return !!unwrap(j); } catch (e) { return /EasyEDA schematic/.test(e.message) ? 'schematic' : false; } };
  return { exportSchematic, exportPcb, importPcb, isEasyEDA, pathToPolys };
})();
if (typeof module !== 'undefined') module.exports = EasyEDA;
