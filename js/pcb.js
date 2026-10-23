'use strict';
// PCB: auto-placement, design rules (JLCPCB defaults), rule-driven 2-layer autorouter (A*), DRC, rendering, Gerber + Excellon export.
const Pcb = (() => {
  const G = 0.25; // placement snap (mm); routing grid comes from the design rules

  // ---------- geometry ----------
  // Bottom-side parts are mirrored (x → -x, seen from the top) and their SMD pads sit on BottomLayer.
  const isBottom = c => c.pcb && c.pcb.side === 'B';
  // Exposed / thermal pad (QFN / DFN paddle, the tab under a power IC): a large SMD pad near the middle of the footprint
  // with pins on both sides of it. Edge pins of modules (XIAO castellations), connectors and big chip pads never are —
  // only exposed pads may take thermal vias.
  const epCache = new WeakMap();
  function exposedPads(fp) {
    let set = epCache.get(fp); if (set) return set;
    set = new Set(); const smd = fp.pads.filter(p => !p.drill), b = fp.box || [0, 0, 0, 0];
    const cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, hw = (b[2] - b[0]) / 2, hh = (b[3] - b[1]) / 2;
    for (const p of smd) {
      if (p.ep) { set.add(p.num); continue; }   // footprint data can say so
      if (Math.min(p.w, p.h) < 1.5 || smd.length < 5) continue;   // a paddle has at least 4 pins around it (a coin-cell contact is not one)
      if (Math.abs(p.x - cx) > 0.3 * hw || Math.abs(p.y - cy) > 0.3 * hh) continue;   // not near the middle
      const o = smd.filter(q => q !== p);
      const lr = o.some(q => q.x < p.x - p.w / 2) && o.some(q => q.x > p.x + p.w / 2);
      const ud = o.some(q => q.y < p.y - p.h / 2) && o.some(q => q.y > p.y + p.h / 2);
      if (lr || ud) set.add(p.num);   // pins on both sides: a centre paddle
    }
    epCache.set(fp, set); return set;
  }
  function padsOf(c, idx) {
    const fp = Lib.footprint(c.footprint); if (!fp || !c.pcb) return [];
    const r = c.pcb.rot || 0, sw = r === 90 || r === 270, bot = isBottom(c), ep = exposedPads(fp);
    return fp.pads.map((p, i) => {
      const [x, y] = Lib.rot(bot ? -p.x : p.x, p.y, r), key = c.ref + '.' + p.num;
      const net = idx ? (idx[key] || (c.pinAlias && c.pinAlias[p.num] ? idx[c.ref + '.' + c.pinAlias[p.num]] : undefined)) : undefined;
      return { ...p, ep: ep.has(p.num), x: c.pcb.x + x, y: c.pcb.y + y, w: sw ? p.h : p.w, h: sw ? p.w : p.h, key, uid: c.ref + '#' + i, ref: c.ref, layer: p.drill ? null : (bot ? 'B' : 'F'), net };
    });
  }
  function fpBox(c, pad = 0) {
    const fp = Lib.footprint(c.footprint), b0 = fp.box, m = isBottom(c) ? [-b0[2], b0[1], -b0[0], b0[3]] : b0, b = Lib.rotBox(m, c.pcb.rot || 0);
    return [c.pcb.x + b[0] - pad, c.pcb.y + b[1] - pad, c.pcb.x + b[2] + pad, c.pcb.y + b[3] + pad];
  }
  const padCu = (p, L2) => p.drill ? L2 : [p.layer || 'F'];

  // ---------- board outline (rectangle, rounded rectangle, ellipse, custom polygon with rounded corners) ----------
  function filletPoly(pts, r, segs = 10) {
    if (!r || r <= 0 || pts.length < 3) return pts.slice();
    const out = [], n = pts.length;
    for (let i = 0; i < n; i++) {
      const P = pts[i], A = pts[(i - 1 + n) % n], B = pts[(i + 1) % n];
      const ua = [A[0] - P[0], A[1] - P[1]], ub = [B[0] - P[0], B[1] - P[1]], la = Math.hypot(...ua), lb = Math.hypot(...ub);
      if (la < 1e-9 || lb < 1e-9) { out.push(P); continue; }
      ua[0] /= la; ua[1] /= la; ub[0] /= lb; ub[1] /= lb;
      const ang = Math.acos(Math.max(-1, Math.min(1, ua[0] * ub[0] + ua[1] * ub[1])));
      if (ang > Math.PI - 1e-3) { out.push(P); continue; }
      let t = r / Math.tan(ang / 2); t = Math.min(t, la / 2, lb / 2); const rr = t * Math.tan(ang / 2);
      const T1 = [P[0] + ua[0] * t, P[1] + ua[1] * t], T2 = [P[0] + ub[0] * t, P[1] + ub[1] * t];
      const bis = [ua[0] + ub[0], ua[1] + ub[1]], bl = Math.hypot(...bis), dc = rr / Math.sin(ang / 2);
      const C = [P[0] + bis[0] / bl * dc, P[1] + bis[1] / bl * dc];
      let a1 = Math.atan2(T1[1] - C[1], T1[0] - C[0]), a2 = Math.atan2(T2[1] - C[1], T2[0] - C[0]), d = a2 - a1;
      while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
      for (let k = 0; k <= segs; k++) { const a = a1 + d * k / segs; out.push([C[0] + rr * Math.cos(a), C[1] + rr * Math.sin(a)]); }
    }
    return out;
  }
  function boardPoly(board = Model.S.board) {
    const w = board.w, h = board.h, sh = board.shape || { type: 'rect' };
    if (sh.type === 'ellipse') { const out = []; for (let k = 0; k < 96; k++) { const a = k / 96 * 2 * Math.PI; out.push([w / 2 + w / 2 * Math.cos(a), h / 2 + h / 2 * Math.sin(a)]); } return out; }
    if (sh.type === 'polygon' && sh.pts && sh.pts.length >= 3) return filletPoly(sh.pts, +sh.r || 0);
    const rect = [[0, 0], [w, 0], [w, h], [0, h]];
    return sh.type === 'rounded' && sh.r > 0 ? filletPoly(rect, Math.min(+sh.r, w / 2, h / 2), 12) : rect;
  }
  const isRectBoard = (board = Model.S.board) => !board.shape || !board.shape.type || board.shape.type === 'rect';
  function inPoly(x, y, poly) {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) c = !c; }
    return c;
  }
  // signed distance from a shape to the board outline (negative = sticks out of the board)
  function edgeDist(sh, poly) {
    let d = Infinity;
    for (let i = 0; i < poly.length; i++) d = Math.min(d, shapeDist({ k: 'seg', a: poly[i], b: poly[(i + 1) % poly.length], r: 0 }, sh));
    const c = sh.k === 'seg' ? sh.a : sh.k === 'circ' ? sh.c : [sh.cx, sh.cy];
    return inPoly(c[0], c[1], poly) ? d : -d;
  }
  function setBoardShape(o = {}) {
    const S = Model.S, b = S.board;
    const type = o.shape || o.type || 'rect';
    if (!['rect', 'rounded', 'ellipse', 'polygon'].includes(type)) throw new Error('shape must be rect, rounded, ellipse or polygon');
    if (o.width > 0) b.w = +o.width; if (o.height > 0) b.h = +o.height;
    const sh = { type };
    if (type === 'rounded') sh.r = Math.max(0.5, +(o.corner_radius ?? o.r ?? 3));
    if (type === 'polygon') {
      const pts = (o.points || o.pts || []).map(q => [+q[0], +q[1]]);
      if (pts.length < 3) throw new Error('polygon needs at least 3 points');
      const minx = Math.min(...pts.map(q => q[0])), miny = Math.min(...pts.map(q => q[1]));
      if (o.normalize !== false && (minx !== 0 || miny !== 0)) { for (const q of pts) { q[0] -= minx; q[1] -= miny; } for (const c of placed()) { c.pcb.x -= minx; c.pcb.y -= miny; } shiftCopper(-minx, -miny); }
      sh.pts = pts.map(q => [+q[0].toFixed(3), +q[1].toFixed(3)]); sh.r = +(o.corner_radius ?? o.r ?? 0);
      b.w = +Math.max(...sh.pts.map(q => q[0])).toFixed(3); b.h = +Math.max(...sh.pts.map(q => q[1])).toFixed(3);
    }
    b.shape = sh;
    return { board: { w: b.w, h: b.h, shape: sh.type, corner_radius: sh.r }, outside: placed().filter(c => !fpInside(c)).map(c => c.ref) };
  }
  function shiftCopper(dx, dy) {
    const P = Model.S.pcb;
    for (const t of P.traces) t.pts = t.pts.map(q => [q[0] + dx, q[1] + dy]);
    for (const v of P.vias) { v.x += dx; v.y += dy; }
    for (const pr of P.pours || []) if (pr.pts) pr.pts = pr.pts.map(q => [q[0] + dx, q[1] + dy]);
  }
  function fpInside(c) { const b = fpBox(c, -0.1), poly = boardPoly(); return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].every(q => inPoly(q[0], q[1], poly)); }

  // ---------- mounting holes (NPTH) ----------
  function addMountingHoles(o = {}) {
    const S = Model.S; if (!S.board.w) throw new Error('Generate the PCB first');
    const d = +o.diameter || 3.2, inset = +o.inset || Math.max(3.5, d / 2 + 2), poly = boardPoly(), idx = Model.pinIndex();
    const pads = placed().flatMap(c => padsOf(c, idx)), boxes = placed().map(c => fpBox(c, 0.5));
    const keep = o.replace === false ? (S.pcb.holes || []) : [];
    const clearOf = (x, y) => inPoly(x, y, poly) && edgeDist({ k: 'circ', c: [x, y], r: d / 2 }, poly) >= 1.0 &&
      !boxes.some(b => x + d / 2 > b[0] && x - d / 2 < b[2] && y + d / 2 > b[1] && y - d / 2 < b[3]) &&
      !pads.some(p => shapeDist({ k: 'circ', c: [x, y], r: d / 2 }, padShape(p)) < 0.6) &&
      !keep.some(h => Math.hypot(h.x - x, h.y - y) < (h.d + d) / 2 + 2);
    const xs = poly.map(q => q[0]), ys = poly.map(q => q[1]), X0 = Math.min(...xs), X1 = Math.max(...xs), Y0 = Math.min(...ys), Y1 = Math.max(...ys);
    const corners = o.points ? o.points.map(q => [+q[0], +q[1], 0, 0]) : [[X0, Y0, 1, 1], [X1, Y0, -1, 1], [X1, Y1, -1, -1], [X0, Y1, 1, -1]];
    S.pcb.holes = keep.slice();
    const placedH = [], skipped = [];
    for (const [cx, cy, sx, sy] of corners) {
      let ok = null;
      if (!sx && !sy) ok = [cx, cy];
      else for (let k = 0; k <= 24 && !ok; k++) { const t = inset + k * 0.5, x = cx + sx * t, y = cy + sy * t; if (clearOf(x, y)) ok = [x, y]; }
      if (ok) { const h = { x: +ok[0].toFixed(2), y: +ok[1].toFixed(2), d, auto: !o.points }; S.pcb.holes.push(h); placedH.push(h); } else skipped.push([cx, cy]);
    }
    return { holes: placedH, skipped: skipped.length, note: skipped.length ? 'Some corners were too crowded — move parts or give points' : 'Run route_pcb so tracks avoid the holes' };
  }

  // ---------- copper pours ----------
  const pourPoly = pr => pr.whole || !pr.pts ? boardPoly() : pr.pts;
  // ---------- keep-out areas: no tracks / vias / copper pour (and optionally no parts) inside, on one or both layers ----------
  // { name, layer: 'F' | 'B' | 'both', pts: polygon (board mm), tracks, vias, pours, parts }
  const keepouts = () => (Model.S.pcb && Model.S.pcb.keepouts) || [];
  const koOn = (k, layer) => k.layer === 'both' || !k.layer || k.layer === layer;
  // distance from a point to the keep-out (0 inside)
  function koDist(k, x, y) {
    if (inPoly(x, y, k.pts)) return 0;
    let d = Infinity; for (let i = 0; i < k.pts.length; i++) d = Math.min(d, ptSeg([x, y], k.pts[i], k.pts[(i + 1) % k.pts.length]));
    return d;
  }
  const koBox = k => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const [x, y] of k.pts) b = [Math.min(b[0], x), Math.min(b[1], y), Math.max(b[2], x), Math.max(b[3], y)]; return b; };
  function addKeepout(o = {}) {
    const S = Model.S; if (!S.board.w) throw new Error('Generate the PCB first');
    let pts;
    if (Array.isArray(o.points) && o.points.length >= 3) pts = o.points.map(q => [+(+q[0]).toFixed(3), +(+q[1]).toFixed(3)]);
    else if (Array.isArray(o.rect) && o.rect.length === 4) { const [x0, y0, x1, y1] = o.rect.map(Number); pts = [[Math.min(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.min(y0, y1)], [Math.max(x0, x1), Math.max(y0, y1)], [Math.min(x0, x1), Math.max(y0, y1)]]; }
    else if (o.circle) { const c = Array.isArray(o.circle) ? { x: o.circle[0], y: o.circle[1], r: o.circle[2] } : o.circle, n = 32; pts = []; for (let i = 0; i < n; i++) { const a = i / n * 2 * Math.PI; pts.push([+(+c.x + c.r * Math.cos(a)).toFixed(3), +(+c.y + c.r * Math.sin(a)).toFixed(3)]); } }
    else if (o.ref) {   // around a part: its footprint box (+ margin), e.g. the antenna end of a module or a coin-cell holder
      const c = Model.comp(o.ref); if (!c || !c.pcb) throw new Error(`${o.ref} is not on the PCB`);
      const b = fpBox(c, +o.margin || 0); pts = [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]].map(q => q.map(v => +v.toFixed(3)));
    } else throw new Error('Give points (polygon), rect [x0, y0, x1, y1], circle {x, y, r} or ref (board mm)');
    if (pts.some(q => !q.every(isFinite))) throw new Error('Coordinates must be numbers (mm)');
    const L = String(o.layer || 'both').toLowerCase(), layer = /^(b|bot|bottom)$/.test(L) ? 'B' : /^(f|t|top|front)$/.test(L) ? 'F' : 'both';
    const k = { name: String(o.name || 'Keep-out ' + (keepouts().length + 1)).slice(0, 60), layer, pts, tracks: o.tracks !== false, vias: o.vias !== false, pours: o.pours !== false, parts: !!o.parts };
    S.pcb.keepouts = keepouts().concat([k]);
    // what is inside already (the router avoids it from now on; DRC reports it)
    const inside = drc().violations.filter(v => v.type === 'keepout' && v.msg.includes(`"${k.name}"`)).map(v => v.msg).slice(0, 20);
    return { index: S.pcb.keepouts.length - 1, keepout: k, already_inside: inside, note: inside.length ? 'Copper or parts are inside — re-route (route_pcb) or move them' : undefined };
  }
  function removeKeepout(o = {}) {
    const S = Model.S, K = keepouts(), n = K.length;
    S.pcb.keepouts = K.filter((k, i) => !(o.index != null ? i === +o.index : o.name ? k.name === o.name : o.all));
    if (S.pcb.keepouts.length === n) throw new Error('Give index, name or all: true');
    return { removed: n - S.pcb.keepouts.length };
  }

  // Raster of one pour: cells inside the pour and the board, away from other nets' copper. Labels = connected islands.
  // Islands that touch no copper of the pour's net (dead copper) or are smaller than the rule pourMinArea are dropped:
  // label 0 like blocked cells; `dead` keeps their cells so the drawing and the Gerber can clear them.
  const pourMemo = new Map();
  function pourRaster(pr, gStep = 0.2) {
    const S0 = Model.S, key = JSON.stringify([pr, gStep, S0.board, S0.rules, S0.nets[pr.net], S0.pcb.traces, S0.pcb.vias, S0.pcb.holes, S0.pcb.keepouts, placed().map(c => [c.ref, c.footprint, c.pcb.x, c.pcb.y, c.pcb.rot, c.pcb.side])]);
    if (pourMemo.has(key)) return pourMemo.get(key);
    const r = pourRasterI(pr, gStep);
    pourMemo.set(key, r); if (pourMemo.size > 12) pourMemo.delete(pourMemo.keys().next().value);
    return r;
  }
  function pourRasterI(pr, gStep) {
    const S = Model.S, R = rules(), cl = pr.clearance || R.clearance, poly = pourPoly(pr), bpoly = boardPoly(), idx = Model.pinIndex();
    const W = Math.ceil(S.board.w / gStep) + 1, H = Math.ceil(S.board.h / gStep) + 1, N = W * H, ok = new Uint8Array(N);
    const fill = (pl, val) => { for (let y = 0; y < H; y++) { const py = y * gStep, xs = []; for (let i = 0, j = pl.length - 1; i < pl.length; j = i++) { const [xi, yi] = pl[i], [xj, yj] = pl[j]; if ((yi > py) !== (yj > py)) xs.push((xj - xi) * (py - yi) / (yj - yi) + xi); } xs.sort((a, b) => a - b); for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] / gStep)); x <= Math.min(W - 1, Math.floor(xs[k + 1] / gStep)); x++) ok[y * W + x] += val; } };
    fill(poly, 1); fill(bpoly, 1); for (let i = 0; i < N; i++) ok[i] = ok[i] === 2 ? 1 : 0;
    const diskOf = {}, disk = r => { const k = r.toFixed(3); if (diskOf[k]) return diskOf[k]; const n = Math.ceil(r / gStep), o = []; for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * gStep) ** 2 + (dy * gStep) ** 2 < r * r) o.push(dx, dy); return (diskOf[k] = o); };
    const blockSeg = (a, b, r) => { // mark a capsule by stamping disks along it
      const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (gStep / 2))), d = disk(r + gStep * 0.35);
      for (let k = 0; k <= n; k++) { const cx = Math.round((a[0] + (b[0] - a[0]) * k / n) / gStep), cy = Math.round((a[1] + (b[1] - a[1]) * k / n) / gStep); for (let q = 0; q < d.length; q += 2) { const x = cx + d[q], y = cy + d[q + 1]; if (x >= 0 && y >= 0 && x < W && y < H) ok[y * W + x] = 0; } }
    };
    const block = (sh, r) => {
      if (sh.k === 'seg') return blockSeg(sh.a, sh.b, sh.r + r);
      const b = bboxOf(sh), x0 = Math.max(0, Math.floor((b[0] - r) / gStep)), x1 = Math.min(W - 1, Math.ceil((b[2] + r) / gStep)), y0 = Math.max(0, Math.floor((b[1] - r) / gStep)), y1 = Math.min(H - 1, Math.ceil((b[3] + r) / gStep));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const i = y * W + x; if (ok[i] && shapeDist({ k: 'circ', c: [x * gStep, y * gStep], r: 0 }, sh) < r) ok[i] = 0; }
    };
    const L2 = R.layers === 1 ? ['F'] : ['F', 'B'];
    for (const c of placed()) for (const q of padsOf(c, idx)) if (q.net !== pr.net && padCu(q, L2).includes(pr.layer)) block(padShape(q), cl);
    for (const t of S.pcb.traces) if (t.net !== pr.net && t.layer === pr.layer) for (let i = 1; i < t.pts.length; i++) block({ k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, cl);
    for (const v of S.pcb.vias) if (v.net !== pr.net) block({ k: 'circ', c: [v.x, v.y], r: v.d / 2 }, cl);
    for (const h of S.pcb.holes || []) block({ k: 'circ', c: [h.x, h.y], r: h.d / 2 }, cl);
    for (const k of keepouts()) if (k.pours && koOn(k, pr.layer)) {
      const b = koBox(k), x0 = Math.max(0, Math.floor(b[0] / gStep) - 1), x1 = Math.min(W - 1, Math.ceil(b[2] / gStep) + 1), y0 = Math.max(0, Math.floor(b[1] / gStep) - 1), y1 = Math.min(H - 1, Math.ceil(b[3] / gStep) + 1);
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (koDist(k, x * gStep, y * gStep) < gStep * 0.5) ok[y * W + x] = 0;
    }
    // board edge clearance
    for (let i = 0; i < bpoly.length; i++) block({ k: 'seg', a: bpoly[i], b: bpoly[(i + 1) % bpoly.length], r: 0 }, R.edgeClearance);
    // islands: 8-connected, so copper touching only at a corner counts as one piece (nothing is cleared between them)
    const label = new Int32Array(N), size = [0]; let n = 0;
    const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];
    for (let i = 0; i < N; i++) if (ok[i] && !label[i]) {
      n++; const st = [i]; label[i] = n; size[n] = 0;
      while (st.length) { const k = st.pop(), x = k % W, y = (k / W) | 0; size[n]++; for (const [dx, dy] of NB) { const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue; const j = ny * W + nx; if (ok[j] && !label[j]) { label[j] = n; st.push(j); } } }
    }
    // live islands: touched by copper of the pour's own net on this layer (pads, tracks, vias)
    const live = new Uint8Array(n + 1), at0 = (x, y) => { const cx = Math.round(x / gStep), cy = Math.round(y / gStep); return cx < 0 || cy < 0 || cx >= W || cy >= H ? 0 : label[cy * W + cx]; };
    const touch = sh => {
      if (sh.k === 'circ') { for (let a = 0; a < 8; a++) live[at0(sh.c[0] + Math.cos(a * Math.PI / 4) * sh.r * 0.9, sh.c[1] + Math.sin(a * Math.PI / 4) * sh.r * 0.9)] = 1; live[at0(sh.c[0], sh.c[1])] = 1; }
      else if (sh.k === 'rect') { for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) live[at0(sh.cx + a / 2 * sh.hw * 0.95, sh.cy + b / 2 * sh.hh * 0.95)] = 1; }
      else { const m = Math.max(1, Math.ceil(Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1]) / (gStep / 2))); for (let k = 0; k <= m; k++) live[at0(sh.a[0] + (sh.b[0] - sh.a[0]) * k / m, sh.a[1] + (sh.b[1] - sh.a[1]) * k / m)] = 1; }
    };
    for (const c of placed()) for (const q of padsOf(c, idx)) if (q.net === pr.net && padCu(q, L2).includes(pr.layer)) touch(padShape(q));
    for (const t of S.pcb.traces) if (t.net === pr.net && t.layer === pr.layer) for (let i = 1; i < t.pts.length; i++) touch({ k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 });
    for (const v of S.pcb.vias) if (v.net === pr.net) touch({ k: 'circ', c: [v.x, v.y], r: v.d / 2 });
    const minCells = (R.pourMinArea || 0) / (gStep * gStep), drop = new Uint8Array(n + 1), dead = [];
    let kept = 0, deadArea = 0;
    for (let k = 1; k <= n; k++) { if (!live[k] || size[k] < minCells) drop[k] = 1; else kept++; }
    if (kept < n) for (let i = 0; i < N; i++) if (label[i] && drop[label[i]]) { dead.push(i); label[i] = 0; deadArea++; }
    // relabel the kept islands 1…kept
    if (kept < n) { const nl = new Int32Array(n + 1); let m = 0; for (let k = 1; k <= n; k++) if (!drop[k]) nl[k] = ++m; for (let i = 0; i < N; i++) if (label[i]) label[i] = nl[label[i]]; }
    return { W, H, g: gStep, label, islands: kept, dead, removed: n - kept, removedArea: +(deadArea * gStep * gStep).toFixed(2), at: at0 };
  }
  const pourInfo = pr => { try { const r = pourRaster(pr); return { islands: r.islands, removed: r.removed, removed_mm2: r.removedArea }; } catch (e) { return {}; } };
  function pourDeadRects(pr) {
    const r = pourRaster(pr); if (!r.dead.length) return [];
    const h = r.g * 0.95, out = [], set = new Set(r.dead);
    for (const i of r.dead) {
      if (set.has(i - 1) && (i - 1) % r.W !== r.W - 1) continue;   // not the start of a run
      let j = i; while (set.has(j + 1) && (j + 1) % r.W !== 0) j++;
      const y = Math.floor(i / r.W) * r.g, xa = (i % r.W) * r.g, xb = (j % r.W) * r.g;
      out.push([+(xa - h).toFixed(4), +(y - h).toFixed(4), +(xb + h).toFixed(4), +(y + h).toFixed(4)]);
    }
    return out;
  }
  function addPour(o = {}) {
    const S = Model.S; if (!S.board.w) throw new Error('Generate the PCB first');
    const net = o.net || 'GND'; if (!S.nets[net]) throw new Error(`No net "${net}"`);
    const layers = o.layer === 'both' ? ['F', 'B'] : [o.layer === 'B' || o.layer === 'bottom' ? 'B' : 'F'];
    S.pcb.pours = S.pcb.pours || [];
    const added = [];
    for (const layer of layers) {
      const pr = { net, layer };
      if (o.points && o.points.length >= 3) pr.pts = o.points.map(q => [+q[0], +q[1]]); else pr.whole = true;
      if (o.clearance > 0) pr.clearance = +o.clearance;
      S.pcb.pours.push(pr); added.push(S.pcb.pours.length - 1);
    }
    const info = added.map(i => Object.assign({ index: i, layer: S.pcb.pours[i].layer === 'B' ? 'bottom' : 'top' }, pourInfo(S.pcb.pours[i])));
    return { added, pours: S.pcb.pours.length, islands: info, note: info.some(q => q.removed) ? 'Pieces of copper that touch no ' + net + ' copper, or are smaller than the rule pourMinArea, were removed (dead copper)' : undefined };
  }

  const placed = () => Model.S.components.filter(c => c.pcb && Lib.footprint(c.footprint));

  // ---------- auto placement ----------
  // Connectors go on the board edge. Parts with an opening (USB, jacks, RF, card slots) face outward, flush with the edge.
  const PLUG_RE = /USB|TYPE-?C|MICRO-?B|MINI-?B|JACK|BARREL|DC-?0\d|RJ-?45|RJ-?11|SMA\b|U\.FL|IPEX|SD-?CARD|MICRO-?SD|TF-?CARD|SIM/i;
  const CONN_RE = /CONN|HEADER|TERMINAL|SCREW|PINHEADER|JST|XH-|PH-|MOLEX|WAGO/i;
  function edgeInfo(c) {
    const lib = c.lcsc && Model.S.lib && Model.S.lib[c.lcsc];
    const text = [c.value, c.footprint, lib && lib.name, lib && lib.package, lib && lib.footprint && lib.footprint.name].filter(Boolean).join(' ');
    // chips whose names mention USB etc. (USBLC6 ESD arrays, CH340 USB-UART, …) are not connectors
    const chip = /\b(SOT|SOD|SOIC|SOP|SSOP|TSSOP|MSOP|QFN|DFN|QFP|LQFP|TQFP|BGA|WLCSP|SC-?70|SC-?88|UDFN)[-_\d]|USBLC|CH3[34]\d|CP210|FT232|ESD|TVS/i.test(text);
    // a pin header / socket footprint is a header whatever its value says ("USB_CON" on a 1x04 header is not a USB socket)
    const header = /pin ?header|pin ?socket|pinhdr|\bhdr|\b[12]x\d{1,2}\b/i.test([c.footprint, lib && lib.footprint && lib.footprint.name, lib && lib.package].filter(Boolean).join(' '));
    const plug = !chip && !header && PLUG_RE.test(text);
    if (chip && c.type !== 'connector' && !/^(J|CN|P)\d+$/i.test(c.ref)) return null;
    if (!plug && !(c.type === 'connector' || CONN_RE.test(text) || /^(J|CN|USB|P)\d+$/i.test(c.ref))) return null;
    let front = null;
    if (plug) {
      // the contacts (SMD row, or all pads) sit at the back; the body/opening extends toward the front
      const fp = Lib.footprint(c.footprint), smd = fp.pads.filter(q => !q.drill), use = smd.length ? smd : fp.pads;
      const px = use.reduce((t, q) => t + q.x, 0) / use.length, py = use.reduce((t, q) => t + q.y, 0) / use.length;
      const vx = (fp.box[0] + fp.box[2]) / 2 - px, vy = (fp.box[1] + fp.box[3]) / 2 - py;
      front = Math.abs(vx) > Math.abs(vy) ? [Math.sign(vx) || 1, 0] : [0, Math.sign(vy) || 1];
      if (isBottom(c)) front[0] = -front[0];
    }
    return { plug, front };
  }
  const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] };
  // how far an edge part sits in from the edge: plugs flush (their opening overhangs on purpose); headers etc. flush too,
  // moved in only as much as their copper needs for the edge-clearance rule
  function edgeInset(c, side, plug) {
    if (plug) return 0;
    const b = fpBox(c), pads = padsOf(c); if (!pads.length) return 0;
    const gap = side === 'left' ? Math.min(...pads.map(p => p.x - p.w / 2)) - b[0] : side === 'right' ? b[2] - Math.max(...pads.map(p => p.x + p.w / 2))
      : side === 'top' ? Math.min(...pads.map(p => p.y - p.h / 2)) - b[1] : b[3] - Math.max(...pads.map(p => p.y + p.h / 2));
    return Math.max(0, rules().edgeClearance + 0.1 - gap);
  }
  // rotation that makes the connector face the given edge (plugs: opening outward; headers: long side along the edge)
  function edgeRot(c, side, info) {
    if (info.front) {
      for (const r of [0, 90, 180, 270]) { const [x, y] = Lib.rot(info.front[0], info.front[1], r); if (Math.round(x) === NORMAL[side][0] && Math.round(y) === NORMAL[side][1]) return r; }
    }
    const b = Lib.footprint(c.footprint).box, wide = (b[2] - b[0]) >= (b[3] - b[1]), horiz = side === 'top' || side === 'bottom';
    return wide === horiz ? 0 : 90;
  }
  function separate(cs, gap, lock = new Map(), maxIt = 500) {
    const half = c => { const b = fpBox(c), x = c.pcb.x, y = c.pcb.y; return [(b[2] - b[0]) / 2, (b[3] - b[1]) / 2, (b[0] + b[2]) / 2 - x, (b[1] + b[3]) / 2 - y]; };
    for (let it = 0; it < maxIt; it++) {
      let moved = false;
      for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) {
        const a = cs[i], b = cs[j], ha = half(a), hb = half(b);
        const dx = (b.pcb.x + hb[2]) - (a.pcb.x + ha[2]), dy = (b.pcb.y + hb[3]) - (a.pcb.y + ha[3]);
        const ox = ha[0] + hb[0] + gap - Math.abs(dx), oy = ha[1] + hb[1] + gap - Math.abs(dy);
        if (ox <= 0 || oy <= 0) continue;
        const la = lock.get(a) || '', lb = lock.get(b) || '';
        let axis = ox < oy ? 'x' : 'y';
        if (la.includes(axis) && lb.includes(axis)) axis = axis === 'x' ? 'y' : 'x';
        if (la.includes(axis) && lb.includes(axis)) continue;
        const ov = axis === 'x' ? ox : oy, sg = (axis === 'x' ? dx : dy) >= 0 ? 1 : -1;
        const ka = la.includes(axis) ? 0 : lb.includes(axis) ? 1 : 0.5, kb = lb.includes(axis) ? 0 : la.includes(axis) ? 1 : 0.5;
        a.pcb[axis] -= sg * ov * ka; b.pcb[axis] += sg * ov * kb; moved = true;
      }
      if (!moved) break;
    }
  }
  const unionBox = list => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const c of list) { const a = fpBox(c); b = [Math.min(b[0], a[0]), Math.min(b[1], a[1]), Math.max(b[2], a[2]), Math.max(b[3], a[3])]; } return b; };

  // Auto-place. With an existing board (or a given size) the outline is kept and parts are fitted inside it;
  // the board is only sized to the parts when there is none yet, or when opt.fit (auto-size) is set.
  function autoPlace(opt = {}) {
    const S = Model.S;
    const given = +opt.w > 0 && +opt.h > 0;
    if (opt.fit || (!given && !(S.board.w > 0))) return opt.compact === false ? autoSize(opt) : compactPlace(opt);
    if (given && (Math.abs(+opt.w - S.board.w) > 1e-6 || Math.abs(+opt.h - S.board.h) > 1e-6)) {
      // the user typed a new size: scale a custom outline with it, keep the shape type
      const sx = S.board.w ? +opt.w / S.board.w : 1, sy = S.board.h ? +opt.h / S.board.h : 1;
      if (S.board.shape && S.board.shape.pts) S.board.shape.pts = S.board.shape.pts.map(q => [+(q[0] * sx).toFixed(3), +(q[1] * sy).toFixed(3)]);
      S.board.w = +opt.w; S.board.h = +opt.h;
    }
    return fitInside(opt);
  }

  function fitInside(opt = {}) {
    const S = Model.S, cs = S.components.filter(c => Lib.footprint(c.footprint));
    if (!cs.length) throw new Error('No components with footprints to place');
    const R = rules(), W = S.board.w, H = S.board.h, poly = boardPoly();
    const margin = Math.max(R.edgeClearance + 0.4, 0.8), cx0 = W / 2, cy0 = H / 2;
    for (const c of cs) { const side = c.pcb && c.pcb.side; c.pcb = { x: 0, y: 0, rot: c.rot || 0 }; if (side === 'B') c.pcb.side = 'B'; }
    // 1) keep the schematic arrangement, scaled to fit the board
    const xs = cs.map(c => c.x), ys = cs.map(c => c.y), sxm = (Math.min(...xs) + Math.max(...xs)) / 2, sym = (Math.min(...ys) + Math.max(...ys)) / 2;
    const spanX = Math.max(1, Math.max(...xs) - Math.min(...xs)), spanY = Math.max(1, Math.max(...ys) - Math.min(...ys));
    const k = Math.min(0.12, (W - 2 * margin) * 0.7 / spanX, (H - 2 * margin) * 0.7 / spanY);
    for (const c of cs) { c.pcb.x = cx0 + (c.x - sxm) * k; c.pcb.y = cy0 + (c.y - sym) * k; }
    // 2) connectors on the board edges (plugs flush, headers just inside), slid inward on curved outlines
    const edgeParts = [], lock = new Map();
    for (const c of cs) {
      const info = edgeInfo(c); if (!info && !c.pcbEdge) continue;
      const fb = fpBox(c), px = (fb[0] + fb[2]) / 2, py = (fb[1] + fb[3]) / 2;
      const side = c.pcbEdge || [['left', px], ['right', W - px], ['top', py], ['bottom', H - py]].sort((a, b) => a[1] - b[1])[0][0];
      c.pcb.rot = edgeRot(c, side, info || { front: null });
      const plug = !!(info && info.plug), inset = edgeInset(c, side, plug), b = fpBox(c);
      if (side === 'left') c.pcb.x += inset - b[0]; if (side === 'right') c.pcb.x += W - inset - b[2];
      if (side === 'top') c.pcb.y += inset - b[1]; if (side === 'bottom') c.pcb.y += H - inset - b[3];
      const n = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] }[side];
      for (let t = 0; t < 80 && !boxInside(c, poly, -0.05); t++) { c.pcb.x += n[0] * 0.25; c.pcb.y += n[1] * 0.25; }
      edgeParts.push({ c, side, plug }); lock.set(c, side === 'left' || side === 'right' ? 'x' : 'y');
    }
    const free = cs.filter(c => !lock.has(c));
    // 2b) arrange for routability: anneal on wire length with fan-out room around each part, then legalise around it
    // several annealing runs from the same start (different seeds); the lowest-cost arrangement wins
    if (opt.anneal !== false) {
      const fx = new Set(edgeParts.map(e => e.c.ref)), tries = Math.max(1, opt.tries ?? 3), base = cs.map(c => JSON.parse(JSON.stringify(c.pcb)));
      let bestS = null, bestC = Infinity;
      for (let k = 0; k < tries; k++) {
        cs.forEach((c, i) => { c.pcb = JSON.parse(JSON.stringify(base[i])); });
        const r = anneal({ time_s: opt.anneal_s ?? 2, seed: (opt.seed ?? 7) + k * 7919, fixed: fx, compact: opt.compact || 0 });
        const cst = r.cost_after ?? r.cost ?? 0;
        if (cst < bestC) { bestC = cst; bestS = cs.map(c => JSON.parse(JSON.stringify(c.pcb))); }
      }
      if (bestS) cs.forEach((c, i) => { c.pcb = bestS[i]; });
    }
    // 3) legalise: place parts one by one (connectors first, then biggest first) at the nearest free spot
    //    to where the schematic wants them — spiral search, inside the outline, no overlaps.
    const want = new Map(cs.map(c => [c, { x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot }]));
    const areaOf = c => { const q = fpBox(c); return (q[2] - q[0]) * (q[3] - q[1]); };
    const hit = (c, placed, gap) => { const q = fpBox(c, gap / 2); return placed.some(o => { const r = fpBox(o, gap / 2); return q[0] < r[2] && r[0] < q[2] && q[1] < r[3] && r[1] < q[3]; }); };
    const okAt = (c, placed, gap, inset) => boxInside(c, poly, inset) && !hit(c, placed, gap);
    function legalise(gap) {
      const placed = [], failed = [];
      // connectors: keep their edge, slide along it to the nearest free spot
      for (const e of edgeParts) {
        const c = e.c, w = want.get(c), base = { x: c.pcb.x, y: c.pcb.y }, along = e.side === 'left' || e.side === 'right' ? [0, 1] : [1, 0];
        let done = false;
        for (let k = 0; k <= 400 && !done; k++) for (const sgn of k ? [1, -1] : [1]) {
          c.pcb.x = base.x + along[0] * sgn * k * 0.25; c.pcb.y = base.y + along[1] * sgn * k * 0.25;
          if (okAt(c, placed, gap, -0.05)) { done = true; break; }
        }
        if (!done) { c.pcb.x = base.x; c.pcb.y = base.y; failed.push(c.ref); }
        placed.push(c);
      }
      // everything else: biggest first, nearest free position (both orientations), spiral outward
      const rest = free.slice().sort((p, q) => areaOf(q) - areaOf(p));
      const step = 0.5, maxR = Math.hypot(W, H);
      for (const c of rest) {
        const w = want.get(c); let best = null;
        for (const rot of [w.rot, (w.rot + 90) % 360]) {
          c.pcb.rot = rot;
          for (let r = 0; r <= maxR && !best; r += step) {
            const n = r === 0 ? 1 : Math.max(8, Math.ceil(2 * Math.PI * r / step));
            for (let i = 0; i < n; i++) {
              const t = i / n * 2 * Math.PI;
              c.pcb.x = w.x + r * Math.cos(t); c.pcb.y = w.y + r * Math.sin(t);
              if (okAt(c, placed, gap, margin)) { best = { x: c.pcb.x, y: c.pcb.y, rot, r }; break; }
            }
          }
          if (best && rot === w.rot && best.r < 2) break;   // close to its spot already: keep its orientation
          if (best && rot !== w.rot) break;
        }
        if (best) { c.pcb.x = best.x; c.pcb.y = best.y; c.pcb.rot = best.rot; }
        else { c.pcb.x = w.x; c.pcb.y = w.y; c.pcb.rot = w.rot; failed.push(c.ref); }
        placed.push(c);
      }
      return failed;
    }
    let failed = [];
    for (const gap of [1.0, 0.6, 0.3]) { failed = legalise(gap); if (!failed.length) break; }
    // put every edge connector back flush with its edge after the search
    for (const e of edgeParts) {
      const q = fpBox(e.c), ins = edgeInset(e.c, e.side, e.plug);
      if (e.side === 'left') e.c.pcb.x += ins - q[0]; if (e.side === 'right') e.c.pcb.x += W - ins - q[2];
      if (e.side === 'top') e.c.pcb.y += ins - q[1]; if (e.side === 'bottom') e.c.pcb.y += H - ins - q[3];
      const n = { left: [1, 0], right: [-1, 0], top: [0, 1], bottom: [0, -1] }[e.side];
      for (let t = 0; t < 80 && !boxInside(e.c, poly, -0.05); t++) { e.c.pcb.x += n[0] * 0.25; e.c.pcb.y += n[1] * 0.25; }
    }
    for (const c of cs) { c.pcb.x = +(Math.round(c.pcb.x / 0.05) * 0.05).toFixed(3); c.pcb.y = +(Math.round(c.pcb.y / 0.05) * 0.05).toFixed(3); }
    const area = cs.reduce((a, c) => { const b = fpBox(c); return a + (b[2] - b[0]) * (b[3] - b[1]); }, 0);
    let boardArea = 0; for (let i = 0; i < poly.length; i++) { const p = poly[i], q = poly[(i + 1) % poly.length]; boardArea += p[0] * q[1] - q[0] * p[1]; } boardArea = Math.abs(boardArea / 2);
    const hadHoles = (S.pcb.holes || []).filter(h => h.auto), holeD = hadHoles.length ? hadHoles[0].d : 0;
    S.pcb = Object.assign({}, S.pcb, { traces: [], vias: [], routed: {}, pours: (S.pcb.pours || []).filter(pr => pr.whole), holes: [] });
    if (holeD) addMountingHoles({ diameter: holeD });
    const still = overlaps(cs, -0.1).map(([a, b]) => `${a.ref}/${b.ref}`), outside = cs.filter(c => !boxInside(c, poly, -0.1)).map(c => c.ref);
    const res = { board: S.board, kept_board: true, placed: cs.length, fits: !still.length && !outside.length, parts_area_pct: Math.round(area / boardArea * 100), on_edge: edgeParts.map(e => `${e.c.ref}:${e.side}${e.plug ? ' (opening outward)' : ''}`) };
    if (!res.fits) { res.overlapping = still; res.outside = outside; res.hint = `The parts need about ${Math.round(area / boardArea * 100)}% of the board area — enlarge the board (Board W×H, or clear it for auto-size), move parts to the bottom side, or use smaller packages.`; }
    return res;
  }
  function boxInside(c, poly, inset) {
    const b = fpBox(c, inset);
    if (!isRectBoard()) return [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]], [(b[0] + b[2]) / 2, b[1]], [(b[0] + b[2]) / 2, b[3]], [b[0], (b[1] + b[3]) / 2], [b[2], (b[1] + b[3]) / 2]].every(q => inPoly(q[0], q[1], poly));
    return b[0] >= -1e-6 && b[1] >= -1e-6 && b[2] <= Model.S.board.w + 1e-6 && b[3] <= Model.S.board.h + 1e-6;
  }
  function clampInside(c, poly, m, W, H) {
    const b = fpBox(c);
    if (b[0] < m) c.pcb.x += m - b[0]; if (b[1] < m) c.pcb.y += m - b[1];
    const b2 = fpBox(c);
    if (b2[2] > W - m) c.pcb.x -= b2[2] - (W - m); if (b2[3] > H - m) c.pcb.y -= b2[3] - (H - m);
    if (!isRectBoard()) for (let t = 0; t < 60 && !boxInside(c, poly, m); t++) { const dx = W / 2 - c.pcb.x, dy = H / 2 - c.pcb.y, l = Math.hypot(dx, dy) || 1; c.pcb.x += dx / l * 0.3; c.pcb.y += dy / l * 0.3; }
  }
  function clampAlong(e, W, H) { // edge parts may slide along their edge but stay on the board
    const b = fpBox(e.c);
    if (e.side === 'left' || e.side === 'right') { if (b[1] < 0.8) e.c.pcb.y += 0.8 - b[1]; else if (b[3] > H - 0.8) e.c.pcb.y -= b[3] - (H - 0.8); }
    else { if (b[0] < 0.8) e.c.pcb.x += 0.8 - b[0]; else if (b[2] > W - 0.8) e.c.pcb.x -= b[2] - (W - 0.8); }
  }
  // Put parts on free board space (no overlap with other parts, holes or part keep-outs, inside the outline), as close as
  // possible to `near` (a ref or [x, y]; default: the parts they connect to). group: the parts keep their layout and move
  // together; otherwise each goes to its own nearest free spot (trying the four rotations). Returns the moves.
  function placeFree(refs, o = {}) {
    const S = Model.S, R = rules(); if (!S.board.w) throw new Error('No PCB yet — generate_pcb first');
    const cs = (refs || []).map(r => { const c = Model.comp(r); if (!c) throw new Error(`No component ${r}`); return c; });
    if (!cs.length) throw new Error('refs is empty');
    for (const c of cs) if (!c.pcb) c.pcb = { x: S.board.w / 2, y: S.board.h / 2, rot: 0, side: o.side === 'bottom' ? 'B' : 'F' };
    const own = new Set(cs.map(c => c.ref)), gap = o.gap != null ? +o.gap : 0.5, margin = Math.max(R.edgeClearance + 0.2, 0.5), poly = boardPoly();
    const fixed = placed().filter(c => !own.has(c.ref)).map(c => ({ b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) }));
    const holes = (S.pcb.holes || []).map(h => [h.x - h.d / 2 - gap, h.y - h.d / 2 - gap, h.x + h.d / 2 + gap, h.y + h.d / 2 + gap]);
    const kos = keepouts().filter(k => k.parts);
    const hitBox = (a, b) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];
    // SMD parts on opposite sides may overlap; through-hole parts block both sides
    const free = c => {
      if (!boxInside(c, poly, margin)) return false;
      const b = fpBox(c, gap / 2), side = isBottom(c) ? 'B' : 'F', th = thBoxes(c, gap);
      if (fixed.some(f => f.side === side ? hitBox(b, f.b) : (f.th.some(t => hitBox(t, b)) || th.some(t => hitBox(t, f.b))))) return false;
      if (holes.some(h => hitBox(b, h))) return false;
      for (const k of kos) if (koOn(k, side) && ([...Array(25)].some((_, q) => inPoly(b[0] + (b[2] - b[0]) * (q % 5) / 4, b[1] + (b[3] - b[1]) * Math.floor(q / 5) / 4, k.pts)) || k.pts.some(([x, y]) => x > b[0] && x < b[2] && y > b[1] && y < b[3]))) return false;
      return true;
    };
    // target point
    let T = null;
    if (Array.isArray(o.near)) T = [+o.near[0], +o.near[1]];
    else if (o.near) { const n = Model.comp(o.near); if (!n || !n.pcb) throw new Error(`${o.near} is not on the PCB`); T = [n.pcb.x, n.pcb.y]; }
    else {
      const idx = Model.pinIndex(), nets = new Set(); for (const c of cs) for (const p of padsOf(c, idx)) if (p.net && !Model.isPower(p.net)) nets.add(p.net);
      const pts = []; for (const c of placed()) if (!own.has(c.ref)) for (const p of padsOf(c, idx)) if (nets.has(p.net)) pts.push([p.x, p.y]);
      T = pts.length ? [pts.reduce((a, q) => a + q[0], 0) / pts.length, pts.reduce((a, q) => a + q[1], 0) / pts.length] : [S.board.w / 2, S.board.h / 2];
    }
    const step = +o.step || 0.25, cand = [];
    for (let y = 0; y <= S.board.h; y += step) for (let x = 0; x <= S.board.w; x += step) cand.push([x, y, Math.hypot(x - T[0], y - T[1])]);
    cand.sort((a, b) => a[2] - b[2]);
    const moves = [];
    if (o.group) {
      const b0 = cs.map(c => fpBox(c)).reduce((a, b) => [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.max(a[2], b[2]), Math.max(a[3], b[3])]);
      const cx = (b0[0] + b0[2]) / 2, cy = (b0[1] + b0[3]) / 2, start = cs.map(c => [c, c.pcb.x, c.pcb.y]);
      for (const [x, y] of cand) {
        const dx = x - cx, dy = y - cy;
        for (const [c, x0, y0] of start) { c.pcb.x = +(x0 + dx).toFixed(3); c.pcb.y = +(y0 + dy).toFixed(3); }
        if (cs.every(free)) return { placed: cs.map(c => ({ ref: c.ref, x: c.pcb.x, y: c.pcb.y })), dx: +dx.toFixed(3), dy: +dy.toFixed(3) };
      }
      for (const [c, x0, y0] of start) { c.pcb.x = x0; c.pcb.y = y0; }
      throw new Error('No free area on the board is big enough for these parts together — grow the board (set_board_shape) or place them one by one');
    }
    const failed = [];
    for (const c of cs) {
      const x0 = c.pcb.x, y0 = c.pcb.y, r0 = c.pcb.rot || 0, rots = o.rotate === false ? [r0] : [r0, ...[0, 90, 180, 270].filter(r => r !== r0)];
      let ok = false;
      for (const [x, y] of cand) { for (const r of rots) { c.pcb.x = +x.toFixed(3); c.pcb.y = +y.toFixed(3); c.pcb.rot = r; if (free(c)) { ok = true; break; } } if (ok) break; }
      if (!ok) { c.pcb.x = x0; c.pcb.y = y0; c.pcb.rot = r0; failed.push(c.ref); continue; }
      fixed.push({ b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) });   // the next part avoids this one
      moves.push({ ref: c.ref, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot });
    }
    return { placed: moves, failed: failed.length ? failed : undefined, note: failed.length ? 'No free spot for these — grow the board or make room' : 'Tracks to the moved parts need routing: route_pcb' };
  }
  // what a part blocks on the other side of the board: only its through-hole pins (pad box + gap), not its body
  const thBoxes = (c, gap = 0) => padsOf(c).filter(p => p.drill).map(p => [p.x - p.w / 2 - gap / 2, p.y - p.h / 2 - gap / 2, p.x + p.w / 2 + gap / 2, p.y + p.h / 2 + gap / 2]);
  // Fast placement check (no routing): parts overlapping (SMD parts on opposite sides may), outside the outline, in a
  // part keep-out, on a mounting hole. refs: only problems that involve these parts.
  // tol: overlaps of the footprint boxes smaller than this (mm, in either direction) are ignored — boxes include margins
  function checkPlacement(refs, gap = 0, tol = 0.25) {
    const S = Model.S, cs = placed(), only = refs && refs.length ? new Set(refs) : null, poly = boardPoly(), out = [];
    const info = cs.map(c => ({ c, b: fpBox(c, gap / 2), side: isBottom(c) ? 'B' : 'F', th: thBoxes(c, gap) }));
    const hit = (a, b) => Math.min(a[2], b[2]) - Math.max(a[0], b[0]) > tol && Math.min(a[3], b[3]) - Math.max(a[1], b[1]) > tol;
    for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
      const A = info[i], B = info[j]; if (only && !only.has(A.c.ref) && !only.has(B.c.ref)) continue;
      if (A.side === B.side ? hit(A.b, B.b) : (A.th.some(t => hit(t, B.b)) || B.th.some(t => hit(t, A.b))))
        out.push({ type: 'overlap', parts: [A.c.ref, B.c.ref], msg: `${A.c.ref} overlaps ${B.c.ref}${A.side !== B.side ? ' (through-hole pins on the other side)' : ''}` });
    }
    for (const A of info) {
      if (only && !only.has(A.c.ref)) continue;
      if (!boxInside(A.c, poly, 0)) out.push({ type: 'outside', parts: [A.c.ref], msg: `${A.c.ref} is (partly) outside the board outline` });
      for (const k of keepouts()) if (k.parts && koOn(k, A.side) && ([...Array(25)].some((_, q) => inPoly(A.b[0] + (A.b[2] - A.b[0]) * (q % 5) / 4, A.b[1] + (A.b[3] - A.b[1]) * Math.floor(q / 5) / 4, k.pts)) || k.pts.some(([x, y]) => x > A.b[0] && x < A.b[2] && y > A.b[1] && y < A.b[3])))
        out.push({ type: 'keepout', parts: [A.c.ref], msg: `${A.c.ref} is inside keep-out "${k.name}"` });
      for (const h of S.pcb.holes || []) if (hit(A.b, [h.x - h.d / 2, h.y - h.d / 2, h.x + h.d / 2, h.y + h.d / 2])) out.push({ type: 'hole', parts: [A.c.ref], msg: `${A.c.ref} covers a mounting hole at (${h.x}, ${h.y})` });
    }
    return out;
  }
  const legalCheck = refs => { const r = checkPlacement(refs); return r.length ? r.map(q => q.msg) : undefined; };
  function overlaps(cs, gap) {
    const out = [], B = cs.map(c => fpBox(c, gap / 2));
    for (let i = 0; i < cs.length; i++) for (let j = i + 1; j < cs.length; j++) { const a = B[i], b = B[j]; if (a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3]) out.push([cs[i], cs[j]]); }
    return out;
  }

  // board sized to the parts (first placement, or auto-size requested)
  // Board sized to the parts, minimum area: start roomy, arrange (several annealing runs pulling connected parts together,
  // big ICs to the centre, connectors on edges), then shrink width and height step by step while the placement stays
  // legal (no overlaps, fan-out room kept, everything on the board).
  function compactPlace(opt = {}) {
    const S = Model.S, t0 = Date.now(), clone = o => JSON.parse(JSON.stringify(o)), limit = (opt.time_s ?? 30) * 1000;
    autoSize(opt);
    const rect = !S.board.shape || !S.board.shape.type || S.board.shape.type === 'rect' || S.board.shape.type === 'rounded';
    const scaleXY = (fx, fy) => {
      const cx = S.board.w / 2, cy = S.board.h / 2;
      for (const c of placed()) { c.pcb.x = cx * fx + (c.pcb.x - cx) * fx; c.pcb.y = cy * fy + (c.pcb.y - cy) * fy; }
      S.board.w = +(S.board.w * fx).toFixed(2); S.board.h = +(S.board.h * fy).toFixed(2);
      if (S.board.shape && S.board.shape.pts) S.board.shape.pts = S.board.shape.pts.map(q => [+(q[0] * fx).toFixed(3), +(q[1] * fy).toFixed(3)]);
    };
    const legal = () => !overlaps(placed(), 0.35).length && placed().every(c => boxInside(c, boardPoly(), -0.05));
    const snap = () => ({ board: clone(S.board), place: placed().map(c => [c.ref, clone(c.pcb)]) });
    const restore = s => { S.board = clone(s.board); for (const [ref, q] of s.place) { const c = Model.comp(ref); if (c) c.pcb = clone(q); } };
    // For three board shapes (natural aspect, square, turned 90° — the shape decides which edges the connectors get),
    // binary-search the smallest board on which the full packer (connectors on edges, annealing, spiral legalising)
    // still places everything legally; keep the smallest result.
    const W0 = S.board.w, H0 = S.board.h, A0 = W0 * H0;
    const partsArea = placed().reduce((a, c) => { const q = fpBox(c); return a + (q[2] - q[0]) * (q[3] - q[1]); }, 0);
    const ratios = rect ? [W0 / H0, 1, H0 / W0] : [W0 / H0];
    let winner = null, steps = 0;
    ratios.forEach((r, vi) => {
      const tEnd = t0 + limit * (vi + 1) / ratios.length;
      const sizeFor = area => [Math.sqrt(area * r), Math.sqrt(area / r)];
      const tryArea = area => {
        const [w, h] = sizeFor(area);
        S.board.w = +w.toFixed(1); S.board.h = +h.toFixed(1);
        fitInside(Object.assign({}, opt, { tries: 2, compact: 0.6, anneal_s: 0.5, seed: 11 + vi * 101 + steps }));
        legalisePlacement(0.4); steps++;
        return legal() ? snap() : null;
      };
      // upper bound: grow until it packs; lower bound: the parts themselves (+20 %)
      let hiA = Math.max(A0, partsArea * 2.2), best = null;
      for (let g = 0; g < 4 && !best && Date.now() < tEnd; g++) { best = tryArea(hiA); if (!best) hiA *= 1.4; }
      if (!best) return;
      let loA = partsArea * 1.2;
      while (hiA / loA > 1.06 && Date.now() < tEnd) {
        const mid = Math.sqrt(loA * hiA), s = tryArea(mid);
        if (s) { best = s; hiA = mid; } else loA = mid;
      }
      restore(best);
      const b = unionBox(placed()), area = (b[2] - b[0]) * (b[3] - b[1]);
      if (!winner || area < winner.area) winner = { area, s: best };
    });
    if (winner) restore(winner.s);
    // trim a rectangular board to the parts (+ edge margin), keeping connectors flush with their edges
    if (rect && winner) {
      const R = rules(), m = Math.max(1, R.edgeClearance + 0.7), b = unionBox(placed()), pre = snap();
      const x0 = Math.max(0, b[0] - m), y0 = Math.max(0, b[1] - m), x1 = Math.min(S.board.w, b[2] + m), y1 = Math.min(S.board.h, b[3] + m);
      for (const c of placed()) { c.pcb.x -= x0; c.pcb.y -= y0; }
      S.board.w = +(x1 - x0).toFixed(1); S.board.h = +(y1 - y0).toFixed(1);
      legalisePlacement(0.4);
      if (!legal()) restore(pre);   // trimming must never break the placement
    }
    const hadHoles = (S.pcb.holes || []).filter(h => h.auto), holeD = hadHoles.length ? hadHoles[0].d : 0;
    S.pcb = Object.assign({}, S.pcb, { traces: [], vias: [], routed: {}, pours: (S.pcb.pours || []).filter(pr => pr.whole), holes: [] });
    if (holeD) addMountingHoles({ diameter: holeD });
    const cs = placed(), still = overlaps(cs, 0).map(([a, b]) => `${a.ref}/${b.ref}`), outside = cs.filter(c => !boxInside(c, boardPoly(), 0)).map(c => c.ref);
    return { board: S.board, placed: cs.length, compacted: steps, fits: !still.length && !outside.length, overlapping: still.length ? still : undefined, outside: outside.length ? outside : undefined, seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  }
  function autoSize(opt = {}) {
    const S = Model.S, cs = S.components.filter(c => Lib.footprint(c.footprint));
    if (!cs.length) throw new Error('No components with footprints to place');
    const k = 0.085, gap = 1.0, m = opt.margin ?? 3;
    for (const c of cs) { const side = c.pcb && c.pcb.side; c.pcb = { x: c.x * k, y: c.y * k, rot: c.rot || 0 }; if (side === 'B') c.pcb.side = 'B'; }
    separate(cs, gap);
    // connectors → nearest edge (or the edge chosen earlier with place_footprint)
    const cb = unionBox(cs), cx = (cb[0] + cb[2]) / 2, cy = (cb[1] + cb[3]) / 2;
    const edgeParts = [], lock = new Map(), sideOf = new Map();
    for (const c of cs) {
      const info = edgeInfo(c); if (!info && !c.pcbEdge) continue;
      const fb = fpBox(c), px = (fb[0] + fb[2]) / 2, py = (fb[1] + fb[3]) / 2;
      const side = c.pcbEdge || [['left', px - cb[0]], ['right', cb[2] - px], ['top', py - cb[1]], ['bottom', cb[3] - py]].sort((a, b) => a[1] - b[1])[0][0];
      c.pcb.rot = edgeRot(c, side, info || { front: null });
      const b2 = fpBox(c);
      if (side === 'left') c.pcb.x += cb[0] - b2[0]; if (side === 'right') c.pcb.x += cb[2] - b2[2];
      if (side === 'top') c.pcb.y += cb[1] - b2[1]; if (side === 'bottom') c.pcb.y += cb[3] - b2[3];
      edgeParts.push({ c, side, plug: !!(info && info.plug) }); sideOf.set(c, side);
      lock.set(c, side === 'left' || side === 'right' ? 'x' : 'y');
    }
    separate(cs, gap, lock);
    // board outline: flush with plug openings, a little margin behind headers, normal margin elsewhere
    const others = cs.filter(c => !sideOf.has(c)), ob = others.length ? unionBox(others) : unionBox(cs), all = unionBox(cs);
    const bound = { left: all[0] - m, right: all[2] + m, top: all[1] - m, bottom: all[3] + m };
    for (const side of ['left', 'right', 'top', 'bottom']) {
      const here = edgeParts.filter(e => e.side === side); if (!here.length) continue;
      const out = side === 'left' || side === 'top' ? -1 : 1, idx = { left: 0, top: 1, right: 2, bottom: 3 }[side];
      const ext = v => out < 0 ? Math.min(...v) : Math.max(...v);
      const plugs = here.filter(e => e.plug), heads = here.filter(e => !e.plug);
      let edge = ext(here.map(e => fpBox(e.c)[idx]).concat(others.length ? [ob[idx] + out * 1.5] : []));
      if (!plugs.length) edge += out * 1.5;
      bound[side] = edge;
      // plugs flush with the edge, headers 1.5 mm in
      for (const e of plugs) { const d = edge - fpBox(e.c)[idx]; if (side === 'left' || side === 'right') e.c.pcb.x += d; else e.c.pcb.y += d; }
      for (const e of heads) { const d = edge - out * 1.5 - fpBox(e.c)[idx]; if (side === 'left' || side === 'right') e.c.pcb.x += d; else e.c.pcb.y += d; }
    }
    let W = bound.right - bound.left, H = bound.bottom - bound.top, ox = -bound.left, oy = -bound.top;
    if (opt.w && opt.h && opt.w >= W && opt.h >= H) {
      // a fixed board size: keep the edge parts on their edges, centre the rest
      const ex = opt.w - W, ey = opt.h - H;
      for (const c of cs) { const sd = sideOf.get(c); c.pcb.x += sd === 'right' ? ex : sd === 'left' ? 0 : ex / 2; c.pcb.y += sd === 'bottom' ? ey : sd === 'top' ? 0 : ey / 2; }
      W = opt.w; H = opt.h;
    }
    const shp = S.board.shape;
    if (shp && shp.type === 'ellipse') { const ex = W * 0.21, ey = H * 0.21; W += 2 * ex; H += 2 * ey; ox += ex; oy += ey; }
    if (shp && shp.type === 'rounded') { const e = (shp.r || 0) * 0.3; W += 2 * e; H += 2 * e; ox += e; oy += e; }
    if (shp && shp.type === 'polygon') { const cx2 = (S.board.w - W) / 2, cy2 = (S.board.h - H) / 2; ox += cx2; oy += cy2; W = S.board.w; H = S.board.h; }
    W = Math.ceil(W * 10) / 10; H = Math.ceil(H * 10) / 10;
    for (const c of cs) { c.pcb.x = +(Math.round((c.pcb.x + ox) / 0.05) * 0.05).toFixed(3); c.pcb.y = +(Math.round((c.pcb.y + oy) / 0.05) * 0.05).toFixed(3); }
    S.board = Object.assign({}, S.board, { w: +W.toFixed(1), h: +H.toFixed(1) });
    const hadHoles = (S.pcb.holes || []).filter(h => h.auto), holeD = hadHoles.length ? hadHoles[0].d : 0;
    S.pcb = Object.assign({}, S.pcb, { traces: [], vias: [], routed: {}, pours: (S.pcb.pours || []).filter(pr => pr.whole), holes: [] });
    if (holeD) addMountingHoles({ diameter: holeD });   // corner holes follow the new board
    return { board: S.board, placed: cs.length, on_edge: edgeParts.map(e => `${e.c.ref}:${e.side}${e.plug ? ' (opening outward)' : ''}`) };
  }

  // Move / rotate one footprint, or put it on a board edge (plugs face outward, flush with the edge).
  function placeFootprint(ref, o = {}) {
    const S = Model.S, c = Model.comp(ref);
    if (!c || !Lib.footprint(c.footprint)) throw new Error(`No footprint for "${ref}"`);
    if (!c.pcb || !S.board.w) throw new Error('Generate the PCB first');
    if (o.side) { const sd = /^b/i.test(o.side) ? 'B' : 'F'; if (sd === 'B') c.pcb.side = 'B'; else delete c.pcb.side; }
    if (o.lock != null) c.pcb.locked = !!o.lock;
    if (o.edge) {
      if (!NORMAL[o.edge]) throw new Error('edge must be left, right, top or bottom');
      const info = edgeInfo(c) || { plug: false, front: null };
      c.pcbEdge = o.edge; c.pcb.rot = edgeRot(c, o.edge, info);
      const inset = edgeInset(c, o.edge, info.plug), b = fpBox(c);
      if (o.edge === 'left') c.pcb.x += inset - b[0]; if (o.edge === 'right') c.pcb.x += S.board.w - inset - b[2];
      if (o.edge === 'top') c.pcb.y += inset - b[1]; if (o.edge === 'bottom') c.pcb.y += S.board.h - inset - b[3];
      if (o.along != null) { if (o.edge === 'left' || o.edge === 'right') c.pcb.y = +o.along; else c.pcb.x = +o.along; }
    }
    if (o.rot != null) c.pcb.rot = ((Math.round(+o.rot / 90) * 90) % 360 + 360) % 360;
    if (o.x != null) c.pcb.x = +o.x; if (o.y != null) c.pcb.y = +o.y;
    c.pcb.x = +(+c.pcb.x).toFixed(3); c.pcb.y = +(+c.pcb.y).toFixed(3);
    const b = fpBox(c);
    return { ref: c.ref, x: c.pcb.x, y: c.pcb.y, rot: c.pcb.rot, side: isBottom(c) ? 'bottom' : 'top', edge: c.pcbEdge || null, outside_board: b[0] < -0.01 || b[1] < -0.01 || b[2] > S.board.w + 0.01 || b[3] > S.board.h + 0.01 };
  }

  // ---------- design rules ----------
  // Defaults follow JLCPCB's standard 2-layer (1 oz) capabilities; verify current limits at jlcpcb.com/capabilities.
  // JLCPCB capabilities (1–2 layers, 1 oz, checked 2026-10-23): 0.1 / 0.1 mm track / space, vias down to 0.15 mm hole /
  // 0.25 mm diameter (extra cost), diameter ≥ hole + 0.1, plated through-hole ring ≥ 0.18 mm, copper ≥ 0.2 mm from the edge
  const JLC_MIN = { minTraceWidth: 0.1, minClearance: 0.1, minViaDrill: 0.15, minViaDiameter: 0.25, minAnnularRing: 0.05, minPthRing: 0.18, minHoleToHole: 0.5, minEdgeClearance: 0.2, minHoleSize: 0.15 };
  // JLCPCB charges extra for a via hole < 0.2 mm, or a hole < 0.3 mm with a diameter < 0.45 mm
  const costsExtra = v => v.drill < 0.2 - 1e-9 || (v.drill < 0.3 - 1e-9 && v.d < 0.45 - 1e-9);
  const costNote = v => `Via ${v.d}/${v.drill} mm costs extra at JLCPCB (no extra cost: hole ≥ 0.2 mm with diameter ≥ 0.45 mm) — pick the matching via option when ordering`;
  // one line for exports / the datasheet: which via sizes the board uses, and whether that costs extra
  function viaSummary() {
    const S = Model.S, R = rules(), sizes = new Map();
    for (const v of S.pcb.vias || []) sizes.set(`${v.d}/${v.drill}`, v);
    if (!sizes.size) return `No vias (rule: ${R.viaDiameter}/${R.viaDrill} mm)`;
    return [...sizes.values()].map(v => `Vias ${v.d} mm diameter / ${v.drill} mm hole: ${costsExtra(v) ? 'COSTS EXTRA at JLCPCB — choose the matching via size when ordering' : 'JLCPCB standard, no extra cost'}`).join('; ');
  }
  const RULE_PRESETS = {
    jlcpcb: { label: 'JLCPCB 2-layer — recommended', values: { traceWidth: 0.25, powerTraceWidth: 0.5, clearance: 0.2, viaDiameter: 0.6, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_free_min: { label: 'JLCPCB 2-layer — smallest at no extra cost (0.1 mm, vias 0.45/0.2)', values: { traceWidth: 0.1, powerTraceWidth: 0.3, clearance: 0.1, viaDiameter: 0.45, viaDrill: 0.2, edgeClearance: 0.2, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_min: { label: 'JLCPCB 2-layer — 5/5 mil', values: { traceWidth: 0.127, powerTraceWidth: 0.3, clearance: 0.127, viaDiameter: 0.56, viaDrill: 0.3, edgeClearance: 0.3, layers: 2, neckDown: true, ...JLC_MIN } },
    jlcpcb_power: { label: 'JLCPCB 2-layer — power / robust', values: { traceWidth: 0.3, powerTraceWidth: 0.8, clearance: 0.25, viaDiameter: 0.8, viaDrill: 0.4, edgeClearance: 0.5, layers: 2, neckDown: true, ...JLC_MIN } },
    home: { label: 'Home etching / CNC milling (1 layer)', values: { traceWidth: 0.4, powerTraceWidth: 0.8, clearance: 0.4, viaDiameter: 1.2, viaDrill: 0.6, edgeClearance: 1.0, layers: 1, neckDown: true, minTraceWidth: 0.3, minClearance: 0.3, minViaDrill: 0.5, minViaDiameter: 1.0, minAnnularRing: 0.25, minHoleToHole: 0.8, minEdgeClearance: 0.8, minHoleSize: 0.6 } },
  };
  function rules() {
    const r = Model.S.rules || {}, p = RULE_PRESETS[r.preset] || RULE_PRESETS.jlcpcb;
    return Object.assign({ preset: 'jlcpcb', netWidths: {}, routeTime: 90, trackStyle: '45', noViaInPad: true, pourMinArea: 0.5 }, p.values, r, { netWidths: Object.assign({}, r.netWidths || {}) });
  }
  // every net uses the rule's trace width; power / GND nets get the power width only when powerWider is on
  const netWidth = (R, net) => +(R.netWidths[net] || (R.powerWider && Model.isPower(net) ? R.powerTraceWidth : R.traceWidth));
  // Rules that violate the fab minimums (returned as warnings by setRules / DRC).
  function ruleWarnings(R) {
    const w = [];
    if (R.traceWidth < R.minTraceWidth) w.push(`Trace width ${R.traceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.powerTraceWidth < R.minTraceWidth) w.push(`Power trace width ${R.powerTraceWidth} < fab minimum ${R.minTraceWidth} mm`);
    if (R.clearance < R.minClearance) w.push(`Clearance ${R.clearance} < fab minimum ${R.minClearance} mm`);
    if (R.viaDrill < R.minViaDrill) w.push(`Via drill ${R.viaDrill} < fab minimum ${R.minViaDrill} mm`);
    if (R.viaDiameter < R.minViaDiameter) w.push(`Via diameter ${R.viaDiameter} < fab minimum ${R.minViaDiameter} mm`);
    if ((R.viaDiameter - R.viaDrill) / 2 < R.minAnnularRing - 1e-9) w.push(`Via annular ring ${((R.viaDiameter - R.viaDrill) / 2).toFixed(3)} < fab minimum ${R.minAnnularRing} mm`);
    if (R.edgeClearance < R.minEdgeClearance) w.push(`Edge clearance ${R.edgeClearance} < fab minimum ${R.minEdgeClearance} mm`);
    if (R.viaDiameter - R.viaDrill < 0.1 - 1e-9) w.push('Via diameter must be at least 0.1 mm larger than the hole (JLCPCB)');
    if (costsExtra({ d: R.viaDiameter, drill: R.viaDrill })) w.push(costNote({ d: R.viaDiameter, drill: R.viaDrill }));
    for (const [n, v] of Object.entries(R.netWidths)) if (+v < R.minTraceWidth) w.push(`Net ${n} width ${v} < fab minimum ${R.minTraceWidth} mm`);
    return w;
  }
  const NUM_KEYS = ['traceWidth', 'powerTraceWidth', 'clearance', 'viaDiameter', 'viaDrill', 'edgeClearance', 'minTraceWidth', 'minClearance', 'minViaDrill', 'minViaDiameter', 'minAnnularRing', 'minPthRing', 'minHoleToHole', 'minEdgeClearance', 'minHoleSize'];
  // Merge a partial rule update into the project (preset first, then overrides).
  function setRules(u = {}) {
    let base = Model.S.rules || {};
    if (u.preset) { if (!RULE_PRESETS[u.preset]) throw new Error(`Unknown preset "${u.preset}". Presets: ${Object.keys(RULE_PRESETS).join(', ')}`); base = { preset: u.preset, netWidths: base.netWidths || {} }; }
    const next = Object.assign({}, base);
    for (const k of NUM_KEYS) if (u[k] != null && u[k] !== '') { const v = +u[k]; if (!(v > 0 && v < 20)) throw new Error(`${k} must be a positive number in mm`); next[k] = v; }
    if (u.layers != null) { if (![1, 2].includes(+u.layers)) throw new Error('layers must be 1 or 2'); next.layers = +u.layers; }
    if (u.neckDown != null) next.neckDown = !!u.neckDown;
    if (u.powerWider != null) next.powerWider = !!u.powerWider;
    if (u.viaInPad != null) next.viaInPad = !!u.viaInPad;
    if (u.noViaInPad != null) { next.noViaInPad = !!u.noViaInPad; if (next.noViaInPad) next.viaInPad = false; }
    if (u.pourMinArea != null && u.pourMinArea !== '') { const v = +u.pourMinArea; if (!(v >= 0 && v <= 50)) throw new Error('pourMinArea must be 0…50 mm²'); next.pourMinArea = v; }
    if (u.trackStyle != null) { const v = String(u.trackStyle).replace(/°|deg/g, ''); if (!['45', '90'].includes(v)) throw new Error('trackStyle must be "45" or "90"'); next.trackStyle = v; }
    if (u.routeTime != null && u.routeTime !== '') { const v = +u.routeTime; if (!(v >= 5 && v <= 1800)) throw new Error('routeTime must be 5…1800 seconds'); next.routeTime = v; }
    if (u.netWidths) {
      next.netWidths = Object.assign({}, base.netWidths || {});
      for (const [n, v] of Object.entries(u.netWidths)) { if (v == null || v === '' || +v === 0) delete next.netWidths[n]; else next.netWidths[n] = +v; }
    }
    Model.S.rules = next;
    const R = rules(); return { rules: R, warnings: ruleWarnings(R) };
  }

  // ---------- autorouter (rule-driven, 2-layer grid A*) ----------
  class Heap {
    constructor() { this.f = []; this.s = []; }
    push(f, s) { const F = this.f, S = this.s; let i = F.length; F.push(f); S.push(s); while (i > 0) { const p = (i - 1) >> 1; if (F[p] <= f) break; F[i] = F[p]; S[i] = S[p]; i = p; } F[i] = f; S[i] = s; }
    pop() {
      const F = this.f, S = this.s, top = S[0], lf = F.pop(), ls = S.pop(), n = F.length;
      if (n) { let i = 0; for (; ;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && F[c + 1] < F[c]) c++; if (F[c] >= lf) break; F[i] = F[c]; S[i] = S[c]; i = c; } F[i] = lf; S[i] = ls; }
      return top;
    }
    get size() { return this.f.length; }
  }
  // Distance from point to pad copper (rect / round / oval-as-capsule).
  function padDist(p, x, y) {
    if (p.shape === 'round') return Math.hypot(x - p.x, y - p.y) - p.w / 2;
    if (p.shape === 'oval') {
      const r = Math.min(p.w, p.h) / 2, hx = Math.max(0, p.w / 2 - r), hy = Math.max(0, p.h / 2 - r);
      const dx = Math.max(0, Math.abs(x - p.x) - hx), dy = Math.max(0, Math.abs(y - p.y) - hy); return Math.hypot(dx, dy) - r;
    }
    const dx = Math.max(0, Math.abs(x - p.x) - p.w / 2), dy = Math.max(0, Math.abs(y - p.y) - p.h / 2);
    return Math.hypot(dx, dy);
  }

  // Route with vias kept off SMD pins. Nets that cannot be finished that way are retried on their own,
  // allowing a via on their own pin as a last resort (reported, and flagged by DRC as a warning).
  function route(opt = {}) {
    const t0 = Date.now(), S = Model.S;
    let r = routeOnce(opt);
    // Copper pours: pads joined through a pour before routing can be cut off once tracks split the pour into
    // islands. Re-check the poured nets and connect the pieces (tracks, or vias down to the other layer's pour).
    // Also a safety net for every net: the exact geometry decides what is connected, so anything the grid router
    // believed connected but is not gets routed again here.
    if (!opt.onlyNets) {
      for (let k = 0; k < 2; k++) {
        const conn = connectivity(), broken = Object.keys(conn).filter(n => !conn[n].complete && !(r.failed || []).includes(n) || ((S.pcb.pours || []).some(p => p.net === n) && !conn[n].complete));
        if (!broken.length) break;
        const left = (opt.time_limit_s ?? rules().routeTime ?? 90) - (Date.now() - t0) / 1000;
        routeOnce(Object.assign({}, opt, { keep: true, keepAll: true, onlyNets: broken, onBest: null, time_limit_s: Math.max(8, Math.min(40, left)) }));
      }
      const st = status();
      r = Object.assign({}, r, { routed: st.routed, total: st.nets, failed: st.unrouted, vias: S.pcb.vias.length, seconds: +((Date.now() - t0) / 1000).toFixed(1) });
    }
    // Clearance repair: the grid can shave a few µm off the clearance (e.g. a track passing a pad corner). Re-route just
    // those nets with a wider safety margin; keep the original if the repair would leave the net unrouted.
    if (!opt.onlyNets) {
      const tooClose = new Set();
      for (const v of drc().violations) if (v.type === 'clearance' || v.type === 'short') { const m = /trace (\S+)/g; let x; while ((x = m.exec(v.msg))) if (x[1] !== '(no') tooClose.add(x[1]); }
      const nets = [...tooClose].filter(n => S.nets[n]);
      if (nets.length) {
        const before = JSON.stringify(S.pcb), bad0 = drc().violations.filter(v => v.type === 'clearance' || v.type === 'short').length, conn0 = connectivity();
        S.pcb.traces = S.pcb.traces.filter(t => t.manual || !nets.includes(t.net)); S.pcb.vias = S.pcb.vias.filter(v => v.manual || !nets.includes(v.net));
        routeOnce(Object.assign({}, opt, { keep: true, keepAll: true, onlyNets: nets, onBest: null, safeExtra: 0.04, time_limit_s: 15 }));
        const conn = connectivity(), lost = nets.some(n => conn0[n] && conn0[n].complete && !(conn[n] && conn[n].complete));
        const bad1 = drc().violations.filter(v => v.type === 'clearance' || v.type === 'short').length;
        if (lost || bad1 >= bad0) S.pcb = JSON.parse(before);
        else { const st = status(); r = Object.assign({}, r, { routed: st.routed, failed: st.unrouted, vias: S.pcb.vias.length, clearance_repaired: nets }); }
      }
    }
    if (r.via_in_pad && r.via_in_pad.length) r.note = 'Via on an SMD pin was needed for: ' + r.via_in_pad.join(', ') + ' (DRC warning). Optimize placement or give the router more room to avoid it.';
    // why each net that is still open failed
    if (r.failed && r.failed.length) {
      const fr = {}, why = r.failed_reason || {};
      for (const n of r.failed) fr[n] = why[n] || ((S.pcb.pours || []).some(p => p.net === n)
        ? 'its copper pour is split into pieces that are not joined (tracks cut through it) — add a stitching via (add_via) or a track (add_track) between the pieces, or make room'
        : 'the router ran out of time or room — route_pcb again, optimize_pcb, more board area or narrower rules (preset jlcpcb_free_min)');
      r.failed_reason = fr;
    } else delete r.failed_reason;
    return r;
  }
  function routeOnce(opt = {}) {
    const S = Model.S, cs = placed(), R = rules();
    if (!cs.length || !S.board.w) throw new Error('Place the components first (generate_pcb / Auto-place)');
    const L = R.layers === 1 ? 1 : 2;
    const minFeature = Math.min(R.traceWidth, R.clearance, ...Object.values(R.netWidths).map(Number).filter(v => v > 0));
    let g = Math.min(0.25, Math.max(0.05, Math.floor(minFeature / 2 / 0.025) * 0.025));
    let W = Math.floor(S.board.w / g) + 1, H = Math.floor(S.board.h / g) + 1;
    while (W * H > 1500000) { g += 0.025; W = Math.floor(S.board.w / g) + 1; H = Math.floor(S.board.h / g) + 1; }
    const N = W * H;
    const idx = Model.pinIndex(), netNames = Object.keys(S.nets), netId = {};
    netNames.forEach((n, i) => netId[n] = i + 1);

    // edge distance per cell (mm)
    const edge = new Float32Array(N);
    if (isRectBoard()) { for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) edge[y * W + x] = Math.min(x * g, y * g, S.board.w - x * g, S.board.h - y * g); }
    else {
      // curved / custom outline: scanline fill for "inside", exact distance near the outline
      const poly = boardPoly(), reach = R.edgeClearance + Math.max(R.viaDiameter, R.powerTraceWidth, ...Object.values(R.netWidths).map(Number)) + 2 * g;
      edge.fill(-1);
      for (let y = 0; y < H; y++) {
        const py = y * g, xs = [];
        for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > py) !== (yj > py)) xs.push((xj - xi) * (py - yi) / (yj - yi) + xi); }
        xs.sort((a, b) => a - b);
        for (let k = 0; k + 1 < xs.length; k += 2) for (let x = Math.max(0, Math.ceil(xs[k] / g)); x <= Math.min(W - 1, Math.floor(xs[k + 1] / g)); x++) edge[y * W + x] = 1e9;
      }
      for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const x0 = Math.max(0, Math.floor((Math.min(a[0], b[0]) - reach) / g)), x1 = Math.min(W - 1, Math.ceil((Math.max(a[0], b[0]) + reach) / g));
        const y0 = Math.max(0, Math.floor((Math.min(a[1], b[1]) - reach) / g)), y1 = Math.min(H - 1, Math.ceil((Math.max(a[1], b[1]) + reach) / g));
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) { const k = y * W + x; if (edge[k] >= 0) { const d = ptSeg([x * g, y * g], a, b); if (d < edge[k]) edge[k] = d; } }
      }
    }

    // keep-outs: distance (mm) from each cell to the nearest keep-out, per copper layer for tracks and for vias
    const koT = new Float32Array(L * N).fill(1e9), koV = new Float32Array(N).fill(1e9);
    for (const k of keepouts()) {
      if (!k.tracks && !k.vias) continue;
      const reach = Math.max(R.viaDiameter, R.powerTraceWidth, ...Object.values(R.netWidths).map(Number)) + 2 * g, b = koBox(k);
      const x0 = Math.max(0, Math.floor((b[0] - reach) / g)), x1 = Math.min(W - 1, Math.ceil((b[2] + reach) / g)), y0 = Math.max(0, Math.floor((b[1] - reach) / g)), y1 = Math.min(H - 1, Math.ceil((b[3] + reach) / g));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const i = y * W + x, d = koDist(k, x * g, y * g);
        if (k.tracks) for (let l = 0; l < L; l++) if (koOn(k, l ? 'B' : 'F') && d < koT[l * N + i]) koT[l * N + i] = d;
        if (k.vias && d < koV[i]) koV[i] = d;   // a via goes through both layers
      }
    }

    // pads: raster cells whose centre lies in the pad (+ nearest cell for tiny pads)
    const allPads = [], padOf = new Int32Array(L * N);
    let orphan = -2;
    for (const c of cs) for (const p of padsOf(c, idx)) {
      p.id = p.net ? netId[p.net] : orphan--;
      p.layers = L === 1 ? [0] : (p.drill ? [0, 1] : [p.layer === 'B' ? 1 : 0]);
      p.cells = [];
      const x0 = Math.max(0, Math.floor((p.x - p.w / 2) / g)), x1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2) / g));
      const y0 = Math.max(0, Math.floor((p.y - p.h / 2) / g)), y1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2) / g));
      const cells = [];
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) if (padDist(p, x * g, y * g) <= 1e-9) cells.push(y * W + x);
      if (!cells.length) { const cx = Math.min(W - 1, Math.max(0, Math.round(p.x / g))), cy = Math.min(H - 1, Math.max(0, Math.round(p.y / g))); cells.push(cy * W + cx); }
      for (const l of p.layers) for (const cell of cells) { p.cells.push(l * N + cell); padOf[l * N + cell] = allPads.length + 1; }
      allPads.push(p);
    }
    // Existing copper is kept (opt.keep !== false): it becomes an obstacle for other nets and part of its own net.
    // Hand-drawn copper (manual) is always kept; earlier autorouted copper is kept only with opt.keepAll —
    // otherwise it is routed again, so rip-up and reroute can move it.
    const keep = opt.keep !== false, keepAuto = !!opt.keepAll;
    const oldTraces = keep ? S.pcb.traces.filter(t => t.manual || keepAuto) : [], oldVias = keep ? S.pcb.vias.filter(v => v.manual || keepAuto) : [];
    if (keep && !keepAuto) S.pcb = Object.assign({}, S.pcb, { traces: oldTraces.slice(), vias: oldVias.slice(), routed: {} });
    if (!keep) S.pcb = Object.assign({}, S.pcb, { traces: [], vias: [], routed: {}, pours: S.pcb.pours || [], holes: S.pcb.holes || [] });
    const conn = connectivity();
    const preT = [], preV = [];
    let orphanT = -100000;
    for (const t of oldTraces) {
      const id = t.net && netId[t.net] ? netId[t.net] : orphanT--, l = t.layer === 'B' ? 1 : 0;
      if (l >= L) continue;
      const cells = new Set();
      for (let i = 1; i < t.pts.length; i++) {
        const [ax, ay] = t.pts[i - 1], [bx, by] = t.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (g / 2)));
        for (let k = 0; k <= n; k++) { const x = Math.round((ax + (bx - ax) * k / n) / g), y = Math.round((ay + (by - ay) * k / n) / g); if (x >= 0 && y >= 0 && x < W && y < H) cells.add(y * W + x); }
      }
      preT.push({ id, l, w: t.w, cells: [...cells], net: t.net });
    }
    for (const v of oldVias) preV.push({ id: v.net && netId[v.net] ? netId[v.net] : orphanT--, x: Math.round(v.x / g), y: Math.round(v.y / g), d: v.d, net: v.net });
    for (const h of S.pcb.holes || []) preV.push({ id: orphanT--, x: Math.round(h.x / g), y: Math.round(h.y / g), d: h.d + 0.2, net: null, hole: true });
    const jobs = netNames.map(n => {
      const pads = allPads.filter(p => p.net === n);
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const p of pads) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); y0 = Math.min(y0, p.y); y1 = Math.max(y1, p.y); }
      // group pads already joined by existing copper into islands ("super pads")
      const c = conn[n], islands = [];
      if (c) for (const grp of c.groups) { const ids = new Set(grp.map(q => q.uid)); islands.push(pads.filter(q => ids.has(q.uid))); }
      else pads.forEach(q => islands.push([q]));
      return { net: n, id: netId[n], pads, islands: islands.filter(i => i.length), hpwl: (x1 - x0) + (y1 - y0), w: netWidth(R, n) };
    }).filter(j => j.pads.length >= 2 && (!opt.onlyNets || opt.onlyNets.includes(j.net)));
    // pour pass: the pour copper tied to the main group is part of the start tree, so a cut-off pad only has to
    // reach the nearest live pour (a short stub, or a via down to the other layer's pour)
    if (opt.onlyNets) for (const j of jobs) {
      const prs = (S.pcb.pours || []).filter(p => p.net === j.net); if (!prs.length || j.islands.length < 2) continue;
      j.islands.sort((a, b) => b.length - a.length);
      const main = j.islands[0], ras = prs.map(pr => ({ pr, r: pourRaster(pr), l: pr.layer === 'B' ? 1 : 0 })).filter(q => q.l < L);
      const live = ras.map(q => new Set(main.filter(p => p.drill || (p.layer || 'F') === q.pr.layer).map(p => q.r.at(p.x, p.y)).filter(Boolean)));
      // one hop through the net's vias: a via in a live island of one layer makes its island on the other layer live
      for (let pass = 0; pass < 2; pass++) for (const v of S.pcb.vias) if (v.net === j.net) {
        const onLive = ras.some((q, k) => live[k].has(q.r.at(v.x, v.y)));
        if (onLive) ras.forEach((q, k) => { const lab = q.r.at(v.x, v.y); if (lab) live[k].add(lab); });
      }
      const extra = [];
      ras.forEach((q, k) => { if (!live[k].size) return; for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (live[k].has(q.r.at(x * g, y * g))) extra.push(q.l * N + y * W + x); });
      if (extra.length) j.pourCells = extra;
    }
    const already = jobs.filter(j => j.islands.length <= 1).map(j => j.net);
    const todo = jobs.filter(j => j.islands.length > 1);
    if (!todo.length) { S.pcb = Object.assign({}, S.pcb, { traces: oldTraces, vias: oldVias, pours: S.pcb.pours || [], holes: S.pcb.holes || [], routed: Object.fromEntries(already.map(n => [n, true])) }); return { routed: jobs.length, total: jobs.length, failed: [], necked_down: [], vias: oldVias.length, kept_tracks: oldTraces.length, rules: R.preset }; }

    const maxW = Math.max(R.traceWidth, ...jobs.map(j => j.w));
    const padReach = Math.max(maxW / 2, R.viaDiameter / 2) + R.clearance + R.viaDrill / 2 + R.minHoleToHole;
    for (const p of allPads) {
      const near = [], x0 = Math.max(0, Math.floor((p.x - p.w / 2 - padReach) / g)), x1 = Math.min(W - 1, Math.ceil((p.x + p.w / 2 + padReach) / g));
      const y0 = Math.max(0, Math.floor((p.y - p.h / 2 - padReach) / g)), y1 = Math.min(H - 1, Math.ceil((p.y + p.h / 2 + padReach) / g));
      for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
        const d = padDist(p, x * g, y * g); if (d >= padReach) continue;
        near.push(y * W + x, d, p.drill ? Math.hypot(x * g - p.x, y * g - p.y) - p.drill / 2 : 99);
      }
      p.near = near;
    }
    const diskCache = {};
    const disk = r => {
      const k = r.toFixed(4); if (diskCache[k]) return diskCache[k];
      const n = Math.ceil(r / g), out = [];
      for (let dy = -n; dy <= n; dy++) for (let dx = -n; dx <= n; dx++) if ((dx * g) ** 2 + (dy * g) ** 2 < r * r) out.push(dx, dy);
      return (diskCache[k] = out);
    };
    const g2 = new Float64Array(L * N), came = new Int32Array(L * N), closed = new Uint8Array(L * N), tmask = new Uint8Array(L * N);
    const blockT = new Uint8Array(L * N), blockV = new Uint8Array(N), own = new Float32Array(L * N), stamp = new Int32Array(L * N);
    // soft mode (blocker discovery): copper of other routed nets is passable at a cost; softT/softV hold its owner id
    const softT = new Int32Array(L * N), softV = new Int32Array(N);
    let soft = false, useHist = true;
    const hist = new Float32Array(L * N);   // negotiated congestion: corridors that stuck nets need get costlier for everyone else
    const SOFT = 3;
    let searchId = 0; const stats = { searches: 0, failed: 0, expanded: 0, maxed: 0, ripups: 0, restarts: 0 };
    const DX = [1, -1, 0, 0, 1, 1, -1, -1], DY = [0, 0, 1, -1, 1, -1, 1, -1], DC = [1, 1, 1, 1, Math.SQRT2, Math.SQRT2, Math.SQRT2, Math.SQRT2];
    // track style: '90' = horizontal / vertical runs only; every change of direction costs a little (fewer, longer straight runs)
    const ortho = R.trackStyle === '90', ND = ortho ? 4 : 8, TURN = 0.6;
    const vr = R.viaDiameter / 2, slack = 0.3 * g;
    // routing state: kept copper is fixed; copper made here belongs to its net (t.id) and can be ripped up
    const vip = new Set();   // nets allowed a via on their own SMD pin (last resort)
    const st = { tcells: preT.map(t => Object.assign({ fixed: true }, t)), gvias: preV.map(v => Object.assign({ fixed: true }, v)) };
    const markDisk = (map, layerOff, cx, cy, r, val = 1) => {
      const d = disk(r);
      for (let i = 0; i < d.length; i += 2) { const x = cx + d[i], y = cy + d[i + 1]; if (x >= 0 && y >= 0 && x < W && y < H) { const k = layerOff + y * W + x; if (map[k] < val) map[k] = val; } }
    };
    // grid rounding can eat a few µm of clearance: keep a small safety margin so DRC never sees 0.199 vs 0.2
    const safe = Math.max(0.01, g * 0.1) + (+opt.safeExtra || 0);
    // Obstacle counts per trace width, kept up to date incrementally: pads, fixed (kept) copper and routed copper.
    // A net's maps are then "counts minus its own contributions > 0", built in one linear pass.
    const wcache = new Map();
    const diskAdd = (map, layerOff, cx, cy, r, sgn) => {
      const d = disk(r);
      for (let i = 0; i < d.length; i += 2) { const x = cx + d[i], y = cy + d[i + 1]; if (x >= 0 && y >= 0 && x < W && y < H) map[layerOff + y * W + x] += sgn; }
    };
    function padAdd(MT, MV, p, w, sgn) {
      const rT = w / 2 + R.clearance + safe, rV = vr + R.clearance + safe, nr = p.near, hole = R.viaDrill / 2 + R.minHoleToHole;
      for (let k = 0; k < nr.length; k += 3) {
        const i = nr[k], d = nr[k + 1];
        if (d < rT) for (const l of p.layers) MT[l * N + i] += sgn;
        if (d < rV || nr[k + 2] < hole) MV[i] += sgn;
      }
    }
    function cuAdd(MT, MV, t, w, sgn) {
      const r1 = w / 2 + t.w / 2 + R.clearance + slack, r2 = vr + t.w / 2 + R.clearance + slack;
      for (const c of t.cells) { const x = c % W, y = (c / W) | 0; diskAdd(MT, t.l * N, x, y, r1, sgn); diskAdd(MV, 0, x, y, r2, sgn); }
    }
    function viaAdd(MT, MV, v, w, sgn) {
      const rt = w / 2 + v.d / 2 + R.clearance + safe, rv = Math.max(v.d / 2 + vr + R.clearance, (v.hole ? v.d : R.viaDrill) / 2 + R.viaDrill / 2 + R.minHoleToHole);
      for (let l = 0; l < L; l++) diskAdd(MT, l * N, v.x, v.y, rt, sgn);
      diskAdd(MV, 0, v.x, v.y, rv, sgn);
    }
    function mapsFor(w) {
      const key = w.toFixed(4); let M = wcache.get(key);
      if (M) return M;
      M = { w, pT: new Int32Array(L * N), pV: new Int32Array(N), fT: new Int32Array(L * N), fV: new Int32Array(N), rT: new Int32Array(L * N), rV: new Int32Array(N) };
      for (const p of allPads) padAdd(M.pT, M.pV, p, w, 1);
      for (const t of st.tcells) if (t.fixed) cuAdd(M.fT, M.fV, t, w, 1); else cuAdd(M.rT, M.rV, t, w, 1);
      for (const v of st.gvias) if (v.fixed) viaAdd(M.fT, M.fV, v, w, 1); else viaAdd(M.rT, M.rV, v, w, 1);
      wcache.set(key, M);
      return M;
    }
    // routed copper added to / removed from the board
    function track(ts, vs2, sgn) { const tt0 = Date.now(); trackI(ts, vs2, sgn); stats.tTrack = (stats.tTrack || 0) + Date.now() - tt0; }
    function trackI(ts, vs2, sgn) { for (const M of wcache.values()) { for (const t of ts) if (!t.fixed) cuAdd(M.rT, M.rV, t, M.w, sgn); for (const v of vs2) if (!v.fixed) viaAdd(M.rT, M.rV, v, M.w, sgn); } }
    const tmpT = new Int32Array(L * N), tmpV = new Int32Array(N), vipCell = new Uint8Array(N);
    // Build "where may this net's centreline / vias go" maps for width w.
    function buildMaps(id, w) {
      const tb0 = Date.now();
      const M = mapsFor(w);
      own.fill(0); vipCell.fill(0);
      for (let k = 0; k < L * N; k++) tmpT[k] = M.pT[k] + M.fT[k] + (soft ? 0 : M.rT[k]);
      for (let k = 0; k < N; k++) tmpV[k] = M.pV[k] + M.fV[k] + (soft ? 0 : M.rV[k]);
      for (const p of allPads) if (p.id === id) padAdd(tmpT, tmpV, p, w, -1);
      for (const t of st.tcells) if (t.id === id && (t.fixed || !soft)) cuAdd(tmpT, tmpV, t, w, -1);
      for (const v of st.gvias) if (v.id === id && (v.fixed || !soft)) viaAdd(tmpT, tmpV, v, w, -1);
      for (let k = 0; k < L * N; k++) blockT[k] = tmpT[k] > 0 ? 1 : 0;
      for (let k = 0; k < N; k++) blockV[k] = tmpV[k] > 0 ? 1 : 0;
      if (soft) { for (let k = 0; k < L * N; k++) softT[k] = M.rT[k] > 0 ? 1 : 0; for (let k = 0; k < N; k++) softV[k] = M.rV[k] > 0 ? 1 : 0; }
      const eT = R.edgeClearance + w / 2, eV = R.edgeClearance + vr;
      for (let i = 0; i < N; i++) { if (edge[i] < eT) { blockT[i] = 1; if (L > 1) blockT[N + i] = 1; } if (edge[i] < eV) blockV[i] = 1; }
      if (keepouts().length) { const kT = w / 2 + safe, kV = vr + safe; for (let k = 0; k < L * N; k++) if (koT[k] < kT) blockT[k] = 1; for (let i = 0; i < N; i++) if (koV[i] < kV) blockV[i] = 1; }
      for (const p of allPads) {
        if (p.id === id) {
          for (const c of p.cells) {
            const i = c % N, px = (i % W) * g, py = ((i / W) | 0) * g;
            const depth = p.shape === 'round' ? p.w / 2 - Math.hypot(px - p.x, py - p.y) : Math.min(p.w / 2 - Math.abs(px - p.x), p.h / 2 - Math.abs(py - p.y));
            const fit = Math.max(0, 2 * depth); if (own[c] < fit) own[c] = fit;
          }
          // no vias on SMD pins (solder wicks into the hole; JLCPCB needs paid filled vias for that):
          // keep vias off our own small pads, except well inside large exposed / thermal pads
          // drill-to-drill spacing applies to our own through-hole pads too
          if (p.drill) { const nr = p.near, hole = R.viaDrill / 2 + R.minHoleToHole; for (let k = 0; k < nr.length; k += 3) if (nr[k + 2] < hole) blockV[nr[k]] = 1; }
          // (a net allowed via-in-pad as a last resort pays a heavy cost for it, so it is used only where unavoidable)
          if (!p.drill && !R.viaInPad) {
            const big = p.ep && Math.min(p.w, p.h) >= 2 * R.viaDiameter + 0.4, nr = p.near, last = vip.has(id);
            for (let k = 0; k < nr.length; k += 3) {
              const i = nr[k]; if (nr[k + 1] >= vr + 0.05) continue;
              if (big && Math.max(own[i], L > 1 ? own[N + i] : 0) >= R.viaDiameter + 0.3) continue;
              if (last) vipCell[i] = 1; else blockV[i] = 1;
            }
          }
        }
      }
      for (const t of st.tcells) if (t.id === id) for (const c of t.cells) if (own[t.l * N + c] < t.w) own[t.l * N + c] = t.w;
      for (const v of st.gvias) if (v.id === id) for (let l = 0; l < L; l++) markDisk(own, l * N, v.x, v.y, vr, v.d);
      stats.tBuild = (stats.tBuild || 0) + Date.now() - tb0; stats.nBuild = (stats.nBuild || 0) + 1;
    }
    // which routed nets does a (soft) path run into? dilate the path by the clearance and look for their copper
    function blockersOf(paths, w, id) {
      const r = w / 2 + Math.max(R.traceWidth, R.powerTraceWidth, ...Object.values(R.netWidths).map(Number)) / 2 + R.clearance + slack + vr, hit = new Set(), out = new Set();
      const d = disk(r);
      for (const path of paths) for (const s of path) {
        const l = s >= N ? 1 : 0, i = s - l * N, x = i % W, y = (i / W) | 0;
        for (let k = 0; k < d.length; k += 2) { const xx = x + d[k], yy = y + d[k + 1]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) hit.add(l * N + yy * W + xx); }
      }
      for (const t of st.tcells) if (!t.fixed && t.id !== id && !out.has(t.id)) for (const c of t.cells) if (hit.has(t.l * N + c)) { out.add(t.id); break; }
      for (const v of st.gvias) if (!v.fixed && v.id !== id && !out.has(v.id)) for (let l = 0; l < L; l++) if (hit.has(l * N + v.y * W + v.x)) { out.add(v.id); break; }
      return out;
    }
    // A* over (layer, cell). own[] = widest trace that fits inside our own copper at that cell.
    function astar(sources, target, w, win) { const ta0 = Date.now(); const r = astarI(sources, target, w, win); stats.tAstar = (stats.tAstar || 0) + Date.now() - ta0; return r; }
    // Cheap reachability test before A*: breadth-first flood from the target (usually the boxed-in side)
    // until a source cell is met. Failed A* searches would otherwise explore the whole board with a heap.
    // two floods (from the target and from the source tree) grown alternately: stops as soon as they meet, or
    // when either side runs out of room — which is quick, because a blocked terminal is usually boxed in.
    const visA = new Int32Array(L * N), visB = new Int32Array(L * N), qA = new Int32Array(L * N), qB = new Int32Array(L * N);
    let reachId = 0;
    function reachable(sources, target, wt) {
      const rid = ++reachId, dvia = R.viaDiameter - 1e-9;
      let ha = 0, ta = 0, hb = 0, tb = 0;
      const pass = s => !(blockT[s] && own[s] < wt);
      for (const s0 of sources) if (pass(s0) && visB[s0] !== rid) { visB[s0] = rid; qB[tb++] = s0; }
      for (const t of target.cells) if (own[t] >= wt || !blockT[t]) { if (visB[t] === rid) return true; if (visA[t] !== rid) { visA[t] = rid; qA[ta++] = t; } }
      if (!ta || !tb) return false;
      const step = (q, h, t, mine, other) => {   // expand one cell; returns [newTail, met]
        const s = q[h], l = s >= N ? 1 : 0, lo = l * N, i = s - lo, x = i % W, y = (i / W) | 0;
        for (let d = 0; d < 8; d++) {
          const nx = x + DX[d], ny = y + DY[d]; if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const ns = lo + ny * W + nx; if (mine[ns] === rid || !pass(ns)) continue;
          if (other[ns] === rid) return -1;
          mine[ns] = rid; q[t++] = ns;
        }
        if (L > 1 && !blockV[i]) {
          const pi = padOf[i] || padOf[N + i], pad = pi ? allPads[pi - 1] : null;
          if (!pad || pad.drill || Math.max(own[i], own[N + i]) >= dvia) {
            const os = (1 - l) * N + i;
            if (mine[os] !== rid && pass(os)) { if (other[os] === rid) return -1; mine[os] = rid; q[t++] = os; }
          }
        }
        return t;
      };
      while (ha < ta && hb < tb) {
        for (let k = 0; k < 32 && ha < ta; k++) { const r = step(qA, ha++, ta, visA, visB); if (r < 0) return true; ta = r; }
        for (let k = 0; k < 32 && hb < tb; k++) { const r = step(qB, hb++, tb, visB, visA); if (r < 0) return true; tb = r; }
      }
      return false;
    }
    function astarI(sources, target, w, win) {
      const sid = ++searchId, wt = w - 1e-9; stats.searches++;
      if ((win[2] - win[0] + 1) * (win[3] - win[1] + 1) > 12000 && !reachable(sources, target, wt)) { stats.unreachable = (stats.unreachable || 0) + 1; return null; }
      let anyT = false;
      for (const t of target.cells) { stamp[t] = sid; g2[t] = Infinity; closed[t] = 0; tmask[t] = 0; if (own[t] >= wt || !blockT[t]) { tmask[t] = 1; anyT = true; } }
      // aim at the nearest pad of the target terminal
      let tp = target.pads ? target.pads[0] : target;
      if (!anyT) { if (soft) stats.softNoTarget = (stats.softNoTarget || 0) + 1; return null; }
      const [wx0, wy0, wx1, wy1] = win;
      const tx = tp.x / g, ty = tp.y / g, heap = new Heap(), K = ortho ? 1 : Math.SQRT2 - 1, HW = 1.15;
      let started = 0;
      for (const s0 of sources) {
        if (blockT[s0] && own[s0] < wt) continue;
        if (stamp[s0] !== sid) { stamp[s0] = sid; closed[s0] = 0; tmask[s0] = 0; }
        g2[s0] = 0; came[s0] = -1; started++;
        const i = s0 % N, dx = Math.abs(i % W - tx), dy = Math.abs(((i / W) | 0) - ty);
        heap.push(HW * (Math.max(dx, dy) + K * Math.min(dx, dy)), s0);
      }
      if (!started) { if (soft) stats.softNoSource = (stats.softNoSource || 0) + 1; return null; }
      let expanded = 0; const limit = soft ? Math.min(250000, L * N) : Math.min(900000, L * N);
      const viaCost = Math.max(8, 2.5 / g), dv = R.viaDiameter - 1e-9;
      while (heap.size) {
        const s = heap.pop(); if (closed[s]) continue; closed[s] = 1;
        if (tmask[s]) { stats.expanded += expanded; if (soft) stats.expSoft = (stats.expSoft || 0) + expanded; if (win[2] - win[0] === W - 1) stats.expFull = (stats.expFull || 0) + expanded; stats.big = Math.max(stats.big || 0, expanded); const path = []; for (let c = s; c !== -1; c = came[c]) path.push(c); return path.reverse(); }
        if (++expanded > limit) { stats.expanded += expanded; stats.failed++; stats.maxed++; return null; }
        const l = s >= N ? 1 : 0, lo = l * N, i = s - lo, x = i % W, y = (i / W) | 0, gs = g2[s] + (l ? 0.15 : 0);
        const ps = came[s], pi = ps >= 0 && ps - lo >= 0 && ps - lo < N ? ps - lo : -1, pdx = pi >= 0 ? x - pi % W : 0, pdy = pi >= 0 ? y - ((pi / W) | 0) : 0;
        for (let d = 0; d < ND; d++) {
          const nx = x + DX[d], ny = y + DY[d]; if (nx < wx0 || ny < wy0 || nx > wx1 || ny > wy1) continue;
          const ns = lo + ny * W + nx;
          if (stamp[ns] !== sid) { stamp[ns] = sid; g2[ns] = Infinity; closed[ns] = 0; tmask[ns] = 0; }
          else if (closed[ns]) continue;
          if (blockT[ns] && own[ns] < wt && !tmask[ns]) continue;
          const ng = gs + DC[d] + ((pdx || pdy) && (pdx !== DX[d] || pdy !== DY[d]) ? TURN : 0) + (useHist ? hist[ns] : 0) + (soft && softT[ns] && own[ns] < wt ? SOFT : 0);
          if (ng < g2[ns]) {
            g2[ns] = ng; came[ns] = s;
            const ddx = Math.abs(nx - tx), ddy = Math.abs(ny - ty);
            heap.push(ng + HW * (ddx > ddy ? ddx + K * ddy : ddy + K * ddx), ns);
          }
        }
        if (L > 1 && !blockV[i]) {
          const pi = padOf[i] || (L > 1 ? padOf[N + i] : 0), pad = pi ? allPads[pi - 1] : null; // via-in-pad only inside our own pad, where the via fits
          if (!pad || pad.drill || Math.max(own[i], L > 1 ? own[N + i] : 0) >= dv) {
            const os = (1 - l) * N + i;
            if (stamp[os] !== sid) { stamp[os] = sid; g2[os] = Infinity; closed[os] = 0; tmask[os] = 0; }
            if (!closed[os]) {
              const ng = g2[s] + viaCost * (vipCell[i] ? 20 : 1) + (soft && softV[i] ? SOFT * 3 : 0);
              if (ng < g2[os]) { g2[os] = ng; came[os] = s; const ddx = Math.abs(x - tx), ddy = Math.abs(y - ty); heap.push(ng + HW * (ddx > ddy ? ddx + K * ddy : ddy + K * ddx), os); }
            }
          }
        }
      }
      stats.expanded += expanded; stats.failed++; stats.expFailed = (stats.expFailed || 0) + expanded;
      return null;
    }

    // Route one net (all its islands into one tree). dry = blocker discovery: nothing is committed, and the
    // ids of the routed nets the paths had to cross are returned.
    function routeNet(job, dry = false) {
      const { id } = job, myT = [], myV = [], dryPaths = [];
      // each island (pads already joined by kept copper) acts as one terminal; its copper is part of the tree
      const islandCells = isl => new Set(isl.flatMap(q => q.cells));
      const terms = job.islands.map(isl => ({ pads: isl, x: isl.reduce((a, q) => a + q.x, 0) / isl.length, y: isl.reduce((a, q) => a + q.y, 0) / isl.length, w: Math.max(...isl.map(q => q.w)), h: Math.max(...isl.map(q => q.h)), cells: [...islandCells(isl)] }));
      // kept tracks/vias of this net extend the terminal they touch
      for (const t of st.tcells) if (t.id === id && t.fixed) { const tc = t.cells.map(c => t.l * N + c), hit = terms.find(T => tc.some(c => T.cells.includes(c))); if (hit) for (const c of tc) hit.cells.push(c); }
      if (job.pourCells) { const tc = terms[0].cells; for (const c of job.pourCells) tc.push(c); }   // (no spread: pours can be 100k+ cells)
      const tree = new Set(terms[0].cells), done = [terms[0]], rest = terms.slice(1), segs = [], vs = [];
      let ok = true, mapW = null, necked = false;
      const widths = [job.w];
      if (R.neckDown) for (const w2 of [R.traceWidth, R.minTraceWidth]) if (w2 < widths[widths.length - 1] - 1e-9) widths.push(w2);
      while (rest.length) {
        let bi = 0, bd = Infinity;
        rest.forEach((T, i) => { for (const D of done) for (const p of T.pads) for (const q of D.pads) { const d = Math.hypot(p.x - q.x, p.y - q.y); if (d < bd) { bd = d; bi = i; } } });
        const target = rest.splice(bi, 1)[0];
        if (target.cells.some(c => tree.has(c))) { done.push(target); continue; }
        let path = null, w = job.w;
        const src = [...tree];
        let bx0 = target.x / g, by0 = target.y / g, bx1 = bx0, by1 = by0;
        for (const s of src) { const i = s % N, x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
        const m = Math.ceil(8 / g);
        const small = [Math.max(0, Math.floor(bx0) - m), Math.max(0, Math.floor(by0) - m), Math.min(W - 1, Math.ceil(bx1) + m), Math.min(H - 1, Math.ceil(by1) + m)];
        const full = [0, 0, W - 1, H - 1];
        for (const w2 of widths) {
          if (mapW !== w2) { buildMaps(id, w2); mapW = w2; for (const t of myT) for (const c of t.cells) if (own[t.l * N + c] < t.w) own[t.l * N + c] = t.w; for (const v of myV) for (let l2 = 0; l2 < L; l2++) markDisk(own, l2 * N, v.x, v.y, vr, v.d); }
          path = astar(src, target, w2, small);
          if (!path && (small[0] > 0 || small[1] > 0 || small[2] < W - 1 || small[3] < H - 1) && w2 === widths[widths.length - 1]) path = astar(src, target, w2, full);
          if (path) { w = w2; break; }
        }
        if (!path) { ok = false; continue; }
        if (w < job.w - 1e-9) necked = true;
        if (dry) dryPaths.push(path);
        // commit
        let run = [], runL = path[0] >= N ? 1 : 0;
        const pt = s => { const i = s % N; return [(i % W) * g, ((i / W) | 0) * g]; };
        const flush = endPad => {
          if (run.length) {
            const pts = run.map(pt);
            const fits = p => Math.min(p.w, p.h) >= w - 1e-9; // only run to the pad centre if the trace fits inside the pad
            const sp = padOf[run[0]]; if (sp && fits(allPads[sp - 1])) { const p = allPads[sp - 1]; pts.unshift([p.x, p.y]); }
            if (endPad && fits(endPad)) pts.push([endPad.x, endPad.y]);
            // straighten: replace grid staircases by the longest clear straight runs (0/45/90° where possible)
            const lo = runL * N, wt = w - 1e-9;
            const cellOK = (x, y) => x >= 0 && y >= 0 && x < W && y < H && !(blockT[lo + y * W + x] && own[lo + y * W + x] < wt) && !(soft && softT[lo + y * W + x] && own[lo + y * W + x] < wt);
            const clear = (a, b) => {
              const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g * 0.5)));
              for (let k = 0; k <= n; k++) {
                const fx = (a[0] + (b[0] - a[0]) * k / n) / g, fy = (a[1] + (b[1] - a[1]) * k / n) / g;
                const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.ceil(fx), y1 = Math.ceil(fy);
                if (!cellOK(x0, y0) || !cellOK(x1, y0) || !cellOK(x0, y1) || !cellOK(x1, y1)) return false;
              }
              return true;
            };
            const okDir = (a, b) => { const dx = Math.abs(b[0] - a[0]), dy = Math.abs(b[1] - a[1]); return dx < 1e-6 || dy < 1e-6 || (!ortho && Math.abs(dx - dy) < 1e-6); };
            // two-leg elbows from a to b: 90° style → the two L corners; 45° style → straight + 45° (both orders)
            const elbows = (a, b) => {
              const dx = b[0] - a[0], dy = b[1] - a[1];
              if (ortho) return [[b[0], a[1]], [a[0], b[1]]];
              const d = Math.min(Math.abs(dx), Math.abs(dy)), sx = Math.sign(dx), sy = Math.sign(dy);
              return [Math.abs(dx) > Math.abs(dy) ? [b[0] - sx * d, a[1]] : [a[0], b[1] - sy * d], [a[0] + sx * d, a[1] + sy * d]];
            };
            const smooth = [pts[0]];
            for (let i = 0; i < pts.length - 1;) {
              // the farthest point reachable by one straight run, or by an elbow; otherwise the next grid step
              let j = i + 1, m = null;
              for (let k = pts.length - 1; k > i; k--) {
                const a = pts[i], b = pts[k];
                if (okDir(a, b)) { if (clear(a, b)) { j = k; break; } continue; }
                const e = elbows(a, b).find(q => clear(a, q) && clear(q, b));
                if (e) { j = k; m = e; break; }
              }
              if (m) smooth.push(m);
              smooth.push(pts[j]); i = j;
            }
            const out = [smooth[0]];
            for (let k = 1; k < smooth.length; k++) {
              const a = out.length > 1 ? out[out.length - 2] : null, b = out[out.length - 1], c = smooth[k];
              if (Math.hypot(c[0] - b[0], c[1] - b[1]) < 1e-6) continue;
              if (a && Math.abs((b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])) < 1e-9) out[out.length - 1] = c; else out.push(c);
            }
            if (out.length >= 2) segs.push({ net: job.net, layer: runL ? 'B' : 'F', w: +w.toFixed(4), pts: out.map(q => [+q[0].toFixed(4), +q[1].toFixed(4)]) });
            // the copper now follows the straightened track: re-rasterise it for clearance and for the net's tree
            const cells = new Set();
            for (let k = 1; k < out.length; k++) {
              const a = out[k - 1], b = out[k], n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / (g * 0.5)));
              for (let q = 0; q <= n; q++) { const x = Math.round((a[0] + (b[0] - a[0]) * q / n) / g), y = Math.round((a[1] + (b[1] - a[1]) * q / n) / g); if (x >= 0 && y >= 0 && x < W && y < H) cells.add(y * W + x); }
            }
            for (const s of run) if (!cells.has(s % N) && !padOf[s]) tree.delete(s);
            for (const c of cells) { tree.add(lo + c); if (own[lo + c] < w) own[lo + c] = w; }
            myT.push({ id, l: runL, w, cells: [...cells] });
          }
          run = [];
        };
        for (let k = 0; k < path.length; k++) {
          const s = path[k], l = s >= N ? 1 : 0;
          if (l !== runL) {
            flush(null); const i = s % N, x = i % W, y = (i / W) | 0;
            vs.push({ net: job.net, x: +(x * g).toFixed(4), y: +(y * g).toFixed(4), d: R.viaDiameter, drill: R.viaDrill });
            myV.push({ id, x, y, d: R.viaDiameter });
            for (let l2 = 0; l2 < L; l2++) markDisk(own, l2 * N, x, y, vr, R.viaDiameter);
            const dd = disk(vr); for (let q = 0; q < dd.length; q += 2) { const xx = x + dd[q], yy = y + dd[q + 1]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) for (let l2 = 0; l2 < L; l2++) tree.add(l2 * N + yy * W + xx); }
            runL = l;
          }
          run.push(s); tree.add(s);
        }
        const lastPad = padOf[path[path.length - 1]] ? allPads[padOf[path[path.length - 1]] - 1] : null;
        flush(lastPad);
        for (const c of target.cells) tree.add(c);
        done.push(target);
      }
      if (!dry) { st.tcells.push(...myT); st.gvias.push(...myV); track(myT, myV, 1); }
      const blockers = dry ? blockersOf(dryPaths, job.w, id) : new Set();
      const len = segs.reduce((a, s) => { for (let i = 1; i < s.pts.length; i++) a += Math.hypot(s.pts[i][0] - s.pts[i - 1][0], s.pts[i][1] - s.pts[i - 1][1]); return a; }, 0);
      return { segs, vs, ok, necked, blockers, len, paths: dry ? dryPaths : null };
    }

    // ---------- negotiated rip-up and reroute, within a time budget ----------
    const t0 = Date.now(), budget = Math.max(1, +(opt.time_limit_s ?? opt.timeLimit ?? R.routeTime ?? 90)) * 1000, deadline = t0 + budget;
    const byId = {}; for (const j of todo) byId[j.id] = j;
    const result = {};   // net → routeNet result (committed)
    const rip = id => {
      const gt = st.tcells.filter(t => !t.fixed && t.id === id), gv = st.gvias.filter(v => !v.fixed && v.id === id);
      track(gt, gv, -1);
      st.tcells = st.tcells.filter(t => t.fixed || t.id !== id); st.gvias = st.gvias.filter(v => v.fixed || v.id !== id); delete result[byId[id].net];
    };
    const commit = job => (result[job.net] = routeNet(job, false)).ok;
    const failedJobs = () => todo.filter(j => !result[j.net] || !result[j.net].ok);
    const score = () => { let f = 0, len = 0, nv = 0; for (const j of todo) { const r = result[j.net]; if (!r || !r.ok) f++; if (r) { len += r.len; nv += r.vs.length; } } return { f, cost: f * 1e7 + len + nv * 1.5 }; };
    const snap = () => ({ t: st.tcells.slice(), v: st.gvias.slice(), r: Object.assign({}, result) });
    const restore = s => {
      const curT = new Set(st.tcells), curV = new Set(st.gvias), snT = new Set(s.t), snV = new Set(s.v);
      track(st.tcells.filter(t => !snT.has(t)), st.gvias.filter(v => !snV.has(v)), -1);
      track(s.t.filter(t => !curT.has(t)), s.v.filter(v => !curV.has(v)), 1);
      st.tcells = s.t.slice(); st.gvias = s.v.slice(); for (const k in result) delete result[k]; Object.assign(result, s.r);
    };
    let seed = 9871; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    let attemptNo = 1, iter = 0;
    const report = (net, extra) => opt.onProgress && opt.onProgress(Object.assign({ net, attempt: attemptNo, iteration: iter, unrouted: failedJobs().length, of: todo.length, elapsed: +((Date.now() - t0) / 1000).toFixed(1), budget: budget / 1000 }, extra));
    const materialize = () => {
      const traces = [], vias = [], routed = {}, failed = [], necked = [];
      for (const j of todo) { const r = result[j.net]; if (!r) { failed.push(j.net); continue; } traces.push(...r.segs); vias.push(...r.vs); if (r.ok) routed[j.net] = true; else failed.push(j.net); if (r.necked) necked.push(j.net); }
      for (const n of already) routed[n] = true;
      return { traces, vias, routed, failed, necked };
    };
    const publish = () => { if (opt.onBest) { const m = materialize(); opt.onBest({ traces: oldTraces.concat(m.traces), vias: oldVias.concat(m.vias), routed: m.routed, unrouted: m.failed.length }); } };

    // pass 1: short nets first
    let order = todo.slice().sort((a, b) => a.hpwl - b.hpwl);
    order.forEach((job, k) => { report(job.net, { done: k, total: order.length, phase: 'route' }); commit(job); });
    let best = snap(), bestScore = score();
    // pass 2 (as before): the nets that failed go first
    if (bestScore.f && Date.now() < deadline) {
      attemptNo = 2;
      const fails = new Set(failedJobs().map(j => j.net));
      for (const j of todo) rip(j.id);
      const ord = order.filter(j => fails.has(j.net)).concat(order.filter(j => !fails.has(j.net)));
      ord.forEach((job, k) => { report(job.net, { done: k, total: ord.length, phase: 'route' }); commit(job); });
      const sc = score();
      if (sc.cost < bestScore.cost - 1e-6) { best = snap(); bestScore = sc; } else restore(best);
    }
    publish();
    const hard = new Set(), ripped = {}, tries = {};
    let stale = 0, noCand = 0;
    while (bestScore.f > 0 && Date.now() < deadline && opt.ripup !== false) {
      iter++;
      const cand = failedJobs().filter(j => !hard.has(j.net));
      // every remaining failure is blocked by pads / fixed copper even with the other nets ignored: a couple of fresh orders, then stop
      if (!cand.length && ++noCand > 2) break;
      if (cand.length && stale < 25) {
        const F = cand[Math.floor(rnd() * cand.length)];
        report(F.net, { phase: 'ripup' });
        const before = snap(), bs = score();
        rip(F.id);
        soft = true; const probe = routeNet(F, true); soft = false;
        let blockers = [...probe.blockers].filter(id => byId[id] && id !== F.id);
        // remember the corridor F needs: path cells and their clearance halo become more expensive
        if (probe.ok && probe.paths) {
          const halo = disk(F.w / 2 + R.traceWidth / 2 + R.clearance + slack);
          for (const path of probe.paths) for (const s of path) {
            const l = s >= N ? 1 : 0, i = s - l * N, x = i % W, y = (i / W) | 0;
            for (let k = 0; k < halo.length; k += 2) { const xx = x + halo[k], yy = y + halo[k + 1]; if (xx >= 0 && yy >= 0 && xx < W && yy < H) { const c = l * N + yy * W + xx; if (hist[c] < 8) hist[c] += 0.4; } }
          }
        }
        if (!probe.ok) {   // blocked even when the other routed nets are ignored
          stats.probeFail = (stats.probeFail || 0) + 1; restore(before);
          if (!R.viaInPad && !R.noViaInPad && !vip.has(F.id)) vip.add(F.id); else hard.add(F.net);
          continue;
        }
        if (!blockers.length) { commit(F); }
        else {
          // nets that have been ripped up often get rerouted first next time (negotiation), and fewer blockers are tried first
          // rip the cheapest blockers (small nets) first; big nets (GND…) are expensive to re-route
          const cost = id => byId[id].pads.length * 4 + byId[id].hpwl / 10 + (ripped[byId[id].net] || 0);
          blockers.sort((a, b) => cost(a) - cost(b));
          const small = blockers.filter(id => byId[id].pads.length <= 8);
          blockers = (small.length ? small : blockers).slice(0, rnd() < 0.5 ? 2 : 4);
          for (const id of blockers) { rip(id); ripped[byId[id].net] = (ripped[byId[id].net] || 0) + 1; stats.ripups++; }
          useHist = false; commit(F); useHist = true;
          const again = blockers.map(id => byId[id]).sort((a, b) => (ripped[b.net] || 0) - (ripped[a.net] || 0) || a.hpwl - b.hpwl);
          for (const j of again) commit(j);
          // nets that still fail get one more try now that everything else is in place
          for (const j of again.concat([F])) if (!result[j.net] || !result[j.net].ok) { rip(j.id); commit(j); }
        }
        if (!result[F.net] || !result[F.net].ok) { tries[F.net] = (tries[F.net] || 0) + 1; if (tries[F.net] >= 3 && !R.viaInPad && !R.noViaInPad) vip.add(F.id); }
        const sc = score();
        // accept improvements; accept equal-failure moves now and then to wander out of local minima
        if (sc.cost < bs.cost - 1e-6 || (sc.f <= bs.f && rnd() < 0.3)) { if (sc.cost < bestScore.cost - 1e-6) { best = snap(); bestScore = sc; stale = 0; publish(); } else stale++; }
        else { restore(before); stale++; }
      }
      // stuck: restart from the best result with the hardest nets routed first
      if (stale >= 25 || !cand.length) {
        restore(best); stale = 0; attemptNo++; stats.restarts++; hard.clear();
        const fails = new Set(failedJobs().map(j => j.net));
        const keepNets = todo.filter(j => !fails.has(j.net));
        const shuffle = keepNets.map(j => [j, rnd()]).sort((a, b) => a[1] - b[1]).map(x => x[0]);
        for (const j of todo) rip(j.id);
        const ord = todo.filter(j => fails.has(j.net)).concat(attemptNo % 2 ? keepNets.sort((a, b) => a.hpwl - b.hpwl) : shuffle);
        ord.forEach((job, k) => { report(job.net, { done: k, total: ord.length, phase: 'restart' }); commit(job); });
        const sc = score();
        if (sc.cost < bestScore.cost - 1e-6) { best = snap(); bestScore = sc; publish(); }
      }
    }
    restore(best);
    const fin = materialize();
    S.pcb = Object.assign({}, S.pcb, { traces: oldTraces.concat(fin.traces), vias: oldVias.concat(fin.vias), pours: S.pcb.pours || [], holes: S.pcb.holes || [], routed: fin.routed });
    return { routed: Object.keys(fin.routed).length, total: jobs.length, kept_tracks: oldTraces.length, failed: fin.failed, necked_down: fin.necked, vias: fin.vias.length, board: S.board, grid_mm: +g.toFixed(3), seconds: +((Date.now() - t0) / 1000).toFixed(1), passes: attemptNo, ripup_iterations: iter, via_in_pad: todo.filter(j => vip.has(j.id) && fin.routed[j.net]).map(j => j.net), blocked_by_layout: [...hard].filter(n => fin.failed.includes(n)), failed_reason: fin.failed.length ? Object.fromEntries(fin.failed.map(n => [n, hard.has(n)
      ? 'no path even with the other nets ignored: blocked by parts, pads, keep-outs or the board edge' + (R.noViaInPad && !R.viaInPad ? ' (vias may not go on SMD pads — it may need room for a via beside a pin)' : '') + ' — move parts apart or make room'
      : 'no room left between the tracks of the other nets — optimize_pcb, more board area, or narrower rules (preset jlcpcb_free_min)'])) : undefined, search: stats, rules: { preset: R.preset, trace: R.traceWidth, power: R.powerTraceWidth, clearance: R.clearance, via: `${R.viaDiameter}/${R.viaDrill}`, layers: L } };
  }

  // ---------- DRC (exact geometry) ----------
  function segSegDist(a, b, c, d) {
    const inter = (() => {
      const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
      const d1 = o(c, d, a), d2 = o(c, d, b), d3 = o(a, b, c), d4 = o(a, b, d);
      return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
    })();
    if (inter) return 0;
    return Math.min(ptSeg(a, c, d), ptSeg(b, c, d), ptSeg(c, a, b), ptSeg(d, a, b));
  }
  function ptSeg(p, a, b) {
    const vx = b[0] - a[0], vy = b[1] - a[1], l2 = vx * vx + vy * vy;
    let t = l2 ? ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / l2 : 0; t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - a[0] - t * vx, p[1] - a[1] - t * vy);
  }
  const ptRect = (p, r) => Math.hypot(Math.max(0, Math.abs(p[0] - r.cx) - r.hw), Math.max(0, Math.abs(p[1] - r.cy) - r.hh));
  function segRect(a, b, r) {
    const inside = p => Math.abs(p[0] - r.cx) <= r.hw && Math.abs(p[1] - r.cy) <= r.hh;
    if (inside(a) || inside(b)) return 0;
    const C = [[r.cx - r.hw, r.cy - r.hh], [r.cx + r.hw, r.cy - r.hh], [r.cx + r.hw, r.cy + r.hh], [r.cx - r.hw, r.cy + r.hh]];
    let m = Math.min(ptRect(a, r), ptRect(b, r));
    for (let i = 0; i < 4; i++) m = Math.min(m, segSegDist(a, b, C[i], C[(i + 1) % 4]));
    return m;
  }
  // Shapes: {k:'seg',a,b,r} | {k:'circ',c,r} | {k:'rect',cx,cy,hw,hh}
  function shapeDist(A, B) {
    if (A.k === 'rect' && B.k !== 'rect') return shapeDist(B, A);
    if (A.k === 'seg') {
      if (B.k === 'seg') return segSegDist(A.a, A.b, B.a, B.b) - A.r - B.r;
      if (B.k === 'circ') return ptSeg(B.c, A.a, A.b) - A.r - B.r;
      return segRect(A.a, A.b, B) - A.r;
    }
    if (A.k === 'circ') {
      if (B.k === 'seg') return shapeDist(B, A);
      if (B.k === 'circ') return Math.hypot(A.c[0] - B.c[0], A.c[1] - B.c[1]) - A.r - B.r;
      return ptRect(A.c, B) - A.r;
    }
    return Math.hypot(Math.max(0, Math.abs(A.cx - B.cx) - A.hw - B.hw), Math.max(0, Math.abs(A.cy - B.cy) - A.hh - B.hh));
  }
  function padShape(p) {
    if (p.shape === 'round') return { k: 'circ', c: [p.x, p.y], r: p.w / 2 };
    if (p.shape === 'oval') { const r = Math.min(p.w, p.h) / 2, hx = p.w / 2 - r, hy = p.h / 2 - r; return { k: 'seg', a: [p.x - hx, p.y - hy], b: [p.x + hx, p.y + hy], r }; }
    return { k: 'rect', cx: p.x, cy: p.y, hw: p.w / 2, hh: p.h / 2 };
  }
  const bboxOf = s => s.k === 'seg' ? [Math.min(s.a[0], s.b[0]) - s.r, Math.min(s.a[1], s.b[1]) - s.r, Math.max(s.a[0], s.b[0]) + s.r, Math.max(s.a[1], s.b[1]) + s.r]
    : s.k === 'circ' ? [s.c[0] - s.r, s.c[1] - s.r, s.c[0] + s.r, s.c[1] + s.r] : [s.cx - s.hw, s.cy - s.hh, s.cx + s.hw, s.cy + s.hh];

  function drc() {
    const S = Model.S, R = rules(), idx = Model.pinIndex(), cs = placed(), out = [];
    const add = (type, msg, x, y, severity = 'error') => out.push({ type, severity, msg, x: +(+x).toFixed(2), y: +(+y).toFixed(2) });
    for (const w of ruleWarnings(R)) out.push({ type: 'rules', severity: 'warning', msg: w });
    if (!cs.length || !S.board.w) return { violations: out, summary: 'No PCB' };
    const L = R.layers === 1 ? 1 : 2, objs = [];
    let orphan = 0;
    for (const c of cs) for (const p of padsOf(c, idx)) objs.push({ s: padShape(p), net: p.net || '~' + (orphan++), layers: L === 1 ? ['F'] : padCu(p, ['F', 'B']), what: `pad ${p.key}`, drill: p.drill, x: p.x, y: p.y });
    for (const c of cs) if (!fpInside(c)) add('outline', `${c.ref} is outside the board outline`, c.pcb.x, c.pcb.y);
    const pours = S.pcb.pours || [];
    for (let i = 0; i < pours.length; i++) for (let j = i + 1; j < pours.length; j++) {
      const A = pours[i], B = pours[j]; if (A.layer !== B.layer || A.net === B.net) continue;
      const pa = pourPoly(A), pb = pourPoly(B);
      if (pa.some(q => inPoly(q[0], q[1], pb)) || pb.some(q => inPoly(q[0], q[1], pa))) add('pour', `Copper pours ${A.net} and ${B.net} overlap on ${A.layer === 'F' ? 'TopLayer' : 'BottomLayer'} (short)`, pa[0][0], pa[0][1]);
    }
    for (const t of S.pcb.traces) {
      if (t.w < R.minTraceWidth - 1e-6) add('trace-width', `Trace on ${t.net} is ${t.w} mm (fab minimum ${R.minTraceWidth})`, t.pts[0][0], t.pts[0][1]);
      for (let i = 1; i < t.pts.length; i++) objs.push({ s: { k: 'seg', a: t.pts[i - 1], b: t.pts[i], r: t.w / 2 }, net: t.net || '~t' + S.pcb.traces.indexOf(t), layers: [t.layer], what: `trace ${t.net || '(no net)'}`, x: (t.pts[i - 1][0] + t.pts[i][0]) / 2, y: (t.pts[i - 1][1] + t.pts[i][1]) / 2 });
    }
    const costWarned = new Set();
    if (R.minPthRing) for (const c of cs) for (const p of padsOf(c, idx)) if (p.drill && (Math.min(p.w, p.h) - p.drill) / 2 < R.minPthRing - 1e-6)
      add('pad', `Pad ${p.key} ring ${((Math.min(p.w, p.h) - p.drill) / 2).toFixed(2)} < ${R.minPthRing} mm (plated through-hole)`, p.x, p.y, 'warning');
    for (const v of S.pcb.vias) {
      objs.push({ s: { k: 'circ', c: [v.x, v.y], r: v.d / 2 }, net: v.net || '~v' + S.pcb.vias.indexOf(v), layers: ['F', 'B'], what: `via ${v.net || '(no net)'}`, drill: v.drill, x: v.x, y: v.y });
      if (v.drill < R.minViaDrill - 1e-6) add('via', `Via drill ${v.drill} < ${R.minViaDrill} mm`, v.x, v.y);
      if ((v.d - v.drill) / 2 < R.minAnnularRing - 1e-6) add('via', `Via annular ring ${((v.d - v.drill) / 2).toFixed(3)} < ${R.minAnnularRing} mm`, v.x, v.y);
      if (costsExtra(v) && !costWarned.has(v.d + '/' + v.drill)) { costWarned.add(v.d + '/' + v.drill); add('via-cost', costNote(v), v.x, v.y, 'warning'); }
      // via on an SMD pad of its own net: solder wicks into the hole (needs filled/capped vias at the fab)
      if (!R.viaInPad) for (const c of cs) for (const p of padsOf(c, idx)) {
        if (p.drill || p.net !== v.net || padDist(p, v.x, v.y) >= v.d / 2) continue;
        const big = p.ep && Math.min(p.w, p.h) >= 2 * v.d + 0.4, depth = Math.min(p.w / 2 - Math.abs(v.x - p.x), p.h / 2 - Math.abs(v.y - p.y));
        if (big && depth >= v.d / 2 + 0.15) continue; // thermal via well inside an exposed pad
        add('via-in-pad', `${R.noViaInPad ? 'Not allowed (rule: no via in pad): via' : 'Via'} on SMD pad ${p.key} (${v.net}) — solder wicks into the hole. ${Model.isGround(v.net) ? 'Add a GND copper pour (⬛ Pour GND) and route again — the pour connects GND without these vias — or' : 'Route again /'} ✨ Optimize to make room, or allow via-in-pad in the rules (filled vias cost extra at JLCPCB)`, v.x, v.y, R.noViaInPad ? 'error' : 'warning');
      }
    }
    (S.pcb.holes || []).forEach((h, i) => objs.push({ s: { k: 'circ', c: [h.x, h.y], r: h.d / 2 }, net: '~hole' + i, layers: ['F', 'B'], what: `mounting hole ${i + 1}`, drill: h.d, x: h.x, y: h.y }));
    const boxes = objs.map(o => bboxOf(o.s));
    // Trace copper that lies inside a pad of the same net adds no copper: measure only the part outside own pads.
    const padsByNet = {};
    for (const o of objs) if (o.what.startsWith('pad')) (padsByNet[o.net] = padsByNet[o.net] || []).push(o.s);
    const inside = (net, c, r) => (padsByNet[net] || []).some(p => p.k === 'rect' ? Math.abs(c[0] - p.cx) <= p.hw - r + 1e-6 && Math.abs(c[1] - p.cy) <= p.hh - r + 1e-6
      : p.k === 'circ' ? Math.hypot(c[0] - p.c[0], c[1] - p.c[1]) <= p.r - r + 1e-6 : ptSeg(c, p.a, p.b) <= p.r - r + 1e-6);
    function refine(A, B, d0) {
      const [T, O] = A.s.k === 'seg' && A.what.startsWith('trace') ? [A, B] : [B, A];
      const { a, b, r } = T.s, len = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.max(1, Math.ceil(len / 0.02));
      let m = Infinity;
      for (let k = 0; k <= n; k++) {
        const c = [a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n];
        if (inside(T.net, c, r)) continue;
        m = Math.min(m, shapeDist({ k: 'circ', c, r }, O.s));
      }
      return m === Infinity ? Infinity : Math.max(m, d0);
    }
    // board edge
    const bpoly = boardPoly(), rectB = isRectBoard();
    objs.forEach((o, i) => {
      const b = boxes[i], d = rectB ? Math.min(b[0], b[1], S.board.w - b[2], S.board.h - b[3]) : edgeDist(o.s, bpoly);
      if (d < R.edgeClearance - 1e-3) add('edge', `${o.what} is ${Math.max(0, d).toFixed(3)} mm from the board edge (rule ${R.edgeClearance})`, o.x, o.y, d < R.minEdgeClearance ? 'error' : 'warning');
    });
    // copper clearance + hole spacing
    const seen = new Set(), cl = R.clearance;
    const order = objs.map((o, i) => i).sort((a, b) => boxes[a][0] - boxes[b][0]);
    for (let ii = 0; ii < order.length; ii++) {
      const i = order[ii], A = objs[i], ba = boxes[i];
      for (let jj = ii + 1; jj < order.length; jj++) {
        const j = order[jj], bb = boxes[j];
        if (bb[0] > ba[2] + Math.max(cl, R.minHoleToHole) + 2) break;
        if (bb[1] > ba[3] + cl + 2 || bb[3] < ba[1] - cl - 2) continue;
        const B = objs[j];
        if (A.drill && B.drill && A.what !== B.what) {
          const hd = Math.hypot(A.x - B.x, A.y - B.y) - A.drill / 2 - B.drill / 2;
          if (hd < R.minHoleToHole - 1e-3 && hd > -1e-6 && !(A.what.startsWith('pad') && B.what.startsWith('pad') && A.what.split('.')[0] === B.what.split('.')[0]))
            add('hole', `Holes ${A.what} / ${B.what} are ${hd.toFixed(3)} mm apart (minimum ${R.minHoleToHole})`, (A.x + B.x) / 2, (A.y + B.y) / 2, 'warning');
        }
        if (A.net === B.net || !A.layers.some(l => B.layers.includes(l))) continue;
        let d = shapeDist(A.s, B.s);
        if (d < cl - 1e-3 && (A.s.k === 'seg' && A.what.startsWith('trace') || B.s.k === 'seg' && B.what.startsWith('trace'))) d = refine(A, B, d);
        if (d < cl - 1e-3) {
          const key = [A.what, B.what].sort().join('|'); if (seen.has(key)) continue; seen.add(key);
          const both = A.what.startsWith('pad') && B.what.startsWith('pad');
          add(d <= 0 ? 'short' : 'clearance', `${d <= 0 ? 'Short' : 'Clearance ' + d.toFixed(3) + ' mm'} between ${A.what} and ${B.what} (rule ${cl})`, (A.x + B.x) / 2, (A.y + B.y) / 2,
            both ? 'warning' : (d < R.minClearance || d <= 0 ? 'error' : 'warning'));
        }
      }
    }
    // keep-out areas
    for (const k of keepouts()) {
      const tag = `keep-out "${k.name}"`;
      // track copper inside a pad of its own net adds nothing: a track may reach a pad that lies in the keep-out
      const kPads = cs.flatMap(c => padsOf(c, idx));
      if (k.tracks) S.pcb.traces.forEach(t => {
        if (!koOn(k, t.layer)) return;
        const own = kPads.filter(p => p.net && p.net === t.net && padCu(p, ['F', 'B']).includes(t.layer));
        for (let i = 1; i < t.pts.length; i++) {
          const a = t.pts[i - 1], b = t.pts[i], m = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 0.1));
          for (let j = 0; j <= m; j++) {
            const x = a[0] + (b[0] - a[0]) * j / m, y = a[1] + (b[1] - a[1]) * j / m;
            if (koDist(k, x, y) >= t.w / 2 - 1e-3 || own.some(p => padDist(p, x, y) <= 0)) continue;
            add('keepout', `Track ${t.net || '(no net)'} enters ${tag}`, x, y); return;
          }
        }
      });
      if (k.vias) for (const v of S.pcb.vias) if (koDist(k, v.x, v.y) < v.d / 2 - 1e-3) add('keepout', `Via ${v.net || '(no net)'} inside ${tag}`, v.x, v.y);
      if (k.parts) for (const c of cs) {
        if (!koOn(k, isBottom(c) ? 'B' : 'F')) continue;
        const b = fpBox(c), hit = [...Array(25)].some((_, q) => inPoly(b[0] + (b[2] - b[0]) * (q % 5) / 4, b[1] + (b[3] - b[1]) * Math.floor(q / 5) / 4, k.pts)) || k.pts.some(([x, y]) => x > b[0] && x < b[2] && y > b[1] && y < b[3]);
        if (hit) add('keepout', `Part ${c.ref} is inside ${tag}`, c.pcb.x, c.pcb.y);
      }
    }
    const st = status();
    for (const n of st.unrouted) out.push({ type: 'unrouted', severity: 'error', msg: `Net ${n} is not routed (connection error — the board would not work)` });
    // silkscreen text over pads: the fab removes silkscreen from exposed copper, so the text would be cut
    for (const side of ['F', 'B']) for (const l of silkLabels(side)) if (l.overPads) {
      const [x, y] = labelCentre(l), what = l.kind === 'part' ? `label of ${l.ref}` : l.kind === 'board' ? 'board name' : `text "${l.text}"`;
      add('silk', `Silkscreen ${what} covers pads (${side === 'F' ? 'top' : 'bottom'}) — move it (drag it, or set_silk_label / update_pcb_text)`, x, y, 'warning');
    }
    const errors = out.filter(v => v.severity === 'error').length, warnings = out.length - errors;
    return { violations: out, errors, warnings, summary: errors ? `${errors} errors, ${warnings} warnings` : warnings ? `0 errors, ${warnings} warnings` : 'DRC passed' };
  }

  // Which pads of each net are joined by copper (pads, tracks, vias that touch on a shared layer).
  let connMemo = { key: null, val: null };
  function connectivity() {
    const S = Model.S;
    const key = JSON.stringify([S.pcb, S.board, S.nets, S.rules, S.components.map(c => [c.ref, c.pcb, c.footprint, c.lcsc])]);
    if (connMemo.key === key) return connMemo.val;
    const idx = Model.pinIndex(), L2 = (rules().layers === 1) ? ['F'] : ['F', 'B'];
    const nodes = [];
    for (const c of placed()) for (const p of padsOf(c, idx)) if (p.net) nodes.push({ k: 'pad', p, net: p.net, layers: padCu(p, L2), shapes: [padShape(p)] });
    S.pcb.traces.forEach((t, i) => { if (t.net) nodes.push({ k: 'trace', i, net: t.net, layers: [t.layer], shapes: t.pts.slice(1).map((q, j) => ({ k: 'seg', a: t.pts[j], b: q, r: t.w / 2 })) }); });
    S.pcb.vias.forEach((v, i) => { if (v.net) nodes.push({ k: 'via', i, net: v.net, layers: L2, shapes: [{ k: 'circ', c: [v.x, v.y], r: v.d / 2 }] }); });
    // copper pours: each connected island of a pour is a node; same-net copper touching the island joins it
    const pourNodes = [];
    (S.pcb.pours || []).forEach((pr, pi) => {
      if (!S.nets[pr.net] || !L2.includes(pr.layer)) return;
      const ras = pourRaster(pr), first = nodes.length;
      for (let k = 1; k <= ras.islands; k++) nodes.push({ k: 'pour', net: pr.net, layers: [pr.layer], shapes: [], pour: pi, island: k });
      pourNodes.push({ pr, ras, first });
    });
    const par = nodes.map((_, i) => i), find = i => { while (par[i] !== i) i = par[i] = par[par[i]]; return i; };
    const samples = sh => {
      const out = [];
      if (sh.k === 'circ') out.push(sh.c);
      else if (sh.k === 'rect') { for (let x = -1; x <= 1; x++) for (let y = -1; y <= 1; y++) out.push([sh.cx + x * sh.hw * 0.8, sh.cy + y * sh.hh * 0.8]); }
      else { const n = Math.max(1, Math.ceil(Math.hypot(sh.b[0] - sh.a[0], sh.b[1] - sh.a[1]) / 0.2)); for (let k = 0; k <= n; k++) out.push([sh.a[0] + (sh.b[0] - sh.a[0]) * k / n, sh.a[1] + (sh.b[1] - sh.a[1]) * k / n]); }
      return out;
    };
    for (const { pr, ras, first } of pourNodes) nodes.forEach((n, i) => {
      if (n.k === 'pour' || n.net !== pr.net || !n.layers.includes(pr.layer)) return;
      for (const sh of n.shapes) for (const q of samples(sh)) { const lab = ras.at(q[0], q[1]); if (lab) { const a = find(i), b = find(first + lab - 1); if (a !== b) par[a] = b; } }
    });
    const byNet = {};
    nodes.forEach((n, i) => (byNet[n.net] = byNet[n.net] || []).push(i));
    for (const ids of Object.values(byNet)) {
      const boxes = ids.map(i => { let b = [Infinity, Infinity, -Infinity, -Infinity]; for (const sh of nodes[i].shapes) { const q = bboxOf(sh); b = [Math.min(b[0], q[0]), Math.min(b[1], q[1]), Math.max(b[2], q[2]), Math.max(b[3], q[3])]; } return b; });
      for (let a = 0; a < ids.length; a++) for (let b = a + 1; b < ids.length; b++) {
        const A = nodes[ids[a]], B = nodes[ids[b]], ba = boxes[a], bb = boxes[b];
        if (!A.shapes.length || !B.shapes.length) continue;
        if (ba[0] > bb[2] + 0.01 || bb[0] > ba[2] + 0.01 || ba[1] > bb[3] + 0.01 || bb[1] > ba[3] + 0.01) continue;
        if (!A.layers.some(l => B.layers.includes(l)) || find(ids[a]) === find(ids[b])) continue;
        if (A.shapes.some(sa => B.shapes.some(sb => shapeDist(sa, sb) <= 0.002))) par[find(ids[a])] = find(ids[b]);
      }
    }
    const out = {};
    for (const [net, ids] of Object.entries(byNet)) {
      const pads = ids.filter(i => nodes[i].k === 'pad').map(i => nodes[i].p); if (pads.length < 2) continue;
      const groups = {};
      ids.forEach(i => { if (nodes[i].k === 'pad') (groups[find(i)] = groups[find(i)] || []).push(nodes[i].p); });
      const g = Object.values(groups);
      out[net] = { pads, groups: g, complete: g.length === 1 };
    }
    connMemo = { key, val: out };
    return out;
  }
  // Ratsnest: shortest lines that would join the still-separate copper islands of each net.
  function ratsnest(conn = connectivity()) {
    const lines = [];
    for (const [net, c] of Object.entries(conn)) {
      if (c.complete) continue;
      const islands = c.groups.map(g => g.slice()), joined = [islands.shift()];
      while (islands.length) {
        let best = null;
        islands.forEach((isl, i) => { for (const a of isl) for (const J of joined) for (const b of J) { const d = Math.hypot(a.x - b.x, a.y - b.y); if (!best || d < best.d) best = { d, i, a, b }; } });
        lines.push({ net, a: best.a, b: best.b }); joined.push(islands.splice(best.i, 1)[0]);
      }
    }
    return lines;
  }
  // ---------- manual tracks: the copilots draw them like the Route tool (pad / point / via, corner by corner) ----------
  const LAYER = v => v === 'B' || /^b(ot|ottom)?$/i.test(String(v || '')) ? 'B' : v === 'F' || /^(t|top|f|front)$/i.test(String(v || '')) ? 'F' : null;
  // "U1.2" / "U1.VCC" → the pad (pads with the same pin: the one nearest to `near`)
  function findPad(ref, near) {
    const s = String(ref).trim(), d = s.indexOf('.'), c = Model.comp(s.slice(0, d));
    if (d < 0 || !c) throw new Error(`No pad "${s}" — use REF.PIN, e.g. R1.1 or U1.VCC`);
    if (!c.pcb) throw new Error(`${c.ref} is not on the PCB`);
    const pads = padsOf(c, Model.pinIndex()), want = s.slice(d + 1);
    let nums; try { nums = Model.resolvePins(s).map(k => k.slice(k.lastIndexOf('.') + 1)); } catch (e) { nums = []; }
    let hit = pads.filter(p => nums.includes(p.num) || (c.pinAlias && nums.includes(c.pinAlias[p.num])));
    if (!hit.length) hit = pads.filter(p => p.num === want);
    if (!hit.length) throw new Error(`${c.ref} has no pad "${want}". Pads: ${pads.map(p => p.num).join(', ')}`);
    if (near) hit.sort((a, b) => Math.hypot(a.x - near[0], a.y - near[1]) - Math.hypot(b.x - near[0], b.y - near[1]));
    return hit[0];
  }
  // points: "REF.PIN" | [x, y] | {x, y, via?, layer?}; a via (or a new layer) at a point switches layer there
  function addTrack(o = {}) {
    const S = Model.S, R = rules(), pts = Array.isArray(o.points) ? o.points : [];
    if (!S.board.w) throw new Error('No PCB yet — call generate_pcb (or place_footprints) first');
    if (pts.length < 2) throw new Error('points needs at least 2 entries (pads like "U1.2" or [x, y] in board mm)');
    let net = o.net || null, layer = LAYER(o.layer);
    const steps = [];
    for (let i = 0; i < pts.length; i++) {
      const q = pts[i], prev = steps.length ? [steps[steps.length - 1].x, steps[steps.length - 1].y] : null;
      if (typeof q === 'string') {
        const p = findPad(q, prev);
        if (p.net && net && p.net !== net) throw new Error(`${p.key} is on net ${p.net}, the track is on ${net}`);
        if (!net) net = p.net || null;
        steps.push({ x: p.x, y: p.y, pad: p });
      } else {
        const x = +(Array.isArray(q) ? q[0] : q.x), y = +(Array.isArray(q) ? q[1] : q.y);
        if (!isFinite(x) || !isFinite(y)) throw new Error(`Point ${i + 1} is not a pad or [x, y]`);
        steps.push({ x, y, via: !Array.isArray(q) && !!q.via, layer: Array.isArray(q) ? null : LAYER(q.layer) });
      }
    }
    if (!net) throw new Error('Which net? Start or end on a pad, or give net');
    if (!S.nets[net]) throw new Error(`No net "${net}"`);
    if (!layer) { const sp = steps.find(s => s.pad && s.pad.layer); layer = sp ? sp.pad.layer : 'F'; }
    if (R.layers === 1 && (layer === 'B' || steps.some(s => s.via || s.layer === 'B'))) throw new Error('The board has 1 copper layer — no vias or bottom tracks');
    const w = +(o.width || netWidth(R, net)), corner = o.corner === '90' || o.corner === 90 ? 90 : o.corner === '45' || o.corner === 45 ? 45 : 0;
    // optional knee between two points: 45° (diagonal first, then straight) or 90° (x first, then y)
    const knee = (a, b) => {
      const dx = b[0] - a[0], dy = b[1] - a[1];
      if (!corner || Math.abs(dx) < 1e-6 || Math.abs(dy) < 1e-6 || (corner === 45 && Math.abs(Math.abs(dx) - Math.abs(dy)) < 1e-6)) return [];
      if (corner === 90) return [[b[0], a[1]]];
      const m = Math.min(Math.abs(dx), Math.abs(dy)); return [[+(a[0] + Math.sign(dx) * m).toFixed(4), +(a[1] + Math.sign(dy) * m).toFixed(4)]];
    };
    const out = [], vias = [];
    let cur = { layer, pts: [[steps[0].x, steps[0].y]] };
    for (let i = 1; i < steps.length; i++) {
      const s = steps[i], last = cur.pts[cur.pts.length - 1], b = [s.x, s.y];
      for (const k of knee(last, b)) cur.pts.push(k);
      cur.pts.push(b);
      if (s.pad && s.pad.layer && s.pad.layer !== cur.layer) throw new Error(`${s.pad.key} is an SMD pad on the ${s.pad.layer === 'F' ? 'top' : 'bottom'} layer but the track is on the ${cur.layer === 'F' ? 'top' : 'bottom'} here — put {x, y, via: true} before it`);
      const to = s.via ? (s.layer || (cur.layer === 'F' ? 'B' : 'F')) : s.layer;
      if (to && to !== cur.layer && i < steps.length - 1) {
        out.push(cur); if (!s.pad || !s.pad.drill) vias.push({ net, x: s.x, y: s.y, d: R.viaDiameter, drill: R.viaDrill, manual: true });
        cur = { layer: to, pts: [b] };
      }
    }
    out.push(cur);
    if (steps[0].pad && steps[0].pad.layer && steps[0].pad.layer !== out[0].layer) throw new Error(`${steps[0].pad.key} is an SMD pad on the ${steps[0].pad.layer === 'F' ? 'top' : 'bottom'} layer — start on that layer`);
    const before = new Set(drc().violations.map(v => v.msg)), first = S.pcb.traces.length;
    for (const t of out) { const p = t.pts.filter((q, k) => !k || Math.hypot(q[0] - t.pts[k - 1][0], q[1] - t.pts[k - 1][1]) > 1e-6).map(q => [+(+q[0]).toFixed(4), +(+q[1]).toFixed(4)]); if (p.length >= 2) S.pcb.traces.push({ net, layer: t.layer, w: +w.toFixed(4), pts: p, manual: true }); }
    for (const v of vias) { const bad = viaPadProblem(v, R); if (bad) throw new Error(bad); }
    for (const v of vias) S.pcb.vias.push(v);
    const tracks = []; for (let i = first; i < S.pcb.traces.length; i++) tracks.push(i);
    const d = drc(), fresh = d.violations.filter(v => !before.has(v.msg) && v.type !== 'unrouted').slice(0, 20), c = connectivity()[net];
    return { net, tracks, vias: vias.length, width: +w.toFixed(4), layers: out.map(t => t.layer === 'F' ? 'top' : 'bottom'), net_complete: !!(c && c.complete), islands_left: c ? c.groups.length : 0, new_drc_problems: fresh, note: fresh.length ? 'This track breaks design rules — move its corners (remove_tracks, then add_track again) or undo' : undefined };
  }
  // a via must keep its clearance from SMD pads (except thermal vias inside an exposed pad), unless via-in-pad is allowed
  function viaPadProblem(v, R = rules()) {
    if (R.viaInPad) return null;
    const idx = Model.pinIndex(), on = [];
    for (const c of placed()) for (const p of padsOf(c, idx)) {
      if (p.drill || padDist(p, v.x, v.y) >= v.d / 2 + (p.net === v.net ? 0 : R.clearance)) continue;
      if (p.ep && p.net === v.net && Math.min(p.w / 2 - Math.abs(v.x - p.x), p.h / 2 - Math.abs(v.y - p.y)) >= v.d / 2 + 0.15) continue;   // thermal via in an exposed pad
      on.push(p.key);
    }
    return on.length ? `Via at (${v.x}, ${v.y}) touches SMD pad ${on.join(', ')} — move it at least ${(v.d / 2 + R.clearance).toFixed(2)} mm from the pad edge (rule: no via in pad)` : null;
  }
  function addVia(o = {}) {
    const S = Model.S, R = rules();
    if (R.layers === 1) throw new Error('The board has 1 copper layer — no vias');
    const x = +o.x, y = +o.y; if (!isFinite(x) || !isFinite(y)) throw new Error('x and y (board mm) are needed');
    if (o.net && !S.nets[o.net]) throw new Error(`No net "${o.net}"`);
    const v = { net: o.net || null, x: +x.toFixed(4), y: +y.toFixed(4), d: +(o.diameter || R.viaDiameter), drill: +(o.drill || R.viaDrill), manual: true };
    const bad = viaPadProblem(v, R); if (bad) throw new Error(bad);
    S.pcb.vias.push(v);
    return Object.assign({ index: S.pcb.vias.length - 1 }, costsExtra(v) ? { note: costNote(v) } : {});
  }
  const trackLen = t => { let l = 0; for (let i = 1; i < t.pts.length; i++) l += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]); return +l.toFixed(2); };
  function trackList(o = {}) {
    const S = Model.S, f = x => !o.net || x.net === o.net;
    return {
      tracks: S.pcb.traces.map((t, i) => [i, t]).filter(([, t]) => f(t)).map(([i, t]) => ({ index: i, net: t.net, layer: t.layer === 'B' ? 'bottom' : 'top', width: t.w, points: t.pts, length_mm: trackLen(t), manual: !!t.manual })),
      vias: S.pcb.vias.map((v, i) => [i, v]).filter(([, v]) => f(v)).map(([i, v]) => ({ index: i, net: v.net, x: v.x, y: v.y, diameter: v.d, drill: v.drill, manual: !!v.manual })),
    };
  }
  // by index list, by net, or only the autorouter's / only hand-drawn ones
  function removeTracks(o = {}) {
    const S = Model.S, ti = new Set((o.tracks || []).map(Number)), vi = new Set((o.vias || []).map(Number));
    const by = x => (o.net ? x.net === o.net : true) && (o.only === 'manual' ? !!x.manual : o.only === 'auto' ? !x.manual : true);
    const all = !ti.size && !vi.size && (o.net || o.only || o.all);
    if (!ti.size && !vi.size && !all) throw new Error('Give tracks / vias (indexes), net, only or all: true');
    const nt = S.pcb.traces.length, nv = S.pcb.vias.length;
    S.pcb.traces = S.pcb.traces.filter((t, i) => !(ti.has(i) || (all && by(t))));
    S.pcb.vias = S.pcb.vias.filter((v, i) => !(vi.has(i) || (all && by(v))));
    const conn = connectivity(); if (S.pcb.routed) for (const n of Object.keys(S.pcb.routed)) if (!conn[n] || !conn[n].complete) delete S.pcb.routed[n];
    return { removed_tracks: nt - S.pcb.traces.length, removed_vias: nv - S.pcb.vias.length, note: 'Track and via indexes after the removed ones moved down — call get_tracks again' };
  }

  function status(conn = connectivity()) {
    const S = Model.S, nets = Object.keys(conn), routed = nets.filter(n => conn[n].complete);
    let len = 0; for (const t of S.pcb.traces) for (let i = 1; i < t.pts.length; i++) len += Math.hypot(t.pts[i][0] - t.pts[i - 1][0], t.pts[i][1] - t.pts[i - 1][1]);
    return { placed: placed().length, components: S.components.length, board: S.board, nets: nets.length, routed: routed.length, unrouted: nets.filter(n => !conn[n].complete), vias: S.pcb.vias.length, trace_length_mm: +len.toFixed(1) };
  }

  // ---------- fabrication outputs ----------
  // ---------- silkscreen text (Gerber has no fonts: a simple stroke font, glyphs on a 4 × 6 grid, y up) ----------
  const GLYPHS = {
    '0': '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0', '1': '1,5 2,6 2,0|1,0 3,0', '2': '0,5 1,6 3,6 4,5 4,4 0,0 4,0',
    '3': '0,5 1,6 3,6 4,5 4,4 3,3 4,2 4,1 3,0 1,0 0,1|1,3 3,3', '4': '3,0 3,6 0,2 4,2', '5': '4,6 0,6 0,3 3,3 4,2 4,1 3,0 0,0',
    '6': '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,2 3,3 0,3', '7': '0,6 4,6 1,0', '8': '1,3 0,4 0,5 1,6 3,6 4,5 4,4 3,3 1,3 0,2 0,1 1,0 3,0 4,1 4,2 3,3',
    '9': '0,1 1,0 3,0 4,1 4,5 3,6 1,6 0,5 0,4 1,3 4,3',
    A: '0,0 0,4 2,6 4,4 4,0|0,3 4,3', B: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|3,3 4,2 4,1 3,0 0,0', C: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1',
    D: '0,0 0,6 2,6 4,4 4,2 2,0 0,0', E: '4,6 0,6 0,0 4,0|0,3 3,3', F: '4,6 0,6 0,0|0,3 3,3', G: '4,5 3,6 1,6 0,5 0,1 1,0 3,0 4,1 4,3 2,3',
    H: '0,0 0,6|4,0 4,6|0,3 4,3', I: '1,6 3,6|2,6 2,0|1,0 3,0', J: '4,6 4,1 3,0 1,0 0,1', K: '0,0 0,6|4,6 0,2|1,3 4,0', L: '0,6 0,0 4,0',
    M: '0,0 0,6 2,3 4,6 4,0', N: '0,0 0,6 4,0 4,6', O: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0', P: '0,0 0,6 3,6 4,5 4,4 3,3 0,3',
    Q: '1,0 0,1 0,5 1,6 3,6 4,5 4,1 3,0 1,0|2,2 4,0', R: '0,0 0,6 3,6 4,5 4,4 3,3 0,3|2,3 4,0', S: '4,5 3,6 1,6 0,5 0,4 1,3 3,3 4,2 4,1 3,0 1,0 0,1',
    T: '0,6 4,6|2,6 2,0', U: '0,6 0,1 1,0 3,0 4,1 4,6', V: '0,6 2,0 4,6', W: '0,6 1,0 2,3 3,0 4,6', X: '0,0 4,6|0,6 4,0', Y: '0,6 2,3 4,6|2,3 2,0',
    Z: '0,6 4,6 0,0 4,0', '-': '1,3 3,3', '_': '0,0 4,0', '.': '1.8,0 2.2,0 2.2,0.4 1.8,0.4 1.8,0', '+': '2,1.5 2,4.5|0.5,3 3.5,3', '/': '0,0 4,6',
    '(': '3,6 2,5 2,1 3,0', ')': '1,6 2,5 2,1 1,0', ':': '1.8,1 2.2,1|1.8,4 2.2,4', '#': '1,0 1,6|3,0 3,6|0,2 4,2|0,4 4,4', ',': '2,0.5 1.4,-0.8',
    '?': '0,5 1,6 3,6 4,5 4,4 2,3 2,2|2,0 2,0.4', '=': '0.5,2 3.5,2|0.5,4 3.5,4', '*': '2,1 2,5|0.5,2 3.5,4|0.5,4 3.5,2', "'": '2,6 2,4.5',
  };
  const ADV = 5.5;   // grid units per character (glyph 4 + gap 1.5)
  const parsed = {};   // glyph strings → stroke point arrays, parsed once
  const glyph = ch => parsed[ch] || (parsed[ch] = ch === ' ' ? [] : (GLYPHS[ch] != null ? GLYPHS[ch] : GLYPHS['?']).split('|').map(st => st.split(' ').map(p => p.split(',').map(Number))));
  // text → polylines in board mm (y down). x / y: anchor point on the baseline; mirror: read from the bottom side
  function strokeText(str, x, y, h, anchor = 'start', mirror = false) {
    const u = h / 6, s = String(str).toUpperCase(), width = Math.max(0, s.length * ADV - 1.5) * u;
    const x0 = anchor === 'middle' ? x - width / 2 : anchor === 'end' ? x - width : x, out = [];
    const mid = 2 * (x0 + width / 2);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i], g = glyph(ch);
      for (const stroke of g) out.push(stroke.map(([gx, gy]) => { let px = x0 + (i * ADV + gx) * u; if (mirror) px = mid - px; return [Math.round(px * 1e4) / 1e4, Math.round((y - gy * u) * 1e4) / 1e4]; }));
    }
    return out;
  }
  const textWidth = (str, h) => Math.max(0, String(str).length * ADV - 1.5) * h / 6;
  // the silkscreen labels of one side (also drawn by the 3D view): each part's reference above its outline (below it
  // when there is no room at the board edge), mirrored on the bottom side, and the board name in the bottom-right corner
  const SILK_H = 1.0, SILK_W = 0.15;   // JLCPCB minimum text: 1 mm high, 0.15 mm line
  // Silkscreen text of one side (Gerber, 2D and 3D all draw this list):
  //  - each part's label (default: its reference) — placed automatically next to the part where it covers no pad,
  //    no other part and no other label, or where the user / AI put it (c.pcb.silk = { dx, dy, h, text, hide },
  //    dx / dy = label centre relative to the part, so it moves with the part)
  //  - the board name (S.pcb.boardLabel = { x, y, h, text, hide }) in a free corner of the top side
  //  - free text items (S.pcb.texts = [{ text, x, y, h, side }]) where they were put
  // Each entry: { kind: 'part' | 'board' | 'text', ref / i, text, x, y (baseline), h, w, anchor, mirror, auto, overPads, rect, lines }
  function padRects(side) {
    const out = [], idx = null;
    for (const c of placed()) for (const p of padsOf(c, idx)) if (p.drill || (p.layer || 'F') === side) out.push([p.x - p.w / 2 - 0.15, p.y - p.h / 2 - 0.15, p.x + p.w / 2 + 0.15, p.y + p.h / 2 + 0.15]);
    return out;
  }
  const overlap = (r, b) => r[0] < b[2] && r[2] > b[0] && r[1] < b[3] && r[3] > b[1];
  // text rotation: degrees counter-clockwise (as seen on the screen), about the centre of the text
  const rotPt = (x, y, cx, cy, deg) => { const a = -deg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), dx = x - cx, dy = y - cy; return [cx + dx * c - dy * s, cy + dx * s + dy * c]; };
  function rotRect(r, deg) {
    if (!deg) return r;
    const cx = (r[0] + r[2]) / 2, cy = (r[1] + r[3]) / 2, q = [[r[0], r[1]], [r[2], r[1]], [r[2], r[3]], [r[0], r[3]]].map(([x, y]) => rotPt(x, y, cx, cy, deg));
    return [Math.min(...q.map(p => p[0])), Math.min(...q.map(p => p[1])), Math.max(...q.map(p => p[0])), Math.max(...q.map(p => p[1]))];
  }
  const normRot = v => ((Math.round(+v || 0) % 360) + 360) % 360;
  // label rectangle for an anchor point (x, baseline y), with a small gap around the text
  const labelRect0 = (x, y, tw, h, anchor) => { const x0 = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x; return [x0 - 0.1, y - h - 0.1, x0 + tw + 0.1, y + 0.1]; };
  const labelRect = labelRect0;
  // the 2D view redraws often: keep the result until something that affects the labels changes
  const silkCache = {};
  function silkLabels(side) {
    const S = Model.S, key = JSON.stringify([S.board.w, S.board.h, S.name, S.pcb.boardLabel, S.pcb.texts, placed().map(c => [c.ref, c.footprint, c.pcb.x, c.pcb.y, c.pcb.rot, c.pcb.side, c.pcb.silk])]);
    if (silkCache[side] && silkCache[side].key === key) return silkCache[side].out;
    const out = silkLabelsRaw(side);
    silkCache[side] = { key, out };
    return out;
  }
  function silkLabelsRaw(side) {
    const S = Model.S, W = S.board.w, H = S.board.h, out = [], cs = placed().filter(c => (isBottom(c) ? 'B' : 'F') === side);
    const boxes = cs.map(c => fpBox(c)), pads = padRects(side), taken = [];
    // spatial grid (2 mm cells) so each candidate spot is only checked against nearby pads, parts and labels
    const G = 2, cells = (r, f) => { const x1 = Math.floor(r[2] / G), y0 = Math.floor(r[1] / G), y1 = Math.floor(r[3] / G); for (let gx = Math.floor(r[0] / G); gx <= x1; gx++) for (let gy = y0; gy <= y1; gy++) if (f(gx * 4096 + gy)) return true; return false; };
    const grid = { pad: new Map(), box: new Map(), lbl: new Map() };
    const put = (m, r, v) => cells(r, k => { (m.get(k) || m.set(k, []).get(k)).push(v); return false; });
    pads.forEach(r => put(grid.pad, r, r)); boxes.forEach((r, i) => put(grid.box, r, i));
    const near = (m, r, f) => cells(r, k => { const a = m.get(k); if (a) for (let j = 0; j < a.length; j++) if (f(a[j])) return true; return false; });
    const offBoard = r => r[0] < 0.2 || r[1] < 0.2 || r[2] > W - 0.2 || r[3] > H - 0.2;
    const onPads = r => near(grid.pad, r, b => overlap(r, b));
    const onLabels = r => near(grid.lbl, r, b => overlap(r, b));
    const hit = (r, skip) => offBoard(r) || onPads(r) || near(grid.box, r, i => i !== skip && overlap(r, boxes[i])) || onLabels(r);
    const add = (o) => { o.rot = normRot(o.rot); o.rect0 = labelRect(o.x, o.y, textWidth(o.text, o.h), o.h, o.anchor); o.rect = rotRect(o.rect0, o.rot); o.overPads = onPads(o.rect); taken.push(o.rect); put(grid.lbl, o.rect, o.rect); out.push(o); };
    // free text first: fixed positions the automatic labels must avoid
    (S.pcb.texts || []).forEach((t, i) => { if ((t.side || 'F') !== side || !String(t.text || '').trim()) return; const h = +t.h || 1.2; add({ kind: 'text', i, text: String(t.text), x: +t.x, y: +t.y + h / 2, h, w: Math.max(SILK_W, h * 0.13), anchor: 'middle', mirror: side === 'B', auto: false, rot: t.rot }); });
    // labels the user / AI placed by hand
    const manual = cs.filter(c => c.pcb.silk && c.pcb.silk.dx != null && !c.pcb.silk.hide);
    for (const c of manual) { const L = c.pcb.silk, h = +L.h || SILK_H; add({ kind: 'part', ref: c.ref, text: String(L.text || c.ref), x: c.pcb.x + L.dx, y: c.pcb.y + L.dy + h / 2, h, w: Math.max(SILK_W, h * 0.13), anchor: 'middle', mirror: side === 'B', auto: false, rot: L.rot }); }
    cs.forEach((c, i) => {
      const L = c.pcb.silk || {}; if (L.hide || L.dx != null) return;
      const b = boxes[i], h = +L.h || SILK_H, text = String(L.text || c.ref), tw0 = textWidth(text, h), cx = (b[0] + b[2]) / 2, cy = (b[1] + b[3]) / 2, rot = normRot(L.rot);
      const labelRect = (x, y, tw, hh, a) => rotRect(labelRect0(x, y, tw, hh, a), rot), tw = tw0;
      const tries = [[cx, b[1] - 0.35, 'middle'], [cx, b[3] + 0.35 + h, 'middle'], [b[0] - 0.35, cy + h / 2, 'end'], [b[2] + 0.35, cy + h / 2, 'start'],
        [cx, b[1] - 1.2, 'middle'], [cx, b[3] + 1.2 + h, 'middle']];   // a little further out when the near spots are taken
      let pick = tries.find(([x, y, a]) => !hit(labelRect(x, y, tw, h, a), i));
      // big part with no free spot around it: inside its outline, where there are no pads
      if (!pick && b[2] - b[0] > tw + 0.6 && b[3] - b[1] > h + 0.6) { const r = labelRect(cx, cy + h / 2, tw, h, 'middle'); if (!onPads(r)) pick = [cx, cy + h / 2, 'middle']; }
      // otherwise search rings around the part (up to 4 mm out): first a spot clear of everything, then one that only
      // crosses part outlines — never pads
      if (!pick) {
        const ring = [];
        for (let d = 0.6; d <= 4.01; d += 0.5) for (let k = 0; k < 12; k++) { const a = k / 12 * 2 * Math.PI, rx = (b[2] - b[0]) / 2 + d + tw / 2, ry = (b[3] - b[1]) / 2 + d + h / 2; ring.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry + h / 2, 'middle']); }
        pick = ring.find(([x, y, a]) => !hit(labelRect(x, y, tw, h, a), i)) ||
          ring.find(([x, y, a]) => { const r = labelRect(x, y, tw, h, a); return !offBoard(r) && !onPads(r) && !onLabels(r); });
      }
      // last resort: the first spot on the board that is clear of pads (labels may touch), else the first on the board
      if (!pick) pick = tries.find(([x, y, a]) => { const r = labelRect(x, y, tw, h, a); return !offBoard(r) && !onPads(r); }) || tries.find(([x, y, a]) => !offBoard(labelRect(x, y, tw, h, a))) || tries[0];
      const [x, y, anchor] = pick;
      add({ kind: 'part', ref: c.ref, text, x, y, h, w: SILK_W, anchor, mirror: side === 'B', auto: true, rot });
    });
    const BL = S.pcb.boardLabel || {}, name = String(BL.text != null && BL.text !== '' ? BL.text : S.name || '');
    if (side === 'F' && name && !BL.hide) {
      let h = +BL.h || 1.2;
      if (BL.x != null) add({ kind: 'board', text: name, x: +BL.x, y: +BL.y + h / 2, h, w: Math.max(SILK_W, h * 0.13), anchor: 'middle', mirror: false, auto: false, rot: BL.rot });
      else {
        const room = W - 2.4; if (!BL.h && textWidth(name, h) > room) h = Math.max(0.8, h * room / textWidth(name, h));
        const tw = textWidth(name, h), corners = [[W - 1.2, H - 1.2, 'end'], [1.2, H - 1.2, 'start'], [W - 1.2, 1.2 + h, 'end'], [1.2, 1.2 + h, 'start']];
        const [x, y, anchor] = corners.find(([x, y, a]) => !hit(labelRect(x, y, tw, h, a), -1)) || corners.find(([x, y, a]) => !onPads(labelRect(x, y, tw, h, a))) || corners[0];
        add({ kind: 'board', text: name, x, y, h, w: Math.max(SILK_W, h * 0.13), anchor, mirror: false, auto: true, rot: BL.rot });
      }
    }
    return out.map(l => {
      let lines = strokeText(l.text, l.x, l.y, l.h, l.anchor, l.mirror);
      if (l.rot) { const cx = (l.rect0[0] + l.rect0[2]) / 2, cy = (l.rect0[1] + l.rect0[3]) / 2; lines = lines.map(pl => pl.map(([x, y]) => rotPt(x, y, cx, cy, l.rot).map(v => Math.round(v * 1e4) / 1e4))); }
      return Object.assign(l, { lines });
    });
  }
  // centre of a label (what the user drags / the AI sets)
  const labelCentre = l => [+(((l.rect[0] + l.rect[2]) / 2)).toFixed(3), +(((l.rect[1] + l.rect[3]) / 2)).toFixed(3)];
  // Change a part's silkscreen label, the board name label ('board') — inside Model.mutate.
  // o: { text, size, hidden, x, y (label centre, board mm), auto: true = back to automatic placement }
  function setSilkLabel(ref, o = {}) {
    const S = Model.S;
    if (/^(board|#board)$/i.test(ref)) {
      const L = Object.assign({}, S.pcb.boardLabel || {});
      if (o.text != null) L.text = String(o.text); if (o.size != null) L.h = Math.max(0.6, Math.min(10, +o.size)); if (o.hidden != null) L.hide = !!o.hidden;
      if (o.rotation != null) { if (normRot(o.rotation)) L.rot = normRot(o.rotation); else delete L.rot; }
      if (o.auto) { delete L.x; delete L.y; } else if (o.x != null && o.y != null) { L.x = +(+o.x).toFixed(3); L.y = +(+o.y).toFixed(3); }
      S.pcb.boardLabel = L; return L;
    }
    const c = Model.comp(ref); if (!c || !c.pcb) throw new Error(`${ref} is not on the PCB`);
    const L = Object.assign({}, c.pcb.silk || {});
    if (o.text != null) { if (String(o.text).trim() && String(o.text) !== c.ref) L.text = String(o.text); else delete L.text; }
    if (o.size != null) L.h = Math.max(0.6, Math.min(10, +o.size)); if (o.hidden != null) { if (o.hidden) L.hide = true; else delete L.hide; }
    if (o.rotation != null) { if (normRot(o.rotation)) L.rot = normRot(o.rotation); else delete L.rot; }
    if (o.auto) { delete L.dx; delete L.dy; } else if (o.x != null && o.y != null) { L.dx = +(+o.x - c.pcb.x).toFixed(3); L.dy = +(+o.y - c.pcb.y).toFixed(3); }
    if (Object.keys(L).length) c.pcb.silk = L; else delete c.pcb.silk;
    return L;
  }
  // free silkscreen text: { text, x, y (centre, board mm), size (mm, default 1.2), side 'top' | 'bottom' }
  function addText(o) {
    const S = Model.S, t = { text: String(o.text || 'TEXT'), x: +(+(o.x != null ? o.x : S.board.w / 2)).toFixed(3), y: +(+(o.y != null ? o.y : S.board.h / 2)).toFixed(3), h: Math.max(0.6, Math.min(10, +o.size || 1.2)), side: /^b/i.test(o.side || '') ? 'B' : 'F' };
    if (normRot(o.rotation)) t.rot = normRot(o.rotation);
    S.pcb.texts = (S.pcb.texts || []).concat([t]); return { index: S.pcb.texts.length - 1, ...t };
  }
  function updateText(i, o) {
    const t = (Model.S.pcb.texts || [])[i]; if (!t) throw new Error('No PCB text #' + i);
    if (o.text != null) t.text = String(o.text); if (o.x != null) t.x = +(+o.x).toFixed(3); if (o.y != null) t.y = +(+o.y).toFixed(3);
    if (o.size != null) t.h = Math.max(0.6, Math.min(10, +o.size)); if (o.side != null) t.side = /^b/i.test(o.side) ? 'B' : 'F';
    if (o.rotation != null) { if (normRot(o.rotation)) t.rot = normRot(o.rotation); else delete t.rot; }
    return { index: i, ...t };
  }
  function removeText(i) { const a = Model.S.pcb.texts || []; if (!a[i]) throw new Error('No PCB text #' + i); a.splice(i, 1); return { removed: i }; }
  // every label with its position, for the AI and the properties panel
  function silkInfo() {
    return ['F', 'B'].flatMap(side => silkLabels(side).map(l => { const [x, y] = labelCentre(l); return Object.assign({ kind: l.kind, side: side === 'F' ? 'top' : 'bottom', text: l.text, x, y, size: l.h, rotation: l.rot || 0, auto: l.auto }, l.kind === 'part' ? { ref: l.ref } : {}, l.kind === 'text' ? { index: l.i } : {}, l.overPads ? { covers_pads: true } : {}); }));
  }
  function gerbers() {
    const S = Model.S, idx = Model.pinIndex(), cs = placed(), Hb = S.board.h;
    if (!cs.length || !S.board.w) throw new Error('No PCB to export');
    const pads = cs.flatMap(c => padsOf(c, idx));
    const C = v => Math.round(v * 1e6), X = (x, y) => `X${C(x)}Y${C(Hb - y)}`;
    function file(func, draw) {
      const ap = new Map(); let next = 10;
      const A = def => { if (!ap.has(def)) ap.set(def, next++); return 'D' + ap.get(def); };
      const body = []; draw(A, body);
      const head = [`G04 CircuitPilot*`, `%TF.FileFunction,${func}*%`, '%FSLAX46Y46*%', '%MOMM*%', '%LPD*%'];
      for (const [d, n] of ap) head.push(`%ADD${n}${d}*%`);
      return head.concat(body, ['M02*']).join('\n') + '\n';
    }
    const f6 = v => v.toFixed(6);
    const padAp = (p, grow = 0) => p.shape === 'round' ? `C,${f6(p.w + grow)}` : p.shape === 'oval' ? `O,${f6(p.w + grow)}X${f6(p.h + grow)}` : `R,${f6(p.w + grow)}X${f6(p.h + grow)}`;
    const R = rules(), onLayer = (p, layer) => p.drill || (p.layer || 'F') === layer;
    const drawCopper = (A, b, layer, grow, net) => {
      for (const t of S.pcb.traces) if (t.layer === layer && (net === undefined || t.net !== net)) { b.push(A(`C,${f6(t.w + grow)}`) + '*'); b.push(X(...t.pts[0]) + 'D02*'); for (const q of t.pts.slice(1)) b.push(X(...q) + 'D01*'); }
      for (const p of pads) if (onLayer(p, layer) && (net === undefined || p.net !== net)) { b.push(A(padAp(p, grow)) + '*'); b.push(X(p.x, p.y) + 'D03*'); }
      for (const v of S.pcb.vias) if (net === undefined || v.net !== net) { b.push(A(`C,${f6(v.d + grow)}`) + '*'); b.push(X(v.x, v.y) + 'D03*'); }
      if (net !== undefined) for (const h of S.pcb.holes || []) { b.push(A(`C,${f6(h.d + grow)}`) + '*'); b.push(X(h.x, h.y) + 'D03*'); }
    };
    const outline = boardPoly();
    const copper = (layer, func) => file(func, (A, b) => {
      // copper pours: dark region, then clear (LPC) other nets' copper + the board-edge band, then all copper on top
      const pours = (S.pcb.pours || []).filter(pr => pr.layer === layer && S.nets[pr.net]);
      if (pours.length) {
        b.push('G01*');
        for (const pr of pours) {
          const poly = pourPoly(pr), cl = pr.clearance || R.clearance;
          b.push('%LPD*%', 'G36*', X(...poly[0]) + 'D02*'); for (const q of poly.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...poly[0]) + 'D01*', 'G37*');
          b.push('%LPC*%'); drawCopper(A, b, layer, 2 * cl, pr.net);
          b.push(A(`C,${f6(2 * R.edgeClearance)}`) + '*', X(...outline[0]) + 'D02*'); for (const q of outline.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...outline[0]) + 'D01*');
          // keep-outs and the dropped pieces (dead copper, islands under pourMinArea) are cleared too
          const region = pts => { b.push('G36*', X(...pts[0]) + 'D02*'); for (const q of pts.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...pts[0]) + 'D01*', 'G37*'); };
          for (const k of keepouts()) if (k.pours && koOn(k, layer)) region(k.pts);
          for (const [x0, y0, x1, y1] of pourDeadRects(pr)) region([[x0, y0], [x1, y0], [x1, y1], [x0, y1]]);
        }
        b.push('%LPD*%');
      }
      drawCopper(A, b, layer, 0);
    });
    const mask = (layer, func) => file(func, (A, b) => { for (const p of pads) if (onLayer(p, layer)) { b.push(A(padAp(p, 0.1)) + '*'); b.push(X(p.x, p.y) + 'D03*'); } });
    const paste = (layer, func) => file(func, (A, b) => { for (const p of pads) if (!p.drill && (p.layer || 'F') === layer) { b.push(A(padAp(p)) + '*'); b.push(X(p.x, p.y) + 'D03*'); } });
    const rectPath = (b, x0, y0, x1, y1) => { b.push(X(x0, y0) + 'D02*'); b.push(X(x1, y0) + 'D01*'); b.push(X(x1, y1) + 'D01*'); b.push(X(x0, y1) + 'D01*'); b.push(X(x0, y0) + 'D01*'); };
    const silk = side => (A, b) => {
      b.push(A('C,0.150000') + '*'); for (const c of cs) if ((isBottom(c) ? 'B' : 'F') === side) { const bb = fpBox(c); rectPath(b, bb[0], bb[1], bb[2], bb[3]); }
      // part references and the board name, as strokes
      for (const l of silkLabels(side)) { b.push(A(`C,${f6(l.w)}`) + '*'); for (const pl of l.lines) { b.push(X(...pl[0]) + 'D02*'); for (const q of (pl.length > 1 ? pl.slice(1) : pl)) b.push(X(...q) + 'D01*'); } }
    };
    const files = {
      'board-F_Cu.gtl': copper('F', 'Copper,L1,Top'),
      'board-B_Cu.gbl': copper('B', 'Copper,L2,Bot'),
      'board-F_Mask.gts': mask('F', 'Soldermask,Top'),
      'board-B_Mask.gbs': mask('B', 'Soldermask,Bot'),
      'board-F_Paste.gtp': paste('F', 'Paste,Top'),
      'board-B_Paste.gbp': paste('B', 'Paste,Bot'),
      'board-F_Silkscreen.gto': file('Legend,Top', silk('F')),
      'board-B_Silkscreen.gbo': file('Legend,Bot', silk('B')),
      'board-Edge_Cuts.gm1': file('Profile,NP', (A, b) => { b.push(A('C,0.100000') + '*'); b.push(X(...outline[0]) + 'D02*'); for (const q of outline.slice(1)) b.push(X(...q) + 'D01*'); b.push(X(...outline[0]) + 'D01*'); }),
    };
    const holes = [...pads.filter(p => p.drill).map(p => ({ x: p.x, y: p.y, d: p.drill })), ...S.pcb.vias.map(v => ({ x: v.x, y: v.y, d: v.drill }))];
    const tools = [...new Set(holes.map(h => h.d.toFixed(3)))];
    let drl = 'M48\n; CircuitPilot drill file\nMETRIC,TZ\n' + tools.map((d, i) => `T${i + 1}C${d}`).join('\n') + '\n%\nG90\nG05\n';
    tools.forEach((d, i) => { drl += `T${i + 1}\n`; for (const h of holes.filter(h => h.d.toFixed(3) === d)) drl += `X${h.x.toFixed(3)}Y${(Hb - h.y).toFixed(3)}\n`; });
    files['board-PTH.drl'] = drl + 'M30\n';
    const nh = S.pcb.holes || [];
    if (nh.length) {
      const nt = [...new Set(nh.map(h => h.d.toFixed(3)))];
      let n = 'M48\n; CircuitPilot non-plated (mounting) holes\nMETRIC,TZ\n' + nt.map((d, i) => `T${i + 1}C${d}`).join('\n') + '\n%\nG90\nG05\n';
      nt.forEach((d, i) => { n += `T${i + 1}\n`; for (const h of nh.filter(h => h.d.toFixed(3) === d)) n += `X${h.x.toFixed(3)}Y${(Hb - h.y).toFixed(3)}\n`; });
      files['board-NPTH.drl'] = n + 'M30\n';
    }
    return files;
  }
  // ---------- placement by simulated annealing ----------
  // Minimises a routability estimate: weighted half-perimeter wire length of every net, plus heavy penalties for
  // overlapping courtyards and for leaving the board. Every part keeps a fan-out margin that grows with its pin count,
  // and parts in opt.boost (e.g. on nets that failed to route) get extra room and pull.
  // Fixed: locked parts, connectors on the board edge (they keep their edge). Returns the cost before / after.
  function anneal(opt = {}) {
    const S = Model.S, cs = placed(), idx = Model.pinIndex(), R = rules();
    if (cs.length < 2) return { moved: 0 };
    const t0 = Date.now(), limit = (opt.time_s ?? 3) * 1000, flip = !!opt.allow_bottom, boost = opt.boost || {};
    let seed = opt.seed ?? 4242; const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const fixed = c => !!(c.pcb.locked || c.pcbEdge || edgeInfo(c) || (opt.fixed && opt.fixed.has(c.ref)));
    const netNames = Object.keys(S.nets), nid = {}; netNames.forEach((n, i) => nid[n] = i);
    const pitch = R.traceWidth + R.clearance;
    // per part, per orientation (rot 0..3 × side): pad offsets on nets and the courtyard box (relative to the origin)
    const P = cs.map(c => {
      const save = c.pcb, orients = [];
      for (const side of flip || c.pcb.side === 'B' ? ['F', 'B'] : ['F']) for (const rot of [0, 90, 180, 270]) {
        c.pcb = { x: 0, y: 0, rot }; if (side === 'B') c.pcb.side = 'B';
        const pads = padsOf(c, idx).filter(p => p.net).map(p => [nid[p.net], p.x, p.y]), b = fpBox(c);
        orients.push({ rot, side, pads, box: b });
      }
      c.pcb = save;
      const pins = padsOf(c, idx).length;
      let o = orients.findIndex(q => q.rot === (c.pcb.rot || 0) && q.side === (c.pcb.side === 'B' ? 'B' : 'F')); if (o < 0) o = 0;
      const nb = new Set(orients[0].pads.map(q => q[0]));
      const margin = Math.min(3, 0.4 + pitch * Math.sqrt(pins) * 0.6 + (boost[c.ref] || 0));
      return { c, x: c.pcb.x, y: c.pcb.y, o, orients, fixed: fixed(c), nets: [...nb], margin, pins };
    });
    // net → [(part index, pad index list)] ; power nets weigh less (wide / poured), large nets get the usual HPWL correction
    const netPins = netNames.map(() => []);
    P.forEach((p, i) => { const by = {}; p.orients[0].pads.forEach((q, k) => (by[q[0]] = by[q[0]] || []).push(k)); for (const n in by) netPins[n].push([i, by[n]]); });
    const netW = netNames.map((n, i) => { const k = netPins[i].reduce((a, q) => a + q[1].length, 0); if (k < 2) return 0; return (Model.isGround(n) ? 0.25 : Model.isPower(n) ? 0.45 : 1) * (k === 2 ? 1.6 : 1 + 0.05 * Math.max(0, k - 3)) * (1 + (opt.netBoost && opt.netBoost[n] || 0)); });
    const hp = new Float64Array(netNames.length);
    const netHP = n => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [i, ks] of netPins[n]) { const p = P[i], pads = p.orients[p.o].pads; for (const k of ks) { const x = p.x + pads[k][1], y = p.y + pads[k][2]; if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; } }
      return x1 >= x0 ? (x1 - x0) + (y1 - y0) : 0;
    };
    // board: rectangle fast path, polygon via corner tests
    const W = S.board.w, H = S.board.h, poly = boardPoly(), rect = isRectBoard(), edgeM = Math.max(R.edgeClearance + 0.3, 0.6);
    const BX = new Float64Array(P.length * 4);   // cached courtyard boxes (with fan-out margin)
    const upd = i => { const p = P[i], b = p.orients[p.o].box, m = p.margin / 2; BX[i * 4] = p.x + b[0] - m; BX[i * 4 + 1] = p.y + b[1] - m; BX[i * 4 + 2] = p.x + b[2] + m; BX[i * 4 + 3] = p.y + b[3] + m; };
    P.forEach((_, i) => upd(i));
    const outside = p => {
      const b0 = p.orients[p.o].box, b = [p.x + b0[0], p.y + b0[1], p.x + b0[2], p.y + b0[3]];
      let o = Math.max(0, edgeM - b[0]) + Math.max(0, edgeM - b[1]) + Math.max(0, b[2] - (W - edgeM)) + Math.max(0, b[3] - (H - edgeM));
      if (!rect && !o) for (const [x, y] of [[b[0], b[1]], [b[2], b[1]], [b[2], b[3]], [b[0], b[3]]]) if (!inPoly(x, y, poly)) o += 1;
      return o;
    };
    const ovI = (i, j) => { const w = Math.min(BX[i * 4 + 2], BX[j * 4 + 2]) - Math.max(BX[i * 4], BX[j * 4]); if (w <= 0) return 0; const h = Math.min(BX[i * 4 + 3], BX[j * 4 + 3]) - Math.max(BX[i * 4 + 1], BX[j * 4 + 1]); return h > 0 ? w * h : 0; };
    let OV = 4; const OUT = 60;
    // big ICs are pulled to the board centre (the rest gathers around them)
    const cx0 = W / 2, cy0 = H / 2, CW = P.map(p => opt.center !== false && p.pins >= 8 ? 0.12 * Math.sqrt(p.pins / 8) : 0);
    const ctr = i => CW[i] ? CW[i] * Math.hypot((BX[i * 4] + BX[i * 4 + 2]) / 2 - cx0, (BX[i * 4 + 1] + BX[i * 4 + 3]) / 2 - cy0) : 0;
    const partCost = i => { let s = OUT * outside(P[i]) + ctr(i); for (let j = 0; j < P.length; j++) if (j !== i) s += OV * ovI(i, j); return s; };
    // compactness: perimeter of the box around all parts (used when the board is sized to the parts)
    const CP = opt.compact || 0;
    const bbPer = () => { if (!CP) return 0; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (let i = 0; i < P.length; i++) { x0 = Math.min(x0, BX[i * 4]); y0 = Math.min(y0, BX[i * 4 + 1]); x1 = Math.max(x1, BX[i * 4 + 2]); y1 = Math.max(y1, BX[i * 4 + 3]); } return CP * ((x1 - x0) + (y1 - y0)); };
    let wire = 0; for (let n = 0; n < netNames.length; n++) { hp[n] = netHP(n); wire += netW[n] * hp[n]; }
    const penAll = () => { let s = 0; for (let i = 0; i < P.length; i++) s += OUT * outside(P[i]) + ctr(i); for (let i = 0; i < P.length; i++) for (let j = i + 1; j < P.length; j++) s += OV * ovI(i, j); return s; };
    let pen = penAll(), comp = bbPer();
    const startCost = wire + pen + comp;
    const mov = P.map((p, i) => i).filter(i => !P[i].fixed);
    if (!mov.length) return { moved: 0, cost: startCost };
    // one move: change parts, recompute the touched nets and their penalties
    const apply = (list, change) => {
      const nets = new Set(); for (const i of list) for (const n of P[i].nets) nets.add(n);
      let before = 0; for (const n of nets) before += netW[n] * hp[n];
      let pb = 0; for (const i of list) pb += partCost(i); if (list.length === 2) pb -= OV * ovI(list[0], list[1]);
      const u0 = change(), undo = () => { u0(); for (const i of list) upd(i); };
      for (const i of list) upd(i);
      const nh = new Map(); let after = 0; for (const n of nets) { const v = netHP(n); nh.set(n, v); after += netW[n] * v; }
      let pa = 0; for (const i of list) pa += partCost(i); if (list.length === 2) pa -= OV * ovI(list[0], list[1]);
      const nc = CP ? bbPer() : 0;
      return { d: (after - before) + (pa - pb) + (nc - comp), commit: () => { for (const [n, v] of nh) hp[n] = v; wire += after - before; pen += pa - pb; comp = nc; }, undo };
    };
    const diag = Math.hypot(W, H);
    const propose = T01 => {
      const r = rnd(), i = mov[Math.floor(rnd() * mov.length)], p = P[i];
      if (r < 0.62 || mov.length < 2) {
        const rad = Math.max(0.3, diag * 0.35 * T01), ox = p.x, oy = p.y;
        return apply([i], () => { p.x += (rnd() * 2 - 1) * rad; p.y += (rnd() * 2 - 1) * rad; return () => { p.x = ox; p.y = oy; }; });
      }
      if (r < 0.8) { const oo = p.o, per = 4; return apply([i], () => { const s = Math.floor(p.o / per); p.o = s * per + Math.floor(rnd() * per); return () => { p.o = oo; }; }); }
      if (r < 0.95 || !flip) {
        const j = mov[Math.floor(rnd() * mov.length)]; if (j === i) return null; const q = P[j];
        return apply([i, j], () => { const ax = p.x, ay = p.y; p.x = q.x; p.y = q.y; q.x = ax; q.y = ay; return () => { q.x = p.x; q.y = p.y; p.x = ax; p.y = ay; }; });
      }
      if (p.orients.length < 8) return null;
      const oo = p.o; return apply([i], () => { p.o = (p.o + 4) % 8; return () => { p.o = oo; }; });
    };
    // temperature from the typical uphill step
    let sum = 0, cnt = 0;
    for (let k = 0; k < 60; k++) { const m = propose(1); if (!m) continue; if (m.d > 0) { sum += m.d; cnt++; } m.undo(); }
    const T0 = Math.max(0.05, (cnt ? sum / cnt : 1) * (opt.hot ?? 1.0));
    let T = T0, moves = 0, best = { cost: wire + pen + comp, s: P.map(p => [p.x, p.y, p.o]) };
    const perT = Math.max(150, 30 * mov.length);
    while (Date.now() - t0 < limit && T > T0 * 2e-4) {
      for (let k = 0; k < perT; k++) {
        const m = propose(Math.min(1, T / T0)); if (!m) continue; moves++;
        if (m.d <= 0 || rnd() < Math.exp(-m.d / T)) { m.commit(); if (wire + pen + comp < best.cost - 1e-9) best = { cost: wire + pen + comp, s: P.map(p => [p.x, p.y, p.o]) }; }
        else m.undo();
      }
      T *= 0.9;
      // overlaps become more expensive as it cools, so the result needs little legalising
      OV = Math.min(40, OV * 1.06); pen = penAll();
      if (wire + pen + comp < best.cost - 1e-9 || best.pen > 0) { best = { cost: wire + pen + comp, pen: pen, s: P.map(p => [p.x, p.y, p.o]) }; }
    }
    // write back the best state
    best.s.forEach(([x, y, o], i) => { const p = P[i]; if (p.fixed) return; const q = p.orients[o]; p.c.pcb.x = +(Math.round(x / 0.05) * 0.05).toFixed(3); p.c.pcb.y = +(Math.round(y / 0.05) * 0.05).toFixed(3); p.c.pcb.rot = q.rot; if (q.side === 'B') p.c.pcb.side = 'B'; else delete p.c.pcb.side; });
    return { moves, cost_before: +startCost.toFixed(1), cost_after: +best.cost.toFixed(1), seconds: +((Date.now() - t0) / 1000).toFixed(1) };
  }

  // Legalise a placement after free moves: connectors back on their edge, no overlaps, everything on the board, snapped.
  function legalisePlacement(gap = 0.4) {
    const S = Model.S, lock = new Map();
    for (const c of placed()) if (c.pcbEdge || edgeInfo(c) || c.pcb.locked) lock.set(c, 'xy');
    separate(placed(), gap, lock);
    for (const c of placed()) if (c.pcbEdge || edgeInfo(c)) {
      const b = fpBox(c), side = c.pcbEdge || [['left', b[0]], ['right', S.board.w - b[2]], ['top', b[1]], ['bottom', S.board.h - b[3]]].sort((p, q) => p[1] - q[1])[0][0];
      const had = c.pcbEdge; placeFootprint(c.ref, { edge: side }); if (!had) delete c.pcbEdge;
    } else if (!c.pcb.locked) clampInside(c, boardPoly(), Math.max(rules().edgeClearance + 0.3, 0.6), S.board.w, S.board.h);
    separate(placed().filter(c => !lock.has(c)), gap * 0.5, new Map());
    for (const c of placed()) { c.pcb.x = +(Math.round(c.pcb.x / 0.05) * 0.05).toFixed(3); c.pcb.y = +(Math.round(c.pcb.y / 0.05) * 0.05).toFixed(3); }
    return { overlaps: overlaps(placed(), 0).map(([a, b]) => `${a.ref}/${b.ref}`), outside: placed().filter(c => !boxInside(c, boardPoly(), -0.05)).map(c => c.ref) };
  }
  // Update the board after schematic edits. Placed parts and still-valid copper stay as they are: copper of nets that no
  // longer exist is removed, new parts go to the nearest free spot next to the parts they connect to (away from existing
  // tracks when possible), and parts that now overlap (e.g. after a footprint change) are moved to a free spot nearby.
  // The caller then routes the nets left incomplete.
  // opt.place === false: load only — new parts are lined up beside the board for manual placement, nothing is moved.
  function syncFromSchematic(opt = {}) {
    const S = Model.S, R = rules();
    if (!S.board.w || !placed().length) throw new Error('Generate the PCB first');
    const nets = new Set(Object.keys(S.nets)), n0 = S.pcb.traces.length + S.pcb.vias.length;
    S.pcb.traces = S.pcb.traces.filter(t => !t.net || nets.has(t.net));
    S.pcb.vias = S.pcb.vias.filter(v => !v.net || nets.has(v.net));
    if (S.pcb.pours) S.pcb.pours = S.pcb.pours.filter(p => !p.net || nets.has(p.net));
    for (const n of Object.keys(S.pcb.routed || {})) if (!nets.has(n)) delete S.pcb.routed[n];
    const removed = n0 - S.pcb.traces.length - S.pcb.vias.length;
    const netsOf = c => Object.keys(S.nets).filter(n => S.nets[n].some(k => k.startsWith(c.ref + '.')));
    const rip = new Set(), drop = ns => { for (const n of ns) { rip.add(n); delete S.pcb.routed[n]; } S.pcb.traces = S.pcb.traces.filter(t => !ns.includes(t.net)); S.pcb.vias = S.pcb.vias.filter(v => !ns.includes(v.net)); };

    const fresh = S.components.filter(c => !c.pcb && Lib.footprint(c.footprint));
    const noFp = S.components.filter(c => !c.pcb && !Lib.footprint(c.footprint)).map(c => c.ref);
    if (opt.place === false) {
      // column(s) to the right of the board, 1 mm apart, top to bottom
      let x = S.board.w + 3, y = 0, colW = 0;
      for (const c of fresh) {
        const b = Lib.rotBox(Lib.footprint(c.footprint).box, c.rot || 0), w = b[2] - b[0], h = b[3] - b[1];
        if (y > 0 && y + h > Math.max(S.board.h, 10)) { x += colW + 2; y = 0; colW = 0; }
        c.pcb = { x: +(x - b[0]).toFixed(3), y: +(y - b[1]).toFixed(3), rot: c.rot || 0 };
        y += h + 1; colW = Math.max(colW, w);
      }
      return { added: fresh.map(c => c.ref), parked: true, overlaps: overlaps(placed().filter(c => !fresh.includes(c)), 0).map(([a, b]) => `${a.ref}/${b.ref}`), no_footprint: noFp, removed_copper: removed };
    }
    // overlapping placed parts: move the smaller, free one of each pair
    const area = c => { const b = fpBox(c); return (b[2] - b[0]) * (b[3] - b[1]); }, pinned = c => c.pcb.locked || c.pcbEdge || edgeInfo(c);
    const move = new Set();
    for (const [a, b] of overlaps(placed(), 0)) {
      if (move.has(a) || move.has(b)) continue;
      const pick = pinned(a) && pinned(b) ? null : pinned(a) ? b : pinned(b) ? a : area(a) <= area(b) ? a : b;
      if (pick) move.add(pick);
    }
    for (const c of placed()) if (!pinned(c) && !boxInside(c, boardPoly(), 0)) move.add(c);   // pushed off the board by a bigger footprint
    const fixed = new Set(placed().filter(c => !move.has(c)));
    const gap = Math.max(0.3, R.clearance), m = Math.max(R.edgeClearance + 0.3, 0.6), poly = boardPoly(), W = S.board.w, H = S.board.h;
    const copperHits = (c, own) => {
      const b = fpBox(c), hit = new Set();
      for (const t of S.pcb.traces) {
        if (own.includes(t.net) || hit.has(t.net)) continue;
        const e = t.w / 2 + R.clearance;
        for (let i = 1; i < t.pts.length && !hit.has(t.net); i++) {
          const [ax, ay] = t.pts[i - 1], [bx, by] = t.pts[i], n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 0.2));
          for (let k = 0; k <= n; k++) { const x = ax + (bx - ax) * k / n, y = ay + (by - ay) * k / n; if (x > b[0] - e && x < b[2] + e && y > b[1] - e && y < b[3] + e) { hit.add(t.net); break; } }
        }
      }
      for (const v of S.pcb.vias) { const e = v.d / 2 + R.clearance; if (!own.includes(v.net) && v.x > b[0] - e && v.x < b[2] + e && v.y > b[1] - e && v.y < b[3] + e) hit.add(v.net); }
      return [...hit];
    };
    const spot = c => {
      const own = netsOf(c), pts = [];
      for (const n of own) for (const k of S.nets[n]) { const o = Model.comp(k.slice(0, k.lastIndexOf('.'))); if (o && o !== c && fixed.has(o)) pts.push([o.pcb.x, o.pcb.y]); }
      const tx = c.pcb && move.has(c) ? c.pcb.x : pts.length ? pts.reduce((a, p) => a + p[0], 0) / pts.length : W / 2;
      const ty = c.pcb && move.has(c) ? c.pcb.y : pts.length ? pts.reduce((a, p) => a + p[1], 0) / pts.length : H / 2;
      const cand = [];
      for (let x = 0; x <= W; x += 0.5) for (let y = 0; y <= H; y += 0.5) cand.push([x, y, (x - tx) ** 2 + (y - ty) ** 2]);
      cand.sort((a, b) => a[2] - b[2]);
      const side = c.pcb && c.pcb.side, rot0 = (c.pcb ? c.pcb.rot : c.rot) || 0, others = [...fixed].map(o => fpBox(o, gap / 2));
      let best = null;
      // nearest spot clear of parts and copper; otherwise (after a further 400 spots) the one crossing the fewest nets
      search: for (let i = 0, lastHit = -1; i < cand.length; i++) {
        if (best && i - lastHit > 400) break;
        const [x, y] = cand[i];
        for (const rot of [rot0, (rot0 + 90) % 360]) {
          c.pcb = { x, y, rot }; if (side === 'B') c.pcb.side = 'B';
          if (!boxInside(c, poly, m)) continue;
          const b = fpBox(c, gap / 2);
          if (others.some(o => b[0] < o[2] && o[0] < b[2] && b[1] < o[3] && o[1] < b[3])) continue;
          const hits = copperHits(c, own);
          if (!hits.length) { best = { x, y, rot, hits }; break search; }
          if (!best) lastHit = i;
          if (!best || hits.length < best.hits.length) best = { x, y, rot, hits };
        }
      }
      return best;
    };
    const added = [], moved = [], noRoom = [];
    for (const c of [...move, ...fresh].sort((a, b) => area(b) - area(a))) {
      const was = !!c.pcb, side = c.pcb && c.pcb.side;
      if (was) drop(netsOf(c));
      const s = spot(c);
      if (s) { c.pcb = { x: +s.x.toFixed(3), y: +s.y.toFixed(3), rot: s.rot }; if (side === 'B') c.pcb.side = 'B'; if (s.hits.length) drop(s.hits); }
      else { // no room: park it beside the board
        const b0 = Lib.footprint(c.footprint).box; c.pcb = { x: +(W + 2 - b0[0] + noRoom.length * 4).toFixed(3), y: +(H / 2).toFixed(3), rot: 0 }; noRoom.push(c.ref);
      }
      fixed.add(c); (was ? moved : added).push(c.ref);
    }
    return { added, moved, no_room: noRoom, no_footprint: noFp, removed_copper: removed, ripped_nets: [...rip] };
  }
  // Move parts until every net routes (and, with opt.shrink, make the board smaller while it still routes).
  // Each round: give the parts on unrouted nets more room and pull, re-anneal locally from the best placement,
  // legalise, route with rip-up; keep the best (fewest unrouted, then smallest board, then shortest copper).
  function optimize(opt = {}) {
    const S = Model.S, t0 = Date.now(), limit = (opt.time_limit_s || 120) * 1000, maxIt = opt.iterations || 60;
    const grow = !!opt.allow_grow, flip = !!opt.allow_bottom, shrink = !!opt.shrink, rt = opt.route_time_s || 12, rtLong = opt.route_time_long_s || 45;
    if (!placed().length || !S.board.w) throw new Error('Generate the PCB first');
    const manual = { traces: S.pcb.traces.filter(t => t.manual), vias: S.pcb.vias.filter(v => v.manual) };
    const clone = o => JSON.parse(JSON.stringify(o));
    const snapPlace = () => placed().map(c => [c.ref, clone(c.pcb)]);
    const applyPlace = arr => arr.forEach(([ref, q]) => { const c = Model.comp(ref); if (c) c.pcb = clone(q); });
    let it = 0, phase = 'route';
    const left = () => limit - (Date.now() - t0);
    const evaluate = (secs = rt) => {
      S.pcb = Object.assign({}, S.pcb, { traces: manual.traces.slice(), vias: manual.vias.slice(), pours: S.pcb.pours || [], holes: S.pcb.holes || [], routed: {} });
      route({ time_limit_s: Math.max(3, Math.min(secs, left() / 1000)), onProgress: opt.onProgress ? p => opt.onProgress(Object.assign({}, p, { iteration: it, of: maxIt, optimizing: true, stage: phase })) : null });
      const st = status(), cs = placed(), poly = boardPoly();
      // parts that overlap or stick out of the board make the layout invalid, whatever the router says
      const bad = overlaps(cs, 0.05).length + cs.filter(c => !boxInside(c, poly, -0.05)).length;
      return { failed: st.unrouted.length + bad * 2, bad, len: st.trace_length_mm, unrouted: st.unrouted, area: +(S.board.w * S.board.h).toFixed(1) };
    };
    const better = (a, b) => a.failed < b.failed || (a.failed === b.failed && (a.area < b.area - 1 || (Math.abs(a.area - b.area) <= 1 && a.len < b.len - 0.5)));
    const legalise = () => legalisePlacement();
    const scaleBoard = f => {
      const cx = S.board.w / 2, cy = S.board.h / 2;
      for (const c of placed()) { c.pcb.x = cx * f + (c.pcb.x - cx) * f; c.pcb.y = cy * f + (c.pcb.y - cy) * f; }
      S.board.w = +(S.board.w * f).toFixed(1); S.board.h = +(S.board.h * f).toFixed(1);
      if (S.board.shape && S.board.shape.pts) S.board.shape.pts = S.board.shape.pts.map(q => [+(q[0] * f).toFixed(3), +(q[1] * f).toFixed(3)]);
      for (const h of S.pcb.holes || []) { h.x = cx * f + (h.x - cx) * f; h.y = cy * f + (h.y - cy) * f; }
    };
    let cur = evaluate(rtLong);
    let best = { score: cur, place: snapPlace(), pcb: clone(S.pcb), board: clone(S.board) };
    if (opt.onBest) opt.onBest({ unrouted: cur.failed });
    const history = [{ iteration: 0, unrouted: cur.failed, length_mm: cur.len, board: `${S.board.w}×${S.board.h}`, move: 'start' }];
    const pressure = {};   // nets that keep failing get more pull and their parts more room
    const applyPressure = (boost, netBoost) => { if (Object.keys(netBoost).length) anneal({ time_s: Math.min(2, left() / 6000), hot: 0.2, seed: 77 + it, boost, netBoost, allow_bottom: flip }); };
    let shrinkStep = 0.94, stuck = 0;
    while (it < maxIt && left() > 4000) {
      it++;
      applyPlace(best.place); S.board = clone(best.board); S.pcb = clone(best.pcb);
      let desc = '';
      if (best.score.failed > 0) {
        phase = 'route';
        for (const n of best.score.unrouted) pressure[n] = (pressure[n] || 0) + 1;
        const idx = Model.pinIndex(), boost = {}, netBoost = {};
        for (const [n, k] of Object.entries(pressure)) netBoost[n] = Math.min(4, 0.8 * k);
        for (const c of placed()) for (const p of padsOf(c, idx)) if (p.net && pressure[p.net]) boost[c.ref] = Math.min(2.5, (boost[c.ref] || 0) + 0.25 * pressure[p.net]);
        if (grow && stuck >= 4) { scaleBoard(1.08); stuck = 0; desc = `enlarge board to ${S.board.w}×${S.board.h} mm, re-arrange`; }
        if (!desc && it % 2 === 0) {
          // a fresh global arrangement (different seed) inside the same outline
          fitInside({ anneal_s: Math.min(5, left() / 4000), seed: 3000 + it * 104729, tries: 1 });
          applyPressure(boost, netBoost);
          desc = 'new arrangement of all parts';
        } else {
          desc = desc || `re-arrange around ${best.score.unrouted.slice(0, 3).join(', ')}${best.score.unrouted.length > 3 ? '…' : ''}`;
          anneal({ time_s: Math.min(4, left() / 4000), hot: stuck > 2 ? 0.6 : 0.25, seed: 1000 + it * 7919, boost, netBoost, allow_bottom: flip });
        }
      } else if (shrink) {
        phase = 'shrink';
        scaleBoard(shrinkStep); desc = `shrink board to ${S.board.w}×${S.board.h} mm`;
        anneal({ time_s: Math.min(3, left() / 4000), hot: 0.3, seed: 2000 + it * 7919, allow_bottom: flip });
      } else break;
      legalise();
      let sc = evaluate();
      // a promising candidate (no worse than the best) gets the full rip-up time before it is judged
      if (sc.failed > 0 && !sc.bad && sc.failed <= best.score.failed && left() > 15000) sc = evaluate(rtLong);
      const kept = better(sc, best.score);
      history.push({ iteration: it, move: desc, unrouted: sc.failed, length_mm: sc.len, board: `${S.board.w}×${S.board.h}`, kept });
      if (kept) { best = { score: sc, place: snapPlace(), pcb: clone(S.pcb), board: clone(S.board) }; stuck = 0; if (opt.onBest) opt.onBest({ unrouted: sc.failed }); }
      else { stuck++; if (phase === 'shrink') { shrinkStep = 1 - (1 - shrinkStep) / 2; if (shrinkStep > 0.985) break; } }
    }
    applyPlace(best.place); S.board = clone(best.board); S.pcb = clone(best.pcb);
    const st = status();
    return { iterations: it, routed: st.routed, total: st.nets, unrouted: st.unrouted, trace_length_mm: st.trace_length_mm, board: S.board, seconds: +((Date.now() - t0) / 1000).toFixed(1), history };
  }

  return { viaSummary, costsExtra, checkPlacement, legalCheck, addTrack, addVia, trackList, removeTracks, addKeepout, removeKeepout, keepouts, pourDeadRects, pourInfo, placeFree, silkLabels, silkInfo, setSilkLabel, addText, updateText, removeText, labelCentre, strokeText, addMountingHoles, autoPlace, placeFootprint, syncFromSchematic, optimize, anneal, legalisePlacement, setBoardShape, boardPoly, isRectBoard, addPour, pourPoly, pourRaster, isBottom, padCu, inPoly, edgeInfo, route, status, gerbers, padsOf, fpBox, placed, rules, setRules, ruleWarnings, drc, RULE_PRESETS, connectivity, ratsnest, netWidth: n => netWidth(rules(), n), geom: { shapeDist, padShape, ptSeg, padDist, segSegDist } };
})();

// Minimal ZIP (store, no compression) writer.
function makeZip(files) {
  const enc = new TextEncoder(), table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; table[n] = c >>> 0; }
  const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = table[(c ^ b[i]) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  const parts = [], cd = []; let off = 0;
  for (const [name, text] of Object.entries(files)) {
    const nb = enc.encode(name), db = text instanceof Uint8Array ? text : enc.encode(text), cr = crc(db);
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(10, 0, true); h.setUint16(12, 33, true);
    h.setUint32(14, cr, true); h.setUint32(18, db.length, true); h.setUint32(22, db.length, true); h.setUint16(26, nb.length, true);
    parts.push(new Uint8Array(h.buffer), nb, db);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(14, 33, true);
    c.setUint32(16, cr, true); c.setUint32(20, db.length, true); c.setUint32(24, db.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
    cd.push(new Uint8Array(c.buffer), nb);
    off += 30 + nb.length + db.length;
  }
  const cdSize = cd.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22)), n = Object.keys(files).length;
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, n, true); e.setUint16(10, n, true); e.setUint32(12, cdSize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...cd, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
